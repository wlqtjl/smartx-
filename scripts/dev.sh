#!/usr/bin/env bash
# 同时启动服务端与客户端（开发模式）。
#
# 使用方法：
#   ./scripts/dev.sh          # 默认端口（server 8787, client 5173）
#   SMARTX_PORT=9001 ./scripts/dev.sh
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

: "${SMARTX_PORT:=8787}"

echo "[dev] starting server on :${SMARTX_PORT}"
(cd "${ROOT}/server" && SMARTX_PORT="${SMARTX_PORT}" npm run dev) &
SERVER_PID=$!

cleanup() {
  echo "[dev] stopping (server pid=${SERVER_PID})"
  kill "${SERVER_PID}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "[dev] starting client (Vite)"
export VITE_SMARTX_API="http://localhost:${SMARTX_PORT}"
(cd "${ROOT}/client" && npm run dev)
