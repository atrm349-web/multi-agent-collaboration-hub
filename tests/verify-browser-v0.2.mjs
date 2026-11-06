// Multi-Agent Collaboration Hub — Real Google Chrome Browser E2E Verification Suite (F-03)
// Drives real macOS Google Chrome (--headless=new) via Chrome DevTools Protocol (CDP WebSocket)
// Strictly separated from HTTP/API script tests per docs/api-contract.md & docs/alignment-v0.2.md.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_PATH = path.resolve(__dirname, '../apps/web/server.mjs');
const CHROME_BIN = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const SERVER_PORT = Number(process.env.BROWSER_TEST_SERVER_PORT || 4326);
const CDP_PORT = Number(process.env.BROWSER_TEST_CDP_PORT || 9344);
const APP_URL = `http://127.0.0.1:${SERVER_PORT}/`;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForHttpReady(url, maxWaitMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch {
      // retry
    }
    await sleep(120);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

class CdpSession {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (res.exceptionDetails) {
      throw new Error(`Browser JS exception: ${JSON.stringify(res.exceptionDetails)}`);
    }
    return res.result?.value;
  }

  async waitForCondition(jsConditionExpr, timeoutMs = 6000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const ok = await this.eval(`Boolean(${jsConditionExpr})`);
      if (ok) return true;
      await sleep(100);
    }
    const diag = await this.eval(`({
      sse: document.getElementById('sseStatusBadge')?.textContent,
      mode: document.getElementById('executionModeBadge')?.textContent,
      bar: document.getElementById('activeTaskBar')?.innerText
    })`);
    throw new Error(`Timed out waiting for browser condition: ${jsConditionExpr}. Current DOM state: ${JSON.stringify(diag)}`);
  }

  close() {
    if (this.ws) this.ws.close();
  }
}

async function runBrowserSuite() {
  console.log('================================================================================');
  console.log('Multi-Agent Collaboration Hub — Real Google Chrome Browser Verification (F-03)');
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log(`Chrome Binary: ${CHROME_BIN}`);
  console.log(`Target URL: ${APP_URL}`);
  console.log('================================================================================\n');

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-chrome-v02-'));
  const serverProc = spawn(process.execPath, [SERVER_PATH], {
    env: { ...process.env, PORT: String(SERVER_PORT), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let chromeProc = null;
  let cdp = null;

  try {
    await waitForHttpReady(`http://127.0.0.1:${SERVER_PORT}/api/v1/health`);

    chromeProc = spawn(
      CHROME_BIN,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        `--user-data-dir=${userDataDir}`,
        `--remote-debugging-port=${CDP_PORT}`,
        APP_URL
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );

    const targets = await waitForHttpReady(`http://127.0.0.1:${CDP_PORT}/json/list`);
    const pageTarget = targets.find((t) => t.type === 'page' && t.url.startsWith(APP_URL)) || targets.find((t) => t.type === 'page');
    assert.ok(pageTarget?.webSocketDebuggerUrl, 'Expected Chrome page target with webSocketDebuggerUrl');

    cdp = new CdpSession(pageTarget.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    // ------------------------------------------------------------------------
    // Browser Check 1: Initial Render, Snapshot Bootstrap & SSE Connection
    // ------------------------------------------------------------------------
    console.log('[Browser Check 1] Verifying initial DOM render, v0.2 Meta badge & SSE connection in Google Chrome...');
    await cdp.waitForCondition(
      `document.getElementById('sseStatusBadge')?.textContent.includes('SSE v0.2: Connected') && document.querySelectorAll('#sidebarTaskList .sidebar-task-card').length === 3`
    );

    const initSnapshot = await cdp.eval(`({
      userAgent: navigator.userAgent,
      title: document.title,
      modeBadge: document.getElementById('executionModeBadge')?.textContent.trim(),
      sseBadge: document.getElementById('sseStatusBadge')?.textContent.trim(),
      sidebarCount: document.querySelectorAll('#sidebarTaskList .sidebar-task-card').length,
      activeTaskStatus: document.querySelector('#activeTaskBar .status-badge')?.textContent.trim()
    })`);
    console.log('  Chrome Runtime Info:', JSON.stringify(initSnapshot));
    assert.ok(initSnapshot.userAgent.includes('HeadlessChrome'));
    assert.ok(initSnapshot.modeBadge.includes('contractVersion=0.2'));
    assert.ok(initSnapshot.modeBadge.includes('liveExecutionAvailable=false'));
    assert.equal(initSnapshot.sidebarCount, 3);
    assert.equal(initSnapshot.activeTaskStatus, 'waiting_approval');
    console.log('  -> PASS: Initial Chrome DOM render, v0.2 badges, and SSE connection verified.\n');

    // ------------------------------------------------------------------------
    // Browser Check 2: Lossless View Switching & DraftPlan Composer Preservation
    // ------------------------------------------------------------------------
    console.log('[Browser Check 2] Verifying Task Center composer, DraftPlan preview & lossless view switching...');
    await cdp.eval(`document.querySelector('[data-view="task-center"]').click()`);
    await cdp.waitForCondition(`Boolean(document.getElementById('composerGoalInput'))`);

    await cdp.eval(`(() => {
      const titleInput = document.getElementById('composerTitleInput');
      const goalInput = document.getElementById('composerGoalInput');
      titleInput.value = 'Browser E2E Custom Vision Task';
      goalInput.value = '在真实 Chrome 中测试智能车赛道识别与障碍物检测 DAG 拆解预览';
      document.getElementById('previewDecomposeBtn').click();
    })()`);

    await cdp.waitForCondition(`document.getElementById('viewportContent')?.innerText.includes('DraftPlan #')`);

    // Switch to Workflow DAG and Agent Workspace, then back to Task Center
    await cdp.eval(`document.querySelector('[data-view="workflow-dag"]').click()`);
    await cdp.waitForCondition(`document.getElementById('viewportContent')?.innerText.includes('SUB-03')`);

    await cdp.eval(`document.querySelector('[data-view="agent-workspace"]').click()`);
    await cdp.waitForCondition(`document.getElementById('viewportContent')?.innerText.includes('logSeq:1')`);

    await cdp.eval(`document.querySelector('[data-view="task-center"]').click()`);
    const preservedDraft = await cdp.eval(`({
      title: document.getElementById('composerTitleInput')?.value,
      goal: document.getElementById('composerGoalInput')?.value,
      hasDraftPlan: document.getElementById('viewportContent')?.innerText.includes('DraftPlan #')
    })`);
    assert.equal(preservedDraft.title, 'Browser E2E Custom Vision Task');
    assert.equal(preservedDraft.goal, '在真实 Chrome 中测试智能车赛道识别与障碍物检测 DAG 拆解预览');
    assert.equal(preservedDraft.hasDraftPlan, true);
    console.log('  -> PASS: Draft inputs and DraftPlan preview preserved across multi-view navigation without data loss.\n');

    // ------------------------------------------------------------------------
    // Browser Check 3: Historical Real Evidence (real-relay-01) Read-Only Lock in DOM
    // ------------------------------------------------------------------------
    console.log('[Browser Check 3] Verifying read-only DOM lock on historical real CLI evidence (real-relay-01)...');
    await cdp.eval(`document.querySelector('[data-select-task="real-relay-01"]').click()`);
    await cdp.waitForCondition(
      `document.getElementById('activeTaskBar')?.innerText.includes('HISTORICAL REAL EVIDENCE') && document.querySelector('#activeTaskBar .status-badge')?.textContent.trim() === 'succeeded'`
    );

    const histCheck = await cdp.eval(`({
      barText: document.getElementById('activeTaskBar')?.innerText,
      controlButtonsCount: document.querySelectorAll('#activeTaskBar [data-v1-task-control]').length,
      mockButtonsCount: document.querySelectorAll('#activeTaskBar [data-mock-step], #activeTaskBar [data-mock-fault]').length
    })`);
    assert.ok(histCheck.barText.includes('历史真实 CLI 证据只读保护'));
    assert.equal(histCheck.controlButtonsCount, 0);
    assert.equal(histCheck.mockButtonsCount, 0);
    console.log('  -> PASS: Historical evidence task renders read-only lock and hides all mutation/mock controls in DOM.\n');

    // ------------------------------------------------------------------------
    // Browser Check 4: Review Center Decoupled Approval & Subtask Rework -> Full DAG Succeeded
    // ------------------------------------------------------------------------
    console.log('[Browser Check 4] Verifying Review Center approval/rework separation and full DAG completion in Chrome...');
    await cdp.eval(`document.querySelector('[data-select-task="task-smartcar-01"]').click()`);
    await cdp.waitForCondition(`document.querySelector('#activeTaskBar .status-badge')?.textContent.trim() === 'waiting_approval'`);

    await cdp.eval(`document.querySelector('[data-view="review-center"]').click()`);
    await cdp.waitForCondition(`Boolean(document.querySelector('[data-approval-decision="approve"]'))`);

    const reviewButtons = await cdp.eval(`({
      hasApprove: Boolean(document.querySelector('[data-approval-decision="approve"]')),
      hasReject: Boolean(document.querySelector('[data-approval-decision="reject"]')),
      hasDecoupledRework: Boolean(document.querySelector('[data-subtask-rework="sub-03"]')),
      diffLoaded: document.querySelector('#viewportContent .code-preview')?.textContent.includes('SmartCarObstacleDetector')
    })`);
    assert.equal(reviewButtons.hasApprove, true);
    assert.equal(reviewButtons.hasReject, true);
    assert.equal(reviewButtons.hasDecoupledRework, true);
    assert.equal(reviewButtons.diffLoaded, true);

    // Click Approve button in Chrome
    await cdp.eval(`document.querySelector('[data-approval-decision="approve"]').click()`);
    await cdp.waitForCondition(`document.querySelector('#activeTaskBar .status-badge')?.textContent.trim() === 'running'`);

    // Click Mock Step twice in Chrome to complete SUB-04 and SUB-05
    await cdp.eval(`document.querySelector('[data-mock-step="task-smartcar-01"]').click()`);
    await sleep(250);
    await cdp.eval(`document.querySelector('[data-mock-step="task-smartcar-01"]').click()`);
    await cdp.waitForCondition(`document.querySelector('#activeTaskBar .status-badge')?.textContent.trim() === 'succeeded'`);

    const finalTaskDom = await cdp.eval(`({
      status: document.querySelector('#activeTaskBar .status-badge')?.textContent.trim(),
      barText: document.getElementById('activeTaskBar')?.innerText
    })`);
    assert.equal(finalTaskDom.status, 'succeeded');
    assert.ok(finalTaskDom.barText.includes('进度 100%'));
    console.log('  -> PASS: Review Center Approve unlocked downstream DAG and progressed task to "succeeded" (100%).\n');

    // ------------------------------------------------------------------------
    // Browser Check 5: Timeout Error Banner, Bounded Subtask Retry & Pause/Resume Flow
    // ------------------------------------------------------------------------
    console.log('[Browser Check 5] Verifying TIMEOUT error banner, Subtask Retry, and Pause->Paused->Resume in Chrome...');
    await cdp.eval(`document.querySelector('[data-select-task="task-telemetry-02"]').click()`);
    await cdp.waitForCondition(`document.querySelector('#activeTaskBar .status-badge')?.textContent.trim() === 'timed_out'`);

    const errBannerExists = await cdp.eval(`Boolean(document.querySelector('#activeTaskBar .error-banner [data-subtask-retry="sub-202"]'))`);
    assert.equal(errBannerExists, true);

    // Click Retry Failed Subtask button inside the error banner
    await cdp.eval(`document.querySelector('#activeTaskBar .error-banner [data-subtask-retry="sub-202"]').click()`);
    await cdp.waitForCondition(`document.querySelector('#activeTaskBar .status-badge')?.textContent.trim() === 'running'`);

    // Click Pause -> verify pausing -> click Mock Step -> verify paused -> click Resume -> verify queued
    await cdp.eval(`document.querySelector('[data-v1-task-control="pause"]').click()`);
    await cdp.waitForCondition(`document.querySelector('#activeTaskBar .status-badge')?.textContent.trim() === 'pausing'`);

    await cdp.eval(`document.querySelector('[data-mock-step="task-telemetry-02"]').click()`);
    await cdp.waitForCondition(`document.querySelector('#activeTaskBar .status-badge')?.textContent.trim() === 'paused'`);

    await cdp.eval(`document.querySelector('[data-v1-task-control="resume"]').click()`);
    await cdp.waitForCondition(`document.querySelector('#activeTaskBar .status-badge')?.textContent.trim() === 'queued'`);
    console.log('  -> PASS: Error banner Subtask Retry and pausing -> paused -> resume -> queued verified in Chrome DOM.\n');

    // ------------------------------------------------------------------------
    // Browser Check 6: SSE Expired Cursor (409 EVENT_CURSOR_EXPIRED) Auto-Recovery in Browser
    // ------------------------------------------------------------------------
    console.log('[Browser Check 6] Verifying SSE 409 EVENT_CURSOR_EXPIRED snapshot auto-recovery in Chrome...');
    await cdp.eval(`document.querySelector('[data-view="dashboard"]').click()`);
    await cdp.waitForCondition(`Boolean(document.getElementById('testExpiredCursorBtn'))`);
    await cdp.eval(`document.getElementById('testExpiredCursorBtn').click()`);
    await cdp.waitForCondition(
      `document.getElementById('sseStatusBadge')?.textContent.includes('SSE v0.2: Connected') && document.getElementById('toastContainer')?.innerText.includes('409 EVENT_CURSOR_EXPIRED')`
    );
    console.log('  -> PASS: Browser handled 409 EVENT_CURSOR_EXPIRED by re-fetching /api/v1/snapshot and re-subscribing SSE.\n');

    console.log('================================================================================');
    console.log('ALL 6 REAL GOOGLE CHROME BROWSER VERIFICATION CHECKS PASSED (0 FAILURES)');
    console.log('================================================================================');
  } finally {
    if (cdp) cdp.close();
    if (chromeProc) chromeProc.kill('SIGTERM');
    serverProc.kill('SIGTERM');
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup error
    }
  }
}

runBrowserSuite().catch((err) => {
  console.error('REAL BROWSER v0.2 VERIFICATION FAILED:', err);
  process.exitCode = 1;
});
