import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { HubStore } from "../../packages/core/state/store.ts";
import { DurableCodexRunner } from "../../packages/core/state/durable-codex.ts";
import type { Agent, Task, Subtask } from "../../packages/shared/src/types.ts";

let root: string; let db: Database; let store: HubStore; let task: Task; let agent: Agent; let step: Subtask;
let count: number; const active: { runner: DurableCodexRunner; id: string }[] = [];
const previousDataDir = process.env.AGETOR_DATA_DIR;
const common = () => ({ id: randomUUID(),version: 1,createdAt: new Date().toISOString(),updatedAt: new Date().toISOString(),executionMode: "live" as const });
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(),"hub-durable-"));
  process.env.AGETOR_DATA_DIR = path.join(root,"state"); mkdirSync(process.env.AGETOR_DATA_DIR); mkdirSync(path.join(root,"workspace"));
  db = new Database(path.join(root,"state","test.sqlite")); store = new HubStore(db); count = 0;
  task = store.put("task",{ ...common(),provenance: "current",title: "durable",goal: "test",repositoryId: randomUUID(),baseCommit: "abc",status: "queued",priority: "medium",
    progressPct: 0,pendingApprovalCount: 0,artifactCount: 0,acceptanceCriteria: [],error: null,startedAt: null,endedAt: null,deadlineAt: null },null);
  agent = store.put("agent",{ ...common(),label: "Codex",roleTitle: "developer",adapterId: "codex-cli",adapterVersion: "test",availability: "available",capabilities: ["stream","cancel"],supportedStages: ["implementation"],permissionProfile: "read-only",maxConcurrency: 1 },null);
  step = store.put("subtask",{ ...common(),taskId: task.id,code: "SUB-01",title: "step",description: "test",stage: "implementation",dependsOn: [],requiredCapabilities: [],acceptanceCriteria: [],status: "ready",assignedAgentId: null,workspaceId: randomUUID(),branchName: null,progressPct: 0,attempt: 1,maxAttempts: 2,timeoutMs: 3000,outputArtifactIds: [],error: null },null);
});
afterEach(async () => {
  for (const item of active.splice(0)) {
    const run = store.get("run",item.id);
    if (["starting","running","cancelling"].includes(run.status)) await item.runner.cancel(item.id,run.version).catch(() => {});
  }
  db.close(); rmSync(root,{ recursive: true,force: true });
  if (previousDataDir === undefined) delete process.env.AGETOR_DATA_DIR; else process.env.AGETOR_DATA_DIR = previousDataDir;
});
function input() { return { subtaskId: step.id,agentId: agent.id,expectedVersion: step.version,idempotencyKey: "one",
  request: { cwd: path.join(root,"workspace"),prompt: "test",sandbox: "read-only" as const,model: "gpt-6.1-sol",effort: "high",timeoutMs: 3000 } }; }
const success = `console.log(JSON.stringify({type:'thread.started',thread_id:'11111111-1111-4111-8111-111111111111'}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'persisted'}}));console.log(JSON.stringify({type:'turn.completed'}));`;
function runner(script = success) {
  return new DurableCodexRunner(store,{ workspaceRoot: root,killGraceMs: 30,spawn: (_cmd,args,options) => {
    count++; return spawn(process.execPath,["--eval",script],options);
  } });
}
function start(r: DurableCodexRunner, request = input()) { const id = r.start(request);active.push({ runner: r,id });return id; }

test("persistent wrapper records process identity, logs and completion, without a duplicate process", async () => {
  const r = runner(); const id = start(r); const duplicate = r.start(input());
  expect(duplicate).toBe(id);
  expect((await r.wait(id)).status).toBe("succeeded"); expect(count).toBe(1);
  expect(store.logs(id).some((log) => log.text === "persisted")).toBe(true);
  expect(store.get("run",id).providerSessionId).toBe("11111111-1111-4111-8111-111111111111");
  const otherDb = new Database(path.join(root,"state","test.sqlite"));
  try {
    const reopened = new HubStore(otherDb); const restarted = new DurableCodexRunner(reopened,{ workspaceRoot: root });
    expect((await restarted.wait(id)).status).toBe("succeeded");
    expect(restarted.start(input())).toBe(id); expect(count).toBe(1);
  } finally { otherDb.close(); }
});

test("cancel before asynchronous preflight never delivers the task prompt", async () => {
  const r = runner("let text='';process.stdin.on('data',x=>text+=x);process.stdin.on('end',()=>{if(text)process.exit(9)});setInterval(()=>{},1000)");
  const id = start(r); const run = store.get("run",id);
  expect((await r.cancel(id,run.version)).status).toBe("cancelled");
  expect(store.logs(id)).toEqual([]);
});

test("active timeout is durable and releases the stopped execution slot", async () => {
  const r = runner("process.on('SIGTERM',()=>{});setInterval(()=>{},1000)");
  const id = start(r,{ ...input(),request: { ...input().request,timeoutMs: 100 } });
  expect((await r.wait(id)).status).toBe("timed_out");
  expect(store.get("subtask",step.id).status).toBe("timed_out");
  expect(db.query("SELECT * FROM hub_execution_slot").all()).toEqual([]);
});

test("logging failure stops the owned process and cannot produce durable success", async () => {
  const r = runner(`console.log(JSON.stringify({type:'turn.started'}));setInterval(()=>{},1000)`);
  db.run("CREATE TEMP TRIGGER reject_log BEFORE INSERT ON hub_logs BEGIN SELECT RAISE(ABORT,'injected log failure'); END");
  const id = start(r);
  expect((await r.wait(id)).status).toBe("failed");
  expect(store.get("run",id).error?.code).toBe("PROCESS_CRASHED");
  expect(db.query("SELECT * FROM hub_execution_slot").all()).toEqual([]);
});

test("preflight failure is persisted rather than leaving an active run", async () => {
  const r = runner(); const id = start(r,{ ...input(),request: { ...input().request,cwd: tmpdir() } });
  expect((await r.wait(id)).status).toBe("failed");
  expect(store.get("run",id).error?.code).toBe("PERMISSION_DENIED"); expect(count).toBe(0);
});

test("a fresh runner quarantines expired startup claims without replay", async () => {
  const claim = store.claim({ ...input(),ownerId: "dead-worker" });
  db.query("UPDATE hub_run_claims SET lease_until_ms=0 WHERE run_id=?").run(claim.run.id);
  const r = runner();
  expect(r.start(input())).toBe(claim.run.id);
  expect((await r.wait(claim.run.id)).status).toBe("interrupted");
  expect(count).toBe(0);
  expect(db.query("SELECT * FROM hub_execution_slot").all().length).toBe(1);
});

test("a foreign live owner is not mistaken for a completed wait", async () => {
  const claim = store.claim({ ...input(),ownerId: "other-worker" });
  const r = runner();
  await expect(r.wait(claim.run.id)).rejects.toThrow("AGENT_UNAVAILABLE");
  expect(count).toBe(0);
});

test("process identity persistence failure stops before delivering a prompt", async () => {
  db.run("CREATE TEMP TRIGGER reject_identity BEFORE UPDATE OF process_group_id ON hub_run_claims BEGIN SELECT RAISE(ABORT,'injected identity failure'); END");
  let delivered = false;
  const r = new DurableCodexRunner(store,{ workspaceRoot: root,killGraceMs: 30,spawn: (_cmd,_args,options) => {
    const proc = spawn(process.execPath,["--eval","setInterval(()=>{},1000)"],options);
    const stdin = proc.stdin!;
    const original = stdin.end.bind(stdin);
    stdin.end = ((...args: unknown[]) => { if (typeof args[0] === "string" && args[0]) delivered = true; return (original as (...args: unknown[]) => unknown)(...args); }) as typeof stdin.end;
    return proc;
  } });
  const id = start(r);
  expect((await r.wait(id)).status).toBe("failed");
  expect(delivered).toBe(false);
  expect(store.get("run",id).error?.code).toBe("PROCESS_CRASHED");
});

import { spyOn } from 'bun:test';
import { ClaudeRuntime } from '../../packages/agent-adapters/claude/runtime.ts';
import { DeepSeekRuntime } from '../../packages/agent-adapters/deepseek/runtime.ts';
test('Claude dispatch failure stays Claude and never silently falls back to DeepSeek', async () => {
  const claude = spyOn(ClaudeRuntime.prototype,'start').mockImplementation(async () => { throw new Error('AUTH_REQUIRED: fixture'); });
  const deepseek = spyOn(DeepSeekRuntime.prototype,'start').mockImplementation(async () => { throw new Error('UNEXPECTED_FALLBACK'); });
  try {
    const r = runner();
    const id = start(r,{...input(),request:{...input().request,model:'claude-fixture'}});
    const run = await r.wait(id);
    expect(run.status).toBe('failed'); expect(run.provider).toBe('claude');
    expect(run.error?.code).toBe('AUTH_REQUIRED');
    expect(claude).toHaveBeenCalledTimes(1); expect(deepseek).not.toHaveBeenCalled();
  } finally { claude.mockRestore(); deepseek.mockRestore(); }
});
