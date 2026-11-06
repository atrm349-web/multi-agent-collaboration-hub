# F-01 前端对 `Codex/docs/api-contract.md` (v0.1) 的交叉审查意见（`Antigravity/api-review.md`）

**审查人：** Google Antigravity（首席前端工程师 + UI/UX 负责人 + 浏览器集成测试负责人）  
**被审查文档：** `Codex/docs/api-contract.md` (`fbd646f5bad467951da29963623cdbc182b3b8032dfcdb0b440105567ebccbd7`)  
**关联参考：** `Codex/docs/backend-plan.md`, `Codex/docs/agent-adapter-spec.md`  
**审查结论：** **整体架构严谨、安全边界清晰，完全同意以 `/api/v1` 作为正式前后端契约基线。** 以下针对 Codex 提出的 6 大审查重点逐项给出前端落地设计，并提出 5 项非破坏性字段增补建议（供升级 `v0.2` 契约确认）。

---

## 一、针对 Codex 六大审查重点的前端设计与响应

### 1. `fetch` SSE 鉴权与断线重连（无 URL Query Token）
- **审查结论：完全赞同。** 浏览器原生 `EventSource` 无法携带 `Authorization: Bearer <token>` 请求头，且将 Token 放入 URL Query 会导致日志与 Referer 泄露（Agetor 也有专门的 `e2e/no-query-token.spec.ts` 防护）。
- **前端落地方案：**
  1. 前端使用 `fetch('/api/v1/events', { headers: { Authorization: 'Bearer ' + token, Accept: 'text/event-stream', ...(lastSeq ? { 'Last-Event-ID': String(lastSeq) } : {}) }, signal: abortController.signal })` 建立流式连接，通过 `ReadableStreamDefaultReader` + `TextDecoder` 按 `\n\n` 帧边界解析 `id:`、`event:`、`data:`。
  2. **客户端单调去重：** 前端 Store 维护 `lastAppliedSeq: number`，任何 `event.seq <= lastAppliedSeq` 的重放事件直接幂等忽略。
  3. **游标过期恢复（`409 EVENT_CURSOR_EXPIRED`）：** 当重连收到 HTTP `409` 且 `error.code === 'EVENT_CURSOR_EXPIRED'` 时，前端自动清空过期游标，先调用 `GET /api/v1/tasks` 与当前选中任务的 `GET /api/v1/tasks/:id` 刷新全量一致性快照，再以最新 `seq` 重新开启 `fetch` SSE 流，并在顶部状态栏显示“已同步最新状态快照”。

### 2. `pausing` / `cancelling` 过渡态、乐观锁 `expectedVersion` 与迟到消息处理
- **审查结论：完全赞同。** 外部 CLI 子进程（如 `codex exec`）不支持即时挂起或瞬时退出，前端绝不能在点击按钮瞬间乐观伪造 `paused` 或 `cancelled`。
- **前端落地方案：**
  1. 用户点击“暂停”或“取消”时，前端携带当前缓存的 `task.version` 调用 `POST /api/v1/tasks/:id/pause` 或 `/cancel`（`{ expectedVersion: task.version }`）。
  2. 收到 `202 Accepted`（`status: 'pausing'` 或 `'cancelling'`）后，按钮切换为禁用旋转态（`Pausing... 等待当前步骤停稳` / `Cancelling... 正在回收进程组`），直到 SSE 推送终态 `task.updated`（`status: 'paused'` 或 `'cancelled'`）。
  3. **处理 `409 CONFLICT / UNSUPPORTED_TRANSITION`：** 若因并发状态推进导致 `expectedVersion` 失配返回 `409`，前端不报错崩溃，而是立即拉取最新 `GET /api/v1/tasks/:id` 更新本地 `version` 与按钮可用态，并通过 Toast 提示用户“任务状态已更新，请确认最新状态后操作”。
  4. **取消中迟到消息展示：** 当任务处于 `cancelling` 或已进入 `cancelled` 后，若仍收到序号合法但属于终止前缓冲区刷出的 `run.output` 日志，前端仍按 `seq` 追加至对应 `AgentRun` 日志流末尾并标记 `[Drained before termination]`，但绝不让迟到的运行事件将任务状态回退为 `running` 或 `succeeded`。

### 3. Agent 能力降级（Capabilities-Driven UI）
- **审查结论：完全赞同。**
- **前端落地方案：**
  1. 前端根据 `GET /api/v1/agents` 返回的 `capabilities: Capability[]`（`'stream' | 'resume' | 'cancel' | 'live-context' | 'structured-output'`）动态控制控件行为。
  2. 例如 `Codex CLI` 首版不支持运行中实时注入（无 `'live-context'` 能力）：当 `AgentRun.status === 'running'` 时，工作区底部的输入框按钮文案自动从“实时注入当前回合”降级切换为 **“加入下一回合上下文队列 (Queue for Next Turn / Handoff)”**，明确告知用户该补充上下文将在当前 `turn` 结束后通过 `resume` 或下一子任务传递，不假装已实时注入正在运行的进程。

### 4. 消息与运行日志分页（`afterSeq` / `cursor` & 字节上限防护）
- **审查结论：完全赞同。**
- **前端落地方案：**
  1. **日志流分页：** 打开 `Agent Workspace` 时，默认调用 `GET /api/v1/runs/:id/logs?afterSeq=0&limit=200` 拉取首批日志，之后由 SSE `run.output` 增量追加；当日志超过长列表阈值时启用固定高度滚动容器与“加载更早/更多（按 `nextSeq`）”机制，防止大体积输出撑爆浏览器 DOM。
  2. **消息列表分页：** 调用 `GET /api/v1/tasks/:id/messages?cursor=...&limit=50` 按游标加载。

### 5. 成果安全引用（`artifactId` + `sha256` + 受控下载预览）
- **审查结论：完全赞同。**
- **前端落地方案：**
  1. 前端在 `Artifact Center`、`Message` 附件卡与 `Review Center` 中一律使用 `artifact.id` 请求 `GET /api/v1/artifacts/:id/content`，绝不拼接或传递本地文件系统绝对路径。
  2. 前端展示 `Artifact.relativePath`、`Artifact.sha256`（前 8 位缩写 + 悬浮完整复制）、`Artifact.size` 及 `Artifact.validationStatus`（`staged` | `validated` | `rejected`）。
  3. 渲染代码/Markdown 预览时，全部使用纯文本转义（`escapeHtml`）或沙箱化渲染，防止模型生成产物中包含恶意 XSS 载荷。

### 6. 审批摘要绑定（`actionDigest` + `expectedVersion` + `expiresAt`）
- **审查结论：完全赞同。**
- **前端落地方案：**
  1. `Review Center` 在渲染每张待决 `Approval` 卡片时，显式展示 `summary`、`actionType`、`actionDigest` 指纹以及倒计时 `expiresAt`。
  2. 当用户点击“批准 (Approve)”或“拒绝 (Reject)”时，前端原样提交当前卡片绑定的 `{ expectedVersion: approval.version, decision: 'approve' | 'reject', actionDigest: approval.actionDigest }`。
  3. 若底层产物或计划在用户审阅期间发生了变更导致后端返回 `409`（`invalidated` / `actionDigest` 不匹配），前端立即高亮提示“待审内容已发生变更，旧审批已失效，已为您刷新最新变更摘要”，防止盲批被篡改或已过期的操作。

---

## 二、建议在 `api-contract.md` (v0.2) 中补充的 5 项字段细节

为确保前端五个核心视图（任务列表、详情、运行日志、消息、成果及审批）高内聚渲染，建议 Codex 在修订 `v0.2` 契约时纳入以下字段：

1. **`GET /api/v1/tasks/:id` 聚合响应补充 `approvals` 与 `artifacts` 摘要列表：**
   - 当前草案返回 `{ task, subtasks, runs, validations }`；建议同时附带 `approvals: Approval[]`（当前任务的待决/历史审批列表）与 `artifacts: Artifact[]`（或保留在独立端点但在 `task` 上提供 `pendingApprovalCount` 与 `artifactCount`），以便任务详情页顶部一次性渲染待审批角标。
2. **`Subtask` DTO 显式包含 `code`（人类可读短编号，如 `"SUB-01"`）与 `dependsOn: string[]`：**
   - UUID 用于逻辑主键，同时提供短编号 `code` 便于在日志、消息引用和 UI 卡片标题中紧凑展示。
3. **`Message` DTO 补充人类可读的发送方/接收方标签或角色映射（`fromLabel`, `toLabel`, `summary`）：**
   - 除 `fromRunId`、`toSubtaskId` 外，增加简短 `summary`（一行摘要）便于在消息时间线和通知横幅中快速扫读。
4. **`Approval` DTO 增加可选的 `diffText?: string` 或 `artifactRefs?: string[]`：**
   - 当审批涉及代码变更或测试配置时，前端可直接关联拉取对应 Artifact 的只读预览，实现“边看 Diff 边点 Approve”的单屏体验。
5. **在 `/api/v1/health` 或 `/api/v1/meta` 暴露 `executionMode: 'live' | 'mock'` 与当前后端连接状态：**
   - 便于前端在顶栏自动校验并展示当前连接的究竟是真实后端还是本地测试桩。
