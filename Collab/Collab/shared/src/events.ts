// Canonical Socket.IO event names — single source of truth for realtime contracts.
// client -> server
export const CONVERSATION_JOIN = "conversation:join";
export const MESSAGE_SEND = "message:send";
export const MESSAGE_REACT = "message:react";
export const TYPING_START = "typing:start";
export const TYPING_STOP = "typing:stop";
// server -> client
export const MESSAGE_NEW = "message:new";
export const MESSAGE_UPDATED = "message:updated";
export const MESSAGE_DELETED = "message:deleted";
export const MESSAGE_READ = "message:read";
export const MESSAGE_REPLY = "message:reply";
export const TASK_CHANGED = "task:changed";
export const REMINDER_CHANGED = "reminder:changed";
export const CONVERSATION_NEW = "conversation:new";
export const CONVERSATION_UPDATED = "conversation:updated";
export const CONVERSATION_DELETED = "conversation:deleted";
// A conversation's unread changed for THIS user (they read / marked-unread it on
// some device). Broadcast to the user's own room so every session (web + desktop)
// updates its unread count + badge live — independent of read-receipts.
export const CONVERSATION_READ = "conversation:read";
// A user's public profile changed (avatar / name / about). Broadcast so every
// client refreshes that person's avatar/name everywhere, instantly.
export const USER_UPDATED = "user:updated";
export const MEETING_NEW = "meeting:new";
export const MEETING_PRESENCE = "meeting:presence";
// Client-emitted on entering a meeting so the server joins the per-meeting
// room. Without this, a user who only listens (never raises hand / reacts /
// chats) never gets joined to the room and therefore never receives meeting
// chat — making the chat panel look "broken" until the first send.
export const MEETING_JOIN = "meeting:join";
export const MEETING_UPDATED = "meeting:updated";
// A host muted this user's microphone (meeting or call). The SFU mute alone is
// not enough: it silences the person for everyone else, but their OWN client is
// not reliably told, so their mic button and tile kept showing "live" while
// nobody could hear them. This tells the muted client directly, so it can mute
// locally and say what happened. Payload: { scope: "meeting" | "call", id, by }.
export const MEDIA_FORCE_MUTE = "media:force_mute";
// An administrator stopped this user's screen share from the /admin portal. The
// SFU mute blanks the share for viewers; this tells the sharer's OWN client to
// stop capturing and say why. Payload: { scope: "meeting", id, by }.
export const MEDIA_FORCE_STOP_SCREEN = "media:force_stop_screen";
// An administrator turned this user's camera off. Same reasoning as above: the
// SFU mute blanks the video for viewers, this tells the owner's own client.
export const MEDIA_FORCE_CAMERA_OFF = "media:force_camera_off";
// An administrator blocked / unblocked the whiteboard for THIS user only (the
// meeting-wide switch rides MEETING_OPTIONS). Payload: { meetingId, blocked }.
export const MEETING_WHITEBOARD_ACCESS = "meeting:whiteboard_access";
// The meeting HOST changed what THIS user may do (camera / screen share /
// whiteboard) from the Settings modal. Sent to that user only; the meeting-wide
// switches ride MEETING_OPTIONS.
// Payload: { meetingId, cameraBlocked, screenShareBlocked, whiteboardBlocked, by }.
export const MEETING_PARTICIPANT_PERMISSIONS = "meeting:participant_permissions";
export const MEETING_LOBBY_UPDATE = "meeting:lobby:update";
// Per-meeting options changed (0116). Carries the new policy to everyone in
// the room so their controls re-render without polling.
export const MEETING_OPTIONS = "meeting:options";
// Meeting polls (0121). One event for every change — created, voted on,
// closed, deleted — carrying the poll's full current state, so a client never
// has to reconcile a partial update against what it already had.
export const MEETING_POLL = "meeting:poll";
export const MEETING_POLL_REMOVED = "meeting:poll:removed";
export const PRESENCE_UPDATE = "presence:update";
export const TYPING = "typing";
// calls — lifecycle signalling over sockets (media transport is a separate build)
// client -> server
export const CALL_REQUEST = "call:request";
export const CALL_ACCEPT = "call:accept";
export const CALL_DECLINE = "call:decline";
export const CALL_CANCEL = "call:cancel";
export const CALL_HANGUP = "call:hangup";
// server -> client
export const CALL_INCOMING = "call:incoming";
export const CALL_RINGING = "call:ringing";
export const CALL_ACCEPTED = "call:accepted";
export const CALL_DECLINED = "call:declined";
export const CALL_CANCELLED = "call:cancelled";
export const CALL_ENDED = "call:ended";
export const CALL_MISSED = "call:missed";
export const CALL_BUSY = "call:busy";
export const CALL_NEW = "call:new";
// A 1:1 call was promoted to a group call: the other party auto-migrates from the
// "call_<id>" room to the new "conv_<id>" group room (new invitees are rung
// separately via HUDDLE_RING).
export const CALL_UPGRADED = "call:upgraded";

// group calls ("huddles") over the LiveKit SFU
export const HUDDLE_JOIN = "huddle:join";
export const HUDDLE_LEAVE = "huddle:leave";
export const HUDDLE_SYNC = "huddle:sync";
export const HUDDLE_STATE = "huddle:state";
// Pull people into an active group call: client asks the server to ring the
// given members (RING), and each invitee receives a notification (RUNG).
export const HUDDLE_RING = "huddle:ring";
export const HUDDLE_RUNG = "huddle:rung";
// invites (connection requests)
export const INVITE_NEW = "invite:new";
export const INVITE_UPDATED = "invite:updated";
// scheduled messages: a sender's pending/sent/failed scheduled list changed
export const SCHEDULED_CHANGED = "scheduled:changed";
// notifications
export const NOTIFICATION_NEW = "notification:new";
export const NOTIFICATION_READ = "notification:read";
export const NOTIFICATION_COUNT = "notification:count";
// files — a file the recipient can see was shared/updated; refetch the files list.
export const FILE_CHANGED = "file:changed";
// meeting interactions (hand raise, reactions)
export const MEETING_HAND_RAISE = "meeting:hand:raise";
export const MEETING_HAND_LOWER = "meeting:hand:lower";
export const MEETING_HAND_STATE = "meeting:hand:state";
export const MEETING_REACTION = "meeting:reaction";
export const MEETING_REACTION_BROADCAST = "meeting:reaction:broadcast";
// meeting chat (piggybacks existing message system via conversationId)
export const MEETING_CHAT_SEND = "meeting:chat:send";
export const MEETING_CHAT_NEW = "meeting:chat:new";
// Meeting duplicate-device prompt (Session Mgmt Phase 3c): when a user joins a
// meeting they're already in on ANOTHER device (session), the server tells the
// JOINING device (MEETING_DUPLICATE) so it can offer move / companion / cancel.
// "Move here" emits MEETING_TAKEOVER → the server tells the user's OTHER devices
// in that meeting to leave (MEETING_LEAVE_NOW). Same-session tabs are NOT dupes.
export const MEETING_DUPLICATE = "meeting:duplicate"; // server → joining device
export const MEETING_TAKEOVER = "meeting:takeover"; // device → server ("move here")
export const MEETING_LEAVE_NOW = "meeting:leave_now"; // server → other devices
// Device handoff (P0-12): move / extend an active call or meeting to another of
// the SAME user's signed-in devices. Session-scoped (room "session:<jti>").
export const DEVICES_LIST = "devices:list"; // ack: caller's devices + online
export const HANDOFF_REQUEST = "handoff:request"; // source → server
export const HANDOFF_OFFER = "handoff:offer"; // server → target device
export const HANDOFF_ACCEPT = "handoff:accept"; // target → server
export const HANDOFF_DECLINE = "handoff:decline"; // target → server
export const HANDOFF_CONFIRMED = "handoff:confirmed"; // server → source
export const HANDOFF_DECLINED = "handoff:declined"; // server → source
// Live session enforcement (Session Mgmt Phase 3): the server tells a specific
// signed-in device that its session was revoked (self "sign out this device",
// "sign out other sessions", admin force-logout, or eviction at the device
// limit). The client clears its token and returns to sign-in. Server closes the
// socket right after, so a revoked session can't keep a live channel open until
// it happens to reconnect (REST is already cut by the per-request #66 check).
export const SESSION_REVOKED = "session:revoked"; // server → device
// Org membership enforcement: this account's membership in an organization
// ended (removed by an admin, or they left). Sent to the user's devices right
// after the server purges their org-scoped conversation access; the client
// re-validates its session and pivots away via the existing org-invalid
// recovery. Their live sockets are also force-ejected from every org
// conversation room server-side, so realtime delivery stops immediately.
export const ORG_MEMBERSHIP_REVOKED = "org:membership-revoked"; // server → user's devices
// E2EE live sync choreography (kills "[Encrypted — not available on this
// device]" walls): a newly APPROVED device triggers the user's other devices
// to push it an encrypted history bundle immediately (not on their next page
// load); SYNC_READY tells the target device its bundle is waiting on the
// relay; SYNC_REQUESTED is the on-demand heal — a device that rendered an
// unreadable message asks its siblings for that conversation's history.
export const E2EE_DEVICE_APPROVED = "e2ee:device-approved"; // server → user's devices
export const E2EE_SYNC_READY = "e2ee:sync-ready"; // server → user's devices
export const E2EE_SYNC_REQUESTED = "e2ee:sync-requested"; // server → user's devices
// Epoch-key backfill for a GROUP conversation a device can't decrypt (keyGone).
// REKEY_REQUEST: server → the conversation ROOM (its online members) so a member
// re-wraps the existing epoch key to the requesting device. KEYS_UPDATED: server →
// the recipient's devices after new conversation keys are stored, so a stuck
// conversation re-decrypts immediately instead of on the next reload.
export const E2EE_EPOCH_REKEY_REQUEST = "e2ee:epoch-rekey-request"; // server → conversation room
export const E2EE_KEYS_UPDATED = "e2ee:keys-updated"; // server → recipient's devices
// Sender re-delivery (the Signal "retry receipt" idea): a device that cannot open
// a DM envelope asks the ORIGINAL SENDER's devices to seal that message to it
// again from their plaintext copy; the server appends the new envelope to the
// message and tells the requester's devices to re-read it.
export const E2EE_REDELIVER_REQUEST = "e2ee:redeliver-request"; // server → sender's devices
export const E2EE_REDELIVERED = "e2ee:redelivered"; // server → requester's devices
export const READY = "ready";
