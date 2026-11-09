# DS-02 / S1 执行包（真实失败 → 自动返工 → 独立审查 → 人工审批）

状态：**夹具已就绪并自测通过，等待真实运行授权**（未产生任何真实模型调用）。
本目录是自包含的实验环境：临时仓库、owner 验收脚本、运行时目录、配置、驱动脚本、证据目录。

## 目录

```
S1-auto-rework/
  repo/                 被测仓库（git init，baseline 5770c45）
  owner-tests/check.mjs owner 验收脚本（在仓库之外，Agent 不可写）
  runtime/              hub 运行时（**运行时自动创建**，已从交付中删除：里面有每次启动随机生成的 credentials.json，不应转交）
  config.json           owner 管理的注册配置（port 4322）
  run.sh                启动器（把官方 codex 加进 PATH）
  drive-s1.ts           驱动：create / watch / decide / export
  validate-fixture.ts   离线校验 payload 能被真实 validatePlan 接受
  evidence/             本轮全部证据
```

## 已完成的夹具自测（不需要模型、不需要额度）

| 检查 | 结果 | 证据 |
|---|---|---|
| owner 验收脚本能区分"未实现"与"正确实现" | 桩实现 exit 1（5 项失败，逐条打印 expected/actual）；正确实现 exit 0（5/5） | 见下方命令 |
| payload 能过真实 `validatePlan` + hub 的 criteria 校验 | `FIXTURE_VALID`，FINAL-REVIEW 自动依赖 IMPL | `evidence/fixture-validation.log` |
| hub 能在**受限沙箱**下启动 | `Hub ready http://127.0.0.1:4322`，health ok，meta live，credentials 0600 | `evidence/startup.log` |
| 驱动脚本读路径可用 | `drive-s1.ts meta` 返回 live meta；`export` 只读导出成功 | `evidence/startup.log` |

复跑：

```sh
# 1) owner 脚本区分度
cd repo && /usr/local/bin/node ../owner-tests/check.mjs ; echo "expect 1"
# 正确实现放在别处跑（不污染 repo baseline）：
#   mkdir -p /tmp/correct/src && 写一份正确实现 → node ../owner-tests/check.mjs → expect 0

# 2) payload 校验
BUN=/Users/anyunhong/Documents/Codex/2026-11-02/multi-agent-collaboration-hub-ai-agent/work/tooling/node_modules/@oven/bun-darwin-aarch64/bin/bun
$BUN validate-fixture.ts

# 3) 启动（这是真实运行的第一步，会开始消耗额度 —— 需授权）
./run.sh
```

## 真实运行的完整步骤（需授权后执行）

```sh
cd "/Users/anyunhong/Documents/deepseek-harness/default-workspace/DeepSeek/DS-02/S1-auto-rework"
BUN=/Users/anyunhong/Documents/Codex/2026-11-02/multi-agent-collaboration-hub-ai-agent/work/tooling/node_modules/@oven/bun-darwin-aarch64/bin/bun

# 0) 记录基线
git -C repo rev-parse HEAD          # 期望 5770c451ffe34636e59a0a12d7608a9b1d92e484
git -C repo status --porcelain      # 期望为空

# 1) 起服务（后台），等到 "Hub ready"
./run.sh > evidence/hub-run.log 2>&1 &

# 2) 建任务（DRY-RUN 保护：必须显式确认）
DS02_CONFIRM_REAL_RUN=1 $BUN drive-s1.ts create        # 输出 taskId

# 3) 观察（自动写 evidence/watch-<taskId>.jsonl）
$BUN drive-s1.ts watch <taskId>

# 4) 审批（由用户在 http://127.0.0.1:4322 点击，或授权后代执行）
DS02_CONFIRM_REAL_RUN=1 $BUN drive-s1.ts decide <approvalId> <version> <digest> approve

# 5) 导出数据库终态
$BUN drive-s1.ts export <taskId>

# 6) 停服 + 校验仓库未变
kill -INT <hub pid>
git -C repo rev-parse HEAD && git -C repo status --porcelain
```

## 预期观测点（对着源码写的，不是想象）

1. `IMPL` 第一次 attempt：`run.exitCode=0`（模型正常返回），但 owner 测试 `validation.exitCode=1` → 触发 `rework()`。
2. 返工消息 `kind=rework_instruction`，content 里带 `AC-AMOUNT: {"exitCode":1,...}` 与 stderr 的 expected/actual。
3. `IMPL.attempt` 变 2，状态 `retry_wait` → 第二次执行以第一次的 commit 为依赖起点。
4. 第二次通过 → `FINAL-REVIEW` 用**不同 providerSessionId** 跑独立审查 → `waiting_approval`。
5. 审批 approve → Task `succeeded`，approval `status=approved` 且 `actionDigest` 与 delivery digest 一致。
6. 结束后 `repo/` HEAD 仍是 `5770c45…`，`git status` 仍为空（Agent 只在 worktree 副本里改）。

## 环境事实（本轮实测，写进报告要用的）

- 控制器在**受限沙箱**下能正常启动与提供 HTTP/SSE（本轮已验证）；但 `runTestProfile` 内部要调 `codex sandbox`，**受限沙箱下会被拒**（`sandbox-exec: sandbox_apply: Operation not permitted`，退出码 71）。因此第 3 步的真实运行必须在**完全访问审批**下执行，或由用户在 Terminal 执行。
- `codex` 必须在 PATH 中（`scripts/start-hub.ts` 用 `Bun.which("codex")`）。`run.sh` 已处理。
- 端口 4322，避开 4320/4321。

## 风险提示

- 真实模型**可能一次通过**（那样就没有返工）。发生时会如实记录，并按方案 A→B→C 升级 forcing 设计，不会伪造失败。
- 两次都没过 → Task `failed`（`maxAttempts=2`），这是"预算不足"的真实结论，不改配置掩盖。
- 每次运行都会消耗订阅额度；`create`/`decide` 都有 `DS02_CONFIRM_REAL_RUN=1` 硬门。


## 交付卫生

- `runtime/` 由 `./run.sh` 自动重建；里面只有 `state/credentials.json`（每次启动随机 token，0600）、SQLite 与 workspaces。**不要把 runtime/ 转交或贴进报告**，本轮已删除。
- `evidence/` 里没有任何 token/凭据；`startup.log` 只记录 `Hub ready` 与 health/meta 输出。
- `repo/` 的 baseline commit 是 `5770c451ffe34636e59a0a12d7608a9b1d92e484`，运行前后都应保持这个 HEAD 且工作区干净。
