import { db, config } from "../platform";
import { permissionFor as filePermissionFor } from "./fileService";
import { serializeMessage, serializeMessageList } from "../serialize";
import * as webhooks from "./webhookService";
import * as connectors from "./connectorService";

// Message kinds that ONLY trusted server-side callers may set — meeting invites,
// task cards, and system/call logs, whose bodies drive privileged, unattributed
// UI cards. A client-originated send supplying one is spoofing a server-authored
// message, so sanitizeClientType coerces it back to a plain "text" message.
// (Legitimate client kinds — voice/sticker/gif/text — pass through unchanged.)
export const SERVER_ONLY_MSG_TYPES = new Set(["meeting_invite", "meeting_attendance", "task_card", "system", "call"]);
export function sanitizeClientType(t: any): any {
  return SERVER_ONLY_MSG_TYPES.has(String(t)) ? "text" : t;
}

// Membership gate: a conversation's messages may only be read, posted to, or
// reacted to by its members. Throws 403 (caught by the error middleware).
async function assertMember(conversationId, userId) {
  const member = await db.conversations.isMember(conversationId, userId);
  if (!member) {
    const e: any = new Error("You are not a member of this conversation");
    e.status = 403;
    e.code = "FORBIDDEN";
    throw e;
  }
}

async function history(conversationId, viewerId, { before = null, limit }: { before?: string | null; limit?: number } = {}) {
  await assertMember(conversationId, viewerId);
  const rows = await db.messages.listForConversation(conversationId, {
    limit: limit || config.constants.pagination.messagesPageSize,
    before: before || null,
    // #16: pass the viewer so the driver can hide messages older than their
    // per-member history cutoff (no-op for members with full history).
    viewerId,
  });
  const bm = new Set(await db.bookmarks.list(viewerId));
  const deletedIds = new Set(await db.messages.getDeletionIds(viewerId));
  // Batched: ONE users query for every sender + reactor on the page, instead of
  // one read per message (a 50-message page was ~50 concurrent user queries).
  return serializeMessageList(
    rows.filter((m) => !deletedIds.has(m.id)),
    viewerId,
    { bookmarkedIds: bm },
  );
}

async function removeForMe({ messageId, userId }) {
  // Hiding a message is per-viewer and never touches the message itself, so it
  // needs no ownership check — you may remove anything from YOUR copy of a
  // conversation. It does need a MEMBERSHIP check: without one, any caller
  // could write deletion rows for arbitrary message ids in threads they aren't
  // part of. Same guard every other message mutation here uses.
  const existing = await db.messages.getById(messageId);
  if (!existing) {
    const e: any = new Error("Message not found");
    e.status = 404;
    e.code = "NOT_FOUND";
    throw e;
  }
  await assertMember(existing.conversationId, userId);
  await db.messages.addDeletion(userId, messageId);
  return { messageId, deleted: true };
}
async function shareAttachmentWithConversation(fileId: string, conversationId: string, senderId: string) {
  let meta: any = null;
  try {
    meta = await db.files.getMeta(String(fileId));
  } catch (_) {
    return; // unreadable meta → leave the send alone (legacy / external file refs)
  }
  if (!meta) return; // not a stored file (demo / url-only attachment) → nothing to grant
  if (meta.conversationId === conversationId) return; // posted where it was uploaded
  if (!(await filePermissionFor(String(fileId), senderId))) {
    const e: any = new Error("You don't have access to that file.");
    e.status = 403;
    e.code = "FILE_FORBIDDEN";
    throw e;
  }
  try {
    await db.fileShares.create({
      fileId: String(fileId),
      subjectType: "conversation",
      subjectId: conversationId,
      permission: "view",
      createdBy: senderId,
    });
  } catch (err: any) {
    // Best-effort: a share-row hiccup must not block the message itself.
    console.warn("[messages] could not share forwarded file %s with %s: %s", fileId, conversationId, err?.message);
  }
}

async function send({
  conversationId,
  senderId,
  text,
  file,
  type = null,
  voice = null,
  encrypted = null,
  forwarded = false,
  forwardCount = 0,
  parentMessageId = null,
  // "Send as important" (Teams-style): create the message already flagged. The
  // author is the sender, so this needs no extra auth beyond the send itself.
  important = false,
  // Some system logs (e.g. a normally-ended call the recipient was already in)
  // should appear in the thread WITHOUT raising an unread badge. Defaults true.
  bumpUnread = true,
  // Set by webhookService.ingest when this message ARRIVED through an incoming
  // webhook. Purely a loop guard for the outgoing dispatcher — see
  // webhookService.dispatch. Not persisted; the message is otherwise ordinary.
  viaWebhookId = null,
  // Set by connectorIngestService when this message ARRIVED through a platform
  // connector (Slack/Teams/Google Chat/WhatsApp). Loop guard for the connector
  // dispatcher — it is never echoed back out the same mapping — plus the
  // original author/platform so a further hop can attribute it. Not persisted.
  viaConnectorMappingId = null,
  bridge = null,
}: any) {
  await assertMember(conversationId, senderId);
  // Block enforcement: in a DM, neither party may message the other if a block
  // exists in either direction. Group conversations are unaffected.
  const conv = await db.conversations.getById(conversationId);
  if (conv && conv.kind === "dm" && db.blocks) {
    const others = (await db.conversations.members(conversationId))
      .map((m: any) => m.userId)
      .filter((id: string) => id !== senderId);
    for (const other of others) {
      if (await db.blocks.isBlockedEitherWay(senderId, other)) {
        const e: any = new Error("You can't message this person.");
        e.status = 403;
        e.code = "BLOCKED";
        throw e;
      }
    }
  }
  // Teams-model pending connection DM (message request). `conv` is already loaded,
  // so this is an O(1) check on the hot send path.
  if (conv && conv.kind === "dm" && (conv as any).pendingConnection) {
    // The RECIPIENT (non-creator) must ACCEPT the request before they can reply —
    // until then the request is read-only for them (the client shows Accept/Decline).
    if (senderId !== (conv as any).createdBy) {
      const e: any = new Error("Accept the connection request to reply.");
      e.status = 403;
      e.code = "ACCEPT_TO_REPLY";
      throw e;
    }
    // The SENDER may send TEXT only until it's accepted — attachments / voice notes /
    // stickers / GIFs are blocked (defense-in-depth; the composer disables them too).
    if (file || voice || ["sticker", "gif"].includes(String(type))) {
      const e: any = new Error(
        "You can only send text until this connection request is accepted.",
      );
      e.status = 403;
      e.code = "PENDING_REQUEST";
      throw e;
    }
  }
  // A file attached to a message in a DIFFERENT conversation than the one it
  // was uploaded to (a FORWARD, or re-attaching something from the Files
  // module) must become readable by THIS conversation's members. The Files
  // permission model only knew the upload conversation, so every recipient of
  // a forwarded image/document got 404 → "File no longer available". Grant the
  // target conversation a view share (the model permissionFor already honours),
  // but only when the SENDER can see the file — otherwise a crafted file id in
  // a message body would turn forwarding into a way to open anyone's file.
  if (file && file.id) await shareAttachmentWithConversation(file.id, conversationId, senderId);
  const row = await db.messages.create({
    conversationId,
    senderId,
    body: encrypted ? null : text || null,
    file: file || null,
    type: type || null,
    voice: voice || null,
    encryptionVersion: encrypted ? encrypted.version || 1 : 0,
    ciphertext: encrypted || null,
    forwarded,
    // A forward of a forward increments the chain so the UI can show
    // "Forwarded many times" (WhatsApp parity). Clamp to >=1 when forwarded.
    forwardCount: forwarded ? Math.max(1, Number(forwardCount) || 1) : 0,
    parentMessageId: parentMessageId || null,
    important: !!important,
  });
  if (bumpUnread && db.conversations.bumpUnread)
    await db.conversations.bumpUnread(conversationId, senderId);
  // A new message resurfaces the conversation for anyone who archived/hid it, so
  // chats are never lost (matches WhatsApp/Teams/Slack). Best-effort.
  try {
    if (db.conversations.unhideAll)
      await db.conversations.unhideAll(conversationId);
  } catch (_) {
    /* non-fatal */
  }
  // Temp-group sliding expiry: any new message (chat, attachment, call log, ported
  // meeting chat) is "activity" — push the death clock out to NOW()+retention_days.
  // No-op on permanent/non-temp conversations. Best-effort — never blocks a send.
  try {
    if ((db.conversations as any).touchTempExpiry)
      await (db.conversations as any).touchTempExpiry(conversationId);
  } catch (_) {
    /* non-fatal */
  }
  const out = await serializeMessage(row, senderId);
  // OUTGOING CHAT WEBHOOKS. Fire-and-forget: dispatch only queues rows, and it
  // swallows its own errors, so a webhook problem can never fail or delay a send.
  webhooks.dispatch("message.created", {
    conversationId,
    message: out,
    viaWebhookId,
  });
  // UNIFIED CONNECTOR ENGINE — same fire-and-forget contract (queues a job per
  // mapped platform channel, swallows its own errors).
  connectors.dispatch("message.created", { conversationId, message: out, viaConnectorMappingId, bridge });
  return out;
}
async function getThread(messageId, viewerId) {
  const t = await db.messages.thread(messageId);
  if (!t) return null;
  if (!(await db.conversations.isMember(t.parent.conversationId, viewerId)))
    return null;
  const bm = new Set(await db.bookmarks.list(viewerId));
  const parent = await serializeMessage(t.parent, viewerId, {
    bookmarkedIds: bm,
  });
  const replies = await serializeMessageList(t.replies, viewerId, {
    bookmarkedIds: bm,
  });
  return { parent, replies };
}
async function toggleReaction({ messageId, userId, emoji }) {
  const existing = await db.messages.getById(messageId);
  if (!existing) return null;
  await assertMember(existing.conversationId, userId);
  const m = await db.messages.toggleReaction(messageId, userId, emoji);
  if (!m) return null;
  const out: any = serializeMessage(m, userId);
  // AUDIT P2: carry the add/remove signal onto the serialized message so the socket
  // handler only notifies the owner on ADD (not when a reaction is toggled off).
  if (out && typeof out === "object") out._reactionAdded = (m as any)._reactionAdded !== false;
  return out;
}
async function edit({ messageId, userId, text, encrypted, viaConnectorMappingId = null }: any) {
  const existing = await db.messages.getById(messageId);
  if (!existing || existing.senderId !== userId) return null;
  // E2EE edit: the client supplies a fully-formed ciphertext envelope set
  // (same shape as a send). Server stores the new envelope, body stays NULL,
  // encryption_version is bumped. Plaintext history is never retained.
  if (encrypted) {
    const m = await db.messages.update(messageId, {
      ciphertext: encrypted,
      encryptionVersion: encrypted.version || 1,
      edited: true,
    });
    if (!m) return null;
    const out = await serializeMessage(m, userId);
    webhooks.dispatch("message.updated", { conversationId: existing.conversationId, message: out });
    connectors.dispatch("message.updated", { conversationId: existing.conversationId, message: out, viaConnectorMappingId });
    return out;
  }
  // Plaintext edit: only allowed when the original was plaintext. An encrypted
  // message MUST be edited via the encrypted path — refusing a plaintext edit
  // here prevents the client from accidentally downgrading an E2EE row.
  if (Number(existing.encryptionVersion) > 0) {
    const e: any = new Error("Encrypted messages must be edited with an encrypted payload");
    e.status = 400;
    throw e;
  }
  const clean = (text || "").trim();
  if (!clean) return null;
  const m = await db.messages.update(messageId, {
    body: clean,
    edited: true,
  });
  if (!m) return null;
  const out = await serializeMessage(m, userId);
  webhooks.dispatch("message.updated", { conversationId: existing.conversationId, message: out });
  connectors.dispatch("message.updated", { conversationId: existing.conversationId, message: out, viaConnectorMappingId });
  return out;
}
async function remove({ messageId, userId, viaConnectorMappingId = null }: any) {
  const existing = await db.messages.getById(messageId);
  if (!existing || existing.senderId !== userId)
    return { id: messageId, deleted: false };
  const m = await db.messages.remove(messageId); // soft-delete; returns the row
  if (!m)
    return {
      id: messageId,
      conversationId: existing.conversationId,
      deleted: false,
    };
  // Return the full (now-tombstoned) message so it can broadcast as an update and
  // render "This message was deleted" in place rather than vanishing.
  const serialized = await serializeMessage(m, userId);
  webhooks.dispatch("message.deleted", {
    conversationId: existing.conversationId,
    message: serialized,
  });
  connectors.dispatch("message.deleted", { conversationId: existing.conversationId, message: serialized, viaConnectorMappingId });
  return { ...serialized, conversationId: existing.conversationId, deleted: true };
}
async function toggleBookmark({ userId, messageId }) {
  // SECURITY: bookmarking was the ONE message mutation with no membership
  // check (removeForMe / react / pin / unpin all assert). Without it any signed-in
  // user could bookmark an arbitrary message id from a conversation they are not
  // in and then read the whole message back — body, sender and attachment —
  // out of GET /api/bookmarks. Assert membership exactly like the siblings do.
  const existing = await db.messages.getById(messageId);
  if (!existing) {
    const e: any = new Error("Message not found.");
    e.status = 404;
    throw e;
  }
  await assertMember(existing.conversationId, userId);
  const bookmarked = await db.bookmarks.toggle(userId, messageId);
  return { messageId, bookmarked };
}
async function listBookmarks(userId) {
  const ids = await db.bookmarks.list(userId);
  const out = [];
  for (const id of ids) {
    const m = await db.messages.getById(id);
    if (!m) continue;
    // Re-assert per read: covers rows bookmarked before this guard existed and
    // access revoked since (left/removed from the conversation).
    try {
      await assertMember(m.conversationId, userId);
    } catch (_) {
      continue;
    }
    out.push(await serializeMessage(m, userId, { bookmarkedIds: new Set(ids) }));
  }
  return out;
}
// List a conversation's pinned messages. SECURITY: the GET /:id/pinned route
// used to call db.messages.listPinned(id) directly — no membership check — so
// ANY authenticated user could read the pinned messages (plaintext bodies for
// non-E2EE conversations) of ANY conversation by id. Every sibling read
// (history/files/links/scheduled/bookmarks) asserts membership; this one didn't.
// Assert membership, and serialize like pin()/history() so the shape carries a
// sender object + viewer flags instead of a raw DB row (which also stops raw
// .body from being emitted verbatim). Mirrors history()'s bookmark handling.
async function listPinned(conversationId, viewerId) {
  await assertMember(conversationId, viewerId);
  const rows = await db.messages.listPinned(conversationId);
  const bm = new Set(await db.bookmarks.list(viewerId));
  return Promise.all(
    (rows || []).map((m) => serializeMessage(m, viewerId, { bookmarkedIds: bm })),
  );
}
// Pin / unpin must return a SERIALIZED message (sender object, time, me, etc.)
// — returning the raw DB row crashes the client render (m.sender is undefined).
async function pin({ messageId, userId }) {
  const existing = await db.messages.getById(messageId);
  if (!existing) return null;
  await assertMember(existing.conversationId, userId);
  const m = await db.messages.pin(messageId, userId);
  return m ? serializeMessage(m, userId) : null;
}
async function unpin({ messageId, userId }) {
  const existing = await db.messages.getById(messageId);
  if (!existing) return null;
  await assertMember(existing.conversationId, userId);
  const m = await db.messages.unpin(messageId);
  return m ? serializeMessage(m, userId) : null;
}
// Teams-style "Mark as important": a per-message flag set by the AUTHOR on their
// own message, visible to everyone in the conversation. Returns null (→ 404) for
// a non-member or a non-author, so nobody can flag someone else's message.
async function setImportant({ messageId, userId, important }) {
  const existing = await db.messages.getById(messageId);
  if (!existing) return null;
  await assertMember(existing.conversationId, userId);
  if (existing.senderId !== userId) return null;
  const m = await db.messages.setImportant(messageId, !!important);
  return m ? serializeMessage(m, userId) : null;
}

export {
  history,
  send,
  toggleReaction,
  edit,
  remove,
  toggleBookmark,
  listBookmarks,
  listPinned,
  getThread,
  removeForMe,
  pin,
  unpin,
  setImportant,
};
