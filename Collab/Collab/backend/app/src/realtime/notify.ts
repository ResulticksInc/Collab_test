import { broadcast } from "./socket";
import { shared, db, config } from "../platform";
import { sendToUser, isReady } from "../services/webPushService";

const { EVENTS } = shared;

// ── Closed-tab WEB-PUSH suppression gate ────────────────────────────────────
// Loads the recipient's notification settings and decides whether the CLOSED-TAB
// web push should be suppressed (quiet-hours / notify-level "none").
//
// CRITICAL invariants:
//  • This gate ONLY affects the WEB PUSH. The live socket emit ALWAYS fires
//    (an open tab still gets its in-app toast + Activity badge — the client's own
//    dispatchNotif gate decides whether to raise an OS notification there).
//  • FAIL-OPEN: any settings-load error must NOT drop the push. A telemetry/DB
//    hiccup can never silence a reminder/task/message notification.
//  • Type-agnostic: applies to EVERY push routed through suppressWebPush
//    (reminders, task_due, messages, …) — not reminder-only. Calls are never
//    gated (they never route through this), and a missed-call is informational.
//
// SCOPE NOTE: suppressWebPush itself is CONVERSATION-AGNOSTIC. It evaluates only
// the GLOBAL notification preferences — notifyLevel==="none" (mute everything)
// and the quiet-hours window (in the recipient's timezone). It does NOT read
// per-conversation mute flags (conversation_members.muted), because it takes a
// userId only and has no conversation context, and it does NOT special-case
// notifyLevel==="mentions" (a "mentions"-only user is treated like a normal
// recipient for the web push — only "none" + quiet-hours suppress here).
//
// Per-conversation MUTE is enforced ONE LEVEL UP, at the message-push call
// sites (realtime/socket.ts and routes/conversations.ts): those filter out
// members who muted the conversation BEFORE calling suppressWebPush, since
// that's where the conversation context lives. So end-to-end a muted
// conversation does NOT raise a closed-tab message push — the coverage just
// isn't inside this function. Reminders/task_due have no conversation mute.
//
// Quiet-hours math mirrors the client (lib/dispatchNotif.quietHoursActive) so
// web and in-app agree: HH:MM window, wrap-around past midnight, equal = off.
// The window is evaluated in the RECIPIENT'S timezone (not the backend host's),
// matching the repo convention that all wall-clock formatting is done in the
// viewer's zone (serialize.ts: "Raw ISO so the client formats in the viewer's
// local timezone"). With users in IST and a UTC/us-east host, evaluating in the
// server zone would shift the window 5.5–10.5h and gate at the wrong hours.

// Resolve the IANA timezone to evaluate quiet-hours in, for this recipient.
//  • The Settings "timezone" value is "auto" by default (system zone, which on
//    the server is meaningless), so a literal IANA name there wins if present.
//  • Else the user PROFILE timezone (e.g. "Asia/Kolkata") — the field users set.
//  • Else a deploy-level override (QUIET_HOURS_TZ / TZ), else UTC.
function pickTimezone(settingsTz: any, profileTz: any): string {
  const isIana = (z: any) =>
    typeof z === "string" && z.trim() !== "" && z.trim().toLowerCase() !== "auto";
  const candidate = isIana(settingsTz)
    ? settingsTz.trim()
    : isIana(profileTz)
      ? profileTz.trim()
      : process.env.QUIET_HOURS_TZ || process.env.TZ || "UTC";
  // Validate the zone is one Intl accepts; fall back to UTC otherwise so a
  // typo'd profile timezone never throws (and never drops a push).
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate });
    return candidate;
  } catch (_) {
    return "UTC";
  }
}

// Current minutes-since-midnight in the given IANA timezone.
function minutesNowInZone(tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  let h = 0;
  let m = 0;
  for (const p of parts) {
    if (p.type === "hour") h = Number(p.value) % 24; // "24" → 0 on some engines
    else if (p.type === "minute") m = Number(p.value);
  }
  return (h || 0) * 60 + (m || 0);
}

function quietHoursActive(s: any, tz: string): boolean {
  if (!s || s.quietHours !== true) return false;
  const parse = (t: any, d: string) => {
    const [h, m] = String(t || d).split(":").map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  const cur = minutesNowInZone(tz);
  const st = parse(s.quietStart, "22:00");
  const en = parse(s.quietEnd, "07:00");
  if (st === en) return false;
  return st < en ? cur >= st && cur < en : cur >= st || cur < en;
}

// Returns true when the closed-tab web push should be SUPPRESSED for this user.
// Defaults (no saved settings) → never suppress. Errors → never suppress.
//
// EXPORTED so every closed-tab web-push site routes through the SAME gate — not
// just pushNotif (reminders/task_due) but also the message push raised from the
// socket layer. The only intentional bypass is the call ring (informational,
// time-critical), which never calls this.
export async function suppressWebPush(
  userId: string,
  opts?: { isMention?: boolean; bypassQuietHours?: boolean },
): Promise<boolean> {
  try {
    const s = (await db.settings.get(userId)) || {};
    // K9: a user who set themselves to "Do not disturb" gets no in-app / socket
    // notifications (web dispatchNotif.shouldPush, and the mobile app) — the
    // closed-app push must honour it too, or DND only works while the app is
    // open. Rings never come through here, so calls still ring (as today).
    let user: any = null;
    try { user = await db.users.getById(userId); } catch (_) {}
    if (user?.manualPresence === "dnd") return true;
    // Explicit "no notifications" preference.
    if (s.notifyLevel === "none") return true;
    // AUDIT P2 (#38): "Mentions only" must ALSO gate closed-tab MESSAGE push, not
    // just the in-app path. A plain-message push is suppressed for a mentions-only
    // user; a directed notification (mention/reply/reaction — isMention) still pushes,
    // so they're pinged exactly when someone @-mentions or replies to them.
    if (s.notifyLevel === "mentions" && !(opts && opts.isMention)) return true;
    // Within the user's quiet-hours window — evaluated in the recipient's zone.
    // K2.2: a caller may exempt a notification class (missed calls, by config).
    if (s.quietHours === true && !(opts && opts.bypassQuietHours)) {
      if (quietHoursActive(s, pickTimezone(s.timezone, user?.timezone))) return true;
    }
    return false;
  } catch (_) {
    // FAIL-OPEN: never let a settings-load failure drop a notification.
    return false;
  }
}

/**
 * Push an already-created notification to its recipient via TWO channels:
 *
 * 1. Socket.IO → every connected tab/device (live toast + Activity badge)
 * 2. Web Push (VAPID) → browser push service (Chrome/Firefox/Edge/Safari) so
 *    the notification lands even when ALL tabs are closed, the laptop is asleep,
 *    or the user is on a different device entirely. The service worker receives
 *    the push event and shows a native OS notification.
 *
 * The SOCKET emit is synchronous and always fires. The WEB PUSH is
 * fire-and-forget (never blocks the socket emit), is suppressed when the user
 * has notifyLevel "none" or is inside their quiet-hours window (evaluated in the
 * recipient's timezone — see suppressWebPush; fail-open). pushNotif itself is
 * for conversation-less notifications (reminders/task_due/etc.), so there is no
 * per-conversation mute to consult here; the message-push paths that DO carry a
 * conversation apply mute at their own call site (socket.ts/conversations.ts).
 * Web push also auto-cleans stale/expired subscriptions (410 Gone).
 */
export function pushNotif(io: any, notif: any, opts?: { tag?: string }): void {
  if (!io || !notif || !notif.userId) return;
  // Live in-app channel — ALWAYS delivered (never gated by quiet-hours/mute).
  io.to(broadcast.userRoom(notif.userId)).emit(EVENTS.NOTIFICATION_NEW, notif);

  if (!isReady()) return;

  // Reminder notifications carry Complete + Snooze actions; the service worker
  // reads targetType/targetId to deep-link + act. url is set per-type so a
  // closed-app click opens the right module (chats for conversation-scoped,
  // otherwise undefined → the SW resolves the module from targetType).
  const url = notif.conversationId ? `/chat/${notif.conversationId}` : undefined;

  // Gate the closed-tab web push (async, fire-and-forget). The socket emit above
  // has already landed for any open tab, so suppression here only affects the OS
  // push when every tab is closed/asleep. isMention:true — every pushNotif is a
  // DIRECTED notification (mention/reply/reaction/reminder/task/…), not the plain-
  // message firehose, so it must still reach a "mentions only" user (AUDIT #38); the
  // message-push site in socket.ts passes no flag and is what mentions-only silences.
  // K2.2: once the phone stops raising its own missed-call notification, the
  // server's `call_missed` is the only one — product can exempt it from quiet
  // hours via CALL_MISSED_BYPASS_QUIET_HOURS (default off = same as web).
  const bypassQuietHours = notif.type === "call_missed" && !!config.calls?.missedBypassQuietHours;
  suppressWebPush(notif.userId, { isMention: true, bypassQuietHours })
    .then((suppress) => {
      if (suppress) return;
      return sendToUser(notif.userId, {
        title: notif.title || "New notification",
        body: notif.body,
        tag: (opts && opts.tag) || `colab-${notif.type || "notif"}-${notif.id || ""}`,
        type: notif.type,
        url,
        conversationId: notif.conversationId,
        targetType: notif.targetType,
        targetId: notif.targetId,
      });
    })
    .catch(() => {});
}

/**
 * Notify every OTHER member that they were added to an auto-created TEMPORARY
 * group (from a call/meeting). The ported session messages are inserted with
 * bumpUnread:false (they're history, not new chatter), so without this the group
 * appears in the sidebar with ZERO signal and nobody notices it. One notification
 * per member per group (dedupKey → repeat POSTs/merges never double-notify),
 * delivered via socket + web push (pushNotif). Best-effort; never throws, so a
 * notification failure can never block the group creation it announces.
 */
export async function notifyAddedToTempGroup(
  io: any,
  opts: {
    conversationId: string;
    title?: string | null;
    actorId: string;
    memberIds: string[];
  },
): Promise<void> {
  if (!io || !opts || !opts.conversationId) return;
  const others = (opts.memberIds || []).filter(
    (uid) => uid && uid !== opts.actorId,
  );
  for (const uid of others) {
    try {
      const n = await (db as any).notifications.create({
        userId: uid,
        type: "group_added",
        title: opts.title || "New group",
        body: "Added from a call/meeting",
        actorId: opts.actorId,
        targetType: "conversation",
        targetId: opts.conversationId,
        conversationId: opts.conversationId,
        dedupKey: "tempgrp:" + opts.conversationId + ":" + uid,
      });
      if (n) pushNotif(io, n);
    } catch (_) {
      /* best-effort — a notification must never block group creation */
    }
  }
}
