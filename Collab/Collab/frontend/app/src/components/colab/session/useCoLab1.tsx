// CoLab session hook — segment 1 (Boot).
// Mechanical extraction from CoLabV1.tsx (statements 210–253),
// plus statements pulled forward so this hook is self-contained.

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { runTopEsc } from "../../../lib/escStack";
import { api } from "../../../lib/api";
import config from "../../../lib/config";
import { initE2EE, decryptMessageList, isE2EEEnabled, setOnHistoryRestored, rearmRecovery, ensurePasswordBackup, E2EE_PENDING_TEXT, needsPasswordRestore, restoreWithPassword } from "../../../lib/e2ee/manager";
import { isDesktopApp } from "../../../lib/platform";
import { loadToken, saveToken, clearToken, saveRefreshToken } from "../../../lib/tokenStore";
import { HIDDEN_MODULES } from "../../../lib/hiddenModules";
import { htmlPreview } from "../helpers";

export type CoLabSession1 = {
  authed: any; tokenRef: any; offlineDemo: any; showToast: any;
  doLogout: any; setMessagesByConv: any; activeIdRef: any; activeId: any;
  commsConvIdRef: any; commsConvId: any; commsOpenRef: any; commsOpen: any;
  modalRef: any; modal: any; setModal: any; goBackRef: any;
  setConversations: any; meRef: any; setConvLoaded: any; setMeetings: any;
  socketRef: any; modeRef: any; mobilePaneRef: any; settingsRef: any;
  setMsgLoadStatus: any; setUsers: any; refetchTasksRef: any; refetchRemindersRef: any;
  refetchFilesRef: any; lastRealtimeAtRef: any; setCalls: any; setTasks: any;
  setTaskCount: any; setTaskCursor: any; setTaskHasMore: any; taskProjectFilterRef: any;
  setTaskProjects: any; setTaskViews: any; taskCursor: any; setTaskLoadingMore: any;
  setReminders: any; setReminderCount: any; setReminderCounts: any; setReminderCursor: any;
  setReminderHasMore: any; setFolders: any; reminderCursor: any; setReminderLoadingMore: any;
  setInvites: any; setMe: any; setOfflineDemo: any; setMode: any;
  setAuthed: any; setAuthResolving: any; setE2eeRestoreOpen: any; setE2eeRestorePw: any;
  setE2eeRestoreErr: any; setLoginError: any; e2eeRestorePw: any; setE2eeRestoreBusy: any;
  setLoginBusy: any; setLimitPrompt: any; limitPrompt: any; setOnboardingOpen: any;
  setDrafts: any; conversationsRef: any; loadMessagesRef: any; messagesByConvRef: any;
  mode: any; frequentUsers: any; changeSetting: any; conversations: any;
};

export function useCoLab1(ctx: CoLabSession1) {

  const {
  authed, tokenRef, offlineDemo, showToast,
  doLogout, setMessagesByConv, activeIdRef, activeId,
  commsConvIdRef, commsConvId, commsOpenRef, commsOpen,
  modalRef, modal, setModal, goBackRef,
  setConversations, meRef, setConvLoaded, setMeetings,
  socketRef, modeRef, mobilePaneRef, settingsRef,
  setMsgLoadStatus, setUsers, refetchTasksRef, refetchRemindersRef,
  refetchFilesRef, lastRealtimeAtRef, setCalls, setTasks,
  setTaskCount, setTaskCursor, setTaskHasMore, taskProjectFilterRef,
  setTaskProjects, setTaskViews, taskCursor, setTaskLoadingMore,
  setReminders, setReminderCount, setReminderCounts, setReminderCursor,
  setReminderHasMore, setFolders, reminderCursor, setReminderLoadingMore,
  setInvites, setMe, setOfflineDemo, setMode,
  setAuthed, setAuthResolving, setE2eeRestoreOpen, setE2eeRestorePw,
  setE2eeRestoreErr, setLoginError, e2eeRestorePw, setE2eeRestoreBusy,
  setLoginBusy, setLimitPrompt, limitPrompt, setOnboardingOpen,
  setDrafts, conversationsRef, loadMessagesRef, messagesByConvRef,
  mode, frequentUsers, changeSetting, conversations
  } = ctx;

  // ---- CoLabV1.tsx statements 210–253 (and pulled) ----
  useEffect(() => {
    if (!authed || !tokenRef.current || offlineDemo) return;
    const ACT_KEY = "colab:last_activity";
    let idleMs = 0;
    let poll: any = null;
    let cancelled = false;
    const now = () => Date.now();
    const readShared = () => {
      let v = 0;
      try {
        v = Number(localStorage.getItem(ACT_KEY) || 0) || 0;
      } catch (_) {}
      return v;
    };
    const writeShared = (t: number) => {
      try {
        localStorage.setItem(ACT_KEY, String(t));
      } catch (_) {}
    };
    // Throttle localStorage writes to at most once every 5s (activity events fire
    // hundreds of times a minute; we only need coarse recency).
    let lastWrite = 0;
    const bump = () => {
      const t = now();
      if (t - lastWrite > 5000) {
        lastWrite = t;
        writeShared(t);
      }
    };
    const ACT_EVENTS = [
      "mousemove",
      "mousedown",
      "keydown",
      "touchstart",
      "scroll",
      "wheel",
    ];
    const onVisible = () => {
      // Returning to a tab is itself activity; also re-check immediately so a tab
      // that was hidden past the threshold logs out on focus rather than lingering.
      if (document.visibilityState === "visible") {
        bump();
        check();
      }
    };
    const check = () => {
      if (cancelled || !tokenRef.current || idleMs <= 0) return;
      const last = Math.max(readShared(), lastWrite);
      if (last > 0 && now() - last >= idleMs) {
        showToast("Signed out after inactivity, per your organization's policy.");
        doLogout();
      }
    };
    // Fetch the tenant idle policy, then arm. If there's no org or no timeout,
    // this effect is inert (no listeners, no interval).
    api
      .orgCurrent(tokenRef.current)
      .then((ctx: any) => {
        if (cancelled) return;
        const mins = ctx && ctx.idleTimeoutMin != null ? Number(ctx.idleTimeoutMin) : 0;
        if (!mins || mins <= 0) return;
        idleMs = mins * 60000;
        // Seed activity now so a fresh login isn't instantly considered idle.
        writeShared(now());
        lastWrite = now();
        ACT_EVENTS.forEach((e) =>
          window.addEventListener(e, bump, { passive: true }),
        );
        document.addEventListener("visibilitychange", onVisible);
        // Check at 1/4 the timeout, clamped to [15s, 60s], so lockout lands within
        // a fraction of the configured window without a busy loop.
        const every = Math.min(60000, Math.max(15000, Math.floor(idleMs / 4)));
        poll = setInterval(check, every);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (poll) clearInterval(poll);
      ACT_EVENTS.forEach((e) => window.removeEventListener(e, bump));
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [authed, offlineDemo, doLogout, showToast]);
  const replaceMessage = useCallback(
    (m) =>
      setMessagesByConv((prev) => {
        // No-op if the thread isn't loaded. Every conversation room is joined on
        // connect, so MESSAGE_UPDATED (edits/reactions) now arrives for chats we've
        // never opened; without this guard the `(prev[id] || []).map` would write
        // an EMPTY array, and the history loaders (which short-circuit on
        // `messagesByConv[id]` existing) would then skip the full fetch and show
        // an empty thread. The edit is picked up by the full fetch on open instead.
        if (!prev[m.conversationId]) return prev;
        const arr = prev[m.conversationId].map((x) =>
          x.id === m.id ? m : x,
        );
        return { ...prev, [m.conversationId]: arr };
      }),
    [],
  );
  const appendMessage = useCallback(
    (m) =>
      setMessagesByConv((prev) => {
        const arr = prev[m.conversationId]
          ? prev[m.conversationId].slice()
          : [];
        if (arr.some((x) => x.id === m.id)) return prev;
        arr.push(m);
        return { ...prev, [m.conversationId]: arr };
      }),
    [],
  );
  const appendIfLoaded = useCallback(
    (m) =>
      setMessagesByConv((prev) => {
        const arr = prev[m.conversationId];
        if (!arr) return prev; // not loaded → leave it for the history loader
        if (arr.some((x) => x.id === m.id)) return prev;
        return { ...prev, [m.conversationId]: [...arr, m] };
      }),
    [],
  );
  const removeMessage = useCallback(
    (conversationId, id) =>
      setMessagesByConv((prev) => {
        if (!prev[conversationId]) return prev;
        return {
          ...prev,
          [conversationId]: prev[conversationId].filter((x) => x.id !== id),
        };
      }),
    [],
  );
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);
  useEffect(() => {
    commsConvIdRef.current = commsConvId;
  }, [commsConvId]);
  useEffect(() => {
    commsOpenRef.current = commsOpen;
  }, [commsOpen]);
  useEffect(() => {
    modalRef.current = modal;
  }, [modal]);
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (modalRef.current) {
        setModal(null);
        return;
      }
      // HIERARCHICAL: run only the TOPMOST registered overlay (LIFO stack), so Esc
      // closes one layer at a time and never touches a sibling/unrelated surface.
      if (runTopEsc()) return;
      // Fallback for overlays still on the legacy broadcast bus (they preventDefault
      // to consume). Only when nothing is open at all does Esc act as module Back.
      const ev = new CustomEvent("colab:esc", { cancelable: true });
      const notConsumed = window.dispatchEvent(ev); // false if preventDefault()
      if (notConsumed) goBackRef.current && goBackRef.current();
    };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, []);
  const [cmdkOpen, setCmdkOpen] = useState(false);
  const closeCmdk = useCallback(() => setCmdkOpen(false), []);
  useEffect(() => {
    if (!authed) {
      setCmdkOpen(false);
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        e.stopPropagation();
        setCmdkOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [authed]);
  useEffect(() => {
    if (!authed || !isDesktopApp) return;
    const STEPS = ["0.85", "0.9", "1", "1.1", "1.2"]; // mirror Settings ZOOMS
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const zin = e.key === "=" || e.key === "+";
      const zout = e.key === "-" || e.key === "_";
      const zreset = e.key === "0";
      if (!zin && !zout && !zreset) return;
      e.preventDefault();
      const cur =
        (document.documentElement.style.getPropertyValue("--uzoom") || "1").trim() ||
        "1";
      let idx = STEPS.indexOf(cur);
      if (idx < 0) {
        // Snap to the nearest step if some out-of-list value was applied.
        const n = Number(cur) || 1;
        idx = STEPS.reduce(
          (best, s, i) =>
            Math.abs(Number(s) - n) < Math.abs(Number(STEPS[best]) - n) ? i : best,
          0,
        );
      }
      const nextIdx = zreset
        ? STEPS.indexOf("1")
        : zin
          ? Math.min(STEPS.length - 1, idx + 1)
          : Math.max(0, idx - 1);
      const next = STEPS[nextIdx];
      if (next !== cur) changeSettingRef.current("zoom", next);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [authed]);
  const bumpPreview = useCallback(
    (m) => {
      const aid = activeIdRef.current;
      const viewingMain = !!aid && modeRef.current === "chats" && mobilePaneRef.current !== "list";
      const commsId = commsConvIdRef.current;
      const viewingComms = commsOpenRef.current && !!commsId;
      const isViewing = (viewingMain && m.conversationId === aid) || (viewingComms && m.conversationId === commsId);
      if (isViewing && !m.me && tokenRef.current && !offlineDemo) {
        api
          .setRead(
            tokenRef.current,
            m.conversationId,
            true,
            settingsRef.current?.readReceipts !== false,
          )
          .catch(() => {});
      }
      setConversations((prev) =>
        prev.map((c) => {
          if (c.id !== m.conversationId) return c;
          // A normally-ended call log shouldn't raise unread (you were in it);
          // missed/declined/cancelled and membership lines still do.
          // "Viewing" = the main pane's active chat OR the conversation currently
          // open in the in-call sidebar — either way you're reading it, so incoming
          // messages there don't accrue unread (mirrors onSelect zeroing unread).
          const nextUnread = isViewing
            ? 0
            : (c.unread || 0) +
              (!m.me &&
              !((m.type === "call" || m.type === "meeting_attendance") && /ended/i.test(m.text || ""))
                ? 1
                : 0);
          // Smart Inbox: keep the priority bucket LIVE on incoming messages —
          // an exact client mirror of the serialize.ts rules. Without this the
          // badge colour / Priority filter would lag until the next refetch.
          let priority: string = "low";
          if (nextUnread > 0 && !c.muted) {
            if (m.type === "meeting_invite") priority = "timely";
            else if (c.kind === "dm") priority = "action";
            else if (c.kind === "group" || c.kind === "channel") {
              const body = String(m.text || "");
              const first = (
                ((meRef.current && meRef.current.name) || "").split(" ")[0] ||
                ""
              ).replace(/\W/g, "");
              const mentioned =
                /@(all|everyone|here)\b/i.test(body) ||
                (first
                  ? new RegExp(
                      "@" +
                        first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
                        "\\b",
                      "i",
                    ).test(body)
                  : false);
              priority = mentioned ? "action" : "fyi";
            }
          }
          return {
            ...c,
            preview:
              // Call/membership logs are self-describing ("📞 Missed call",
              // "Alice added Bob") — no "You:" prefix (matches the server-
              // rendered preview, and avoids "You: 📞 Missed call").
              (m.me &&
              m.type !== "call" &&
              m.type !== "meeting_attendance" &&
              m.type !== "system" &&
              m.type !== "meeting_invite"
                ? "You: "
                : "") +
              (m.type === "voice"
                ? "🎙 Voice message"
                : m.type === "sticker"
                  ? "🖼️ Sticker"
                  : m.type === "gif"
                    ? "🎞️ GIF"
                    : m.file
                      ? "📎 " + m.file.name
                      : htmlPreview(m.text)),
            // Raw HTML so the row renders a compact formatted preview live (not
            // just on refresh). Null for voice/file/system/invite so the plain label is used.
            previewHtml:
              m.type === "voice" ||
              m.file ||
              m.encryptionVersion ||
              m.type === "call" ||
              m.type === "meeting_attendance" ||
              m.type === "system" ||
              m.type === "meeting_invite"
                ? null
                : m.text || null,
            time: m.time,
            // Bump recency so this conversation jumps to the top of the list.
            lastMessageAt: m.createdAt || new Date().toISOString(),
            unread: nextUnread,
            priority,
          };
        }),
      );
    },
    [offlineDemo],
  );
  const decryptConvPreviews = useCallback(async (convs: any[]) => {
    try {
      const enc = (convs || []).filter(
        (c) => c && c.lastMessageEnc && c.lastMessageEnc.ciphertext,
      );
      if (!enc.length) return;
      // skipPin: previews decrypt only the LATEST message; pinning the E2EE
      // downgrade anchor at that (newest) timestamp would raise it above the true
      // first encrypted message and widen the anti-downgrade window.
      const dec = await decryptMessageList(
        enc.map((c) => c.lastMessageEnc),
        { skipPin: true },
      );
      const byConv = new Map<string, any>();
      for (const d of dec) if (d && d.conversationId) byConv.set(d.conversationId, d);
      setConversations((prev) =>
        prev.map((c) => {
          const d = byConv.get(c.id);
          if (!d || typeof d.text !== "string" || !d.text) return c;
          if (
            c.lastMessageAt &&
            d.createdAt &&
            Date.parse(c.lastMessageAt) > Date.parse(d.createdAt)
          )
            return c;
          // Must match E2EE_PENDING_TEXT too, not just the legacy bracketed form.
          // The bracket test predates the current placeholder copy, which has no
          // bracket — so the placeholder was NOT recognised, and it overwrote a
          // perfectly good sidebar preview with "Syncing…".
          const placeholder =
            d.encrypted === false &&
            (d.text.startsWith("[") || d.text === E2EE_PENDING_TEXT);
          if (placeholder && c.preview) return c; // keep the good preview
          const meMsg = !!(c.lastMessageEnc && c.lastMessageEnc.me);
          return {
            ...c,
            preview: (meMsg ? "You: " : "") + htmlPreview(d.text),
            previewHtml: placeholder ? null : d.text,
          };
        }),
      );
    } catch (_) {}
  }, []);
  // Per-conversation member flags (starred / muted) the user just toggled.
  // A list refetch that STARTED before the toggle's POST was acknowledged may
  // carry the pre-toggle value (the server read the row before the write), and
  // landing late it used to overwrite the optimistic update — "Mark as
  // favourite" visibly un-did itself although the DB had it. The desktop app
  // hit this constantly: clicking back into the window fires the focus
  // reconcile → refetch at the same moment as the menu click. Entries hold the
  // flag value plus the time the write was acknowledged (null while in flight);
  // refetchConversations overlays an entry whenever its fetch began before that
  // ack, and drops it once a fetch that began after the ack confirms the server.
  const convFlagOverridesRef = useRef(
    new Map<string, { flags: Record<string, any>; committedAt: number | null; since: number }>(),
  );
  const refetchConversations = useCallback(async () => {
    try {
      const fetchStartedAt = Date.now();
      const convs = await api.getConversations(tokenRef.current);
      const aid = activeIdRef.current;
      const viewingMain = !!aid && modeRef.current === "chats" && mobilePaneRef.current !== "list";
      const commsId = commsConvIdRef.current;
      const viewingComms = commsOpenRef.current && !!commsId;
      const overrides = convFlagOverridesRef.current;
      const sanitized = (convs || []).map((c: any) => {
        if (!c) return c;
        let row = c;
        const ov = overrides.get(String(c.id));
        if (ov) {
          const stale = ov.committedAt == null || fetchStartedAt < ov.committedAt;
          // Safety valve: a write that never acks (network gone) must not pin
          // the row forever — after 60 s the server wins again.
          const expired = fetchStartedAt - ov.since > 60_000;
          if (stale && !expired) row = { ...c, ...ov.flags };
          else overrides.delete(String(c.id));
        }
        if ((viewingMain && row.id === aid) || (viewingComms && row.id === commsId)) {
          return { ...row, unread: 0 };
        }
        return row;
      });
      setConversations(sanitized);
      // This is also a RECOVERY path (focus/reconnect after a failed boot
      // hydration) — clear the sidebar skeleton once real data lands.
      setConvLoaded(true);
      decryptConvPreviews(sanitized);
    } catch (_) {}
  }, [decryptConvPreviews]);
  const refetchMeetings = useCallback(async () => {
    try {
      setMeetings(await api.getMeetings(tokenRef.current));
    } catch (_) {}
  }, []);
  useEffect(() => {
    let last = 0;
    const reconcile = () => {
      if (document.visibilityState !== "visible") return;
      if (!tokenRef.current) return;
      const now = Date.now();
      if (now - last < 4000) return;
      last = now;
      // Revive a socket the server destroyed on a rejected handshake, so
      // returning to the window recovers realtime IMMEDIATELY rather than
      // waiting out the backoff in connect_error. `active === false` is the
      // destroyed state specifically (socket.io's own reconnection handles a
      // merely-disconnected socket, and connect() is a no-op mid-reconnect).
      // We only need to revive it: the "connect" handler's hadConnection branch
      // already performs the full resync, including refetching the OPEN thread's
      // messages — which is the half this focus reconcile never covered and the
      // reason a stale thread survived an app switch.
      const sock: any = socketRef.current;
      if (sock && !sock.active && !sock.connected) {
        sock.auth = { token: tokenRef.current };
        sock.connect();
      }
      // The OPEN thread is being viewed the instant the tab regains focus. A
      // message that landed while this tab was backgrounded left the SERVER's
      // unread lit (the client marks unread=0 locally for the active chat but never
      // sent a read receipt for that message), so a plain refetch would resurrect
      // the badge on a conversation the user is literally looking at — and it stuck
      // until they switched chats (which finally fired setRead). So: if the chat
      // view is actually showing a conversation, mark it read on the SERVER, clear
      // it locally for a snappy badge, and DEFER the conversations refetch until the
      // read is registered so it returns unread:0 for this thread.
      const viewedId = activeIdRef.current;
      const chatOnScreen =
        !!viewedId &&
        modeRef.current === "chats" &&
        mobilePaneRef.current !== "list";
      if (chatOnScreen && tokenRef.current) {
        setConversations((prev) =>
          prev.map((c) => (c.id === viewedId && c.unread ? { ...c, unread: 0 } : c)),
        );
        api
          .setRead(
            tokenRef.current,
            viewedId,
            true,
            settingsRef.current?.readReceipts !== false,
          )
          .catch(() => {})
          .then(() => refetchConversations());
      } else {
        refetchConversations();
      }
      // Also refresh invites on focus so a pending connection request that arrived
      // while the tab was backgrounded gets its in-chat Accept/Decline control (the
      // pending DM and its invite must stay consistent).
      refetchInvites();
      // Force-refresh the OPEN thread directly, regardless of socket state. The
      // revive above only reloads the thread when the socket was fully DESTROYED;
      // a half-open/zombie socket (connected===true but silently dropping events)
      // would otherwise leave the open conversation stale until a manual reload —
      // the "I have to refresh 2-3 times" symptom. This REST refetch bypasses the
      // dead socket; it merges (non-destructive) and dedups by id, so it's cheap.
      const aidF = activeIdRef.current;
      if (aidF) {
        api
          .getMessages(tokenRef.current, aidF)
          .then(decryptMessageList)
          .then((msgs) => {
            setMessagesByConv((prev) => ({ ...prev, [aidF]: msgs }));
            setMsgLoadStatus((s) => ({ ...s, [aidF]: "loaded" }));
          })
          .catch(() => {});
      }
      // Contacts too: `users` was only ever set at boot, so a failed boot fetch
      // (or roster changes while backgrounded) left "No people found" until a
      // full refresh — the reported "users are not displayed" symptom.
      api
        .getUsers(tokenRef.current)
        .then((ppl) => setUsers(ppl || []))
        .catch(() => {});
      // Realign tasks/reminders/files too: a *_CHANGED missed while the tab was
      // backgrounded would otherwise leave those lists AND their rail/badge counts
      // stale until the next event or a full reconnect. Each refresh is page-1 +
      // authoritative counts, so it's cheap (and debounced above).
      // Tasks feed the Dashboard's "due today" line, so they are always realigned;
      // a module that is switched off (lib/hiddenModules.ts) renders nothing, so
      // its refetch would only add round trips to the focus burst.
      refetchTasksRef.current?.();
      if (!HIDDEN_MODULES.has("reminders")) refetchRemindersRef.current?.();
      if (!HIDDEN_MODULES.has("files")) refetchFilesRef.current?.();
      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        import("../../../lib/pushRegistration").then((m) => m.registerPush(tokenRef.current!)).catch(() => {});
      }
    };
    window.addEventListener("focus", reconcile);
    document.addEventListener("visibilitychange", reconcile);
    return () => {
      window.removeEventListener("focus", reconcile);
      document.removeEventListener("visibilitychange", reconcile);
    };
  }, [refetchConversations]);
  useEffect(() => {
    // Must exceed engine.io pingInterval(25s)+pingTimeout(20s) so a healthy-but-
    // idle socket (whose only traffic is the ping) is never force-cycled.
    const STALE_MS = 60000;
    const id = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      const sock: any = socketRef.current;
      if (!sock || !sock.connected) return; // not-connected is socket.io's own job
      const last = lastRealtimeAtRef.current;
      if (!last) return;
      if (Date.now() - last <= STALE_MS) return;
      // Silent zombie: cycle the transport. Stamp forward first so the reconnect
      // window isn't immediately re-flagged before "connect" refreshes it.
      lastRealtimeAtRef.current = Date.now();
      try {
        sock.disconnect();
        sock.connect();
      } catch (_) {
        /* best-effort; focus reconcile remains a fallback */
      }
    }, 15000);
    return () => clearInterval(id);
  }, []);
  const onLoadOlderCalls = useCallback(
    async (before) => {
      if (offlineDemo || !tokenRef.current) return [];
      return api
        .getCalls(tokenRef.current, { before, limit: 50 })
        .catch(() => []);
    },
    [offlineDemo],
  );
  const refetchCalls = useCallback(async () => {
    try {
      // Voicemail is masked off in the frontend (by request) — not fetched, so
      // `voicemails` stays empty and every surface derived from it (the Calls
      // section and the Activity rows/pills) disappears consistently.
      const c = await api.getCalls(tokenRef.current);
      setCalls(c);
    } catch (_) {}
  }, []);
  const applyTaskPage = useCallback((res: any) => {
    if (Array.isArray(res)) {
      setTasks(res);
      setTaskCount(res.length);
      setTaskCursor(null);
      setTaskHasMore(false);
      return;
    }
    const list = (res && res.tasks) || [];
    setTasks(list);
    setTaskCount(res && typeof res.count === "number" ? res.count : list.length);
    setTaskCursor((res && res.nextCursor) || null);
    setTaskHasMore(!!(res && res.hasMore));
  }, []);
  const refetchTasks = useCallback(async () => {
    try {
      // Thread the active SERVER-SIDE project filter so the page + count are for
      // the filtered set ("" = all, "none" = unfiled, else a project id). The
      // projects + saved views are refreshed alongside (cheap, owner-scoped).
      const proj = taskProjectFilterRef.current || undefined;
      const [page, projects, views] = await Promise.all([
        api.getTasks(tokenRef.current, { project: proj }),
        api.getTaskProjects(tokenRef.current).catch(() => []),
        api.getTaskViews(tokenRef.current).catch(() => []),
      ]);
      applyTaskPage(page);
      setTaskProjects(Array.isArray(projects) ? projects : []);
      setTaskViews(Array.isArray(views) ? views : []);
    } catch (_) {}
  }, [applyTaskPage]);
  const loadMoreTasks = useCallback(async () => {
    if (!taskCursor) return;
    setTaskLoadingMore(true);
    try {
      const res: any = await api.getTasks(tokenRef.current, {
        cursor: taskCursor,
        project: taskProjectFilterRef.current || undefined,
      });
      const more = (res && res.tasks) || [];
      setTasks((prev) => {
        const seen = new Set(prev.map((t) => t.id));
        return [...prev, ...more.filter((t) => !seen.has(t.id))];
      });
      if (res && typeof res.count === "number") setTaskCount(res.count);
      setTaskCursor((res && res.nextCursor) || null);
      setTaskHasMore(!!(res && res.hasMore));
    } catch (_) {
    } finally {
      setTaskLoadingMore(false);
    }
  }, [taskCursor]);
  const applyReminderPage = useCallback((res: any) => {
    if (Array.isArray(res)) {
      setReminders(res);
      setReminderCount(res.length);
      setReminderCounts({});
      setReminderCursor(null);
      setReminderHasMore(false);
      return;
    }
    const list = (res && res.reminders) || [];
    setReminders(list);
    setReminderCount(
      res && typeof res.count === "number" ? res.count : list.length,
    );
    setReminderCounts((res && res.counts) || {});
    setReminderCursor((res && res.nextCursor) || null);
    setReminderHasMore(!!(res && res.hasMore));
  }, []);
  const refetchReminders = useCallback(async () => {
    try {
      const [r, fld] = await Promise.all([
        api.getReminders(tokenRef.current),
        api.getFolders(tokenRef.current),
      ]);
      applyReminderPage(r);
      setFolders(fld);
    } catch (_) {}
  }, [applyReminderPage]);
  const loadMoreReminders = useCallback(async () => {
    if (!reminderCursor) return;
    setReminderLoadingMore(true);
    try {
      const res: any = await api.getReminders(tokenRef.current, {
        cursor: reminderCursor,
      });
      const more = (res && res.reminders) || [];
      setReminders((prev) => {
        const seen = new Set(prev.map((r) => r.id));
        return [...prev, ...more.filter((r) => !seen.has(r.id))];
      });
      if (res && typeof res.count === "number") setReminderCount(res.count);
      if (res && res.counts) setReminderCounts(res.counts);
      setReminderCursor((res && res.nextCursor) || null);
      setReminderHasMore(!!(res && res.hasMore));
    } catch (_) {
    } finally {
      setReminderLoadingMore(false);
    }
  }, [reminderCursor]);
  const refetchInvites = useCallback(async () => {
    if (offlineDemo || !tokenRef.current) return;
    try {
      setInvites(await api.getInvites(tokenRef.current));
    } catch (_) {}
  }, [offlineDemo]);
  const authSuccess = useCallback((token, user, refreshToken?, password?) => {
    tokenRef.current = token;
    setMe(user);
    // Persist via the token-store shim: localStorage on web, OS keychain (with a
    // localStorage mirror) on desktop. Fire-and-forget — the sync mirror is written
    // immediately inside saveToken so readers don't wait on the keychain IPC.
    saveToken(token).catch(() => {});
    // Phase 5: store the rotating refresh token so a lapsed access token can renew
    // silently (see api.ts attemptRefresh) instead of forcing a re-login.
    if (refreshToken) saveRefreshToken(refreshToken);
    setOfflineDemo(false);
    setMode("dashboard");
    // Clear the boot splash together with the authed flip so the SSO-handoff path
    // (which resolves auth during boot, while authResolving is still true) reveals
    // the app in one step with no login-screen flash. Harmless for password login,
    // where authResolving is already false.
    // Reveal the app NOW and let E2EE initialise alongside it. initE2EE is a chain
    // of sequential round trips (device check/registration, token rebind, backup
    // probe, history sync) — 2–3 s on a backend reached through a far-away edge
    // — and gating the reveal on it held BOTH the UI and every boot data fetch
    // (they key on `authed`) behind that chain. Overlapping is safe: the device
    // rebind rotates only the refresh token (the current access token stays
    // valid, api.ts's refresh is single-flight), and every decrypt/encrypt path
    // already waits on an in-flight init (manager.ts ensureDecryptReady) and
    // re-decrypts anything decoded before init settled (flushNotReadyConvs).
    setAuthed(true);
    setAuthResolving(false);
    initE2EE(token, user.id)
      .catch(() => { /* app is already open; encryption heals on retry/next init */ })
      .finally(() => {
        // WhatsApp-model automatic encrypted backup: on a PASSWORD sign-in
        // (the only moment the password exists in memory), silently create,
        // verify, or restore the user's server-blind history backup — so a
        // brand-new device shows full history instead of encrypted
        // placeholders. Fire-and-forget; sign-in never waits on it. Uses
        // tokenRef (initE2EE may have rebound the token to this device).
        if (password) void ensurePasswordBackup(tokenRef.current || token, password);
        // B2 — password-less login path (SSO, saved-session restore): a fresh
        // device with a password-wrapped backup waiting has NO way to auto-open
        // it (no password in memory). Offer the restore prompt instead so the
        // user can enter their sign-in password and recover history.
        else {
          needsPasswordRestore()
            .then((yes) => {
              if (yes) {
                setE2eeRestoreOpen(true);
                setE2eeRestorePw("");
                setE2eeRestoreErr(null);
              }
            })
            .catch(() => {});
        }
      });
  }, []);
  const authError = useCallback((e) => {
    setLoginError(
      e instanceof TypeError
        ? "Couldn't reach the server. Make sure the backend is running."
        : e?.message || "Something went wrong. Please try again.",
    );
  }, []);
  const doE2eeRestore = useCallback(async () => {
    if (!tokenRef.current || !e2eeRestorePw.trim()) return;
    setE2eeRestoreBusy(true);
    setE2eeRestoreErr(null);
    try {
      const res = await restoreWithPassword(tokenRef.current, e2eeRestorePw);
      if (res.noWrap) {
        setE2eeRestoreErr("No password-backed backup was found for your account.");
        return;
      }
      setE2eeRestoreOpen(false);
      setE2eeRestorePw("");
      showToast?.({
        text: `Restored ${res.restored} message${res.restored === 1 ? "" : "s"} from your backup.`,
      });
    } catch (e: any) {
      setE2eeRestoreErr(
        e && e.name === "WrongRecoveryKeyError"
          ? "That password doesn't match your backup."
          : e?.message || "Couldn't restore from backup. Please try again.",
      );
    } finally {
      setE2eeRestoreBusy(false);
    }
  }, [e2eeRestorePw, showToast]);
  const doLogin = useCallback(
    async (email, password, remember?, evictSessionId?) => {
      setLoginBusy(true);
      setLoginError(null);
      try {
        const out: any = await api.login(email, password, evictSessionId);
        // Session limit reached — don't log in; surface the device prompt so the
        // user can choose one to sign out (or cancel). Never silently removed.
        if (out && out.limitReached) {
          setLimitPrompt({
            email,
            password,
            remember,
            sessions: out.sessions || [],
            max: out.max,
          });
          return;
        }
        setLimitPrompt(null);
        authSuccess(out.token, out.user, out.refreshToken, password);
        // Desktop app: browser-like credential remember (OS keychain via
        // safeStorage). Save on a remember-on login, clear it when unchecked.
        const cd = (window as any).collabDesktop;
        if (cd?.saveCredential) {
          if (remember === false) cd.clearCredential?.();
          else cd.saveCredential(email, password);
        }
      } catch (e) {
        authError(e);
      } finally {
        setLoginBusy(false);
      }
    },
    [authSuccess, authError],
  );
  const signOutLoginDevice = useCallback(
    async (sessionId: string) => {
      setLoginBusy(true);
      setLoginError(null);
      try {
        const out: any = await api.evictLoginSession(
          limitPrompt?.email,
          limitPrompt?.password,
          sessionId,
        );
        setLimitPrompt((p: any) =>
          p
            ? { ...p, sessions: out.sessions || [], max: out.max, active: out.active, underLimit: out.underLimit }
            : p,
        );
      } catch (e) {
        authError(e);
      } finally {
        setLoginBusy(false);
      }
    },
    [limitPrompt, authError],
  );
  const doSignup = useCallback(
    async (name, email, password) => {
      setLoginBusy(true);
      setLoginError(null);
      try {
        const { token, user, refreshToken } = await api.signup(name, email, password);
        authSuccess(token, user, refreshToken, password);
        // Brand-new account → show the one-time welcome onboarding. (Login never
        // does this, so existing users are never interrupted.)
        setOnboardingOpen(true);
      } catch (e) {
        authError(e);
      } finally {
        setLoginBusy(false);
      }
    },
    [authSuccess, authError],
  );
  const [ssoBoot] = useState<{
    code: string | null;
    state: string | null;
    error: string | null;
    loginHint: string | null;
  }>(() => {
    if (typeof window === "undefined") return { code: null, state: null, error: null, loginHint: null };
    try {
      const p = new URLSearchParams(window.location.search);
      // The IdP redirects to the app ROOT (redirect_uri = "/") with ?code&state on
      // success, or ?error on denial. `sso_error` is our OWN start-side failure
      // (e.g. not_configured) surfaced by /api/auth/sso/start. `login_hint` (no
      // code) is the IdP app LAUNCHER opening our homepage for an already-signed-in
      // IdP user — we must start OIDC for them, not show the password form.
      return {
        code: p.get("code"),
        state: p.get("state"),
        error: p.get("error") || p.get("sso_error"),
        loginHint: p.get("login_hint"),
      };
    } catch (_) {
      return { code: null, state: null, error: null, loginHint: null };
    }
  });
  const ssoExchangedRef = useRef(false);
  useEffect(() => {
    const { code, state, error: err, loginHint } = ssoBoot;
    const isCallback = !!(code && state);
    if (!isCallback && !err && !loginHint) return;
    const strip = () => {
      try {
        const url = new URL(window.location.href);
        for (const k of ["code", "state", "error", "sso_error", "session_state", "iss", "login_hint"])
          url.searchParams.delete(k);
        window.history.replaceState({}, document.title, url.pathname + url.search + url.hash);
      } catch (_) {}
    };
    // IdP launcher: ?login_hint with no code. If this browser has no saved session,
    // go straight to SSO start with the hint (the IdP's own cookie then completes
    // the login). A saved session just proceeds to restore as usual.
    if (loginHint && !isCallback && !err) {
      if (!config.ssoEnabled) {
        strip();
        return;
      }
      loadToken()
        .then((tok) => {
          if (tok) {
            strip();
            return;
          }
          window.location.assign(api.ssoStartUrl(loginHint));
        })
        .catch(() => strip());
      return;
    }
    // An ?error (or our ?sso_error) with no code = a failed/denied sign-in.
    if (err && !isCallback) {
      const msg =
        err === "not_configured"
          ? "SSO isn't configured on this server yet."
          : err === "access_denied"
            ? "SSO sign-in was cancelled."
            : err === "start_failed"
              ? "Couldn't start SSO sign-in. Please try again."
              : "SSO sign-in failed. Please try again, or use your email and password.";
      setLoginError(msg);
      setAuthResolving(false);
      strip();
      return;
    }
    // Success: exchange ?code&state server-side, EXACTLY once (StrictMode double-
    // invokes this effect in dev; the OAuth code is single-use). Strip the params
    // first so a refresh can't replay them.
    if (ssoExchangedRef.current) return;
    ssoExchangedRef.current = true;
    setLoginBusy(true);
    strip();
    api
      .ssoCallback(code as string, state as string)
      .then(({ token, user, refreshToken }) => {
        // Remember HOW this session was made so logout can also end the IdP
        // session (guide v3 §9) — password logins never bounce through the IdP.
        try { window.localStorage.setItem("colab.authMethod", "sso"); } catch (_) {}
        authSuccess(token, user, refreshToken); // clears authResolving on authed flip
      })
      .catch((e) => {
        authError(e);
        setAuthResolving(false);
      })
      .finally(() => setLoginBusy(false));
  }, [authSuccess, authError, ssoBoot]);
  useEffect(() => {
    let cancelled = false;
    // Mid SSO callback (?code&state)? The dedicated SSO effect above owns auth
    // resolution — skip the saved-token path so it doesn't race it or flash the
    // login screen before the exchange completes. Uses the first-render snapshot
    // because the SSO effect has already stripped ?code from the live URL by now.
    if (ssoBoot.code && ssoBoot.state) return;
    // Load the saved token via the shim: localStorage on web, OS keychain (async)
    // on desktop. The durable server session keeps the user logged in across
    // restarts even though the access token's own TTL is short.
    loadToken()
      .then((token) => {
        if (cancelled) return;
        if (!token) {
          // No saved session → show the login screen immediately.
          setAuthResolving(false);
          return;
        }
        tokenRef.current = token;
        // P0 (unexpected sign-outs): the old catch treated EVERY me() failure —
        // network blip, 5xx during a deploy, 429 — as "token invalid" and wiped
        // the stored session, dumping the user at sign-in. Only a confirmed 401
        // is proof the token is dead; anything else retries with backoff while
        // the splash holds, and on final give-up we show sign-in WITHOUT
        // destroying the stored session (next launch restores it).
        const RESTORE_RETRY_MS = [2000, 4000, 8000, 15000];
        const attemptRestore = (attempt: number) => {
        api
          .me(tokenRef.current || token)
          .then((user) => {
            if (cancelled) return;
            setMe(user);
            // REFRESH restores the last-visited module (persisted to clb_mode while
            // authed). A fresh sign-in never runs this branch — authSuccess forces
            // "dashboard" — so login / signup / SSO still land on the Dashboard.
            // Validate against the known set so a stale value can't wedge the app.
            try {
              // Hidden modules are deliberately absent: a clb_mode saved before
              // they were switched off must not reopen one on next launch.
              // (setMode also guards this, but keeping them out of KNOWN means
              // the stale value is simply ignored rather than bounced.)
              const KNOWN = [
                "dashboard", "chats", "search", "agents", "settings",
                "calendar", "meetings", "activity", "contacts",
              ].filter((m) => !HIDDEN_MODULES.has(m));
              const saved = localStorage.getItem("clb_mode");
              if (saved && KNOWN.includes(saved)) setMode(saved);
            } catch (_) {}
            // Flip authed + resolving together AFTER E2EE init settles, so the app
            // is revealed in one step with no login flash in between.
            // .catch BEFORE .finally: without it an E2EE init failure on this
            // (session-restore) path became an unhandled promise rejection —
            // surfacing as a console error with no context. The sibling
            // password-login path at authSuccess already catches. The app still
            // opens either way; encryption heals on the next init.
            // Reveal first, initialise E2EE alongside (see authSuccess for why
            // this overlap is safe) — on the everyday "open the app" path this
            // chain was the single largest delay before the Dashboard appeared.
            setAuthed(true);
            setAuthResolving(false);
            initE2EE(token, user.id)
              .catch((e) => {
                console.warn("[e2ee] init failed on session restore:", e?.message || e);
              })
              .finally(() => {
                // B2 — same prompt offer as the SSO path: a fresh/reset device
                // whose password-wrapped backup can't auto-open (no password on
                // session restore) is offered the chance to enter it.
                needsPasswordRestore()
                  .then((yes) => {
                    if (yes) {
                      setE2eeRestoreOpen(true);
                      setE2eeRestorePw("");
                      setE2eeRestoreErr(null);
                    }
                  })
                  .catch(() => {});
              });
          })
          .catch((err: any) => {
            if (cancelled) return;
            if (err && err.status === 401) {
              // Token invalid/expired/revoked → clear it (localStorage + keychain)
              // and fall through to the login screen.
              tokenRef.current = null;
              clearToken().catch(() => {});
              // Also purge composer drafts so a prior user's unsent text on this
              // browser can't leak to the next sign-in (this boot-restore 401 path
              // doesn't go through doLogout, which is the other purge site).
              try {
                for (let i = window.localStorage.length - 1; i >= 0; i--) {
                  const k = window.localStorage.key(i);
                  if (k && k.startsWith("clb_draft_")) window.localStorage.removeItem(k);
                }
              } catch (_) {}
              setDrafts({});
              setAuthResolving(false);
            } else if (attempt < RESTORE_RETRY_MS.length) {
              // Transient (network/5xx/429) or org-membership pivot in flight
              // (403 → the org-invalid recovery is switching orgs) — retry.
              setTimeout(() => {
                if (!cancelled) attemptRestore(attempt + 1);
              }, RESTORE_RETRY_MS[attempt]);
            } else {
              // ~30s of failures: surface sign-in, but KEEP the stored session —
              // the server being unreachable is not proof the session is dead.
              tokenRef.current = null;
              setAuthResolving(false);
            }
          });
        };
        attemptRestore(0);
      })
      .catch(() => {
        if (!cancelled) setAuthResolving(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    setOnHistoryRestored((convIds) => {
      setMessagesByConv((p) => {
        const n = { ...p };
        convIds.forEach((id) => {
          delete n[id];
        });
        return n;
      });
      // B1: a restore merged plaintext for these conversations. Dropping only
      // the message cache is NOT enough — loadMessages short-circuits on a
      // "loaded" status, so the currently-open thread would stay on its stale
      // (pending) rows forever. Reset the load status too so the lazy loader
      // refetches + re-runs decryptMessageList, which now serves the restored
      // plaintext from the cache.
      setMsgLoadStatus((s) => {
        const n = { ...s };
        convIds.forEach((id) => {
          delete n[id];
        });
        return n;
      });
      // Also refresh the sidebar PREVIEW line for the restored conversations:
      // it's decrypted separately from the thread (decryptConvPreviews) and,
      // without this, would keep showing "[Encrypted — waiting to sync…]" as
      // the last-message preview even though the thread itself has healed. The
      // cache-first decrypt path now finds the restored plaintext.
      const restored = new Set(convIds);
      const rows = (conversationsRef.current || []).filter((c: any) => restored.has(c.id));
      if (rows.length) decryptConvPreviews(rows);
      // B1: if the CURRENTLY-OPEN thread is among the restored conversations,
      // force a refetch right now so its pending rows heal immediately — not
      // only when the user next clicks "Try again" or the 90s safety-net loop
      // happens to tick. loadMessages(force=true) ignores the fresh status we
      // just reset and re-runs decryptMessageList against the merged cache.
      if (activeIdRef.current && restored.has(activeIdRef.current)) {
        loadMessagesRef.current(activeIdRef.current, true);
      }
    });
  }, [decryptConvPreviews]);
  useEffect(() => {
    if (!authed || !isE2EEEnabled()) return;
    const RETRY_MS = 90000;
    const CAP = 5;
    const attemptsByConv = new Map<string, number>();
    const id = setInterval(() => {
      const aid = activeIdRef.current;
      if (!aid || !tokenRef.current) return;
      const msgs = messagesByConvRef.current?.[aid];
      const hasPending =
        Array.isArray(msgs) &&
        msgs.some((m: any) => m && m._pendingRecovery === true);
      if (!hasPending) {
        attemptsByConv.delete(aid); // thread healed → reset this conversation's budget
        return;
      }
      const n = attemptsByConv.get(aid) || 0;
      attemptsByConv.set(aid, n + 1);
      // Budget spent → slow down, never stop: every 5th tick (≈7.5 min) keeps
      // checking, so rows re-delivered while nothing else triggered a reload
      // still appear without the user having to receive a new message.
      if (n >= CAP && (n - CAP) % 5 !== 4) return;
      // Re-arm the once-per-session throttles for THIS conversation, then re-decrypt:
      // the re-decrypt re-hits keyGone/fsGone/decrypt-failed and re-issues heal / rekey
      // / self-recovery with the throttles cleared.
      rearmRecovery(aid);
      api
        .getMessages(tokenRef.current, aid)
        .then(decryptMessageList)
        .then((m) => setMessagesByConv((prev) => ({ ...prev, [aid]: m })))
        .catch(() => {});
    }, RETRY_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed]);
  useEffect(() => {
    if (!authed) return;
    try {
      localStorage.setItem("clb_mode", mode);
    } catch (_) {}
  }, [authed, mode]);
  const freqRank = useMemo(() => {
    const m: Record<string, number> = {};
    (frequentUsers || []).forEach((u: any) => {
      if (u && u.id) m[u.id] = u.score || 0;
    });
    return m;
  }, [frequentUsers]);
  const sortByFreq = useCallback(
    (list: any[]) =>
      [...(list || [])].sort((a, b) => {
        const sa = freqRank[a && a.id] || 0;
        const sb = freqRank[b && b.id] || 0;
        if (sb !== sa) return sb - sa;
        return String((a && a.name) || "").localeCompare(
          String((b && b.name) || ""),
        );
      }),
    [freqRank],
  );
  const changeSettingRef = useRef(changeSetting);
  const active = conversations.find((c) => c.id === activeId) || null;

  return {
    replaceMessage,
    appendMessage,
    appendIfLoaded,
    removeMessage,
    cmdkOpen,
    setCmdkOpen,
    closeCmdk,
    bumpPreview,
    decryptConvPreviews,
    refetchConversations,
    convFlagOverridesRef,
    refetchMeetings,
    onLoadOlderCalls,
    refetchCalls,
    applyTaskPage,
    refetchTasks,
    loadMoreTasks,
    applyReminderPage,
    refetchReminders,
    loadMoreReminders,
    refetchInvites,
    authSuccess,
    authError,
    doE2eeRestore,
    doLogin,
    signOutLoginDevice,
    doSignup,
    ssoBoot,
    ssoExchangedRef,
    freqRank,
    sortByFreq,
    changeSettingRef,
    active,
  };
}
