import { randomBytes } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile, chmod, lstat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { HubService, resolveRepository } from '../packages/core/hub.ts';
import { HubStore } from '../packages/core/state/store.ts';
import { createHubHandler } from '../packages/core/http.ts';
import { buildFrontendAssets } from '../packages/core/frontend.ts';

// 1. Locate project root and configuration
const projectRoot = path.resolve(__dirname, '../../..');
const defaultConfigPath = path.join(projectRoot, 'config/hub-config.json');
const configArg = process.argv[2];
const configPath = configArg
  ? (path.isAbsolute(configArg) ? configArg : path.resolve(process.cwd(), configArg))
  : (existsSync(defaultConfigPath) ? defaultConfigPath : null);

let config: any = {};
if (configPath && existsSync(configPath)) {
  try {
    config = JSON.parse(await readFile(configPath, 'utf8'));
  } catch (err) {
    console.error(`Warning: Failed to parse ${configPath}, using defaults.`, err);
  }
}

// 2. Resolve runtime root outside of git checkouts
let runtimeRoot = config.root || process.env.HUB_RUNTIME_DIR;
if (!runtimeRoot || !path.isAbsolute(runtimeRoot)) {
  runtimeRoot = path.join(os.homedir(), '.agent-hub-runtime');
}

// Ensure runtime root exists
await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
let root = await realpath(runtimeRoot);

// Ensure runtime root is NOT inside any Git repository checkout
const gitCheck = spawnSync('/usr/bin/git', ['-C', root, 'rev-parse', '--show-toplevel']);
if (gitCheck.status === 0) {
  runtimeRoot = path.join(os.homedir(), '.agent-hub-runtime');
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  root = await realpath(runtimeRoot);
}

const port = config.port ?? (process.env.PORT ? parseInt(process.env.PORT, 10) : 4321);
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid port: ' + port);

const state = path.join(root, 'state');
await mkdir(state, { recursive: true, mode: 0o700 });
if ((await lstat(state)).isSymbolicLink()) throw new Error('State directory cannot be a symlink');
await chmod(state, 0o700);
process.env.AGETOR_DATA_DIR = state;

// 3. Resolve Frontend Directory
let frontendDir = config.frontendDir;
if (frontendDir && !path.isAbsolute(frontendDir)) {
  frontendDir = path.resolve(projectRoot, frontendDir);
}
if (!frontendDir || !existsSync(frontendDir)) {
  frontendDir = path.join(projectRoot, 'apps/web/public');
}

// 4. Resolve Repositories & Auto-seed Demo Repository if needed
let rawRepos = Array.isArray(config.repositories) ? config.repositories : [];

// If no repositories configured or demo repo path does not exist, auto-seed a local git repository
if (rawRepos.length === 0 || !existsSync(rawRepos[0]?.path || '')) {
  const demoSeedDir = path.join(projectRoot, 'examples/demo-geometry-repo');
  const demoTargetDir = path.join(os.homedir(), '.agent-hub-demo-repo');

  if (!existsSync(path.join(demoTargetDir, '.git')) && existsSync(demoSeedDir)) {
    await mkdir(demoTargetDir, { recursive: true });
    spawnSync('cp', ['-r', `${demoSeedDir}/.`, demoTargetDir]);
    spawnSync('/usr/bin/git', ['init', '-q', demoTargetDir]);
    spawnSync('/usr/bin/git', ['-C', demoTargetDir, 'config', 'user.name', 'Agent Hub Demo']);
    spawnSync('/usr/bin/git', ['-C', demoTargetDir, 'config', 'user.email', 'demo@agent-hub.local']);
    spawnSync('/usr/bin/git', ['-C', demoTargetDir, 'add', '.']);
    spawnSync('/usr/bin/git', ['-C', demoTargetDir, 'commit', '-qm', 'feat: initial demo geometry suite']);
  }

  if (existsSync(demoTargetDir)) {
    rawRepos = [
      {
        id: '11111111-2222-3333-4444-555555555555',
        label: 'demo-geometry-repo',
        path: demoTargetDir,
        defaultTestProfileId: 'geom-tests',
        model: 'deepseek-chat',
        models: {
          planner: 'deepseek-reasoner',
          developer: 'deepseek-chat',
          reviewer: 'deepseek-chat'
        },
        effort: 'low',
        testProfiles: [
          { id: 'circle-tests', command: [process.execPath || 'node', 'test_circle.js'], timeoutMs: 15000 },
          { id: 'rect-tests', command: [process.execPath || 'node', 'test_rect.js'], timeoutMs: 15000 },
          { id: 'geom-tests', command: [process.execPath || 'node', 'test_geom.js'], timeoutMs: 15000 }
        ]
      }
    ];
  }
}

// Ensure repository paths and test commands are absolute/executable
for (const r of rawRepos) {
  if (r.path && !path.isAbsolute(r.path)) {
    r.path = path.resolve(projectRoot, r.path);
  }
  if (Array.isArray(r.testProfiles)) {
    for (const tp of r.testProfiles) {
      if (Array.isArray(tp.command)) {
        if (tp.command[0] === 'node' || tp.command[0]?.includes('node')) {
          tp.command[0] = process.execPath || 'node';
        }
      }
    }
  }
}

const repositories = await Promise.all(rawRepos.map(resolveRepository));

// 5. Codex CLI Check (Graceful fallback)
const needsCodex = repositories.some((r) => {
  const models = [r.model, r.models?.planner, r.models?.developer, r.models?.reviewer].filter(Boolean) as string[];
  return models.length > 0 && models.some((m) => m && (m.includes('codex') || m.includes('gpt')));
});

let cli = Bun.which('codex');
if (!cli && existsSync('/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex')) {
  cli = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
}

if (needsCodex) {
  if (!cli) {
    console.warn('Notice: Official Codex CLI not found in PATH or ChatGPT.app; Codex will run in standby mode.');
  } else {
    const auth = spawnSync(cli, ['login', 'status'], { encoding: 'utf8', timeout: 15000 });
    if (auth.status !== 0) {
      console.warn('Notice: Codex login inactive; tasks will use configured API keys or standby mode.');
    }
  }
}

// 6. Token, Assets & Store Initialization
const token = randomBytes(32).toString('hex');
const frontend = frontendDir ? await buildFrontendAssets(frontendDir, token) : null;
const maxConcurrency = config.maxConcurrency ?? (process.env.HUB_MAX_CONCURRENCY ? parseInt(process.env.HUB_MAX_CONCURRENCY, 10) : 2);

const { db } = await import('../src/bun/db.ts');
const store = new HubStore(db, Date.now, 10000, maxConcurrency);
const service = new HubService(store, { root, repositories, maxConcurrency });

const origin = `http://127.0.0.1:${port}`;
const api = createHubHandler({ service, token, port });

const server = Bun.serve({
  hostname: '127.0.0.1',
  port,
  idleTimeout: 120,
  maxRequestBodySize: 256 * 1024,
  fetch: async (request) => {
    const url = new URL(request.url);
    if (url.origin !== origin || (request.headers.has('host') && request.headers.get('host') !== url.host)) {
      return new Response('Forbidden', { status: 403 });
    }
    if (url.pathname.startsWith('/api/')) return api(request);
    if (
      request.method !== 'GET' ||
      url.search ||
      url.hash ||
      request.headers.get('sec-fetch-site') === 'cross-site' ||
      (request.headers.has('origin') && request.headers.get('origin') !== origin)
    ) {
      return new Response('Forbidden', { status: 403 });
    }
    const asset = frontend?.assets.get(url.pathname);
    if (!asset) return new Response('Not found', { status: 404 });
    return new Response(asset.body, {
      headers: {
        'content-type': asset.type,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
        'cross-origin-resource-policy': 'same-origin',
        'referrer-policy': 'no-referrer',
        'content-security-policy': `default-src 'self'; script-src 'nonce-${frontend!.nonce}'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`
      }
    });
  }
});

await writeFile(path.join(state, 'credentials.json'), JSON.stringify({ origin, token, pid: process.pid }), { mode: 0o600 });
await chmod(path.join(state, 'credentials.json'), 0o600);

const tickTimer = setInterval(() => void service.tick().catch(console.error), 1000);
console.log(`================================================================================`);
console.log(`🚀 Multi-Agent Collaboration Hub (Agent Router) is LIVE!`);
console.log(`🌐 Dashboard URL:    ${origin}`);
console.log(`⚡ Max Concurrency:  ${service.maxConcurrency}`);
console.log(`📁 Runtime Storage:  ${root}`);
console.log(`🔒 Local Token Auth: 0600 mode credentials stored`);
console.log(`================================================================================`);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(tickTimer);
  await service.close();
  await server.stop(true);
  db.close();
  process.exit(0);
}

process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
