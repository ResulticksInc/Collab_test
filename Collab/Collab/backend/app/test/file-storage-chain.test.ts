import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { Readable } from "stream";
import { useTestDatabase } from "./_setup";

// FILE UPLOAD STORAGE CHAIN (docs/FILE_UPLOAD_STORAGE_CHAIN.md): disk → s3 → db.
//
// Runs the REAL fileService/diskStorageService/fileGcService/fileTierService
// against the throwaway test DB. The S3 tier is pointed at a closed port so it
// fails FAST and deterministically (ECONNREFUSED, 1 attempt, short connect
// timeout) — no MinIO is needed. The disk tier is a per-run temp directory; the
// "disk unavailable" cases flip it read-only, so they skip when running as root
// (root ignores file modes).
//
// FILE_BLOB_FALLBACK_MAX_BYTES is lowered to 1 MB so the "large / streamed"
// cases only need a 2 MB body.

let dbUp = false;
let db: any;
let fileService: any;
let disk: any;
let gc: any;
let tier: any;

const OWNER = "u_fsc_owner";
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "colab-files-"));
const SMALL = Buffer.from("hello storage chain — small buffered upload\n".repeat(50));
const LARGE = Buffer.alloc(2 * 1024 * 1024, 7); // 2 MB > 1 MB cap → streamed

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

// Flip EVERY directory under the root (not just the root) to `mode`: a
// read-only root alone still lets a write succeed inside a dated subdirectory
// an earlier upload already created.
function setDirsMode(mode: number) {
  const stack = [ROOT];
  while (stack.length) {
    const d = stack.pop()!;
    for (const ent of fs.readdirSync(d, { withFileTypes: true }))
      if (ent.isDirectory()) stack.push(path.join(d, ent.name));
    fs.chmodSync(d, mode);
  }
}

before(async () => {
  await useTestDatabase();
  process.env.AUTH_JWT_SECRET = "test-secret-colab";
  process.env.LIVEKIT_API_KEY = "testkey";
  process.env.LIVEKIT_API_SECRET = "testsecret_at_least_32_characters_long_xx";
  process.env.LIVEKIT_WS_URL = "ws://localhost:7534";
  // Storage chain under test.
  process.env.FILE_STORAGE_ORDER = "disk,s3,db";
  process.env.FILE_STORAGE_DIR = ROOT;
  process.env.FILE_STORAGE_MIN_FREE_BYTES = "0";
  process.env.FILE_BLOB_FALLBACK_MAX_BYTES = String(1024 * 1024);
  process.env.S3_ENDPOINT = "http://127.0.0.1:1"; // nothing listens → ECONNREFUSED
  process.env.S3_PUBLIC_ENDPOINT = "http://127.0.0.1:1";
  process.env.S3_CONNECT_TIMEOUT_MS = "1000";
  process.env.S3_REQUEST_TIMEOUT_MS = "1000";
  process.env.S3_MAX_ATTEMPTS = "1";
  process.env.FILES_GC_RETENTION_DAYS = "30";

  try {
    const { migrate } = await import("../../../database/src");
    const platform = await import("../src/platform");
    db = platform.db;
    await migrate(platform.config.database.url);
    fileService = await import("../src/services/fileService");
    disk = await import("../src/services/diskStorageService");
    gc = await import("../src/services/fileGcService");
    tier = await import("../src/services/fileTierService");
    await db.users.upsert({
      id: OWNER,
      email: OWNER + "@ex.com",
      name: "FSC Owner",
      initials: "FS",
      color: "#2563EB",
      presence: "off",
      passwordHash: null,
    });
    dbUp = true;
  } catch (e: any) {
    console.error("[test] MySQL unavailable — DB cases will skip:", e.message);
  }
});

after(async () => {
  try {
    setDirsMode(0o700);
  } catch {
    /* ignore */
  }
  fs.rmSync(ROOT, { recursive: true, force: true });
  if (db?.pool?.end) await db.pool.end();
});

const dbTest = (name: string, fn: any) =>
  test(name, async (t) => {
    if (!dbUp) {
      t.skip("MySQL not available");
      return;
    }
    await fn(t);
  });

async function readAll(stream: any): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

const upload = (name: string, body: Buffer) =>
  fileService.create({
    uploaderId: OWNER,
    name,
    mime: "application/octet-stream",
    stream: Readable.from([body]),
    size: body.length,
    conversationId: null,
  });

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("tierOrder parses FILE_STORAGE_ORDER and effectiveBackend infers legacy rows", async (t) => {
  if (!dbUp) return t.skip("MySQL not available");
  assert.deepEqual(fileService.tierOrder(), ["disk", "s3", "db"]);
  assert.equal(fileService.effectiveBackend({ storageKey: "k" }), "s3");
  assert.equal(fileService.effectiveBackend({}), "db");
  assert.equal(fileService.effectiveBackend({ storageKey: "k", storageBackend: "disk" }), "disk");
});

test("disk driver rejects keys that escape the root", async (t) => {
  if (!dbUp) return t.skip("MySQL not available");
  await assert.rejects(() => disk.upload("../../evil", Buffer.from("x")), /Invalid storage key/);
  await assert.rejects(() => disk.remove("../x"), /Invalid storage key/);
  await assert.rejects(() => disk.getStream("/etc/passwd"), /Invalid storage key/);
});

// ---------------------------------------------------------------------------
// Upload chain
// ---------------------------------------------------------------------------

let diskSmallId = "";
let diskSmallKey = "";

dbTest("small upload lands on the disk tier, not in the DB", async () => {
  const f = await upload("small.txt", SMALL);
  diskSmallId = f.id;
  const meta = await db.files.getMeta(f.id);
  assert.equal(meta.storageBackend, "disk");
  assert.ok(meta.storageKey);
  diskSmallKey = meta.storageKey;
  const abs = path.join(ROOT, meta.storageKey);
  assert.ok(fs.existsSync(abs), "object exists under FILE_STORAGE_DIR");
  assert.ok(!fs.existsSync(abs + ".part"), "no temp file left behind");
  assert.equal(fs.readFileSync(abs).equals(SMALL), true);
  const row = await db.files.getData(f.id);
  assert.equal(row.data, null, "LONGBLOB stays empty for a disk-tier file");
});

dbTest("large (streamed) upload lands on the disk tier and downloads byte-identical", async () => {
  const f = await upload("large.bin", LARGE);
  const meta = await db.files.getMeta(f.id);
  assert.equal(meta.storageBackend, "disk");
  const dl = await fileService.getDownload({ fileId: f.id, userId: OWNER });
  assert.ok(dl.stream, "streamed download");
  assert.equal(dl.contentLength, LARGE.length);
  const got = await readAll(dl.stream);
  assert.equal(got.equals(LARGE), true);
});

dbTest("disk-tier download honours Range (206) and rejects an unsatisfiable range (416)", async () => {
  const part = await fileService.getDownload({ fileId: diskSmallId, userId: OWNER, range: "bytes=2-5" });
  assert.equal(part.statusCode, 206);
  assert.equal(part.contentRange, `bytes 2-5/${SMALL.length}`);
  assert.equal(part.partialLength, 4);
  assert.equal(part.contentLength, SMALL.length, "full size still advertised for the ETag");
  assert.equal((await readAll(part.stream)).equals(SMALL.subarray(2, 6)), true);
  await assert.rejects(
    () => fileService.getDownload({ fileId: diskSmallId, userId: OWNER, range: `bytes=${SMALL.length + 10}-` }),
    (e: any) => e.status === 416 && e.code === "RANGE_NOT_SATISFIABLE",
  );
});

dbTest("presigned URL is only offered for S3-backed files", async () => {
  assert.equal(await fileService.getPresignedUrl({ fileId: diskSmallId, userId: OWNER }), null);
});

dbTest("disk + S3 unavailable → small upload falls back to the DB tier", async (t) => {
  if (isRoot) return t.skip("root ignores read-only dirs");
  setDirsMode(0o500); // read-only → disk.upload fails (EACCES)
  try {
    const f = await upload("fallback.txt", SMALL);
    const meta = await db.files.getMeta(f.id);
    assert.equal(meta.storageBackend, "db");
    assert.equal(meta.storageKey, null);
    const dl = await fileService.getDownload({ fileId: f.id, userId: OWNER });
    assert.ok(!dl.stream);
    assert.equal(Buffer.from(dl.data).equals(SMALL), true);
  } finally {
    setDirsMode(0o700);
  }
});

dbTest("disk + S3 unavailable → large upload is an honest 503 and leaves no row", async (t) => {
  if (isRoot) return t.skip("root ignores read-only dirs");
  const before = (await fileService.listForUser(OWNER, { tab: "owned" })).count;
  setDirsMode(0o500);
  try {
    await assert.rejects(
      () => upload("big-fail.bin", LARGE),
      (e: any) => {
        assert.equal(e.status, 503);
        assert.equal(e.code, "STORAGE_UNAVAILABLE");
        assert.equal(e.expose, true);
        // Admin → Server Logs must say WHY each tier refused the file (seen on
        // run, 8 Oct 2026: a bare "couldn't be saved" with no tier reasons).
        const tiers = Object.fromEntries((e.details?.tiers || []).map((t: any) => [t.tier, t.outcome]));
        assert.match(tiers.disk || "", /^failed — /, JSON.stringify(e.details));
        assert.match(tiers.s3 || "", /^failed — /, JSON.stringify(e.details));
        assert.match(tiers.db || "", /^skipped — /, "the db tier is skipped for a large streamed upload");
        assert.equal(e.details.file.name, "big-fail.bin");
        assert.equal(e.details.tierOrder, "disk,s3,db");
        return true;
      },
    );
  } finally {
    setDirsMode(0o700);
  }
  const after = (await fileService.listForUser(OWNER, { tab: "owned" })).count;
  assert.equal(after, before, "no file row for a failed upload");
});

// ---------------------------------------------------------------------------
// GC + cold tier
// ---------------------------------------------------------------------------

dbTest("GC removes the disk object and hard-deletes the row after retention", async () => {
  await fileService.remove({ fileId: diskSmallId, userId: OWNER });
  await db.pool.query("UPDATE files SET deleted_at = DATE_SUB(NOW(3), INTERVAL 40 DAY) WHERE id = ?", [diskSmallId]);
  const r = await gc.runGc(30, 50);
  assert.ok(r.removedIds.includes(diskSmallId), "row reclaimed");
  assert.ok(!fs.existsSync(path.join(ROOT, diskSmallKey)), "disk object removed");
  assert.equal(await db.files.getDeletedMeta(diskSmallId), null);
});

dbTest("cold-tier job leaves a file on disk when S3 is unreachable", async () => {
  const f = await upload("cold.txt", SMALL);
  await db.pool.query("UPDATE files SET created_at = DATE_SUB(NOW(), INTERVAL 40 DAY) WHERE id = ?", [f.id]);
  const r = await tier.runTier({ coldAfterDays: 30, pressurePct: 0, batch: 10, enabled: true });
  // Since 8 Oct 2026 the run is PAUSED by a failed readiness ping before any
  // file is read off disk (no per-file 30 s upload timeouts against a dead
  // MinIO), so nothing is scanned — the outcome that matters is unchanged.
  assert.equal(r.s3Unreachable, true, JSON.stringify(r));
  assert.equal(r.moved, 0);
  const meta = await db.files.getMeta(f.id);
  assert.equal(meta.storageBackend, "disk", "row untouched");
  assert.ok(fs.existsSync(path.join(ROOT, meta.storageKey)), "disk copy untouched");
});

dbTest("cold-tier job is a no-op when disabled", async () => {
  const r = await tier.runTier({ enabled: false });
  assert.equal(r.disabled, true);
});

dbTest("disk ping reports the configured root and free space", async () => {
  const p = await disk.ping();
  assert.equal(p.dir, path.resolve(ROOT));
  assert.ok(p.freeBytes > 0);
  assert.ok(p.usedPct >= 0 && p.usedPct <= 100);
});
