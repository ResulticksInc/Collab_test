import React, { useRef, useState, useEffect, useCallback, useMemo } from "react";
import Avatar, { statusClass } from "./Avatar";
import FloatingMenu from "./FloatingMenu";
import { messagePreview, firstLineHtml } from "../lib/messageText";
import { sanitizeMessageHtml } from "../lib/sanitizeHtml";
import { sidebarTime } from "../lib/time";
import { IconBellOff, IconMoreHorizontal, IconStar, IconChevronDown, IconChevronRight, IconChevronLeft, IconMessageSquarePlus, IconUserPlus, IconUsers, IconHash, IconSearch, IconX, IconPhone, IconPhoneMissed, IconVideo, IconMic, IconMessageSquare, IconBell, IconMail, IconCheckCheck, IconSettings, IconCalendarPlus, IconExternalLink, IconArchive, IconTrash, IconLogOut } from "../lib/icons";
import OverflowToolbar, { type ToolbarItem } from "./OverflowToolbar";

// Call/meeting-log previews ("📞 Call ended · 0:21", "📹 Meeting ended",
// "🎙️ Call recording") open with a raw emoji — render a crisp Lucide glyph
// instead (same mapping the in-chat call log rows use, ChatView ~2946). The
// emoji prefix is stripped and the matching icon leads the preview line.
const CALL_PREVIEW_EMOJI = /^\s*(📞|📹|🎙️|🎙)\s*/u;
function callPreviewIcon(text: string) {
  const m = text.match(CALL_PREVIEW_EMOJI);
  if (!m) return null;
  const rest = text.slice(m[0].length).trim();
  const Icon =
    m[1] === "🎙️" || m[1] === "🎙"
      ? IconMic
      : m[1] === "📹" || /video/i.test(rest)
        ? IconVideo
        : /miss|declin|cancell|no answer|unanswer/i.test(rest)
          ? IconPhoneMissed
          : IconPhone;
  return { Icon, rest };
}

// Conversation-row last-message: render the FIRST formatted line (bullets/bold,
// one line) when the server provides raw HTML; otherwise the plain emoji/text
// preview (voice/file/empty).
function convPreview(c: any) {
  // Call-log previews can arrive via EITHER field (previewHtml after a server
  // refetch, plain preview on a live bump) — check the plain text first so the
  // Lucide treatment covers both.
  const plain = (c && c.preview) || "";
  const callIc = callPreviewIcon(plain);
  if (callIc) {
    const { Icon, rest } = callIc;
    return (
      <div className="cp cp-call">
        <Icon size={12} aria-hidden />
        <span className="cp-call-txt">{rest}</span>
      </div>
    );
  }
  if (c && c.previewHtml) {
    return <div className="cp msg-prev-1" dangerouslySetInnerHTML={{ __html: sanitizeMessageHtml(firstLineHtml(c.previewHtml)) }} />;
  }
  return <div className="cp">{c ? c.preview : ""}</div>;
}

function passFilter(c, f) {
  if (!c) return false;
  if (f === "unread") return (c.unread || 0) > 0;
  if (f === "read") return (c.unread || 0) === 0;
  if (f === "groups") return c.kind === "group";
  if (f === "archived") return !!c.hidden;
  if (f === "fav") return !!c.starred;
  // Smart Inbox: what's waiting on YOU — unread DMs / @mentions ("action") and
  // meeting invites ("timely"). Buckets are computed server-side (serialize.ts),
  // rules-only, no AI.
  if (f === "priority") return c.priority === "action" || c.priority === "timely";
  return true;
}


function ConvRowImpl({ c, active, onSelect, onStar, onAction, selectMode = false, selected = false, onToggleSelect, draft = "" }) {
  const unread = (c.unread || 0) > 0;
  // Teams-style unsent DRAFT: a plain one-line preview of the composer text this
  // conversation has waiting. Rendered in place of the last-message preview.
  const draftText = draft ? messagePreview(draft) : "";
  const hasDraft = !!draftText;
  // A conversation with no last message has nothing to put on the preview line.
  // Checked against the SAME two fields convPreview() reads, so the two can't
  // disagree and leave an empty preview row rendered (or a preview with the
  // timestamp missing). Whitespace-only previews count as empty.
  const hasPreview = !!(
    (c && c.previewHtml) ||
    (c && typeof c.preview === "string" && c.preview.trim())
  );
  const timeLabel = c.lastMessageAt ? sidebarTime(c.lastMessageAt) : "";
  // Whether this conversation has any message at all. When empty, message-dependent
  // actions (Mark as unread, Clear chat) stay visible but soft-disabled — clicking
  // shows an explanation instead of silently doing nothing / leaving a phantom dot.
  const hasMessages = !!(unread || hasPreview || c.lastMessageAt);
  const menuItems = [
    { label: c?.muted ? "Unmute" : "Mute", icon: c?.muted ? <IconBell size={18} /> : <IconBellOff size={18} />, onClick: () => onAction("mute", c?.id) },
    { label: c?.starred ? "Remove favourite" : "Mark as favourite", icon: <IconStar size={18} />, onClick: () => onAction("star", c?.id) },
    { label: unread ? "Mark as read" : "Mark as unread", icon: unread ? <IconCheckCheck size={18} /> : <IconMail size={18} />, onClick: () => onAction("read", c?.id), muted: !hasMessages },
    ...(c && (c.kind === "group" || c.kind === "channel")
      ? [{ label: "Manage " + (c.kind === "channel" ? "channel" : "group"), icon: <IconSettings size={18} />, onClick: () => onAction("manage", c.id) }]
      : []),
    // A pending connection request (not yet accepted) is text-only — no meeting or
    // call actions until the other person accepts, so hide "Schedule a meeting".
    ...(c && c.kind !== "self" && !c.pendingConnection ? [{ label: "Schedule a meeting", icon: <IconCalendarPlus size={18} />, onClick: () => onAction("schedule", c.id) }] : []),
    { label: "Open in new window", icon: <IconExternalLink size={18} />, onClick: () => onAction("window", c?.id) },
    c?.hidden
      ? { label: "Unarchive chat", icon: <IconArchive size={18} />, onClick: () => onAction("unhide", c?.id) }
      : { label: "Archive chat", icon: <IconArchive size={18} />, onClick: () => onAction("hide", c?.id) },
    // Non-owners can't hard-delete a group/channel — they LEAVE it (the handler
    // enforces the same rule); label it accordingly so the action is honest.
    c && (c.kind === "group" || c.kind === "channel") && c.memberRole !== "owner"
      ? { label: "Leave " + (c.kind === "channel" ? "channel" : "group"), icon: <IconLogOut size={18} />, onClick: () => onAction("delete", c.id), danger: true }
      : {
        label: c && (c.kind === "group" || c.kind === "channel") ? "Delete " + (c.kind === "channel" ? "channel" : "group") : "Clear chat",
        icon: <IconTrash size={18} />,
        onClick: () => onAction("delete", c?.id),
        danger: true,
        // "Clear chat" on an EMPTY DM has nothing to clear → soft-disable it (a
        // group/channel Delete stays available regardless of message count).
        muted: c && c.kind !== "group" && c.kind !== "channel" && !hasMessages,
      },
  ];
  return (
    <div
      className={
        "cv" + (active ? " active" : "") + (c.starred ? " starred-conv" : "") + (unread ? " unread" : "") +
        (selectMode ? " cv-selectable" : "") + (selected ? " cv-selected" : "")
      }
      role="button"
      tabIndex={0}
      aria-label={c.name}
      aria-current={active ? "true" : undefined}
      aria-pressed={selectMode ? selected : undefined}
      onClick={() => (selectMode ? onToggleSelect(c.id) : onSelect(c.id))}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); (selectMode ? onToggleSelect(c.id) : onSelect(c.id)); }
      }}
    >
      {selectMode ? (
        <span className="cv-check" aria-hidden="true">
          <span className={"cv-check-box" + (selected ? " on" : "")}>{selected ? "✓" : ""}</span>
        </span>
      ) : null}
      <div className="ca-wrap">
        {c.muted ? (
          /* Muted: the avatar is replaced by a light-gray circle with a bell-off icon (Teams-style). */
          <span className="cv-mute-av" title="Muted">
            <IconBellOff size={20} />
          </span>
        ) : (
          <Avatar avatar={c?.avatar} size={40} />
        )}
        {!c.muted && c?.avatar && c.avatar.kind === "user" && c.presence ? (
          <span className={"sd " + statusClass(c.presence)} />
        ) : null}
      </div>
      <div className="cv-info">
        {/* BA/CEO #29: with a message, the time sits at the right end of the
            PREVIEW line, not up on the username line.
            But a conversation with NO message has no preview to share that line
            with, so the timestamp was left sitting alone on a second row —
            a whole empty line under the name just to hold a date. In that case
            it moves up to the right end of the NAME line instead, and the
            preview row is dropped entirely. Either way the time is right-
            aligned; it just never occupies a line of its own.
            Format the raw ISO in the browser (local tz); the server `time`
            field is UTC-formatted. */}
        <div className="cn">
          <span className="cn-txt" title={c.name}>{c.name}</span>
        </div>
        {hasDraft || hasPreview ? (
          <div className="cv-preview-row">
            {hasDraft ? (
              <div className="cp cp-draft">
                <span className="cp-draft-lbl">Draft:</span> {draftText}
              </div>
            ) : (
              convPreview(c)
            )}
          </div>
        ) : null}
      </div>
      {/* Single trailing column: the timestamp and the unread badge stack here
          and both right-align to the row's --sbpx guide — the SAME guide the
          section "+" and the hover ⋯ use — so every trailing element in the
          sidebar shares one vertical line regardless of unread state or width. */}
      <div className="cv-meta">
        {timeLabel ? <span className="ct">{timeLabel}</span> : null}
        {/* Smart Inbox: the unread badge's colour encodes the priority bucket —
            red = waiting on you (DM / @mention), amber = meeting invite. */}
        {c.unread ? (
          <span
            className={
              "ub" +
              (c.priority === "action"
                ? " ub-action"
                : c.priority === "timely"
                  ? " ub-timely"
                  : "")
            }
            title={
              c.priority === "action"
                ? "Needs you — direct message or mention"
                : c.priority === "timely"
                  ? "Meeting invite"
                  : undefined
            }
          >
            {c.unread}
          </span>
        ) : null}
      </div>
      {/* Inline star removed — "Mark / Remove favourite" lives in the ⋯ menu.
          In multi-select mode the whole row toggles selection, so the ⋯ (and its
          single-row actions) is hidden to avoid a competing click target. */}
      {selectMode ? null : (
        <FloatingMenu
          placement="bottom-end"
          trigger={
            <button
              className="kebab-btn"
              data-tip="More"
              aria-label="More"
              onClick={(e) => e.stopPropagation()}
            >
              <IconMoreHorizontal size={16} />
            </button>
          }
          items={menuItems}
        />
      )}
    </div>
  );
}
// Memoized so unrelated CoLabV1 re-renders (typing indicators, presence, socket
// events that DON'T change this conversation) skip every row. Default shallow
// compare is correct: onSelect/onStar are stable useCallbacks; onAction changes
// only when the conversation list itself changes (which already re-renders rows).
const ConvRow = React.memo(ConvRowImpl);
const Empty = ({ label }) => (
  <div style={{ padding: "10px var(--sbpx, 14px)", fontSize: 12, color: "var(--g400)" }}>
    {label}
  </div>
);

function SearchResultsImpl({ results, onSelect, onSelectPerson, onSelectMessage }) {
  const { people = [], conversations = [], messages = [] } = results;
  const none = !people.length && !conversations.length && !messages.length;
  return (
    <div className="sb-body">
      {none ? <Empty label="No results" /> : null}
      {conversations.length ? (
        <>
          <div className="sec-lbl">Conversations</div>
          {conversations.map((c) => (
            <div key={c.id} className="cv" onClick={() => onSelect(c.id)}>
              <div className="ca-wrap">
                <Avatar avatar={c.avatar} size={36} />
              </div>
              <div className="cv-info">
                <div className="cn" title={c.name}>{c.name}</div>
                {convPreview(c)}
              </div>
            </div>
          ))}
        </>
      ) : null}
      {people.length ? (
        <>
          <div className="sec-lbl">People</div>
          {people.map((p) => (
            <div key={p.id} className="cv" onClick={() => onSelectPerson(p.id)}>
              <div className="ca-wrap">
                <Avatar
                  avatar={{
                    kind: "user",
                    initials: p.initials,
                    color: p.color,
                    avatarUrl: p.avatarUrl,
                  }}
                  size={36}
                />
              </div>
              <div className="cv-info">
                <div className="cn" title={p.name}>{p.name}</div>
                <div className="cp">Start a direct message</div>
              </div>
            </div>
          ))}
        </>
      ) : null}
      {messages.length ? (
        <>
          <div className="sec-lbl">Messages</div>
          {messages.map((m) => (
            <div
              key={m.id}
              className="cv"
              onClick={() =>
                onSelectMessage
                  ? onSelectMessage(m.conversationId, m.id)
                  : onSelect(m.conversationId)
              }
            >
              <div className="ca-wrap">
                <Avatar
                  avatar={{
                    kind: "user",
                    initials: m.sender.initials,
                    color: m.sender.color,
                    avatarUrl: m.sender.avatarUrl,
                  }}
                  size={36}
                />
              </div>
              <div className="cv-info">
                <div className="cn" title={m.sender?.name && m.sender.name !== "You" ? m.sender.name : ""}>{m.sender?.name && m.sender.name !== "You" ? m.sender.name : ""}</div>
                <div className="cp">{messagePreview(m.text)}</div>
              </div>
            </div>
          ))}
        </>
      ) : null}
    </div>
  );
}
// Memoized — while a search is open, unrelated CoLabV1 re-renders skip it.
const SearchResults = React.memo(SearchResultsImpl);

const SkeletonRows = () => (
  <div aria-hidden="true" style={{ padding: "2px 0" }}>
    {[0, 1, 2, 3, 4].map((i) => (
      <div key={i} className="cv-skel">
        <span className="cv-skel-av" />
        <span className="cv-skel-lines">
          <span />
          <span />
        </span>
      </div>
    ))}
  </div>
);

// Pending connection-request rows (the "Requests" sidebar filter). Sender avatar
// + name + how-long-ago, with Accept / Decline. State updates live: accepting or
// declining refetches invites in the parent, so the row drops off immediately.
function RequestsList({ requests, onAccept, onDecline, loading }: any) {
  if (loading && (!requests || !requests.length)) return <SkeletonRows />;
  if (!requests || !requests.length)
    return <Empty label="No pending requests" />;
  const av = (u: any) => ({
    kind: "user",
    initials: u && u.initials,
    color: u && u.color,
    avatarUrl: u && u.avatarUrl,
  });
  return (
    <>
      <div className="sec-lbl">Connection requests</div>
      {requests.map((i: any) => (
        <div key={i.id} className="req-row">
          <Avatar avatar={av(i.from)} size={40} />
          <div className="req-info">
            <div className="cn">{(i.from && i.from.name) || "Someone"}</div>
            <div className="cp">
              Wants to connect
              {i.createdAt ? " · " + sidebarTime(i.createdAt) : ""}
            </div>
          </div>
          <div className="req-actions">
            <button
              className="req-accept"
              onClick={() => onAccept && onAccept(i.id)}
            >
              Accept
            </button>
            <button
              className="req-decline"
              onClick={() => onDecline && onDecline(i.id)}
            >
              Decline
            </button>
          </div>
        </div>
      ))}
    </>
  );
}

// Memoized: rendered inside the giant CoLabV1 root (and portaled into calls/
// meetings), so without memo it re-rendered on every root state change (typing,
// read-receipts, timers) — visibly janky during a call. With stable callback
// props (see CoLabV1) it now only re-renders when its own data actually changes.
function ConversationSidebar({
  conversations,
  drafts = {},
  selfPresence,
  loading,
  activeId,
  onSelect,
  filter,
  onFilter,
  search,
  onSearch,
  // Bumped by the parent to programmatically OPEN the sidebar search (e.g. when the
  // top-bar global search's "Chat" scope is picked from another module). Any
  // increment reveals the search bar.
  openSearchTick = 0,
  searchResults,
  onSelectPerson,
  onSelectMessage,
  onStar,
  onMute,
  onConvAction,
  // Optional batch handler for multi-select. When present, a "Select" affordance
  // appears (Groups header) enabling checkbox selection + one-shot bulk
  // leave/delete. Omitted by the embedded in-call sidebar (no bulk there).
  onBulkConvAction = null,
  onCreateGroup,
  onCreateChannel,
  onNewDm,
  workspaceName,
  // Optional so the embedded (in-call) instance can omit them — the panel owns
  // width there and the resize handle is hidden.
  sidebarWidth = 348,
  onResize = (_w: number) => { },
  invites = [],
  onAcceptInvite,
  onDeclineInvite,
  // EMBEDDED mode: render the SAME Messages sidebar inside the in-call/meeting
  // collaboration panel. Drops the singleton id="sidebar" (the main app already
  // owns it) and the global collapse/resize affordances (which drive app-wide
  // state); the panel wrapper owns width. All gated so the main sidebar is
  // byte-identical when embedded=false.
  embedded = false,
  onClose = () => { },
}) {
  // The Archive view shows hidden conversations; every other view excludes them.
  const isArchivedView = filter === "archived";
  // Memoize the filter + the four grouped sorts so they only recompute when the
  // conversation list or filter actually changes — not on every unrelated
  // CoLabV1 re-render (typing/presence/socket events). `visible` is memoized
  // FIRST so the grouped memos below get a stable dep.
  const visible = useMemo(
    () => (conversations || []).filter((c: any) =>
      c && (isArchivedView ? (!!c.hidden && c.kind !== "self") : (passFilter(c, filter) && !c.hidden))),
    [conversations, isArchivedView, filter],
  );
  const hidden = useMemo(() => (conversations || []).filter((c: any) => c && c.hidden), [conversations]);
  const [showHidden, setShowHidden] = useState(false);
  const self = useMemo(() => (conversations || []).find((c: any) => c && c.kind === "self"), [conversations]);
  // Order: most recent activity (date + time of the last message) first. The
  // unread count is a badge only — it never changes a row's position.
  const { favs, chats, channels } = useMemo(() => {
    const recency = (c: any) => {
      const t = c && c.lastMessageAt ? Date.parse(c.lastMessageAt) : NaN;
      return Number.isNaN(t) ? 0 : t;
    };
    const byRecent = (a: any, b: any) => {
      // No special tier for temporary (call/meeting) groups: an unconditional
      // temp-first pin kept an auto-created call group glued to the top of
      // Chats for its whole 7-day life, so chats with NEWER activity never
      // rose above it — the reported "latest chats are not moving to top".
      // A just-created temp group still surfaces at the top the honest way:
      // its ported messages/attachments carry the newest lastMessageAt at that
      // moment, and afterwards it decays by recency like every other chat
      // (ORD-14: most recent activity first).
      return recency(b) - recency(a);
    };
    return {
      favs: visible.filter((c: any) => c && c.starred && c.kind !== "self").sort(byRecent),
      chats: visible.filter((c: any) => c && (c.kind === "dm" || c.kind === "group") && !c.starred).sort(byRecent),
      channels: visible.filter((c: any) => c && c.kind === "channel" && !c.starred).sort(byRecent),
    };
  }, [visible]);
  // Role-tiered grouping for the "Unread" view (reached from the dashboard's
  // Unread shortcut): bucket by the SENDER's org role, senior roles first, using
  // the senderRoleRank the server attaches per conversation. Only built for the
  // unread filter — every other view keeps the kind-based sections below.
  const roleGrouped = filter === "unread";
  const roleTiers = useMemo(() => {
    if (!roleGrouped) return [] as { role: string; rank: number; items: any[] }[];
    const recency = (c: any) => {
      const t = c && c.lastMessageAt ? Date.parse(c.lastMessageAt) : NaN;
      return Number.isNaN(t) ? 0 : t;
    };
    const map = new Map<string, { role: string; rank: number; items: any[] }>();
    for (const c of visible) {
      if (!c || c.kind === "self") continue;
      const role = c.senderRole || "";
      const rank = typeof c.senderRoleRank === "number" ? c.senderRoleRank : 0;
      const key = role || "_none";
      let t = map.get(key);
      if (!t) { t = { role, rank, items: [] }; map.set(key, t); }
      t.items.push(c);
    }
    const tiers = [...map.values()];
    tiers.forEach((t) => t.items.sort((a, b) => recency(b) - recency(a)));
    // Senior roles first; the roleless "Other" bucket (rank 0) sinks to the end.
    tiers.sort((a, b) => b.rank - a.rank || a.role.localeCompare(b.role));
    return tiers;
  }, [visible, roleGrouped]);
  const roleLabel = (role: string) => {
    if (!role) return "Other";
    const cap = role.charAt(0).toUpperCase() + role.slice(1);
    return /s$/i.test(cap) ? cap : cap + "s";
  };
  // ── Multi-select (bulk leave/delete of conversations) ──────────────────────
  // Local UI state only; the batch itself is delegated to the parent via
  // onBulkConvAction so the exact owner→delete / member→leave / DM→archive rule
  // (and its single confirmation) lives in ONE place shared with the per-row ⋯.
  const bulkEnabled = typeof onBulkConvAction === "function";
  // Select mode is SCOPED to ONE section — clicking "Select" in Chats
  // makes DM and Group rows selectable, "Select" in Channels only channels. null = off.
  const [selectScope, setSelectScope] = useState<"chats" | "channel" | null>(null);
  // Folder-based expand/collapse (Teams-style): each sidebar section (Favourites,
  // Chats, Channels) is a collapsible folder; the collapsed set
  // persists so it survives reloads. Same chevron pattern the Archived peek uses.
  const [collapsedFolders, setCollapsedFolders] = useState<Record<string, boolean>>(
    () => {
      try {
        return JSON.parse(localStorage.getItem("clb_folders_collapsed") || "{}");
      } catch {
        return {};
      }
    },
  );
  const toggleFolder = useCallback((k: string) => {
    setCollapsedFolders((prev) => {
      const next = { ...prev, [k]: !prev[k] };
      try {
        localStorage.setItem("clb_folders_collapsed", JSON.stringify(next));
      } catch {
        /* private mode — collapse still works for the session */
      }
      return next;
    });
  }, []);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  // A row is selectable only when its kind matches the active scope.
  const rowInScope = (c: any) =>
    selectScope !== null &&
    c &&
    (selectScope === "chats"
      ? c.kind === "dm" || c.kind === "group"
      : c.kind === selectScope);
  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const exitSelect = useCallback(() => {
    setSelectScope(null);
    setSelectedIds(new Set());
  }, []);
  // Leaving the current view (or losing the bulk handler) cancels selection so a
  // stale set can't be actioned against a filter the user has since navigated away from.
  useEffect(() => { exitSelect(); }, [filter, bulkEnabled, exitSelect]);
  // Verb reflects the selection: a set that is ONLY non-owner groups/channels is a
  // "Leave"; anything the user owns (or a DM) makes it "Delete" (the parent's
  // confirm then spells out the exact mix before anything is destroyed).
  const bulkVerb = useMemo(() => {
    if (!selectedIds.size) return "Delete";
    const picked = (conversations || []).filter((c: any) => c && selectedIds.has(c.id));
    const allLeave = picked.length > 0 && picked.every(
      (c: any) => c && (c.kind === "group" || c.kind === "channel") && c.memberRole !== "owner",
    );
    return allLeave ? "Leave" : "Delete";
  }, [conversations, selectedIds]);
  const runBulk = useCallback(async () => {
    if (!bulkEnabled || !selectedIds.size) return;
    const ok = await onBulkConvAction("delete", [...selectedIds]);
    if (ok) exitSelect();
  }, [bulkEnabled, onBulkConvAction, selectedIds, exitSelect]);
  // Single row factory so selection wiring lives in one place instead of being
  // threaded through all six render sites (You-row excluded — it isn't deletable).
  const renderConvRow = (c: any) => (
    <ConvRow
      key={c.id}
      c={c}
      active={activeId === c.id}
      draft={drafts[c.id] || ""}
      onSelect={onSelect}
      onStar={onStar}
      onAction={onConvAction}
      selectMode={rowInScope(c)}
      selected={selectedIds.has(c.id)}
      onToggleSelect={toggleSelect}
    />
  );
  // "You" (self-notes) row. Same ⋯ actions as any chat (favourite / open in new
  // window / archive / clear) — and it now RENDERS in the section that matches its
  // state: Favourites when starred, Direct Messages otherwise, and nowhere in the
  // main list once archived (it surfaces in the Archived peek instead). So the menu
  // actions actually move it, like every other conversation.
  const selfFav = !!(self && self.starred && !self.hidden);
  const selfInDm = !!(self && !self.starred && !self.hidden);
  const renderYouItem = () =>
    self ? (
      <div
        key="you-self"
        className={"you-item" + (activeId === self.id ? " active" : "")}
        onClick={() => onSelect(self.id)}
      >
        <div className="ca-wrap">
          <Avatar avatar={self.avatar} size={40} />
          <span className={"sd " + statusClass(selfPresence)} />
        </div>
        <div className="cv-info">
          <div className="cn">You</div>
          <div className="cp">Message yourself · notes &amp; files</div>
        </div>
        <FloatingMenu
          placement="bottom-end"
          trigger={
            <button
              className="kebab-btn"
              data-tip="More"
              aria-label="More"
              onClick={(e) => e.stopPropagation()}
            >
              <IconMoreHorizontal size={16} />
            </button>
          }
          items={[
            {
              label: self.starred ? "Remove favourite" : "Mark as favourite",
              icon: <IconStar size={18} />,
              onClick: () => onConvAction("star", self.id),
            },
            { label: "Open in new window", icon: <IconExternalLink size={18} />, onClick: () => onConvAction("window", self.id) },
            self.hidden
              ? { label: "Unarchive chat", icon: <IconArchive size={18} />, onClick: () => onConvAction("unhide", self.id) }
              : { label: "Archive chat", icon: <IconArchive size={18} />, onClick: () => onConvAction("hide", self.id) },
            { label: "Clear chat", icon: <IconTrash size={18} />, onClick: () => onConvAction("delete", self.id), danger: true },
          ]}
        />
      </div>
    ) : null;
  // The "+" / New-DM affordances focus the workspace search so the user can find
  // "New DM" opens the Contacts module (where you pick a person / send a
  // connection request) — the old behavior focused a search box that no longer
  // exists, so the button did nothing.
  const startNewDm = () => { if (onNewDm) onNewDm(); };
  // Pending incoming connection requests — surfaced as a sidebar filter between
  // All and Unread (and rendered as an actionable Accept/Decline list).
  const requests = useMemo(
    () =>
      (invites || []).filter(
        (i: any) => i.direction === "incoming" && i.status === "pending" && i.from,
      ),
    [invites],
  );
  const FILTERS: [string, string][] = [
    ["all", "All"],
    ["requests", "Requests"],
    // Starred conversations (the "Favourites" section on its own).
    ["fav", "Favourites"],
    ["unread", "Unread"],
    ["read", "Read"],
    ["groups", "Groups"],
    ["archived", "Archived"],
  ];
  // Filter chips for the width-adaptive OverflowToolbar. Single source of truth is
  // still `filter` + `onFilter`; the toolbar promotes the active chip and pushes
  // whatever doesn't fit into a ⋮ menu on its own. The Requests chip shows the
  // pending-request count.
  const filterItems: ToolbarItem[] = FILTERS.map(([id, label]) => ({
    id,
    label,
    badge: id === "requests" && requests.length ? requests.length : undefined,
  }));
  const [resizing, setResizing] = useState(false);
  const [dragW, setDragW] = useState<number | null>(null);
  // Header "New group or channel" button opens a two-option chooser instead of
  // jumping straight into group creation — channels were only reachable from
  // the Channels section (+), which nobody found.
  const [createOpen, setCreateOpen] = useState(false);
  const createRef = useRef<HTMLDivElement>(null);
  // The DM-sidebar search bar is HIDDEN by default; the search toggle in the
  // header (between Collapse and New DM) reveals it below the header. Closing
  // (toggle again / Escape / ✕) hides the bar and clears the query so the filter
  // chips / list return.
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const closeSearch = useCallback(() => {
    onSearch && onSearch("");
    setSearchOpen(false);
  }, [onSearch]);
  // Focus the input as soon as the bar is revealed so typing works right away.
  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);
  // Parent-driven open (top-bar "Chat" scope lands here). Any tick increment reveals
  // the search bar; the initial 0 is a no-op so it stays hidden on mount.
  useEffect(() => {
    if (openSearchTick > 0) setSearchOpen(true);
  }, [openSearchTick]);
  useEffect(() => {
    if (!createOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (createRef.current && !createRef.current.contains(e.target as Node)) setCreateOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [createOpen]);
  const moreItemStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: "100%",
    padding: "8px 10px",
    border: "none",
    borderRadius: 8,
    background: "transparent",
    cursor: "pointer",
    textAlign: "left",
    fontSize: 13,
    color: "var(--g800)",
  };
  const drag = useRef({ active: false, startX: 0, startW: 0, lastW: 0 });
  const onResizeRef = useRef(onResize);
  useEffect(() => {
    onResizeRef.current = onResize;
  }, [onResize]);
  const onMove = useCallback((e: PointerEvent) => {
    if (!drag.current.active) return;
    let w = drag.current.startW + (e.clientX - drag.current.startX);
    // Minimum collapse width: the narrowest the sidebar may be dragged. Held at
    // the point where the row layout stays clean — avatar + name + trailing
    // timestamp, section headers and the search field all still read without
    // cramping (the reference "minimum" the user signed off on). Below this the
    // trailing column and search placeholder start to clip.
    if (w < 248) w = 248;
    if (w > 460) w = 460;
    drag.current.lastW = w;
    setDragW(w);
  }, []);
  const onUp = useCallback(() => {
    if (!drag.current.active) return;
    drag.current.active = false;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    setResizing(false);
    setDragW(null);
    if (onResizeRef.current) onResizeRef.current(drag.current.lastW);
  }, [onMove]);
  useEffect(
    () => () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    },
    [onMove, onUp],
  );
  const startResize = (e: any) => {
    e.preventDefault();
    const cur = (dragW != null ? dragW : sidebarWidth) || 348;
    drag.current = {
      active: true,
      startX: e.clientX,
      startW: cur,
      lastW: cur,
    };
    setResizing(true);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  return (
    <div
      id={embedded ? undefined : "sidebar"}
      className={
        [embedded ? "sb-embedded" : "", resizing ? "resizing" : ""]
          .filter(Boolean)
          .join(" ") || undefined
      }
      style={
        {
          ["--sbw"]: ((dragW != null ? dragW : sidebarWidth) || 348) + "px",
        } as React.CSSProperties
      }
    >
      <div className="sb-hd">
        {/* Figma Chats header: brand tile + "Chats". */}
        {/* <span className="sb-hd-ico" aria-hidden="true">
          <IconMessageSquare />
        </span> */}
        <h2>{"Chats"}</h2>
        {embedded ? (
          onClose ? (
            <button
              className="ib"
              data-tip="Close"
              aria-label="Close chat sidebar"
              onClick={onClose}
            >
              <IconX size={17} />
            </button>
          ) : null
        ) : (
          <button
            className="ib"
            data-tip="Collapse sidebar"
            aria-label="Collapse sidebar"
            onClick={() => document.body.classList.add("sb-collapsed")}
          >
            {/* <IconChevronLeft /> */}
          </button>
        )}
        {/* New-DM + New-Group are hidden in the in-call/meeting (embedded) sidebar
            — you're picking an EXISTING conversation to chat in mid-call, not
            starting a brand-new one from here. */}
        {!embedded && (
          <>
            {/* Search toggle — sits between Collapse and New DM; reveals the search
                bar below the header (hidden by default). */}
            <button
              className={"ib" + (searchOpen ? " active" : "")}
              data-tip="Search chats"
              aria-label="Search chats and people"
              aria-pressed={searchOpen}
              onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
            >
              <IconSearch />
            </button>
            <button
              className="ib"
              data-tip="New DM"
              aria-label="New DM"
              onClick={startNewDm}
            >
              <IconMessageSquarePlus />
            </button>
            <div ref={createRef} style={{ position: "relative", display: "inline-flex" }}>
              <button
                className="ib"
                data-tip="New Group / Channel"
                aria-label="New Group or Channel"
                aria-expanded={createOpen}
                onClick={() => setCreateOpen((o) => !o)}
              >
                <IconUserPlus />
              </button>
              {createOpen ? (
                <div
                  style={{
                    position: "absolute",
                    top: "100%",
                    right: 0,
                    marginTop: 4,
                    zIndex: 60,
                    minWidth: 224,
                    background: "var(--bg, #fff)",
                    border: "1px solid var(--g200)",
                    borderRadius: 10,
                    boxShadow: "0 12px 32px rgba(0,0,0,0.18)",
                    padding: 6,
                  }}
                >
                  <button
                    style={{ ...moreItemStyle, alignItems: "flex-start" }}
                    onClick={() => {
                      setCreateOpen(false);
                      onCreateGroup();
                    }}
                  >
                    <IconUsers size={16} style={{ marginTop: 2, flexShrink: 0 }} />
                    <span>
                      <span style={{ display: "block", fontWeight: 600 }}>Group</span>
                      <span style={{ display: "block", fontSize: 12, color: "var(--g500, #6b7280)" }}>
                        A private space for the people you add
                      </span>
                    </span>
                  </button>
                  <button
                    style={{ ...moreItemStyle, alignItems: "flex-start" }}
                    onClick={() => {
                      setCreateOpen(false);
                      onCreateChannel();
                    }}
                  >
                    <IconHash size={16} style={{ marginTop: 2, flexShrink: 0 }} />
                    <span>
                      <span style={{ display: "block", fontWeight: 600 }}>Channel</span>
                      <span style={{ display: "block", fontSize: 12, color: "var(--g500, #6b7280)" }}>
                        A shared space for a team or topic
                      </span>
                    </span>
                  </button>
                </div>
              ) : null}
            </div>
          </>
        )}
      </div>
      {/* Conversation-list search — BA/CEO #28: a visible bar again (was hidden
          behind the ⋮ menu). Searches messages & people; results render in the
          SearchResults panel below while a query is active. */}
      {searchOpen ? (
        <div className="sb-search">
          <div className="gsb-wrap">
            <IconSearch className="si" />
            <input
              ref={searchInputRef}
              type="text"
              placeholder="Search messages & people"
              value={search || ""}
              onChange={(e) => onSearch && onSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") closeSearch();
              }}
              aria-label="Search conversations"
            />
            <button className="sb-search-x" aria-label="Clear search" onClick={closeSearch}>
              <IconX size={14} />
            </button>
          </div>
        </div>
      ) : null}
      {searchResults ? (
        <SearchResults
          results={searchResults}
          onSelect={onSelect}
          onSelectPerson={onSelectPerson}
          onSelectMessage={onSelectMessage}
        />
      ) : (
        <>
          <OverflowToolbar
            className="fb"
            itemClassName="ft"
            activeItemClassName="active"
            badgeClassName="ft-c"
            moreClassName="ft ft-more"
            ariaLabel="Conversation filters"
            gap={4}
            items={filterItems}
            activeId={filter}
            onSelect={onFilter}
          />
          <div className="sb-body">
            {selectScope !== null ? (
              <div className="sb-bulkbar" role="toolbar" aria-label="Bulk actions">
                <button
                  type="button"
                  className="sb-bulk-x"
                  onClick={exitSelect}
                  aria-label="Cancel selection"
                  title="Cancel"
                >
                  <IconX size={15} />
                </button>
                <div className="sb-bulk-meta">
                  <span className="sb-bulk-num">{selectedIds.size}</span>
                  <span className="sb-bulk-lbl">
                    selected in{" "}
                    {selectScope === "chats"
                      ? "Chats"
                      : "Channels"}
                  </span>
                </div>
                <button
                  type="button"
                  className="sb-bulk-del"
                  disabled={!selectedIds.size}
                  onClick={runBulk}
                >
                  {bulkVerb}
                  {selectedIds.size ? ` ${selectedIds.size}` : ""}
                </button>
              </div>
            ) : null}
            {filter === "requests" ? (
              <RequestsList
                requests={requests}
                onAccept={onAcceptInvite}
                onDecline={onDeclineInvite}
                loading={loading}
              />
            ) : roleGrouped ? (
              <>
                {roleTiers.length ? (
                  roleTiers.map((t) => (
                    <div key={t.role || "_none"} className="sb-role-tier">
                      <div className="sec-lbl">{roleLabel(t.role)}</div>
                      {t.items.map(renderConvRow)}
                    </div>
                  ))
                ) : loading ? (
                  <SkeletonRows />
                ) : (
                  <Empty label="No unread messages" />
                )}
              </>
            ) : (
              <>
                {favs.length || selfFav ? (
                  <>
                    <div
                      className={"sec-lbl sec-fold" + (collapsedFolders.fav ? " is-collapsed" : "")}
                      style={{ display: "flex", alignItems: "center", justifyContent: "flex-start", gap: 5, cursor: "pointer" }}
                      onClick={() => toggleFolder("fav")}
                    >
                      {collapsedFolders.fav ? <IconChevronRight size={13} /> : <IconChevronDown size={13} />}
                      {/* <IconStar size={13} /> */}
                      Favourites
                    </div>
                    {!collapsedFolders.fav ? (
                      <>
                        {selfFav ? renderYouItem() : null}
                        {favs.map(renderConvRow)}
                      </>
                    ) : null}
                    {/* <div className="div-h" /> */}
                  </>
                ) : null}
                {filter === "fav" ? (
                  /* Favourites filter: only the starred section above — no empty
                     "Chats" block underneath. */
                  favs.length || selfFav ? null : loading ? <SkeletonRows /> : <Empty label="No favourites yet" />
                ) : filter !== "groups" || chats.some((c: any) => c.kind === "group") ? (
                  <div id="chat-section">
                    <div className={"sec-lbl" + (collapsedFolders.chats ? " is-collapsed" : "")} style={{ cursor: "pointer" }} onClick={() => toggleFolder("chats")}>
                      <span
                        className="sec-fold"
                        style={{ cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 4 }}
                      >
                        {collapsedFolders.chats ? <IconChevronRight size={13} /> : <IconChevronDown size={13} />}
                        {filter === "groups" ? "Groups" : "Chats"}
                      </span>
                      {bulkEnabled && chats.length > 0 && !selectScope && !collapsedFolders.chats ? (
                        <button
                          type="button"
                          className="sec-select-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectScope("chats");
                          }}
                          title="Select chats to leave or remove"
                        >
                          Select
                        </button>
                      ) : null}
                    </div>
                    {!collapsedFolders.chats ? (
                      <>
                        {/* "You" (self-notes) sits at the TOP of Chats — unless
                        it's been favourited (→ Favourites) or archived (→ Archived). */}
                        {selfInDm ? renderYouItem() : null}
                        {chats.length ? (
                          chats.map(renderConvRow)
                        ) : selfInDm ? null : loading ? (
                          <SkeletonRows />
                        ) : (
                          <Empty label={filter === "groups" ? "No groups" : "No conversations"} />
                        )}
                      </>
                    ) : null}
                  </div>
                ) : null}
                {/* Channels section temporarily commented out as of now
                {filter !== "fav" && filter !== "groups" ? (
                  <div id="ch-section" style={{ marginTop: 4 }}>
                    <div className="sec-lbl">
                      <span
                        className="sec-fold"
                        onClick={() => toggleFolder("channel")}
                        style={{ cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 4 }}
                      >
                        {collapsedFolders.channel ? <IconChevronRight size={13} /> : <IconChevronDown size={13} />}
                        Channels
                      </span>
                      {bulkEnabled && channels.length > 0 && !selectScope && !collapsedFolders.channel ? (
                        <button
                          type="button"
                          className="sec-select-btn"
                          onClick={() => setSelectScope("channel")}
                          title="Select channels to leave or delete"
                        >
                          Select
                        </button>
                      ) : null}
                    </div>
                    {!collapsedFolders.channel && channels.length ? (
                      channels.map(renderConvRow)
                    ) : null}
                  </div>
                ) : null}
                */}
                {/* Quick "Archived" peek from non-archive views. In the Archive view
                the main list already shows them, so this collapsible is hidden. */}
                {!isArchivedView && hidden.length > 0 ? (
                  <div style={{ marginTop: 4 }}>
                    <div className={"sec-lbl" + (!showHidden ? " is-collapsed" : "")} style={{ cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }} onClick={() => setShowHidden((s) => !s)}>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4, whiteSpace: "nowrap", flexShrink: 0 }}>{showHidden ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />} Archived ({hidden.length})</span>
                      {showHidden && (
                        <button className="sec-select-btn" style={{ whiteSpace: "nowrap", flexShrink: 0 }} onClick={(e) => { e.stopPropagation(); hidden.forEach(c => onConvAction("unhide", c.id)); }}>
                          Restore all
                        </button>
                      )}
                    </div>
                    {showHidden ? hidden.map(renderConvRow) : null}
                  </div>
                ) : null}
                {isArchivedView && visible.length === 0 ? (
                  <Empty label="No archived chats" />
                ) : null}
              </>
            )}
          </div>
        </>
      )}
      {!embedded && (
        <div
          className="sb-resize"
          onPointerDown={startResize}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          title="Drag to resize"
        />
      )}
    </div>
  );
}

export default React.memo(ConversationSidebar);
