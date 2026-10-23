import { asyncRouter } from "../asyncRouter";
const router = asyncRouter();
import { ok, fail, shared, db } from "../platform";
import authMiddleware from "../middleware/auth";
import { rateLimit } from "../middleware/rateLimit";

// AUDIT P1: build a Content-Disposition value that survives non-Latin-1 filenames
// (CJK, emoji, macOS NFD-decomposed accents). Node's res.setHeader throws
// ERR_INVALID_CHAR for any code point > 0xFF, so passing a raw multibyte name 500s
// the download AND breaks inline chat-image rendering (same endpoint). Per RFC
// 6266/5987 we emit BOTH an ASCII-sanitized `filename=` fallback and a percent-
// encoded `filename*=UTF-8''…`; CR/LF are stripped to close header injection.
function contentDisposition(name: string): string {
  const raw = String(name || "file").replace(/[\r\n]/g, "");
  // ASCII fallback: replace any non-printable-ASCII (incl. quotes/backslash) with "_".
  const ascii = raw.replace(/["\\]/g, "_").replace(/[^\x20-\x7e]/g, "_") || "file";
  const enc = encodeURIComponent(raw).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16));
  return `attachment; filename="${ascii}"; filename*=UTF-8''${enc}`;
}

// Hard ceiling on a single upload. Streamed straight to object storage (S3
// multipart) — the body is NEVER buffered into RAM — so this guards storage/
// bandwidth, not memory. Enforced from the declared Content-Length.
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

// Per-IP cap on the heavy 100mb upload route. Conservative: a real user never
// uploads 60 files in a minute; this only stops a flooding/abusive client.
const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: "Too many uploads. Please wait a moment and try again.",
});
import {
  listForUser,
  listDeleted,
  restore,
  create,
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
} from "../services/fileService";
import { scanFile } from "../services/virusScanService";
import { record } from "../services/auditService";
import * as notificationService from "../services/notificationService";
import { broadcast } from "../realtime/socket";
import { pushNotif } from "../realtime/notify";
const { EVENTS } = shared;

function parseEncryptedMeta(req) {
  const raw =
    req.headers["x-colab-e2ee"] ||
    req.headers["x-colab-encryption"] ||
    req.query.encrypted;
  if (!raw) return null;
  try {
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return { version: 1, algorithm: "aes-gcm", malformed: true };
  }
}

function setEncryptedHeader(res, f) {
  if (!f || !Number(f.encryptionVersion)) return;
  res.setHeader(
    "X-CoLab-E2EE",
    JSON.stringify({ version: f.encryptionVersion, ...(f.ciphertextMeta || {}) }),
  );
}

// PERF: a stored file's bytes are IMMUTABLE per id — the storageKey is a
// randomUUID-stamped path minted once at upload, and an edit produces a brand
// new file id, never a rewrite. We emit a strong ETag so the browser can hold the
// bytes and, on the next open, revalidate with If-None-Match → we answer 304 and
// skip re-transferring the (potentially large) body. That is the expensive part
// for images/video, so this is a real win.
//
// IMPORTANT — why `no-cache`, NOT `immutable`: these routes sit behind real
// server-side gates — per-file permission (getDownload → permissionFor), share-
// link revocation (linkDownload), download-ticket expiry (downloadByTicket), and
// the P0-E download AUDIT. `immutable` + a long max-age would let the browser
// serve a cached URL for a year with NO origin round-trip, silently bypassing all
// of those (a revoked link would keep working; re-downloads would go unaudited).
// `private, no-cache` means "store it, but ALWAYS revalidate before use": the
// request still reaches the origin every time, so every gate + the audit re-run,
// yet a matching ETag returns a bodiless 304 so the bytes aren't re-sent. `private`
// keeps it out of any shared proxy cache. Returns the ETag for the 304 check.
function setRevalidateCache(res, f) {
  const id = f && (f.id != null ? f.id : null);
  if (id == null) return null;
  const len =
    f.contentLength != null
      ? f.contentLength
      : f.size != null
        ? f.size
        : f.data
          ? f.data.length
          : "";
  const etag = `"${id}-${len}"`;
  res.setHeader("ETag", etag);
  res.setHeader("Cache-Control", "private, no-cache");
  return etag;
}

// The gate already ran (we reached here), so a matching If-None-Match is safe to
// answer with a bodiless 304 — the client reuses its stored copy, we skip the
// transfer. When it fires we tear down the already-opened S3 stream so the socket
// to object storage isn't left dangling. We MUST attach an 'error' listener before
// destroying: destroy() can make the S3 Readable emit 'error' asynchronously, and
// an 'error' with no listener throws (crashing the process) — the surrounding
// try/catch only guards a synchronous throw, not a later event.
function maybeNotModified(req, res, f, etag): boolean {
  if (!etag) return false;
  const inm = req.headers["if-none-match"];
  if (!inm || String(inm) !== etag) return false;
  const s = (f as any).stream;
  if (s) {
    try {
      s.on("error", () => {});
      s.destroy();
    } catch (_) {
      /* best-effort teardown */
    }
  }
  res.status(304).end();
  return true;
}

// Public, unauthenticated: anyone with a share link can download. The token is
// the credential, so this route is registered BEFORE the auth middleware.
router.get("/link/:token", async (req, res) => {
  const f = await linkDownload(req.params.token);
  if (!f)
    return res
      .status(404)
      .json(fail("NOT_FOUND", "Link not found or disabled"));
  // AUDIT (P0-E): public shared-link fetches are exfiltration-visible. Record
  // anonymously (no authenticated actor on this public route) with the link
  // token. Fire-and-forget — never block/slow the stream. record() already
  // swallows its own errors, but the extra catch guards a sync throw.
  try {
    void record({
      actorId: null,
      action: "file.link.download",
      targetType: "file",
      targetId: (f as any).id || null,
      detail: { token: req.params.token, anonymous: true },
    });
  } catch (_) {
    /* audit must never break a download */
  }
  res.setHeader("Content-Type", f.mime || "application/octet-stream");
  setEncryptedHeader(res, f);
  const etag = setRevalidateCache(res, f);
  if (maybeNotModified(req, res, f, etag)) return;
  res.setHeader("Content-Disposition", contentDisposition(f.name));
  // Advertise the size so the client can render a real download progress bar —
  // the streamed S3 body has no inherent length. f.size is the exact byte count
  // recorded at upload; the BLOB fallback uses the buffer length.
  const dlLen =
    (f as any).contentLength != null
      ? (f as any).contentLength
      : (f as any).size != null
        ? (f as any).size
        : (f as any).data
          ? (f as any).data.length
          : undefined;
  if (dlLen != null && Number(dlLen) > 0)
    res.setHeader("Content-Length", String(dlLen));
  if ((f as any).stream) {
    const s = (f as any).stream;
    s.on("error", (e: any) => {
      console.warn("[files] link stream error:", e?.message);
      if (!res.headersSent) res.status(500).end();
      else res.destroy();
    });
    s.pipe(res);
    return;
  }
  res.send(f.data);
});

// Stream a resolved file object (from a streaming or BLOB service call) to the
// response with the right headers. Shared by the ticketed download route.
function pipeFileToResponse(res: any, f: any, req?: any) {
  res.setHeader("Content-Type", f.mime || "application/octet-stream");
  setEncryptedHeader(res, f);
  const etag = setRevalidateCache(res, f);
  if (req && maybeNotModified(req, res, f, etag)) return;
  res.setHeader("Content-Disposition", contentDisposition(f.name));
  const dlLen =
    f.contentLength != null
      ? f.contentLength
      : f.size != null
        ? f.size
        : f.data
          ? f.data.length
          : undefined;
  if (dlLen != null && Number(dlLen) > 0)
    res.setHeader("Content-Length", String(dlLen));
  if (f.stream) {
    const s = f.stream;
    s.on("error", (e: any) => {
      console.warn("[files] ticket stream error:", e?.message);
      if (!res.headersSent) res.status(500).end();
      else res.destroy();
    });
    s.pipe(res);
    return;
  }
  res.send(f.data);
}

// AUDIT #28 (hotfix): PUBLIC, SAME-ORIGIN streaming download for an oversized
// attachment, gated by a SHORT-LIVED SIGNED TICKET (not a permanent public link,
// and not a browser-unreachable presigned MinIO URL). The ticket is the credential
// (membership was checked when it was minted, and downloadByTicket re-checks it),
// so — like /link/:token — this route is registered BEFORE the auth middleware.
// This is what makes >100MB downloads actually work in the live deploy, where
// MinIO is not exposed to browsers.
router.get("/dl/:ticket", async (req, res) => {
  const f = await downloadByTicket(req.params.ticket);
  if (!f)
    return res
      .status(404)
      .json(fail("NOT_FOUND", "Download link expired or invalid"));
  // AUDIT (P0-E): keep large-file downloads exfiltration-visible, same as the
  // authenticated /:id/download and public /link/:token paths. The actor is the
  // uid embedded in (and validated by) the ticket. Fire-and-forget — never blocks
  // the stream.
  try {
    void record({
      actorId: (f as any).dlActorId || null,
      action: "file.download",
      targetType: "file",
      targetId: (f as any).id || null,
      detail: { via: "ticket" },
    });
  } catch (_) {
    /* audit must never break a download */
  }
  pipeFileToResponse(res, f, req);
});

router.use(authMiddleware);

// Decode the opaque base64 keyset cursor the client passes back verbatim. A
// malformed cursor just restarts from page 1 (never throws). Shared by the
// file list and the recycle-bin list.
function decodeCursor(raw: any): any {
  if (!raw) return null;
  try {
    return JSON.parse(Buffer.from(String(raw), "base64").toString("utf8"));
  } catch {
    return null;
  }
}
function encodeCursor(c: any): string | null {
  return c ? Buffer.from(JSON.stringify(c), "utf8").toString("base64") : null;
}

// GET /api/files?limit=&cursor=&tab= — paginated. Returns { files, hasMore,
// nextCursor, count }. `cursor` is the opaque base64 keyset token from the
// previous page; `limit` is clamped server-side; `tab` (owned/shared/starred/all)
// paginates WITHIN that tab so the count + pages are correct per tab. `count` is
// the total live count for that tab (badges must not undercount once the client
// only holds a page). Mirrors GET /api/tasks + GET /api/reminders.
router.get("/", async (req, res) => {
  const limit = req.query.limit ? Number(req.query.limit) : undefined;
  const tab = req.query.tab ? String(req.query.tab) : undefined;
  // SERVER-SIDE SEARCH (P0-F): a name/type filter applied WITHIN the tab so the
  // search spans ALL the user's files, not just the loaded page. The client
  // drives it (debounced) and re-pages from scratch when the term changes.
  const search = req.query.search ? String(req.query.search) : undefined;
  const cursor = decodeCursor(req.query.cursor);
  const page = await listForUser(req.user.userId, { limit, cursor, tab, search });
  res.json(
    ok({
      files: page.files,
      hasMore: page.hasMore,
      count: page.count,
      nextCursor: encodeCursor(page.nextCursor),
    }),
  );
});

// GET /api/files/trash?limit=&cursor= — the caller's recycle bin: their OWN
// soft-deleted files, newest-deleted first, paginated. Owner-scoped in the
// service (only the uploader sees their trash). Returns { files, hasMore,
// nextCursor }; each file carries deletedAt. Declared BEFORE the "/:id/*" routes
// so "trash" is never captured as a file id.
router.get("/trash", async (req, res) => {
  const limit = req.query.limit ? Number(req.query.limit) : undefined;
  const cursor = decodeCursor(req.query.cursor);
  const page = await listDeleted(req.user.userId, { limit, cursor });
  res.json(
    ok({
      files: page.files,
      hasMore: page.hasMore,
      nextCursor: encodeCursor(page.nextCursor),
      // AUDIT #47: authoritative whole-bin tally for the recycle-bin header.
      count: (page as any).count,
      totalBytes: (page as any).totalBytes,
    }),
  );
});

// Upload: raw bytes in the body; metadata in query (?name=&mime=&conversationId=).
// The request stream is piped STRAIGHT to object storage (S3 multipart) — the
// body is never buffered into a Node Buffer — so a 2 GB attachment costs ~32 MB
// of RAM, not 2 GB. Limiter runs first so a 429'd request never opens a stream.
router.post(
  "/",
  uploadLimiter,
  async (req, res) => {
    const name = req.query.name ? String(req.query.name) : "file";
    const mime = req.query.mime
      ? String(req.query.mime)
      : (req.headers["content-type"] as string) || "application/octet-stream";
    const conversationId = req.query.conversationId
      ? String(req.query.conversationId)
      : null;
    const declaredLen = Number(req.headers["content-length"] || 0);
    if (!declaredLen)
      return res.status(400).json(fail("BAD_REQUEST", "Empty file"));
    if (declaredLen > MAX_UPLOAD_BYTES)
      return res
        .status(413)
        .json(fail("TOO_LARGE", "File exceeds the 2 GB limit"));
    const f = await create({
      uploaderId: req.user.userId,
      name,
      mime,
      stream: req,
      size: declaredLen,
      conversationId,
      encrypted: parseEncryptedMeta(req),
    });
    if (f && f.id)
      await record({
        actorId: req.user.userId,
        action: "file.upload",
        targetType: "file",
        targetId: f.id,
      });
    // Virus-scan HOOK (P0-E): fire-and-forget so it NEVER blocks/slows the
    // streaming upload response. NO-OP by default (see virusScanService) — the
    // real scanner is infra-dependent and wired in later.
    if (f && f.id) {
      void scanFile((f as any).storageKey || null, {
        id: f.id,
        uploaderId: req.user.userId,
        name: f.name,
        mime: f.mime,
        size: f.size,
        conversationId,
      }).catch((e) =>
        console.warn("[virus-scan] hook failed:", e && e.message),
      );
    }
    res.status(201).json(ok(f));
  },
);

router.get("/:id/download", async (req, res) => {
  // HTTP Range (a single "bytes=a-b") enables partial fetches for E2EE video
  // STREAMING: the decrypt-on-play Service Worker asks for just the ciphertext
  // chunks it needs. A comma (multi-range) is unsupported by S3 GetObject → serve
  // the full object instead.
  const rangeHdr =
    typeof req.headers.range === "string" && !req.headers.range.includes(",")
      ? req.headers.range
      : undefined;
  const f = await getDownload({
    fileId: req.params.id,
    userId: req.user.userId,
    range: rangeHdr,
  });
  if (!f) return res.status(404).json(fail("NOT_FOUND", "File not found"));
  // AUDIT (P0-E): authenticated downloads are exfiltration-visible. Record the
  // actor + fileId fire-and-forget — never block/slow the stream below. Streaming
  // fires MANY range sub-requests per view, so audit only the playback START (no
  // range, or the range beginning at byte 0) — one row per view, not per chunk.
  // The per-request permission gate (getDownload → permissionFor) still runs on
  // every range, so access control is unchanged.
  const isAuditableStart = !rangeHdr || /^bytes=0-/.test(rangeHdr);
  if (isAuditableStart) {
    try {
      void record({
        actorId: req.user.userId,
        action: "file.download",
        targetType: "file",
        targetId: req.params.id,
      });
    } catch (_) {
      /* audit must never break a download */
    }
  }
  res.setHeader("Content-Type", f.mime || "application/octet-stream");
  res.setHeader("Accept-Ranges", "bytes"); // advertise range support on every response
  setEncryptedHeader(res, f);
  const etag = setRevalidateCache(res, f);
  // A media player often sends BOTH If-None-Match and Range; it must still get its
  // slice, so only honour the bodiless 304 for a NON-ranged request.
  if (!rangeHdr && maybeNotModified(req, res, f, etag)) return;
  res.setHeader("Content-Disposition", contentDisposition(f.name));
  const isPartial = (f as any).statusCode === 206 && (f as any).contentRange;
  if (isPartial) {
    // 206: Content-Range carries the full total; Content-Length is the SLICE size
    // (partialLength) — NOT the full object size, or the client truncates/hangs.
    res.status(206);
    res.setHeader("Content-Range", String((f as any).contentRange));
    if ((f as any).partialLength != null)
      res.setHeader("Content-Length", String((f as any).partialLength));
  } else {
    // Advertise the full size so the client can render a real download progress bar.
    const dlLen =
      (f as any).contentLength != null
        ? (f as any).contentLength
        : (f as any).size != null
          ? (f as any).size
          : (f as any).data
            ? (f as any).data.length
            : undefined;
    if (dlLen != null && Number(dlLen) > 0)
      res.setHeader("Content-Length", String(dlLen));
  }
  if ((f as any).stream) {
    const s = (f as any).stream;
    s.on("error", (e: any) => {
      console.warn("[files] download stream error:", e?.message);
      if (!res.headersSent) res.status(500).end();
      else res.destroy();
    });
    s.pipe(res);
    return;
  }
  res.send(f.data);
});

router.get("/:id/presigned", async (req, res) => {
  const result = await getPresignedUrl({
    fileId: req.params.id,
    userId: req.user.userId,
  });
  if (!result)
    return res.status(404).json(fail("NOT_FOUND", "File not found or not S3-backed"));
  res.json(ok(result));
});

// AUDIT #28 (hotfix): mint a short-lived signed ticket for a SAME-ORIGIN streaming
// download of an oversized attachment. Returns { ticket, url } where url is the
// public /api/files/dl/:ticket path the browser navigates to (streamed through the
// backend proxy — no MinIO exposure, no OOM, no permanent public link). Membership
// is enforced by mintDownloadTicket (permissionFor) and re-checked on download.
router.get("/:id/download-ticket", async (req, res) => {
  const ticket = await mintDownloadTicket({
    fileId: req.params.id,
    userId: req.user.userId,
  });
  if (!ticket)
    return res.status(404).json(fail("NOT_FOUND", "File not found"));
  res.json(ok({ ticket, url: "/api/files/dl/" + encodeURIComponent(ticket) }));
});

router.post("/:id/star", async (req, res) => {
  const f = await setStar({
    fileId: req.params.id,
    userId: req.user.userId,
    starred: !!(req.body && req.body.starred),
  });
  if (!f) return res.status(404).json(fail("NOT_FOUND", "File not found"));
  res.json(ok(f));
});

router.delete("/:id", async (req, res) =>
  res.json(
    ok(await remove({ fileId: req.params.id, userId: req.user.userId })),
  ),
);

// POST /api/files/:id/restore — recover a soft-deleted file from the recycle bin.
// Owner-only (the service guards on uploaderId, mirroring delete). The S3 blob
// was retained on soft-delete, so the bytes are intact. 404 if the file isn't in
// the caller's trash (not found / not owned / already live).
router.post("/:id/restore", async (req, res) => {
  const f = await restore({ fileId: req.params.id, userId: req.user.userId });
  if (!f)
    return res
      .status(404)
      .json(fail("NOT_FOUND", "File not found in your recycle bin"));
  await record({
    actorId: req.user.userId,
    action: "file.restore",
    targetType: "file",
    targetId: req.params.id,
  });
  // Real-time: a file restored in one tab should appear live in the owner's other
  // open tabs (recycle-bin + files list reconcile) without a manual refresh,
  // mirroring the share path. Restore is owner-only, so broadcast to the owner's
  // user room. Best-effort — never fail the restore on a socket hiccup.
  try {
    const io = req.app.get("io");
    if (io)
      io.to(broadcast.userRoom(req.user.userId)).emit(EVENTS.FILE_CHANGED, {});
  } catch (_) {
    /* never break restore on a notify error */
  }
  res.json(ok(f));
});

// Sharing (P1.13)
router.get("/:id/details", async (req, res) => {
  const d = await details(req.params.id, req.user.userId);
  if (!d) return res.status(404).json(fail("NOT_FOUND", "File not found"));
  res.json(ok(d));
});
router.get("/:id/shares", async (req, res) => {
  const s = await listShares(req.params.id, req.user.userId);
  if (!s) return res.status(404).json(fail("NOT_FOUND", "File not found"));
  res.json(ok(s));
});
router.post("/:id/share", async (req, res) => {
  const b = req.body || {};
  const s = await share({
    fileId: req.params.id,
    byUserId: req.user.userId,
    subjectType: b.subjectType,
    subjectId: b.subjectId,
    permission: b.permission,
  });
  if (!s) return res.status(404).json(fail("NOT_FOUND", "File not found"));
  await record({
    actorId: req.user.userId,
    action: "file.share",
    targetType: "file",
    targetId: req.params.id,
    detail: { subjectType: b.subjectType, permission: b.permission },
  });
  // Real-time: a direct (user) share notifies the recipient live and refreshes
  // their files list with no refresh. Group/channel fan-out is a follow-up.
  try {
    const io = req.app.get("io");
    if (
      b.subjectType === "user" &&
      b.subjectId &&
      b.subjectId !== req.user.userId
    ) {
      const [sharer, d] = await Promise.all([
        db.users.getById(req.user.userId),
        details(req.params.id, req.user.userId).catch(() => null),
      ]);
      const n = await notificationService.notifyFileShared({
        userId: b.subjectId,
        sharerName: (sharer && sharer.name) || "Someone",
        fileId: req.params.id,
        fileName: (d && (d.name || d.fileName)) || "a file",
      });
      pushNotif(io, n);
      if (io)
        io.to(broadcast.userRoom(b.subjectId)).emit(EVENTS.FILE_CHANGED, {});
    } else if (b.subjectType === "conversation" && b.subjectId && io) {
      // Group/channel share: refresh the files list live for anyone viewing
      // that conversation's room. No mass per-member notification (avoids
      // channel-share notification spam; mirrors Teams/Slack behavior).
      io.to(broadcast.room(b.subjectId)).emit(EVENTS.FILE_CHANGED, {});
    }
  } catch (_) {
    /* never break sharing on a notify error */
  }
  res.status(201).json(ok(s));
});
router.delete("/:id/shares/:shareId", async (req, res) => {
  const out = await unshare({
    shareId: req.params.shareId,
    userId: req.user.userId,
  });
  await record({
    actorId: req.user.userId,
    action: "file.unshare",
    targetType: "file",
    targetId: req.params.id,
  });
  res.json(ok(out));
});
router.post("/:id/link", async (req, res) => {
  const l = await createLink({
    fileId: req.params.id,
    userId: req.user.userId,
    permission: (req.body || {}).permission,
  });
  await record({
    actorId: req.user.userId,
    action: "file.link.create",
    targetType: "file",
    targetId: req.params.id,
  });
  res.json(ok(l));
});
router.delete("/:id/link", async (req, res) => {
  const out = await revokeLink({
    fileId: req.params.id,
    userId: req.user.userId,
  });
  await record({
    actorId: req.user.userId,
    action: "file.link.revoke",
    targetType: "file",
    targetId: req.params.id,
  });
  res.json(ok(out));
});

export default router;
