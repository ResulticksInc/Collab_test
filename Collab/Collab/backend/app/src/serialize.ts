import { db, shared } from "./platform";
const { CONVERSATION } = shared;

// Messages are stored as rich-text HTML (Tiptap). Conversation-list previews
// must be PLAIN TEXT — otherwise the sidebar shows raw markup like
// "<p><a target=…". Strip tags, turn block boundaries into spaces, decode the
// common entities, and collapse whitespace.
// Compact one-line preview: only the FIRST non-empty line/block (WhatsApp-style),
// so a multi-line message or list previews as just its first line in the
// conversation list — matching the frontend lib/messageText.messagePreview().
function htmlToPreview(html) {
  if (!html) return "";
  const decoded = String(html)
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|td|th)>/gi, "\n")
    .replace(/<br\s*\/?>(?:)/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#3[49];/g, "'");
  const firstLine = decoded
    .split("\n")
    .map((t) => t.replace(/\s+/g, " ").trim())
    .find((t) => t.length > 0);
  return firstLine || "";
}

const hhmm = (d) => {
  try {
    return new Date(d).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
};
const dayLabel = (d) => {
  try {
    return new Date(d).toLocaleDateString([], {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  } catch {
    return "";
  }
};
// Short deterministic version token so an avatar URL changes when the image
// changes (busts the browser cache).
function avatarVer(s) {
  let h = 0;
  const str = String(s || "");
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h.toString(36) + str.length.toString(36);
}
// Reference an avatar by the small public URL (frontend resolves to absolute),
// never the raw data URL — so the heavy data isn't embedded in every payload.
function userAvatarUrl(u) {
  return u && u.avatarUrl ? `/api/public/users/${u.id}/avatar?v=${avatarVer(u.avatarUrl)}` : null;
}
function convAvatarUrl(c) {
  return c && c.avatarUrl ? `/api/public/conversations/${c.id}/avatar?v=${avatarVer(c.avatarUrl)}` : null;
}

// Resolve the presence shown to others (full Teams state set). A manual
// Away/Busy/DND/Be-right-back override applies only while the user is actually
// connected (presence !== "off"); when truly offline, "off" always wins so the
// real offline state + last-seen are never hidden. "Appear offline" hides the
// online state from everyone regardless of the real connection.
function effectivePresence(u: any): string {
  const p = (u && u.presence) || "off";
  const m = u && u.manualPresence;
  if (m === "offline") return "off"; // Appear offline
  if (
    p !== "off" &&
    (m === "away" || m === "busy" || m === "dnd" || m === "brb")
  )
    return m;
  return p;
}

const pubUser = (u) =>
  u && {
    id: u.id,
    name: u.name,
    initials: u.initials,
    color: u.color,
    avatarUrl: userAvatarUrl(u),
    about: u.about || null,
    title: u.title || null,
    pronouns: u.pronouns || null,
    // A public-link guest (role 'guest') has only a synthetic @guest.invalid
    // address — never put it in front of the org's members.
    email: u.role === "guest" ? null : u.email || null,
    phone: u.phone || null,
    timezone: u.timezone || null,
    // Manual status (Away/DND) wins ONLY while the user is actually connected;
    // a truly-offline user always serializes "off" so the offline dot + last-seen
    // are never masked. DND maps to the existing "busy" value.
    presence: effectivePresence(u),
    role: u.role || "member",
  };
const URL_RE = /(https?:\/\/[^\s]+)/g;

// ── Batched user resolution ──────────────────────────────────────────────────
// db.users.getById is an uncached SELECT, so serializing a LIST used to fire one
// query per row: a 50-message page = 50 concurrent user reads, a meetings page =
// meetings × attendees (unbounded), the conversation list = one per DM peer +
// unread sender. Under ~100 concurrent users that saturates the connection pool
// (the driver already lists errno 1040 "too many connections" as retryable).
//
// Fix is the same one serializeTaskList already applies: collect every distinct
// user id the list will render, resolve them in ONE getByIds, and hand the map
// down. Every serializer below takes an OPTIONAL map — when absent it falls back
// to the original per-id getById, so single-item callers are untouched and the
// output shape is byte-for-byte identical either way.
async function resolveUsersByIds(ids: Iterable<string>): Promise<Map<string, any>> {
  const map = new Map<string, any>();
  const list = [...new Set([...ids].filter(Boolean))];
  if (!list.length) return map;
  if (db.users.getByIds) {
    const rows = await db.users.getByIds(list);
    for (const u of rows || []) if (u && u.id) map.set(u.id, u);
  } else {
    // Driver without a batch getter: resolve once per DISTINCT id (already far
    // fewer reads than once per row) so behaviour is preserved everywhere.
    for (const id of list) map.set(id, await db.users.getById(id));
  }
  return map;
}
// Read a user through the prefetched map when we have one, else fall back to a
// direct read. A map MISS still falls through to getById: the map is an
// optimization, never an authority on existence.
async function userFrom(usersById: Map<string, any> | undefined, id: string) {
  if (!id) return null;
  if (usersById && usersById.has(id)) return usersById.get(id);
  return db.users.getById(id);
}

// Groups raw reactions into per-emoji { emoji, count, mine, reactors:[{id,name}] }.
// `reactors` is viewer-independent (correct for every recipient) and powers the
// "who reacted" popover. Each UNIQUE reactor is resolved once (dedupe cache) to
// avoid an N+1. NOTE: this is async — callers MUST await it.
// Two visually-identical emoji can differ by a trailing Unicode variation
// selector (U+FE0F / U+FE0E) or surrounding whitespace — e.g. the composer's
// quick-bar "❤️" carries U+FE0F while an emoji-picker's "❤" may not. Grouping on
// the raw string then splits the SAME reaction into two pills that never combine.
// Normalise to a stable KEY (strip the selectors) so they aggregate; the pill
// still DISPLAYS the first raw emoji so its glyph renders exactly as sent.
function reactionKey(emoji: any): string {
  return String(emoji || "").replace(/[︎️]/g, "").trim();
}
async function groupReactions(reactions, viewerId, usersById?: Map<string, any>) {
  const map = new Map();
  const nameCache = new Map<string, string>();
  const nameFor = async (uid: string): Promise<string> => {
    if (nameCache.has(uid)) return nameCache.get(uid)!;
    let nm = "Someone";
    try {
      const u = await userFrom(usersById, uid);
      if (u && u.name) nm = u.name;
    } catch { /* fall through to default */ }
    nameCache.set(uid, nm);
    return nm;
  };
  for (const r of reactions || []) {
    const key = reactionKey(r.emoji);
    const e = map.get(key) || { emoji: r.emoji, count: 0, mine: false, reactors: [] };
    e.count++;
    if (r.userId === viewerId) e.mine = true;
    e.reactors.push({ id: r.userId, name: await nameFor(r.userId) });
    map.set(key, e);
  }
  return [...map.values()];
}

// ── Smart Inbox: the viewer's mention token, memoised ────────────────────────
// The priority mention-scan only needs the viewer's FIRST NAME (\W-stripped —
// the composer's own "@First" convention). Fetching it per conversation was an
// N+1: listForUser serializes the whole list in one Promise.all burst, firing
// an identical users.getById for EVERY unread group/channel. Share ONE fetch:
// concurrent callers join the in-flight promise, and a short TTL covers rapid
// sequential serializations (message broadcast paths). Staleness only delays a
// display-only bucket after a rename — harmless. Same defect-class fix the file
// already applies to task assignees (usersById batching).
const viewerFirstCache = new Map<string, { v: string; at: number }>();
const viewerFirstInflight = new Map<string, Promise<string>>();
const VIEWER_FIRST_TTL_MS = 10_000;
async function viewerFirstName(viewerId: string): Promise<string> {
  const hit = viewerFirstCache.get(viewerId);
  if (hit && Date.now() - hit.at < VIEWER_FIRST_TTL_MS) return hit.v;
  let p = viewerFirstInflight.get(viewerId);
  if (!p) {
    p = (async () => {
      try {
        const u = await db.users.getById(viewerId);
        return (((u && u.name) || "").split(" ")[0] || "").replace(/\W/g, "");
      } catch {
        return ""; // best-effort — never fail serialization
      }
    })();
    viewerFirstInflight.set(viewerId, p);
  }
  try {
    const v = await p;
    if (viewerFirstCache.size > 5000) viewerFirstCache.clear(); // bound memory
    viewerFirstCache.set(viewerId, { v, at: Date.now() });
    return v;
  } finally {
    viewerFirstInflight.delete(viewerId);
  }
}

// ── Role-based inbox grouping: counterpart org-role rank, memoised per org ────
// The dashboard's "Unread" / "Missed calls" shortcuts group conversations & calls
// by the COUNTERPART's org role (owner → admin → … → member). Rank comes from the
// org's role catalog overlaid on the built-in ladder — mirrors
// orgService.orgRoleRanks(), kept LOCAL here to avoid a service import cycle.
// Memoised like viewerFirstName: a conversation list serializes in one burst, so
// this reads the catalog ONCE per org, not once per row. Best-effort — a missing
// orgId or an unreadable catalog just falls back to the built-in ladder.
const ROLE_RANK_FALLBACK: Record<string, number> = {
  owner: 100,
  admin: 80,
  member: 40,
  guest: 20,
};
const roleRankCache = new Map<string, { m: Map<string, number>; at: number }>();
const roleRankInflight = new Map<string, Promise<Map<string, number>>>();
const ROLE_RANK_TTL_MS = 30_000;
async function roleRanksFor(orgId?: string | null): Promise<Map<string, number>> {
  const key = orgId || "_";
  const hit = roleRankCache.get(key);
  if (hit && Date.now() - hit.at < ROLE_RANK_TTL_MS) return hit.m;
  let p = roleRankInflight.get(key);
  if (!p) {
    p = (async () => {
      const m = new Map<string, number>(Object.entries(ROLE_RANK_FALLBACK));
      if (orgId) {
        try {
          for (const r of (await db.orgs.roleCatalog(orgId)) || [])
            m.set(r.key, Number(r.rank) || 0);
        } catch {
          /* keep the fallback ladder if the catalog can't be read */
        }
      }
      return m;
    })();
    roleRankInflight.set(key, p);
  }
  try {
    const m = await p;
    if (roleRankCache.size > 500) roleRankCache.clear(); // bound memory
    roleRankCache.set(key, { m, at: Date.now() });
    return m;
  } finally {
    roleRankInflight.delete(key);
  }
}
function rankOfRole(m: Map<string, number>, role?: string | null): number {
  if (!role) return 0;
  const r = m.get(role);
  return typeof r === "number" ? r : 0;
}

// Minimal but COMPLETE conversation shape (every field serializeConversation
// emits) with safe neutral defaults. Used when serializing a single row throws
// so the row still appears in the sidebar — named, ordered, openable — with a
// blank preview, instead of vanishing or (via Promise.all) 500ing the WHOLE
// list. Never does I/O and never throws.
function fallbackConversation(conv: any, viewerId: string) {
  const c = conv || {};
  const lm = c.lastMessage || null;
  return {
    priority: "low",
    senderRole: null,
    senderRoleRank: 0,
    id: c.id,
    kind: c.kind,
    name:
      c.title ||
      (c.kind === CONVERSATION.SELF
        ? "You"
        : c.kind === CONVERSATION.DM
          ? "Direct message"
          : "Conversation"),
    avatar: { kind: "icon", icon: c.icon || "#" },
    description: c.description || null,
    temporary: !!c.temporary,
    expiresAt: c.expiresAt || null,
    retentionDays: c.retentionDays != null ? Number(c.retentionDays) : 7,
    pendingConnection: !!c.pendingConnection,
    presence: null,
    lastSeen: null,
    preview: "",
    previewHtml: null,
    time: lm && lm.createdAt ? hhmm(lm.createdAt) : "",
    lastMessageAt: lm ? lm.createdAt : null,
    encryptedPreview: false,
    lastMessageEnc: null,
    unread: c.unread || 0,
    hidden: !!c.hidden,
    starred: !!c.starred,
    muted: !!c.muted,
    memberRole: c.role || null,
    memberCount: (c.members || []).length,
    members: c.members || [],
    createdBy: c.createdBy || null,
    // Marks a row that fell back so the client (and diagnostics) can tell it apart
    // from a normally-serialized one. Unknown keys are ignored by the client.
    _degraded: true,
  };
}

// Batched conversation-list serialization — the BOOT HYDRATION path. Every row
// resolved its own users: the DM peer, up to 3 members to name an untitled
// group, and the last sender of every unread group/channel. A sidebar of 40
// conversations meant ~40-80 user reads before the app could paint. Collect
// them all and issue ONE query.
//
// The id set below MUST mirror the branches in serializeConversation; a miss is
// safe (userFrom falls back to a direct read) but costs the query back.
async function serializeConversationList(convs: any[], viewerId) {
  const list = convs || [];
  if (!list.length) return [];
  const ids = new Set<string>();
  for (const conv of list) {
    const members = conv.members || [];
    if (conv.kind === CONVERSATION.SELF) ids.add(viewerId);
    else if (conv.kind === CONVERSATION.DM)
      ids.add(members.find((m) => m !== viewerId) || viewerId);
    else if (conv.kind === CONVERSATION.GROUP && !conv.title)
      for (const id of members.filter((m) => m !== viewerId).slice(0, 3)) ids.add(id);
    // Call/meeting groups draw a merged avatar from up to 4 members.
    if (isSessionGroup(conv)) for (const id of sessionGroupAvatarIds(conv, viewerId)) ids.add(id);
    const last = conv.lastMessage;
    if ((conv.unread || 0) > 0 && last && last.senderId && last.senderId !== viewerId)
      ids.add(last.senderId);
  }
  // The batch prefetch is an OPTIMIZATION, not an authority — userFrom falls back
  // to a direct read on a miss — so a failure here must not sink the whole list.
  const usersById = await resolveUsersByIds(ids).catch((e) => {
    console.error(
      "[serializeConversationList] user prefetch failed; falling back to per-row reads",
      e,
    );
    return new Map<string, any>();
  });
  // GET /api/conversations is the boot-critical hydration call: if ANY single row
  // throws (an unreadable last message, a user read that errors, corrupt org data),
  // a bare Promise.all rejects the ENTIRE response with a 500 and locks the user
  // out of the app. Serialize each row independently and degrade a failure to a
  // minimal-but-complete row, logging the offender (conversation + last-message id)
  // so the underlying data can be found and repaired.
  return Promise.all(
    list.map((c) =>
      serializeConversation(c, viewerId, usersById).catch((e) => {
        try {
          const lm = c && c.lastMessage;
          console.error(
            `[serializeConversationList] conversation ${c && c.id} (kind=${c && c.kind}, ` +
              `lastMessage=${lm && lm.id}, type=${lm && lm.type}) failed to serialize; ` +
              "returning a degraded row so the rest of the sidebar still loads",
            e,
          );
        } catch {
          /* logging must never throw */
        }
        return fallbackConversation(c, viewerId);
      }),
    ),
  );
}

// Any GROUP without an uploaded picture — user-created groups (💬) as well as
// the 📞 / 📹 call and meeting groups. Their list avatar is a MERGE of the
// members' avatars (2–4 people) rather than the generic emoji tile. Channels
// keep their icon; a group with a real picture keeps that picture.
function isSessionGroup(conv: any): boolean {
  return !!conv && conv.kind === CONVERSATION.GROUP && !conv.avatarUrl;
}
// Members whose avatars make up the merged tile: the OTHER members first (the
// people you'd recognise the call by), then you, capped at 4.
function sessionGroupAvatarIds(conv: any, viewerId: string): string[] {
  const members: string[] = conv.members || [];
  const others = members.filter((m) => m !== viewerId);
  const ordered = members.includes(viewerId) ? [...others, viewerId] : others;
  return ordered.slice(0, 4);
}

async function serializeConversation(conv, viewerId, usersById?: Map<string, any>) {
  let name = conv.title || "";
  // Group/channel avatar: a real uploaded image when set, else the emoji icon.
  let avatar: any = conv.avatarUrl
    ? { kind: "group", avatarUrl: convAvatarUrl(conv), icon: conv.icon || "#", initials: (conv.title || "G").slice(0, 2).toUpperCase(), color: "#64748b" }
    : { kind: "icon", icon: conv.icon || "#" };
  if (isSessionGroup(conv)) {
    const members: any[] = [];
    for (const id of sessionGroupAvatarIds(conv, viewerId)) {
      const u = await userFrom(usersById, id);
      if (u) members.push({ initials: u.initials, color: u.color, avatarUrl: userAvatarUrl(u) });
    }
    // Needs at least 2 faces to be a merge; a lone member keeps the icon tile.
    if (members.length >= 2) avatar = { ...avatar, members };
  }
  let presence = null;
  let lastSeen = null;
  // Hoisted so the DM peer is reachable when we resolve the role-grouping key below.
  let other: any = null;
  if (conv.kind === CONVERSATION.DM || conv.kind === CONVERSATION.SELF) {
    const otherId =
      conv.kind === CONVERSATION.SELF
        ? viewerId
        : conv.members.find((m) => m !== viewerId) || viewerId;
    other = await userFrom(usersById, otherId);
    name =
      conv.kind === CONVERSATION.SELF
        ? "You"
        : (other && other.name) || "Direct message";
    avatar = {
      kind: "user",
      initials: other && other.initials,
      color: other && other.color,
      avatarUrl: userAvatarUrl(other),
    };
    presence = other ? effectivePresence(other) : null;
    // Only expose last-seen if the peer shares it (their privacy setting).
    lastSeen = other && other.shareLastSeen ? other.lastSeen || null : null;
  } else if (conv.kind === CONVERSATION.GROUP && !conv.title) {
    // P1.4: an untitled group (e.g. a DM that gained participants) shows a
    // temporary name built from its other members.
    const others = (conv.members || []).filter((m) => m !== viewerId);
    const names: string[] = [];
    for (const id of others.slice(0, 3)) {
      const u = await userFrom(usersById, id);
      if (u && u.name) names.push(u.name.split(" ")[0]);
    }
    let label = names.join(" + ");
    if (others.length > 3) label += ` + ${others.length - 3} more`;
    name = label || "Group";
  }
  const last = conv.lastMessage;
  const lastEncrypted = last && Number(last.encryptionVersion) > 0;
  // ── Smart Inbox (deterministic, no AI): the sidebar's priority bucket ──────
  //   action → this conversation is waiting on YOU: an unread DM, or an unread
  //            group/channel message that @mentions you (or @all/@everyone/@here)
  //   timely → the unread last message is a meeting invite
  //   fyi    → other unread group/channel traffic
  //   low    → read, or deliberately muted
  // Rules only — no models, no network. Encrypted bodies can't be mention-
  // scanned (ciphertext), so they bucket as fyi rather than guessing.
  let priority: "action" | "timely" | "fyi" | "low" = "low";
  const unreadN = conv.unread || 0;
  if (unreadN > 0 && !conv.muted) {
    if (last && last.type === "meeting_invite") priority = "timely";
    else if (conv.kind === CONVERSATION.DM) priority = "action";
    else if (
      conv.kind === CONVERSATION.GROUP ||
      conv.kind === CONVERSATION.CHANNEL
    ) {
      const body = String((last && last.body) || "");
      let mentioned = /@(all|everyone|here)\b/i.test(body);
      if (!mentioned && !lastEncrypted) {
        // Mentions are inserted as "@First" (first name, \W stripped) — match
        // the composer's own convention. Memoised: ONE viewer fetch per burst,
        // not one per conversation (see viewerFirstName above).
        const first = await viewerFirstName(viewerId);
        if (first)
          mentioned = new RegExp(
            "@" + first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b",
            "i",
          ).test(body);
      }
      priority = mentioned ? "action" : "fyi";
    }
  }
  // ── Role-based grouping key ──────────────────────────────────────────────
  // Who is this thread FROM, for the dashboard's role-tiered "Unread" view: the
  // DM peer, or (group/channel) the last message's sender. `senderRoleRank` lets
  // the client order the tiers (owner → admin → … → member) without knowing the
  // org's role ladder. Best-effort; role is null (rank 0, bottom tier) if unknown.
  let senderRole: string | null = null;
  if ((conv.kind === CONVERSATION.DM || conv.kind === CONVERSATION.SELF) && other) {
    senderRole = other.role || null; // DM peer already fetched — free
  } else if (unreadN > 0 && last && last.senderId && last.senderId !== viewerId) {
    // Only the UNREAD group/channel rows are role-grouped, so only they pay the
    // extra sender lookup (getById is deduped/cached) — read rows stay untouched.
    const s = await Promise.resolve(userFrom(usersById, last.senderId)).catch(() => null);
    senderRole = (s && s.role) || null;
  }
  const senderRoleRank = rankOfRole(
    // Row shape varies (camelCased vs raw); accept any of them — falls back to the
    // built-in ladder when absent, so standard roles still tier correctly.
    await roleRanksFor(conv.orgId || conv.organizationId || conv.organization_id),
    senderRole,
  );
  return {
    priority,
    senderRole,
    senderRoleRank,
    id: conv.id,
    kind: conv.kind,
    name,
    avatar,
    description: conv.description || null,
    // BA/CEO: auto-expiring temp group (from an ended call/meeting chat) — the
    // client shows a "deletes in N days" notice. retentionDays = the sliding TTL
    // (refreshed on activity); the user can change it or convert to permanent.
    temporary: !!conv.temporary,
    expiresAt: conv.expiresAt || null,
    retentionDays: conv.retentionDays != null ? Number(conv.retentionDays) : 7,
    // Teams-model: a DM created at Connect time that the recipient hasn't accepted
    // yet — the sender's composer shows a "Request sent" banner + disables
    // attachments until this clears (on accept).
    pendingConnection: !!(conv as any).pendingConnection,
    presence,
    lastSeen,
    preview: last
      ? last.type === "voice"
        ? "🎤 Voice message"
        : last.type === "sticker"
        ? "🖼️ Sticker"
        : last.type === "gif"
        ? "🎞️ GIF"
        : last.type === "meeting_invite"
          ? "📅 " +
            (() => {
              try {
                return JSON.parse(last.body || "{}").title || "Meeting invitation";
              } catch {
                return "Meeting invitation";
              }
            })()
          : last.type === "meeting_attendance"
            ? "📹 Meeting ended" // JSON body — never show it raw
          : last.type === "task_card"
            ? "📋 " +
              (() => {
                try {
                  return JSON.parse(last.body || "{}").title || "Task";
                } catch {
                  return "Task";
                }
              })()
            : last.type === "session_divider"
              ? // Session divider carries a hidden "§sd:<sessionKey>§" dedup marker
                // in its body — strip it so the sidebar preview shows only the
                // human label ("Call · 23 Jul 2026"), never the raw id.
                String(last.body || "").replace(/^§sd:[^§]*§/, "").trim() ||
                "New session"
              : last.file
                ? `📎 ${last.file.name || "File"}`
                : htmlToPreview(last.body)
      : "",
    // Raw last-message HTML so the sidebar can render a COMPACT formatted preview
    // (bullets/bold, clamped to one line). Null for voice/file/encrypted/invite
    // so the plain `preview` (emoji label) is used instead — never raw JSON.
    previewHtml:
      last &&
      !last.file &&
      last.type !== "voice" &&
      last.type !== "meeting_invite" &&
      last.type !== "meeting_attendance" &&
      last.type !== "task_card" &&
      last.type !== "session_divider" &&
      !Number(last.encryptionVersion)
        ? last.body || null
        : null,
    time: last ? hhmm(last.createdAt) : "",
    // Sortable timestamp for "most recent at top" ordering in the sidebar.
    lastMessageAt: last ? last.createdAt : null,
    encryptedPreview: !!lastEncrypted,
    // The encrypted last message's envelope so the CLIENT can decrypt the list
    // preview — the server can't (E2EE), so it ships an empty `preview` above and
    // this instead. Only for encrypted TEXT messages: files/voice/invite/task
    // already get a plaintext label above, so they need no client decrypt. Shape
    // matches what decryptMessageList() consumes; null leaves non-E2EE untouched.
    lastMessageEnc:
      lastEncrypted &&
      last &&
      !last.file &&
      last.type !== "voice" &&
      last.type !== "meeting_invite" &&
      last.type !== "task_card"
        ? {
            id: last.id,
            conversationId: conv.id,
            encrypted: true,
            encryptionVersion: Number(last.encryptionVersion) || 0,
            ciphertext: last.ciphertext || null,
            type: last.type || "text",
            sender: { id: last.senderId },
            me: last.senderId === viewerId,
            createdAt: last.createdAt,
          }
        : null,
    unread: conv.unread || 0,
    hidden: !!conv.hidden,
    starred: !!conv.starred,
    muted: !!conv.muted,
    // The VIEWER's role in this conversation ("owner" | "admin" | "member" |
    // null). Surfaced so the frontend can gate group/channel management UI
    // (rename / change avatar / delete) without a separate /members fetch.
    memberRole: conv.role || null,
    memberCount: (conv.members || []).length,
    members: conv.members || [],
    createdBy: conv.createdBy || null,
  };
}

async function serializeMessage(msg, viewerId, opts: any = {}) {
  // opts.usersById (optional) is the prefetched id→user map from
  // serializeMessageList — present on list paths, absent for single-message
  // callers (send/edit/pin/react), which keep the direct read.
  const sender = await userFrom(opts.usersById, msg.senderId);
  // Meeting-invite cards carry their payload as JSON in the body (no schema
  // change). Parse it into a structured `meeting` field and expose a clean
  // human label as `text` so conversation-list previews don't show raw JSON.
  let text = msg.body || "";
  let meeting: any = null;
  if (msg.type === "meeting_invite" && msg.body) {
    try {
      const p = JSON.parse(msg.body);
      // Look up the LIVE meeting so the invite card reflects current reality —
      // reschedule, cancellation, deletion, and (the common case) expiry of the
      // scheduled window — instead of the frozen snapshot in the message body.
      // meeting_invite messages are sparse in a timeline, so the extra read is cheap.
      const live: any = p.meetingId
        ? await db.meetings.getById(p.meetingId).catch(() => null)
        : null;
      meeting = {
        meetingId: p.meetingId || null,
        title: (live && live.title) || p.title || "Meeting",
        startsAt: (live && live.startsAt) || p.startsAt || null,
        durationMin: (live && live.durationMin) || p.durationMin || 30,
        // "ended" when the meeting row is gone (deleted); otherwise the live status
        // (scheduled/completed/cancelled). The client combines this with the
        // scheduled window to decide joinable vs expired on its own live clock.
        status: live ? live.status || "scheduled" : p.meetingId ? "ended" : "scheduled",
      };
      text = "📅 " + meeting.title;
    } catch {
      /* malformed payload — leave as-is */
    }
  }
  // Task cards (Unified Action Bar /task) — same JSON-in-body pattern as the
  // meeting invite: parse into `task`, expose a clean preview label as `text`.
  let task: any = null;
  if (msg.type === "task_card" && msg.body) {
    try {
      const p = JSON.parse(msg.body);
      task = {
        taskId: p.taskId || null,
        title: p.title || "Task",
        priority: p.priority || null,
        assigneeNames: Array.isArray(p.assigneeNames)
          ? p.assigneeNames.slice(0, 12)
          : [],
      };
      text = "📋 " + task.title;
    } catch {
      /* malformed payload — leave as-is */
    }
  }
  // Attendance card posted when a meeting ends — same JSON-in-body pattern.
  // `text` becomes the plain "Meeting ended" line so list previews, older
  // clients and the ended-meeting detection all read it as the end-of-meeting
  // trace it replaces.
  let attendance: any = null;
  if (msg.type === "meeting_attendance" && msg.body) {
    try {
      const p = JSON.parse(msg.body);
      attendance = {
        meetingId: p.meetingId || null,
        title: p.title || "Meeting",
        startedAt: p.startedAt || null,
        endedAt: p.endedAt || null,
        durationSec: Number(p.durationSec) || 0,
        attendedCount: Number(p.attendedCount) || 0,
        // Who may open the report (host + co-hosts) — the endpoint enforces it;
        // this only lets the client hide a card that would just 403.
        viewerIds: Array.isArray(p.viewerIds) ? p.viewerIds.slice(0, 50) : [],
      };
      text = "📹 Meeting ended";
    } catch {
      /* malformed payload — leave as-is */
    }
  }
  return {
    id: msg.id,
    conversationId: msg.conversationId,
    me: msg.senderId === viewerId,
    sender: pubUser(sender) || {
      name: "Member",
      initials: "?",
      color: "#94A3B8",
    },
    text,
      file: msg.file || null,
      type: msg.type || "text",
      meeting,
      task,
      attendance,
      voice: msg.voice || null,
    encrypted: Number(msg.encryptionVersion) > 0,
    encryptionVersion: Number(msg.encryptionVersion) || 0,
    ciphertext: msg.ciphertext || null,
    forwarded: !!msg.forwarded,
    forwardCount: Number(msg.forwardCount) || 0,
    edited: !!msg.edited,
    deleted: !!msg.deleted,
    reactions: await groupReactions(msg.reactions, viewerId, opts.usersById),
    bookmarked: opts.bookmarkedIds ? opts.bookmarkedIds.has(msg.id) : false,
    time: hhmm(msg.createdAt),
    createdAt: msg.createdAt,
    parentMessageId: msg.parentMessageId || null,
    replyCount: msg.replyCount || 0,
    lastReplyAt: msg.lastReplyAt || null,
    pinned: !!msg.pinned,
    pinnedBy: msg.pinnedBy || null,
    pinnedAt: msg.pinnedAt || null,
    important: !!msg.important,
  };
}

// Batched message-list serialization. Collects every distinct user id the page
// will render — each message's sender PLUS every reactor (the "who reacted"
// popover names them) — and resolves them in ONE query instead of one per
// message. A 50-message page drops from ~50+ user reads to 1. Output is
// identical to mapping serializeMessage over the list.
// Minimal but COMPLETE message shape (every field serializeMessage emits) with
// safe defaults — used when a single message fails to serialize so the rest of
// the thread still renders instead of the whole page 500ing. Never does I/O.
// Encrypted bodies keep their ciphertext so the client can still decrypt them.
function fallbackMessage(msg: any, viewerId: string) {
  const m = msg || {};
  return {
    id: m.id,
    conversationId: m.conversationId,
    me: m.senderId === viewerId,
    sender: { id: m.senderId, name: "Member", initials: "?", color: "#94A3B8" },
    text: m.body || "",
    file: m.file || null,
    type: m.type || "text",
    meeting: null,
    task: null,
    attendance: null,
    voice: m.voice || null,
    encrypted: Number(m.encryptionVersion) > 0,
    encryptionVersion: Number(m.encryptionVersion) || 0,
    ciphertext: m.ciphertext || null,
    forwarded: !!m.forwarded,
    forwardCount: Number(m.forwardCount) || 0,
    edited: !!m.edited,
    deleted: !!m.deleted,
    reactions: [],
    bookmarked: false,
    time: (() => {
      try {
        return hhmm(m.createdAt);
      } catch {
        return "";
      }
    })(),
    createdAt: m.createdAt,
    parentMessageId: m.parentMessageId || null,
    replyCount: m.replyCount || 0,
    lastReplyAt: m.lastReplyAt || null,
    pinned: !!m.pinned,
    pinnedBy: m.pinnedBy || null,
    pinnedAt: m.pinnedAt || null,
    important: !!m.important,
    _degraded: true,
  };
}

async function serializeMessageList(messages: any[], viewerId, opts: any = {}) {
  const list = messages || [];
  if (!list.length) return [];
  const ids = new Set<string>();
  for (const m of list) {
    if (m.senderId) ids.add(m.senderId);
    for (const r of m.reactions || []) if (r && r.userId) ids.add(r.userId);
  }
  const usersById = await resolveUsersByIds(ids).catch((e) => {
    console.error(
      "[serializeMessageList] user prefetch failed; falling back to per-row reads",
      e,
    );
    return new Map<string, any>();
  });
  // A single unserializable message (e.g. a corrupt envelope) must not 500 the
  // whole thread — degrade just that one to a placeholder and log it.
  return Promise.all(
    list.map((m) =>
      serializeMessage(m, viewerId, { ...opts, usersById }).catch((e) => {
        try {
          console.error(
            `[serializeMessageList] message ${m && m.id} (type=${m && m.type}) failed to serialize; returning a degraded message`,
            e,
          );
        } catch {
          /* logging must never throw */
        }
        return fallbackMessage(m, viewerId);
      }),
    ),
  );
}

async function serializeMember(m, usersById?: Map<string, any>) {
  // Read through the prefetched map when a list caller supplies one; a MISS still
  // falls back to a direct getById (the map is an optimization, never an authority
  // on existence — soft-deleted members resolve via the fallback exactly as before).
  const u = await userFrom(usersById, m.userId);
  return {
    ...(pubUser(u) || {
      id: m.userId,
      name: "Member",
      initials: "?",
      color: "#94A3B8",
    }),
    email: (u && u.email) || null,
    title: (u && u.title) || null,
    memberRole: m.role,
    starred: !!m.starred,
    muted: !!m.muted,
  };
}
// Batched member-list serialization — resolves every member's user in ONE
// getByIds instead of a getById per member (the member-list N+1 flagged in the
// review). Mirrors serializeMessageList / serializeTaskList; single serializeMember
// callers are untouched and the output is byte-for-byte identical either way.
async function serializeMemberList(members) {
  const usersById = await resolveUsersByIds(
    (members || []).map((x) => x.userId),
  );
  return Promise.all((members || []).map((x) => serializeMember(x, usersById)));
}

// Time/status-based lifecycle for list rendering. When a presence count is
// supplied (from the batch presenceCounts query), live participants override
// "expired" → "active" so the list matches the room API's computeState.
function meetingListState(mt, present = 0) {
  if (present >= 1) return "active";
  if (mt.status === "cancelled") return "cancelled";
  if (mt.status === "completed") return "completed";
  const start = Date.parse(mt.startsAt);
  if (!Number.isFinite(start)) return "scheduled";
  const end = start + (mt.durationMin || 30) * 60000;
  const now = Date.now();
  if (now < start - 5 * 60000) return "scheduled";
  if (now < start) return "starting";
  if (now <= end) return "active";
  return "expired";
}
async function serializeMeeting(mt, viewerId, present = 0, usersById?: Map<string, any>) {
  const startsAt = mt.occurrenceStartsAt || mt.startsAt;
  const isOcc = mt.occurrenceIndex != null && mt.occurrenceIndex > 0;
  const attendees = await Promise.all(
    (mt.attendees || []).map(async (a) => ({
      ...(pubUser(await userFrom(usersById, a.userId)) || {}),
      status: a.status,
      role: a.role || "participant",
      // Optional guests (0122) — "come if it's useful" rather than "you need
      // to be there". Drives the chip badge in the scheduler.
      optional: !!a.optional,
    })),
  );
  const mine = mt.createdBy === viewerId;
  const self = (mt.attendees || []).find((a) => a.userId === viewerId);
  const counts = (mt.attendees || []).reduce((acc: any, a: any) => {
    acc[a.status] = (acc[a.status] || 0) + 1;
    return acc;
  }, {});
  return {
    id: isOcc ? `${mt.id}__occ_${mt.occurrenceIndex}` : mt.id,
    meetingId: mt.id,
    seriesId: mt.id,
    occurrenceIndex: mt.occurrenceIndex || 0,
    // RSCH-02/RCR-20/21: the occurrence's stable identity (its ORIGINAL day,
    // the RECURRENCE-ID analogue) — what single-occurrence edits/cancels key
    // on — and whether this occurrence deviates from its series.
    occurrenceKey: mt.occurrenceKey || null,
    isException: !!mt.isException,
    title: mt.title,
    startsAt,
    seriesStartsAt: mt.seriesStartsAt || mt.startsAt,
    durationMin: mt.durationMin,
    time: hhmm(startsAt),
    day: dayLabel(startsAt),
    conversationId: mt.conversationId,
    // Agenda / where (0118).
    description: mt.description || null,
    location: mt.location || null,
    // The organiser's IANA zone. Persisted for EVERY meeting now (not just
    // recurring), so the scheduler can label a one-off's time with the zone it
    // was set in — which is the whole point when booking across timezones.
    // NULL on meetings created before that change, and on a junk value.
    timezone: mt.timezone || null,
    mine,
    hostId: mt.createdBy,
    status: mt.status || "scheduled",
    state: meetingListState(mt, present),
    myStatus: mine ? "host" : self ? self.status : null,
    attendees,
    statusCounts: counts,
    lobbyEnabled: !!mt.lobbyEnabled,
    locked: !!mt.locked,
    // Whether a public (guest) join link exists (0132). Only the boolean —
    // the token itself is fetched through the host-gated public-link route.
    publicLinkEnabled: !!mt.publicLinkToken,
    // PER-MEETING OPTIONS (0116). Sent with every meeting so the client can
    // disable the controls the server would refuse anyway — the UI should never
    // offer a button that is going to fail.
    options: {
      lobbyPolicy: mt.lobbyPolicy || (mt.lobbyEnabled ? "nobody" : "everyone"),
      allowMic: mt.allowMic == null ? true : !!mt.allowMic,
      allowCamera: mt.allowCamera == null ? true : !!mt.allowCamera,
      allowChat: mt.allowChat == null ? true : !!mt.allowChat,
      allowReactions: mt.allowReactions == null ? true : !!mt.allowReactions,
      allowWhiteboard: mt.allowWhiteboard == null ? true : !!mt.allowWhiteboard,
      allowScreenShare: mt.allowScreenShare == null ? true : !!mt.allowScreenShare,
      hostAllowWhiteboard: mt.hostAllowWhiteboard == null ? true : !!mt.hostAllowWhiteboard,
      autoRecord: !!mt.autoRecord,
    },
    recurrence: mt.recurrence || "none",
    recurrenceRule: mt.recurrenceRule || null,
    // Meeting-reminder lead (#53): minutes before start to notify attendees.
    reminderLeadMin: mt.reminderLeadMin == null ? null : Number(mt.reminderLeadMin),
  };
}

// Batched meeting-list serialization. The list path was a DOUBLE N+1: one
// serializeMeeting per meeting, each resolving every attendee with its own
// getById — so an org with 30 meetings × 10 attendees issued ~300 user reads for
// one page load. Collect every attendee id across the whole list and resolve
// them in ONE query. `presentBy` maps meetingId → live participant count.
async function serializeMeetingList(
  meetings: any[],
  viewerId,
  presentBy: Record<string, number> = {},
) {
  const list = meetings || [];
  if (!list.length) return [];
  const ids = new Set<string>();
  for (const mt of list)
    for (const a of mt.attendees || []) if (a && a.userId) ids.add(a.userId);
  const usersById = await resolveUsersByIds(ids);
  return Promise.all(
    list.map((mt) => serializeMeeting(mt, viewerId, presentBy[mt.id] || 0, usersById)),
  );
}

function extractLinks(messages) {
  const out = [];
  for (const m of messages) {
    const found = (m.body || "").match(URL_RE);
    if (found)
      for (const url of found)
        out.push({
          url,
          messageId: m.id,
          // Raw ISO so the client formats in the viewer's local timezone; `time`
          // (server-tz) kept only as a legacy fallback.
          createdAt: m.createdAt,
          time: hhmm(m.createdAt),
        });
  }
  return out;
}

function reminderState(r) {
  if (r.status === "archived") return "archived";
  if (r.status === "done" || r.done) return "completed";
  if (r.dueAt) {
    const due = Date.parse(r.dueAt);
    if (Number.isFinite(due)) {
      if (due < Date.now()) return "overdue";
      if (new Date(due).toDateString() === new Date().toDateString())
        return "today";
    }
  }
  return "upcoming";
}
function serializeReminder(r) {
  return {
    id: r.id,
    text: r.text,
    description: r.description || "",
    done: !!r.done,
    status: r.status || (r.done ? "done" : "open"),
    state: reminderState(r),
    priority: r.priority || "Medium",
    folderId: r.folderId || null,
    dueLabel: r.dueLabel || null,
    dueAt: r.dueAt || null,
    recurrence: r.recurrence || "none",
    // CUSTOM LEAD TIME + STRUCTURED RECURRENCE (#53). leadMinutes NULL/0 = fire at
    // due; recurrenceRule (Outlook-style, shared with meetings) drives real
    // next-occurrence when present, else the legacy `recurrence` enum.
    leadMinutes: r.leadMinutes == null ? null : Number(r.leadMinutes),
    recurrenceRule: r.recurrenceRule || null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt || null,
  };
}
function serializeFolder(f) {
  return { id: f.id, name: f.name, icon: f.icon || "📁" };
}
const durLabel = (s) => {
  const n = Number(s) || 0;
  const m = Math.floor(n / 60);
  const ss = String(n % 60).padStart(2, "0");
  return `${m}:${ss}`;
};
async function serializeCall(c, viewerId) {
  const otherId = viewerId === c.initiatorId ? c.peerId : c.initiatorId;
  const other = otherId ? await db.users.getById(otherId) : null;
  const direction = viewerId === c.initiatorId ? "out" : "in";
  // Peer's org-role rank so the Calls module can tier missed calls (owner → …
  // → member) with the same ordering as the sidebar's role-grouped Unread view.
  const peerRoleRank = rankOfRole(
    await roleRanksFor(c.orgId || c.organizationId || c.organization_id),
    other && other.role,
  );
  return {
    id: c.id,
    peerRoleRank,
    conversationId: c.conversationId,
    kind: c.kind,
    video: c.kind === "video",
    direction,
    status: c.status,
    durationSec: c.durationSec || 0,
    durLabel: durLabel(c.durationSec),
    time: hhmm(c.startedAt),
    startedAt: c.startedAt,
    peer: pubUser(other) || {
      id: otherId,
      name: "Unknown",
      initials: "?",
      color: "#94A3B8",
    },
  };
}

// Serialize a single task. `usersById` (optional) is a pre-fetched id→user map
// from serializeTaskList — when present, assignee/reporter are read from the map
// (zero extra queries); when absent, fall back to a per-id getById so single-task
// callers (create/update/move/409) keep working unchanged.
// `assigneesByTask` / `watchersByTask` (optional) are pre-fetched id-list maps
// from serializeTaskList — when present they avoid a per-task query; when absent,
// single-task callers (create/update/move/409/assign/watch) fetch the lists
// directly. The output adds an `assignees[]` array (the full multi-assignee set)
// while keeping `assignee` (the PRIMARY) + `assigneeId` for any reader that still
// wants one. `watchers` is the id list (the detail panel resolves avatars from
// the users it already holds).
async function serializeTask(
  t,
  usersById?: Map<string, any>,
  assigneesByTask?: Record<string, string[]>,
  watchersByTask?: Record<string, string[]>,
  attachmentsByTask?: Record<string, any[]>,
  progressByTask?: Record<string, { total: number; done: number }>,
  projectsById?: Record<string, any>,
) {
  const resolve = async (uid: string) => {
    if (!uid) return null;
    if (usersById) return usersById.get(uid) || null;
    return await db.users.getById(uid);
  };
  // The assignee id set: from the batch map when available, else a direct read,
  // else (driver without the join table) fall back to the single assignee_id.
  let assigneeIds: string[];
  if (assigneesByTask) assigneeIds = assigneesByTask[t.id] || [];
  else if (db.tasks && db.tasks.assignees) assigneeIds = await db.tasks.assignees(t.id);
  else assigneeIds = t.assigneeId ? [t.assigneeId] : [];
  // Defensive: if the join table is empty but the legacy primary is set (a row
  // created before the back-fill), still surface the primary as an assignee.
  if (!assigneeIds.length && t.assigneeId) assigneeIds = [t.assigneeId];
  const assignees: any[] = [];
  for (const uid of assigneeIds) {
    const pu = pubUser(await resolve(uid));
    if (pu) assignees.push(pu);
  }
  // Primary assignee = assignee_id when present (kept consistent), else the first
  // of the set — so `assignee` is never out of sync with `assignees[0]`.
  const primaryId = t.assigneeId || assigneeIds[0] || null;
  const assignee = primaryId ? pubUser(await resolve(primaryId)) : null;
  const reporter = t.reporterId ? pubUser(await resolve(t.reporterId)) : null;
  let watchers: string[];
  if (watchersByTask) watchers = watchersByTask[t.id] || [];
  else if (db.tasks && db.tasks.watchers) watchers = await db.tasks.watchers(t.id);
  else watchers = [];
  // Attachments[] summary (feature #51): from the batch map when available (the
  // board page), else a direct read for single-task callers (create/update/move/
  // detail/409). The blob lives in `files`; the client downloads via the Files
  // endpoints (/api/files/:id/download), so only a light summary travels here.
  let attachments: any[];
  if (attachmentsByTask) attachments = attachmentsByTask[t.id] || [];
  else if (db.tasks && db.tasks.attachments)
    attachments = await db.tasks.attachments(t.id);
  else attachments = [];
  // SUBTASK PROGRESS (feature #52a): from the batch map when available (the board
  // page — one query for the whole page, no N+1), else a direct count for a
  // single-task caller (create/update/move/detail/409). `subtaskCount` = live
  // children, `doneSubtaskCount` = children in a done status; the client renders a
  // progress bar/fraction when subtaskCount > 0.
  let progress: { total: number; done: number };
  if (progressByTask) progress = progressByTask[t.id] || { total: 0, done: 0 };
  else if (db.tasks && db.tasks.subtaskProgressFor) {
    const m = await db.tasks.subtaskProgressFor([t.id]);
    progress = m[t.id] || { total: 0, done: 0 };
  } else progress = { total: 0, done: 0 };
  // PROJECTS-AS-ENTITIES (#52b): the linked project {id,name,color}. From the
  // batch map on the board page (no N+1), else a direct resolve for single-task
  // callers. Null when unfiled or the project was deleted.
  let project: any = null;
  if (t.projectId) {
    if (projectsById) project = projectsById[t.projectId] || null;
    else if (db.tasks && db.tasks.projectsForIds) {
      const m = await db.tasks.projectsForIds([t.projectId]);
      project = m[t.projectId] || null;
    }
  }
  return {
    id: t.id,
    title: t.title,
    description: t.description || "",
    status: t.status,
    priority: t.priority,
    dueLabel: t.dueLabel || null,
    dueAt: t.dueAt || null,
    labels: t.labels || [],
    // Legacy free-text project name (kept for back-compat / CSV export).
    project: t.project || null,
    // PROJECTS-AS-ENTITIES (#52b): the linked project id + resolved {id,name,color}
    // object (null when unfiled). `projectId` lets the client filter/group without
    // a lookup; `projectObj` carries the display name/color.
    projectId: t.projectId || null,
    projectObj: project,
    assignee,
    assigneeId: primaryId,
    // Full multi-assignee set (primary-first). New canonical field for the UI.
    assignees,
    reporter,
    creator: reporter,
    // Watcher user ids (the client resolves avatars from its user list).
    watchers,
    // File attachments (summary only — id/name/mime/size/uploader). Downloaded
    // via the existing /api/files/:id endpoints, which enforce Files authz.
    attachments,
    createdAt: t.createdAt || null,
    updatedAt: t.updatedAt || null,
    // Recurrence (feature #52a): {none,daily,weekly,monthly}. On completion a
    // recurring task spawns its next occurrence exactly once (server-side).
    recurrence: t.recurrence || "none",
    // Subtasks (feature #52a): the parent id (null = top-level) + progress.
    parentTaskId: t.parentTaskId || null,
    subtaskCount: progress.total,
    doneSubtaskCount: progress.done,
    // Optimistic-concurrency token the client echoes back on its next PATCH so
    // the server can detect a concurrent edit (→ 409). Defaults to 1 for rows
    // serialized before the column existed.
    version: t.version == null ? 1 : Number(t.version),
  };
}

// Batched task-list serialization — fixes the N+1 that did a getById per assignee
// AND per reporter for EVERY task (up to ~4000 user lookups on a full page). We
// collect the distinct assignee+reporter ids across the whole list, fetch them in
// ONE users query (getByIds, falling back to per-id only on a driver without it),
// build an id→user map, and hand it to each serializeTask so it reads from the map
// instead of querying. Output shape is byte-for-byte identical to mapping
// serializeTask over the list.
async function serializeTaskList(tasks: any[]) {
  const list = tasks || [];
  if (!list.length) return [];
  const taskIds = list.map((t) => t.id);
  // ONE query for every task's assignee set (the multi-assignee table) + ONE for
  // watchers — instead of a per-task read. Falls back to the legacy single
  // assignee_id when the driver lacks the batch helper (older driver).
  const assigneesByTask: Record<string, string[]> =
    db.tasks && db.tasks.assigneesFor
      ? await db.tasks.assigneesFor(taskIds)
      : {};
  const watchersByTask: Record<string, string[]> =
    db.tasks && db.tasks.watchersFor ? await db.tasks.watchersFor(taskIds) : {};
  // ONE query for every task's attachment summaries (feature #51) — batched like
  // assignees/watchers so a full page never does a per-task attachments read.
  const attachmentsByTask: Record<string, any[]> =
    db.tasks && db.tasks.attachmentsFor
      ? await db.tasks.attachmentsFor(taskIds)
      : {};
  // ONE query for every task's subtask progress (feature #52a) — batched like
  // assignees/watchers/attachments so a full page costs a single GROUP BY count,
  // never a per-task children read.
  const progressByTask: Record<string, { total: number; done: number }> =
    db.tasks && db.tasks.subtaskProgressFor
      ? await db.tasks.subtaskProgressFor(taskIds)
      : {};
  // ONE query for every task's linked project (#52b) — batched like the others so
  // a full page never does a per-task project read. Keyed by project id.
  const projectIds = [
    ...new Set(list.map((t) => t.projectId).filter(Boolean)),
  ];
  const projectsById: Record<string, any> =
    projectIds.length && db.tasks && db.tasks.projectsForIds
      ? await db.tasks.projectsForIds(projectIds)
      : {};
  // Collect EVERY distinct user id we will serialize (all assignees across all
  // tasks + each reporter) so the users batch is still a single query.
  const ids = new Set<string>();
  for (const t of list) {
    const a = assigneesByTask[t.id];
    if (a && a.length) for (const uid of a) ids.add(uid);
    else if (t.assigneeId) ids.add(t.assigneeId); // pre-back-fill fallback
    if (t.reporterId) ids.add(t.reporterId);
  }
  const usersById = new Map<string, any>();
  if (ids.size) {
    const idList = [...ids];
    if (db.users.getByIds) {
      const rows = await db.users.getByIds(idList);
      for (const u of rows || []) if (u && u.id) usersById.set(u.id, u);
    } else {
      // Fallback driver without a batch getter: resolve once per distinct id
      // (still far fewer than per-task) and cache.
      for (const id of idList) usersById.set(id, await db.users.getById(id));
    }
  }
  return Promise.all(
    list.map((t) =>
      serializeTask(
        t,
        usersById,
        assigneesByTask,
        watchersByTask,
        attachmentsByTask,
        progressByTask,
        projectsById,
      ),
    ),
  );
}

// PROJECTS-AS-ENTITIES (#52b): a project DTO → its API shape.
function serializeProject(p) {
  return p && {
    id: p.id,
    name: p.name,
    color: p.color || "#64748b",
    archived: !!p.archived,
    createdAt: p.createdAt || null,
  };
}
// SAVED VIEWS / SWIMLANES (#52b): a saved-view DTO → its API shape.
function serializeSavedView(v) {
  return v && {
    id: v.id,
    name: v.name,
    filter: v.filter || {},
    groupBy: v.groupBy || "none",
    sort: v.sort || "created",
    createdAt: v.createdAt || null,
    updatedAt: v.updatedAt || null,
  };
}

async function serializeTaskActivity(a) {
  const actor = a.actorId ? pubUser(await db.users.getById(a.actorId)) : null;
  return {
    id: a.id,
    kind: a.kind,
    detail: a.detail || null,
    actor,
    createdAt: a.createdAt,
  };
}
async function serializeTaskComment(c) {
  const author = c.authorId
    ? pubUser(await db.users.getById(c.authorId))
    : null;
  return { id: c.id, body: c.body, author, createdAt: c.createdAt };
}

async function serializeVoicemail(vm) {
  const from = vm.fromUser ? await db.users.getById(vm.fromUser) : null;
  return {
    id: vm.id,
    callId: vm.callId,
    durationSec: vm.durationSec,
    listened: vm.listened,
    createdAt: vm.createdAt,
    time: hhmm(vm.createdAt),
    from: pubUser(from) || {
      id: vm.fromUser,
      name: "Unknown",
      initials: "?",
      color: "#94A3B8",
    },
  };
}

export {
  serializeConversation,
  serializeConversationList,
  serializeMessage,
  serializeMessageList,
  serializeMember,
  serializeMemberList,
  serializeMeeting,
  serializeMeetingList,
  serializeReminder,
  serializeFolder,
  serializeCall,
  serializeVoicemail,
  serializeTask,
  serializeTaskList,
  serializeTaskActivity,
  serializeTaskComment,
  serializeProject,
  serializeSavedView,
  extractLinks,
  pubUser,
  userAvatarUrl,
  hhmm,
};
