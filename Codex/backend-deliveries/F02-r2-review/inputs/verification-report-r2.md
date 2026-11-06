# `F02-r2` 交叉复核返工验证报告（`R1` ~ `R5` 全量修复与受控 Chrome 实测证据）

- **修订号**：`F02-r2`（对应 `Codex/backend-deliveries/F02-cross-review/README.md` 的 `R1` ~ `R5` 返工清单）
- **生成时间**：`2026-11-03T01:28:48.763Z`
- **关联交付目录**：[`Antigravity/frontend-deliveries/F02-r2/`](file:///Users/developer/Desktop/%E9%9B%86%E5%90%88agnet/Antigravity/frontend-deliveries/F02-r2/manifest.json)
- **关联结构化证据**：[`Antigravity/evidence/f02-r2/controlled-chrome-f02-r2.json`](file:///Users/developer/Desktop/%E9%9B%86%E5%90%88agnet/Antigravity/evidence/f02-r2/controlled-chrome-f02-r2.json)
- **原 `F02` 基线保留说明**：原 `Antigravity/frontend-deliveries/F02/` 与 `Antigravity/evidence/live-f02-i01*` 保持原样未覆盖，供历史追溯。

---

## 1. 证据分层与诚实口径说明（`R1` 修复）

| 证据层级 | 脚本 / 证据文件 | 真实组件 | 受控替身 / 替换项 | 实际证明边界 |
|---|---|---|---|---|
| **受控 Chrome 全交互验证 (`F02-r2`)** | [`tests/verify-live-f02-r2.ts`](file:///Users/developer/Desktop/%E9%9B%86%E5%90%88agnet/tests/verify-live-f02-r2.ts) → [`controlled-chrome-f02-r2.json`](file:///Users/developer/Desktop/%E9%9B%86%E5%90%88agnet/Antigravity/evidence/f02-r2/controlled-chrome-f02-r2.json) | 真实 `HubService` 协调器、真实 SQLite `HubStore`、真实 Git Worktree (`WorkspaceManager`)、真实 `createHubHandler` HTTP/Fetch-SSE、真实 `buildFrontendAssets` CSP Nonce 桥接、真实 Google Chrome 156 (CDP) | `planner` 与 `spawn` 为受控替身；`testRunner` 替换为调用本地 `python3 verify_clamp.py` | 证明真实控制器 + HTTP/SSE + 真实 Chrome 在全部 UI 按钮路径（拆解预览、`R3` 计划校验/传递依赖压缩、创建、排队消息、`R2` 原始字节落盘下载与 SHA-256 校验、`R4` 含 `data` 字段 JSON 预览、独立返工、审批通过、暂停/恢复/取消、409 游标恢复）下的端到端闭环。任务标题仅为 UI 展示标签，实际代码 fixture 为 `src/clamp.py`（不宣称已交付智能车视觉识别系统，也不宣称本脚本直接调用了真实大模型或 `codex sandbox -P hub-test`）。 |
| **真实 Codex CLI + 正式 OS 沙箱 HTTP 证据** | [`Codex/backend-deliveries/B04-B06/evidence/real-http.json`](file:///Users/developer/Desktop/%E9%9B%86%E5%90%88agnet/Codex/backend-deliveries/B04-B06/evidence/real-http.json) | 真实官方 `codex` CLI（Planner + Developer + 独立 Session Reviewer）、真实 `runTestProfile`（`codex sandbox -P hub-test` 独立 macOS 沙箱）、真实 `HubService` / HTTP | 无注入替身 | 证明未注入替换下的真实模型拆解、独立会话开发与终审、正式 `codex sandbox -P hub-test` 验收测试及真实 HTTP 成功路径。 |
| **正式 OS 沙箱隔离与负向安全回归** | [`backend/agetor/src/bun/hub-workspace.test.ts`](file:///Users/developer/Desktop/%E9%9B%86%E5%90%88agnet/backend/agetor/src/bun/hub-workspace.test.ts) | 真实 `runTestProfile`（`codex sandbox -P hub-test`） | 无替换 | 证明正式测试沙箱禁止读写控制态目录、禁止访问网络、支持超时与显式取消进程组回收。 |

---

## 2. `R1` ~ `R5` 逐项修复与实测断言结果

### `R2 [P1]`：下载受控产物保持原始字节与 SHA-256 严格一致
- **修复位置**：[`apps/web/public/app.js`](file:///Users/developer/Desktop/%E9%9B%86%E5%90%88agnet/apps/web/public/app.js#L131-L207) (`fetchArtifactRaw`) 与 [`apps/web/public/app.js`](file:///Users/developer/Desktop/%E9%9B%86%E5%90%88agnet/apps/web/public/app.js#L1641-L1664) (`[data-download-artifact]`)。
- **机制**：下载不再读取经格式化或 UTF-8 解码的 `artifactContentCache`，而是调用 `fetchArtifactRaw(artifactId)` 携带 `Bearer` 请求原始 `/content`，校验 `res.ok`，读取 `res.arrayBuffer()` 原始 `Uint8Array` 字节与原始 `mimeType`，通过 `crypto.subtle.digest('SHA-256', bytes)` 计算哈希并与 `Artifact.sha256` 严格比对一致后，构造 `new Blob([raw.bytes], { type: raw.mimeType })` 触发浏览器下载。
- **实测结果（CDP `Browser.setDownloadBehavior` 真实落盘文件校验）**：
  - 紧凑 JSON `compact.json` (`{"ok":true}`)：原始 SHA-256 = `4062edaf750fb8074e7e83e0c9028c94e32468a8b6f1614774328ef045150f93`，Chrome 落盘文件 SHA-256 = `4062edaf750fb8074e7e83e0c9028c94e32468a8b6f1614774328ef045150f93`，落盘字节 = `{"ok":true}`，`bytesPreserved: true`。
  - 含非 UTF-8 字节的二进制产物 `binary-fixture.bin` (`89504e47fffefd0080c042`)：原始 SHA-256 = `c9c8a155cf70935b7e19411dc89ff84820d8319ddc851e0fdf6cdef212d1f5ab`，Chrome 落盘文件 SHA-256 = `c9c8a155cf70935b7e19411dc89ff84820d8319ddc851e0fdf6cdef212d1f5ab`，`bytesPreserved: true`。
  - 错误响应与哈希篡改拦截：不存在的产物返回 `404 NOT_FOUND`，哈希不匹配抛出 `ARTIFACT_INTEGRITY_MISMATCH`，均不会保存错误文件。

### `R4 [P2]`：`/content` 独立分流，含 `data` 字段的原始 JSON 产物不丢失字段
- **修复位置**：[`apps/web/public/app.js`](file:///Users/developer/Desktop/%E9%9B%86%E5%90%88agnet/apps/web/public/app.js#L114-L129) (`formatArtifactPreviewFromRaw`) 与 [`apps/web/public/app.js`](file:///Users/developer/Desktop/%E9%9B%86%E5%90%88agnet/apps/web/public/app.js#L209-L216) (`apiRequest`)。
- **机制**：`apiRequest` 在业务 `{ data, requestId }` 解包前优先匹配 `/^\/api\/v1\/artifacts\/([^/]+)\/content$/`，交由 `fetchArtifactRaw` + `formatArtifactPreviewFromRaw` 处理，不再根据 JSON 对象内含 `data` 字段误判为接口包装。
- **实测结果**：
  - `with-data.json` (`{"data":"payload","metadata":"must survive"}`)：预览解析结果为 `{"data":"payload","metadata":"must survive"}`，`metadata` 完整保留；
  - `string-literal.json` (`"hello-json-string"`)：预览结果为 `"\"hello-json-string\""`；
  - `clamp.py`（普通文本）：原样渲染 Python 源码；
  - `binary-fixture.bin`（非 UTF-8 二进制）：安全显示 `[Binary Artifact · 11 bytes · mimeType=application/octet-stream · sha256=c9c8a155...]`。

### `R3 [P1]`：禁止静默删减计划/丢失传递依赖，支持显式传递依赖压缩与重预览
- **修复位置**：[`apps/web/public/app.js`](file:///Users/developer/Desktop/%E9%9B%86%E5%90%88agnet/apps/web/public/app.js#L256-L353) (`inspectDraftPlanCompatibility` & `sanitizeExecutablePlan`) 与 [`apps/web/public/app.js`](file:///Users/developer/Desktop/%E9%9B%86%E5%90%88agnet/apps/web/public/app.js#L1797-L1838) (`#compressDraftPlanBtn` & `#launchTaskBtn`)。
- **机制**：
  - Live 模式下点击 `#launchTaskBtn` 时，若 `DraftPlan` 含 `stage === 'analysis'` 或 `code === 'FINAL-REVIEW'`（或可执行节点数为 0），直接**明确拒绝创建 (`INVALID_INPUT`)** 并提示用户先点击「压缩非执行节点（保留传递依赖与验收条件）并重新预览」确认或重新拆解，绝不静默删减节点或返回 `undefined` 触发服务端重规划。
  - `sanitizeExecutablePlan(subtasks)` 在压缩 `analysis` 节点时递归解析并保留传递依赖（`A -> B(analysis) -> C` 压缩后 `C.dependsOn = ['A']`），同时将移除的 `analysis` 节点的 `acceptanceCriteria` 合并至下游节点；若过滤后剩余 0 个可执行节点，直接抛出 `INVALID_INPUT` 错误。
- **实测结果**：
  - `A -> B(analysis) -> C` 未压缩直接点击创建：被 UI 明确拒绝（`uncompressedLaunchRejectedInUi: true`），未创建任务；
  - 点击 `#compressDraftPlanBtn` 压缩并重预览：`C.dependsOn` 精确保留为 `["A"]`，`C.acceptanceCriteria` 合并为 `["ac-c", "ac-b"]`；
  - 全 `analysis` 节点计划调用 `sanitizeExecutablePlan`：抛出 `INVALID_INPUT`（`allAnalysisPlanThrew: "INVALID_INPUT"`）。

### `R5 [P2]`：取消终态收敛与 `drained` 日志契约对齐
- **核对结论**：在 `backend/agetor/packages/agent-adapters/codex/runtime.ts:165,175` 中，`cancel()` 将 `run.intent` 置为 `"CANCELLED"` 后，后续流式事件被有意忽略，因此 Live 运行器在取消后不会产出 `drained=true` 日志（仅 Mock 模式 Suite 6 模拟 `drained=true`）。
- **修复与实测断言**：撤回原报告中“Live `drained=true` 已验证”的表述；在 `tests/verify-live-f02-r2.ts` 中对 `Task 2` 严格断言 `finalStatus === "cancelled"`、`preCancelLogCount === 22 (>= 1)` 且 `liveDrainedLogCount === 0`。

---

## 3. 新版 `F02-r2` 5 文件 SHA-256 清单

- `apps/web/public/index.html` (`Antigravity/frontend-deliveries/F02-r2/index.html`): `66304e120a1fad26f5a79e740721a1140fa81f6c5b27d9ab6472f17ac595bde5`
- `apps/web/public/app.js` (`Antigravity/frontend-deliveries/F02-r2/app.js`): `e1652a7c8a9465cb1f20434fe253b0488a051f1a9438265b42082aa162c69463`
- `apps/web/public/styles.css` (`Antigravity/frontend-deliveries/F02-r2/styles.css`): `cf18944d3c0fb913ff95ace72b40acd6216662d5d5e6203933214e0c88039fbe`
- `Antigravity/frontend-deliveries/F02-r2/app.live-native.js`: `818fcb3ac8fb44ea103d8f293b9e64f95ca3e5de6981fa41f06f4e75060eb2ea`
- `Antigravity/frontend-deliveries/F02-r2/index.live-native.html`: `83e361e46fe0adceed36f79a47422604679828fdbb7b2199455140f75638b317`
