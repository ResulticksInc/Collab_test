#!/usr/bin/env bash
# Apply migrations + seed (postgres). For DATABASE_DRIVER=memory these are no-ops/in-process.
set -e
cd "$(dirname "$0")/.."
node database/src/migrate.js
node database/src/seed.js
