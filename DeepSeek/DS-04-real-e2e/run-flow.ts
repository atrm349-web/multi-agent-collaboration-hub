// DS-04 real end-to-end flow: start the productized hub, run one real task with
// the configured DeepSeek models, approve it, verify artifacts, capture the UI.
// Everything is logged so the verdict can be checked afterwards.
import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const BACKEND = "/Users/anyunhong/Desktop/集合agent/backend/agetor";
const SHARED = "/Users/anyunhong/Desktop/集合agent";
const BUN = "/Users/anyunhong/Documents/Codex/2026-11-02/multi-agent-collaboration-hub-ai-agent/work/tooling/node_modules/@oven/bun-darwin-aarch64/bin/bun";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CONFIG = path.join(HERE, "config.json");
const REPO = path.join(HERE, "repo");
const EVIDENCE = path.join(HERE, "evidence");
const PORT = 4340;

await mkdir(EVIDENCE, { recursive: true });
const logPath = path.join(EVIDENCE, "flow.log");
await writeFile(logPath, "");
const log = async (msg: string) => {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  await appendFile(logPath, line + "\n");
};

const hub = spawn(BUN, [path.join(BACKEND, "scripts/start-hub.ts"), CONFIG], {
  cwd: SHARED,
  env: { ...process.env, PATH: `/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin:${process.env.PATH}` },
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
});
let hubOut = "";
hub.stdout.on("data", (b) => { hubOut += b.toString(); });
hub.stderr.on("data", (b) => { hubOut += b.toString(); });
await log(`hub pid=${hub.pid} starting`);

const stateDir = path.join(HERE, "runtime", "state");
let creds: { origin: string; token: string } | null = null;
for (let i = 0; i < 120; i++) {
  await Bun.sleep(500);
  if (hub.exitCode !== null) { await log(`hub exited early code=${hub.exitCode}\n${hubOut.slice(-2000)}`); break; }
  try {
    const raw = JSON.parse(await readFile(path.join(stateDir, "credentials.json"), "utf8"));
    creds = { origin: raw.origin, token: raw.token };
    break;
  } catch { /* not ready */ }
}
if (!creds) { await log("FATAL no credentials"); process.exit(1); }
await log(`hub ready ${creds.origin}`);

const headers = { authorization: `Bearer ${creds.token}` };
async function api(method: string, pathname: string, body?: unknown, key?: string) {
  const h: Record<string, string> = { ...headers };
  if (body !== undefined) { h["content-type"] = "application/json"; h["idempotency-key"] = key ?? crypto.randomUUID(); }
  const res = await fetch(creds!.origin + pathname, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data: any = text;
  try { data = JSON.parse(text); } catch { /* raw */ }
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(data).slice(0, 400)}`);
  return data?.data ?? data;
}

const result: Record<string, unknown> = { startedAt: new Date().toISOString(), steps: [] };
const step = async (name: string, fn: () => Promise<unknown>) => {
  const at = new Date().toISOString();
  try {
    const value = await fn();
    const summary = JSON.parse(JSON.stringify(value ?? null));
    (result.steps as any[]).push({ name, at, ok: true, summary });
    await log(`STEP ${name} OK ${JSON.stringify(summary).slice(0, 300)}`);
    return value;
  } catch (error) {
    (result.steps as any[]).push({ name, at, ok: false, error: String(error).slice(0, 800) });
    await log(`STEP ${name} FAIL ${error}`);
    throw error;
  }
};

let taskId = "";
try {
  const meta = await step("meta", () => api("GET", "/api/v1/meta"));
  await log(`meta=${JSON.stringify(meta)}`);

  const repoRef = await step("repositories", () => api("GET", "/api/v1/repositories"));
  await log(`repositories=${JSON.stringify(repoRef)}`);

  const goal = [
    "Implement parseDuration in src/duration.js of the duration-kit repository.",
    "Follow README.md exactly: units s/m/h/d, combined units, case-insensitive, unit required,",
    "invalid input throws RangeError containing INVALID_DURATION, return integer seconds.",
  ].join(" ");

  let plan: any = null;
  try {
    plan = await step("decompose(real planner)", () => api("POST", "/api/v1/tasks/decompose", {
      goal, repositoryId: "77777777-7777-4777-8777-777777777777",
    }, `ds04-decompose-${Date.now()}`));
    await log(`planner subtasks=${Array.isArray(plan?.subtasks) ? plan.subtasks.length : "n/a"}`);
  } catch (error) {
    await log(`planner unavailable, continuing with explicit plan: ${error}`);
  }

  const create = await step("create task", () => api("POST", "/api/v1/tasks", {
    title: "DS-04 real e2e: implement parseDuration",
    goal,
    repositoryId: "77777777-7777-4777-8777-777777777777",
    priority: "medium",
    acceptanceCriteria: [{ id: "AC-FINAL", description: "owner acceptance oracle still exits 0", testProfileId: "acceptance" }],
    plannedSubtasks: [{
      id: crypto.randomUUID(),
      code: "IMPL",
      title: "Implement parseDuration",
      description: "Implement parseDuration in src/duration.js following README.md, keeping module.exports shape.",
      stage: "implementation",
      dependsOn: [],
      requiredCapabilities: ["stream"],
      acceptanceCriteria: [{ id: "AC-DURATION", description: "owner acceptance oracle exits 0", testProfileId: "acceptance" }],
    }],
  }, `ds04-create-${Date.now()}`));
  taskId = create.id ?? create.task?.id;
  await log(`task=${taskId}`);

  const terminal = new Set(["waiting_approval", "succeeded", "failed", "cancelled", "timed_out"]);
  let seen = "";
  let lastStatus = "";
  const deadline = Date.now() + 25 * 60_000;
  while (Date.now() < deadline) {
    await Bun.sleep(2000);
    const detail = await api("GET", `/api/v1/tasks/${taskId}`);
    const task = detail.task ?? detail;
    const subtasks = detail.subtasks?.items ?? detail.subtasks ?? [];
    const runs = detail.runs?.items ?? detail.runs ?? [];
    const snap = {
      status: task.status, progress: task.progressPct,
      subtasks: subtasks.map((s: any) => `${s.code}:${s.status}#${s.attempt}`).join(","),
      runs: runs.map((r: any) => `${r.attempt}:${r.status}${r.exitCode === null ? "" : "/exit" + r.exitCode}`).join(","),
    };
    const key = JSON.stringify(snap);
    if (key !== seen) {
      seen = key;
      await log(`STATE ${JSON.stringify(snap)}`);
      (result.steps as any[]).push({ name: "state", at: new Date().toISOString(), ok: true, summary: snap });
    }
    lastStatus = task.status;
    if (terminal.has(task.status)) break;
  }

  if (lastStatus === "waiting_approval") {
    const approvals = await api("GET", `/api/v1/tasks/${taskId}/approvals`);
    const items = approvals.items ?? approvals;
    const pending = (Array.isArray(items) ? items : []).find((a: any) => a.status === "pending");
    if (!pending) throw new Error("no pending approval");
    await step("approve (authorized by the user's run request)", () => api("POST", `/api/v1/approvals/${pending.id}/decision`, {
      expectedVersion: pending.version, decision: "approve", actionDigest: pending.actionDigest,
      comment: "DS-04 real end-to-end run: approved by operator request",
    }, `ds04-approve-${Date.now()}`));
    for (let i = 0; i < 60; i++) {
      await Bun.sleep(1000);
      const t = await api("GET", `/api/v1/tasks/${taskId}`);
      const task = t.task ?? t;
      if (["succeeded", "failed"].includes(task.status)) { await log(`FINAL ${task.status}`); break; }
    }
  }

  const finalDetail = await api("GET", `/api/v1/tasks/${taskId}`);
  const finalTask = finalDetail.task ?? finalDetail;
  await log(`final status=${finalTask.status} artifacts=${finalTask.artifactCount}`);

  const artifacts = await api("GET", `/api/v1/tasks/${taskId}/artifacts`);
  const artifactItems = artifacts.items ?? [];
  const downloads: any[] = [];
  for (const artifact of artifactItems) {
    const res = await fetch(`${creds.origin}/api/v1/artifacts/${artifact.id}/content`, { headers });
    const bytes = Buffer.from(await res.arrayBuffer());
    const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    downloads.push({
      id: artifact.id, name: artifact.name, category: artifact.category,
      sizeBytes: bytes.length, declaredSha256: artifact.sha256, downloadedSha256: digest,
      match: digest === artifact.sha256, status: res.status,
    });
  }
  await log(`artifact downloads=${downloads.length} allMatch=${downloads.every((d) => d.match)}`);

  // Repository must be untouched: agents work in isolated copies.
  const head = (await Bun.$`git -C ${REPO} rev-parse HEAD`.text()).trim();
  const status = (await Bun.$`git -C ${REPO} status --porcelain`.text()).trim();
  await log(`repo head=${head} status=${status || "(clean)"}`);

  // Capture the live UI so "usable" is evaluated on the real screen, not the API.
  const shot = path.join(EVIDENCE, "ui-live.png");
  const chrome = spawn(CHROME, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--hide-scrollbars",
    `--user-data-dir=${path.join(HERE, "runtime", "chrome-profile")}`,
    "--window-size=1600,1000", "--virtual-time-budget=12000",
    `--screenshot=${shot}`, `${creds.origin}/`,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve) => chrome.once("close", resolve));
  await log(`screenshot=${shot}`);

  Object.assign(result, { taskId, finalStatus: finalTask.status, progress: finalTask.progressPct, downloads, repoHead: head, repoStatus: status, screenshot: shot });
} catch (error) {
  await log(`FLOW ERROR ${error}`);
  result.error = String(error);
} finally {
  await log(`hub output tail:\n${hubOut.slice(-1500)}`);
  try { process.kill(-hub.pid!, "SIGTERM"); } catch { try { hub.kill("SIGTERM"); } catch { /* gone */ } }
  await Bun.sleep(2500);
  result.endedAt = new Date().toISOString();
  await writeFile(path.join(EVIDENCE, "result.json"), JSON.stringify(result, null, 2));
  await log("done");
  process.exit(0);
}
