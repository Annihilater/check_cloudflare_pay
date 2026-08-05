#!/usr/bin/env bash
# 公共变量与函数

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

APP_NAME="check_cloudflare_pay"
BIN="$ROOT_DIR/target/release/$APP_NAME"
RUN_DIR="$ROOT_DIR/.run"
PID_FILE="$RUN_DIR/$APP_NAME.pid"
LOG_FILE="$RUN_DIR/$APP_NAME.log"
PORT="${PORT:-8787}"

mkdir -p "$RUN_DIR"

is_pid_running() {
  local pid="${1:-}"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

read_pid() {
  if [[ -f "$PID_FILE" ]]; then
    tr -d '[:space:]' <"$PID_FILE" || true
  fi
}

# 通过 PID 文件或端口查找进程
find_pid() {
  local pid
  pid="$(read_pid)"
  if is_pid_running "$pid"; then
    echo "$pid"
    return 0
  fi

  # 兼容：进程还在但 PID 文件丢失
  if command -v lsof >/dev/null 2>&1; then
    lsof -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -n1 || true
    return 0
  fi
  echo ""
}

is_running() {
  local pid
  pid="$(find_pid)"
  is_pid_running "$pid"
}

wait_http() {
  local url="http://127.0.0.1:${PORT}/api/scan/status"
  local i
  for i in $(seq 1 30); do
    if curl -fsS --max-time 1 "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.2
  done
  return 1
}
