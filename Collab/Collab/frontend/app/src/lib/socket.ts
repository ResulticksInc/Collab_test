import { io } from "socket.io-client";
import config from "./config";
import { log } from "./logger";
export const EVENTS = {
  CONVERSATION_JOIN: "conversation:join",
  MESSAGE_SEND: "message:send",
  MESSAGE_REACT: "message:react",
  TYPING_START: "typing:start",
  TYPING_STOP: "typing:stop",
  MESSAGE_NEW: "message:new",
  MESSAGE_UPDATED: "message:updated",
  MESSAGE_DELETED: "message:deleted",
  MESSAGE_READ: "message:read",
  MESSAGE_REPLY: "message:reply",
  TASK_CHANGED: "task:changed",
  REMINDER_CHANGED: "reminder:changed",
  CONVERSATION_NEW: "conversation:new",
  CONVERSATION_UPDATED: "conversation:updated",
  CONVERSATION_DELETED: "conversation:deleted",
  // Cross-device unread sync: this user read / marked-unread a conversation on
  // another session; update its unread count + badge here too.
  CONVERSATION_READ: "conversation:read",
  USER_UPDATED: "user:updated",
  MEETING_NEW: "meeting:new",
  MEETING_UPDATED: "meeting:updated",
  // Per-meeting options changed (0116) — carries the new policy so in-meeting
  // controls re-render immediately.
  MEETING_OPTIONS: "meeting:options",
  MEETING_POLL: "meeting:poll",
  MEETING_POLL_REMOVED: "meeting:poll:removed",
  // A host muted this user's mic (meeting or call). Keep in sync with
  // shared/src/events.ts — this file is a separate copy.
  MEDIA_FORCE_MUTE: "media:force_mute",
  MEDIA_FORCE_STOP_SCREEN: "media:force_stop_screen",
  MEDIA_FORCE_CAMERA_OFF: "media:force_camera_off",
  MEETING_WHITEBOARD_ACCESS: "meeting:whiteboard_access",
  // The host changed what THIS user may do (camera / screen share / whiteboard).
  MEETING_PARTICIPANT_PERMISSIONS: "meeting:participant_permissions",
  PRESENCE_UPDATE: "presence:update",
  TYPING: "typing",
  CALL_REQUEST: "call:request",
  CALL_ACCEPT: "call:accept",
  CALL_DECLINE: "call:decline",
  CALL_CANCEL: "call:cancel",
  CALL_HANGUP: "call:hangup",
  CALL_INCOMING: "call:incoming",
  CALL_RINGING: "call:ringing",
  CALL_ACCEPTED: "call:accepted",
  CALL_DECLINED: "call:declined",
  CALL_CANCELLED: "call:cancelled",
  CALL_ENDED: "call:ended",
  CALL_MISSED: "call:missed",
  CALL_BUSY: "call:busy",
  CALL_NEW: "call:new",
  CALL_UPGRADED: "call:upgraded",
  HUDDLE_JOIN: "huddle:join",
  HUDDLE_LEAVE: "huddle:leave",
  HUDDLE_SYNC: "huddle:sync",
  HUDDLE_STATE: "huddle:state",
  HUDDLE_RING: "huddle:ring",
  HUDDLE_RUNG: "huddle:rung",
  INVITE_NEW: "invite:new",
  INVITE_UPDATED: "invite:updated",
  SCHEDULED_CHANGED: "scheduled:changed",
  NOTIFICATION_NEW: "notification:new",
  NOTIFICATION_READ: "notification:read",
  NOTIFICATION_COUNT: "notification:count",
  FILE_CHANGED: "file:changed",
  MEETING_HAND_RAISE: "meeting:hand:raise",
  MEETING_HAND_LOWER: "meeting:hand:lower",
  MEETING_HAND_STATE: "meeting:hand:state",
  MEETING_REACTION: "meeting:reaction",
  MEETING_REACTION_BROADCAST: "meeting:reaction:broadcast",
  MEETING_CHAT_SEND: "meeting:chat:send",
  MEETING_CHAT_NEW: "meeting:chat:new",
  MEETING_JOIN: "meeting:join",
  // Meeting duplicate-device prompt (Session Mgmt Phase 3c): joined a meeting
  // you're already in on another device → offer move / companion / cancel.
  MEETING_DUPLICATE: "meeting:duplicate",
  MEETING_TAKEOVER: "meeting:takeover",
  MEETING_LEAVE_NOW: "meeting:leave_now",
  // Device handoff (P0-12) — move/extend an active call/meeting across the
  // user's own signed-in devices (mirrors shared/src/events.ts).
  DEVICES_LIST: "devices:list",
  HANDOFF_REQUEST: "handoff:request",
  HANDOFF_OFFER: "handoff:offer",
  HANDOFF_ACCEPT: "handoff:accept",
  HANDOFF_DECLINE: "handoff:decline",
  HANDOFF_CONFIRMED: "handoff:confirmed",
  HANDOFF_DECLINED: "handoff:declined",
  // Live session enforcement (Session Mgmt Phase 3): this device's session was
  // revoked elsewhere (self "sign out this device", "sign out others", admin
  // force-logout, or device-limit eviction). Clear the token + return to sign-in.
  SESSION_REVOKED: "session:revoked",
  // Org membership enforcement: this account's membership in an organization
  // ended (removed/left). The client re-validates its session and pivots away
  // via the existing org-invalid recovery.
  ORG_MEMBERSHIP_REVOKED: "org:membership-revoked",
  // E2EE live sync choreography (mirrors shared/src/events.ts): new device
  // approved → siblings push history now; sync-ready → target fetches; sync-
  // requested → siblings push targeted history for unreadable conversations.
  E2EE_DEVICE_APPROVED: "e2ee:device-approved",
  E2EE_SYNC_READY: "e2ee:sync-ready",
  E2EE_SYNC_REQUESTED: "e2ee:sync-requested",
  // Epoch-key backfill: a device that can't decrypt a GROUP conversation (keyGone
  // — it never received the epoch key, e.g. approved after the epoch was minted or
  // FK-skipped) asks online MEMBERS to re-wrap the existing epoch key to it; the
  // member does so and the server pushes E2EE_KEYS_UPDATED so it re-decrypts now.
  E2EE_EPOCH_REKEY_REQUEST: "e2ee:epoch-rekey-request",
  E2EE_KEYS_UPDATED: "e2ee:keys-updated",
  // Sender re-delivery: a device that cannot open a DM envelope asks the
  // original sender's devices to seal that message to it again; the server
  // appends the envelope and tells the requester's devices to re-read.
  E2EE_REDELIVER_REQUEST: "e2ee:redeliver-request",
  E2EE_REDELIVERED: "e2ee:redelivered",
  READY: "ready",
};
export function connectSocket(token) {
  // An empty socketUrl means SAME-ORIGIN: io(undefined) connects to the page's
  // own origin, and Next reverse-proxies /socket.io to the backend. Falling back
  // to undefined (not "") is important — socket.io treats "" inconsistently.
  // A socketUrl WITH a path prefix (API fronted at https://host/prefix, e.g. an edge
  // worker) must not be passed to io() as-is: socket.io reads the path as a
  // NAMESPACE, so the connect would never match. Split it into origin + engine
  // path (/prefix/socket.io/). With no prefix this resolves to the default.
  let ioTarget: string | undefined = config.socketUrl || undefined;
  let ioPath = "/socket.io/";
  if (config.socketUrl) {
    try {
      const u = new URL(config.socketUrl);
      ioTarget = u.origin;
      ioPath = u.pathname.replace(/\/+$/, "") + "/socket.io/";
    } catch (_) {
      /* not an absolute URL — leave as given */
    }
  }
  const socket = io(ioTarget, {
    path: ioPath,
    auth: { token },
    // POLLING FIRST, then upgrade to WebSocket. In the same-origin setup the
    // socket is proxied through the Next server, whose dev rewrites can carry
    // HTTP long-poll but CANNOT proxy a raw WebSocket upgrade — so a
    // websocket-first client (with socket.io's default tryAllTransports=false)
    // failed to connect at all and timed out, which is why call recipients
    // received nothing. Connecting via polling guarantees the socket comes up;
    // Engine.IO then opportunistically upgrades to WebSocket where the proxy
    // supports it (e.g. nginx in prod) and silently stays on polling where it
    // doesn't (Next dev). tryAllTransports also lets it fall through if the
    // first transport ever fails.
    //
    // NEXT_PUBLIC_WS_FIRST=1 (set by the Cloudflare `cf:build`, where the Worker
    // proxies the upgrade and every long-poll is a cross-continent round trip)
    // tries WebSocket first and only falls back to polling if that fails — the
    // socket is live about a second sooner and never spends its first seconds
    // long-polling through the edge.
    transports: process.env.NEXT_PUBLIC_WS_FIRST === "1" ? ["websocket", "polling"] : ["polling", "websocket"],
    tryAllTransports: true,
    reconnection: true,
  });
  // Base diagnostics — realtime connection lifecycle. The in-app Diagnostics
  // panel + DevTools console both surface these, so a dropped live channel is
  // obvious instead of silent.
  //
  // Transient reconnects are NORMAL: a laptop sleeping, wifi hopping, or a
  // backend redeploy all drop the socket, and socket.io fires connect_error on
  // EVERY failed retry attempt. Logging each one at error level flooded the ops
  // board — a single user on a WebSocket-hostile proxy could post hundreds of
  // identical "Realtime connect failed" rows. Gate it: count consecutive
  // failures, keep the early ones at WARN (diagnostics-only, NOT escalated to
  // telemetry), and raise a SINGLE error once the failure is clearly sustained.
  // The counter resets the moment we (re)connect.
  let connectErrCount = 0;
  const ESCALATE_AT = 4; // aligns with the in-app "Realtime connection problem" toast
  socket.on("connect", () => {
    connectErrCount = 0;
    log.success("realtime", "Realtime connected", {
      hint: "Live messages, calls and presence are active.",
    });
  });
  socket.on("disconnect", (reason: string) =>
    log.warn("realtime", `Realtime disconnected (${reason})`, {
      hint:
        reason === "io server disconnect"
          ? "The server closed the connection — reconnecting…"
          : "Connection dropped — reconnecting automatically.",
    }),
  );
  socket.on("connect_error", (e: any) => {
    connectErrCount += 1;
    const msg = `Realtime connect failed: ${(e && e.message) || e}`;
    const hint =
      "The live channel can't reach the server — real-time updates and calls are paused. Check the network/proxy; it keeps retrying.";
    if (connectErrCount < ESCALATE_AT) {
      // Early attempts: diagnostics-only; never reaches the error board.
      log.warn("realtime", msg, { hint });
    } else if (connectErrCount === ESCALATE_AT) {
      // Sustained: escalate exactly ONCE so the operator sees one real signal
      // instead of a per-attempt storm. Stays silent afterwards until we reset.
      log.error("realtime", msg, { hint });
    }
  });
  socket.io.on("reconnect", (n: number) => {
    connectErrCount = 0;
    log.success("realtime", `Realtime reconnected (attempt ${n})`);
  });
  return socket;
}
