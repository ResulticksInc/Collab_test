import { useState, useEffect, useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import Avatar from "./Avatar";
import { api } from "../lib/api";
import { EVENTS } from "../lib/socket";
import PublicLinkControl from "./PublicLinkControl";

const MeetingStage = dynamic(() => import("./MeetingStage"), {
  ssr: false,
  loading: () => (
    <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", background: "#000", color: "#fff" }}>
      Loading meeting stage...
    </div>
  ),
});
import {
  IconMessageCircle,
  IconUsers,
  IconX,
  IconSearch,
  IconCheck,
  IconMicOff,
} from "../lib/icons";

// The lobby projection carries only name/initials/color/avatarUrl (no contact
// details), so this maps it onto Avatar's shape with sane fallbacks.
const lobbyAvatar = (p: any) => ({
  kind: "user" as const,
  initials:
    p?.initials ||
    (p?.name || "?")
      .split(/\s+/)
      .slice(0, 2)
      .map((w: string) => w[0])
      .join("")
      .toUpperCase(),
  color: p?.color || "var(--ac)",
  avatarUrl: p?.avatarUrl || null,
});

// "waiting 2m" — how long someone has been knocking. A host triaging a queue
// needs to know who has been out there longest.
const waitedFor = (iso: string) => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const mins = Math.max(0, Math.floor((Date.now() - t) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h`;
};

const STATE_LABEL: Record<string, string> = {
  scheduled: "Scheduled",
  starting: "Starting",
  waiting: "Waiting for participants",
  active: "Active",
  completed: "Completed",
  cancelled: "Cancelled",
  expired: "Expired",
};

export default function MeetingRoom({
  room,
  me,
  token,
  socket,
  offline,
  onLeave,
  onToast,
  settings,
  onChangeSetting,
  users,
  conversations,
  initialMic,
  initialCam,
  onMinimize,
  onMoveDevice,
  onOpenComms,
  commsUnread,
  pip,
  isGuest = false,
}: any) {
  const [r, setR] = useState<any>(room);
  const [showRecs, setShowRecs] = useState(false);
  const [showMore, setShowMore] = useState(false);
  // Share-invitation picker: DM / Group / Channel tabs, search + per-target
  // invite/reminder, optimistic state. `invitedLocal` holds both user ids and
  // conversation ids (ids are globally unique).
  const [shareOpen, setShareOpen] = useState(false);
  const [shareTab, setShareTab] = useState<"dm" | "group">("dm");
  const invitePopRef = useRef<HTMLDivElement | null>(null);
  const [shareQuery, setShareQuery] = useState("");
  const [invitedLocal, setInvitedLocal] = useState<Set<string>>(new Set());
  const [reminded, setReminded] = useState<Set<string>>(new Set());
  // Multi-select invite: click a row to select, click again to DESELECT, then
  // "Send invites (N)" — instead of the old send-on-each-click (which re-sent).
  const [inviteSel, setInviteSel] = useState<Set<string>>(new Set());
  const [recs, setRecs] = useState<any[]>([]);
  const [lobbyQueue, setLobbyQueue] = useState<any[]>([]);
  const [lobbyStatus, setLobbyStatus] = useState<string | null>(
    room?.lobbyStatus || null,
  );
  // What the WAITING screen shows: meeting title, host, whether the meeting has
  // started, who is already inside, and who else is holding with you. Comes back
  // from /room/enter and is refreshed by the poll below, so the numbers on that
  // screen are live rather than a snapshot from the moment you knocked.
  const [lobbyInfo, setLobbyInfo] = useState<any>(room?.lobby || null);
  // A lobby response carries no `meeting` (you are not in it yet) — its id is at
  // the top level. Without this fallback the wait screen's poll had no id and
  // never ran.
  const meetingId = (r && r.meeting && r.meeting.id) || (r && r.meetingId) || null;
  const inLobby = lobbyStatus === "waiting" || lobbyStatus === "denied";
  const isHost = r?.isHost;
  const isCoHost =
    r?.meeting?.attendees?.some(
      (a: any) => a.id === me?.id && a.role === "co-host",
    ) || false;
  const canControl = isHost || isCoHost;
  const lobbyEnabled = r?.meeting?.lobbyEnabled ?? false;

  useEffect(() => {
    setR(room);
    if (room?.lobbyStatus) setLobbyStatus(room.lobbyStatus);
    if (room?.lobby) setLobbyInfo(room.lobby);
  }, [room]);

  useEffect(() => {
    if (!meetingId || offline) return;
    const onPresence = (e: any) => {
      if (e && e.meetingId === meetingId)
        setR((cur: any) =>
          cur
            ? {
                ...cur,
                count: e.count,
                state: e.state,
                participants: e.participants,
              }
            : cur,
        );
    };
    const onUpdated = (e: any) => {
      if (e && e.meetingId === meetingId) {
        // A recording may have just been saved — refresh the list. (Guests of a
        // public link can't list recordings — skip the request that would 403.)
        if (!isGuest) api.getRecordings(token, meetingId).then((x: any) => setRecs(x || [])).catch(() => {});
        if (e.lobbyAdmitted) {
          setLobbyStatus("admitted");
          api
            .enterMeetingRoom(token, meetingId)
            .then((next: any) => {
              if (next && next.meeting) {
                setR(next);
                setLobbyStatus(null);
              }
            })
            .catch(() => {});
        }
        if (e.lobbyDenied) setLobbyStatus("denied");
      }
    };
    if (socket) {
      socket.on("meeting:presence", onPresence);
      socket.on("meeting:updated", onUpdated);
    }
    // Room keepalive — only for someone actually IN the room. Beating from the
    // lobby would be a request every 20s that can never do anything (there is no
    // presence row to touch until you are admitted).
    const hb = inLobby
      ? null
      : setInterval(async () => {
          if (!token) return;
          try {
            const next = await api.meetingRoomHeartbeat(token, meetingId);
            if (next && next.meeting) setR(next);
          } catch {
            /* transient */
          }
        }, 20000);
    return () => {
      if (socket) {
        socket.off("meeting:presence", onPresence);
        socket.off("meeting:updated", onUpdated);
      }
      if (hb) clearInterval(hb);
    };
  }, [meetingId, socket, token, offline, inLobby]);

  useEffect(() => {
    if (!meetingId || offline || !token || inLobby || isGuest) return;
    let live = true;
    api
      .getRecordings(token, meetingId)
      .then((x: any) => live && setRecs(x || []))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [meetingId, offline, token, inLobby]);

  const deleteRec = useCallback(async (rid: string) => {
    if (!token || !meetingId) return;
    try {
      await api.deleteRecording(token, meetingId, rid);
      setRecs((prev: any[]) => prev.filter((x) => x.id !== rid));
      onToast && onToast("Recording deleted.");
    } catch {
      onToast && onToast("Couldn't delete the recording.");
    }
  }, [token, meetingId, onToast]);

  const refreshLobby = useCallback(async () => {
    if (!canControl || !token || !meetingId) return;
    try {
      const list = await api.getMeetingLobby(token, meetingId);
      setLobbyQueue((list || []).filter((p: any) => p.status === "waiting"));
    } catch {}
  }, [canControl, token, meetingId]);

  useEffect(() => {
    if (!canControl || !lobbyEnabled) return;
    refreshLobby();
    const iv = setInterval(refreshLobby, 5000);
    return () => clearInterval(iv);
  }, [canControl, lobbyEnabled, refreshLobby]);

  // While you are in the lobby you are NOT in the meeting's socket room, so no
  // presence event reaches you — without this poll the wait screen would freeze
  // on the numbers it was born with and would only unblock if the admit event
  // happened to arrive. Reads the status endpoint rather than re-POSTing
  // /room/enter: that call MUTATES, and a denied person would be re-queued by
  // their own poll.
  useEffect(() => {
    if (lobbyStatus !== "waiting" || !token || !meetingId || offline) return;
    let live = true;
    const tick = async () => {
      try {
        const s0: any = await api.getMyLobbyStatus(token, meetingId);
        if (!live || !s0) return;
        if (s0.lobby) setLobbyInfo(s0.lobby);
        if (s0.status === "admitted") {
          const next: any = await api.enterMeetingRoom(token, meetingId);
          if (live && next && next.meeting) {
            setR(next);
            setLobbyStatus(null);
          }
        } else if (s0.status === "denied") {
          setLobbyStatus("denied");
        }
      } catch {
        /* transient — the next tick retries */
      }
    };
    tick();
    const iv = setInterval(tick, 5000);
    return () => {
      live = false;
      clearInterval(iv);
    };
  }, [lobbyStatus, token, meetingId, offline]);

  // Close invite popover when clicking outside it
  useEffect(() => {
    if (!shareOpen) return;
    const handler = (e: MouseEvent) => {
      if (invitePopRef.current && !invitePopRef.current.contains(e.target as Node))
        setShareOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [shareOpen]);

  // ── Lobby waiting room (Teams-style) ────────────────────────────────────
  // The old screen said "Waiting to be admitted" and nothing else — no meeting
  // name, no sign anyone was in there, no idea whether the wait was 5 seconds or
  // the host hadn't arrived. It now answers the three questions someone standing
  // outside actually has: what am I waiting for, has it started and who is in
  // it, and am I alone out here.
  if (lobbyStatus === "waiting") {
    const li = lobbyInfo || {};
    const inRoom: any[] = li.participants || [];
    const alsoWaiting: any[] = li.waiting || [];
    const shownIn = inRoom.slice(0, 6);
    const shownWaiting = alsoWaiting.slice(0, 6);
    return (
      <div className="mr-overlay" role="dialog" aria-label="Meeting lobby">
        <div className="mr-lobby-card">
          <div className="mr-lobby-glyph" aria-hidden="true">
            <IconUsers size={26} />
            <span className="mr-lobby-pulse" />
          </div>
          <h2 className="mr-lobby-h">Waiting for someone to let you in</h2>
          {li.title ? <div className="mr-lobby-sub">{li.title}</div> : null}

          {/* Has it started, and who is in there. This is the single most useful
              fact for someone waiting — a meeting nobody has joined yet reads
              very differently from one already running with eight people. */}
          <div className={"mr-lobby-state" + (li.started ? " live" : "")}>
            <span className="mr-lobby-dot" aria-hidden="true" />
            {li.started
              ? `In progress · ${li.count} ${li.count === 1 ? "person" : "people"} in the meeting`
              : li.hostName
                ? `Not started yet · waiting for ${li.hostName}`
                : "Not started yet"}
          </div>

          {shownIn.length > 0 ? (
            <div className="mr-lobby-group">
              <div className="mr-lobby-group-t">Already in the meeting</div>
              <div className="mr-lobby-people">
                {shownIn.map((p: any) => (
                  <div className="mr-lobby-person" key={p.id}>
                    <Avatar avatar={lobbyAvatar(p)} size={28} />
                    <span className="mr-lobby-person-n">
                      {p.name}
                      {p.isHost ? <em className="mr-lobby-tag">Host</em> : null}
                    </span>
                  </div>
                ))}
                {inRoom.length > shownIn.length ? (
                  <div className="mr-lobby-more">
                    +{inRoom.length - shownIn.length} more
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          {shownWaiting.length > 0 ? (
            <div className="mr-lobby-group">
              <div className="mr-lobby-group-t">
                Waiting with you ({alsoWaiting.length})
              </div>
              <div className="mr-lobby-people">
                {shownWaiting.map((p: any) => (
                  <div className="mr-lobby-person" key={p.id}>
                    <Avatar avatar={lobbyAvatar(p)} size={28} />
                    <span className="mr-lobby-person-n">{p.name}</span>
                  </div>
                ))}
                {alsoWaiting.length > shownWaiting.length ? (
                  <div className="mr-lobby-more">
                    +{alsoWaiting.length - shownWaiting.length} more
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          <div className="mr-lobby-foot">
            <div className="mr-wait-spinner" />
            <span>
              {li.started
                ? "Someone in the meeting will admit you."
                : "You’ll be let in when the meeting starts."}
            </span>
          </div>
          <button className="mr-btn mr-leave mr-lobby-leave" onClick={onLeave}>
            Leave
          </button>
        </div>
      </div>
    );
  }

  if (lobbyStatus === "denied") {
    return (
      <div className="mr-overlay" role="dialog" aria-label="Meeting lobby">
        <div className="mr-lobby-card">
          <div className="mr-lobby-glyph denied" aria-hidden="true">
            <IconUsers size={26} />
          </div>
          <h2 className="mr-lobby-h">You weren&rsquo;t admitted</h2>
          <div className="mr-lobby-sub">
            {lobbyInfo?.title
              ? `Someone in "${lobbyInfo.title}" declined your request to join.`
              : "Someone in the meeting declined your request to join."}
          </div>
          <button className="mr-btn mr-lobby-leave" onClick={onLeave}>
            Go back
          </button>
        </div>
      </div>
    );
  }

  if (!r || !r.meeting) return null;
  const m = r.meeting;
  const count = r.count || 0;
  const state = r.state;
  const attendees = m.attendees || [];

  let waitMsg = "";
  if (state === "active") waitMsg = "";
  else if (state === "completed") waitMsg = "This meeting has ended.";
  else if (state === "cancelled") waitMsg = "This meeting was cancelled.";
  else if (isHost) waitMsg = "Waiting for participants to join.";
  else if (!r.hostPresent)
    waitMsg = "Waiting for the host to start the meeting.";
  else waitMsg = "You are the first participant in this meeting.";

  // Invite a person directly into their DM (also adds them as an attendee). The
  // invite card carries Join/Reject, masked until 10 min before start. The row
  // flips to "Yet to join" only after the send succeeds.
  const sendInvite = async (uid: string, name?: string) => {
    if (!token || !meetingId || !uid) return;
    try {
      await api.inviteMeetingAttendee(token, meetingId, uid);
      setInvitedLocal((prev) => new Set(prev).add(uid));
      onToast && onToast(`Invitation sent${name ? " to " + name : ""}.`);
    } catch {
      onToast && onToast("Couldn't send the invitation. Please try again.");
    }
  };
  // Re-send the invitation as a gentle reminder to someone who hasn't joined.
  const sendReminder = async (uid: string, name?: string) => {
    if (!token || !meetingId || !uid) return;
    try {
      await api.inviteMeetingAttendee(token, meetingId, uid);
      setReminded((prev) => new Set(prev).add(uid));
      onToast && onToast(`Reminder sent${name ? " to " + name : ""}.`);
    } catch {
      onToast && onToast("Couldn't send the reminder. Please try again.");
    }
  };
  // Post the invitation into a whole group/channel (everyone there sees it).
  const sendConvInvite = async (cid: string, name?: string) => {
    if (!token || !meetingId || !cid) return;
    try {
      await api.inviteMeetingConversation(token, meetingId, cid);
      setInvitedLocal((prev) => new Set(prev).add(cid));
      onToast && onToast(`Invitation posted${name ? " to " + name : ""}.`);
    } catch {
      onToast && onToast("Couldn't post the invitation. Please try again.");
    }
  };
  const sendConvReminder = async (cid: string, name?: string) => {
    if (!token || !meetingId || !cid) return;
    try {
      await api.inviteMeetingConversation(token, meetingId, cid);
      setReminded((prev) => new Set(prev).add(cid));
      onToast && onToast(`Reminder posted${name ? " to " + name : ""}.`);
    } catch {
      onToast && onToast("Couldn't post the reminder. Please try again.");
    }
  };
  // Toggle a row in/out of the pending invite selection (click = select, click
  // again = deselect). Nothing is sent until "Send invites".
  const toggleInviteSel = (id: string) =>
    setInviteSel((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  // Send every selected person/group in one go, then clear the selection.
  const sendSelected = async () => {
    if (!token || !meetingId) return;
    const ids = Array.from(inviteSel);
    let ok = 0;
    for (const id of ids) {
      const u = (users || []).find((x: any) => x && x.id === id);
      const c = u
        ? null
        : (conversations || []).find((x: any) => x && x.id === id);
      try {
        if (u) {
          await api.inviteMeetingAttendee(token, meetingId, u.id);
          setInvitedLocal((p) => new Set(p).add(u.id));
          ok++;
        } else if (c) {
          await api.inviteMeetingConversation(token, meetingId, c.id);
          setInvitedLocal((p) => new Set(p).add(c.id));
          ok++;
        }
      } catch {
        /* skip the ones that fail; report the count that worked */
      }
    }
    setInviteSel(new Set());
    onToast &&
      onToast(
        ok ? `Sent ${ok} invite${ok !== 1 ? "s" : ""}.` : "Couldn't send invites.",
      );
  };
  const activeRec = recs.find((x: any) => x.status === "recording");
  const toggleRecord = async () => {
    if (!token || !meetingId) return;
    try {
      if (activeRec) await api.stopRecording(token, meetingId, activeRec.id);
      else await api.startRecording(token, meetingId);
      onToast && onToast(activeRec ? "Recording stopped" : "Recording started");
    } catch (e: any) {
      onToast && onToast((e && e.message) || "Recording action failed");
    }
    const x = await api.getRecordings(token, meetingId).catch(() => []);
    setRecs(x || []);
  };
  // ONE-WAY — each participant unmutes themselves (consent stays with them).
  const muteAll = async () => {
    if (!token || !meetingId) return;
    try {
      await api.muteAllMeetingParticipants(token, meetingId);
      onToast && onToast("Participants muted — each person can unmute themselves.");
    } catch (e: any) {
      onToast && onToast((e && e.message) || "Mute all failed");
    }
  };
  const muteParticipant = async (userId: string) => {
    if (!token || !meetingId) return;
    try {
      await api.muteMeetingParticipant(token, meetingId, userId, true);
      onToast && onToast("Participant muted");
    } catch (e: any) {
      onToast && onToast((e && e.message) || "Mute failed");
    }
  };
  const removeParticipant = async (userId: string) => {
    if (!token || !meetingId) return;
    try {
      await api.removeMeetingParticipant(token, meetingId, userId);
      onToast && onToast("Participant removed");
    } catch (e: any) {
      onToast && onToast((e && e.message) || "Remove failed");
    }
  };
  const admitParticipant = async (userId: string) => {
    if (!token || !meetingId) return;
    try {
      await api.admitLobbyParticipant(token, meetingId, userId);
      onToast && onToast("Participant admitted");
      refreshLobby();
    } catch (e: any) {
      onToast && onToast((e && e.message) || "Admit failed");
    }
  };
  const denyParticipant = async (userId: string) => {
    if (!token || !meetingId) return;
    try {
      await api.denyLobbyParticipant(token, meetingId, userId);
      onToast && onToast("Participant denied");
      refreshLobby();
    } catch (e: any) {
      onToast && onToast((e && e.message) || "Deny failed");
    }
  };
  const admitAll = async () => {
    if (!token || !meetingId) return;
    try {
      await api.admitAllLobby(token, meetingId);
      onToast && onToast("All participants admitted");
      refreshLobby();
    } catch (e: any) {
      onToast && onToast((e && e.message) || "Admit all failed");
    }
  };
  const promoteCoHost = async (userId: string) => {
    if (!token || !meetingId) return;
    try {
      await api.promoteMeetingCoHost(token, meetingId, userId);
      onToast && onToast("Promoted to co-host");
    } catch (e: any) {
      onToast && onToast((e && e.message) || "Promote failed");
    }
  };
  const demoteCoHost = async (userId: string) => {
    if (!token || !meetingId) return;
    try {
      await api.demoteMeetingCoHost(token, meetingId, userId);
      onToast && onToast("Demoted to participant");
    } catch (e: any) {
      onToast && onToast((e && e.message) || "Demote failed");
    }
  };

  return (
    <div className="mr-overlay" role="dialog" aria-label="Meeting room">
      <div className="mr-shell" style={{ position: "relative" }}>
        <div className={"mr-stage" + (state !== "active" ? " mr-stage-idle" : "")}>
          <MeetingStage
            meetingId={m.id}
            token={token}
            offline={offline}
            onToast={onToast}
            isHost={isHost}
            isCoHost={isCoHost}
            meetingLocked={!!m.locked}
            socket={socket}
            onLeave={onLeave}
            onToggleRecord={toggleRecord}
            recording={!!activeRec}
            onPromoteCoHost={promoteCoHost}
            onDemoteCoHost={demoteCoHost}
            meId={me?.id}
            hostId={m.hostId}
            coHostIds={new Set(attendees.filter((a: any) => a.role === "co-host").map((a: any) => a.id))}
            settings={settings}
            onChangeSetting={onChangeSetting}
            initialMic={initialMic}
            initialCam={initialCam}
            meetingTitle={m.title || "Meeting"}
            onMinimize={onMinimize}
            pip={!!pip}
            onMoveDevice={onMoveDevice}
            onOpenComms={onOpenComms}
            commsUnread={commsUnread}
            onMoreOptions={() => setShowMore((v) => !v)}
            onInvite={isGuest ? undefined : () => setShareOpen((v) => !v)}
            isGuest={isGuest}
            onRecordings={() => {
              const opening = !(showMore && showRecs);
              setShowRecs(opening); setShowMore(opening);
            }}
            inviteActive={shareOpen}
            recsActive={showMore && showRecs}
            recCount={recs.length}
            meetingConversationId={m.conversationId || null}
            meetingAttendeeIds={attendees.map((a: any) => a.id)}
          />
          {waitMsg && state !== "active" ? (
            <div className="mr-wait-hero">
              <div className="mr-wait-pulse" aria-hidden="true">
                <IconUsers />
              </div>
              <div className="mr-wait-title">{m.title || "Meeting"}</div>
              <div className="mr-wait-msg">{waitMsg}</div>
            </div>
          ) : null}
        </div>

        {/* Lobby queue: floating panel at top-right of the stage. This is the
            host's half of the waiting room — the people knocking, how long they
            have been there, and one click each to admit or decline. */}
        {canControl && lobbyEnabled && lobbyQueue.length > 0 ? (
          <div className="mr-lobby-float" role="region" aria-label="Meeting lobby">
            <div className="mr-lobby-header">
              <span>
                {lobbyQueue.length === 1
                  ? "1 person waiting"
                  : `${lobbyQueue.length} people waiting`}
              </span>
              <button className="mr-mini" onClick={admitAll}>
                Admit all
              </button>
            </div>
            {lobbyQueue.map((p: any) => (
              <div key={p.userId} className="mr-inv-row">
                <Avatar avatar={lobbyAvatar(p)} size={26} />
                <span className="mr-inv-name">
                  {p.name || p.email}
                  {p.requestedAt ? (
                    <em className="mr-lobby-since">{waitedFor(p.requestedAt)}</em>
                  ) : null}
                </span>
                <button className="mr-mini" onClick={() => admitParticipant(p.userId)}>
                  Admit
                </button>
                <button className="mr-mini danger" onClick={() => denyParticipant(p.userId)}>
                  Deny
                </button>
              </div>
            ))}
          </div>
        ) : null}

        {/* Invite popover — floats above the dock, outside mr-more-panel */}
        {shareOpen && (() => {
          const inRoomIds = new Set((r.participants || []).map((p: any) => p.id));
          const invitedIds = new Set([
            ...attendees.map((a: any) => a.id),
            ...Array.from(invitedLocal),
          ]);
          const meId = me?.id;
          const q = shareQuery.trim().toLowerCase();
          const matches = (n: string) => !q || (n || "").toLowerCase().includes(q);
          const linkedConvId = r?.meeting?.conversationId || null;
          const tagOf = (id: string) =>
            inRoomIds.has(id) ? "inRoom" : invitedIds.has(id) ? "invited" : "invitable";
          // Exclude self AND anyone already IN the meeting — you can't invite
          // yourself, and re-inviting someone who's already here is noise (they'd
          // just get a redundant card). People who were invited but haven't joined
          // yet still appear (with a "Yet to join" + Remind row) so the host can
          // nudge them; only the already-joined are dropped from the candidate list.
          const dmRows = (users || [])
            .filter((u: any) => u && u.id && u.id !== meId && !inRoomIds.has(u.id) && matches(u.name))
            .slice(0, 20)
            .map((u: any) => ({ ...u, _tag: tagOf(u.id) }));
          const groupRows = (conversations || [])
            .filter((c: any) => c && c.kind === "group" && matches(c.name))
            .sort((a: any, b: any) =>
              (Date.parse(b.lastMessageAt || "") || 0) - (Date.parse(a.lastMessageAt || "") || 0),
            )
            .slice(0, 20)
            .map((c: any) => ({ ...c, _invited: invitedLocal.has(c.id) || c.id === linkedConvId }));
          return (
            <div className="mr-invite-pop" ref={invitePopRef}>
              <div className="mr-invite-pop-head">
                <div className="mr-invite-pop-title">
                  <span>Invite to meeting</span>
                  <small>Send a direct or group invite</small>
                </div>
                <button className="mr-invite-pop-close" onClick={() => setShareOpen(false)} aria-label="Close">
                  <IconX size={14} />
                </button>
              </div>
              {/* Public (guest) link: host / co-host can hand out a link that works
                  for people with no Collab account. */}
              {canControl && !isGuest && !offline ? (
                <div className="mr-invite-pub">
                  <PublicLinkControl
                    actions={{
                      get: (id) => api.getMeetingPublicLink(token, id),
                      create: (id) => api.createMeetingPublicLink(token, id),
                      revoke: (id) => api.revokeMeetingPublicLink(token, id),
                    }}
                    meetingId={m.id}
                    enabled={!!m.publicLinkEnabled}
                    onToast={(t) => onToast && onToast(t)}
                  />
                </div>
              ) : null}
              <div className="mr-share-tabs" role="tablist">
                {([["dm", "People"], ["group", "Groups"]] as const).map(([k, label]) => (
                  <button key={k} role="tab" aria-selected={shareTab === k}
                    className={"mr-share-tab" + (shareTab === k ? " active" : "")}
                    onClick={() => setShareTab(k)}>{label}</button>
                ))}
              </div>
              <div className="mr-share-search">
                <IconSearch aria-hidden="true" />
                <input value={shareQuery} onChange={(e) => setShareQuery(e.target.value)}
                  placeholder={shareTab === "dm" ? "Search people…" : "Search groups…"}
                  aria-label="Search to invite" autoFocus/>
              </div>
              <div className="mr-share-list">
                {shareTab === "dm" ? (
                  dmRows.length ? dmRows.map((u: any) => (
                    <div key={u.id}
                      className={"mr-inv-row" + (inviteSel.has(u.id) ? " selected" : "")}
                      onClick={(u._tag === "invitable" || inviteSel.has(u.id)) && !offline ? () => toggleInviteSel(u.id) : undefined}
                      style={(u._tag === "invitable" || inviteSel.has(u.id)) && !offline ? { cursor: "pointer" } : undefined}>
                      <Avatar avatar={{ kind: "user", initials: u.initials, color: u.color, avatarUrl: u.avatarUrl }} size={26}/>
                      <span className="mr-inv-name">{u.name}</span>
                      {!inviteSel.has(u.id) && u._tag === "inRoom" ? (
                        <span className="mr-inv-status st-inroom">In room</span>
                      ) : !inviteSel.has(u.id) && u._tag === "invited" ? (
                        <>
                          <span className="mr-inv-status st-yettojoin">Yet to join</span>
                          <button className={"mr-mini" + (reminded.has(u.id) ? " on" : "")}
                            onClick={(e) => { e.stopPropagation(); sendReminder(u.id, u.name); }} disabled={offline}>
                            {reminded.has(u.id) ? "Reminder sent" : "Remind"}
                          </button>
                        </>
                      ) : (
                        <span className={"mr-inv-check" + (inviteSel.has(u.id) ? " on" : "")} aria-hidden="true">
                          {inviteSel.has(u.id) ? (
                            <IconCheck size={12} />
                          ) : null}
                        </span>
                      )}
                    </div>
                  )) : <div className="mr-inv-empty">No people found.</div>
                ) : (
                  groupRows.length ? groupRows.map((c: any) => (
                    <div key={c.id}
                      className={"mr-inv-row" + (inviteSel.has(c.id) ? " selected" : "")}
                      onClick={(!c._invited || inviteSel.has(c.id)) && !offline ? () => toggleInviteSel(c.id) : undefined}
                      style={(!c._invited || inviteSel.has(c.id)) && !offline ? { cursor: "pointer" } : undefined}>
                      <Avatar avatar={c.avatar || { kind: "icon", icon: <IconMessageCircle size={14} /> }} size={26}/>
                      <span className="mr-inv-name">{c.name}</span>
                      {!inviteSel.has(c.id) && c._invited ? (
                        <>
                          <span className="mr-inv-status st-yettojoin">Invited</span>
                          <button className={"mr-mini" + (reminded.has(c.id) ? " on" : "")}
                            onClick={(e) => { e.stopPropagation(); sendConvReminder(c.id, c.name); }} disabled={offline}>
                            {reminded.has(c.id) ? "Reminder sent" : "Remind"}
                          </button>
                        </>
                      ) : (
                        <span className={"mr-inv-check" + (inviteSel.has(c.id) ? " on" : "")} aria-hidden="true">
                          {inviteSel.has(c.id) ? (
                            <IconCheck size={12} />
                          ) : null}
                        </span>
                      )}
                    </div>
                  )) : <div className="mr-inv-empty">No groups found.</div>
                )}
              </div>
              {inviteSel.size > 0 && (
                <div className="mr-invite-foot">
                  <button className="mr-invite-clear" onClick={() => setInviteSel(new Set())} disabled={offline}>
                    Clear
                  </button>
                  <button className="mr-invite-send" onClick={sendSelected} disabled={offline}>
                    {inviteSel.size === 1 ? "Send invite" : `Send invites (${inviteSel.size})`}
                  </button>
                </div>
              )}
            </div>
          );
        })()}

        {/* Recordings / host-controls panel */}
        {showMore && (
          <div className="mr-more-panel">
            {(canControl || isHost) && (
              <div className="mr-controls">
                {canControl && (
                  <button className="mr-btn" onClick={muteAll} disabled={offline}>
                    <IconMicOff size={14} style={{marginRight:5}} />
                    Mute all
                  </button>
                )}
                {/* The binary lobby button became a three-way policy in the
                    options below (0116). Mute all stays here because it is an
                    immediate ACTION, not a setting. */}
                <button className="mr-btn" onClick={() => { setShowMore(false); setShowRecs(false); }} style={{ marginLeft: "auto" }}>
                  <IconX size={14} style={{marginRight:5}} />
                  Close
                </button>
              </div>
            )}

        {!showRecs && (
          <MeetingOptionsPanel
            token={token}
            meetingId={meetingId}
            socket={socket}
            onToast={onToast}
          />
        )}
        {showRecs ? (
          <div className="mr-recs">
            {recs.length ? (
              recs.map((rec: any) => (
                <RecRow
                  key={rec.id}
                  rec={rec}
                  token={token}
                  canDelete={!!isHost}
                  onDelete={deleteRec}
                  onToast={onToast}
                />
              ))
            ) : (
              <div className="mr-inv-empty">
                No recordings yet. Tap Record in the controls to capture this meeting.
              </div>
            )}
          </div>
        ) : null}
          </div>
        )}

      </div>
    </div>
  );
}

// One recording row: lazily fetches the (auth'd) bytes into an object URL for
// inline playback + download. A plain <video src> can't send the Bearer token,
// so we fetch → blob → objectURL like the chat attachments do.
function RecRow({ rec, token, canDelete, onDelete, onToast }: any) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  const ensure = useCallback(async () => {
    if (url || loading || !rec.playbackUrl) return url;
    setLoading(true);
    try {
      const b = await api.recordingBlob(token, rec.playbackUrl);
      const u = URL.createObjectURL(b);
      setUrl(u);
      return u;
    } catch {
      onToast && onToast("Couldn't load the recording.");
      return null;
    } finally {
      setLoading(false);
    }
  }, [url, loading, rec.playbackUrl, token, onToast]);
  const download = async () => {
    const u = url || (await ensure());
    if (!u) return;
    const a = document.createElement("a");
    a.href = u;
    a.download = `recording-${(rec.createdAt || "").slice(0, 10) || rec.id}.webm`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };
  const dur = rec.durationSec
    ? `${Math.floor(rec.durationSec / 60)}:${String(rec.durationSec % 60).padStart(2, "0")}`
    : null;
  const when = rec.createdAt
    ? new Date(rec.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : "";
  const ready = rec.status === "ready" && rec.playbackUrl;
  return (
    <div className="mr-rec">
      <div className="mr-rec-row">
        <div className="mr-rec-ic" aria-hidden="true">
          <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7" /></svg>
        </div>
        <div className="mr-rec-info">
          <span className="mr-rec-title">Recording</span>
          <span className="mr-rec-meta">{ready ? `${dur ? dur + " · " : ""}${when}` : rec.status === "recording" ? "Recording…" : rec.status === "processing" ? "Processing…" : "Unavailable"}</span>
        </div>
        {ready ? (
          <div className="mr-rec-acts">
            {!url ? (
              <button className="mr-mini" onClick={ensure} disabled={loading}>{loading ? "Loading…" : "Play"}</button>
            ) : null}
            <button className="mr-mini" onClick={download}>Download</button>
            {canDelete ? (
              <button className="mr-mini danger" onClick={() => onDelete(rec.id)}>Delete</button>
            ) : null}
          </div>
        ) : null}
      </div>
      {url ? (
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <video className="mr-rec-video" src={url} controls autoPlay />
      ) : null}
    </div>
  );
}


// ── Meeting options (0116) ──────────────────────────────────────────────────
// The policy layer over the host controls. Every switch here is enforced on the
// SERVER — the LiveKit grant refuses a disallowed publish and the socket
// handlers drop disallowed chat/reactions — so this panel is the way to express
// intent, not the thing that enforces it.
//
// Saves are OPTIMISTIC with revert: the switch moves immediately (a control
// that lags feels broken), and snaps back with an explanation if the server
// says no. Each field is sent on its own, so one rejected change never discards
// the others.
function MeetingOptionsPanel({ token, meetingId, socket, onToast }: any) {
  const [opts, setOpts] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!token || !meetingId) return;
    let alive = true;
    api
      .getMeetingOptions(token, meetingId)
      .then((o: any) => alive && setOpts(o))
      .catch(() => alive && setErr("Couldn't load meeting options."));
    return () => {
      alive = false;
    };
  }, [token, meetingId]);

  // Follow changes made by a co-host (or by this host on another device), so two
  // people with the panel open never see different policies.
  useEffect(() => {
    if (!socket || !meetingId) return;
    const onOpts = (d: any) => {
      if (d && d.meetingId === meetingId) setOpts(d);
    };
    socket.on(EVENTS.MEETING_OPTIONS, onOpts);
    return () => {
      socket.off(EVENTS.MEETING_OPTIONS, onOpts);
    };
  }, [socket, meetingId]);

  const save = useCallback(
    async (patch: any) => {
      if (!token || !meetingId) return;
      const key = Object.keys(patch)[0];
      const prev = opts;
      setOpts((c: any) => ({ ...c, ...patch })); // optimistic
      setBusy(key);
      setErr(null);
      try {
        const next = await api.setMeetingOptions(token, meetingId, patch);
        setOpts(next);
        // The setting is saved and binds every future join regardless — but if
        // the media server could not be reached, people ALREADY in the room keep
        // their current permissions until they rejoin. Say so rather than let the
        // host believe it took effect for everyone.
        if (next && next.applied && next.applied.missed > 0) {
          onToast &&
            onToast(
              `Saved. ${next.applied.missed} ${
                next.applied.missed === 1 ? "person" : "people"
              } already in the meeting will pick this up when they rejoin.`,
            );
        }
      } catch (e: any) {
        setOpts(prev); // revert — the server is the source of truth
        const msg = (e && e.message) || "Couldn't save that option.";
        setErr(msg);
        onToast && onToast(msg);
      } finally {
        setBusy(null);
      }
    },
    [token, meetingId, opts, onToast],
  );

  if (!opts) {
    return (
      <div className="mr-opts">
        <div className="mr-opts-loading">{err || "Loading meeting options…"}</div>
      </div>
    );
  }
  if (!opts.canEdit) {
    // A plain attendee can READ the policy — knowing why a control is disabled
    // is much better than a greyed-out button with no explanation.
    return (
      <div className="mr-opts">
        <div className="mr-opts-note">
          The host controls what attendees can do in this meeting.
        </div>
        <ul className="mr-opts-readonly">
          <li>Microphone: {opts.allowMic ? "allowed" : "off for attendees"}</li>
          <li>Camera: {opts.allowCamera ? "allowed" : "off for attendees"}</li>
          <li>Chat: {opts.allowChat ? "allowed" : "off for attendees"}</li>
          <li>Reactions: {opts.allowReactions ? "allowed" : "off for attendees"}</li>
        </ul>
      </div>
    );
  }

  const radio = (field: string, value: string, label: string, hint?: string) => (
    <label className="mr-opt-radio" key={value}>
      <input
        type="radio"
        name={field}
        checked={opts[field] === value}
        disabled={busy === field}
        onChange={() => save({ [field]: value })}
      />
      <span>
        {label}
        {hint ? <em className="mr-opt-hint">{hint}</em> : null}
      </span>
    </label>
  );

  const toggle = (field: string, label: string) => (
    <label className="mr-opt-check" key={field}>
      <input
        type="checkbox"
        checked={!!opts[field]}
        disabled={busy === field}
        onChange={(e) => save({ [field]: e.target.checked })}
      />
      <span>{label}</span>
    </label>
  );

  return (
    <div className="mr-opts">
      <div className="mr-opts-group">
        <div className="mr-opts-title">Who bypasses the lobby</div>
        {radio("lobbyPolicy", "everyone", "Everyone", "No lobby — anyone with the link joins")}
        {radio("lobbyPolicy", "invited", "People I invited", "Anyone else waits for you")}
        {radio("lobbyPolicy", "nobody", "Nobody", "You admit every person yourself")}
      </div>

      <div className="mr-opts-group">
        <div className="mr-opts-title">Attendees may</div>
        {toggle("allowMic", "Turn on their microphone")}
        {toggle("allowCamera", "Turn on their camera")}
        {toggle("allowChat", "Use meeting chat")}
        {toggle("allowReactions", "React and raise hands")}
        <div className="mr-opts-foot">
          These never apply to you or your co-hosts.
        </div>
      </div>

      <div className="mr-opts-group">
        <div className="mr-opts-title">Recording</div>
        {toggle("autoRecord", "Start recording when I join")}
      </div>

      {err ? <div className="mr-opts-err">{err}</div> : null}
    </div>
  );
}
