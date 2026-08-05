#!/usr/bin/env bash
# 停止扫描服务
# 用法: ./scripts/stop.sh [--force]

set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force|-f) FORCE=1 ;;
    -h|--help)
      cat <<'EOF'
用法: ./scripts/stop.sh [选项]

  --force, -f   直接 SIGKILL
  -h, --help    显示帮助
EOF
      exit 0
      ;;
    *)
      echo "未知参数: $arg" >&2
      exit 1
      ;;
  esac
done

pid="$(find_pid)"
if ! is_pid_running "$pid"; then
  rm -f "$PID_FILE"
  # 再清一遍端口占用（非本项目进程则只提示）
  if command -v lsof >/dev/null 2>&1; then
    extra="$(lsof -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
    if [[ -n "$extra" ]]; then
      echo "PID 文件无进程，但端口 $PORT 仍被占用: $extra"
      echo "如需强制结束: kill $extra"
      exit 1
    fi
  fi
  echo "未在运行"
  exit 0
fi

echo "停止进程 pid=$pid …"
if [[ "$FORCE" -eq 1 ]]; then
  kill -9 "$pid" 2>/dev/null || true
else
  kill "$pid" 2>/dev/null || true
  # 等待优雅退出
  for _ in $(seq 1 20); do
    if ! is_pid_running "$pid"; then
      break
    fi
    sleep 0.15
  done
  if is_pid_running "$pid"; then
    echo "优雅退出超时，发送 SIGKILL…"
    kill -9 "$pid" 2>/dev/null || true
  fi
fi

rm -f "$PID_FILE"
echo "已停止"
