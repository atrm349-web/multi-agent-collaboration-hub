# 2026-11-10 最终合并与收尾交付

本次基于 Antigravity 最新提交 `03de4b3` 合并 Codex 的全项加固。保留最新界面布局、Muse/WorkBuddy 开发集成、任务级模型选择和快速/DAG 两种入口。已完成桌面同步和本机服务启用；`deployment.json` 与 `post-deployment.json` 记录最终状态。

## 修复内容

- Claude、DeepSeek、Gemini 文件工具共用工作区边界检查，拒绝越界、符号/硬链接、特殊文件、保留路径和只读写入。Claude 完成事件与平台一致；非法审查结果不再自动通过，中央解析器拒绝歧义裁决。
- 测试执行拥有持久化进程组、启动身份与恢复登记；控制器崩溃后仅终止身份吻合的旧测试组。未知所有权隔离，提供带鉴权、CAS、幂等与检查理由的解除入口。
- 默认几何验收改用工作区外的只读 oracle，不能靠弱化仓库内部测试绕过。规划提供验收目录和阶段，局部节点可绑定局部测试，最终独立审查运行整合验收。
- Codex 不再被转交 WorkBuddy；角色别名解析为 `gpt-6.1-sol`。Claude 缺配置时明确失败，取消静默切换 DeepSeek。auto 在创建任务时分配显式工作模型，避免把 `auto` 送给 Codex CLI；它按顺序分配，不宣称能自动探测额度或挑选最优模型。
- Run 持久化实际 provider/model/executionKind/capabilities，界面按实际 Run 展示；旧记录缺字段明确显示未记录。保留厂商筛选目录，移除固定“在线”与按角色猜厂商的表述。审查模型独立选择，可选 Codex 本地登录态。
- Muse/WorkBuddy 缺少经过验证的只读策略，拒绝只读执行与直接规划，保留开发执行。Muse 正确登记为 in-process，历史 claim 同步迁移。
- 旧控制器已停止、子任务因进程中断而 blocked 时，父任务不再永久显示 running；改为 failed 并保留证据，不重放执行。

## 最终验证

| 验证 | 结果 |
| --- | --- |
| Hub 回归 | **110 pass / 17 skip / 0 fail**，536 条断言，127 项 / 17 文件 |
| Hub 与全仓 TypeScript | 均通过，日志为空 |
| JavaScript | `node --check` 通过，实际前端集成构建通过 |
| 真实 Codex | 真实规划、开发、独立审查、官方 OS 测试沙箱与审批后 succeeded；7 个产物 SHA-256 一致，原始临时仓库未改变 |
| 崩溃恢复 | 独立控制器测试阶段 SIGKILL 后重启，旧测试组停止，Task failed/PROCESS_CRASHED，剩余恢复登记 0 |
| 浏览器 | 真实浏览器/HTTP/SQLite/Git；planner/provider/testRunner 为受控替身。完成任务新建、模型选择、实际 Run 归因、文字成果、审批后 succeeded |

最终源码见 `source/`，替换前内容见 `source-before/`；`manifest.json` 记录每个替换文件的前后哈希；`SHA256.json` 核对交付副本。前端源码锁同时存放在项目 `backend/agetor/docs/hub/frontend-source-lock.json`。本交付是基于 Git HEAD 的工作树变更，未提交或推送远程。

`real-codex-evidence.json` 与 `crash-evidence.json` 是本版本实测。历史 2026-11-09 的真实 Codex 返工与外部 oracle 证据保留在原 hardening 输出目录，不冒充本次新增实测。DeepSeek 上次真实调用返回 HTTP 402，记录在 `deepseek-blocked-2026-11-09.json`，本次未重复付费调用。

## 本机启用与恢复

发布前逐文件核对共享基线；检查既有控制器、回环端口、执行登记与旧任务状态。即使服务已经停止，也先用 SQLite backup 接口备份数据库到 runtime 私有 backups 目录，再替换源码。运行时令牌、配置密钥和数据库备份不复制进共享交付目录。

`deployment.json` 记录源文件同步、实际服务启动、数据库备份位置、恢复隔离数量和在线前端哈希匹配结果。若旧服务已停止，serviceStarted=true 与 serviceRestarted=false 表示从停止状态重新启动。

回退时先停止对应本机服务，对照 manifest 恢复 source-before 的旧文件，并处理本次新增文件，再恢复匹配的数据库备份与复核。保留其他协作者的内容，不能直接重置整个仓库。原有产物和等待审批记录保留。

## 尚未验收的范围

- Claude/Gemini/DeepSeek/WorkBuddy/Muse 的真实账号专项本次均未计为通过；需明确设置 `HUB_LIVE_TESTS=1` 才执行现有专项。默认阶段配置仍为 Codex/auto/Claude，真实可用性取决于各账号配置与额度。
- 原生 Muse/WorkBuddy 外部执行的取消与控制器崩溃后停止未完成专项验收；不能套用 Codex 进程组回收结论。禁止把这类网关当作可强制只读的审查器。
- Windows、长期并发压力、完整宿主机文件读取隔离未验证。源码锁 `runtimeEnforced=false`，用于版本核对，不能代替运行时权限控制。

本轮收尾覆盖当前 macOS 实现的已识别修复与交付，不等于完整跨厂商、跨系统的生产验收。

## 最终启用结果

44 个变更文件已同步。旧服务本来已停止，本次从停止状态启动 `http://127.0.0.1:4321`，在线 app.js 哈希匹配，needsAttention=0。两份数据库备份 integrity_check 均为 ok。原有 2 条成功、3 条待审批保留；中断的旧任务已正确显示 failed/PROCESS_CRASHED，不再虚假 running。已部署页面可加载，截图在 browser/screenshots/deployed.png。
