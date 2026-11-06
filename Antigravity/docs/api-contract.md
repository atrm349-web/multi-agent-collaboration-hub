# 前后端接口契约（`docs/api-contract.md`）

**契约版本：** V1.0.0  
**状态：** 第一阶段基准契约（Antigravity 已在本地原型服务 `apps/web/server.mjs` 完整实现，待 Codex 在正式后端引擎中对齐实现）  
**共享类型源码：** [`packages/shared/src/types.ts`](../packages/shared/src/types.ts)

---

## 1. 基础约定

- **默认本地服务地址：** `http://127.0.0.1:4320`
- **数据编码：** `application/json; charset=utf-8`
- **时间戳格式：** ISO 8601 UTC 字符串（例如 `"2026-11-02T05:50:00.000Z"`）
- **响应信封格式：**
  ```json
  {
    "ok": true,
    "executionMode": "mock",
    "data": { ... },
    "timestamp": "2026-11-02T05:50:00.000Z"
  }
  ```
- **错误响应格式：**
  ```json
  {
    "ok": false,
    "error": {
      "code": "INVALID_STATE_TRANSITION",
      "message": "Cannot pause a task that is already completed."
    }
  }
  ```

---

## 2. 端点详细规范

### 2.1 `GET /api/state`
返回平台当前全量内存/持久化快照：
```json
{
  "ok": true,
  "executionMode": "mock",
  "data": {
    "tasks": [],
    "subtasks": [],
    "agents": [],
    "agentRuns": [],
    "messages": [],
    "artifacts": [],
    "approvals": []
  }
}
```

### 2.2 `POST /api/tasks/decompose`
根据用户输入的自然语言任务目标，返回建议的子任务 DAG 拆解预览，不立即副作用启动进程。
- **Request:**
  ```json
  {
    "prompt": "开发一个基于 Python 的智能车视觉识别系统，要求实现赛道识别、障碍物检测、测试验证，并生成完整开发文档。",
    "repoPath": "~/workspace/smartcar-vision"
  }
  ```
- **Response (`data.subtasksPreview`):**
  返回包含 `code`, `title`, `stage`, `dependsOn`, `assignedAgentId`, `acceptanceCriteria` 的数组。

### 2.3 `POST /api/tasks`
创建新任务、初始化子任务 DAG 并启动第一个就绪节点（`SUB-01`）。
- **Request:**
  ```json
  {
    "title": "Python 智能车视觉识别系统",
    "prompt": "开发一个基于 Python 的智能车视觉识别系统，要求实现赛道识别、障碍物检测、测试验证，并生成完整开发文档。",
    "repoPath": "~/workspace/smartcar-vision",
    "priority": "high",
    "maxRetries": 3,
    "timeoutSeconds": 180
  }
  ```

### 2.4 `POST /api/tasks/:taskId/action`
对任务执行状态控制或演练指令。
- **Request:**
  ```json
  {
    "action": "pause | resume | cancel | retry | step | simulate_timeout | simulate_failure",
    "reason": "Optional operator note"
  }
  ```

### 2.5 `POST /api/approvals/:approvalId/resolve`
处理人工审核门禁（批准继续或打回返工）。
- **Request:**
  ```json
  {
    "decision": "approved | rework_requested",
    "comment": "障碍物检测在低照度样本集下召回率不足 90%，请补充 CLAHE 自适应直方图均衡化预处理并重跑测试。"
  }
  ```
- **状态机联动：**
  - 若 `decision === "approved"`：对应 `Approval.status = "approved"`，关联 `Subtask.status = "completed"`，自动调度其下游依赖已满足的 `Subtask` 进入 `running`。若为最后一个门禁，则 `Task.status = "completed"`。
  - 若 `decision === "rework_requested"`：对应 `Approval.status = "rework_requested"`，关联 `Subtask.status = "reworking"`，`Task.status = "reworking"`，自动生成一条 `type: "rework_instruction"` 的 `Message` 发送给负责该子任务的 Agent 并触发新一轮 `AgentRun`。

### 2.6 `POST /api/messages`
发送人工干预指令或追问到指定 Agent。
- **Request:**
  ```json
  {
    "taskId": "task-smartcar-01",
    "subtaskId": "sub-02",
    "toAgentId": "agent-codex",
    "content": "请确保赛道识别模块输出标准鸟瞰图变换矩阵与车道曲率半径。"
  }
  ```

### 2.7 `GET /api/stream` (SSE)
保持长连接，服务端在任何状态变化时发送 `data: <JSON>\n\n`，JSON 结构为：
```json
{
  "eventId": "evt-1042",
  "type": "task.updated | subtask.updated | run.log | message.created | approval.updated | artifact.created | state.snapshot",
  "timestamp": "2026-11-02T05:51:00.000Z",
  "payload": { ... }
}
```
