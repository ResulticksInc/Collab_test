// Per-user whiteboard blocks, set from the /admin portal or by the meeting host.
//
// The meeting-wide switch is a persisted column (0133). This is the finer
// control — "this one person may not use the whiteboard" — and it is held in
// memory on purpose: it is a live-session moderation action, it needs no
// migration, and a backend restart clearing it simply restores the default
// (everyone may use the board). The meeting-wide switch is unaffected.
const blocked = new Map<string, Set<string>>();

export function isWhiteboardBlocked(meetingId: string, userId: string): boolean {
  return !!blocked.get(meetingId)?.has(userId);
}

export function setWhiteboardBlocked(meetingId: string, userId: string, on: boolean): void {
  let set = blocked.get(meetingId);
  if (on) {
    if (!set) blocked.set(meetingId, (set = new Set()));
    set.add(userId);
  } else if (set) {
    set.delete(userId);
    if (!set.size) blocked.delete(meetingId);
  }
}

// Everyone blocked from the whiteboard in a meeting (admin- or host-set — it is
// one flag), for the host's Settings modal.
export function whiteboardBlockedUserIds(meetingId: string): string[] {
  return [...(blocked.get(meetingId) || [])];
}
