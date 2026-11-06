import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, realpath, rm, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

export interface WorkspaceHandle {
  id: string; taskId: string; subtaskId: string; repositoryPath: string;
  baseCommit: string; headCommit: string; agentPath: string; worktreePath: string; barePath: string;
}
export interface WorkspaceFile { relativePath: string; sizeBytes: number; sha256: string }
export interface FrozenArtifact { id: string; name: string; relativePath: string; sha256: string; sizeBytes: number; mimeType: string }
export interface TestProfile { id: string; command: string[]; timeoutMs: number; readPaths?: string[] }
export interface TestResult { profileId: string; exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; cancelled: boolean }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA = /^[a-f0-9]{40,64}$/i;
const MAX_FILE = 4 * 1024 * 1024;
const MAX_TOTAL = 32 * 1024 * 1024;
const SKIP = new Set(["node_modules", ".venv", "__pycache__", ".hub-test"]);
const FORBIDDEN = new Set([".git", ".codex"]);
function hash(bytes: Uint8Array) { return createHash("sha256").update(bytes).digest("hex"); }
function inside(root: string, target: string) { const relative = path.relative(root,target); return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)); }
function relativeName(name: string): string {
  if (!name || name.length > 240 || path.isAbsolute(name) || /[\\\x00-\x1f]/.test(name) || name.split("/").some((part) => !part || part === "." || part === ".." || FORBIDDEN.has(part.toLowerCase()) || part.toLowerCase() === ".hub-test")) {
    throw new Error("ARTIFACT_INVALID: unsafe relative path");
  }
  return name;
}
async function privateDir(root: string, relative: string): Promise<string> {
  const canonical = await realpath(root); let current = canonical;
  for (const part of relative.split("/")) {
    relativeName(part); current = path.join(current,part);
    try { await mkdir(current,{ mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink() || !inside(canonical,await realpath(current))) throw new Error("PERMISSION_DENIED: unsafe storage directory");
  }
  return current;
}
async function filesIn(folder: string, coordinator = false): Promise<Map<string,{bytes: Buffer; mode: number}>> {
  const root = await realpath(folder); const files = new Map<string,{bytes: Buffer; mode: number}>(); let total = 0;
  async function visit(directory: string) {
    for (const entry of await readdir(directory,{ withFileTypes: true })) {
      const relative = path.relative(root,path.join(directory,entry.name)).split(path.sep).join("/");
      if (coordinator && relative === ".git") continue;
      if (SKIP.has(entry.name)) continue;
      relativeName(relative);
      const full = path.join(directory,entry.name); const info = await lstat(full);
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()) || (info.isFile() && info.nlink > 1)) throw new Error("ARTIFACT_INVALID: links and special files are not accepted");
      if (info.isDirectory()) { await visit(full); continue; }
      if (info.size > MAX_FILE || files.size >= 500 || total + info.size > MAX_TOTAL) throw new Error("PAYLOAD_TOO_LARGE: workspace snapshot exceeds MVP limits");
      const descriptor = openSync(full,constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = fstatSync(descriptor); const bytes = readFileSync(descriptor);
        if (!opened.isFile() || opened.nlink > 1 || bytes.length > MAX_FILE || !inside(root,realpathSync(full))) throw new Error("ARTIFACT_INVALID: file changed during read");
        files.set(relative,{ bytes,mode: opened.mode & 0o111 ? 0o755 : 0o644 }); total += bytes.length;
      } finally { closeSync(descriptor); }
    }
  }
  // shortcut: snapshot limits suit the local MVP; stream large project assets before raising them.
  await visit(root); return files;
}
async function copyFiles(files: Map<string,{bytes: Buffer; mode: number}>, destination: string) {
  for (const [relative,item] of files) { const file = path.join(destination,relative); await mkdir(path.dirname(file),{ recursive: true,mode: 0o700 }); await writeFile(file,item.bytes); await chmod(file,item.mode); }
}
function gitEnvironment(home: string): NodeJS.ProcessEnv {
  return { PATH: "/usr/bin:/bin:/usr/sbin:/sbin",HOME: home,GIT_CONFIG_NOSYSTEM: "1",GIT_CONFIG_GLOBAL: "/dev/null",GIT_TERMINAL_PROMPT: "0",GIT_TEMPLATE_DIR: home,
    GIT_AUTHOR_NAME: "Agent Hub",GIT_AUTHOR_EMAIL: "hub@local.invalid",GIT_COMMITTER_NAME: "Agent Hub",GIT_COMMITTER_EMAIL: "hub@local.invalid" };
}
async function git(args: string[], cwd: string, home: string, allowFailure = false): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = spawn("/usr/bin/git",["-c","core.hooksPath=/dev/null","-c","core.fsmonitor=false","-c","core.attributesFile=/dev/null",...args],{ cwd,env: gitEnvironment(home),stdio: ["ignore","pipe","pipe"] });
  let stdout = ""; let stderr = "";
  const outDecoder = new StringDecoder("utf8"); const errDecoder = new StringDecoder("utf8");
  const timer = setTimeout(() => proc.kill("SIGKILL"),30_000);
  proc.stdout.on("data",(bytes: Buffer) => { stdout += outDecoder.write(bytes); if (Buffer.byteLength(stdout) > MAX_TOTAL) proc.kill("SIGKILL"); });
  proc.stderr.on("data",(bytes: Buffer) => { stderr += errDecoder.write(bytes); if (Buffer.byteLength(stderr) > MAX_FILE) proc.kill("SIGKILL"); });
  const code = await new Promise<number>((resolve,reject) => { proc.once("error",reject); proc.once("close",(value) => resolve(value ?? -1)); }).finally(() => clearTimeout(timer));
  stdout += outDecoder.end(); stderr += errDecoder.end();
  if (code !== 0 && !allowFailure) throw new Error(`WORKTREE_CONFLICT: Git operation failed: ${stderr.slice(0,500)}`);
  return { code,stdout,stderr };
}

export class WorkspaceManager {
  constructor(readonly root: string) {}
  private async validate(handle: WorkspaceHandle) {
    if (![handle.id,handle.taskId,handle.subtaskId].every((id) => UUID.test(id)) || !SHA.test(handle.baseCommit) || !SHA.test(handle.headCommit)) throw new Error("INVALID_INPUT: workspace identity");
    const root = await realpath(this.root);
    for (const [actual,expected] of [[handle.agentPath,path.join(root,"workspaces",handle.id)],
      [handle.worktreePath,path.join(root,"state","worktrees",handle.id)],[handle.barePath,path.join(root,"state","repositories",`${handle.taskId}.git`)]] as [string,string][]) {
      if (actual !== expected || (await realpath(actual!)) !== expected) throw new Error("PERMISSION_DENIED: workspace metadata changed");
    }
  }
  async prepare(input: { repositoryPath: string; baseCommit: string; taskId: string; subtaskId: string; dependencyCommits?: string[] }): Promise<WorkspaceHandle> {
    if (![input.taskId,input.subtaskId].every((id) => UUID.test(id)) || !SHA.test(input.baseCommit) || (input.dependencyCommits ?? []).some((commit) => !SHA.test(commit))) throw new Error("INVALID_INPUT: repository commit or workspace id");
    const root = await realpath(this.root); const repositoryPath = await realpath(input.repositoryPath);
    const home = await privateDir(root,"state/git-home"); const repositories = await privateDir(root,"state/repositories");
    const barePath = path.join(repositories,`${input.taskId}.git`); const recordFile = path.join(repositories,`${input.taskId}.json`);
    try {
      const record = JSON.parse(await readFile(recordFile,"utf8"));
      if (record.repositoryPath !== repositoryPath || record.baseCommit !== input.baseCommit) throw new Error("CONFLICT: task repository base is immutable");
      if ((await realpath(barePath)) !== barePath || (await lstat(barePath)).isSymbolicLink()) throw new Error("PERMISSION_DENIED: repository storage changed");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await git(["clone","--bare","--no-hardlinks","--dissociate","--",repositoryPath,barePath],root,home);
      await writeFile(recordFile,JSON.stringify({ repositoryPath,baseCommit: input.baseCommit }),{ flag: "wx",mode: 0o600 });
    }
    await git(["--git-dir",barePath,"rev-parse","--verify",`${input.baseCommit}^{commit}`],root,home);
    const id = randomUUID(); const worktrees = await privateDir(root,"state/worktrees"); const workspaces = await privateDir(root,"workspaces");
    const worktreePath = path.join(worktrees,id); const agentPath = path.join(workspaces,id);
    await git(["--git-dir",barePath,"worktree","add","--detach",worktreePath,input.baseCommit],root,home);
    const handle: WorkspaceHandle = { id,taskId: input.taskId,subtaskId: input.subtaskId,repositoryPath,baseCommit: input.baseCommit,headCommit: input.baseCommit,agentPath,worktreePath,barePath };
    for (const commit of input.dependencyCommits ?? []) {
      await git(["merge-base","--is-ancestor",input.baseCommit,commit],worktreePath,home);
      const merged = await git(["merge","--no-edit","--no-ff",commit],worktreePath,home,true);
      if (merged.code !== 0) {
        const conflicts = await git(["diff","--name-only","--diff-filter=U","-z"],worktreePath,home,true);
        const error = new Error("WORKTREE_CONFLICT: dependency changes require manual conflict resolution") as Error & { files: string[]; workspace: WorkspaceHandle };
        error.files = conflicts.stdout.split("\0").filter(Boolean); error.workspace = handle;
        throw error;
      }
    }
    handle.headCommit = (await git(["rev-parse","HEAD"],worktreePath,home)).stdout.trim();
    const files = await filesIn(worktreePath,true); await mkdir(agentPath,{ mode: 0o700 }); await copyFiles(files,agentPath);
    return handle;
  }
  async capture(handle: WorkspaceHandle): Promise<{ commit: string; diff: string; files: WorkspaceFile[] }> {
    await this.validate(handle); const home = await privateDir(this.root,"state/git-home");
    const input = await filesIn(handle.agentPath); const original = await filesIn(handle.worktreePath,true);
    for (const relative of original.keys()) if (!input.has(relative)) await rm(path.join(handle.worktreePath,relative));
    await copyFiles(input,handle.worktreePath);
    await git(["add","-A","--"],handle.worktreePath,home);
    const dirty = await git(["diff","--cached","--quiet"],handle.worktreePath,home,true);
    if (dirty.code !== 0) await git(["commit","-m",`Hub task ${handle.subtaskId}`],handle.worktreePath,home);
    const commit = (await git(["rev-parse","HEAD"],handle.worktreePath,home)).stdout.trim();
    const diff = (await git(["diff","--no-ext-diff","--no-textconv",handle.headCommit,commit,"--"],handle.worktreePath,home)).stdout;
    const changed = (await git(["diff","--name-only","-z",handle.headCommit,commit,"--"],handle.worktreePath,home)).stdout.split("\0").filter(Boolean);
    return { commit,diff,files: changed.filter((name) => input.has(name)).map((relativePath) => {
      const bytes = input.get(relativePath)!.bytes; return { relativePath,sizeBytes: bytes.length,sha256: hash(bytes) };
    }) };
  }
}

/** Test scratch belongs in .hub-test; acceptance must refer to the frozen source. */
export async function workspaceFingerprint(workspace: string): Promise<string> {
  const files = await filesIn(workspace);
  return hash(Buffer.from(JSON.stringify([...files].sort(([a],[b])=>a.localeCompare(b)).map(([name,item])=>[name,item.mode,hash(item.bytes)]))));
}

function mime(name: string): string {
  if (/\.json$/i.test(name)) return "application/json";
  if (/\.(png|jpg|jpeg)$/i.test(name)) return /png$/i.test(name) ? "image/png" : "image/jpeg";
  if (/\.pdf$/i.test(name)) return "application/pdf";
  return /\.(py|js|ts|tsx|jsx|md|txt|csv|yaml|yml|toml|diff|patch|html|css)$/i.test(name) ? "text/plain; charset=utf-8" : "application/octet-stream";
}
export async function writeArtifact(root: string, bytes: Uint8Array | string, name: string): Promise<FrozenArtifact> {
  relativeName(name); const data = typeof bytes === "string" ? Buffer.from(bytes) : Buffer.from(bytes);
  if (data.length > MAX_FILE) throw new Error("PAYLOAD_TOO_LARGE: artifact exceeds MVP limit");
  const id = randomUUID(); const directory = await privateDir(root,`state/artifacts/${id}`);
  const metadata: FrozenArtifact = { id,name: path.basename(name),relativePath: name,sha256: hash(data),sizeBytes: data.length,mimeType: mime(name) };
  await writeFile(path.join(directory,"blob"),data,{ flag: "wx",mode: 0o600 });
  await writeFile(path.join(directory,"metadata.json"),JSON.stringify(metadata),{ flag: "wx",mode: 0o600 });
  return metadata;
}
export async function freezeArtifact(root: string, handle: WorkspaceHandle, relativePath: string): Promise<FrozenArtifact> {
  relativeName(relativePath);
  const canonicalRoot = await realpath(root);
  if (!UUID.test(handle.id) || await realpath(handle.agentPath) !== path.join(canonicalRoot,"workspaces",handle.id)) throw new Error("PERMISSION_DENIED: unregistered artifact workspace");
  const files = await filesIn(handle.agentPath); const item = files.get(relativePath);
  if (!item) throw new Error("NOT_FOUND: artifact source does not exist");
  return writeArtifact(root,item.bytes,relativePath);
}
export async function readFrozenArtifact(root: string, expected: FrozenArtifact): Promise<Buffer> {
  if (!UUID.test(expected.id) || !/^[a-f0-9]{64}$/i.test(expected.sha256)) throw new Error("ARTIFACT_INVALID: artifact identity");
  const directory = path.join(await realpath(root),"state/artifacts",expected.id);
  try { if ((await lstat(directory)).isSymbolicLink() || await realpath(directory) !== directory) throw new Error("ARTIFACT_INVALID: storage changed"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("NOT_FOUND: unknown artifact"); throw error; }
  const metadata = JSON.parse(await readFile(path.join(directory,"metadata.json"),"utf8")) as FrozenArtifact;
  if (["id","name","relativePath","sha256","sizeBytes","mimeType"].some((key) => metadata[key as keyof FrozenArtifact] !== expected[key as keyof FrozenArtifact])) throw new Error("ARTIFACT_INVALID: metadata mismatch");
  const file = path.join(directory,"blob"); const descriptor = openSync(file,constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(descriptor); if (!info.isFile() || info.nlink > 1 || info.size > MAX_FILE) throw new Error("ARTIFACT_INVALID: unsafe artifact storage");
    const bytes = readFileSync(descriptor);
    if (bytes.length !== expected.sizeBytes || hash(bytes) !== expected.sha256) throw new Error("ARTIFACT_INVALID: artifact hash mismatch");
    return bytes;
  } finally { closeSync(descriptor); }
}

/** Runs only a server-registered fixed argv under a restricted-read OS sandbox. */
export async function runTestProfile(root: string, workspace: string, profile: TestProfile, signal?: AbortSignal): Promise<TestResult> {
  if (process.platform !== "darwin") throw new Error("UNSUPPORTED_CAPABILITY: independent test sandbox is only verified on macOS");
  if (!profile.id || !Array.isArray(profile.command) || !profile.command.length || !path.isAbsolute(profile.command[0]!) || profile.command.some((arg) => typeof arg !== "string" || arg.includes("\0"))
    || !Number.isSafeInteger(profile.timeoutMs) || profile.timeoutMs < 1 || profile.timeoutMs > 300_000) throw new Error("INVALID_INPUT: invalid registered test profile");
  if (signal?.aborted) throw new Error("CANCELLED: test cancelled before start");
  const canonicalRoot = await realpath(root); const cwd = await realpath(workspace);
  const workspaces = path.join(canonicalRoot,"workspaces");
  if (!inside(workspaces,cwd) || cwd === workspaces) throw new Error("PERMISSION_DENIED: test workspace is not registered");
  const reserved = path.join(cwd,".hub-test");
  try { const info = await lstat(reserved); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("PERMISSION_DENIED: unsafe test temporary directory"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; await mkdir(reserved,{ mode: 0o700 }); }
  const config = await privateDir(root,`state/test-sandboxes/${randomUUID()}`);
  const readable = [...new Set([await realpath(profile.command[0]!),...(profile.readPaths ?? []).map((file) => realpathSync(file))])].filter((file) => file !== cwd);
  const rules = ["[permissions.hub-test.filesystem]",'":minimal" = "read"',`${JSON.stringify(cwd)} = "write"`,...readable.map((file) => `${JSON.stringify(file)} = "read"`),"[permissions.hub-test.network]","enabled = false",""];
  await writeFile(path.join(config,"config.toml"),rules.join("\n"),{ mode: 0o600 });
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin",HOME: reserved,TMPDIR: reserved,CODEX_HOME: config,LANG: "en_US.UTF-8" };
  const found = Bun.which("codex");
  if (!found) throw new Error("BINARY_NOT_FOUND: official Codex sandbox is not installed");
  const sandboxBinary = await realpath(found);
  const proc = spawn(sandboxBinary,["sandbox","-P","hub-test","-C",cwd,"--",...profile.command],{ cwd,env,detached: true,stdio: ["ignore","pipe","pipe"] });
  let stdout = ""; let stderr = ""; let timedOut = false; let cancelled = false; let overLimit = false;
  const stdoutDecoder = new StringDecoder("utf8"); const stderrDecoder = new StringDecoder("utf8");
  const kill = (signal: NodeJS.Signals) => { if (!proc.pid) return; try { process.kill(-proc.pid,signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } };
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const stop = () => { kill("SIGTERM"); escalation ??= setTimeout(() => kill("SIGKILL"),500); };
  const abort = () => { cancelled = true; stop(); };
  signal?.addEventListener("abort",abort,{ once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => { timedOut = true; stop(); },profile.timeoutMs);
  const collect = (stream: "stdout" | "stderr", bytes: Buffer) => {
    if (stream === "stdout") stdout += stdoutDecoder.write(bytes); else stderr += stderrDecoder.write(bytes);
    if (Buffer.byteLength(stdout)+Buffer.byteLength(stderr) > 1024*1024) { overLimit = true; stop(); }
  };
  proc.stdout.on("data",(bytes: Buffer) => collect("stdout",bytes)); proc.stderr.on("data",(bytes: Buffer) => collect("stderr",bytes));
  const exitCode = await new Promise<number|null>((resolve,reject) => { proc.once("error",reject); proc.once("close",resolve); }).finally(() => { clearTimeout(timer); clearTimeout(escalation); signal?.removeEventListener("abort",abort); });
  stdout += stdoutDecoder.end(); stderr += stderrDecoder.end();
  // A test may have forked a silent descendant; never leave its group behind.
  kill("SIGKILL");
  if (proc.pid) {
    for (let attempt = 0; attempt < 100; attempt++) {
      try { process.kill(-proc.pid,0); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") break; throw error; }
      if (attempt === 99) throw new Error("PROCESS_CRASHED: test process group was not reaped");
      await new Promise((resolve) => setTimeout(resolve,10));
    }
  }
  if (overLimit) throw new Error("PAYLOAD_TOO_LARGE: test output exceeded limit");
  return { profileId: profile.id,exitCode,stdout,stderr,timedOut,cancelled };
}
