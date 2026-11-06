// Multi-Agent Collaboration Hub — Unified Contract v0.2 Automated Verification Suite
// Scope: HTTP / API / SSE Contract Verification (strictly separated from Browser UI Verification)
// Target baseline: docs/api-contract.md (v0.2) & packages/shared/src/types.v0.2.ts

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_PATH = path.resolve(__dirname, '../apps/web/server.mjs');
const TEST_PORT = Number(process.env.TEST_PORT || 4325);
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
const TOKEN = 'dev-local-hub-token-v1';

let idemCounter = 1;
function nextIdemKey(prefix = 'test-v02') {
  idemCounter += 1;
  return `${prefix}-${idemCounter}`;
}

async function reqJson(pathname, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const headers = {
    ...(options.auth !== false ? { Authorization: `Bearer ${TOKEN}` } : {}),
    ...(options.headers || {})
  };
  if (options.body !== undefined && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`${BASE_URL}${pathname}`, {
    method,
    headers,
    body: options.body !== undefined ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body)) : undefined
  });
  const contentType = res.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await res.json() : await res.text();
  return { status: res.status, headers: res.headers, body };
}

async function waitForServerReady(maxWaitMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const r = await reqJson('/api/v1/health', { auth: false });
      if (r.status === 200 && r.body?.data?.status === 'ok') return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error('Server failed to start within timeout');
}

async function runContractTests() {
  console.log('================================================================================');
  console.log('Multi-Agent Collaboration Hub — HTTP/API Contract v0.2 Verification Suite (F-03)');
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log(`Target Server: ${SERVER_PATH} on ${BASE_URL}`);
  console.log('================================================================================\n');

  const serverProc = spawn(process.execPath, [SERVER_PATH], {
    env: { ...process.env, PORT: String(TEST_PORT), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    await waitForServerReady();

    // ------------------------------------------------------------------------
    // Suite 1: Health, Auth, Origin Allowlist & Query Token Rejection
    // ------------------------------------------------------------------------
    console.log('[Suite 1] Testing Health, Bearer Auth, Origin Allowlist & Query Token Rejection...');
    const health = await reqJson('/api/v1/health', { auth: false });
    assert.equal(health.status, 200);
    assert.equal(health.body.data.status, 'ok');
    assert.ok(health.body.requestId);

    const noAuth = await reqJson('/api/v1/meta', { auth: false });
    assert.equal(noAuth.status, 401);
    assert.equal(noAuth.body.error.code, 'UNAUTHENTICATED');

    const queryToken = await reqJson(`/api/v1/meta?token=${TOKEN}`);
    assert.equal(queryToken.status, 400);
    assert.equal(queryToken.body.error.code, 'INVALID_INPUT');

    const badOrigin = await reqJson('/api/v1/meta', {
      headers: { Origin: 'https://malicious.example.com' }
    });
    assert.equal(badOrigin.status, 403);
    assert.equal(badOrigin.body.error.code, 'PERMISSION_DENIED');
    console.log('  -> PASS: Health, 401 UNAUTHENTICATED, 400 Query Token Forbidden, and 403 Origin check verified.\n');

    // ------------------------------------------------------------------------
    // Suite 2: Meta, Repositories, Agents (unsupportedReasons) & Page<Task>
    // ------------------------------------------------------------------------
    console.log('[Suite 2] Testing /api/v1/meta, /repositories, /agents & true Page<Task> pagination...');
    const meta = await reqJson('/api/v1/meta');
    assert.equal(meta.status, 200);
    assert.equal(meta.body.data.contractVersion, '0.2');
    assert.equal(meta.body.data.executionMode, 'mock');
    assert.equal(meta.body.data.liveExecutionAvailable, false);

    const repos = await reqJson('/api/v1/repositories?limit=10');
    assert.equal(repos.status, 200);
    assert.ok(Array.isArray(repos.body.data.items));
    assert.equal(repos.body.data.nextCursor, null);

    const agents = await reqJson('/api/v1/agents');
    assert.equal(agents.status, 200);
    assert.ok(agents.body.data.items.length >= 3);
    const codexAgent = agents.body.data.items.find((a) => a.id === 'agent-codex');
    assert.ok(codexAgent);
    assert.ok(codexAgent.unsupportedReasons['live-context']);
    const deepseekAgent = agents.body.data.items.find((a) => a.id === 'agent-deepseek');
    assert.equal(deepseekAgent.availability, 'disabled');

    const tasksPage1 = await reqJson('/api/v1/tasks?limit=2');
    assert.equal(tasksPage1.status, 200);
    assert.equal(tasksPage1.body.data.items.length, 2);
    assert.ok(tasksPage1.body.data.nextCursor, 'Expected non-null nextCursor for Page 1');
    // Verify it is NOT returning the old full state object
    assert.equal(tasksPage1.body.data.subtasks, undefined);

    const tasksPage2 = await reqJson(`/api/v1/tasks?limit=2&cursor=${encodeURIComponent(tasksPage1.body.data.nextCursor)}`);
    assert.equal(tasksPage2.status, 200);
    assert.equal(tasksPage2.body.data.items.length, 1);
    assert.equal(tasksPage2.body.data.nextCursor, null);
    assert.equal(tasksPage2.body.data.items[0].id, 'real-relay-01');
    assert.equal(tasksPage2.body.data.items[0].status, 'succeeded');
    assert.equal(tasksPage2.body.data.items[0].provenance, 'historical');
    console.log('  -> PASS: Meta, Repositories, Agents capability/unsupportedReasons, and cursor-paginated Page<Task> verified.\n');

    // ------------------------------------------------------------------------
    // Suite 3: Snapshot, TaskDetail, Per-Run LogPage (logSeq) & Artifact Content Security
    // ------------------------------------------------------------------------
    console.log('[Suite 3] Testing /api/v1/snapshot, TaskDetail, LogPage (logSeq) & Artifact Content headers...');
    const snap = await reqJson('/api/v1/snapshot?taskId=task-smartcar-01');
    assert.equal(snap.status, 200);
    assert.equal(snap.body.data.schemaVersion, '0.2');
    assert.equal(typeof snap.body.data.snapshotSeq, 'number');
    assert.equal(snap.body.data.selectedTask.task.id, 'task-smartcar-01');
    assert.equal(snap.body.data.selectedTask.task.status, 'waiting_approval');
    assert.ok(Array.isArray(snap.body.data.selectedTask.subtasks));
    assert.ok(Array.isArray(snap.body.data.selectedTask.runs.items));
    assert.ok(Array.isArray(snap.body.data.selectedTask.validations.items));
    assert.ok(Array.isArray(snap.body.data.selectedTask.approvals.items));
    assert.ok(Array.isArray(snap.body.data.selectedTask.artifacts.items));

    // Verify Artifact DTO does not expose absolute path or raw previewContent in list
    const art01Dto = snap.body.data.selectedTask.artifacts.items.find((a) => a.id === 'art-01');
    assert.equal(art01Dto.relativePath, 'src/vision/contracts.py');
    assert.equal(art01Dto.path, undefined);
    assert.equal(art01Dto.previewContent, undefined);

    const logPage = await reqJson('/api/v1/runs/run-101/logs?afterSeq=2&limit=2');
    assert.equal(logPage.status, 200);
    assert.equal(logPage.body.data.runId, 'run-101');
    assert.equal(logPage.body.data.items.length, 2);
    assert.equal(logPage.body.data.items[0].logSeq, 3);
    assert.equal(logPage.body.data.items[1].logSeq, 4);
    assert.equal(logPage.body.data.nextSeq, 4);
    assert.equal(logPage.body.data.hasMore, true);

    const artContent = await reqJson('/api/v1/artifacts/art-01/content');
    assert.equal(artContent.status, 200);
    assert.equal(artContent.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(artContent.headers.get('content-security-policy'), "default-src 'none'");
    assert.ok(String(artContent.body).includes('class CameraHomography'));

    const traversal = await reqJson('/api/v1/artifacts/..%2Fetc%2Fpasswd/content');
    assert.equal(traversal.status, 400);
    assert.equal(traversal.body.error.code, 'INVALID_INPUT');
    console.log('  -> PASS: Consistent Snapshot, TaskDetail bounded pages, LogPage (logSeq/hasMore), and Artifact nosniff/traversal security verified.\n');

    // ------------------------------------------------------------------------
    // Suite 4: Unknown Control Field Rejection, Idempotency-Key Replay/409, and CAS
    // ------------------------------------------------------------------------
    console.log('[Suite 4] Testing Unknown Field Rejection, Idempotency-Key Replay/Conflict, and CAS expectedVersion...');
    const unknownFieldRes = await reqJson('/api/v1/tasks/decompose', {
      method: 'POST',
      headers: { 'Idempotency-Key': nextIdemKey() },
      body: {
        goal: 'Build vision pipeline',
        repositoryId: 'repo-smartcar-vision',
        unexpectedShellFlag: '--danger-full-access'
      }
    });
    assert.equal(unknownFieldRes.status, 400);
    assert.equal(unknownFieldRes.body.error.code, 'INVALID_INPUT');

    const missingIdem = await reqJson('/api/v1/tasks/decompose', {
      method: 'POST',
      body: { goal: 'Build vision pipeline', repositoryId: 'repo-smartcar-vision' }
    });
    assert.equal(missingIdem.status, 400);
    assert.equal(missingIdem.body.error.code, 'INVALID_INPUT');

    const sharedKey = nextIdemKey('idem-replay');
    const decomp1 = await reqJson('/api/v1/tasks/decompose', {
      method: 'POST',
      headers: { 'Idempotency-Key': sharedKey },
      body: { goal: '开发智能车赛道识别与障碍物检测', repositoryId: 'repo-smartcar-vision' }
    });
    assert.equal(decomp1.status, 200);
    assert.ok(decomp1.body.data.id);

    // Same key + same payload -> exact replay
    const decompReplay = await reqJson('/api/v1/tasks/decompose', {
      method: 'POST',
      headers: { 'Idempotency-Key': sharedKey },
      body: { repositoryId: 'repo-smartcar-vision', goal: '开发智能车赛道识别与障碍物检测' }
    });
    assert.equal(decompReplay.status, 200);
    assert.equal(decompReplay.body.data.id, decomp1.body.data.id);
    assert.equal(decompReplay.body.requestId, decomp1.body.requestId);

    // Same key + different payload -> 409 CONFLICT
    const decompConflict = await reqJson('/api/v1/tasks/decompose', {
      method: 'POST',
      headers: { 'Idempotency-Key': sharedKey },
      body: { goal: 'Different goal payload', repositoryId: 'repo-smartcar-vision' }
    });
    assert.equal(decompConflict.status, 409);
    assert.equal(decompConflict.body.error.code, 'CONFLICT');

    // CAS mismatch on pause
    const casMismatch = await reqJson('/api/v1/tasks/task-smartcar-01/pause', {
      method: 'POST',
      headers: { 'Idempotency-Key': nextIdemKey() },
      body: { expectedVersion: 999 }
    });
    assert.equal(casMismatch.status, 409);
    assert.equal(casMismatch.body.error.code, 'CONFLICT');
    console.log('  -> PASS: Unknown field rejection (400), Idempotency-Key replay (200) & payload mismatch (409), and CAS mismatch (409) verified.\n');

    // ------------------------------------------------------------------------
    // Suite 5: Approval vs. Rework Decoupling, Digest & Expiration Checks, Full DAG Completion
    // ------------------------------------------------------------------------
    console.log('[Suite 5] Testing Approval/Rework decoupling, actionDigest/expiration checks & full DAG completion...');
    const gate = snap.body.data.selectedTask.approvals.items[0];
    assert.equal(gate.id, 'gate-101');
    assert.equal(gate.status, 'pending');

    // Legacy decision='rework_requested' must be rejected with 400 INVALID_INPUT
    const legacyDecision = await reqJson('/api/v1/approvals/gate-101/decision', {
      method: 'POST',
      headers: { 'Idempotency-Key': nextIdemKey() },
      body: {
        expectedVersion: gate.version,
        decision: 'rework_requested',
        actionDigest: gate.actionDigest
      }
    });
    assert.equal(legacyDecision.status, 400);
    assert.equal(legacyDecision.body.error.code, 'INVALID_INPUT');

    // Wrong actionDigest must return 409 CONFLICT
    const badDigest = await reqJson('/api/v1/approvals/gate-101/decision', {
      method: 'POST',
      headers: { 'Idempotency-Key': nextIdemKey() },
      body: {
        expectedVersion: gate.version,
        decision: 'approve',
        actionDigest: 'tampered-digest-0000'
      }
    });
    assert.equal(badDigest.status, 409);
    assert.equal(badDigest.body.error.code, 'CONFLICT');

    // Independent Subtask Rework invalidates pending approval and increments attempt
    const reworkRes = await reqJson('/api/v1/subtasks/sub-03/rework', {
      method: 'POST',
      headers: { 'Idempotency-Key': nextIdemKey() },
      body: {
        expectedVersion: 3,
        reason: 'Adjust CLAHE clipLimit for tunnel exit glare',
        artifactRefs: ['art-03']
      }
    });
    assert.equal(reworkRes.status, 202);
    assert.equal(reworkRes.body.data.subtask.attempt, 3);
    assert.ok(reworkRes.body.data.invalidatedApprovalIds.includes('gate-101'));
    assert.ok(reworkRes.body.data.blockedSubtaskIds.includes('sub-04'));

    // Verify expired approval rejection after reset + EXPIRE_APPROVAL fault
    await reqJson('/__mock_control/reset', { method: 'POST', body: {} });
    await reqJson('/__mock_control/fault', {
      method: 'POST',
      body: { taskId: 'task-smartcar-01', faultType: 'EXPIRE_APPROVAL' }
    });
    const expiredDecision = await reqJson('/api/v1/approvals/gate-101/decision', {
      method: 'POST',
      headers: { 'Idempotency-Key': nextIdemKey() },
      body: {
        expectedVersion: 2,
        decision: 'approve',
        actionDigest: gate.actionDigest
      }
    });
    assert.equal(expiredDecision.status, 409);
    assert.equal(expiredDecision.body.error.code, 'CONFLICT');

    // Reset and run full approval -> step SUB-04 -> step SUB-05 -> Task succeeded
    await reqJson('/__mock_control/reset', { method: 'POST', body: {} });
    const approveOk = await reqJson('/api/v1/approvals/gate-101/decision', {
      method: 'POST',
      headers: { 'Idempotency-Key': nextIdemKey() },
      body: {
        expectedVersion: 1,
        decision: 'approve',
        actionDigest: gate.actionDigest,
        comment: 'Verified CLAHE diff and homography accuracy'
      }
    });
    assert.equal(approveOk.status, 200);
    assert.equal(approveOk.body.data.status, 'approved');

    // Advance SUB-04 and SUB-05 via isolated mock control
    await reqJson('/__mock_control/step', { method: 'POST', body: { taskId: 'task-smartcar-01' } });
    const finalStep = await reqJson('/__mock_control/step', { method: 'POST', body: { taskId: 'task-smartcar-01' } });
    assert.equal(finalStep.status, 200);
    assert.equal(finalStep.body.data.task.status, 'succeeded');
    assert.equal(finalStep.body.data.task.progressPct, 100);
    console.log('  -> PASS: Approval/Rework separation, digest/expiration enforcement, and full DAG completion to "succeeded" verified.\n');

    // ------------------------------------------------------------------------
    // Suite 6: Transitional States (pausing/cancelling), Drained Output, Bounded Retry & B-01 Guardrail
    // ------------------------------------------------------------------------
    console.log('[Suite 6] Testing pausing->paused->resume, cancelling->cancelled with drained=true, Retry & B-01 Guardrail...');
    await reqJson('/__mock_control/reset', { method: 'POST', body: {} });

    // Resume from waiting_approval (not paused) must fail with 409 UNSUPPORTED_TRANSITION
    const prematureResume = await reqJson('/api/v1/tasks/task-smartcar-01/resume', {
      method: 'POST',
      headers: { 'Idempotency-Key': nextIdemKey() },
      body: { expectedVersion: 4 }
    });
    assert.equal(prematureResume.status, 409);
    assert.equal(prematureResume.body.error.code, 'UNSUPPORTED_TRANSITION');

    // Pause -> 202 pausing -> step -> paused -> resume -> 202 queued
    const pauseRes = await reqJson('/api/v1/tasks/task-smartcar-01/pause', {
      method: 'POST',
      headers: { 'Idempotency-Key': nextIdemKey() },
      body: { expectedVersion: 4 }
    });
    assert.equal(pauseRes.status, 202);
    assert.equal(pauseRes.body.data.status, 'pausing');

    const stepPaused = await reqJson('/__mock_control/step', {
      method: 'POST',
      body: { taskId: 'task-smartcar-01' }
    });
    assert.equal(stepPaused.body.data.task.status, 'paused');

    const resumeRes = await reqJson('/api/v1/tasks/task-smartcar-01/resume', {
      method: 'POST',
      headers: { 'Idempotency-Key': nextIdemKey() },
      body: { expectedVersion: stepPaused.body.data.task.version }
    });
    assert.equal(resumeRes.status, 202);
    assert.equal(resumeRes.body.data.status, 'queued');

    // Bounded Subtask Retry on timed_out subtask sub-202 (attempt 1 -> 2, preserving run-202)
    const retryRes = await reqJson('/api/v1/subtasks/sub-202/retry', {
      method: 'POST',
      headers: { 'Idempotency-Key': nextIdemKey() },
      body: { expectedVersion: 2, reason: 'Retry with user-space ringbuffer' }
    });
    assert.equal(retryRes.status, 202);
    assert.equal(retryRes.body.data.subtask.attempt, 2);
    assert.equal(retryRes.body.data.subtask.status, 'running');
    assert.notEqual(retryRes.body.data.run.id, 'run-202');

    // Cancel task-telemetry-02 -> 202 cancelling -> step -> cancelled + drained=true log line
    const telDetail = await reqJson('/api/v1/tasks/task-telemetry-02');
    const cancelRes = await reqJson('/api/v1/tasks/task-telemetry-02/cancel', {
      method: 'POST',
      headers: { 'Idempotency-Key': nextIdemKey() },
      body: { expectedVersion: telDetail.body.data.task.version, reason: 'Abort benchmark' }
    });
    assert.equal(cancelRes.status, 202);
    assert.equal(cancelRes.body.data.status, 'cancelling');

    const stepCancelled = await reqJson('/__mock_control/step', {
      method: 'POST',
      body: { taskId: 'task-telemetry-02' }
    });
    assert.equal(stepCancelled.body.data.task.status, 'cancelled');

    const activeRunLogs = await reqJson(`/api/v1/runs/${encodeURIComponent(retryRes.body.data.run.id)}/logs`);
    const drainedEntry = activeRunLogs.body.data.items.find((l) => l.drained === true);
    assert.ok(drainedEntry, 'Expected drained=true log line on cancelled run');

    // B-01 External Git Metadata PERMISSION_DENIED is non-retryable
    await reqJson('/__mock_control/fault', {
      method: 'POST',
      body: { taskId: 'task-smartcar-01', faultType: 'PERMISSION_DENIED_EXTERNAL_GIT' }
    });
    const smartcarAfterB01 = await reqJson('/api/v1/tasks/task-smartcar-01');
    const failedSub = smartcarAfterB01.body.data.subtasks.find((s) => s.status === 'failed');
    assert.equal(failedSub.error.code, 'PERMISSION_DENIED');
    assert.equal(failedSub.error.retryable, false);

    const retryNonRetryable = await reqJson(`/api/v1/subtasks/${encodeURIComponent(failedSub.id)}/retry`, {
      method: 'POST',
      headers: { 'Idempotency-Key': nextIdemKey() },
      body: { expectedVersion: failedSub.version, reason: 'Attempt retry on permission error' }
    });
    assert.equal(retryNonRetryable.status, 409);
    assert.equal(retryNonRetryable.body.error.code, 'UNSUPPORTED_TRANSITION');
    console.log('  -> PASS: Transitional states, drained=true post-cancel log, bounded retry, and B-01 non-retryable PERMISSION_DENIED verified.\n');

    // ------------------------------------------------------------------------
    // Suite 7: Historical Evidence Read-Only Protection & SSE Snapshot Cursor Replay
    // ------------------------------------------------------------------------
    console.log('[Suite 7] Testing Historical Evidence Read-Only Protection (real-relay-01) & SSE Cursor Replay...');
    const mutateHistTask = await reqJson('/api/v1/tasks/real-relay-01/pause', {
      method: 'POST',
      headers: { 'Idempotency-Key': nextIdemKey() },
      body: { expectedVersion: 6 }
    });
    assert.equal(mutateHistTask.status, 409);
    assert.equal(mutateHistTask.body.error.code, 'UNSUPPORTED_TRANSITION');

    const stepHistTask = await reqJson('/__mock_control/step', {
      method: 'POST',
      body: { taskId: 'real-relay-01' }
    });
    assert.equal(stepHistTask.status, 409);
    assert.equal(stepHistTask.body.error.code, 'UNSUPPORTED_TRANSITION');

    // SSE malformed cursor -> 400, expired cursor -> 409
    const badCursorSse = await reqJson('/api/v1/events', {
      headers: { 'Last-Event-ID': 'not-a-number' }
    });
    assert.equal(badCursorSse.status, 400);
    assert.equal(badCursorSse.body.error.code, 'INVALID_INPUT');

    const expiredCursorSse = await reqJson('/api/v1/events', {
      headers: { 'Last-Event-ID': '1' }
    });
    assert.equal(expiredCursorSse.status, 409);
    assert.equal(expiredCursorSse.body.error.code, 'EVENT_CURSOR_EXPIRED');

    // Snapshot -> Mutate -> Connect SSE with Last-Event-ID=snapshotSeq -> Verify outbox replay
    await reqJson('/__mock_control/reset', { method: 'POST', body: {} });
    const baseSnap = await reqJson('/api/v1/snapshot?taskId=task-smartcar-01');
    const watermark = baseSnap.body.data.snapshotSeq;

    await reqJson('/api/v1/tasks/task-smartcar-01/messages', {
      method: 'POST',
      headers: { 'Idempotency-Key': nextIdemKey() },
      body: {
        toSubtaskId: 'sub-03',
        content: 'Verify multi-byte UTF-8 SSE replay: 车道线曲率与障碍物单应性矩阵校验 ✓',
        artifactRefs: ['art-03']
      }
    });

    const controller = new AbortController();
    const sseRes = await fetch(`${BASE_URL}/api/v1/events?taskId=task-smartcar-01`, {
      headers: {
        Accept: 'text/event-stream',
        Authorization: `Bearer ${TOKEN}`,
        'Last-Event-ID': String(watermark)
      },
      signal: controller.signal
    });
    assert.equal(sseRes.status, 200);
    const reader = sseRes.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let sseText = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      sseText += decoder.decode(value, { stream: true });
      if (sseText.includes('event: message.created')) {
        controller.abort();
        break;
      }
    }
    assert.ok(sseText.includes('event: message.created'));
    assert.ok(sseText.includes('车道线曲率与障碍物单应性矩阵校验 ✓'));
    console.log('  -> PASS: Historical evidence read-only protection and SSE snapshotSeq outbox replay verified.\n');

    console.log('================================================================================');
    console.log('ALL 7 CONTRACT v0.2 TEST SUITES PASSED (0 FAILURES)');
    console.log('================================================================================');
  } finally {
    serverProc.kill('SIGTERM');
  }
}

runContractTests().catch((err) => {
  console.error('CONTRACT v0.2 VERIFICATION FAILED:', err);
  process.exitCode = 1;
});
