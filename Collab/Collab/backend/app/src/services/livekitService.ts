import { AccessToken, TrackSource } from "livekit-server-sdk";
import { randomUUID } from "crypto";
import { config } from "../platform";

const ALL_TRACK_SOURCES = [
  TrackSource.CAMERA,
  TrackSource.MICROPHONE,
  TrackSource.SCREEN_SHARE,
  TrackSource.SCREEN_SHARE_AUDIO,
];

function toTrackSource(s: any): TrackSource {
  if (typeof s === "number") return s;
  const str = String(s).toLowerCase();
  if (str === "camera") return TrackSource.CAMERA;
  if (str === "microphone") return TrackSource.MICROPHONE;
  if (str === "screen_share") return TrackSource.SCREEN_SHARE;
  if (str === "screen_share_audio") return TrackSource.SCREEN_SHARE_AUDIO;
  return TrackSource.UNKNOWN;
}

// LiveKit room identity scheme: "<userId>__<perJoinUUID>".
//   - Per-join suffix → DUPLICATE_IDENTITY (LiveKit's "kick the existing
//     participant with the same identity") only fires when the user OPENS
//     A SECOND TAB / DEVICE for the SAME call, which is the intended UX,
//     not a bug. Without this, an honest reload caused DUPLICATE_IDENTITY
//     because the old socket hadn't yet been GC'd at the SFU.
//   - Host controls (remove/mute) operate on identity. They get the user's
//     PREFIX (everything before "__") from the room's participant list and
//     act on the live identity that matches, so the UUID is irrelevant to
//     the operator's mental model — they pick "Alice", we resolve "Alice"
//     to her current __<UUID> tail and kick that.
const IDENT_SEP = "__";
function makeIdentity(userId: string) {
  return userId + IDENT_SEP + randomUUID();
}
function baseUserId(identity: string) {
  // lastIndexOf, NOT indexOf: a userId can itself contain "__" (authService
  // mints ids of the form "<slice>_<hash>" and the slice can end in "_"), and
  // the per-join UUID never does. Splitting on the FIRST separator truncated
  // such a user's id, so host controls resolved the wrong id — the actor was
  // no longer excluded from mute-all, and the force-mute notification was sent
  // to a room nobody is in, leaving that person muted with a mic button still
  // showing "live".
  const i = identity.lastIndexOf(IDENT_SEP);
  return i === -1 ? identity : identity.slice(0, i);
}
// Returns the LIVE "userId__<uuid>" identity for a user, plus whether the SFU
// answered at all. Callers need that second value: an unreachable SFU used to be
// indistinguishable from "the user isn't in the room", so every host control
// reported success while doing nothing.
async function findLiveIdentity(
  client: any,
  room: string,
  userId: string,
): Promise<{ identity: string | null; sfuReachable: boolean }> {
  let sfuReachable = true;
  const list = await client.listParticipants(room).catch(() => {
    sfuReachable = false;
    return [];
  });
  for (const p of list || []) {
    const id = p && p.identity;
    if (id && baseUserId(id) === userId) return { identity: id, sfuReachable };
  }
  return { identity: null, sfuReachable };
}

// Who is ACTUALLY connected to a LiveKit room right now, as bare user ids. `reachable`
// is false when the SFU didn't answer — callers must treat that as "unknown", never
// as "nobody is there" (an outage must not look like everyone left).
async function listRoomUserIds(room: string): Promise<{ reachable: boolean; userIds: Set<string> }> {
  try {
    const client = await roomService();
    const list: any[] = await client.listParticipants(room);
    const userIds = new Set<string>();
    for (const p of list || []) if (p && p.identity) userIds.add(baseUserId(p.identity));
    return { reachable: true, userIds };
  } catch (e: any) {
    // LiveKit answers "room does not exist" (404) once a room is empty and reaped —
    // that IS a definitive "nobody is connected", unlike a network failure.
    const msg = String((e && (e.message || e.code || e.status)) || "");
    if (/not.?found|does not exist|404/i.test(msg)) return { reachable: true, userIds: new Set() };
    return { reachable: false, userIds: new Set() };
  }
}

function livekitHost() {
  return config.livekit.serverUrl.replace(/^ws(s?):\/\//, "http$1://");
}

async function roomService() {
  const sdk: any = await import("livekit-server-sdk");
  return new sdk.RoomServiceClient(
    livekitHost(),
    config.livekit.apiKey,
    config.livekit.apiSecret,
  );
}

// Mint a LiveKit room access token for a user. It is a JWT signed with the
// LiveKit API secret; the LiveKit SFU validates it on connect. Authorization
// (conversation/call membership) is enforced by the caller BEFORE minting —
// this function assumes the user is already allowed into `room`.
async function roomToken({
  userId,
  name,
  room,
  role = "participant",
  canPublish = true,
  canPublishSources,
  wsUrl,
  avatarUrl,
}: {
  userId: string;
  name?: string;
  // Public, versioned avatar URL (serialize.userAvatarUrl). Rides in the
  // participant METADATA so every client in the room can show the photo on a
  // camera-off tile — LiveKit only carries identity + name otherwise, which is
  // why meeting/call tiles could only ever draw initials.
  avatarUrl?: string | null;
  room: string;
  role?: string;
  canPublish?: boolean;
  canPublishSources?: any[];
  // Browser-facing signalling URL. When omitted we fall back to the configured
  // LIVEKIT_WS_URL. The calls route passes a value derived from the request
  // origin (wss://<host>/livekit) when running behind a TLS front, so the token
  // always carries a URL the browser can actually reach — no matter what host,
  // IP, or domain the deployment lives on (see routes/calls.ts publicWsUrl()).
  wsUrl?: string;
}) {
  const at = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
    identity: makeIdentity(userId),
    name: name || userId,
    ttl: config.livekit.tokenTtlSec,
    // `role` is server-decided and signed: clients use it to decide whose
    // view-control messages (spotlight) to honour. Participants cannot rewrite
    // their own metadata (no canUpdateOwnMetadata grant).
    metadata: JSON.stringify({ avatarUrl: avatarUrl || null, role: role || "participant" }),
  });

  // An EMPTY sources list means "no restriction" to LiveKit, so the historic
  // fallback below grants everything — right for calls, which pass nothing, but
  // wrong for a meeting attendee whose policy permits no source at all. Gate the
  // fallback on canPublish so a fully-restricted participant's token says so
  // plainly instead of relying on canPublish:false to override a grant that
  // claims every source. (Per-meeting options, 0116.)
  const effectivePublishSources = canPublishSources && canPublishSources.length
    ? canPublishSources.map(toTrackSource)
    : canPublish
      ? ALL_TRACK_SOURCES
      : [];

  at.addGrant({
    roomJoin: true,
    room,
    canPublish,
    canPublishSources: effectivePublishSources,
    canSubscribe: true,
    canPublishData: true,
    roomAdmin: role === "host",
  });
  // Advertise the self-hosted TURN relay (coturn) to the browser so off-LAN /
  // global clients that can't reach the SFU's node_ip directly relay media over
  // turns://<domain>:443 (TLS) instead of a raw IP. Omitted when TURN isn't
  // configured (internal/LAN-only deploys). ICE still tries a direct path first
  // and only falls back to the relay, so on-network calls are unaffected.
  const turn: any = (config as any).turn;
  const iceServers =
    turn && Array.isArray(turn.urls) && turn.urls.length
      ? [
          {
            urls: turn.urls,
            username: turn.username || undefined,
            credential: turn.password || undefined,
          },
        ]
      : undefined;
  return {
    token: await at.toJwt(),
    wsUrl: wsUrl || config.livekit.wsUrl,
    room,
    role,
    iceServers,
  };
}

// Host-control identity resolution: the operator passes the USER ID
// ("u_alice"); we look up the live SFU identity ("u_alice__<uuid>") and
// act on it. If the user is not in the room we no-op gracefully (returns
// inRoom:false). This keeps host controls working with the per-join UUID
// scheme above — without it, every remove/mute would no-op because the
// SFU has no participant whose identity is just "u_alice".
async function removeParticipant(room: string, userId: string) {
  const client = await roomService();
  const { identity: liveIdent, sfuReachable } = await findLiveIdentity(client, room, userId);
  if (!liveIdent) return { room, userId, removed: false, inRoom: false, sfuReachable };
  await client.removeParticipant(room, liveIdent);
  return { room, userId, identity: liveIdent, removed: true, inRoom: true, sfuReachable };
}

// Evict any EXISTING participant(s) of this user from the room before a FRESH join,
// so a second tab/device REPLACES the prior session instead of the same person
// showing up twice (one active session per user — Zoom/Teams behaviour). The new
// session's identity is minted AFTER this runs, so it is never self-evicted. FAIL-SOFT
// throughout: LiveKit unreachable / room-not-yet-created / a remove error all no-op,
// and the caller mints the join token regardless — so at worst a duplicate lingers
// (today's behaviour), never a blocked or broken join.
async function evictPriorSessions(room: string, userId: string) {
  try {
    const client = await roomService();
    const list = await client.listParticipants(room).catch(() => []);
    for (const p of list || []) {
      const id = p && p.identity;
      if (id && baseUserId(id) === userId)
        await client.removeParticipant(room, id).catch(() => {});
    }
  } catch (_) {
    /* nothing to evict / SFU unreachable → the fresh join still proceeds */
  }
}

// Host "End for everyone": delete the SFU room, which disconnects EVERY
// participant at once (each client fires RoomEvent.Disconnected with reason
// ROOM_DELETED and leaves — see MeetingStage). Best-effort: if the SFU is
// unreachable or the room is already gone, the caller (which already updated the
// DB + notified clients) proceeds regardless, so "end" never hangs on the SFU.
async function deleteRoom(room: string) {
  // The room is over — its self-mute intents (MIC-02) are dead weight.
  for (const k of selfMuteIntents.keys())
    if (k.startsWith(room + "|")) selfMuteIntents.delete(k);
  try {
    const client = await roomService();
    await client.deleteRoom(room);
    return { room, deleted: true };
  } catch (_) {
    return { room, deleted: false };
  }
}

// Ground-truth liveness for a call/meeting room: is anyone actually in it? Used
// to reap "ghost" calls whose DB row is stuck non-terminal because both parties
// left ungracefully (closed tab / crash) so neither CALL_HANGUP nor a socket
// disconnect fired. FAIL-SAFE: only reports empty:true when the SFU CONFIRMS zero
// participants — an unreachable SFU returns sfuReachable:false so callers never
// reap a call they couldn't verify was actually dead.
async function roomIsEmpty(
  room: string,
): Promise<{ empty: boolean; sfuReachable: boolean }> {
  try {
    const client = await roomService();
    let sfuReachable = true;
    const list = await client.listParticipants(room).catch(() => {
      sfuReachable = false;
      return null;
    });
    if (!sfuReachable) return { empty: false, sfuReachable: false };
    return { empty: !list || (list as any[]).length === 0, sfuReachable: true };
  } catch (_) {
    return { empty: false, sfuReachable: false };
  }
}

// ── MIC-02: server-side self-mute enforcement ────────────────────────────────
// Host moderation (muteParticipant / muteAllParticipants below) mutes on the
// HOST's demand. This records each participant's OWN reported mute intent and
// re-asserts it AT THE SFU, so a client bug — UI shows muted while the track
// still publishes — cannot leak audio past the server. Self-targeting only:
// the route passes the authenticated caller's id, so the worst a malicious
// report can do is mute its own sender.
//
// The map is per-process. Both the immediate sweep and the delayed re-check run
// on the instance that received the report, so no cross-instance state is
// needed; the intent entry only gates the re-check (a mute→unmute inside the
// re-check window reads the newer intent and skips). Entries are cleared on
// unmute, on deleteRoom, and by an opportunistic age sweep so ungracefully
// abandoned rooms can't grow the map forever.
const selfMuteIntents = new Map<string, { muted: boolean; at: number }>();
const SELF_MUTE_RECHECK_MS = 2500;
const SELF_MUTE_MAX_AGE_MS = 12 * 3600 * 1000;

function sweepSelfMuteIntents() {
  if (selfMuteIntents.size < 500) return;
  const cutoff = Date.now() - SELF_MUTE_MAX_AGE_MS;
  for (const [k, v] of selfMuteIntents) if (v.at < cutoff) selfMuteIntents.delete(k);
}

async function enforceSelfMuteState(room: string, userId: string, muted: boolean) {
  const key = room + "|" + userId;
  sweepSelfMuteIntents();
  if (!muted) {
    // Unmute is the participant's own consent — record it (so an in-flight
    // re-check stands down) and touch nothing at the SFU.
    selfMuteIntents.delete(key);
    return { room, userId, muted: false, enforced: false };
  }
  selfMuteIntents.set(key, { muted: true, at: Date.now() });
  // Immediate sweep: mute any audio track this participant has live right now.
  const first = await muteParticipant(room, userId, true).catch(() => null);
  // Delayed re-check: a track published moments after the report (LiveKit's
  // reconnect engine re-publishing, a device switch re-acquiring) must also
  // land muted — the server-side dual of the client's MIC-04 re-apply. Reads
  // the intent at fire time so a quick unmute in between wins.
  const t = setTimeout(() => {
    if (selfMuteIntents.get(key)?.muted)
      muteParticipant(room, userId, true).catch(() => {});
  }, SELF_MUTE_RECHECK_MS);
  (t as any).unref?.();
  return {
    room,
    userId,
    muted: true,
    enforced: true,
    tracks: first?.tracks ?? 0,
    inRoom: first?.inRoom ?? false,
  };
}

async function muteParticipant(room: string, userId: string, muted = true) {
  const client = await roomService();
  const { identity: liveIdent, sfuReachable } = await findLiveIdentity(client, room, userId);
  if (!liveIdent) return { room, userId, muted, tracks: 0, inRoom: false, sfuReachable };
  const participant = await client.getParticipant(room, liveIdent);
  const tracks = (participant?.tracks || []).filter(
    (track: any) => track?.type === "AUDIO" || track?.type === 0,
  );
  for (const track of tracks) {
    if (track?.sid) await client.mutePublishedTrack(room, liveIdent, track.sid, muted);
  }
  return { room, userId, identity: liveIdent, muted, tracks: tracks.length, inRoom: true, sfuReachable };
}

// PER-MEETING OPTIONS (0116): re-permission everyone ALREADY in the room when
// a host changes what attendees are allowed to do.
//
// A LiveKit grant is baked into the join token, so without this a policy change
// would only bind late joiners — the host would tighten a setting, watch nothing
// happen to the people in front of them, and reasonably conclude it was broken.
// `updateParticipant` rewrites the permission on the live session instead.
//
// Two things have to happen, in this order:
//   1. Take the permission away, so no NEW publish of that source succeeds.
//   2. Mute what is ALREADY published, because revoking permission does not
//      retroactively stop a track that is mid-flight.
// Doing (2) first would leave a window where the participant could re-publish.
//
// Fail-soft throughout: a participant who has just left, or an SFU blip, must
// never make the whole options change fail. The caller's DB write has already
// committed, so the policy is correct even if one live update is missed — and
// that participant picks it up on their next join.
async function applyPermissions(
  room: string,
  perUser: Array<{
    userId: string;
    canPublish: boolean;
    canPublishSources: string[];
    /** Preserve the host's room-admin grant — see the atomic note below. */
    roomAdmin?: boolean;
  }>,
): Promise<{ updated: number; missed: number }> {
  if (!perUser.length) return { updated: 0, missed: 0 };
  let updated = 0;
  let missed = 0;
  let client: any;
  try {
    client = await roomService();
  } catch (e: any) {
    console.warn("[livekit] applyPermissions: SFU unreachable —", e?.message || e);
    return { updated: 0, missed: perUser.length };
  }
  for (const p of perUser) {
    try {
      const { identity: liveIdent, sfuReachable } = await findLiveIdentity(client, room, p.userId);
      if (!liveIdent) {
        // Distinguish the two reasons this can be empty. "Not connected" is a
        // normal no-op; "the SFU did not answer" is a FAILURE, and reporting it
        // as a no-op would make a broken media server look like a successful
        // policy change — the caller could not tell them apart.
        if (!sfuReachable) {
          missed++;
          console.warn(
            "[livekit] applyPermissions: SFU did not answer for room",
            room,
            "— policy applies on next join",
          );
        }
        continue;
      }
      // LiveKit replaces the permission set ATOMICALLY — whatever is omitted is
      // cleared, not left alone. So every field roomToken grants has to be
      // restated here, or a host would silently lose roomAdmin the moment they
      // changed any option.
      await client.updateParticipant(room, liveIdent, {
        permission: {
          canSubscribe: true,
          canPublishData: true,
          canPublish: p.canPublish,
          canPublishSources: p.canPublishSources.map(toTrackSource),
          roomAdmin: !!p.roomAdmin,
        },
      });
      // Stop anything already live that the new grant no longer permits.
      const allowed = new Set(p.canPublishSources);
      const participant = await client.getParticipant(room, liveIdent).catch(() => null);
      for (const track of participant?.tracks || []) {
        if (!track?.sid || track.muted) continue;
        const src = String(track.source || "").toLowerCase();
        const disallowed =
          (src.includes("camera") && !allowed.has("camera")) ||
          (src.includes("microphone") && !allowed.has("microphone")) ||
          (src.includes("screen_share_audio") && !allowed.has("screen_share_audio")) ||
          (src.includes("screen_share") && !src.includes("audio") && !allowed.has("screen_share"));
        if (disallowed || !p.canPublish)
          await client.mutePublishedTrack(room, liveIdent, track.sid, true).catch(() => {});
      }
      updated++;
    } catch (e: any) {
      missed++;
      console.warn(
        "[livekit] applyPermissions failed for",
        p.userId,
        "-",
        e?.message || e,
      );
    }
  }
  return { updated, missed };
}

// Host moderation: mute every participant's audio in one call. This is
// deliberately ONE-WAY. There is no force-unmute: turning someone's microphone
// back on is THEIR consent to give, not the host's to take (Teams/Zoom/Meet
// behave the same — a host may mute, and at most *ask* someone to unmute).
// Server-muted participants can always unmute themselves from their own mic
// control. exceptUserId spares the actor.
async function muteAllParticipants(
  room: string,
  exceptUserId: string | null = null,
) {
  const client = await roomService();
  // Match the other listParticipants call sites (lines 26, 123): a LiveKit
  // "room not found" / transient TwirpError here was UNCAUGHT and surfaced as an
  // opaque 500 "Something went wrong" when the host pressed Mute everyone. Fall
  // back to an empty roster (nothing to mute) instead of crashing the request.
  // Distinguish "the room is empty" from "we couldn't reach the SFU". Both used
  // to collapse to an empty roster, so a misconfigured LIVEKIT_SERVER_URL (e.g.
  // localhost from inside the backend container, where LiveKit isn't) made every
  // host control report success while muting nobody. The caller surfaces this.
  let sfuReachable = true;
  const participants = await client.listParticipants(room).catch(() => {
    sfuReachable = false;
    return [];
  });
  let affected = 0;
  let targeted = 0;
  let audioTracks = 0;
  let failures = 0;
  // Who we actually muted, so the caller can tell those clients directly (the
  // SFU mute does not reliably reach the muted person's own client).
  const mutedUserIds = new Set<string>();
  const targets = (participants || []).filter((participant: any) => {
    const identity = participant?.identity;
    if (!identity) return false;
    if (exceptUserId && baseUserId(identity) === exceptUserId) return false;
    return true;
  });
  targeted = targets.length;
  // Re-fetch each participant to read its tracks.
  //
  // This mirrors muteParticipant (the single-participant control, which works).
  // listParticipants' ParticipantInfo is not a reliable source of the `tracks`
  // array, so reading it directly filtered an empty list for every participant:
  // nothing was muted, `affected` stayed 0, and the route still answered 200 —
  // the host saw "Everyone muted" while every microphone stayed live. Falls back
  // to the roster entry when a re-fetch fails, so a transient error degrades
  // rather than skipping that person entirely.
  //
  // Fetched in PARALLEL: these are independent round trips to the SFU, and doing
  // them sequentially made "Mute everyone" cost one round trip per participant —
  // ~100 of them in a full meeting, all while the host's request blocked.
  const fulls = await Promise.all(
    targets.map(async (participant: any) => {
      try {
        const fetched = await client.getParticipant(room, participant.identity);
        return fetched || participant;
      } catch (_) {
        return participant;
      }
    }),
  );
  for (let i = 0; i < targets.length; i += 1) {
    const identity = targets[i].identity;
    const full: any = fulls[i];
    const tracks = ((full && full.tracks) || []).filter(
      (track: any) => track?.type === "AUDIO" || track?.type === 0,
    );
    audioTracks += tracks.length;
    for (const track of tracks) {
      if (track?.sid) {
        try {
          await client.mutePublishedTrack(room, identity, track.sid, true);
          affected += 1;
          mutedUserIds.add(baseUserId(identity));
        } catch (_) {
          // Already muted / stale track sid — skip it. One participant's
          // already-muted mic must NOT fail the action for everyone else (this
          // was the "Failed to mute all" bug when someone was pre-muted).
          failures += 1;
        }
      }
    }
  }
  // Report enough for the caller to tell "nobody to mute" apart from "tried and
  // failed". Previously only `mutedTracks` came back, so a total failure was
  // indistinguishable from an already-quiet room and the UI called both success.
  return {
    room,
    mutedTracks: affected,
    participants: targeted,
    audioTracks,
    failures,
    sfuReachable,
    mutedUserIds: [...mutedUserIds],
  };
}

// LiveKit reports TrackInfo.source as a number (protobuf enum) on current SDKs
// and as a string name on older ones — accept both.
function trackSourceName(t: any): string {
  const s = t?.source;
  if (typeof s === "number") {
    return ({ 1: "camera", 2: "microphone", 3: "screen_share", 4: "screen_share_audio" } as any)[s] || "";
  }
  return String(s || "").toLowerCase();
}

// Live roster of a room as the admin portal needs it: who is connected and what
// each person is publishing right now. `reachable` is false when the SFU did not
// answer — callers must show that as "unknown", never as "nobody is in the room".
async function listRoomParticipants(room: string): Promise<{
  reachable: boolean;
  participants: Array<{
    userId: string;
    identity: string;
    name: string;
    micOn: boolean;
    cameraOn: boolean;
    screenSharing: boolean;
  }>;
}> {
  let client: any;
  let list: any[] = [];
  try {
    client = await roomService();
    list = await client.listParticipants(room);
  } catch (e: any) {
    const msg = String((e && (e.message || e.code || e.status)) || "");
    // "room does not exist" == definitively empty (see listRoomUserIds).
    if (/not.?found|does not exist|404/i.test(msg)) return { reachable: true, participants: [] };
    return { reachable: false, participants: [] };
  }
  // listParticipants' entries don't reliably carry `tracks` (see
  // muteAllParticipants) — re-fetch each, falling back to the roster entry.
  const fulls = await Promise.all(
    (list || []).map(async (p: any) => {
      try {
        return (await client.getParticipant(room, p.identity)) || p;
      } catch (_) {
        return p;
      }
    }),
  );
  const participants = fulls
    .filter((p: any) => p && p.identity)
    .map((p: any) => {
      const tracks: any[] = p.tracks || [];
      const live = (src: string) =>
        tracks.some((t) => trackSourceName(t) === src && !t.muted);
      return {
        userId: baseUserId(p.identity),
        identity: p.identity,
        name: String(p.name || ""),
        micOn: live("microphone"),
        cameraOn: live("camera"),
        screenSharing: live("screen_share"),
      };
    });
  return { reachable: true, participants };
}

// Admin moderation: stop ONE person's current screen share. Mutes their
// screen-share (and share-audio) tracks at the SFU, so viewers stop receiving it
// at once. It does NOT revoke the permission — they may share again later.
async function stopScreenShare(room: string, userId: string) {
  const client = await roomService();
  const { identity: liveIdent, sfuReachable } = await findLiveIdentity(client, room, userId);
  if (!liveIdent) return { room, userId, tracks: 0, inRoom: false, sfuReachable };
  const participant = await client.getParticipant(room, liveIdent);
  const tracks = (participant?.tracks || []).filter((t: any) => {
    const src = trackSourceName(t);
    return src === "screen_share" || src === "screen_share_audio";
  });
  let stopped = 0;
  for (const t of tracks) {
    if (!t?.sid) continue;
    try {
      await client.mutePublishedTrack(room, liveIdent, t.sid, true);
      stopped += 1;
    } catch (_) {
      /* already muted / track just ended */
    }
  }
  return { room, userId, identity: liveIdent, tracks: tracks.length, stopped, inRoom: true, sfuReachable };
}

// Admin moderation: turn camera(s) off. Mutes the camera track at the SFU so
// viewers stop receiving it at once. `userId` null = everyone in the room. Like
// the mic, this is ONE-WAY — the person may switch their camera back on.
async function stopCamera(room: string, userId: string | null = null) {
  const client = await roomService();
  let sfuReachable = true;
  const list: any[] = await client.listParticipants(room).catch(() => {
    sfuReachable = false;
    return [];
  });
  const targets = (list || []).filter(
    (p: any) => p?.identity && (!userId || baseUserId(p.identity) === userId),
  );
  const stoppedUserIds = new Set<string>();
  let failures = 0;
  await Promise.all(
    targets.map(async (p: any) => {
      let full: any = p;
      try {
        full = (await client.getParticipant(room, p.identity)) || p;
      } catch (_) {}
      for (const t of full.tracks || []) {
        if (!t?.sid || trackSourceName(t) !== "camera") continue;
        try {
          await client.mutePublishedTrack(room, p.identity, t.sid, true);
          stoppedUserIds.add(baseUserId(p.identity));
        } catch (_) {
          failures += 1;
        }
      }
    }),
  );
  return {
    room,
    inRoom: targets.length > 0,
    stoppedUserIds: [...stoppedUserIds],
    failures,
    sfuReachable,
  };
}

// Resolve the CLIENT-facing LiveKit signalling URL for a request / socket
// handshake. Lived in routes/calls.ts (which still re-exports it); it is here so
// realtime/socket.ts can mint the callee's room token for the call push without
// a routes ↔ realtime import cycle. Accepts anything with `headers` (+ optional
// `secure`): an Express req or a socket.io handshake.
//
// The browser must connect to a URL it can actually reach AND whose scheme
// matches the page (an https page may not open a ws:// socket). Rather than rely
// on a hand-set LIVEKIT_WS_URL — which broke a deploy when it was left at
// ws://localhost — we DERIVE it from the request origin whenever the configured
// value is missing or loopback. Behind the production TLS front (Caddy/nginx),
// the SFU signalling is proxied at /livekit on the same public origin, so
// `wss://<the-host-the-browser-used>/livekit` is correct for ANY deployment.
//
// Precedence: an explicit non-loopback LIVEKIT_WS_URL always wins (operator
// override). Derivation only kicks in behind a TLS-terminating proxy
// (X-Forwarded-Proto: https), so local dev (plain http) keeps using the
// configured ws://localhost:7534. One exception: a request whose Host is
// localhost/127.0.0.1 can only come from the same machine, so the SFU it can
// reach is the one proxied at /livekit on that same origin — derive it.
const LOOPBACK_RE = /(^|\/\/)(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i;
function publicWsUrl(req: any): string | undefined {
  const configured = (config.livekit.wsUrl || "").trim();
  const headers = (req && req.headers) || {};
  const first = (v: any) =>
    (Array.isArray(v) ? v[0] : v || "").toString().split(",")[0].trim();
  const proto = first(headers["x-forwarded-proto"]);
  const host = first(headers["x-forwarded-host"]) || first(headers["host"]);
  const secure = proto === "https" || (!proto && !!(req && req.secure));

  if (host && LOOPBACK_RE.test(host))
    return `${secure ? "wss" : "ws"}://${host}/livekit`;

  const loopback = !configured || LOOPBACK_RE.test(configured);
  if (!loopback) return configured;
  if (proto === "https" && host) return `wss://${host}/livekit`;
  return configured || undefined;
}

export {
  stopCamera,
  roomToken,
  publicWsUrl,
  applyPermissions,
  removeParticipant,
  evictPriorSessions,
  deleteRoom,
  roomIsEmpty,
  muteParticipant,
  muteAllParticipants,
  enforceSelfMuteState,
  makeIdentity,
  baseUserId,
  findLiveIdentity,
  listRoomUserIds,
  listRoomParticipants,
  stopScreenShare,
};
