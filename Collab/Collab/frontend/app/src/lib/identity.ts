// Canonical identity helper. The logged-in user's id (`selfId`) is the single
// source of truth for "who am I" — never a hardcoded seed id like "u_you".
//
// The other participant of a 1:1 conversation, relative to the current user.
// Returns null if there is no distinct other member. Used to resolve the
// callee's id (peerId) so it ALWAYS equals the room that user's socket joined,
// in both directions (the bug was deriving this against a fixed "u_you").
export function otherMemberId(
  members: string[] | undefined | null,
  selfId: string | undefined | null,
): string | null {
  return (members || []).find((m) => m && m !== selfId) || null;
}
