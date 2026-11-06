import {readFile,writeFile} from 'node:fs/promises';
import {randomBytes,randomUUID,createHash,webcrypto} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import assert from 'node:assert/strict';
import {buildFrontendAssets} from '../../work/upstream/agetor/packages/core/frontend.ts';
import {validatePlan} from '../../work/upstream/agetor/packages/core/planner.ts';
const shared='./';const folder=shared+'/Antigravity/frontend-deliveries/F02-r2';
const app=await readFile(shared+'/apps/web/public/app.js','utf8');const token=randomBytes(32).toString('hex');const bridge=await buildFrontendAssets(shared+'/apps/web/public',token);
assert.equal(bridge.assets.get('/app.js')!.body,await readFile(folder+'/app.live-native.js','utf8'));
assert.equal(bridge.assets.get('/')!.body.split(bridge.nonce).join('__CSP_NONCE__').split(token).join('__BOOTSTRAP_TOKEN__'),await readFile(folder+'/index.live-native.html','utf8'));
let fixture=Buffer.from('{"data":"payload","metadata":"must survive"}');let status=200;let expected=createHash('sha256').update(fixture).digest('hex');
const code=app.slice(app.indexOf('async function computeSha256Hex'),app.indexOf('\nglobalThis.apiRequest ='));
const f=runInNewContext(code+';({apiRequest,fetchArtifactRaw,formatArtifactPreviewFromRaw,sanitizeExecutablePlan,inspectDraftPlanCompatibility})',{crypto:webcrypto,TextDecoder,TextEncoder,Uint8Array,AUTH_TOKEN:token,makeIdempotencyKey:()=> 'fixture',showToast:()=>{},loadConsistentSnapshot:async()=>{},uiState:{artifactsPage:{items:[{id:'fixture',get sha256(){return expected;}}]}},fetch:async()=>new Response(fixture,{status,headers:{'content-type':'application/json'}})});
assert.deepEqual(JSON.parse(await f.apiRequest('/api/v1/artifacts/fixture/content')),{data:'payload',metadata:'must survive'});
const raw=await f.fetchArtifactRaw('fixture');assert.equal(Buffer.from(raw.bytes).equals(fixture),true);
expected='0'.repeat(64);await assert.rejects(f.fetchArtifactRaw('fixture'),/ARTIFACT_INTEGRITY_MISMATCH/);status=404;fixture=Buffer.from('{"error":{"code":"NOT_FOUND","message":"fixture"}}');await assert.rejects(f.fetchArtifactRaw('fixture'),/NOT_FOUND/);
function step(stage:string,code:string,dependsOn:string[]=[],id=randomUUID()){return {id,stage,code,title:code,description:code,dependsOn,requiredCapabilities:['stream'],acceptanceCriteria:[{id:'ac-'+code,description:code}]};}
const a=step('implementation','A');const b=step('analysis','B',[a.id]);const c=step('implementation','C',[b.id]);const d=step('documentation','D',[b.id]);
const chain=f.sanitizeExecutablePlan([a,b,c]);assert.equal(JSON.stringify(chain[1].dependsOn),JSON.stringify([a.id]));assert.equal(chain[1].acceptanceCriteria.some((x:any)=>x.id==='ac-B'),true);validatePlan(chain);
assert.throws(()=>f.sanitizeExecutablePlan([b]),/INVALID_INPUT/);assert.equal(f.inspectDraftPlanCompatibility([a,b,c]).isDirectlyExecutable,false);
let branchingError:string|null=null;const branching=f.sanitizeExecutablePlan([a,b,c,d]);try{validatePlan(branching);}catch(e){branchingError=String(e);}
const leaf=f.sanitizeExecutablePlan([a,b]);const leafCriterionPreserved=leaf.some((s:any)=>s.acceptanceCriteria.some((ac:any)=>ac.id==='ac-B'));
const results={checkedAt:new Date().toISOString(),bridge:{sourceHashes:bridge.sourceHashes,nativeAppMatches:true,nativeHtmlMatches:true},originalReproductions:{rawJsonDataPreserved:true,rawBytesPreserved:true,hashMismatchRejected:true,httpErrorRejected:true,chainDependenciesPreserved:true,chainCriteriaPreserved:true,emptyExecutableRejected:true,directInvalidPlanRejected:true},additionalPlanChecks:{branchingBackendValidationError:branchingError,branching,terminalRemovedCriterionPreserved:leafCriterionPreserved}};
await writeFile('outputs/f02-r2-review/focused-results.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results.additionalPlanChecks,null,2));
