import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WorkspaceManager, freezeArtifact, readFrozenArtifact, runTestProfile, writeArtifact } from "../../packages/core/workspace.ts";

let temp: string; let root: string; let repo: string; let base: string; let taskId: string; let manager: WorkspaceManager;
function git(args: string[], cwd = repo): string {
  return execFileSync("/usr/bin/git",["-c","core.hooksPath=/dev/null","-c","user.name=Hub Test","-c","user.email=test@local.invalid",...args],{ cwd,encoding: "utf8",env: { ...process.env,GIT_CONFIG_GLOBAL: "/dev/null",GIT_CONFIG_NOSYSTEM: "1" },stdio: ["ignore","pipe","pipe"] }).trim();
}
beforeEach(async () => {
  temp = await mkdtemp(path.join(tmpdir(),"hub-workspace-")); root = path.join(temp,"hub"); repo = path.join(temp,"source");
  await mkdir(root); await mkdir(repo); git(["init","--initial-branch=main"]);
  await writeFile(path.join(repo,"base.txt"),"base\n"); await writeFile(path.join(repo,"tool.sh"),"#!/bin/sh\necho base\n"); await chmod(path.join(repo,"tool.sh"),0o755);
  git(["add","."]); git(["commit","-m","base"]); base = git(["rev-parse","HEAD"]); taskId = randomUUID(); manager = new WorkspaceManager(root);
});
afterEach(async () => { await rm(temp,{ recursive: true,force: true }); });
const input = () => ({ repositoryPath: repo,baseCommit: base,taskId,subtaskId: randomUUID() });

test("coordinator uses a real worktree, while Agent files have no Git metadata and source stays unchanged", async () => {
  const workspace = await manager.prepare(input());
  expect(await readFile(path.join(workspace.worktreePath,".git"),"utf8")).toContain("gitdir:");
  expect(await readFile(path.join(workspace.agentPath,"base.txt"),"utf8")).toBe("base\n");
  await expect(readFile(path.join(workspace.agentPath,".git"))).rejects.toThrow();
  await writeFile(path.join(workspace.agentPath,"new.py"),"print('hello')\n");
  const captured = await manager.capture(workspace);
  expect(captured.files.map((file) => file.relativePath)).toEqual(["new.py"]);
  expect(captured.diff).toContain("print('hello')"); expect(captured.commit).not.toBe(base);
  expect(git(["rev-parse","HEAD"])).toBe(base); expect(git(["status","--porcelain"])).toBe("");
  expect(git(["ls-files","--stage","tool.sh"],workspace.worktreePath)).toStartWith("100755");
});

test("dependency commits integrate into a new workspace and only its own changes are captured", async () => {
  const first = await manager.prepare(input()); await writeFile(path.join(first.agentPath,"a.txt"),"A");
  const a = await manager.capture(first);
  const next = await manager.prepare({ ...input(),dependencyCommits: [a.commit] });
  expect(await readFile(path.join(next.agentPath,"a.txt"),"utf8")).toBe("A");
  await writeFile(path.join(next.agentPath,"b.txt"),"B"); const b = await manager.capture(next);
  expect(b.files.map((file) => file.relativePath)).toEqual(["b.txt"]);
});

test("merge conflict preserves coordinator evidence and original repository", async () => {
  const first = await manager.prepare(input()); await writeFile(path.join(first.agentPath,"base.txt"),"left\n"); const a = await manager.capture(first);
  const second = await manager.prepare(input()); await writeFile(path.join(second.agentPath,"base.txt"),"right\n"); const b = await manager.capture(second);
  let failed: unknown;
  try { await manager.prepare({ ...input(),dependencyCommits: [a.commit,b.commit] }); } catch (error) { failed = error; }
  expect(String(failed)).toContain("WORKTREE_CONFLICT");
  const failure = failed as Error & { files: string[]; workspace: { worktreePath: string } };
  expect(failure.files).toContain("base.txt");
  expect(git(["diff","--name-only","--diff-filter=U"],failure.workspace.worktreePath)).toContain("base.txt");
  expect(git(["rev-parse","HEAD"])).toBe(base);
});

test("Agent symlinks and injected CLI metadata are rejected before capture", async () => {
  const workspace = await manager.prepare(input());
  await symlink(path.join(repo,"base.txt"),path.join(workspace.agentPath,"escape"));
  await expect(manager.capture(workspace)).rejects.toThrow("ARTIFACT_INVALID");
  await rm(path.join(workspace.agentPath,"escape")); await mkdir(path.join(workspace.agentPath,".codex"));
  await expect(manager.capture(workspace)).rejects.toThrow("ARTIFACT_INVALID");
});

test("artifacts remain immutable, validate metadata and hashes after reopening, reject path escape", async () => {
  const workspace = await manager.prepare(input()); await writeFile(path.join(workspace.agentPath,"result.py"),"print(42)\n");
  const artifact = await freezeArtifact(root,workspace,"result.py");
  expect((await readFrozenArtifact(root,artifact)).toString()).toBe("print(42)\n");
  await writeFile(path.join(workspace.agentPath,"result.py"),"changed");
  expect((await readFrozenArtifact(root,artifact)).toString()).toBe("print(42)\n");
  await expect(freezeArtifact(root,workspace,"../source/base.txt")).rejects.toThrow("ARTIFACT_INVALID");
  await expect(readFrozenArtifact(root,{ ...artifact,sha256: "f".repeat(64) })).rejects.toThrow("ARTIFACT_INVALID");
  await writeFile(path.join(root,"state/artifacts",artifact.id,"blob"),"tampered");
  await expect(readFrozenArtifact(root,artifact)).rejects.toThrow("ARTIFACT_INVALID");
  expect((await writeArtifact(root,"report","reports/check.txt")).relativePath).toBe("reports/check.txt");
});

test("registered test profile runs in sandbox and cannot read/write control state or use network", async () => {
  const workspace = await manager.prepare(input()); const secret = path.join(root,"state","secret.txt"); await writeFile(secret,"PRIVATE_FIXTURE");
  const python = "/Applications/Xcode.app/Contents/Developer/usr/bin/python3";
  const source = `from pathlib import Path\nimport socket\np=Path(${JSON.stringify(secret)})\nfor action in [lambda:p.read_text(),lambda:p.write_text('bad')]:\n try: action()\n except PermissionError: pass\n else: raise AssertionError('control storage was accessible')\ns=socket.socket()\ntry:\n s.connect(('127.0.0.1',9))\nexcept PermissionError: pass\nelse: raise AssertionError('network was accessible')\nPath('test-result.txt').write_text('OK')\nprint('SANDBOX_VALIDATED')`;
  const result = await runTestProfile(root,workspace.agentPath,{ id: "sandbox-negative",command: [python,"-I","-B","-c",source],timeoutMs: 15_000 });
  expect(result.exitCode).toBe(0); expect(result.stdout).toContain("SANDBOX_VALIDATED");
  expect(await readFile(secret,"utf8")).toBe("PRIVATE_FIXTURE");
});

test("test timeout and explicit cancellation are distinct and reap their process group", async () => {
  const workspace = await manager.prepare(input()); const python = "/Applications/Xcode.app/Contents/Developer/usr/bin/python3";
  const profile = { id: "sleep",command: [python,"-I","-B","-c","import time;time.sleep(30)"],timeoutMs: 150 };
  const timed = await runTestProfile(root,workspace.agentPath,profile); expect(timed.timedOut).toBe(true); expect(timed.cancelled).toBe(false);
  const controller = new AbortController(); const pending = runTestProfile(root,workspace.agentPath,{ ...profile,timeoutMs: 15_000 },controller.signal);
  setTimeout(() => controller.abort(),100); const cancelled = await pending;
  expect(cancelled.cancelled).toBe(true); expect(cancelled.timedOut).toBe(false);
});

test('external trusted oracle still rejects code after project tests are weakened', async () => {
  const workspace = await manager.prepare(input());
  const oracle = new URL('../../../../config/acceptance/test_circle.cjs',import.meta.url).pathname;
  const profile = {id:'external-circle',command:[process.execPath,oracle],readPaths:[path.dirname(oracle)],timeoutMs:15000};
  await writeFile(path.join(workspace.agentPath,'circle.js'),'exports.area=()=>0;exports.circumference=()=>0;');
  await writeFile(path.join(workspace.agentPath,'test_circle.js'),'console.log("all tests passed");');
  const failed = await runTestProfile(root,workspace.agentPath,profile);
  expect(failed.exitCode).not.toBe(0);
  await writeFile(path.join(workspace.agentPath,'circle.js'),'exports.area=r=>Math.PI*r*r;exports.circumference=r=>2*Math.PI*r;');
  const passed = await runTestProfile(root,workspace.agentPath,profile);
  if (passed.exitCode !== 0) throw new Error(passed.stderr || passed.stdout);
  expect(passed.exitCode).toBe(0);
  expect(passed.stdout).toContain('CIRCLE_TESTS_PASSED');
});
