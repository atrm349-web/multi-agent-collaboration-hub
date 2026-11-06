# B-02 Codex 受控执行器 — 本轮已实测通过

日期：2026-11-02。D-01用户已确认Agetor条件复用；本包是后端B-01/B-02交付，尚不是完整平台。

## 已交付

- `packages/agent-adapters/codex/runtime.ts`：只允许Codex的独立子进程运行器，复用上游改造后的buildCodexCommand，不依赖tmux。
- 支持启动、状态/日志/结果查询、指定session恢复、取消和超时；单实例最多一个活跃run，符合8GB Mac的轻量验证目标。
- 固定工作区根：realpath校验目录及符号链接逃逸；拒绝请求提供bin/env/home/未知字段，过滤密钥环境变量。数据目录必须显式位于允许根内；静态导入runtime不打开用户数据库。
- 成功必须有turn.completed且进程exit=0；取消/超时意图不能被迟到成功覆盖；先SIGTERM、必要时SIGKILL，确认进程组回收后才结束。
- 处理跨chunk UTF-8/CRLF/无末尾换行；单run日志上限1MiB，超限失败关闭。

## 实测结果

- B-01：413项单元/工作区/启用策略回归通过。
- 新运行器：15项/47断言通过，包含孙进程回收。
- 上游Codex事件映射：14项通过；两个编排会话测试文件分别3项通过，共6项。
- 原项目typecheck和新增Hub专用typecheck通过；git diff --check通过。
- 真实Codex共6个串行运行：初始调用、明确session恢复、允许工作区写入、工作区外写入被OS沙箱拒绝、已启动工具命令的活动取消、已启动工具命令的15秒超时。登录沿用ChatGPT，没有新增API Key。
- `evidence/real-runtime/summary.json` passed=true；取消记录commandStarted=true，超时timeoutCommandStarted=true。outside-write-denied运行成功表示“负向隔离测试成功”，不是越界写入成功。

初次把上游测试混在同一进程时，有3个计时断言失败：queue-floor测试泄漏400ms假执行延时，另一文件只等80/200ms。按独立进程运行均通过；保留b02-initial-mixed-tests.log，不把混跑说成通过，也未为掩盖失败修改无关上游测试。

## 源码与复现

桌面共享根目录的 `backend/agetor/` 是完整本地源码仓库，分支与提交见source-version.json；没有推送远程，也没有覆盖前端Mock。

在该源码目录安装锁定依赖后：

```sh
bun install --frozen-lockfile --ignore-scripts
bun run test:hub
bun run typecheck
bun run typecheck:hub
# 必须使用不存在的新输出目录；此命令会消耗现有Codex配额
bun run verify:hub:live /absolute/path/to/new-evidence-directory
```

需要官方Codex CLI 0.166.0-alpha.5.1或经兼容验证的版本，已完成官方ChatGPT登录。真实测试脚本固定验证模型gpt-6.1-sol/high，不代表动态模型发现已经完成。

使用运行器前先在受控根目录内创建专用AGETOR_DATA_DIR；程序只在新进程中导入这条受控路径，不复用曾打开旧用户数据库的宿主。

## Antigravity 现在如何配合

读取本包和完整源码即可；继续F-03的v0.2前端迁移。暂不要把Mock标成live：本轮没有提供正式/api/v1服务、持久化运行恢复或调度DAG。实际HTTP联调命令将由B-03及后续服务集成提供。

## 尚未完成和限制

- B-03数据库持久化/重启对账，B-04调度，B-05独立验收/审批返工，B-06并行Worktree集成尚未完成；状态目前在内存，不承诺崩溃续跑。
- Windows执行明确拒绝，等待Windows进程树/沙箱适配；macOS只验证当前环境，未做长时压力测试。
- 不接管旧上游tmux会话、不启动原Agetor完整桌面自动执行。原上游其他harness仍保留，不属于受控Hub入口已验证能力。
- workspace-write并不等于完整读取隔离；未声称任意恶意代码均无法读取所有用户可读文件。真正执行不可信仓库前仍需完善读取/配置/插件权限策略。
- 关联Worktree的auto写入当前明确拒绝；Git操作需后续协调器接管，绝不为方便commit自动扩大权限。
