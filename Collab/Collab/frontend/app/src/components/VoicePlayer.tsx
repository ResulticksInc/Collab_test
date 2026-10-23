import React, { useEffect, useRef, useState } from "react";
import { IconPlay, IconPause, IconAlertTriangle } from "../lib/icons";
import { sanitizeWaveform } from "../lib/voiceWaveform";
import { decryptBlob } from "../lib/e2ee/media";
import { mimeOf } from "../lib/desktopFiles";

type Props = { src: string | null; voice?: any; token?: string; file?: any };

export default function VoicePlayer({ src, voice, token, file }: Props) {
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [progress, setProgress] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState<number>(Number(voice?.duration) || 0);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [pendingPlay, setPendingPlay] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const scrubberRef = useRef<HTMLDivElement | null>(null);
  const fetchingRef = useRef(false);

  useEffect(() => {
    setDuration(Number(voice?.duration) || 0);
  }, [voice]);

  const bars = (() => {
    // REAL waveform first (WhatsApp model): the sender decoded the clip and
    // shipped normalized peaks in voice.waveform, so the bars show the true
    // shape of the audio — pauses dip, speech rises. sanitizeWaveform guards
    // against malformed payloads. Peaks are 1–100; map onto a 12–100% height
    // range so silence still renders a visible baseline dot.
    const real = sanitizeWaveform(voice?.waveform);
    if (real) return real.map((p) => 12 + p * 0.88);
    // Legacy messages (sent before waveforms shipped) keep the deterministic
    // synthetic bars so old threads don't change appearance.
    let seed = (src || "x").length || 7;
    const rng = () => {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };
    return Array.from({ length: 40 }).map(() => 20 + rng() * 80);
  })();

  const ensureAudio = async () => {
    if (audioUrl || fetchingRef.current || !src) return audioUrl;
    fetchingRef.current = true;
    try {
      const r = await fetch(src, token ? { headers: { Authorization: "Bearer " + token } } : {});
      if (!r.ok) throw new Error(String(r.status));
      // A voice note in an E2EE conversation is stored as CIPHERTEXT, exactly
      // like every other attachment. This used to hand the raw encrypted bytes
      // straight to <audio>, which silently refused to decode them — the play
      // button simply did nothing. Decrypt with the wrapped key that
      // decryptMessageList attaches to the file, mirroring useFileBlob.
      // The RECORDER's own mimeType comes first. mimeOf() infers from the file
      // name, so a voice note stored without a useful extension yields a wrong
      // (or generic) type that the browser then refuses to decode — the very
      // failure this fix is about. Fall back to the name, then the response.
      const mimeType =
        (voice && (voice.mimeType || voice.mime || voice.type)) ||
        (file && mimeOf(file)) ||
        r.headers.get("Content-Type") ||
        "audio/webm";
      // The blob MUST carry a MIME type or the object URL won't decode. slice()
      // re-types without copying the bytes; new Blob([...]) would duplicate the
      // whole clip in memory (and decryptBlob below makes another copy).
      const raw = await r.blob();
      let blob = raw.slice(0, raw.size, mimeType);
      if (file && file._e2eeKey && file._e2eeIv)
        blob = await decryptBlob(blob, file._e2eeKey, file._e2eeIv, mimeType);
      const url = URL.createObjectURL(blob);
      setAudioUrl(url);
      setLoadFailed(false);
      return url;
    } catch {
      setLoadFailed(true);
      return null;
    } finally {
      fetchingRef.current = false;
    }
  };

  useEffect(() => {
    return () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    };
  }, [audioUrl]);

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onTime = () => {
      const ct = a.currentTime || 0;
      const dur = a.duration && Number.isFinite(a.duration) ? a.duration : duration || 1;
      setProgress(dur > 0 ? ct / dur : 0);
      setCurrentTime(ct);
    };
    const onLoaded = () => {
      if (Number.isFinite(a.duration) && a.duration > 0) setDuration(a.duration);
    };
    const onEnd = () => {
      setPlaying(false);
      setProgress(0);
      setCurrentTime(0);
    };
    a.addEventListener("timeupdate", onTime);
    a.addEventListener("loadedmetadata", onLoaded);
    a.addEventListener("ended", onEnd);
    return () => {
      a.removeEventListener("timeupdate", onTime);
      a.removeEventListener("loadedmetadata", onLoaded);
      a.removeEventListener("ended", onEnd);
    };
  }, [audioUrl, duration]);

  useEffect(() => {
    if (audioUrl && pendingPlay) {
      const a = audioRef.current;
      // A rejected play() used to be swallowed, so an undecodable clip looked
      // like a dead button. Surface it as the same "couldn't load" state a
      // failed fetch produces.
      a?.play()
        .then(() => setPlaying(true))
        .catch(() => setLoadFailed(true));
      setPendingPlay(false);
    }
  }, [audioUrl, pendingPlay]);

  const toggle = async (e?: any) => {
    e && e.preventDefault();
    const a = audioRef.current;
    if (playing) {
      a?.pause();
      setPlaying(false);
      return;
    }
    if (!audioUrl) {
      // Nothing fetchable (no URL and no file id) — say so rather than leaving
      // the button inert with no explanation.
      if (!src) {
        setLoadFailed(true);
        return;
      }
      setPendingPlay(true);
      ensureAudio();
      return;
    }
    a?.play()
      .then(() => setPlaying(true))
      .catch(() => setLoadFailed(true));
  };

  const toggleSpeed = (e?: any) => {
    e && e.preventDefault();
    const a = audioRef.current;
    if (!a) return;
    const next = speed === 1 ? 1.5 : speed === 1.5 ? 2 : 1;
    a.playbackRate = next;
    setSpeed(next);
  };

  const onSeek = (e: React.MouseEvent) => {
    e.preventDefault();
    const a = audioRef.current;
    const s = scrubberRef.current;
    if (!a || !s) return;
    const rect = s.getBoundingClientRect();
    const pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const dur = a.duration && Number.isFinite(a.duration) ? a.duration : duration || 1;
    a.currentTime = pos * dur;
    setProgress(pos);
    setCurrentTime(a.currentTime);
  };

  const mmss = (secs: number) => {
    const s = Number.isFinite(secs) ? Math.max(0, Math.floor(secs)) : 0;
    return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
  };

  return (
    <div className="vp">
      <button className="vp-play" onClick={toggle} title={loadFailed ? "Couldn't load audio" : playing ? "Pause" : "Play"}>
        {loadFailed ? (
          <IconAlertTriangle size={18} />
        ) : playing ? (
          <IconPause size={18} />
        ) : (
          <IconPlay size={18} />
        )}
      </button>
      <div ref={scrubberRef} className="vp-scrub" onClick={onSeek}>
        <div className="vp-track">
          <div className="vp-fill" style={{ width: `${progress * 100}%` }} />
        </div>
        <div className="vp-bars">
          {bars.map((h, i) => {
            const isPlayed = i / bars.length <= progress;
            return <div key={i} className={isPlayed ? "vp-bar vp-pd" + (playing && isPlayed ? " playing" : "") : "vp-bar"} style={{ height: `${h}%` }} />;
          })}
        </div>
      </div>
      <span className="vp-time">{mmss(currentTime)} / {mmss(duration)}</span>
      <button className={"vp-speed" + (speed !== 1 ? " active" : "")} onClick={toggleSpeed}>{speed}x</button>
      {/* onError catches a decode failure that never rejects play() (a corrupt
          or wrongly-typed clip), so the button reflects reality either way. */}
      <audio
        ref={audioRef}
        src={audioUrl || undefined}
        preload="none"
        onError={() => {
          if (audioUrl) {
            setLoadFailed(true);
            setPlaying(false);
          }
        }}
        style={{ display: "none" }}
      />
    </div>
  );
}