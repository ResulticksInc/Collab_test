// CoLab session hook — segment 5 (Calls).
// Mechanical extraction from CoLabV1.tsx (statements 321–395),
// plus statements pulled forward so this hook is self-contained.

import { useEffect, useRef, useCallback } from "react";
import { pushPreviewOf } from "../../../lib/pushPreview";
import { searchHelp } from "../../../lib/helpContent";
import { otherMemberId } from "../../../lib/identity";
import { api } from "../../../lib/api";
import { log } from "../../../lib/logger";
import { EVENTS } from "../../../lib/socket";
import { encryptForUser, encryptForGroup, isE2EEEnabled, isRatchetEnabled, isConvE2EERequired } from "../../../lib/e2ee/manager";
import { isDesktopApp } from "../../../lib/platform";
import { subscribeDeepLinks } from "../../../lib/deepLink";

export type CoLabSession5 = {
  conversations: any; offlineDemo: any; tokenRef: any; users: any;
  setSearch: any; setSearchResults: any; setCommsConvId: any; onSelect: any;
  setMode: any; invites: any; refetchConversations: any; onAcceptInvite: any;
  showToast: any; onSendInvite: any; refetchMeetings: any; joinPrefsRef: any;
  settingsRef: any; changeSettingRef: any; meetings: any; me: any;
  setRoomState: any; setPreJoin: any; setOpenTaskId: any; deepLinkDoneRef: any;
  deepLinkRef: any; authed: any; setModal: any; setJumpMsgId: any;
  hasCallSessionRef: any; setCallPip: any; onLeaveRoomRef: any; onLeaveRoom: any;
  setMeetings: any; refetchTasks: any; setTasks: any; meRef: any;
  socketRef: any; connected: any; appendMessage: any; bumpPreview: any;
  activeCallRef: any; setActiveCall: any; conversationsRef: any; activeIdRef: any;
  setManageConvId: any; setMobilePane: any; handoffOffer: any; setHandoffOffer: any;
  mode: any; active: any; usersRef: any; setMeetingTitle: any;
  setMeetingAttendees: any; activeCall: any; maybeShowFeedbackRef: any; maybeShowFeedback: any;
  startRingtone: any; stopRingtone: any; presentationDndActive: any; roomState: any;
  setOpenFileId: any; setOrgTab: any; changeSetting: any;
};

export function useCoLab5(ctx: CoLabSession5) {

  const {
  conversations, offlineDemo, tokenRef, users,
  setSearch, setSearchResults, setCommsConvId, onSelect,
  setMode, invites, refetchConversations, onAcceptInvite,
  showToast, onSendInvite, refetchMeetings, joinPrefsRef,
  settingsRef, changeSettingRef, meetings, me,
  setRoomState, setPreJoin, setOpenTaskId, deepLinkDoneRef,
  deepLinkRef, authed, setModal, setJumpMsgId,
  hasCallSessionRef, setCallPip, onLeaveRoomRef, onLeaveRoom,
  setMeetings, refetchTasks, setTasks, meRef,
  socketRef, connected, appendMessage, bumpPreview,
  activeCallRef, setActiveCall, conversationsRef, activeIdRef,
  setManageConvId, setMobilePane, handoffOffer, setHandoffOffer,
  mode, active, usersRef, setMeetingTitle,
  setMeetingAttendees, activeCall, maybeShowFeedbackRef, maybeShowFeedback,
  startRingtone, stopRingtone, presentationDndActive, roomState,
  setOpenFileId, setOrgTab, changeSetting
  } = ctx;

  // ---- CoLabV1.tsx statements 321–395 (and pulled) ----
  const onGlobalSearch = useCallback(
    async (query) => {
      if (!query || !query.trim())
        return { conversations: [], people: [], messages: [], help: [] };
      // Help articles are searched client-side (lib/helpContent) and merged in as
      // their own category, so the Help Center is reachable from the ONE global
      // search bar like every other module (its in-module search bar was removed).
      const help = searchHelp(query);
      if (!offlineDemo && tokenRef.current) {
        try {
          const r = await api.search(tokenRef.current, query);
          return { ...r, help };
        } catch {
          return { conversations: [], people: [], messages: [], help };
        }
      }
      const s = query.toLowerCase();
      return {
        conversations: conversations.filter((c) =>
          (c.name || "").toLowerCase().includes(s),
        ),
        people: users.filter((u) => (u.name || "").toLowerCase().includes(s)),
        messages: [],
        help,
      };
    },
    [offlineDemo, conversations, users],
  );
  const openConvTargetRef = useRef<"app" | "comms">("app");
  const onSelectPerson = useCallback(
    async (userId) => {
      const existing = (conversations || []).find(
        (c) => c && c.kind === "dm" && (c.members || []).includes(userId),
      );
      setSearch("");
      setSearchResults(null);
      // Where a resolved DM should OPEN. In the app that's the Chat module; from
      // the in-call sidebar it must be the comms panel — routing the main app
      // instead changed a view buried UNDER the full-screen call overlay, so
      // clicking a person mid-call looked like it did nothing at all.
      const openResolved = (id: string) => {
        if (openConvTargetRef.current === "comms") {
          setCommsConvId(id);
          return;
        }
        onSelect(id);
        setMode("chats");
      };
      // Already connected → open the existing DM.
      if (existing) {
        openResolved(existing.id);
        return;
      }
      if (offlineDemo || !tokenRef.current) return;
      // An ACCEPTED connection already has a DM — the invite carries its
      // conversationId. Open it directly instead of falling through to
      // onSendInvite (the source of the wrong "connection request sent" toast on
      // an already-connected person). Also covers the case where the sender
      // missed the CONVERSATION_NEW event, so the DM isn't in `conversations` yet.
      const accepted = (invites || []).find(
        (i: any) =>
          i.status === "accepted" &&
          i.conversationId &&
          ((i.direction === "outgoing" && i.to && i.to.id === userId) ||
            (i.direction === "incoming" && i.from && i.from.id === userId)),
      );
      if (accepted) {
        if (!conversations.some((c) => c.id === accepted.conversationId))
          refetchConversations();
        openResolved(accepted.conversationId);
        return;
      }
      // No DM yet → starting a conversation is a CONNECTION REQUEST the other
      // person must accept (the DM is created only on acceptance). If THEY've
      // already requested you, accepting connects you both immediately.
      const incoming = (invites || []).find(
        (i: any) =>
          i.direction === "incoming" &&
          i.status === "pending" &&
          i.from &&
          i.from.id === userId,
      );
      if (incoming) {
        await onAcceptInvite(incoming.id);
        // Accepting creates the DM asynchronously (CONVERSATION_NEW), so there
        // is no id to open yet. In-call, stay put rather than switching a module
        // the user can't see behind the overlay.
        if (openConvTargetRef.current !== "comms") setMode("chats");
        return;
      }
      const outgoing = (invites || []).find(
        (i: any) =>
          i.direction === "outgoing" &&
          i.status === "pending" &&
          i.to &&
          i.to.id === userId,
      );
      if (outgoing) {
        showToast("Connection request already sent");
        return;
      }
      await onSendInvite(userId);
    },
    [
      conversations,
      invites,
      onSelect,
      offlineDemo,
      onAcceptInvite,
      onSendInvite,
      showToast,
      refetchConversations,
    ],
  );
  // RCR-05: server-computed preview of a recurrence's next dates for the editor.
  const onPreviewOccurrences = useCallback(async (body: any) => {
    if (!tokenRef.current) return [];
    try {
      const r: any = await api.previewMeetingOccurrences(tokenRef.current, body);
      return (r && (r.data || r)) || [];
    } catch (_) {
      return [];
    }
  }, []);
  // Free/busy for the scheduler. Returns { busy, free, checked }; a failure
  // yields null so the dialog shows no hint rather than a wrong one.
  const onCheckAvailability = useCallback(async (body: any) => {
    if (!tokenRef.current) return null;
    try {
      const r: any = await api.meetingAvailability(tokenRef.current, body);
      return (r && (r.data || r)) || null;
    } catch (_) {
      return null;
    }
  }, []);
  // Live room state for the calendar's meeting-details dialog: has it started,
  // how many are in it. Same endpoint the green room and lobby read, so all
  // three screens quote the same number.
  const onMeetingPreview = useCallback(async (meetingId: string) => {
    if (!tokenRef.current || !meetingId) return null;
    try {
      const r: any = await api.getMeetingPreview(tokenRef.current, meetingId);
      return (r && (r.data || r)) || null;
    } catch (_) {
      return null;
    }
  }, []);
  const onCreateMeeting = useCallback(
    async (payload) => {
      if (!offlineDemo && tokenRef.current) {
        try {
          // Return the created meeting so the scheduler can show its ID + link.
          const m = await api.createMeeting(tokenRef.current, payload);
          await refetchMeetings();
          return m;
        } catch (e) {
          showToast((e as any)?.message || "Action failed");
        }
      }
      return undefined;
    },
    [offlineDemo, refetchMeetings, showToast],
  );
  const enterMeetingNow = useCallback(
    async (id, prefs?: any) => {
      if (prefs) {
        joinPrefsRef.current = prefs;
        // CARRY THE GREEN ROOM'S DEVICE CHOICE INTO THE MEETING.
        // The pre-join screen returns { mic, cam, micId, camId, spkId }, but only
        // mic/cam were ever read from it — MeetingStage acquires its mic from
        // settings.micId instead. So picking a working microphone in the green
        // room had literally no effect on the meeting you then joined, which is
        // the worst possible outcome for someone using that screen precisely
        // because their default mic was not working.
        for (const k of ["micId", "camId", "spkId"] as const) {
          const v = prefs[k];
          if (v && v !== (settingsRef.current || {})[k]) changeSettingRef.current(k, v);
        }
      }
      const mtg = (meetings || []).find((m) => m.id === id);
      if (offlineDemo || !tokenRef.current) {
        const mep = me ? [{ ...me, joinedAt: new Date().toISOString() }] : [];
        setRoomState({
          meeting: mtg || { id, title: "Meeting", attendees: [] },
          participants: mep,
          count: mep.length,
          state: mep.length >= 2 ? "active" : "waiting",
          isHost: mtg ? !!mtg.mine : true,
          hostPresent: true,
        });
        return;
      }
      // Room-lookup observability: this step runs BEFORE MeetingStage (and its
      // [CALLDIAG] trail) exists, so log it here. Captures whether the meeting
      // resolved, or failed at locked/ejected/closed/lobby/lookup — the BA/CEO
      // can read the exact stage from the DiagnosticsPanel (Ctrl+Alt+D).
      log.info("meeting", "Join clicked — looking up room", { data: { meetingId: id } });
      try {
        const room = await api.enterMeetingRoom(tokenRef.current, id);
        if (room && room.locked && !room.meeting) {
          log.warn("meeting", "Room locked — host not admitting", { data: { meetingId: id } });
          showToast(
            "This meeting is locked — the host isn't admitting new participants.",
          );
        } else if (room && room.meeting) {
          log.success("meeting", "Room resolved — connecting media", { data: { meetingId: id } });
          setRoomState(room);
          refetchMeetings();
        } else if (room && room.ejected) {
          log.warn("meeting", "Removed by host", { data: { meetingId: id } });
          showToast("You were removed from this meeting by the host.");
        } else if (room && room.closed) {
          log.warn("meeting", "Meeting has ended", { data: { meetingId: id } });
          showToast("This meeting has ended.");
        } else if (room && room.lobbyStatus === "waiting") {
          log.info("meeting", "In lobby — awaiting host admit", { data: { meetingId: id } });
          // Open the room view so the WAITING ROOM renders. Previously this only
          // raised a toast and dropped the response on the floor, so the lobby
          // screen in MeetingRoom was unreachable code and being held outside
          // looked like the Join button had simply failed. The screen itself
          // says what is happening (who is inside, whether it has started), and
          // it admits you automatically the moment the host says yes — so no
          // "try again once admitted" toast either.
          setRoomState(room);
        } else {
          log.error("meeting", "Room lookup returned no meeting", {
            hint: "The meeting may have been deleted, or the server couldn't resolve the room.",
            data: { meetingId: id, room },
          });
          showToast("Couldn't open the meeting room");
        }
      } catch (e) {
        log.error("meeting", "Room lookup failed", {
          hint: "Network/server error reaching the meeting API before media connect.",
          data: { meetingId: id, error: (e as any)?.message },
        });
        showToast((e as any)?.message || "Couldn't open the meeting room");
      }
    },
    [offlineDemo, meetings, me, refetchMeetings, showToast],
  );
  const rsvpAcceptedRef = useRef<Set<string>>(new Set());
  const onJoinMeeting = useCallback(
    (id) => {
      const mtg = (meetings || []).find((m) => m.id === id);
      setPreJoin({ id, title: mtg ? mtg.title : "Meeting" });
      // Joining an invite IS accepting it. Record RSVP "accepted" once per
      // meeting/session so the host's attendee list reflects who's coming.
      // Fire-and-forget (never blocks entry); "accepted" is a SILENT status
      // update server-side (only declines are surfaced), so it adds no noise.
      if (!offlineDemo && tokenRef.current && !rsvpAcceptedRef.current.has(id)) {
        rsvpAcceptedRef.current.add(id);
        api.rsvpMeeting(tokenRef.current, id, "accepted").then(
          () => refetchMeetings(),
          () => {
            rsvpAcceptedRef.current.delete(id); // allow a later retry on failure
          },
        );
      }
    },
    [meetings, offlineDemo, refetchMeetings],
  );
  const onOpenTaskFromChat = useCallback((id: string) => {
    if (!id) return;
    setMode("tasks");
    setOpenTaskId(id);
  }, []);
  const onRejectMeeting = useCallback(
    async (id) => {
      if (offlineDemo || !tokenRef.current) return;
      try {
        await api.rsvpMeeting(tokenRef.current, id, "declined");
        refetchMeetings();
        showToast("Invitation declined");
      } catch (e) {
        showToast((e as any)?.message || "Couldn't decline the invitation");
      }
    },
    [offlineDemo, refetchMeetings, showToast],
  );
  useEffect(() => {
    if (deepLinkDoneRef.current) return;
    if (deepLinkRef.current === undefined) {
      try {
        deepLinkRef.current = new URLSearchParams(window.location.search).get(
          "meeting",
        );
      } catch {
        deepLinkRef.current = null;
      }
    }
    const id = deepLinkRef.current;
    // No `&& meetings.length` gate: a shared link must still land an authed user
    // in pre-join even when their meetings list is empty (a brand-new invitee).
    // onJoinMeeting tolerates an unknown meeting (falls back to title "Meeting")
    // and enterMeetingRoom is the real access gate.
    if (id && (offlineDemo || tokenRef.current)) {
      deepLinkDoneRef.current = true;
      onJoinMeeting(id);
    }
  }, [meetings, offlineDemo, onJoinMeeting]);
  const convLinkDoneRef = useRef(false);
  useEffect(() => {
    if (convLinkDoneRef.current) return;
    let cid: string | null = null;
    try {
      cid = new URLSearchParams(window.location.search).get("conversation");
    } catch {
      cid = null;
    }
    if (cid && (offlineDemo || tokenRef.current) && conversations.length) {
      convLinkDoneRef.current = true;
      setMode("chats");
      onSelect(cid);
    }
  }, [conversations, offlineDemo, onSelect]);
  useEffect(() => {
    if (!isDesktopApp || !authed) return;
    const off = subscribeDeepLinks((action) => {
      switch (action.kind) {
        case "new":
          // Jump-list / dock "New message" → the SAME composer the Rail's
          // "New message" button opens (setModal). Routes here via colab://new.
          setMode("chats");
          setModal({ type: "newMessage" });
          break;
        case "chat":
          setMode("chats");
          onSelect(action.conversationId);
          break;
        case "message":
          setMode("chats");
          onSelect(action.conversationId);
          setJumpMsgId(action.messageId);
          break;
        case "meeting":
          // Reuse the public meeting-join entry point (green room → enter).
          onJoinMeeting(action.meetingId);
          break;
        case "call":
          // Opening the conversation is the deep-link action; STARTING a call
          // stays an explicit user gesture (browser autoplay/permission rules).
          setMode("chats");
          onSelect(action.conversationId);
          break;
        case "presence":
          // Jump-list / dock "Available / Away / Do Not Disturb" → the SAME
          // presence setter the status menu uses (changeSetting("manualPresence",
          // …)), so it syncs to the server like a manual choice. The shell's
          // "available" maps to the app's default-online "auto"; away/busy map
          // 1:1. If WE'd auto-Away'd, an explicit choice here clears that flag so
          // the idle monitor won't later "restore" over it.
          autoAwayRef.current = false;
          changeSettingRef.current(
            "manualPresence",
            action.state === "available" ? "auto" : action.state,
          );
          break;
      }
    });
    return off;
  }, [authed, onSelect, onJoinMeeting]);
  useEffect(() => {
    if (!isDesktopApp) return;
    const cd = (window as any).collabDesktop;
    if (!cd || typeof cd.onGlobalShortcut !== "function") return;
    const off = cd.onGlobalShortcut((payload: { action?: string }) => {
      if (!payload || payload.action !== "toggle-pip") return;
      // Only meaningful while a session is docked; toggle the existing PiP state.
      if (hasCallSessionRef.current) setCallPip((v) => !v);
    });
    return typeof off === "function" ? off : undefined;
  }, []);
  onLeaveRoomRef.current = onLeaveRoom;
  const onUpdateMeeting = useCallback(
    async (id, patch) => {
      if (!offlineDemo && tokenRef.current) {
        try {
          await api.updateMeeting(tokenRef.current, id, patch);
          await refetchMeetings();
        } catch (e) {
          showToast((e as any)?.message || "Action failed");
        }
      }
    },
    [offlineDemo, refetchMeetings, showToast],
  );
  const onDeleteMeeting = useCallback(
    async (id, note?: string, opts?: any) => {
      // A single-OCCURRENCE cancel keeps the series in the list — only the
      // refetch below re-renders the calendar minus that occurrence (RCR-23).
      const occurrenceOnly = !!(opts && opts.scope === "occurrence");
      if (!occurrenceOnly) setMeetings((prev) => prev.filter((m) => m.id !== id));
      if (!offlineDemo && tokenRef.current) {
        try {
          if (note || occurrenceOnly) {
            await api.cancelMeeting(tokenRef.current, id, note, opts);
          } else {
            await api.deleteMeeting(tokenRef.current, id);
          }
          await refetchMeetings();
        } catch (e) {
          showToast((e as any)?.message || "Action failed");
        }
      }
    },
    [offlineDemo, refetchMeetings, showToast],
  );
  const onLeaveMeeting = useCallback(
    async (id) => {
      if (!offlineDemo && tokenRef.current) {
        try {
          await api.leaveMeeting(tokenRef.current, id);
          await refetchMeetings();
        } catch (e) {
          showToast((e as any)?.message || "Action failed");
        }
      }
    },
    [offlineDemo, refetchMeetings, showToast],
  );
  const onInviteMeeting = useCallback(
    async (id: string, userId: string) => {
      if (!offlineDemo && tokenRef.current) {
        try {
          await api.inviteMeetingAttendee(tokenRef.current, id, userId);
          await refetchMeetings();
        } catch (e) {
          showToast((e as any)?.message || "Action failed");
          throw e;
        }
      }
    },
    [offlineDemo, refetchMeetings, showToast],
  );
  const onCancelMeeting = useCallback(
    async (id) => {
      if (offlineDemo || !tokenRef.current) return;
      try {
        await api.cancelMeeting(tokenRef.current, id);
        await refetchMeetings();
      } catch (e) {
        showToast((e as any)?.message || "Couldn't cancel the meeting");
      }
    },
    [offlineDemo, refetchMeetings, showToast],
  );
  const onCompleteMeeting = useCallback(
    async (id) => {
      if (offlineDemo || !tokenRef.current) return;
      try {
        await api.completeMeeting(tokenRef.current, id);
        await refetchMeetings();
      } catch (e) {
        showToast((e as any)?.message || "Couldn't end the meeting");
      }
    },
    [offlineDemo, refetchMeetings, showToast],
  );
  const onBulkTasks = useCallback(
    async (action, value, ids) => {
      if (!ids || !ids.length) return;
      if (!offlineDemo && tokenRef.current) {
        try {
          const r: any = await api.bulkTasks(tokenRef.current, {
            ids,
            action,
            value,
          });
          await refetchTasks();
          // Some tasks may have been skipped by server-side dependency enforcement
          // (can't complete while blockers are open). Surface that — the refetch
          // already reflects that their status was left unchanged.
          const blocked = r && Array.isArray(r.blocked) ? r.blocked : [];
          if (blocked.length)
            showToast(
              `${blocked.length} task${
                blocked.length === 1 ? "" : "s"
              } couldn't be completed — still blocked by unfinished tasks.`,
            );
        } catch (e) {
          showToast((e as any)?.message || "Bulk action failed");
        }
      } else {
        setTasks((prev) =>
          prev
            .map((t) => {
              if (!ids.includes(t.id)) return t;
              if (action === "move") return { ...t, status: value };
              if (action === "complete") return { ...t, status: "done" };
              if (action === "archive") return { ...t, status: "archived" };
              if (action === "assign")
                return {
                  ...t,
                  assignee: users.find((u) => u.id === value) || null,
                };
              return t;
            })
            .filter((t) => !(action === "delete" && ids.includes(t.id))),
        );
      }
    },
    [offlineDemo, refetchTasks, users, showToast],
  );
  const onReply = useCallback(
    async (convId, parentId, text) => {
      if (!offlineDemo && tokenRef.current) {
        try {
          // E2EE-aware reply: a reply is just a child message — same encryption
          // rules as a top-level send. Without this, replies in an E2EE
          // conversation went to the server as plaintext text, hit the pinned
          // E2EE gate on the receiver, and rendered "[Unencrypted — rejected]".
          const conv = conversations.find((c) => c.id === convId);
          const mustEncrypt = !!(
            conv &&
            isE2EEEnabled() &&
            (conv.kind === "dm" ||
              conv.kind === "self" ||
              conv.kind === "group" ||
              conv.kind === "channel")
          );
          if (mustEncrypt) {
            let encrypted: any;
            if (conv!.kind === "dm" || conv!.kind === "self") {
              const otherId =
                conv!.members.find((m) => m !== meRef.current?.id) ||
                meRef.current?.id;
              if (!otherId) throw new Error("No recipient");
              encrypted = await encryptForUser(
                tokenRef.current!,
                otherId,
                text,
                convId,
                { useOpk: true, useRatchet: isRatchetEnabled() },
              );
            } else {
              const memberIds = (conv!.members || []).filter(Boolean);
              encrypted = await encryptForGroup(
                tokenRef.current!,
                convId,
                memberIds,
                text,
              );
            }
            // encryptFor* returns null when the DM peer has no E2EE device yet.
            // Emitting anyway sent {encrypted: null} with no text — a blank
            // message. And if this conversation is already pinned E2EE, a
            // plaintext fallback would be REJECTED by the recipient's downgrade
            // guard and shown as "[Unencrypted message — rejected]". So: pinned
            // → fail closed and keep the draft; not pinned → fall through to the
            // ordinary plaintext reply below.
            if (encrypted) {
              // Fan out via the same socket path sends use, so the server stores
              // the ciphertext envelope set and broadcasts to peers.
              const payload: any = {
                conversationId: convId,
                parentMessageId: parentId,
                encrypted,
                // Push-notification body only (server can't read the envelope).
                pushPreview: pushPreviewOf(text),
              };
              if (socketRef.current && connected) {
                socketRef.current.emit(EVENTS.MESSAGE_SEND, payload);
              }
              return { id: null, conversationId: convId, parentMessageId: parentId };
            }
            if (await isConvE2EERequired(convId)) {
              throw new Error(
                "This chat is end-to-end encrypted and the other device isn't ready yet. Your reply wasn't sent — please try again in a moment.",
              );
            }
          }
          return await api.sendMessage(
            tokenRef.current,
            convId,
            text,
            parentId,
          );
        } catch (e) {
          showToast((e as any)?.message || "Couldn't send reply");
          return null;
        }
      }
      const now = new Date();
      const m = {
        id: Math.random().toString(36).slice(2),
        conversationId: convId,
        me: true,
        sender: {
          name: "You",
          initials: "AJ",
          color: "#1a1a2e",
          avatarUrl: "",
        },
        text,
        time: now.toLocaleTimeString([], {
          hour: "numeric",
          minute: "2-digit",
        }),
        file: null,
        reactions: [],
        createdAt: now.toISOString(),
        parentMessageId: parentId,
      };
      appendMessage(m);
      bumpPreview(m);
      return m;
    },
    [offlineDemo, appendMessage, bumpPreview, conversations, connected, showToast],
  );
  const onStartCall = useCallback(
    (peer, video) => {
      if (!peer) return;
      if (activeCallRef.current) return;
      // Production gate: only block if the socket OBJECT doesn't exist at all
      // (which means connectSocket never ran — auth not loaded yet). We do NOT
      // gate on connected/handshake state because socket.io-client BUFFERS
      // emits across reconnects (default volatile=false), so a click during a
      // transient disconnect is sent the moment the socket re-establishes. If
      // it never does, the existing no-answer timeout fails the call cleanly.
      // This eliminates the entire false-offline class of bug.
      const s = socketRef.current;
      if (!s) {
        showToast("Still connecting — try again in a moment");
        return;
      }
      setActiveCall({
        callId: null,
        peer,
        kind: video ? "video" : "audio",
        dir: "out",
        status: "calling",
      });
      // I placed this 1:1 call, so I'm its host. Keyed by peer so the claim
      // survives the call being promoted to a group later on.
      markCallStarted(peer && peer.id);
      s.emit(EVENTS.CALL_REQUEST, {
        peerId: peer.id,
        kind: video ? "video" : "audio",
      });
    },
    [connected, showToast],
  );
  const STARTED_CALLS_KEY = "clb_started_calls";
  const startedCallsRef = useRef<Set<string>>(
    (() => {
      try {
        return new Set<string>(
          JSON.parse(sessionStorage.getItem(STARTED_CALLS_KEY) || "[]"),
        );
      } catch {
        return new Set<string>();
      }
    })(),
  );
  const markCallStarted = useCallback((key?: string | null) => {
    if (!key) return;
    startedCallsRef.current.add(key);
    try {
      sessionStorage.setItem(
        STARTED_CALLS_KEY,
        JSON.stringify([...startedCallsRef.current].slice(-50)), // bound growth
      );
    } catch {
      /* private mode / quota — in-memory set still works for this session */
    }
  }, []);
  const iStartedCall = useCallback(
    (key?: string | null) => !!key && startedCallsRef.current.has(key),
    [],
  );
  const enterHuddle = useCallback(
    (conversation, video, dir = "out") => {
      if (!conversation) return;
      if (activeCallRef.current) return;
      // Same production gate as onStartCall — only block if there's no socket
      // object at all; otherwise let socket.io buffer the emit until ready.
      const s = socketRef.current;
      if (!s) {
        showToast("Still connecting — try again in a moment");
        return;
      }
      const kind = video ? "video" : "audio";
      // Starting (not joining) a huddle makes me its host — remember it so a
      // later rejoin from the huddle bar doesn't demote me.
      if (dir === "out") markCallStarted(conversation.id);
      setActiveCall({
        callId: null,
        conversationId: conversation.id,
        kind,
        dir,
        status: "connected",
        group: true,
        name: conversation.name,
        peer: {
          id: conversation.id,
          name: conversation.name,
          initials:
            (conversation.avatar && conversation.avatar.initials) || "#",
          color:
            (conversation.avatar && conversation.avatar.color) || "#4f46e5",
          avatarUrl: conversation.avatar && conversation.avatar.avatarUrl,
        },
      });
      socketRef.current.emit(EVENTS.HUDDLE_JOIN, {
        conversationId: conversation.id,
        kind,
      });
    },
    [connected, showToast],
  );
  const currentActiveConv = useCallback(
    () =>
      conversationsRef.current.find((c) => c.id === activeIdRef.current) ||
      null,
    [],
  );
  const onManageFromChat = useCallback((id: string) => setManageConvId(id), []);
  const onBackToList = useCallback(() => setMobilePane("list"), []);
  const onAddParticipantsFromChat = useCallback(
    () => setModal({ type: "addParticipants" }),
    [],
  );
  const onJoinHuddleFromChat = useCallback(
    (video: boolean) => {
      const c = currentActiveConv();
      if (c) enterHuddle(c, video, "in");
    },
    [currentActiveConv, enterHuddle],
  );
  const acceptHandoff = useCallback(() => {
    const o = handoffOffer;
    if (!o) return;
    setHandoffOffer(null);
    try {
      socketRef.current &&
        socketRef.current.emit(EVENTS.HANDOFF_ACCEPT, {
          fromSessionId: o.fromSessionId,
          mode: o.mode,
        });
    } catch (_) {}
    if (o.kind === "meeting" && o.meetingId) {
      onJoinMeeting(o.meetingId);
      return;
    }
    // conversationId (group/upgraded call) takes precedence over callId —
    // the same precedence the token endpoint uses.
    if (o.conversationId) {
      const conv = (conversationsRef.current || []).find(
        (c: any) => c.id === o.conversationId,
      );
      if (conv) {
        enterHuddle(conv, !!o.video, "in");
        return;
      }
    }
    if (o.callId) {
      setActiveCall({
        callId: o.callId,
        conversationId: null,
        peer:
          o.peer || { name: o.title || "Call", initials: "?", color: "#4f46e5" },
        kind: o.video ? "video" : "audio",
        status: "connected",
        dir: "in",
        // "Continue here too" joins WITHOUT evicting the source device (the
        // call surface maps this to fresh:false on its token request).
        handoffJoin: o.mode === "join",
      });
    }
  }, [handoffOffer, onJoinMeeting, enterHuddle]);
  const declineHandoff = useCallback(() => {
    const o = handoffOffer;
    setHandoffOffer(null);
    if (o && socketRef.current) {
      try {
        socketRef.current.emit(EVENTS.HANDOFF_DECLINE, {
          fromSessionId: o.fromSessionId,
        });
      } catch (_) {}
    }
  }, [handoffOffer]);
  const onStartCallFromChat = useCallback(
    (video: boolean) => {
      const active = currentActiveConv();
      if (active && (active.kind === "group" || active.kind === "channel")) {
        enterHuddle(active, video, "out");
        return;
      }
      const me = meRef.current;
      const otherId = otherMemberId(active && active.members, me && me.id);
      const peer =
        usersRef.current.find((u: any) => u.id === otherId) ||
        (active
          ? {
              id: otherId || active.id,
              name: active.name,
              initials: (active.avatar && active.avatar.initials) || "?",
              color: (active.avatar && active.avatar.color) || "#4f46e5",
              avatarUrl: active.avatar && active.avatar.avatarUrl,
            }
          : null);
      if (peer) onStartCall(peer, video);
    },
    [currentActiveConv, enterHuddle, onStartCall],
  );
  const onScheduleMeetingFromChat = useCallback(() => {
    const c = currentActiveConv();
    const name = c && c.name;
    const meId = meRef.current?.id;
    setMeetingTitle(name ? "Meeting with " + name : "");
    let attendees: string[] = [];
    if (c && (c.kind === "group" || c.kind === "channel") && Array.isArray(c.members)) {
      attendees = c.members.map((m: any) => m.id || m).filter((id: string) => id !== meId);
    } else if (c && c.kind === "dm") {
      // Previously left empty for DMs — add the peer so the meeting isn't created
      // with nobody invited.
      const peerId = otherMemberId(c.members, meId);
      if (peerId) attendees = [peerId];
    }
    setMeetingAttendees(attendees);
    setMode("calendar");
  }, [currentActiveConv]);
  const acceptingRef = useRef(false);
  useEffect(() => {
    if (!activeCall) acceptingRef.current = false;
  }, [activeCall]);
  const onAcceptCall = useCallback(() => {
    const c = activeCallRef.current;
    if (!c) return;
    // Re-entry guard: a fast double-tap on Accept would emit CALL_ACCEPT twice —
    // the second one hits a now-connected call and surfaces a spurious "cannot
    // accept a connected call" error. Ignore taps until the next ring resets it.
    if (acceptingRef.current) return;
    acceptingRef.current = true;
    // Accepting a group-call invite → join the huddle (no 1:1 callId to accept).
    if (c.huddleRing && c.conversationId && socketRef.current) {
      socketRef.current.emit(EVENTS.HUDDLE_JOIN, {
        conversationId: c.conversationId,
        kind: c.kind,
      });
      setActiveCall({ ...c, status: "connected", huddleRing: false });
      try {
        refetchConversations();
      } catch (_) {}
      return;
    }
    if (c.callId && socketRef.current)
      socketRef.current.emit(EVENTS.CALL_ACCEPT, { callId: c.callId });
  }, [refetchConversations]);
  const onDeclineCall = useCallback((reason?: string) => {
    const c = activeCallRef.current;
    // A group-call invite has no ringing callId on the server — just dismiss
    // the prompt locally (the inviter isn't blocked waiting on us). If a quick-
    // reply was chosen, post it into the group like the 1:1 decline does.
    if (c && c.huddleRing) {
      const r = typeof reason === "string" ? reason.trim() : "";
      if (r && c.conversationId && tokenRef.current)
        api.sendMessage(tokenRef.current, c.conversationId, r).catch(() => {});
      setActiveCall(null);
      return;
    }
    if (c && c.callId && socketRef.current)
      socketRef.current.emit(EVENTS.CALL_DECLINE, {
        callId: c.callId,
        reason: typeof reason === "string" ? reason : undefined,
      });
    setActiveCall(null);
  }, []);
  const pendingCancelRef = useRef(false);
  const onCancelCall = useCallback(() => {
    const c = activeCallRef.current;
    if (c && c.callId && socketRef.current)
      socketRef.current.emit(EVENTS.CALL_CANCEL, { callId: c.callId });
    else if (c && c.dir === "out" && !c.callId) pendingCancelRef.current = true;
    setActiveCall(null);
  }, []);
  maybeShowFeedbackRef.current = maybeShowFeedback;
  const onHangup = useCallback((seconds, meta?: any) => {
    const c = activeCallRef.current;
    console.warn(
      "[call] ON_HANGUP callId=%s convId=%s seconds=%s ts=%d",
      c && c.callId,
      c && c.conversationId,
      seconds,
      Date.now(),
    );
    console.trace("[call] ON_HANGUP_TRACE");
    if (c && c.conversationId && socketRef.current)
      socketRef.current.emit(EVENTS.HUDDLE_LEAVE, {
        conversationId: c.conversationId,
      });
    if (c && c.callId && socketRef.current)
      socketRef.current.emit(EVENTS.CALL_HANGUP, {
        callId: c.callId,
        durationSec: seconds || 0,
      });
    setActiveCall(null);
    // Post-call feedback (#67): only the user-initiated "Leave" button passes
    // `meta` (with connected/netQuality). Automatic hangups (grace-expiry after a
    // peer drop, DUPLICATE_IDENTITY, etc.) call onHangup WITHOUT meta and are
    // therefore never eligible — matching the spec's "normal user-initiated end".
    if (meta)
      maybeShowFeedbackRef.current({
        kind: "call",
        callId: (c && c.callId) || meta.callId || null,
        durationSec: seconds || 0,
        netQuality: meta.netQuality,
        connected: !!meta.connected,
      });
  }, []);
  const onAddToCall = useCallback(
    async (userIds) => {
      const c = activeCallRef.current;
      if (!c || !Array.isArray(userIds) || !userIds.length) return;
      if (!c.conversationId && !c.callId) return;
      if (offlineDemo || !tokenRef.current) {
        showToast("Connect to a workspace to add people");
        return;
      }
      try {
        let convId = c.conversationId;
        if (!convId) {
          // 1:1 call → promote to a group call. The server builds a group
          // conversation from both parties + the invitees and auto-migrates the
          // other party (CALL_UPGRADED); we migrate THIS leg locally so the call
          // effect reconnects to the new "conv_<id>" room.
          const res: any = await api.addCallParticipants(
            tokenRef.current,
            c.callId,
            userIds,
          );
          convId = res && res.conversationId;
          if (!convId) throw new Error("Couldn't start the group call");
          setActiveCall((cur) =>
            cur && cur.callId === c.callId
              ? { ...cur, conversationId: convId, callId: undefined }
              : cur,
          );
          // Join the new group huddle's conversation room so this socket also
          // receives its messages/system pills. The server already registered us
          // for the ring (add-participants route), so this is additive/idempotent.
          if (socketRef.current)
            socketRef.current.emit(EVENTS.HUDDLE_JOIN, {
              conversationId: convId,
              kind: c.kind,
            });
        } else {
          await api.addMembers(tokenRef.current, convId, userIds);
        }
        await refetchConversations();
        if (socketRef.current)
          socketRef.current.emit(EVENTS.HUDDLE_RING, {
            conversationId: convId,
            userIds,
          });
        showToast(
          userIds.length > 1
            ? "People added to the call"
            : "Person added to the call",
        );
      } catch (e) {
        showToast((e as any)?.message || "Couldn't add to the call");
      }
    },
    [offlineDemo, refetchConversations, showToast],
  );
  useEffect(() => {
    activeCallRef.current = activeCall;
  }, [activeCall]);
  useEffect(() => {
    const st = activeCall && activeCall.status;
    if (st === "ringing" || st === "calling") startRingtone();
    else stopRingtone();
    return () => stopRingtone();
  }, [activeCall ? activeCall.status : null, startRingtone, stopRingtone]);
  const lastIncomingRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isDesktopApp) return;
    const cd = (window as any).collabDesktop;
    if (!cd) return;
    const c = activeCall;
    const isIncomingRing = !!c && c.status === "ringing" && c.dir === "in";
    if (isIncomingRing) {
      // Presentation Mode (P0-11): no taskbar flash / native call surface
      // while presenting — the call quietly becomes a missed-call entry.
      if (presentationDndActive()) return;
      // De-dupe: only fire the native surface once per distinct ring.
      const key = String(c.callId || c.conversationId || "ring");
      if (lastIncomingRef.current === key) return;
      lastIncomingRef.current = key;
      const who = (c.peer && c.peer.name) || c.name || "Someone";
      const title =
        "Incoming " + (c.kind === "video" ? "video " : "") + "call";
      const body = who + " is calling";
      try {
        if (typeof cd.incomingCall === "function")
          cd.incomingCall({ id: key, title, body });
      } catch (_) {}
    } else if (lastIncomingRef.current !== null) {
      // Ring resolved (connected / declined / ended / missed) → stop the flash.
      lastIncomingRef.current = null;
      try {
        if (typeof cd.callCleared === "function") cd.callCleared();
      } catch (_) {}
    }
  }, [activeCall]);
  const callActiveDesktop =
    (!!activeCall && activeCall.status === "connected") || !!roomState;
  useEffect(() => {
    if (!isDesktopApp) return;
    const cd = (window as any).collabDesktop;
    if (!cd || typeof cd.setCallActive !== "function") return;
    try { cd.setCallActive(callActiveDesktop); } catch (_) {}
    // On unmount, ensure the blocker is released.
    return () => { try { cd.setCallActive(false); } catch (_) {} };
  }, [callActiveDesktop]);
  const onAcceptCallRef = useRef(onAcceptCall);
  onAcceptCallRef.current = onAcceptCall;
  const onDeclineCallRef = useRef(onDeclineCall);
  onDeclineCallRef.current = onDeclineCall;
  const reminderActionRef = useRef<{
    complete: (id: string) => void;
    snooze: (id: string, minutes?: number) => void;
    open: (id: string) => void;
  }>({ complete: () => {}, snooze: () => {}, open: () => {} });
  const taskActionRef = useRef<{
    complete: (id: string) => void;
    open: (id: string) => void;
  }>({ complete: () => {}, open: () => {} });
  const fileActionRef = useRef<(id: string) => void>(() => {});
  fileActionRef.current = (id: string) => {
    setMode("files");
    setOpenFileId(id);
  };
  // Chat-message notification click (desktop OS notification): open the
  // conversation the message belongs to and jump to that message — the same
  // target the web service worker resolves for type message/mention/reply.
  const chatActionRef = useRef<(cid: string, messageId?: string) => void>(() => {});
  chatActionRef.current = (cid: string, messageId?: string) => {
    onSelect(cid);
    setMode("chats");
    if (messageId) setJumpMsgId(messageId);
  };
  const orgActionRef = useRef<(type: string) => void>(() => {});
  orgActionRef.current = (type: string) => {
    if (type === "org_broadcast") {
      setOrgTab("broadcasts");
      setMode("org");
    } else if (type === "org_join_request") {
      setOrgTab("requests");
      setMode("org");
    } else {
      setMode("activity");
    }
  };
  useEffect(() => {
    if (!isDesktopApp) return;
    const cd = (window as any).collabDesktop;
    if (!cd || typeof cd.onNotificationAction !== "function") return;
    const off = cd.onNotificationAction((action: string, data?: any) => {
      const d = data || {};
      // Reminder notification (type "reminder" / targetType "reminder").
      if (d.type === "reminder" || d.targetType === "reminder") {
        const rid = d.targetId || d.id;
        if (!rid) return;
        if (action === "complete") reminderActionRef.current.complete(rid);
        else if (action === "snooze") reminderActionRef.current.snooze(rid, 10);
        else reminderActionRef.current.open(rid); // plain click → open + focus
        return;
      }
      // Task notification (task_due / task_assigned / task_completed, or
      // targetType "task"). "complete" → mark done; any other → open the task.
      if (d.type === "task_due" || d.type === "task_assigned" || d.type === "task_completed" || d.targetType === "task") {
        const tid = d.targetId || d.id;
        if (!tid) return;
        if (action === "complete") taskActionRef.current.complete(tid);
        else taskActionRef.current.open(tid); // view / plain click → open + focus
        return;
      }
      // File-share notification (type "file_shared" / targetType "file"). Any
      // click opens the Files module focused on the file (no per-action buttons).
      if (d.type === "file_shared" || d.targetType === "file") {
        const fid = d.targetId || d.id;
        if (!fid) return;
        fileActionRef.current(fid);
        return;
      }
      // Organization (BA #6): a desktop OS notification for a broadcast opens the
      // Organization module on Broadcasts; a join request opens Join requests.
      // Other org news is personal and belongs in Activity — same split as the
      // web SW + in-app paths, so all three routes agree.
      if (d.type === "org_broadcast" || d.type === "org_join_request" || d.targetType === "org") {
        orgActionRef.current(d.type);
        return;
      }
      // Chat messages (type message / mention / reply / reaction, or a missed
      // call, which the web SW also routes to its conversation). ANY click or the
      // "Reply" / "Mark read" buttons open that conversation (opening it also marks
      // it read). Needs a conversationId; an incoming-call ring is handled below.
      if (
        d.conversationId &&
        (d.type === "message" || d.type === "mention" || d.type === "reply" ||
          d.type === "reaction" || d.type === "call_missed" || d.targetType === "message")
      ) {
        const isMsg = d.type !== "call_missed";
        chatActionRef.current(d.conversationId, isMsg ? (d.id || d.targetId || undefined) : undefined);
        return;
      }
      // Calls (Answer / Decline) — only while a call is actually ringing.
      const c = activeCallRef.current;
      const ringing = !!c && c.status === "ringing" && c.dir === "in";
      if (!ringing) return; // no-op unless a call is actually ringing
      if (action === "answer") onAcceptCallRef.current();
      else if (action === "decline") onDeclineCallRef.current();
    });
    return typeof off === "function" ? off : undefined;
  }, []);
  useEffect(() => {
    if (!isDesktopApp) return;
    const cd = (window as any).collabDesktop;
    if (!cd || typeof cd.onGlobalShortcut !== "function") return;
    const off = cd.onGlobalShortcut((payload: { action?: string }) => {
      if (!payload) return;
      if (payload.action !== "answer-call" && payload.action !== "decline-call")
        return;
      const c = activeCallRef.current;
      const ringing = !!c && c.status === "ringing" && c.dir === "in";
      if (!ringing) return; // only act on a real ringing call
      if (payload.action === "answer-call") onAcceptCallRef.current();
      else onDeclineCallRef.current();
    });
    return typeof off === "function" ? off : undefined;
  }, []);
  changeSettingRef.current = changeSetting;
  const autoAwayRef = useRef(false);
  useEffect(() => {
    if (!isDesktopApp) return;
    const cd = (window as any).collabDesktop;
    if (!cd || typeof cd.onPresenceAuto !== "function") return;
    const off = cd.onPresenceAuto((payload: { state?: string }) => {
      const state = payload && payload.state;
      const current = (settingsRef.current &&
        settingsRef.current.manualPresence) || "auto";
      if (state === "away") {
        // Only auto-Away the default-online user; never clobber a manual choice.
        if (current === "auto") {
          autoAwayRef.current = true;
          changeSettingRef.current("manualPresence", "away");
        }
      } else if (state === "active") {
        // Restore ONLY if WE auto-set Away (don't undo a manual Away/DND/online).
        if (autoAwayRef.current && current === "away") {
          autoAwayRef.current = false;
          changeSettingRef.current("manualPresence", "auto");
        } else {
          autoAwayRef.current = false;
        }
      }
    });
    return typeof off === "function" ? off : undefined;
  }, []);

  return {
    onGlobalSearch,
    openConvTargetRef,
    onSelectPerson,
    onCreateMeeting,
    onPreviewOccurrences,
    onCheckAvailability,
    onMeetingPreview,
    enterMeetingNow,
    rsvpAcceptedRef,
    onJoinMeeting,
    onOpenTaskFromChat,
    onRejectMeeting,
    convLinkDoneRef,
    onUpdateMeeting,
    onInviteMeeting,
    onDeleteMeeting,
    onLeaveMeeting,
    onCancelMeeting,
    onCompleteMeeting,
    onBulkTasks,
    onReply,
    onStartCall,
    STARTED_CALLS_KEY,
    startedCallsRef,
    markCallStarted,
    iStartedCall,
    enterHuddle,
    currentActiveConv,
    onManageFromChat,
    onBackToList,
    onAddParticipantsFromChat,
    onJoinHuddleFromChat,
    acceptHandoff,
    declineHandoff,
    onStartCallFromChat,
    onScheduleMeetingFromChat,
    acceptingRef,
    onAcceptCall,
    onDeclineCall,
    pendingCancelRef,
    onCancelCall,
    onHangup,
    onAddToCall,
    lastIncomingRef,
    callActiveDesktop,
    onAcceptCallRef,
    onDeclineCallRef,
    reminderActionRef,
    taskActionRef,
    fileActionRef,
    chatActionRef,
    orgActionRef,
    autoAwayRef,
  };
}
