// Per-person camera / screen-share restrictions set by the meeting host.
//
// Same shape and the same trade-off as whiteboardAccess.ts (which holds the
// per-person whiteboard block): a live-session moderation action, held in memory,
// no migration. A backend restart restores the default (everyone may use
// everything); the meeting-wide switches are persisted columns and unaffected.
//
// What makes this enforceable rather than cosmetic is that the token route and
// the live re-permission path both read these through meetingPolicy.effectiveGrant,
// so a restricted person who reloads the tab is handed a token that STILL refuses
// the source — they cannot dodge a restriction by rejoining.
const cameraBlocked = new Map<string, Set<string>>();
const screenShareBlocked = new Map<string, Set<string>>();

function has(map: Map<string, Set<string>>, meetingId: string, userId: string) {
  return !!map.get(meetingId)?.has(userId);
}

function put(map: Map<string, Set<string>>, meetingId: string, userId: string, on: boolean) {
  let set = map.get(meetingId);
  if (on) {
    if (!set) map.set(meetingId, (set = new Set()));
    set.add(userId);
  } else if (set) {
    set.delete(userId);
    if (!set.size) map.delete(meetingId);
  }
}

export function restrictionsOf(meetingId: string, userId: string) {
  return {
    cameraBlocked: has(cameraBlocked, meetingId, userId),
    screenShareBlocked: has(screenShareBlocked, meetingId, userId),
  };
}

export function setCameraBlocked(meetingId: string, userId: string, on: boolean) {
  put(cameraBlocked, meetingId, userId, on);
}

export function setScreenShareBlocked(meetingId: string, userId: string, on: boolean) {
  put(screenShareBlocked, meetingId, userId, on);
}

// Every person with at least one camera / screen-share restriction in a meeting,
// so the host's Settings modal can show current state when it opens.
export function restrictedUserIds(meetingId: string): string[] {
  return [
    ...new Set([
      ...(cameraBlocked.get(meetingId) || []),
      ...(screenShareBlocked.get(meetingId) || []),
    ]),
  ];
}
