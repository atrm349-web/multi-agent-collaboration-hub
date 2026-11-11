import { readWorkspaceFile, writeWorkspaceFile, listWorkspaceFiles } from '../workspace-files.ts';
import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { GeminiClient, type GeminiContent } from "./client.ts";
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

export class GeminiRuntime {
  private readonly runs = new Map<string, Run>();
  private readonly client: GeminiClient;
  private busy = false;

  constructor(private readonly options: {
    workspaceRoot: string;
    onEvent?: (runId: string, log: CodexLog) => void;
    onSpawn?: (runId: string, processGroupId: number, kind?: "process-group" | "in-process") => void;
    killGraceMs?: number;
  }) {
    this.client = new GeminiClient();
  }

  async start(request: CodexRequest): Promise<string> {
    if (this.busy) throw new Error("AGENT_UNAVAILABLE: one Gemini run is already active");
    this.busy = true;

    try {
      const root = await realpath(this.options.workspaceRoot);
      const cwd = await realpath(request.cwd);
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
      this.options.onSpawn?.(runId, process.pid, "in-process");
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

  private cleanJson(raw: string): string {
    const trimmed = raw.trim();
    const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    return match ? match[1]!.trim() : trimmed;
  }

  private async executeLoop(run: Run, request: CodexRequest, cwd: string): Promise<void> {
    try {
      const isWrite = request.sandbox === "workspace-write";
      const systemInstruction = isWrite
        ? `You are an expert autonomous software engineer working in a local workspace repository.
You must solve the user's task by reading files and writing code.
If you need to write a file, you MUST output a block in this exact format:
<<<WRITE_FILE:relative/path/to/file.ext>>>
...file contents...
<<<END_FILE>>>

Output clear summaries of what you implemented. Do not alter unrelated files.`
        : request.outputSchema
          ? `You are an independent quality auditor. Review the workspace files.
Evaluate whether the code satisfies the goal and acceptance criteria.
Output your final answer as ONLY valid JSON conforming to this schema: ${JSON.stringify(request.outputSchema)}.
No markdown formatting or extra text.`
          : `You are an expert software engineer in read-only analysis mode. Inspect files and provide clear analysis.`;

      // Read current workspace files for context
      const fileList = (await listWorkspaceFiles(cwd)).filter((entry) => entry.isFile()).map((entry) => entry.name);
      const fileContexts: string[] = [];
      for (const f of fileList.slice(0, 10)) {
        try {
          const content = await readWorkspaceFile(cwd, f);
          if (content.length < 5000) fileContexts.push(`--- File: ${f} ---\n${content}`);
        } catch {}
      }

      const promptWithContext = fileContexts.length > 0
        ? `${request.prompt}\n\nCurrent workspace files for context:\n${fileContexts.join("\n\n")}`
        : request.prompt;

      const contents: GeminiContent[] = [
        { role: "user", parts: [{ text: promptWithContext }] }
      ];

      const model = request.model.startsWith("gemini") ? request.model : "gemini-3.5-flash-lite";

      const res = await this.client.generateContent({
        model,
        contents,
        systemInstruction,
        temperature: 0.1,
        signal: run.abortController.signal,
      });

      if (run.abortController.signal.aborted) throw new Error("CANCELLED: request stopped before file delivery");
      const text = res.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      this.record(run, {
        seq: run.logs.length + 1,
        stream: "event",
        event: { type: "item.completed", item: { type: "agent_message", text } },
      });

      // Parse and execute any file writes
      if (isWrite) {
        const fileRegex = /<<<WRITE_FILE:([^\n>]+)>>>\r?\n([\s\S]*?)<<<END_FILE>>>/g;
        let match;
        let filesWritten = 0;
        while ((match = fileRegex.exec(text)) !== null) {
          const filePath = match[1]!.trim();
          const fileContent = match[2]!;
          await writeWorkspaceFile(cwd, filePath, fileContent, isWrite);
          filesWritten++;
          this.record(run, {
            seq: run.logs.length + 1,
            stream: "event",
            event: { type: "tool.write_file", path: filePath, status: "ok" },
          });
        }
      }

      run.result.status = "succeeded";
      run.result.exitCode = 0;
      run.result.result = request.outputSchema ? this.cleanJson(text) : text;
    } catch (err: any) {
      if (!run.terminal) {
        run.result.status = "failed";
        run.result.error = {
          code: String(err.message).match(/^([A-Z_]+):/)?.[1] ?? "AGENT_ERROR",
          message: err.message ?? String(err),
          retryable: false,
        };
      }
    } finally {
      this.finish(run);
    }
  }

  private finish(run: Run): void {
    if (run.terminal) return;
    run.terminal = true;
    if (run.timer) clearTimeout(run.timer);
    this.busy = false;
    run.resolve(run.result);
  }

  private record(run: Run, log: CodexLog): void {
    run.logs.push(log);
    this.options.onEvent?.(run.result.runId, log);
  }

  async wait(runId: string): Promise<CodexResult> {
    const run = this.runs.get(runId);
    if (!run) throw new Error("NOT_FOUND: run not found");
    return await run.done;
  }

  async cancel(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run || run.terminal) return;
    run.abortController.abort();
    run.result.status = "cancelled";
    run.result.error = { code: "CANCELLED", message: "Run was cancelled by caller", retryable: false };
    this.finish(run);
  }

  getLogs(runId: string): CodexLog[] {
    return this.runs.get(runId)?.logs ?? [];
  }
}
