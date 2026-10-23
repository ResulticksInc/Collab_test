import { useState, useEffect, useRef, useCallback } from "react";
import { useEsc } from "../../../lib/escStack";
import { useInlineMentions } from "../../../lib/useInlineMentions";
import { usePresenterMode } from "../../../lib/presenter/usePresenterMode";
import { useParticipantMenu } from "../../ParticipantMenu";
import type { Rect } from "../../EmojiPicker";
import { api } from "../../../lib/api";
import type { CallDiagnostics } from "../../../lib/callDiagnostics";
import { playPattern, MESSAGE_TONE } from "../../../lib/sounds";
import { chooseDialog } from "../../../lib/dialog";
import { SpatialAudioManager } from "../../../lib/spatialAudio";
import { setPresenting } from "../../../lib/presentation";
import { fsRequest, fsExit, fsElement } from "../helpers";
import type { WbMessage } from "../../Whiteboard";
import type { CallModalProps } from "./types";
import { avatarUrlOf, baseUid, roleOf } from "../../../lib/meeting/identity";
import { useGalleryPageSize } from "../../../lib/galleryPaging";
import { loadStageViewPrefs, saveStageViewPrefs, type StageViewPrefs, loadCallLayout, saveCallLayout, type CallLayout } from "../../../lib/stageView";
import { resolveMediaUrl } from "../../../lib/image";

// useCallSessionCore: every piece of CallModal state/derivation/ref that the
// media hook, control actions and the rendered JSX share (decomposition of the
// former 5.4k-line inline CallModal). Pure logic — no JSX.
export function useCallSessionCore(props: CallModalProps) {
  const {
    call,
    huddles,
    token,
    meId,
    // Called with the conversation returned by /temp-from-session, so the parent
    // can show the preserved call chat (and its expiry banner) immediately.
    onTempGroupCreated,
    onAccept,
    onDecline,
    onCancel,
    onHangup,
    onAddPeople,
    addPeople,
    onSearchPeople,
    showToast,
    socket,
    settings,
    onChangeSetting,
    isGroupHost = false,
    onMinimize,
    pip,
    resolveCallMediaCtx,
    onMoveDevice,
    onOpenComms,
    commsUnread,
  } = props;
  const { peer, kind, dir, status, callId } = call;
  const video = kind === "video";
  const isGroup = !!call.conversationId;
  // Who can moderate THIS call (mute-everyone, per-participant mute/remove).
  // Product rule (#20): the call STARTER is the host — in both 1:1 and group
  // calls — matching meetings. `dir === "out"` means I placed/started this call;
  // `isGroupHost` additionally covers a group's owner/admin/creator who JOINED a
  // call someone else started. The backend enforces the same (call initiator for
  // 1:1, huddle starter or conv owner/admin for group), so a stray button 403s
  // rather than silently mis-acting.
  const isCallHost = isGroupHost || dir === "out";
  // Mute/unmute-everyone visibility. GROUP calls stay host-only (moderation).
  // A 1:1 call has exactly two people and no owner, so BOTH parties get it —
  // otherwise whoever ANSWERED could never settle the audio (the reported
  // "mute everyone is missing in calls"). Backend allows either party too.
  const canMuteEveryone = isCallHost || !isGroup;
  // Allow inviting people on a CONNECTED call: group calls always, and 1:1 calls
  // too (adding someone promotes the 1:1 to a group). Hidden while still ringing.
  const canAddPeople =
    !!onAddPeople &&
    (isGroup || (!!call.callId && call.status === "connected"));
  const [sec, setSec] = useState(0);
  // Calls join with mic + camera OFF by default — the user enables them after
  // joining (matches Teams/Zoom "join muted, camera off").
  const [mic, setMic] = useState(false);
  const [cam, setCam] = useState(false);
  const [screen, setScreen] = useState(false);
  // BA/CEO #3 (calls): in-flight screen-share START — drives a pending dock button.
  const [screenPending, setScreenPending] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const toggleFullscreen = () => {
    const el = stageRef.current?.closest("[data-call-view]") as HTMLElement;
    if (!fsElement()) {
      if (el) fsRequest(el);
    } else {
      fsExit();
    }
  };
  useEffect(() => {
    const sync = () => setFullscreen(!!fsElement());
    document.addEventListener("fullscreenchange", sync);
    document.addEventListener("webkitfullscreenchange", sync);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      document.removeEventListener("webkitfullscreenchange", sync);
    };
  }, []);
  const [spk, setSpk] = useState(true);
  const spkRef = useRef(true);
  const [connecting, setConnecting] = useState(true);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [mediaRetryKey, setMediaRetryKey] = useState(0);
  // WebRTC diagnostics (additive observability) + bounded auto-rejoin counter.
  const [callDiag, setCallDiag] = useState<CallDiagnostics | null>(null);
  const rejoinAttemptsRef = useRef(0);
  // Real media-connectivity phase, independent of the signalling `status`.
  // Per the call-state spec, the UI must reflect ACTUAL LiveKit connectivity,
  // never signalling acceptance:
  //   connecting_media → room.connect() in flight (also covers reconnecting)
  //   connected        → LiveKit room connected AND a remote participant present
  //   failed           → couldn't reach / lost the media server before connecting
  // "Connected", the call timer, and meeting controls are gated on `connected`.
  const [mediaPhase, setMediaPhase] = useState<
    "connecting_media" | "connected" | "failed"
  >("connecting_media");
  const [remoteJoined, setRemoteJoined] = useState(false);
  // True once a REMOTE camera track is attached; flipped off when the remote
  // turns their camera off (track unpublished → TrackUnsubscribed → detach).
  // Drives the 1:1 camera-off avatar fallback so the video stage is never empty.
  const [remoteVideoOn, setRemoteVideoOn] = useState(false);
  // # of tiles on the call stage (local + remote). The centered camera-off avatar
  // overlay only shows when this is 0 (stage completely empty / pre-join), so it
  // can never overlap ANY tile — your own self-view included.
  const [callTotalTiles, setCallTotalTiles] = useState(0);
  // Remote Control: the remote screen-sharer we can request control of (set from
  // relayoutGrid), + a rect getter for the shared <video> (coordinate mapping).
  const [rcSharer, setRcSharer] = useState<{ sid: string; name: string } | null>(
    null,
  );
  const getShareRect = useCallback((): DOMRect | null => {
    const root = stageRef.current
      ? stageRef.current.closest(".call-stage-enter")
      : null;
    const el = (root || document).querySelector(
      '[data-screen="true"][data-local="false"] video',
    ) as HTMLElement | null;
    return el ? el.getBoundingClientRect() : null;
  }, []);
  const mediaLive = mediaPhase === "connected";
  const [devices, setDevices] = useState<{
    mics: any[];
    cams: any[];
    speakers: any[];
  }>({
    mics: [],
    cams: [],
    speakers: [],
  });
  const [selMic, setSelMic] = useState("");
  const [selCam, setSelCam] = useState("");
  const [selSpk, setSelSpk] = useState("");
  // Live mirror of the chosen speaker so attach() + a mid-call change route audio
  // to the right output element without a stale-closure on `settings`.
  const sinkRef = useRef<string>("");
  const roomRef = useRef<any>(null);
  // Presenter Mode — composite the presenter's camera over the shared content
  // into one ScreenShare stream (identical impl in meetings). The selector shows
  // only while sharing; non-standard modes need the camera on.
  const presenter = usePresenterMode({
    roomRef,
    screenOn: screen,
    cameraOn: cam,
  });
  // Presentation Mode (P0-11): raise the shared "presenting" flag while screen
  // sharing or in a presenter layout — every notification surface goes quiet.
  // Cleared on unmount so ending the call always restores notifications.
  useEffect(() => {
    setPresenting(screen || presenter.mode !== "standard");
  }, [screen, presenter.mode]);
  useEffect(() => () => setPresenting(false), []);
  const pcRef = useRef<any>(null);
  const camTrackRef = useRef<any>(null);
  const secRef = useRef(0);
  const stageRef = useRef<any>(null);
  const audioRef = useRef<any>(null);
  const tilesRef = useRef<Map<string, any>>(new Map());
  const everConnectedRef = useRef(false);
  // Spatial audio: MASKED OFF (by request). The manager still handles
  // speaker-mute + output-device selection (Web Audio bypasses the <audio>
  // element that normally carries them), so the plumbing stays — but the state
  // is hard-false rather than read from storage. Reading the stored preference
  // with the toggle removed would leave anyone who had enabled it permanently
  // panned with no way to turn it off.
  const spatialRef = useRef<SpatialAudioManager | null>(null);
  const [spatialOn, setSpatialOn] = useState(false);
  // Collaborative whiteboard, synced over the LiveKit data channel.
  const [showCallWhiteboard, setShowCallWhiteboard] = useState(false);
  const [wbResyncNonce, setWbResyncNonce] = useState(0);
  const wbReceiverRef = useRef<
    ((m: WbMessage, meta?: { fromModerator?: boolean }) => void) | null
  >(null);
  // Pin — Microsoft Teams "Pin for me": LOCAL-only (never broadcast), MULTIPLE
  // pins allowed, pinned people stay prominent regardless of who's speaking. The
  // ref is read by the imperative grid layout; the state drives re-layout + the
  // pin buttons' active styling. relayoutGridRef lets the imperatively-built pin
  // buttons and this state re-run the current layout closure.
  const [callPinnedSids, setCallPinnedSids] = useState<string[]>([]);
  const callPinnedRef = useRef<string[]>([]);
  const relayoutGridRef = useRef<(() => void) | null>(null);
  // Set inside the room-join effect; lets the local mic toggle update the local
  // tile's mic-muted badge immediately (calls have no per-tile React render).
  const setCallTileMicRef = useRef<((sid: string, muted: boolean) => void) | null>(null);
  const callPinAreaRef = useRef<HTMLDivElement | null>(null);
  const callStripRef = useRef<HTMLDivElement | null>(null);
  // Shared per-participant overflow (⋮) menu (calls + group calls). The HOOKS live
  // here alongside the other call-state hooks so they run every render in a stable
  // order; the opener that reads live room + role state is assigned further down.
  const callPartMenu = useParticipantMenu();
  const openCallTileMenuRef = useRef<(b: HTMLElement, t: HTMLElement) => void>(
    () => {},
  );
  // Same cap as meetings (VIEW-08: max 4) — it was unlimited here, and pinning
  // most of a group call just rebuilt the grid it was meant to escape.
  const CALL_MAX_PINS = 4;
  const toggleCallPin = (sid: string) => {
    if (!callPinnedRef.current.includes(sid) && callPinnedRef.current.length >= CALL_MAX_PINS) {
      showToast("Up to 4 participants can be pinned.");
      return;
    }
    setCallPinnedSids((prev) =>
      prev.includes(sid) ? prev.filter((s) => s !== sid) : [...prev, sid],
    );
  };
  useEffect(() => {
    callPinnedRef.current = callPinnedSids;
    if (relayoutGridRef.current) relayoutGridRef.current();
  }, [callPinnedSids]);
  // REAL Gallery/Participant view mode for calls (P0-1 parity with meetings —
  // previously "Speaker view" was faked by opening the People panel). "speaker"
  // renders one prominent tile + an in-stage side rail; independent of the People
  // panel. The ref is read by the imperative relayoutGrid closure.
  // Remembered across calls, like the meeting's view (its own key: someone may
  // well want Gallery in big meetings and Participant view in small calls).
  // Stage LAYOUT (lib/stageView CallLayout): speaker (default) · speaker-bottom ·
  // gallery · focus. Picked from the dock's Layout menu, switchable mid-call,
  // per-viewer (never affects others), remembered for the next call.
  const [callViewMode, setCallViewMode] = useState<CallLayout>(() => loadCallLayout());
  const callViewModeRef = useRef<CallLayout>(callViewMode);
  useEffect(() => {
    callViewModeRef.current = callViewMode;
    saveCallLayout(callViewMode);
    if (relayoutGridRef.current) relayoutGridRef.current();
  }, [callViewMode]);

  // ── Gallery PAGING (parity with meetings). A big group call used to shrink
  // every tile without limit; now it pages at the same device-tier size. The
  // refs are read by the imperative relayoutGrid closure.
  const callPageSize = useGalleryPageSize();
  const callPageSizeRef = useRef(callPageSize);
  const [callPage, setCallPage] = useState(0);
  const [callPageCount, setCallPageCount] = useState(1);
  const callPageRef = useRef(0);
  useEffect(() => {
    callPageSizeRef.current = callPageSize;
    callPageRef.current = callPage;
    if (relayoutGridRef.current) relayoutGridRef.current();
  }, [callPageSize, callPage]);

  // ── ACTIVE SPEAKER (Participant view follows whoever is talking). Written by
  // the media hook's debounced ActiveSpeakersChanged handler. No tile outline —
  // that was removed from calls on request and stays removed.
  const callActiveSpeakerRef = useRef<string | null>(null);

  // ── SPOTLIGHT (host sets the view for everyone) — parity with meetings
  // (VIEW-09): up to 3 people, by BASE user id so it survives a reconnect,
  // synced over the data channel as {t:"spot", uids}. Receivers only honour it
  // from a participant whose SERVER-SIGNED role is host (see roleOf).
  const [callSpotlightUids, setCallSpotlightUids] = useState<string[]>([]);
  const [callSpotlightBy, setCallSpotlightBy] = useState("");
  const [callSpotlightEscaped, setCallSpotlightEscaped] = useState(false);
  const callSpotlightRef = useRef<string[]>([]);
  const callSpotlightEscapedRef = useRef(false);
  useEffect(() => {
    callSpotlightRef.current = callSpotlightUids;
    callSpotlightEscapedRef.current = callSpotlightEscaped;
    if (relayoutGridRef.current) relayoutGridRef.current();
  }, [callSpotlightUids, callSpotlightEscaped]);
  const publishCallSpotlight = (uids: string[]) => {
    try {
      const r: any = roomRef.current;
      if (r && r.localParticipant)
        r.localParticipant.publishData(
          new TextEncoder().encode(JSON.stringify({ t: "spot", uids })),
          { reliable: true },
        );
    } catch (_) {}
  };
  const toggleCallSpotlight = (uid: string) => {
    if (!isCallHost || !uid) return;
    const cur = callSpotlightRef.current;
    if (!cur.includes(uid) && cur.length >= 3) {
      showToast("Up to 3 participants can be spotlighted.");
      return;
    }
    const next = cur.includes(uid) ? cur.filter((u) => u !== uid) : [...cur, uid];
    setCallSpotlightUids(next);
    setCallSpotlightBy(next.length ? "you" : "");
    setCallSpotlightEscaped(false);
    publishCallSpotlight(next);
  };
  // Switch mode (WhatsApp/Meet "tap the little tile"): by default YOUR camera
  // rides the corner PiP; tapping it swaps you into the main view and drops the
  // primary remote camera to the corner. Tapping again swaps back. The ref feeds
  // the imperative relayout; a change re-runs the layout. If the layout can't
  // honour a swap (no remote camera to trade with) it silently corners you again,
  // so a stale flag never strands the wrong tile.
  const [callPipSwap, setCallPipSwap] = useState(false);
  const callPipSwapRef = useRef(false);
  useEffect(() => {
    callPipSwapRef.current = callPipSwap;
    if (relayoutGridRef.current) relayoutGridRef.current();
  }, [callPipSwap]);
  // Concurrent screen shares in a CALL — mirror of MeetingStage's "spotlight +
  // per-viewer switcher". Only affects layout with 2+ live shares; 0/1 share is
  // unchanged. Refs feed the imperative relayout; a change re-runs the layout.
  const [callScreenShares, setCallScreenShares] = useState<
    { pid: string; name: string }[]
  >([]);
  const [callFocusedScreenPid, setCallFocusedScreenPid] = useState<
    string | null
  >(null);
  const [callScreenViewMode, setCallScreenViewMode] = useState<
    "spotlight" | "sideBySide"
  >("spotlight");
  const callFocusedScreenPidRef = useRef<string | null>(null);
  const callScreenViewModeRef = useRef<"spotlight" | "sideBySide">("spotlight");
  const prevCallScreenPidsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    callFocusedScreenPidRef.current = callFocusedScreenPid;
    callScreenViewModeRef.current = callScreenViewMode;
    if (relayoutGridRef.current) relayoutGridRef.current();
  }, [callFocusedScreenPid, callScreenViewMode]);
  // Recompute the live screen-share list from the stage tiles. Among screen tiles
  // (data-screen="true") the pid is unique (one screen source per participant),
  // so pid identifies a share. Auto-focuses the newest + toasts once 2+ share.
  const refreshCallScreenSharesRef = useRef<(() => void) | null>(null);
  refreshCallScreenSharesRef.current = () => {
    const stage = stageRef.current;
    if (!stage) return;
    const els = Array.from(
      stage.querySelectorAll('[data-screen="true"]'),
    ) as HTMLElement[];
    const list = els
      .filter((t) => t.dataset.local !== "true") // sharer never sees own tile in switcher
      .map((t) => {
        const pid = t.dataset.pid || "";
        const raw = t.querySelector(".cv-tile-label")?.textContent || "";
        const name = raw.replace(/\s*\(you\)\s*$/i, "").trim() || "Someone";
        return { pid, name };
      })
      .filter((s) => s.pid);
    const ids = new Set(list.map((s) => s.pid));
    let added: { pid: string; name: string } | null = null;
    for (const s of list)
      if (!prevCallScreenPidsRef.current.has(s.pid)) {
        added = s;
        break;
      }
    prevCallScreenPidsRef.current = ids;
    setCallScreenShares(list);
    if (added) {
      setCallFocusedScreenPid(added.pid);
      setCallScreenViewMode("spotlight");
      if (list.length > 1) showToast(`${added.name} is presenting`);
    } else if (
      callFocusedScreenPidRef.current &&
      !ids.has(callFocusedScreenPidRef.current)
    ) {
      // The spotlighted share stopped → re-focus the newest remaining one so the
      // switcher pill and the stage don't disagree (no "nothing selected" state).
      setCallFocusedScreenPid(list.length ? list[list.length - 1].pid : null);
    }
  };
  // PiP awareness for the imperative grid: in the tiny floating window we show ONE
  // meaningful tile full-bleed (see relayoutGrid) instead of a cramped mini-grid.
  const pipRef = useRef(pip);

  // People panel (parity with Meetings) for 1:1 + group calls. Additive overlay —
  // does NOT touch the imperative video grid. The roster is a lightweight snapshot
  // of the LiveKit room, refreshed on participant join/leave + while the panel is
  // open, so we never duplicate the call's media pipeline.
  const [peoplePanelOpen, setPeoplePanelOpen] = useState(false);
  // In-call side panel tabs (People | Chat) — parity with the meeting panel.
  // The in-call chat rides the LiveKit DataChannel (like reactions/hands):
  // call-scoped, ephemeral, encrypted in transit — never a second copy of the
  // conversation message stack.
  const [callPanelTab, setCallPanelTab] = useState<"people" | "chat">("people");
  const [callChatMsgs, setCallChatMsgs] = useState<
    Array<{ id: string; name: string; text: string; ts: number; self?: boolean; file?: any }>
  >([]);
  const [callChatDraft, setCallChatDraft] = useState("");
  // Unread badge for the in-call chat tab. Peer messages (appended in the
  // DataChannel receive handler) carry no `self` flag; your own sends are echoed
  // locally with self:true and never round-trip, so no id check is needed — the
  // receive path already excludes you. Count only while the Chat tab is not the
  // on-screen tab, and clear when it is.
  const [callChatUnread, setCallChatUnread] = useState(0);
  const callChatVisibleRef = useRef(false);
  callChatVisibleRef.current = peoplePanelOpen && callPanelTab === "chat";
  // In-call chat notifications: a soft ding when a peer messages while you're not
  // looking at the Chat tab. Muteable (parity with the main chat's per-chat
  // "Mute notifications"), persisted so the choice survives across calls. Read
  // via a ref inside the DataChannel receive closure to avoid a stale value.
  const [callChatMuted, setCallChatMuted] = useState<boolean>(() => {
    try {
      return localStorage.getItem("clb_call_chat_muted") === "1";
    } catch {
      return false;
    }
  });
  const callChatMutedRef = useRef(callChatMuted);
  callChatMutedRef.current = callChatMuted;
  // Also honour the GLOBAL "notification sounds" setting (parity with the app's
  // out-of-call ding, which returns early when settings.notifSound === false) —
  // read via a ref so the DataChannel receive closure sees the live value.
  const callChatNotifSoundRef = useRef(true);
  callChatNotifSoundRef.current = !(settings && (settings as any).notifSound === false);
  const toggleCallChatMuted = useCallback(() => {
    setCallChatMuted((m) => {
      const next = !m;
      try {
        localStorage.setItem("clb_call_chat_muted", next ? "1" : "0");
      } catch {}
      return next;
    });
  }, []);
  // Soft "message received" ding for in-call chat. Self-contained because CallModal
  // is a separate component from CoLabV1's global notifier (playNotifSound), so it
  // can't reuse it — same brief MESSAGE_TONE, not the looping ringtone. Gated at
  // the call site by the mute toggle + whether the Chat tab is already on screen.
  const playCallChatDing = useCallback(() => {
    try {
      const Ctx =
        (window as any).AudioContext || (window as any).webkitAudioContext;
      if (!Ctx) return;
      const ac = new Ctx();
      try {
        if (ac.state === "suspended" && ac.resume) ac.resume();
      } catch (_) {}
      const total = playPattern(ac, MESSAGE_TONE, 0.1);
      setTimeout(
        () => {
          try {
            ac.close();
          } catch (_) {}
        },
        (total + 0.5) * 1000,
      );
    } catch (_) {}
  }, []);
  useEffect(() => {
    if (peoplePanelOpen && callPanelTab === "chat") setCallChatUnread(0);
  }, [peoplePanelOpen, callPanelTab]);
  // In-call chat composer extras — emoji library + file attachment (parity with
  // the meeting chat, BA/CEO feedback).
  const [callChatEmoji, setCallChatEmoji] = useState(false);
  const [callChatEmojiAnchor, setCallChatEmojiAnchor] = useState<Rect | null>(null);
  // Close the call-chat emoji picker when the panel closes or the tab leaves
  // Chat — otherwise it lingers/re-opens on its own when switching to People or
  // reopening the panel.
  useEffect(() => {
    if (!peoplePanelOpen || callPanelTab !== "chat") setCallChatEmoji(false);
  }, [peoplePanelOpen, callPanelTab]);
  const [callChatUploading, setCallChatUploading] = useState(false);
  const callChatFileRef = useRef<HTMLInputElement | null>(null);
  // BA/CEO #3: on call end, preserve the ephemeral in-call chat (never stored
  // server-side) as an auto-expiring temp group. A ref holds the latest state so
  // the unmount cleanup can send it regardless of WHICH hangup path fired.
  const callChatCaptureRef = useRef<any>({});
  callChatCaptureRef.current = {
    callChatMsgs,
    call,
    isGroup,
    token,
    meId,
    onTempGroupCreated,
  };
  // Shared per-call-session id so every participant's hangup POST dedupes into
  // ONE temp group server-side (see /temp-from-session): group calls use the
  // LiveKit room SID — unique per room INSTANCE and identical for everyone in
  // it; rooms are deleted at call end, so back-to-back calls in the same group
  // get distinct SIDs. (1:1 calls use callId instead — see the teardown below.)
  const callRoomSidRef = useRef<string | null>(null);
  // The session's temp-group conversation id once it exists, so the recording
  // can be posted DIRECTLY into it (see the recorder's onstop) instead of
  // relying on the ephemeral call-chat transcript being ported at unmount —
  // that port snapshots BEFORE the recorder stops, so a hangup-while-recording
  // dropped the recording from the group entirely.
  const sessionGroupIdRef = useRef<string | null>(null);
  useEffect(() => {
    return () => {
      const c = callChatCaptureRef.current || {};
      const msgs = (c.callChatMsgs || []).filter(
        (m: any) => (m.text && m.text.trim()) || m.file,
      );
      if (!msgs.length || !c.token || !c.meId) return;
      const peerId = c.call && c.call.peer && c.call.peer.id;
      // Membership: the 1:1 peer + any group participants still resolvable from
      // the room. Call chat carries no per-sender user id, so 1:1 attributes the
      // peer's lines to them and the server attributes anything unmapped to the
      // creator (content is preserved regardless).
      const ids = new Set<string>();
      if (peerId) ids.add(peerId);
      try {
        const r = roomRef.current as any;
        if (r && r.remoteParticipants)
          for (const p of r.remoteParticipants.values()) {
            const uid = String(p.identity || "").split("__")[0];
            if (uid) ids.add(uid);
          }
      } catch (_) {}
      const messages = msgs.map((m: any) => ({
        senderId: m.self ? c.meId : !c.isGroup ? peerId : undefined,
        text: m.text || "",
        file: m.file || null,
      }));
      // Dedup key shared by ALL participants of this call session — the server
      // collapses each participant's POST into ONE temp group (first writer
      // ports the transcript; the rest reuse it). 1:1 → callId (both parties
      // know it from ring/accept); group → LiveKit room SID.
      const roomSid = callRoomSidRef.current;
      const sessionKey = c.isGroup
        ? roomSid
          ? "g:" + roomSid
          : null
        : c.call && c.call.callId
          ? "c:" + c.call.callId
          : roomSid
            ? "g:" + roomSid
            : null;
      try {
        // Merge the created group straight from the RESPONSE, don't wait on the
        // CONVERSATION_NEW socket echo. The echo carries only an id and triggers
        // a full refetch, and it is emitted during call teardown — exactly when
        // the socket is most likely to be mid-reconnect — so the temp group (and
        // its "auto-deleted in N days" header) could arrive seconds late, or not
        // until the next reload. The POST reply already contains the whole
        // conversation, temporary + expiresAt included.
        Promise.resolve(
          api.tempGroupFromCall(c.token, {
            icon: "📞",
            memberIds: Array.from(ids),
            messages,
            sessionKey,
            // Honour the destination chosen LIVE (Continue vs Create new): if the
            // group was already opened this session, port the transcript straight
            // into IT — never re-dedup, or a "Create new" call would leak back
            // into the historical group at hangup.
            targetGroupId: sessionGroupIdRef.current || null,
          }),
        )
          .then((conv: any) => {
            if (conv && conv.id && c.onTempGroupCreated)
              c.onTempGroupCreated(conv);
          })
          .catch(() => {});
      } catch (_) {
        /* best-effort — never block teardown */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Detect the 1:1 → group promotion edge (local "Add people" or remote
  // CALL_UPGRADED both flip call.conversationId → isGroup true).
  const wasGroupRef = useRef(isGroup);
  useEffect(() => {
    if (isGroup && !wasGroupRef.current) {
      // Surface the People panel + a small info toast on group promotion.
      setPeoplePanelOpen(true);
      showToast("This is now a group call");
    }
    wasGroupRef.current = isGroup;
  }, [isGroup, showToast]);
  const [callRoster, setCallRoster] = useState<
    Array<{ sid: string; identity: string; name: string; avatarUrl?: string; userId?: string; role?: string; isLocal: boolean; micOn: boolean; camOn: boolean; speaking: boolean }>
  >([]);
  // Shared @-mention behaviour (keyboard-navigable, Esc-dismiss) for the in-call
  // chat, resolved against the live call roster — same hook the meeting chat uses.
  const callMentions = useInlineMentions({
    draft: callChatDraft,
    setDraft: setCallChatDraft,
    people: callRoster,
  });
  // Hang MYSELF up — the plain Leave, and the "End" entry in the host's split
  // menu (which ends the call for you, not for the room).
  const leaveCallNow = () =>
    onHangup(sec, {
      // Post-call feedback (#67): everConnectedRef reflects whether media ever
      // reached the room, netQuality is the live indicator, and the call prop
      // carries kind/callId. The parent's maybeShowFeedback uses these to gate
      // the dialog (connected + duration + throttle).
      connected: everConnectedRef.current,
      netQuality,
      kind: "call",
      callId: call.callId || null,
    });
  // HOST ONLY — end the call for the whole room. Removing a participant already
  // ends the call for them (see the DELETE controls routes), so this removes
  // everyone else and then hangs up last, leaving nobody behind in a room the
  // host thinks they closed. allSettled, not all: one failed removal (someone
  // already dropped, a 403 on a stale role) must not strand the host in the
  // call — the backend re-checks the host gate on every one of these anyway.
  const endCallForAll = async () => {
    const others = (callRoster || []).filter((p: any) => !p.isLocal);
    await Promise.allSettled(
      others.map((p: any) => {
        // LiveKit identities are "<userId>__<device>"; the control routes take
        // the bare user id.
        const uid = String(p.identity || "").split("__")[0];
        if (!uid) return Promise.resolve();
        return isGroup && call.conversationId
          ? api.removeGroupCallParticipant(token, call.conversationId, uid)
          : call.callId
            ? api.removeDirectCallParticipant(token, call.callId, uid)
            : Promise.resolve();
      }),
    );
    leaveCallNow();
  };
  // Ensure the call's LIVE temp group exists and return its conversation id.
  // This group is what makes in-call chat attachments downloadable by peers:
  // a file uploaded with a conversationId passes the backend membership check,
  // whereas a bare call-chat upload is owned by no conversation and 404s for
  // everyone but the uploader. Created lazily on first need (a chat send, or the
  // roster tick), memoised in sessionGroupIdRef, and concurrency-guarded so
  // simultaneous callers share ONE in-flight POST (the backend also dedups by
  // sessionKey, so a race can't create two groups).
  const ensureGroupPromiseRef = useRef<Promise<string | null> | null>(null);
  const ensureSessionGroupId = useCallback((): Promise<string | null> => {
    if (sessionGroupIdRef.current)
      return Promise.resolve(sessionGroupIdRef.current);
    if (ensureGroupPromiseRef.current) return ensureGroupPromiseRef.current;
    const cc = callChatCaptureRef.current || {};
    const r = roomRef.current;
    if (!r || !cc.token) return Promise.resolve(null);
    const others = (
      r.remoteParticipants ? Array.from(r.remoteParticipants.values()) : []
    ) as any[];
    if (!others.length) return Promise.resolve(null); // solo → no group yet
    const roomSid = callRoomSidRef.current;
    const isGrp = !!cc.isGroup;
    const sessionKey = isGrp
      ? roomSid
        ? "g:" + roomSid
        : null
      : cc.call && cc.call.callId
        ? "c:" + cc.call.callId
        : roomSid
          ? "g:" + roomSid
          : null;
    const ids = new Set<string>();
    const peerId = cc.call && cc.call.peer && cc.call.peer.id;
    if (peerId) ids.add(peerId);
    for (const p of others) {
      const uid = String(p.identity || "").split("__")[0];
      if (uid) ids.add(uid);
    }
    if (!sessionKey || !ids.size) return Promise.resolve(null);
    const memberIds = Array.from(ids);
    // Remember-my-choice key: stable per participant set (from THIS user's view),
    // so a decision made once ("always continue" / "always new" with these people)
    // skips the prompt on every later call/meeting with them (spec E).
    const rememberKey =
      "clb_tgpref:" +
      memberIds.map((x) => String(x).toLowerCase()).sort().join(",");
    const p = (async (): Promise<string | null> => {
      try {
        let mode: "auto" | "new" = "auto";
        // 1) Does a matching temp group already exist for these people? (no create)
        const check: any = await api
          .tempGroupFromCall(cc.token, { memberIds, messages: [], sessionKey, mode: "check" })
          .catch(() => null);
        const match = check && check.existingMatch;
        if (match && match.id) {
          // 2) Honour a remembered choice; otherwise PROMPT before deciding where
          //    this session's content lands (spec B — never silently continue).
          let pref: string | null = null;
          try { pref = localStorage.getItem(rememberKey); } catch (_) {}
          if (pref === "new") mode = "new";
          else if (pref === "continue") mode = "auto";
          else {
            const choice = await chooseDialog(
              `You already have a temporary conversation "${match.title || "with these people"}". Where should this ${cc.isGroup ? "call" : "call"}'s chat and files go?`,
              [
                {
                  value: "continue",
                  label: "Continue existing conversation",
                  description: "This call is appended as a new session in the same group.",
                },
                {
                  value: "new",
                  label: "Create a new conversation",
                  description: "Start a separate temporary group just for this call.",
                },
              ],
              {
                title: "A conversation already exists",
                rememberLabel: "Remember my choice for these people",
                confirmText: "Continue",
              },
            );
            // Cancelled → don't fork; fall back to continuing the existing one so
            // the content still has a home (never lost).
            mode = choice && choice.value === "new" ? "new" : "auto";
            if (choice && choice.remember) {
              try {
                localStorage.setItem(rememberKey, choice.value === "new" ? "new" : "continue");
              } catch (_) {}
            }
          }
        }
        // 3) Create/attach the LIVE group with the chosen destination. Everything
        //    else this session (recording, attachments, the hangup transcript
        //    port) targets THIS id, so the destination stays consistent.
        const conv: any = await api.tempGroupFromCall(cc.token, {
          icon: "📞",
          memberIds,
          messages: [],
          sessionKey,
          mode,
        });
        if (conv && conv.id) {
          sessionGroupIdRef.current = conv.id;
          if (cc.onTempGroupCreated) cc.onTempGroupCreated(conv);
          return conv.id as string;
        }
        return null;
      } catch (_) {
        return null;
      } finally {
        ensureGroupPromiseRef.current = null;
      }
    })();
    ensureGroupPromiseRef.current = p;
    return p;
  }, []);
  const refreshRoster = useCallback(() => {
    const r = roomRef.current;
    if (!r) { setCallRoster([]); return; }
    const out: any[] = [];
    const lp = r.localParticipant;
    if (lp)
      out.push({ sid: lp.sid, identity: lp.identity || "", name: lp.name || "You", avatarUrl: resolveMediaUrl(avatarUrlOf(lp)), userId: baseUid(lp.identity), role: roleOf(lp), isLocal: true, micOn: !!lp.isMicrophoneEnabled, camOn: !!lp.isCameraEnabled, speaking: !!lp.isSpeaking });
    const rem = r.remoteParticipants ? Array.from(r.remoteParticipants.values()) : [];
    for (const p of rem as any[])
      out.push({ sid: p.sid, identity: p.identity || "", name: p.name || "Participant", avatarUrl: resolveMediaUrl(avatarUrlOf(p)), userId: baseUid(p.identity), role: roleOf(p), isLocal: false, micOn: !!p.isMicrophoneEnabled, camOn: !!p.isCameraEnabled, speaking: !!p.isSpeaking });
    // DEDUPE by base user id ("same profile connected 3 times"): one human who
    // reloads / opens a 2nd tab / auto-rejoins mints a fresh LiveKit identity
    // (userId + "__" + uuid) each time, so they'd show as several roster rows +
    // tiles. Keep the richest session per person (local > screen? n/a here >
    // camera > speaking > first). Tile-level dedupe is in ensureCallTile below.
    const byUser = new Map<string, any>();
    const rankR = (p: any) => (p.isLocal ? 100 : 0) + (p.camOn ? 4 : 0) + (p.speaking ? 1 : 0);
    for (const p of out) {
      const key = String(p.identity || "").split("__")[0] || p.sid;
      const cur = byUser.get(key);
      if (!cur || rankR(p) > rankR(cur)) byUser.set(key, p);
    }
    setCallRoster(Array.from(byUser.values()));
    // Temp group is deliberately NOT created here. Per "create only on real
    // collaboration" (spec): the group is minted lazily on the FIRST shared
    // content — a chat attachment (sendCallChatFile), a recording (recorder
    // onstop, below), or the end-of-call transcript port (which itself no-ops
    // when there were zero messages). Simply being in a call with nothing shared
    // must never spawn a temporary group.
  }, []);
  useEffect(() => {
    if (!peoplePanelOpen) return;
    refreshRoster();
    const t = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        refreshRoster();
      }
    }, 2000);
    return () => clearInterval(t);
  }, [peoplePanelOpen, refreshRoster]);
  // P0-10: the People panel is a MANAGEMENT list — tiles are never relocated
  // into it. The stage (pin area + side rail) owns all media; the panel only
  // needs the lightweight roster above. Re-run the idempotent layout on pip
  // toggle (minimize/restore re-parents the stage container).
  useEffect(() => {
    pipRef.current = pip;
    if (relayoutGridRef.current) relayoutGridRef.current();
    const id = requestAnimationFrame(() => {
      if (relayoutGridRef.current) relayoutGridRef.current();
    });
    return () => cancelAnimationFrame(id);
  }, [pip]);

  // In-call reactions + raise-hand (parity with meetings) — sent over the LiveKit
  // DataChannel (no backend needed; the room already has all participants).
  // Reactions auto-expire; raised hands persist until lowered or the person leaves.
  const [callReactions, setCallReactions] = useState<
    { id: string; emoji: string; name: string }[]
  >([]);
  const [callHands, setCallHands] = useState<{ id: string; name: string }[]>([]);
  // Raised hands, for the imperative layout (tile badge + ordering). Hands are
  // keyed by LiveKit identity (or "__me__" for the local user).
  const callHandsRef = useRef<{ id: string; name: string }[]>([]);
  useEffect(() => {
    callHandsRef.current = callHands;
    if (relayoutGridRef.current) relayoutGridRef.current();
  }, [callHands]);
  // Per-user VIEW preferences — the SAME store as meetings (lib/stageView), so
  // "hide self view" chosen in a meeting holds in a call too.
  const [callViewPrefs, setCallViewPrefs] = useState<StageViewPrefs>(() => loadStageViewPrefs());
  const callViewPrefsRef = useRef<StageViewPrefs>(callViewPrefs);
  const setCallViewPref = (patch: Partial<StageViewPrefs>) =>
    setCallViewPrefs((prev) => {
      const next = { ...prev, ...patch };
      saveStageViewPrefs(next);
      return next;
    });
  useEffect(() => {
    callViewPrefsRef.current = callViewPrefs;
    if (relayoutGridRef.current) relayoutGridRef.current();
  }, [callViewPrefs]);
  // Re-fit the thumbnail rail when the stage box changes size (debounced).
  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let t: any = null;
    const ro = new ResizeObserver(() => {
      if (t) clearTimeout(t);
      t = setTimeout(() => relayoutGridRef.current && relayoutGridRef.current(), 120);
    });
    ro.observe(el);
    return () => {
      if (t) clearTimeout(t);
      ro.disconnect();
    };
  }, [status]);
  const [reactOpen, setReactOpen] = useState(false);
  // Skype-style "More ⋯" overflow menu for the call dock (speaker / record /
  // mute all / minimize / fullscreen).
  const [callMoreOpen, setCallMoreOpen] = useState(false);
  // Device pickers live in a popup off the More menu (so the call dock is a
  // single bar — no persistent device-selector row below it).
  const [callDevicesOpen, setCallDevicesOpen] = useState(false);
  // Each transient call surface registers on the central Esc stack WHILE OPEN, so
  // Esc closes the most-recently-opened one first (true LIFO across the whole app,
  // not a hardcoded priority) and never falls through to Back while one is open.
  useEsc(callDevicesOpen, () => setCallDevicesOpen(false));
  useEsc(callMoreOpen, () => setCallMoreOpen(false));
  useEsc(reactOpen, () => setReactOpen(false));
  useEsc(peoplePanelOpen, () => setPeoplePanelOpen(false));
  const handRaisedRef = useRef(false);
  const localStreamRef = useRef<any>(null);
  const remoteStreamRef = useRef<any>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<any>(null);
  const recChunksRef = useRef<any[]>([]);
  const recAudioCtxRef = useRef<any>(null);
  // Fallback mic capture opened only when the call mic is off (so a recording
  // still gets the local voice); released in rec.onstop.
  const recMicStreamRef = useRef<MediaStream | null>(null);
  const [recording, setRecording] = useState(false);
  // A remote participant is recording (received over the LiveKit data channel).
  // The REC badge shows when EITHER we or a peer records — a consent indicator
  // everyone sees, matching meetings (which propagate via the recordings list).
  const [peerRecording, setPeerRecording] = useState(false);
  // AUDIT #46: remember WHICH participant announced recording, so if that
  // participant drops WITHOUT a clean stop we can clear the stale REC badge the
  // moment they disconnect — instead of only when the whole room empties.
  const peerRecorderRef = useRef<string | null>(null);
  const recordingRef = useRef(false);
  // "Saving…" window between stop() and the upload finishing — parity with the
  // meeting Record button, and it blocks a double-click during the flush.
  const [recBusy, setRecBusy] = useState(false);
  const recStartedAtRef = useRef(0);
  // Set while recording so newly-subscribed audio (late joiners / someone
  // unmuting) is mixed into the SAME recording destination.
  const recAddAudioRef = useRef<((pub: any) => void) | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [netQuality, setNetQuality] = useState<
    "excellent" | "good" | "poor" | "lost" | "unknown"
  >("unknown");
  const [pttTalking, setPttTalking] = useState(false);
  const [quickReply, setQuickReply] = useState(false);
  // Reflect OS-level connectivity immediately — LiveKit on localhost rides the
  // loopback (survives Wi-Fi off), so navigator.onLine is the reliable signal
  // for a real network drop. Goes red instantly, clears when the network is back.
  useEffect(() => {
    const goOffline = () => setNetQuality("lost");
    const goOnline = () => setNetQuality("unknown");
    if (typeof navigator !== "undefined" && navigator.onLine === false)
      goOffline();
    window.addEventListener("offline", goOffline);
    window.addEventListener("online", goOnline);
    return () => {
      window.removeEventListener("offline", goOffline);
      window.removeEventListener("online", goOnline);
    };
  }, []);
  // Safari/iOS/Chrome block audio autoplay until a user gesture — track it so we
  // can show a one-tap "Enable sound" prompt instead of silently playing nothing.
  const [audioBlocked, setAudioBlocked] = useState(false);

  useEffect(
    () => () => {
      try {
        if (recorderRef.current && recorderRef.current.state !== "inactive")
          recorderRef.current.stop();
      } catch (_) {
        /* ignore */
      }
    },
    [],
  );

  // NOTE: a manual "screen-local" preview tile used to be injected here for audio
  // calls, but LiveKit's own LocalTrackPublished → attach() already renders the
  // local screen-share track as a tile. The manual one was a DUPLICATE (the
  // screen showed twice during share). Removed — attach() is the single source.

  useEffect(() => {
    // Timer runs only once media is truly connected — never on signalling.
    if (!mediaLive) return;
    const t = setInterval(
      () =>
        setSec((x) => {
          const n = x + 1;
          secRef.current = n;
          return n;
        }),
      1000,
    );
    return () => clearInterval(t);
  }, [mediaLive]);

  // Hot-plug: refresh the device list when a mic/cam/headset is plugged in or
  // removed mid-call, so the in-call pickers stay current. LiveKit owns the
  // tracks and auto-falls-back to another device when the *active* one is
  // unplugged; RoomEvent.ActiveDeviceChanged (above) keeps the picker selection
  // in sync with that fallback, so here we only re-enumerate the options.
  useEffect(() => {
    if (!mediaLive) return;
    const md: any = typeof navigator !== "undefined" && navigator.mediaDevices;
    if (!md || !md.addEventListener) return;
    const refresh = () => {
      md.enumerateDevices()
        .then((ds: MediaDeviceInfo[]) => {
          setDevices({
            mics: ds.filter((d) => d.kind === "audioinput"),
            cams: ds.filter((d) => d.kind === "videoinput"),
            speakers: ds.filter((d) => d.kind === "audiooutput"),
          });
        })
        .catch(() => {});
    };
    md.addEventListener("devicechange", refresh);
    return () => md.removeEventListener("devicechange", refresh);
  }, [mediaLive]);

  // Keep the speaker sink in sync with the saved/selected output device and
  // push it onto any already-attached remote <audio> elements. setSinkId is
  // Chromium-only and a no-op elsewhere (guarded), so this degrades cleanly.
  useEffect(() => {
    const want = selSpk || (settings && (settings as any).speakerId) || "";
    sinkRef.current = want;
    if (!want) return;
    spatialRef.current && spatialRef.current.setSinkId(want);
    const host = audioRef.current;
    if (!host) return;
    Array.from(host.children || []).forEach((a: any) => {
      if (a && a.dataset && a.dataset.spatial) return; // manager owns the sink
      if (a && typeof a.setSinkId === "function")
        a.setSinkId(want).catch(() => {});
    });
  }, [selSpk, settings && (settings as any).speakerId, mediaLive]);

  // Track prior disconnect so StrictMode remount can wait for it
  const lkDisconnectingRef = useRef<Promise<void> | null>(null);
  // Stable call key (conv:<id>/call:<id>) currently mid-connect. Claimed
  // synchronously on effect entry so a ringing->connected re-render can't open a
  // SECOND room.connect() with the same LiveKit identity (the DUPLICATE_IDENTITY
  // eviction that tore 1:1 calls down). Cleared on every connect exit.
  const lkConnectingRef = useRef<string | null>(null);

  // All call media uses the LiveKit SFU. 1:1 calls join call_<id>; group calls
  // join conv_<id>. The socket layer is only lifecycle signalling.
  return {
    addOpen, audioBlocked, audioRef, callChatCaptureRef, callChatDraft, callChatEmoji, callChatEmojiAnchor, callChatFileRef,
    callChatMsgs, callChatMuted, callChatMutedRef, callChatNotifSoundRef, callChatUnread, callChatUploading, callChatVisibleRef, callDevicesOpen,
    callFocusedScreenPid, callFocusedScreenPidRef, callHands, callId, callMentions, callMoreOpen, callPanelTab, callPartMenu,
    callPinAreaRef, callPinnedRef, callPinnedSids, callPipSwapRef, callReactions, callRoomSidRef, callRoster, callScreenShares,
    callScreenViewMode, callScreenViewModeRef, callStripRef, callTotalTiles, callViewMode, callViewModeRef, cam, canAddPeople,
    callHandsRef, callViewPrefs, callViewPrefsRef, setCallViewPref,
    callPage, callPageCount, callPageRef, callPageSizeRef, setCallPage, setCallPageCount, callActiveSpeakerRef,
    callSpotlightUids, callSpotlightBy, callSpotlightEscaped, callSpotlightRef, callSpotlightEscapedRef,
    setCallSpotlightUids, setCallSpotlightBy, setCallSpotlightEscaped, toggleCallSpotlight, publishCallSpotlight,
    canMuteEveryone, connecting, devices, dir, endCallForAll, ensureSessionGroupId, everConnectedRef, fullscreen,
    getShareRect, handRaisedRef, isCallHost, isGroup, kind, leaveCallNow, lkConnectingRef, lkDisconnectingRef,
    localStreamRef, mediaError, mediaLive, mediaPhase, mediaRetryKey, mic, netQuality, openCallTileMenuRef, peer,
    peerRecorderRef, peerRecording, peoplePanelOpen, pipRef, playCallChatDing, presenter, pttTalking, rcSharer,
    reactOpen, recAddAudioRef, recAudioCtxRef, recBusy, recChunksRef, recMicStreamRef, recStartedAtRef, recorderRef,
    recording, recordingRef, refreshCallScreenSharesRef, refreshRoster, rejoinAttemptsRef, relayoutGridRef, remoteJoined, remoteStreamRef,
    remoteVideoOn, roomRef, screen, screenPending, screenStreamRef, sec, secRef, selCam,
    selMic, selSpk, setAddOpen, setAudioBlocked, setCallChatDraft, setCallChatEmoji, setCallChatEmojiAnchor, setCallChatMsgs,
    setCallChatUnread, setCallChatUploading, setCallDevicesOpen, setCallDiag, setCallFocusedScreenPid, setCallHands, setCallMoreOpen, setCallPanelTab,
    setCallPinnedSids, setCallPipSwap, setCallReactions, setCallScreenViewMode, setCallTileMicRef, setCallTotalTiles, setCallViewMode, setCam,
    setConnecting, setDevices, setMediaError, setMediaPhase, setMediaRetryKey, setMic, setNetQuality, setPeerRecording,
    setPeoplePanelOpen, setPttTalking, setRcSharer, setReactOpen, setRecBusy, setRecording, setRemoteJoined, setRemoteVideoOn,
    setScreen, setScreenPending, setSelCam, setSelMic, setSelSpk, setShowCallWhiteboard, setSpk, setWbResyncNonce,
    showCallWhiteboard, sinkRef, spatialOn, spatialRef, spk, spkRef, stageRef, status,
    tilesRef, toggleCallChatMuted, toggleCallPin, toggleFullscreen, video, wbReceiverRef, wbResyncNonce,
  };
}
