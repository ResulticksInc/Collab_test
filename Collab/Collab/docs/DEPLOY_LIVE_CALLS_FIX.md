# Live deploy — calls/meetings media fix (collab.resulticks.com, local DB)

**One line:** calls were failing on the **media plane**, not signalling. Signalling
(`wss://…/livekit`) is healthy — LiveKit answers the public validate probe with its
own `400 join_request is required`. The failure is **ICE/DTLS**: the SFU advertises
the internal `node_ip 10.200.3.17`, which off-LAN/external clients can't reach, and
there was **no working TURN relay** to bridge them, so media DTLS times out
(`dtls timeout: context deadline exceeded`). That's why it "works for some, fails for
others, drops mid-call" — it depends entirely on whether the client's network can
reach the SFU's media path.

This bundle fixes the in-repo half. **Internal LAN/VPN calls work from the bundle
alone.** **External/internet calls additionally need the box-side infra in the Ops
checklist below** (a public IP, DNS, TLS cert, open ports) — no zip can contain those.

---

## What changed in this bundle

| File | Change | Why |
|---|---|---|
| `infrastructure/coturn/turnserver.conf` | `use-auth-secret` → **`lt-cred-mech` + static `user=collab-turn:…`**, realm `collab.resulticks.com`, **`allowed-peer-ip=10.200.3.17`** before the RFC1918 deny, cert paths, 443 listener | The backend sends **static** TURN creds (`livekitService.ts`) — the old ephemeral/HMAC mode rejected them (401 → no relay). And the `10.0.0.0/8` deny was blocking coturn from relaying to the SFU. |
| `docker-compose.live.yml` | **Added the `coturn` service** (host networking, certs mount, `--external-ip/--relay-ip=${COTURN_PUBLIC_IP}` via command args) | coturn existed only in the base compose; the live stack ran **zero relay**, so external clients had no fallback. |
| `.env.live` | Added **`COTURN_PUBLIC_IP`**; reordered `TURN_URLS` to lead with `turns:5349` + `turn:3478` (443 last, best-effort); bumped **`LIVEKIT_TOKEN_TTL_SEC` 3600 → 43200** | Public-IP for relay candidates; reliable TURN baseline first; long meetings no longer hit 1-hour token expiry. |
| `infrastructure/coturn/certs/` | New dir (`.gitignore` + `README`) | Bind-mount target for the TURN TLS cert; real keys never committed. |
| `frontend/app/src/lib/api.ts` | A transient `401` now **re-validates via `/auth/me`** before logging out (was: logout on *any* 401) | Fixes "unexpected logouts" during calls on flaky networks — a blip/restart no longer dumps users to the sign-in screen. |
| `infrastructure/livekit/livekit.live.yaml` | **Unchanged** (deliberately) | `node_ip 10.200.3.17` / `use_external_ip false` is correct for the internal plane; flipping it would break internal media. External is solved by coturn, not the SFU. |

LiveKit `node_ip 10.200.3.17` keeps internal clients on a **direct** path; external
clients fall back to the **coturn relay**, which (running on the same box) reaches the
SFU over the LAN. Two unreachable halves bridged by one server that can reach both.

---

## Ops checklist — REQUIRED before external/internet calls work

Internal LAN/VPN calls need none of this. External calls need **all** of it (these are
box/network actions no bundle can perform):

1. **Public IP / DNAT** — confirm the box has a genuinely internet-routable IPv4 (or a
   1:1 DNAT) for TURN. *If `10.200.3.17` is its only address with no public mapping,
   external TURN is physically impossible — escalate to the network team first.*
2. **Set `COTURN_PUBLIC_IP`** in `.env.live` to that public IPv4 (replace
   `REPLACE_WITH_PUBLIC_IPv4`). coturn fails loudly with the placeholder — by design.
3. **DNS** — create `turncollab.resulticks.com` → that public IP (a **separate** A
   record from `collab.resulticks.com`; it points at the box/its NAT, **not** the app LB).
4. **TLS cert** for `turncollab.resulticks.com` — drop `fullchain.pem` + `privkey.key`
   into `infrastructure/coturn/certs/` on the box. Without it `turns:5349/443` fail TLS
   and only plain `turn:3478` works (blocked on TLS-only egress).
5. **Open inbound** on the public IP: `3478/udp+tcp`, `5349/udp+tcp`, and the relay
   range **`49152-65535/udp`** (the actual media flows here — mandatory). Keep the
   SFU media ports open too: `7531/tcp`, `7532/udp`, `7533/udp`.
6. **Port-443 decision** — does the corporate/Google-Cloud LB own public 443 for this
   host? **If yes:** remove the `turns:…:443` entry from `TURN_URLS` in `.env.live`
   **and** comment `alt-tls-listening-port=443` in `turnserver.conf` (`5349`+`3478`
   still work). **If a separate public IP can give coturn its own 443:** open
   `443/udp+tcp` to coturn and keep it.

---

## Deploy (local DB profile — `DB_PROFILE=local`, bundled MySQL container)

```bash
# from the bundle root, on the live box:
docker compose --env-file .env.live -f docker-compose.live.yml up -d --build

# if you only changed TURN_URLS / coturn afterward, also restart backend so the new
# ICE list is minted into call tokens (config is read once at startup):
docker compose --env-file .env.live -f docker-compose.live.yml up -d backend coturn
```

---

## Verify (run on the live box)

```bash
# 1. compose resolves incl. coturn
docker compose --env-file .env.live -f docker-compose.live.yml config >/dev/null && echo COMPOSE_OK

# 2. coturn is up and parsed its public IP (NO 'cannot parse external-ip' = placeholder left in)
docker logs --tail=50 colab-coturn

# 3. coturn is listening on the host (network_mode: host)
ss -lunp | grep -E ':3478|:5349' ; ss -ltnp | grep -E ':3478|:5349|:443'

# 4. DNS + TLS for the TURN host
getent hosts turncollab.resulticks.com    # → COTURN_PUBLIC_IP (not the app LB, not 10.200.3.17)
echo | openssl s_client -connect turncollab.resulticks.com:5349 -servername turncollab.resulticks.com 2>/dev/null | openssl x509 -noout -subject -dates

# 5. static auth + a relay allocation to the SFU succeeds (proves the auth-mode + peer-ACL fixes)
docker exec colab-coturn turnutils_uclient -v -y -u collab-turn -w '8V$kR2!mQ9#zL4@xT7^nP1&cY6*Wj3HgF5sD' -e 10.200.3.17 -p 3478 127.0.0.1

# 6. coturn (on the box) can reach the SFU media ports over the LAN
docker exec colab-coturn sh -c 'nc -vz -u 10.200.3.17 7532; nc -vz 10.200.3.17 7531'

# 7. signalling still healthy (unchanged): LiveKit answers its own 400
curl -sS https://collab.resulticks.com/livekit/rtc/v1/validate -o /dev/null -w '%{http_code}\n'   # expect 400

# 8. END-TO-END (Chrome on a HOME network, NOT VPN): join a call on https://collab.resulticks.com,
#    open chrome://webrtc-internals → the publisher PeerConnection should show a SELECTED candidate
#    pair of type 'relay' and DTLS state 'connected' (no 'dtls timeout'). An internal/VPN client on
#    the same call should show a 'host' (10.200.3.17) pair — confirming internal is unaffected.
```

A green #8 is the definition of done for external calls. Items B/F/G of the broader
enterprise checklist (multi-network matrix, load test, media-failure metrics) remain
ops/test execution work.

---

## Rollback

Calls were already broken for external clients, so this is strictly additive. To revert
the relay: `docker compose -f docker-compose.live.yml stop coturn` and remove the
`turns:`/`turn:` entries from `TURN_URLS` (internal direct calls are unaffected either way).
The `api.ts` 401 change is strictly less aggressive than before; revert by restoring the
single `dispatchEvent` line if desired.
