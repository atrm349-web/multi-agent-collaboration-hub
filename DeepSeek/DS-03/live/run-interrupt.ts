// DS-03 live interruption scenarios.
//   bun run-interrupt.ts A   # SIGINT during the registered test window
//   bun run-interrupt.ts B   # SIGKILL the controller during the test window, then recover
//   bun run-interrupt.ts C   # SIGKILL the model process group mid-run
// Fault injection only ever targets processes started by this script.
import { readFile, writeFile, mkdir, appendFile, cp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const SCENARIO = (process.argv[2] ?? "A").toUpperCase();
if (!["A", "B", "C"].includes(SCENARIO)) throw new Error("usage: run-interrupt.ts A|B|C");

const HERE = path.dirname(new URL(import.meta.url).pathname);
const BACKEND = process.env.DS03_BACKEND ?? "/Users/anyunhong/Desktop/集合agent/backend/agetor";
const SHARED = "/Users/anyunhong/Desktop/集合agent";
const BUN = "/Users/anyunhong/Documents/Codex/2026-11-02/multi-agent-collaboration-hub-ai-agent/work/tooling/node_modules/@oven/bun-darwin-aarch64/bin/bun";
const SEED = path.join(HERE, "seed");
const OWNER_TESTS = path.join(HERE, "owner-tests");
const PORT = { A: 4342, B: 4343, C: 4344 }[SCENARIO]!;
const DIR = path.join(HERE, SCENARIO);
const EVIDENCE = path.join(HERE, "evidence");
const REPO = path.join(DIR, "repo");
const RUNTIME = path.join(DIR, "runtime");
const CONFIG = path.join(DIR, "config.json");
const REPO_ID = "99999999-9999-4999-8999-999999999999";

await mkdir(EVIDENCE, { recursive: true });
await mkdir(DIR, { recursive: true });
const logPath = path.join(EVIDENCE, `${SCENARIO}.log`);
await writeFile(logPath, "");
const log = async (m: string) => { const l = `${new Date().toISOString()} [${SCENARIO}] ${m}`; console.log(l); await appendFile(logPath, l + "\n"); };

// ---- fresh repo -----------------------------------------------------------------
await rm(REPO, { recursive: true, force: true });
await cp(SEED, REPO, { recursive: true });
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
    id: REPO_ID, label: `DS-03 ${SCENARIO}`, path: REPO,
    defaultTestProfileId: "slow",
    model: SCENARIO === "C" ? "gpt-6.1-sol" : "deepseek-chat",
    models: SCENARIO === "C"
      ? { planner: "gpt-6.1-sol", developer: "gpt-6.1-sol", reviewer: "gpt-6.1-sol" }
      : { planner: "deepseek-reasoner", developer: "deepseek-chat", reviewer: "deepseek-chat" },
    effort: "low",
    testProfiles: [{
      id: "slow",
      command: ["/usr/local/bin/node", path.join(OWNER_TESTS, "slow.mjs")],
      timeoutMs: 180000,
      readPaths: [OWNER_TESTS],
    }],
  }],
}, null, 2));

// ---- helpers --------------------------------------------------------------------
type Hub = { pid: number; origin: string; token: string };
async function startHub(): Promise<Hub> {
  const proc = spawn(BUN, [path.join(BACKEND, "scripts/start-hub.ts"), CONFIG], {
    cwd: SHARED,
    env: { ...process.env, PATH: `/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin:${process.env.PATH}`, DS03_SLOW_SECONDS: "45" },
    stdio: ["ignore", "pipe", "pipe"], detached: true,
  });
  let out = "";
  proc.stdout.on("data", (b) => { out += b.toString(); });
  proc.stderr.on("data", (b) => { out += b.toString(); });
  for (let i = 0; i < 120; i++) {
    await Bun.sleep(500);
    if (proc.exitCode !== null) throw new Error(`hub exited early: ${out.slice(-800)}`);
    try {
      const c = JSON.parse(await readFile(path.join(RUNTIME, "state", "credentials.json"), "utf8"));
      return { pid: proc.pid!, origin: c.origin, token: c.token };
    } catch { /* not ready */ }
  }
  throw new Error("hub never became ready");
}
function api(hub: Hub, method: string, p: string, body?: unknown) {
  const headers: Record<string, string> = { authorization: `Bearer ${hub.token}` };
  if (body !== undefined) { headers["content-type"] = "application/json"; headers["idempotency-key"] = crypto.randomUUID(); }
  return fetch(hub.origin + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
}
async function dbRows(sql: string) {
  const { Database } = await import("bun:sqlite");
  const db = new Database(path.join(RUNTIME, "state", "agetor.sqlite"), { readonly: true });
  try { return db.query(sql).all(); } finally { db.close(); }
}
async function waitFor(label: string, fn: () => Promise<boolean>, ms = 180000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await Bun.sleep(500);
  }
  await log(`TIMEOUT waiting for ${label}`);
  return false;
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function stopHub(hub: Hub, signal: NodeJS.Signals) {
  try { process.kill(hub.pid, signal); } catch { /* gone */ }
  await waitFor(`${signal} exit`, async () => !alive(hub.pid), 15000);
}

const result: Record<string, unknown> = { scenario: SCENARIO, startedAt: new Date().toISOString(), base: BASE };

try {
  let hub = await startHub();
  await log(`hub pid=${hub.pid} ready ${hub.origin}`);

  const create = await api(hub, "POST", "/api/v1/tasks", {
    title: `DS-03 ${SCENARIO} interruption probe`,
    goal: "Implement parseDuration in src/duration.js following README.md rules 1-9.",
    repositoryId: REPO_ID, priority: "medium",
    acceptanceCriteria: [{ id: "AC-FINAL", description: "strict oracle exits 0", testProfileId: "slow" }],
    plannedSubtasks: [{
      id: crypto.randomUUID(), code: "IMPL", title: "Implement parseDuration",
      description: "Implement parseDuration in src/duration.js following README.md rules 1-9.",
      stage: "implementation", dependsOn: [], requiredCapabilities: ["stream"],
      acceptanceCriteria: [{ id: "AC-DURATION", description: "strict oracle exits 0", testProfileId: "slow" }],
    }],
  });
  const taskId = create.body?.data?.id ?? create.body?.id;
  await log(`task=${taskId} status=${create.status}`);

  // A/B enter the registered-test window; C must be caught while the model turn
  // is still running, so it waits for a live provider session instead.
  let pgid: number | null = null;
  if (SCENARIO === "C") {
    const live = await waitFor("running model session", async () => {
      const rows = await dbRows(`SELECT json_extract(data,'$.status') st, json_extract(data,'$.providerSessionId') s FROM hub_entities WHERE kind='run'`);
      return rows.some((r: any) => r.st === "running" && !!r.s);
    }, 180000);
    const claims = await dbRows("SELECT process_group_id FROM hub_run_claims");
    pgid = claims.at(-1)?.process_group_id ?? null;
    await log(`modelTurnLive=${live} claimPgid=${pgid} claims=${claims.length}`);
    if (!live) throw new Error("model turn never became observable; scenario C would kill nothing");
  } else {
    const inTest = await waitFor("validating", async () => {
      const rows = await dbRows(`SELECT json_extract(data,'$.status') s FROM hub_entities WHERE kind='subtask' AND json_extract(data,'$.code')='IMPL'`);
      return rows.some((r: any) => r.s === "validating");
    });
    const claims = await dbRows("SELECT run_id, owner_id, process_group_id, lease_until_ms FROM hub_run_claims");
    pgid = claims.at(-1)?.process_group_id ?? null;
    await log(`inTestWindow=${inTest} claimPgid=${pgid} claims=${claims.length}`);
  }

  if (SCENARIO === "A") {
    await stopHub(hub, "SIGINT");
    await Bun.sleep(1500);
    const task = await dbRows(`SELECT json_extract(data,'$.status') s FROM hub_entities WHERE kind='task'`);
    const subs = await dbRows(`SELECT json_extract(data,'$.code') c, json_extract(data,'$.status') s FROM hub_entities WHERE kind='subtask'`);
    const slot = await dbRows("SELECT * FROM hub_execution_slot");
    const childAlive = pgid ? alive(pgid) : false;
    const head = (await Bun.$`git -C ${REPO} rev-parse HEAD`.text()).trim();
    const dirty = (await Bun.$`git -C ${REPO} status --porcelain`.text()).trim();
    await log(`A after stop: task=${JSON.stringify(task)} subs=${JSON.stringify(subs)} slot=${slot.length} childAlive=${childAlive} repoClean=${!dirty} headSame=${head === BASE}`);
    result.after = { task, subs, slotRows: slot.length, childAlive, headSame: head === BASE, repoClean: !dirty };

    const hub2 = await startHub();
    const meta = await api(hub2, "GET", "/api/v1/meta");
    const interrupted = await dbRows(`SELECT count(*) n FROM hub_entities WHERE kind='run' AND json_extract(data,'$.status')='interrupted'`);
    await log(`A restart: live=${meta.body?.data?.liveExecutionAvailable} interruptedRuns=${interrupted[0]?.n}`);
    result.restart = { live: meta.body?.data?.liveExecutionAvailable, interruptedRuns: interrupted[0]?.n };
    await stopHub(hub2, "SIGINT");
  }

  if (SCENARIO === "B") {
    process.kill(hub.pid, "SIGKILL");
    await waitFor("controller dead", async () => !alive(hub.pid), 10000);
    const childStillAlive = pgid ? alive(pgid) : false;
    const orphans = (await Bun.$`pgrep -f ${path.join(OWNER_TESTS, "slow.mjs")}`.text().catch(() => "")).trim().split("\n").filter(Boolean);
    await log(`B controller killed; claimPgid alive=${childStillAlive}; orphaned test pids=${JSON.stringify(orphans)}`);

    const hub2 = await startHub();
    await log(`B restarted pid=${hub2.pid}`);
    await Bun.sleep(13000); // lease is 10s
    const runs = await dbRows(`SELECT json_extract(data,'$.status') s FROM hub_entities WHERE kind='run'`);
    const subs = await dbRows(`SELECT json_extract(data,'$.code') c, json_extract(data,'$.status') s FROM hub_entities WHERE kind='subtask'`);
    const slotAfter = await dbRows("SELECT * FROM hub_execution_slot");
    const metaAfter = await api(hub2, "GET", "/api/v1/meta");
    const runRow = await dbRows(`SELECT json_extract(data,'$.version') v, id FROM hub_entities WHERE kind='run' AND json_extract(data,'$.status')='interrupted' LIMIT 1`);
    const taskAfter = await dbRows(`SELECT json_extract(data,'$.status') s, json_extract(data,'$.error.code') e FROM hub_entities WHERE kind='task'`);
    await log(`B after reconcile: task=${JSON.stringify(taskAfter)} runs=${JSON.stringify(runs)} subs=${JSON.stringify(subs)} slot=${slotAfter.length} live=${metaAfter.body?.data?.liveExecutionAvailable}`);
    result.reconcile = { task: taskAfter, runs, subs, slotRows: slotAfter.length, live: metaAfter.body?.data?.liveExecutionAvailable, childStillAlive, orphansBeforeRecovery: orphans };

    if (runRow[0]) {
      const ack1 = await api(hub2, "POST", `/api/v1/runs/${runRow[0].id}/acknowledge`, {
        expectedVersion: runRow[0].v, processGroupVerifiedStopped: true, reason: "DS-03 B: child group still running, must be rejected",
      });
      await log(`B ack while child alive: ${ack1.status} ${JSON.stringify(ack1.body).slice(0, 200)}`);
      if (pgid && alive(pgid)) { try { process.kill(-pgid, "SIGKILL"); } catch { /* gone */ } }
      await Bun.sleep(1500);
      const ack2 = await api(hub2, "POST", `/api/v1/runs/${runRow[0].id}/acknowledge`, {
        expectedVersion: runRow[0].v, processGroupVerifiedStopped: true, reason: "DS-03 B: child group verified stopped, reviewed workspace",
      });
      const slotFinal = await dbRows("SELECT * FROM hub_execution_slot");
      const metaFinal = await api(hub2, "GET", "/api/v1/meta");
      await log(`B ack after kill: ${ack2.status} ${JSON.stringify(ack2.body).slice(0, 200)} slot=${slotFinal.length} live=${metaFinal.body?.data?.liveExecutionAvailable}`);
      result.ack = { whileAlive: ack1.status, afterKill: ack2.status, slotRows: slotFinal.length, live: metaFinal.body?.data?.liveExecutionAvailable };
    }
    await stopHub(hub2, "SIGINT");
  }

  if (SCENARIO === "C") {
    const before = await dbRows(`SELECT json_extract(data,'$.status') s, json_extract(data,'$.version') v FROM hub_entities WHERE kind='run'`);
    if (pgid && alive(pgid)) { try { process.kill(-pgid, "SIGKILL"); } catch { /* gone */ } }
    await log(`C killed model group pgid=${pgid} beforeRuns=${JSON.stringify(before)}`);
    await Bun.sleep(6000);
    const runsAfter = await dbRows(`SELECT json_extract(data,'$.status') s, json_extract(data,'$.attempt') a, json_extract(data,'$.error.code') e FROM hub_entities WHERE kind='run'`);
    const subsAfter = await dbRows(`SELECT json_extract(data,'$.code') c, json_extract(data,'$.status') s, json_extract(data,'$.attempt') a FROM hub_entities WHERE kind='subtask'`);
    const taskAfter = await dbRows(`SELECT json_extract(data,'$.status') s, json_extract(data,'$.error.code') e FROM hub_entities WHERE kind='task'`);
    const slotAfter = await dbRows("SELECT * FROM hub_execution_slot");
    await log(`C after kill: runs=${JSON.stringify(runsAfter)} subs=${JSON.stringify(subsAfter)} task=${JSON.stringify(taskAfter)} slot=${slotAfter.length}`);
    result.afterKill = { before, runs: runsAfter, subs: subsAfter, task: taskAfter, slotRows: slotAfter.length };
    await stopHub(hub, "SIGINT");
  }

  const head = (await Bun.$`git -C ${REPO} rev-parse HEAD`.text()).trim();
  const dirty = (await Bun.$`git -C ${REPO} status --porcelain`.text()).trim();
  result.repo = { headSame: head === BASE, clean: !dirty };
  await log(`repo unchanged=${head === BASE} clean=${!dirty}`);
} catch (error) {
  await log(`ERROR ${error}`);
  result.error = String(error);
} finally {
  await writeFile(path.join(EVIDENCE, `${SCENARIO}.json`), JSON.stringify(result, null, 2));
  await log("done");
  process.exit(0);
}
