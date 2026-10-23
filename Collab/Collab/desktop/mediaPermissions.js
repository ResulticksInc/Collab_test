// Who may use the camera, microphone and screen capture in the desktop shell.
//
// Electron denies every permission request unless the main process answers one,
// so this is the whole policy. It is deliberately small and pure (no electron
// import) so it can be unit-tested — a mistake here either breaks sign-in or
// hands the camera to whatever page happens to be loaded.
//
// THE RULE
//   • camera / microphone — our own app origin, plus the SSO/IdP origins the app
//     already trusts to run the sign-in flow IN-WINDOW (cfg.authOrigins). An IdP
//     that verifies a face needs getUserMedia; refusing it is what produced
//     "Camera permission was blocked" in the desktop app while the identical
//     flow worked in a browser.
//     A frame EMBEDDED in one of those trusted pages gets the same answer. Face
//     verification widgets are routinely served from a second host inside an
//     <iframe allow="camera">; a browser lets the embedding page delegate the
//     camera to it, and so do we — the trusted page chose to embed it. The
//     requester's own origin is still what matters when it is the top frame.
//   • screen capture — our own origin ONLY, and only from the top frame. An
//     identity provider has no legitimate reason to record the user's screen,
//     and no sign-in flow needs it, so this stays exactly as narrow as it was.
//   • everything else on the allow-list (fullscreen, clipboard, notifications)
//     — unchanged, granted to any page we are willing to load.
//   • anything not on the allow-list — denied.

const ALLOWED = new Set([
  "media",
  "mediaKeySystem",
  "display-capture",
  "notifications",
  "fullscreen",
  "pointerLock",
  "clipboard-read",
  "clipboard-sanitized-write",
]);

// Camera + microphone. `mediaKeySystem` (EME) is grouped here because it is
// origin-sensitive for the same reason, not because it touches a device.
const CAMERA_MIC = new Set(["media", "mediaKeySystem"]);
const SCREEN_CAPTURE = new Set(["display-capture"]);

function toOrigin(value) {
  const s = String(value || "").trim();
  if (!s) return "";
  try {
    return new URL(s).origin;
  } catch {
    return "";
  }
}

/**
 * Build the permission gate.
 *
 * @param {object} opts
 * @param {string} opts.appOrigin        the hosted Collab origin (cfg.origin)
 * @param {string[]} [opts.authOrigins]  SSO/IdP origins allowed in-window
 * @returns {{ grant: (permission: string, url: string, ctx?: { topUrl?: string }) => boolean,
 *             cameraOrigins: string[] }}
 */
function createPermissionGate({ appOrigin, authOrigins } = {}) {
  const app = toOrigin(appOrigin);
  // An unparseable app origin must not become "" and then match every page whose
  // origin also fails to parse ("null" origins, file://, about:blank).
  const cameraOrigins = new Set();
  if (app) cameraOrigins.add(app);
  for (const o of authOrigins || []) {
    const origin = toOrigin(o);
    if (origin) cameraOrigins.add(origin);
  }

  return {
    cameraOrigins: [...cameraOrigins],
    /**
     * @param {string} permission  Electron permission name
     * @param {string} url         URL (or origin) of the frame asking
     * @param {{ topUrl?: string }} [ctx]
     *   topUrl — URL of the top-level page the asking frame lives in. Only
     *   consulted for camera/mic, and only when the asking frame itself is not
     *   trusted (i.e. a sub-frame embedded by a trusted page).
     */
    grant(permission, url, ctx) {
      if (!ALLOWED.has(permission)) return false;
      const origin = toOrigin(url);
      if (!origin) return !CAMERA_MIC.has(permission) && !SCREEN_CAPTURE.has(permission);
      if (SCREEN_CAPTURE.has(permission)) return !!app && origin === app;
      if (CAMERA_MIC.has(permission)) {
        if (cameraOrigins.has(origin)) return true;
        const top = toOrigin(ctx && ctx.topUrl);
        return !!top && top !== origin && cameraOrigins.has(top);
      }
      return true;
    },
  };
}

module.exports = { createPermissionGate, ALLOWED, CAMERA_MIC, SCREEN_CAPTURE, toOrigin };
