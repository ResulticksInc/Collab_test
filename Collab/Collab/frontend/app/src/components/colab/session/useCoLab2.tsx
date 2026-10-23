// CoLab session hook — segment 2 (Socket).
// Mechanical extraction from CoLabV1.tsx (statements 254–254),
// plus statements pulled forward so this hook is self-contained.

import { useEffect, useRef, useCallback } from "react";
import { HIDDEN_MODULES } from "../../../lib/hiddenModules";
import { api } from "../../../lib/api";
import { connectSocket, EVENTS } from "../../../lib/socket";
import { decryptMessageList, myDeviceId, onPeerDeviceApproved, onSyncReady, onSyncRequested, rewrapEpochsForDevice, onConversationKeysUpdated, rearmRecoveryOnReconnect, rememberSentPlaintext, E2EE_PENDING_TEXT, redeliverMessage, redeliverMany, onRedelivered } from "../../../lib/e2ee/manager";
import { playPattern, MESSAGE_TONE } from "../../../lib/sounds";
import { tagFor, shouldPush, fire as fireNotif, type NotifPayload } from "../../../lib/dispatchNotif";
import { htmlPreview } from "../helpers";

export type CoLabSession2 = {
  authed: any; offlineDemo: any; tokenRef: any; socketRef: any;
  onSelect: any; setMode: any; setActiveCall: any; setJumpMsgId: any;
  setOpenTaskId: any; refetchTasks: any; setFocusReminderId: any; refetchReminders: any;
  showToast: any; setOpenFileId: any; refetchInvites: any; setOrgTab: any;
  tasks: any; reminders: any; setConversations: any; setConvLoaded: any;
  decryptConvPreviews: any; setUsers: any; users: any; setMeetings: any;
  setCalls: any; setNotifications: any; setNotifUnread: any; setFrequentUsers: any;
  setBlockedIds: any; applyTaskPage: any; applyReminderPage: any; setFolders: any;
  setInvites: any; setSettings: any; applySettings: any; lastRealtimeAtRef: any;
  setConnected: any; refetchConversations: any; activeIdRef: any; setMessagesByConv: any;
  setMsgLoadStatus: any; activeCallRef: any; seenMsgIdsRef: any; seenMsgOrderRef: any;
  meRef: any; me: any; sentFileEnvRef: any; appendIfLoaded: any;
  bumpPreview: any; maybeNotify: any; conversationsRef: any; setReadState: any;
  removeMessage: any; setActiveId: any; setMe: any; refetchMeetings: any;
  refetchCalls: any; setTaskTick: any; refetchFilesRef: any; setFileChangeTick: any;
  presentationDndActive: any; notifGateContext: any; setHandoffOffer: any; setRoomState: any;
  doLogout: any; rekeyRecheckRef: any; messagesByConvRef: any; keysUpdatedTimersRef: any;
  dupHandledRef: any; roomStateRef: any; setMeetingDup: any; setTypingBy: any;
  typingTimersRef: any; appendMessage: any; replaceMessage: any; setScheduledByConv: any;
  roomState: any; connected: any; settingsRef: any; setFeedbackMeta: any;
  modeRef: any; mobilePaneRef: any; commsOpenRef: any; commsConvIdRef: any;
};

export function useCoLab2(ctx: CoLabSession2) {

  const {
    authed, offlineDemo, tokenRef, socketRef,
    onSelect, setMode, setActiveCall, setJumpMsgId,
    setOpenTaskId, refetchTasks, setFocusReminderId, refetchReminders,
    showToast, setOpenFileId, refetchInvites, setOrgTab,
    tasks, reminders, setConversations, setConvLoaded,
    decryptConvPreviews, setUsers, users, setMeetings,
    setCalls, setNotifications, setNotifUnread, setFrequentUsers,
    setBlockedIds, applyTaskPage, applyReminderPage, setFolders,
    setInvites, setSettings, applySettings, lastRealtimeAtRef,
    setConnected, refetchConversations, activeIdRef, setMessagesByConv,
    setMsgLoadStatus, activeCallRef, seenMsgIdsRef, seenMsgOrderRef,
    meRef, me, sentFileEnvRef, appendIfLoaded,
    bumpPreview, maybeNotify, conversationsRef, setReadState,
    removeMessage, setActiveId, setMe, refetchMeetings,
    refetchCalls, setTaskTick, refetchFilesRef, setFileChangeTick,
    presentationDndActive, notifGateContext, setHandoffOffer, setRoomState,
    doLogout, rekeyRecheckRef, messagesByConvRef, keysUpdatedTimersRef,
    dupHandledRef, roomStateRef, setMeetingDup, setTypingBy,
    typingTimersRef, appendMessage, replaceMessage, setScheduledByConv,
    roomState, connected, settingsRef, setFeedbackMeta,
    modeRef, mobilePaneRef, commsOpenRef, commsConvIdRef
  } = ctx;

  // ---- CoLabV1.tsx statements 254–254 (and pulled) ----
  useEffect(() => {
    if (!authed || offlineDemo) return;
    let cancelled = false;
    // Pending revival of a socket the server destroyed on a rejected handshake
    // (see connect_error below). Declared at EFFECT scope, not inside the async
    // body, so the cleanup below can clear it. Cleared on connect and unmount.
    let reviveTimer: ReturnType<typeof setTimeout> | null = null;
    const swHandler = (ev: MessageEvent) => {
      if (ev.data?.type !== "NOTIFICATION_ACTION") return;
      const nav = ev.data.nav || {};
      const tok = tokenRef.current;
      try { window.focus(); } catch (_) { }
      const s = socketRef.current;

      switch (nav.action) {
        case "dismiss":
          break;

        case "answer-call":
          if (nav.conversationId) { onSelect(nav.conversationId); setMode("chats"); }
          setActiveCall((cur: any) => {
            if (cur && cur.status === "ringing" && cur.dir === "in" && s && cur.callId) {
              s.emit(EVENTS.CALL_ACCEPT, { callId: cur.callId });
              return { ...cur, status: "connected" };
            }
            return cur;
          });
          break;

        case "decline-call":
          setActiveCall((cur: any) => {
            if (cur && cur.status === "ringing" && cur.dir === "in" && s && cur.callId) {
              s.emit(EVENTS.CALL_DECLINE, { callId: cur.callId });
              return null;
            }
            return cur;
          });
          break;

        case "reply-message":
          if (nav.conversationId) {
            onSelect(nav.conversationId);
            setMode("chats");
            if (nav.targetId) setJumpMsgId(nav.targetId);
          }
          break;

        case "mark-read":
          if (nav.conversationId) {
            onSelect(nav.conversationId);
            setMode("chats");
            if (tok) api.setRead(tok, nav.conversationId, true, false).catch(() => { });
          }
          break;

        case "join-meeting":
          setMode("calendar");
          break;

        case "task-view":
          setMode("tasks");
          if (nav.targetId) setOpenTaskId(nav.targetId);
          break;

        case "task-complete":
          setMode("tasks");
          if (nav.targetId) setOpenTaskId(nav.targetId);
          if (tok && nav.targetId) {
            api.moveTask(tok, nav.targetId, "done")
              .then(() => refetchTasks())
              .catch(() => { });
          }
          break;

        case "reminder-view":
          setMode("reminders");
          if (nav.targetId) setFocusReminderId(nav.targetId);
          break;

        case "reminder-complete":
          setMode("reminders");
          if (nav.targetId) setFocusReminderId(nav.targetId);
          if (tok && nav.targetId) {
            api.completeReminder(tok, nav.targetId)
              .then(() => refetchReminders())
              .catch(() => { });
          }
          break;

        case "reminder-snooze":
          setMode("reminders");
          if (nav.targetId) setFocusReminderId(nav.targetId);
          if (tok && nav.targetId) {
            api.snoozeReminder(tok, nav.targetId, 10)
              .then(() => { refetchReminders(); showToast("Snoozed 10 min"); })
              .catch(() => { });
          }
          break;

        case "file-view":
          // A file-share notification (targetType "file", no conversationId)
          // opens the Files module focused on / highlighting that file — it must
          // NOT fall through to the chats default (the old dead-end).
          setMode("files");
          if (nav.targetId) setOpenFileId(nav.targetId);
          break;

        case "accept-invite":
          setMode("contacts");
          if (tok && nav.targetId) {
            api.acceptInvite(tok, nav.targetId)
              .then(() => refetchInvites())
              .catch(() => { });
          }
          break;

        case "decline-invite":
          setMode("contacts");
          if (tok && nav.targetId) {
            api.declineInvite(tok, nav.targetId)
              .then(() => refetchInvites())
              .catch(() => { });
          }
          break;

        case "navigate":
        default:
          if (nav.conversationId) {
            onSelect(nav.conversationId);
            setMode(nav.mode || "chats");
            if (nav.targetId && nav.mode === "chats") setJumpMsgId(nav.targetId);
          } else if (nav.mode) {
            // Set the org deep-link tab BEFORE the mode flip so OrgAdmin mounts
            // straight onto the right tab (BA #6) rather than flashing Members.
            if (nav.mode === "org" && nav.orgTab) setOrgTab(nav.orgTab);
            setMode(nav.mode);
            if (nav.mode === "tasks" && nav.targetId) setOpenTaskId(nav.targetId);
            else if (nav.mode === "files" && nav.targetId) setOpenFileId(nav.targetId);
          }
          break;
      }
    };
    if (typeof navigator !== "undefined" && "serviceWorker" in navigator)
      navigator.serviceWorker.addEventListener("message", swHandler);
    (async () => {
      try {
        const token = tokenRef.current;
        if (!token) return;
        // Phase 2 requests START NOW, alongside Phase 1, instead of after it. Every
        // API call is a full round trip to the backend (~350 ms when the app is
        // served from an edge on another continent), so a Phase-1 → Phase-2 →
        // frequent/blocked chain cost three sequential trips before the Dashboard
        // (which renders meetings, calls, tasks, invites and frequent users) was
        // complete. The RESULTS are still applied after Phase 1 has painted (see
        // fetchSecondary below), so first paint is unchanged — only the network
        // waits overlap. Hidden modules (lib/hiddenModules.ts) are not fetched at
        // all: nothing renders reminders/folders while the module is off. Tasks
        // stay — the Dashboard's "due today" line reads them.
        const remindersHidden = HIDDEN_MODULES.has("reminders");
        const EMPTY_REMINDERS = { reminders: [], hasMore: false, nextCursor: null, count: 0, counts: {} };
        const secondaryP = Promise.all([
          api.getMeetings(token).catch(() => []),
          api.getCalls(token).catch(() => []),
          api.getTasks(token).catch(() => ({ tasks: [], hasMore: false, nextCursor: null, count: 0 })),
          remindersHidden ? Promise.resolve(EMPTY_REMINDERS) : api.getReminders(token).catch(() => EMPTY_REMINDERS),
          remindersHidden ? Promise.resolve([]) : api.getFolders(token).catch(() => []),
          api.getInvites(token).catch(() => []),
          api.getNotifications(token).catch(() => []),
          api.getFrequentUsers(token).catch(() => []),
          api.getBlockedUsers(token).catch(() => []),
        ]);
        // Phase 1 (Immediate / Core Interactive Shell): conversations, users, settings, unread count
        const [convs, ppl, sett, ncount] = await Promise.all([
          api.getConversations(token).catch(() => null),
          api.getUsers(token).catch(() => null),
          api.getSettings(token).catch(() => null),
          api.getUnreadNotificationCount(token).catch(() => ({ count: 0 })),
        ]);
        if (cancelled) return;
        if (convs !== null) {
          setConversations(convs);
          setConvLoaded(true);
          // Yield E2EE preview decryption to idle to eliminate main thread blocking during first paint
          if (typeof window !== "undefined" && "requestIdleCallback" in window) {
            (window as any).requestIdleCallback(() => { if (!cancelled) decryptConvPreviews(convs); });
          } else {
            setTimeout(() => { if (!cancelled) decryptConvPreviews(convs); }, 60);
          }
        }
        if (ppl !== null) setUsers(ppl);
        if (sett) {
          const norm = {
            ...sett,
            inMeetingChatMode: sett.inMeetingChatMode !== false,
          };
          setSettings(norm);
          applySettings(norm);
        }
        setNotifUnread((ncount && ncount.count) || 0);

        // Backoff retry for whichever critical list failed:
        if (convs === null || ppl === null) {
          const DELAYS = [2000, 5000, 10000, 20000, 30000];
          const rehydrate = (attempt: number, need: { convs: boolean; users: boolean }) => {
            if (cancelled || (!need.convs && !need.users)) return;
            setTimeout(async () => {
              if (cancelled || !tokenRef.current) return;
              const left = { ...need };
              if (need.convs) {
                try {
                  const rows = await api.getConversations(tokenRef.current);
                  if (cancelled) return;
                  setConversations(rows);
                  setConvLoaded(true);
                  decryptConvPreviews(rows);
                  left.convs = false;
                } catch (_) { }
              }
              if (need.users) {
                try {
                  const rows = await api.getUsers(tokenRef.current);
                  if (cancelled) return;
                  setUsers(rows);
                  left.users = false;
                } catch (_) { }
              }
              rehydrate(Math.min(attempt + 1, DELAYS.length - 1), left);
            }, DELAYS[attempt]);
          };
          rehydrate(0, { convs: convs === null, users: ppl === null });
        }

        // Phase 2 (applied post-paint): the secondary lists requested above, in
        // flight since before Phase 1 — this only waits for whatever is still
        // outstanding and commits it in one batch.
        const fetchSecondary = async () => {
          if (cancelled || !tokenRef.current) return;
          try {
            const [mtgs, cls, tsk, rem, fld, inv, notifs, freq, blocked] = await secondaryP;
            if (cancelled) return;
            setMeetings(mtgs);
            setCalls(cls);
            setNotifications(notifs || []);
            applyTaskPage(tsk);
            applyReminderPage(rem);
            setFolders(fld);
            setInvites(inv);
            setFrequentUsers(freq || []);
            setBlockedIds(
              new Set(
                (Array.isArray(blocked) ? blocked : [])
                  .map((x: any) => x.id || x.blockedId || x.userId)
                  .filter(Boolean),
              ),
            );
          } catch (_) { }
        };

        if (typeof window !== "undefined" && "requestIdleCallback" in window) {
          (window as any).requestIdleCallback(fetchSecondary);
        } else {
          setTimeout(fetchSecondary, 100);
        }
        if (typeof Notification !== "undefined") {
          // Electron always grants notification permission — skip browser prompt.
          const isElectron = typeof window !== "undefined" && (window as any).collabDesktop?.appInfo?.isElectron;
          if (isElectron) {
            import("../../../lib/pushRegistration").then((m) => m.registerPush(token)).catch(() => { });
          } else if (Notification.permission === "granted") {
            import("../../../lib/pushRegistration").then((m) => m.registerPush(token)).catch(() => { });
          }
          // DELIBERATELY NO requestPermission() HERE. Asking at boot — before
          // the user has done anything — is the "too many permissions" prompt
          // people complained about, and browsers increasingly penalise it.
          //
          // On Safari it was worse than merely rude: Safari requires
          // requestPermission() to be called from a user gesture, so firing it
          // from this async hydration .then() silently resolved 'default' and
          // registerPush (which hard-returns unless permission === "granted")
          // never ran. Notifications could therefore NEVER be enabled on Safari
          // from the boot path at all.
          //
          // The correct, gesture-driven path already exists: Settings →
          // enableNotifs(), which prompts on a real click and then registers
          // push. Users who have already granted are handled by the branch
          // above, so nobody loses notifications they had turned on.
        }
        if (typeof window !== "undefined") {
          const sp = new URLSearchParams(window.location.search);
          const nConv = sp.get("notif_conv");
          const nMode = sp.get("notif_mode");
          const nAnswer = sp.get("notif_answer");
          const nTarget = sp.get("notif_target");
          const nAction = sp.get("notif_action");
          const nOrgTab = sp.get("notif_orgtab");
          if (nConv || nMode || nAnswer || nTarget || nAction) {
            // Cold start from a push with no app tab open: seed the Organization
            // deep-link tab before the mode flip (BA #6), same as the SW path.
            if (nMode === "org" && nOrgTab) setOrgTab(nOrgTab);
            if (nConv) {
              onSelect(nConv);
              setMode(nMode || "chats");
              // The notification's message id (notif_target) → scroll to it, same as
              // the already-open-tab click path does.
              if (nTarget && (nMode || "chats") === "chats" && !nAction) setJumpMsgId(nTarget);
            }
            else if (nMode) setMode(nMode);
            if (nAction === "task-complete" && nTarget) {
              setMode("tasks");
              setOpenTaskId(nTarget);
              api.moveTask(token, nTarget, "done").then(() => refetchTasks()).catch(() => { });
            } else if (nAction === "accept-invite" && nTarget) {
              setMode("contacts");
              api.acceptInvite(token, nTarget).then(() => refetchInvites()).catch(() => { });
            } else if (nAction === "decline-invite" && nTarget) {
              setMode("contacts");
              api.declineInvite(token, nTarget).then(() => refetchInvites()).catch(() => { });
            } else if (nAction === "reminder-complete" && nTarget) {
              setMode("reminders");
              setFocusReminderId(nTarget);
              api.completeReminder(token, nTarget).then(() => refetchReminders()).catch(() => { });
            } else if (nAction === "reminder-snooze" && nTarget) {
              setMode("reminders");
              setFocusReminderId(nTarget);
              api.snoozeReminder(token, nTarget, 10).then(() => refetchReminders()).catch(() => { });
            } else if (nTarget && nMode === "tasks") {
              setOpenTaskId(nTarget);
            } else if (nTarget && nMode === "reminders") {
              setFocusReminderId(nTarget);
            } else if (nTarget && nMode === "files") {
              setMode("files");
              setOpenFileId(nTarget);
            }
            window.history.replaceState({}, "", window.location.pathname);
          }
        }
        const first = (convs || []).find((c) => c && c.kind !== "self") || (convs || [])[0];
        // Do NOT auto-open a conversation on boot/module entry. The Messaging
        // module should land on the empty "select or start a conversation" state
        // (ChatView renders <Welcome/> when no conversation is active) until the
        // user explicitly clicks a conversation. (`first` is still used by the
        // READY handler below to refresh whatever the user later selects.)
        const socket = connectSocket(token);
        socketRef.current = socket;
        let hadConnection = false;
        // Liveness heartbeat for the zombie-socket detector: stamp on every
        // inbound event AND every engine.io ping. On a healthy-but-idle socket the
        // ping (default ~25s) keeps this fresh with no app traffic; on a half-open
        // transport BOTH stop, so the detector's staleness window trips.
        lastRealtimeAtRef.current = Date.now();
        try {
          socket.onAny(() => { lastRealtimeAtRef.current = Date.now(); });
          socket.io.on("ping", () => { lastRealtimeAtRef.current = Date.now(); });
        } catch (_) { /* older socket.io shape — detector falls back to focus reconcile */ }
        socket.on("connect", () => {
          setConnected(true);
          lastRealtimeAtRef.current = Date.now();
          // FIRST connect — close the hydration→subscribe race. Boot hydration
          // takes its REST snapshot BEFORE this socket subscribes, so anything
          // that lands in that window is neither in the snapshot NOR delivered
          // live — which is exactly the "stale until I refresh 2-3 times" symptom.
          // Do a NON-DESTRUCTIVE catch-up: refetch the sidebar and force-refresh
          // the open thread only. (No cache-nuke here, unlike a reconnect: the
          // freshly-hydrated caches are still valid and must not be dropped.)
          if (!hadConnection) {
            refetchConversations();
            // Keep the invite list in lock-step with the (now visible) conversation
            // list: a pending connection DM is visible to the recipient, but its
            // in-chat Accept/Decline bar needs the matching invite in state — so a
            // missed INVITE_NEW must be backfilled here too, not just conversations.
            refetchInvites();
            const aid0 = activeIdRef.current;
            if (aid0) {
              api
                .getMessages(tokenRef.current, aid0)
                .then(decryptMessageList)
                .then((msgs) => {
                  if (!cancelled) {
                    setMessagesByConv((prev) => ({ ...prev, [aid0]: msgs }));
                    setMsgLoadStatus((s) => ({ ...s, [aid0]: "loaded" }));
                  }
                })
                .catch(() => {
                  /* keep hydrated data; next open/focus reconciles */
                });
            }
          }
          // Reconnect after a network blip: rejoin the room the user is actually
          // in and refetch so NO messages sent during the gap are missed.
          if (hadConnection) {
            // Re-arm ALL E2EE recovery now the socket is back — not just the epoch
            // re-key throttle. A heal/rekey that went unanswered while peers were
            // offline can re-fire, and any sibling sync bundle or own-backup that
            // landed during the gap is pulled now (both were previously init-only).
            // The active-thread re-decrypt below then re-hits keyGone/fsGone/decrypt-
            // failed and re-requests with the throttles cleared.
            rearmRecoveryOnReconnect();
            const aid = activeIdRef.current;
            if (aid) {
              socket.emit(EVENTS.CONVERSATION_JOIN, { conversationId: aid });
              api
                // Use the LIVE token (tokenRef), not the boot-effect closure's
                // stale `token` — a rotation mid-session would 401 this refetch.
                .getMessages(tokenRef.current, aid)
                .then(decryptMessageList)
                .then((msgs) => {
                  // Replace the whole cache with ONLY the freshly-fetched active
                  // thread, dropping every other loaded conversation. Those
                  // reload fresh via the onSelect/sidebar loaders on next open —
                  // otherwise a non-active chat that received messages during the
                  // disconnect keeps its stale thread (the loaders short-circuit
                  // on a present entry) and permanently misses them.
                  if (!cancelled) {
                    setMessagesByConv({ [aid]: msgs });
                    // #3-B: keep the load-status map in lock-step — only `aid` is
                    // now loaded; clearing the rest makes them REFETCH on next
                    // open (a stale 'loaded' status + dropped cache = blank thread
                    // that never reloads).
                    setMsgLoadStatus({ [aid]: "loaded" });
                  }
                })
                .catch(() => {
                  // Don't wipe on a failed reconnect refetch — keep the prior
                  // thread + statuses; just mark the active one retryable.
                  if (!cancelled)
                    setMsgLoadStatus((s) => ({ ...s, [aid]: "error" }));
                });
            } else {
              // No active conversation — still drop stale caches so every chat
              // reloads fresh on next open after the disconnect gap.
              if (!cancelled) {
                setMessagesByConv({});
                setMsgLoadStatus({}); // #3-B: reset statuses so all refetch
              }
            }
            refetchConversations();
            // Backfill invites alongside conversations (see the connect handler) so a
            // pending connection request whose INVITE_NEW was missed during the drop
            // isn't stranded as a DM without its Accept/Decline control.
            refetchInvites();
            // AUDIT P1 (#6): re-register in the huddle on reconnect. The dropped
            // socket's cleanup removed us from the roster; LiveKit media auto-
            // reconnects but the roster is never rebuilt, so we'd vanish from
            // everyone's participant list (and could post a spurious "Group call
            // ended") while still audible/visible. HUDDLE_JOIN is idempotent.
            const ac = activeCallRef.current;
            if (ac && (ac as any).group && ac.conversationId && ac.status === "connected") {
              socket.emit(EVENTS.HUDDLE_JOIN, {
                conversationId: ac.conversationId,
                kind: (ac as any).kind || "audio",
              });
            }
            // LIVE token (tokenRef) here too — the closure `token` goes stale
            // after a mid-session rotation and these resyncs silently 401'd.
            api
              .getNotifications(tokenRef.current)
              .then((ns) => { if (!cancelled) setNotifications(ns || []); })
              .catch(() => { });
            api
              .getUnreadNotificationCount(tokenRef.current)
              .then((r) => {
                if (!cancelled) setNotifUnread((r && r.count) || 0);
              })
              .catch(() => { });
            if (typeof Notification !== "undefined" && Notification.permission === "granted") {
              import("../../../lib/pushRegistration").then((m) => m.registerPush(tokenRef.current!)).catch(() => { });
            }
          }
          hadConnection = true;
        });
        socket.on("disconnect", () => setConnected(false));
        // Surface handshake failures (CORS / auth / transport) instead of
        // failing silently — a silent failure is exactly what made realtime
        // "only update after a refresh". The socket keeps retrying (reconnection
        // is on); this just makes the problem visible and the state accurate.
        // Track repeated handshake failures so we surface ONE visible toast
        // (not a per-retry storm). socket.io reconnects automatically; if the
        // 4th attempt still fails the user has a real problem to debug.
        let connectErrCount = 0;
        socket.on("connect_error", (err: any) => {
          setConnected(false);
          const msg = (err && (err.message || err)) || "unknown";
          console.error("[socket] connect_error:", msg);
          connectErrCount += 1;
          if (connectErrCount === 4)
            showToast("Realtime connection problem: " + msg);
          // A REJECTED HANDSHAKE IS FATAL TO THE CLIENT — revive it ourselves.
          //
          // `reconnection: true` does NOT cover this case. When the server
          // rejects the handshake (realtime/socket.ts calls next(new Error(...))
          // for an expired/invalid token), socket.io-client 4.8.3 receives a
          // CONNECT_ERROR packet and calls destroy(), which drops every manager
          // subscription — its own comment reads "clean subscriptions to avoid
          // reconnections". `socket.active` is just `!!this.subs`, so it flips
          // false and the socket NEVER retries. Nothing else in this file calls
          // connect() again, so realtime stayed dead until a full page load —
          // which on the thin Electron shell means killing the app and
          // relaunching it. That is the reported "web to app sync" bug.
          //
          // The trigger is routine rather than exotic: AUTH_TOKEN_TTL is 7d
          // against a 30d session, and the socket's handshake auth is only
          // re-stamped when a REST call 401s. A desktop client left running for
          // a week (it closes to tray, backgroundThrottling is off) reliably
          // lands here.
          //
          // Re-stamp the LIVE token each attempt — tokenRef is refreshed by the
          // 401 recovery path, so a retry can succeed with a rotated token where
          // the destroyed socket's stale one could not.
          if (!socket.active && !cancelled) {
            if (reviveTimer) clearTimeout(reviveTimer);
            // Capped exponential backoff: 2s, 4s, 8s, 16s, then every 30s. An
            // uncapped retry against a genuinely revoked session would hammer
            // the backend for every idle client.
            const delay = Math.min(2000 * 2 ** (connectErrCount - 1), 30000);
            reviveTimer = setTimeout(() => {
              reviveTimer = null;
              if (cancelled || socket.active || socket.connected) return;
              (socket as any).auth = { token: tokenRef.current };
              socket.connect();
            }, delay);
          }
        });
        socket.on("connect", () => {
          connectErrCount = 0;
          if (reviveTimer) {
            clearTimeout(reviveTimer);
            reviveTimer = null;
          }
        });
        socket.on(EVENTS.READY, () => {
          // Rejoin whatever conversation is active now (not just the one that was
          // active at mount), so the room subscription is always correct.
          const aid = activeIdRef.current || (first && first.id);
          if (aid)
            socket.emit(EVENTS.CONVERSATION_JOIN, { conversationId: aid });
        });
        socket.on(EVENTS.MESSAGE_NEW, async (m) => {
          // Idempotency: drop a message id we've already handled (at-least-once
          // delivery + dual room/user-room fan-out could deliver the same one
          // twice; without this bumpPreview would double-count unread).
          const dedupId = m && m.id;
          if (dedupId) {
            if (seenMsgIdsRef.current.has(dedupId)) return;
            seenMsgIdsRef.current.add(dedupId);
            seenMsgOrderRef.current.push(dedupId);
            if (seenMsgOrderRef.current.length > 500) {
              const gone = seenMsgOrderRef.current.shift();
              if (gone) seenMsgIdsRef.current.delete(gone);
            }
          }
          const myId = meRef.current && meRef.current.id;
          const sid = m && m.sender && m.sender.id;
          const isMine = sid === myId;
          const fixed = sid ? { ...m, me: isMine, _status: "delivered" } : m;
          const [decrypted] = await decryptMessageList([fixed]);
          if (isMine) {
            setMessagesByConv((prev) => {
              const arr = prev[decrypted.conversationId];
              if (!arr) return prev;
              // Server-authored lines (call/system logs, meeting-invite cards)
              // are NOT echoes of an optimistic send (they just happen to be
              // authored by me) — append by id so they never clobber an
              // unrelated in-flight optimistic message.
              if (
                decrypted.type === "call" ||
                decrypted.type === "system" ||
                decrypted.type === "meeting_invite"
              ) {
                if (arr.some((x) => x.id === decrypted.id)) return prev;
                return {
                  ...prev,
                  [decrypted.conversationId]: [...arr, decrypted],
                };
              }
              // Match the EXACT optimistic bubble by the echoed clientId when the
              // server sent one back (#1: keeps a fast text echo from replacing a
              // slow in-flight file bubble). Fall back to "first pending optimistic"
              // for older servers / any echo without a clientId.
              const echoClientId = (m as any) && (m as any).clientId;
              const optIdx = echoClientId
                ? arr.findIndex((x) => x._clientId === echoClientId)
                : arr.findIndex(
                  (x) => x._clientId && x._status && x._status !== "delivered",
                );
              if (optIdx !== -1) {
                // The optimistic bubble still holds the PLAINTEXT this user just
                // typed. A sender must always be able to read their own message,
                // so persist that plaintext under the server's id (decrypt reads
                // this cache first) and, if the echo came back as the pending
                // placeholder, render the text we already have instead of it.
                // Previously the sender's copy depended solely on the per-device
                // self-envelope: when that was missing, their own messages showed
                // "Syncing…" forever, with nothing to sync from on a single device.
                const opt: any = arr[optIdx];
                let settled = decrypted;
                // FILE case first: the sender's own E2EE attachment can't be
                // decrypted from the echo (its self-envelope targets other devices),
                // so it would flip to "Not available on this device". Re-attach the
                // AES key we generated at send, and cache the {type,key,iv,caption}
                // envelope under the server id so it also survives a reload (the
                // cache-first decrypt runs it through applyFileEnvelope). This is the
                // attachment analogue of the typed-text rescue below.
                const sentEnv = echoClientId
                  ? sentFileEnvRef.current.get(echoClientId)
                  : undefined;
                if (sentEnv && decrypted && decrypted.id && decrypted.file) {
                  void rememberSentPlaintext(decrypted.id, sentEnv);
                  try {
                    const env = JSON.parse(sentEnv);
                    const mime =
                      decrypted.file.type || decrypted.file.mime || "application/octet-stream";
                    const echoCap =
                      typeof env.caption === "string" && env.caption.trim() !== ""
                        ? env.caption
                        : null;
                    settled = {
                      ...decrypted,
                      file: {
                        ...decrypted.file,
                        type: mime,
                        mime,
                        e2ee: true,
                        _e2eeKey: env.key,
                        _e2eeIv: env.iv,
                        // Chunked-video stream manifest (so the sender can also
                        // stream their own video after the echo swaps the bubble).
                        _e2eeStream: env.stream || decrypted.file._e2eeStream,
                        // Carry the poster + caption forward too.
                        thumb: env.thumb || decrypted.file.thumb,
                        // Dedicated caption field so the renderer keeps this attachment in
                        // ONE media bubble (matches applyFileEnvelope on the recipient side).
                        caption: echoCap,
                      },
                      text: echoCap,
                      encrypted: false,
                      ciphertext: null,
                    };
                  } catch (_) {
                    /* keep the decrypted echo as-is */
                  }
                  if (echoClientId) sentFileEnvRef.current.delete(echoClientId);
                } else {
                  // The optimistic bubble still holds the PLAINTEXT this user just
                  // typed. A sender must always be able to read their own message,
                  // so persist that plaintext under the server's id (decrypt reads
                  // this cache first) and, if the echo came back as the pending
                  // placeholder, render the text we already have instead of it.
                  const typed = opt && typeof opt.text === "string" ? opt.text : "";
                  if (typed && decrypted && decrypted.id) {
                    // NEVER cache a FILE's caption as its plaintext. A file's cache
                    // slot holds the {type,key,iv,caption} envelope (written by
                    // decryptMessageList) that the reload path needs to recover the
                    // decrypt key; overwriting it with the bare caption strips the
                    // key and locks the file as "Not available on this device" on
                    // reload. Text messages still get the plaintext rescue.
                    if (!decrypted.file) void rememberSentPlaintext(decrypted.id, typed);
                    if (decrypted.text === E2EE_PENDING_TEXT)
                      settled = { ...decrypted, text: typed, encrypted: false, ciphertext: null };
                  }
                }
                const updated = arr.slice();
                updated[optIdx] = settled;
                return { ...prev, [decrypted.conversationId]: updated };
              }
              if (arr.some((x) => x.id === decrypted.id)) return prev;
              return {
                ...prev,
                [decrypted.conversationId]: [...arr, decrypted],
              };
            });
          } else {
            appendIfLoaded(decrypted);
          }
          bumpPreview(decrypted);
          maybeNotify(decrypted);
          const cid = decrypted && decrypted.conversationId;
          if (cid) {
            const isViewing =
              (activeIdRef.current === cid &&
                modeRef.current === "chats" &&
                mobilePaneRef.current !== "list") ||
              (commsOpenRef.current && commsConvIdRef.current === cid);
            if (isViewing && !isMine && tokenRef.current && !offlineDemo) {
              api
                .setRead(
                  tokenRef.current,
                  cid,
                  true,
                  settingsRef.current?.readReceipts !== false,
                )
                .catch(() => { });
            }
          }
          if (cid && !conversationsRef.current.some((c) => c.id === cid)) {
            await refetchConversations();
            // Brand-new conversation: the refetched row's server-side preview is
            // EMPTY for E2EE (the server can't decrypt), and it would show
            // "No messages yet" until the 2nd message. We already decrypted THIS
            // message, so write the preview from it directly — no dependence on
            // the lastMessageEnc round-trip. Preview only (unread came from the
            // refetch); skip an undecryptable placeholder.
            const t = decrypted && decrypted.text;
            // Same fix as the preview guard above: the bracket test misses the
            // current placeholder copy, so an undecryptable message both
            // clobbered the preview AND raised a desktop notification whose body
            // read "Syncing…".
            const ph =
              decrypted &&
              decrypted.encrypted === false &&
              typeof t === "string" &&
              (t.startsWith("[") || t === E2EE_PENDING_TEXT);
            if (t && !ph)
              setConversations((prev) =>
                prev.map((c) => {
                  if (c.id !== cid) return c;
                  // Monotonicity: if two messages raced the awaited refetch, don't
                  // let an older one clobber a newer preview or move lastMessageAt
                  // backwards. (Server refetch is authoritative for unread/order.)
                  if (
                    c.lastMessageAt &&
                    decrypted.createdAt &&
                    Date.parse(decrypted.createdAt) < Date.parse(c.lastMessageAt)
                  )
                    return c;
                  return {
                    ...c,
                    preview:
                      (decrypted.me &&
                        decrypted.type !== "call" &&
                        decrypted.type !== "system"
                        ? "You: "
                        : "") +
                      (decrypted.type === "sticker"
                        ? "🖼️ Sticker"
                        : decrypted.type === "gif"
                          ? "🎞️ GIF"
                          : decrypted.file
                            ? "📎 " + (decrypted.file.name || "File")
                            : htmlPreview(t)),
                    previewHtml:
                      decrypted.file || decrypted.type === "voice" ? null : t,
                    lastMessageAt: decrypted.createdAt || c.lastMessageAt,
                    unread: 0,
                  };
                }),
              );
          }
        });
        socket.on(EVENTS.MESSAGE_UPDATED, async (m) => {
          const [decrypted] = await decryptMessageList([m]);
          // A MESSAGE_UPDATED broadcast (edit / react / delete) is serialized
          // ONCE, relative to the ACTOR — so its viewer-relative fields carry the
          // ACTOR's perspective: `me` (own-vs-received side) and each reaction's
          // `mine` are the editor/reactor's, and `bookmarked` is always false
          // (the update serializer has no bookmark set). Applied verbatim, this
          // flips a recipient's OWN message to the wrong side and mis-marks
          // reactions on every edit/react/delete. Recompute for THIS viewer
          // before replacing — mirrors the MESSAGE_NEW `me` recompute above.
          const myId = meRef.current && meRef.current.id;
          const sid = decrypted && decrypted.sender && decrypted.sender.id;
          const fixed = {
            ...decrypted,
            me: sid ? sid === myId : decrypted.me,
            reactions: Array.isArray(decrypted.reactions)
              ? decrypted.reactions.map((r: any) => ({
                ...r,
                mine:
                  Array.isArray(r.reactors) &&
                  r.reactors.some((x: any) => x && x.id === myId),
              }))
              : decrypted.reactions,
          };
          // Preserve the viewer's own bookmark (the broadcast always carries
          // false; bookmarks are personal and not changed by edit/react/delete).
          setMessagesByConv((prev) => {
            if (!prev[fixed.conversationId]) return prev;
            const arr = prev[fixed.conversationId].map((x: any) => {
              if (x.id !== fixed.id) return x;
              // A react / pin / read update re-sends the SAME ciphertext. If it
              // failed to decrypt here (transient key miss) while the bubble
              // already shows the real text, keep that text — never let a
              // metadata update turn a readable message into the pending row.
              // A first EDIT (edited flips) still takes the new result.
              const keepText =
                fixed._pendingRecovery === true &&
                x._pendingRecovery !== true &&
                typeof x.text === "string" &&
                x.text.trim() !== "" &&
                x.text !== E2EE_PENDING_TEXT &&
                !!fixed.edited === !!x.edited;
              return keepText
                ? { ...fixed, text: x.text, file: x.file, _pendingRecovery: undefined, bookmarked: x.bookmarked }
                : { ...fixed, bookmarked: x.bookmarked };
            });
            return { ...prev, [fixed.conversationId]: arr };
          });
        });
        // Read receipt from the peer (or an echo from another of our own devices):
        // advance the per-conversation read pointer so sent messages flip from
        // ✓✓ "Delivered" to ✓✓ "Read" (accent color) live.
        socket.on(EVENTS.MESSAGE_READ, ({ conversationId, userId, lastReadAt }) =>
          setReadState((p) => ({
            ...p,
            [conversationId]: {
              ...(p[conversationId] || {}),
              [userId]: Date.parse(lastReadAt) || Date.now(),
            },
          })),
        );
        // Cross-device unread sync: THIS user read / marked-unread a conversation
        // on another session. Update its unread here so totalUnread → the web
        // title + desktop taskbar badge refresh live (no wait for a focus refetch).
        socket.on(EVENTS.CONVERSATION_READ, ({ conversationId, unread }) => {
          const isViewing =
            (activeIdRef.current === conversationId &&
              modeRef.current === "chats" &&
              mobilePaneRef.current !== "list") ||
            (commsOpenRef.current && commsConvIdRef.current === conversationId);
          setConversations((prev) =>
            prev.map((c) =>
              c.id === conversationId
                ? { ...c, unread: isViewing ? 0 : (unread ?? 0) }
                : c,
            ),
          );
        });
        socket.on(EVENTS.MESSAGE_REPLY, async (m) => {
          const myId = meRef.current && meRef.current.id;
          const sid = m && m.sender && m.sender.id;
          const isMine = sid === myId;
          const fixed = sid ? { ...m, me: isMine } : m;
          const [decrypted] = await decryptMessageList([fixed]);
          appendIfLoaded(decrypted);
          bumpPreview(decrypted);
          const cid = decrypted && decrypted.conversationId;
          if (cid) {
            const isViewing =
              (activeIdRef.current === cid &&
                modeRef.current === "chats" &&
                mobilePaneRef.current !== "list") ||
              (commsOpenRef.current && commsConvIdRef.current === cid);
            if (isViewing && !isMine && tokenRef.current && !offlineDemo) {
              api
                .setRead(
                  tokenRef.current,
                  cid,
                  true,
                  settingsRef.current?.readReceipts !== false,
                )
                .catch(() => { });
            }
          }
        });
        socket.on(EVENTS.MESSAGE_DELETED, ({ id, conversationId }) =>
          removeMessage(conversationId, id),
        );
        socket.on(EVENTS.CONVERSATION_NEW, (p: any) => {
          // Join the brand-new conversation's room so its SUBSEQUENT messages
          // arrive live — the connect-time join-all only covered conversations
          // that existed then. Payload is either { conversationId } or a full
          // conversation object with { id }; handle both.
          const cid = p && (p.conversationId || p.id);
          if (cid)
            socket.emit(EVENTS.CONVERSATION_JOIN, { conversationId: cid });
          refetchConversations();
        });
        socket.on(EVENTS.CONVERSATION_UPDATED, (conv: any) => {
          // Group/channel name/description/avatar changed — merge it in live.
          if (!conv || !conv.id) return;
          const isViewing =
            (activeIdRef.current === conv.id &&
              modeRef.current === "chats" &&
              mobilePaneRef.current !== "list") ||
            (commsOpenRef.current && commsConvIdRef.current === conv.id);
          setConversations((prev) =>
            prev.map((c) => {
              if (c.id !== conv.id) return c;
              const merged = { ...c, ...conv };
              if (isViewing) merged.unread = 0;
              return merged;
            }),
          );
        });
        socket.on(EVENTS.CONVERSATION_DELETED, ({ conversationId }) => {
          setConversations((prev) =>
            prev.filter((c) => c.id !== conversationId),
          );
          setActiveId((cur) => (cur === conversationId ? null : cur));
        });
        // A person changed their avatar/name/about — reflect it everywhere live:
        // the directory (pickers/members/mentions), DM rows, and message rows.
        socket.on(EVENTS.USER_UPDATED, (u: any) => {
          if (!u || !u.id) return;
          const myId = meRef.current && meRef.current.id;
          setUsers((prev: any[]) => {
            if (!Array.isArray(prev)) return prev;
            const i = prev.findIndex((x) => x && x.id === u.id);
            if (i === -1) return [...prev, u];
            const next = prev.slice();
            next[i] = { ...next[i], ...u };
            return next;
          });
          if (myId === u.id) setMe((m: any) => ({ ...(m || {}), ...u }));
          // Patch the peer avatar/name on any DM with this person.
          setConversations((prev: any[]) =>
            prev.map((c) => {
              if (
                c &&
                c.kind === "dm" &&
                u.id !== myId &&
                Array.isArray(c.members) &&
                c.members.includes(u.id)
              ) {
                return {
                  ...c,
                  title: u.name || c.title,
                  avatar: {
                    ...(c.avatar || {}),
                    avatarUrl: u.avatarUrl,
                    initials: c.avatar && c.avatar.initials,
                  },
                };
              }
              return c;
            }),
          );
          // Patch sender avatar/name on already-loaded messages from this person.
          setMessagesByConv((prev: any) => {
            let changed = false;
            const out: any = {};
            for (const k of Object.keys(prev || {})) {
              const arr = prev[k];
              let touched = false;
              const narr = (arr || []).map((m: any) => {
                if (m && m.sender && m.sender.id === u.id) {
                  touched = true;
                  return {
                    ...m,
                    sender: {
                      ...m.sender,
                      avatarUrl: u.avatarUrl,
                      name: u.name || m.sender.name,
                    },
                  };
                }
                return m;
              });
              out[k] = touched ? ((changed = true), narr) : arr;
            }
            return changed ? out : prev;
          });
        });
        socket.on(EVENTS.MEETING_NEW, () => refetchMeetings());
        socket.on(EVENTS.MEETING_UPDATED, () => refetchMeetings());
        socket.on(EVENTS.SCHEDULED_CHANGED, ({ conversationId }) => {
          if (conversationId) loadScheduled(conversationId);
        });
        socket.on(EVENTS.CALL_NEW, () => refetchCalls());
        socket.on(EVENTS.TASK_CHANGED, () => {
          refetchTasks();
          setTaskTick((n) => n + 1);
        });
        socket.on(EVENTS.REMINDER_CHANGED, () => refetchReminders());
        // A file was shared with / updated for this user → refresh the files
        // list live (the accompanying NOTIFICATION_NEW shows the toast + badge).
        socket.on(EVENTS.FILE_CHANGED, () => {
          if (refetchFilesRef.current) refetchFilesRef.current();
          // Also nudge the recycle bin (its trash list is client-owned in
          // FilesView and isn't touched by the live-list refetch above).
          setFileChangeTick((n) => n + 1);
        });
        // Server rejected a send (e.g. BLOCKED). Drop the optimistic message so
        // it doesn't sit there looking delivered, and surface why.
        socket.on("message:send_failed", (p: any) => {
          const convId = p && p.conversationId;
          if (convId) {
            setMessagesByConv((prev) => {
              const list = prev[convId];
              if (!Array.isArray(list)) return prev;
              // Remove the most recent still-pending (optimistic) outgoing message.
              const idx = [...list]
                .reverse()
                .findIndex(
                  (m: any) =>
                    m &&
                    m.me &&
                    (m._status === "sending" ||
                      /^(?:tmp|_opt)/.test(String(m.id || ""))),
                );
              if (idx === -1) return prev;
              const realIdx = list.length - 1 - idx;
              return {
                ...prev,
                [convId]: list.filter((_: any, i: number) => i !== realIdx),
              };
            });
          }
          showToast((p && p.message) || "Message couldn't be sent.");
        });
        // Server dropped a send because we're over the per-socket rate limit — it
        // was NEVER delivered, so mark the optimistic bubble FAILED (retryable)
        // instead of leaving it looking sent, and tell the user to slow down.
        socket.on("message:rate_limited", (p: any) => {
          const convId = (p && p.conversationId) || activeIdRef.current;
          if (convId) {
            setMessagesByConv((prev) => {
              const list = prev[convId];
              if (!Array.isArray(list)) return prev;
              const idx = [...list]
                .reverse()
                .findIndex(
                  (m: any) =>
                    m &&
                    m.me &&
                    (m._status === "sending" ||
                      /^(?:tmp|_opt)/.test(String(m.id || ""))),
                );
              if (idx === -1) return prev;
              const realIdx = list.length - 1 - idx;
              const next = list.slice();
              next[realIdx] = { ...next[realIdx], _status: "failed" };
              return { ...prev, [convId]: next };
            });
          }
          showToast(
            "You're sending messages too fast — try again in a moment.",
          );
        });
        socket.on(EVENTS.INVITE_NEW, (p) => {
          const name = p && p.invite && p.invite.from && p.invite.from.name;
          // P0-11: no interruption toasts over a live presentation.
          if (!presentationDndActive())
            showToast(
              name
                ? `${name} sent you a connection request`
                : "New connection request",
            );
          refetchInvites();
          const gate = notifGateContext();
          const payload: NotifPayload = { type: "invite", title: name ? `${name} sent you a connection request` : "New connection request", body: "Open Collab to accept or decline.", targetId: p.invite?.id, targetType: "invite" };
          if (!shouldPush(gate, payload)) return;
          const tag = tagFor("invite", p.invite?.id);
          fireNotif(tag, payload.title, payload.body, () => { setMode("contacts"); }, () => { }, payload);
        });
        socket.on(EVENTS.INVITE_UPDATED, (p) => {
          const inv = p && p.invite;
          // "X accepted your request" must reach ONLY the original SENDER. This event
          // fires for BOTH parties (UI sync), so gate on direction: the accepter's
          // view is "incoming" — they just clicked Accept and must NOT be notified
          // about accepting their own request (that was the both-users-notified bug).
          if (inv && inv.status === "accepted" && inv.direction === "outgoing") {
            const name = inv.to && inv.to.name ? inv.to.name : "Your invite";
            // P0-11: no interruption toasts over a live presentation.
            if (!presentationDndActive())
              showToast(`${name} accepted your request`);
            const gate = notifGateContext();
            // type "invite_accepted" (not "invite") so the service worker doesn't
            // attach Accept/Decline actions to an already-accepted request.
            const payload: NotifPayload = { type: "invite_accepted", title: `${name} accepted your request`, body: "You are now connected on CoLab." };
            if (shouldPush(gate, payload)) {
              const tag = tagFor("invite-accept", inv.id);
              fireNotif(tag, payload.title, payload.body, () => { setMode("contacts"); }, () => { }, payload);
            }
          }
          refetchInvites();
          // Teams-model pending DM: on accept the pending flag clears (banner goes,
          // attachments unlock); on decline/cancel/block the pending DM is torn down
          // — refetch so the sender's sidebar + open composer reflect it live.
          refetchConversations();
        });
        // ── Device handoff (P0-12) ────────────────────────────────────────
        // OFFER arrives on the TARGET device (session-scoped emit): show the
        // continue-here prompt. CONFIRMED arrives back on the SOURCE: for a
        // "move", drop the media HERE quietly — no hangup/end signal, the call
        // or meeting itself keeps running (the other device carries it now).
        socket.on(EVENTS.HANDOFF_OFFER, (p: any) => {
          if (p) setHandoffOffer(p);
        });
        socket.on(EVENTS.HANDOFF_CONFIRMED, (p: any) => {
          if (!p || p.mode !== "move") {
            showToast("Your other device joined too.");
            return;
          }
          showToast("Moved to your other device.");
          // Unmount = graceful LiveKit disconnect via the surfaces' own
          // teardown. App-level call/meeting state is untouched server-side.
          setActiveCall(null);
          setRoomState(null);
        });
        socket.on(EVENTS.HANDOFF_DECLINED, () => {
          showToast("Your other device declined.");
        });
        // Live session enforcement (Phase 3): this device's session was revoked
        // elsewhere — self "sign out this device", "sign out other sessions",
        // admin force-logout, or eviction when another device hit the limit. The
        // server closes our socket right after; clear the token and return to
        // sign-in with a clear reason (doLogout nulls the token synchronously, so
        // the follow-on 401 → colab:unauthorized is ignored — no double toast).
        socket.on(EVENTS.SESSION_REVOKED, (p: any) => {
          if (!tokenRef.current) return; // already signed out
          showToast(
            p && p.reason === "logout"
              ? "You were signed out."
              : "You were signed out of this device.",
          );
          doLogout();
        });
        // TOTAL ACCESS CLEANUP: this account's membership in an org just ended
        // (removed by an admin, or left from another device). Probe a gated
        // endpoint: if OUR session is on that org it 403s ORG_MEMBERSHIP_INVALID,
        // the api layer dispatches colab:org-invalid, and the existing recovery
        // switches to a remaining org or signs out — so a device idling on the
        // removed org is evicted immediately, not on its next user action. A
        // session on a DIFFERENT org probes clean and nothing happens.
        socket.on(EVENTS.ORG_MEMBERSHIP_REVOKED, () => {
          if (!tokenRef.current) return;
          api.me(tokenRef.current).catch(() => { });
        });
        // E2EE live sync choreography — kills "[Encrypted — waiting to sync]"
        // walls in real time instead of waiting for somebody's next page load:
        //  • a NEW device of mine was approved → push it a history bundle NOW;
        //  • a bundle for THIS device landed on the relay → restore it NOW
        //    (restore fires onHistoryRestored → caches drop → threads refetch);
        //  • a sibling device asked for specific conversations → push targeted
        //    history for exactly those.
        socket.on(EVENTS.E2EE_DEVICE_APPROVED, (p: any) => {
          void onPeerDeviceApproved(String(p?.deviceId || ""));
        });
        socket.on(EVENTS.E2EE_SYNC_READY, (p: any) => {
          void onSyncReady(String(p?.targetDeviceId || ""));
        });
        socket.on(EVENTS.E2EE_SYNC_REQUESTED, (p: any) => {
          void onSyncRequested(String(p?.requesterDeviceId || ""), p?.conversationIds || []);
        });
        // Sender re-delivery — SENDER side. A member's device cannot open one of
        // OUR messages; seal it to that device again from our plaintext copy.
        // Same anti-harvest guard as the epoch re-key below: only for a user our
        // own cached roster lists as a member of that conversation.
        socket.on(EVENTS.E2EE_REDELIVER_REQUEST, (p: any) => {
          const mids: string[] = Array.isArray(p && p.messageIds)
            ? p.messageIds.filter((x: any) => typeof x === "string" && x)
            : p && p.messageId ? [String(p.messageId)] : [];
          const cid = p && p.conversationId;
          const uid = p && p.userId;
          const did = p && p.deviceId;
          if (!mids.length || !cid || !uid || !did || !tokenRef.current) return;
          if (uid === meRef.current?.id && String(did) === String(myDeviceId || "")) return;
          const conv = conversationsRef.current.find((c: any) => c.id === cid);
          const isMember =
            !!conv &&
            (Array.isArray(conv.members)
              ? conv.members.some((m: any) => (typeof m === "string" ? m : m && m.id) === uid)
              : false);
          if (!isMember) return;
          void redeliverMany(
            tokenRef.current,
            mids.slice(0, 500).map((mid) => ({
              messageId: String(mid),
              conversationId: String(cid),
              requesterUserId: String(uid),
              requesterDeviceId: String(did),
            })),
          ).catch(() => { });
        });
        // Sender re-delivery — REQUESTER side: a fresh envelope for this device
        // is on the row; refetch the thread so it decrypts.
        socket.on(EVENTS.E2EE_REDELIVERED, (p: any) => {
          onRedelivered(String(p?.conversationId || ""), String(p?.messageId || ""));
        });
        // Epoch-key backfill — MEMBER side. A co-member can't decrypt this group
        // (keyGone) and asked its members to re-wrap the epoch key to it. If I hold
        // the key, re-seal it to their device.
        socket.on(EVENTS.E2EE_EPOCH_REKEY_REQUEST, (p: any) => {
          const cid = p && p.conversationId;
          const uid = p && p.userId;
          const did = p && p.deviceId;
          if (!cid || !uid || !did || !tokenRef.current) return;
          if (uid === meRef.current?.id && String(did) === String(myDeviceId || "")) return;
          // DEFENCE-IN-DEPTH against an untrusted SERVER (the only party that emits
          // this event): only re-wrap the group epoch to a device belonging to a
          // user we INDEPENDENTLY know is a member of this conversation. Without
          // this, a malicious server could name any user with a published bundle
          // and harvest the epoch key to an attacker device on demand. We trust our
          // own member list, not the socket payload.
          const conv = conversationsRef.current.find((c: any) => c.id === cid);
          if (conv && Array.isArray(conv.members) && conv.members.includes(uid)) {
            void rewrapEpochsForDevice(tokenRef.current, String(cid), String(uid), String(did));
          } else {
            // The requester isn't in our CACHED member list. That list can be stale (a
            // just-added member — exactly who'd be missing their epoch key — is the
            // common case). Before refusing (the anti-harvest guard), REFRESH THE VISIBLE
            // ROSTER once per (conversation, requester) per session and re-check against
            // it. Critically we re-check the SAME server-fed conversation list that drives
            // the participant UI, and COMMIT it to state — not a discarded side fetch:
            // key-granting therefore stays coupled to user-visible membership, so a server
            // that lies to slip a device onto the key must also show that device in
            // everyone's roster (detectable). rekeyRecheckRef bounds this to one refetch
            // per (conversation, requester) so a spoofed request can't drive repeated
            // fetches; a transient failure clears the marker so a genuine member isn't
            // blocked for the whole session.
            const rk = String(cid) + "|" + String(uid);
            if (rekeyRecheckRef.current.has(rk)) return;
            rekeyRecheckRef.current.add(rk);
            void (async () => {
              try {
                const convs = await api.getConversations(tokenRef.current!);
                setConversations(convs);
                const fresh = (Array.isArray(convs) ? convs : []).find(
                  (c: any) => c.id === cid,
                );
                if (
                  fresh &&
                  Array.isArray(fresh.members) &&
                  fresh.members.includes(uid)
                ) {
                  await rewrapEpochsForDevice(
                    tokenRef.current!,
                    String(cid),
                    String(uid),
                    String(did),
                  );
                }
                // A confirmed non-member keeps rk set (the anti-harvest bound holds).
              } catch (_) {
                // Transient failure (network blip / token race): DON'T poison rk — let a
                // later request retry so a genuinely-added member isn't blocked for the
                // whole session. The up-front add still de-dupes concurrent in-flight
                // requests, and nothing is relayed on failure so no storm results.
                rekeyRecheckRef.current.delete(rk);
              }
            })();
          }
        });
        // Epoch-key backfill — REQUESTER side. New conversation keys landed for me;
        // drop the stale epoch cache and re-decrypt the open thread. DEBOUNCED: in a
        // large group EVERY online member answers with its own KEYS_UPDATED, so a
        // single request would otherwise re-fetch + re-decrypt the whole thread N
        // times. Clear the cache immediately (cheap) but coalesce the re-decrypt
        // onto one trailing timer per conversation, and skip it if the epoch now
        // resolves from cache (already healed).
        socket.on(EVENTS.E2EE_KEYS_UPDATED, (p: any) => {
          const cid = p && p.conversationId;
          if (!cid) return;
          onConversationKeysUpdated(String(cid));
          if (activeIdRef.current !== cid || !tokenRef.current) {
            // NON-active conversation just received a re-wrapped epoch key. ONLY if its
            // cached thread actually has unresolved recovery-pending rows, evict the
            // cache + status so it re-fetches and decrypts fresh with the new key on
            // next open (the open loaders short-circuit on a present 'loaded' entry, so
            // stale pending rows would otherwise persist until a reload). A fully-
            // healthy cached thread is left untouched — no needless drop/re-decrypt/
            // flicker. The active conversation is handled by the debounced re-decrypt
            // below.
            const scid = String(cid);
            const cachedMsgs = messagesByConvRef.current?.[scid];
            const hasPending =
              Array.isArray(cachedMsgs) &&
              cachedMsgs.some((m: any) => m && m._pendingRecovery === true);
            if (!hasPending) return;
            setMessagesByConv((prev) => {
              if (!(scid in prev)) return prev;
              const n = { ...prev };
              delete n[scid];
              return n;
            });
            setMsgLoadStatus((s) => {
              if (!(scid in s)) return s;
              const n = { ...s };
              delete n[scid];
              return n;
            });
            return;
          }
          const existing = keysUpdatedTimersRef.current.get(String(cid));
          if (existing) clearTimeout(existing);
          const t = setTimeout(() => {
            keysUpdatedTimersRef.current.delete(String(cid));
            if (activeIdRef.current !== cid || !tokenRef.current) return;
            api
              .getMessages(tokenRef.current, String(cid))
              .then(decryptMessageList)
              .then((msgs) => {
                setMessagesByConv((prev) => ({ ...prev, [cid]: msgs }));
                setMsgLoadStatus((s) => ({ ...s, [cid]: "loaded" }));
              })
              .catch(() => { });
          }, 900);
          keysUpdatedTimersRef.current.set(String(cid), t);
        });
        // Meeting duplicate-device prompt (Phase 3c): we just joined a meeting
        // we're already in on another device. Prompt once per meeting entry —
        // dupHandledRef swallows the reconnect re-emits of MEETING_JOIN.
        socket.on(EVENTS.MEETING_DUPLICATE, (p: any) => {
          const mid = p && p.meetingId;
          if (!mid || dupHandledRef.current.has(mid)) return;
          // Only prompt if we're actually in (or entering) THIS meeting.
          const cur = roomStateRef.current;
          if (!cur || !cur.meeting || cur.meeting.id !== mid) return;
          setMeetingDup({ meetingId: mid, devices: p.devices || [] });
        });
        // The other device took over (or we chose to move it there) — leave here.
        socket.on(EVENTS.MEETING_LEAVE_NOW, (p: any) => {
          const mid = p && p.meetingId;
          const cur = roomStateRef.current;
          if (!mid || !cur || !cur.meeting || cur.meeting.id !== mid) return;
          setMeetingDup(null);
          showToast("This meeting moved to your other device.");
          onLeaveRoomRef.current();
        });
        socket.on(EVENTS.NOTIFICATION_NEW, (n: any) => {
          if (n) {
            setNotifications((prev) =>
              n.id && prev.some((x) => x.id === n.id) ? prev : [n, ...prev],
            );
            setNotifUnread((c) => c + 1);
            // ISSUE #18: org-scoped notifications (join-requests etc.) refresh the
            // OrgSwitcher pending-count badge live.
            if (n.targetType === "org" || String(n.type || "").startsWith("org"))
              window.dispatchEvent(new Event("colab:org-notif"));
            // AUDIT P1: honor per-conversation MUTE for interruptive alerts. Reactions,
            // replies and other conversation-scoped notifications for a MUTED chat must
            // not toast / sound / OS-notify (they were previously unconditional, unlike
            // the plain-message path which already respects mute). The notification is
            // still stored + counted above, so nothing is lost from Activity. A DIRECT
            // @mention is the deliberate exception — Slack/Teams still let it through a
            // muted conversation.
            const mutedConv = !!(
              n.conversationId &&
              conversationsRef.current.some(
                (c: any) => c.id === n.conversationId && c.muted,
              )
            );
            const interruptAllowed = !mutedConv || n.type === "mention";
            // P0-11: the notification is stored + counted (nothing is lost;
            // it's all in Activity afterwards) — just no toast while presenting.
            if (interruptAllowed && !presentationDndActive())
              showToast(n.title || "New notification");
            const gate = notifGateContext();
            const payload: NotifPayload = {
              type: n.type || "",
              id: n.id,
              title: n.title || "New notification",
              body: n.body,
              conversationId: n.conversationId,
              senderId: n.actorId || n.senderId,
              targetType: n.targetType,
              targetId: n.targetId,
            };
            if (!interruptAllowed) return; // muted conversation → no push/sound/OS
            if (!shouldPush(gate, payload, { checkNotifyCalls: n.type === "call_missed" })) return;
            const tag = tagFor(n.type || "notif", n.id);
            fireNotif(tag, payload.title, payload.body, () => {
              // A file-share notification (targetType "file") opens the Files
              // module focused on the file — checked BEFORE conversationId because
              // the notification may also carry the upload's conversationId, which
              // would otherwise misroute it to chats (the old dead-end).
              if (n.targetType === "file" && n.targetId) {
                setMode("files");
                setOpenFileId(n.targetId);
              } else if (n.conversationId) {
                onSelect(n.conversationId);
                setMode("chats");
                if (n.targetType === "message" && n.targetId) setJumpMsgId(n.targetId);
              } else if (n.targetType === "meeting" && n.targetId) {
                setMode("calendar");
              } else if (n.targetType === "reminder") {
                setMode("reminders");
                if (n.targetId) setFocusReminderId(n.targetId);
              } else if (n.targetType === "task") {
                setMode("tasks");
                if (n.targetId) setOpenTaskId(n.targetId);
              } else if (n.type === "call_missed") {
                setMode("chats");
              } else if (
                n.targetType === "session" ||
                (n.type && String(n.type).startsWith("security"))
              ) {
                // New/suspicious sign-in alert → open Settings to review devices.
                setMode("settings");
              } else if (
                n.targetType === "org" ||
                (n.type && String(n.type).startsWith("org"))
              ) {
                // BA #6: route to the page the notification is ABOUT. A broadcast
                // opens the Organization module on Broadcasts (where the full
                // announcement and its history live); an incoming join request
                // opens Join requests so an admin can act on it immediately.
                // Personal org news (role change, you were added/removed, your
                // request was decided) stays in Activity — there is no org page
                // for it, and Activity is where the full notification lives.
                const t = String(n.type || "");
                if (t === "org_broadcast") {
                  setOrgTab("broadcasts");
                  setMode("org");
                } else if (t === "org_join_request") {
                  setOrgTab("requests");
                  setMode("org");
                } else {
                  setMode("activity");
                }
              }
            }, () => {
              const sx = gate.settings;
              if (sx && sx.notifSound === false) return;
              try {
                const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
                if (!Ctx) return;
                const ac = new Ctx();
                try { if (ac.state === "suspended" && ac.resume) ac.resume(); } catch (_) { }
                const totalDur = playPattern(ac, MESSAGE_TONE, 0.1);
                setTimeout(() => { try { ac.close(); } catch (_) { } }, (totalDur + 0.5) * 1000);
              } catch (_) { }
            }, payload);
          }
        });
        // The server pushes the authoritative unread count whenever it changes
        // (e.g. notifications read/cleared on another device). Trust it so the
        // Activity badge always reflects reality without a reload.
        socket.on(EVENTS.NOTIFICATION_COUNT, (p) => {
          const c =
            typeof p === "number"
              ? p
              : p && typeof p.count === "number"
                ? p.count
                : null;
          if (c != null) setNotifUnread(Math.max(0, c));
        });
        // A notification (or all of them) was marked read elsewhere — sync the
        // list item state and the badge live. NOTIFICATION_COUNT (above) is the
        // authoritative correction if a payload ever drifts.
        socket.on(EVENTS.NOTIFICATION_READ, (p) => {
          if (p && p.all) {
            setNotifications((prev) =>
              prev.map((n) => ({ ...n, isRead: true })),
            );
            setNotifUnread(0);
            return;
          }
          const ids = !p
            ? []
            : Array.isArray(p.ids)
              ? p.ids
              : p.notificationId != null
                ? [p.notificationId]
                : p.id != null
                  ? [p.id]
                  : [];
          if (!ids.length) return;
          setNotifications((prev) =>
            prev.map((n) => (ids.includes(n.id) ? { ...n, isRead: true } : n)),
          );
          setNotifUnread((c) => Math.max(0, c - ids.length));
        });
        socket.on(EVENTS.PRESENCE_UPDATE, ({ userId, presence, lastSeen }) =>
          setConversations((prev) =>
            prev.map((c) =>
              c && c.kind === "dm" && (c.members || []).includes(userId)
                ? { ...c, presence, ...(lastSeen ? { lastSeen } : {}) }
                : c,
            ),
          ),
        );
        socket.on(EVENTS.TYPING, ({ conversationId, userId, typing }) => {
          setTypingBy((prev) => ({
            ...prev,
            [conversationId]: typing ? userId : null,
          }));
          const timers = typingTimersRef.current;
          if (timers[conversationId]) clearTimeout(timers[conversationId]);
          if (typing) {
            timers[conversationId] = setTimeout(() => {
              setTypingBy((prev) =>
                prev[conversationId]
                  ? { ...prev, [conversationId]: null }
                  : prev,
              );
              delete timers[conversationId];
            }, 6000);
          } else {
            delete timers[conversationId];
          }
        });
      } catch (e) {
        // Logged in but a fetch failed; sections stay empty rather than faking data.
      }
    })();
    return () => {
      cancelled = true;
      if (reviveTimer) clearTimeout(reviveTimer);
      if (socketRef.current) socketRef.current.close();
      if (typeof navigator !== "undefined" && "serviceWorker" in navigator)
        navigator.serviceWorker.removeEventListener("message", swHandler);
    };
  }, [
    authed,
    offlineDemo,
    appendMessage,
    appendIfLoaded,
    bumpPreview,
    maybeNotify,
    refetchConversations,
    decryptConvPreviews,
    refetchMeetings,
    refetchCalls,
    refetchTasks,
    refetchReminders,
    refetchInvites,
    replaceMessage,
    removeMessage,
    applySettings,
    showToast,
  ]);
  const loadScheduled = useCallback(
    (id) => {
      if (!id || offlineDemo || !tokenRef.current) return;
      api
        .listScheduled(tokenRef.current, id)
        .then((rows) => setScheduledByConv((p) => ({ ...p, [id]: rows })))
        .catch(() => { });
    },
    [offlineDemo],
  );
  const onLeaveRoom = useCallback(async (meta?: any) => {
    const id = roomState && roomState.meeting ? roomState.meeting.id : null;
    setRoomState(null);
    // Phase 3c: leaving the meeting resets its duplicate-prompt state so a later
    // re-join can prompt again, and dismisses any open prompt for it.
    if (id) dupHandledRef.current.delete(id);
    setMeetingDup((d: any) => (d && d.meetingId === id ? null : d));
    // Post-call feedback (#67): MeetingStage passes leave metadata (duration,
    // netQuality, connected). A leave WITHOUT meta (defensive / programmatic
    // teardown) is treated as not-user-initiated and is skipped by the gate.
    if (meta)
      maybeShowFeedbackRef.current({
        kind: "meeting",
        meetingId: meta.meetingId || id || null,
        durationSec: meta.durationSec || 0,
        netQuality: meta.netQuality,
        connected: !!meta.connected,
      });
    if (id && !offlineDemo && tokenRef.current) {
      try {
        await api.leaveMeetingRoom(tokenRef.current, id);
      } catch {
        /* best-effort */
      }
      refetchMeetings();
    }
    // Returning from the meeting overlay: re-pull the open conversation's messages
    // from the server so a meeting-invite card (or call/system log) posted while we
    // were in the meeting is restored from its persisted copy — fixes the reported
    // "invite disappears from the DM after join/leave" (client view going stale).
    const aid = activeIdRef.current;
    if (aid && !offlineDemo && tokenRef.current) {
      api
        .getMessages(tokenRef.current, aid)
        .then(decryptMessageList)
        .then((msgs) =>
          setMessagesByConv((p) => ({ ...p, [aid]: msgs })),
        )
        .catch(() => { });
    }
  }, [roomState, offlineDemo, refetchMeetings]);
  const onLeaveRoomRef = useRef(onLeaveRoom);
  const FEEDBACK_MIN_SEC = 60;
  const FEEDBACK_THROTTLE_MS = 24 * 60 * 60 * 1000;
  const FEEDBACK_LS_KEY = "colab_feedback_last_shown";
  const maybeShowFeedback = useCallback(
    (arg: {
      kind: "call" | "meeting";
      callId?: string | null;
      meetingId?: string | null;
      durationSec?: number;
      netQuality?: string | null;
      connected?: boolean;
    }) => {
      try {
        // Throttle is PER-TYPE (call vs meeting): seeing the dialog after a meeting
        // must NOT suppress it after a call within the same 24h (or vice versa), so
        // feedback surfaces for EVERY call type — not just whichever ended first.
        const lsKey = FEEDBACK_LS_KEY + "_" + arg.kind;
        // Dev force-enable: bypass throttle + duration (but not the setting).
        let force = false;
        try {
          const qs =
            typeof window !== "undefined"
              ? new URLSearchParams(window.location.search)
              : null;
          force =
            (qs && qs.get("feedback") === "1") ||
            (typeof localStorage !== "undefined" &&
              localStorage.getItem("colab_feedback_force") === "1");
        } catch {
          /* ignore */
        }

        // Gate 1: media must have actually connected.
        if (!arg.connected) return;
        // Gate 2: the feature must be enabled (default ON; false disables).
        const s = settingsRef.current || {};
        if (s.callFeedback === false) return;

        if (!force) {
          // Gate 3: duration threshold.
          if ((arg.durationSec || 0) <= FEEDBACK_MIN_SEC) return;
          // Gate 4: 24h throttle via a localStorage timestamp.
          try {
            const last = parseInt(localStorage.getItem(lsKey) || "0", 10);
            if (last && Date.now() - last < FEEDBACK_THROTTLE_MS) return;
          } catch {
            /* if storage is unavailable, don't block the dialog */
          }
        }

        // Record the shown-timestamp NOW so a rapid second call can't double-open.
        try {
          localStorage.setItem(lsKey, String(Date.now()));
        } catch {
          /* ignore */
        }

        setFeedbackMeta({
          kind: arg.kind,
          callId: arg.callId ?? null,
          meetingId: arg.meetingId ?? null,
          durationSec: arg.durationSec || 0,
          networkQuality: arg.netQuality ?? null,
        });
      } catch {
        /* feedback must never break the leave flow */
      }
    },
    [],
  );
  const maybeShowFeedbackRef = useRef(maybeShowFeedback);

  return {
    loadScheduled,
    onLeaveRoom,
    onLeaveRoomRef,
    FEEDBACK_MIN_SEC,
    FEEDBACK_THROTTLE_MS,
    FEEDBACK_LS_KEY,
    maybeShowFeedback,
    maybeShowFeedbackRef,
  };
}
