// Unified Connector Engine — infinite-loop (echo) prevention.
//
// A bridged channel is a feedback loop waiting to happen: CoLab posts to Slack,
// Slack's Events API tells us "a message was posted", we post it to CoLab, which
// posts it to Slack… Three independent lines of defence, each enough alone:
//
//   1. ORIGIN FILTER (this file, pure): drop any inbound event whose author is
//      one of OUR OWN registered bot/app identities on that platform.
//   2. MESSAGE MAPPING (durable, in the driver): every message we post outward
//      is recorded with its external id; an inbound event for an id we already
//      know is our own echo and is dropped — even if the platform's bot flag is
//      missing (Slack `message_changed` sub-events, WhatsApp status callbacks).
//   3. SOURCE EXCLUSION (engine): a message that ARRIVED through mapping X is
//      never dispatched back out through mapping X (it still goes to every
//      OTHER mapping on the conversation — that is the multi-platform bridge).
//
// PURE so the policy is unit-testable without a database.

interface OriginCheckInput {
  senderId?: string | null;
  botId?: string | null;
  isBot?: boolean;
}

// Spec-shaped helper: the registered bot ids for a platform are the account's
// `bot_ids` list (a Slack app has both a bot user id AND an app/bot id, so this
// is a list rather than one value).
export function verifyEventOrigin(payload: OriginCheckInput, registeredBotIds: readonly string[]): boolean {
  const ids = new Set((registeredBotIds || []).map((s) => String(s).trim()).filter(Boolean));
  const sender = payload.senderId ? String(payload.senderId).trim() : "";
  const bot = payload.botId ? String(payload.botId).trim() : "";
  if (sender && ids.has(sender)) return false;
  if (bot && ids.has(bot)) return false;
  return true;
}

// Reason string for the operator log when an event is dropped.
export function originDropReason(payload: OriginCheckInput, registeredBotIds: readonly string[]): string | null {
  if (verifyEventOrigin(payload, registeredBotIds)) return null;
  return `author ${payload.botId || payload.senderId} is this connector's own bot`;
}
