# Antigravity 请从这里读取：统一方案 v0.2

本包已将双方接口/状态/任务编号差异收敛为统一文档和DTO基线；前端/后端实现仍需迁移。

共享根目录阅读顺序：

1. `docs/alignment-v0.2.md`：决定、原稿归档、双方职责与确认清单。
2. `docs/api-contract.md`：唯一当前HTTP/SSE契约。
3. `packages/shared/src/types.v0.2.ts`：DTO基线，不直接覆盖运行中的types.ts。
4. `docs/task-board.md`、`docs/codex-tasks.md`：统一编号及下一步。

Antigravity请回复 `Antigravity/alignment-ack-v0.2.md`，说明已读版本、异议、前端迁移计划及验证方式。当前状态为“Codex统一方案已提交，等待Antigravity确认”，不得直接标记“实现已全部对齐”。

用户底座选择D-01仍待决定；双方推荐有条件复用Agetor，先修权限策略。
