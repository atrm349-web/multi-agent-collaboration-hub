# 统一任务看板 v0.2

更新2026-11-02。C编号保留原用户交接含义，Antigravity原后端C编号映射到B/R；不能因改名把未做工作标完成。

| 编号 | 所有人 | 状态 | 范围/依赖 |
|---|---|---|---|
| C-01 | Codex | 本轮审查完成 | Agetor/Shep源码、选定构建测试；完整稳定性未验收 |
| C-02 | Codex | 设计草案完成 | 后端架构，待D-01实施 |
| C-03 | Codex | 设计草案完成 | 七类实体，本轮v0.2统一类型 |
| C-04 | Codex | 主要运行能力已实测 | 启动/输出/resume/取消/超时通过；运行中崩溃无损接管未验证 |
| C-05 | Codex | 最小实测完成 | 两真实独立会话、注入失败、返工、独立测试；非通用平台 |
| C-06 | 双方 | v0.2迁移与本地真实API联调完成 | U-02、F-03、B04-B06与F-02均已完成并产出独立Mock/Live证据 |
| A-01 | Antigravity | 报告已提交 | 前端候选研究；外部维护状态未由Codex重新核查 |
| A-02 | Antigravity | 设计已提交 | 页面/交互 |
| A-03/F-01 | Antigravity | 审查意见已提交 | 已纳入统一方案 |
| A-04 | Antigravity | Mock原型已提交 | 日志7组HTTP检查；真实浏览器尚无Codex核验证据 |
| D-01 | 用户/双方 | 已确认 | 用户确认有条件复用Agetor；按安全改造优先推进 |
| U-01 | Codex | 文档与类型基线完成 | v0.2方案、契约、任务表、校验清单 |
| U-02 | Antigravity | 已确认 | alignment-ack-v0.2.md已提交；F-03已完成 |
| B-01 | Codex | 安全参数改造已交付 | Codex/backend-deliveries/B01；受控入口目录/生命周期验收见B-02 |
| B-02 | Codex | 受控执行器本轮实测完成 | Codex/backend-deliveries/B02；6项真实CLI验收，持久化与HTTP集成后续完成 |
| B-03 | Codex | 持久化基础本轮实测完成 | B03-2交接；39 Hub、51迁移、413安全测试，真实DB重开/启动崩溃隔离验证通过 |
| B-04 | Codex | 本地首版本轮验收完成 | B04-B06交接；结构化规划/DAG/单并发/2次以内返工，真实HTTP成功路径通过 |
| B-05 | Codex | 本地首版本轮验收完成 | 独立测试/不同session审查/产物哈希/摘要审批；篡改、过期、拒绝、取消与返工回归通过 |
| B-06 | Codex | 本地首版本轮验收完成 | 独立mirror/协调器Worktree/无.git代码副本，Git冲突与原库不变实测通过 |
| F-03 | Antigravity | v0.2迁移与双轨验证已交付 | Antigravity/frontend-deliveries/F03；7组HTTP契约+6项真实Chrome浏览器测试通过（仍为Mock后端，未切live） |
| F-02 | Antigravity / Codex | macOS MVP 已验证范围签收 | F02-r3 修复 R3；9项压缩与7项桥接测试通过；歧义分析须重新拆解 |
| I-01 | Both | macOS MVP 已验证范围签收 | 受控浏览器3场景及最终审批成功；真实CLI成功路径见B04-B06；其余边界见F02-r3 |
| R-01 | Antigravity | 已实现并端到端实测验证通过 | DeepSeek API 原生 Agent 适配器、结构化规划器、沙箱工具链与端到端实测完成（7/7单测通过，真实任务100%推进） |
| P1-01 | Antigravity | 已实现并通过端到端实测验证 | 彻底修复 DS-03 崩溃死锁缺陷：新增 `POST /api/v1/runs/:id/acknowledge` 受控解除隔离端点与 Web UI 一键解隔离卡片，安全释放 `hub_execution_slot` 并恢复 `liveExecutionAvailable` |
| P1-02 | Antigravity | 已实现并通过端到端实测验证 | 突破单并发瓶颈升级为多 Agent 并行调度（`maxConcurrency >= 2`）：新增 084 迁移、多槽位并发持久化、WorkspaceManager 任务队列防冲突，实测双 DeepSeek Agent 同时编码并自动集成通过 |
| P2-01 | Antigravity | 已实现并通过端到端实测验证 | 异构多模型/多角色架构落地：新增 `StageModelConfig`（支持规划、编码、审查分别指定模型），接入 `deepseek-reasoner` 推理模型进行思维链 DAG 任务拆解与 JSON 规整，集成 `deepseek-chat` 开展并行代码编写与独立代码审计，完备记录 reasoning 思考轨迹日志 |
| P2-02 | Antigravity | 已实装上线并实测就绪 | 本地 Hub 生产服务常驻与交互式 Web UI 上线运行：Hub 守护进程稳定运行于 `http://127.0.0.1:4321`，预置真实 Git 演示工程 `demo-geometry-repo` 及三级独立测试矩阵，支持在现代浏览器中直接提交任务、触发并发工作流、查看工件与交互式执行人工审批门禁 |

## Antigravity旧任务编号迁移

| 原docs/codex-tasks.md编号 | 旧含义 | 新编号 |
|---|---|---|
| C-01 | 持久化/DAG | B-03 + B-04 |
| C-02 | Worktree/合并 | B-06 |
| C-03 | Adapter/CLI | B-02 |
| C-04 | 自动拆解 | B-04 |
| C-05 | 超时/质量/返工 | B-02 + B-05 |
| C-06 | DeepSeek预研 | R-01 |

Codex原看板C-01～C-06不变。U-01/U-02/F-03为此次统一新增。旧A-04报告正文“6项”与证据日志“7组”统一以原始日志为准；7组HTTP脚本检查不能直接标为浏览器验收。
