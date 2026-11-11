# Multi-Agent Collaboration Hub API v0.2（唯一当前基线）

2026-11-02；契约已统一，实施待迁移。对应 `packages/shared/src/types.v0.2.ts`。旧草案归档，不保证旧 Mock 的 `/api/*` 或字段兼容。

## 通用规则

- 绑定127.0.0.1；精确来源允许列表。除最小健康检查外均 Bearer 鉴权，禁止 query token；不使用固定开发 token 作为 live 认证。
- 时间 UTC ISO-8601；ID为UUID；code只是展示短编号。请求 JSON 的未知控制字段拒绝，禁止把客户端输入直接拼成 shell。
- 成功 `{data,requestId}`，列表的 data 是 `{items,nextCursor}`；错误 `{error:{code,message,retryable,details?},requestId}`。executionMode 在实体和 meta 中声明，不替代 requestId。
- 普通列表 limit默认20、最大100，稳定按 createdAt/id 排序；日志limit默认200、最大500，并设响应字节上限。cursor不透明，不承担授权。
- 可变实体 version用于CAS；运行时版本与软件 adapterVersion 分开。401重新认证，403权限不足，404不存在，409冲突，413过大，429限流，503执行器不可用。
- schemaVersion/contractVersion 均为 `0.2`；不因接口存在就宣称功能已实现。

## 端点

下表除 content/events 外均使用统一信封；非特别说明返回200。

| 方法与路径 | 输入 | data / 行为 |
|---|---|---|
| GET /health | 无；可不鉴权 | `{status:'ok'}`，不公开运行/账号/目录 |
| GET /meta | 无 | Meta：版本、模式、liveExecutionAvailable、可用功能 |
| GET /repositories | cursor,limit | Page<RepositoryRef>；仅服务端已登记的允许仓库，首版不提供任意路径注册接口 |
| POST /tasks/decompose | `{goal,repositoryId}`；Idempotency-Key | 生成 DraftPlan，不启动代码执行；需要真实规划但CLI不可用时503，不静默切Mock |
| POST /tasks | CreateTaskRequest；Idempotency-Key | 201 Task；先queued，调度器按策略执行。plannedSubtasks可选，服务端重新校验DAG/权限 |
| GET /tasks | cursor,limit,status? | Page<Task>，不是全量state |
| GET /tasks/:id | 无 | TaskDetail，含subtasks/runs/validations及审批/成果有上限的Page |
| GET /tasks/:id/runs | cursor,limit | Page<AgentRun>，用于详情运行历史翻页 |
| GET /tasks/:id/validations | cursor,limit | Page<Validation>，用于详情验收记录翻页 |
| GET /agents | cursor,limit | Page<Agent>，含capabilities、unsupportedReasons，不含凭据 |
| GET /snapshot | taskId? | Snapshot：单一数据库一致性视图和snapshotSeq，见下节 |
| GET /runs/:id/logs | afterSeq（per-run logSeq）,limit | LogPage；nextSeq为已返回最后logSeq，hasMore表示尚有历史条目 |
| GET /tasks/:id/messages | cursor,limit | Page<Message> |
| GET /tasks/:id/artifacts | cursor,limit | Page<Artifact> |
| GET /tasks/:id/approvals | cursor,limit,status? | Page<Approval> |
| GET /artifacts/:id/content | 无 | 已登记不可变内容；nosniff、CSP、限长、受控下载；禁止请求本地绝对路径 |
| POST /tasks/:id/pause | `{expectedVersion}`；Idempotency-Key | 202 `{taskId,status:'pausing',operationId}`；停止新派发，活跃步骤停稳后paused |
| POST /tasks/:id/resume | `{expectedVersion}`；Idempotency-Key | 202 `{taskId,status:'queued',operationId}`；仅从paused恢复；不是provider精确断点恢复保证 |
| POST /tasks/:id/cancel | `{expectedVersion,reason?}`；Idempotency-Key | 202 cancelling，等终态；取消覆盖待派发和迟到成功 |
| POST /subtasks/:id/retry | `{expectedVersion,reason}`；Idempotency-Key | 202；仅失败/超时且无活跃run、次数未耗尽时新attempt，不能复写旧run |
| POST /subtasks/:id/rework | `{expectedVersion,reason,artifactRefs}`；Idempotency-Key | 202；验证态或waiting_approval下发起返工，无活跃run；失效旧审批，影响的后续依赖阻塞 |
| POST /approvals/:id/decision | `{expectedVersion,decision:'approve'|'reject',actionDigest,comment?}`；Idempotency-Key | Approval；校验摘要/版本/期限；拒绝阻止动作，需返工再单独调用rework |
| POST /tasks/:id/messages | `{toSubtaskId,content,artifactRefs}`；Idempotency-Key | 201 `{message,delivery:'queued_next_turn'}`，首版只排队；上下文不执行为终端命令 |
| GET /events | taskId?；Last-Event-ID头 | SSE：见下节 |

表中路径均相对 `/api/v1`。命令执行、仓库登记、任意timeout延长、模拟reset/step/error不暴露为首版通用公开控制接口。

幂等键按操作/资源作用域保存，绑定规范化载荷摘要；同key同载荷返回原响应，同key不同载荷409。CAS失配409且不自动重试控制动作。Idempotency-Key不替代权限校验。创建计划的模型调用同样可能消耗配额。

## 数据、状态与验收

完整DTO字段见 types.v0.2.ts。七类实体均明确executionMode；Task/Run/Message/Artifact/Validation记录 provenance=`current`或`historical`。旧真实relay以只读历史证据展示，不能在Mock中推进状态或算作当前执行完成。每Task首版最多100个Subtask，超限拒绝，故详情subtasks可作为有界完整DAG返回。

- Task：draft→decomposing→queued→running→succeeded/failed/timed_out；可进入waiting_approval、pausing→paused、cancelling→cancelled。终态不被迟到消息回退；首版不原地重启终态整体任务，用户可创建新Task。
- Subtask：pending→ready→running→validating→succeeded；可进入waiting_approval、retry_wait、blocked、failed、timed_out、cancelled。返工创建新attempt，内部记录原因，不另造reworking成功语义。
- Run：queued→starting→running→succeeded/failed/timed_out/interrupted，取消经cancelling→cancelled。exit=0缺终态事件算错误，不算完成。
- Approval：pending→approved/rejected/expired/invalidated。approve不直接将Task变成功；仍需满足全部验收。
- Agent availability：unknown/available/busy/unavailable/disabled；缺能力返回UNSUPPORTED_CAPABILITY，UI禁用并解释。
- Artifact validationStatus：staged/validated/rejected，内容变更创建新版本/ID；不可变版本SHA-256与审批摘要绑定。

maxAttempts默认2，含首次；attempt从1计数，timeoutMs为每run执行上限，idleTimeoutMs单独选配。认证/权限错误不自动重试；429尊重Retry-After与截止时间。Task timed_out只在整体期限触发；单run超时先由重试策略处理，不直接终止所有Task。

Task成功需要必要步骤成功、测试实际通过、必需产物哈希/存在性有效、审核完成且无待决审批。前端progressPct仅显示，不是成功判据。独立Worktree不能保证Git共享元数据完全无锁；并发冲突须排队或报WORKTREE_CONFLICT，禁止破坏性reset作为自动恢复。

## SSE、日志和一致性

事件格式：`id: <global seq>`、`event: <type>`、`data: <EventEnvelope JSON>`，空行结束。seq为安全整数，日志中的logSeq是单run序号，不可混用。事件类型：task.updated、subtask.updated、agent.updated、run.updated、run.output、message.created、artifact.created、validation.completed、approval.required、approval.decided。事件携带schemaVersion/taskId?/runId?/version?/payload；payload的变更实体采用当前DTO。

客户端使用fetch流携带Authorization与Last-Event-ID，不用原生EventSource URL token。解析须兼容分块UTF-8、CRLF、跨chunk帧、多行data、心跳注释；不能只对单次chunk调用split。每条订阅单独保存游标，按seq去重；过滤后的序号允许跳跃。

首次读取 `/snapshot?taskId=...`：后端在同一事务读取当前Task摘要Page、Agent Page、选中TaskDetail及snapshotSeq。所有返回Page都有nextCursor，未展示的集合通过对应列表端点读取，不能把分页首批当作全部。随后订阅相同范围events，Last-Event-ID=snapshotSeq，重放所有seq大于水位的事件。状态变更与outbox同事务提交，防止快照至订阅期间丢失。

游标格式非法400；超前于服务水位或早于保留窗口409 EVENT_CURSOR_EXPIRED。客户端重新获取一致性snapshot再订阅，不能将多次独立GET的最后一次seq随意拼成一致性快照。若快照在订阅前已过期，重复该流程。心跳建议15秒；错误后指数退避且支持AbortController取消。

日志页以logSeq去重。Task已取消后的输出可追加标记drained=true，但不得覆盖终态。SSE是至少一次交付，不保证恰好一次；客户端必须幂等应用和处理version陈旧事件。

## 错误和模式

统一代码：INVALID_INPUT、UNAUTHENTICATED、PERMISSION_DENIED、NOT_FOUND、CONFLICT、UNSUPPORTED_TRANSITION、UNSUPPORTED_CAPABILITY、EVENT_CURSOR_EXPIRED、PAYLOAD_TOO_LARGE、AGENT_UNAVAILABLE、BINARY_NOT_FOUND、AUTH_REQUIRED、RATE_LIMITED、SPAWN_ERROR、TRANSPORT_ERROR、TURN_FAILED、MISSING_TERMINAL_EVENT、TIMEOUT、CANCELLED、WORKTREE_CONFLICT、DEPENDENCY_FAILED、ARTIFACT_INVALID、ACCEPTANCE_FAILED、PROCESS_CRASHED。

旧AGENT_TIMEOUT→TIMEOUT，CLI_NOT_FOUND→BINARY_NOT_FOUND，TEST_ASSERTION_FAILED→ACCEPTANCE_FAILED，recoverable→retryable。终端细节需脱敏，禁止回传认证文件、完整环境变量或秘密参数。

meta.executionMode说明当前服务，liveExecutionAvailable表示当前可派发真实CLI；实体executionMode与provenance说明数据来源。Mock可含只读historical/live证据，必须分区展示，不能使服务顶栏显示“真实执行已接通”。Mock/live切换必须明确配置与用户选择，禁止故障时自动静默降级模拟。

## 契约验收（尚待迁移执行）

检查页形状、DTO状态/错误枚举、所有控制CAS/幂等、审批摘要和过期、路径越界、Auth/Origin、快照订阅竞态、游标过期、UTF-8分块与CRLF、取消后迟到输出、能力禁用、Mock与历史证据隔离。HTTP/API测试和真实浏览器测试分别记录；真实CLI取消/恢复需独立证据。
