import { mergedAvatarOf, colorOf, initialsOf } from "../../lib/meeting/identity";
import { groupChatMessages } from "../meeting/chatGroups";
import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  IconBell,
  IconBellOff,
  IconHand,
  IconMessageSquare,
  IconChevronLeft,
  IconChevronRight,
  IconSearch,
  IconMic,
  IconMicOff,
  IconMonitor,
  IconCast,
  IconMoreHorizontal,
  IconMoreVertical,
  IconPaperclip,
  IconPencil,
  IconSmile,
  IconUserPlus,
  IconUsers,
  IconVideo,
  IconVideoOff,
  IconVolume2,
  IconX, IconInfoOutline, IconMenu, IconCheckCheck, IconCopy
} from "../../lib/icons";
import QrCode from "../QrCode";
import Avatar from "../Avatar";
import Select from "../ui/Select";
import LayoutPicker from "../LayoutPicker";
import WeakNetworkBanner from "../WeakNetworkBanner";
import ViewMenuSection from "../ViewMenuSection";
import RingingCard from "./RingingCard";
import CallChatAttachment from "./CallChatAttachment";
import MutedSpeakingPrompt from "../MutedSpeakingPrompt";
import RemoteControlLayer from "../RemoteControlLayer";
import { InlineMentionPopover } from "../../lib/useInlineMentions";
import { AddParticipantsModal } from "../Modals";
import { EmojiPicker } from "../EmojiPicker";
import LeaveControl from "../LeaveControl";
import Whiteboard from "../Whiteboard";
import { api } from "../../lib/api";
import { canScreenShare } from "../../lib/mediaSupport";
import { fsRequest, fsExit, fsElement } from "./helpers";
import { useCallSessionCore } from "./call/useCallSessionCore";
import { useCallSessionControls } from "./call/useCallSessionControls";
import { useCallSessionMedia } from "./call/useCallSessionMedia";
import type { CallModalProps } from "./call/types";

// CallModal (call stage + ringing card) — the JSX render shell. All state, the
// LiveKit media lifecycle and the control actions live in the colab/call hooks;
// this file only assembles the session and renders it.
export default function CallModal(props: CallModalProps) {
  const {
    call,
    chatConversationId,
    huddles,
    token,
    meId,
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
  const core = useCallSessionCore(props);
  const controls = useCallSessionControls(props, core);
  useCallSessionMedia(props, core, controls);
  const {
    addOpen, audioBlocked, audioRef, callChatDraft, callChatEmoji, callChatEmojiAnchor, callChatFileRef, callChatMsgs,
    callChatMuted, callChatUnread, callChatUploading, callDevicesOpen, callFocusedScreenPid, callHands, callMentions, callMoreOpen,
    callPanelTab, callPartMenu, callPinnedSids, callReactions, callRoster, callScreenShares, callScreenViewMode, callTotalTiles,
    callViewMode, cam, canAddPeople, canMuteEveryone, devices, dir, endCallForAll, fullscreen,
    getShareRect, isCallHost, isGroup, kind, leaveCallNow, mediaError, mediaLive, mediaPhase,
    mic, openCallTileMenuRef, peer, peerRecording, peoplePanelOpen, presenter, pttTalking, rcSharer,
    reactOpen, recBusy, recording, remoteJoined, remoteVideoOn, roomRef, screen, screenPending, selCam,
    selMic, selSpk, setAddOpen, setAudioBlocked, setCallChatDraft, setCallChatEmoji, setCallChatEmojiAnchor, setCallDevicesOpen,
    setCallFocusedScreenPid, setCallMoreOpen, setCallPanelTab, setCallPinnedSids, setCallScreenViewMode, setCallViewMode, setMediaError, setMediaPhase,
    setMediaRetryKey, setPeoplePanelOpen, setReactOpen, setShowCallWhiteboard, showCallWhiteboard, spatialOn, spk, stageRef,
    status, tilesRef, toggleCallChatMuted, toggleCallPin, toggleFullscreen, video, wbResyncNonce, netQuality,
    callPage, callPageCount, setCallPage, callSpotlightUids, callSpotlightBy, callSpotlightEscaped,
    setCallSpotlightEscaped, toggleCallSpotlight, callViewPrefs, setCallViewPref, } = core;
  // People-panel filter (parity with the meeting panel).
  const [peopleQuery, setPeopleQuery] = useState("");
  // Call-details popover (the "i" by the title — parity with the meeting top
  // bar). Closes on Escape or on a click anywhere outside it.
  const [showCallInfo, setShowCallInfo] = useState(false);
  // Anchors the reaction popover to the React button itself (right edges
  // aligned, opening upward) instead of centring it on the stage.
  const [reactAnchor, setReactAnchor] = useState<{ left: number; bottom: number } | null>(null);
  // Close it on an outside click or Escape — mirrors MeetingStage's identical
  // handling for its own reaction popover (.ms-reaction-group). It's a body
  // portal now, but `closest()` walks the real DOM regardless of the React
  // tree, so this still correctly ignores clicks inside the popover itself.
  useEffect(() => {
    if (!reactOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (!t || !t.closest) return;
      if (t.closest(".cv-reaction-picker")) return;
      if (t.closest('[aria-label="Send a reaction"]')) return;
      setReactOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setReactOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [reactOpen]);
  useEffect(() => {
    if (!showCallInfo) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && !t.closest(".ms-info-wrap")) setShowCallInfo(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowCallInfo(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [showCallInfo]);
  const callInfoId = String((call && (call.callId || call.id)) || "");
  // Join link = the ?conversation=<id> deep link CoLabV1 handles on load: it opens
  // the chat this call lives in, where the call banner / "Join" is. Same role as
  // the meeting popover's ?meeting= link, and what its QR encodes.
  const callChatId = (call && call.conversationId) || chatConversationId || null;
  const callJoinLink =
    typeof window !== "undefined" && callChatId
      ? `${window.location.origin}/?conversation=${callChatId}`
      : "";
  const copyCallInfo = (text: string, what: string) => {
    try {
      navigator.clipboard.writeText(text).then(
        () => showToast && showToast(`${what} copied`),
        () => showToast && showToast("Couldn't copy"),
      );
    } catch {
      showToast && showToast("Couldn't copy");
    }
  };
  const {
    CALL_REACTIONS, hh, insertCallChatEmoji, mm, muteAllGroup, mutePeerInGroup, openCallTileMenu, sendCallChat,
    sendCallChatFile, sendCallReaction, ss, switchCam, switchMic, switchSpk, toggleCallHand, toggleCam,
    toggleMic, toggleRecord, toggleScreen, toggleSpk, wbBroadcast, wbLoad, wbRegisterReceiver, wbSave, } = controls;
  const callTime = hh > 0 ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
  // Recording elapsed time for the header pill. Counts from the moment ANY
  // recording (yours, the server's, or a peer's) starts; hidden when none is on.
  const isRec = !!(recording || peerRecording);
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

  const phaseDotColor =
    mediaPhase === "connected"
      ? "#22C55E"
      : mediaPhase === "failed"
        ? "#EF4444"
        : "#F59E0B";
  const phaseLabel =
    mediaPhase === "connected"
      ? `Connected \u00b7 ${callTime}`
      : mediaPhase === "failed"
        ? "Unable to reach media server"
        : isGroup
          ? "Joining\u2026"
          : remoteJoined
            ? "Reconnecting\u2026"
            : "Connecting\u2026";
  // Group call with 2+ people on it: a merged disc of their faces (others
  // first, you last, max 4). A 1:1 call keeps the peer's own avatar.
  const avatar =
    (isGroup && callRoster.length >= 2 && mergedAvatarOf(callRoster)) || {
      kind: "user",
      initials: peer.initials,
      color: peer.color,
      avatarUrl: peer.avatarUrl,
    };
  // ── Teams-style meeting layout ──────────────────────────────────────────
  // Full-screen dark stage, compact top header, central participant grid,
  // bottom-anchored control bar. Replaces the prototype "big card" layout.

  // Call-control icons now come from the shared lib/icons module (design system),
  // so the mic/camera/share/hang-up glyphs are identical to the rail, chat header
  // and meeting dock. The old inline-path `ic()`/`phone` helpers are retired.

  // ── Control button helpers ────────────────────────────────────────────
  const ctlStyle = (
    active?,
    danger?,
    accept?,
    disabled?,
  ): React.CSSProperties => ({
    width: 44,
    height: 44,
    borderRadius: "50%",
    border: "none",
    cursor: disabled ? "not-allowed" : "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: danger || accept || active ? "#fff" : "var(--meet-btn-fg)",
    background: danger
      ? "#EF4444"
      : accept
        ? "#22C55E"
        : active
          ? "var(--ac)"
          : "var(--meet-btn)",
    opacity: disabled ? 0.35 : 1,
    transition: "background .15s, opacity .15s",
  });

  // (Leave + side-control styling now comes from the shared meeting-dock CSS
  // classes .ms-dock-btn / .ms-dock-leave — see ctlBtn below — so calls and
  // meetings render an identical bottom bar.)

  // Each control shows its label under the icon (Skype-style), matching the
  // meeting dock; Leave stays a red pill with its label.
  const ctlBtn = (
    label,
    active,
    onClick,
    ariaLabel,
    children,
    danger?,
    disabled?,
    activeClass = " on",
    titleText?, // explicit tooltip (defaults to the label) — parity with meetings
    badge?: number, // unread count → meeting-parity .ms-dock-badge (e.g. call chat)
  ) => (
    // Uses the EXACT meeting-dock markup (.ms-dock-btn / .ms-dock-icon /
    // .ms-dock-label, and .ms-dock-leave for Leave), so the calls bottom bar is
    // visually identical to the meeting dock — same size, hover, active + off
    // states, labels. `activeClass` lets Record use the red `.rec-on` state.
    <button
      className={
        "ms-dock-btn" + (danger ? " ms-dock-leave" : active ? activeClass : "")
      }
      onClick={disabled ? undefined : onClick}
      disabled={!!disabled}
      aria-label={ariaLabel}
      title={titleText || label}
    >
      <span className="ms-dock-icon">{children}</span>
      <span className="ms-dock-label">{label}</span>
      {/* Always-visible unread badge (parity with the meeting dock Chat button,
          MeetingStage.tsx:4189) — the in-panel tab badge is invisible while the
          panel is closed, which is exactly when a chat notification is needed. */}
      {badge && badge > 0 ? (
        <span className="ms-dock-badge">{badge > 99 ? "99+" : badge}</span>
      ) : null}
    </button>
  );

  const mediaDisabled = !mediaLive;
  // Screen share needs getDisplayMedia, which iOS/iPadOS Safari lacks entirely —
  // gate the control so it's honestly disabled there instead of throwing on tap.
  const screenShareSupported = canScreenShare();

  // ── Control bar ───────────────────────────────────────────────────────
  // Reusable overflow-menu row (Skype "More") — icon + label, shared styling.
  const moreItem = (label, onClick, svg, disabled?) => (
    <button
      type="button"
      className="ms-more-item"
      disabled={!!disabled}
      onClick={
        disabled
          ? undefined
          : () => {
            onClick();
            setCallMoreOpen(false);
          }
      }
    >
      <svg viewBox="0 0 24 24">{svg}</svg>
      {label}
    </button>
  );

  const controlBar = (
    <div
      // Same class as the meeting dock (styles/call.css + v1.css .ms-dock), so
      // the Figma in-call restyle reaches calls and meetings from one place —
      // the inline copy of these rules is gone.
      className="ms-dock"
      role="group"
      aria-label="Call controls"
    >
      {/* LEFT: empty grid cell — balances the right column so the primary
          cluster sits truly centered. */}
      {/* LEFT cluster: collaboration actions, right-aligned so they hug the
          centred media controls; the far-left edge stays empty. */}
      <div className="ms-dock-group ms-dock-left">
        {/* P0-3: no primary "Participants" toolbar action — the People panel
            opens from the Participant-view toggle. Label is "Invite", matching
            the meeting dock. */}
        {canAddPeople
          ? ctlBtn(
            "Invite",
            false,
            () => setAddOpen(true),
            "Invite others",
            <IconUserPlus size={20} />,
            false,
            mediaDisabled,
          )
          : null}
        {/* Record button */}
        {ctlBtn(
          recording ? "Stop" : "Record",
          recording,
          toggleRecord,
          recording ? "Stop recording" : "Record call",
          <svg viewBox="0 0 24 24" width={20} height={20} fill={recording ? "#ef4444" : "none"} stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
            <circle cx="12" cy="12" r="8" fill={recording ? "#ef4444" : "none"} />
            <circle cx="12" cy="12" r="3" fill="currentColor" />
          </svg>,
          false,
          mediaDisabled || recBusy,
          " rec-on",
          recording ? "Stop recording" : "Record call",
        )}
        {/* People panel (roster) — its own button; the stage LAYOUT is a separate
            picker below (it used to open this panel as a fake "speaker view"). */}
        {ctlBtn(
          "Participants",
          peoplePanelOpen && callPanelTab === "people",
          () => {
            if (peoplePanelOpen && callPanelTab === "people") {
              setPeoplePanelOpen(false);
            } else {
              setPeoplePanelOpen(true);
              setCallPanelTab("people");
            }
          },
          peoplePanelOpen && callPanelTab === "people" ? "Hide participants" : "Show participants",
          <svg viewBox="0 0 24 24" width={20} height={20} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="9" cy="8" r="3.5" />
            <path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6" />
            <circle cx="17" cy="9" r="2.8" />
            <path d="M16 14.2c3.2.2 5.5 2.4 5.5 5.8" />
          </svg>,
        )}
        {ctlBtn(
          "Whiteboard",
          showCallWhiteboard,
          () => setShowCallWhiteboard((v) => !v),
          showCallWhiteboard ? "Close whiteboard" : "Open whiteboard",
          <IconPencil size={20} />,
          false,
          false,
        )}
      </div>

      {/* CENTER cluster: the round mic/camera controls — the ABSOLUTE middle. */}
      <div className="ms-dock-group ms-dock-center">
        {/* Round media controls — shared with the meeting dock. Camera-on fills
            accent; muted / camera-off go red. */}
        <div className="ms-dock-media">
          <div className="ms-dock-btn-wrap">
            <button
              className={"ms-dock-btn" + (mic || pttTalking ? "" : " off")}
              onClick={mediaDisabled ? undefined : toggleMic}
              disabled={mediaDisabled}
              aria-label={mic ? "Mute microphone" : "Unmute microphone (or hold Space to talk)"}
              title={pttTalking ? "Talking…" : mic ? "Mute" : "Unmute"}
            >
              <span className="ms-dock-icon">
                {mic || pttTalking ? <IconMic size={19} /> : <IconMicOff size={19} />}
              </span>
              <span className="ms-dock-label">{mic ? "Mute" : "Unmute"}</span>
            </button>
            <button
              className="ms-dock-chevron"
              onClick={() => setCallDevicesOpen((v) => !v)}
              title="Audio settings"
              aria-label="Audio device settings"
            >
              <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 15l6-6 6 6" /></svg>
            </button>
          </div>
          <div className={"ms-dock-btn-wrap" + (cam ? " cam-on" : "")}>
            <button
              className={"ms-dock-btn" + (cam ? "" : " off")}
              onClick={mediaDisabled ? undefined : toggleCam}
              disabled={mediaDisabled}
              aria-label={cam ? "Stop camera" : "Start camera"}
              title={cam ? "Stop video" : "Start video"}
            >
              <span className="ms-dock-icon">
                {cam ? <IconVideo size={19} /> : <IconVideoOff size={19} />}
              </span>
              <span className="ms-dock-label">{cam ? "Stop video" : "Start video"}</span>
            </button>
            <button
              className="ms-dock-chevron"
              onClick={() => setCallDevicesOpen((v) => !v)}
              title="Video settings"
              aria-label="Video device settings"
            >
              <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 15l6-6 6 6" /></svg>
            </button>
          </div>
          {/* Screen share as a MEDIA-style button (image order: mic · cam · screen)
            so it's RED when OFF exactly like mic/cam; its presentation-view
            switcher appears right next to it while sharing. Kept INSIDE
            ms-dock-media (matching MeetingStage) so it gets the same 40px in-pill
            circle style — as a sibling it fell back to the base rectangle. */}
          {/* Share is a split control (mic/camera parity): the pill toggles sharing,
            the chevron opens the presentation-mode menu ("screen share modes"). */}
        </div>
        {/* Leave — the red hang-up beside the media pill (reference dock). Same
            <LeaveControl> the meeting dock uses, so the two never diverge.
            The call HOST (starter, or a group owner/admin who joined) gets the
            same split pill a meeting host gets. There is no single "end the
            room" call endpoint the way meetings have api.completeMeeting, but
            the host-gated remove-participant controls already exist and
            removing someone ends the call for them — so End-for-everyone is
            composed from those, then hangs the host up last. */}
        {/* 1:1 calls get a PLAIN "Leave" pill — there is exactly one other person,
            so hanging up already ends the call for both; an "End for everyone"
            split menu there is redundant and confusing. Split pill = group only. */}
        <LeaveControl
          canEndForAll={isCallHost && isGroup}
          ariaLabel="End call"
          sessionNoun="call"
          onLeave={leaveCallNow}
          onEnd={leaveCallNow}
          onEndForAll={endCallForAll}
        />
      </div>

      {/* RIGHT cluster: communication actions hug the media's right; Leave is
          pushed to the far edge (exception 2). */}
      <div className="ms-dock-group ms-dock-right">
        {/* Chat — opens the in-call panel on its Chat tab (People | Chat). Carries
            the unread badge so a peer's message notifies you even while the panel
            is closed (parity with the meeting dock Chat button). */}
        {ctlBtn(
          "Chat",
          peoplePanelOpen && callPanelTab === "chat",
          () => {
            if (peoplePanelOpen && callPanelTab === "chat") {
              setPeoplePanelOpen(false);
            } else {
              setPeoplePanelOpen(true);
              setCallPanelTab("chat");
            }
          },
          "In-call chat",
          <IconMessageSquare size={20} />,
          false,
          false,
          undefined,
          undefined,
          peoplePanelOpen && callPanelTab === "chat" ? 0 : callChatUnread,
        )}
        {/* React — right cluster, after Chat (reference dock). Its popover
            anchors to THIS button (computed rect, opens upward, right edges
            aligned) instead of floating centred on the stage. */}
        {ctlBtn(
          "React",
          reactOpen,
          (e: React.MouseEvent) => {
            // Read the button's rect SYNCHRONOUSLY, in the handler — React
            // nulls out the synthetic event's currentTarget once the handler
            // returns, so reaching for it from inside a setState updater
            // (which can run later, e.g. under Strict Mode's double-invoke)
            // throws. Compute first, flip state after.
            const opening = !reactOpen;
            if (opening) {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              const PICKER_W = 378;
              const vw = window.innerWidth;
              let left = r.right - PICKER_W;
              left = Math.max(8, Math.min(left, vw - 8 - PICKER_W));
              setReactAnchor({ left, bottom: window.innerHeight - r.top + 10 });
            }
            setReactOpen(opening);
            setCallMoreOpen(false);
          },
          "Send a reaction",
          <svg viewBox="0 0 24 24" width={20} height={20} fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
            <circle cx="12" cy="12" r="10" />
            <path d="M8 14s1.5 2 4 2 4-2 4-2" />
            <line x1="9" y1="9" x2="9.01" y2="9" />
            <line x1="15" y1="9" x2="15.01" y2="9" />
          </svg>,
          false,
          mediaDisabled,
        )}
        <div className="ms-dock-btn-wrap ms-share-wrap">
          <button
            className={"ms-dock-btn" + (screen ? " on" : screenPending ? " pending" : " share-idle")}
            onClick={
              mediaDisabled || (screenPending && !screen) || !screenShareSupported
                ? undefined
                : toggleScreen
            }
            disabled={mediaDisabled || (screenPending && !screen) || !screenShareSupported}
            aria-label={screen ? "Stop sharing" : "Share screen"}
            title={
              !screenShareSupported
                ? "Screen sharing isn't available in this browser"
                : screenPending
                  ? "Starting…"
                  : screen
                    ? "Stop sharing"
                    : "Share screen"
            }
          >
            <span className="ms-dock-icon">{screen || screenPending ? <IconMonitor size={19} /> : <IconCast size={19} />}</span>
            <span className="ms-dock-label">
              {screenPending ? "Starting…" : screen ? "Stop sharing" : "Share"}
            </span>
          </button>
        </div>
        <div className="ms-more-wrap" style={{ position: "relative" }}>
          <button
            type="button"
            className={"ms-dock-btn" + (callMoreOpen ? " on" : "")}
            onClick={() => setCallMoreOpen((v) => !v)}
            aria-label="More options"
            title="More"
          >
            <span className="ms-dock-icon"><IconMoreHorizontal size={20} /></span>
            <span className="ms-dock-label">More</span>
          </button>
          {callMoreOpen && (
            <>
              <div
                onClick={() => setCallMoreOpen(false)}
                style={{ position: "fixed", inset: 0, zIndex: 199 }}
              />
              {/* Raise hand lives here (overflow); React was promoted to the
                  main dock (BA/CEO #19). */}
              <div className="ms-more-menu" style={{ zIndex: 200 }}>
                {/* View preferences (shared with meetings). */}
                <ViewMenuSection prefs={callViewPrefs} onChange={setCallViewPref} />
                {moreItem(
                  callHands.some((h) => h.id === "__me__") ? "Lower hand" : "Raise hand",
                  toggleCallHand,
                  <>
                    <path d="M18 11V6a2 2 0 0 0-4 0M14 10V4a2 2 0 0 0-4 0v2M10 10.5V6a2 2 0 0 0-4 0v8" />
                    <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
                  </>,
                  mediaDisabled,
                )}
                {moreItem(
                  spk ? "Speaker on" : "Speaker off",
                  toggleSpk,
                  <>
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                    <path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07" />
                  </>,
                  mediaDisabled,
                )}
                {/* Spatial audio toggle removed — masked off (spatialOn is
                    hard-false). The manager plumbing stays in its disabled path. */}
                {canMuteEveryone
                  ? moreItem(
                    "Mute all",
                    muteAllGroup,
                    <>
                      <line x1="1" y1="1" x2="23" y2="23" />
                      <path d="M9 9v3a3 3 0 005.12 2.12M15 9.34V4a3 3 0 00-5.94-.6" />
                      <path d="M17 16.95A7 7 0 015 12" />
                    </>,
                    mediaDisabled,
                  )
                  : null}
                {onMinimize && status === "connected"
                  ? moreItem(
                    "Minimize",
                    // BUGFIX: exit native fullscreen BEFORE minimizing to PiP —
                    // otherwise the PiP (React/CSS) state change is hidden under
                    // the browser's fullscreen layer and Minimize appears to do
                    // nothing / stay fullscreen.
                    async () => {
                      if (fsElement()) {
                        try { await fsExit(); } catch { }
                      }
                      onMinimize();
                    },
                    <>
                      <rect x="3" y="4" width="18" height="14" rx="2" ry="2" />
                      <rect
                        x="12.5"
                        y="11"
                        width="6.5"
                        height="5"
                        rx="1"
                        fill="currentColor"
                        stroke="none"
                      />
                    </>,
                  )
                  : null}
                {moreItem(
                  fullscreen ? "Exit fullscreen" : "Fullscreen",
                  toggleFullscreen,
                  fullscreen ? (
                    <path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3" />
                  ) : (
                    <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" />
                  ),
                )}
                {moreItem(
                  "Devices",
                  () => setCallDevicesOpen(true),
                  <>
                    <path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z" />
                    <path d="M19 10v2a7 7 0 01-14 0v-2" />
                    <line x1="12" y1="19" x2="12" y2="23" />
                  </>,
                )}
                {onMoveDevice && status === "connected"
                  ? moreItem(
                    // Renamed from "Move to another device" by request.
                    // NOTE: the feature transfers the session to another of
                    // YOUR SIGNED-IN DEVICES (another browser or the desktop
                    // app), not to a second monitor — see DeviceHandoff.tsx,
                    // which lists signed-in devices. The dialog body still has
                    // to say "devices" to remain truthful, so the label and
                    // the sheet under it are deliberately not identical.
                    "Move To Another Screen",
                    onMoveDevice,
                    <>
                      <rect x="2" y="3" width="13" height="9" rx="2" />
                      <path d="M8 21h4M10 16v5" />
                      <rect x="16" y="8" width="6" height="11" rx="1.5" />
                    </>,
                  )
                  : null}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );

  // ── Device selectors ──────────────────────────────────────────────────
  // Speaker routing is Chromium-only (setSinkId); hide the picker where it
  // can't take effect so we never show a control that silently no-ops.
  const canPickSpeaker =
    typeof HTMLMediaElement !== "undefined" &&
    typeof HTMLMediaElement.prototype.setSinkId === "function" &&
    devices.speakers.length > 0;
  const devicePickers =
    devices.mics.length > 0 || devices.cams.length > 0 || canPickSpeaker ? (
      <div
        style={{
          display: "flex",
          gap: 8,
          justifyContent: "center",
          flexWrap: "wrap",
          marginTop: 8,
        }}
      >
        {devices.mics.length > 0 && (
          <Select
            value={selMic}
            onChange={(e) => switchMic(e.target.value)}
            aria-label="Microphone"
            style={{
              fontSize: 11,
              maxWidth: 200,
              borderRadius: 6,
              padding: "3px 6px",
              background: "var(--meet-pop)",
              color: "var(--meet-fg)",
              border: "1px solid var(--meet-btn-line)",
              textOverflow: "ellipsis",
              overflow: "hidden",
              whiteSpace: "nowrap",
            }}
          >
            {devices.mics.map((d, i) => (
              <option key={d.deviceId || i} value={d.deviceId}>
                {d.label || `Microphone ${i + 1}`}
              </option>
            ))}
          </Select>
        )}
        {devices.cams.length > 0 && (
          <Select
            value={selCam}
            onChange={(e) => switchCam(e.target.value)}
            aria-label="Camera"
            style={{
              fontSize: 11,
              maxWidth: 200,
              borderRadius: 6,
              padding: "3px 6px",
              background: "var(--meet-pop)",
              color: "var(--meet-fg)",
              border: "1px solid var(--meet-btn-line)",
              textOverflow: "ellipsis",
              overflow: "hidden",
              whiteSpace: "nowrap",
            }}
          >
            {devices.cams.map((d, i) => (
              <option key={d.deviceId || i} value={d.deviceId}>
                {d.label || `Camera ${i + 1}`}
              </option>
            ))}
          </Select>
        )}
        {canPickSpeaker && (
          <Select
            value={selSpk}
            onChange={(e) => switchSpk(e.target.value)}
            aria-label="Speaker"
            style={{
              fontSize: 11,
              maxWidth: 200,
              borderRadius: 6,
              padding: "3px 6px",
              background: "var(--meet-pop)",
              color: "var(--meet-fg)",
              border: "1px solid var(--meet-btn-line)",
              textOverflow: "ellipsis",
              overflow: "hidden",
              whiteSpace: "nowrap",
            }}
          >
            {devices.speakers.map((d, i) => (
              <option key={d.deviceId || i} value={d.deviceId}>
                {d.label || `Speaker ${i + 1}`}
              </option>
            ))}
          </Select>
        )}
      </div>
    ) : null;

  // ── Status pill (top header) ──────────────────────────────────────────
  const statusPill = (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 12,
        color: "var(--meet-fg)",
        background: "var(--meet-btn)",
        padding: "3px 10px",
        borderRadius: 999,
      }}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: phaseDotColor,
        }}
      />
      {phaseLabel}
    </span>
  );

  // ── Badges (screen share, recording) ──────────────────────────────────
  const badges = (
    <>
      {screen && mediaLive ? (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            fontSize: 11,
            color: "#fff",
            background: "#EF4444",
            padding: "3px 10px",
            borderRadius: 999,
            cursor: "pointer",
          }}
          onClick={toggleScreen}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: "#fff",
            }}
          />
          Sharing · Stop
        </span>
      ) : null}
    </>
  );

  // ── Ringing card (compact, centered) ──────────────────────────────────
  const ringingCard = (
    <RingingCard
      avatar={avatar}
      peer={peer}
      video={video}
      status={status}
      dir={dir}
      onDecline={onDecline}
      onAccept={onAccept}
      onCancel={onCancel}
      ctlStyle={ctlStyle}
    />
  );

  // ── Connected: full-screen meeting stage ──────────────────────────────
  const meetingStage = (
    <div
      className="call-stage-enter"
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        background: "var(--meet-bg)",
        color: "var(--meet-fg)",
        zIndex: 1000,
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Call"
      data-call-view
    >
      {/* ── Top header ── */}
      <div className="call-chrome call-topbar">
        <div className="call-topbar-left">
          {/* Top-left ☰ — the collaboration sidebar (chat with anyone WITHOUT
              leaving the call). The People panel opens from the Participant-
              view toggle; in-call chat from the Chat button. */}
          {onOpenComms && (
            <button
              type="button"
              onClick={onOpenComms}
              title="Chat with anyone while on the call"
              aria-label={commsUnread > 0 ? "Open chat sidebar (unread messages)" : "Open chat sidebar"}
              className="ms-topbar-btn ms-topbar-menu"
              style={{ position: "relative", flexShrink: 0 }}
            >
              <IconMenu size={18} />
              {commsUnread > 0 && (
                <span
                  aria-hidden="true"
                  style={{
                    position: "absolute",
                    top: 4,
                    right: 4,
                    width: 9,
                    height: 9,
                    borderRadius: "50%",
                    background: "#ef4444",
                    border: "2px solid var(--meet-pop, #1b1f2a)",
                  }}
                />
              )}
            </button>
          )}
          <Avatar avatar={avatar} size={32} />
          <span className="call-topbar-titlewrap">
            <span className="ms-topbar-titlerow">
              <span className="call-topbar-title">
                {isGroup ? call.name || peer.name : peer.name}
              </span>
              {/* Info (i) → call details (ID, type, who's on, elapsed time). Same
              button + popover chrome as the meeting top bar. */}
              <div className="ms-info-wrap" style={{ position: "relative", flexShrink: 0 }}>
                <button
                  type="button"
                  className={"ms-topbar-btn ms-info-btn" + (showCallInfo ? " on" : "")}
                  onClick={() => setShowCallInfo((v) => !v)}
                  title="Call info"
                  aria-label="Call info"
                  aria-expanded={showCallInfo}
                >
                  <IconInfoOutline size={20} className="ms-info-glyph" />
                </button>
                {showCallInfo && (
                  <div className={"ms-info-pop" + (callJoinLink ? " has-qr" : "")} role="dialog" aria-label="Call details">
                    {/* Same layout as the meeting popover: details column + a QR of
                    the join link on the right (when the call has a conversation). */}
                    <div className="ms-info-main">
                      <div className="ms-info-pop-title">
                        {isGroup ? call.name || peer.name : peer.name}
                      </div>
                      {callInfoId && (
                        <div className="ms-info-row">
                          <span className="ms-info-label">Call ID</span>
                          {/* Ellipsized by CSS; title + Copy carry the full id. */}
                          <span className="ms-info-val" title={callInfoId}>{callInfoId}</span>
                          <button
                            type="button"
                            className="ms-info-copy"
                            aria-label="Copy call ID"
                            title="Copy call ID"
                            onClick={() => copyCallInfo(callInfoId, "Call ID")}
                          >
                            <IconCopy size={18} />
                          </button>
                        </div>
                      )}
                      {callJoinLink && (
                        <div className="ms-info-row">
                          <span className="ms-info-label">Join link</span>
                          <span className="ms-info-val" title={callJoinLink}>{callJoinLink}</span>
                          <button
                            type="button"
                            className="ms-info-copy"
                            aria-label="Copy join link"
                            title="Copy join link"
                            onClick={() => copyCallInfo(callJoinLink, "Link")}
                          >
                            <IconCopy size={18} />
                          </button>
                        </div>
                      )}
                      <div style={{ display: 'none' }} className="ms-info-row">
                        <span className="ms-info-label">Type</span>
                        <span className="ms-info-val">
                          {(isGroup ? "Group " : "1:1 ") + (video ? "video call" : "audio call")}
                        </span>
                      </div>
                      <div style={{ display: 'none' }} className="ms-info-row">
                        <span className="ms-info-label">People</span>
                        <span className="ms-info-val">
                          {callRoster.length > 0
                            ? callRoster.map((p: any) => (p && p.name) || "").filter(Boolean).join(", ") ||
                            `${callRoster.length} on the call`
                            : "Waiting for others to join"}
                        </span>
                      </div>
                      <div style={{ display: 'none' }} className="ms-info-row">
                        <span className="ms-info-label">Duration</span>
                        <span className="ms-info-val">{mediaPhase === "connected" ? callTime : phaseLabel}</span>
                      </div>
                    </div>
                    {callJoinLink && (
                      <div className="ms-info-qr">
                        <QrCode value={callJoinLink} size={86} title="Scan to open this call's chat" />
                      </div>
                    )}
                  </div>
                )}
              </div>
            </span>
            {/* Participant TOGGLE — the exact same compact pill as the meeting
                top bar (.ms-topbar-people): icon + bare count, no caption text.
                Clicking opens the People panel. Every participant sees it (1:1
                and group alike) — viewing who is on the call is not a host
                privilege. */}
            {callRoster.length > 0 && (
              <button
                type="button"
                className="ms-topbar-people"
                onClick={() => {
                  setPeoplePanelOpen(true);
                  setCallPanelTab("people");
                }}
                title={`${callRoster.length} participant${callRoster.length === 1 ? "" : "s"} — show People`}
                aria-label="Show participants"
              >
                {callRoster.length} of {callRoster.length} in the call
                {mediaPhase === "connected" ? (
                  <>
                    <span className="ms-topbar-sep" aria-hidden="true">|</span>
                    {callTime}
                  </>
                ) : null}
              </button>
            )}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
          {badges}
          {/* Recording pill: red dot + recording elapsed time. Only while a
              recording is running — call duration lives in the subtitle. */}
          {isRec && (
            <div className="ms-topbar-timer rec" title={"Recording · " + fmtRec(recElapsed)}>
              <span className="ms-rec-dot" aria-label="Recording" />
              {fmtRec(recElapsed)}
            </div>
          )}
          {/* View — Speaker · Speaker bottom strip · Gallery · Focus. */}
          <LayoutPicker variant="topbar" value={callViewMode} onChange={setCallViewMode} />
        </div>
      </div>

      {/* Audio blocked by the browser (Safari/iOS/Chrome autoplay policy) — one tap to enable */}
      {audioBlocked ? (
        <button
          onClick={() => {
            const r = roomRef.current;
            if (r)
              r.startAudio()
                .then(() => setAudioBlocked(false))
                .catch(() => { });
          }}
          style={{
            position: "absolute",
            top: 56,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 20,
            display: "flex",
            alignItems: "center",
            gap: 8,
            background: "#f59e0b",
            color: "#1b1b2f",
            border: "none",
            borderRadius: 999,
            padding: "8px 18px",
            fontSize: 13,
            fontWeight: 700,
            cursor: "pointer",
            boxShadow: "0 4px 16px rgba(0,0,0,.3)",
          }}
        >
          <IconVolume2 size={16} />
          Tap to enable sound
        </button>
      ) : null}

      {/* ── Central stage ── */}
      <div
        style={{
          flex: 1,
          // min-height:0 lets this flex-grow child shrink correctly inside the
          // column instead of being floored by its min-content height.
          minHeight: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
          position: "relative",
          padding: 4,
          // The People panel docks on the RIGHT (Teams-style), so reserve room
          // on the RIGHT — the video grid shrinks beside it instead of being
          // overlapped + leaving a dead gap on the left.
          paddingRight: peoplePanelOpen ? 350 : 4,
          // FLICKER FIX: do NOT animate padding — it's a LAYOUT property, so a
          // 180ms transition re-ran the whole tile grid's sizing every frame
          // while the People/Chat panel opened. Snap it (single reflow, like the
          // meeting panel); the panel itself slides via its own transform.
          contain: "layout",
        }}
      >
        {/* Concurrent screen shares → a floating "who to view" switcher (only
            with 2+ live shares; single-share is untouched). Reuses the meeting
            switcher styles. Each viewer picks independently — spotlight one, or
            Both/All for a side-by-side split. Purely local. */}
        {callScreenShares.length >= 2 && !showCallWhiteboard && (
          <div
            className="ms-share-switcher"
            role="group"
            aria-label="Choose which shared screen to view"
            // Center over the VISIBLE video area, not the padding-box: the stage
            // reserves 328px on the right for the People/Chat panel, so shift left
            // by half that when it's open (otherwise the pill drifts toward/under
            // the panel).
            style={peoplePanelOpen ? { left: "calc(50% - 175px)" } : undefined}
          >
            <span className="ms-share-switcher-label">
              {callScreenShares.length} people are sharing
            </span>
            {callScreenShares.map((s) => (
              <button
                key={s.pid}
                type="button"
                className={
                  "ms-share-chip" +
                  (callScreenViewMode === "spotlight" &&
                    callFocusedScreenPid === s.pid
                    ? " active"
                    : "")
                }
                onClick={() => {
                  setCallScreenViewMode("spotlight");
                  setCallFocusedScreenPid(s.pid);
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
                (callScreenViewMode === "sideBySide" ? " active" : "")
              }
              onClick={() => setCallScreenViewMode("sideBySide")}
              title="View all shared screens side by side"
            >
              {callScreenShares.length === 2 ? "Both" : "All"}
            </button>
          </div>
        )}
        {/* Video tile grid (LiveKit attaches tiles here). Columns/rows are
            set imperatively by relayoutGrid() from participant count, so all
            tiles fit the viewport regardless of N. */}
        {/* Host spotlight overrides this viewer's layout — say who did it and give
            the per-viewer escape (parity with meetings). In flow above the stage,
            so it needs no positioned ancestor inside the call window. */}
        {callSpotlightUids.length > 0 && !callSpotlightEscaped && !pip ? (
          <div
            className="ms-spotlight-banner"
            role="status"
            style={{ position: "static", transform: "none", margin: "6px auto", alignSelf: "center", flexShrink: 0 }}
          >
            <span>Spotlighted by {callSpotlightBy || "you"}</span>
            <button
              type="button"
              className="ms-spotlight-return"
              onClick={() => setCallSpotlightEscaped(true)}
            >
              Return to my view
            </button>
          </div>
        ) : null}
        {mediaLive && (
          <WeakNetworkBanner
            quality={netQuality}
            camOn={!!cam}
            onTurnOffVideo={() => {
              if (cam) void toggleCam();
            }}
          />
        )}
        <div
          ref={stageRef}
          className={"cv-stage" + (isCallHost ? " can-manage" : "") + (peoplePanelOpen && !pip ? " panel-open" : "")}
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(1, minmax(0, 1fr))",
            gridTemplateRows: "repeat(1, minmax(0, 1fr))",
            gap: 6,
            width: "100%",
            // SAFARI/WebKit FIX (camera-off grid collapse): do NOT use height:100%
            // here. A percentage height on a flex item whose own height came from
            // flex-grow is treated as indefinite by WebKit, so the minmax(0,1fr)
            // rows collapse to the tiles' in-flow content height — which is ZERO
            // for a camera-off tile (avatar/label/buttons are all position:absolute),
            // so the grid vanished until a <video> injected intrinsic height (the
            // "only shows when I turn the camera on" bug). align-self:stretch gives
            // this child a DEFINITE flex cross-size WebKit resolves correctly, and
            // the .cv-stage min-height:180px floor (v1.css) mirrors .ms-stage.
            alignSelf: "stretch",
            maxWidth: "none",
            overflow: "hidden",
            ...(screen
              ? { border: "2px solid #EF4444", borderRadius: 12 }
              : {}),
          }}
        />
        {/* Gallery pages (parity with meetings): a big group call pages instead
            of shrinking every tile. In flow under the stage. */}
        {callPageCount > 1 && !pip ? (
          <div
            className="ms-pager"
            role="navigation"
            aria-label="Gallery pages"
            style={{ position: "static", transform: "none", margin: "6px auto 2px", alignSelf: "center", flexShrink: 0 }}
          >
            <button
              className="ms-pager-btn"
              onClick={() => setCallPage((n: number) => Math.max(0, n - 1))}
              disabled={callPage <= 0}
              aria-label="Previous page"
            >
              <IconChevronLeft size={16} />
            </button>
            <span className="ms-pager-label">
              {callPage + 1} / {callPageCount}
            </span>
            <button
              className="ms-pager-btn"
              onClick={() => setCallPage((n: number) => Math.min(callPageCount - 1, n + 1))}
              disabled={callPage >= callPageCount - 1}
              aria-label="Next page"
            >
              <IconChevronRight size={16} />
            </button>
          </div>
        ) : null}

        {showCallWhiteboard && (
          <div
            style={{
              position: "absolute",
              // Occupy the EXACT video-grid rect: match the central stage's
              // padding (4) and its paddingRight (328 when the People panel is
              // open on the RIGHT, else 4). The board then fills the tile area
              // and its right edge sits flush beside the panel like the grid.
              top: 4,
              left: 4,
              bottom: 4,
              right: peoplePanelOpen ? 350 : 4,
              zIndex: 5,
            }}
          >
            <Whiteboard
              broadcast={wbBroadcast}
              registerReceiver={wbRegisterReceiver}
              onClose={() => setShowCallWhiteboard(false)}
              title="Whiteboard"
              resyncNonce={wbResyncNonce}
              loadState={wbLoad}
              saveState={wbSave}
              canModerate={!isGroup || isGroupHost}
              selfName={
                (roomRef.current &&
                  roomRef.current.localParticipant &&
                  roomRef.current.localParticipant.name) ||
                "You"
              }
            />
          </div>
        )}

        {/* Teams-style "you're muted" nudge while muted + talking. */}
        <MutedSpeakingPrompt active={!mic} onUnmute={toggleMic} />

        {/* Raised-hands pill (parity with meetings) */}
        {callHands.length > 0 ? (
          <div className="cv-hands-pill">
            <span className="cv-hand-emoji"><IconHand size={16} /></span>
            {callHands.length === 1
              ? `${callHands[0].name} raised a hand`
              : `${callHands.length} hands raised`}
          </div>
        ) : null}

        {/* Floating reactions overlay (parity with meetings) */}
        {callReactions.length > 0 ? (
          <div className="cv-floating-reactions">
            {callReactions.map((r) => (
              <div key={r.id} className="cv-float-reaction" title={r.name}>
                {r.emoji}
              </div>
            ))}
          </div>
        ) : null}

        {/* Reaction picker popover (opened from the dock "React" button) */}
        {reactOpen
          ? createPortal(
            // Portaled to <body>: the "Central stage" wrapper just above sets
            // `contain: layout` (a flicker-perf fix), which — same as a
            // `transform` — makes IT the containing block for any
            // position:fixed descendant instead of the real viewport. This
            // picker was rendering relative to THAT box, off by however much
            // it falls short of the viewport (here, the dock's own height).
            <div
              className="cv-reaction-picker"
              style={
                reactAnchor
                  ? {
                    position: "fixed",
                    left: reactAnchor.left,
                    bottom: reactAnchor.bottom,
                    transform: "none",
                    // Now a <body> child (portal): the call view itself sits
                    // at zIndex 1000, so with no z-index of its own this
                    // painted BEHIND it — present and correctly positioned,
                    // just invisible. Match the muted-toast's 6001.
                    zIndex: 6001,
                  }
                  : undefined
              }
            >
              {CALL_REACTIONS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  className="cv-reaction-btn"
                  onClick={() => sendCallReaction(emoji)}
                  aria-label={`React ${emoji}`}
                >
                  {emoji}
                </button>
              ))}
            </div>,
            document.body,
          )
          : null}

        {/* Audio-only (or pre-upgrade): centered peer avatar while the remote has
            no video. Reacts to a mid-call audio→video upgrade — once the peer
            publishes a camera track (remoteVideoOn), this hides so their video
            shows instead of the avatar. */}
        {!video &&
          !screen &&
          !isGroup &&
          !remoteVideoOn &&
          callTotalTiles === 0 &&
          mediaPhase !== "failed" && (
            <div
              style={{
                position: "absolute",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 10,
              }}
            >
              <Avatar avatar={avatar} size={80} />
              <div style={{ fontSize: 15, fontWeight: 600 }}>{peer.name}</div>
            </div>
          )}

        {/* Video 1:1: remote camera off → show peer avatar instead of an empty
            stage (mirrors the audio-only overlay above; the group path is handled
            by MeetingStage). Gated on remoteJoined so it doesn't flash pre-join. */}
        {video &&
          !screen &&
          !isGroup &&
          remoteJoined &&
          !remoteVideoOn &&
          callTotalTiles === 0 &&
          mediaPhase !== "failed" && (
            <div
              style={{
                position: "absolute",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 10,
              }}
            >
              <Avatar avatar={avatar} size={80} />
              <div style={{ fontSize: 15, fontWeight: 600 }}>{peer.name}</div>
            </div>
          )}

        {/* Group fallback: participant avatars when media failed */}
        {isGroup && mediaPhase === "failed" ? (
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 16,
              justifyContent: "center",
              alignItems: "center",
            }}
          >
            {(
              (huddles &&
                call.conversationId &&
                huddles[call.conversationId] &&
                huddles[call.conversationId].participants) ||
              []
            ).map((p) => (
              <div key={p.id} style={{ textAlign: "center" }}>
                <div
                  style={{
                    width: 56,
                    height: 56,
                    borderRadius: "50%",
                    background: "color-mix(in srgb, var(--ac) 32%, #2a2b36)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 20,
                    fontWeight: 700,
                    margin: "0 auto 6px",
                  }}
                >
                  {(p.name || "?")
                    .split(/\s+/)
                    .map((w) => w[0])
                    .slice(0, 2)
                    .join("")
                    .toUpperCase()}
                </div>
                <div style={{ fontSize: 11, fontWeight: 600, opacity: 0.8 }}>
                  {p.name}
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {/* Shared participant overflow (⋮) menu — opened from each remote tile's
            ⋮ button (see openCallTileMenu). Replaces the old hardcoded Mute/Remove
            overlay; portals to <body> at --z-menu so it clears the call stage and
            is identical to the meeting participant menu. */}
        {callPartMenu.menu}

        {/* Phase message inside the stage */}
        {mediaPhase !== "connected" && (
          <div
            style={{
              position: "absolute",
              bottom: 16,
              left: "50%",
              transform: "translateX(-50%)",
              textAlign: "center",
              color:
                mediaPhase === "failed" ? "#FCA5A5" : "rgba(255,255,255,.7)",
              fontSize: 13,
              background: "rgba(0,0,0,.4)",
              padding: "6px 16px",
              borderRadius: 8,
              display: "flex",
              alignItems: "center",
              gap: 10,
            }}
          >
            <span>
              {mediaPhase === "failed"
                ? "Unable to connect to media server"
                : `${isGroup ? "Joining call" : remoteJoined ? "Reconnecting" : "Connecting"}…`}
            </span>
            {mediaPhase === "failed" && (
              <button
                onClick={() => {
                  setMediaError(null);
                  setMediaPhase("connecting_media");
                  setMediaRetryKey((k) => k + 1);
                }}
                style={{
                  background: "var(--brand-cta-gradient)",
                  color: "#fff",
                  border: "none",
                  borderRadius: 6,
                  padding: "4px 12px",
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Retry
              </button>
            )}
          </div>
        )}

        <div ref={audioRef} style={{ display: "none" }} />
      </div>

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

      {/* ── Remote Control (request/allow/control/cursor/toolbar/border) ── */}
      {!pip ? (
        <RemoteControlLayer
          room={mediaLive ? roomRef.current : null}
          localSid={
            mediaLive && roomRef.current && roomRef.current.localParticipant
              ? roomRef.current.localParticipant.sid
              : null
          }
          localName={
            (roomRef.current &&
              roomRef.current.localParticipant &&
              roomRef.current.localParticipant.name) ||
            "You"
          }
          isSharingScreen={!!screen}
          remoteSharer={rcSharer}
          getShareRect={getShareRect}
          isDesktop={
            typeof window !== "undefined" && !!(window as any).collabDesktop
          }
          onLog={(action, peerSid) => {
            try {
              const t = localStorage.getItem("clb_token");
              if (t)
                api
                  .logRemoteControl(t, { action, peer: peerSid || "" })
                  .catch(() => { });
            } catch (_) { }
          }}
        />
      ) : null}

      {/* ── People panel (parity with Meetings; additive overlay) ── */}
      {peoplePanelOpen && !pip ? (
        <div className="cv-people-panel">
          {/* People | Chat tabs — same panel model as meetings (image-2 parity):
              the Participant-view toggle opens People, the Chat button opens
              Chat. Reuses the meeting ms-panel-tab classes. */}
          <div className="cv-people-head">
            <div className="ms-panel-tabs-v2">
              {/* BA/CEO #5: Chat is the FIRST tab, People second (parity with the
                  meeting panel, which was reordered in wave 1). */}
              <button
                className={
                  "ms-panel-tab" + (callPanelTab === "chat" ? " active" : "")
                }
                onClick={() => setCallPanelTab("chat")}
              >
                <IconMessageSquare size={13} />
                Chat
                {callChatUnread > 0 && (
                  <span className="ms-panel-count">
                    {callChatUnread > 99 ? "99+" : callChatUnread}
                  </span>
                )}
              </button>
              <button
                className={
                  "ms-panel-tab" + (callPanelTab === "people" ? " active" : "")
                }
                onClick={() => setCallPanelTab("people")}
              >
                <IconUsers size={13} />
                Participants
                {callRoster.length > 0 && (
                  <span className="ms-panel-count">{callRoster.length}</span>
                )}
              </button>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              {/* Mute in-call chat notifications (bell) — parity with the main
                  chat's per-conversation "Mute notifications". Only on the Chat
                  tab, since it governs chat dings. */}
              {callPanelTab === "chat" ? (
                <button
                  className="cv-people-close"
                  onClick={toggleCallChatMuted}
                  aria-pressed={callChatMuted}
                  aria-label={
                    callChatMuted
                      ? "Unmute chat notifications"
                      : "Mute chat notifications"
                  }
                  title={
                    callChatMuted
                      ? "Unmute chat notifications"
                      : "Mute chat notifications"
                  }
                >
                  {callChatMuted ? (
                    <IconBellOff size={16} />
                  ) : (
                    <IconBell size={16} />
                  )}
                </button>
              ) : null}
              <button
                className="cv-people-close"
                onClick={() => setPeoplePanelOpen(false)}
                aria-label="Close panel"
              >
                <IconX size={16} />
              </button>
            </div>
          </div>
          {callPanelTab === "chat" ? (
            /* ── In-call chat (DataChannel; ephemeral, call-scoped) ── */
            <div
              className="ms-chat-panel-v2"
              // Drag-and-drop file upload (parity with the main chat). Call chat
              // sends immediately (no staging), so send every dropped file.
              onDragOver={(e) => {
                e.preventDefault();
              }}
              onDrop={(e) => {
                e.preventDefault();
                const fs = e.dataTransfer && e.dataTransfer.files;
                if (fs && fs.length)
                  Array.from(fs).forEach((f) => sendCallChatFile(f));
              }}
            >
              <div className="ms-chat-messages-v2">
                {callChatMsgs.length === 0 && (
                  <div className="ms-chat-empty-v2">
                    <IconMessageSquare size={28} />
                    <span>No messages yet</span>
                  </div>
                )}
                {groupChatMessages(callChatMsgs, {
                  id: (m: any) => String(m.id),
                  sender: (m: any) => (m.self ? "__me__" : String(m.name || "")),
                  name: (m: any) => String(m.name || "?"),
                  ts: (m: any) => Number(m.ts),
                  mine: (m: any) => !!m.self,
                }).map((g) =>
                  g.kind === "day" ? (
                    <div key={g.key} className="icc-day">
                      <span>{g.label}</span>
                    </div>
                  ) : (
                    <div key={g.key} className={"icc-run" + (g.mine ? " mine" : "")}>
                      <div className="icc-avatar" style={{ background: colorOf(g.senderName) }}>
                        {initialsOf(g.senderName)}
                      </div>
                      <div className="icc-col">
                        <div className="icc-name">{g.mine ? "You" : g.senderName}</div>
                        {g.items.map((m: any) => (
                          <div key={m.id} className="icc-bubble">
                            {m.text ? <div className="icc-text">{m.text}</div> : null}
                            {m.file && m.file.id ? (
                              <CallChatAttachment
                                file={m.file}
                                token={token}
                                onToast={showToast}
                              />
                            ) : null}
                          </div>
                        ))}
                        <div className="icc-meta">
                          <span>
                            {new Date(g.last).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                          </span>
                          {g.mine ? <IconCheckCheck size={14} /> : null}
                        </div>
                      </div>
                    </div>
                  ),
                )}
              </div>
              {callChatEmoji && callChatEmojiAnchor ? (
                <EmojiPicker
                  anchorRect={callChatEmojiAnchor}
                  onSelect={insertCallChatEmoji}
                  onClose={() => setCallChatEmoji(false)}
                />
              ) : null}
              <InlineMentionPopover mentions={callMentions} />
              <div className="ms-chat-composer">
                <input
                  ref={callChatFileRef}
                  type="file"
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const f = e.target.files && e.target.files[0];
                    if (f) sendCallChatFile(f);
                    e.currentTarget.value = "";
                  }}
                />
                <button
                  className="ms-chat-composer-btn"
                  title="Attach file"
                  aria-label="Attach file"
                  disabled={callChatUploading}
                  onClick={() =>
                    callChatFileRef.current && callChatFileRef.current.click()
                  }
                >
                  <IconPaperclip size={15} />
                </button>
                <button
                  className={"ms-chat-composer-btn" + (callChatEmoji ? " on" : "")}
                  title="Emoji"
                  aria-label="Emoji"
                  // Stop mousedown reaching the picker's outside-click handler so
                  // a second click toggles it closed (not close-then-reopen).
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    const r = (
                      e.currentTarget as HTMLButtonElement
                    ).getBoundingClientRect();
                    setCallChatEmojiAnchor({
                      top: r.top,
                      left: r.left,
                      width: r.width,
                      height: r.height,
                    });
                    setCallChatEmoji((v) => !v);
                  }}
                >
                  <IconSmile size={15} />
                </button>
                <input
                  type="text"
                  value={callChatDraft}
                  onChange={(e) => setCallChatDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (callMentions.onKeyDown(e)) return;
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      sendCallChat();
                    }
                  }}
                  // Paste an image/screenshot straight into the chat (parity with
                  // the meeting chat + main composer). Clipboard file items upload
                  // and send immediately, like drag-drop.
                  onPaste={(e) => {
                    const items = e.clipboardData && e.clipboardData.items;
                    if (!items) return;
                    for (let i = 0; i < items.length; i++) {
                      if (items[i].kind === "file") {
                        const f = items[i].getAsFile();
                        if (f) {
                          e.preventDefault();
                          sendCallChatFile(f);
                          break;
                        }
                      }
                    }
                  }}
                  placeholder="Message everyone…"
                  className="ms-chat-composer-input"
                />
                <button
                  className="ms-chat-composer-btn"
                  onClick={sendCallChat}
                  disabled={!callChatDraft.trim()}
                  aria-label="Send message"
                  title="Send"
                >
                  <svg viewBox="0 0 24 24" width={15} height={15} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M22 2 11 13" />
                    <path d="M22 2 15 22l-4-9-9-4z" />
                  </svg>
                </button>
              </div>
            </div>
          ) : (
            <>
              {canMuteEveryone ? (
                <button className="cv-people-muteall" onClick={muteAllGroup}>
                  <IconMicOff size={14} />
                  Mute everyone
                </button>
              ) : null}
              {/* P0-10: compact Teams-style MANAGEMENT list — one row per person
              (avatar · name · speaking/mic/cam/hand status); contextual actions
              reveal on hover (pin · focus · ⋮). Reuses the meeting panel's
              ms-person-* classes so both surfaces share ONE visual system. The
              panel never hosts video tiles — the stage owns all media. */}
              <div className="ms-people-search">
                <IconSearch size={13} />
                <input
                  placeholder="Search participants…"
                  className="ms-people-input"
                  aria-label="Search participants"
                  value={peopleQuery}
                  onChange={(e) => setPeopleQuery(e.target.value)}
                />
              </div>
              <div className="ms-people-list cv-people-list">
                {peopleQuery.trim() &&
                  !callRoster.some((p) =>
                    String(p.name || "").toLowerCase().includes(peopleQuery.trim().toLowerCase()),
                  ) ? (
                  <div className="ms-people-empty" style={{ padding: 16, fontSize: 12, opacity: 0.7, textAlign: "center" }}>
                    No participants match “{peopleQuery.trim()}”.
                  </div>
                ) : null}
                {callRoster
                  .filter(
                    (p) =>
                      !peopleQuery.trim() ||
                      String(p.name || "").toLowerCase().includes(peopleQuery.trim().toLowerCase()),
                  )
                  .map((p) => {
                    const pinned = callPinnedSids.includes(p.sid);
                    const hand = callHands.some(
                      (h) => h.id === p.sid || (p.isLocal && h.id === "__me__"),
                    );
                    // Tiles are keyed by SUFFIX (`<sid>:avatar`, `<sid>:<trackSid>`),
                    // never the bare sid — resolve by prefix or tileEl is always null
                    // (which silently killed the roster ⋮ + fullscreen). Prefer a real
                    // video/screen tile over the avatar placeholder.
                    const pickTile = (): HTMLElement | null => {
                      let avatarTile: HTMLElement | null = null;
                      for (const [k, v] of tilesRef.current) {
                        if (k !== p.sid && !k.startsWith(p.sid + ":")) continue;
                        const t: HTMLElement | null = (v && (v as any).tile) || null;
                        if (!t) continue;
                        if (k.endsWith(":avatar")) {
                          avatarTile = t;
                          continue;
                        }
                        return t;
                      }
                      return avatarTile;
                    };
                    const tileEl: HTMLElement | null = pickTile();
                    return (
                      <div
                        key={p.sid}
                        className={"ms-person-row" + (p.speaking ? " speaking" : "")}
                      >
                        {/* BA/CEO #21: hand badge sits OUTSIDE the overflow:hidden
                      avatar so it layers over the corner, not clipped inside. */}
                        <div className="ms-person-avatar-wrap">
                          <div
                            className="ms-person-avatar cv-person-avatar"
                            style={{ background: colorOf(String(p.identity || "").split("__")[0] || String(p.name || "")) }}
                          >
                            {String(p.name || "?")
                              .split(/\s+/)
                              .map((w) => w[0])
                              .filter(Boolean)
                              .slice(0, 2)
                              .join("")
                              .toUpperCase()}
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
                          </div>
                          {hand && (
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
                          {/* Role from the server-signed token (calls have no co-host). */}
                          <span className="ms-person-role">
                            {p.role === "host" ? "Host" : "Participant"}
                          </span>
                        </div>
                        <div className="ms-person-status">
                          {/* Raised hand shows as a badge over the avatar (BA/CEO #21). */}
                          {/* Mic + camera state, ALWAYS shown (reference): accent when on, red
                        slashed glyph when off. */}
                          <span
                            className={"ms-person-mic " + (p.micOn ? "on" : "off")}
                            title={p.micOn ? "Microphone on" : "Microphone off"}
                          >
                            {p.micOn ? <IconMic size={18} /> : <IconMicOff size={18} />}
                          </span>
                          <span
                            className={"ms-person-cam " + (p.camOn ? "on" : "off")}
                            title={p.camOn ? "Camera on" : "Camera off"}
                          >
                            {p.camOn ? <IconVideo size={18} /> : <IconVideoOff size={18} />}
                          </span>
                        </div>
                        <div className="ms-person-actions">
                          {isCallHost && isGroup && p.userId ? (
                            <button
                              className={
                                "ms-person-action ms-person-spotlight" +
                                (callSpotlightUids.includes(p.userId) ? " on" : "")
                              }
                              aria-label={callSpotlightUids.includes(p.userId) ? "Remove spotlight" : "Spotlight for everyone"}
                              aria-pressed={callSpotlightUids.includes(p.userId)}
                              title={callSpotlightUids.includes(p.userId) ? "Remove spotlight" : "Spotlight for everyone"}
                              onClick={() => toggleCallSpotlight(p.userId as string)}
                            >
                              <svg viewBox="0 0 24 24" width={15} height={15} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <path d="M12 2l2.4 4.86 5.36.78-3.88 3.78.92 5.34L12 14.24l-4.8 2.52.92-5.34L4.24 7.64l5.36-.78z" />
                              </svg>
                            </button>
                          ) : null}
                          <button
                            className={"ms-person-action" + (pinned ? " on" : "")}
                            aria-label={pinned ? "Unpin participant" : "Pin participant"}
                            aria-pressed={pinned}
                            title={pinned ? "Unpin" : "Pin for me"}
                            onClick={() => toggleCallPin(p.sid)}
                          >
                            <svg viewBox="0 0 24 24" width={15} height={15} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <path d="M12 17v5" />
                              <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z" />
                            </svg>
                          </button>
                          <button
                            className="ms-person-action"
                            aria-label="Focus participant (fullscreen)"
                            title="Fullscreen"
                            onClick={() => {
                              // In Participant view a non-prominent tile is railed
                              // (display:none) and can't go fullscreen, so surface it
                              // with a pin first. In Gallery the tile is already
                              // visible — pinning there would wrongly collapse the
                              // grid to one person, so ONLY pin when actually hidden.
                              const t0 = pickTile();
                              const needsPin =
                                !pinned &&
                                !!t0 &&
                                t0.classList.contains("cv-tile-railed");
                              if (needsPin) toggleCallPin(p.sid);
                              requestAnimationFrame(() =>
                                requestAnimationFrame(() => {
                                  const t = pickTile();
                                  if (!t) return;
                                  try {
                                    fsRequest(t);
                                  } catch (_) { }
                                  if (needsPin) {
                                    // The pin was only to surface a hidden tile for
                                    // fullscreen — undo it on exit so the prior
                                    // layout is restored (no sticky spotlight).
                                    const onFs = () => {
                                      if (!fsElement()) {
                                        setCallPinnedSids((prev) =>
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
                          {isCallHost && !p.isLocal && (
                            <button
                              className="ms-person-action"
                              aria-label="Mute participant"
                              title="Mute"
                              onClick={() => {
                                // LiveKit identity is "<userId>__<uuid>"; the mute
                                // endpoint resolves by BASE user id — strip the tail.
                                const sep = p.identity.indexOf("__");
                                const uid =
                                  sep === -1 ? p.identity : p.identity.slice(0, sep);
                                if (uid) mutePeerInGroup(uid);
                              }}
                            >
                              <svg viewBox="0 0 24 24" width={15} height={15} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <line x1="2" y1="2" x2="22" y2="22" />
                                <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V5a3 3 0 0 0-5.94-.6" />
                                <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23" />
                                <line x1="12" y1="19" x2="12" y2="22" />
                              </svg>
                            </button>
                          )}
                          {isCallHost && !p.isLocal && tileEl && (
                            <button
                              className="ms-person-action"
                              aria-label="Participant options"
                              aria-haspopup="menu"
                              title="More options"
                              onClick={(e) =>
                                openCallTileMenuRef.current(e.currentTarget, tileEl)
                              }
                            >
                              <IconMoreVertical size={16} />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
              </div>
            </>
          )}
        </div>
      ) : null}

      {/* ── Bottom control bar — FLUSH: no margins around the bar, so no
          second background layer peeks from behind it (parity w/ .ms-dock). */}
      <div
        className="call-chrome"
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 0,
          width: "100%",
          boxSizing: "border-box",
          padding: 0,
          flexShrink: 0,
          // Containing block for the Devices popup (.cv-devices-pop, absolute) so
          // it anchors above THIS bar, not the full-screen call view (off-screen).
          position: "relative",
          // Stacking context ABOVE the whiteboard (z5), mirroring the meeting dock
          // (.ms-dock z100): keeps the dock + its pop-ups (More menu, Devices,
          // reactions) usable OVER the board instead of rendering under it.
          zIndex: 100,
        }}
      >
        {controlBar}
        {callDevicesOpen ? (
          <>
            <div
              onClick={() => setCallDevicesOpen(false)}
              style={{ position: "fixed", inset: 0, zIndex: 199 }}
            />
            <div className="cv-devices-pop">
              <div className="cv-devices-head">
                <span>Devices</span>
                <button
                  type="button"
                  onClick={() => setCallDevicesOpen(false)}
                  aria-label="Close devices"
                >
                  <IconX size={14} />
                </button>
              </div>
              {devicePickers}
            </div>
          </>
        ) : null}
      </div>

      {/* Error / info banner (permission denied, settlement timeout, connection failure) */}
      {mediaError && mediaPhase !== "connected" ? (
        <div
          style={{
            position: "absolute",
            top: 56,
            left: "50%",
            transform: "translateX(-50%)",
            maxWidth: 480,
            background:
              mediaPhase === "failed"
                ? "rgba(239,68,68,.15)"
                : "rgba(245,158,11,.15)",
            border:
              "1px solid " + (mediaPhase === "failed" ? "#EF4444" : "#F59E0B"),
            color: "#fff",
            borderRadius: 10,
            padding: "8px 14px",
            fontSize: 12.5,
            textAlign: "center",
            zIndex: 10,
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <span>{mediaError}</span>
          {mediaPhase === "failed" && (
            <button
              onClick={() => {
                setMediaError(null);
                setMediaPhase("connecting_media");
                setMediaRetryKey((k) => k + 1);
              }}
              style={{
                background: "var(--brand-cta-gradient)",
                color: "#fff",
                border: "none",
                borderRadius: 6,
                padding: "4px 12px",
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              Retry
            </button>
          )}
        </div>
      ) : null}

      {/* Add people modal */}
      {addOpen && canAddPeople ? (
        <AddParticipantsModal
          people={addPeople || []}
          onSearch={onSearchPeople}
          onClose={() => setAddOpen(false)}
          onAdd={(ids) => {
            setAddOpen(false);
            onAddPeople(ids);
          }}
        />
      ) : null}
    </div>
  );

  return status === "connected" ? meetingStage : ringingCard;
}
