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
    onSpawn?: (runId: string, processGroupId: number, kind?: "process-group" | "in-process") => void;
    killGraceMs?: number;
  }) {
    this.client = new WorkBuddyClient();
  }

  async start(request: CodexRequest): Promise<string> {
    if (request.sandbox === "read-only") throw new Error("UNSUPPORTED_CAPABILITY: WorkBuddy gateway has no verified read-only execution policy");
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
      const submitRes = await this.client.submitRun({
        task: request.prompt,
        workspace: cwd,
        output: "artifacts",
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

        const current = await this.client.waitRun(submitRes.run.id, 10);
        this.record(run, {
          seq: run.logs.length + 1,
          stream: "event",
          event: { type: "workbuddy.status", status: current.status, round: current.round },
        });

        if (current.status === "completed") {
          run.result.status = "succeeded";
          run.result.exitCode = 0;
          run.result.result = current.result?.text ?? "WorkBuddy completed task successfully";
          this.record(run, {
            seq: run.logs.length + 1,
            stream: "event",
            event: { type: "item.completed", item: { type: "agent_message", text: run.result.result } },
          });
          break;
        }

        if (current.status === "failed" || current.status === "cancelled" || current.status === "blocked") {
          run.result.status = current.status === "cancelled" ? "cancelled" : "failed";
          run.result.error = {
            code: current.error?.code ?? "WORKBUDDY_EXECUTION_FAILED",
            message: current.error?.message ?? `WorkBuddy ended with status: ${current.status}`,
            retryable: false,
          };
          break;
        }

        await new Promise(r => setTimeout(r, 1000));
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
