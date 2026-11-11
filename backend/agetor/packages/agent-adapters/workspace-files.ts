import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

const MAX_FILE_BYTES = 4 * 1024 * 1024;

async function checkedPath(cwd: string, name: string, createParents = false): Promise<string> {
  if (typeof name !== 'string' || name.includes('\0') || path.isAbsolute(name)) {
    throw new Error('PERMISSION_DENIED: expected a relative workspace path');
  }
  const root = await realpath(cwd);
  const target = path.resolve(root, name);
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('PERMISSION_DENIED: path escapes workspace');
  }
  const parts = relative ? relative.split(path.sep) : [];
  let current = root;
  for (const [index, part] of parts.entries()) {
    if (['.git', '.codex', '.hub-test'].includes(part.toLowerCase())) {
      throw new Error('PERMISSION_DENIED: reserved workspace path');
    }
    current = path.join(current, part);
    if (createParents && index < parts.length - 1) {
      await mkdir(current).catch((error) => { if (error.code !== 'EEXIST') throw error; });
    }
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()) || (info.isFile() && info.nlink !== 1)) {
        throw new Error('PERMISSION_DENIED: links and special files are forbidden');
      }
    } catch (error) {
      if (!(createParents && index === parts.length - 1 && (error as NodeJS.ErrnoException).code === 'ENOENT')) throw error;
    }
  }
  return target;
}

export async function readWorkspaceFile(cwd: string, name: string): Promise<string> {
  const target = await checkedPath(cwd, name);
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > MAX_FILE_BYTES) throw new Error('PERMISSION_DENIED: invalid workspace file');
    const bytes = await file.readFile();
    if (bytes.length > MAX_FILE_BYTES) throw new Error('PAYLOAD_TOO_LARGE: workspace file exceeds limit');
    return bytes.toString('utf8');
  } finally { await file.close(); }
}

export async function writeWorkspaceFile(cwd: string, name: string, content: string, writable: boolean): Promise<void> {
  if (!writable) throw new Error('PERMISSION_DENIED: write operations are forbidden in read-only sandbox');
  if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error('PAYLOAD_TOO_LARGE: invalid workspace content');
  const target = await checkedPath(cwd, name, true);
  const file = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1) throw new Error('PERMISSION_DENIED: invalid workspace file');
    await file.truncate(0);
    await file.writeFile(content, 'utf8');
  } finally { await file.close(); }
}

export async function listWorkspaceFiles(cwd: string, name = '.') {
  return readdir(await checkedPath(cwd, name), { withFileTypes: true });
}
