# 双方统一方案 v0.2

日期：2026-11-02。Codex 已整理；等待 Antigravity 按确认清单读取并回复。

用户已授权本轮契约统一。本文件不代表已批准 Agetor 正式底座，也不代表前后端已经完成迁移。

## 唯一基线与文件职责

- 根目录 `docs/api-contract.md`：唯一正式 HTTP/SSE 契约 v0.2，替代原根目录 V1.0.0 和 Codex v0.1 草案。
- `packages/shared/src/types.v0.2.ts`：对应 DTO 类型基线；这是供迁移使用的新文件。
- **现有 `packages/shared/src/types.ts`、`apps/web/` 和原测试尚未迁移，不要声称已符合 v0.2。** Antigravity 迁移代码后再将类型基线整合进 types.ts，避免直接替换破坏现有原型。
- `docs/task-board.md`：统一任务编号和当前状态；`docs/codex-tasks.md`：迁移说明及后端优先级。
- `docs/archive/`：保存原根目录 API、看板、任务清单。`Codex/docs/`、`Antigravity/docs/` 和双方原 manifest 是历史交接，不再作为当前契约。
- Codex 主导后端契约；Antigravity 主导前端实现。共享类型和接口变更先记录意见并对齐版本，不能无协调覆盖。

## 已统一的决定

| 冲突项 | v0.2 统一决定 |
|---|---|
| API 前缀 | 仅 `/api/v1`；旧 `/api/*` 仅属旧 Mock，不是正式兼容保证 |
| 成功状态 | Task/Subtask/AgentRun 均为 `succeeded`，删除 `completed` 别名 |
| 等待审批 | `waiting_approval`，替代 `awaiting_approval` |
| 暂停/取消 | `pausing`/`cancelling` 是真实意图状态；停稳后才是 paused/cancelled |
| 审批与返工 | Approval 状态只有 pending/approved/rejected/expired/invalidated；返工通过独立 Subtask rework 操作，不再把 rework_requested 当审批决定 |
| 重试数量 | `maxAttempts` 含首次，`attempt` 从1计数；默认2。旧 maxRetries=n 转换为 maxAttempts=n+1 |
| 时间/错误 | UTC ISO-8601，超时用 timeoutMs；错误用 code/message/retryable，替代 recoverable |
| 路径与产物 | repositoryId/workspaceId/artifactId；成果只暴露 relativePath，不允许凭绝对路径下载 |
| 运行模式 | live/mock 加 provenance；展示历史真实实验不代表当前 Mock 后端拥有 live 调度能力 |
| 日志/SSE | run.output；全局 seq 与 per-run logSeq 分开；fetch SSE 鉴权、快照水位、断线回放 |
| 验收证据 | Node HTTP/API 测试与真实浏览器操作分别记录；模拟测试不能作为真实 CLI 验收 |

## Antigravity 五项建议的决定

1. 接受 Task 上 pendingApprovalCount/artifactCount，详情返回有上限的审批/成果 Page，避免无限聚合。
2. 接受 Subtask.code 和 dependsOn；code 仅展示，不作为主键。
3. 接受 Message.fromLabel/toLabel/summary；ID 为权威来源，标签仅用于显示。
4. 接受 Approval.artifactRefs 和 diffArtifactId；不把未限长 diffText 塞进全部审批响应。
5. 接受 `/api/v1/meta`：executionMode、liveExecutionAvailable、contractVersion。网络连接状态由前端自行探测，不是服务端固定字段。

额外接受 Agent.unsupportedReasons，解释能力禁用。排队上下文与实时 sendContext 分开，不假装所有 Agent 均支持即时注入。

## 首版与底座

双方推荐有条件复用 Agetor；D-01 仍待用户决定。B-01 必须禁止自动 danger-full-access，失败时明确报错。Web/Headless 可先验证，但 Agetor 当前 Codex 驱动仍依赖 tmux；换成浏览器界面不会自动消除该依赖，需要安装受控运行依赖或设计替代驱动并验证。

首版只自动接入已验证的 Codex 官方 CLI。Antigravity 是开发协作者，不列为已具备 live-context 的真实可调度 Agent。DeepSeek 预研留至 P2，不能成为第一轮阻塞项。

## Antigravity 读取后需要完成

请创建 `Antigravity/alignment-ack-v0.2.md`，写明：

1. 已读统一文档与 SHA-256 manifest；认可的版本和仍存在的异议。
2. F-03 前端迁移计划：旧字段、接口、状态、日志/SSE、审批及模式展示如何迁移。
3. 将原型的 `/api/v1/tasks` 返回全量 state 的行为改为真正 Task Page；旧路由暂保留时注明仅 Mock 兼容。
4. Mock reset/step/故障注入迁往隔离测试控制面，不进入 live API；明确不控制真实会话。
5. 新增契约测试和真实浏览器测试，分别报告，不能只修改 PASS 文案。
6. 尚未完成时明确列为 pending，不写“前后端已完全对齐”。

请勿自动执行 Codex 后端任务或直接改写 Codex 原型；底座确认、B-01 与后端 API 可用后再进入真实联调。
