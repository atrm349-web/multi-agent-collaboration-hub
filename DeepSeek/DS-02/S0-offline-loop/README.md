# DS-02 / S0：离线闭环自测（受控证据，非真实模型）

- 目的：在花订阅额度之前，用**真实** `HubService` / SQLite / Git worktree / 质量门，把三条关键状态机路径跑一遍，确认夹具、断言与预期证据形状都对。
- 结果：**s1 / s2 / s3 全部通过**。
- 分类声明（不许混淆）：**provider 是本地模拟器（`fake-provider.mjs`），planner 被 `plannedSubtasks` 绕过，`testRunner` 用直接 `node` 执行替代 seatbelt 沙箱。** 控制器、SQLite、Git、质量门、审批摘要、产物冻结都是生产代码。
- 证据：`s0-s1-evidence.json`、`s0-s2-evidence.json`、`s0-s3-evidence.json`。

## 1. 三个场景各自证明了什么

### s1 失败 → 自动返工 → 审批 → succeeded

```
IMPL attempt 1  run succeeded/exit0  →  validation AC-AMOUNT failed/exit1   ← 模型"成功"但实现不达标
rework          rework_instruction 带完整失败输出（expected "¥12.34" but got "12.34"）
IMPL attempt 2  从 attempt 1 的 commit 继续 → validation passed/exit0
FINAL-REVIEW    独立 session → AC-FINAL passed → waiting_approval
approve         → Task succeeded
```

- 3 个 run、3 个 validation、3 个互不相同的 provider session。
- 原仓库 `HEAD` 仍为 `5770c451…`，工作区干净。

### s2 审批拒绝 → 显式返工 → 新审批 → succeeded

```
第 1 轮: IMPL attempt 1 通过 → FINAL-REVIEW 通过 → approval#1 pending（digest 8a170866…, 5 个 artifactRefs）
reject   → approval#1 = rejected，Task 仍 waiting_approval
rework   → 显式 POST subtasks/{FINAL-REVIEW}/rework → 目标落到 IMPL，attempt 2
第 2 轮: IMPL attempt 2 通过 → FINAL-REVIEW attempt 2 → approval#2 pending（digest c28f5472…, 4 个 artifactRefs）
approve  → Task succeeded
```

证明的四件事：

1. **旧审批不会复活**：approval#1 终态 `rejected`，approval#2 是全新记录。
2. **digest 与产物引用都换了**：`actionDigest` 不同，`artifactRefs` 从 5 个变成 4 个（第 1 轮的空 diff 不再被引用），说明新审批只绑当前 attempt 的产物。
3. **拒绝不会自动返工**：reject 后任务停在 `waiting_approval`，必须显式 rework——这正是交接方案里"拒绝保持等待显式返工"的语义。
4. **rework 打到 FINAL-REVIEW 会映射到最后一个实现/文档子任务**（返回 `subtaskId` 是 IMPL，`status: retry_wait`）。

### s3 两次都失败 → 重试预算耗尽 → Task failed（无审批）

```
IMPL attempt 1 → validation failed/exit1 → rework
IMPL attempt 2 → validation failed/exit1 → rework 抛 UNSUPPORTED_TRANSITION: retry budget exhausted
→ Task failed，error.code=UNSUPPORTED_TRANSITION，runs 恰好 2 条，approvals 0 条
```

证明：`maxAttempts=2` 是硬上限，第三次不会发生；任务终态不会被伪造的审批带过。

## 2. 本轮自测顺带发现的三个真实观察（给 Codex）

### 观察 1：`run.succeeded` 不等于实现被接受（这是设计，但要写进文档）

s1 里 `runs[0].status=succeeded` 而 `validations[0].status=failed` 同时存在。这是正确的：模型进程正常退出，但固定验收测试不通过，平台据此返工。**建议在 `LOCAL-START.md` 或 `docs/hub` 明确写一句**，否则后来者很容易把"run 成功"误读成"任务成功"。

### 观察 2：重试预算耗尽后，子任务停在 `validating`

s3 的终态：`task.status=failed`，但 `IMPL.status` 仍是 `validating`（attempt 2），`FINAL-REVIEW` 仍是 `pending`。`failTask()` 只改 task，不收敛子任务。

影响：UI 上会看到一个"永久 validating"的子任务；`subtaskAction(retry)` 要求 `failed|timed_out`，所以这个子任务也无法手动重试（任务已终态，本来也不允许）。**建议 `failTask()` 顺手把非终态子任务标为 `failed`**（带同一个 error），代价一行，收益是状态自洽。

### 观察 3：零改动的 FINAL-REVIEW 也会产生空 diff 产物

s2 里第 1 轮的 approval 有 5 个 artifactRefs，其中包含一份空 diff（sha256 `e3b0c442…`）。它会让 `artifactCount` 虚高，也让审批摘要列出无意义条目。建议 `execute()` 在 `captured.files.length === 0` 时跳过 diff 产物。

## 3. 怎么复跑

```sh
cd DeepSeek/DS-02/S0-offline-loop
BUN=/Users/anyunhong/Documents/Codex/2026-11-02/multi-agent-collaboration-hub-ai-agent/work/tooling/node_modules/@oven/bun-darwin-aarch64/bin/bun
$BUN s0-loop.ts s1     # exit 0
$BUN s0-loop.ts s2     # exit 0（rejected>approved）
$BUN s0-loop.ts s3     # exit 0（failed / 2 runs / 0 approvals）
```

每个场景用独立的 `runtime-<s>/`，每次运行前删除重建，不参与交付。

## 4. 与 S1 的区别

| | S0（本目录） | S1（`../S1-auto-rework`） |
|---|---|---|
| provider | 本地模拟器 | **真实 Codex CLI（订阅）** |
| planner | 绕过 | 绕过（同样 `plannedSubtasks`） |
| 测试执行 | 直接 `node` | **官方 seatbelt 沙箱** |
| 额度 | 0 | 1–3 次调用 |
| 证据等级 | 受控 | 真实模型 |

S0 通过只证明**失败/拒绝/超限发生时，平台的状态机是可观测、自洽的**；真实模型会不会失败、能不能按失败文本修复，只有 S1 能回答。

## 5. 这轮修掉的两个夹具 bug（记录在案，避免复现）

1. s2 最初让第一次 attempt 就写"naive"实现，导致它先生成了自动返工，等我去 reject 时 `IMPL` 已经是 attempt 2 → `rework` 直接抛"retry budget exhausted"。修法：S2 场景用 `DS0_FIRST_ATTEMPT_CORRECT=1` 让首轮通过。
2. s3 最初把"任务 failed"当成异常（等待循环里无条件抛错）。修法：s3 允许首轮终态是 `failed`，只在 s1/s2 视为异常。

这两条说明：**夹具本身也要被测**，否则真实运行时会浪费额度在夹具 bug 上。
