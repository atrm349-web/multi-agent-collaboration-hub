import {readFile,writeFile} from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import {buildFrontendAssets} from '/Users/developer/Documents/Codex/2026-11-02/multi-agent-collaboration-hub-ai-agent/work/upstream/agetor/packages/core/frontend.ts';
const root='./';const out='/Users/developer/Documents/Codex/2026-11-02/multi-agent-collaboration-hub-ai-agent/outputs/f02-cross-review';
const manifest=JSON.parse(await readFile(root+'/Antigravity/frontend-deliveries/F02/manifest.json','utf8'));const hashes:Record<string,string>={};const mismatches:string[]=[];
for(const [name,expected] of Object.entries({...manifest.sourceHashes,...manifest.liveNativeBundleHashes})){
 const rel=Object.hasOwn(manifest.sourceHashes,name)?'apps/web/public/'+name:'Antigravity/frontend-deliveries/F02/'+name;
 hashes[rel]=createHash('sha256').update(await readFile(root+'/'+rel)).digest('hex');if(hashes[rel]!==expected)mismatches.push(rel);
}
const token=randomBytes(32).toString('hex');const built=await buildFrontendAssets(root+'/apps/web/public',token);const app=await readFile(root+'/apps/web/public/app.js','utf8');
const nativeApp=await readFile(root+'/Antigravity/frontend-deliveries/F02/app.live-native.js','utf8');const nativeHtml=await readFile(root+'/Antigravity/frontend-deliveries/F02/index.live-native.html','utf8');
const html=built.assets.get('/')!.body.split(built.nonce).join('__HUB_CSP_NONCE__').split(token).join('__HUB_BOOTSTRAP_TOKEN__');
const fn=app.slice(app.indexOf('function sanitizeExecutablePlan('),app.indexOf('\nasync function ensureArtifactContent('));const cleaned=runInNewContext(fn+`;sanitizeExecutablePlan([{id:'A',stage:'implementation',code:'A',dependsOn:[]},{id:'B',stage:'analysis',code:'B',dependsOn:['A']},{id:'C',stage:'implementation',code:'C',dependsOn:['B']}])`);
const apiFn=app.slice(app.indexOf('async function apiRequest('),app.indexOf('\nfunction sanitizeExecutablePlan('));
const response=new Response(JSON.stringify({data:'payload',metadata:'must survive'}),{headers:{'content-type':'application/json'}});
const parsed=await runInNewContext(apiFn+`;apiRequest('/api/v1/artifacts/fixture/content')`,{AUTH_TOKEN:token,makeIdempotencyKey:()=> 'fixture',fetch:async()=>response,JSON,showToast:()=>{},loadConsistentSnapshot:async()=>{}});
const block=app.slice(app.indexOf('  if (target.dataset.downloadArtifact) {'),app.indexOf('  // v0.2 Business Task Control:'));
let downloaded:Blob|undefined;
const node={click(){},remove(){}};
const original=Buffer.from('{"ok":true}');
await runInNewContext('(async()=>{'+block+'})()',{
 target:{dataset:{downloadArtifact:'fixture',filename:'fixture.json'}},ensureArtifactContent:async()=>{},uiState:{artifactContentCache:{fixture:JSON.stringify({ok:true},null,2)}},Blob,
 URL:{createObjectURL:(blob:Blob)=>{downloaded=blob;return 'blob:fixture';},revokeObjectURL:()=>{}},document:{createElement:()=>node,body:{appendChild:()=>{}}},showToast:()=>{}
});
const downloadedBytes=Buffer.from(await downloaded!.arrayBuffer());
const result={downloadReproduction:{originalSha256:createHash('sha256').update(original).digest('hex'),downloadSha256:createHash('sha256').update(downloadedBytes).digest('hex'),bytesPreserved:original.equals(downloadedBytes)},checkedAt:new Date().toISOString(),hashes,manifestMatches:mismatches.length===0,mismatches,bridgeSourceHashes:built.sourceHashes,nativeAppMatches:built.assets.get('/app.js')!.body===nativeApp,nativeHtmlMatches:html===nativeHtml,reproductions:{lostTransitiveDependency:{input:'A -> B(analysis) -> C',actual:cleaned,expectedCDependsOn:['A']},rawJsonArtifactDataLoss:{input:{data:'payload',metadata:'must survive'},actual:parsed}}};
await writeFile(out+'/source-sync.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
