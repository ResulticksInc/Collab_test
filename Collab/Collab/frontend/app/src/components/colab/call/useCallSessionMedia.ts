import { useEffect, useRef } from "react";
import * as LK from "livekit-client";
import { api } from "../../../lib/api";
import { SpatialAudioManager } from "../../../lib/spatialAudio";
import { applyPresenterHidden } from "../../../lib/presenter/presenterTiles";
import { applyTileGrid } from "../../../lib/tileGrid";
import { e2eeRoomOptions, enableRoomE2EE, isCallMediaE2EEOn } from "../../../lib/e2ee/callMedia";
import { getCallMediaKey } from "../../../lib/e2ee/manager";
import { log } from "../../../lib/logger";
import { mediaBlockedReason, preferSecureWsUrl, preferredVideoCodec } from "../../../lib/mediaSupport";
import { classifyMediaError } from "../../../lib/mediaErrors";
import { startMicWatchdog } from "../../../lib/micWatchdog";
import { openScreenPopout, closePopout, closeAllPopouts, popoutCapability } from "../../../lib/screenPopout";
import { hiddenReasons } from "../../../lib/stageVisibility";
import { createCallDiagnostics, turnAdvertisedIn, type CallDiagnostics } from "../../../lib/callDiagnostics";
import { fire } from "../../../lib/dispatchNotif";
import { PARTICIPANT_MENU_ICON } from "../../ParticipantMenu";
import { fsRequest, fsExit, fsElement } from "../helpers";
import { avatarUrlOf, paintAvatar, baseUid, roleOf, gradientAngleOf, applyTilePalette } from "../../../lib/meeting/identity";
import { pageSlice } from "../../../lib/galleryPaging";
import {
  galleryRank, railRank, sortByRank, tileHasVideo, layoutRail, clearRailTile,
  enablePipDrag, setTileHand, flashTileReaction, railSideFor, setTileSpeaking,
  attachAdaptiveVideoFit,
} from "../../../lib/stageView";
import { resolveMediaUrl } from "../../../lib/image";
import { CAMERA_CAPTURE, CALL_VIDEO_MAX_BITRATE, prioritizeAudioSender } from "../../../lib/mediaQuality";
import type { CallModalProps } from "./types";
import { useCallSessionCore } from "./useCallSessionCore";
import { useCallSessionControls } from "./useCallSessionControls";

// useCallSessionMedia: LiveKit SFU room lifecycle (connect/tiles/data-channel/teardown).
export function useCallSessionMedia(
  props: CallModalProps,
  core: ReturnType<typeof useCallSessionCore>,
  controls: ReturnType<typeof useCallSessionControls>,
) {
  const {
    audioRef, callChatMutedRef, callChatNotifSoundRef, callChatVisibleRef, callFocusedScreenPidRef, callId, callPinAreaRef, callPinnedRef,
    callPinnedSids, callPipSwapRef, callRoomSidRef, callRoster, callScreenViewModeRef, callStripRef, callViewModeRef, cam,
    connecting, everConnectedRef, fullscreen, handRaisedRef, isGroup, kind, lkConnectingRef, lkDisconnectingRef,
    localStreamRef, mediaRetryKey, mic, openCallTileMenuRef, peer, peerRecorderRef, pipRef, playCallChatDing,
    presenter, recAddAudioRef, recording, recordingRef, refreshCallScreenSharesRef, refreshRoster, rejoinAttemptsRef, relayoutGridRef,
    remoteStreamRef, roomRef, screen, screenStreamRef, secRef, setAudioBlocked, setCallChatMsgs, setCallChatUnread,
    setCallDiag, setCallHands, setCallPinnedSids, setCallPipSwap, setCallReactions, setCallTileMicRef, setCallTotalTiles, setCam,
    setConnecting, setDevices, setMediaError, setMediaPhase, setMediaRetryKey, setMic, setNetQuality, setPeerRecording,
    setRcSharer, setRemoteJoined, setRemoteVideoOn, setScreen, setScreenPending, setSelCam, setSelMic, setSelSpk,
    setShowCallWhiteboard, setWbResyncNonce, sinkRef, spatialRef, spkRef, stageRef, status, tilesRef,
    toggleCallPin, video, wbReceiverRef,
    callPageRef, callPageSizeRef, setCallPage, setCallPageCount, callActiveSpeakerRef,
    callSpotlightRef, callSpotlightEscapedRef, setCallSpotlightUids, setCallSpotlightBy,
    setCallSpotlightEscaped, publishCallSpotlight, isCallHost,
    callHandsRef, callViewPrefsRef, setCallViewPref,
  } = core;
  const { syncLocalMicState, isMicPublication } = controls;
  const { call, token, onHangup, showToast, settings, pip, resolveCallMediaCtx } = props;

  // MIC-04: render-synced ref mirrors of the CURRENT mic/cam intent. The connect
  // effect below deliberately omits `mic`/`cam` from its deps (re-running it
  // would tear the room down), so its Reconnected closure captured the JOIN-TIME
  // values — a user who muted mid-call was silently UNMUTED by the next network
  // blip, with the dock still showing muted (the Sev-1 divergence class). These
  // refs re-sync on every render, so event handlers always read the live intent.
  // POP-01/02: pop-out windows for remote screen shares, keyed by tile key.
  // Closed on call end (cleanup below) and when a share stops (detach).
  const callPipWindowsRef = useRef<Map<string, Window>>(new Map());
  // Tile keys currently living in a pop-out window. relayoutGrid drops these from
  // the grid so the call falls back to its DEFAULT view instead of keeping a dead
  // "Popped out" card in the main slot (the meeting stage does the same).
  const callPoppedOutRef = useRef<Set<string>>(new Set());
  useEffect(() => () => closeAllPopouts(callPipWindowsRef.current), []);
  const micIntentRef = useRef(mic);
  micIntentRef.current = mic;
  const camIntentRef = useRef(cam);
  camIntentRef.current = cam;

  // MIC-22/23: mic health watchdog (shared with MeetingStage — one health
  // policy). A capture device that dies mid-call is re-acquired automatically
  // with a visible "Reconnecting your microphone…"; sustained failure surfaces
  // the product-owned guidance instead of a silent dead mic. Also reports the
  // initial mute intent the moment the call settles, so server-side enforcement
  // (MIC-02) is armed from the first second.
  useEffect(() => {
    if (status !== "connected") return;
    const room0 = roomRef.current;
    if (room0 && room0.name)
      api.reportMuteState(token, room0.name, !micIntentRef.current).catch(() => {});
    const stop = startMicWatchdog({
      getRoom: () => roomRef.current,
      getIntent: () => micIntentRef.current,
      onStatus: (s) => {
        if (s.kind === "reconnecting") {
          if (s.attempt === 1) showToast("Reconnecting your microphone…");
        } else if (s.kind === "recovered") {
          showToast(
            s.label ? `Microphone reconnected — using ${s.label}` : "Microphone reconnected",
          );
        } else {
          const g = classifyMediaError(s.error, "microphone");
          showToast(g.silent ? "Collab couldn't reconnect your microphone — pick another device in Settings." : `${g.title} ${g.steps[0] || ""}`.trim());
        }
      },
    });
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);
  useEffect(() => {
    const INST = Math.random().toString(36).substring(2, 8);
    const mountTs = Date.now();
    console.warn(
      "[call] EFFECT_MOUNT inst=%s ts=%d callId=%s convId=%s status=%s hasToken=%s",
      INST,
      mountTs,
      callId,
      call.conversationId,
      status,
      !!token,
    );
    if (status !== "connected" || !token) {
      console.warn(
        "[call] EFFECT_MOUNT_SKIP inst=%s reason=status=%s token=%s",
        INST,
        status,
        !!token,
      );
      return;
    }
    if (!call.conversationId && !callId) {
      console.warn("[call] EFFECT_MOUNT_SKIP inst=%s reason=noCallId", INST);
      return;
    }
    // Re-entry guard keyed on the STABLE call id: if another mount for THIS call
    // is already mid-connect, bail so we don't join twice with the same identity.
    // A genuine redial (new callId) or a post-cleanup remount has a free slot.
    const callKey = call.conversationId
      ? `conv:${call.conversationId}`
      : `call:${callId}`;
    if (lkConnectingRef.current === callKey) {
      console.warn(
        "[call] EFFECT_MOUNT_SKIP inst=%s reason=concurrent_connect key=%s",
        INST,
        callKey,
      );
      return;
    }
    lkConnectingRef.current = callKey;
    let cancelled = false;
    let stageRO: ResizeObserver | null = null;
    let speakerDebounce: any = null; // active-speaker follow (Participant view)
    let room: any = null;
    const localCleanup: (() => void)[] = [];
    let subAudio = 0;
    let subVideo = 0;
    everConnectedRef.current = false;
    // Fresh call → clear any stale reactions / raised hands / pins from a prior call.
    setCallReactions([]);
    setCallHands([]);
    setCallPinnedSids([]);
    handRaisedRef.current = false;

    // Connect watchdog (demo safety net): if media never connects within 25s —
    // e.g. room.connect() hangs on a hostile network/firewall where TURN is
    // unreachable — flip to a clear failure with retry instead of an endless
    // "connecting…" spinner.
    const connectWatchdog = setTimeout(() => {
      if (!cancelled && !everConnectedRef.current) {
        console.warn("[call] CONNECT_WATCHDOG_TIMEOUT inst=%s", INST);
        setMediaError(
          "Couldn't reach the media server — this is usually a network or firewall issue. Try again, or switch networks.",
        );
        setMediaPhase("failed");
        setConnecting(false);
      }
    }, 25000);
    localCleanup.push(() => clearTimeout(connectWatchdog));

    // FIX: capture refs at effect start for use in cleanup
    const stageCurrent = stageRef.current;
    const audioCurrent = audioRef.current;
    const tilesCurrent = tilesRef.current;

    // Hoisted so the catch/cleanup can reference it (a const inside try is not
    // in scope in catch). Assigned once the token is in hand.
    let diag: CallDiagnostics | null = null;
    (async () => {
      try {
        // Wait for any prior disconnect to finish (StrictMode remount safety)
        if (lkDisconnectingRef.current) {
          console.warn("[call] WAITING_PRIOR_DISCONNECT inst=%s", INST);
          await lkDisconnectingRef.current;
          lkDisconnectingRef.current = null;
          // Extra settling time for LiveKit server to process the disconnect
          await new Promise((r) => setTimeout(r, 300));
          if (cancelled) return;
        }
        setConnecting(true);
        setMediaError(null);
        setMediaPhase("connecting_media");
        setRemoteJoined(false);
        setRemoteVideoOn(false);
        setNetQuality("unknown");
        const body: any = call.conversationId
          ? { conversationId: call.conversationId }
          : { callId };
        // fresh: replace any prior session of mine in this room (one tile per
        // user). EXCEPTION — a "Continue here too" device handoff (P0-12) joins
        // ALONGSIDE the user's other device, so it must NOT evict it.
        body.fresh = call.handoffJoin ? false : true;
        const [res] = await Promise.all([api.getCallToken(token, body)]);
        if (cancelled) return;
        // Spin up the diagnostics trail. turnAdvertised tells us up-front whether
        // the backend even handed the browser a TURN relay — if not, off-network
        // calls cannot traverse symmetric NAT and WILL fail at ICE.
        const _turnAdvertised = turnAdvertisedIn(
          (res as any) && (res as any).iceServers,
        );
        diag = createCallDiagnostics(INST, { turnAdvertised: _turnAdvertised });
        setCallDiag(diag);
        localCleanup.push(() => diag.stop());
        diag.log("Token Generated", {
          room: (res as any) && (res as any).room,
          iceServers: (((res as any) && (res as any).iceServers) || []).length,
          turnAdvertised: _turnAdvertised,
        });
        // Secure-context preflight. On a plain-HTTP LAN origin the browser hides
        // navigator.mediaDevices, so getUserMedia throws an opaque error and the
        // call dies as "Unable to connect to media server". Detect it up front
        // and surface actionable guidance instead of crashing.
        const _mediaReason = mediaBlockedReason();
        if (_mediaReason) {
          console.warn(
            "[call] MEDIA_UNAVAILABLE inst=%s reason=%s",
            INST,
            _mediaReason,
          );
          if (!cancelled) {
            setMediaError(_mediaReason);
            setMediaPhase("failed");
            setConnecting(false);
          }
          return;
        }
        const _sx = settings || {};
        const _aCap: any = {
          noiseSuppression: _sx.noiseSuppression !== false,
          echoCancellation: _sx.echoCancellation !== false,
          // Supplying our own audioCaptureDefaults REPLACES LiveKit's defaults,
          // which include autoGainControl:true — omitting it left AGC unset, so the
          // mic could boost residual speaker-to-mic bleed and amplify echo. Set it
          // explicitly so the full AEC/NS/AGC triad is always applied.
          autoGainControl: _sx.autoGainControl !== false,
        };
        // Pin the saved mic ONLY when it still exists. A stale micId (a Bluetooth
        // headset that has since disconnected, or a USB mic unplugged) would force
        // capture of a PHANTOM device → a silent track nobody can hear. If the
        // device list shows inputs but not this one, it's gone → drop it and let
        // LiveKit use the system default. Empty/failed enumeration keeps the old
        // behavior so this can't regress the normal case.
        let _micOk = !!_sx.micId;
        if (_sx.micId) {
          try {
            const _ins = (await navigator.mediaDevices.enumerateDevices()).filter(
              (d) => d.kind === "audioinput" && d.deviceId,
            );
            if (_ins.length && !_ins.some((d) => d.deviceId === _sx.micId)) _micOk = false;
          } catch {
            /* keep _micOk = true — trust the saved id when we can't enumerate */
          }
        }
        if (_micOk) _aCap.deviceId = _sx.micId;
        // Explicit 720p30 capture — shared with the meeting path (lib/mediaQuality
        // explains why 720p, not 1080p, is the better top rung).
        const _vCap: any = { ...CAMERA_CAPTURE };
        if (_sx.cameraId) _vCap.deviceId = _sx.cameraId;
        const _out: any = {};
        if (_sx.speakerId) _out.deviceId = _sx.speakerId;
        sinkRef.current = _sx.speakerId || "";
        // External TURN relay advertised by the backend (coturn). Lets off-LAN /
        // global callers relay media over turns://<domain> when they can't reach
        // the SFU's node_ip directly. ICE tries direct first, then this relay.
        const _ice = ((res as any) && (res as any).iceServers) || [];
        room = new LK.Room({
          adaptiveStream: true,
          dynacast: true,
          ...e2eeRoomOptions(), // {} unless E2EE is enabled → ctor unchanged when off
          ...(_ice.length ? { rtcConfig: { iceServers: _ice } } : {}),
          // MIC-01 / D-1(a) hard mute: mute STOPS CAPTURE (track stopped, OS
          // mic indicator off) — mirrors MeetingStage, one mute semantics.
          stopMicTrackOnMute: true,
          audioCaptureDefaults: _aCap,
          videoCaptureDefaults: _vCap,
          audioOutput: _out,
          // Simulcast ladder + a feature-DETECTED publish codec (never hardcoded):
          // whatever THIS browser can encode — Chrome/Firefox → VP9, Safari-mac →
          // H.264, otherwise VP8 — chosen only from codecs every browser can
          // decode, so all participants interoperate. undefined ⇒ let
          // livekit-client negotiate. (The old hardcoded VP9 was un-encodable on
          // Safari-mac → the "dead video / screenshare on Mac" reports.)
          publishDefaults: {
            simulcast: true,
            videoSimulcastLayers: [
              (LK.VideoPresets as any).h180,
              (LK.VideoPresets as any).h360,
            ],
            videoCodec: preferredVideoCodec(),
            videoEncoding: { maxBitrate: CALL_VIDEO_MAX_BITRATE, maxFramerate: 30 },
            dtx: true,
            red: true,
          } as any,
          disconnectOnPageLeave: false,
          // 10 attempts over ~60s instead of 5/~17s. Real-world recovery
          // (laptop wake, VPN handover, wifi flap) commonly takes 30-60s; the
          // tighter 17s budget killed otherwise-recoverable calls.
          reconnectPolicy: {
            nextRetryDelayInMs: (context: any) => {
              if (context.retryCount > 10) return null;
              return Math.min(500 * Math.pow(1.6, context.retryCount), 7000);
            },
          },
        });
        roomRef.current = room;
        // Room SID for the call-chat dedup key. Async in livekit-client v2
        // (getSid resolves once connected); a sync string fallback covers older
        // API shapes. Reset first so a reconnect never carries a stale SID.
        callRoomSidRef.current = null;
        try {
          const sidP = (room as any).getSid
            ? (room as any).getSid()
            : (room as any).sid;
          if (sidP && typeof sidP.then === "function")
            sidP
              .then((s: string) => {
                callRoomSidRef.current = s || null;
              })
              .catch(() => {});
          else if (typeof sidP === "string" && sidP)
            callRoomSidRef.current = sidP;
        } catch (_) {}
        console.warn(
          "[call] ROOM_CREATE inst=%s room=%s",
          INST,
          room && (room.name || room.roomName || Object.keys(room).length),
        );

        // Capture LiveKit tracks into MediaStream refs so call recording can mix
        // BOTH local and remote audio (and include video). Without this the refs
        // stayed null and recording fell back to local-mic-only.
        // Remove a track from the recording refs when it goes away. WITHOUT this
        // the refs were append-only, so a recording started later grabbed the
        // FIRST video track ever seen — often an ended screen share or a
        // switched-off camera. A dead track emits no frames, the encoder stalls,
        // and the blob comes out as a ~110-byte header → the bogus "Recording was
        // empty" report. This is the main cause of recordings being hit-or-miss.
        const dropTrk = (mst: any) => {
          if (!mst) return;
          for (const ref of [localStreamRef, remoteStreamRef]) {
            try {
              const s = ref.current;
              if (!s) continue;
              const hit = s.getTracks().find((t: any) => t.id === mst.id);
              if (hit) s.removeTrack(hit);
            } catch (_) {
              /* ignore */
            }
          }
        };
        const addTrk = (ref: any, mst: any) => {
          if (!mst) return;
          if (!ref.current) ref.current = new MediaStream();
          try {
            if (!ref.current.getTracks().some((t: any) => t.id === mst.id))
              ref.current.addTrack(mst);
          } catch (_) {
            /* ignore */
          }
        };
        // Participant-first tile: create an avatar placeholder for every
        // participant who joins, BEFORE any video track arrives. This mirrors
        // MeetingStage's updateParticipants/ensureTile approach: tiles represent
        // PEOPLE, not video streams. A participant with camera OFF should still
        // appear as an avatar tile, not disappear from the layout.
        const TILE_COLORS = ["#6366f1","#0ea5e9","#10b981","#f59e0b","#ef4444","#8b5cf6","#ec4899","#14b8a6"];
        function tileColorOf(key: string) { let h=0; for(let i=0;i<key.length;i++) h=(h*31+key.charCodeAt(i))>>>0; return TILE_COLORS[h%TILE_COLORS.length]; }
        function tileInitials(name: string) { return (name||"?").trim().split(/\s+/).map(w=>w[0]).slice(0,2).join("").toUpperCase()||"?"; }
        // Base user id from a LiveKit identity ("<userId>__<join-uuid>").
        const uidOf = (identity: string) => String(identity || "").split("__")[0];
        // "Same profile connected 3 times": remove any EXISTING tiles for the
        // same HUMAN (base identity) but a DIFFERENT sid — a stale/duplicate
        // session (reload / 2nd tab / auto-rejoin ghost) — keeping the call grid
        // to one tile per person. Screen + camera of the SAME session share one
        // sid, so they're never removed against each other.
        const dedupeUserTiles = (uid: string, keepSid: string) => {
          if (!uid) return;
          for (const [k, v] of [...tilesRef.current.entries()]) {
            const t: any = v.tile;
            if (t && t.dataset && t.dataset.uid === uid && t.dataset.pid !== keepSid) {
              try { v.track && (v.track as any).detach && (v.track as any).detach().forEach((e: any) => e.remove()); } catch (_) {}
              try { t.remove(); } catch (_) {}
              tilesRef.current.delete(k);
            }
          }
        };
        // Live per-tile MIC-MUTED indicator. Appended to every people tile;
        // shown when that participant's mic is OFF. Driven imperatively by the
        // TrackMuted/TrackUnmuted listeners + the local mic toggle (setCallTileMic)
        // — calls previously had NO mic listeners, so the tiles never reflected it.
        // Round mic chip in the tile's bottom-RIGHT corner (reference tile): a
        // mic glyph while live, the slashed mic when muted (`.muted`).
        const MIC_SVGS =
          '<svg class="mic-on" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/></svg>' +
          '<svg class="mic-off" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/></svg>';
        const addMicBadge = (tile: HTMLElement, muted: boolean) => {
          let b = tile.querySelector(".cv-tile-mic") as HTMLElement | null;
          if (!b) {
            b = document.createElement("span");
            b.className = "cv-tile-mic";
            b.innerHTML = MIC_SVGS;
            tile.appendChild(b);
          }
          b.classList.toggle("muted", muted);
          b.setAttribute("aria-label", muted ? "Microphone muted" : "Microphone on");
        };
        const setCallTileMic = (sid: string, muted: boolean) => {
          const st = stageRef.current;
          if (!st) return;
          st.querySelectorAll('[data-pid="' + sid + '"]').forEach((t: any) => {
            if (t.dataset.screen === "true") return; // screen tiles have no mic
            addMicBadge(t as HTMLElement, muted);
          });
        };
        setCallTileMicRef.current = setCallTileMic;
        // Profile photo for a camera-off tile: from the participant's token
        // metadata (falls back to the public per-user endpoint by identity).
        const avatarUrlForSid = (sid: string, identity = ""): string => {
          const r: any = roomRef.current;
          let p: any = null;
          if (r) {
            if (r.localParticipant && r.localParticipant.sid === sid) p = r.localParticipant;
            else (r.remoteParticipants || new Map()).forEach((x: any) => { if (x.sid === sid) p = x; });
          }
          return resolveMediaUrl(avatarUrlOf(p || (identity ? { identity } : null)));
        };
        // One builder for every camera-off placeholder (initials circle with the
        // profile photo layered on top) so the join-time avatar tile, the
        // unpublish fallback and the mute fallback all look identical.
        const makeAvatarPlaceholder = (sid: string, name: string, identity = "") => {
          const ph = document.createElement("div");
          ph.className = "cv-avatar-ph";
          Object.assign(ph.style, {
            position: "absolute", top: "50%", left: "50%",
            transform: "translate(-50%,-50%)",
            width: "72px", height: "72px",
            borderRadius: "50%",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: "24px", fontWeight: "700", color: "#fff",
          });
          // Accent on a CSS variable so call.css can draw the pastel disc +
          // accent initials (same look as the meeting tiles).
          ph.style.setProperty("--av", tileColorOf(sid));
          ph.textContent = tileInitials(name);
          paintAvatar(ph, avatarUrlForSid(sid, identity));
          return ph;
        };
        const tileDisplayName = (tile: HTMLElement) =>
          (((tile.querySelector(".cv-tile-label") as any) || {}).textContent || "")
            .replace(/ \(you\)$/, "");
        // Camera MUTED (not unpublished): livekit-client's setCameraEnabled(false)
        // only mutes the camera publication — the track stays published and its
        // <video> stays in the tile, frozen/black. Nothing reached detach(), so
        // the tile never fell back to the avatar (the "my picture isn't shown
        // when I turn my camera off" report). Hide the <video> and lay the avatar
        // over it; on unmute LiveKit re-feeds the same element, so just reveal it.
        const setTileCameraOff = (sid: string, off: boolean) => {
          for (const v of tilesRef.current.values()) {
            const tile = v.tile;
            if (tile.dataset.pid !== sid || tile.dataset.screen === "true") continue;
            if (!v.track) continue; // avatar-only tile — already shows the avatar
            tile.querySelectorAll(".cv-vid").forEach((e: any) => {
              e.style.display = off ? "none" : "";
            });
            const ph = tile.querySelector(".cv-avatar-ph");
            if (off) {
              if (!ph) tile.insertBefore(makeAvatarPlaceholder(sid, tileDisplayName(tile)), tile.firstChild);
            } else if (ph) ph.remove();
            tile.dataset.camOff = off ? "true" : "false";
          }
        };
        const isCameraPublication = (pub: any) =>
          !!pub &&
          pub.kind === "video" &&
          pub.source !== LK.Track.Source.ScreenShare &&
          pub.source !== LK.Track.Source.ScreenShareAudio;
        const ensureCallTile = (sid: string, name: string, isLocal: boolean, identity = "", micOn = true) => {
          // Check if a tile already exists for this participant (any key starting with this sid)
          const exists = [...tilesRef.current.keys()].some(k => k.startsWith(sid + ":"));
          if (exists) return;
          const uid = uidOf(identity);
          if (uid) dedupeUserTiles(uid, sid); // drop this user's ghost sessions first
          const key = sid + ":avatar";
          const tile = document.createElement("div");
          tile.className = "cv-tile";
          tile.dataset.pid = sid;
          tile.dataset.uid = uid;
          tile.dataset.key = key;
          // Per-person accent on the tile: seeds the camera-off gradient backdrop.
          tile.style.setProperty("--av", tileColorOf(sid));
          tile.style.setProperty("--av-angle", gradientAngleOf(sid) + "deg");
          applyTilePalette(tile, String(uid || sid), stageRef.current);
          tile.dataset.local = isLocal ? "true" : "false";
          Object.assign(tile.style, {
            position: "relative",
            background: "var(--meet-tile)",
            borderRadius: "10px",
            border: "none",
            boxShadow: "none",
            overflow: "hidden",
            width: "100%", height: "100%",
            minWidth: "0", minHeight: "0",
            outline: "none",
          });
          tile.appendChild(makeAvatarPlaceholder(sid, name, identity));
          const label = document.createElement("div");
          label.className = "cv-tile-label";
          const labelName = document.createElement("span");
          labelName.className = "cv-tile-name";
          labelName.textContent = name + (isLocal && !/^you$/i.test(name) ? " (you)" : "");
          label.appendChild(labelName);
          label.insertAdjacentHTML("beforeend", '<span class="label-wave" aria-hidden="true"><i></i><i></i><i></i><i></i></span>');
          Object.assign(label.style, {
            position: "absolute", left: "12px", bottom: "12px",
            maxWidth: "calc(100% - 24px)",
            color: "#fff", fontSize: "15px", fontWeight: "500",
            letterSpacing: "-0.01em",
            padding: "8px 20px", borderRadius: "79px",
            background: "var(--call-overlay, rgba(0,0,0,.3))",
            border: "none",
            boxShadow: "none",
            backdropFilter: "blur(14px) saturate(1.2)",
            WebkitBackdropFilter: "blur(14px) saturate(1.2)",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          });
          tile.appendChild(label);
          addMicBadge(tile, !micOn); // live mic-muted indicator
          // Pin + fullscreen buttons so AVATAR tiles match video tiles — both
          // clients then show the same controls on a panel tile regardless of
          // whether that participant's camera is on. (attach() guards against
          // double-adding when a video track later reuses this tile.)
          const pinBtn = document.createElement("button");
          pinBtn.className = "cv-pin-btn";
          pinBtn.type = "button";
          pinBtn.setAttribute("aria-label", "Pin for me");
          pinBtn.title = "Pin for me";
          pinBtn.innerHTML =
            '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4h6l-1 6 3 3v2H7v-2l3-3z"/><line x1="12" y1="15" x2="12" y2="21"/></svg>';
          pinBtn.onclick = (ev: any) => {
            ev.stopPropagation();
            toggleCallPin(sid);
          };
          tile.appendChild(pinBtn);
          const fsBtn = document.createElement("button");
          fsBtn.className = "cv-fs-btn";
          fsBtn.type = "button";
          fsBtn.setAttribute("aria-label", "Fullscreen tile");
          fsBtn.title = "Fullscreen";
          fsBtn.innerHTML =
            '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
          fsBtn.onclick = (ev: any) => {
            ev.stopPropagation();
            if (fsElement() === tile) fsExit();
            else fsRequest(tile);
          };
          tile.appendChild(fsBtn);
          if (!isLocal) {
            tile.dataset.name = name;
            const menuBtn = document.createElement("button");
            menuBtn.className = "cv-menu-btn";
            menuBtn.type = "button";
            menuBtn.setAttribute("aria-label", "Participant options");
            menuBtn.setAttribute("aria-haspopup", "menu");
            menuBtn.title = "More options";
            menuBtn.innerHTML = PARTICIPANT_MENU_ICON;
            menuBtn.onclick = (ev: any) => {
              ev.stopPropagation();
              openCallTileMenuRef.current(menuBtn, tile);
            };
            tile.appendChild(menuBtn);
          }
          stageRef.current && stageRef.current.appendChild(tile);
          tilesRef.current.set(key, { tile, track: null });
          relayoutGrid();
        };
        const attach = (track: any, participant: any) => {
          if (track.kind === "audio" && participant.isLocal) return;
          if (track.kind === "audio") {
            addTrk(remoteStreamRef, track.mediaStreamTrack); // recording capture (unchanged)
            // Spatial routing first (Web Audio panner). On success the manager
            // carries speaker-mute + output-device that the <audio> element used
            // to; on failure fall back to the element path below.
            if (!spatialRef.current) {
              spatialRef.current = new SpatialAudioManager();
              // Masked off — force disabled. This used to read the persisted
              // preference; with the toggle gone that would silently keep
              // panning audio for anyone who had previously enabled it.
              try {
                spatialRef.current.setEnabled(false);
              } catch (_) {}
            }
            if (
              spatialRef.current.attach(
                participant.sid,
                track,
                audioRef.current,
              )
            ) {
              spatialRef.current.setMuted(!spkRef.current);
              if (sinkRef.current)
                spatialRef.current.setSinkId(sinkRef.current);
              return;
            }
            const ael = track.attach();
            ael.autoplay = true;
            ael.muted = !spkRef.current;
            const _sk = sinkRef.current;
            if (_sk && ael.setSinkId) ael.setSinkId(_sk).catch(() => {});
            audioRef.current && audioRef.current.appendChild(ael);
            ael.play && ael.play().catch(() => {});
            return;
          }
          const el = track.attach();
          // video track — capture for recording (local→local ref, remote→remote ref)
          addTrk(
            participant.isLocal ? localStreamRef : remoteStreamRef,
            track.mediaStreamTrack,
          );
          const trackKey = participant.sid + ":" + (track.sid || "v");
          const isScreen = track.source === LK.Track.Source.ScreenShare;

          // SELF SCREEN-SHARE: never render your OWN shared screen back to you —
          // the loopback is what creates the infinite "hall of mirrors" (your
          // shared screen shows the call, which shows your shared screen, …).
          // Show a placeholder; the remote side still receives the real screen.
          // Mirrors MeetingStage — "what we do in meetings, we do in calls".
          if (isScreen && participant.isLocal) {
            const sTile = document.createElement("div");
            sTile.className = "cv-tile cv-self-screen";
            sTile.dataset.pid = participant.sid;
            sTile.dataset.uid = uidOf(participant.identity);
            sTile.dataset.key = trackKey;
            sTile.dataset.screen = "true";
            sTile.dataset.local = "true";
            Object.assign(sTile.style, {
              position: "relative",
              background: "var(--meet-tile)",
              borderRadius: "6px",
              border: "1px solid rgba(255,255,255,.06)",
              overflow: "hidden",
              width: "100%",
              height: "100%",
              minWidth: "0",
              minHeight: "0",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            });
            sTile.innerHTML =
              '<div class="ms-self-share"><div class="ms-self-share-inner">' +
              '<svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>' +
              '<span class="ms-self-share-t">You’re sharing your screen</span>' +
              '<span class="ms-self-share-s">Everyone else can see it — your own preview is hidden to prevent a mirror loop.</span>' +
              "</div></div>";
            // POP-01/02: a WORKING pop-out for YOUR OWN share too. The tile
            // itself still hides the preview (the "mirror loop" only happens
            // when the live share is rendered back on the display you're
            // sharing) — but the pop-out opens a SEPARATE window carrying the
            // real screen video, which you can drag onto a second monitor. A
            // hidden <video> holds the local screen stream so the shared pop-out
            // helper has a source without showing the mirror inside the tile.
            const selfSrc: MediaStream | null =
              (track && (track as any).mediaStream) ||
              (track && (track as any).mediaStreamTrack
                ? new MediaStream([(track as any).mediaStreamTrack])
                : null);
            if (selfSrc) {
              const hidden = document.createElement("video");
              (hidden as any).srcObject = selfSrc;
              hidden.autoplay = true;
              (hidden as any).playsInline = true;
              hidden.muted = true;
              hidden.style.cssText = "position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;";
              sTile.appendChild(hidden);
            }
            const selfPop = document.createElement("button");
            selfPop.className = "ms-popout-btn cv-popout-btn";
            selfPop.type = "button";
            selfPop.title = "Pop out your shared screen (drag to another monitor)";
            selfPop.setAttribute("aria-label", selfPop.title);
            selfPop.innerHTML =
              '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';
            const selfKey = trackKey;
            const selfAddPh = () => {
              sTile.classList.add("ms-tile-popped-out");
              callPoppedOutRef.current.add(selfKey);
              relayoutGridRef.current?.();
              if (sTile.querySelector(".ms-popout-placeholder")) return;
              const ph = document.createElement("div");
              ph.className = "ms-popout-placeholder";
              const m2 = document.createElement("span");
              m2.textContent = "Popped out";
              const bk = document.createElement("button");
              bk.type = "button";
              bk.className = "ms-popout-bringback";
              bk.textContent = "Bring back";
              bk.onclick = (ev: any) => {
                ev.stopPropagation();
                closePopout(callPipWindowsRef.current, selfKey);
                sTile.classList.remove("ms-tile-popped-out");
                sTile.querySelector(".ms-popout-placeholder")?.remove();
              };
              ph.appendChild(m2); ph.appendChild(bk); sTile.appendChild(ph);
            };
            const selfRmPh = () => {
              sTile.classList.remove("ms-tile-popped-out");
              callPoppedOutRef.current.delete(selfKey);
              relayoutGridRef.current?.();
              sTile.querySelector(".ms-popout-placeholder")?.remove();
            };
            selfPop.onclick = (ev: any) => {
              ev.stopPropagation();
              void openScreenPopout({
                tile: sTile,
                pid: selfKey,
                participantName: "Your screen",
                video: sTile.querySelector("video") as HTMLVideoElement | null,
                pipWindows: callPipWindowsRef.current,
                onToast: showToast,
                addPlaceholder: selfAddPh,
                removePlaceholder: selfRmPh,
              });
            };
            sTile.appendChild(selfPop);
            stageRef.current && stageRef.current.appendChild(sTile);
            tilesRef.current.set(trackKey, { tile: sTile, track });
            relayoutGrid();
            refreshCallScreenSharesRef.current?.();
            return;
          }

          // Reuse an existing avatar tile (from ParticipantConnected) if one
          // exists — participants are PEOPLE, not video streams. Replace the
          // avatar placeholder with the live <video> element.
          const avatarKey = participant.sid + ":avatar";
          const avatarEntry = tilesRef.current.get(avatarKey);
          if (avatarEntry && !isScreen) {
            const tile = avatarEntry.tile;
            tilesRef.current.delete(avatarKey);
            // Remove the avatar placeholder circle
            tile.querySelectorAll("div").forEach((c: any) => { if (c.style.transform && c.style.transform.includes("translate")) c.remove(); });
            tile.dataset.key = trackKey;
            tile.dataset.uid = uidOf(participant.identity);
            tile.dataset.screen = "false";
            tile.dataset.local = participant.isLocal ? "true" : "false";
            el.className = "cv-vid";
            Object.assign(el.style, {
              width: "100%", height: "100%", objectFit: "cover",
            });
            attachAdaptiveVideoFit(el);
            // Remove stale video elements before prepending the fresh one
            tile.querySelectorAll(".cv-vid").forEach((v: any) => v.remove());
            tile.insertBefore(el, tile.firstChild);
            // Add pin button (reuse or create)
            if (!tile.querySelector(".cv-pin-btn")) {
              const pinBtn = document.createElement("button");
              pinBtn.className = "cv-pin-btn";
              pinBtn.type = "button";
              pinBtn.setAttribute("aria-label", "Pin for me");
              pinBtn.title = "Pin for me";
              pinBtn.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4h6l-1 6 3 3v2H7v-2l3-3z"/><line x1="12" y1="15" x2="12" y2="21"/></svg>';
              const _pinSid2 = participant.sid;
              pinBtn.onclick = (ev: any) => { ev.stopPropagation(); toggleCallPin(_pinSid2); };
              tile.appendChild(pinBtn);
            }
            if (!tile.querySelector(".cv-fs-btn")) {
              const fsBtn = document.createElement("button");
              fsBtn.className = "cv-fs-btn";
              fsBtn.type = "button";
              fsBtn.setAttribute("aria-label", "Fullscreen tile");
              fsBtn.title = "Fullscreen";
              fsBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
              fsBtn.onclick = (ev: any) => { ev.stopPropagation(); if (fsElement() === tile) fsExit(); else fsRequest(tile); };
              tile.appendChild(fsBtn);
            }
            if (
              !participant.isLocal &&
              !isScreen &&
              !tile.querySelector(".cv-menu-btn")
            ) {
              tile.dataset.name = participant.name || "Participant";
              const menuBtn = document.createElement("button");
              menuBtn.className = "cv-menu-btn";
              menuBtn.type = "button";
              menuBtn.setAttribute("aria-label", "Participant options");
              menuBtn.setAttribute("aria-haspopup", "menu");
              menuBtn.title = "More options";
              menuBtn.innerHTML = PARTICIPANT_MENU_ICON;
              menuBtn.onclick = (ev: any) => {
                ev.stopPropagation();
                openCallTileMenuRef.current(menuBtn, tile);
              };
              tile.appendChild(menuBtn);
            }
            tilesRef.current.set(trackKey, { tile, track });
            tile.dataset.camOff = "false";
            if (track.isMuted) setTileCameraOff(participant.sid, true);
            if (!participant.isLocal) setRemoteVideoOn(!track.isMuted);
            return;
          }

          const key = trackKey;
          // Same-user dedupe: a camera track arriving for a sid with no avatar
          // tile yet (e.g. a remote whose ParticipantConnected didn't fire) must
          // still drop this human's ghost sessions. Skip for screen tiles (a
          // user legitimately has camera + screen under one sid).
          if (!isScreen) dedupeUserTiles(uidOf(participant.identity), participant.sid);
          const tile = document.createElement("div");
          tile.className = "cv-tile";
          tile.style.setProperty("--av", tileColorOf(participant.sid));
          tile.style.setProperty("--av-angle", gradientAngleOf(participant.sid) + "deg");
          applyTilePalette(tile, String(participant.identity || participant.sid).split("__")[0], stageRef.current);
          tile.dataset.pid = participant.sid;
          tile.dataset.uid = uidOf(participant.identity);
          tile.dataset.key = key;
          // Tile fills its grid cell — no fixed aspect-ratio. With a count-aware
          // grid (ceil(sqrt(n))) below, the cell drives the size so all members
          // remain visible without scrolling; objectFit on the inner <video>
          // preserves the camera aspect.
          Object.assign(tile.style, {
            position: "relative",
            background: "var(--meet-tile)",
            borderRadius: "10px",
            border: "none",
            boxShadow: "none",
            overflow: "hidden",
            width: "100%",
            height: "100%",
            minWidth: "0",
            minHeight: "0",
            outline: "none",
          });
          // A shared SCREEN must letterbox (contain) so a 16:9 desktop isn't
          // cropped; camera tiles keep cover. Self-view is NOT mirrored (user
          // preference) — shown exactly as the camera captures it. Mirrors MeetingStage.
          // Flag screen tiles so pin/spotlight prefers them over the camera tile.
          tile.dataset.screen = isScreen ? "true" : "false";
          tile.dataset.local = participant.isLocal ? "true" : "false";
          el.className = "cv-vid"; // targetable by the no-mirror guard in v1.css
          Object.assign(el.style, {
            width: "100%",
            height: "100%",
            objectFit: isScreen ? "contain" : "cover",
          });
          if (!isScreen) attachAdaptiveVideoFit(el);
          const label = document.createElement("div");
          label.className = "cv-tile-label";
          // Display name only — never the raw identity/user id.
          const labelName = document.createElement("span");
          labelName.className = "cv-tile-name";
          labelName.textContent =
            (participant.name || "Participant") +
            (participant.isLocal && !/^you$/i.test(participant.name || "") ? " (you)" : "");
          label.appendChild(labelName);
          if (!isScreen) label.insertAdjacentHTML("beforeend", '<span class="label-wave" aria-hidden="true"><i></i><i></i><i></i><i></i></span>');
          Object.assign(label.style, {
            position: "absolute",
            left: "12px",
            bottom: "12px",
            maxWidth: "calc(100% - 24px)",
            color: "#fff",
            fontSize: "15px",
            fontWeight: "500",
            letterSpacing: "0",
            padding: "8px 20px",
            borderRadius: "79px",
            background: "var(--call-overlay, rgba(0,0,0,.3))",
            border: "none",
            boxShadow: "none",
            backdropFilter: "blur(14px) saturate(1.2)",
            WebkitBackdropFilter: "blur(14px) saturate(1.2)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          });
          tile.appendChild(el);
          tile.appendChild(label);
          if (!isScreen) addMicBadge(tile, !participant.isMicrophoneEnabled); // live mic-muted indicator
          // Teams "Pin for me" control (hover-revealed). LOCAL-only, multi-pin —
          // toggles this participant in callPinnedSids; the state effect re-runs
          // relayoutGrid(). Title flips to "Unpin" via the .cv-tile-pinned class.
          const pinBtn = document.createElement("button");
          pinBtn.className = "cv-pin-btn";
          pinBtn.type = "button";
          pinBtn.setAttribute("aria-label", "Pin for me");
          pinBtn.title = "Pin for me";
          pinBtn.innerHTML =
            '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4h6l-1 6 3 3v2H7v-2l3-3z"/><line x1="12" y1="15" x2="12" y2="21"/></svg>';
          const _pinSid = participant.sid;
          pinBtn.onclick = (ev) => {
            ev.stopPropagation();
            toggleCallPin(_pinSid);
          };
          tile.appendChild(pinBtn);
          // Per-tile fullscreen (parity with meeting tiles).
          const fsBtn = document.createElement("button");
          fsBtn.className = "cv-fs-btn";
          fsBtn.type = "button";
          fsBtn.setAttribute("aria-label", "Fullscreen tile");
          fsBtn.title = "Fullscreen";
          fsBtn.innerHTML =
            '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
          fsBtn.onclick = (ev) => {
            ev.stopPropagation();
            if (fsElement() === tile) fsExit();
            else fsRequest(tile);
          };
          tile.appendChild(fsBtn);
          // POP-01/02: pop out a REMOTE screen share into its own window — the
          // SAME control meetings have. (Your own share can't pop out — POP-08
          // loop prevention — and self-screen returns earlier, so this only
          // reaches remote screen tiles.) Uses the shared screenPopout helper so
          // calls and meetings never drift.
          if (isScreen && !participant.isLocal) {
            const { hasDocPip, hasVidPip } = popoutCapability();
            const popoutBtn = document.createElement("button");
            popoutBtn.className = "ms-popout-btn cv-popout-btn";
            popoutBtn.type = "button";
            popoutBtn.title = hasDocPip
              ? "Pop out screen share (window)"
              : hasVidPip
                ? "Pop out screen share (Picture-in-Picture)"
                : "Pop out screen share";
            popoutBtn.setAttribute("aria-label", popoutBtn.title);
            popoutBtn.innerHTML =
              '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';
            const popKey = tile.dataset.key || key;
            const addPlaceholder = () => {
              tile.classList.add("ms-tile-popped-out");
              callPoppedOutRef.current.add(popKey);
              relayoutGridRef.current?.();
              if (tile.querySelector(".ms-popout-placeholder")) return;
              const ph = document.createElement("div");
              ph.className = "ms-popout-placeholder";
              const msg = document.createElement("span");
              msg.textContent = "Popped out";
              const back = document.createElement("button");
              back.type = "button";
              back.className = "ms-popout-bringback";
              back.textContent = "Bring back";
              back.onclick = (ev: any) => {
                ev.stopPropagation();
                closePopout(callPipWindowsRef.current, popKey);
                const pipEl = (document as any).pictureInPictureElement;
                if (pipEl && tile.contains(pipEl))
                  (document as any).exitPictureInPicture?.().catch?.(() => {});
                tile.classList.remove("ms-tile-popped-out");
                tile.querySelector(".ms-popout-placeholder")?.remove();
              };
              ph.appendChild(msg);
              ph.appendChild(back);
              tile.appendChild(ph);
            };
            const removePlaceholder = () => {
              tile.classList.remove("ms-tile-popped-out");
              callPoppedOutRef.current.delete(popKey);
              relayoutGridRef.current?.();
              tile.querySelector(".ms-popout-placeholder")?.remove();
            };
            popoutBtn.onclick = (ev: any) => {
              ev.stopPropagation();
              void openScreenPopout({
                tile,
                pid: popKey,
                participantName: participant.name || "Screen share",
                video: tile.querySelector("video") as HTMLVideoElement | null,
                pipWindows: callPipWindowsRef.current,
                onToast: showToast,
                addPlaceholder,
                removePlaceholder,
              });
            };
            tile.appendChild(popoutBtn);
          }
          if (!participant.isLocal && !isScreen) {
            tile.dataset.name = participant.name || "Participant";
            const menuBtn = document.createElement("button");
            menuBtn.className = "cv-menu-btn";
            menuBtn.type = "button";
            menuBtn.setAttribute("aria-label", "Participant options");
            menuBtn.setAttribute("aria-haspopup", "menu");
            menuBtn.title = "More options";
            menuBtn.innerHTML = PARTICIPANT_MENU_ICON;
            menuBtn.onclick = (ev: any) => {
              ev.stopPropagation();
              openCallTileMenuRef.current(menuBtn, tile);
            };
            tile.appendChild(menuBtn);
          }
          stageRef.current && stageRef.current.appendChild(tile);
          tilesRef.current.set(key, { tile, track });
          if (!isScreen) {
            tile.dataset.camOff = "false";
            if (track.isMuted) setTileCameraOff(participant.sid, true);
          }
          relayoutGrid();
          if (isScreen) refreshCallScreenSharesRef.current?.();
          // A remote camera tile is now showing → hide the camera-off avatar.
          if (!participant.isLocal && !isScreen) setRemoteVideoOn(!track.isMuted);
        };
        // Stable handler so relayout can attach it to whichever tile is currently
        // the corner PiP and clear it from the rest by identity.
        const onPipTileClick = () => setCallPipSwap((v) => !v);
        // Count-aware grid: cols = ceil(sqrt(n)), rows = ceil(n / cols), each
        // cell minmax(0, 1fr) so tiles shrink to fit the viewport as N grows
        // (replaces the auto-fit grid that clipped rows for large meetings).
        const relayoutGrid = () => {
          const stage = stageRef.current;
          if (!stage) return;
          // Spatial audio: pan each remote voice to match where its tile sits on
          // screen. Immediate even-spread fallback (join order), then refine to
          // accurate tile-centre x after the grid reflows.
          if (spatialRef.current && roomRef.current?.remoteParticipants) {
            const sp = spatialRef.current;
            sp.setOrder(
              [...roomRef.current.remoteParticipants.values()].map(
                (p: any) => p.sid,
              ),
            );
            requestAnimationFrame(() => {
              const st = stageRef.current;
              if (!st) return;
              const sr = st.getBoundingClientRect();
              if (!sr.width) return;
              const positions: { id: string; x: number }[] = [];
              for (const e of tilesRef.current.values()) {
                const t = e.tile;
                if (
                  !t ||
                  t.dataset.local === "true" ||
                  t.dataset.screen === "true"
                )
                  continue;
                const pid = t.dataset.pid;
                if (!pid) continue;
                const r = t.getBoundingClientRect();
                if (!r.width) continue;
                positions.push({
                  id: pid,
                  x: (r.left + r.width / 2 - sr.left) / sr.width,
                });
              }
              if (positions.length) sp.setLayout(positions);
            });
          }
          // A share that is open in a pop-out window is not on the stage: hide
          // its tile and leave it out of the grid maths entirely, so the call
          // returns to its normal layout. The tile stays in the DOM (still
          // subscribed, still feeding the pop-out) and rejoins on close.
          //
          // ANTI-MIRROR: while YOU are sharing, other people's screen shares are
          // not rendered here either. Suppressing only your own preview breaks a
          // 1-node loop; two people sharing at once still mirrored each other
          // forever. A sharer that renders no remote share cannot be part of a
          // cycle at any depth. Same rule as MeetingStage — what we do in
          // meetings, we do in calls.
          const iAmSharing = [...tilesRef.current.values()].some(
            (e) => e.tile.dataset.screen === "true" && e.tile.dataset.local === "true",
          );
          const tiles0 = [...tilesRef.current.entries()]
            .filter(([k, e]) => {
              const { poppedOut, mirrorGuard } = hiddenReasons(
                {
                  pid: k,
                  isScreen: e.tile.dataset.screen === "true",
                  isLocal: e.tile.dataset.local === "true",
                },
                {
                  localIsSharing: iAmSharing,
                  poppedOutPids: callPoppedOutRef.current,
                },
              );
              e.tile.classList.toggle("ms-tile-popped-hidden", poppedOut);
              e.tile.classList.toggle("ms-tile-mirror-guarded", mirrorGuard);
              return !poppedOut && !mirrorGuard;
            })
            .map(([, e]) => e.tile);
          // -- View preferences (lib/stageView: the SAME store as meetings) --
          const prefs = callViewPrefsRef.current;
          // "Hide participants without video": camera-off REMOTE people leave the
          // stage (still in People, audio untouched). Never when it would empty it.
          const isNoVideoRemote = (t: HTMLElement) =>
            t.dataset.local !== "true" && t.dataset.screen !== "true" && !tileHasVideo(t);
          const dropNoVideo =
            prefs.hideNoVideo &&
            !pipRef.current &&
            tiles0.some((t) => t.dataset.local !== "true" && !isNoVideoRemote(t));
          const tiles = tiles0.filter((t) => {
            const hide = dropNoVideo && isNoVideoRemote(t);
            t.classList.toggle("stage-tile-hidden", hide);
            if (hide) clearRailTile(t);
            return !hide;
          });
          // Self-view prefs are STAGE-level classes; CSS applies them to whichever
          // tile is cornered, so no branch below has to re-apply them.
          stage.classList.toggle("hide-self-pip", prefs.hideSelf);
          for (const c of ["br", "bl", "tr", "tl"])
            stage.classList.toggle("pip-corner-" + c, prefs.pipCorner === c);
          // Raised hands: badge on the tile + ordering. Hands are keyed by LiveKit
          // identity ("__me__" for the local user); tiles carry the base user id.
          const handUids = new Set(
            callHandsRef.current.map((h) => (h.id === "__me__" ? "__me__" : baseUid(h.id))),
          );
          const tileHand = (t: HTMLElement) =>
            t.dataset.screen !== "true" &&
            (t.dataset.local === "true"
              ? handUids.has("__me__")
              : handUids.has(t.dataset.uid || ""));
          for (const t of tiles0) setTileHand(t, tileHand(t));
          const n = tiles.length;
          setCallTotalTiles((prev) => (prev !== n ? n : prev));
          // Remote Control: detect the remote screen-sharer (drives the request UI).
          const _shareTile = tiles.find(
            (t) => t.dataset.screen === "true" && t.dataset.local !== "true",
          );
          const _sharer = _shareTile
            ? {
                sid: _shareTile.dataset.pid || "",
                name: (
                  ((_shareTile.querySelector(".cv-tile-label") as any) || {})
                    .textContent || "Presenter"
                ).trim(),
              }
            : null;
          setRcSharer((prev) =>
            (prev && prev.sid) === (_sharer && _sharer.sid) ? prev : _sharer,
          );
          const pins = callPinnedRef.current || [];
          const pinnedTiles = tiles.filter((t) =>
            pins.includes(t.dataset.pid || ""),
          );
          const unpinnedTiles = tiles.filter(
            (t) => !pins.includes(t.dataset.pid || ""),
          );
          // Pin badge/outline (always reflects pin state, both layout modes).
          for (const t of tiles)
            t.classList.toggle(
              "cv-tile-pinned",
              pins.includes(t.dataset.pid || ""),
            );
          // Skype/Teams self-view — your own CAMERA tile floats as a small PiP
          // instead of taking an equal/main grid cell. Never when you're alone,
          // never for the self screen-share placeholder (data-screen="true"),
          // never when you've pinned yourself, and never inside the floating PiP
          // window (it shows exactly one tile by design).
          const selfTile =
            tiles.find(
              (t) => t.dataset.local === "true" && t.dataset.screen !== "true",
            ) || null;
          // LAYOUTS MUST LOOK DIFFERENT (same rule as MeetingStage): in a 1:1
          // call, cornering the self-view in every layout made Speaker, bottom
          // strip, Gallery and Focus render the same picture. Gallery puts you
          // in the equal grid; the two Speaker layouts put you in the strip
          // when you are the only other person; Focus keeps the corner PiP.
          // "Hide my own preview" keeps the (hidden) corner placement.
          const layoutNow = callViewModeRef.current;
          const othersOnStage = tiles.filter((t) => t !== selfTile).length;
          const selfTakesStageCell =
            !prefs.hideSelf &&
            (layoutNow === "gallery" ||
              ((layoutNow === "speaker" || layoutNow === "speaker-bottom") &&
                othersOnStage === 1 &&
                !prefs.focusContent));
          const selfPipEligible =
            !pipRef.current &&
            !!selfTile &&
            tiles.length > 1 &&
            !selfTakesStageCell &&
            !pins.includes((selfTile && selfTile.dataset.pid) || "") &&
            // A spotlighted self is on the main stage for everyone — including you.
            !(
              !callSpotlightEscapedRef.current &&
              callSpotlightRef.current.includes((selfTile && selfTile.dataset.uid) || "")
            );
          // Switch mode: normally YOU are cornered; when swapped, corner the
          // primary remote camera instead and let your tile take the main view.
          // Never corner a screen share (that's the point of the call) — with no
          // remote camera to trade with, fall back to cornering yourself.
          let selfPip: HTMLElement | null = selfPipEligible ? selfTile : null;
          if (selfPip && callPipSwapRef.current) {
            // Corner an UNPINNED remote camera. A PINNED tile is a "keep this on
            // the main stage" request that outranks the swap — so if the only
            // remote is pinned we corner YOU again (swap becomes a no-op) rather
            // than fighting the pin. This is also what makes pinning the cornered
            // person promote them: they leave the corner and you take it.
            const remoteCam = tiles.find(
              (t) =>
                t !== selfTile &&
                t.dataset.screen !== "true" &&
                !pins.includes(t.dataset.pid || ""),
            );
            selfPip = remoteCam || selfPip;
          }
          const gridTiles = selfPip ? tiles.filter((t) => t !== selfPip) : tiles;
          for (const t of tiles) {
            const isPip = t === selfPip;
            t.classList.toggle("cv-tile-self-pip", isPip);
            if (isPip) {
              t.dataset.pip = "true";
              // Clear any hide class so a self-view carrying a stale
              // cv-tile-railed / cv-tile-pg-hidden (display:none) can't vanish.
              t.classList.remove("cv-tile-railed", "cv-tile-pg-hidden");
              // Tap-to-swap affordance (see Switch mode above).
              t.onclick = onPipTileClick;
              t.title = callPipSwapRef.current
                ? "Switch back to their view"
                : "Switch to your view · drag to move";
              // Drag to any corner (snaps; remembered). A tap still swaps.
              enablePipDrag(t, () => stageRef.current, (c) => setCallViewPref({ pipCorner: c }));
            } else {
              delete t.dataset.pip;
              if (t.onclick === onPipTileClick) {
                t.onclick = null;
                t.title = "";
              }
            }
          }
          const sizeGrid = (el: HTMLElement, count: number) => {
            const cols = count <= 1 ? 1 : Math.ceil(Math.sqrt(count));
            const rows = count <= 1 ? 1 : Math.ceil(count / cols);
            // CEO: equal-size tiles; a partial last row is CENTRED, never stretched.
            applyTileGrid(el, cols, rows);
          };
          const resetTile = (t: HTMLElement) => {
            clearRailTile(t);
            t.style.flex = "";
            t.style.order = "";
            t.style.width = "100%";
            t.style.height = "100%";
            t.style.minHeight = "0";
            t.classList.remove("cv-tile-pg-hidden", "cv-tile-railed", "cv-tile-paged-out", "cv-tile-spotlit");
          };
          // ── PiP: the floating window is tiny (16:9), so a multi-tile grid is
          // useless — you'd see slivers. Show exactly ONE meaningful tile full-
          // bleed and hide the rest (kept mounted → audio unaffected). Priority:
          //   1) a SHARED SCREEN (the point of the call; contain-fit fills the
          //      16:9 PiP with no crop),
          //   2) a REMOTE camera that's ON (see who's talking),
          //   3) any remote tile (its avatar shows for a camera-off peer),
          //   4) the local tile (solo).
          // This is what fixes the "PiP is blank/white" report: previously the
          // cramped grid showed a cropped white corner of the shared screen.
          if (pipRef.current && n > 0) {
            const remote = tiles.filter((t) => t.dataset.local !== "true");
            const focalPip =
              tiles.find(
                (t) =>
                  t.dataset.screen === "true" && t.dataset.local !== "true",
              ) ||
              remote.find(
                (t) => !!t.querySelector(".cv-vid") && t.dataset.camOff !== "true",
              ) ||
              remote[0] ||
              tiles[0];
            if (callPinAreaRef.current && callPinAreaRef.current.parentElement)
              callPinAreaRef.current.remove();
            if (callStripRef.current && callStripRef.current.parentElement)
              callStripRef.current.remove();
            stage.style.display = "grid";
            stage.style.flexDirection = "";
            stage.style.flexWrap = "";
            stage.style.alignContent = "";
            stage.style.justifyContent = "";
            stage.style.overflow = "hidden";
            layoutRail(stage, []);
            for (const t of tiles) {
              resetTile(t);
              if (t.parentElement !== stage) stage.appendChild(t);
              t.classList.toggle("cv-tile-railed", t !== focalPip);
            }
            sizeGrid(stage, 1);
            return;
          }
          // ── Prominent layout (mirrors MeetingStage — ONE model for both
          // surfaces): pins are always prominent; in Participant view the
          // focal tile (live screen share > first remote camera) is prominent
          // too. Everyone else rides a VERTICAL side rail INSIDE the stage.
          // P0-2 HARD RULE: tiles never render in a row below the stage, and
          // are never relocated into the People panel (it's a management
          // list, not a second canvas — P0-10).
          // Any non-gallery layout is "speaker-style": one focal tile + a strip.
          const layoutId = callViewModeRef.current;
          const speakerMode = layoutId !== "gallery";
          let focal: HTMLElement | null = null;
          // BA/CEO #4: a LIVE screen share is ALWAYS the focal/main tile — in ANY
          // view mode (gallery too), never a secondary equal tile. All screen
          // tiles (pid unique among them); only relevant with more than one tile.
          const screenTilesArr =
            n > 1
              ? tiles.filter(
                  (t) =>
                    t.dataset.screen === "true" && t.dataset.local !== "true",
                )
              : [];
          // Which screen(s) fill the stage. 0 → none; 1 → that one (UNCHANGED
          // single-share path); 2+ → the local viewer's switcher choice: spotlight
          // the focused one (default newest) or lay ALL out side-by-side.
          let promotedScreenTiles: HTMLElement[] = [];
          if (screenTilesArr.length === 1) {
            promotedScreenTiles = [screenTilesArr[0]];
          } else if (screenTilesArr.length >= 2) {
            if (callScreenViewModeRef.current === "sideBySide") {
              promotedScreenTiles = screenTilesArr.slice();
            } else {
              const fp = callFocusedScreenPidRef.current;
              const focused =
                (fp && screenTilesArr.find((t) => t.dataset.pid === fp)) ||
                screenTilesArr[screenTilesArr.length - 1];
              promotedScreenTiles = [focused];
            }
          }
          if (promotedScreenTiles.length) {
            focal = promotedScreenTiles[0];
          } else if (speakerMode && n > 1) {
            // Pick the focal from gridTiles (never the cornered PiP). When you've
            // swapped yourself into the main view, feature your own tile.
            // Follow whoever is TALKING (debounced in ActiveSpeakersChanged); it
            // used to be "the first remote tile", which never moved.
            const spk = callActiveSpeakerRef.current;
            focal =
              (callPipSwapRef.current && selfTile && selfTile !== selfPip
                ? selfTile
                : null) ||
              // Never auto-feature YOUR OWN tile as the speaker (it can sit in
              // the grid now, see selfTakesStageCell) — the main view follows
              // the other people; you only go large via swap or a pin.
              (spk
                ? gridTiles.find(
                    (t) =>
                      t.dataset.pid === spk &&
                      t.dataset.screen !== "true" &&
                      t.dataset.local !== "true",
                  ) || null
                : null) ||
              gridTiles.find(
                (t) => t.dataset.local !== "true" && t.dataset.screen !== "true",
              ) ||
              gridTiles.find((t) => t.dataset.local !== "true") ||
              null;
          }
          // Participant view: the focal + any pins fill the stage; EVERYONE
          // ELSE is hidden on the stage and shown in the People panel roster
          // instead (Teams-style — the roster IS the participant labels, no
          // in-stage rail chips). Gallery view fills with the pinned set.
          // SPOTLIGHT (host, for everyone) OVERRIDES the viewer's own pins and view
          // mode — same precedence as meetings (VIEW-09). A live screen share stays
          // focal alongside it. Pins are kept, just not rendered until it ends or
          // the viewer chooses "Return to my view".
          const spotTiles: HTMLElement[] = [];
          if (!callSpotlightEscapedRef.current && callSpotlightRef.current.length) {
            for (const t of tiles) {
              if (t.dataset.screen === "true") continue;
              if (callSpotlightRef.current.includes(t.dataset.uid || "")) spotTiles.push(t);
            }
          }
          const prominentSet = new Set<HTMLElement>(
            spotTiles.length ? spotTiles : pinnedTiles,
          );
          for (const st of promotedScreenTiles) prominentSet.add(st);
          if (focal && !spotTiles.length) prominentSet.add(focal);
          for (const t of tiles) t.classList.toggle("cv-tile-spotlit", spotTiles.includes(t));
          const prominentTiles = gridTiles.filter((t) => prominentSet.has(t));
          const hiddenTiles = gridTiles.filter((t) => !prominentSet.has(t));
          if (prominentTiles.length > 0 && hiddenTiles.length > 0) {
            // Dissolve any leftover pin-area / rail from an older layout.
            if (callPinAreaRef.current && callPinAreaRef.current.parentElement)
              callPinAreaRef.current.remove();
            if (callStripRef.current && callStripRef.current.parentElement)
              callStripRef.current.remove();
            stage.style.display = "grid";
            stage.style.flexDirection = "";
            stage.style.flexWrap = "";
            stage.style.alignContent = "";
            stage.style.justifyContent = "";
            stage.style.overflow = "hidden";
            for (const t of prominentTiles) {
              resetTile(t); // clears cv-tile-railed
              if (t.parentElement !== stage) stage.appendChild(t);
            }
            for (const t of hiddenTiles) {
              resetTile(t);
              // Hidden on the stage → the person shows in the People roster. The
              // tile stays MOUNTED so audio is unaffected.
              t.classList.add("cv-tile-railed");
              if (t.parentElement !== stage) stage.appendChild(t);
            }
            // RAIL: everyone who is not a main tile rides a VERTICAL strip on the
            // right, INSIDE the stage (P0-2 still holds: never a row under it,
            // never relocated into the People panel). Speaker first, then hands,
            // then cameras; whoever does not fit sits behind a "+N" chip. "Focus on
            // content" turns the rail off (the previous behaviour).
            const rankCtx = {
              pinned: (pid: string) => pins.includes(pid),
              handRaised: tileHand,
              speakerPid: callActiveSpeakerRef.current,
            };
            // Focus view (or the "Focus on content" preference) turns the strip
            // off; the bottom-strip layout moves it to the stage floor.
            const rail = layoutRail(
              stage,
              prefs.focusContent || layoutId === "focus"
                ? []
                : sortByRank(hiddenTiles, (t) => railRank(t, rankCtx)),
              { side: railSideFor(layoutId) },
            );
            for (const t of rail.shown) t.classList.remove("cv-tile-railed");
            // Float the self-view over this layout (e.g. while screen sharing:
            // the share is focal, your camera drops to the corner).
            if (selfPip) {
              resetTile(selfPip);
              selfPip.classList.add("cv-tile-self-pip");
              if (selfPip.parentElement !== stage) stage.appendChild(selfPip);
            }
            sizeGrid(stage, prominentTiles.length);
            return;
          }
          // Default (no pins, or everyone pinned): all tiles are DIRECT children,
          // plain count-aware grid. Tear down the pin containers if present.
          layoutRail(stage, []);
          for (const t of gridTiles) {
            resetTile(t);
            if (t.parentElement !== stage) stage.appendChild(t);
          }
          // The self-view floats in the corner; it never occupies a grid cell,
          // so a 1:1 call becomes a single full-bleed remote tile + your PiP.
          if (selfPip) {
            resetTile(selfPip);
            selfPip.classList.add("cv-tile-self-pip");
            if (selfPip.parentElement !== stage) stage.appendChild(selfPip);
          }
          if (callPinAreaRef.current && callPinAreaRef.current.parentElement)
            callPinAreaRef.current.remove();
          if (callStripRef.current && callStripRef.current.parentElement)
            callStripRef.current.remove();
          stage.style.display = "grid";
          stage.style.flexDirection = "";
          stage.style.flexWrap = "";
          stage.style.alignContent = "";
          stage.style.justifyContent = "";
          stage.style.overflow = "hidden";
          // PAGING (parity with meetings): past the device-tier page size, show one
          // page. Screen shares, then you/pins, lead page 1; everyone else keeps
          // join order so tiles don't reshuffle as people talk. display:none lets
          // adaptiveStream pause the hidden tiles' video; audio is unaffected.
          const pageSize = callPageSizeRef.current || 16;
          if (gridTiles.length > pageSize) {
            const { visible, pages, page } = pageSlice(
              gridTiles,
              // screen, then you/pins, raised hands, camera on, the rest: all
              // slow-changing, and the sort is stable (no reshuffle while talking).
              (t) =>
                galleryRank(t, {
                  pinned: (pid: string) => pins.includes(pid),
                  handRaised: tileHand,
                }),
              callPageRef.current,
              pageSize,
            );
            const vis = new Set(visible);
            for (const t of gridTiles) t.classList.toggle("cv-tile-paged-out", !vis.has(t));
            sizeGrid(stage, visible.length);
            setCallPageCount((prev) => (prev === pages ? prev : pages));
            if (page !== callPageRef.current) setCallPage(page);
            return;
          }
          setCallPageCount((prev) => (prev === 1 ? prev : 1));
          if (callPageRef.current !== 0) setCallPage(0);
          sizeGrid(stage, gridTiles.length);
        };
        relayoutGridRef.current = relayoutGrid;
        // Responsive: the strip/rail geometry is MEASURED from the stage box, so
        // re-run the layout whenever that box changes (window resize, People
        // panel open/close, fullscreen, PiP) — rAF-coalesced, idempotent.
        if (typeof ResizeObserver !== "undefined" && stageRef.current) {
          let roRaf = 0;
          stageRO = new ResizeObserver(() => {
            if (roRaf) return;
            roRaf = requestAnimationFrame(() => {
              roRaf = 0;
              if (!cancelled) relayoutGrid();
            });
          });
          stageRO.observe(stageRef.current);
        }
        const detach = (track: any) => {
          try {
            track.detach().forEach((e: any) => e.remove());
          } catch (_) {}
          const localSid =
            roomRef.current &&
            roomRef.current.localParticipant &&
            roomRef.current.localParticipant.sid;
          for (const [k, v] of tilesRef.current)
            if (v.track === track) {
              const pid = v.tile.dataset.pid;
              const isRemote = pid && pid !== localSid;
              const isCamera =
                track.kind === "video" &&
                track.source !== LK.Track.Source.ScreenShare;
              const stillInRoom =
                isRemote &&
                roomRef.current &&
                roomRef.current.remoteParticipants &&
                [...roomRef.current.remoteParticipants.values()].some(
                  (p: any) => p.sid === pid,
                );
              // Is the LOCAL user still in the call? (their own camera going off must
              // NOT delete their tile — it should fall back to their initials, like
              // a remote peer, instead of vanishing).
              const localStillHere =
                !isRemote &&
                !!(roomRef.current && roomRef.current.localParticipant);
              if (isCamera && (stillInRoom || localStillHere)) {
                // Camera OFF but the participant is STILL here — a remote peer OR YOU
                // turning your own camera off → revert the tile to an initials avatar
                // instead of deleting it. Your own self-view then shows your letters
                // (Teams/Zoom), and remote tiles never blink out. Re-keyed to
                // "<sid>:avatar" so attach() swaps the <video> straight back in when
                // the camera returns (that path handles local + remote identically).
                const tile = v.tile;
                tile.querySelectorAll(".cv-vid").forEach((e: any) => e.remove());
                if (!tile.querySelector(".cv-avatar-ph"))
                  tile.insertBefore(makeAvatarPlaceholder(pid, tileDisplayName(tile)), tile.firstChild);
                delete tile.dataset.camOff;
                tile.dataset.key = pid + ":avatar";
                tilesRef.current.delete(k);
                tilesRef.current.set(pid + ":avatar", { tile, track: null });
                if (isRemote) setRemoteVideoOn(false);
              } else {
                if (track.kind === "video" && isRemote) setRemoteVideoOn(false);
                // POP-10: a remote share ending closes ITS pop-out window (keyed
                // by the tile key), leaving any other shares' pop-outs open.
                if (v.tile.dataset.screen === "true")
                  closePopout(callPipWindowsRef.current, k);
                  callPoppedOutRef.current.delete(k);
                v.tile.remove();
                tilesRef.current.delete(k);
              }
            }
          // Drop pins for any participant who just left (so the layout doesn't
          // strand, and a same-sid rejoin won't silently re-pin).
          const stillPresent = new Set(
            [...tilesRef.current.values()].map((v) => v.tile.dataset.pid),
          );
          setCallPinnedSids((prev) => {
            const next = prev.filter((sid) => stillPresent.has(sid));
            return next.length === prev.length ? prev : next;
          });
          relayoutGrid();
          // A share may have just stopped — re-sync the switcher list (cheap DOM
          // re-query; no-op when nothing screen-related changed).
          refreshCallScreenSharesRef.current?.();
        };

        // A 1:1 call is only "connected" once the remote participant is
        // actually in the room. For group calls, being in the room is enough
        // (others may still be ringing). This is the gate for showing
        // "Connected" and starting the timer.
        const markConnectedIfReady = () => {
          if (cancelled) return;
          const remotes =
            room && room.remoteParticipants ? room.remoteParticipants.size : 0;
          console.warn(
            "[livekit] markConnectedIfReady remotes=%d isGroup=%s tiles=%d audio=%d video=%d",
            remotes,
            isGroup,
            tilesRef.current.size,
            subAudio,
            subVideo,
          );
          if (isGroup || remotes > 0) {
            setRemoteJoined(true);
            setMediaPhase("connected");
          }
        };

        room
          .on(LK.RoomEvent.TrackSubscribed, (t: any, _p: any, part: any) => {
            if (t.kind === "audio") subAudio++;
            if (t.kind === "video") subVideo++;
            console.warn(
              "[livekit] TrackSubscribed kind=%s participant=%s audio=%d video=%d",
              t.kind,
              part && part.identity,
              subAudio,
              subVideo,
            );
            // Mix late-arriving audio into an in-progress recording.
            if (t.kind === "audio" && recAddAudioRef.current) {
              try { recAddAudioRef.current({ track: t }); } catch (_) {}
            }
            attach(t, part);
            markConnectedIfReady();
          })
          .on(LK.RoomEvent.TrackUnsubscribed, (t: any) => {
            if (t && t.kind === "audio") subAudio = Math.max(0, subAudio - 1);
            if (t && t.kind === "video") subVideo = Math.max(0, subVideo - 1);
            dropTrk(t && t.mediaStreamTrack); // keep the recording refs live-only
            console.warn(
              "[livekit] TrackUnsubscribed kind=%s audio=%d video=%d",
              t && t.kind,
              subAudio,
              subVideo,
            );
            detach(t);
          })
          .on(LK.RoomEvent.LocalTrackPublished, (pub: any, part: any) => {
            console.warn(
              "[livekit] LocalTrackPublished kind=%s source=%s",
              pub && pub.kind,
              pub && pub.source,
            );
            if (pub.track) {
              if (
                pub.source === LK.Track.Source.ScreenShare &&
                pub.track.mediaStream
              ) {
                screenStreamRef.current = pub.track.mediaStream;
                // BA/CEO #3: `screen` is event-driven — true only once the share
                // actually publishes, so a cancelled/hung picker can't strand it.
                setScreen(true);
                setScreenPending(false);
              }
              // Local mic never reaches attach() (it early-returns for local audio),
              // so capture it here so recording includes the local side.
              if (
                pub.kind === "audio" &&
                pub.source !== LK.Track.Source.ScreenShareAudio
              ) {
                addTrk(localStreamRef, pub.track.mediaStreamTrack);
              }
              attach(pub.track, part);
            }
          })
          .on(LK.RoomEvent.LocalTrackUnpublished, (pub: any) => {
            console.warn(
              "[livekit] LocalTrackUnpublished kind=%s source=%s",
              pub && pub.kind,
              pub && pub.source,
            );
            // Keep the recording refs live-only for LOCAL tracks too (camera +
            // local screen share both enter localStreamRef via attach) — without
            // this they stayed append-only and a later recording could pick a
            // stale local track.
            dropTrk(pub && pub.track && pub.track.mediaStreamTrack);
            if (
              pub &&
              (pub.source === LK.Track.Source.ScreenShare ||
                pub.source === LK.Track.Source.ScreenShareAudio)
            ) {
              screenStreamRef.current = null;
              // Reset on ANY stop — incl. the browser's own "Stop sharing" bar,
              // which never calls toggleScreen(), so `screen` stayed true and the
              // dock + tiles kept showing a phantom "presenting" / "Stop sharing".
              setScreen(false);
            }
            if (pub.track) detach(pub.track);
          })
          .on(LK.RoomEvent.ActiveSpeakersChanged, (speakers: any[]) => {
            const active = new Set(speakers.map((s) => s.sid));
            // Tiles may live inside the pin-area / strip containers, so query by
            // [data-pid] rather than only the stage's direct children.
            if (stageRef.current)
              Array.from(
                stageRef.current.querySelectorAll("[data-pid]"),
              ).forEach((c: any) => {
                // No hard outline (it read as a divider between tiles); speaking
                // is shown as a soft glow + a sound-wave under the avatar instead.
                c.style.outline = "none";
                setTileSpeaking(c, active.has(c.dataset.pid));
              });
            // Participant view FOLLOWS the speaker. Debounced 500ms so a cough or a
            // keyboard clack doesn't swap the main tile; never yourself; and the
            // last speaker is HELD through silence (clearing it would bounce the
            // stage back to "first remote" every time someone pauses for breath).
            const lead = speakers.find((sp: any) => sp && !sp.isLocal);
            if (speakerDebounce) clearTimeout(speakerDebounce);
            if (lead && lead.sid !== callActiveSpeakerRef.current) {
              const sid = lead.sid;
              speakerDebounce = setTimeout(() => {
                speakerDebounce = null;
                if (cancelled || callActiveSpeakerRef.current === sid) return;
                callActiveSpeakerRef.current = sid;
                if (callViewModeRef.current !== "gallery") relayoutGrid();
              }, 500);
            }
          })
          // Per-tile MIC-MUTED indicator (calls had NO mic listeners before, so
          // tiles never showed mic state), and the People-panel roster with it.
          // Matches the MICROPHONE only: this used to accept any audio
          // publication (`pub.kind === "audio" || …`), and we share the presented
          // tab's audio too (setScreenShareEnabled with audio: true), so muting a
          // shared tab flipped the presenter's MIC badge while the roster — which
          // re-derives from isMicrophoneEnabled — correctly did not. That is the
          // tile-says-muted / roster-says-live split. isMicPublication is
          // source-based, falling back to kind only when a publication carries no
          // source at all.
          .on(LK.RoomEvent.TrackMuted, (pub: any, part: any) => {
            if (isMicPublication(pub)) {
              setCallTileMic(part.sid, true);
              syncLocalMicState(part);
            }
            // Camera off (yours or the peer's) → avatar over the paused <video>.
            if (isCameraPublication(pub) && part) {
              setTileCameraOff(part.sid, true);
              if (!part.isLocal) setRemoteVideoOn(false);
            }
            refreshRoster();
          })
          .on(LK.RoomEvent.TrackUnmuted, (pub: any, part: any) => {
            if (isMicPublication(pub)) {
              setCallTileMic(part.sid, false);
              syncLocalMicState(part);
            }
            if (isCameraPublication(pub) && part) {
              setTileCameraOff(part.sid, false);
              if (!part.isLocal) setRemoteVideoOn(true);
            }
            refreshRoster();
          })
          // A REMOTE mic publication that arrives ALREADY-UNMUTED emits no
          // TrackMuted/TrackUnmuted transition, so a tile badge initialized to
          // "muted" (its default before the mic pub registers) would stay wrong
          // forever — the reported "shows muted while speaking". Re-derive the
          // badge from the publication's real mute state the moment it publishes.
          .on(LK.RoomEvent.TrackPublished, (pub: any, part: any) => {
            if (isMicPublication(pub)) setCallTileMic(part.sid, !!pub.isMuted);
            refreshRoster();
          })
          .on(
            LK.RoomEvent.ActiveDeviceChanged,
            (kind: any, deviceId: string) => {
              // Keep the in-call pickers in sync with LiveKit's actual active
              // device, including its automatic fallback when the active device is
              // unplugged mid-call.
              if (cancelled) return;
              if (kind === "audioinput") setSelMic(deviceId);
              else if (kind === "videoinput") setSelCam(deviceId);
              else if (kind === "audiooutput") setSelSpk(deviceId);
            },
          )
          // Audio first under congestion (see lib/mediaQuality).
          .on(LK.RoomEvent.LocalTrackPublished, (pub: any) => prioritizeAudioSender(pub))
          .on(
            LK.RoomEvent.ConnectionQualityChanged,
            (quality: any, participant: any) => {
              if (cancelled) return;
              if (
                room.localParticipant &&
                participant &&
                participant.sid === room.localParticipant.sid
              ) {
                const q = String(quality || "unknown");
                // Map LiveKit's "lost" through as a real red downgrade instead of
                // collapsing it to grey "unknown".
                setNetQuality(
                  q === "excellent" || q === "good" || q === "poor"
                    ? q
                    : q === "lost"
                      ? "lost"
                      : "unknown",
                );
              }
            },
          )
          .on(LK.RoomEvent.AudioPlaybackStatusChanged, () => {
            if (!cancelled) setAudioBlocked(!room.canPlaybackAudio);
          })
          .on(LK.RoomEvent.ConnectionStateChanged, (s: any) => {
            const localIdent =
              room && room.localParticipant && room.localParticipant.identity;
            console.warn(
              "[call] ConnectionStateChanged inst=%s state=%s identity=%s ts=%d",
              INST,
              s,
              localIdent,
              Date.now(),
            );
            if (cancelled) return;
            // Surface transient reconnection in the UI instead of a stale
            // "Connected". Recovery flips back via Reconnected below.
            if (s === LK.ConnectionState.Reconnecting) {
              setMediaPhase("connecting_media");
              setNetQuality("lost");
            }
          })
          .on(LK.RoomEvent.ParticipantConnected, (p: any) => {
            // Late-joiner: if WE are recording, re-announce so the newcomer's REC
            // badge shows too (they missed the initial data-channel broadcast).
            if (recordingRef.current && room && room.localParticipant) {
              try {
                room.localParticipant.publishData(
                  new TextEncoder().encode(JSON.stringify({ t: "rec", on: true })),
                  { reliable: true },
                );
              } catch (_) {}
            }
            // Late-joiner: re-announce our presenter mode so they hide our
            // redundant camera tile too.
            presenter.announceMode();
            // Late-joiner: the host re-announces the current spotlight so the
            // newcomer lands in the same view as everyone else.
            if (isCallHost && callSpotlightRef.current.length)
              publishCallSpotlight(callSpotlightRef.current);
            const remotes = room ? room.remoteParticipants.size : 0;
            const localIdent =
              room && room.localParticipant && room.localParticipant.identity;
            console.warn(
              "[call] ParticipantConnected local=%s remote=%s remotes=%d sid=%s ts=%d",
              localIdent,
              p && p.identity,
              remotes,
              p && p.sid,
              Date.now(),
            );
            // Participant-first tile: create an avatar tile for every
            // joining participant BEFORE any video track arrives. If a
            // video track later attaches, the avatar is replaced with
            // the live feed — the tile always exists.
            if (p && p.sid) {
              const name = (p && p.name) || "Participant";
              ensureCallTile(p.sid, name, false, (p as any).identity || "", !!(p as any).isMicrophoneEnabled);
            }
            markConnectedIfReady();
            refreshRoster();
          })
          .on(LK.RoomEvent.DataReceived, (payload: any, participant: any) => {
            // In-call reaction / raise-hand from a remote participant.
            try {
              const msg = JSON.parse(new TextDecoder().decode(payload));
              const name = (participant && participant.name) || "Someone";
              const pid =
                (participant && (participant.identity || participant.sid)) ||
                name;
              if (msg && msg.t === "react" && msg.emoji) {
                // Also pop it ON the sender's tile, so you can see WHO reacted.
                if (participant && participant.sid)
                  for (const [k, e] of tilesRef.current)
                    if (String(k).split(":")[0] === participant.sid && e.tile.dataset.screen !== "true")
                      flashTileReaction(e.tile, msg.emoji);
                const id =
                  Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
                setCallReactions((prev) => [...prev, { id, emoji: msg.emoji, name }]);
                setTimeout(
                  () => setCallReactions((prev) => prev.filter((r) => r.id !== id)),
                  4000,
                );
              } else if (msg && msg.t === "spot" && Array.isArray(msg.uids)) {
                // Host-driven view. Honoured ONLY from a participant whose
                // server-signed token role is host — anyone can send a data
                // message, so the sender's claim alone is worth nothing.
                const r = roleOf(participant);
                if (r !== "host" && r !== "co-host") return;
                const uids = msg.uids.filter((u: any) => typeof u === "string").slice(0, 3);
                setCallSpotlightUids(uids);
                setCallSpotlightBy(uids.length ? name : "");
                setCallSpotlightEscaped(false); // a NEW set re-arms the escape
              } else if (msg && msg.t === "hand") {
                setCallHands((prev) =>
                  msg.raised
                    ? prev.some((h) => h.id === pid)
                      ? prev
                      : [...prev, { id: pid, name }]
                    : prev.filter((h) => h.id !== pid),
                );
              } else if (
                msg &&
                msg.t === "chat" &&
                ((typeof msg.text === "string" && msg.text.trim()) ||
                  (msg.file && msg.file.id))
              ) {
                // In-call chat message from a peer (panel Chat tab) — text and/or
                // an uploaded file descriptor.
                const id =
                  Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
                setCallChatMsgs((prev) => [
                  ...prev,
                  {
                    id,
                    name,
                    text: String(msg.text || "").slice(0, 2000),
                    ts: Date.now(),
                    file: msg.file && msg.file.id ? msg.file : undefined,
                  },
                ]);
                // Unread badge for the recipient: this branch only ever runs for
                // a PEER's message (your own are echoed locally with self:true and
                // never traverse the DataChannel), so bump the count whenever the
                // Chat tab isn't the one on screen.
                if (!callChatVisibleRef.current) {
                  setCallChatUnread((c) => c + 1);
                  // Soft ding so you notice a chat message while watching the
                  // video — unless you muted the call chat (bell toggle in the
                  // panel header) or turned notification sounds off globally.
                  if (!callChatMutedRef.current && callChatNotifSoundRef.current)
                    playCallChatDing();
                }
              } else if (msg && msg.t === "wb" && msg.wb) {
                // Collaborative whiteboard op from a peer. Shared surface:
                // auto-open when a peer opens/draws (skip ambient cursor/sync-
                // request); the mount then pulls full state via sync-request.
                const wop = msg.wb.op;
                if (wop && wop !== "cursor" && wop !== "sync-request")
                  setShowCallWhiteboard(true);
                // AUDIT #22: pass sender moderator status for receiver-side lock
                // enforcement. In a 1:1 call BOTH parties moderate (canModerate =
                // !isGroup), so any sender is a moderator. For GROUP calls the
                // remote sender's host status isn't derivable at this dispatch
                // (no host-identity plumbing here — see meetings for the full
                // host/co-host model), so we stay permissive to avoid rejecting a
                // legit host's ops; group-call receiver-enforcement is deferred.
                wbReceiverRef.current &&
                  wbReceiverRef.current(msg.wb, { fromModerator: true });
              } else if (msg && msg.t === "rec") {
                // A peer started/stopped recording — surface the shared REC badge.
                // Track the announcer so an unclean drop can clear it (#46).
                peerRecorderRef.current = msg.on
                  ? (participant && (participant.identity || participant.sid)) || null
                  : null;
                setPeerRecording(!!msg.on);
              } else if (msg && msg.t === "presenter" && participant) {
                // A peer entered/left a presenter layout — their camera is now in
                // their screen composite, so hide their redundant camera tile.
                presenter.ingestSignal(participant.sid, msg.mode);
                applyPresenterHidden(stageRef.current, presenter.presentingSids);
                // Re-apply shortly after, in case their camera tile is still
                // attaching when the signal arrives.
                setTimeout(
                  () =>
                    applyPresenterHidden(
                      stageRef.current,
                      presenter.presentingSids,
                    ),
                  250,
                );
              }
            } catch (_) {}
          })
          .on(LK.RoomEvent.ParticipantDisconnected, (p: any) => {
            // Someone who left can't stay pinned or stay "the speaker" — a stale
            // pin kept the stage in prominent mode around a tile that was gone.
            if (p && p.sid) {
              if (callActiveSpeakerRef.current === p.sid) callActiveSpeakerRef.current = null;
              if (callPinnedRef.current.includes(p.sid))
                setCallPinnedSids((prev) => prev.filter((x) => x !== p.sid));
            }
            // Release the leaver's spatial-audio panner.
            if (p && p.sid && spatialRef.current)
              spatialRef.current.detach(p.sid);
            // Drop the leaver from the presenting set + un-hide any tiles.
            if (p && p.sid) {
              presenter.dropPresenter(p.sid);
              applyPresenterHidden(stageRef.current, presenter.presentingSids);
            }
            // AUDIT #46: if the participant who announced recording is the one
            // that just dropped (unclean host drop — no clean stop was sent),
            // clear the stale REC badge immediately for everyone still here.
            const leaver = (p && (p.identity || p.sid)) || null;
            if (leaver && peerRecorderRef.current && leaver === peerRecorderRef.current) {
              peerRecorderRef.current = null;
              setPeerRecording(false);
            }
            // Fallback: everyone else has left → clear any lingering badge.
            if (room && room.remoteParticipants.size === 0) {
              peerRecorderRef.current = null;
              setPeerRecording(false);
            }
            // Drop a leaving participant's raised hand.
            try {
              const pid = (p && (p.identity || p.sid)) || null;
              if (pid)
                setCallHands((prev) => prev.filter((h) => h.id !== pid));
            } catch (_) {}
            refreshRoster();
            // Group calls: tear down the leaver's tiles here. A camera-off
            // participant's avatar tile carries track:null, so the track-detach
            // path can't reclaim it — it would otherwise ghost in the grid and
            // inflate the participant count. (1:1 is handled by the grace window
            // below; guarding on isGroup avoids removing the peer mid-grace.)
            if (isGroup && p && p.sid) {
              const sid = p.sid;
              for (const [k, v] of tilesRef.current) {
                if (v.tile && v.tile.dataset && v.tile.dataset.pid === sid) {
                  try {
                    v.tile.remove();
                  } catch (_) {}
                  tilesRef.current.delete(k);
                }
              }
              setCallPinnedSids((prev) => prev.filter((s) => s !== sid));
              if (relayoutGridRef.current) relayoutGridRef.current();
            }
            const remotes = room ? room.remoteParticipants.size : 0;
            const localIdent =
              room && room.localParticipant && room.localParticipant.identity;
            console.warn(
              "[call] ParticipantDisconnected local=%s remote=%s remotes=%d ts=%d",
              localIdent,
              p && p.identity,
              remotes,
              Date.now(),
            );
            // 1:1 grace window: a network blip can fire ParticipantDisconnected
            // for the peer before its reconnect re-fires ParticipantConnected.
            // Wait 10s; if they're still gone, end. Otherwise the call drops on
            // every flap (especially common on mobile data → wifi handover).
            if (!isGroup && remotes === 0 && !cancelled) {
              console.warn(
                "[call] last remote left 1:1 call — entering 10s grace",
              );
              const graceMs = 10000;
              const graceStart = Date.now();
              const graceTimer = setInterval(() => {
                if (cancelled) {
                  clearInterval(graceTimer);
                  return;
                }
                const r =
                  room && room.remoteParticipants
                    ? room.remoteParticipants.size
                    : 0;
                if (r > 0) {
                  clearInterval(graceTimer);
                  console.warn(
                    "[call] peer rejoined within grace — keeping call alive",
                  );
                  return;
                }
                if (Date.now() - graceStart >= graceMs) {
                  clearInterval(graceTimer);
                  console.warn(
                    "[call] grace expired without peer rejoin — ending",
                  );
                  onHangup(secRef.current);
                }
              }, 500);
              localCleanup.push(() => clearInterval(graceTimer));
            }
          })
          .on(LK.RoomEvent.Disconnected, (reason: any) => {
            const name =
              (LK.DisconnectReason && LK.DisconnectReason[reason]) || reason;
            const localIdent =
              room && room.localParticipant && room.localParticipant.identity;
            console.warn(
              "[call] ROOM_DISCONNECT_EVENT inst=%s identity=%s reason=%s everConnected=%s cancelled=%s ts=%d",
              INST,
              localIdent,
              name,
              everConnectedRef.current,
              cancelled,
              Date.now(),
            );
            if (cancelled) return;
            // DUPLICATE_IDENTITY: the same user joined this call on another tab
            // or device. With the per-join UUID identity, this is only the
            // legitimate "you answered elsewhere" case — surface a message,
            // do NOT tear down (the OTHER tab is the active one).
            const isDup =
              reason ===
                (LK.DisconnectReason &&
                  LK.DisconnectReason.DUPLICATE_IDENTITY) ||
              String(name).toUpperCase().includes("DUPLICATE");
            if (isDup) {
              showToast("You answered this call on another device.");
              return;
            }
            // Terminal disconnects — do NOT auto-rejoin (a rejoin would re-enter /
            // recreate the room). The host ended the call for everyone
            // (ROOM_DELETED, from deleteRoom on hangup) or you were removed
            // (PARTICIPANT_REMOVED): leave the call. Mirrors MeetingStage's
            // terminal handling so calls eject peers the same way meetings do.
            {
              const DR: any = LK.DisconnectReason || {};
              const uname = String(name).toUpperCase();
              const ended =
                reason === DR.ROOM_DELETED ||
                uname.includes("ROOM_DELETED") ||
                uname.includes("DELETE");
              const kicked =
                reason === DR.PARTICIPANT_REMOVED || uname.includes("REMOVED");
              if (ended) {
                showToast("The call ended.");
                onHangup(secRef.current);
                return;
              }
              if (kicked) {
                // FIX: distinguish between "host ejected this user from the call"
                // and "this device was evicted because the same user answered on
                // another device (fresh=true evictPriorSessions)". In the latter
                // case, calling onHangup() terminates the call for the remote peer
                // too — the evicted device must ONLY clean up its own media.
                // isDup (DUPLICATE_IDENTITY) already handles the simultaneous-answer
                // path; this guard covers the fresh-eviction path that fires after
                // the winning device has connected to the SFU.
                // Heuristic: if we were never connected (everConnected=false) this
                // is likely a race/eviction, not a host-kick. A host kick always
                // happens to an already-connected participant.
                if (!everConnectedRef.current) {
                  console.warn("[call] PARTICIPANT_REMOVED before connected — treating as self-eviction (other device answered), not ending call for peer");
                  showToast("You answered this call on another device.");
                  return;
                }
                showToast("You were removed from the call.");
                onHangup(secRef.current);
                return;
              }
            }
            // P1 Automatic Rejoin: before surfacing failure, re-run the existing
            // connect path (re-mint token + reconnect + reacquire tracks) a
            // bounded number of times. LiveKit's own reconnectPolicy has already
            // exhausted its transient retries by the time Disconnected fires, so
            // this is the outer safety net. Counter resets to 0 on a clean join.
            const MAX_AUTO_REJOIN = 2;
            if (rejoinAttemptsRef.current < MAX_AUTO_REJOIN) {
              rejoinAttemptsRef.current += 1;
              diag.log("Auto-rejoin", {
                attempt: rejoinAttemptsRef.current,
                of: MAX_AUTO_REJOIN,
                reason: String(name),
              });
              showToast("Network issue — reconnecting…");
              setMediaError(null);
              setMediaPhase("connecting_media");
              setMediaRetryKey((k) => k + 1); // re-runs the connect effect (same path as Retry)
              return;
            }
            // Auto-rejoin exhausted → show an honest, network-specific failure
            // (not a blank "media server error") informed by the diagnostics.
            const _snap = diag.snapshot();
            const _failMsg = !_snap.turnAdvertised
              ? "Couldn't establish a media path — no TURN relay was available. Cross-network calls need a public TURN server. Try a different network (e.g. a mobile hotspot), or ask IT to enable TURN."
              : !_snap.turnUsed
                ? "Couldn't establish a media path. Your network is likely blocking video calls and the TURN relay wasn't reachable. Try another network, or ask IT to verify the TURN ports (3478 UDP/TCP, 5349/443 TLS)."
                : "Lost the media connection and couldn't recover after retrying. This is usually a network or firewall issue — try again or switch networks.";
            diag.log("Media Error", {
              fatal: true,
              reason: String(name),
              everConnected: everConnectedRef.current,
              turnAdvertised: _snap.turnAdvertised,
              turnUsed: _snap.turnUsed,
            });
            setMediaError(_failMsg);
            setMediaPhase("failed");
            setConnecting(false);
          })
          .on(LK.RoomEvent.Reconnecting, () => {
            console.warn("[livekit] media reconnecting…");
            // Network dropped — downgrade the indicator to "lost" since quality
            // stats stop arriving while offline (was staying stale-green).
            if (!cancelled) {
              setMediaPhase("connecting_media");
              setNetQuality("lost");
            }
          })
          .on(LK.RoomEvent.Reconnected, () => {
            const remotes = room ? room.remoteParticipants.size : 0;
            console.warn("[livekit] media reconnected remotes=%d", remotes);
            // Clear back to "unknown" so the next real measurement repaints it.
            if (!cancelled) {
              setNetQuality("unknown");
              markConnectedIfReady();
              const lp = room && room.localParticipant;
              if (lp) {
                // MIC-04: enforce local mic & cam intent upon reconnect — from
                // the LIVE intent refs, never this closure's join-time `mic`/
                // `cam` (which silently unmuted anyone who muted mid-call).
                Promise.resolve(lp.setMicrophoneEnabled(micIntentRef.current)).catch(() => {});
                Promise.resolve(lp.setCameraEnabled(camIntentRef.current)).catch(() => {});
                // MIC-02: re-report so the server re-asserts the mute against
                // whatever tracks this reconnect just re-published.
                api.reportMuteState(token, room.name, !micIntentRef.current).catch(() => {});
              }
              // Re-apply spatial panning + re-pull the whiteboard after the blip.
              try {
                relayoutGridRef.current && relayoutGridRef.current();
              } catch (_) {}
              setWbResyncNonce((n) => n + 1);
            }
          });

        const _wsUrl = preferSecureWsUrl(res.wsUrl);
        console.warn(
          "[call] ROOM_CONNECT_START inst=%s wsUrl=%s room=%s ts=%d",
          INST,
          _wsUrl,
          res.room,
          Date.now(),
        );
        diag.log("Room Join Attempt", { wsUrl: _wsUrl, room: res.room });
        await room.connect(_wsUrl, res.token);
        everConnectedRef.current = true;
        // E2EE media (gated): key the room with the conversation's shared epoch
        // key so all participants who can read the conversation derive the same
        // media key. No-op when E2EE is off. Best-effort — never breaks the call.
        // B3 — 1:1 calls (no group conversationId) now seed a 1:1 epoch via the
        // DM conversation resolved by the parent; getCallMediaKey will mint +
        // ECIES-wrap per device if no row exists yet, and reuse it on rejoin.
        // Gated on the MEDIA E2EE flag (not chat E2EE) so the key round-trips are
        // skipped while media E2EE is off (enableRoomE2EE would discard the key).
        if (isCallMediaE2EEOn()) {
          try {
            const ctx = (typeof resolveCallMediaCtx === "function" && resolveCallMediaCtx()) || {
              conversationId: call.conversationId || null,
              members: [] as string[],
            };
            if (ctx.conversationId) {
              const mk = await getCallMediaKey(token, ctx.conversationId, ctx.members || []);
              await enableRoomE2EE(room, mk);
            }
          } catch (_) {}
        }
        // Attach the stats poller + lifecycle listeners now that the PC exists.
        diag.attach(room, LK);
        diag.log("Room Joined", { room: res.room });
        rejoinAttemptsRef.current = 0;
        // Participant-first tile: ensure the local participant always has a tile,
        // even when camera is OFF. Video tracks attach to this tile later if the
        // local camera is enabled.
        if (room.localParticipant) {
          ensureCallTile(
            room.localParticipant.sid,
            room.localParticipant.name || "You",
            true,
            room.localParticipant.identity || "",
            !!room.localParticipant.isMicrophoneEnabled,
          );
        }
        // Already-present remotes: when you JOIN a room that already has people in
        // it, NO ParticipantConnected fires for them — so create their tiles now,
        // else the later joiner is left with an empty People panel (cross-browser
        // desync). Their published tracks attach later via TrackSubscribed.
        if (room.remoteParticipants) {
          for (const rp of room.remoteParticipants.values() as any) {
            if (rp && rp.sid)
              ensureCallTile(rp.sid, (rp as any).name || "Participant", false, (rp as any).identity || "", !!(rp as any).isMicrophoneEnabled);
          }
        }
        // …and the ROSTER has the same blind spot as the tiles: it refreshes on
        // ParticipantConnected/Disconnected, which never fire for people already
        // in the room when YOU join. Without this, a late joiner's callRoster
        // stayed [] (until the People panel's poll ran), so the header's
        // participant toggle — gated on roster length — rendered for the call
        // starter only.
        refreshRoster();
        // Tab close / browser quit / OS sleep on mobile: synchronously signal
        // the SFU so the participant is removed immediately instead of lingering
        // as a 15-90s ghost until the SFU notices the WS death. `pagehide` is
        // the only event mobile browsers fire reliably; `beforeunload` is the
        // desktop belt+braces. room.disconnect(true) sends a Leave frame.
        const onPageHide = () => {
          try {
            roomRef.current && roomRef.current.disconnect(true);
          } catch (_) {}
        };
        window.addEventListener("pagehide", onPageHide);
        window.addEventListener("beforeunload", onPageHide);
        localCleanup.push(() => {
          window.removeEventListener("pagehide", onPageHide);
          window.removeEventListener("beforeunload", onPageHide);
        });
        const localIdent =
          room.localParticipant && room.localParticipant.identity;
        console.warn(
          "[call] ROOM_CONNECT_SUCCESS inst=%s room=%s identity=%s sid=%s ts=%d",
          INST,
          res.room,
          localIdent,
          room.localParticipant && room.localParticipant.sid,
          Date.now(),
        );
        if (cancelled) {
          lkConnectingRef.current = null;
          console.warn(
            "[call] ROOM_CONNECT_CANCELLED inst=%s — disconnecting",
            INST,
          );
          console.trace(
            "[call] ROOM_DISCONNECT_CALL source=connect_cancelled inst=%s room=%s identity=%s",
            INST,
            res.room,
            localIdent,
          );
          try {
            room.disconnect();
          } catch (_) {}
          return;
        }
        // The room is already CONNECTED at this point. A device that fails to
        // start (camera "Could not start video source", mic in use by another
        // app) must NOT abort the call or get mis-reported as a media-server
        // failure — keep the call alive and let the user retry the device.
        try {
          // Join muted — do not auto-start the mic; the user unmutes when ready.
          await room.localParticipant.setMicrophoneEnabled(false);
          // Keep the React mic state in lock-step. This effect re-runs whenever
          // callId/conversationId change (e.g. "Add people" upgrades a 1:1 to a
          // group, or a Retry), and without this the button kept showing
          // "unmuted" while the track was actually muted — the user thought
          // they were speaking and nobody could hear them.
          if (!cancelled) setMic(false);
        } catch (micErr: any) {
          console.warn(
            "[call] MIC_ENABLE_FAIL inst=%s err=%s",
            INST,
            micErr && micErr.message,
          );
          if (!cancelled)
            showToast(
              "Couldn't start your microphone — close other apps using it, then unmute.",
            );
        }
        // Camera off by default too — only start it if the user explicitly
        // pre-toggled it (the user turns it on after joining otherwise).
        if (cam) {
          try {
            await room.localParticipant.setCameraEnabled(true);
            if (!cancelled) setCam(true);
          } catch (camErr: any) {
            console.warn(
              "[call] CAM_ENABLE_FAIL inst=%s err=%s",
              INST,
              camErr && camErr.message,
            );
            if (!cancelled) {
              setCam(false);
              showToast(
                "Couldn't start your camera — joined with video off. Close other apps using it, then press Start video.",
              );
            }
          }
        }
        // Try to start audio playback; if the browser blocks it (Safari/iOS,
        // Chrome before a gesture), surface the one-tap "Enable sound" prompt.
        try {
          await room.startAudio();
        } catch (_) {}
        if (!cancelled) setAudioBlocked(!room.canPlaybackAudio);
        try {
          const ds = await navigator.mediaDevices.enumerateDevices();
          if (!cancelled) {
            const mics = ds.filter((d) => d.kind === "audioinput");
            const cams = ds.filter((d) => d.kind === "videoinput");
            const speakers = ds.filter((d) => d.kind === "audiooutput");
            setDevices({ mics, cams, speakers });
            // Seed the pickers from the saved device so the dropdown reflects
            // what's actually capturing/playing (not just the first option).
            setSelMic(_sx.micId || (mics[0] && mics[0].deviceId) || "");
            setSelCam(_sx.cameraId || (cams[0] && cams[0].deviceId) || "");
            setSelSpk(
              _sx.speakerId || (speakers[0] && speakers[0].deviceId) || "",
            );
          }
        } catch (_) {}
        if (!cancelled) {
          setConnecting(false);
          console.warn(
            "[call] livekit connected — checking remote participants",
          );
          markConnectedIfReady();
          lkConnectingRef.current = null;
          if (!isGroup) {
            // Poll every 500ms until remote participant appears or we time out.
            // This replaces the old single-shot 1500ms timer that missed late
            // joiners and left the call stuck at "connecting_media" forever.
            let settled = false;
            const SETTLE_POLL_MS = 500;
            const SETTLE_TIMEOUT_MS = 15000;
            const settleStart = Date.now();
            const settleInterval = setInterval(() => {
              if (cancelled || settled) {
                clearInterval(settleInterval);
                return;
              }
              const remotes =
                room && room.remoteParticipants
                  ? room.remoteParticipants.size
                  : 0;
              console.warn(
                "[call] settlement poll remotes=%d elapsed=%dms",
                remotes,
                Date.now() - settleStart,
              );
              if (remotes > 0) {
                settled = true;
                clearInterval(settleInterval);
                markConnectedIfReady();
              } else if (Date.now() - settleStart > SETTLE_TIMEOUT_MS) {
                settled = true;
                clearInterval(settleInterval);
                console.warn(
                  "[call] settlement timeout — remote never joined after %dms",
                  SETTLE_TIMEOUT_MS,
                );
                setMediaError(
                  "The other party hasn't joined yet. You can wait or leave.",
                );
              }
            }, SETTLE_POLL_MS);
            localCleanup.push(() => clearInterval(settleInterval));
          }
        }
      } catch (e: any) {
        lkConnectingRef.current = null;
        console.warn(
          "[call] ROOM_CONNECT_FAIL inst=%s error=%s ts=%d",
          INST,
          e && e.message,
          Date.now(),
        );
        if (diag)
          diag.log("Media Error", { phase: "connect", err: e && e.message });
        if (!cancelled) {
          const _msg = e && e.message ? String(e.message) : "";
          const _status =
            (e && (e.status || (e.response && e.response.status))) || 0;
          const _detail = (e && (e.detail || e.reason || e.code || "")) + "";
          const _turnAdv = diag ? diag.snapshot().turnAdvertised : true;
          // 403 from /calls/token = membership/lock/lobby/eject. Don't blame
          // the media server in that case — it's an authorization decision.
          setMediaError(
            e && e.name === "NotAllowedError"
              ? "Microphone/camera permission denied — allow access, then rejoin."
              : _status === 403 && /lock/i.test(_msg + _detail)
                ? "This call is locked. Ask the host to unlock or admit you."
                : _status === 403 && /remov|eject|kick/i.test(_msg + _detail)
                  ? "You were removed from this call by the host."
                  : _status === 403
                    ? "You can't join this call — check the membership or ask the host."
                    : /getUserMedia|mediaDevices|secure context|isSecureContext/i.test(
                          _msg,
                        )
                      ? mediaBlockedReason() || _msg
                      : !_turnAdv
                        ? "Couldn't reach the media server, and no TURN relay was available for your network. Try a different network"
                        : "Couldn't reach the media server — usually a network or firewall issue. Check your connection or switch networks, then Retry.",
          );
          setMediaPhase("failed");
          setConnecting(false);
        }
      }
    })();
    return () => {
      cancelled = true;
      if (stageRO) {
        stageRO.disconnect();
        stageRO = null;
      }
      lkConnectingRef.current = null;
      localCleanup.forEach((fn) => fn());
      const inst = INST;
      const callIdent =
        room && room.localParticipant && room.localParticipant.identity;
      console.warn(
        "[call] EFFECT_CLEANUP inst=%s ts=%d hasRoom=%s identity=%s",
        inst,
        Date.now(),
        !!room,
        callIdent,
      );
      if (room) {
        console.trace(
          "[call] ROOM_DISCONNECT_CALL source=effect_cleanup inst=%s identity=%s",
          inst,
          callIdent,
        );
        // Signal disconnect so StrictMode remount can wait for it
        lkDisconnectingRef.current = (async () => {
          try {
            await room.disconnect();
          } catch (_) {}
          await new Promise((r) => setTimeout(r, 500));
        })();
      }
      // FIX: use captured variables instead of ref.current in cleanup
      tilesCurrent.forEach((v) => {
        try {
          v.tile.remove();
        } catch (_) {}
      });
      tilesCurrent.clear();
      if (audioCurrent) audioCurrent.innerHTML = "";
      roomRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, token, callId, call.conversationId, video, mediaRetryKey]);
}
