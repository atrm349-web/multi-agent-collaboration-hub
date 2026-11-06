# Antigravity F-02 前端真实后端联调交付包 (`Antigravity/frontend-deliveries/F02/`)

- **交付时间**：2026-11-03
- **对应任务**：`F-02`（前端状态层与 Fetch-SSE 实时订阅打通真实后端 API）& `I-01`（多 Agent 真实协同端到端验收）
- **对齐后端版本**：Codex `B-04 ~ B-06`（分支 `codex/b04-b06-local-platform`，提交 `9322bac26700a251947469a379658607cff4bb4b`）

---

## 1. 对 `Codex/backend-deliveries/B04-B06/README.md` 全部事项的逐项对齐

1. **受控桥接锚点 100% 兼容（零破坏直接运行 `start-hub.ts`）**：
   - [`apps/web/public/app.js`](file:///Users/developer/Desktop/%E9%9B%86%E5%90%88agnet/apps/web/public/app.js) 与 [`apps/web/public/index.html`](file:///Users/developer/Desktop/%E9%9B%86%E5%90%88agnet/apps/web/public/index.html) 完整保留了 [`packages/core/frontend.ts`](file:///Users/developer/Desktop/%E9%9B%86%E5%90%88agnet/backend/agetor/packages/core/frontend.ts) 中的全部 `replaceExact` 替换锚点。
   - 在不修改 `backend/agetor` 任何文件的前提下，`bun test src/bun/hub-frontend.test.ts` **7 项测试（36 项断言）全部通过**，`bun scripts/start-hub.ts` 可直接挂载 `.//apps/web/public` 启动。
   - 同时在本目录产出已内联桥接逻辑的正式前端交付件 [`app.live-native.js`](file:///Users/developer/Desktop/%E9%9B%86%E5%90%88agnet/Antigravity/frontend-deliveries/F02/app.live-native.js) 与 [`index.live-native.html`](file:///Users/developer/Desktop/%E9%9B%86%E5%90%88agnet/Antigravity/frontend-deliveries/F02/index.live-native.html)，并在 [`manifest.json`](file:///Users/developer/Desktop/%E9%9B%86%E5%90%88agnet/Antigravity/frontend-deliveries/F02/manifest.json) 中登记最新源码 SHA-256 哈希，供 Codex 随时同步 `packages/core/frontend.ts`。

2. **修复并增强真实后端 (`executionMode: 'live'`) 联调的 5 项关键细节**：
   - **`Idempotency-Key` 首字符规范对齐 (`http.ts:225`)**：[`makeIdempotencyKey()`](file:///Users/developer/Desktop/%E9%9B%86%E5%90%88agnet/apps/web/public/app.js#L74-L78) 自动剥离 `/api/v1/...` 路径转换产生的首字符连字符 `-`，严格满足服务端 `/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/` 正则校验。
   - **`.json` 测试报告产物内容读取兼容 (`http.ts:166`)**：[`apiRequest()`](file:///Users/developer/Desktop/%E9%9B%86%E5%90%88agnet/apps/web/public/app.js#L128-L135) 针对 `/api/v1/artifacts/:id/content` 返回 `Content-Type: application/json` 原始产物字节流（非 `{ data, requestId }` 包装）时，自动序列化为格式化 JSON 文本，确保 `SUB-01-clamp.json` 等 `test_report` 在 `Artifact Center` 中完整高亮展示并支持一键下载（`⬇ 下载产物`）。
   - **`FINAL-REVIEW` 保留编码与 `analysis` 阶段剥离 (`hub.ts:219-221`)**：新增 [`sanitizeExecutablePlan()`](file:///Users/developer/Desktop/%E9%9B%86%E5%90%88agnet/apps/web/public/app.js#L137-L147)，在提交 `POST /api/v1/tasks` 时自动过滤仅属于 `tasks/decompose` 的 `analysis` 阶段节点与协调器保留的 `FINAL-REVIEW` 编码，并同步清理下游 `dependsOn` 引用；同时在 `Task Center` 顶部醒目提示 `FINAL-REVIEW` 协调器保留规则与 `defaultTestProfileId` 独立沙箱验收机制。
   - **子任务重试/返工响应结构双模兼容 (`hub.ts:284`)**：`POST /api/v1/subtasks/:id/retry` 与 `/rework` 同时兼容真实后端返回的 `{ subtaskId, status: 'retry_wait', operationId }` 与 Mock 服务返回的 `{ subtask, invalidatedApprovalIds }`；在 `Review Center` 中支持对 `pending` 审批直接触发返工（自动将旧审批置为 `invalidated`）以及在 `reject`（审批变为 `rejected`、任务保持 `waiting_approval`）后显式触发 `POST /api/v1/subtasks/:id/rework`。
   - **独立沙箱验收测试记录展示 (`detail.validations.items`)**：在 `Review Center` 新增 **独立沙箱验收测试记录 (`Validation Records`)** 面板，展示每条 `Validation` 的 `criterionId`、`status`、`exitCode`、`subtaskId`、`runId` 与 `evidenceArtifactIds`。

---

## 2. 最新前端源码 SHA-256 清单（供 Codex `packages/core/frontend.ts` 核对）

| 文件 | 路径 | SHA-256 |
|---|---|---|
| `index.html` | `.//apps/web/public/index.html` | `66304e120a1fad26f5a79e740721a1140fa81f6c5b27d9ab6472f17ac595bde5` |
| `app.js` | `.//apps/web/public/app.js` | `60612e4e148ff138ff9451263f22965c5daa1360a15bb78b21303ff5b6e9e2f1` |
| `styles.css` | `.//apps/web/public/styles.css` | `cf18944d3c0fb913ff95ace72b40acd6216662d5d5e6203933214e0c88039fbe` |
| `app.live-native.js` | `.//Antigravity/frontend-deliveries/F02/app.live-native.js` | `57ae412748763aecc81b4ffabe99cd362a141c9d429e55056934b1d16ad09122` |
| `index.live-native.html` | `.//Antigravity/frontend-deliveries/F02/index.live-native.html` | `794b7df7d07c3aa5fcb7ed1f9920df291a7bb650645207e77e4f5e5507f68523` |
