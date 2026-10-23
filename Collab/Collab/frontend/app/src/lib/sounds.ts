// ── Premium, copyright-free notification audio ──────────────────────────────
// Everything here is SYNTHESIZED on the Web Audio graph (no sampled clips), so
// the tones are entirely original and carry zero licensing risk. Each "note" is
// a warm, bell-like chime — a fundamental sine plus a faint, slightly-detuned
// octave partial under a soft attack/decay envelope — rather than a thin beep.
//
// Shared by CoLabV1 (live call ringtone + message ding) and Settings (ringtone
// preview) so the sound a user picks is exactly the sound they hear in a call.

type Note = { freq: number; dur: number; gap: number };

function synthNote(
  ac: any,
  freq: number,
  t: number,
  dur: number,
  peak: number,
) {
  const env = ac.createGain();
  env.connect(ac.destination);
  env.gain.setValueAtTime(0.0001, t);
  env.gain.exponentialRampToValueAtTime(peak, t + 0.015); // gentle attack
  env.gain.exponentialRampToValueAtTime(0.0001, t + dur); // smooth decay
  const partials = [
    { mult: 1, gain: 1 },
    { mult: 2.001, gain: 0.3 }, // octave shimmer, faintly detuned for warmth
  ];
  partials.forEach((p) => {
    const o = ac.createOscillator();
    const pg = ac.createGain();
    pg.gain.value = p.gain;
    o.type = "sine";
    o.frequency.value = freq * p.mult;
    o.connect(pg);
    pg.connect(env);
    o.start(t);
    o.stop(t + dur + 0.03);
  });
}

// Returns the total scheduled duration (seconds) so callers can time AudioContext
// teardown.
export function playPattern(ac: any, pattern: Note[], peak: number) {
  let t = ac.currentTime + 0.02;
  const start = t;
  pattern.forEach((n) => {
    synthNote(ac, n.freq, t, n.dur, peak);
    t += n.dur + n.gap;
  });
  return t - start;
}

// Call ringtones — original melodic chimes (frequencies in Hz). Chosen for warm,
// open musical intervals so they read as premium, not like any vendor's stock
// ringtone.
export const RINGTONE_PATTERNS: Record<string, Note[]> = {
  // "Aurora" — airy rising fifth + octave.
  default: [
    { freq: 659.25, dur: 0.18, gap: 0.06 },
    { freq: 987.77, dur: 0.18, gap: 0.06 },
    { freq: 1318.51, dur: 0.34, gap: 0.5 },
  ],
  // "Chime" — dignified falling fourth (a reimagined door-chime).
  classic: [
    { freq: 880.0, dur: 0.26, gap: 0.12 },
    { freq: 587.33, dur: 0.42, gap: 0.5 },
  ],
  // "Pulse" — bright, energetic ascending arpeggio.
  modern: [
    { freq: 1046.5, dur: 0.1, gap: 0.04 },
    { freq: 1318.51, dur: 0.1, gap: 0.04 },
    { freq: 1567.98, dur: 0.1, gap: 0.04 },
    { freq: 2093.0, dur: 0.24, gap: 0.5 },
  ],
  // "Tap" — single soft, low-key note.
  minimal: [{ freq: 783.99, dur: 0.16, gap: 0.6 }],
};

// Message / notification ding — a short, gentle rising fourth. Deliberately
// distinct from (and softer than) any call ringtone so a new message never
// sounds like an incoming call.
export const MESSAGE_TONE: Note[] = [
  { freq: 1174.66, dur: 0.09, gap: 0.03 },
  { freq: 1567.98, dur: 0.2, gap: 0.0 },
];

// One-shot preview of a ringtone (used by the Settings picker). Plays the chosen
// melody once at a comfortable level and tears the AudioContext down after.
export function previewRingtone(key?: string, peak = 0.16) {
  try {
    const Ctx =
      (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return;
    const ac = new Ctx();
    try {
      if (ac.state === "suspended" && ac.resume) ac.resume();
    } catch (_) {
      /* ignore */
    }
    const pattern =
      RINGTONE_PATTERNS[key || "default"] || RINGTONE_PATTERNS.default;
    const total = playPattern(ac, pattern, peak);
    setTimeout(
      () => {
        try {
          ac.close();
        } catch (_) {
          /* ignore */
        }
      },
      (total + 0.5) * 1000,
    );
  } catch (_) {
    /* ignore */
  }
}
