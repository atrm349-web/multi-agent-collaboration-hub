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

import { MuseRuntime } from '../../packages/agent-adapters/muse/runtime.ts';
import { providerForModel } from '../../packages/agent-adapters/provider.ts';
import { planWithMuse, planWithWorkBuddy } from '../../packages/core/planner.ts';
import { randomUUID } from 'node:crypto';
import { MuseClient } from '../../packages/agent-adapters/muse/client.ts';
import { WorkBuddyClient } from '../../packages/agent-adapters/workbuddy/client.ts';
import { spyOn } from 'bun:test';

test('providers expose actual resume support and native attribution', () => {
  expect(providerForModel('muse')).toBe('muse');
  for (const model of ['muse','workbuddy','deepseek-chat']) expect(capabilitiesForModel(model)).not.toContain('resume');
  expect(capabilitiesForModel('gpt-6.1-sol')).toContain('resume');
});

for (const [model, Runtime, Client, planner] of [
  ['muse',MuseRuntime,MuseClient,planWithMuse],
  ['workbuddy',WorkBuddyRuntime,WorkBuddyClient,planWithWorkBuddy],
] as const) {
  test(`${model} accepts user-selected read-only review and default-client planning`, async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(),'native-roles-'));
    const submitted: string[] = [];
    const plan = {subtasks:[{id:randomUUID(),code:'DEV',title:'Implement',description:'Implement fixture',stage:'implementation',dependsOn:[],requiredCapabilities:['stream'],acceptanceCriteria:[{id:'check',description:'Check fixture'}]}]};
    let response: object = {approved:true,findings:[]};
    const submit = spyOn(Client.prototype,'submitRun').mockImplementation(async (input: any): Promise<any> => {
      submitted.push(input.task);return {run:{id:'fixture'},created:true};
    });
    const wait = spyOn(Client.prototype,'waitRun').mockImplementation(async (): Promise<any> => ({status:'completed',result:{json:response,text:JSON.stringify(response),artifacts:[]}}));
    try {
      const runtime = new Runtime({workspaceRoot:cwd});
      const id = await runtime.start({cwd,prompt:'Review fixture',sandbox:'read-only',model,effort:'low',outputSchema:{type:'object'}});
      expect((await runtime.wait(id)).status).toBe('succeeded');
      expect(submitted[0]).toContain('Do not modify source files');
      response=plan;
      const draft=await planner({goal:'Plan fixture',cwd,workspaceRoot:cwd,repositoryId:randomUUID(),model,effort:'low'});
      expect(draft.subtasks[0]!.id).toBe(plan.subtasks[0]!.id);
      expect(submitted).toHaveLength(2);
      expect(submitted[1]).toContain('planning-only Agent');
    } finally {submit.mockRestore();wait.mockRestore();await rm(cwd,{recursive:true,force:true});}
  });
}
