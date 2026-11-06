# C-02/C-03 后端架构草案

状态：待选型确认的设计，不是已经实现的平台。优先映射到候选原有目录，不建立第二套平行基础设施。

## 模块与输入输出

| 模块 | 输入 → 输出 | 依赖与约束 |
|---|---|---|
| Task Manager | 用户目标、验收要求 → Task | SQLite 事务、请求幂等键；不自动执行用户文本中的命令 |
| Planner | Task、可用能力 → 结构化 Subtask DAG | 通过 Adapter 生成；校验 JSON、依赖存在、无环、数量上限、明确验收 |
| Scheduler | 就绪步骤、运行额度 → AgentRun | 按能力和状态选 Agent；事务 claim；不可仅靠模型决定完成 |
| Workflow Engine | 执行/审核事件 → 状态推进、有限返工 | attempt 上限、截止时间、取消优先、版本 CAS |
| Agent Adapter | 受控请求 → 事件、终态、结果 | 官方 CLI，明确权限，独立 provider session id |
| Message Bus | handoff/review/fix → 持久化消息 | 事务写消息+outbox；消费者幂等去重；至少一次投递 |
| Workspace Manager | repo/base SHA → workspace lease | 受控 Git，独立工作区、路径约束；Worktree 不当沙箱 |
| Result Validator | 产物、验收清单 → 验收记录 | 协调器运行授权测试；审核意见不等于验收成功 |
| Approval Manager | 明确操作摘要 → 一次性批准/拒绝 | 绑定动作、路径、参数哈希与期限；修改后旧审批失效 |
| Artifact Store | 合法文件引用 → 不可变版本、SHA-256 | 固定根、拒绝逃逸/符号链接、大小限制、原子落盘 |
| HTTP/SSE | UI 请求/订阅 → DTO/可回放事件 | 回环、鉴权、分页、错误码，不泄漏原始凭据 |

## 数据模型

所有 ID 用 UUID，时间为 UTC ISO-8601，UI 转本地时区；可变实体带 version、createdAt、updatedAt。错误统一 `{code,message,retryable,details}`，details 不含密钥。

| 实体 | 必要字段及关联 | 生命周期 |
|---|---|---|
| Task | id,title,goal,repositoryId,baseCommit,acceptanceCriteria[],status,version,error | draft→queued→running→succeeded/failed；经 pausing→paused、cancelling→cancelled，可进入 waiting_approval |
| Subtask | id,taskId,role,description,dependsOn[],requiredCapabilities[],acceptanceCriteria[],attempt,maxAttempts,assignedAgentId,status | pending→ready→running→validating→succeeded；失败可 retry_wait 或终止 |
| Agent | id,adapterId,label,capabilities,permissionProfile,maxConcurrency,availability | unknown/available/busy/unavailable/disabled；配置与实时状态区分 |
| AgentRun | id,subtaskId,agentId,attempt,idempotencyKey,providerSessionId,workspaceId,pid,leaseUntil,lastSeq,status,exitCode,error,startedAt,endedAt | queued→starting→running→cancelling→cancelled；或 succeeded/failed/timed_out/interrupted |
| Message | id,taskId,fromRunId,toSubtaskId,kind,correlationId,causationId,artifactRefs[],payload,deliveredAt | pending→delivered；处理幂等键独立于送达时间 |
| Artifact | id,taskId,producerRunId,relativePath,sha256,size,mimeType,kind,validationStatus | staged→validated/rejected；内容不可变，变更新建版本 |
| Approval | id,taskId,runId,actionType,actionDigest,summary,status,expiresAt,decidedBy,decidedAt | pending→approved/rejected/expired/invalidated；不可复用扩大权限 |

补充持久化：subtask_dependencies、validation_runs、workflow_events/outbox、workspace_leases、message_receipts。优先复用已有 task/run/event 表，迁移添加必要外键及索引，不将既有用户库直接用于实验。

## 状态及恢复规则

1. 同一 Task 的推进序列化；运行 claim 使用事务与唯一键 `(subtaskId,attempt)`。启动进程与写数据库不是原子操作，需 starting 状态、lease 和启动对账。
2. 只有依赖全部成功、能力和权限均满足才能进入 ready。重试产生新 run；保留旧错误。默认最多 2 次 attempt，认证/权限/输入错误不自动重试，429 按 Retry-After 受截止时间约束。
3. pause 是停止派发并等待正在运行的步骤停稳；不假装所有 Agent 支持即时暂停。cancel 先记录意图，停止后续派发，再终止进程组并回收；迟到成功不得覆盖 cancelled。
4. 重启后对账 active lease、PID/启动时间、会话日志和 provider session。失联标 interrupted；先判断外部副作用，再决定新 attempt 或显式 resume，禁止不确定时直接重复执行。
5. Task 成功要求：必要步骤全部通过、审核完成、授权验收命令 exit=0、必需产物存在且哈希有效、无待决审批。Agent 自报完成只是输入信号。
6. Worktree 由协调器创建/提交/集成；禁止为 Git 写入而自动扩大 Agent 权限。并行只读审核可共享不可变快照；并行修改必须使用不同工作区并明确合并冲突处理。

## Agetor 复用映射（待确认）

保留 `db.ts`/migrations、`server.ts`/SSE、`worktree.ts`、Codex JSONL 驱动、流水线事件；增加一个薄的能力/权限契约，在现有启动入口落实，不重写所有 harness。禁止未选择的 CLI 自动发现后启用执行。新增验收由协调器调用，不能依赖 `<handoff>` 自报。

## 优先级

P0：选型确认→安全策略→Adapter 终态/取消→数据库幂等/恢复。

P1：结构化规划→依赖调度→中心消息→隔离成果→审核/返工闭环→API。

P2：Antigravity 前端集成和浏览器证据→故障注入回归→本地 MVP 验收。

当前 prototype/relay.py 是 CLI 技术证明，不是上述 Task Manager、HTTP 服务或通用调度器。
