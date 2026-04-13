#!/bin/bash
set -e

echo "[platform] Waiting for PostgreSQL..."
until pg_isready -h "${PGHOST:-postgres}" -p "${PGPORT:-5432}" -U "${PGUSER:-postgres}" -q 2>/dev/null; do
  sleep 1
done
echo "[platform] PostgreSQL is ready."

echo "[platform] Initializing database schema..."
node -e "import('./dist/server/platform/index.js').then(m => m.initializePlatform()).then(() => { console.log('[platform] DB ready'); process.exit(0); })"

echo "[platform] Starting API server..."
exec node dist/cli/index.js serve --host 0.0.0.0 --port ${PORT:-4747}
