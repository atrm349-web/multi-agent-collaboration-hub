# Multi-Agent Collaboration Hub — 页面结构、功能与交互说明（`docs/ui-pages.md`）

**文档版本：** V1.0  
**编写角色：** Antigravity（UI/UX 设计负责人）  
**设计风格定位：** 专业开发工具级深色界面（借鉴 Linear / Agetor / Vibe Kanban 精髓），高信息密度、状态语义色彩明确、零花哨干扰。

---

## 一、全局布局结构（Workbench Shell）

平台采用**四区固定工作台布局**，确保用户在执行任何复杂操作时都不会迷失上下文：

1. **顶部全局控制栏（Top Control Bar）**
   - **项目与仓库选择器：** 显示当前绑定的本地 Git 仓库路径（如 `~/projects/smartcar-vision`）与基准分支（`main @ a4f92c1`）。
   - **运行模式显著标识（Execution Mode Pill）：**
     - `MOCK SIMULATOR`（琥珀色警示徽章）：明确告知当前处于模拟演示数据或沙箱演练模式。
     - `LIVE RUNTIME`（翠绿色实心徽章）：明确标识当前连接真实本地 CLI Agent 进程与真实 Git Worktree。
   - **全局系统健康度与快捷操作：** 活跃 Agent 数、运行中子任务数、待人工审核门禁数（闪烁提醒）、`+ 新建协同任务` 快捷按钮。

2. **左侧主导航栏（Left Navigation Rail）**
   - 包含 8 个一级模块入口（支持数字快捷键 `1`-`8` 切换，且**切换页面绝不丢失当前选中的任务、过滤器和输入框草稿**）：
     1. `Dashboard`（总览与舰队监控）
     2. `Task Center`（任务发布与看板队列）
     3. `Workflow View`（子任务 DAG 依赖拓扑）
     4. `Agent Workspace`（多 Agent 实时终端与 Worktree 监控）
     5. `Communication Panel`（Agent 间上下文交换与消息总线）
     6. `Review Center`（代码 Diff、测试验证与人工审批门禁）
     7. `Artifact Center`（代码、文档与测试报告成果库）
     8. `Settings`（Agent Adapter 配置与安全策略）

3. **中央主视图区（Primary Viewport）**
   - 根据当前激活的模块渲染对应工作区，顶部固定显示**当前选中任务的快捷上下文条（Active Task Context Bar）**，包含任务状态徽章、总体进度条以及**全局任务控制按钮组（暂停 Pause / 恢复 Resume / 注入异常演练 Simulate Error / 重试 Retry / 取消 Cancel）**。

4. **右侧/底部可折叠实时检视面板（Live Inspector Drawer）**
   - 在任何页面均可快速查看当前任务的最新 Agent 间通信消息与错误告警，点击告警可直接跳转到对应的子任务或审批单。

---

## 二、八大核心模块页面与交互详解

### 1. Dashboard（项目总览与 Agent 状态）
- **核心功能：**
  - **KPI 指标卡：** 总任务数、执行中子任务数、并发活跃 Agent 数、待人工审批（Pending Approvals）数、测试通过率。
  - **Agent 舰队状态矩阵（Agent Fleet Matrix）：** 展示已注册的每一个 Agent（`OpenAI Codex CLI`、`Google Antigravity`、`Claude Code CLI`、`DeepSeek Harness`），显示其实时状态（`idle` / `busy` / `offline` / `error` / `rate_limited`）、当前分配的子任务编号、绑定的 Git Worktree 路径与认证方式（本地 CLI 登录态 / SDK 会话）。
  - **活跃任务闭环流水线概览：** 直观展示“发布 → 拆解 → 执行 → 上下文移交 → 质量审核 → 返工/交付”的实时所处阶段。

### 2. Task Center（任务创建、拆解预览与状态看板）
- **任务快速创建与自动拆解器（Task Composer）：**
  - 提供自然语言输入框（内置一键填入示例任务：*“开发一个基于 Python 的智能车视觉识别系统，要求实现赛道识别、障碍物检测、测试验证，并生成完整开发文档”*）。
  - 支持配置：目标 Git 仓库路径、优先级（Low/Medium/High/Critical）、最大自动重试次数（默认 3 次）、单步超时时间、是否开启关键节点人工审批。
  - **交互亮点：** 点击“智能拆解并预览 DAG”可实时生成结构化子任务预览列表（显示每个子任务的负责 Agent 与前置依赖），确认后点击“启动多 Agent 协同”正式入列执行。
- **Kanban 状态看板与任务列表：**
  - 按状态分列展示：`Queued / Decomposing`、`Running`、`Awaiting Approval / Reworking`、`Paused / Failed / Timed Out`、`Completed`。
  - 每张任务卡清晰展示：任务标题、模式标签（`MOCK` / `LIVE`）、子任务完成比例、当前活跃 Agent 头像徽章、待审批红点或错误码提示，以及直接操作控件（暂停、取消、重试、进入详情）。

### 3. Workflow View（任务流程与子任务依赖 DAG 展示）
- **核心功能：**
  - 以有向无环图（DAG 拓扑阶段列）展示当前任务下的所有 `Subtask`：
    - **Stage 1 - 需求分析与架构设计（`SUB-01`）**：由 `Codex CLI` 生成接口规范与目录结构。
    - **Stage 2 - 并行模块研发（`SUB-02` 赛道识别 & `SUB-03` 障碍物检测）**：前置于 `SUB-01`，在两个独立的 Git Worktree 分支中并行执行，互不污染。
    - **Stage 3 - 集成测试与视觉评测（`SUB-04`）**：依赖 `SUB-02` 与 `SUB-03` 同时完成，汇总上下文并运行 Pytest 基准测试。
    - **Stage 4 - 完整开发文档与交付打包（`SUB-05`）**：依赖 `SUB-04` 审核通过，由 `Antigravity` 生成架构与 API 文档。
  - **交互能力：** 点击任意子任务节点可查看其前置依赖输入、验收标准（Acceptance Criteria）、独立分支名（如 `worktree/sub-02-lane-detect`）、产出物链接，并支持单独对该子任务执行“模拟超时/失败”、“触发重试”或“跳过”。

### 4. Agent Workspace（多 Agent 协作监控与实时日志面板）
- **核心功能：**
  - **多分栏/可切换 Agent 终端流（Multi-Agent Live Log Console）：** 支持按 Agent 或按 `AgentRun` 查看实时 `stdout` / `stderr` / `system` 日志流。
  - **运行元数据头：** 显示当前执行进程的 `PID`、`tmuxSession` 名称、执行的真实 CLI 命令（如 `codex exec --json -C ~/.hub/worktrees/sub-02`）、已运行时长与退出码。
  - **向运行中 Agent 发送补充指令（Follow-up Directive）：** 用户可在底部输入框向指定 Agent 发送人工干预指令，实时记入协作消息总线。

### 5. Communication Panel（Agent 间信息交换与共享上下文记录）
- **核心功能：**
  - 专为“多 Agent 像真正开发团队一样协同”设计的**结构化消息总线视图**，而非普通单人聊天记录。
  - 每条消息明确展示：`发送方 Agent (From)` → `接收方 Agent (To)`、消息类型标签（`任务拆解`、`上下文移交 Context Handoff`、`评审反馈 Review Feedback`、`返工指令 Rework Instruction`、`异常告警 Error Alert`、`人工指令 Human Directive`）。
  - **共享上下文附件卡（Shared Context Refs）：** 展示随消息传递的 Git Commit SHA、共享文件路径列表及关联的 `Artifact` 快捷跳转按钮。

### 6. Review Center（代码差异、质量门禁审批与测试结果）
- **核心功能：**
  - **待审批队列（Approval Gates）：** 集中展示所有处于 `pending` 状态的审核请求（方案签字、代码 Diff 审核、测试覆盖率门禁、最终交付验收）。
  - **双栏/统一代码 Diff 查看器：** 高亮显示新增（绿色 `+`）与删除（红色 `-`）代码行，展示修改文件统计（Files Changed / Insertions / Deletions）。
  - **一键审批与打回返工闭环：**
    - 点击 **“批准通过 (Approve & Continue)”**：当前子任务标记为 `completed`，自动解锁下游依赖子任务。
    - 点击 **“要求返工 (Request Rework)”**：输入审核意见后，任务状态自动流转为 `reworking`，通过消息总线向原执行 Agent 发送 `rework_instruction`，触发返工重跑。

### 7. Artifact Center（生成文件、代码、文档与测试报告预览）
- **核心功能：**
  - 集中展示任务产出的所有 `Artifact`，支持按类别过滤（`全部`、`代码文件 Code`、`差异补丁 Diff`、`测试报告 Test Report`、`开发文档 Documentation`）。
  - **结构化预览器：**
    - 代码与 Markdown 文档提供语法高亮与格式化视图。
    - 测试报告提供可视化通过率横条（Total / Passed / Failed / Coverage %）。

### 8. Settings（Agent 配置、工作区与容错策略）
- **核心功能：**
  - **Agent Adapter 配置表：** 查看与配置各 Agent 的本地 CLI 路径、认证方式说明（严格遵守“使用现有本地 CLI 登录态与合法 SDK，禁止 Cookie 提取或绕过认证”原则）、启用/禁用开关与最大并发数。
  - **Git Worktree 与沙箱策略：** 配置 Worktree 隔离根目录、任务完成后是否保留分支、默认超时时间与最大重试次数。

---

## 三、异常、超时、失败与错误恢复交互规范

1. **显著的结构化错误横幅（Error Banner）：** 当任务或子任务发生 `AGENT_TIMEOUT`、`TEST_ASSERTION_FAILED`、`WORKTREE_CONFLICT` 或 `CLI_NOT_FOUND` 时，在任务卡片和详情页顶部渲染红色高对比度错误面板，包含：
   - 错误代码（如 `AGENT_TIMEOUT`）与发生时间戳。
   - 人类可读的故障原因与原始进程退出码（如 `exitCode: 124`）。
   - 系统建议的恢复动作（`suggestedAction`）。
2. **一键恢复操作栏：**
   - **重试当前子任务（Retry Subtask）**：清理锁文件并重新拉起 `AgentRun`，递增 `retryCount`。
   - **打回上游返工（Rework with Context）**：附带错误日志发回给负责 Agent 进行自动修复。
   - **安全取消（Cancel Task）**：终止活跃子进程并保留现场日志供排查。
