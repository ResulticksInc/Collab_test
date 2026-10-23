// Shared CORS origin policy for both the HTTP API (Express) and realtime
// (Socket.IO). Allows the configured allowlist exactly, PLUS any
// localhost / 127.0.0.1 / ::1 origin on any port.
//
// Why the localhost allowance: the realtime WebSocket handshake is origin-
// checked with credentials, so a trivial dev-origin difference — `localhost`
// vs `127.0.0.1`, `:3000` vs `:3002`, or `next start` vs `next dev` — would
// otherwise REJECT the handshake. With no client-side error handler that
// failure is silent, and the UI ends up updating only on a manual refresh
// (HTTP keeps working, the socket never connects). Accepting any localhost
// origin removes that entire class of failure for local dev/demo.
//
// It is safe: a request carrying a localhost Origin can only come from the
// same machine, never from a remote attacker hitting a production domain —
// production browsers send the real domain Origin, which must still be in the
// configured allowlist.
type OriginCb = (err: Error | null, allow?: boolean) => void;

// A loopback or RFC1918 private-network host. Such an origin can only be loaded
// from the same machine or the same LAN — never by a remote internet attacker
// hitting a production domain — so reflecting it is safe and makes local/LAN
// demos work on any port without per-host config. Public production browsers
// send the real domain Origin, which must still be in the configured allowlist.
// Loopback (same-machine) — always safe to reflect.
function isLoopbackHost(host: string): boolean {
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host.endsWith(".localhost")
  );
}
// RFC1918 private-LAN ranges.
function isPrivateLanHost(host: string): boolean {
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true; // 10.0.0.0/8
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true; // 192.168.0.0/16
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host)) return true; // 172.16.0.0/12
  return false;
}
// AUDIT P3 (#52): in PRODUCTION, blanket-reflecting every RFC1918 origin with
// credentials effectively disables CORS across the corporate LAN the app runs on
// (any intranet page / rogue device becomes a trusted origin). So private-range
// reflection is allowed only in non-production, OR when an operator explicitly
// opts in (CORS_ALLOW_PRIVATE=true) for a legitimate on-prem LAN deployment.
// Loopback stays allowed everywhere (it can only come from the same machine).
const ALLOW_PRIVATE_LAN =
  process.env.NODE_ENV !== "production" ||
  /^(1|true|yes|on)$/i.test(process.env.CORS_ALLOW_PRIVATE || "");

export function corsOrigin(allowed: string[]) {
  const set = new Set(allowed || []);
  return (origin: string | undefined, cb: OriginCb) => {
    // Non-browser clients / same-origin requests send no Origin header.
    if (!origin) return cb(null, true);
    if (set.has(origin)) return cb(null, true);
    try {
      const host = new URL(origin).hostname;
      if (isLoopbackHost(host)) return cb(null, true);
      if (ALLOW_PRIVATE_LAN && isPrivateLanHost(host)) return cb(null, true);
    } catch {
      /* malformed Origin → fall through to deny */
    }
    return cb(new Error("Not allowed by CORS"));
  };
}
