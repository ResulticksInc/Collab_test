// ── Presentation Mode (P0-11) ────────────────────────────────────────────────
// A tiny session-scoped "the user is presenting" signal, shared by every
// surface that can present (1:1 calls, group calls, meetings — CoLabV1 and
// MeetingStage both write it) and every notification emitter that must go
// quiet while it's on (shouldPush, toasts, sounds, ringtone, banners).
//
// Design notes:
// - This is a SUPPRESSION FLAG, not a settings mutation. The user's own
//   notification preferences (notifyLevel, quiet hours, manual Busy) are never
//   touched, so "restore the previous state exactly" is inherent — when
//   presenting ends the flag drops and their own preferences are simply back
//   in charge. If they had DND on already, it stays on (never overridden).
// - Whether presenting actually suppresses anything is decided at the READ
//   sites via the `presentationDnd` setting (default ON) — the flag itself
//   only says "a screen share / presenter layout is live".

let presenting = false;
const subs = new Set<(on: boolean) => void>();

export function setPresenting(on: boolean): void {
  if (on === presenting) return;
  presenting = on;
  subs.forEach((f) => {
    try {
      f(on);
    } catch (_) {
      /* a listener error must never break the presenter */
    }
  });
}

export function isPresenting(): boolean {
  return presenting;
}

export function onPresentingChange(f: (on: boolean) => void): () => void {
  subs.add(f);
  return () => subs.delete(f);
}
