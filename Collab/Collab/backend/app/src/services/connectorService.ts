// UNIFIED CONNECTOR ENGINE — management, outbound dispatch, job worker,
// calendar sync. Bridges CoLab conversations/meetings with Microsoft Teams,
// Slack, Google Workspace (Chat + Calendar), Outlook Calendar and the WhatsApp
// Cloud API. See docs/CONNECTOR_ENGINE.md.
//
//   ACCOUNTS   One per platform credential an organization registers. Managed
//              by org admins (routes gate on org:manage). Credentials are sealed
//              at rest and never returned.
//   MAPPINGS   platform channel ↔ CoLab conversation. Scoped exactly like chat
//              webhooks: the mapping is only ever as privileged as the member
//              who created it (owner), whose live membership is re-checked on
//              every bridged message.
//   OUTBOUND   messageService / meetingService call dispatch*(): the send path
//              only INSERTs a job (never blocks on a platform), and the
//              leader-elected drain() worker executes it with an atomic claim
//              + exponential backoff.
//   INBOUND    lives in connectorIngestService (it needs messageService, which
//              imports THIS module for dispatch — keeping them apart avoids the
//              cycle).
import crypto from "crypto";
import { db, config } from "../platform";
import { resolveScope } from "./webhookService";
import { credentialHint, mergeCredentials, openCredentials, sealCredentials } from "./connectors/credentials";
import { getCalendarAdapter, getChatAdapter } from "./connectors/registry";
import { attribute, PLATFORM_LABEL } from "./connectors/transformer";
import {
  type AdapterCtx,
  type CalendarEventInput,
  type NormalizedMessage,
  PLATFORM_CATALOG,
  type Platform,
  PlatformError,
  isCalendarPlatform,
  isChatPlatform,
  isPlatform,
} from "./connectors/types";

const CN = config.connectors;

export const EVENTS_SUPPORTED = ["message.created", "message.updated", "message.deleted"] as const;
type SupportedEvent = (typeof EVENTS_SUPPORTED)[number];

function disabled(): never {
  const e: any = new Error("Connectors are disabled on this deployment.");
  e.status = 503;
  e.code = "CONNECTORS_DISABLED";
  throw e;
}
function bad(message: string, status = 400, code = "BAD_REQUEST"): never {
  const e: any = new Error(message);
  e.status = status;
  e.code = code;
  throw e;
}
const sha = (s: string) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

// ── Adapter context ─────────────────────────────────────────────────────────
// Unseal the credential and merge deployment-wide API versions under the
// account's own settings. Only the worker / test paths ever call this.
export function buildCtx(account: {
  id: string;
  platform: string;
  settings?: Record<string, any>;
  botIds?: string[];
  externalWorkspaceId?: string | null;
  credentialsEnc?: string | null;
}): AdapterCtx {
  return {
    account: {
      id: account.id,
      platform: account.platform as Platform,
      settings: { graphApiVersion: CN.graphApiVersion, whatsappApiVersion: CN.whatsappApiVersion, ...(account.settings || {}) },
      botIds: account.botIds || [],
      externalWorkspaceId: account.externalWorkspaceId || null,
    },
    credentials: openCredentials(account.credentialsEnc, CN.secret),
    timeoutMs: CN.timeoutMs,
  };
}

// ── Public shapes ───────────────────────────────────────────────────────────
function publicAccount(a: any) {
  if (!a) return null;
  const cat = PLATFORM_CATALOG[a.platform as Platform];
  return {
    id: a.id,
    organizationId: a.organizationId || null,
    platform: a.platform,
    platformLabel: cat?.label || a.platform,
    kind: cat?.kind || (isCalendarPlatform(a.platform) ? "calendar" : "chat"),
    name: a.name,
    externalWorkspaceId: a.externalWorkspaceId || null,
    botIds: a.botIds || [],
    hasCredentials: !!a.credentialsEnc,
    credentialHint: a.credentialHint || null,
    settings: a.settings || {},
    enabled: !!a.enabled,
    lastStatus: a.lastStatus || null,
    lastActivityAt: a.lastActivityAt || null,
    failureCount: Number(a.failureCount || 0),
    createdBy: a.createdBy,
    createdAt: a.createdAt,
    inboundUrl: inboundUrl(a.platform, a.id),
  };
}

function publicMapping(m: any, conv?: any, account?: any) {
  if (!m) return null;
  return {
    id: m.id,
    accountId: m.accountId,
    platform: account ? account.platform : m.platform || undefined,
    accountName: account ? account.name : undefined,
    conversationId: m.conversationId,
    scope: conv ? (conv.kind === "dm" ? "user" : "group") : undefined,
    conversationTitle: conv ? conv.title || null : undefined,
    externalChannelId: m.externalChannelId,
    externalChannelName: m.externalChannelName || null,
    externalMeta: m.externalMeta || {},
    direction: m.direction || "both",
    ownerId: m.ownerId,
    enabled: !!m.enabled,
    lastStatus: m.lastStatus || null,
    lastActivityAt: m.lastActivityAt || null,
    failureCount: Number(m.failureCount || 0),
    createdAt: m.createdAt,
  };
}

function inboundUrl(platform: string, accountId: string) {
  const base = config.backend.publicUrl || "";
  const path = `${config.constants.api.prefix}/connectors/in/${platform}/${accountId}`;
  return base ? `${String(base).replace(/\/$/, "")}${path}` : path;
}

// The organization an account belongs to must be the caller's active org
// (null-tolerant for single-tenant deployments that never created an org).
function sameOrg(a: string | null | undefined, b: string | null | undefined) {
  return (a || null) === (b || null);
}

// ── Accounts ────────────────────────────────────────────────────────────────
function validateCredentials(platform: Platform, creds: Record<string, any>, requireAll: boolean) {
  const cat = PLATFORM_CATALOG[platform];
  const missing = cat.fields
    .filter((f) => f.required && (creds[f.key] === undefined || creds[f.key] === null || creds[f.key] === ""))
    .map((f) => f.key);
  if (requireAll && missing.length) bad(`Missing ${cat.label} credential field(s): ${missing.join(", ")}`);
  // Google: service account OR refresh-token trio.
  if ((platform === "google_calendar" || platform === "google_chat") && requireAll) {
    const hasSa = !!creds.serviceAccountJson;
    const hasRt = !!(creds.clientId && creds.clientSecret && creds.refreshToken);
    if (!hasSa && !hasRt) bad("Provide a Google service account JSON, or an OAuth clientId + clientSecret + refreshToken.");
  }
  const unknown = Object.keys(creds).filter((k) => !cat.fields.some((f) => f.key === k));
  if (unknown.length) bad(`Unknown credential field(s) for ${cat.label}: ${unknown.join(", ")}`);
}

export async function createAccount(opts: {
  platform: string;
  name?: string;
  credentials?: Record<string, any>;
  settings?: Record<string, any>;
  externalWorkspaceId?: string | null;
  botIds?: string[] | string;
  createdBy: string;
  organizationId: string | null;
}) {
  if (!CN.enabled) disabled();
  if (!isPlatform(opts.platform)) bad(`Unknown platform. One of: ${Object.keys(PLATFORM_CATALOG).join(", ")}`);
  const platform = opts.platform as Platform;
  const creds = opts.credentials && typeof opts.credentials === "object" ? opts.credentials : {};
  validateCredentials(platform, creds, true);
  const name = String(opts.name || "").trim().slice(0, 120) || `${PLATFORM_CATALOG[platform].label} connector`;
  const row = await db.connectors.createAccount({
    platform,
    name,
    externalWorkspaceId: opts.externalWorkspaceId ? String(opts.externalWorkspaceId).slice(0, 191) : null,
    botIds: normalizeIds(opts.botIds),
    credentialsEnc: sealCredentials(creds, CN.secret),
    credentialHint: credentialHint(platform, creds),
    settings: sanitizeSettings(opts.settings),
    createdBy: opts.createdBy,
    organizationId: opts.organizationId,
  });
  return publicAccount(row);
}

function normalizeIds(v: any): string[] {
  const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [];
  return Array.from(new Set(list.map((s: any) => String(s || "").trim()).filter(Boolean))).slice(0, 20);
}

// Settings are free-form per platform but bounded: plain JSON, small.
function sanitizeSettings(s: any): Record<string, any> {
  if (!s || typeof s !== "object" || Array.isArray(s)) return {};
  const json = JSON.stringify(s);
  if (json.length > 8000) bad("Settings are too large.");
  return JSON.parse(json);
}

export async function listAccounts(organizationId: string | null) {
  if (!CN.enabled) return [];
  const rows = await db.connectors.listAccounts({ organizationId });
  return rows.map(publicAccount);
}

async function loadAccount(id: string, organizationId: string | null) {
  const a = await db.connectors.getAccount(id);
  if (!a || !sameOrg(a.organizationId, organizationId)) bad("Connector account not found.", 404, "NOT_FOUND");
  return a;
}

export async function getAccount(id: string, organizationId: string | null) {
  if (!CN.enabled) disabled();
  const a = await loadAccount(id, organizationId);
  const jobs = await db.connectors.countJobs(id).catch(() => null);
  return { ...publicAccount(a), jobs };
}

export async function updateAccount(
  id: string,
  organizationId: string | null,
  patch: {
    name?: string;
    enabled?: boolean;
    settings?: Record<string, any>;
    externalWorkspaceId?: string | null;
    botIds?: string[] | string;
    credentials?: Record<string, any>;
  },
) {
  if (!CN.enabled) disabled();
  const a = await loadAccount(id, organizationId);
  const next: any = {};
  if (patch.name !== undefined) next.name = String(patch.name).trim().slice(0, 120) || a.name;
  if (patch.enabled !== undefined) next.enabled = !!patch.enabled;
  if (patch.settings !== undefined) next.settings = { ...(a.settings || {}), ...sanitizeSettings(patch.settings) };
  if (patch.externalWorkspaceId !== undefined)
    next.externalWorkspaceId = patch.externalWorkspaceId ? String(patch.externalWorkspaceId).slice(0, 191) : null;
  if (patch.botIds !== undefined) next.botIds = normalizeIds(patch.botIds);
  if (patch.credentials !== undefined) {
    // Rotate in place: blank fields keep their stored value, so an admin can
    // change ONE secret without re-entering every other one.
    const current = openCredentials(a.credentialsEnc, CN.secret);
    const merged = mergeCredentials(current, patch.credentials || {});
    validateCredentials(a.platform, merged, true);
    next.credentialsEnc = sealCredentials(merged, CN.secret);
    next.credentialHint = credentialHint(a.platform, merged);
  }
  const row = await db.connectors.updateAccount(id, next);
  return publicAccount(row);
}

export async function removeAccount(id: string, organizationId: string | null) {
  if (!CN.enabled) disabled();
  await loadAccount(id, organizationId);
  return db.connectors.removeAccount(id);
}

// Live round-trip to the platform with the stored credential. On success the
// platform-reported bot identities / workspace id are recorded on the account
// when the admin left them blank — they are what the loop guard keys on.
export async function testAccount(id: string, organizationId: string | null) {
  if (!CN.enabled) disabled();
  const a = await loadAccount(id, organizationId);
  const ctx = buildCtx(a);
  const adapter: any = getChatAdapter(a.platform) || getCalendarAdapter(a.platform);
  if (!adapter) bad("No adapter for that platform.", 500, "INTERNAL");
  try {
    const r = await adapter.testConnection(ctx);
    const patch: any = {};
    if (r.botIds?.length) patch.botIds = Array.from(new Set([...(a.botIds || []), ...r.botIds]));
    if (r.workspaceId && !a.externalWorkspaceId) patch.externalWorkspaceId = String(r.workspaceId).slice(0, 191);
    if (Object.keys(patch).length) await db.connectors.updateAccount(id, patch);
    await db.connectors.markAccountHealth(id, "ok", false);
    return { ok: true, detail: r.detail || null, botIds: patch.botIds || a.botIds, workspaceId: patch.externalWorkspaceId || a.externalWorkspaceId };
  } catch (e: any) {
    await db.connectors.markAccountHealth(id, e?.status ? `HTTP ${e.status}` : "error", true).catch(() => {});
    return { ok: false, detail: e?.message || String(e), status: e?.status ?? null };
  }
}

// ── Mappings ────────────────────────────────────────────────────────────────
const DIRECTIONS = new Set(["both", "inbound", "outbound"]);

export async function createMapping(opts: {
  ownerId: string;
  organizationId: string | null;
  accountId: string;
  conversationId?: string;
  userId?: string;
  externalChannelId: string;
  externalChannelName?: string | null;
  externalMeta?: Record<string, any>;
  direction?: string;
}) {
  if (!CN.enabled) disabled();
  const account = await loadAccount(opts.accountId, opts.organizationId);
  if (!isChatPlatform(account.platform)) bad("Channel mappings apply to chat platforms; calendar accounts sync meetings automatically.");
  const conv = await resolveScope(opts.ownerId, { conversationId: opts.conversationId, userId: opts.userId });
  const channel = String(opts.externalChannelId || "").trim().slice(0, 191);
  if (!channel) bad("externalChannelId is required (the Slack channel id, Teams channel id, Google Chat space name or WhatsApp number).");
  const existing = await db.connectors.listMappingsForConversation(conv.id);
  if (existing.length >= CN.maxMappingsPerConversation)
    bad(`This conversation already has the maximum of ${CN.maxMappingsPerConversation} connector mappings.`, 409, "LIMIT_REACHED");
  if (existing.some((m: any) => m.accountId === account.id && m.externalChannelId === channel))
    bad("That channel is already mapped to this conversation.", 409, "ALREADY_EXISTS");
  const direction = DIRECTIONS.has(String(opts.direction)) ? String(opts.direction) : "both";
  const row = await db.connectors.createMapping({
    accountId: account.id,
    conversationId: conv.id,
    externalChannelId: channel,
    externalChannelName: opts.externalChannelName ? String(opts.externalChannelName).slice(0, 191) : null,
    externalMeta: sanitizeSettings(opts.externalMeta),
    direction,
    ownerId: opts.ownerId,
    organizationId: opts.organizationId,
  });
  return publicMapping(row, conv, account);
}

async function loadManageableMapping(id: string, userId: string) {
  const m = await db.connectors.getMapping(id);
  if (!m) bad("Mapping not found.", 404, "NOT_FOUND");
  if (m.ownerId !== userId) {
    const members = await db.conversations.members(m.conversationId);
    const me = (members || []).find((x: any) => (x.userId || x.id) === userId);
    if (!me || !["owner", "admin"].includes(String(me.role || "member")))
      bad("Only the mapping's creator or a conversation admin can manage it.", 403, "FORBIDDEN");
  }
  return m;
}

export async function listMappingsForConversation(conversationId: string, viewerId: string) {
  if (!CN.enabled) return [];
  const conv = await resolveScope(viewerId, { conversationId });
  const rows = await db.connectors.listMappingsForConversation(conv.id);
  const out: any[] = [];
  for (const m of rows) out.push(publicMapping(m, conv, await db.connectors.getAccount(m.accountId)));
  return out;
}

export async function listMappingsMine(userId: string) {
  if (!CN.enabled) return [];
  const rows = await db.connectors.listMappingsForOwner(userId);
  const out: any[] = [];
  for (const m of rows) {
    if (!(await db.conversations.isMember(m.conversationId, userId))) continue;
    out.push(publicMapping(m, await db.conversations.getById(m.conversationId), await db.connectors.getAccount(m.accountId)));
  }
  return out;
}

export async function listMappingsForAccount(accountId: string, organizationId: string | null) {
  if (!CN.enabled) return [];
  const account = await loadAccount(accountId, organizationId);
  const rows = await db.connectors.listMappingsForAccount(accountId);
  const out: any[] = [];
  for (const m of rows) out.push(publicMapping(m, await db.conversations.getById(m.conversationId).catch(() => null), account));
  return out;
}

export async function updateMapping(
  id: string,
  userId: string,
  patch: { externalChannelName?: string | null; externalMeta?: Record<string, any>; direction?: string; enabled?: boolean },
) {
  if (!CN.enabled) disabled();
  const m = await loadManageableMapping(id, userId);
  const next: any = {};
  if (patch.externalChannelName !== undefined) next.externalChannelName = patch.externalChannelName ? String(patch.externalChannelName).slice(0, 191) : null;
  if (patch.externalMeta !== undefined) next.externalMeta = { ...(m.externalMeta || {}), ...sanitizeSettings(patch.externalMeta) };
  if (patch.direction !== undefined) next.direction = DIRECTIONS.has(String(patch.direction)) ? String(patch.direction) : m.direction;
  if (patch.enabled !== undefined) next.enabled = !!patch.enabled;
  const row = await db.connectors.updateMapping(id, next);
  return publicMapping(row);
}

export async function removeMapping(id: string, userId: string) {
  if (!CN.enabled) disabled();
  await loadManageableMapping(id, userId);
  return db.connectors.removeMapping(id);
}

// Queue a synthetic outbound post so someone can verify the mapping end-to-end
// without waiting for real chat traffic.
export async function testMapping(id: string, userId: string) {
  if (!CN.enabled) disabled();
  const m = await loadManageableMapping(id, userId);
  const account = await db.connectors.getAccount(m.accountId);
  if (!account || !account.enabled) bad("The connector account is disabled.", 409, "ACCOUNT_DISABLED");
  const user = await db.users.getById(userId).catch(() => null);
  const jobId = await db.connectors.enqueueJob({
    accountId: m.accountId,
    mappingId: m.id,
    kind: "outbound.message.created",
    dedupeKey: `test:${m.id}:${Date.now()}`,
    payload: {
      event: "message.created",
      test: true,
      message: {
        id: `test-${crypto.randomUUID()}`,
        text: "This is a test post from CoLab's connector engine.",
        type: "text",
        parentMessageId: null,
        sender: { id: userId, name: (user && user.name) || "CoLab" },
        createdAt: new Date().toISOString(),
      },
    },
    organizationId: m.organizationId || null,
  });
  kick();
  return { jobId, queued: !!jobId };
}

// ── Outbound dispatch (message send/edit/delete path) ───────────────────────
// FIRE-AND-FORGET and defensive: a connector problem must never fail, slow or
// roll back a chat message. Synchronously this is one SELECT + N cheap INSERTs.
export function dispatch(
  event: SupportedEvent,
  ctx: {
    conversationId: string;
    message: any;
    // The mapping the message ARRIVED through (loop guard: never echo it back
    // out the same mapping; every OTHER mapping on the conversation still gets
    // it — that is the multi-platform bridge).
    viaConnectorMappingId?: string | null;
    // Original author/platform when the message came in through a connector.
    bridge?: { sourcePlatform: string; authorName?: string | null } | null;
  },
) {
  if (!CN.enabled) return;
  void (async () => {
    try {
      const m = ctx.message;
      if (!m || !m.id) return;
      // No plaintext to bridge: E2EE conversations never cross a connector.
      if (m.encrypted || Number(m.encryptionVersion || 0) > 0) return;
      const mappings = await db.connectors.listOutboundFor(ctx.conversationId);
      if (!mappings.length) return;
      let queued = 0;
      for (const mp of mappings) {
        if (ctx.viaConnectorMappingId && mp.id === ctx.viaConnectorMappingId) continue;
        // Deliver only what the owner may see — the payload carries message
        // text, so a mapping whose owner has left the conversation must stop.
        if (!(await db.conversations.isMember(ctx.conversationId, mp.ownerId))) {
          await db.connectors.markMappingHealth(mp.id, "owner_not_member", true).catch(() => {});
          continue;
        }
        const text = String(m.text ?? m.body ?? "");
        const payload = {
          event,
          message: {
            id: m.id,
            text,
            type: m.type || "text",
            parentMessageId: m.parentMessageId || null,
            sender: m.sender ? { id: m.sender.id || null, name: m.sender.name || null } : null,
            file: m.file ? { name: m.file.name || null, mime: m.file.mime || null, size: m.file.size || null } : null,
            createdAt: m.createdAt || m.time || null,
            deleted: !!m.deleted,
          },
          bridge: ctx.bridge || null,
        };
        // Same message + mapping + event enqueues once; an EDIT re-enqueues only
        // when the text actually changed.
        const dedupeKey =
          event === "message.updated"
            ? `${event}:${m.id}:${mp.id}:${sha(text).slice(0, 12)}`
            : `${event}:${m.id}:${mp.id}`;
        const id = await db.connectors.enqueueJob({
          accountId: mp.accountId,
          mappingId: mp.id,
          kind: `outbound.${event}`,
          dedupeKey,
          payload,
          organizationId: mp.organizationId || null,
        });
        if (id) queued++;
      }
      if (queued) kick();
    } catch (e) {
      console.error("[connectors] dispatch failed (message send unaffected):", (e as any)?.message || e);
    }
  })();
}

// ── Meeting → calendar sync (meeting create/update/cancel/delete path) ──────
export function dispatchMeeting(event: "meeting.upserted" | "meeting.deleted", meeting: any, organizationId?: string | null) {
  if (!CN.enabled) return;
  void (async () => {
    try {
      if (!meeting || !meeting.id) return;
      const orgId = organizationId === undefined ? meeting.organizationId ?? null : organizationId;
      const accounts = (await db.connectors.listAccounts({ organizationId: orgId })).filter(
        (a: any) => a.enabled && isCalendarPlatform(a.platform) && a.settings?.autoSyncMeetings !== false,
      );
      if (!accounts.length) return;
      // Identical meeting state never enqueues twice; every real change does.
      const stateHash = sha(
        JSON.stringify([
          meeting.title,
          meeting.startsAt,
          meeting.durationMin,
          meeting.status,
          meeting.description,
          meeting.location,
          (meeting.attendees || []).map((a: any) => a.userId || a.id).sort(),
        ]),
      ).slice(0, 16);
      let queued = 0;
      for (const a of accounts) {
        const id = await db.connectors.enqueueJob({
          accountId: a.id,
          kind: event === "meeting.deleted" ? "calendar.delete" : "calendar.upsert",
          dedupeKey: event === "meeting.deleted" ? `cal.delete:${meeting.id}:${a.id}` : `cal.upsert:${meeting.id}:${a.id}:${stateHash}`,
          payload: { meetingId: meeting.id },
          organizationId: a.organizationId || null,
        });
        if (id) queued++;
      }
      if (queued) kick();
    } catch (e) {
      console.error("[connectors] meeting dispatch failed (meeting unaffected):", (e as any)?.message || e);
    }
  })();
}

export async function listMeetingMappings(meetingId: string, userId: string) {
  if (!CN.enabled) return [];
  const m = await db.meetings.getById(meetingId);
  if (!m) bad("Meeting not found.", 404, "NOT_FOUND");
  const invited = m.createdBy === userId || (m.attendees || []).some((a: any) => (a.userId || a.id) === userId);
  if (!invited) bad("You're not part of this meeting.", 403, "FORBIDDEN");
  const rows = await db.connectors.listMeetingMappingsForMeeting(meetingId);
  const out: any[] = [];
  for (const r of rows) {
    const acc = await db.connectors.getAccount(r.accountId);
    out.push({ ...r, syncToken: undefined, platform: acc?.platform || null, accountName: acc?.name || null });
  }
  return out;
}

// Enqueue a delta pull for every calendar account that has pulls enabled.
// Called from the boot timer loop (leader-gated) and the manual route.
export async function enqueueCalendarPulls(onlyAccountId?: string, organizationId?: string | null) {
  if (!CN.enabled) return 0;
  const accounts: any[] = onlyAccountId
    ? [await loadAccount(onlyAccountId, organizationId ?? null)]
    : [
        ...(await db.connectors.listEnabledAccountsByPlatform("google_calendar")),
        ...(await db.connectors.listEnabledAccountsByPlatform("outlook_calendar")),
      ];
  let n = 0;
  const bucket = Math.floor(Date.now() / (Math.max(1, CN.calendarPullMinutes) * 60_000));
  for (const a of accounts) {
    if (!a || !a.enabled || !isCalendarPlatform(a.platform)) continue;
    if (!onlyAccountId && a.settings?.pullEnabled === false) continue;
    const id = await db.connectors.enqueueJob({
      accountId: a.id,
      kind: "calendar.pull",
      dedupeKey: onlyAccountId ? `cal.pull:${a.id}:manual:${Date.now()}` : `cal.pull:${a.id}:${bucket}`,
      payload: {},
      organizationId: a.organizationId || null,
    });
    if (id) n++;
  }
  if (n) kick();
  return n;
}

// ── Jobs (operator view) ────────────────────────────────────────────────────
export async function listJobs(accountId: string, organizationId: string | null, opts: { status?: string; limit?: number } = {}) {
  if (!CN.enabled) return [];
  await loadAccount(accountId, organizationId);
  const rows = await db.connectors.listJobs({ accountId, status: opts.status, limit: opts.limit });
  // Payloads embed message text; the operator view shows metadata only.
  return rows.map((j: any) => ({ ...j, payload: undefined, summary: summarizeJob(j) }));
}
function summarizeJob(j: any) {
  const p = j.payload || {};
  if (j.kind.startsWith("outbound.")) return { event: p.event, messageId: p.message?.id || null, test: !!p.test };
  return { meetingId: p.meetingId || null };
}
export async function retryJob(id: string, organizationId: string | null) {
  if (!CN.enabled) disabled();
  const j = await db.connectors.getJob(id);
  if (!j) bad("Job not found.", 404, "NOT_FOUND");
  await loadAccount(j.accountId, organizationId);
  const ok = await db.connectors.retryJob(id);
  if (ok) kick();
  return { id, requeued: ok };
}

// ── Worker ──────────────────────────────────────────────────────────────────
// Exponential backoff with a cap: 20s, 80s, ~5m, ~21m, ~1h, then give up (6
// attempts by default). Jittered so a fleet of jobs against one recovering
// platform does not re-collide on every wave.
function backoffSec(attempt: number): number | null {
  if (attempt >= CN.maxAttempts) return null;
  const base = 20 * Math.pow(4, attempt - 1);
  return Math.min(base, 3600) * (0.85 + Math.random() * 0.3);
}

let draining = false;
let drainAgain = false;

export async function drain(): Promise<number> {
  if (!CN.enabled) return 0;
  if (draining) {
    drainAgain = true;
    return 0;
  }
  draining = true;
  let done = 0;
  try {
    for (let pass = 0; pass < 20; pass++) {
      const batch = await db.connectors.claimJobs(20);
      if (!batch.length) break;
      const results = await Promise.all(batch.map((j: any) => runJob(j)));
      done += results.filter(Boolean).length;
    }
  } catch (e) {
    console.error("[connectors] drain failed:", (e as any)?.message || e);
  } finally {
    draining = false;
  }
  if (drainAgain) {
    drainAgain = false;
    return done + (await drain());
  }
  return done;
}

let kickTimer: any = null;
function kick() {
  if (kickTimer) return;
  kickTimer = setTimeout(() => {
    kickTimer = null;
    void drain();
  }, 500);
  if (typeof kickTimer.unref === "function") kickTimer.unref();
}

async function runJob(job: any): Promise<boolean> {
  if (!job.account?.live) {
    await db.connectors.markJobFailed(job.id, "connector account disabled or removed", null);
    return false;
  }
  let ctx: AdapterCtx;
  try {
    ctx = buildCtx(job.account);
  } catch (e: any) {
    await db.connectors.markJobFailed(job.id, "cannot unseal credentials: " + (e?.message || e), null);
    await db.connectors.markAccountHealth(job.accountId, "bad_credentials", true).catch(() => {});
    return false;
  }
  const attempt = Number(job.attempts || 0) + 1;
  try {
    const result = await executeJob(job, ctx);
    await db.connectors.markJobDone(job.id, result);
    await db.connectors.markAccountHealth(job.accountId, "ok", false).catch(() => {});
    if (job.mappingId) await db.connectors.markMappingHealth(job.mappingId, "ok", false).catch(() => {});
    return true;
  } catch (e: any) {
    const retryable = e instanceof PlatformError ? e.retryable : !(e && e.permanent);
    const retry = retryable ? backoffSec(attempt) : null;
    const msg = e?.message || String(e);
    await db.connectors.markJobFailed(job.id, msg, retry);
    const status = e?.status ? `HTTP ${e.status}` : "error";
    await db.connectors.markAccountHealth(job.accountId, status, true).catch(() => {});
    if (job.mappingId) await db.connectors.markMappingHealth(job.mappingId, status, true).catch(() => {});
    if (!retry) console.warn(`[connectors] job ${job.id} (${job.kind}) failed permanently: ${msg}`);
    return false;
  }
}

const permanent = (message: string) => Object.assign(new Error(message), { permanent: true });

async function executeJob(job: any, ctx: AdapterCtx): Promise<any> {
  switch (job.kind) {
    case "outbound.message.created":
    case "outbound.message.updated":
    case "outbound.message.deleted":
      return runOutbound(job, ctx);
    case "calendar.upsert":
      return runCalendarUpsert(job, ctx);
    case "calendar.delete":
      return runCalendarDelete(job, ctx);
    case "calendar.pull":
      return runCalendarPull(job, ctx);
    default:
      throw permanent(`unknown job kind ${job.kind}`);
  }
}

// Bridged messages are posted by our bot on the far side, so the ORIGINAL
// author rides in the text. A message that itself arrived through a connector
// already carries its "**Name** (via Slack)" header, so it is passed as-is.
function outboundText(payload: any): string {
  const m = payload.message || {};
  const base = String(m.text || "").trim() || (m.file ? `📎 ${m.file.name || "attachment"}` : "");
  if (payload.bridge) return base;
  return attribute(base, m.sender?.name, PLATFORM_LABEL.colab);
}

async function runOutbound(job: any, ctx: AdapterCtx) {
  const adapter = getChatAdapter(job.account.platform);
  if (!adapter) throw permanent(`no chat adapter for ${job.account.platform}`);
  const mp = job.mapping;
  if (!mp || !mp.live) throw permanent("mapping disabled or removed before delivery");
  if (!(await db.conversations.isMember(mp.conversationId, mp.ownerId))) throw permanent("mapping owner is no longer a member");
  const payload = job.payload || {};
  const m = payload.message || {};
  const mappingRef = { id: mp.id, externalChannelId: mp.externalChannelId, externalMeta: mp.externalMeta || {}, conversationId: mp.conversationId };
  const msg: NormalizedMessage = {
    text: outboundText(payload),
    authorName: payload.bridge?.authorName || m.sender?.name || null,
    authorId: m.sender?.id || null,
    sourcePlatform: (payload.bridge?.sourcePlatform as any) || "colab",
    threadRef: null,
  };
  if (job.kind === "outbound.message.created") {
    // A retry after a crash between send and record must not double-post.
    const already = await db.connectors.findByMessage(mp.id, m.id);
    if (already) return { skipped: "already delivered", externalMessageId: already.externalMessageId };
    if (!msg.text.trim()) return { skipped: "empty message" };
    if (m.parentMessageId) {
      const parent = await db.connectors.findByMessage(mp.id, m.parentMessageId);
      if (parent) msg.threadRef = parent.externalThreadId || parent.externalMessageId;
    }
    const r = await adapter.sendMessage(ctx, mappingRef, msg);
    if (!payload.test)
      await db.connectors.recordMessage({
        mappingId: mp.id,
        conversationId: mp.conversationId,
        messageId: m.id,
        externalMessageId: r.externalMessageId,
        externalThreadId: r.externalThreadId || msg.threadRef || null,
        direction: "out",
      });
    return { externalMessageId: r.externalMessageId, externalThreadId: r.externalThreadId || null };
  }
  const counterpart = await db.connectors.findByMessage(mp.id, m.id);
  if (!counterpart) return { skipped: "no counterpart on this platform" };
  msg.threadRef = counterpart.externalThreadId || null;
  if (job.kind === "outbound.message.updated") {
    if (!adapter.updateMessage) return { unsupported: "edit", externalMessageId: counterpart.externalMessageId };
    await adapter.updateMessage(ctx, mappingRef, counterpart.externalMessageId, msg);
    return { updated: counterpart.externalMessageId };
  }
  if (!adapter.deleteMessage) return { unsupported: "delete", externalMessageId: counterpart.externalMessageId };
  await adapter.deleteMessage(ctx, mappingRef, counterpart.externalMessageId);
  return { deleted: counterpart.externalMessageId };
}

// ── Calendar jobs ───────────────────────────────────────────────────────────
function meetingJoinUrl(meetingId: string, settings: Record<string, any>): string | null {
  const tpl = settings?.joinUrlTemplate || (config.backend.publicUrl ? `${String(config.backend.publicUrl).replace(/\/api\/?$/, "").replace(/\/$/, "")}/meetings/{id}` : "");
  return tpl ? String(tpl).replace("{id}", meetingId) : null;
}

async function calendarInput(meeting: any, settings: Record<string, any>): Promise<CalendarEventInput> {
  const start = new Date(meeting.startsAt);
  if (Number.isNaN(start.getTime())) throw permanent("meeting has no valid start time");
  const end = new Date(start.getTime() + Math.max(1, Number(meeting.durationMin) || 30) * 60_000);
  const host = await db.users.getById(meeting.createdBy).catch(() => null);
  const ids = (meeting.attendees || []).map((a: any) => a.userId || a.id).filter(Boolean);
  const users = ids.length ? await db.users.getByIds(ids).catch(() => []) : [];
  const emails = new Set<string>();
  // Public-link guests carry a synthetic @guest.invalid address — never invite it.
  for (const u of users || []) if (u?.email && u.role !== "guest" && u.email !== host?.email) emails.add(String(u.email));
  return {
    meetingId: meeting.id,
    title: meeting.title || "Meeting",
    description: meeting.description || null,
    location: meeting.location || null,
    startUtc: start.toISOString(),
    endUtc: end.toISOString(),
    timezone: meeting.timezone || null,
    organizerEmail: host?.email || null,
    attendeeEmails: Array.from(emails),
    joinUrl: meetingJoinUrl(meeting.id, settings),
    cancelled: meeting.status === "cancelled",
  };
}

async function runCalendarUpsert(job: any, ctx: AdapterCtx) {
  const adapter = getCalendarAdapter(job.account.platform);
  if (!adapter) throw permanent(`no calendar adapter for ${job.account.platform}`);
  const meetingId = job.payload?.meetingId;
  const meeting = meetingId ? await db.meetings.getById(meetingId) : null;
  const existing = meetingId ? await db.connectors.getMeetingMapping(job.accountId, meetingId) : null;
  if (!meeting) {
    // Deleted between enqueue and run: treat as a delete.
    if (existing?.externalEventId) await adapter.deleteEvent(ctx, existing.externalCalendarId, existing.externalEventId).catch(() => {});
    if (existing) await db.connectors.removeMeetingMapping(existing.id);
    return { skipped: "meeting no longer exists" };
  }
  const input = await calendarInput(meeting, ctx.account.settings);
  const r = await adapter.upsertEvent(ctx, input, existing?.externalEventId || null);
  const row = await db.connectors.upsertMeetingMapping({
    accountId: job.accountId,
    meetingId: meeting.id,
    externalCalendarId: r.externalCalendarId,
    externalEventId: r.externalEventId,
    joinUrl: r.joinUrl || null,
    scheduledStartUtc: input.startUtc,
    scheduledEndUtc: input.endUtc,
    externalUpdatedAt: r.updatedAt || null,
    lastStatus: input.cancelled ? "cancelled" : "synced",
    organizationId: job.account.organizationId || null,
  });
  return { externalEventId: r.externalEventId, joinUrl: r.joinUrl || null, mappingId: row.id };
}

async function runCalendarDelete(job: any, ctx: AdapterCtx) {
  const adapter = getCalendarAdapter(job.account.platform);
  if (!adapter) throw permanent(`no calendar adapter for ${job.account.platform}`);
  const meetingId = job.payload?.meetingId;
  const existing = meetingId ? await db.connectors.getMeetingMapping(job.accountId, meetingId) : null;
  if (!existing) return { skipped: "no external event" };
  if (existing.externalEventId) await adapter.deleteEvent(ctx, existing.externalCalendarId, existing.externalEventId);
  await db.connectors.removeMeetingMapping(existing.id);
  return { deleted: existing.externalEventId };
}

// Pull the platform's delta and reconcile against our mappings. The DEFAULT is
// observe-only: external edits are recorded on the mapping (lastStatus
// 'drifted' / 'removed_externally') so an operator sees them, and only an
// account with settings.applyExternalChanges=true writes them back onto the
// CoLab meeting. Compare-before-write uses the mapping's own stored times, as
// the spec's delta strategy prescribes.
async function runCalendarPull(job: any, ctx: AdapterCtx) {
  const adapter = getCalendarAdapter(job.account.platform);
  if (!adapter) throw permanent(`no calendar adapter for ${job.account.platform}`);
  const fresh = await db.connectors.getAccount(job.accountId);
  if (!fresh) throw permanent("account vanished");
  const cursor: string | null = fresh.settings?.syncCursor || null;
  const { changes, nextCursor } = await adapter.pullChanges(ctx, cursor);
  let drifted = 0;
  let applied = 0;
  let removed = 0;
  for (const ch of changes) {
    const mm = await db.connectors.findMeetingMappingByExternal(job.accountId, ch.externalEventId);
    if (!mm) continue;
    if (ch.removed) {
      removed++;
      await db.connectors.upsertMeetingMapping({ accountId: job.accountId, meetingId: mm.meetingId, lastStatus: "removed_externally", externalUpdatedAt: ch.updatedAt || null });
      if (ctx.account.settings?.applyExternalChanges) {
        await db.meetings.setStatus(mm.meetingId, "cancelled").catch(() => {});
        applied++;
      }
      continue;
    }
    const sameStart = mm.scheduledStartUtc && ch.startUtc && Math.abs(new Date(mm.scheduledStartUtc).getTime() - new Date(ch.startUtc).getTime()) < 60_000;
    const sameEnd = mm.scheduledEndUtc && ch.endUtc && Math.abs(new Date(mm.scheduledEndUtc).getTime() - new Date(ch.endUtc).getTime()) < 60_000;
    if (sameStart && sameEnd) continue;
    drifted++;
    if (ctx.account.settings?.applyExternalChanges && ch.startUtc && ch.endUtc) {
      const durationMin = Math.max(1, Math.round((new Date(ch.endUtc).getTime() - new Date(ch.startUtc).getTime()) / 60_000));
      await db.meetings.update(mm.meetingId, { startsAt: new Date(ch.startUtc).toISOString(), durationMin });
      await db.connectors.upsertMeetingMapping({ accountId: job.accountId, meetingId: mm.meetingId, scheduledStartUtc: ch.startUtc, scheduledEndUtc: ch.endUtc, externalUpdatedAt: ch.updatedAt || null, lastStatus: "applied_external" });
      applied++;
    } else {
      await db.connectors.upsertMeetingMapping({ accountId: job.accountId, meetingId: mm.meetingId, externalUpdatedAt: ch.updatedAt || null, lastStatus: "drifted" });
    }
  }
  // Persist the cursor on the LIVE row (not the job's snapshot) so a concurrent
  // settings edit is not clobbered.
  await db.connectors.updateAccount(job.accountId, { settings: { ...(fresh.settings || {}), syncCursor: nextCursor } });
  return { changes: changes.length, drifted, removed, applied, cursor: nextCursor ? "updated" : "reset" };
}

// Housekeeping, run from the backend's timer loop under the leader gate.
export async function sweep() {
  if (!CN.enabled) return { requeued: 0, pruned: 0 };
  const requeued = await db.connectors.requeueStaleJobs(300).catch(() => 0);
  const pruned = await db.connectors.pruneJobs(CN.jobRetentionDays).catch(() => 0);
  return { requeued, pruned };
}

