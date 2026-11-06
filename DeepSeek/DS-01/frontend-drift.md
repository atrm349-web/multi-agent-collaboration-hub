# 前端基线漂移分析（DS-01 发现）

- 发现方：DeepSeek
- 发现时间：2026-11-03 20:1x JST
- 影响范围：`apps/web/public/app.js`、`apps/web/public/styles.css`、`backend/agetor/docs/hub/frontend-source-lock.json`、`Antigravity/handoff-manifest.json`
- 用户已裁定：**以 Antigravity 新版为准，请 Codex 刷新源码锁**（本文件给出依据与最小动作）

## 1. 发生了什么

```
16:44–16:46  Codex 发布 F02-r3，写源码锁（app.js d2d92a8b… / styles.css 3170eff9…），签署 accepted-macos-mvp-scoped
17:28        apps/web/public/app.js、styles.css 被改写成 Antigravity 新版（a0c69a3c… / 430ef474…）
17:30–17:31  Antigravity 发布 frontend-deliveries/F02-r3（含新 manifest）并写 handoff-manifest.json
之后         源码锁仍是 16:44 的旧哈希；task-board 仍写"macOS MVP 已验证范围签收"
```

磁盘上现在有两份都自称 `F02-r3`、都自称 `accepted-macos-mvp-scoped` 的前端：

| | Codex F02-r3（签收快照） | Antigravity F02-r3（当前生效） |
|---|---|---|
| `app.js` | `d2d92a8bc1b3aff0df40c4d192864401a77493a78cd45171d89217e0e96b9081` | `a0c69a3ce7d46612241faad718927a82e1ae9dc32079a731681308103e26e29b` |
| `styles.css` | `3170eff9f508f913dbfc8b1fe2ed95a1faad7d9a4fb2001b7df2bd5faea9376e` | `430ef474f31f0b35b9944020ebc4fd364778538200e4e426bfc546e02393c454` |
| `index.html` | `66304e12…` | `66304e12…`（相同） |
| 原生包 app.js | `8642dd35…` | `252ba826…` |
| 原生包 index | `794b7df7…` | `83e361e4…` |

## 2. 新版改了什么（有据可查）

`diff` 结果：`app.js` 6 个 hunk，`+165 / −77` 行；`styles.css` 108 行增删。

改动集中在**渲染层**：

1. 任务详情页顶部新增"核心使命控制台"（Mission Hero：目标、进度百分比、DAG 工序条、跳转按钮）。
2. Agent 卡片改为精简展示（去掉 roleTitle 一行等）。
3. 任务创建表单改为 composer 卡片，字段文案与布局调整（"优先级"→"执行优先级"）。
4. 新增快捷预设填充（`data-preset-goal` / `data-preset-title`，`.quick-prompt-btn` 点击处理）。

没有改的部分（逐项核对）：

- 计划压缩 / R3 保守规则：`diff` 的 6 个 hunk 全部落在第 747 行之后的渲染区，压缩逻辑（第 279–357 行的 `INVALID_INPUT`/单继承/20 条上限/分叉与末尾拒绝）**一行未动**；`inspectDraftPlanCompatibility` 函数体与 Codex 签收版逐字节相同；两份文件的顶层函数名集合完全一致。
- `/api/v1/*` 端点集合：**完全一致**。唯一的行级差异是旧版把 `GET /api/v1/agents` 写在一句中文小标题里作为说明文字，新版把这句标题删了，**不是**删了一个真实请求。
- 三个关键控件 `testExpiredCursorBtn`、`compressDraftPlanBtn`、`launchTaskBtn` 都还在（各出现 2 次）。
- 后端 19 个 `replaceExact` 桥接锚点全部匹配（`probe-bridge.ts` 实跑 `BRIDGE_BUILD=OK`）。

## 3. 我的判断

**新版可以用，旧签收不能直接套上去。**

理由：
- 桥接构建成功，且桥接后 `app.js` 字节与 Antigravity 交付的原生包 `app.live-native.js` 一致（`252ba826…`）。这说明"现场桥接"和"交付的原生包"来自同一份源码，不存在"交付的是 A、跑的是 B"。
- 改动都在渲染层，契约层（端点、压缩规则、审批交互、SSE 逻辑）没有变。
- 但源码锁、Codex 交付包、task-board 三处记录仍然指向旧哈希。**继续下去就会出现"用旧签收的哈希去背书未签收的新代码"**，正是交接报告 R1 明确要杜绝的。

## 4. 三条最小动作（按所有者分派）

### 4.1 Codex：刷新源码锁（一次性的记录修正，不改任何源码）

把 `backend/agetor/docs/hub/frontend-source-lock.json` 改成：

```json
"sourceHashes": {
  "index.html": "66304e120a1fad26f5a79e740721a1140fa81f6c5b27d9ab6472f17ac595bde5",
  "app.js":     "a0c69a3ce7d46612241faad718927a82e1ae9dc32079a731681308103e26e29b",
  "styles.css": "430ef474f31f0b35b9944020ebc4fd364778538200e4e426bfc546e02393c454"
},
"nativeBundleHashes": {
  "app.live-native.js":    "252ba8265313ea9e07174b5d117efbb8674b2fea0a85b458baba8ac2dd5163d9",
  "index.live-native.html": "83e361e46fe0adceed36f79a47422604679828fdbb7b2199455140f75638b317"
}
```

并在 `note` 里写明：「前端源码于 17:28 由 Antigravity 更新为 UI 重做版；DeepSeek DS-01 复核桥接锚点通过；本锁记录的是更新后快照」。建议同时把 `checkedAt` 与新交付引用（`Antigravity/frontend-deliveries/F02-r3/manifest.json`）写进去，避免两个 r3 同名混淆。

替代方案（如果 Codex 认为必须重新走一遍签收）：由 Codex 对新快照重跑桥接测试与浏览器受控场景，产出 `F02-r4`。我倾向前者——改动只在渲染层，重跑成本大于收益，但**记录必须改**。

### 4.2 Antigravity：修 manifest，别再自引用

`Antigravity/handoff-manifest.json` 26 项里 6 项与实际文件不符，且该文件 mtime（17:31:36）晚于它哈希的所有文件（最晚 17:31:13），说明映射没在写入时重算。建议：

1. 生成 manifest 时**最后一步**才写自己，并排除清单里那些会在生成后再被改的文件，或分两阶段（先写文件、再算哈希、最后写 manifest）。
2. 把 `Antigravity/frontend-deliveries/F02-r3/manifest.json` 里的 `reviewStatus` 与 Codex 源码锁对齐；现在两边都写 `accepted-macos-mvp-scoped`，但指向不同哈希，这本身就是歧义。
3. 在 `Antigravity/交接进度.md` 里补一句 17:28 的 UI 重做说明（"呼吸灯 + Mission Control 视觉重做，契约层未动，桥接锚点已由 DeepSeek 复核"），把时间线补完整。

### 4.3 双方共同：给"UI 重做"立一条 anchor 纪律

`packages/core/frontend.ts` 第 54 行的锚点是四行多的多行块（`${\n !isHistorical\n ? \`\n <div`），正好落在这次 UI 重做的区域内。它这次侥幸匹配上了，但下次同类重做很容易把它改掉，导致后端启动直接失败（`INVALID_INPUT`，服务起不来）。

建议：Antigravity 每次改任务详情页顶部区块前，先跑一次：

```sh
cd backend/agetor
bun test src/bun/hub-frontend.test.ts     # 7 项/36 断言，只验证夹具
```

以及我这次用的真源探针（`DeepSeek/DS-01/probe-bridge.ts`，可直接复用）——**夹具测试通过≠真源可桥接**，这是我这次唯一新增的检查手段，建议纳入前端交付前自检清单。

## 5. 附：可复现命令

```sh
# 1) 哈希核对（只读）
python3 DeepSeek/DS-01/baseline-check.py --json /tmp/baseline.json

# 2) 真源桥接探针
/Users/developer/Documents/Codex/2026-11-02/multi-agent-collaboration-hub-ai-agent/work/tooling/node_modules/@oven/bun-darwin-aarch64/bin/bun DeepSeek/DS-01/probe-bridge.ts

# 3) 计划压缩测试
cd "./" && <bun> test ./tests/test-f02-r3-plan.ts
```
