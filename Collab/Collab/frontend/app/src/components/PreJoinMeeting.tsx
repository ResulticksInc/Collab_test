import { useEffect, useRef, useState } from "react";
import { IconMic, IconMicOff, IconVideo, IconVideoOff } from "../lib/icons";
import Avatar from "./Avatar";
import { api } from "../lib/api";
import Select from "./ui/Select";

// Pre-join "green room": a device check shown BEFORE entering a meeting. The
// user previews their camera, confirms the mic is picking up sound, picks
// devices, and chooses whether to join with mic/camera on — then proceeds.
// onJoin receives the chosen prefs; the meeting starts with exactly those.
//
// It also answers the question everyone actually has at this moment — "is it
// running, and who's in there?" — for EVERY joiner, invited or not. Only the
// lobby POLICY decides who is then held for admission; this screen is purely
// informational, so an invited person sees the same facts and walks straight in.

// The green room shows the same badge shape as the lobby: name/initials/colour
// only (the preview endpoint deliberately sends no contact details).
const previewAvatar = (p: any) => ({
  kind: "user" as const,
  initials:
    p?.initials ||
    (p?.name || "?")
      .split(/\s+/)
      .slice(0, 2)
      .map((w: string) => w[0])
      .join("")
      .toUpperCase(),
  color: p?.color || "var(--ac)",
  avatarUrl: p?.avatarUrl || null,
});

export default function PreJoinMeeting({
  title,
  meName,
  meetingId,
  token,
  onJoin,
  onCancel,
  guestName,
  joinDisabled = false,
  joining = false,
}: {
  title?: string;
  meName?: string;
  /** Meeting being joined — enables the live "who's already in" panel. */
  meetingId?: string;
  token?: string;
  onJoin: (prefs: { mic: boolean; cam: boolean; micId?: string; camId?: string; spkId?: string }) => void;
  /** Omit to hide Cancel (a guest arriving by link has nowhere to go back to). */
  onCancel?: () => void;
  /**
   * PUBLIC-LINK GUEST LOBBY. When set, the "Joining as" line becomes a name field
   * the guest must fill in — the parent owns the value and validation, and passes
   * `joinDisabled` so Join stays off until the name is valid. `context` is the
   * "hosted by … · organisation" line. No auth token exists yet in this mode, so
   * the live room preview (which needs one) is skipped.
   */
  guestName?: {
    value: string;
    onChange: (v: string) => void;
    error?: string | null;
    context?: string | null;
    maxLength?: number;
    /**
     * This browser already joined the meeting as `value`: the field is shown
     * read-only and the guest rejoins under that same identity (one guest
     * identity per browser profile per meeting — see lib/guestDevice.ts).
     */
    locked?: boolean;
  };
  joinDisabled?: boolean;
  joining?: boolean;
}) {
  const [mic, setMic] = useState(true);
  const [cam, setCam] = useState(false);
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [cams, setCams] = useState<MediaDeviceInfo[]>([]);
  const [spks, setSpks] = useState<MediaDeviceInfo[]>([]);
  const [micId, setMicId] = useState<string>("");
  const [camId, setCamId] = useState<string>("");
  const [spkId, setSpkId] = useState<string>("");
  const [level, setLevel] = useState(0); // 0..1 mic level
  const [err, setErr] = useState<string | null>(null);
  // Live room state. `undefined` = still asking (say nothing rather than
  // guessing "not started"); `null` = unavailable, and the screen quietly falls
  // back to its old prompt instead of showing a broken panel.
  const [preview, setPreview] = useState<any>(undefined);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<any>(null);
  const rafRef = useRef<number | null>(null);

  // Who is already in there — polled, because someone sitting in the green room
  // checking their camera is exactly when the meeting fills up.
  useEffect(() => {
    if (!meetingId || !token) {
      setPreview(null);
      return;
    }
    let live = true;
    const tick = async () => {
      try {
        const p: any = await api.getMeetingPreview(token, meetingId);
        if (live) setPreview(p || null);
      } catch {
        if (live) setPreview((cur: any) => (cur === undefined ? null : cur));
      }
    };
    tick();
    const iv = setInterval(tick, 5000);
    return () => {
      live = false;
      clearInterval(iv);
    };
  }, [meetingId, token]);

  // (Re)acquire the preview stream whenever the device or on/off choices change.
  useEffect(() => {
    let cancelled = false;
    const stop = () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      if (audioCtxRef.current) {
        try { audioCtxRef.current.close(); } catch (_) { /* ignore */ }
        audioCtxRef.current = null;
      }
    };
    (async () => {
      try {
        if (!mic && !cam) { stop(); setLevel(0); return; }
        // Release the previous capture BEFORE asking for a new one. Stopping it
        // afterwards (as this did) left two live captures overlapping on every
        // device switch, which on Safari is exactly the shape that produces
        // repeated permission prompts and unstable capture.
        stop();
        const constraints: MediaStreamConstraints = {
          // `ideal`, NOT `exact`, on the mic. Safari salts deviceIds per origin
          // and per session, so a remembered or stale id throws
          // OverconstrainedError — which the catch below flattened into the
          // generic "Couldn't access your camera or microphone", making a
          // perfectly working mic look broken. `ideal` falls back to the default
          // device instead of failing.
          audio: mic ? (micId ? { deviceId: { ideal: micId } } : true) : false,
          // Default to 1080p capture (matches the call + meeting Room defaults);
          // "ideal" so webcams that can't do 1080 fall back gracefully.
          video: cam
            ? {
                deviceId: camId ? { ideal: camId } : undefined,
                width: { ideal: 1920 },
                height: { ideal: 1080 },
              }
            : false,
        };
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        setErr(null);
        if (videoRef.current) videoRef.current.srcObject = cam ? stream : null;
        // Enumerate device labels (only available after a getUserMedia grant).
        const devs = await navigator.mediaDevices.enumerateDevices();
        if (!cancelled) {
          setMics(devs.filter((d) => d.kind === "audioinput"));
          setCams(devs.filter((d) => d.kind === "videoinput"));
          setSpks(devs.filter((d) => d.kind === "audiooutput"));
        }
        // Mic level meter.
        if (mic && stream.getAudioTracks().length) {
          const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
          const ctx = new Ctx();
          audioCtxRef.current = ctx;
          // RESUME THE CONTEXT — this is the actual "mic doesn't work in Safari"
          // bug. This effect runs on mount, i.e. outside any user gesture, and
          // Safari starts such a context in state 'suspended'. A suspended
          // context feeds the analyser pure silence, so the level bar sat flat
          // at zero no matter how loud you spoke and the mic read as dead —
          // even though capture was fine and the meeting would have carried
          // audio normally. resume() is a promise that rejects when it is still
          // gesture-blocked; the pointerdown fallback below then catches the
          // user's next click. spatialAudio.ts already does exactly this.
          const resume = () => {
            try {
              if (ctx.state === "suspended") ctx.resume().catch(() => {});
            } catch (_) { /* ignore */ }
          };
          resume();
          if (ctx.state === "suspended") {
            const once = () => { resume(); window.removeEventListener("pointerdown", once); };
            window.addEventListener("pointerdown", once, { once: true });
          }
          const src = ctx.createMediaStreamSource(stream);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 256;
          src.connect(analyser);
          const data = new Uint8Array(analyser.frequencyBinCount);
          let lastLevelUpdate = 0;
          let curLevel = 0;
          const tick = (now: number) => {
            analyser.getByteTimeDomainData(data);
            let peak = 0;
            for (let i = 0; i < data.length; i++) {
              const v = Math.abs(data[i] - 128) / 128;
              if (v > peak) peak = v;
            }
            curLevel = curLevel * 0.7 + peak * 0.3;
            if (!lastLevelUpdate || now - lastLevelUpdate >= 66) {
              lastLevelUpdate = now;
              setLevel(curLevel);
            }
            rafRef.current = requestAnimationFrame(tick);
          };
          rafRef.current = requestAnimationFrame(tick);
        } else {
          setLevel(0);
        }
      } catch (e: any) {
        if (!cancelled) {
          setErr(
            e && e.name === "NotAllowedError"
              ? "Camera/microphone permission was blocked. Allow access in your browser to check your devices."
              : "Couldn't access your camera or microphone.",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mic, cam, micId, camId]);

  const joinNow = () => {
    if (joinDisabled || joining) return;
    if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    onJoin({ mic, cam, micId: micId || undefined, camId: camId || undefined, spkId: spkId || undefined });
  };

  const initials = (guestName ? guestName.value || "?" : meName || "?")
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <div className="pj-overlay-v2" role="dialog" aria-modal="true" aria-label="Device check before joining">
      <div className="pj-card-v2">
        {/* Left 55%: camera preview */}
        <div className="pj-preview-v2">
          <div className="pj-preview-frame">
            {cam ? (
              // eslint-disable-next-line jsx-a11y/media-has-caption
              <video ref={videoRef} autoPlay muted playsInline style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            ) : (
              <div className="pj-preview-off">
                <div className="pj-preview-avatar" style={{ background: "var(--ac)" }}>{initials}</div>
                <span>Camera is off</span>
              </div>
            )}
          </div>
          <div className="pj-preview-controls">
            <button
              className={"pj-preview-btn" + (mic ? "" : " off")}
              onClick={() => setMic((v) => !v)}
              title={mic ? "Mute microphone" : "Unmute microphone"}
              aria-pressed={mic}
            >
              {mic ? <IconMic size={18} /> : <IconMicOff size={18} />}
            </button>
            <button
              className={"pj-preview-btn" + (cam ? "" : " off")}
              onClick={() => setCam((v) => !v)}
              title={cam ? "Stop camera" : "Start camera"}
              aria-pressed={cam}
            >
              {cam ? <IconVideo size={18} /> : <IconVideoOff size={18} />}
            </button>
          </div>
        </div>

        {/* Right 45%: info + device selectors + join */}
        <div className="pj-info-v2">
          <div className="pj-info-title">{title || "Meeting"}</div>
          {/* Live room state — shown to EVERY joiner, invited or not. "Is it
              running and who's in there?" is the question people actually have
              at this moment, and it decides whether they join now or wait. The
              lobby POLICY is a separate matter: it only decides who gets held
              after pressing Join, and the wait screen then repeats these same
              facts so the two can never disagree.
              While the first fetch is in flight, or if it fails, this falls back
              to the old prompt rather than asserting "not started". */}
          {preview ? (
            <div className="pj-room-state">
              <div className={"pj-room-pill" + (preview.started ? " live" : "")}>
                <span className="pj-room-dot" aria-hidden="true" />
                {preview.started
                  ? `In progress · ${preview.count} ${preview.count === 1 ? "person" : "people"} in the meeting`
                  : preview.hostName
                    ? `Not started yet · waiting for ${preview.hostName}`
                    : "Not started yet"}
              </div>
              {preview.participants && preview.participants.length > 0 ? (
                <div className="pj-room-people">
                  {preview.participants.slice(0, 5).map((p: any) => (
                    <span className="pj-room-person" key={p.id}>
                      <Avatar avatar={previewAvatar(p)} size={22} />
                      <span className="pj-room-person-n">
                        {p.name}
                        {p.isHost ? <em className="pj-room-tag">Host</em> : null}
                      </span>
                    </span>
                  ))}
                  {preview.participants.length > 5 ? (
                    <span className="pj-room-more">
                      +{preview.participants.length - 5}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="pj-info-meta">
              {/* Just the prompt. Your name used to be repeated here as well, and
                  then again in the "Joining as" block a few lines below — the same
                  identity stated twice, one line apart, with no difference in
                  meaning. "Joining as" is the one that earns its place: it is
                  labelled, so it answers *which account* you are about to join
                  with (the thing worth checking on a shared machine). */}
              <span>Ready to join?</span>
            </div>
          )}

          {err && <div className="pj-err-v2">{err}</div>}

          {guestName ? (
            <div className="pj-name-block">
              <label className="pj-name-label" htmlFor="pj-guest-name">Your name</label>
              <input
                id="pj-guest-name"
                className={"pj-name-input" + (guestName.locked ? " locked" : "")}
                type="text"
                value={guestName.value}
                maxLength={guestName.maxLength || 50}
                placeholder="Enter your name"
                autoComplete="name"
                autoFocus={!guestName.locked}
                spellCheck={false}
                readOnly={!!guestName.locked}
                aria-readonly={guestName.locked ? true : undefined}
                aria-invalid={guestName.error ? true : undefined}
                aria-describedby="pj-guest-name-help"
                onChange={(e) => {
                  if (!guestName.locked) guestName.onChange(e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) joinNow();
                }}
              />
              <div
                id="pj-guest-name-help"
                className={"pj-name-help" + (guestName.error ? " err" : "")}
                role={guestName.error ? "alert" : undefined}
              >
                {guestName.error ||
                  (guestName.context
                    ? guestName.context
                    : "You'll join as a guest. Others will see this name.")}
              </div>
            </div>
          ) : (
            meName && (
              <div className="pj-name-block">
                <div className="pj-name-label">Joining as</div>
                <div className="pj-name-value">{meName}</div>
              </div>
            )
          )}

          {/* Mic level bar */}
          {mic && (
            <div className="pj-mic-level" aria-hidden="true">
              <div className="pj-mic-fill" style={{ width: Math.min(100, Math.round(level * 140)) + "%" }}/>
            </div>
          )}

          {mics.length > 0 && (
            <div className="pj-device-sel-v2">
              <div className="pj-device-label-v2">Microphone</div>
              <Select className="pj-device-select" value={micId} onChange={(e) => setMicId(e.target.value)} disabled={!mic}>
                <option value="">Default microphone</option>
                {mics.map((d, i) => <option key={d.deviceId || i} value={d.deviceId}>{d.label || `Microphone ${i + 1}`}</option>)}
              </Select>
            </div>
          )}
          {cams.length > 0 && (
            <div className="pj-device-sel-v2">
              <div className="pj-device-label-v2">Camera</div>
              <Select className="pj-device-select" value={camId} onChange={(e) => setCamId(e.target.value)} disabled={!cam}>
                <option value="">Default camera</option>
                {cams.map((d, i) => <option key={d.deviceId || i} value={d.deviceId}>{d.label || `Camera ${i + 1}`}</option>)}
              </Select>
            </div>
          )}
          {spks.length > 0 && (
            <div className="pj-device-sel-v2">
              <div className="pj-device-label-v2">Speaker</div>
              <Select className="pj-device-select" value={spkId} onChange={(e) => setSpkId(e.target.value)}>
                <option value="">Default speaker</option>
                {spks.map((d, i) => <option key={d.deviceId || i} value={d.deviceId}>{d.label || `Speaker ${i + 1}`}</option>)}
              </Select>
            </div>
          )}

          <div className="pj-actions-v2">
            {onCancel ? <button className="pj-cancel-v2" onClick={onCancel}>Cancel</button> : null}
            <button
              className="pj-join-v2"
              onClick={joinNow}
              disabled={joinDisabled || joining}
              aria-busy={joining || undefined}
            >
              {joining ? "Joining…" : "Join now"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
