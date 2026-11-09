// DS-02 S1-real: real-model failure → automatic rework → review → approval.
// Same productized entry as DS-04 (start-hub + DeepSeek models + seatbelt tests),
// but the acceptance oracle is deliberately strict, so a first-attempt miss is a
// genuine "the model did not meet the stated standard" event.
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
const PORT = 4341;
const REPO_ID = "88888888-8888-4888-8888-888888888888";

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
  if (hub.exitCode !== null) { await log(`hub exited early code=${hub.exitCode}\n${hubOut.slice(-1500)}`); break; }
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

const result: Record<string, unknown> = { startedAt: new Date().toISOString(), states: [] };
let taskId = "";
try {
  const meta = await api("GET", "/api/v1/meta");
  await log(`meta executionMode=${meta.executionMode} features=${meta.enabledFeatures.join(",")}`);

  const goal = [
    "Implement parseDuration in src/duration.js of the duration-kit repository.",
    "Follow README.md rules 1-9 exactly: units s/m/h/d/w, combined segments, case-insensitive,",
    "single space allowed BETWEEN segments but never inside one, no bare numbers, no decimals,",
    "RangeError with INVALID_DURATION for every invalid input including safe-integer overflow.",
  ].join(" ");

  const create = await api("POST", "/api/v1/tasks", {
    title: "DS-02 S1-real: strict parseDuration (failure/rework attempt)",
    goal,
    repositoryId: REPO_ID,
    priority: "medium",
    acceptanceCriteria: [{ id: "AC-FINAL", description: "strict owner oracle still exits 0", testProfileId: "acceptance" }],
    plannedSubtasks: [{
      id: crypto.randomUUID(),
      code: "IMPL",
      title: "Implement parseDuration",
      description: "Implement parseDuration in src/duration.js following README.md rules 1-9.",
      stage: "implementation",
      dependsOn: [],
      requiredCapabilities: ["stream"],
      acceptanceCriteria: [{ id: "AC-DURATION", description: "strict owner oracle exits 0 (13 checks)", testProfileId: "acceptance" }],
    }],
  }, `ds02-real-${Date.now()}`);
  taskId = create.id;
  await log(`task=${taskId}`);

  const terminal = new Set(["waiting_approval", "succeeded", "failed", "cancelled", "timed_out"]);
  let seen = "";
  let lastStatus = "";
  const deadline = Date.now() + 30 * 60_000;
  while (Date.now() < deadline) {
    await Bun.sleep(2000);
    const detail = await api("GET", `/api/v1/tasks/${taskId}`);
    const task = detail.task ?? detail;
    const subtasks = detail.subtasks?.items ?? detail.subtasks ?? [];
    const runs = detail.runs?.items ?? detail.runs ?? [];
    const snap = {
      status: task.status,
      subtasks: subtasks.map((s: any) => `${s.code}:${s.status}#${s.attempt}`).join(","),
      runs: runs.map((r: any) => `att${r.attempt}:${r.status}${r.exitCode === null ? "" : "/exit" + r.exitCode}`).join(","),
    };
    const key = JSON.stringify(snap);
    if (key !== seen) { seen = key; await log(`STATE ${key}`); (result.states as any[]).push({ at: new Date().toISOString(), ...snap }); }
    lastStatus = task.status;
    if (terminal.has(task.status)) break;
  }

  // Capture the failure evidence BEFORE approving, so rework reasons are recorded.
  const validations = await api("GET", `/api/v1/tasks/${taskId}/validations`);
  const messages = await api("GET", `/api/v1/tasks/${taskId}/messages`);
  const reworkMsgs = (messages.items ?? []).filter((m: any) => m.kind === "rework_instruction");
  await log(`validations=${(validations.items ?? []).length} reworkMessages=${reworkMsgs.length}`);
  for (const v of validations.items ?? []) await log(`  validation ${v.criterionId} ${v.status} exit=${v.exitCode}`);
  for (const m of reworkMsgs) await log(`  rework reason: ${String(m.content).slice(0, 700)}`);

  if (lastStatus === "waiting_approval") {
    const approvals = await api("GET", `/api/v1/tasks/${taskId}/approvals`);
    const pending = (approvals.items ?? []).find((a: any) => a.status === "pending");
    if (!pending) throw new Error("no pending approval");
    await api("POST", `/api/v1/approvals/${pending.id}/decision`, {
      expectedVersion: pending.version, decision: "approve", actionDigest: pending.actionDigest,
      comment: "DS-02 S1-real: approved by operator request",
    }, `ds02-approve-${Date.now()}`);
    for (let i = 0; i < 90; i++) {
      await Bun.sleep(1000);
      const t = await api("GET", `/api/v1/tasks/${taskId}`);
      const task = t.task ?? t;
      if (["succeeded", "failed"].includes(task.status)) break;
    }
  }

  const finalDetail = await api("GET", `/api/v1/tasks/${taskId}`);
  const finalTask = finalDetail.task ?? finalDetail;
  await log(`FINAL ${finalTask.status}`);

  const artifacts = await api("GET", `/api/v1/tasks/${taskId}/artifacts`);
  const downloads: any[] = [];
  for (const a of artifacts.items ?? []) {
    const res = await fetch(`${creds.origin}/api/v1/artifacts/${a.id}/content`, { headers });
    const bytes = Buffer.from(await res.arrayBuffer());
    const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    downloads.push({ name: a.name, category: a.category, size: bytes.length, match: digest === a.sha256 });
  }
  await log(`artifacts=${downloads.length} allMatch=${downloads.every((d) => d.match)}`);

  const head = (await Bun.$`git -C ${REPO} rev-parse HEAD`.text()).trim();
  const status = (await Bun.$`git -C ${REPO} status --porcelain`.text()).trim();
  await log(`repo head=${head} status=${status || "(clean)"}`);

  // Live-mode screenshot on the CURRENT frontend snapshot (frozen at startup).
  const shot = path.join(EVIDENCE, "ui-live-mode.png");
  const chrome = spawn(CHROME, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--hide-scrollbars",
    `--user-data-dir=${path.join(HERE, "runtime", "chrome-profile")}`,
    "--window-size=1600,1000", "--virtual-time-budget=12000",
    `--screenshot=${shot}`, `${creds.origin}/`,
  ], { stdio: "ignore" });
  await new Promise((resolve) => chrome.once("close", resolve));

  Object.assign(result, {
    taskId, finalStatus: finalTask.status, reworkMessages: reworkMsgs.map((m: any) => String(m.content).slice(0, 1500)),
    downloads, repoHead: head, repoStatus: status, screenshot: shot,
    validations: (validations.items ?? []).map((v: any) => ({ criterion: v.criterionId, status: v.status, exitCode: v.exitCode })),
  });
} catch (error) {
  await log(`FLOW ERROR ${error}`);
  result.error = String(error);
} finally {
  await log(`hub output tail:\n${hubOut.slice(-800)}`);
  try { process.kill(-hub.pid!, "SIGTERM"); } catch { try { hub.kill("SIGTERM"); } catch { /* gone */ } }
  await Bun.sleep(2000);
  result.endedAt = new Date().toISOString();
  await writeFile(path.join(EVIDENCE, "result.json"), JSON.stringify(result, null, 2));
  await log("done");
  process.exit(0);
}
