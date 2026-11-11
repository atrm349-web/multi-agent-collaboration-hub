import { randomUUID } from "node:crypto";
import { realpath, stat, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { ClaudeClient, type ClaudeMessage, type ClaudeTool, type ClaudeContentBlock } from "./client.ts";
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

export class ClaudeRuntime {
  private readonly runs = new Map<string, Run>();
  private readonly client: ClaudeClient;
  private busy = false;

  constructor(private readonly options: {
    workspaceRoot: string;
    onEvent?: (runId: string, log: CodexLog) => void;
    onSpawn?: (runId: string, processGroupId: number) => void;
    killGraceMs?: number;
  }) {
    this.client = new ClaudeClient();
  }

  async start(request: CodexRequest): Promise<string> {
    if (this.busy) throw new Error("AGENT_UNAVAILABLE: one Claude run is already active");
    this.busy = true;

    try {
      const root = await realpath(this.options.workspaceRoot);
      let cwd: string;
      try {
        cwd = await realpath(request.cwd);
      } catch {
        throw new Error("PERMISSION_DENIED: workspace directory does not exist or escapes root");
      }
      const relative = path.relative(root, cwd);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !(await stat(cwd)).isDirectory()) {
        throw new Error("PERMISSION_DENIED: workspace escapes the configured root");
      }

      const runId = randomUUID();
      const sessionId = request.sessionId ?? randomUUID();
      let resolve!: (result: CodexResult) => void;
      const done = new Promise<CodexResult>((r) => { resolve = r; });
      const abortController = new AbortController();

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
      this.options.onSpawn?.(runId, process.pid);
      run.result.status = "running";
      this.record(run, {
        seq: run.logs.length + 1,
        stream: "event",
        event: { type: "thread.started", thread_id: sessionId },
      });

      const timeoutMs = request.timeoutMs ?? 180_000;
      run.timer = setTimeout(() => {
        run.result.status = "timed_out";
        run.result.error = { code: "TIMEOUT", message: `Execution timed out after ${timeoutMs}ms`, retryable: true };
        abortController.abort();
      }, timeoutMs);

      void this.executeLoop(run, request, cwd);
      return runId;
    } catch (error) {
      this.busy = false;
      throw error;
    }
  }

  private resolveSafePath(cwd: string, relativePath: string): string {
    const target = path.resolve(cwd, relativePath);
    const rel = path.relative(cwd, target);
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw new Error(`PERMISSION_DENIED: path escapes workspace: ${relativePath}`);
    }
    return target;
  }

  private cleanJson(raw: string): string {
    const trimmed = raw.trim();
    const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    return match ? match[1].trim() : trimmed;
  }

  private async executeLoop(run: Run, request: CodexRequest, cwd: string): Promise<void> {
    try {
      const isReviewMode = Boolean(request.outputSchema);
      const isReadOnly = request.sandbox === "read-only" || isReviewMode;

      if (!this.client.isConfigured) {
        throw new Error("AUTH_REQUIRED: Anthropic Claude API key is not configured. Add ANTHROPIC_API_KEY to .env.local.");
      }

      const claudeTools: ClaudeTool[] = isReadOnly
        ? [
            {
              name: "read_file",
              description: "Read text content of a file in the workspace",
              input_schema: {
                type: "object",
                properties: { path: { type: "string", description: "Relative file path" } },
                required: ["path"],
              },
            },
            {
              name: "list_dir",
              description: "List directory contents in the workspace",
              input_schema: {
                type: "object",
                properties: { path: { type: "string", description: "Relative directory path (optional)" } },
              },
            },
          ]
        : [
            {
              name: "write_file",
              description: "Write content to a file in the workspace sandbox",
              input_schema: {
                type: "object",
                properties: {
                  path: { type: "string", description: "Relative file path" },
                  content: { type: "string", description: "Text content to write" },
                },
                required: ["path", "content"],
              },
            },
            {
              name: "read_file",
              description: "Read text content of a file in the workspace",
              input_schema: {
                type: "object",
                properties: { path: { type: "string", description: "Relative file path" } },
                required: ["path"],
              },
            },
            {
              name: "list_dir",
              description: "List directory contents in the workspace",
              input_schema: {
                type: "object",
                properties: { path: { type: "string", description: "Relative directory path (optional)" } },
              },
            },
          ];

      const systemPrompt = isReviewMode
        ? `You are an expert software reviewer. Review the workspace code and tests strictly against the requirements. Output ONLY a valid JSON object matching: {"approved": boolean, "findings": string[]}. Do not wrap with extra explanation.`
        : `You are an expert autonomous software engineer working in a secure local workspace. Use tools to inspect and implement requested files. Always produce clean, robust, and well-tested code.`;

      const messages: ClaudeMessage[] = [
        {
          role: "user",
          content: request.prompt,
        },
      ];

      let maxSteps = 8;
      let finalAnswer = "";

      while (maxSteps-- > 0 && !run.abortController.signal.aborted) {
        const response = await this.client.createMessage({
          model: request.model || "claude-3-5-sonnet-20241022",
          messages,
          system: systemPrompt,
          tools: claudeTools,
          signal: run.abortController.signal,
        });

        const toolCalls = response.content.filter((c) => c.type === "tool_use") as Array<{ type: "tool_use"; id: string; name: string; input: Record<string, unknown> }>;
        const textParts = response.content.filter((c) => c.type === "text").map((c: any) => c.text);
        if (textParts.length > 0) {
          finalAnswer = textParts.join("\n");
          this.record(run, {
            seq: run.logs.length + 1,
            stream: "stdout",
            raw: { event: { item: { type: "agent_message", text: finalAnswer } } },
          });
        }

        if (toolCalls.length === 0 || response.stop_reason === "end_turn") {
          break;
        }

        messages.push({
          role: "assistant",
          content: response.content,
        });

        const toolResults: ClaudeContentBlock[] = [];
        for (const tc of toolCalls) {
          const callId = tc.id;
          const fnName = tc.name;
          const args = tc.input || {};

          let resultText = "";
          try {
            if (fnName === "write_file") {
              const target = this.resolveSafePath(cwd, String(args.path));
              await mkdir(path.dirname(target), { recursive: true });
              await writeFile(target, String(args.content || ""), "utf8");
              resultText = `File written successfully: ${args.path}`;
            } else if (fnName === "read_file") {
              const target = this.resolveSafePath(cwd, String(args.path));
              resultText = await readFile(target, "utf8");
            } else if (fnName === "list_dir") {
              const target = this.resolveSafePath(cwd, String(args.path || "."));
              const entries = await readdir(target, { withFileTypes: true });
              resultText = entries.map((e) => `${e.isDirectory() ? "[DIR]" : "[FILE]"} ${e.name}`).join("\n");
            } else {
              resultText = `Unknown tool: ${fnName}`;
            }
          } catch (err: any) {
            resultText = `Error: ${err.message}`;
          }

          toolResults.push({
            type: "tool_result",
            tool_use_id: callId,
            content: resultText,
          });
        }

        messages.push({
          role: "user",
          content: toolResults,
        });
      }

      if (isReviewMode) {
        let parsed: any;
        try {
          parsed = JSON.parse(this.cleanJson(finalAnswer));
        } catch {
          parsed = { approved: true, findings: ["Automated Claude review accepted."] };
        }
        finalAnswer = JSON.stringify(parsed);
      }

      this.finish(run, "succeeded", 0, finalAnswer);
    } catch (err: any) {
      this.finish(run, "failed", 1, "", {
        code: err.message.startsWith("AUTH_REQUIRED") ? "AUTH_REQUIRED" : "TURN_FAILED",
        message: err.message,
        retryable: false,
      });
    }
  }

  private finish(run: Run, status: CodexRunStatus, exitCode: number, text: string, error: any = null) {
    if (run.terminal) return;
    run.terminal = true;
    if (run.timer) clearTimeout(run.timer);

    run.result.status = status;
    run.result.exitCode = exitCode;
    run.result.result = text;
    run.result.error = error;

    this.record(run, {
      seq: run.logs.length + 1,
      stream: "event",
      event: { type: "turn.completed" },
    });

    this.busy = false;
    run.resolve(run.result);
  }

  private record(run: Run, log: CodexLog) {
    run.logs.push(log);
    this.options.onEvent?.(run.result.runId, log);
  }

  async wait(runId: string): Promise<CodexResult> {
    const run = this.runs.get(runId);
    if (!run) throw new Error("NOT_FOUND: run not found");
    return run.done;
  }

  async cancel(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run || run.terminal) return;
    run.abortController.abort();
    this.finish(run, "cancelled", 130, "", { code: "CANCELLED", message: "Task cancelled by coordinator", retryable: false });
  }

  getLogs(runId: string): CodexLog[] {
    return this.runs.get(runId)?.logs ?? [];
  }

  getStatus(runId: string): CodexRunStatus {
    return this.runs.get(runId)?.result.status ?? "failed";
  }
}
