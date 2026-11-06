import { randomUUID } from "node:crypto";
import { CodexRuntime, type CodexResult } from "../../agent-adapters/codex/runtime.ts";
import type { AgentRun } from "../../shared/src/types.ts";
import { HubStore, type ClaimRequest } from "./store.ts";

interface Job {
  runtime: CodexRuntime; runtimeId: string | null;
  completion: Promise<void>; failure: unknown;
}

/** Persistent claims surround the process lifecycle; a fresh runner never replays old work. */
export class DurableCodexRunner {
  private readonly ownerId = randomUUID();
  private readonly jobs = new Map<string,Job>();

  constructor(private readonly store: HubStore,
    private readonly options: Pick<ConstructorParameters<typeof CodexRuntime>[0],"workspaceRoot" | "spawn" | "killGraceMs">) {
    this.store.reconcileExpired();
  }

  start(input: Omit<ClaimRequest,"ownerId">): string {
    const claimed = this.store.claim({ ...input,ownerId: this.ownerId });
    if (!claimed.created) return claimed.run.id;
    const id = claimed.run.id;
    let persistenceFailure: unknown = null;
    const job: Job = { runtime: null as unknown as CodexRuntime,runtimeId: null,completion: Promise.resolve(),failure: null };
    const stopForFailure = (error: unknown, runtimeId: string) => {
      persistenceFailure ??= error;
      // Runtime observers must not throw into a stream callback or leave a process running.
      queueMicrotask(() => { void job.runtime.cancel(runtimeId).catch((failure) => { job.failure ??= failure; }); });
    };
    job.runtime = new CodexRuntime({ ...this.options,
      onSpawn: (runtimeId,pid) => {
        job.runtimeId = runtimeId;
        try { this.store.spawned(id,this.ownerId,pid); }
        catch (error) { persistenceFailure ??= error; throw error; }
        if (this.store.get("run",id).status === "cancelling") throw new Error("CANCELLED: task was cancelled before prompt delivery");
      },
      onEvent: (runtimeId,log) => {
        job.runtimeId = runtimeId;
        try { this.store.recordLog(id,this.ownerId,log); }
        catch (error) { stopForFailure(error,runtimeId); }
      },
    });
    this.jobs.set(id,job);
    const heartbeat = setInterval(() => {
      try {
        this.store.heartbeat(id,this.ownerId);
        if (this.store.get("run",id).status === "cancelling" && job.runtimeId) {
          void job.runtime.cancel(job.runtimeId).catch((error) => { job.failure ??= error; });
        }
      } catch (error) {
        persistenceFailure ??= error;
        if (job.runtimeId) stopForFailure(error,job.runtimeId);
      }
    },Math.max(25,Math.floor(this.store.leaseMs/3)));
    job.completion = (async () => {
      let outcome: CodexResult;
      try {
        job.runtimeId = await job.runtime.start(input.request);
        if (persistenceFailure || this.store.get("run",id).status === "cancelling") await job.runtime.cancel(job.runtimeId);
        outcome = await job.runtime.wait(job.runtimeId);
      } catch (error) {
        if (job.runtimeId) await job.runtime.cancel(job.runtimeId);
        const match = String(error).match(/(?:Error: )?([A-Z_]+):/);
        outcome = { runId: id,status: "failed",sessionId: null,result: "",exitCode: null,
          error: { code: match?.[1] ?? "SPAWN_ERROR",message: String(error),retryable: false } };
      }
      if (persistenceFailure) outcome = { ...outcome,status: "failed",
        error: { code: "PROCESS_CRASHED",message: "Persistence failed; owned process was stopped",retryable: false } };
      // Expired ownership or quarantine is intentionally not overwritten by a late result.
      this.store.complete(id,this.ownerId,outcome);
    })().catch((error) => { job.failure = error; }).finally(() => { clearInterval(heartbeat); this.jobs.delete(id); });
    return id;
  }

  async wait(runId: string): Promise<AgentRun> {
    const job = this.jobs.get(runId);
    if (job) {
      await job.completion;
      if (job.failure) throw job.failure;
    }
    const saved = this.store.get("run",runId);
    if (!job && ["starting","running","cancelling"].includes(saved.status)) {
      throw new Error("AGENT_UNAVAILABLE: run belongs to another worker or requires recovery; inspect stored state");
    }
    return saved;
  }
  async cancel(runId: string, expectedVersion: number): Promise<AgentRun> {
    const run = this.store.requestCancel(runId,expectedVersion);
    if (run.status !== "cancelling") return run;
    const job = this.jobs.get(runId);
    if (job?.runtimeId) await job.runtime.cancel(job.runtimeId);
    // A different worker reads the persisted cancellation on its next heartbeat.
    return job ? this.wait(runId) : run;
  }
}
