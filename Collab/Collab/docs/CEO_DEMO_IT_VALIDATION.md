# CoLab Calls/Meetings — IT Validation & Root Cause (pre-CEO-demo)

> **⚠️ Historical (pre-demo) record.** The root-cause analysis below (media plane on private `10.200.3.17`) still holds, but the TURN specifics are superseded: the live deploy now uses a **public relay** `turncollab.resulticks.com` → `34.74.165.103`, plain TURN on **port 3478** (not 3479). For current values see `.env.live` + [DEPLOY_PUBLIC_TURN.md](DEPLOY_PUBLIC_TURN.md).

**Bottom line first:** The entire media plane terminates at a **private corporate IP
(`10.200.3.17`)** — both the LiveKit SFU and the TURN relay. That is why
**Office ↔ Office calls work but Office ↔ 4G / home / hotel calls fail.** A client
that is not on the corporate LAN/VPN has **no reachable media endpoint**. This is a
network/topology issue, not an application-layer bug.

---

## The proof (from this repo's config)

| Component | Setting | File |
|---|---|---|
| SFU media IP | `node_ip: 10.200.3.17` (private), `use_external_ip: false` | [livekit.live.yaml:15](../infrastructure/livekit/livekit.live.yaml#L15) |
| SFU RTC ports | UDP **7532**, TCP **7531**, built-in TURN UDP **7533** | [livekit.live.yaml:11](../infrastructure/livekit/livekit.live.yaml#L11) |
| coturn relay/external IP | `COTURN_PUBLIC_IP=10.200.3.17` (private) | `.env.live` (~L105) |
| coturn ports | UDP/TCP **3478**, TLS **5349**, alt-TLS **443** | [turnserver.conf:27](../infrastructure/coturn/turnserver.conf#L27) |
| coturn relays only to SFU | `allowed-peer-ip=10.200.3.17 / 10.205.11.8` | [turnserver.conf:95](../infrastructure/coturn/turnserver.conf#L95) |

The `.env.live` file says it outright:
> "This box has NO public IP … coturn relays at the server's REAL LAN IP 10.200.3.17 …
> True public-internet clients would need a SEPARATELY-hosted public TURN; this internal
> box can't serve them."

So: **TURN is internal-only.** Internal TURN = Office only. You need **public TURN** (or a
public SFU IP) for Office / Home / 4G / Hotel / Client network.

> ⚠️ Port note: coturn listens on **3478** (see turnserver.conf). Verify
> the right port.

---

## The decision you must make today

1. **Best:** Give the SFU box (or a small separate VM) a **public IPv4 + DNS + TLS cert**,
   run **coturn there** with `external-ip = <public IP>`, open **3478/3479 UDP+TCP, 5349 TLS,
   443 TLS**, and point `TURN_URLS` / `COTURN_PUBLIC_IP` at it. Then it works anywhere.
2. **Fallback if no public IP by tomorrow:** Run the CEO demo with **all participants on the
   corporate LAN/VPN** (where 10.200.3.17 is reachable) — it already works there. Do **not**
   attempt an off-network/4G participant; it will fail, and now you know exactly why.

---

## Your 7 IT-verification questions — answered + what to check on the box

**Q1. Office ↔ Office, 5-min video call?** → Expected to PASS today (both reach `10.200.3.17`).
If it fails, signalling/TLS/SFU startup is broken — check `docker logs colab-livekit`, `colab-nginx`.

**Q2. Office ↔ Mobile 4G, 5-min call?** → Expected to FAIL with current config (4G can't reach
`10.200.3.17`). This is the real test and the gate for "any network."

**Q3. Is TURN reachable externally?** Test from OUTSIDE the corporate network:
```bash
# UDP/TCP relay + TLS — run from a non-corporate machine (or 4G hotspot laptop):
nc -vzu turncollab.resulticks.com 3479      # UDP 3479
nc -vz  turncollab.resulticks.com 3479      # TCP 3479
nc -vz  turncollab.resulticks.com 5349      # TLS 5349
nc -vz  turncollab.resulticks.com 443       # alt-TLS 443
# Authoritative relay-allocation test:
turnutils_uclient -v -t -u collab-turn -w '<TURN_PASSWORD>' turncollab.resulticks.com -p 3479
```
If these fail from outside → TURN is not public-facing (today's state).

**Q4. Is LiveKit advertising the correct IP?** It advertises `node_ip = 10.200.3.17` (private).
Confirm: `docker exec colab-livekit cat /etc/livekit.yaml | grep -E 'node_ip|use_external_ip'`.
For public reach this must be a **public IP** (and `use_external_ip` strategy reconsidered).

**Q5. Are UDP media ports open?** SFU needs **7532/udp** (and 7531/tcp, 7533/udp) reachable by
clients. `nc -vzu <server> 7532`. On the corporate net only today.

**Q6. Public TURN or internal-only?** → **INTERNAL ONLY.** (relay IP = `10.200.3.17`, private).
This is the single most important finding. Internal TURN cannot serve 4G/home/hotel.

**Q7. (implicit) Firewall / reachability:** Whatever public endpoint you choose (SFU or TURN)
must have its ports open inbound from the public internet, not just the corp LAN.

---

## Use the new in-app diagnostics to confirm in 10 seconds (no guessing)

This build adds a **WebRTC debug panel** + structured **console logging** to both calls and
meetings (additive only — no change to signalling/tokens/LiveKit).

**Enable the panel on staging/prod (no rebuild):** in the browser console run
`localStorage.setItem('colab_call_debug','1')` then reload — or append `?calldebug=1` to the URL.
(In dev it's always on, bottom-left of the call/meeting.)

It shows live: **ICE state, selected candidate (host/srflx/relay), TURN used?, TURN advertised?,
latency, packet loss, throughput**, plus an event log and a **Copy** button.

**Console trail** — filter DevTools console by `CALLDIAG`. You'll see, e.g.:
```
[CALLDIAG ab12cd] Token Generated turnAdvertised=false iceServers=0
[CALLDIAG ab12cd] Room Join Attempt ...
[CALLDIAG ab12cd] Room Joined ...
[CALLDIAG ab12cd] ICE Failed hint="no relay candidate — NO TURN advertised by token (cross-network calls will fail)"
```
That one line tells you whether it's a TURN/relay problem — exactly the diagnosis that was
missing. On an Office↔4G test, expect either `turnAdvertised=false` or `TURN used? no` →
confirms the private-IP media plane.

**For the CEO demo:** keep the panel open on one machine. If a call drops, you (and IT) see
`ICE Failed → no relay candidate` instead of a shrug — and you can recover gracefully (the app
now auto-rejoins twice before showing an honest, network-specific message).

---

## What changed in the app (client-side, this build)

- **P0 Diagnostics logging** — full lifecycle trail (`Token Generated`, `Room Join Attempt`,
  `Room Joined`, `ICE Connected/Failed`, `Track Published/Subscribed`, `Participant Disconnected`,
  `Media Error`) with TURN/relay hints, in calls **and** meetings.
- **P0 WebRTC debug panel** — `CallDebugPanel`, dev always / staging-prod opt-in.
- **P1 Graceful failure UX** — replaced "media server error" with honest, network/TURN-specific
  messages (e.g. "no TURN relay was available — try another network or ask IT to enable public TURN").
- **P1 Automatic rejoin** — bounded (2×) auto-reconnect (reusing the existing retry path) before
  surfacing failure.

No signalling, token, or LiveKit-integration code was changed.
