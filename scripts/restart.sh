#!/usr/bin/env bash
# 重启服务
# 用法: ./scripts/restart.sh [--build]

set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"

"$DIR/stop.sh" || true
exec "$DIR/start.sh" "$@"
