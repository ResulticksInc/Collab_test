import { db } from "../platform";

// Fire-and-forget recorder: an audit write must never block or fail the
// action that triggered it.
async function record(e: any) {
  try {
    await db.audit.create(e);
  } catch (err) {
    console.error("[audit] failed to record", e && e.action, err);
  }
}

async function listForActor(actorId: string, limit = 50) {
  return db.audit.listForActor(actorId, limit);
}

export { record, listForActor };
