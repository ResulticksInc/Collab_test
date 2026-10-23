// CoLab session hook — segment 6 (Misc).
// Mechanical extraction from CoLabV1.tsx (statements 396–466),
// plus statements pulled forward so this hook is self-contained.

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { api } from "../../../lib/api";
import { EVENTS } from "../../../lib/socket";
import config from "../../../lib/config";
import { tagFor, shouldPush, fire as fireNotif, type NotifPayload } from "../../../lib/dispatchNotif";
import { isDesktopApp } from "../../../lib/platform";
import { isMyTask } from "../helpers";

export type CoLabSession6 = {
  socketRef: any; connected: any; acceptingRef: any; activeCallRef: any;
  roomStateRef: any; showToast: any; setActiveCall: any; notifGateContext: any;
  playNotifSound: any; pendingCancelRef: any; setHuddles: any; conversationsRef: any;
  offlineDemo: any; tokenRef: any; refetchTasks: any; setTasks: any;
  users: any; taskProjectFilterRef: any; setTaskProjectFilter: any; setTaskViews: any;
  taskViews: any; tasksRef: any; setTaskConflict: any; meRef: any;
  refetchReminders: any; setReminders: any; reminderActionRef: any; setMode: any;
  setFocusReminderId: any; taskActionRef: any; setOpenTaskId: any; setFolders: any;
  setTheme: any; modeRef: any; hasCallSessionRef: any; setCallPip: any;
  setNavHistory: any; activeIdRef: any; mode: any; activeId: any;
  pane: any; mobilePaneRef: any; setForwardStack: any; setGxScope: any;
  setGxQuery: any; setGxOpen: any; setCallsSeenAt: any; userSelectedAtRef: any;
  setMobilePane: any; setLogoutOpen: any; setCommsOpen: any; settingsRef: any;
  onSelect: any; onModeRef: any; setCommsConvId: any; setSearch: any;
  setSearchResults: any; setCommsJumpMsgId: any; setModal: any; setConversations: any;
  openConvTargetRef: any; onSelectPerson: any; roomState: any; activeCall: any;
  setActiveId: any; goBackRef: any; mobilePane: any; conversations: any;
  commsOpen: any; commsConvId: any; tasks: any; me: any;
  reminderCounts: any; reminders: any; settings: any; active: any; setFilter: any;
};

export function useCoLab6(ctx: CoLabSession6) {

  const {
  socketRef, connected, acceptingRef, activeCallRef,
  roomStateRef, showToast, setActiveCall, notifGateContext,
  playNotifSound, pendingCancelRef, setHuddles, conversationsRef,
  offlineDemo, tokenRef, refetchTasks, setTasks,
  users, taskProjectFilterRef, setTaskProjectFilter, setTaskViews,
  taskViews, tasksRef, setTaskConflict, meRef,
  refetchReminders, setReminders, reminderActionRef, setMode,
  setFocusReminderId, taskActionRef, setOpenTaskId, setFolders,
  setTheme, modeRef, hasCallSessionRef, setCallPip,
  setNavHistory, activeIdRef, mode, activeId,
  pane, mobilePaneRef, setForwardStack, setGxScope,
  setGxQuery, setGxOpen, setCallsSeenAt, userSelectedAtRef,
  setMobilePane, setLogoutOpen, setCommsOpen, settingsRef,
  onSelect, onModeRef, setCommsConvId, setSearch,
  setSearchResults, setCommsJumpMsgId, setModal, setConversations,
  openConvTargetRef, onSelectPerson, roomState, activeCall,
  setActiveId, goBackRef, mobilePane, conversations,
  commsOpen, commsConvId, tasks, me,
  reminderCounts, reminders, settings, active, setFilter
  } = ctx;

  // ---- CoLabV1.tsx statements 396–466 (and pulled) ----
  useEffect(() => {
    const s = socketRef.current;
    if (!s || !connected) return;
    const incoming = ({ call, caller }) => {
      acceptingRef.current = false; // fresh ring → allow Accept again
      // AUDIT P1 + busy-visibility: never let an incoming 1:1 ring clobber an
      // in-progress call/huddle OR a meeting the user is in. Auto-decline with a
      // REASON so the caller learns WHY (see the `declined` handler) instead of a
      // silent ring-out — the server busy-check only inspects the calls table, so
      // huddle/meeting busy has to be signalled from here.
      const inCall = !!activeCallRef.current;
      const inMeeting = !!roomStateRef.current;
      if (inCall || inMeeting) {
        const reason = inCall ? "busy" : "in_meeting";
        try {
          socketRef.current?.emit(EVENTS.CALL_DECLINE, { callId: call.id, reason });
        } catch (_) {}
        showToast(
          ((caller && caller.name) || "Someone") +
            " called — you're " +
            (inCall ? "already in a call" : "in a meeting"),
        );
        return;
      }
      console.warn(
        "[call] CALL_INCOMING id=%s kind=%s caller=%s",
        call.id,
        call.kind,
        caller && caller.id,
      );
      setActiveCall({
        callId: call.id,
        peer: caller,
        kind: call.kind,
        dir: "in",
        status: "ringing",
      });
      const gate = notifGateContext();
      const title = "Incoming " + (call.kind === "video" ? "video " : "") + "call";
      const body = (caller && caller.name ? caller.name : "Someone") + " is calling";
      const payload: NotifPayload = { type: "call_incoming", id: call.id, title, body, conversationId: call.conversationId };
      // On the DESKTOP app, the native "ring + answer when closed" effect
      // (collabDesktop.incomingCall, keyed on activeCall) already shows a native
      // Answer/Decline notification + flashes the taskbar. And fireNotif itself
      // routes to a native Electron notification when collabDesktop exists — so
      // leaving this web path on would fire a SECOND native notification for the
      // same ring. Suppress it on desktop; the browser keeps the web path
      // unchanged (it's the only call notification there).
      if (!isDesktopApp && typeof document !== "undefined" && document.hidden &&
          shouldPush(gate, payload, { checkNotifyLevel: false, checkNotifyCalls: true })) {
        const tag = tagFor("call-incoming", call.id);
        fireNotif(tag, title, body, () => {
          try { window.focus(); } catch (_) {}
        }, playNotifSound, payload);
      }
    };
    const ringing = ({ call }) => {
      console.warn("[call] CALL_RINGING id=%s", call.id);
      // Caller already hit Cancel before this id existed → cancel it now so the
      // callee can't connect to an abandoned call.
      if (pendingCancelRef.current) {
        pendingCancelRef.current = false;
        socketRef.current &&
          socketRef.current.emit(EVENTS.CALL_CANCEL, { callId: call.id });
        return;
      }
      setActiveCall((cur) =>
        cur && cur.dir === "out" && !cur.callId
          ? { ...cur, callId: call.id }
          : cur,
      );
    };
    const accepted = ({ call }) => {
      console.warn("[call] CALL_ACCEPTED id=%s", call.id);
      setActiveCall((cur) => {
        if (!cur) return cur;
        // CALL_ACCEPTED goes to every device of the callee. A device that is still
        // ringing but did NOT tap Accept (acceptingRef unset) means the user
        // answered on another device (e.g. mobile) → dismiss the ring instead of
        // joining the same call from web/desktop as well.
        if (cur.callId === call.id && cur.dir === "in" && cur.status === "ringing" && !acceptingRef.current) {
          showToast("Call answered on another device");
          return null;
        }
        if (cur.callId === call.id) return { ...cur, status: "connected" };
        if (cur.dir === "out" && !cur.callId && cur.status === "calling")
          return { ...cur, callId: call.id, status: "connected" };
        return cur;
      });
    };
    const closeWith = (msg, eventName) => (payload) => {
      const cid = payload && payload.call && payload.call.id;
      console.warn("[call] %s id=%s", eventName || "CALL_CLOSE", cid);
      setActiveCall((cur) => {
        if (cur && cur.callId === cid) {
          if (msg) showToast(typeof msg === "function" ? msg(cur) : msg);
          return null;
        }
        return cur;
      });
    };
    const declined = (payload: any) => {
      const cid = payload && payload.call && payload.call.id;
      const reason = payload && payload.reason;
      console.warn("[call] CALL_DECLINED id=%s reason=%s", cid, reason || "");
      setActiveCall((cur) => {
        if (cur && cur.callId === cid) {
          // Busy-visibility: translate the callee's reason into a clear message so
          // the caller understands WHY (they were in a call / a meeting) rather than
          // seeing a raw code or a generic "declined".
          const who = (cur.peer && cur.peer.name) || "They";
          let msg: string;
          if (reason === "busy" || reason === "in_call") msg = `${who} is already in a call`;
          else if (reason === "in_meeting") msg = `${who} is in a meeting`;
          else if (reason) msg = `Declined: "${reason}"`;
          else msg = "Call declined";
          showToast(msg);
          return null;
        }
        return cur;
      });
    };
    const cancelled = closeWith("Call cancelled", "CALL_CANCELLED");
    const ended = closeWith(null, "CALL_ENDED");
    const missed = closeWith(
      (cur) => (cur.dir === "out" ? "No answer" : "Missed call"),
      "CALL_MISSED",
    );
    const busy = ({ peer }) => {
      console.warn("[call] CALL_BUSY peer=%s", peer && peer.id);
      setActiveCall((cur) => {
        if (cur && cur.dir === "out") {
          // Server CALL_BUSY only fires from the calls-table check → the peer is on
          // another call. Say so specifically instead of a bare "is busy".
          showToast((peer && peer.name ? peer.name : "They") + " is already in a call");
          return null;
        }
        return cur;
      });
    };
    const onErr = (e) => {
      console.warn("[call] CALL_ERROR %s", e && e.message);
      showToast((e && e.message) || "Call failed");
    };
    const huddleState = ({ conversationId, kind, participants }) => {
      setHuddles((prev) => {
        const next = { ...prev };
        if (participants && participants.length)
          next[conversationId] = { kind, participants };
        else delete next[conversationId];
        return next;
      });
      // If a group-call invite is still ringing for us but the call has emptied
      // out (everyone left), dismiss the stale prompt instead of ringing forever.
      const ac = activeCallRef.current;
      if (
        ac &&
        ac.huddleRing &&
        ac.conversationId === conversationId &&
        (!participants || participants.length === 0)
      ) {
        setActiveCall(null);
        showToast("Group call ended");
      }
    };
    s.on(EVENTS.HUDDLE_STATE, huddleState);
    const huddleRung = ({ conversationId, kind, from } = {} as any) => {
      // Already busy in another call → don't hijack it; just notify.
      if (activeCallRef.current) {
        showToast(
          ((from && from.name) || "Someone") + " added you to a group call",
        );
        return;
      }
      const conv = conversationsRef.current.find(
        (c: any) => c.id === conversationId,
      );
      const inviter = (from && from.name) || "Someone";
      // Show a real incoming-call prompt (Join / Decline) instead of a toast,
      // so a group-call invite rings like a 1:1 call. Accept → join the huddle.
      setActiveCall({
        callId: null,
        conversationId,
        kind: kind === "video" ? "video" : "audio",
        dir: "in",
        status: "ringing",
        group: true,
        huddleRing: true,
        name: (conv && conv.name) || inviter,
        peer: {
          id: (from && from.id) || conversationId,
          name: conv && conv.name ? `${inviter} · ${conv.name}` : inviter,
          initials:
            (conv && conv.avatar && conv.avatar.initials) ||
            inviter.slice(0, 1).toUpperCase(),
          color: (conv && conv.avatar && conv.avatar.color) || "#4f46e5",
          avatarUrl: conv && conv.avatar && conv.avatar.avatarUrl,
        },
      });
    };
    // A 1:1 call I'm in was promoted to a group: auto-follow into the new group
    // room (the connect effect re-runs when conversationId changes).
    const upgraded = ({ callId, conversationId }) => {
      console.warn(
        "[call] CALL_UPGRADED callId=%s -> conv=%s",
        callId,
        conversationId,
      );
      setActiveCall((cur) =>
        cur && cur.callId === callId && !cur.conversationId
          ? { ...cur, conversationId, callId: null, group: true }
          : cur,
      );
      // Follow into the new group huddle's room (the server already seeded us in
      // the roster; this is idempotent) so we receive its messages and remain in
      // the live participant list.
      if (conversationId)
        s.emit(EVENTS.HUDDLE_JOIN, {
          conversationId,
          kind: activeCallRef.current?.kind || "audio",
        });
    };
    s.on(EVENTS.HUDDLE_RUNG, huddleRung);
    s.on(EVENTS.CALL_UPGRADED, upgraded);
    s.on(EVENTS.CALL_INCOMING, incoming);
    s.on(EVENTS.CALL_RINGING, ringing);
    s.on(EVENTS.CALL_ACCEPTED, accepted);
    s.on(EVENTS.CALL_DECLINED, declined);
    s.on(EVENTS.CALL_CANCELLED, cancelled);
    s.on(EVENTS.CALL_ENDED, ended);
    s.on(EVENTS.CALL_MISSED, missed);
    s.on(EVENTS.CALL_BUSY, busy);
    s.on("call:error", onErr);
    return () => {
      s.off(EVENTS.CALL_INCOMING, incoming);
      s.off(EVENTS.CALL_RINGING, ringing);
      s.off(EVENTS.CALL_ACCEPTED, accepted);
      s.off(EVENTS.CALL_DECLINED, declined);
      s.off(EVENTS.CALL_CANCELLED, cancelled);
      s.off(EVENTS.CALL_ENDED, ended);
      s.off(EVENTS.CALL_MISSED, missed);
      s.off(EVENTS.CALL_BUSY, busy);
      s.off(EVENTS.HUDDLE_STATE, huddleState);
      s.off(EVENTS.HUDDLE_RUNG, huddleRung);
      s.off(EVENTS.CALL_UPGRADED, upgraded);
      s.off("call:error", onErr);
    };
  }, [connected, showToast, playNotifSound]);
  const onCreateTask = useCallback(
    async (payload) => {
      if (!offlineDemo && tokenRef.current) {
        try {
          const created = await api.createTask(tokenRef.current, payload);
          // Multi-assignee: createTask sets the primary (assigneeId); apply the
          // FULL set in a follow-up call when more than one was selected.
          const ids = (payload.assigneeIds || []).filter(Boolean);
          if (created && created.id && ids.length > 1)
            await api
              .setTaskAssignees(tokenRef.current, created.id, ids)
              .catch(() => {});
          // Initial dependencies (feature #51): link each selected "blocked by"
          // task after create. The server cycle-checks each edge; a rejected one
          // is skipped (best-effort) so a bad pick never fails the whole create.
          const depIds = (payload.depIds || []).filter(Boolean);
          if (created && created.id && depIds.length)
            for (const depId of depIds)
              await api
                .addTaskDep(tokenRef.current, created.id, depId)
                .catch(() => {});
          await refetchTasks();
        } catch (e) {
          showToast((e as any)?.message || "Action failed");
        }
      } else {
        setTasks((prev) => [
          ...prev,
          {
            id: "t_" + Date.now(),
            title: payload.title,
            status: payload.status || "todo",
            priority: payload.priority || "Medium",
            dueLabel: null,
            assignee: users.find((u) => u.id === payload.assigneeId) || null,
            assignees: (payload.assigneeIds && payload.assigneeIds.length
              ? payload.assigneeIds
              : payload.assigneeId
                ? [payload.assigneeId]
                : []
            )
              .map((id: string) => users.find((u) => u.id === id))
              .filter(Boolean),
            watchers: [],
          },
        ]);
      }
    },
    [offlineDemo, refetchTasks, users, showToast],
  );
  const onProjectFilter = useCallback(
    async (projectId: string) => {
      taskProjectFilterRef.current = projectId || "";
      setTaskProjectFilter(projectId || "");
      if (!offlineDemo && tokenRef.current) await refetchTasks();
    },
    [offlineDemo, refetchTasks],
  );
  const onCreateProject = useCallback(
    async (body: any) => {
      if (offlineDemo || !tokenRef.current) return null;
      try {
        const p = await api.createTaskProject(tokenRef.current, body);
        await refetchTasks();
        return p;
      } catch (e) {
        showToast((e as any)?.message || "Couldn't create project");
        return null;
      }
    },
    [offlineDemo, refetchTasks, showToast],
  );
  const onUpdateProject = useCallback(
    async (id: string, body: any) => {
      if (offlineDemo || !tokenRef.current) return;
      try {
        await api.updateTaskProject(tokenRef.current, id, body);
        await refetchTasks();
      } catch (e) {
        showToast((e as any)?.message || "Couldn't update project");
      }
    },
    [offlineDemo, refetchTasks, showToast],
  );
  const onDeleteProject = useCallback(
    async (id: string) => {
      if (offlineDemo || !tokenRef.current) return;
      try {
        await api.deleteTaskProject(tokenRef.current, id);
        // A deleted project un-files its tasks; if it was the active filter, drop
        // back to "all" so the board isn't stuck on a vanished project.
        if (taskProjectFilterRef.current === id) {
          taskProjectFilterRef.current = "";
          setTaskProjectFilter("");
        }
        await refetchTasks();
      } catch (e) {
        showToast((e as any)?.message || "Couldn't delete project");
      }
    },
    [offlineDemo, refetchTasks, showToast],
  );
  const onSaveView = useCallback(
    async (body: any) => {
      if (offlineDemo || !tokenRef.current) return null;
      try {
        const v = await api.createTaskView(tokenRef.current, body);
        setTaskViews(await api.getTaskViews(tokenRef.current).catch(() => taskViews));
        return v;
      } catch (e) {
        showToast((e as any)?.message || "Couldn't save view");
        return null;
      }
    },
    [offlineDemo, showToast, taskViews],
  );
  const onUpdateView = useCallback(
    async (id: string, body: any) => {
      if (offlineDemo || !tokenRef.current) return;
      try {
        await api.updateTaskView(tokenRef.current, id, body);
        setTaskViews(await api.getTaskViews(tokenRef.current).catch(() => taskViews));
      } catch (e) {
        showToast((e as any)?.message || "Couldn't update view");
      }
    },
    [offlineDemo, showToast, taskViews],
  );
  const onDeleteView = useCallback(
    async (id: string) => {
      if (offlineDemo || !tokenRef.current) return;
      try {
        await api.deleteTaskView(tokenRef.current, id);
        setTaskViews(await api.getTaskViews(tokenRef.current).catch(() => taskViews));
      } catch (e) {
        showToast((e as any)?.message || "Couldn't delete view");
      }
    },
    [offlineDemo, showToast, taskViews],
  );
  const onMoveTask = useCallback(
    async (id, status) => {
      if (!offlineDemo && tokenRef.current) {
        // OPTIMISTIC UI (feature #51): flip the status in state IMMEDIATELY (no
        // flicker on a board drag), then reconcile with the server. Snapshot the
        // task first so a rejection (e.g. dependency-block 400) rolls back to the
        // exact prior status instead of leaving the UI in the optimistic state.
        const prevTask = tasksRef.current.find((t) => t.id === id);
        setTasks((prev) =>
          prev.map((t) => (t.id === id ? { ...t, status } : t)),
        );
        try {
          const updated = await api.moveTask(tokenRef.current, id, status);
          // Adopt the authoritative server task (keeps version/fields in sync).
          if (updated)
            setTasks((prev) =>
              prev.map((t) => (t.id === id ? { ...t, ...updated } : t)),
            );
          await refetchTasks();
        } catch (e) {
          // Roll back to the server truth: restore the snapshot (or refetch if we
          // never held one) so a blocked/failed move doesn't stick in the UI.
          if (prevTask)
            setTasks((prev) =>
              prev.map((t) => (t.id === id ? { ...t, ...prevTask } : t)),
            );
          else await refetchTasks();
          showToast((e as any)?.message || "Action failed");
        }
      } else {
        setTasks((prev) =>
          prev.map((t) => (t.id === id ? { ...t, status } : t)),
        );
      }
    },
    [offlineDemo, refetchTasks, showToast],
  );
  const onDeleteTask = useCallback(
    async (id) => {
      if (!offlineDemo && tokenRef.current) {
        try {
          await api.deleteTask(tokenRef.current, id);
          await refetchTasks();
        } catch (e) {
          showToast((e as any)?.message || "Action failed");
        }
      } else {
        setTasks((prev) => prev.filter((t) => t.id !== id));
      }
    },
    [offlineDemo, refetchTasks, showToast],
  );
  const onUpdateTask = useCallback(
    async (id, patch) => {
      if (!offlineDemo && tokenRef.current) {
        // An empty patch is a pure board-refetch nudge (e.g. after an attachment
        // link/unlink, whose own endpoint already broadcast TASK_CHANGED). Don't
        // send a no-op PATCH — that would needlessly bump the version and could
        // 409 a concurrent editor. Just reconcile from the server.
        const fields = patch ? Object.keys(patch).filter((k) => k !== "version") : [];
        if (!fields.length) {
          await refetchTasks();
          return;
        }
        // Snapshot the pre-edit task OUTSIDE the try so the catch can roll the
        // optimistic change back to it on a non-409 failure.
        const snapshot = tasksRef.current.find((t) => t.id === id);
        try {
          // Send the version we last saw for this task so the server can detect a
          // concurrent edit. We read it from current state (the freshest task we
          // hold) rather than trusting the caller to thread it.
          const known = snapshot;
          const version = patch && "version" in patch ? patch.version : known?.version;
          const body = { ...patch };
          delete (body as any).version;
          // OPTIMISTIC UI (feature #51): apply the field edit to state IMMEDIATELY,
          // keeping the snapshot to roll back to on a non-409 failure. An empty
          // patch (a board-refetch nudge after an attachment change) is skipped —
          // there's nothing to apply optimistically and no rollback to keep.
          if (Object.keys(body).length)
            setTasks((prev) =>
              prev.map((t) => (t.id === id ? { ...t, ...body } : t)),
            );
          const updated = await api.updateTask(
            tokenRef.current,
            id,
            body,
            version,
          );
          // Merge the authoritative server task straight into state so the open
          // panel and board reflect the new version immediately (refetch also
          // runs, but this avoids a flash and keeps the version in sync).
          if (updated)
            setTasks((prev) =>
              prev.map((t) => (t.id === id ? { ...t, ...updated } : t)),
            );
          await refetchTasks();
          return updated;
        } catch (e: any) {
          if (e && e.status === 409) {
            // Optimistic-concurrency conflict: someone else changed this task.
            // DON'T clobber. Adopt the server's current task into state (so the
            // version + fields are fresh) and signal the open panel to surface a
            // non-destructive "this task changed, review" banner.
            const current = e.details && e.details.current;
            if (current)
              setTasks((prev) =>
                prev.map((t) => (t.id === id ? { ...t, ...current } : t)),
              );
            else await refetchTasks();
            setTaskConflict({ id, current: current || null, at: Date.now() });
            showToast(
              "This task was changed by someone else — review the latest version.",
            );
            return null;
          }
          // Generic failure (e.g. a dependency-block 400 on a Done edit): roll the
          // optimistic change back to the snapshot so the UI reflects server truth.
          if (snapshot)
            setTasks((prev) =>
              prev.map((t) => (t.id === id ? { ...t, ...snapshot } : t)),
            );
          else await refetchTasks();
          showToast((e as any)?.message || "Action failed");
          return null;
        }
      } else {
        setTasks((prev) =>
          prev.map((t) =>
            t.id === id
              ? {
                  ...t,
                  ...patch,
                  assignee:
                    "assigneeId" in patch
                      ? users.find((u) => u.id === patch.assigneeId) || null
                      : t.assignee,
                }
              : t,
          ),
        );
      }
    },
    [offlineDemo, refetchTasks, users, showToast],
  );
  const onSetAssignees = useCallback(
    async (id, userIds) => {
      if (!offlineDemo && tokenRef.current) {
        try {
          const updated = await api.setTaskAssignees(
            tokenRef.current,
            id,
            userIds,
          );
          if (updated)
            setTasks((prev) =>
              prev.map((t) => (t.id === id ? { ...t, ...updated } : t)),
            );
          await refetchTasks();
        } catch (e) {
          showToast((e as any)?.message || "Action failed");
        }
      } else {
        setTasks((prev) =>
          prev.map((t) =>
            t.id === id
              ? {
                  ...t,
                  assignees: (userIds || [])
                    .map((uid: string) => users.find((u) => u.id === uid))
                    .filter(Boolean),
                  assignee: users.find((u) => u.id === (userIds || [])[0]) || null,
                }
              : t,
          ),
        );
      }
    },
    [offlineDemo, refetchTasks, users, showToast],
  );
  const onWatchTask = useCallback(
    async (id, watch) => {
      if (offlineDemo || !tokenRef.current) {
        setTasks((prev) =>
          prev.map((t) => {
            if (t.id !== id) return t;
            const set = new Set<string>(t.watchers || []);
            if (watch) set.add(meRef.current?.id);
            else set.delete(meRef.current?.id);
            return { ...t, watchers: [...set].filter(Boolean) };
          }),
        );
        return;
      }
      try {
        const r = watch
          ? await api.watchTask(tokenRef.current, id)
          : await api.unwatchTask(tokenRef.current, id);
        const watchers = (r && r.watchers) || [];
        setTasks((prev) =>
          prev.map((t) => (t.id === id ? { ...t, watchers } : t)),
        );
        await refetchTasks();
      } catch (e) {
        showToast((e as any)?.message || "Action failed");
      }
    },
    [offlineDemo, refetchTasks, showToast],
  );
  const reminderState = (dueAt) => {
    if (!dueAt) return "upcoming";
    const due = Date.parse(dueAt);
    if (!Number.isFinite(due)) return "upcoming";
    if (due < Date.now()) return "overdue";
    return new Date(due).toDateString() === new Date().toDateString()
      ? "today"
      : "upcoming";
  };
  const nextDueLocal = (dueAt, rec) => {
    if (!dueAt || rec === "none") return null;
    let d = new Date(dueAt);
    if (Number.isNaN(d.getTime())) return null;
    const now = Date.now();
    const adv = () => {
      if (rec === "daily") d = new Date(d.getTime() + 86400000);
      else if (rec === "weekly") d = new Date(d.getTime() + 7 * 86400000);
      else if (rec === "monthly") {
        const n = new Date(d);
        n.setMonth(n.getMonth() + 1);
        d = n;
      } else return false;
      return true;
    };
    if (!adv()) return null;
    let g = 0;
    while (d.getTime() <= now && g++ < 1000) if (!adv()) break;
    return d.toISOString();
  };
  const spawnLocal = useCallback((r) => {
    const nd = nextDueLocal(r.dueAt, r.recurrence);
    if (!nd) return null;
    return {
      ...r,
      id: "r_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
      done: false,
      status: "open",
      dueAt: nd,
      state: reminderState(nd),
      createdAt: new Date().toISOString(),
    };
    // nextDueLocal and reminderState are plain functions defined in component scope
    // but never change identity — no deps needed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const onAddReminder = useCallback(
    async (payload) => {
      const body = {
        text: payload.text,
        folderId: payload.folderId || null,
        dueLabel: payload.dueLabel || null,
        dueAt: payload.dueAt || null,
        priority: payload.priority || "Medium",
        recurrence: payload.recurrence || "none",
        description: payload.description || null,
        // CUSTOM LEAD TIME + STRUCTURED RECURRENCE (#53).
        leadMinutes: payload.leadMinutes ?? null,
        recurrenceRule: payload.recurrenceRule ?? null,
      };
      if (!body.text || !body.text.trim()) return;
      if (!offlineDemo && tokenRef.current) {
        try {
          await api.createReminder(tokenRef.current, body);
          await refetchReminders();
        } catch (e) {
          showToast((e as any)?.message || "Action failed");
        }
      } else {
        setReminders((prev) => [
          {
            id: "r_" + Date.now(),
            ...body,
            done: false,
            status: "open",
            state: reminderState(body.dueAt),
            createdAt: new Date().toISOString(),
          },
          ...prev,
        ]);
      }
    },
    [offlineDemo, refetchReminders, showToast],
  );
  const onQuickAddReminder = useCallback(
    async (text: string, folderId: string | null = null) => {
      if (offlineDemo || !tokenRef.current) return null;
      try {
        const res = await api.quickAddReminder(tokenRef.current, text, folderId);
        if (res && res.created) await refetchReminders();
        return res;
      } catch (e) {
        showToast((e as any)?.message || "Couldn't add reminder");
        return null;
      }
    },
    [offlineDemo, refetchReminders, showToast],
  );
  const onPatchReminder = useCallback(
    async (id, patch) => {
      if (!offlineDemo && tokenRef.current) {
        try {
          await api.patchReminder(tokenRef.current, id, patch);
          await refetchReminders();
        } catch (e) {
          showToast((e as any)?.message || "Action failed");
        }
      } else {
        setReminders((prev) =>
          prev.map((r) =>
            r.id === id
              ? {
                  ...r,
                  ...patch,
                  state:
                    "dueAt" in patch ? reminderState(patch.dueAt) : r.state,
                }
              : r,
          ),
        );
      }
    },
    [offlineDemo, refetchReminders, showToast],
  );
  const onSetReminderStatus = useCallback(
    async (id, status) => {
      if (!offlineDemo && tokenRef.current) {
        try {
          await api.setReminderStatus(tokenRef.current, id, status);
          await refetchReminders();
        } catch (e) {
          showToast((e as any)?.message || "Action failed");
        }
      } else {
        setReminders((prev) => {
          const spawned: any[] = [];
          const out = prev.map((r) => {
            if (r.id !== id) return r;
            if (
              status === "done" &&
              r.status !== "done" &&
              r.recurrence &&
              r.recurrence !== "none" &&
              r.dueAt
            ) {
              const sp = spawnLocal(r);
              if (sp) spawned.push(sp);
            }
            return {
              ...r,
              status,
              done: status === "done",
              state:
                status === "archived"
                  ? "archived"
                  : status === "done"
                    ? "completed"
                    : reminderState(r.dueAt),
            };
          });
          return [...spawned, ...out];
        });
      }
    },
    [offlineDemo, refetchReminders, spawnLocal, showToast],
  );
  const onSnoozeReminder = useCallback(
    async (id, minutes = 10) => {
      if (!offlineDemo && tokenRef.current) {
        try {
          await api.snoozeReminder(tokenRef.current, id, minutes);
          await refetchReminders();
          showToast(`Snoozed ${minutes} min`);
        } catch (e) {
          showToast((e as any)?.message || "Snooze failed");
        }
      } else {
        const dueAt = new Date(Date.now() + minutes * 60000).toISOString();
        setReminders((prev) =>
          prev.map((r) =>
            r.id === id
              ? { ...r, dueAt, status: "open", done: false, state: reminderState(dueAt) }
              : r,
          ),
        );
        showToast(`Snoozed ${minutes} min`);
      }
    },
    [offlineDemo, refetchReminders, showToast],
  );
  const onCompleteReminder = useCallback(
    (id) => onSetReminderStatus(id, "done"),
    [onSetReminderStatus],
  );
  reminderActionRef.current = {
    complete: (id: string) => { setMode("reminders"); setFocusReminderId(id); onCompleteReminder(id); },
    snooze: (id: string, minutes = 10) => { setMode("reminders"); setFocusReminderId(id); onSnoozeReminder(id, minutes); },
    open: (id: string) => { setMode("reminders"); setFocusReminderId(id); },
  };
  taskActionRef.current = {
    complete: (id: string) => {
      setMode("tasks");
      setOpenTaskId(id);
      const tok = tokenRef.current;
      if (tok) api.moveTask(tok, id, "done").then(() => refetchTasks()).catch(() => {});
    },
    open: (id: string) => { setMode("tasks"); setOpenTaskId(id); },
  };
  const onRenameFolder = useCallback(
    async (id, name, icon) => {
      if (!offlineDemo && tokenRef.current) {
        try {
          await api.renameFolder(tokenRef.current, id, name, icon);
          await refetchReminders();
        } catch (e) {
          showToast((e as any)?.message || "Action failed");
        }
      } else {
        setFolders((prev) =>
          prev.map((f) =>
            f.id === id
              ? { ...f, name: name ?? f.name, icon: icon ?? f.icon }
              : f,
          ),
        );
      }
    },
    [offlineDemo, refetchReminders, showToast],
  );
  const onDeleteFolder = useCallback(
    async (id) => {
      if (!offlineDemo && tokenRef.current) {
        try {
          await api.deleteFolder(tokenRef.current, id);
          await refetchReminders();
        } catch (e) {
          showToast((e as any)?.message || "Action failed");
        }
      } else {
        setFolders((prev) => prev.filter((f) => f.id !== id));
        setReminders((prev) =>
          prev.map((r) => (r.folderId === id ? { ...r, folderId: null } : r)),
        );
      }
    },
    [offlineDemo, refetchReminders, showToast],
  );
  const onBulkReminders = useCallback(
    async (action, value, ids) => {
      if (!ids || !ids.length) return;
      if (!offlineDemo && tokenRef.current) {
        try {
          await api.bulkReminders(tokenRef.current, { ids, action, value });
          await refetchReminders();
        } catch (e) {
          showToast((e as any)?.message || "Bulk action failed");
        }
      } else {
        setReminders((prev) => {
          const idset = new Set(ids);
          const spawned: any[] = [];
          let out = prev.map((r) => {
            if (!idset.has(r.id)) return r;
            if (action === "complete") {
              if (r.recurrence && r.recurrence !== "none" && r.dueAt) {
                const sp = spawnLocal(r);
                if (sp) spawned.push(sp);
              }
              return { ...r, done: true, status: "done", state: "completed" };
            }
            if (action === "archive")
              return { ...r, status: "archived", state: "archived" };
            if (action === "open")
              return {
                ...r,
                done: false,
                status: "open",
                state: reminderState(r.dueAt),
              };
            if (action === "move") return { ...r, folderId: value || null };
            if (action === "priority") return { ...r, priority: value };
            return r;
          });
          if (action === "delete") out = out.filter((r) => !idset.has(r.id));
          return [...spawned, ...out];
        });
      }
    },
    [offlineDemo, refetchReminders, spawnLocal, showToast],
  );
  const onToggleReminder = useCallback(
    async (id) => {
      if (!offlineDemo && tokenRef.current) {
        try {
          await api.toggleReminder(tokenRef.current, id);
          await refetchReminders();
        } catch (e) {
          showToast((e as any)?.message || "Action failed");
        }
      } else {
        setReminders((prev) => {
          const spawned: any[] = [];
          const out = prev.map((r) => {
            if (r.id !== id) return r;
            const becomingDone = !(r.status === "done" || r.done);
            if (
              becomingDone &&
              r.recurrence &&
              r.recurrence !== "none" &&
              r.dueAt
            ) {
              const sp = spawnLocal(r);
              if (sp) spawned.push(sp);
            }
            return {
              ...r,
              done: becomingDone,
              status: becomingDone ? "done" : "open",
              state: becomingDone ? "completed" : reminderState(r.dueAt),
            };
          });
          return [...spawned, ...out];
        });
      }
    },
    [offlineDemo, refetchReminders, spawnLocal, showToast],
  );
  const onDeleteReminder = useCallback(
    async (id) => {
      if (!offlineDemo && tokenRef.current) {
        try {
          await api.deleteReminder(tokenRef.current, id);
          await refetchReminders();
        } catch (e) {
          showToast((e as any)?.message || "Action failed");
        }
      } else {
        setReminders((prev) => prev.filter((r) => r.id !== id));
      }
    },
    [offlineDemo, refetchReminders, showToast],
  );
  const onCreateFolder = useCallback(
    async (name, icon) => {
      if (!offlineDemo && tokenRef.current) {
        try {
          await api.createFolder(tokenRef.current, { name, icon });
          await refetchReminders();
        } catch (e) {
          showToast((e as any)?.message || "Action failed");
        }
      } else {
        setFolders((prev) => [...prev, { id: "f_" + Date.now(), name, icon }]);
      }
    },
    [offlineDemo, refetchReminders, showToast],
  );
  // Collab is always light (see applySettings) — the quick toggle is a no-op.
  const toggleTheme = useCallback(() => setTheme("light"), [setTheme]);
  const onMode = useCallback((m: string) => {
    const cur = modeRef.current;
    // If a meeting/call is docked, navigating to another module minimizes it to
    // a floating PiP (it stays connected; "enlarge" restores it).
    if (hasCallSessionRef.current) setCallPip(true);
    setNavHistory((h) => {
      const last = h[h.length - 1];
      if (last && last.mode === cur && last.activeId === activeIdRef.current)
        return h;
      return [
        ...h,
        {
          mode: cur,
          activeId: activeIdRef.current,
          pane: mobilePaneRef.current,
        },
      ];
    });
    setForwardStack([]);
    setMode(m);
    // Reset the global top-bar search on plain (rail/programmatic) navigation so
    // a previously-typed scope query doesn't silently re-filter a module on
    // re-entry, and the scope menu never re-pops. Chip clicks call setMode
    // directly (they bypass onMode), so they keep their chosen scope.
    setGxScope("all");
    setGxQuery("");
    setGxOpen(false);
    // Opening Calls marks the missed-call list as seen, so the dashboard count
    // clears and won't reappear (until a NEW missed call arrives).
    if (m === "calls") {
      const t = Date.now();
      setCallsSeenAt(t);
      try {
        localStorage.setItem("colab_calls_seen", String(t));
      } catch {
        /* ignore */
      }
    }
    // Only reset to list view if the user navigated to "chats" from the rail
    // without selecting a specific conversation first. When onSelect + onMode
    // are called together (e.g. from dashboard/activity), onSelect already set
    // mobilePane to "chat" — don't clobber it.
    if (m === "chats" && Date.now() - userSelectedAtRef.current > 200)
      setMobilePane("list");
  }, []);
  // Rail clicks only: tapping "Messages" always lands on the All tab, so a leftover
  // Requests/Unread/Groups filter can't hide the list. Programmatic onMode("chats")
  // callers (e.g. "open unread") set their own filter and keep using onMode.
  const onRailMode = useCallback((m: string) => {
    if (m === "chats") setFilter("all");
    onMode(m);
  }, [onMode, setFilter]);
  const onOpenSettings = useCallback(() => onMode("settings"), [onMode]);
  const onRequestLogout = useCallback(() => setLogoutOpen(true), []);
  const onCloseComms = useCallback(() => setCommsOpen(false), []);
  const onCommsSelect = useCallback((id: string) => {
    if (settingsRef.current?.inMeetingChatMode) {
      setCommsOpen(false);
      onSelect(id);
      onModeRef.current("chats");
    } else {
      setCommsConvId(id);
      // Snap the list back out of search, exactly as the main sidebar does on
      // select (onSelect clears both). Without this the query and its results
      // panel were still sitting there when you came back via "All chats",
      // hiding the conversation list behind a stale search.
      setSearch("");
      setSearchResults(null);
    }
  }, [onSelect]);
  const onCommsSelectMessage = useCallback(
    (convId: string, msgId?: string) => {
      setCommsConvId(convId);
      if (msgId) setCommsJumpMsgId(msgId);
    },
    [],
  );
  const onOpenCreateGroup = useCallback(() => setModal({ type: "createGroup" }), []);
  const onOpenCreateChannel = useCallback(() => setModal({ type: "createChannel" }), []);
  const onCommsNewDm = useCallback(() => { setCommsOpen(false); onMode("contacts"); }, [onMode]);
  const onTempGroupCreated = useCallback((conv: any) => {
    if (!conv || !conv.id) return;
    setConversations((prev) => {
      const i = prev.findIndex((c) => c.id === conv.id);
      if (i === -1) return [{ ...conv, unread: conv.unread || 0 }, ...prev];
      const next = prev.slice();
      next[i] = { ...next[i], ...conv };
      return next;
    });
  }, []);
  const onCommsSelectPerson = useCallback(
    async (userId: string) => {
      openConvTargetRef.current = "comms";
      try {
        await onSelectPerson(userId);
      } finally {
        openConvTargetRef.current = "app";
      }
    },
    [onSelectPerson],
  );
  const helpFromRef = useRef<string>("dashboard");
  const [helpTarget, setHelpTarget] = useState<string>("");
  const onOpenHelp = useCallback(() => {
    setHelpTarget("");
    helpFromRef.current = modeRef.current;
    onMode("help");
  }, [onMode]);
  useEffect(() => {
    hasCallSessionRef.current = !!(roomState || activeCall);
  }, [roomState, activeCall]);
  const callSessionId =
    (roomState && roomState.meeting && roomState.meeting.id) ||
    (activeCall &&
      (activeCall.callId ||
        activeCall.conversationId ||
        (activeCall.peer && activeCall.peer.id))) ||
    null;
  useEffect(() => {
    if (callSessionId) setCallPip(false);
  }, [callSessionId]);
  const goBack = () => {
    setNavHistory((h) => {
      if (h.length === 0) return h;
      setForwardStack((f) => [
        {
          mode: modeRef.current,
          activeId: activeIdRef.current,
          pane: mobilePaneRef.current,
        },
        ...f,
      ]);
      const prev = h[h.length - 1];
      setMode(prev.mode);
      setActiveId(prev.activeId ?? null);
      setMobilePane(prev.pane ?? (prev.activeId ? "chat" : "list"));
      return h.slice(0, -1);
    });
  };
  const goForward = () => {
    setForwardStack((f) => {
      if (f.length === 0) return f;
      setNavHistory((h) => [
        ...h,
        {
          mode: modeRef.current,
          activeId: activeIdRef.current,
          pane: mobilePaneRef.current,
        },
      ]);
      const next = f[0];
      setMode(next.mode);
      setActiveId(next.activeId ?? null);
      setMobilePane(next.pane ?? (next.activeId ? "chat" : "list"));
      return f.slice(1);
    });
  };
  goBackRef.current = goBack;
  onModeRef.current = onMode;
  modeRef.current = mode;
  mobilePaneRef.current = mobilePane;
  const totalUnread = conversations.reduce(
    (n, c) => n + (c.hidden ? 0 : c.unread || 0),
    0,
  );
  const commsUnread = conversations.reduce(
    (n, c) =>
      n +
      (c.hidden || (commsOpen && c.id === commsConvId) ? 0 : c.unread || 0),
    0,
  );
  const myOpenTaskCount = useMemo(
    () =>
      tasks.filter(
        (t) => isMyTask(t, me && me.id) && t.status !== "done",
      ).length,
    [tasks, me],
  );
  const openReminderCount = useMemo(
    () =>
      reminderCounts && typeof reminderCounts.open === "number"
        ? reminderCounts.open
        : reminders.filter((r) => !r.done).length,
    [reminderCounts, reminders],
  );
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.title =
      settings.notifBadge !== false && totalUnread > 0
        ? `(${totalUnread}) ${config.appName}`
        : config.appName;
  }, [totalUnread, settings.notifBadge]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const cd = (window as any).collabDesktop;
    if (cd && typeof cd.setBadgeCount === "function") {
      try { cd.setBadgeCount(totalUnread); } catch {}
    }
  }, [totalUnread]);
  const recentConvKey = useMemo(() => {
    const ts = (s: any) => (s ? Date.parse(s) || 0 : 0);
    return (conversations || [])
      .filter((c) => c && c.id && !c.hidden)
      .map((c) => ({
        id: c.id as string,
        name: (c.name as string) || "Conversation",
        t: ts(c.lastMessageAt || c.updatedAt),
      }))
      .sort((a, b) => b.t - a.t)
      .slice(0, 5);
  }, [conversations]);
  useEffect(() => {
    if (!isDesktopApp || typeof window === "undefined") return;
    const cd = (window as any).collabDesktop;
    if (cd && typeof cd.setRecentConversations === "function") {
      try {
        cd.setRecentConversations(
          recentConvKey.map((c) => ({ id: c.id, name: c.name })),
        );
      } catch {}
    }
  }, [recentConvKey]);
  const activeIdForHuddle = active ? active.id : null;
  useEffect(() => {
    if (!activeIdForHuddle || !connected) return;
    try {
      socketRef.current &&
        socketRef.current.emit(EVENTS.HUDDLE_SYNC, {
          conversationId: activeIdForHuddle,
        });
    } catch (_) {}
  }, [activeIdForHuddle, connected]);
  const commsConv = commsConvId
    ? conversations.find((c) => c.id === commsConvId) || null
    : null;
  const isPopout =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("popout") === "1";

  return {
    onCreateTask,
    onProjectFilter,
    onCreateProject,
    onUpdateProject,
    onDeleteProject,
    onSaveView,
    onUpdateView,
    onDeleteView,
    onMoveTask,
    onDeleteTask,
    onUpdateTask,
    onSetAssignees,
    onWatchTask,
    reminderState,
    nextDueLocal,
    spawnLocal,
    onAddReminder,
    onQuickAddReminder,
    onPatchReminder,
    onSetReminderStatus,
    onSnoozeReminder,
    onCompleteReminder,
    onRenameFolder,
    onDeleteFolder,
    onBulkReminders,
    onToggleReminder,
    onDeleteReminder,
    onCreateFolder,
    toggleTheme,
    onMode,
    onRailMode,
    onOpenSettings,
    onRequestLogout,
    onCloseComms,
    onCommsSelect,
    onCommsSelectMessage,
    onOpenCreateGroup,
    onOpenCreateChannel,
    onCommsNewDm,
    onTempGroupCreated,
    onCommsSelectPerson,
    helpFromRef,
    helpTarget,
    setHelpTarget,
    onOpenHelp,
    callSessionId,
    goBack,
    goForward,
    totalUnread,
    commsUnread,
    myOpenTaskCount,
    openReminderCount,
    recentConvKey,
    activeIdForHuddle,
    commsConv,
    isPopout,
  };
}
