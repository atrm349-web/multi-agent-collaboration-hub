import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Explicit opt-in: this script makes real subscription-backed CLI calls.
const outputArgument = process.argv[2];
if (!outputArgument) throw new Error("Supply a new evidence directory");
const output = path.resolve(outputArgument);
if (existsSync(output)) throw new Error("Existing output is never overwritten");
const workspace = path.join(output, "workspace");
const forbidden = path.join(output, "outside-workspace");
mkdirSync(workspace, { recursive: true, mode: 0o700 });
mkdirSync(forbidden, { mode: 0o700 });
process.env.AGETOR_DATA_DIR = path.join(output, "state");
mkdirSync(process.env.AGETOR_DATA_DIR, { mode: 0o700 });
const { CodexRuntime } = await import("../packages/agent-adapters/codex/runtime.ts");
const auth = spawnSync("codex", ["login", "status"], { encoding: "utf8" });
assert.equal(auth.status, 0, "Official CLI must already be authenticated");
assert.match(auth.stdout + auth.stderr, /Logged in using ChatGPT/);
const runtime = new CodexRuntime({ workspaceRoot: output,
  onEvent(runId, log) {
    if (log.stream === "event") appendFileSync(path.join(output, `${runId}.jsonl`), JSON.stringify(log) + "\n");
  } });
const summary: Record<string, unknown> = { execution: "real", auth: "existing-chatgpt-login", runs: [] };
const results = summary.runs as unknown[];
function save() { writeFileSync(path.join(output, "summary.json"), JSON.stringify(summary, null, 2)); }
const base = { cwd: workspace, model: "gpt-6.1-sol", effort: "high", sandbox: "read-only" as const, timeoutMs: 90_000 };
async function execute(label: string, request: Parameters<typeof runtime.start>[0]) {
  const runId = await runtime.start(request);
  const result = await runtime.wait(runId);
  results.push({ label, ...result }); save();
  console.log(`${label}: ${result.status}`);
  return result;
}
function commands(id: string) {
  return runtime.getLogs(id).flatMap((log) => {
    const e = log.event;
    const item = e?.item as Record<string, unknown> | undefined;
    return e?.type === "item.completed" && item?.type === "command_execution" ? [item] : [];
  });
}
try {
  const fresh = await execute("start-and-output", { ...base, prompt: "Do not use tools. Reply exactly HUB_RUNTIME_OK." });
  assert.equal(fresh.status, "succeeded"); assert.match(fresh.result, /HUB_RUNTIME_OK/); assert.ok(fresh.sessionId);
  const resumed = await execute("explicit-session-resume", { ...base, sessionId: fresh.sessionId,
    prompt: "Do not use tools. Reply exactly HUB_RESUME_OK." });
  assert.equal(resumed.status, "succeeded"); assert.equal(resumed.sessionId, fresh.sessionId); assert.match(resumed.result, /HUB_RESUME_OK/);

  const write = await execute("workspace-write", { ...base, sandbox: "workspace-write",
    prompt: "Use your shell tool to create greeting.txt in the current directory containing exactly HUB_WORKSPACE_WRITE_OK. Do not commit, access other folders or run any other task. Report the outcome." });
  assert.equal(write.status, "succeeded");
  assert.equal(readFileSync(path.join(workspace, "greeting.txt"), "utf8").trim(), "HUB_WORKSPACE_WRITE_OK");
  assert.ok(commands(write.runId).some((item) => item.exit_code === 0));

  const blocked = path.join(forbidden, "blocked.txt");
  const isolation = await execute("outside-write-denied", { ...base, sandbox: "workspace-write",
    prompt: `This is an authorized sandbox negative test of an empty test folder. Execute exactly one shell command: python3 -c ${JSON.stringify(`open(${JSON.stringify(blocked)}, 'w').write('HUB_SHOULD_BE_BLOCKED')`)}. Do not request escalation, change permissions, or try alternative tools. A permission denial is the expected test result. Report what happened.` });
  assert.equal(isolation.status, "succeeded"); assert.equal(existsSync(blocked), false);
  assert.ok(commands(isolation.runId).some((item) => typeof item.exit_code === "number" && item.exit_code !== 0
    && String(item.command).includes("blocked.txt")), "Actual denied tool execution required");

  const cancelId = await runtime.start({ ...base,
    prompt: "Immediately execute this one shell command using your shell tool: python3 -c \"import time; print('HUB_CANCEL_WAIT', flush=True); time.sleep(60)\". Do not run any other task." });
  const deadline = Date.now() + 45_000;
  let commandStarted = false;
  while (Date.now() < deadline && runtime.getStatus(cancelId) === "running") {
    commandStarted = runtime.getLogs(cancelId).some((log) => log.event?.type === "item.started"
      && (log.event?.item as Record<string, unknown> | undefined)?.type === "command_execution");
    if (commandStarted) break;
    await Bun.sleep(100);
  }
  await Bun.sleep(750);
  await runtime.cancel(cancelId);
  const cancelled = runtime.getResult(cancelId);
  results.push({ label: "active-cancellation", commandStarted, ...cancelled }); save();
  assert.equal(cancelled.status, "cancelled"); assert.equal(commandStarted, true);
  await runtime.cancel(cancelId);
  console.log("active-cancellation: cancelled and repeated cancel is idempotent");

  const timeout = await execute("deadline", { ...base, timeoutMs: 15_000,
    prompt: "Immediately execute this one shell command using your shell tool: python3 -c \"import time; print('HUB_TIMEOUT_WAIT', flush=True); time.sleep(60)\". Do not run any other task." });
  assert.equal(timeout.status, "timed_out");
  const timeoutCommandStarted = runtime.getLogs(timeout.runId).some((log) => log.event?.type === "item.started"
    && (log.event?.item as Record<string, unknown> | undefined)?.type === "command_execution");
  summary.timeoutCommandStarted = timeoutCommandStarted;
  summary.passed = true; save();
  console.log("REAL_CODEX_RUNTIME_VERIFIED");
} catch (error) {
  summary.passed = false; summary.error = String(error); save();
  throw error;
}
