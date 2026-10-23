import { useEffect, useRef, useState, useCallback } from "react";
import { api } from "../lib/api";
import { confirmDialog } from "../lib/dialog";
import { saveBlobAs } from "../lib/saveBlob";
import { setPresenting } from "../lib/presentation";
import { applyTileGrid } from "../lib/tileGrid";
import Whiteboard, { type WbMessage } from "./Whiteboard";
import LeaveControl from "./LeaveControl";
import { SpatialAudioManager } from "../lib/spatialAudio";
import {
  IconAlertTriangle,
  IconPencil,
  IconHand,
  IconX,
  IconChevronUp,
  IconPin,
  IconEyeLucide,
  IconInfo,
  IconLock,
  IconVolume2,
  IconChevronLeft,
  IconChevronRight,
  IconUsers,
  IconMessageSquare,
  IconSearch,
  IconMicOff,
  IconMonitor,
  IconCast,
  IconUserMinus,
  IconUserPlus,
  IconFile,
  IconSmile,
  IconPaperclip,
  IconSend,
  IconVideo,
  IconPlay,
  IconDownload,
  IconVideoOff,
  IconMic,
  IconMoreHorizontal,
  IconMoreVertical,
  IconPictureInPicture,
  IconLockOpen,
  IconSparkles,
  IconBarChart, IconInfoOutline, IconMenu, IconCheckCheck, IconCopy, IconSettings } from "../lib/icons";
import QrCode from "./QrCode";
import {
  useParticipantMenu,
  buildParticipantActions,
  PARTICIPANT_MENU_ICON,
} from "./ParticipantMenu";
import { EVENTS } from "../lib/socket";
import { mediaBlockedReason, preferSecureWsUrl, canScreenShare, preferredVideoCodec } from "../lib/mediaSupport";
import * as LK from "livekit-client";
import { usePresenterMode } from "../lib/presenter/usePresenterMode";
import { applyPresenterHidden } from "../lib/presenter/presenterTiles";
import { EmojiPicker, type Rect } from "./EmojiPicker";
import { useInlineMentions, InlineMentionPopover } from "../lib/useInlineMentions";
import RemoteControlLayer from "./RemoteControlLayer";
import {
  createCallDiagnostics,
  turnAdvertisedIn,
  type CallDiagnostics,
} from "../lib/callDiagnostics";
import { isE2EEEnabled, getCallMediaKey } from "../lib/e2ee/manager";
import { e2eeRoomOptions, enableRoomE2EE, isCallMediaE2EEOn } from "../lib/e2ee/callMedia";
import { classifyMediaError, type MediaGuidance } from "../lib/mediaErrors";
import { startMicWatchdog } from "../lib/micWatchdog";
import { trackEvent, captureIssue } from "../lib/telemetry";
import { openScreenPopout, closePopout, closeAllPopouts, popoutCapability } from "../lib/screenPopout";
import { hiddenReasons } from "../lib/stageVisibility";
import MediaHelpBanner from "./MediaHelpBanner";
import { isDesktopApp } from "../lib/platform";


// A chat attachment that PLAYS in place when it's a video (e.g. a meeting
// recording, BA/CEO), and otherwise renders a download button. The auth'd bytes
// are fetched to an object URL on demand (a <video> can't send a Bearer header),
// so nothing downloads until the user hits Play.
import ChatAttachment from "./meeting/ChatAttachment";
import HandsTray from "./meeting/HandsTray";
import Avatar from "./Avatar";
import { groupChatMessages } from "./meeting/chatGroups";
import ReactionsOverlay from "./meeting/ReactionsOverlay";
import ReactionPicker from "./meeting/ReactionPicker";
import DeviceSettings from "./meeting/DeviceSettings";
import HostControlsModal from "./meeting/HostControlsModal";
import PollsPanel from "./meeting/PollsPanel";
// Decomposition (Phase 0): pure helpers now live outside this component so the
// file shrinks toward something reviewable and they can be shared/unit-tested.
import { fsRequest, fsExit, fsElement } from "../lib/meeting/fullscreen";
import { mergedAvatarOf, initialsOf, colorOf, baseUid, avatarUrlOf, paintAvatar, gradientAngleOf, applyTilePalette } from "../lib/meeting/identity";
import { resolveMediaUrl } from "../lib/image";
import WeakNetworkBanner from "./WeakNetworkBanner";
import { useGalleryPageSize } from "../lib/galleryPaging";
import ViewMenuSection from "./ViewMenuSection";
import LayoutPicker from "./LayoutPicker";
import {
  loadStageViewPrefs, saveStageViewPrefs, type StageViewPrefs, galleryRank, railRank, sortByRank,
  tileHasVideo, layoutRail, clearRailTile, enablePipDrag, setTileHand, flashTileReaction,
  loadCallLayout, saveCallLayout, railSideFor, MEETING_LAYOUT_KEY, type CallLayout, setTileSpeaking,
  attachAdaptiveVideoFit,
} from "../lib/stageView";
import { CAMERA_CAPTURE, MEETING_VIDEO_MAX_BITRATE, prioritizeAudioSender } from "../lib/mediaQuality";
import { useMeetingPolicy } from "../hooks/useMeetingPolicy";
import { useBackgroundEffect } from "../hooks/useBackgroundEffect";

export default function MeetingStage({
  meetingId,
  token,
  offline,
  video = false,
  onToast,
  isHost = false,
  isCoHost = false,
  meetingLocked = false,
  socket,
  onLeave,
  onToggleRecord,
  recording = false,
  onPromoteCoHost,
  onDemoteCoHost,
  coHostIds,
  hostId,
  settings,
  onChangeSetting,
  initialMic = true,
  initialCam = false,
  meetingTitle = "Meeting",
  onMinimize,
  onMoveDevice,
  onOpenComms,
  commsUnread,
  onMoreOptions,
  onInvite,
  onRecordings,
  inviteActive = false,
  recsActive = false,
  recCount = 0,
  meetingConversationId,
  meetingAttendeeIds,
  meId,
  pip = false,
  // Public-link guest: no account, so no file uploads (chat attachments need one).
  isGuest = false,
}: any) {
  const [phase, setPhase] = useState<
    "joining" | "connected" | "disconnected" | "ended"
  >("joining");
  const [err, setErr] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  // WebRTC diagnostics (additive observability) + bounded auto-rejoin counter.
  const [mtgDiag, setMtgDiag] = useState<CallDiagnostics | null>(null);
  const rejoinAttemptsRef = useRef(0);
  const [mic, setMic] = useState(initialMic !== false);
  const [cam, setCam] = useState(!!initialCam || !!video);
  const [screen, setScreen] = useState(false);
  // BA/CEO #3: true while a screen-share START request is in flight (picker open /
  // publishing). Drives a spinner + disabled dock button so it never looks infinite.
  const [screenPending, setScreenPending] = useState(false);
  // Screen share needs getDisplayMedia (absent on iOS/iPadOS Safari) — gate the
  // control so it's honestly disabled there rather than throwing on tap.
  const screenShareSupported = canScreenShare();
  const [devices, setDevices] = useState<{
    mics: MediaDeviceInfo[];
    cams: MediaDeviceInfo[];
    speakers: MediaDeviceInfo[];
  }>({ mics: [], cams: [], speakers: [] });
  const [selMic, setSelMic] = useState("");
  const [selCam, setSelCam] = useState("");
  const [selSpk, setSelSpk] = useState("");
  // The output device to actually APPLY via setSinkId on each remote <audio>.
  // CRITICAL: this is NOT selSpk. selSpk is the *picker* value and defaults to the
  // first enumerated device (speakers[0]); applying that would route audio to a
  // device the user never chose — the enumeration's first entry is frequently not
  // where they're listening — so meetings went silent (tiles blink, no sound)
  // while calls, which apply only a saved/explicit choice, stayed audible. Mirror
  // the call's sinkRef: "" here means "leave it on the system default", and we set
  // it only from a saved speakerId or an explicit in-meeting switch.
  const spkSinkRef = useRef("");
  // Speaker routing (setSinkId) is Chromium-only — Firefox/Safari ignore it. Gate
  // the Speaker picker on real support so the meeting and call paths behave
  // identically across browsers (no dead picker that silently does nothing).
  const sinkSupported =
    typeof HTMLMediaElement !== "undefined" &&
    typeof (HTMLMediaElement.prototype as any).setSinkId === "function";
  const [participants, setParticipants] = useState<any[]>([]);
  const [presenterId, setPresenterId] = useState<string | null>(null);
  // Concurrent screen shares (BA/CEO "spotlight + per-viewer switcher"): the live
  // set of screen-share tiles {pid,name}, the local viewer's chosen focal share,
  // and whether to spotlight one or lay ALL of them out side-by-side. These ONLY
  // affect layout when 2+ shares are live; with 0 or 1 share the layout is
  // unchanged (the common case can't regress).
  const [screenShares, setScreenShares] = useState<
    { pid: string; name: string }[]
  >([]);
  const [focusedScreenPid, setFocusedScreenPid] = useState<string | null>(null);
  const [screenViewMode, setScreenViewMode] = useState<
    "spotlight" | "sideBySide"
  >("spotlight");
  const prevScreenPidsRef = useRef<Set<string>>(new Set());
  // Latest focal pid for the (captured-once) refreshScreenShares to read.
  const focusedScreenPidRef = useRef<string | null>(null);
  focusedScreenPidRef.current = focusedScreenPid;
  // Recompute the screen-share list from the live tiles (each screen tile carries
  // data-screen="true" + a "<name> — screen" label). Called after a share
  // attaches/detaches. Auto-focuses the NEWEST share and toasts "X is presenting"
  // (only once 2+ shares are live — no toast for a lone presenter).
  const refreshScreenShares = () => {
    const root =
      (stageRef.current &&
        (stageRef.current.closest(".ms-wrap") as HTMLElement)) ||
      stageRef.current;
    if (!root) return;
    const els = Array.from(
      root.querySelectorAll('[data-pid][data-screen="true"]'),
    ) as HTMLElement[];
    const list = els
      .filter((t) => t.dataset.local !== "true") // sharer never sees own tile in switcher
      .map((t) => {
        const pid = t.dataset.pid || "";
        const raw = t.querySelector(".ms-label")?.textContent || "";
        const name =
          raw
            .replace(/\s*—\s*screen\s*$/i, "")
            .replace(/\s*\(you\)\s*$/i, "")
            .trim() || "Someone";
        return { pid, name };
      })
      .filter((s) => s.pid);
    const ids = new Set(list.map((s) => s.pid));
    let added: { pid: string; name: string } | null = null;
    for (const s of list)
      if (!prevScreenPidsRef.current.has(s.pid)) {
        added = s;
        break;
      }
    prevScreenPidsRef.current = ids;
    setScreenShares(list);
    if (added) {
      setFocusedScreenPid(added.pid);
      setScreenViewMode("spotlight");
      if (list.length > 1 && onToast) onToast(`${added.name} is presenting`);
    } else if (
      focusedScreenPidRef.current &&
      !ids.has(focusedScreenPidRef.current)
    ) {
      // The spotlighted share stopped → re-focus the newest remaining one so the
      // switcher pill and the stage stay in sync.
      setFocusedScreenPid(list.length ? list[list.length - 1].pid : null);
    }
  };
  const [activeSpeakerSid, setActiveSpeakerSid] = useState<string | null>(null);
  // Stage LAYOUT (lib/stageView CallLayout, shared with calls): speaker
  // (default) · speaker-bottom · gallery · focus. Picked from the dock's Layout
  // menu, switchable mid-meeting, per-viewer (VIEW-06). VIEW-07: remembered
  // across meetings under the meeting's own key.
  const [viewMode, setViewMode] = useState<CallLayout>(() => loadCallLayout(MEETING_LAYOUT_KEY));
  useEffect(() => {
    saveCallLayout(viewMode, MEETING_LAYOUT_KEY);
  }, [viewMode]);
  // Any non-gallery layout is "speaker-style": one focal tile + a strip.
  const speakerStyle = viewMode !== "gallery";
  // Switch mode (WhatsApp/Meet "tap the little tile"): by default YOUR camera
  // rides the corner PiP; tapping it swaps you into the main stage and drops the
  // primary remote camera to the corner. Tapping again swaps back. With no remote
  // camera to trade with, the layout silently corners you again so a stale flag
  // never strands the wrong tile. A change re-runs the layout effect below.
  const [pipSwap, setPipSwap] = useState(false);
  const onPipTileClick = useCallback(() => setPipSwap((v) => !v), []);
  // VIEW-09 Spotlight — an organizer/co-organizer forces up to 3 tiles large
  // for EVERYONE (unlike pin, which is local-only). Spotlights are stored as
  // base USER ids — stable across reconnects, unlike LiveKit sids — and are
  // resolved to live tile sids at layout time. They ride the same LiveKit data
  // channel as the whiteboard/presenter/REC messages ({t:"spot"}), receivers
  // trust them only from the host/co-hosts (same fromModerator rule as wb),
  // and any moderator re-announces the active set to late joiners.
  // `spotlightEscaped` is the local "Return to my view" escape: it suppresses
  // the forced layout for THIS viewer only and re-arms when the set changes.
  const [spotlightUids, setSpotlightUids] = useState<string[]>([]);
  const [spotlightBy, setSpotlightBy] = useState<string>("");
  const [spotlightEscaped, setSpotlightEscaped] = useState(false);
  const spotlightUidsRef = useRef<string[]>([]);
  spotlightUidsRef.current = spotlightUids;
  const spotlightBroadcast = (uids: string[]) => {
    const room = roomRef.current;
    if (!room || !room.localParticipant) return;
    try {
      room.localParticipant.publishData(
        new TextEncoder().encode(JSON.stringify({ t: "spot", uids })),
        { reliable: true },
      );
    } catch (_) {}
  };
  const toggleSpotlight = (uid: string, name?: string) => {
    const has = spotlightUids.includes(uid);
    if (!has && spotlightUids.length >= 3) {
      onToast && onToast("Up to 3 participants can be spotlighted.");
      return;
    }
    const next = has ? spotlightUids.filter((u) => u !== uid) : [...spotlightUids, uid];
    trackEvent(has ? "view.spotlight.off" : "view.spotlight.on"); // §9.2
    setSpotlightUids(next);
    spotlightUidsRef.current = next;
    setSpotlightBy(""); // local actor → banner reads "Spotlighted by you"
    setSpotlightEscaped(false);
    spotlightBroadcast(next);
    setSrAnnouncement(
      next.length
        ? has
          ? "Spotlight removed."
          : `Spotlight applied.${name ? ` ${name} is now the main view.` : ""}`
        : "Spotlight removed.",
    );
  };

  // Teams "Pin for me" — LOCAL-only, MULTI-pin (VIEW-08: max 4).
  const [pinnedSids, setPinnedSids] = useState<string[]>([]);
  const [srAnnouncement, setSrAnnouncement] = useState("");
  const togglePin = (sid: string) => {
    trackEvent(pinnedSids.includes(sid) ? "view.pin.off" : "view.pin.on"); // §9.2
    // Say so visibly — the limit used to be announced to screen readers only, so
    // for everyone else a 5th pin just did nothing (spotlight already toasts).
    if (!pinnedSids.includes(sid) && pinnedSids.length >= 4)
      onToast && onToast("Up to 4 participants can be pinned.");
    return setPinnedSids((prev) => {
      const next = prev.includes(sid)
        ? prev.filter((s) => s !== sid)
        : prev.length >= 4
          ? prev
          : [...prev, sid];
      setSrAnnouncement(
        prev.includes(sid)
          ? "Unpinned participant"
          : prev.length >= 4
            ? "Maximum 4 participants can be pinned"
            : "Pinned participant",
      );
      return next;
    });
  };
  // Shared per-participant overflow (⋮) menu. The HOOKS live here (top of the
  // component, before any early return) so they run in a stable order every
  // render; the action-builder + opener are assigned further down, once the
  // mute / remove / co-host handlers exist (see below `canControl`).
  const meetPartMenu = useParticipantMenu();
  const openMeetTileMenuRef = useRef<(btn: HTMLElement, sid: string) => void>(
    () => {},
  );
  const msPinAreaRef = useRef<HTMLDivElement | null>(null);
  // Participant view side rail (P0-2): non-prominent tiles ride a vertical rail
  // INSIDE the stage — never a bottom row, never the People panel (P0-10: the
  // panel is a compact management list, not a second meeting canvas).
  const msStripRef = useRef<HTMLDivElement | null>(null);
  // People panel roster filter (search by name).
  const [panelQuery, setPanelQuery] = useState("");
  // VIEW-20: device-tier dynamic page size (mobile=4, tablet=9, laptop=16, desktop=25)
  // Live: follows window resize / rotation (lib/galleryPaging).
  const galleryPageSize = useGalleryPageSize();
  const GALLERY_PAGE_SIZE = galleryPageSize;
  const speakerDebounceRef = useRef<any>(null);
  const [page, setPage] = useState(0);
  const [pageCount, setPageCount] = useState(1);
  // Per-user view preferences (rail vs focus-on-content, hide camera-off people,
  // hide / move the self view) — shared with calls, remembered across sessions.
  const [viewPrefs, setViewPrefs] = useState<StageViewPrefs>(() => loadStageViewPrefs());
  const setViewPref = (patch: Partial<StageViewPrefs>) =>
    setViewPrefs((prev) => {
      const next = { ...prev, ...patch };
      saveStageViewPrefs(next);
      return next;
    });
  // Bumped (debounced) when the stage box changes size, so the rail re-fits.
  const [stageSizeNonce, setStageSizeNonce] = useState(0);
  // PER-MEETING OPTIONS (0116) — fetch, follow and derive live in one hook
  // (hooks/useMeetingPolicy). The server enforces all of it; these booleans
  // only stop the UI offering a control that would be refused.
  const isPrivileged = isHost || isCoHost;
  const {
    options: meetingOptions,
    allowMic,
    allowCam,
    allowScreen,
    allowChat,
    allowReact,
    allowWhiteboard,
    whiteboardOffBy,
  } = useMeetingPolicy({ token, meetingId, socket, isPrivileged });
  const [handRaised, setHandRaised] = useState(false);
  const [raisedHands, setRaisedHands] = useState<string[]>([]);
  const [reactions, setReactions] = useState<any[]>([]);
  const [showReactions, setShowReactions] = useState(false);
  // Anchors the reaction popover to the React button itself (its right edge
  // aligned with the button's, opening upward) instead of floating centred
  // on the stage, disconnected from what opened it.
  const [reactAnchor, setReactAnchor] = useState<{ left: number; bottom: number } | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  // Polls (0121) is a THIRD side-panel tab. Tracked separately so the existing
  // chat/people boolean and everything keyed off it stays exactly as it was.
  const [pollsOpen, setPollsOpen] = useState(false);
  const [showSidePanel, setShowSidePanel] = useState(false);
  const [chatMessages, setChatMessages] = useState<any[]>([]);
  const [chatDraft, setChatDraft] = useState("");
  const [chatEmoji, setChatEmoji] = useState(false);
  // BA/CEO #6: anchor for the full shared emoji picker in the meeting chat.
  const [chatEmojiAnchor, setChatEmojiAnchor] = useState<Rect | null>(null);
  // Close the chat emoji picker whenever the Chat tab or the whole side panel
  // closes — otherwise it lingers and re-opens on its own when you switch to
  // People or reopen the panel (the picker's render guard was left stale).
  useEffect(() => {
    if (!chatOpen || !showSidePanel) setChatEmoji(false);
  }, [chatOpen, showSidePanel]);
  const [chatUploading, setChatUploading] = useState(false);
  // Staged attachment awaiting a caption + Send (WhatsApp-style preview).
  const [chatStaged, setChatStaged] = useState<{
    file: File;
    url: string;
    isImage: boolean;
  } | null>(null);
  const chatFileRef = useRef<any>(null);
  const chatInputRef = useRef<any>(null);
  // Unread badge for the in-meeting chat. Counts ONLY messages from OTHER people
  // that arrive while the chat panel is not on screen; your own sends (the server
  // echoes them back to you) and anything read live never count.
  const [chatUnread, setChatUnread] = useState(0);
  // Refs so the socket handler (registered once per socket/meeting) always reads
  // the CURRENT panel visibility and local user id, not a stale closure.
  const chatVisibleRef = useRef(false);
  chatVisibleRef.current = showSidePanel && chatOpen;
  const meIdRef = useRef(meId);
  meIdRef.current = meId;
  // Messages already counted (a socket reconnect can re-replay the same ids).
  const chatCountedRef = useRef<Set<string>>(new Set());
  // The server replays the last ~100 messages through MEETING_CHAT_NEW right
  // after we join (backend socket.ts:1148). Those are history, not unread — and
  // they arrive as a burst on a CLIENT clock we can trust, so we gate on a short
  // readiness window rather than comparing a server timestamp to a client one
  // (that comparison drops genuinely-new messages under clock skew). The window
  // is (re)started from joinMeetingRoom() when we actually join and the replay
  // begins — NOT on component mount. Anchoring it to the join fixes cold-start /
  // deep-link, where the socket connects AFTER mount so a mount-anchored timer
  // would expire before the replay arrives and count old history as unread.
  const chatReadyRef = useRef(false);
  const chatReadyTimerRef = useRef<any>(null);
  // Opening the Chat panel (dock button or tab) marks it read.
  useEffect(() => {
    if (showSidePanel && chatOpen) setChatUnread(0);
  }, [showSidePanel, chatOpen]);
  const [handNames, setHandNames] = useState<Record<string, string>>({});
  const [showDevices, setShowDevices] = useState(false);
  // Host Settings modal (creator only).
  const [showHostControls, setShowHostControls] = useState(false);
  // Which section the device popup opens to. The mic chevron shows audio devices
  // (Microphone + Speaker), the camera chevron shows the Camera — so the two
  // controls no longer open an identical combined popup. null = show everything.
  const [devicesTab, setDevicesTab] = useState<"audio" | "video" | null>(null);
  const openDevices = (t: "audio" | "video") => {
    const already = showDevices && devicesTab === t;
    setDevicesTab(t);
    setShowDevices(!already);
  };
  const [netQuality, setNetQuality] = useState<
    "excellent" | "good" | "poor" | "lost" | "unknown"
  >("unknown");
  const [locked, setLocked] = useState(!!meetingLocked);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const roomRef = useRef<any>(null);
  // BACKGROUND BLUR (Phase 1C). Built on the segmentation stack already vendored
  // for presenter mode — same local /public/mediapipe assets, so it works
  // offline, in Electron and air-gapped. The choice persists per device.
  const {
    mode: bgMode,
    setMode: setBgMode,
    degradeLevel: bgDegrade,
  } = useBackgroundEffect({ roomRef, cameraOn: cam });

  // Set by the room effect (see updateParticipantsRef.current = …) so the LOCAL
  // mic/cam toggles can re-run tile reconciliation. Declared here, above the
  // effect that assigns it, so there is no initialization-order question.
  const updateParticipantsRef = useRef<(() => void) | null>(null);
  // Presenter Mode — shared with calls (CoLabV1). Selector shows while sharing.
  const presenter = usePresenterMode({
    roomRef,
    screenOn: screen,
    cameraOn: cam,
  });
  // Presentation Mode (P0-11): raise the shared "presenting" flag while screen
  // sharing or in a presenter layout (same signal as calls — CoLabV1 hosts the
  // suppression + the enable/disable toasts). Cleared on unmount.
  useEffect(() => {
    setPresenting(screen || presenter.mode !== "standard");
  }, [screen, presenter.mode]);
  useEffect(() => () => setPresenting(false), []);
  const lkDisconnectingRef = useRef<Promise<void> | null>(null);
  const stageRef = useRef<any>(null);
  const audioRef = useRef<any>(null);
  // Spatial audio: one manager per meeting, lazily created on first remote audio
  // track and torn down on unmount. On by default (fan participant voices across
  // the stereo field to cut meeting fatigue); toggle in the "More" menu.
  const spatialRef = useRef<SpatialAudioManager | null>(null);
  // SPATIAL AUDIO IS MASKED OFF (by request) — hard false, NOT read from
  // storage. Reading the stored preference here would strand every user who had
  // already switched it on: the menu item that turned it off is gone, so their
  // audio would stay panned with no way back. The manager and all attach/detach
  // plumbing stay in place and simply run in their disabled path.
  const [spatialOn, setSpatialOn] = useState(false);
  // Collaborative whiteboard, synced over the LiveKit data channel.
  const [showWhiteboard, setShowWhiteboard] = useState(false);
  // An administrator (portal) or the host (Settings modal) can switch the
  // whiteboard off for the meeting, or block it for one person.
  // The ref lets the room's data-channel handler (created once, at connect)
  // read the LIVE value instead of the one it closed over.
  const allowWhiteboardRef = useRef(true);
  allowWhiteboardRef.current = allowWhiteboard;
  const wbWasAllowedRef = useRef(true);
  useEffect(() => {
    if (allowWhiteboard) {
      wbWasAllowedRef.current = true;
      return;
    }
    // Close an open board at once; say why only on the on→off transition.
    setShowWhiteboard(false);
    if (wbWasAllowedRef.current) {
      wbWasAllowedRef.current = false;
      onToast &&
        onToast(
          whiteboardOffBy === "admin"
            ? "The whiteboard was turned off by an administrator."
            : whiteboardOffBy === "you"
              ? "The host turned off the whiteboard for you."
              : "The host turned off the whiteboard.",
        );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowWhiteboard]);
  const [wbResyncNonce, setWbResyncNonce] = useState(0);
  const wbReceiverRef = useRef<
    ((m: WbMessage, meta?: { fromModerator?: boolean }) => void) | null
  >(null);
  const tilesRef = useRef<Map<string, any>>(new Map());
  const participantNames = useRef<Map<string, string>>(new Map());
  const everConnectedRef = useRef(false);
  // Holds the teardown for the pagehide/beforeunload listeners installed after
  // a successful room.connect(); called from the effect's cleanup and from the
  // Disconnected handler so we never leak a listener across re-mounts/retries.
  const connectCleanupRef = useRef<null | (() => void)>(null);
  const chatEndRef = useRef<any>(null);
  // Client-side recording (browser composites + records the meeting, uploads the
  // blob — no egress worker needed, works in any environment).
  const recorderRef = useRef<any>(null);
  const recChunksRef = useRef<any[]>([]);
  const recAudioCtxRef = useRef<any>(null);
  // Fallback mic opened when nobody is publishing audio at record time, so a
  // recording is never pure silence. Released in onstop.
  const recMicStreamRef = useRef<MediaStream | null>(null);
  // Set while recording: lets newly-subscribed audio tracks (people who join or
  // unmute AFTER Record was pressed) be mixed into the SAME destination, instead
  // of being silently absent from the whole recording.
  const recAddAudioRef = useRef<((pub: any) => void) | null>(null);
  const recRafRef = useRef<number>(0);
  const recIntervalRef = useRef<any>(null);
  const recCanvasStreamRef = useRef<any>(null);
  const recStartRef = useRef(0);
  const [clientRecording, setClientRecording] = useState(false);
  // Peers see a REC indicator too — meetings, like calls, broadcast recording
  // state over the data channel (the record-consent dialog promises this).
  const [peerRecording, setPeerRecording] = useState(false);
  // Recording elapsed time for the header pill. Counts from the moment ANY
  // recording (yours, the server's, or a peer's) starts; hidden when none is on.
  const isRec = !!(clientRecording || recording || peerRecording);
  const [recSince, setRecSince] = useState<number | null>(null);
  useEffect(() => {
    setRecSince(isRec ? (t) => t || Date.now() : null);
  }, [isRec]);
  const recElapsed = recSince ? Math.max(0, Math.floor((Date.now() - recSince) / 1000)) : 0;
  const fmtRec = (s: number) => {
    const p = (n: number) => String(n).padStart(2, "0");
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h > 0 ? `${h}:${p(m)}:${p(sec)}` : `${p(m)}:${p(sec)}`;
  };
  // Bumped on tab visibility-regain to re-run the layout's video subscription
  // (see the visibilitychange effect below) — cures the all-blank stage after a
  // pop-out on a second monitor backgrounded the tab and adaptiveStream dropped
  // every remote camera.
  const [visRegainNonce, setVisRegainNonce] = useState(0);
  // When the whiteboard closes — by the user, or force-closed by an administrator
  // mid-draw — re-run the stage layout / video subscriptions exactly as a
  // tab-visibility regain does. The board covers the grid, and without this a
  // tile that was underneath it could come back blank instead of live.
  const wbWasOpenRef = useRef(false);
  useEffect(() => {
    const wasOpen = wbWasOpenRef.current;
    wbWasOpenRef.current = showWhiteboard;
    if (!wasOpen || showWhiteboard) return;
    setVisRegainNonce((n) => n + 1);
    const t = setTimeout(() => setVisRegainNonce((n) => n + 1), 400);
    return () => clearTimeout(t);
  }, [showWhiteboard]);
  // REC-03/04: one consent notice per meeting session when SOMEONE ELSE's
  // recording is (or becomes) active — covers both "recording starts while I'm
  // here" and "I join a meeting already being recorded" (the recorder
  // re-broadcasts its REC state to late joiners on ParticipantConnected, which
  // flips peerRecording right after join). The persistent REC indicator stays
  // on the stage; this is the explicit one-time notice + SR announcement.
  const recNoticeShownRef = useRef(false);
  useEffect(() => {
    if (!peerRecording || recNoticeShownRef.current) return;
    recNoticeShownRef.current = true;
    onToast &&
      onToast(
        "This meeting is being recorded. By staying, you consent to being recorded." +
          (process.env.NEXT_PUBLIC_RECORDING_POLICY_URL
            ? ` Policy: ${process.env.NEXT_PUBLIC_RECORDING_POLICY_URL}`
            : ""),
      );
    setSrAnnouncement("This meeting is being recorded.");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peerRecording]);
  // AUDIT #46: track WHO announced recording so an unclean drop of that specific
  // participant clears the stale REC badge immediately (not only when the room empties).
  const peerRecorderRef = useRef<string | null>(null);
  const clientRecordingRef = useRef(false);
  // MIC-04: ref mirrors of mic/cam intent so event-handler closures (Reconnected,
  // onForceMute) always read the CURRENT intent — not the stale initial capture.
  const micIntentRef = useRef(initialMic !== false);
  const camIntentRef = useRef(!!initialCam || !!video);
  const [recBusy, setRecBusy] = useState(false);
  const [duration, setDuration] = useState(0);
  // Skype-style "More ⋯" overflow menu (View / Lock / Meeting Options).
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  // Meeting-details popover (eye icon by the title): ID + join link + copy.
  const [showInfo, setShowInfo] = useState(false);
  const [immersive, setImmersive] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // VIEW-05: in fullscreen, chrome auto-hides after 3s of inactivity and returns on mousemove/keypress.
  const [chromeVisible, setChromeVisible] = useState(true);
  useEffect(() => {
    if (!isFullscreen) {
      setChromeVisible(true);
      return;
    }
    setSrAnnouncement("Fullscreen mode enabled");
    let timer: any = null;
    const onActivity = () => {
      setChromeVisible(true);
      clearTimeout(timer);
      timer = setTimeout(() => {
        setChromeVisible(false);
      }, 3000);
    };
    onActivity();
    window.addEventListener("mousemove", onActivity, { passive: true });
    window.addEventListener("keydown", onActivity, { passive: true });
    window.addEventListener("pointerdown", onActivity, { passive: true });
    return () => {
      clearTimeout(timer);
      window.removeEventListener("mousemove", onActivity);
      window.removeEventListener("keydown", onActivity);
      window.removeEventListener("pointerdown", onActivity);
    };
  }, [isFullscreen]);
  // Apply spatial-audio on/off to the live graph without dropping audio,
  // and remember the choice across meetings.
  useEffect(() => {
    spatialRef.current && spatialRef.current.setEnabled(spatialOn);
    try {
      localStorage.setItem("clb_spatial_audio", spatialOn ? "1" : "0");
    } catch (_) {}
  }, [spatialOn]);
  // POP-10: active popped-out windows, keyed by TILE pid (`<sid>:screen`) so
  // that (a) one share ending closes only ITS pop-out — with concurrent shares,
  // stopping one presenter must not tear down pop-outs of the others — and
  // (b) re-clicking Pop out on an already-popped tile focuses the existing
  // window instead of stacking a duplicate. All of them close on exit/unmount.
  const activePipWindowsRef = useRef<Map<string, Window>>(new Map());
  // POP-04: tiles that are currently living in a pop-out window. A popped-out
  // share is NOT on the stage any more, so the stage must fall back to its
  // normal view (gallery / speaker / whatever the viewer chose) instead of
  // holding the main slot with a dead "Popped out" card — see the layout effect,
  // which filters these pids out of the promoted-screen set.
  const [poppedOutPids, setPoppedOutPids] = useState<string[]>([]);
  // How many remote screen shares the anti-mirror guard is holding back right
  // now (see the layout effect). Drives the explanatory strip — a share simply
  // vanishing with no reason given would read as a bug.
  const [mirrorGuardedCount, setMirrorGuardedCount] = useState(0);
  const markPoppedOut = (pid: string, on: boolean) =>
    setPoppedOutPids((prev) =>
      on
        ? prev.includes(pid)
          ? prev
          : [...prev, pid]
        : prev.includes(pid)
          ? prev.filter((x) => x !== pid)
          : prev,
    );
  const closePipWindow = (pid: string) => closePopout(activePipWindowsRef.current, pid);
  const closeAllPipWindows = () => closeAllPopouts(activePipWindowsRef.current);
  useEffect(
    () => () => {
      spatialRef.current && spatialRef.current.close();
      spatialRef.current = null;
      closeAllPipWindows();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  // Whiteboard sync over the LiveKit data channel (peer-to-peer via the SFU).
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
  // Broadcast our recording state to peers (t:"rec") so everyone sees the shared
  // REC indicator — mirrors calls (CoLabV1) and honors the consent dialog.
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
  // Durable whiteboard snapshot (server-persisted per meeting).
  const wbBoardKey = meetingId ? `meeting:${meetingId}` : "";
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
  useEffect(() => {
    const sync = () => setIsFullscreen(!!fsElement());
    document.addEventListener("fullscreenchange", sync);
    document.addEventListener("webkitfullscreenchange", sync);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      document.removeEventListener("webkitfullscreenchange", sync);
    };
  }, []);

  // Browser-level connectivity. LiveKit on localhost rides the loopback, which
  // survives Wi-Fi off, so LiveKit may never report a drop — but the OS network
  // does. Reflect navigator.onLine immediately so the indicator goes red the
  // moment the network drops, and clears when it returns.
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

  // Leaving while recording: stop the recorder so its onstop finalizes + uploads
  // the blob (don't silently drop the capture).
  useEffect(() => {
    return () => {
      try {
        if (recorderRef.current && recorderRef.current.state !== "inactive")
          recorderRef.current.stop();
        cancelAnimationFrame(recRafRef.current);
        if (recIntervalRef.current) clearInterval(recIntervalRef.current);
      } catch (_) {
        /* ignore */
      }
    };
  }, []);

  // Call duration timer: starts when connected, resets on retry/disconnect.
  useEffect(() => {
    if (phase !== "connected") {
      setDuration(0);
      return;
    }
    const start = Date.now();
    const id = setInterval(
      () => setDuration(Math.floor((Date.now() - start) / 1000)),
      1000,
    );
    return () => clearInterval(id);
  }, [phase]);

  // Close the device / reaction / chat-emoji popups on outside-click AND Escape
  // (R9 + esc-action-based). Escape is captured so it claims the key before the
  // global handler — it closes the open popup, not leave/Back the meeting.
  useEffect(() => {
    if (
      !showDevices &&
      !showReactions &&
      !showMoreMenu &&
      !showInfo
    )
      return;
    // Note: the chat emoji picker (BA/CEO #6) manages its own outside-click and
    // Escape handling, so it is deliberately NOT closed here.
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (!t || !t.closest) return;
      // The popup is `.ms-device-popup-v2` and the toggles are `.ms-dock-chevron`
      // — the old `.ms-dev-group` matched NOTHING, so every mousedown (including
      // one on the popup's own <select>) closed it before a device could be picked.
      if (
        showDevices &&
        !t.closest(".ms-device-popup-v2") &&
        !t.closest(".ms-dock-chevron")
      )
        setShowDevices(false);
      if (showReactions && !t.closest(".ms-reaction-group"))
        setShowReactions(false);
      if (showMoreMenu && !t.closest(".ms-more-wrap")) setShowMoreMenu(false);
      if (showInfo && !t.closest(".ms-info-wrap")) setShowInfo(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      setShowDevices(false);
      setShowReactions(false);
      setShowMoreMenu(false);
      setShowInfo(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [showDevices, showReactions, showMoreMenu, showInfo]);

  useEffect(() => {
    if (!socket || !meetingId) return;
    const onHandState = (d: any) => {
      if (d.meetingId === meetingId) {
        setRaisedHands(d.hands || []);
        if (d.names) setHandNames(d.names);
      }
    };
    const onReaction = (d: any) => {
      if (d.meetingId !== meetingId) return;
      const id = d.ts + "_" + d.userId;
      // Also pop it ON the sender's tile, so you can see WHO reacted.
      try {
        const r0: any = roomRef.current;
        if (r0 && d.userId && d.emoji) {
          const all = [r0.localParticipant, ...Array.from(r0.remoteParticipants?.values?.() || [])];
          const sp: any = all.find((x: any) => x && baseUid(x.identity) === d.userId);
          if (sp)
            for (const [k, v] of tilesRef.current as any) {
              const tl = v && v.tile;
              if (tl && String(k).split(":")[0] === sp.sid && tl.dataset.screen !== "true")
                flashTileReaction(tl, d.emoji);
            }
        }
      } catch (_) {}
      setReactions((prev) => [...prev, { ...d, id }]);
      setTimeout(
        () => setReactions((prev) => prev.filter((r) => r.id !== id)),
        4000,
      );
    };
    const onChatMsg = (d: any) => {
      if (d.meetingId !== meetingId) return;
      setChatMessages((prev) =>
        d.id && prev.some((m) => m.id === d.id) ? prev : [...prev, d],
      );
      // Unread: never for your OWN message (the server broadcasts it back to the
      // sender too), never while the chat panel is on screen, never twice for the
      // same id, and never for the join-time history replay.
      const key = d.id || `${d.senderId}_${d.ts}`;
      if (chatCountedRef.current.has(key)) return;
      chatCountedRef.current.add(key);
      // Cap the dedup set so it doesn't grow without bound in long meetings.
      if (chatCountedRef.current.size > 500) {
        const oldest = chatCountedRef.current.values().next().value;
        chatCountedRef.current.delete(oldest);
      }
      if (!chatReadyRef.current) return;
      if (meIdRef.current && d.senderId === meIdRef.current) return;
      if (chatVisibleRef.current) return;
      setChatUnread((c) => c + 1);
    };
    // A host muted us. The SFU mute silences us for everyone else, but does NOT
    // reliably reach this client — so the mic button and our own tile kept
    // showing "live" while nobody could hear us. Mute for real locally, which
    // makes the SDK, the dock toggle and the tile badge agree, and say why.
    const onForceMute = (d: any) => {
      if (!d || d.scope !== "meeting" || (d.id && d.id !== meetingId)) return;
      // Claim this mic change as "ours" while it is applied: the
      // setMicrophoneEnabled(false) below fires TrackMuted, which re-enters
      // syncLocalMicState — without this flag that path reads it as a fresh host
      // mute and shows the SAME toast a second time.
      selfMicChangeRef.current = true;
      setTimeout(() => { selfMicChangeRef.current = false; }, 1500);
      const lp = roomRef.current && roomRef.current.localParticipant;
      setMic(false);
      micIntentRef.current = false; // MIC-04: host mute also updates intent ref
      if (lp) {
        Promise.resolve(lp.setMicrophoneEnabled(false))
          .catch(() => {})
          // syncOwnTile only touches refs, so this first-render closure is safe.
          .finally(() => syncOwnTile());
      }
      onToast &&
        onToast(
          "The host muted you. You can unmute yourself when you need to speak.",
        );
    };
    // An administrator stopped our screen share from the portal. The SFU has
    // already blanked it for viewers; end the capture locally so our own button
    // and the browser's "sharing" bar agree. We may start a new share later.
    // An administrator turned our camera off. Same shape as onForceMute: switch
    // it off for real locally so the dock toggle, the tile and the SDK agree
    // (otherwise our tile keeps claiming "live" while viewers see black). We may
    // turn it back on ourselves.
    const onForceCameraOff = (d: any) => {
      if (!d || d.scope !== "meeting" || (d.id && d.id !== meetingId)) return;
      setCam(false);
      camIntentRef.current = false;
      const lp = roomRef.current && roomRef.current.localParticipant;
      if (lp) {
        Promise.resolve(lp.setCameraEnabled(false))
          .catch(() => {})
          .finally(() => syncOwnTile());
      }
      onToast &&
        onToast(
          d.by === "admin"
            ? "An administrator turned off your camera. You can turn it back on."
            : "The host turned off your camera.",
        );
    };
    const onForceStopScreen = (d: any) => {
      if (!d || d.scope !== "meeting" || (d.id && d.id !== meetingId)) return;
      const lp = roomRef.current && roomRef.current.localParticipant;
      if (lp) Promise.resolve(lp.setScreenShareEnabled(false)).catch(() => {});
      onToast &&
        onToast(
          d.by === "admin"
            ? "An administrator stopped your screen share."
            : "The host stopped your screen share.",
        );
    };
    socket.on(EVENTS.MEETING_HAND_STATE, onHandState);
    socket.on(EVENTS.MEETING_REACTION_BROADCAST, onReaction);
    socket.on(EVENTS.MEETING_CHAT_NEW, onChatMsg);
    socket.on(EVENTS.MEDIA_FORCE_MUTE, onForceMute);
    socket.on(EVENTS.MEDIA_FORCE_STOP_SCREEN, onForceStopScreen);
    socket.on(EVENTS.MEDIA_FORCE_CAMERA_OFF, onForceCameraOff);
    // Join the per-meeting socket room so we RECEIVE chat/hand/reaction events
    // without needing to send one first. Previously listeners-only saw nothing.
    const joinMeetingRoom = () => {
      if (!meetingId) return;
      socket.emit(EVENTS.MEETING_JOIN, { meetingId });
      // Each MEETING_JOIN (initial + every reconnect) triggers a fresh server
      // history replay, so (re)start the unread-suppression window here, aligned
      // with when the replay actually begins. Re-replayed ids are additionally
      // deduped by chatCountedRef, so a reconnect never double-counts.
      chatReadyRef.current = false;
      if (chatReadyTimerRef.current) clearTimeout(chatReadyTimerRef.current);
      chatReadyTimerRef.current = setTimeout(() => {
        chatReadyRef.current = true;
      }, 1500);
    };
    joinMeetingRoom();
    // CRITICAL: re-emit MEETING_JOIN on every socket reconnect. Without this, a
    // wifi blip / VPN handover drops the per-meeting socket-room membership and
    // the participant silently stops receiving chat/hands/reactions for the
    // rest of the meeting (the LiveKit media plane recovers, but the socket.io
    // side does not).
    socket.on("connect", joinMeetingRoom);
    return () => {
      socket.off(EVENTS.MEETING_HAND_STATE, onHandState);
      socket.off(EVENTS.MEETING_REACTION_BROADCAST, onReaction);
      socket.off(EVENTS.MEETING_CHAT_NEW, onChatMsg);
      socket.off(EVENTS.MEDIA_FORCE_MUTE, onForceMute);
      socket.off(EVENTS.MEDIA_FORCE_STOP_SCREEN, onForceStopScreen);
      socket.off(EVENTS.MEDIA_FORCE_CAMERA_OFF, onForceCameraOff);
      socket.off("connect", joinMeetingRoom);
      if (chatReadyTimerRef.current) clearTimeout(chatReadyTimerRef.current);
    };
  }, [socket, meetingId]);

  useEffect(() => {
    if (chatEndRef.current)
      chatEndRef.current.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages.length]);

  useEffect(() => {
    const INST = Math.random().toString(36).substring(2, 8);
    if (offline || !token || !meetingId) {
      setPhase("disconnected");
      return;
    }
    let cancelled = false;
    let room: any = null;
    let audioSub = 0;
    let videoSub = 0;
    const tilesCurrent = tilesRef.current;
    const audioCurrent = audioRef.current;
    everConnectedRef.current = false;
    // Fresh meeting → clear any pins carried over from a previous room.
    setPinnedSids([]);
    // Connect watchdog: never leave the user on an endless "Connecting…" if the
    // media server is unreachable (network/firewall/TURN). Surface a clear,
    // retryable failure after 25s. The guard makes it a no-op once connected.
    const connectWatchdog = setTimeout(() => {
      if (!cancelled && !everConnectedRef.current) {
        setErr(
          "Couldn't reach the meeting media server — usually a network or firewall issue. Retry, or switch networks.",
        );
        setPhase("disconnected");
      }
    }, 25000);
    // Hoisted so catch/cleanup can reference it. Assigned once the token is in hand.
    let diag: CallDiagnostics | null = null;
    (async () => {
      try {
        // Wait for any prior disconnect to finish (StrictMode remount safety)
        if (lkDisconnectingRef.current) {
          await lkDisconnectingRef.current;
          lkDisconnectingRef.current = null;
          await new Promise((r) => setTimeout(r, 300));
          if (cancelled) return;
        }
        setPhase("joining");
        setErr(null);
        const [res] = await Promise.all([
          // fresh: replace any prior session of mine in this room (one tile per user).
          api.getCallToken(token, { meetingId, fresh: true }),
        ]);
        if (cancelled) return;
        // Diagnostics trail. turnAdvertised flags up-front whether the backend
        // handed us a TURN relay — without one, off-network meeting joins fail
        // at ICE for anyone behind symmetric NAT.
        const _turnAdvertised = turnAdvertisedIn(
          (res as any) && (res as any).iceServers,
        );
        diag = createCallDiagnostics(INST, { turnAdvertised: _turnAdvertised });
        setMtgDiag(diag);
        diag.log("Token Generated", {
          meetingId,
          iceServers: (((res as any) && (res as any).iceServers) || []).length,
          turnAdvertised: _turnAdvertised,
        });
        // Secure-context preflight (see lib/mediaSupport). On a plain-HTTP LAN
        // origin navigator.mediaDevices is undefined, so joining the meeting
        // would crash on the mic step. Fail fast with guidance instead.
        const _mediaReason = mediaBlockedReason();
        if (_mediaReason) {
          if (!cancelled) {
            setErr(_mediaReason);
            setPhase("disconnected");
          }
          return;
        }
        // Honor the user's saved device choices (Settings → mic/camera/speaker),
        // matching the 1:1 call path. Empty/unset = system default. Setting
        // audioOutput.deviceId makes LiveKit apply setSinkId at construction.
        const _sx = settings || {};
        const _aCap: any = {
          noiseSuppression: _sx.noiseSuppression !== false,
          echoCancellation: _sx.echoCancellation !== false,
          // Custom audioCaptureDefaults REPLACE LiveKit's defaults (which include
          // autoGainControl:true); set it explicitly so AEC/NS/AGC are all applied
          // and the mic can't boost residual speaker bleed into echo.
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
        // Explicit 720p30 capture — shared with the call path (lib/mediaQuality
        // explains why 720p, not 1080p, is the better top rung).
        const _vCap: any = { ...CAMERA_CAPTURE };
        if (_sx.cameraId) _vCap.deviceId = _sx.cameraId;
        // Validate the saved speaker the SAME way as the mic above: a stale
        // speakerId (device unplugged, or a Bluetooth id that rotated on
        // reconnect) handed to audioOutput makes LiveKit's attach throw
        // "setSinkId NotFoundError" and can leave remote audio routed to a dead
        // device → silent. If it's gone, drop it so LiveKit AND the per-element
        // path both fall back to the system default.
        let _spkOk = !!_sx.speakerId;
        if (_sx.speakerId) {
          try {
            const _outs = (await navigator.mediaDevices.enumerateDevices()).filter(
              (d) => d.kind === "audiooutput" && d.deviceId,
            );
            if (_outs.length && !_outs.some((d) => d.deviceId === _sx.speakerId)) _spkOk = false;
          } catch {
            /* keep _spkOk = true — trust the saved id when we can't enumerate */
          }
        }
        const _out: any = {};
        if (_spkOk) _out.deviceId = _sx.speakerId;
        // Per-element setSinkId source = the (validated) saved speaker only, never
        // an auto-picked device. Empty leaves each <audio> on the system default.
        spkSinkRef.current = _spkOk ? _sx.speakerId : "";
        // External TURN relay (coturn) advertised by the backend — same as the
        // call path, so off-LAN / global meeting participants relay media over
        // turns://<domain> when they can't reach the SFU's node_ip directly.
        const _ice = ((res as any) && (res as any).iceServers) || [];
        room = new LK.Room({
          adaptiveStream: true,
          dynacast: true,
          ...e2eeRoomOptions(),
          ...(_ice.length ? { rtcConfig: { iceServers: _ice } } : {}),
          disconnectOnPageLeave: false,
          // MIC-01 / D-1(a) hard mute: mute STOPS CAPTURE at the source (the
          // track is stopped, the OS mic-in-use indicator goes off), not just
          // "disabled but still capturing". Unmute re-acquires — a few hundred
          // ms slower, which the trust guarantee is worth. Same option in the
          // 1:1/group call path (useCallSessionMedia) — one mute semantics.
          stopMicTrackOnMute: true,
          audioCaptureDefaults: _aCap,
          videoCaptureDefaults: _vCap,
          audioOutput: _out,
          // Simulcast matters more in meetings than 1:1 — multiple viewers
          // with mixed bandwidth subscribe to each publisher.
          publishDefaults: {
            simulcast: true,
            videoSimulcastLayers: [
              (LK.VideoPresets as any).h180,
              (LK.VideoPresets as any).h360,
            ],
            // NO hardcoded codec: publish in whatever THIS browser can actually
            // encode — Chrome/Firefox → VP9, Safari-mac → H.264, otherwise VP8 —
            // chosen only from codecs every browser can DECODE, so all participants
            // interoperate. undefined ⇒ let livekit-client negotiate. (A hardcoded
            // VP9 was un-encodable on Safari-mac → the "dead video on Mac" report.)
            videoCodec: preferredVideoCodec(),
            videoEncoding: { maxBitrate: MEETING_VIDEO_MAX_BITRATE, maxFramerate: 30 },
            dtx: true,
            red: true,
          } as any,
          // 10 attempts over ~60s — wake-from-sleep / VPN-handover commonly
          // takes 30-60s to re-establish the WS. The tighter 17s budget gave
          // up on otherwise-recoverable meetings.
          reconnectPolicy: {
            nextRetryDelayInMs: (context: any) => {
              if (context.retryCount > 10) return null;
              return Math.min(500 * Math.pow(1.6, context.retryCount), 7000);
            },
          },
        });
        roomRef.current = room;

        const updateParticipants = () => {
          if (!room) return;
          // livekit-client 2.x: the participant map is room.remoteParticipants;
          // room.participants is the deprecated v1 alias (undefined in 2.19.1).
          // Using it here early-returned and silently dropped every 3rd+ tile.
          const remotes = room.remoteParticipants || room.participants;
          if (!remotes) return;
          const ps: any[] = [];
          remotes.forEach((p: any) => {
            ps.push({
              sid: p.sid,
              identity: p.identity,
              // Bare userId for host-control + role/hand matching (see baseUid).
              userId: baseUid(p.identity),
              // Display the name only — never the raw identity/user id.
              name: p.name || "Participant",
              avatarUrl: resolveMediaUrl(avatarUrlOf(p)),
              isLocal: false,
              hasScreenShare: p.isScreenShareEnabled,
              isSpeaking: p.isSpeaking,
              // Mic/cam status for the Participant View roster rows (P0-10).
              micOn: !!p.isMicrophoneEnabled,
              camOn: !!p.isCameraEnabled,
            });
          });
          if (room.localParticipant) {
            ps.push({
              sid: room.localParticipant.sid,
              identity: room.localParticipant.identity,
              userId: baseUid(room.localParticipant.identity),
              name: room.localParticipant.name || "You",
              avatarUrl: resolveMediaUrl(avatarUrlOf(room.localParticipant)),
              isLocal: true,
              hasScreenShare: screen,
              isSpeaking: room.localParticipant.isSpeaking,
              micOn: !!room.localParticipant.isMicrophoneEnabled,
              camOn: !!room.localParticipant.isCameraEnabled,
            });
          }
          // DEDUPE by base user id (the "same profile connected 3 times" bug).
          // makeIdentity() adds a per-JOIN uuid, so one human who reloads / opens
          // a 2nd tab / auto-rejoins after a blip mints a fresh LiveKit identity
          // + sid each time and shows as several tiles (server-side eviction is
          // racy/fail-soft). Collapse to ONE entry per person: keep the richest
          // session (local wins; then screen-share; then camera; then speaking;
          // then first seen) and let the pruning below remove the losers' tiles.
          const byUser = new Map<string, any>();
          const rankP = (p: any) =>
            (p.isLocal ? 100 : 0) +
            (p.hasScreenShare ? 8 : 0) +
            (p.camOn ? 4 : 0) +
            (p.isSpeaking ? 1 : 0);
          for (const p of ps) {
            const key = p.userId || p.sid;
            const cur = byUser.get(key);
            if (!cur || rankP(p) > rankP(cur)) byUser.set(key, p);
          }
          const view = Array.from(byUser.values());
          view.sort((a, b) => (a.isLocal ? -1 : b.isLocal ? 1 : 0));
          // Spread remote voices across the stereo field in tile order (spatial
          // audio). Local participant is excluded — you don't hear yourself.
          // setOrder is the immediate even-spread fallback; a rAF pass then
          // refines to each remote tile's true on-screen x for accurate panning.
          if (spatialRef.current) {
            const sp = spatialRef.current;
            sp.setOrder(view.filter((p) => !p.isLocal).map((p) => p.sid));
            requestAnimationFrame(() => {
              const st = stageRef.current as HTMLElement | null;
              if (!st) return;
              const sr = st.getBoundingClientRect();
              if (!sr.width) return;
              const seen = new Set<string>();
              const positions: { id: string; x: number }[] = [];
              for (const t of Array.from(
                st.querySelectorAll<HTMLElement>("[data-pid]"),
              )) {
                if (t.dataset.local === "true") continue;
                // Camera + screen tiles share a base sid; pan by the first
                // (camera) tile so a presenter's voice isn't double-counted.
                const sid = String(t.dataset.pid || "").split(":")[0];
                if (!sid || seen.has(sid)) continue;
                const r = t.getBoundingClientRect();
                if (!r.width) continue;
                seen.add(sid);
                positions.push({
                  id: sid,
                  x: (r.left + r.width / 2 - sr.left) / sr.width,
                });
              }
              if (positions.length) sp.setLayout(positions);
            });
          }
          // Reconcile tiles: every participant gets a tile (avatar placeholder
          // until a video track attaches); prune tiles for departed people AND
          // the deduped-away duplicate sessions (their sids aren't in `view`).
          const liveSids = new Set(view.map((p) => p.sid));
          for (const p of view) ensureTile(p);
          // Sync each people tile's mic-muted badge from live mic state. This
          // runs on every TrackMuted/TrackUnmuted + local toggle (both call
          // updateParticipants), so the indicator tracks reality in real time.
          for (const p of view) {
            const entry = tilesRef.current.get(p.sid);
            const badge = entry && (entry.tile.querySelector(".ms-tile-mic") as HTMLElement | null);
            if (badge) {
              badge.classList.toggle("muted", !p.micOn);
              badge.setAttribute("aria-label", p.micOn ? "Microphone on" : "Microphone muted");
            }
          }
          for (const [k, v] of tilesRef.current) {
            // Tiles are keyed "<sid>" (camera) or "<sid>:screen"; prune by the
            // BASE sid so a presenter's screen tile isn't dropped while they're
            // still in the room (it's removed by detach when sharing stops).
            const base = String(k).split(":")[0];
            if (!liveSids.has(base)) {
              try {
                v.track && v.track.detach().forEach((e: any) => e.remove());
              } catch (_) {}
              v.tile.remove();
              tilesRef.current.delete(k);
            }
          }
          setParticipants(view);
          // Drop pins for participants who have left so a stale pin can't keep
          // an empty/dead tile featured.
          setPinnedSids((prev) => {
            const next = prev.filter((sid) =>
              liveSids.has(String(sid).split(":")[0]),
            );
            return next.length === prev.length ? prev : next;
          });
          // Clear the presenter id when the presenter has left the room.
          setPresenterId((prev) =>
            prev && !liveSids.has(String(prev).split(":")[0]) ? null : prev,
          );
        };
        // Expose it so the LOCAL mic/cam toggles can refresh their own tile.
        // LiveKit's TrackMuted/TrackUnmuted are remote-driven, so without this
        // your own tile badge never re-rendered after you muted or unmuted
        // yourself: you join a meeting muted, unmute from the dock, and the tile
        // kept showing the muted icon while the dock showed live.
        updateParticipantsRef.current = updateParticipants;

        // Create a tile with an avatar placeholder if one doesn't exist yet.
        const ensureTile = (participant: any, isScreen = false) => {
          // Screen-share gets its OWN tile (keyed sid:screen) so a presenter's
          // camera and screen render as two separate tiles instead of fighting
          // over one — which produced the duplicate/flickering renders.
          const pid = participant.sid + (isScreen ? ":screen" : "");
          let entry = tilesRef.current.get(pid);
          if (entry) return entry;
          // Always label by display name — never the raw identity/user id.
          const displayName = participant.name || "Participant";
          const nm =
            displayName +
            (isScreen ? " — screen" : participant.isLocal && !/^you$/i.test(displayName) ? " (you)" : "");
          participantNames.current.set(pid, displayName);
          const tile = document.createElement("div");
          tile.className =
            "ms-tile ms-tile-novideo" + (isScreen ? " ms-tile-screen" : "");
          tile.dataset.pid = pid;
          // Mark the local tile so gallery paging keeps "you" on page 1.
          if (participant.isLocal) tile.dataset.local = "true";
          // Per-person accent on the TILE too: the camera-off backdrop is a soft
          // gradient seeded from it (Skype-style), see call.css.
          tile.style.setProperty("--av", colorOf(participant.identity || displayName || pid));
          tile.style.setProperty("--av-angle", gradientAngleOf(participant.identity || displayName || pid) + "deg");
          // One of the 20 generated backdrops, stable per person (identity minus
          // the per-session suffix so a rejoin keeps the same colour).
          applyTilePalette(tile, String(participant.identity || displayName || pid).split("__")[0], stageRef.current);
          // Avatar placeholder shown when no camera track is present.
          const ph = document.createElement("div");
          ph.className = "ms-avatar-ph";
          const circle = document.createElement("div");
          circle.className = "ms-avatar-circle";
          circle.textContent = initialsOf(displayName);
          // Accent on a CSS variable (not an inline background) so the sheet can
          // tint it: pastel disc + the accent for the initials (Figma tile).
          circle.style.setProperty(
            "--av",
            colorOf(participant.identity || displayName || pid),
          );
          // Profile photo over the initials (a screen-share tile has no person).
          if (!isScreen) paintAvatar(circle, resolveMediaUrl(avatarUrlOf(participant)));
          ph.appendChild(circle);
          tile.appendChild(ph);
          const label = document.createElement("div");
          label.className = "ms-label";
          // Mic status chip — a round badge in the tile's bottom-RIGHT corner
          // (Figma tile): mic glyph when live, slashed mic when muted. The
          // participant sync toggles `.muted`; camera/screen tiles get none.
          if (!isScreen) {
            const micGlyph = document.createElement("span");
            micGlyph.className = "ms-tile-mic";
            micGlyph.setAttribute("aria-label", "Microphone on");
            micGlyph.innerHTML =
              '<svg class="mic-on" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/></svg>' +
              '<svg class="mic-off" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/></svg>';
            tile.appendChild(micGlyph);
          }
          const labelName = document.createElement("span");
          labelName.className = "ms-tile-name";
          labelName.textContent = nm;
          label.appendChild(labelName);
          // Speaking wave inside the pill (animates while .tile-speaking is on).
          if (!isScreen) label.insertAdjacentHTML("beforeend", '<span class="label-wave" aria-hidden="true"><i></i><i></i><i></i><i></i></span>');
          // Teams "Pin for me" — local, multi-pin. Toggles this tile in pinnedSids.
          const expandBtn = document.createElement("button");
          expandBtn.className = "ms-expand-btn";
          expandBtn.title = "Pin for me";
          expandBtn.innerHTML =
            '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>';
          expandBtn.onclick = (e) => {
            e.stopPropagation();
            togglePin(pid);
          };
          const fsBtn = document.createElement("button");
          fsBtn.className = "ms-fullscreen-btn";
          fsBtn.title = "Fullscreen";
          fsBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
          fsBtn.onclick = (e) => {
            e.stopPropagation();
            if (fsElement() === tile) fsExit(); else fsRequest(tile);
          };
          tile.appendChild(label);
          tile.appendChild(fsBtn);
          tile.appendChild(expandBtn);
          if (isScreen) {
            const popoutBtn = document.createElement("button");
            popoutBtn.className = "ms-popout-btn";
            popoutBtn.type = "button";
            const { hasDocPip, hasVidPip } = popoutCapability();
            // POP-08 loop prevention: popping out YOUR OWN share can recurse —
            // the pop-out window lands on the display you're sharing and mirrors
            // itself forever. (A remote share can't recurse: its pixels aren't
            // this machine's screen.) Suppress with an inline explanation rather
            // than a control that silently degrades.
            const isOwnShare = !!participant.isLocal;
            if (isOwnShare) {
              popoutBtn.disabled = true;
              popoutBtn.setAttribute("aria-disabled", "true");
              popoutBtn.title =
                "Pop out is unavailable for your own share — it would mirror itself on the screen you're sharing.";
            } else {
              // Capability-honest tooltip (platform note in §2): say which pop-out
              // this browser can actually do instead of silently degrading.
              popoutBtn.title = hasDocPip
                ? "Pop out screen share (window)"
                : hasVidPip
                  ? "Pop out screen share (Picture-in-Picture)"
                  : "Pop out screen share";
            }
            popoutBtn.setAttribute("aria-label", popoutBtn.title);
            popoutBtn.innerHTML =
              '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';
            // POP-04: while popped out, the tile keeps its (dimmed) live video as
            // the thumbnail and gains this overlay with a "Bring back" control.
            const addPlaceholder = () => {
              tile.classList.add("ms-tile-popped-out");
              markPoppedOut(pid, true);
              if (tile.querySelector(".ms-popout-placeholder")) return;
              const ph = document.createElement("div");
              ph.className = "ms-popout-placeholder";
              const msg = document.createElement("span");
              msg.textContent = "Popped out";
              const back = document.createElement("button");
              back.type = "button";
              back.className = "ms-popout-bringback";
              back.textContent = "Bring back";
              back.onclick = (ev) => {
                ev.stopPropagation();
                // Doc-PiP path: closing the window fires its pagehide → cleanup.
                closePipWindow(pid);
                // Video-PiP path: this tile's video may be the active PiP element.
                const pipEl = (document as any).pictureInPictureElement;
                if (pipEl && tile.contains(pipEl))
                  (document as any).exitPictureInPicture?.().catch?.(() => {});
                removePlaceholder();
              };
              ph.appendChild(msg);
              ph.appendChild(back);
              tile.appendChild(ph);
            };
            const removePlaceholder = () => {
              tile.classList.remove("ms-tile-popped-out");
              markPoppedOut(pid, false);
              tile.querySelector(".ms-popout-placeholder")?.remove();
            };
            popoutBtn.onclick = (e) => {
              e.stopPropagation();
              if (isOwnShare) return; // POP-08 (button is disabled; belt and braces)
              void openScreenPopout({
                tile,
                pid,
                participantName: participant.name || "Screen share",
                video: tile.querySelector("video") as HTMLVideoElement | null,
                pipWindows: activePipWindowsRef.current,
                onToast,
                onEvent: trackEvent,
                addPlaceholder,
                removePlaceholder,
              });
            };
            tile.appendChild(popoutBtn);
          }
          // (The mic-muted glyph now lives at the start of the name pill — see
          // the label build above — so it can't collide with the self-view PiP.)
          // Participant ⋮ menu — remote camera/avatar tiles only (not self, not a
          // screen-share tile). Opens the SAME shared ParticipantMenu as the call
          // path + People panel. Bound once here; the opener ref resolves the
          // current participant + role state at click time.
          if (!participant.isLocal && !isScreen) {
            const menuBtn = document.createElement("button");
            menuBtn.className = "ms-tile-menu-btn";
            menuBtn.type = "button";
            menuBtn.setAttribute("aria-label", "Participant options");
            menuBtn.setAttribute("aria-haspopup", "menu");
            menuBtn.title = "More options";
            menuBtn.innerHTML = PARTICIPANT_MENU_ICON;
            const _menuSid = participant.sid;
            menuBtn.onclick = (e) => {
              e.stopPropagation();
              openMeetTileMenuRef.current(menuBtn, _menuSid);
            };
            tile.appendChild(menuBtn);
          }
          stageRef.current && stageRef.current.appendChild(tile);
          entry = { tile, track: null, participantSid: pid };
          tilesRef.current.set(pid, entry);
          return entry;
        };

        const attach = (track: any, participant: any) => {
          // If a recording is in progress, mix this newly-arrived audio into it
          // (someone joined or unmuted after Record was pressed).
          if (track.kind === "audio" && recAddAudioRef.current) {
            try { recAddAudioRef.current({ track }); } catch (_) {}
          }
          if (track.kind === "audio" && participant.isLocal) return;
          if (track.kind === "audio") {
            // Try spatial routing first (Web Audio panner). On success the track
            // plays through the shared AudioContext — do NOT also attach an
            // <audio> element or it double-plays. Falls back to plain playback.
            if (!spatialRef.current) {
              spatialRef.current = new SpatialAudioManager();
              // Spatial audio is masked off — the manager is created for its
              // plain-playback path only, so force it disabled here. This used
              // to read the persisted preference; with the toggle gone that
              // would silently re-enable panning for anyone who had it on.
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
            )
              return;
            const ael = track.attach();
            ael.autoplay = true;
            // Per-element speaker sink WITH a fallback (parity with the 1:1 call
            // path, CoLabV1 ~13429): if the saved speaker id is stale/invalid —
            // common with a Bluetooth headset whose id rotates on reconnect —
            // setSinkId rejects and .catch() leaves the element on the DEFAULT
            // device so audio is still HEARD, instead of routing to a dead device
            // (silent). The Room's audioOutput alone has no such fallback, which
            // is why meetings went silent where calls did not.
            const _sk = spkSinkRef.current;
            if (_sk && (ael as any).setSinkId)
              (ael as any).setSinkId(_sk).catch(() => {});
            audioRef.current && audioRef.current.appendChild(ael);
            // Autoplay policy: `autoplay = true` is a HINT, not a command — the
            // browser frequently won't start playback without an explicit play().
            // The 1:1 call path calls play() here and works; the meeting path
            // never did, which is why meeting audio was CAPTURED + routed but
            // stayed SILENT (tiles blink, nobody's heard). Play explicitly
            // (best-effort; room.startAudio()'s join gesture unblocks it).
            ael.play && ael.play().catch(() => {});
            return;
          }
          const isScreen =
            track.source === "screen_share" || track.source === "screen";
          // SELF SCREEN-SHARE: never render your OWN shared screen back to you.
          // The loopback is what creates the infinite "hall of mirrors" — your
          // shared screen contains the meeting window, which shows your shared
          // screen, which shows the meeting… Teams/Zoom/Meet all suppress the
          // presenter's own share view and show a placeholder instead. Remote
          // participants still receive + render the real screen via
          // TrackSubscribed, so nothing changes for the audience.
          if (isScreen && participant.isLocal) {
            const selfEntry = ensureTile(participant, true);
            selfEntry.tile
              .querySelectorAll(".ms-vid")
              .forEach((e: any) => e.remove());
            selfEntry.tile.dataset.screen = "true";
            selfEntry.tile.classList.remove("ms-tile-novideo");
            selfEntry.tile.classList.add("ms-self-screen");
            if (!selfEntry.tile.querySelector(".ms-self-share")) {
              const ph = document.createElement("div");
              ph.className = "ms-self-share";
              ph.innerHTML =
                '<div class="ms-self-share-inner">' +
                '<svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>' +
                '<span class="ms-self-share-t">You’re sharing your screen</span>' +
                '<span class="ms-self-share-s">Everyone else can see it — your own preview is hidden to prevent a mirror loop.</span>' +
                "</div>";
              selfEntry.tile.prepend(ph);
            }
            selfEntry.track = track;
            setPresenterId(selfEntry.tile.dataset.pid as string);
            updateParticipants();
            refreshScreenShares();
            return;
          }
          const el = track.attach();
          const entry = ensureTile(participant, isScreen);
          const pid = entry.tile.dataset.pid as string;
          participantNames.current.set(
            pid,
            participant.name || participant.identity || pid,
          );
          if (isScreen) setPresenterId(pid);
          // Remove ALL prior video elements in THIS tile (defensive: never leave a
          // stale <video> behind that would render as a duplicate).
          entry.tile
            .querySelectorAll(".ms-vid")
            .forEach((e: any) => e.remove());
          Object.assign(el.style, {
            width: "100%",
            height: "100%",
            objectFit: isScreen ? "contain" : "cover",
          });
          el.className = "ms-vid";
          if (!isScreen) attachAdaptiveVideoFit(el);
          // Self-view is shown as-is (not mirrored) per user preference.
          entry.tile.prepend(el);
          entry.tile.classList.remove("ms-tile-novideo");
          if (isScreen) entry.tile.dataset.screen = "true";
          entry.track = track;
          updateParticipants();
          if (isScreen) refreshScreenShares();
        };
        const detach = (track: any) => {
          try {
            track.detach().forEach((e: any) => e.remove());
          } catch (_) {}
          for (const [k, v] of tilesRef.current)
            if (v.track === track) {
              if (v.tile.dataset.screen === "true") {
                // Dedicated screen tile — remove it entirely when sharing stops.
                // Close only THIS share's pop-out window (keyed by tile pid):
                // with concurrent shares, one presenter stopping must not tear
                // down pop-outs of the shares still running.
                closePipWindow(k);
                // Clear the "open in a separate window" strip immediately rather
                // than waiting for the window's own teardown to be observed.
                markPoppedOut(k, false);
                if (onToast) onToast("Screen sharing ended");
                setPresenterId((prev: any) => (prev === k ? null : prev));
                try {
                  v.tile.remove();
                } catch (_) {}
                tilesRef.current.delete(k);
                refreshScreenShares();
              } else {
                // Camera track gone — keep the tile, fall back to the avatar.
                v.tile
                  .querySelectorAll(".ms-vid")
                  .forEach((e: any) => e.remove());
                v.tile.classList.add("ms-tile-novideo");
                v.track = null;
              }
              updateParticipants();
              return;
            }
        };

        room
          .on(LK.RoomEvent.TrackSubscribed, (t: any, _p: any, part: any) => {
            if (t.kind === "audio") audioSub++;
            if (t.kind === "video") videoSub++;
            attach(t, part);
          })
          // Keep the Participant View roster's mic/cam status live (P0-10) —
          // a mute/unmute republishes nothing, so without these the row icons
          // would only refresh on join/leave.
          // A host's "Mute everyone" is a SERVER-side mute: LiveKit stops our
          // published audio and fires TrackMuted for our OWN participant. That
          // refreshed the tile badge but left the control-bar `mic` state — the
          // only thing the dock button reads — still showing "on", so the user
          // saw "Everyone muted" while their own toggle looked live. Re-read the
          // SDK's truth for any local microphone mute/unmute, whoever caused it.
          .on(LK.RoomEvent.TrackMuted, (pub: any, part: any) => {
            syncLocalMicState(pub, part);
            updateParticipants();
          })
          .on(LK.RoomEvent.TrackUnmuted, (pub: any, part: any) => {
            syncLocalMicState(pub, part);
            updateParticipants();
          })
          // A remote mic that publishes already-unmuted emits no Muted/Unmuted
          // transition, so a tile badge defaulting to "muted" would stay wrong —
          // re-derive from the actual publication state on publish.
          .on(LK.RoomEvent.TrackPublished, () => {
            updateParticipants();
          })
          .on(LK.RoomEvent.TrackUnsubscribed, (t: any, _pub: any, part: any) => {
            if (t && t.kind === "audio") audioSub = Math.max(0, audioSub - 1);
            if (t && t.kind === "video") videoSub = Math.max(0, videoSub - 1);
            if (t && t.kind === "audio" && part && spatialRef.current)
              spatialRef.current.detach(part.sid);
            detach(t);
          })
          .on(LK.RoomEvent.DataReceived, (payload: any, participant: any) => {
            // Whiteboard ops from a remote participant (t:"wb"). Reactions/hands
            // in the meeting go over Socket.io, not here.
            try {
              const msg = JSON.parse(new TextDecoder().decode(payload));
              if (msg && msg.t === "wb" && msg.wb) {
                // Shared surface: auto-open when a peer opens/draws (but not on
                // ambient cursor/sync-request traffic). The mount then pulls full
                // state via sync-request.
                const op = msg.wb.op;
                if (!allowWhiteboardRef.current) return;
                if (op && op !== "cursor" && op !== "sync-request")
                  setShowWhiteboard(true);
                // AUDIT #22: tell the whiteboard whether the SENDER is a moderator
                // (host / co-host) so it can reject a locked-out peer's ops.
                const senderUid = baseUid(participant && participant.identity);
                const fromModerator =
                  !!(hostId && senderUid === hostId) ||
                  !!(coHostIds && coHostIds.has && coHostIds.has(senderUid));
                wbReceiverRef.current &&
                  wbReceiverRef.current(msg.wb, { fromModerator });
              } else if (msg && msg.t === "presenter" && participant) {
                // A peer entered/left a presenter layout — hide their redundant
                // camera tile (their camera is composited into their share).
                presenter.ingestSignal(participant.sid, msg.mode);
                applyPresenterHidden(stageRef.current, presenter.presentingSids);
                setTimeout(
                  () =>
                    applyPresenterHidden(
                      stageRef.current,
                      presenter.presentingSids,
                    ),
                  250,
                );
              } else if (msg && msg.t === "rec") {
                // A peer started/stopped recording — surface the shared REC badge.
                // Track the announcer so an unclean drop can clear it (#46).
                peerRecorderRef.current = msg.on
                  ? (participant && (participant.identity || participant.sid)) || null
                  : null;
                setPeerRecording(!!msg.on);
              } else if (msg && msg.t === "spot" && participant) {
                // VIEW-09: a moderator changed the spotlight set. Trust it only
                // from the host/co-hosts — same rule as whiteboard moderation —
                // so a regular participant can't force anyone's layout.
                const spotSenderUid = baseUid(participant.identity);
                const spotFromModerator =
                  !!(hostId && spotSenderUid === hostId) ||
                  !!(coHostIds && coHostIds.has && coHostIds.has(spotSenderUid));
                if (spotFromModerator) {
                  const uids = (Array.isArray(msg.uids) ? msg.uids : [])
                    .filter((u: any) => typeof u === "string" && u)
                    .slice(0, 3);
                  const prev = spotlightUidsRef.current;
                  const same =
                    prev.length === uids.length && prev.every((u, i) => u === uids[i]);
                  setSpotlightBy(participant.name || "the organizer");
                  if (!same) {
                    spotlightUidsRef.current = uids;
                    setSpotlightUids(uids);
                    // A CHANGED spotlight re-applies over a prior local escape.
                    setSpotlightEscaped(false);
                    // VIEW-11: announce the forced change to screen readers.
                    setSrAnnouncement(
                      uids.length
                        ? `Spotlight applied by ${participant.name || "the organizer"}.`
                        : "Spotlight removed.",
                    );
                  }
                }
              }
            } catch (_) {}
          })
          .on(LK.RoomEvent.LocalTrackPublished, (pub: any, part: any) => {
            if (pub.track) attach(pub.track, part);
            // BA/CEO #3: `screen` is EVENT-DRIVEN — set true ONLY once the share
            // track actually publishes (paired with the Unpublished reset below).
            // A cancelled or hung picker never publishes, so it can never strand
            // the presenting flag / DND / dock label.
            const _src = pub.source || (pub.track && pub.track.source);
            if (_src === "screen_share" || _src === "screen") {
              setScreen(true);
              setScreenPending(false);
            }
            updateParticipants();
          })
          .on(LK.RoomEvent.LocalTrackUnpublished, (pub: any) => {
            // Screen share ended — incl. via the BROWSER's own "Stop sharing"
            // bar, which never calls toggleScreen(), leaving `screen` stuck true
            // (the dock kept showing "Stop sharing" + a phantom "Presenting").
            // Reset it FIRST and unconditionally: tile/pop-out teardown below can
            // throw (concurrent shares, a pop-out window already gone), and when
            // it did, `screen` stayed true and Stop became a dead button.
            const _src = pub.source || (pub.track && pub.track.source);
            if (_src === "screen_share" || _src === "screen" || _src === "screen_share_audio") {
              setScreen(false);
              setScreenPending(false);
            }
            try { if (pub.track) detach(pub.track); } catch (_) {}
            try { updateParticipants(); } catch (_) {}
          })
          .on(LK.RoomEvent.ParticipantConnected, () => {
            updateParticipants();
            // Late-joiner: re-announce our presenter mode so they hide our tile,
            // and our recording state so their REC badge shows too.
            presenter.announceMode();
            if (clientRecordingRef.current) recBroadcast(true);
            // VIEW-09: any moderator re-announces the active spotlight set so a
            // late joiner lands in the same forced layout as everyone else.
            const amMod =
              !!(hostId && meId === hostId) ||
              !!(coHostIds && coHostIds.has && coHostIds.has(meId));
            if (amMod && spotlightUidsRef.current.length)
              spotlightBroadcast(spotlightUidsRef.current);
          })
          .on(LK.RoomEvent.ParticipantDisconnected, (p: any) => {
            if (p && p.sid) presenter.dropPresenter(p.sid);
            // AUDIT #46: the recorder dropped without a clean stop → clear the
            // stale REC badge the instant that specific participant disconnects.
            const leaver = (p && (p.identity || p.sid)) || null;
            if (leaver && peerRecorderRef.current && leaver === peerRecorderRef.current) {
              peerRecorderRef.current = null;
              setPeerRecording(false);
            }
            // Fallback: everyone else left → clear any lingering badge.
            if (room && room.remoteParticipants && room.remoteParticipants.size === 0) {
              peerRecorderRef.current = null;
              setPeerRecording(false);
            }
            setTimeout(() => {
              updateParticipants();
              applyPresenterHidden(stageRef.current, presenter.presentingSids);
            }, 100);
          })
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
                // LiveKit emits "lost" when the local connection drops — surface it
                // as a real red downgrade, not the grey "unknown" it used to collapse to.
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
          // Keep the device pickers in sync with LiveKit's actual active device,
          // incl. its automatic fallback when the active device is unplugged.
          .on(
            LK.RoomEvent.ActiveDeviceChanged,
            (kind: any, deviceId: string) => {
              if (cancelled) return;
              if (kind === "audioinput") setSelMic(deviceId);
              else if (kind === "videoinput") setSelCam(deviceId);
              else if (kind === "audiooutput") setSelSpk(deviceId);
            },
          )
          .on(LK.RoomEvent.ActiveSpeakersChanged, (speakers: any[]) => {
            if (!stageRef.current) return;
            const speaking = new Set(
              (speakers || []).map((s: any) => s && s.sid).filter(Boolean),
            );
            // Track the primary active speaker for speaker-view layout with 500ms debounce
            // (VIEW-21) to filter out transient noises/bursts, and NEVER yourself.
            const firstRemote = (speakers || []).find(
              (s: any) => s && s.sid && !s.isLocal,
            );
            if (firstRemote && firstRemote.sid) {
              if (speakerDebounceRef.current) clearTimeout(speakerDebounceRef.current);
              speakerDebounceRef.current = setTimeout(() => {
                setActiveSpeakerSid(firstRemote.sid);
              }, 500);
            } else {
              if (speakerDebounceRef.current) clearTimeout(speakerDebounceRef.current);
              setActiveSpeakerSid(null);
            }
            // Tiles may nest in the pin-area / strip containers, so query by
            // [data-pid] rather than only the stage's direct children.
            Array.from(
              stageRef.current.querySelectorAll("[data-pid]"),
            ).forEach((c: any) => {
              const base = String(c.dataset.pid || "").split(":")[0];
              // Screen shares keep their subtle frame; people get the speaking
              // glow + sound-wave (lib/stageView, shared with calls).
              c.style.outline =
                c.dataset.screen === "true"
                  ? "2px solid color-mix(in srgb, var(--ac) 60%, transparent)"
                  : "none";
              setTileSpeaking(c, speaking.has(base));
            });
          })
          .on(LK.RoomEvent.Disconnected, (reason: any) => {
            const name =
              (LK.DisconnectReason && LK.DisconnectReason[reason]) ||
              reason ||
              "UNKNOWN";
            if (cancelled) return;
            // We clicked "End for everyone" ourselves — endForAll already calls
            // onLeave; ignore our own ROOM_DELETED echo so we don't leave twice.
            if (endingRef.current) return;
            // DUPLICATE_IDENTITY = same user joined this meeting on another tab/
            // device. With per-join UUID identity this is the legitimate "you
            // joined elsewhere" path — keep the other tab in, don't slam the UI
            // to disconnected. The other tab IS the active session.
            const isDup =
              reason ===
                (LK.DisconnectReason &&
                  LK.DisconnectReason.DUPLICATE_IDENTITY) ||
              String(name).toUpperCase().includes("DUPLICATE");
            if (isDup) {
              setErr("You joined this meeting on another device or tab.");
              return;
            }
            // Terminal disconnects — do NOT auto-rejoin (a rejoin would recreate a
            // fresh EMPTY room / re-enter). The host ended the meeting for everyone
            // (ROOM_DELETED) or you were removed (PARTICIPANT_REMOVED): leave.
            {
              const DR: any = LK.DisconnectReason || {};
              const uname = String(name).toUpperCase();
              const ended =
                reason === DR.ROOM_DELETED ||
                uname.includes("ROOM_DELETED") ||
                uname.includes("DELETE");
              const kicked =
                reason === DR.PARTICIPANT_REMOVED || uname.includes("REMOVED");
              if (ended || kicked) {
                onToast &&
                  onToast(
                    ended
                      ? "The host ended the meeting."
                      : "You were removed from the meeting.",
                  );
                onLeave && onLeave(leaveMeta());
                return;
              }
            }
            // P1 Automatic Rejoin: re-run the existing connect path (re-mint token
            // + reconnect + reacquire tracks) a bounded number of times before
            // surfacing failure. LiveKit's reconnectPolicy is already exhausted by
            // the time Disconnected fires. Counter resets to 0 on a clean join.
            const MAX_AUTO_REJOIN = 2;
            if (rejoinAttemptsRef.current < MAX_AUTO_REJOIN) {
              rejoinAttemptsRef.current += 1;
              if (diag)
                diag.log("Auto-rejoin", {
                  attempt: rejoinAttemptsRef.current,
                  of: MAX_AUTO_REJOIN,
                  reason: String(name),
                });
              onToast && onToast("Network issue — reconnecting…");
              setErr(null);
              setPhase("joining");
              setNetQuality("lost");
              setRetryKey((k) => k + 1); // same path as the Retry button
              return;
            }
            setPhase("disconnected");
            setNetQuality("lost");
            const _snap = diag ? diag.snapshot() : null;
            const _msg =
              _snap && !_snap.turnAdvertised
                ? "Couldn't keep a media path — no TURN relay was available. Try a different network"
                : _snap && !_snap.turnUsed
                  ? "Lost the meeting media and couldn't reconnect. Your network may be blocking it and the TURN relay wasn't reachable. Try another network, or ask IT to verify the TURN ports (3478/5349/443)."
                  : "Lost connection to the meeting media (" +
                    name +
                    "). Click Retry to reconnect.";
            if (diag)
              diag.log("Media Error", {
                fatal: true,
                reason: String(name),
                everConnected: everConnectedRef.current,
                turnAdvertised: _snap && _snap.turnAdvertised,
                turnUsed: _snap && _snap.turnUsed,
              });
            setErr(_msg);
            onToast &&
              onToast("Disconnected from meeting media (" + name + ")");
          })
          // Network dropped: LiveKit may stop emitting quality stats entirely, so
          // downgrade the indicator here instead of leaving it stale-green.
          .on(LK.RoomEvent.Reconnecting, () => {
            if (!cancelled) {
              // Only show the full-stage "Connecting…" overlay on the INITIAL
              // join. A mid-call blip must NOT flip to "joining" — that painted an
              // OPAQUE panel over the whole stage (the ~5-min blank the user saw).
              // Once connected, keep the last tiles rendered and rely on the subtle
              // top "Reconnecting…" pill (driven by netQuality below).
              if (!everConnectedRef.current) setPhase("joining");
              setNetQuality("lost");
            }
          })
          // Recovered: clear back to "unknown" so the next real measurement
          // shows, AND force-rebuild participant tiles. A reconnect can join us
          // back to a different SFU node whose remoteParticipants set differs
          // from what we cached; without re-running updateParticipants we'd
          // show ghost tiles for participants who left during the outage and
          // miss tiles for ones who joined.
          .on(LK.RoomEvent.Reconnected, () => {
            if (!cancelled) {
              setPhase("connected");
              setNetQuality("unknown");
              try {
                updateParticipants();
              } catch (_) {}
              // Re-pull whiteboard state (spatial re-applies via updateParticipants).
              setWbResyncNonce((n) => n + 1);
              // MIC-04: re-apply mute/cam intent AFTER reconnect. LiveKit's internal
              // reconnect re-publishes local tracks regardless of prior mute state,
              // so a user who was muted would leak audio until they toggled again.
              // micIntentRef/camIntentRef are ref mirrors that always hold the
              // current intent, safe to read from this closure.
              const lp = room && room.localParticipant;
              if (lp) {
                Promise.resolve(lp.setMicrophoneEnabled(micIntentRef.current)).catch(() => {});
                Promise.resolve(lp.setCameraEnabled(camIntentRef.current)).catch(() => {});
              }
              // MIC-02: re-report intent so the server re-asserts it against
              // whatever tracks the reconnect just re-published (the server runs
              // its own delayed re-check to catch a slow re-publish).
              if (room)
                api.reportMuteState(token, room.name, !micIntentRef.current).catch(() => {});
            }
          });

        if (diag)
          diag.log("Room Join Attempt", {
            wsUrl: preferSecureWsUrl(res.wsUrl),
            meetingId,
          });
        await room.connect(preferSecureWsUrl(res.wsUrl), res.token);
        everConnectedRef.current = true;
        if (diag) {
          diag.attach(room, LK);
          diag.log("Room Joined", { meetingId });
        }
        rejoinAttemptsRef.current = 0;
        // Meeting media E2EE: seed the shared epoch key for all attendees then
        // enable insertable-streams encryption. Best-effort — any failure falls
        // back to unencrypted media so the meeting is never dropped. Gated on the
        // MEDIA E2EE flag (not chat E2EE): while media E2EE is off, skip the
        // getCallMediaKey/ensureGroupKey round-trips entirely instead of minting a
        // key enableRoomE2EE would discard (needless join latency + error noise).
        if (isCallMediaE2EEOn()) {
          try {
            const convKey =
              meetingConversationId || "meeting:" + meetingId;
            const mk = await getCallMediaKey(
              token,
              convKey,
              meetingAttendeeIds || [],
            );
            await enableRoomE2EE(room, mk);
          } catch (_) {}
        }
        if (cancelled) {
          try {
            room.disconnect();
          } catch (_) {}
          return;
        }
        // pagehide / beforeunload: synchronously tell the SFU the participant
        // is gone instead of leaving a 15-90s ghost tile for everyone else.
        // pagehide is the only event mobile browsers fire reliably; beforeunload
        // is the desktop belt+braces. disconnect(true) sends a Leave frame.
        const onPageHide = () => {
          try {
            roomRef.current && roomRef.current.disconnect(true);
          } catch (_) {}
        };
        window.addEventListener("pagehide", onPageHide);
        window.addEventListener("beforeunload", onPageHide);
        connectCleanupRef.current = () => {
          window.removeEventListener("pagehide", onPageHide);
          window.removeEventListener("beforeunload", onPageHide);
          connectCleanupRef.current = null;
        };
        // Honor the pre-join device choice. CRITICAL: a device that fails to START
        // (mic/cam busy — held by Teams/Zoom/another tab — or a driver
        // NotReadableError, or denied permission) must NOT abort the join. These
        // run AFTER a successful room.connect(), so the media server is fine;
        // letting the exception reach the outer catch drops the user to the fatal
        // "network/firewall" screen where they can't even LISTEN. Guard each device
        // separately (mirrors the 1:1 call path): join with that device OFF, reflect
        // it on the toggle, and say so in device-specific terms.
        if (initialMic !== false) {
          try {
            await room.localParticipant.setMicrophoneEnabled(true);
          } catch (micErr: any) {
            if (!cancelled) {
              setMic(false);
              // Intent ref must follow the UI here, or the reconnect re-apply
              // and the mic watchdog would keep resurrecting a mic the dock
              // shows as muted — a live mic behind a muted button. The user
              // re-arms both by pressing unmute.
              micIntentRef.current = false;
              // Persistent product-owned guidance (banner), not a 4s toast — a
              // blocked mic at join is the "joined but silent, nothing works"
              // case; the banner spells out the exact OS checkpoints to fix it.
              setMediaGuidance(classifyMediaError(micErr, "microphone"));
            }
          }
        }
        if (initialCam || video) {
          try {
            await room.localParticipant.setCameraEnabled(true);
          } catch (camErr: any) {
            if (!cancelled) {
              setCam(false);
              camIntentRef.current = false; // same as the mic: intent follows the UI
              // Same as the mic: persistent banner with the exact OS checkpoints
              // instead of a transient toast, so a blocked camera at join isn't a
              // silent "joined with video off" dead end.
              setMediaGuidance(classifyMediaError(camErr, "camera"));
            }
          }
        }
        try {
          await room.startAudio();
        } catch (_) {}
        if (!cancelled) {
          setAudioBlocked(!room.canPlaybackAudio);
          setPhase("connected");
          updateParticipants();
        }
      } catch (e: any) {
        if (diag)
          diag.log("Media Error", { phase: "connect", err: e && e.message });
        if (!cancelled) {
          // NEVER surface the raw LiveKit error: its message embeds the full
          // ws:// URL including the access_token (a token leak in the UI, seen
          // as the JWT showing in the error banner). Categorize into a clean,
          // safe message. The token endpoint distinguishes 403 by reason:
          //   "locked"  → meeting is locked (lobby/lock policy)
          //   "removed" → host removed this user (eject sticks across re-mint)
          //   other 403 → not admitted yet (lobby pending)
          // 401 = auth/key mismatch; anything else = network/firewall/TURN.
          const _emsg = e && e.message ? String(e.message) : "";
          const _status =
            (e && (e.status || (e.response && e.response.status))) || 0;
          const _detail = (e && (e.detail || e.reason || e.code || "")) + "";
          const _turnAdv = diag ? diag.snapshot().turnAdvertised : true;
          setErr(
            e && e.name === "NotAllowedError"
              ? "Microphone/camera permission denied — allow access, then rejoin."
              : _status === 403 && /lock/i.test(_emsg + _detail)
                ? "This meeting is locked. Ask the host to unlock it or admit you."
                : _status === 403 && /remov|eject|kick/i.test(_emsg + _detail)
                  ? "You were removed from this meeting by the host."
                  : _status === 403
                    ? "You haven't been admitted to this meeting yet — the host will let you in."
                    : _status === 401 || /401|unauthor/i.test(_emsg)
                      ? "Couldn't authorize with the media server — please rejoin, or contact your admin if it persists."
                      : !_turnAdv
                        ? "Couldn't reach the meeting media server, and no TURN relay was available for your network."
                        : "Couldn't reach the meeting media server — usually a network or firewall issue. Retry, or switch networks.",
          );
          setPhase("disconnected");
        }
      }
    })();
    return () => {
      cancelled = true;
      clearTimeout(connectWatchdog);
      if (diag) diag.stop();
      // Tear down the pagehide/beforeunload listeners FIRST so a re-mount
      // can't double-register them.
      if (connectCleanupRef.current) {
        try {
          connectCleanupRef.current();
        } catch (_) {}
      }
      if (room) {
        lkDisconnectingRef.current = (async () => {
          try {
            await room.disconnect();
          } catch (_) {}
          await new Promise((r) => setTimeout(r, 500));
        })();
      }
      tilesCurrent.forEach((v) => {
        try {
          v.track && v.track.detach().forEach((e: any) => e.remove());
        } catch (_) {}
      });
      tilesCurrent.clear();
      if (audioCurrent) audioCurrent.innerHTML = "";
      roomRef.current = null;
    };
  }, [meetingId, token, offline, video, retryKey]);

  useEffect(() => {
    // Guard: in an insecure context navigator.mediaDevices is undefined; touching
    // it here would throw and break the whole MeetingStage render.
    const md: any =
      typeof navigator !== "undefined" ? navigator.mediaDevices : null;
    if (!md || !md.enumerateDevices) return;
    md.enumerateDevices()
      .then((ds) => {
        const mics = ds.filter((d) => d.kind === "audioinput");
        const cams = ds.filter((d) => d.kind === "videoinput");
        const speakers = ds.filter((d) => d.kind === "audiooutput");
        setDevices({ mics, cams, speakers });
        // Prefer the user's saved device (Settings) so the picker reflects what's
        // actually capturing; fall back to the first enumerated device.
        const sx = settings || {};
        if (!selMic && (sx.micId || mics.length))
          setSelMic(sx.micId || mics[0].deviceId);
        if (!selCam && (sx.cameraId || cams.length))
          setSelCam(sx.cameraId || cams[0].deviceId);
        if (!selSpk && (sx.speakerId || speakers.length))
          setSelSpk(sx.speakerId || speakers[0].deviceId);
      })
      .catch(() => {});
    const handler = () => {
      md.enumerateDevices()
        .then((ds) => {
          setDevices({
            mics: ds.filter((d) => d.kind === "audioinput"),
            cams: ds.filter((d) => d.kind === "videoinput"),
            speakers: ds.filter((d) => d.kind === "audiooutput"),
          });
        })
        .catch(() => {});
    };
    md.addEventListener("devicechange", handler);
    return () => md.removeEventListener("devicechange", handler);
  }, []);

  // Selective VIDEO subscription for large rooms. `visible` = the set of tile
  // pids whose video should stay subscribed; pass null to subscribe everyone
  // (small rooms / focus modes restore). Audio publications are never touched —
  // you must always hear off-screen speakers; only expensive video is gated.
  const applyVideoSubscription = useCallback((visible: Set<string> | null) => {
    const room = roomRef.current;
    const remotes = room && (room.remoteParticipants || room.participants);
    if (!remotes) return;
    remotes.forEach((p: any) => {
      const pubs = p.trackPublications || p.videoTrackPublications;
      pubs &&
        pubs.forEach((pub: any) => {
          if (!pub || pub.kind !== "video") return; // audio always subscribed
          const isScreen =
            pub.source === "screen_share" || pub.source === "screen";
          const pid = p.sid + (isScreen ? ":screen" : "");
          const want = visible ? visible.has(pid) : true;
          // setSubscribed re-sends an UpdateSubscription frame on EVERY call (it is
          // NOT a no-op when unchanged), and this runs on every track event — so
          // gate on the current desired state to avoid flooding the SFU in large
          // meetings. subscriptionStatus is "subscribed" | "desired" | "unsubscribed".
          const status = pub.subscriptionStatus;
          const already = status
            ? want
              ? status !== "unsubscribed"
              : status === "unsubscribed"
            : !!pub.isSubscribed === want;
          if (!already && pub.setSubscribed) {
            try {
              pub.setSubscribed(want);
            } catch (_) {
              /* ignore */
            }
          }
        });
    });
  }, []);

  // Apply view mode + expanded styling + gallery pagination + selective
  // subscription. Single source of truth for which tiles show and which video
  // tracks stay subscribed.
  useEffect(() => {
    if (!stageRef.current) return;
    const stage = stageRef.current as HTMLElement;

    // Query from the whole meeting root, not just the stage — in speaker view the
    // non-prominent tiles are relocated INTO the People panel (outside the stage),
    // so a stage-only query would lose track of them and orphan their DOM.
    const tileRoot = (stage.closest(".ms-wrap") as HTMLElement) || stage;
    // Live sids straight from the room, so the tilesRef Map (which lags by up to
    // the 100ms disconnect debounce) can't resurrect a ghost tile for someone who
    // already left during a layout pass.
    const _room = roomRef.current;
    const _remotes = _room && (_room.remoteParticipants || _room.participants);
    const _live = new Set<string>();
    if (_remotes && typeof _remotes.forEach === "function")
      _remotes.forEach((p: any) => {
        if (p && p.sid) _live.add(p.sid);
      });
    if (_room && _room.localParticipant && _room.localParticipant.sid)
      _live.add(_room.localParticipant.sid);
    const allTiles = () => {
      // Union the DOM query with the tilesRef Map. In speaker view the relocated
      // tiles live inside the conditionally-mounted People panel, so when the panel
      // unmounts (close) those tiles DETACH from the document — a DOM-only query
      // could never re-discover them, leaving the grid empty on re-open. The Map
      // keeps live references, so detached-but-alive tiles are still found and
      // re-appended to their correct home on the next layout pass.
      const fromDom = Array.from(
        tileRoot.querySelectorAll("[data-pid]"),
      ) as HTMLElement[];
      const fromMap = (Array.from(tilesRef.current.values())
        .map((e: any) => e && e.tile)
        .filter(Boolean) as HTMLElement[]).filter((t) =>
        _live.size === 0
          ? true
          : _live.has(
              String((t && t.dataset && t.dataset.pid) || "").split(":")[0],
            ),
      );
      return Array.from(new Set<HTMLElement>([...fromDom, ...fromMap]));
    };
    const resetTile = (t: HTMLElement) => {
      t.classList.remove(
        "ms-tile-expanded",
        "ms-tile-minimized",
        "ms-tile-paged-out",
        "ms-tile-pg-hidden",
        "ms-tile-railed",
        "ms-tile-spotlit",
      );
      clearRailTile(t);
      t.style.flex = "";
      t.style.width = "";
      t.style.height = "";
      t.style.maxWidth = "";
      t.style.maxHeight = "";
    };

    // ── Speaker view: treat the active speaker (or screen-share presenter) as
    //     a prominent tile — displays large at top, rest in a thumbnail strip.
    //     User-initiated pins take priority over auto-speaker. When nobody is
    //     actively speaking, default to the first remote tile so speaker view
    //     always looks distinct from gallery (not a flat equal grid). ──
    // A share living in a pop-out window is not on the stage: drop its tile from
    // the layout altogether so the stage returns to its DEFAULT view (the
    // viewer's gallery / speaker layout) rather than holding the main slot with a
    // dead card. The tile stays in the DOM — hidden, still subscribed, still
    // feeding the pop-out and the recording composite — and rejoins the layout
    // the moment the window closes.
    //
    // ANTI-MIRROR (the "hall of mirrors"): while YOU are sharing, other people's
    // screen shares are not rendered on your stage. A loop needs a CYCLE — your
    // captured screen shows their share, theirs shows yours — and every node in
    // that cycle has to be both sharing and rendering. Suppressing your own
    // preview (done at TrackSubscribed) only breaks the 1-node cycle; two people
    // sharing at once still mirrored each other forever, which is exactly the
    // recursion in the bug report. A sharer that renders NO remote share cannot
    // be part of any cycle at any depth, so this closes it for good — including
    // for three or more presenters, and whether the surface shared is a monitor,
    // a window or a tab (all three can contain the CoLab window).
    // The rule itself lives in lib/stageVisibility — pure, shared with the call
    // path, and covered by backend/app/test/stage-visibility.test.ts so the
    // invariant cannot be edited away by accident.
    let mirrorGuarded = 0;
    const everyTile0 = allTiles().filter((t) => {
      const { poppedOut, mirrorGuard } = hiddenReasons(
        {
          pid: t.dataset.pid || "",
          isScreen: t.dataset.screen === "true",
          isLocal: t.dataset.local === "true",
        },
        { localIsSharing: screen, poppedOutPids: poppedOutPids },
      );
      t.classList.toggle("ms-tile-popped-hidden", poppedOut);
      // display:none also lets adaptiveStream drop the subscription, so the
      // frames are not even decoded while they are suppressed.
      t.classList.toggle("ms-tile-mirror-guarded", mirrorGuard);
      if (mirrorGuard) mirrorGuarded++;
      return !poppedOut && !mirrorGuard;
    });
    setMirrorGuardedCount((prev) => (prev === mirrorGuarded ? prev : mirrorGuarded));
    // "Hide participants without video": camera-off REMOTE people leave the stage
    // (they stay in People, and their audio is untouched). Never applied when it
    // would empty the stage — if nobody remote has video, everyone stays.
    const isNoVideoRemote = (t: HTMLElement) =>
      t.dataset.local !== "true" && t.dataset.screen !== "true" && !tileHasVideo(t);
    const dropNoVideo =
      viewPrefs.hideNoVideo &&
      everyTile0.some((t) => t.dataset.local !== "true" && !isNoVideoRemote(t));
    const everyTile = everyTile0.filter((t) => {
      const hide = dropNoVideo && isNoVideoRemote(t);
      t.classList.toggle("stage-tile-hidden", hide);
      if (hide) clearRailTile(t);
      return !hide;
    });
    // Self-view preferences are STAGE-level classes (CSS does the rest), so no
    // branch below has to remember to re-apply them to whichever tile is cornered.
    stage.classList.toggle("hide-self-pip", viewPrefs.hideSelf);
    for (const c of ["br", "bl", "tr", "tl"])
      stage.classList.toggle("pip-corner-" + c, viewPrefs.pipCorner === c);
    // Ordering facts: whose hand is up (hands are keyed by USER id, tiles by sid).
    const handSids = new Set(
      participants.filter((p: any) => raisedHands.includes(p.userId)).map((p: any) => p.sid),
    );
    const rankCtx = {
      pinned: (pid: string) => pinnedSids.includes(pid),
      handRaised: (t: HTMLElement) => handSids.has(String(t.dataset.pid || "").split(":")[0]),
      speakerPid: activeSpeakerSid,
    };
    for (const t of everyTile0)
      setTileHand(t, t.dataset.screen !== "true" && rankCtx.handRaised(t));
    // VIEW-09: resolve the spotlighted USER ids to the sids of their live tiles.
    // A spotlighted person who left simply resolves to nothing (graceful no-op),
    // and the local "Return to my view" escape disables the whole set here.
    const spotlightSet = new Set<string>();
    if (!spotlightEscaped && spotlightUids.length && roomRef.current) {
      const r0: any = roomRef.current;
      const all = [r0.localParticipant, ...Array.from(r0.remoteParticipants?.values?.() || [])];
      for (const p of all) {
        if (p && p.identity && spotlightUids.includes(baseUid(p.identity)) && p.sid)
          spotlightSet.add(p.sid);
      }
    }
    // MINIMISED (app PiP dock): the dock is thumbnail-sized, so show exactly ONE
    // full-bleed tile — a remote screen share, else whoever is speaking, else a
    // remote with their camera on, else any remote, else you. The full grid used
    // to be squeezed in here (the `pip` prop was passed down but never read).
    // Mirrors the call path's PiP branch (useCallSessionMedia.relayoutGrid).
    if (pip) {
      const isRemote = (t: HTMLElement) => t.dataset.local !== "true";
      const hasVideo = (t: HTMLElement) => !!t.querySelector("video");
      const pick =
        everyTile.find((t) => isRemote(t) && t.dataset.screen === "true") ||
        everyTile.find((t) => isRemote(t) && t.dataset.pid === activeSpeakerSid) ||
        everyTile.find((t) => isRemote(t) && hasVideo(t)) ||
        everyTile.find(isRemote) ||
        everyTile[0] ||
        null;
      if (msPinAreaRef.current && msPinAreaRef.current.parentElement) msPinAreaRef.current.remove();
      if (msStripRef.current && msStripRef.current.parentElement) msStripRef.current.remove();
      stage.style.display = "grid";
      stage.style.flexDirection = "";
      layoutRail(stage, []);
      for (const t of everyTile) {
        resetTile(t);
        t.classList.remove("ms-tile-self-pip", "ms-tile-pinned", "ms-tile-spotlit");
        delete t.dataset.pip;
        if (t.onclick === onPipTileClick) {
          t.onclick = null;
          t.title = "";
        }
        t.classList.toggle("ms-tile-railed", t !== pick);
        if (t.parentElement !== stage) stage.appendChild(t);
      }
      applyTileGrid(stage, 1, 1);
      applyVideoSubscription(new Set(pick ? [pick.dataset.pid || ""] : []));
      setPageCount(1);
      return;
    }
    // Skype/Teams self-view: your own CAMERA tile never occupies the main stage —
    // it floats as a small picture-in-picture. Three deliberate exceptions: alone
    // in the meeting (nothing else to show), your SELF SCREEN-SHARE tile
    // (data-screen="true" — that placeholder stays a normal stage tile), and when
    // you have explicitly pinned yourself via "Pin for me".
    const selfTile =
      everyTile.find(
        (t) => t.dataset.local === "true" && t.dataset.screen !== "true",
      ) || null;
    const selfPid = (selfTile && selfTile.dataset.pid) || "";
    // LAYOUTS MUST LOOK DIFFERENT (Windows/Mac web report: "Layout is not
    // changed"). With two people in the room, cornering the self-view in EVERY
    // layout made Speaker, bottom-strip, Gallery and Focus all render the same
    // picture — one big tile + your PiP — so the Layout menu appeared broken.
    //   • Gallery: "everyone in an equal grid" — the self tile is a grid cell.
    //   • Speaker / bottom strip: when you are the ONLY other person, your tile
    //     rides the strip (right / bottom) so the strip isn't empty and the
    //     two layouts differ from each other and from Focus.
    //   • Focus: unchanged — corner PiP, no strip.
    // "Hide my own preview" still wins: the hidden PiP is the only way to not
    // show yourself, so that preference keeps the corner placement.
    const othersOnStage = everyTile.filter((t) => t !== selfTile).length;
    const selfTakesStageCell =
      !viewPrefs.hideSelf &&
      (viewMode === "gallery" ||
        ((viewMode === "speaker" || viewMode === "speaker-bottom") &&
          othersOnStage === 1 &&
          !viewPrefs.focusContent));
    const selfPipEligible =
      !!selfTile &&
      everyTile.length > 1 &&
      !selfTakesStageCell &&
      !pinnedSids.includes(selfPid) &&
      // A spotlighted self occupies the main stage (the organizer forced it
      // large for everyone — including you), never the corner PiP.
      !spotlightSet.has(selfPid);
    // Switch mode: normally YOU are cornered; when swapped, corner the primary
    // remote camera instead and let your tile take the main stage. Never corner a
    // screen share (that's the point of the meeting) — with no remote camera to
    // trade with, fall back to cornering yourself.
    let selfPip: HTMLElement | null = selfPipEligible ? selfTile : null;
    if (selfPip && pipSwap) {
      // Corner an UNPINNED remote camera. A PINNED tile is a "keep this on the
      // main stage" request that outranks the swap — so if the only remote is
      // pinned we corner YOU again (swap becomes a no-op) rather than fighting
      // the pin. This is also what makes pinning the cornered person promote
      // them: they leave the corner and you take it.
      const remoteCam = everyTile.find(
        (t) =>
          t !== selfTile &&
          t.dataset.screen !== "true" &&
          !pinnedSids.includes(t.dataset.pid || ""),
      );
      selfPip = remoteCam || selfPip;
    }
    // The tiles that actually compete for stage space (grid math, prominent/rail
    // logic) — the floating self-view is excluded from all of it.
    const stageTiles = selfPip
      ? everyTile.filter((t) => t !== selfPip)
      : everyTile;
    for (const t of everyTile) {
      const isPip = t === selfPip;
      t.classList.toggle("ms-tile-self-pip", isPip);
      if (isPip) {
        t.dataset.pip = "true";
        // The PiP is excluded from the branches that un-hide stage tiles, so
        // clear any hide class here or a self-view carrying a stale
        // ms-tile-railed / ms-tile-paged-out (display:none) would vanish —
        // and a stale ms-tile-spotlit from a just-removed spotlight of YOU
        // would keep the amber outline on the corner PiP forever.
        t.classList.remove("ms-tile-railed", "ms-tile-paged-out", "ms-tile-spotlit");
        // The self tile can arrive here straight from the strip (Speaker →
        // Focus): drop the strip's inline left/top/size so the PiP snaps to its
        // corner instead of floating where the strip thumbnail was.
        clearRailTile(t);
        // Tap-to-swap affordance (see Switch mode above).
        t.onclick = onPipTileClick;
        t.title = pipSwap ? "Switch back to their view" : "Switch to your view · drag to move";
        // Drag to any corner (snaps; remembered). A tap still swaps.
        enablePipDrag(t, () => stageRef.current, (c) => setViewPref({ pipCorner: c }));
      } else {
        delete t.dataset.pip;
        if (t.onclick === onPipTileClick) {
          t.onclick = null;
          t.title = "";
        }
      }
    }
    // Fallback featured tile: first non-local tile (skip screen-share tiles so
    // a camera tile is preferred as the default focal point).
    const defaultSpeakerPid =
      speakerStyle && everyTile.length > 1
        ? (everyTile.find(
            (t) => t.dataset.local !== "true" && t.dataset.screen !== "true",
          )?.dataset.pid ?? everyTile.find((t) => t.dataset.local !== "true")?.dataset.pid ?? null)
        : null;
    // BA/CEO #4: a LIVE screen share is ALWAYS the main stage — in ANY view mode
    // (gallery included), never a secondary equal tile. It wins over the auto
    // active-speaker focal.
    // All live screen-share tiles in DOM (join) order — newest last.
    // All REMOTE live screen-share tiles in DOM (join) order — newest last.
    // The local self-screen placeholder (data-local="true") is already rendered
    // in the grid with "You're sharing your screen"; exclude it here so it never
    // displaces a remote share from the main-stage spotlight.
    const screenPidsAll = everyTile
      .filter((t) => t.dataset.screen === "true" && t.dataset.local !== "true")
      .map((t) => t.dataset.pid || "")
      .filter(Boolean);
    // Which screen(s) fill the stage. 0 → none; 1 → that one (UNCHANGED — the
    // single-share common case is byte-identical to before). 2+ → the LOCAL
    // viewer's choice via the switcher: side-by-side (all shares) or spotlight
    // (the focused one, defaulting to the newest); the rest drop to thumbnails.
    let promotedScreenPids: string[] = [];
    if (screenPidsAll.length === 1) {
      promotedScreenPids = [screenPidsAll[0]];
    } else if (screenPidsAll.length >= 2) {
      if (screenViewMode === "sideBySide") {
        promotedScreenPids = screenPidsAll.slice();
      } else {
        const focus =
          focusedScreenPid && screenPidsAll.includes(focusedScreenPid)
            ? focusedScreenPid
            : screenPidsAll[screenPidsAll.length - 1];
        promotedScreenPids = [focus];
      }
    }
    const screenPid = promotedScreenPids[0] || null;
    const pipPid = (selfPip && selfPip.dataset.pid) || "";
    const speakerPid =
      screenPid ||
      (speakerStyle
        ? // Swapped yourself into the main view → you're the featured tile;
          // otherwise the presenter / active speaker / first remote.
          pipSwap && selfPid && selfPid !== pipPid
          ? selfPid
          : presenterId || activeSpeakerSid || defaultSpeakerPid
        : null);
    // Participant view: the focal + any pins fill the stage; EVERYONE ELSE is
    // hidden on the stage and shown in the People panel roster instead
    // (Teams-style — the roster IS the participant labels, no in-stage rail
    // chips). Gallery view = the (multi-) pinned set fills, rest hidden — UNLESS a
    // screen share is live, which is promoted to the focal tile regardless of view.
    // VIEW-09: an active spotlight OVERRIDES the viewer's own choice — the
    // spotlighted tiles (plus any live screen share, which always stays focal)
    // fill the stage; the viewer's pins are RETAINED but not shown until the
    // spotlight ends or they hit "Return to my view" (acceptance §1.3).
    const prominentPids = new Set<string>(
      spotlightSet.size
        ? [...spotlightSet, ...promotedScreenPids]
        : promotedScreenPids.length
          ? [...pinnedSids, ...promotedScreenPids]
          : speakerStyle
            ? [...pinnedSids, ...(speakerPid ? [speakerPid] : [])]
            : pinnedSids,
    );
    // The cornered PiP never competes for the main stage — it isn't in stageTiles,
    // so leaving its pid here would count toward hasProminent and strand an empty
    // stage (e.g. a swapped-out remote that was pinned or the active speaker).
    if (pipPid) prominentPids.delete(pipPid);
    const hasProminent =
      prominentPids.size > 0 && stageTiles.length > prominentPids.size;

    if (hasProminent) {
      // Dissolve any leftover pin-area / rail from an older layout.
      if (msPinAreaRef.current && msPinAreaRef.current.parentElement)
        msPinAreaRef.current.remove();
      if (msStripRef.current && msStripRef.current.parentElement)
        msStripRef.current.remove();
      stage.classList.remove("ms-expanded-mode", "ms-speaker-mode");
      stage.style.display = "grid";
      stage.style.flexDirection = "";
      const shown: HTMLElement[] = [];
      const others: HTMLElement[] = [];
      for (const t of stageTiles) {
        resetTile(t);
        const pid = t.dataset.pid || "";
        if (prominentPids.has(pid)) {
          t.classList.remove("ms-tile-railed");
          // Outline only for EXPLICIT pins, not the auto active-speaker focal;
          // spotlit tiles get their own badge (VIEW-09). While a spotlight is
          // active the pin set isn't rendered, so the pin outline stays off.
          t.classList.toggle(
            "ms-tile-pinned",
            !spotlightSet.size && pinnedSids.includes(pid),
          );
          t.classList.toggle("ms-tile-spotlit", spotlightSet.has(pid));
          if (t.parentElement !== stage) stage.appendChild(t);
          shown.push(t);
        } else {
          // Not a main tile → the thumbnail RAIL (below), or hidden when the
          // viewer chose "Focus on content". Tile stays MOUNTED so audio is
          // unaffected either way.
          t.classList.remove("ms-tile-pinned", "ms-tile-spotlit");
          t.classList.add("ms-tile-railed");
          if (t.parentElement !== stage) stage.appendChild(t);
          others.push(t);
        }
      }
      // RAIL: everyone who isn't a main tile rides a vertical strip on the right,
      // INSIDE the stage — speaker first, then hands, then cameras. Whoever
      // doesn't fit stays hidden behind a "+N" chip (they are in People).
      // Focus view (or the "Focus on content" preference) turns the strip off;
      // the bottom-strip layout moves it to the stage floor.
      const rail = layoutRail(
        stage,
        viewPrefs.focusContent || viewMode === "focus"
          ? []
          : sortByRank(others, (t) => railRank(t, rankCtx)),
        { side: railSideFor(viewMode) },
      );
      for (const t of rail.shown) t.classList.remove("ms-tile-railed");
      // Float the self-view over the prominent layout (e.g. while screen sharing:
      // the share is focal, your camera drops to the corner). resetTile leaves
      // ms-tile-self-pip intact; re-adding it is defensive.
      if (selfPip) {
        resetTile(selfPip);
        selfPip.classList.add("ms-tile-self-pip");
        if (selfPip.parentElement !== stage) stage.appendChild(selfPip);
      }
      const n = Math.max(1, shown.length);
      const cols = Math.ceil(Math.sqrt(n));
      const rows = Math.ceil(n / cols);
      // CEO: equal-size tiles; a partial last row is CENTRED, never stretched.
      applyTileGrid(stage, cols, rows);
      // Subscribe video only for the shown tiles (audio stays on for everyone).
      const visiblePids = new Set(
        [...shown, ...rail.shown].map((t) => t.dataset.pid || ""),
      );
      // The cornered self-view PiP is shown too, so keep its video subscribed —
      // in switch mode it's a REMOTE, and it isn't in `shown`, so without this it
      // would be unsubscribed and the corner would blank to an avatar. (When it's
      // your own local tile, pipPid isn't in the remote-participant loop, so this
      // is a harmless no-op.)
      if (pipPid) visiblePids.add(pipPid);
      applyVideoSubscription(
        everyTile.length > GALLERY_PAGE_SIZE ? visiblePids : null,
      );
      setPageCount(1);
      return;
    }


    // Not in two-zone pin mode → dissolve the pin containers (if any) and put all
    // tiles back as DIRECT children before the gallery/speaker logic runs.
    // A tile may be stray (in the People panel from speaker view, or in a pin
    // container) — pull ALL tiles back as direct stage children before gallery.
    const anyStray = everyTile.some((t) => t.parentElement !== stage);
    if (
      anyStray ||
      (msPinAreaRef.current && msPinAreaRef.current.parentElement) ||
      (msStripRef.current && msStripRef.current.parentElement)
    ) {
      for (const t of everyTile) {
        resetTile(t);
        if (t.parentElement !== stage) stage.appendChild(t);
      }
      // resetTile ran on the self tile too; re-mark it so it stays a corner PiP.
      if (selfPip) selfPip.classList.add("ms-tile-self-pip");
      if (msPinAreaRef.current) msPinAreaRef.current.remove();
      if (msStripRef.current) msStripRef.current.remove();
      stage.style.display = "";
      stage.style.flexDirection = "";
    }

    // The floating self-view never occupies a gallery grid cell.
    const tiles = (Array.from(stage.children) as HTMLElement[]).filter(
      (t) => !!t.dataset.pid && t !== selfPip,
    );
    const big = tiles.length > GALLERY_PAGE_SIZE; // gate selective subscription

    // Gallery
    layoutRail(stage, []);
    tiles.forEach(clearRailTile);
    stage.classList.remove("ms-expanded-mode", "ms-speaker-mode");
    stage.style.display = "";       // undo flex from speaker / pin
    stage.style.flexDirection = "";
    tiles.forEach((c) =>
      // Un-hide any tiles that were hidden by Participant view (ms-tile-railed).
      c.classList.remove("ms-tile-expanded", "ms-tile-minimized", "ms-tile-railed", "ms-tile-pinned", "ms-tile-spotlit"),
    );

    if (big) {
      // Screen shares, then the local tile / a pinned tile, rank first so they
      // always land on page 1; everyone else keeps stable join (DOM) order so
      // tiles don't reshuffle as people speak.
      // …then raised hands, then people with their camera on (lib/stageView
      // galleryRank). All slow-changing facts and a STABLE sort, so pages still
      // don't reshuffle as people speak.
      const ordered = sortByRank(tiles, (el) => galleryRank(el, rankCtx));
      const pages = Math.ceil(ordered.length / GALLERY_PAGE_SIZE);
      const cur = Math.min(Math.max(0, page), pages - 1);
      const slice = ordered.slice(
        cur * GALLERY_PAGE_SIZE,
        cur * GALLERY_PAGE_SIZE + GALLERY_PAGE_SIZE,
      );
      const vis = new Set(slice.map((el) => el.dataset.pid || ""));
      tiles.forEach((el) =>
        el.classList.toggle(
          "ms-tile-paged-out",
          !vis.has(el.dataset.pid || ""),
        ),
      );
      const n = Math.max(1, vis.size);
      const cols = Math.ceil(Math.sqrt(n));
      const rows = Math.ceil(n / cols);
      // CEO: equal-size tiles; a partial last row is CENTRED, never stretched.
      applyTileGrid(stage, cols, rows);
      // Grid math uses `vis` (paged tiles only); subscription must ALSO keep the
      // cornered self-view PiP's video — in switch mode it's a remote that's off
      // the current page but still shown in the corner. Kept out of `vis` so it
      // doesn't add a phantom grid cell.
      applyVideoSubscription(pipPid ? new Set(vis).add(pipPid) : vis);
      setPageCount(pages);
      if (cur !== page) setPage(cur);
    } else {
      tiles.forEach((el) => el.classList.remove("ms-tile-paged-out"));
      // Gallery: count-aware ceil(sqrt(n)) so every participant fits the
      // viewport without scrolling, regardless of N. Count actual tiles (which
      // include a presenter's dedicated "<sid>:screen" tile) — participants.length
      // would undercount and clip the screen-share tile out of the grid.
      const n = Math.max(1, tiles.length);
      const cols = n <= 1 ? 1 : Math.ceil(Math.sqrt(n));
      const rows = n <= 1 ? 1 : Math.ceil(n / cols);
      // CEO: equal-size tiles; a partial last row is CENTRED, never stretched.
      applyTileGrid(stage, cols, rows);
      applyVideoSubscription(null);
      setPageCount(1);
      if (page !== 0) setPage(0);
    }
  }, [
    pinnedSids,
    spotlightUids,
    spotlightEscaped,
    viewMode,
    pipSwap,
    onPipTileClick,
    presenterId,
    activeSpeakerSid,
    participants,
    page,
    applyVideoSubscription,
    focusedScreenPid,
    screenViewMode,
    poppedOutPids,
    screen,
    visRegainNonce,
    pip,
    galleryPageSize,
    viewPrefs,
    raisedHands,
    stageSizeNonce,
  ]);

  // Re-fit the rail when the stage box changes size (window resize, side panel
  // open/close). Debounced; the layout effect depends on the nonce.
  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let t: any = null;
    const ro = new ResizeObserver(() => {
      if (t) clearTimeout(t);
      t = setTimeout(() => setStageSizeNonce((n) => n + 1), 120);
    });
    ro.observe(el);
    return () => {
      if (t) clearTimeout(t);
      ro.disconnect();
    };
  }, [phase]);

  // Blank-stage-after-popout fix. `adaptiveStream: true` lets livekit-client
  // auto-unsubscribe remote video whose elements are hidden — INCLUDING when
  // the whole tab is hidden. Popping the shared content into a Document-PiP
  // window on a SECOND MONITOR backgrounds the main tab, so the SDK drops every
  // remote camera; and there was no re-subscribe when the tab came back, so a
  // viewer returning after the share ended saw an all-blank stage. On
  // visibility-regain, re-run the layout (which re-applies the correct
  // per-view subscription set) once the tab is genuinely visible so the manual
  // re-subscribe and adaptiveStream agree; a second pass a beat later covers
  // adaptiveStream re-evaluating element visibility on the next frame.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVis = () => {
      if (document.visibilityState !== "visible") return;
      setVisRegainNonce((n) => n + 1);
      setTimeout(() => setVisRegainNonce((n) => n + 1), 400);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  // Mirror the SDK's real microphone state into the control-bar toggle. Called
  // for every TrackMuted/TrackUnmuted so a host-initiated (server) mute moves
  // the dock button too, not just the tile badge. Reads isMicrophoneEnabled
  // rather than inferring from the event, so it stays correct no matter which
  // side triggered the change. Only reacts to OUR OWN microphone track.
  const syncLocalMicState = (pub: any, part: any) => {
    try {
      const room = roomRef.current;
      if (!room || !part || !part.isLocal) return;
      // MICROPHONE only. We share the presented tab's audio too, which is also
      // kind "audio", so a kind-only test would let a shared tab drive the mic
      // state. Fall back to kind only when the publication reports no source.
      if (pub) {
        if (pub.source ? pub.source !== "microphone" : pub.kind !== "audio") return;
      }
      const live = !!room.localParticipant.isMicrophoneEnabled;
      setMic(live);
      // Being muted by a host was completely silent — the icon flipped with no
      // explanation of why your microphone stopped working. Only speak up when
      // WE didn't do it, so a normal self-mute stays quiet.
      if (!live && !selfMicChangeRef.current) {
        onToast &&
          onToast("The host muted you. You can unmute yourself when you need to speak.");
      }
    } catch (_) {
      /* best-effort UI sync — never break media handling */
    }
  };

  const syncOwnTile = () => {
    try {
      updateParticipantsRef.current && updateParticipantsRef.current();
    } catch (_) {
      /* best-effort: a badge refresh must never break the toggle */
    }
  };

  // Marks a mic change WE initiated, so syncLocalMicState can tell a self-mute
  // apart from a host mute and only explain the latter.
  const selfMicChangeRef = useRef(false);
  // One calm, persistent inline help strip when a device (mic/cam/screen) can't
  // open — classified into product-owned, OS-specific guidance (see mediaErrors).
  // Replaces the old blanket "close other apps" toast that misdiagnosed a macOS
  // permission block as a device conflict and left users with no real fix.
  const [mediaGuidance, setMediaGuidance] = useState<MediaGuidance | null>(null);
  const clearGuidance = (w: MediaGuidance["what"]) =>
    setMediaGuidance((g) => (g && g.what === w ? null : g));

  // MIC-22/23: mic health watchdog — a mic that dies mid-meeting (device yanked,
  // Bluetooth dropped, permission revoked, driver reset) must never be a silent
  // dead mic. The shared watchdog re-acquires it automatically with a visible
  // "Reconnecting your microphone…" and, after sustained failure, the same
  // persistent recovery banner a blocked mic at join gets. Also the moment the
  // room settles, report the initial mute intent so the server-side enforcement
  // (MIC-02) has it from the first second, not from the first toggle.
  useEffect(() => {
    if (phase !== "connected") return;
    if (roomRef.current)
      api.reportMuteState(token, roomRef.current.name, !micIntentRef.current).catch(() => {});
    const stop = startMicWatchdog({
      getRoom: () => roomRef.current,
      getIntent: () => micIntentRef.current,
      onStatus: (s) => {
        if (s.kind === "reconnecting") {
          trackEvent("mic.reacquire.attempt"); // §9.2
          if (s.attempt === 1) onToast && onToast("Reconnecting your microphone…");
        } else if (s.kind === "recovered") {
          trackEvent("mic.reacquire.recovered");
          clearGuidance("microphone");
          setSrAnnouncement(
            s.label ? `Microphone reconnected — using ${s.label}` : "Microphone reconnected",
          );
          onToast &&
            onToast(s.label ? `Microphone reconnected — using ${s.label}` : "Microphone reconnected");
        } else {
          // §9.1 Sev-1 visibility: a mic that could NOT be re-acquired.
          trackEvent("mic.reacquire.failed");
          captureIssue("media", "mic re-acquisition failed", {});
          setMediaGuidance(classifyMediaError(s.error, "microphone"));
        }
      },
    });
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const toggleMic = async () => {
    const n = !mic;
    // Turning the mic ON is what the policy restricts — muting yourself is
    // always allowed, whatever the host has set.
    if (n && !allowMic) {
      onToast && onToast("The host has turned off microphones for attendees.");
      return;
    }
    selfMicChangeRef.current = true;
    setTimeout(() => { selfMicChangeRef.current = false; }, 1500);
    setMic(n);
    micIntentRef.current = n; // MIC-04: keep ref in sync for reconnect handler
    const lp = roomRef.current && roomRef.current.localParticipant;
    if (!lp) return;
    // Revert the button + surface feedback if the device is busy/denied, instead
    // of showing "on" while publishing nothing.
    const micT0 = Date.now();
    try {
      await lp.setMicrophoneEnabled(n);
      // §9.2: mute/unmute latency, bucketed (content-free).
      const micMs = Date.now() - micT0;
      trackEvent("mic.toggle." + (n ? "on" : "off"));
      trackEvent(micMs < 200 ? "mic.latency.lt200" : micMs < 1000 ? "mic.latency.lt1000" : "mic.latency.slow");
      if (n) clearGuidance("microphone");
      // Refresh OUR OWN tile: LiveKit fires TrackMuted/TrackUnmuted for remote
      // participants, so a purely local mute/unmute left this tile's mic badge
      // showing the state it had at join time — the dock said live while the
      // tile still showed muted (and vice-versa).
      syncOwnTile();
      // MIC-02: tell the server, so a mute is ALSO enforced at the SFU (a client
      // bug can't leak audio past it). Fire-and-forget — a lost report never
      // affects the UI, and the local hard mute above already stopped capture.
      if (roomRef.current)
        api.reportMuteState(token, roomRef.current.name, !n).catch(() => {});
    } catch (err: any) {
      setMic(!n);
      micIntentRef.current = !n; // revert ref on failure too
      syncOwnTile();
      // §9.1 Sev-1 class: a mute toggle that FAILED and reverted is exactly the
      // reconciliation-failure signal — grouped server-side via error telemetry.
      captureIssue("media", "mic toggle failed and reverted", { wanted: n ? "on" : "off" });
      trackEvent("mic.reconcile.failed");
      if (n) setMediaGuidance(classifyMediaError(err, "microphone"));
    }
  };

  // ── Global shortcut: toggle mic mute (DESKTOP ONLY) ──────────────────────
  // The Electron shell's OS-wide CommandOrControl+Shift+M sends "toggle-mute".
  // We invoke the SAME toggleMic the meeting control bar uses (never a second
  // mute path) and only while the room is connected. A ref keeps the latest
  // closure so the subscription is set up once. Inert in the browser.
  const toggleMicRef = useRef(toggleMic);
  toggleMicRef.current = toggleMic;
  useEffect(() => {
    if (!isDesktopApp) return;
    const cd = (window as any).collabDesktop;
    if (!cd || typeof cd.onGlobalShortcut !== "function") return;
    const off = cd.onGlobalShortcut((payload: { action?: string }) => {
      if (payload && payload.action === "toggle-mute" && roomRef.current) {
        toggleMicRef.current();
      }
    });
    return typeof off === "function" ? off : undefined;
  }, []);

  const toggleCam = async () => {
    const n = !cam;
    if (n && !allowCam) {
      onToast && onToast("The host has turned off your camera.");
      return;
    }
    setCam(n);
    camIntentRef.current = n; // MIC-04: keep ref in sync for reconnect handler
    const lp = roomRef.current && roomRef.current.localParticipant;
    if (!lp) return;
    try {
      await lp.setCameraEnabled(n);
      if (n) clearGuidance("camera");
      syncOwnTile(); // same reason as the mic: local changes raise no remote event
    } catch (err: any) {
      setCam(!n);
      camIntentRef.current = !n; // revert ref on failure too
      syncOwnTile();
      if (n) setMediaGuidance(classifyMediaError(err, "camera"));
    }
  };
  const toggleScreen = async () => {
    const r = roomRef.current;
    if (!r) return;
    // Ignore repeat clicks while a START is in flight — but never block a STOP: a
    // live share must always be stoppable even if the pending flag got stranded.
    if (screenPending && !screen) return;
    const n = !screen;
    // Starting a share is what the host can switch off; stopping one is always
    // allowed (never trap someone in a share they can't end).
    if (n && !allowScreen) {
      onToast && onToast("The host has turned off screen sharing.");
      return;
    }
    // Do NOT flip `screen` here — the LocalTrackPublished/Unpublished handlers own
    // it (single source of truth). We only raise a PENDING spinner while starting.
    if (n) setScreenPending(true);
    try {
      // Best-effort tab/system audio capture; video share is unaffected if the
      // browser/user declines audio. Options are ignored on stop (n===false).
      const req = r.localParticipant.setScreenShareEnabled(n, {
        audio: true,
        systemAudio: "include",
      });
      // BA/CEO #3: bound the getDisplayMedia round-trip so a slow/hung picker
      // (common in the Electron shell) can never look infinite.
      await (n
        ? Promise.race([
            req,
            new Promise((_, rej) => setTimeout(() => rej(new Error("SCREEN_TIMEOUT")), 15000)),
          ])
        : req);
      if (n) clearGuidance("screen");
    } catch (e: any) {
      const name = (e && (e.name || e.message)) || "";
      if (name === "SCREEN_TIMEOUT") {
        // Force the share off so a late-resolving request can't strand us.
        try {
          await r.localParticipant.setScreenShareEnabled(false);
        } catch (_) {}
      } else if (name === "AbortError") {
        /* user cancelled the OS screen picker — benign, stay quiet */
      } else {
        // NotAllowedError on macOS is the Screen-Recording OS permission block
        // (indistinguishable from a plain deny) — NOT a benign cancel. Show the
        // exact System Settings checkpoints instead of silently doing nothing.
        setMediaGuidance(classifyMediaError(e, "screen"));
      }
      // NotAllowedError / AbortError = user cancelled the picker → silent recovery.
    } finally {
      setScreenPending(false); // publish event also clears it on the success path
    }
  };
  // Await + catch + persist + revert-on-failure, so a switch that fails (device
  // busy/removed, or audiooutput on a browser without setSinkId) gives feedback
  // instead of a silent unhandled rejection, and the choice carries to next time.
  const switchMic = async (deviceId: string) => {
    const prev = selMic;
    setSelMic(deviceId);
    try {
      await roomRef.current?.switchActiveDevice("audioinput", deviceId);
      onChangeSetting && onChangeSetting("micId", deviceId);
    } catch {
      setSelMic(prev);
      onToast && onToast("Couldn't switch microphone");
    }
  };
  const switchCam = async (deviceId: string) => {
    const prev = selCam;
    setSelCam(deviceId);
    try {
      await roomRef.current?.switchActiveDevice("videoinput", deviceId);
      onChangeSetting && onChangeSetting("cameraId", deviceId);
    } catch {
      setSelCam(prev);
      onToast && onToast("Couldn't switch camera");
    }
  };
  const switchSpeaker = async (deviceId: string) => {
    const prev = selSpk;
    const prevSink = spkSinkRef.current;
    setSelSpk(deviceId);
    // An explicit pick becomes the sink to apply (unlike the auto-picker default).
    spkSinkRef.current = deviceId;
    try {
      await roomRef.current?.switchActiveDevice("audiooutput", deviceId);
      onChangeSetting && onChangeSetting("speakerId", deviceId);
    } catch {
      setSelSpk(prev);
      spkSinkRef.current = prevSink;
      onToast && onToast("Couldn't switch speaker");
    }
  };

  const toggleHandRaise = useCallback(() => {
    if (!socket || !meetingId) return;
    const raising = !handRaised;
    // Hands ride the reactions policy (the server groups them the same way), so
    // raising is gated while LOWERING an already-raised hand always works —
    // otherwise turning reactions off would strand a raised hand up forever.
    if (raising && !allowReact) {
      onToast && onToast("The host has turned off reactions for attendees.");
      return;
    }
    setHandRaised(raising);
    socket.emit(
      raising ? EVENTS.MEETING_HAND_RAISE : EVENTS.MEETING_HAND_LOWER,
      { meetingId },
    );
  }, [socket, meetingId, handRaised, allowReact, onToast]);

  const sendReaction = useCallback(
    (emoji: string) => {
      if (!socket || !meetingId) return;
      if (!allowReact) {
        onToast && onToast("The host has turned off reactions for attendees.");
        setShowReactions(false);
        return;
      }
      socket.emit(EVENTS.MEETING_REACTION, { meetingId, emoji });
      setShowReactions(false);
    },
    [socket, meetingId, allowReact, onToast],
  );

  const sendChatMessage = useCallback(async () => {
    if (!socket || !meetingId) return;
    if (!allowChat) {
      onToast && onToast("The host has turned off chat for attendees.");
      return;
    }
    // A staged attachment sends with the typed text as its caption (preview-
    // then-send, matching the main chat composer).
    if (chatStaged) {
      setChatUploading(true);
      try {
        const desc = await api.uploadFile(token, chatStaged.file);
        socket.emit(EVENTS.MEETING_CHAT_SEND, {
          meetingId,
          text: chatDraft.trim(),
          file: desc,
        });
        if (chatStaged.url) URL.revokeObjectURL(chatStaged.url);
        setChatStaged(null);
        setChatDraft("");
        setChatEmoji(false);
      } catch {
        onToast && onToast("Couldn't upload the file");
      } finally {
        setChatUploading(false);
      }
      return;
    }
    if (!chatDraft.trim()) return;
    socket.emit(EVENTS.MEETING_CHAT_SEND, {
      meetingId,
      text: chatDraft.trim(),
    });
    setChatDraft("");
    setChatEmoji(false);
  }, [socket, meetingId, chatDraft, chatStaged, token, onToast]);

  // --- In-meeting chat extras: @mention, emoji, attachments ---
  const insertChatEmoji = useCallback((e: string) => {
    setChatDraft((d) => d + e);
    setChatEmoji(false);
    chatInputRef.current && chatInputRef.current.focus();
  }, []);

  // Shared @-mention behaviour (keyboard-navigable, Esc-dismiss) resolved against
  // the meeting participants — same hook the in-call chat uses.
  const mentions = useInlineMentions({
    draft: chatDraft,
    setDraft: setChatDraft,
    people: participants,
    inputRef: chatInputRef,
  });

  const onChatFile = useCallback(
    (e: any) => {
      const f = e.target.files && e.target.files[0];
      if (e.target) e.target.value = "";
      if (!f) return;
      // Drag-drop and paste also land here — a guest has no upload permission.
      if (isGuest) {
        onToast && onToast("File sharing isn't available to guests.");
        return;
      }
      if (f.size > 2 * 1024 * 1024 * 1024) {
        onToast && onToast("File is too large (max 2 GB)");
        return;
      }
      // Stage for a preview + caption instead of sending immediately.
      setChatStaged((prev) => {
        if (prev && prev.url) URL.revokeObjectURL(prev.url);
        const isImage = (f.type || "").startsWith("image/");
        return { file: f, url: isImage ? URL.createObjectURL(f) : "", isImage };
      });
      chatInputRef.current && chatInputRef.current.focus();
    },
    [onToast],
  );

  const clearChatStaged = useCallback(() => {
    setChatStaged((prev) => {
      if (prev && prev.url) URL.revokeObjectURL(prev.url);
      return null;
    });
  }, []);
  // Revoke a staged object URL if the meeting unmounts mid-compose.
  const chatStagedRef = useRef(chatStaged);
  chatStagedRef.current = chatStaged;
  useEffect(
    () => () => {
      const s = chatStagedRef.current;
      if (s && s.url) URL.revokeObjectURL(s.url);
    },
    [],
  );

  const lowerHand = useCallback(
    (userId: string) => {
      if (!socket || !meetingId) return;
      socket.emit(EVENTS.MEETING_HAND_LOWER, { meetingId, userId });
    },
    [socket, meetingId],
  );

  const toggleFullscreen = () => {
    const el = stageRef.current?.closest(".ms-wrap") as HTMLElement;
    if (!fsElement()) { if (el) fsRequest(el); } else fsExit();
  };

  // People-panel avatar live video: attach a participant's ALREADY-subscribed
  // camera track (stored in tilesRef under the bare sid by attach()) into the
  // small round avatar <video>. LiveKit tracks support attaching to multiple
  // elements, so this reuses the stage's subscription — no new track/subscription.
  // The callback ref fires with the element on mount and null on unmount; on unmount
  // LiveKit's own detach (triggered when the camera turns off) removes the sink.
  const bindPeopleAvatarVideo = (el: HTMLVideoElement | null, sid: string) => {
    if (!el) return;
    const entry = tilesRef.current.get(sid);
    const track = entry && entry.track;
    if (!track) return; // not subscribed yet → the tinted initials background shows
    try {
      el.muted = true; // video-only track, but be safe against any audio sink
      (el as any).playsInline = true;
      track.attach(el);
    } catch (_) {}
  };

  // ONE-WAY by design — no "unmute everyone". Turning a mic back on is the
  // participant's own consent to give; the host can only mute the room.
  const muteAll = async () => {
    try {
      // The endpoint returns how many audio tracks it actually muted. It answers
      // 200 even when that count is ZERO (the SFU may have muted nothing), and
      // this used to claim success regardless — the host saw "Everyone muted"
      // while every microphone stayed live. Report what actually happened.
      const res: any = await api.muteAllMeetingParticipants(token, meetingId);
      const r = res?.data ?? res ?? {};
      const muted = Number(r.mutedTracks ?? 0);
      const audio = Number(r.audioTracks ?? 0);
      if (muted > 0) {
        onToast && onToast("Everyone muted — each person can unmute themselves.");
      } else if (r.sfuReachable === false) {
        // The media server couldn't be reached, so nothing was muted. Never let
        // this read as success.
        onToast &&
          onToast("Couldn't reach the media server — no one was muted. Please try again.");
      } else if (audio > 0) {
        // There WERE live microphones and we muted none of them: a real failure,
        // not a quiet room. Never report this as success.
        onToast &&
          onToast("Couldn't mute everyone — please try again in a moment.");
      } else {
        onToast &&
          onToast(
            "No one to mute — everyone else already has their microphone off.",
          );
      }
    } catch (e: any) {
      // Surface the real reason (permission / SFU) instead of a blanket fail.
      onToast && onToast(e?.message || "Couldn't mute everyone");
    }
  };
  const toggleLock = async () => {
    const next = !locked;
    setLocked(next); // optimistic
    try {
      await api.lockMeeting(token, meetingId, next);
      onToast &&
        onToast(
          next ? "Meeting locked — no one new can join" : "Meeting unlocked",
        );
    } catch {
      setLocked(!next);
      onToast && onToast("Couldn't change lock state");
    }
  };
  // These endpoints answer 200 even when they did nothing — an unreachable media
  // server or a participant who has already left both come back "successful".
  // Reporting that as "Participant muted" is how the whole mute problem stayed
  // invisible, so branch on what the server actually says it did.
  const mutePeer = async (identity: string) => {
    try {
      const r: any = (await api.muteMeetingParticipant(token, meetingId, identity)) || {};
      if (r.sfuReachable === false) {
        onToast && onToast("Couldn't reach the media server — that person wasn't muted.");
      } else if (r.inRoom === false) {
        onToast && onToast("That person has already left the meeting.");
      } else {
        onToast && onToast("Participant muted");
      }
    } catch {
      onToast && onToast("Failed to mute participant");
    }
  };
  const removePeer = async (identity: string) => {
    try {
      const r: any = (await api.removeMeetingParticipant(token, meetingId, identity)) || {};
      if (r.sfuReachable === false) {
        onToast && onToast("Couldn't reach the media server — that person wasn't removed.");
      } else if (r.removed === false) {
        onToast && onToast("That person has already left the meeting.");
      } else {
        onToast && onToast("Participant removed");
      }
    } catch {
      onToast && onToast("Failed to remove participant");
    }
  };

  const canControl = isHost || isCoHost;

  // ── The ONE participant-actions menu (meeting tiles + People panel) ─────────
  // Same primitive + rules as the call path (ParticipantMenu): pin-for-me for
  // everyone, plus Mute / Remove and Make / Remove co-host for hosts. RBAC HIDES
  // actions you can't use (never disables) — identical on web + desktop.
  const buildMeetActionsFor = (p: any) => {
    const isSelf = !!p.isLocal;
    const targetIsCoHost = !!(
      coHostIds &&
      coHostIds.has &&
      coHostIds.has(p.userId)
    );
    const isTargetHost = !!(hostId && p.userId === hostId);
    return buildParticipantActions({
      isSelf,
      canManage: canControl && !isSelf,
      canPromote:
        isHost &&
        !isSelf &&
        !isTargetHost &&
        !!onPromoteCoHost &&
        !!onDemoteCoHost,
      targetIsCoHost,
      onMute: canControl && !isSelf ? () => mutePeer(p.userId) : undefined,
      onRemove: canControl && !isSelf ? () => removePeer(p.userId) : undefined,
      onPromote: onPromoteCoHost ? () => onPromoteCoHost(p.userId) : undefined,
      onDemote: onDemoteCoHost ? () => onDemoteCoHost(p.userId) : undefined,
    });
  };
  openMeetTileMenuRef.current = (btnEl: HTMLElement, sid: string) => {
    const p = participants.find((x: any) => x.sid === sid);
    if (p) meetPartMenu.open(btnEl, buildMeetActionsFor(p), p.name);
  };

  const netLabel =
    netQuality === "excellent"
      ? "Strong connection"
      : netQuality === "good"
        ? "Good connection"
        : netQuality === "poor"
          ? "Weak connection"
          : netQuality === "lost"
            ? "Connection lost"
            : "Checking connection…";

  const fmtDuration = (s: number) => {
    const h = Math.floor(s / 3600),
      m = Math.floor((s % 3600) / 60),
      sec = s % 60;
    return h > 0
      ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
      : `${m}:${String(sec).padStart(2, "0")}`;
  };

  // Meeting-details popover data. The join link mirrors CalendarView's
  // meetingLink() — the ?meeting=<id> deep link CoLabV1 handles on load.
  const joinLink =
    typeof window !== "undefined" && meetingId
      ? `${window.location.origin}/?meeting=${meetingId}`
      : "";
  const copyInfo = (text: string, what: string) => {
    try {
      navigator.clipboard.writeText(text).then(
        () => onToast && onToast(`${what} copied`),
        () => onToast && onToast("Couldn't copy"),
      );
    } catch {
      onToast && onToast("Couldn't copy");
    }
  };

  // Post-call feedback (#67): the metadata the parent's maybeShowFeedback needs
  // to decide whether to show the dialog. `connected` reflects whether media ever
  // reached the room (everConnectedRef), so a meeting that never joined is
  // correctly skipped. Duration + netQuality are the live in-call values.
  const leaveMeta = () => ({
    kind: "meeting" as const,
    meetingId,
    durationSec: duration,
    netQuality,
    connected: everConnectedRef.current,
  });

  // Leave for ME only — the meeting keeps running for everyone else. Shared by
  // the split control's "Leave" half and its "End" entry (which ends YOUR
  // participation, not the meeting), so both can never drift apart.
  const leaveNow = () => {
    const meta = leaveMeta();
    try {
      roomRef.current && roomRef.current.disconnect();
    } catch (_) {}
    onLeave && onLeave(meta);
  };

  const endingRef = useRef(false);
  const endForAll = async () => {
    // Mark that WE initiated the end so our own ROOM_DELETED echo (from the
    // backend deleting the room) doesn't double-fire the leave + toast below.
    endingRef.current = true;
    // Ending the meeting for everyone is HOST-ONLY server-side. Swallowing the
    // failure here meant a rejected end looked identical to a successful one:
    // the caller disconnected while the meeting carried on for everyone else,
    // with nothing on screen to say so. Surface it and stay in the room instead.
    try {
      await api.completeMeeting(token, meetingId);
    } catch (e: any) {
      endingRef.current = false;
      onToast &&
        onToast(
          e?.status === 403
            ? "Only the meeting host can end this meeting for everyone."
            : "Couldn't end the meeting. Please try again.",
        );
      return;
    }
    try {
      roomRef.current && roomRef.current.disconnect();
    } catch (_) {}
    onLeave && onLeave(leaveMeta());
  };

  // ── Client-side recording ──────────────────────────────────────────────
  // Composite every camera/screen tile onto a canvas + mix all audio via Web
  // Audio, record with MediaRecorder, and upload the blob on stop. No egress
  // worker required — recording works locally and on any deployment.
  const stopClientRecording = () => {
    try {
      if (recorderRef.current && recorderRef.current.state !== "inactive")
        recorderRef.current.stop();
    } catch (_) {
      /* ignore */
    }
  };
  const startClientRecording = async () => {
    const reason = mediaBlockedReason();
    if (reason) {
      onToast && onToast(reason);
      return;
    }
    if (
      !(await confirmDialog(
        // Same consent wording as calls — one recording experience everywhere.
        // REC-05 (§11 Q3): when the workspace publishes a recording policy,
        // the consent dialog cites it — per-jurisdiction explicit-consent
        // actions remain a legal decision, but the policy link ships now.
        "Recording will capture audio and video from this meeting. By continuing, you confirm that all participants have been informed and consent to being recorded." +
          (process.env.NEXT_PUBLIC_RECORDING_POLICY_URL
            ? `\n\nWorkspace recording policy: ${process.env.NEXT_PUBLIC_RECORDING_POLICY_URL}`
            : ""),
        { title: "Start recording?", confirmText: "Start recording" },
      ))
    )
      return;
    try {
      const Ctx =
        (window as any).AudioContext || (window as any).webkitAudioContext;
      const ac = new Ctx();
      if (ac.state === "suspended") {
        try {
          await ac.resume();
        } catch (_) {
          /* ignore */
        }
      }
      recAudioCtxRef.current = ac;
      const dest = ac.createMediaStreamDestination();
      const room = roomRef.current;
      const seenAudio = new Set<string>();
      let audioSources = 0;
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
      if (room) {
        const lp = room.localParticipant;
        const lpPubs =
          lp && (lp.audioTrackPublications || lp.trackPublications);
        if (lpPubs && lpPubs.forEach) lpPubs.forEach(addAudio);
        const remotes = room.participants || room.remoteParticipants;
        if (remotes && remotes.forEach)
          remotes.forEach((p: any) => {
            const pubs = p.audioTrackPublications || p.trackPublications;
            if (pubs && pubs.forEach) pubs.forEach(addAudio);
          });
      }
      // Keep mixing tracks that appear AFTER Record was pressed (late joiners,
      // someone unmuting). Without this they were absent from the entire
      // recording with no warning. Cleared when the recorder stops.
      recAddAudioRef.current = addAudio;
      // Nobody publishing audio yet → capture this device's mic so the
      // recording is never pure digital silence (parity with calls).
      if (audioSources === 0) {
        try {
          const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
          recMicStreamRef.current = mic;
          ac.createMediaStreamSource(mic).connect(dest);
          audioSources++;
        } catch (_) {
          onToast && onToast("No microphone available — recording video only.");
        }
      }
      // Canvas video composite (grid of the live participant TILES).
      const canvas = document.createElement("canvas");
      canvas.width = 1280;
      canvas.height = 720;
      const cctx = canvas.getContext("2d");
      const paint = () => {
        if (!cctx) return;
        const stage = stageRef.current as HTMLElement | null;
        // Composite every VISIBLE participant tile — the live camera/screen
        // <video> when present, otherwise the participant's avatar (initials)
        // card. Iterating TILES (not just <video>s) means a SOLO or camera-off
        // meeting still records a meaningful frame instead of a blank canvas —
        // a blank canvas encodes to ~nothing and trips the "empty recording"
        // guard, which is exactly the "only one user" failure.
        const allTiles = stage
          ? (Array.from(stage.querySelectorAll(".ms-tile")) as HTMLElement[])
          : [];
        // Keep a tile if it's VISIBLE (video or avatar) OR it's hidden but still
        // carries LIVE video — during a screen share (or Speaker/pinned view)
        // the other cameras are "railed" (display:none, offsetParent === null)
        // yet stay subscribed with playing <video>. Filtering purely on
        // visibility would drop them and record only the on-stage tile; keeping
        // live-video tiles preserves the old "capture everyone" behavior while
        // still skipping paged-out avatar-only tiles from large galleries.
        let tiles = allTiles.filter((t) => {
          if (t.offsetParent !== null) return true;
          const vv = t.querySelector("video.ms-vid") as HTMLVideoElement | null;
          return !!vv && vv.readyState >= 2 && vv.videoWidth > 0;
        });
        if (!tiles.length) tiles = allTiles; // never composite an empty grid
        const cells = tiles.map((t) => {
          const v = t.querySelector("video.ms-vid") as HTMLVideoElement | null;
          const hasVideo = !!v && v.readyState >= 2 && v.videoWidth > 0;
          const circle = t.querySelector(
            ".ms-avatar-circle",
          ) as HTMLElement | null;
          const label = t.querySelector(".ms-label") as HTMLElement | null;
          return {
            v: hasVideo ? v : null,
            initials: (circle && circle.textContent) || "?",
            color: (circle && circle.style.background) || "#6366f1",
            name: (label && label.textContent) || "",
            isScreen:
              t.dataset.screen === "true" ||
              t.classList.contains("ms-tile-screen"),
          };
        });
        cctx.fillStyle = "#101216";
        cctx.fillRect(0, 0, canvas.width, canvas.height);
        const n = cells.length || 1;
        const cols = n <= 1 ? 1 : Math.ceil(Math.sqrt(n));
        const rows = Math.ceil(n / cols);
        const cw = canvas.width / cols;
        const ch = canvas.height / rows;
        cells.forEach((cell, i) => {
          const cx = (i % cols) * cw;
          const cy = Math.floor(i / cols) * ch;
          // Cell backing so avatar cards read as distinct tiles.
          cctx.fillStyle = "#16181d";
          cctx.fillRect(cx + 4, cy + 4, cw - 8, ch - 8);
          const v = cell.v;
          if (v) {
            const vr = v.videoWidth / v.videoHeight;
            const cr = cw / ch;
            // A SCREEN SHARE must be letterboxed (contain) so the shared
            // deck/app is never cropped; cameras use cover (a face reads fine
            // cropped).
            let dw = cw,
              dh = ch,
              dx = cx,
              dy = cy;
            if (cell.isScreen) {
              const s = Math.min(cw / v.videoWidth, ch / v.videoHeight);
              dw = v.videoWidth * s;
              dh = v.videoHeight * s;
              dx = cx + (cw - dw) / 2;
              dy = cy + (ch - dh) / 2;
            } else if (vr > cr) {
              dh = ch;
              dw = ch * vr;
              dx = cx - (dw - cw) / 2;
            } else {
              dw = cw;
              dh = cw / vr;
              dy = cy - (dh - ch) / 2;
            }
            try {
              cctx.drawImage(v, dx, dy, dw, dh);
            } catch (_) {
              /* not ready */
            }
          } else {
            // Camera-off → avatar: initials in a colored circle, centered.
            const r = Math.min(cw, ch) * 0.16;
            const ccx = cx + cw / 2,
              ccy = cy + ch / 2;
            cctx.beginPath();
            cctx.arc(ccx, ccy, r, 0, Math.PI * 2);
            cctx.fillStyle = cell.color || "#6366f1";
            cctx.fill();
            cctx.fillStyle = "#fff";
            cctx.font = `600 ${Math.round(r)}px system-ui, -apple-system, sans-serif`;
            cctx.textAlign = "center";
            cctx.textBaseline = "middle";
            cctx.fillText(cell.initials, ccx, ccy);
          }
          // Name chip (bottom-left of the cell).
          if (cell.name) {
            cctx.font = "500 26px system-ui, -apple-system, sans-serif";
            cctx.textAlign = "left";
            cctx.textBaseline = "alphabetic";
            const tw = cctx.measureText(cell.name).width;
            cctx.fillStyle = "rgba(0,0,0,0.5)";
            cctx.fillRect(cx + 12, cy + ch - 48, tw + 24, 36);
            cctx.fillStyle = "#fff";
            cctx.fillText(cell.name, cx + 24, cy + ch - 23);
          }
        });
        // Live REC clock (top-right): its pixels change every second, so
        // canvas.captureStream keeps emitting frames even when the composite is
        // otherwise static (all cameras off) — the encoder never stalls and the
        // blob is never "empty".
        const start = recStartRef.current || Date.now();
        const elapsed = Math.max(0, Math.round((Date.now() - start) / 1000));
        const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
        const ss = String(elapsed % 60).padStart(2, "0");
        cctx.fillStyle = "rgba(0,0,0,0.45)";
        cctx.fillRect(canvas.width - 196, 24, 172, 50);
        cctx.fillStyle = "#ef4444";
        cctx.beginPath();
        cctx.arc(canvas.width - 172, 49, 8, 0, Math.PI * 2);
        cctx.fill();
        cctx.fillStyle = "#fff";
        cctx.font = "600 30px system-ui, -apple-system, sans-serif";
        cctx.textAlign = "left";
        cctx.textBaseline = "middle";
        cctx.fillText(`REC ${mm}:${ss}`, canvas.width - 152, 50);
      };
      const draw = () => {
        paint();
        recRafRef.current = requestAnimationFrame(draw);
      };
      recStartRef.current = Date.now();
      draw();
      // rAF pauses/throttles when the meeting window is hidden or minimized,
      // which would FREEZE the recording composite. A low-rate timer keeps
      // painting so the recording stays live in the background when hidden.
      recIntervalRef.current = setInterval(() => {
        if (typeof document !== "undefined" && document.visibilityState === "hidden") {
          paint();
        }
      }, 500);
      const vStream = (canvas as any).captureStream(30);
      recCanvasStreamRef.current = vStream;
      const mixed = new MediaStream([
        ...vStream.getVideoTracks(),
        ...dest.stream.getAudioTracks(),
      ]);
      let options: any = {
        videoBitsPerSecond: 1_200_000,
        audioBitsPerSecond: 128_000,
      };
      if (
        typeof MediaRecorder !== "undefined" &&
        MediaRecorder.isTypeSupported
      ) {
        if (MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus"))
          options.mimeType = "video/webm;codecs=vp8,opus";
        else if (MediaRecorder.isTypeSupported("video/webm"))
          options.mimeType = "video/webm";
      }
      const rec = new MediaRecorder(mixed, options);
      recChunksRef.current = [];
      rec.ondataavailable = (e: any) => {
        if (e.data && e.data.size) recChunksRef.current.push(e.data);
      };
      // REC-14: a mid-meeting recorder failure must ALERT the person who
      // started it and PRESERVE everything captured so far — never a silent
      // red dot over a dead recorder. Stopping routes through onstop, which
      // finalizes the chunks collected up to the failure and uploads them.
      rec.onerror = (e: any) => {
        console.error("[meeting] recorder error", e && (e.error || e));
        onToast &&
          onToast(
            "Recording hit a problem — saving what was captured so far.",
          );
        setSrAnnouncement("Recording stopped due to an error. The captured part is being saved.");
        try {
          if (rec.state !== "inactive") rec.stop();
        } catch (_) {}
      };
      rec.onstop = async () => {
        cancelAnimationFrame(recRafRef.current);
        if (recIntervalRef.current) {
          clearInterval(recIntervalRef.current);
          recIntervalRef.current = null;
        }
        try {
          recCanvasStreamRef.current &&
            recCanvasStreamRef.current
              .getTracks()
              .forEach((t: any) => t.stop());
        } catch (_) {
          /* ignore */
        }
        // Stop mixing late tracks + release the fallback mic so the OS mic
        // indicator clears.
        recAddAudioRef.current = null;
        try {
          recMicStreamRef.current &&
            recMicStreamRef.current.getTracks().forEach((t) => t.stop());
        } catch (_) {}
        recMicStreamRef.current = null;
        try {
          recAudioCtxRef.current && recAudioCtxRef.current.close();
        } catch (_) {
          /* ignore */
        }
        recAudioCtxRef.current = null;
        setClientRecording(false);
        clientRecordingRef.current = false;
        recBroadcast(false);
        const blob = new Blob(recChunksRef.current, { type: "video/webm" });
        const durationSec = Math.round(
          (Date.now() - recStartRef.current) / 1000,
        );
        if (blob.size < 1024) {
          onToast && onToast("Recording was empty — nothing was captured.");
          return;
        }
        // The recording is delivered to the meeting CHAT only — NEVER
        // auto-downloaded to the host's machine. Everyone opens/plays it from
        // chat and downloads it there on demand (per-user choice). We still keep
        // a copy in the Recordings panel; no local file drop.
        setRecBusy(true);
        try {
          await api.uploadRecording(token, meetingId, blob, { durationSec });
          onToast &&
            onToast("Recording saved to chat — open it there to play or download.");
          // Post the ACTUAL recording into the meeting chat as a downloadable
          // attachment. Upload the same blob to the files store so it renders +
          // downloads via the normal chat file path for everyone.
          if (socket && meetingId) {
            const mm = Math.floor(durationSec / 60);
            const ss = String(durationSec % 60).padStart(2, "0");
            try {
              const recFile = new File(
                [blob],
                `meeting-recording-${mm}m${ss}s.webm`,
                { type: "video/webm" },
              );
              const desc = await api.uploadFile(token, recFile);
              socket.emit(EVENTS.MEETING_CHAT_SEND, {
                meetingId,
                text: `📹 Meeting recording (${mm}:${ss})`,
                file: desc,
              });
            } catch {
              // Files-store upload failed — still announce it so people know the
              // recording was captured.
              socket.emit(EVENTS.MEETING_CHAT_SEND, {
                meetingId,
                text: `📹 Recording saved (${mm}:${ss}).`,
              });
            }
          }
        } catch {
          // Emergency local download fallback so recording is never lost on network or size error
          try {
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `meeting-recording-${Date.now()}.webm`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 10000);
            onToast &&
              onToast("Upload failed — saved recording to your device instead.");
          } catch (_) {
            onToast && onToast("Couldn't save the recording. Please try again.");
          }
        } finally {
          setRecBusy(false);
        }
      };
      recStartRef.current = Date.now();
      rec.start(1000);
      recorderRef.current = rec;
      setClientRecording(true);
      clientRecordingRef.current = true;
      recBroadcast(true);
      onToast && onToast("Recording started.");
    } catch (_) {
      // Tear down the compositing loop + timer so a MediaRecorder-ctor failure
      // (or any mid-setup throw) can't leave a runaway 1080px canvas draw + the
      // captured stream running for the rest of the meeting.
      cancelAnimationFrame(recRafRef.current);
      if (recIntervalRef.current) {
        clearInterval(recIntervalRef.current);
        recIntervalRef.current = null;
      }
      try {
        recCanvasStreamRef.current &&
          recCanvasStreamRef.current
            .getTracks()
            .forEach((t: any) => t.stop());
      } catch (__) {
        /* ignore */
      }
      recCanvasStreamRef.current = null;
      try {
        recAudioCtxRef.current && recAudioCtxRef.current.close();
      } catch (__) {
        /* ignore */
      }
      recAudioCtxRef.current = null;
      onToast && onToast("Couldn't start recording on this device.");
    }
  };
  const handleRecordClick = () => {
    if (recBusy) return;
    if (clientRecording) stopClientRecording();
    else startClientRecording();
  };

  // "Try again" from the media help strip re-attempts the device that failed.
  const retryMedia = () => {
    const w = mediaGuidance?.what;
    setMediaGuidance(null);
    if (w === "microphone") { if (!mic) toggleMic(); }
    else if (w === "camera") { if (!cam) toggleCam(); }
    else if (w === "screen") { if (!screen) toggleScreen(); }
  };

  return (
    <div
      className={
        "ms-wrap" +
        (immersive ? " ms-immersive" : "") +
        (canControl ? " can-manage" : "")
      }
    >
      {/* Calm, single, dismissible help strip when a device can't open (mic/cam/
          screen) — product-owned, OS-specific guidance; floats top-centre without
          blocking the stage. */}
      {mediaGuidance && !mediaGuidance.silent ? (
        <div
          style={{
            position: "absolute",
            top: 64,
            left: 0,
            right: 0,
            zIndex: 40,
            display: "flex",
            justifyContent: "center",
            padding: "0 12px",
            pointerEvents: "none",
          }}
        >
          <div style={{ pointerEvents: "auto", width: "100%", maxWidth: 560 }}>
            <MediaHelpBanner
              guidance={mediaGuidance}
              onRetry={retryMedia}
              onDismiss={() => setMediaGuidance(null)}
            />
          </div>
        </div>
      ) : null}
      {/* ── Top bar ─────────────────────────────────────────── */}
      <div className="ms-topbar-v2">
        <div className="ms-topbar-left">
          {/* Top-left ☰ — the collaboration sidebar (chat with anyone WITHOUT
              leaving the meeting). The People panel opens from the Participant
              view toggle in the dock; in-meeting Chat from the Chat button. */}
          {onOpenComms && (
            <button
              className="ms-topbar-btn ms-topbar-menu"
              onClick={onOpenComms}
              title="Chat with anyone while in the meeting"
              aria-label={commsUnread > 0 ? "Open chat sidebar (unread messages)" : "Open chat sidebar"}
            >
              <IconMenu size={18} />
              {commsUnread > 0 && <span className="ms-topbar-dot" aria-hidden="true" />}
            </button>
          )}
          {/* Meeting avatar: with 2+ people in the call, a merged disc of their
              faces (others first, you last, max 4 — same mosaic as group rows in
              the chat list); otherwise the meeting name's initials. */}
          {(() => {
            const merged = mergedAvatarOf(
              participants.map((p: any) => ({
                name: p.name,
                identity: p.identity,
                avatarUrl: resolveMediaUrl(avatarUrlOf(p)),
                isLocal: !!p.isLocal,
              })),
            );
            return merged ? (
              <span className="ms-topbar-avatar-wrap" aria-hidden="true">
                <Avatar avatar={merged} size={32} />
              </span>
            ) : (
              <span
                className="ms-topbar-avatar"
                style={{ background: colorOf(String(meetingTitle || "Meeting")) }}
                aria-hidden="true"
              >
                {initialsOf(String(meetingTitle || "Meeting"))}
              </span>
            );
          })()}
          {/* Meeting name (+ info) with "N in the call | started" beneath it —
              clicking the subtitle opens the People panel. */}
          <div className="ms-topbar-titlewrap">
            <span className="ms-topbar-titlerow">
              <span className="ms-topbar-title">{meetingTitle}</span>
              {/* Info (i) → meeting details (ID + join link + copy). */}
              <span className="ms-info-wrap" style={{ position: "relative", display: "inline-flex" }}>
            <button
              className={"ms-topbar-btn ms-info-btn" + (showInfo ? " on" : "")}
              onClick={() => setShowInfo((v) => !v)}
              title="Meeting info"
              aria-label="Meeting info"
            >
              {/* Outline "i" in a circle (design asset Info.svg), stroked in the
                  accent — shared with the 1:1 call top bar. */}
              <IconInfoOutline size={20} className="ms-info-glyph" />
            </button>
            {showInfo && (
              <div
                className="ms-info-pop has-qr"
                role="dialog"
                aria-label="Meeting details"
              >
                {/* Reference layout: title + label/value rows with icon copy
                    buttons on the left, a QR of the join link on the right. Values
                    are ellipsized by CSS (full text in title= and on Copy). */}
                <div className="ms-info-main">
                  <div className="ms-info-pop-title">{meetingTitle}</div>
                  <div className="ms-info-row">
                    <span className="ms-info-label">Meeting ID</span>
                    <span className="ms-info-val" title={String(meetingId || "")}>{meetingId}</span>
                    <button
                      type="button"
                      className="ms-info-copy"
                      aria-label="Copy meeting ID"
                      title="Copy meeting ID"
                      onClick={() => copyInfo(String(meetingId || ""), "Meeting ID")}
                    >
                      <IconCopy size={18} />
                    </button>
                  </div>
                  <div className="ms-info-row">
                    <span className="ms-info-label">Join link</span>
                    <span className="ms-info-val" title={joinLink}>{joinLink}</span>
                    <button
                      type="button"
                      className="ms-info-copy"
                      aria-label="Copy join link"
                      title="Copy join link"
                      onClick={() => copyInfo(joinLink, "Link")}
                    >
                      <IconCopy size={18} />
                    </button>
                  </div>
                </div>
                <div className="ms-info-qr">
                  <QrCode value={joinLink} size={86} title="Scan to join this meeting" />
                </div>
              </div>
            )}
              </span>
            </span>
            {participants.length > 0 && (
              <button
                className="ms-topbar-people"
                onClick={() => {
                  setShowSidePanel(true);
                  setChatOpen(false);
                }}
                title={`${participants.length} participant${participants.length !== 1 ? "s" : ""} — show People`}
                aria-label="Show participants"
              >
                {participants.length} of {participants.length} in the call
                {phase === "connected" ? (
                  <>
                    <span className="ms-topbar-sep" aria-hidden="true">|</span>
                    {fmtDuration(duration)}
                  </>
                ) : null}
              </button>
            )}
          </div>
          {locked && (
            <div
              className="ms-topbar-badge ms-badge-lock"
              title="Meeting locked — no new participants can join"
            >
              <IconLock size={11} />
              Locked
            </div>
          )}
          {audioBlocked && (
            <button
              className="ms-enable-sound-v2"
              onClick={() => {
                const r = roomRef.current;
                if (r)
                  r.startAudio()
                    .then(() => setAudioBlocked(false))
                    .catch(() => {});
              }}
            >
              <IconVolume2 size={13} />
              Enable audio
            </button>
          )}
        </div>
        <div className="ms-topbar-right">
          {/* Recording pill: red dot + recording elapsed time. Only while a
              recording is running — meeting duration lives in the subtitle. */}
          {isRec && (
            <div className="ms-topbar-timer rec" title={"Recording · " + fmtRec(recElapsed)}>
              <span className="ms-rec-dot" aria-label="Recording" />
              {fmtRec(recElapsed)}
            </div>
          )}
          {/* View — Speaker · Speaker bottom strip · Gallery · Focus. */}
          <LayoutPicker
            variant="topbar"
            value={viewMode}
            onChange={(next) => {
              trackEvent("view.switch." + next);
              setViewMode(next);
            }}
          />
          {/* Only surface the network when it's genuinely degraded — no
              always-on "Strong connection" label (it read as misleading). */}
          {(netQuality === "lost" || netQuality === "poor") && (
            <div
              className={
                "ms-net-warn" +
                (netQuality === "lost" ? " is-lost" : " is-poor")
              }
              title={netLabel}
            >
              <span className="ms-net-warn-dot" />
              {netQuality === "lost" ? "Reconnecting…" : "Weak network"}
            </div>
          )}
          {/* Fullscreen + Picture-in-picture now live in the dock's More (⋯) menu —
              removed from the top bar so they aren't duplicated. NO top-right ⋮:
              the chat sidebar opens from the top-LEFT ☰. */}
        </div>
      </div>

      {/* ── Remote Control (request/allow/control/cursor/toolbar/border) ── */}
      <RemoteControlLayer
        room={roomRef.current}
        localSid={
          (roomRef.current &&
            roomRef.current.localParticipant &&
            roomRef.current.localParticipant.sid) ||
          null
        }
        localName={
          (roomRef.current &&
            roomRef.current.localParticipant &&
            roomRef.current.localParticipant.name) ||
          "You"
        }
        isSharingScreen={!!screen}
        remoteSharer={(() => {
          const ls =
            (roomRef.current &&
              roomRef.current.localParticipant &&
              roomRef.current.localParticipant.sid) ||
            null;
          const base = presenterId ? String(presenterId).split(":")[0] : null;
          if (!base || base === ls) return null;
          const p = participants.find((pp: any) => pp.sid === base);
          return { sid: base, name: (p && p.name) || "Presenter" };
        })()}
        getShareRect={() => {
          const root = stageRef.current
            ? stageRef.current.closest(".ms-wrap")
            : null;
          const el = (root || document).querySelector(
            '[data-screen="true"]:not([data-local="true"]) video',
          ) as HTMLElement | null;
          return el ? el.getBoundingClientRect() : null;
        }}
        isDesktop={
          typeof window !== "undefined" && !!(window as any).collabDesktop
        }
        onLog={(action, peerSid) => {
          try {
            const t = localStorage.getItem("clb_token");
            if (t)
              api
                .logRemoteControl(t, { action, peer: peerSid || "" })
                .catch(() => {});
          } catch {
            /* ignore */
          }
        }}
      />

      {/* ── Main body: grid + optional side panel ─────────── */}
{/* PiP shows no dock, so a presenter who minimised the call (or switched away
          while sharing) had no way to stop. This is the only control PiP adds. */}
      {pip && screen ? (
        <button
          type="button"
          className="pip-stop-share"
          onClick={(e) => { e.stopPropagation(); void toggleScreen(); }}
          aria-label="Stop sharing"
          title="Stop sharing"
        >
          <IconMonitor size={13} /> Stop sharing
        </button>
      ) : null}
      <div className="ms-body">
        <div className="ms-main">
          {mirrorGuardedCount > 0 && (
            <div className="ms-popped-strip ms-mirror-strip" role="status">
              <IconAlertTriangle size={14} />
              <span className="ms-popped-strip-txt">
                {mirrorGuardedCount === 1 ? "Another screen share is" : mirrorGuardedCount + " screen shares are"}{" "}
                hidden while you&rsquo;re sharing — showing it would mirror your
                screen back into the meeting. Stop sharing to view.
              </span>
            </div>
          )}
          {/* A share that is open in its own window gets a slim, non-blocking
              strip instead of taking over the stage — it says where the content
              went and brings it back in one click. */}
          {poppedOutPids.length > 0 && (
            <div className="ms-popped-strip" role="status">
              <svg
                viewBox="0 0 24 24"
                width="14"
                height="14"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                <polyline points="15 3 21 3 21 9" />
                <line x1="10" y1="14" x2="21" y2="3" />
              </svg>
              <span className="ms-popped-strip-txt">
                {poppedOutPids.length === 1
                  ? (screenShares.find((s) => s.pid === poppedOutPids[0])?.name ||
                      "A shared screen") + " is open in a separate window"
                  : poppedOutPids.length + " shared screens are open in separate windows"}
              </span>
              <button
                type="button"
                className="ms-popped-strip-btn"
                onClick={() => {
                  for (const k of [...poppedOutPids]) closePipWindow(k);
                  const pipEl = (document as any).pictureInPictureElement;
                  if (pipEl) (document as any).exitPictureInPicture?.().catch?.(() => {});
                  setPoppedOutPids([]);
                }}
              >
                {poppedOutPids.length === 1 ? "Bring back" : "Bring all back"}
              </button>
            </div>
          )}
          {/* Concurrent screen shares → a floating "who to view" switcher. Only
              renders with 2+ live shares (single-share is untouched). Each viewer
              picks independently: a presenter to spotlight, or Both/All for a
              side-by-side split. Purely local — no server/track change. */}
          {screenShares.length >= 2 && !showWhiteboard && (
            <div
              className="ms-share-switcher"
              role="group"
              aria-label="Choose which shared screen to view"
            >
              <span className="ms-share-switcher-label">
                {screenShares.length} people are sharing
              </span>
              {screenShares.map((s) => (
                <button
                  key={s.pid}
                  type="button"
                  className={
                    "ms-share-chip" +
                    (screenViewMode === "spotlight" && focusedScreenPid === s.pid
                      ? " active"
                      : "")
                  }
                  onClick={() => {
                    setScreenViewMode("spotlight");
                    setFocusedScreenPid(s.pid);
                  }}
                  title={`View ${s.name}'s screen`}
                >
                  {s.name}
                </button>
              ))}
              <button
                type="button"
                className={
                  "ms-share-chip" +
                  (screenViewMode === "sideBySide" ? " active" : "")
                }
                onClick={() => setScreenViewMode("sideBySide")}
                title="View all shared screens side by side"
              >
                {screenShares.length === 2 ? "Both" : "All"}
              </button>
            </div>
          )}
          {phase === "connected" && (
            <WeakNetworkBanner
              quality={netQuality}
              camOn={cam}
              onTurnOffVideo={() => {
                if (cam) void toggleCam();
              }}
            />
          )}
          <div
            className={
              "ms-stage" +
              (speakerStyle ? " ms-speaker-layout" : " ms-gallery-layout") +
              (screen ? " ms-sharing" : "") +
              (showSidePanel ? " panel-open" : "")
            }
            ref={stageRef}
            data-count={participants.length}
          />
          {presenterId && (
            <div
              style={{
                position: "absolute",
                top: 64,
                left: "50%",
                transform: "translateX(-50%)",
                zIndex: 25,
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 14px",
                borderRadius: 20,
                background: "rgba(15, 23, 42, 0.85)",
                backdropFilter: "blur(8px)",
                color: "#fff",
                fontSize: 12,
                fontWeight: 500,
                boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
                border: "1px solid rgba(255,255,255,0.12)",
              }}
            >
              {/* Says who is PRESENTING. This pill used to read "Spotlighted: X" with
                  a "Return to my view" button that did nothing (the stage promotes a
                  live share from the tiles themselves, not from this state) — and it
                  duplicated the real spotlight banner's wording. Spotlight keeps its
                  own banner + escape below; this is information only. */}
              <span>
                {(() => {
                  const pp = participants.find(
                    (p: any) => p.sid === String(presenterId).split(":")[0],
                  );
                  return pp && pp.isLocal
                    ? "You're presenting"
                    : `${(pp && pp.name) || "Someone"} is presenting`;
                })()}
              </span>
            </div>
          )}
          {showWhiteboard && allowWhiteboard && (
            <Whiteboard
              broadcast={wbBroadcast}
              registerReceiver={wbRegisterReceiver}
              onClose={() => setShowWhiteboard(false)}
              title="Whiteboard"
              resyncNonce={wbResyncNonce}
              loadState={wbLoad}
              saveState={wbSave}
              canModerate={canControl}
              selfName={
                (roomRef.current &&
                  roomRef.current.localParticipant &&
                  roomRef.current.localParticipant.name) ||
                "You"
              }
            />
          )}
          {pageCount > 1 && (
            <div
              className="ms-pager"
              role="navigation"
              aria-label="Gallery pages"
            >
              <button
                className="ms-pager-btn"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page <= 0}
                aria-label="Previous page"
              >
                <IconChevronLeft size={16} />
              </button>
              <span
                className="ms-pager-label"
                style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
              >
                {page + 1} / {pageCount}
                {activeSpeakerSid && page > 0 && (
                  <span
                    title="Active speaker on earlier page"
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: "var(--ac, #0ea5e9)",
                      display: "inline-block",
                    }}
                  />
                )}
              </span>
              <button
                className="ms-pager-btn"
                onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                disabled={page >= pageCount - 1}
                aria-label="Next page"
              >
                <IconChevronRight size={16} />
              </button>
            </div>
          )}
        </div>

        {/* Right side panel (People or Chat) */}
        {showSidePanel && (
          <div className="ms-panel-v2">
            <div className="ms-panel-head">
              <div className="ms-panel-tabs-v2">
                {/* BA/CEO #5: Chat is the FIRST tab, People second. */}
                <button
                  className={"ms-panel-tab" + (chatOpen && !pollsOpen ? " active" : "")}
                  onClick={() => {
                    setPollsOpen(false);
                    setChatOpen(true);
                  }}
                >
                  <IconMessageSquare size={13} />
                  Chat
                  {chatUnread > 0 && (
                    <span className="ms-panel-count">
                      {chatUnread > 99 ? "99+" : chatUnread}
                    </span>
                  )}
                </button>
                <button
                  className={"ms-panel-tab" + (!chatOpen && !pollsOpen ? " active" : "")}
                  onClick={() => {
                    setPollsOpen(false);
                    setChatOpen(false);
                  }}
                >
                  <IconUsers size={13} />
                  Participants
                  <span className="ms-panel-count">{participants.length}</span>
                </button>
                <button
                  className={"ms-panel-tab" + (pollsOpen ? " active" : "")}
                  onClick={() => setPollsOpen(true)}
                >
                  <IconBarChart size={13} />
                  Polls
                </button>
              </div>
              {(clientRecording || peerRecording) && (
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 5,
                    padding: "2px 8px",
                    borderRadius: 12,
                    background: "rgba(239, 68, 68, 0.15)",
                    color: "#ef4444",
                    fontSize: 11,
                    fontWeight: 600,
                    marginRight: 8,
                  }}
                >
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: "#ef4444",
                    }}
                  />
                  REC
                </span>
              )}
              <button
                className="ms-panel-close"
                onClick={() => setShowSidePanel(false)}
                aria-label="Close panel"
              >
                <IconX size={15} />
              </button>
            </div>

            {pollsOpen ? (
              <PollsPanel
                token={token}
                meetingId={meetingId}
                socket={socket}
                canManage={canControl}
                onToast={onToast}
              />
            ) : !chatOpen ? (
              /* ── Participant View — a compact Teams-style MANAGEMENT panel
                   (P0-10). One row per participant (avatar · name · presence ·
                   role · mic/cam/hand status); contextual actions reveal on
                   hover (pin · focus · ⋮), touch devices use the ⋮ menu. It
                   never hosts video tiles — the stage owns all media. ── */
              <div className="ms-people-panel">
                <div className="ms-people-search">
                  <IconSearch size={13} />
                  <input
                    placeholder="Search participants…"
                    className="ms-people-input"
                    aria-label="Search participants"
                    value={panelQuery}
                    onChange={(e) => setPanelQuery(e.target.value)}
                  />
                </div>
                {/* Host-only, but shown whenever the host is here (not only with
                    >1 participant) so it's always present under the search, per
                    the sample. Muting when alone is simply a no-op. */}
                {canControl && (
                  <button className="ms-people-mute-all" onClick={muteAll}>
                    <IconMicOff size={13} />
                    Mute everyone
                  </button>
                )}
                <div className="ms-people-list">
                  {(panelQuery.trim()
                    ? participants.filter((p: any) =>
                        String(p.name || "")
                          .toLowerCase()
                          .includes(panelQuery.trim().toLowerCase()),
                      )
                    : participants
                  ).map((p: any) => (
                    <div
                      key={p.sid}
                      className={
                        "ms-person-row" + (p.isSpeaking ? " speaking" : "")
                      }
                    >
                      {/* BA/CEO #21: the raised-hand badge sits OUTSIDE the
                          avatar (which is overflow:hidden to clip the video
                          circle) so it layers neatly over the avatar's corner
                          instead of being clipped inside it. */}
                      <div className="ms-person-avatar-wrap">
                        <div
                          className="ms-person-avatar"
                          style={{ background: colorOf(p.identity || p.name) }}
                        >
                          {p.camOn ? (
                            <video
                              className="ms-person-avatar-vid"
                              autoPlay
                              muted
                              playsInline
                              ref={(el) => bindPeopleAvatarVideo(el, p.sid)}
                            />
                          ) : (
                            <>
                              {initialsOf(p.name)}
                              {p.avatarUrl ? (
                                <img
                                  className="ms-person-avatar-vid"
                                  style={{ background: "transparent" }}
                                  src={p.avatarUrl}
                                  alt=""
                                  onError={(e) => {
                                    e.currentTarget.style.display = "none";
                                  }}
                                />
                              ) : null}
                            </>
                          )}
                        </div>
                        {raisedHands.includes(p.userId) && (
                          <span className="ms-person-hand-badge" title="Hand raised">
                            <IconHand size={11} />
                          </span>
                        )}
                      </div>
                      <div className="ms-person-info">
                        <span className="ms-person-name">
                          {p.name}
                          {p.isLocal ? " (you)" : ""}
                        </span>
                        <span className="ms-person-role">
                          {hostId && p.userId === hostId
                            ? "Host"
                            : coHostIds &&
                                coHostIds.has &&
                                coHostIds.has(p.userId)
                              ? "Co-host"
                              : "Participant"}
                        </span>
                      </div>
                      <div className="ms-person-status">
                        {/* Raised hand shows as a badge over the avatar (above),
                            not inline here (BA/CEO #21). */}
                        {presenterId === p.sid && (
                          <span
                            className="ms-person-presenting"
                            title="Presenting"
                          >
                            <IconMonitor size={12} />
                          </span>
                        )}
                        <span
                          className={"ms-person-mic " + (p.micOn === false ? "off" : "on")}
                          title={p.micOn === false ? "Microphone off" : "Microphone on"}
                        >
                          {p.micOn === false ? <IconMicOff size={18} /> : <IconMic size={18} />}
                        </span>
                        <span
                          className={"ms-person-cam " + (p.camOn === false ? "off" : "on")}
                          title={p.camOn === false ? "Camera off" : "Camera on"}
                        >
                          {p.camOn === false ? <IconVideoOff size={18} /> : <IconVideo size={18} />}
                        </span>
                      </div>
                      {/* Hover-revealed contextual actions (desktop); on touch
                          the ⋮ menu carries everything (see hover:none CSS). */}
                      <div className="ms-person-actions">
                        <button
                          className={
                            "ms-person-action" +
                            (pinnedSids.includes(p.sid) ? " on" : "")
                          }
                          aria-label={
                            pinnedSids.includes(p.sid)
                              ? "Unpin participant"
                              : "Pin participant"
                          }
                          aria-pressed={pinnedSids.includes(p.sid)}
                          title={pinnedSids.includes(p.sid) ? "Unpin" : "Pin for me"}
                          onClick={() => togglePin(p.sid)}
                        >
                          <svg viewBox="0 0 24 24" width={15} height={15} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M12 17v5" />
                            <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z" />
                          </svg>
                        </button>
                        {/* VIEW-09: Spotlight — organizer/co-organizer only.
                            Unlike Pin (local), this forces the tile large for
                            EVERYONE, capped at 3, with a per-viewer escape. */}
                        {canControl && (
                          <button
                            className={
                              "ms-person-action ms-person-spotlight" +
                              (spotlightUids.includes(p.userId) ? " on" : "")
                            }
                            aria-label={
                              spotlightUids.includes(p.userId)
                                ? "Remove spotlight"
                                : "Spotlight for everyone"
                            }
                            aria-pressed={spotlightUids.includes(p.userId)}
                            title={
                              spotlightUids.includes(p.userId)
                                ? "Remove spotlight"
                                : "Spotlight for everyone"
                            }
                            onClick={() => toggleSpotlight(p.userId, p.name)}
                          >
                            <svg viewBox="0 0 24 24" width={15} height={15} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <path d="M12 2l2.4 4.86 5.36.78-3.88 3.78.92 5.34L12 14.24l-4.8 2.52.92-5.34L4.24 7.64l5.36-.78z" />
                            </svg>
                          </button>
                        )}
                        <button
                          className="ms-person-action"
                          aria-label="Focus participant (fullscreen)"
                          title="Fullscreen"
                          onClick={() => {
                            // In Participant view a non-prominent tile is railed
                            // (display:none) and can't go fullscreen, so surface
                            // it with a pin first. In Gallery it's already
                            // visible — pinning there would collapse the grid to
                            // one person, so ONLY pin when actually hidden.
                            const ent0: any =
                              tilesRef.current.get(p.sid) ||
                              tilesRef.current.get(p.sid + ":screen");
                            const t0: HTMLElement | null =
                              (ent0 && ent0.tile) || null;
                            const needsPin =
                              !pinnedSids.includes(p.sid) &&
                              !!t0 &&
                              t0.classList.contains("ms-tile-railed");
                            if (needsPin) togglePin(p.sid);
                            requestAnimationFrame(() =>
                              requestAnimationFrame(() => {
                                const ent: any =
                                  tilesRef.current.get(p.sid) ||
                                  tilesRef.current.get(p.sid + ":screen");
                                if (!ent || !ent.tile) return;
                                try {
                                  fsRequest(ent.tile);
                                } catch (_) {}
                                if (needsPin) {
                                  // The pin only surfaced a hidden tile for
                                  // fullscreen — undo it on exit so the prior
                                  // layout is restored (no sticky spotlight).
                                  const onFs = () => {
                                    if (!fsElement()) {
                                      setPinnedSids((prev) =>
                                        prev.filter((s) => s !== p.sid),
                                      );
                                      document.removeEventListener("fullscreenchange", onFs);
                                      document.removeEventListener("webkitfullscreenchange", onFs);
                                    }
                                  };
                                  document.addEventListener("fullscreenchange", onFs);
                                  document.addEventListener("webkitfullscreenchange", onFs);
                                }
                              }),
                            );
                          }}
                        >
                          <svg viewBox="0 0 24 24" width={15} height={15} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" />
                          </svg>
                        </button>
                        {canControl && !p.isLocal && (
                          <button
                            className="ms-person-action"
                            aria-label="Mute participant"
                            title="Mute"
                            onClick={() => mutePeer(p.userId)}
                          >
                            <svg viewBox="0 0 24 24" width={15} height={15} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <line x1="2" y1="2" x2="22" y2="22" />
                              <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V5a3 3 0 0 0-5.94-.6" />
                              <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23" />
                              <line x1="12" y1="19" x2="12" y2="22" />
                            </svg>
                          </button>
                        )}
                        {canControl && !p.isLocal && (
                          <button
                            className="ms-person-action"
                            aria-label="Participant options"
                            aria-haspopup="menu"
                            title="More options"
                            onClick={(e) =>
                              meetPartMenu.open(
                                e.currentTarget,
                                buildMeetActionsFor(p),
                                p.name,
                              )
                            }
                          >
                            <IconMoreVertical size={16} />
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                  {panelQuery.trim() &&
                    participants.every(
                      (p: any) =>
                        !String(p.name || "")
                          .toLowerCase()
                          .includes(panelQuery.trim().toLowerCase()),
                    ) && (
                      <div className="ms-people-empty">
                        No participants match “{panelQuery.trim()}”.
                      </div>
                    )}
                </div>
              </div>
            ) : (
              /* ── Chat panel ── */
              <div
                className="ms-chat-panel-v2"
                // Drag-and-drop file upload (parity with the main chat). Reuses the
                // same single-file stage-then-send path as the paste handler.
                onDragOver={(e) => {
                  e.preventDefault();
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const f =
                    e.dataTransfer &&
                    e.dataTransfer.files &&
                    e.dataTransfer.files[0];
                  if (f) onChatFile({ target: { files: [f], value: "" } });
                }}
              >
                <div className="ms-chat-messages-v2">
                  {chatMessages.length === 0 && (
                    <div className="ms-chat-empty-v2">
                      <IconMessageSquare size={28} />
                      <span>No messages yet</span>
                    </div>
                  )}
                  {groupChatMessages(chatMessages, {
                    id: (m: any) => String(m.id),
                    sender: (m: any) => String(m.senderId || m.senderName || ""),
                    name: (m: any) => String(m.senderName || "?"),
                    ts: (m: any) => Number(m.ts),
                    mine: (m: any) => !!meIdRef.current && m.senderId === meIdRef.current,
                  }).map((g) =>
                    g.kind === "day" ? (
                      <div key={g.key} className="icc-day">
                        <span>{g.label}</span>
                      </div>
                    ) : (
                      <div key={g.key} className={"icc-run" + (g.mine ? " mine" : "")}>
                        <div className="icc-avatar" style={{ background: colorOf(g.sender) }}>
                          {initialsOf(g.senderName)}
                        </div>
                        <div className="icc-col">
                          <div className="icc-name">{g.mine ? "You" : g.senderName}</div>
                          {g.items.map((m: any) => (
                            <div key={m.id} className="icc-bubble">
                              {m.text && <div className="icc-text">{m.text}</div>}
                              {m.file && (
                                <ChatAttachment
                                  file={m.file}
                                  token={token}
                                  onToast={onToast}
                                />
                              )}
                            </div>
                          ))}
                          <div className="icc-meta">
                            <span>
                              {new Date(g.last).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                            </span>
                            {g.mine ? <IconCheckCheck size={14} /> : null}
                          </div>
                        </div>
                      </div>
                    ),
                  )}
                  <div ref={chatEndRef} />
                </div>

                <InlineMentionPopover mentions={mentions} />
                {/* BA/CEO #6: full searchable emoji library (shared with the
                    main chat) instead of the old tiny fixed palette. */}
                {chatEmoji && chatEmojiAnchor && (
                  <EmojiPicker
                    anchorRect={chatEmojiAnchor}
                    onSelect={insertChatEmoji}
                    onClose={() => setChatEmoji(false)}
                  />
                )}
                {chatStaged && (
                  <div className="ms-chat-staged">
                    {chatStaged.isImage && chatStaged.url ? (
                      <img
                        src={chatStaged.url}
                        alt={chatStaged.file.name}
                        className="ms-chat-staged-img"
                      />
                    ) : (
                      <div className="ms-chat-staged-file">
                        <IconFile size={16} />
                      </div>
                    )}
                    <span className="ms-chat-staged-name">
                      {chatStaged.file.name}
                    </span>
                    <button
                      type="button"
                      className="ms-chat-staged-x"
                      onClick={clearChatStaged}
                      aria-label="Remove attachment"
                    >
                      <IconX size={12} />
                    </button>
                  </div>
                )}
                <div className="ms-chat-composer">
                  {!isGuest && (
                    <>
                      <input
                        ref={chatFileRef}
                        type="file"
                        style={{ display: "none" }}
                        onChange={onChatFile}
                      />
                      <button
                        className="ms-chat-composer-btn"
                        title="Attach file"
                        disabled={chatUploading}
                        onClick={() =>
                          chatFileRef.current && chatFileRef.current.click()
                        }
                      >
                        <IconPaperclip size={15} />
                      </button>
                    </>
                  )}
                  <button
                    className={
                      "ms-chat-composer-btn" + (chatEmoji ? " on" : "")
                    }
                    title="Emoji"
                    // Stop the mousedown reaching the picker's document-level
                    // outside-click handler, so a second click cleanly toggles
                    // the picker closed instead of close-then-reopen.
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      const r = (
                        e.currentTarget as HTMLButtonElement
                      ).getBoundingClientRect();
                      setChatEmojiAnchor({
                        top: r.top,
                        left: r.left,
                        width: r.width,
                        height: r.height,
                      });
                      setChatEmoji((v) => !v);
                    }}
                  >
                    <IconSmile size={15} />
                  </button>
                  <input
                    ref={chatInputRef}
                    type="text"
                    value={chatDraft}
                    onChange={(e) => setChatDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (mentions.onKeyDown(e)) return;
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        sendChatMessage();
                      }
                    }}
                    onPaste={(e) => {
                      const items = e.clipboardData && e.clipboardData.items;
                      if (!items) return;
                      for (let i = 0; i < items.length; i++) {
                        if (items[i].kind === "file") {
                          const f = items[i].getAsFile();
                          if (f) {
                            e.preventDefault();
                            onChatFile({ target: { files: [f], value: "" } });
                            break;
                          }
                        }
                      }
                    }}
                    // Chat turned off leaves the HISTORY readable and disables
                    // only sending — same as Teams, and a good deal kinder than
                    // hiding messages people have already seen.
                    disabled={!allowChat}
                    placeholder={
                      !allowChat
                        ? "The host has turned off chat for attendees"
                        : chatUploading
                          ? "Uploading…"
                          : chatStaged
                            ? "Add a caption…"
                            : "Message everyone…"
                    }
                    className="ms-chat-composer-input"
                  />
                  <button
                    onClick={sendChatMessage}
                    disabled={
                      !allowChat || (!chatDraft.trim() && !chatStaged) || chatUploading
                    }
                    className="ms-chat-composer-send"
                    aria-label="Send message"
                  >
                    <IconSend size={15} />
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Floating hand raise tray ──────────────────────── */}
      <HandsTray
        raisedHands={raisedHands}
        participants={participants}
        handNames={handNames}
        canControl={canControl}
        onLowerHand={lowerHand}
      />

      {/* Shared participant overflow (⋮) menu — opened from meeting tiles + the
          People panel. Portals to <body> at --z-menu; identical to the call path. */}
      {meetPartMenu.menu}
      {/* ── Floating reactions ────────────────────────────── */}
      <ReactionsOverlay reactions={reactions} />

      {/* ── Status overlays ──────────────────────────────── */}
      {/* Belt-and-suspenders: the opaque overlay is for the FIRST connect only —
          never re-cover the stage on a mid-call reconnect (see the Reconnecting
          handler; the "Reconnecting…" pill covers that case). */}
      {phase === "joining" && !everConnectedRef.current && (
        <div className="ms-connect-overlay">
          <div className="ms-connect-spinner" />
          <span>Connecting to meeting…</span>
        </div>
      )}
      {err && (
        <div className="ms-err-overlay">
          <IconAlertTriangle size={32} />
          <span>{err}</span>
          <button
            className="ms-err-retry"
            onClick={() => {
              setErr(null);
              setPhase("joining");
              setRetryKey((k) => k + 1);
            }}
          >
            Retry
          </button>
        </div>
      )}

      <div ref={audioRef} style={{ display: "none" }} />

      {/* ── Device settings popup ────────────────────────── */}
      <DeviceSettings
        open={showDevices}
        tab={devicesTab}
        devices={devices}
        selMic={selMic}
        selCam={selCam}
        selSpk={selSpk}
        sinkSupported={sinkSupported}
        onSwitchMic={switchMic}
        onSwitchCam={switchCam}
        onSwitchSpeaker={switchSpeaker}
        onClose={() => setShowDevices(false)}
      />

      {/* ── Host settings (creator only) ─────────────────── */}
      {isHost && showHostControls && (
        <HostControlsModal
          token={token}
          meetingId={meetingId}
          participants={participants}
          hostId={hostId}
          coHostIds={coHostIds}
          onMute={mutePeer}
          onMuteAll={muteAll}
          onRemove={removePeer}
          onToast={onToast}
          onClose={() => setShowHostControls(false)}
        />
      )}

      {/* ── Reaction picker ──────────────────────────────── */}
      <ReactionPicker
        open={showReactions}
        onPick={sendReaction}
        style={
          reactAnchor
            ? {
                position: "fixed",
                left: reactAnchor.left,
                bottom: reactAnchor.bottom,
                transform: "none",
                // Now a <body> child (portal) — see the matching note in
                // CallModal.tsx: needs an explicit z-index above the meeting
                // root's or it paints behind it, present but invisible.
                zIndex: 6001,
              }
            : undefined
        }
      />

      {/* VIEW-09: an active spotlight overrides this viewer's layout — say WHO
          forced it and give the per-viewer escape. Escaping is local only and
          re-arms if the organizer changes the spotlight set. */}
      {spotlightUids.length > 0 && !spotlightEscaped ? (
        <div className="ms-spotlight-banner" role="status">
          <span>Spotlighted by {spotlightBy || "you"}</span>
          <button
            type="button"
            className="ms-spotlight-return"
            onClick={() => {
              setSpotlightEscaped(true);
              setSrAnnouncement("Returned to your view.");
            }}
          >
            Return to my view
          </button>
        </div>
      ) : null}
      {/* VIEW-11: Screen reader announcements */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          padding: 0,
          margin: -1,
          overflow: "hidden",
          clip: "rect(0,0,0,0)",
          border: 0,
        }}
      >
        {srAnnouncement}
      </div>

      {/* ── Floating control dock ────────────────────────── */}
      <div
        className={"ms-dock" + (isFullscreen && !chromeVisible ? " ms-dock-autohidden" : "")}
        style={{
          opacity: isFullscreen && !chromeVisible ? 0 : 1,
          transition: "opacity 0.25s ease",
          pointerEvents: isFullscreen && !chromeVisible ? "none" : "auto",
        }}
      >
        {/* LEFT cluster: collaboration actions, right-aligned so they hug the
            centred media controls; the far-left edge stays empty. */}
        <div className="ms-dock-group ms-dock-left">
          {onInvite && (
            <button
              className={"ms-dock-btn" + (inviteActive ? " on" : "")}
              onClick={onInvite}
              title="Invite others"
              aria-label="Invite others"
            >
              <span className="ms-dock-icon">
                <IconUserPlus size={19} />
              </span>
              <span className="ms-dock-label">Invite</span>
            </button>
          )}

          {/* Record button */}
          <button
            className={"ms-dock-btn" + (clientRecording ? " rec-on" : "")}
            onClick={handleRecordClick}
            disabled={recBusy}
            aria-label={clientRecording ? "Stop recording" : "Record meeting"}
            title={clientRecording ? "Stop recording" : "Record meeting"}
          >
            <span className="ms-dock-icon">
              <svg viewBox="0 0 24 24" width={19} height={19} fill={clientRecording ? "#ef4444" : "none"} stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
                <circle cx="12" cy="12" r="8" fill={clientRecording ? "#ef4444" : "none"} />
                <circle cx="12" cy="12" r="3" fill="currentColor" />
              </svg>
            </span>
            <span className="ms-dock-label">
              {clientRecording ? "Stop" : "Record"}
            </span>
          </button>

          {/* People panel (roster) — its own button; the stage LAYOUT is the
              separate picker next to it (it used to open this panel as a fake
              "participant view"). */}
          <button
            className={"ms-dock-btn" + (showSidePanel && !chatOpen ? " on" : "")}
            onClick={() => {
              if (showSidePanel && !chatOpen) setShowSidePanel(false);
              else {
                setShowSidePanel(true);
                setChatOpen(false);
              }
            }}
            aria-label={showSidePanel && !chatOpen ? "Hide participants" : "Show participants"}
            title="People"
          >
            <span className="ms-dock-icon">
              <IconUsers size={19} />
            </span>
            <span className="ms-dock-label">Participants</span>
          </button>

          <button
            className={"ms-dock-btn" + (showWhiteboard ? " on" : "")}
            onClick={() => setShowWhiteboard((v) => !v)}
            disabled={!allowWhiteboard}
            aria-label={showWhiteboard ? "Close whiteboard" : "Open whiteboard"}
            title={
              allowWhiteboard
                ? "Whiteboard"
                : whiteboardOffBy === "admin"
                  ? "Whiteboard turned off by an administrator"
                  : "Whiteboard turned off by the host"
            }
          >
            <span className="ms-dock-icon">
              <IconPencil size={19} />
            </span>
            <span className="ms-dock-label">Whiteboard</span>
          </button>

          {/* Host settings — the meeting's CREATOR only (not co-hosts): who may
              use camera / screen share / whiteboard, mute and remove people. */}
          {isHost && (
            <button
              className={"ms-dock-btn" + (showHostControls ? " on" : "")}
              onClick={() => setShowHostControls((v) => !v)}
              aria-label="Host settings"
              aria-haspopup="dialog"
              title="Host settings"
            >
              <span className="ms-dock-icon">
                <IconSettings size={19} />
              </span>
              <span className="ms-dock-label">Settings</span>
            </button>
          )}

        </div>

        {/* CENTER cluster: the round mic/camera controls — the ABSOLUTE middle of
            the bar (the balanced 1fr side columns flank this auto column). */}
        <div className="ms-dock-group ms-dock-center">
          {/* Round media controls — camera-on fills accent (Skype's blue camera);
              muted / camera-off go red. */}
          <div className="ms-dock-media">
            <div className="ms-dock-btn-wrap">
              <button
                className={"ms-dock-btn" + (mic ? "" : " off")}
                onClick={toggleMic}
                // Muting yourself always works; only UNMUTING is policy-gated,
                // so a restricted attendee can still silence themselves.
                disabled={offline || (!mic && !allowMic)}
                aria-label={mic ? "Mute" : "Unmute"}
                title={
                  !mic && !allowMic
                    ? "The host has turned off microphones for attendees"
                    : mic
                      ? "Mute microphone"
                      : "Unmute microphone"
                }
              >
                <span className="ms-dock-icon">
                  {mic ? <IconMic size={19} /> : <IconMicOff size={19} />}
                </span>
                <span className="ms-dock-label">{mic ? "Mute" : "Unmute"}</span>
              </button>
              <button
                className="ms-dock-chevron"
                onClick={() => openDevices("audio")}
                title="Audio settings"
                aria-label="Audio device settings"
              >
                <IconChevronUp size={16} />
              </button>
            </div>
            {/* Image order: Mic · Camera · Screen. The camera sits BEFORE screen
                share so the screen button (and its presentation-view switcher) is
                the LAST media control, right where the sharing controls belong. */}
            <div className={"ms-dock-btn-wrap" + (cam ? " cam-on" : "")}>
              <button
                className={"ms-dock-btn" + (cam ? "" : " off")}
                onClick={toggleCam}
                disabled={offline || (!cam && !allowCam)}
                aria-label={cam ? "Stop video" : "Start video"}
                title={
                  !cam && !allowCam
                    ? "The host has turned off cameras for attendees"
                    : cam
                      ? "Stop camera"
                      : "Start camera"
                }
              >
                <span className="ms-dock-icon">
                  {cam ? <IconVideo size={19} /> : <IconVideoOff size={19} />}
                </span>
                <span className="ms-dock-label">
                  {cam ? "Stop video" : "Start video"}
                </span>
              </button>
              <button
                className="ms-dock-chevron"
                onClick={() => openDevices("video")}
                title="Video settings"
                aria-label="Video device settings"
              >
                <IconChevronUp size={16} />
              </button>
            </div>
          </div>
          {/* Leave — the red hang-up right beside the media pill (Figma). Shared
              with the call dock via <LeaveControl>: hosts AND co-hosts get the
              split pill (Leave | ▾ End / End for everyone), everyone else gets
              a plain Leave that acts on the first click. */}
          {/* End-for-everyone is HOST-only on the server (complete() checks
              createdBy), matching Zoom/Teams where a co-host cannot end the
              meeting. Offering it to co-hosts on `canControl` showed them a
              button that always failed — gate on isHost so the UI matches. */}
          <LeaveControl
            canEndForAll={isHost}
            ariaLabel="Leave meeting"
            onLeave={leaveNow}
            onEnd={leaveNow}
            onEndForAll={endForAll}
          />
        </div>

        {/* RIGHT cluster: communication actions hug the media's right; Leave is
            pushed to the far edge (exception 2). */}
        <div className="ms-dock-group ms-dock-right">
          <button
            className={"ms-dock-btn" + (showSidePanel && chatOpen ? " on" : "")}
            onClick={() => {
              if (showSidePanel && chatOpen) setShowSidePanel(false);
              else {
                setShowSidePanel(true);
                setChatOpen(true);
              }
            }}
            aria-label="Chat"
            title="Chat"
          >
            <span className="ms-dock-icon">
              <IconMessageSquare size={19} />
            </span>
            <span className="ms-dock-label">Chat</span>
            {chatUnread > 0 && !(showSidePanel && chatOpen) && (
              <span className="ms-dock-badge">
                {chatUnread > 99 ? "99+" : chatUnread}
              </span>
            )}
          </button>
          {/* BA/CEO #19: React is a first-class dock control (was buried in the
              More menu, so reactions felt broken/undiscoverable). */}
          <button
            className={"ms-dock-btn" + (showReactions ? " on" : "")}
            onClick={(e) => {
              // Read the rect SYNCHRONOUSLY, in the handler — see the matching
              // note in CallModal.tsx (React nulls currentTarget once the
              // handler returns, so a setState-updater closure is too late).
              const opening = !showReactions;
              if (opening) {
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                const PICKER_W = 378;
                const vw = window.innerWidth;
                let left = r.right - PICKER_W;
                left = Math.max(8, Math.min(left, vw - 8 - PICKER_W));
                setReactAnchor({ left, bottom: window.innerHeight - r.top + 10 });
              }
              setShowReactions(opening);
              setShowMoreMenu(false);
            }}
            disabled={!allowReact}
            aria-label="Send a reaction"
            title={
              allowReact
                ? "React"
                : "The host has turned off reactions for attendees"
            }
          >
            <span className="ms-dock-icon">
              <IconSmile size={19} />
            </span>
            <span className="ms-dock-label">React</span>
          </button>

            <div className="ms-dock-btn-wrap ms-share-wrap">
              <button
                className={
                  "ms-dock-btn" +
                  (screen ? " on" : screenPending ? " pending" : " share-idle")
                }
                onClick={
                  offline ||
                  (screenPending && !screen) ||
                  !screenShareSupported ||
                  (!screen && !allowScreen)
                    ? undefined
                    : toggleScreen
                }
                disabled={
                  offline ||
                  (screenPending && !screen) ||
                  !screenShareSupported ||
                  (!screen && !allowScreen)
                }
                aria-label={screen ? "Stop sharing" : "Share screen"}
                title={
                  !screenShareSupported
                    ? "Screen sharing isn't available in this browser"
                    : !screen && !allowScreen
                      ? "The host has turned off screen sharing"
                      : screen
                      ? "Stop sharing"
                      : "Share screen"
                }
              >
                <span className="ms-dock-icon">
                  {screen || screenPending ? (
                    <IconMonitor size={19} />
                  ) : (
                    <IconCast size={19} />
                  )}
                </span>
                <span className="ms-dock-label">
                  {screenPending
                    ? "Starting…"
                    : screen
                      ? "Stop sharing"
                      : "Share"}
                </span>
              </button>
            </div>

          {/* More ⋯ — overflow: raise hand / fullscreen / PiP / device / lock /
              Meeting Options. */}
          <div className="ms-more-wrap" style={{ position: "relative" }}>
            <button
              className={"ms-dock-btn" + (showMoreMenu ? " on" : "")}
              onClick={() => setShowMoreMenu((v) => !v)}
              aria-label="More options"
              title="More"
            >
              <span className="ms-dock-icon">
                <IconMoreHorizontal size={19} />
              </span>
              <span className="ms-dock-label">More</span>
            </button>
            {showMoreMenu && (
              <div className="ms-more-menu">
                <button
                  className="ms-more-item"
                  onClick={() => {
                    toggleHandRaise();
                    setShowMoreMenu(false);
                  }}
                  disabled={offline || (!handRaised && !allowReact)}
                  title={
                    !handRaised && !allowReact
                      ? "The host has turned off reactions for attendees"
                      : undefined
                  }
                >
                  <IconHand size={17} />
                  {handRaised ? "Lower hand" : "Raise hand"}
                </button>
                {/* View preferences (shared with calls — components/ViewMenuSection). */}
                <ViewMenuSection prefs={viewPrefs} onChange={setViewPref} />
                {/* Spatial audio toggle removed — the feature is masked off
                    (spatialOn is hard-false). The manager plumbing stays. */}
                <button
                  className="ms-more-item"
                  onClick={() => {
                    toggleFullscreen();
                    setShowMoreMenu(false);
                  }}
                >
                  <svg viewBox="0 0 24 24">
                    {isFullscreen ? (
                      <>
                        <polyline points="4 14 10 14 10 20" />
                        <polyline points="20 10 14 10 14 4" />
                        <line x1="14" y1="10" x2="21" y2="3" />
                        <line x1="3" y1="21" x2="10" y2="14" />
                      </>
                    ) : (
                      <>
                        <polyline points="15 3 21 3 21 9" />
                        <polyline points="9 21 3 21 3 15" />
                        <line x1="21" y1="3" x2="14" y2="10" />
                        <line x1="3" y1="21" x2="10" y2="14" />
                      </>
                    )}
                  </svg>
                  {isFullscreen ? "Exit fullscreen" : "Fullscreen"}
                </button>
                {onMinimize && (
                  <button
                    className="ms-more-item"
                    onClick={async () => {
                      setShowMoreMenu(false);
                      // BUGFIX: minimizing to PiP is a React/CSS state change, but
                      // native fullscreen is a browser layer ON TOP of the DOM — the
                      // PiP change is invisible underneath it. Exit native fullscreen
                      // FIRST, then minimize, so PiP actually shows.
                      if (fsElement()) {
                        try { await fsExit(); } catch {}
                      }
                      onMinimize();
                    }}
                  >
                    <IconPictureInPicture size={17} />
                    Picture in picture
                  </button>
                )}
                {/* Device handoff (P0-12): move / extend this meeting to
                    another of the user's signed-in devices. */}
                {onMoveDevice && (
                  <button
                    className="ms-more-item"
                    onClick={() => {
                      onMoveDevice();
                      setShowMoreMenu(false);
                    }}
                  >
                    <svg viewBox="0 0 24 24">
                      <rect x="2" y="3" width="13" height="9" rx="2" />
                      <path d="M8 21h4M10 16v5" />
                      <rect x="16" y="8" width="6" height="11" rx="1.5" />
                    </svg>
                    {/* See the note at the call-side copy of this item in
                        CoLabV1.tsx: this transfers to another SIGNED-IN DEVICE,
                        not a second monitor. Label renamed by request. */}
                    Move To Another Screen
                  </button>
                )}
                {/* Background blur — a personal video setting, so it is above
                    the host-only controls and available to everyone. Disabled
                    with an explanation when the camera is off, because there is
                    nothing to apply it to. */}
                <button
                  className={"ms-more-item" + (bgMode === "blur" ? " on" : "")}
                  onClick={() => {
                    setBgMode(bgMode === "blur" ? "none" : "blur");
                    setShowMoreMenu(false);
                  }}
                  disabled={!cam}
                  title={
                    !cam
                      ? "Turn your camera on to blur your background"
                      : bgMode === "blur"
                        ? "Turn off background blur"
                        : "Blur what's behind you"
                  }
                >
                  <IconSparkles size={17} />
                  {bgMode === "blur" ? "Remove background blur" : "Blur my background"}
                  {bgMode === "blur" && bgDegrade > 0 ? (
                    <span className="ms-more-hint">reduced quality</span>
                  ) : null}
                </button>
                {isHost && (
                  <button
                    className="ms-more-item"
                    onClick={() => {
                      toggleLock();
                      setShowMoreMenu(false);
                    }}
                  >
                    {locked ? (
                      <IconLock size={17} />
                    ) : (
                      <IconLockOpen size={17} />
                    )}
                    {locked ? "Unlock meeting" : "Lock meeting"}
                  </button>
                )}
                {/* The "Recordings" entry was REMOVED alongside the Record
                    button — an in-meeting list that can no longer gain entries
                    is just a dead end. Host controls (Mute all, Lobby) live in
                    the SAME MeetingRoom panel and are still reachable through
                    "Meeting Options" below, so nothing was stranded by dropping
                    this opener. Past recordings remain available from the
                    meeting's Recordings tab in the Meetings module. */}
                {canControl && onMoreOptions && (
                  <button
                    className="ms-more-item"
                    onClick={() => {
                      onMoreOptions();
                      setShowMoreMenu(false);
                    }}
                  >
                    <svg viewBox="0 0 24 24">
                      <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" />
                      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
                    </svg>
                    Meeting Options
                  </button>
                )}
              </div>
            )}
          </div>

        </div>
      </div>
    </div>
  );
}
