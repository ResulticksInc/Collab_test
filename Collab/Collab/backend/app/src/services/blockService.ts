import { db } from "../platform";
import { pubUser } from "../serialize";
import { httpErr as httpError } from "../optimization/httpError";

async function block({ blockerId, blockedId, reason }) {
  if (!blockedId) throw httpError(400, "User is required.");
  if (blockedId === blockerId) throw httpError(400, "You can't block yourself.");
  const target = await db.users.getById(blockedId);
  if (!target) throw httpError(404, "That person isn't on Collab.");
  await db.blocks.block(blockerId, blockedId, reason);
  return { blockedId, blocked: true };
}

async function unblock({ blockerId, blockedId }) {
  await db.blocks.unblock(blockerId, blockedId);
  return { blockedId, blocked: false };
}

async function list(userId) {
  const rows = await db.blocks.listBlocked(userId);
  return Promise.all(
    rows.map(async (r) => ({
      ...(pubUser(await db.users.getById(r.userId)) || { id: r.userId }),
      reason: r.reason,
      createdAt: r.createdAt,
    })),
  );
}

// Shared guard used by messaging + calls.
async function isBlockedBetween(a, b) {
  if (!a || !b || a === b) return false;
  return db.blocks.isBlockedEitherWay(a, b);
}

async function report({ reporterId, reportedId, reason }) {
  if (!reportedId) throw httpError(400, "User is required.");
  if (reportedId === reporterId) throw httpError(400, "You can't report yourself.");
  const target = await db.users.getById(reportedId);
  if (!target) throw httpError(404, "That person isn't on Collab.");
  await db.blocks.report(reporterId, reportedId, reason);
  return { reported: true };
}

async function listReports(userId) {
  const rows = await db.blocks.listReports(userId);
  return Promise.all(
    rows.map(async (r) => ({
      id: r.id,
      ...(pubUser(await db.users.getById(r.userId)) || { id: r.userId }),
      reason: r.reason,
      createdAt: r.createdAt,
    })),
  );
}

async function removeReport({ userId, reportId }) {
  return db.blocks.removeReport(userId, reportId);
}

export { block, unblock, list, isBlockedBetween, report, listReports, removeReport };
