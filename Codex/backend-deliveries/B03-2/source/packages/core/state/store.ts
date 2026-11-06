import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { migrate } from "../../../src/bun/migrate.ts";
import schema from "../../../src/bun/migrations/082_hub_execution.sql" with { type: "text" };
import type { Agent, AgentRun, Approval, Artifact, EventEnvelope, LogLine, Message,
  Subtask, Task, Validation } from "../../shared/src/types.ts";
import type { CodexLog, CodexRequest, CodexResult } from "../../agent-adapters/codex/runtime.ts";

type Entities = { task: Task; subtask: Subtask; agent: Agent; run: AgentRun;
  message: Message; artifact: Artifact; approval: Approval; validation: Validation };
type Kind = keyof Entities;
type Claim = { run_id: string; owner_id: string; lease_until_ms: number;
  process_group_id: number | null; request_hash: string; request_json: string; subtask_id: string };
const ACTIVE = new Set(["starting", "running", "cancelling"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const allowed: Record<Kind, readonly string[]> = {
  task: ["draft","decomposing","queued","running","waiting_approval","pausing","paused","cancelling","succeeded","failed","timed_out","cancelled"],
  subtask: ["pending","ready","running","validating","waiting_approval","retry_wait","blocked","succeeded","failed","timed_out","cancelled"],
  agent: ["unknown","available","busy","unavailable","disabled"],
  run: ["queued","starting","running","cancelling","succeeded","failed","timed_out","cancelled","interrupted"],
  message: ["pending","delivered"], artifact: ["staged","validated","rejected"],
  approval: ["pending","approved","rejected","expired","invalidated"],
  validation: ["pending","running","passed","failed","unverified"],
};
export interface ClaimRequest {
  subtaskId: string; agentId: string; expectedVersion: number; idempotencyKey: string;
  request: CodexRequest; ownerId: string;
}

/** Uses an explicitly supplied Agetor database, never opens a user's default file. */
export class HubStore {
  constructor(readonly db: Database, private readonly clock = Date.now, readonly leaseMs = 10_000) {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 100) throw new Error("INVALID_INPUT: invalid lease duration");
    db.run("PRAGMA foreign_keys=ON"); db.run("PRAGMA busy_timeout=3000");
    db.run("PRAGMA journal_mode=WAL"); db.run("PRAGMA synchronous=FULL");
    migrate(db, [{ id: "082_hub_execution", sql: schema }]);
  }
  get<K extends Kind>(kind: K, id: string): Entities[K] {
    const row = this.db.query<{ data: string }, [string,string]>(
      "SELECT data FROM hub_entities WHERE id=? AND kind=?").get(id,kind);
    if (!row) throw new Error("NOT_FOUND: unknown entity");
    return JSON.parse(row.data);
  }
  list<K extends Kind>(kind: K, taskId: string, limit = 100): Entities[K][] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("INVALID_INPUT: limit");
    return this.db.query<{ data: string }, [string,string,number]>(
      "SELECT data FROM hub_entities WHERE kind=? AND task_id=? ORDER BY created_at,id LIMIT ?")
      .all(kind,taskId,limit).map((row) => JSON.parse(row.data));
  }
  put<K extends Exclude<Kind,"run">>(kind: K, data: Entities[K], expectedVersion: number | null): Entities[K] {
    return this.db.transaction(() => this.save(kind,data,expectedVersion)).immediate();
  }
  private save<K extends Kind>(kind: K, data: Entities[K], expectedVersion: number | null): Entities[K] {
    if (!Object.hasOwn(allowed,kind) || !data || !UUID.test(data.id) || !["mock","live"].includes(data.executionMode)
        || (expectedVersion !== null && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1))) throw new Error("INVALID_INPUT: entity");
    const old = this.db.query<{ data: string; kind: string }, [string]>("SELECT data,kind FROM hub_entities WHERE id=?").get(data.id);
    const previous = old ? JSON.parse(old.data) as Entities[K] : null;
    if (old?.kind !== undefined && old.kind !== kind) throw new Error("CONFLICT: entity kind is immutable");
    if ((previous?.version ?? null) !== expectedVersion) throw new Error("CONFLICT: stale entity version");
    if (previous && (previous.executionMode !== data.executionMode ||
        ("provenance" in previous && "provenance" in data && previous.provenance !== data.provenance))) throw new Error("CONFLICT: evidence origin is immutable");
    if (previous && "provenance" in previous && previous.provenance === "historical") throw new Error("UNSUPPORTED_TRANSITION: historical evidence is immutable");
    const taskId = "taskId" in data ? data.taskId : null;
    if (taskId) this.get("task",taskId);
    if ("subtaskId" in data) {
      const linked = this.get("subtask",data.subtaskId);
      if (linked.taskId !== taskId) throw new Error("CONFLICT: cross-task subtask reference");
    }
    const linkedRunId = kind === "artifact" ? (data as Artifact).producerRunId : "runId" in data ? data.runId : kind === "message" ? (data as Message).fromRunId : null;
    if (linkedRunId) {
      const linked = this.get("run",linkedRunId);
      if (linked.taskId !== taskId || ("subtaskId" in data && linked.subtaskId !== data.subtaskId)) throw new Error("CONFLICT: cross-task run reference");
    }
    const artifactIds = "artifactRefs" in data ? data.artifactRefs : "evidenceArtifactIds" in data ? data.evidenceArtifactIds : [];
    for (const id of artifactIds) if (this.get("artifact",id).taskId !== taskId) throw new Error("CONFLICT: cross-task artifact reference");
    if (kind === "message" && this.get("subtask",(data as Message).toSubtaskId).taskId !== taskId) throw new Error("CONFLICT: message target");
    if (previous && kind === "approval" && (previous as Approval).status !== "pending") throw new Error("UNSUPPORTED_TRANSITION: approval already decided");
    if (previous && kind === "artifact") {
      for (const key of ["sha256","relativePath","sizeBytes","producerRunId"] as const) {
        if ((previous as Artifact)[key] !== (data as Artifact)[key]) throw new Error("CONFLICT: artifact content is immutable");
      }
    }
    if (previous && "taskId" in previous && previous.taskId !== taskId) throw new Error("CONFLICT: task ownership is immutable");
    const status = kind === "agent" ? (data as Agent).availability : kind === "artifact" ? (data as Artifact).validationStatus :
      kind === "message" ? ((data as Message).deliveredAt ? "delivered" : "pending") : (data as Task).status;
    if (!allowed[kind].includes(status)) throw new Error("INVALID_INPUT: unsupported entity status");
    if (previous && ["succeeded","failed","timed_out","cancelled","interrupted"].includes((previous as AgentRun).status)
        && status !== (previous as AgentRun).status && kind !== "subtask") throw new Error("UNSUPPORTED_TRANSITION: terminal state");
    if (kind === "task" && status === "succeeded" && (data as Task).provenance !== "historical") {
      throw new Error("UNSUPPORTED_CAPABILITY: task success requires the B-05 result validator");
    }
    const now = new Date(this.clock()).toISOString();
    const saved = { ...data, version: previous ? previous.version + 1 : 1,
      createdAt: previous?.createdAt ?? now, updatedAt: now } as Entities[K];
    this.db.query("INSERT INTO hub_entities(id,kind,task_id,status,version,data,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) " +
      "ON CONFLICT(id) DO UPDATE SET status=excluded.status,version=excluded.version,data=excluded.data,updated_at=excluded.updated_at")
      .run(saved.id,kind,taskId,status,saved.version,JSON.stringify(saved),saved.createdAt,saved.updatedAt);
    const event = kind === "run" ? "run.updated" : kind === "message" ? "message.created" : kind === "artifact" ? "artifact.created" :
      kind === "approval" ? (status === "pending" ? "approval.required" : "approval.decided") : kind === "validation" ? "validation.completed" : `${kind}.updated`;
    // Nonterminal validation records are snapshot-only until B-05 defines progress events.
    if (kind !== "validation" || ["passed","failed"].includes(status)) {
      this.emit(event,kind === "task" ? saved.id : taskId,kind === "run" ? saved.id : null,saved.version,saved);
    }
    return saved;
  }
  private emit(type: string, taskId: string | null, runId: string | null, version: number | null, payload: unknown): void {
    this.db.query("INSERT INTO hub_outbox(event_type,task_id,run_id,entity_version,payload,created_at) VALUES(?,?,?,?,?,?)")
      .run(type,taskId,runId,version,JSON.stringify(payload),new Date(this.clock()).toISOString());
  }
  claim(input: ClaimRequest): { run: AgentRun; created: boolean } {
    if (!input.idempotencyKey?.trim() || input.idempotencyKey.length > 128 || !input.ownerId?.trim()) throw new Error("INVALID_INPUT: claim key/owner");
    const request = JSON.stringify({ agentId: input.agentId, request: Object.fromEntries(Object.entries(input.request).sort(([a],[b]) => a.localeCompare(b))) });
    const hash = createHash("sha256").update(request).digest("hex");
    return this.db.transaction(() => {
      const existing = this.db.query<Claim,[string,string]>("SELECT * FROM hub_run_claims WHERE subtask_id=? AND idempotency_key=?")
        .get(input.subtaskId,input.idempotencyKey);
      if (existing) {
        if (existing.request_hash !== hash) throw new Error("CONFLICT: idempotency key payload changed");
        return { run: this.get("run",existing.run_id), created: false };
      }
      const subtask = this.get("subtask",input.subtaskId); const task = this.get("task",subtask.taskId);
      const agent = this.get("agent",input.agentId);
      if (subtask.version !== input.expectedVersion) throw new Error("CONFLICT: stale subtask version");
      if (!["ready","retry_wait"].includes(subtask.status) || !["queued","running"].includes(task.status)
          || task.provenance !== "current" || !["available","busy"].includes(agent.availability)
          || agent.adapterId !== "codex-cli" || agent.executionMode !== "live" || task.executionMode !== "live"
          || subtask.executionMode !== "live") throw new Error("UNSUPPORTED_TRANSITION: subtask/agent is not executable");
      if (subtask.requiredCapabilities.some((capability) => !agent.capabilities.includes(capability)) || !agent.supportedStages.includes(subtask.stage)) {
        throw new Error("UNSUPPORTED_CAPABILITY: agent cannot execute this subtask");
      }
      if (input.request.sandbox === "workspace-write" && agent.permissionProfile !== "workspace-write") throw new Error("PERMISSION_DENIED: agent profile forbids writes");
      if (!Number.isSafeInteger(subtask.attempt) || subtask.attempt < 1 || subtask.attempt > subtask.maxAttempts) throw new Error("UNSUPPORTED_TRANSITION: attempts exhausted");
      if (subtask.dependsOn.some((id) => { const dep = this.get("subtask",id); return dep.taskId !== task.id || dep.status !== "succeeded"; })) {
        throw new Error("DEPENDENCY_FAILED: prerequisites are not satisfied");
      }
      if (this.db.query("SELECT 1 FROM hub_execution_slot").get()) throw new Error("AGENT_UNAVAILABLE: execution slot is occupied or quarantined");
      if (this.db.query("SELECT 1 FROM hub_run_claims WHERE subtask_id=? AND attempt=?").get(subtask.id,subtask.attempt)) {
        throw new Error("CONFLICT: attempt already has a run");
      }
      const now = new Date(this.clock()).toISOString();
      const run = this.save("run",{ id: randomUUID(), version: 1, createdAt: now, updatedAt: now,
        executionMode: "live", provenance: "current", taskId: task.id, subtaskId: subtask.id, agentId: agent.id,
        status: "starting", attempt: subtask.attempt, providerSessionId: input.request.sessionId ?? null,
        workspaceId: subtask.workspaceId ?? subtask.id, startedAt: null, endedAt: null, exitCode: null, error: null },null);
      this.db.query("INSERT INTO hub_run_claims(run_id,subtask_id,attempt,idempotency_key,request_hash,request_json,owner_id,lease_until_ms) VALUES(?,?,?,?,?,?,?,?)")
        .run(run.id,subtask.id,subtask.attempt,input.idempotencyKey,hash,JSON.stringify(input.request),input.ownerId,this.clock()+this.leaseMs);
      this.db.query("INSERT INTO hub_execution_slot(id,run_id) VALUES(1,?)").run(run.id);
      this.save("subtask",{ ...subtask,status: "running",assignedAgentId: agent.id },subtask.version);
      this.save("agent",{ ...agent,availability: "busy" },agent.version);
      if (task.status === "queued") this.save("task",{ ...task,status: "running",startedAt: now },task.version);
      return { run, created: true };
    }).immediate();
  }
  private owned(runId: string, owner: string): { run: AgentRun; claim: Claim } {
    const claim = this.db.query<Claim,[string]>("SELECT * FROM hub_run_claims WHERE run_id=?").get(runId);
    const run = this.get("run",runId);
    if (!claim || claim.owner_id !== owner || claim.lease_until_ms <= this.clock() || !ACTIVE.has(run.status)) {
      throw new Error("CONFLICT: execution lease lost or run is terminal");
    }
    return { run,claim };
  }
  heartbeat(runId: string, owner: string): void {
    this.db.transaction(() => { this.owned(runId,owner);
      this.db.query("UPDATE hub_run_claims SET lease_until_ms=? WHERE run_id=?").run(this.clock()+this.leaseMs,runId);
    }).immediate();
  }
  spawned(runId: string, owner: string, pid: number): void {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("INVALID_INPUT: process group");
    this.db.transaction(() => { const { run } = this.owned(runId,owner);
      this.db.query("UPDATE hub_run_claims SET process_group_id=? WHERE run_id=?").run(pid,runId);
      this.save("run",{ ...run,status: run.status === "cancelling" ? "cancelling" : "running",startedAt: new Date(this.clock()).toISOString() },run.version);
    }).immediate();
  }
  recordLog(runId: string, owner: string, log: CodexLog): void {
    this.db.transaction(() => {
      const { run } = this.owned(runId,owner);
      if (!Number.isSafeInteger(log.seq) || log.seq < 1) throw new Error("INVALID_INPUT: log sequence");
      const existing = this.db.query<{ data: string },[string,number]>("SELECT data FROM hub_logs WHERE run_id=? AND log_seq=?").get(runId,log.seq);
      const item = log.event?.item as { text?: string } | undefined;
      const line: LogLine = { logSeq: log.seq,timestamp: new Date(this.clock()).toISOString(),stream: log.stream === "stderr" ? "stderr" : "system",
        text: log.text ?? item?.text ?? JSON.stringify(log.event), ...(run.status === "cancelling" ? { drained: true } : {}) };
      const stored = JSON.stringify({ raw: log,line });
      if (existing) {
        if (JSON.stringify(JSON.parse(existing.data).raw) !== JSON.stringify(log)) throw new Error("CONFLICT: log sequence reused");
        return;
      }
      this.db.query("INSERT INTO hub_logs VALUES(?,?,?)").run(runId,log.seq,stored);
      if (log.event?.type === "thread.started" && typeof log.event.thread_id === "string") {
        this.save("run",{ ...run,providerSessionId: log.event.thread_id },run.version);
      }
      this.emit("run.output",run.taskId,run.id,null,line);
    }).immediate();
  }
  logs(runId: string, afterSeq = 0, limit = 200): LogLine[] {
    this.get("run",runId);
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("INVALID_INPUT: log cursor");
    return this.db.query<{ data: string },[string,number,number]>("SELECT data FROM hub_logs WHERE run_id=? AND log_seq>? ORDER BY log_seq LIMIT ?")
      .all(runId,afterSeq,limit).map((row) => JSON.parse(row.data).line);
  }
  requestCancel(runId: string, expectedVersion: number): AgentRun {
    return this.db.transaction(() => { const run = this.get("run",runId);
      if (!ACTIVE.has(run.status)) return run;
      return this.save("run",{ ...run,status: "cancelling" },expectedVersion);
    }).immediate();
  }
  complete(runId: string, owner: string, result: CodexResult): AgentRun {
    return this.db.transaction(() => {
      const { run,claim } = this.owned(runId,owner);
      if (claim.process_group_id) {
        try { process.kill(-claim.process_group_id,0); throw new Error("AGENT_UNAVAILABLE: process group has not stopped"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
      if (!["succeeded","failed","cancelled","timed_out"].includes(result.status)) throw new Error("INVALID_INPUT: nonterminal result");
      const status = (run.status === "cancelling" ? "cancelled" : result.status) as "succeeded" | "failed" | "cancelled" | "timed_out";
      const saved = this.save("run",{ ...run,status,providerSessionId: result.sessionId ?? run.providerSessionId,
        endedAt: new Date(this.clock()).toISOString(),exitCode: result.exitCode,
        error: status === "cancelled" ? { code: "CANCELLED",message: "Cancellation requested",retryable: false } : result.error },run.version);
      const subtask = this.get("subtask",run.subtaskId);
      this.save("subtask",{ ...subtask,status: status === "succeeded" ? "validating" : status,error: saved.error },subtask.version);
      this.db.query("DELETE FROM hub_execution_slot WHERE run_id=?").run(run.id);
      const agent = this.get("agent",run.agentId);
      if (agent.availability === "busy") this.save("agent",{ ...agent,availability: "available" },agent.version);
      return saved;
    }).immediate();
  }
  reconcileExpired(): string[] {
    return this.db.transaction(() => {
      const rows = this.db.query<{ run_id: string },[number]>("SELECT c.run_id FROM hub_run_claims c JOIN hub_entities e ON e.id=c.run_id " +
        "WHERE e.status IN ('starting','running','cancelling') AND c.lease_until_ms<=?").all(this.clock());
      for (const { run_id } of rows) {
        const run = this.get("run",run_id);
        const error = { code: "PROCESS_CRASHED",message: "Execution owner lost; reconcile side effects before retry",retryable: false };
        this.save("run",{ ...run,status: "interrupted",endedAt: new Date(this.clock()).toISOString(),error },run.version);
        const subtask = this.get("subtask",run.subtaskId);
        this.save("subtask",{ ...subtask,status: "blocked",error },subtask.version);
        const task = this.get("task",run.taskId);
        this.save("task",{ ...task,error },task.version);
      }
      // Keep the occupied slot: old children may still be executing. Never kill a reused PID.
      return rows.map((row) => row.run_id);
    }).immediate();
  }
  acknowledgeInterruption(runId: string, expectedVersion: number, evidence: { processGroupVerifiedStopped: boolean; reason: string }): void {
    this.db.transaction(() => {
      const run = this.get("run",runId);
      if (run.version !== expectedVersion) throw new Error("CONFLICT: stale run version");
      if (run.status !== "interrupted" || evidence.processGroupVerifiedStopped !== true || !evidence.reason.trim()) {
        throw new Error("UNSUPPORTED_TRANSITION: explicit stopped-process and side-effect review required");
      }
      if (!this.db.query("SELECT 1 FROM hub_execution_slot WHERE run_id=?").get(runId)) return;
      const claim = this.db.query<Claim,[string]>("SELECT * FROM hub_run_claims WHERE run_id=?").get(runId)!;
      if (claim.process_group_id) {
        try { process.kill(-claim.process_group_id,0); throw new Error("AGENT_UNAVAILABLE: process group is still present"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
      this.db.query("DELETE FROM hub_execution_slot WHERE run_id=?").run(runId);
      const agent = this.get("agent",run.agentId);
      if (agent.availability === "busy") this.save("agent",{ ...agent,availability: "available" },agent.version);
      this.emit("run.updated",run.taskId,run.id,run.version,{ ...run,reconciliationNote: evidence.reason });
    }).immediate();
  }
  snapshot<T>(read: () => T): { snapshotSeq: number; data: T } {
    return this.db.transaction(() => ({ data: read(),snapshotSeq: this.db.query<{ seq: number },[]>("SELECT COALESCE(MAX(seq),0) AS seq FROM hub_outbox").get()!.seq })).deferred();
  }
  events(afterSeq = 0, limit = 100): EventEnvelope[] {
    const max = this.db.query<{ seq: number },[]>("SELECT COALESCE(MAX(seq),0) AS seq FROM hub_outbox").get()!.seq;
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("INVALID_INPUT: event cursor");
    if (afterSeq > max) throw new Error("EVENT_CURSOR_EXPIRED: event cursor is ahead of the store");
    return this.db.query<{ seq: number; event_type: EventEnvelope["type"]; task_id: string|null; run_id: string|null; entity_version: number|null; payload: string; created_at: string },[number,number]>(
      "SELECT * FROM hub_outbox WHERE seq>? ORDER BY seq LIMIT ?").all(afterSeq,limit).map((row) => ({ schemaVersion: "0.2",seq: row.seq,type: row.event_type,
        timestamp: row.created_at,...(row.task_id ? { taskId: row.task_id } : {}),...(row.run_id ? { runId: row.run_id } : {}),
        ...(row.entity_version !== null ? { version: row.entity_version } : {}),payload: JSON.parse(row.payload) }));
  }
  acknowledgeEvent(consumer: string, seq: number): boolean {
    if (!consumer.trim() || !Number.isSafeInteger(seq) || seq < 1) throw new Error("INVALID_INPUT: receipt");
    return this.db.query("INSERT OR IGNORE INTO hub_event_receipts VALUES(?,?)").run(consumer,seq).changes === 1;
  }
}
