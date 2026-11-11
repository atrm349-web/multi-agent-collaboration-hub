import {Database} from 'bun:sqlite';
import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises';
import {execFileSync,spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {HubStore} from '../../work/closeout-2026-11-10/backend/agetor/packages/core/state/store.ts';
import {HubService,resolveRepository} from '../../work/closeout-2026-11-10/backend/agetor/packages/core/hub.ts';
import {processGroupExists} from '../../work/closeout-2026-11-10/backend/agetor/packages/core/process-identity.ts';

const mode=process.argv[2];
if (mode === 'start' || mode === 'recover') {
  const root=process.argv[3]!;
  process.env.AGETOR_DATA_DIR=path.join(root,'state');
  process.env.PATH='/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin:'+process.env.PATH;
  const repo=await resolveRepository({id:'11111111-2222-4333-8444-555555555555',label:'Crash fixture',path:path.join(root,'source'),defaultTestProfileId:'sleep',testProfiles:[{id:'sleep',command:['/Applications/Xcode.app/Contents/Developer/usr/bin/python3','-I','-B','-c','import time; time.sleep(30)'],timeoutMs:45000}]});
  const db=new Database(path.join(root,'state','hub.sqlite'));const store=new HubStore(db);
  const service=new HubService(store,{root,repositories:[repo],spawn:(_command,_args,options)=>spawn(process.execPath,['-e',`process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'thread.started',thread_id:'${randomUUID()}'}));console.log(JSON.stringify({type:'turn.completed'}))})`],options)});
  if(mode==='start') await service.create({title:'Crash fixture',goal:'hold test',repositoryId:repo.id,acceptanceCriteria:[{id:'final',description:'sleep'}],plannedSubtasks:[{id:randomUUID(),code:'IMPL',title:'hold',description:'hold',stage:'implementation',dependsOn:[],requiredCapabilities:['stream'],acceptanceCriteria:[{id:'step',description:'sleep'}]}]});
  if(mode==='recover') {
    const deadline=Date.now()+10000;
    while(Date.now()<deadline && store.validationRecovery().length) { await service.tick(); await Bun.sleep(50); }
    await writeFile(path.join(root,'recovery.json'),JSON.stringify({tasks:service.page('task').items,claims:store.validationRecovery()}));
    await service.close();db.close();process.exit(0);
  }
  await new Promise(()=>{});
} else {
  const root=await mkdtemp(path.join(tmpdir(),'hub-crash-verified-'));
  await mkdir(path.join(root,'source'));await mkdir(path.join(root,'state'));
  const git=(args:string[])=>execFileSync('/usr/bin/git',args,{cwd:path.join(root,'source'),stdio:'ignore'});
  git(['init','-q']);git(['config','user.name','Fixture']);git(['config','user.email','fixture@local.invalid']);
  await writeFile(path.join(root,'source','file.txt'),'baseline');git(['add','.']);git(['commit','-qm','initial']);
  let child:ReturnType<typeof spawn>|undefined; let testPid:number|undefined;
  try {
    child=spawn(process.execPath,[import.meta.path,'start',root],{stdio:['ignore','ignore','pipe']});
    let stderr=''; child.stderr?.on('data',chunk=>{stderr+=chunk.toString()});
    const stopped=new Promise(resolve=>child!.once('close',resolve));
    const deadline=Date.now()+15000;
    while(Date.now()<deadline) {
      try {
        const db=new Database(path.join(root,'state','hub.sqlite'),{readonly:true});
        const claim=db.query<{process_group_id:number},[]>("SELECT process_group_id FROM hub_validation_claims WHERE process_group_id IS NOT NULL").get();
        db.close(); if(claim) {testPid=claim.process_group_id;break;}
      } catch {}
      await Bun.sleep(50);
    }
    if(!testPid) {
      const db=new Database(path.join(root,'state','hub.sqlite'),{readonly:true});
      const states=db.query("SELECT kind,status,data FROM hub_entities WHERE kind IN ('task','subtask','run')").all();db.close();
      throw new Error('No registered test process was observed '+stderr+' '+JSON.stringify(states));
    }
    child.kill('SIGKILL');await stopped;
    const recovered=spawn(process.execPath,[import.meta.path,'recover',root],{stdio:['ignore','ignore','pipe']});
    const exit=await new Promise(resolve=>recovered.once('close',resolve));
    const evidence=JSON.parse(await readFile(path.join(root,'recovery.json'),'utf8'));
    if(exit!==0 || evidence.tasks[0].status!=='failed' || evidence.claims.length || processGroupExists(testPid)) throw new Error('Crash recovery invariant failed');
    console.log(JSON.stringify({mode:'real HubService/Git/SQLite/official OS test sandbox; controlled model worker',controllerKilledDuring:'registered test',taskStatus:evidence.tasks[0].status,errorCode:evidence.tasks[0].error?.code,remainingValidationClaims:evidence.claims.length,testProcessGroupStopped:true},null,2));
  } finally {
    if(child?.exitCode===null) child.kill('SIGKILL');
    if(testPid) {try{process.kill(-testPid,'SIGKILL');}catch{}}
    await rm(root,{recursive:true,force:true});
  }
}
