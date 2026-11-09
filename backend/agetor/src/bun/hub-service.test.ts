import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {HubStore} from '../../packages/core/state/store.ts';
import {HubService,resolveRepository} from '../../packages/core/hub.ts';
import {extractReviewJson} from '../../packages/core/quality.ts';
import {createHubHandler} from '../../packages/core/http.ts';

test('extractReviewJson parses pure JSON, fenced JSON, and JSON preceded by reviewer analysis text', () => {
  expect(extractReviewJson('{"approved":true,"findings":[]}')).toEqual({ approved: true, findings: [] });
  expect(extractReviewJson('```json\n{"approved":false,"findings":["fix bug"]}\n```')).toEqual({ approved: false, findings: ['fix bug'] });
  expect(extractReviewJson('我来审查所有文件。\n现在所有测试结果都清楚了。\n{"approved":false,"findings":["1. fix test_formatter.js","2. pass startDate"]}')).toEqual({
    approved: false,
    findings: ['1. fix test_formatter.js', '2. pass startDate']
  });
  expect(() => extractReviewJson('not json at all')).toThrow('ACCEPTANCE_FAILED: reviewer returned invalid JSON');
  expect(() => extractReviewJson('{"approved":"yes"}')).toThrow('ACCEPTANCE_FAILED: malformed review');
});

for (const scenario of ['approve','tamper','reject','expiry','cancel','rework','test-mutates'] as const) test('HTTP durable pipeline and final gate: '+scenario,async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'hub-service-'));const old=process.env.AGETOR_DATA_DIR;
 const repository=path.join(root,'source');await mkdir(repository);await mkdir(path.join(root,'state'));process.env.AGETOR_DATA_DIR=path.join(root,'state');
 execFileSync('/usr/bin/git',['init','-q',repository]);execFileSync('/usr/bin/git',['-C',repository,'config','user.name','Fixture']);execFileSync('/usr/bin/git',['-C',repository,'config','user.email','fixture@example.invalid']);
 await writeFile(path.join(repository,'answer.txt'),'initial\n');execFileSync('/usr/bin/git',['-C',repository,'add','.']);execFileSync('/usr/bin/git',['-C',repository,'commit','-qm','fixture']);
 const db=new Database(path.join(root,'state','hub.sqlite'));const store=new HubStore(db);let service:HubService|undefined;let executions=0;let checks=0;
 try{
 const repo=await resolveRepository({id:randomUUID(),label:'Fixture',path:repository,defaultTestProfileId:'accept',testProfiles:[{id:'accept',command:['/usr/bin/true'],timeoutMs:1000}]});
 service=new HubService(store,{root,repositories:[repo],spawn:(_command,_args,options)=>{executions++;return spawn(process.execPath,['--eval',`process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'thread.started',thread_id:${JSON.stringify(randomUUID())}}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'{"approved":true,"findings":[]}'}}));console.log(JSON.stringify({type:'turn.completed'}));});`],options);},testRunner:async(_root,_cwd,p)=>{if(scenario==='test-mutates')await writeFile(path.join(_cwd,'answer.txt'),'changed by test');return ({profileId:p.id,exitCode:scenario==='rework'&&checks++===0?1:0,stdout:'fixture test',stderr:'',timedOut:false,cancelled:false});}});
 const token='a'.repeat(64);const handler=createHubHandler({service,token,port:4321});
 const post=async(route:string,body:unknown,key=randomUUID())=>handler(new Request('http://127.0.0.1:4321/api/v1/'+route,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json','idempotency-key':key},body:JSON.stringify(body)}));
 const id=randomUUID();const payload={title:'Fixture',goal:'Keep the fixture intact',repositoryId:repo.id,acceptanceCriteria:[{id:'task-check',description:'Registered acceptance'}],plannedSubtasks:[{id,code:'IMPLEMENT',title:'Implement',description:'Inspect fixture',stage:'implementation',dependsOn:[],requiredCapabilities:['stream'],acceptanceCriteria:[{id:'step-check',description:'Registered acceptance'}]}]};
 const key=randomUUID();const response=await post('tasks',payload,key);expect(response.status).toBe(201);const created=(await response.json()).data;
 expect((await (await post('tasks',payload,key)).json()).data.id).toBe(created.id);
 const deadline=Date.now()+15000;while(Date.now()<deadline&& !['waiting_approval','failed'].includes(store.get('task',created.id).status))await Bun.sleep(30);
 if(scenario==='test-mutates'){expect(store.get('task',created.id).status).toBe('failed');expect(store.get('task',created.id).error?.message).toContain('modified the frozen source');return;}
 expect(store.get('task',created.id).error).toBeNull();expect(store.get('task',created.id).status).toBe('waiting_approval');expect(executions).toBe(scenario==='rework'?3:2);expect(service.snapshot().selectedTask?.subtasks.length).toBe(2);
 if(scenario==='rework'){expect(store.get('subtask',id).attempt).toBe(2);expect(store.list('validation',created.id).some(v=>v.status==='failed')).toBe(true);}
 const approval=store.list('approval',created.id)[0]!;expect(approval.status).toBe('pending');
 const stale=await post(`approvals/${approval.id}/decision`,{expectedVersion:approval.version,decision:'approve',actionDigest:'b'.repeat(64)});expect(stale.status).toBe(409);
 expect(store.get('task',created.id).status).toBe('waiting_approval');
 if(scenario==='tamper'){
 const artifact=store.get('artifact',approval.artifactRefs[0]!);await writeFile(path.join(root,'state','artifacts',artifact.id,'blob'),'corrupted');
 const result=await post(`approvals/${approval.id}/decision`,{expectedVersion:approval.version,decision:'approve',actionDigest:approval.actionDigest});expect(result.status).not.toBe(200);expect(store.get('approval',approval.id).status).toBe('invalidated');expect(store.get('task',created.id).status).not.toBe('succeeded');return;
 }
 if(scenario==='reject'){
 const result=await post(`approvals/${approval.id}/decision`,{expectedVersion:approval.version,decision:'reject',actionDigest:approval.actionDigest});expect(result.status).toBe(200);expect(store.get('task',created.id).status).toBe('waiting_approval');expect(store.get('task',created.id).pendingApprovalCount).toBe(0);return;
 }
 if(scenario==='expiry'){
 const expired=store.put('approval',{...approval,expiresAt:new Date(0).toISOString()},approval.version);
 const result=await post(`approvals/${approval.id}/decision`,{expectedVersion:expired.version,decision:'approve',actionDigest:approval.actionDigest});expect(result.status).toBe(409);expect(store.get('approval',approval.id).status).toBe('expired');return;
 }
 if(scenario==='cancel'){
 const task=store.get('task',created.id);expect((await post(`tasks/${task.id}/cancel`,{expectedVersion:task.version,reason:'test'})).status).toBe(202);await service.tick();expect(store.get('task',task.id).status).toBe('cancelled');expect(store.get('approval',approval.id).status).toBe('invalidated');return;
 }
 const approved=await post(`approvals/${approval.id}/decision`,{expectedVersion:approval.version,decision:'approve',actionDigest:approval.actionDigest});expect(approved.status).toBe(200);
 expect(store.get('task',created.id).status).toBe('succeeded');expect(service.snapshot(created.id).selectedTask?.task.id).toBe(created.id);
 expect(execFileSync('/usr/bin/git',['-C',repository,'status','--porcelain']).toString()).toBe('');
 }finally{await service?.close();db.close();await rm(root,{recursive:true,force:true});if(old===undefined)delete process.env.AGETOR_DATA_DIR;else process.env.AGETOR_DATA_DIR=old;}
},20000);
