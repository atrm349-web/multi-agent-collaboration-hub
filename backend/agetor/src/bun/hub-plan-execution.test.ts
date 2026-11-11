import {test, expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {HubStore} from '../../packages/core/state/store.ts';
import {HubService,resolveRepository} from '../../packages/core/hub.ts';
import {runTestProfile} from '../../packages/core/workspace.ts';

test('raw planner DAG executes partial profiles then final integrated oracle', async () => {
  const root=await mkdtemp(path.join(tmpdir(),'hub-plan-execution-'));
  const old=process.env.AGETOR_DATA_DIR;
  const source=path.join(root,'source'); await mkdir(source); await mkdir(path.join(root,'state'));
  process.env.AGETOR_DATA_DIR=path.join(root,'state');
  const git=(args:string[])=>execFileSync('/usr/bin/git',args,{cwd:source,stdio:'ignore'});
  git(['init','-q']);git(['config','user.name','Fixture']);git(['config','user.email','fixture@local.invalid']);
  await writeFile(path.join(source,'answer.txt'),'baseline');git(['add','.']);git(['commit','-qm','initial']);
  const db=new Database(path.join(root,'state','hub.sqlite')); const store=new HubStore(db);
  let service:HubService|undefined;
  try {
    const profiles=['circle','rect','all'].map(id=>({id,command:['/usr/bin/true'],timeoutMs:1000,description:id,stages:['implementation','review']}));
    const repo=await resolveRepository({id:randomUUID(),label:'Fixture',path:source,defaultTestProfileId:'all',testProfiles:profiles});
    const a=randomUUID(),b=randomUUID(); const tested:string[]=[];
    const steps=[{id:a,code:'A',title:'A',description:'A',stage:'implementation' as const,dependsOn:[],requiredCapabilities:['stream' as const],acceptanceCriteria:[{id:'a',description:'circle only',testProfileId:'circle'}]},
      {id:b,code:'B',title:'B',description:'B',stage:'implementation' as const,dependsOn:[a],requiredCapabilities:['stream' as const],acceptanceCriteria:[{id:'b',description:'rectangle only',testProfileId:'rect'}]}];
    service=new HubService(store,{root,repositories:[repo],planner:async()=>({id:randomUUID(),repositoryId:repo.id,goal:'raw DAG',executionMode:'live',subtasks:steps}),
      spawn:(_command,args,options)=>spawn(process.execPath,['-e',`process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'thread.started',thread_id:'${randomUUID()}'}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'{"approved":true,"findings":[]}'}}));console.log(JSON.stringify({type:'turn.completed'}))})`],options),
      testRunner:async(_root,_cwd,profile)=>{tested.push(profile.id);return {profileId:profile.id,exitCode:0,stdout:'pass',stderr:'',timedOut:false,cancelled:false};}});
    const task=await service.create({title:'Raw DAG',goal:'raw DAG',repositoryId:repo.id,acceptanceCriteria:[{id:'final',description:'integrated'}]});
    const deadline=Date.now()+10000;
    while(Date.now()<deadline && !['waiting_approval','failed'].includes(store.get('task',task.id).status)) await Bun.sleep(30);
    expect(store.get('task',task.id).status).toBe('waiting_approval');
    expect(tested).toEqual(['circle','rect','all']);
    expect(store.get('subtask',a).acceptanceCriteria[0]?.testProfileId).toBe('circle');
  } finally {await service?.close();db.close();await rm(root,{recursive:true,force:true});if(old===undefined)delete process.env.AGETOR_DATA_DIR;else process.env.AGETOR_DATA_DIR=old;}
});
