import { db, orgContext } from "../platform";
import * as notifService from "./notificationService";

// Org-wide BROADCASTS (BA #6). One delivery routine shared by BOTH paths — the
// immediate "Send broadcast" and the scheduled poller — so a queued broadcast is
// byte-for-byte the same notification as an instant one. Transport-free: it
// returns the notifications it created and lets the caller fan them out over
// realtime/web-push (mirrors scheduledMessageService.runDue).

export type BroadcastDelivery = { broadcast: any; notifications: any[] };

// Build + persist one notification per member (author excluded). Never throws
// for a single bad recipient — one member's failure must not stop the rest.
async function notifyMembers(b: any): Promise<any[]> {
  // Run the WHOLE delivery inside the broadcast's own org context. The
  // notification INSERT stamps organization_id from currentOrgId(); the
  // scheduled poller runs outside any request, where that is null — so a queued
  // broadcast's notifications were written with organization_id NULL, arrived
  // live over the socket, and then silently vanished from Activity on the next
  // reload (listForUser filters on organization_id = the session's org). The
  // immediate route path already runs inside the sender's org context; wrapping
  // here makes both paths stamp the same tenant, from the broadcast row itself.
  return orgContext.run({ orgId: b.organizationId }, async () => {
    const [roster, org, actor] = await Promise.all([
      db.orgs.members(b.organizationId),
      db.orgs.getById(b.organizationId),
      b.authorId ? db.users.getById(b.authorId) : Promise.resolve(null),
    ]);
    // Announcements go to ACTIVE members only, excluding author and any specifically excluded users (e.g. CEO/CTO).
    const excluded = new Set(
      Array.isArray(b.excludedUserIds)
        ? b.excludedUserIds
        : Array.isArray(b.excluded_user_ids)
          ? b.excluded_user_ids
          : typeof b.excludedUserIds === "string"
            ? b.excludedUserIds.split(",").map((s: string) => s.trim()).filter(Boolean)
            : [],
    );
    const recipients = (roster || []).filter(
      (m) =>
        m &&
        m.userId &&
        m.userId !== b.authorId &&
        !excluded.has(m.userId) &&
        (!m.status || m.status === "active"),
    );
    // Fan the per-member inserts out with BOUNDED concurrency instead of a serial
    // await over the whole ~100-user roster. Bounded (not an unbounded Promise.all
    // over every member) because the mysql driver already flags errno 1040 "too
    // many connections" as retryable — 100 simultaneous inserts could saturate the
    // pool. Each recipient keeps its own try/catch so one bad recipient never stops
    // the rest, and `out` stays in roster order.
    const out: any[] = [];
    const CONCURRENCY = 10;
    for (let i = 0; i < recipients.length; i += CONCURRENCY) {
      const results = await Promise.all(
        recipients.slice(i, i + CONCURRENCY).map(async (m) => {
          try {
            return await notifService.notifyOrgBroadcast({
              userId: m.userId,
              actorName: actor?.name || b.authorName || "An administrator",
              orgName: org?.name || "Your organization",
              orgId: b.organizationId,
              title: b.title,
              body: b.body,
            });
          } catch (_) {
            return null; /* skip this recipient, keep delivering to the rest */
          }
        }),
      );
      for (const n of results) if (n) out.push(n);
    }
    return out;
  });
}

// Deliver a broadcast that is due NOW (the immediate path). The row is already
// persisted with status 'sent' by the route.
export async function deliver(b: any): Promise<BroadcastDelivery> {
  return { broadcast: b, notifications: await notifyMembers(b) };
}

// Poller tick: claim every due scheduled broadcast and deliver it. Claiming is
// atomic (status → 'sending' inside a transaction with SKIP LOCKED), so running
// several app instances cannot double-send. A delivery failure marks the row
// 'failed' rather than leaving it stuck in 'sending' forever.
export async function runDue(limit = 20): Promise<BroadcastDelivery[]> {
  const due = await db.orgs.claimDueBroadcasts(limit);
  const sent: BroadcastDelivery[] = [];
  for (const b of due) {
    try {
      const notifications = await notifyMembers(b);
      await db.orgs.setBroadcastStatus(b.id, "sent");
      sent.push({ broadcast: { ...b, status: "sent" }, notifications });
    } catch (e) {
      try {
        await db.orgs.setBroadcastStatus(b.id, "failed");
      } catch (_) {
        /* best-effort */
      }
      console.error("[org-broadcast] delivery failed:", (e as any)?.message || e);
    }
  }
  return sent;
}
