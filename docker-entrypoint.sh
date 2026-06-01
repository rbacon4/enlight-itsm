#!/bin/bash
# Production entrypoint for the single-container Enlight deployment.
#  1. Applies pending database migrations (idempotent — safe to run every start).
#  2. Starts the API and the BullMQ worker together, and exits (so the
#     orchestrator restarts the container) if either process dies.
set -euo pipefail

if [ -z "${DATABASE_URL:-}" ]; then
  echo "FATAL: DATABASE_URL is not set." >&2
  exit 1
fi

echo "[entrypoint] Applying database migrations…"
node /app/packages/api/dist/db/migrate.js

echo "[entrypoint] Starting API (port ${PORT:-3000}) and worker…"
node /app/packages/api/dist/index.js &
API_PID=$!
node /app/packages/worker/dist/packages/worker/src/index.js &
WORKER_PID=$!

# Optionally start the MCP HTTP server (set MCP_ENABLED=true to enable).
MCP_PID=""
if [ "${MCP_ENABLED:-false}" = "true" ]; then
  echo "[entrypoint] Starting MCP server (port ${MCP_PORT:-3001})…"
  node /app/packages/mcp/dist/index.js &
  MCP_PID=$!
fi

# Forward termination to all children for graceful shutdown.
ALL_PIDS="$API_PID $WORKER_PID${MCP_PID:+ $MCP_PID}"
term() {
  echo "[entrypoint] Shutting down…"
  # shellcheck disable=SC2086
  kill -TERM $ALL_PIDS 2>/dev/null || true
  wait "$API_PID" "$WORKER_PID" 2>/dev/null || true
  exit 0
}
trap term TERM INT

# If any process exits, stop the others so the container restarts cleanly.
wait -n
echo "[entrypoint] A process exited — stopping the container." >&2
# shellcheck disable=SC2086
kill -TERM $ALL_PIDS 2>/dev/null || true
exit 1
