import { db, currentOrgId } from "../platform";
import * as conversationService from "./conversationService";
import { pubUser } from "../serialize";
import { httpErr as httpError } from "../optimization/httpError";

async function send({ fromUserId, toUserId }) {
  if (!toUserId) throw httpError(400, "Recipient is required.");
  if (toUserId === fromUserId)
    throw httpError(400, "You can't invite yourself.");
  const target = await db.users.getById(toUserId);
  if (!target) throw httpError(404, "That person isn't on Collab.");
  // Connections are INTRA-TENANT (P0 #22): search, DM lists and conversation reads
  // are all org-scoped, so a DM created for someone outside the sender's workspace
  // would be invisible to the sender. Require the recipient to be an active member
  // of the sender's active org. Skipped for legacy NULL-org (single-tenant)
  // sessions, which are byte-for-byte unaffected.
  const orgId = currentOrgId();
  if (orgId) {
    const m = await db.orgs.membership(toUserId, orgId);
    if (!m || m.status !== "active")
      throw httpError(400, "That person isn't in your workspace.");
  }
  if (await db.invites.isBlockedBy(fromUserId, toUserId))
    throw httpError(403, "You can't send this person an invite.");
  // "Already connected" now means an ACCEPTED connection — a DM that is NOT still
  // pending. A pending DM (from an earlier, not-yet-accepted request) is caught by
  // the pending-invite guard below instead of reading as connected.
  const dmId = await db.conversations.findDmBetween(fromUserId, toUserId);
  if (dmId) {
    const dm = await db.conversations.getById(dmId);
    if (dm && !dm.pendingConnection)
      throw httpError(409, "You're already connected with this person.");
  }
  const existing = await db.invites.findBetween(fromUserId, toUserId);
  if (existing && existing.status === "pending")
    throw httpError(409, "There's already a pending invite with this person.");
  // Teams-model pending messaging: create the DM NOW (pending) so the sender can
  // open it and send TEXT immediately, before the recipient accepts. dm_key dedup
  // makes this idempotent; conversationService adds the recipient as a HIDDEN
  // member so the DM stays out of their sidebar until they accept (they keep the
  // normal incoming connection-request UX). Attachments are blocked until accept.
  const { conversation } = await conversationService.create({
    kind: "dm",
    title: null,
    icon: null,
    memberIds: [toUserId],
    creatorId: fromUserId,
    pending: true,
  });
  const invite = await db.invites.create({ fromUserId, toUserId });
  return { invite, conversationId: conversation.id };
}

// Tear down the pending DM created at Connect time when a request is declined /
// blocked / cancelled — so it leaves no orphan chat and a future re-Connect starts
// with a clean DM (discardPending is a no-op on an already-accepted conversation).
async function discardPendingDm(a, b) {
  try {
    // Org-agnostic (see accept): the pending DM lives in the SENDER's org, but the
    // decliner/canceller may be acting from another active org. discardPending only
    // ever touches a still-pending row (pending_connection=1 guard), so resolving
    // it cross-org can never harm an already-accepted conversation.
    const dmId = await db.conversations.findDmBetweenAny(a, b);
    if (dmId) await db.conversations.discardPending(dmId);
  } catch (_) {
    /* best-effort teardown */
  }
}

async function accept({ inviteId, userId }) {
  const inv = await db.invites.getById(inviteId);
  if (!inv) throw httpError(404, "Invite not found.");
  if (inv.toUserId !== userId)
    throw httpError(403, "Only the recipient can accept this invite.");
  // Idempotent: re-accepting an ALREADY-accepted invite is a success, not an error.
  // A client that retries after a transient network/socket hiccup then converges to
  // the connected state instead of a confusing "already accepted" 409.
  if (inv.status === "accepted")
    return {
      invite: inv,
      conversationId: inv.conversationId,
      fromUserId: inv.fromUserId,
      toUserId: inv.toUserId,
    };
  if (inv.status !== "pending")
    throw httpError(409, `This invite is already ${inv.status}.`);
  // Membership is created here — and only here. Resolve the pending DM created at
  // Connect time ORG-AGNOSTICALLY: it was stamped with the sender's active org, but
  // the recipient may be accepting while a different org they belong to is active.
  // An org-scoped lookup would miss it and fall through to a create() that collides
  // on the global dm_key unique index and 500s (row-alias upsert keeps the old id).
  // dm_key guarantees at most one DM per pair system-wide, so this finds THE DM.
  let conversationId = await db.conversations.findDmBetweenAny(
    inv.fromUserId,
    inv.toUserId,
  );
  if (!conversationId) {
    const { conversation } = await conversationService.create({
      kind: "dm",
      title: null,
      icon: null,
      memberIds: [inv.fromUserId],
      creatorId: inv.toUserId,
    });
    conversationId = conversation.id;
  }
  // Teams-model: clear the pending flag BEFORE marking the invite accepted so a
  // mid-failure leaves the invite 'pending' and the whole accept safely retryable.
  // The DM becomes a normal DM — both parties can now send text + attachments, and
  // the recipient's Accept/Decline gate disappears. No member un-hide needed: under
  // the message-request model the recipient was a normal (visible) member all along.
  await db.conversations.setPendingConnection(conversationId, false);
  const updated = await db.invites.setStatus(
    inviteId,
    "accepted",
    conversationId,
  );
  return {
    invite: updated,
    conversationId,
    fromUserId: inv.fromUserId,
    toUserId: inv.toUserId,
  };
}

async function respond(inviteId, userId, status) {
  const inv = await db.invites.getById(inviteId);
  if (!inv) throw httpError(404, "Invite not found.");
  if (inv.toUserId !== userId)
    throw httpError(403, "Only the recipient can respond to this invite.");
  if (inv.status !== "pending")
    throw httpError(409, `This invite is already ${inv.status}.`);
  const updated = await db.invites.setStatus(inviteId, status);
  await discardPendingDm(inv.fromUserId, inv.toUserId);
  return {
    invite: updated,
    fromUserId: inv.fromUserId,
    toUserId: inv.toUserId,
  };
}
const decline = ({ inviteId, userId }) => respond(inviteId, userId, "declined");
const block = ({ inviteId, userId }) => respond(inviteId, userId, "blocked");

// The SENDER withdraws their own still-pending request. Mirrors respond() but is
// keyed on the fromUser (sender) instead of the recipient. Status "cancelled" so the
// recipient's client drops it from its pending list (Request tab / dashboard count /
// Contacts) on the INVITE_UPDATED -> refetch, and the sender's "Requested" reverts
// to "Connect". A resolved (accepted/declined) invite can't be cancelled.
async function cancel({ inviteId, userId }) {
  const inv = await db.invites.getById(inviteId);
  if (!inv) throw httpError(404, "Invite not found.");
  if (inv.fromUserId !== userId)
    throw httpError(403, "Only the sender can cancel this request.");
  if (inv.status !== "pending")
    throw httpError(409, `This invite is already ${inv.status}.`);
  const updated = await db.invites.setStatus(inviteId, "cancelled");
  await discardPendingDm(inv.fromUserId, inv.toUserId);
  return {
    invite: updated,
    fromUserId: inv.fromUserId,
    toUserId: inv.toUserId,
  };
}

async function serialize(i, viewerId) {
  return {
    id: i.id,
    status: i.status,
    direction: i.fromUserId === viewerId ? "outgoing" : "incoming",
    from: pubUser(await db.users.getById(i.fromUserId)),
    to: pubUser(await db.users.getById(i.toUserId)),
    conversationId: i.conversationId,
    createdAt: i.createdAt,
    respondedAt: i.respondedAt,
  };
}

async function listForUser(userId) {
  const rows = await db.invites.listForUser(userId);
  return Promise.all(rows.map((i) => serialize(i, userId)));
}

export { send, accept, decline, block, cancel, listForUser, serialize };
