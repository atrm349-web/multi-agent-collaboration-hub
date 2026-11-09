import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ClaudeRuntime } from '/Users/anyunhong/Desktop/集合agent/backend/agetor/packages/agent-adapters/claude/runtime.ts';

const root = await mkdtemp(path.join(os.tmpdir(), 'hub-review-probe-'));
const findings: unknown[] = [];
try {
  for (const scenario of ['normal-review', 'readonly-write', 'symlink-escape', 'malformed-review']) {
    const cwd = path.join(root, scenario);
    await mkdir(cwd);
    const outside = path.join(root, `${scenario}-outside.txt`);
    await writeFile(outside, 'original');
    if (scenario === 'symlink-escape') await symlink(outside, path.join(cwd, 'linked.txt'));
    let calls = 0;
    const runtime = new ClaudeRuntime({ workspaceRoot: root });
    (runtime as any).client = {
      isConfigured: true,
      async createMessage() {
        calls++;
        if (calls === 1 && ['readonly-write', 'symlink-escape'].includes(scenario)) {
          return { stop_reason: 'tool_use', content: [{type:'tool_use', id:'fixture-tool', name:'write_file', input:{path:scenario === 'symlink-escape' ? 'linked.txt' : 'unexpected.txt', content:'modified'}}] };
        }
        return {stop_reason:'end_turn',content:[{type:'text',text:scenario === 'malformed-review' ? 'not valid JSON' : '{"approved":true,"findings":[]}'}]};
      }
    };
    const runId = await runtime.start({cwd, prompt:'Controlled local probe', sandbox:scenario === 'symlink-escape' ? 'workspace-write' : 'read-only', model:'claude-fixture',effort:'low',outputSchema:{type:'object'}});
    const result = await runtime.wait(runId);
    const logs = runtime.getLogs(runId);
    const expectedAnswerEvents = logs.filter(log => log.event?.item?.type === 'agent_message').length;
    findings.push({scenario,status:result.status,result:result.result,expectedAnswerEvents,
      readonlyFileCreated:scenario === 'readonly-write' ? await readFile(path.join(cwd,'unexpected.txt'),'utf8').catch(()=>null) : undefined,
      outsideFileContent:scenario === 'symlink-escape' ? await readFile(outside,'utf8') : undefined});
  }
  console.log(JSON.stringify({mode:'local fake provider; no API requests or credentials',findings},null,2));
} finally {
  await rm(root,{recursive:true,force:true});
}
