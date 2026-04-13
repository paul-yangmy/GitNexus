#!/bin/sh
set -eu

cleanup() {
  if [ -n "${BACKEND_PID:-}" ]; then
    kill "$BACKEND_PID" 2>/dev/null || true
    wait "$BACKEND_PID" 2>/dev/null || true
  fi
}

trap cleanup INT TERM EXIT

cd /app/gitnexus
npm run serve -- --host 0.0.0.0 --port 4747 &
BACKEND_PID=$!

cd /app/gitnexus-web
exec npm run dev -- --host 0.0.0.0 --port 5173
