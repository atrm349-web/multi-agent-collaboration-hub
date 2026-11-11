import { execFileSync } from 'node:child_process';

export function processIdentity(pid: number): string | null {
  try {
    return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim() || null;
  } catch { return null; }
}

export function processGroupExists(pid: number): boolean {
  try { process.kill(-pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}
