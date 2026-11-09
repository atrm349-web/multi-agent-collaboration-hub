# DS-02 S1-real 证据说明

| 文件 | 内容 |
|---|---|
| `flow.log` | 全过程时间线（含每次状态迁移、两条 validation、返工原因原文） |
| `result.json` | 结构化结果：finalStatus、validations、10 个产物下载哈希、reworkMessages（**attempt 1 的失败测试原文就在这里**）、repo HEAD/状态 |
| `ui-live-mode.png` | 任务成功后实机模式截图（14:47 版前端） |
| `artifacts/` | 从冻结产物库导出的文件（`artifact__duration.js` 是 **attempt 2** 的交付物；`IMPL-acceptance-attempt-2.json` 是 attempt 2 的测试报告） |

注意：attempt 1 的测试报告文件在导出时与 attempt 2 同名，被覆盖；但它的**完整 stdout（含 3 条 FAIL 行）原样保存在 `result.json` 的 `reworkMessages[0].content`**，以及 `flow.log` 的 "rework reason" 行里。这已足够复核"首版为什么不合格"。
