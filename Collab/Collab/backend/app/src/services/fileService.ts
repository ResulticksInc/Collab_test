import { randomUUID } from "crypto";
import jwt from "jsonwebtoken";
import { Transform } from "stream";
import { config, db } from "../platform";
import * as storage from "./storageService";
import * as disk from "./diskStorageService";
import { httpErr } from "../optimization/httpError";

const RANK: Record<string, number> = { view: 1, comment: 2, edit: 3 };
function cleanPerm(p) {
  return p === "edit" || p === "comment" || p === "view" ? p : "view";
}
const err = (message: string, status: number, code?: string) => httpErr(status, message, code);

function serializeFile(f, viewerId) {
  return {
    id: f.id,
    name: f.name,
    mime: f.mime || "application/octet-stream",
    size: f.size || 0,
    createdAt: f.createdAt,
    conversationId: f.conversationId || null,
    starred: !!f.starred,
    uploaderId: f.uploaderId,
    owned: viewerId ? f.uploaderId === viewerId : true,
    hasLink: !!f.linkPermission,
    encrypted: Number(f.encryptionVersion) > 0,
    encryptionVersion: Number(f.encryptionVersion) || 0,
    ciphertextMeta: f.ciphertextMeta || null,
  };
}

// Paginated list of a user's accessible files. Returns the page of serialized
// files plus the pagination envelope (hasMore + nextCursor) and the TOTAL live
// count so dashboard/rail badges stay correct now that the client no longer
// holds every row. Mirrors taskService.list / reminderService.listReminders.
// `limit` is clamped in the repo; `cursor` is the opaque keyset token from the
// previous page; `tab` (owned/shared/starred/all) paginates WITHIN that tab so
// counts + pages agree per tab. Authz is inherent (the accessible-files
// predicate). The search index uses listAllForIndex, NOT this, so paging here
// never truncates search.
async function listForUser(userId, { limit, cursor, tab, search }: any = {}) {
  // A paginating driver exposes countForUser (mirrors taskService keying off
  // db.tasks.listForUser). When present, use the real keyset page + total count.
  // `search` (P0-F) is a server-side name/type filter WITHIN the tab so search
  // spans ALL the user's files, not just the loaded page; the count reflects the
  // filtered total so the header tally + "Load more" stay correct under search.
  if (db.files.countForUser) {
    const [page, count] = await Promise.all([
      db.files.listForUser(userId, { limit, cursor, tab, search }),
      db.files.countForUser(userId, { tab, search }),
    ]);
    const files = (page.files || []).map((f) => serializeFile(f, userId));
    return {
      files,
      hasMore: !!page.hasMore,
      nextCursor: page.nextCursor || null,
      count: count == null ? files.length : count,
    };
  }
  // Fallback driver whose listForUser yields a bare array (no real paging) — keep
  // the envelope shape uniform for callers.
  const res: any = await db.files.listForUser(userId);
  const rows = Array.isArray(res) ? res : res.files || [];
  const files = rows.map((f) => serializeFile(f, userId));
  return { files, hasMore: false, nextCursor: null, count: files.length };
}

// FULL accessible-file set for the search index ONLY. Returns serialized files
// for everything the user can see (no pagination) so unified search never
// silently truncates as the read-path pages. See db.files.listAllForIndex.
async function listAllForIndex(userId) {
  let rows: any[];
  if (db.files.listAllForIndex) {
    rows = await db.files.listAllForIndex(userId);
  } else {
    // Fallback: a driver without the dedicated method — read the bare list. The
    // current MySQL driver always defines listAllForIndex, so this is latent, but
    // it must still AWAIT the promise (listForUser is async) and handle both the
    // paginated-envelope and bare-array shapes, or search would silently empty.
    const r: any = await db.files.listForUser(userId);
    rows = Array.isArray(r) ? r : (r && r.files) || [];
  }
  return rows.map((f) => serializeFile(f, userId));
}

// Recycle-bin: a user's OWN soft-deleted files (newest-deleted first), paginated.
// Owner-scoped at the repo level. Each item carries deletedAt so the UI can show
// "deleted N days ago" and how long until the GC retention window reclaims it.
async function listDeleted(userId, { limit, cursor }: any = {}) {
  const page = await db.files.listDeleted(userId, { limit, cursor });
  const files = (page.files || []).map((f) => ({
    ...serializeFile(f, userId),
    deletedAt: f.deletedAt || null,
  }));
  // AUDIT #47: return the AUTHORITATIVE total count + byte tally so the recycle-
  // bin header reflects the whole bin, not just the loaded page. Cheap COUNT+SUM;
  // computed regardless of cursor so the tally stays correct while paging.
  let count = files.length;
  let totalBytes = files.reduce((n, f: any) => n + (f.size || 0), 0);
  try {
    const tally = await db.files.countDeleted(userId);
    if (tally) {
      count = tally.count;
      totalBytes = tally.totalBytes;
    }
  } catch {
    /* fall back to the loaded-page tally on any count failure */
  }
  return {
    files,
    hasMore: !!page.hasMore,
    nextCursor: page.nextCursor || null,
    count,
    totalBytes,
  };
}

// Restore a soft-deleted file from the recycle bin. Permission-checked: only the
// owner (uploader) may restore — mirroring remove()'s owner-only guard. The S3
// blob was retained on soft-delete, so the bytes are intact. Returns the restored
// file or null (not found / not owned / already live).
async function restore({ fileId, userId }) {
  const meta = await db.files.getDeletedMeta(fileId);
  if (!meta || meta.uploaderId !== userId) return null;
  const restored = await db.files.restore(fileId);
  return restored ? serializeFile(restored, userId) : null;
}

// Collect a request stream into memory, refusing to grow past `max` (the
// declared Content-Length is a client claim, not a guarantee).
function readAll(stream: NodeJS.ReadableStream, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    stream.on("data", (c: Buffer) => {
      total += c.length;
      if (total > max) {
        const e: any = new Error("File is larger than declared.");
        e.status = 413;
        e.code = "TOO_LARGE";
        e.expose = true;
        (stream as any).destroy?.();
        reject(e);
        return;
      }
      chunks.push(c);
    });
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

// ── Storage tiers (docs/FILE_UPLOAD_STORAGE_CHAIN.md) ────────────────────────
// Every upload walks FILE_STORAGE_ORDER (default disk → s3 → db) until a tier
// accepts it. "db" (files.data LONGBLOB) is only ever used for a buffered upload
// at or under FILE_BLOB_FALLBACK_MAX_BYTES; large uploads stream to the first
// disk/s3 tier that passes preflight and get an honest 503 if that fails
// mid-stream (the request body can only be consumed once).
type Tier = "disk" | "s3" | "db";
const TIER_NAMES: Tier[] = ["disk", "s3", "db"];
function parseTierOrder(raw: string): Tier[] {
  const out: Tier[] = [];
  for (const part of String(raw || "").split(",")) {
    const t = part.trim().toLowerCase() as Tier;
    if (!t) continue;
    if (!TIER_NAMES.includes(t))
      throw new Error(
        `FILE_STORAGE_ORDER: unknown tier "${t}" (expected a comma list of ${TIER_NAMES.join("|")})`,
      );
    if (!out.includes(t)) out.push(t);
  }
  if (!out.length) throw new Error("FILE_STORAGE_ORDER is empty");
  return out;
}
const TIER_ORDER: Tier[] = parseTierOrder(config.storage.order);
function tierOrder(): Tier[] {
  return TIER_ORDER.slice();
}
// Which tier a row's bytes live on. Rows written before migration 0127 carry no
// backend; infer it the way the pre-0127 code did (key → S3, no key → LONGBLOB).
function effectiveBackend(meta: any): Tier {
  const b = meta && meta.storageBackend;
  if (b === "disk" || b === "s3" || b === "db") return b;
  return meta && meta.storageKey ? "s3" : "db";
}

// Cheap "is MinIO answering" check before a stream is handed to the S3 tier.
// HeadBucket has the same connect/request timeouts as the upload would, so an
// unreachable MinIO costs one bounded round-trip and the stream stays intact.
async function s3Preflight(): Promise<void> {
  try {
    await storage.pingBucket();
  } catch (e: any) {
    throw storage.isStorageUnreachable(e) ? storage.storageUnavailableError(e) : e;
  }
}

async function create({ uploaderId, name, mime, data, stream, size, conversationId, encrypted }: any) {
  const safeName = (name || "file").trim() || "file";
  const key = storage.storageKey(uploaderId, safeName);
  const contentType = mime || "application/octet-stream";
  const declared = Number(size) || 0;
  // Small streamed uploads are buffered FIRST. A stream can only be consumed
  // once: if a tier fails part-way through, the bytes are gone and there is
  // nothing left to try the next tier with. Buffering an 8 MB cap's worth is
  // cheap; the full chain then applies to the files people actually share in
  // chat, while big files keep streaming (disk/s3 only, honest 503 on failure —
  // a multi-GB LONGBLOB would blow MySQL max_allowed_packet).
  const fallbackMax = Number(config.storage.blobFallbackMaxBytes) || 0;
  if (stream && fallbackMax > 0 && declared > 0 && declared <= fallbackMax) {
    data = await readAll(stream, fallbackMax);
    stream = null;
  }
  const dbAllowed = !!data && (fallbackMax <= 0 || data.length <= fallbackMax);

  // A stream can be handed to ONE tier only: once a tier starts reading it the
  // bytes are gone for the others. `consumed` therefore flips at HAND-OFF, and
  // each tier gets a cheap preflight BEFORE the hand-off so a refusal that
  // needs no bytes (volume not writable / full, MinIO not answering) lets the
  // next tier take the still-intact stream.
  //
  // Until 8 Oct 2026 this used a Transform tap that set `consumed` on the first
  // chunk it saw — but a pipe pre-fills the tap's buffer before anyone reads,
  // so the flag was already true while the disk tier was still in preflight.
  // The disk refusal then ended the chain ("mid-stream failure") and MinIO was
  // never tried: every large upload died with "couldn't be saved" although
  // object storage was fine. Seen on run as STORAGE_UNAVAILABLE on POST /api/files.
  let consumed = false;
  const body: any = stream;

  let backend: Tier | null = null;
  let lastErr: any = null;
  // Per-tier outcome, surfaced on the final 503 so Admin → Server Logs says
  // WHY each tier refused the file (the console warnings below used to be the
  // only place that knew: "disk: EACCES, s3: timeout, db: skipped — too big").
  const attempts: Array<{ tier: Tier; outcome: string }> = [];
  for (const tier of TIER_ORDER) {
    if (tier === "db") {
      if (!dbAllowed) {
        attempts.push({
          tier,
          outcome: !data
            ? "skipped — streamed upload (too large to buffer for the database tier)"
            : `skipped — ${data.length} bytes exceeds FILE_BLOB_FALLBACK_MAX_BYTES (${fallbackMax})`,
        });
        continue;
      }
      backend = "db";
      break;
    }
    const driver = tier === "disk" ? disk : storage;
    try {
      if (data) {
        await driver.upload(key, data, contentType);
      } else {
        if (consumed) break; // bytes already handed to a failed tier
        if (tier === "disk") await disk.preflight(declared);
        else await s3Preflight();
        consumed = true; // hand-off: whatever happens now, no other tier can retry
        await driver.upload(key, body, contentType);
      }
      backend = tier;
      break;
    } catch (e: any) {
      lastErr = e;
      const why = String((e && (e.cause?.code || e.code || e.name)) || "") + (e?.cause?.message || e?.message ? `: ${(e.cause?.message || e.message)}` : "");
      attempts.push({ tier, outcome: `failed — ${why.slice(0, 240)}` });
      if (!data && consumed) break; // mid-stream failure: nothing left to retry
      // Say so in the log: a silent fallback hides an outage that may still be
      // breaking every LARGE upload and every download of that tier's files.
      console.warn(
        "[files] %s tier unavailable for %s (%d bytes) — trying next tier: %s",
        tier,
        safeName,
        data ? data.length : declared,
        (e && e.message) || e,
      );
    }
  }
  if (!backend) {
    // Chain exhausted. Surface an HONEST 503 — not a naked 500. The raw AWS/fs
    // error is an empty-message ECONNREFUSED/ENOSPC with no .status, which the
    // app error handler would otherwise render as the opaque "Something went
    // wrong. Please try again."
    const err: any = new Error(
      "File storage is temporarily unavailable — the file couldn't be saved. Please try again shortly.",
    );
    err.status = 503;
    err.code = "STORAGE_UNAVAILABLE";
    err.expose = true; // user-safe message — let the handler show it (not generic)
    err.cause = lastErr;
    // Recorded into the error ledger's context by the app error handler.
    err.details = {
      file: { name: safeName, bytes: data ? data.length : declared, mime: contentType },
      tierOrder: TIER_ORDER.join(","),
      tiers: attempts,
    };
    throw err;
  }
  if (backend === "db" && TIER_ORDER[0] !== "db")
    console.warn(
      "[files] every object tier unreachable — storing %s (%d bytes) in the database instead",
      safeName,
      data ? data.length : 0,
    );
  const f = await db.files.create({
    uploaderId,
    name: safeName,
    mime,
    size: size != null ? size : (data ? data.length : 0),
    data: backend === "db" ? data : null,
    storageKey: backend === "db" ? null : key,
    storageBackend: backend,
    conversationId: conversationId || null,
    encryptionVersion: encrypted ? encrypted.version || 1 : 0,
    ciphertextMeta: encrypted || null,
  });
  return serializeFile(f, uploaderId);
}

// Open a stored object for reading on whichever tier holds it. Returns null for
// a LONGBLOB row (caller reads db.files.getData). Same return shape for disk and
// s3 so the routes stay tier-agnostic.
async function openForRead(meta: any, range?: string) {
  const backend = effectiveBackend(meta);
  if (backend === "db" || !meta.storageKey) return null;
  if (backend === "disk") return disk.getStream(meta.storageKey, range);
  try {
    return await storage.getStream(meta.storageKey, range);
  } catch (e: any) {
    // MinIO unreachable: the cold-tier job uploads under the SAME key and only
    // deletes the disk copy after the row flips, so a copy may still be on the
    // local volume. Serve it rather than a 503 when it is; a missing copy
    // (ENOENT → 404 from the disk tier) re-throws the storage outage as-is.
    if (e?.code === "STORAGE_UNAVAILABLE") {
      try {
        return await disk.getStream(meta.storageKey, range);
      } catch (_) {
        /* fall through to the real reason */
      }
    }
    throw e;
  }
}

// Authorization: owner (uploader) > edit > comment > view. A grant can come
// from a direct user share, a conversation (group/channel) the user belongs
// to, or an active share link (only when the caller presents the link token).
// Returns the effective permission, or null.
async function permissionFor(fileId, userId, { viaShareLink = false } = {}) {
  const meta = await db.files.getMeta(fileId);
  if (!meta) return null;
  if (meta.uploaderId === userId) return "owner";
  let best: string | null = null;
  const perms = await db.fileShares.permissionsFor(fileId, userId);
  for (const p of perms) if (!best || RANK[p] > RANK[best]) best = p;
  // SECURITY: linkPermission is an AMBIENT grant (no secret required) so applying
  // it for every authenticated caller silently shares files cross-tenant. Only
  // honour it when the caller explicitly presented the share-link token on the
  // /files/link/:token path (viaShareLink=true).
  if (viaShareLink && meta.linkPermission) {
    if (!best || RANK[meta.linkPermission] > RANK[best])
      best = meta.linkPermission;
  }
  // A file attached to a conversation is viewable by that conversation's members:
  // if you're in the chat, you can open/play/download anything shared there
  // (voice notes, images, attachments). Without this, recipients got 404.
  if (
    !best &&
    meta.conversationId &&
    (await db.conversations.isMember(meta.conversationId, userId))
  ) {
    best = "view";
  }
  // A file shared in a MEETING chat is viewable by anyone who can access that
  // meeting (its creator or an attendee — including invitees who joined by ID),
  // mirroring the conversation-membership grant above. Without this, only the
  // uploader could download meeting-chat attachments and every other participant
  // got a 404. The file<->meeting link comes from meeting_messages.file_json.
  if (!best) {
    try {
      const mids = await db.meetingMessages.meetingIdsForFile(fileId);
      for (const mid of mids) {
        const mtg: any = await db.meetings.getById(mid);
        if (
          mtg &&
          (mtg.createdBy === userId ||
            (mtg.attendees || []).some((a: any) => a.userId === userId))
        ) {
          best = "view";
          break;
        }
      }
    } catch (_) {
      /* never throw from an authorization read */
    }
  }
  return best;
}

async function getDownload({ fileId, userId, range }: any) {
  if (!(await permissionFor(fileId, userId))) return null;
  const meta = await db.files.getMeta(fileId);
  if (!meta) return null;
  const r = await openForRead(meta, range);
  if (r) {
    // Stream from disk/S3 so the route pipes it instead of buffering the whole
    // file into Node memory (avoids OOM under concurrent large downloads).
    // `range` (HTTP Range header) enables partial fetches for E2EE video streaming.
    // contentLength MUST stay the FULL object size (the ETag is derived from it,
    // so a range and a full request must agree). On a 206 the S3 ContentLength is
    // the PARTIAL length — take the total from the "bytes a-b/total" tail instead,
    // and carry the partial length separately.
    const total = r.contentRange
      ? Number(String(r.contentRange).split("/")[1])
      : r.contentLength;
    return {
      ...meta,
      stream: r.stream,
      contentLength: total ?? meta.size,
      partialLength: r.contentRange ? r.contentLength : null,
      contentRange: r.contentRange || null,
      statusCode: r.statusCode,
    };
  }
  return db.files.getData(fileId); // BLOB fallback (small/rare) → { ...meta, data }
}

async function getPresignedUrl({ fileId, userId }) {
  if (!(await permissionFor(fileId, userId))) return null;
  const meta = await db.files.getMeta(fileId);
  // Only an S3-backed object can be presigned; disk/db rows go through the
  // same-origin streaming download routes (the client already falls back).
  if (!meta || !meta.storageKey || effectiveBackend(meta) !== "s3") return null;
  const url = await storage.presignedUrl(meta.storageKey);
  return { url, name: meta.name, mime: meta.mime };
}

// ── Oversized-attachment download (AUDIT #28 hotfix) ─────────────────────────
// An oversized (>100MB) non-E2EE attachment must be downloadable WITHOUT (a)
// fetching the whole file into a browser Blob (OOM) and WITHOUT (b) a presigned
// S3/MinIO URL — MinIO's S3 API is NOT browser-reachable in the live deploy (no
// host port; S3_PUBLIC_ENDPOINT unset), so a presigned URL points at an
// unreachable host and the download fails.
//
// Instead we mint a SHORT-LIVED SIGNED TICKET (a JWT, no DB row) that the PUBLIC
// GET /api/files/dl/:ticket route streams THROUGH the same-origin backend proxy
// (which is how normal downloads already work). This is:
//   • same-origin  → always browser-reachable (nginx /api → backend), no MinIO exposure
//   • streamed     → piped from S3 through the backend, never buffered (no OOM)
//   • authenticated→ membership checked at MINT and RE-checked at download
//   • short-lived  → 5 min, so a leaked URL is a tiny single-file capability
//   • not public   → never a permanent, unauthenticated share link (the #28 defect)
//
// SECURITY: the ticket carries a distinct `purpose` and NO `sub` claim, so even
// though it's signed with the same secret it can NEVER authenticate as an access
// token (authMiddleware reads `sub` → userId; absent here) and downloadByTicket
// additionally enforces purpose === "file-dl".
const DL_TICKET_TTL_SEC = 5 * 60;

async function mintDownloadTicket({ fileId, userId }) {
  if (!(await permissionFor(fileId, userId))) return null;
  const meta = await db.files.getMeta(fileId);
  if (!meta) return null;
  return jwt.sign(
    { fid: fileId, uid: userId, purpose: "file-dl" },
    config.auth.jwtSecret,
    { expiresIn: DL_TICKET_TTL_SEC },
  );
}

async function downloadByTicket(ticket: string) {
  let decoded: any;
  try {
    decoded = jwt.verify(ticket, config.auth.jwtSecret);
  } catch {
    return null; // expired / tampered / bad signature
  }
  if (!decoded || decoded.purpose !== "file-dl" || !decoded.fid || !decoded.uid)
    return null;
  // Re-check membership at download time (defense in depth: a file un-shared
  // after the ticket was minted must not still be reachable). getDownload runs
  // permissionFor + returns the streamed file.
  const f = await getDownload({ fileId: decoded.fid, userId: decoded.uid });
  if (!f) return null;
  // Attach the ticket's actor so the route can attribute the audit event (the
  // download is otherwise anonymous — the ticket, not a session, is the credential).
  return { ...f, dlActorId: decoded.uid };
}

// Anyone with the link gets the file (token is the credential).
async function linkDownload(token) {
  const meta = await db.files.getByToken(token);
  if (!meta) return null;
  const r = await openForRead(meta);
  if (r) return { ...meta, stream: r.stream, contentLength: r.contentLength ?? meta.size };
  return meta;
}

async function remove({ fileId, userId }) {
  const meta = await db.files.getMeta(fileId);
  if (!meta || meta.uploaderId !== userId)
    return { id: fileId, deleted: false };
  // Soft-delete only: the S3 blob is intentionally RETAINED so the file is
  // recoverable from the recycle bin. The GC sweeper (FILES_GC_RETENTION_DAYS)
  // reclaims the blob + hard-deletes the row only after the retention window.
  // Pass the actor so `deleted_by` is recorded (audit / who-deleted-it).
  await db.files.remove(fileId, userId);
  return { id: fileId, deleted: true };
}

// A favorite is PERSONAL (per-user, migration 0114): any file you can access
// can be your favorite, and nobody else's stars touch your list. The old
// model — a single global flag only the uploader could set — is why favorites
// "sometimes worked": your own uploads starred fine, while a file shared WITH
// you 404'd here and the client's optimistic star silently reverted.
async function setStar({ fileId, userId, starred }) {
  if (!(await permissionFor(fileId, userId))) return null;
  const f = await db.files.setStar(fileId, userId, starred);
  return f ? serializeFile(f, userId) : null;
}

async function resolveShares(rows) {
  // Batch-resolve every distinct user (share subjects + creators) in ONE getByIds
  // instead of up to 3 getById per row (the N+1 flagged in the review); resolve
  // each distinct subject-conversation once. A map MISS still falls back to a
  // per-id read, so the "User"/"Group"/"Channel"/null fallbacks are byte-identical.
  const userIds = new Set<string>();
  const convIds = new Set<string>();
  for (const s of rows) {
    if (s.subjectType === "user") userIds.add(s.subjectId);
    else convIds.add(s.subjectId);
    if (s.createdBy) userIds.add(s.createdBy);
  }
  const usersById = new Map<string, any>();
  if (userIds.size && (db.users as any).getByIds) {
    for (const u of (await (db.users as any).getByIds([...userIds])) || [])
      if (u && u.id) usersById.set(u.id, u);
  }
  const getUser = async (id: string) =>
    usersById.has(id) ? usersById.get(id) : await db.users.getById(id);
  const convById = new Map<string, any>();
  for (const id of convIds)
    convById.set(id, await db.conversations.getById(id));

  const out: any[] = [];
  for (const s of rows) {
    let subjectName = s.subjectId;
    if (s.subjectType === "user") {
      const u = await getUser(s.subjectId);
      subjectName = (u && u.name) || "User";
    } else {
      const c = convById.get(s.subjectId);
      subjectName =
        (c && c.title) || (c && c.kind === "channel" ? "Channel" : "Group");
    }
    let createdByName: any = null;
    if (s.createdBy) {
      const b = await getUser(s.createdBy);
      createdByName = b && b.name;
    }
    out.push({
      id: s.id,
      subjectType: s.subjectType,
      subjectId: s.subjectId,
      subjectName,
      permission: s.permission,
      createdBy: s.createdBy,
      createdByName,
      createdAt: s.createdAt,
    });
  }
  return out;
}

// Only the owner or an editor may share.
async function share({ fileId, byUserId, subjectType, subjectId, permission }) {
  const meta = await db.files.getMeta(fileId);
  if (!meta) return null;
  const mine = await permissionFor(fileId, byUserId);
  if (mine !== "owner" && mine !== "edit")
    throw err("You don't have permission to share this file", 403, "FORBIDDEN");
  if (subjectType === "user") {
    const u = await db.users.getById(subjectId);
    if (!u) throw err("Unknown user", 400, "BAD_SUBJECT");
    if (subjectId === meta.uploaderId)
      throw err(
        "They already own this file — no need to share it with them.",
        400,
        "ALREADY_OWNER",
      );
  } else if (subjectType === "conversation") {
    if (!(await db.conversations.isMember(subjectId, byUserId)))
      throw err("You're not a member of that conversation", 403, "FORBIDDEN");
  } else {
    throw err("Invalid share target", 400, "BAD_SUBJECT");
  }
  return db.fileShares.create({
    fileId,
    subjectType,
    subjectId,
    permission: cleanPerm(permission),
    createdBy: byUserId,
  });
}

async function listShares(fileId, userId) {
  if (!(await permissionFor(fileId, userId))) return null;
  return resolveShares(await db.fileShares.listForFile(fileId));
}

async function unshare({ shareId, userId }) {
  const s = await db.fileShares.getById(shareId);
  if (!s) return { id: shareId, deleted: false };
  const meta = await db.files.getMeta(s.fileId);
  if (!meta || meta.uploaderId !== userId)
    throw err("Only the owner can change sharing", 403, "FORBIDDEN");
  return db.fileShares.remove(shareId);
}

async function createLink({ fileId, userId, permission }) {
  const meta = await db.files.getMeta(fileId);
  if (!meta || meta.uploaderId !== userId)
    throw err("Only the owner can create a link", 403, "FORBIDDEN");
  const token = meta.shareToken || randomUUID();
  const f = await db.files.setShareToken(fileId, token, cleanPerm(permission));
  return {
    token: f.shareToken,
    permission: f.linkPermission,
    path: `/api/files/link/${f.shareToken}`,
  };
}

async function revokeLink({ fileId, userId }) {
  const meta = await db.files.getMeta(fileId);
  if (!meta || meta.uploaderId !== userId)
    throw err("Only the owner can change the link", 403, "FORBIDDEN");
  await db.files.setShareToken(fileId, null, null);
  return { fileId, link: null };
}

async function details(fileId, userId) {
  const meta = await db.files.getMeta(fileId);
  if (!meta) return null;
  const viewer = await permissionFor(fileId, userId);
  if (!viewer) return null;
  const owner = await db.users.getById(meta.uploaderId);
  const allShares = await resolveShares(
    await db.fileShares.listForFile(fileId),
  );
  // A file's owner already has full access, so they must never appear as a
  // "shared with" recipient (or in the derived activity) of their own file.
  const shares = allShares.filter(
    (s) => !(s.subjectType === "user" && s.subjectId === meta.uploaderId),
  );
  let linkedConversation: any = null;
  if (meta.conversationId) {
    const c = await db.conversations.getById(meta.conversationId);
    if (c)
      linkedConversation = {
        id: c.id,
        kind: c.kind,
        name:
          c.title ||
          (c.kind === "channel"
            ? "Channel"
            : c.kind === "group"
              ? "Group"
              : "Conversation"),
      };
  }
  // Activity is synthesized from real share events — no fabricated history.
  const activity = shares.map((s) => ({
    when: s.createdAt,
    text: `Shared with ${s.subjectName} (${s.permission})${
      s.createdByName ? " by " + s.createdByName : ""
    }`,
  }));
  return {
    id: meta.id,
    name: meta.name,
    owner: owner ? { id: owner.id, name: owner.name } : null,
    permission: viewer,
    shares,
    link: meta.linkPermission
      ? {
          permission: meta.linkPermission,
          path: `/api/files/link/${meta.shareToken}`,
        }
      : null,
    linkedConversation,
    activity,
  };
}

export {
  tierOrder,
  effectiveBackend,
  openForRead,
  listForUser,
  listAllForIndex,
  listDeleted,
  restore,
  create,
  // Exposed so taskService can authorize task-attachment links against the SAME
  // Files permission model (a user may only attach a file they can already see).
  permissionFor,
  getDownload,
  getPresignedUrl,
  mintDownloadTicket,
  downloadByTicket,
  linkDownload,
  remove,
  setStar,
  share,
  listShares,
  unshare,
  createLink,
  revokeLink,
  details,
};
