# Call connect fast path (backend)

Response to "Collab calls: backend changes for faster connect" (mobile team, 22 Oct 2026).
Target: audio within ~2 s of the answer. Everything below is in the backend; nothing in the
mobile app has to change for it to ship, but the app can start using the new fields.

## What changed

| # (PDF) | Ask | Done | Where |
|---|---|---|---|
| 1 | Callee's LiveKit token in the call push | Yes. `call_incoming` now carries `livekitToken` + `wsUrl` (FCM `data` on Android, VoIP payload on iOS). Web push leg strips both. | `realtime/socket.ts` `calleeJoinCredentials`, `services/mobilePushService.ts`, `services/webPushService.ts` |
| 1 | ...or return it from the REST accept | Yes. `POST /api/calls/direct/:id/accept` returns `{ call, token, wsUrl, room, role, iceServers }`. | `routes/calls.ts` |
| 2 | Stop ending live calls on a stale socket | Yes. On a last-socket disconnect the server waits `CALL_DISCONNECT_GRACE_MS` (10 s), re-checks for a live socket cluster-wide, and for a connected call also checks the `call_<id>` SFU room. An adapter error now skips the hang-up and logs instead of failing toward "last socket". | `realtime/socket.ts` disconnect handler |
| 2 | Reap dead sockets faster | Yes. `pingInterval` 5 s / `pingTimeout` 10 s (env `SOCKET_PING_INTERVAL_MS`, `SOCKET_PING_TIMEOUT_MS`). | `realtime/socket.ts`, `config/src/index.ts` |
| 3 | Media server + API near the users | Not a code change. See "Infrastructure" below. | — |
| 4 | `call:request`: emit first, reap after | Yes. Socket emits (`call:incoming`, `call:ringing`) happen before any push work. The ghost-call reap no longer runs on every call: the atomic request is tried first and the reap (now parallel for both parties) runs only when the busy check trips, then the request is retried once. The two user reads run alongside the atomic insert; the membership and block reads run in parallel. | `services/callService.ts`, `realtime/socket.ts` |
| 4 | `call:accept`: fewer DB round trips | Yes. Accept is one guarded `UPDATE ... WHERE status='ringing' AND peer_id=?` + one read (was read + write + read). Also serialises two concurrent accepts. | `database/src/drivers/mysql.ts` `calls.transitionIf`, `services/callService.ts` |
| 4 | `POST /api/calls/token`: one query for three reads | Mostly. The host check reuses the call row already fetched (no second `getById`), the profile read overlaps the membership read, and the `fresh` eviction (a LiveKit API round trip) is no longer awaited. | `routes/calls.ts` |
| 5 | Cheaper socket handshake | Yes. Blocklist + session reads run in parallel, and a positive verdict is cached per token for `SOCKET_AUTH_CACHE_MS` (15 s). Negative verdicts are never cached; a revoke on the node evicts the entry. | `realtime/socket.ts` `io.use` |
| 6 | Don't send the "answered" retract to the device that answered | Yes. The answering session (`jti`) / device id is excluded from `sendCallCancel`; other devices still get it. Covers socket accept, REST accept and the External API accept. | `realtime/socket.ts` `retractRing`, `services/mobilePushService.ts` |
| — | Server-side timings | Yes. One log line each: `[CallTrace:server] call=<id> request→ringing +<ms>`, `accept→accepted +<ms>` (socket), `accept.rest→accepted +<ms>` (REST), `token +<ms>`. Line them up with the app's `[CallTrace]` marks per call id. | all three handlers |

## New push fields (callee only)

```
livekitToken  JWT for room call_<id>, identity = callee, role participant, TTL = LIVEKIT_TOKEN_TTL_SEC (default 3600 s)
wsUrl         signalling URL, derived from the caller's origin the same way /token does it
```

Both are optional: if minting fails, or the FCM message would exceed 4 KB, the push goes out
without them and the app must fall back to `POST /api/calls/token` as today. They are shed
before `targetId`/`senderId`, never instead of them.

## New env knobs (all have defaults; nothing to set)

```
CALL_DISCONNECT_GRACE_MS=10000   # 0 disables the grace re-check
SOCKET_PING_INTERVAL_MS=5000
SOCKET_PING_TIMEOUT_MS=10000
SOCKET_AUTH_CACHE_MS=15000       # 0 disables the handshake cache
```

## Infrastructure (PDF item 3) — the part code cannot fix

The phone measured a 250 ms RTT to the SFU and the API from the users' network. A WebRTC
join is ~10 dependent round trips, so that alone is 2.3–4 s per join; at 50 ms it is under
1 s. The code changes above remove round trips from the signalling path; they cannot shorten
one.

- Run LiveKit (and the API, and the MySQL it talks to) in a region close to the users, or use
  LiveKit Cloud (nearest edge per client).
- TURN: `.env.live` already configures coturn at `turncollab.resulticks.com` with
  `turns:…:443?transport=tcp`, and `roomToken` advertises it in `iceServers`. The phone's
  trace showed `pair=srflx`, i.e. a direct path was available, so TURN was correctly not used.
  Check the TURN host is up in the same region when the SFU moves.
- Quick check before moving anything: from a phone on the users' network, `ping` and a TLS
  handshake to the SFU host and to `collab.resulticks.com`. Above ~100 ms is the problem.

## Tests

- `backend/app/test/calls-signalling.test.ts`: REST accept returns the callee's room token;
  a stale socket's disconnect does not end a call re-joined on a new socket, while a user who
  really leaves still ends it. Needs MySQL (`TEST_DATABASE_URL`).
- `backend/app/test/mobile-push.test.ts`: `livekitToken`/`wsUrl` in the FCM data map and
  the VoIP payload; a cancel never carries one; the token is shed before the routing ids
  when over budget. Pure, no DB.
