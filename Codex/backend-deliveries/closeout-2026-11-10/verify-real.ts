import {Database} from 'bun:sqlite';
import {mkdtemp,mkdir,writeFile,rm,readdir,readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {resolveDeepSeekApiKey} from '/Users/anyunhong/Desktop/集合agent/backend/agetor/packages/agent-adapters/deepseek/client.ts';
import {HubStore} from '../../work/closeout-2026-11-10/backend/agetor/packages/core/state/store.ts';
import {HubService,resolveRepository} from '../../work/closeout-2026-11-10/backend/agetor/packages/core/hub.ts';

const provider=process.env.HARDENING_PROVIDER ?? "deepseek";
if (provider === "deepseek") process.env.DEEPSEEK_API_KEY=resolveDeepSeekApiKey();
process.env.PATH='/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin:'+process.env.PATH;
const root=await mkdtemp(path.join(tmpdir(),'hub-hardening-real-'));const source=path.join(root,'source');const oracleDir=path.join(root,'owner-acceptance');
await mkdir(source);await mkdir(oracleDir);await mkdir(path.join(root,'state'));process.env.AGETOR_DATA_DIR=path.join(root,'state');
const git=(args:string[])=>execFileSync('/usr/bin/git',args,{cwd:source,encoding:'utf8'}).trim();
git(['init','-q']);git(['config','user.name','Fixture']);git(['config','user.email','fixture@local.invalid']);
await writeFile(path.join(source,'double.js'),'exports.double = n => n;\n');await writeFile(path.join(source,'README.md'),'Implement double(n) = n*2. Preserve CommonJS export double in double.js. Only one implementation step is needed.\n');git(['add','.']);git(['commit','-qm','initial']);
const original=git(['rev-parse','HEAD']);const oracle=path.join(oracleDir,'check.cjs');
await writeFile(oracle,`const assert=require('node:assert');const {double}=require(require('node:path').join(process.cwd(),'double.js'));for(const n of [-3,0,2,5])assert.strictEqual(double(n),n*2);console.log('DOUBLE_4_ASSERTIONS_PASSED');`);
const db=new Database(path.join(root,'state','hub.sqlite'));const store=new HubStore(db);let service:HubService|undefined;
try {
  const repo=await resolveRepository({id:randomUUID(),label:'Real hardening verification',path:source,model:provider === 'codex' ? 'gpt-6.1-sol' : 'deepseek-chat',effort:'low',defaultTestProfileId:'acceptance',testProfiles:[{id:'acceptance',description:'Verify the sole double.js implementation and integrated final result',stages:['implementation','review'],command:[process.execPath,oracle],readPaths:[oracleDir],timeoutMs:15000}]});
  service=new HubService(store,{root,repositories:[repo],maxConcurrency:1});
  const task=await service.create({title:'Double fixture',goal:'Implement double(n)=n*2 in CommonJS double.js. Create exactly one implementation step using testProfileId acceptance. Do not create analysis, documentation or custom review steps. The coordinator adds final review.',repositoryId:repo.id,acceptanceCriteria:[{id:'final-double',description:'Double positive, zero and negative numbers',testProfileId:'acceptance'}]});
  const deadline=Date.now()+180000;
  while(Date.now()<deadline && !['waiting_approval','failed'].includes(store.get('task',task.id).status)) await Bun.sleep(200);
  const before=store.get('task',task.id);
  if(before.status!=='waiting_approval') throw new Error(JSON.stringify({stage:'before-approval',status:before.status,error:before.error}));
  const approval=store.list('approval',task.id).find(a=>a.status==='pending')!;
  await service.decideApproval(approval.id,{expectedVersion:approval.version,decision:'approve',actionDigest:approval.actionDigest,comment:'Owner-authorized disposable verification fixture'});
  const artifacts=store.list('artifact',task.id);let verified=0;
  for(const artifact of artifacts){const bytes=await service.artifact(artifact.id);if(createHash('sha256').update(bytes.bytes).digest('hex')!==artifact.sha256)throw new Error('Artifact hash mismatch');verified++;}
  const result={mode:`real ${provider} planner/developer/reviewer; official OS test sandbox; disposable repository`,status:store.get('task',task.id).status,subtasks:store.list('subtask',task.id).map(s=>({code:s.code,status:s.status,attempt:s.attempt})),runs:store.list('run',task.id).map(r=>({provider:r.provider,model:r.model,status:r.status,executionKind:r.executionKind})),validations:store.list('validation',task.id).map(v=>({criterionId:v.criterionId,status:v.status,exitCode:v.exitCode})),verifiedArtifacts:verified,originalRepositoryUnchanged:git(['rev-parse','HEAD'])===original && git(['status','--porcelain'])===''};
  console.log(JSON.stringify(result,null,2));
} catch (error) {
  const directory=path.join(root,'state','planning');
  const logs=await readdir(directory).catch(()=>[]);
  const traces=await Promise.all(logs.filter(name=>name.endsWith('.jsonl')).map(async(name)=>({file:name,tail:(await readFile(path.join(directory,name),'utf8')).slice(-6000)})));
  await writeFile(new URL(`./real-${provider}-failure.json`,import.meta.url),JSON.stringify({provider,error:String(error),traces},null,2));
  throw error;
} finally {await service?.close();db.close();await rm(root,{recursive:true,force:true});}
