# C-04 Agent Adapter 契约草案 v0.1

状态：设计供双方审查；实际原型只覆盖 Codex CLI 子集。

```ts
type Capability = 'stream' | 'resume' | 'cancel' | 'live-context' | 'structured-output';
type RunStatus = 'queued' | 'starting' | 'running' | 'cancelling' |
  'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted';
type Sandbox = 'read-only' | 'workspace-write';
interface RunRequest {
  runId: string; idempotencyKey: string; prompt: string;
  workspaceId: string; sandbox: Sandbox; timeoutMs: number;
  artifactRefs: string[]; providerSessionId?: string;
}
interface AdapterEvent {
  runId: string; seq: number; timestamp: string;
  type: 'started' | 'output' | 'tool' | 'artifact' | 'approval' | 'completed' | 'error';
  payload: Record<string, unknown>;
}
interface AgentAdapter {
  describe(): Promise<{ id: string; version: string; capabilities: Capability[];
    sandboxModes: Sandbox[]; auth: 'existing-cli-login' | 'external-secret-ref' }>;
  start(request: RunRequest): Promise<{ runId: string; status: RunStatus }>;
  events(runId: string, afterSeq?: number): AsyncIterable<AdapterEvent>;
  getStatus(runId: string): Promise<RunStatus>;
  cancel(runId: string): Promise<void>;
  getResult(runId: string): Promise<{ status: RunStatus; providerSessionId?: string;
    artifactRefs: string[]; error?: {code: string; message: string; retryable: boolean} }>;
  sendContext?(runId: string, messageId: string): Promise<void>;
}
```

## 语义

- 统一 runId 由协调器分配，providerSessionId 是不透明外部 ID；run 与 session 不混为一谈。resume 是新 run，在允许情况下引用旧 session。
- `start` 先持久化幂等请求再启动；同幂等键同载荷返回既有 run，不同载荷返回 CONFLICT。崩溃后的不确定启动必须对账，不能承诺恰好一次进程创建。
- capability 缺失直接 UNSUPPORTED_CAPABILITY；调用者可排队在下一轮传上下文，不能假装已经实时注入。Codex exec 首版不支持运行中的 sendContext 或进程即时暂停。
- `cancel` 幂等；已终态保持原终态；活跃运行先记录 cancelling，再发送终止、限时升级和回收。cancel 请求返回不表示已结束，必须等 cancelled 事件/状态。
- timeout 与 cancelled 区分；未知事件保留诊断，终态需要明确成功事件和进程结果；exit=0 但缺终态返回 MISSING_TERMINAL_EVENT。
- provider 会话恢复不等于恢复崩溃时的精确执行点。已执行 Git/外部操作须先核对，不能盲目重放。

## Codex CLI 初期映射

官方来源：[Non-interactive mode](https://developers.openai.com/codex/noninteractive)。当前 CLI 帮助与实际调用已核查。

`codex exec --json --sandbox read-only|workspace-write -C <受控目录> -`，prompt 通过 stdin，不拼接 shell；恢复为 exec 级参数置于 `resume <明确 session id> -` 前。不使用 `--last`，避免串错会话。结构化输出可用 `--output-schema`；原型用 JSON 内容解析及固定 AST 校验，尚未验证该 CLI 选项。

保留 `thread.started`、turn/item 事件，日志增加协调器 seq。`turn.completed` 加 exit=0 只说明此次模型运行结束，结果仍需验收。依赖官方 CLI 既有 ChatGPT 登录；不读取、复制或展示 auth.json，不新增 API Key，不承诺会员配额无限或后台会话长期可用。

原型使用 `--ignore-user-config` 避免继承用户执行配置，并显式只读；仍不代表 OS 完整文件读取隔离。通用平台需要另行验证配置、插件、hooks、网络与可读目录策略，不能仅靠 prompt 控制权限。

## 错误分类

AUTH_REQUIRED、RATE_LIMITED、BINARY_NOT_FOUND、UNSUPPORTED_CAPABILITY、PERMISSION_DENIED、INVALID_INPUT、SPAWN_ERROR、TRANSPORT_ERROR、TURN_FAILED、MISSING_TERMINAL_EVENT、TIMEOUT、CANCELLED、ARTIFACT_INVALID、ACCEPTANCE_FAILED。

分类须优先结构化 provider 错误和退出状态；无法可靠识别则保留通用错误与已脱敏诊断，不根据任意 stderr 中的关键字断言认证失败。认证错误不自动无限重试。

## 消息与产物

handoff 含 messageId、taskId、fromRunId、toSubtaskId、kind、correlationId、artifactRefs、acceptanceRefs；上下文通过不可变文件版本引用，不把凭据或整机目录默认共享给下一 Agent。审核输出需要问题列表和验收证据引用。模型生成的 JSON、路径和命令均不可信，必须通过边界校验。
