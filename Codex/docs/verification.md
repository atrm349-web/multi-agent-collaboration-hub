# 真实执行证据与限制

日期：2026-11-02。所有编号对应本轮实际操作；设计文件中的示例不作为实测。

## 构建/测试

详见 architecture-audit.md。补充：Shep 的 SQLite 消息仓库、消息总线、Git 检查点集成测试为 **3 文件、19 项通过**，日志 `evidence/shep-integration-tests.log`。

候选仓库均在 `work/upstream/` 的独立下载副本中检查；结束时 `git status --short` 无源码变更。Node 及 Codex 沿用本机安装；Bun/pnpm 和包缓存位于项目 work/。未操作用户真实 Agetor/Shep 数据库，Shep 启动使用独立 SHEP_HOME。

认证探针：`codex login status` 显示 Logged in using ChatGPT；`codex exec --ignore-user-config --sandbox read-only --json ...` 返回 HUB_AUTH_OK 和 turn.completed，见 `evidence/codex-auth-probe.jsonl`。没有读取/复制 auth.json。当前沙箱不能启动 CLI 内部服务，允许该进程运行后成功，CLI 内部仍使用 read-only；没有改为 danger-full-access。

## 双 Agent 实验

真实日志目录 `evidence/real-relay-01/`；最终汇总 `acceptance.json`；SQLite `state.sqlite` 保存 runs/messages/artifacts。

1. 开发会话 A 实际生成 clamp 函数的 JSON 内容。协调器进行固定 AST 白名单校验后写入实验目录；不是模型拥有任意文件写权限。
2. 实验协调器**主动注入**缺失反向边界检查的版本，运行真实 Python 验收，exit=1。该缺陷不是开发 Agent 的原始错误。
3. 审核会话 B 与 A 的 provider session 不同，收到代码和实际失败输出，返回拒绝并指出边界问题。
4. 协调器记录反馈，使用明确 A session id 调用官方 `exec resume`。A 返回修复版本。
5. 协调器重跑 5 个验收案例通过；恢复 B 会话，让 B 使用真实 shell 命令独立运行同一验收脚本，也得到 `5 acceptance cases passed`、exit=0。
6. 最后一步只在 JSONL 中存在成功的 command_execution、acceptance.py 命令和实际通过输出时认定 reviewerRanTests=true；没有把一段文字“通过”当作执行证据。

`acceptance.json` 显示 execution=real、faultInjected=true、initialTestExit=1、finalTestExit=0、independentSessions=true、reviewerRanTests=true、repairUsedResume=true。原型源码后补了独立审核执行步骤；本轮该步骤在已有实验会话上追加执行，证据与既有记录保存在同一目录，未为更新源码重复耗用整轮模型调用。

## 本地原型自测

`python3 -m unittest discover -s prototype -v`：4 项通过（在包根目录运行）。覆盖缺失终态/失败、非法产物拒绝、合法函数接收、超时杀进程并持久化失败。

超时单测使用受控本地替身 CLI；不计作真实 Codex 超时/主动取消验证。参考 `evidence/prototype-tests.log`。尚未验证真实 Agent 运行中取消、启动崩溃恢复、并行调度、OS 完整隔离或 Windows。

## 运行原型

在交接包根目录：

```sh
python3 -m unittest discover -s prototype -v
python3 prototype/relay.py --output ./local-runs/relay-001
```

依赖 Python 3、PATH 中可用且已登录的官方 Codex CLI。输出目录必须不存在，防止覆盖既有结果。每次真实实验消耗现有 Codex 使用配额。错误见对应 run 目录和 SQLite；该原型不启动 Web 服务，不读取 Antigravity 个人会话。

原型是固定函数测试证明：没有通用任务拆解、任务 API、真正并行工作区、自动崩溃恢复、前端或完整生产安全边界。read-only 限制写入，不代表禁止读取用户其他文件；要运行任意不可信任务还需平台权限策略与沙箱验证。原始 stderr 可能含第三方诊断，分享前应复核；本轮只交接已检查的 JSONL/结果与构建测试日志，认证探针的原始 stderr 留在私人 work 中。
