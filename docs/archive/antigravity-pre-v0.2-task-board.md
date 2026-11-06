# 第一阶段与第二阶段开发任务看板（`docs/task-board.md`）

| 任务编号 | 负责角色 | 任务名称 | 当前状态 | 交付物 / 验收证据 |
| :--- | :--- | :--- | :--- | :--- |
| **A-01** | Antigravity | 研究候选开源项目（Agetor / Shep / Vibe Kanban） | ✅ 已完成 | [`docs/open-source-evaluation.md`](./open-source-evaluation.md) |
| **A-02** | Antigravity | 设计前端产品结构与 8 大核心模块交互 | ✅ 已完成 | [`docs/frontend-plan.md`](./frontend-plan.md), [`docs/ui-pages.md`](./ui-pages.md) |
| **A-03** | Antigravity | 定义前端数据需求、7 大实体与状态流转规则 | ✅ 已完成 | [`packages/shared/src/types.ts`](../packages/shared/src/types.ts), [`docs/frontend-api-requirements.md`](./frontend-api-requirements.md), [`docs/api-contract.md`](./api-contract.md) |
| **A-04** | Antigravity | 制作最小可交互原型并完成本地运行与集成验证 | ✅ 已完成 | [`apps/web/server.mjs`](../apps/web/server.mjs), [`apps/web/public/index.html`](../apps/web/public/index.html), [`tests/verify-prototype.mjs`](../tests/verify-prototype.mjs) |
| **C-01** | OpenAI Codex | 核心 SQLite 持久化与 DAG 拓扑状态机实现 | ⏳ 待 Codex 执行 | 详见 [`docs/codex-tasks.md`](./codex-tasks.md) |
| **C-02** | OpenAI Codex | Git Worktree 隔离池与跨分支自动合并/冲突检测 | ⏳ 待 Codex 执行 | 详见 [`docs/codex-tasks.md`](./codex-tasks.md) |
| **C-03** | OpenAI Codex | 统一 `AgentAdapter` 接口与 `CodexCliAdapter` 真实子进程流式接入 | ⏳ 待 Codex 执行 | 详见 [`docs/codex-tasks.md`](./codex-tasks.md) |
| **C-04** | OpenAI Codex | 自然语言任务自动拆解引擎（Task Decomposer） | ⏳ 待 Codex 执行 | 详见 [`docs/codex-tasks.md`](./codex-tasks.md) |
| **C-05** | OpenAI Codex | 自动测试验证、看门狗超时控制与失败自动返工闭环 | ⏳ 待 Codex 执行 | 详见 [`docs/codex-tasks.md`](./codex-tasks.md) |
| **C-06** | OpenAI Codex | DeepSeek Harness 候选适配器认证方式与成本验证 | ⏳ 待 Codex 执行 | 详见 [`docs/codex-tasks.md`](./codex-tasks.md) |
