// DS-02 S1 driver. Talks to the locally started hub over loopback HTTP only.
//
//   bun drive-s1.ts meta                       # read-only sanity check
//   DS02_CONFIRM_REAL_RUN=1 bun drive-s1.ts create
//   bun drive-s1.ts watch <taskId>             # poll + append evidence
//   bun drive-s1.ts export <taskId>            # read-only SQLite dump
//   DS02_CONFIRM_REAL_RUN=1 bun drive-s1.ts decide <approvalId> <version> <digest> approve|reject
//
// The token is read from runtime/state/credentials.json and never printed.
import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const EVIDENCE = process.env.DS02_EVIDENCE ?? path.join(HERE, "evidence");
const RUNTIME = process.env.DS02_RUNTIME ?? path.join(HERE, "runtime");
const IMPL_ID = "55555555-5555-4555-8555-555555555555";
const REPOSITORY_ID = process.env.DS02_REPOSITORY_ID ?? "44444444-4444-4444-8444-444444444444";
const PROFILE_ID = process.env.DS02_PROFILE_ID ?? "acceptance";
const TASK_TITLE = process.env.DS02_TITLE ?? "DS-02 S1: amount formatter with strict owner acceptance";

async function creds(): Promise<{ origin: string; token: string }> {
  const raw = JSON.parse(await readFile(path.join(RUNTIME, "state", "credentials.json"), "utf8"));
  if (typeof raw.origin !== "string" || typeof raw.token !== "string") throw new Error("credentials shape");
  return { origin: raw.origin, token: raw.token };
}

const { origin, token } = await creds();
const auth = { authorization: `Bearer ${token}` };

async function api(method: string, pathname: string, body?: unknown, key?: string) {
  const headers: Record<string, string> = { ...auth };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    headers["idempotency-key"] = key ?? crypto.randomUUID();
  }
  const response = await fetch(origin + pathname, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let data: unknown = text;
  try { data = JSON.parse(text); } catch { /* keep raw text */ }
  if (!response.ok) {
    const error = (data as { error?: { code?: string; message?: string } })?.error;
    throw new Error(`${response.status} ${error?.code ?? "ERROR"}: ${error?.message ?? text.slice(0, 300)}`);
  }
  return data as any;
}

const [command, ...rest] = process.argv.slice(2);
await mkdir(EVIDENCE, { recursive: true });

function requireConfirm() {
  if (process.env.DS02_CONFIRM_REAL_RUN !== "1") {
    throw new Error("REFUSED: set DS02_CONFIRM_REAL_RUN=1 to spend real subscription quota");
  }
}

function plannedSubtasks() {
  return [{
    id: IMPL_ID,
    code: "IMPL",
    title: "Implement formatAmount",
    description: "Implement src/amount.mjs exporting formatAmount(minorUnits) that returns a human-readable RMB string with two decimals.",
    stage: "implementation",
    dependsOn: [],
    requiredCapabilities: ["stream"],
    acceptanceCriteria: [{ id: "AC-AMOUNT", description: "owner acceptance test exits 0", testProfileId: PROFILE_ID }],
  }];
}

const taskCriteria = [{ id: "AC-FINAL", description: "Final delivery still passes the owner acceptance test", testProfileId: PROFILE_ID }];

if (command === "meta") {
  console.log(JSON.stringify(await api("GET", "/api/v1/meta"), null, 2));
} else if (command === "create") {
  requireConfirm();
  const body = {
    title: TASK_TITLE,
    goal: [
      "Implement src/amount.mjs exporting formatAmount(minorUnits) that converts an integer amount of fen into a human-readable RMB string.",
      "Keep the project runnable. Do not edit anything outside the current code directory.",
    ].join("\n"),
    repositoryId: REPOSITORY_ID,
    priority: "medium",
    acceptanceCriteria: taskCriteria,
    plannedSubtasks: plannedSubtasks(),
  };
  const key = `ds02-s1-${Date.now()}`;
  const task = await api("POST", "/api/v1/tasks", body, key);
  await writeFile(path.join(EVIDENCE, `create-${task.id}.json`), JSON.stringify({ request: body, idempotencyKey: key, response: task }, null, 2));
  console.log(task.id);
} else if (command === "watch") {
  const taskId = rest[0];
  if (!taskId) throw new Error("usage: watch <taskId>");
  const deadline = Date.now() + Number(process.env.DS02_WATCH_MS ?? 45 * 60_000);
  const seen = new Set<string>();
  let lastRuns = 0;
  const log = path.join(EVIDENCE, `watch-${taskId}.jsonl`);
  while (Date.now() < deadline) {
    const detail = await api("GET", `/api/v1/tasks/${taskId}`);
    const task = detail.data?.task ?? detail.task;
    const runs = detail.data?.runs?.items ?? detail.runs?.items ?? [];
    const line = {
      at: new Date().toISOString(),
      task: { status: task.status, version: task.version, progressPct: task.progressPct, error: task.error, pendingApprovalCount: task.pendingApprovalCount },
      subtasks: (detail.data?.subtasks ?? detail.subtasks ?? []).map((s: any) => ({ code: s.code, status: s.status, attempt: s.attempt, maxAttempts: s.maxAttempts, error: s.error })),
      runs: runs.map((r: any) => ({ id: r.id, subtaskId: r.subtaskId, attempt: r.attempt, status: r.status, exitCode: r.exitCode, providerSessionId: r.providerSessionId })),
    };
    const fingerprint = JSON.stringify(line);
    if (!seen.has(fingerprint)) {
      seen.add(fingerprint);
      await appendFile(log, fingerprint + "\n");
      console.log(`${line.at} task=${line.task.status} subtasks=${line.subtasks.map((s: any) => `${s.code}:${s.status}#${s.attempt}`).join(",")} runs=${runs.length}`);
    }
    if (["succeeded", "failed", "cancelled", "timed_out"].includes(task.status)) break;
    if (task.status === "waiting_approval") {
      const approvals = await api("GET", `/api/v1/tasks/${taskId}/approvals`);
      const pending = (approvals.items ?? []).filter((a: any) => a.status === "pending");
      if (pending.length) {
        await writeFile(path.join(EVIDENCE, `approval-${taskId}.json`), JSON.stringify(pending, null, 2));
        console.log(`waiting_approval; pending approval ${pending[0].id} version=${pending[0].version} digest=${pending[0].actionDigest}`);
        break;
      }
    }
    await Bun.sleep(2000);
    if (runs.length !== lastRuns) lastRuns = runs.length;
  }
} else if (command === "decide") {
  requireConfirm();
  const [approvalId, version, digest, decision] = rest;
  if (!approvalId || !version || !digest || !["approve", "reject"].includes(decision ?? "")) {
    throw new Error("usage: decide <approvalId> <version> <digest> approve|reject");
  }
  const result = await api("POST", `/api/v1/approvals/${approvalId}/decision`, {
    expectedVersion: Number(version), decision, actionDigest: digest, comment: "DS-02 S1 authorized decision",
  });
  await appendFile(path.join(EVIDENCE, "decisions.jsonl"), JSON.stringify({ at: new Date().toISOString(), approvalId, version, decision, result }) + "\n");
  console.log(JSON.stringify(result, null, 2));
} else if (command === "export") {
  const taskId = rest[0];
  if (!taskId) throw new Error("usage: export <taskId>");
  const { Database } = await import("bun:sqlite");
  const db = new Database(path.join(RUNTIME, "state", "agetor.sqlite"), { readonly: true });
  try {
    const dump = {
      exportedAt: new Date().toISOString(),
      task: db.query("SELECT data FROM hub_entities WHERE kind='task' AND id=?").get(taskId),
      subtasks: db.query("SELECT data FROM hub_entities WHERE kind='subtask' AND task_id=? ORDER BY created_at,id").all(taskId),
      runs: db.query("SELECT data FROM hub_entities WHERE kind='run' AND task_id=? ORDER BY created_at,id").all(taskId),
      validations: db.query("SELECT data FROM hub_entities WHERE kind='validation' AND task_id=? ORDER BY created_at,id").all(taskId),
      approvals: db.query("SELECT data FROM hub_entities WHERE kind='approval' AND task_id=? ORDER BY created_at,id").all(taskId),
      artifacts: db.query("SELECT data FROM hub_entities WHERE kind='artifact' AND task_id=? ORDER BY created_at,id").all(taskId),
      messages: db.query("SELECT data FROM hub_entities WHERE kind='message' AND task_id=? ORDER BY created_at,id").all(taskId),
      workspaces: db.query("SELECT * FROM hub_workspaces").all(),
      events: db.query("SELECT * FROM hub_outbox ORDER BY seq").all(),
      logs: db.query("SELECT run_id, log_seq, data FROM hub_logs ORDER BY run_id, log_seq").all(),
    };
    const parsed = Object.fromEntries(Object.entries(dump).map(([k, v]) => [k, Array.isArray(v) ? v.map((row: any) => (row && typeof row.data === "string" ? { ...row, data: JSON.parse(row.data) } : row)) : v]));
    await writeFile(path.join(EVIDENCE, `database-${taskId}.json`), JSON.stringify(parsed, null, 2));
    console.log(`wrote evidence/database-${taskId}.json`);
  } finally {
    db.close();
  }
} else {
  console.log("usage: meta | create | watch <taskId> | decide <approvalId> <version> <digest> approve|reject | export <taskId>");
  process.exit(2);
}
