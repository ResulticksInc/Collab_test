import { S3Client, GetObjectCommand, DeleteObjectCommand, HeadBucketCommand, CreateBucketCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { config } from "../platform";
import { randomUUID } from "crypto";

// Fail FAST when object storage is unreachable. Without a connect timeout the
// SDK waits on the OS (a minute or more per attempt) and retries three times, so
// an upload against a dead MinIO hung for minutes before fileService could turn
// it into the 503 the user actually needs to see. Only the CONNECT is bounded —
// a large multipart part still gets as long as it needs once connected.
const connectTimeoutMs = Math.max(1000, Number(config.storage.connectTimeoutMs) || 5000);
const requestTimeoutMs = Math.max(1000, Number(config.storage.requestTimeoutMs) || 30000);
const maxAttempts = Math.max(1, Number(config.storage.maxAttempts) || 2);
const requestHandler = new NodeHttpHandler({
  connectionTimeout: connectTimeoutMs,
  requestTimeout: requestTimeoutMs,
});

// True when the error means "object storage didn't answer" (connect refused /
// timed out, DNS failure, socket idle timeout, reset) as opposed to a real S3
// answer such as NoSuchKey or AccessDenied. Callers turn these into an honest
// 503 so an outage reads as "storage unavailable" (ledger: infra), not as an
// application 500.
function isStorageUnreachable(e: any): boolean {
  const code = String(e?.code || e?.name || "");
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|EPIPE/i.test(code)) return true;
  if (/TimeoutError|RequestTimeout|RequestTimeoutException|ServiceUnavailable|SlowDown/i.test(code)) return true;
  const st = e?.$metadata?.httpStatusCode;
  if (st === 502 || st === 503 || st === 504) return true;
  return /socket hang up|timed? ?out/i.test(String(e?.message || ""));
}

function storageUnavailableError(cause: any): Error {
  const err: any = new Error(
    "File storage is temporarily unavailable — please try again shortly.",
  );
  err.status = 503;
  err.expose = true;
  err.code = "STORAGE_UNAVAILABLE";
  err.cause = cause;
  return err;
}

const s3 = new S3Client({
  endpoint: config.storage.endpoint,
  region: "us-east-1",
  credentials: {
    accessKeyId: config.storage.accessKeyId,
    secretAccessKey: config.storage.secretAccessKey,
  },
  forcePathStyle: true,
  requestHandler,
  maxAttempts,
});

// A SECOND client pinned to the PUBLIC endpoint, used ONLY to presign browser-facing
// URLs. SigV4 signs the host, so a presigned URL must be signed against the exact host
// the browser will hit — the internal `endpoint` (e.g. minio:9003 inside Docker) is
// unreachable from a browser, so signing GETs with `s3` produced dead links for a
// containerized backend. Falls back to `s3` when no distinct public endpoint is set
// (e.g. live, which serves files via the streaming /api/files/:id/download proxy and
// never hands out presigned URLs — so the fallback is never actually exercised there).
const s3Signer =
  config.storage.publicEndpoint &&
  config.storage.publicEndpoint !== config.storage.endpoint
    ? new S3Client({
        endpoint: config.storage.publicEndpoint,
        region: "us-east-1",
        credentials: {
          accessKeyId: config.storage.accessKeyId,
          secretAccessKey: config.storage.secretAccessKey,
        },
        forcePathStyle: true,
      })
    : s3;

const BUCKET = config.storage.bucket;

function storageKey(uploaderId: string, filename: string): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "/");
  const uid = randomUUID().slice(0, 8);
  const safe = (filename || "file").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200);
  return `files/${date}/${uploaderId}/${uid}-${safe}`;
}

// Lazily guarantee the bucket exists before the FIRST upload, memoized so it's a
// single HeadBucket round-trip per process — not per upload. The boot-time
// ensureBucket() is best-effort and can lose a race with a slow-starting MinIO
// (backend depends_on minio with condition: service_started, not _healthy), which
// left the bucket uncreated and made EVERY upload fail with NoSuchBucket ("File
// upload failed: Something went wrong"). Ensuring here is self-healing: the bucket
// is created on demand. On failure we reset the cache so the next upload retries
// rather than caching a permanent failure.
let bucketReady: Promise<void> | null = null;
function ensureBucketOnce(): Promise<void> {
  if (!bucketReady) {
    bucketReady = ensureBucket().catch((e) => {
      bucketReady = null;
      throw e;
    });
  }
  return bucketReady;
}

async function upload(key: string, data: Buffer | NodeJS.ReadableStream, mime: string): Promise<void> {
  await ensureBucketOnce();
  const u = new Upload({
    client: s3,
    params: { Bucket: BUCKET, Key: key, Body: data as any, ContentType: mime },
    queueSize: 4,
    partSize: 8 * 1024 * 1024, // 8MB parts; multipart never holds the whole file (~32MB peak)
  });
  await u.done();
}

async function download(key: string): Promise<Buffer> {
  const res = await s3.send(
    new GetObjectCommand({ Bucket: BUCKET, Key: key }),
  );
  const chunks: Buffer[] = [];
  for await (const chunk of res.Body as any) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// Streaming read: returns the S3 object's Node Readable so the HTTP route can
// PIPE it to the client instead of buffering the whole file into memory (avoids
// OOM under concurrent large downloads). Caller is responsible for piping +
// error handling.
async function getStream(
  key: string,
  range?: string,
): Promise<{
  stream: any;
  contentLength?: number;
  contentRange?: string;
  acceptRanges?: string;
  statusCode?: number;
}> {
  let res;
  try {
    res = await s3.send(
      new GetObjectCommand({
        Bucket: BUCKET,
        Key: key,
        // Let S3/MinIO do the byte math: pass the raw HTTP Range through so the
        // client can fetch just the ciphertext chunks it needs (streaming).
        ...(range ? { Range: range } : {}),
      }),
    );
  } catch (e: any) {
    // An unsatisfiable range is a 416, NOT a server fault.
    if (
      e?.name === "InvalidRange" ||
      e?.Code === "InvalidRange" ||
      e?.$metadata?.httpStatusCode === 416
    ) {
      const err: any = new Error("Requested range not satisfiable.");
      err.status = 416;
      err.expose = true;
      err.code = "RANGE_NOT_SATISFIABLE";
      throw err;
    }
    // A DB file row can outlive its object (interrupted/failed upload, storage
    // wiped, lifecycle expiry). S3 answers GetObject with NoSuchKey — which is a
    // NOT-FOUND condition, NOT a server fault. Left unhandled it surfaces as a 500
    // logged as an 'error', flooding the error ledger and telling the client the
    // server broke. Tag it as an exposed 404 so every download route (/:id,
    // ticket, link — all funnel through here) returns "no longer available" and
    // the ledger records it as a 'warn'.
    if (e?.name === "NoSuchKey" || e?.Code === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404) {
      const err: any = new Error("This file is no longer available.");
      err.status = 404;
      err.expose = true;
      err.code = "OBJECT_MISSING";
      throw err;
    }
    // MinIO alive-but-unresponsive (or down): a 503 the client can show as
    // "storage unavailable · retry" instead of an opaque 500.
    if (isStorageUnreachable(e)) throw storageUnavailableError(e);
    throw e;
  }
  // Return the REAL object size alongside the stream so the route advertises an
  // accurate Content-Length — a stale DB size would truncate or hang the client.
  // On a ranged request also surface ContentRange/AcceptRanges + the 206 status.
  return {
    stream: res.Body,
    contentLength: res.ContentLength,
    contentRange: (res as any).ContentRange,
    acceptRanges: (res as any).AcceptRanges,
    statusCode: res.$metadata?.httpStatusCode,
  };
}

async function presignedUrl(key: string, expiresIn = 3600): Promise<string> {
  // Sign against the PUBLIC endpoint (browser-reachable), not the internal one.
  return getSignedUrl(
    s3Signer,
    new GetObjectCommand({ Bucket: BUCKET, Key: key }),
    { expiresIn },
  );
}

async function remove(key: string): Promise<void> {
  await s3.send(
    new DeleteObjectCommand({ Bucket: BUCKET, Key: key }),
  );
}

async function ensureBucket(): Promise<void> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
    return; // bucket already present
  } catch {
    // fall through and attempt to create it
  }
  try {
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
    console.log("[storage] created bucket: %s", BUCKET);
  } catch (e: any) {
    // A concurrent boot/worker may have created it between our Head and Create,
    // or it existed but Head was denied — treat "already exists" as success.
    const code = e?.name || e?.Code || e?.$metadata?.httpStatusCode || "";
    if (/BucketAlreadyOwnedByYou|BucketAlreadyExists|409/i.test(String(code))) {
      return;
    }
    throw e;
  }
}

// Cheap reachability probe for the readiness endpoint: a HeadBucket round-trip
// (does NOT create anything). Throws if object storage is unreachable.
async function pingBucket(): Promise<void> {
  await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
}

export { storageKey, upload, download, getStream, presignedUrl, remove, ensureBucket, pingBucket, isStorageUnreachable, storageUnavailableError, BUCKET, s3 };
