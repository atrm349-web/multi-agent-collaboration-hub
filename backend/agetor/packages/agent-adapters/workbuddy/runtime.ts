import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { WorkBuddyClient } from "./client.ts";
import type { CodexRequest, CodexResult, CodexLog } from "../codex/runtime.ts";

interface Run {
  result: CodexResult;
  logs: CodexLog[];
  done: Promise<CodexResult>;
  resolve: (result: CodexResult) => void;
  timer?: ReturnType<typeof setTimeout>;
  wbRunId?: string;
  terminal: boolean;
}

export class WorkBuddyRuntime {
  private readonly runs = new Map<string, Run>();
  private readonly client: WorkBuddyClient;
  private busy = false;

  constructor(private readonly options: {
    workspaceRoot: string;
    onEvent?: (runId: string, log: CodexLog) => void;
    onSpawn?: (runId: string, processGroupId: number) => void;
    killGraceMs?: number;
  }) {
    this.client = new WorkBuddyClient();
  }

  async start(request: CodexRequest): Promise<string> {
    if (this.busy) throw new Error("AGENT_UNAVAILABLE: one WorkBuddy run is already active");
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
        if (run.wbRunId) void this.client.cancelRun(run.wbRunId).catch(() => {});
        run.result.status = "timed_out";
        run.result.error = { code: "TIMEOUT", message: `Execution timed out after ${timeoutMs}ms`, retryable: true };
        this.finish(run);
      }, timeoutMs);

      void this.execute(run, request, cwd);
      return runId;
    } catch (error) {
      this.busy = false;
      throw error;
    }
  }

  private async execute(run: Run, request: CodexRequest, cwd: string): Promise<void> {
    try {
      const wantsJson = Boolean(request.outputSchema);
      const taskPrompt = wantsJson
        ? `${request.prompt}\n\n[WorkBuddy 网关说明]：请正常写入平台指定的本轮结果文件 output.json 并调用 report（这属于平台正常交付机制，不违反只读/不修改代码目录的约束）。请将上述要求的纯 JSON 结构同时放入 output.json 的 "json" 字段与 "text" 字段中，"artifacts" 設为空数组 []。`
        : `${request.prompt}\n\n[WorkBuddy 网关说明]：请在当前工作目录 (${cwd}) 完成任务要求的文件修改或编写，并正常写入平台指定的本轮结果文件 output.json（将中文成果说明填入 "text" 字段）及调用 report。`;

      const submitRes = await this.client.submitRun({
        task: taskPrompt,
        workspace: cwd,
        output: wantsJson ? "json" : "text",
        timeoutSeconds: Math.floor((request.timeoutMs ?? 180_000) / 1000),
      });

      run.wbRunId = submitRes.run.id;
      this.record(run, {
        seq: run.logs.length + 1,
        stream: "event",
        event: { type: "workbuddy.submitted", wbRunId: submitRes.run.id, status: submitRes.run.status },
      });

      // Poll until finished
      const startTime = Date.now();
      const timeoutMs = request.timeoutMs ?? 180_000;

      while (Date.now() - startTime < timeoutMs) {
        if (run.terminal) break;

        const current = await this.client.waitRun(submitRes.run.id, 15);
        this.record(run, {
          seq: run.logs.length + 1,
          stream: "event",
          event: { type: "workbuddy.status", status: current.status, round: current.round },
        });

        if (current.status === "completed") {
          run.result.status = "succeeded";
          run.result.exitCode = 0;
          if (wantsJson && current.result?.json !== undefined) {
            run.result.result = typeof current.result.json === "string"
              ? current.result.json
              : JSON.stringify(current.result.json);
          } else {
            run.result.result = current.result?.text ?? (current.result?.json !== undefined ? JSON.stringify(current.result.json) : "WorkBuddy completed task successfully");
          }
          this.record(run, {
            seq: run.logs.length + 1,
            stream: "event",
            event: { type: "item.completed", item: { type: "agent_message", text: run.result.result } },
          });
          break;
        }

        if (current.status === "failed" || current.status === "cancelled" || current.status === "blocked" || current.status === "uncertain") {
          run.result.status = current.status === "cancelled" ? "cancelled" : "failed";
          run.result.error = {
            code: current.error?.code ?? "WORKBUDDY_EXECUTION_FAILED",
            message: current.error?.message ?? `WorkBuddy ended with status: ${current.status}`,
            retryable: current.error?.code === "DISPATCH_NOT_SENT",
          };
          break;
        }

        await new Promise(r => setTimeout(r, 250));
      }

      if (!run.terminal && run.result.status === "running") {
        if (run.wbRunId) void this.client.cancelRun(run.wbRunId).catch(() => {});
        run.result.status = "timed_out";
        run.result.error = { code: "TIMEOUT", message: `Execution timed out after ${timeoutMs}ms`, retryable: true };
      }
    } catch (err: any) {
      if (!run.terminal) {
        run.result.status = "failed";
        run.result.error = {
          code: "WORKBUDDY_ADAPTER_ERROR",
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
    if (run.wbRunId) void this.client.cancelRun(run.wbRunId).catch(() => {});
    run.result.status = "cancelled";
    run.result.error = { code: "CANCELLED", message: "Run was cancelled by caller", retryable: false };
    this.finish(run);
  }

  getLogs(runId: string): CodexLog[] {
    return this.runs.get(runId)?.logs ?? [];
  }
}
