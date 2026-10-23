import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { Readable } from "stream";
import { useTestDatabase } from "./_setup";

// FILE_STORAGE_ORDER=s3,db — the rollback switch — must reproduce the pre-0127
// behaviour exactly: small uploads fall back to the DB when S3 is down, large
// uploads are an honest 503, and the disk tier is never touched.

let dbUp = false;
let db: any;
let fileService: any;
const OWNER = "u_fso_owner";
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "colab-files-legacy-"));
const SMALL = Buffer.from("legacy order\n".repeat(100));
const LARGE = Buffer.alloc(2 * 1024 * 1024, 3);

before(async () => {
  await useTestDatabase();
  process.env.AUTH_JWT_SECRET = "test-secret-colab";
  process.env.LIVEKIT_API_KEY = "testkey";
  process.env.LIVEKIT_API_SECRET = "testsecret_at_least_32_characters_long_xx";
  process.env.LIVEKIT_WS_URL = "ws://localhost:7534";
  process.env.FILE_STORAGE_ORDER = "s3,db";
  process.env.FILE_STORAGE_DIR = ROOT;
  process.env.FILE_BLOB_FALLBACK_MAX_BYTES = String(1024 * 1024);
  process.env.S3_ENDPOINT = "http://127.0.0.1:1";
  process.env.S3_PUBLIC_ENDPOINT = "http://127.0.0.1:1";
  process.env.S3_CONNECT_TIMEOUT_MS = "1000";
  process.env.S3_REQUEST_TIMEOUT_MS = "1000";
  process.env.S3_MAX_ATTEMPTS = "1";
  try {
    const { migrate } = await import("../../../database/src");
    const platform = await import("../src/platform");
    db = platform.db;
    await migrate(platform.config.database.url);
    fileService = await import("../src/services/fileService");
    await db.users.upsert({ id: OWNER, email: OWNER + "@ex.com", name: "FSO Owner", initials: "FO", color: "#2563EB", presence: "off", passwordHash: null });
    dbUp = true;
  } catch (e: any) {
    console.error("[test] MySQL unavailable — DB cases will skip:", e.message);
  }
});

after(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  if (db?.pool?.end) await db.pool.end();
});

const upload = (name: string, body: Buffer) =>
  fileService.create({ uploaderId: OWNER, name, mime: "application/octet-stream", stream: Readable.from([body]), size: body.length, conversationId: null });

test("s3,db: small upload falls back to the DB and never touches the disk tier", async (t) => {
  if (!dbUp) return t.skip("MySQL not available");
  assert.deepEqual(fileService.tierOrder(), ["s3", "db"]);
  const f = await upload("legacy-small.txt", SMALL);
  const meta = await db.files.getMeta(f.id);
  assert.equal(meta.storageBackend, "db");
  assert.equal(meta.storageKey, null);
  assert.deepEqual(fs.readdirSync(ROOT), [], "disk tier untouched");
});

test("s3,db: large upload is an honest 503 when S3 is down", async (t) => {
  if (!dbUp) return t.skip("MySQL not available");
  await assert.rejects(() => upload("legacy-large.bin", LARGE), (e: any) => e.status === 503 && e.code === "STORAGE_UNAVAILABLE");
  assert.deepEqual(fs.readdirSync(ROOT), [], "disk tier untouched");
});
