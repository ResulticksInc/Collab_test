// Unified Connector Engine — shared contracts.
//
// Every platform adapter speaks this ONE vocabulary. The engine
// (connectorService / connectorIngestService) never knows a Slack `ts` from a
// Teams `replyToId`: it sees InboundEvent / NormalizedMessage / SendResult and
// the adapter does the translation at the edge. See docs/CONNECTOR_ENGINE.md.

export type Platform =
  | "slack"
  | "teams"
  | "google_chat"
  | "whatsapp"
  | "google_calendar"
  | "outlook_calendar";

const CHAT_PLATFORMS: readonly Platform[] = ["slack", "teams", "google_chat", "whatsapp"] as const;
const CALENDAR_PLATFORMS: readonly Platform[] = ["google_calendar", "outlook_calendar"] as const;
export const ALL_PLATFORMS: readonly Platform[] = [...CHAT_PLATFORMS, ...CALENDAR_PLATFORMS];

export function isPlatform(p: any): p is Platform {
  return (ALL_PLATFORMS as readonly string[]).includes(String(p));
}
export function isChatPlatform(p: any): boolean {
  return (CHAT_PLATFORMS as readonly string[]).includes(String(p));
}
export function isCalendarPlatform(p: any): boolean {
  return (CALENDAR_PLATFORMS as readonly string[]).includes(String(p));
}

// Human-readable labels + which credential fields each platform needs. The
// management API serves this so a client can render the setup form without
// hard-coding a list that drifts from the server's. `secret: true` fields are
// write-only (sealed at rest, never echoed back).
export const PLATFORM_CATALOG: Record<
  Platform,
  {
    label: string;
    kind: "chat" | "calendar";
    fields: { key: string; label: string; secret?: boolean; required?: boolean; hint?: string }[];
    inbound: string; // what the platform must be pointed at
  }
> = {
  slack: {
    label: "Slack",
    kind: "chat",
    inbound: "Events API request URL → POST /api/connectors/in/slack/<accountId>",
    fields: [
      { key: "botToken", label: "Bot User OAuth token (xoxb-…)", secret: true, required: true },
      { key: "signingSecret", label: "Signing secret", secret: true, required: true },
    ],
  },
  teams: {
    label: "Microsoft Teams",
    kind: "chat",
    inbound:
      "Graph change-notification URL or Bot messaging endpoint → POST /api/connectors/in/teams/<accountId>",
    fields: [
      { key: "tenantId", label: "Entra tenant id", required: true },
      { key: "clientId", label: "App (client) id", required: true },
      { key: "clientSecret", label: "Client secret", secret: true, required: true },
      {
        key: "clientState",
        label: "Change-notification clientState",
        secret: true,
        hint: "Any random string; it is echoed by Graph on every notification and verified here.",
      },
    ],
  },
  google_chat: {
    label: "Google Chat",
    kind: "chat",
    inbound: "Chat app HTTP endpoint → POST /api/connectors/in/google_chat/<accountId>",
    fields: [
      { key: "serviceAccountJson", label: "Service account JSON", secret: true, required: true },
      {
        key: "projectNumber",
        label: "Google Cloud project number",
        required: true,
        hint: "The audience of the bearer token Google Chat sends.",
      },
    ],
  },
  whatsapp: {
    label: "WhatsApp Cloud API",
    kind: "chat",
    inbound: "Webhook callback URL → /api/connectors/in/whatsapp/<accountId> (GET verify + POST)",
    fields: [
      { key: "accessToken", label: "System-user access token", secret: true, required: true },
      { key: "phoneNumberId", label: "Phone number id", required: true },
      { key: "appSecret", label: "Meta app secret", secret: true, required: true },
      { key: "verifyToken", label: "Webhook verify token", secret: true, required: true },
    ],
  },
  google_calendar: {
    label: "Google Calendar",
    kind: "calendar",
    inbound: "n/a — CoLab pulls changes with a sync token (CONNECTORS_CALENDAR_PULL_MINUTES)",
    fields: [
      {
        key: "serviceAccountJson",
        label: "Service account JSON (domain-wide delegation)",
        secret: true,
        hint: "Either this, or a refresh token below.",
      },
      { key: "clientId", label: "OAuth client id" },
      { key: "clientSecret", label: "OAuth client secret", secret: true },
      { key: "refreshToken", label: "OAuth refresh token", secret: true },
      { key: "calendarId", label: "Calendar id", hint: "Defaults to 'primary'." },
      {
        key: "impersonate",
        label: "Organizer email to act as",
        hint: "With domain-wide delegation, the calendar events are created on this user's calendar.",
      },
    ],
  },
  outlook_calendar: {
    label: "Outlook Calendar (Microsoft 365)",
    kind: "calendar",
    inbound: "n/a — CoLab pulls changes with a delta link (CONNECTORS_CALENDAR_PULL_MINUTES)",
    fields: [
      { key: "tenantId", label: "Entra tenant id", required: true },
      { key: "clientId", label: "App (client) id", required: true },
      { key: "clientSecret", label: "Client secret", secret: true, required: true },
      {
        key: "organizerEmail",
        label: "Organizer mailbox",
        hint: "Events are created on this mailbox (Calendars.ReadWrite application permission).",
      },
    ],
  },
};

// ── Normalized shapes ───────────────────────────────────────────────────────

// The engine's canonical text format is CoLab's own markdown subset:
//   **bold**  _italic_  ~~strike~~  `code`  ```fence```  [text](url)  > quote
// Adapters convert to/from this at the edge (transformer.ts).
export interface NormalizedMessage {
  text: string;
  // Where it originally came from and who wrote it there — carried across a
  // multi-hop bridge (Slack → CoLab → Teams) so the far side can attribute it.
  authorName?: string | null;
  authorId?: string | null;
  sourcePlatform?: Platform | "colab" | null;
  attachments?: NormalizedAttachment[];
  // Thread reference ON THE TARGET platform (set by the engine from the
  // message mappings before calling sendMessage).
  threadRef?: string | null;
}

export interface NormalizedAttachment {
  name: string;
  url?: string | null;
  mime?: string | null;
  size?: number | null;
}

export type InboundKind = "message.created" | "message.updated" | "message.deleted" | "ignored";

export interface InboundEvent {
  kind: InboundKind;
  // Stable per-platform id of the EVENT (not the message), for idempotency.
  externalEventId: string;
  externalChannelId: string;
  externalMessageId: string;
  // Root the message belongs to (null = it is a root itself).
  externalThreadId?: string | null;
  senderId?: string | null;
  senderName?: string | null;
  // Set when the platform marks the author as an app/bot.
  botId?: string | null;
  isBot?: boolean;
  text: string; // raw platform text — the engine converts it
  attachments?: NormalizedAttachment[];
  timestamp?: string | null;
  // Routing the platform needs to post BACK (Teams serviceUrl + conversation
  // id, Google Chat space type…). Persisted onto the mapping on first sight.
  channelMeta?: Record<string, any> | null;
  // Why an event was ignored (for the operator log).
  ignoreReason?: string | null;
}

export interface SendResult {
  externalMessageId: string;
  externalThreadId?: string | null;
  raw?: any;
}

export interface TestResult {
  ok: boolean;
  detail?: string;
  botIds?: string[];
  workspaceId?: string | null;
}

// What every adapter call receives: the account row (minus the sealed blob)
// and the UNSEALED credentials. Credentials never leave the worker process.
export interface AdapterCtx {
  account: {
    id: string;
    platform: Platform;
    settings: Record<string, any>;
    botIds: string[];
    externalWorkspaceId?: string | null;
  };
  credentials: Record<string, any>;
  timeoutMs: number;
}

export interface InboundRequest {
  headers: Record<string, any>;
  query: Record<string, any>;
  rawBody: Buffer;
  body: any; // parsed JSON (or {} when the body is not JSON)
  method: string;
}

export interface MappingRef {
  id: string;
  externalChannelId: string;
  externalMeta: Record<string, any>;
  conversationId: string;
}

export interface ChatAdapter {
  platform: Platform;
  // A platform's one-off endpoint handshake (Slack url_verification, Graph
  // validationToken, WhatsApp hub.challenge). Returning a response short-circuits
  // the ingest. Called BEFORE verifyInbound — adapters that need the signature
  // on the handshake too (Slack) verify inside.
  handshake?(req: InboundRequest, ctx: AdapterCtx): { status: number; body: any; contentType?: string } | null;
  verifyInbound(req: InboundRequest, ctx: AdapterCtx): Promise<boolean>;
  parseInbound(req: InboundRequest, ctx: AdapterCtx): Promise<InboundEvent[]>;
  sendMessage(ctx: AdapterCtx, mapping: MappingRef, msg: NormalizedMessage): Promise<SendResult>;
  // Optional: platforms without edit/delete (WhatsApp) leave these undefined and
  // the engine records "unsupported" instead of failing the job.
  updateMessage?(ctx: AdapterCtx, mapping: MappingRef, externalMessageId: string, msg: NormalizedMessage): Promise<void>;
  deleteMessage?(ctx: AdapterCtx, mapping: MappingRef, externalMessageId: string): Promise<void>;
  testConnection(ctx: AdapterCtx): Promise<TestResult>;
}

export interface CalendarEventInput {
  meetingId: string;
  title: string;
  description?: string | null;
  location?: string | null;
  startUtc: string; // ISO
  endUtc: string; // ISO
  timezone?: string | null;
  organizerEmail?: string | null;
  attendeeEmails: string[];
  // CoLab's own join link, so the external event points back at the meeting.
  joinUrl?: string | null;
  cancelled?: boolean;
}

export interface CalendarUpsertResult {
  externalEventId: string;
  externalCalendarId: string;
  joinUrl?: string | null;
  updatedAt?: string | null;
}

export interface CalendarChange {
  externalEventId: string;
  removed: boolean;
  startUtc?: string | null;
  endUtc?: string | null;
  title?: string | null;
  updatedAt?: string | null;
}

export interface CalendarAdapter {
  platform: Platform;
  upsertEvent(ctx: AdapterCtx, input: CalendarEventInput, existingExternalId: string | null): Promise<CalendarUpsertResult>;
  deleteEvent(ctx: AdapterCtx, externalCalendarId: string, externalEventId: string): Promise<void>;
  // Delta pull. `cursor` is the platform's opaque token from the previous pull
  // (null = full initial read, bounded to a window the adapter chooses).
  pullChanges(ctx: AdapterCtx, cursor: string | null): Promise<{ changes: CalendarChange[]; nextCursor: string | null }>;
  testConnection(ctx: AdapterCtx): Promise<TestResult>;
}

// A platform call that failed. `retryable` drives the job queue: a 5xx /
// timeout / 429 is retried with backoff, a 4xx is a permanent failure that
// retrying an unchanged request can never fix.
export class PlatformError extends Error {
  status: number | null;
  retryable: boolean;
  platform: string;
  body?: any;
  constructor(platform: string, message: string, opts: { status?: number | null; retryable?: boolean; body?: any } = {}) {
    super(message);
    this.name = "PlatformError";
    this.platform = platform;
    this.status = opts.status ?? null;
    this.body = opts.body;
    this.retryable =
      opts.retryable !== undefined
        ? opts.retryable
        : this.status == null || this.status >= 500 || this.status === 408 || this.status === 429;
  }
}
