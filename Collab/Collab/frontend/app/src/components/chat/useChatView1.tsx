// useChatView1.tsx — ChatView session hook segment 1.
// Mechanical extraction from ChatView.tsx (statements 124–188).
// Statements pulled forward so this hook is self-contained.

import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { messagePlain } from "../../lib/messageText";
import { isBlankRich, CHAT_WINDOW_CHUNK, CHAT_PAGE_SIZE, PERSON_CARD_DELAY, personPresenceLabel, buildRenderItems } from "./helpers";
import { Rect } from "./EmojiPicker";
import { INLINE_MAX, HARD_MAX } from "../../lib/fileLimits";
import { isE2EEEnabled } from "../../lib/e2ee/manager";

export type ChatViewSession1 = {
  autoResize: any; convId: any; conversation: any; editorRef: any;
  embedded: any; endedMeetingIds: any; exhausted: any; freqRank: any;
  grouping: any; inQuery: any; inSearch: any; jumpToMessageId: any;
  listRef: any; loadingEarlier: any; matchIdx: any; matched: any;
  meId: any; messages: any; mq: any; newestAtTop: any; onCallUser: any;
  onJumped: any; onLoadEarlier: any; onSelectPerson: any; onSendFile: any;
  onTyping: any; pendingConnection: any; people: any; pinIdx: any;
  presence: any; replyTo: any; searchMatchIds: any; sendTyping: any;
  setDragOver: any; setExhausted: any; setLoadingEarlier: any; setMatchIdx: any;
  setMi: any; setMq: any; setMsgLimit: any; setNote: any;
  setPinIdx: any; setReplyTo: any; setStaged: any; setText: any;
  setUploadPct: any; showLastSeen: any; shown: any; staged: any;
  text: any; typingActiveRef: any; typingTimer: any; unreadCount: any;
};

export function useChatView1(ctx: ChatViewSession1) {

  const {
    autoResize, convId, conversation, editorRef,
    embedded, endedMeetingIds, exhausted, freqRank,
    grouping, inQuery, inSearch, jumpToMessageId,
    listRef, loadingEarlier, matchIdx, matched,
    meId, messages, mq, newestAtTop, onCallUser,
    onJumped, onLoadEarlier, onSelectPerson, onSendFile,
    onTyping, pendingConnection, people, pinIdx,
    presence, replyTo, searchMatchIds, sendTyping,
    setDragOver, setExhausted, setLoadingEarlier, setMatchIdx,
    setMi, setMq, setMsgLimit, setNote,
    setPinIdx, setReplyTo, setStaged, setText,
    setUploadPct, showLastSeen, shown, staged,
    text, typingActiveRef, typingTimer, unreadCount
  } = ctx;

  // ---- ChatView.tsx statements ----
  const handleLoadEarlier = useCallback(async () => {
    // ORD-05 (newest-at-top): older rows append BELOW the viewport, so the
    // pre-load scrollTop is exactly right — but the commit can still nudge the
    // position (the Load-earlier button re-rendering/unmounting is often the
    // browser's scroll-anchor NODE, and native anchoring re-applies its
    // correction after every write). Suspend overflow-anchor for the restore
    // window, hold the position across the commit frames, then hand anchoring
    // back (still wanted for live inserts at the top, see ORD-03).
    const holdTopModeScroll = (prevTop: number) => {
      const el0 = listRef.current;
      if (el0) el0.style.overflowAnchor = "none";
      const hold = () => {
        const el2 = listRef.current;
        if (el2) el2.scrollTop = prevTop;
      };
      requestAnimationFrame(() => {
        hold();
        requestAnimationFrame(hold);
      });
      setTimeout(() => {
        hold();
        const el2 = listRef.current;
        if (el2) el2.style.overflowAnchor = "";
      }, 250);
    };
    if (matched.length > shown.length) {
      const elW = listRef.current;
      const prevTopW = elW ? elW.scrollTop : 0;
      setMsgLimit((n: number) => n + CHAT_WINDOW_CHUNK);
      if (newestAtTop) holdTopModeScroll(prevTopW);
      return;
    }
    if (!onLoadEarlier || loadingEarlier || exhausted) return;
    const el = listRef.current;
    const prevH = el ? el.scrollHeight : 0;
    const prevTop = el ? el.scrollTop : 0;
    setLoadingEarlier(true);
    try {
      const added = await onLoadEarlier(convId);
      if (!added) {
        setExhausted(true);
        return;
      }
      setMsgLimit((n: number) => n + added);
      // A SHORT page means we just read the last one — mark exhausted now rather
      // than waiting for a further click to come back empty. Without this the
      // button lingered after the final page and only disappeared once the user
      // pressed it again and got nothing.
      if (added < CHAT_PAGE_SIZE) setExhausted(true);
      // Bottom mode: the older page renders ABOVE the viewport, so hold the
      // reader's place by the height delta. Under newest-at-top (ORD-05) older
      // messages append BELOW the viewport — nothing above changed, so the
      // pre-fetch scrollTop is EXACTLY right; restore it verbatim (the button
      // that just unmounted can be the browser's scroll-anchor node, and its
      // removal otherwise nudges the view by the button's height).
      if (newestAtTop) {
        holdTopModeScroll(prevTop);
      } else {
        requestAnimationFrame(() => {
          const el2 = listRef.current;
          if (el2) el2.scrollTop = prevTop + (el2.scrollHeight - prevH);
        });
      }
    } finally {
      setLoadingEarlier(false);
    }
  }, [
    matched.length,
    shown.length,
    onLoadEarlier,
    loadingEarlier,
    exhausted,
    convId,
    newestAtTop,
  ]);
  const jumpToMessage = useCallback((id: string) => {
    const el = document.getElementById("msg-" + id);
    if (!el) return;
    // INSTANT jump (not smooth): a smooth scroll animates through the whole list,
    // and messages lazily render / decrypt as they pass the viewport, so the
    // screen visibly flickers "all the way there". Landing directly on the target
    // (block:center) then flashing it is both flicker-free and faster.
    el.scrollIntoView({ behavior: "auto", block: "center" });
    el.classList.add("msg-flash");
    setTimeout(() => el.classList.remove("msg-flash"), 1400);
  }, []);
  useEffect(() => {
    setMatchIdx(Math.max(0, searchMatchIds.length - 1));
  }, [searchMatchIds.length, inQuery]);
  const goPrevMatch = useCallback(() => setMatchIdx((i) => Math.max(0, i - 1)), []);
  const goNextMatch = useCallback(
    () => setMatchIdx((i) => Math.min(searchMatchIds.length - 1, i + 1)),
    [searchMatchIds.length],
  );
  const searchJumpRef = useRef(0);
  useEffect(() => {
    searchJumpRef.current = 0;
  }, [matchIdx, inQuery]);
  useEffect(() => {
    if (!inSearch || !searchMatchIds.length) return;
    const id = searchMatchIds[matchIdx];
    if (!id) return;
    if (shown.some((m: any) => m && m.id === id)) {
      const t = setTimeout(() => jumpToMessage(id), 60);
      return () => clearTimeout(t);
    }
    if (searchJumpRef.current < 15 && !exhausted && !loadingEarlier) {
      searchJumpRef.current += 1;
      handleLoadEarlier();
    }
  }, [
    inSearch,
    searchMatchIds,
    matchIdx,
    shown,
    exhausted,
    loadingEarlier,
    handleLoadEarlier,
    jumpToMessage,
  ]);
  const jumpAttemptsRef = useRef(0);
  useEffect(() => {
    jumpAttemptsRef.current = 0;
  }, [jumpToMessageId, convId]);
  useEffect(() => {
    if (!jumpToMessageId) return;
    const inWindow = shown.some((m: any) => m && m.id === jumpToMessageId);
    if (inWindow) {
      const t = setTimeout(() => {
        jumpToMessage(jumpToMessageId);
        if (onJumped) onJumped();
      }, 80);
      return () => clearTimeout(t);
    }
    // Target not visible yet — load older history (bounded) until it appears or
    // history is exhausted, then give up gracefully (the conversation is open).
    if (jumpAttemptsRef.current < 15 && !exhausted && !loadingEarlier) {
      jumpAttemptsRef.current += 1;
      handleLoadEarlier();
    } else if (exhausted || jumpAttemptsRef.current >= 15) {
      if (onJumped) onJumped();
    }
  }, [
    jumpToMessageId,
    shown,
    exhausted,
    loadingEarlier,
    handleLoadEarlier,
    jumpToMessage,
    onJumped,
    convId,
  ]);
  const pinnedMsgs = useMemo(
    () => (messages || []).filter((m: any) => m && m.pinned && !m.deleted),
    [messages],
  );
  const curPin = pinnedMsgs.length
    ? pinnedMsgs[Math.min(pinIdx, pinnedMsgs.length - 1)]
    : null;
  useEffect(() => {
    if (pinIdx >= pinnedMsgs.length) setPinIdx(0);
  }, [pinnedMsgs.length, pinIdx]);
  useEffect(() => {
    setPinIdx(0);
  }, [convId]);
  const cyclePin = useCallback(() => {
    if (!pinnedMsgs.length) return;
    const next = (pinIdx + 1) % pinnedMsgs.length;
    setPinIdx(next);
    const target = pinnedMsgs[next];
    if (target) jumpToMessage(target.id);
  }, [pinnedMsgs, pinIdx]);
  const albumOf = useMemo(() => {
    const map: Record<string, { lead: boolean; run: any[]; leadId: string }> =
      {};
    for (const it of buildRenderItems(shown, grouping)) {
      if (it.kind === "album")
        it.run.forEach((mm: any, idx: number) => {
          map[mm.id] = { lead: idx === 0, run: it.run, leadId: it.run[0].id };
        });
    }
    return map;
  }, [shown, grouping]);
  const byId = useMemo<Record<string, any>>(() => {
    const out: Record<string, any> = {};
    for (const mm of messages || []) out[mm.id] = mm;
    return out;
  }, [messages]);
  const [bannerTick, setBannerTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setBannerTick((x) => x + 1), 30000);
    return () => clearInterval(t);
  }, []);
  const bannerInvite = useMemo<{ id: string | null; ended: boolean; suppressed: Set<string> }>(() => {
    const list = messages || [];
    const now = Date.now();
    // Walk from the newest message and pin the latest STILL-ACTIVE invite as the
    // header banner, SKIPPING any that have ended. A meeting is "ended" by ANY of:
    // the live meetings list (host "End for everyone", catches an EARLY end the
    // invite's stale snapshot can't), the invite's own snapshot status, its
    // scheduled window having passed, or a meeting-specific "ended/cancelled"
    // trace posted after it. (The trace must say "meeting" — a plain "📞 Call
    // ended" trace, same type "call", must not hide a live invite.)
    //
    // `suppressed` = the invite MESSAGES that must NOT render inline in the
    // stream: the single active invite (shown once, as the header) PLUS every
    // ended invite (Issue 1 — a finished meeting's card must disappear entirely,
    // represented only by its "Meeting ended" call-log trace, never a lingering
    // inline card). So re-scheduling always yields a fresh header and never an
    // invite buried in the timeline. Older STILL-active invites (a genuinely
    // separate upcoming meeting) are left inline as normal cards.
    const suppressed = new Set<string>();
    let bannerId: string | null = null;
    for (let i = list.length - 1; i >= 0; i--) {
      const mm: any = list[i];
      if (!(mm && mm.type === "meeting_invite" && mm.meeting)) continue;
      const mtg = mm.meeting;
      const mtgId = mtg.meetingId;
      const endedByStatus = !!(
        mtgId &&
        endedMeetingIds &&
        typeof endedMeetingIds.has === "function" &&
        endedMeetingIds.has(mtgId)
      );
      const snapshotEnded = mtg.status === "cancelled" || mtg.status === "ended";
      const startMs = mtg.startsAt ? Date.parse(mtg.startsAt) : NaN;
      const endMs = Number.isFinite(startMs)
        ? startMs + (Number(mtg.durationMin) || 30) * 60 * 1000
        : NaN;
      const expired = Number.isFinite(endMs) && now > endMs;
      const endedByTrace = list
        .slice(i + 1)
        .some(
          (t: any) =>
            t &&
            (t.type === "call" || t.type === "meeting_attendance") &&
            /meeting/i.test(String(t.text || "")) &&
            /ended|cancell?ed/i.test(String(t.text || "")),
        );
      if (endedByStatus || snapshotEnded || expired || endedByTrace) {
        if (mm.id) suppressed.add(mm.id); // ended → never inline
        continue;
      }
      if (bannerId === null) {
        bannerId = (mm && mm.id) || null; // latest active → header banner
        if (mm.id) suppressed.add(mm.id); // …and hidden inline (shown once)
      }
    }
    return { id: bannerId, ended: false, suppressed };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, endedMeetingIds, bannerTick]);
  const lastAckId = useMemo(() => {
    for (let i = shown.length - 1; i >= 0; i--) {
      const mm: any = shown[i];
      if (!mm || !mm.me || mm.deleted) continue;
      if (
        mm._status === "sending" ||
        mm._status === "sent" ||
        mm._status === "uploading" ||
        mm._status === "failed"
      )
        continue;
      if (albumOf[mm.id]) continue;
      if (bannerInvite.suppressed.has(mm.id)) continue;
      return mm.id;
    }
    return null;
  }, [shown, albumOf, bannerInvite]);
  const [tempNoticeClosed, setTempNoticeClosed] = useState<Record<string, 1>>(
    {},
  );
  const tempNoticeDismissed = !!(
    conversation &&
    conversation.temporary &&
    (tempNoticeClosed[conversation.id] ||
      (() => {
        try {
          return (
            localStorage.getItem("clb_tempnote_x_" + conversation.id) === "1"
          );
        } catch (_) {
          return false;
        }
      })())
  );
  const isGroupish =
    conversation?.kind === "group" || conversation?.kind === "channel";
  const myIdSet = useMemo(
    () =>
      new Set(
        [
          meId,
          conversation && conversation.meId,
          conversation && conversation.myId,
        ].filter(Boolean) as string[],
      ),
    [meId, conversation],
  );
  const peopleById = useMemo(() => {
    const map: Record<string, any> = {};
    (people || []).forEach((u: any) => {
      if (u && u.id) map[u.id] = u;
    });
    return map;
  }, [people]);
  // Full profile modal (click an author's avatar in a group / channel).
  const [profileModal, setProfileModal] = useState<any>(null);
  const [personCard, setPersonCard] = useState<{ info: any; rect: Rect } | null>(
    null,
  );
  const pcShowTimer = useRef<any>(null);
  const pcHideTimer = useRef<any>(null);
  const clearPcShow = () => {
    if (pcShowTimer.current) clearTimeout(pcShowTimer.current);
    pcShowTimer.current = null;
  };
  const clearPcHide = () => {
    if (pcHideTimer.current) clearTimeout(pcHideTimer.current);
    pcHideTimer.current = null;
  };
  const closePersonCard = useCallback(() => {
    clearPcShow();
    clearPcHide();
    setPersonCard(null);
  }, []);
  useEffect(() => () => { clearPcShow(); clearPcHide(); }, []);
  useEffect(() => { closePersonCard(); }, [conversation && conversation.id, closePersonCard]);
  useEffect(() => {
    if (!personCard) return;
    const onScroll = () => closePersonCard();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Consume the Escape so it dismisses ONLY the card — without this the same
        // keypress also fell through to the app's global Escape (navigate Back),
        // yanking the user out of the conversation they were reading.
        e.stopPropagation();
        e.preventDefault();
        closePersonCard();
      }
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (!t || !t.closest || !t.closest(".person-card")) closePersonCard();
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDown, true);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDown, true);
    };
  }, [personCard, closePersonCard]);
  const handleAvatarEnter = useCallback((info: any, el: HTMLElement) => {
    clearPcHide();
    clearPcShow();
    // Store the raw identity (id + name/avatar). It's enriched with email /
    // presence / last-seen at RENDER time (enrichPersonCard) rather than here, so
    // this handler stays stable (deps []) and the card always reflects the latest
    // directory + DM presence without re-rendering every memoized message row.
    // Measure the rect at FIRE time (not enter time) from the live element, and
    // skip entirely if the element left the DOM during the delay — this prevents
    // an orphan card popping up detached at a stale position when the row scrolls
    // or unmounts within the 600ms window (no mouseleave fires in those cases).
    pcShowTimer.current = setTimeout(() => {
      if (!el || !el.isConnected) return;
      setPersonCard({ info, rect: el.getBoundingClientRect() });
    }, PERSON_CARD_DELAY);
  }, []);
  const handleAvatarLeave = useCallback(() => {
    // Cancel a pending open, and give a short grace so the pointer can travel
    // from the avatar onto the card without it closing.
    clearPcShow();
    clearPcHide();
    pcHideTimer.current = setTimeout(() => setPersonCard(null), 220);
  }, []);
  const handleCardEnter = useCallback(() => { clearPcHide(); }, []);
  const handleCardLeave = useCallback(() => {
    clearPcHide();
    pcHideTimer.current = setTimeout(() => setPersonCard(null), 160);
  }, []);
  // Open a direct chat with the person (hover-card "Chat" action, profile modal "Chat").
  const openDirectChat = useCallback(
    (info: any) => {
      clearPcShow();
      clearPcHide();
      setPersonCard(null);
      setProfileModal(null);
      // Never DM yourself (defence-in-depth against a mis-flagged self message).
      if (onSelectPerson && info && info.id && !myIdSet.has(info.id))
        onSelectPerson(info.id);
    },
    [onSelectPerson, myIdSet],
  );
  // Clicking an author's avatar: in a group / channel open the full profile modal;
  // elsewhere keep the original behaviour (open the DM).
  const handleAvatarClick = useCallback(
    (info: any) => {
      if (isGroupish && info && info.id && !myIdSet.has(info.id)) {
        clearPcShow();
        clearPcHide();
        setPersonCard(null);
        setProfileModal(info);
        return;
      }
      openDirectChat(info);
    },
    [isGroupish, openDirectChat, myIdSet],
  );
  const handleCardCall = useCallback(
    (person: any, video: boolean) => {
      clearPcShow();
      clearPcHide();
      setPersonCard(null);
      if (onCallUser && person && person.id && !myIdSet.has(person.id))
        onCallUser(person, video);
    },
    [onCallUser, myIdSet],
  );
  const dmPeerInfo = (() => {
    if (embedded || !conversation || conversation.kind !== "dm") return null;
    const pid = ((conversation.members || []) as string[]).find(
      (x) => x && !myIdSet.has(x),
    );
    if (!pid) return null;
    const a = conversation.avatar || {};
    return {
      id: pid,
      name: conversation.name,
      initials: a.initials,
      color: a.color,
      avatarUrl: a.avatarUrl,
    };
  })();
  const lastSeenLabel = (iso: string) => {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "Offline";
    const now = new Date();
    const time = d.toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });
    const yest = new Date(now);
    yest.setDate(now.getDate() - 1);
    if (d.toDateString() === now.toDateString())
      return "last seen today at " + time;
    if (d.toDateString() === yest.toDateString())
      return "last seen yesterday at " + time;
    return (
      "last seen " +
      d.toLocaleDateString([], { month: "short", day: "numeric" }) +
      " at " +
      time
    );
  };
  const personStatusText = (presence: any, lastSeen: any) => {
    const p = String(presence || "").toLowerCase();
    const known = p && p !== "off" && p !== "offline";
    if (known) return personPresenceLabel(presence);
    if (lastSeen && showLastSeen) return lastSeenLabel(lastSeen);
    return p ? "Offline" : "";
  };
  const enrichPersonCard = (info: any) => {
    const dir = (info && info.id && peopleById[info.id]) || {};
    let presence = dir.presence != null ? dir.presence : info.presence;
    let lastSeen = dir.lastSeen != null ? dir.lastSeen : info.lastSeen;
    if (
      conversation &&
      conversation?.kind === "dm" &&
      info &&
      info.id &&
      (conversation.members || []).includes(info.id)
    ) {
      if (conversation.presence != null) presence = conversation.presence;
      if (conversation.lastSeen != null) lastSeen = conversation.lastSeen;
    }
    return {
      id: info.id,
      name: info.name || dir.name || "",
      initials: info.initials || dir.initials,
      color: info.color || dir.color,
      avatarUrl: info.avatarUrl || dir.avatarUrl,
      email: dir.email || info.email,
      phone: dir.phone || info.phone,
      memberRole: info.memberRole || dir.memberRole,
      presence,
      // The status / "last seen" line is shown ONLY in groups and channels, and
      // ONLY when the viewer's Last-seen setting is on. In a DM it's hidden (the
      // header already carries the peer's status), and it's hidden entirely when
      // Last-seen is off — so it never leaks a last-seen the viewer opted out of.
      statusText:
        isGroupish && showLastSeen
          ? personStatusText(presence, lastSeen)
          : "",
    };
  };
  const sub =
    conversation?.kind === "self"
      ? "Message yourself — only you can see this"
      : isGroupish
        ? (conversation?.memberCount || 0) + " members"
        : conversation?.presence === "on"
          ? "Available"
          : conversation?.presence === "busy"
            ? "Busy"
            : conversation?.presence === "dnd"
              ? "Do not disturb"
              : conversation?.presence === "brb"
                ? "Be right back"
                : conversation?.presence === "away"
                  ? "Away"
                  : showLastSeen && conversation?.lastSeen
                    ? lastSeenLabel(conversation.lastSeen)
                    : "Offline";
  const unreadSepIdLive = (() => {
    if (!unreadCount || unreadCount <= 0 || !messages || !messages.length)
      return null;
    const otherMsgs = messages.filter((m: any) => !m.me);
    if (otherMsgs.length <= unreadCount) return null;
    const sepMsg = otherMsgs[otherMsgs.length - unreadCount];
    return sepMsg?.id || null;
  })();
  // ORD-08: the divider must be STABLE while the user reads. Computed live it
  // vanished one render after open — opening marks the thread read, unreadCount
  // drops to 0, and the "New messages" line the reader was using as their
  // landmark disappeared under them. Latch the first non-null boundary per
  // conversation; a conversation switch re-derives it.
  const unreadSepLatchRef = useRef<{ conv: any; id: string | null }>({ conv: undefined, id: null });
  if (unreadSepLatchRef.current.conv !== convId)
    unreadSepLatchRef.current = { conv: convId, id: unreadSepIdLive };
  else if (!unreadSepLatchRef.current.id && unreadSepIdLive)
    unreadSepLatchRef.current.id = unreadSepIdLive;
  const unreadSepId = unreadSepLatchRef.current.id;
  const flash = (msg: string) => {
    setNote(msg);
    setTimeout(() => setNote(""), 2600);
  };
  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value;
    setText(v);
    autoResize();
    const mm = /(?:^|\s)@(\w*)$/.exec(v);
    if (mm) {
      setMq(mm[1]);
      setMi(0);
    } else {
      setMq(null);
    }
    if (onTyping && sendTyping !== false) {
      // START only on the idle→typing transition; the 1400ms idle timer emits STOP.
      if (!typingActiveRef.current) {
        typingActiveRef.current = true;
        onTyping(true);
      }
      clearTimeout(typingTimer.current);
      typingTimer.current = setTimeout(() => {
        typingActiveRef.current = false;
        onTyping(false);
      }, 1400);
    }
  };
  const onEditorChange = useCallback(
    (v: string) => {
      // Normalize a blank doc to "" so a select-all+delete (which can leave a
      // residual empty paragraph / <br>, making the box render 2-3 lines tall)
      // triggers the same clean reset the composer does after Send — the value
      // sync then collapses the editor back to a single empty line.
      setText(isBlankRich(v) ? "" : v);
      if (onTyping && sendTyping !== false) {
        if (!typingActiveRef.current) {
          typingActiveRef.current = true;
          onTyping(true);
        }
        clearTimeout(typingTimer.current);
        typingTimer.current = setTimeout(() => {
          typingActiveRef.current = false;
          onTyping(false);
        }, 1400);
      }
    },
    [onTyping, sendTyping],
  );
  const mentionPeople = (() => {
    const seen = new Map();
    // Authoritative member-id set built from BOTH shapes the payload can carry
    // (ids in `members`, and objects in `memberDetails`), so a conversation that
    // populates only one of them is still filtered correctly.
    const memberIds = new Set<string>([
      ...((conversation && conversation.members) || []),
      ...(((conversation && conversation.memberDetails) || [])
        .map((m: any) => m && m.id)
        .filter(Boolean)),
    ]);
    // Never offer YOURSELF, under any id shape. A DM's members = [me, peer], so a
    // simple `id !== meId` string check let self leak whenever meId and the id in
    // the conversation payload differed by format — the reported bug where a DM
    // with one person offered the CURRENT user in the "@" picker. Compare against
    // every id we know for "me".
    const myIds = new Set<string>(
      [meId, conversation && conversation.meId, conversation && conversation.myId]
        .filter(Boolean) as string[],
    );
    const isSelf = (id: string) => !id || myIds.has(id);
    // When we know the membership, a candidate MUST be a member. Only when we
    // know nothing (both shapes empty) do we fall back to people who have
    // actually spoken in the thread — never the global directory.
    const knowMembers = memberIds.size > 0;
    const isMember = (id: string) => !knowMembers || memberIds.has(id);
    // Message senders: were seeded with only a `!m.me` check — no membership or
    // self guard — so a stale/foreign sender (or self, when m.me was wrong) could
    // appear. Gate them the same as everyone else.
    (messages || []).forEach((m: any) => {
      const sid = m && m.sender && m.sender.id;
      if (sid && !isSelf(sid) && isMember(sid)) seen.set(sid, m.sender);
    });
    ((conversation && conversation.memberDetails) || []).forEach((m: any) => {
      if (m && m.id && !isSelf(m.id)) seen.set(m.id, m);
    });
    // Directory users are candidates ONLY when they belong to THIS conversation.
    // The old guard read "memberIds.size === 0 || memberIds.has(u.id)", so an
    // unpopulated members list silently meant NO filter — and the entire
    // workspace directory became mentionable, ranked by interaction frequency.
    (people || []).forEach((u: any) => {
      if (u && u.id && !isSelf(u.id) && !seen.has(u.id) && memberIds.has(u.id))
        seen.set(u.id, u);
    });
    return [...seen.values()].sort((a: any, b: any) => {
      const sa = (freqRank && freqRank[a.id]) || 0;
      const sb = (freqRank && freqRank[b.id]) || 0;
      if (sb !== sa) return sb - sa;
      return String(a.name || "").localeCompare(String(b.name || ""));
    });
  })();
  const mentionMatches =
    mq === null
      ? []
      : mentionPeople
        .filter((p: any) =>
          (p.name || "").toLowerCase().includes((mq || "").toLowerCase()),
        )
        .slice(0, 6);
  const insertMention = (p: any) => {
    const first = ((p.name || "").split(" ")[0] || p.name || "user").replace(
      /\W/g,
      "",
    );
    setText((t) => t.replace(/(^|\s)@(\w*)$/, "$1@" + first + " "));
    setMq(null);
  };
  const convIsE2EE =
    isE2EEEnabled() &&
    (conversation?.kind === "dm" ||
      conversation?.kind === "self" ||
      conversation?.kind === "group" ||
      conversation?.kind === "channel");
  const sendFileDirect = (fl: File) => {
    if (!fl) return;
    if (fl.size > HARD_MAX) {
      flash('"' + (fl.name || "File") + '" exceeds the 2 GB maximum.');
      return;
    }
    // Over the inline cap → upload + send as a Collab link (non-E2EE only).
    const asLink = fl.size > INLINE_MAX && !convIsE2EE;
    onSendFile &&
      onSendFile(fl, replyTo ? replyTo.id : null, undefined, undefined, asLink);
  };
  const stageFiles = (files: File[] | FileList | null) => {
    // Teams-model pending request: text only until accepted. This is the single
    // funnel for attach / paste / drop / add-more, so one guard disables them all.
    if (pendingConnection) {
      flash("You can only send text until this request is accepted.");
      return;
    }
    const arr = files ? Array.from(files) : [];
    if (!arr.length) return;
    const next: {
      id: string;
      file: File;
      url: string;
      isImage: boolean;
      asLink?: boolean;
    }[] = [];
    arr.forEach((f, i) => {
      if (f.size > HARD_MAX) {
        flash('"' + (f.name || "File") + '" exceeds the 2 GB maximum.');
        return;
      }
      // Over the inline cap → rides as a Collab link (non-E2EE only; an encrypted
      // chat's bytes are ciphertext, so it's delivered as a large attachment).
      const asLink = f.size > INLINE_MAX && !convIsE2EE;
      let file = f;
      if (!f.name || f.name === "image.png" || /^blob$/i.test(f.name)) {
        const ext = (f.type && f.type.split("/")[1]) || "png";
        const stamp = new Date()
          .toISOString()
          .replace(/[:.]/g, "-")
          .slice(0, 19);
        try {
          file = new File(
            [f],
            `Screenshot ${stamp}${arr.length > 1 ? "-" + (i + 1) : ""}.${ext}`,
            { type: f.type },
          );
        } catch (_) {
          /* some browsers disallow File ctor on a File — fall back */
        }
      }
      const isImage = (file.type || "").startsWith("image/");
      next.push({
        id: `${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`,
        file,
        url: isImage ? URL.createObjectURL(file) : "",
        isImage,
        asLink,
      });
    });
    if (next.length) {
      setStaged((prev) => [...prev, ...next]);
      // Land the caret in the message composer so a caption can be typed right away.
      // Without this, focus stayed on the attach/Add control, so pressing Enter
      // re-opened the file picker instead of the composer receiving the keystroke.
      requestAnimationFrame(() => {
        try {
          editorRef.current?.focus();
        } catch (_) { }
      });
    }
  };
  const removeStaged = (id: string) => {
    setStaged((prev) => {
      const hit = prev.find((s) => s.id === id);
      if (hit && hit.url) URL.revokeObjectURL(hit.url);
      return prev.filter((s) => s.id !== id);
    });
  };
  const commitStaged = () => {
    if (!staged.length) return;
    const caption = text.trim();
    const parent = replyTo ? replyTo.id : null;
    const batch = staged;
    setText("");
    setReplyTo(null);
    // Clear the composer preview chips IMMEDIATELY. The message now lives in the thread
    // as an optimistic bubble that shows the upload + its OWN progress bar, so keeping
    // the chips here too showed the loading UI in BOTH places (#3). `uploadPct` is still
    // tracked (drives the desktop taskbar progress) but is no longer rendered as chips.
    setStaged([]);
    if (onTyping) {
      clearTimeout(typingTimer.current);
      typingActiveRef.current = false;
      onTyping(false);
    }
    // 2+ attachments → a WhatsApp/Teams grid album; the caption belongs to the
    // album (carried on the lead's file.caption), not to the first image as text.
    const isAlbum = batch.length >= 2;
    batch.forEach((s, i) => {
      setUploadPct((p) => ({ ...p, [s.id]: 0 }));
      Promise.resolve(
        onSendFile &&
        onSendFile(
          s.file,
          parent,
          i === 0 ? caption : "",
          (pct: number) => setUploadPct((p) => ({ ...p, [s.id]: pct })),
          s.asLink,
          undefined,
          isAlbum,
        ),
      ).finally(() => {
        if (s.url) URL.revokeObjectURL(s.url);
        setUploadPct((p) => {
          const n = { ...p };
          delete n[s.id];
          return n;
        });
      });
    });
  };
  const onFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length) stageFiles(e.target.files);
    e.target.value = "";
  };
  const onDropFile = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length)
      stageFiles(e.dataTransfer.files);
  };
  const slashPlain = messagePlain(text || "").trim();
  const slashTyping = /^\/(\w*)$/.exec(slashPlain);

  return {
    handleLoadEarlier,
    jumpToMessage,
    goPrevMatch,
    goNextMatch,
    searchJumpRef,
    jumpAttemptsRef,
    pinnedMsgs,
    curPin,
    cyclePin,
    albumOf,
    byId,
    bannerTick,
    setBannerTick,
    bannerInvite,
    lastAckId,
    tempNoticeClosed,
    setTempNoticeClosed,
    tempNoticeDismissed,
    isGroupish,
    myIdSet,
    peopleById,
    personCard,
    setPersonCard,
    pcShowTimer,
    pcHideTimer,
    clearPcShow,
    clearPcHide,
    closePersonCard,
    handleAvatarEnter,
    handleAvatarLeave,
    handleCardEnter,
    handleCardLeave,
    handleAvatarClick,
    openDirectChat,
    profileModal,
    setProfileModal,
    handleCardCall,
    dmPeerInfo,
    lastSeenLabel,
    personStatusText,
    enrichPersonCard,
    sub,
    unreadSepId,
    flash,
    handleChange,
    onEditorChange,
    mentionPeople,
    mentionMatches,
    insertMention,
    convIsE2EE,
    sendFileDirect,
    stageFiles,
    removeStaged,
    commitStaged,
    onFileInput,
    onDropFile,
    slashPlain,
    slashTyping,
  };
}
