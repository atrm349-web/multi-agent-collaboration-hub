// Real HubService/HTTP/SQLite/Git with controlled planner/provider and injected Python test runner.
// Browser verification is performed separately through CUA. No real model or official sandbox is exercised.
import { Database } from "bun:sqlite";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { HubStore } from "/Users/developer/Documents/Codex/2026-11-02/multi-agent-collaboration-hub-ai-agent/work/upstream/agetor/packages/core/state/store.ts";
import { HubService, resolveRepository } from "/Users/developer/Documents/Codex/2026-11-02/multi-agent-collaboration-hub-ai-agent/work/upstream/agetor/packages/core/hub.ts";
import { createHubHandler } from "/Users/developer/Documents/Codex/2026-11-02/multi-agent-collaboration-hub-ai-agent/work/upstream/agetor/packages/core/http.ts";
import { buildFrontendAssets } from "/Users/developer/Documents/Codex/2026-11-02/multi-agent-collaboration-hub-ai-agent/work/upstream/agetor/packages/core/frontend.ts";
import type { DraftPlan } from "/Users/developer/Documents/Codex/2026-11-02/multi-agent-collaboration-hub-ai-agent/work/upstream/agetor/packages/shared/src/types.ts";

const PYTHON3_PATH = "/Applications/Xcode.app/Contents/Developer/usr/bin/python3";
const FRONTEND_DIR = "/Users/developer/Documents/Codex/2026-11-02/multi-agent-collaboration-hub-ai-agent/work/frontend-fix-r3/public";
const EVIDENCE_R2_DIR = "/Users/developer/Documents/Codex/2026-11-02/multi-agent-collaboration-hub-ai-agent/outputs/f02-r3/browser";
const SCREENSHOT_R2_DIR = path.join(EVIDENCE_R2_DIR, "screenshots");
const TOKEN = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");

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

  // Initialize a disposable Git repository for the controlled Python fixture.
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
    label: "Clamp Fixture Repo (Real Git + Controlled Test Runner)",
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
      const make=(stage:string,code:string,dependsOn:string[]=[])=>({id:randomUUID(),stage,code,title:code,description:code,dependsOn,requiredCapabilities:["stream"],acceptanceCriteria:[{id:"ac-"+code,description:code}]});
      const a=make("implementation","A"); const b=make("analysis","B",[a.id]); const c=make("implementation","C",[b.id]); const d=make("documentation","D",[b.id]);
      const subtasks=opts.goal.includes("R3-BRANCH")?[a,b,c,d]:opts.goal.includes("R3-TERMINAL")?[a,b]:opts.goal.includes("R3-CHAIN")?[a,b,c]:[a];
      return {id:randomUUID(),repositoryId:opts.repositoryId,goal:opts.goal,executionMode:"live",subtasks} as DraftPlan;
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

  const requests: object[]=[];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    maxRequestBodySize: 256 * 1024,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.origin !== origin || (request.headers.has("host") && request.headers.get("host") !== url.host)) {
        return new Response("Forbidden", { status: 403 });
      }
      if (url.pathname.startsWith("/api/")) { const response=await api(request); requests.push({method:request.method,path:url.pathname,status:response.status}); return response; }
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


  console.log("R3_FIXTURE_READY "+origin);
  console.log("MODE: real-controller/http; planner/provider/testRunner controlled fixtures; no model calls");
  await new Promise<void>((resolve)=>{process.once("SIGINT",resolve);process.once("SIGTERM",resolve);});
  await service.close();
  writeFileSync(path.join(EVIDENCE_R2_DIR,"server-evidence.json"),JSON.stringify({mode:"controlled-provider",requests,tasks:service.page("task").items,sourceHashes:frontendAssets.sourceHashes},null,2));
  await server.stop(true);db.close();rmSync(root,{recursive:true,force:true});
}
await main();
