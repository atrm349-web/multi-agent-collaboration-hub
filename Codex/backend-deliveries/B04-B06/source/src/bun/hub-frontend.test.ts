import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { buildFrontendAssets } from "../../packages/core/frontend.ts";

let folder: string;
const token = "a".repeat(64);
const cursorButton = '<button class="btn" id="testExpiredCursorBtn" title="发送过期 Last-Event-ID=1 触发 409 EVENT_CURSOR_EXPIRED 并验证自动快照重连">演练 SSE 游标过期恢复 (409 Replay)</button>';
// A minimal frozen-source fixture contains the exact integration anchors, not a new UI.
const appSource = [
  "const AUTH_TOKEN = 'dev-local-hub-token-v1';",
  "const uiState = { selectedTaskId: 'task-smartcar-01', meta: {executionMode:'mock'} };",
  "async function bootstrap(){await loadConsistentSnapshot('task-smartcar-01');}",
  "async function reset(){await loadConsistentSnapshot('task-smartcar-01');}",
  "function showToast(){}",
  "function render(t,run,m,art,tasks){const task=t;const isHistorical=t.provenance==='historical';const isHist=isHistorical;return `",
  "${isHistorical ? '🔒 HISTORICAL LIVE' : 'MOCK CURRENT'}",
  "${isHistorical ? '🔒 HISTORICAL REAL EVIDENCE (READ-ONLY · provenance=historical)' : 'MOCK CURRENT (executionMode=mock · provenance=current)'}",
  "${isHist ? '🔒 HISTORICAL LIVE' : 'MOCK CURRENT'}",
  "${run.provenance === 'historical' ? '🔒 HISTORICAL LIVE EVIDENCE' : 'MOCK RUN'}",
  "${m.provenance === 'historical' ? '🔒 HISTORICAL LIVE' : 'MOCK CURRENT'}",
  "${art.provenance === 'historical' ? '🔒 HISTORICAL LIVE EVIDENCE' : 'MOCK ARTIFACT'}",
  "严格区分 current (Mock) 与 historical (只读实测证据)",
  "2 项当前 Mock + 1 项只读历史实测证据",
  "    ${",
  "      !isHistorical",
  "        ? `",
  '      <div data-mock-step="fixture"><button data-mock-fault="TIMEOUT">fault</button><button id="resetDemoStateBtn">reset</button></div>',
  "    `",
  "        : ''",
  "    }",
  cursorButton,
  "`;}",
  "async function click(target){",
  "  if (target.id === 'testExpiredCursorBtn') { return 'expired'; }",
  "  if (target.id === 'resetDemoStateBtn') { return 'reset'; }",
  "  if (target.dataset.mockStep) { return 'step'; }",
  "  if (target.dataset.mockFault) { return 'fault'; }",
  "}",
].join("\n");
const htmlSource = '<!doctype html><html><head><title>Fixture</title></head><body>Repo: smartcar-vision (main @ a4f92c1)\n当前服务端为 Mock 状态机 (liveExecutionAvailable=false)，与历史只读实测证据分区展示\nSERVICE: MOCK · contractVersion=0.2 · liveExecutionAvailable=false\n<script type="module" src="/app.js"></script></body></html>';
beforeEach(async () => {
  folder = await mkdtemp(path.join(tmpdir(),"hub-frontend-"));
  await Promise.all([writeFile(path.join(folder,"app.js"),appSource),writeFile(path.join(folder,"index.html"),htmlSource),
    writeFile(path.join(folder,"styles.css"),"body{color:white}")]);
});
afterEach(async () => { await rm(folder,{ recursive: true,force: true }); });

test("only known static paths are returned and source files are never modified", async () => {
  const result = await buildFrontendAssets(folder,token);
  expect([...result.assets.keys()].sort()).toEqual(["/","/app.js","/index.html","/styles.css"]);
  expect(await readFile(path.join(folder,"app.js"),"utf8")).toBe(appSource);
  expect(await readFile(path.join(folder,"index.html"),"utf8")).toBe(htmlSource);
  expect(result.sourceHashes["app.js"]).toBe(createHash("sha256").update(appSource).digest("hex"));
  expect(result.assets.get("/styles.css")!.body).toBe("body{color:white}");
  expect(result.assets.get("/")!.body).toBe(result.assets.get("/index.html")!.body);
});

test("nonce bootstrap carries the token without embedding it in JS URLs or public app source", async () => {
  const result = await buildFrontendAssets(folder,token);
  const html = result.assets.get("/")!.body; const app = result.assets.get("/app.js")!.body;
  expect(html).toContain(`nonce="${result.nonce}"`);
  expect(html).toContain(`Object.freeze({"token":"${token}"})`);
  expect(html).not.toContain("?token="); expect(app).not.toContain(token);
  expect(app).toContain("const AUTH_TOKEN = globalThis.__HUB_BOOT__.token;");
  expect(app).not.toContain("selectedTaskId: 'task-smartcar-01'");
  expect(app).not.toContain("loadConsistentSnapshot('task-smartcar-01')");
  expect((await buildFrontendAssets(folder,token)).nonce).not.toBe(result.nonce);
});

test("live records render live labels and no Mock controls; Mock mode remains explicit", async () => {
  const built = await buildFrontendAssets(folder,token); const app = built.assets.get("/app.js")!.body;
  const context = { __HUB_BOOT__: { token } };
  const setup = `const t={provenance:'current',executionMode:'live'};uiState.meta.executionMode='live';`;
  const live = runInNewContext(app+"\n"+setup+"render(t,t,t,t,[t]);",context) as string;
  expect(live).toContain("LIVE CURRENT"); expect(live).toContain("LIVE RUN"); expect(live).toContain("LIVE ARTIFACT");
  expect(live).not.toContain("MOCK CURRENT"); expect(live).not.toContain("data-mock-step");
  expect(live).not.toContain("data-mock-fault"); expect(live).not.toContain("resetDemoStateBtn"); expect(live).not.toContain("testExpiredCursorBtn");
  const mock = runInNewContext(app+"\nconst t={provenance:'current',executionMode:'mock'};render(t,t,t,t,[t]);",{ __HUB_BOOT__: { token } }) as string;
  expect(mock).toContain("MOCK CURRENT"); expect(mock).toContain("data-mock-step"); expect(mock).toContain("testExpiredCursorBtn");
});

test("historical labels stay read-only and live click guards reject stray Mock controls", async () => {
  const { assets } = await buildFrontendAssets(folder,token); const app = assets.get("/app.js")!.body;
  const historical = runInNewContext(app+"\nconst t={provenance:'historical',executionMode:'live'};uiState.meta.executionMode='live';render(t,t,t,t,[t]);",{ __HUB_BOOT__: { token } }) as string;
  expect(historical).toContain("HISTORICAL LIVE"); expect(historical).not.toContain("data-mock-step");
  const clicks = await runInNewContext(app+"\nuiState.meta.executionMode='live';Promise.all([click({id:'resetDemoStateBtn',dataset:{}}),click({id:'testExpiredCursorBtn',dataset:{}}),click({id:'',dataset:{mockStep:'id'}}),click({id:'',dataset:{mockFault:'TIMEOUT'}})]);",{ __HUB_BOOT__: { token } });
  expect(clicks).toEqual([undefined,undefined,undefined,undefined]);
});

test("unknown or repeated integration anchors fail instead of silently patching another UI version", async () => {
  await writeFile(path.join(folder,"app.js"),appSource.replace("selectedTaskId: 'task-smartcar-01',","selectedTaskId: 'different',"));
  await expect(buildFrontendAssets(folder,token)).rejects.toThrow("INVALID_INPUT");
  await writeFile(path.join(folder,"app.js"),appSource+"\nconst AUTH_TOKEN = 'dev-local-hub-token-v1';");
  await expect(buildFrontendAssets(folder,token)).rejects.toThrow("INVALID_INPUT");
});

test("weak/non-hex tokens and symlinked assets are rejected", async () => {
  for (const bad of ["short","<script>bad</script>","z".repeat(64)]) await expect(buildFrontendAssets(folder,bad)).rejects.toThrow("INVALID_INPUT");
  await rm(path.join(folder,"styles.css")); await symlink(path.join(folder,"app.js"),path.join(folder,"styles.css"));
  await expect(buildFrontendAssets(folder,token)).rejects.toThrow("INVALID_INPUT");
});

test("assets remain a frozen read snapshot after the source changes", async () => {
  const built = await buildFrontendAssets(folder,token); const original = built.assets.get("/app.js")!.body;
  await writeFile(path.join(folder,"app.js"),"changed source");
  expect(built.assets.get("/app.js")!.body).toBe(original);
  await expect(buildFrontendAssets(folder,token)).rejects.toThrow("INVALID_INPUT");
});
