// Unified Connector Engine — MySQL repository (migrations/0129_connector_engine.sql).
//
// Pure persistence: the SERVICE (backend/app/src/services/connectors) owns every
// authorization rule, the credential sealing and the platform calls. This layer
// never sees a plaintext token (credentials arrive already sealed) and never
// decides who may read what.
//
// Factored out of drivers/mysql.ts so the engine's ~30 queries live next to each
// other instead of inside the 8k-line driver; the driver passes in its own q()
// (Postgres-style $n placeholders, { rows, rowCount } result shim) and id maker.
import { currentOrgId } from "../orgContext";

type Q = (sql: string, params?: any[]) => Promise<{ rows: any[]; rowCount: number }>;

const parseJson = (s: any, fallback: any) => {
  if (s == null || s === "") return fallback;
  if (typeof s !== "string") return s;
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
};

const mapAccount = (r: any) =>
  r && {
    id: r.id,
    organizationId: r.organization_id || null,
    platform: r.platform,
    name: r.name,
    externalWorkspaceId: r.external_workspace_id || null,
    botIds: String(r.bot_ids || "")
      .split(",")
      .map((s: string) => s.trim())
      .filter(Boolean),
    credentialsEnc: r.credentials_enc || null,
    credentialHint: r.credential_hint || null,
    settings: parseJson(r.settings_json, {}),
    enabled: !!r.enabled,
    lastStatus: r.last_status || null,
    lastActivityAt: r.last_activity_at || null,
    failureCount: Number(r.failure_count || 0),
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };

const mapMapping = (r: any) =>
  r && {
    id: r.id,
    organizationId: r.organization_id || null,
    accountId: r.account_id,
    conversationId: r.conversation_id,
    externalChannelId: r.external_channel_id,
    externalChannelName: r.external_channel_name || null,
    externalMeta: parseJson(r.external_meta_json, {}),
    direction: r.direction || "both",
    ownerId: r.owner_id,
    enabled: !!r.enabled,
    lastStatus: r.last_status || null,
    lastActivityAt: r.last_activity_at || null,
    failureCount: Number(r.failure_count || 0),
    createdAt: r.created_at,
  };

const mapMessageMapping = (r: any) =>
  r && {
    id: r.id,
    mappingId: r.mapping_id,
    conversationId: r.conversation_id,
    messageId: r.message_id,
    externalMessageId: r.external_message_id,
    externalThreadId: r.external_thread_id || null,
    direction: r.direction,
    createdAt: r.created_at,
    lastActivityAt: r.last_activity_at,
  };

const mapMeetingMapping = (r: any) =>
  r && {
    id: r.id,
    organizationId: r.organization_id || null,
    accountId: r.account_id,
    meetingId: r.meeting_id,
    externalCalendarId: r.external_calendar_id || "primary",
    externalEventId: r.external_event_id || null,
    joinUrl: r.join_url || null,
    scheduledStartUtc: r.scheduled_start_utc || null,
    scheduledEndUtc: r.scheduled_end_utc || null,
    externalUpdatedAt: r.external_updated_at || null,
    syncToken: r.sync_token || null,
    lastStatus: r.last_status || null,
    lastSyncedAt: r.last_synced_at || null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };

const mapJob = (r: any) =>
  r && {
    id: r.id,
    organizationId: r.organization_id || null,
    accountId: r.account_id,
    mappingId: r.mapping_id || null,
    kind: r.kind,
    dedupeKey: r.dedupe_key,
    payload: parseJson(r.payload, {}),
    status: r.status,
    attempts: Number(r.attempts || 0),
    error: r.error || null,
    result: parseJson(r.result_json, null),
    nextAttemptAt: r.next_attempt_at,
    claimedAt: r.claimed_at || null,
    createdAt: r.created_at,
    doneAt: r.done_at || null,
  };

export function createMysqlConnectorsRepo(q: Q, genId: () => string) {
  const clampLimit = (n: any, d: number, max: number) =>
    Math.max(1, Math.min(max, Number(n) || d));

  const connectors = {
    // ── Accounts ─────────────────────────────────────────────────────────────
    async createAccount(a: {
      platform: string;
      name: string;
      externalWorkspaceId?: string | null;
      botIds?: string[];
      credentialsEnc?: string | null;
      credentialHint?: string | null;
      settings?: any;
      createdBy: string;
      organizationId?: string | null;
    }) {
      const id = genId();
      await q(
        `INSERT INTO connector_accounts
           (id, organization_id, platform, name, external_workspace_id, bot_ids,
            credentials_enc, credential_hint, settings_json, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          id,
          a.organizationId === undefined ? currentOrgId() : a.organizationId,
          a.platform,
          a.name,
          a.externalWorkspaceId || null,
          (a.botIds || []).join(","),
          a.credentialsEnc || null,
          a.credentialHint || null,
          a.settings ? JSON.stringify(a.settings) : null,
          a.createdBy,
        ],
      );
      return connectors.getAccount(id);
    },
    async getAccount(id: string) {
      return mapAccount(
        (await q("SELECT * FROM connector_accounts WHERE id=$1 AND deleted=0", [id])).rows[0],
      );
    },
    async listAccounts(opts: { organizationId?: string | null; platform?: string } = {}) {
      const params: any[] = [];
      let where = "deleted=0";
      if (opts.organizationId !== undefined) {
        if (opts.organizationId === null) where += " AND organization_id IS NULL";
        else {
          params.push(opts.organizationId);
          where += ` AND organization_id=$${params.length}`;
        }
      }
      if (opts.platform) {
        params.push(opts.platform);
        where += ` AND platform=$${params.length}`;
      }
      return (
        await q(`SELECT * FROM connector_accounts WHERE ${where} ORDER BY created_at DESC`, params)
      ).rows.map(mapAccount);
    },
    // Every enabled account of a platform, across tenants — for the background
    // calendar pull sweep (org context is on the row for background jobs).
    async listEnabledAccountsByPlatform(platform: string) {
      return (
        await q(
          "SELECT * FROM connector_accounts WHERE platform=$1 AND enabled=1 AND deleted=0",
          [platform],
        )
      ).rows.map(mapAccount);
    },
    async updateAccount(
      id: string,
      patch: {
        name?: string;
        enabled?: boolean;
        externalWorkspaceId?: string | null;
        botIds?: string[];
        credentialsEnc?: string | null;
        credentialHint?: string | null;
        settings?: any;
      },
    ) {
      const sets: string[] = [];
      const params: any[] = [];
      const set = (col: string, v: any) => {
        params.push(v);
        sets.push(`${col}=$${params.length}`);
      };
      if (patch.name !== undefined) set("name", patch.name);
      if (patch.enabled !== undefined) set("enabled", patch.enabled ? 1 : 0);
      if (patch.externalWorkspaceId !== undefined)
        set("external_workspace_id", patch.externalWorkspaceId || null);
      if (patch.botIds !== undefined) set("bot_ids", (patch.botIds || []).join(","));
      if (patch.credentialsEnc !== undefined) set("credentials_enc", patch.credentialsEnc || null);
      if (patch.credentialHint !== undefined) set("credential_hint", patch.credentialHint || null);
      if (patch.settings !== undefined)
        set("settings_json", patch.settings ? JSON.stringify(patch.settings) : null);
      if (sets.length) {
        params.push(id);
        await q(
          `UPDATE connector_accounts SET ${sets.join(", ")} WHERE id=$${params.length} AND deleted=0`,
          params,
        );
      }
      return connectors.getAccount(id);
    },
    async removeAccount(id: string) {
      const r = await q(
        "UPDATE connector_accounts SET deleted=1, deleted_at=now(3), enabled=0 WHERE id=$1 AND deleted=0",
        [id],
      );
      return { id, removed: (r.rowCount || 0) > 0 };
    },
    async markAccountHealth(id: string, status: string, failed: boolean) {
      await q(
        `UPDATE connector_accounts
           SET last_status=$1, last_activity_at=now(3),
               failure_count = CASE WHEN $2 = 1 THEN failure_count + 1 ELSE 0 END
         WHERE id=$3`,
        [String(status).slice(0, 64), failed ? 1 : 0, id],
      );
    },

    // ── Channel mappings ─────────────────────────────────────────────────────
    async createMapping(m: {
      accountId: string;
      conversationId: string;
      externalChannelId: string;
      externalChannelName?: string | null;
      externalMeta?: any;
      direction?: string;
      ownerId: string;
      organizationId?: string | null;
    }) {
      const id = genId();
      await q(
        `INSERT INTO connector_channel_mappings
           (id, organization_id, account_id, conversation_id, external_channel_id,
            external_channel_name, external_meta_json, direction, owner_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          id,
          m.organizationId === undefined ? currentOrgId() : m.organizationId,
          m.accountId,
          m.conversationId,
          m.externalChannelId,
          m.externalChannelName || null,
          m.externalMeta ? JSON.stringify(m.externalMeta) : null,
          m.direction || "both",
          m.ownerId,
        ],
      );
      return connectors.getMapping(id);
    },
    async getMapping(id: string) {
      return mapMapping(
        (await q("SELECT * FROM connector_channel_mappings WHERE id=$1 AND deleted=0", [id]))
          .rows[0],
      );
    },
    async listMappingsForConversation(conversationId: string) {
      return (
        await q(
          "SELECT * FROM connector_channel_mappings WHERE conversation_id=$1 AND deleted=0 ORDER BY created_at DESC",
          [conversationId],
        )
      ).rows.map(mapMapping);
    },
    async listMappingsForAccount(accountId: string) {
      return (
        await q(
          "SELECT * FROM connector_channel_mappings WHERE account_id=$1 AND deleted=0 ORDER BY created_at DESC",
          [accountId],
        )
      ).rows.map(mapMapping);
    },
    async listMappingsForOwner(ownerId: string) {
      return (
        await q(
          "SELECT * FROM connector_channel_mappings WHERE owner_id=$1 AND deleted=0 ORDER BY created_at DESC",
          [ownerId],
        )
      ).rows.map(mapMapping);
    },
    // Inbound routing: which CoLab conversations does this platform channel feed?
    async findMappingsByChannel(accountId: string, externalChannelId: string) {
      return (
        await q(
          `SELECT * FROM connector_channel_mappings
            WHERE account_id=$1 AND external_channel_id=$2 AND enabled=1 AND deleted=0
              AND direction IN ('both','inbound')`,
          [accountId, externalChannelId],
        )
      ).rows.map(mapMapping);
    },
    // Outbound fan-out read, on the message-send path: enabled outbound mappings
    // of this conversation whose ACCOUNT is also enabled. Indexed by
    // (conversation_id, enabled).
    async listOutboundFor(conversationId: string) {
      return (
        await q(
          `SELECT m.*, a.platform AS account_platform
             FROM connector_channel_mappings m
             JOIN connector_accounts a ON a.id = m.account_id
            WHERE m.conversation_id=$1 AND m.enabled=1 AND m.deleted=0
              AND m.direction IN ('both','outbound')
              AND a.enabled=1 AND a.deleted=0`,
          [conversationId],
        )
      ).rows.map((r: any) => ({ ...mapMapping(r), platform: r.account_platform }));
    },
    async updateMapping(
      id: string,
      patch: {
        externalChannelName?: string | null;
        externalMeta?: any;
        direction?: string;
        enabled?: boolean;
      },
    ) {
      const sets: string[] = [];
      const params: any[] = [];
      const set = (col: string, v: any) => {
        params.push(v);
        sets.push(`${col}=$${params.length}`);
      };
      if (patch.externalChannelName !== undefined)
        set("external_channel_name", patch.externalChannelName || null);
      if (patch.externalMeta !== undefined)
        set("external_meta_json", patch.externalMeta ? JSON.stringify(patch.externalMeta) : null);
      if (patch.direction !== undefined) set("direction", patch.direction);
      if (patch.enabled !== undefined) set("enabled", patch.enabled ? 1 : 0);
      if (sets.length) {
        params.push(id);
        await q(
          `UPDATE connector_channel_mappings SET ${sets.join(", ")} WHERE id=$${params.length} AND deleted=0`,
          params,
        );
      }
      return connectors.getMapping(id);
    },
    async removeMapping(id: string) {
      const r = await q(
        "UPDATE connector_channel_mappings SET deleted=1, deleted_at=now(3), enabled=0 WHERE id=$1 AND deleted=0",
        [id],
      );
      return { id, removed: (r.rowCount || 0) > 0 };
    },
    async markMappingHealth(id: string, status: string, failed: boolean) {
      await q(
        `UPDATE connector_channel_mappings
           SET last_status=$1, last_activity_at=now(3),
               failure_count = CASE WHEN $2 = 1 THEN failure_count + 1 ELSE 0 END
         WHERE id=$3`,
        [String(status).slice(0, 64), failed ? 1 : 0, id],
      );
    },

    // ── Message / thread mappings ────────────────────────────────────────────
    // INSERT IGNORE against the (mapping, external id) and (mapping, message)
    // unique keys: `inserted:false` means the counterpart was already known —
    // the durable echo/duplicate guard.
    async recordMessage(m: {
      mappingId: string;
      conversationId: string;
      messageId: string;
      externalMessageId: string;
      externalThreadId?: string | null;
      direction: "in" | "out";
    }) {
      const id = genId();
      const r = await q(
        `INSERT IGNORE INTO connector_message_mappings
           (id, mapping_id, conversation_id, message_id, external_message_id, external_thread_id, direction)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          id,
          m.mappingId,
          m.conversationId,
          m.messageId,
          String(m.externalMessageId).slice(0, 191),
          m.externalThreadId ? String(m.externalThreadId).slice(0, 191) : null,
          m.direction,
        ],
      );
      return { id, inserted: (r.rowCount || 0) > 0 };
    },
    async findByExternal(mappingId: string, externalMessageId: string) {
      return mapMessageMapping(
        (
          await q(
            "SELECT * FROM connector_message_mappings WHERE mapping_id=$1 AND external_message_id=$2",
            [mappingId, String(externalMessageId).slice(0, 191)],
          )
        ).rows[0],
      );
    },
    async findByMessage(mappingId: string, messageId: string) {
      return mapMessageMapping(
        (
          await q(
            "SELECT * FROM connector_message_mappings WHERE mapping_id=$1 AND message_id=$2",
            [mappingId, messageId],
          )
        ).rows[0],
      );
    },
    // The ROOT of an external thread as we know it: the earliest message we
    // mapped into that thread (Google Chat threads have a name distinct from
    // any message id, so the root cannot be looked up by message id alone).
    async findByThread(mappingId: string, externalThreadId: string) {
      return mapMessageMapping(
        (
          await q(
            `SELECT * FROM connector_message_mappings
              WHERE mapping_id=$1 AND (external_thread_id=$2 OR external_message_id=$2)
              ORDER BY created_at ASC LIMIT 1`,
            [mappingId, String(externalThreadId).slice(0, 191)],
          )
        ).rows[0],
      );
    },
    // Every platform counterpart of one CoLab message (for edits / deletes).
    async listByMessage(messageId: string) {
      return (
        await q("SELECT * FROM connector_message_mappings WHERE message_id=$1", [messageId])
      ).rows.map(mapMessageMapping);
    },
    async touchThread(mappingId: string, externalThreadId: string) {
      await q(
        "UPDATE connector_message_mappings SET last_activity_at=now(3) WHERE mapping_id=$1 AND external_message_id=$2",
        [mappingId, String(externalThreadId).slice(0, 191)],
      );
    },

    // ── Meeting mappings ─────────────────────────────────────────────────────
    async upsertMeetingMapping(m: {
      accountId: string;
      meetingId: string;
      externalCalendarId?: string | null;
      externalEventId?: string | null;
      joinUrl?: string | null;
      scheduledStartUtc?: string | Date | null;
      scheduledEndUtc?: string | Date | null;
      externalUpdatedAt?: string | Date | null;
      lastStatus?: string | null;
      organizationId?: string | null;
    }) {
      const existing = await connectors.getMeetingMapping(m.accountId, m.meetingId);
      if (!existing) {
        const id = genId();
        await q(
          `INSERT INTO connector_meeting_mappings
             (id, organization_id, account_id, meeting_id, external_calendar_id, external_event_id,
              join_url, scheduled_start_utc, scheduled_end_utc, external_updated_at, last_status, last_synced_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now(3))`,
          [
            id,
            m.organizationId === undefined ? currentOrgId() : m.organizationId,
            m.accountId,
            m.meetingId,
            m.externalCalendarId || "primary",
            m.externalEventId || null,
            m.joinUrl || null,
            m.scheduledStartUtc || null,
            m.scheduledEndUtc || null,
            m.externalUpdatedAt || null,
            m.lastStatus || null,
          ],
        );
        return mapMeetingMapping(
          (await q("SELECT * FROM connector_meeting_mappings WHERE id=$1", [id])).rows[0],
        );
      }
      const sets: string[] = ["last_synced_at=now(3)"];
      const params: any[] = [];
      const set = (col: string, v: any) => {
        params.push(v);
        sets.push(`${col}=$${params.length}`);
      };
      if (m.externalCalendarId !== undefined) set("external_calendar_id", m.externalCalendarId || "primary");
      if (m.externalEventId !== undefined) set("external_event_id", m.externalEventId || null);
      if (m.joinUrl !== undefined) set("join_url", m.joinUrl || null);
      if (m.scheduledStartUtc !== undefined) set("scheduled_start_utc", m.scheduledStartUtc || null);
      if (m.scheduledEndUtc !== undefined) set("scheduled_end_utc", m.scheduledEndUtc || null);
      if (m.externalUpdatedAt !== undefined) set("external_updated_at", m.externalUpdatedAt || null);
      if (m.lastStatus !== undefined) set("last_status", m.lastStatus || null);
      params.push(existing.id);
      await q(
        `UPDATE connector_meeting_mappings SET ${sets.join(", ")} WHERE id=$${params.length}`,
        params,
      );
      return mapMeetingMapping(
        (await q("SELECT * FROM connector_meeting_mappings WHERE id=$1", [existing.id])).rows[0],
      );
    },
    async getMeetingMapping(accountId: string, meetingId: string) {
      return mapMeetingMapping(
        (
          await q(
            "SELECT * FROM connector_meeting_mappings WHERE account_id=$1 AND meeting_id=$2",
            [accountId, meetingId],
          )
        ).rows[0],
      );
    },
    async listMeetingMappingsForMeeting(meetingId: string) {
      return (
        await q("SELECT * FROM connector_meeting_mappings WHERE meeting_id=$1", [meetingId])
      ).rows.map(mapMeetingMapping);
    },
    async findMeetingMappingByExternal(accountId: string, externalEventId: string) {
      return mapMeetingMapping(
        (
          await q(
            "SELECT * FROM connector_meeting_mappings WHERE account_id=$1 AND external_event_id=$2",
            [accountId, String(externalEventId).slice(0, 191)],
          )
        ).rows[0],
      );
    },
    async listMeetingMappingsForAccount(accountId: string, limit = 500) {
      return (
        await q(
          "SELECT * FROM connector_meeting_mappings WHERE account_id=$1 ORDER BY updated_at DESC LIMIT $2",
          [accountId, clampLimit(limit, 500, 2000)],
        )
      ).rows.map(mapMeetingMapping);
    },
    async setMeetingSyncToken(id: string, token: string | null) {
      await q(
        "UPDATE connector_meeting_mappings SET sync_token=$1, last_synced_at=now(3) WHERE id=$2",
        [token, id],
      );
    },
    async removeMeetingMapping(id: string) {
      const r = await q("DELETE FROM connector_meeting_mappings WHERE id=$1", [id]);
      return { id, removed: (r.rowCount || 0) > 0 };
    },

    // ── Job queue ────────────────────────────────────────────────────────────
    // `null` back means the dedupe key already exists: the job was enqueued
    // before (a redelivered webhook, a double dispatch) and is NOT re-queued.
    async enqueueJob(j: {
      accountId: string;
      mappingId?: string | null;
      kind: string;
      dedupeKey: string;
      payload: any;
      delaySec?: number;
      organizationId?: string | null;
    }) {
      const id = genId();
      const r = await q(
        `INSERT IGNORE INTO connector_jobs
           (id, organization_id, account_id, mapping_id, kind, dedupe_key, payload, next_attempt_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7, DATE_ADD(now(3), INTERVAL $8 SECOND))`,
        [
          id,
          j.organizationId === undefined ? currentOrgId() : j.organizationId,
          j.accountId,
          j.mappingId || null,
          j.kind,
          String(j.dedupeKey).slice(0, 191),
          JSON.stringify(j.payload ?? {}),
          Math.max(0, Math.round(Number(j.delaySec) || 0)),
        ],
      );
      return (r.rowCount || 0) > 0 ? id : null;
    },
    // Atomic claim: the UPDATE ... ORDER BY ... LIMIT flips the rows to
    // 'running' under their row locks, so two replicas draining at once can
    // never hand the same job to two platform calls. Returns the rows joined
    // with what the worker needs (sealed credentials + mapping routing).
    async claimJobs(limit = 20) {
      const claim = genId();
      const r = await q(
        `UPDATE connector_jobs
           SET status='running', claim_token=$1, claimed_at=now(3)
         WHERE status='pending' AND next_attempt_at <= now(3)
         ORDER BY next_attempt_at
         LIMIT $2`,
        [claim, clampLimit(limit, 20, 200)],
      );
      if (!r.rowCount) return [];
      return (
        await q(
          `SELECT j.*,
                  a.platform AS a_platform, a.credentials_enc AS a_credentials_enc,
                  a.settings_json AS a_settings_json, a.bot_ids AS a_bot_ids,
                  a.external_workspace_id AS a_external_workspace_id,
                  a.enabled AS a_enabled, a.deleted AS a_deleted, a.organization_id AS a_org,
                  m.external_channel_id AS m_external_channel_id,
                  m.external_meta_json AS m_external_meta_json,
                  m.conversation_id AS m_conversation_id, m.owner_id AS m_owner_id,
                  m.direction AS m_direction, m.enabled AS m_enabled, m.deleted AS m_deleted
             FROM connector_jobs j
             JOIN connector_accounts a ON a.id = j.account_id
             LEFT JOIN connector_channel_mappings m ON m.id = j.mapping_id
            WHERE j.claim_token=$1 AND j.status='running'`,
          [claim],
        )
      ).rows.map((row: any) => ({
        ...mapJob(row),
        account: {
          id: row.account_id,
          organizationId: row.a_org || null,
          platform: row.a_platform,
          credentialsEnc: row.a_credentials_enc || null,
          settings: parseJson(row.a_settings_json, {}),
          botIds: String(row.a_bot_ids || "").split(",").filter(Boolean),
          externalWorkspaceId: row.a_external_workspace_id || null,
          live: !!row.a_enabled && !row.a_deleted,
        },
        mapping: row.mapping_id
          ? {
              id: row.mapping_id,
              externalChannelId: row.m_external_channel_id,
              externalMeta: parseJson(row.m_external_meta_json, {}),
              conversationId: row.m_conversation_id,
              ownerId: row.m_owner_id,
              direction: row.m_direction || "both",
              live: !!row.m_enabled && !row.m_deleted,
            }
          : null,
      }));
    },
    async markJobDone(id: string, result: any) {
      await q(
        `UPDATE connector_jobs
           SET status='done', attempts=attempts+1, error=NULL, claim_token=NULL,
               result_json=$1, done_at=now(3)
         WHERE id=$2`,
        [result == null ? null : JSON.stringify(result).slice(0, 60000), id],
      );
    },
    // Retry with the caller-computed backoff, or give up permanently once the
    // attempt budget is spent (`retryInSec` NULL).
    async markJobFailed(id: string, error: string, retryInSec: number | null) {
      if (retryInSec == null) {
        await q(
          "UPDATE connector_jobs SET status='failed', attempts=attempts+1, error=$1, claim_token=NULL, done_at=now(3) WHERE id=$2",
          [String(error || "").slice(0, 512), id],
        );
        return;
      }
      await q(
        `UPDATE connector_jobs
           SET status='pending', attempts=attempts+1, error=$1, claim_token=NULL,
               next_attempt_at = DATE_ADD(now(3), INTERVAL $2 SECOND)
         WHERE id=$3`,
        [String(error || "").slice(0, 512), Math.max(1, Math.round(retryInSec)), id],
      );
    },
    async getJob(id: string) {
      return mapJob((await q("SELECT * FROM connector_jobs WHERE id=$1", [id])).rows[0]);
    },
    async listJobs(opts: { accountId?: string; mappingId?: string; status?: string; limit?: number } = {}) {
      const params: any[] = [];
      const where: string[] = ["1=1"];
      if (opts.accountId) {
        params.push(opts.accountId);
        where.push(`account_id=$${params.length}`);
      }
      if (opts.mappingId) {
        params.push(opts.mappingId);
        where.push(`mapping_id=$${params.length}`);
      }
      if (opts.status) {
        params.push(opts.status);
        where.push(`status=$${params.length}`);
      }
      params.push(clampLimit(opts.limit, 50, 200));
      return (
        await q(
          `SELECT * FROM connector_jobs WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT $${params.length}`,
          params,
        )
      ).rows.map(mapJob);
    },
    // Operator "try again" on a permanently failed job. Resets the attempt
    // budget so the backoff schedule starts over.
    async retryJob(id: string) {
      const r = await q(
        "UPDATE connector_jobs SET status='pending', attempts=0, error=NULL, claim_token=NULL, next_attempt_at=now(3), done_at=NULL WHERE id=$1 AND status='failed'",
        [id],
      );
      return (r.rowCount || 0) > 0;
    },
    // Re-arm jobs a crashed/redeployed process left mid-flight.
    async requeueStaleJobs(olderThanSec = 300) {
      const r = await q(
        `UPDATE connector_jobs
           SET status='pending', claim_token=NULL, next_attempt_at=now(3)
         WHERE status='running' AND claimed_at < DATE_SUB(now(3), INTERVAL $1 SECOND)`,
        [Math.max(30, olderThanSec)],
      );
      return r.rowCount || 0;
    },
    // Retention: finished jobs are an operational aid (payloads embed message
    // text), so old rows are hard-deleted. Pending/running rows are never pruned.
    async pruneJobs(retentionDays = 14) {
      const r = await q(
        "DELETE FROM connector_jobs WHERE status IN ('done','failed') AND created_at < DATE_SUB(now(3), INTERVAL $1 DAY)",
        [Math.max(1, retentionDays)],
      );
      return r.rowCount || 0;
    },
    async countJobs(accountId: string) {
      const rows = (
        await q(
          "SELECT status, COUNT(*) AS n FROM connector_jobs WHERE account_id=$1 GROUP BY status",
          [accountId],
        )
      ).rows;
      const out: Record<string, number> = { pending: 0, running: 0, done: 0, failed: 0 };
      for (const r of rows) out[r.status] = Number(r.n || 0);
      return out;
    },
  };
  return connectors;
}
