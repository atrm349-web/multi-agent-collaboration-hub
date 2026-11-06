# 后续需要 OpenAI Codex 配合完成的后端开发任务清单（`docs/codex-tasks.md`）

**文档版本：** V1.0  
**发件人：** Antigravity（首席前端工程师 + UI/UX 负责人 + 浏览器集成测试负责人）  
**收件人：** OpenAI Codex（首席后端工程师 + 系统架构负责人 + Agent 编排引擎负责人）

---

## 协作背景说明

Antigravity 已完成第一阶段开源项目审查（`docs/open-source-evaluation.md`）、前端架构方案（`docs/frontend-plan.md`）、页面设计（`docs/ui-pages.md`）、前后端共享类型契约（`packages/shared/src/types.ts`、`docs/api-contract.md`），并已在 `apps/web/` 下构建了可本地运行、带完整状态机模拟器的最小可交互原型。

为将系统从 `executionMode: 'mock'` 推进至真实的多 Agent 生产协同（`executionMode: 'live'`），请 Codex 按照以下任务编号、接口需求与验收条件开展后端核心开发：

---

## 任务列表与验收条件

### 任务 `C-01`：核心持久化存储与任务/子任务 DAG 状态机实现
- **所属层级：** 第二层（任务调度核心 `packages/core`）
- **开发内容：**
  1. 基于 SQLite（如 Node.js v22/v24 内置 `node:sqlite` 或 `better-sqlite3`）实现 7 大实体（`Task`, `Subtask`, `Agent`, `AgentRun`, `Message`, `Artifact`, `Approval`）的持久化存储。
  2. 实现 DAG 拓扑调度器：当某个 `Subtask` 状态变为 `completed` 时，自动检查所有 `dependsOn` 包含该子任务的下游节点；若前置依赖全部 `completed`，自动将其状态从 `pending` 置为 `ready` 并推入执行队列。
- **接口要求：** 严格遵循 `packages/shared/src/types.ts` 与 `docs/api-contract.md`。
- **验收条件：**
  - 服务重启后，正在运行或暂停的任务状态、历史日志与产出物索引不丢失。
  - 循环依赖检测（Cycle Detection）能够在 `POST /api/tasks` 阶段拦截非法 DAG 并返回结构化错误。

---

### 任务 `C-02`：Git Worktree 隔离管理器与跨子任务上下文合并
- **所属层级：** 第四层（执行与存储 `packages/core/worktree`）
- **开发内容：**
  1. 借鉴 `alamops/agetor` 的分支与 Worktree 隔离机制，在每个 `Subtask` 启动前创建独立的工作区：`~/.multi-agent-hub/worktrees/<taskId>/<subtaskCode>` 与独立分支 `hub/<taskId>/<subtaskCode>`。
  2. 当并行子任务（如 `SUB-02` 赛道识别与 `SUB-03` 障碍物检测）均完成后，为下游依赖子任务（如 `SUB-04` 集成测试）创建集成分支并自动合并上游分支变更；若出现 Git 冲突，捕获冲突文件列表并生成 `StructuredError.code = 'WORKTREE_CONFLICT'` 上报前端。
- **验收条件：**
  - 两个并行运行的 Agent 进程在同一 Git 仓库下同时读写文件不会发生锁冲突或工作区污染。
  - 前端 `Review Center` 可以通过 `GET /api/artifacts` 获取每个子任务分支相对于 `baseCommit` 的真实 `git diff` 内容与 `diffStats`。

---

### 任务 `C-03`：统一 `AgentAdapter` 接口与本地 CLI 运行时集成
- **所属层级：** 第三层（Agent Adapter `packages/agent-adapters`）
- **开发内容：**
  1. 实现统一的 `AgentAdapter` 接口：
     - `startTask(runInput): Promise<AgentRunHandle>`
     - `getStatus(runId): Promise<AgentRunStatus>`
     - `cancelTask(runId): Promise<void>`
     - `sendContext(runId, message): Promise<void>`
     - `getResult(runId): Promise<Artifact[]>`
     - `getLogs(runId, cursor?): AsyncIterable<LogLine>`
  2. 首批优先实现 **`CodexCliAdapter`**：调用本地已登录的 `codex exec --json`（参考 `agetor` 的 `src/bun/codex-tmux.ts`），严格使用用户本地已有的 ChatGPT Plus CLI 登录态，不要求额外付费 API Key。
  3. 实现进程生命周期探测与预检接口（检查本地 `PATH` 是否存在对应 CLI 二进制及登录状态，若缺失返回 `CLI_NOT_FOUND` 或 `AUTH_REQUIRED`）。
- **验收条件：**
  - 启动任务后，真实子进程的 `stdout`/`stderr` 通过 `GET /api/stream` 的 `run.log` 事件实时推送到前端 `Agent Workspace` 面板，延迟低于 300ms。
  - 点击前端 `Cancel` 或 `Pause` 按钮时，能够可靠终止或挂起对应子进程树，无僵尸进程残留。

---

### 任务 `C-04`：自然语言任务自动拆解引擎（Task Decomposer）
- **所属层级：** 第二层（任务调度核心 `packages/core/decomposer`）
- **开发内容：**
  1. 实现 `POST /api/tasks/decompose` 的真实后端逻辑：调用主规划 Agent（默认使用 Codex CLI）分析用户自然语言 Prompt 与目标仓库目录结构，输出符合 JSON Schema 的 `Subtask[]` 列表（含阶段划分、推荐 Agent、前置依赖 `dependsOn` 和验收条件 `acceptanceCriteria`）。
  2. 当 CLI 离线或用户选择沙箱演练模式时，优雅回退至启发式模板拆解器并标注 `executionMode: 'mock'`。
- **验收条件：**
  - 输入交接文档中的示例 Prompt（Python 智能车视觉识别系统），能在规定时间内返回结构合法的多阶段 DAG 子任务列表。

---

### 任务 `C-05`：自动化质量审核、超时监控与失败返工（Rework Loop）
- **所属层级：** 第二层（任务调度核心 `packages/core/quality-gate`）
- **开发内容：**
  1. 实现单步超时看门狗（Watchdog）：当 `AgentRun` 超过 `Task.timeoutSeconds` 时，自动终止进程，写入 `StructuredError.code = 'AGENT_TIMEOUT'` 并推送 `task.updated` 事件。
  2. 实现测试验证与自动返工：当测试阶段子任务退出码非 0 或人工在 `Review Center` 点击 `Request Rework` 时，自动构建包含失败日志、Diff 评审意见的 `rework_instruction` 消息，通过 `sendContext` 注入给原负责 Agent 重新拉起 `AgentRun`（直至达到 `maxRetries`）。
- **验收条件：**
  - 前端触发 `Request Rework` 或模拟测试失败时，能够完整走通 `running → awaiting_approval/failed → reworking → running → completed` 闭环。

---

### 任务 `C-06`：候选 Agent 扩展预研（DeepSeek Harness 认证与成本验证）
- **所属层级：** 第三层（Agent Adapter 预研）
- **开发内容：**
  1. 验证 DeepSeek Harness 的实际接入方式（本地 CLI / 标准 API / 模型服务认证成本），输出简短的技术可行性评估，并在 `Settings` 接口中暴露配置状态。
  2. 严格遵守“不使用 Cookie 提取、不绕过身份认证、不违反服务条款”的技术红线。
