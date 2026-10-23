# CoLab WebRTC Calls & Video Root Cause Analysis (RCA)

**Target Environment:** `collab-uat.resulticks.com` (`http://10.200.3.64:7524` / `34.73.179.104`)  
**Symptom:** *"Couldn't reach the media server — usually a network or firewall issue. Check your connection or switch networks, then Retry."*  
**Date:** 2026-08-24  
**Framework:** Ponytail Senior Dev Mode (Trace real flow end-to-end → Root Cause, not symptom)

---

## 1. Executive Summary

Audio and video calls failed during WebRTC ICE connection establishment. While HTTP/WebSocket signalling on `https://collab-uat.resulticks.com/livekit` is functional, **WebRTC media (audio/video RTP packets) had zero reachable endpoints** due to three compounding misconfigurations:
1. **Wrong LiveKit SFU IP:** LiveKit advertised `node_ip: 10.205.11.8` (stale test server IP) instead of `10.200.3.64`.
2. **Non-Existent TURN Domain:** `.env.teams` pointed to `turn.collab-uat.resulticks.com` which does not exist in DNS (`NXDOMAIN`).
3. **Missing TURN Peer Whitelist:** `turnserver.conf` did not permit relaying to the `10.200.3.64` SFU.

---

## 2. End-to-End WebRTC Flow & Failure Points

```
[Browser / Client]
       │
       ├─ 1. HTTPS / REST API (/api/calls/token) ───► [Backend:4000] ──► Returns JWT + wsUrl + iceServers
       │
       ├─ 2. WebSocket Signalling (wss://collab-uat.resulticks.com/livekit) ──► [Nginx / LB] ──► [LiveKit:7534] (SUCCESS: 200/400)
       │
       ▼ 3. WebRTC Media ICE Candidate Negotiation (FAILURE):
       │
       ├─ Path A: Direct LAN Connection (node_ip)
       │    └── Client attempts UDP to 10.205.11.8:7532 ──► [FAILED: Wrong Host IP]
       │
       └─ Path B: NAT Traversal Relay (TURN)
            └── Client resolves turn.collab-uat.resulticks.com ──► [FAILED: DNS NXDOMAIN]
```

---

## 3. Detailed Root Causes & Evidence

### Root Cause 1: Stale Media IP in `livekit.test.yaml`
- **Location:** `infrastructure/livekit/livekit.test.yaml:16`
- **Before:** `node_ip: 10.205.11.8`
- **Impact:** LiveKit generated host candidates with IP `10.205.11.8`. Client browsers on the LAN attempted to route audio/video packets to `10.205.11.8:7532`, which timed out because the actual server is `10.200.3.64`.
- **Fix:** Updated `node_ip: 10.200.3.64`.

### Root Cause 2: Dead TURN Domain in `.env.teams`
- **Location:** `.env.teams:67`
- **Before:** `TURN_URLS=turn:turn.collab-uat.resulticks.com:3479...`
- **Evidence:**
  ```bash
  $ nslookup turn.collab-uat.resulticks.com
  ** server can't find turn.collab-uat.resulticks.com: NXDOMAIN
  ```
- **Impact:** When direct LAN media failed (e.g. for off-VPN / remote users), the browser tried to fall back to the TURN relay, but DNS resolution failed completely.
- **Fix:** Switched to the active production TURN relay:
  ```env
  TURN_URLS=turn:turncollab.resulticks.com:3478?transport=udp,turn:turncollab.resulticks.com:3478?transport=tcp,turns:turncollab.resulticks.com:5349?transport=tcp,turns:turncollab.resulticks.com:443?transport=tcp
  ```
  *(Verified: `turncollab.resulticks.com` resolves to `34.74.165.103` on ports 3478/5349/443).*

### Root Cause 3: Missing Allowed Peer in `turnserver.conf`
- **Location:** `infrastructure/coturn/turnserver.conf:100`
- **Impact:** Coturn blocks RFC1918 private subnets by default to prevent open relay abuse. Without an explicit `allowed-peer-ip=10.200.3.64`, the relay refused to forward media packets to the LiveKit SFU.
- **Fix:** Added `allowed-peer-ip=10.200.3.64`.

---

## 4. Operational Requirements (Infra & Firewall)

For calls to succeed across all networks:

| Traffic Type | Destination | Protocol / Port | Purpose | Requirement |
|---|---|---|---|---|
| **Web & Signalling** | `collab-uat.resulticks.com` | `TCP 443` / `TCP 7524` | HTTPS & WSS Signalling | **MANDATORY** |
| **LAN WebRTC Media** | `10.200.3.64` | `UDP 7532` & `TCP 7531` | Direct Audio/Video Media | **MANDATORY on LAN/VPN** |
| **External TURN Relay**| `turncollab.resulticks.com` (`34.74.165.103`) | `UDP 3478`, `TCP 5349` | Off-network / Remote calls | **MANDATORY for WFH/Off-VPN** |

---

## 5. Verification Checklist

1. [x] LiveKit configured with `node_ip: 10.200.3.64`.
2. [x] LiveKit service restarted and broadcasting `nodeIP: 10.200.3.64`.
3. [x] Signalling verified via `curl https://collab-uat.resulticks.com/livekit/rtc/v1/validate` (HTTP 400 join_request is required).
4. [x] Working TURN relay `turncollab.resulticks.com` configured in `.env.teams`.
5. [x] Coturn peer ACL whitelists `10.200.3.64`.
