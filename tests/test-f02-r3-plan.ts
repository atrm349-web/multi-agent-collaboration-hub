import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID, createHash, webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';
import { buildFrontendAssets } from '../backend/agetor/packages/core/frontend.ts';
import { validatePlan } from '../backend/agetor/packages/core/planner.ts';

const shared = path.resolve(__dirname, '..');
const appSource = await readFile(shared + '/apps/web/public/app.js', 'utf8');
const token = randomBytes(32).toString('hex');
const bridge = await buildFrontendAssets(shared + '/apps/web/public', token);

console.log('Testing F02-r3 Frontend Logic & validatePlan joint assertions...');

// Extract pure functions from app.js
const code = appSource.slice(
  appSource.indexOf('async function computeSha256Hex'),
  appSource.indexOf('\nglobalThis.apiRequest =')
);

let fixture = Buffer.from('{"data":"payload","metadata":"must survive"}');
let status = 200;
let expected = createHash('sha256').update(fixture).digest('hex');

const f = runInNewContext(
  code + ';({apiRequest,fetchArtifactRaw,formatArtifactPreviewFromRaw,sanitizeExecutablePlan,inspectDraftPlanCompatibility})',
  {
    crypto: webcrypto,
    TextDecoder,
    TextEncoder,
    Uint8Array,
    AUTH_TOKEN: token,
    makeIdempotencyKey: () => 'fixture',
    showToast: () => {},
    loadConsistentSnapshot: async () => {},
    uiState: { artifactsPage: { items: [{ id: 'fixture', get sha256() { return expected; } }] } },
    fetch: async () => new Response(fixture, { status, headers: { 'content-type': 'application/json' } })
  }
);

function step(stage: string, code: string, dependsOn: string[] = [], id = randomUUID()) {
  return {
    id,
    stage,
    code,
    title: code,
    description: code,
    dependsOn,
    requiredCapabilities: ['stream'],
    acceptanceCriteria: [{ id: 'ac-' + code, description: code }]
  };
}

// 1. Single chain A -> B (analysis) -> C
console.log('[Check 1] Testing single chain [A -> B(analysis) -> C]...');
const a = step('implementation', 'A');
const b = step('analysis', 'B', [a.id]);
const c = step('implementation', 'C', [b.id]);
const chain = f.sanitizeExecutablePlan([a, b, c]);
assert.equal(chain.length, 2);
assert.equal(JSON.stringify(chain[1].dependsOn), JSON.stringify([a.id]));
assert.equal(chain[1].acceptanceCriteria.some((x: any) => x.id === 'ac-B'), true);
const validatedChain = validatePlan(chain);
assert.equal(validatedChain.length, 2);
console.log('  -> PASS: Single chain compression preserved ac-B and passed validatePlan');

// 2. Branching A -> B (analysis) -> (C, D) (R3-a fix verification: rejected unambiguously)
console.log('[Check 2] Testing branching [A -> B(analysis) -> (C, D)] (R3-a)...');
const d = step('documentation', 'D', [b.id]);
assert.throws(
  () => f.sanitizeExecutablePlan([a, b, c, d]),
  /INVALID_INPUT: Cannot compress B: expected exactly one executable destination for its acceptance criteria, found 2/
);
console.log('  -> PASS: Branching compression rejected with clear message requesting plan regeneration');

// 3. Terminal analysis node with criteria [A -> B] (R3-b fix verification)
console.log('[Check 3] Testing terminal removed node with criteria [A -> B(analysis)] (R3-b)...');
assert.throws(
  () => f.sanitizeExecutablePlan([a, b]),
  /INVALID_INPUT: Cannot compress B: expected exactly one executable destination for its acceptance criteria, found 0/
);
console.log('  -> PASS: Terminal removed node with criteria was explicitly rejected with INVALID_INPUT (not silently lost)');

// 4. Isolated analysis node with criteria [B]
console.log('[Check 4] Testing isolated analysis node with criteria [B]...');
assert.throws(() => f.sanitizeExecutablePlan([b]), /INVALID_INPUT/);
console.log('  -> PASS: Isolated analysis node rejected with INVALID_INPUT');

// 5. Normal executable fan-out [A -> (C, D)]
console.log('[Check 5] Testing normal executable fan-out [A -> (C, D)]...');
const normalFanOut = f.sanitizeExecutablePlan([a, c, d]);
assert.equal(normalFanOut.length, 3);
validatePlan(normalFanOut);
console.log('  -> PASS: Normal executable fan-out remains supported and passes validatePlan');

// 6. Compatibility inspector
console.log('[Check 6] Testing inspectDraftPlanCompatibility...');
assert.equal(f.inspectDraftPlanCompatibility([a, b, c]).isDirectlyExecutable, false);
assert.equal(f.inspectDraftPlanCompatibility([a, c]).isDirectlyExecutable, true);
console.log('  -> PASS: inspectDraftPlanCompatibility correctly reports executability');

// 7. Verify API and artifact integrity functions remain fully intact
console.log('[Check 7] Testing artifact integrity and raw parsing...');
assert.deepEqual(JSON.parse(await f.apiRequest('/api/v1/artifacts/fixture/content')), {
  data: 'payload',
  metadata: 'must survive'
});
const raw = await f.fetchArtifactRaw('fixture');
assert.equal(Buffer.from(raw.bytes).equals(fixture), true);
expected = '0'.repeat(64);
await assert.rejects(f.fetchArtifactRaw('fixture'), /ARTIFACT_INTEGRITY_MISMATCH/);
status = 404;
fixture = Buffer.from('{"error":{"code":"NOT_FOUND","message":"fixture"}}');
await assert.rejects(f.fetchArtifactRaw('fixture'), /NOT_FOUND/);
console.log('  -> PASS: Artifact raw bytes and integrity handling intact');

console.log('\nALL F02-R3 FRONTEND PLAN TESTS & BACKEND VALIDATION ASSERTIONS PASSED!');
