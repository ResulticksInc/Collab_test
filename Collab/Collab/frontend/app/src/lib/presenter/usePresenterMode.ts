// Presenter Mode — the shared React hook. Owns the processor lifecycle so the two
// hosts (CoLabV1 calls, MeetingStage meetings) stay a thin wiring layer: pass the
// room ref + the live screen/camera booleans, render the selector, done.

import { useCallback, useEffect, useRef, useState } from "react";
import * as LK from "livekit-client";
import { PresenterProcessor } from "./PresenterProcessor";
import type { PresenterMode } from "./types";

export interface UsePresenterModeResult {
  mode: PresenterMode;
  setMode: (m: PresenterMode) => void;
  /** Sharing screen (selector should be visible). */
  screenOn: boolean;
  /** Camera on (non-standard modes are enabled). */
  cameraOn: boolean;
  degradeLevel: number;
  /** Feed a received `t:"presenter"` signal from a peer (keyed by their sid). */
  ingestSignal: (sid: string, mode: PresenterMode) => void;
  /** Drop a peer from the presenting set (on disconnect). */
  dropPresenter: (sid: string) => void;
  /** Re-announce our active mode — e.g. when a new peer joins mid-presentation. */
  announceMode: () => void;
  /** Sids of remote peers presenting now (their separate camera tile is redundant). */
  presentingSids: Set<string>;
}

export function usePresenterMode(params: {
  roomRef: { current: any };
  screenOn: boolean;
  cameraOn: boolean;
}): UsePresenterModeResult {
  const { roomRef, screenOn, cameraOn } = params;
  const [mode, setModeState] = useState<PresenterMode>("standard");
  const [degradeLevel, setDegradeLevel] = useState(0);
  const procRef = useRef<PresenterProcessor | null>(null);
  const modeRef = useRef<PresenterMode>("standard");
  // The LocalVideoTrack we called setProcessor() on. A full LiveKit reconnect
  // re-publishes the screen track as a NEW object; comparing identity against
  // this lets the watchdog notice and re-attach.
  const attachedTrackRef = useRef<any>(null);
  // Serialize apply() so the watchdog and a user pick can't race into a double
  // setProcessor / double destroy.
  const applyingRef = useRef(false);
  const screenOnRef = useRef(screenOn);
  const presentingSidsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    screenOnRef.current = screenOn;
  }, [screenOn]);

  const getScreenTrack = useCallback(() => {
    const room = roomRef.current;
    const pub = room?.localParticipant?.getTrackPublication?.(
      LK.Track.Source.ScreenShare,
    );
    return ((pub && (pub.videoTrack || pub.track)) as any) || null;
  }, [roomRef]);

  const getCameraMst = useCallback((): MediaStreamTrack | null => {
    const room = roomRef.current;
    const pub = room?.localParticipant?.getTrackPublication?.(
      LK.Track.Source.Camera,
    );
    const t = pub && (pub.track || pub.videoTrack);
    return (t && (t.mediaStreamTrack as MediaStreamTrack)) || null;
  }, [roomRef]);

  const broadcast = useCallback(
    (m: PresenterMode) => {
      const room = roomRef.current;
      if (!room?.localParticipant) return;
      try {
        room.localParticipant.publishData(
          new TextEncoder().encode(JSON.stringify({ t: "presenter", mode: m })),
          { reliable: true },
        );
      } catch {
        /* data channel not ready — non-fatal, composite still works */
      }
    },
    [roomRef],
  );

  // Attach / update / detach the processor to match the requested mode. Also the
  // re-attach path after a reconnect swaps the screen track. Serialized.
  const apply = useCallback(
    async (m: PresenterMode) => {
      if (applyingRef.current) return;
      applyingRef.current = true;
      try {
        let screenTrack = getScreenTrack();
        // MeetingStage flips `screen` true optimistically (before the publication
        // exists), so a fast pick can arrive before the screen track is ready.
        // Wait briefly for it rather than silently no-op.
        if (m !== "standard" && !screenTrack) {
          for (let i = 0; i < 20 && !screenTrack; i++) {
            await new Promise((r) => setTimeout(r, 100));
            if (modeRef.current !== m) return; // superseded by a newer pick
            screenTrack = getScreenTrack();
          }
        }

        // Detach path: standard mode, or the share is gone.
        if (m === "standard" || !screenTrack) {
          if (procRef.current) {
            try {
              await attachedTrackRef.current?.stopProcessor?.();
            } catch {
              /* track may already be gone */
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

        // Reconnect: the published screen track was recreated, so our processor
        // is orphaned on a dead track. Drop it and re-attach to the new one.
        if (
          procRef.current &&
          attachedTrackRef.current &&
          attachedTrackRef.current !== screenTrack
        ) {
          try {
            await procRef.current.destroy();
          } catch {
            /* noop */
          }
          procRef.current = null;
          attachedTrackRef.current = null;
        }

        if (!procRef.current) {
          const proc = new PresenterProcessor({
            getCameraTrack: getCameraMst,
            mode: m,
            onDegrade: (lvl) => setDegradeLevel(lvl),
          });
          procRef.current = proc;
          try {
            await screenTrack.setProcessor(proc as any);
            attachedTrackRef.current = screenTrack;
          } catch (err) {
            console.warn(
              "[presenter] setProcessor failed err=%s",
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
          procRef.current.setMode(m);
        }
      } finally {
        applyingRef.current = false;
      }
    },
    [getScreenTrack, getCameraMst],
  );

  const setMode = useCallback(
    (m: PresenterMode) => {
      setModeState(m);
      modeRef.current = m;
      void apply(m);
      broadcast(m);
    },
    [apply, broadcast],
  );

  // Screen sharing stopped (incl. the browser's own "Stop sharing" bar): tear the
  // processor down and reset to standard so the next share starts clean.
  useEffect(() => {
    if (!screenOn && modeRef.current !== "standard") {
      modeRef.current = "standard";
      setModeState("standard");
      setDegradeLevel(0);
      if (procRef.current) {
        try {
          void procRef.current.destroy();
        } catch {
          /* noop */
        }
        procRef.current = null;
        attachedTrackRef.current = null;
      }
      broadcast("standard");
    }
  }, [screenOn, broadcast]);

  // Reconnect / republish watchdog. After a full LiveKit reconnect the screen
  // track is a new object and our processor is orphaned — without this the
  // presenter silently reverts to a raw share. Cheap identity check every 2.5s.
  useEffect(() => {
    const iv = setInterval(() => {
      if (applyingRef.current) return;
      const m = modeRef.current;
      if (m === "standard" || !screenOnRef.current) return;
      const st = getScreenTrack();
      if (!st) return; // not published yet; the screen-off effect owns teardown
      const lost = !procRef.current;
      const swapped =
        !!attachedTrackRef.current && attachedTrackRef.current !== st;
      if (lost || swapped) void apply(m);
    }, 2500);
    return () => clearInterval(iv);
  }, [getScreenTrack, apply]);

  useEffect(() => {
    return () => {
      if (procRef.current) {
        try {
          void procRef.current.destroy();
        } catch {
          /* noop */
        }
        procRef.current = null;
        attachedTrackRef.current = null;
      }
    };
  }, []);

  const ingestSignal = useCallback((sid: string, m: PresenterMode) => {
    if (!sid) return;
    if (m === "standard") presentingSidsRef.current.delete(sid);
    else presentingSidsRef.current.add(sid);
  }, []);

  const dropPresenter = useCallback((sid: string) => {
    if (sid) presentingSidsRef.current.delete(sid);
  }, []);

  // Re-announce our active mode (a new peer that joined mid-presentation needs it
  // to hide our redundant camera tile). No-op when we aren't presenting.
  const announceMode = useCallback(() => {
    if (modeRef.current !== "standard") broadcast(modeRef.current);
  }, [broadcast]);

  return {
    mode,
    setMode,
    screenOn,
    cameraOn,
    degradeLevel,
    ingestSignal,
    dropPresenter,
    announceMode,
    presentingSids: presentingSidsRef.current,
  };
}
