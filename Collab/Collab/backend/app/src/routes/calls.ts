import express from "express";
import { asyncRouter } from "../asyncRouter";
import * as meetingPolicy from "../services/meetingPolicy";
import { ok, fail, db, config, shared } from "../platform";
import authMiddleware from "../middleware/auth";
import { history, getById } from "../services/callService";
import {
  roomToken,
  publicWsUrl,
  muteParticipant,
  muteAllParticipants,
  enforceSelfMuteState,
  removeParticipant,
  evictPriorSessions,
} from "../services/livekitService";
import {
  leave as leaveVoicemail,
  listForUser as listVoicemails,
  markListened as markVmListened,
  remove as removeVoicemail,
  getAudio as getVmAudio,
} from "../services/voicemailService";
import { enterRoom as meetingEnterRoom } from "../services/meetingService";
import { broadcast, acceptDirectCall, declineDirectCall } from "../realtime/socket";
import { userAvatarUrl } from "../serialize";
import { create as createConversation } from "../services/conversationService";
import * as huddleStore from "../services/huddleStore";

const { EVENTS } = shared;
const router = asyncRouter();

// publicWsUrl() now lives in services/livekitService.ts (shared with the
// realtime layer); re-exported so existing importers and tests keep working.
export { publicWsUrl };

function parseEncryptedMeta(req) {
  const raw =
    req.headers["x-colab-e2ee"] ||
    req.headers["x-colab-encryption"] ||
    req.query.encrypted;
  if (!raw) return null;
  try {
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return { version: 1, algorithm: "aes-gcm", malformed: true };
  }
}

function setEncryptedHeader(res, f) {
  if (!f || !Number(f.encryptionVersion)) return;
  res.setHeader(
    "X-CoLab-E2EE",
    JSON.stringify({
      version: f.encryptionVersion,
      ...(f.ciphertextMeta || {}),
    }),
  );
}

// Ringing/control signalling (request/accept/decline/cancel/hangup) is realtime
// over Socket.IO (see realtime/socket.ts). Media runs through the LiveKit SFU;
// this route exposes call history and mints LiveKit room tokens.
router.use(authMiddleware);

router.get("/", async (req, res) => {
  const { before, limit } = req.query as any;
  res.json(
    ok(
      await history(req.user.userId, {
        before: before || null,
        limit: Math.min(Number(limit) || 50, 100),
      }),
    ),
  );
});

const deny = (status, message) => {
  const e: any = new Error(message);
  e.status = status;
  return e;
};

// Terminal 1:1-call statuses (mirror of callService TERMINAL): once a call is in
// any of these, its room token must no longer be minted — the call is over.
const TERMINAL_CALL_STATUSES = [
  "ended",
  "declined",
  "cancelled",
  "missed",
  "failed",
  "busy",
];

// Issue a LiveKit room token, GATED by membership (closes the call IDOR):
//   { callId }         -> 1:1 room  "call_<id>"  (must be a call participant)
//   { conversationId } -> group room "conv_<id>" (must be a conversation member)
router.post("/token", async (req, res) => {
  const t0 = Date.now();
  const uid = req.user.userId;
  let { callId, conversationId, meetingId } = req.body || {};
  if (meetingId) meetingId = String(meetingId).split("__occ_")[0];
  let room;
  // The participant's profile photo, for camera-off tiles (best-effort). Kicked
  // off NOW so it overlaps the membership read below instead of following it.
  const meUserP = db.users.getById(uid).catch(() => null);
  let directCall: any = null;
  if (callId) {
    const call = await getById(callId);
    if (!call) throw deny(404, "call not found");
    directCall = call;
    if (call.initiatorId !== uid && call.peerId !== uid)
      throw deny(403, "You are not a participant in this call.");
    // A finished 1:1 call session can't be rejoined via its old token — the link
    // expires the moment the call ends (hangup/decline/miss/cancel). Rejoining a
    // person requires placing a FRESH call, which mints a new callId. Without this
    // the /token endpoint (the call's effective "link") stayed open after the call
    // was over. See TERMINAL in callService.
    if (TERMINAL_CALL_STATUSES.includes(String(call.status)))
      throw deny(403, "This call has ended.");
    room = "call_" + callId;
  } else if (conversationId) {
    if (!(await db.conversations.isMember(conversationId, uid)))
      throw deny(403, "You can only join calls for conversations you're in.");
    room = "conv_" + conversationId;
  } else if (meetingId) {
    // Meeting A/V room — JOIN BY ID/LINK. The meeting id is an unguessable UUID
    // and acts as the access credential (like Zoom/Meet): anyone holding it may
    // ATTEMPT entry, including people who weren't explicitly invited. The real
    // gate is enterRoom, which enforces (in order) host eject, lock, and the
    // host's lobby — uninvited / non-host users wait for admission whenever the
    // lobby is on, so a host who wants every join vetted just turns the lobby on.
    // enterRoom returns an object with `.meeting` ONLY when entry is granted;
    // refusals return null / {ejected} / {locked} / {lobbyStatus} WITHOUT
    // `.meeting`. It is idempotent (presence/status upserts), so re-running it
    // here (the client also calls it at room/enter) is harmless.
    const m = await db.meetings.getById(meetingId);
    if (!m) throw deny(404, "meeting not found");
    const entry: any = await meetingEnterRoom({ meetingId, userId: uid });
    if (!entry || !entry.meeting) {
      // Eject takes precedence — if the host removed this user, the front-end
      // should say "you were removed", not "you're not admitted yet". The
      // client's error categorization keys off the word "removed" in the
      // message string (see CoLabV1.tsx + MeetingStage.tsx 403 handling).
      if (entry && entry.closed) throw deny(403, "This meeting has ended.");
      if (entry && entry.ejected)
        throw deny(403, "You were removed from this meeting by the host.");
      if (entry && entry.locked) throw deny(403, "This meeting is locked.");
      throw deny(403, "You haven't been admitted to this meeting yet.");
    }
    room = "meeting_" + meetingId;
  } else {
    throw deny(400, "callId, conversationId or meetingId required");
  }
  // Determine role for LiveKit token permissions
  let role = "participant";
  // PER-MEETING OPTIONS (0116): what this participant may publish. Left
  // undefined for calls and huddles, where roomToken's default (everything)
  // applies — options are a meeting concept only.
  let grant: { canPublish?: boolean; canPublishSources?: any[] } = {};
  if (meetingId) {
    const m = await db.meetings.getById(meetingId);
    let attendeeRole: string | null = null;
    if (m && m.createdBy === uid) {
      role = "host";
    } else {
      try {
        attendeeRole = await db.meetings.getAttendeeRole(meetingId, uid);
        if (attendeeRole) role = attendeeRole;
      } catch (_) {}
    }
    // SERVER-SIDE ENFORCEMENT. The grant is computed from the same function
    // that re-permissions live participants when a host changes the policy
    // (services/meetingPolicy.effectiveGrant), so a late joiner and someone
    // already in the room always end up with identical permissions. Because
    // this rides in the signed token, an attendee who may not present is
    // refused by the SFU itself — not merely by a hidden button.
    if (m)
      grant = meetingPolicy.grantForUser(m, uid, {
        isHost: role === "host",
        isCoHost: attendeeRole === "co-host",
      });
  }
  // One active session per user: on a FRESH join (client sends fresh:true), evict any
  // prior session of this user in the room, so a second tab/device REPLACES the old
  // one instead of the same person appearing twice. fresh-gated so a token REFRESH can
  // never self-evict; evictPriorSessions is fail-soft so it never blocks the join.
  // CALL HOST, by the same rules the moderation routes enforce (requireCallHost /
  // requireConvOwner): the initiator of a 1:1 call; a group's owner/admin/creator
  // or whoever started the huddle. It rides in the signed token metadata so every
  // client can TRUST "this participant is the host" — which is what lets a
  // host-driven view change (spotlight) be honoured in calls at all.
  if (!meetingId) {
    if (directCall) {
      // 1:1 host = the initiator; same rule as requireCallHost, without re-reading
      // the row we already have.
      if (directCall.initiatorId === uid) role = "host";
    } else if (conversationId) {
      try {
        await requireConvOwner(conversationId, uid);
        role = "host";
      } catch (_) {
        /* not the host — stays "participant" */
      }
    }
  }
  // One active session per user: a FRESH join evicts this user's prior session
  // in the room. The eviction is a LiveKit API round trip; it is NOT awaited —
  // identities carry a per-join suffix so the new join never collides with the
  // old one, and the old session is gone a moment later either way. Fail-soft.
  if ((req.body || {}).fresh) void evictPriorSessions(room, uid).catch(() => {});
  const meUser = await meUserP;
  const out = await roomToken({
    userId: uid,
    name: req.user.name,
    avatarUrl: userAvatarUrl(meUser),
    room,
    role,
    wsUrl: publicWsUrl(req),
    ...grant,
  });
  if (callId) console.log("[CallTrace:server] call=%s token +%dms", callId, Date.now() - t0);
  res.json(ok(out));
});

// Pre-flight connection check: mint a token for the caller's OWN private probe
// room so the client can verify the full media path (connect + ICE/TURN relay)
// without needing a peer or a real call. No membership needed — just auth.
router.post("/diag-token", async (req, res) => {
  const uid = req.user.userId;
  res.json(
    ok(
      await roomToken({
        userId: uid,
        name: req.user.name,
        room: "diag_" + uid,
        wsUrl: publicWsUrl(req),
      }),
    ),
  );
});

async function requireConvOwner(conversationId: string, userId: string) {
  const members = await db.conversations.members(conversationId);
  const me = members.find((m: any) => m.userId === userId);
  if (me && (me.role === "owner" || me.role === "admin")) return;
  // Also accept the conversation CREATOR (matches the meeting host gate + the
  // client's host check) — a creator whose member role wasn't stamped
  // owner/admin would otherwise see the control but get a confusing 403.
  try {
    const conv = await db.conversations.getById(conversationId);
    if (conv && conv.createdBy === userId) return;
  } catch (_) {}
  // Also accept whoever STARTED this group call. Product rule: the call starter
  // is the call's host (parity with meetings) even if they aren't the group's
  // owner/admin — so any member who kicks off a huddle can moderate it. The
  // client mirrors this by showing the controls when dir==="out".
  try {
    const starter = await huddleStore.huddleStarter(conversationId);
    if (starter && starter === userId) return;
  } catch (_) {}
  throw deny(403, "Only the group owner, admin, or the person who started the call can control participants.");
}

// 1:1 call host = the INITIATOR (the person who placed the call). Durable on the
// call record, so it survives reconnects. Powers the /direct/:callId controls
// that target the "call_<id>" room (a 1:1 call has no conversation to own).
async function requireCallHost(callId: string, userId: string) {
  const call = await getById(callId);
  if (!call) throw deny(404, "call not found");
  if (call.initiatorId !== userId)
    throw deny(403, "Only the person who started the call can control participants.");
  return call;
}

// A 1:1 call has exactly two people and no conversation to own, so BOTH parties
// may mute/unmute the room (product decision: in a two-person call either side
// can settle the audio). Destructive controls (remove/end) stay initiator-only
// via requireCallHost above.
async function requireDirectCallParty(callId: string, userId: string) {
  const call = await getById(callId);
  if (!call) throw deny(404, "call not found");
  if (call.initiatorId !== userId && call.peerId !== userId)
    throw deny(403, "Only people on this call can control its audio.");
  return call;
}

// Tell each muted person directly. Muting a track at the SFU silences them for
// everyone else but does NOT reliably reach their own client, so their mic
// button and tile kept showing "live" while nobody could hear them.
function notifyForceMuted(req: any, result: any, scope: string, id: string) {
  const io = req.app.get("io");
  if (!io) return;
  for (const uid of result?.mutedUserIds || []) {
    io.to(broadcast.userRoom(uid)).emit(EVENTS.MEDIA_FORCE_MUTE, {
      scope,
      id,
      by: req.user.userId,
    });
  }
}

// MIC-02: a client reports ITS OWN mute state so the server re-asserts it at
// the SFU (immediately + a delayed re-check) — a client bug that keeps
// publishing while the UI says muted cannot leak audio past this. The clients
// send it on every self-toggle, on connect, and after every reconnect.
// Self-targeting by construction: enforcement uses req.user.userId, so no
// membership check is needed — the worst a caller can do is mute themselves.
// Room ids come from LiveKit's Room.name, always one of our three prefixes.
router.post("/media/self-mute-state", async (req, res) => {
  const { room, muted } = req.body || {};
  if (typeof room !== "string" || !/^(conv|call|meeting)_[A-Za-z0-9_-]{1,64}$/.test(room))
    throw deny(400, "Invalid room.");
  res.json(ok(await enforceSelfMuteState(room, req.user.userId, muted === true)));
});

router.post("/group/:convId/controls/mute-all", async (req, res) => {
  await requireConvOwner(req.params.convId, req.user.userId);
  const result: any = await muteAllParticipants(
    "conv_" + req.params.convId,
    req.user.userId,
  );
  notifyForceMuted(req, result, "call", req.params.convId);
  res.json(ok(result));
});

// No unmute-all counterpart by design: switching someone's mic back on is
// their consent to give, not the host's to take.

router.post(
  "/group/:convId/controls/participants/:userId/mute",
  async (req, res) => {
    await requireConvOwner(req.params.convId, req.user.userId);
    const muted = (req.body || {}).muted !== false;
    const result: any = await muteParticipant(
      "conv_" + req.params.convId,
      req.params.userId,
      muted,
    );
    // Tell the muted person, exactly as mute-all and the meetings routes do.
    // Without this, muting ONE person in a call left their mic button and tile
    // still showing "live" while nobody could hear them — the original report,
    // which mute-all fixed but this path did not. Never on an unmute: switching
    // someone's mic back on stays their own choice.
    notifyForceMuted(req, { mutedUserIds: muted && result?.tracks > 0 ? [req.params.userId] : [] }, "call", req.params.convId);
    res.json(ok(result));
  },
);

router.delete(
  "/group/:convId/controls/participants/:userId",
  async (req, res) => {
    await requireConvOwner(req.params.convId, req.user.userId);
    if (req.params.userId === req.user.userId)
      throw deny(400, "You cannot remove yourself from the call.");
    res.json(
      ok(
        await removeParticipant("conv_" + req.params.convId, req.params.userId),
      ),
    );
  },
);

// ── 1:1 (direct) call controls ──────────────────────────────────────────────
// A 1:1 call has no conversation to own, so its moderation targets the LiveKit
// "call_<id>" room and is gated on the call INITIATOR (the starter/host). "Mute
// everyone" here simply mutes the one other party (exceptUserId=self); Remove
// ends the call for them. Parity with meetings' host controls.
// ── K6: REST accept / decline for 1:1 calls (mobile push) ────────────────────
// A phone answering or declining a push-delivered ring from the shade / CallKit
// while the app is killed has NO socket (Android runs the action in a background
// isolate), so CALL_ACCEPT / CALL_DECLINE can't be emitted. These mirror the
// socket handlers exactly (state transition, events to both parties, ring
// retraction, call log) so the caller stops hearing ringback right away instead
// of waiting for CALL_MISSED_MS. Only the callee may act (callService enforces).
// Returns { call, token, wsUrl, room, role, iceServers }: the callee's room token
// rides back with the accept so a killed-state phone joins straight away instead
// of spending another round trip on POST /token (mobile handoff, Oct 2026).
router.post("/direct/:callId/accept", async (req, res) => {
  const t0 = Date.now();
  const callId = String(req.params.callId);
  let call: any;
  try {
    call = await acceptDirectCall(req.app.get("io"), {
      callId,
      userId: req.user.userId,
      // The device that answered must not receive its own "answered elsewhere"
      // retraction (it raced the CallKit entry of the live call).
      sessionJti: req.user.jti || null,
      deviceId: req.user.deviceId || null,
    });
  } catch (e: any) {
    throw deny(e?.status || 500, e?.message || "Could not accept the call.");
  }
  let join: any = {};
  try {
    const meUser = await db.users.getById(req.user.userId).catch(() => null);
    join = await roomToken({
      userId: req.user.userId,
      name: req.user.name,
      avatarUrl: userAvatarUrl(meUser),
      room: "call_" + callId,
      role: "participant",
      wsUrl: publicWsUrl(req),
    });
  } catch (_) {
    /* the accept already happened; the app can still fall back to POST /token */
  }
  console.log("[CallTrace:server] call=%s accept.rest→accepted +%dms", callId, Date.now() - t0);
  res.json(ok({ call, ...join }));
});
router.post("/direct/:callId/decline", async (req, res) => {
  const reason = typeof (req.body || {}).reason === "string" ? req.body.reason : undefined;
  try {
    const call = await declineDirectCall(req.app.get("io"), { callId: String(req.params.callId), userId: req.user.userId, reason });
    res.json(ok({ call }));
  } catch (e: any) {
    throw deny(e?.status || 500, e?.message || "Could not decline the call.");
  }
});

router.post("/direct/:callId/controls/mute-all", async (req, res) => {
  await requireDirectCallParty(req.params.callId, req.user.userId);
  const result: any = await muteAllParticipants(
    "call_" + req.params.callId,
    req.user.userId,
  );
  notifyForceMuted(req, result, "call", req.params.callId);
  res.json(ok(result));
});


router.post(
  "/direct/:callId/controls/participants/:userId/mute",
  async (req, res) => {
    await requireCallHost(req.params.callId, req.user.userId);
    const muted = (req.body || {}).muted !== false;
    const result: any = await muteParticipant(
      "call_" + req.params.callId,
      req.params.userId,
      muted,
    );
    // Same as the group route: the SFU mute never reaches the muted person's own
    // client, so tell them directly. Mute only, never unmute.
    notifyForceMuted(req, { mutedUserIds: muted && result?.tracks > 0 ? [req.params.userId] : [] }, "call", req.params.callId);
    res.json(ok(result));
  },
);

router.delete(
  "/direct/:callId/controls/participants/:userId",
  async (req, res) => {
    await requireCallHost(req.params.callId, req.user.userId);
    if (req.params.userId === req.user.userId)
      throw deny(400, "You cannot remove yourself from the call.");
    res.json(
      ok(
        await removeParticipant("call_" + req.params.callId, req.params.userId),
      ),
    );
  },
);

router.post(
  "/voicemail",
  express.raw({ type: "*/*", limit: "100mb" }),
  async (req: any, res) => {
    const { toUserId, callId, durationSec, mime } = req.query as any;
    const data = Buffer.isBuffer(req.body) ? req.body : Buffer.from([]);
    if (!toUserId)
      return res.status(400).json(fail("BAD_REQUEST", "toUserId required"));
    if (!data.length)
      return res.status(400).json(fail("BAD_REQUEST", "Empty voicemail"));
    const vm = await leaveVoicemail({
      fromUserId: req.user.userId,
      toUserId: String(toUserId),
      callId: callId ? String(callId) : null,
      durationSec: Number(durationSec) || 0,
      mime: mime ? String(mime) : req.headers["content-type"] || "audio/webm",
      data,
      encrypted: parseEncryptedMeta(req),
    });
    res.status(201).json(ok(vm));
  },
);
router.get("/voicemails", async (req, res) =>
  res.json(ok(await listVoicemails(req.user.userId))),
);
router.post("/voicemails/:id/listened", async (req, res) =>
  res.json(
    ok(await markVmListened({ id: req.params.id, userId: req.user.userId })),
  ),
);
router.delete("/voicemails/:id", async (req, res) =>
  res.json(
    ok(await removeVoicemail({ id: req.params.id, userId: req.user.userId })),
  ),
);
router.get("/voicemails/:id/audio", async (req, res) => {
  const f = await getVmAudio({
    voicemailId: req.params.id,
    userId: req.user.userId,
  });
  if (!f) return res.status(404).json(fail("NOT_FOUND", "Voicemail not found"));
  res.setHeader("Content-Type", f.mime || "audio/webm");
  setEncryptedHeader(res, f);
  res.send(f.data);
});

// Promote a 1:1 call to a group call. Creates a group conversation from the two
// existing call parties + the invitees, then AUTO-MIGRATES the other party into
// the new "conv_<id>" room via CALL_UPGRADED. The caller migrates locally and
// rings the invitees via HUDDLE_RING (matching the existing group-call flow), so
// no new ring path is needed. Returns the new conversation.
router.post("/:callId/add-participants", async (req, res) => {
  const uid = req.user.userId;
  const userIds: string[] = Array.isArray((req.body || {}).userIds)
    ? (req.body.userIds as any[]).filter(Boolean)
    : [];
  const call = await getById(req.params.callId);
  if (!call) throw deny(404, "call not found");
  if (call.initiatorId !== uid && call.peerId !== uid)
    throw deny(403, "You are not a participant in this call.");
  if (!userIds.length) throw deny(400, "userIds required");
  const other = uid === call.initiatorId ? call.peerId : call.initiatorId;
  // Group = both existing call parties + the invitees (the creator, uid, is
  // added by the conversation service).
  const memberIds = [
    ...new Set([other, ...userIds].filter((id) => id && id !== uid)),
  ];
  const r = await createConversation({
    kind: shared.CONVERSATION.GROUP,
    title: null,
    icon: null,
    memberIds,
    creatorId: uid,
  });
  const conv = r && r.conversation;
  if (!conv) throw deny(500, "Could not create the group call.");
  const io = req.app.get("io");
  // Seed the new group huddle on the SERVER with BOTH existing call parties
  // BEFORE responding. The caller emits HUDDLE_RING immediately after this route
  // returns, and that ring is gated by huddleHas(caller). Registering here —
  // rather than relying on a client HUDDLE_JOIN that races the ring (the JOIN
  // handler does more async work than the RING gate, so the ring can lose) —
  // makes the invitee ring deterministic and seeds a non-empty roster so the
  // upgraded call never shows empty.
  const kind = call.kind === "video" ? "video" : "audio";
  const [meUser, otherUser] = await Promise.all([
    db.users.getById(uid),
    other ? db.users.getById(other) : Promise.resolve(null),
  ]);
  await huddleStore.huddleAdd(
    conv.id,
    uid,
    (meUser && meUser.name) || "Member",
    kind,
  );
  if (other)
    await huddleStore.huddleAdd(
      conv.id,
      other,
      (otherUser && otherUser.name) || "Member",
      kind,
    );
  if (io) {
    // Broadcast the fresh roster to every member's personal room (mirrors
    // broadcastHuddle in realtime/socket.ts, which targets userRoom not the conv
    // room, so no socket.join is needed here).
    const { participants } = await huddleStore.huddleGet(conv.id);
    const members = await db.conversations.members(conv.id);
    const statePayload = { conversationId: conv.id, kind, participants };
    for (const m of members)
      io.to(broadcast.userRoom(m.userId)).emit(
        EVENTS.HUDDLE_STATE,
        statePayload,
      );
  }
  if (io && other)
    io.to(broadcast.userRoom(other)).emit(EVENTS.CALL_UPGRADED, {
      callId: call.id,
      conversationId: conv.id,
      conversation: conv,
    });
  // AUDIT P1: transition the original 1:1 call to a terminal state so neither party
  // is left server-side "busy". requestAtomic/hasActiveCall only clear on a terminal
  // status; previously the row stayed 'connected' until an unrelated socket
  // disconnect, so after upgrading a 1:1 to a group BOTH users silently couldn't
  // place or receive new 1:1 calls for the rest of their session.
  try {
    await db.calls.setStatus(call.id, "ended");
  } catch (_) {}
  res.json(ok({ conversationId: conv.id, conversation: conv }));
});

export default router;
