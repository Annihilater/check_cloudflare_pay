#!/usr/bin/env bash
# 启动扫描服务（后台）
# 用法: ./scripts/start.sh [--build] [--fg]
#   --build  强制重新编译
#   --fg     前台运行（不写 PID，Ctrl+C 退出）

set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

FORCE_BUILD=0
FOREGROUND=0
for arg in "$@"; do
  case "$arg" in
    --build|-b) FORCE_BUILD=1 ;;
    --fg|--foreground) FOREGROUND=1 ;;
    -h|--help)
      cat <<'EOF'
用法: ./scripts/start.sh [选项]

  --build, -b     强制 cargo build --release
  --fg            前台运行
  -h, --help      显示帮助

环境变量:
  PORT=8787       监听端口
EOF
      exit 0
      ;;
    *)
      echo "未知参数: $arg（用 --help 查看用法）" >&2
      exit 1
      ;;
  esac
done

if is_running; then
  pid="$(find_pid)"
  echo "已在运行 (pid=$pid, port=$PORT)"
  echo "地址: http://127.0.0.1:${PORT}"
  exit 0
fi

# 清理残留 PID
if [[ -f "$PID_FILE" ]]; then
  rm -f "$PID_FILE"
fi

need_build=0
if [[ ! -x "$BIN" ]]; then
  need_build=1
fi
if [[ "$FORCE_BUILD" -eq 1 ]]; then
  need_build=1
fi

if [[ "$need_build" -eq 1 ]]; then
  echo "编译 release 二进制…"
  cargo build --release
fi

export PORT

if [[ "$FOREGROUND" -eq 1 ]]; then
  echo "前台启动: $BIN (PORT=$PORT)"
  echo "地址: http://127.0.0.1:${PORT}"
  exec "$BIN"
fi

echo "后台启动: $BIN (PORT=$PORT)"
nohup "$BIN" >>"$LOG_FILE" 2>&1 &
pid=$!
echo "$pid" >"$PID_FILE"

if wait_http; then
  echo "启动成功 (pid=$pid)"
  echo "地址: http://127.0.0.1:${PORT}"
  echo "日志: $LOG_FILE"
  echo "停止: ./scripts/stop.sh"
else
  echo "进程已启动但健康检查超时 (pid=$pid)，请查看日志:" >&2
  echo "  tail -n 50 $LOG_FILE" >&2
  exit 1
fi
