// Unified Connector Engine — JSON file-store repository.
//
// Same surface as drivers/mysqlConnectors.ts so the connector services are driver
// agnostic (DATABASE_DRIVER=json local dev needs no MySQL). Single-process by
// construction, so the "atomic claim" is a synchronous filter and the UNIQUE
// keys are explicit `find`s before an insert.
import { currentOrgId } from "../orgContext";

type Store = {
  tbl: (table: string) => any[];
  save: (table: string) => void;
  genId: () => string;
  now: () => string;
};

const T_ACC = "connector_accounts";
const T_MAP = "connector_channel_mappings";
const T_MSG = "connector_message_mappings";
const T_MTG = "connector_meeting_mappings";
const T_JOB = "connector_jobs";

const clampLimit = (n: any, d: number, max: number) => Math.max(1, Math.min(max, Number(n) || d));
const pub = (r: any) => {
  if (!r) return r;
  const { deleted: _d, deletedAt: _da, claimToken: _c, ...rest } = r;
  return rest;
};

export function createJsonConnectorsRepo({ tbl, save, genId, now }: Store) {
  const live = (r: any) => r && !r.deleted;
  const byCreatedDesc = (a: any, b: any) => String(b.createdAt).localeCompare(String(a.createdAt));

  const connectors = {
    // ── Accounts ─────────────────────────────────────────────────────────────
    async createAccount(a: any) {
      const row = {
        id: genId(),
        organizationId: a.organizationId === undefined ? currentOrgId() : a.organizationId,
        platform: a.platform,
        name: a.name,
        externalWorkspaceId: a.externalWorkspaceId || null,
        botIds: a.botIds || [],
        credentialsEnc: a.credentialsEnc || null,
        credentialHint: a.credentialHint || null,
        settings: a.settings || {},
        enabled: true,
        lastStatus: null,
        lastActivityAt: null,
        failureCount: 0,
        createdBy: a.createdBy,
        createdAt: now(),
        updatedAt: now(),
        deleted: false,
      };
      tbl(T_ACC).push(row);
      save(T_ACC);
      return pub(row);
    },
    async getAccount(id: string) {
      return pub(tbl(T_ACC).find((r) => r.id === id && live(r)));
    },
    async listAccounts(opts: any = {}) {
      return tbl(T_ACC)
        .filter(live)
        .filter((r) => (opts.organizationId === undefined ? true : (r.organizationId || null) === opts.organizationId))
        .filter((r) => (opts.platform ? r.platform === opts.platform : true))
        .sort(byCreatedDesc)
        .map(pub);
    },
    async listEnabledAccountsByPlatform(platform: string) {
      return tbl(T_ACC).filter((r) => live(r) && r.enabled && r.platform === platform).map(pub);
    },
    async updateAccount(id: string, patch: any) {
      const r = tbl(T_ACC).find((x) => x.id === id && live(x));
      if (r) {
        for (const k of ["name", "externalWorkspaceId", "botIds", "credentialsEnc", "credentialHint", "settings"])
          if (patch[k] !== undefined) r[k] = patch[k];
        if (patch.enabled !== undefined) r.enabled = !!patch.enabled;
        r.updatedAt = now();
        save(T_ACC);
      }
      return pub(r);
    },
    async removeAccount(id: string) {
      const r = tbl(T_ACC).find((x) => x.id === id && live(x));
      if (r) {
        r.deleted = true;
        r.deletedAt = now();
        r.enabled = false;
        save(T_ACC);
      }
      return { id, removed: !!r };
    },
    async markAccountHealth(id: string, status: string, failed: boolean) {
      const r = tbl(T_ACC).find((x) => x.id === id);
      if (r) {
        r.lastStatus = String(status).slice(0, 64);
        r.lastActivityAt = now();
        r.failureCount = failed ? Number(r.failureCount || 0) + 1 : 0;
        save(T_ACC);
      }
    },

    // ── Channel mappings ─────────────────────────────────────────────────────
    async createMapping(m: any) {
      const dup = tbl(T_MAP).find(
        (r) =>
          r.accountId === m.accountId &&
          r.externalChannelId === m.externalChannelId &&
          r.conversationId === m.conversationId,
      );
      if (dup) {
        const e: any = new Error("That already exists.");
        e.errno = 1062;
        throw e;
      }
      const row = {
        id: genId(),
        organizationId: m.organizationId === undefined ? currentOrgId() : m.organizationId,
        accountId: m.accountId,
        conversationId: m.conversationId,
        externalChannelId: m.externalChannelId,
        externalChannelName: m.externalChannelName || null,
        externalMeta: m.externalMeta || {},
        direction: m.direction || "both",
        ownerId: m.ownerId,
        enabled: true,
        lastStatus: null,
        lastActivityAt: null,
        failureCount: 0,
        createdAt: now(),
        deleted: false,
      };
      tbl(T_MAP).push(row);
      save(T_MAP);
      return pub(row);
    },
    async getMapping(id: string) {
      return pub(tbl(T_MAP).find((r) => r.id === id && live(r)));
    },
    async listMappingsForConversation(conversationId: string) {
      return tbl(T_MAP).filter((r) => live(r) && r.conversationId === conversationId).sort(byCreatedDesc).map(pub);
    },
    async listMappingsForAccount(accountId: string) {
      return tbl(T_MAP).filter((r) => live(r) && r.accountId === accountId).sort(byCreatedDesc).map(pub);
    },
    async listMappingsForOwner(ownerId: string) {
      return tbl(T_MAP).filter((r) => live(r) && r.ownerId === ownerId).sort(byCreatedDesc).map(pub);
    },
    async findMappingsByChannel(accountId: string, externalChannelId: string) {
      return tbl(T_MAP)
        .filter(
          (r) =>
            live(r) &&
            r.enabled &&
            r.accountId === accountId &&
            r.externalChannelId === externalChannelId &&
            ["both", "inbound"].includes(r.direction || "both"),
        )
        .map(pub);
    },
    async listOutboundFor(conversationId: string) {
      const accounts = tbl(T_ACC);
      return tbl(T_MAP)
        .filter(
          (r) =>
            live(r) &&
            r.enabled &&
            r.conversationId === conversationId &&
            ["both", "outbound"].includes(r.direction || "both"),
        )
        .map((r) => ({ r, a: accounts.find((x) => x.id === r.accountId && live(x) && x.enabled) }))
        .filter(({ a }) => !!a)
        .map(({ r, a }) => ({ ...pub(r), platform: a.platform }));
    },
    async updateMapping(id: string, patch: any) {
      const r = tbl(T_MAP).find((x) => x.id === id && live(x));
      if (r) {
        for (const k of ["externalChannelName", "externalMeta", "direction"]) if (patch[k] !== undefined) r[k] = patch[k];
        if (patch.enabled !== undefined) r.enabled = !!patch.enabled;
        save(T_MAP);
      }
      return pub(r);
    },
    async removeMapping(id: string) {
      const r = tbl(T_MAP).find((x) => x.id === id && live(x));
      if (r) {
        r.deleted = true;
        r.deletedAt = now();
        r.enabled = false;
        save(T_MAP);
      }
      return { id, removed: !!r };
    },
    async markMappingHealth(id: string, status: string, failed: boolean) {
      const r = tbl(T_MAP).find((x) => x.id === id);
      if (r) {
        r.lastStatus = String(status).slice(0, 64);
        r.lastActivityAt = now();
        r.failureCount = failed ? Number(r.failureCount || 0) + 1 : 0;
        save(T_MAP);
      }
    },

    // ── Message / thread mappings ────────────────────────────────────────────
    async recordMessage(m: any) {
      const ext = String(m.externalMessageId).slice(0, 191);
      const exists = tbl(T_MSG).find(
        (r) => r.mappingId === m.mappingId && (r.externalMessageId === ext || r.messageId === m.messageId),
      );
      const id = genId();
      if (exists) return { id, inserted: false };
      tbl(T_MSG).push({
        id,
        mappingId: m.mappingId,
        conversationId: m.conversationId,
        messageId: m.messageId,
        externalMessageId: ext,
        externalThreadId: m.externalThreadId ? String(m.externalThreadId).slice(0, 191) : null,
        direction: m.direction,
        createdAt: now(),
        lastActivityAt: now(),
      });
      save(T_MSG);
      return { id, inserted: true };
    },
    async findByExternal(mappingId: string, externalMessageId: string) {
      const ext = String(externalMessageId).slice(0, 191);
      return tbl(T_MSG).find((r) => r.mappingId === mappingId && r.externalMessageId === ext) || null;
    },
    async findByMessage(mappingId: string, messageId: string) {
      return tbl(T_MSG).find((r) => r.mappingId === mappingId && r.messageId === messageId) || null;
    },
    async findByThread(mappingId: string, externalThreadId: string) {
      const t = String(externalThreadId).slice(0, 191);
      return (
        tbl(T_MSG)
          .filter((r) => r.mappingId === mappingId && (r.externalThreadId === t || r.externalMessageId === t))
          .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0] || null
      );
    },
    async listByMessage(messageId: string) {
      return tbl(T_MSG).filter((r) => r.messageId === messageId);
    },
    async touchThread(mappingId: string, externalThreadId: string) {
      const r = tbl(T_MSG).find((x) => x.mappingId === mappingId && x.externalMessageId === String(externalThreadId).slice(0, 191));
      if (r) {
        r.lastActivityAt = now();
        save(T_MSG);
      }
    },

    // ── Meeting mappings ─────────────────────────────────────────────────────
    async upsertMeetingMapping(m: any) {
      let r = tbl(T_MTG).find((x) => x.accountId === m.accountId && x.meetingId === m.meetingId);
      if (!r) {
        r = {
          id: genId(),
          organizationId: m.organizationId === undefined ? currentOrgId() : m.organizationId,
          accountId: m.accountId,
          meetingId: m.meetingId,
          externalCalendarId: m.externalCalendarId || "primary",
          externalEventId: m.externalEventId || null,
          joinUrl: m.joinUrl || null,
          scheduledStartUtc: m.scheduledStartUtc || null,
          scheduledEndUtc: m.scheduledEndUtc || null,
          externalUpdatedAt: m.externalUpdatedAt || null,
          syncToken: null,
          lastStatus: m.lastStatus || null,
          lastSyncedAt: now(),
          createdAt: now(),
          updatedAt: now(),
        };
        tbl(T_MTG).push(r);
      } else {
        for (const k of [
          "externalCalendarId",
          "externalEventId",
          "joinUrl",
          "scheduledStartUtc",
          "scheduledEndUtc",
          "externalUpdatedAt",
          "lastStatus",
        ])
          if (m[k] !== undefined) r[k] = m[k] || (k === "externalCalendarId" ? "primary" : null);
        r.lastSyncedAt = now();
        r.updatedAt = now();
      }
      save(T_MTG);
      return { ...r };
    },
    async getMeetingMapping(accountId: string, meetingId: string) {
      return tbl(T_MTG).find((x) => x.accountId === accountId && x.meetingId === meetingId) || null;
    },
    async listMeetingMappingsForMeeting(meetingId: string) {
      return tbl(T_MTG).filter((x) => x.meetingId === meetingId);
    },
    async findMeetingMappingByExternal(accountId: string, externalEventId: string) {
      return tbl(T_MTG).find((x) => x.accountId === accountId && x.externalEventId === externalEventId) || null;
    },
    async listMeetingMappingsForAccount(accountId: string, limit = 500) {
      return tbl(T_MTG)
        .filter((x) => x.accountId === accountId)
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
        .slice(0, clampLimit(limit, 500, 2000));
    },
    async setMeetingSyncToken(id: string, token: string | null) {
      const r = tbl(T_MTG).find((x) => x.id === id);
      if (r) {
        r.syncToken = token;
        r.lastSyncedAt = now();
        save(T_MTG);
      }
    },
    async removeMeetingMapping(id: string) {
      const arr = tbl(T_MTG);
      const i = arr.findIndex((x) => x.id === id);
      if (i >= 0) arr.splice(i, 1);
      save(T_MTG);
      return { id, removed: i >= 0 };
    },

    // ── Job queue ────────────────────────────────────────────────────────────
    async enqueueJob(j: any) {
      const key = String(j.dedupeKey).slice(0, 191);
      if (tbl(T_JOB).find((r) => r.dedupeKey === key)) return null;
      const id = genId();
      const at = new Date(Date.now() + Math.max(0, Math.round(Number(j.delaySec) || 0)) * 1000).toISOString();
      tbl(T_JOB).push({
        id,
        organizationId: j.organizationId === undefined ? currentOrgId() : j.organizationId,
        accountId: j.accountId,
        mappingId: j.mappingId || null,
        kind: j.kind,
        dedupeKey: key,
        payload: j.payload ?? {},
        status: "pending",
        claimToken: null,
        attempts: 0,
        error: null,
        result: null,
        nextAttemptAt: at,
        claimedAt: null,
        createdAt: now(),
        doneAt: null,
      });
      save(T_JOB);
      return id;
    },
    async claimJobs(limit = 20) {
      const t = now();
      const due = tbl(T_JOB)
        .filter((j) => j.status === "pending" && String(j.nextAttemptAt) <= t)
        .sort((a, b) => String(a.nextAttemptAt).localeCompare(String(b.nextAttemptAt)))
        .slice(0, clampLimit(limit, 20, 200));
      if (!due.length) return [];
      const claim = genId();
      for (const j of due) {
        j.status = "running";
        j.claimToken = claim;
        j.claimedAt = t;
      }
      save(T_JOB);
      const accounts = tbl(T_ACC);
      const maps = tbl(T_MAP);
      return due.map((j) => {
        const a = accounts.find((x) => x.id === j.accountId);
        const m = j.mappingId ? maps.find((x) => x.id === j.mappingId) : null;
        return {
          ...pub(j),
          account: a
            ? {
                id: a.id,
                organizationId: a.organizationId || null,
                platform: a.platform,
                credentialsEnc: a.credentialsEnc || null,
                settings: a.settings || {},
                botIds: a.botIds || [],
                externalWorkspaceId: a.externalWorkspaceId || null,
                live: !!a.enabled && !a.deleted,
              }
            : { id: j.accountId, platform: null, credentialsEnc: null, settings: {}, botIds: [], live: false },
          mapping: m
            ? {
                id: m.id,
                externalChannelId: m.externalChannelId,
                externalMeta: m.externalMeta || {},
                conversationId: m.conversationId,
                ownerId: m.ownerId,
                direction: m.direction || "both",
                live: !!m.enabled && !m.deleted,
              }
            : null,
        };
      });
    },
    async markJobDone(id: string, result: any) {
      const j = tbl(T_JOB).find((x) => x.id === id);
      if (j) {
        j.status = "done";
        j.attempts = Number(j.attempts || 0) + 1;
        j.error = null;
        j.claimToken = null;
        j.result = result ?? null;
        j.doneAt = now();
        save(T_JOB);
      }
    },
    async markJobFailed(id: string, error: string, retryInSec: number | null) {
      const j = tbl(T_JOB).find((x) => x.id === id);
      if (!j) return;
      j.attempts = Number(j.attempts || 0) + 1;
      j.error = String(error || "").slice(0, 512);
      j.claimToken = null;
      if (retryInSec == null) {
        j.status = "failed";
        j.doneAt = now();
      } else {
        j.status = "pending";
        j.nextAttemptAt = new Date(Date.now() + Math.max(1, Math.round(retryInSec)) * 1000).toISOString();
      }
      save(T_JOB);
    },
    async getJob(id: string) {
      return pub(tbl(T_JOB).find((x) => x.id === id));
    },
    async listJobs(opts: any = {}) {
      return tbl(T_JOB)
        .filter((j) => (opts.accountId ? j.accountId === opts.accountId : true))
        .filter((j) => (opts.mappingId ? j.mappingId === opts.mappingId : true))
        .filter((j) => (opts.status ? j.status === opts.status : true))
        .sort(byCreatedDesc)
        .slice(0, clampLimit(opts.limit, 50, 200))
        .map(pub);
    },
    async retryJob(id: string) {
      const j = tbl(T_JOB).find((x) => x.id === id && x.status === "failed");
      if (!j) return false;
      j.status = "pending";
      j.attempts = 0;
      j.error = null;
      j.claimToken = null;
      j.nextAttemptAt = now();
      j.doneAt = null;
      save(T_JOB);
      return true;
    },
    async requeueStaleJobs(olderThanSec = 300) {
      const cutoff = new Date(Date.now() - Math.max(30, olderThanSec) * 1000).toISOString();
      let n = 0;
      for (const j of tbl(T_JOB))
        if (j.status === "running" && String(j.claimedAt || "") < cutoff) {
          j.status = "pending";
          j.claimToken = null;
          j.nextAttemptAt = now();
          n++;
        }
      if (n) save(T_JOB);
      return n;
    },
    async pruneJobs(retentionDays = 14) {
      const cutoff = new Date(Date.now() - Math.max(1, retentionDays) * 86400000).toISOString();
      const arr = tbl(T_JOB);
      const before = arr.length;
      const keep = arr.filter((j) => !(["done", "failed"].includes(j.status) && String(j.createdAt) < cutoff));
      arr.length = 0;
      arr.push(...keep);
      save(T_JOB);
      return before - keep.length;
    },
    async countJobs(accountId: string) {
      const out: Record<string, number> = { pending: 0, running: 0, done: 0, failed: 0 };
      for (const j of tbl(T_JOB)) if (j.accountId === accountId) out[j.status] = (out[j.status] || 0) + 1;
      return out;
    },
  };
  return connectors;
}
