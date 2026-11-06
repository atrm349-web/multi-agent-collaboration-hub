import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { HubStore, type ClaimRequest } from "../../packages/core/state/store.ts";
import type { Agent, Subtask, Task } from "../../packages/shared/src/types.ts";
import type { CodexResult } from "../../packages/agent-adapters/codex/runtime.ts";

let folder: string; let db: Database; let store: HubStore; let now: number;
let task: Task; let agent: Agent; let subtask: Subtask;
const common = () => ({ id: randomUUID(),version: 1,createdAt: new Date(now).toISOString(),updatedAt: new Date(now).toISOString(),executionMode: "live" as const });
beforeEach(() => {
  folder = mkdtempSync(path.join(tmpdir(),"hub-state-")); now = 1_790_000_000_000;
  db = new Database(path.join(folder,"test.sqlite"));
  store = new HubStore(db,() => now,1000);
  task = store.put("task",{ ...common(),provenance: "current",title: "test",goal: "test",repositoryId: randomUUID(),baseCommit: "abc",
    status: "queued",priority: "medium",progressPct: 0,pendingApprovalCount: 0,artifactCount: 0,acceptanceCriteria: [],
    error: null,startedAt: null,endedAt: null,deadlineAt: null },null);
  agent = store.put("agent",{ ...common(),label: "Codex",roleTitle: "developer",adapterId: "codex-cli",adapterVersion: "test",
    availability: "available",capabilities: ["stream","cancel","resume"],supportedStages: ["implementation"],permissionProfile: "read-only",maxConcurrency: 1 },null);
  subtask = store.put("subtask",{ ...common(),taskId: task.id,code: "SUB-01",title: "test",description: "test",stage: "implementation",status: "ready",
    dependsOn: [],requiredCapabilities: [],acceptanceCriteria: [],assignedAgentId: null,workspaceId: randomUUID(),branchName: null,
    progressPct: 0,attempt: 1,maxAttempts: 2,timeoutMs: 1000,outputArtifactIds: [],error: null },null);
});
afterEach(() => { db.close(); rmSync(folder,{ recursive: true,force: true }); });
function input(key = "request-1"): ClaimRequest {
  return { subtaskId: subtask.id,agentId: agent.id,expectedVersion: subtask.version,idempotencyKey: key,ownerId: "worker-1",
    request: { cwd: folder,prompt: "hello",sandbox: "read-only",model: "gpt-6.1-sol",effort: "high",timeoutMs: 1000 } };
}
const result = (runId: string): CodexResult => ({ runId,status: "succeeded",sessionId: null,result: "done",exitCode: 0,error: null });

test("entity CAS and outbox commit together, and stale writes do not mutate either", () => {
  const count = store.events().length;
  const changed = store.put("task",{ ...task,title: "changed" },task.version);
  expect(changed.version).toBe(2);
  expect(store.events().length).toBe(count+1);
  expect(() => store.put("task",{ ...task,title: "lost update" },task.version)).toThrow("CONFLICT");
  expect(store.get("task",task.id).title).toBe("changed");
  expect(store.events().length).toBe(count+1);
});

test("a failed outbox insert rolls back the entity update", () => {
  db.run("CREATE TEMP TRIGGER reject_event BEFORE INSERT ON hub_outbox BEGIN SELECT RAISE(ABORT,'injected disk failure'); END");
  expect(() => store.put("task",{ ...task,title: "uncommitted" },task.version)).toThrow();
  expect(store.get("task",task.id).title).toBe("test");
  expect(store.get("task",task.id).version).toBe(1);
});

test("same idempotency key survives reopening and never creates a second run", () => {
  const first = store.claim(input());
  const other = new Database(path.join(folder,"test.sqlite"));
  try {
    const reopened = new HubStore(other,() => now,1000);
    const second = reopened.claim(input());
    expect(second.created).toBe(false); expect(second.run.id).toBe(first.run.id);
    expect(reopened.list("run",task.id).length).toBe(1);
    expect(() => reopened.claim({ ...input(),request: { ...input().request,prompt: "different" } })).toThrow("CONFLICT");
  } finally { other.close(); }
});

test("single execution slot blocks other workers and attempts", () => {
  store.claim(input());
  const second = store.put("subtask",{ ...subtask,id: randomUUID(),code: "SUB-02" },null);
  expect(() => store.claim({ ...input("second"),subtaskId: second.id,expectedVersion: second.version,ownerId: "worker-2" })).toThrow("AGENT_UNAVAILABLE");
  expect(store.list("run",task.id).length).toBe(1);
});

test("multi-concurrency store allows parallel execution up to maxConcurrency", () => {
  const multiDb = new Database(":memory:");
  try {
    const multiStore = new HubStore(multiDb,() => now,1000,2);
    const mTask = multiStore.put("task",{ ...task,id: randomUUID() },null);
    const mAgent = multiStore.put("agent",{ ...agent,id: randomUUID() },null);
    const step1 = multiStore.put("subtask",{ ...subtask,id: randomUUID(),taskId: mTask.id,code: "SUB-01" },null);
    const step2 = multiStore.put("subtask",{ ...subtask,id: randomUUID(),taskId: mTask.id,code: "SUB-02" },null);
    const step3 = multiStore.put("subtask",{ ...subtask,id: randomUUID(),taskId: mTask.id,code: "SUB-03" },null);

    const claim1 = multiStore.claim({ ...input("m1"),agentId: mAgent.id,subtaskId: step1.id,expectedVersion: step1.version,ownerId: "worker-1" });
    expect(claim1.created).toBe(true);

    const claim2 = multiStore.claim({ ...input("m2"),agentId: mAgent.id,subtaskId: step2.id,expectedVersion: step2.version,ownerId: "worker-2" });
    expect(claim2.created).toBe(true);
    expect(multiStore.list("run",mTask.id).length).toBe(2);

    expect(() => multiStore.claim({ ...input("m3"),agentId: mAgent.id,subtaskId: step3.id,expectedVersion: step3.version,ownerId: "worker-3" }))
      .toThrow("AGENT_UNAVAILABLE");
  } finally { multiDb.close(); }
});

test("unmet dependencies and historical tasks cannot launch", () => {
  const blocked = store.put("subtask",{ ...subtask,id: randomUUID(),dependsOn: [subtask.id] },null);
  expect(() => store.claim({ ...input(),subtaskId: blocked.id })).toThrow("DEPENDENCY_FAILED");
  const history = store.put("task",{ ...task,id: randomUUID(),provenance: "historical" },null);
  const historyStep = store.put("subtask",{ ...subtask,id: randomUUID(),taskId: history.id },null);
  expect(() => store.claim({ ...input(),subtaskId: historyStep.id })).toThrow("UNSUPPORTED_TRANSITION");
  expect(() => store.put("task",{ ...history,title: "change history" },history.version)).toThrow("historical");
  expect(() => store.put("task",{ ...task,provenance: "historical" },task.version)).toThrow("CONFLICT");
});

test("cancel intention is durable and wins over a late successful result", () => {
  const claim = store.claim(input()); store.spawned(claim.run.id,"worker-1",99_999_999);
  const running = store.get("run",claim.run.id);
  store.requestCancel(running.id,running.version);
  const completed = store.complete(running.id,"worker-1",result(running.id));
  expect(completed.status).toBe("cancelled");
  expect(store.get("subtask",subtask.id).status).toBe("cancelled");
  expect(() => store.complete(running.id,"worker-1",result(running.id))).toThrow("CONFLICT");
});

test("logs and provider session persist with deduplication", () => {
  const { run } = store.claim(input()); const seq = store.snapshot(() => null).snapshotSeq;
  const log = { seq: 1,stream: "event" as const,event: { type: "thread.started",thread_id: randomUUID() } };
  store.recordLog(run.id,"worker-1",log); store.recordLog(run.id,"worker-1",log);
  expect(store.logs(run.id).length).toBe(1);
  expect(store.get("run",run.id).providerSessionId).toBe(log.event.thread_id);
  expect(store.events(seq).filter((e) => e.type === "run.output").length).toBe(1);
  expect(() => store.recordLog(run.id,"worker-1",{ ...log,event: { ...log.event,type: "different" } })).toThrow("CONFLICT");
});

test("successful process only moves subtask to validating, never completes the task", () => {
  const { run } = store.claim(input());
  store.complete(run.id,"worker-1",result(run.id));
  expect(store.get("subtask",subtask.id).status).toBe("validating");
  const activeTask = store.get("task",task.id);
  expect(activeTask.status).toBe("running");
  expect(() => store.put("task",{ ...activeTask,status: "succeeded" },activeTask.version)).toThrow("B-05");
});

test("expired ownership is quarantined; no blind replay or stale completion", () => {
  const { run } = store.claim(input()); now += 1001;
  expect(store.reconcileExpired()).toEqual([run.id]);
  expect(store.reconcileExpired()).toEqual([]);
  expect(store.get("run",run.id).status).toBe("interrupted");
  expect(store.get("subtask",subtask.id).status).toBe("blocked");
  expect(() => store.complete(run.id,"worker-1",result(run.id))).toThrow("CONFLICT");
  const second = store.put("subtask",{ ...subtask,id: randomUUID(),code: "SUB-02" },null);
  expect(() => store.claim({ ...input("second"),subtaskId: second.id })).toThrow("AGENT_UNAVAILABLE");
  const interrupted = store.get("run",run.id);
  expect(() => store.acknowledgeInterruption(run.id,interrupted.version,{ processGroupVerifiedStopped: false,reason: "unchecked" })).toThrow();
  store.acknowledgeInterruption(run.id,interrupted.version,{ processGroupVerifiedStopped: true,reason: "No process was spawned; reviewed pending request" });
  expect(store.claim({ ...input("second"),subtaskId: second.id }).created).toBe(true);
});

test("heartbeat extends the lease but cannot resurrect an expired owner", () => {
  const { run } = store.claim(input()); now += 700; store.heartbeat(run.id,"worker-1");
  now += 700; expect(store.reconcileExpired()).toEqual([]);
  now += 301; expect(() => store.heartbeat(run.id,"worker-1")).toThrow("CONFLICT");
  expect(store.reconcileExpired()).toEqual([run.id]);
});

test("snapshot watermark replays later mutations and consumer receipts are idempotent", () => {
  const snapshot = store.snapshot(() => store.get("task",task.id));
  store.put("task",{ ...task,title: "after snapshot" },task.version);
  const events = store.events(snapshot.snapshotSeq);
  expect(snapshot.data.title).toBe("test"); expect(events.length).toBe(1);
  expect(events[0]!.payload.title).toBe("after snapshot");
  expect(store.acknowledgeEvent("frontend",events[0]!.seq)).toBe(true);
  expect(store.acknowledgeEvent("frontend",events[0]!.seq)).toBe(false);
  expect(() => store.events(999999)).toThrow("EVENT_CURSOR_EXPIRED");
});

test("all seven entities and validation evidence survive reopening without touching old tables", () => {
  db.run("CREATE TABLE old_tasks(id TEXT PRIMARY KEY); INSERT INTO old_tasks VALUES('original')");
  const { run } = store.claim(input());
  const msg = store.put("message",{ ...common(),provenance: "current",taskId: task.id,fromRunId: run.id,toSubtaskId: subtask.id,
    fromLabel: "developer",toLabel: "reviewer",summary: "handoff",content: "result",kind: "context_handoff",
    correlationId: randomUUID(),causationId: null,artifactRefs: [],deliveredAt: null },null);
  const artifact = store.put("artifact",{ ...common(),provenance: "current",taskId: task.id,subtaskId: subtask.id,producerRunId: run.id,
    name: "code",relativePath: "result.py",sha256: "a".repeat(64),sizeBytes: 4,mimeType: "text/plain",category: "code",validationStatus: "staged" },null);
  const approval = store.put("approval",{ ...common(),taskId: task.id,subtaskId: subtask.id,runId: run.id,actionType: "test",
    actionDigest: "a".repeat(64),summary: "review",status: "pending",expiresAt: new Date(now+5000).toISOString(),artifactRefs: [artifact.id],decidedAt: null,decidedBy: null },null);
  const check = store.put("validation",{ ...common(),provenance: "current",taskId: task.id,subtaskId: subtask.id,runId: run.id,
    criterionId: "criterion",status: "unverified",exitCode: null,evidenceArtifactIds: [] },null);
  const other = new Database(path.join(folder,"test.sqlite"));
  try {
    const reopened = new HubStore(other);
    expect(reopened.get("message",msg.id).summary).toBe("handoff");
    expect(reopened.get("artifact",artifact.id).sha256).toBe("a".repeat(64));
    expect(reopened.get("approval",approval.id).status).toBe("pending");
    expect(reopened.get("validation",check.id).status).toBe("unverified");
    expect(other.query("SELECT id FROM old_tasks").get()).toEqual({ id: "original" });
  } finally { other.close(); }
});

test("two real worker processes race the same idempotency key without duplicate claims", async () => {
  const modulePath = path.resolve(import.meta.dir,"../../packages/core/state/store.ts");
  const source = `import {Database} from 'bun:sqlite';import {HubStore} from ${JSON.stringify(modulePath)};
    const db=new Database(${JSON.stringify(path.join(folder,"test.sqlite"))});
    const store=new HubStore(db,()=>${now},1000);
    console.log(JSON.stringify(store.claim(${JSON.stringify(input())})));db.close();`;
  const workers = [Bun.spawn([process.execPath,"--eval",source],{ stdout: "pipe",stderr: "pipe" }),
    Bun.spawn([process.execPath,"--eval",source],{ stdout: "pipe",stderr: "pipe" })];
  const results = await Promise.all(workers.map(async (worker) => {
    const [code,out,err] = await Promise.all([worker.exited,new Response(worker.stdout).text(),new Response(worker.stderr).text()]);
    expect(err).toBe(""); expect(code).toBe(0); return JSON.parse(out);
  }));
  expect(results.filter((item) => item.created).length).toBe(1);
  expect(results[0].run.id).toBe(results[1].run.id);
  expect(store.list("run",task.id).length).toBe(1);
});

test("agent capability and permission mismatches cannot claim a process", () => {
  const writes = { ...input(),request: { ...input().request,sandbox: "workspace-write" as const } };
  expect(() => store.claim(writes)).toThrow("PERMISSION_DENIED");
  subtask = store.put("subtask",{ ...subtask,requiredCapabilities: ["live-context"] },subtask.version);
  expect(() => store.claim(input())).toThrow("UNSUPPORTED_CAPABILITY");
  expect(store.list("run",task.id)).toEqual([]);
});

test("interruption acknowledgement never releases a still-present process group", async () => {
  const child = spawn(process.execPath,["--eval","setInterval(()=>{},1000)"],{ detached: true,stdio: "ignore" });
  try {
    const { run } = store.claim(input()); store.spawned(run.id,"worker-1",child.pid!);
    now += 1001; store.reconcileExpired();
    const interrupted = store.get("run",run.id);
    expect(() => store.acknowledgeInterruption(run.id,interrupted.version,{ processGroupVerifiedStopped: true,reason: "wrong assertion" })).toThrow("AGENT_UNAVAILABLE");
  } finally {
    process.kill(-child.pid!,"SIGKILL");
    await new Promise<void>((resolve) => child.once("close",() => resolve()));
  }
});
