import { createHash, randomBytes } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

export interface FrontendAsset { body: string; type: string }
export interface FrontendAssets {
  assets: Map<string,FrontendAsset>;
  nonce: string;
  sourceHashes: Record<string,string>;
}

export const frontendIntegrationPatch = Object.freeze([
  "Read the Antigravity source snapshot without modifying its files; fail on unexpected integration anchors.",
  "Replace the fixed Mock bearer token with a nonce-protected backend bootstrap token.",
  "Remove the Mock task ID from initial selection and bootstrap snapshot requests.",
  "Render current Task/Run/Message/Artifact labels from executionMode; preserve historical evidence labels.",
  "Show Mock reset/step/fault and cursor-expiry rehearsal controls only when server meta says mock.",
  "Reject accidental Mock control clicks in live mode; the backend must also omit all Mock endpoints.",
]);

function replaceExact(source: string, before: string, after: string, count = 1): string {
  if (source.split(before).length - 1 !== count) throw new Error("INVALID_INPUT: frontend source changed; review the live integration patch");
  return source.split(before).join(after);
}

/** Freeze and adapt an explicitly supplied frontend version; never edits Antigravity's source. */
export async function buildFrontendAssets(frontendDir: string, token: string): Promise<FrontendAssets> {
  if (typeof token !== "string" || !/^[a-f0-9]{32,256}$/i.test(token)) throw new Error("INVALID_INPUT: frontend bootstrap requires a random hex bearer token");
  const root = await realpath(frontendDir);
  const names = ["index.html","app.js","styles.css"];
  const loaded = await Promise.all(names.map(async (name) => {
    const file = path.join(root,name); const metadata = await lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 2*1024*1024) throw new Error("INVALID_INPUT: frontend asset must be a bounded regular file");
    return [name,await readFile(file,"utf8")] as const;
  }));
  const sources = Object.fromEntries(loaded);
  let app = sources["app.js"]!;
  app = replaceExact(app,"const AUTH_TOKEN = 'dev-local-hub-token-v1';","const AUTH_TOKEN = globalThis.__HUB_BOOT__.token;");
  app = replaceExact(app,"selectedTaskId: 'task-smartcar-01',","selectedTaskId: null,");
  app = replaceExact(app,"await loadConsistentSnapshot('task-smartcar-01');","await loadConsistentSnapshot(null);",2);
  app = replaceExact(app,"isHistorical ? '🔒 HISTORICAL LIVE' : 'MOCK CURRENT'","isHistorical ? '🔒 HISTORICAL LIVE' : (t.executionMode === 'live' ? 'LIVE CURRENT' : 'MOCK CURRENT')");
  app = replaceExact(app,"isHistorical ? '🔒 HISTORICAL REAL EVIDENCE (READ-ONLY · provenance=historical)' : 'MOCK CURRENT (executionMode=mock · provenance=current)'",
    "isHistorical ? '🔒 HISTORICAL REAL EVIDENCE (READ-ONLY · provenance=historical)' : (task.executionMode === 'live' ? 'LIVE CURRENT (executionMode=live · provenance=current)' : 'MOCK CURRENT (executionMode=mock · provenance=current)')");
  app = replaceExact(app,"isHist ? '🔒 HISTORICAL LIVE' : 'MOCK CURRENT'","isHist ? '🔒 HISTORICAL LIVE' : (t.executionMode === 'live' ? 'LIVE CURRENT' : 'MOCK CURRENT')");
  app = replaceExact(app,"run.provenance === 'historical' ? '🔒 HISTORICAL LIVE EVIDENCE' : 'MOCK RUN'",
    "run.provenance === 'historical' ? '🔒 HISTORICAL LIVE EVIDENCE' : (run.executionMode === 'live' ? 'LIVE RUN' : 'MOCK RUN')");
  app = replaceExact(app,"m.provenance === 'historical' ? '🔒 HISTORICAL LIVE' : 'MOCK CURRENT'",
    "m.provenance === 'historical' ? '🔒 HISTORICAL LIVE' : (m.executionMode === 'live' ? 'LIVE CURRENT' : 'MOCK CURRENT')");
  app = replaceExact(app,"art.provenance === 'historical' ? '🔒 HISTORICAL LIVE EVIDENCE' : 'MOCK ARTIFACT'",
    "art.provenance === 'historical' ? '🔒 HISTORICAL LIVE EVIDENCE' : (art.executionMode === 'live' ? 'LIVE ARTIFACT' : 'MOCK ARTIFACT')");
  app = replaceExact(app,"严格区分 current (Mock) 与 historical (只读实测证据)","严格区分 current (LIVE/MOCK) 与 historical (只读实测证据)");
  app = replaceExact(app,"2 项当前 Mock + 1 项只读历史实测证据",
    "${tasks.filter((t) => t.provenance !== 'historical' && t.executionMode === 'live').length} 项当前 LIVE / ${tasks.filter((t) => t.provenance !== 'historical' && t.executionMode === 'mock').length} 项当前 MOCK / ${tasks.filter((t) => t.provenance === 'historical').length} 项历史证据");
  app = replaceExact(app,"    ${\n      !isHistorical\n        ? `\n      <div",
    "    ${\n      !isHistorical && uiState.meta.executionMode === 'mock'\n        ? `\n      <div");
  const cursorButton = '<button class="btn" id="testExpiredCursorBtn" title="发送过期 Last-Event-ID=1 触发 409 EVENT_CURSOR_EXPIRED 并验证自动快照重连">演练 SSE 游标过期恢复 (409 Replay)</button>';
  app = replaceExact(app,cursorButton,"${uiState.meta.executionMode === 'mock' ? `"+cursorButton+"` : ''}");
  const cursorHandler = "  if (target.id === 'testExpiredCursorBtn') {";
  app = replaceExact(app,cursorHandler,
    "  if (uiState.meta.executionMode !== 'mock' && (['testExpiredCursorBtn', 'resetDemoStateBtn'].includes(target.id) || target.dataset.mockStep || target.dataset.mockFault)) {\n    showToast('Mock controls are disabled by the live backend', true);\n    return;\n  }\n\n"+cursorHandler);
  const nonce = randomBytes(18).toString("base64url");
  let html = replaceExact(sources["index.html"]!,"</head>",
    `<script nonce="${nonce}">globalThis.__HUB_BOOT__=Object.freeze(${JSON.stringify({ token })});</script>\n</head>`);
  html = replaceExact(html,'<script type="module" src="/app.js"></script>',`<script nonce="${nonce}" type="module" src="/app.js"></script>`);
  html = replaceExact(html,"Repo: smartcar-vision (main @ a4f92c1)","Repo: waiting for selection");
  html = replaceExact(html,"当前服务端为 Mock 状态机 (liveExecutionAvailable=false)，与历史只读实测证据分区展示","服务模式从后端 meta 读取；历史实测证据保持只读");
  html = replaceExact(html,"SERVICE: MOCK · contractVersion=0.2 · liveExecutionAvailable=false","SERVICE: CONNECTING · contractVersion=0.2");
  const index = { body: html,type: "text/html; charset=utf-8" };
  return { nonce,sourceHashes: Object.fromEntries(loaded.map(([name,body]) => [name,createHash("sha256").update(body).digest("hex")])),
    assets: new Map([["/",index],["/index.html",index],["/app.js",{ body: app,type: "text/javascript; charset=utf-8" }],
      ["/styles.css",{ body: sources["styles.css"]!,type: "text/css; charset=utf-8" }]]) };
}
