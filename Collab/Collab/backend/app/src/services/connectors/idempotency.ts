// Unified Connector Engine — distributed idempotency locks.
//
// Platforms redeliver: Slack retries an event the moment we take >3s, Graph
// re-sends notifications, WhatsApp replays after any non-2xx. The first copy
// must win and every later copy must be dropped, across every backend replica.
//
//   • Redis configured → atomic `SET key 1 NX PX ttl` (the spec's lock).
//   • No Redis         → per-process Map with the same semantics. Correct for a
//                        single instance; a multi-replica deployment sets
//                        REDIS_URL (REDIS_REQUIRED already enforces that in
//                        production).
//
// This is the FAST path. The DURABLE guard is the UNIQUE dedupe_key on
// connector_jobs and the (mapping, external id) key on message mappings — so a
// Redis flush or restart never lets a duplicate through either.
import { config } from "../../platform";

let redisClient: any = null;
const memory = new Map<string, number>();
const PREFIX = "colab:connectors:idem:";

async function initRedis() {
  if (redisClient !== null) return;
  if (!config.redis?.url) {
    redisClient = false;
    return;
  }
  try {
    const redis = await import("redis");
    // Same fail-fast posture as tokenBlocklist: a down Redis must degrade to
    // memory, not hang every inbound webhook on a never-ending reconnect.
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

function sweepMemory() {
  if (memory.size < 10_000) return;
  const now = Date.now();
  for (const [k, exp] of memory) if (exp <= now) memory.delete(k);
}

// Acquire the lock for `key`. TRUE = first time seen (proceed); FALSE = a
// duplicate within the TTL window (drop).
export async function acquire(key: string, ttlSec: number): Promise<boolean> {
  const ttl = Math.max(1, Math.round(ttlSec));
  await initRedis();
  if (redisClient) {
    try {
      const r = await redisClient.set(PREFIX + key, "1", { NX: true, PX: ttl * 1000 });
      return r === "OK";
    } catch {
      /* fall through to memory on a transient Redis error */
    }
  }
  const now = Date.now();
  const exp = memory.get(key);
  if (exp && exp > now) return false;
  memory.set(key, now + ttl * 1000);
  sweepMemory();
  return true;
}

