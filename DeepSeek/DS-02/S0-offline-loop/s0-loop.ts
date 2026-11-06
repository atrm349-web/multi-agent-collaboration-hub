// DS-02 S0: OFFLINE self-tests of the rework / rejection / retry-budget paths.
//
//   bun s0-loop.ts s1   # fail -> auto rework -> pass -> review -> approve -> succeeded
//   bun s0-loop.ts s2   # pass -> review -> REJECT -> explicit rework -> approve -> succeeded
//   bun s0-loop.ts s3   # always-fail -> 2 attempts -> task failed, no approval
//
// REAL: HubService, SQLite store, Git worktrees, quality gate, approval digest.
// CONTROLLED: provider (local simulator), planner (bypassed with plannedSubtasks),
//             testRunner (direct node instead of the seatbelt sandbox).
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const SCENARIO = (process.argv[2] ?? "s1").toLowerCase();
if (!["s1", "s2", "s3"].includes(SCENARIO)) throw new Error("usage: s0-loop.ts s1|s2|s3");
// S2 exercises the reject path, so its first attempt must already satisfy the oracle.
process.env.DS0_FIRST_ATTEMPT_CORRECT = SCENARIO === "s2" ? "1" : "0";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const BACKEND = ".//backend/agetor";
const ROOT = path.join(HERE, `runtime-${SCENARIO}`);
const REPO = path.join(HERE, "..", "S1-auto-rework", "repo");
const OWNER_TESTS = path.join(HERE, "..", "S1-auto-rework", "owner-tests");
const CHECK = path.join(OWNER_TESTS, "check.mjs");
const ALWAYS_FAIL = path.join(OWNER_TESTS, "always-fail.mjs");
const NODE = "/usr/local/bin/node";
const FAKE = path.join(HERE, "fake-provider.mjs");

await rm(ROOT, { recursive: true, force: true });
await mkdir(path.join(ROOT, "state"), { recursive: true, mode: 0o700 });
process.env.AGETOR_DATA_DIR = path.join(ROOT, "state");

const { HubService, resolveRepository } = await import(`${BACKEND}/packages/core/hub.ts`);
const { HubStore } = await import(`${BACKEND}/packages/core/state/store.ts`);
const { db } = await import(`${BACKEND}/src/bun/db.ts`);

const PROFILE = SCENARIO === "s3" ? "failing" : "acceptance";
const repository = await resolveRepository({
  id: "44444444-4444-4444-8444-444444444444",
  label: `DS-02 S0 ${SCENARIO}`,
  path: REPO,
  defaultTestProfileId: PROFILE,
  model: "gpt-6.1-sol",
  effort: "high",
  testProfiles: [
    { id: "acceptance", command: [NODE, CHECK], timeoutMs: 20000, readPaths: [OWNER_TESTS] },
    { id: "failing", command: [NODE, ALWAYS_FAIL], timeoutMs: 20000, readPaths: [OWNER_TESTS] },
  ],
});

const fakeSpawn = (_cmd: string, _args: string[], options: { cwd?: string }) =>
  spawn(NODE, [FAKE], { cwd: options.cwd, detached: true, stdio: ["pipe", "pipe", "pipe"] }) as never;

const directTestRunner = async (_root: string, workspace: string, profile: { id: string; command: string[]; timeoutMs: number }, signal?: AbortSignal) => {
  const proc = Bun.spawn([profile.command[0]!, ...profile.command.slice(1)], {
    cwd: workspace, stdout: "pipe", stderr: "pipe", env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill("SIGKILL"); }, profile.timeoutMs);
  const exitCode = await proc.exited;
  clearTimeout(timer);
  return { profileId: profile.id, exitCode, stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(), timedOut, cancelled: signal?.aborted ?? false };
};

const store = new HubStore(db);
const service = new HubService(store, { root: ROOT, repositories: [repository], spawn: fakeSpawn, testRunner: directTestRunner });

const IMPL_ID = randomUUID();
const task = await service.create({
  title: `S0 ${SCENARIO} offline self-test`,
  goal: "Implement src/amount.mjs exporting formatAmount(minorUnits) as a human-readable RMB string with two decimals.",
  repositoryId: repository.id,
  priority: "medium",
  acceptanceCriteria: [{ id: "AC-FINAL", description: "owner acceptance test still passes", testProfileId: PROFILE }],
  plannedSubtasks: [{
    id: IMPL_ID, code: "IMPL", title: "Implement formatAmount",
    description: "Implement src/amount.mjs exporting formatAmount(minorUnits).",
    stage: "implementation", dependsOn: [], requiredCapabilities: ["stream"],
    acceptanceCriteria: [{ id: "AC-AMOUNT", description: "owner acceptance test exits 0", testProfileId: PROFILE }],
  }],
});
console.log(`[${SCENARIO}] created task`, task.id);

const trace: unknown[] = [];
const snap = (label: string) => {
  const t = store.get("task", task.id);
  trace.push({
    label, at: new Date().toISOString(),
    task: { status: t.status, version: t.version, progressPct: t.progressPct, error: t.error },
    steps: store.list("subtask", task.id).map((s) => ({ code: s.code, status: s.status, attempt: s.attempt, error: s.error?.code ?? null })),
    runs: store.list("run", task.id).map((r) => ({ attempt: r.attempt, status: r.status, exitCode: r.exitCode, session: r.providerSessionId })),
    pendingApprovals: store.list("approval", task.id).filter((a) => a.status === "pending").length,
  });
};

async function waitFor(predicate: (status: string) => boolean, label: string, maxMs = 120_000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    await Bun.sleep(500);
    const t = store.get("task", task.id);
    if (predicate(t.status)) { snap(label); return t; }
  }
  snap(`${label}-timeout`);
  throw new Error(`timeout waiting for ${label}; last status=${store.get("task", task.id).status}`);
}

let rejected: unknown = null;
let reworked: unknown = null;

const first = await waitFor((s) => ["waiting_approval", "failed"].includes(s), "first-terminal");
if (first.status === "failed" && SCENARIO !== "s3") throw new Error("unexpected early failure");

if (SCENARIO === "s2") {
  const approval = store.list("approval", task.id).find((a) => a.status === "pending")!;
  rejected = await service.decideApproval(approval.id, {
    expectedVersion: approval.version, decision: "reject", actionDigest: approval.actionDigest,
    comment: "S0 s2: request a change before approval",
  });
  snap("after-reject");
  const review = store.list("subtask", task.id).find((s) => s.code === "FINAL-REVIEW")!;
  reworked = await service.subtaskAction(review.id, "rework", {
    expectedVersion: review.version, reason: "S0 s2: explicit rework after rejection", artifactRefs: [],
  });
  await waitFor((s) => ["waiting_approval", "failed"].includes(s), "second-approval");
}

let decided: unknown = null;
if (SCENARIO === "s3") {
  const after = store.get("task", task.id);
  const runs = store.list("run", task.id);
  const subtasks = store.list("subtask", task.id);
  const dump = {
    classification: "controlled: real HubService/SQLite/Git/quality gate; simulated provider; planner bypassed; testRunner replaced",
    scenario: SCENARIO, taskId: task.id, trace,
    status: after.status, error: after.error,
    runs: runs.map((r) => ({ attempt: r.attempt, status: r.status, exitCode: r.exitCode, error: r.error })),
    subtasks: subtasks.map((s) => ({ code: s.code, status: s.status, attempt: s.attempt, maxAttempts: s.maxAttempts, error: s.error })),
    validations: store.list("validation", task.id).map((v) => ({ criterionId: v.criterionId, status: v.status, exitCode: v.exitCode })),
    approvals: store.list("approval", task.id),
  };
  await writeFile(path.join(HERE, `s0-${SCENARIO}-evidence.json`), JSON.stringify(dump, null, 2));
  console.log(`[s3] status=${after.status} runs=${runs.length} validations=${dump.validations.length} approvals=${dump.approvals.length}`);
  await service.close(); db.close();
  process.exit(after.status === "failed" && runs.length === 2 && dump.approvals.length === 0 ? 0 : 1);
}

const pending = store.list("approval", task.id).find((a) => a.status === "pending");
if (!pending) throw new Error("no pending approval at terminal state");
decided = await service.decideApproval(pending.id, {
  expectedVersion: pending.version, decision: "approve", actionDigest: pending.actionDigest,
  comment: `S0 ${SCENARIO} approval`,
});
const after = store.get("task", task.id);
snap("after-approve");

const dump = {
  classification: "controlled: real HubService/SQLite/Git/quality gate; simulated provider; planner bypassed; testRunner replaced",
  scenario: SCENARIO, taskId: task.id,
  status: after.status,
  rejectResult: rejected, reworkResult: reworked, approveResult: decided,
  trace,
  subtasks: store.list("subtask", task.id),
  runs: store.list("run", task.id),
  validations: store.list("validation", task.id),
  approvals: store.list("approval", task.id),
  artifacts: store.list("artifact", task.id),
  messages: store.list("message", task.id),
  workspaces: db.query("SELECT * FROM hub_workspaces").all(),
};
await writeFile(path.join(HERE, `s0-${SCENARIO}-evidence.json`), JSON.stringify(dump, null, 2));
console.log(`[${SCENARIO}] final=${after.status} runs=${dump.runs.length} validations=${dump.validations.length} approvals=${dump.approvals.map((a) => a.status).join(">")}`);
await service.close(); db.close();
process.exit(after.status === "succeeded" ? 0 : 1);
