import { db } from "../platform";

const MENTION_RE = /@(\w[\w.-]*)/g;

function extractMentions(body: string): string[] {
  if (!body) return [];
  const names: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = MENTION_RE.exec(body))) names.push(m[1]);
  return [...new Set(names)];
}

async function resolveUsersByName(names: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const n of names) {
    const user = await db.users.getByName(n);
    if (user) ids.push(user.id);
  }
  return ids;
}

// The frontend inserts a mention as "@" + the user's FIRST name with non-word
// chars stripped (ChatView.insertMention: name.split(" ")[0].replace(/\W/g,"")),
// rendered via /@([A-Za-z0-9_]+)/. So an `@`-token rarely equals a full name and
// db.users.getByName (exact full-name match) misses multi-word names. This
// resolver maps each extracted token to a REAL user id by matching the SAME
// first-name-stripped form against the supplied candidate users, falling back to
// an exact full-name lookup. Only resolves to users present in `candidates`
// (callers pass real members), so a mention can never notify a non-member or be
// injected. Returns DISTINCT user ids. Pure given `candidates` (no DB for the
// token match) — the getByName fallback only runs for an unmatched token.
async function resolveMentionedUserIds(
  body: string,
  candidates: Array<{ id: string; name?: string }>,
): Promise<string[]> {
  const tokens = extractMentions(body || "");
  if (!tokens.length) return [];
  const norm = (s: any) =>
    String(s || "")
      .split(" ")[0]
      .replace(/\W/g, "")
      .toLowerCase();
  const byFirst = new Map<string, string>(); // first-name-stripped → user id
  for (const u of candidates || []) {
    if (!u || !u.id) continue;
    const key = norm(u.name);
    // First writer wins for an ambiguous first name — deterministic, and the
    // frontend picker disambiguates at insert time anyway.
    if (key && !byFirst.has(key)) byFirst.set(key, u.id);
  }
  const out = new Set<string>();
  for (const tok of tokens) {
    const key = norm(tok);
    if (key && byFirst.has(key)) {
      out.add(byFirst.get(key)!);
      continue;
    }
    // Fallback: an exact full-name match (covers a single-word name typed in
    // full). Restricted to the CANDIDATE set — this used to hit the global user
    // directory, so "@Someone" who isn't in the conversation was notified (and
    // handed an excerpt of a thread they're not a member of).
    const u = await db.users.getByName(tok);
    if (u && (candidates || []).some((c) => c && c.id === u.id)) out.add(u.id);
  }
  return [...out];
}

async function create(params: {
  userId: string;
  type: string;
  title: string;
  body?: string;
  actorId?: string;
  targetType?: string;
  targetId?: string;
  conversationId?: string;
  // Optional idempotency key. When set, db.notifications.create makes a repeat
  // (same key for the same user) a no-op and returns null — the callers' existing
  // `if (n && io) pushNotif` guard then suppresses the live re-emit too. Un-keyed
  // notifications (the default) are never deduped, preserving legacy behaviour.
  dedupKey?: string;
}) {
  return db.notifications.create(params);
}

async function notifyMentions({
  body,
  senderId,
  senderName,
  conversationId,
  messageId,
  members,
  exclude,
}: {
  body: string;
  senderId: string;
  senderName: string;
  conversationId: string;
  messageId: string;
  members?: Array<{ userId?: string; id?: string; name?: string }>;
  // Users already notified through the exact-id path. They are skipped here so a
  // message mixing a picked mention with a hand-typed "@Name" notifies each
  // person once, instead of the caller having to choose one path or the other.
  exclude?: string[];
}) {
  const tokens = extractMentions(body);
  if (!tokens.length) return [];
  // AUDIT P1: the composer inserts "@" + FIRST name only, so the old exact
  // full-name match (resolveUsersByName) silently missed every "First Last" user —
  // i.e. essentially everyone. Resolve against the conversation members with the
  // SAME first-name convention (resolveMentionedUserIds). Names are fetched only
  // when a message actually contains an @token, so non-mention messages pay nothing.
  let userIds: string[];
  const mem = (members || []).filter((m) => m && (m.userId || m.id));
  if (mem.length) {
    const candidates = await Promise.all(
      mem.map(async (m) => {
        const id = (m.userId || m.id) as string;
        if (m.name) return { id, name: m.name };
        try {
          const u = await db.users.getById(id);
          return { id, name: u?.name };
        } catch {
          return { id };
        }
      }),
    );
    userIds = await resolveMentionedUserIds(body, candidates);
  } else {
    userIds = await resolveUsersByName(tokens); // legacy fallback (no members passed)
  }
  const skip = new Set(exclude || []);
  // Fan the per-recipient inserts out CONCURRENTLY instead of one serial await at
  // a time. The self/skip exclusion is applied first; Promise.all preserves input
  // order so the returned list is identical, and null results are still dropped.
  const targets = userIds.filter(
    (uid) => uid !== senderId && !skip.has(uid),
  );
  const created = await Promise.all(
    targets.map((uid) =>
      create({
        userId: uid,
        type: "mention",
        title: `${senderName} mentioned you`,
        body: body.length > 200 ? body.slice(0, 200) + "…" : body,
        actorId: senderId,
        targetType: "message",
        targetId: messageId,
        conversationId,
      }),
    ),
  );
  return created.filter(Boolean);
}

// Notify an EXPLICIT, pre-resolved set of mentioned users.
//
// The sender's composer already knows exactly who was picked (each mention
// carries that user's id), so the caller passes ids instead of a name to
// re-resolve. That matters twice over: it is the only mention path available for
// an end-to-end-encrypted message (the server has no readable body to scan), and
// it can't confuse two members who share a first name the way the name-based
// resolver does.
//
// `body` is OPTIONAL and must be omitted for an encrypted message so no
// plaintext excerpt is ever persisted. The CALLER is responsible for validating
// that every id is a real member of the conversation.
async function notifyMentionedIds({
  userIds,
  senderId,
  senderName,
  conversationId,
  messageId,
  body,
}: {
  userIds: string[];
  senderId: string;
  senderName: string;
  conversationId: string;
  messageId: string;
  body?: string;
}) {
  const notifications: any[] = [];
  for (const uid of [...new Set(userIds || [])]) {
    if (!uid || uid === senderId) continue;
    const n = await create({
      userId: uid,
      type: "mention",
      title: `${senderName} mentioned you`,
      body: body ? (body.length > 200 ? body.slice(0, 200) + "…" : body) : undefined,
      actorId: senderId,
      targetType: "message",
      targetId: messageId,
      conversationId,
    });
    if (n) notifications.push(n);
  }
  return notifications;
}

async function notifyReply({
  parentMessageSenderId,
  senderId,
  senderName,
  conversationId,
  messageId,
  body,
}: any) {
  if (parentMessageSenderId === senderId) return null;
  return create({
    userId: parentMessageSenderId,
    type: "reply",
    title: `${senderName} replied to your message`,
    body: body?.length > 200 ? body.slice(0, 200) + "…" : body,
    actorId: senderId,
    targetType: "message",
    targetId: messageId,
    conversationId,
  });
}

async function notifyCallMissed({
  userId,
  callerName,
  callId,
  conversationId,
}: any) {
  return create({
    userId,
    type: "call_missed",
    title: `Missed call from ${callerName}`,
    actorId: undefined,
    targetType: "call",
    targetId: callId,
    conversationId,
  });
}

async function notifyMeetingInvite({
  userId,
  hostName,
  meetingId,
  meetingTitle,
}: any) {
  return create({
    userId,
    type: "meeting_invite",
    title: `${hostName} invited you to "${meetingTitle}"`,
    targetType: "meeting",
    targetId: meetingId,
    // One invite notification per meeting per user — re-dispatch (schedule-time
    // loop + manual /:id/invite + DM-and-conversation overlap) no longer doubles.
    dedupKey: `minvite:${meetingId}:${userId}`,
  });
}

async function notifyFileShared({
  userId,
  sharerName,
  fileId,
  fileName,
  conversationId,
}: any) {
  return create({
    userId,
    type: "file_shared",
    title: `${sharerName} shared "${fileName}" with you`,
    targetType: "file",
    targetId: fileId,
    conversationId,
  });
}

async function notifyTaskAssigned({
  userId,
  assignerName,
  taskId,
  taskTitle,
}: any) {
  if (!userId) return null;
  return create({
    userId,
    type: "task_assigned",
    title: `${assignerName} assigned you a task: "${taskTitle}"`,
    targetType: "task",
    targetId: taskId,
  });
}

async function notifyTaskCompleted({
  userId,
  actorName,
  taskId,
  taskTitle,
}: any) {
  if (!userId) return null;
  return create({
    userId,
    type: "task_completed",
    title: `${actorName} completed "${taskTitle}"`,
    targetType: "task",
    targetId: taskId,
  });
}

// @mention inside a task description or comment. Deep-links to the task (the
// SAME targetType:"task" + targetId the client already routes for task_assigned/
// task_due), so the existing notification deep-link opens the exact task.
async function notifyTaskMention({
  userId,
  mentionerName,
  taskId,
  taskTitle,
}: any) {
  if (!userId) return null;
  return create({
    userId,
    type: "task_mention",
    title: `${mentionerName} mentioned you in a task`,
    body: taskTitle || undefined,
    targetType: "task",
    targetId: taskId,
  });
}

// Generic "the task changed" notification for WATCHERS (status change / new
// comment). Reuses the task deep-link so a click opens the exact task. `kind`
// shapes the title; falls back to a neutral "updated".
async function notifyTaskWatched({
  userId,
  actorName,
  taskId,
  taskTitle,
  kind,
  detail,
}: any) {
  if (!userId) return null;
  const title =
    kind === "status"
      ? `${actorName} moved "${taskTitle}"${detail ? " to " + detail : ""}`
      : kind === "comment"
        ? `${actorName} commented on "${taskTitle}"`
        : `${actorName} updated "${taskTitle}"`;
  return create({
    userId,
    type: "task_watch",
    title,
    targetType: "task",
    targetId: taskId,
  });
}

async function notifyReaction({
  userId,
  reactorName,
  messageId,
  emoji,
  conversationId,
}: any) {
  if (!userId) return null;
  return create({
    userId,
    type: "reaction",
    title: `${reactorName} reacted ${emoji} to your message`,
    targetType: "message",
    targetId: messageId,
    conversationId,
  });
}

async function notifyMeetingCancelled({
  userId,
  hostName,
  meetingId,
  meetingTitle,
  note,
}: any) {
  return create({
    userId,
    type: "meeting_cancelled",
    title: note ? `${hostName} cancelled "${meetingTitle}": ${note}` : `${hostName} cancelled "${meetingTitle}"`,
    targetType: "meeting",
    targetId: meetingId,
  });
}

// "Ends in N minutes" — the wrap-up nudge, sent to people IN the meeting.
// Deduped per (meeting, occurrence, lead, user) so a retried tick or a second
// app instance can never double-notify the same person for the same warning.
async function notifyMeetingEnding({
  userId,
  meetingId,
  meetingTitle,
  minutesLeft,
  occurrenceStart,
}: any) {
  return create({
    userId,
    type: "meeting_ending",
    title: `"${meetingTitle}" ends in ${minutesLeft} minutes`,
    actorId: undefined,
    targetType: "meeting",
    targetId: meetingId,
    dedupKey: `mend:${meetingId}:${occurrenceStart}:${minutesLeft}:${userId}`,
  });
}

async function notifyMeetingStarted({
  userId,
  hostName,
  meetingId,
  meetingTitle,
}: any) {
  return create({
    userId,
    type: "meeting_started",
    title: `"${meetingTitle}" has started`,
    actorId: undefined,
    targetType: "meeting",
    targetId: meetingId,
    // "has started" fires on room.count===1 (first entrant), which recurs every
    // time the room empties + someone re-enters (a 2-person meeting where one
    // drops + rejoins) → the duplicate "started" rows. Key on a DAY bucket so
    // re-entry within the day is a no-op, while a genuine next-day occurrence of
    // a recurring meeting still announces once.
    dedupKey: `mstart:${meetingId}:${userId}:${Math.floor(Date.now() / 86400000)}`,
  });
}

async function notifyMeetingUpdated({
  userId,
  hostName,
  meetingId,
  meetingTitle,
}: any) {
  return create({
    userId,
    type: "meeting_updated",
    title: `${hostName} updated "${meetingTitle}"`,
    targetType: "meeting",
    targetId: meetingId,
    // Collapse a burst of rapid edits (PATCH per keystroke/save) into one row per
    // 5-minute window; a genuinely later edit still notifies.
    dedupKey: `mupdate:${meetingId}:${userId}:${Math.floor(Date.now() / 300000)}`,
  });
}

async function notifyMeetingReminder({
  userId,
  meetingId,
  meetingTitle,
  minutesBefore,
}: any) {
  return create({
    userId,
    type: "meeting_reminder",
    title: `"${meetingTitle}" starts in ${minutesBefore} minute${minutesBefore === 1 ? "" : "s"}`,
    targetType: "meeting",
    targetId: meetingId,
  });
}

async function listForUser(userId: string, opts?: { limit?: number; beforeId?: string }) {
  return db.notifications.listForUser(userId, opts);
}

async function unreadCount(userId: string) {
  return db.notifications.unreadCount(userId);
}

async function markRead(userId: string, notificationId: string) {
  return db.notifications.markRead(userId, notificationId);
}

async function markAllRead(userId: string) {
  return db.notifications.markAllRead(userId);
}

async function remove(userId: string, notificationId: string) {
  return db.notifications.remove(userId, notificationId);
}

async function notifyChannel({
  conversationId,
  senderId,
  senderName,
  messageId,
  memberIds,
}: {
  conversationId: string;
  senderId: string;
  senderName: string;
  messageId: string;
  memberIds: string[];
}) {
  const notifications: any[] = [];
  for (const uid of memberIds) {
    if (uid === senderId) continue;
    const n = await create({
      userId: uid,
      type: "mention",
      title: `${senderName} mentioned @channel`,
      actorId: senderId,
      targetType: "message",
      targetId: messageId,
      conversationId,
    });
    if (n) notifications.push(n);
  }
  return notifications;
}

// Org membership activity — surfaced in the affected member's Activity feed.
async function notifyOrgRoleChanged({ userId, actorName, orgName, roleName, orgId }: any) {
  if (!userId) return null;
  return create({
    userId,
    type: "org_role",
    title: `Your role in ${orgName} is now ${roleName}`,
    body: actorName ? `Updated by ${actorName}.` : undefined,
    targetType: "org",
    targetId: orgId,
  });
}
async function notifyOrgMemberAdded({ userId, actorName, orgName, roleName, orgId }: any) {
  if (!userId) return null;
  return create({
    userId,
    type: "org_member",
    title: `You were added to ${orgName}`,
    body: `Role: ${roleName}.${actorName ? ` Added by ${actorName}.` : ""}`,
    targetType: "org",
    targetId: orgId,
  });
}
// Enterprise onboarding — a user asked to join an org (→ its owners/admins).
async function notifyJoinRequestReceived({ userId, requesterName, orgName, orgId }: any) {
  if (!userId) return null;
  return create({
    userId,
    type: "org_join_request",
    title: `${requesterName || "Someone"} requested to join ${orgName}`,
    body: "Review it in Organization settings → Join requests.",
    targetType: "org",
    targetId: orgId,
  });
}
// …and the outcome (→ the requester). `reason` is the admin's optional
// free-text explanation (BA #1) — echoed verbatim so the user knows why.
async function notifyJoinRequestDecided({ userId, approved, orgName, orgId, actorName, reason }: any) {
  if (!userId) return null;
  return create({
    userId,
    type: approved ? "org_join_approved" : "org_join_rejected",
    title: approved ? `You've joined ${orgName}` : `Your request to join ${orgName} wasn't approved`,
    body: approved
      ? `Welcome aboard!${actorName ? ` Approved by ${actorName}.` : ""}`
      : `${actorName ? `Reviewed by ${actorName}. ` : ""}${reason ? `Reason: ${reason}` : "You can request again or contact an administrator."}`,
    targetType: "org",
    targetId: orgId,
  });
}
// A member was removed from the org (→ the removed user). Optional reason (BA #1).
async function notifyOrgMemberRemoved({ userId, actorName, orgName, orgId, reason }: any) {
  if (!userId) return null;
  return create({
    userId,
    type: "org_member_removed",
    title: `You were removed from ${orgName}`,
    body: `${actorName ? `Removed by ${actorName}. ` : ""}${reason ? `Reason: ${reason}` : ""}`.trim() || undefined,
    targetType: "org",
    targetId: orgId,
  });
}
// A member LEFT the org on their own (→ each remaining owner/admin). Informational,
// so administrators know the roster changed; routes to Activity (type starts "org").
async function notifyOrgMemberLeft({ userId, memberName, orgName, orgId }: any) {
  if (!userId) return null;
  return create({
    userId,
    type: "org_member_left",
    title: `${memberName || "A member"} left ${orgName}`,
    targetType: "org",
    targetId: orgId,
  });
}
// Org-wide broadcast (BA #6) — owners/admins → every member.
async function notifyOrgBroadcast({ userId, actorName, orgName, orgId, title, body }: any) {
  if (!userId) return null;
  return create({
    userId,
    type: "org_broadcast",
    title: `📢 ${orgName}: ${title}`,
    body: `${body ? `${String(body).slice(0, 300)} ` : ""}${actorName ? `— ${actorName}` : ""}`.trim() || undefined,
    targetType: "org",
    targetId: orgId,
  });
}

// Report a concern (Settings) — the reporter's submission pings the org's
// managers; the handler's response pings the reporter back.
async function notifyConcernReported({ userId, reporterName, category, orgId }: any) {
  if (!userId) return null;
  return create({
    userId,
    type: "org_concern",
    title: `A concern was reported${reporterName ? ` by ${reporterName}` : ""}`,
    body: `Category: ${category}. Review it in Organization → Concerns.`,
    targetType: "org",
    targetId: orgId || null,
  });
}
async function notifyConcernHandled({ userId, status, response }: any) {
  if (!userId) return null;
  return create({
    userId,
    type: "concern_update",
    title: status === "closed" ? "Your concern was resolved" : "Your concern is being reviewed",
    body: response ? String(response).slice(0, 300) : undefined,
    targetType: null,
    targetId: null,
  });
}

export {
  extractMentions,
  resolveMentionedUserIds,
  create,
  notifyOrgRoleChanged,
  notifyJoinRequestReceived,
  notifyJoinRequestDecided,
  notifyOrgMemberAdded,
  notifyOrgMemberRemoved,
  notifyOrgMemberLeft,
  notifyOrgBroadcast,
  notifyConcernReported,
  notifyConcernHandled,
  notifyMentions,
  notifyMentionedIds,
  notifyChannel,
  notifyReply,
  notifyCallMissed,
  notifyMeetingInvite,
  notifyFileShared,
  notifyTaskAssigned,
  notifyTaskCompleted,
  notifyTaskMention,
  notifyTaskWatched,
  notifyMeetingCancelled,
  notifyMeetingStarted,
  notifyMeetingEnding,
  notifyMeetingUpdated,
  notifyMeetingReminder,
  notifyReaction,
  listForUser,
  unreadCount,
  markRead,
  markAllRead,
  remove,
};
