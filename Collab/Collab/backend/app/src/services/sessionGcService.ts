import { db } from "../platform";
import { disconnectSession, sessionHasLiveSocket } from "../realtime/socket";

// ── Session GC (Session Management Phase 5) ─────────────────────────────────
// Periodic housekeeping over auth_sessions, run from the server tick loop:
//
//   • EXPIRE — revoke sessions past their expires_at. They're already 401'd on
//     the next REST request by the #66 check, but the GC reclaims the row and
//     cuts any lingering live socket so a walked-away device stops receiving
//     realtime events the moment its window closes.
//
//   • IDLE — enforce each org's idle_timeout_min (configured in Phase 4): revoke
//     sessions whose last REST activity is older than the org's window and
//     invalidate their still-valid tokens. SAFE by design — a session that still
//     has a LIVE socket is skipped (a connected / in-call user is not idle), so
//     the sweep only reclaims genuinely-abandoned sessions and never boots an
//     actively-connected device. Strict "sign out even open-but-idle tabs" is a
//     client-enforced concern; this is the server-side safety net.
//
// Everything is best-effort and bounded — a DB/socket hiccup on one row must
// never abort the sweep or affect live traffic.
export async function sweepSessions(io: any): Promise<{ expired: number; idle: number }> {
  let expired = 0;
  let idle = 0;

  // 1) Expired sessions — revoke + disconnect.
  try {
    const jtis = await db.sessions.listExpiredActive(500);
    for (const jti of jtis || []) {
      try {
        const did = await db.sessions.revokeById(jti);
        if (did) {
          void disconnectSession(io, jti, "expired");
          expired++;
        }
      } catch (_) {
        /* per-row best-effort */
      }
    }
  } catch (e: any) {
    console.warn("[session-gc] expired sweep failed:", e?.message || e);
  }

  // 2) Idle sessions beyond their org policy — skip any still holding a socket.
  try {
    const jtis = await db.sessions.listIdleBeyondOrgPolicy(500);
    for (const jti of jtis || []) {
      try {
        if (await sessionHasLiveSocket(io, jti)) continue; // connected → not idle
        const did = await db.sessions.revokeById(jti);
        if (did) {
          void disconnectSession(io, jti, "idle");
          idle++;
        }
      } catch (_) {
        /* per-row best-effort */
      }
    }
  } catch (e: any) {
    console.warn("[session-gc] idle sweep failed:", e?.message || e);
  }

  // 3) Housekeeping: drop refresh tokens well past expiry (Phase 5). Never affects
  //    live auth — these rows are already unusable; this just keeps the table small.
  try {
    if (db.refreshTokens && db.refreshTokens.purgeExpired) {
      const r = await db.refreshTokens.purgeExpired(7);
      if (r && r.purged) console.log(`[session-gc] purged ${r.purged} expired refresh token(s)`);
    }
  } catch (e: any) {
    console.warn("[session-gc] refresh-token purge failed:", e?.message || e);
  }

  // 4) Mobile push K4 sweep: retire push_devices rows not seen for 60 days
  //    (wiped / reinstalled / lost phones). Once a day is plenty.
  try {
    const days = Math.max(1, Number(process.env.PUSH_DEVICE_STALE_DAYS) || 60);
    if (db.pushDevices?.sweepStale && Date.now() - lastDeviceSweepAt > DEVICE_SWEEP_EVERY_MS) {
      lastDeviceSweepAt = Date.now();
      const n = await db.pushDevices.sweepStale(days);
      if (n) console.log(`[session-gc] retired ${n} stale push device(s) (> ${days}d)`);
    }
  } catch (e: any) {
    console.warn("[session-gc] push device sweep failed:", e?.message || e);
  }

  return { expired, idle };
}
const DEVICE_SWEEP_EVERY_MS = 24 * 60 * 60 * 1000;
let lastDeviceSweepAt = 0;
