# DeepSeek 交付目录（本地镜像）

这里是我（DeepSeek）在 Multi-Agent Collaboration Hub 项目中的全部产出。

**注意：这是本地 workspace 里的镜像目录，不是共享目录。**
共享项目根是 `./`，我的沙箱无法写入，所以按用户确认的方式：我先写在这里，由用户转交。

## 转交方式

把整个 `DeepSeek/` 目录复制到共享根下，保持结构：

```sh
cp -R "/Users/developer/Documents/deepseek-harness/default-workspace/DeepSeek" \
      ".//DeepSeek"
```

之后共享路径为 `集合agent/DeepSeek/…`，本文档里所有 `DS-0x/...` 相对路径都对得上。

## 目录

| 路径 | 内容 |
|---|---|
| `解阻清单.md` | **要继续推进还差你哪三项决定**（额度 / 谁执行 / 谁审批） |
| `交接进度.md` | 进度信箱：状态总览、发现、下一步、证据索引（各方先读这个） |
| `DS-01/README.md` | DS-01 接收记录：我的可执行范围、基线结论、首轮清单、文件分工 |
| `DS-01/baseline-verification.md` | 基线哈希核对报告（后端 6/6、Codex 包 27/27、AG manifest 20/26、测试 83/83） |
| `DS-01/frontend-drift.md` | 前端基线漂移分析与三条最小动作（含可直接粘贴的源码锁新值） |
| `DS-01/给Codex.md` | 给 Codex 的三项请求（刷新源码锁、index 哈希口径、DS-02 环境前提） |
| `DS-01/给Antigravity.md` | 给 Antigravity 的两项请求（重算 manifest、anchor 纪律） |
| `DS-02/验证方案.md` | 真实模型失败与自动返工验证方案（S1 主场景 + S2/S3 补充） |
| `DS-02/S0-offline-loop/` | 离线返工闭环自测（真实控制器/状态机 + 模拟 provider），已通过 |
| `DS-02/S1-auto-rework/` | **可直接执行的 S1 执行包**：临时仓库、owner 验收脚本、配置、驱动、证据（已自测，未消耗额度） |
| `DS-03/验证方案.md` | 中断与恢复验证方案（正常停止 / 控制器崩溃 / 模型进程退出） |
| `DS-03/scenario/` | A/B/C 场景执行包：慢验收脚本、独立 runtime/端口、注入步骤 |
| `DS-03/初步发现-隔离解除无入口.md` | 静态发现：崩溃隔离后没有 HTTP 解除入口（待实测确认） |
| `DS-04/验收矩阵.md` | 10 个端到端场景的证据盘点：哪些是受控证据、哪些是真实模型证据、还缺什么 |
| `DS-05/稳定性测试计划.md` | 本机稳定性有限测试计划（T1–T5，含采样脚本与判据） |
| `DS-05/初步结果-T4-T5.md` | 重启一致性与异常入口的实测结果 + 3 条启动脚本改进建议 |
| `DS-01/evidence/` | 全部原始日志与 `baseline.json` |
| `DS-01/baseline-check.py` | 只读核对脚本，可随时复跑 |
| `DS-01/probe-bridge.ts` | 真源桥接探针（验证 `apps/web/public` 能否被后端桥接） |

## 复跑方式

```sh
# 哈希核对
python3 DeepSeek/DS-01/baseline-check.py --json /tmp/baseline.json

# 真源桥接探针（需要 bun）
BUN=/Users/developer/Documents/Codex/2026-11-02/multi-agent-collaboration-hub-ai-agent/work/tooling/node_modules/@oven/bun-darwin-aarch64/bin/bun
$BUN DeepSeek/DS-01/probe-bridge.ts

# Hub 测试（需要 codex 在 PATH，且需要能嵌套 seatbelt 的环境）
cd backend/agetor
PATH=/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin:$PATH $BUN test \
  src/bun/hub-codex-runtime.test.ts src/bun/hub-durable-codex.test.ts \
  src/bun/hub-frontend.test.ts src/bun/hub-http.test.ts src/bun/hub-planner.test.ts \
  src/bun/hub-service.test.ts src/bun/hub-state-store.test.ts src/bun/hub-workspace.test.ts
```

## 纪律

- 我只写 `DeepSeek/**`，不改 `apps/web/**`、`backend/**`、`docs/**`、`tests/**` 和别人的交付目录。
- 需要跨边界改动时，我提交「复现步骤 + 建议补丁文本 + 证据」，由文件所有者执行。
- 证据里不含 token、凭据或私人配置；启动服务的日志已做脱敏检查。
