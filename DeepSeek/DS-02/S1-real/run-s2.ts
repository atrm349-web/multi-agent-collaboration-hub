// DS-02 S2 (real models): approve-reject → explicit rework → new approval.
// Closes the "旧审批失效 / 旧产物不复活" half of DS-02 with real model calls.
import { readFile, writeFile, mkdir, cp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const BACKEND = "/Users/anyunhong/Desktop/集合agent/backend/agetor";
const SHARED = "/Users/anyunhong/Desktop/集合agent";
const BUN = "/Users/anyunhong/Documents/Codex/2026-11-02/multi-agent-collaboration-hub-ai-agent/work/tooling/node_modules/@oven/bun-darwin-aarch64/bin/bun";
const DIR = path.join(HERE, "S2");
const REPO = path.join(DIR, "repo");
const RUNTIME = path.join(DIR, "runtime");
const CONFIG = path.join(DIR, "config.json");
const EVIDENCE = path.join(DIR, "evidence");
const SRC_REPO = path.join(HERE, "..", "..", "DS-04-real-e2e", "repo");
const ORACLE_DIR = path.join(HERE, "..", "..", "DS-04-real-e2e", "owner-tests");
const ORACLE = path.join(ORACLE_DIR, "check.mjs");
const PORT = 4346;
const REPO_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

await rm(DIR, { recursive: true, force: true });
await mkdir(DIR, { recursive: true });
await mkdir(EVIDENCE, { recursive: true });
await cp(SRC_REPO, REPO, { recursive: true });
await rm(path.join(REPO, ".git"), { recursive: true, force: true });
await Bun.$`git init -q ${REPO}`;
await Bun.$`git -C ${REPO} add -A`;
await Bun.$`git -C ${REPO} -c user.name=owner -c user.email=owner@local commit -qm baseline`;
const BASE = (await Bun.$`git -C ${REPO} rev-parse HEAD`.text()).trim();

await writeFile(CONFIG, JSON.stringify({
  root: RUNTIME, port: PORT, maxConcurrency: 1,
  frontendDir: "/Users/anyunhong/Desktop/集合agent/apps/web/public",
  repositories: [{
    id: REPO_ID, label: "DS-02 S2 reject/rework", path: REPO,
    defaultTestProfileId: "acceptance", model: "deepseek-chat",
    models: { planner: "deepseek-reasoner", developer: "deepseek-chat", reviewer: "deepseek-chat" },
    effort: "low",
    testProfiles: [{ id: "acceptance", command: ["/usr/local/bin/node", ORACLE], timeoutMs: 20000, readPaths: [ORACLE_DIR] }],
  }],
}, null, 2));

const log = async (m: string) => { const l = `${new Date().toISOString()} ${m}`; console.log(l); await writeFile(path.join(EVIDENCE, "s2.log"), l + "\n", { flag: "a" }); };
await writeFile(path.join(EVIDENCE, "s2.log"), "");
await log(`repo base=${BASE}`);

const hub = spawn(BUN, [path.join(BACKEND, "scripts/start-hub.ts"), CONFIG], {
  cwd: SHARED, stdio: ["ignore", "pipe", "pipe"], detached: true,
  env: { ...process.env, PATH: `/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin:${process.env.PATH}` },
});
let creds: any = null;
for (let i = 0; i < 120; i++) {
  await Bun.sleep(500);
  try { creds = JSON.parse(await readFile(path.join(RUNTIME, "state", "credentials.json"), "utf8")); break; } catch {}
}
if (!creds) { await log("hub not ready"); process.exit(1); }
await log(`hub ready ${creds.origin}`);
const headers = { authorization: `Bearer ${creds.token}` };
const api = async (m: string, p: string, body?: unknown) => {
  const h: Record<string, string> = { ...headers };
  if (body !== undefined) { h["content-type"] = "application/json"; h["idempotency-key"] = crypto.randomUUID(); }
  const r = await fetch(creds.origin + p, { method: m, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const taskOf = async (id: string) => { const d = await api("GET", `/api/v1/tasks/${id}`); return d.body?.data ?? d.body; };

const out: any = { base: BASE };
try {
  const create = await api("POST", "/api/v1/tasks", {
    title: "DS-02 S2: reject then rework",
    goal: "Implement parseDuration in src/duration.js following README.md.",
    repositoryId: REPO_ID, priority: "medium",
    acceptanceCriteria: [{ id: "AC-FINAL", description: "owner oracle exits 0", testProfileId: "acceptance" }],
    plannedSubtasks: [{
      id: crypto.randomUUID(), code: "IMPL", title: "Implement parseDuration",
      description: "Implement parseDuration in src/duration.js following README.md.",
      stage: "implementation", dependsOn: [], requiredCapabilities: ["stream"],
      acceptanceCriteria: [{ id: "AC-DURATION", description: "owner oracle exits 0", testProfileId: "acceptance" }],
    }],
  });
  const taskId = create.body?.data?.id;
  await log(`task=${taskId}`);

  let status = "";
  for (let i = 0; i < 300; i++) {
    await Bun.sleep(2000);
    status = (await taskOf(taskId)).task?.status ?? (await taskOf(taskId)).status;
    if (["waiting_approval", "failed", "succeeded"].includes(status)) break;
  }
  await log(`first terminal: ${status}`);
  if (status !== "waiting_approval") throw new Error(`S2 needs a passing first attempt, got ${status}`);

  const a1 = (await api("GET", `/api/v1/tasks/${taskId}/approvals`)).body?.data?.items?.find((x: any) => x.status === "pending");
  await log(`approval#1 id=${a1.id} digest=${a1.actionDigest.slice(0, 12)} refs=${a1.artifactRefs.length}`);
  const rej = await api("POST", `/api/v1/approvals/${a1.id}/decision`, {
    expectedVersion: a1.version, decision: "reject", actionDigest: a1.actionDigest, comment: "DS-02 S2: change requested",
  });
  await log(`reject -> ${rej.status} approval=${rej.body?.data?.status}`);
  const afterReject = (await taskOf(taskId)).task;
  await log(`task after reject: ${afterReject.status}`);

  const detail = await taskOf(taskId);
  const subs = Array.isArray(detail.subtasks) ? detail.subtasks : (detail.subtasks?.items ?? []);
  const review = subs.find((s: any) => s.code === "FINAL-REVIEW");
  if (!review) throw new Error(`no FINAL-REVIEW subtask: ${JSON.stringify(Object.keys(detail))}`);
  const rw = await api("POST", `/api/v1/subtasks/${review.id}/rework`, {
    expectedVersion: review.version, reason: "DS-02 S2: explicit rework after rejection", artifactRefs: [],
  });
  await log(`rework -> ${rw.status} target=${rw.body?.data?.subtaskId} state=${rw.body?.data?.status}`);

  status = "";
  for (let i = 0; i < 300; i++) {
    await Bun.sleep(2000);
    status = (await taskOf(taskId)).task?.status;
    if (["waiting_approval", "failed", "succeeded"].includes(status)) break;
  }
  await log(`second terminal: ${status}`);

  const approvals = (await api("GET", `/api/v1/tasks/${taskId}/approvals`)).body?.data?.items ?? [];
  const a2 = approvals.find((x: any) => x.status === "pending");
  await log(`approvals: ${approvals.map((a: any) => `${a.status}:${a.actionDigest.slice(0, 8)}:refs${a.artifactRefs.length}`).join(" | ")}`);
  if (a2) {
    const ap = await api("POST", `/api/v1/approvals/${a2.id}/decision`, {
      expectedVersion: a2.version, decision: "approve", actionDigest: a2.actionDigest, comment: "DS-02 S2: approved after rework",
    });
    await log(`approve -> ${ap.status}`);
  } else {
    await log("no pending approval after rework");
  }
  await Bun.sleep(2500);
  const final = await taskOf(taskId);
  const task = final.task ?? final;
  const runs = final.runs?.items ?? [];
  await log(`FINAL ${task.status} runs=${runs.length} sessions=${runs.map((r: any) => (r.providerSessionId || "").slice(0, 8)).join(",")}`);

  const head = (await Bun.$`git -C ${REPO} rev-parse HEAD`.text()).trim();
  const clean = !(await Bun.$`git -C ${REPO} status --porcelain`.text()).trim();
  Object.assign(out, {
    taskId, firstStatus: "waiting_approval", reject: rej.body?.data?.status,
    taskAfterReject: afterReject.status, rework: rw.body?.data,
    approvals: approvals.map((a: any) => ({ status: a.status, digest: a.actionDigest, refs: a.artifactRefs.length })),
    finalStatus: task.status, runs: runs.length,
    sessions: runs.map((r: any) => r.providerSessionId),
    repo: { headSame: head === BASE, clean },
  });
  await log(`repo unchanged=${head === BASE} clean=${clean}`);
} catch (error) {
  await log(`ERROR ${error}`);
  out.error = String(error);
} finally {
  await writeFile(path.join(EVIDENCE, "s2.json"), JSON.stringify(out, null, 2));
  try { process.kill(hub.pid!, "SIGINT"); } catch {}
  await Bun.sleep(1500);
  process.exit(0);
}
