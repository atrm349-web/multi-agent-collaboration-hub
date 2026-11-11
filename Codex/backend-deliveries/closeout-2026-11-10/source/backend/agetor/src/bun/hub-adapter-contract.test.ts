import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ClaudeRuntime } from '../../packages/agent-adapters/claude/runtime.ts';
import { readWorkspaceFile, writeWorkspaceFile } from '../../packages/agent-adapters/workspace-files.ts';

test('workspace tools reject parent escapes, symlink reads/writes and readonly writes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workspace-tools-'));
  try {
    const cwd = path.join(root, 'code'); await mkdir(cwd);
    const outside = path.join(root, 'outside'); await writeFile(outside, 'original');
    await symlink(outside, path.join(cwd, 'linked'));
    await expect(readWorkspaceFile(cwd, 'linked')).rejects.toThrow('PERMISSION_DENIED');
    await expect(writeWorkspaceFile(cwd, 'linked', 'changed', true)).rejects.toThrow('PERMISSION_DENIED');
    await expect(writeWorkspaceFile(cwd, '../outside', 'changed', true)).rejects.toThrow('PERMISSION_DENIED');
    await expect(writeWorkspaceFile(cwd, 'new.txt', 'changed', false)).rejects.toThrow('PERMISSION_DENIED');
    await writeWorkspaceFile(cwd, 'nested/file.txt', 'safe', true);
    expect(await readWorkspaceFile(cwd, 'nested/file.txt')).toBe('safe');
    expect(await readFile(outside, 'utf8')).toBe('original');
  } finally { await rm(root, {recursive:true, force:true}); }
});

for (const scenario of ['valid-review', 'invalid-review', 'readonly-write', 'prefaced-review']) {
  test(`Claude contract ${scenario}`, async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-contract-'));
    try {
      const runtime = new ClaudeRuntime({workspaceRoot:cwd});
      let calls = 0;
      (runtime as any).client = {isConfigured:true, async createMessage() {
        calls++;
        if (scenario === 'readonly-write' && calls === 1) return {stop_reason:'tool_use',content:[{type:'tool_use',id:'fake',name:'write_file',input:{path:'forbidden.txt',content:'bad'}}]};
        return {stop_reason:'end_turn',content:[{type:'text',text:scenario === 'invalid-review' ? 'bad JSON' : (scenario === 'prefaced-review' ? '审查完成。\n{"approved":true,"findings":[]}' : '{"approved":true,"findings":[]}')}]};
      }};
      const id = await runtime.start({cwd, prompt:'Review fixture',sandbox:'read-only',model:'claude-fixture',effort:'low',outputSchema:{type:'object'}});
      const result = await runtime.wait(id);
      expect(result.status).toBe(scenario === 'invalid-review' ? 'failed' : 'succeeded');
      expect(runtime.getLogs(id).some(log => (log.event?.item as {type?:string} | undefined)?.type === 'agent_message')).toBe(true);
      await expect(readFile(path.join(cwd,'forbidden.txt'))).rejects.toThrow();
    } finally { await rm(cwd,{recursive:true,force:true}); }
  });
}

import { WorkBuddyRuntime } from '../../packages/agent-adapters/workbuddy/runtime.ts';
import { capabilitiesForModel } from '../../packages/agent-adapters/provider.ts';
test('gateway rejects unverified read-only execution and providers expose actual resume support', async () => {
  const runtime = new WorkBuddyRuntime({workspaceRoot:os.tmpdir()});
  await expect(runtime.start({cwd:os.tmpdir(),prompt:'Review',sandbox:'read-only',model:'workbuddy',effort:'low'})).rejects.toThrow('UNSUPPORTED_CAPABILITY');
  expect(capabilitiesForModel('deepseek-chat')).not.toContain('resume');
  expect(capabilitiesForModel('gpt-6.1-sol')).toContain('resume');
});

import { MuseRuntime } from '../../packages/agent-adapters/muse/runtime.ts';
import { providerForModel } from '../../packages/agent-adapters/provider.ts';
import { planWithMuse, planWithWorkBuddy } from '../../packages/core/planner.ts';
test('Muse attribution and native planning/read-only restrictions fail before dispatch', async () => {
  expect(providerForModel('muse')).toBe('muse');
  expect(capabilitiesForModel('muse')).not.toContain('resume');
  const runtime = new MuseRuntime({workspaceRoot:os.tmpdir()});
  await expect(runtime.start({cwd:os.tmpdir(),prompt:'Review',sandbox:'read-only',model:'muse',effort:'low'})).rejects.toThrow('UNSUPPORTED_CAPABILITY');
  const options = {goal:'Plan',cwd:os.tmpdir(),workspaceRoot:os.tmpdir(),repositoryId:'11111111-2222-3333-4444-555555555555',model:'muse',effort:'low'};
  await expect(planWithMuse(options)).rejects.toThrow('UNSUPPORTED_CAPABILITY');
  await expect(planWithWorkBuddy({...options,model:'workbuddy'})).rejects.toThrow('UNSUPPORTED_CAPABILITY');
});
