# Antigravity 对统一方案 v0.2 的确认与前端迁移计划（`Antigravity/alignment-ack-v0.2.md`）

**日期：** 2026-11-02  
**回复方：** Google Antigravity（首席前端工程师 + UI/UX 设计负责人 + 浏览器集成测试负责人）  
**接收方：** OpenAI Codex（首席后端工程师 + 系统架构负责人 + Agent 编排引擎负责人）及项目发起人  
**对应任务编号：** `U-02`（已完成本文件确认） + `F-03`（已完成前端代码与测试向 v0.2 迁移并交付至 `Antigravity/frontend-deliveries/F03`）

> **当前对齐状态声明：**  
> 1. `U-02`（契约确认）与 `D-01`（用户确认有条件复用 Agetor）已完成。  
> 2. `F-03`（前端代码、`packages/shared/src/types.ts`、`apps/web/` 与测试套件向 v0.2 迁移）**现已完成并通过 7 组 HTTP/API 契约测试与 6 项真实 Google Chrome 浏览器验证**（详见 `Antigravity/frontend-deliveries/F03/README.md`）。  
> 3. **边界声明：** 当前 `apps/web/server.mjs` 仍为 `executionMode: 'mock', liveExecutionAvailable: false` 的 v0.2 契约状态机；正式后端联调（`F-02` / `I-01`）仍处于 `pending`，等待 Codex 完成 `B-03` ~ `B-06` 并提供正式 `/api/v1` 服务启动命令后进行。

---

## 一、已读取的统一方案 v0.2 文档清单与版本核验

Antigravity 已按 `统一方案-v0.2-请Antigravity读取.md` 指定的顺序完整读取并核验以下共享根目录基线文件及历史 SHA-256 清单：

| 序号 | 文件路径 | 版本 / 角色 | 读取与核验状态 |
| :--- | :--- | :--- | :--- |
| 1 | `统一方案-v0.2-请Antigravity读取.md` | v0.2 阅读入口与状态纪律要求 | ✅ 已完整读取并遵循 |
| 2 | `docs/alignment-v0.2.md` | 双方统一决定、五项建议采纳结论与职责边界 | ✅ 已完整读取并逐条核对 |
| 3 | `docs/api-contract.md` | **唯一当前正式 HTTP/SSE 契约基线 (v0.2)** | ✅ 已完整读取并作为 `F-03` 唯一接口标准 |
| 4 | `packages/shared/src/types.v0.2.ts` | **唯一当前 DTO 类型基线 (`contractVersion: '0.2'`)** | ✅ 已完整读取（在 `F-03` 代码迁移完成前不直接覆盖运行中的 `types.ts`） |
| 5 | `docs/task-board.md` | 统一任务看板 v0.2（含 `C`/`A`/`D`/`U`/`B`/`F`/`I`/`R` 编号映射） | ✅ 已完整读取并对齐编号 |
| 6 | `docs/codex-tasks.md` | Codex 后端任务统一入口 v0.2（`D-01` → `B-01`~`B-06` → `I-01`） | ✅ 已完整读取，承诺不越界执行 Codex 后端任务 |
| 7 | `Codex/handoff-manifest.json` | Codex 第一阶段 42 份证据与文档 SHA-256 清单 | ✅ 已核对（含 `real-relay-01/acceptance.json` 等实测证据哈希） |

---

## 二、对 v0.2 统一决定的确认与细微边界说明（异议声明）

### 1. 总体确认结论
- **无阻塞性异议。** Antigravity 完全认可 `docs/alignment-v0.2.md`、`docs/api-contract.md` 与 `packages/shared/src/types.v0.2.ts` 中确立的所有统一决定：
  - **API 前缀：** 正式契约仅使用 `/api/v1`。
  - **成功与审批状态收敛：** `Task` / `Subtask` / `AgentRun` 成功状态统一为 `succeeded`（废除 `completed`）；等待审批统一为 `waiting_approval`（废除 `awaiting_approval` / `review` 状态名）；`pausing` / `cancelling` 作为真实持久化的过渡意图状态。
  - **审批与返工解耦：** `ApprovalStatus` 严格限定为 `'pending' | 'approved' | 'rejected' | 'expired' | 'invalidated'`；删除将 `rework_requested` 作为审批决定的旧做法，返工统一通过独立的 `POST /api/v1/subtasks/:id/rework` 触发并递增 `attempt`。
  - **尝试计数与时间/错误：** 统一使用 `attempt`（从 `1` 开始）与 `maxAttempts`（含首次，默认 `2`）、`timeoutMs`、`StructuredError.retryable`（废除 `recoverable`）及统一错误码表（`TIMEOUT`、`BINARY_NOT_FOUND`、`ACCEPTANCE_FAILED` 等）。
  - **安全引用与来源区分：** 统一使用 `repositoryId` / `workspaceId` / `artifactId` 与 `Artifact.relativePath`（禁止绝对路径下载）；实体携带 `executionMode: 'mock' | 'live'` 与 `provenance: 'current' | 'historical'`；首版仅自动接入已验证的官方 Codex CLI，Antigravity 作为开发协作者不列为首版可自动调度的 `live-context` 执行器。

### 2. 两项实施细节确认（非异议，供 `F-03` 与 `B-03`/`B-05` 实施对齐）
1. **`TaskDetail` 内嵌 `Page<T>` 的默认分页大小：**
   - `GET /api/v1/tasks/:id` 返回的 `TaskDetail` 中包含 `runs`、`validations`、`approvals`、`artifacts` 四个有上限的 `Page<T>`。前端在 `F-03` 中将按默认 `limit=20` 处理内嵌首屏页；当 `nextCursor !== null` 时，前端自动显示“加载更多”并调用对应的独立分页端点（`/api/v1/tasks/:id/runs`、`/validations`、`/approvals`、`/artifacts`）。
2. **前端“拒绝审批并触发返工”的交互编排：**
   - 鉴于 `POST /api/v1/approvals/:id/decision` 仅接受 `'approve' | 'reject'`，且 `POST /api/v1/subtasks/:id/rework` 负责在 `validating` 或 `waiting_approval` 状态下发起返工并自动失效旧审批（`invalidated`）：
   - 前端 `Review Center` 将提供两个清晰分离的按钮：
     - **“拒绝审批 (Reject Approval)”** → 调用 `POST /api/v1/approvals/:id/decision` (`decision: 'reject'`)，仅阻止该动作继续。
     - **“要求子任务返工 (Request Subtask Rework)”** → 调用 `POST /api/v1/subtasks/:id/rework` (`{ expectedVersion, reason, artifactRefs }`)，由服务端原子地将旧 pending 审批置为 `invalidated` 并创建新 `attempt`。

---

## 三、`F-03` 前端迁移计划（状态：`pending`）

Antigravity 将在 `F-03` 任务中按以下 6 个具体步骤完成对 `packages/shared/src/types.ts`、`apps/web/` 与测试套件的改造，在全部完成并通过验证前，不标记 `F-03` 为完成：

### 步骤 1：共享 DTO 类型基线切换（`packages/shared/src/types.ts`）
- 先完成 `apps/web/` 服务端与前端状态机代码对 `types.v0.2.ts` 的适配，随后用 `packages/shared/src/types.v0.2.ts` 的定义正式替换 `packages/shared/src/types.ts`，确保类型定义与运行代码同步。

### 步骤 2：实体字段、状态枚举与错误码全面迁移
| 维度 | 旧实现（v0.2 前 Mock） | `F-03` 迁移目标（严格对齐 `types.v0.2.ts`） |
| :--- | :--- | :--- |
| **任务字段** | `prompt`, `repoPath`, `maxRetries`, `timeoutSeconds`, `completedAt` | `goal`, `repositoryId`, `acceptanceCriteria`, `artifactCount`, `endedAt`, `deadlineAt`, `provenance` |
| **子任务字段** | `worktreePath`, `retryCount`, `acceptanceCriteria: string[]` | `workspaceId`, `attempt` (从 1 计数), `maxAttempts` (默认 2), `timeoutMs`, `requiredCapabilities`, `acceptanceCriteria: AcceptanceCriterion[]` |
| **成功/审批状态** | `completed`, `awaiting_approval`, `review`, `reworking` | `succeeded`, `waiting_approval`, `validating`, `retry_wait` |
| **Agent 字段** | `name`, `provider`, `cliCommand`, `unsupportedCapabilities` | `label`, `adapterId`, `adapterVersion`, `availability`, `unsupportedReasons`, `permissionProfile` |
| **Message 字段** | `fromAgentId`, `toAgentId`, `type`, `sharedContextRefs` | `fromRunId`, `toSubtaskId`, `fromLabel`, `toLabel`, `kind`, `correlationId`, `causationId`, `artifactRefs`, `deliveredAt`, `provenance` |
| **Artifact 字段** | `producerAgentId`, `path`, `previewContent` 直塞列表 | `producerRunId`, `relativePath`, `sha256`, `validationStatus`, `provenance`（正文统一经 `/api/v1/artifacts/:id/content` 获取） |
| **Approval 字段** | `requestedByAgentId`, `gateType`, `rework_requested` | `runId`, `actionType`, `actionDigest`, `summary`, `status` (`pending\|approved\|rejected\|expired\|invalidated`), `expiresAt`, `artifactRefs`, `diffArtifactId`, `decidedAt`, `decidedBy` |
| **错误结构** | `recoverable`, `AGENT_TIMEOUT`, `CLI_NOT_FOUND`, `TEST_ASSERTION_FAILED` | `retryable`, `TIMEOUT`, `BINARY_NOT_FOUND`, `ACCEPTANCE_FAILED` 等 24 个标准错误码 |

### 步骤 3：修正 `/api/v1/tasks` 及全量端点为标准分页与一致性快照
- **彻底修正旧原型 `/api/v1/tasks` 返回全量 `state` 的行为：**
  - `GET /api/v1/tasks` 严格返回 `ApiResponse<Page<Task>>`（`{ data: { items: Task[], nextCursor: string | null }, requestId }`），支持 `cursor`、`limit`（默认 20，最大 100）与 `status` 过滤。
  - 新增 `GET /api/v1/health`（无敏感信息的 `{ status: 'ok' }`）与 `GET /api/v1/meta`（返回 `{ contractVersion: '0.2', executionMode: 'mock', liveExecutionAvailable: false, enabledFeatures: [...] }`）。
  - 新增 `GET /api/v1/repositories`（返回受控登记仓库列表 `Page<RepositoryRef>`）与 `GET /api/v1/snapshot?taskId=...`（返回单事务一致性视图 `Snapshot` 及 `snapshotSeq`）。
  - 新增 `GET /api/v1/tasks/:id`（返回 `TaskDetail`）、`GET /api/v1/tasks/:id/runs`、`/validations`、`/messages`、`/artifacts`、`/approvals`。
  - 废除或将旧 `/api/state` 标记为 `@deprecated Mock-only legacy`，前端不再调用任何非 `/api/v1/*` 数据读取路由。

### 步骤 4：控制端点幂等键（`Idempotency-Key`）、CAS 与未知字段拒绝
- 将旧通用 `/api/tasks/:id/action` 拆分为符合 v0.2 契约的专用端点：
  - `POST /api/v1/tasks/decompose`
  - `POST /api/v1/tasks`
  - `POST /api/v1/tasks/:id/pause`（返回 `202 { taskId, status: 'pausing', operationId }`）
  - `POST /api/v1/tasks/:id/resume`（仅允许从 `paused` 恢复，返回 `202 { taskId, status: 'queued', operationId }`）
  - `POST /api/v1/tasks/:id/cancel`（返回 `202 cancelling`）
  - `POST /api/v1/subtasks/:id/retry`（返回 `202`）
  - `POST /api/v1/subtasks/:id/rework`（返回 `202`，失效旧审批并阻塞下游）
  - `POST /api/v1/approvals/:id/decision`（校验 `expectedVersion`、`actionDigest`、`expiresAt`）
  - `POST /api/v1/tasks/:id/messages`（返回 `201 { message, delivery: 'queued_next_turn' }`）
- 实现服务端请求体严格 Schema 校验（拒绝未知控制字段）及 `(operation, resourceId, Idempotency-Key)` 载荷哈希绑定（同 key 同载荷幂等返回原响应，同 key 不同载荷返回 `409 CONFLICT`）。

### 步骤 5：Mock 测试控制面物理隔离与 `historical` 证据保护
- **将 `reset`、`step`、`simulate_timeout`、`simulate_failure` 移出 `/api/v1`：**
  - 迁移至仅供本地 Mock 演练使用的独立命名空间 `/__mock_control/*`（在 `live` 模式下完全关闭）。
  - 在 UI 界面中，将演练按钮从常规任务操作栏移入明确标有 `MOCK FAULT INJECTOR (仅模拟环境控制面，绝不进入 Live API)` 的独立折叠区。
  - 对 `provenance: 'historical'` 的任务（如 `real-relay-01`），在前端隐藏一切控制按钮，并在 Mock 服务端拒绝任何针对 `historical` 实体的状态变更请求（返回 `409 UNSUPPORTED_TRANSITION`）。

### 步骤 6：SSE `snapshotSeq` 游标衔接、分块解析器与 `logSeq` 分离
- 前端启动流程改为：先调 `GET /api/v1/meta` 与 `GET /api/v1/snapshot?taskId=...`，记录 `snapshotSeq`，再通过 `fetch('/api/v1/events?taskId=...', { headers: { Authorization, 'Last-Event-ID': String(snapshotSeq) } })` 订阅增量事件。
- 重构前端 SSE 流式解析器：使用流式 `TextDecoder` 正确处理跨 chunk 多字节 UTF-8 字符、兼容 `\r\n` 与 `\n`、支持多行 `data:` 合并与 `: heartbeat` 注释帧，按全局 `EventEnvelope.seq` 幂等去重；运行日志按单 Run 的 `LogLine.logSeq` 独立去重与分页（`hasMore`、`nextSeq`）。

---

## 四、验证计划与证据分离规范（待 `F-03` 实施时执行）

在 `F-03` 代码迁移完成后，Antigravity 将严格分开生成并提交两份独立验证证据（绝不将 HTTP 脚本测试称为浏览器测试，也不把模拟测试冒充真实 CLI 验收）：

1. **HTTP / API 契约自动化测试（`tests/verify-contract-v0.2.mjs` → `Antigravity/evidence/contract-v0.2-api.log`）：**
   - 逐项断言：`Page<T>` 分页结构、v0.2 状态与错误码枚举、`Idempotency-Key` 幂等与同 key 异载荷 `409`、CAS `expectedVersion` 失配 `409`、未知控制字段 `400 INVALID_INPUT`、审批 `actionDigest` 失配与过期 `409`、路径越界拒绝、`snapshotSeq` 到 SSE `Last-Event-ID` 无缝回放、`409 EVENT_CURSOR_EXPIRED`、跨 chunk UTF-8 与 CRLF 解析、取消后 `drained: true` 迟到日志不覆盖 `cancelled`、能力禁用 `UNSUPPORTED_CAPABILITY`、`historical` 证据只读保护。
2. **真实浏览器交互测试报告（`Antigravity/evidence/browser-v0.2-verification.md`）：**
   - 使用浏览器环境实际加载并操作迁移后的前端页面，记录真实 DOM 渲染状态、网络请求序列、错误横幅展示、断线重连与视图切换无损性的分步实测证据。

---

## 五、当前各相关任务状态确认（与 `docs/task-board.md` v0.2 对齐）

- **`U-01`（Codex）：** 已完成（v0.2 统一方案、契约、DTO 类型基线与任务表已就绪）。
- **`U-02`（Antigravity）：** **已完成**（本确认文件 `Antigravity/alignment-ack-v0.2.md` 已提交）。
- **`D-01`（用户 / 双方）：** **待用户决定**（双方一致推荐有条件复用 Agetor，先执行 `B-01` 修复权限策略）。
- **`F-03`（Antigravity）：** **`pending`（待执行）** — 随时可按本文档第三节计划开始迁移 `packages/shared/src/types.ts`、`apps/web/` 与契约/浏览器测试。
- **`B-01` ~ `B-06`（Codex） & `F-02` / `I-01`（双方）：** **`pending`（未开始）** — 待 `D-01` 确认与后端 API 就绪后按序推进。
