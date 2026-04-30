#!/bin/bash
# ============================================================
# Moss QQ Bot — 停止脚本
# 用法: bash scripts/stop.sh
# ============================================================
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PID_FILE="$PROJECT_DIR/logs/bot.pid"

if [ ! -f "$PID_FILE" ]; then
  echo "[stop] 未找到 PID 文件，bot 可能未运行"
  exit 0
fi

PID=$(cat "$PID_FILE")

if kill -0 "$PID" 2>/dev/null; then
  echo "[stop] 正在停止 bot (PID: $PID)..."
  kill "$PID"

  # 等待最多 10 秒
  for i in $(seq 1 10); do
    if ! kill -0 "$PID" 2>/dev/null; then
      echo "[stop] bot 已停止"
      rm -f "$PID_FILE"
      exit 0
    fi
    sleep 1
  done

  echo "[stop] 强制终止..."
  kill -9 "$PID" 2>/dev/null || true
  rm -f "$PID_FILE"
  echo "[stop] bot 已强制停止"
else
  echo "[stop] PID $PID 对应进程不存在，清理 PID 文件"
  rm -f "$PID_FILE"
fi
