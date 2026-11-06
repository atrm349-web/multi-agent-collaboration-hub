import { spawn as spawnProcess, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Harness } from "../../../src/shared/types.ts";

export type CodexRunStatus = "starting" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled" | "timed_out";
export interface CodexRequest {
  cwd: string;
  prompt: string;
  sandbox: "read-only" | "workspace-write";
  model: string;
  effort: string;
  timeoutMs?: number;
  sessionId?: string;
}
export interface CodexLog {
  seq: number;
  stream: "event" | "stderr";
  event?: Record<string, unknown>;
  text?: string;
}
export interface CodexResult {
  runId: string;
  status: CodexRunStatus;
  sessionId: string | null;
  result: string;
  exitCode: number | null;
  error: { code: string; message: string; retryable: boolean } | null;
}
interface Run {
  result: CodexResult;
  logs: CodexLog[];
  logBytes: number;
  proc?: ChildProcess;
  done: Promise<CodexResult>;
  resolve: (result: CodexResult) => void;
  timer?: ReturnType<typeof setTimeout>;
  escalation?: ReturnType<typeof setTimeout>;
  terminal: boolean;
  failure: string | null;
  intent: "CANCELLED" | "TIMEOUT" | "PAYLOAD_TOO_LARGE" | null;
  finished: boolean;
  cleanupFailed: boolean;
}
const LIMIT = 1024 * 1024;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HARNESS: Harness = { id: "codex", kind: "codex", label: "Codex", isBuiltin: true,
  home: null, bin: null, env: {}, enabled: true };

/** One controlled local Codex process. */
// shortcut: run state is in memory; add B-03 persistence before long-lived service use.
export class CodexRuntime {
  private readonly runs = new Map<string, Run>();
  private busy = false;

  constructor(private readonly options: {
    workspaceRoot: string;
    spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
    onEvent?: (runId: string, log: CodexLog) => void;
    killGraceMs?: number;
  }) {
    if (process.platform === "win32") throw new Error("UNSUPPORTED_PLATFORM: process-tree cancellation is not verified on Windows");
  }

  async start(request: CodexRequest): Promise<string> {
    if (this.busy) throw new Error("AGENT_UNAVAILABLE: one Codex run is already active");
    this.busy = true;
    try {
      const fields = ["cwd", "prompt", "sandbox", "model", "effort", "timeoutMs", "sessionId"];
      if (!request || typeof request !== "object" || Array.isArray(request)
          || Object.keys(request).some((key) => !fields.includes(key))
          || typeof request.cwd !== "string" || !request.cwd
          || typeof request.prompt !== "string" || !request.prompt || Buffer.byteLength(request.prompt) > LIMIT
          || typeof request.model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(request.model)
          || typeof request.effort !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(request.effort)
          || !["read-only", "workspace-write"].includes(request.sandbox)
          || (request.sessionId !== undefined && !SESSION_ID.test(request.sessionId))
          || (request.timeoutMs !== undefined && (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0))) {
        throw new Error("INVALID_INPUT: invalid prompt, sandbox, session or timeout");
      }
      if (process.env.AGETOR_CODEX_BIN?.trim()) {
        throw new Error("PERMISSION_DENIED: the controlled runtime does not accept a binary override");
      }
      const root = await realpath(this.options.workspaceRoot);
      const cwd = await realpath(request.cwd);
      const relative = path.relative(root, cwd);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
          || !(await stat(cwd)).isDirectory()) {
        throw new Error("PERMISSION_DENIED: workspace escapes the configured root");
      }
      // agents.ts imports Agetor's DB; require explicit isolated storage before loading it.
      if (!process.env.AGETOR_DATA_DIR || !path.isAbsolute(process.env.AGETOR_DATA_DIR)) {
        throw new Error("PERMISSION_DENIED: AGETOR_DATA_DIR must explicitly name isolated storage");
      }
      const storage = await realpath(process.env.AGETOR_DATA_DIR);
      const storageRelative = path.relative(root, storage);
      if (storageRelative === ".." || storageRelative.startsWith(`..${path.sep}`)
          || path.isAbsolute(storageRelative) || !(await stat(storage)).isDirectory()) {
        throw new Error("PERMISSION_DENIED: AGETOR_DATA_DIR escapes the configured root");
      }
      const { buildCodexCommand } = await import("../../../src/bun/agents.ts");
      const built = await buildCodexCommand(HARNESS, request.prompt, {
        mode: request.sandbox === "read-only" ? "ask" : "auto",
        model: request.model, effort: request.effort, resumeSessionId: request.sessionId,
      }, cwd);
      const runId = randomUUID();
      let resolve!: (result: CodexResult) => void;
      const done = new Promise<CodexResult>((r) => { resolve = r; });
      const run: Run = { result: { runId, status: "starting", sessionId: request.sessionId ?? null,
        result: "", exitCode: null, error: null }, logs: [], logBytes: 0, done, resolve,
        terminal: false, failure: null, intent: null, finished: false, cleanupFailed: false };
      this.runs.set(runId, run);
      const env: NodeJS.ProcessEnv = {};
      for (const key of ["HOME", "PATH", "TMPDIR", "LANG", "LC_ALL", "CODEX_HOME",
        "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]) {
        if (process.env[key] !== undefined) env[key] = process.env[key];
      }
      try {
        const proc: ChildProcess = (this.options.spawn ?? spawnProcess)(built.cmd[0]!, built.cmd.slice(1), {
          cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"],
        });
        run.proc = proc;
        run.result.status = "running";
        const decoder = new StringDecoder("utf8");
        let pending = "";
        const readLine = (line: string) => {
          if (!line.trim() || run.finished) return;
          let event: Record<string, unknown>;
          try { event = JSON.parse(line); }
            catch { run.failure ??= "TRANSPORT_ERROR"; return; }
          if (!event || typeof event !== "object" || Array.isArray(event)) {
            run.failure ??= "TRANSPORT_ERROR";
            return;
          }
          this.record(run, { seq: run.logs.length + 1, stream: "event", event });
          if (event.type === "thread.started" && typeof event.thread_id === "string") run.result.sessionId = event.thread_id;
          if (event.type === "turn.completed") run.terminal = true;
          if (event.type === "turn.failed" || event.type === "error") run.failure ??= "TURN_FAILED";
          if (event.type === "item.completed") {
            const item = event.item as Record<string, unknown> | undefined;
            if (item?.type === "agent_message" && typeof item.text === "string") run.result.result = item.text;
          }
        };
        proc.stdout?.on("data", (chunk: Buffer) => {
          if (run.intent || run.finished) return;
          pending += decoder.write(chunk);
          if (Buffer.byteLength(pending) > LIMIT) { this.stop(run, "PAYLOAD_TOO_LARGE"); return; }
          let newline: number;
          while ((newline = pending.indexOf("\n")) !== -1) {
            readLine(pending.slice(0, newline));
            pending = pending.slice(newline + 1);
          }
        });
        proc.stderr?.on("data", (chunk: Buffer) => {
          if (!run.finished && !run.intent) this.record(run, {
            seq: run.logs.length + 1, stream: "stderr", text: chunk.toString("utf8"),
          });
        });
        proc.once("error", (error) => {
          run.failure = (error as NodeJS.ErrnoException).code === "ENOENT" ? "BINARY_NOT_FOUND" : "SPAWN_ERROR";
        });
        proc.once("close", async (code) => {
          pending += decoder.end();
          if (!run.intent) readLine(pending);
          run.result.exitCode = code;
          await this.reapGroup(run);
          this.finish(run);
        });
        proc.stdin?.on("error", () => { run.failure ??= "TRANSPORT_ERROR"; });
        proc.stdin?.end(request.prompt);
        run.timer = setTimeout(() => this.stop(run, "TIMEOUT"), request.timeoutMs ?? 120_000);
      } catch {
        run.failure = "SPAWN_ERROR";
        this.finish(run);
      }
      return runId;
    } catch (error) {
      this.busy = false;
      throw error;
    }
  }

  getStatus(runId: string): CodexRunStatus { return this.run(runId).result.status; }
  getResult(runId: string): CodexResult { return structuredClone(this.run(runId).result); }
  getLogs(runId: string, afterSeq = 0): CodexLog[] {
    return structuredClone(this.run(runId).logs.filter((log) => log.seq > afterSeq));
  }
  async wait(runId: string): Promise<CodexResult> { return structuredClone(await this.run(runId).done); }
  async cancel(runId: string): Promise<void> {
    const run = this.run(runId);
    this.stop(run, "CANCELLED");
    await run.done;
  }
  private run(id: string): Run {
    const run = this.runs.get(id);
    if (!run) throw new Error("NOT_FOUND: unknown run");
    return run;
  }
  private record(run: Run, log: CodexLog): void {
    run.logBytes += Buffer.byteLength(JSON.stringify(log));
    if (run.logBytes > LIMIT) { this.stop(run, "PAYLOAD_TOO_LARGE"); return; }
    run.logs.push(log);
    try { this.options.onEvent?.(run.result.runId, structuredClone(log)); }
    catch { /* Observer failure must not orphan the owned process. */ }
  }
  private stop(run: Run, intent: NonNullable<Run["intent"]>): void {
    if (run.finished || run.intent) return;
    run.intent = intent;
    run.result.status = "cancelling";
    const signal = (name: NodeJS.Signals) => {
      if (!run.proc?.pid) return;
      try { process.kill(-run.proc.pid, name); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") run.proc.kill(name);
      }
    };
    signal("SIGTERM");
    run.escalation = setTimeout(() => signal("SIGKILL"), this.options.killGraceMs ?? 2_000);
  }
  private finish(run: Run): void {
    if (run.finished) return;
    run.finished = true;
    clearTimeout(run.timer);
    clearTimeout(run.escalation);
    const code = (run.cleanupFailed ? "PROCESS_CRASHED" : run.intent) ?? run.failure ?? (run.result.exitCode !== 0 ? "PROCESS_CRASHED" :
      !run.terminal ? "MISSING_TERMINAL_EVENT" : null);
    run.result.status = code === "CANCELLED" ? "cancelled" : code === "TIMEOUT" ? "timed_out" : code ? "failed" : "succeeded";
    run.result.error = code ? { code, message: `Codex run ended with ${code}`, retryable: false } : null;
    this.busy = false;
    run.resolve(structuredClone(run.result));
  }
  private async reapGroup(run: Run): Promise<void> {
    const pid = run.proc?.pid;
    if (!pid) return;
    // close reaps the leader only; a descendant with ignored stdio can still be alive.
    const exists = () => {
      try { process.kill(-pid, 0); return true; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
        throw error;
      }
    };
    try {
      if (!exists()) return;
      try { process.kill(-pid, "SIGKILL"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      for (let i = 0; i < 100; i++) {
        if (!exists()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      run.cleanupFailed = true;
    } catch { run.cleanupFailed = true; }
  }
}
