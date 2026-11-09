// DS-03 B follow-up: the crash-during-test task is stuck at "validating".
// Question: is a manual cancel the only way out? Verify it actually works.
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const BACKEND = "/Users/anyunhong/Desktop/集合agent/backend/agetor";
const SHARED = "/Users/anyunhong/Desktop/集合agent";
const BUN = "/Users/anyunhong/Documents/Codex/2026-11-02/multi-agent-collaboration-hub-ai-agent/work/tooling/node_modules/@oven/bun-darwin-aarch64/bin/bun";
const CONFIG = path.join(HERE, "B", "config.json");
const RUNTIME = path.join(HERE, "B", "runtime");

const hub = spawn(BUN, [path.join(BACKEND, "scripts/start-hub.ts"), CONFIG], {
  cwd: SHARED, stdio: ["ignore", "pipe", "pipe"], detached: true,
});
let out = ""; hub.stdout.on("data", (b) => out += b); hub.stderr.on("data", (b) => out += b);
let creds: any = null;
for (let i = 0; i < 60; i++) {
  await Bun.sleep(500);
  try { creds = JSON.parse(await readFile(path.join(RUNTIME, "state", "credentials.json"), "utf8")); break; } catch {}
}
if (!creds) { console.log("hub not ready", out.slice(-500)); process.exit(1); }
const api = async (m: string, p: string, body?: unknown) => {
  const h: Record<string, string> = { authorization: `Bearer ${creds.token}` };
  if (body !== undefined) { h["content-type"] = "application/json"; h["idempotency-key"] = crypto.randomUUID(); }
  const r = await fetch(creds.origin + p, { method: m, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

const tasks = await api("GET", "/api/v1/tasks");
const task = tasks.body.data.items[0];
console.log("stuck task:", task.status, "version", task.version, "error", task.error);
const cancel = await api("POST", `/api/v1/tasks/${task.id}/cancel`, { expectedVersion: task.version, reason: "DS-03 B: manual recovery of a stuck validating task" });
console.log("cancel ->", cancel.status, JSON.stringify(cancel.body).slice(0, 200));
await Bun.sleep(3000);
const after = await api("GET", `/api/v1/tasks/${task.id}`);
const t = after.body.data.task ?? after.body.data;
console.log("after cancel:", t.status, "progress", t.progressPct, "error", t.error?.code ?? null);
const subs = (after.body.data.subtasks?.items ?? after.body.data.subtasks ?? []).map((s: any) => `${s.code}:${s.status}`);
console.log("subtasks:", subs.join(","));
await writeFile(path.join(HERE, "evidence", "B-manual-cancel.json"), JSON.stringify({ before: task.status, cancel: cancel.status, after: t.status, subtasks: subs }, null, 2));
try { process.kill(hub.pid!, "SIGINT"); } catch {}
await Bun.sleep(1500);
process.exit(0);
