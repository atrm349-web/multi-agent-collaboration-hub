# C-01 开源架构与运行审查

审查日期：2026-11-02。结论是选定模块审查与运行验证，不是完整安全审计或长期稳定性验收。

| 项目 | 固定提交 | 栈与维护信号 | 许可证 |
|---|---|---|---|
| [Agetor](https://github.com/alamops/agetor) | `5ebf2aa4d634d53a071b0a44c0f378664e498ba4` | Bun、Electrobun、React、SQLite；仓库未归档，查询时最近推送 2026-11-02 | 根 LICENSE：MIT，2026 Alamo Saravali |
| [Shep](https://github.com/shep-ai/shep) | `e1b4a04809c99c250a1c3ea45cc343ec9d93c9fc` | Node、TypeScript、LangGraph、Next、SQLite；仓库未归档，查询时最近推送 2026-11-01 | 根 LICENSE：MIT，2024 Shep AI |

推送时间不代表维护质量；未评估维护者响应时长。Vibe Kanban 暂未做源码审查，仅保留界面参考定位。

## Agetor：已核查的源码路径

- `src/bun/db.ts`：Bun SQLite，WAL，任务、运行、事件、配置及流水线状态；`migrations/` 是现有迁移入口。
- `src/bun/orchestrator.ts`：启动/停止/队列及会话恢复；已有逻辑应原位扩展。
- `src/bun/codex-tmux.ts`：`codex exec --json`，通过 stdin 传提示，解析 `thread.started`、`turn.completed`、`turn.failed`，保存 thread id；后续 `exec resume`。tmux 存活与任务状态恢复是两个不同层次。
- `src/bun/pipeline-runner.ts`、`src/shared/pipeline.ts`：步骤图、handoff、分支/汇合、循环步数限制、重试、取消及启动时 reconcile。**同一流水线步骤共享父任务 Worktree**，并发写入仍会冲突。
- `src/bun/worktree.ts`：任务级 Git Worktree；不是 OS 沙箱。
- `src/bun/server.ts`、`api-config.ts`：HTTP/SSE，默认回环地址、随机令牌及区分客户端权限，事件恢复有测试。

### 必须解决的差距

1. `agents.ts:1077` 附近会在关联 Worktree 外部 Git 写入时把 Codex 自动切换为 `danger-full-access`，与项目约束冲突。不能静默提权；应拒绝不支持的权限需求，或由协调器承担受控 Git 操作。
2. 流水线 handoff 与进程结束不能替代独立测试、文件哈希和验收。新增 Result Validator 后才能认定整体任务成功。
3. 流水线平行写分支需要独立 Worktree/快照与受控集成；首版先串行修改、并行只读审核。
4. harness 解析/编排集中在大文件：本次 `orchestrator.ts` 9537 行、`server.ts` 8694 行。增量适配成本可控，但不宜为统一接口重写所有现有驱动。
5. README 支持多种 CLI 不证明其会员授权或本机可用；本项目只启用 Codex 验证路线。

## Shep：已核查的源码路径

- `packages/core/src/application/ports/output/agents/agent-executor.interface.ts`：执行、流事件、resumeSession、AbortSignal、超时及安全约束。
- `infrastructure/services/agents/common/executors/codex-cli-executor.service.ts`：官方 CLI JSONL、stdin、终止/超时/缺失终态处理；`buildArgs` 固定 `danger-full-access`。能力声明 `requiresPermissiveMode: true`；严格策略应拒绝，而不能降级。
- `infrastructure/services/agents/feature-agent/feature-agent-graph.ts`：LangGraph、验证/修复环、审批、检查点。
- `infrastructure/repositories/sqlite-agent-message.repository.ts` 和 `services/agents/agent-message-bus/sqlite-agent-message-bus.ts`：持久化消息和订阅；跨节点恰好一次执行仍不能由此推定。
- `services/git/worktree.service.ts`、检查点仓库：工作区和恢复能力。
- 仓库 AGENTS.md 要求 TypeSpec-first、测试先行、统一 Executor Provider；采纳后必须遵循，不能另造模型选择入口。

优势：结构化执行接口、工作流与审批能力丰富。代价：完整 SDLC/管理功能很多；按全局设置解析 Executor 的现有规则也需要评估如何兼容按子任务匹配不同 Agent。

## 环境与实际验证

Mac arm64，macOS 26.7.1；Node 24.21.0；工作区临时 Bun 1.4.4；Shep 使用其指定 pnpm 10.33.0；Codex CLI 0.166.0-alpha.5.1。未做全局安装或修改用户认证配置。

| 检查 | 结果 | 证据 |
|---|---|---|
| Agetor 冻结安装、禁用安装脚本 | 通过，696 个包 | `evidence/agetor-install.log` |
| Agetor `tsc --noEmit` | 通过，无诊断 | `evidence/agetor-typecheck.log` |
| Agetor Vite 前端构建 | 通过；存在大 chunk 提醒 | `evidence/agetor-build-web.log` |
| Agetor Bun headless 打包 | 通过，208 模块 | `evidence/agetor-build-core.log` |
| Agetor Codex 映射、流水线、Worktree 选定测试 | 244 通过 | `evidence/agetor-tests.log` |
| Agetor API 认证、SSE 恢复 | 初次监听失败；允许本地监听后 42 通过 | `evidence/agetor-server-tests.log` |
| Agetor lockfile advisory floor 测试 | 3 通过；仅检查指定 shell-quote 下界 | `evidence/agetor-dependency-tests.log` |
| Agetor 完整桌面打包 | 前置检查阻塞：缺少系统 tmux；未完成 Electrobun/签名/GUI 验收 | `evidence/agetor-package-prerequisite.log` |
| Shep 冻结安装 | 系统 pnpm 11 不匹配；指定 10.33 后通过，安装脚本先禁用 | `evidence/shep-install-pnpm10.log` |
| Shep CLI 编译 | 通过；嵌套脚本调用出现 pnpm 11 警告，应固定 PATH | `evidence/shep-build.log` |
| Shep Codex、安全约束、Worktree、工作流单测 | 4 文件 131 通过；不调用真实厂商 | `evidence/shep-tests.log` |
| Shep CLI 启动 | 初次缺 SQLite 绑定；定向 rebuild 后 `--help` 成功 | `evidence/shep-cli-smoke.log` |
| 真实 Codex 调用、双会话交接及恢复 | 通过，详情见 verification.md | `evidence/real-relay-01/acceptance.json` |

244 与 42 的测试数不能直接相加称为首次完整套件通过：首次混合执行含 2 个 beforeAll 失败，后者单独重跑有 42 个实际 API 用例。

Shep 消息/检查点的额外集成结果单独保存在 `evidence/shep-integration-tests.log`，以该日志的最终摘要为准。

## 依赖与许可边界

已查看两份根 LICENSE、锁文件、直接依赖声明和安装元数据。直接依赖的许可清单见 `evidence/direct-dependency-licenses.json`；Shep 的 better-sqlite3、node-pty 许可文件已抽查为 MIT。Agetor 打包会携带 tmux/动态库/native helpers，分发前必须逐项保留相应声明。MIT 根许可不覆盖所有第三方依赖，也不代表签名资源/商标可随意复用。

安装先禁用 scripts；仅对已查阅的 better-sqlite3 执行定向 rebuild。未做所有传递依赖的法律审计、完整漏洞扫描或二进制供应链认证。测试中的 advisory floor 不是完整漏洞扫描。

## 选型建议与决策门

推荐 Agetor 有条件复用，原因是现有任务看板、CLI、多任务、Worktree、SQLite、流水线和 HTTP/SSE 与目标直接吻合，改造范围较集中。Shep 的消息/检查点和分层值得参考，但不建议把两套运行时拼接，也不为沿用前一轮建议额外引入 LangGraph。

**正式底座尚未确定。** 用户确认路线后，先完成安全启动策略的回归测试，再处理工作区/验收和任务拆解；若改造证据不支持该路线，返回 Shep 评估。当前没有声称任一候选在此 Mac 已完成稳定 GUI 运行。
