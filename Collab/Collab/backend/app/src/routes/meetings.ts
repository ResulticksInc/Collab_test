import express from "express";
import { asyncRouter } from "../asyncRouter";
import * as meetingPolicy from "../services/meetingPolicy";
import * as pollService from "../services/meetingPollService";
const router = asyncRouter();
import { shared, ok, fail, db } from "../platform";
import authMiddleware from "../middleware/auth";
import {
  create,
  listForUser,
  listForUserCalendar,
  generateIcs,
  update,
  remove,
  leave,
  respond,
  enterRoom,
  heartbeatRoom,
  leaveRoom,
  getRoom,
  cancel,
  complete,
  startTemporaryGroup,
  ensureMeetingGroup,
  previewOccurrences,
  toggleLobby,
  toggleLock,
  getOptions as getMeetingOptions,
  attendance as meetingAttendance,
  availability as meetingAvailability,
  setOptions as setMeetingOptions,
  lobbyList,
  roomPreview,
  lobbySelf,
  lobbyAdmit,
  lobbyDeny,
  lobbyAdmitAll,
  promoteCoHost,
  demoteCoHost,
  getHostControls,
  setHostSettings,
  setParticipantPermissions,
} from "../services/meetingService";
import {
  start as startRecording,
  stop as stopRecording,
  listForMeeting as listRecordings,
  remove as removeRecording,
  uploadClientRecording,
  getRecordingDownload,
} from "../services/recordingService";
import {
  muteAllParticipants,
  muteParticipant,
  removeParticipant,
  deleteRoom,
} from "../services/livekitService";
import { send } from "../services/messageService";
import { record as auditRecord } from "../services/auditService";
import {
  ensureLink as ensurePublicLink,
  getLink as getPublicLink,
  revokeLink as revokePublicLink,
  redactRoomForGuest,
  slimPerson,
} from "../services/guestMeetingService";
import { recordEvents } from "../services/telemetryService";
import { broadcast } from "../realtime/socket";
import { pushNotif, notifyAddedToTempGroup } from "../realtime/notify";
import * as notifService from "../services/notificationService";
const { EVENTS } = shared;
import { validate } from "../middleware/validate";
router.use(authMiddleware);

// Transparently handle recurring occurrence synthetic IDs (e.g. "m_123__occ_2" -> "m_123")
router.param("id", (req: any, _res, next, id) => {
  if (id && typeof id === "string") {
    req.params.id = id.split("__occ_")[0];
  }
  next();
});

// Post an actionable meeting-invite card into a conversation. The payload
// (meetingId/title/startsAt) rides in the message body as JSON; serializeMessage
// parses it into `meeting` and the client renders a time-gated Join/Reject card.
export async function postInviteCardTo(req: any, meeting: any, conversationId: string, inviterId: string) {
  const payload = JSON.stringify({
    meetingId: meeting.id,
    title: meeting.title || "Meeting",
    startsAt: meeting.startsAt || null,
    // Carry the real duration so the invite card's Join stays live for the WHOLE
    // meeting — without it the card defaulted to 30 min and hid Join on longer
    // meetings while they were still in progress.
    durationMin: meeting.durationMin || null,
  });
  const msg = await send({
    conversationId,
    senderId: inviterId,
    text: payload,
    file: null,
    type: "meeting_invite",
    bumpUnread: true,
  });
  const io = req.app.get("io");
  if (io) io.to(broadcast.room(conversationId)).emit(EVENTS.MESSAGE_NEW, msg);
  return msg;
}

// Land a meeting invite in ONE attendee's Activity feed (+ push). This used to
// ALSO find-or-create a 1:1 chat with every invitee and drop the invite card there,
// which put a separate chat-list item for each member of a meeting in the host's
// (and every invitee's) Chat list. The meeting already has its own chat (created at
// scheduling — ensureMeetingGroup), so the card now goes there once instead.
// Throws on failure — callers decide whether to surface it.
async function notifyMeetingAttendee(req: any, meeting: any, attendeeId: string, inviterId: string) {
  if (!meeting || !attendeeId || attendeeId === inviterId) return;
  const io = req.app.get("io");
  const inviter = await db.users.getById(inviterId);
  const n = await notifService.notifyMeetingInvite({
    userId: attendeeId,
    hostName: (inviter && inviter.name) || "Someone",
    meetingId: meeting.id,
    meetingTitle: meeting.title || "a meeting",
  });
  if (n && io) pushNotif(io, n);
}

// Schedule-time invites: ONE actionable card in the meeting's own chat (everyone in
// it sees the Join/Reject, which stay masked client-side until 10 min before the
// start) + a per-attendee Activity notification. No per-attendee 1:1 chats. When the
// meeting was scheduled FROM a chat, that conversation is the meeting chat and the
// caller already posts the card there, so only notifications are sent here.
// Best-effort — one failure must never fail the whole schedule.
export async function postMeetingInvites(req: any, meeting: any, attendeeIds: string[], inviterId: string) {
  try {
    if (!meeting) return;
    if (!meeting.conversationId) {
      const grp: any = await ensureMeetingGroup(await db.meetings.getById(meeting.id));
      if (grp && grp.id) await postInviteCardTo(req, meeting, grp.id, inviterId);
    }
  } catch (e) {
    console.warn("[meetings] invite card post failed for meeting", meeting && meeting.id, e);
  }
  await Promise.allSettled(
    (attendeeIds || []).map((a) =>
      notifyMeetingAttendee(req, meeting, a, inviterId).catch((e) =>
        console.warn("[meetings] invite notification failed for", a, e),
      ),
    ),
  );
}

// Best-effort "Meeting ended/cancelled" trace into the meeting's linked
// conversation timeline (mirrors the 1:1/group call logs). conversationId-gated
// and wrapped so a logging failure never breaks the meeting route.
async function postMeetingTrace(req, meeting, label) {
  try {
    if (!meeting) return;
    // MCHAT-12: system events land in the meeting's OWN group (dmKey
    // "call|m:<id>", created at scheduling) — falling back from the linked
    // conversation a chat-scheduled meeting carries.
    const convId =
      meeting.conversationId ||
      ((db.conversations as any).findByDmKey &&
        (await (db.conversations as any).findByDmKey("call|m:" + meeting.id)));
    if (!convId) return;
    const msg = await send({
      conversationId: convId,
      senderId: req.user.userId,
      text: label,
      file: null,
      type: "call",
      bumpUnread: false,
    });
    const io = req.app.get("io");
    if (io) io.to(broadcast.room(convId)).emit(EVENTS.MESSAGE_NEW, msg);
  } catch (_) {
    /* non-fatal */
  }
}
router.get("/", async (req, res) => {
  const isCalendar = req.query.calendar === "true" || req.query.calendar === "1";
  const limit = Math.min(Number(req.query.count) || 10, 60);
  const data = isCalendar
    ? await listForUserCalendar(req.user.userId, limit)
    : await listForUser(req.user.userId);
  res.json(ok(data));
});

router.get("/:id/ics", async (req, res) => {
  const m = await db.meetings.getById(req.params.id);
  if (!m) return res.status(404).json(fail("NOT_FOUND", "Meeting not found."));
  let host: any = null;
  if (m.createdBy) {
    try { host = await db.users.getById(m.createdBy); } catch (_) {}
  }
  const ics = generateIcs(m, host);
  const filename = `${(m.title || "meeting").replace(/[^a-zA-Z0-9_-]/g, "_")}.ics`;
  res.setHeader("Content-Type", "text/calendar; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(ics);
});
// RCR-05: preview the next computed dates of a recurrence rule BEFORE saving —
// same expansion the calendar uses, nothing persisted.
router.post("/preview-occurrences", async (req, res) => {
  const { startsAt, recurrence, recurrenceRule, timeZone, count } = req.body || {};
  res.json(
    ok(
      previewOccurrences({
        startsAt,
        recurrence,
        recurrenceRule,
        timezone: timeZone,
        count,
      }),
    ),
  );
});

router.post("/", validate({
  title: { maxLength: 200 },
  startsAt: { required: true },
  recurrence: { isOneOf: ["none", "daily", "weekly", "biweekly", "monthly", "yearly"] },
}), async (req, res) => {
  const { title, startsAt, durationMin, attendees, conversationId, recurrence, recurrenceRule, reminderLeadMin, options, description, location, optionalAttendees } =
    req.body || {};
  // People are mandatory: without an attendee there is nobody to invite, so a
  // meeting with an empty guest list is rejected here as well as in the form.
  if (!Array.isArray(attendees) || attendees.filter(Boolean).length === 0)
    return res.status(400).json(fail("BAD_REQUEST", "Add at least one person to the meeting."));
  // AUDIT #31: resolve the meeting's timezone (client IANA -> the organiser's
  // profile). For a RECURRING meeting this drives DST-correct expansion; for a
  // one-off it is what the scheduler shows as the organiser's zone. Resolved for
  // both now, so a one-off no longer has to guess at display time.
  let timeZone =
    typeof (req.body || {}).timeZone === "string" && (req.body as any).timeZone
      ? (req.body as any).timeZone
      : null;
  if (!timeZone) {
    try {
      const u = await db.users.getById(req.user.userId);
      if (u && (u as any).timezone) timeZone = (u as any).timezone;
    } catch {
      /* fall back to server-local (NULL tz) */
    }
  }
  const mt = await create({
    title,
    startsAt,
    durationMin,
    attendees: attendees || [],
    conversationId,
    recurrence,
    recurrenceRule,
    reminderLeadMin,
    timezone: timeZone,
    // Agenda / where (0118). Capped so a pasted document can't become the row.
    description: typeof description === "string" ? description.slice(0, 8000) : null,
    location: typeof location === "string" ? location.slice(0, 255) : null,
    creatorId: req.user.userId,
  });
  // Optional guests (0122). Applied after the attendee rows exist. Ignores ids
  // that aren't actually attendees, so a stale client can't create orphan flags.
  if (Array.isArray(optionalAttendees) && optionalAttendees.length) {
    const invited = new Set((attendees || []).map(String));
    await Promise.allSettled(
      optionalAttendees
        .map(String)
        .filter((id: string) => invited.has(id))
        .map((id: string) => (db.meetings as any).setAttendeeOptional(mt.id, id, true)),
    );
  }
  // PER-MEETING OPTIONS (0116) at SCHEDULE time. Validated by the same
  // normalizePatch the PATCH route uses, so an invalid value is rejected here
  // too rather than silently creating a meeting with a policy the host did not
  // ask for. Applied AFTER create because the option columns carry safe
  // defaults — a meeting is never briefly in an unintended state.
  if (options && typeof options === "object") {
    const clean = meetingPolicy.normalizePatch(options);
    if (Object.keys(clean).length) {
      await db.meetings.setOptions(mt.id, clean);
      Object.assign(mt as any, clean);
      (mt as any).options = { ...meetingPolicy.OPTION_DEFAULTS, ...clean };
      (mt as any).lobbyEnabled =
        clean.lobbyPolicy !== undefined
          ? clean.lobbyPolicy !== "everyone"
          : (mt as any).lobbyEnabled;
    }
  }
  const io = req.app.get("io");
  if (io)
    for (const a of attendees || [])
      io.to(broadcast.userRoom(a)).emit(EVENTS.MEETING_NEW, {
        meetingId: mt.id,
      });
  // §9.2: recurrence pattern distribution (single vs each pattern).
  void recordEvents(["meeting.create." + ((mt as any).recurrence && (mt as any).recurrence !== "none" ? (mt as any).recurrence : "single")]);
  // MCHAT-01/20: the meeting chat was created AT SCHEDULING (ensureMeetingGroup)
  // — join every member's live sockets to its room and announce it, so it
  // appears in each invitee's chat list immediately, before the meeting starts.
  const grp = (mt as any).meetingGroup;
  if (io && grp && grp.id) {
    for (const uid of grp.memberIds || []) {
      io.in(broadcast.userRoom(uid)).socketsJoin(broadcast.room(grp.id));
      io.to(broadcast.userRoom(uid)).emit(EVENTS.CONVERSATION_NEW, {
        conversationId: grp.id,
      });
    }
  }
  // At schedule time, drop the invite card straight into each invitee's DM (and
  // the linked group/channel if targeted). Join/Reject on the card stay masked
  // client-side until 10 min before the start. Best-effort, after the 201 data
  // is ready so a dispatch hiccup never fails the schedule. Fan the dispatches
  // out CONCURRENTLY (allSettled) instead of one serial await at a time —
  // postMeetingInvites already swallows its own per-attendee errors, so this only
  // adds isolation and collapses N round-trips of waiting into one.
  await postMeetingInvites(req, mt, attendees || [], req.user.userId);
  if (conversationId)
    try {
      await postInviteCardTo(req, mt, conversationId, req.user.userId);
    } catch (_) {
      /* non-fatal */
    }
  res.status(201).json(ok(mt));
});

// Invite mid-meeting from the Share-invitation picker (or re-send a reminder).
// DM path ({userId}): adds them as an attendee + drops the card in their DM.
// Group/channel path ({conversationId}): posts ONE card into that conversation
// so everyone there sees the Join/Reject (sender must be a member — enforced by
// messageService.send).
router.post("/:id/invite", async (req, res) => {
  const meeting = await requireMeetingParticipant(req.params.id, req.user.userId);
  const { userId, conversationId } = req.body || {};
  if (conversationId) {
    await postInviteCardTo(req, meeting, conversationId, req.user.userId);
    return res.json(ok({ invited: true }));
  }
  if (!userId) {
    const e: any = new Error("userId or conversationId is required.");
    e.status = 400;
    throw e;
  }
  await db.meetings.setAttendeeStatus(req.params.id, userId, "invited");
  // MCHAT-20: a newly invited person gains meeting-chat membership right away.
  try {
    const grp = await ensureMeetingGroup(await db.meetings.getById(req.params.id));
    const io0 = req.app.get("io");
    if (grp && io0) {
      io0.in(broadcast.userRoom(userId)).socketsJoin(broadcast.room(grp.id));
      io0.to(broadcast.userRoom(userId)).emit(EVENTS.CONVERSATION_NEW, { conversationId: grp.id });
    }
  } catch (_) {}
  // Manual invite/reminder: propagate failures so the UI can show a real error
  // instead of a false "Invitation sent".
  await notifyMeetingAttendee(req, meeting, userId, req.user.userId);
  const io = req.app.get("io");
  if (io) {
    io.to(broadcast.userRoom(userId)).emit(EVENTS.MEETING_NEW, {
      meetingId: req.params.id,
    });
    io.to(broadcast.userRoom(req.user.userId)).emit(EVENTS.MEETING_UPDATED, {
      meetingId: req.params.id,
    });
  }
  res.json(ok({ invited: true }));
});
router.patch("/:id", async (req, res) => {
  // AUDIT #31: normalize the client's camelCase timeZone → the `timezone` column
  // the update service expects, so editing a recurring meeting re-persists its zone.
  const patch: any = { ...(req.body || {}) };
  if (typeof patch.timeZone === "string" && patch.timeZone && !("timezone" in patch))
    patch.timezone = patch.timeZone;
  // People are mandatory: an edit may not empty the guest list. (Leaving
  // `attendees` out of the patch keeps the existing set untouched.)
  if ("attendees" in patch && (!Array.isArray(patch.attendees) || patch.attendees.filter(Boolean).length === 0))
    return res.status(400).json(fail("BAD_REQUEST", "Add at least one person to the meeting."));
  // PER-MEETING OPTIONS (0116). Lifted OUT of the generic patch — `options` is
  // not a meetings column, and it needs the option-specific authorization
  // (host/co-host) plus the live re-permissioning that setOptions performs. Done
  // FIRST so that if a bad value is supplied the whole edit is rejected before
  // anything is persisted, rather than half-applying.
  const optionPatch = patch.options;
  delete patch.options;
  // Optional guests survive an edit: update() soft-replaces the attendee set, so
  // the flags have to be re-applied AFTER it, not before.
  const optionalIds: string[] = Array.isArray(patch.optionalAttendees)
    ? patch.optionalAttendees.map(String)
    : [];
  const hadOptional = "optionalAttendees" in patch;
  delete patch.optionalAttendees;
  if (optionPatch && typeof optionPatch === "object") {
    await setMeetingOptions({
      meetingId: req.params.id,
      userId: req.user.userId,
      patch: optionPatch,
    });
    const io0 = req.app.get("io");
    if (io0)
      io0
        .to("meeting:" + req.params.id)
        .emit(
          EVENTS.MEETING_OPTIONS,
          await getMeetingOptions({ meetingId: req.params.id, userId: req.user.userId }),
        );
  }
  const mt = await update({
    meetingId: req.params.id,
    userId: req.user.userId,
    patch,
  });
  if (!mt) return res.status(403).json(ok({ updated: false }));
  if (hadOptional) {
    const wanted = new Set(optionalIds);
    await Promise.allSettled(
      ((mt as any).attendees || []).map((a: any) =>
        (db.meetings as any).setAttendeeOptional(
          req.params.id,
          a.userId || a.id,
          wanted.has(String(a.userId || a.id)),
        ),
      ),
    );
  }
  broadcastMeeting(req, mt);
  // RSCH-10 + CNCL-08's reschedule twin: a system line in the meeting chat and
  // an audit row whenever the TIME actually changed (title/agenda edits stay
  // quiet — they don't reset RSVPs either, per RSCH-04).
  try {
    const fmtWhen = (iso: any) => {
      const d = new Date(iso);
      return Number.isFinite(d.getTime())
        ? d.toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
        : String(iso);
    };
    const actor0 = await db.users.getById(req.user.userId).catch(() => null);
    const who = (actor0 && (actor0 as any).name) || "The host";
    if ((mt as any)._seriesSplit) {
      // RCR-22: the series was split — the response IS the new (future) series.
      const sp = (mt as any)._seriesSplit;
      void recordEvents(["meeting.reschedule.split"]); // §9.2 occurrence-vs-series split
      void auditRecord({ actorId: req.user.userId, action: "meeting.series_split", targetType: "meeting", targetId: sp.originalId, detail: { newId: sp.newId, splitKey: sp.splitKey } });
      await postMeetingTrace(req, mt, `📅 ${who} changed this meeting from ${sp.splitKey} onward`);
    } else if ((mt as any)._occurrenceMoved) {
      const mv = (mt as any)._occurrenceMoved;
      void recordEvents(["meeting.reschedule.occurrence"]); // §9.2 + exception rate
      void auditRecord({ actorId: req.user.userId, action: "meeting.reschedule", targetType: "meeting", targetId: req.params.id, detail: { scope: "occurrence", key: mv.key, startsAt: mv.startsAt } });
      if (mv.startsAt)
        await postMeetingTrace(req, mt, `📅 ${who} moved the ${mv.key} occurrence to ${fmtWhen(mv.startsAt)}`);
    } else if ((mt as any)._rescheduled) {
      void recordEvents(["meeting.reschedule.series"]); // §9.2
      void auditRecord({ actorId: req.user.userId, action: "meeting.reschedule", targetType: "meeting", targetId: req.params.id, detail: { scope: "series", startsAt: patch.startsAt || null } });
      if (patch.startsAt)
        await postMeetingTrace(req, mt, `📅 ${who} moved this meeting to ${fmtWhen(patch.startsAt)}`);
    }
  } catch (_) {}
  try {
    const actor = await db.users.getById(req.user.userId);
    const io = req.app.get("io");
    for (const a of mt.attendees || []) {
      if (a.id === req.user.userId) continue;
      const n = await notifService.notifyMeetingUpdated({
        userId: a.id,
        hostName: (actor && actor.name) || "The host",
        meetingId: mt.id,
        meetingTitle: mt.title || "a meeting",
      });
      if (n && io) pushNotif(io, n);
    }
  } catch (_) {}
  res.json(ok(mt));
});
router.delete("/:id", async (req, res) =>
  res.json(
    ok(await remove({ meetingId: req.params.id, userId: req.user.userId })),
  ),
);
router.post("/:id/rsvp", async (req, res) => {
  const status = (req.body || {}).status;
  const mt = await respond({
    meetingId: req.params.id,
    userId: req.user.userId,
    status,
  });
  broadcastMeeting(req, mt);
  // #14: a decline must be SURFACED, not silently recorded — notify the host and
  // post a "has declined the meeting" line into the meeting's conversation.
  if (status === "declined")
    void notifyMeetingDecline(req, req.params.id, req.user.userId);
  res.json(ok(mt));
});

// Notify the host (live Activity feed) and post a "X has declined the meeting"
// system line into the meeting's conversation (DM/group/channel) when an invitee
// declines. Best-effort: a notify failure must never break the RSVP itself.
async function notifyMeetingDecline(
  req: any,
  meetingId: string,
  declinerId: string,
) {
  try {
    const io = req.app.get("io");
    const m = await db.meetings.getById(meetingId);
    if (!m) return;
    const decliner = await db.users.getById(declinerId);
    const declinerName = (decliner && decliner.name) || "Someone";
    if (m.createdBy && m.createdBy !== declinerId) {
      const n = await notifService.create({
        userId: m.createdBy,
        type: "meeting_declined",
        title: `${declinerName} declined "${m.title || "a meeting"}"`,
        targetType: "meeting",
        targetId: meetingId,
      });
      if (n && io) pushNotif(io, n);
    }
    if (m.conversationId && io) {
      const msg = await send({
        conversationId: m.conversationId,
        senderId: declinerId,
        text: `${declinerName} has declined the meeting "${m.title || ""}".`.trim(),
        file: null,
        type: "system",
        bumpUnread: true,
      });
      io.to(broadcast.room(m.conversationId)).emit(EVENTS.MESSAGE_NEW, msg);
    }
  } catch (_) {
    /* never break the RSVP on a decline-notify error */
  }
}
router.post("/:id/leave", async (req, res) =>
  res.json(
    ok(await leave({ meetingId: req.params.id, userId: req.user.userId })),
  ),
);
// Broadcast live room presence to every invited attendee + everyone currently
// in the room, so participant counts update in realtime as people come and go.
async function emitPresence(req: any, meetingId: string) {
  const io = req.app.get("io");
  if (!io) return;
  const room = await getRoom({ meetingId, userId: null });
  if (!room) return;
  const ids = new Set<string>(
    [
      ...((room.meeting as any).attendees || []).map((a: any) => a.id),
      ...room.participants.map((p: any) => p.id),
    ].filter(Boolean),
  );
  // Public-link guests get the roster WITHOUT members' email/phone/title — the
  // same redaction the REST room responses apply (redactRoomForGuest).
  const guestIds = new Set<string>(
    [...((room.meeting as any).attendees || []), ...room.participants]
      .filter((x: any) => x && x.role === "guest")
      .map((x: any) => x.id),
  );
  const slimParticipants = guestIds.size ? room.participants.map(slimPerson) : room.participants;
  for (const uid of ids)
    io.to(broadcast.userRoom(uid)).emit(EVENTS.MEETING_PRESENCE, {
      meetingId,
      count: room.count,
      state: room.state,
      participants: guestIds.has(uid) ? slimParticipants : room.participants,
    });
}

// Notify all attendees that a meeting's metadata changed (RSVP, cancel,
// complete, reschedule) so their lists refetch in realtime.
function broadcastMeeting(req: any, mt: any) {
  const io = req.app.get("io");
  if (!io || !mt) return;
  const ids = new Set<string>(
    [mt.hostId, ...(mt.attendees || []).map((a: any) => a.id)].filter(Boolean),
  );
  for (const uid of ids)
    io.to(broadcast.userRoom(uid)).emit(EVENTS.MEETING_UPDATED, {
      meetingId: mt.id,
    });
}

// AUTO-RECORD (0116). Fires when the HOST enters, not the first participant:
// starting a recording before the host arrives would capture people waiting in
// an empty room, and the recording is attributed to whoever started it.
// Guarded so it can only ever start ONE recording per session, and entirely
// best-effort — a recording that cannot start (egress unconfigured, storage
// down) must never stop the host from joining their own meeting.
async function maybeAutoRecord(req: any, meetingId: string, userId: string) {
  try {
    const m = await db.meetings.getById(meetingId);
    if (!m || !m.autoRecord || m.createdBy !== userId) return;
    const existing = await listRecordings({ meetingId, userId }).catch(() => []);
    if ((existing || []).some((r: any) => r.status === "recording")) return;
    const rec = await startRecording({ meetingId, userId });
    void auditRecord({
      actorId: userId,
      action: "recording.start",
      targetType: "recording",
      targetId: (rec as any)?.id || null,
      detail: { meetingId, auto: true },
    });
    await emitMeetingUpdateById(req, meetingId);
  } catch (e: any) {
    console.warn("[meetings] auto-record did not start:", e?.message || e);
  }
}

router.post("/:id/room/enter", async (req, res) => {
  const room = await enterRoom({
    meetingId: req.params.id,
    userId: req.user.userId,
  });
  if (!room) return res.status(404).json(ok({ entered: false }));
  await emitPresence(req, req.params.id);
  // A public-link guest only ever gets the room itself. Everything below is
  // member-side fan-out (auto-record, the meeting's chat group, "meeting
  // started" notifications) that must never be triggered by, or include, a guest.
  if (req.user.guest) return res.json(ok(redactRoomForGuest(room)));
  // Only once the host is genuinely IN the room — a lobby/locked/ejected result
  // has no `count`, so this can never fire for someone still waiting outside.
  if ("count" in room) void maybeAutoRecord(req, req.params.id, req.user.userId);
  // TEMP GROUP AT START: once 2+ people are in the room, create the meeting's
  // temporary group NOW (idempotent, keyed on the meeting) so chat + the
  // recording land in it live — instead of only after the meeting ends. Emit
  // CONVERSATION_NEW so every member sees it immediately. Best-effort.
  if ("count" in room && (room as any).count >= 2) {
    try {
      const tg = await startTemporaryGroup({ meetingId: req.params.id, userId: req.user.userId });
      const io = req.app.get("io");
      if (io && tg && tg.id) {
        for (const uid of tg.memberIds) {
          io.in(broadcast.userRoom(uid)).socketsJoin(broadcast.room(tg.id));
          io.to(broadcast.userRoom(uid)).emit(EVENTS.CONVERSATION_NEW, { conversationId: tg.id });
        }
        // Notify the other participants so the meeting's temp group is noticed,
        // not just silently added to their sidebar (dedupKey → once per member).
        await notifyAddedToTempGroup(io, {
          conversationId: tg.id,
          title: (tg as any).title || null,
          actorId: req.user.userId,
          memberIds: tg.memberIds,
        });
      }
    } catch (_) { /* best-effort — never block room entry */ }
  }
  if ("count" in room && room.count === 1) {
    try {
      const m = await db.meetings.getById(req.params.id);
      const host = m && m.createdBy ? await db.users.getById(m.createdBy) : null;
      const io = req.app.get("io");
      for (const a of (m && m.attendees) || []) {
        const aid = a.id || a.userId;
        if (!aid || aid === req.user.userId) continue;
        const n = await notifService.notifyMeetingStarted({
          userId: aid,
          hostName: (host && host.name) || "Someone",
          meetingId: req.params.id,
          meetingTitle: (m && m.title) || "a meeting",
        });
        if (n && io) pushNotif(io, n);
      }
    } catch (_) {}
  }
  res.json(ok(room));
});
router.post("/:id/room/heartbeat", async (req, res) => {
  // A heartbeat is a keepalive fired on a timer while in the room. A transient DB
  // hiccup or a backend restart/redeploy mid-call must NOT surface as a 500 the
  // user sees — that just triggers an error storm (and a telemetry loop) for a beat
  // the client will retry anyway. Degrade to a soft "stale" response so the client
  // quietly retries next tick. A genuinely-gone room still resolves on the next
  // successful beat or via the socket roster.
  try {
    const room = await heartbeatRoom({
      meetingId: req.params.id,
      userId: req.user.userId,
    });
    res.json(ok(req.user.guest ? redactRoomForGuest(room) || { count: 0 } : room || { count: 0 }));
  } catch (_) {
    res.json(ok({ count: 0, stale: true }));
  }
});
router.post("/:id/room/leave", async (req, res) => {
  const r = await leaveRoom({
    meetingId: req.params.id,
    userId: req.user.userId,
  });
  await emitPresence(req, req.params.id);
  res.json(ok(r));
});
router.post("/:id/cancel", async (req, res) => {
  const note = typeof (req.body || {}).note === "string" ? req.body.note.trim() : "";
  // CNCL-01: the organizer cancels a single OCCURRENCE or the entire series,
  // chosen explicitly (scope "occurrence" needs the occurrence being cancelled).
  const scope = (req.body || {}).scope === "occurrence" ? "occurrence" : "series";
  const occurrenceStartsAt = (req.body || {}).occurrenceStartsAt || null;
  const m = await cancel({
    meetingId: req.params.id,
    userId: req.user.userId,
    scope,
    occurrenceStartsAt,
  });
  if (!m) return res.status(403).json(ok({ cancelled: false }));
  void recordEvents(["meeting.cancel." + scope]); // §9.2 occurrence-vs-series split
  // CNCL-08: cancellation is audit-logged with actor + scope.
  void auditRecord({
    actorId: req.user.userId,
    action: "meeting.cancel",
    targetType: "meeting",
    targetId: req.params.id,
    detail: { scope, occurrenceStartsAt, note: note || null },
  });
  broadcastMeeting(req, m);
  if ((m as any)._occurrenceCancelled) {
    // RCR-23: one occurrence excluded; the series (and its artifacts) stand.
    const day = (m as any)._occurrenceCancelled;
    await postMeetingTrace(
      req,
      m,
      note
        ? `📹 The ${day} occurrence was cancelled: ${note}`
        : `📹 The ${day} occurrence was cancelled`,
    );
    return res.json(ok(m));
  }
  await postMeetingTrace(req, m, note ? `📹 Meeting cancelled: ${note}` : "📹 Meeting cancelled");
  try {
    const host = await db.users.getById(req.user.userId);
    const io = req.app.get("io");
    for (const a of m.attendees || []) {
      if (a.id === req.user.userId) continue;
      const n = await notifService.notifyMeetingCancelled({
        userId: a.id,
        hostName: (host && host.name) || "The host",
        meetingId: m.id,
        meetingTitle: m.title || "a meeting",
        note,
      });
      if (n && io) pushNotif(io, n);
    }
  } catch (_) {}
  res.json(ok(m));
});
router.post("/:id/complete", async (req, res) => {
  const m = await complete({
    meetingId: req.params.id,
    userId: req.user.userId,
  });
  if (!m) return res.status(403).json(ok({ completed: false }));
  // End for EVERYONE: complete() already enforced the host check + marked the
  // meeting completed; now delete the SFU room so ALL participants are actually
  // disconnected (not just the host who clicked it). Best-effort.
  try {
    await deleteRoom("meeting_" + req.params.id);
  } catch (_) {}
  broadcastMeeting(req, m);
  // The attendance card IS the "Meeting ended" line (with the duration and the
  // report attached). Only when there is none — nobody ever joined — post the
  // plain trace, so the timeline never shows the ending twice.
  const att = (m as any).attendanceMessage;
  if (att) {
    try {
      const io0 = req.app.get("io");
      if (io0) io0.to(broadcast.room(att.conversationId)).emit(EVENTS.MESSAGE_NEW, att);
    } catch (_) { /* non-fatal */ }
    delete (m as any).attendanceMessage;
    // A chat-scheduled meeting is ALSO linked to the conversation it was created
    // from — that timeline still needs its own end trace.
    if ((m as any).conversationId && (m as any).conversationId !== att.conversationId)
      await postMeetingTrace(req, m, "📹 Meeting ended");
  } else {
    await postMeetingTrace(req, m, "📹 Meeting ended");
  }
  // BA/CEO #3: if the meeting chat was preserved as a temp group, push it to
  // every member in realtime — join their sockets to the new room and emit
  // CONVERSATION_NEW so it appears immediately (with an unread badge from the
  // "temporary group" notice) instead of only after a manual refetch. Mirrors
  // the call path (POST /conversations/temp-from-session).
  const tg = (m as any).tempGroup;
  const io = req.app.get("io");
  if (io && tg && tg.id) {
    const members = Array.from(
      new Set([req.user.userId, ...(tg.memberIds || [])].filter(Boolean)),
    );
    for (const uid of members) {
      io.in(broadcast.userRoom(uid)).socketsJoin(broadcast.room(tg.id));
      io.to(broadcast.userRoom(uid)).emit(EVENTS.CONVERSATION_NEW, {
        conversationId: tg.id,
      });
    }
    // Notify the other participants so the preserved meeting chat is noticed
    // (dedupKey shares the key with the meeting-start notify, so a member who was
    // already notified at start isn't notified again on end).
    await notifyAddedToTempGroup(io, {
      conversationId: tg.id,
      title: (m as any).title || null,
      actorId: req.user.userId,
      memberIds: members as string[],
    });
  }
  const { tempGroup, ...meetingOut } = m as any;
  res.json(ok(meetingOut));
});

// Any meeting PARTICIPANT — host, co-host, an invited attendee, or someone
// currently in the live room — may invite/add others (Zoom/Meet-style: sharing an
// invite isn't a host-only control). Disruptive controls (mute-all, remove, lock)
// stay host/co-host-only via requireMeetingHostOrCoHost.
async function requireMeetingParticipant(meetingId: string, userId: string) {
  const meeting = await db.meetings.getById(meetingId);
  if (!meeting) {
    const e: any = new Error("Meeting not found.");
    e.status = 404;
    throw e;
  }
  if (meeting.createdBy === userId) return meeting; // host
  const role = await db.meetings.getAttendeeRole(meetingId, userId);
  if (role) return meeting; // any attendee (participant / co-host)
  const present = await db.meetings.roomParticipants(meetingId).catch(() => []);
  if (present.some((p: any) => p.userId === userId)) return meeting; // live in the room
  const e: any = new Error("Only meeting participants can invite others.");
  e.status = 403;
  throw e;
}

async function requireMeetingHostOrCoHost(meetingId: string, userId: string) {
  const meeting = await db.meetings.getById(meetingId);
  if (!meeting) {
    const e: any = new Error("Meeting not found.");
    e.status = 404;
    throw e;
  }
  if (meeting.createdBy === userId) return meeting;
  const role = await db.meetings.getAttendeeRole(meetingId, userId);
  if (role === "co-host") return meeting;
  const e: any = new Error("Only the host or co-host can control meeting participants.");
  e.status = 403;
  throw e;
}

async function requireMeetingHost(meetingId: string, userId: string) {
  const meeting = await db.meetings.getById(meetingId);
  if (!meeting) {
    const e: any = new Error("Meeting not found.");
    e.status = 404;
    throw e;
  }
  if (meeting.createdBy !== userId) {
    const e: any = new Error("Only the host can perform this action.");
    e.status = 403;
    throw e;
  }
  return meeting;
}

router.post("/:id/controls/mute-all", async (req, res) => {
  await requireMeetingHostOrCoHost(req.params.id, req.user.userId);
  const result: any = await muteAllParticipants(
    "meeting_" + req.params.id,
    req.user.userId,
  );
  // Tell each muted person directly. Muting the track at the SFU silences them
  // for everyone else, but does NOT reliably reach their own client — so their
  // mic button and tile kept showing "live" while nobody could hear them.
  const io = req.app.get("io");
  if (io) {
    for (const uid of result?.mutedUserIds || []) {
      io.to(broadcast.userRoom(uid)).emit(EVENTS.MEDIA_FORCE_MUTE, {
        scope: "meeting",
        id: req.params.id,
        by: req.user.userId,
      });
    }
  }
  res.json(ok(result));
});

// NOTE: there is deliberately NO unmute-all counterpart. Un-muting a person's
// microphone is their own consent to give — a host may mute the room, never
// switch someone's mic back on for them.

router.post("/:id/controls/participants/:userId/mute", async (req, res) => {
  await requireMeetingHostOrCoHost(req.params.id, req.user.userId);
  const muted = (req.body || {}).muted !== false;
  const result: any = await muteParticipant(
    "meeting_" + req.params.id,
    req.params.userId,
    muted,
  );
  // Same blind spot as mute-all: the SFU mute doesn't reliably reach the muted
  // person's own client, so tell them directly. Only for an actual mute — this
  // never force-UNmutes anyone (that stays their own choice).
  const io = req.app.get("io");
  if (io && muted && result?.tracks > 0) {
    io.to(broadcast.userRoom(req.params.userId)).emit(EVENTS.MEDIA_FORCE_MUTE, {
      scope: "meeting",
      id: req.params.id,
      by: req.user.userId,
    });
  }
  res.json(ok(result));
});

router.delete("/:id/controls/participants/:userId", async (req, res) => {
  await requireMeetingHostOrCoHost(req.params.id, req.user.userId);
  if (req.params.userId === req.user.userId) {
    const e: any = new Error("The host cannot remove themselves.");
    e.status = 400;
    throw e;
  }
  // Persist the eject FIRST so the user can't re-mint a token and rejoin in
  // the few ms between the SFU kick and the row write. The eject check in
  // meetingService.enterRoom returns { ejected:true } and the calls route
  // maps that to 403 "removed".
  try {
    await (db.meetings as any).meetingEject(
      req.params.id,
      req.params.userId,
      req.user.userId,
    );
  } catch (_) {
    // best-effort — even without persistence, the SFU kick still happens below
  }
  res.json(
    ok(await removeParticipant("meeting_" + req.params.id, req.params.userId)),
  );
});

// Host can revoke an eject (admit a previously-removed user back). Useful if
// they removed the wrong person; saves the user from a "you were removed"
// dead-end with no way to recover except waiting for the meeting to end.
router.post("/:id/controls/participants/:userId/readmit", async (req, res) => {
  await requireMeetingHostOrCoHost(req.params.id, req.user.userId);
  try {
    await (db.meetings as any).meetingEjectClear(req.params.id, req.params.userId);
  } catch (_) {}
  res.json(ok({ readmitted: true, meetingId: req.params.id, userId: req.params.userId }));
});

// --- Public (guest) join link --------------------------------------------
// Host / co-host only (enforced in guestMeetingService). POST is idempotent: it
// returns the existing link or mints one. DELETE revokes — the old URL stops
// resolving at once. The token is returned ONLY from here; meeting payloads carry
// just `publicLinkEnabled`.
const publicLinkBody = (r: any) => ({
  enabled: !!r.enabled,
  token: r.token || null,
  path: r.token ? "/join/" + r.token : null,
});
router.get("/:id/public-link", async (req, res) => {
  res.json(ok(publicLinkBody(await getPublicLink({ meetingId: req.params.id, userId: req.user.userId }))));
});
router.post("/:id/public-link", async (req, res) => {
  const r = await ensurePublicLink({ meetingId: req.params.id, userId: req.user.userId });
  if (r.created)
    void auditRecord({ actorId: req.user.userId, action: "meeting.public_link_create", targetType: "meeting", targetId: req.params.id });
  await emitMeetingUpdateById(req, req.params.id);
  res.json(ok(publicLinkBody(r)));
});
router.delete("/:id/public-link", async (req, res) => {
  const r = await revokePublicLink({ meetingId: req.params.id, userId: req.user.userId });
  void auditRecord({ actorId: req.user.userId, action: "meeting.public_link_revoke", targetType: "meeting", targetId: req.params.id });
  await emitMeetingUpdateById(req, req.params.id);
  res.json(ok(publicLinkBody(r)));
});

// --- Lobby / waiting room ---
router.post("/:id/lobby/toggle", async (req, res) => {
  const r = await toggleLobby({
    meetingId: req.params.id,
    userId: req.user.userId,
    enabled: (req.body || {}).enabled,
  });
  if (!r) return res.status(403).json(ok({ toggled: false }));
  broadcastMeeting(req, await db.meetings.getById(req.params.id));
  res.json(ok(r));
});

// --- Free/busy for the scheduler ---
// POST, not GET, because the attendee list can be long enough to strain a query
// string. Answers only for people the caller could invite anyway.
router.post("/availability", async (req, res) => {
  const { userIds, startsAt, durationMin, excludeMeetingId } = req.body || {};
  res.json(
    ok(
      await meetingAvailability({
        userIds,
        startsAt,
        durationMin,
        excludeMeetingId,
        viewerId: req.user.userId,
      }),
    ),
  );
});

// --- Polls (0121) ---
// Everyone in the meeting can read and vote; only host/co-host can create,
// close or delete (enforced in the service). Every mutation broadcasts the
// poll's FULL new state to the meeting room, so no client has to merge a
// partial update — the last event always wins and they cannot disagree.
function emitPoll(req: any, poll: any) {
  const io = req.app.get("io");
  if (io && poll) io.to("meeting:" + req.params.id).emit(EVENTS.MEETING_POLL, poll);
}

router.get("/:id/polls", async (req, res) =>
  res.json(ok(await pollService.list({ meetingId: req.params.id, userId: req.user.userId }))),
);

router.post("/:id/polls", async (req, res) => {
  const { question, options, anonymous, multiChoice } = req.body || {};
  const poll = await pollService.create({
    meetingId: req.params.id,
    userId: req.user.userId,
    question,
    options,
    anonymous,
    multiChoice,
  });
  emitPoll(req, poll);
  void auditRecord({
    actorId: req.user.userId,
    action: "meeting.poll.create",
    targetType: "meeting",
    targetId: req.params.id,
    detail: { pollId: poll.id, anonymous: poll.anonymous },
  });
  res.status(201).json(ok(poll));
});

router.post("/:id/polls/:pollId/vote", async (req, res) => {
  const poll = await pollService.vote({
    pollId: req.params.pollId,
    userId: req.user.userId,
    optionIndexes: (req.body || {}).optionIndexes ?? (req.body || {}).optionIndex,
  });
  // Broadcast the updated tally to everyone. `myVote` in the payload is the
  // VOTER's own — each client overlays its own answer from its own request, so
  // a broadcast can never tell someone else what they voted.
  emitPoll(req, { ...poll, myVote: [] });
  res.json(ok(poll));
});

router.post("/:id/polls/:pollId/close", async (req, res) => {
  const poll = await pollService.close({
    pollId: req.params.pollId,
    userId: req.user.userId,
  });
  emitPoll(req, { ...poll, myVote: [] });
  res.json(ok(poll));
});

router.get("/:id/polls/:pollId/voters", async (req, res) =>
  res.json(
    ok(await pollService.voters({ pollId: req.params.pollId, userId: req.user.userId })),
  ),
);

router.delete("/:id/polls/:pollId", async (req, res) => {
  const out = await pollService.remove({
    pollId: req.params.pollId,
    userId: req.user.userId,
  });
  const io = req.app.get("io");
  if (io)
    io.to("meeting:" + req.params.id).emit(EVENTS.MEETING_POLL_REMOVED, {
      meetingId: req.params.id,
      pollId: req.params.pollId,
    });
  res.json(ok(out));
});

// --- Attendance report (0119) ---
// Who actually attended, for how long, across however many times they dropped
// and rejoined. Host and co-host only: it is a record of people's behaviour, so
// it gets the same gate as the other host surfaces rather than being readable by
// every attendee.
router.get("/:id/attendance", async (req, res) => {
  const report = await meetingAttendance({
    meetingId: req.params.id,
    userId: req.user.userId,
    since: req.query.since ? String(req.query.since) : null,
  });
  if (!report) return res.status(404).json(fail("NOT_FOUND", "Meeting not found."));
  // ?format=csv gives the download an organiser actually wants to hand to
  // finance or a training record, rather than making them transcribe a table.
  if (String(req.query.format || "").toLowerCase() === "csv") {
    // ISO 8601, not Date.toString() — a CSV opened in a spreadsheet in another
    // locale must not become unparseable, and "Fri Sep 04 2026 GMT+0530" is.
    const isoOrBlank = (v: any) => {
      const d = new Date(v);
      return Number.isFinite(d.getTime()) ? d.toISOString() : "";
    };
    const esc = (v: any) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const rows = [
      ["Name", "Email", "First joined", "Last left", "Sessions", "Duration (minutes)", "Still present"],
      ...report.rows.map((r: any) => [
        r.name, r.email, isoOrBlank(r.firstJoined), isoOrBlank(r.lastLeft), r.sessions,
        Math.round(r.seconds / 60), r.stillPresent ? "yes" : "no",
      ]),
    ];
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="attendance-${req.params.id}.csv"`,
    );
    return res.send(rows.map((r) => r.map(esc).join(",")).join("\n"));
  }
  res.json(ok(report));
});

// --- Per-meeting options (0116) ---
// GET is open to anyone in the meeting: the client needs the policy to disable
// the controls the server would refuse anyway, so the UI matches reality.
router.get("/:id/options", async (req, res) => {
  const out = await getMeetingOptions({
    meetingId: req.params.id,
    userId: req.user.userId,
  });
  if (!out) return res.status(404).json(fail("NOT_FOUND", "Meeting not found."));
  res.json(ok(out));
});

// PATCH is host/co-host only (enforced in the service). Persists, re-permissions
// everyone already in the room, then tells every attendee to re-read.
router.patch("/:id/options", async (req, res) => {
  const out = await setMeetingOptions({
    meetingId: req.params.id,
    userId: req.user.userId,
    patch: req.body || {},
  });
  if (!out) return res.status(404).json(fail("NOT_FOUND", "Meeting not found."));
  // Two signals on purpose. MEETING_UPDATED refreshes the meeting everywhere it
  // is listed; MEETING_OPTIONS carries the new policy to people IN the room so
  // their controls update without a round-trip.
  const io = req.app.get("io");
  // The in-meeting socket room is a bare `meeting:<id>` (realtime/socket.ts),
  // NOT a conversation room — broadcast.room() would prefix it with "conv:".
  if (io) io.to("meeting:" + req.params.id).emit(EVENTS.MEETING_OPTIONS, out);
  broadcastMeeting(req, await db.meetings.getById(req.params.id));
  await auditRecord({
    actorId: req.user.userId,
    action: "meeting.options.update",
    targetType: "meeting",
    targetId: req.params.id,
    detail: req.body || {},
  });
  res.json(ok(out));
});

// --- Host Settings modal (creator only) ---------------------------------
// Camera / screen share / whiteboard, meeting-wide and per person. Mute-all,
// mute-one and remove already exist above and are reused by the modal as-is.
// Every route here is the meeting's CREATOR only (enforced in the service) —
// co-hosts are deliberately not let in.
router.get("/:id/controls/settings", async (req, res) => {
  res.json(ok(await getHostControls({ meetingId: req.params.id, userId: req.user.userId })));
});

// Tell people their own client to stop what it is publishing. The SFU mute
// blanks it for viewers but does not reliably reach the owner's UI.
function emitForcedStops(req: any, meetingId: string, by: string, stopped: any) {
  const io = req.app.get("io");
  if (!io) return;
  for (const uid of stopped?.cameraUserIds || [])
    io.to(broadcast.userRoom(uid)).emit(EVENTS.MEDIA_FORCE_CAMERA_OFF, { scope: "meeting", id: meetingId, by });
  for (const uid of stopped?.screenUserIds || [])
    io.to(broadcast.userRoom(uid)).emit(EVENTS.MEDIA_FORCE_STOP_SCREEN, { scope: "meeting", id: meetingId, by });
}

router.patch("/:id/controls/settings", async (req, res) => {
  const out: any = await setHostSettings({
    meetingId: req.params.id,
    userId: req.user.userId,
    patch: req.body || {},
  });
  const io = req.app.get("io");
  // Same pair of signals as PATCH /options: the policy to everyone in the room,
  // and a meeting refresh everywhere it is listed.
  if (io) io.to("meeting:" + req.params.id).emit(EVENTS.MEETING_OPTIONS, { ...out, stopped: undefined, applied: undefined, patch: undefined });
  emitForcedStops(req, req.params.id, req.user.userId, out.stopped);
  broadcastMeeting(req, await db.meetings.getById(req.params.id));
  await auditRecord({
    actorId: req.user.userId,
    action: "meeting.host_settings.update",
    targetType: "meeting",
    targetId: req.params.id,
    detail: out.patch,
  });
  res.json(ok(out));
});

router.patch("/:id/controls/participants/:userId/permissions", async (req, res) => {
  const out: any = await setParticipantPermissions({
    meetingId: req.params.id,
    userId: req.user.userId,
    targetUserId: req.params.userId,
    patch: req.body || {},
  });
  const io = req.app.get("io");
  if (io)
    io.to(broadcast.userRoom(req.params.userId)).emit(EVENTS.MEETING_PARTICIPANT_PERMISSIONS, {
      meetingId: req.params.id,
      cameraBlocked: out.cameraBlocked,
      screenShareBlocked: out.screenShareBlocked,
      whiteboardBlocked: out.whiteboardBlocked,
      by: req.user.userId,
    });
  emitForcedStops(req, req.params.id, req.user.userId, out.stopped);
  await auditRecord({
    actorId: req.user.userId,
    action: "meeting.participant_permissions.update",
    targetType: "meeting",
    targetId: req.params.id,
    detail: { userId: req.params.userId, ...out.changed },
  });
  res.json(ok(out));
});

// --- Lock / unlock (host seals the room) ---
router.post("/:id/lock", async (req, res) => {
  const r = await toggleLock({
    meetingId: req.params.id,
    userId: req.user.userId,
    locked: (req.body || {}).locked,
  });
  if (!r) return res.status(403).json(ok({ locked: false }));
  await emitPresence(req, req.params.id);
  res.json(ok(r));
});

// What the GREEN ROOM shows everyone before they join — invited or not: whether
// the meeting has started, how many people are already in it, and who. Held
// people get the same facts from /lobby/self while they wait, so the two screens
// can never disagree. Same narrow projection: name badges, no contact details.
router.get("/:id/preview", async (req, res) => {
  const r = await roomPreview({
    meetingId: req.params.id,
    userId: req.user.userId,
  });
  if (!r) return res.status(404).json(fail("NOT_FOUND", "Meeting not found."));
  res.json(ok(r));
});

// The waiting person's own view: their status plus what the wait screen shows
// (who is already inside, who else is holding, whether it has started). Any
// authenticated user may read it for a meeting they are queued at — it is the
// only thing they CAN see, and it carries public profile fields only.
router.get("/:id/lobby/self", async (req, res) => {
  const r = await lobbySelf({
    meetingId: req.params.id,
    userId: req.user.userId,
  });
  if (!r || !r.lobby) return res.status(404).json(fail("NOT_FOUND", "Meeting not found."));
  res.json(ok(r));
});

router.get("/:id/lobby", async (req, res) => {
  const list = await lobbyList({
    meetingId: req.params.id,
    userId: req.user.userId,
  });
  res.json(ok(list));
});

router.post("/:id/lobby/admit", async (req, res) => {
  const { userId: targetUserId } = req.body || {};
  const r = await lobbyAdmit({
    meetingId: req.params.id,
    userId: req.user.userId,
    targetUserId,
  });
  const io = req.app.get("io");
  if (io) {
    io.to(broadcast.userRoom(targetUserId)).emit(EVENTS.MEETING_UPDATED, {
      meetingId: req.params.id,
      lobbyAdmitted: true,
    });
    await emitPresence(req, req.params.id);
  }
  res.json(ok(r));
});

router.post("/:id/lobby/deny", async (req, res) => {
  const { userId: targetUserId } = req.body || {};
  const r = await lobbyDeny({
    meetingId: req.params.id,
    userId: req.user.userId,
    targetUserId,
  });
  const io = req.app.get("io");
  if (io)
    io.to(broadcast.userRoom(targetUserId)).emit(EVENTS.MEETING_UPDATED, {
      meetingId: req.params.id,
      lobbyDenied: true,
    });
  res.json(ok(r));
});

router.post("/:id/lobby/admit-all", async (req, res) => {
  const r = await lobbyAdmitAll({
    meetingId: req.params.id,
    userId: req.user.userId,
  });
  const io = req.app.get("io");
  if (io) {
    const list = await lobbyList({ meetingId: req.params.id, userId: req.user.userId });
    for (const p of list)
      io.to(broadcast.userRoom(p.userId)).emit(EVENTS.MEETING_UPDATED, {
        meetingId: req.params.id,
        lobbyAdmitted: true,
      });
  }
  res.json(ok(r));
});

// --- Co-host management ---
router.post("/:id/controls/participants/:userId/promote", async (req, res) => {
  const r = await promoteCoHost({
    meetingId: req.params.id,
    userId: req.user.userId,
    targetUserId: req.params.userId,
  });
  await emitPresence(req, req.params.id);
  res.json(ok(r));
});

router.post("/:id/controls/participants/:userId/demote", async (req, res) => {
  const r = await demoteCoHost({
    meetingId: req.params.id,
    userId: req.user.userId,
    targetUserId: req.params.userId,
  });
  await emitPresence(req, req.params.id);
  res.json(ok(r));
});

// Broadcast a meeting change to all attendees (used by recording actions).
async function emitMeetingUpdateById(req: any, meetingId: string) {
  const io = req.app.get("io");
  if (!io) return;
  const m = await db.meetings.getById(meetingId);
  if (!m) return;
  const ids = new Set<string>(
    [m.createdBy, ...(m.attendees || []).map((a: any) => a.userId)].filter(
      Boolean,
    ),
  );
  for (const uid of ids)
    io.to(broadcast.userRoom(uid)).emit(EVENTS.MEETING_UPDATED, { meetingId });
}

router.get("/:id/recordings", async (req, res) =>
  res.json(
    ok(
      await listRecordings({
        meetingId: req.params.id,
        userId: req.user.userId,
      }),
    ),
  ),
);
router.post("/:id/recordings/start", async (req, res) => {
  const rec = await startRecording({
    meetingId: req.params.id,
    userId: req.user.userId,
  });
  // REC-11: every recording lifecycle/access event is audit-logged.
  void recordEvents(["recording.start"]); // §9.2
  void auditRecord({ actorId: req.user.userId, action: "recording.start", targetType: "recording", targetId: (rec as any)?.id || null, detail: { meetingId: req.params.id } });
  await emitMeetingUpdateById(req, req.params.id);
  res.status(201).json(ok(rec));
});
router.post("/:id/recordings/:rid/stop", async (req, res) => {
  const rec = await stopRecording({
    meetingId: req.params.id,
    recordingId: req.params.rid,
    userId: req.user.userId,
  });
  void recordEvents(["recording.stop"]); // §9.2
  void auditRecord({ actorId: req.user.userId, action: "recording.stop", targetType: "recording", targetId: req.params.rid, detail: { meetingId: req.params.id } });
  await emitMeetingUpdateById(req, req.params.id);
  res.json(ok(rec));
});
router.delete("/:id/recordings/:rid", async (req, res) => {
  const r = await removeRecording({
    meetingId: req.params.id,
    recordingId: req.params.rid,
    userId: req.user.userId,
  });
  void recordEvents(["recording.delete"]); // §9.2
  void auditRecord({ actorId: req.user.userId, action: "recording.delete", targetType: "recording", targetId: req.params.rid, detail: { meetingId: req.params.id } });
  await emitMeetingUpdateById(req, req.params.id);
  res.json(ok(r));
});

// Client-side recording upload (browser MediaRecorder blob). Raw body — a
// route-level express.raw overrides the global express.json parser for this one
// route so the video bytes arrive intact as a Buffer (mirrors /api/files).
router.post(
  "/:id/recordings/upload",
  express.raw({ type: "*/*", limit: "2gb" }),
  async (req, res) => {
    const mime = req.query.mime
      ? String(req.query.mime)
      : req.headers["content-type"] || "video/webm";
    const durationSec = req.query.durationSec ? Number(req.query.durationSec) : 0;
    const data = Buffer.isBuffer(req.body) ? req.body : Buffer.from([]);
    if (!data.length)
      return res.status(400).json(fail("BAD_REQUEST", "The recording was empty."));
    const rec = await uploadClientRecording({
      meetingId: req.params.id,
      userId: req.user.userId,
      data,
      mime,
      durationSec,
    });
    void recordEvents(["recording.upload"]); // §9.2
  void auditRecord({ actorId: req.user.userId, action: "recording.upload", targetType: "recording", targetId: (rec as any)?.id || null, detail: { meetingId: req.params.id, sizeBytes: data.length, durationSec } });
    await emitMeetingUpdateById(req, req.params.id);
    res.status(201).json(ok(rec));
  },
);

// Stream a stored recording for inline playback / download.
router.get("/:id/recordings/:rid/download", async (req, res) => {
  const r = await getRecordingDownload({
    meetingId: req.params.id,
    recordingId: req.params.rid,
    userId: req.user.userId,
  });
  // REC-12: download/playback events are logged (fires only AFTER the access
  // check above passed — a denied request never reaches this line).
  void recordEvents(["recording.download"]); // §9.2
  void auditRecord({ actorId: req.user.userId, action: "recording.download", targetType: "recording", targetId: req.params.rid, detail: { meetingId: req.params.id } });
  res.setHeader("Content-Type", r.mime);
  res.setHeader("Content-Disposition", "inline");
  res.setHeader("Accept-Ranges", "bytes");
  const s = r.stream;
  s.on("error", () => {
    if (!res.headersSent) res.status(500).end();
    else res.destroy();
  });
  s.pipe(res);
});

export default router;
