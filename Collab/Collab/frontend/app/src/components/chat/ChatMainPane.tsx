// ChatMainPane.tsx — ChatView render shell (mechanical extraction from ChatView.tsx).
// Do not hand-edit beyond imports.

import React from "react";
import { createPortal } from "react-dom";
import { IconAlertTriangle, IconBold, IconType, IconTextColor, IconChevronDown, IconChevronUp, IconClock, IconCode, IconDownload, IconIndentDecrease, IconIndentIncrease, IconItalic, IconLink, IconList, IconListOrdered, IconMic, IconMinus, IconMoreHorizontal, IconPaperclip, IconPause, IconPin, IconPlay, IconPlus, IconQuote, IconRemoveFormatting, IconSend, IconSmile, IconSparkles, IconStrikethrough, IconTable, IconTrash, IconUnderline, IconUndo, IconX } from "../../lib/icons";
import Avatar from "../Avatar";
import RichTextEditor from "../RichTextEditor";
import { useComposerLayout } from "./useComposerLayout";
import { messagePreview, messageRowPreview, firstLineHtml } from "../../lib/messageText";
import { isBlankRich, toLocalInput, fmtSchedule, CHAT_PAGE_SIZE, onMessageListCopy } from "./helpers";
import { MsgRow } from "./MsgRow";
import ProfileModal from "./ProfileModal";
import { Welcome, TabPane } from "./TabPane";
import { api } from "../../lib/api";
import { confirmDialog, promptDialog } from "../../lib/dialog";
import { FileExtAvatar } from "./FileAttachment";
import { E2EE_PENDING_TEXT } from "../../lib/e2ee/manager";
import { trackEvent } from "../../lib/telemetry";
import dynamic from "next/dynamic";
import { sanitizeMessageHtml as sanitizeHtml } from "../../lib/sanitizeHtml";
import MediaAlbum, { AlbumLightbox } from "./MediaAlbum";
import { PersonCard, MeetingInviteCard } from "./RichCards";
import { E2EERestoreBanner } from "./E2EEBanners";
import type { PickedMedia } from "../GifPicker";

const GifPicker = dynamic(() => import("../GifPicker"), { ssr: false });

export default function ChatMainPane({ s }: { s: any }) {
  const {
    actionsBtnRef, actionsMenuRef, actionsOpen, actionsPos,
    actionsRef, activateMsg, activeMsgId, aiErr,
    aiLoading, aiSummary, albumOf, atTop,
    bannerInvite, byId, chatImgNav, clearStaged,
    composerImportant, confirmSchedule, conversation, curPin,
    cyclePin, deactivateMsg, dragOver, editingSched,
    editorRef, embedded, enrichPersonCard, enterToSend,
    exhausted, fileRef, flash, fmtOpen,
    gifOpen, gifPickerRef, goNextMatch, goPrevMatch,
    grouping, handleAvatarClick, handleAvatarEnter, handleAvatarLeave,
    openDirectChat, profileModal, setProfileModal,
    handleCardCall, handleCardEnter, handleCardLeave, handleLoadEarlier,
    inQuery, inSearch, insertMention, isGroupish,
    isMobile, jumpToMessage, lastAckId, linkConfirm,
    linkPreview, listRef, loadingEarlier, matchIdx,
    matched, me, meId, mentionMatches,
    mentionPeople, messages, mi, moreBtnRef,
    moreMenu, moreMenuPortalRef, moreMenuPos, moreMenuRef,
    mq, msgLoadStatus, myIdSet, newestAtTop, offlineDemo,
    onAcceptRequest, onAddParticipants, onBookmark, onCallUser,
    onCancelScheduled, onCancelUpload, onDeclineRequest, onDeleteMessage,
    onDropFile, onEditMessage, onEditorChange, onFileInput,
    onForward, onJoinMeeting, onLoadEarlier, onMarkImportant,
    onOpenTask, onPin, onReact, onRejectMeeting,
    onRetry, onRetryLoad, onSelectPerson, onSend,
    onSendMedia, onUnblockUser, onUnpin, openActions,
    openMoreMenu, pauseRecording, peerBlocked, peerReadAt,
    pendingConnection, pendingRequestInvite, personCard, pinIdx,
    pinnedMsgs, popoverOpenRef, recording, recordingPaused,
    recordingTime, removeStaged, replyTo, schedAt,
    schedOpen, schedPickerRef, schedScopeRef, scheduled,
    scrollToBottom, scrollingRef, searchMatchIds, seenMeta,
    setActionsOpen, setAiErr, setAiSummary, setChatImgNav,
    setComposerImportant, setDragOver, setEditingSched, setFmtOpen,
    setGifOpen, setInQuery, setInSearch, setMoreMenu,
    setPopoverOpen, setReplyTo, setSchedAt, setSchedOpen,
    setShowJump, setSlashHover, setTempNoticeClosed, setText,
    showJump, showReceipts, shown, slashActive,
    slashHover, slashMatches, stageFiles, staged,
    startRecording, startReply, stopRecording, sub,
    submit, tab, tempNoticeDismissed, text,
    timeFormat, token, typingName, unreadSepId,
    uploadPct
  } = s;

  // Adaptive composer row: single-line until the text wraps or reaches the icon
  // cluster, then stacked (icons on their own bottom row). See useComposerLayout.
  const composerRowRef = React.useRef<HTMLDivElement>(null);
  const composerStacked = useComposerLayout(composerRowRef, text, [recording, staged.length, fmtOpen]);

  if (!conversation) return <Welcome />;
  // "Load earlier" affordance — extracted so it can render at the OLDER end of
  // the list in either direction: above the messages normally, BELOW them under
  // newest-at-top (ORD-05: older messages load as the user scrolls down).
  // `atTop` already tracks the older end direction-aware (see useChatView0).
  const earlierBtn =
    matched.length > shown.length ||
      (onLoadEarlier &&
        !exhausted &&
        atTop &&
        shown.length > 0 &&
        messages.length >= CHAT_PAGE_SIZE) ? (
      <button
        className="msgs-earlier"
        disabled={loadingEarlier}
        onClick={() => {
          trackEvent("chat.load_earlier.tap"); // §9.2 pagination requests
          handleLoadEarlier();
        }}
      >
        {loadingEarlier
          ? "Loading…"
          : matched.length > shown.length
            ? `Load earlier messages (${matched.length - shown.length})`
            : "Load earlier messages"}
      </button>
    ) : null;
  // Rows that will actually RENDER. Date separators and grouping must be
  // computed over THESE — the raw list contains rows that render as null
  // (suppressed meeting-invite cards, album continuation rows, hidden legacy
  // system lines), and a day whose only occupants are invisible left an
  // ORPHAN date pill in the stream ("Monday 24 Aug" with nothing under it).
  const rowVisible = (m: any) => {
    if (!m) return false;
    const alb0 = albumOf[m.id];
    if (alb0 && !alb0.lead) return false;
    if (bannerInvite.suppressed.has(m.id)) return false;
    if (
      m.type === "system" &&
      /^Temporary group from your call\/meeting chat/.test(String(m.text || ""))
    )
      return false;
    if (
      m.type === "system" &&
      conversation &&
      conversation.temporary &&
      /created the (group|channel)$/.test(String(m.text || ""))
    )
      return false;
    return true;
  };
  const visibleRows = shown.filter(rowVisible);
  return (
    tab === "chat" ? (
      <div className="tp active" id="tp-chat">
        {/* AI Summary */}
        {aiLoading || aiSummary || aiErr ? (
          <div className="ai-sum">
            <div className="ai-sum-hd">
              <span className="ai-sum-title">
                <IconSparkles className="ai-sum-spark" />

                Catch me up
              </span>
              <button
                className="ai-sum-x"
                onClick={() => {
                  setAiSummary(null);
                  setAiErr(null);
                }}
                aria-label="Dismiss summary"
              >
                <IconX size={14} />
              </button>
            </div>
            {aiLoading ? (
              <div className="ai-sum-loading">
                Collab AI is summarizing this conversation…
              </div>
            ) : aiErr ? (
              <div className="ai-sum-err">{aiErr}</div>
            ) : (
              <div className="ai-sum-body">{aiSummary}</div>
            )}
          </div>
        ) : null}

        {/* (Live-call banner moved ABOVE the tab bar — visible on every
                tab, Teams-style, with Lucide icons.) */}

        {/* Search bar — Teams-style: match counter + up/down navigation */}
        {inSearch ? (
          <div
            style={{
              padding: "8px 14px",
              borderBottom: "1px solid var(--g200)",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <input
              name="message-search"
              autoComplete="off"
              autoFocus
              value={inQuery}
              onChange={(e) => setInQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (e.shiftKey) goPrevMatch();
                  else goNextMatch();
                }
              }}
              placeholder="Search in this conversation…"
              style={{
                flex: 1,
                minWidth: 0,
                padding: "7px 10px",
                borderRadius: 8,
                border: "1.5px solid var(--g200)",
                fontSize: 13,
                background: "var(--g50)",
                color: "var(--g900)",
                outline: "none",
                boxSizing: "border-box",
              }}
            />
            {inQuery.trim() ? (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 2,
                  flexShrink: 0,
                }}
              >
                <span
                  style={{
                    fontSize: 12,
                    color: "var(--g500)",
                    fontVariantNumeric: "tabular-nums",
                    minWidth: 40,
                    textAlign: "center",
                  }}
                >
                  {searchMatchIds.length
                    ? `${matchIdx + 1}/${searchMatchIds.length}`
                    : "0/0"}
                </span>
                <button
                  className="ib"
                  aria-label="Previous match (older)"
                  title="Previous match"
                  disabled={matchIdx <= 0}
                  onClick={goPrevMatch}
                >
                  <span
                    style={{
                      display: "inline-flex",
                      transform: "rotate(180deg)",
                    }}
                  >
                    <IconChevronDown size={16} />
                  </span>
                </button>
                <button
                  className="ib"
                  aria-label="Next match (newer)"
                  title="Next match"
                  disabled={matchIdx >= searchMatchIds.length - 1}
                  onClick={goNextMatch}
                >
                  <IconChevronDown size={16} />
                </button>
              </div>
            ) : null}
            {/* Explicit close (✕) — the in-conversation search is entered from
                    the Global Search "Chat" scope, so it needs its own way out
                    besides Esc. Clears the query and drops back to the chat. */}
            <button
              className="ib"
              aria-label="Close search"
              title="Close search (Esc)"
              onClick={() => {
                setInSearch(false);
                setInQuery("");
              }}
              style={{ flexShrink: 0 }}
            >
              <IconX size={16} />
            </button>
          </div>
        ) : null}

        {/* Pinned message banner (WhatsApp/Telegram-style). Click cycles
                through pinned messages and jumps the list to each one. */}
        {curPin ? (
          <div
            className="pin-banner"
            onClick={cyclePin}
            title={
              pinnedMsgs.length > 1
                ? "Click to cycle pinned"
                : "Jump to pinned"
            }
          >
            <span className="pin-banner-bar" />
            <span className="pin-banner-icon" aria-hidden="true">
              <IconPin size={15} />
            </span>
            <div className="pin-banner-body">
              <div className="pin-banner-head">
                <span className="pin-banner-title">
                  Pinned message
                  {pinnedMsgs.length > 1
                    ? ` (${pinIdx + 1}/${pinnedMsgs.length})`
                    : ""}
                </span>
              </div>
              {curPin.text ? (
                <div
                  className="pin-banner-text msg-prev-1"
                  dangerouslySetInnerHTML={{
                    __html: sanitizeHtml(firstLineHtml(curPin.text)),
                  }}
                />
              ) : (
                <div className="pin-banner-text">
                  {messageRowPreview(curPin)}
                </div>
              )}
            </div>
            {onUnpin ? (
              <button
                type="button"
                className="pin-banner-x"
                aria-label="Unpin"
                onClick={(e) => {
                  e.stopPropagation();
                  onUnpin(curPin);
                }}
              >
                <IconX />

              </button>
            ) : null}
          </div>
        ) : null}

        {/* BA/CEO #1: the active meeting invite is pinned as a HEADER below
                the chat header (Teams-style). MeetingInviteCard returns null once
                the meeting ends/cancels/expires, so the banner auto-vanishes
                (via .chat-invite-banner:empty). */}
        {bannerInvite.id && !bannerInvite.ended && byId[bannerInvite.id] ? (
          <div className="chat-invite-banner">
            <MeetingInviteCard
              m={byId[bannerInvite.id]}
              onJoin={onJoinMeeting}
              onReject={onRejectMeeting}
              isGroup={isGroupish}
            />
          </div>
        ) : null}

        {/* BA/CEO #3: temporary group (from an ended call/meeting chat) —
                tell users it auto-deletes so they don't rely on it long-term.
                Dismissible via the X (per conversation, persisted); dismissing
                only hides the notice — the auto-delete itself still happens. */}
        {conversation && conversation.temporary && !tempNoticeDismissed
          ? (() => {
            /* Layout-critical styles are INLINE so the controls can never
               render out of place with a stale stylesheet. */
            const t = conversation.expiresAt
              ? Date.parse(conversation.expiresAt)
              : NaN;
            const msLeft = Number.isFinite(t) ? t - Date.now() : Infinity;
            const keepDays = Number(conversation.retentionDays) > 0
              ? Number(conversation.retentionDays)
              : 7;
            const dismiss = () => {
              setTempNoticeClosed((p) => ({ ...p, [conversation.id]: 1 }));
              try {
                localStorage.setItem("clb_tempnote_x_" + conversation.id, "1");
              } catch (_) { }
            };
            // One day before deletion: promote the passive notice to an
            // actionable banner (Convert / Extend / Keep) per the spec.
            if (Number.isFinite(t) && msLeft < 24 * 3600000) {
              const hrs = Math.max(1, Math.round(msLeft / 3600000));
              const abtn: React.CSSProperties = {
                height: 26, padding: "0 10px", borderRadius: 7,
                border: "1px solid rgba(245,158,11,0.4)", background: "#fff",
                color: "var(--g800)", fontSize: 11.5, fontWeight: 600, cursor: "pointer",
              };
              return (
                <div className="chat-temp-notice chat-temp-notice-urgent" style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", justifyContent: "center" }}>
                  <span style={{ fontWeight: 600 }}>
                    ⏳ This temporary conversation will be deleted{msLeft <= 0 ? " soon" : ` in about ${hrs} hour${hrs === 1 ? "" : "s"}`}.
                  </span>
                  <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
                    <button
                      type="button"
                      style={{ ...abtn, background: "var(--brand-cta-gradient)", color: "#fff", border: "none" }}
                      onClick={() => { if (token) api.convertConversationToPermanent(token, conversation.id).catch(() => { }); }}
                    >
                      Convert to permanent
                    </button>
                    <button
                      type="button"
                      style={abtn}
                      onClick={() => { if (token) api.setConversationRetention(token, conversation.id, keepDays).catch(() => { }); }}
                    >
                      Extend {keepDays} days
                    </button>
                    <button type="button" style={{ ...abtn, border: "none", background: "transparent" }} onClick={dismiss}>
                      Keep temporary
                    </button>
                  </span>
                </div>
              );
            }
            return (
              <div className="chat-temp-notice" style={{ position: "relative" }}>
                ⏳ Temporary group from your call/meeting — it will be
                automatically deleted
                {(() => {
                  if (!Number.isFinite(t)) return " in 7 days";
                  const days = Math.max(0, Math.ceil((t - Date.now()) / 86400000));
                  return days <= 0 ? " today" : days === 1 ? " in 1 day" : ` in ${days} days`;
                })()}
                .
                <button
                  type="button"
                  className="chat-temp-notice-x"
                  aria-label="Dismiss notice"
                  data-tip="Dismiss"
                  style={{
                    position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)",
                    width: 20, height: 20, display: "flex", alignItems: "center", justifyContent: "center",
                    border: "none", background: "transparent", padding: 0, cursor: "pointer",
                    color: "var(--g500, #6b7280)",
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    dismiss();
                  }}
                >
                  <IconX size={13} />
                </button>
              </div>
            );
          })()
          : null}

        {/* #11 — chat-wide image viewer (portals to <body>); ←/→ browse every image
                in the conversation, opened from any image bubble. */}
        {chatImgNav ? (
          <AlbumLightbox
            run={chatImgNav.run}
            token={token}
            index={chatImgNav.idx}
            onIndex={(u: any) =>
              setChatImgNav((v) =>
                v ? { ...v, idx: typeof u === "function" ? u(v.idx) : u } : v,
              )
            }
            onClose={() => setChatImgNav(null)}
          />
        ) : null}
        {/* Message list */}
        <div
          className={"msgs" + (dragOver ? " drag-over" : "")}
          ref={listRef}
          onCopy={onMessageListCopy}
          role="list"
          aria-label="Messages"
          onDragOver={(e) => {
            e.preventDefault();
            if (
              e.dataTransfer &&
              Array.from(e.dataTransfer.types || []).includes("Files")
            ) {
              // The overlay is a child of this SCROLL container, so an inset:0
              // box sits at the top of the content and scrolls out of view on a
              // long thread. Pin it to the visible window instead: dragover fires
              // continuously, so these stay fresh while the pointer moves.
              const el = e.currentTarget as HTMLElement;
              el.style.setProperty("--msgs-st", el.scrollTop + "px");
              el.style.setProperty("--msgs-vh", el.clientHeight + "px");
              setDragOver(true);
            }
          }}
          onDragLeave={(e) => {
            if (e.currentTarget === e.target) setDragOver(false);
          }}
          onClickCapture={(e) => {
            // Link confirmation: when enabled, show the real destination domain
            // before opening any external link (covers msg-link + rich-HTML anchors).
            if (!linkConfirm) return;
            const a = (e.target as HTMLElement).closest("a[href]");
            if (!a) return;
            const u = a.getAttribute("href") || "";
            if (!/^https?:/i.test(u)) return;
            e.preventDefault();
            let host = u;
            try {
              host = new URL(u).hostname.replace(/^www\./, "");
            } catch (_) { }
            confirmDialog("Open this external link?\n\n" + host, {
              title: "Leaving Collab",
              confirmText: "Open link",
            }).then((ok) => {
              if (ok) window.open(u, "_blank", "noopener");
            });
          }}
          onDrop={onDropFile}
        >
          {dragOver && (
            <div className="msgs-drop" role="status" aria-live="polite">
              <div className="msgs-drop-frame" aria-hidden />
              <div className="msgs-drop-card">
                <span className="msgs-drop-icon" aria-hidden>
                  <IconPaperclip />
                  <span className="msgs-drop-icon-badge"><IconPlus /></span>
                </span>
                <span className="msgs-drop-title">Drop files to attach</span>
                <span className="msgs-drop-sub">
                  {conversation?.kind === "self"
                    ? "They'll be saved to your notes"
                    : `They'll be sent to ${conversation?.name || "this chat"}`}
                  <i aria-hidden>·</i>up to 2 GB each
                </span>
              </div>
            </div>
          )}
          {/* `messages.length >= CHAT_PAGE_SIZE` is the new gate: if the whole
                  thread arrived in under one server page, there is provably
                  nothing older and the button was pure noise — which is why it
                  showed on brand-new conversations with three messages in them. */}
          {!newestAtTop ? earlierBtn : null}

          {/* ISSUE #3-B: distinguish loading / failed from a genuinely empty
                  thread (previously all three looked identical = a blank pane). */}
          {messages.length === 0 && msgLoadStatus === "loading" ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: 40,
                fontSize: 13,
                color: "var(--g400)",
              }}
            >
              Loading messages…
            </div>
          ) : null}
          {messages.length === 0 && msgLoadStatus === "error" ? (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                padding: 40,
                gap: 10,
              }}
            >
              <div style={{ fontSize: 13, color: "var(--g500)" }}>
                Couldn't load messages.
              </div>
              <button
                className="btn-p"
                style={{ height: 30, padding: "0 16px", fontSize: 13 }}
                onClick={() => onRetryLoad && onRetryLoad()}
              >
                Retry
              </button>
            </div>
          ) : null}

          {/* Rendered unconditionally — the banner self-gates. A brand-new
                    device needs the restore button even on a thread with NO
                    pending rows (an empty or freshly-started chat), which the old
                    "only if a placeholder is visible" test could never show. */}
          <E2EERestoreBanner
            conversationId={conversation && conversation.id}
            onRetryLoad={onRetryLoad}
            hasPendingMessages={
              !!shown &&
              shown.some(
                (x: any) =>
                  x &&
                  (x._pendingRecovery === true ||
                    (x.text || "").trim() === E2EE_PENDING_TEXT ||
                    (x.encrypted && !(x.text || "").trim())),
              )
            }
          />

          {visibleRows.map((m: any, i: number) => {
            const prev = visibleRows[i - 1];
            const sk = (x: any) =>
              (x.sender && x.sender.id) ||
              (x.me ? "__me__" : (x.sender && x.sender.name) || "?");
            const dayKey = (x: any) => {
              const d = new Date(x.createdAt);
              return Number.isFinite(d.getTime()) ? d.toDateString() : "";
            };
            const showDate = !prev || dayKey(prev) !== dayKey(m);
            const within = (() => {
              if (!prev || showDate) return false;
              const pa = Date.parse(prev.createdAt),
                pb = Date.parse(m.createdAt);
              if (!Number.isFinite(pa) || !Number.isFinite(pb)) return true;
              // abs(): under newest-at-top the render-order previous is the
              // NEWER message, so the signed diff is negative — which made
              // EVERY same-day, same-sender pair "within" and glued whole
              // days into one group (ORD-10).
              return Math.abs(pb - pa) < 5 * 60 * 1000;
            })();
            const first =
              grouping === false ||
              !prev ||
              sk(prev) !== sk(m) ||
              !within ||
              showDate;
            const dateLabel = (() => {
              const d = new Date(m.createdAt);
              if (!Number.isFinite(d.getTime())) return "";
              const today = new Date(),
                yest = new Date();
              yest.setDate(today.getDate() - 1);
              if (d.toDateString() === today.toDateString()) return "Today";
              if (d.toDateString() === yest.toDateString())
                return "Yesterday";
              return d.toLocaleDateString([], {
                weekday: "long",
                month: "short",
                day: "numeric",
              });
            })();

            const alb = albumOf[m.id];
            return (
              <React.Fragment key={m.id}>
                {showDate && dateLabel ? (
                  <div className="date-div">
                    <span>{dateLabel}</span>
                  </div>
                ) : null}
                {/* ORD-08: the divider sits at the unread/read BOUNDARY.
                        unreadSepId is the OLDEST unread message; ascending, it
                        renders first among the unread, so the divider goes ABOVE
                        it. Descending it renders LAST among the unread (newer
                        unread rows are above it), so the divider goes BELOW it —
                        see the mirrored render after the row. */}
                {!newestAtTop && unreadSepId === m.id ? (
                  <div className="unread-sep">
                    <span>New messages</span>
                  </div>
                ) : null}
                {alb && !alb.lead ? null : alb ? (
                  <MediaAlbum
                    run={alb.run}
                    token={token}
                    first={first}
                    leadId={alb.leadId}
                    timeFormat={timeFormat}
                    meId={meId}
                  />
                ) : bannerInvite.suppressed.has(m.id) ? null : (
                  <MsgRow
                    m={m}
                    meId={meId}
                    embedded={embedded}
                    readAt={showReceipts === false ? 0 : peerReadAt}
                    seen={seenMeta}
                    isLastAck={m.id === lastAckId}
                    first={first}
                    convTemporary={!!(conversation && conversation.temporary)}
                    linkPreview={linkPreview}
                    timeFormat={timeFormat}
                    onReact={onReact}
                    onBookmark={onBookmark}
                    onForward={onForward}
                    onEdit={onEditMessage}
                    onDelete={onDeleteMessage}
                    onReplyTo={startReply}
                    onJumpTo={jumpToMessage}
                    byId={byId}
                    token={token}
                    isMobile={isMobile}
                    activeId={activeMsgId}
                    onActivate={activateMsg}
                    onDeactivate={deactivateMsg}
                    scrollingRef={scrollingRef}
                    popoverOpenRef={popoverOpenRef}
                    onPopoverChange={setPopoverOpen}
                    onRetry={onRetry}
                    onCancelUpload={onCancelUpload}
                    onPin={onPin}
                    onUnpin={onUnpin}
                    onMarkImportant={onMarkImportant}
                    onJoinMeeting={onJoinMeeting}
                    onRejectMeeting={onRejectMeeting}
                    onOpenTask={onOpenTask}
                    onRetryLoad={onRetryLoad}
                    myIds={myIdSet}
                    onAvatarEnter={handleAvatarEnter}
                    onAvatarLeave={handleAvatarLeave}
                    onAvatarClick={handleAvatarClick}
                  />
                )}
                {/* ORD-08 mirror for newest-at-top — see the note above. */}
                {newestAtTop && unreadSepId === m.id ? (
                  <div className="unread-sep">
                    <span>New messages</span>
                  </div>
                ) : null}
              </React.Fragment>
            );
          })}

          {/* ORD-05: under newest-at-top the OLDER end is the bottom —
                  the Load-earlier affordance lives there instead. */}
          {newestAtTop ? earlierBtn : null}

          {/* Teams-style hover profile card for a chat author (DMs, groups and
                  channels). Single instance for the whole thread; portaled. Info is
                  enriched with email/presence/last-seen at render time. */}
          {personCard ? (
            <PersonCard
              info={enrichPersonCard(personCard.info)}
              rect={personCard.rect}
              // In a DM the "Chat" action would reopen this same conversation,
              // so hide it there; keep it in groups/channels.
              showChat={isGroupish}
              onMessage={() => openDirectChat(personCard.info)}
              onCall={onCallUser ? handleCardCall : undefined}
              onEnter={handleCardEnter}
              onLeave={handleCardLeave}
            />
          ) : null}

          {/* Full profile modal — opened by clicking a chat author's avatar in a group / channel. */}
          {profileModal ? (
            <ProfileModal
              info={enrichPersonCard(profileModal)}
              dm={conversation?.kind === "dm" ? s : undefined}
              onClose={() => setProfileModal(null)}
              onChat={openDirectChat}
              onCall={
                onCallUser
                  ? (p: any, video: boolean) => {
                      setProfileModal(null);
                      handleCardCall(p, video);
                    }
                  : undefined
              }
            />
          ) : null}

          {/* Read status shows WhatsApp-style per-message (grey ✓✓ delivered,
                  blue ✓✓ read) on the message row itself — no separate line. */}

          {inQuery.trim() && !searchMatchIds.length ? (
            <div
              style={{
                color: "var(--g400)",
                fontSize: 13,
                textAlign: "center",
                padding: 20,
              }}
            >
              No matches in this conversation.
            </div>
          ) : null}
        </div>

        {/* Jump to latest — appears only while scrolled away from the
                latest edge. ORD-04: under newest-at-top the latest is the TOP,
                so the pill points (and scrolls) up. */}
        {showJump ? (
          <button
            type="button"
            className="chat-jump-latest"
            aria-label={newestAtTop ? "New messages — jump to top" : "Jump to latest messages"}
            title={newestAtTop ? "New messages" : "Jump to latest"}
            onClick={() => {
              trackEvent("chat.jump_pill.tap"); // §9.2
              // scrollToBottom is direction-aware ("show me the latest"):
              // top edge under newest-at-top, robust bottom-scroll otherwise.
              scrollToBottom();
              setShowJump(false);
            }}
          >
            {newestAtTop ? <IconChevronUp size={18} /> : <IconChevronDown size={18} />}
          </button>
        ) : null}

        {/* Typing indicator */}
        {typingName ? (
          <div
            style={{
              padding: "2px 18px 4px",
              fontSize: 12,
              color: "var(--g500)",
              fontStyle: "italic",
            }}
          >
            {typingName} is typing…
          </div>
        ) : null}

        {/* Composer — replaced by an Unblock banner when this DM peer is
                blocked (WhatsApp-style): a blocked contact can't be messaged. */}
        {peerBlocked ? (
          <div className="ci-blocked">
            <span className="ci-blocked-txt">
              You blocked this contact. You can&apos;t send messages.
            </span>
            <button
              type="button"
              className="ci-blocked-btn"
              onClick={() => {
                const pid = (conversation.members || []).find(
                  (m: string) => m !== meId,
                );
                if (pid && onUnblockUser) onUnblockUser(pid);
              }}
            >
              Unblock
            </button>
          </div>
        ) : pendingRequestInvite ? (
          /* RECIPIENT side of a pending connection request (Teams message
             request): they can READ the sender's message above, then Accept to
             reply or Decline. The composer is replaced until they accept. */
          <div className="ci-request">
            <div className="ci-request-info">
              <span className="ci-request-title">
                {(conversation.name || "This person") + " wants to connect"}
              </span>
              <span className="ci-request-sub">
                Accept to reply, or decline if you don&apos;t know them.
              </span>
            </div>
            <div className="ci-request-actions">
              <button
                type="button"
                className="ci-request-decline"
                onClick={() =>
                  onDeclineRequest && onDeclineRequest(pendingRequestInvite.id)
                }
              >
                Decline
              </button>
              <button
                type="button"
                className="ci-request-accept"
                onClick={() =>
                  onAcceptRequest && onAcceptRequest(pendingRequestInvite.id)
                }
              >
                Accept
              </button>
            </div>
          </div>
        ) : (
          <div
            className="ci"
            style={{ position: "relative" }}
            ref={schedScopeRef}
          >
            <div
              className="ci-box"
              onClick={(e) => {
                const target = e.target as HTMLElement;
                if (target.closest("button, a, input, select, label, .ci-actions-menu, .ci-more-menu, .att-tray, .reply-bar")) return;
                editorRef.current?.focus();
              }}
            >
              {/* Teams-model: pending connection request — you can send a text
                      now; attachments unlock once the other person accepts. */}
              {pendingConnection ? (
                <div className="ci-pending-bar" role="status">
                  <IconClock size={14} />
                  <span>
                    Request sent — you can send a message. Attachments unlock once
                    they accept.
                  </span>
                </div>
              ) : null}
              {/* Reply banner */}
              {replyTo ? (
                <div className="reply-bar">
                  <span className="reply-bar-bar" />
                  <div className="reply-bar-c">
                    <span className="reply-bar-name">
                      Replying to{" "}
                      {replyTo.me ? "yourself" : replyTo.sender.name}
                    </span>
                    {replyTo.text ? (
                      <span
                        className="reply-bar-text msg-prev-1"
                        dangerouslySetInnerHTML={{
                          __html: sanitizeHtml(firstLineHtml(replyTo.text)),
                        }}
                      />
                    ) : (
                      <span className="reply-bar-text">
                        {messageRowPreview(replyTo)}
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    className="reply-bar-x"
                    aria-label="Cancel reply"
                    onClick={() => setReplyTo(null)}
                  >
                    <IconX />
                  </button>
                </div>
              ) : null}

              {/* Hidden file input for the Attach control (the visible button
                      now lives on the composer row's right cluster below). */}
              <input
                name="file-attach"
                ref={fileRef}
                type="file"
                multiple
                style={{ display: "none" }}
                onChange={onFileInput}
              />
              {/* Formatting bar — Teams-style: hidden by default, revealed only
                      when "Show formatting options" is chosen from the + (actions and
                      apps) menu on the composer row. Attach / emoji / actions / voice /
                      schedule / send all live on the row itself now, so this bar holds
                      ONLY the rich-text controls. */}
              {fmtOpen ? (
                <div className="ci-tb ci-fmt-bar">
                  {/* B I U S */}
                  <button
                    className="cb"
                    data-tip="Bold (Ctrl+B)"
                    aria-label="Bold"
                    onClick={() => editorRef.current?.toggleBold()}
                  >
                    <IconBold />

                  </button>
                  <button
                    className="cb"
                    data-tip="Italic (Ctrl+I)"
                    aria-label="Italic"
                    onClick={() => editorRef.current?.toggleItalic()}
                  >
                    <IconItalic />

                  </button>
                  <button
                    className="cb"
                    data-tip="Underline (Ctrl+U)"
                    aria-label="Underline"
                    onClick={() => editorRef.current?.toggleUnderline()}
                  >
                    <IconUnderline />

                  </button>
                  <button
                    className="cb"
                    data-tip="Strikethrough"
                    aria-label="Strikethrough"
                    onClick={() => editorRef.current?.toggleStrike()}
                  >
                    <IconStrikethrough />

                  </button>
                  <div className="ci-sep" />
                  {/* Lists */}
                  <button
                    className="cb"
                    data-tip="Bullet list"
                    aria-label="Bullet list"
                    onClick={() => editorRef.current?.toggleBulletList()}
                  >
                    <IconList />

                  </button>
                  <button
                    className="cb"
                    data-tip="Numbered list"
                    aria-label="Numbered list"
                    onClick={() => editorRef.current?.toggleOrderedList()}
                  >
                    <IconListOrdered />

                  </button>
                  <div className="ci-sep" />
                  {/* Indent / outdent */}
                  <button
                    className="cb"
                    data-tip="Decrease indent"
                    aria-label="Decrease indent"
                    onClick={() => editorRef.current?.outdent()}
                  >
                    <IconIndentDecrease />

                  </button>
                  <button
                    className="cb"
                    data-tip="Increase indent"
                    aria-label="Increase indent"
                    onClick={() => editorRef.current?.indent()}
                  >
                    <IconIndentIncrease />

                  </button>
                  <div className="ci-sep" />
                  {/* Quote, link, code */}
                  <button
                    className="cb"
                    data-tip="Blockquote"
                    aria-label="Blockquote"
                    onClick={() => editorRef.current?.toggleBlockquote()}
                  >
                    <IconQuote />

                  </button>
                  <button
                    className="cb"
                    data-tip="Insert link"
                    aria-label="Insert link"
                    onClick={() => {
                      promptDialog("Enter URL", "", {
                        title: "Insert link",
                        placeholder: "https://example.com",
                        confirmText: "Insert",
                      }).then((url) => {
                        if (url) editorRef.current?.setLink(url);
                      });
                    }}
                  >
                    <IconLink />

                  </button>
                  <button
                    className="cb"
                    data-tip="Inline code"
                    aria-label="Inline code"
                    onClick={() => editorRef.current?.toggleCode()}
                  >
                    <IconCode />

                  </button>
                  {/* Text colour — a native colour picker overlaid on the button;
                        applies the chosen colour to the current selection. */}
                  <label
                    className="cb"
                    data-tip="Text colour"
                    aria-label="Text colour"
                    style={{ position: "relative", cursor: "pointer" }}
                  >
                    <IconTextColor />
                    <input
                      type="color"
                      aria-label="Pick text colour"
                      onChange={(e) =>
                        editorRef.current?.setColor(e.target.value)
                      }
                      style={{
                        position: "absolute",
                        inset: 0,
                        width: "100%",
                        height: "100%",
                        opacity: 0,
                        cursor: "pointer",
                        border: "none",
                        padding: 0,
                      }}
                    />
                  </label>
                  <div className="ci-sep" />
                  {/* More menu — Teams "..." pattern */}
                  <div className="ci-more" ref={moreMenuRef}>
                    <button
                      ref={moreBtnRef}
                      className="cb"
                      data-tip="More formatting options"
                      aria-label="More formatting options"
                      onClick={openMoreMenu}
                    >
                      <IconMoreHorizontal />

                    </button>
                    {moreMenu && moreMenuPos &&
                      createPortal(
                        <div
                          ref={moreMenuPortalRef}
                          className="ci-more-menu"
                          style={{
                            position: "fixed",
                            left: moreMenuPos.left,
                            bottom: moreMenuPos.bottom,
                            right: "auto",
                            top: "auto",
                          }}
                          onClick={() => setMoreMenu(false)}
                        >
                          <button
                            onClick={() => editorRef.current?.toggleCodeBlock()}
                          >
                            <IconCode />
                            Code block
                          </button>
                          <button
                            onClick={() => editorRef.current?.clearFormatting()}
                          >
                            <IconRemoveFormatting />
                            Clear all formatting
                          </button>
                          <div className="ci-more-sep" />
                          <button
                            onClick={() =>
                              editorRef.current?.setHorizontalRule()
                            }
                          >
                            <IconMinus />
                            Insert horizontal rule
                          </button>
                          <button
                            onClick={() => editorRef.current?.insertTable()}
                          >
                            <IconTable />
                            Insert table
                          </button>
                          <button
                            onClick={() => editorRef.current?.addColumnAfter()}
                          >
                            <svg viewBox="0 0 24 24">
                              <rect x="3" y="3" width="18" height="18" rx="2" />
                              <line x1="15" y1="3" x2="15" y2="21" />
                            </svg>
                            Insert column
                          </button>
                          <button
                            onClick={() => editorRef.current?.addRowAfter()}
                          >
                            <svg viewBox="0 0 24 24">
                              <rect x="3" y="3" width="18" height="18" rx="2" />
                              <line x1="3" y1="15" x2="21" y2="15" />
                            </svg>
                            Insert row
                          </button>
                          <button
                            onClick={() => editorRef.current?.deleteColumn()}
                          >
                            <svg viewBox="0 0 24 24">
                              <rect x="3" y="3" width="18" height="18" rx="2" />
                              <line x1="15" y1="3" x2="15" y2="21" />
                              <line x1="8" y1="9" x2="12" y2="13" />
                              <line x1="12" y1="9" x2="8" y2="13" />
                            </svg>
                            Delete column
                          </button>
                          <button
                            onClick={() => editorRef.current?.deleteRow()}
                          >
                            <svg viewBox="0 0 24 24">
                              <rect x="3" y="3" width="18" height="18" rx="2" />
                              <line x1="3" y1="15" x2="21" y2="15" />
                              <line x1="9" y1="8" x2="13" y2="12" />
                              <line x1="13" y1="8" x2="9" y2="12" />
                            </svg>
                            Delete row
                          </button>
                          <button
                            onClick={() => editorRef.current?.deleteTable()}
                          >
                            <svg viewBox="0 0 24 24">
                              <rect x="3" y="3" width="18" height="18" rx="2" />
                              <line x1="7" y1="7" x2="17" y2="17" />
                              <line x1="17" y1="7" x2="7" y2="17" />
                            </svg>
                            Delete table
                          </button>
                          <div className="ci-more-sep" />
                          <button onClick={() => editorRef.current?.undo()}>
                            <IconUndo />
                            Undo typing
                          </button>
                        </div>,
                        document.body,
                      )}
                  </div>
                </div>
              ) : null}

              {/* Important-flag banner: when the next message is marked important
                      (from the + menu), show a clear, dismissible indicator so the
                      sender always sees it's on. */}
              {composerImportant && !embedded ? (
                <div className="ci-important-bar">
                  <IconAlertTriangle size={13} />
                  <span>This message will be marked important</span>
                  <button
                    type="button"
                    className="ci-important-x"
                    aria-label="Remove important flag"
                    onClick={() => setComposerImportant(false)}
                  >
                    <IconX size={13} />
                  </button>
                </div>
              ) : null}

              {/* Scheduled messages bar */}
              {(scheduled || []).length > 0 && (
                <div className="sched-bar">
                  <div className="sched-bar-hd">
                    {scheduled.length} Scheduled
                  </div>
                  {scheduled.map((s: any) => (
                    <div className="sched-item" key={s.id}>
                      <span
                        className={
                          "sched-when" +
                          (s.status === "failed" ? " failed" : "")
                        }
                      >
                        {s.status === "failed"
                          ? "Failed to send"
                          : fmtSchedule(s.sendAt)}
                      </span>
                      <span className="sched-body">
                        {messagePreview(s.body)}
                      </span>
                      <button
                        type="button"
                        className="sched-act"
                        onClick={() => {
                          setText(s.body);
                          setEditingSched(s.id);
                          const orig = new Date(s.sendAt);
                          const future =
                            orig.getTime() > Date.now() + 60000
                              ? orig
                              : (() => {
                                const d = new Date();
                                const m = d.getMinutes();
                                d.setMinutes(
                                  m + ((15 - (m % 15)) % 15) + 15,
                                  0,
                                  0,
                                );
                                return d;
                              })();
                          setSchedAt(toLocalInput(future.toISOString()));
                          setSchedOpen(true);
                        }}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="sched-act"
                        onClick={() =>
                          onCancelScheduled && onCancelScheduled(s.id)
                        }
                      >
                        Cancel
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Schedule picker */}
              {schedOpen && (
                <div
                  ref={schedPickerRef}
                  className="sched-pick"
                  tabIndex={-1}
                >
                  <span className="sched-pick-lb">
                    {editingSched ? "Reschedule for" : "Send at"}
                  </span>
                  <input
                    type="datetime-local"
                    value={schedAt}
                    min={toLocalInput(
                      new Date(Date.now() + 60000).toISOString(),
                    )}
                    onChange={(e) => setSchedAt(e.target.value)}
                  />
                  <button
                    type="button"
                    className="sched-go"
                    disabled={!schedAt}
                    onClick={confirmSchedule}
                  >
                    {editingSched ? "Reschedule" : "Schedule"}
                  </button>
                  <button
                    type="button"
                    className="sched-x"
                    onClick={() => {
                      setSchedOpen(false);
                      setEditingSched(null);
                    }}
                  >
                    Cancel
                  </button>
                </div>
              )}

              {/* Attachment preview tray — WhatsApp-style: preview + caption
                    before sending (drag-drop / attach button / paste all land here) */}
              {staged.length > 0 && (
                <div className="att-tray">
                  <div className="att-tray-hd">
                    <span>
                      {staged.length} attachment
                      {staged.length > 1 ? "s" : ""} ready — add a caption
                      below, then Send
                    </span>
                    <button
                      type="button"
                      className="att-tray-clear"
                      onClick={clearStaged}
                      aria-label="Discard attachments"
                    >
                      Discard all
                    </button>
                  </div>
                  <div className="att-tray-items">
                    {staged.map((s) => (
                      <div
                        key={s.id}
                        className="att-chip"
                        title={s.file.name}
                      >
                        {s.isImage && s.url ? (
                          <img
                            src={s.url}
                            alt={s.file.name}
                            className="att-chip-img"
                          />
                        ) : (
                          <div className="att-chip-file">
                            <FileExtAvatar name={s.file.name} size={34} radius={9} />

                            <span className="att-chip-name">
                              {s.file.name}
                            </span>
                            <span className="att-chip-size">
                              {s.file.size / 1024 < 1024
                                ? `${Math.max(1, Math.round(s.file.size / 1024))} KB`
                                : `${(s.file.size / 1048576).toFixed(1)} MB`}
                            </span>
                            {s.asLink ? (
                              <span
                                className="att-chip-size"
                                style={{ color: "#0ea5e9" }}
                              >
                                Will send as a Collab link
                              </span>
                            ) : null}
                          </div>
                        )}
                        <button
                          type="button"
                          className="att-chip-x"
                          onClick={() => removeStaged(s.id)}
                          aria-label={`Remove ${s.file.name}`}
                          disabled={uploadPct[s.id] !== undefined}
                        >
                          <IconX />

                        </button>
                        {uploadPct[s.id] !== undefined ? (
                          <div
                            className="att-chip-prog"
                            aria-label={`Uploading ${uploadPct[s.id]}%`}
                          >
                            <div
                              className="att-chip-prog-bar"
                              style={{ width: `${uploadPct[s.id]}%` }}
                            />
                            <span className="att-chip-prog-pct">
                              {uploadPct[s.id]}%
                            </span>
                          </div>
                        ) : null}
                      </div>
                    ))}
                    <button
                      type="button"
                      className="att-chip-add"
                      onClick={() =>
                        fileRef.current && fileRef.current.click()
                      }
                      aria-label="Add more attachments"
                    >
                      <IconPlus />
                      <span>Add</span>
                    </button>
                  </div>
                </div>
              )}

              {/* Composer row */}
              <div
                className={"ci-row" + (composerStacked ? " stacked" : "")}
                ref={composerRowRef}
              >
                {/* Unified Action Bar — slash-command cheat sheet. Shows the
                        matching commands while "/word" is being typed, then the
                        active command's usage once args begin. Informational
                        only; typing continues in the editor. */}
                {slashMatches.length || slashActive ? (() => {
                  const list = slashActive ? [slashActive] : slashMatches;
                  const active = list.find((c) => c.cmd === slashHover) || list[0];
                  return (
                    <div className="mention-pop slash-pop">
                      <div className="slash-list">
                        <div className="slash-head">Commands</div>
                        {list.map((c) => {
                          const args = c.usage.replace("/" + c.cmd, "").trim();
                          return (
                            <div
                              key={c.cmd}
                              className={"slash-opt" + (active && active.cmd === c.cmd ? " on" : "")}
                              onMouseEnter={() => setSlashHover(c.cmd)}
                            >
                              <div className="slash-opt-top">
                                <span className="slash-cmd">/{c.cmd}</span>
                                {args ? <span className="slash-args">{args}</span> : null}
                              </div>
                              <span className="slash-desc">{c.desc}</span>
                            </div>
                          );
                        })}
                      </div>
                      {active ? (
                        <div className="slash-detail">
                          <div className="slash-detail-title">{active.title}</div>
                          <div className="slash-detail-desc">{active.desc}</div>
                          {active.example ? (
                            <div className="slash-detail-eg">
                              <span className="slash-detail-eg-lbl">Example</span>
                              <code>{active.example}</code>
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  );
                })() : null}
                {/* @mention dropdown */}
                {mq !== null && mentionMatches.length ? (
                  <div className="mention-pop">
                    {mentionMatches.map((p: any, i: number) => (
                      <button
                        key={p.id}
                        className={"mention-opt" + (i === mi ? " on" : "")}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          insertMention(p);
                        }}
                      >
                        <Avatar
                          avatar={{
                            kind: "user",
                            initials: p.initials,
                            color: p.color,
                            avatarUrl: p.avatarUrl,
                          }}
                          size={22}
                        />
                        <span>{p.name}</span>
                      </button>
                    ))}
                  </div>
                ) : null}

                {recording ? (
                  <div
                    style={{
                      flex: 1,
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "0 10px",
                      color: "var(--red)",
                    }}
                  >
                    {!recordingPaused && (
                      <div
                        className="pulsing-dot"
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: 4,
                          background: "var(--red)",
                          animation: "pulse 1.5s infinite",
                        }}
                      />
                    )}
                    {recordingPaused && (
                      <div
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: 4,
                          background: "var(--g400)",
                        }}
                      />
                    )}
                    <span style={{ fontSize: 13, fontWeight: 600 }}>
                      {Math.floor(recordingTime / 60)}:
                      {(recordingTime % 60).toString().padStart(2, "0")}
                    </span>
                    <div style={{ flex: 1 }} />
                    <button
                      className="sb-btn"
                      style={{ color: "var(--g500)" }}
                      data-tip="Discard Recording"
                      aria-label="Discard Recording"
                      onClick={() => stopRecording(true)}
                    >
                      <IconTrash />

                    </button>
                    <button
                      className="sb-btn"
                      style={{ color: "var(--g500)" }}
                      data-tip={recordingPaused ? "Resume Recording" : "Pause Recording"}
                      aria-label={recordingPaused ? "Resume Recording" : "Pause Recording"}
                      onClick={pauseRecording}
                    >
                      {recordingPaused ? (
                        <IconPlay />

                      ) : (
                        <IconPause />

                      )}
                    </button>
                    <button
                      className="sb-btn"
                      style={{ color: "var(--ac)" }}
                      data-tip="Send Recording"
                      aria-label="Send Recording"
                      onClick={() => stopRecording(false)}
                    >
                      <IconSend />

                    </button>
                  </div>
                ) : (
                  <RichTextEditor
                    ref={editorRef}
                    value={text}
                    onChange={onEditorChange}
                    onSend={submit}
                    placeholder={
                      staged.length
                        ? "Add a caption…"
                        : enterToSend !== false
                          ? "Type a message"
                          : "Type a message (⌘/Ctrl+Enter to send)"
                    }
                    mentionUsers={mentionPeople}
                    allowBroadcast={conversation?.kind !== "dm" && conversation?.kind !== "self"}
                    onAddPeople={onAddParticipants}
                    canAddPeople={
                      (conversation?.kind === "group" ||
                        conversation?.kind === "channel") &&
                      !!onAddParticipants &&
                      (conversation?.memberRole === "owner" ||
                        conversation?.memberRole === "admin" ||
                        (!!conversation?.createdBy &&
                          !!meId &&
                          conversation.createdBy === meId))
                    }
                    enterToSend={enterToSend !== false}
                    disabled={recording}
                    onFiles={(files: File[]) => {
                      stageFiles(files);
                      return true;
                    }}
                  />
                )}

                {/* Bottom action bar (Teams-style): sits on its own row UNDER
                        the editor, anchored to the bottom-right of the composer. The
                        editor above grows to its max-height and then scrolls
                        internally, so these icons never move or scroll with the text. */}
                <div className="ci-row-actions">
                  {/* Right-cluster actions (Teams order): emoji · attach · actions
                        and apps (+) · voice · schedule · send. Hidden while a voice
                        recording is in progress — the recorder owns the row. */}
                  {!recording ? (
                    <>
                      <span
                        ref={gifPickerRef}
                        className="ci-row-act"
                        style={{ position: "relative", display: "inline-flex" }}
                      >
                        <button
                          className={"sb-btn" + (gifOpen ? " active" : "")}
                          data-tip="Emoji, GIFs & stickers"
                          aria-label="Emoji, GIFs and stickers"
                          onClick={() => setGifOpen((v) => !v)}
                        >
                          <IconSmile />
                        </button>
                        {gifOpen ? (
                          <GifPicker
                            token={token}
                            onEmoji={(ch: string) => {
                              // Insert at the CURSOR (Tiptap's own API), not
                              // appended to the end — `setText(t => t + ch)`
                              // ignored wherever the caret actually was.
                              if (editorRef.current) editorRef.current.insertText(ch);
                              else setText((t) => t + ch);
                            }}
                            onPick={
                              pendingConnection
                                ? () => {
                                  setGifOpen(false);
                                  flash("You can only send text until this request is accepted.");
                                }
                                : onSendMedia
                                  ? (m: PickedMedia) => onSendMedia(m)
                                  : () => { }
                            }
                            onClose={() => setGifOpen(false)}
                            anchorRef={gifPickerRef}
                          />
                        ) : null}
                      </span>
                      <button
                        className="sb-btn"
                        data-tip={pendingConnection ? "Attachments unlock once your request is accepted" : "Attach file"}
                        aria-label="Attach file"
                        disabled={pendingConnection}
                        onClick={() => fileRef.current && fileRef.current.click()}
                      >
                        <IconPaperclip />
                      </button>
                      {/* Actions (+) — small Teams-style menu holding the formatting
                            toggle + the important-message flag. */}
                      {/* <div
                        className="ci-actions"
                        ref={actionsRef}
                        style={{ position: "relative", display: "inline-flex" }}
                      >
                        <button
                          ref={actionsBtnRef}
                          className={"sb-btn" + (actionsOpen ? " active" : "")}
                          data-tip="Actions"
                          aria-label="Actions"
                          aria-haspopup="menu"
                          aria-expanded={actionsOpen}
                          onClick={openActions}
                        >
                          <IconPlus />
                        </button>
                        {actionsOpen && actionsPos
                          ? createPortal(
                            <div
                              ref={actionsMenuRef}
                              className="ci-actions-menu"
                              role="menu"
                              style={{
                                position: "fixed",
                                left: actionsPos.left,
                                bottom: actionsPos.bottom,
                              }}
                            >
                              <button
                                type="button"
                                role="menuitem"
                                className={fmtOpen ? "active" : ""}
                                onClick={() => {
                                  setFmtOpen((v) => !v);
                                  setActionsOpen(false);
                                }}
                              >
                                <IconType size={16} />
                                <span>
                                  {fmtOpen
                                    ? "Hide formatting options"
                                    : "Show formatting options"}
                                </span>
                              </button>
                              {!embedded ? (
                                <button
                                  type="button"
                                  role="menuitem"
                                  className={composerImportant ? "active" : ""}
                                  onClick={() => {
                                    setComposerImportant((v) => !v);
                                    setActionsOpen(false);
                                  }}
                                >
                                  <IconAlertTriangle size={16} />
                                  <span>
                                    {composerImportant
                                      ? "Unmark as important"
                                      : "Mark as important"}
                                  </span>
                                </button>
                              ) : null}
                            </div>,
                            document.body,
                          )
                          : null}
                      </div> */}
                    </>
                  ) : null}

                  {!recording && !pendingConnection && (
                    <button
                      className="sb-btn"
                      data-tip="Record voice message"
                      aria-label="Record voice message"
                      onClick={startRecording}
                    >
                      <IconMic />

                    </button>
                  )}

                  <button
                    className="sb-btn sched-btn"
                    data-tip="Schedule message"
                    aria-label="Schedule message"
                    disabled={isBlankRich(text) || pendingConnection}
                    onClick={() => {
                      setEditingSched(null);
                      if (!schedAt) {
                        const d = new Date();
                        const m = d.getMinutes();
                        d.setMinutes(m + ((15 - (m % 15)) % 15), 0, 0);
                        setSchedAt(toLocalInput(d.toISOString()));
                      }
                      setSchedOpen((o) => !o);
                    }}
                  >
                    <IconClock />

                  </button>

                  {text.length > 3000 && (
                    <span
                      className="char-count"
                      style={{
                        display: "flex",
                        alignItems: "center",
                        fontSize: 11,
                        color:
                          text.length > 65536
                            ? "var(--red)"
                            : text.length > 4000
                              ? "var(--amb)"
                              : "var(--g400)",
                        marginRight: 8,
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {text.length} / 65536
                    </span>
                  )}
                  <button
                    className="sb-btn"
                    data-tip="Send message"
                    aria-label="Send message"
                    onClick={submit}
                    style={{ marginLeft: 6 }}
                    disabled={
                      text.length > 65536 ||
                      (staged.length === 0 && isBlankRich(text))
                    }
                  >
                    <IconSend />

                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    ) : (
      <TabPane
        tab={tab}
        token={token}
        conversation={conversation}
        offlineDemo={offlineDemo}
        meId={meId}
        onSelectPerson={onSelectPerson}
        messages={messages}
      />
    )
  );
}
