# B-04 / B-05 / B-06：macOS 本地首版后端交接

日期：2026-11-03。提交：9322bac26700a251947469a379658607cff4bb4b。
分支：codex/b04-b06-local-platform。仅本地提交，未推送远程。

## 本轮完成

- B-04：真实 CLI 结构化规划、严格 DAG 校验、单并发调度、依赖集成、2次以内有界返工、下一轮消息投递、暂停/恢复/取消、幂等/CAS。
- B-05：实际测试退出码和报告、当前产物哈希验证、独立 provider session 审查、最终审批摘要/版本/到期校验。模型结束只能进入验证；Task 成功必须经过质量门及最终审批。测试不能改写被验收源码。
- B-06：每任务独立 Git mirror、协调器 Worktree、无.git 的 Agent 代码副本、依赖合并、冲突证据保留、不可变产物。原仓库不修改。
- 真实 `/api/v1` HTTP：本地鉴权、分页、快照水位、SSE 重放、日志、下载、控制/审批与本地启动入口。
- Antigravity 前端桥：读取原文件后生成内存适配副本，随机 live token、无初始 Mock ID、LIVE标签、禁用Mock控件、CSP nonce/同源保护。原前端未改动。

## 验证结果与证据

- `evidence/tests.log`：134 项通过、0失败、947断言，含迁移、持久化、运行器、DAG、HTTP、前端桥、工作区、最终门禁；受控失败→新attempt→重测→独立审查→审批成功已覆盖。
- 全仓与Hub严格TypeScript检查通过，diff检查通过。
- `evidence/real-http.json`：实际订阅CLI规划→修改clamp.py→官方沙箱内固定Python断言→不同session只读审查→等待审批；重启后通过真实HTTP审批，Task=succeeded，2项Validation passed/exitCode0，5个产物，原仓库不变。
- `evidence/browser.json/png`：真实Chrome连接真实HTTP；LIVE、SSE、SUCCEEDED、DAG2/2、5个产物；无pageerror。只验证此页冒烟，不代表所有按钮均经过真实端到端验证。
- 工作区7项实际Git/官方沙箱测试含控制目录读写和网络禁止、取消、超时。外层沙箱内嵌启动曾返回71，在获授权外层运行后通过。
- 第一轮模型输出缺JSON闭合括号被拒绝；现通过官方 `--output-schema` 约束规划/审查，仍保留严格JSON校验，不修补猜测输出、无Mock回退。
- 真实流程先到waiting_approval，验收脚本审批查询路径写错而停止；修正后复用持久化任务完成重启/审批，未重复模型工作。重启还发现state已存在报错，已修复并实测。

## Antigravity 下一步（F-02 / I-01）

1. 先读本README、`source/docs/hub/LOCAL-START.md`和四份证据；共享 `backend/agetor` 是本轮完整源码。
2. 将前端桥中的最小改动正式迁回你维护的前端；当前桥锚点对应本轮F03源码，后续改源码要同步桥或使用正式boot约定，不能恢复固定live token。
3. 用真实后端补测新建/规划、详情分页、日志/产物下载、暂停恢复取消、SSE断线恢复、审批拒绝/返工与digest冲突等完整交互；保持Mock与live证据分开。
4. `FINAL-REVIEW`是服务端保留code，客户端勿重复生成。当前不支持执行analysis阶段；规划阶段处理分析。未指定testProfileId时采用管理员注册的默认profile，UI需说明验收策略。
5. 请在Antigravity目录写验收反馈。不要因本次后端首版通过，就把I-01全功能/Windows/长期稳定性标为完成。

## 启动

完整说明：`backend/agetor/docs/hub/LOCAL-START.md`。需Bun、Git、已登录官方Codex CLI；运行root必须在任何Git仓库外，state与workspaces互不包含，并发1。此机Bun位于Codex工作区tooling目录；若未加入PATH，使用该Bun绝对路径执行脚本（不要把凭据写入脚本）。注册自己的源码路径及真正的固定验收命令后，运行 `bun scripts/start-hub.ts /absolute/path/config.json`。

验收服务已停止，没有额外常驻后台服务。未创建API密钥，没有公开监听、远程推送或发布。

## 尚未覆盖

本轮真实模型走成功路径；平台自动失败返工用受控子进程回归验证，尚未在本次真实HTTP任务里强制制造模型返工。完整前端交互、长时负载、模型运行中进程崩溃接管、完整Agent文件读取隔离、Windows和跨厂商接入未验收。测试配置必须由本地用户审查；Agent可修改的仓库测试不等同于独立验收标准。此版本是本地单用户首版，尚非完整产品。
