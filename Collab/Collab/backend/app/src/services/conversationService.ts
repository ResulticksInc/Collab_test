import { db, shared } from "../platform";
import { createHash } from "crypto";
import {
  serializeConversation,
  serializeConversationList,
  serializeMemberList,
  extractLinks,
  hhmm,
} from "../serialize";
import { send } from "./messageService";

// Cross-session dedup key for a temp group. Same-PARTICIPANTS calls, and
// same-NAME meetings, resolve to ONE key → ONE temp group (each session is
// appended), instead of a fresh group per call/meeting. Normalized so member
// ORDER/CASE and name case/whitespace can never mint a "duplicate" of the same
// set/name. Hashed to a fixed 43 chars so it fits dm_key's budget without the
// truncation-collision risk a raw member list would carry.
function tempGroupDedupKey(
  title: string | null | undefined,
  memberIds: string[],
): string {
  const isMeeting = !!(title && String(title).trim());
  const raw = isMeeting
    ? "m:" + String(title).trim().toLowerCase()
    : "p:" +
      Array.from(
        new Set(
          (memberIds || [])
            .map((x) => String(x || "").trim().toLowerCase())
            .filter(Boolean),
        ),
      )
        .sort()
        .join(",");
  return "tg|" + createHash("sha1").update(raw).digest("hex").slice(0, 40);
}

// Post a centered "system" timeline line into a group/channel (membership
// events, creation) — rendered as a neutral pill on the client, the same family
// as call logs. Best-effort: a logging failure must never block the membership
// operation. Returns the serialized message (or null) so the route can
// broadcast MESSAGE_NEW for live append.
async function postSystemMessage(conversationId, senderId, text) {
  try {
    return await send({ conversationId, senderId, text, file: null, type: "system" });
  } catch (_) {
    return null;
  }
}
const isGroupKind = (kind) =>
  kind === shared.CONVERSATION.GROUP || kind === shared.CONVERSATION.CHANNEL;
const nameOf = async (id) => {
  const u = await db.users.getById(id);
  return (u && u.name) || "Someone";
};
// Viewer-independent group name built from ALL participants' full names:
// "Alice Kim + Bob Lee", "Alice Kim + Bob Lee + Carol Ng", and
// "Alice Kim + Bob Lee + Carol Ng + 2 more" beyond three. Used to auto-name
// call groups so the label shows everyone who was on the call and reads the
// same for every member (unlike a single baked peer name). Full names — not
// first-name-only — so distinct people who share a first name stay distinct.
const buildParticipantName = async (ids: string[]) => {
  const uniq = Array.from(new Set((ids || []).filter(Boolean)));
  const names: string[] = [];
  for (const id of uniq.slice(0, 3)) {
    const u = await db.users.getById(id);
    if (u && u.name) names.push(u.name);
  }
  let label = names.join(" + ");
  if (uniq.length > 3) label += ` + ${uniq.length - 3} more`;
  return label || "Group call";
};

async function listForUser(userId) {
  let rows = await db.conversations.listForUser(userId);
  // P1.5: every user has a Personal Space ("self" conversation) for notes,
  // saved messages and drafts. Provision it once, idempotently, the first time
  // the user loads their conversations.
  if (!rows.some((c) => c.kind === shared.CONVERSATION.SELF)) {
    await create({
      kind: shared.CONVERSATION.SELF,
      title: "You",
      icon: null,
      creatorId: userId,
    });
    rows = await db.conversations.listForUser(userId);
  }
  // Return ALL conversations (including archived/hidden) WITH the `hidden` flag,
  // so the client can show them under the Archive view and restore them. The
  // client filters `!hidden` for active lists. (Previously hidden rows were
  // dropped here, so archived chats disappeared on reload and Archive was empty.)
  // Batched: ONE users query for every DM peer / unread sender / untitled-group
  // member across the whole sidebar, instead of one read per row (boot hydration).
  const out = await serializeConversationList(rows, userId);
  return out.sort((a, b) =>
    a.kind === "self"
      ? -1
      : b.kind === "self"
        ? 1
        : (b.time || "").localeCompare(a.time || ""),
  );
}
// Deterministic key for a DM between two users — sorted ids so it's identical
// regardless of who initiates. Backs the unique index that makes duplicate DMs
// impossible at the database level.
function dmKeyFor(a, b) {
  return [a, b].sort().join("|");
}

async function returnExistingDm(conversationId, creatorId) {
  try {
    await db.conversations.setMemberFlag(conversationId, creatorId, "hidden", false);
  } catch (_) { /* best-effort un-hide */ }
  // Ensure the creator is actually a member (covers a DM created by the peer).
  try { await db.conversations.addMember(conversationId, creatorId, { role: "member" }); } catch (_) {}
  const conv = await db.conversations.getById(conversationId);
  return {
    conversation: await serializeConversation(conv, creatorId),
    memberIds: (conv && conv.members) || [],
    systemMessage: null,
  };
}

async function create({ kind, title, icon, avatarUrl, memberIds = [], creatorId, temporary = false, expiresAt = null, sessionKey = null, pending = false }: any) {
  const memberList: string[] = (
    Array.isArray(memberIds)
      ? memberIds
      : typeof memberIds === "string"
      ? memberIds.trim().startsWith("[")
        ? (() => { try { const p = JSON.parse(memberIds); return Array.isArray(p) ? p : []; } catch { return []; } })()
        : memberIds.split(",")
      : []
  ).map((x: any) => String(x || "").trim()).filter(Boolean);

  // One DM per user pair, enforced by a unique dm_key index (race-proof).
  let dmKey: string | null = null;
  if (kind === shared.CONVERSATION.DM) {
    const peers = Array.from(
      new Set(memberList.filter((id) => id && id !== creatorId)),
    );
    if (peers.length === 1) {
      const peerId = peers[0];
      dmKey = dmKeyFor(creatorId, peerId);
      // Canonical lookup by key (covers DMs created by either party).
      const existingId =
        (db.conversations.findByDmKey && (await db.conversations.findByDmKey(dmKey))) ||
        (await db.conversations.findDmBetween(creatorId, peerId));
      if (existingId) return returnExistingDm(existingId, creatorId);
    }
  } else if (isGroupKind(kind) && sessionKey) {
    // Call-session dedup: EVERY participant's client preserves the same ended
    // call's chat at hangup (see /temp-from-session), so a shared per-session
    // key rides the same unique dm_key index and the N near-simultaneous POSTs
    // collapse to ONE temp group. `existing: true` tells the caller another
    // participant already created it (skip porting — same transcript).
    dmKey = ("call|" + String(sessionKey)).slice(0, 80);
    const existingId =
      db.conversations.findByDmKey && (await db.conversations.findByDmKey(dmKey));
    if (existingId)
      return { ...(await returnExistingDm(existingId, creatorId)), existing: true };
  }
  let conv;
  try {
    conv = await db.conversations.create({
      kind,
      title: title || null,
      icon: icon || (kind === shared.CONVERSATION.CHANNEL ? "#" : "💬"),
      createdBy: creatorId,
      dmKey,
      // BA/CEO: auto-expiring temp group (from a call/meeting chat after it ends).
      temporary: !!temporary,
      expiresAt: expiresAt || null,
      // Teams-model: a DM minted at Connect time before the recipient accepts.
      pendingConnection: !!pending,
    });
  } catch (e: any) {
    // Lost a create race — the unique dm_key index rejected the second insert.
    // Resolve to the winner instead of erroring. (`existing` matters only to
    // the call-session dedup path; inert for DMs.)
    if (dmKey && db.conversations.findByDmKey) {
      const winnerId = await db.conversations.findByDmKey(dmKey);
      if (winnerId)
        return { ...(await returnExistingDm(winnerId, creatorId)), existing: true };
    }
    throw e;
  }
  if (avatarUrl && db.conversations.update) {
    try {
      await db.conversations.update(conv.id, { avatarUrl });
    } catch (e: any) {
      console.warn("[conversationService] failed to save avatarUrl", e && (e.message || e));
    }
  }
  const all = Array.from(new Set([creatorId, ...memberList]));
  for (const uid of all)
    await db.conversations.addMember(conv.id, uid, {
      role: uid === creatorId ? "owner" : "member",
    });
  // Teams-model pending DM (Message-request): both parties are normal members. The
  // recipient SEES the pending DM + the sender's message as a request and Accept/
  // Declines from it (gating is per-viewer in the client + the send guard), so
  // nothing is hidden here.
  // Opening system line for a new group/channel ("X created the group"). Skip
  // DMs and the SELF space so those stay clean. Also skip TEMPORARY groups: those
  // are auto-created from a call/meeting's in-session chat (createTemporaryGroup),
  // so nobody "created" a group — the centered system line just interleaved with
  // the real transcript as a stray middle-aligned message.
  let systemMessage: any = null;
  if (isGroupKind(kind) && !temporary)
    systemMessage = await postSystemMessage(
      conv.id,
      creatorId,
      `${await nameOf(creatorId)} created the ${kind}`,
    );
  const full = await db.conversations.listForUser(creatorId);
  const row = full.find((c) => c.id === conv.id);
  return {
    conversation: await serializeConversation(row, creatorId),
    memberIds: all,
    systemMessage,
  };
}
async function assertMember(conversationId, userId) {
  if (!(await db.conversations.isMember(conversationId, userId))) {
    const e: any = new Error("You are not a member of this conversation");
    e.status = 403;
    e.code = "FORBIDDEN";
    throw e;
  }
}
// Role helpers for group/channel admin gating. DMs and "self" do not use roles.
async function getMyRole(conversationId, userId) {
  const members = await db.conversations.members(conversationId);
  const me = members.find((m) => m.userId === userId);
  return me ? (me.role || "member") : null;
}
async function assertAdmin(conversationId, userId) {
  const r = await getMyRole(conversationId, userId);
  if (r !== "owner" && r !== "admin") {
    const e: any = new Error("Only group admins can do that");
    e.status = 403;
    e.code = "FORBIDDEN_ROLE";
    throw e;
  }
}
// Change a member's role. Admins may flip member<->admin; only the owner may
// transfer ownership (which demotes the previous owner to admin). The owner
// cannot be demoted without an explicit transfer.
async function setMemberRole({ conversationId, requesterId, targetUserId, role }) {
  if (!["owner", "admin", "member"].includes(role)) {
    const e: any = new Error("Invalid role");
    e.status = 400;
    e.code = "BAD_ROLE";
    throw e;
  }
  const myRole = await getMyRole(conversationId, requesterId);
  if (myRole !== "owner" && !(myRole === "admin" && role !== "owner")) {
    const e: any = new Error("Only the owner can change admin/owner roles");
    e.status = 403;
    e.code = "FORBIDDEN_ROLE";
    throw e;
  }
  const targetRole = await getMyRole(conversationId, targetUserId);
  if (!targetRole) {
    const e: any = new Error("Not a member");
    e.status = 404;
    throw e;
  }
  if (targetRole === "owner" && role !== "owner") {
    const e: any = new Error("Transfer ownership instead of demoting the owner");
    e.status = 400;
    throw e;
  }
  if (role === "owner") {
    // Ownership transfer: requester (owner) steps down to admin.
    await db.conversations.setMemberRole(conversationId, requesterId, "admin");
  }
  await db.conversations.setMemberRole(conversationId, targetUserId, role);
  return { conversationId, userId: targetUserId, role };
}
// Remove a member (admin kick) or leave (self). The owner must transfer
// ownership before leaving so the group is never left ownerless.
async function removeMember({ conversationId, requesterId, targetUserId }) {
  const conv = await db.conversations.getById(conversationId);
  if (!conv || conv.kind === "dm" || conv.kind === "self") return { removed: false };
  if (requesterId !== targetUserId) {
    await assertAdmin(conversationId, requesterId);
    const targetRole = await getMyRole(conversationId, targetUserId);
    if (targetRole === "owner") {
      const e: any = new Error("Cannot remove the owner");
      e.status = 403;
      throw e;
    }
    const myRole = await getMyRole(conversationId, requesterId);
    if (targetRole === "admin" && myRole !== "owner") {
      const e: any = new Error("Only the owner can remove an admin");
      e.status = 403;
      throw e;
    }
  } else {
    const myRole = await getMyRole(conversationId, requesterId);
    if (myRole === "owner") {
      const e: any = new Error("Transfer ownership before leaving the group");
      e.status = 400;
      e.code = "OWNER_MUST_TRANSFER";
      throw e;
    }
  }
  // Post the membership line BEFORE removal so the actor (and, for a self-leave,
  // the leaver) is still a member and send()'s membership gate passes.
  let message: any = null;
  if (isGroupKind(conv.kind)) {
    const actorName = await nameOf(requesterId);
    message =
      requesterId === targetUserId
        ? await postSystemMessage(conversationId, requesterId, `${actorName} left`)
        : await postSystemMessage(
            conversationId,
            requesterId,
            `${actorName} removed ${await nameOf(targetUserId)}`,
          );
  }
  await db.conversations.removeMember(conversationId, targetUserId);
  return { removed: true, conversationId, userId: targetUserId, message };
}

async function addMembers(conversationId, userIds, requesterId?, shareHistory = true) {
  if (requesterId) await assertMember(conversationId, requesterId);
  // Fetch the conversation ONCE, up-front, and enforce both gates BEFORE any
  // membership row is inserted — a later reject used to leave orphan rows (a DM
  // member could persist arbitrary members despite the 400).
  const conv = await db.conversations.getById(conversationId);
  // WhatsApp behavior: adding people to a DM must NOT convert it. The frontend
  // creates a new group instead. If the API is called directly on a DM, reject.
  if (conv && conv.kind === shared.CONVERSATION.DM) {
    const e: any = new Error("Cannot add members to a direct message. Create a group instead.");
    e.status = 400;
    e.code = "DM_ADD_DENIED";
    throw e;
  }
  // Only owners/admins can invite to an existing group/channel.
  if (
    requesterId &&
    conv &&
    (conv.kind === shared.CONVERSATION.GROUP || conv.kind === shared.CONVERSATION.CHANNEL)
  ) {
    await assertAdmin(conversationId, requesterId);
  }
  const existing = await db.conversations.members(conversationId);
  const existingIds = new Set(existing.map((m) => m.userId));
  const toAdd: string[] = [];
  const already: string[] = [];
  for (const uid of userIds) {
    if (existingIds.has(uid)) already.push(uid);
    else toAdd.push(uid);
  }
  for (const uid of toAdd) {
    await db.conversations.addMember(conversationId, uid);
    // #16: if the inviter chose NOT to share prior messages, stamp the join
    // moment as this member's history cutoff (before posting the "added"
    // system line below, so they still see that they were added + everything
    // after). Default (shareHistory=true) leaves the cutoff NULL = full view.
    if (!shareHistory)
      await db.conversations.setMemberHistoryCutoff(conversationId, uid);
  }
  const alreadyNames: string[] = [];
  for (const uid of already) {
    const u = await db.users.getById(uid);
    alreadyNames.push((u && u.name) || "That person");
  }
  // System line: "Alice added Bob, Carol" (group/channel only, real adds only).
  let systemMessage: any = null;
  if (requesterId && toAdd.length && conv && isGroupKind(conv.kind)) {
    const names: string[] = [];
    for (const uid of toAdd) names.push(await nameOf(uid));
    systemMessage = await postSystemMessage(
      conversationId,
      requesterId,
      `${await nameOf(requesterId)} added ${names.join(", ")}`,
    );
  }
  return {
    members: await members(conversationId),
    added: toAdd.length,
    addedIds: toAdd, // the ids actually inserted (excludes already-members)
    already: alreadyNames,
    systemMessage,
  };
}
async function setStar(conversationId, userId, value) {
  await db.conversations.setMemberFlag(
    conversationId,
    userId,
    "starred",
    value,
  );
  return { conversationId, starred: value };
}
async function setMute(conversationId, userId, value) {
  await db.conversations.setMemberFlag(conversationId, userId, "muted", value);
  return { conversationId, muted: value };
}
async function setHidden(conversationId, userId, value) {
  await db.conversations.setMemberFlag(conversationId, userId, "hidden", value);
  return { conversationId, hidden: value };
}
// Per-user "Clear chat" (WhatsApp-style): hide every existing message from THIS
// member's view by stamping their history cutoff to now — the conversation stays
// in their list as a fresh EMPTY chat (not archived), and other participants keep
// their full history. Also zero their unread so the cleared chat carries no badge.
async function clearHistory(conversationId, userId) {
  await assertMember(conversationId, userId);
  await db.conversations.setMemberHistoryCutoff(conversationId, userId);
  await db.conversations.setMemberFlag(conversationId, userId, "unread", 0);
  return { conversationId, cleared: true };
}
async function setRead(conversationId, userId, read) {
  await db.conversations.setMemberFlag(
    conversationId,
    userId,
    "unread",
    read ? 0 : 1,
  );
  return { conversationId, unread: read ? 0 : 1 };
}
async function markRead(conversationId, userId) {
  const r = await db.conversations.markRead(conversationId, userId);
  return { conversationId, userId, lastReadAt: r.lastReadAt, unread: 0 };
}
async function getReceipts(conversationId, userId) {
  if (!(await db.conversations.isMember(conversationId, userId))) return [];
  return db.conversations.readReceipts(conversationId);
}
async function memberIdsOf(conversationId) {
  const m = await db.conversations.members(conversationId);
  return m.map((x) => x.userId);
}
async function update(conversationId, userId, patch) {
  const conv = await db.conversations.getById(conversationId);
  if (!conv) return null;
  const members = await db.conversations.members(conversationId);
  const me = members.find((m) => m.userId === userId);
  if (!me || (me.role !== "owner" && me.role !== "admin"))
    return null;
  await db.conversations.update(conversationId, patch);
  return db.conversations.getById(conversationId);
}

// Temp-group lifecycle actions. Gated on MEMBERSHIP (not owner/admin): both are
// non-destructive to history — converting only KEEPS the data, and any
// participant of the shared collab space may promote it or adjust its window.
async function convertTempToPermanent(conversationId, userId) {
  if (!(await db.conversations.isMember(conversationId, userId))) return null;
  const c = await db.conversations.getById(conversationId);
  if (!c) return null;
  await (db.conversations as any).convertToPermanent(conversationId);
  // Announce the promotion in-thread so all participants see it's now permanent.
  try {
    const actor = await db.users.getById(userId).catch(() => null);
    await postSystemMessage(
      conversationId,
      userId,
      `${(actor && actor.name) || "Someone"} made this a permanent group`,
    );
  } catch (_) {}
  return db.conversations.getById(conversationId);
}

async function setTempRetention(conversationId, userId, days) {
  if (!(await db.conversations.isMember(conversationId, userId))) return null;
  const c = await db.conversations.getById(conversationId);
  if (!c || !c.temporary) return null;
  await (db.conversations as any).setTempRetention(conversationId, days);
  return db.conversations.getById(conversationId);
}

async function remove(conversationId, userId) {
  const ids = await memberIdsOf(conversationId);
  if (!ids.includes(userId)) return { id: conversationId, deleted: false };
  // Only the OWNER can hard-delete a group/channel — otherwise any member could
  // wipe everyone else's history. DM/self preserved (existing "delete for me"
  // semantics for those conversation kinds stay intact via this same route).
  const conv = await db.conversations.getById(conversationId);
  if (conv && (conv.kind === shared.CONVERSATION.GROUP || conv.kind === shared.CONVERSATION.CHANNEL)) {
    const role = await getMyRole(conversationId, userId);
    if (role !== "owner") {
      const e: any = new Error("Only the owner can delete this group");
      e.status = 403;
      e.code = "FORBIDDEN_OWNER";
      throw e;
    }
  }
  await db.conversations.remove(conversationId);
  return { id: conversationId, deleted: true, memberIds: ids };
}
async function members(conversationId, requesterId?) {
  if (requesterId) await assertMember(conversationId, requesterId);
  const m = await db.conversations.members(conversationId);
  // Batched: one getByIds for the whole roster instead of a getById per member.
  return serializeMemberList(m);
}
async function files(conversationId, requesterId?) {
  if (requesterId) await assertMember(conversationId, requesterId);
  const msgs = await db.messages.listForConversation(conversationId, {
    limit: 200,
  });
  // Resolve every file-sender in ONE batched read instead of a getById per file
  // message (the old N+1 fired up to 200 serial user queries per page). Output
  // rows, order and the `by` → "Member" fallback are unchanged; a map MISS still
  // falls back to getById so a missing sender behaves exactly as before.
  const fileMsgs = msgs.filter((m) => m.file);
  const senderIds = [
    ...new Set(fileMsgs.map((m) => m.senderId).filter(Boolean)),
  ];
  const byId = new Map<string, any>();
  if (senderIds.length && (db.users as any).getByIds) {
    for (const u of (await (db.users as any).getByIds(senderIds)) || [])
      if (u && u.id) byId.set(u.id, u);
  }
  const out = [];
  for (const m of fileMsgs) {
    const u = byId.has(m.senderId)
      ? byId.get(m.senderId)
      : await db.users.getById(m.senderId);
    out.push({
      ...m.file,
      messageId: m.id,
      by: u ? u.name : "Member",
      // Raw ISO so the client formats in the viewer's local timezone; `time`
      // (server-tz) kept only as a legacy fallback.
      createdAt: m.createdAt,
      time: hhmm(m.createdAt),
    });
  }
  return out;
}
async function links(conversationId, requesterId?) {
  if (requesterId) await assertMember(conversationId, requesterId);
  const msgs = await db.messages.listForConversation(conversationId, {
    limit: 200,
  });
  return extractLinks(msgs);
}
const TEMP_GROUP_TTL_DAYS = 7;

// BA/CEO: preserve a call/meeting's in-session chat as an AUTO-EXPIRING group so
// participants can still find it after the session ends. Creates a temporary
// group (soft-deleted by the daily GC after TEMP_GROUP_TTL_DAYS days), ports the
// messages in chronological order, and posts a notice about the auto-deletion.
async function createTemporaryGroup({
  title,
  icon,
  memberIds = [],
  creatorId,
  messages = [],
  sessionKey = null,
  // Duplicate-prompt plumbing (spec B/E): "check" = report a matching group
  // without creating; "new" = force a fresh group; "auto" (default) = dedup.
  mode = "auto",
  // Recurring-meeting series (spec F): every occurrence keys into ONE group.
  seriesKey = null,
  // End-of-session capture: append into the group chosen live, no re-dedup.
  targetGroupId = null,
  // Raw per-session id used to place exactly one session divider (spec D).
  sessionMarker = null,
}: any) {
  const expiresAt = new Date(
    Date.now() + TEMP_GROUP_TTL_DAYS * 24 * 60 * 60 * 1000,
  );
  // No explicit title → auto-name from ALL participants ("A + B", "A + B + C",
  // "A + B + C + N more"), baked once so it's identical for every member. Calls
  // pass null (this builds the participant name); meetings pass their own name.
  const finalTitle =
    title || (await buildParticipantName([creatorId, ...memberIds]));
  // Dedup base — a recurring meeting SERIES funnels every occurrence into ONE
  // group (key by the stable series id, spec F); otherwise meeting NAME / call
  // PARTICIPANT SET (tempGroupDedupKey). The client's per-session sessionKey is
  // never the dedup key (that's what makes back-to-back sessions reuse one
  // group) — except in the "new" branch, which deliberately forks a fresh one.
  const dedupBase = seriesKey
    ? "tg|" +
      createHash("sha1")
        .update("s:" + String(seriesKey).trim().toLowerCase())
        .digest("hex")
        .slice(0, 40)
    : tempGroupDedupKey(title, [creatorId, ...memberIds]);
  // mode "check": report whether a matching temp group already exists WITHOUT
  // creating one — the client shows the "Continue vs Create new" prompt off this.
  if (mode === "check") {
    const dmKey = ("call|" + dedupBase).slice(0, 80);
    const existingId =
      db.conversations.findByDmKey && (await db.conversations.findByDmKey(dmKey));
    if (!existingId) return { existingMatch: null } as any;
    const ec = await db.conversations.getById(existingId);
    return {
      existingMatch: { id: existingId, title: (ec && ec.title) || finalTitle },
    } as any;
  }
  let conversation: any;
  let existing = false;
  if (targetGroupId) {
    // End-of-session capture honoring the destination chosen LIVE: append into
    // the already-created group and NEVER re-dedup — otherwise a "Create new"
    // session would leak back into the historical group at hangup.
    if (!(await db.conversations.isMember(targetGroupId, creatorId)))
      return null as any;
    conversation = await db.conversations.getById(targetGroupId);
    if (!conversation) return null as any;
    existing = true;
  } else {
    // "new" → a genuinely fresh group keyed by the per-session id (this session's
    // participants still collapse to one, but it never matches history);
    // "auto" → dedup into the participant-set / name / series group.
    const effectiveKey =
      mode === "new"
        ? ("new:" + String(sessionKey || dedupBase)).slice(0, 75)
        : dedupBase;
    const created = (await create({
      kind: shared.CONVERSATION.GROUP,
      title: finalTitle,
      icon: icon || "💬",
      memberIds,
      creatorId,
      temporary: true,
      expiresAt,
      sessionKey: effectiveKey,
    })) as any;
    conversation = created.conversation;
    existing = created.existing;
  }
  // D: session divider — exactly one per distinct session, deduped by the raw
  // per-session marker so N participant POSTs don't each add one and a later
  // session gets its own. Posted at the session's FIRST touch of the group (the
  // live creation, which the attachment/recording paths await) so it sits BEFORE
  // this session's content, not after it. Cosmetic → never blocks the port.
  if (sessionMarker) {
    try {
      const marker = "§sd:" + String(sessionMarker) + "§";
      const pre = await db.messages.listForConversation(conversation.id, {
        limit: 500,
      });
      if (!(pre || []).some((r: any) => String(r.body || "").includes(marker))) {
        const when = new Date().toLocaleDateString("en-GB", {
          day: "numeric",
          month: "short",
          year: "numeric",
        });
        const label = (title ? "Meeting" : "Call") + " · " + when;
        await send({
          conversationId: conversation.id,
          senderId: creatorId,
          text: marker + label,
          file: null,
          type: "session_divider",
          bumpUnread: false,
        });
      }
    } catch (_) {
      /* divider is cosmetic */
    }
  }
  // Another participant of the SAME call session already preserved this chat —
  // reuse their group instead of creating a duplicate. Participants leave at
  // different moments, so each client's capture is a different WINDOW of the
  // same chat (late joiners miss the start, early leavers miss the tail):
  // append only the lines the group doesn't already hold — union coverage
  // without duplicating shared lines. `deduped` tells the route to skip
  // re-broadcasting CONVERSATION_NEW (the creator's POST already announced it).
  if (existing) {
    try {
      const keyOf = (text: any, file: any) => {
        let fname = "";
        try {
          const f = typeof file === "string" ? JSON.parse(file) : file;
          fname = (f && f.name) || "";
        } catch (_) {}
        return `${String(text || "").trim()}${fname}`;
      };
      const rows = await db.messages.listForConversation(conversation.id, {
        limit: 500,
      });
      const have = new Set((rows || []).map((r: any) => keyOf(r.body, r.file)));
      const memberSet = new Set([creatorId, ...memberIds].filter(Boolean));
      for (const m of messages || []) {
        const text = (m && (m.text ?? m.body)) || "";
        const file = (m && m.file) || null;
        if (!text && !file) continue;
        // Orphan mid-call uploads (call recordings, in-call attachments) are
        // adopted into this group so EVERY member can play/download them —
        // without this only the uploader passes permissionFor (404 for peers).
        if (file && file.id && (db.files as any).adoptIntoConversation) {
          try {
            await (db.files as any).adoptIntoConversation(file.id, conversation.id);
          } catch (_) {
            /* best-effort */
          }
        }
        if (have.has(keyOf(text, file))) continue;
        const sender =
          m && m.senderId && memberSet.has(m.senderId) ? m.senderId : creatorId;
        try {
          await send({
            conversationId: conversation.id,
            senderId: sender,
            text,
            file,
            bumpUnread: false,
          });
        } catch (_) {
          /* skip a bad row, keep merging the rest */
        }
      }
    } catch (_) {
      /* merge is best-effort — the first writer's transcript already stands */
    }
    return { ...conversation, deduped: true };
  }
  // Every ported message must come from a MEMBER (send asserts membership), so an
  // unknown/unmapped sender (common for call chat, which is name-keyed) falls back
  // to the creator rather than being dropped.
  const memberSet = new Set([creatorId, ...memberIds].filter(Boolean));
  for (const m of messages || []) {
    const text = (m && (m.text ?? m.body)) || "";
    const file = (m && m.file) || null;
    if (!text && !file) continue;
    // Orphan mid-call uploads (call recordings, in-call attachments) are
    // adopted into this group so EVERY member can play/download them — without
    // this only the uploader passes permissionFor (404 for everyone else).
    if (file && file.id && (db.files as any).adoptIntoConversation) {
      try {
        await (db.files as any).adoptIntoConversation(file.id, conversation.id);
      } catch (_) {
        /* best-effort */
      }
    }
    const sender =
      m && m.senderId && memberSet.has(m.senderId) ? m.senderId : creatorId;
    try {
      await send({
        conversationId: conversation.id,
        senderId: sender,
        text,
        file,
        bumpUnread: false,
      });
    } catch (_) {
      /* skip a bad row, keep porting the rest */
    }
  }
  // No in-timeline "Temporary group…" system message: the chat header already
  // pins a dismissible banner with a LIVE day countdown, so the static copy in
  // the stream was pure repetition (and its hardcoded "7 days" drifted from the
  // banner's real remaining time). ChatView also hides the rows persisted by
  // older builds.
  return conversation;
}

export {
  listForUser,
  create,
  createTemporaryGroup,
  addMembers,
  setStar,
  setMute,
  setHidden,
  clearHistory,
  setRead,
  markRead,
  getReceipts,
  update,
  convertTempToPermanent,
  setTempRetention,
  remove,
  members,
  setMemberRole,
  removeMember,
  files,
  links,
};
