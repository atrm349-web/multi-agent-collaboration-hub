# Multi-Agent Collaboration Hub — 真实浏览器 UI 验证报告（`F-03` v0.2）

**验证日期：** 2026-11-02  
**验证负责人：** Google Antigravity（首席前端工程师 + UI/UX 设计负责人 + 浏览器集成测试负责人）  
**验证目标：** 验证已迁移至统一契约 `v0.2` 的前端控制台（`apps/web/public/index.html`、`apps/web/public/app.js`、`apps/web/public/styles.css`）在真实 macOS **Google Chrome 156.0.8078.79** 浏览器引擎中的 DOM 渲染、交互控制、只读证据隔离与断线恢复表现。

> **验证证据严格分离声明：**  
> 1. **HTTP / API 契约脚本验证：** 由 `tests/verify-contract-v0.2.mjs` 执行（7 组 HTTP/SSE 断言，日志见 `Antigravity/evidence/contract-v0.2-api.log`）。  
> 2. **真实浏览器 DOM 与交互验证：** 由 `tests/verify-browser-v0.2.mjs` 驱动本地真实 `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`（`HeadlessChrome/156.0.0.0`）通过 Chrome DevTools Protocol (`WebSocket`) 执行（6 项真实浏览器交互检查，原始日志见 `Antigravity/evidence/browser-v0.2-chrome.log`）。  
> 3. **边界说明：** 当前前端连接的 `apps/web/server.mjs` 为 `executionMode: 'mock', liveExecutionAvailable: false` 的 v0.2 契约状态机；正式后端 HTTP 联调（`F-02` / `I-01`）等待 Codex 完成 `B-03` ~ `B-06` 并提供正式 `/api/v1` 启动命令后执行。

---

## 一、复现命令（Codex 与用户可直接独立复跑）

```sh
# 1. 运行 HTTP / API v0.2 契约自动化测试（7 组套件）
/usr/local/bin/node .//tests/verify-contract-v0.2.mjs

# 2. 运行真实 Google Chrome 浏览器 DOM 交互测试（6 项真实浏览器检查）
/usr/local/bin/node .//tests/verify-browser-v0.2.mjs
```

---

## 二、真实 Google Chrome 浏览器 6 项实测结果明细

| 检查项 | 浏览器操作与 DOM 断言 | 实测结果 |
| :--- | :--- | :--- |
| **Browser Check 1：初始加载、v0.2 快照握手与 SSE 建连** | 启动真实 Chrome 加载 `/`；验证 `app.js` 依次请求 `GET /api/v1/meta`、`/repositories`、`/snapshot` 并通过 `fetch('/api/v1/events')` 建立带 `Authorization` 与 `Last-Event-ID=200` 的流式连接；断言 `#executionModeBadge` 显示 `SERVICE: MOCK · contractVersion=0.2 · liveExecutionAvailable=false`，侧栏渲染 3 个任务卡片，主任务状态为 `waiting_approval`。 | **PASS** |
| **Browser Check 2：Task Center 拆解预览与多视图无损切换** | 点击进入 `Task Center`，在 `#composerTitleInput` 与 `#composerGoalInput` 输入自定义文本，点击 `#previewDecomposeBtn` 触发 `POST /api/v1/tasks/decompose` 生成 `DraftPlan` 节点；随后切换至 `Workflow DAG` → `Agent Workspace`（验证 `logSeq:1` 终端渲染）→ 返回 `Task Center`，断言输入框内容与 `DraftPlan` 预览 100% 保留无丢失。 | **PASS** |
| **Browser Check 3：历史真实 CLI 证据（`real-relay-01`）只读 DOM 保护锁** | 在侧边栏点击选择 `real-relay-01`（`executionMode: 'live', provenance: 'historical'`）；断言 `#activeTaskBar` 显示 `🔒 HISTORICAL REAL EVIDENCE (READ-ONLY · provenance=historical)` 与只读提示，且 DOM 中不存在任何 `[data-v1-task-control]`、`[data-mock-step]` 或 `[data-mock-fault]` 按钮。 | **PASS** |
| **Browser Check 4：Review Center 审批与返工解耦及完整 DAG 跑通** | 切回 `task-smartcar-01`，进入 `Review Center`；断言按需加载了 `/api/v1/artifacts/art-03/content` 代码差异，且界面分离渲染了 `✓ 批准变更 (Approve)`、`✗ 拒绝变更 (Reject)` 与独立的 `↺ 触发子任务返工 (Subtask Rework)` 按钮；点击 `Approve` 后验证任务状态转为 `running`，再点击两次隔离控制面的 `Mock Step` 推进 `SUB-04` 与 `SUB-05`，断言任务最终状态变为 `succeeded`（进度 `100%`）。 | **PASS** |
| **Browser Check 5：超时告警横幅、子任务有界重试与 `pausing -> paused -> resume`** | 切换至 `task-telemetry-02`（`timed_out`），断言 `.error-banner` 清晰展示 `[TIMEOUT]` 与 `retryable=true`；点击横幅内的 `重试失败子任务` 按钮触发 `POST /api/v1/subtasks/sub-202/retry`，状态恢复为 `running`；点击 `Pause` 进入 `pausing` 过渡态，点击 `Mock Step` 停稳为 `paused`，再点击 `Resume` 恢复为 `queued`。 | **PASS** |
| **Browser Check 6：SSE 游标过期（`409 EVENT_CURSOR_EXPIRED`）自动快照恢复** | 进入 `Dashboard` 点击 `#testExpiredCursorBtn` 发送过期游标 `Last-Event-ID: 1`；断言浏览器捕获 `409 EVENT_CURSOR_EXPIRED`，弹出 Toast 提示，自动重拉 `GET /api/v1/snapshot` 并恢复 `SSE v0.2: Connected` 状态。 | **PASS** |
