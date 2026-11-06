import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { HubStore } from "../packages/core/state/store.ts";
import { DurableCodexRunner } from "../packages/core/state/durable-codex.ts";
import type { Agent, Task, Subtask } from "../packages/shared/src/types.ts";

const argument = process.argv[2];
if (!argument) throw new Error("Supply a new evidence directory");
const output = path.resolve(argument);
if (existsSync(output)) throw new Error("Existing evidence is never overwritten");
const workspace = path.join(output,"workspace");
process.env.AGETOR_DATA_DIR = path.join(output,"state");
mkdirSync(workspace,{ recursive: true,mode: 0o700 });
mkdirSync(process.env.AGETOR_DATA_DIR,{ recursive: true,mode: 0o700 });
const { db } = await import("../src/bun/db.ts");
const store = new HubStore(db);
const common = () => ({ id: randomUUID(),version: 1,createdAt: new Date().toISOString(),updatedAt: new Date().toISOString(),executionMode: "live" as const });
const task: Task = store.put("task",{ ...common(),provenance: "current",title: "persistence proof",goal: "prove durable CLI execution",repositoryId: randomUUID(),baseCommit: "none",status: "queued",priority: "medium",progressPct: 0,pendingApprovalCount: 0,artifactCount: 0,acceptanceCriteria: [],error: null,startedAt: null,endedAt: null,deadlineAt: null },null);
const agent: Agent = store.put("agent",{ ...common(),label: "Codex",roleTitle: "developer",adapterId: "codex-cli",adapterVersion: "0.166.0-alpha.5.1",availability: "available",capabilities: ["stream","cancel","resume"],supportedStages: ["implementation"],permissionProfile: "workspace-write",maxConcurrency: 1 },null);
const step: Subtask = store.put("subtask",{ ...common(),taskId: task.id,code: "SUB-01",title: "real CLI",description: "durable proof",stage: "implementation",dependsOn: [],requiredCapabilities: ["stream"],acceptanceCriteria: [],status: "ready",assignedAgentId: null,workspaceId: randomUUID(),branchName: null,progressPct: 0,attempt: 1,maxAttempts: 2,timeoutMs: 90000,outputArtifactIds: [],error: null },null);
let modelCalls = 0;
const runner = new DurableCodexRunner(store,{ workspaceRoot: output,spawn: (command,args,options) => {
  modelCalls++; return spawn(command,args,options);
} });
const blockedStateFile = path.join(process.env.AGETOR_DATA_DIR,"control-state-write-blocked.txt");
const denialCommand = `python3 -c ${JSON.stringify(`open(${JSON.stringify(blockedStateFile)}, 'w').write('SHOULD_BE_DENIED')`)}`;
const input = { subtaskId: step.id,agentId: agent.id,expectedVersion: step.version,idempotencyKey: "real-once",
  request: { cwd: workspace,prompt: `This is an authorized negative test on a dedicated fixture. Execute exactly this shell command: ${denialCommand}. Permission denial is expected. Do not escalate or try alternatives. Then reply HUB_DURABLE_OK.`,sandbox: "workspace-write" as const,model: "gpt-6.1-sol",effort: "high",timeoutMs: 90000 } };
const runId = runner.start(input);
assert.equal(runner.start(input),runId);
const completed = await runner.wait(runId);
assert.equal(completed.status,"succeeded"); assert.equal(modelCalls,1);
assert.ok(store.logs(runId).some((log) => log.text.includes("HUB_DURABLE_OK")));
assert.equal(existsSync(blockedStateFile),false);
const deniedCommandRecorded = store.logs(runId).some((line) => {
  try {
    const e = JSON.parse(line.text);
    return e.type === "item.completed" && e.item?.type === "command_execution" && e.item?.exit_code !== 0
      && typeof e.item?.exit_code === "number" && String(e.item.command).includes("control-state-write-blocked");
  } catch { return false; }
});
assert.ok(deniedCommandRecorded,"Need an actual denied control-storage write command");
assert.equal(store.get("subtask",step.id).status,"validating");
assert.equal(store.get("task",task.id).status,"running");
const crashStep = store.put("subtask",{ ...step,id: randomUUID(),code: "SUB-02" },null);
const crashInput = { ...input,subtaskId: crashStep.id,idempotencyKey: "startup-crash",ownerId: "crash-fixture" };
const file = path.join(process.env.AGETOR_DATA_DIR,"agetor.sqlite");
db.run("PRAGMA wal_checkpoint(TRUNCATE)"); db.close();
const moduleFile = path.resolve(import.meta.dir,"../packages/core/state/store.ts");
// This worker intentionally crashes AFTER claim commit and BEFORE launching any model.
const crashSource = `import {Database} from 'bun:sqlite';import {HubStore} from ${JSON.stringify(moduleFile)};
  const store=new HubStore(new Database(${JSON.stringify(file)}),Date.now,100);
  console.log(JSON.stringify(store.claim(${JSON.stringify(crashInput)})));
  process.kill(process.pid,'SIGKILL');`;
const worker = Bun.spawn([process.execPath,"--eval",crashSource],{ stdout: "pipe",stderr: "pipe" });
const [exit,workerOut,workerErr] = await Promise.all([worker.exited,new Response(worker.stdout).text(),new Response(worker.stderr).text()]);
assert.notEqual(exit,0); assert.equal(workerErr,"");
const crashedId = JSON.parse(workerOut).run.id as string;
await Bun.sleep(150);
const reopenedDb = new Database(file); const reopened = new HubStore(reopenedDb);
assert.equal(reopened.get("run",runId).status,"succeeded");
assert.equal(reopened.get("run",runId).providerSessionId,completed.providerSessionId);
assert.ok(reopened.logs(runId).some((log) => log.text.includes("HUB_DURABLE_OK")));
assert.deepEqual(reopened.reconcileExpired(),[crashedId]);
assert.equal(reopened.get("run",crashedId).status,"interrupted");
assert.equal(reopened.get("subtask",crashStep.id).status,"blocked");
assert.equal(reopened.claim({ ...input,ownerId: "restarted-worker" }).created,false);
assert.equal(reopened.claim(crashInput).created,false);
const watermark = reopened.snapshot(() => reopened.get("task",task.id));
const summary = { passed: true,execution: "real",modelCalls,runId,providerSessionId: completed.providerSessionId,
  persistedRunStatus: reopened.get("run",runId).status,subtaskStatus: reopened.get("subtask",step.id).status,
  taskNotPrematurelySucceeded: reopened.get("task",task.id).status === "running",
  logsAfterReopen: reopened.logs(runId).length,snapshotSeq: watermark.snapshotSeq,
  startupWorkerCrashInjected: true,modelProcessCrashTested: false,crashedRunId: crashedId,
  crashedRunStatus: reopened.get("run",crashedId).status,
  quarantinedSlotRetained: reopenedDb.query("SELECT * FROM hub_execution_slot").all().length === 1,
  noAutomaticModelReplay: modelCalls === 1,controlStorageWriteDenied: deniedCommandRecorded };
writeFileSync(path.join(output,"summary.json"),JSON.stringify(summary,null,2));
writeFileSync(path.join(output,"events.json"),JSON.stringify(reopened.events(0,500),null,2));
reopenedDb.close();
console.log("REAL_PERSISTENCE_AND_STARTUP_CRASH_VERIFIED");
