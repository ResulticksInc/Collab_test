import { config } from "../platform";

let redisClient: any = null;
const memoryStore = new Map<string, number>();

const REDIS_PREFIX = "jwt:block:";

async function initRedis() {
  if (redisClient !== null) return;
  if (!config.redis?.url) {
    redisClient = false;
    return;
  }
  try {
    const redis = await import("redis");
    // Fail fast if Redis is unreachable (REDIS_URL set but Redis down). The
    // default node-redis reconnect strategy retries forever and HANGS connect(),
    // which — since isBlocked() runs on every authed request — would freeze the
    // whole API. reconnectStrategy:false + bounded connect + a race cap make it
    // reject so we fall back to the in-memory store. Graceful degradation.
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

function tokenKey(token: string): string {
  const parts = token.split(".");
  return parts.length === 3 ? parts[2] : token;
}

async function add(token: string, expiresAt: number) {
  await initRedis();
  const key = tokenKey(token);
  const ttlSec = Math.max(1, Math.ceil((expiresAt * 1000 - Date.now()) / 1000));
  if (redisClient) {
    await redisClient.set(REDIS_PREFIX + key, "1", { EX: ttlSec });
  } else {
    memoryStore.set(key, expiresAt * 1000);
  }
}

async function isBlocked(token: string): Promise<boolean> {
  await initRedis();
  const key = tokenKey(token);
  if (redisClient) {
    return !!(await redisClient.get(REDIS_PREFIX + key));
  }
  const expiry = memoryStore.get(key);
  if (!expiry) return false;
  if (Date.now() > expiry) {
    memoryStore.delete(key);
    return false;
  }
  return true;
}

function pruneMemory() {
  const now = Date.now();
  for (const [k, exp] of memoryStore) {
    if (now > exp) memoryStore.delete(k);
  }
}
setInterval(pruneMemory, 60_000);

export { add, isBlocked };
