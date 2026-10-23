// Per-meeting options — the policy layer above the host controls.
//
// ONE source of truth. Both places that decide what a participant may publish
// read `effectiveSources` from here:
//
//   • POST /api/calls/token   — bakes the grant at join time.
//   • setOptions()            — re-permissions people ALREADY connected, live.
//
// They must never disagree. If they did, a host who tightened a policy would
// see it apply to late joiners and not to the people already in the room —
// exactly the inconsistency this module exists to prevent. Keep the decision
// in this function; callers only supply the meeting and the role.

import { restrictionsOf } from "./participantRestrictions";

export type LobbyPolicy = "everyone" | "invited" | "nobody";

export interface MeetingOptions {
  lobbyPolicy: LobbyPolicy;
  allowMic: boolean;
  allowCamera: boolean;
  allowChat: boolean;
  allowReactions: boolean;
  // Set from the /admin portal only — deliberately absent from normalizePatch, so
  // a host cannot switch back on a whiteboard an administrator shut down.
  allowWhiteboard: boolean;
  // Host Settings modal (0134). Both are written ONLY through the host-only
  // controls route — deliberately absent from normalizePatch, so a co-host
  // using the general options panel cannot flip them.
  //
  // allowScreenShare: may attendees present? (hosts/co-hosts always can)
  // hostAllowWhiteboard: the HOST's whiteboard switch. Separate from
  //   allowWhiteboard above so the host can never re-enable a board an
  //   administrator shut down — the board is on only when BOTH are on. Like
  //   the admin's, it applies to everyone, host included.
  allowScreenShare: boolean;
  hostAllowWhiteboard: boolean;
  autoRecord: boolean;
}

// Defaults mirror the SQL column defaults exactly (migration 0116), so a
// meeting created before this feature — or a driver row missing the fields —
// behaves precisely as meetings did before: no lobby, everything allowed.
export const OPTION_DEFAULTS: MeetingOptions = {
  lobbyPolicy: "everyone",
  allowMic: true,
  allowCamera: true,
  allowChat: true,
  allowReactions: true,
  allowWhiteboard: true,
  allowScreenShare: true,
  hostAllowWhiteboard: true,
  autoRecord: false,
};

const LOBBY_VALUES: LobbyPolicy[] = ["everyone", "invited", "nobody"];

// Read the options off a meeting row, filling anything absent with the default.
export function optionsOf(meeting: any): MeetingOptions {
  if (!meeting) return { ...OPTION_DEFAULTS };
  const lobbyPolicy = LOBBY_VALUES.includes(meeting.lobbyPolicy)
    ? meeting.lobbyPolicy
    : // Fall back to the legacy boolean if the policy column is missing or junk,
      // so a half-migrated row still behaves sensibly rather than silently
      // dropping a lobby the host had switched on.
      meeting.lobbyEnabled
      ? "nobody"
      : "everyone";
  return {
    lobbyPolicy,
    allowMic: meeting.allowMic == null ? OPTION_DEFAULTS.allowMic : !!meeting.allowMic,
    allowCamera: meeting.allowCamera == null ? OPTION_DEFAULTS.allowCamera : !!meeting.allowCamera,
    allowChat: meeting.allowChat == null ? OPTION_DEFAULTS.allowChat : !!meeting.allowChat,
    allowReactions:
      meeting.allowReactions == null ? OPTION_DEFAULTS.allowReactions : !!meeting.allowReactions,
    allowWhiteboard:
      meeting.allowWhiteboard == null ? OPTION_DEFAULTS.allowWhiteboard : !!meeting.allowWhiteboard,
    allowScreenShare:
      meeting.allowScreenShare == null ? OPTION_DEFAULTS.allowScreenShare : !!meeting.allowScreenShare,
    hostAllowWhiteboard:
      meeting.hostAllowWhiteboard == null
        ? OPTION_DEFAULTS.hostAllowWhiteboard
        : !!meeting.hostAllowWhiteboard,
    autoRecord: !!meeting.autoRecord,
  };
}

// Validate a client-supplied patch. Unknown keys are dropped and bad values are
// rejected with a 400 rather than silently coerced — a host who mistypes a
// policy should be told, not given a meeting that is subtly wrong.
export function normalizePatch(raw: any): Partial<MeetingOptions> {
  const patch: Partial<MeetingOptions> = {};
  if (!raw || typeof raw !== "object") return patch;
  const bad = (m: string) => {
    const e: any = new Error(m);
    e.status = 400;
    e.code = "BAD_REQUEST";
    throw e;
  };
  if (raw.lobbyPolicy !== undefined) {
    if (!LOBBY_VALUES.includes(raw.lobbyPolicy))
      bad('lobbyPolicy must be "everyone", "invited" or "nobody".');
    patch.lobbyPolicy = raw.lobbyPolicy;
  }
  for (const k of ["allowMic", "allowCamera", "allowChat", "allowReactions", "autoRecord"] as const) {
    if (raw[k] !== undefined) {
      if (typeof raw[k] !== "boolean") bad(`${k} must be true or false.`);
      patch[k] = raw[k];
    }
  }
  return patch;
}

// THE decision. What may this participant publish?
//
// Hosts and co-hosts are never restricted — a policy is something they impose,
// not something they can lock themselves out with. (A host who disallows the
// microphone and then cannot unmute themselves would be a support ticket, and
// worse, there would be no way to undo it from inside the meeting.)
//
// Two layers apply to everyone else, and a source must pass BOTH:
//   • the meeting-wide switch (allowCamera / allowMic / allowScreenShare)
//   • the host's per-person restriction (cameraBlocked / screenShareBlocked),
//     passed by the caller from services/participantRestrictions
export function effectiveSources(
  meeting: any,
  opts: {
    isHost: boolean;
    isCoHost: boolean;
    cameraBlocked?: boolean;
    screenShareBlocked?: boolean;
  },
): string[] {
  if (opts.isHost || opts.isCoHost)
    return ["camera", "microphone", "screen_share", "screen_share_audio"];
  const o = optionsOf(meeting);
  const sources: string[] = [];
  if (o.allowScreenShare && !opts.screenShareBlocked)
    sources.push("screen_share", "screen_share_audio");
  if (o.allowCamera && !opts.cameraBlocked) sources.push("camera");
  if (o.allowMic) sources.push("microphone");
  return sources;
}

// An attendee with NO permitted sources is still a valid participant — they can
// see and hear the meeting, they simply cannot publish. LiveKit needs
// canPublish:false for that case, because an empty canPublishSources array is
// treated as "no restriction" (see roomToken's ALL_TRACK_SOURCES fallback), and
// passing it would silently grant everything — the exact opposite of intent.
export function effectiveGrant(
  meeting: any,
  opts: Parameters<typeof effectiveSources>[1],
) {
  const sources = effectiveSources(meeting, opts);
  return sources.length
    ? { canPublish: true, canPublishSources: sources }
    : { canPublish: false, canPublishSources: [] as string[] };
}

// Does the lobby hold this person? Host and co-host always bypass.
export function mustWaitInLobby(
  meeting: any,
  opts: { isHost: boolean; isCoHost: boolean; isInvited: boolean },
): boolean {
  if (opts.isHost || opts.isCoHost) return false;
  const { lobbyPolicy } = optionsOf(meeting);
  if (lobbyPolicy === "everyone") return false;
  if (lobbyPolicy === "nobody") return true;
  return !opts.isInvited; // 'invited' — on the invite list joins directly
}

// The grant for ONE person in ONE meeting, with the host's per-person
// restrictions folded in. Every call site that mints or rewrites a LiveKit
// permission (token route, external API, live re-permission) goes through this,
// so none of them can forget the restrictions and hand a blocked person their
// camera or screen share back.
export function grantForUser(
  meeting: any,
  userId: string,
  opts: { isHost: boolean; isCoHost: boolean },
) {
  const r = restrictionsOf(meeting?.id, userId);
  return effectiveGrant(meeting, { ...opts, ...r });
}
