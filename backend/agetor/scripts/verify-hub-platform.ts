import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync,spawn} from 'node:child_process';
const base=await mkdtemp(path.join(tmpdir(),'hub-platform-live-'));const root=path.join(base,'runtime');const source=path.join(base,'source');await mkdir(source);await mkdir(root);
execFileSync('/usr/bin/git',['init','-q',source]);execFileSync('/usr/bin/git',['-C',source,'config','user.name','Hub Fixture']);execFileSync('/usr/bin/git',['-C',source,'config','user.email','fixture@example.invalid']);
await writeFile(path.join(source,'clamp.py'),'def clamp(value, low, high):\n    return value\n');execFileSync('/usr/bin/git',['-C',source,'add','.']);execFileSync('/usr/bin/git',['-C',source,'commit','-qm','fixture']);
const port=44321;const repositoryId=randomUUID();const config=path.join(base,'config.json');
await writeFile(config,JSON.stringify({root,port,frontendDir:path.resolve(__dirname, '../../../apps/web/public'),repositories:[{id:repositoryId,label:'Live clamp fixture',path:source,defaultTestProfileId:'clamp',testProfiles:[{id:'clamp',command:['/Applications/Xcode.app/Contents/Developer/usr/bin/python3','-I','-B','-c',"import runpy; f=runpy.run_path('clamp.py')['clamp']; assert [f(x,0,10) for x in [-1,0,5,10,11]]==[0,0,5,10,10]; print('CLAMP_ACCEPTANCE_PASSED')"],timeoutMs:15000}]}]}));
const processHandle=spawn(process.execPath,['scripts/start-hub.ts',config],{stdio:['ignore','pipe','pipe']});let output='';processHandle.stdout.on('data',b=>{output+=b;});processHandle.stderr.on('data',b=>{output+=b;});
let taskId:string|undefined;const evidence:Record<string,unknown>={execution:'real',base,api:'real-http',model:'official-codex-cli',startedAt:new Date().toISOString()};
try{
 let credentials:{token:string;origin:string}|undefined;
 for(let i=0;i<150;i++){try{credentials=JSON.parse(await readFile(path.join(root,'state','credentials.json'),'utf8'));break;}catch{if(processHandle.exitCode!==null)throw new Error(output);await Bun.sleep(100);}}
 if(!credentials)throw new Error('Startup timed out: '+output);
 const {origin,token}=credentials;
 const request=async(route:string,body?:unknown)=>{const response=await fetch(origin+'/api/v1/'+route,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,...(body===undefined?{}:{'content-type':'application/json','idempotency-key':randomUUID()})},...(body===undefined?{}:{body:JSON.stringify(body)})});const json=await response.json();if(!response.ok)throw new Error(JSON.stringify(json));return json.data;};
 if((await fetch(origin+'/api/v1/tasks')).status!==401)throw new Error('Authentication failed');
 const html=await(await fetch(origin)).text();if(!html.includes('__HUB_BOOT__'))throw new Error('Frontend boot missing');
 evidence.frontendSourceHashes=(await (await import('../packages/core/frontend.ts')).buildFrontendAssets(path.resolve(__dirname, '../../../apps/web/public'),token)).sourceHashes;
 const plan=await request('tasks/decompose',{repositoryId,goal:'Implement clamp(value, low, high) in clamp.py returning low when below low and high when above high, otherwise value; assume low <= high. Use exactly one implementation subtask, no other stages; coordinator adds final independent review. Use criterion id clamp-correct with registered profile clamp. No docs or additional files.'});
 evidence.plan=plan;
 const task=await request('tasks',{repositoryId,title:'Real clamp pipeline',goal:'Correct clamp boundaries for low <= high; implement only clamp.py.',acceptanceCriteria:[{id:'clamp-final',description:'Clamp boundary test passes',testProfileId:'clamp'}],plannedSubtasks:plan.subtasks});taskId=task.id;
 let detail;const until=Date.now()+300000;
 do{detail=await request('tasks/'+task.id);if(['waiting_approval','failed','cancelled','timed_out'].includes(detail.task.status))break;await Bun.sleep(1000);}while(Date.now()<until);
 evidence.detail=detail;
 if(detail.task.status!=='waiting_approval')throw new Error('Pipeline did not reach approval: '+JSON.stringify(detail.task));
 const approvals=await request('tasks/'+task.id+'/approvals');const approval=approvals.items.find((a:any)=>a.status==='pending');if(!approval)throw new Error('No final approval');
 await request('approvals/'+approval.id+'/decision',{expectedVersion:approval.version,decision:'approve',actionDigest:approval.actionDigest,comment:'Authorized local fixture acceptance test'});
 const final=await request('tasks/'+task.id);if(final.task.status!=='succeeded')throw new Error('Final gate failed');evidence.final=final;evidence.success=true;
 const original=execFileSync('/usr/bin/git',['-C',source,'status','--porcelain']).toString();if(original)throw new Error('Source changed');evidence.sourceUnchanged=true;
 console.log('REAL_HUB_PLATFORM_VERIFIED '+base);
}catch(error){evidence.success=false;evidence.error=String(error);console.error(String(error));process.exitCode=1;
}finally{processHandle.kill('SIGTERM');await new Promise<void>(resolve=>{if(processHandle.exitCode!==null)resolve();else processHandle.once('exit',()=>resolve());});evidence.serverOutput=output;evidence.endedAt=new Date().toISOString();await writeFile(path.join(base,'evidence.json'),JSON.stringify(evidence,null,2));console.log('Evidence: '+path.join(base,'evidence.json'));}
