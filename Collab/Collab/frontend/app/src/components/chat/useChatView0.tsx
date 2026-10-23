// useChatView0.tsx — ChatView session hook segment 0.
// Mechanical extraction from ChatView.tsx (statements 0–183).
// Statements pulled forward so this hook is self-contained.

import React, { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } from "react";
import { RichTextEditorHandle } from "../RichTextEditor";
import { extractLinksFromMessages, usePopup, CHAT_WINDOW_INITIAL } from "./helpers";
import { Rect } from "./EmojiPicker";
import { api } from "../../lib/api";
import { isDesktopApp } from "../../lib/platform";
import { mimeOf } from "../../lib/desktopFiles";
import { chatImageOpenerRef } from "./FileAttachment";

export function useChatView0(props: any) {
  const {
  conversation,
  messages,
  token,
  meId,
  onSend,
  onSendFile,
  onSendMedia,
  onBack,
  onReact,
  onBookmark,
  onForward,
  onEditMessage,
  onDeleteMessage,
  onStartCall,
  onGlobalSearchScope,
  onAddParticipants,
  onMute,
  onOpenBookmarks,
  onScheduleMeeting,
  onTyping,
  onDraftChange,
  typingUserId,
  connected,
  offlineDemo,
  onToggleTheme,
  readReceipts,
  showReceipts,
  showLastSeen,
  grouping,
  linkPreview,
  timeFormat,
  linkConfirm,
  sendTyping,
  onReply,
  enterToSend,
  huddle,
  inHuddle,
  onJoinHuddle,
  scheduled,
  onSchedule,
  onReschedule,
  onCancelScheduled,
  onSelectPerson,
  onCallUser,
  showToast,
  onRetry,
  onCancelUpload,
  unreadCount,
  onPin,
  onUnpin,
  onMarkImportant,
  freqRank = {},
  endedMeetingIds,
  onUpdateConversation,
  onUploadConversationAvatar,
  me,
  onUpdateProfile,
  onOpenSettings,
  onUploadAvatar,
  onSetMemberRole,
  onRemoveMember,
  onLeaveConversation,
  onManageConversation,
  onLoadEarlier,
  peerBlocked,
  // Teams-model: this DM is a still-pending connection request (sender side). Only
  // TEXT may be sent; attachments/voice/media are disabled + a banner is shown until
  // the recipient accepts.
  pendingConnection = false,
  // RECIPIENT side of a pending request: the incoming invite (or null). When set, the
  // composer is replaced with an Accept / Decline bar — they read the message, then
  // decide. onAcceptRequest/onDeclineRequest take the invite id.
  pendingRequestInvite = null,
  onAcceptRequest,
  onDeclineRequest,
  onBlockUser,
  onUnblockUser,
  onReportUser,
  onJoinMeeting,
  onRejectMeeting,
  onOpenTask,
  onTaskCreated,
  jumpToMessageId,
  onJumped,
  msgLoadStatus,
  onRetryLoad,
  people,
  presence,
  statusMessage,
  onPresenceChange,
  onStatusMessageChange,
  embedded,
  }: any = props;

  // ---- ChatView.tsx statements ----
  const [text, setText] = useState("");
  const [slashHover, setSlashHover] = useState<string | null>(null); // active row in the / menu (drives the detail panel)
  // WhatsApp read ticks: the latest time any OTHER member read up to. A message
  // sent at/before this shows a BLUE double-tick (read); otherwise grey
  // (delivered). One number → cheap to thread through the memoized rows.
  const peerReadAt = React.useMemo(() => {
    const rr = readReceipts || {};
    const isDm = conversation && conversation.kind === "dm";
    if (isDm) {
      // The single peer: the max other-user last-read time.
      let mx = 0;
      for (const [uid, ts] of Object.entries(rr)) {
        if (uid !== meId) {
          const n = Number(ts) || 0;
          if (n > mx) mx = n;
        }
      }
      return mx;
    }
    // Group/channel: only "read" (blue) once EVERY other member has read up to it
    // — the MIN of members' last-read times (a member with no receipt counts as 0
    // = unread, so the min stays 0 until all have read). Avoids the misleading
    // "read by everyone" when only one of N has opened it.
    const others = ((conversation && conversation.members) || []).filter(
      (id: string) => id && id !== meId,
    );
    if (!others.length) return 0;
    let mn = Infinity;
    for (const id of others) {
      const n = Number(rr[id]) || 0;
      if (n < mn) mn = n;
    }
    return mn === Infinity ? 0 : mn;
  }, [readReceipts, meId, conversation]);
  const seenMeta = useMemo(() => {
    if (!conversation || showReceipts === false) return null;
    const others = (((conversation.members as string[]) || [])).filter(
      (id) => id && id !== meId,
    );
    if (!others.length) return null;
    const names: Record<string, string> = {};
    (messages || []).forEach((mm: any) => {
      if (mm && mm.sender && mm.sender.id && mm.sender.name)
        names[mm.sender.id] = mm.sender.name;
    });
    (people || []).forEach((u: any) => {
      if (u && u.id && !names[u.id]) names[u.id] = u.name || u.email || "";
    });
    return { receipts: readReceipts || {}, others, names };
  }, [conversation, showReceipts, readReceipts, meId, messages, people]);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [atTop, setAtTop] = useState(false);
  const [tab, setTab] = useState("chat");
  const [inSearch, setInSearch] = useState(false);
  const [inQuery, setInQuery] = useState("");
  const [chatSearchOpen, setChatSearchOpen] = useState(false);
  const [chatGsQuery, setChatGsQuery] = useState("");
  const [chatGsScope, setChatGsScope] = useState("");
  const chatSearchRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!chatSearchOpen) return;
    const h = (e: MouseEvent) => {
      if (chatSearchRef.current && !chatSearchRef.current.contains(e.target as Node))
        setChatSearchOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [chatSearchOpen]);
  const [matchIdx, setMatchIdx] = useState(0);
  const [note, setNote] = useState("");
  const [gifOpen, setGifOpen] = useState(false);
  const gifPickerRef = useRef<HTMLDivElement>(null);
  const [moreMenu, setMoreMenu] = useState(false);
  const [moreMenuPos, setMoreMenuPos] = useState<{
    left: number;
    bottom: number;
  } | null>(null);
  const [composerImportant, setComposerImportant] = useState(false);
  const [fmtOpen, setFmtOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const actionsRef = useRef<HTMLDivElement>(null); // trigger wrapper
  const actionsBtnRef = useRef<HTMLButtonElement>(null); // the + button (for its rect)
  const actionsMenuRef = useRef<HTMLDivElement>(null); // the portaled menu
  const [actionsPos, setActionsPos] = useState<{ left: number; bottom: number } | null>(null);
  const openActions = useCallback(() => {
    setActionsOpen((v) => {
      const next = !v;
      if (next && actionsBtnRef.current) {
        const r = actionsBtnRef.current.getBoundingClientRect();
        const MENU_W = 224;
        const vw = window.innerWidth;
        let left = r.right - MENU_W;
        left = Math.max(8, Math.min(left, vw - 8 - MENU_W));
        setActionsPos({ left, bottom: window.innerHeight - r.top + 8 });
      }
      return next;
    });
  }, []);
  useEffect(() => {
    if (!actionsOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (actionsRef.current && actionsRef.current.contains(t)) return;
      if (actionsMenuRef.current && actionsMenuRef.current.contains(t)) return;
      setActionsOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setActionsOpen(false);
    };
    // Defer the mousedown listener so the click that opened the menu doesn't close it.
    const id = window.setTimeout(() => document.addEventListener("mousedown", onDown), 0);
    document.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [actionsOpen]);
  const moreMenuRef = useRef<HTMLDivElement>(null); // the "…" trigger wrapper
  const moreBtnRef = useRef<HTMLButtonElement>(null); // the "…" button (for its rect)
  const moreMenuPortalRef = useRef<HTMLDivElement>(null); // the portaled menu
  // Open UPWARD from the button (composer sits at the bottom), right-aligned to
  // it, then CLAMP into the viewport so it can't run off either edge.
  const openMoreMenu = useCallback(() => {
    setMoreMenu((v) => {
      const next = !v;
      if (next && moreBtnRef.current) {
        const r = moreBtnRef.current.getBoundingClientRect();
        const MENU_W = 220;
        const vw = window.innerWidth;
        let left = r.right - MENU_W;
        left = Math.max(8, Math.min(left, vw - 8 - MENU_W));
        setMoreMenuPos({ left, bottom: window.innerHeight - r.top + 6 });
      }
      return next;
    });
  }, []);
  useEffect(() => {
    if (!moreMenu) return;
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (moreMenuRef.current && moreMenuRef.current.contains(t)) return;
      if (moreMenuPortalRef.current && moreMenuPortalRef.current.contains(t))
        return;
      setMoreMenu(false);
    };
    const id = window.setTimeout(
      () => document.addEventListener("mousedown", handler),
      0,
    );
    return () => {
      window.clearTimeout(id);
      document.removeEventListener("mousedown", handler);
    };
  }, [moreMenu]);
  const [schedOpen, setSchedOpen] = useState(false);
  const schedPickerRef = useRef<HTMLDivElement>(null);
  const schedScopeRef = useRef<HTMLDivElement>(null);
  const [schedAt, setSchedAt] = useState("");
  const [editingSched, setEditingSched] = useState<string | null>(null);
  const [mq, setMq] = useState<string | null>(null);
  const mentionPopRef = useRef<HTMLDivElement>(null);
  const [mi, setMi] = useState(0);
  const [replyTo, setReplyTo] = useState<any>(null);
  const [staged, setStaged] = useState<
    {
      id: string;
      file: File;
      url: string;
      isImage: boolean;
      asLink?: boolean;
    }[]
  >([]);
  const [uploadPct, setUploadPct] = useState<Record<string, number>>({});
  const [dragOver, setDragOver] = useState(false);
  const [chatImgNav, setChatImgNav] = useState<{ run: any[]; idx: number } | null>(null);
  const openChatImgNav = useCallback(
    (f: any) => {
      const imgs = (messages || [])
        .filter((mm: any) => mm && mm.file && mimeOf(mm.file).startsWith("image/"))
        .map((mm: any) => ({ file: mm.file }));
      const idx = imgs.findIndex((x: any) => String(x.file?.id) === String(f?.id));
      setChatImgNav({ run: imgs.length ? imgs : [{ file: f }], idx: idx < 0 ? 0 : idx });
    },
    [messages],
  );
  useEffect(() => {
    chatImageOpenerRef.current = openChatImgNav;
    return () => {
      if (chatImageOpenerRef.current === openChatImgNav) chatImageOpenerRef.current = null;
    };
  }, [openChatImgNav]);
  const [infoOpen, setInfoOpen] = useState(false);
  // "search" = search-only panel (header search icon); "details" = full group details (header name).
  const [infoMode, setInfoMode] = useState<"search" | "details">("search");
  const [infoRender, setInfoRender] = useState(false);
  useEffect(() => {
    if (infoOpen) {
      setInfoRender(true);
      return;
    }
    const t = window.setTimeout(() => setInfoRender(false), 220);
    return () => window.clearTimeout(t);
  }, [infoOpen]);
  const [infoMembers, setInfoMembers] = useState<any>(null);
  const [infoFiles, setInfoFiles] = useState<any>(null);
  const [editName, setEditName] = useState<string | null>(null);
  const [editAbout, setEditAbout] = useState<string | null>(null);
  const [editSelfName, setEditSelfName] = useState<string | null>(null);
  const [editDesc, setEditDesc] = useState<string | null>(null);
  const convAvatarRef = useRef<HTMLInputElement>(null);
  const [convAvatarCropFile, setConvAvatarCropFile] = useState<File | null>(null);
  const [infoLinks, setInfoLinks] = useState<any>(null);
  const [aiSummary, setAiSummary] = useState<any>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiErr, setAiErr] = useState<any>(null);
  const [msgLimit, setMsgLimit] = useState(CHAT_WINDOW_INITIAL);
  const [isMobile, setIsMobile] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [recordingPaused, setRecordingPaused] = useState(false);
  const [activeMsgId, setActiveMsgId] = useState<string | null>(null);
  const [imgViewer, setImgViewer] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingIntervalRef = useRef<any>(null);
  const recordingTimeRef = useRef(0);
  const fileRef = useRef<any>(null);
  const listRef = useRef<any>(null);
  // ORD-01/D-3(b): the user's display-order preference. Hoisted above the scroll
  // machinery because the ENTIRE anchor direction depends on it — "latest" is
  // the bottom edge normally, the TOP edge under newest-at-top.
  const newestAtTop = props.newestAtTop === true;
  // Scroll so the LATEST message is in view. Bottom edge normally; under
  // newest-at-top the latest lives at scrollTop 0 (kept name: every caller
  // means "show me the latest", not literally "the bottom").
  const scrollToBottom = (el?: any) => {
    const first = el || listRef.current;
    if (!first) return;
    if (newestAtTop) {
      first.scrollTop = 0;
      return;
    }
    first.scrollTop = first.scrollHeight;
    let frames = 0;
    let lastH = -1;
    const step = () => {
      const n = listRef.current;
      if (!n || frames++ >= 8) return;
      if (n.scrollHeight !== lastH) {
        lastH = n.scrollHeight;
        n.scrollTop = n.scrollHeight;
        requestAnimationFrame(step);
      }
    };
    requestAnimationFrame(step);
  };
  // Distance from the LATEST-message edge (direction-aware).
  const latestGap = (el: any) =>
    newestAtTop
      ? el.scrollTop
      : el.scrollHeight - el.scrollTop - el.clientHeight;
  const composerRef = useRef<any>(null);
  const [showJump, setShowJump] = useState(false);
  const [pinIdx, setPinIdx] = useState(0);
  const editorRef = useRef<RichTextEditorHandle>(null);
  const typingTimer = useRef<any>(null);
  const typingActiveRef = useRef(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const mq = window.matchMedia("(pointer: coarse)");
    setIsMobile(mq.matches);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  useEffect(() => {
    recordingTimeRef.current = recordingTime;
  }, [recordingTime]);
  useEffect(() => {
    if (!isDesktopApp || typeof window === "undefined") return;
    const cd = (window as any).collabDesktop;
    if (!cd || typeof cd.setProgress !== "function") return;
    const ids = Object.keys(uploadPct);
    try {
      if (!ids.length) {
        cd.setProgress(-1); // nothing in flight → clear the indicator
      } else {
        const sum = ids.reduce((n, k) => n + (uploadPct[k] || 0), 0);
        cd.setProgress(Math.max(0, Math.min(1, sum / ids.length / 100)));
      }
    } catch { }
  }, [uploadPct]);
  useEffect(() => {
    if (!isDesktopApp || typeof window === "undefined") return;
    return () => {
      const cd = (window as any).collabDesktop;
      if (cd && typeof cd.setProgress === "function") {
        try { cd.setProgress(-1); } catch { }
      }
    };
  }, []);
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t && t.tagName === "IMG" && t.closest(".msg-rich")) {
        const src = (t as HTMLImageElement).currentSrc || (t as HTMLImageElement).src;
        if (src) {
          e.preventDefault();
          e.stopPropagation();
          setImgViewer(src);
        }
      }
    };
    el.addEventListener("click", onClick, true);
    return () => el.removeEventListener("click", onClick, true);
  }, []);
  usePopup(
    // Scope = the whole composer, so clicking into the editor to change the
    // text of a scheduled message (the Edit flow) keeps the picker open.
    schedScopeRef,
    () => {
      setSchedOpen(false);
      setEditingSched(null);
    },
    schedOpen,
  );
  const convId = conversation && conversation.id;
  const convKind = conversation && conversation.kind;
  useEffect(() => {
    setMsgLimit(CHAT_WINDOW_INITIAL);
    setExhausted(false);
    setAtTop(false);
  }, [convId]);
  useEffect(() => {
    setAiSummary(null);
    setAiErr(null);
    setAiLoading(false);
    setReplyTo(null);
    setInfoOpen(false);
    setInfoMembers(null);
    setActiveMsgId(null);
    // Drop any staged-but-unsent attachments so they can't land in the wrong chat.
    setStaged((prev) => {
      prev.forEach((s) => s.url && URL.revokeObjectURL(s.url));
      return [];
    });
    setDragOver(false);
  }, [convId]);
  useEffect(() => {
    if (!infoOpen || offlineDemo || !token) return;
    if (convKind === "self") return;
    let off = false;
    api
      .getMembers(token, convId)
      .then((d: any) => !off && setInfoMembers(d))
      .catch(() => !off && setInfoMembers([]));
    api
      .getFiles(token, convId)
      .then((d: any) => !off && setInfoFiles(d || []))
      .catch(() => !off && setInfoFiles([]));
    // ISSUE #12: infoLinks is derived client-side from messages (see effect
    // below), NOT api.getLinks — the server can't see URLs in E2EE chats.
    return () => {
      off = true;
    };
  }, [infoOpen, convId, convKind, offlineDemo, token]);
  useEffect(() => {
    if (!infoOpen) return;
    setInfoLinks(extractLinksFromMessages(messages));
  }, [infoOpen, messages]);
  const reloadMembers = useCallback(() => {
    if (!token || !convId) return;
    api
      .getMembers(token, convId)
      .then((d: any) => setInfoMembers(d))
      .catch(() => { });
  }, [token, convId]);
  const mgmtRole = useCallback(
    async (uid: string, role: string) => {
      if (!onSetMemberRole) return;
      await onSetMemberRole(convId, uid, role);
      reloadMembers();
    },
    [onSetMemberRole, convId, reloadMembers],
  );
  const mgmtRemove = useCallback(
    async (uid: string, name: string) => {
      if (!onRemoveMember) return;
      await onRemoveMember(convId, uid, name);
      reloadMembers();
    },
    [onRemoveMember, convId, reloadMembers],
  );
  const mgmtLeave = useCallback(() => {
    if (onLeaveConversation) onLeaveConversation(convId);
  }, [onLeaveConversation, convId]);
  useEffect(() => {
    setTab("chat");
    setInSearch(false);
    setInQuery("");
    setGifOpen(false);
  }, [convId]);
  const stagedRef = useRef(staged);
  stagedRef.current = staged;
  useEffect(
    () => () => {
      stagedRef.current.forEach((s) => s.url && URL.revokeObjectURL(s.url));
    },
    [],
  );
  const draftConvRef = useRef(convId);
  const draftTextRef = useRef(text);
  draftTextRef.current = text;
  useEffect(() => {
    // Reset per-message composer flags on every conversation switch so an
    // "important" toggle, an open formatting bar, or an open Actions menu can never
    // leak from one conversation into the next (ChatView is not remounted on switch).
    setComposerImportant(false);
    setActionsOpen(false);
    setFmtOpen(false);
    if (!convId) {
      draftConvRef.current = convId;
      return;
    }
    const flushConv = convId; // the conversation this effect belongs to
    let restored = "";
    try {
      restored = localStorage.getItem("clb_draft_" + convId) || "";
    } catch (_) { }
    draftConvRef.current = convId;
    setText(restored);
    // Seed the shared drafts map (sidebar "Draft:" indicator) when switching in.
    if (onDraftChange) onDraftChange(convId, restored);
    return () => {
      // Flush the OUTGOING conversation's draft synchronously on switch, so text
      // typed within the debounce window (the last 500ms) isn't dropped when the
      // pending debounced save is cancelled. draftTextRef holds the latest text.
      const t = draftTextRef.current;
      try {
        if (t) localStorage.setItem("clb_draft_" + flushConv, t);
        else localStorage.removeItem("clb_draft_" + flushConv);
      } catch (_) { }
      if (onDraftChange) onDraftChange(flushConv, t || "");
    };
  }, [convId]);
  useEffect(() => {
    if (!convId || draftConvRef.current !== convId) return;
    const t = setTimeout(() => {
      try {
        if (text) localStorage.setItem("clb_draft_" + convId, text);
        else localStorage.removeItem("clb_draft_" + convId);
      } catch (_) { }
      // Lift the (debounced) draft up so the conversation sidebar can show a
      // Teams-style "Draft:" indicator on the row. text is already normalized to
      // "" when blank (onEditorChange), so an emptied composer clears the label.
      if (onDraftChange) onDraftChange(convId, text || "");
    }, 500);
    return () => clearTimeout(t);
  }, [text, convId]);
  const wasNearBottomRef = useRef(true);
  const lastMsgKeyRef = useRef<string>("");
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    let raf = 0;
    const onScroll = () => {
      // The ref write must stay synchronous — other effects (media-load re-snap,
      // the auto-scroll layout effect) read wasNearBottomRef during the same
      // frame. Only the React state update (setShowJump) is batched into a single
      // rAF so a burst of scroll events collapses to one re-render per frame.
      // "NearBottom" reads as "near the LATEST edge" — direction-aware (ORD-03).
      wasNearBottomRef.current = latestGap(el) < 120;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const nearLatest = latestGap(el) < 120;
        setShowJump(!nearLatest && el.scrollHeight - el.clientHeight > 400);
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newestAtTop]);
  useEffect(() => {
    wasNearBottomRef.current = true;
    lastMsgKeyRef.current = "";
    setShowJump(false);
  }, [convId]);
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const onMediaLoad = (e: Event) => {
      const t = e.target as HTMLElement;
      if (!t || (t.tagName !== "IMG" && t.tagName !== "VIDEO")) return;
      // Bottom mode only: media above the fold grew, so re-pin to the bottom.
      // Under newest-at-top the latest edge is scrollTop 0, which media growth
      // BELOW the viewport can't move — snapping to the bottom would yank the
      // reader to the oldest messages.
      if (!newestAtTop && wasNearBottomRef.current) el.scrollTop = el.scrollHeight;
    };
    el.addEventListener("load", onMediaLoad, true);
    el.addEventListener("loadedmetadata", onMediaLoad, true);
    return () => {
      el.removeEventListener("load", onMediaLoad, true);
      el.removeEventListener("loadedmetadata", onMediaLoad, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newestAtTop]);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const arr = messages || [];
    const last = arr.length ? arr[arr.length - 1] : null;
    const key =
      arr.length + ":" + (last ? last.id || last._clientId || "" : "");
    const isNewContent = key !== lastMsgKeyRef.current;
    lastMsgKeyRef.current = key;
    // Pinned-to-bottom is taken from the ref (captured by onScroll BEFORE this
    // update) OR a fresh live-DOM measure — the ref alone can be stale across a
    // re-render. Auto-scroll ONLY when (a) the user was pinned to the bottom and
    // (b) genuinely new content arrived. A background resync (socket reconnect,
    // presence churn, USER_UPDATED) replaces the array with the SAME last
    // message → isNewContent is false → the reader is never yanked down. Done in
    // useLayoutEffect (before paint) so there's no visible jump/flash.
    // A message I JUST SENT (mine / optimistic clientId) must ALWAYS snap to the
    // bottom, even if the pinned check is momentarily false — you initiated it, so
    // the view should follow your message (it was leaving the view scrolled up).
    const ownSent = !!(last && (last.me || last._clientId));
    const pinned = wasNearBottomRef.current || latestGap(el) < 80;
    if (isNewContent && (pinned || ownSent)) {
      // One robust multi-frame scroll handles ALL cases — opening a thread, a message
      // I just sent (status must be visible), and incoming while pinned — converging
      // on the true latest message despite content-visibility's estimated heights.
      scrollToBottom(el);
    }
    // ORD-03 (newest-at-top, reader scrolled down into history): a new message
    // inserts ABOVE the viewport; NATIVE scroll anchoring holds the reader's
    // place. Manual height-delta compensation was tried and reverted — with
    // content-visibility, rows materialize lazily and scrollHeight moves for
    // reasons other than the insert, so a computed delta over-corrects (reads
    // as a jump). The browser's anchor tracks an on-screen element instead,
    // which is exactly the right primitive here — so do nothing.
  }, [messages, convId]);
  useEffect(() => {
    const onEsc = (e: Event) => {
      // Action-based, topmost-first: Esc closes the transient surface the user
      // most recently opened (emoji/GIF picker / schedule picker / info / search /
      // staged / reply) and CLAIMS the event so it never falls through to the
      // global module "Back". Only when nothing here is open does Esc go back.
      // (The GifPicker also owns its own Escape, but claim it here too so a stray
      // focus state can't leak Esc to module Back while the picker is open.)
      if (gifOpen) {
        setGifOpen(false);
        e.preventDefault();
        return;
      }
      if (schedOpen) {
        setSchedOpen(false);
        setEditingSched(null);
        e.preventDefault();
        return;
      }
      if (infoOpen) {
        setInfoOpen(false);
        e.preventDefault();
        return;
      }
      if (inSearch) {
        setInSearch(false);
        setInQuery("");
        e.preventDefault();
        return;
      }
      if (staged.length) {
        clearStaged();
        e.preventDefault();
        return;
      }
      if (replyTo) {
        setReplyTo(null);
        e.preventDefault();
        return;
      }
    };
    window.addEventListener("colab:esc", onEsc);
    return () => window.removeEventListener("colab:esc", onEsc);
  }, [gifOpen, schedOpen, infoOpen, inSearch, replyTo, staged.length]);
  useEffect(() => {
    if (!schedOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      setSchedOpen(false);
      setEditingSched(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [schedOpen]);
  const autoResize = useCallback(() => {
    const el = textRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
  }, []);
  const scrollingRef = useRef(false);
  const popoverOpenRef = useRef(false);
  const scrollIdleRef = useRef<any>(null);
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    let raf = 0;
    const onScroll = () => {
      // These must stay synchronous: scrollingRef + the idle timer gate hover-
      // toolbar activation timing, which is read outside React's render cycle.
      scrollingRef.current = true;
      if (scrollIdleRef.current) clearTimeout(scrollIdleRef.current);
      scrollIdleRef.current = setTimeout(() => {
        scrollingRef.current = false;
      }, 220);
      // The React state updates (atTop affordance, dismissing the hover toolbar)
      // are batched into one rAF so a scroll burst collapses to one re-render per
      // frame instead of firing synchronously on every scroll event.
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        // Track whether we're near the OLDER-messages end so the "Load earlier"
        // affordance only appears when the user has scrolled to it — the top
        // normally, the BOTTOM under newest-at-top (ORD-05: older loads as the
        // user scrolls down). The name keeps its historical meaning of "at the
        // older end".
        setAtTop(
          newestAtTop
            ? el.scrollHeight - el.scrollTop - el.clientHeight < 80
            : el.scrollTop < 80,
        );
        // Scrolling dismisses the hover toolbar — unless a popover is open, in
        // which case the user is mid-interaction and we leave it alone.
        if (!popoverOpenRef.current) setActiveMsgId(null);
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (scrollIdleRef.current) clearTimeout(scrollIdleRef.current);
      if (raf) cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newestAtTop]);
  const activateMsg = useCallback((id: string, _rect: Rect) => {
    if (scrollingRef.current) return;
    setActiveMsgId(id);
  }, []);
  const deactivateMsg = useCallback(() => {
    if (popoverOpenRef.current) return;
    setActiveMsgId(null);
  }, []);
  const setPopoverOpen = useCallback((open: boolean) => {
    popoverOpenRef.current = open;
  }, []);
  useEffect(() => {
    const close = () => {
      popoverOpenRef.current = false;
      setActiveMsgId(null);
    };
    window.addEventListener("colab:close-msg-toolbar", close);
    return () => window.removeEventListener("colab:close-msg-toolbar", close);
  }, []);
  const matched = messages;
  const searchMatchIds = useMemo(
    () =>
      inQuery.trim()
        ? messages
          .filter((m: any) =>
            (m.text || (m.file && m.file.name) || "")
              .toLowerCase()
              .includes(inQuery.toLowerCase()),
          )
          .map((m: any) => m.id)
        : [],
    [messages, inQuery],
  );
  const shown = useMemo(() => {
    const win = matched.slice(Math.max(0, matched.length - msgLimit));
    // Stable-sort the visible window by send time so a rare out-of-order echo
    // (a server MESSAGE_NEW arriving before an earlier optimistic send) can't
    // render messages in the wrong order. If EITHER time is unparseable, keep
    // the original insertion order for that pair (never reorder blindly).
    return win
      .map((m: any, i: number) => [m, i] as [any, number])
      .sort((a, b) => {
        const ta = Date.parse(a[0] && a[0].createdAt);
        const tb = Date.parse(b[0] && b[0].createdAt);
        if (Number.isNaN(ta) || Number.isNaN(tb)) return newestAtTop ? b[1] - a[1] : a[1] - b[1];
        return newestAtTop ? (tb - ta || b[1] - a[1]) : (ta - tb || a[1] - b[1]);
      })
      .map((p) => p[0]);
  }, [matched, msgLimit, newestAtTop]);
  const clearStaged = () => {
    setStaged((prev) => {
      prev.forEach((s) => s.url && URL.revokeObjectURL(s.url));
      return [];
    });
  };

  return {
    conversation,
    messages,
    token,
    meId,
    onSend,
    onSendFile,
    onSendMedia,
    onBack,
    onReact,
    onBookmark,
    onForward,
    onEditMessage,
    onDeleteMessage,
    onStartCall,
    onGlobalSearchScope,
    onAddParticipants,
    onMute,
    onOpenBookmarks,
    onScheduleMeeting,
    onTyping,
    onDraftChange,
    typingUserId,
    connected,
    offlineDemo,
    onToggleTheme,
    readReceipts,
    showReceipts,
    showLastSeen,
    grouping,
    linkPreview,
    timeFormat,
    linkConfirm,
    sendTyping,
    onReply,
    enterToSend,
    huddle,
    inHuddle,
    onJoinHuddle,
    scheduled,
    onSchedule,
    onReschedule,
    onCancelScheduled,
    onSelectPerson,
    onCallUser,
    showToast,
    onRetry,
    onCancelUpload,
    unreadCount,
    onPin,
    onUnpin,
    onMarkImportant,
    freqRank,
    endedMeetingIds,
    onUpdateConversation,
    onUploadConversationAvatar,
    me,
    onUpdateProfile,
    onOpenSettings,
    onUploadAvatar,
    onSetMemberRole,
    onRemoveMember,
    onLeaveConversation,
    onManageConversation,
    onLoadEarlier,
    peerBlocked,
    pendingConnection,
    pendingRequestInvite,
    onAcceptRequest,
    onDeclineRequest,
    onBlockUser,
    onUnblockUser,
    onReportUser,
    onJoinMeeting,
    onRejectMeeting,
    onOpenTask,
    onTaskCreated,
    jumpToMessageId,
    onJumped,
    msgLoadStatus,
    onRetryLoad,
    people,
    presence,
    statusMessage,
    onPresenceChange,
    onStatusMessageChange,
    embedded,
    text,
    setText,
    slashHover,
    setSlashHover,
    peerReadAt,
    seenMeta,
    loadingEarlier,
    setLoadingEarlier,
    exhausted,
    setExhausted,
    atTop,
    setAtTop,
    tab,
    setTab,
    inSearch,
    setInSearch,
    inQuery,
    setInQuery,
    chatSearchOpen,
    setChatSearchOpen,
    chatGsQuery,
    setChatGsQuery,
    chatGsScope,
    setChatGsScope,
    chatSearchRef,
    matchIdx,
    setMatchIdx,
    note,
    setNote,
    gifOpen,
    setGifOpen,
    gifPickerRef,
    moreMenu,
    setMoreMenu,
    moreMenuPos,
    setMoreMenuPos,
    composerImportant,
    setComposerImportant,
    fmtOpen,
    setFmtOpen,
    actionsOpen,
    setActionsOpen,
    actionsRef,
    actionsBtnRef,
    actionsMenuRef,
    actionsPos,
    setActionsPos,
    openActions,
    moreMenuRef,
    moreBtnRef,
    moreMenuPortalRef,
    openMoreMenu,
    schedOpen,
    setSchedOpen,
    schedPickerRef,
    schedScopeRef,
    schedAt,
    setSchedAt,
    editingSched,
    setEditingSched,
    mq,
    setMq,
    mentionPopRef,
    mi,
    setMi,
    replyTo,
    setReplyTo,
    staged,
    setStaged,
    uploadPct,
    setUploadPct,
    dragOver,
    setDragOver,
    chatImgNav,
    setChatImgNav,
    openChatImgNav,
    infoOpen,
    setInfoOpen,
    infoMode,
    setInfoMode,
    infoRender,
    setInfoRender,
    infoMembers,
    setInfoMembers,
    infoFiles,
    setInfoFiles,
    editName,
    setEditName,
    editAbout,
    setEditAbout,
    editSelfName,
    setEditSelfName,
    editDesc,
    setEditDesc,
    convAvatarRef,
    convAvatarCropFile,
    setConvAvatarCropFile,
    infoLinks,
    setInfoLinks,
    aiSummary,
    setAiSummary,
    aiLoading,
    setAiLoading,
    aiErr,
    setAiErr,
    msgLimit,
    setMsgLimit,
    isMobile,
    setIsMobile,
    recording,
    setRecording,
    recordingTime,
    setRecordingTime,
    recordingPaused,
    setRecordingPaused,
    activeMsgId,
    setActiveMsgId,
    imgViewer,
    setImgViewer,
    mediaRecorderRef,
    audioChunksRef,
    recordingIntervalRef,
    recordingTimeRef,
    fileRef,
    listRef,
    scrollToBottom,
    composerRef,
    showJump,
    setShowJump,
    pinIdx,
    setPinIdx,
    editorRef,
    typingTimer,
    typingActiveRef,
    textRef,
    convId,
    convKind,
    reloadMembers,
    mgmtRole,
    mgmtRemove,
    mgmtLeave,
    stagedRef,
    draftConvRef,
    draftTextRef,
    wasNearBottomRef,
    lastMsgKeyRef,
    autoResize,
    scrollingRef,
    popoverOpenRef,
    scrollIdleRef,
    activateMsg,
    deactivateMsg,
    setPopoverOpen,
    matched,
    searchMatchIds,
    shown,
    clearStaged,
    newestAtTop,
  };
}
