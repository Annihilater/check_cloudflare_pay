#!/usr/bin/env bash
# 查看服务状态
# 用法: ./scripts/status.sh

set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

pid="$(find_pid)"
if is_pid_running "$pid"; then
  echo "状态: 运行中"
  echo "PID:  $pid"
  echo "端口: $PORT"
  echo "地址: http://127.0.0.1:${PORT}"
  echo "日志: $LOG_FILE"
  if curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/api/scan/status" >/tmp/cf_pay_status.json 2>/dev/null; then
    if command -v python3 >/dev/null 2>&1; then
      python3 - <<'PY'
import json
with open("/tmp/cf_pay_status.json") as f:
    d = json.load(f)
p = d.get("progress") or {}
print(f"扫描: {d.get('status')}")
print(f"进度: {p.get('checked', 0)} / {p.get('total', 0)}")
print(f"可用: {p.get('available', 0)}  占用: {p.get('taken', 0)}  错误: {p.get('errors', 0)}")
if p.get("rate_per_sec") is not None:
    print(f"速率: {p.get('rate_per_sec'):.2f}/s")
PY
    else
      echo "API:  $(cat /tmp/cf_pay_status.json)"
    fi
  else
    echo "API:  无响应"
  fi
  exit 0
fi

echo "状态: 未运行"
echo "启动: ./scripts/start.sh"
exit 1
