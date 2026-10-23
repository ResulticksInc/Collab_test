import { useEffect, useRef, useCallback } from "react";
import { EVENTS } from "../../../lib/socket";
import { api } from "../../../lib/api";
import { confirmDialog } from "../../../lib/dialog";
import { isDesktopApp } from "../../../lib/platform";
import { trackEvent, captureIssue } from "../../../lib/telemetry";
import { hasMediaDevices } from "../../../lib/mediaSupport";
import { buildParticipantActions } from "../../ParticipantMenu";
import type { WbMessage } from "../../Whiteboard";
import type { CallModalProps } from "./types";
import { useCallSessionCore } from "./useCallSessionCore";

// useCallSessionControls: call moderation + control-bar actions (mute/pin/record/
// screen-share/whiteboard/chat/reactions) and their small side-effect subscriptions.
export function useCallSessionControls(
  props: CallModalProps,
  core: ReturnType<typeof useCallSessionCore>,
) {
  const {
    audioRef, callChatCaptureRef, callChatDraft, callChatMsgs, callId, callPartMenu, cam, ensureSessionGroupId,
    handRaisedRef, isCallHost, isGroup, kind, localStreamRef, mic, openCallTileMenuRef, peer,
    presenter, recAddAudioRef, recAudioCtxRef, recBusy, recChunksRef, recMicStreamRef, recStartedAtRef, recorderRef,
    recording, recordingRef, remoteStreamRef, roomRef, screen, screenPending, sec, selCam,
    selMic, selSpk, setCallChatDraft, setCallChatEmoji, setCallChatMsgs, setCallChatUploading, setCallHands, setCallReactions,
    setCallTileMicRef, setCam, setMic, setPttTalking, setReactOpen, setRecBusy, setRecording, setScreenPending,
    setSelCam, setSelMic, setSelSpk, setSpk, sinkRef, spatialOn, spatialRef, spk,
    spkRef, status, video, wbReceiverRef,
  } = core;
  const { call, huddles, token, showToast, socket, onChangeSetting } = props;
  // Mirror the SDK's real microphone state into the control-bar toggle. A host's
  // "Mute everyone" is a SERVER-side mute: LiveKit stops our published audio and
  // fires TrackMuted for our own participant, which updated the tile badge but
  // left this `mic` state — the only thing the dock button reads — showing "on".
  // Reads isMicrophoneEnabled (the SDK's truth) so it is correct regardless of
  // which side initiated the change.
  // True only for a participant's MICROPHONE publication. Screen-share audio is
  // also kind "audio", so a kind-only test lets a presenter's shared tab drive
  // the mic-muted badge. Prefer the explicit source; fall back to kind only when
  // the publication reports no source.
  const isMicPublication = (pub: any) => {
    if (!pub) return false;
    if (pub.source) return pub.source === "microphone";
    return pub.kind === "audio";
  };

  const syncLocalMicState = (part: any) => {
    try {
      const room = roomRef.current;
      if (!room || !part || !part.isLocal) return;
      const live = !!room.localParticipant.isMicrophoneEnabled;
      setMic(live);
      // Being muted by a host used to be completely silent — the icon just
      // flipped, with no way to know why your microphone stopped working. Say
      // so, but only when WE didn't do it (selfMicChangeRef marks our own
      // toggle), so a normal self-mute stays quiet.
      if (!live && !selfMicChangeRef.current) {
        showToast("The host muted you. You can unmute yourself when you need to speak.");
      }
    } catch (_) {
      /* best-effort UI sync — never break media handling */
    }
  };
  // Marks a mic change WE initiated, so syncLocalMicState can tell a self-mute
  // apart from a host mute and only explain the latter.
  const selfMicChangeRef = useRef(false);

  // A host muted us. Muting the track at the SFU silences us for everyone else
  // but does NOT reliably reach this client, so the dock toggle and our own tile
  // kept showing "live" while nobody could hear us. Mute for real locally — that
  // makes the SDK, the toggle and the tile badge agree — and explain why.
  useEffect(() => {
    if (!socket) return;
    const onForceMute = (d: any) => {
      if (!d || d.scope !== "call") return;
      // Ignore an event meant for a DIFFERENT room. These are delivered to the
      // user's personal socket room, not the call's, so without this a stray or
      // replayed event would mute whatever call happens to be open. The meetings
      // handler has always checked this.
      const myRoomId = call.conversationId || call.callId;
      if (d.id && myRoomId && d.id !== myRoomId) return;
      // Claim this mic change as "ours" for the moment it takes to apply.
      // setMicrophoneEnabled(false) below fires TrackMuted, which re-enters
      // syncLocalMicState — without this flag that path treats it as a fresh
      // host mute and shows the SAME toast a second time.
      selfMicChangeRef.current = true;
      setTimeout(() => { selfMicChangeRef.current = false; }, 1500);
      setMic(false);
      const room = roomRef.current;
      const lp = room && room.localParticipant;
      if (lp) {
        Promise.resolve(lp.setMicrophoneEnabled(false)).catch(() => {});
        if (lp.sid) setCallTileMicRef.current?.(lp.sid, true);
      }
      showToast("The host muted you. You can unmute yourself when you need to speak.");
    };
    socket.on(EVENTS.MEDIA_FORCE_MUTE, onForceMute);
    return () => {
      socket.off(EVENTS.MEDIA_FORCE_MUTE, onForceMute);
    };
  }, [socket, showToast]);

  const toggleMic = async () => {
    const next = !mic;
    selfMicChangeRef.current = true;
    setTimeout(() => { selfMicChangeRef.current = false; }, 1500);
    setMic(next);
    // Update the local tile's mic-muted badge immediately (setMicrophoneEnabled
    // also fires TrackMuted/TrackUnmuted, but reflecting it now avoids any lag).
    const lsid = roomRef.current && roomRef.current.localParticipant && roomRef.current.localParticipant.sid;
    if (lsid) setCallTileMicRef.current?.(lsid, !next);
    if (roomRef.current) {
      const micT0 = Date.now();
      try {
        await roomRef.current.localParticipant.setMicrophoneEnabled(next);
        const micMs = Date.now() - micT0; // §9.2 mute/unmute latency, bucketed
        trackEvent("mic.toggle." + (next ? "on" : "off"));
        trackEvent(micMs < 200 ? "mic.latency.lt200" : micMs < 1000 ? "mic.latency.lt1000" : "mic.latency.slow");
        // MIC-02: report our own state so a mute is ALSO enforced at the SFU.
        // Fire-and-forget — a lost report never affects the UI, and the hard
        // mute above already stopped capture locally.
        api.reportMuteState(token, roomRef.current.name, !next).catch(() => {});
      } catch (e: any) {
        console.warn("[call] TOGGLE_MIC_FAIL err=%s", e && e.message);
        // §9.1 Sev-1 class: mute reconcile failure (UI reverted).
        captureIssue("media", "mic toggle failed and reverted (call)", { wanted: next ? "on" : "off" });
        trackEvent("mic.reconcile.failed");
        setMic(!next);
        if (lsid) setCallTileMicRef.current?.(lsid, next);
        showToast(
          "Couldn't access your microphone — check permissions and try again.",
        );
      }
    }
  };

  // ── Global shortcut: toggle mic mute (DESKTOP ONLY) ──────────────────────
  // The Electron shell's OS-wide CommandOrControl+Shift+M sends "toggle-mute".
  // We invoke the SAME toggleMic the call control bar uses (never a second mute
  // path) and only while media is connected. A ref keeps the latest closure so
  // the subscription is set up once. Inert in the browser.
  const toggleMicRef = useRef(toggleMic);
  toggleMicRef.current = toggleMic;
  useEffect(() => {
    if (!isDesktopApp) return;
    const cd = (window as any).collabDesktop;
    if (!cd || typeof cd.onGlobalShortcut !== "function") return;
    const off = cd.onGlobalShortcut((payload: { action?: string }) => {
      if (payload && payload.action === "toggle-mute" && status === "connected") {
        toggleMicRef.current();
      }
    });
    return typeof off === "function" ? off : undefined;
  }, [status]);

  // ── In-call reactions + raise-hand (DataChannel, parity with meetings) ──
  const publishCall = (obj: any) => {
    try {
      const r = roomRef.current;
      if (r && r.localParticipant)
        r.localParticipant.publishData(
          new TextEncoder().encode(JSON.stringify(obj)),
          { reliable: true },
        );
    } catch (_) {}
  };
  const sendCallReaction = (emoji: string) => {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    setCallReactions((prev) => [...prev, { id, emoji, name: "You" }]);
    setTimeout(
      () => setCallReactions((prev) => prev.filter((r) => r.id !== id)),
      4000,
    );
    publishCall({ t: "react", emoji });
    setReactOpen(false);
  };
  const toggleCallHand = () => {
    const raised = !handRaisedRef.current;
    handRaisedRef.current = raised;
    // Local hand keyed by a constant that can't collide with a remote
    // participant identity/sid; shown as "You" in the pill.
    setCallHands((prev) =>
      raised
        ? prev.some((h) => h.id === "__me__")
          ? prev
          : [...prev, { id: "__me__", name: "You" }]
        : prev.filter((h) => h.id !== "__me__"),
    );
    publishCall({ t: "hand", raised });
  };
  // In-call chat (panel Chat tab) — DataChannel, parity with the meeting chat.
  const newChatId = () =>
    Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const sendCallChat = () => {
    const text = callChatDraft.trim();
    if (!text) return;
    setCallChatMsgs((prev) => [
      ...prev,
      { id: newChatId(), name: "You", text, ts: Date.now(), self: true },
    ]);
    setCallChatDraft("");
    setCallChatEmoji(false);
    publishCall({ t: "chat", text });
    // First message IS collaboration — mint the temp group now (which surfaces the
    // duplicate prompt during the call), so the destination is fixed before the
    // hangup transcript port lands. Concurrency-guarded → fires the prompt once.
    void ensureSessionGroupId();
  };
  const insertCallChatEmoji = (e: string) => {
    setCallChatDraft((d) => d + e);
    setCallChatEmoji(false);
  };
  // Attachment: the DataChannel is too small for file bytes, so upload over HTTP
  // and broadcast a lightweight descriptor peers render the same way (parity with
  // the meeting chat; both download via api.downloadFile).
  const sendCallChatFile = async (file: File) => {
    if (!file) return;
    setCallChatUploading(true);
    try {
      // Upload INTO the call's live temp group so every participant (a member of
      // that group) passes the backend file-permission check and can download it.
      // Without a conversationId the file is owned by no conversation and 404s for
      // everyone but the uploader (the reported "can't download in calls chat").
      const cid = await ensureSessionGroupId();
      const desc = await api.uploadFile(token, file, cid || undefined);
      setCallChatMsgs((prev) => [
        ...prev,
        { id: newChatId(), name: "You", text: "", ts: Date.now(), self: true, file: desc },
      ]);
      publishCall({ t: "chat", text: "", file: desc });
    } catch {
      showToast("Couldn't upload the file");
    } finally {
      setCallChatUploading(false);
    }
  };
  const CALL_REACTIONS = ["👍", "❤️", "😂", "🎉", "👏", "😮"];

  // Push-to-talk: while muted, hold Space to talk; release to re-mute. Ignored
  // when typing in an input (chat, device pickers) so it doesn't hijack Space.
  const pttActiveRef = useRef(false);
  useEffect(() => {
    if (status !== "connected") return;
    const isTyping = (t: any) =>
      t &&
      (t.tagName === "INPUT" ||
        t.tagName === "TEXTAREA" ||
        t.tagName === "SELECT" ||
        t.isContentEditable);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat || isTyping(e.target)) return;
      if (mic || pttActiveRef.current) return;
      e.preventDefault();
      pttActiveRef.current = true;
      roomRef.current &&
        roomRef.current.localParticipant.setMicrophoneEnabled(true);
      setPttTalking(true);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== "Space" || !pttActiveRef.current) return;
      e.preventDefault();
      pttActiveRef.current = false;
      roomRef.current &&
        roomRef.current.localParticipant.setMicrophoneEnabled(false);
      setPttTalking(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      // Restore the user's intended mute state if we were mid-talk on unmount.
      if (pttActiveRef.current) {
        pttActiveRef.current = false;
        roomRef.current &&
          roomRef.current.localParticipant.setMicrophoneEnabled(false);
      }
    };
  }, [status, mic]);
  // Camera toggle — also the audio→video "upgrade" path: in an audio call the
  // user can press Start video and we publish a camera track on the existing
  // connection. A camera that fails to acquire reverts the toggle (non-fatal).
  const toggleCam = async () => {
    const next = !cam;
    setCam(next);
    if (roomRef.current) {
      try {
        await roomRef.current.localParticipant.setCameraEnabled(next);
      } catch (e: any) {
        console.warn("[call] TOGGLE_CAM_FAIL err=%s", e && e.message);
        setCam(false);
        showToast(
          "Couldn't start your camera — close other apps using it and try again.",
        );
      }
    }
  };
  const toggleScreen = async () => {
    const r = roomRef.current;
    if (!r) return;
    if (screenPending && !screen) return; // ignore repeat START clicks; never block a STOP
    const next = !screen;
    // `screen` is owned by the LocalTrackPublished/Unpublished events (single
    // source of truth), so we only raise a PENDING spinner while starting.
    if (next) setScreenPending(true);
    try {
      // Request tab/system audio too (best-effort). Options ignored on stop.
      const req = r.localParticipant.setScreenShareEnabled(next, {
        audio: true,
        systemAudio: "include",
      });
      // BA/CEO #3: bound the picker round-trip so a slow/hung picker never hangs.
      await (next
        ? Promise.race([
            req,
            new Promise((_, rej) => setTimeout(() => rej(new Error("SCREEN_TIMEOUT")), 15000)),
          ])
        : req);
    } catch (e: any) {
      const name = (e && (e.name || e.message)) || "";
      if (name === "SCREEN_TIMEOUT") {
        try {
          await r.localParticipant.setScreenShareEnabled(false);
        } catch (_) {}
      } else if (name !== "NotAllowedError" && name !== "AbortError") {
        showToast("Couldn't start screen share.");
      }
      // NotAllowedError / AbortError = user cancelled the picker → silent.
    } finally {
      setScreenPending(false);
    }
  };
  // Moderation targets the group room (conv_<id>) when the call has a
  // conversation, else the 1:1 room (call_<id>). Same UI, two backend routes.
  // ONE-WAY by design. There is no "unmute everyone": switching someone's mic
  // back on is their own consent to give. Each person unmutes themselves.
  const muteAllGroup = async () => {
    try {
      // Same as meetings: the endpoint reports how many audio tracks it actually
      // muted and returns 200 even when that is zero, so a blanket success toast
      // could claim "Everyone muted" while every microphone stayed live.
      let res: any = null;
      if (call.conversationId) res = await api.muteAllGroupCall(token, call.conversationId);
      else if (call.callId) res = await api.muteAllDirectCall(token, call.callId);
      else return;
      const r = res?.data ?? res ?? {};
      const muted = Number(r.mutedTracks ?? 0);
      const audio = Number(r.audioTracks ?? 0);
      if (muted > 0) {
        showToast("Everyone muted — each person can unmute themselves.");
      } else if (r.sfuReachable === false) {
        // The media server couldn't be reached, so nothing was muted. Never let
        // this read as success.
        showToast("Couldn't reach the media server — no one was muted. Please try again.");
      } else if (audio > 0) {
        // Live microphones existed and none were muted: a real failure, not a
        // quiet call. Never report this as success.
        showToast("Couldn't mute everyone — please try again in a moment.");
      } else {
        showToast(
          "No one to mute — everyone else already has their microphone off.",
        );
      }
    } catch (e: any) {
      showToast(e?.message || "Couldn't mute everyone");
    }
  };
  const mutePeerInGroup = async (identity: string) => {
    try {
      // Answers 200 even when nothing happened (media server unreachable, or the
      // person already left), so branch on what it actually reports rather than
      // claiming success — that silence is what hid the mute bug.
      let r: any = null;
      if (call.conversationId)
        r = await api.muteGroupCallParticipant(token, call.conversationId, identity);
      else if (call.callId)
        r = await api.muteDirectCallParticipant(token, call.callId, identity);
      else return;
      const d: any = r || {};
      if (d.sfuReachable === false) {
        showToast("Couldn't reach the media server — that person wasn't muted.");
      } else if (d.inRoom === false) {
        showToast("That person has already left the call.");
      } else {
        showToast("Participant muted");
      }
    } catch {
      showToast("Failed to mute participant");
    }
  };
  const removePeerFromGroup = async (identity: string) => {
    try {
      if (call.conversationId)
        await api.removeGroupCallParticipant(
          token,
          call.conversationId,
          identity,
        );
      else if (call.callId)
        await api.removeDirectCallParticipant(token, call.callId, identity);
      else return;
      showToast("Participant removed");
    } catch {
      showToast("Failed to remove participant");
    }
  };
  // ── Shared per-participant overflow (⋮) menu — calls + group calls ──────────
  // Replaces the old hardcoded host-controls overlay. Every REMOTE tile carries a
  // ⋮ that opens the ONE shared ParticipantMenu (identical to meetings): pin-for-me
  // for everyone, plus Mute / Remove for the group host. Tiles are keyed by LiveKit
  // sid but the mute/remove APIs take identity, so we resolve sid→identity from the
  // live room at click time. The opener is stored in a ref so a ⋮ button bound once
  // at tile-creation time always sees the CURRENT host/handler state.
  const openCallTileMenu = (btnEl: HTMLElement, tile: HTMLElement) => {
    const room = roomRef.current;
    const sid = tile.dataset.pid || "";
    let lp: any = null;
    if (room) {
      if (room.localParticipant?.sid === sid) lp = room.localParticipant;
      else {
        const rem: any = room.remoteParticipants;
        const iter: any = rem?.values ? rem.values() : rem ? Object.values(rem) : [];
        for (const p of iter) {
          if (p?.sid === sid) { lp = p; break; }
        }
      }
    }
    const identity: string = lp?.identity || "";
    // LiveKit identity is "<userId>__<per-join-uuid>"; the host-control endpoints
    // resolve by the BASE user id (backend findLiveIdentity strips the __uuid).
    // Passing the FULL identity here made Mute/Remove silently no-op in group calls
    // (no participant's base id equals the full string) — strip it to the base id.
    const sepIdx = identity.indexOf("__");
    const userId: string = sepIdx === -1 ? identity : identity.slice(0, sepIdx);
    const name: string = lp?.name || tile.dataset.name || "Participant";
    const isSelf = !!lp?.isLocal || tile.dataset.local === "true";
    // The tile's participant left between render and click (an avatar placeholder
    // can linger after a disconnect) — give feedback instead of opening a menu
    // whose Mute/Remove would silently no-op on a now-empty identity.
    if (!isSelf && !lp) {
      showToast(`${name} is no longer in the call`);
      return;
    }
    const canManage = isCallHost && !isSelf && !!identity;
    const actions = buildParticipantActions({
      isSelf,
      canManage,
      canPromote: false, // calls have no co-host role
      onMute: canManage ? () => mutePeerInGroup(userId) : undefined,
      onRemove: canManage ? () => removePeerFromGroup(userId) : undefined,
    });
    callPartMenu.open(btnEl, actions, name);
  };
  openCallTileMenuRef.current = openCallTileMenu;
  // One place that returns the recorder UI to a clean idle state — used by the
  // error path and by the "recorder already inactive" branch, both of which
  // previously left the dock stuck showing Stop with a live REC badge.
  const resetRecordingState = () => {
    setRecording(false);
    recordingRef.current = false;
    setRecBusy(false);
    recorderRef.current = null;
    try { recBroadcast(false); } catch (_) {}
  };
  const toggleRecord = async () => {
    if (recording) {
      // Stop safely: never stop before the first chunk has had time to land
      // (a start→stop inside ~1s flushed only a header → bogus "empty
      // recording"), force a final chunk, and never call stop() twice.
      setRecBusy(true);
      try {
        const r = recorderRef.current;
        if (r && r.state !== "inactive") {
          const held = 1200 - (Date.now() - (recStartedAtRef.current || 0));
          if (held > 0) await new Promise((res) => setTimeout(res, held));
          try { r.requestData(); } catch (_) {}
          r.stop();
        } else {
          // Recorder already gone (error/teardown) — clear the whole UI state,
          // not just the busy flag, or Stop stays stuck forever.
          resetRecordingState();
        }
      } catch (_) {
        resetRecordingState();
      }
      return;
    }
    {
      const ok = await confirmDialog(
        "Recording will capture audio and video from this call. By continuing, you confirm that all participants have been informed and consent to being recorded.",
        { title: "Start recording?", confirmText: "Start recording" },
      );
      if (!ok) return;
    }
    const local = localStreamRef.current; // used for the VIDEO track fallback below
    const remote = remoteStreamRef.current;
    try {
      let recordStream: MediaStream;
      let hasVideo = false;
      try {
        const Ctx =
          (window as any).AudioContext || (window as any).webkitAudioContext;
        const ac = new Ctx();
        recAudioCtxRef.current = ac;
        // A fresh AudioContext starts SUSPENDED under the browser autoplay
        // policy; while suspended no samples flow through the destination and the
        // recording ends up an empty ~110-byte WebM header. Resume it (we're
        // inside the record-button user gesture, so this is allowed).
        try {
          if (ac.state === "suspended") await ac.resume();
        } catch (_) {}
        const dest = ac.createMediaStreamDestination();
        let audioSources = 0;
        // Pull audio straight from the LiveKit publications, wrapping EACH track
        // in its own MediaStream (createMediaStreamSource only consumes a
        // stream's FIRST audio track — so remoteStreamRef, a single accumulator
        // of all remotes, would record only one). Mirrors MeetingStage's recorder.
        // The old code read stale `localStreamRef/remoteStreamRef` snapshots which
        // are BOTH null on a normal LiveKit call (mic off by default), so nothing
        // was ever connected → the empty-recording bug.
        const seenAudio = new Set<string>();
        const addAudio = (pub: any) => {
          try {
            const t = pub && pub.track && pub.track.mediaStreamTrack;
            if (!t || t.kind !== "audio") return;
            if (seenAudio.has(t.id)) return; // a track can only be sourced once
            seenAudio.add(t.id);
            ac.createMediaStreamSource(new MediaStream([t])).connect(dest);
            audioSources++;
          } catch (_) {
            /* already sourced / dead track */
          }
        };
        // Keep mixing audio that arrives AFTER Record was pressed — a late
        // joiner, or the peer unmuting. Previously sources were wired once at
        // start, so anyone who spoke up later was missing from the recording
        // entirely. Cleared in onstop.
        recAddAudioRef.current = addAudio;
        const room = roomRef.current as any;
        if (room) {
          const lp = room.localParticipant;
          const lpPubs = lp && (lp.audioTrackPublications || lp.trackPublications);
          if (lpPubs && lpPubs.forEach) lpPubs.forEach(addAudio);
          const remotes = room.remoteParticipants || room.participants;
          if (remotes && remotes.forEach)
            remotes.forEach((p: any) => {
              const pubs = p.audioTrackPublications || p.trackPublications;
              if (pubs && pubs.forEach) pubs.forEach(addAudio);
            });
        }
        // Mic OFF by default → no local audio publication. Grab it directly and
        // CONNECT it (the old fallback wrote localStreamRef but the graph read a
        // stale const, so it was silently dropped). Released in rec.onstop.
        if (audioSources === 0 && hasMediaDevices()) {
          try {
            const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
            recMicStreamRef.current = mic;
            ac.createMediaStreamSource(mic).connect(dest);
            audioSources++;
          } catch (_) {}
        }
        // Video: pick a track that is actually LIVE. Taking [0] blindly was the
        // main cause of "sometimes it records, sometimes it says nothing was
        // captured": the refs accumulate every track ever seen, so [0] was often
        // an ENDED screen share or a switched-off camera. A dead/muted track
        // never emits a frame, so the encoder stalls and the blob comes out as a
        // bare header. Also re-read the refs HERE (not the pre-await snapshot) —
        // getUserMedia above can block for seconds behind a permission prompt.
        const liveVideo = (s: any) =>
          s && s.getVideoTracks
            ? s.getVideoTracks().find((t: any) => t.readyState === "live" && !t.muted)
            : null;
        const videoTrack =
          liveVideo(remoteStreamRef.current) || liveVideo(localStreamRef.current);
        const tracks: MediaStreamTrack[] = [...dest.stream.getAudioTracks()];
        if (videoTrack) {
          tracks.push(videoTrack);
          hasVideo = true;
          // If the chosen camera/share ends mid-recording, flush instead of
          // letting the muxer stall on a dead input.
          try {
            videoTrack.addEventListener("ended", () => {
              try {
                const r = recorderRef.current;
                if (r && r.state === "recording") r.stop();
              } catch (_) {}
            });
          } catch (_) {}
        }
        if (audioSources === 0 && !hasVideo) {
          // Truly nothing audible or visible to capture.
          try {
            ac.close();
          } catch (_) {}
          recAudioCtxRef.current = null;
          showToast(
            "Nothing to record yet — turn on your mic or camera, or wait for someone to join.",
          );
          return;
        }
        recordStream = new MediaStream(tracks);
      } catch (_) {
        recordStream = local || remote;
        hasVideo = !!(recordStream && recordStream.getVideoTracks().length);
      }
      // Pick a supported container/codec explicitly. A no-option MediaRecorder
      // can default to a type the browser won't actually encode for VIDEO,
      // producing an empty/invalid file — audio just happened to work on the
      // default. This is why video-call recordings weren't saving. Mirrors the
      // meeting recorder's codec selection.
      let recOpts: any = {
        videoBitsPerSecond: 1_200_000,
        audioBitsPerSecond: 128_000,
      };
      if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported) {
        const prefs = hasVideo
          ? [
              "video/webm;codecs=vp9,opus",
              "video/webm;codecs=vp8,opus",
              "video/webm",
            ]
          : ["audio/webm;codecs=opus", "audio/webm"];
        const okType = prefs.find((t) => MediaRecorder.isTypeSupported(t));
        if (okType) recOpts.mimeType = okType;
      }
      const rec = new MediaRecorder(recordStream, recOpts);
      recChunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size) recChunksRef.current.push(e.data);
      };
      const recStartedAt = Date.now();
      recStartedAtRef.current = recStartedAt; // read by the stop-too-soon guard
      // Surface encoder failures instead of letting them look like "empty".
      rec.onerror = (e: any) => {
        console.warn("[call] RECORDER_ERROR", e && e.error);
        showToast("Recording failed — " + ((e && e.error && e.error.name) || "encoder error"));
        // FULL reset: clearing only recBusy left `recording` true, so the dock
        // stayed stuck on "Stop" with the REC badge still broadcast to peers,
        // and the next Stop click hit the inactive-recorder branch and returned
        // without ever clearing it.
        resetRecordingState();
      };
      rec.onstop = async () => {
        recAddAudioRef.current = null; // stop mixing late tracks
        // Release the fallback mic (if we opened one) so the OS mic indicator clears.
        try {
          recMicStreamRef.current &&
            recMicStreamRef.current.getTracks().forEach((t) => t.stop());
        } catch (_) {}
        recMicStreamRef.current = null;
        const mime = hasVideo ? "video/webm" : "audio/webm";
        const blob = new Blob(recChunksRef.current, { type: mime });
        // A near-empty blob means no media was actually captured (mic blocked,
        // context suspended, or stopped instantly). Don't save/produce a useless
        // ~110-byte file — tell the user so they can retry.
        if (!recChunksRef.current.length || blob.size < 1024) {
          try {
            recAudioCtxRef.current && recAudioCtxRef.current.close();
          } catch (_) {}
          recAudioCtxRef.current = null;
          setRecording(false);
          recordingRef.current = false;
          setRecBusy(false);
          recBroadcast(false);
          showToast("Recording was empty — nothing was captured. Please try again.");
          return;
        }
        // The recording is delivered to the call CHAT only — NEVER
        // auto-downloaded to the recorder's machine. Each person opens/plays it
        // from chat and downloads there on demand (per-user choice).
        try {
          recAudioCtxRef.current && recAudioCtxRef.current.close();
        } catch (_) {}
        recAudioCtxRef.current = null;
        setRecording(false);
        recordingRef.current = false;
        recBroadcast(false);
        // Persist the recording into the call chat (parity with meetings, where the
        // recording lands in the chat as a Play/Download attachment). Call chat is
        // ephemeral, so upload the blob as a FILE and append it to callChatMsgs —
        // the on-unmount capture then ports it into the auto-created temp group, and
        // publishCall shows it to the peer live during the call.
        try {
          const durationSec = Math.max(
            0,
            Math.round((Date.now() - recStartedAt) / 1000),
          );
          const mm = Math.floor(durationSec / 60);
          const ss = String(durationSec % 60).padStart(2, "0");
          const recFile = new File(
            [blob],
            `call-recording-${mm}m${ss}s.webm`,
            { type: mime },
          );
          // Group calls: attach the upload to the group conversation so every
          // member passes permissionFor's membership grant and can play the
          // recording DURING the call. 1:1 calls have no conversation yet — the
          // temp-group port adopts the orphan file at hangup instead.
          const liveConvId =
            (callChatCaptureRef.current &&
              callChatCaptureRef.current.call &&
              callChatCaptureRef.current.call.conversationId) ||
            undefined;
          const desc = await api.uploadFile(token, recFile, liveConvId);
          // 1:1: grant the peer view access right away (best-effort) so they
          // can play the recording DURING the call too — the temp-group port
          // adopts the file for post-call access regardless.
          try {
            const cc = callChatCaptureRef.current || {};
            const recPeerId =
              !cc.isGroup && cc.call && cc.call.peer && cc.call.peer.id;
            if (recPeerId && desc && desc.id)
              Promise.resolve(
                api.shareFile(token, desc.id, "user", recPeerId, "view"),
              ).catch(() => {});
          } catch (_) {}
          const label = `${hasVideo ? "📹" : "🎙️"} Call recording (${mm}:${ss})`;
          setCallChatMsgs((prev) => [
            ...prev,
            {
              id: newChatId(),
              name: "You",
              text: label,
              ts: Date.now(),
              self: true,
              file: desc,
            },
          ]);
          try {
            publishCall({ t: "chat", text: label, file: desc });
          } catch (_) {}
          // Post the recording DIRECTLY into the session's temp group. The
          // unmount transcript port snapshots callChatMsgs BEFORE the recorder
          // stops, so hanging up while recording dropped the file from the group
          // entirely — the reported "recordings are in call chat but not in the
          // temp group". Posting here is independent of teardown ordering.
          try {
            // A recording IS collaboration — mint the temp group on-demand if it
            // doesn't exist yet (eager roster-tick creation was removed), so the
            // clip lands in the group even when nothing else was shared first.
            const gid = await ensureSessionGroupId();
            if (gid) await api.sendPayload(token, gid, { text: label, file: desc });
          } catch (_) {
            /* best-effort — it is still in the call chat + transcript port */
          }
          showToast("Recording saved to chat — open it there to play or download.");
        } catch (_) {
          // Emergency local download fallback so recording is never lost on network or upload error
          try {
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `call-recording-${Date.now()}.webm`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 10000);
            showToast("Upload failed — saved recording to your device instead.");
          } catch {
            showToast("Couldn't save the recording. Please try again.");
          }
        } finally {
          setRecBusy(false);
        }
      };
      // Collect a chunk every second so even a short recording captures data
      // (a no-arg start() only emits one chunk at stop()).
      rec.start(1000);
      recorderRef.current = rec;
      setRecording(true);
      recordingRef.current = true;
      recBroadcast(true);
      showToast("Recording started");
    } catch (_) {
      // Release anything opened before the throw (rec.onstop never fires here) so
      // the OS mic indicator clears and the AudioContext doesn't leak; without
      // this a retry would open a second mic.
      try {
        recMicStreamRef.current &&
          recMicStreamRef.current.getTracks().forEach((t) => t.stop());
      } catch (_e) {}
      recMicStreamRef.current = null;
      try {
        recAudioCtxRef.current && recAudioCtxRef.current.close();
      } catch (_e) {}
      recAudioCtxRef.current = null;
      showToast("Recording isn't supported in this browser");
    }
  };
  // Apply spatial on/off to the live audio graph without dropping audio,
  // and remember the choice across calls.
  useEffect(() => {
    spatialRef.current && spatialRef.current.setEnabled(spatialOn);
    try {
      localStorage.setItem("clb_spatial_audio", spatialOn ? "1" : "0");
    } catch (_) {}
  }, [spatialOn]);
  // Tear the spatial audio graph down when this view unmounts.
  useEffect(
    () => () => {
      spatialRef.current && spatialRef.current.close();
      spatialRef.current = null;
    },
    [],
  );
  // Whiteboard sync over the LiveKit data channel (t:"wb").
  const wbBroadcast = useCallback((m: WbMessage) => {
    const room = roomRef.current;
    if (!room || !room.localParticipant) return;
    try {
      room.localParticipant.publishData(
        new TextEncoder().encode(JSON.stringify({ t: "wb", wb: m })),
        { reliable: true },
      );
    } catch (_) {}
  }, []);
  // Broadcast our recording state to every participant over the LiveKit data
  // channel (t:"rec"), so peers show the shared REC indicator (privacy/consent).
  const recBroadcast = useCallback((on: boolean) => {
    const room = roomRef.current;
    if (!room || !room.localParticipant) return;
    try {
      room.localParticipant.publishData(
        new TextEncoder().encode(JSON.stringify({ t: "rec", on })),
        { reliable: true },
      );
    } catch (_) {}
  }, []);
  const wbRegisterReceiver = useCallback(
    (fn: (m: WbMessage, meta?: { fromModerator?: boolean }) => void) => {
      wbReceiverRef.current = fn;
      return () => {
        if (wbReceiverRef.current === fn) wbReceiverRef.current = null;
      };
    },
    [],
  );
  // Durable whiteboard snapshot (server-persisted). `call` + `socket` are
  // CallModal props. 1:1 calls key by the call id; group huddles have no callId
  // (they're identified by conversationId), so key those by the conversation so
  // the group's board also persists across all-leave / rejoin. The backend
  // canAccessBoard() authorizes `call:<conversationId>` via conversation
  // membership, so no server change is needed.
  const wbBoardKey =
    call && call.callId
      ? "call:" + call.callId
      : call && call.conversationId
        ? "call:" + call.conversationId
        : "";
  const wbLoad = useCallback(() => {
    return new Promise<any[] | null>((resolve) => {
      if (!socket || !wbBoardKey) return resolve(null);
      let done = false;
      const to = setTimeout(() => {
        if (!done) {
          done = true;
          resolve(null);
        }
      }, 4000);
      socket.emit("wb:load", { boardKey: wbBoardKey }, (data: any) => {
        if (done) return;
        done = true;
        clearTimeout(to);
        resolve(data && Array.isArray(data.pages) ? data.pages : null);
      });
    });
  }, [socket, wbBoardKey]);
  const wbSave = useCallback(
    (pages: any) => {
      if (socket && wbBoardKey)
        socket.emit("wb:save", { boardKey: wbBoardKey, data: { v: 1, pages } });
    },
    [socket, wbBoardKey],
  );

  const toggleSpk = () => {
    const next = !spk;
    spkRef.current = next;
    setSpk(next);
    if (audioRef.current)
      Array.from(audioRef.current.children).forEach((a: any) => {
        if (a && a.dataset && a.dataset.spatial) return; // manager handles these
        a.muted = !next;
      });
    // Spatial-audio tracks play through Web Audio (not the <audio> elements
    // above), so mute them via the manager too.
    spatialRef.current && spatialRef.current.setMuted(!next);
  };
  const switchMic = async (id) => {
    const prev = selMic;
    setSelMic(id);
    try {
      if (roomRef.current)
        await roomRef.current.switchActiveDevice("audioinput", id);
      onChangeSetting && onChangeSetting("micId", id);
    } catch (e) {
      setSelMic(prev);
      showToast && showToast("Couldn't switch microphone");
    }
  };
  const switchCam = async (id) => {
    const prev = selCam;
    setSelCam(id);
    try {
      if (roomRef.current)
        await roomRef.current.switchActiveDevice("videoinput", id);
      onChangeSetting && onChangeSetting("cameraId", id);
    } catch (e) {
      setSelCam(prev);
      showToast && showToast("Couldn't switch camera");
    }
  };
  const switchSpk = async (id) => {
    const prev = selSpk;
    setSelSpk(id);
    sinkRef.current = id;
    spatialRef.current && spatialRef.current.setSinkId(id);
    try {
      // Route via LiveKit when it supports the audio sink; always also push
      // setSinkId onto the attached <audio> elements as the reliable path
      // (LiveKit's audioOutput only governs tracks it created).
      if (
        roomRef.current &&
        typeof roomRef.current.switchActiveDevice === "function"
      ) {
        await roomRef.current
          .switchActiveDevice("audiooutput", id)
          .catch(() => {});
      }
      const host = audioRef.current;
      if (host) {
        await Promise.all(
          Array.from(host.children || []).map((a: any) =>
            a && a.dataset && a.dataset.spatial
              ? null // manager owns the spatial sink
              : a && typeof a.setSinkId === "function"
                ? a.setSinkId(id).catch(() => {})
                : null,
          ),
        );
      }
      onChangeSetting && onChangeSetting("speakerId", id);
    } catch (e) {
      setSelSpk(prev);
      sinkRef.current = prev;
      showToast && showToast("Couldn't switch speaker");
    }
  };

  const hh = Math.floor(sec / 3600);
  const mm = String(Math.floor((sec % 3600) / 60)).padStart(2, "0");
  const ss = String(sec % 60).padStart(2, "0");
  return {
    CALL_REACTIONS, hh, insertCallChatEmoji, isMicPublication, mm, muteAllGroup, mutePeerInGroup, newChatId,
    openCallTileMenu, pttActiveRef, publishCall, recBroadcast, removePeerFromGroup, resetRecordingState, selfMicChangeRef, sendCallChat,
    sendCallChatFile, sendCallReaction, ss, switchCam, switchMic, switchSpk, syncLocalMicState, toggleCallHand,
    toggleCam, toggleMic, toggleMicRef, toggleRecord, toggleScreen, toggleSpk, wbBoardKey, wbBroadcast,
    wbLoad, wbRegisterReceiver, wbSave,
  };
}
