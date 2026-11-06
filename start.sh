#!/usr/bin/env bash
# ==============================================================================
# Multi-Agent Collaboration Hub (Agent Router) — 一键开箱即用启动脚本
# ==============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "================================================================================"
echo "🤖 正在启动 Multi-Agent Collaboration Hub (多智能体协作调度大屏)..."
echo "================================================================================"

# 1. 检查运行环境 (Bun 推荐，Node.js 兼容)
BUN_BIN=""
if command -v bun &> /dev/null; then
  BUN_BIN="$(command -v bun)"
elif [ -f "$HOME/.bun/bin/bun" ]; then
  BUN_BIN="$HOME/.bun/bin/bun"
elif [ -f "/opt/homebrew/bin/bun" ]; then
  BUN_BIN="/opt/homebrew/bin/bun"
elif [ -f "/usr/local/bin/bun" ]; then
  BUN_BIN="/usr/local/bin/bun"
fi

if [ -z "$BUN_BIN" ]; then
  echo "❌ 未检测到 Bun 运行环境。"
  echo "💡 建议运行一键安装命令: curl -fsSL https://bun.sh/install | bash"
  exit 1
fi

echo "✔ 检测到引擎环境: $BUN_BIN ($($BUN_BIN --version))"

# 2. 检查环境变量配置
if [ ! -f ".env.local" ]; then
  echo "ℹ️  未检测到 .env.local 文件，将以零配置【演示模式 (Mock Mode)】开箱启动。"
  echo "💡 如需接入真实的 DeepSeek / Gemini / Codex / WorkBuddy，请复制 .env.example 为 .env.local 并填入密钥。"
else
  echo "✔ 检测到 .env.local，已自动挂载实机模型凭证。"
fi

# 3. 启动 Hub 调度服务端
exec "$BUN_BIN" backend/agetor/scripts/start-hub.ts config/hub-config.json
