#!/usr/bin/env bash
# Start backend + frontend together (dev). Requires: npm install at repo root.
set -e
cd "$(dirname "$0")/.."
npm run dev
