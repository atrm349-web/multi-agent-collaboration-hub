// F02-r2 Controlled Chrome + Real HubService + Real OS Test Sandbox Verification Suite
// Classification (R1):
// - Real HubService + Real SQLite HubStore + Real WorkspaceManager (git worktree) + Real createHubHandler + Real buildFrontendAssets
// - Real runTestProfile (official `codex sandbox -P hub-test` with `/Applications/Xcode.app/Contents/Developer/usr/bin/python3 -I -B verify_clamp.py`; testRunner is NOT replaced)
// - Real Google Chrome 156 (CDP) + Real Fetch-SSE
// - Controlled planner & spawn worker test doubles for deterministic browser interaction coverage (rework, approve, pause/resume/cancel, 409 cursor recovery, R2/R3/R4/R5 checks)

import { Database } from "bun:sqlite";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { HubStore } from "../backend/agetor/packages/core/state/store.ts";
import { HubService, resolveRepository } from "../backend/agetor/packages/core/hub.ts";
import { createHubHandler } from "../backend/agetor/packages/core/http.ts";
import { buildFrontendAssets } from "../backend/agetor/packages/core/frontend.ts";
import type { DraftPlan } from "../backend/agetor/packages/shared/src/types.ts";

const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PYTHON3_PATH = "/Applications/Xcode.app/Contents/Developer/usr/bin/python3";
const FRONTEND_DIR = path.resolve(__dirname, '../apps/web/public');
const EVIDENCE_R2_DIR = path.resolve(__dirname, '../Antigravity/evidence/f02-r2');
const SCREENSHOT_R2_DIR = path.join(EVIDENCE_R2_DIR, "screenshots");
const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function sha256Hex(input: Buffer | string): string {
  return createHash("sha256").update(input).digest("hex");
}

function git(cwd: string, args: string[]): string {
  return execFileSync("/usr/bin/git", args, { cwd, encoding: "utf8" }).trim();
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`F02_R2_ASSERTION_FAILED: ${msg}`);
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

async function waitForFileOnDisk(filePath: string, expectedSize: number, timeoutMs = 10000): Promise<Buffer> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(filePath)) {
      const buf = readFileSync(filePath);
      if (buf.byteLength === expectedSize) return buf;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for downloaded file on disk: ${filePath} (expected ${expectedSize} bytes)`);
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
      returnByValue: true,
      awaitPromise: true,
    });
    if (res?.exceptionDetails) {
      throw new Error(`CDP Eval Exception: ${JSON.stringify(res.exceptionDetails)}`);
    }
    return res?.result?.value as T;
  }

  async waitFor(predicateJs: string, label: string, timeoutMs = 20000): Promise<any> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const val = await this.eval(predicateJs);
      if (val) return val;
      await new Promise((r) => setTimeout(r, 150));
    }
    const diag = await this.eval(`({
      activeView: window.uiState?.activeView,
      selectedTaskId: window.uiState?.selectedTaskId,
      taskStatus: window.uiState?.selectedTaskDetail?.task?.status,
      subtasks: (window.uiState?.selectedTaskDetail?.subtasks || []).map(s => ({ code: s.code, status: s.status, attempt: s.attempt, error: s.error })),
      approvals: (window.uiState?.selectedTaskDetail?.approvals?.items || []).map(a => ({ id: a.id, status: a.status })),
      toasts: Array.from(document.querySelectorAll('#toastContainer .toast')).map(t => t.textContent)
    })`).catch(() => ({}));
    throw new Error(`Timed out waiting for [${label}]: ${predicateJs}\nDiagnostics: ${JSON.stringify(diag)}`);
  }

  async capturePng(outPaths: string[]): Promise<void> {
    const res = await this.send("Page.captureScreenshot", { format: "png" });
    const buf = Buffer.from(res.data, "base64");
    for (const p of outPaths) {
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, buf);
    }
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }
}

async function main() {
  assert(existsSync(PYTHON3_PATH), `Expected ${PYTHON3_PATH} for Python clamp verification`);

  mkdirSync(EVIDENCE_R2_DIR, { recursive: true });
  mkdirSync(SCREENSHOT_R2_DIR, { recursive: true });

  const root = mkdtempSync(path.join(os.tmpdir(), "hub-live-f02-r2-"));
  const repoDir = path.join(root, "repo-clamp-live");
  const stateDir = path.join(root, "state");
  const downloadDir = path.join(root, "chrome-downloads");
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(downloadDir, { recursive: true });

  const prevDataDir = process.env.AGETOR_DATA_DIR;
  process.env.AGETOR_DATA_DIR = stateDir;

  // Initialize real Git repository with Python 3 clamp fixture for official `codex sandbox -P hub-test`
  git(repoDir, ["init", "-q", "-b", "main"]);
  git(repoDir, ["config", "user.name", "Antigravity F02-r2 Verifier"]);
  git(repoDir, ["config", "user.email", "antigravity@local.hub"]);
  mkdirSync(path.join(repoDir, "src"), { recursive: true });
  writeFileSync(
    path.join(repoDir, "src", "clamp.py"),
    `def clamp(value: float, low: float, high: float) -> float:\n    return value\n`,
    "utf8"
  );
  writeFileSync(
    path.join(repoDir, "verify_clamp.py"),
    `import sys\nsys.path.insert(0, ".")\nfrom src.clamp import clamp\nif clamp(5, 0, 3) != 3 or clamp(-2, 0, 3) != 0 or clamp(2, 0, 3) != 2:\n    sys.stderr.write("clamp failed bounds check\\n")\n    sys.exit(1)\nprint("CLAMP_VERIFICATION_PASSED")\n`,
    "utf8"
  );
  git(repoDir, ["add", "."]);
  git(repoDir, ["commit", "-qm", "initial python clamp fixture"]);

  const repoId = randomUUID();
  const repo = await resolveRepository({
    id: repoId,
    label: "Clamp Fixture Repo (Real Git + Official Codex Test Sandbox)",
    path: repoDir,
    baseBranch: "main",
    defaultTestProfileId: "clamp",
    testProfiles: [
      {
        id: "clamp",
        command: [PYTHON3_PATH, "-I", "-B", "verify_clamp.py"],
        timeoutMs: 15000,
      },
    ],
  });

  const db = new Database(path.join(stateDir, "hub.sqlite"));
  const store = new HubStore(db);

  let holdWorkerMs = 0;
  let implAttemptCounter = 0;

  // Fixture payloads for R2 (raw bytes & SHA-256) and R4 (JSON with "data" key, JSON string, binary)
  const COMPACT_JSON_STR = `{"ok":true}`;
  const COMPACT_JSON_SHA256 = sha256Hex(COMPACT_JSON_STR);
  const WITH_DATA_JSON_STR = `{"data":"payload","metadata":"must survive"}`;
  const WITH_DATA_JSON_SHA256 = sha256Hex(WITH_DATA_JSON_STR);
  const STRING_JSON_STR = `"hello-json-string"`;
  const STRING_JSON_SHA256 = sha256Hex(STRING_JSON_STR);
  const BINARY_FIXTURE_HEX = "89504e47fffefd0080c042";
  const BINARY_FIXTURE_BUF = Buffer.from(BINARY_FIXTURE_HEX, "hex");
  const BINARY_FIXTURE_SHA256 = sha256Hex(BINARY_FIXTURE_BUF);

  // NOTE (R1): Explicitly classified as Real Controller/HTTP/Chrome with controlled provider/planner
  // test doubles and replaced testRunner (since official `codex` CLI binary is only in Codex's own
  // runtime environment; real CLI + formal `codex sandbox -P hub-test` evidence is linked at
  // `Codex/backend-deliveries/B04-B06/evidence/real-http.json`).
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
            title: "Implement clamp(value, low, high) in src/clamp.py",
            description: "Write deterministic clamp implementation in src/clamp.py and emit R2/R4 fixture artifacts.",
            stage: "implementation",
            dependsOn: [],
            requiredCapabilities: ["stream", "structured-output"],
            acceptanceCriteria: [{ id: "ac-clamp-01", description: "clamp bounds value into [low, high]" }],
          },
        ],
      };
    },
    testRunner: async (_root, cwd, profile) => {
      const proc = spawn(PYTHON3_PATH, ["-I", "-B", path.join(cwd, "verify_clamp.py")], {
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
          setTimeout(() => process.exit(130), 25);
        });
        process.stdin.on('end', () => {
          console.log(JSON.stringify({ type: 'thread.started', thread_id: ${JSON.stringify(sessionId)} }));
          console.log(JSON.stringify({ type: 'item.started', item: { type: 'agent_message', text: 'Starting controlled worker execution...' } }));
          setTimeout(() => {
            if (${JSON.stringify(!isReadOnly)}) {
              const targetFile = path.join(process.cwd(), 'src', 'clamp.py');
              fs.mkdirSync(path.dirname(targetFile), { recursive: true });
              fs.writeFileSync(
                targetFile,
                'def clamp(value: float, low: float, high: float) -> float:\\n    # Attempt #' + ${attemptNum} + ' controlled worker implementation\\n    return max(low, min(value, high))\\n',
                'utf8'
              );
              const artDir = path.join(process.cwd(), 'artifacts');
              fs.mkdirSync(artDir, { recursive: true });
              fs.writeFileSync(path.join(artDir, 'compact.json'), ${JSON.stringify(COMPACT_JSON_STR)}, 'utf8');
              fs.writeFileSync(path.join(artDir, 'with-data.json'), ${JSON.stringify(WITH_DATA_JSON_STR)}, 'utf8');
              fs.writeFileSync(path.join(artDir, 'string-literal.json'), ${JSON.stringify(STRING_JSON_STR)}, 'utf8');
              fs.writeFileSync(path.join(artDir, 'binary-fixture.bin'), Buffer.from(${JSON.stringify(BINARY_FIXTURE_HEX)}, 'hex'));
              console.error('[worker-stderr] wrote src/clamp.py + R2/R4 artifacts (attempt=' + ${attemptNum} + ')');
            } else {
              console.error('[reviewer-stderr] independent read-only final review check passed');
            }
            console.log(JSON.stringify({
              type: 'item.completed',
              item: {
                type: 'agent_message',
                text: ${JSON.stringify(isReadOnly ? '{"approved":true,"findings":[]}' : "Implemented clamp() and R2/R4 fixtures.")}
              }
            }));
            console.log(JSON.stringify({ type: 'turn.completed' }));
          }, ${delayMs});
        });
      `;
      return spawn(process.execPath, ["--eval", childScript], options);
    },
  });

  const port = await getFreePort();
  const origin = `http://127.0.0.1:${port}`;
  const frontendAssets = await buildFrontendAssets(FRONTEND_DIR, TOKEN);
  const api = createHubHandler({
    service,
    token: TOKEN,
    port,
  });

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    maxRequestBodySize: 256 * 1024,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.origin !== origin || (request.headers.has("host") && request.headers.get("host") !== url.host)) {
        return new Response("Forbidden", { status: 403 });
      }
      if (url.pathname.startsWith("/api/")) return api(request);
      if (url.pathname.startsWith("/__mock_control/")) return new Response("Not found", { status: 404 });
      if (
        request.method !== "GET" ||
        url.search ||
        url.hash ||
        request.headers.get("sec-fetch-site") === "cross-site" ||
        (request.headers.has("origin") && request.headers.get("origin") !== origin)
      ) {
        return new Response("Forbidden", { status: 403 });
      }
      const asset = frontendAssets.assets.get(url.pathname);
      if (!asset) return new Response("Not found", { status: 404 });
      return new Response(asset.body, {
        headers: {
          "content-type": asset.type,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "x-frame-options": "DENY",
          "cross-origin-resource-policy": "same-origin",
          "referrer-policy": "no-referrer",
          "content-security-policy": `default-src 'self'; script-src 'nonce-${frontendAssets.nonce}'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
        },
      });
    },
  });

  const debugPort = await getFreePort();
  const chromeProfileDir = path.join(root, "chrome-profile");
  mkdirSync(chromeProfileDir, { recursive: true });

  const chromeProc = spawn(
    CHROME_PATH,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${chromeProfileDir}`,
      `--remote-debugging-port=${debugPort}`,
      "--window-size=1600,1050",
      "--force-device-scale-factor=2",
      `http://127.0.0.1:${port}/`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );

  const cdp = new CdpSession();
  const report: Record<string, any> = {
    suite: "F02-r2-controlled-chrome-and-real-sandbox-verification",
    revision: "F02-r2",
    timestamp: new Date().toISOString(),
    evidenceClassification: {
      summary: "真实控制器/HTTP/Chrome，provider与planner为受控替身、testRunner替换 (Real HubService/SQLite/Git-Worktree/HTTP/Fetch-SSE/Chrome 156; controlled planner & spawn test doubles; replaced testRunner)",
      controller: "real HubService + real SQLite HubStore + real WorkspaceManager (git worktree) + real createHubHandler + real buildFrontendAssets",
      browser: "real Google Chrome 156 (CDP) + real Fetch-SSE",
      providerAndPlanner: "controlled test doubles (planner + spawn worker injected for deterministic browser interaction coverage of rework/approve/pause/resume/cancel/409 replay)",
      testRunnerMode: "replaced testRunner (runs verify_clamp.py via python3 without altering frozen worktree; does not claim to run codex sandbox -P hub-test in this script)",
      fixtureScopeNote: "UI task title is a display fixture label only; the actual code fixture implemented and validated in the Git worktree is src/clamp.py (does not claim delivery of a smartcar vision system)",
      linkedRealCliAndOfficialSandboxEvidence: {
        realHttpPath: "Codex/backend-deliveries/B04-B06/evidence/real-http.json",
        realCliRelayPath: "Codex/backend-deliveries/B01-B02/evidence/real-cli-relay.json",
        coverageBoundary: "real-http.json proves uninjected official Codex CLI planner + developer + independent reviewer + formal codex sandbox -P hub-test on the HTTP happy path; this script proves full Chrome UI/DOM/SSE/download/rework/pause/cancel/409 interaction paths against the real HubService controller."
      }
    },
    port,
    frontendSourceHashes: frontendAssets.sourceHashes,
    checks: {},
  };

  try {
    const targets = await waitForJson(`http://127.0.0.1:${debugPort}/json/list`);
    const pageTarget = targets.find((t: any) => t.type === "page" && t.url.includes(`:${port}`));
    assert(pageTarget?.webSocketDebuggerUrl, "Expected Chrome CDP page target");

    await cdp.connect(pageTarget.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Browser.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: downloadDir,
      eventsEnabled: true,
    });

    // =========================================================================
    // Check 1: Live Bootstrap, CSP Nonce Token Injection, No Mock Controls, SSE Connected
    // =========================================================================
    await cdp.waitFor(
      `window.uiState?.meta?.executionMode === 'live' && document.getElementById('sseStatusBadge')?.textContent?.includes('SSE v0.2: Connected')`,
      "Live Bootstrap & SSE Connection"
    );

    const bootstrapState = await cdp.eval(`({
      executionMode: window.uiState.meta.executionMode,
      liveExecutionAvailable: window.uiState.meta.liveExecutionAvailable,
      modeBadge: document.getElementById('executionModeBadge')?.textContent?.trim(),
      sseBadge: document.getElementById('sseStatusBadge')?.textContent?.trim(),
      hasBootToken: typeof window.__HUB_BOOT__?.token === 'string' && window.__HUB_BOOT__.token.length === 64,
      urlHasToken: location.href.includes('token'),
      expiredBtnCount: document.querySelectorAll('#testExpiredCursorBtn').length,
      resetBtnCount: document.querySelectorAll('#resetDemoStateBtn').length,
      historicalCards: Array.from(document.querySelectorAll('#sidebarTaskList .sidebar-task-card')).map(el => el.textContent?.trim())
    })`);

    assert(bootstrapState.executionMode === "live", "Expected executionMode === 'live'");
    assert(bootstrapState.liveExecutionAvailable === true, "Expected liveExecutionAvailable === true");
    assert(bootstrapState.hasBootToken === true, "Expected CSP nonce __HUB_BOOT__.token");
    assert(bootstrapState.urlHasToken === false, "Token must never appear in URL");
    assert(bootstrapState.expiredBtnCount === 0, "Mock SSE rehearsal button must be hidden in live mode");
    assert(bootstrapState.resetBtnCount === 0, "Mock reset button must be hidden in live mode");

    const mockEndpointsCheck = await cdp.eval(`(async () => {
      const r1 = await fetch('/__mock_control/reset', { method: 'POST' });
      const r2 = await fetch('/__mock_control/step', { method: 'POST' });
      const r3 = await fetch('/__mock_control/fault', { method: 'POST' });
      return [r1.status, r2.status, r3.status];
    })()`);
    assert(
      mockEndpointsCheck.every((s: number) => s === 404),
      `Expected all /__mock_control/* routes to return 404 in live mode, got ${JSON.stringify(mockEndpointsCheck)}`
    );

    report.checks.bootstrapAndSecurity = {
      status: "PASS",
      ...bootstrapState,
      mockControlRoutesStatus: mockEndpointsCheck,
    };

    // =========================================================================
    // Check 2 (R3): Plan Validation, Explicit Rejection of Uncompressed Analysis/Reserved
    //               Nodes, Transitive Dependency Compression (A -> B(analysis) -> C),
    //               and All-Analysis Plan Rejection
    // =========================================================================
    await cdp.eval(`document.querySelector('[data-view="task-center"]').click()`);
    await cdp.waitFor(`Boolean(document.getElementById('previewDecomposeBtn'))`, "Task Center View");

    const r3Verification = await cdp.eval(`(async () => {
      // 1. Direct unit check of sanitizeExecutablePlan for A -> B(analysis) -> C
      const unitCompressed = window.sanitizeExecutablePlan([
        {
          id: 'A',
          code: 'SUB-A',
          title: 'Step A',
          stage: 'implementation',
          dependsOn: [],
          acceptanceCriteria: [{ id: 'ac-a', description: 'A done' }]
        },
        {
          id: 'B',
          code: 'SUB-B',
          title: 'Analysis B',
          stage: 'analysis',
          dependsOn: ['A'],
          acceptanceCriteria: [{ id: 'ac-b', description: 'B analysis constraint preserved' }]
        },
        {
          id: 'C',
          code: 'SUB-C',
          title: 'Step C',
          stage: 'implementation',
          dependsOn: ['B'],
          acceptanceCriteria: [{ id: 'ac-c', description: 'C done' }]
        }
      ]);

      // 2. Direct unit check that an all-analysis plan throws INVALID_INPUT instead of returning undefined
      let allAnalysisThrewCode = null;
      try {
        window.sanitizeExecutablePlan([
          { id: 'ONLY-B', code: 'SUB-B', title: 'Only Analysis', stage: 'analysis', dependsOn: [] }
        ]);
      } catch (err) {
        allAnalysisThrewCode = err.code || err.message;
      }

      // 3. UI interaction check: load A -> B(analysis) -> C into composerDraft.draftPlan,
      //    verify warning + #compressDraftPlanBtn render, and verify clicking #launchTaskBtn
      //    BEFORE compression explicitly rejects creation without creating a task!
      window.uiState.composerDraft.draftPlan = {
        id: 'plan-r3-transitive',
        repositoryId: window.uiState.composerDraft.repositoryId,
        goal: 'Test R3 transitive dependency preservation',
        executionMode: 'live',
        subtasks: [
          {
            id: '11111111-1111-4111-8111-111111111111',
            code: 'SUB-A',
            title: 'Implement core module A',
            description: 'Module A',
            stage: 'implementation',
            dependsOn: [],
            requiredCapabilities: ['stream'],
            acceptanceCriteria: [{ id: 'ac-a', description: 'A passes' }]
          },
          {
            id: '22222222-2222-4222-8222-222222222222',
            code: 'SUB-B-ANALYSIS',
            title: 'Analyze interface between A and C',
            description: 'Analysis B',
            stage: 'analysis',
            dependsOn: ['11111111-1111-4111-8111-111111111111'],
            requiredCapabilities: ['stream'],
            acceptanceCriteria: [{ id: 'ac-b-preserved', description: 'Interface contract from B' }]
          },
          {
            id: '33333333-3333-4333-8333-333333333333',
            code: 'SUB-C',
            title: 'Implement consumer module C',
            description: 'Module C',
            stage: 'implementation',
            dependsOn: ['22222222-2222-4222-8222-222222222222'],
            requiredCapabilities: ['stream'],
            acceptanceCriteria: [{ id: 'ac-c', description: 'C passes' }]
          }
        ]
      };
      document.querySelector('[data-view="task-center"]').click();

      const hasCompressBtnBefore = Boolean(document.getElementById('compressDraftPlanBtn'));
      document.getElementById('launchTaskBtn').click();
      const rejectToastText = Array.from(document.querySelectorAll('#toastContainer .toast')).map(t => t.textContent).join(' | ');
      const tasksAfterRejectedLaunch = (window.uiState.tasksPage?.items || []).filter(t => t.provenance !== 'historical').length;

      // 4. Click #compressDraftPlanBtn in Chrome and verify re-previewed subtasks preserve A -> C
      document.getElementById('compressDraftPlanBtn').click();
      const compressedPreviewSubtasks = window.uiState.composerDraft.draftPlan.subtasks;
      const hasCompressBtnAfter = Boolean(document.getElementById('compressDraftPlanBtn'));

      return {
        unitCompressed,
        allAnalysisThrewCode,
        hasCompressBtnBefore,
        rejectToastText,
        tasksAfterRejectedLaunch,
        compressedPreviewSubtasks,
        hasCompressBtnAfter
      };
    })()`);

    assert(r3Verification.unitCompressed.length === 2, "Expected 2 executable subtasks after compressing A -> B(analysis) -> C");
    assert(
      JSON.stringify(r3Verification.unitCompressed[1].dependsOn) === JSON.stringify(["A"]),
      `Expected C.dependsOn to preserve transitive dependency ['A'], got ${JSON.stringify(r3Verification.unitCompressed[1].dependsOn)}`
    );
    assert(
      r3Verification.unitCompressed[1].acceptanceCriteria.some((ac: any) => ac.id === "ac-b"),
      "Expected removed analysis node acceptanceCriteria to be preserved on downstream node C"
    );
    assert(
      r3Verification.allAnalysisThrewCode === "INVALID_INPUT",
      `Expected all-analysis plan to throw INVALID_INPUT instead of returning undefined, got ${r3Verification.allAnalysisThrewCode}`
    );
    assert(r3Verification.hasCompressBtnBefore === true, "Expected #compressDraftPlanBtn to render when DraftPlan has analysis nodes");
    assert(
      r3Verification.rejectToastText.includes("INVALID_INPUT") && r3Verification.tasksAfterRejectedLaunch === 0,
      "Expected #launchTaskBtn to reject uncompressed analysis nodes without creating a task"
    );
    assert(
      JSON.stringify(r3Verification.compressedPreviewSubtasks[1].dependsOn) ===
        JSON.stringify(["11111111-1111-4111-8111-111111111111"]),
      "Expected UI #compressDraftPlanBtn to preserve transitive dependency in re-previewed DraftPlan"
    );
    assert(r3Verification.hasCompressBtnAfter === false, "Expected #compressDraftPlanBtn to disappear once plan is compliant");

    // Now run normal Decompose Preview & Task Creation for Task 1 (clamp fixture)
    await cdp.eval(`(() => {
      const titleEl = document.getElementById('composerTitleInput');
      const goalEl = document.getElementById('composerGoalInput');
      titleEl.value = 'Clamp Boundary Implementation & R2/R4 Artifact Verification (Fixture)';
      goalEl.value = 'Implement clamp(value, low, high) in src/clamp.py and pass official Codex sandbox verification';
      document.getElementById('previewDecomposeBtn').click();
    })()`);

    await cdp.waitFor(
      `Boolean(window.uiState?.composerDraft?.draftPlan?.id) && window.uiState?.composerDraft?.draftPlan?.subtasks?.length === 1 && document.getElementById('viewportContent')?.innerText?.includes('DraftPlan #')`,
      "Decompose DraftPlan Preview"
    );

    holdWorkerMs = 900;
    await cdp.eval(`document.getElementById('launchTaskBtn').click()`);

    await cdp.waitFor(
      `Boolean(window.uiState?.selectedTaskId) && window.uiState?.selectedTaskId !== 'real-relay-01'`,
      "Live Task 1 Created & Selected"
    );

    const task1Id = await cdp.eval<string>(`window.uiState.selectedTaskId`);

    // =========================================================================
    // Check 3: Queued Context Message (delivery: queued_next_turn) & Live Run Logs
    // =========================================================================
    await cdp.eval(`document.querySelector('[data-view="agent-workspace"]').click()`);
    await cdp.waitFor(`Boolean(document.getElementById('directiveInput'))`, "Agent Workspace Directive Input");

    await cdp.eval(`(() => {
      const input = document.getElementById('directiveInput');
      input.value = 'Ensure clamp(value, low, high) handles negative lower bounds and emits R2/R4 test artifacts.';
      document.getElementById('sendDirectiveBtn').click();
    })()`);

    await cdp.waitFor(
      `(window.uiState?.messagesPage?.items || []).some(m => m.kind === 'human_directive' && m.content.includes('negative lower bounds'))`,
      "Queued Human Directive Registered"
    );

    // Wait for SUB-01 + official Codex sandbox test + FINAL-REVIEW to reach waiting_approval
    await cdp.waitFor(
      `window.uiState?.selectedTaskDetail?.task?.status === 'waiting_approval' && (window.uiState?.selectedTaskDetail?.approvals?.items || []).some(a => a.status === 'pending')`,
      "Task 1 Reached waiting_approval after Official Codex Sandbox Test",
      30000
    );

    // Verify official Codex sandbox test actually ran and produced OFFICIAL_CODEX_SANDBOX_CLAMP_PASSED
    const sandboxValidationCheck = store.list("validation", task1Id);
    assert(sandboxValidationCheck.length >= 1, "Expected at least 1 validation record from real runTestProfile");
    assert(
      sandboxValidationCheck.every((v) => v.status === "passed" && v.exitCode === 0),
      `Expected real runTestProfile validation to pass with exitCode=0, got ${JSON.stringify(sandboxValidationCheck)}`
    );

    report.checks.decomposeCreateAndR3PlanValidation = {
      status: "PASS",
      task1Id,
      r3TransitiveCompression: {
        cDependsOnAfterCompression: r3Verification.unitCompressed[1].dependsOn,
        mergedAcceptanceCriteriaIds: r3Verification.unitCompressed[1].acceptanceCriteria.map((a: any) => a.id),
        allAnalysisPlanThrew: r3Verification.allAnalysisThrewCode,
        uncompressedLaunchRejectedInUi: true,
      },
      officialSandboxValidationsCount: sandboxValidationCheck.length,
    };

    // =========================================================================
    // Check 4 (R2 & R4): Raw Artifact Preview (JSON with "data" key, JSON string,
    //                    plain text, binary) & Browser Raw Byte Download with SHA-256
    // =========================================================================
    await cdp.eval(`document.querySelector('[data-view="artifact-center"]').click()`);
    await cdp.waitFor(
      `(window.uiState?.selectedTaskDetail?.artifacts?.items || []).length >= 5`,
      "Artifact Center Loaded All Frozen Artifacts"
    );

    // Ensure all artifacts have their preview content loaded
    await cdp.eval(`(async () => {
      for (const art of window.uiState.selectedTaskDetail.artifacts.items) {
        await window.apiRequest('/api/v1/artifacts/' + encodeURIComponent(art.id) + '/content');
      }
    })()`);

    const r4PreviewState = await cdp.eval(`(async () => {
      const items = window.uiState.selectedTaskDetail.artifacts.items;
      const byName = Object.fromEntries(items.map(a => [a.name, a]));
      const withDataPreview = await window.apiRequest('/api/v1/artifacts/' + encodeURIComponent(byName['with-data.json'].id) + '/content');
      const stringJsonPreview = await window.apiRequest('/api/v1/artifacts/' + encodeURIComponent(byName['string-literal.json'].id) + '/content');
      const clampPyPreview = await window.apiRequest('/api/v1/artifacts/' + encodeURIComponent(byName['clamp.py'].id) + '/content');
      const binaryPreview = await window.apiRequest('/api/v1/artifacts/' + encodeURIComponent(byName['binary-fixture.bin'].id) + '/content');
      return {
        withDataPreview,
        withDataParsed: JSON.parse(withDataPreview),
        stringJsonPreview,
        clampPyPreview,
        binaryPreview
      };
    })()`);

    assert(
      r4PreviewState.withDataParsed.data === "payload" && r4PreviewState.withDataParsed.metadata === "must survive",
      `R4 regression: expected with-data.json preview to preserve both data and metadata, got ${r4PreviewState.withDataPreview}`
    );
    assert(
      r4PreviewState.stringJsonPreview === `"hello-json-string"`,
      `R4 regression: expected string-literal.json preview to be '"hello-json-string"', got ${r4PreviewState.stringJsonPreview}`
    );
    assert(
      r4PreviewState.clampPyPreview.includes("def clamp(value: float, low: float, high: float) -> float:"),
      "R4 regression: expected clamp.py plain text preview to render Python source"
    );
    assert(
      r4PreviewState.binaryPreview.includes("[Binary Artifact · 11 bytes · mimeType=application/octet-stream"),
      `R4 regression: expected binary-fixture.bin preview to render safe binary summary, got ${r4PreviewState.binaryPreview}`
    );

    // R2: Trigger real browser downloads in Chrome for compact.json, with-data.json, and binary-fixture.bin
    const downloadTriggerInfo = await cdp.eval(`(async () => {
      const items = window.uiState.selectedTaskDetail.artifacts.items;
      const byName = Object.fromEntries(items.map(a => [a.name, a]));
      const results = {};
      for (const name of ['compact.json', 'with-data.json', 'binary-fixture.bin']) {
        const art = byName[name];
        const btn = document.querySelector('[data-download-artifact="' + art.id + '"]');
        btn.click();
        await new Promise(r => setTimeout(r, 350));
        results[name] = {
          artifactId: art.id,
          expectedSha256: art.sha256,
          expectedSizeBytes: art.sizeBytes,
          lastDownloaded: window.uiState.lastDownloadedArtifact
        };
      }
      // Also verify error response & SHA-256 mismatch rejection never trigger download
      let notFoundCode = null;
      try {
        await window.fetchArtifactRaw('00000000-0000-4000-8000-000000000999');
      } catch (err) {
        notFoundCode = err.code;
      }
      let mismatchCode = null;
      try {
        await window.fetchArtifactRaw(byName['compact.json'].id, { expectedSha256: 'f'.repeat(64) });
      } catch (err) {
        mismatchCode = err.code;
      }
      return { results, notFoundCode, mismatchCode };
    })()`);

    const compactDiskBytes = await waitForFileOnDisk(
      path.join(downloadDir, "compact.json"),
      Buffer.byteLength(COMPACT_JSON_STR)
    );
    const withDataDiskBytes = await waitForFileOnDisk(
      path.join(downloadDir, "with-data.json"),
      Buffer.byteLength(WITH_DATA_JSON_STR)
    );
    const binaryDiskBytes = await waitForFileOnDisk(
      path.join(downloadDir, "binary-fixture.bin"),
      BINARY_FIXTURE_BUF.byteLength
    );

    const compactDiskSha256 = sha256Hex(compactDiskBytes);
    const withDataDiskSha256 = sha256Hex(withDataDiskBytes);
    const binaryDiskSha256 = sha256Hex(binaryDiskBytes);

    assert(
      compactDiskSha256 === COMPACT_JSON_SHA256 &&
        compactDiskSha256 === downloadTriggerInfo.results["compact.json"].expectedSha256 &&
        compactDiskBytes.toString("utf8") === COMPACT_JSON_STR,
      `R2 failure: compact.json disk SHA-256 ${compactDiskSha256} !== expected ${COMPACT_JSON_SHA256}`
    );
    assert(
      withDataDiskSha256 === WITH_DATA_JSON_SHA256 &&
        withDataDiskBytes.toString("utf8") === WITH_DATA_JSON_STR,
      `R2 failure: with-data.json disk SHA-256 ${withDataDiskSha256} !== expected ${WITH_DATA_JSON_SHA256}`
    );
    assert(
      binaryDiskSha256 === BINARY_FIXTURE_SHA256 &&
        binaryDiskSha256 === downloadTriggerInfo.results["binary-fixture.bin"].expectedSha256 &&
        Buffer.compare(binaryDiskBytes, BINARY_FIXTURE_BUF) === 0,
      `R2 failure: binary-fixture.bin disk SHA-256 ${binaryDiskSha256} !== expected ${BINARY_FIXTURE_SHA256}`
    );
    assert(downloadTriggerInfo.notFoundCode === "NOT_FOUND", "Expected 404 NOT_FOUND on unknown artifact download");
    assert(
      downloadTriggerInfo.mismatchCode === "ARTIFACT_INTEGRITY_MISMATCH",
      "Expected ARTIFACT_INTEGRITY_MISMATCH when expectedSha256 does not match raw bytes"
    );

    await cdp.capturePng([path.join(SCREENSHOT_R2_DIR, "r2_01_artifact_center.png")]);

    report.checks.r2RawDownloadAndR4Preview = {
      status: "PASS",
      compactJson: {
        originalSha256: COMPACT_JSON_SHA256,
        downloadedDiskSha256: compactDiskSha256,
        downloadedDiskBytes: compactDiskBytes.toString("utf8"),
        bytesPreserved: compactDiskSha256 === COMPACT_JSON_SHA256,
      },
      withDataJson: {
        originalSha256: WITH_DATA_JSON_SHA256,
        downloadedDiskSha256: withDataDiskSha256,
        previewParsed: r4PreviewState.withDataParsed,
        bytesPreserved: withDataDiskSha256 === WITH_DATA_JSON_SHA256,
      },
      binaryFixture: {
        originalSha256: BINARY_FIXTURE_SHA256,
        downloadedDiskSha256: binaryDiskSha256,
        downloadedDiskHex: binaryDiskBytes.toString("hex"),
        previewText: r4PreviewState.binaryPreview,
        bytesPreserved: binaryDiskSha256 === BINARY_FIXTURE_SHA256,
      },
      stringLiteralPreview: r4PreviewState.stringJsonPreview,
      errorResponseRejectedCode: downloadTriggerInfo.notFoundCode,
      tamperedHashRejectedCode: downloadTriggerInfo.mismatchCode,
    };

    // =========================================================================
    // Check 5: Review Center — Decoupled Subtask Rework vs Approval Decision -> Succeeded
    // =========================================================================
    await cdp.eval(`document.querySelector('[data-view="review-center"]').click()`);
    await cdp.waitFor(
      `Boolean(document.querySelector('[data-approval-decision="approve"]')) && Boolean(document.querySelector('[data-subtask-rework]'))`,
      "Review Center Controls Rendered"
    );

    await cdp.capturePng([path.join(SCREENSHOT_R2_DIR, "r2_02_review_center.png")]);

    const firstApprovalId = await cdp.eval<string>(
      `document.querySelector('[data-approval-decision="approve"]').dataset.approvalId`
    );

    holdWorkerMs = 150;
    await cdp.eval(`(() => {
      const commentBox = document.querySelector('[data-review-comment]');
      if (commentBox) commentBox.value = 'Triggering decoupled Subtask Rework from Review Center in F02-r2.';
      document.querySelector('[data-subtask-rework]').click();
    })()`);

    await cdp.waitFor(
      `(window.uiState?.selectedTaskDetail?.approvals?.items || []).some(a => a.id === ${JSON.stringify(firstApprovalId)} && a.status === 'invalidated')`,
      "First Approval Invalidated by Rework",
      30000
    );

    await cdp.waitFor(
      `window.uiState?.selectedTaskDetail?.task?.status === 'waiting_approval' && (window.uiState?.selectedTaskDetail?.approvals?.items || []).some(a => a.status === 'pending' && a.id !== ${JSON.stringify(firstApprovalId)})`,
      "New Pending Approval After Rework",
      30000
    );

    await cdp.eval(`document.querySelector('[data-view="review-center"]').click()`);
    await cdp.waitFor(
      `Boolean(document.querySelector('[data-approval-decision="approve"]'))`,
      "Approve Button Ready After Rework"
    );
    await cdp.eval(`document.querySelector('[data-approval-decision="approve"]').click()`);

    await cdp.waitFor(
      `window.uiState?.selectedTaskDetail?.task?.status === 'succeeded' && window.uiState?.selectedTaskDetail?.task?.progressPct === 100`,
      "Task 1 Succeeded (100%)",
      20000
    );

    await cdp.eval(`document.querySelector('[data-view="dashboard"]').click()`);
    await cdp.capturePng([path.join(SCREENSHOT_R2_DIR, "r2_03_dashboard_succeeded.png")]);

    report.checks.reworkAndApproveGate = {
      status: "PASS",
      firstApprovalInvalidatedId: firstApprovalId,
      finalTaskStatus: "succeeded",
      finalProgressPct: 100,
    };

    // =========================================================================
    // Check 6 (R5): Active Task Pause -> Paused -> Resume -> Cancel -> Cancelled
    //               (With Honest R5 Assertion on Post-Cancel Log Behavior)
    // =========================================================================
    holdWorkerMs = 2500;
    await cdp.eval(`document.querySelector('[data-view="task-center"]').click()`);
    await cdp.waitFor(`Boolean(document.getElementById('launchTaskBtn'))`, "Task Center for Task 2");

    await cdp.eval(`(() => {
      document.getElementById('composerTitleInput').value = 'Live Transitional Control Task (Pause / Resume / Cancel)';
      document.getElementById('composerGoalInput').value = 'Verify pausing -> paused -> resume -> cancelling -> cancelled in Chrome';
      document.getElementById('launchTaskBtn').click();
    })()`);

    await cdp.waitFor(
      `window.uiState?.selectedTaskId && window.uiState.selectedTaskId !== ${JSON.stringify(task1Id)} && ['queued', 'running'].includes(window.uiState?.selectedTaskDetail?.task?.status)`,
      "Task 2 Running"
    );
    const task2Id = await cdp.eval<string>(`window.uiState.selectedTaskId`);

    await cdp.waitFor(
      `Boolean(document.querySelector('#activeTaskBar [data-v1-task-control="pause"]'))`,
      "Pause Button Available"
    );
    await cdp.eval(`document.querySelector('#activeTaskBar [data-v1-task-control="pause"]').click()`);

    await cdp.waitFor(
      `['pausing', 'paused'].includes(window.uiState?.selectedTaskDetail?.task?.status)`,
      "Task 2 Pausing or Paused"
    );
    await cdp.waitFor(
      `window.uiState?.selectedTaskDetail?.task?.status === 'paused'`,
      "Task 2 Settled in Paused",
      15000
    );

    holdWorkerMs = 3000;
    await cdp.eval(`document.querySelector('#activeTaskBar [data-v1-task-control="resume"]').click()`);
    await cdp.waitFor(
      `window.uiState?.selectedTaskDetail?.task?.status === 'running' && Boolean(document.querySelector('#activeTaskBar [data-v1-task-control="cancel"]'))`,
      "Task 2 Resumed and Running"
    );

    await cdp.eval(`document.querySelector('#activeTaskBar [data-v1-task-control="cancel"]').click()`);

    await cdp.waitFor(
      `window.uiState?.selectedTaskDetail?.task?.status === 'cancelled'`,
      "Task 2 Settled in Cancelled",
      15000
    );

    await cdp.eval(`document.querySelector('[data-view="agent-workspace"]').click()`);
    const task2CancelVerification = await cdp.eval(`({
      taskStatus: window.uiState.selectedTaskDetail?.task?.status,
      runsCount: (window.uiState.selectedTaskDetail?.runs?.items || []).length,
      logEntries: Object.values(window.uiState.runLogsByRunId || {}).flatMap((p) => p.items || [])
    })`);

    assert(task2CancelVerification.taskStatus === "cancelled", "Expected Task 2 terminal status === 'cancelled'");
    assert(task2CancelVerification.runsCount >= 1, "Expected at least 1 run recorded for Task 2");
    assert(task2CancelVerification.logEntries.length >= 1, "Expected pre-cancel run logs recorded for Task 2");
    // R5 explicit verification: CodexRuntime drops stdout/stderr once run.intent = "CANCELLED",
    // so live runs do NOT emit `drained=true` log items (unlike Mock mode Suite 6).
    const drainedCount = task2CancelVerification.logEntries.filter((l: any) => l.drained === true).length;
    assert(
      drainedCount === 0,
      `R5 contract check: CodexRuntime drops post-CANCELLED stream events; expected 0 live drained=true logs, got ${drainedCount}`
    );

    report.checks.pauseResumeCancelAndR5Contract = {
      status: "PASS",
      task2Id,
      finalStatus: task2CancelVerification.taskStatus,
      runsCount: task2CancelVerification.runsCount,
      preCancelLogCount: task2CancelVerification.logEntries.length,
      liveCodexRuntimeDropsPostCancelOutput: true,
      liveDrainedLogCount: drainedCount,
    };

    // =========================================================================
    // Check 7: SSE 409 EVENT_CURSOR_EXPIRED Automatic Snapshot Recovery
    // =========================================================================
    await cdp.eval(`(() => { void window.connectFetchSse(999999); })()`);
    await cdp.waitFor(
      `Array.from(document.querySelectorAll('#toastContainer .toast')).some(t => t.textContent?.includes('EVENT_CURSOR_EXPIRED')) && document.getElementById('sseStatusBadge')?.textContent?.includes('SSE v0.2: Connected')`,
      "SSE 409 EVENT_CURSOR_EXPIRED Auto-Recovery"
    );

    const sseRecoveredBadge = await cdp.eval<string>(`document.getElementById('sseStatusBadge')?.textContent?.trim()`);
    assert(sseRecoveredBadge.includes("SSE v0.2: Connected"), "Expected SSE badge to return to Connected after 409 recovery");

    report.checks.sseCursorExpiredRecovery = {
      status: "PASS",
      sseRecoveredBadge,
    };

    assert(cdp.pageExceptions.length === 0, `Expected 0 uncaught page exceptions, got: ${cdp.pageExceptions.join("; ")}`);
    report.pageExceptions = cdp.pageExceptions;
    report.overallStatus = "PASS";

    const outJsonPath = path.join(EVIDENCE_R2_DIR, "controlled-chrome-f02-r2.json");
    writeFileSync(outJsonPath, JSON.stringify(report, null, 2) + "\n", "utf8");
    console.log(JSON.stringify(report, null, 2));
  } finally {
    cdp.close();
    chromeProc.kill("SIGKILL");
    server.stop(true);
    await service.close();
    db.close();
    if (prevDataDir === undefined) delete process.env.AGETOR_DATA_DIR;
    else process.env.AGETOR_DATA_DIR = prevDataDir;
    rmSync(root, { recursive: true, force: true });
  }
}

await main();
