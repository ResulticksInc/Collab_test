import { api } from "./api";
import config from "./config";
import { log } from "./logger";

// Tracks whether this browser session has a valid, server-confirmed push
// subscription for the CURRENT user. Reset on logout so that the next
// user who logs in on the same browser registers their own subscription.
let registered = false;
let registeredToken = "";
// Once we learn push is unavailable (no VAPID key on the server, or the browser
// can't subscribe), latch it so the ~6 registerPush() call sites never retry —
// otherwise every boot/permission-grant/reconnect re-hits /push/vapid-key and
// spams the server (and previously, the diagnostics panel). Reset on logout.
let pushUnavailable = false;

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// True when an existing PushSubscription was created with `vapidKey`. Browsers
// that don't expose options.applicationServerKey are treated as matching (we
// can't tell, and needlessly resubscribing would churn endpoints).
function sameServerKey(sub: PushSubscription, vapidKey: string): boolean {
  try {
    const current = sub.options && sub.options.applicationServerKey;
    if (!current) return true;
    const a = new Uint8Array(current as ArrayBuffer);
    const b = urlBase64ToUint8Array(vapidKey);
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  } catch (_) {
    return true;
  }
}

export async function registerPush(token: string): Promise<boolean> {
  // Known-unavailable this session → never retry (graceful degradation).
  if (pushUnavailable) return false;
  // Re-register if token changed (different user logged in without page reload)
  if (registered && registeredToken === token) return true;
  if (typeof window === "undefined") return false;
  if (!("serviceWorker" in navigator)) {
    console.warn("[push] Service Workers not supported");
    return false;
  }
  if (!("PushManager" in window)) {
    console.warn("[push] Push API not supported");
    return false;
  }
  if (typeof Notification === "undefined" || Notification.permission !== "granted") {
    return false;
  }

  try {
    const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    await navigator.serviceWorker.ready;

    let vapidKey = config.vapidPublicKey;
    if (!vapidKey) {
      const vapidRes = await api.getVapidKey(token).catch(() => null);
      vapidKey = vapidRes?.publicKey || "";
    }
    if (!vapidKey) {
      // Server has no VAPID configured (or unreachable). Disable push for the
      // whole session and log ONCE, dev-only — never a user-facing error.
      pushUnavailable = true;
      // ONE console line in every environment (never a user-facing error). This
      // state used to be logged dev-only, which made "service worker registered
      // but no push subscription" impossible to diagnose on a deployed site.
      console.warn(
        "[push] Background notifications are OFF: the server returned no VAPID key " +
          "(VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are not set in the backend container). " +
          "Notifications will only appear while a tab is open.",
      );
      if (process.env.NODE_ENV !== "production") {
        log.info("app", "Push notifications unavailable — server not configured; disabled for this session.");
      }
      return false;
    }

    let sub = await reg.pushManager.getSubscription();
    // A subscription is bound to the VAPID key it was created with. If the
    // deployment's key changed (rotated, or a different env file), the old
    // subscription still "exists" but every push to it is rejected by the push
    // service — a silent, permanent failure. Detect the mismatch and resubscribe.
    if (sub && !sameServerKey(sub, vapidKey)) {
      const staleEndpoint = sub.endpoint;
      try { await sub.unsubscribe(); } catch (_) {}
      await api.pushUnsubscribe(token, staleEndpoint).catch(() => {});
      sub = null;
    }
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey) as BufferSource,
      });
    }

    await api.pushSubscribe(token, sub.toJSON());
    registered = true;
    registeredToken = token;
    console.log("[push] Push subscription confirmed for this user");
    return true;
  } catch (err) {
    // Chrome/Edge disable the push service in a private/incognito window, so
    // pushManager.subscribe() rejects there even though everything else works.
    // That is expected, not a fault: log it as such so it doesn't read as a
    // broken app in the console (this was reported as "errors in incognito").
    // Push is the only degraded feature; the app is fully functional without it.
    const name = (err as any)?.name || "";
    if (name === "AbortError" || name === "NotAllowedError" || name === "NotSupportedError") {
      console.info(
        "[push] Background notifications aren't available in this browser session " +
          "(private windows disable them). Everything else works normally.",
      );
    } else {
      console.warn("[push] Registration failed:", err);
    }
    return false;
  }
}

// Call on logout so the next user re-registers their own subscription.
// Also clears the unavailable-latch so a different server/deploy is re-probed.
export function resetPushRegistration(): void {
  registered = false;
  registeredToken = "";
  pushUnavailable = false;
}

export async function unregisterPush(token: string): Promise<void> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    const endpoint = sub.endpoint;
    await sub.unsubscribe();
    await api.pushUnsubscribe(token, endpoint).catch(() => {});
    registered = false;
    registeredToken = "";
  } catch (_) {}
}
