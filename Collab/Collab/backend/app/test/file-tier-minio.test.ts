import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import { Readable } from "stream";
import { useTestDatabase } from "./_setup";

// Cold-tier job POSITIVE path — needs a real MinIO (the dev compose one on
// localhost:9003). Skips cleanly when none is listening. Verifies: disk → S3
// copy under the same key, row flipped to s3, disk copy removed, download now
// streams from S3 byte-identical, and a presigned URL becomes available.

const S3_HOST = process.env.TEST_S3_HOST || "127.0.0.1";
const S3_PORT = Number(process.env.TEST_S3_PORT || 9003);

function portOpen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (v: boolean) => { try { s.destroy(); } catch {} resolve(v); };
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
    s.setTimeout(1000, () => done(false));
  });
}

let ready = false;
let db: any;
let fileService: any;
let tier: any;
let storage: any;
const OWNER = "u_ftm_owner";
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "colab-files-tier-"));
const BODY = Buffer.from("cold tier move body\n".repeat(200));
const createdKeys: string[] = [];

before(async () => {
  await useTestDatabase();
  process.env.AUTH_JWT_SECRET = "test-secret-colab";
  process.env.LIVEKIT_API_KEY = "testkey";
  process.env.LIVEKIT_API_SECRET = "testsecret_at_least_32_characters_long_xx";
  process.env.LIVEKIT_WS_URL = "ws://localhost:7534";
  process.env.FILE_STORAGE_ORDER = "disk,s3,db";
  process.env.FILE_STORAGE_DIR = ROOT;
  process.env.FILE_STORAGE_MIN_FREE_BYTES = "0";
  process.env.S3_ENDPOINT = `http://${S3_HOST}:${S3_PORT}`;
  process.env.S3_PUBLIC_ENDPOINT = `http://${S3_HOST}:${S3_PORT}`;
  process.env.S3_BUCKET = process.env.TEST_S3_BUCKET || "colab-files-test";
  process.env.S3_ACCESS_KEY_ID = process.env.S3_ACCESS_KEY_ID || "colabminio";
  process.env.S3_SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY || "colabminio123";
  process.env.S3_CONNECT_TIMEOUT_MS = "2000";
  process.env.S3_MAX_ATTEMPTS = "1";
  if (!(await portOpen(S3_HOST, S3_PORT))) {
    console.error(`[test] no MinIO on ${S3_HOST}:${S3_PORT} — tier move cases will skip`);
    return;
  }
  try {
    const { migrate } = await import("../../../database/src");
    const platform = await import("../src/platform");
    db = platform.db;
    await migrate(platform.config.database.url);
    fileService = await import("../src/services/fileService");
    tier = await import("../src/services/fileTierService");
    storage = await import("../src/services/storageService");
    await storage.pingBucket().catch(() => storage.ensureBucket());
    await db.users.upsert({ id: OWNER, email: OWNER + "@ex.com", name: "FTM Owner", initials: "FT", color: "#2563EB", presence: "off", passwordHash: null });
    ready = true;
  } catch (e: any) {
    console.error("[test] MySQL/MinIO unavailable — tier move cases will skip:", e.message);
  }
});

after(async () => {
  for (const k of createdKeys) await storage?.remove(k).catch(() => {});
  fs.rmSync(ROOT, { recursive: true, force: true });
  if (db?.pool?.end) await db.pool.end();
});

async function readAll(stream: any): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

test("cold-tier job moves an aged disk file to S3 and reads keep working", async (t) => {
  if (!ready) return t.skip("MySQL or MinIO not available");
  const f = await fileService.create({ uploaderId: OWNER, name: "move-me.txt", mime: "text/plain", stream: Readable.from([BODY]), size: BODY.length, conversationId: null });
  let meta = await db.files.getMeta(f.id);
  assert.equal(meta.storageBackend, "disk");
  createdKeys.push(meta.storageKey);
  const diskPath = path.join(ROOT, meta.storageKey);
  await db.pool.query("UPDATE files SET created_at = DATE_SUB(NOW(), INTERVAL 40 DAY) WHERE id = ?", [f.id]);

  const r = await tier.runTier({ coldAfterDays: 30, pressurePct: 0, batch: 10, enabled: true });
  assert.equal(r.moved, 1, JSON.stringify(r));
  assert.equal(r.movedBytes, BODY.length);

  meta = await db.files.getMeta(f.id);
  assert.equal(meta.storageBackend, "s3");
  assert.ok(!fs.existsSync(diskPath), "disk copy removed after the row points at S3");
  const dl = await fileService.getDownload({ fileId: f.id, userId: OWNER });
  assert.ok(dl.stream);
  assert.equal((await readAll(dl.stream)).equals(BODY), true, "bytes served from S3 match");
  const pre = await fileService.getPresignedUrl({ fileId: f.id, userId: OWNER });
  assert.ok(pre && /^https?:\/\//.test(pre.url), "presigned URL now available");
});

test("cold-tier job skips files younger than the threshold", async (t) => {
  if (!ready) return t.skip("MySQL or MinIO not available");
  const f = await fileService.create({ uploaderId: OWNER, name: "fresh.txt", mime: "text/plain", stream: Readable.from([BODY]), size: BODY.length, conversationId: null });
  const r = await tier.runTier({ coldAfterDays: 30, pressurePct: 0, batch: 10, enabled: true });
  assert.equal(r.moved, 0);
  const meta = await db.files.getMeta(f.id);
  assert.equal(meta.storageBackend, "disk");
});

// Production, 8 Oct 2026: the files volume sat above FILE_TIER_PRESSURE_PCT
// while the backend could not reach MinIO. Pressure mode then moved the oldest
// files — including attachments shared minutes earlier — into a MinIO nobody
// could read from, and web clients showed "Storage unavailable". Two rules now:
// a run is PAUSED when object storage doesn't answer a quick ping, and
// pressure mode never touches a file younger than the min age.
test("pressure mode leaves a file younger than the min age on disk", async (t) => {
  if (!ready) return t.skip("MySQL or MinIO not available");
  const f = await fileService.create({ uploaderId: OWNER, name: "fresh-under-pressure.txt", mime: "text/plain", stream: Readable.from([BODY]), size: BODY.length, conversationId: null });
  const meta0 = await db.files.getMeta(f.id);
  createdKeys.push(meta0.storageKey);
  // pressurePct 1 → any real volume is "under pressure"; min age 1 day.
  const r = await tier.runTier({ coldAfterDays: 30, pressurePct: 1, pressureMinAgeDays: 1, batch: 10, enabled: true });
  assert.equal(r.pressure, true, "the run was in pressure mode");
  const meta = await db.files.getMeta(f.id);
  assert.equal(meta.storageBackend, "disk", "a file shared today stays on the fast tier");
});

test("a run is paused — nothing moved, nothing deleted — when object storage does not answer", async (t) => {
  if (!ready) return t.skip("MySQL or MinIO not available");
  const f = await fileService.create({ uploaderId: OWNER, name: "stay-put.txt", mime: "text/plain", stream: Readable.from([BODY]), size: BODY.length, conversationId: null });
  const meta0 = await db.files.getMeta(f.id);
  const diskPath = path.join(ROOT, meta0.storageKey);
  await db.pool.query("UPDATE files SET created_at = DATE_SUB(NOW(), INTERVAL 40 DAY) WHERE id = ?", [f.id]);
  const dead = async () => { const e: any = new Error("connect ECONNREFUSED"); e.code = "ECONNREFUSED"; throw e; };
  const r = await tier.runTier({ coldAfterDays: 30, pressurePct: 1, pressureMinAgeDays: 0, batch: 10, enabled: true, pingS3: dead });
  assert.equal(r.s3Unreachable, true, JSON.stringify(r));
  assert.equal(r.moved, 0);
  const meta = await db.files.getMeta(f.id);
  assert.equal(meta.storageBackend, "disk", "the row still points at disk");
  assert.ok(fs.existsSync(diskPath), "the disk copy is untouched");
  // And a slow ping (hangs) is treated the same, within the ping timeout.
  const hang = () => new Promise<void>(() => {});
  const r2 = await tier.runTier({ coldAfterDays: 30, pressurePct: 1, pressureMinAgeDays: 0, batch: 10, enabled: true, pingS3: hang });
  assert.equal(r2.s3Unreachable, true);
  // Reachable again → the aged file moves as before.
  const r3 = await tier.runTier({ coldAfterDays: 30, pressurePct: 0, batch: 10, enabled: true });
  assert.equal(r3.moved, 1, JSON.stringify(r3));
  createdKeys.push(meta0.storageKey);
});
