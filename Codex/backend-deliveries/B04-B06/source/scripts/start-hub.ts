import {randomBytes} from 'node:crypto';
import {mkdir,readFile,realpath,writeFile,chmod,lstat} from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {HubService,resolveRepository} from '../packages/core/hub.ts';
import {HubStore} from '../packages/core/state/store.ts';
import {createHubHandler} from '../packages/core/http.ts';
import {buildFrontendAssets} from '../packages/core/frontend.ts';

// Configuration is local-owner input; the HTTP API cannot register paths or commands.
const configPath=process.argv[2];
if(!configPath)throw new Error('Usage: bun scripts/start-hub.ts /absolute/path/config.json');
const config=JSON.parse(await readFile(configPath,'utf8'));
if(!path.isAbsolute(config.root)||!Array.isArray(config.repositories))throw new Error('Invalid runtime root/repositories');
await mkdir(config.root,{recursive:true,mode:0o700});const root=await realpath(config.root);
if(spawnSync('/usr/bin/git',['-C',root,'rev-parse','--show-toplevel']).status===0)throw new Error('Runtime root must be outside any Git checkout');
const port=config.port??4321;if(!Number.isSafeInteger(port)||port<1024||port>65535)throw new Error('Invalid port');
const state=path.join(root,'state');await mkdir(state,{recursive:true,mode:0o700});if((await lstat(state)).isSymbolicLink())throw new Error('State directory cannot be a symlink');await chmod(state,0o700);
process.env.AGETOR_DATA_DIR=state;
const cli=Bun.which('codex');if(!cli)throw new Error('Official Codex CLI is required');
const auth=spawnSync(cli,['login','status'],{encoding:'utf8',timeout:15000});
if(auth.status!==0)throw new Error('Existing Codex login is unavailable; no API fallback is enabled');
const repositories=await Promise.all(config.repositories.map(resolveRepository));
const token=randomBytes(32).toString('hex');
const frontend=config.frontendDir?await buildFrontendAssets(config.frontendDir,token):null;
const {db}=await import('../src/bun/db.ts');const service=new HubService(new HubStore(db),{root,repositories});
const origin=`http://127.0.0.1:${port}`;const api=createHubHandler({service,token,port});
const server=Bun.serve({hostname:'127.0.0.1',port,idleTimeout:120,maxRequestBodySize:256*1024,fetch:async(request)=>{
 const url=new URL(request.url);
 if(url.origin!==origin || (request.headers.has('host')&&request.headers.get('host')!==url.host))return new Response('Forbidden',{status:403});
 if(url.pathname.startsWith('/api/'))return api(request);
 if(request.method!=='GET'||url.search||url.hash || request.headers.get('sec-fetch-site')==='cross-site' || (request.headers.has('origin')&&request.headers.get('origin')!==origin))return new Response('Forbidden',{status:403});
 const asset=frontend?.assets.get(url.pathname);if(!asset)return new Response('Not found',{status:404});
 return new Response(asset.body,{headers:{'content-type':asset.type,'cache-control':'no-store','x-content-type-options':'nosniff','x-frame-options':'DENY','cross-origin-resource-policy':'same-origin','referrer-policy':'no-referrer','content-security-policy':`default-src 'self'; script-src 'nonce-${frontend!.nonce}'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`}});
}});
await writeFile(path.join(state,'credentials.json'),JSON.stringify({origin,token,pid:process.pid}),{mode:0o600});await chmod(path.join(state,'credentials.json'),0o600);
console.log(`Hub ready: ${origin}; concurrency=1; credentials stored locally (0600)`);
let stopping=false;async function stop(){if(stopping)return;stopping=true;await service.close();await server.stop(true);db.close();process.exit(0);}
process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
