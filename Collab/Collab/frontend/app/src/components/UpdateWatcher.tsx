import React, { useCallback, useEffect, useRef, useState } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// UpdateWatcher — bring a freshly deployed frontend build into an already-open
// session WITHOUT the user having to hard-refresh.
//
// Context: the HTML shell is served `no-cache, must-revalidate` and every Next.js
// chunk is content-hashed, so a new deploy is ALWAYS picked up on the next full
// page load — a browser refresh/revisit, or a desktop app relaunch (the desktop
// shell just loads the live URL). The ONE gap is a tab/window left open for a long
// time: it keeps running the build it loaded with until something reloads it.
//
// This watcher closes that gap. It notes the build id the page loaded with, polls
// the deployed build id (on an interval, on focus, and when the tab becomes
// visible), and when they differ it:
//   1. shows a subtle, dismissible "A new version is available — Refresh" banner, and
//   2. auto-refreshes at the next SAFE moment — when the user returns to a tab that
//      had been hidden and is NOT in a call or meeting — so the update lands on its
//      own without interrupting anything or discarding a message being typed.
//
// Safety: it never acts unless this page actually carries a build id (so a login
// redirect or a build-id-less response can't trigger a false reload), and after a
// reload the new page's id matches the server's, so there is no reload loop. While
// the user is actively looking at the screen it only ever shows the banner — the
// silent reload is reserved for the away-then-return, idle case.
// ─────────────────────────────────────────────────────────────────────────────

const POLL_MS = 5 * 60 * 1000; // every 5 min, plus focus + visibility triggers
const FIRST_CHECK_MS = 15000; // let the app settle before the first check

function ownBuildId(): string | null {
  try {
    return (window as any).__NEXT_DATA__?.buildId || null;
  } catch {
    return null;
  }
}

async function fetchDeployedBuildId(): Promise<string | null> {
  try {
    const res = await fetch("/", { cache: "no-store", credentials: "same-origin" });
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(/"buildId":"(.*?)"/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export default function UpdateWatcher({
  busy,
  notify = true,
}: {
  busy: boolean;
  notify?: boolean;
}) {
  const [ready, setReady] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const mine = useRef<string | null>(null);
  const readyRef = useRef(false);
  const busyRef = useRef(busy);
  const hiddenAt = useRef(0); // ms timestamp the tab was last hidden (0 = visible)
  const lastCheck = useRef(0);
  readyRef.current = ready;
  busyRef.current = busy;

  // Only auto-swap the build after a genuine absence, so a quick alt-tab while
  // composing a message can't reload out from under a draft.
  const AWAY_MS = 60000;

  useEffect(() => {
    mine.current = ownBuildId();
  }, []);

  const check = useCallback(async () => {
    // Never act on a page that has no build id of its own — that's the only way a
    // stray/redirected response could look like a "new build" and loop us.
    if (!mine.current || readyRef.current) return;
    // Throttle: focus fires often; don't refetch the shell more than once per 30s.
    const now = Date.now();
    if (now - lastCheck.current < 30000) return;
    lastCheck.current = now;
    const server = await fetchDeployedBuildId();
    if (server && server !== mine.current) setReady(true);
  }, []);

  useEffect(() => {
    const iv = setInterval(check, POLL_MS);
    const first = setTimeout(check, FIRST_CHECK_MS);
    const onFocus = () => check();
    const onVis = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt.current = Date.now();
        return;
      }
      // Became visible again. Re-check for a new build, and if one is already
      // staged and the user was genuinely away and isn't mid call/meeting, apply
      // it now — the safest possible moment to swap builds under someone.
      const away = hiddenAt.current ? Date.now() - hiddenAt.current : 0;
      hiddenAt.current = 0;
      check();
      if (away >= AWAY_MS && readyRef.current && !busyRef.current) {
        window.location.reload();
      }
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(iv);
      clearTimeout(first);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [check]);

  // Don't surface the banner over a live call/meeting — no accidental mid-call
  // Refresh; it reappears the moment they're idle again. `notify` is the user's
  // Settings → Notifications preference: when off, the banner is suppressed (the
  // silent background update on away-return still happens — it's invisible).
  if (!ready || dismissed || busy || !notify) return null;
  return (
    <div className="update-banner" role="status" aria-live="polite">
      <span className="update-banner-txt">A new version of Collab is available.</span>
      <button
        className="update-banner-btn"
        onClick={() => window.location.reload()}
        type="button"
      >
        Refresh
      </button>
      <button
        className="update-banner-x"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
        title="Dismiss"
        type="button"
      >
        ✕
      </button>
    </div>
  );
}
