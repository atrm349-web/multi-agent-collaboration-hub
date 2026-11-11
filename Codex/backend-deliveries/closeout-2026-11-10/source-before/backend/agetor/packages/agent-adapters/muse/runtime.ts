import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { MuseClient } from "./client.ts";
import type { CodexRequest, CodexResult, CodexLog } from "../codex/runtime.ts";

interface Run {
  result: CodexResult;
  logs: CodexLog[];
  done: Promise<CodexResult>;
  resolve: (result: CodexResult) => void;
  timer?: ReturnType<typeof setTimeout>;
  museRunId?: string;
  terminal: boolean;
}

export class MuseRuntime {
  private readonly runs = new Map<string, Run>();
  private readonly client: MuseClient;
  private busy = false;

  constructor(private readonly options: {
    workspaceRoot: string;
    onEvent?: (runId: string, log: CodexLog) => void;
    onSpawn?: (runId: string, processGroupId: number) => void;
    killGraceMs?: number;
  }) {
    this.client = new MuseClient();
  }

  async start(request: CodexRequest): Promise<string> {
    if (this.busy) throw new Error("AGENT_UNAVAILABLE: one Muse run is already active");
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
        if (run.museRunId) void this.client.cancelRun(run.museRunId).catch(() => {});
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
        ? `${request.prompt}\n\n[Meta Muse 自带额度说明]：请使用 Muse 自身额度执行，正常写入平台指定的本轮结果文件 output.json 并调用 report（将纯 JSON 结构放入 "json" 字段与 "text" 字段，"artifacts" 设为空数组 []）。`
        : `${request.prompt}\n\n[Meta Muse 自带额度说明]：请在当前工作目录 (${cwd}) 使用 Muse 自身额度完成任务要求的文件编写/修改，并写入交付报告 DELIVERY_REPORT.md 与结果文件 output.json。`;

      const submitRes = await this.client.submitRun({
        task: taskPrompt,
        workspace: cwd,
        output: wantsJson ? "json" : "text",
        timeoutSeconds: Math.floor((request.timeoutMs ?? 180_000) / 1000),
      });

      run.museRunId = submitRes.run.id;
      this.record(run, {
        seq: run.logs.length + 1,
        stream: "event",
        event: { type: "muse.submitted", museRunId: submitRes.run.id, status: submitRes.run.status, quotaType: "self_quota" },
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
          event: { type: "muse.status", status: current.status, round: current.round },
        });

        if (current.status === "completed") {
          run.result.status = "succeeded";
          run.result.exitCode = 0;
          if (wantsJson && current.result?.json !== undefined) {
            run.result.result = typeof current.result.json === "string"
              ? current.result.json
              : JSON.stringify(current.result.json);
          } else {
            run.result.result = current.result?.text ?? (current.result?.json !== undefined ? JSON.stringify(current.result.json) : "Muse completed task successfully with internal quota");
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
            code: current.error?.code ?? "MUSE_EXECUTION_FAILED",
            message: current.error?.message ?? `Muse ended with status: ${current.status}`,
            retryable: current.error?.code === "DISPATCH_NOT_SENT",
          };
          break;
        }

        await new Promise(r => setTimeout(r, 250));
      }

      if (!run.terminal && run.result.status === "running") {
        if (run.museRunId) void this.client.cancelRun(run.museRunId).catch(() => {});
        run.result.status = "timed_out";
        run.result.error = { code: "TIMEOUT", message: `Execution timed out after ${timeoutMs}ms`, retryable: true };
      }
    } catch (err: any) {
      if (!run.terminal) {
        run.result.status = "failed";
        run.result.error = {
          code: "MUSE_ADAPTER_ERROR",
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
    if (run.museRunId) void this.client.cancelRun(run.museRunId).catch(() => {});
    run.result.status = "cancelled";
    run.result.error = { code: "CANCELLED", message: "Run was cancelled by caller", retryable: false };
    this.finish(run);
  }

  getLogs(runId: string): CodexLog[] {
    return this.runs.get(runId)?.logs ?? [];
  }
}
