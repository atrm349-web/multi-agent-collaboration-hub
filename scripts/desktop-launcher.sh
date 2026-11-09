#!/usr/bin/env bash
# ==============================================================================
# Agent Router 桌面双击启动脚本 (支持无缝拉起与浏览器自动打开)
# ==============================================================================

PROJECT_DIR="/Users/anyunhong/Desktop/集合agent"
cd "$PROJECT_DIR"
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

# 1. 检查当前服务健康状态
HEALTH=$(curl -s -m 1 http://127.0.0.1:4321/api/v1/health 2>/dev/null || true)

if [[ "$HEALTH" != *"ok"* ]]; then
  # 如果 4321 端口有无响应的进程，先优雅清理
  lsof -ti :4321 | xargs kill -9 2>/dev/null || true
  sleep 0.3
  # 后台启动 Hub 服务
  nohup ./start.sh > /tmp/agent-hub.log 2>&1 &
  
  # 最多等待 6 秒直至健康检查通过
  for i in {1..30}; do
    sleep 0.2
    HEALTH=$(curl -s -m 1 http://127.0.0.1:4321/api/v1/health 2>/dev/null || true)
    if [[ "$HEALTH" == *"ok"* ]]; then
      break
    fi
  done
fi

# 2. 唤醒默认浏览器直接打开大屏并置于前台
open "http://127.0.0.1:4321"
osascript -e 'display notification "🚀 Multi-Agent 协同大屏已启动并在浏览器就绪！" with title "Agent Router"' 2>/dev/null || true
