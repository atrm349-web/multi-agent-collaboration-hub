# Multi-Agent Collaboration Hub — `F-02` & `I-01` 真实后端 + 真实 Google Chrome 端到端交互联调报告

- **验证时间**：2026-11-03
- **负责模块**：`Antigravity`（`F-02` 前端状态层与真实后端 API/Fetch-SSE 打通 + `I-01` 端到端交互与浏览器验收）
- **对接后端**：`OpenAI Codex` 交付的 `B-04 ~ B-06`（`backend/agetor`，分支 `codex/b04-b06-local-platform`，提交 `9322bac26700a251947469a379658607cff4bb4b`）
- **浏览器环境**：真实 `Google Chrome 156.0.0.0`（macOS arm64，通过 CDP 驱动真实 DOM 点击、表单输入、SSE 订阅与 Retina 2x 截图）
- **证据归档（严格区分 Live 与 Mock）**：
  - **Live 真实后端 + Chrome 证据**：
    - 结构化联调结果：[`Antigravity/evidence/live-f02-i01.json`](file:///Users/developer/Desktop/%E9%9B%86%E5%90%88agnet/Antigravity/evidence/live-f02-i01.json)
    - 控制台执行日志：[`Antigravity/evidence/live-f02-i01.log`](file:///Users/developer/Desktop/%E9%9B%86%E5%90%88agnet/Antigravity/evidence/live-f02-i01.log)
    - Live 模式 Chrome 实测截图：
      - [`live_01_dashboard.png`](file:///Users/developer/Desktop/%E9%9B%86%E5%90%88agnet/Antigravity/evidence/screenshots/live_01_dashboard.png)（`SERVICE: LIVE`、`liveExecutionAvailable=true`、无 Mock 注入面板）
      - [`live_02_task_center.png`](file:///Users/developer/Desktop/%E9%9B%86%E5%90%88agnet/Antigravity/evidence/screenshots/live_02_task_center.png)（`POST /api/v1/tasks/decompose` 拆解预览与 `FINAL-REVIEW` / `defaultTestProfileId` 规则横幅）
      - [`live_03_review_center.png`](file:///Users/developer/Desktop/%E9%9B%86%E5%90%88agnet/Antigravity/evidence/screenshots/live_03_review_center.png)（`actionDigest` 终审门禁、独立 `Validation Records` 验收面板与显式 `Rework` 按钮）
      - [`live_04_artifact_center.png`](file:///Users/developer/Desktop/%E9%9B%86%E5%90%88agnet/Antigravity/evidence/screenshots/live_04_artifact_center.png)（受控 `diff`、`code` 与 `.json` `test_report` 内容渲染及下载按钮）
  - **Mock 契约回归证据（独立归档）**：
    - [`Antigravity/evidence/mock-contract-v0.2.log`](file:///Users/developer/Desktop/%E9%9B%86%E5%90%88agnet/Antigravity/evidence/mock-contract-v0.2.log)（7 大 HTTP 契约测试套件全通）
    - [`Antigravity/evidence/mock-browser-v0.2.log`](file:///Users/developer/Desktop/%E9%9B%86%E5%90%88agnet/Antigravity/evidence/mock-browser-v0.2.log)（6 项 Chrome 交互检查全通）

---

## 1. 联调过程中发现并修复的前后端真实对接问题

在直接挂载 [`backend/agetor/packages/core/frontend.ts`](file:///Users/developer/Desktop/%E9%9B%86%E5%90%88agnet/backend/agetor/packages/core/frontend.ts)、[`packages/core/http.ts`](file:///Users/developer/Desktop/%E9%9B%86%E5%90%88agnet/backend/agetor/packages/core/http.ts) 与 [`packages/core/hub.ts`](file:///Users/developer/Desktop/%E9%9B%86%E5%90%88agnet/backend/agetor/packages/core/hub.ts) 执行真实浏览器联调时，定位并修复了以下关键细节：

1. **`Idempotency-Key` 首字符规范对齐 (`http.ts:225`)**：
   - **现象**：前端原 `path.replace(/[^a-z0-9]/gi, '-')` 将 `/api/v1/tasks/decompose` 转为 `-api-v1-tasks-decompose-...`（以 `-` 开头），而真实后端 `http.ts:225` 校验正则 `/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/` 要求首字符必须为字母或数字。
   - **修复**：在 [`makeIdempotencyKey()`](file:///Users/developer/Desktop/%E9%9B%86%E5%90%88agnet/apps/web/public/app.js#L74-L78) 中自动剥离非字母数字前缀，确保所有写请求 `Idempotency-Key` 100% 符合真实后端正则。
2. **`.json` 测试报告产物内容读取 (`http.ts:166`)**：
   - **现象**：真实后端对 `SUB-01-clamp.json` 等测试报告产物返回原始 JSON 字节流（`Content-Type: application/json`，不包裹 `{ data, requestId }`），原 `apiRequest` 返回 `payload.data` 导致 `.json` 产物内容为 `undefined`。
   - **修复**：在 [`apiRequest()`](file:///Users/developer/Desktop/%E9%9B%86%E5%90%88agnet/apps/web/public/app.js#L128-L135) 中对 `/content` 端点兼容原始字符串与原始 JSON 对象（自动格式化为 `JSON.stringify(payload, null, 2)`），并在 `Artifact Center` 增加受控产物一键下载按钮。
3. **`FINAL-REVIEW` 协调器保留编码与 `analysis` 阶段剥离 (`hub.ts:219-221`)**：
   - **修复**：新增 [`sanitizeExecutablePlan()`](file:///Users/developer/Desktop/%E9%9B%86%E5%90%88agnet/apps/web/public/app.js#L137-L147)，在提交 `POST /api/v1/tasks` 时自动过滤 `stage === 'analysis'` 与 `code === 'FINAL-REVIEW'`，并重映射下游 `dependsOn`，同时在 UI 界面显式展示 `FINAL-REVIEW` 保留编码与 `defaultTestProfileId` 沙箱验收规则。
4. **子任务重试/返工响应结构双模兼容 (`hub.ts:284`)**：
   - **修复**：兼容真实后端 `{ subtaskId, status: 'retry_wait', operationId }` 与 Mock 服务 `{ subtask, invalidatedApprovalIds }` 两种返回结构，并在 `Review Center` 的 `rejected` 审批卡片上提供显式 `POST /api/v1/subtasks/:id/rework` 触发入口。

---

## 2. 7 大真实后端 + Google Chrome 端到端交互验收项结果 (`tests/verify-live-f02-i01.ts`)

| 序号 | 验收项 | 实测验证内容 | 结果 |
|---|---|---|---|
| **Check 1** | `bootstrapAndLiveMode` | CSP Nonce 注入 `window.__HUB_BOOT__.token`；顶栏展示 `SERVICE: LIVE · contractVersion=0.2 · liveExecutionAvailable=true`；DOM 中 Mock 控制按钮数量为 `0`；自动选中已注册真实 Git 仓库 UUID。 | **PASS** |
| **Check 2** | `decomposeAndCreate` | 在 Chrome 中点击 `#previewDecomposeBtn` 调用 `POST /api/v1/tasks/decompose` 渲染 `DraftPlan`；点击 `#launchTaskBtn` 调用 `POST /api/v1/tasks`（`201`），协调器自动追加 `FINAL-REVIEW`（`Independent final review`）。 | **PASS** |
| **Check 3** | `pauseResumeMessageAndValidation` | 在 Chrome 中点击 `⏸ 暂停任务`（`pausing -> paused`）；在 `Agent Workspace` 发送排队上下文消息（`POST /api/v1/tasks/:id/messages` -> `delivery='queued_next_turn'`）；点击 `▶ 恢复派发`（`paused -> queued -> running`）；完成独立沙箱测试与 `FINAL-REVIEW` 后进入 `waiting_approval`。 | **PASS** |
| **Check 4** | `sseCursorRecovery` | 触发过期游标 `Last-Event-ID: 999999`，真实后端返回 `409 EVENT_CURSOR_EXPIRED`，前端自动重拉 `/api/v1/snapshot` 并以最新 `snapshotSeq` 恢复 SSE 连接。 | **PASS** |
| **Check 5** | `artifactCenter` | 在 Chrome 中切换至 `Artifact Center`，验证 `SUB-01-attempt-1.diff`、`src/clamp.ts`、`SUB-01-clamp.json`、`FINAL-REVIEW-attempt-1.diff`、`FINAL-REVIEW-clamp.json` 5 项受控产物正文完整渲染（`.json` 报告包含 `"profileId": "clamp"` 与 `"exitCode": 0`），并点击 `⬇ 下载产物`。 | **PASS** |
| **Check 6** | `approvalAndReworkLifecycle` | 验证错误 `actionDigest` 返回 `409 CONFLICT`；点击 `Reject`（`decision='reject'`）后审批变为 `rejected`、任务保持 `waiting_approval` 等待显式返工；点击显式 `Rework` 触发 Attempt #2 生成新 `actionDigest` 审批；点击 `Approve`（`decision='approve'`）后 `Task = succeeded`（`100%`）；并在第 2 个任务上验证 `pending` 状态下点击 `Rework` 自动将旧审批置为 `invalidated`。 | **PASS** |
| **Check 7** | `cancelAndDrainedLogs` | 在 Chrome 中对正在运行 Attempt #2 的第 2 个任务点击 `⏹ 取消任务`，验证 `cancelling -> cancelled` 终态收敛，进程组收到 `SIGTERM` 后刷出的迟到 stderr 行标记为 `drained=true` 且不覆盖 `cancelled` 终态。 | **PASS** |

---

## 3. 诚实边界说明（Verification Boundaries）

- **已验证范围**：macOS (`darwin-arm64`) 本地单用户受控协同闭环（`127.0.0.1` 绑定、Bearer + CSP Nonce 鉴权、SQLite WAL 持久化、Git Worktree 隔离、独立验收测试、独立终审与 `actionDigest` 门禁、Fetch-SSE 流式事件与 Chrome 156 端到端交互）。
- **未覆盖范围（保持未勾选/未声称完成）**：
  - Windows 平台路径、权限与沙箱未验证；
  - 真实模型进程在运行中途被外部强杀后的自动接管未验证（当前由启动对账保守标记 `run=interrupted`、`subtask=blocked` 并隔离执行槽）；
  - 多厂商异构 CLI（Claude Code / Gemini CLI 等）默认关闭自动发现，未纳入本次真实运行验收；
  - 长时间高负载压测未执行。
