// DS-05 T2/T3 live: three sequential real tasks + SSE reconnect stress.
// No destructive actions: it only creates tasks in its own repo/runtime.
import { readFile, writeFile, mkdir, appendFile, cp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const BACKEND = "/Users/anyunhong/Desktop/集合agent/backend/agetor";
const SHARED = "/Users/anyunhong/Desktop/集合agent";
const BUN = "/Users/anyunhong/Documents/Codex/2026-11-02/multi-agent-collaboration-hub-ai-agent/work/tooling/node_modules/@oven/bun-darwin-aarch64/bin/bun";
const REPO = path.join(HERE, "repo");
const OWNER = path.join(HERE, "check.mjs");
const RUNTIME = path.join(HERE, "runtime");
const CONFIG = path.join(HERE, "config.json");
const EVIDENCE = path.join(HERE, "evidence");
const PORT = 4345;
const REPO_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TASKS = 3;

await mkdir(EVIDENCE, { recursive: true });
const logPath = path.join(EVIDENCE, "t2-t3.log");
await writeFile(logPath, "");
const log = async (m: string) => { const l = `${new Date().toISOString()} ${m}`; console.log(l); await appendFile(logPath, l + "\n"); };

await rm(RUNTIME, { recursive: true, force: true });
await rm(path.join(REPO, ".git"), { recursive: true, force: true });
await Bun.$`git init -q ${REPO}`;
await Bun.$`git -C ${REPO} add -A`;
await Bun.$`git -C ${REPO} -c user.name=owner -c user.email=owner@local commit -qm baseline`;
const BASE = (await Bun.$`git -C ${REPO} rev-parse HEAD`.text()).trim();
await log(`repo base=${BASE}`);

await writeFile(CONFIG, JSON.stringify({
  root: RUNTIME, port: PORT, maxConcurrency: 1,
  frontendDir: "/Users/anyunhong/Desktop/集合agent/apps/web/public",
  repositories: [{
    id: REPO_ID, label: "DS-05 T2/T3", path: REPO,
    defaultTestProfileId: "acceptance", model: "deepseek-chat",
    models: { planner: "deepseek-reasoner", developer: "deepseek-chat", reviewer: "deepseek-chat" },
    effort: "low",
    testProfiles: [{ id: "acceptance", command: ["/usr/local/bin/node", OWNER], timeoutMs: 20000, readPaths: [HERE] }],
  }],
}, null, 2));

const hub = spawn(BUN, [path.join(BACKEND, "scripts/start-hub.ts"), CONFIG], {
  cwd: SHARED, stdio: ["ignore", "pipe", "pipe"], detached: true,
  env: { ...process.env, PATH: `/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin:${process.env.PATH}` },
});
let hubOut = ""; hub.stdout.on("data", (b) => hubOut += b); hub.stderr.on("data", (b) => hubOut += b);

let creds: any = null;
for (let i = 0; i < 120; i++) {
  await Bun.sleep(500);
  try { creds = JSON.parse(await readFile(path.join(RUNTIME, "state", "credentials.json"), "utf8")); break; } catch {}
}
if (!creds) { await log("hub not ready: " + hubOut.slice(-500)); process.exit(1); }
await log(`hub pid=${hub.pid} ready ${creds.origin}`);

const headers = { authorization: `Bearer ${creds.token}` };
async function api(method: string, p: string, body?: unknown) {
  const h: Record<string, string> = { ...headers };
  if (body !== undefined) { h["content-type"] = "application/json"; h["idempotency-key"] = crypto.randomUUID(); }
  const r = await fetch(creds.origin + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
const footprint = async () => {
  const out = await Bun.$`footprint -p ${hub.pid!}`.text().catch(() => "");
  const m = out.match(/phys_footprint:\s*([\d.]+)\s*(\w+)/);
  return m ? `${m[1]} ${m[2]}` : "n/a";
};
const dbSize = async () => {
  try { const st = await Bun.file(path.join(RUNTIME, "state", "agetor.sqlite")).stat(); return st?.size ?? 0; } catch { return 0; }
};

const result: any = { base: BASE, tasks: [], sse: {} };
result.memoryIdle = await footprint();
result.dbIdle = await dbSize();
await log(`idle footprint=${result.memoryIdle} db=${result.dbIdle}`);

const createAndRun = async (n: number) => {
  const started = Date.now();
  const create = await api("POST", "/api/v1/tasks", {
    title: `DS-05 T2 task ${n}`,
    goal: "Implement parseDuration in src/duration.js following README.md rules 1-9.",
    repositoryId: REPO_ID, priority: "medium",
    acceptanceCriteria: [{ id: "AC-FINAL", description: "strict oracle exits 0", testProfileId: "acceptance" }],
    plannedSubtasks: [{
      id: crypto.randomUUID(), code: "IMPL", title: "Implement parseDuration",
      description: "Implement parseDuration in src/duration.js following README.md rules 1-9.",
      stage: "implementation", dependsOn: [], requiredCapabilities: ["stream"],
      acceptanceCriteria: [{ id: "AC-DURATION", description: "strict oracle exits 0", testProfileId: "acceptance" }],
    }],
  });
  const taskId = create.body?.data?.id ?? create.body?.id;
  const attempts = new Set<number>();
  let status = "";
  for (let i = 0; i < 300; i++) {
    await Bun.sleep(2000);
    const d = await api("GET", `/api/v1/tasks/${taskId}`);
    const t = d.body?.data?.task ?? d.body?.data;
    const runs = d.body?.data?.runs?.items ?? [];
    for (const r of runs) if (r.subtaskId) attempts.add(r.attempt);
    status = t.status;
    if (["waiting_approval", "failed", "succeeded", "cancelled"].includes(status)) break;
  }
  let approved = false;
  if (status === "waiting_approval") {
    const a = await api("GET", `/api/v1/tasks/${taskId}/approvals`);
    const pending = (a.body?.data?.items ?? []).find((x: any) => x.status === "pending");
    if (pending) {
      await api("POST", `/api/v1/approvals/${pending.id}/decision`, {
        expectedVersion: pending.version, decision: "approve", actionDigest: pending.actionDigest, comment: "DS-05 T2 stability run",
      });
      approved = true;
      for (let i = 0; i < 60; i++) {
        await Bun.sleep(1000);
        const d = await api("GET", `/api/v1/tasks/${taskId}`);
        status = (d.body?.data?.task ?? d.body?.data).status;
        if (["succeeded", "failed"].includes(status)) break;
      }
    }
  }
  const entry = { n, taskId, status, approved, seconds: Math.round((Date.now() - started) / 1000), maxAttempt: Math.max(...attempts, 0), footprint: await footprint(), dbBytes: await dbSize() };
  result.tasks.push(entry);
  await log(`task${n}: status=${status} approved=${approved} seconds=${entry.seconds} maxAttempt=${entry.maxAttempt} footprint=${entry.footprint} db=${entry.dbBytes}`);
};

for (let n = 1; n <= TASKS; n++) await createAndRun(n);

// T3: expired cursor must be rejected, valid reconnects must succeed 10x.
const snap = await api("GET", "/api/v1/snapshot");
const seq = snap.body?.data?.snapshotSeq ?? 0;
const expired = await fetch(`${creds.origin}/api/v1/events`, { headers: { ...headers, "last-event-id": String(seq + 1000) } });
result.sse.expiredStatus = expired.status;
await log(`SSE expired cursor -> ${expired.status} (expect 409)`);

let ok = 0; const latencies: number[] = [];
for (let i = 0; i < 10; i++) {
  const t0 = Date.now();
  const ac = new AbortController();
  const res = await fetch(`${creds.origin}/api/v1/events`, { headers: { ...headers, "last-event-id": String(seq) }, signal: ac.signal });
  if (res.status !== 200) { await log(`reconnect ${i} status=${res.status}`); continue; }
  const reader = res.body!.getReader();
  const { value } = await Promise.race([
    reader.read(),
    Bun.sleep(1500).then(() => ({ value: new Uint8Array() })),
  ]);
  ac.abort();
  if (value && Buffer.from(value).toString().includes("connected")) { ok++; latencies.push(Date.now() - t0); }
}
result.sse.reconnects = { ok, of: 10, latencyMs: latencies };
await log(`SSE reconnects ok=${ok}/10 latency=${latencies.join(",")}ms`);

result.memoryEnd = await footprint();
result.dbEnd = await dbSize();
result.repo = { headSame: (await Bun.$`git -C ${REPO} rev-parse HEAD`.text()).trim() === BASE, clean: !(await Bun.$`git -C ${REPO} status --porcelain`.text()).trim() };
await log(`end footprint=${result.memoryEnd} db=${result.dbEnd} repo=${JSON.stringify(result.repo)}`);

await writeFile(path.join(EVIDENCE, "t2-t3.json"), JSON.stringify(result, null, 2));
try { process.kill(hub.pid!, "SIGINT"); } catch {}
await Bun.sleep(2000);
process.exit(0);
