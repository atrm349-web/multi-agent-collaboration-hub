# C-06 HTTP/SSE 契约草案 v0.1

**设计，尚无已运行的 Hub API。** Agetor 原有 API 路径不同；选型确认后先核对并映射，避免同时维护两套重复接口。

本地单用户：绑定 127.0.0.1，Bearer 令牌经受控启动传给 UI；不写入 URL/日志。CORS 仅精确允许开发来源；Origin 校验、鉴权、方法/内容类型校验仍必须执行，不因 loopback 省略。所有凭据和 provider 原始认证状态不可通过 API 返回。

统一前缀 `/api/v1`。成功返回 `{data, requestId}`；列表 `{data:[], nextCursor:null, requestId}`；错误 `{error:{code,message,retryable,details},requestId}`。DTO 见 backend-plan.md；路径用 artifact id 引用，不接受用户任意绝对路径下载。时间 UTC ISO-8601、UUID、状态 snake_case。

| 方法与路径 | 请求 / 查询 | 响应 / 语义 |
|---|---|---|
| POST /tasks | `{title,goal,repositoryId,acceptanceCriteria:[{id,description,testProfileId?}]}`；Idempotency-Key 必填 | 201 Task，重复同载荷 200；创建只入队，执行策略由配置决定 |
| GET /tasks | cursor,limit（默认20，最大100）,status? | 200 Task 摘要列表 |
| GET /tasks/:id | 无 | 200 `{task,subtasks,runs,validations}`；大日志另取 |
| GET /agents | 无 | 200 Agent 列表，含 capabilities/availability/权限摘要，排除秘密 |
| GET /runs/:id/logs | afterSeq,limit | 200 `{runId,items:[{seq,timestamp,stream,text}],nextSeq}`；脱敏和字节上限 |
| GET /tasks/:id/messages | cursor,limit | 200 Message 列表 |
| GET /tasks/:id/artifacts | cursor,limit | 200 Artifact 元数据 |
| GET /artifacts/:id/content | 无 | 按 MIME 返回内容，Content-Disposition/CSP 安全处理；只读已登记版本 |
| POST /tasks/:id/pause | `{expectedVersion}` | 202 `{taskId,status:'pausing',operationId}`；不再派发，活跃步骤停稳后 paused |
| POST /tasks/:id/resume | `{expectedVersion}` | 202；从 paused 继续派发，不承诺外部 CLI 可无损恢复 |
| POST /tasks/:id/cancel | `{expectedVersion,reason?}` | 202 cancelling；同意图重复请求幂等，等终态事件 |
| POST /approvals/:id/decision | `{expectedVersion,decision:'approve'|'reject',actionDigest}` | 200 Approval；过期/摘要不符/已决定返回409 |
| GET /events | taskId?；Last-Event-ID 头 | text/event-stream，可回放；无 query token |

Task 状态补充 `pausing`、`cancelling` 供前端呈现意图；与后端持久化实体保持一致，不能提前展示 paused/cancelled。

## 示例

```json
{
  "data": {
    "id": "11111111-1111-4111-8111-111111111111",
    "title": "验证 clamp 函数",
    "goal": "开发并审核边界处理",
    "status": "queued",
    "version": 1
  },
  "requestId": "22222222-2222-4222-8222-222222222222"
}
```

示例为设计数据，不能作为运行截图或验收证据。错误状态：400 INVALID_INPUT；401 UNAUTHENTICATED；403 PERMISSION_DENIED；404 NOT_FOUND；409 CONFLICT/UNSUPPORTED_TRANSITION；413 PAYLOAD_TOO_LARGE；429 RATE_LIMITED；503 AGENT_UNAVAILABLE。

## SSE

```text
id: 184
event: run.updated
data: {"seq":184,"timestamp":"2026-11-02T06:00:00Z","taskId":"...","runId":"...","version":4,"payload":{"status":"running"}}

```

事件：task.updated、subtask.updated、run.updated、run.output、message.created、artifact.created、validation.completed、approval.required、approval.decided。全局单调 seq，事务内持久化状态和 outbox，断线后按 Last-Event-ID 重放；前端按 seq 去重。保留窗口外返回 409 EVENT_CURSOR_EXPIRED，重新获取快照再订阅；心跳注释建议15秒。

浏览器原生 EventSource 不支持自定义 Authorization 头；前端使用 fetch 读取 SSE，或以后专门审查安全 cookie 方案，不能为方便改成 URL token。取消/状态控件必须处理 409、断线、不可用及待审批；禁用状态由 capabilities 和服务器状态决定。

## Antigravity 交付要求

先完成任务列表、详情、运行日志、消息和成果五个视图及审批/暂停/取消交互；不先实现复杂工作流编辑器。开发 mock 必须显著标记模拟，不写成真实执行。浏览器验收提供操作步骤、错误状态、断线重连、重复事件去重、取消中迟到消息及成果下载的证据。

字段变更由 Codex 修改契约，Antigravity 在独立意见文件提出变更；双方确认后增加版本，避免一方覆盖另一方代码。
