import {readFile,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
const base='/var/folders/5p/_hdrwwks2bv4q63hr_d2x4980000gn/T/hub-platform-live-kkhr1E';
const previous=JSON.parse(await readFile(base+'/evidence.json','utf8'));
const proc=spawn(process.execPath,['scripts/start-hub.ts',base+'/config.json'],{stdio:['ignore','pipe','pipe']});let output='';proc.stdout.on('data',b=>output+=b);proc.stderr.on('data',b=>output+=b);
try{
 for(let i=0;i<100&&!output.includes('Hub ready:');i++){if(proc.exitCode!==null)throw new Error(output);await Bun.sleep(100);}
 const {origin,token}=JSON.parse(await readFile(base+'/runtime/state/credentials.json','utf8'));
 const get=async(p:string)=>{const r=await fetch(origin+'/api/v1/'+p,{headers:{authorization:'Bearer '+token}});const j=await r.json();if(!r.ok)throw new Error(JSON.stringify(j));return j.data;};
 const taskId=previous.detail.task.id;const detail=await get('tasks/'+taskId);if(detail.task.status!=='waiting_approval')throw new Error('Persisted state did not recover');
 const approvals=await get('tasks/'+taskId+'/approvals');const a=approvals.items.find((x:any)=>x.status==='pending');
 const r=await fetch(origin+'/api/v1/approvals/'+a.id+'/decision',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json','idempotency-key':crypto.randomUUID()},body:JSON.stringify({expectedVersion:a.version,decision:'approve',actionDigest:a.actionDigest,comment:'Authorized local test fixture final acceptance'})});if(!r.ok)throw new Error(await r.text());
 const final=await get('tasks/'+taskId);if(final.task.status!=='succeeded')throw new Error('Not succeeded');
 const runs=await get('tasks/'+taskId+'/runs');const validations=await get('tasks/'+taskId+'/validations');
 const artifact=(await get('tasks/'+taskId+'/artifacts')).items.find((x:any)=>x.name==='clamp.py');const source=await fetch(origin+'/api/v1/artifacts/'+artifact.id+'/content',{headers:{authorization:'Bearer '+token}});const code=await source.text();
 const proof={...previous,success:true,priorError:previous.error,error:null,final,runs,validations,code,restartRecovered:true,endedAt:new Date().toISOString()};await writeFile(base+'/final-evidence.json',JSON.stringify(proof,null,2));console.log(JSON.stringify({status:final.task.status,runs:runs.items.map((x:any)=>({id:x.id,session:x.providerSessionId,status:x.status})),validations:validations.items.map((x:any)=>({status:x.status,exitCode:x.exitCode})),code}));
}finally{proc.kill('SIGTERM');await new Promise<void>(resolve=>{if(proc.exitCode!==null)resolve();else proc.once('exit',()=>resolve());});}
