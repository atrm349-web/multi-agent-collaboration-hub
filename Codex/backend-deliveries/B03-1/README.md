# B03-1：持久化存储与事务验收

2026-11-02。已实现并测试的第一部分，不代表整个B-03已完成。

复用Agetor的Bun SQLite与migrate，添加082号迁移及hub_命名空间表，现有task/run数据表不改写。七类实体与Validation证据可以持久化；支持实体version CAS、请求幂等、单执行槽、owner/lease、日志与provider session保存、事务outbox及消费去重、快照水位。

15项实际SQLite测试通过（含两真实本地worker进程竞争同一幂等键），严格TypeScript检查通过。过期任务标interrupted、Subtask blocked，保留执行槽隔离；必须明确核验旧进程组已停止和副作用，再人工解除隔离，不自动重复调用模型、不凭旧PID杀进程。模型进程成功只让Subtask进入validating，不使Task自动成功。

尚未完成：本存储层与B-02运行器的持久化桥接、真实CLI重开数据库验证，正在B03-2继续。未提供正式HTTP服务；前端仍不能切live。source为可审查快照，完整后端仓库将在B03-2最终验证后更新。
