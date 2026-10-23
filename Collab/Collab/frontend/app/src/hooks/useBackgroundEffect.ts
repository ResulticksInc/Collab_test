import { useCallback, useEffect, useRef, useState } from "react";
import * as LK from "livekit-client";
import {
  BackgroundProcessor,
  type BackgroundMode,
} from "../lib/meeting/BackgroundProcessor";

// Background blur / replace for the local camera.
//
// Owns the processor lifecycle so both hosts (meetings and the call dock) stay
// thin wiring. Mirrors usePresenterMode deliberately — same attach/reattach and
// serialisation problems, so the same shape of solution.
//
// Two lifecycle hazards it exists to handle:
//   • The camera track is a NEW object after a device switch or a LiveKit
//     reconnect, which orphans a processor attached to the old one. The watchdog
//     below notices by identity and re-attaches.
//   • Turning the camera off and on republishes the track, so the effect has to
//     be re-applied rather than assumed to persist.
//
// The choice is remembered per device in localStorage: someone who blurs their
// background does not want to re-choose it at the start of every meeting.

const STORE_KEY = "clb_bg_mode";
const STORE_IMG = "clb_bg_image";

function readStored(): { mode: BackgroundMode; imageUrl: string | null } {
  try {
    const m = localStorage.getItem(STORE_KEY) as BackgroundMode | null;
    const img = localStorage.getItem(STORE_IMG);
    return {
      mode: m === "blur" || m === "image" ? m : "none",
      imageUrl: img || null,
    };
  } catch {
    return { mode: "none", imageUrl: null };
  }
}

export interface UseBackgroundEffectResult {
  mode: BackgroundMode;
  setMode: (m: BackgroundMode, imageUrl?: string | null) => void;
  imageUrl: string | null;
  /** 0 = full quality; 1..2 = segmenting less often to hold the frame rate. */
  degradeLevel: number;
  /** True once the camera is live and an effect can actually be applied. */
  available: boolean;
}

export function useBackgroundEffect(params: {
  roomRef: { current: any };
  cameraOn: boolean;
}): UseBackgroundEffectResult {
  const { roomRef, cameraOn } = params;
  const initial = typeof window === "undefined" ? { mode: "none" as BackgroundMode, imageUrl: null } : readStored();
  const [mode, setModeState] = useState<BackgroundMode>(initial.mode);
  const [imageUrl, setImageUrl] = useState<string | null>(initial.imageUrl);
  const [degradeLevel, setDegradeLevel] = useState(0);

  const procRef = useRef<BackgroundProcessor | null>(null);
  const attachedTrackRef = useRef<any>(null);
  const applyingRef = useRef(false);
  const modeRef = useRef<BackgroundMode>(initial.mode);
  const imageRef = useRef<string | null>(initial.imageUrl);

  const getCameraTrack = useCallback(() => {
    const room = roomRef.current;
    const pub = room?.localParticipant?.getTrackPublication?.(LK.Track.Source.Camera);
    return ((pub && (pub.videoTrack || pub.track)) as any) || null;
  }, [roomRef]);

  const apply = useCallback(async () => {
    if (applyingRef.current) return;
    applyingRef.current = true;
    try {
      const track = getCameraTrack();
      const want = modeRef.current;

      // No camera to attach to — drop any processor we still hold so it cannot
      // leak a canvas loop while the camera is off.
      if (!track) {
        if (procRef.current) {
          try {
            await procRef.current.destroy();
          } catch {
            /* noop */
          }
          procRef.current = null;
          attachedTrackRef.current = null;
          setDegradeLevel(0);
        }
        return;
      }

      // The published track was recreated (device switch / reconnect): our
      // processor is attached to a dead object. Drop and re-attach.
      if (
        procRef.current &&
        attachedTrackRef.current &&
        attachedTrackRef.current !== track
      ) {
        try {
          await procRef.current.destroy();
        } catch {
          /* noop */
        }
        procRef.current = null;
        attachedTrackRef.current = null;
      }

      if (want === "none") {
        if (procRef.current) {
          try {
            await track.stopProcessor?.();
          } catch {
            /* noop */
          }
          try {
            await procRef.current.destroy();
          } catch {
            /* noop */
          }
          procRef.current = null;
          attachedTrackRef.current = null;
          setDegradeLevel(0);
        }
        return;
      }

      if (!procRef.current) {
        const proc = new BackgroundProcessor({
          mode: want,
          imageUrl: imageRef.current,
          onDegrade: (lvl) => setDegradeLevel(lvl),
        });
        procRef.current = proc;
        try {
          await track.setProcessor(proc as any);
          attachedTrackRef.current = track;
        } catch (err) {
          // Never leave the camera dark because an effect failed — the raw
          // track keeps publishing and the user simply has no background.
          console.warn(
            "[background] setProcessor failed err=%s",
            (err as any)?.message || err,
          );
          try {
            await proc.destroy();
          } catch {
            /* noop */
          }
          procRef.current = null;
          attachedTrackRef.current = null;
          setDegradeLevel(0);
        }
      } else {
        // Already attached — switch blur/image in place, no camera flicker.
        procRef.current.setMode(want, { imageUrl: imageRef.current });
      }
    } finally {
      applyingRef.current = false;
    }
  }, [getCameraTrack]);

  const setMode = useCallback(
    (m: BackgroundMode, url?: string | null) => {
      modeRef.current = m;
      setModeState(m);
      if (url !== undefined) {
        imageRef.current = url;
        setImageUrl(url);
      }
      try {
        localStorage.setItem(STORE_KEY, m);
        if (url !== undefined) {
          if (url) localStorage.setItem(STORE_IMG, url);
          else localStorage.removeItem(STORE_IMG);
        }
      } catch {
        /* private mode — the choice just won't persist */
      }
      void apply();
    },
    [apply],
  );

  // Re-apply whenever the camera comes on, and poll for a track swap the way
  // presenter mode does: LiveKit gives no event for "your camera track object
  // was replaced", and a stale processor is invisible until someone says the
  // blur stopped working.
  useEffect(() => {
    void apply();
    if (!cameraOn) return;
    const iv = setInterval(() => {
      const track = getCameraTrack();
      if (track && attachedTrackRef.current && track !== attachedTrackRef.current) void apply();
      if (track && !attachedTrackRef.current && modeRef.current !== "none") void apply();
    }, 2000);
    return () => clearInterval(iv);
  }, [cameraOn, apply, getCameraTrack]);

  // Tear down on unmount so a canvas + segmenter never outlive the meeting.
  useEffect(
    () => () => {
      const p = procRef.current;
      procRef.current = null;
      attachedTrackRef.current = null;
      if (p) void p.destroy().catch(() => {});
    },
    [],
  );

  return { mode, setMode, imageUrl, degradeLevel, available: !!cameraOn };
}
