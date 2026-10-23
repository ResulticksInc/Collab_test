#!/usr/bin/env bash
# Switch the active environment profile by copying .env.<profile> to .env.
# Usage (from repo root):  ./scripts/use-profile.sh local|teams|live
set -e
p="${1:-}"
case "$p" in
  local|teams|live) ;;
  *) echo "Usage: $0 local|teams|live"; exit 1 ;;
esac
src=".env.$p"
[ -f "$src" ] || { echo "Missing $src (run from the repo root)"; exit 1; }
cp "$src" .env
echo "Active profile -> $p   (.env  <-  $src)"
# Show the key facts of what you just switched to.
for k in PUBLIC_HOST FRONTEND_PORT DB_PROFILE DATABASE_URL LIVEKIT_WS_URL; do
  line=$(grep -m1 "^$k=" .env || true)
  [ -n "$line" ] && echo "  $line"
done
grep -qE 'REPLACE_WITH|CHANGE_ME' .env && echo "!  Fill the REPLACE_WITH_*/CHANGE_ME_* values in .env before deploying (see docs/ENV_PROFILES.md)." || true
