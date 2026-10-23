// ─────────────────────────────────────────────────────────────────────────────
// Auth-token store shim — ONE place that decides WHERE the auth tokens live.
//
//   • WEB: localStorage (unchanged — the same "clb_token" / "clb_refresh" keys, so
//          the web flow is byte-for-byte unaffected).
//   • DESKTOP: prefers the OS keychain via Electron `safeStorage` (DPAPI / Keychain /
//          libsecret) exposed by preload as `collabDesktop.secureStore`, so tokens
//          are encrypted at rest instead of plaintext localStorage. Falls back to
//          localStorage when the keychain is unavailable, so login NEVER breaks.
//
// AUDIT #16: the 30-day REFRESH token (a long-lived credential) is now keychain-
// backed on desktop too — previously it was plaintext localStorage only. The keyed
// secure store (`secureStore.keyed`) gives it its own OS-encrypted slot. On an OLDER
// desktop shell that lacks the keyed API, the refresh token transparently falls back
// to localStorage (current behaviour) — the version-skew window never corrupts the
// store. The keychain is async, so an in-memory cache serves the SYNCHRONOUS refresh
// path (a 401 renews without awaiting IPC); it's hydrated on boot by loadToken().
// ─────────────────────────────────────────────────────────────────────────────

import { isDesktopApp } from "./platform";

const TOKEN_KEY = "clb_token";
const REFRESH_KEY = "clb_refresh";

type SecureStore = {
  keyed?: boolean;
  get: (key?: string) => Promise<{ available: boolean; value: string | null }>;
  set: (a?: string, b?: string) => Promise<{ available: boolean; ok: boolean }>;
  clear: (key?: string) => Promise<{ available: boolean; ok: boolean }>;
};

function secure(): SecureStore | null {
  if (!isDesktopApp || typeof window === "undefined") return null;
  const cd = (window as unknown as { collabDesktop?: { secureStore?: SecureStore } })
    .collabDesktop;
  return cd && cd.secureStore && typeof cd.secureStore.get === "function"
    ? cd.secureStore
    : null;
}

// Keyed-aware wrappers. On a NEWER shell (secureStore.keyed) each secret has its own
// encrypted slot; on an OLDER shell only the access token is keychain-backed via the
// legacy keyless signature, and any other key reports "unavailable" so the caller
// falls back to localStorage. This keeps the version-skew window safe.
function kGet(s: SecureStore, key: string) {
  if (s.keyed) return s.get(key);
  return key === "authToken"
    ? s.get()
    : Promise.resolve({ available: false, value: null });
}
function kSet(s: SecureStore, key: string, value: string) {
  if (s.keyed) return s.set(key, value);
  return key === "authToken"
    ? s.set(value)
    : Promise.resolve({ available: false, ok: false });
}
function kClear(s: SecureStore, key: string) {
  if (s.keyed) return s.clear(key);
  return s.clear(); // legacy clear == authToken only
}

function lsGet(k: string): string | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage.getItem(k) : null;
  } catch {
    return null;
  }
}
function lsSet(k: string, v: string) {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(k, v);
  } catch {
    /* private mode / quota — non-fatal */
  }
}
function lsClear(k: string) {
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(k);
  } catch {
    /* non-fatal */
  }
}

// ── Access token ─────────────────────────────────────────────────────────────
// Kept behaviour: the plaintext localStorage MIRROR stays (synchronous readers —
// telemetry, raw fetch helpers — depend on it), so the access token's storage is
// unchanged. It's short-lived + rotating; the refresh token is the sensitive one.

export async function loadToken(): Promise<string | null> {
  // Hydrate the refresh-token cache in the same boot step (fire-and-forget).
  void loadRefreshToken();
  const s = secure();
  if (s) {
    try {
      const r = await kGet(s, "authToken");
      if (r && r.available) {
        if (r.value) {
          lsSet(TOKEN_KEY, r.value); // keep the sync mirror in step
          return r.value;
        }
        // Keychain available but empty → migrate an existing localStorage token in.
        const legacy = lsGet(TOKEN_KEY);
        if (legacy) {
          try { await kSet(s, "authToken", legacy); } catch { /* best-effort */ }
          return legacy;
        }
        return null;
      }
    } catch {
      /* keychain blip → fall through to localStorage */
    }
  }
  return lsGet(TOKEN_KEY);
}

export async function saveToken(token: string): Promise<void> {
  lsSet(TOKEN_KEY, token); // always keep the sync mirror so existing readers work
  const s = secure();
  if (s) {
    try { await kSet(s, "authToken", token); } catch { /* mirror written → non-fatal */ }
  }
}

export async function clearToken(): Promise<void> {
  lsClear(TOKEN_KEY);
  const s = secure();
  if (s) {
    try { await kClear(s, "authToken"); } catch { /* non-fatal */ }
  }
}

// ── Refresh token (30-day, rotating) ─────────────────────────────────────────
// AUDIT #16: keychain-backed on desktop (its own encrypted slot); localStorage on
// web or an old shell. A synchronous in-memory cache serves the hot 401 path.
let refreshCache: string | null = null;

// Whether the refresh token can go to the keychain on THIS shell (keyed API present).
function refreshUsesKeychain(): SecureStore | null {
  const s = secure();
  return s && s.keyed ? s : null;
}

// Hydrate refreshCache on boot. Keychain shells: read the encrypted slot and migrate
// any legacy plaintext value in (then wipe it from localStorage). Else: localStorage.
export async function loadRefreshToken(): Promise<void> {
  const s = refreshUsesKeychain();
  if (s) {
    try {
      const r = await kGet(s, "refreshToken");
      if (r && r.available) {
        if (r.value) {
          refreshCache = r.value;
          lsClear(REFRESH_KEY); // remove any legacy plaintext copy
          return;
        }
        // Empty keychain slot → migrate a legacy plaintext refresh token in.
        const legacy = lsGet(REFRESH_KEY);
        if (legacy) {
          try { await kSet(s, "refreshToken", legacy); } catch { /* best-effort */ }
          refreshCache = legacy;
          lsClear(REFRESH_KEY);
          return;
        }
        refreshCache = null;
        return;
      }
    } catch {
      /* keychain blip → fall through to localStorage */
    }
  }
  refreshCache = lsGet(REFRESH_KEY);
}

export function getRefreshToken(): string | null {
  // Sync path (401 renew). Prefer the in-memory cache; on web/no-keychain it mirrors
  // localStorage, so a fresh tab that hasn't run loadRefreshToken() still reads it.
  if (refreshCache != null) return refreshCache;
  return lsGet(REFRESH_KEY);
}

export function saveRefreshToken(token: string): void {
  if (!token) return;
  refreshCache = token;
  const s = refreshUsesKeychain();
  if (s) {
    // Keychain shell: encrypt at rest, and DO NOT leave a plaintext copy.
    void kSet(s, "refreshToken", token).catch(() => {});
    lsClear(REFRESH_KEY);
  } else {
    lsSet(REFRESH_KEY, token); // web / old shell → localStorage (unchanged)
  }
}

export function clearRefreshToken(): void {
  refreshCache = null;
  lsClear(REFRESH_KEY);
  const s = refreshUsesKeychain();
  if (s) void kClear(s, "refreshToken").catch(() => {});
}

// ── E2EE history-backup secret (desktop keychain only) ───────────────────────
// The 32-byte recovery secret that opens the user's server-blind history backup
// normally lives in IndexedDB next to the device keys. On DESKTOP that store is
// wiped by a reinstall / "clear app data" while the OS keychain survives — which
// is exactly the case where the restored session has no password in memory and
// used to dead-end on "Message unavailable on this device". Keeping a copy of
// the secret in the keychain (its own OS-encrypted slot, tagged with the user id
// so it can never be applied to a different account) lets the app re-derive the
// backup key and restore the full history with no prompt.
//
// WEB: deliberately a no-op. There is no storage on the web that outlives
// IndexedDB and is safer than it; localStorage would be a downgrade.
const RECOVERY_SLOT = "e2eeRecoverySecret";

export async function saveRecoverySecret(userId: string, secretB64: string): Promise<boolean> {
  const s = refreshUsesKeychain();
  if (!s || !userId || !secretB64) return false;
  try {
    const r = await kSet(s, RECOVERY_SLOT, userId + ":" + secretB64);
    return !!(r && r.available && r.ok);
  } catch {
    return false;
  }
}

/** The stored secret for THIS user, or null (never another user's). */
export async function loadRecoverySecret(userId: string): Promise<string | null> {
  const s = refreshUsesKeychain();
  if (!s || !userId) return null;
  try {
    const r = await kGet(s, RECOVERY_SLOT);
    if (!r || !r.available || !r.value) return null;
    const i = r.value.indexOf(":");
    if (i <= 0) return null;
    return r.value.slice(0, i) === userId ? r.value.slice(i + 1) : null;
  } catch {
    return null;
  }
}

export async function clearRecoverySecret(): Promise<void> {
  const s = refreshUsesKeychain();
  if (!s) return;
  try { await kClear(s, RECOVERY_SLOT); } catch { /* non-fatal */ }
}
