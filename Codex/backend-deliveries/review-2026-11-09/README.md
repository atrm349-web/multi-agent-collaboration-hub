# DeepSeek 与 Gemini／Antigravity 最新交接复核

复核日期为 2026-11-09，执行方为 Codex。共享项目真实路径为 `/Users/anyunhong/Desktop/集合agent`，旧名 `/Users/anyunhong/Desktop/集合agnet` 当前解析到同一目录。

本次读取 DeepSeek 的《最终验收报告》、最新《交接进度》、DS-03 修复报告及补丁，并将 Antigravity 的《交接进度》作为当前找到的 Gemini／Antigravity 交接入口。未找到独立命名的 Gemini 最新交接报告。源码复核基线为 `1c693a3`，完整哈希见本目录 review-snapshot.json。

## 最新进度

| 能力 | 当前可确认的进度 | 证据范围 |
|---|---|---|
| 真实任务成功路径 | DeepSeek 已提供新版实际运行记录 | DS-04 运行对应 0ce7323，随后代码继续改变 |
| 真实模型失败自动返工 | 已有第一次验收失败、第二次通过 13 条断言的交付记录 | DS-02 S1，基线 9d86d89，本轮未重跑付费模型 |
| 拒绝审批后显式返工 | 已有新 digest、新产物引用和最终成功记录 | DS-02 S2，独立 session 与审批路径均有记录 |
| 重试预算耗尽 | 连续任务第 3 次最终 failed，已由 DeepSeek 实测 | 结果符合有界重试，错误码 UNSUPPORTED_TRANSITION 的用户提示仍可改善 |
| SSE 与连续运行 | 有 3 个真实任务、10 次重连的短时实测记录 | 2/3 成功，样本量不足以估算长期成功率或内存泄漏 |
| 多模型与并发 | 源码已有 DeepSeek、Gemini、Claude、WorkBuddy、Codex 路由及并发槽位 | Antigravity 报告并行任务通过，本轮未独立复跑所有厂商真实任务 |
| 崩溃后 validating 卡死 | 最小修复已进入 15:17 的 1c693a3 | DeepSeek 报告截止时仍写待合入，当前源码已变化，需当前提交回归 |
| 生产与无人值守 | 仍有恢复及适配器缺陷待解决 | 现有短时成功证据不足以支撑交接中“生产级”的范围 |

资料入口为 `/Users/anyunhong/Desktop/集合agent/DeepSeek/最终验收报告.md` 与 `/Users/anyunhong/Desktop/集合agent/Antigravity/交接进度.md`。

## P1 必须先修

### 1. Claude 只读模式仍能执行写工具

当前 `claude/runtime.ts` 的工具声明根据只读模式裁剪，但执行器第 221–224 行收到 write_file 时直接 mkdir/writeFile，缺少实际权限判断。模型返回一个未在当前工具声明中提供的 write_file，就能在只读审查请求中落盘。

本轮以受控 Claude 响应执行真实适配器，在临时目录中复现 read-only 请求创建 unexpected.txt。全部响应由本地替身提供，未调用真实 API。

改进应在工具执行入口核对工具白名单和 isReadOnly，写操作必须由 workspace-write 明确允许。补充“模型在只读模式请求 write_file”的回归，验证文件没有生成。

另一个边界问题是 resolveSafePath 仅做字符串路径范围判断。临时工作区含一个指向外部临时文件的符号链接时，write_file 修改了外部文件。WorkspaceManager 初始化快照有拒绝链接的检查，但适配器自身仍应防御执行期或直接调用输入。补充真实路径与链接校验，并在文件打开时防止跟随链接，覆盖读、写及父目录链接。DeepSeek/Gemini 也有同类词法路径判断，需要逐一验证。

源码位置为 `/Users/anyunhong/Desktop/集合agent/backend/agetor/packages/agent-adapters/claude/runtime.ts` 第 94–100 行及第 221–228 行。复现结果见 probe-results.json。

### 2. Claude 的完成日志不符合平台读取契约

Claude 第 197–201 行写入 stream=stdout、raw.event.item。平台 CodexLog 契约要求 event.item，HubStore.recordLog 又会将整个 log 包进 raw，因此实际落库结构多嵌套一层。HubService.answer 查询 $.raw.event.item，无法找到 Claude 的最终答案。

本轮让 Claude 返回合法 approved JSON，适配器自报 succeeded，但符合平台契约的 agent_message 事件数为 0。这会使 Claude 终审在读取审查 JSON 时失败。

改进应复用已有 event 结构，并让所有 provider 跑相同的事件、结构化输出、取消和错误契约测试。新增 Claude 经 DurableCodexRunner、HubStore 到 HubService 审核的集成测试，覆盖平台正常入口。

同时，Claude 第 255–258 行在 JSON 解析失败时自动生成 approved=true。本轮 malformed-review 已复现此结果。当前日志缺陷会阻止其正常传到质量门，但修日志时必须一起删除这条自动批准兜底，解析失败应明确失败并记录原始响应。

源码位置为 `/Users/anyunhong/Desktop/集合agent/backend/agetor/packages/agent-adapters/claude/runtime.ts`。现有 hub-claude.test.ts 的 3 项测试全部通过，却未覆盖上述行为。

### 3. 崩溃恢复修复仍缺少测试子进程所有权

1c693a3 已合入 reconcileInterruptedValidations，将孤儿 validating 子任务和任务标为 failed。当前代码第 302 行还会删除对应 run 的槽位，但测试阶段自身没有持久化 claim 或测试进程组登记，原测试子进程可能仍在执行。

这项改动解决状态静默卡死，剩余工作是持久化测试阶段的身份、租约和进程归属。API 模型请求应登记为控制器内请求或远程作业，避免用控制器 PID 冒充独立模型进程组。重启后先核验原测试已停止或隔离，再开放重试与相关资源。

构造器当前捕获对账错误后仅写日志并继续启动。建议对账失败时在 meta 暴露 needsAttention，并阻止受影响任务继续派发，保留可审查错误。

验收至少覆盖测试前、测试中、测试结束但结果未落盘三个中断窗口，并检查原测试进程、槽位、重复执行及并发任务隔离。当前两个相关测试文件中未找到 reconcileInterruptedValidations 的回归覆盖，本轮未注入共享服务崩溃。

源码位置为 `/Users/anyunhong/Desktop/集合agent/backend/agetor/packages/core/state/store.ts` 第 276 行起，以及 `/Users/anyunhong/Desktop/集合agent/backend/agetor/packages/core/hub.ts` 第 104 行。DeepSeek 的 A/B 实验记录位于 `/Users/anyunhong/Desktop/集合agent/DeepSeek/DS-03/fix-verify/报告.md`。

### 4. 默认验收脚本位于 Agent 可写仓库

当前 config/hub-config.json 注册 node test_circle.js、test_rect.js、test_geom.js。启动器将演示仓库复制为独立 Git 仓库，但测试脚本仍随源文件进入 Agent 代码目录，写工具可以同时修改实现和断言。

HubService 在模型完成之后计算测试前指纹，能检测测试期间的源码变更，无法判断 Agent 在测试开始前是否削弱了断言。因此该默认配置不能独立保证验收标准未被改动。

将可信断言移到 Agent 工作区之外，通过受控绝对命令和最小 readPaths 读取。验证“实现错误且项目测试被改成全通过”时，外部验收仍失败。DeepSeek 的真实测试采用仓库外 oracle，可复用其方法。

配置位置为 `/Users/anyunhong/Desktop/集合agent/config/hub-config.json`，执行位置为 `/Users/anyunhong/Desktop/集合agent/backend/agetor/packages/core/hub.ts` 第 445 行起。

## P2 随后改进

### 5. 模型归因需要后端真实数据

当前 app.js 第 1998、2116 行仍按 assignedAgentId 的固定片段及 stage==='review' 映射 DeepSeek、WorkBuddy、Claude。后端 seedAgent 仍统一写 adapterId=codex-cli，并对所有 Agent 声明相同能力。

改进应让 Run 保存实际 provider、model、执行类型与能力快照，由 UI 显示实际运行记录。相同角色可配置不同模型，历史任务需要保留当时的模型归因。逐厂商标识实际可用的 stream/resume/cancel/structured-output 能力。

### 6. 规划输出与各阶段验收范围需要一致

DeepSeek 报告明确记录 planner 拆出 7 步后，实跑创建的是经过另行选择的可执行任务。因此现有成功证据仍需补充“原始计划直接执行”的完整路径。

实现节点只绑定其负责功能的验收，文档节点验证文档产物，最终整合节点执行整套验收。使用已有 testProfileId 绑定能力，先验证模型输出的 ID 合法且与任务范围一致，再增加必要能力。避免早期局部节点必须通过整个项目最终测试而耗尽 attempt。

### 7. 当前基线与签收记录已失配

当前源码锁仍标记 11-03 的 Codex F02-r3。实查前端 index.html/app.js/styles.css 三项全部漂移，后端锁内六项中 http.ts/hub.ts/workspace.ts/start-hub.ts 四项漂移。frontend.ts 与 quality.ts 两项匹配。

建议先冻结一个候选提交，完成修复与契约回归，再创建新的交付包、源码锁和验证矩阵。历史 F02-r3 保留其原始签收范围。当前报告的测试版本至少有 0ce7323、9d86d89、1c693a3，应分别对应执行证据。Antigravity 的表头仍写 11-03，正文却已列新增多模型功能，需补实际更新日期。

## 建议执行顺序与分工

1. Codex 先处理只读权限、文件边界、Claude 事件格式和非法审查输出，并补统一适配器契约测试。
2. Codex 与 DeepSeek 补测试阶段持久化 claim、崩溃隔离及外部可信验收。DeepSeek 用现有中断脚本复跑最新提交并保存 A/B 结果。
3. Gemini／Antigravity 修正真实 provider/model 展示、needsAttention 提示与交接日期。规划直接执行按注册 testProfileId 对齐。
4. 冻结同一提交，由 DeepSeek 跑真实成功、失败返工、拒绝返工、预算耗尽及中断恢复。最后同步 manifest、源码锁和任务看板。
5. 本机基线稳定后继续 Windows 迁移。此前 Windows 方案停留在源码检查与路线评估，完整方案尚未交付。

## 本轮实际验证与限制

- 只读核对最新报告、Git 提交、关键源码与哈希。
- 现有 Claude 测试为 3 pass、4 断言。
- 自建本地受控探针复现只读写入、符号链接写出、Claude 完成事件缺失及非法 JSON 自动批准。探针只操作自身临时目录，结束后清理。
- 本轮未运行付费模型、未重启常驻服务、未执行崩溃注入和完整类型检查。报告中的真实模型结果引用 DeepSeek 交付记录。
- 本轮仅保存复核与改进建议，运行源码等待后续修复任务。
