# 开源项目技术审查与二次开发评估报告（任务 A-01）

**文档版本：** V1.0  
**编写角色：** Antigravity（首席前端工程师 / UI&UX 负责人 / 浏览器集成测试负责人）  
**审查范围：** `alamops/agetor`、`shep-ai/shep`、`BloopAI/vibe-kanban`  
**审查日期：** 2026-11-02

---

## 一、执行摘要与核心结论

我们对三个候选 GitHub 仓库的最新主干代码结构、`package.json`、许可证、维护活跃度及前后端架构进行了拉取与比对审查，核心结论如下：

| 维度 | 第一候选：`alamops/agetor` | 第二候选：`shep-ai/shep` | 界面参考：`BloopAI/vibe-kanban` |
| :--- | :--- | :--- | :--- |
| **开源协议** | **MIT License**（完全兼容二次开发） | **MIT License**（完全兼容二次开发） | **Apache-2.0** |
| **维护状态** | 极活跃（2026-11-02 仍有提交，v1.1.0） | 极活跃（2026-11-01 提交，v1.253.1） | **官方已宣布停止维护（Sunsetting）** |
| **主语言 / 运行时** | TypeScript + **Bun** + **Electrobun** + `tmux` | TypeScript + Node.js (>=22) + Next.js + Electron | **Rust (Cargo/SQLx/Tauri)** + React/TS |
| **前端技术栈** | React 19 + Vite 8 + Tailwind CSS 3 + `@xyflow/react` + `@dnd-kit` + `@xterm/xterm` | Next.js + React + Tailwind + Storybook + shadcn/ui | React + Vite + TanStack Router + Tailwind (`packages/ui`) |
| **Git Worktree 隔离** | 原生支持（每个任务独立 `agetor/<id>-<slug>` 分支与 Worktree） | 原生支持（每个 Feature 独立 Worktree） | 原生支持（Workspace 级 Worktree） |
| **已支持 CLI Agent** | Claude Code, **Codex**, Cursor, Gemini CLI, fx, **Antigravity (`agy`)**, Copilot, OpenCode | Claude Code, **Codex**, Kimi, Copilot, Cursor, Gemini, Cline, Ollama | Claude Code, Codex, Gemini, Amp 等 |
| **多 Agent 协同能力** | 支持 **Agent Profiles** 与 **Pipelines 画布编排**（`@xyflow/react`） | 支持 Spec-Driven (Requirements → Plan → Implement → PR) 与 `agent-message-bus` | 以单 Issue 对应单 Agent Workspace 为主 |
| **二次开发推荐度** | **★★★★☆（推荐复用前端架构与 CLI Harness 思想，需解耦 Electrobun）** | **★★★☆☆（推荐借鉴 Clean Architecture Port 接口与 Approval Gate）** | **★★☆☆☆（仅作 UI 组件与 Diff 交互参考，不作为代码底座）** |

---

## 二、任务 A-01 六大核心问题逐项解答

### 1. 哪个项目的 UI 最适合二次开发？
- **`alamops/agetor` 的前端技术栈与交互形态最契合本项目目标**，同时建议吸收 `BloopAI/vibe-kanban` 的 `packages/ui` 组件设计范式。
- **技术依据：**
  - `agetor` 采用 **React 19 + Vite 8 + Tailwind CSS 3 + Lucide Icons**，并已内置 `@dnd-kit/core`（看板拖拽）、`@xyflow/react` + `@dagrejs/dagre`（DAG 流程图自动布局）、`@xterm/xterm`（终端模拟器）以及 `react-markdown`（结构化文档渲染），与我们规划的看板 + DAG 工作流 + Agent 终端日志完全同构。
  - `BloopAI/vibe-kanban` 虽然 UI 组件划分非常清晰（如 `ChatApprovalCard.tsx`、`ChangesPanel.tsx`、`KanbanBoard.tsx`、`AskUserQuestionBanner.tsx`），但**该项目已在 README 顶部正式公告 "Vibe Kanban is sunsetting"**，且后端重度绑定 Rust (`crates/db`, `crates/server`, `electric` 同步引擎)，若直接 Fork 会给 Codex 的后端二次开发带来极高的 Rust 维护负担。
  - `shep-ai/shep` 的代码库过于庞大（总文件数 11,699 个，源码文件 4,594 个），包含 K8s Agent、ArgoCD、AWS Bedrock、WhatsApp/Telegram 网关、TypeSpec (`tsp`) 代码生成等大量企业级冗余模块，直接在其上二次开发负担过重。

### 2. 哪些组件与机制可以直接复用或移植？
- **从 `alamops/agetor` 可复用/移植的设计与模块：**
  1. **Kanban 状态列与卡片结构**：`Backlog → Ready → Running → Blocked → Review → Done` 状态映射及未读消息圆点提示（`unread_watermarks`）。
  2. **Pipeline DAG 畫布交互（`@xyflow/react` + `@dagrejs/dagre`）**：`agetor` 已实现节点连线与步骤状态高亮（`pipeline-blocked-step-highlight`），可直接扩展为我们平台的 **Subtask 自动拆解依赖拓扑图（Workflow View）**。
  3. **CLI Harness 驱动机制（供 Codex 后端参考）**：`src/bun/codex-tmux.ts`（使用 `codex exec --json` 并按 thread id 恢复会话）、`src/bun/antigravity-tmux.ts`（使用 `agy` stream-json 模式）、`src/bun/claude-tmux.ts`、`src/bun/git-diff.ts`。
- **从 `BloopAI/vibe-kanban` (`packages/ui/src/components/`) 可借鉴的 UI 组件结构：**
  1. `ChatApprovalCard.tsx` / `AskUserQuestionBanner.tsx`：人工审批与 Agent 提问交互卡片。
  2. `ChangesPanel.tsx` / `PierreConversationDiff.tsx`：代码变更 Diff 视图与行级评论引用回传给 Agent。
  3. `ContextUsageGauge.tsx` / `ToolStatusDot.tsx` / `TodoProgressPopup.tsx`：上下文消耗仪表与子任务进度指示器。
- **从 `shep-ai/shep` (`packages/core/src/application/ports/output/agents/`) 可借鉴的架构接口（供 Codex 参考）：**
  1. `agent-executor.interface.ts`、`agent-message-bus.interface.ts`、`agent-run-repository.interface.ts`。
  2. Spec-Driven 审批门禁（Approval Gates）与 CI 失败自动重试（默认 3 次）的状态机逻辑。

### 3. 是否需要改造现有路由、状态管理或布局？
- **需要改造。** `agetor` 原始 UI 采用“单看板主屏 + 侧边抽屉（Task Details Modal/Drawer）”的紧凑布局，主要面向“单用户手动创建卡片并指定单个 Agent/Pipeline 运行”。
- 而 **Multi-Agent Collaboration Hub** 的核心场景是“**一条自然语言任务 → 自动拆解为多子任务 DAG → 多 Agent 并发协作与上下文交换 → 质量审核与失败返工 → 集中交付成果**”。因此我们需要将布局升级为**专业级多视图工作台（Workbench Shell）**：
  - 左侧固定导航栏（Dashboard / Task Center / Workflow DAG / Agent Workspace / Communication Bus / Review Center / Artifact Center / Settings）。
  - 顶部全局状态栏（当前项目仓库、真实/模拟运行模式切换标识、活跃 Agent 计数、待人工审批告警徽章、快速发布任务入口）。
  - 主工作区支持在不同模块间无损切换，同时保留底部/右侧可折叠的实时 Agent 通信与日志流抽屉。

### 4. 任务状态和 Agent 消息是否容易实时显示？
- **非常容易，且已有成熟模式。**
- `agetor` 使用基于 Event ID 游标的增量事件流（`event-resume.ts`、`db-events-forward.test.ts`），`shep` 使用 `stream-agent-events.use-case.ts` 计算状态/消息/审批增量（Delta）。
- 在我们的前后端契约中，统一采用 **REST API（命令与初始快照）+ SSE (`GET /api/stream?cursor=<lastEventId>`)** 实现毫秒级实时推送，支持断线自动重连与游标恢复。

### 5. 哪些功能是现成的，哪些需要新开发？
- **候选项目已有现成方案（可直接转化）：**
  - Git Worktree 隔离创建与分支管理逻辑。
  - 单 Agent CLI 的 JSONL/Stream 输出解析与终端日志展示。
  - 基础 Kanban 任务卡片状态流转与 Diff 预览。
- **本项目需要新开发的核心功能：**
  1. **自然语言任务自动拆解器（Task Decomposer UI & Orchestrator）**：将用户输入的一句话需求自动拆解为带 `dependsOn` 依赖关系的 `Subtask[]` DAG，并允许用户在启动前微调或审批拆解方案。
  2. **跨 Agent 上下文移交与消息总线面板（Communication Panel）**：显式展示上游 Agent（如架构设计或视觉算法实现 Agent）向平级/下游 Agent（如测试验证或文档生成 Agent）传递的文件路径、Git Commit 与结构化摘要。
  3. **质量审核与失败自动返工闭环（Review & Rework Loop）**：当测试 Agent 发现断言失败或人工审核拒绝时，将任务状态切换为 `reworking`，附带结构化错误原因打回给原执行 Agent 重试。
  4. **集中式成果交付中心（Artifact Center）**：按代码、Diff、测试验证报告、开发文档分类归档所有子任务产物，支持一键预览与验收。
  5. **Mock / Live 双模式透明标识系统**：在 Codex 完成全部底层 CLI 适配前，前端内置高保真状态机模拟器，但所有模拟数据均强制带有 `executionMode: 'mock'` 字段与视觉徽章，绝不混淆模拟数据与真实执行结果。

### 6. 主要技术和维护风险是什么？
1. **本地环境依赖风险（已验证）**：
   - 经本机环境检测，当前 Mac 已安装 `node v24.21.0`、`npm`、`git`、`python3`，但**未安装 `bun` 与 `pnpm`**。
   - `alamops/agetor` 强依赖 `bun`、`electrobun` 以及 macOS 专用的原生编译脚本（`vendor:tmux`, `vendor:notifier`, `vendor:disclaim`），若直接原封不动克隆运行 `agetor` 桌面端会因缺少 `bun` 和签名证书而受阻，且不利于后续扩展 Windows 支持。
2. **应对方案（架构解耦）**：
   - **不直接耦合 `electrobun` 外壳**，而是采用标准的跨平台 Web 前后端分离架构（Node.js >= 22 / TypeScript + React/Vite 前端），在 `multi-agent-hub` 仓库中吸纳 `agetor` 的 UI 交互设计与 CLI 适配器逻辑，确保在 Mac 与未来的 Windows 上均可直接用原生 `node` 启动。

---

## 三、验证状态声明

- **已验证部分：**
  - 三个候选仓库（`alamops/agetor`、`shep-ai/shep`、`BloopAI/vibe-kanban`）的 GitHub 元数据、开源许可证、最新提交时间、`package.json` 依赖树及源码目录树已全部通过脚本拉取并核验完毕。
  - 本机开发环境（macOS, Node.js `v24.21.0`, Git, Python3）已验证可用；确认本机未安装 `bun` 和 `pnpm`。
- **尚未验证部分：**
  - Codex CLI 与 DeepSeek Harness 在本机的实际账号登录态及子进程非交互调用延迟（需由 Codex 在后端阶段验证）。
- **存在的阻碍与规避措施：**
  - 鉴于 `BloopAI/vibe-kanban` 已停止维护、`agetor` 强依赖 `bun`/`electrobun`，我们已决定在 `/Users/developer/.gemini/antigravity/scratch/multi-agent-hub` 建立干净的标准 Monorepo 结构，直接基于本机已有的 Node v24 运行时构建第一阶段可交互原型。
