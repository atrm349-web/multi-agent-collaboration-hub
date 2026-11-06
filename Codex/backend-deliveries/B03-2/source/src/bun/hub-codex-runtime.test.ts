import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawn, type SpawnOptions } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CodexRuntime, type CodexRequest } from "../../packages/agent-adapters/codex/runtime.ts";

let root: string;
let runtimes: { runtime: CodexRuntime; id: string }[];
let originalDataDir: string | undefined;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "hub-codex-")); runtimes = [];
  originalDataDir = process.env.AGETOR_DATA_DIR;
  process.env.AGETOR_DATA_DIR = path.join(root, "state");
  await mkdir(process.env.AGETOR_DATA_DIR);
  await mkdir(path.join(root,"workspace"));
});
afterEach(async () => {
  await Promise.all(runtimes.map(({ runtime, id }) => runtime.cancel(id)));
  await rm(root, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.AGETOR_DATA_DIR;
  else process.env.AGETOR_DATA_DIR = originalDataDir;
});
const success = `console.log(JSON.stringify({type:'turn.completed'}));`;
const request = (): CodexRequest => ({ cwd: path.join(root,"workspace"), prompt: "test", sandbox: "read-only",
  model: "gpt-6.1-sol", effort: "high", timeoutMs: 5_000 });
function fixture(script: string, observed?: (args: readonly string[], options: SpawnOptions) => void) {
  const runtime = new CodexRuntime({ workspaceRoot: root, killGraceMs: 30,
    spawn: ((_: string, args: readonly string[], options: SpawnOptions) => {
      observed?.(args, options);
      return spawn("node", ["-e", script], options);
    }) as typeof spawn });
  return runtime;
}
async function start(runtime: CodexRuntime, input = request()) {
  const id = await runtime.start(input);
  runtimes.push({ runtime, id });
  return id;
}

test("JSONL handles split UTF-8, CRLF and a final unterminated line", async () => {
  const session = "11111111-1111-4111-8111-111111111111";
  const lines = JSON.stringify({ type: "thread.started", thread_id: session }) + "\r\n" +
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "测试通过" } }) + "\n" +
    JSON.stringify({ type: "turn.completed" });
  const runtime = fixture(`const bytes=Buffer.from(${JSON.stringify(lines)});let i=0;
    const t=setInterval(()=>{process.stdout.write(bytes.subarray(i,i+1));i++;if(i>=bytes.length)clearInterval(t)},1);`);
  const id = await start(runtime);
  const result = await runtime.wait(id);
  expect(result.status).toBe("succeeded");
  expect(result.sessionId).toBe(session);
  expect(result.result).toBe("测试通过");
  expect(runtime.getLogs(id).length).toBe(3);
  expect(runtime.getLogs(id, 2).length).toBe(1);
});

test("zero exit without completion is a failure", async () => {
  const runtime = fixture("process.stdout.write('{}\\n')");
  const result = await runtime.wait(await start(runtime));
  expect(result.error?.code).toBe("MISSING_TERMINAL_EVENT");
});

test("nonzero exit overrides a completion event", async () => {
  const runtime = fixture(success + "process.exitCode=7;");
  const result = await runtime.wait(await start(runtime));
  expect(result.status).toBe("failed");
  expect(result.exitCode).toBe(7);
  expect(result.error?.code).toBe("PROCESS_CRASHED");
});

test("turn.failed remains a failure even with a later completion", async () => {
  const runtime = fixture("console.log(JSON.stringify({type:'turn.failed'}));" + success);
  const result = await runtime.wait(await start(runtime));
  expect(result.error?.code).toBe("TURN_FAILED");
});

test("cancellation reaps the process, cannot be overwritten by completion, and is idempotent", async () => {
  const runtime = fixture(`process.on('SIGTERM',()=>{${success}});setInterval(()=>{},1000);`);
  const id = await start(runtime);
  await new Promise((r) => setTimeout(r, 150));
  await runtime.cancel(id);
  expect(runtime.getStatus(id)).toBe("cancelled");
  expect(runtime.getResult(id).error?.code).toBe("CANCELLED");
  await runtime.cancel(id);
  expect(runtime.getStatus(id)).toBe("cancelled");
});

test("timeout escalates for an unresponsive process and remains distinct from cancel", async () => {
  const runtime = fixture("process.on('SIGTERM',()=>{});setInterval(()=>{},1000)");
  const result = await runtime.wait(await start(runtime, { ...request(), timeoutMs: 150 }));
  expect(result.status).toBe("timed_out");
  expect(result.error?.code).toBe("TIMEOUT");
});

test("root and symlink escape are rejected before spawning", async () => {
  let calls = 0;
  const runtime = fixture(success, () => { calls++; });
  const outside = await mkdtemp(path.join(tmpdir(), "hub-outside-"));
  try {
    await symlink(outside, path.join(root, "escape"));
    await expect(runtime.start({ ...request(), cwd: outside })).rejects.toThrow("PERMISSION_DENIED");
    await expect(runtime.start({ ...request(), cwd: path.join(root, "escape") })).rejects.toThrow("PERMISSION_DENIED");
    expect(calls).toBe(0);
  } finally { await rm(outside, { recursive: true, force: true }); }
});

test("storage must be explicitly isolated under the workspace root before importing the DB", async () => {
  const runtime = fixture(success);
  delete process.env.AGETOR_DATA_DIR;
  await expect(runtime.start(request())).rejects.toThrow("PERMISSION_DENIED");
  process.env.AGETOR_DATA_DIR = tmpdir();
  await expect(runtime.start(request())).rejects.toThrow("PERMISSION_DENIED");
});

test("an Agent cannot run inside control storage or an ancestor that could overwrite it", async () => {
  const runtime = fixture(success);
  await expect(runtime.start({ ...request(),cwd: root })).rejects.toThrow("must be disjoint");
  await expect(runtime.start({ ...request(),cwd: path.join(root,"state") })).rejects.toThrow("must be disjoint");
});

test("one active run prevents concurrent and racing starts", async () => {
  const runtime = fixture("setInterval(()=>{},1000)");
  const first = runtime.start(request());
  await expect(runtime.start(request())).rejects.toThrow("AGENT_UNAVAILABLE");
  const id = await first;
  runtimes.push({ runtime, id });
  await expect(runtime.start(request())).rejects.toThrow("AGENT_UNAVAILABLE");
});

test("resume uses an explicit session, safe parent flags and a secret-free inherited environment", async () => {
  const secret = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-secret-never-forward";
  const session = "11111111-1111-4111-8111-111111111111";
  try {
    const runtime = fixture(success, (args, options) => {
      expect(args.slice(-3)).toEqual(["resume", session, "-"]);
      expect(args.indexOf("--sandbox")).toBeLessThan(args.indexOf("resume"));
      expect(args).not.toContain("danger-full-access");
      expect(options.env?.OPENAI_API_KEY).toBeUndefined();
      expect(options.shell).toBeUndefined();
      expect(options.detached).toBe(true);
    });
    const result = await runtime.wait(await start(runtime, { ...request(), sessionId: session }));
    expect(result.sessionId).toBe(session);
    await expect(runtime.start({ ...request(), sessionId: "--last" })).rejects.toThrow("INVALID_INPUT");
  } finally {
    if (secret === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = secret;
  }
});

test("malformed JSON and excessive output fail safely", async () => {
  const malformed = fixture("console.log('not json');" + success);
  expect((await malformed.wait(await start(malformed))).error?.code).toBe("TRANSPORT_ERROR");
  const excessive = fixture("process.stdout.write('x'.repeat(1024*1024+1));setInterval(()=>{},1000)");
  expect((await excessive.wait(await start(excessive))).error?.code).toBe("PAYLOAD_TOO_LARGE");
});

test("missing binary is reported as a terminal spawn error", async () => {
  const runtime = new CodexRuntime({ workspaceRoot: root,
    spawn: ((_: string, _args: readonly string[], options: SpawnOptions) =>
      spawn(path.join(root, "missing-codex"), [], options)) as typeof spawn });
  expect((await runtime.wait(await start(runtime))).error?.code).toBe("BINARY_NOT_FOUND");
});

test("runtime requests cannot override trusted process configuration", async () => {
  let calls = 0;
  const runtime = fixture(success, () => { calls++; });
  for (const input of [null, { ...request(), bin: "/bin/sh" }, { ...request(), env: {} },
    { ...request(), home: "/tmp" }, { ...request(), prompt: 7 }, { ...request(), cwd: null },
    { ...request(), model: "--dangerously-bypass-approvals-and-sandbox" }]) {
    await expect(runtime.start(input as CodexRequest)).rejects.toThrow("INVALID_INPUT");
  }
  expect(calls).toBe(0);
  const original = process.env.AGETOR_CODEX_BIN;
  process.env.AGETOR_CODEX_BIN = "/bin/sh";
  try { await expect(runtime.start(request())).rejects.toThrow("PERMISSION_DENIED"); }
  finally {
    if (original === undefined) delete process.env.AGETOR_CODEX_BIN;
    else process.env.AGETOR_CODEX_BIN = original;
  }
});

test("cancel kills a descendant in the owned process group before resolving", async () => {
  const runtime = fixture(`const {spawn}=require('node:child_process');
    process.on('SIGTERM',()=>{});
    const child=spawn('node',['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'inherit'});
    console.log(JSON.stringify({type:'test.descendant',pid:child.pid}));
    setInterval(()=>{},1000);`);
  const id = await start(runtime);
  let descendant: number | undefined;
  for (let i = 0; i < 100 && !descendant; i++) {
    descendant = runtime.getLogs(id).find((log) => log.event?.type === "test.descendant")?.event?.pid as number | undefined;
    if (!descendant) await new Promise((r) => setTimeout(r, 10));
  }
  expect(descendant).toBeNumber();
  await runtime.cancel(id);
  let gone = false;
  for (let i = 0; i < 100 && !gone; i++) {
    try { process.kill(descendant!, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") gone = true; else throw error; }
    if (!gone) await new Promise((r) => setTimeout(r, 10));
  }
  expect(gone).toBe(true);
});

test("cancel also reaps a silent descendant after its leader has already exited", async () => {
  const runtime = fixture(`const {spawn}=require('node:child_process');
    const child=spawn('node',['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});
    console.log(JSON.stringify({type:'test.descendant',pid:child.pid}));setInterval(()=>{},1000);`);
  const id = await start(runtime);
  let descendant: number | undefined;
  for (let i = 0; i < 100 && !descendant; i++) {
    descendant = runtime.getLogs(id).find((log) => log.event?.type === "test.descendant")?.event?.pid as number | undefined;
    if (!descendant) await new Promise((r) => setTimeout(r, 10));
  }
  expect(descendant).toBeNumber();
  await new Promise((r) => setTimeout(r, 150));
  await runtime.cancel(id);
  expect(runtime.getStatus(id)).toBe("cancelled");
  expect(() => process.kill(descendant!, 0)).toThrow();
});
