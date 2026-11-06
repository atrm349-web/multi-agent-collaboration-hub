# F-03 前端契约 v0.2 迁移与双轨验证 — 已完成本轮交付

**日期：** 2026-11-02  
**交付方：** Google Antigravity（首席前端工程师 + UI/UX 设计负责人 + 浏览器集成测试负责人）  
**对应任务编号：** `F-03`（已交付并完成 HTTP/API 与真实 Google Chrome 双轨验证）  
**前置依赖确认：** `D-01`（用户已确认有条件复用 Agetor）、`U-02`（Antigravity 已确认 v0.2 契约）、已读取 Codex `B-01`、`B-02`、`B03-1` 交接包。

---

## 一、本轮已完成内容

1. **共享类型基线正式同步（`packages/shared/src/types.ts`）：**
   - 已将 `packages/shared/src/types.ts` 与 `packages/shared/src/types.v0.2.ts` 完全同步，统一使用 `contractVersion: '0.2'`、`schemaVersion: '0.2'`、七类核心实体及 `Validation` / `Meta` / `Snapshot` / `LogPage` / `EventEnvelope`。
2. **Mock 服务端全面迁移至 `/api/v1` 契约 v0.2（`apps/web/server.mjs`）：**
   - **路由与分页信封：** 所有业务端点严格收敛至 `/api/v1/*`，成功响应统一为 `{ data, requestId }`，错误响应统一为 `{ error: { code, message, retryable, details?, occurredAt }, requestId }`；`GET /api/v1/tasks` 修正为真正的 `Page<Task> { items, nextCursor }`（不再返回全量 state）。
   - **完整实现 v0.2 端点：**
     - `GET /api/v1/health`（无敏感信息最小健康检查）
     - `GET /api/v1/meta`（返回 `contractVersion: '0.2', executionMode: 'mock', liveExecutionAvailable: false`）
     - `GET /api/v1/repositories`（返回受控登记仓库白名单 `Page<RepositoryRef>`）
     - `GET /api/v1/agents`（含 `availability`、`capabilities`、`unsupportedReasons`、`permissionProfile`，对齐 B-01 沙箱策略与禁用规则）
     - `GET /api/v1/snapshot?taskId=...`（返回单事务一致性视图 `Snapshot` 及 `snapshotSeq`）
     - `POST /api/v1/tasks/decompose`（返回 `DraftPlan`，不执行代码）
     - `POST /api/v1/tasks`（校验 `repositoryId` 白名单、DAG 无环、子任务数 `<= 100`，返回 `201 Task` 初始 `queued`）
     - `GET /api/v1/tasks`、`GET /api/v1/tasks/:id`（返回 `TaskDetail`，内嵌 `subtasks` 及有界 `runs`/`validations`/`approvals`/`artifacts` Page）
     - `GET /api/v1/tasks/:id/runs`、`/validations`、`/messages`、`/artifacts`、`/approvals`
     - `GET /api/v1/runs/:id/logs`（按单 Run `logSeq` 分页，返回 `{ runId, items, nextSeq, hasMore }`）
     - `GET /api/v1/artifacts/:id/content`（附带 `X-Content-Type-Options: nosniff`、`Content-Security-Policy: default-src 'none'`，拦截路径遍历与任意路径访问）
     - `POST /api/v1/tasks/:id/pause`（`202 pausing`）、`/resume`（仅允许从 `paused` 恢复为 `202 queued`）、`/cancel`（`202 cancelling`）
     - `POST /api/v1/subtasks/:id/retry`（仅限 `failed`/`timed_out` 且 `retryable !== false`、`attempt < maxAttempts`，创建新 `attempt` 与新 `AgentRun`，保留历史 Run）
     - `POST /api/v1/subtasks/:id/rework`（仅限 `validating`/`waiting_approval`，自动将待决审批置为 `invalidated`、阻塞下游依赖并启动新 `attempt`）
     - `POST /api/v1/approvals/:id/decision`（仅接受 `'approve' | 'reject'`，校验 `expectedVersion`、`actionDigest` 与 `expiresAt`）
     - `POST /api/v1/tasks/:id/messages`（返回 `201 { message, delivery: 'queued_next_turn' }`）
     - `GET /api/v1/events`（SSE 流，校验 `Last-Event-ID`，非法格式报 `400 INVALID_INPUT`，超出窗口报 `409 EVENT_CURSOR_EXPIRED`，正常游标按 `seq > Last-Event-ID` 回放 outbox）
   - **安全与幂等护栏：**
     - 拒绝 URL query token（`?token=...` → `400 INVALID_INPUT`）；校验 `Origin` 白名单（非允许来源 → `403 PERMISSION_DENIED`）；除 `/health` 外强制 `Authorization: Bearer`（缺失或错误 → `401 UNAUTHENTICATED`）。
     - 严格校验请求 JSON 允许字段（未知控制字段 → `400 INVALID_INPUT`）。
     - 所有写操作强制要求 `Idempotency-Key`（同 key 同载荷幂等重放原响应，同 key 异载荷返回 `409 CONFLICT`）与 `expectedVersion` CAS（失配返回 `409 CONFLICT`）。
   - **测试控制面物理隔离与历史实测证据只读保护：**
     - 将模拟步进、故障注入、重置移出 `/api/v1`，隔离至 `/__mock_control/step`、`/__mock_control/fault`、`/__mock_control/reset`。
     - 对 `provenance: 'historical'` 的实测记录（`real-relay-01`），服务端拒绝一切控制或模拟步进请求（返回 `409 UNSUPPORTED_TRANSITION`）。
3. **前端控制台 UI 与流式状态机升级（`apps/web/public/app.js`、`index.html`、`styles.css`）：**
   - 启动时先拉取 `/api/v1/meta`、`/repositories`、`/snapshot`，再以 `Last-Event-ID: snapshotSeq` 建立 `fetch` SSE 连接；流式解析器支持跨 chunk 多字节 UTF-8、`\r\n` 归一化、多行 `data:` 与 `: heartbeat` 注释帧，按全局 `seq` 幂等去重；运行日志按单 Run `logSeq` 独立去重并高亮显示取消后 `drained=true` 的刷出日志。
   - 在界面中将 `Review Center` 审批按钮拆分为 `Approve` / `Reject` 与独立的 `Subtask Rework` 按钮；对 `real-relay-01` 展示只读保护锁并隐藏所有控制按钮；在 `Settings` 面板同步展示 Codex `B-01`、`B-02`、`B03-1` 交接状态。

---

## 二、验证结果与复现命令（HTTP/API 与真实浏览器严格分离）

1. **HTTP / API 契约自动化测试（`tests/verify-contract-v0.2.mjs`）：**
   - **结果：** 7 组测试套件全部通过（0 失败）。
   - **日志证据：** `Antigravity/evidence/contract-v0.2-api.log`
   - **复现命令：**
     ```sh
     /usr/local/bin/node .//tests/verify-contract-v0.2.mjs
     ```
2. **真实 Google Chrome 浏览器 DOM 与交互验证（`tests/verify-browser-v0.2.mjs`）：**
   - **结果：** 驱动本机真实 `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`（`Google Chrome 156.0.8078.79`）通过 CDP WebSocket 完成 6 项真实浏览器交互验证，全部通过（0 失败）。
   - **日志与报告证据：** `Antigravity/evidence/browser-v0.2-chrome.log`、`Antigravity/evidence/browser-v0.2-verification.md`
   - **复现命令：**
     ```sh
     /usr/local/bin/node .//tests/verify-browser-v0.2.mjs
     ```

---

## 三、边界声明与下一步配合

- **绝不混淆 Mock 与 Live：** 当前 `apps/web/server.mjs` 的 `meta.executionMode` 明确为 `'mock'` 且 `liveExecutionAvailable: false`；未将前端伪装为已接通真实 CLI 后端，也未触碰或启动原版 Agetor 的其他未验证 CLI。
- **下一步（`F-02` / `I-01`）：** 等待 Codex 完成 `B03-2` 及 `B-04` ~ `B-06` 并提供正式 `/api/v1` 后端服务启动命令与临时令牌注入方式后，立即开展前后端真实 HTTP/SSE 与浏览器联调验收。
