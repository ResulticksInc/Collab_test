#!/usr/bin/env bash
# Generate the RSA key pair CoLab uses to DECRYPT the encrypted PII claims
# (`claims_jwe`) the AgenXchange IdP places in the SSO id_token. See docs/SSO.md.
#
#   keys/collab_private.pem      -> stays on the CoLab server (SSO_JWE_PRIVATE_KEY_FILE
#                                    or inline SSO_JWE_PRIVATE_KEY). NEVER commit.
#   keys/agenxchange_public.pem  -> hand to the AgenXchange team; they encrypt with it.
#
# Usage: scripts/gen-sso-keys.sh [out-dir]   (default: ./keys)
set -euo pipefail
OUT="${1:-$(cd "$(dirname "$0")/.." && pwd)/keys}"
mkdir -p "$OUT"
if [ -f "$OUT/collab_private.pem" ]; then
  echo "gen-sso-keys: $OUT/collab_private.pem already exists — refusing to overwrite." >&2
  echo "              Delete it first if you really want a NEW pair (the IdP must then be re-registered with the new public key)." >&2
  exit 1
fi
openssl genrsa -out "$OUT/collab_private.pem" 2048
openssl rsa -in "$OUT/collab_private.pem" -pubout -out "$OUT/agenxchange_public.pem"
chmod 600 "$OUT/collab_private.pem"
echo "gen-sso-keys: wrote $OUT/collab_private.pem (keep secret) and $OUT/agenxchange_public.pem (share with AgenXchange)."
