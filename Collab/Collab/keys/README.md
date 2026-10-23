# keys/

RSA key pair for the SSO **encrypted PII claims** (`claims_jwe` in the AgenXchange
id_token). Generate with `scripts/gen-sso-keys.sh` (or the two `openssl` commands in
`docs/SSO.md`).

| File | Role |
| --- | --- |
| `collab_private.pem` | Stays on the CoLab server. Point `SSO_JWE_PRIVATE_KEY_FILE` at it (or paste its contents into `SSO_JWE_PRIVATE_KEY`). **Never commit.** |
| `agenxchange_public.pem` | Give to the AgenXchange team. They encrypt the PII with it. |

Both `.pem` files are git-ignored; only this README is tracked.
