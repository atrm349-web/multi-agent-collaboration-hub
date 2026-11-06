# Multi-Agent Collaboration Hub — Codex 第一阶段交接包

更新时间：2026-11-02。正式底座未决定，当前是源码审查、架构草案和真实 CLI 技术证明。

建议阅读顺序：

1. `docs/project-understanding.md`：目标与范围。
2. `docs/architecture-audit.md`：Agetor/Shep 源码、构建/测试、许可及推荐。
3. `docs/backend-plan.md`：模块、七类实体、状态及恢复设计。
4. `docs/agent-adapter-spec.md`：能力、权限、事件、取消和恢复语义。
5. `docs/api-contract.md`：提供 Antigravity 审查的 HTTP/SSE 草案。
6. `docs/task-board.md`：状态与依赖，区分设计/实测/未做。
7. `docs/verification.md` 和 `evidence/`：真实证据与运行方法。

## 已实测

Agetor 前端构建、headless 打包、typecheck，244 项核心选定测试、42 项 API 选定测试及 3 项依赖下界测试；Shep CLI 构建/帮助启动、131 项选定单测和 19 项集成测试。真实 Codex A/B 独立会话完成成果交接、故障注入、审核、恢复修复及独立验收。原型 4 项本地自测通过。

## 推荐与待决定

推荐有条件复用 Agetor；必须先取消自动全权限升级、落实工作区冲突规则和独立验收。未直接改造任何候选项目。Agetor 完整桌面打包因缺少 tmux 未完成；Shep 完整 Web/Electron、任一产品的长期运行没有验证。

## 给 Antigravity 的首项任务 F-01

请在共享根目录的 `Antigravity/` 中创建自己的 `progress.md` 和 `api-review.md`，记录阅读版本、接口意见、前端计划和需要 Codex 配合的事项；不要直接改写 Codex 的报告。字段/状态/事件方案确认及用户确定底座后，再开始产品前端实现。

首轮审查重点：fetch SSE 鉴权与重连、取消中/暂停中状态、Agent 能力降级、消息/日志分页、成果引用、审批摘要绑定。浏览器实测证据需与 mock 明确分开。

工作区源码和大型依赖目前在原 Codex 工作区 `work/upstream/`；共享包不包含它们，避免把实验缓存当作共同正式仓库。选型确认后再建立统一 Git 仓库与独立开发分支。

共享文件是人工/按任务更新的交接方式，目前没有后台监控或自动双向覆盖。双方在继续工作前读取对方进度，再维护自己负责的文件；发现冲突先记录并协调。
