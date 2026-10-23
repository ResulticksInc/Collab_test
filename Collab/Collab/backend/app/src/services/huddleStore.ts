import { config } from "../platform";

// Cost-free, IT-dependency-free store for the two ephemeral call/meeting maps
// that previously lived as in-process Maps in realtime/socket.ts — huddle
// membership (group calls) and raised hands (meetings). Mirrors the proven
// tokenBlocklist pattern EXACTLY: use the Redis already in docker-compose when
// REDIS_URL is configured (so state is shared across backend replicas and group
// calls/meetings stay correct horizontally), and fall back to the SAME in-process
// Maps otherwise — so the zero-config single-instance dev path is byte-identical
// to today. No new dependency (the `redis` package is already used), no schema,
// no ops. Keys self-expire via a TTL refreshed on every write (no cleanup job).

let redisClient: any = null;
const HKEY = (cid: string) => `huddle:${cid}`; // hash: userId->name, plus __kind__->kind, __starter__->userId
const RKEY = (mid: string) => `hands:${mid}`; // set of userIds
const RUNG = (cid: string) => `huddle:rung:${cid}`; // set of userIds rung by push for this huddle (K3)
const TTL_SEC = 60 * 60 * 12; // 12h safety expiry, refreshed on every write
const KIND = "__kind__"; // reserved hash field (userIds are UUIDs, never collide)
const STARTER = "__starter__"; // reserved hash field: the userId who STARTED the call (first joiner) — the call "host"

// In-process fallback — IDENTICAL shapes to the old socket.ts maps.
const huddles = new Map<
  string,
  { kind: string; parts: Map<string, string>; starter?: string }
>();
const raisedHands = new Map<string, Set<string>>();
const rungUsers = new Map<string, Set<string>>();

async function init() {
  if (redisClient !== null) return;
  if (!config.redis?.url) {
    redisClient = false;
    return;
  }
  try {
    const redis = await import("redis");
    // CRITICAL: fail FAST if Redis is unreachable. With node-redis's default
    // reconnect strategy, connect() retries forever and HANGS — which would
    // freeze every huddle/hand op when REDIS_URL is set but Redis is down. With
    // reconnectStrategy:false + a bounded connectTimeout, connect() rejects, we
    // fall back to the in-process Map, and the app degrades gracefully (no IT
    // dependency). The Promise.race is a belt-and-suspenders cap on any hang.
    const client = redis.createClient({
      url: config.redis.url,
      socket: { reconnectStrategy: false, connectTimeout: 3000 },
    });
    client.on("error", () => {});
    await Promise.race([
      client.connect(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("redis connect timeout")), 3500)),
    ]);
    redisClient = client;
  } catch {
    redisClient = false;
  }
}

// ---- Huddles (group calls) -------------------------------------------------
// Returns TRUE iff this add created the huddle (the caller is the FIRST
// participant) — computed ATOMICALLY so two simultaneous joins into an empty
// huddle can't both think they were first (which would double-post a
// "Group call started" system line). Redis: HSETNX on the reserved __kind__
// field is a single atomic op — exactly one concurrent caller sets it. In-proc:
// the check+set runs synchronously (no await between them) so it's atomic on
// Node's single thread.
export async function huddleAdd(cid: string, userId: string, name: string, kind: string): Promise<boolean> {
  await init();
  if (redisClient) {
    try {
      const wasFirst = await redisClient.hSetNX(HKEY(cid), KIND, kind);
      // Stamp the STARTER atomically alongside the kind — HSETNX means only the
      // very first joiner sticks, so the "host" of a group call is durably the
      // person who started it (survives their reconnects; changes only if the
      // huddle empties and is recreated). Reserved field, never a real userId.
      if (wasFirst) await redisClient.hSetNX(HKEY(cid), STARTER, userId);
      await redisClient.hSet(HKEY(cid), { [userId]: name });
      await redisClient.expire(HKEY(cid), TTL_SEC);
      return !!wasFirst;
    } catch {
      // Redis blipped mid-session — drop the dead client (init() re-attempts on
      // the next call) and fall through to the in-process Map so the roster op
      // still applies instead of throwing and half-breaking the huddle.
      redisClient = null;
    }
  }
  let h = huddles.get(cid);
  const first = !h || h.parts.size === 0;
  if (!h) { h = { kind, parts: new Map(), starter: userId }; huddles.set(cid, h); }
  else if (first && !h.starter) h.starter = userId;
  h.parts.set(userId, name);
  return first;
}

// Returns TRUE iff this removal emptied the huddle (the caller was the LAST
// participant) — atomic so two simultaneous final leaves can't both post
// "Group call ended". Redis: DEL returns 1 only for the caller that actually
// removed the now-empty key (the other gets 0). In-proc: synchronous check+set.
export async function huddleRemove(cid: string, userId: string): Promise<boolean> {
  await init();
  if (redisClient) {
    try {
      await redisClient.hDel(HKEY(cid), userId);
      const remaining: string[] = await redisClient.hKeys(HKEY(cid));
      // Exclude BOTH reserved fields — otherwise a lingering __starter__ would
      // keep the "remaining" count > 0 forever, so the huddle never reports empty
      // (no "call ended" pill) and the key leaks until its TTL.
      if (remaining.filter((k) => k !== KIND && k !== STARTER).length === 0) {
        const deleted = await redisClient.del(HKEY(cid));
        return deleted === 1;
      }
      await redisClient.expire(HKEY(cid), TTL_SEC);
      return false;
    } catch {
      redisClient = null;
    }
  }
  const h = huddles.get(cid);
  if (!h) return false;
  const had = h.parts.has(userId);
  h.parts.delete(userId);
  if (h.parts.size === 0) { huddles.delete(cid); return had; }
  return false;
}

// Returns { kind, participants:[{id,name}] }; kind null when no live huddle.
export async function huddleGet(
  cid: string,
): Promise<{ kind: string | null; participants: { id: string; name: string }[] }> {
  await init();
  if (redisClient) {
    try {
      const all: Record<string, string> = await redisClient.hGetAll(HKEY(cid));
      const kind = all[KIND] ?? null;
      const participants = Object.entries(all)
        .filter(([k]) => k !== KIND && k !== STARTER)
        .map(([id, name]) => ({ id, name: String(name) }));
      return { kind: participants.length ? kind : null, participants };
    } catch {
      redisClient = null;
    }
  }
  const h = huddles.get(cid);
  return {
    kind: h ? h.kind : null,
    participants: h ? Array.from(h.parts, ([id, name]) => ({ id, name })) : [],
  };
}

// Conversation ids that currently have a live huddle (≥1 participant). Used by the
// reconciler that evicts ghost participants whose client never sent a leave.
export async function huddleActiveIds(): Promise<string[]> {
  await init();
  if (redisClient) {
    try {
      const ids: string[] = [];
      for await (const k of redisClient.scanIterator({ MATCH: "huddle:*", COUNT: 200 })) {
        const key = String(k);
        if (key.startsWith("huddle:rung:")) continue; // the ring roster, not a huddle
        ids.push(key.slice("huddle:".length));
      }
      return ids;
    } catch {
      redisClient = null;
    }
  }
  return Array.from(huddles.entries())
    .filter(([, h]) => h.parts.size > 0)
    .map(([cid]) => cid);
}

export async function huddleHas(cid: string, userId: string): Promise<boolean> {
  await init();
  if (redisClient) {
    try {
      return !!(await redisClient.hExists(HKEY(cid), userId));
    } catch {
      redisClient = null;
    }
  }
  const h = huddles.get(cid);
  return !!(h && h.parts.has(userId));
}

// Who STARTED this group call (the "host" for participant-control purposes).
// Returns null when there's no live huddle or the starter is unknown.
export async function huddleStarter(cid: string): Promise<string | null> {
  await init();
  if (redisClient) {
    try {
      const s = await redisClient.hGet(HKEY(cid), STARTER);
      return s || null;
    } catch {
      redisClient = null;
    }
  }
  const h = huddles.get(cid);
  return (h && h.starter) || null;
}

// ---- Rung-by-push roster (K3) ---------------------------------------------
// Who was RUNG for this huddle (HUDDLE_RING → push) and hasn't joined yet. A
// terminated phone rings from that push and has no socket to learn the call
// was answered elsewhere / ended, so the ring must be RETRACTED by push too.
// Cluster-safe like the roster above (ring and join may land on different
// replicas). Self-expires with the huddle TTL.
export async function huddleRungAdd(cid: string, userIds: string[]): Promise<void> {
  const ids = (userIds || []).filter(Boolean);
  if (!ids.length) return;
  await init();
  if (redisClient) {
    try {
      await redisClient.sAdd(RUNG(cid), ids);
      await redisClient.expire(RUNG(cid), TTL_SEC);
      return;
    } catch {
      redisClient = null;
    }
  }
  let set = rungUsers.get(cid);
  if (!set) { set = new Set(); rungUsers.set(cid, set); }
  for (const id of ids) set.add(id);
}

// Remove ONE rung user (they joined / declined). Returns true iff they were
// rung — the caller only retracts a ring that was actually sent.
export async function huddleRungTake(cid: string, userId: string): Promise<boolean> {
  await init();
  if (redisClient) {
    try {
      return (await redisClient.sRem(RUNG(cid), userId)) > 0;
    } catch {
      redisClient = null;
    }
  }
  const set = rungUsers.get(cid);
  if (!set || !set.has(userId)) return false;
  set.delete(userId);
  if (!set.size) rungUsers.delete(cid);
  return true;
}

// Drain EVERY still-rung user (the huddle ended) — atomic in Redis (one caller
// gets the members, the key is gone for everyone else).
export async function huddleRungDrain(cid: string): Promise<string[]> {
  await init();
  if (redisClient) {
    try {
      const members: string[] = await redisClient.sMembers(RUNG(cid));
      if (members.length) await redisClient.del(RUNG(cid));
      return members;
    } catch {
      redisClient = null;
    }
  }
  const set = rungUsers.get(cid);
  rungUsers.delete(cid);
  return set ? Array.from(set) : [];
}

// ---- Raised hands (meetings) ----------------------------------------------
export async function handAdd(mid: string, userId: string) {
  await init();
  if (redisClient) {
    await redisClient.sAdd(RKEY(mid), userId);
    await redisClient.expire(RKEY(mid), TTL_SEC);
  } else {
    if (!raisedHands.has(mid)) raisedHands.set(mid, new Set());
    raisedHands.get(mid)!.add(userId);
  }
}

export async function handRemove(mid: string, userId: string) {
  await init();
  if (redisClient) {
    await redisClient.sRem(RKEY(mid), userId);
  } else {
    const s = raisedHands.get(mid);
    if (s) { s.delete(userId); if (s.size === 0) raisedHands.delete(mid); }
  }
}

export async function handList(mid: string): Promise<string[]> {
  await init();
  if (redisClient) return await redisClient.sMembers(RKEY(mid));
  const s = raisedHands.get(mid);
  return s ? Array.from(s) : [];
}
