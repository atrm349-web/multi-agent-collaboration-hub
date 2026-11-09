# DS-03 场景执行包（A/B/C）

状态：**夹具已就绪，等待 DS-02 通过与运行授权**。本目录不含任何真实运行结果。

## 结构

```
scenario/
  owner-tests/slow.mjs   慢验收：先 sleep（默认 45s）再跑 DS-02 的同一套断言
  run.sh                 ./run.sh A|B|C → 各自的 runtime + 端口（4323/4324/4325）+ 独立 repo 副本
  A|B|C/                 运行时生成：repo/、config.json、runtime/、evidence/
```

慢验收脚本的用处：把"活动窗口"从"赌模型跑多久"变成**确定的 45 秒**。A/B 两个场景都只需 1 次真实模型调用（模型写代码那一步），随后进入 45 秒测试窗口，注入点稳定可复现。

## 通用准备

```sh
cd DeepSeek/DS-03/scenario
./run.sh A                     # 打印 scenario/port/root，等 "Hub ready"
BUN=/Users/anyunhong/Documents/Codex/2026-11-02/multi-agent-collaboration-hub-ai-agent/work/tooling/node_modules/@oven/bun-darwin-aarch64/bin/bun
DS02_CONFIRM_REAL_RUN=1 DS02_REPOSITORY_ID=66666666-6666-4666-8666-666666666666 \
  DS02_PROFILE_ID=slow DS02_RUNTIME="$PWD/A/runtime" DS02_EVIDENCE="$PWD/A/evidence" \
  DS02_TITLE="DS-03 A normal stop" $BUN ../DS-02/S1-auto-rework/drive-s1.ts create
```

拿到 `taskId` 后开始 `watch`（同样用 `DS02_RUNTIME`/`DS02_EVIDENCE` 指到本场景）。

## 场景 A：正常停止（SIGINT）

1. `watch` 等到 `IMPL` 进入 `validating`（说明 45 秒测试窗口已打开）。
2. 记录：`lsof -nP -iTCP:4323 -sTCP:LISTEN -t`（控制器 PID）、`claim.process_group_id`（测试进程组）、`hub_execution_slot` 行。
3. `kill -INT <hub pid>`。
4. 断言：
   - 进程退出、4323 无监听；
   - task/subtask 均为 `cancelled`（`finishControl`）；
   - `hub_execution_slot` 为空；
   - `kill -0 <pgid>` 失败（测试进程组被回收）；
   - `git -C A/repo rev-parse HEAD` 与 baseline 一致、工作区干净。
5. 重启 `./run.sh A`：无 `interrupted`/`blocked` 残留，`meta.liveExecutionAvailable=true`。

## 场景 B：控制器 SIGKILL（孤儿进程）

1. 同 A 进入 `validating`。
2. `kill -9 <hub pid>`（只杀控制器，**不碰测试进程组**）。
3. 立刻记录 `kill -0 <pgid>`：期望仍成功（子进程活着）。
4. 立刻重启 `./run.sh B`（同一个 runtime）：启动时 lease 尚未过期（10 s），首次对账可能什么都不做。
5. 等 ≥15 s 后再看：
   - run 变 `interrupted`、subtask `blocked`、task 带 `error`；
   - **run 数量不变**（不重复派发）、`hub_execution_slot` 仍被占、`meta.liveExecutionAvailable=false`。
6. 解除尝试：
   - 子进程还活着时 `acknowledgeInterruption` 必须被拒（`AGENT_UNAVAILABLE: process group is still present`）；
   - `kill -9 -<pgid>` 后再试，必须成功；槽位释放、agent 恢复 `available`、`run.updated` 事件带 `reconciliationNote`。
   - 注意：**没有 HTTP 端点**（见 `../初步发现-隔离解除无入口.md`），只能用脚本直调 store。这一点本身就是发现。

## 场景 C：模型进程退出（SIGKILL 进程组）

1. `watch` 等到 `run.status=running` 且日志里出现 `thread.started`（session 已建立）。
2. `kill -9 -<pgid>`。
3. 记录 run 终态：`exitCode`、`error.code`、`retryable`；subtask 是 `retry_wait`（自动返工）还是 `failed`。
4. 若返工：等 attempt 2 完成，确认状态机继续推进；若直接失败：确认 task `failed`、无 pending 审批、无残留槽位。
5. 重启一次确认无 `interrupted` 残留。

## 采集

复用 DS-02 的 `drive-s1.ts export <taskId>`（用 `DS02_RUNTIME` 指向本场景）导出数据库终态；`watch-<taskId>.jsonl` 提供状态迁移时间线。

进程证据：`kill -0` 结果序列 + `lsof` + `pgrep -fl "node|codex"`（我的沙箱禁 `ps`/`top`，但 `pgrep` 可用；如需 `ps` 级证据请在 Terminal 补一条）。

## 判据

见 `../验证方案.md` 第 7 节。任一不满足 → 记为问题并给最小修复建议，不改共享源码。
