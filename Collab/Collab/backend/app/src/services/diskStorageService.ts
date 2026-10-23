// Local file-storage tier (docs/FILE_UPLOAD_STORAGE_CHAIN.md §6).
//
// First tier in the upload chain: bytes land on the backend's files volume
// (FILE_STORAGE_DIR, a named Docker volume in every compose profile) before MinIO
// or MySQL are considered. Mirrors storageService's surface — upload / getStream /
// remove / ping — so fileService treats every tier the same way, and throws the
// SAME error shapes (404 OBJECT_MISSING, 416 RANGE_NOT_SATISFIABLE, 503
// STORAGE_UNAVAILABLE) so every download route renders them identically.
//
// Safety rules:
//   • keys are resolved INSIDE the root — a key that escapes it is rejected;
//   • writes are atomic: <key>.part → fsync → rename, so a crash mid-upload never
//     leaves a half file a download could serve;
//   • preflight() checks writability + free space BEFORE the request stream is
//     consumed, so a tight disk moves the chain on to MinIO cleanly.
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { config } from "../platform";
import { storageUnavailableError } from "./storageService";

const ROOT = path.resolve(String(config.storage.localDir || "./data/files"));
const MIN_FREE = Math.max(0, Number(config.storage.localMinFreeBytes) || 0);
const PART_SUFFIX = ".part";

function rootDir(): string {
  return ROOT;
}

// Errors that mean "the disk tier can't take/serve this right now" — as opposed
// to a caller bug. These move the chain on (upload) or become a 503 (download).
function isDiskUnavailable(e: any): boolean {
  const code = String(e?.code || "");
  if (/^(ENOSPC|EROFS|EACCES|EPERM|EIO|EDQUOT|EMFILE|ENFILE|EBUSY|ENOTDIR)$/.test(code)) return true;
  // ENOENT on the ROOT (volume not mounted) is an outage; ENOENT on a key is
  // handled separately as a 404 by getStream.
  if (code === "ENOENT" && e?.path && path.resolve(String(e.path)) === ROOT) return true;
  return false;
}

function badKeyError(key: string): Error {
  const err: any = new Error("Invalid storage key.");
  err.status = 400;
  err.code = "BAD_STORAGE_KEY";
  err.expose = false;
  err.key = key;
  return err;
}

// Resolve a relative key to an absolute path, refusing anything that escapes
// the root ("..", absolute paths, empty). storageService.storageKey() already
// whitelists filename characters; this is the belt for remove()/getStream().
function resolveKey(key: string): string {
  if (!key || typeof key !== "string" || path.isAbsolute(key)) throw badKeyError(key);
  const abs = path.resolve(ROOT, key);
  if (abs === ROOT || !abs.startsWith(ROOT + path.sep)) throw badKeyError(key);
  return abs;
}

async function ensureRoot(): Promise<void> {
  await fsp.mkdir(ROOT, { recursive: true });
}

// Free bytes on the volume holding ROOT (statfs: Node ≥ 18.15).
async function freeBytes(): Promise<{ free: number; total: number }> {
  const st: any = await (fsp as any).statfs(ROOT);
  return {
    free: Number(st.bavail) * Number(st.bsize),
    total: Number(st.blocks) * Number(st.bsize),
  };
}

// Reject BEFORE the request stream is consumed when the tier cannot take
// `bytes` more: root missing/unwritable, or landing the file would leave less
// than FILE_STORAGE_MIN_FREE_BYTES free. Throws 503 STORAGE_UNAVAILABLE.
async function preflight(bytes: number): Promise<void> {
  try {
    await ensureRoot();
    await fsp.access(ROOT, fs.constants.W_OK);
    const { free } = await freeBytes();
    const need = Math.max(0, Number(bytes) || 0);
    if (free - need < MIN_FREE) {
      const e: any = new Error(
        `insufficient free space on ${ROOT}: ${free} free, ${need} needed, ${MIN_FREE} reserve`,
      );
      e.code = "ENOSPC";
      throw e;
    }
  } catch (e: any) {
    throw storageUnavailableError(e);
  }
}

// Atomic write: temp file → fsync → rename. Cleans the temp file on ANY failure
// so a dead upload never leaves a stray .part behind (sweepParts also reaps
// orphans from a crash). Accepts a Buffer or a Readable (streamed uploads).
async function upload(key: string, data: Buffer | NodeJS.ReadableStream, _mime?: string): Promise<void> {
  const abs = resolveKey(key);
  const tmp = abs + PART_SUFFIX;
  try {
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    const src = Buffer.isBuffer(data) ? Readable.from([data]) : (data as Readable);
    await pipeline(src, fs.createWriteStream(tmp, { flags: "w" }));
    const fh = await fsp.open(tmp, "r+");
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fsp.rename(tmp, abs);
  } catch (e: any) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    if (isDiskUnavailable(e)) throw storageUnavailableError(e);
    throw e;
  }
}

// Parse a single "bytes=a-b" | "bytes=a-" | "bytes=-n" Range against `total`.
// Returns null for no/unsupported range, throws 416 when unsatisfiable.
function parseRange(range: string | undefined, total: number): { start: number; end: number } | null {
  if (!range) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
  if (!m) return null;
  const [, a, b] = m;
  let start: number;
  let end: number;
  if (a === "" && b === "") return null;
  if (a === "") {
    // suffix range: last n bytes
    const n = Number(b);
    if (!(n > 0)) return unsatisfiable();
    start = Math.max(0, total - n);
    end = total - 1;
  } else {
    start = Number(a);
    end = b === "" ? total - 1 : Math.min(Number(b), total - 1);
  }
  if (!(start >= 0) || start >= total || end < start) return unsatisfiable();
  return { start, end };
}
function unsatisfiable(): never {
  const err: any = new Error("Requested range not satisfiable.");
  err.status = 416;
  err.expose = true;
  err.code = "RANGE_NOT_SATISFIABLE";
  throw err;
}

// Same return shape as storageService.getStream so the download routes are
// tier-agnostic: on a ranged read contentLength is the SLICE size and
// contentRange carries "bytes a-b/total"; on a full read contentLength is total.
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
  const abs = resolveKey(key);
  let st: fs.Stats;
  try {
    st = await fsp.stat(abs);
  } catch (e: any) {
    if (e?.code === "ENOENT") {
      const err: any = new Error("This file is no longer available.");
      err.status = 404;
      err.expose = true;
      err.code = "OBJECT_MISSING";
      throw err;
    }
    if (isDiskUnavailable(e)) throw storageUnavailableError(e);
    throw e;
  }
  const total = st.size;
  const r = parseRange(range, total);
  if (r) {
    return {
      stream: fs.createReadStream(abs, { start: r.start, end: r.end }),
      contentLength: r.end - r.start + 1,
      contentRange: `bytes ${r.start}-${r.end}/${total}`,
      acceptRanges: "bytes",
      statusCode: 206,
    };
  }
  return {
    stream: fs.createReadStream(abs),
    contentLength: total,
    acceptRanges: "bytes",
    statusCode: 200,
  };
}

// Size of a stored object (used by the cold-tier job to verify a copy).
async function sizeOf(key: string): Promise<number> {
  const st = await fsp.stat(resolveKey(key));
  return st.size;
}

// Delete an object. A missing file counts as success (already gone); the
// matching .part, if any, is reaped too.
async function remove(key: string): Promise<void> {
  const abs = resolveKey(key);
  try {
    await fsp.rm(abs, { force: true });
    await fsp.rm(abs + PART_SUFFIX, { force: true });
  } catch (e: any) {
    if (isDiskUnavailable(e)) throw storageUnavailableError(e);
    throw e;
  }
}

// Readiness probe: root exists + writable + free-space numbers for /health/ready
// and the ops portal. Throws when the tier is unusable.
async function ping(): Promise<{ dir: string; freeBytes: number; totalBytes: number; usedPct: number }> {
  await ensureRoot();
  await fsp.access(ROOT, fs.constants.W_OK);
  // access(W_OK) answers from the mode bits; a read-only mount, a root-owned
  // volume under a non-root process or a full inode table only show up when a
  // byte is actually written. Probe with a real file so /health/ready reports
  // the disk tier as down BEFORE the first user upload fails on it.
  const probe = path.join(ROOT, `.probe-${process.pid}-${Date.now()}`);
  try {
    await fsp.writeFile(probe, "ok", { flag: "w" });
  } finally {
    await fsp.rm(probe, { force: true }).catch(() => {});
  }
  const { free, total } = await freeBytes();
  const usedPct = total > 0 ? Math.round(((total - free) / total) * 1000) / 10 : 0;
  return { dir: ROOT, freeBytes: free, totalBytes: total, usedPct };
}

// Reap orphaned temp files (crash between write and rename) older than
// `maxAgeMs`. Bounded walk; never throws — a sweep must not break the caller.
async function sweepParts(maxAgeMs = 24 * 60 * 60 * 1000, maxVisit = 50000): Promise<number> {
  let removed = 0;
  let visited = 0;
  const cutoff = Date.now() - maxAgeMs;
  const stack = [ROOT];
  try {
    while (stack.length && visited < maxVisit) {
      const dir = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const ent of entries) {
        visited++;
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) stack.push(p);
        else if (ent.isFile() && ent.name.endsWith(PART_SUFFIX)) {
          try {
            const st = await fsp.stat(p);
            if (st.mtimeMs < cutoff) {
              await fsp.rm(p, { force: true });
              removed++;
            }
          } catch {
            /* ignore */
          }
        }
      }
    }
  } catch {
    /* never throw from a sweep */
  }
  return removed;
}

export { rootDir, ensureRoot, preflight, upload, getStream, sizeOf, remove, ping, sweepParts, isDiskUnavailable, freeBytes };
