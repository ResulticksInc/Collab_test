// Spatial audio for calls & meetings.
//
// Reduces "meeting fatigue" by placing each remote participant's voice at a
// distinct point in the stereo field instead of everyone stacked dead-centre —
// the brain separates overlapping talkers far more easily when they come from
// different directions (the "cocktail-party effect").
//
// Implementation: LiveKit v2 exposes a Web Audio hook on RemoteAudioTrack
// (setAudioContext + setWebAudioPlugins). We route each remote track through a
// StereoPannerNode; LiveKit wires source → panner → destination for us and
// handles the Chromium remote-track quirk internally. Participants are spread
// evenly across the field by their order in the tile list (left → right), so a
// 1:1 call stays centred and a busy meeting fans voices out.
//
// Everything is best-effort and feature-detected: if the browser lacks Web
// Audio, LiveKit lacks the plugin API, or the AudioContext can't start, callers
// fall back to plain <audio> element playback (attach() returns false) so audio
// is never lost.

type LKRemoteAudioTrack = {
  setAudioContext?: (ctx: AudioContext | undefined) => void;
  setWebAudioPlugins?: (nodes: AudioNode[]) => void;
  // LiveKit routes web-audio output through the track's own gain node; setVolume
  // drives it, so we mute spatial tracks here instead of via <audio>.muted.
  setVolume?: (v: number) => void;
  // LiveKit only wires the web-audio graph when the track is ATTACHED to an
  // element (RemoteAudioTrack.attach() runs connectWebAudio when a context is
  // set) — so we must attach, keeping the element in the DOM to satisfy the
  // Chromium remote-stream quirk. Audible output comes from the graph; LiveKit
  // suppresses the element's own output.
  attach?: (element?: HTMLMediaElement) => HTMLMediaElement;
  detach?: (element?: HTMLMediaElement) => void;
  mediaStreamTrack?: MediaStreamTrack;
};

// Max distance from centre, in the StereoPanner range [-1, 1]. Kept below 1 so
// even the outermost voice retains presence in both ears (fully-hard-panned
// audio feels detached / "in one ear").
const MAX_PAN = 0.75;

export class SpatialAudioManager {
  private ctx: AudioContext | null = null;
  private panners = new Map<string, StereoPannerNode>();
  private tracks = new Map<string, LKRemoteAudioTrack>();
  private elements = new Map<string, HTMLMediaElement>();
  private order: string[] = [];
  // id → horizontal position 0..1 across the stage (tile centre). When present it
  // drives accurate panning ("the voice comes from where I see them"); otherwise
  // we fall back to an even spread by `order`.
  private layout = new Map<string, number>();
  private enabled = false; // opt-in: off until setEnabled(true) (see callers)
  private muted = false;
  private sinkId: string | null = null;
  private supported: boolean;
  // Bound keep-alive handler: browsers auto-suspend an AudioContext when the tab
  // is backgrounded (and some platforms suspend on OS audio-focus changes). Left
  // suspended, spatial audio goes silent. We resume on visibility/focus and on
  // the context's own statechange so playback self-heals.
  private keepAlive: (() => void) | null = null;

  constructor() {
    this.supported =
      typeof window !== "undefined" &&
      (typeof (window as any).AudioContext === "function" ||
        typeof (window as any).webkitAudioContext === "function");
  }

  private resumeCtx() {
    const ctx = this.ctx;
    if (ctx && ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }
  }

  isSupported() {
    return this.supported;
  }

  isEnabled() {
    return this.enabled;
  }

  private ensureCtx(): AudioContext | null {
    if (!this.supported) return null;
    if (!this.ctx) {
      try {
        const Ctor =
          (window as any).AudioContext || (window as any).webkitAudioContext;
        this.ctx = new Ctor();
      } catch {
        this.supported = false;
        return null;
      }
      // Install the self-healing keep-alive once, when the context is created.
      if (!this.keepAlive) {
        this.keepAlive = () => this.resumeCtx();
        try {
          this.ctx.addEventListener?.("statechange", this.keepAlive);
        } catch {}
        if (typeof document !== "undefined") {
          try {
            document.addEventListener("visibilitychange", this.keepAlive);
          } catch {}
        }
        if (typeof window !== "undefined") {
          try {
            window.addEventListener("focus", this.keepAlive);
          } catch {}
        }
      }
    }
    // Autoplay policy: the context may start suspended; joining a call is a user
    // gesture, so resume() succeeds. Fire-and-forget — resume is idempotent.
    this.resumeCtx();
    return this.ctx;
  }

  // Route a remote audio track through a per-participant panner and attach it
  // (into `host`). Returns true when spatialisation was applied (the caller must
  // NOT also attach the track — the manager owns its element now); false to fall
  // back to plain element playback.
  attach(
    id: string,
    track: LKRemoteAudioTrack,
    host?: HTMLElement | null,
  ): boolean {
    if (!this.enabled || !this.supported) return false;
    if (
      typeof track.setWebAudioPlugins !== "function" ||
      typeof track.setAudioContext !== "function" ||
      typeof track.attach !== "function"
    ) {
      return false;
    }
    const ctx = this.ensureCtx();
    if (!ctx || typeof ctx.createStereoPanner !== "function") return false;
    try {
      let panner = this.panners.get(id);
      if (!panner) {
        panner = ctx.createStereoPanner();
        panner.pan.value = 0;
        this.panners.set(id, panner);
      }
      this.tracks.set(id, track);
      // Configure web-audio BEFORE attach so RemoteAudioTrack.attach() wires the
      // source → panner → gain → destination graph itself.
      track.setAudioContext(ctx);
      track.setWebAudioPlugins([panner]);
      const el = track.attach();
      try {
        el.autoplay = true;
        // Tag so the host's own mute/sink loops (e.g. a "speaker off" toggle
        // that sets el.muted on every child) SKIP this element — muting it would
        // starve the Web Audio source. Mute/sink go through the manager instead.
        (el as HTMLElement).dataset.spatial = "1";
      } catch {}
      if (host && (host as any).appendChild) host.appendChild(el);
      this.elements.set(id, el);
      // Honour the current speaker-mute (routes through the LiveKit gain node)
      // and output device.
      try {
        track.setVolume?.(this.muted ? 0 : 1);
      } catch {}
      this.applySink();
      this.applyPans();
      return true;
    } catch {
      // Any failure → tear down and let the caller do plain element playback.
      try {
        track.setWebAudioPlugins?.([]);
      } catch {}
      try {
        const el = this.elements.get(id);
        if (el) track.detach?.(el);
      } catch {}
      this.panners.delete(id);
      this.tracks.delete(id);
      this.elements.delete(id);
      return false;
    }
  }

  detach(id: string) {
    const track = this.tracks.get(id);
    try {
      track?.setWebAudioPlugins?.([]);
    } catch {}
    try {
      const el = this.elements.get(id);
      if (el) {
        track?.detach?.(el);
        el.remove?.();
      }
    } catch {}
    try {
      this.panners.get(id)?.disconnect();
    } catch {}
    this.panners.delete(id);
    this.tracks.delete(id);
    this.elements.delete(id);
    this.order = this.order.filter((x) => x !== id);
  }

  // Tell the manager the left→right ordering of remote participants (e.g. the
  // order their tiles appear). Voices are spread evenly across that ordering.
  // Used as a fallback when precise tile positions aren't provided.
  setOrder(ids: string[]) {
    this.order = ids.slice();
    this.applyPans();
  }

  // Precise positioning: `positions` maps each remote id to its tile-centre x
  // (0..1 across the stage). This makes the pan match where the speaker is shown,
  // which is the enterprise "spatial accuracy" behaviour (Teams/Zoom immersive).
  setLayout(positions: Array<{ id: string; x: number }>) {
    this.layout = new Map(
      positions
        .filter((p) => p && typeof p.x === "number" && isFinite(p.x))
        .map((p) => [p.id, Math.min(1, Math.max(0, p.x))]),
    );
    this.order = positions.map((p) => p.id);
    this.applyPans();
  }

  private applyPans() {
    const active = this.order.filter((id) => this.panners.has(id));
    const n = active.length;
    active.forEach((id, i) => {
      const panner = this.panners.get(id);
      if (!panner) return;
      let pan: number;
      if (!this.enabled) {
        pan = 0;
      } else if (this.layout.has(id)) {
        // Accurate: map tile-centre x (0..1) to [-MAX_PAN, +MAX_PAN].
        pan = (this.layout.get(id)! * 2 - 1) * MAX_PAN;
      } else if (n <= 1) {
        pan = 0;
      } else {
        // Fallback: even spread across the field by order.
        pan = ((i / (n - 1)) * 2 - 1) * MAX_PAN;
      }
      this.setPanValue(panner, pan);
    });
  }

  private setPanValue(panner: StereoPannerNode, value: number) {
    try {
      const ctx = this.ctx;
      if (ctx && panner.pan.setTargetAtTime) {
        // Glide to avoid a click when the layout reshuffles mid-call.
        panner.pan.setTargetAtTime(value, ctx.currentTime, 0.05);
      } else {
        panner.pan.value = value;
      }
    } catch {
      try {
        panner.pan.value = value;
      } catch {}
    }
  }

  // Speaker mute (used by CoLabV1's speaker toggle, which previously muted the
  // <audio> element). Applies to every spatial track's LiveKit gain node.
  setMuted(muted: boolean) {
    this.muted = muted;
    this.tracks.forEach((t) => {
      try {
        t.setVolume?.(muted ? 0 : 1);
      } catch {}
    });
  }

  // Output device selection. AudioContext.setSinkId is Chromium 110+; where it's
  // unsupported spatial audio simply plays on the default device.
  setSinkId(id: string) {
    this.sinkId = id || null;
    this.applySink();
  }

  private applySink() {
    const ctx = this.ctx as any;
    if (ctx && this.sinkId && typeof ctx.setSinkId === "function") {
      try {
        ctx.setSinkId(this.sinkId);
      } catch {}
    }
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    if (!on) {
      // Collapse everyone to centre (mono) but keep the graph intact so toggling
      // back on is instant and never drops audio.
      this.panners.forEach((p) => this.setPanValue(p, 0));
    } else {
      this.ensureCtx();
      this.applyPans();
    }
  }

  close() {
    this.tracks.forEach((t, id) => {
      try {
        t.setWebAudioPlugins?.([]);
      } catch {}
      try {
        const el = this.elements.get(id);
        if (el) {
          t.detach?.(el);
          el.remove?.();
        }
      } catch {}
    });
    this.panners.forEach((p) => {
      try {
        p.disconnect();
      } catch {}
    });
    this.panners.clear();
    this.tracks.clear();
    this.elements.clear();
    this.order = [];
    if (this.keepAlive) {
      try {
        this.ctx?.removeEventListener?.("statechange", this.keepAlive);
      } catch {}
      try {
        if (typeof document !== "undefined")
          document.removeEventListener("visibilitychange", this.keepAlive);
      } catch {}
      try {
        if (typeof window !== "undefined")
          window.removeEventListener("focus", this.keepAlive);
      } catch {}
      this.keepAlive = null;
    }
    if (this.ctx) {
      try {
        this.ctx.close();
      } catch {}
      this.ctx = null;
    }
  }
}
