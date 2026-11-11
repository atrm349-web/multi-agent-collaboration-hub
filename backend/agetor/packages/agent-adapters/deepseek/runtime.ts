import { readWorkspaceFile, writeWorkspaceFile, listWorkspaceFiles } from '../workspace-files.ts';
import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { DeepSeekClient, type DeepSeekMessage, type DeepSeekTool } from "./client.ts";
import type { CodexRequest, CodexResult, CodexLog, CodexRunStatus } from "../codex/runtime.ts";

interface Run {
  result: CodexResult;
  logs: CodexLog[];
  done: Promise<CodexResult>;
  resolve: (result: CodexResult) => void;
  timer?: ReturnType<typeof setTimeout>;
  abortController: AbortController;
  terminal: boolean;
}

const TOOLS: DeepSeekTool[] = [
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or overwrite a file in the workspace with the specified content.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path within the workspace" },
          content: { type: "string", description: "Full UTF-8 content to write into the file" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the full contents of a file in the workspace.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path within the workspace" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List files and subdirectories in a workspace directory.",
      parameters: {
        type: "object",
        properties: {
          directory: { type: "string", description: "Relative directory path (or empty for root)" },
        },
      },
    },
  },
];

export class DeepSeekRuntime {
  private readonly runs = new Map<string, Run>();
  private readonly client: DeepSeekClient;
  private busy = false;

  constructor(private readonly options: {
    workspaceRoot: string;
    onEvent?: (runId: string, log: CodexLog) => void;
    onSpawn?: (runId: string, processGroupId: number, kind?: "process-group" | "in-process") => void;
    killGraceMs?: number;
    client?: DeepSeekClient;
  }) {
    this.client = options.client ?? new DeepSeekClient();
  }

  private record(run: Run, log: CodexLog) {
    run.logs.push(log);
    this.options.onEvent?.(run.result.runId, log);
  }

  async start(request: CodexRequest): Promise<string> {
    if (this.busy) throw new Error("AGENT_UNAVAILABLE: one run is already active");
    this.busy = true;

    try {
      const cwd = await realpath(request.cwd);
      const root = await realpath(this.options.workspaceRoot);
      const relative = path.relative(root, cwd);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("PERMISSION_DENIED: workspace escapes root");
      if (!(await stat(cwd)).isDirectory()) {
        throw new Error("INVALID_INPUT: workspace cwd is not a directory");
      }

      const runId = randomUUID();
      const sessionId = request.sessionId ?? randomUUID();
      const abortController = new AbortController();

      let resolve!: (result: CodexResult) => void;
      const done = new Promise<CodexResult>((r) => { resolve = r; });

      const run: Run = {
        result: {
          runId,
          status: "starting",
          sessionId,
          result: "",
          exitCode: null,
          error: null,
        },
        logs: [],
        done,
        resolve,
        abortController,
        terminal: false,
      };

      this.runs.set(runId, run);

      // Signal spawn callback with current process pid
      this.options.onSpawn?.(runId, process.pid, "in-process");

      run.result.status = "running";
      this.record(run, {
        seq: run.logs.length + 1,
        stream: "event",
        event: { type: "thread.started", thread_id: sessionId },
      });

      // Timeout watchdog
      const timeoutMs = request.timeoutMs ?? 180_000;
      run.timer = setTimeout(() => {
        run.result.status = "timed_out";
        run.result.error = { code: "TIMEOUT", message: `Execution timed out after ${timeoutMs}ms`, retryable: true };
        abortController.abort();
      }, timeoutMs);

      // Launch async worker loop
      void this.executeLoop(run, request, cwd);

      return runId;
    } catch (error) {
      this.busy = false;
      throw error;
    }
  }

  private cleanJson(raw: string): string {
    const trimmed = raw.trim();
    const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    return match ? match[1]!.trim() : trimmed;
  }

  private async executeLoop(run: Run, request: CodexRequest, cwd: string): Promise<void> {
    try {
      const model = request.model.startsWith("deepseek") ? request.model : "deepseek-chat";
      const isWrite = request.sandbox === "workspace-write";
      const availableTools = isWrite ? TOOLS : [TOOLS[1]!, TOOLS[2]!]; // read_file and list_files in read-only

      const systemPrompt = isWrite
        ? "You are an expert autonomous software engineer working in a local workspace repository.\n"
          + "Analyze the user's task carefully, read any relevant files, write clean code and tests using write_file.\n"
          + "Never delete or corrupt unrelated files. Output a concise summary of the files modified when done."
        : request.outputSchema
          ? `You are an independent quality auditor. Use read_file to inspect the actual code files in the workspace.\n`
            + `Evaluate whether the code satisfies the goal and acceptance criteria. Output your final answer as ONLY valid JSON conforming to this schema: ${JSON.stringify(request.outputSchema)}. No markdown formatting or extra text.`
          : "You are an expert software engineer in read-only analysis mode. Use read_file to inspect files and provide clear analysis.";

      const messages: DeepSeekMessage[] = [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: request.prompt,
        },
      ];

      let turns = 0;
      const maxTurns = 12;
      let finalAnswer = "";

      while (turns < maxTurns) {
        turns++;
        if (run.abortController.signal.aborted) break;

        const response = await this.client.chat({
          model,
          messages,
          tools: availableTools,
          temperature: 0.1,
          signal: run.abortController.signal,
        });

        const choice = response.choices[0];
        if (!choice) break;

        const assistantMsg = choice.message;
        messages.push({
          role: "assistant",
          content: assistantMsg.content ?? "",
          tool_calls: assistantMsg.tool_calls,
        });

        if (assistantMsg.reasoning_content) {
          this.record(run, {
            seq: run.logs.length + 1,
            stream: "event",
            event: {
              type: "item.completed",
              item: { type: "reasoning", text: assistantMsg.reasoning_content },
            },
          });
        }

        if (assistantMsg.content) {
          finalAnswer = assistantMsg.content;
          this.record(run, {
            seq: run.logs.length + 1,
            stream: "event",
            event: {
              type: "item.completed",
              item: { type: "agent_message", text: assistantMsg.content },
            },
          });
        }

        if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
          for (const toolCall of assistantMsg.tool_calls) {
            const name = toolCall.function.name;
            let args: Record<string, unknown> = {};
            try {
              args = JSON.parse(toolCall.function.arguments);
            } catch {
              args = {};
            }

            let toolResult = "";
            try {
              if (name === "write_file") {
                if (!isWrite) {
                  throw new Error("PERMISSION_DENIED: write operations are forbidden in read-only sandbox");
                }
                await writeWorkspaceFile(cwd, String(args.path), String(args.content), isWrite && !run.abortController.signal.aborted);
                toolResult = `Successfully wrote ${Buffer.byteLength(String(args.content))} bytes to ${args.path}`;
                this.record(run, {
                  seq: run.logs.length + 1,
                  stream: "event",
                  event: { type: "tool.write_file", path: args.path, status: "ok" },
                });
              } else if (name === "read_file") {
                toolResult = await readWorkspaceFile(cwd, String(args.path));
              } else if (name === "list_files") {
                const entries = await listWorkspaceFiles(cwd, String(args.directory ?? "."));
                toolResult = JSON.stringify(entries.map((e) => ({
                  name: e.name,
                  isDirectory: e.isDirectory(),
                })));
              } else {
                toolResult = `Error: unknown tool ${name}`;
              }
            } catch (err: unknown) {
              toolResult = `Error executing tool: ${err instanceof Error ? err.message : String(err)}`;
            }

            messages.push({
              role: "tool",
              name,
              tool_call_id: toolCall.id,
              content: toolResult ?? "",
            });
          }
        } else {
          // No more tool calls, model concluded
          break;
        }
      }

      let resultText = finalAnswer || (isWrite ? "Subtask completed successfully." : "{}");
      if (request.outputSchema) {
        resultText = this.cleanJson(resultText);
      }

      run.result.result = resultText;
      run.result.status = "succeeded";
      run.result.exitCode = 0;

      this.record(run, {
        seq: run.logs.length + 1,
        stream: "event",
        event: { type: "turn.completed" },
      });
    } catch (error: unknown) {
      if (run.abortController.signal.aborted && run.result.status === "starting") {
        run.result.status = "cancelled";
        run.result.error = { code: "CANCELLED", message: "Run was cancelled", retryable: false };
      } else if (!run.result.error) {
        const msg = error instanceof Error ? error.message : String(error);
        const match = msg.match(/^([A-Z_]+):/);
        run.result.status = "failed";
        run.result.exitCode = 1;
        run.result.error = {
          code: match ? match[1]! : "TURN_FAILED",
          message: msg,
          retryable: false,
        };
      }
    } finally {
      clearTimeout(run.timer);
      run.terminal = true;
      this.busy = false;
      run.resolve(run.result);
    }
  }

  async wait(runId: string): Promise<CodexResult> {
    const run = this.runs.get(runId);
    if (!run) throw new Error("NOT_FOUND: run does not exist");
    return await run.done;
  }

  async cancel(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run || run.terminal) return;
    run.abortController.abort();
    run.result.status = "cancelling";
    run.result.error = { code: "CANCELLED", message: "Cancellation requested by coordinator", retryable: false };
  }
}
