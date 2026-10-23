// MIC-22/23: local microphone health watchdog, shared by BOTH the meeting stage
// (MeetingStage) and the 1:1/group call path (useCallSessionMedia) — one health
// policy, two surfaces, never a second mute path.
//
// The failure it exists for: the OS yanks the capture device mid-session (USB
// headset unplugged, Bluetooth dropped, permission revoked, driver reset). The
// underlying MediaStreamTrack silently flips to readyState "ended", nothing is
// published any more, and every UI indicator keeps saying "live" — the classic
// silent dead mic. This watchdog polls the local mic publication's health and,
// when the user INTENDS to be unmuted but the track is gone/ended, re-acquires
// it automatically (MIC-22) and reports progress so the caller can show
// "Reconnecting your microphone…" → "reconnected" / recovery guidance (MIC-23).
//
// Deliberate boundaries:
//  • Intent-gated. When the user is muted there is NOTHING to watch — hard mute
//    (stopMicTrackOnMute) stops capture, so an ended track is the CORRECT state.
//    A recovery attempt while muted would re-open the mic against the user's
//    will; MIC-20's "a fallback never unmutes anyone" applies here too.
//  • `publication.isMuted` is NOT treated as unhealthy. A muted-but-live track
//    can be a host/server mute the client hasn't reconciled yet; unmuting it
//    from here would fight the host. Only a missing/ended capture track counts.
//  • Two consecutive unhealthy ticks are required before acting, so the publish
//    gap right after join and transient blips never trigger a spurious restart.
//  • Silent while the room itself is reconnecting — LiveKit's own reconnect
//    engine re-publishes tracks; racing it would double-acquire.

export type MicWatchdogStatus =
  | { kind: "reconnecting"; attempt: number }
  | { kind: "recovered"; label: string }
  | { kind: "failed"; error: any };

export interface MicWatchdogOpts {
  /** The live LiveKit Room, or null once torn down. */
  getRoom: () => any | null;
  /** Current mic INTENT (true = the user means to be live). */
  getIntent: () => boolean;
  /** Health/progress callbacks — map to toasts/banners in the caller. */
  onStatus: (s: MicWatchdogStatus) => void;
  /** Poll cadence. Default 4s → a dead mic is noticed within ~8s. */
  intervalMs?: number;
  /** MIC-23: attempts before surfacing recovery guidance. Default 3. */
  maxAttempts?: number;
}

function micPublication(room: any): any | null {
  const lp = room && room.localParticipant;
  if (!lp) return null;
  // Track.Source.Microphone is the string "microphone" in livekit-client v2;
  // matching on it (with a first-audio fallback) avoids importing the SDK here.
  const pubs: any[] = Array.from(lp.audioTrackPublications?.values?.() || []);
  return pubs.find((p) => p && p.source === "microphone") || pubs[0] || null;
}

function micHealthy(room: any): boolean {
  const pub = micPublication(room);
  const mst = pub && pub.track && pub.track.mediaStreamTrack;
  return !!(mst && mst.readyState === "live");
}

export function startMicWatchdog(opts: MicWatchdogOpts): () => void {
  const intervalMs = opts.intervalMs ?? 4000;
  const maxAttempts = opts.maxAttempts ?? 3;
  let attempts = 0;
  let unhealthyTicks = 0;
  let recovering = false;
  let gaveUp = false; // stop intervening after maxAttempts (until re-armed)
  let lastError: any = null;
  let stopped = false;

  const rearm = () => {
    // New hardware (devicechange) or a fresh unmute is a new chance — clear the
    // give-up latch so the next unhealthy tick may try again.
    attempts = 0;
    gaveUp = false;
  };

  let hadIntent = opts.getIntent();

  const tick = async () => {
    if (stopped || recovering) return;
    const room = opts.getRoom();
    // Only act on a settled, connected room; LiveKit owns recovery elsewhere.
    if (!room || room.state !== "connected") {
      unhealthyTicks = 0;
      return;
    }
    const intent = opts.getIntent();
    if (intent && !hadIntent) rearm(); // muted → unmuted transition re-arms
    hadIntent = intent;
    if (!intent) {
      unhealthyTicks = 0;
      return;
    }
    if (micHealthy(room)) {
      unhealthyTicks = 0;
      attempts = 0;
      gaveUp = false;
      return;
    }
    if (gaveUp) return;
    unhealthyTicks++;
    if (unhealthyTicks < 2) return; // debounce join gaps / transient blips

    recovering = true;
    attempts++;
    try {
      opts.onStatus({ kind: "reconnecting", attempt: attempts });
      const pub = micPublication(room);
      try {
        // Preferred: restart the existing track in place (keeps the publication,
        // no renegotiation). Falls back to a full off→on cycle, which lets the
        // SDK acquire the current default device when the old one is gone
        // (MIC-20 fallback — intent stays "unmuted" throughout, and the muted
        // path never reaches this code, so a fallback can never unmute anyone).
        if (pub && pub.track && typeof pub.track.restartTrack === "function") {
          await pub.track.restartTrack();
        } else {
          throw new Error("no restartable track");
        }
      } catch (_) {
        const lp = room.localParticipant;
        await lp.setMicrophoneEnabled(false);
        await lp.setMicrophoneEnabled(true);
      }
      // Verify, don't assume: only a live capture track counts as recovered.
      if (!opts.getIntent()) {
        // User muted while we were recovering — their intent wins; drop the
        // freshly acquired track rather than leaving a live mic behind.
        try { await room.localParticipant.setMicrophoneEnabled(false); } catch (_) {}
        unhealthyTicks = 0;
      } else if (micHealthy(room)) {
        const mst = micPublication(room)?.track?.mediaStreamTrack;
        attempts = 0;
        unhealthyTicks = 0;
        opts.onStatus({ kind: "recovered", label: (mst && mst.label) || "" });
      } else {
        throw new Error("mic track still not live after restart");
      }
    } catch (e: any) {
      lastError = e && e.error ? e.error : e;
      if (attempts >= maxAttempts) {
        gaveUp = true;
        // MIC-23: never a silent dead mic — hand the caller the last error so it
        // can render device-picker / permission guidance.
        opts.onStatus({ kind: "failed", error: lastError });
      }
    } finally {
      recovering = false;
    }
  };

  const timer = setInterval(() => { void tick(); }, intervalMs);
  const md = typeof navigator !== "undefined" ? navigator.mediaDevices : null;
  const onDeviceChange = () => rearm();
  if (md && typeof md.addEventListener === "function")
    md.addEventListener("devicechange", onDeviceChange);

  return () => {
    stopped = true;
    clearInterval(timer);
    if (md && typeof md.removeEventListener === "function")
      md.removeEventListener("devicechange", onDeviceChange);
  };
}
