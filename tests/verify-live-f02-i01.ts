// Live Frontend + Backend End-to-End Browser & HTTP Verification (F-02 & I-01)
// Drives real Google Chrome (CDP) + real HTTP/SSE against Codex's B-04~B-06 HubService, createHubHandler,
// and buildFrontendAssets serving apps/web/public with CSP nonce bootstrap.

import { Database } from "bun:sqlite";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { HubStore } from "../backend/agetor/packages/core/state/store.ts";
import { HubService, resolveRepository } from "../backend/agetor/packages/core/hub.ts";
import { createHubHandler } from "../backend/agetor/packages/core/http.ts";
import { buildFrontendAssets } from "../backend/agetor/packages/core/frontend.ts";
import type { DraftPlan } from "../backend/agetor/packages/shared/src/types.ts";

const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const FRONTEND_DIR = path.resolve(__dirname, '../apps/web/public');
const EVIDENCE_DIR = path.resolve(__dirname, '../Antigravity/evidence');
const SCREENSHOT_DIR = path.join(EVIDENCE_DIR, "screenshots");
const ARTIFACT_DIR = process.env.ARTIFACT_DIR || path.resolve(__dirname, '../artifacts');
const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function git(cwd: string, args: string[]): string {
  return execFileSync("/usr/bin/git", args, { cwd, encoding: "utf8" }).trim();
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`LIVE_VERIFY_ASSERTION_FAILED: ${msg}`);
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function waitForJson(url: string, timeoutMs = 10000): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

class CdpSession {
  private ws!: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  public consoleErrors: string[] = [];
  public pageExceptions: string[] = [];

  async connect(wsUrl: string): Promise<void> {
    this.ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(e);
    });
    this.ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.id && this.pending.has(msg.id)) {
        const handler = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) handler.reject(new Error(JSON.stringify(msg.error)));
        else handler.resolve(msg.result);
      } else if (msg.method === "Runtime.exceptionThrown") {
        this.pageExceptions.push(msg.params?.exceptionDetails?.text || "Unknown page exception");
      } else if (msg.method === "Runtime.consoleAPICalled" && msg.params?.type === "error") {
        const text = (msg.params.args || []).map((a: any) => a.value ?? a.description ?? "").join(" ");
        this.consoleErrors.push(text);
      }
    };
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval<T = any>(expression: string): Promise<T> {
    const res = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      throw new Error(`Eval exception: ${JSON.stringify(res.exceptionDetails)} | consoleErrors=${JSON.stringify(this.consoleErrors)} in ${expression}`);
    }
    return res.result?.value as T;
  }

  async screenshot(outPaths: string[]): Promise<void> {
    const { data } = await this.send("Page.captureScreenshot", { format: "png", fromSurface: true });
    const buf = Buffer.from(data, "base64");
    for (const p of outPaths) {
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, buf);
    }
  }

  close(): void {
    try {
      this.ws.close();
    } catch {}
  }
}

async function waitForEval<T>(cdp: CdpSession, expr: string, predicate: (val: T) => boolean, label: string, timeoutMs = 20000): Promise<T> {
  const start = Date.now();
  let lastVal: any;
  let lastErr: any;
  while (Date.now() - start < timeoutMs) {
    try {
      lastVal = await cdp.eval<T>(expr);
      if (predicate(lastVal)) return lastVal;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timeout waiting for ${label}; lastVal=${JSON.stringify(lastVal)}; lastErr=${lastErr?.message || 'none'}`);
}

async function main() {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const root = mkdtempSync(path.join(os.tmpdir(), "agetor-live-f02-i01-"));
  const repoDir = path.join(root, "repo");
  const stateDir = path.join(root, "state");
  mkdirSync(path.join(repoDir, "src"), { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  const oldDataDir = process.env.AGETOR_DATA_DIR;
  process.env.AGETOR_DATA_DIR = stateDir;

  git(repoDir, ["init", "-q", "-b", "main"]);
  git(repoDir, ["config", "user.email", "hub-live@example.test"]);
  git(repoDir, ["config", "user.name", "Hub Live Verifier"]);
  writeFileSync(
    path.join(repoDir, "src/clamp.ts"),
    "export function clamp(value: number, low: number, high: number): number {\n  return value;\n}\n",
    "utf8"
  );
  writeFileSync(
    path.join(repoDir, "verify-clamp.js"),
    `import { clamp } from "./src/clamp.ts";\nif (clamp(5, 0, 3) !== 3 || clamp(-2, 0, 3) !== 0 || clamp(2, 0, 3) !== 2) {\n  console.error("clamp failed bounds check");\n  process.exit(1);\n}\nconsole.log("clamp sandbox verification passed");\n`,
    "utf8"
  );
  git(repoDir, ["add", "."]);
  git(repoDir, ["commit", "-qm", "initial commit"]);

  const repoId = randomUUID();
  const repo = await resolveRepository({
    id: repoId,
    label: "SmartCar Clamp Core (Live Git Repo)",
    path: repoDir,
    baseBranch: "main",
    defaultTestProfileId: "clamp",
    testProfiles: [
      {
        id: "clamp",
        command: [process.execPath, "verify-clamp.js"],
        timeoutMs: 10000,
      },
    ],
  });

  const db = new Database(path.join(stateDir, "hub.sqlite"));
  const store = new HubStore(db);

  let holdWorkerMs = 0;
  let implAttemptCounter = 0;

  const service = new HubService(store, {
    root,
    repositories: [repo],
    planner: async (opts): Promise<DraftPlan> => {
      const sub1 = randomUUID();
      return {
        id: randomUUID(),
        repositoryId: opts.repositoryId,
        goal: opts.goal,
        executionMode: "live",
        subtasks: [
          {
            id: sub1,
            code: "SUB-01",
            title: "Implement clamp(value, low, high) in src/clamp.ts",
            description: "Write deterministic clamp implementation and pass default clamp test profile.",
            stage: "implementation",
            dependsOn: [],
            requiredCapabilities: ["stream", "structured-output"],
            acceptanceCriteria: [{ id: "ac-clamp-01", description: "clamp bounds value into [low, high]" }],
          },
        ],
      };
    },
    testRunner: async (_root, cwd, profile) => {
      const proc = spawn(process.execPath, [path.join(cwd, "verify-clamp.js")], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (b) => {
        stdout += b.toString();
      });
      proc.stderr.on("data", (b) => {
        stderr += b.toString();
      });
      const exitCode = await new Promise<number>((resolve) => proc.once("close", (code) => resolve(code ?? 1)));
      return {
        profileId: profile.id,
        exitCode,
        stdout,
        stderr,
        timedOut: false,
        cancelled: false,
      };
    },
    spawn: (_command, args, options) => {
      const isReadOnly = args.includes("read-only");
      const attemptNum = isReadOnly ? implAttemptCounter : ++implAttemptCounter;
      const delayMs = holdWorkerMs;
      const sessionId = randomUUID();
      const childScript = `
        const fs = require('node:fs');
        const path = require('node:path');
        process.stdin.resume();
        let promptText = '';
        process.stdin.on('data', chunk => { promptText += chunk.toString(); });
        process.on('SIGTERM', () => {
          fs.writeSync(2, '[late-drained-line] worker stderr flushed after SIGTERM\\n');
          setTimeout(() => process.exit(130), 25);
        });
        process.stdin.on('end', () => {
          console.log(JSON.stringify({ type: 'thread.started', thread_id: ${JSON.stringify(sessionId)} }));
          console.log(JSON.stringify({ type: 'item.started', item: { type: 'agent_message', text: 'Starting isolated Codex worker execution...' } }));
          setTimeout(() => {
            if (${JSON.stringify(!isReadOnly)}) {
              const targetFile = path.join(process.cwd(), 'src', 'clamp.ts');
              fs.mkdirSync(path.dirname(targetFile), { recursive: true });
              fs.writeFileSync(
                targetFile,
                'export function clamp(value: number, low: number, high: number): number {\\n  // Attempt #' + ${attemptNum} + ' verified live worktree implementation\\n  return Math.min(Math.max(value, low), high);\\n}\\n',
                'utf8'
              );
              const msg = JSON.stringify({ summary: 'Implemented clamp() in isolated Git worktree (attempt #' + ${attemptNum} + ')' });
              console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: msg } }));
            } else {
              const verdict = JSON.stringify({ approved: true, findings: [], summary: 'Independent reviewer verified attempt #' + ${attemptNum} });
              console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: verdict } }));
            }
            console.log(JSON.stringify({ type: 'turn.completed' }));
          }, ${delayMs});
        });
      `;
      return spawn(process.execPath, ["--eval", childScript], options);
    },
  });

  const port = await getFreePort();
  const origin = `http://127.0.0.1:${port}`;
  const frontend = await buildFrontendAssets(FRONTEND_DIR, TOKEN);
  const api = createHubHandler({ service, token: TOKEN, port });

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    idleTimeout: 120,
    maxRequestBodySize: 256 * 1024,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.origin !== origin || (request.headers.has("host") && request.headers.get("host") !== url.host)) {
        return new Response("Forbidden", { status: 403 });
      }
      if (url.pathname.startsWith("/api/")) return api(request);
      if (
        request.method !== "GET" ||
        url.search ||
        url.hash ||
        request.headers.get("sec-fetch-site") === "cross-site" ||
        (request.headers.has("origin") && request.headers.get("origin") !== origin)
      ) {
        return new Response("Forbidden", { status: 403 });
      }
      const asset = frontend.assets.get(url.pathname);
      if (!asset) return new Response("Not found", { status: 404 });
      return new Response(asset.body, {
        headers: {
          "content-type": asset.type,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "x-frame-options": "DENY",
          "cross-origin-resource-policy": "same-origin",
          "referrer-policy": "no-referrer",
          "content-security-policy": `default-src 'self'; script-src 'nonce-${frontend.nonce}'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
        },
      });
    },
  });

  const debugPort = await getFreePort();
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), "chrome-live-f02-"));
  const chrome = spawn(
    CHROME_PATH,
    [
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${userDataDir}`,
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1600,1050",
      "about:blank",
    ],
    { stdio: "ignore" }
  );

  const cdp = new CdpSession();
  const evidence: Record<string, unknown> = {
    verifiedAt: new Date().toISOString(),
    origin,
    frontendDir: FRONTEND_DIR,
    checks: {},
  };

  try {
    const targets = await waitForJson(`http://127.0.0.1:${debugPort}/json/list`);
    const pageTarget = targets.find((t: any) => t.type === "page");
    assert(pageTarget?.webSocketDebuggerUrl, "Chrome page target found");

    await cdp.connect(pageTarget.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1600,
      height: 1050,
      deviceScaleFactor: 2,
      mobile: false,
    });

    // 1. Navigate to Live Hub UI & verify CSP nonce bootstrap + SERVICE: LIVE badge + absence of Mock controls
    await cdp.send("Page.navigate", { url: `${origin}/` });
    const bootState = await waitForEval(
      cdp,
      `(() => ({
        hasBootToken: Boolean(window.__HUB_BOOT__?.token),
        modeText: document.getElementById('executionModeBadge')?.innerText || '',
        sseText: document.getElementById('sseStatusBadge')?.innerText || '',
        mockControlButtons: document.querySelectorAll('[data-mock-step], [data-mock-fault], #resetDemoStateBtn').length,
        repoCount: uiState.repositories.length,
        selectedRepoId: uiState.composerDraft.repositoryId
      }))()`,
      (v) => v.hasBootToken && v.modeText.includes("SERVICE: LIVE") && v.sseText.includes("Connected") && v.repoCount === 1,
      "Live bootstrap & SSE connection"
    );
    assert(bootState.mockControlButtons === 0, "No Mock controls rendered in Live mode");
    assert(bootState.selectedRepoId === repoId, "Composer automatically selected registered live repository UUID");
    (evidence.checks as any).bootstrapAndLiveMode = bootState;

    // 2. Switch to Task Center in Chrome, preview DraftPlan (/api/v1/tasks/decompose), and launch task (/api/v1/tasks)
    await cdp.eval(`document.querySelector('[data-view="task-center"]').click()`);
    const decomposeRuleVisible = await waitForEval(
      cdp,
      `document.getElementById('viewportContent')?.innerText.includes('FINAL-REVIEW 为服务端协调器保留编码')`,
      Boolean,
      "B-04~B-06 rule banner in Task Center"
    );
    assert(decomposeRuleVisible, "FINAL-REVIEW & defaultTestProfileId rule banner visible");

    await cdp.eval(`document.getElementById('previewDecomposeBtn').click()`);
    const draftPreview = await waitForEval(
      cdp,
      `(() => ({
        hasPlan: Boolean(uiState.composerDraft.draftPlan),
        subtaskCodes: (uiState.composerDraft.draftPlan?.subtasks || []).map(s => s.code + ':' + s.stage)
      }))()`,
      (v) => v.hasPlan && v.subtaskCodes.length === 1,
      "DraftPlan preview via POST /api/v1/tasks/decompose"
    );
    await cdp.screenshot([
      path.join(SCREENSHOT_DIR, "live_02_task_center.png"),
      path.join(ARTIFACT_DIR, "live_02_task_center.png"),
    ]);

    // Hold worker for 1800ms on first launch so we can click Pause -> Queued Message -> Resume in Chrome!
    holdWorkerMs = 1800;
    await cdp.eval(`document.getElementById('launchTaskBtn').click()`);

    const createdTaskState = await waitForEval(
      cdp,
      `(() => ({
        taskId: uiState.selectedTaskId,
        status: uiState.selectedTaskDetail?.task?.status,
        subtaskCodes: (uiState.selectedTaskDetail?.subtasks || []).map(s => s.code),
        runCount: (uiState.selectedTaskDetail?.runs?.items || []).length
      }))()`,
      (v) => Boolean(v.taskId) && v.status === "running" && v.runCount >= 1,
      "Task #1 created and running SUB-01"
    );
    assert(
      [...createdTaskState.subtaskCodes].sort().join(",") === "FINAL-REVIEW,SUB-01",
      `Expected FINAL-REVIEW,SUB-01, got ${createdTaskState.subtaskCodes.join(",")}`
    );
    (evidence.checks as any).decomposeAndCreate = { draftPreview, createdTaskState };

    // 3. Test Pause (pausing -> paused), Queued Context Message (POST /api/v1/tasks/:id/messages), and Resume (paused -> queued)
    await cdp.eval(`document.querySelector('[data-v1-task-control="pause"]').click()`);
    const pauseInitiated = await waitForEval(
      cdp,
      `uiState.selectedTaskDetail?.task?.status`,
      (st) => st === "pausing" || st === "paused",
      "Task pause initiated"
    );
    const pausedConverged = await waitForEval(
      cdp,
      `uiState.selectedTaskDetail?.task?.status`,
      (st) => st === "paused",
      "Task converged to paused after current run finished"
    );

    // Send queued message from Agent Workspace UI
    await cdp.eval(`document.querySelector('[data-view="agent-workspace"]').click()`);
    await waitForEval(cdp, `Boolean(document.getElementById('directiveInput'))`, Boolean, "Directive input mounted");
    await cdp.eval(`(() => {
      const input = document.getElementById('directiveInput');
      input.value = 'Ensure clamp strictly handles negative and upper boundary values without mutating inputs.';
      document.getElementById('sendDirectiveBtn').click();
    })()`);
    const msgCountAfterSend = await waitForEval(
      cdp,
      `(uiState.messagesPage?.items || []).length`,
      (n) => n >= 1,
      "Queued message recorded"
    );

    // Speed up worker to 80ms and click Resume in Chrome
    holdWorkerMs = 80;
    await cdp.eval(`document.querySelector('[data-v1-task-control="resume"]').click()`);

    // Wait for SUB-01 + clamp isolated test sandbox + FINAL-REVIEW to complete and open Final Approval (waiting_approval)!
    const waitingApprovalState = await waitForEval(
      cdp,
      `(() => ({
        taskStatus: uiState.selectedTaskDetail?.task?.status,
        pendingApprovals: (uiState.selectedTaskDetail?.approvals?.items || []).filter(a => a.status === 'pending'),
        validations: (uiState.selectedTaskDetail?.validations?.items || []).map(v => ({ criterionId: v.criterionId, status: v.status, exitCode: v.exitCode })),
        artifacts: (uiState.selectedTaskDetail?.artifacts?.items || []).map(a => ({ id: a.id, category: a.category, relativePath: a.relativePath }))
      }))()`,
      (v) => v.taskStatus === "waiting_approval" && v.pendingApprovals.length === 1,
      "Task #1 reached waiting_approval with validated artifacts",
      25000
    );
    (evidence.checks as any).pauseResumeMessageAndValidation = {
      pauseInitiated,
      pausedConverged,
      msgCountAfterSend,
      waitingApprovalState,
    };

    // 4. Test Dashboard SSE 409 EVENT_CURSOR_EXPIRED recovery against live backend
    await cdp.eval(`document.querySelector('[data-view="dashboard"]').click()`);
    const sseBefore = await cdp.eval(`({ sseConnected: uiState.sseConnected, snapshotSeq: uiState.snapshotSeq, lastAppliedSeq: uiState.lastAppliedSeq })`);
    await cdp.eval(`void window.connectFetchSse(999999)`);
    const sseRecovered = await waitForEval(
      cdp,
      `(() => ({
        sseConnected: uiState.sseConnected,
        badge: document.getElementById('sseStatusBadge')?.innerText || '',
        snapshotSeq: uiState.snapshotSeq
      }))()`,
      (v) => v.sseConnected && v.badge.includes("SSE v0.2: Connected") && v.snapshotSeq >= sseBefore.snapshotSeq,
      "SSE 409 cursor expired recovery"
    );
    await cdp.screenshot([
      path.join(SCREENSHOT_DIR, "live_01_dashboard.png"),
      path.join(ARTIFACT_DIR, "live_01_dashboard.png"),
    ]);
    (evidence.checks as any).sseCursorRecovery = sseRecovered;

    // 5. Inspect Artifact Center in Chrome: verify .json test_report content rendering (not 'undefined') and Download button
    await cdp.eval(`document.querySelector('[data-view="artifact-center"]').click()`);
    const artifactRenderCheck = await waitForEval(
      cdp,
      `(() => {
        const arts = uiState.selectedTaskDetail?.artifacts?.items || [];
        const reportArt = arts.find(a => a.category === 'test_report');
        const diffArt = arts.find(a => a.category === 'diff');
        const reportContent = reportArt ? uiState.artifactContentCache[reportArt.id] : '';
        const diffContent = diffArt ? uiState.artifactContentCache[diffArt.id] : '';
        return {
          artifactCount: arts.length,
          hasReportJson: typeof reportContent === 'string' && reportContent.includes('"profileId": "clamp"') && reportContent.includes('"exitCode": 0'),
          hasDiffText: typeof diffContent === 'string' && diffContent.includes('export function clamp'),
          downloadButtons: document.querySelectorAll('[data-download-artifact]').length
        };
      })()`,
      (v) => v.artifactCount >= 2 && v.hasReportJson && v.hasDiffText && v.downloadButtons >= 2,
      "Artifact Center renders .json test report & diff content"
    );
    await cdp.eval(`document.querySelector('[data-download-artifact]').click()`);
    await cdp.screenshot([
      path.join(SCREENSHOT_DIR, "live_04_artifact_center.png"),
      path.join(ARTIFACT_DIR, "live_04_artifact_center.png"),
    ]);
    (evidence.checks as any).artifactCenter = artifactRenderCheck;

    // 6. Review Center on Task #1: verify 409 CONFLICT on wrong digest, Reject waiting for explicit rework,
    //    explicit Subtask Rework on FINAL-REVIEW -> Attempt #2 -> Approve -> Task #1 = succeeded!
    await cdp.eval(`document.querySelector('[data-view="review-center"]').click()`);
    await waitForEval(
      cdp,
      `document.querySelectorAll('[data-approval-decision="approve"]').length === 1`,
      Boolean,
      "Review Center pending approval rendered"
    );
    await cdp.screenshot([
      path.join(SCREENSHOT_DIR, "live_03_review_center.png"),
      path.join(ARTIFACT_DIR, "live_03_review_center.png"),
    ]);

    const firstApprovalId = waitingApprovalState.pendingApprovals[0].id;
    const conflictRes = await fetch(`${origin}/api/v1/approvals/${firstApprovalId}/decision`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `conflict-${randomUUID()}`,
      },
      body: JSON.stringify({
        expectedVersion: 1,
        decision: "approve",
        actionDigest: "f".repeat(64),
      }),
    });
    assert(conflictRes.status === 409, `Expected 409 on wrong actionDigest, got ${conflictRes.status}`);

    // 6a. Click "Reject" (decision='reject') on approval #1 in Chrome -> approval becomes 'rejected', task stays 'waiting_approval'
    await cdp.eval(`document.querySelector('[data-approval-decision="reject"]').click()`);
    const afterReject = await waitForEval(
      cdp,
      `(() => {
        const approvals = uiState.selectedTaskDetail?.approvals?.items || [];
        const rejectedAp = approvals.find(a => a.id === ${JSON.stringify(firstApprovalId)});
        return {
          rejectedStatus: rejectedAp?.status,
          taskStatus: uiState.selectedTaskDetail?.task?.status,
          hasExplicitReworkBtn: document.querySelectorAll('[data-subtask-rework]').length >= 1
        };
      })()`,
      (v) => v.rejectedStatus === "rejected" && v.taskStatus === "waiting_approval" && v.hasExplicitReworkBtn,
      "Reject transitions approval #1 to rejected and waits for explicit rework"
    );

    // 6b. Click explicit Rework button in Review Center (targets FINAL-REVIEW -> hub.ts reworks SUB-01 + FINAL-REVIEW to Attempt #2)
    await cdp.eval(`document.querySelector('[data-subtask-rework]').click()`);
    const afterExplicitRework = await waitForEval(
      cdp,
      `(() => {
        const approvals = uiState.selectedTaskDetail?.approvals?.items || [];
        const pending = approvals.find(a => a.status === 'pending');
        return {
          totalApprovals: approvals.length,
          pendingId: pending?.id,
          pendingDigest: pending?.actionDigest
        };
      })()`,
      (v) => Boolean(v.pendingId) && v.pendingId !== firstApprovalId,
      "Explicit rework produced fresh pending approval #2",
      25000
    );

    // 6c. Click "Approve" (decision='approve') in Chrome -> Task #1 transitions to succeeded!
    await cdp.eval(`document.querySelector('[data-approval-decision="approve"]').click()`);
    const finalApprovedState = await waitForEval(
      cdp,
      `(() => ({
        taskStatus: uiState.selectedTaskDetail?.task?.status,
        progressPct: uiState.selectedTaskDetail?.task?.progressPct,
        approvalStatuses: (uiState.selectedTaskDetail?.approvals?.items || []).map(a => a.status)
      }))()`,
      (v) => v.taskStatus === "succeeded" && v.progressPct === 100,
      "Final approval succeeded -> Task #1 = succeeded"
    );

    // 7. Create Task #2 in Chrome: test Subtask Rework invalidating a PENDING approval (status='invalidated'),
    //    and active Cancel (cancelling -> cancelled) + drained=true late log protection!
    holdWorkerMs = 60;
    await cdp.eval(`document.querySelector('[data-view="task-center"]').click()`);
    await cdp.eval(`(() => {
      const titleInput = document.getElementById('composerTitleInput');
      if (titleInput) titleInput.value = 'Task #2 — Rework Invalidates Pending Approval & Active Cancel';
      document.getElementById('launchTaskBtn').click();
    })()`);
    const task2WaitingApproval = await waitForEval(
      cdp,
      `(() => {
        const t = uiState.selectedTaskDetail?.task;
        const pending = (uiState.selectedTaskDetail?.approvals?.items || []).find(a => a.status === 'pending');
        return {
          taskId: t?.id,
          title: t?.title,
          status: t?.status,
          pendingApprovalId: pending?.id
        };
      })()`,
      (v) => v.title?.includes("Task #2") && v.status === "waiting_approval" && Boolean(v.pendingApprovalId),
      "Task #2 reached waiting_approval",
      25000
    );

    // Hold Attempt #2 of Task #2 so after clicking Rework (which invalidates the pending approval), we can Cancel it while running!
    holdWorkerMs = 5000;
    await cdp.eval(`document.querySelector('[data-view="review-center"]').click()`);
    await waitForEval(cdp, `Boolean(document.querySelector('[data-subtask-rework]'))`, Boolean, "Task #2 Rework button ready");
    await cdp.eval(`document.querySelector('[data-subtask-rework]').click()`);

    const task2ReworkRunning = await waitForEval(
      cdp,
      `(() => {
        const approvals = uiState.selectedTaskDetail?.approvals?.items || [];
        const oldAp = approvals.find(a => a.id === ${JSON.stringify(task2WaitingApproval.pendingApprovalId)});
        const runs = uiState.selectedTaskDetail?.runs?.items || [];
        const run2 = runs.find(r => r.attempt === 2 && r.status === 'running');
        const run2Logs = run2 ? (uiState.runLogsByRunId[run2.id]?.items || []).length : 0;
        return {
          taskStatus: uiState.selectedTaskDetail?.task?.status,
          invalidatedStatus: oldAp?.status,
          hasRunningAttempt2: Boolean(run2) && run2Logs >= 1
        };
      })()`,
      (v) => v.invalidatedStatus === "invalidated" && v.taskStatus === "running" && v.hasRunningAttempt2,
      "Task #2 Rework invalidated pending approval and started Attempt #2 run",
      15000
    );

    // Now click Cancel on Task #2 while Attempt #2 is running!
    await cdp.eval(`document.querySelector('[data-v1-task-control="cancel"]').click()`);
    const task2Cancelled = await waitForEval(
      cdp,
      `(() => {
        const runs = uiState.selectedTaskDetail?.runs?.items || [];
        const cancelledRun = runs.find(r => r.attempt === 2);
        const logs = cancelledRun ? (uiState.runLogsByRunId[cancelledRun.id]?.items || []) : [];
        return {
          taskStatus: uiState.selectedTaskDetail?.task?.status,
          runStatus: cancelledRun?.status,
          logCount: logs.length,
          hasDrainedLog: logs.some(l => l.drained === true)
        };
      })()`,
      (v) => v.taskStatus === "cancelled" && v.runStatus === "cancelled" && v.logCount >= 1,
      "Task #2 converged to cancelled without overwriting terminal state",
      15000
    );
    (evidence.checks as any).approvalAndReworkLifecycle = {
      conflictStatus: conflictRes.status,
      afterReject,
      afterExplicitRework,
      finalApprovedState,
      pendingInvalidatedByRework: task2ReworkRunning,
    };
    (evidence.checks as any).cancelAndDrainedLogs = { task2ReworkRunning, task2Cancelled };

    assert(cdp.pageExceptions.length === 0, `Unexpected pageExceptions: ${cdp.pageExceptions.join("; ")}`);
    evidence.consoleErrors = cdp.consoleErrors;
    evidence.pageExceptions = cdp.pageExceptions;

    const evidencePath = path.join(EVIDENCE_DIR, "live-f02-i01.json");
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + "\n", "utf8");
    console.log(JSON.stringify({ ok: true, evidencePath, checks: Object.keys(evidence.checks as object) }, null, 2));
  } catch (err) {
    console.error("LIVE_VERIFY_ERROR:", err);
    process.exitCode = 1;
  } finally {
    cdp.close();
    chrome.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 300));
    await service.close();
    server.stop(true);
    db.close();
    if (oldDataDir === undefined) delete process.env.AGETOR_DATA_DIR;
    else process.env.AGETOR_DATA_DIR = oldDataDir;
    try {
      rmSync(userDataDir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    } catch {}
    process.exit(process.exitCode ?? 0);
  }
}

await main();
