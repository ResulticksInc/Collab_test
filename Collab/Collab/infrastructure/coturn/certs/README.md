# coturn TLS certs

Drop the TLS material for the TURN server here, on the live box, before
`docker compose -f docker-compose.live.yml up -d coturn`:

- `fullchain.pem` — full certificate chain
- `privkey.key`   — private key (coturn reads PEM content regardless of the `.key` extension)

These MUST be valid for **turncollab.resulticks.com** (the host advertised in
`TURN_URLS` in `.env.live`). turns:5349 (and optional turns:443) fail the TLS
handshake without them, leaving only plain `turn:3478` — which is blocked on
TLS-only / 443-only egress.

The container reads them at `/etc/coturn/certs/{fullchain.pem,privkey.key}`
(see `cert=`/`pkey=` in `../turnserver.conf`). Never commit real keys — the
`.gitignore` in this directory blocks `*.pem`, `*.crt`, and `*.key`.
