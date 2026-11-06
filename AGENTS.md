# AGENTS.md — Multi-Agent Collaboration Hub 协作开发规范

本项目由 **Google Antigravity** 与 **OpenAI Codex** 共同承担开发，采用明确的分工边界与契约驱动协作机制。

---

## 一、角色分工与文件所有权

| 角色 | 负责范围 | 主导目录与文件 |
| :--- | :--- | :--- |
| **Antigravity**<br>*(首席前端工程师 + UI/UX 设计负责人 + 浏览器集成测试负责人)* | 产品交互设计、8 大前端视图模块实现、客户端状态管理、SSE 实时渲染、Mock 交互原型与浏览器端到端验证 | `apps/web/**`<br>`docs/frontend-plan.md`<br>`docs/ui-pages.md`<br>`docs/frontend-api-requirements.md`<br>`docs/open-source-evaluation.md` |
| **OpenAI Codex**<br>*(首席后端工程师 + 系统架构负责人 + Agent 编排引擎负责人)* | 任务拆解与 DAG 调度核心、SQLite 持久化、Git Worktree 隔离池、统一 `AgentAdapter` 与 CLI 子进程管理、超时重试与安全沙箱 | `packages/core/**`<br>`packages/agent-adapters/**`<br>`docs/architecture.md`<br>`docs/backend-plan.md` |
| **双方共同维护（需协商确认）** | 前后端共享数据结构、REST + SSE 接口契约、跨模块集成测试与任务看板 | `packages/shared/src/types.ts`<br>`docs/api-contract.md`<br>`docs/codex-tasks.md`<br>`tests/**` |

---

## 二、协作铁律

1. **禁止无协调同时修改同一核心文件：** 前端视图代码由 Antigravity 修改，后端编排与进程适配器由 Codex 修改。
2. **契约先行：** 任何对 `packages/shared/src/types.ts` 或 REST/SSE 端点的字段变更，必须同步更新 `docs/api-contract.md`。
3. **诚实标识模拟与真实状态：** 在真实 CLI 进程接通前，所有模拟数据必须携带 `executionMode: "mock"`，严禁将未经验证或模拟的功能描述为真实已完成。
4. **合规与安全底线：**
   - 仅使用合法的本地 CLI 登录态或官方公开 SDK，严禁使用 Cookie 提取、认证绕过或违反各平台服务条款的手段。
   - 不在未经用户确认的情况下执行破坏性 Git 操作、删除工作区外文件或部署公网服务。
