import { currentOrgId } from "../orgContext";
import { createMysqlConnectorsRepo } from "./mysqlConnectors";

// The DIRECT org-scoped tables (Organizations Phase 0). A SELECT/UPDATE/DELETE that
// touches one of these MUST carry an `organization_id` predicate. unscopedOrgTable()
// returns the first offending table (or null), so the q() tripwire and its unit test
// share ONE detector. PURE: no env, no DB.
const ORG_DIRECT_TABLES = new Set<string>([
  "conversations", "meetings", "tasks", "files", "reminders", "folders",
  "calls", "notifications", "task_projects", "invites", "user_blocks",
  "user_reports",
]);
export function unscopedOrgTable(rawSql: string): string | null {
  const sql = String(rawSql || "")
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
  const verb = (sql.match(/^\s*(select|update|delete)\b/i) || [])[1];
  if (!verb) return null; // INSERT / DDL / SET / etc. are not policed
  if (/^\s*select\s+1\b/i.test(sql)) return null; // health / existence probes
  const tables = new Set<string>();
  const re = /\b(?:from|join|update|delete\s+from)\s+`?([a-z_][a-z0-9_]*)`?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) tables.add(m[1].toLowerCase());
  let hit: string | null = null;
  for (const t of tables) if (ORG_DIRECT_TABLES.has(t)) { hit = t; break; }
  if (!hit) return null; // no org-scoped table in play
  if (/\borganization_id\b/i.test(sql)) return null; // carries a tenant predicate
  return hit;
}

// Build a BOOLEAN-MODE FULLTEXT term string from a raw search query (0072):
// optional word terms (any match scores; more matches rank higher) with a
// prefix `*` on the trailing term for search-as-you-type — the same shape
// messages.search has used since 0017, minus the `+` (the ILIKE recall floor
// makes required-terms unnecessary and optional terms rank partial matches).
// Returns "" when the query has no indexable tokens (caller falls back to the
// legacy LIKE-only query).
function ftsBool(qry: any): string {
  const terms = String(qry || "")
    .toLowerCase()
    .match(/[a-z0-9]+/g);
  if (!terms || !terms.length) return "";
  return terms
    .map((w, i) => (i === terms.length - 1 ? w + "*" : w))
    .join(" ");
}

// MySQL repository (production). `mysql2` required lazily so the in-memory
// driver needs no native deps.
function createMysqlDb(config) {
  const mysql = require("mysql2/promise");
  const { randomUUID, createHash } = require("crypto");
  const u = new URL(config.database.url);
  const pool = mysql.createPool({
    // Prefer IPv4 — "localhost" resolves to ::1 first, which Docker's port
    // forwarding often doesn't answer.
    host: u.hostname === "localhost" ? "127.0.0.1" : u.hostname,
    port: Number(u.port) || 3306,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.replace(/^\//, "")),
    timezone: "Z", // store/read DATETIME in UTC, matching the app's ISO strings
    charset: "utf8mb4",
    // Tunable per deployment. Default raised to 20 (was 10, which saturated
    // quickly under load). Raise via DB_POOL_LIMIT toward your MySQL
    // max_connections (default 151) for busier servers / more replicas.
    connectionLimit: Number(process.env.DB_POOL_LIMIT) || 20,
    waitForConnections: true,
    // AUDIT P2 (#40): bound the wait queue + connect time so a saturation spike or
    // a hot lock FAILS FAST (callers get an error and can 503/retry) instead of the
    // whole app hanging with every request queued forever. queueLimit defaults to a
    // few multiples of the pool; connectTimeout guards a wedged DB.
    queueLimit: Number(process.env.DB_QUEUE_LIMIT) || (Number(process.env.DB_POOL_LIMIT) || 20) * 4,
    connectTimeout: Number(process.env.DB_CONNECT_TIMEOUT_MS) || 10000,
    enableKeepAlive: true,
  });
  const genId = () => randomUUID();
  // App code is written against Postgres SQL. Translate the handful of dialect
  // differences we keep inline (the rest are rewritten per query):
  //   - "= ANY($n)"  -> "IN ($n)"     (mysql2 expands an array param in IN (?))
  //   - ILIKE        -> LIKE          (MySQL LIKE is case-insensitive by collation)
  const translate = (sql: string) =>
    sql.replace(/=\s*ANY\s*\(/gi, "IN (").replace(/\bILIKE\b/gi, "LIKE");
  // Postgres reuses/reorders $1..$n; MySQL uses positional `?`. Rewrite $n to ?
  // in order of appearance and build the matching positional parameter list.
  const bind = (sql: string, params: any[]) => {
    const out: any[] = [];
    const text = sql.replace(/\$(\d+)/g, (_m, n) => {
      out.push(params[Number(n) - 1]);
      return "?";
    });
    return { text, params: out };
  };
  // mysql2 won't accept ISO strings ("…Z") for DATETIME reliably; pass Dates.
  const normParam = (v: any) => {
    if (v instanceof Date || Buffer.isBuffer(v)) return v;
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) {
      const d = new Date(v);
      if (!Number.isNaN(d.getTime())) return d;
    }
    return v;
  };
  // ── Organizations tenant-filter helper (Phase 1 scoping sweep) ──────────────
  // Append a conditional `organization_id` predicate to a query, AUTO-NUMBERING
  // the positional param right after the caller's existing params (so we never
  // hand-count $N across ~60 heterogeneous queries). Returns {clause, params}.
  //   const { clause, params } = orgFilter([rid, userId]);
  //   await q(`... WHERE id=$1 AND user_id=$2${clause}`, params);
  // NULL-org (legacy/pre-cutover) session → currentOrgId() is null → NO clause →
  // prior behavior preserved (and single-tenant is a no-op since one org). `col`
  // carries a table alias for JOINed reads (e.g. "t.organization_id").
  const orgFilter = (baseParams: any[], col = "organization_id") => {
    const orgId = currentOrgId();
    if (!orgId) return { clause: "", params: baseParams };
    return { clause: ` AND ${col}=$${baseParams.length + 1}`, params: [...baseParams, orgId] };
  };
  // NULL-TOLERANT variant: same as orgFilter but also admits rows whose org is
  // NULL. Those are pre-org legacy rows and cross-boundary records (an invited
  // external contact has no org, so a DM/call/invite involving them is stamped
  // NULL) — excluding them makes real history VANISH for a session that has
  // become org-bound. This mirrors the shape already inlined in
  // conversations.listForUser; user-facing LISTS should use this, so that a
  // list and the widgets ranking it can never disagree about what exists.
  // A NULL-org row belongs to no other tenant, so admitting your own leaks
  // nothing across the boundary.
  const orgFilterOrNull = (baseParams: any[], col = "organization_id") => {
    const orgId = currentOrgId();
    if (!orgId) return { clause: "", params: baseParams };
    const n = baseParams.length + 1;
    return {
      clause: ` AND (${col}=$${n} OR ${col} IS NULL)`,
      params: [...baseParams, orgId],
    };
  };
  // NOTE: One API is a STRUCTURED-JSON gateway (table/columns/joins/conditions),
  // not a raw-SQL endpoint, so it cannot transparently back this SQL-based driver
  // (it can't express FULLTEXT, window functions, ON DUPLICATE KEY upserts, or
  // FOR UPDATE). CoLab's own data therefore stays on the direct pool here; One API
  // is exposed as an explicit structured helper (src/oneApiClient.ts) for the
  // specific calls that suit it. See docs/ONE_API.md.
  // ── Tenant-isolation tripwire (Organizations Phase 0) ──────────────────────
  // Every query passes through q(), so this ONE place can assert that a
  // SELECT/UPDATE/DELETE touching a DIRECT org-scoped table carries an
  // `organization_id` predicate — turning "forgot the tenant filter" into a loud
  // failure instead of a silent cross-tenant leak.
  //
  // OPT-IN for now (COLAB_ORG_GUARD=1): Phase 0 only lands the columns; the
  // read/write paths are not org-scoped until Phase 1, so a default-on guard would
  // throw on every existing query. Phase 1 flips it default-on (non-prod) as the
  // queries get scoped. NEVER active in production (defense-in-depth, not a
  // prod-latency/crash risk); the real boundary is the app-layer scoping + this guard.
  const assertOrgScoped = (rawSql: string) => {
    if (process.env.COLAB_ORG_GUARD !== "1") return; // opt-in until Phase 1
    if (process.env.NODE_ENV === "production") return; // never in prod
    const hit = unscopedOrgTable(rawSql);
    if (hit)
      throw new Error(
        `[org-guard] query touches org-scoped table "${hit}" without an organization_id ` +
          `predicate — scope it to the tenant (Organizations). Set COLAB_ORG_GUARD=0 to ` +
          `bypass. SQL: ${String(rawSql).replace(/\s+/g, " ").trim().slice(0, 300)}`,
      );
  };

  // Transient MySQL failures worth ONE-OR-TWO short retries: deadlock (1213) and
  // lock-wait timeout (1205) — the server itself tells you to retry these — plus a
  // dropped pooled connection. We retry ONLY read-only (SELECT) statements: a
  // retried INSERT/UPDATE/DELETE could double-apply, so writes fail fast to the
  // caller instead. This is a bounded, in-process resilience shim (no new infra).
  const RETRYABLE_ERRNOS = new Set([1213, 1205, 1040, 1203]); // + too-many-connections / per-user cap
  const RETRYABLE_CODES = new Set([
    "PROTOCOL_CONNECTION_LOST",
    "ECONNRESET",
    "ETIMEDOUT",
    // Pool churn under load: a burst that momentarily exhausts the pool/queue
    // (or a connect that times out mid-burst) returned a hard 500 that the
    // frontend rendered as "data missing". These are exactly as transient as a
    // dropped connection — worth the same bounded SELECT-only retry.
    "ECONNREFUSED",
    "POOL_ENQUEUELIMIT",
    "POOL_CLOSED",
    "ER_CON_COUNT_ERROR",
  ]);
  const isRetryableDbError = (e: any) =>
    !!e && (RETRYABLE_ERRNOS.has(e.errno) || RETRYABLE_CODES.has(e.code));

  // pg-compatible result shim: SELECT -> { rows }, write -> { rowCount }.
  const q = async (t: string, p: any = []) => {
    assertOrgScoped(t);
    const bound = bind(translate(t), p || []);
    const params = bound.params.map(normParam);
    const readOnly = /^\s*select\b/i.test(t);
    let attempt = 0;
    for (;;) {
      try {
        const [res]: any = await pool.query(bound.text, params);
        if (Array.isArray(res)) return { rows: res, rowCount: res.length };
        return { rows: [], rowCount: (res && res.affectedRows) || 0 };
      } catch (e: any) {
        if (readOnly && attempt < 2 && isRetryableDbError(e)) {
          attempt++;
          // Small backoff + jitter so contending transactions don't re-collide.
          await new Promise((r) => setTimeout(r, 40 * attempt + Math.floor(Math.random() * 30)));
          continue;
        }
        throw e;
      }
    }
  };
  const mapUser = (r) =>
    r && {
      id: r.id,
      email: r.email,
      name: r.name,
      initials: r.initials,
      color: r.color,
      avatarUrl: r.avatar_url,
      about: r.about || null,
      title: r.title || null,
      pronouns: r.pronouns || null,
      phone: r.phone || null,
      timezone: r.timezone || null,
      role: r.role,
      presence: r.presence,
      manualPresence: r.manual_presence || null,
      lastSeen: r.last_seen || null,
      shareLastSeen: r.share_last_seen == null ? true : !!r.share_last_seen,
      passwordHash: r.password_hash,
      ssoEnabled: !!r.sso_enabled,
    };
  const mapMsg = (r) => ({
    id: r.id,
    conversationId: r.conversation_id,
    senderId: r.sender_id,
    body: r.body,
    file: r.file_json,
    type: r.type || "text",
    voice: r.voice_json || null,
    encryptionVersion: Number(r.encryption_version) || 0,
    ciphertext: r.ciphertext_json || null,
    forwarded: r.forwarded,
    forwardCount: Number(r.forward_count) || 0,
    edited: r.edited,
    deleted: !!r.deleted,
    reactions: r.reactions_json || [],
    createdAt: r.created_at,
    parentMessageId: r.parent_message_id || null,
    replyCount: r.reply_count != null ? Number(r.reply_count) : 0,
    lastReplyAt: r.last_reply_at || null,
    pinned: !!r.pinned,
    pinnedBy: r.pinned_by || null,
    pinnedAt: r.pinned_at || null,
    important: !!r.important,
  });
  const mapGuestDevice = (r) => ({
    meetingId: r.meeting_id,
    deviceId: r.device_id,
    userId: r.user_id,
    joinCount: Number(r.join_count) || 1,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    // the bound guest row is gone or soft-deleted → the binding is stale
    userDeleted: r.user_deleted == null ? true : !!Number(r.user_deleted),
  });
  const mapMtg = (r) => ({
    id: r.id,
    title: r.title,
    startsAt: r.starts_at,
    durationMin: r.duration_min,
    createdBy: r.created_by,
    conversationId: r.conversation_id,
    status: r.status || "scheduled",
    hardEnded: !!r.hard_ended, // AUDIT #9: host "ended for everyone" — session sealed
    lobbyEnabled: !!r.lobby_enabled,
    locked: !!r.locked,
    // Agenda / where (0118). Null on every meeting created before the field.
    description: r.description == null ? null : String(r.description),
    location: r.location == null ? null : String(r.location),
    // PER-MEETING OPTIONS (0116). `lobbyEnabled` above is kept as a mirror of
    // lobbyPolicy <> 'everyone' so every existing reader keeps working; these
    // are the finer-grained policy the token grant is actually built from.
    lobbyPolicy: r.lobby_policy || "everyone",
    allowMic: r.allow_mic == null ? true : !!r.allow_mic,
    allowCamera: r.allow_camera == null ? true : !!r.allow_camera,
    allowChat: r.allow_chat == null ? true : !!r.allow_chat,
    allowReactions: r.allow_reactions == null ? true : !!r.allow_reactions,
    // Admin-only switch (0133): the portal can shut the shared whiteboard down.
    allowWhiteboard: r.allow_whiteboard == null ? true : !!r.allow_whiteboard,
    // Host Settings modal (0134).
    allowScreenShare: r.allow_screen_share == null ? true : !!r.allow_screen_share,
    hostAllowWhiteboard: r.host_allow_whiteboard == null ? true : !!r.host_allow_whiteboard,
    autoRecord: !!r.auto_record,
    recurrence: r.recurrence || "none",
    recurrenceRule: r.recurrence_rule
      ? (() => { try { return JSON.parse(r.recurrence_rule); } catch { return null; } })()
      : null,
    // AUDIT #31: IANA timezone the recurring series was created in, so occurrences
    // expand DST-correctly. NULL → legacy server-local.
    timezone: r.timezone || null,
    // MEETING-REMINDER SCHEDULER (#53): minutes before starts_at to notify
    // attendees. NULL/0 = no meeting reminder.
    reminderLeadMin: r.reminder_lead_min == null ? null : Number(r.reminder_lead_min),
    // Per-occurrence state (RSCH-02/RCR-20/RCR-23): cancelled-occurrence day
    // keys and per-occurrence overrides, keyed by the ORIGINAL occurrence day.
    exdates: r.exdates
      ? (() => { try { const v = JSON.parse(r.exdates); return Array.isArray(v) ? v : []; } catch { return []; } })()
      : [],
    occurrenceOverrides: r.occurrence_overrides
      ? (() => { try { const v = JSON.parse(r.occurrence_overrides); return v && typeof v === "object" ? v : {}; } catch { return {}; } })()
      : {},
    icsSequence: r.ics_sequence == null ? 0 : Number(r.ics_sequence),
    // Tenant the meeting belongs to, and the secret behind its public (guest)
    // join link (0132). The token is host-only: serializeMeeting exposes just a
    // boolean, and the token itself leaves the server only via the host-gated
    // public-link route.
    organizationId: r.organization_id || null,
    publicLinkToken: r.public_link_token || null,
  });
  const mapRec = (r) => ({
    id: r.id,
    meetingId: r.meeting_id,
    startedBy: r.started_by,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    status: r.status,
    storageKey: r.storage_key,
    playbackUrl: r.playback_url,
    egressId: r.egress_id,
    durationSec: r.duration_sec,
    sizeBytes: Number(r.size_bytes) || 0,
    createdAt: r.created_at,
  });
  const mapVm = (r) => ({
    id: r.id,
    callId: r.call_id,
    fromUser: r.from_user,
    toUser: r.to_user,
    fileId: r.file_id,
    durationSec: r.duration_sec,
    listened: r.listened,
    createdAt: r.created_at,
  });
  const mapFile = (r) =>
    r && {
      id: r.id,
      conversationId: r.conversation_id,
      uploaderId: r.uploader_id,
      name: r.name,
      mime: r.mime,
      size: Number(r.size) || 0,
      storageKey: r.storage_key || null,
      storageBackend: r.storage_backend || null,
      createdAt: r.created_at,
      starred: !!r.starred,
      shareToken: r.share_token || null,
      linkPermission: r.link_permission || null,
      encryptionVersion: Number(r.encryption_version) || 0,
      ciphertextMeta: r.ciphertext_meta || null,
    };

  const users = {
    async getById(id) {
      return mapUser(
        (await q("SELECT * FROM users WHERE id=$1", [id])).rows[0],
      );
    },
    // Login + lookup-by-identity MUST exclude soft-deleted accounts (a deleted
    // user can never log in or be resolved by their freed-up email/name).
    async getByEmail(email) {
      return mapUser(
        (await q("SELECT * FROM users WHERE email=$1 AND deleted=0", [email])).rows[0],
      );
    },
    async getByName(name) {
      // id-only projection: getByName's ONLY caller is the @mention resolver
      // (notificationService.resolveMentions), which reads just `.id`. Selecting
      // `id` instead of `*` keeps this off the users.avatar_url TEXT data-URL blob
      // (review: "SELECT * pulls large TEXT columns callers don't need"). mapUser
      // tolerates the minimal row — every other field is simply undefined, which
      // no caller reads. Behaviour (a resolved id, or null on no match) unchanged.
      return mapUser(
        (await q("SELECT id FROM users WHERE name=$1 AND deleted=0 LIMIT 1", [name])).rows[0],
      );
    },
    // Batch resolve users by id in ONE query (fixes serialize N+1 on task lists).
    // Like getById, this is intentionally NOT filtered by `deleted` so a
    // soft-deleted (anonymized) assignee/reporter still resolves to its shell for
    // rendering old rows. Returns only the rows that exist; callers map by id.
    async getByIds(ids) {
      const list = (ids || []).filter(Boolean);
      if (!list.length) return [];
      return (
        await q("SELECT * FROM users WHERE id = ANY($1)", [list])
      ).rows.map(mapUser);
    },
    async list(orgId) {
      // AUDIT P1: scope the directory to the active org's members — a global users
      // table leaks the cross-org social graph + PII (name/title/pronouns/phone/
      // timezone) to every tenant. Mirrors search(). A NULL-org (legacy) session
      // keeps the prior global behavior for backward compatibility.
      const orgClause = orgId
        ? " AND EXISTS (SELECT 1 FROM organization_members om WHERE om.user_id=users.id AND om.organization_id=$1 AND om.status='active' AND om.deleted=0)"
        : "";
      return (
        await q(
          `SELECT * FROM users WHERE deleted=0${orgClause} ORDER BY name`,
          orgId ? [orgId] : [],
        )
      ).rows.map(mapUser);
    },
    // Paginated + optionally-searched directory for the Contacts list (offset
    // paging, ORDER BY name to match the UI's alphabetical order). Same org scope
    // as list()/search(). We fetch limit+1 rows to report hasMore without a second
    // COUNT query. LIMIT/OFFSET are validated integers (never user strings).
    async listPage({ orgId, q: qry, limit, offset }: any = {}) {
      // Floor to integers so a hand-crafted ?limit=50.5 / ?offset=1e21 can't reach
      // the SQL as a non-integer and 500 with a syntax error.
      const lim = Math.min(Math.max(Math.floor(Number(limit)) || 50, 1), 100);
      const off = Math.max(Math.floor(Number(offset)) || 0, 0);
      const params = [];
      let clause = "";
      const search = String(qry || "").trim();
      if (search) {
        // Escape LIKE wildcards so "50%" / "a_b" match literally (mirrors search()).
        params.push("%" + search.replace(/[\\%_]/g, (c) => "\\" + c) + "%");
        clause += ` AND (name ILIKE $${params.length} OR email ILIKE $${params.length})`;
      }
      if (orgId) {
        params.push(orgId);
        clause += ` AND EXISTS (SELECT 1 FROM organization_members om WHERE om.user_id=users.id AND om.organization_id=$${params.length} AND om.status='active' AND om.deleted=0)`;
      }
      const rows = (
        await q(
          `SELECT * FROM users WHERE deleted=0${clause} ORDER BY name, id LIMIT ${lim + 1} OFFSET ${off}`,
          params,
        )
      ).rows;
      const hasMore = rows.length > lim;
      return { users: rows.slice(0, lim).map(mapUser), hasMore };
    },
    // NOTE: getById() above is INTENTIONALLY NOT filtered by deleted — message/
    // call rendering resolves senders by id, and a soft-deleted (anonymized)
    // user must still resolve to its "Deleted user" shell so old threads render.
    async upsert(u) {
      await q(
        // ON DUPLICATE: revive any soft-deleted account on a fresh upsert
        // (deleted=0) so a re-signup never silently resurrects a dead, anonymized
        // row — it comes back as a clean live account.
        `INSERT INTO users (id,email,name,initials,color,avatar_url,role,presence,password_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) AS new ON DUPLICATE KEY UPDATE email=new.email,name=new.name,initials=new.initials,color=new.color,avatar_url=new.avatar_url,role=new.role,presence=new.presence,password_hash=COALESCE(new.password_hash, users.password_hash),deleted=0,deleted_at=NULL,deleted_by=NULL`,
        [
          u.id,
          u.email,
          u.name,
          u.initials,
          u.color,
          u.avatarUrl || null,
          u.role || "member",
          u.presence || "off",
          u.passwordHash || null,
        ],
      );
      // Never depend on read-after-write visibility: on a slow / read-write-split
      // shared DB the row may not be readable immediately, which previously made
      // upsert() return undefined and crashed signup. Fall back to what we wrote.
      return (
        (await this.getById(u.id)) || {
          id: u.id,
          email: u.email,
          name: u.name,
          initials: u.initials,
          color: u.color,
          avatarUrl: u.avatarUrl || null,
          role: u.role || "member",
          presence: u.presence || "off",
          passwordHash: u.passwordHash || null,
        }
      );
    },
    // Soft-delete + anonymize an account. Frees the UNIQUE email (so it can be
    // re-registered), blanks PII, but KEEPS the row so authored messages still
    // resolve to a "Deleted user" shell (messages.sender_id is FK RESTRICT, so a
    // true row delete is impossible anyway). Cascade of the user's other data is
    // driven by accountService (explicit soft-cascade).
    async softDelete(id, actorId) {
      await q(
        `UPDATE users SET deleted=1, deleted_at=now(3), deleted_by=$2,
           email=CONCAT('deleted+', id, '@deleted.invalid'),
           name='Deleted user', avatar_url=NULL, about=NULL, manual_presence=NULL
         WHERE id=$1 AND deleted=0`,
        [id, actorId || null],
      );
      return this.getById(id);
    },
    // Full account deletion = anonymize the user + soft-cascade everything they OWN,
    // while KEEPING authored content (messages/meeting messages/task comments/
    // recordings/call logs) attached to the anonymized "Deleted user" shell — a
    // true row delete is impossible (messages.sender_id is FK RESTRICT) and would
    // corrupt other people's history. Sequential UPDATEs (no hard delete anywhere).
    async deleteAccount(userId, actorId) {
      const by = actorId || userId;
      // 1) Anonymize + soft-delete the account itself (frees the UNIQUE email).
      await this.softDelete(userId, by);
      // 2) Soft-delete the collections the user OWNS (former FK ON DELETE CASCADE).
      const owned: Array<[string, string]> = [
        ["conversation_members", "user_id"], ["bookmarks", "user_id"],
        ["meeting_attendees", "user_id"], ["meeting_presence", "user_id"],
        ["folders", "user_id"], ["reminders", "user_id"], ["notifications", "user_id"],
        ["scheduled_messages", "sender_id"],
        ["voicemails", "from_user"], ["voicemails", "to_user"],
        ["user_blocks", "blocker_id"], ["user_blocks", "blocked_id"],
        ["user_reports", "reporter_id"], ["user_reports", "reported_id"],
        ["invites", "from_user_id"], ["invites", "to_user_id"],
        // Organizations: drop the user's memberships (the DELETE /account route
        // already blocked deletion if they solely own any org — orgsSolelyOwnedBy).
        ["organization_members", "user_id"], ["team_members", "user_id"],
      ];
      for (const [tbl, col] of owned) {
        await q(`UPDATE \`${tbl}\` SET deleted=1, deleted_at=now(3), deleted_by=$2 WHERE \`${col}\`=$1 AND deleted=0`, [userId, by]);
      }
      // 3) Revoke the user's E2EE devices (uses the existing `revoked` flag).
      await q("UPDATE e2ee_devices SET revoked=true WHERE user_id=$1 AND revoked=false", [userId]);
      // 4) Former ON DELETE SET NULL: detach references but KEEP the shared content.
      await q("UPDATE notifications SET actor_id=NULL WHERE actor_id=$1", [userId]);
      await q("UPDATE tasks SET assignee_id=NULL WHERE assignee_id=$1", [userId]);
      await q("UPDATE tasks SET reporter_id=NULL WHERE reporter_id=$1", [userId]);
      await q("UPDATE task_activity SET actor_id=NULL WHERE actor_id=$1", [userId]);
      // Drop the deleted user from the multi-assignee + watcher sets so they no
      // longer appear as an assignee/watcher anywhere. Re-point any task whose
      // PRIMARY was this user at its new oldest assignee (or NULL).
      const primaryTasks = (
        await q("SELECT id FROM tasks WHERE assignee_id IS NULL AND id IN (SELECT task_id FROM task_assignees WHERE user_id=$1)", [userId])
      ).rows.map((r: any) => r.id);
      await q("DELETE FROM task_assignees WHERE user_id=$1", [userId]);
      await q("DELETE FROM task_watchers WHERE user_id=$1", [userId]);
      for (const tid of primaryTasks) {
        const next = (
          await q("SELECT user_id FROM task_assignees WHERE task_id=$1 ORDER BY assigned_at ASC, user_id ASC LIMIT 1", [tid])
        ).rows[0];
        await q("UPDATE tasks SET assignee_id=$2 WHERE id=$1", [tid, next ? next.user_id : null]);
      }
      return { id: userId, deleted: true };
    },
    // Organizations: orgs where `userId` is the ONLY active owner — deleting the
    // account (or leaving) would orphan the tenant, so those flows must block on this
    // and require an ownership transfer first (the >=1-active-owner invariant).
    async orgsSolelyOwnedBy(userId) {
      return (
        await q(
          `SELECT o.id, o.name
             FROM organizations o
             JOIN organization_members m
               ON m.organization_id = o.id AND m.user_id = $1
              AND m.role = 'owner' AND m.status = 'active' AND m.deleted = 0
            WHERE o.deleted = 0 AND o.status = 'active'
              AND (SELECT COUNT(*) FROM organization_members m2
                     WHERE m2.organization_id = o.id AND m2.role = 'owner'
                       AND m2.status = 'active' AND m2.deleted = 0) = 1`,
          [userId],
        )
      ).rows;
    },
    async setPresence(id, presence) {
      // Stamp last_seen when going offline so "last seen <time>" is accurate.
      if (presence === "off") {
        await q("UPDATE users SET presence=$2, last_seen=now() WHERE id=$1", [id, presence]);
      } else {
        await q("UPDATE users SET presence=$2 WHERE id=$1", [id, presence]);
      }
      return this.getById(id);
    },
    async setShareLastSeen(id, share) {
      await q("UPDATE users SET share_last_seen=$2 WHERE id=$1", [id, share ? 1 : 0]);
    },
    // Mark a user as SSO-capable (idempotent). Called on every successful SSO
    // sign-in; never cleared here — a local password can still coexist.
    async setSsoEnabled(id) {
      await q("UPDATE users SET sso_enabled=1 WHERE id=$1", [id]);
      return this.getById(id);
    },
    // Overwrite a user's password hash. The caller is responsible for validating
    // strength and producing the scrypt "saltHex:hashHex" — this layer only stores
    // it. Used by the admin password-reset flow (forgotten-password recovery).
    async updatePassword(id, passwordHash) {
      await q("UPDATE users SET password_hash=$2 WHERE id=$1", [id, passwordHash]);
      return this.getById(id);
    },
    // Manual presence override (full Teams set). Only away/busy/dnd/brb/offline
    // are stored; anything else (incl. "auto"/"active"/empty) clears the override
    // → automatic presence (Available). Column is VARCHAR(16), so no enum widening.
    async setManualPresence(id, status) {
      const val = ["away", "busy", "dnd", "brb", "offline"].includes(status)
        ? status
        : null;
      await q("UPDATE users SET manual_presence=$2 WHERE id=$1", [id, val]);
      return this.getById(id);
    },
    async updateAvatar(id, avatarUrl) {
      await q("UPDATE users SET avatar_url=$2 WHERE id=$1", [id, avatarUrl]);
      return this.getById(id);
    },
    async updateProfile(id, patch) {
      const sets: string[] = [];
      const vals: any[] = [id];
      let idx = 2;
      if (patch.name !== undefined) { sets.push(`name=$${idx++}`); vals.push(patch.name); }
      if (patch.about !== undefined) { sets.push(`about=$${idx++}`); vals.push(patch.about); }
      if (patch.avatarUrl !== undefined) { sets.push(`avatar_url=$${idx++}`); vals.push(patch.avatarUrl); }
      if (patch.title !== undefined) { sets.push(`title=$${idx++}`); vals.push(patch.title); }
      if (patch.pronouns !== undefined) { sets.push(`pronouns=$${idx++}`); vals.push(patch.pronouns); }
      if (patch.phone !== undefined) { sets.push(`phone=$${idx++}`); vals.push(patch.phone); }
      if (patch.timezone !== undefined) { sets.push(`timezone=$${idx++}`); vals.push(patch.timezone); }
      if (sets.length) await q(`UPDATE users SET ${sets.join(",")} WHERE id=$1`, vals);
      return this.getById(id);
    },
    async search(qry, orgId) {
      // Organizations: people search returns only members of the active org (a global
      // users table would leak the cross-org social graph). Conditional — a NULL-org
      // (legacy) session keeps the prior global behavior.
      const orgClause = orgId
        ? " AND EXISTS (SELECT 1 FROM organization_members om WHERE om.user_id=users.id AND om.organization_id=$2 AND om.status='active' AND om.deleted=0)"
        : "";
      // Escape LIKE wildcards so a query like "50%" or "a_b" matches literally
      // (mirrors files._searchFilter). Value is still a bound param — no injection.
      const like = "%" + String(qry || "").replace(/[\\%_]/g, (c) => "\\" + c) + "%";
      const rows = (
        await q(
          `SELECT * FROM users WHERE (name ILIKE $1 OR email ILIKE $1) AND deleted=0${orgClause} ORDER BY name LIMIT 20`,
          orgId ? [like, orgId] : [like],
        )
      ).rows;
      if (rows.length || !orgId) return rows.map(mapUser);
      // CONTACT-INVITATION escape hatch: the org scope above made everyone who
      // signed up but was never added to the org INVISIBLE to org members — the
      // invite flow could no longer find them at all. When the scoped search
      // comes up empty AND the query is a complete email address, look that ONE
      // address up globally. This is invite-by-known-address (Slack/Teams
      // external-contact style), not directory access: no wildcard, no listing,
      // no enumeration — you must already know the exact address, and you get
      // at most the one public card it belongs to.
      const email = String(qry || "").trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return [];
      return (
        await q(`SELECT * FROM users WHERE email = $1 AND deleted=0 LIMIT 1`, [email])
      ).rows.map(mapUser);
    },
    // Interaction frequency for a user: how much they've engaged each other
    // person, used to rank contacts/pickers "most-interacted first". Combines
    // DM message volume (both directions) with call count (weighted higher, a
    // call is a stronger signal than a message). Returns [{ userId, score }].
    async interactionScores(userId) {
      const scores = new Map();
      const add = (id, n) => {
        if (!id || id === userId) return;
        scores.set(id, (scores.get(id) || 0) + n);
      };
      // Messages exchanged in shared DMs, attributed to the other member.
      // ORG-SCOPED: without the tenant predicate this ranked peers from EVERY
      // org the caller has ever belonged to, so a brand-new organization opened
      // with the previous org's "frequent contacts" already populated. Both
      // `conversations` and `calls` are ORG_DIRECT_TABLES; the q() tripwire that
      // would have caught this is opt-in (COLAB_ORG_GUARD=1) and off in prod,
      // which is how it slipped through Phase 0 scoping.
      // Frequently-contacted must be STRICTLY the active org. orgFilterOrNull adds
      // `OR organization_id IS NULL`, which re-leaked legacy / unstamped DMs+calls
      // into EVERY org — so a brand-new org still showed the user's OLD contacts.
      // Scope to the active org EXACTLY (unscoped only when the session has no
      // active org, i.e. a legacy null-org session).
      const orgId = currentOrgId();
      const strictScope = (col: string) =>
        orgId
          ? { clause: ` AND ${col} = $2`, params: [userId, orgId] }
          : { clause: "", params: [userId] };
      const msgScope = strictScope("conv.organization_id");
      const msgRows = (
        await q(
          `SELECT cm2.user_id AS peer, COUNT(m.id) AS c
             FROM conversation_members cm1
             JOIN conversations conv ON conv.id = cm1.conversation_id AND conv.kind='dm' AND conv.deleted=0
             JOIN conversation_members cm2 ON cm2.conversation_id = conv.id AND cm2.user_id <> cm1.user_id AND cm2.deleted=0
             JOIN users pu ON pu.id = cm2.user_id AND pu.deleted=0
             LEFT JOIN messages m ON m.conversation_id = conv.id AND m.deleted=0
            WHERE cm1.user_id = $1 AND cm1.deleted=0${msgScope.clause}
            GROUP BY cm2.user_id`,
          msgScope.params,
        )
      ).rows;
      for (const r of msgRows) add(r.peer, Number(r.c) || 0);
      // Calls between the two parties (each call weighted as 3 messages).
      const callScope = strictScope("calls.organization_id");
      const callRows = (
        await q(
          `SELECT IF(initiator_id=$1, peer_id, initiator_id) AS peer, COUNT(*) AS c
             FROM calls
             JOIN users pu ON pu.id = IF(calls.initiator_id=$1, calls.peer_id, calls.initiator_id) AND pu.deleted=0
            WHERE (initiator_id=$1 OR peer_id=$1) AND peer_id IS NOT NULL${callScope.clause}
            GROUP BY peer`,
          callScope.params,
        )
      ).rows;
      for (const r of callRows) add(r.peer, (Number(r.c) || 0) * 3);
      return Array.from(scores.entries())
        .map(([id, score]) => ({ userId: id, score }))
        .sort((a, b) => b.score - a.score);
    },
  };
  const conversations = {
    async create(c) {
      const id = c.id || genId();
      // Organizations: stamp the active tenant on the new conversation (its org).
      const orgId = currentOrgId();
      const retentionDays =
        Number.isFinite(Number(c.retentionDays)) && Number(c.retentionDays) > 0
          ? Math.floor(Number(c.retentionDays))
          : 7;
      await q(
        "INSERT INTO conversations (id,kind,title,icon,created_by,dm_key,organization_id,temporary,expires_at,retention_days,pending_connection) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) AS new ON DUPLICATE KEY UPDATE kind=new.kind, title=new.title, icon=new.icon, deleted=0, deleted_at=NULL, dm_key=new.dm_key",
        [id, c.kind, c.title || null, c.icon || null, c.createdBy || null, c.dmKey || null, orgId, c.temporary ? 1 : 0, c.expiresAt || null, retentionDays, c.pendingConnection ? 1 : 0],
      );
      // Look up by the (globally unique) id we just wrote. On a dm_key collision the
      // row-alias upsert above UPDATED the pre-existing row instead of inserting —
      // and that row keeps its ORIGINAL id (and org), so a by-id lookup finds
      // nothing. Fall back to the canonical dm_key to return the surviving row
      // rather than dereferencing undefined (which surfaced as a 500 on invite
      // accept when the two DMs straddled an org boundary).
      let r = (await q(`SELECT * FROM conversations WHERE id=$1`, [id])).rows[0];
      if (!r && c.dmKey)
        r = (
          await q(`SELECT * FROM conversations WHERE dm_key=$1 AND deleted=0 LIMIT 1`, [c.dmKey])
        ).rows[0];
      return r
        ? { id: r.id, kind: r.kind, title: r.title, icon: r.icon }
        : { id, kind: c.kind, title: c.title || null, icon: c.icon || null };
    },
    // BA/CEO: daily GC — soft-delete auto-expiring temp groups past their TTL.
    async sweepExpiredTemporary() {
      const r = await q(
        "UPDATE conversations SET deleted=1, deleted_at=now(3), deleted_by='system:temp-gc', dm_key=NULL WHERE temporary=1 AND deleted=0 AND expires_at IS NOT NULL AND expires_at < NOW()",
        [],
      );
      return (r && r.rowCount) || 0;
    },
    // Teams-model pending messaging: flip the pending flag (1 at Connect, 0 on accept).
    async setPendingConnection(convId, val) {
      await q("UPDATE conversations SET pending_connection=$2 WHERE id=$1", [
        convId,
        val ? 1 : 0,
      ]);
    },
    // Tear down a STILL-PENDING DM (declined / cancelled / blocked). Soft-delete +
    // NULL the dm_key so a fresh Connect later mints a brand-new DM (no message
    // leakage from the rejected request). The `pending_connection=1` guard makes
    // this a no-op on any already-accepted conversation.
    async discardPending(convId) {
      const r = await q(
        "UPDATE conversations SET deleted=1, deleted_at=now(3), deleted_by='system:invite-rejected', dm_key=NULL WHERE id=$1 AND pending_connection=1 AND deleted=0",
        [convId],
      );
      return (r && r.rowCount) || 0;
    },
    async findByDmKey(dmKey) {
      if (!dmKey) return null;
      const orgId = currentOrgId();
      const r = (
        await q(
          `SELECT id FROM conversations WHERE dm_key=$1 AND deleted=0${orgId ? " AND organization_id=$2" : ""} LIMIT 1`,
          orgId ? [dmKey, orgId] : [dmKey],
        )
      ).rows[0];
      return r ? r.id : null;
    },
    // Sliding-window refresh: push a temp group's death clock out to
    // NOW()+retention_days on every activity (new message/attachment/recording/
    // session). No-op on permanent (temporary=0) or already-deleted rows.
    async touchTempExpiry(convId) {
      if (!convId) return 0;
      const r = await q(
        "UPDATE conversations SET expires_at = DATE_ADD(NOW(), INTERVAL retention_days DAY) WHERE id=$1 AND temporary=1 AND deleted=0",
        [convId],
      );
      return (r && r.rowCount) || 0;
    },
    // Change the retention window (days) AND immediately re-anchor expires_at from
    // now, so shortening can't retro-expire and extending applies at once.
    async setTempRetention(convId, days) {
      const d = Math.max(1, Math.min(3650, Math.floor(Number(days) || 7)));
      const r = await q(
        "UPDATE conversations SET retention_days=$2, expires_at = DATE_ADD(NOW(), INTERVAL $2 DAY) WHERE id=$1 AND temporary=1 AND deleted=0",
        [convId, d],
      );
      return { updated: (r && r.rowCount) || 0, retentionDays: d };
    },
    // Promote a temp group to a normal, permanent group: clear the flag + clock.
    async convertToPermanent(convId) {
      const r = await q(
        "UPDATE conversations SET temporary=0, expires_at=NULL WHERE id=$1 AND deleted=0",
        [convId],
      );
      return (r && r.rowCount) || 0;
    },
    async addMember(convId, userId, opts: any = {}) {
      await q(
        // Re-join revives a soft-removed member (deleted=0) instead of silently
        // no-op'ing on the surviving row.
        `INSERT INTO conversation_members (conversation_id,user_id,role,starred,muted) VALUES ($1,$2,$3,$4,$5) AS new ON DUPLICATE KEY UPDATE deleted=0, deleted_at=NULL, role=new.role, starred=new.starred, muted=new.muted`,
        [convId, userId, opts.role || "member", !!opts.starred, !!opts.muted],
      );
    },
    async setMemberRole(convId, userId, role) {
      await q(
        `UPDATE conversation_members SET role=$3 WHERE conversation_id=$1 AND user_id=$2`,
        [convId, userId, role],
      );
      return { conversationId: convId, userId, role };
    },
    // #16: stamp the moment a member joined a group WITHOUT prior-history
    // sharing. The message list hides anything older than this for them only.
    async setMemberHistoryCutoff(convId, userId) {
      await q(
        `UPDATE conversation_members SET history_visible_from = now(3) WHERE conversation_id=$1 AND user_id=$2`,
        [convId, userId],
      );
    },
    async removeMember(convId, userId, actorId) {
      await q(
        `UPDATE conversation_members SET deleted=1, deleted_at=now(3), deleted_by=$3 WHERE conversation_id=$1 AND user_id=$2 AND deleted=0`,
        [convId, userId, actorId || null],
      );
      return { conversationId: convId, userId, removed: true };
    },
    async setMemberFlag(convId, userId, flag, value) {
      if (flag === "unread") {
        await q(
          `UPDATE conversation_members SET unread=$3 WHERE conversation_id=$1 AND user_id=$2`,
          [convId, userId, Number(value) || 0],
        );
        return { userId, unread: Number(value) || 0 };
      }
      const cols = { starred: "starred", muted: "muted", hidden: "hidden" };
      const col = cols[flag] || "muted";
      await q(
        `UPDATE conversation_members SET ${col}=$3 WHERE conversation_id=$1 AND user_id=$2`,
        [convId, userId, !!value],
      );
      return { userId, [flag]: !!value };
    },
    async bumpUnread(convId, exceptUserId) {
      await q(
        `UPDATE conversation_members SET unread = unread + 1 WHERE conversation_id=$1 AND user_id <> $2 AND deleted=0`,
        [convId, exceptUserId],
      );
    },
    // Resurface a conversation for everyone who had hidden/archived it. A new
    // message must bring the chat back (WhatsApp/Teams/Slack), never lose it.
    async unhideAll(convId) {
      await q(
        `UPDATE conversation_members SET hidden=false WHERE conversation_id=$1 AND deleted=0`,
        [convId],
      );
    },
    async markRead(convId, userId) {
      await q(
        `UPDATE conversation_members SET unread=0, last_read_at=now() WHERE conversation_id=$1 AND user_id=$2`,
        [convId, userId],
      );
      const r = await q(
        `SELECT last_read_at FROM conversation_members WHERE conversation_id=$1 AND user_id=$2`,
        [convId, userId],
      );
      return {
        userId,
        lastReadAt: r.rows[0] ? r.rows[0].last_read_at : null,
      };
    },
    async readReceipts(convId) {
      return (
        await q(
          `SELECT user_id, last_read_at FROM conversation_members WHERE conversation_id=$1 AND last_read_at IS NOT NULL AND deleted=0`,
          [convId],
        )
      ).rows.map((r) => ({ userId: r.user_id, lastReadAt: r.last_read_at }));
    },
    async remove(cid, actorId) {
      // Soft-delete + EXPLICIT child soft-cascade (FK ON DELETE CASCADE no longer
      // fires on an UPDATE). dm_key is NULLed to free the UNIQUE slot for a fresh DM.
      // Messages are NOT tombstoned — the conversation + its memberships going
      // deleted=1 already make them inaccessible; tombstoning every row would be wrong.
      const by = actorId || null;
      // Organizations: the conversation is already tenant-validated by the caller; add
      // the org predicate to the DIRECT-table cascades so they can never touch another
      // tenant's rows (and to satisfy the q() guard). Non-DIRECT children unchanged.
      const orgId = currentOrgId();
      const oc3 = orgId ? " AND organization_id=$3" : "";
      const oc2 = orgId ? " AND organization_id=$2" : "";
      const p3 = orgId ? [cid, by, orgId] : [cid, by];
      const p1 = orgId ? [cid, orgId] : [cid];
      await q(`UPDATE conversations SET deleted=1, deleted_at=now(3), deleted_by=$2, dm_key=NULL WHERE id=$1${oc3}`, p3);
      await q("UPDATE conversation_members SET deleted=1, deleted_at=now(3), deleted_by=$2 WHERE conversation_id=$1 AND deleted=0", [cid, by]);
      await q(`UPDATE files SET deleted=1, deleted_at=now(3), deleted_by=$2 WHERE conversation_id=$1 AND deleted=0${oc3}`, p3);
      await q("UPDATE file_shares SET deleted=1, deleted_at=now(3) WHERE subject_type='conversation' AND subject_id=$1 AND deleted=0", [cid]);
      await q("UPDATE scheduled_messages SET deleted=1, deleted_at=now(3) WHERE conversation_id=$1 AND deleted=0", [cid]);
      await q("UPDATE bookmarks SET deleted=1, deleted_at=now(3) WHERE message_id IN (SELECT id FROM messages WHERE conversation_id=$1) AND deleted=0", [cid]);
      // Former ON DELETE SET NULL: detach call/invite references.
      await q(`UPDATE calls SET conversation_id=NULL WHERE conversation_id=$1${oc2}`, p1);
      await q(`UPDATE invites SET conversation_id=NULL WHERE conversation_id=$1${oc2}`, p1);
      return { id: cid, deleted: true };
    },
    // Existing 1:1 DM between two users, if any (used to gate duplicate connections).
    async findDmBetween(a, b) {
      const orgId = currentOrgId();
      const r = await q(
        `SELECT c.id FROM conversations c
           WHERE c.kind='dm' AND c.deleted=0${orgId ? " AND c.organization_id=$3" : ""}
             AND EXISTS (SELECT 1 FROM conversation_members m WHERE m.conversation_id=c.id AND m.user_id=$1 AND m.deleted=0)
             AND EXISTS (SELECT 1 FROM conversation_members m WHERE m.conversation_id=c.id AND m.user_id=$2 AND m.deleted=0)
           LIMIT 1`,
        orgId ? [a, b, orgId] : [a, b],
      );
      return r.rows[0] ? r.rows[0].id : null;
    },
    // Same as findDmBetween but ORG-AGNOSTIC. dm_key makes at most ONE DM per user
    // pair exist system-wide, so this resolves that single DM regardless of the
    // caller's active org. Used by invite-accept: the pending DM was stamped with
    // the SENDER's org at Connect time, but the recipient may be accepting while a
    // DIFFERENT org is active — the org-scoped findDmBetween would then miss it and
    // (before this) fall through to a create that collides on the global dm_key
    // index and 500s. Accept must operate on the existing DM wherever it lives.
    async findDmBetweenAny(a, b) {
      const r = await q(
        `SELECT c.id FROM conversations c
           WHERE c.kind='dm' AND c.deleted=0
             AND EXISTS (SELECT 1 FROM conversation_members m WHERE m.conversation_id=c.id AND m.user_id=$1 AND m.deleted=0)
             AND EXISTS (SELECT 1 FROM conversation_members m WHERE m.conversation_id=c.id AND m.user_id=$2 AND m.deleted=0)
           LIMIT 1`,
        [a, b],
      );
      return r.rows[0] ? r.rows[0].id : null;
    },
    async isMember(convId, userId) {
      const cid = String(convId || "");
      // Ephemeral MEETING chat ("meeting:<id>") has NO conversation_members rows —
      // membership IS participation in the meeting. Resolve it from the meeting
      // tables so in-meeting chat AND its E2EE key exchange work for every
      // participant: the host, a formal attendee, or someone currently in the room.
      // (Every message/E2EE membership check funnels through here, so fixing it
      // once makes meeting chat consistent across send, read, keys, and epoch.)
      const mm = /^meeting:(.+)$/.exec(cid);
      if (mm) {
        const mid = mm[1];
        const r = await q(
          `SELECT 1 FROM meetings WHERE id=$1 AND created_by=$2 AND deleted=0
           UNION SELECT 1 FROM meeting_attendees WHERE meeting_id=$1 AND user_id=$2 AND deleted=0
           UNION SELECT 1 FROM meeting_presence WHERE meeting_id=$1 AND user_id=$2 AND deleted=0
           LIMIT 1`,
          [mid, userId],
        );
        return r.rows.length > 0;
      }
      const r = await q(
        "SELECT 1 FROM conversation_members WHERE conversation_id=$1 AND user_id=$2 AND deleted=0 LIMIT 1",
        [convId, userId],
      );
      return r.rows.length > 0;
    },
    // K5 (iOS badge): conversations with unread activity for this user — the
    // number the sidebar shows as its dot count, sent as `aps.badge` so a
    // terminated iPhone's icon badge tracks unread chats. Muted conversations
    // don't count (they never notified). Fast: hits idx on (user_id).
    async unreadConversationCount(userId) {
      const r = (
        await q(
          `SELECT COUNT(*) AS n FROM conversation_members cm
             JOIN conversations c ON c.id = cm.conversation_id AND c.deleted = 0
            WHERE cm.user_id = $1 AND cm.deleted = 0 AND cm.muted = 0 AND cm.unread > 0`,
          [userId],
        )
      ).rows[0];
      return Number(r?.n) || 0;
    },
    async members(convId) {
      return (
        await q(
          "SELECT user_id, role, starred, muted, hidden, unread FROM conversation_members WHERE conversation_id=$1 AND deleted=0",
          [convId],
        )
      ).rows.map((r) => ({
        userId: r.user_id,
        role: r.role,
        starred: r.starred,
        muted: r.muted,
        hidden: r.hidden,
        unread: r.unread,
      }));
    },
    // Distinct user ids that share at least one conversation with `uid` (excluding
    // uid). Used to scope presence fan-out to people who can actually see this
    // user's presence dot. Index-backed (idx_members_user + members PK).
    async listPeerIds(uid) {
      return (
        await q(
          `SELECT DISTINCT m2.user_id
             FROM conversation_members m1
             JOIN conversation_members m2 ON m2.conversation_id = m1.conversation_id AND m2.deleted=0
            WHERE m1.user_id = $1 AND m2.user_id <> $1 AND m1.deleted=0`,
          [uid],
        )
      ).rows.map((r) => r.user_id);
    },
    async getById(id) {
      // Organizations: scope the by-id fetch to the active tenant (ambient orgContext)
      // so a raw id can never surface another org's conversation. Null-org = unscoped.
      const orgId = currentOrgId();
      const c = (
        await q(
          `SELECT * FROM conversations WHERE id=$1 AND deleted=0${orgId ? " AND organization_id=$2" : ""}`,
          orgId ? [id, orgId] : [id],
        )
      ).rows[0];
      if (!c) return null;
      const mem = (
        await q(
          "SELECT user_id FROM conversation_members WHERE conversation_id=$1 AND deleted=0",
          [id],
        )
      ).rows.map((x) => x.user_id);
      return {
        id: c.id,
        kind: c.kind,
        title: c.title,
        icon: c.icon,
        description: c.description || null,
        avatarUrl: c.avatar_url || null,
        members: mem,
        createdBy: c.created_by || null,
        temporary: !!c.temporary,
        pendingConnection: !!c.pending_connection,
        expiresAt: c.expires_at || null,
        retentionDays: c.retention_days != null ? Number(c.retention_days) : 7,
      };
    },
    async update(convId, patch) {
      const sets: string[] = [];
      const vals: any[] = [convId];
      let idx = 2;
      if (patch.title !== undefined) { sets.push(`title=$${idx++}`); vals.push(patch.title); }
      if (patch.icon !== undefined) { sets.push(`icon=$${idx++}`); vals.push(patch.icon); }
      if (patch.description !== undefined) { sets.push(`description=$${idx++}`); vals.push(patch.description); }
      if (patch.avatarUrl !== undefined) { sets.push(`avatar_url=$${idx++}`); vals.push(patch.avatarUrl); }
      if (sets.length) {
        const orgId = currentOrgId();
        const oc = orgId ? ` AND organization_id=$${idx}` : "";
        if (orgId) vals.push(orgId);
        await q(`UPDATE conversations SET ${sets.join(",")} WHERE id=$1${oc}`, vals);
      }
      return this.getById(convId);
    },
    async setKind(convId, kind) {
      const orgId = currentOrgId();
      await q(
        `UPDATE conversations SET kind=$2 WHERE id=$1${orgId ? " AND organization_id=$3" : ""}`,
        orgId ? [convId, kind, orgId] : [convId, kind],
      );
      return { id: convId, kind };
    },
    async listForUser(uid) {
      // Also select the viewer's role (cm.role) so the frontend can gate
      // group/channel admin UI without an extra /members round-trip.
      const orgId = currentOrgId();
      const rows = (
        await q(
          // Org-bound sessions ALSO see their NULL-org conversations. Those are
          // pre-org legacy threads and cross-boundary DMs (an invited external
          // contact has no org, so a DM they start is stamped NULL) — filtering
          // them out silently VANISHED those chats the moment a session became
          // org-bound. Membership (the cm JOIN) is the access gate; a NULL-org
          // row belongs to no other tenant, so including your own leaks nothing.
          `SELECT c.*, cm.starred, cm.muted, cm.hidden, cm.unread, cm.role, cm.history_visible_from FROM conversations c JOIN conversation_members cm ON cm.conversation_id=c.id AND cm.deleted=0 WHERE cm.user_id=$1 AND c.deleted=0${orgId ? " AND (c.organization_id=$2 OR c.organization_id IS NULL)" : ""}`,
          orgId ? [uid, orgId] : [uid],
        )
      ).rows;
      if (!rows.length) return [];
      // Batch the per-conversation lookups into 2 set-based queries instead of an
      // N+1 (was 1 + 2N). Verified row-for-row identical to the loop version
      // against the real DB (scripts/verify-listforuser.cjs).
      const ids = rows.map((c) => c.id);
      const memBy = new Map<string, string[]>();
      for (const m of (
        await q(
          "SELECT conversation_id, user_id FROM conversation_members WHERE conversation_id = ANY($1) AND deleted=0",
          [ids],
        )
      ).rows) {
        const list = memBy.get(m.conversation_id) || [];
        list.push(m.user_id);
        memBy.set(m.conversation_id, list);
      }
      // Latest message per conversation — resolved in TWO steps on purpose.
      // Step 1 finds the latest message ID per conversation carrying ONLY light
      // key columns (id + the partition/order keys) through the window sort.
      // Step 2 fetches the full rows for just those winning ids (no sort).
      //
      // Why not one `SELECT m.* ... ROW_NUMBER() OVER (...)`: selecting m.* forces
      // MySQL to buffer EVERY column through the PARTITION/ORDER BY sort — including
      // the large E2EE envelopes that video STREAMING introduced (embedded
      // first-frame poster + chunk manifest in ciphertext_json/file_json). One such
      // recent message overflowed sort_buffer_size ("Out of sort memory, consider
      // increasing server sort buffer size") and 500'd the ENTIRE sidebar for
      // everyone. Sorting just (conversation_id, created_at, id) keeps it tiny.
      const lastBy = new Map<string, any>();
      const lastIds = (
        await q(
          `SELECT t.id FROM (
             SELECT m.id, ROW_NUMBER() OVER (PARTITION BY m.conversation_id ORDER BY m.created_at DESC, m.id DESC) AS rn
             FROM messages m WHERE m.conversation_id = ANY($1) AND m.deleted=0
           ) t WHERE t.rn = 1`,
          [ids],
        )
      ).rows.map((r) => r.id);
      if (lastIds.length) {
        for (const m of (
          await q(`SELECT * FROM messages WHERE id = ANY($1)`, [lastIds])
        ).rows) {
          lastBy.set(m.conversation_id, m);
        }
      }
      return rows.map((c) => ({
        id: c.id,
        kind: c.kind,
        title: c.title,
        icon: c.icon,
        description: c.description || null,
        avatarUrl: c.avatar_url || null,
        members: memBy.get(c.id) || [],
        starred: c.starred,
        muted: c.muted,
        hidden: c.hidden,
        unread: c.unread,
        role: c.role || "member",
        createdBy: c.created_by || null,
        // Respect this member's per-user history cutoff (set by "Clear chat" or a
        // no-prior-history join): if the latest message predates it, the viewer has
        // no visible history, so the sidebar preview is empty too — the chat reads
        // as fresh, not "cleared but still previewing the old last line".
        lastMessage: (() => {
          try {
            const lm = lastBy.get(c.id);
            if (!lm) return null;
            const cut = c.history_visible_from;
            if (cut && new Date(lm.created_at) < new Date(cut)) return null;
            return mapMsg(lm);
          } catch (e) {
            // A single unreadable last message (e.g. a streaming-era envelope row)
            // must NOT fail the whole conversations query and 500 the sidebar —
            // degrade just this preview to null so the rest of the list still loads.
            console.error(
              `[mysql.listForUser] last message for conversation ${c.id} failed to map; serving without a preview`,
              e,
            );
            return null;
          }
        })(),
        temporary: !!c.temporary,
        pendingConnection: !!c.pending_connection,
        expiresAt: c.expires_at || null,
        retentionDays: c.retention_days != null ? Number(c.retention_days) : 7,
      }));
    },
    // Lightweight id-only variant of listForUser for the socket room-join on
    // connect: a single index-backed query with NO members fan-out and NO
    // last-message window-function scan (which listForUser runs and which the
    // join-all would otherwise pay on every connect/reconnect just to read ids).
    // Org-scoped via currentOrgId() to match the tenant the client renders.
    async listConversationIdsForUser(uid) {
      const orgId = currentOrgId();
      const rows = (
        await q(
          // Same NULL-org inclusion as listForUser — the socket must join the
          // rooms of every conversation the LIST shows, or those threads render
          // but never receive live messages.
          `SELECT cm.conversation_id AS id FROM conversation_members cm JOIN conversations c ON c.id=cm.conversation_id AND c.deleted=0 WHERE cm.user_id=$1 AND cm.deleted=0${orgId ? " AND (c.organization_id=$2 OR c.organization_id IS NULL)" : ""}`,
          orgId ? [uid, orgId] : [uid],
        )
      ).rows;
      return rows.map((r) => r.id);
    },
  };
  // Fetch full message rows for `orderedIds`, returned in that EXACT order. The
  // messages table carries large TEXT/JSON columns (E2EE ciphertext/file envelopes,
  // including the video-STREAMING first-frame poster + chunk manifest); selecting
  // them INSIDE a filesort overflows MySQL sort_buffer_size ("Out of sort memory")
  // and 500s the endpoint. So EVERY message-list query sorts on LIGHT key columns
  // to get an ordered id list, then hydrates the fat rows here — with NO sort.
  async function hydrateMessagesInOrder(orderedIds) {
    if (!orderedIds || !orderedIds.length) return [];
    const byId = new Map(
      (await q(`SELECT * FROM messages WHERE id = ANY($1)`, [orderedIds])).rows.map(
        (r) => [r.id, r],
      ),
    );
    return orderedIds
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map(mapMsg);
  }
  const messages = {
    async listForConversation(cid, { limit = 50, before = null, viewerId = null } = {}) {
      // P1.8: replies live INLINE in the conversation timeline (WhatsApp model),
      // not in a separate thread page/panel. Every message (reply or not) is
      // returned in chronological order.
      // #16: when `viewerId` is known, hide messages older than that member's
      // history cutoff (set if they were added without prior-history sharing).
      // COALESCE makes a NULL cutoff a no-op (created_at >= created_at), so this
      // is invisible to everyone with full history. Bare calls (no viewerId)
      // keep the original full-history behavior verbatim.
      // Keyset pagination (mirrors notifications.listForUser): with `before`
      // (a message id), fetch the page just-OLDER than that message, still
      // returned ASC so the client can prepend a chronological block.
      if (before) {
        // COMPOSITE keyset: tie-break on id in the WHERE (not just ORDER BY) so
        // messages sharing the cursor's timestamp can't be skipped or duplicated
        // at a page seam. Row comparison matches ORDER BY (created_at,id).
        const cut = viewerId
          ? ` AND m.created_at >= COALESCE((SELECT history_visible_from FROM conversation_members WHERE conversation_id=$1 AND user_id=$4), m.created_at)`
          : "";
        // Page of ids sorted on light key columns only (see hydrateMessagesInOrder).
        // The list comes back DESC (newest first); reverse to the ASC block the
        // client prepends.
        const pageIds = (
          await q(
            `SELECT m.id FROM messages m
               WHERE m.conversation_id=$1
                 AND (m.created_at, m.id) < ((SELECT created_at FROM messages WHERE id=$2), $2)${cut}
               ORDER BY m.created_at DESC, m.id DESC LIMIT $3`,
            viewerId ? [cid, before, limit, viewerId] : [cid, before, limit],
          )
        ).rows.map((r) => r.id);
        return hydrateMessagesInOrder(pageIds.reverse());
      }
      // Initial load (no cursor): return the NEWEST `limit` messages, re-ordered
      // ASC so the client gets a chronological block to render. Mirrors the
      // `before` keyset path above. Without the DESC/subquery the query returned
      // the OLDEST `limit` rows, so conversations with >50 messages never showed
      // recent content on first open.
      const cut = viewerId
        ? ` AND m.created_at >= COALESCE((SELECT history_visible_from FROM conversation_members WHERE conversation_id=$1 AND user_id=$3), m.created_at)`
        : "";
      const pageIds = (
        await q(
          `SELECT m.id FROM messages m
             WHERE m.conversation_id=$1${cut}
             ORDER BY m.created_at DESC, m.id DESC LIMIT $2`,
          viewerId ? [cid, limit, viewerId] : [cid, limit],
        )
      ).rows.map((r) => r.id);
      return hydrateMessagesInOrder(pageIds.reverse());
    },
    async thread(parentId) {
      const parent = await this.getById(parentId);
      if (!parent) return null;
      const replyIds = (
        await q(
          "SELECT id FROM messages WHERE parent_message_id=$1 ORDER BY created_at ASC, id ASC",
          [parentId],
        )
      ).rows.map((r) => r.id);
      const replies = await hydrateMessagesInOrder(replyIds);
      return { parent, replies };
    },
    async getById(mid) {
      // Organizations: scope the by-id fetch to the active tenant (ambient orgContext).
      const orgId = currentOrgId();
      const r = (
        await q(
          `SELECT * FROM messages WHERE id=$1${orgId ? " AND organization_id=$2" : ""}`,
          orgId ? [mid, orgId] : [mid],
        )
      ).rows[0];
      return r ? mapMsg(r) : null;
    },
    async create({
      conversationId,
      senderId,
      body = null,
      file = null,
      type = null,
      voice = null,
      encryptionVersion = 0,
      ciphertext = null,
      forwarded = false,
      forwardCount = 0,
      parentMessageId = null,
      important = false,
    }) {
      const id = genId();
      await q(
        // Organizations: denormalize the parent conversation's org onto the message
        // (what messages.search filters on). Derived from the conversation, not the
        // session, so it's always consistent with the conversation's tenant.
        `INSERT INTO messages (id,conversation_id,sender_id,body,file_json,type,voice_json,encryption_version,ciphertext_json,forwarded,forward_count,parent_message_id,important,organization_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,(SELECT organization_id FROM conversations WHERE id=$2))`,
        [
          id,
          conversationId,
          senderId,
          body,
          file ? JSON.stringify(file) : null,
          // messages.type is NOT NULL DEFAULT 'text'; an explicit NULL defeats the
          // default and fails (1048). Default text messages to 'text' here.
          type || "text",
          voice ? JSON.stringify(voice) : null,
          encryptionVersion,
          ciphertext ? JSON.stringify(ciphertext) : null,
          forwarded,
          Number(forwardCount) || 0,
          parentMessageId,
          important ? true : false,
        ],
      );
      const r = (await q("SELECT * FROM messages WHERE id=$1", [id])).rows[0];
      // Don't depend on read-after-write visibility on a slow / read-write-split
      // shared DB: if the just-inserted row isn't readable yet, return what we
      // wrote so a successful send never surfaces as a crash or silent failure.
      return r
        ? mapMsg(r)
        : {
            id,
            conversationId,
            senderId,
            body: body || null,
            file: file || null,
            type: type || "text",
            voice: voice || null,
            encryptionVersion: Number(encryptionVersion) || 0,
            ciphertext: ciphertext || null,
            forwarded: !!forwarded,
            forwardCount: Number(forwardCount) || 0,
            edited: false,
            reactions: [],
            createdAt: new Date().toISOString(),
            parentMessageId: parentMessageId || null,
            replyCount: 0,
            lastReplyAt: null,
            important: !!important,
          };
    },
    async toggleReaction(mid, userId, emoji) {
      // The reaction list is a read-modify-write on reactions_json. Two people
      // reacting to the SAME message concurrently would each read, edit their own
      // copy, and the last UPDATE would clobber the other (lost reaction). Do it
      // inside a transaction with SELECT ... FOR UPDATE so concurrent toggles
      // SERIALIZE on the row instead of racing.
      const conn = await pool.getConnection();
      const cq = async (t: string, p: any[] = []) => {
        const bound = bind(translate(t), p || []);
        const [res]: any = await conn.query(
          bound.text,
          bound.params.map(normParam),
        );
        if (Array.isArray(res)) return { rows: res, rowCount: res.length };
        return { rows: [], rowCount: (res && res.affectedRows) || 0 };
      };
      let arr: any[] = [];
      let hadSame = false;
      try {
        await conn.beginTransaction();
        const sel = await cq(
          "SELECT reactions_json FROM messages WHERE id=$1 FOR UPDATE",
          [mid],
        );
        if (!sel.rows.length) {
          await conn.rollback();
          return null;
        }
        arr = sel.rows[0].reactions_json || [];
        if (typeof arr === "string") {
          try {
            arr = JSON.parse(arr);
          } catch {
            arr = [];
          }
        }
        if (!Array.isArray(arr)) arr = [];
        // One reaction per user. Remove their existing one (whatever emoji), then
        // add the new emoji unless they tapped the SAME one (toggle off).
        const mineAt = arr.findIndex((r: any) => r.userId === userId);
        hadSame = mineAt >= 0 && arr[mineAt].emoji === emoji;
        if (mineAt >= 0) arr.splice(mineAt, 1);
        if (!hadSame) arr.push({ userId, emoji });
        await cq("UPDATE messages SET reactions_json=$2 WHERE id=$1", [
          mid,
          JSON.stringify(arr),
        ]);
        await conn.commit();
      } catch (e) {
        try {
          await conn.rollback();
        } catch (_) {}
        throw e;
      } finally {
        conn.release();
      }
      const m = await this.getById(mid);
      if (!m) return null;
      m.reactions = arr;
      // AUDIT P2: signal ADD vs toggle-OFF so callers only notify the message owner
      // on an add (un-reacting previously fired a false "reacted to your message").
      (m as any)._reactionAdded = !hadSame;
      return m;
    },
    async update(mid, patch) {
      // E2EE edits replace the encrypted envelope set + bump encryption_version;
      // plaintext edits set body. body is always cleared to NULL on an encrypted
      // edit so the server never holds plaintext for an E2EE row.
      const encrypted = patch.ciphertext != null;
      await q(
        `UPDATE messages SET
            body              = CASE WHEN $4 THEN NULL ELSE COALESCE($2, body) END,
            edited            = COALESCE($3, edited),
            ciphertext_json   = CASE WHEN $4 THEN $5 ELSE ciphertext_json END,
            encryption_version= CASE WHEN $4 THEN $6 ELSE encryption_version END
         WHERE id=$1`,
        [
          mid,
          patch.body ?? null,
          patch.edited ?? null,
          encrypted ? 1 : 0,
          encrypted ? JSON.stringify(patch.ciphertext) : null,
          encrypted ? Number(patch.encryptionVersion) || 1 : 0,
        ],
      );
      return this.getById(mid);
    },
    async remove(mid) {
      // Soft delete ("delete for everyone"): keep the row, clear the content so
      // the client can render a "This message was deleted" tombstone in place.
      await q(
        "UPDATE messages SET deleted=true, body=null, file_json=null, voice_json=null, reactions_json=null, type='text' WHERE id=$1",
        [mid],
      );
      return this.getById(mid);
    },
    async search(uid, qry, orgId) {
      // Index-backed FTS with a prefix on the trailing term (search-as-you-type).
      const terms = String(qry || "")
        .toLowerCase()
        .match(/[a-z0-9]+/g);
      if (!terms || !terms.length) return [];
      const bool = terms
        .map((w, i) => (i === terms.length - 1 ? "+" + w + "*" : "+" + w))
        .join(" ");
      // Organizations: scope the FULLTEXT search to the active tenant so a query can
      // NEVER match another org's messages (the confirmed cross-org search leak). Only
      // when an orgId is present (org-aware session); a legacy/NULL session keeps the
      // prior behavior. messages.organization_id (denormalized in 0068) makes this a
      // plain predicate — no join through conversations, preserving MATCH relevance.
      const orgClause = orgId ? " AND m.organization_id = $3" : "";
      const hitIds = (
        await q(
          `SELECT m.id FROM messages m
             JOIN conversation_members cm ON cm.conversation_id=m.conversation_id AND cm.deleted=0
            WHERE cm.user_id=$1
              AND m.deleted=0
              AND MATCH(m.body) AGAINST($2 IN BOOLEAN MODE)${orgClause}
            ORDER BY MATCH(m.body) AGAINST($2 IN BOOLEAN MODE) DESC,
                     m.created_at DESC
            LIMIT 30`,
          orgId ? [uid, bool, orgId] : [uid, bool],
        )
      ).rows.map((r) => r.id);
      // Preserve the relevance order returned above (do NOT reverse).
      return hydrateMessagesInOrder(hitIds);
    },
    async addDeletion(userId, messageId) {
      await q(
        "INSERT IGNORE INTO message_deletions (user_id,message_id) VALUES ($1,$2)",
        [userId, messageId],
      );
    },
    async getDeletionIds(userId) {
      return (
        await q(
          "SELECT message_id FROM message_deletions WHERE user_id=$1",
          [userId],
        )
      ).rows.map((r) => r.message_id);
    },
    async pin(mid, userId) {
      await q("UPDATE messages SET pinned=true, pinned_by=$2, pinned_at=NOW() WHERE id=$1", [mid, userId]);
      return this.getById(mid);
    },
    async unpin(mid) {
      await q("UPDATE messages SET pinned=false, pinned_by=NULL, pinned_at=NULL WHERE id=$1", [mid]);
      return this.getById(mid);
    },
    async setImportant(mid, important) {
      await q("UPDATE messages SET important=$2 WHERE id=$1", [mid, important ? true : false]);
      return this.getById(mid);
    },
    async listPinned(conversationId) {
      const pinnedIds = (await q("SELECT id FROM messages WHERE conversation_id=$1 AND pinned=true ORDER BY pinned_at DESC, id DESC", [conversationId])).rows.map((r) => r.id);
      return hydrateMessagesInOrder(pinnedIds);
    },
  };
  const bookmarks = {
    async toggle(userId, messageId) {
      const ex = (
        await q("SELECT 1 FROM bookmarks WHERE user_id=$1 AND message_id=$2 AND deleted=0", [
          userId,
          messageId,
        ])
      ).rows[0];
      if (ex) {
        await q("UPDATE bookmarks SET deleted=1, deleted_at=now(3), deleted_by=$1 WHERE user_id=$1 AND message_id=$2", [
          userId,
          messageId,
        ]);
        return false;
      }
      // Revive a previously-removed bookmark instead of failing on the PK.
      await q("INSERT INTO bookmarks (user_id,message_id) VALUES ($1,$2) AS new ON DUPLICATE KEY UPDATE deleted=0, deleted_at=NULL", [
        userId,
        messageId,
      ]);
      return true;
    },
    async list(userId) {
      return (
        await q("SELECT message_id FROM bookmarks WHERE user_id=$1 AND deleted=0", [userId])
      ).rows.map((r) => r.message_id);
    },
  };
  const meetings = {
    async create(mt) {
      const id = mt.id || genId();
      const orgId = currentOrgId();
      await q(
        `INSERT INTO meetings (id,title,starts_at,duration_min,created_by,conversation_id,recurrence,recurrence_rule,reminder_lead_min,organization_id,timezone,description,location) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) AS new ON DUPLICATE KEY UPDATE title=new.title, starts_at=new.starts_at, duration_min=new.duration_min, recurrence=new.recurrence, recurrence_rule=new.recurrence_rule, reminder_lead_min=new.reminder_lead_min, timezone=new.timezone, description=new.description, location=new.location`,
        [
          id,
          mt.title,
          mt.startsAt,
          mt.durationMin || 30,
          mt.createdBy || null,
          mt.conversationId || null,
          mt.recurrence || "none",
          mt.recurrenceRule == null ? null : typeof mt.recurrenceRule === "string" ? mt.recurrenceRule : JSON.stringify(mt.recurrenceRule),
          mt.reminderLeadMin == null ? null : Number(mt.reminderLeadMin),
          orgId,
          mt.timezone || null,
          // Agenda / where (0118). Empty string is stored as NULL so "no agenda"
          // has exactly one representation.
          mt.description && String(mt.description).trim() ? String(mt.description) : null,
          mt.location && String(mt.location).trim() ? String(mt.location) : null,
        ],
      );
      const r = (
        await q(
          `SELECT * FROM meetings WHERE id=$1${orgId ? " AND organization_id=$2" : ""}`,
          orgId ? [id, orgId] : [id],
        )
      ).rows[0];
      for (const u of mt.attendees || [])
        await q(
          // invited_by_host=1: this row came from the HOST's invite list, which
          // is what the "invited" lobby policy keys on (0117).
          "INSERT INTO meeting_attendees (meeting_id,user_id,invited_by_host) VALUES ($1,$2,1) AS new ON DUPLICATE KEY UPDATE deleted=0, deleted_at=NULL, invited_by_host=1",
          [id, u],
        );
      return mapMtg(r);
    },
    async listForUser(uid) {
      const of = orgFilter([uid], "m.organization_id");
      const rows = (
        await q(
          `SELECT DISTINCT m.* FROM meetings m LEFT JOIN meeting_attendees a ON a.meeting_id=m.id AND a.deleted=0 WHERE (m.created_by=$1 OR a.user_id=$1) AND m.deleted=0${of.clause} ORDER BY m.starts_at`,
          of.params,
        )
      ).rows;
      const out = [];
      for (const m of rows) {
        const att = (
          await q(
            "SELECT user_id,status,role,optional FROM meeting_attendees WHERE meeting_id=$1 AND deleted=0",
            [m.id],
          )
        ).rows.map((x) => ({ userId: x.user_id, status: x.status, role: x.role || "participant", optional: !!x.optional }));
        out.push({ ...mapMtg(m), attendees: att });
      }
      return out;
    },
    async search(uid, qry, orgId) {
      const orgClause = orgId ? " AND m.organization_id = $3" : "";
      // Hybrid relevance (0072): ILIKE recall floor + word-level FULLTEXT on the
      // title, best matches first (then the original schedule ordering). The
      // relevance score rides in the SELECT list because DISTINCT + ORDER BY on
      // a non-selected expression is rejected under ONLY_FULL_GROUP_BY.
      const bool = ftsBool(qry);
      const bp = orgId ? "$4" : "$3";
      const rows = (
        await q(
          bool
            ? `SELECT DISTINCT m.*, MATCH(m.title) AGAINST(${bp} IN BOOLEAN MODE) AS _rel
                 FROM meetings m LEFT JOIN meeting_attendees a ON a.meeting_id=m.id AND a.deleted=0
               WHERE (m.created_by=$1 OR a.user_id=$1) AND m.deleted=0${orgClause}
                 AND (m.title ILIKE $2 OR MATCH(m.title) AGAINST(${bp} IN BOOLEAN MODE))
               ORDER BY _rel DESC, m.starts_at LIMIT 20`
            : `SELECT DISTINCT m.* FROM meetings m LEFT JOIN meeting_attendees a ON a.meeting_id=m.id AND a.deleted=0
               WHERE (m.created_by=$1 OR a.user_id=$1) AND m.title ILIKE $2 AND m.deleted=0${orgClause}
               ORDER BY m.starts_at LIMIT 20`,
          bool
            ? orgId
              ? [uid, "%" + qry + "%", orgId, bool]
              : [uid, "%" + qry + "%", bool]
            : orgId
              ? [uid, "%" + qry + "%", orgId]
              : [uid, "%" + qry + "%"],
        )
      ).rows;
      const out = [];
      for (const m of rows) {
        const att = (
          await q(
            "SELECT user_id,status,role,optional FROM meeting_attendees WHERE meeting_id=$1 AND deleted=0",
            [m.id],
          )
        ).rows.map((x) => ({ userId: x.user_id, status: x.status, role: x.role || "participant", optional: !!x.optional }));
        out.push({ ...mapMtg(m), attendees: att });
      }
      return out;
    },
    async getById(mid) {
      const orgId = currentOrgId();
      const m = (
        await q(
          `SELECT * FROM meetings WHERE id=$1 AND deleted=0${orgId ? " AND organization_id=$2" : ""}`,
          orgId ? [mid, orgId] : [mid],
        )
      ).rows[0];
      if (!m) return null;
      const att = (
        await q(
          "SELECT user_id,status,role,optional FROM meeting_attendees WHERE meeting_id=$1 AND deleted=0",
          [mid],
        )
      ).rows.map((x) => ({ userId: x.user_id, status: x.status, role: x.role || "participant", optional: !!x.optional }));
      return { ...mapMtg(m), attendees: att };
    },
    async setAttendeeStatus(mid, uid, status) {
      await q(
        // This one method serves BOTH paths, so it derives the flag from the
        // status it is given: only a HOST invite writes 'invited' (POST
        // /:id/invite); a self-joiner is always inserted 'accepted' and an RSVP
        // writes accepted/declined/tentative. GREATEST makes the flag monotonic
        // — once someone is host-invited, later joins or RSVPs can never clear
        // it, which is what stops the "invited" lobby policy drifting (0117).
        `INSERT INTO meeting_attendees (meeting_id,user_id,status,invited_by_host)
         VALUES ($1,$2,$3,$4) AS new
         ON DUPLICATE KEY UPDATE status=new.status, deleted=0, deleted_at=NULL,
           invited_by_host = GREATEST(meeting_attendees.invited_by_host, new.invited_by_host)`,
        [mid, uid, status, status === "invited" ? 1 : 0],
      );
    },
    async update(mid, patch) {
      const { attendees, ...rest } = patch || {};
      const u = orgFilter([
        mid,
        rest.title ?? null,
        rest.startsAt ?? null,
        rest.durationMin ?? null,
        rest.recurrence ?? null,
        rest.recurrenceRule == null ? null : typeof rest.recurrenceRule === "string" ? rest.recurrenceRule : JSON.stringify(rest.recurrenceRule),
        rest.reminderLeadMin == null ? null : Number(rest.reminderLeadMin),
        rest.timezone ?? null,
        rest.exdates == null ? null : JSON.stringify(rest.exdates),
        rest.occurrenceOverrides == null ? null : JSON.stringify(rest.occurrenceOverrides),
        rest.icsSequence == null ? null : Number(rest.icsSequence),
      ]);
      await q(
        `UPDATE meetings SET title=COALESCE($2,title), starts_at=COALESCE($3,starts_at), duration_min=COALESCE($4,duration_min), recurrence=COALESCE($5,recurrence), recurrence_rule=COALESCE($6,recurrence_rule), reminder_lead_min=COALESCE($7,reminder_lead_min), timezone=COALESCE($8,timezone), exdates=COALESCE($9,exdates), occurrence_overrides=COALESCE($10,occurrence_overrides), ics_sequence=COALESCE($11,ics_sequence) WHERE id=$1${u.clause}`,
        u.params,
      );
      // Agenda / location (0118) are handled OUTSIDE the COALESCE block above:
      // COALESCE treats null as "leave unchanged", which would make clearing an
      // agenda impossible. Here an ABSENT key leaves the column alone and an
      // empty string genuinely empties it — which is what a host deleting their
      // agenda text expects.
      for (const [key, col] of [["description", "description"], ["location", "location"]] as const) {
        if (!(key in rest)) continue;
        const val = rest[key] == null || String(rest[key]).trim() === "" ? null : String(rest[key]);
        const uu = orgFilter([mid, val]);
        await q(`UPDATE meetings SET ${col}=$2 WHERE id=$1${uu.clause}`, uu.params);
      }
      const s = orgFilter([mid]);
      const r = (await q(`SELECT * FROM meetings WHERE id=$1${s.clause}`, s.params)).rows[0];
      if (!r) return null;
      if (Array.isArray(attendees)) {
        const existing = (
          await q(
            "SELECT user_id,status,role,optional FROM meeting_attendees WHERE meeting_id=$1 AND deleted=0",
            [mid],
          )
        ).rows;
        const exMap = Object.fromEntries(
          existing.map((e) => [e.user_id, e.status]),
        );
        // Soft-replace the attendee set: mark all current attendees deleted, then
        // revive/insert the kept ones (deleted=0), preserving their prior status.
        await q("UPDATE meeting_attendees SET deleted=1, deleted_at=now(3) WHERE meeting_id=$1", [mid]);
        for (const u of attendees)
          await q(
            "INSERT INTO meeting_attendees (meeting_id,user_id,status,invited_by_host) VALUES ($1,$2,$3,1) AS new ON DUPLICATE KEY UPDATE deleted=0, deleted_at=NULL, status=new.status, invited_by_host=1",
            [mid, u, exMap[u] || "invited"],
          );
      }
      const att = (
        await q(
          "SELECT user_id,status,role,optional FROM meeting_attendees WHERE meeting_id=$1 AND deleted=0",
          [mid],
        )
      ).rows.map((x) => ({ userId: x.user_id, status: x.status, role: x.role || "participant", optional: !!x.optional }));
      return { ...mapMtg(r), attendees: att };
    },
    async remove(mid, actorId) {
      // Soft-delete + explicit child soft-cascade (FK CASCADE no longer fires).
      const by = actorId || null;
      const u = orgFilter([mid, by]);
      await q(`UPDATE meetings SET deleted=1, deleted_at=now(3), deleted_by=$2 WHERE id=$1${u.clause}`, u.params);
      await q("UPDATE meeting_attendees SET deleted=1, deleted_at=now(3) WHERE meeting_id=$1 AND deleted=0", [mid]);
      await q("UPDATE meeting_presence SET deleted=1, deleted_at=now(3) WHERE meeting_id=$1 AND deleted=0", [mid]);
      await q("UPDATE meeting_recordings SET deleted=1, deleted_at=now(3) WHERE meeting_id=$1 AND deleted=0", [mid]);
      await q("UPDATE meeting_messages SET deleted=1, deleted_at=now(3) WHERE meeting_id=$1 AND deleted=0", [mid]);
      await q("UPDATE meeting_ejected SET deleted=1, deleted_at=now(3) WHERE meeting_id=$1 AND deleted=0", [mid]);
      return { id: mid, deleted: true };
    },
    async removeAttendee(mid, uid) {
      await q(
        "UPDATE meeting_attendees SET deleted=1, deleted_at=now(3) WHERE meeting_id=$1 AND user_id=$2",
        [mid, uid],
      );
      const s = orgFilter([mid]);
      const m = (await q(`SELECT * FROM meetings WHERE id=$1 AND deleted=0${s.clause}`, s.params)).rows[0];
      return m ? mapMtg(m) : null;
    },
    // --- live room presence (who is in the room right now) ---
    async enterRoom(mid, uid) {
      await q(
        `INSERT INTO meeting_presence (meeting_id,user_id) VALUES ($1,$2)
         ON DUPLICATE KEY UPDATE last_seen=now(), deleted=0, deleted_at=NULL`,
        [mid, uid],
      );
      // ATTENDANCE LOG (0119). One row per join. Guarded so a reconnect that
      // re-enters an ALREADY-OPEN session does not start a second one — a flaky
      // network would otherwise read as a dozen separate attendances.
      const open = (
        await q(
          "SELECT id FROM meeting_attendance WHERE meeting_id=$1 AND user_id=$2 AND left_at IS NULL LIMIT 1",
          [mid, uid],
        )
      ).rows[0];
      if (!open)
        await q(
          "INSERT INTO meeting_attendance (id, meeting_id, user_id) VALUES ($1,$2,$3)",
          [genId(), mid, uid],
        );
    },
    async heartbeatRoom(mid, uid) {
      await q(
        "UPDATE meeting_presence SET last_seen=now() WHERE meeting_id=$1 AND user_id=$2",
        [mid, uid],
      );
    },
    async leaveRoom(mid, uid) {
      await q(
        "UPDATE meeting_presence SET deleted=1, deleted_at=now(3) WHERE meeting_id=$1 AND user_id=$2",
        [mid, uid],
      );
      // Close the open attendance session (0119). No-op if none is open.
      await q(
        "UPDATE meeting_attendance SET left_at=now(3) WHERE meeting_id=$1 AND user_id=$2 AND left_at IS NULL",
        [mid, uid],
      );
    },
    // The report. One row per person with their real first join, last leave,
    // number of separate sessions, and total seconds actually attended —
    // computed in SQL so a long meeting never ships thousands of rows to Node.
    // A session still open (left_at NULL) counts up to now, so the report is
    // meaningful DURING the meeting, not only after it.
    // `since` (optional) limits the report to sessions that started at/after it —
    // a recurring series logs every occurrence under ONE meeting id, and a report
    // must describe the occurrence that just ran, not the whole series' history.
    async attendanceReport(mid, since = null) {
      return (
        await q(
          `SELECT a.user_id,
                  MIN(a.joined_at)                                   AS first_joined,
                  MAX(COALESCE(a.left_at, now(3)))                   AS last_left,
                  COUNT(*)                                           AS sessions,
                  SUM(TIMESTAMPDIFF(SECOND, a.joined_at, COALESCE(a.left_at, now(3)))) AS seconds,
                  MAX(a.left_at IS NULL)                             AS still_present
             FROM meeting_attendance a
            WHERE a.meeting_id=$1 AND ($2 IS NULL OR a.joined_at >= $2)
            GROUP BY a.user_id
            ORDER BY first_joined`,
          [mid, since ? new Date(since) : null],
        )
      ).rows.map((r: any) => ({
        userId: r.user_id,
        firstJoined: r.first_joined,
        lastLeft: r.last_left,
        sessions: Number(r.sessions || 0),
        seconds: Math.max(0, Number(r.seconds || 0)),
        stillPresent: !!Number(r.still_present),
      }));
    },
    // Clear ALL presence for a meeting (used by complete()/"End for everyone").
    // Without this, roomParticipants keeps returning rows for ~90s after the host
    // ends the meeting, so computeState reports "active" (present>=1 overrides
    // status=completed) and a hard-ended meeting stays rejoinable during teardown.
    async clearRoom(mid) {
      await q(
        "UPDATE meeting_presence SET deleted=1, deleted_at=now(3) WHERE meeting_id=$1 AND deleted=0",
        [mid],
      );
      // The meeting is over for everyone: close every OPEN attendance session at
      // this instant. attendanceReport measures an open session up to now(), so
      // without this a finished meeting's durations (and its "last leave") kept
      // growing every time the report was opened.
      try {
        await q(
          "UPDATE meeting_attendance SET left_at=now(3) WHERE meeting_id=$1 AND left_at IS NULL",
          [mid],
        );
      } catch (_) { /* pre-0119 database — no attendance log */ }
    },
    // REC-15: full attendance for a meeting — every join row, INCLUDING rows
    // soft-deleted by leave/teardown (deleted_at doubles as the leave time).
    async attendance(mid) {
      const rows = (
        await q(
          `SELECT user_id, joined_at, last_seen, deleted_at FROM meeting_presence
           WHERE meeting_id=$1 ORDER BY joined_at`,
          [mid],
        )
      ).rows;
      return rows.map((r: any) => ({
        userId: r.user_id,
        joinedAt: r.joined_at,
        leftAt: r.deleted_at || r.last_seen,
      }));
    },
    async roomParticipants(mid) {
      const rows = (
        await q(
          `SELECT user_id, joined_at FROM meeting_presence
           WHERE meeting_id=$1 AND deleted=0 AND last_seen > now() - INTERVAL 90 SECOND
           ORDER BY joined_at`,
          [mid],
        )
      ).rows;
      return rows.map((r) => ({ userId: r.user_id, joinedAt: r.joined_at }));
    },
    async presenceCounts(meetingIds: string[]) {
      if (!meetingIds.length) return {};
      const ph = meetingIds.map((_, i) => `$${i + 1}`).join(",");
      const rows = (
        await q(
          `SELECT meeting_id, COUNT(*) AS cnt FROM meeting_presence
           WHERE meeting_id IN (${ph}) AND deleted=0 AND last_seen > now() - INTERVAL 90 SECOND
           GROUP BY meeting_id`,
          meetingIds,
        )
      ).rows;
      const map: Record<string, number> = {};
      for (const r of rows) map[r.meeting_id] = Number(r.cnt);
      return map;
    },
    // MEETING-REMINDER SCHEDULER (#53): candidate meetings whose reminder might be
    // due. Returns every live, not-cancelled meeting that has a reminder_lead_min
    // set AND whose series could still produce an occurrence at/after a recent past
    // bound (so a still-running or just-finished window is covered) — the SERVICE
    // does the precise recurrence expansion + lead math + the per-occurrence
    // exactly-once claim. We pre-filter cheaply in SQL (lead set, not cancelled,
    // not deleted, starts within a horizon OR recurring) so the scan stays light.
    // Includes each meeting's attendees so the service can fan the notification out
    // without an N+1 per meeting.
    async withReminderLead(horizonDaysAhead = 366) {
      const rows = (
        await q(
          `SELECT * FROM meetings
             WHERE deleted=0
               AND status <> 'cancelled'
               AND hard_ended = 0
               AND reminder_lead_min IS NOT NULL AND reminder_lead_min > 0
               AND (
                 recurrence <> 'none'
                 OR (starts_at >= now() - INTERVAL 1 DAY
                     AND starts_at <= now() + INTERVAL ${Math.max(1, Number(horizonDaysAhead) || 366)} DAY)
               )`,
          [],
        )
      ).rows;
      if (!rows.length) return [];
      const mIds = rows.map((m) => m.id);
      const ph = mIds.map((_, i) => `$${i + 1}`).join(",");
      const allAtts = (
        await q(
          `SELECT meeting_id, user_id, status FROM meeting_attendees WHERE meeting_id IN (${ph}) AND deleted=0`,
          mIds,
        )
      ).rows;
      const attMap = new Map<string, any[]>();
      for (const a of allAtts) {
        if (!attMap.has(a.meeting_id)) attMap.set(a.meeting_id, []);
        attMap.get(a.meeting_id)!.push({ userId: a.user_id, status: a.status });
      }
      return rows.map((m) => ({
        ...mapMtg(m),
        attendees: attMap.get(m.id) || [],
      }));
    },
    // Atomic per-occurrence claim for the meeting-reminder scan: the FIRST tick to
    // insert (meeting_id, occurrence_start) wins and returns true; a duplicate /
    // concurrent tick's insert is swallowed by the PK and returns false. This is the
    // meeting twin of reminders.notified_at — it guarantees a meeting reminder fires
    // EXACTLY ONCE per occurrence, across recurrence expansion and worker restarts.
    // MEETINGS ENDING SOON. Driven off LIVE PRESENCE rather than the calendar:
    // the warning only means anything to people actually in the room, and
    // scanning presence keeps this to the handful of meetings running right now
    // instead of every meeting in the horizon.
    async liveMeetings() {
      const rows = (
        await q(
          `SELECT DISTINCT m.*
             FROM meetings m
             JOIN meeting_presence p ON p.meeting_id = m.id
            WHERE p.deleted = 0
              AND p.last_seen > now() - INTERVAL 90 SECOND
              AND m.deleted = 0
              AND m.status <> 'cancelled'
              AND m.hard_ended = 0`,
        )
      ).rows;
      return rows.map(mapMtg);
    },
    // Exactly-once per (meeting, occurrence, lead). The first inserter wins; a
    // concurrent or repeated tick gets false and skips the fan-out.
    async claimEndWarning(mid: string, occurrenceStart: string, minutesBefore: number) {
      const r = await q(
        `INSERT IGNORE INTO meeting_end_warnings_sent (meeting_id, occurrence_start, minutes_before)
         VALUES ($1,$2,$3)`,
        [mid, occurrenceStart, minutesBefore],
      );
      return (r.rowCount || 0) > 0;
    },
    async claimReminderOccurrence(meetingId, occurrenceStartIso) {
      const r = await q(
        `INSERT IGNORE INTO meeting_reminders_sent (meeting_id, occurrence_start)
           VALUES ($1, $2)`,
        [meetingId, occurrenceStartIso],
      );
      // INSERT IGNORE: affectedRows=1 for a fresh insert, 0 when the PK already
      // exists (the duplicate is SKIPPED, not matched-updated). The previous
      // `ON DUPLICATE KEY UPDATE meeting_id=meeting_id` reported the MATCHED row
      // (affectedRows=1) for a duplicate under mysql2's default CLIENT_FOUND_ROWS
      // flag, so the claim ALWAYS returned true — the exactly-once ledger never
      // deduped and every scheduler tick re-fired the reminder (the ~10x spam).
      return (r.rowCount || 0) > 0;
    },
    async setStatus(mid, status) {
      const u = orgFilter([mid, status]);
      await q(`UPDATE meetings SET status=$2 WHERE id=$1${u.clause}`, u.params);
      const s = orgFilter([mid]);
      const r = (await q(`SELECT * FROM meetings WHERE id=$1${s.clause}`, s.params)).rows[0];
      return r ? mapMtg(r) : null;
    },
    // AUDIT #9: mark a meeting hard-ended ("End for everyone") so nobody rejoins the
    // session, distinct from a reusable natural completion.
    async setHardEnded(mid) {
      const u = orgFilter([mid]);
      await q(`UPDATE meetings SET hard_ended=1, status='completed' WHERE id=$1${u.clause}`, u.params);
      const r = (await q(`SELECT * FROM meetings WHERE id=$1${u.clause}`, u.params)).rows[0];
      return r ? mapMtg(r) : null;
    },
    // For a RECURRING series, "End for everyone" closes this occurrence only —
    // clear hard_ended so future occurrences remain joinable and reminders re-fire.
    async clearHardEndedAndComplete(mid) {
      const u = orgFilter([mid]);
      await q(`UPDATE meetings SET hard_ended=0, status='completed' WHERE id=$1${u.clause}`, u.params);
      const r = (await q(`SELECT * FROM meetings WHERE id=$1${u.clause}`, u.params)).rows[0];
      return r ? mapMtg(r) : null;
    },
    // Resolve a meeting from its public-link token. Deliberately NOT org-scoped:
    // the caller is an anonymous guest with no tenant context yet — the row's own
    // organization_id is what establishes the tenant for the guest session.
    async getByPublicToken(token) {
      const t = String(token || "");
      if (!t || t.length > 64) return null;
      // Intentionally tenant-UNscoped (the token itself is the credential, and the
      // row's organization_id seeds the guest's tenant). Naming the column in the
      // select list keeps the COLAB_ORG_GUARD tripwire's detector satisfied.
      const r = (
        await q(
          "SELECT meetings.*, organization_id AS tenant_id FROM meetings WHERE public_link_token=$1 AND deleted=0 LIMIT 1",
          [t],
        )
      ).rows[0];
      return r ? mapMtg(r) : null;
    },
    // Set (or, with null, revoke) the public-link token. Org-scoped like every
    // other write so a host can only touch their own tenant's meeting.
    async setPublicLinkToken(mid, token) {
      const u = orgFilter([mid, token || null]);
      await q(`UPDATE meetings SET public_link_token=$2 WHERE id=$1${u.clause}`, u.params);
      const f = orgFilter([mid]);
      const r = (await q(`SELECT * FROM meetings WHERE id=$1${f.clause}`, f.params)).rows[0];
      return r ? mapMtg(r) : null;
    },
    // ── Guest device binding (0135) ───────────────────────────────────────
    // (meeting, browser-profile device id) → the guest user minted on the first
    // join, so re-joins from the same browser reuse ONE identity. Tenant-unscoped
    // like getByPublicToken: the caller is an anonymous guest with no org yet,
    // and the table has no organization_id (the meeting row carries it).
    async getGuestDevice(meetingId, deviceId) {
      const r = (
        await q(
          `SELECT d.meeting_id, d.device_id, d.user_id, d.join_count, d.created_at, d.last_seen_at,
                  COALESCE(u.deleted, 1) AS user_deleted
             FROM meeting_guest_devices d
             LEFT JOIN users u ON u.id = d.user_id
            WHERE d.meeting_id=$1 AND d.device_id=$2 LIMIT 1`,
          [String(meetingId), String(deviceId)],
        )
      ).rows[0];
      return r ? mapGuestDevice(r) : null;
    },
    // A stale binding (its guest row was deleted) is pointed at the new guest.
    async rebindGuestDevice({ meetingId, deviceId, userId }) {
      await q(
        "UPDATE meeting_guest_devices SET user_id=$3, join_count=1, created_at=CURRENT_TIMESTAMP(3), last_seen_at=CURRENT_TIMESTAMP(3) WHERE meeting_id=$1 AND device_id=$2",
        [String(meetingId), String(deviceId), String(userId)],
      );
      return this.getGuestDevice(meetingId, deviceId);
    },
    // First-writer-wins: a concurrent join from two tabs of the same browser
    // races on the primary key; the loser's INSERT turns into a counter bump and
    // the row's user_id (the winner's) is what the caller must adopt.
    async bindGuestDevice({ meetingId, deviceId, userId }) {
      await q(
        "INSERT INTO meeting_guest_devices (meeting_id, device_id, user_id) VALUES ($1,$2,$3) ON DUPLICATE KEY UPDATE join_count=join_count+1, last_seen_at=CURRENT_TIMESTAMP(3)",
        [String(meetingId), String(deviceId), String(userId)],
      );
      return this.getGuestDevice(meetingId, deviceId);
    },
    async setLobbyEnabled(mid, enabled) {
      // Writes BOTH representations: on -> 'nobody' (everyone waits, the old
      // meaning of the boolean), off -> 'everyone'. A host using the simple
      // toggle and a host using the options panel can never leave the meeting
      // in a state where the two disagree.
      const u = orgFilter([mid, enabled ? 1 : 0, enabled ? "nobody" : "everyone"]);
      await q(
        `UPDATE meetings SET lobby_enabled=$2, lobby_policy=$3 WHERE id=$1${u.clause}`,
        u.params,
      );
    },
    // Per-meeting options (0116). Writes only the keys supplied, and keeps the
    // legacy lobby_enabled boolean in step with lobby_policy in the SAME
    // statement — so the mirror can never drift from the policy, even if two
    // hosts change options concurrently.
    async setOptions(mid, patch: any = {}) {
      const sets: string[] = [];
      const vals: any[] = [];
      const push = (col: string, v: any) => { vals.push(v); sets.push(`${col}=$${vals.length + 1}`); };
      if (patch.lobbyPolicy !== undefined) {
        push("lobby_policy", String(patch.lobbyPolicy));
        push("lobby_enabled", patch.lobbyPolicy === "everyone" ? 0 : 1);
      }
      if (patch.allowMic !== undefined) push("allow_mic", patch.allowMic ? 1 : 0);
      if (patch.allowCamera !== undefined) push("allow_camera", patch.allowCamera ? 1 : 0);
      if (patch.allowChat !== undefined) push("allow_chat", patch.allowChat ? 1 : 0);
      if (patch.allowReactions !== undefined) push("allow_reactions", patch.allowReactions ? 1 : 0);
      if (patch.allowWhiteboard !== undefined) push("allow_whiteboard", patch.allowWhiteboard ? 1 : 0);
      if (patch.allowScreenShare !== undefined) push("allow_screen_share", patch.allowScreenShare ? 1 : 0);
      if (patch.hostAllowWhiteboard !== undefined) push("host_allow_whiteboard", patch.hostAllowWhiteboard ? 1 : 0);
      if (patch.autoRecord !== undefined) push("auto_record", patch.autoRecord ? 1 : 0);
      if (!sets.length) return;
      const u = orgFilter([mid, ...vals]);
      await q(`UPDATE meetings SET ${sets.join(", ")} WHERE id=$1${u.clause}`, u.params);
    },
    // Kept for the legacy lobby toggle, which now writes THROUGH the policy so
    // the two representations cannot disagree.
    async setLocked(mid, locked) {
      const u = orgFilter([mid, locked ? 1 : 0]);
      await q(`UPDATE meetings SET locked=$2 WHERE id=$1${u.clause}`, u.params);
    },
    async setAttendeeRole(mid, uid, role) {
      await q(
        "UPDATE meeting_attendees SET role=$3 WHERE meeting_id=$1 AND user_id=$2 AND deleted=0",
        [mid, uid, role],
      );
    },
    // FREE/BUSY (scheduler redesign). Which of these people already have a
    // meeting overlapping [from, to]? Computed from meetings we already store —
    // no calendar integration needed for internal attendees, which is exactly
    // the case the scheduler cares about.
    //
    // Overlap is the standard half-open test: a meeting ending exactly when the
    // new one starts is NOT a conflict, or every back-to-back meeting would
    // report busy. Cancelled and deleted meetings never count, and `excludeId`
    // lets an EDIT ignore the meeting being edited (otherwise it always
    // conflicts with itself).
    async busyAmong(userIds: string[], from: string, to: string, excludeId?: string | null) {
      if (!userIds || !userIds.length) return [];
      const ph = userIds.map((_, i) => `$${i + 1}`).join(",");
      const params: any[] = [...userIds, from, to];
      let clause = "";
      if (excludeId) {
        params.push(excludeId);
        clause = ` AND m.id <> $${params.length}`;
      }
      const rows = (
        await q(
          `SELECT DISTINCT a.user_id, m.id AS meeting_id, m.title, m.starts_at, m.duration_min
             FROM meeting_attendees a
             JOIN meetings m ON m.id = a.meeting_id
            WHERE a.user_id IN (${ph})
              AND a.deleted = 0
              AND a.status <> 'declined'
              AND m.deleted = 0
              AND m.status <> 'cancelled'
              AND m.starts_at < $${userIds.length + 2}
              AND DATE_ADD(m.starts_at, INTERVAL m.duration_min MINUTE) > $${userIds.length + 1}
              ${clause}`,
          params,
        )
      ).rows;
      return rows.map((r: any) => ({
        userId: r.user_id,
        meetingId: r.meeting_id,
        title: r.title,
        startsAt: r.starts_at,
        durationMin: Number(r.duration_min || 0),
      }));
    },
    // Was this person on the HOST's invite list, as opposed to having simply
    // joined at some point? The "invited" lobby policy turns on this (0117).
    async isInvitedByHost(mid, uid) {
      const r = (await q(
        "SELECT invited_by_host FROM meeting_attendees WHERE meeting_id=$1 AND user_id=$2 AND deleted=0",
        [mid, uid],
      )).rows[0];
      return !!(r && r.invited_by_host);
    },
    async setAttendeeOptional(mid, uid, optional) {
      await q(
        "UPDATE meeting_attendees SET optional=$3 WHERE meeting_id=$1 AND user_id=$2 AND deleted=0",
        [mid, uid, optional ? 1 : 0],
      );
    },
    async getAttendeeRole(mid, uid) {
      const r = (await q(
        "SELECT role FROM meeting_attendees WHERE meeting_id=$1 AND user_id=$2 AND deleted=0",
        [mid, uid],
      )).rows[0];
      return r ? r.role : null;
    },
    async lobbyRequest(mid, uid) {
      await q(
        `INSERT INTO meeting_lobby (meeting_id,user_id,status) VALUES ($1,$2,'waiting')
         ON DUPLICATE KEY UPDATE status='waiting', requested_at=NOW(), decided_at=NULL, decided_by=NULL`,
        [mid, uid],
      );
    },
    async lobbyAdmit(mid, uid, decidedBy) {
      await q(
        "UPDATE meeting_lobby SET status='admitted', decided_at=NOW(), decided_by=$3 WHERE meeting_id=$1 AND user_id=$2",
        [mid, uid, decidedBy],
      );
    },
    async lobbyDeny(mid, uid, decidedBy) {
      await q(
        "UPDATE meeting_lobby SET status='denied', decided_at=NOW(), decided_by=$3 WHERE meeting_id=$1 AND user_id=$2",
        [mid, uid, decidedBy],
      );
    },
    async lobbyAdmitAll(mid, decidedBy) {
      await q(
        "UPDATE meeting_lobby SET status='admitted', decided_at=NOW(), decided_by=$2 WHERE meeting_id=$1 AND status='waiting'",
        [mid, decidedBy],
      );
    },
    async lobbyList(mid) {
      const rows = (await q(
        "SELECT l.*, u.name, u.email FROM meeting_lobby l JOIN users u ON u.id=l.user_id AND u.deleted=0 WHERE l.meeting_id=$1 ORDER BY l.requested_at",
        [mid],
      )).rows;
      return rows.map((r) => ({
        userId: r.user_id,
        name: r.name,
        email: r.email,
        status: r.status,
        requestedAt: r.requested_at,
      }));
    },
    async lobbyStatus(mid, uid) {
      const r = (await q(
        "SELECT status FROM meeting_lobby WHERE meeting_id=$1 AND user_id=$2",
        [mid, uid],
      )).rows[0];
      return r ? r.status : null;
    },
    // --- Host eject (persisted "removed from meeting") ---
    // Without this list, a kicked user could just re-POST /api/calls/token and
    // be back in. With it, meetingService.enterRoom returns { ejected:true }
    // immediately, the route returns 403, and the client surfaces the proper
    // "You were removed from this meeting" message (see CoLabV1/MeetingStage
    // error categorization).
    async meetingEject(mid, uid, ejectedBy) {
      await q(
        `INSERT INTO meeting_ejected (meeting_id, user_id, ejected_by)
         VALUES ($1, $2, $3)
         ON DUPLICATE KEY UPDATE ejected_at=NOW(), ejected_by=VALUES(ejected_by), deleted=0, deleted_at=NULL`,
        [mid, uid, ejectedBy],
      );
      // Also kill any live-room presence row so they aren't counted as
      // "alreadyIn" by computeState during the few-second SFU teardown window.
      await q(
        "UPDATE meeting_presence SET deleted=1, deleted_at=now(3) WHERE meeting_id=$1 AND user_id=$2",
        [mid, uid],
      );
    },
    async meetingEjectClear(mid, uid) {
      await q(
        "UPDATE meeting_ejected SET deleted=1, deleted_at=now(3) WHERE meeting_id=$1 AND user_id=$2",
        [mid, uid],
      );
    },
    async meetingEjectClearAll(mid) {
      await q("UPDATE meeting_ejected SET deleted=1, deleted_at=now(3) WHERE meeting_id=$1", [mid]);
    },
    async meetingIsEjected(mid, uid) {
      const r = (await q(
        "SELECT 1 AS x FROM meeting_ejected WHERE meeting_id=$1 AND user_id=$2 AND deleted=0",
        [mid, uid],
      )).rows[0];
      return !!r;
    },
  };
  const mapRem = (r) => ({
    id: r.id,
    userId: r.user_id,
    folderId: r.folder_id,
    // Organizations: surface the tenant so the recurring-spawn path (which also
    // runs in the background fire tick where currentOrgId() is null) can inherit
    // the SOURCE reminder's org onto the next occurrence.
    organizationId: r.organization_id || null,
    text: r.text,
    done: r.done,
    dueLabel: r.due_label,
    createdAt: r.created_at,
    description: r.description || "",
    dueAt: r.due_at || null,
    priority: r.priority || "Medium",
    status: r.status || (r.done ? "done" : "open"),
    updatedAt: r.updated_at || null,
    recurrence: r.recurrence || "none",
    // AUDIT #31: IANA timezone the recurring series was created in, so occurrences
    // are expanded in that zone (no DST drift). NULL → legacy server-local.
    timezone: r.timezone || null,
    // CUSTOM LEAD TIME (#53): minutes before due_at to notify. NULL/0 = at due.
    leadMinutes: r.lead_minutes == null ? null : Number(r.lead_minutes),
    // STRUCTURED RECURRENCE (#53): the Outlook-style rule (mirrors meetings).
    // mysql2 may hand back JSON parsed or as a string — tolerate both.
    recurrenceRule:
      r.recurrence_rule == null
        ? null
        : typeof r.recurrence_rule === "string"
          ? (() => { try { return JSON.parse(r.recurrence_rule); } catch { return null; } })()
          : r.recurrence_rule,
  });
  const mapTask = (r) =>
    r && {
      id: r.id,
      title: r.title,
      status: r.status,
      priority: r.priority,
      dueLabel: r.due_label,
      assigneeId: r.assignee_id,
      createdAt: r.created_at,
      description: r.description || "",
      labels: r.labels || [],
      dueAt: r.due_at || null,
      updatedAt: r.updated_at || null,
      reporterId: r.reporter_id || null,
      project: r.project || null,
      // PROJECTS-AS-ENTITIES (#52b): the linked project id (NULL = unfiled). The
      // {id,name,color} object is resolved batched in serializeTaskList.
      projectId: r.project_id || null,
      version: r.version == null ? 1 : Number(r.version),
      dueNotifiedAt: r.due_notified_at || null,
      // Recurring tasks (#52a): {none,daily,weekly,monthly}.
      recurrence: r.recurrence || "none",
      // Subtasks (#52a): self-FK parent (NULL = top-level task).
      parentTaskId: r.parent_task_id || null,
    };
  // PROJECTS-AS-ENTITIES (#52b): a task project row → its DTO.
  const mapProject = (r) =>
    r && {
      id: r.id,
      ownerId: r.owner_id,
      name: r.name,
      color: r.color || "#64748b",
      archived: !!r.archived,
      createdAt: r.created_at,
    };
  // SAVED VIEWS / SWIMLANES (#52b): a saved-view row → its DTO. `filter` is stored
  // as JSON; mysql2 may return it parsed (object) or as a string — normalize both.
  const mapSavedView = (r) => {
    if (!r) return r;
    let filter: any = r.filter;
    if (typeof filter === "string") {
      try {
        filter = JSON.parse(filter);
      } catch {
        filter = {};
      }
    }
    return {
      id: r.id,
      userId: r.user_id,
      name: r.name,
      filter: filter || {},
      groupBy: r.group_by || "none",
      sort: r.sort || "created",
      createdAt: r.created_at,
      updatedAt: r.updated_at || null,
    };
  };
  const mapPushDevice = (r) =>
    r && {
      id: r.id,
      userId: r.user_id,
      platform: r.platform,
      token: r.token,
      voipToken: r.voip_token || null,
      deviceId: r.device_id || null,
      appVersion: r.app_version || null,
      sessionJti: r.session_jti || null,
      userAgent: r.user_agent || null,
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
    };
  const mapPushClick = (r) =>
    r && {
      id: r.id,
      eventId: r.event_id,
      userId: r.user_id,
      platform: r.platform,
      source: r.source,
      appState: r.app_state,
      action: r.action,
      notificationType: r.notification_type,
      tag: r.tag,
      conversationId: r.conversation_id,
      targetType: r.target_type,
      targetId: r.target_id,
      clickedAt: r.clicked_at,
      createdAt: r.created_at,
    };
  const mapCall = (r) => ({
    id: r.id,
    conversationId: r.conversation_id,
    initiatorId: r.initiator_id,
    peerId: r.peer_id,
    kind: r.kind,
    direction: r.direction,
    status: r.status,
    durationSec: r.duration_sec,
    startedAt: r.started_at,
  });
  const mapInvite = (r) => ({
    id: r.id,
    fromUserId: r.from_user_id,
    toUserId: r.to_user_id,
    status: r.status,
    conversationId: r.conversation_id,
    createdAt: r.created_at,
    respondedAt: r.responded_at,
  });
  const invites = {
    async create({ fromUserId, toUserId }) {
      const id = genId();
      const orgId = currentOrgId();
      await q(
        `INSERT INTO invites (id,from_user_id,to_user_id,status,organization_id) VALUES ($1,$2,$3,'pending',$4)`,
        [id, fromUserId, toUserId, orgId],
      );
      const r = (
        await q(
          `SELECT * FROM invites WHERE id=$1${orgId ? " AND organization_id=$2" : ""}`,
          orgId ? [id, orgId] : [id],
        )
      ).rows[0];
      return mapInvite(r);
    },
    async getById(id) {
      // NOT org-scoped: an invite is a cross-user (often cross-org) connection request;
      // access is gated by from/to membership, not org. Row still carries org (create).
      const r = (await q("SELECT * FROM invites WHERE id=$1", [id])).rows[0];
      return r ? mapInvite(r) : null;
    },
    async setStatus(id, status, conversationId = null) {
      await q(
        "UPDATE invites SET status=$2, responded_at=now(), conversation_id=COALESCE($3,conversation_id) WHERE id=$1",
        [id, status, conversationId],
      );
      const r = (await q("SELECT * FROM invites WHERE id=$1", [id])).rows[0];
      return r ? mapInvite(r) : null;
    },
    async listForUser(userId) {
      // ORG-SCOPED: feeds the dashboard's "Pending requests" tile, which
      // otherwise carried invites from every org the caller had ever been in.
      const scope = orgFilterOrNull([userId]);
      return (
        await q(
          `SELECT * FROM invites WHERE (from_user_id=$1 OR to_user_id=$1) AND deleted=0${scope.clause} ORDER BY created_at DESC`,
          scope.params,
        )
      ).rows.map(mapInvite);
    },
    // Most-recent invite between two users (either direction), for guard checks.
    async findBetween(a, b) {
      const r = (
        await q(
          `SELECT * FROM invites
             WHERE ((from_user_id=$1 AND to_user_id=$2) OR (from_user_id=$2 AND to_user_id=$1)) AND deleted=0
             ORDER BY created_at DESC LIMIT 1`,
          [a, b],
        )
      ).rows[0];
      return r ? mapInvite(r) : null;
    },
    // True if `target` has blocked `sender` on any invite.
    async isBlockedBy(sender, target) {
      const r = await q(
        `SELECT 1 FROM invites WHERE from_user_id=$1 AND to_user_id=$2 AND status='blocked' AND deleted=0 LIMIT 1`,
        [sender, target],
      );
      return r.rows.length > 0;
    },
  };
  const folders = {
    async create({ userId, name, icon }) {
      const id = genId();
      // Organizations: stamp the active tenant (in-request → currentOrgId()).
      const orgId = currentOrgId();
      await q(
        `INSERT INTO folders (id,user_id,name,icon,organization_id) VALUES ($1,$2,$3,$4,$5)`,
        [id, userId, name, icon || "📁", orgId],
      );
      const r = (await q("SELECT * FROM folders WHERE id=$1", [id])).rows[0];
      return { id: r.id, userId: r.user_id, name: r.name, icon: r.icon };
    },
    async rename(fid, userId, name, icon) {
      const u = orgFilter([fid, userId, name ?? null, icon ?? null]);
      await q(
        `UPDATE folders SET name=COALESCE($3,name), icon=COALESCE($4,icon) WHERE id=$1 AND user_id=$2${u.clause}`,
        u.params,
      );
      const s = orgFilter([fid, userId]);
      const r = (
        await q(`SELECT * FROM folders WHERE id=$1 AND user_id=$2${s.clause}`, s.params)
      ).rows[0];
      return r
        ? { id: r.id, userId: r.user_id, name: r.name, icon: r.icon }
        : null;
    },
    async listForUser(userId) {
      const { clause, params } = orgFilter([userId]);
      return (
        await q(`SELECT * FROM folders WHERE user_id=$1 AND deleted=0${clause} ORDER BY created_at`, params)
      ).rows.map((r) => ({
        id: r.id,
        userId: r.user_id,
        name: r.name,
        icon: r.icon,
      }));
    },
    async delete(fid, userId) {
      // Soft-delete + former ON DELETE SET NULL: un-file the folder's reminders
      // (keep the reminders, just detach them from the deleted folder).
      const u = orgFilter([fid, userId]);
      await q(`UPDATE folders SET deleted=1, deleted_at=now(3), deleted_by=$2 WHERE id=$1 AND user_id=$2${u.clause}`, u.params);
      const r2 = orgFilter([fid, userId]);
      await q(`UPDATE reminders SET folder_id=NULL WHERE folder_id=$1 AND user_id=$2 AND deleted=0${r2.clause}`, r2.params);
    },
  };
  const reminders = {
    async create({
      userId,
      text,
      folderId = null,
      dueLabel = null,
      description = null,
      dueAt = null,
      priority = "Medium",
      recurrence = "none",
      leadMinutes = null,
      recurrenceRule = null,
      timezone = null,
    }) {
      const id = genId();
      // Organizations: stamp the active tenant (create is always in-request).
      const orgId = currentOrgId();
      await q(
        `INSERT INTO reminders (id,user_id,folder_id,text,due_label,description,due_at,priority,recurrence,lead_minutes,recurrence_rule,organization_id,timezone)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          id,
          userId,
          folderId,
          text,
          dueLabel,
          description,
          dueAt,
          priority,
          recurrence,
          leadMinutes == null ? null : Number(leadMinutes),
          recurrenceRule == null
            ? null
            : typeof recurrenceRule === "string"
              ? recurrenceRule
              : JSON.stringify(recurrenceRule),
          orgId,
          timezone || null,
        ],
      );
      const r = (await q("SELECT * FROM reminders WHERE id=$1", [id])).rows[0];
      return mapRem(r);
    },
    // Real keyset pagination over a user's reminders. Mirrors tasks.listForUser
    // EXACTLY (P0-A → P0-D): stable order (created_at DESC, id DESC); the cursor
    // is the previous page's last (createdAt, id). We fetch limit+1 to learn
    // whether another page exists in one round-trip, then trim. `limit` is
    // clamped; authz is inherent (user_id scoping). The firing engine (claimDue)
    // has its OWN query and is untouched by this read-path paging — it still sees
    // every due row regardless of any UI page boundary.
    async listForUser(userId, { limit = 100, cursor = null }: any = {}) {
      const lim = Math.max(1, Math.min(Number(limit) || 100, 500));
      const params: any[] = [userId];
      let keyset = "";
      if (cursor && cursor.createdAt && cursor.id) {
        // Strictly "after" the cursor in (created_at DESC, id DESC) order.
        params.push(cursor.createdAt, cursor.createdAt, cursor.id);
        keyset =
          ` AND (created_at < $${params.length - 2}` +
          ` OR (created_at = $${params.length - 1} AND id < $${params.length}))`;
      }
      // Organizations: tenant filter goes BEFORE the LIMIT param (pushed last).
      const of = orgFilter(params);
      of.params.push(lim + 1);
      const rows = (
        await q(
          `SELECT * FROM reminders
           WHERE user_id=$1 AND deleted=0${keyset}${of.clause}
           ORDER BY created_at DESC, id DESC
           LIMIT $${of.params.length}`,
          of.params,
        )
      ).rows.map(mapRem);
      const hasMore = rows.length > lim;
      const page = hasMore ? rows.slice(0, lim) : rows;
      const last = page[page.length - 1];
      const nextCursor =
        hasMore && last ? { createdAt: last.createdAt, id: last.id } : null;
      return { reminders: page, hasMore, nextCursor };
    },
    // Total live reminder count for a user — the authoritative total badge value
    // once the client only holds a page (mirrors tasks.countForUser). Cheap COUNT,
    // soft-delete aware, same predicate as listForUser.
    async countForUser(userId) {
      const { clause, params } = orgFilter([userId]);
      const r = (
        await q(
          `SELECT COUNT(*) AS n FROM reminders WHERE user_id=$1 AND deleted=0${clause}`,
          params,
        )
      ).rows[0];
      return Number((r && (r.n ?? r.N)) || 0);
    },
    // Smart-view / per-folder counts computed SERVER-SIDE so the RemindersView
    // badges (Today / Upcoming / Overdue / Completed / Archived / All) and the
    // per-folder counts + the Rail "open reminders" badge stay correct now that
    // the client holds only a page (filtering the partial array would undercount).
    //
    // The buckets mirror serialize.reminderState EXACTLY — and crucially its
    // PRECEDENCE (overdue is decided BEFORE today, so a reminder due earlier
    // today is overdue, NOT today). The buckets are therefore mutually exclusive:
    //   archived  → status='archived'
    //   completed → status='done' OR done=1 (and not archived)
    //   overdue   → active, due_at strictly before `nowIso`
    //   today     → active, due_at in [nowIso, dayEndIso)  (still-future, same day)
    //   upcoming  → every other active reminder (no due, or a due beyond today)
    // "active" = not archived and not completed. `all` = active total. `open` =
    // every not-done reminder (matches the Rail badge's `!r.done`). `nowIso` +
    // the day end are the SERVER-LOCAL day (the basis reminderState uses via
    // Date.now()/toDateString()) so SQL and JS agree. `dayStartIso` is unused now
    // that `today`'s lower bound is `nowIso` (overdue owns everything before now),
    // but it's kept in the signature for callers/back-compat.
    async countsForUser(userId, nowIso, dayStartIso, dayEndIso) {
      const c1 = orgFilter([userId, nowIso, dayEndIso]);
      const r = (
        await q(
          `SELECT
             SUM(CASE WHEN status='archived' THEN 1 ELSE 0 END) AS archived,
             SUM(CASE WHEN status<>'archived' AND (status='done' OR done=1) THEN 1 ELSE 0 END) AS completed,
             SUM(CASE WHEN status<>'archived' AND status<>'done' AND done=0
                       AND due_at IS NOT NULL AND due_at < $2 THEN 1 ELSE 0 END) AS overdue,
             SUM(CASE WHEN status<>'archived' AND status<>'done' AND done=0
                       AND due_at IS NOT NULL AND due_at >= $2 AND due_at < $3 THEN 1 ELSE 0 END) AS today,
             SUM(CASE WHEN status<>'archived' AND status<>'done' AND done=0 THEN 1 ELSE 0 END) AS active,
             SUM(CASE WHEN done=0 THEN 1 ELSE 0 END) AS open
           FROM reminders WHERE user_id=$1 AND deleted=0${c1.clause}`,
          c1.params,
        )
      ).rows[0] || {};
      const num = (v) => Number(v || 0);
      const archived = num(r.archived);
      const completed = num(r.completed);
      const overdue = num(r.overdue);
      const today = num(r.today);
      const active = num(r.active);
      const open = num(r.open);
      // "upcoming" = active reminders that are neither overdue nor due-today
      // (no due date, or a future due date beyond today). Derived so the buckets
      // partition the active set exactly (no double counting).
      const upcoming = Math.max(0, active - overdue - today);
      // Per-folder counts: the sidebar list badge counts a folder's ACTIVE
      // reminders (not archived, not completed) — matches RemindersView's
      // per-folder badge predicate.
      const c2 = orgFilter([userId]);
      const folderRows = (
        await q(
          `SELECT folder_id AS fid, COUNT(*) AS n
             FROM reminders
            WHERE user_id=$1 AND deleted=0 AND folder_id IS NOT NULL
              AND status<>'archived' AND status<>'done' AND done=0${c2.clause}
            GROUP BY folder_id`,
          c2.params,
        )
      ).rows;
      const folders: Record<string, number> = {};
      for (const fr of folderRows) folders[fr.fid] = Number(fr.n || 0);
      return {
        all: active,
        today,
        upcoming,
        overdue,
        completed,
        archived,
        open,
        folders,
      };
    },
    async search(userId, qry, orgId) {
      const orgClause = orgId ? " AND organization_id = $3" : "";
      // Hybrid relevance (0072): see tasks.search — ILIKE recall floor + word-
      // level FULLTEXT, ranked by weighted MATCH (text 2x description).
      const bool = ftsBool(qry);
      if (!bool) {
        return (
          await q(
            `SELECT * FROM reminders WHERE user_id=$1 AND deleted=0 AND status <> 'archived'${orgClause}
             AND (text ILIKE $2 OR COALESCE(description,'') ILIKE $2)
             ORDER BY created_at DESC LIMIT 20`,
            orgId ? [userId, "%" + qry + "%", orgId] : [userId, "%" + qry + "%"],
          )
        ).rows.map(mapRem);
      }
      const bp = orgId ? "$4" : "$3";
      return (
        await q(
          `SELECT reminders.*,
                  (MATCH(text) AGAINST(${bp} IN BOOLEAN MODE) * 2
                 + MATCH(description) AGAINST(${bp} IN BOOLEAN MODE)) AS _rel
             FROM reminders WHERE user_id=$1 AND deleted=0 AND status <> 'archived'${orgClause}
           AND (text ILIKE $2 OR COALESCE(description,'') ILIKE $2
                OR MATCH(text) AGAINST(${bp} IN BOOLEAN MODE)
                OR MATCH(description) AGAINST(${bp} IN BOOLEAN MODE))
           ORDER BY _rel DESC, created_at DESC LIMIT 20`,
          orgId
            ? [userId, "%" + qry + "%", orgId, bool]
            : [userId, "%" + qry + "%", bool],
        )
      ).rows.map(mapRem);
    },
    async toggle(rid, userId) {
      // MySQL evaluates SET left-to-right, so assign `done` from the OLD status
      // BEFORE flipping `status` to preserve Postgres semantics.
      const u = orgFilter([rid, userId]);
      await q(
        `UPDATE reminders SET
             done = (status <> 'done'),
             status = CASE WHEN status='done' THEN 'open' ELSE 'done' END,
             updated_at = now()
           WHERE id=$1 AND user_id=$2${u.clause}`,
        u.params,
      );
      return this.getOne(rid, userId); // getOne is org-scoped
    },
    async setStatus(rid, userId, status) {
      const u = orgFilter([rid, userId, status]);
      await q(
        `UPDATE reminders SET status=$3, done=($3='done'), updated_at=now() WHERE id=$1 AND user_id=$2${u.clause}`,
        u.params,
      );
      return this.getOne(rid, userId);
    },
    async update(rid, userId, patch) {
      const sets: string[] = [];
      const vals: any[] = [rid, userId];
      const add = (col, val) => {
        vals.push(val);
        sets.push(`${col}=$${vals.length}`);
      };
      if (patch.text !== undefined) add("text", patch.text);
      if (patch.folderId !== undefined) add("folder_id", patch.folderId);
      if (patch.dueLabel !== undefined) add("due_label", patch.dueLabel);
      if (patch.description !== undefined)
        add("description", patch.description);
      if (patch.dueAt !== undefined) add("due_at", patch.dueAt);
      if (patch.priority !== undefined) add("priority", patch.priority);
      if (patch.recurrence !== undefined) add("recurrence", patch.recurrence);
      if (patch.leadMinutes !== undefined)
        add("lead_minutes", patch.leadMinutes == null ? null : Number(patch.leadMinutes));
      if (patch.recurrenceRule !== undefined)
        add(
          "recurrence_rule",
          patch.recurrenceRule == null
            ? null
            : typeof patch.recurrenceRule === "string"
              ? patch.recurrenceRule
              : JSON.stringify(patch.recurrenceRule),
        );
      if (patch.status !== undefined) {
        add("status", patch.status);
        add("done", patch.status === "done");
      }
      if (!sets.length) return this.getOne(rid, userId);
      sets.push("updated_at=now()");
      const u = orgFilter(vals);
      await q(
        `UPDATE reminders SET ${sets.join(", ")} WHERE id=$1 AND user_id=$2${u.clause}`,
        u.params,
      );
      return this.getOne(rid, userId);
    },
    async delete(rid, userId) {
      const u = orgFilter([rid, userId]);
      await q(
        `UPDATE reminders SET deleted=1, deleted_at=now(3), deleted_by=$2 WHERE id=$1 AND user_id=$2${u.clause}`,
        u.params,
      );
    },
    async getOne(rid, userId) {
      // Organizations: also scope to the active tenant so a user who belongs to
      // more than one org can't read another org's reminder by id (single-owner
      // entity → getById scoping is safe; conditional so NULL-org keeps behavior).
      const orgId = currentOrgId();
      const r = (
        await q(
          `SELECT * FROM reminders WHERE id=$1 AND user_id=$2 AND deleted=0${orgId ? " AND organization_id=$3" : ""}`,
          orgId ? [rid, userId, orgId] : [rid, userId],
        )
      ).rows[0];
      return r ? mapRem(r) : null;
    },
    // ATOMIC double-spawn guard (closes the concurrent TOCTOU that a bare
    // existence-check + create() pair would leave open). The fire-tick and a
    // concurrent completion can both reach spawnNext sub-millisecond apart; with
    // a non-atomic check-then-insert they could both see "no occurrence" and
    // insert two identical next rows. We can't add a UNIQUE index on the series
    // identity — existing done/deleted rows legitimately share (user,text,due_at)
    // and index creation would fail / future inserts would be wrongly rejected.
    //
    // Instead we SERIALIZE the check+insert with a MySQL named advisory lock
    // (GET_LOCK) keyed by the stable series identity + the next due instant.
    // GET_LOCK serializes regardless of indexes or isolation level and needs NO
    // schema change, so it's safe on existing data. Whoever grabs the lock first
    // does the existence check and (if absent) the insert; the second waiter then
    // re-checks under the lock, sees the committed row, and returns null. The
    // lock is connection-scoped and always released in finally.
    //
    // FAIL-OPEN-ish: if the lock can't be acquired in time we fall back to the
    // plain check+insert (same residual narrow race as before — never worse), so
    // a busy lock table can't drop a legitimate recurring spawn.
    async spawnNextOccurrence({
      userId,
      text,
      folderId = null,
      dueLabel = null,
      description = null,
      dueAt = null,
      priority = "Medium",
      recurrence = "none",
      leadMinutes = null,
      recurrenceRule = null,
      organizationId = undefined,
      timezone = null,
    }) {
      // Organizations: this runs from BOTH the completion path (in-request → org
      // ambient) AND the background fire tick (no request → currentOrgId() null).
      // So inherit the SOURCE reminder's org (passed by the caller) and only fall
      // back to the ambient org — otherwise a fire-tick spawn would be born NULL-org.
      const orgId = organizationId !== undefined ? organizationId : currentOrgId();
      const conn = await pool.getConnection();
      // Run a $-style query on THIS pinned connection with the same
      // translate/bind/normParam semantics as the pooled q() helper, so the SQL
      // below behaves identically inside the dedicated lock connection.
      const cq = async (t: string, p: any[] = []) => {
        const bound = bind(translate(t), p || []);
        const [res]: any = await conn.query(bound.text, bound.params.map(normParam));
        if (Array.isArray(res)) return { rows: res, rowCount: res.length };
        return { rows: [], rowCount: (res && res.affectedRows) || 0 };
      };
      // Deterministic, length-bounded lock name (MySQL lock names cap at 64
      // chars). Hash the series identity so arbitrary text/folder values fit.
      const lockKey = createHash("sha1")
        .update(
          [userId, recurrence, folderId || "", dueAt || "", text || ""].join("|"),
        )
        .digest("hex");
      const lockName = `rem_spawn_${lockKey}`;
      let locked = false;
      try {
        try {
          const lr: any = await cq("SELECT GET_LOCK($1, 5) AS ok", [lockName]);
          locked = !!(lr.rows[0] && Number(lr.rows[0].ok) === 1);
        } catch (_) {
          locked = false; // fall through to the plain check+insert
        }
        const exists = await cq(
          `SELECT id FROM reminders
             WHERE user_id=$1 AND deleted=0
               AND status NOT IN ('done','archived')
               AND text=$2
               AND COALESCE(folder_id,'')=COALESCE($3,'')
               AND recurrence=$4
               AND due_at=$5
               AND organization_id <=> $6
             LIMIT 1`,
          [userId, text, folderId, recurrence, dueAt, orgId],
        );
        if (exists.rows.length > 0) return null;
        const id = genId();
        await cq(
          `INSERT INTO reminders (id,user_id,folder_id,text,due_label,description,due_at,priority,recurrence,lead_minutes,recurrence_rule,organization_id,timezone)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            id, userId, folderId, text, dueLabel, description, dueAt, priority, recurrence,
            leadMinutes == null ? null : Number(leadMinutes),
            recurrenceRule == null
              ? null
              : typeof recurrenceRule === "string"
                ? recurrenceRule
                : JSON.stringify(recurrenceRule),
            orgId,
            timezone || null,
          ],
        );
        const r = (await cq("SELECT * FROM reminders WHERE id=$1", [id])).rows[0];
        return mapRem(r);
      } finally {
        if (locked) {
          try { await conn.query("SELECT RELEASE_LOCK(?)", [lockName]); } catch (_) {}
        }
        conn.release();
      }
    },
    // Snooze: re-arm a reminder to fire again at a new instant. Pushes due_at
    // forward, CLEARS notified_at (so the exactly-once claimDue engine re-claims
    // it at the new time), and forces status back to 'open'. This re-uses the
    // firing backbone unchanged — it just resets the row's gate; it never emits a
    // notification itself. Ownership-scoped (user_id) so it's IDOR-safe.
    async rearm(rid, userId, dueAtIso) {
      const u = orgFilter([rid, userId, dueAtIso]);
      await q(
        `UPDATE reminders
           SET due_at=$3, notified_at=NULL, status='open', done=0, updated_at=now()
           WHERE id=$1 AND user_id=$2 AND deleted=0${u.clause}`,
        u.params,
      );
      return this.getOne(rid, userId);
    },
    async recurringDueAmong(ids, userId) {
      const { clause, params } = orgFilter([ids, userId]);
      return (
        await q(
          `SELECT * FROM reminders
           WHERE id = ANY($1) AND user_id=$2 AND deleted=0
             AND (recurrence <> 'none' OR recurrence_rule IS NOT NULL)
             AND due_at IS NOT NULL AND status <> 'done'${clause}`,
          params,
        )
      ).rows.map(mapRem);
    },
    async bulkPatch(ids, userId, patch) {
      const sets: string[] = [];
      const vals: any[] = [ids, userId];
      const add = (col, val) => {
        vals.push(val);
        sets.push(`${col}=$${vals.length}`);
      };
      if (patch.status !== undefined) {
        add("status", patch.status);
        add("done", patch.status === "done");
      }
      if (patch.folderId !== undefined) add("folder_id", patch.folderId);
      if (patch.priority !== undefined) add("priority", patch.priority);
      if (!sets.length) return { count: 0 };
      sets.push("updated_at=now()");
      const u = orgFilter(vals);
      const r = await q(
        `UPDATE reminders SET ${sets.join(", ")} WHERE id = ANY($1) AND user_id=$2 AND deleted=0${u.clause}`,
        u.params,
      );
      return { count: r.rowCount || 0 };
    },
    async bulkRemove(ids, userId) {
      const u = orgFilter([ids, userId]);
      const r = await q(
        `UPDATE reminders SET deleted=1, deleted_at=now(3), deleted_by=$2 WHERE id = ANY($1) AND user_id=$2 AND deleted=0${u.clause}`,
        u.params,
      );
      return { count: r.rowCount || 0 };
    },
    // Reminders firing engine: atomically claim due reminders so each fires
    // EXACTLY once, then read them back. Mirrors scheduledMessages.claimDue —
    // SELECT ... FOR UPDATE SKIP LOCKED, stamp notified_at, read back, in a tx.
    // due_at is a UTC wall-clock DATETIME (like send_at), so compare against
    // UTC_TIMESTAMP() — correct regardless of the MySQL session timezone.
    //
    // CUSTOM LEAD TIME (#53): the row fires on its DERIVED notify-at =
    // due_at - lead_minutes (NULL/0 lead = fire AT due_at, the original behaviour).
    // This is the ONLY change to the predicate — the effective fire instant shifts
    // earlier by the lead. Everything that makes firing reliable is UNTOUCHED: the
    // notified_at exactly-once stamp, FOR UPDATE SKIP LOCKED, the ORDER + LIMIT, and
    // the missed-catch-up (a row whose notify-at already passed while the worker was
    // down is still <= now, so it's claimed on the next tick). COALESCE defaults a
    // NULL lead to 0 so legacy rows compare exactly as before.
    async claimDue(limit) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const lim = Number(limit) || 50;
        const [picked]: any = await conn.query(
          `SELECT id FROM reminders
             WHERE deleted=0 AND status='open' AND notified_at IS NULL
               AND due_at IS NOT NULL
               AND (due_at - INTERVAL COALESCE(lead_minutes,0) MINUTE) <= UTC_TIMESTAMP()
             ORDER BY due_at ASC
             LIMIT ${lim}
             FOR UPDATE SKIP LOCKED`,
          [],
        );
        const ids = picked.map((r) => r.id);
        if (!ids.length) {
          await conn.commit();
          return [];
        }
        await conn.query(
          `UPDATE reminders SET notified_at=now() WHERE id IN (?)`,
          [ids],
        );
        const [rows]: any = await conn.query(
          `SELECT * FROM reminders WHERE id IN (?)`,
          [ids],
        );
        await conn.commit();
        return rows.map(mapRem);
      } catch (e) {
        try {
          await conn.rollback();
        } catch {
          /* ignore */
        }
        throw e;
      } finally {
        conn.release();
      }
    },
    // AUTO-PRUNE (#53): bound the unbounded recurrence row-spawn. A daily reminder
    // running for a year leaves ~365 done occurrence rows behind; this soft-deletes
    // the very old COMPLETED ones past a retention window so the table stays lean.
    //
    // SAFETY (never prune anything live or future):
    //   • recurring only       — recurrence<>'none' OR recurrence_rule IS NOT NULL
    //                            (a one-off completed reminder is the user's history,
    //                            not auto-spawned noise — left untouched)
    //   • completed only       — status='done' OR done=1
    //   • already past         — due_at strictly BEFORE the cutoff (window days ago)
    //   • not already deleted  — deleted=0
    // It uses SOFT delete (the project-wide convention), so a pruned row is still
    // recoverable / GC'd by the normal lifecycle. Bounded by `limit` per call so a
    // huge backlog drains over several sweeps instead of one giant UPDATE. Returns
    // the number pruned. Pure data hygiene — never touches the call/meeting path.
    async pruneOldOccurrences(windowDays = 90, limit = 500) {
      const days = Math.max(1, Number(windowDays) || 90);
      const lim = Math.max(1, Math.min(Number(limit) || 500, 5000));
      const cutoff = new Date(Date.now() - days * 86400000).toISOString();
      // (1) COMPLETED occurrences older than the window (original behaviour).
      const doneRes = await q(
        `UPDATE reminders
            SET deleted=1, deleted_at=now(3)
          WHERE deleted=0
            AND (recurrence <> 'none' OR recurrence_rule IS NOT NULL)
            AND (status='done' OR done=1)
            AND due_at IS NOT NULL
            AND due_at < $1
          ORDER BY due_at ASC
          LIMIT ${lim}`,
        [cutoff],
      );
      // (2) AUDIT #32: old, STILL-OPEN occurrences of a recurring series that have
      // already been SUPERSEDED by a newer live occurrence in the same series.
      // The fire path (reminderFireService.runDue) rolls a recurring reminder
      // forward WITHOUT completing the fired occurrence, so without this those
      // fired-but-unacknowledged rows accumulate forever — (1) never reclaims them
      // because they're not `done`. We only ever prune an occurrence that ALREADY
      // has a strictly-later successor in its series, so the current/tail
      // occurrence of every series is always preserved (a user who never touches a
      // recurring reminder still keeps exactly one live upcoming instance).
      //
      // Series identity mirrors spawnNextOccurrence's own existence check:
      // (user_id, text, folder_id, recurrence, organization_id). MySQL forbids
      // referencing the UPDATE target inside its own subquery (error 1093), so we
      // SELECT the superseded ids via a self-join first, then delete them by id.
      const staleLim = Math.max(1, lim - (doneRes.rowCount || 0));
      const stale =
        staleLim > 0
          ? await q(
              `SELECT r.id
                 FROM reminders r
                 JOIN reminders n
                   ON n.user_id = r.user_id
                  AND n.deleted = 0
                  AND n.id <> r.id
                  AND n.text = r.text
                  AND COALESCE(n.folder_id,'') = COALESCE(r.folder_id,'')
                  AND n.recurrence = r.recurrence
                  AND n.organization_id <=> r.organization_id
                  AND n.due_at > r.due_at
                WHERE r.deleted = 0
                  AND (r.recurrence <> 'none' OR r.recurrence_rule IS NOT NULL)
                  AND r.status NOT IN ('done','archived')
                  AND r.done = 0
                  AND r.due_at IS NOT NULL
                  AND r.due_at < $1
                ORDER BY r.due_at ASC
                LIMIT ${staleLim}`,
              [cutoff],
            )
          : { rows: [] as any[] };
      const staleIds = (stale.rows || []).map((row: any) => row.id);
      let stalePruned = 0;
      if (staleIds.length) {
        const up = await q(
          `UPDATE reminders SET deleted=1, deleted_at=now(3)
            WHERE id = ANY($1) AND deleted=0`,
          [staleIds],
        );
        stalePruned = up.rowCount || 0;
      }
      return { pruned: (doneRes.rowCount || 0) + stalePruned };
    },
  };
  const tasks = {
    async create({
      title,
      status = "todo",
      priority = "Medium",
      dueLabel = null,
      assigneeId = null,
      description = null,
      labels = [],
      dueAt = null,
      reporterId = null,
      project = null,
      projectId = null,
      recurrence = "none",
      parentTaskId = null,
    }) {
      const id = genId();
      // Organizations: stamp the active tenant on the task + its denormalized children.
      const orgId = currentOrgId();
      await q(
        `INSERT INTO tasks (id,title,status,priority,due_label,assignee_id,description,labels,due_at,reporter_id,project,project_id,recurrence,parent_task_id,organization_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          id,
          title,
          status,
          priority,
          dueLabel,
          assigneeId,
          description,
          JSON.stringify(labels || []),
          dueAt,
          reporterId,
          project,
          projectId,
          recurrence,
          parentTaskId,
          orgId,
        ],
      );
      // Mirror the single assignee into the canonical join table + auto-watch the
      // assignee and reporter (the default-watch rule). Idempotent inserts.
      if (assigneeId)
        await q(
          "INSERT IGNORE INTO task_assignees (task_id,user_id,assigned_by,organization_id) VALUES ($1,$2,$3,$4)",
          [id, assigneeId, reporterId || null, orgId],
        );
      for (const w of [assigneeId, reporterId])
        if (w)
          await q(
            "INSERT IGNORE INTO task_watchers (task_id,user_id,organization_id) VALUES ($1,$2,$3)",
            [id, w, orgId],
          );
      const r = (
        await q(
          `SELECT * FROM tasks WHERE id=$1${orgId ? " AND organization_id=$2" : ""}`,
          orgId ? [id, orgId] : [id],
        )
      ).rows[0];
      return mapTask(r);
    },
    async getById(tid) {
      const orgId = currentOrgId();
      const r = (
        await q(
          `SELECT * FROM tasks WHERE id=$1 AND deleted=0${orgId ? " AND organization_id=$2" : ""}`,
          orgId ? [tid, orgId] : [tid],
        )
      ).rows[0];
      return r ? mapTask(r) : null;
    },
    async list({ limit = 2000 } = {}) {
      const of = orgFilter([]);
      of.params.push(limit);
      return (
        await q(`SELECT * FROM tasks WHERE deleted=0${of.clause} ORDER BY created_at DESC LIMIT $${of.params.length}`, of.params)
      ).rows.map(mapTask);
    },
    // Real keyset pagination over a user's tasks. Stable order is
    // (created_at DESC, id DESC); the cursor is the last row's (createdAt, id)
    // from the previous page. We fetch limit+1 to know if another page exists
    // without a second round-trip, then trim. Returns the slice + a `hasMore`
    // flag + the `nextCursor` to pass back. `limit` is clamped by the caller.
    async listForUser(userId, { limit = 100, cursor = null, projectId = undefined }: any = {}) {
      const lim = Math.max(1, Math.min(Number(limit) || 100, 500));
      const params: any[] = [userId];
      let keyset = "";
      if (cursor && cursor.createdAt && cursor.id) {
        // Strictly "after" the cursor in (created_at DESC, id DESC) order.
        params.push(cursor.createdAt, cursor.createdAt, cursor.id);
        keyset =
          ` AND (created_at < $${params.length - 2}` +
          ` OR (created_at = $${params.length - 1} AND id < $${params.length}))`;
      }
      // PROJECTS-AS-ENTITIES (#52b): an optional SERVER-SIDE project filter so the
      // page + count agree. `null`/"" filters to UNFILED tasks (project_id IS
      // NULL); a non-empty id filters to that project; `undefined` = no filter.
      let projectClause = "";
      if (projectId !== undefined) {
        if (projectId === null || projectId === "") {
          projectClause = " AND project_id IS NULL";
        } else {
          params.push(projectId);
          projectClause = ` AND project_id=$${params.length}`;
        }
      }
      // Organizations: tenant filter goes BEFORE the LIMIT param (pushed last).
      const of = orgFilter(params, "tasks.organization_id");
      of.params.push(lim + 1);
      // "My tasks" = reporter OR ANY assignee. With multiple assignees the
      // predicate can no longer be a bare assignee_id check (that only matches the
      // PRIMARY), so it also matches via the task_assignees join table. assignee_id
      // is kept (it = the primary) so an existing index/plan still helps the common
      // case; the EXISTS covers secondary assignees.
      const rows = (
        await q(
          `SELECT * FROM tasks
           WHERE (reporter_id=$1 OR assignee_id=$1
                  OR EXISTS (SELECT 1 FROM task_assignees ta
                              WHERE ta.task_id=tasks.id AND ta.user_id=$1))
             AND deleted=0${projectClause}${keyset}${of.clause}
           ORDER BY created_at DESC, id DESC
           LIMIT $${of.params.length}`,
          of.params,
        )
      ).rows.map(mapTask);
      const hasMore = rows.length > lim;
      const page = hasMore ? rows.slice(0, lim) : rows;
      const last = page[page.length - 1];
      const nextCursor =
        hasMore && last ? { createdAt: last.createdAt, id: last.id } : null;
      return { tasks: page, hasMore, nextCursor };
    },
    // Total live task count for a user — drives dashboard/rail badges that must
    // NOT undercount once the list is paginated (the client no longer holds the
    // full set). Cheap COUNT, soft-delete aware, mirrors listForUser's filter.
    async countForUser(userId, { projectId = undefined }: any = {}) {
      // Mirror listForUser's predicate exactly (reporter OR ANY assignee + the
      // same optional project filter) so the dashboard/rail badge total agrees
      // with the paginated list.
      const params: any[] = [userId];
      let projectClause = "";
      if (projectId !== undefined) {
        if (projectId === null || projectId === "") {
          projectClause = " AND project_id IS NULL";
        } else {
          params.push(projectId);
          projectClause = ` AND project_id=$${params.length}`;
        }
      }
      const of = orgFilter(params, "tasks.organization_id");
      const r = (
        await q(
          `SELECT COUNT(*) AS n FROM tasks
           WHERE (reporter_id=$1 OR assignee_id=$1
                  OR EXISTS (SELECT 1 FROM task_assignees ta
                              WHERE ta.task_id=tasks.id AND ta.user_id=$1))
             AND deleted=0${projectClause}${of.clause}`,
          of.params,
        )
      ).rows[0];
      return Number((r && (r.n ?? r.N)) || 0);
    },
    // Optimistic-concurrency aware update. Always bumps `version = version + 1`
    // (so the row genuinely changes — affectedRows is never falsely 0). When
    // `expectedVersion` is provided, the UPDATE is guarded with `AND version =
    // expected`; a concurrent edit moved the version on, so the guard matches 0
    // rows → `matched:false`. The caller distinguishes conflict (row still
    // exists) from deletion. Returns { task, matched } — task is the freshly
    // re-read row (or null if it no longer exists).
    async update(tid, patch, expectedVersion: any = undefined) {
      const sets: string[] = [];
      const vals: any[] = [tid];
      const add = (col, val) => {
        vals.push(val);
        sets.push(`${col}=$${vals.length}`);
      };
      if (patch.title !== undefined) add("title", patch.title);
      if (patch.status !== undefined) add("status", patch.status);
      if (patch.priority !== undefined) add("priority", patch.priority);
      if (patch.dueLabel !== undefined) add("due_label", patch.dueLabel);
      if (patch.assigneeId !== undefined) add("assignee_id", patch.assigneeId);
      if (patch.description !== undefined)
        add("description", patch.description);
      if (patch.labels !== undefined)
        add("labels", JSON.stringify(patch.labels || []));
      if (patch.dueAt !== undefined) add("due_at", patch.dueAt);
      if (patch.project !== undefined) add("project", patch.project);
      if (patch.projectId !== undefined) add("project_id", patch.projectId);
      if (patch.recurrence !== undefined) add("recurrence", patch.recurrence);
      if (patch.parentTaskId !== undefined)
        add("parent_task_id", patch.parentTaskId);
      // Due-firing stamp: the service clears this (to NULL) when a task is
      // rescheduled or reopened so the next due scan can fire it again. `add`
      // binds a null param → `due_notified_at = NULL`.
      if (patch.dueNotifiedAt !== undefined)
        add("due_notified_at", patch.dueNotifiedAt);
      sets.push("updated_at=now()");
      sets.push("version=version+1");
      let where = "WHERE id=$1 AND deleted=0";
      const hasGuard =
        expectedVersion !== undefined && expectedVersion !== null;
      if (hasGuard) {
        vals.push(Number(expectedVersion));
        where += ` AND version=$${vals.length}`;
      }
      const of = orgFilter(vals);
      where += of.clause;
      const r = await q(`UPDATE tasks SET ${sets.join(", ")} ${where}`, of.params);
      const matched = (r.rowCount || 0) > 0;
      const s = orgFilter([tid]);
      const row = (
        await q(`SELECT * FROM tasks WHERE id=$1 AND deleted=0${s.clause}`, s.params)
      ).rows[0];
      const task = row ? mapTask(row) : null;
      // No guard → preserve the legacy contract (callers expect the task or
      // null). With a guard, the service needs both task + matched.
      return hasGuard ? { task, matched } : task;
    },
    async logActivity(taskId, actorId, kind, detail = null) {
      const id = genId();
      // Organizations: inherit the parent task's tenant (authoritative), falling
      // back to the ambient org — task_activity is a denormalized org child.
      const orgId = currentOrgId();
      await q(
        `INSERT INTO task_activity (id,task_id,actor_id,kind,detail,organization_id)
           VALUES ($1,$2,$3,$4,$5,COALESCE((SELECT organization_id FROM tasks WHERE id=$2),$6))`,
        [
          id,
          taskId,
          actorId || null,
          kind,
          detail ? JSON.stringify(detail) : null,
          orgId,
        ],
      );
      const r = (await q("SELECT * FROM task_activity WHERE id=$1", [id]))
        .rows[0];
      return {
        id: r.id,
        actorId: r.actor_id,
        kind: r.kind,
        detail: r.detail,
        createdAt: r.created_at,
      };
    },
    async activity(taskId) {
      return (
        await q(
          "SELECT * FROM task_activity WHERE task_id=$1 ORDER BY created_at DESC LIMIT 200",
          [taskId],
        )
      ).rows.map((r) => ({
        id: r.id,
        actorId: r.actor_id,
        kind: r.kind,
        detail: r.detail,
        createdAt: r.created_at,
      }));
    },
    async addDep(taskId, dependsOnId) {
      await q(
        "INSERT INTO task_deps (task_id,depends_on_id) VALUES ($1,$2) AS new ON DUPLICATE KEY UPDATE deleted=0, deleted_at=NULL",
        [taskId, dependsOnId],
      );
      return { taskId, dependsOnId };
    },
    async removeDep(taskId, dependsOnId) {
      await q("UPDATE task_deps SET deleted=1, deleted_at=now(3) WHERE task_id=$1 AND depends_on_id=$2", [
        taskId,
        dependsOnId,
      ]);
      return { taskId, dependsOnId, removed: true };
    },
    async deps(taskId) {
      const a = orgFilter([taskId], "t.organization_id");
      const blockedBy = (
        await q(
          `SELECT t.* FROM task_deps d JOIN tasks t ON t.id=d.depends_on_id AND t.deleted=0 WHERE d.task_id=$1 AND d.deleted=0${a.clause}`,
          a.params,
        )
      ).rows.map(mapTask);
      const b = orgFilter([taskId], "t.organization_id");
      const blocking = (
        await q(
          `SELECT t.* FROM task_deps d JOIN tasks t ON t.id=d.task_id AND t.deleted=0 WHERE d.depends_on_id=$1 AND d.deleted=0${b.clause}`,
          b.params,
        )
      ).rows.map(mapTask);
      return { blockedBy, blocking };
    },
    async addComment(taskId, authorId, body) {
      const id = genId();
      // Organizations: inherit the parent task's tenant (denormalized org child).
      const orgId = currentOrgId();
      await q(
        `INSERT INTO task_comments (id,task_id,author_id,body,organization_id)
           VALUES ($1,$2,$3,$4,COALESCE((SELECT organization_id FROM tasks WHERE id=$2),$5))`,
        [id, taskId, authorId || null, body, orgId],
      );
      const r = (await q("SELECT * FROM task_comments WHERE id=$1", [id]))
        .rows[0];
      return {
        id: r.id,
        authorId: r.author_id,
        body: r.body,
        createdAt: r.created_at,
      };
    },
    async comments(taskId) {
      return (
        await q(
          "SELECT * FROM task_comments WHERE task_id=$1 AND deleted=0 ORDER BY created_at ASC LIMIT 500",
          [taskId],
        )
      ).rows.map((r) => ({
        id: r.id,
        authorId: r.author_id,
        body: r.body,
        createdAt: r.created_at,
      }));
    },
    async removeComment(commentId, userId) {
      const r = await q(
        "UPDATE task_comments SET deleted=1, deleted_at=now(3), deleted_by=$2 WHERE id=$1 AND author_id=$2 AND deleted=0",
        [commentId, userId],
      );
      return { id: commentId, deleted: (r.rowCount || 0) > 0 };
    },
    async bulkPatch(ids, patch) {
      const sets: string[] = [];
      const vals: any[] = [ids];
      const add = (col, val) => {
        vals.push(val);
        sets.push(`${col}=$${vals.length}`);
      };
      if (patch.status !== undefined) add("status", patch.status);
      if (patch.assigneeId !== undefined) add("assignee_id", patch.assigneeId);
      if (!sets.length) return { count: 0 };
      sets.push("updated_at=now()");
      // Bump version so any editor holding a now-stale single-task version is
      // forced to reconcile (their guarded PATCH will 409 after this bulk write).
      sets.push("version=version+1");
      const of = orgFilter(vals);
      const r = await q(
        `UPDATE tasks SET ${sets.join(", ")} WHERE id = ANY($1) AND deleted=0${of.clause}`,
        of.params,
      );
      return { count: r.rowCount || 0 };
    },
    async bulkLog(ids, actorId, kind, detail = null) {
      // Organizations: carry each source task's own org straight into its activity
      // row (the SELECT already reads the task, so no COALESCE/ambient needed).
      await q(
        `INSERT INTO task_activity (id,task_id,actor_id,kind,detail,organization_id)
         SELECT UUID(), id, $2, $3, $4, organization_id FROM tasks WHERE id = ANY($1)`,
        [ids, actorId || null, kind, detail ? JSON.stringify(detail) : null],
      );
    },
    async bulkRemove(ids) {
      const rf = orgFilter([ids]);
      const r = await q(`UPDATE tasks SET deleted=1, deleted_at=now(3) WHERE id = ANY($1) AND deleted=0${rf.clause}`, rf.params);
      // SUBTASK SOFT-CASCADE (#52a): soft-delete the whole subtree under each
      // deleted task, level by level (mirrors the single-task remove() recursion).
      // Bounded by a depth cap so a pathological tree can't loop forever.
      let frontier: string[] = [...ids];
      let depth = 0;
      while (frontier.length && depth++ < 1000) {
        const kf = orgFilter([frontier]);
        const kids = (
          await q(
            `SELECT id FROM tasks WHERE parent_task_id = ANY($1) AND deleted=0${kf.clause}`,
            kf.params,
          )
        ).rows.map((row) => row.id);
        if (!kids.length) break;
        const uf = orgFilter([kids]);
        await q(`UPDATE tasks SET deleted=1, deleted_at=now(3) WHERE id = ANY($1) AND deleted=0${uf.clause}`, uf.params);
        await q("UPDATE task_comments SET deleted=1, deleted_at=now(3) WHERE task_id = ANY($1) AND deleted=0", [kids]);
        await q("UPDATE task_deps SET deleted=1, deleted_at=now(3) WHERE (task_id = ANY($1) OR depends_on_id = ANY($1)) AND deleted=0", [kids]);
        await q("UPDATE task_attachments SET deleted=1, deleted_at=now(3) WHERE task_id = ANY($1) AND deleted=0", [kids]);
        frontier = kids;
      }
      // Soft-cascade to children, mirroring the single-task remove() above so a bulk
      // delete doesn't leave orphaned comment/dep/attachment-link rows at deleted=0.
      // (Attachment file BLOBS are left intact — owner-managed via the recycle bin;
      // we only drop the task association, same as remove().)
      await q("UPDATE task_comments SET deleted=1, deleted_at=now(3) WHERE task_id = ANY($1) AND deleted=0", [ids]);
      await q("UPDATE task_deps SET deleted=1, deleted_at=now(3) WHERE (task_id = ANY($1) OR depends_on_id = ANY($1)) AND deleted=0", [ids]);
      await q("UPDATE task_attachments SET deleted=1, deleted_at=now(3) WHERE task_id = ANY($1) AND deleted=0", [ids]);
      return { count: r.rowCount || 0 };
    },
    async search(userId, qry, orgId) {
      // Scope to the requester (reporter OR assignee) so unified search can never
      // surface tasks the user has no access to — matches listForUser + the
      // assertTaskAccess gate used everywhere else in the module.
      const orgClause = orgId ? " AND organization_id = $3" : "";
      // Hybrid relevance (0072): ILIKE keeps the substring recall floor, OR'd
      // with word-level FULLTEXT recall; ranked by weighted MATCH (title 2x)
      // with the old recency ordering as tiebreak. Falls back to the legacy
      // query when the input has no indexable tokens.
      const bool = ftsBool(qry);
      if (!bool) {
        return (
          await q(
            `SELECT * FROM tasks WHERE deleted=0 AND status <> 'archived'${orgClause}
             AND (reporter_id=$2 OR assignee_id=$2
                  OR EXISTS (SELECT 1 FROM task_assignees ta
                              WHERE ta.task_id=tasks.id AND ta.user_id=$2))
             AND (title ILIKE $1 OR COALESCE(description,'') ILIKE $1)
             ORDER BY updated_at DESC LIMIT 20`,
            orgId ? ["%" + qry + "%", userId, orgId] : ["%" + qry + "%", userId],
          )
        ).rows.map(mapTask);
      }
      const bp = orgId ? "$4" : "$3";
      return (
        await q(
          `SELECT tasks.*,
                  (MATCH(title) AGAINST(${bp} IN BOOLEAN MODE) * 2
                 + MATCH(description) AGAINST(${bp} IN BOOLEAN MODE)) AS _rel
             FROM tasks WHERE deleted=0 AND status <> 'archived'${orgClause}
           AND (reporter_id=$2 OR assignee_id=$2
                OR EXISTS (SELECT 1 FROM task_assignees ta
                            WHERE ta.task_id=tasks.id AND ta.user_id=$2))
           AND (title ILIKE $1 OR COALESCE(description,'') ILIKE $1
                OR MATCH(title) AGAINST(${bp} IN BOOLEAN MODE)
                OR MATCH(description) AGAINST(${bp} IN BOOLEAN MODE))
           ORDER BY _rel DESC, updated_at DESC LIMIT 20`,
          orgId
            ? ["%" + qry + "%", userId, orgId, bool]
            : ["%" + qry + "%", userId, bool],
        )
      ).rows.map(mapTask);
    },
    async remove(tid, actorId) {
      // Soft-delete + child soft-cascade to comments/deps (activity is an append log).
      const by = actorId || null;
      // SUBTASK SOFT-CASCADE (#52a): collect this task's live children FIRST (before
      // we touch anything), then soft-delete each via a recursive remove() so their
      // OWN children/comments/deps/attachments cascade too. Bounded by the natural
      // tree (and the parent-cycle guard the service enforces on re-parent), so this
      // can't run away. A child re-parented to NULL by the FK never happens on this
      // SOFT path — the rows stay linked, just flagged deleted.
      const cf = orgFilter([tid]);
      const children = (
        await q(
          `SELECT id FROM tasks WHERE parent_task_id=$1 AND deleted=0${cf.clause}`,
          cf.params,
        )
      ).rows.map((r) => r.id);
      for (const cid of children) await this.remove(cid, actorId);
      const df = orgFilter([tid, by]);
      await q(`UPDATE tasks SET deleted=1, deleted_at=now(3), deleted_by=$2 WHERE id=$1${df.clause}`, df.params);
      await q("UPDATE task_comments SET deleted=1, deleted_at=now(3) WHERE task_id=$1 AND deleted=0", [tid]);
      await q("UPDATE task_deps SET deleted=1, deleted_at=now(3) WHERE (task_id=$1 OR depends_on_id=$1) AND deleted=0", [tid]);
      // Soft-delete the attachment LINKS too (the file blobs are intentionally
      // left intact in `files` — they may be shared elsewhere and are owner-managed
      // via the recycle bin; we only drop the task association).
      await q("UPDATE task_attachments SET deleted=1, deleted_at=now(3), deleted_by=$2 WHERE task_id=$1 AND deleted=0", [tid, by]);
    },
    // TASK DUE-DATE FIRING engine — mirrors reminders.claimDue EXACTLY: atomically
    // claim due, unresolved, never-notified tasks so each fires EXACTLY once, stamp
    // due_notified_at inside the same transaction (FOR UPDATE SKIP LOCKED so
    // concurrent workers never double-fire), then read them back.
    //   • due_at <= UTC_TIMESTAMP() — due_at is a UTC wall-clock DATETIME (written
    //     via the same normParam Date path as reminders.due_at), so compare against
    //     UTC_TIMESTAMP() regardless of the MySQL session timezone.
    //   • status NOT IN ('done','archived') — a resolved task never alerts.
    //   • due_notified_at IS NULL — exactly-once; the service clears it back to NULL
    //     on reschedule/reopen so a re-armed task can fire again.
    // `staleDays` (optional) skips absurdly-overdue tasks so a long-dormant backlog
    // doesn't flood on first deploy; 0/undefined = no stale cutoff.
    async claimDueTasks(limit, staleDays = 0) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const lim = Number(limit) || 50;
        const stale = Number(staleDays) || 0;
        const staleClause =
          stale > 0
            ? ` AND due_at >= (UTC_TIMESTAMP() - INTERVAL ${stale} DAY)`
            : "";
        const [picked]: any = await conn.query(
          `SELECT id FROM tasks
             WHERE deleted=0
               AND status NOT IN ('done','archived')
               AND due_notified_at IS NULL
               AND due_at IS NOT NULL AND due_at <= UTC_TIMESTAMP()${staleClause}
             ORDER BY due_at ASC
             LIMIT ${lim}
             FOR UPDATE SKIP LOCKED`,
          [],
        );
        const ids = picked.map((r) => r.id);
        if (!ids.length) {
          await conn.commit();
          return [];
        }
        await conn.query(
          `UPDATE tasks SET due_notified_at=now(3) WHERE id IN (?)`,
          [ids],
        );
        const [rows]: any = await conn.query(
          `SELECT * FROM tasks WHERE id IN (?)`,
          [ids],
        );
        await conn.commit();
        return rows.map(mapTask);
      } catch (e) {
        try {
          await conn.rollback();
        } catch {
          /* ignore */
        }
        throw e;
      } finally {
        conn.release();
      }
    },
    // ---- MULTIPLE ASSIGNEES (join table; assignee_id kept as primary) --------
    // The set of user ids assigned to a task, oldest-assigned first (so [0] is
    // the "primary" that tasks.assignee_id mirrors). Order is stable by
    // assigned_at then user_id for a deterministic primary.
    async assignees(taskId) {
      return (
        await q(
          `SELECT user_id FROM task_assignees WHERE task_id=$1 ORDER BY assigned_at ASC, user_id ASC`,
          [taskId],
        )
      ).rows.map((r) => r.user_id);
    },
    // Batch variant for serializeTaskList: all assignees for many tasks in ONE
    // query → { taskId: [userId, ...] } (preserving the primary-first order).
    async assigneesFor(taskIds) {
      const ids = (taskIds || []).filter(Boolean);
      if (!ids.length) return {};
      const rows = (
        await q(
          `SELECT task_id, user_id FROM task_assignees
             WHERE task_id = ANY($1) ORDER BY assigned_at ASC, user_id ASC`,
          [ids],
        )
      ).rows;
      const out: Record<string, string[]> = {};
      for (const r of rows) (out[r.task_id] ||= []).push(r.user_id);
      return out;
    },
    // True if `userId` is one of the task's assignees (index-backed point read).
    async isAssignee(taskId, userId) {
      const r = await q(
        "SELECT 1 FROM task_assignees WHERE task_id=$1 AND user_id=$2 LIMIT 1",
        [taskId, userId],
      );
      return r.rows.length > 0;
    },
    // Add one assignee (idempotent on the PK) and keep tasks.assignee_id pointing
    // at the PRIMARY (oldest) assignee so every legacy single-id reader stays
    // consistent. Bumps version so a concurrent editor reconciles. Returns the
    // resulting assignee id list (primary-first).
    async addAssignee(taskId, userId, assignedBy = null) {
      // Organizations: inherit the parent task's tenant (denormalized org child) —
      // the mutation paths must stamp org just like tasks.create's children do.
      await q(
        `INSERT INTO task_assignees (task_id,user_id,assigned_by,organization_id)
           VALUES ($1,$2,$3,(SELECT organization_id FROM tasks WHERE id=$1))
         ON DUPLICATE KEY UPDATE assigned_by=COALESCE(task_assignees.assigned_by, VALUES(assigned_by))`,
        [taskId, userId, assignedBy],
      );
      await this.syncPrimaryAssignee(taskId);
      return this.assignees(taskId);
    },
    // Remove one assignee, then re-point the primary at the new oldest (or NULL).
    async removeAssignee(taskId, userId) {
      await q("DELETE FROM task_assignees WHERE task_id=$1 AND user_id=$2", [
        taskId,
        userId,
      ]);
      await this.syncPrimaryAssignee(taskId);
      return this.assignees(taskId);
    },
    // Replace the entire assignee set with `userIds` (dedup, order-preserving),
    // then re-point the primary. Used by the "set assignees" service op.
    async setAssignees(taskId, userIds, assignedBy = null) {
      const wanted = [...new Set((userIds || []).filter(Boolean))];
      const current = await this.assignees(taskId);
      const cur = new Set(current);
      const next = new Set(wanted);
      for (const uid of current)
        if (!next.has(uid))
          await q("DELETE FROM task_assignees WHERE task_id=$1 AND user_id=$2", [
            taskId,
            uid,
          ]);
      for (const uid of wanted)
        if (!cur.has(uid))
          await q(
            `INSERT INTO task_assignees (task_id,user_id,assigned_by,organization_id)
               VALUES ($1,$2,$3,(SELECT organization_id FROM tasks WHERE id=$1))
             ON DUPLICATE KEY UPDATE assigned_by=COALESCE(task_assignees.assigned_by, VALUES(assigned_by))`,
            [taskId, uid, assignedBy],
          );
      await this.syncPrimaryAssignee(taskId);
      return this.assignees(taskId);
    },
    // Keep tasks.assignee_id == the PRIMARY (oldest) assignee, or NULL when none.
    // Bumps version (a guarded concurrent PATCH then reconciles) but does NOT
    // touch due_notified_at (reassignment isn't a reschedule/reopen).
    async syncPrimaryAssignee(taskId) {
      const list = await this.assignees(taskId);
      const primary = list[0] || null;
      const u = orgFilter([taskId, primary]);
      await q(
        `UPDATE tasks SET assignee_id=$2, updated_at=now(), version=version+1 WHERE id=$1 AND deleted=0${u.clause}`,
        u.params,
      );
      return primary;
    },
    // ---- WATCHERS ------------------------------------------------------------
    async watchers(taskId) {
      return (
        await q(
          `SELECT user_id FROM task_watchers WHERE task_id=$1 ORDER BY created_at ASC`,
          [taskId],
        )
      ).rows.map((r) => r.user_id);
    },
    // Batch variant for serializeTaskList: all watchers for many tasks in ONE
    // query → { taskId: [userId, ...] }.
    async watchersFor(taskIds) {
      const ids = (taskIds || []).filter(Boolean);
      if (!ids.length) return {};
      const rows = (
        await q(
          `SELECT task_id, user_id FROM task_watchers
             WHERE task_id = ANY($1) ORDER BY created_at ASC`,
          [ids],
        )
      ).rows;
      const out: Record<string, string[]> = {};
      for (const r of rows) (out[r.task_id] ||= []).push(r.user_id);
      return out;
    },
    async isWatcher(taskId, userId) {
      const r = await q(
        "SELECT 1 FROM task_watchers WHERE task_id=$1 AND user_id=$2 LIMIT 1",
        [taskId, userId],
      );
      return r.rows.length > 0;
    },
    // Add a watcher (idempotent). A no-op if userId is falsy.
    async addWatcher(taskId, userId) {
      if (!userId) return;
      // Organizations: inherit the parent task's tenant (denormalized org child).
      await q(
        `INSERT IGNORE INTO task_watchers (task_id,user_id,organization_id)
           VALUES ($1,$2,(SELECT organization_id FROM tasks WHERE id=$1))`,
        [taskId, userId],
      );
    },
    async removeWatcher(taskId, userId) {
      await q("DELETE FROM task_watchers WHERE task_id=$1 AND user_id=$2", [
        taskId,
        userId,
      ]);
      return { taskId, userId, removed: true };
    },
    // ---- ATTACHMENTS (feature #51) -------------------------------------------
    // A task<->file LINK. The blob already lives in `files` (uploaded via the
    // Files streaming pipeline); this only records the association. Idempotent:
    // re-linking the same file un-deletes a previously-detached row (so a detach
    // followed by re-attach revives the link instead of a PK collision).
    async addAttachment(taskId, fileId, attachedBy) {
      await q(
        `INSERT INTO task_attachments (task_id,file_id,attached_by) VALUES ($1,$2,$3) AS new
         ON DUPLICATE KEY UPDATE deleted=0, deleted_at=NULL, deleted_by=NULL,
           attached_by=COALESCE(new.attached_by, task_attachments.attached_by),
           attached_at=now(3)`,
        [taskId, fileId, attachedBy || null],
      );
      return { taskId, fileId };
    },
    // Soft-detach a single link (the file blob itself is removed separately by the
    // service via fileService, which soft-deletes it into the recycle bin).
    async removeAttachment(taskId, fileId, actorId) {
      const r = await q(
        "UPDATE task_attachments SET deleted=1, deleted_at=now(3), deleted_by=$3 WHERE task_id=$1 AND file_id=$2 AND deleted=0",
        [taskId, fileId, actorId || null],
      );
      return { taskId, fileId, removed: (r.rowCount || 0) > 0 };
    },
    // Live attachments for a task, newest-first, joined to the (live) file row so
    // the caller gets the file summary (name/mime/size/uploader) in one query.
    // A file that was itself soft-deleted (deleted=1 on files) drops out via the
    // JOIN's deleted=0 guard, so a recycled file never shows as a live attachment.
    async attachments(taskId) {
      return (
        await q(
          `SELECT f.id, f.name, f.mime, f.size, f.uploader_id, f.created_at, f.storage_key, f.storage_backend,
                  ta.attached_by, ta.attached_at
             FROM task_attachments ta
             JOIN files f ON f.id = ta.file_id AND f.deleted = 0
            WHERE ta.task_id = $1 AND ta.deleted = 0
            ORDER BY ta.attached_at DESC`,
          [taskId],
        )
      ).rows.map((r) => ({
        id: r.id,
        name: r.name,
        mime: r.mime || null,
        size: Number(r.size) || 0,
        uploaderId: r.uploader_id || null,
        createdAt: r.created_at,
        attachedBy: r.attached_by || null,
        attachedAt: r.attached_at,
      }));
    },
    // Batch variant for serializeTaskList: live attachments for many tasks in ONE
    // query → { taskId: [ {id,name,mime,size,...}, ... ] }. Mirrors assigneesFor/
    // watchersFor so a full board page costs one attachments query, not one per task.
    async attachmentsFor(taskIds) {
      const ids = (taskIds || []).filter(Boolean);
      if (!ids.length) return {};
      const rows = (
        await q(
          `SELECT ta.task_id, f.id, f.name, f.mime, f.size, f.uploader_id, f.created_at,
                  ta.attached_by, ta.attached_at
             FROM task_attachments ta
             JOIN files f ON f.id = ta.file_id AND f.deleted = 0
            WHERE ta.task_id = ANY($1) AND ta.deleted = 0
            ORDER BY ta.attached_at DESC`,
          [ids],
        )
      ).rows;
      const out: Record<string, any[]> = {};
      for (const r of rows)
        (out[r.task_id] ||= []).push({
          id: r.id,
          name: r.name,
          mime: r.mime || null,
          size: Number(r.size) || 0,
          uploaderId: r.uploader_id || null,
          createdAt: r.created_at,
          attachedBy: r.attached_by || null,
          attachedAt: r.attached_at,
        });
      return out;
    },
    // Is this file currently attached (live) to this task? Used to scope detach
    // authz to a link that actually exists, and to guard the file soft-delete.
    async hasAttachment(taskId, fileId) {
      const r = await q(
        "SELECT 1 FROM task_attachments WHERE task_id=$1 AND file_id=$2 AND deleted=0 LIMIT 1",
        [taskId, fileId],
      );
      return r.rows.length > 0;
    },
    // ---- SUBTASKS / PROGRESS (feature #52a) ----------------------------------
    // The live child subtasks of a parent, oldest-first (so the detail panel lists
    // them in creation order). Each is an ordinary task row (mapTask).
    async subtasks(parentId) {
      const { clause, params } = orgFilter([parentId]);
      return (
        await q(
          `SELECT * FROM tasks WHERE parent_task_id=$1 AND deleted=0${clause} ORDER BY created_at ASC, id ASC`,
          params,
        )
      ).rows.map(mapTask);
    },
    // Batch progress for serializeTaskList: for many PARENT ids, ONE query returns
    // { parentId: { total, done } } counting their live children (done = a child in
    // a DONE status). Avoids the N+1 of a per-task children read on a board page.
    // `DONE` is parameterized to the service's completion statuses so the count
    // agrees with the board's notion of "done".
    async subtaskProgressFor(parentIds, doneStatuses = ["done"]) {
      const ids = (parentIds || []).filter(Boolean);
      if (!ids.length) return {};
      const done = (doneStatuses || []).filter(Boolean);
      const of = orgFilter([ids, done.length ? done : ["done"]]);
      const rows = (
        await q(
          `SELECT parent_task_id AS pid,
                  COUNT(*) AS total,
                  SUM(CASE WHEN status = ANY($2) THEN 1 ELSE 0 END) AS done
             FROM tasks
            WHERE parent_task_id = ANY($1) AND deleted=0${of.clause}
            GROUP BY parent_task_id`,
          of.params,
        )
      ).rows;
      const out: Record<string, { total: number; done: number }> = {};
      for (const r of rows)
        out[r.pid] = {
          total: Number(r.total) || 0,
          done: Number(r.done ?? r.DONE) || 0,
        };
      return out;
    },
    // True if `candidateAncestorId` is `taskId` or one of its ANCESTORS — used by
    // the service to reject re-parenting a task UNDER its own descendant (a subtask
    // cycle), the subtask analogue of the dependency cycle guard. Walks parent
    // links upward from candidateAncestorId; if we reach taskId the edge would
    // close a loop. Bounded by a visited-set + a hard depth cap.
    async isAncestorOf(taskId, candidateAncestorId) {
      if (!candidateAncestorId) return false;
      if (taskId === candidateAncestorId) return true;
      const visited = new Set<string>();
      let cur = candidateAncestorId;
      let budget = 5000;
      while (cur && budget-- > 0) {
        if (visited.has(cur)) break;
        visited.add(cur);
        const af = orgFilter([cur]);
        const r = (
          await q(`SELECT parent_task_id FROM tasks WHERE id=$1 AND deleted=0${af.clause}`, af.params)
        ).rows[0];
        const parent = r && r.parent_task_id;
        if (!parent) return false;
        if (parent === taskId) return true;
        cur = parent;
      }
      return false;
    },
    // ATOMIC double-spawn guard for a recurring task's NEXT occurrence — the task
    // twin of reminders.spawnNextOccurrence. A double-complete or a fire/complete
    // race must NOT create two next occurrences. We SERIALIZE the existence-check +
    // insert with a MySQL named advisory lock (GET_LOCK) keyed by the stable series
    // identity (the source task id + the next due instant), so no schema UNIQUE
    // index is required (live done/deleted rows can legitimately share a due_at).
    // The first holder checks-and-inserts; a racing second waiter re-checks under
    // the lock, sees the committed occurrence, and returns null. Connection-scoped,
    // released in finally. Fail-open-ish: a lock that can't be acquired falls back
    // to the plain check+insert (never worse than the old non-atomic path).
    //
    // `seriesId` is the ORIGINAL recurring task's id (every spawned occurrence
    // carries it via recurrence_series_id-in-spirit; here we key the dedupe on the
    // source task id passed by the caller + the next due). The new row copies the
    // source's title/description/priority/recurrence and the assignee/watcher sets
    // are re-applied by the service after insert.
    async spawnNextOccurrence({
      sourceTaskId,
      title,
      description = null,
      priority = "Medium",
      recurrence = "none",
      dueAt = null,
      dueLabel = null,
      project = null,
      projectId = null,
      reporterId = null,
      assigneeId = null,
    }) {
      const conn = await pool.getConnection();
      const cq = async (t: string, p: any[] = []) => {
        const bound = bind(translate(t), p || []);
        const [res]: any = await conn.query(bound.text, bound.params.map(normParam));
        if (Array.isArray(res)) return { rows: res, rowCount: res.length };
        return { rows: [], rowCount: (res && res.affectedRows) || 0 };
      };
      const lockKey = createHash("sha1")
        .update([sourceTaskId || "", recurrence, dueAt || "", title || ""].join("|"))
        .digest("hex");
      const lockName = `task_spawn_${lockKey}`;
      let locked = false;
      try {
        try {
          const lr: any = await cq("SELECT GET_LOCK($1, 5) AS ok", [lockName]);
          locked = !!(lr.rows[0] && Number(lr.rows[0].ok) === 1);
        } catch (_) {
          locked = false;
        }
        // An equivalent LIVE (not done/archived/deleted) occurrence already spawned
        // for this series at this next due instant? Then this is a duplicate spawn.
        // Compare due_at DIRECTLY (DATETIME=DATETIME via the normParam Date bind,
        // exactly like reminders.spawnNextOccurrence) — NOT via COALESCE-to-string,
        // which would force a TZ-sensitive string coercion and miss the match. The
        // null-safe operator <=> handles reporter_id being NULL.
        // Organizations: the spawn runs in the completing user's request (ambient org =
        // the source task's tenant). Stamp it on the new occurrence + scope the dedup so
        // two tenants' identical series can never cross-match.
        const orgId = currentOrgId();
        const exists = await cq(
          `SELECT id FROM tasks
             WHERE deleted=0
               AND status NOT IN ('done','archived')
               AND title=$1
               AND recurrence=$2
               AND reporter_id <=> $3
               AND due_at = $4
               AND organization_id <=> $5
             LIMIT 1`,
          [title, recurrence, reporterId, dueAt, orgId],
        );
        if (exists.rows.length > 0) return null;
        const id = genId();
        await cq(
          `INSERT INTO tasks (id,title,status,priority,due_label,assignee_id,description,labels,due_at,reporter_id,project,project_id,recurrence,parent_task_id,organization_id)
             VALUES ($1,$2,'todo',$3,$4,$5,$6,'[]',$7,$8,$9,$10,$11,NULL,$12)`,
          [id, title, priority, dueLabel, assigneeId, description, dueAt, reporterId, project, projectId, recurrence, orgId],
        );
        const r = (await cq("SELECT * FROM tasks WHERE id=$1", [id])).rows[0];
        return mapTask(r);
      } finally {
        if (locked) {
          try { await conn.query("SELECT RELEASE_LOCK(?)", [lockName]); } catch (_) {}
        }
        conn.release();
      }
    },
    // FULL accessible task set for CSV export (feature #52a): every live task the
    // user can access (reporter OR ANY assignee), newest-first, NO pagination — the
    // export spans the whole set, not a page. Mirrors listForUser's authz predicate
    // exactly so a user can only ever export their OWN accessible tasks (no IDOR).
    // A hard cap bounds a pathological account; the route streams the rows out.
    async listAllForUser(userId, { limit = 100000 } = {}) {
      const lim = Math.max(1, Math.min(Number(limit) || 100000, 100000));
      const of = orgFilter([userId], "tasks.organization_id");
      of.params.push(lim);
      return (
        await q(
          `SELECT * FROM tasks
           WHERE (reporter_id=$1 OR assignee_id=$1
                  OR EXISTS (SELECT 1 FROM task_assignees ta
                              WHERE ta.task_id=tasks.id AND ta.user_id=$1))
             AND deleted=0${of.clause}
           ORDER BY created_at DESC, id DESC
           LIMIT $${of.params.length}`,
          of.params,
        )
      ).rows.map(mapTask);
    },
    // ONE keyset PAGE of the export set (feature #52a) — same authz predicate +
    // (created_at DESC, id DESC) ordering as listForUser/listAllForUser, but page-
    // sized so exportCsv can STREAM the whole accessible set out a page at a time
    // (memory stays O(page), not O(account)). The `cursor` is the previous page's
    // last (createdAt, id); fetch limit+1 to learn if another page exists in one
    // round-trip, then trim. Pure read; no IDOR (user-scoped predicate is inherent).
    async listForUserPage(userId, { limit = 1000, cursor = null }: any = {}) {
      const lim = Math.max(1, Math.min(Number(limit) || 1000, 5000));
      const params: any[] = [userId];
      let keyset = "";
      if (cursor && cursor.createdAt && cursor.id) {
        params.push(cursor.createdAt, cursor.createdAt, cursor.id);
        keyset =
          ` AND (created_at < $${params.length - 2}` +
          ` OR (created_at = $${params.length - 1} AND id < $${params.length}))`;
      }
      const of = orgFilter(params, "tasks.organization_id");
      of.params.push(lim + 1);
      const rows = (
        await q(
          `SELECT * FROM tasks
           WHERE (reporter_id=$1 OR assignee_id=$1
                  OR EXISTS (SELECT 1 FROM task_assignees ta
                              WHERE ta.task_id=tasks.id AND ta.user_id=$1))
             AND deleted=0${keyset}${of.clause}
           ORDER BY created_at DESC, id DESC
           LIMIT $${of.params.length}`,
          of.params,
        )
      ).rows.map(mapTask);
      const hasMore = rows.length > lim;
      const page = hasMore ? rows.slice(0, lim) : rows;
      const last = page[page.length - 1];
      const nextCursor =
        hasMore && last ? { createdAt: last.createdAt, id: last.id } : null;
      return { tasks: page, hasMore, nextCursor };
    },
    // PROJECTS-AS-ENTITIES (#52b): batched project lookup for serializeTaskList —
    // resolve {id,name,color} for many task project_ids in ONE query (no N+1),
    // returning { projectId: {id,name,color} }. A soft-deleted project resolves to
    // undefined so the task serializes as unfiled. Mirrors assigneesFor/etc.
    async projectsForIds(projectIds) {
      const ids = [...new Set((projectIds || []).filter(Boolean))];
      if (!ids.length) return {};
      const of = orgFilter([ids]);
      const rows = (
        await q(
          `SELECT id, name, color FROM task_projects WHERE id = ANY($1) AND deleted=0${of.clause}`,
          of.params,
        )
      ).rows;
      const out: Record<string, any> = {};
      for (const r of rows) out[r.id] = { id: r.id, name: r.name, color: r.color };
      return out;
    },
    // Keep the legacy free-text `project` consistent with a project rename. Scoped
    // by project_id ALONE: project_id already uniquely implies the owner (it is a
    // VARCHAR(36) PK), so we don't also narrow by reporter_id. That narrowing would
    // miss any task whose reporter differs from the project owner (e.g. legacy
    // back-filled rows, or a task filed before the actor→reporter fix landed),
    // leaving its legacy `project` text frozen at the OLD name while the live
    // projectObj.name shows the NEW one. ownerId is retained in the signature for
    // call-site compatibility but is intentionally not part of the predicate.
    // Best-effort text mirror; the canonical link is project_id.
    async bulkSetProjectText(projectId, _ownerId, name) {
      const of = orgFilter([projectId, name]);
      await q(
        `UPDATE tasks SET project=$2 WHERE project_id=$1 AND deleted=0${of.clause}`,
        of.params,
      );
    },
  };
  // PROJECTS-AS-ENTITIES (#52b). Owner-scoped task projects, MIRRORING the reminder
  // `folders` repo CRUD shape. Every read/mutation is scoped by owner_id, so a
  // caller can only ever touch their OWN projects (no IDOR). Soft-delete un-files
  // the project's tasks (project_id=NULL), exactly like folders.delete un-files
  // reminders — the tasks themselves are kept.
  const taskProjects = {
    async create({ ownerId, name, color }) {
      const id = genId();
      // Organizations: stamp the owner's active tenant (create is in-request).
      const orgId = currentOrgId();
      await q(
        `INSERT INTO task_projects (id,owner_id,name,color,organization_id) VALUES ($1,$2,$3,$4,$5)`,
        [id, ownerId, name, color || "#64748b", orgId],
      );
      const r = (await q("SELECT * FROM task_projects WHERE id=$1", [id])).rows[0];
      return mapProject(r);
    },
    // Scoped by owner_id: a non-owner's update matches 0 rows → returns null.
    async update(pid, ownerId, { name, color, archived }: any) {
      const u = orgFilter([pid, ownerId, name ?? null, color ?? null, archived == null ? null : archived ? 1 : 0]);
      await q(
        `UPDATE task_projects
            SET name=COALESCE($3,name),
                color=COALESCE($4,color),
                archived=COALESCE($5,archived)
          WHERE id=$1 AND owner_id=$2 AND deleted=0${u.clause}`,
        u.params,
      );
      return this.getForUser(pid, ownerId); // org-scoped
    },
    async listForUser(ownerId) {
      const { clause, params } = orgFilter([ownerId]);
      return (
        await q(
          `SELECT * FROM task_projects WHERE owner_id=$1 AND deleted=0${clause} ORDER BY archived ASC, created_at ASC`,
          params,
        )
      ).rows.map(mapProject);
    },
    // The single project IF it belongs to the caller (else null) — the authz check
    // the service uses to reject linking a task to a project you can't see (IDOR).
    async getForUser(pid, ownerId) {
      const { clause, params } = orgFilter([pid, ownerId]);
      const r = (
        await q(`SELECT * FROM task_projects WHERE id=$1 AND owner_id=$2 AND deleted=0${clause}`, params)
      ).rows[0];
      return r ? mapProject(r) : null;
    },
    async delete(pid, ownerId) {
      // Soft-delete + un-file: the project's tasks keep existing, just lose the
      // link (mirrors folders.delete → reminders.folder_id=NULL). Scoped by owner.
      // The soft-delete itself stays owner-scoped (id+owner_id) — only the owner
      // may delete their project (IDOR guard).
      const d = orgFilter([pid, ownerId]);
      const res = (
        await q(
          `UPDATE task_projects SET deleted=1, deleted_at=now(3), deleted_by=$2 WHERE id=$1 AND owner_id=$2 AND deleted=0${d.clause}`,
          d.params,
        )
      ).rowCount;
      // Only un-file once we actually deleted the project (a non-owner call matched
      // 0 rows above → don't touch any tasks). Then un-file by project_id ALONE:
      // project_id implies the owner, so narrowing by reporter_id would strand any
      // task whose reporter differs from the project owner (legacy back-filled rows
      // or pre-fix filings), leaving a dangling project_id pointing at a now-deleted
      // project. Scoping by project_id un-files every task that referenced it.
      if (res) {
        const un = orgFilter([pid]);
        await q(
          `UPDATE tasks SET project_id=NULL, project=NULL WHERE project_id=$1 AND deleted=0${un.clause}`,
          un.params,
        );
      }
      return { id: pid, deleted: true };
    },
  };
  // SAVED VIEWS / SWIMLANES (#52b). User-scoped: every read/mutation is gated by
  // user_id so a user only ever sees/edits their OWN views (no IDOR). `filter` is
  // stored as JSON the SERVICE validates before persisting (never eval'd here).
  const taskSavedViews = {
    async create({ userId, name, filter, groupBy, sort }) {
      const id = genId();
      await q(
        `INSERT INTO task_saved_views (id,user_id,name,filter,group_by,sort)
           VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, userId, name, JSON.stringify(filter || {}), groupBy || "none", sort || "created"],
      );
      const r = (await q("SELECT * FROM task_saved_views WHERE id=$1", [id])).rows[0];
      return mapSavedView(r);
    },
    async update(vid, userId, { name, filter, groupBy, sort }: any) {
      const sets: string[] = [];
      const vals: any[] = [vid, userId];
      const add = (col, val) => {
        vals.push(val);
        sets.push(`${col}=$${vals.length}`);
      };
      if (name !== undefined) add("name", name);
      if (filter !== undefined) add("filter", JSON.stringify(filter || {}));
      if (groupBy !== undefined) add("group_by", groupBy || "none");
      if (sort !== undefined) add("sort", sort || "created");
      if (!sets.length) return this.getForUser(vid, userId);
      sets.push("updated_at=now()");
      await q(
        `UPDATE task_saved_views SET ${sets.join(", ")} WHERE id=$1 AND user_id=$2 AND deleted=0`,
        vals,
      );
      return this.getForUser(vid, userId);
    },
    async listForUser(userId) {
      return (
        await q(
          "SELECT * FROM task_saved_views WHERE user_id=$1 AND deleted=0 ORDER BY created_at ASC",
          [userId],
        )
      ).rows.map(mapSavedView);
    },
    async getForUser(vid, userId) {
      const r = (
        await q("SELECT * FROM task_saved_views WHERE id=$1 AND user_id=$2 AND deleted=0", [vid, userId])
      ).rows[0];
      return r ? mapSavedView(r) : null;
    },
    async delete(vid, userId) {
      await q(
        "UPDATE task_saved_views SET deleted=1, deleted_at=now(3), deleted_by=$2 WHERE id=$1 AND user_id=$2 AND deleted=0",
        [vid, userId],
      );
      return { id: vid, deleted: true };
    },
  };
  const calls = {
    async create({
      conversationId = null,
      initiatorId,
      peerId = null,
      kind = "audio",
      direction = "out",
      status = "ringing",
    }) {
      const id = genId();
      const orgId = currentOrgId();
      await q(
        `INSERT INTO calls (id,conversation_id,initiator_id,peer_id,kind,direction,status,organization_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, conversationId, initiatorId, peerId, kind, direction, status, orgId],
      );
      const r = (
        await q(
          `SELECT * FROM calls WHERE id=$1${orgId ? " AND organization_id=$2" : ""}`,
          orgId ? [id, orgId] : [id],
        )
      ).rows[0];
      return mapCall(r);
    },
    // Atomic call-request: lock the participants' active-call rows FOR UPDATE,
    // re-check busy state UNDER the lock, then insert — so two concurrent callers
    // to the same peer serialize here and a glare race can't double-ring. Mirrors
    // claimDue's transaction pattern. Returns a created call (status 'ringing' on
    // success, 'busy' if the peer is engaged); throws {status:409} if the
    // INITIATOR is already on a call (matches prior service semantics).
    async requestAtomic({ conversationId = null, initiatorId, peerId, kind = "audio" }) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const [active]: any = await conn.query(
          `SELECT initiator_id, peer_id FROM calls
             WHERE (initiator_id=? OR peer_id=? OR initiator_id=? OR peer_id=?)
               AND status IN ('ringing','connected')
             FOR UPDATE`,
          [initiatorId, initiatorId, peerId, peerId],
        );
        const busyFor = (u) => active.some((r) => r.initiator_id === u || r.peer_id === u);
        if (busyFor(initiatorId)) {
          const e: any = new Error("You are already on a call.");
          e.status = 409;
          throw e;
        }
        const status = busyFor(peerId) ? "busy" : "ringing";
        const id = genId();
        // Organizations: stamp the initiator's active tenant on the call (its org).
        // The FOR UPDATE busy-check above stays UNSCOPED — glare/busy must be detected
        // across every context.
        const orgId = currentOrgId();
        await conn.query(
          `INSERT INTO calls (id,conversation_id,initiator_id,peer_id,kind,direction,status,organization_id)
             VALUES (?,?,?,?,?,?,?,?)`,
          [id, conversationId, initiatorId, peerId, kind, "out", status, orgId],
        );
        const [rows]: any = await conn.query("SELECT * FROM calls WHERE id=?", [id]);
        await conn.commit();
        return mapCall(rows[0]);
      } catch (e) {
        try { await conn.rollback(); } catch { /* ignore */ }
        throw e;
      } finally {
        conn.release();
      }
    },
    async end(cid, { status = "ended", durationSec = 0 } = {}) {
      await q("UPDATE calls SET status=$2, duration_sec=$3 WHERE id=$1", [
        cid,
        status,
        durationSec,
      ]);
      const r = (await q("SELECT * FROM calls WHERE id=$1", [cid])).rows[0];
      return r ? mapCall(r) : null;
    },
    async getById(cid) {
      // NOT org-scoped: a call spans two users whose active org can differ (a 1:1 /
      // cross-org connection). Access is gated by the participant check in the token
      // flow — an org filter here would 404 a legitimate participant. The row still
      // carries its org (stamped at create) for list/analytics scoping.
      const r = (await q("SELECT * FROM calls WHERE id=$1", [cid])).rows[0];
      return r ? mapCall(r) : null;
    },
    async setStatus(cid, status, durationSec = null) {
      await q(
        "UPDATE calls SET status=$2, duration_sec=COALESCE($3,duration_sec) WHERE id=$1",
        [cid, status, durationSec],
      );
      const r = (await q("SELECT * FROM calls WHERE id=$1", [cid])).rows[0];
      return r ? mapCall(r) : null;
    },
    // Guarded transition in ONE write: status moves from `from` to `to` only if
    // the row is still in `from` and (optionally) the acting user holds the
    // given role. Returns the updated call, or null when nothing matched — the
    // caller then reads the row once to say WHY (404/403/409). Collapses the
    // accept hot path (read + write + read) to write + read and makes two
    // concurrent accepts serialise on the row instead of both "winning".
    async transitionIf(cid, { from, to, peerId = null, initiatorId = null, durationSec = null }) {
      const froms = Array.isArray(from) ? from : [from];
      const params: any[] = [cid, to, durationSec, ...froms];
      let sql = `UPDATE calls SET status=$2, duration_sec=COALESCE($3,duration_sec) WHERE id=$1 AND status IN (${froms.map((_, i) => `$${i + 4}`).join(",")})`;
      if (peerId) { params.push(peerId); sql += ` AND peer_id=$${params.length}`; }
      if (initiatorId) { params.push(initiatorId); sql += ` AND initiator_id=$${params.length}`; }
      const r = await q(sql, params);
      if (!r.rowCount) return null;
      const row = (await q("SELECT * FROM calls WHERE id=$1", [cid])).rows[0];
      return row ? mapCall(row) : null;
    },
    async listForUser(userId, before, limit) {
      // ORG-SCOPED: the call log (and the dashboard's "Missed calls" tile it
      // feeds) previously carried every org the caller had ever been in, so a
      // new organization opened with the previous org's call history.
      const scope = orgFilterOrNull([userId, before || null, limit || 50]);
      return (
        await q(
          `SELECT * FROM calls WHERE (initiator_id=$1 OR peer_id=$1)
             AND ($2 IS NULL OR started_at < $2)${scope.clause}
           ORDER BY started_at DESC LIMIT $3`,
          scope.params,
        )
      ).rows.map(mapCall);
    },
    async hasActiveCall(userId) {
      const r = (
        await q(
          `SELECT 1 FROM calls WHERE (initiator_id=$1 OR peer_id=$1)
           AND status IN ('ringing','connected') LIMIT 1`,
          [userId],
        )
      ).rows[0];
      return !!r;
    },
    async listActiveForUser(userId) {
      return (
        await q(
          `SELECT * FROM calls WHERE (initiator_id=$1 OR peer_id=$1)
           AND status IN ('ringing','connected')`,
          [userId],
        )
      ).rows.map(mapCall);
    },
    async findStaleRinging(olderThanMs) {
      return (
        await q(
          `SELECT * FROM calls WHERE status='ringing'
           AND started_at < DATE_SUB(NOW(), INTERVAL $1 SECOND)`,
          [Math.floor(olderThanMs / 1000)],
        )
      ).rows.map(mapCall);
    },
  };
  const settings = {
    async get(userId) {
      const r = (
        await q("SELECT data FROM user_settings WHERE user_id=$1", [userId])
      ).rows[0];
      return r ? r.data : null;
    },
    async set(userId, data) {
      await q(
        `INSERT INTO user_settings (user_id,data) VALUES ($1,$2) AS new
           ON DUPLICATE KEY UPDATE data = JSON_MERGE_PATCH(user_settings.data, new.data), updated_at=now()`,
        [userId, JSON.stringify(data)],
      );
      const r = (
        await q("SELECT data FROM user_settings WHERE user_id=$1", [userId])
      ).rows[0];
      return r ? r.data : null;
    },
  };
  const files = {
    async create(f) {
      const id = f.id || genId();
      // Organizations: derive the tenant from the parent conversation when present
      // (authoritative), falling back to the uploader's active org for personal
      // files. getMeta/reads stay UNSCOPED (public share-token links can be opened
      // cross-org/anonymously — access is gated by _accessibleWhere + the token,
      // not org); the create-stamp just gives the row a correct org for analytics.
      const orgId = currentOrgId();
      await q(
        `INSERT INTO files (id,conversation_id,uploader_id,name,mime,size,data,storage_key,storage_backend,encryption_version,ciphertext_meta,organization_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,COALESCE((SELECT organization_id FROM conversations WHERE id=$2),$12))`,
        [
          id,
          f.conversationId || null,
          f.uploaderId || null,
          f.name,
          f.mime || null,
          f.size || 0,
          f.storageKey ? null : f.data,
          f.storageKey || null,
          // Tier that holds the bytes (0127). Callers pass it explicitly; a
          // storage_key without a backend is treated as S3 (legacy behaviour),
          // no storage_key means the LONGBLOB.
          f.storageBackend || (f.storageKey ? "s3" : "db"),
          f.encryptionVersion || 0,
          f.ciphertextMeta ? JSON.stringify(f.ciphertextMeta) : null,
          orgId,
        ],
      );
      const r = (
        await q(
          `SELECT id,conversation_id,uploader_id,name,mime,size,created_at,starred,storage_key,storage_backend,encryption_version,ciphertext_meta FROM files WHERE id=$1 AND deleted=0`,
          [id],
        )
      ).rows[0];
      return mapFile(r);
    },
    // Call-chat porting: adopt an ORPHAN file (uploaded mid-call, when no
    // conversation exists yet — e.g. a call recording) into the ended call's
    // temp group, so the conversation-membership grant in permissionFor lets
    // every member play/download it instead of 404ing for everyone but the
    // uploader. Guards live in the SQL: never re-links a file that already
    // belongs to a conversation, and only adopts when the file's uploader is
    // a member of the adopting conversation (no third-party file grabbing).
    async adoptIntoConversation(fileId, conversationId) {
      await q(
        `UPDATE files SET conversation_id=$2
          WHERE id=$1 AND deleted=0 AND conversation_id IS NULL
            AND uploader_id IN (SELECT user_id FROM conversation_members
                                 WHERE conversation_id=$2 AND deleted=0)`,
        [fileId, conversationId],
      );
    },
    // Accessible-files predicate, shared by every files read path: owned, shared
    // directly with the user, or shared to a conversation the user belongs to.
    // `$1` is the viewer id. Returned as a SQL fragment + the leading param so
    // pagination/count/index reads all use the SAME authorization scope.
    _accessibleWhere() {
      return `deleted=0 AND (uploader_id=$1
              OR id IN (SELECT file_id FROM file_shares WHERE subject_type='user' AND subject_id=$1 AND deleted=0)
              OR id IN (
                   SELECT s.file_id FROM file_shares s
                   JOIN conversation_members cm
                     ON cm.conversation_id = s.subject_id AND cm.user_id = $1 AND cm.deleted=0
                   WHERE s.subject_type='conversation' AND s.deleted=0
                 ))`;
    },
    // Per-tab filter fragment. `tab` paginates WITHIN the tab so the page slice
    // and the count agree per tab. Tabs mirror the FilesView surfaces:
    //   owned  → files the user uploaded
    //   shared → accessible files the user did NOT upload (came via a share)
    //   starred→ accessible files the user has starred
    //   all/undefined → the full accessible set
    _tabFilter(tab) {
      switch (tab) {
        case "owned":
          return " AND uploader_id=$1";
        case "shared":
          return " AND uploader_id<>$1";
        case "starred":
          // Per-user favorites (0114): YOUR stars, not the uploader's global flag.
          return " AND EXISTS (SELECT 1 FROM file_stars fs WHERE fs.file_id=files.id AND fs.user_id=$1)";
        default:
          return "";
      }
    },
    // SERVER-SIDE SEARCH (P0-F): a name/type LIKE filter WITHIN the tab so search
    // spans ALL the user's files, not just the loaded page (otherwise pagination
    // makes the client search find only page-1). Pushes the bound LIKE param onto
    // `params` and references it by its 1-based index, mirroring the keyset push.
    // Returns "" when there's no search term. The wildcards in the term are
    // escaped so a user typing `%` / `_` searches the literal characters.
    _searchFilter(search, params) {
      const s = (search == null ? "" : String(search)).trim();
      if (!s) return "";
      const esc = s.replace(/[\\%_]/g, (c) => "\\" + c);
      params.push("%" + esc + "%");
      const i = params.length;
      // Match the file NAME or its MIME TYPE (so "pdf" / "image" find by kind too).
      return ` AND (name LIKE $${i} OR mime LIKE $${i})`;
    },
    // Real keyset pagination over a user's accessible files. Mirrors
    // tasks.listForUser / reminders.listForUser EXACTLY (P0-F): stable order
    // (created_at DESC, id DESC); the cursor is the previous page's last
    // (createdAt, id). We fetch limit+1 to learn whether another page exists in
    // one round-trip, then trim. `limit` is clamped; authz is inherent (the
    // accessible-files predicate). An optional `tab` paginates WITHIN that tab so
    // counts + pages stay correct per tab. The search index has its OWN
    // full-set read (listAllForIndex) so paging here never truncates search.
    async listForUser(uid, { limit = 100, cursor = null, tab = null, search = null }: any = {}) {
      const lim = Math.max(1, Math.min(Number(limit) || 100, 500));
      const params: any[] = [uid];
      // The search filter param must be pushed BEFORE the keyset/LIMIT params so
      // the bound `$N` indices appear in the SAME order as in the SQL string.
      const searchSql = this._searchFilter(search, params);
      let keyset = "";
      if (cursor && cursor.createdAt && cursor.id) {
        // Strictly "after" the cursor in (created_at DESC, id DESC) order.
        params.push(cursor.createdAt, cursor.createdAt, cursor.id);
        keyset =
          ` AND (created_at < $${params.length - 2}` +
          ` OR (created_at = $${params.length - 1} AND id < $${params.length}))`;
      }
      // Organizations: tenant filter goes BEFORE the LIMIT param (pushed last).
      const of = orgFilter(params);
      of.params.push(lim + 1);
      const rows = (
        await q(
          `SELECT id,conversation_id,uploader_id,name,mime,size,created_at,EXISTS(SELECT 1 FROM file_stars fs WHERE fs.file_id=files.id AND fs.user_id=$1) AS starred,share_token,link_permission,encryption_version,ciphertext_meta
           FROM files
           WHERE ${this._accessibleWhere()}${this._tabFilter(tab)}${searchSql}${keyset}${of.clause}
           ORDER BY created_at DESC, id DESC
           LIMIT $${of.params.length}`,
          of.params,
        )
      ).rows.map(mapFile);
      const hasMore = rows.length > lim;
      const page = hasMore ? rows.slice(0, lim) : rows;
      const last = page[page.length - 1];
      const nextCursor =
        hasMore && last ? { createdAt: last.createdAt, id: last.id } : null;
      return { files: page, hasMore, nextCursor };
    },
    // Total accessible-file count for a user (per-tab when `tab` is given) — the
    // authoritative badge total once the client only holds a page. Cheap COUNT,
    // soft-delete aware, SAME predicate + tab filter as listForUser.
    async countForUser(uid, { tab = null, search = null }: any = {}) {
      const params: any[] = [uid];
      const searchSql = this._searchFilter(search, params);
      const of = orgFilter(params);
      const r = (
        await q(
          `SELECT COUNT(*) AS n FROM files
           WHERE ${this._accessibleWhere()}${this._tabFilter(tab)}${searchSql}${of.clause}`,
          of.params,
        )
      ).rows[0];
      return Number((r && (r.n ?? r.N)) || 0);
    },
    // FULL accessible-file set for the SEARCH INDEX only. searchService matches
    // file NAMES across everything the user can see; it must NOT be paginated or
    // the index would silently truncate (a soft-failure where files just stop
    // being findable). Same authorization predicate as listForUser, no LIMIT.
    // Kept separate from the read-path so the read-path can page freely without
    // blast-radius on search.
    async listAllForIndex(uid) {
      const { clause, params } = orgFilter([uid]);
      return (
        await q(
          `SELECT id,conversation_id,uploader_id,name,mime,size,created_at,EXISTS(SELECT 1 FROM file_stars fs WHERE fs.file_id=files.id AND fs.user_id=$1) AS starred,share_token,link_permission,encryption_version,ciphertext_meta
           FROM files
           WHERE ${this._accessibleWhere()}${clause}
           ORDER BY created_at DESC`,
          params,
        )
      ).rows.map(mapFile);
    },
    // Recycle-bin list: a user's OWN soft-deleted files, newest-deleted first.
    // Owner-scoped (only the uploader can see/restore their trash), keyset on
    // (deleted_at DESC, id DESC). Mirrors the read-path paging shape.
    async listDeleted(uid, { limit = 100, cursor = null }: any = {}) {
      const lim = Math.max(1, Math.min(Number(limit) || 100, 500));
      const params: any[] = [uid];
      let keyset = "";
      if (cursor && cursor.deletedAt && cursor.id) {
        params.push(cursor.deletedAt, cursor.deletedAt, cursor.id);
        keyset =
          ` AND (deleted_at < $${params.length - 2}` +
          ` OR (deleted_at = $${params.length - 1} AND id < $${params.length}))`;
      }
      const of = orgFilter(params);
      of.params.push(lim + 1);
      const rows = (
        await q(
          `SELECT id,conversation_id,uploader_id,name,mime,size,created_at,starred,share_token,link_permission,encryption_version,ciphertext_meta,deleted_at,deleted_by
           FROM files
           WHERE uploader_id=$1 AND deleted=1${keyset}${of.clause}
           ORDER BY deleted_at DESC, id DESC
           LIMIT $${of.params.length}`,
          of.params,
        )
      ).rows.map((r) => ({
        ...mapFile(r),
        deletedAt: r.deleted_at || null,
        deletedBy: r.deleted_by || null,
      }));
      const hasMore = rows.length > lim;
      const page = hasMore ? rows.slice(0, lim) : rows;
      const last = page[page.length - 1];
      const nextCursor =
        hasMore && last ? { deletedAt: last.deletedAt, id: last.id } : null;
      return { files: page, hasMore, nextCursor };
    },
    // AUDIT #47: authoritative recycle-bin tally so the header reflects EVERYTHING
    // in trash, not just the loaded page. Same owner+org scope as listDeleted.
    // One COUNT+SUM round-trip (cheap); SUM(size) is NULL for an empty bin → 0.
    async countDeleted(uid) {
      const of = orgFilter([uid]);
      const r = (
        await q(
          `SELECT COUNT(*) AS n, COALESCE(SUM(size),0) AS bytes
           FROM files
           WHERE uploader_id=$1 AND deleted=1${of.clause}`,
          of.params,
        )
      ).rows[0];
      return {
        count: Number((r && (r.n ?? r.N)) || 0),
        totalBytes: Number((r && (r.bytes ?? r.BYTES)) || 0),
      };
    },
    // Soft-deleted-only metadata read (for restore's permission check). Returns
    // null for a live file (deleted=0) — restore must only ever touch trash.
    async getDeletedMeta(id) {
      const r = (
        await q(
          `SELECT id,conversation_id,uploader_id,name,mime,size,storage_key,storage_backend,created_at,starred,share_token,link_permission,encryption_version,ciphertext_meta,deleted_at,deleted_by
           FROM files WHERE id=$1 AND deleted=1`,
          [id],
        )
      ).rows[0];
      return r ? { ...mapFile(r), deletedAt: r.deleted_at || null, deletedBy: r.deleted_by || null } : null;
    },
    // Restore a soft-deleted file: clear the soft-delete trio so it re-appears in
    // the owner's list. Only acts on a row that is currently deleted=1 (so it is
    // idempotent and can't "un-restore" a live file). Returns the restored meta
    // or null if nothing was restored (already live / unknown). The S3 blob was
    // retained, so the file's bytes are intact.
    //
    // CRITICAL (restore/GC TOCTOU): also clear gc_claimed_at so that if a GC sweep
    // had already claimed this row, the claim is now invalidated. The worker
    // re-confirms gcClaimStillValid() right before its irreversible storage.remove,
    // so this UPDATE makes a racing Restore win — the blob is NOT deleted.
    async restore(id) {
      const u = orgFilter([id]);
      const r = await q(
        `UPDATE files SET deleted=0, deleted_at=NULL, deleted_by=NULL, gc_claimed_at=NULL WHERE id=$1 AND deleted=1${u.clause}`,
        u.params,
      );
      if (!(r.rowCount || 0)) return null;
      return this.getMeta(id);
    },
    // GC sweeper: ATOMICALLY claim a BOUNDED batch of files eligible for permanent
    // deletion — soft-deleted (deleted=1) AND past the retention window (deleted_at
    // older than `retentionDays`). NEVER returns a live file.
    //
    // The claim is OBSERVABLE: inside one transaction we SELECT ... FOR UPDATE SKIP
    // LOCKED (same pattern as reminders.claimDue / scheduledMessages.claimDue) and
    // stamp gc_claimed_at on exactly the claimed rows. This closes the restore/GC
    // TOCTOU: restore() clears gc_claimed_at, and the worker re-confirms the marker
    // is still set + the row still soft-deleted immediately before the irreversible
    // S3 delete — so a Restore that races an in-flight sweep wins (the worker skips
    // the blob). Returns id + storage_key so the worker can delete the S3 object
    // before hard-deleting the row. Ordered oldest-deleted first (FIFO reclaim) and
    // capped by `batch` so a run is cheap and bounded. The worker hard-deletes each
    // row only AFTER its blob delete succeeds (a failed blob delete leaves the row
    // for the next run instead of orphaning the object).
    async claimForGc(retentionDays, batch = 100) {
      const days = Math.max(0, Number(retentionDays) || 0);
      const lim = Math.max(1, Math.min(Number(batch) || 100, 1000));
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const [picked]: any = await conn.query(
          `SELECT id, storage_key, storage_backend FROM files
             WHERE deleted=1 AND deleted_at IS NOT NULL
               AND deleted_at <= now(3) - INTERVAL ? DAY
             ORDER BY deleted_at ASC
             LIMIT ${lim}
             FOR UPDATE SKIP LOCKED`,
          [days],
        );
        if (!picked.length) {
          await conn.commit();
          return [];
        }
        const ids = picked.map((r) => r.id);
        // Stamp the claim marker atomically (re-guard deleted=1 so a row that went
        // live between the SELECT and here is NOT marked — belt for the lock).
        await conn.query(
          `UPDATE files SET gc_claimed_at=now(3) WHERE id IN (?) AND deleted=1`,
          [ids],
        );
        await conn.commit();
        return picked.map((r) => ({
          id: r.id,
          storageKey: r.storage_key || null,
          storageBackend: r.storage_backend || null,
        }));
      } catch (e) {
        try {
          await conn.rollback();
        } catch {
          /* ignore */
        }
        throw e;
      } finally {
        conn.release();
      }
    },
    // Cold-tier job (0127, docs/FILE_UPLOAD_STORAGE_CHAIN.md §11.3): live
    // disk-tier rows eligible to move to S3 — older than `olderThanDays`, or
    // (pressure mode, olderThanDays=0) simply the oldest disk-tier rows. Oldest
    // first so the hot set stays the most recent uploads. Bounded by `batch`.
    async listDiskTierCandidates(olderThanDays, batch = 200) {
      const days = Math.max(0, Number(olderThanDays) || 0);
      const lim = Math.max(1, Math.min(Number(batch) || 200, 1000));
      const age = days > 0 ? ` AND created_at <= now(3) - INTERVAL ${days} DAY` : "";
      return (
        await q(
          `SELECT id, storage_key, size, created_at FROM files
             WHERE deleted=0 AND storage_backend='disk' AND storage_key IS NOT NULL${age}
             ORDER BY created_at ASC
             LIMIT ${lim}`,
          [],
        )
      ).rows.map((r) => ({
        id: r.id,
        storageKey: r.storage_key,
        size: Number(r.size) || 0,
        createdAt: r.created_at,
      }));
    },
    // Flip a row's tier ONLY if it is still on `from` (compare-and-set), so a
    // concurrent GC/restore/re-run can never clobber a newer state. Returns true
    // when the row was moved.
    async setStorageBackend(id, from, to) {
      const r = await q(
        `UPDATE files SET storage_backend=$3 WHERE id=$1 AND storage_backend=$2`,
        [id, from, to],
      );
      return (r.rowCount || 0) > 0;
    },
    // Rows whose tier changed but whose old object may still exist: not needed —
    // the tier job deletes the disk copy right after the CAS; a crash in between
    // leaves a stale disk file that sweepStaleDisk() (below) reconciles.
    // Live counts per tier for the ops portal / health detail.
    async tierStats() {
      const rows = (
        await q(
          `SELECT storage_backend AS backend, COUNT(*) AS n, COALESCE(SUM(size),0) AS bytes
             FROM files WHERE deleted=0 GROUP BY storage_backend`,
          [],
        )
      ).rows;
      const out: Record<string, { count: number; bytes: number }> = {};
      for (const r of rows)
        out[String(r.backend || "")] = { count: Number(r.n) || 0, bytes: Number(r.bytes) || 0 };
      return out;
    },
    // Re-confirm a GC claim immediately BEFORE the irreversible S3 delete. Returns
    // true ONLY if the row is STILL soft-deleted (deleted=1) AND still carries the
    // claim marker (gc_claimed_at IS NOT NULL). A restore between claim and here
    // clears both (deleted=0, gc_claimed_at=NULL), so this returns false and the
    // worker SKIPS the blob delete — the file the owner just restored keeps its
    // bytes. Pure read; shrinks the TOCTOU window to a single statement.
    async gcClaimStillValid(id) {
      const r = (
        await q(
          `SELECT id FROM files WHERE id=$1 AND deleted=1 AND gc_claimed_at IS NOT NULL`,
          [id],
        )
      ).rows[0];
      return !!r;
    },
    // Permanent row delete — used ONLY by the GC sweeper, ONLY on a row that is
    // still soft-deleted (deleted=1), and ONLY after its blob has been removed.
    // The `deleted=1` guard is a belt-and-suspenders safety: even if a row were
    // restored between claim and delete, this would refuse to hard-delete a live
    // file. Child rows (file_shares/voicemails) were already soft-deleted on the
    // original soft-delete and cascade-drop via their FK ON DELETE CASCADE.
    async hardDelete(id) {
      const r = await q(`DELETE FROM files WHERE id=$1 AND deleted=1`, [id]);
      return { id, deleted: (r.rowCount || 0) > 0 };
    },
    async getMeta(id) {
      const r = (
        await q(
          `SELECT id,conversation_id,uploader_id,name,mime,size,storage_key,storage_backend,created_at,starred,share_token,link_permission,encryption_version,ciphertext_meta FROM files WHERE id=$1 AND deleted=0`,
          [id],
        )
      ).rows[0];
      return r ? mapFile(r) : null;
    },
    async setShareToken(id, token, linkPermission) {
      const u = orgFilter([id, token || null, linkPermission || null]);
      await q(
        `UPDATE files SET share_token=$2, link_permission=$3 WHERE id=$1${u.clause}`,
        u.params,
      );
      const s = orgFilter([id]);
      const r = (
        await q(
          `SELECT id,conversation_id,uploader_id,name,mime,size,storage_key,storage_backend,created_at,starred,share_token,link_permission,encryption_version,ciphertext_meta FROM files WHERE id=$1${s.clause}`,
          s.params,
        )
      ).rows[0];
      return r ? mapFile(r) : null;
    },
    async getByToken(token) {
      const r = (
        await q(
          `SELECT id,name,mime,size,data,storage_key,storage_backend,link_permission,encryption_version,ciphertext_meta FROM files WHERE share_token=$1 AND deleted=0`,
          [token],
        )
      ).rows[0];
      if (!r || !r.link_permission) return null;
      return {
        id: r.id,
        name: r.name,
        mime: r.mime,
        size: Number(r.size) || 0,
        data: r.data,
        storageKey: r.storage_key || null,
        storageBackend: r.storage_backend || null,
        linkPermission: r.link_permission,
        encryptionVersion: Number(r.encryption_version) || 0,
        ciphertextMeta: r.ciphertext_meta || null,
      };
    },
    // Per-user favorite (0114): one row per (file, user). The caller has
    // already access-gated (fileService.setStar → permissionFor).
    async setStar(id, userId, starred) {
      if (starred)
        await q(`INSERT IGNORE INTO file_stars (file_id, user_id) VALUES ($1,$2)`, [id, userId]);
      else
        await q(`DELETE FROM file_stars WHERE file_id=$1 AND user_id=$2`, [id, userId]);
      const s = orgFilter([id, userId]);
      const r = (
        await q(
          `SELECT id,conversation_id,uploader_id,name,mime,size,created_at,EXISTS(SELECT 1 FROM file_stars fs WHERE fs.file_id=files.id AND fs.user_id=$2) AS starred,encryption_version,ciphertext_meta FROM files WHERE id=$1${s.clause}`,
          s.params,
        )
      ).rows[0];
      return r ? mapFile(r) : null;
    },
    async getData(id) {
      const r = (
        await q(
          `SELECT name,mime,size,data,storage_key,storage_backend,encryption_version,ciphertext_meta FROM files WHERE id=$1 AND deleted=0`,
          [id],
        )
      ).rows[0];
      return r
        ? {
            name: r.name,
            mime: r.mime,
            size: Number(r.size) || 0,
            data: r.data,
            storageKey: r.storage_key || null,
            storageBackend: r.storage_backend || null,
            encryptionVersion: Number(r.encryption_version) || 0,
            ciphertextMeta: r.ciphertext_meta || null,
          }
        : null;
    },
    async remove(id, actorId) {
      // Soft-delete + child soft-cascade (file_shares + voicemails). The S3 blob is
      // intentionally KEPT (a retention/GC job purges it later) so the file is
      // recoverable — destroying it synchronously would defeat soft-delete.
      const by = actorId || null;
      const u = orgFilter([id, by]);
      await q(`UPDATE files SET deleted=1, deleted_at=now(3), deleted_by=$2 WHERE id=$1${u.clause}`, u.params);
      await q(`UPDATE file_shares SET deleted=1, deleted_at=now(3) WHERE file_id=$1 AND deleted=0`, [id]);
      await q(`UPDATE voicemails SET deleted=1, deleted_at=now(3) WHERE file_id=$1 AND deleted=0`, [id]);
      return { id, deleted: true };
    },
  };

  const mapShare = (r) =>
    r && {
      id: r.id,
      fileId: r.file_id,
      subjectType: r.subject_type,
      subjectId: r.subject_id,
      permission: r.permission,
      createdBy: r.created_by,
      createdAt: r.created_at,
    };
  const fileShares = {
    async create({ fileId, subjectType, subjectId, permission, createdBy }) {
      const id = genId();
      await q(
        `INSERT INTO file_shares (id,file_id,subject_type,subject_id,permission,created_by)
           VALUES ($1,$2,$3,$4,$5,$6) AS new
           ON DUPLICATE KEY UPDATE permission=new.permission, created_by=new.created_by, created_at=now(), deleted=0, deleted_at=NULL`,
        [id, fileId, subjectType, subjectId, permission, createdBy || null],
      );
      const r = (
        await q(
          `SELECT * FROM file_shares WHERE file_id=$1 AND subject_type=$2 AND subject_id=$3`,
          [fileId, subjectType, subjectId],
        )
      ).rows[0];
      return mapShare(r);
    },
    async listForFile(fileId) {
      return (
        await q(
          `SELECT * FROM file_shares WHERE file_id=$1 AND deleted=0 ORDER BY created_at ASC`,
          [fileId],
        )
      ).rows.map(mapShare);
    },
    async getById(id) {
      const r = (await q(`SELECT * FROM file_shares WHERE id=$1 AND deleted=0`, [id]))
        .rows[0];
      return r ? mapShare(r) : null;
    },
    async remove(id) {
      const r = await q(`UPDATE file_shares SET deleted=1, deleted_at=now(3) WHERE id=$1 AND deleted=0`, [id]);
      return { id, deleted: (r.rowCount || 0) > 0 };
    },
    async permissionsFor(fileId, userId) {
      return (
        await q(
          `SELECT permission FROM file_shares
           WHERE file_id=$1 AND deleted=0 AND (
             (subject_type='user' AND subject_id=$2)
             OR (subject_type='conversation' AND subject_id IN (
                  SELECT conversation_id FROM conversation_members WHERE user_id=$2 AND deleted=0
                ))
           )`,
          [fileId, userId],
        )
      ).rows.map((row) => row.permission);
    },
  };

  const mapAudit = (r) => ({
    id: String(r.id),
    actorId: r.actor_id,
    action: r.action,
    targetType: (r.meta_json && r.meta_json.targetType) || null,
    targetId: r.target || null,
    detail: (r.meta_json && r.meta_json.detail) || null,
    createdAt: r.created_at,
  });
  // ── REPORT A CONCERN (Settings → Report a concern) ────────────────────────
  const mapConcern = (r) => ({
    id: r.id,
    organizationId: r.organization_id || null,
    userId: r.user_id,
    reporterName: r.reporter_name || null,
    category: r.category,
    module: r.module || "other",
    dependency: r.dependency || "dev",
    suggestedResolution: r.suggested_resolution || null,
    subject: r.subject || null,
    body: r.body,
    fileId: r.file_id || null,
    status: r.status,
    response: r.response || null,
    handledBy: r.handled_by || null,
    handledAt: r.handled_at || null,
    createdAt: r.created_at,
  });
  const concerns = {
    async create({ userId, orgId = null, category, module = "other", subject = null, body, fileId = null, dependency = "dev", suggestedResolution = null }) {
      const id = genId();
      await q(
        `INSERT INTO concern_reports (id, organization_id, user_id, category, module, subject, body, file_id, dependency, suggested_resolution)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          id,
          orgId,
          userId,
          String(category || "other").slice(0, 32),
          String(module || "other").slice(0, 32),
          subject ? String(subject).slice(0, 200) : null,
          String(body || ""),
          fileId || null,
          dependency || "dev",
          suggestedResolution ? String(suggestedResolution).slice(0, 2000) : null,
        ],
      );
      return this.getById(id);
    },
    async getById(id) {
      const r = (
        await q(
          `SELECT c.*, u.name AS reporter_name FROM concern_reports c
             LEFT JOIN users u ON u.id = c.user_id
            WHERE c.id=$1 AND c.deleted=0`,
          [id],
        )
      ).rows[0];
      return r ? mapConcern(r) : null;
    },
    // The reporter's own reports (Settings list) — always visible to them.
    async listForUser(userId, limit = 50) {
      return (
        await q(
          `SELECT c.*, u.name AS reporter_name FROM concern_reports c
             LEFT JOIN users u ON u.id = c.user_id
            WHERE c.user_id=$1 AND c.deleted=0
            ORDER BY c.created_at DESC LIMIT ${Math.min(Number(limit) || 50, 200)}`,
          [userId],
        )
      ).rows.map(mapConcern);
    },
    // Triage list for the org's managers.
    async listForOrg(orgId, { status = null, limit = 100 } = {} as any) {
      const vals: any[] = [orgId];
      let where = `c.organization_id=$1 AND c.deleted=0`;
      if (status) { vals.push(status); where += ` AND c.status=$${vals.length}`; }
      return (
        await q(
          `SELECT c.*, u.name AS reporter_name FROM concern_reports c
             LEFT JOIN users u ON u.id = c.user_id
            WHERE ${where}
            ORDER BY c.created_at DESC LIMIT ${Math.min(Number(limit) || 100, 500)}`,
          vals,
        )
      ).rows.map(mapConcern);
    },
    // Org-scoped so a manager can only triage their own tenant's reports.
    async setStatus(id, orgId, { status, response = null, handledBy = null }) {
      await q(
        `UPDATE concern_reports
            SET status=$3, response=$4, handled_by=$5, handled_at=now(3)
          WHERE id=$1 AND organization_id=$2 AND deleted=0`,
        [id, orgId, status, response, handledBy],
      );
      return this.getById(id);
    },
  };
  // ── ERROR LEDGER ──────────────────────────────────────────────────────────
  // Every backend/frontend/process error, deduped by fingerprint while open.
  // Each environment writes to its OWN database, so live/local separation is
  // inherent — no cross-env routing needed here.
  const mapErrLog = (r) => ({
    id: String(r.id),
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    occurrences: Number(r.occurrences) || 1,
    env: r.env,
    source: r.source,
    severity: r.severity,
    code: r.code || null,
    message: r.message,
    stack: r.stack || null,
    context: typeof r.context === "string" ? JSON.parse(r.context) : r.context || null,
    requestPath: r.request_path || null,
    userId: r.user_id || null,
    organizationId: r.organization_id || null,
    fingerprint: r.fingerprint,
    status: r.status,
    resolution: r.resolution || null,
    dependency: r.dependency || null,
    resolvedBy: r.resolved_by || null,
    resolvedAt: r.resolved_at || null,
  });
  const errorLogs = {
    // ATOMIC dedup-upsert via the uq_errlog_open_fp unique index (a generated
    // column carrying the fingerprint only while status='open'): an OPEN row
    // with the same fingerprint absorbs the recurrence (occurrences+1,
    // last_seen bumped) in ONE statement, so concurrent bursts can't
    // double-insert. Resolved/ignored rows release the key, so a recurrence
    // after resolve opens a NEW row and reads as a regression.
    async record(e) {
      await q(
        `INSERT INTO error_logs
           (env, source, severity, code, message, stack, context, request_path,
            user_id, organization_id, dependency, fingerprint)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON DUPLICATE KEY UPDATE
           occurrences = occurrences + 1, last_seen_at = now(3)`,
        [
          e.env || "unknown",
          e.source || "backend",
          e.severity || "error",
          e.code ? String(e.code).slice(0, 64) : null,
          String(e.message || "unknown error").slice(0, 8000),
          e.stack ? String(e.stack).slice(0, 16000) : null,
          e.context ? JSON.stringify(e.context).slice(0, 8000) : null,
          e.requestPath ? String(e.requestPath).slice(0, 255) : null,
          e.userId || null,
          e.organizationId || null,
          // Auto-classified owner (dev|infra|external), stamped at capture;
          // triage may overwrite it later via resolve().
          e.dependency || "dev",
          e.fingerprint,
        ],
      );
      return { recorded: true };
    },
    async list({ status = null, severity = null, source = null, q: qry = null, limit = 100 } = {} as any) {
      const conds: string[] = [];
      const vals: any[] = [];
      const add = (sql: string, v: any) => { vals.push(v); conds.push(sql.replace("?", "$" + vals.length)); };
      if (status) add("status = ?", status);
      if (severity) add("severity = ?", severity);
      if (source) add("source = ?", source);
      if (qry) add("(message LIKE ? OR code LIKE ?)".replace("?", "$" + (vals.length + 1)).replace("?", "$" + (vals.length + 1)), "%" + String(qry).replace(/[\\%_]/g, (c) => "\\" + c) + "%");
      const where = conds.length ? " WHERE " + conds.join(" AND ") : "";
      const lim = Math.min(Math.max(1, Number(limit) || 100), 500);
      return (
        await q(`SELECT * FROM error_logs${where} ORDER BY last_seen_at DESC LIMIT ${lim}`, vals)
      ).rows.map(mapErrLog);
    },
    async resolve(id, { status = "resolved", resolution = null, dependency = null, resolvedBy = null } = {} as any) {
      await q(
        `UPDATE error_logs SET status=$2, resolution=$3, dependency=$4,
                resolved_by=$5, resolved_at=now(3)
          WHERE id=$1`,
        [id, status, resolution, dependency, resolvedBy],
      );
      const r = (await q(`SELECT * FROM error_logs WHERE id=$1`, [id])).rows[0];
      return r ? mapErrLog(r) : null;
    },
    async openCount() {
      return Number(
        (await q(`SELECT COUNT(*) AS c FROM error_logs WHERE status='open'`)).rows[0]?.c || 0,
      );
    },
  };
  const audit = {
    async create(e) {
      const meta =
        e.targetType || e.detail
          ? JSON.stringify({
              targetType: e.targetType || null,
              detail: e.detail || null,
            })
          : null;
      // Organizations: stamp the active tenant on new audit rows (in-request →
      // currentOrgId(); null for background writers, backfilled historically in
      // 0069 since the append-only trigger blocks UPDATE). audit_log is DIRECT.
      await q(
        "INSERT INTO audit_log (actor_id, action, target, meta_json, organization_id) VALUES ($1,$2,$3,$4,$5)",
        [e.actorId || null, e.action, e.targetId || null, meta, currentOrgId()],
      );
    },
    async listForActor(actorId, limit = 50) {
      return (
        await q(
          "SELECT * FROM audit_log WHERE actor_id=$1 ORDER BY created_at DESC LIMIT $2",
          [actorId, limit],
        )
      ).rows.map(mapAudit);
    },
    // Org activity feed (BA #4): ORGANIZATION-GOVERNANCE actions only, by ANY
    // actor (this is the org's activity, not the viewer's).
    //
    // audit_log stamps organization_id on EVERY row in the tenant — message
    // deletes, conversation creates, file GC — so an unfiltered "rows for this
    // org" query is a firehose of unrelated product activity, not an org feed.
    // Restrict to the governance namespaces: `org.*` (membership, roles,
    // join-request decisions, settings, broadcasts) and `admin.*` (an admin
    // acting on another member's sessions/devices).
    async listForOrg(orgId, limit = 100) {
      return (
        await q(
          `SELECT a.*, u.name AS actor_name
             FROM audit_log a
             LEFT JOIN users u ON u.id = a.actor_id
            WHERE a.organization_id=$1
              AND (a.action LIKE 'org.%' OR a.action LIKE 'admin.%')
            ORDER BY a.created_at DESC
            LIMIT $2`,
          [orgId, Math.min(Number(limit) || 100, 300)],
        )
      ).rows.map((r) => ({ ...mapAudit(r), actorName: r.actor_name || null }));
    },
  };

  const voicemails = {
    async create({ callId, fromUser, toUser, fileId, durationSec }) {
      const id = genId();
      await q(
        "INSERT INTO voicemails (id,call_id,from_user,to_user,file_id,duration_sec) VALUES ($1,$2,$3,$4,$5,$6)",
        [id, callId || null, fromUser, toUser, fileId, durationSec || 0],
      );
      const r = (await q("SELECT * FROM voicemails WHERE id=$1 AND deleted=0", [id])).rows[0];
      return mapVm(r);
    },
    async listForUser(toUser) {
      return (
        await q(
          "SELECT * FROM voicemails WHERE to_user=$1 AND deleted=0 ORDER BY created_at DESC",
          [toUser],
        )
      ).rows.map(mapVm);
    },
    async getById(id) {
      const r = (await q("SELECT * FROM voicemails WHERE id=$1 AND deleted=0", [id])).rows[0];
      return r ? mapVm(r) : null;
    },
    async markListened(id) {
      await q("UPDATE voicemails SET listened=true WHERE id=$1", [id]);
      const r = (await q("SELECT * FROM voicemails WHERE id=$1 AND deleted=0", [id])).rows[0];
      return r ? mapVm(r) : null;
    },
    async remove(id) {
      const r = await q("UPDATE voicemails SET deleted=1, deleted_at=now(3) WHERE id=$1 AND deleted=0", [id]);
      return { id, deleted: (r.rowCount || 0) > 0 };
    },
    async unreadCount(toUser) {
      const r = (
        await q(
          "SELECT COUNT(*) AS n FROM voicemails WHERE to_user=$1 AND deleted=0 AND listened=false",
          [toUser],
        )
      ).rows[0];
      return r ? Number(r.n) : 0;
    },
  };
  const e2ee = {
    async registerDevice({
      id,
      userId,
      name = null,
      identityKey,
      signedPreKey = null,
      trusted = true,
      signingKey = null,
      ratchetInitialKey = null,
    }) {
      // `trusted` is only applied to a genuinely NEW device row. On re-register
      // of an existing deviceId the ON DUPLICATE branch deliberately does NOT
      // touch `trusted`, so an already-approved device can't be silently demoted
      // (and a pending one can't self-promote by re-registering). `signing_key`
      // (B2 — sender authentication) and `ratchet_initial_key` (Double Ratchet
      // Phase 1 — DH ratchet seed) ARE refreshed on re-register via COALESCE so
      // a device that pre-dated those columns can publish them on next init
      // without losing trust.
      await q(
        `INSERT INTO e2ee_devices (id,user_id,name,identity_key,signed_pre_key,trusted,signing_key,ratchet_initial_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) AS new
         ON DUPLICATE KEY UPDATE name=new.name, identity_key=new.identity_key,
           signed_pre_key=new.signed_pre_key, revoked=false,
           signing_key=COALESCE(new.signing_key, e2ee_devices.signing_key),
           ratchet_initial_key=COALESCE(new.ratchet_initial_key, e2ee_devices.ratchet_initial_key)`,
        [
          id,
          userId,
          name,
          identityKey,
          signedPreKey ? JSON.stringify(signedPreKey) : null,
          trusted ? 1 : 0,
          signingKey,
          ratchetInitialKey,
        ],
      );
      return this.getDevice(id);
    },
    async approveDevice({ userId, deviceId }) {
      await q(
        "UPDATE e2ee_devices SET trusted=true WHERE id=$1 AND user_id=$2",
        [deviceId, userId],
      );
      return { id: deviceId, trusted: true };
    },
    async getDevice(id) {
      const r = (
        await q("SELECT * FROM e2ee_devices WHERE id=$1", [id])
      ).rows[0];
      return r
        ? {
            id: r.id,
            userId: r.user_id,
            name: r.name,
            identityKey: r.identity_key,
            signingKey: r.signing_key || null,
            ratchetInitialKey: r.ratchet_initial_key || null,
            signedPreKey: r.signed_pre_key,
            trusted: !!r.trusted,
            revoked: !!r.revoked,
            createdAt: r.created_at,
          }
        : null;
    },
    async listDevices(userId) {
      return (
        await q(
          `SELECT * FROM e2ee_devices
           WHERE user_id=$1 AND revoked=false
           ORDER BY created_at ASC`,
          [userId],
        )
      ).rows.map((r) => ({
        id: r.id,
        userId: r.user_id,
        name: r.name,
        identityKey: r.identity_key,
        signingKey: r.signing_key || null,
        ratchetInitialKey: r.ratchet_initial_key || null,
        signedPreKey: r.signed_pre_key,
        trusted: !!r.trusted,
        createdAt: r.created_at,
        lastSeenAt: r.last_seen_at || null,
      }));
    },
    // Activity stamp for stale-device pruning: touched (throttled by the CALLER)
    // whenever a device-bound token makes an authenticated request. The WHERE
    // clause self-throttles too — one write per device per hour max — so this is
    // safe to call opportunistically on the request hot path. Fire-and-forget.
    async touchDevice(id) {
      if (!id) return;
      await q(
        `UPDATE e2ee_devices SET last_seen_at = NOW(3)
          WHERE id=$1 AND (last_seen_at IS NULL OR last_seen_at < NOW(3) - INTERVAL 1 HOUR)`,
        [id],
      );
    },
    async revokeDevice({ userId, deviceId }) {
      await q("UPDATE e2ee_devices SET revoked=true WHERE id=$1 AND user_id=$2", [
        deviceId,
        userId,
      ]);
      return { id: deviceId, revoked: true };
    },
    async publishOneTimePreKeys({ deviceId, keys }) {
      for (const k of keys || []) {
        await q(
          `INSERT IGNORE INTO e2ee_one_time_prekeys (id,device_id,key_id,public_key)
           VALUES ($1,$2,$3,$4)`,
          [genId(), deviceId, k.keyId || k.id, k.publicKey],
        );
      }
      await q(
        `UPDATE e2ee_devices
         SET one_time_pre_key_count = (
           SELECT COUNT(*) FROM e2ee_one_time_prekeys
           WHERE device_id=$1 AND consumed_at IS NULL
         )
         WHERE id=$1`,
        [deviceId],
      );
      return { deviceId, count: (keys || []).length };
    },
    // Atomically claim a one-time prekey (forward secrecy / X3DH). Returns true
    // only if THIS caller marked it consumed (affected row), so two senders can
    // never share an OPK — the recipient deletes each OPK after one decrypt.
    async consumeOneTimePreKey({ deviceId, keyId }) {
      const r = await q(
        `UPDATE e2ee_one_time_prekeys SET consumed_at=now(3)
         WHERE device_id=$1 AND key_id=$2 AND consumed_at IS NULL`,
        [deviceId, keyId],
      );
      const claimed = (r && (r as any).rowCount) > 0;
      if (claimed) {
        await q(
          `UPDATE e2ee_devices SET one_time_pre_key_count = (
             SELECT COUNT(*) FROM e2ee_one_time_prekeys
             WHERE device_id=$1 AND consumed_at IS NULL)
           WHERE id=$1`,
          [deviceId],
        );
      }
      return { claimed };
    },
    async getPreKeyBundle(userId) {
      // Fan-out MUST exclude pending (untrusted) devices: a silently-enrolled or
      // not-yet-approved device receives no envelopes/keys until an existing
      // device approves it. (listDevices returns all non-revoked for display;
      // here we keep only trusted ones for actual key distribution.)
      const devices = (await this.listDevices(userId)).filter((d: any) => d.trusted);
      const out: any[] = [];
      for (const d of devices) {
        const pre = (
          await q(
            `SELECT * FROM e2ee_one_time_prekeys
             WHERE device_id=$1 AND consumed_at IS NULL
             ORDER BY created_at ASC LIMIT 1`,
            [d.id],
          )
        ).rows[0];
        // NOTE: do NOT consume the one-time prekey on a bundle fetch. The v1
        // ECIES path uses per-message ephemeral keys and never needs a prekey,
        // so consuming here silently drained the pool (~100 fetches → empty)
        // and would break Phase-2 X3DH. A prekey must only be consumed when it
        // is actually claimed for a handshake (a dedicated Phase-2 operation).
        out.push({
          ...d,
          oneTimePreKey: pre
            ? { keyId: pre.key_id, publicKey: pre.public_key }
            : null,
        });
      }
      return out;
    },
    async putConversationKey({
      conversationId,
      deviceId,
      userId,
      keyVersion = 1,
      encryptedKey,
      algorithm = "x25519-aes-gcm",
    }) {
      try {
        // INSERT-IF-ABSENT: an existing (conversation,device,version) wrap is NEVER
        // replaced. An epoch's key is fixed for its lifetime, so a second wrap for
        // the same slot is either the same key (a re-wrap — nothing to gain) or a
        // DIFFERENT key, which splits the epoch: that device then can't read what
        // the rest of the group sends under that version. Older clients did exactly
        // that from a last-resort upsert; this makes it impossible server-side.
        await q(
          `INSERT INTO e2ee_conversation_keys
             (conversation_id,device_id,user_id,key_version,encrypted_key,algorithm)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON DUPLICATE KEY UPDATE encrypted_key=encrypted_key`,
          [conversationId, deviceId, userId, keyVersion, encryptedKey, algorithm],
        );
        return { conversationId, deviceId, userId, keyVersion };
      } catch (err: any) {
        // Unknown device_id (device not registered) or a conversation deleted
        // mid-flight → FK violation. Skip this one row rather than 500 the whole
        // key-put loop (which stranded the OTHER, valid devices). The skipped
        // device gets its key when it registers and re-requests. No data lost.
        if (
          err &&
          (err.errno === 1452 ||
            err.code === "ER_NO_REFERENCED_ROW_2" ||
            err.code === "ER_NO_REFERENCED_ROW")
        )
          return { conversationId, deviceId, userId, keyVersion, skipped: true };
        throw err;
      }
    },
    // Atomically claim a NEW conversation-key epoch. All device rows for the
    // version are inserted in ONE statement with a plain INSERT (no upsert): if
    // any (conversation,device,version) already exists, the whole statement fails
    // with a duplicate-key error and NOTHING is written. Two members racing to
    // create the same epoch therefore serialize — exactly one wins ({created:true})
    // and the loser ({created:false}) re-fetches and adopts the winner's key.
    async createConversationEpoch({ conversationId, version, envelopes }) {
      let rows = envelopes || [];
      if (!rows.length) return { created: false, version };
      // SKIP envelopes whose device_id is NOT registered in e2ee_devices. A single
      // unknown device would violate the device FK and abort this ENTIRE bulk
      // insert → 500, NO keys stored → the whole group is stranded on
      // pending-key / decrypt-failed. Known devices still get their key here; an
      // unregistered device can't decrypt anyway and picks up its key once it
      // registers and re-requests. (Never loses data — only avoids a batch abort.)
      const ids = Array.from(
        new Set(rows.map((e: any) => e.deviceId).filter(Boolean)),
      );
      if (ids.length) {
        const ph = ids.map((_, k) => "$" + (k + 1)).join(",");
        const known = new Set(
          (await q(`SELECT id FROM e2ee_devices WHERE id IN (${ph})`, ids)).rows.map(
            (r: any) => r.id,
          ),
        );
        rows = rows.filter((e: any) => known.has(e.deviceId));
      }
      if (!rows.length) return { created: false, version, skipped: "no-known-devices" };
      const tuples: string[] = [];
      const vals: any[] = [];
      let i = 1;
      for (const e of rows) {
        tuples.push(`($${i++},$${i++},$${i++},$${i++},$${i++},$${i++})`);
        vals.push(
          conversationId,
          e.deviceId,
          e.userId,
          version,
          e.encryptedKey,
          e.algorithm || "ecies-p256-aesgcm",
        );
      }
      try {
        await q(
          `INSERT INTO e2ee_conversation_keys
             (conversation_id,device_id,user_id,key_version,encrypted_key,algorithm)
           VALUES ${tuples.join(",")}`,
          vals,
        );
        return { created: true, version };
      } catch (err: any) {
        if (err && (err.code === "ER_DUP_ENTRY" || err.errno === 1062)) {
          // Tell the loser the highest version that exists, so a device with
          // nothing to adopt can claim the NEXT free epoch instead of guessing.
          let maxVersion = version;
          try {
            const r = await q(
              `SELECT MAX(key_version) AS mv FROM e2ee_conversation_keys WHERE conversation_id=$1`,
              [conversationId],
            );
            maxVersion = Number(r.rows[0]?.mv) || version;
          } catch (_) { /* best-effort */ }
          return { created: false, version, maxVersion };
        }
        // FK race (e.g. the conversation was deleted mid-flight) — never 500 the
        // key-distribution path over it; the client retries/re-requests.
        if (
          err &&
          (err.errno === 1452 ||
            err.code === "ER_NO_REFERENCED_ROW_2" ||
            err.code === "ER_NO_REFERENCED_ROW")
        )
          return { created: false, version, skipped: "fk" };
        throw err;
      }
    },
    async listConversationKeys({ conversationId, userId }) {
      return (
        await q(
          `SELECT * FROM e2ee_conversation_keys
           WHERE conversation_id=$1 AND user_id=$2
           ORDER BY key_version DESC`,
          [conversationId, userId],
        )
      ).rows.map((r) => ({
        conversationId: r.conversation_id,
        deviceId: r.device_id,
        userId: r.user_id,
        keyVersion: r.key_version,
        encryptedKey: r.encrypted_key,
        algorithm: r.algorithm,
        createdAt: r.created_at,
      }));
    },
    // ---- Mechanism A: server-blind device-link history sync relay ----------
    // Stores/serves OPAQUE base64 ciphertext only. The driver never parses or
    // decodes `ciphertext`; there is no key column. Rows expire (expires_at) and
    // are deleted after the target device acks a successful restore. Identity for
    // fetch/ack is enforced by the service from the device-bound JWT, never a
    // body/query id.
    async putHistorySyncChunk({
      targetUserId,
      targetDeviceId,
      sourceDeviceId,
      bundleId,
      chunkIndex = 0,
      chunkCount = 1,
      ciphertext,
      algorithm = "ecies-p256-aesgcm",
      ttlSeconds = 14 * 24 * 3600,
    }) {
      await q(
        `INSERT INTO e2ee_history_sync
           (id,target_user_id,target_device_id,source_device_id,bundle_id,chunk_index,chunk_count,ciphertext,algorithm,byte_len,expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,DATE_ADD(now(3), INTERVAL $11 SECOND)) AS new
         ON DUPLICATE KEY UPDATE
           ciphertext=new.ciphertext, byte_len=new.byte_len,
           expires_at=new.expires_at, source_device_id=new.source_device_id`,
        [
          genId(),
          targetUserId,
          targetDeviceId,
          sourceDeviceId,
          bundleId,
          chunkIndex,
          chunkCount,
          ciphertext,
          algorithm,
          Buffer.byteLength(ciphertext, "utf8"),
          ttlSeconds,
        ],
      );
      return { bundleId, chunkIndex, chunkCount };
    },
    async listHistorySyncFor({ targetUserId, targetDeviceId }) {
      return (
        await q(
          `SELECT bundle_id,chunk_index,chunk_count,source_device_id,ciphertext,algorithm,created_at
             FROM e2ee_history_sync
            WHERE target_user_id=$1 AND target_device_id=$2 AND expires_at>now(3)
            ORDER BY created_at ASC, chunk_index ASC`,
          [targetUserId, targetDeviceId],
        )
      ).rows.map((r) => ({
        bundleId: r.bundle_id,
        chunkIndex: r.chunk_index,
        chunkCount: r.chunk_count,
        sourceDeviceId: r.source_device_id,
        ciphertext: r.ciphertext,
        algorithm: r.algorithm,
        createdAt: r.created_at,
      }));
    },
    async deleteHistorySyncFor({ targetUserId, targetDeviceId, bundleId = null }) {
      const r = bundleId
        ? await q(
            `DELETE FROM e2ee_history_sync
              WHERE target_user_id=$1 AND target_device_id=$2 AND bundle_id=$3`,
            [targetUserId, targetDeviceId, bundleId],
          )
        : await q(
            `DELETE FROM e2ee_history_sync
              WHERE target_user_id=$1 AND target_device_id=$2`,
            [targetUserId, targetDeviceId],
          );
      return { deleted: (r as any).rowCount || (r as any).affectedRows || 0 };
    },
    async purgeExpiredHistorySync() {
      const r = await q(
        "DELETE FROM e2ee_history_sync WHERE expires_at<=now(3)",
      );
      return { purged: (r as any).rowCount || (r as any).affectedRows || 0 };
    },
    // ---- Durable re-delivery requests (0126) ----------------------------------
    // "Device D of user U cannot open message M — seal it to D again." Kept
    // until a member's device stores the envelope (deleteRedeliverRequest) or
    // the row expires. Names a message and a device only; never content.
    async putRedeliverRequest({
      messageId,
      conversationId,
      requesterUserId,
      requesterDeviceId,
      ttlSeconds = 7 * 24 * 3600,
    }) {
      await q(
        `INSERT INTO e2ee_redeliver_requests
           (id,message_id,conversation_id,requester_user_id,requester_device_id,expires_at)
         VALUES ($1,$2,$3,$4,$5,DATE_ADD(now(3), INTERVAL $6 SECOND)) AS new
         ON DUPLICATE KEY UPDATE expires_at=new.expires_at`,
        [genId(), messageId, conversationId, requesterUserId, requesterDeviceId, ttlSeconds],
      );
      return { messageId, requesterDeviceId };
    },
    // Every live request in a conversation this user is a member of, except the
    // ones raised by the user's own device `excludeDeviceId`, and only for
    // requester devices that still exist and are not revoked (a dead device's
    // ask can never be consumed). Newest first, capped.
    async listRedeliverRequestsFor({ userId, excludeDeviceId = null, limit = 500 }) {
      return (
        await q(
          `SELECT r.message_id, r.conversation_id, r.requester_user_id, r.requester_device_id, r.created_at
             FROM e2ee_redeliver_requests r
             JOIN conversation_members cm
               ON cm.conversation_id=r.conversation_id AND cm.user_id=$1
             JOIN e2ee_devices d
               ON d.id=r.requester_device_id AND d.user_id=r.requester_user_id AND d.revoked=false
            WHERE r.expires_at>now(3)
              AND ($2 IS NULL OR r.requester_device_id<>$2)
            ORDER BY r.created_at DESC
            LIMIT ${Math.max(1, Math.min(1000, Number(limit) || 500))}`,
          [userId, excludeDeviceId],
        )
      ).rows.map((r) => ({
        messageId: r.message_id,
        conversationId: r.conversation_id,
        requesterUserId: r.requester_user_id,
        requesterDeviceId: r.requester_device_id,
        createdAt: r.created_at,
      }));
    },
    // The caller's own open asks in one conversation, with what can still answer
    // them: every non-revoked device of every member (own siblings included)
    // other than the asking device, and when each was last seen.
    async listRedeliverStatus({ userId, conversationId, requesterDeviceId }) {
      const asks = (
        await q(
          `SELECT message_id, created_at FROM e2ee_redeliver_requests
            WHERE conversation_id=$1 AND requester_user_id=$2 AND requester_device_id=$3 AND expires_at>now(3)`,
          [conversationId, userId, requesterDeviceId],
        )
      ).rows.map((r) => ({ messageId: r.message_id, askedAt: r.created_at }));
      const devices = (
        await q(
          `SELECT d.id, d.user_id, d.last_seen_at, d.created_at
             FROM e2ee_devices d
             JOIN conversation_members cm ON cm.user_id=d.user_id AND cm.conversation_id=$1 AND cm.deleted=0
            WHERE d.revoked=false AND d.id<>$2`,
          [conversationId, requesterDeviceId],
        )
      ).rows.map((r) => ({
        id: String(r.id),
        userId: r.user_id,
        lastSeenAt: r.last_seen_at || null,
        createdAt: r.created_at,
      }));
      return { asks, devices };
    },
    async countRedeliverRequestsBy({ userId }) {
      const { rows } = await q(
        "SELECT COUNT(*) AS n FROM e2ee_redeliver_requests WHERE requester_user_id=$1 AND expires_at>now(3)",
        [userId],
      );
      return Number(rows[0]?.n || 0);
    },
    async deleteRedeliverRequest({ messageId, requesterDeviceId }) {
      const r = await q(
        "DELETE FROM e2ee_redeliver_requests WHERE message_id=$1 AND requester_device_id=$2",
        [messageId, requesterDeviceId],
      );
      return { deleted: (r as any).rowCount || (r as any).affectedRows || 0 };
    },
    async purgeExpiredRedeliverRequests() {
      const r = await q("DELETE FROM e2ee_redeliver_requests WHERE expires_at<=now(3)");
      return { purged: (r as any).rowCount || (r as any).affectedRows || 0 };
    },
    // ---- Mechanism B: server-blind encrypted history RECOVERY BACKUP --------
    // Stores/serves OPAQUE base64 ciphertext + iv + a NON-SECRET salt only. The
    // driver never parses or decodes `ciphertext`; there is no key column. One
    // backup per user — fully replaced on each refresh (DELETE existing rows then
    // INSERT the new chunk set inside a transaction so a partial write can't leave
    // a torn backup). Identity (user_id) is enforced by the service from the JWT.
    async putRecoveryBackup({ userId, salt, chunks }) {
      const list = chunks || [];
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        // Bump the version past whatever the prior backup carried so clients can
        // detect a newer server backup. MAX over the user's rows (NULL → 0).
        const [verRows]: any = await conn.query(
          "SELECT COALESCE(MAX(version),0) AS v FROM e2ee_recovery_backup WHERE user_id=?",
          [userId],
        );
        const version = (Number(verRows?.[0]?.v) || 0) + 1;
        await conn.query("DELETE FROM e2ee_recovery_backup WHERE user_id=?", [
          userId,
        ]);
        for (const c of list) {
          await conn.query(
            `INSERT INTO e2ee_recovery_backup
               (id,user_id,salt,chunk_index,chunk_count,ciphertext,iv,version,byte_len)
             VALUES (?,?,?,?,?,?,?,?,?)`,
            [
              genId(),
              userId,
              salt,
              Number(c.index) || 0,
              Number(c.count) || list.length || 1,
              c.ciphertext,
              c.iv,
              version,
              Buffer.byteLength(String(c.ciphertext || ""), "utf8"),
            ],
          );
        }
        await conn.commit();
        return { ok: true, version, chunkCount: list.length };
      } catch (err) {
        try {
          await conn.rollback();
        } catch {
          /* ignore */
        }
        throw err;
      } finally {
        conn.release();
      }
    },
    async getRecoveryBackup(userId) {
      const { rows } = await q(
        `SELECT salt,chunk_index,chunk_count,ciphertext,iv,version
           FROM e2ee_recovery_backup
          WHERE user_id=$1
          ORDER BY chunk_index ASC`,
        [userId],
      );
      if (!rows.length) return null;
      // Attach EVERY recovery wrap (auto-restore), one per kind — opaque to us.
      // The recovery secret can be wrapped under the sign-in password AND/OR a
      // user-set passphrase (Slice 2), so a new device restores from whichever
      // key it can supply. `passwordWrap` is kept as the kind='password' one for
      // backward compatibility with the existing auto-restore path.
      let wraps: any[] = [];
      try {
        const ws = (
          await q(
            `SELECT kind,ct,iv,kdf_salt,iterations FROM e2ee_recovery_wrap WHERE user_id=$1`,
            [userId],
          )
        ).rows;
        wraps = ws.map((w) => ({
          kind: w.kind || "password",
          ct: w.ct,
          iv: w.iv,
          salt: w.kdf_salt,
          iterations: w.iterations,
        }));
      } catch (_) {
        /* wrap table missing / pre-migration → backup still served without wraps */
      }
      const passwordWrap = wraps.find((w) => w.kind === "password") || null;
      return {
        salt: rows[0].salt,
        version: rows[0].version,
        passwordWrap,
        wraps,
        chunks: rows.map((r) => ({
          index: r.chunk_index,
          count: r.chunk_count,
          ciphertext: r.ciphertext,
          iv: r.iv,
        })),
      };
    },
    // Backup METADATA only — salt, version, wraps, a size summary and the FIRST
    // chunk as a probe, but not the chunk ciphertext. Lets clients check "is
    // there a backup / which wraps exist / does my key still open it" without
    // downloading the whole (full-history) backup. Still opaque to the driver.
    async getRecoveryBackupMeta(userId) {
      const { rows } = await q(
        `SELECT salt, version, chunk_index, chunk_count, ciphertext, iv, byte_len
           FROM e2ee_recovery_backup
          WHERE user_id=$1
          ORDER BY chunk_index ASC`,
        [userId],
      );
      if (!rows.length) return null;
      let wraps: any[] = [];
      try {
        const ws = (
          await q(
            `SELECT kind,ct,iv,kdf_salt,iterations FROM e2ee_recovery_wrap WHERE user_id=$1`,
            [userId],
          )
        ).rows;
        wraps = ws.map((w) => ({
          kind: w.kind || "password",
          ct: w.ct,
          iv: w.iv,
          salt: w.kdf_salt,
          iterations: w.iterations,
        }));
      } catch (_) {
        /* wrap table missing / pre-migration → served without wraps */
      }
      return {
        salt: rows[0].salt,
        version: rows[0].version,
        chunkCount: rows.length,
        byteLen: rows.reduce((n, r) => n + (Number(r.byte_len) || 0), 0),
        passwordWrap: wraps.find((w) => w.kind === "password") || null,
        wraps,
        probe: { ciphertext: rows[0].ciphertext, iv: rows[0].iv },
      };
    },
    // Upsert ONE recovery wrap for (user, kind). Opaque base64 in/out. kind
    // defaults to 'password' for legacy callers; 'passphrase' / 'legacy-password'
    // are the Slice-2/Slice-4 kinds. The (user_id, kind) primary key lets multiple
    // wrap kinds coexist for one user.
    async putRecoveryWrap({ userId, kind, ct, iv, kdfSalt, iterations }) {
      await q(
        `INSERT INTO e2ee_recovery_wrap (user_id,kind,ct,iv,kdf_salt,iterations)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON DUPLICATE KEY UPDATE ct=VALUES(ct), iv=VALUES(iv), kdf_salt=VALUES(kdf_salt), iterations=VALUES(iterations)`,
        [userId, kind || "password", ct, iv, kdfSalt, Number(iterations) || 310000],
      );
      return { ok: true };
    },
    // Delete a single wrap kind (e.g. remove a recovery passphrase) without
    // touching the backup chunks or the other wraps.
    async deleteRecoveryWrap(userId, kind) {
      const r = await q(
        "DELETE FROM e2ee_recovery_wrap WHERE user_id=$1 AND kind=$2",
        [userId, kind || "password"],
      );
      return { deleted: (r as any).rowCount || (r as any).affectedRows || 0 };
    },
    async deleteRecoveryBackup(userId) {
      const r = await q("DELETE FROM e2ee_recovery_backup WHERE user_id=$1", [
        userId,
      ]);
      // Turning the backup off removes the password wrap with it — a wrap
      // without a backup is useless and would advertise a restore that 404s.
      try {
        await q("DELETE FROM e2ee_recovery_wrap WHERE user_id=$1", [userId]);
      } catch (_) {}
      // ...and the sealed account key: "turn off backup" leaves no recovery
      // material behind on the server.
      try {
        await q("DELETE FROM e2ee_account_key WHERE user_id=$1", [userId]);
      } catch (_) {}
      return { deleted: (r as any).rowCount || (r as any).affectedRows || 0 };
    },
    // ---- Automatic recovery: per-user SEALED account key ---------------------
    // The driver stores the sealed blob verbatim; sealing/unsealing lives in the
    // service (backend/app/src/services/e2eeEscrow.ts).
    async getAccountKey(userId) {
      const { rows } = await q("SELECT sealed FROM e2ee_account_key WHERE user_id=$1", [userId]);
      return rows.length ? String(rows[0].sealed) : null;
    },
    // Insert-if-absent: two devices of one user racing to mint a key must end
    // up with the SAME key, so a loser's insert is a no-op and the caller
    // re-reads. Returns true when THIS call created the row.
    async putAccountKeyIfAbsent({ userId, sealed }) {
      const r = await q(
        `INSERT INTO e2ee_account_key (user_id, sealed) VALUES ($1,$2)
         ON DUPLICATE KEY UPDATE user_id=user_id`,
        [userId, sealed],
      );
      return ((r as any).affectedRows || (r as any).rowCount || 0) === 1;
    },
    async deleteAccountKey(userId) {
      const r = await q("DELETE FROM e2ee_account_key WHERE user_id=$1", [userId]);
      return { deleted: (r as any).rowCount || (r as any).affectedRows || 0 };
    },
  };
  const recordings = {
    async create(meetingId, startedBy, egressId) {
      const id = genId();
      await q(
        "INSERT INTO meeting_recordings (id,meeting_id,started_by,egress_id) VALUES ($1,$2,$3,$4)",
        [id, meetingId, startedBy, egressId || null],
      );
      const r = (await q("SELECT * FROM meeting_recordings WHERE id=$1 AND deleted=0", [id]))
        .rows[0];
      return mapRec(r);
    },
    async finish(id, patch) {
      await q(
        `UPDATE meeting_recordings SET
             status=COALESCE($2,status), ended_at=COALESCE($3,ended_at),
             storage_key=COALESCE($4,storage_key), playback_url=COALESCE($5,playback_url),
             duration_sec=COALESCE($6,duration_sec), size_bytes=COALESCE($7,size_bytes)
           WHERE id=$1`,
        [
          id,
          patch.status ?? null,
          patch.endedAt ?? null,
          patch.storageKey ?? null,
          patch.playbackUrl ?? null,
          patch.durationSec ?? null,
          patch.sizeBytes ?? null,
        ],
      );
      const r = (await q("SELECT * FROM meeting_recordings WHERE id=$1 AND deleted=0", [id]))
        .rows[0];
      return r ? mapRec(r) : null;
    },
    async listForMeeting(meetingId) {
      return (
        await q(
          "SELECT * FROM meeting_recordings WHERE meeting_id=$1 AND deleted=0 ORDER BY created_at DESC",
          [meetingId],
        )
      ).rows.map(mapRec);
    },
    async getById(id) {
      const r = (await q("SELECT * FROM meeting_recordings WHERE id=$1 AND deleted=0", [id]))
        .rows[0];
      return r ? mapRec(r) : null;
    },
    async findByEgress(egressId) {
      const r = (
        await q("SELECT * FROM meeting_recordings WHERE egress_id=$1 AND deleted=0", [
          egressId,
        ])
      ).rows[0];
      return r ? mapRec(r) : null;
    },
    async remove(id) {
      const r = await q("UPDATE meeting_recordings SET deleted=1, deleted_at=now(3) WHERE id=$1 AND deleted=0", [id]);
      return { id, deleted: (r.rowCount || 0) > 0 };
    },
    async deleteOlderThan(days) {
      // Retention: soft-delete aged recordings. A separate blob-GC job purges the
      // storage objects after the row has been soft-deleted (rows no longer cascade).
      const r = await q(
        "UPDATE meeting_recordings SET deleted=1, deleted_at=now(3) WHERE created_at < now() - INTERVAL $1 DAY AND deleted=0",
        [Number(days)],
      );
      return { count: r.rowCount || 0 };
    },
  };
  // Persisted in-meeting chat (audit trail + survives rejoin).
  const meetingMessages = {
    async add({ meetingId, senderId, body, file }) {
      const id = genId();
      await q(
        "INSERT INTO meeting_messages (id,meeting_id,sender_id,body,file_json) VALUES ($1,$2,$3,$4,$5)",
        [id, meetingId, senderId, body || null, file ? JSON.stringify(file) : null],
      );
      const r = (await q("SELECT * FROM meeting_messages WHERE id=$1", [id])).rows[0];
      return r && {
        id: r.id,
        meetingId: r.meeting_id,
        senderId: r.sender_id,
        body: r.body || "",
        file: r.file_json || null,
        createdAt: r.created_at,
      };
    },
    async listRecent(meetingId, limit = 100) {
      const lim = Math.max(1, Math.min(500, Number(limit) || 100));
      const rows = (await q(
        "SELECT * FROM meeting_messages WHERE meeting_id=$1 AND deleted=0 ORDER BY created_at DESC, id DESC LIMIT $2",
        [meetingId, lim],
      )).rows;
      return rows.reverse().map((r) => ({
        id: r.id,
        meetingId: r.meeting_id,
        senderId: r.sender_id,
        body: r.body || "",
        file: r.file_json || null,
        createdAt: r.created_at,
      }));
    },
    // Meetings in whose chat this file was shared (used to authorize downloads
    // of meeting-chat attachments for every participant, not just the uploader).
    async meetingIdsForFile(fileId) {
      if (!fileId) return [];
      const rows = (
        await q(
          "SELECT DISTINCT meeting_id FROM meeting_messages WHERE deleted=0 AND JSON_UNQUOTE(JSON_EXTRACT(file_json, '$.id')) = $1",
          [fileId],
        )
      ).rows;
      return rows.map((r) => r.meeting_id);
    },
  };
  function mapBroadcast(r) {
    return {
      id: r.id,
      organizationId: r.organization_id,
      authorId: r.author_id,
      authorName: r.author_name || null,
      title: r.title,
      body: r.body || "",
      sendAt: r.send_at || null,
      status: r.status || "sent",
      fileId: r.file_id || null,
      createdAt: r.created_at,
    };
  }
  function mapScheduled(r) {
    return {
      id: r.id,
      conversationId: r.conversation_id,
      senderId: r.sender_id,
      body: r.body,
      sendAt: r.send_at,
      status: r.status,
      sentMessageId: r.sent_message_id,
      error: r.error,
      // E2EE envelope (per-device array) delivered at send time; null for
      // plaintext/legacy/non-E2EE scheduled messages.
      ciphertext: r.ciphertext_json || null,
      encryptionVersion: Number(r.encryption_version) || 0,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
  const scheduledMessages = {
    async create({ conversationId, senderId, body, sendAt, encrypted = null }) {
      const id = genId();
      await q(
        `INSERT INTO scheduled_messages (id,conversation_id,sender_id,body,send_at,ciphertext_json,encryption_version)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          id,
          conversationId,
          senderId,
          body,
          sendAt,
          encrypted ? JSON.stringify(encrypted) : null,
          encrypted ? 1 : 0,
        ],
      );
      const r = (await q("SELECT * FROM scheduled_messages WHERE id=$1 AND deleted=0", [id]))
        .rows[0];
      return mapScheduled(r);
    },
    async getById(id) {
      const r = (await q("SELECT * FROM scheduled_messages WHERE id=$1 AND deleted=0", [id]))
        .rows[0];
      return r ? mapScheduled(r) : null;
    },
    async listForConversation(conversationId, senderId) {
      const rows = (
        await q(
          `SELECT * FROM scheduled_messages
           WHERE conversation_id=$1 AND sender_id=$2 AND deleted=0
             AND status IN ('scheduled','sending','failed')
           ORDER BY send_at ASC`,
          [conversationId, senderId],
        )
      ).rows;
      return rows.map(mapScheduled);
    },
    async update(id, patch) {
      const vals: any[] = [id];
      const sets: string[] = [];
      if (typeof patch.body === "string") {
        vals.push(patch.body);
        sets.push(`body=$${vals.length}`);
      }
      if (patch.sendAt) {
        vals.push(patch.sendAt);
        sets.push(`send_at=$${vals.length}`);
      }
      // A reschedule that changes the body re-encrypts on the client and sends a
      // fresh envelope (or null for non-E2EE) — keep ciphertext in lock-step with
      // body so we never deliver a stale envelope or a plaintext downgrade.
      if (patch.encrypted !== undefined) {
        vals.push(patch.encrypted ? JSON.stringify(patch.encrypted) : null);
        sets.push(`ciphertext_json=$${vals.length}`);
        vals.push(patch.encrypted ? 1 : 0);
        sets.push(`encryption_version=$${vals.length}`);
      }
      if (!sets.length) return scheduledMessages.getById(id);
      sets.push("status='scheduled'", "error=NULL", "updated_at=now()");
      await q(
        `UPDATE scheduled_messages SET ${sets.join(", ")} WHERE id=$1`,
        vals,
      );
      return scheduledMessages.getById(id);
    },
    async setStatus(id, status, opts: any = {}) {
      await q(
        `UPDATE scheduled_messages
           SET status=$2, sent_message_id=COALESCE($3,sent_message_id),
               error=$4, updated_at=now()
           WHERE id=$1`,
        [id, status, opts.sentMessageId || null, opts.error || null],
      );
      return scheduledMessages.getById(id);
    },
    async remove(id) {
      const r = await q("UPDATE scheduled_messages SET deleted=1, deleted_at=now(3) WHERE id=$1 AND deleted=0", [id]);
      return { id, deleted: (r.rowCount || 0) > 0 };
    },
    async claimDue(nowIso, limit) {
      // MySQL has no RETURNING and forbids UPDATE-ing a table referenced by a
      // subquery on itself, so claim atomically inside a transaction:
      // SELECT ... FOR UPDATE SKIP LOCKED, flip to 'sending', then read back.
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const lim = Number(limit) || 10;
        // send_at is stored as the UTC wall-clock (the ISO "…Z" string has its Z
        // dropped on insert into DATETIME), so it MUST be compared against UTC,
        // not now() / a session-local Date param. Using UTC_TIMESTAMP() makes due
        // detection correct regardless of the MySQL session timezone — otherwise
        // on a non-UTC session, scheduled/rescheduled messages are never claimed.
        const [picked]: any = await conn.query(
          `SELECT id FROM scheduled_messages
             WHERE deleted=0 AND ((status='scheduled' AND send_at <= UTC_TIMESTAMP())
                OR (status='sending' AND updated_at < now() - INTERVAL 2 MINUTE))
             ORDER BY send_at ASC
             LIMIT ${lim}
             FOR UPDATE SKIP LOCKED`,
          [],
        );
        const ids = picked.map((r) => r.id);
        if (!ids.length) {
          await conn.commit();
          return [];
        }
        await conn.query(
          `UPDATE scheduled_messages SET status='sending', updated_at=now() WHERE id IN (?)`,
          [ids],
        );
        const [rows]: any = await conn.query(
          `SELECT * FROM scheduled_messages WHERE id IN (?)`,
          [ids],
        );
        await conn.commit();
        return rows.map(mapScheduled);
      } catch (e) {
        try {
          await conn.rollback();
        } catch {
          /* ignore */
        }
        throw e;
      } finally {
        conn.release();
      }
    },
  };
  function mapNotif(r) {
    return {
      id: r.id,
      userId: r.user_id,
      type: r.type,
      title: r.title,
      body: r.body || null,
      actorId: r.actor_id || null,
      targetType: r.target_type || null,
      targetId: r.target_id || null,
      conversationId: r.conversation_id || null,
      isRead: !!r.is_read,
      createdAt: r.created_at,
    };
  }
  const notifications = {
    async create({ userId, type, title, body, actorId, targetType, targetId, conversationId, dedupKey }) {
      const id = genId();
      // Organizations: tag with the CONTENT's tenant — the parent conversation's
      // org when present (authoritative for chat/mention/reaction notifications),
      // else the actor's active org (in-request). Notification READS stay
      // user-scoped, so a fire-tick notification with no conversation + no request
      // (e.g. a reminder firing) simply lands NULL-org, which is harmless until the
      // inbox is org-scoped (then thread the source org through like reminders).
      const orgId = currentOrgId();
      const cols =
        "id,user_id,type,title,body,actor_id,target_type,target_id,conversation_id,organization_id,dedup_key";
      const vals =
        "$1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE((SELECT organization_id FROM conversations WHERE id=$9),$10),$11";
      const params = [id, userId, type, title, body || null, actorId || null, targetType || null, targetId || null, conversationId || null, orgId, dedupKey || null];
      if (dedupKey) {
        // Idempotent insert: the UNIQUE (user_id, dedup_key) index makes a repeat
        // (same occurrence/target/user) a no-op. INSERT IGNORE → affectedRows 0 on
        // a duplicate; return null so the caller ALSO skips the live pushNotif
        // re-emit (every meeting notify site is guarded `if (n && io) push…`).
        const r = await q(`INSERT IGNORE INTO notifications (${cols}) VALUES (${vals})`, params);
        if (!((r.rowCount || 0) > 0)) return null;
      } else {
        // No dedup key → NULL never collides in the unique index, so un-keyed
        // notification types keep their exact prior behaviour (one row per call).
        await q(`INSERT INTO notifications (${cols}) VALUES (${vals})`, params);
      }
      const r = (await q("SELECT * FROM notifications WHERE id=$1", [id])).rows[0];
      return r ? mapNotif(r) : null;
    },
    async listForUser(userId, { limit = 50, beforeId = null } = {}) {
      if (beforeId) {
        const { clause, params } = orgFilter([userId, beforeId]);
        const rows = (
          await q(
            `SELECT * FROM notifications WHERE user_id=$1 AND deleted=0
               AND (created_at, id) < ((SELECT created_at FROM notifications WHERE id=$2), $2)${clause}
               ORDER BY created_at DESC, id DESC LIMIT ${Number(limit) || 50}`,
            params,
          )
        ).rows;
        return rows.map(mapNotif);
      }
      const { clause, params } = orgFilter([userId]);
      return (
        await q(
          `SELECT * FROM notifications WHERE user_id=$1 AND deleted=0${clause} ORDER BY created_at DESC LIMIT ${Number(limit) || 50}`,
          params,
        )
      ).rows.map(mapNotif);
    },
    async unreadCount(userId) {
      const { clause, params } = orgFilter([userId]);
      const r = (
        await q(`SELECT COUNT(*) AS n FROM notifications WHERE user_id=$1 AND deleted=0 AND is_read=false${clause}`, params)
      ).rows[0];
      return Number(r?.n) || 0;
    },
    async markRead(userId, notificationId) {
      const { clause, params } = orgFilter([notificationId, userId]);
      await q(`UPDATE notifications SET is_read=true WHERE id=$1 AND user_id=$2${clause}`, params);
    },
    async markAllRead(userId) {
      const { clause, params } = orgFilter([userId]);
      await q(`UPDATE notifications SET is_read=true WHERE user_id=$1 AND is_read=false${clause}`, params);
    },
    async remove(userId, notificationId) {
      const { clause, params } = orgFilter([notificationId, userId]);
      const r = await q(`UPDATE notifications SET deleted=1, deleted_at=now(3), deleted_by=$2 WHERE id=$1 AND user_id=$2 AND deleted=0${clause}`, params);
      return { id: notificationId, deleted: (r.rowCount || 0) > 0 };
    },
  };
  const blocks = {
    async block(blockerId, blockedId, reason) {
      // Organizations: stamp the blocker's active tenant (in-request). Block READS
      // stay UNSCOPED — a block is a cross-user relationship checked in BOTH
      // directions (isBlockedEitherWay), so an org filter would hide a legit block.
      const orgId = currentOrgId();
      await q(
        `INSERT INTO user_blocks (blocker_id, blocked_id, reason, organization_id) VALUES ($1,$2,$3,$4)
           AS new ON DUPLICATE KEY UPDATE reason=new.reason, organization_id=new.organization_id, deleted=0, deleted_at=NULL`,
        [blockerId, blockedId, reason || null, orgId],
      );
      return { blockerId, blockedId };
    },
    async unblock(blockerId, blockedId) {
      const r = await q(
        "UPDATE user_blocks SET deleted=1, deleted_at=now(3) WHERE blocker_id=$1 AND blocked_id=$2 AND deleted=0",
        [blockerId, blockedId],
      );
      return { blockerId, blockedId, removed: (r.rowCount || 0) > 0 };
    },
    // Is there a block in EITHER direction between the two users?
    async isBlockedEitherWay(a, b) {
      const r = await q(
        `SELECT 1 FROM user_blocks
           WHERE ((blocker_id=$1 AND blocked_id=$2)
              OR (blocker_id=$2 AND blocked_id=$1)) AND deleted=0 LIMIT 1`,
        [a, b],
      );
      return r.rows.length > 0;
    },
    async listBlocked(blockerId) {
      return (
        await q(
          "SELECT blocked_id, reason, created_at FROM user_blocks WHERE blocker_id=$1 AND deleted=0",
          [blockerId],
        )
      ).rows.map((r) => ({ userId: r.blocked_id, reason: r.reason, createdAt: r.created_at }));
    },
    async report(reporterId, reportedId, reason) {
      const id = genId();
      // Organizations: stamp the reporter's active tenant (in-request); reads stay
      // reporter-scoped (a report is the reporter's own record).
      const orgId = currentOrgId();
      await q(
        "INSERT INTO user_reports (id, reporter_id, reported_id, reason, organization_id) VALUES ($1,$2,$3,$4,$5)",
        [id, reporterId, reportedId, (reason || "").slice(0, 512) || null, orgId],
      );
      return { id };
    },
    async listReports(reporterId) {
      return (
        await q(
          "SELECT id, reported_id, reason, created_at FROM user_reports WHERE reporter_id=$1 AND deleted=0 ORDER BY created_at DESC",
          [reporterId],
        )
      ).rows.map((r) => ({ id: r.id, userId: r.reported_id, reason: r.reason, createdAt: r.created_at }));
    },
    async removeReport(reporterId, reportId) {
      const r = await q(
        "UPDATE user_reports SET deleted=1, deleted_at=now(3) WHERE id=$1 AND reporter_id=$2 AND deleted=0",
        [reportId, reporterId],
      );
      return { id: reportId, removed: (r.rowCount || 0) > 0 };
    },
  };
  // ── Telemetry: server-side client-error aggregation ──────────────────────
  // Cost-free production observability. recordClientError UPSERTs by fingerprint
  // so a recurring error is ONE row (count bumps), never millions — the table
  // cannot be flooded. The caller (telemetryService) computes the fingerprint and
  // enforces size caps; this layer only persists. listClientErrors/​purgeOld feed
  // the admin dashboard and the hourly retention sweeper.
  // AUTH SESSIONS (#66): durable login sessions the user can list + revoke. The
  // session `id` is embedded in the JWT as `jti`; the auth middleware looks it up
  // on each authed request and 401s a revoked/expired one. `last_active_at` is
  // bumped THROTTLED (the middleware gates this to >= 60s) so it is not a per-
  // request write. Reads/writes here are PK or (user_id)-index scoped — cheap.
  const mapSession = (r) =>
    r && {
      id: r.id,
      userId: r.user_id,
      deviceLabel: r.device_label || null,
      deviceType: r.device_type || null,
      browser: r.browser || null,
      os: r.os || null,
      userAgent: r.user_agent || null,
      ip: r.ip || null,
      city: r.city || null,
      country: r.country || null,
      platform: r.platform || "web",
      createdAt: r.created_at,
      lastActiveAt: r.last_active_at,
      expiresAt: r.expires_at,
      revoked: !!r.revoked,
      revokedAt: r.revoked_at || null,
      // Computed lifecycle status. IDLE once no activity for >5min (last_active_at
      // is bumped throttled at ~60s), EXPIRED past expires_at, REVOKED if flagged.
      status: (() => {
        if (r.revoked) return "revoked";
        const exp = r.expires_at ? new Date(r.expires_at).getTime() : 0;
        if (exp && exp <= Date.now()) return "expired";
        const la = r.last_active_at ? new Date(r.last_active_at).getTime() : 0;
        return la && Date.now() - la <= 5 * 60 * 1000 ? "active" : "idle";
      })(),
    };
  const sessions = {
    // Mint a session row on login/signup. `id` becomes the JWT jti. `expiresAt`
    // is the durable anchor (~30d) so users stay logged in across restarts.
    async create({
      id,
      userId,
      deviceLabel = null,
      deviceType = null,
      browser = null,
      os = null,
      userAgent = null,
      ip = null,
      city = null,
      country = null,
      platform = "web",
      expiresAt,
    }: {
      id: string;
      userId: string;
      deviceLabel?: string | null;
      deviceType?: string | null;
      browser?: string | null;
      os?: string | null;
      userAgent?: string | null;
      ip?: string | null;
      city?: string | null;
      country?: string | null;
      platform?: string;
      expiresAt: Date | string;
    }) {
      const cap = (v: any, n: number) => (v ? String(v).slice(0, n) : null);
      await q(
        `INSERT INTO auth_sessions
           (id, user_id, device_label, device_type, browser, os, user_agent, ip, city, country, platform, expires_at, active_org_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
           (SELECT organization_id FROM organization_members
              WHERE user_id=$2 AND status='active' AND deleted=0
              ORDER BY (role='owner') DESC, (role='admin') DESC, created_at ASC
              LIMIT 1))`,
        [
          id,
          userId,
          cap(deviceLabel, 255),
          cap(deviceType, 16),
          cap(browser, 48),
          cap(os, 48),
          cap(userAgent, 512),
          cap(ip, 64),
          cap(city, 96),
          cap(country, 96),
          platform === "desktop" ? "desktop" : "web",
          expiresAt,
        ],
      );
      return { id, userId };
    },
    // HOT PATH: validity check for the auth middleware. Single PK lookup; returns
    // a tiny shape (or null when the row doesn't exist). The CALLER decides what a
    // null/throw means — a missing row is treated as "unknown jti → allow" (a
    // legacy/foreign token), only an explicitly revoked/expired row is rejected.
    async getForAuth(id) {
      const r = (
        await q(
          "SELECT id, user_id, revoked, expires_at, active_org_id FROM auth_sessions WHERE id=$1",
          [id],
        )
      ).rows[0];
      return r
        ? {
            id: r.id,
            userId: r.user_id,
            revoked: !!r.revoked,
            expiresAt: r.expires_at,
            // Organizations: the session's active tenant (may be NULL on a legacy
            // session — the middleware resolves the user's primary org in that case).
            activeOrgId: r.active_org_id || null,
          }
        : null;
    },
    // Throttled last-active bump: only writes when the stored last_active_at is
    // older than `minGapSec` seconds, so a burst of requests is a single write.
    // Fire-and-forget from the middleware; never blocks the response.
    async touch(id, minGapSec = 60) {
      const gap = Math.max(1, Number(minGapSec) || 60);
      await q(
        `UPDATE auth_sessions
            SET last_active_at = now(3)
          WHERE id=$1
            AND last_active_at < now(3) - INTERVAL ${gap} SECOND`,
        [id],
      );
    },
    // Switch the caller's active org (Org switcher, #70). IDOR-guarded by user_id —
    // the ROUTE first verifies the user is a member of targetOrgId (can't set a
    // tenant you don't belong to). Updating the session row is enough: the auth
    // middleware reads active_org_id fresh each request, so no token re-issue.
    async setActiveOrg(sessionId, userId, orgId) {
      const r = await q(
        `UPDATE auth_sessions SET active_org_id=$3 WHERE id=$1 AND user_id=$2 AND deleted=0`,
        [sessionId, userId, orgId || null],
      );
      return { updated: (r.rowCount || 0) > 0 };
    },
    // Count the user's ACTIVE sessions (not revoked, not expired) — backs the
    // concurrent-session limit check at login.
    async countActive(userId) {
      const r = (
        await q(
          `SELECT COUNT(*) AS n FROM auth_sessions
            WHERE user_id=$1 AND revoked=0 AND deleted=0 AND expires_at > now(3)`,
          [userId],
        )
      ).rows[0];
      return Number((r && r.n) || 0);
    },
    // ── Session GC (Session Mgmt Phase 5) ────────────────────────────────────
    // Ids of still-active sessions past their expires_at — for the GC sweep to
    // revoke + live-disconnect (they're already 401'd per-request; this reclaims
    // the row and cuts any lingering socket). Bounded batch.
    async listExpiredActive(limit = 500) {
      const n = Math.max(1, Math.min(5000, Math.floor(Number(limit) || 500)));
      return (
        await q(
          `SELECT id FROM auth_sessions
            WHERE revoked=0 AND deleted=0 AND expires_at <= now(3)
            ORDER BY expires_at ASC LIMIT ${n}`,
          [],
        )
      ).rows.map((r) => r.id);
    },
    // Ids of active sessions idle beyond their org's idle_timeout_min (Phase 4
    // policy). A session's tenant is its active_org_id; NULL-org (legacy) sessions
    // and orgs with no timeout are exempt. Idle = last REST activity older than the
    // window (last_active_at is bumped, throttled, on every authed request).
    async listIdleBeyondOrgPolicy(limit = 500) {
      const n = Math.max(1, Math.min(5000, Math.floor(Number(limit) || 500)));
      return (
        await q(
          `SELECT s.id
             FROM auth_sessions s
             JOIN organizations o ON o.id = s.active_org_id AND o.deleted=0
            WHERE s.revoked=0 AND s.deleted=0
              AND o.idle_timeout_min IS NOT NULL AND o.idle_timeout_min > 0
              AND s.last_active_at IS NOT NULL
              AND TIMESTAMPADD(MINUTE, o.idle_timeout_min, s.last_active_at) < now(3)
            ORDER BY s.last_active_at ASC LIMIT ${n}`,
          [],
        )
      ).rows.map((r) => r.id);
    },
    // GC-context revoke by id alone (no user scoping — the sweep already selected
    // the row). Idempotent: only flips a not-yet-revoked row.
    async revokeById(sessionId) {
      const r = await q(
        `UPDATE auth_sessions SET revoked=1, revoked_at=now(3) WHERE id=$1 AND revoked=0`,
        [sessionId],
      );
      return (r.rowCount || 0) > 0;
    },
    // The user's own sessions, newest first. Excludes soft-deleted rows. Returns
    // revoked ones too (the UI greys them) unless includeRevoked=false.
    async listForUser(userId, { includeRevoked = true } = {}) {
      const revFilter = includeRevoked ? "" : " AND revoked=0";
      return (
        await q(
          `SELECT * FROM auth_sessions
            WHERE user_id=$1 AND deleted=0${revFilter}
            ORDER BY created_at DESC
            LIMIT 100`,
          [userId],
        )
      ).rows.map(mapSession);
    },
    // Revoke ONE of the caller's sessions (IDOR-guarded by the user_id predicate —
    // a session id that isn't the caller's is a no-op, never another user's row).
    // Returns true only if a row was actually revoked.
    async revoke(userId, sessionId) {
      const r = await q(
        `UPDATE auth_sessions
            SET revoked=1, revoked_at=now(3)
          WHERE id=$1 AND user_id=$2 AND revoked=0`,
        [sessionId, userId],
      );
      return (r.rowCount || 0) > 0;
    },
    // Revoke all the caller's OTHER sessions (everything except `keepSessionId`).
    async revokeOthers(userId, keepSessionId) {
      const r = await q(
        `UPDATE auth_sessions
            SET revoked=1, revoked_at=now(3)
          WHERE user_id=$1 AND id<>$2 AND revoked=0 AND deleted=0`,
        [userId, keepSessionId || ""],
      );
      return { revoked: r.rowCount || 0 };
    },
    // Revoke EVERY active session for a user — the force-logout primitive behind an
    // admin password reset. NOT caller/IDOR-scoped (the actor is an admin acting ON
    // the target user); the auth middleware 401s each device on its next request.
    async revokeAllForUser(userId) {
      const r = await q(
        `UPDATE auth_sessions
            SET revoked=1, revoked_at=now(3)
          WHERE user_id=$1 AND revoked=0 AND deleted=0`,
        [userId],
      );
      return { revoked: r.rowCount || 0 };
    },
  };

  // ── Refresh-token rotation (Session Mgmt Phase 5) ──────────────────────────
  // Opaque refresh tokens, stored HASHED, bound to a session (session_id = jti =
  // the token "family"). Rotation is single-use: markUsed flips 0→1 exactly once,
  // so the tightest concurrent-refresh race can't rotate twice; the loser is told
  // to retry (NOT treated as theft). A token re-presented AFTER its grace window
  // is a genuine replay → the service revokes the whole family + its session.
  const refreshTokens = {
    async issue({ id, sessionId, userId, tokenHash, expiresAt }) {
      await q(
        `INSERT INTO auth_refresh_tokens (id, session_id, user_id, token_hash, expires_at)
           VALUES ($1,$2,$3,$4,$5)`,
        [id, sessionId, userId, tokenHash, expiresAt],
      );
      return { id };
    },
    async findByHash(tokenHash) {
      const r = (
        await q(
          `SELECT id, session_id, user_id, used, revoked, expires_at, used_at
             FROM auth_refresh_tokens WHERE token_hash=$1`,
          [tokenHash],
        )
      ).rows[0];
      return r
        ? {
            id: r.id,
            sessionId: r.session_id,
            userId: r.user_id,
            used: !!r.used,
            revoked: !!r.revoked,
            expiresAt: r.expires_at,
            usedAt: r.used_at || null,
          }
        : null;
    },
    // Flip 0→1 atomically. Returns true ONLY for the winner, so two concurrent
    // refreshes with the same token can never both rotate.
    async markUsed(id) {
      const r = await q(
        `UPDATE auth_refresh_tokens SET used=1, used_at=now(3) WHERE id=$1 AND used=0 AND revoked=0`,
        [id],
      );
      return (r.rowCount || 0) > 0;
    },
    // Revoke every refresh token in a family (logout / reuse-detected / admin revoke).
    async revokeFamily(sessionId) {
      const r = await q(
        `UPDATE auth_refresh_tokens SET revoked=1 WHERE session_id=$1 AND revoked=0`,
        [sessionId],
      );
      return { revoked: r.rowCount || 0 };
    },
    // Revoke ALL of a user's refresh tokens across every session — the token-side
    // of account deletion / global force-logout (mirrors sessions.revokeAllForUser).
    async revokeAllForUser(userId) {
      const r = await q(
        `UPDATE auth_refresh_tokens SET revoked=1 WHERE user_id=$1 AND revoked=0`,
        [userId],
      );
      return { revoked: r.rowCount || 0 };
    },
    // Housekeeping: drop rows well past expiry (called from the session-GC tick).
    async purgeExpired(days = 7) {
      const d = Math.max(0, Math.floor(Number(days) || 7));
      const r = await q(
        `DELETE FROM auth_refresh_tokens WHERE expires_at < now(3) - INTERVAL ${d} DAY`,
        [],
      );
      return { purged: r.rowCount || 0 };
    },
  };

  // ── MFA (TOTP second factor + single-use backup codes) ─────────────────────
  // The secret is stored SEALED (AES-256-GCM) by the service layer — this driver
  // only persists opaque strings, never a raw TOTP seed.
  const mfa = {
    async getEnrollment(userId, method = "totp") {
      const r = (
        await q(
          `SELECT user_id, method, secret_enc, confirmed_at, created_at, last_step
             FROM mfa_enrollments WHERE user_id=$1 AND method=$2`,
          [userId, method],
        )
      ).rows[0];
      return r
        ? {
            userId: r.user_id,
            method: r.method,
            secretEnc: r.secret_enc,
            confirmedAt: r.confirmed_at || null,
            createdAt: r.created_at,
            lastStep: r.last_step == null ? null : Number(r.last_step),
          }
        : null;
    },
    // TOTP anti-replay: record the accepted time-step ONLY if it advances past the
    // last one (atomic compare-and-set). Returns true for the winner, so the same
    // code — or any earlier step — can never be redeemed twice, even concurrently.
    async bumpTotpStep(userId, counter, method = "totp") {
      const r = await q(
        `UPDATE mfa_enrollments SET last_step=$3
           WHERE user_id=$1 AND method=$2 AND (last_step IS NULL OR last_step < $3)`,
        [userId, method, counter],
      );
      return (r.rowCount || 0) > 0;
    },
    // Begin (or restart) enrollment: store the sealed secret as PENDING
    // (confirmed_at NULL), replacing any prior secret so a re-enroll starts clean.
    async upsertPending(userId, secretEnc, method = "totp") {
      await q(
        `INSERT INTO mfa_enrollments (user_id, method, secret_enc, confirmed_at)
           VALUES ($1,$2,$3,NULL)
         ON DUPLICATE KEY UPDATE secret_enc=$3, confirmed_at=NULL, created_at=CURRENT_TIMESTAMP(3)`,
        [userId, method, secretEnc],
      );
      return { userId, method };
    },
    // Confirm a pending enrollment on the first valid code. True iff a row moved
    // pending → confirmed.
    async confirm(userId, method = "totp") {
      const r = await q(
        `UPDATE mfa_enrollments SET confirmed_at=CURRENT_TIMESTAMP(3)
           WHERE user_id=$1 AND method=$2 AND confirmed_at IS NULL`,
        [userId, method],
      );
      return (r.rowCount || 0) > 0;
    },
    // Disable MFA: drop the enrollment(s) AND all backup codes for the user.
    async remove(userId, method) {
      if (method) await q(`DELETE FROM mfa_enrollments WHERE user_id=$1 AND method=$2`, [userId, method]);
      else await q(`DELETE FROM mfa_enrollments WHERE user_id=$1`, [userId]);
      await q(`DELETE FROM mfa_backup_codes WHERE user_id=$1`, [userId]);
      return { removed: true };
    },
    // Replace the user's whole backup-code set (fresh 10 on enroll / regenerate).
    // ATOMIC: DELETE + bulk INSERT in one transaction so a mid-write failure can
    // never leave the user with fewer codes than the client just displayed.
    async replaceBackupCodes(userId, rows) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        await conn.query(`DELETE FROM mfa_backup_codes WHERE user_id=?`, [userId]);
        if (rows.length) {
          await conn.query(
            `INSERT INTO mfa_backup_codes (id, user_id, code_hash) VALUES ?`,
            [rows.map((c) => [c.id, userId, c.codeHash])],
          );
        }
        await conn.commit();
        return { count: rows.length };
      } catch (e) {
        try {
          await conn.rollback();
        } catch {
          /* ignore */
        }
        throw e;
      } finally {
        conn.release();
      }
    },
    // Atomically consume ONE matching unused code — winner-only, so a code can
    // never be redeemed twice even under concurrent attempts.
    async consumeBackupCode(userId, codeHash) {
      const r = await q(
        `UPDATE mfa_backup_codes SET used_at=CURRENT_TIMESTAMP(3)
           WHERE user_id=$1 AND code_hash=$2 AND used_at IS NULL LIMIT 1`,
        [userId, codeHash],
      );
      return (r.rowCount || 0) > 0;
    },
    async countUnusedBackupCodes(userId) {
      const r = (
        await q(`SELECT COUNT(*) AS n FROM mfa_backup_codes WHERE user_id=$1 AND used_at IS NULL`, [userId])
      ).rows[0];
      return Number((r && r.n) || 0);
    },
  };

  // ── Custom stickers / GIFs (WhatsApp-style personal tray) ──────────────────
  const mapSticker = (r) =>
    r && {
      id: r.id,
      ownerId: r.owner_id,
      orgId: r.org_id || null,
      storageKey: r.storage_key,
      mime: r.mime,
      name: r.name || null,
      kind: r.kind || "sticker",
      width: r.width != null ? Number(r.width) : null,
      height: r.height != null ? Number(r.height) : null,
      createdAt: r.created_at,
    };
  const stickers = {
    async create({ id, ownerId, orgId, storageKey, mime, name, kind, width, height }) {
      await q(
        `INSERT INTO custom_stickers (id, owner_id, org_id, storage_key, mime, name, kind, width, height)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id, ownerId, orgId || null, storageKey, mime, (name || "").slice(0, 120) || null, kind || "sticker", width || null, height || null],
      );
      return { id };
    },
    // A user's tray, newest first. Bounded — a personal tray is small by nature.
    async listForUser(ownerId, limit = 120) {
      const n = Math.max(1, Math.min(500, Math.floor(Number(limit) || 120)));
      return (
        await q(
          `SELECT * FROM custom_stickers WHERE owner_id=$1 AND deleted=0 ORDER BY created_at DESC LIMIT ${n}`,
          [ownerId],
        )
      ).rows.map(mapSticker);
    },
    // Public fetch by id (for the no-auth serve route) — returns even a foreign
    // user's sticker (they're shareable), but never a soft-deleted one.
    async get(id) {
      const r = (await q(`SELECT * FROM custom_stickers WHERE id=$1 AND deleted=0`, [id])).rows[0];
      return mapSticker(r);
    },
    async softDelete(id, ownerId) {
      const r = await q(
        `UPDATE custom_stickers SET deleted=1 WHERE id=$1 AND owner_id=$2 AND deleted=0`,
        [id, ownerId],
      );
      return (r.rowCount || 0) > 0;
    },
  };

  // POST-CALL / POST-MEETING FEEDBACK (#67). Pure analytics sink — written by the
  // feedback route after a connected call/meeting ends normally, never read on any
  // call/meeting hot path (so it can't destabilize the media plane). `categories`
  // is stored as a compact JSON blob for future quality dashboards.
  const callFeedback = {
    async create({
      userId,
      kind = "call",
      callId = null,
      meetingId = null,
      feedbackType = "good",
      categories = null,
      comment = null,
      durationSec = 0,
      networkQuality = null,
      platform = "web",
      os = null,
      browser = null,
      appVersion = null,
      buildNumber = null,
      diagnostics = null,
    }: {
      userId: string;
      kind?: string;
      callId?: string | null;
      meetingId?: string | null;
      feedbackType?: string;
      categories?: any;
      comment?: string | null;
      durationSec?: number;
      networkQuality?: string | null;
      platform?: string;
      os?: string | null;
      browser?: string | null;
      appVersion?: string | null;
      buildNumber?: string | null;
      // Session Replay Lite (migration 0071): the client's diagnostics timeline
      // for the session this feedback refers to. Route-capped at 100KB.
      diagnostics?: string | null;
    }) {
      const id = genId();
      await q(
        `INSERT INTO call_feedback
           (id, user_id, kind, call_id, meeting_id, feedback_type, categories,
            comment, duration_sec, network_quality, platform, os, browser,
            app_version, build_number, diagnostics)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [
          id,
          userId,
          kind === "meeting" ? "meeting" : "call",
          callId ? String(callId).slice(0, 64) : null,
          meetingId ? String(meetingId).slice(0, 36) : null,
          feedbackType === "issues" ? "issues" : "good",
          categories ? JSON.stringify(categories) : JSON.stringify({}),
          comment ? String(comment).slice(0, 1000) : null,
          Math.max(0, Math.floor(Number(durationSec) || 0)),
          networkQuality ? String(networkQuality).slice(0, 16) : null,
          platform === "desktop" ? "desktop" : "web",
          os ? String(os).slice(0, 64) : null,
          browser ? String(browser).slice(0, 64) : null,
          appVersion ? String(appVersion).slice(0, 32) : null,
          buildNumber ? String(buildNumber).slice(0, 32) : null,
          diagnostics ? String(diagnostics).slice(0, 100_000) : null,
        ],
      );
      return { id };
    },
  };

  const telemetry = {
    // §9.2 usage counters: one row per (event name, UTC day), bumped in place.
    async bumpEvents(names: string[]) {
      const day = new Date().toISOString().slice(0, 10);
      for (const name of names) {
        await q(
          `INSERT INTO telemetry_events (name, day, count) VALUES ($1,$2,1) AS new
           ON DUPLICATE KEY UPDATE count = telemetry_events.count + 1`,
          [name, day],
        );
      }
    },
    async eventSummary(days = 7) {
      const rows = (
        await q(
          `SELECT name, day, count FROM telemetry_events
           WHERE day >= DATE_SUB(CURDATE(), INTERVAL $1 DAY)
           ORDER BY day DESC, name`,
          [Math.max(1, Math.min(90, days))],
        )
      ).rows;
      return rows.map((r: any) => ({ name: r.name, day: r.day, count: Number(r.count) }));
    },
    async recordClientError({
      fingerprint,
      userId = null,
      level = "error",
      category = "general",
      message,
      stack = null,
      url = null,
      userAgent = null,
      context = null,
      appVersion = null,
    }: {
      fingerprint: string;
      userId?: string | null;
      level?: string;
      category?: string | null;
      message: string;
      stack?: string | null;
      url?: string | null;
      userAgent?: string | null;
      context?: any;
      appVersion?: string | null;
    }) {
      const ctxJson = context == null ? null : typeof context === "string" ? context : JSON.stringify(context);
      await q(
        `INSERT INTO client_errors
           (id, fingerprint, user_id, level, category, message, stack, url, user_agent, context, app_version, count, first_seen, last_seen)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1,now(3),now(3)) AS new
         ON DUPLICATE KEY UPDATE
           count       = client_errors.count + 1,
           last_seen   = now(3),
           -- keep the freshest context for the same fingerprint
           message     = new.message,
           stack       = new.stack,
           url         = new.url,
           user_agent  = new.user_agent,
           context     = COALESCE(new.context, client_errors.context),
           app_version = new.app_version,
           category    = new.category,
           user_id     = COALESCE(new.user_id, client_errors.user_id),
           level       = new.level,
           -- A recurrence AFTER a manual resolve is a real regression signal, so
           -- reopen the row → it returns to Active (matches error_logs, whose
           -- open-scoped index inserts a fresh open row on recurrence). This
           -- upsert only fires on a NEW occurrence, which by definition post-dates
           -- resolved_at, so it never reopens a still-current resolve.
           status      = IF(client_errors.status IN ('resolved','ignored'), 'open', client_errors.status),
           resolved_at = IF(client_errors.status IN ('resolved','ignored'), NULL,   client_errors.resolved_at),
           resolved_by = IF(client_errors.status IN ('resolved','ignored'), NULL,   client_errors.resolved_by),
           resolution  = IF(client_errors.status IN ('resolved','ignored'), NULL,   client_errors.resolution)`,
        [
          genId(),
          fingerprint,
          userId,
          level || "error",
          category || "general",
          message,
          stack,
          url,
          userAgent,
          ctxJson,
          appVersion,
        ],
      );
    },
    // Recent grouped errors for the operator dashboard — newest activity first.
    async listClientErrors({ limit = 100, sinceHours = 24 } = {}) {
      const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
      const hrs = Math.min(Math.max(Number(sinceHours) || 24, 1), 24 * 30);
      const rows = (
        await q(
          `SELECT id, fingerprint, user_id, level, message, stack, url, user_agent,
                  app_version, count, first_seen, last_seen
             FROM client_errors
            WHERE last_seen > now(3) - INTERVAL ${hrs} HOUR
            ORDER BY last_seen DESC
            LIMIT ${lim}`,
        )
      ).rows;
      return rows.map((r) => ({
        id: r.id,
        fingerprint: r.fingerprint,
        userId: r.user_id || null,
        level: r.level,
        message: r.message,
        stack: r.stack || null,
        url: r.url || null,
        userAgent: r.user_agent || null,
        appVersion: r.app_version || null,
        count: Number(r.count) || 0,
        firstSeen: r.first_seen,
        lastSeen: r.last_seen,
      }));
    },
    // Retention: drop groups whose newest occurrence is older than N days.
    async purgeOldClientErrors(days = 14) {
      const d = Math.min(Math.max(Number(days) || 14, 1), 365);
      const r = await q(
        `DELETE FROM client_errors WHERE last_seen < now(3) - INTERVAL ${d} DAY`,
      );
      return { purged: r.rowCount || 0 };
    },
  };
  // ── Organizations: membership + RBAC resolution (Phase 2) ──────────────────
  const mapOrg = (r) =>
    r && {
      id: r.id,
      name: r.name,
      slug: r.slug,
      kind: r.kind,
      status: r.status,
      ownerId: r.owner_id || null,
      createdBy: r.created_by || null,
      createdAt: r.created_at,
    };
  const orgs = {
    // The caller's membership row in an org, or null. Backs BOTH the fail-closed
    // membership gate (#68) and can() (#69). Only an active, non-deleted row counts.
    async membership(userId, orgId) {
      if (!userId || !orgId) return null;
      const r = (
        await q(
          `SELECT organization_id, user_id, role, status, team_id
             FROM organization_members
            WHERE user_id=$1 AND organization_id=$2 AND deleted=0`,
          [userId, orgId],
        )
      ).rows[0];
      return r
        ? { organizationId: r.organization_id, userId: r.user_id, role: r.role, status: r.status, teamId: r.team_id || null }
        : null;
    },
    // The DISTINCT permission set a user holds in an org, resolved from their role
    // via the catalog. A role_key resolves against the org's OWN roles first and the
    // built-in '_system' roles as a fallback (only system roles exist in v1, so this
    // is a clean single match; org-custom roles should use DISTINCT keys). Returns []
    // for a non-member / inactive membership — fail-closed.
    async permissionsForMember(userId, orgId) {
      if (!userId || !orgId) return [];
      return (
        await q(
          `SELECT DISTINCT rp.permission
             FROM organization_members om
             JOIN roles r
               ON r.role_key = om.role AND r.deleted=0
              AND r.organization_id IN (om.organization_id, '_system')
             JOIN role_permissions rp ON rp.role_id = r.id
            WHERE om.user_id=$1 AND om.organization_id=$2
              AND om.status='active' AND om.deleted=0`,
          [userId, orgId],
        )
      ).rows.map((x) => x.permission);
    },
    // Orgs a user actively belongs to — backs the switcher (#71) + provisioning (#70).
    async listForUser(userId) {
      if (!userId) return [];
      return (
        await q(
          `SELECT o.id, o.name, o.slug, o.kind, o.status, om.role
             FROM organization_members om
             JOIN organizations o ON o.id = om.organization_id AND o.deleted=0
            WHERE om.user_id=$1 AND om.status='active' AND om.deleted=0
            ORDER BY o.name`,
          [userId],
        )
      ).rows.map((r) => ({
        id: r.id, name: r.name, slug: r.slug, kind: r.kind, status: r.status, role: r.role,
      }));
    },
    // The built-in role catalog (for the admin console role picker). Org-custom
    // roles (real organization_id) are unioned in when they exist.
    async roleCatalog(orgId = null) {
      return (
        await q(
          `SELECT r.id, r.organization_id, r.role_key, r.name, r.role_rank, r.is_system,
                  (SELECT GROUP_CONCAT(rp.permission) FROM role_permissions rp WHERE rp.role_id = r.id) AS perms
             FROM roles r
            WHERE r.deleted=0 AND r.organization_id IN ('_system', $1)
            ORDER BY r.role_rank DESC`,
          [orgId || "_system"],
        )
      ).rows.map((r) => ({
        id: r.id, organizationId: r.organization_id, key: r.role_key, name: r.name,
        rank: Number(r.role_rank) || 0, isSystem: !!r.is_system,
        permissions: r.perms ? String(r.perms).split(",") : [],
      }));
    },
    // Replace a role's permission grants (hard delete + insert — role_permissions is a
    // plain (role_id, permission) PK with no soft-delete). The SERVICE validates the
    // set first (grantable + within the actor's own permissions).
    async _setRolePerms(roleId, permissions) {
      await q(`DELETE FROM role_permissions WHERE role_id=$1`, [roleId]);
      for (const p of [...new Set((permissions || []).map((x) => String(x)))]) {
        await q(`INSERT IGNORE INTO role_permissions (role_id, permission) VALUES ($1,$2)`, [roleId, p]);
      }
    },
    // Create a CUSTOM, org-scoped role (never _system). role_key is derived + stable so
    // organization_members.role can reference it like a built-in.
    async createRole(orgId, name, rank, permissions) {
      const clean = String(name || "").trim();
      if (!clean) return { error: "NAME_REQUIRED" };
      const key = "org_" + createHash("md5").update(orgId + ":" + clean.toLowerCase()).digest("hex").slice(0, 16);
      const dup = (
        await q(`SELECT id FROM roles WHERE organization_id=$1 AND role_key=$2 AND deleted=0`, [orgId, key])
      ).rows[0];
      if (dup) return { error: "DUPLICATE" };
      const id = genId();
      await q(
        `INSERT INTO roles (id, organization_id, role_key, name, role_rank, is_system) VALUES ($1,$2,$3,$4,$5,0)`,
        [id, orgId, key, clean, Number(rank) || 40],
      );
      await this._setRolePerms(id, permissions);
      return {
        role: { id, key, name: clean, rank: Number(rank) || 40, isSystem: false, permissions: [...new Set((permissions || []).map((x) => String(x)))] },
      };
    },
    // Edit a custom role — rename and/or replace permissions. System roles are immutable.
    async updateRole(orgId, roleId, patch) {
      const r = (
        await q(`SELECT id, is_system FROM roles WHERE id=$1 AND organization_id=$2 AND deleted=0`, [roleId, orgId])
      ).rows[0];
      if (!r) return { error: "NOT_FOUND" };
      if (r.is_system) return { error: "SYSTEM_ROLE" };
      const nm = patch && typeof patch.name === "string" ? patch.name.trim() : "";
      if (nm) await q(`UPDATE roles SET name=$3 WHERE id=$1 AND organization_id=$2`, [roleId, orgId, nm]);
      if (patch && Array.isArray(patch.permissions)) await this._setRolePerms(roleId, patch.permissions);
      return { ok: true };
    },
    // Soft-delete a custom role. Blocks _system roles and any role still assigned to a
    // member (they'd be left permission-less).
    async deleteRole(orgId, roleId) {
      const r = (
        await q(`SELECT id, role_key, is_system FROM roles WHERE id=$1 AND organization_id=$2 AND deleted=0`, [roleId, orgId])
      ).rows[0];
      if (!r) return { error: "NOT_FOUND" };
      if (r.is_system) return { error: "SYSTEM_ROLE" };
      const inUse = (
        await q(`SELECT 1 FROM organization_members WHERE organization_id=$1 AND role=$2 AND deleted=0 LIMIT 1`, [orgId, r.role_key])
      ).rows[0];
      if (inUse) return { error: "IN_USE" };
      await q(`UPDATE roles SET deleted=1, deleted_at=now(3) WHERE id=$1 AND organization_id=$2`, [roleId, orgId]);
      await q(`DELETE FROM role_permissions WHERE role_id=$1`, [roleId]);
      return { ok: true };
    },
    // ---- Provisioning + settings (Org product backend, #70) ------------------
    async create({ name, slug, kind = "team", ownerId, createdBy = null }) {
      const id = genId();
      await q(
        `INSERT INTO organizations (id,name,slug,kind,owner_id,created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, name, slug, kind, ownerId || null, createdBy || ownerId || null],
      );
      // The creator is the first OWNER (satisfies the >=1-active-owner invariant).
      if (ownerId)
        await q(
          `INSERT INTO organization_members (id,organization_id,user_id,role,status)
             VALUES ($1,$2,$3,'owner','active')
           ON DUPLICATE KEY UPDATE role='owner', status='active', deleted=0, deleted_at=NULL`,
          [genId(), id, ownerId],
        );
      return this.getById(id);
    },
    async getById(orgId) {
      const r = (await q(`SELECT * FROM organizations WHERE id=$1 AND deleted=0`, [orgId])).rows[0];
      return mapOrg(r);
    },
    async getBySlug(slug) {
      const r = (await q(`SELECT * FROM organizations WHERE slug=$1 AND deleted=0`, [slug])).rows[0];
      return mapOrg(r);
    },
    async updateSettings(orgId, patch) {
      const sets: string[] = [];
      const vals: any[] = [orgId];
      const add = (col, val) => { vals.push(val); sets.push(`${col}=$${vals.length}`); };
      if (patch.name !== undefined) add("name", patch.name);
      if (!sets.length) return this.getById(orgId);
      await q(`UPDATE organizations SET ${sets.join(", ")} WHERE id=$1 AND deleted=0`, vals);
      return this.getById(orgId);
    },
    // ── Session policy (Session Mgmt Phase 4) ────────────────────────────────
    // Per-org overrides of the global session defaults. NULL = inherit the env
    // default (AUTH_MAX_SESSIONS). session_limit 0 = unlimited. idle_timeout_min
    // is stored here and enforced by the Phase 5 session-GC sweep.
    async getPolicy(orgId) {
      if (!orgId) return { sessionLimit: null, idleTimeoutMin: null };
      const r = (
        await q(`SELECT session_limit, idle_timeout_min FROM organizations WHERE id=$1 AND deleted=0`, [orgId])
      ).rows[0];
      return {
        sessionLimit: r && r.session_limit != null ? Number(r.session_limit) : null,
        idleTimeoutMin: r && r.idle_timeout_min != null ? Number(r.idle_timeout_min) : null,
      };
    },
    async setPolicy(orgId, { sessionLimit, idleTimeoutMin }: any = {}) {
      const sets: string[] = [];
      const vals: any[] = [orgId];
      const add = (col, val) => { vals.push(val); sets.push(`${col}=$${vals.length}`); };
      if (sessionLimit !== undefined)
        add("session_limit", sessionLimit === null ? null : Math.max(0, Math.floor(Number(sessionLimit) || 0)));
      if (idleTimeoutMin !== undefined)
        add("idle_timeout_min", idleTimeoutMin === null ? null : Math.max(0, Math.floor(Number(idleTimeoutMin) || 0)));
      if (sets.length)
        await q(`UPDATE organizations SET ${sets.join(", ")} WHERE id=$1 AND deleted=0`, vals);
      return this.getPolicy(orgId);
    },
    // Per-org GIF-search provider + API key (admin-set, no redeploy). Kept OUT of
    // getPolicy so the session-policy endpoint never echoes the secret; media.ts
    // reads it directly and falls back to the deployment-wide env key.
    async getGifConfig(orgId) {
      if (!orgId) return { provider: "", key: "" };
      const r = (
        await q(`SELECT gif_provider, gif_api_key FROM organizations WHERE id=$1 AND deleted=0`, [orgId])
      ).rows[0];
      return { provider: (r && r.gif_provider) || "", key: (r && r.gif_api_key) || "" };
    },
    async setGifConfig(orgId, provider, key) {
      const k = key == null || key === "" ? null : String(key).slice(0, 128);
      // Only "giphy" is implemented; coerce anything else. Clearing the key also
      // clears the provider so a blank org row reads as "inherit env".
      const p = !k ? null : provider === "giphy" ? "giphy" : "giphy";
      await q(`UPDATE organizations SET gif_provider=$2, gif_api_key=$3 WHERE id=$1 AND deleted=0`, [orgId, p, k]);
      return { provider: p || "", key: k || "" };
    },
    // The effective concurrent-session LIMIT for a user across their active orgs —
    // the MOST RESTRICTIVE policy wins. An org that inherits (session_limit NULL)
    // participates as the passed env default, so a SECURE org relying on the
    // default isn't silently out-voted by a LAX org's larger explicit cap. 0 =
    // unlimited (non-binding). Returns a positive number (strictest cap), 0 (every
    // applicable policy is unlimited), or null (the user has no active org →
    // caller falls back to the env default).
    async effectiveSessionLimitForUser(userId, envDefault = null) {
      if (!userId) return null;
      const rows = (
        await q(
          `SELECT o.session_limit AS lim
             FROM organization_members om
             JOIN organizations o ON o.id = om.organization_id AND o.deleted=0
            WHERE om.user_id=$1 AND om.status='active' AND om.deleted=0`,
          [userId],
        )
      ).rows;
      if (!rows.length) return null; // no orgs → inherit env default (caller decides)
      const envN =
        envDefault == null ? null : Math.max(0, Math.floor(Number(envDefault) || 0));
      const eff = rows.map((r) =>
        r.lim == null ? envN : Math.max(0, Math.floor(Number(r.lim) || 0)),
      );
      const positives = eff.filter((n) => n != null && n > 0) as number[];
      if (positives.length) return Math.min(...positives); // strictest positive cap
      return 0; // every applicable policy is unlimited (or an unknown env default)
    },
    // ---- Members ----
    async members(orgId) {
      return (
        await q(
          `SELECT om.user_id, om.role, om.status, om.team_id, u.name, u.email,
                  u.sso_enabled, (u.password_hash IS NOT NULL) AS has_password,
                  (SELECT GROUP_CONCAT(tm.team_id) FROM team_members tm JOIN teams t ON t.id = tm.team_id
                    WHERE tm.user_id = om.user_id AND tm.deleted=0 AND t.organization_id = om.organization_id) AS team_ids
             FROM organization_members om JOIN users u ON u.id=om.user_id
            WHERE om.organization_id=$1 AND om.deleted=0
            ORDER BY FIELD(om.role,'owner','ceo','cto','cfo','admin','director','manager','member','guest'), u.name`,
          [orgId],
        )
      ).rows.map((r) => ({
        userId: r.user_id, role: r.role, status: r.status, teamId: r.team_id || null,
        teamIds: r.team_ids ? String(r.team_ids).split(",") : [],
        name: r.name, email: r.email,
        // SSO is "on" for an account when it has ever signed in via SSO (the stored
        // flag) OR it has no local password at all — a passwordless account can ONLY
        // exist via the SSO login path (signup/provisioning always set a password;
        // invites require an existing account), so passwordless ⟺ SSO-only. Deriving
        // this makes the badge self-healing: correct even before the flag is backfilled
        // or for any future passwordless path that forgets to stamp it.
        ssoEnabled: !!r.sso_enabled || !r.has_password, hasPassword: !!r.has_password,
      }));
    },
    async addMember(orgId, userId, role = "member") {
      await q(
        `INSERT INTO organization_members (id,organization_id,user_id,role,status) VALUES ($1,$2,$3,$4,'active')
         ON DUPLICATE KEY UPDATE role=VALUES(role), status='active', deleted=0, deleted_at=NULL`,
        [genId(), orgId, userId, role],
      );
      return this.membership(userId, orgId);
    },
    async setMemberRole(orgId, userId, role) {
      await q(
        `UPDATE organization_members SET role=$3 WHERE organization_id=$1 AND user_id=$2 AND deleted=0`,
        [orgId, userId, role],
      );
      return this.membership(userId, orgId);
    },
    async removeMember(orgId, userId, byUserId = null, reason = null) {
      const r = await q(
        `UPDATE organization_members SET deleted=1, deleted_at=now(3), deleted_by=$3, removed_reason=$4 WHERE organization_id=$1 AND user_id=$2 AND deleted=0`,
        [orgId, userId, byUserId, reason ? String(reason).slice(0, 500) : null],
      );
      return { removed: (r.rowCount || 0) > 0 };
    },
    // TOTAL ACCESS CLEANUP on org removal (Teams/Slack parity): losing org
    // membership must also revoke every org-scoped conversation membership
    // (channels, groups, DMs, meeting chats) and org meeting invites — those
    // rows are what message fan-out, file access, and the sidebar key on, and
    // they used to survive removal, leaving the removed user readable-in and
    // receiving realtime messages. Conversation rows use the same soft-delete
    // as conversations.removeMember (a later re-add starts clean, nothing is
    // destroyed); meeting invites are hard-deleted (attendance has no
    // soft-delete column). Returns the affected conversation ids so the
    // realtime layer can eject live sockets from those rooms immediately.
    async purgeMemberAccess(orgId, userId, byUserId = null) {
      const ids = (
        await q(
          `SELECT cm.conversation_id FROM conversation_members cm
             JOIN conversations c ON c.id = cm.conversation_id
            WHERE c.organization_id=$1 AND cm.user_id=$2 AND cm.deleted=0`,
          [orgId, userId],
        )
      ).rows.map((r) => r.conversation_id);
      if (ids.length) {
        await q(
          `UPDATE conversation_members cm
             JOIN conversations c ON c.id = cm.conversation_id
              SET cm.deleted=1, cm.deleted_at=now(3), cm.deleted_by=$3
            WHERE c.organization_id=$1 AND cm.user_id=$2 AND cm.deleted=0`,
          [orgId, userId, byUserId],
        );
      }
      await q(
        `DELETE ma FROM meeting_attendees ma
           JOIN meetings m ON m.id = ma.meeting_id
           JOIN conversations c ON c.id = m.conversation_id
          WHERE c.organization_id=$1 AND ma.user_id=$2`,
        [orgId, userId],
      );
      return { conversationIds: ids };
    },
    // The org a session should default to for this user. SAME precedence as the
    // active_org_id sub-select in sessions.create (owner, then admin, then the
    // oldest membership), so an org adopted lazily mid-session is identical to
    // what a fresh sign-in would have picked.
    async primaryForUser(userId) {
      const r = (
        await q(
          `SELECT organization_id FROM organization_members
            WHERE user_id=$1 AND status='active' AND deleted=0
            ORDER BY (role='owner') DESC, (role='admin') DESC, created_at ASC
            LIMIT 1`,
          [userId],
        )
      ).rows[0];
      return r ? r.organization_id : null;
    },
    // Backs the >=1-active-owner invariant (never demote/remove the last owner).
    async ownerCount(orgId) {
      const r = (
        await q(
          `SELECT COUNT(*) AS n FROM organization_members
            WHERE organization_id=$1 AND role='owner' AND status='active' AND deleted=0`,
          [orgId],
        )
      ).rows[0];
      return Number(r?.n) || 0;
    },
    // ── Organization join requests (enterprise onboarding) ─────────────────────
    // NOTE: a discoverOrgs(term) that searched/listed orgs by name was intentionally
    // removed — enumerating the tenant list is sensitive. Joining resolves a single
    // org by its code (slug, via getBySlug) or an invite link; there is deliberately
    // no "list/search all orgs" query. Do not re-add one.

    // Create (or re-open, after a rejection) a pending join request. UPSERT on the
    // (org,user) unique key so a user never accumulates stale rows.
    async createJoinRequest(orgId, userId, message = null) {
      await q(
        `INSERT INTO organization_join_requests (id, organization_id, user_id, status, message)
           VALUES ($1,$2,$3,'pending',$4)
         ON DUPLICATE KEY UPDATE status='pending', message=VALUES(message),
           decided_by=NULL, decided_at=NULL, created_at=now(3)`,
        [genId(), orgId, userId, message ? String(message).slice(0, 500) : null],
      );
      return this.pendingJoinRequest(userId, orgId);
    },
    async joinRequest(id) {
      const r = (await q(`SELECT * FROM organization_join_requests WHERE id=$1`, [id])).rows[0];
      return r
        ? { id: r.id, organizationId: r.organization_id, userId: r.user_id, status: r.status, message: r.message || "", decidedBy: r.decided_by || null, createdAt: r.created_at }
        : null;
    },
    async pendingJoinRequest(userId, orgId) {
      const r = (
        await q(
          `SELECT * FROM organization_join_requests WHERE user_id=$1 AND organization_id=$2 AND status='pending'`,
          [userId, orgId],
        )
      ).rows[0];
      return r
        ? { id: r.id, organizationId: r.organization_id, userId: r.user_id, status: r.status, message: r.message || "", createdAt: r.created_at }
        : null;
    },
    // Admin roster of requests for an org. status='' → all; default pending only.
    async listJoinRequests(orgId, status = "pending") {
      return (
        await q(
          `SELECT jr.id, jr.organization_id, jr.user_id, jr.status, jr.message, jr.created_at, u.name, u.email
             FROM organization_join_requests jr
             JOIN users u ON u.id = jr.user_id
            WHERE jr.organization_id=$1 AND ($2='' OR jr.status=$2)
            ORDER BY jr.created_at ASC`,
          [orgId, status || ""],
        )
      ).rows.map((r) => ({
        id: r.id, organizationId: r.organization_id, userId: r.user_id, status: r.status,
        message: r.message || "", createdAt: r.created_at, name: r.name, email: r.email,
      }));
    },
    // The caller's own requests — powers the onboarding "Request Sent" state.
    async joinRequestsForUser(userId) {
      return (
        await q(
          `SELECT jr.id, jr.organization_id, jr.status, jr.created_at, o.name AS org_name, o.slug AS org_slug
             FROM organization_join_requests jr
             JOIN organizations o ON o.id = jr.organization_id AND o.deleted=0
            WHERE jr.user_id=$1
            ORDER BY jr.created_at DESC`,
          [userId],
        )
      ).rows.map((r) => ({
        id: r.id, organizationId: r.organization_id, status: r.status,
        createdAt: r.created_at, orgName: r.org_name, orgSlug: r.org_slug,
      }));
    },
    async setJoinRequestStatus(id, status, decidedBy = null, reason = null) {
      // ATOMIC first-action-wins (BA #2): the status flip only lands while the
      // row is still 'pending', so when two admins race, exactly ONE conditional
      // UPDATE claims it; the loser sees claimed:false and the service 409s.
      const r = await q(
        `UPDATE organization_join_requests
            SET status=$2, decided_by=$3, decided_at=now(3), decision_reason=$4
          WHERE id=$1 AND status='pending'`,
        [id, status, decidedBy, reason ? String(reason).slice(0, 500) : null],
      );
      return {
        claimed: (r.rowCount || 0) > 0,
        request: await this.joinRequest(id),
      };
    },
    // ---- Org-wide broadcasts (BA #6): durable history; delivery rides the
    // notifications pipeline. Any active member may list them (BA #3). ----
    async createBroadcast(orgId, authorId, title, body = null, opts: any = {}) {
      const id = genId();
      // sendAt in the future → park as 'scheduled' for the poller; otherwise it
      // is delivered inline by the route and recorded as already 'sent'.
      const sendAt = opts.sendAt || null;
      const status = sendAt ? "scheduled" : "sent";
      await q(
        `INSERT INTO org_broadcasts (id, organization_id, author_id, title, body, send_at, status, file_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          id, orgId, authorId,
          String(title).slice(0, 255),
          body ? String(body).slice(0, 8000) : null,
          sendAt, status, opts.fileId || null,
        ],
      );
      return this.broadcast(id);
    },
    async broadcast(id) {
      const r = (
        await q(
          `SELECT b.*, u.name AS author_name FROM org_broadcasts b
             LEFT JOIN users u ON u.id=b.author_id WHERE b.id=$1 AND b.deleted=0`,
          [id],
        )
      ).rows[0];
      return r ? mapBroadcast(r) : null;
    },
    // Managers see scheduled + sent (so they can review/cancel what is queued);
    // everyone else sees only what has actually been DELIVERED — a scheduled
    // announcement must not leak before its send time.
    async listBroadcasts(orgId, limit = 50, includeScheduled = false) {
      return (
        await q(
          `SELECT b.*, u.name AS author_name
             FROM org_broadcasts b
             LEFT JOIN users u ON u.id = b.author_id
            WHERE b.organization_id=$1 AND b.deleted=0
              AND ($3 = 1 OR b.status = 'sent')
            ORDER BY COALESCE(b.send_at, b.created_at) DESC
            LIMIT $2`,
          [orgId, Math.min(Number(limit) || 50, 200), includeScheduled ? 1 : 0],
        )
      ).rows.map(mapBroadcast);
    },
    // Atomic claim of due scheduled broadcasts — same shape as
    // scheduledMessages.claimDue: SELECT ... FOR UPDATE SKIP LOCKED, flip to
    // 'sending', read back. Guarantees one delivery even with several app
    // instances polling. send_at is stored as UTC wall-clock, so it MUST be
    // compared against UTC_TIMESTAMP() (not now(), which is session-local).
    async claimDueBroadcasts(limit = 20) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const lim = Number(limit) || 20;
        const [picked]: any = await conn.query(
          `SELECT id FROM org_broadcasts
             WHERE deleted=0
               AND ((status='scheduled' AND send_at <= UTC_TIMESTAMP())
                 OR (status='sending' AND created_at < now() - INTERVAL 5 MINUTE))
             ORDER BY send_at ASC
             LIMIT ${lim}
             FOR UPDATE SKIP LOCKED`,
          [],
        );
        const ids = picked.map((r) => r.id);
        if (!ids.length) {
          await conn.commit();
          return [];
        }
        await conn.query(`UPDATE org_broadcasts SET status='sending' WHERE id IN (?)`, [ids]);
        const [rows]: any = await conn.query(
          `SELECT b.*, u.name AS author_name FROM org_broadcasts b
             LEFT JOIN users u ON u.id=b.author_id WHERE b.id IN (?)`,
          [ids],
        );
        await conn.commit();
        return rows.map(mapBroadcast);
      } catch (e) {
        try { await conn.rollback(); } catch (_) {}
        throw e;
      } finally {
        conn.release();
      }
    },
    async setBroadcastStatus(id, status) {
      await q(`UPDATE org_broadcasts SET status=$2 WHERE id=$1`, [id, status]);
      return this.broadcast(id);
    },
    // Delete a broadcast FOR EVERYONE (soft-delete). Works for a queued one
    // (which also cancels it — claimDueBroadcasts filters deleted=0) and for an
    // already-sent one (it disappears from every member's Broadcasts list).
    // 'sending' is excluded so a delete can't race a delivery mid-flight; that
    // window is seconds, and the row becomes deletable the moment it lands.
    // Scoped by organization_id so an admin can only ever touch their own org.
    async deleteBroadcast(id, orgId) {
      const r = await q(
        `UPDATE org_broadcasts SET deleted=1
          WHERE id=$1 AND organization_id=$2 AND deleted=0 AND status <> 'sending'`,
        [id, orgId],
      );
      return { id, deleted: (r.rowCount || 0) > 0 };
    },
    // Edit a broadcast FOR EVERYONE. Editing a QUEUED one changes what will be
    // delivered (the poller reads title/body at send time); editing a SENT one
    // updates the announcement everyone sees in the org page — it does NOT
    // re-notify, since that notification already went out.
    async updateBroadcast(id, orgId, patch: any = {}) {
      const vals: any[] = [id, orgId];
      const sets: string[] = [];
      if (typeof patch.title === "string" && patch.title.trim()) {
        vals.push(String(patch.title).slice(0, 255));
        sets.push(`title=$${vals.length}`);
      }
      if (patch.body !== undefined) {
        vals.push(patch.body ? String(patch.body).slice(0, 8000) : null);
        sets.push(`body=$${vals.length}`);
      }
      // Rescheduling only makes sense while it is still queued.
      if (patch.sendAt !== undefined) {
        vals.push(patch.sendAt || null);
        sets.push(`send_at=$${vals.length}`);
      }
      if (!sets.length) return this.broadcast(id);
      await q(
        `UPDATE org_broadcasts SET ${sets.join(", ")}
          WHERE id=$1 AND organization_id=$2 AND deleted=0 AND status <> 'sending'`,
        vals,
      );
      return this.broadcast(id);
    },
    // ---- Teams (list + the self-serve department picker) ----
    async teams(orgId) {
      return (
        await q(
          `SELECT t.id, t.name, t.parent_team_id, t.depth,
                  (SELECT COUNT(*) FROM team_members tm WHERE tm.team_id=t.id AND tm.deleted=0) AS member_count
             FROM teams t WHERE t.organization_id=$1 AND t.deleted=0 ORDER BY t.path, t.name`,
          [orgId],
        )
      ).rows.map((r) => ({
        id: r.id, name: r.name, parentTeamId: r.parent_team_id || null,
        depth: Number(r.depth) || 0, memberCount: Number(r.member_count) || 0,
      }));
    },
    async teamInOrg(orgId, teamId) {
      const r = (
        await q(`SELECT id FROM teams WHERE id=$1 AND organization_id=$2 AND deleted=0`, [teamId, orgId])
      ).rows[0];
      return !!r;
    },
    // Create a team, optionally nested under a parent (sub-department). Computes the
    // materialized name-path + depth, enforces the 5-level cap, and rejects a duplicate
    // sibling name. Returns { team } on success or { error } for the service to map.
    async createTeam(orgId, name, parentTeamId) {
      const clean = String(name || "").trim();
      if (!clean) return { error: "NAME_REQUIRED" };
      let depth = 0;
      let path = "/" + clean;
      if (parentTeamId) {
        const p = (
          await q(`SELECT path, depth FROM teams WHERE id=$1 AND organization_id=$2 AND deleted=0`, [parentTeamId, orgId])
        ).rows[0];
        if (!p) return { error: "PARENT_NOT_FOUND" };
        depth = (Number(p.depth) || 0) + 1;
        if (depth > 5) return { error: "TOO_DEEP" };
        path = (p.path || "") + "/" + clean;
      }
      const dup = (
        await q(
          `SELECT id FROM teams WHERE organization_id=$1 AND (parent_team_id <=> $2) AND name=$3 AND deleted=0`,
          [orgId, parentTeamId || null, clean],
        )
      ).rows[0];
      if (dup) return { error: "DUPLICATE" };
      const id = genId();
      await q(
        `INSERT INTO teams (id, organization_id, parent_team_id, name, path, depth)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, orgId, parentTeamId || null, clean, path, depth],
      );
      return { team: { id, name: clean, parentTeamId: parentTeamId || null, depth, memberCount: 0 } };
    },
    // Legacy single "primary/home team" pick (the /current/my-team route). ADDITIVE:
    // sets the primary team and joins it; does NOT leave other teams — MULTI-TEAM is
    // the model (a member can be in many teams, e.g. a CEO in Executive AND Product).
    async setMemberTeam(orgId, userId, teamId) {
      await q(
        `UPDATE organization_members SET team_id=$3 WHERE organization_id=$1 AND user_id=$2 AND deleted=0`,
        [orgId, userId, teamId || null],
      );
      if (teamId)
        await q(
          `INSERT INTO team_members (team_id,user_id) VALUES ($1,$2)
           ON DUPLICATE KEY UPDATE deleted=0, deleted_at=NULL`,
          [teamId, userId],
        );
      return this.membership(userId, orgId);
    },
    // Multi-team membership toggle. join = add/reactivate the team_members row; leave =
    // soft-delete it. organization_members.team_id is kept as a convenience "primary"
    // (set on join; cleared only if the team being left WAS the primary). All simple
    // single-table writes so behaviour is easy to reason about.
    async setTeamMembership(orgId, userId, teamId, join) {
      if (!(await this.teamInOrg(orgId, teamId))) return this.membership(userId, orgId);
      if (join) {
        await q(
          `INSERT INTO team_members (team_id,user_id) VALUES ($1,$2)
           ON DUPLICATE KEY UPDATE deleted=0, deleted_at=NULL`,
          [teamId, userId],
        );
        await q(
          `UPDATE organization_members SET team_id=$3 WHERE organization_id=$1 AND user_id=$2 AND deleted=0`,
          [orgId, userId, teamId],
        );
      } else {
        await q(
          `UPDATE team_members SET deleted=1, deleted_at=now(3) WHERE team_id=$1 AND user_id=$2 AND deleted=0`,
          [teamId, userId],
        );
        await q(
          `UPDATE organization_members SET team_id=NULL WHERE organization_id=$1 AND user_id=$2 AND deleted=0 AND team_id=$3`,
          [orgId, userId, teamId],
        );
      }
      return this.membership(userId, orgId);
    },
    // Every team (id) a member currently belongs to in an org.
    async memberTeamIds(orgId, userId) {
      return (
        await q(
          `SELECT tm.team_id FROM team_members tm JOIN teams t ON t.id = tm.team_id
            WHERE tm.user_id=$1 AND tm.deleted=0 AND t.organization_id=$2`,
          [userId, orgId],
        )
      ).rows.map((r) => r.team_id);
    },
    // The org a brand-new SSO / self-serve user should land in. An explicitly
    // configured SSO_DEFAULT_ORG_SLUG wins; otherwise, on a SINGLE-TENANT deploy
    // (exactly one active org) that sole org; else null (a true multi-tenant deploy
    // requires an explicit invite, so we never guess a tenant for them).
    async defaultOrg() {
      const slug = (process.env.SSO_DEFAULT_ORG_SLUG || "").trim();
      if (slug) return this.getBySlug(slug);
      const rows = (
        await q(`SELECT * FROM organizations WHERE deleted=0 AND status='active' LIMIT 2`)
      ).rows;
      return rows.length === 1 ? mapOrg(rows[0]) : null;
    },
  };

  // Whiteboard snapshots (enterprise persistence). board_key = "call:<id>" or
  // "meeting:<id>"; data is the JSON board. Debounced last-writer-wins upsert.
  const whiteboards = {
    async get(boardKey: string) {
      const r = await q("SELECT data FROM whiteboards WHERE board_key = $1", [
        boardKey,
      ]);
      if (!r.rows.length) return null;
      try {
        return JSON.parse(r.rows[0].data);
      } catch {
        return null;
      }
    },
    async save(boardKey: string, data: any, updatedBy?: string) {
      const json = JSON.stringify(data == null ? {} : data);
      await q(
        "INSERT INTO whiteboards (board_key, data, updated_by) VALUES ($1, $2, $3) " +
          "ON DUPLICATE KEY UPDATE data = VALUES(data), updated_by = VALUES(updated_by)",
        [boardKey, json, updatedBy || null],
      );
      return { boardKey };
    },
    async remove(boardKey: string) {
      await q("DELETE FROM whiteboards WHERE board_key = $1", [boardKey]);
      return { boardKey };
    },
  };

  // ── Chat webhooks (incoming + outgoing) ────────────────────────────────────
  // Row shape is documented in migrations/0115_chat_webhooks.sql. Everything is
  // scoped to one conversation_id (a DM or a group); the SERVICE owns the
  // membership authorization, this layer is pure persistence.
  const mapWebhook = (r: any) =>
    r && {
      id: r.id,
      direction: r.direction,
      name: r.name,
      conversationId: r.conversation_id,
      ownerId: r.owner_id,
      tokenHint: r.token_hint || null,
      targetUrl: r.target_url || null,
      secret: r.secret || null,
      events: String(r.events || "").split(",").filter(Boolean),
      enabled: !!r.enabled,
      lastStatus: r.last_status || null,
      lastDeliveryAt: r.last_delivery_at || null,
      failureCount: Number(r.failure_count || 0),
      createdAt: r.created_at,
    };

  const webhooks = {
    async create(w: {
      direction: string;
      name: string;
      conversationId: string;
      ownerId: string;
      tokenHash?: string | null;
      tokenHint?: string | null;
      targetUrl?: string | null;
      secret?: string | null;
      events?: string[];
    }) {
      const id = genId();
      // Organizations: stamp the creator's active tenant so an org-wide audit or
      // purge can find these rows (reads stay conversation/owner-scoped, which is
      // already a tighter filter than the tenant).
      const orgId = currentOrgId();
      await q(
        `INSERT INTO chat_webhooks
           (id, organization_id, direction, name, conversation_id, owner_id,
            token_hash, token_hint, target_url, secret, events)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          id,
          orgId,
          w.direction,
          w.name,
          w.conversationId,
          w.ownerId,
          w.tokenHash || null,
          w.tokenHint || null,
          w.targetUrl || null,
          w.secret || null,
          (w.events && w.events.length ? w.events : ["message.created"]).join(","),
        ],
      );
      return mapWebhook((await q("SELECT * FROM chat_webhooks WHERE id=$1", [id])).rows[0]);
    },
    async getById(id: string) {
      return mapWebhook(
        (await q("SELECT * FROM chat_webhooks WHERE id=$1 AND deleted=0", [id])).rows[0],
      );
    },
    // Incoming ingest lookup. Matches on the sha256 of the presented token — the
    // plaintext is never stored, so a DB dump yields no working endpoint.
    async getByTokenHash(tokenHash: string) {
      return mapWebhook(
        (
          await q(
            "SELECT * FROM chat_webhooks WHERE token_hash=$1 AND direction='in' AND deleted=0",
            [tokenHash],
          )
        ).rows[0],
      );
    },
    async listForConversation(conversationId: string) {
      return (
        await q(
          "SELECT * FROM chat_webhooks WHERE conversation_id=$1 AND deleted=0 ORDER BY created_at DESC",
          [conversationId],
        )
      ).rows.map(mapWebhook);
    },
    async listForOwner(ownerId: string) {
      return (
        await q(
          "SELECT * FROM chat_webhooks WHERE owner_id=$1 AND deleted=0 ORDER BY created_at DESC",
          [ownerId],
        )
      ).rows.map(mapWebhook);
    },
    // The outgoing fan-out read, on the message-send path: enabled 'out' hooks
    // for this conversation that subscribe to this event. Indexed by
    // (conversation_id, direction, enabled).
    async listOutgoingFor(conversationId: string, event: string) {
      return (
        await q(
          `SELECT * FROM chat_webhooks
             WHERE conversation_id=$1 AND direction='out' AND enabled=1 AND deleted=0
               AND FIND_IN_SET($2, events) > 0`,
          [conversationId, event],
        )
      ).rows.map(mapWebhook);
    },
    async update(id: string, patch: { name?: string; enabled?: boolean; events?: string[] }) {
      const sets: string[] = [];
      const params: any[] = [];
      if (patch.name !== undefined) { params.push(patch.name); sets.push(`name=$${params.length}`); }
      if (patch.enabled !== undefined) { params.push(patch.enabled ? 1 : 0); sets.push(`enabled=$${params.length}`); }
      if (patch.events !== undefined) { params.push(patch.events.join(",")); sets.push(`events=$${params.length}`); }
      if (sets.length) {
        params.push(id);
        await q(`UPDATE chat_webhooks SET ${sets.join(", ")} WHERE id=$${params.length} AND deleted=0`, params);
      }
      return webhooks.getById(id);
    },
    // Re-key an existing webhook in place: the id and the delivery history are
    // kept, only the credential changes, so rotating does not require rewiring
    // the consumer's configuration beyond the secret itself.
    async rotate(id: string, cred: { tokenHash?: string; tokenHint?: string; secret?: string }) {
      if (cred.tokenHash)
        await q("UPDATE chat_webhooks SET token_hash=$1, token_hint=$2 WHERE id=$3 AND deleted=0", [
          cred.tokenHash,
          cred.tokenHint || null,
          id,
        ]);
      if (cred.secret)
        await q("UPDATE chat_webhooks SET secret=$1 WHERE id=$2 AND deleted=0", [cred.secret, id]);
      return webhooks.getById(id);
    },
    async remove(id: string) {
      const r = await q(
        "UPDATE chat_webhooks SET deleted=1, deleted_at=now(3) WHERE id=$1 AND deleted=0",
        [id],
      );
      return { id, removed: (r.rowCount || 0) > 0 };
    },
    async markHealth(id: string, status: string, failed: boolean) {
      await q(
        `UPDATE chat_webhooks
           SET last_status=$1, last_delivery_at=now(3),
               failure_count = CASE WHEN $2 = 1 THEN failure_count + 1 ELSE 0 END
         WHERE id=$3`,
        [String(status).slice(0, 32), failed ? 1 : 0, id],
      );
    },

    // ── Outgoing delivery queue ──────────────────────────────────────────────
    async enqueue(webhookId: string, event: string, payload: string) {
      const id = genId();
      await q(
        "INSERT INTO chat_webhook_deliveries (id, webhook_id, event, payload) VALUES ($1,$2,$3,$4)",
        [id, webhookId, event, payload],
      );
      return id;
    },
    // Claim due work. The UPDATE ... ORDER BY id LIMIT is the claim (it flips the
    // rows to 'sending' under the row locks it takes), so several backend
    // replicas draining concurrently can never hand the same delivery to two
    // HTTP posts. The leader gate in index.ts makes this rare; the claim makes
    // it correct even without one.
    async claimDue(limit = 25) {
      const claim = genId();
      const r = await q(
        `UPDATE chat_webhook_deliveries
           SET status='sending', claim_token=$1
         WHERE status='pending' AND next_attempt_at <= now(3)
         ORDER BY next_attempt_at
         LIMIT $2`,
        [claim, Math.max(1, Math.min(200, limit))],
      );
      if (!r.rowCount) return [];
      return (
        await q(
          `SELECT d.*, w.target_url, w.secret, w.enabled AS hook_enabled, w.deleted AS hook_deleted
             FROM chat_webhook_deliveries d
             JOIN chat_webhooks w ON w.id = d.webhook_id
            WHERE d.claim_token=$1 AND d.status='sending'`,
          [claim],
        )
      ).rows.map((row: any) => ({
        id: row.id,
        webhookId: row.webhook_id,
        event: row.event,
        payload: row.payload,
        attempts: Number(row.attempts || 0),
        targetUrl: row.target_url,
        secret: row.secret,
        hookLive: !!row.hook_enabled && !row.hook_deleted,
      }));
    },
    async markDelivered(id: string, responseCode: number) {
      await q(
        `UPDATE chat_webhook_deliveries
           SET status='delivered', attempts=attempts+1, response_code=$1,
               error=NULL, claim_token=NULL, delivered_at=now(3)
         WHERE id=$2`,
        [responseCode, id],
      );
    },
    // Retry with the caller-computed backoff, or give up permanently once the
    // attempt budget is spent. `retryInSec` NULL means "no more attempts".
    async markFailed(id: string, responseCode: number | null, error: string, retryInSec: number | null) {
      if (retryInSec == null) {
        await q(
          "UPDATE chat_webhook_deliveries SET status='failed', attempts=attempts+1, response_code=$1, error=$2, claim_token=NULL WHERE id=$3",
          [responseCode, String(error || "").slice(0, 512), id],
        );
        return;
      }
      await q(
        `UPDATE chat_webhook_deliveries
           SET status='pending', attempts=attempts+1, response_code=$1, error=$2,
               claim_token=NULL, next_attempt_at = DATE_ADD(now(3), INTERVAL $3 SECOND)
         WHERE id=$4`,
        [responseCode, String(error || "").slice(0, 512), Math.max(1, Math.round(retryInSec)), id],
      );
    },
    async listDeliveries(webhookId: string, limit = 25) {
      return (
        await q(
          `SELECT id, event, status, attempts, response_code, error, created_at, delivered_at
             FROM chat_webhook_deliveries WHERE webhook_id=$1
            ORDER BY created_at DESC LIMIT $2`,
          [webhookId, Math.max(1, Math.min(100, limit))],
        )
      ).rows.map((r: any) => ({
        id: r.id,
        event: r.event,
        status: r.status,
        attempts: Number(r.attempts || 0),
        responseCode: r.response_code == null ? null : Number(r.response_code),
        error: r.error || null,
        createdAt: r.created_at,
        deliveredAt: r.delivered_at || null,
      }));
    },
    // Re-arm deliveries a crashed/redeployed process left mid-flight. Without
    // this a claim that never completed would sit in 'sending' forever.
    async requeueStale(olderThanSec = 300) {
      const r = await q(
        `UPDATE chat_webhook_deliveries
           SET status='pending', claim_token=NULL, next_attempt_at=now(3)
         WHERE status='sending' AND created_at < DATE_SUB(now(3), INTERVAL $1 SECOND)`,
        [Math.max(30, olderThanSec)],
      );
      return r.rowCount || 0;
    },
    // Retention: the delivery log is an operational aid, not a record of the
    // conversation (payloads embed message text), so old rows are hard-deleted.
    async pruneDeliveries(retentionDays = 30) {
      const r = await q(
        "DELETE FROM chat_webhook_deliveries WHERE created_at < DATE_SUB(now(3), INTERVAL $1 DAY)",
        [Math.max(1, retentionDays)],
      );
      return r.rowCount || 0;
    },
  };

  // ── Meeting polls (0121) ───────────────────────────────────────────────────
  // The SERVICE decides who may see what (anonymity, host-only actions); this
  // layer is persistence and vote arithmetic only.
  const mapPoll = (r: any) =>
    r && {
      id: r.id,
      meetingId: r.meeting_id,
      createdBy: r.created_by,
      question: r.question,
      options: (() => {
        try {
          const v = JSON.parse(r.options);
          return Array.isArray(v) ? v.map(String) : [];
        } catch {
          return [];
        }
      })(),
      status: r.status || "open",
      anonymous: !!r.anonymous,
      multiChoice: !!r.multi_choice,
      createdAt: r.created_at,
      closedAt: r.closed_at || null,
    };

  const polls = {
    async create(p: {
      meetingId: string;
      createdBy: string;
      question: string;
      options: string[];
      anonymous?: boolean;
      multiChoice?: boolean;
    }) {
      const id = genId();
      await q(
        `INSERT INTO meeting_polls (id, meeting_id, created_by, question, options, anonymous, multi_choice)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          id,
          p.meetingId,
          p.createdBy,
          p.question,
          JSON.stringify(p.options),
          p.anonymous === false ? 0 : 1,
          p.multiChoice ? 1 : 0,
        ],
      );
      return mapPoll((await q("SELECT * FROM meeting_polls WHERE id=$1", [id])).rows[0]);
    },
    async getById(id: string) {
      return mapPoll(
        (await q("SELECT * FROM meeting_polls WHERE id=$1 AND deleted=0", [id])).rows[0],
      );
    },
    async listForMeeting(meetingId: string) {
      return (
        await q(
          "SELECT * FROM meeting_polls WHERE meeting_id=$1 AND deleted=0 ORDER BY created_at",
          [meetingId],
        )
      ).rows.map(mapPoll);
    },
    async close(id: string) {
      await q(
        "UPDATE meeting_polls SET status='closed', closed_at=now(3) WHERE id=$1 AND deleted=0 AND status<>'closed'",
        [id],
      );
      return polls.getById(id);
    },
    async remove(id: string) {
      const r = await q(
        "UPDATE meeting_polls SET deleted=1, deleted_at=now(3) WHERE id=$1 AND deleted=0",
        [id],
      );
      return { id, removed: (r.rowCount || 0) > 0 };
    },
    // Casting a vote REPLACES this person's previous answer, so changing your
    // mind while a poll is open works and can never leave two answers behind.
    // Single-choice is the same code path with a one-element array.
    async vote(pollId: string, userId: string, optionIndexes: number[]) {
      await q("DELETE FROM meeting_poll_votes WHERE poll_id=$1 AND user_id=$2", [pollId, userId]);
      for (const idx of optionIndexes)
        await q(
          "INSERT INTO meeting_poll_votes (poll_id, user_id, option_index) VALUES ($1,$2,$3)",
          [pollId, userId, idx],
        );
      return { pollId, userId, optionIndexes };
    },
    // Counts per option, plus how many DISTINCT people answered — which is not
    // the sum of the counts once a poll allows multiple choices.
    async tally(pollId: string) {
      const counts = (
        await q(
          "SELECT option_index, COUNT(*) AS n FROM meeting_poll_votes WHERE poll_id=$1 GROUP BY option_index",
          [pollId],
        )
      ).rows;
      const voters = (
        await q(
          "SELECT COUNT(DISTINCT user_id) AS n FROM meeting_poll_votes WHERE poll_id=$1",
          [pollId],
        )
      ).rows[0];
      return {
        counts: Object.fromEntries(counts.map((r: any) => [Number(r.option_index), Number(r.n)])),
        voterCount: Number((voters && voters.n) || 0),
      };
    },
    async myVote(pollId: string, userId: string) {
      return (
        await q(
          "SELECT option_index FROM meeting_poll_votes WHERE poll_id=$1 AND user_id=$2 ORDER BY option_index",
          [pollId, userId],
        )
      ).rows.map((r: any) => Number(r.option_index));
    },
    // Only ever called for a NON-anonymous poll — the service enforces that.
    async voters(pollId: string) {
      return (
        await q(
          "SELECT user_id, option_index FROM meeting_poll_votes WHERE poll_id=$1 ORDER BY option_index",
          [pollId],
        )
      ).rows.map((r: any) => ({ userId: r.user_id, optionIndex: Number(r.option_index) }));
    },
  };

  return {
    driver: "mysql",
    users,
    whiteboards,
    orgs,
    // Chat webhooks, both directions — see migrations/0115_chat_webhooks.sql.
    webhooks,
    // Unified Connector Engine (Teams/Slack/Google/WhatsApp + calendars) —
    // see migrations/0129_connector_engine.sql and drivers/mysqlConnectors.ts.
    connectors: createMysqlConnectorsRepo(q, genId),
    // Meeting polls — see migrations/0121_meeting_polls.sql.
    polls,
    conversations,
    messages,
    bookmarks,
    meetings,
    folders,
    reminders,
    calls,
    tasks,
    // PROJECTS-AS-ENTITIES + SAVED VIEWS (#52b).
    taskProjects,
    taskSavedViews,
    invites,
    settings,
    meetingMessages,
    files,
    fileShares,
    audit,
    errorLogs,
    concerns,
    recordings,
    voicemails,
    e2ee,
    scheduledMessages,
    notifications,
    blocks,
    telemetry,
    // AUTH SESSIONS (#66): durable login-session tracking + revocation.
    sessions,
    // REFRESH-TOKEN ROTATION (Phase 5): opaque, single-use, family-scoped refresh tokens.
    refreshTokens,
    mfa,
    // Custom stickers / GIFs — WhatsApp-style personal reusable tray.
    stickers,
    // POST-CALL / POST-MEETING FEEDBACK (#67): analytics sink for the feedback dialog.
    callFeedback,
    pushSubscriptions: {
      async upsert(userId: string, sub: { endpoint: string; p256dh: string; auth: string }, userAgent?: string) {
        const existing = (await q(
          "SELECT id FROM push_subscriptions WHERE endpoint=$1 AND deleted=0",
          [sub.endpoint],
        )).rows[0];
        if (existing) {
          await q(
            "UPDATE push_subscriptions SET user_id=$1, p256dh=$2, auth=$3, user_agent=$4, last_used_at=now() WHERE id=$5",
            [userId, sub.p256dh, sub.auth, userAgent || null, existing.id],
          );
          return existing.id;
        }
        const id = genId();
        await q(
          `INSERT INTO push_subscriptions (id,user_id,endpoint,p256dh,auth,user_agent)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [id, userId, sub.endpoint, sub.p256dh, sub.auth, userAgent || null],
        );
        return id;
      },
      async removeByEndpoint(endpoint: string) {
        await q(
          "UPDATE push_subscriptions SET deleted=1, deleted_at=now(3) WHERE endpoint=$1 AND deleted=0",
          [endpoint],
        );
      },
      async removeForUser(userId: string) {
        await q(
          "UPDATE push_subscriptions SET deleted=1, deleted_at=now(3) WHERE user_id=$1 AND deleted=0",
          [userId],
        );
      },
      async listForUser(userId: string) {
        return (await q(
          "SELECT * FROM push_subscriptions WHERE user_id=$1 AND deleted=0 ORDER BY created_at DESC",
          [userId],
        )).rows;
      },
      async listForUsers(userIds: string[]) {
        if (!userIds.length) return [];
        const ph = userIds.map((_, i) => `$${i + 1}`).join(",");
        return (await q(
          `SELECT * FROM push_subscriptions WHERE user_id IN (${ph}) AND deleted=0`,
          userIds,
        )).rows;
      },
    },
    // MOBILE PUSH DEVICES (0124): FCM / APNs registrations for the Flutter app.
    // Same shape as pushSubscriptions above; `token` is the identity of a row
    // (a token moving between accounts on a shared phone re-homes the row).
    pushDevices: {
      async upsert(
        userId: string,
        dev: { platform: string; token: string; voipToken?: string | null; deviceId?: string | null; appVersion?: string | null; sessionJti?: string | null },
        userAgent?: string,
      ) {
        const existing = (await q(
          "SELECT id, voip_token, session_jti FROM push_devices WHERE token=$1",
          [dev.token],
        )).rows[0];
        if (existing) {
          await q(
            `UPDATE push_devices SET user_id=$1, platform=$2, voip_token=$3, device_id=$4, app_version=$5,
               user_agent=$6, session_jti=$7, last_seen_at=now(3), deleted=0, deleted_at=NULL WHERE id=$8`,
            [
              userId, dev.platform,
              // A re-register without a VoIP token (Android, or iOS before PushKit
              // answered) must not blank one we already hold.
              dev.voipToken === undefined ? existing.voip_token : dev.voipToken,
              dev.deviceId || null, dev.appVersion || null, userAgent || null,
              // K4: the session that (re)registered the row — a jti-less token
              // keeps whatever binding we already hold.
              dev.sessionJti === undefined ? existing.session_jti : dev.sessionJti,
              existing.id,
            ],
          );
          return existing.id;
        }
        const id = genId();
        await q(
          `INSERT INTO push_devices (id,user_id,platform,token,voip_token,device_id,app_version,user_agent,session_jti)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [id, userId, dev.platform, dev.token, dev.voipToken || null, dev.deviceId || null, dev.appVersion || null, userAgent || null, dev.sessionJti || null],
        );
        return id;
      },
      async removeByToken(token: string) {
        await q(
          "UPDATE push_devices SET deleted=1, deleted_at=now(3) WHERE token=$1 AND deleted=0",
          [token],
        );
      },
      async removeByVoipToken(voipToken: string) {
        await q(
          "UPDATE push_devices SET voip_token=NULL WHERE voip_token=$1",
          [voipToken],
        );
      },
      async removeForUser(userId: string) {
        await q(
          "UPDATE push_devices SET deleted=1, deleted_at=now(3) WHERE user_id=$1 AND deleted=0",
          [userId],
        );
      },
      // K4: retire every device registered under a session that just ended
      // server-side (revoke / evict / idle GC / account delete). Returns the
      // number of rows retired so callers can log it.
      async removeBySession(sessionJti: string) {
        if (!sessionJti) return 0;
        const r = await q(
          "UPDATE push_devices SET deleted=1, deleted_at=now(3) WHERE session_jti=$1 AND deleted=0",
          [sessionJti],
        );
        return r.rowCount || 0;
      },
      // K4 sweep: a phone that hasn't re-registered in `days` (default 60) was
      // wiped / reinstalled / lost — its token is dead weight (and FCM would
      // 404 it anyway). Soft-delete like every other path.
      async sweepStale(days = 60) {
        const r = await q(
          "UPDATE push_devices SET deleted=1, deleted_at=now(3) WHERE deleted=0 AND last_seen_at < DATE_SUB(now(3), INTERVAL $1 DAY)",
          [Math.max(1, Number(days) || 60)],
        );
        return r.rowCount || 0;
      },
      async listForUser(userId: string) {
        return (await q(
          "SELECT * FROM push_devices WHERE user_id=$1 AND deleted=0 ORDER BY last_seen_at DESC",
          [userId],
        )).rows.map(mapPushDevice);
      },
      async listForUsers(userIds: string[]) {
        if (!userIds.length) return [];
        const ph = userIds.map((_, i) => `$${i + 1}`).join(",");
        return (await q(
          `SELECT * FROM push_devices WHERE user_id IN (${ph}) AND deleted=0`,
          userIds,
        )).rows.map(mapPushDevice);
      },
    },
    // NOTIFICATION CLICK LEDGER (0124): idempotent on event_id so a retried
    // batch from the app never double-records a tap.
    pushClickEvents: {
      async record(userId: string, ev: any) {
        const id = genId();
        const r = await q(
          `INSERT IGNORE INTO push_click_events
             (id,event_id,user_id,platform,source,app_state,action,notification_type,tag,conversation_id,target_type,target_id,clicked_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            id, ev.eventId, userId, ev.platform || null, ev.source || null, ev.appState || null,
            ev.action || null, ev.notificationType || null, ev.tag || null, ev.conversationId || null,
            ev.targetType || null, ev.targetId || null, ev.clickedAt || null,
          ],
        );
        return (r && r.rowCount) ? true : false;
      },
      async listForUser(userId: string, limit = 50) {
        return (await q(
          "SELECT * FROM push_click_events WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2",
          [userId, Math.min(Math.max(Number(limit) || 50, 1), 500)],
        )).rows.map(mapPushClick);
      },
    },
    async withTransaction<T>(fn: (txQuery: (sql: string, params?: any[]) => Promise<any>) => Promise<T>): Promise<T> {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const txQ = async (t: string, p: any = []) => {
          assertOrgScoped(t);
          const bound = bind(translate(t), p || []);
          const params = bound.params.map(normParam);
          const [res]: any = await conn.query(bound.text, params);
          if (Array.isArray(res)) return { rows: res, rowCount: res.length };
          return { rows: [], rowCount: (res && res.affectedRows) || 0 };
        };
        const result = await fn(txQ);
        await conn.commit();
        return result;
      } catch (err) {
        try { await conn.rollback(); } catch (_) {}
        throw err;
      } finally {
        conn.release();
      }
    },
    pool,
  };
}
export { createMysqlDb };
