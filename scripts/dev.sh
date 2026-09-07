#!/usr/bin/env bash
# Recite dev: FastAPI backend + Vite dev server, opens the browser once.
set -euo pipefail
cd "$(dirname "$0")/.."

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
export PYTHONPATH=backend
PORT="${RECITE_PORT:-8744}"
cleanup() { kill 0 }
trap cleanup EXIT

(cd backend && .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port "$PORT" --log-level warning) &
API=$!

(cd frontend && [ -d node_modules ] || npm install --silent) || true
if [ ! -d frontend/node_modules ]; then
  echo "frontend deps missing — run: cd frontend && npm install"
  kill $API 2>/dev/null || true; exit 1
fi
(cd frontend && npm run dev -- --port 5173 --strictPort) &
WEB=$!

sleep 1
echo "Recite → http://localhost:5173"
[ "${RECITE_NO_OPEN:-}" = "" ] && (sleep 1; open "http://localhost:5173" 2>/dev/null) || true
wait
