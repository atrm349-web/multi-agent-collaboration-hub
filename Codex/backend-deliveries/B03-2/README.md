# B-03 持久化与启动恢复 — 本轮基础能力完成

日期：2026-11-02。完整后端位于共享根目录backend/agetor；本包source为增量快照，changes.patch基于B-02提交。source-version.json给出准确版本。

## 已完成

- 复用Agetor原Bun SQLite和migrate，追加082_hub_execution迁移。新增hub_表，不改写原任务/运行数据。启用WAL、FULL同步和事务CAS。
- 七类实体及Validation证据持久化；关联归属检查、历史证据/来源不可篡改、产物内容不可原地改写。Task成功暂被明确拒绝，等待B-05验收器，不能凭模型进程结束自动完成项目。
- 以(subtaskId, idempotencyKey)绑定请求摘要，(subtaskId, attempt)唯一；进程启动前事务claim并占用数据库单执行槽，重复请求返回旧run，不重复启动CLI。
- owner/lease、心跳、进程组标识、日志和provider session、终态落库。先保存进程身份，再向CLI交付prompt；持久化失败会停止已拥有的子进程，不上报成功。
- 状态与outbox同事务，快照水位、事件重放和日志去重、消费者收据可持久化。收据不意味着外部副作用恰好一次：调用方处理必须幂等；需要本地原子处理时在同一数据库事务中处理并记录收据。
- 启动时对过期claim做保守对账：run为interrupted，Subtask blocked，保留执行槽隔离；旧worker的迟到结果不能覆盖。不会按旧PID盲目杀进程，也不会自动重放可能已经有副作用的任务。
- 解除隔离要求明确的停止/副作用复核记录；若已知进程组仍存在则拒绝解除。解除后也不自动重试，旧run保持interrupted供审计。
- DurableCodexRunner使用完毕释放内存job/日志对象，历史查询走数据库；单执行槽控制并发，不增加多模型并行负载。

## 本轮额外收紧的控制区边界

B-02的执行目录与AGETOR_DATA_DIR现在必须互不包含，避免Agent写自己的调度数据库。旧版允许把state放在执行cwd内的示例不再适用。

建议布局：

```text
hub-root/                 # runtime配置的workspaceRoot：受控容器根
  state/                  # AGETOR_DATA_DIR，只有协调器写入
  workspaces/task-001/    # Agent实际cwd
```

cwd不能是hub-root本身，也不能是state或其父/子目录；真实路径及符号链接逃逸检查仍保留。CLI额外写根、临时目录写权限和终端网络保持关闭。当前不宣称完整读取隔离、恶意插件隔离或任意不可信仓库均可安全运行。

## 实际验证

- **39项Hub测试 / 138断言通过**：运行器16项、存储15项、持久化桥接8项。包含两个真实本地worker竞争、事务回滚、重开DB幂等、取消迟到结果、存储失败停进程、启动记录失败不交付prompt、过期隔离和仍活跃的进程组不得解除。
- **51项上游迁移测试通过**；更新了上游对“081为最后一条迁移”的旧断言，确认新增082后的顺序和旧数据保留。
- **413项安全/工作区/启用策略回归通过**；两个TypeScript检查和git diff --check通过。
- **真实Codex实验通过**：只调用一次官方CLI；真实工具尝试写控制区空白哨兵文件，被沙箱拒绝；日志、provider session和succeeded状态在关闭并重开DB后保留。Subtask仅进入validating，Task未被误报成功。
- **真实本地worker启动崩溃实验通过**：worker提交claim后、尚未启动模型前被SIGKILL；重启对账为interrupted并保留隔离；重复同key不重新执行。

证据：evidence/real-summary.json、real-events.json、fixture-database.sqlite（只含本轮新建测试数据的一致性备份，已quick_check并核对9条日志）、测试日志。summary中的modelCalls统计CLI启动次数，不是模型服务的HTTP请求或计费次数。

**区分范围：实际模型进程中途崩溃后的自动接管/无损续跑没有验证。** 本轮崩溃点是已提交claim、尚未启动模型的本地worker；运行中失联只保证保守隔离，旧子进程未必已经停止。只读证据数据库不要当作正式服务数据目录使用。

## 复现入口

在backend/agetor中，使用已安装的Bun与锁定依赖：

```sh
bun run test:hub
bun run test:hub:state
bun run test:hub:durable
bun run typecheck
bun run typecheck:hub
# 手动真实验收，会消耗现有Codex配额，输出目录必须是新目录
bun run verify:hub:persistence /absolute/path/to/new-evidence
```

本机验证工具Bun在原Codex工作区work/tooling/node_modules/@oven/bun-darwin-aarch64/bin/bun，不要求全局安装。桌面源码仓库未重复复制node_modules；复现前需安装锁定依赖或使用现有验证工作区。CLI沿用官方ChatGPT登录，不复制auth.json、不新增API Key。

## Antigravity接下来

继续F-03前端v0.2迁移；本轮没有修改apps/web或对方文件。后端DTO复制自已确认的v0.2基线，位于backend/agetor/packages/shared/src/types.ts；不表示根目录旧Mock types.ts已经迁移。

尚无正式/api/v1服务，不能把Mock切live。B-04将连接任务规划/依赖调度与服务；B-05补独立验收、审批和返工；B-06补Worktree集成。Validation非终态目前仅快照查询，只有passed/failed发validation.completed；对外实时进度事件在B-05细化，避免把unverified假报完成。

Windows、长时压力、断电/硬盘故障、日志保留清理、整个前后端联调均未完成。B03-1是阶段历史快照，本包与完整源码为较新实现，不要混用不同版本的补丁。
