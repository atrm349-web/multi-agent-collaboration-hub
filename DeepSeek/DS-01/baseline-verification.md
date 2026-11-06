# DS-01 基线哈希核对报告

- 核对方：DeepSeek
- 核对时间：2026-11-03T11:11Z–11:25Z（本地 20:11–20:25 +09:00）
- 核对对象：`./` 当前磁盘内容
- 可复现脚本：`baseline-check.py`（只读）；原始结果：`evidence/baseline.json`
- 结论口径：**只写本次实查到的数据**。交接报告里的历史数字（413/134 项等）本轮未复跑，不作为本轮结论。

## 1. 后端基线（可信）

```sh
git -C backend/agetor rev-parse HEAD            # 9f56aa45219df6544a7d2a62177a16ce78aa9a20
git -C backend/agetor rev-parse --abbrev-ref HEAD # codex/b04-b06-local-platform
git -C backend/agetor status --porcelain        #  M docs/hub/frontend-source-lock.json
```

与交接报告第 9 节完全一致：HEAD 相同，唯一工作区改动就是源码锁本身。

源码锁 6 个后端关键文件（`backendHashes`）：

| 文件 | SHA-256 | 结果 |
|---|---|---|
| `packages/core/frontend.ts` | `5c954b12…b54ec` | ✅ |
| `packages/core/http.ts` | `336d38d2…db6bc` | ✅ |
| `packages/core/hub.ts` | `c78178d2…196b0` | ✅ |
| `packages/core/quality.ts` | `469f5e9b…6e87` | ✅ |
| `packages/core/workspace.ts` | `11f34351…9836` | ✅ |
| `scripts/start-hub.ts` | `875fed68…ef8211` | ✅ |

另外记录（本轮源码锁内没有、但后续 DS-02/DS-03 会引用）：

| 文件 | SHA-256 |
|---|---|
| `packages/core/planner.ts` | `c842383550f99380863373af3bf254bd1548e6d82f13628032e60b4e3b3802eb` |
| `packages/core/state/store.ts` | `b21814047834379982eadf46d65c1c22c41b07a0f4014524d44ab745ad260812` |
| `packages/core/state/durable-codex.ts` | `d45e454b9aaa0add7d48aaa13e0d3cf3c7fc54dfb9b8896411fd946fbabb3b88` |
| `src/bun/agents.ts` | `38d8862370e12e81337933dcaeebebae826cbea59dd82489d3e757f26921a6f4` |

## 2. 前端基线（漂移，见 frontend-drift.md）

| 文件 | 源码锁记录（Codex 16:44） | 磁盘实际（17:28） | 结果 |
|---|---|---|---|
| `index.html` | `66304e120a1f…95bde5` | `66304e120a1f…95bde5` | ✅ |
| `app.js` | `d2d92a8bc1b3…6b9081` | `a0c69a3ce7d4…6e29b` | ❌ 漂移 |
| `styles.css` | `3170eff9f508…a9376e` | `430ef474f31f…93c454` | ❌ 漂移 |

磁盘实际三文件与 `Antigravity/frontend-deliveries/F02-r3/` **3/3 一致**，即当前生效的是 Antigravity 的新版 F02-r3。

## 3. 桥接兼容性（关键补充检查）

源码锁只能说明"文件变了"，不能说明"还能不能用"。所以我直接跑了一次桥接构建：

```
BRIDGE_BUILD=OK
sourceHashes={app.js a0c69a3c…, index.html 66304e12…, styles.css 430ef474…}
asset /app.js  len=91947  sha256=252ba8265313ea9e07174b5d117efbb8674b2fea0a85b458baba8ac2dd5163d9
asset /styles.css len=31863 sha256=430ef474f31f0b35b9944020ebc4fd364778538200e4e426bfc546e02393c454
```

要点：

1. `buildFrontendAssets` 对当前（新版）前端**全部 `replaceExact` 锚点匹配成功**，没有抛 `INVALID_INPUT`。也就是说后端启动不会因为锚点缺失而失败。
2. 桥接产出的 `app.js` 哈希 `252ba826…` 与 Antigravity manifest 里 `nativeBundleHashes["app.live-native.js"] = 252ba826…` **完全一致**，说明"刷新后的原生包"与"从源码快照现场桥接"得到同一 JS 字节。
3. 桥接产出的 `index.html` 哈希每次不同（本次 `e8b865a0…`，上一次 `32d9f003…`），原因是 `frontend.ts` 每次构建注入随机 nonce。**因此 index 的桥接哈希不能直接和原生包哈希比较，比对只能以 `app.js`/`styles.css` 为准。** 这一点建议写进后续验收口径，否则会反复出现"哈希对不上"的假问题。

## 4. 交付包完整性

| 交付包 | 声明校验文件 | 结果 |
|---|---|---|
| Codex `F02-r3` | `SHA256.json`（27 文件） | **27/27 匹配** |
| Antigravity `handoff-manifest.json` | 自述 26 文件 | **20 匹配 / 6 不一致** |

Antigravity 6 项不一致清单：

| 文件 | manifest 记录 | 磁盘实际 |
|---|---|---|
| `Antigravity/frontend-deliveries/F02-r2/manifest.json` | `b83c0023…` | `8932364f…` |
| `Antigravity/frontend-deliveries/F02-r3/manifest.json` | `85ef0db3…` | `2da49279…` |
| `Antigravity/交接进度.md` | `bfda8a82…` | `f89bb22b…` |
| `apps/web/server.mjs` | `c76a264e…` | `ffe2b5fc…` |
| `docs/task-board.md` | `1e147977…` | `09363589…` |
| `tests/test-f02-r3-plan.ts` | `f90dfd7f…` | `82a4b211…` |

时序证据（`os.stat` 精确 mtime）：

```
17:31:36.310  Antigravity/handoff-manifest.json        ← 最后写入
17:31:13.518  Antigravity/frontend-deliveries/F02-r3/manifest.json
17:19:13.609  apps/web/server.mjs
17:04:01.176  Antigravity/交接进度.md
17:02:05.523  tests/test-f02-r3-plan.ts
16:46:08.094  docs/task-board.md
```

`handoff-manifest.json` 的写入时间晚于它记录的全部文件，但其 `files` 哈希与这些文件的实际内容不符——说明该映射是在更早的快照上算好、之后随文件改动被"整体抬时间戳"的，**不能作为完整性依据**。这不必然是恶意：更可能是先写 manifest、再改文件、最后补 `updatedAt`。但结果一样：它不能用来主张"某份源码被签收"。

## 5. 可运行性核对

环境（`evidence/env-probe.log`）：

| 项 | 值 |
|---|---|
| 主机 | macOS 27.2 (26B123)，Apple M3，8 GB |
| git | 2.54.0 (Apple Git-157) |
| node / bun | v24.21.0 / 1.4.4 |
| Codex CLI | 0.166.0-alpha.5.1，`Logged in using ChatGPT` |
| Chrome | 156.0.8078.80 |
| python3 | 3.9.6 |
| 磁盘 | 50 GiB 可用 |
| 监听 4320/4321 | **无**（仅有 127.0.0.1:49735，即 DeepSeek Harness Web GUI 自身） |

- 交接报告/Antigravity 记录里"UI 在 4320 常驻提供服务"的说法，本次实查**不成立**：4320 无监听。
- 共享后端没有 `node_modules`，机器上也没有可用的 `tsc`，所以 `bun run typecheck` / `typecheck:hub` 本轮**无法复核**，不标通过。

Hub 测试（`src/bun/hub-*.test.ts` 共 8 个文件）：

| 执行环境 | 结果 |
|---|---|
| 受限沙箱（默认） | 81 pass / 2 fail / 422 expect；失败原因：`sandbox-exec: sandbox_apply: Operation not permitted`（嵌套 seatbelt 被外层沙箱拒绝），`codex sandbox` 退出码 71 |
| 完全访问（审批后） | **83 pass / 0 fail / 427 expect / 10.3 s** |

日志：`evidence/hub-suite-full-access.log`。

计划压缩测试（`tests/test-f02-r3-plan.ts`，脚本式，非 bun:test）：7 组检查全部 PASS，见 `evidence/plan-compression.log`。

## 6. 结论

1. **后端基线可信**，可以用 6 文件哈希作为后续 DS-02/DS-03 的对照锚点。
2. **前端基线存在一处真实的、必须处理的分歧**：磁盘上是被 Antigravity 17:28 改写的新版，源码锁与 Codex 交付包记录的是 16:44 的旧版。分歧本身不阻塞运行（桥接验证通过），但**"old 签收直接套在新代码上"这件事已经发生了**，必须由所有者修补记录，而不是由我口头绕过。
3. **Antigravity 的 manifest 不能作为完整性证据**（6/26 不一致 + 时序矛盾）。
4. 环境侧有一条硬约束要提前说清：**任何需要 `codex sandbox` 的验证（注册测试、质量门）在受限沙箱下必然失败**，必须在完全访问审批下执行，或由用户在 Terminal 里执行我给出的脚本。
