#!/bin/bash
# ============================================================
# OpenCode QQ Bot — 后台启动脚本
# 用法: bash scripts/start-bg.sh
# 日志: logs/opencode-qq-bot.log (自动轮转，保留最近10个)
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LOG_DIR="$PROJECT_DIR/logs"

# 确保日志目录存在
mkdir -p "$LOG_DIR"

# 日志文件（按日期）
DATE=$(date +%Y%m%d)
LOG_FILE="$LOG_DIR/bot-$DATE.log"
PID_FILE="$LOG_DIR/bot.pid"

# 检查是否已在运行
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo "[start-bg] bot 已在运行 (PID: $OLD_PID)"
    exit 0
  fi
  rm -f "$PID_FILE"
fi

# 检查 opencode serve 是否可用
if [ -n "${OPENCODE_BASE_URL:-}" ]; then
  echo "[start-bg] 使用外部 opencode: $OPENCODE_BASE_URL"
else
  echo "[start-bg] 使用嵌入式 opencode（自动启动）"
fi

# 后台启动
cd "$PROJECT_DIR"

# 添加 bun 到 PATH
export PATH="$HOME/.bun/bin:$HOME/.opencode/bin:$PATH"

nohup bun run src/index.ts >> "$LOG_FILE" 2>&1 &
BOT_PID=$!
echo $BOT_PID > "$PID_FILE"

echo "[start-bg] bot 已启动 (PID: $BOT_PID)"
echo "[start-bg] 日志文件: $LOG_FILE"
echo "[start-bg] 查看日志: tail -f $LOG_FILE"
echo "[start-bg] 停止: kill $BOT_PID 或 bash scripts/stop.sh"

# 保留最近 10 个日志文件
ls -t "$LOG_DIR"/bot-*.log 2>/dev/null | tail -n +11 | xargs -r rm -f
