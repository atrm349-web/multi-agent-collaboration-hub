<div align="center">

# 🔮 Multi-Agent Collaboration Hub (Agent Router)

### 跨厂商 · 多模型自主协同分工调度平台 (Local-First Autonomous Orchestrator)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Runtime: Bun / Node.js](https://img.shields.io/badge/Runtime-Bun%20%7C%20Node.js%20%3E%3D20-orange.svg)](https://bun.sh/)
[![UI: Agent Router 1:1](https://img.shields.io/badge/UI-Agent%20Router%201:1-success.svg)](#系统功能全景)
[![Models Supported](https://img.shields.io/badge/Models-DeepSeek%20%7C%20Claude%20%7C%20Gemini%20%7C%20WorkBuddy%20%7C%20Codex-purple.svg)](#多智能体分工协同体系)

---

**为了能用上几大 Agent 的额度与各自最强能力，做了多 Agent 软件间的协同调度器。**  
**核心思路很简单：你只跟一个主代理说话，主代理自动拆解、派发、多模型并发执行、独立沙箱代码审查与门禁测试，最后自动汇聚交付！**

</div>

---

## 📑 目录

- [🌟 为什么需要 Agent Router？](#-为什么需要-agent-router)
- [🖥️ 系统功能全景与拓扑大屏](#️-系统功能全景与拓扑大屏)
- [🤖 多智能体分工协同体系](#-多智能体分工协同体系)
- [🚀 1 分钟开箱即用快速上手](#-1-分钟开箱即用快速上手)
- [🛠️ 如何添加自定义 Agent（从零到一实战教程）](#️-如何添加自定义-agent从零到一实战教程)
- [📂 项目目录结构](#-项目目录结构)
- [⚙️ 环境变量与参数配置](#️-环境变量与参数配置)
- [🔒 安全与本地隐私保护承诺](#-安全与本地隐私保护承诺)
- [📄 开源协议](#-开源协议)

---

## 🌟 为什么需要 Agent Router？

在日常使用大模型与 AI 智能体时，开发者常常面临以下痛点：
1. **各家模型额度分散**：手里有 ChatGPT Plus、DeepSeek、Gemini、腾讯 WorkBuddy 等多个账号或额度，无法聚合使用。
2. **单模型能力存在局限**：
   - **DeepSeek (Reasoner / Chat)**：擅长数学逻辑、算法攻坚与复杂因果推理。
   - **Claude (Sonnet 3.5)**：擅长全栈架构、深度代码审查、自修复与长文档整合。
   - **Gemini (Flash / Pro)**：擅长超长上下文吞吐、基线规范校验与多模态分析。
   - **WorkBuddy / 本地工具**：擅长垂直领域本地网关调用与文件几何模块处理。
   - **Codex / ChatGPT**：擅长工程脚手架、测试驱动开发与自动化门禁把控。
3. **重复沟通与粘合成本高**：在多个 Web 窗口或 CLI 工具之间手动复制粘贴代码、人工测试和纠错，效率低下。

**Multi-Agent Collaboration Hub (Agent Router)** 提供了一套本地优先（Local-First）的轻量级解决方案：
- **统一入口**：你只需向主代理下达总体目标，或在页面点击【➕ 新建真实协同任务】。
- **自动 DAG 编排**：主调度器自动拆解依赖，分配给最合适的子模型。
- **物理沙箱隔离**：各子任务在独立的 Git Worktree 中执行，互不污染。
- **自动化测试门禁**：必须通过预设单元测试与独立代码审查门禁（`exitCode=0`）后方可归档合流。
- **1:1 沉浸式拓扑大屏**：全局流光连线、任务进度、时间轨道（Gantt Swimlane）一目了然。

---

## 🖥️ 系统功能全景与拓扑大屏

系统内置了 1:1 像素级复刻的 **Agent Router 沉浸式大屏**：

```
+---------------------------------------------------------------------------------------------------------+
| 🔮 Agent Router  [协作拓扑]   (5 执行成员)  (6 任务)  (4 已完成)      [➕ 新建真实协同任务]  [🟢 实机运行]    |
+-------------------+-------------------------------------------------------------------------------------+
| 运行区域          |  [实机] 智能协同 · 几何计算与全流程代码审查交付                        🟢 真实多Agent协同 · 全链路打通|
| • 实机 · 多Agent  +-------------------------------------------------------------------------------------+
|   本地网关·真实模型 |  【执行成员 5】           【主代理·拆解与整合】                      【结果去向 2】         |
|                   |  +------------------+    +-----------------------+              +--------------------+  |
| 真实协同成员      |  | (D) DeepSeek     |===>| Hub 主调度器 (C)      |=============>| 产物库 (Artifacts) |  |
| (C) 主代理        |  | (A) Claude       |===>| - 规划目标拆解 (DAG)   |=============>| - square.js        |  |
| (D) DeepSeek      |  | (G) Gemini       |===>| - 多模型异步并发派发  |              | - triangle.js      |  |
| (A) Claude        |  | (W) WorkBuddy    |===>| - 物理沙箱代码生成    |              | - test_geom.js     |  |
| (G) Gemini        |  | (X) Codex CLI    |===>| - 自动化测试与独立审查|              +--------------------+  |
| (W) WorkBuddy     |  +------------------+    +-----------------------+              | 质量门禁 (Gates)   |  |
| (X) Codex         |                                     ||                          | - exitCode=0 放行  |  |
|                   |                                     || 动态流光拓扑能量弧       | - 独立评审核准     |  |
|                   +-------------------------------------\/--------------------------+--------------------+  |
|                   | 时间轨道 (Timeline Gantt Swimlane):                                                     |
|                   | 主调度器   [===== T0 DAG规划拆解 =====] ◆ [======== 多模型并发调度 ========] ◆ [== 归档 ==] |
|                   | DeepSeek             [==== S1 square.js (3.6s) ====] ✔                                  |
|                   | Gemini               [==== S2 triangle.js (4.1s) ==] ✔                                  |
|                   | Claude                                              [==== S3 独立审查 (3.8s) =====] ✔   |
+-------------------+-----------------------------------------------------------------------------------------+
```

---

## 🤖 多智能体分工协同体系

```mermaid
flowchart TD
    User([👤 开发者下达协同目标]) --> Hub[👑 Hub 主调度器 Coordinator]
    
    subgraph DAG [DAG 智能任务拆解与调度]
        Hub --> Sub1[任务 T1: 核心算法实现]
        Hub --> Sub2[任务 T2: 几何辅助模块]
        Hub --> Sub3[任务 T3: 规范校验]
    end

    subgraph Engines [多模型异构并发执行集群]
        Sub1 -->|自动分配| DeepSeek[🧠 DeepSeek R1 / V3<br/>长链推理 & 算法攻坚]
        Sub2 -->|自动分配| Claude[🔮 Claude 3.5 Sonnet<br/>全栈实现 & 审查重做]
        Sub3 -->|自动分配| Gemini[🌐 Gemini Flash / Pro<br/>接口基线校验]
        Sub4 -->|自动分配| WorkBuddy[🛠️ WorkBuddy<br/>本地智能体 & 工具执行]
    end

    subgraph Sandboxes [Git Worktree 物理隔离沙箱]
        DeepSeek --> WB1[(沙箱工作区 1)]
        Claude --> WB2[(沙箱工作区 2)]
        Gemini --> WB3[(沙箱工作区 3)]
        WorkBuddy --> WB4[(沙箱工作区 4)]
    end

    subgraph Verification [全自动化质量门禁与审查]
        WB1 --> Gate[🛡️ 独立代码审查 + 自动化测试套件 (exitCode=0)]
        WB2 --> Gate
        WB3 --> Gate
        WB4 --> Gate
    end

    Gate -->|通过放行| Final[📦 成果与证据库 Artifacts & Git Commit]
```

---

## 🚀 1 分钟开箱即用快速上手

系统支持 **零依赖阻碍、开箱即用**。默认未配置密钥时以**【演示模式 (Mock Mode)】**启动，配置密钥后一秒切换为**【实机多模型协同 (Live Mode)】**。

### 1. 运行环境要求
- **Bun**（强烈推荐，极速启动）：[https://bun.sh](https://bun.sh)
  ```bash
  curl -fsSL https://bun.sh/install | bash
  ```
- 或 **Node.js**（>= 20.0.0）

### 2. 下载并一键启动
```bash
# 1. 克隆代码仓库
git clone https://github.com/your-username/multi-agent-collaboration-hub.git
cd multi-agent-collaboration-hub

# 2. 一键启动服务（会自动检测环境、建立沙箱环境）
./start.sh
```

如果使用 `bun` 或 `npm`，也可以直接运行：
```bash
bun run start
# 或
npm start
```

### 3. 打开大屏
终端打印就绪后，在浏览器中访问：
👉 **`http://127.0.0.1:4321`**

即可看到完整的 **Agent Router 拓扑调度大屏**！

### 4. 接入你的真实 API 密钥（可选）
如果需要使用真实的 DeepSeek、Gemini 或 ChatGPT 等模型：
```bash
# 复制环境变量模板
cp .env.example .env.local

# 使用你喜欢的编辑器编辑密钥
vim .env.local
```
在 `.env.local` 填入你的密钥后，重新运行 `./start.sh`，系统将自动识别并开启真实实机协同调度！

---

## 🛠️ 如何添加自定义 Agent（从零到一实战教程）

项目采用了模块化解耦的 **Agent Adapter 架构**。添加一个新模型（例如：本地 Ollama、Claude API、Qwen 通义千问、vLLM 等）仅需简单的 4 个步骤：

### 目录结构规范
所有 Agent 适配器存放在 `backend/agetor/packages/agent-adapters/` 下：
```text
backend/agetor/packages/agent-adapters/
├── deepseek/          # DeepSeek 适配器
├── gemini/            # Gemini 适配器
├── workbuddy/         # WorkBuddy 适配器
├── codex/             # Codex 官方 CLI 适配器
└── <my-agent>/        # 👈 你的自定义智能体
    ├── client.ts      # 网络通信、鉴权与重试
    ├── runtime.ts     # 工作区文件生成与执行回路
    └── index.ts       # 统一导出
```

---

### 步骤 1：编写通信客户端 `client.ts`

以接入任意 **兼容 OpenAI 格式的接口（如 Ollama / vLLM / 通义千问 / DeepSeek 本地部署）** 为例：

```typescript
// backend/agetor/packages/agent-adapters/my-agent/client.ts
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export interface MyAgentConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

export function resolveMyAgentKey(): string {
  if (process.env.MY_AGENT_API_KEY) return process.env.MY_AGENT_API_KEY.trim();
  // 自动从根目录 .env.local 读取
  const envPath = path.resolve(process.cwd(), ".env.local");
  if (existsSync(envPath)) {
    const text = readFileSync(envPath, "utf8");
    const m = text.match(/^\s*MY_AGENT_API_KEY\s*=\s*["']?([^"'\s]+)["']?/m);
    if (m && m[1]) return m[1];
  }
  return "ollama-local-key"; // 本地部署无需真实 key 时提供默认值
}

export class MyAgentClient {
  private apiKey: string;
  private baseUrl: string;
  private model: string;

  constructor(config?: MyAgentConfig) {
    this.apiKey = config?.apiKey || resolveMyAgentKey();
    this.baseUrl = config?.baseUrl || process.env.MY_AGENT_BASE_URL || "http://127.0.0.1:11434/v1";
    this.model = config?.model || "qwen2.5-coder:7b";
  }

  async generateCode(prompt: string, contextFiles?: Record<string, string>): Promise<string> {
    const systemPrompt = "你是一名顶尖的代码架构与实现智能体，请直接输出代码或文件修改方案。";
    
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `上下文文件:\n${JSON.stringify(contextFiles || {})}\n\n需求:\n${prompt}` }
        ],
        temperature: 0.2
      })
    });

    if (!response.ok) {
      throw new Error(`MyAgent API 调用失败: ${response.status} ${await response.text()}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || "";
  }
}
```

---

### 步骤 2：编写沙箱执行器 `runtime.ts`

```typescript
// backend/agetor/packages/agent-adapters/my-agent/runtime.ts
import { writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { MyAgentClient } from "./client.ts";

export interface ExecutionContext {
  workspaceDir: string;
  subtaskId: string;
  goal: string;
}

export class MyAgentRuntime {
  private client: MyAgentClient;

  constructor(client?: MyAgentClient) {
    this.client = client || new MyAgentClient();
  }

  async executeTask(ctx: ExecutionContext): Promise<{ success: boolean; filesModified: string[] }> {
    console.log(`[MyAgent] 开始在沙箱 ${ctx.workspaceDir} 中执行: ${ctx.goal}`);

    // 1. 调用模型生成实现
    const code = await this.client.generateCode(ctx.goal);

    // 2. 将生成结果安全写入隔离工作区
    const targetFile = path.join(ctx.workspaceDir, "solution.js");
    await writeFile(targetFile, code, "utf8");

    return {
      success: true,
      filesModified: ["solution.js"]
    };
  }
}
```

---

### 步骤 3：编写统一导出 `index.ts`

```typescript
// backend/agetor/packages/agent-adapters/my-agent/index.ts
export * from "./client.ts";
export * from "./runtime.ts";
```

---

### 步骤 4：在前端大屏注册该 Agent 显示（可选）

打开 `apps/web/public/app.js`，在 `memberCards` 数组中添加一行配置，大屏将自动出现专属头像与连线：

```javascript
{
  id: "myagent",
  name: "MyAgent (Qwen/Ollama)",
  model: "qwen2.5-coder:7b",
  letter: "Q",
  avatarCls: "ar-avatar-z", // 可选自带的主题色类名
  status: "在线",
  statusCls: "ar-status-success",
  tasks: [
    { code: "T7", title: "本地算法实现模块", status: "已完成", color: "#10b981" }
  ]
}
```

---

## 📂 项目目录结构

```text
├── start.sh                      # 🚀 一键开箱即用启动脚本 (优先使用)
├── .env.example                  # 环境变量模板 (复制为 .env.local 即可配置 Key)
├── .gitignore                    # 严格过滤个人敏感凭证、运行时数据库与日志
├── package.json                  # 项目依赖与启动脚本
├── config/
│   └── hub-config.json           # 默认跨平台服务器与仓库配置文件
├── apps/
│   └── web/                      # 前端交互界面
│       ├── server.mjs            # 静态轻量备用服务器
│       └── public/
│           ├── index.html        # 单页应用根模板
│           ├── styles.css        # 1:1 拓扑大屏样式与流光动画系统
│           └── app.js            # 前端大屏核心逻辑与实时事件交互
├── backend/
│   └── agetor/                   # 调度核心服务 (Hub Backend)
│       ├── packages/
│       │   ├── core/             # HTTP 路由、契约状态机、Git Worktree 沙箱管理
│       │   └── agent-adapters/   # 跨厂商多模型适配器集群 (DeepSeek/Claude/Gemini/WorkBuddy/Codex)
│       ├── scripts/
│       │   └── start-hub.ts      # 跨平台守护主进程启动脚本
│       └── src/bun/              # 数据库迁移、并发插槽与自动化测试
├── examples/
│   └── demo-geometry-repo/       # 开箱自带的几何算法演练测试仓库
└── docs/                         # 契约规范、设计图例与交接文档
```

---

## ⚙️ 环境变量与参数配置

系统自动读取根目录的 `.env.local` 文件，支持以下变量：

| 环境变量名 | 说明 | 默认值 / 示例 | 是否必需 |
| :--- | :--- | :--- | :--- |
| `PORT` | Hub 调度器 HTTP / WebSocket 服务端口 | `4321` | 否 |
| `HUB_MAX_CONCURRENCY` | 允许同时并行的子任务插槽数量 | `2` | 否 |
| `DEEPSEEK_API_KEY` | DeepSeek 官方 API 密钥 (用于推理、规划与编码) | `sk-...` | 实机模式推荐 |
| `DEEPSEEK_BASE_URL` | DeepSeek 服务端点 | `https://api.deepseek.com` | 否 |
| `ANTHROPIC_API_KEY` | Anthropic Claude API 密钥 (Claude 3.5 Sonnet) | `sk-ant-...` | 否 (可选真机引擎) |
| `ANTHROPIC_BASE_URL` | Anthropic 服务端点 | `https://api.anthropic.com` | 否 |
| `GEMINI_API_KEY` | Google Gemini API 密钥 (用于基线与规划) | `AQ....` | 实机模式推荐 |
| `WORKBUDDY_GATEWAY_URL` | 腾讯 WorkBuddy 本地网关地址 | `http://127.0.0.1:18492` | 否 |
| `OPENAI_API_KEY` | OpenAI 官方 API 密钥 (Codex 直连) | `sk-...` | 否 (支持桌面登录态) |

---

## 🔒 安全与本地隐私保护承诺

1. **Local-First 本地优先**：本项目所有核心调度、DAG 分解、沙箱执行与 SQLite 数据库均运行在用户本地机器上。
2. **密钥零泄漏保证**：
   - 本项目通过 `.gitignore` 严格排除了 `.env`、`.env.local` 及所有私有凭据文件。
   - 源代码中已全部采用动态路径解析，杜绝任何硬编码的开发者私人用户名、私有工作路径或私有 Token。
3. **安全沙箱隔离**：各子任务运行于独立的 Git Worktree 目录，未经测试门禁审查的代码绝不会合并进主分支。

---

## 📄 开源协议

本项目基于 **[MIT License](LICENSE)** 开源，欢迎自由二次开发、接入你自己的模型或在商业项目中参考使用！

<div align="center">
<b>让每个开发者的多模型额度真正协同起来！🚀</b>
</div>
