// Outlook / Microsoft 365 Calendar adapter (Microsoft Graph).
//
// Auth: Entra client credentials with the Calendars.ReadWrite APPLICATION
// permission, acting on the organizer's mailbox (/users/{mailbox}/events). The
// mailbox is credentials.organizerEmail, or — with settings.actAsOrganizer —
// the CoLab meeting host's own email. A Teams meeting link is requested with
// isOnlineMeeting + onlineMeetingProvider (the spec's payload).
// Delta: calendarView/delta with a stored deltaLink (410 → full re-read).
import { callJson, expectOk } from "../http";
import { getMicrosoftToken } from "../oauth";
import { type AdapterCtx, type CalendarAdapter, type CalendarChange, type CalendarEventInput, PlatformError } from "../types";

const SCOPE = "https://graph.microsoft.com/.default";
const base = (ctx: AdapterCtx) => `https://graph.microsoft.com/${ctx.account.settings?.graphApiVersion || "v1.0"}`;

function mailbox(ctx: AdapterCtx, organizerEmail?: string | null): string {
  const mb = (ctx.account.settings?.actAsOrganizer && organizerEmail) || ctx.credentials.organizerEmail || organizerEmail;
  if (!mb) throw new PlatformError("outlook_calendar", "no organizer mailbox configured (credentials.organizerEmail)", { status: 400, retryable: false });
  return String(mb);
}

async function api(ctx: AdapterCtx, method: string, url: string, body?: any, extraHeaders: Record<string, string> = {}) {
  const token = await getMicrosoftToken("outlook_calendar", ctx.credentials, SCOPE, ctx.timeoutMs);
  return callJson("outlook_calendar", url, {
    method,
    headers: { authorization: `Bearer ${token}`, prefer: 'outlook.timezone="UTC"', ...extraHeaders },
    body,
    timeoutMs: ctx.timeoutMs,
  });
}

// Graph wants a naive local time + an explicit zone; we always speak UTC.
const naiveUtc = (iso: string) => new Date(iso).toISOString().replace(/\.\d{3}Z$/, "");

function eventBody(input: CalendarEventInput, create: boolean) {
  const html = [
    input.description ? `<p>${String(input.description).replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p>` : "",
    input.joinUrl ? `<p>Join in CoLab: <a href="${input.joinUrl}">${input.joinUrl}</a></p>` : "",
  ]
    .filter(Boolean)
    .join("");
  const body: any = {
    subject: input.title,
    body: { contentType: "HTML", content: html },
    start: { dateTime: naiveUtc(input.startUtc), timeZone: "UTC" },
    end: { dateTime: naiveUtc(input.endUtc), timeZone: "UTC" },
    attendees: input.attendeeEmails.map((address) => ({ emailAddress: { address }, type: "required" })),
    isOnlineMeeting: true,
    onlineMeetingProvider: "teamsForBusiness",
    isCancelled: !!input.cancelled,
  };
  if (input.location) body.location = { displayName: input.location };
  if (create) body.transactionId = `colab-${input.meetingId}`; // Graph-side idempotency on create
  return body;
}

export const outlookCalendarAdapter: CalendarAdapter = {
  platform: "outlook_calendar",

  async upsertEvent(ctx, input, existingExternalId) {
    const mb = encodeURIComponent(mailbox(ctx, input.organizerEmail));
    if (existingExternalId) {
      const r = await api(ctx, "PATCH", `${base(ctx)}/users/${mb}/events/${encodeURIComponent(existingExternalId)}`, eventBody(input, false));
      if (r.status !== 404) {
        expectOk("outlook_calendar", r, "update event");
        return { externalEventId: String(r.json.id), externalCalendarId: mailbox(ctx, input.organizerEmail), joinUrl: r.json.onlineMeeting?.joinUrl || r.json.webLink || null, updatedAt: r.json.lastModifiedDateTime || null };
      }
    }
    const r = await api(ctx, "POST", `${base(ctx)}/users/${mb}/events`, eventBody(input, true));
    expectOk("outlook_calendar", r, "create event");
    return { externalEventId: String(r.json.id), externalCalendarId: mailbox(ctx, input.organizerEmail), joinUrl: r.json.onlineMeeting?.joinUrl || r.json.webLink || null, updatedAt: r.json.lastModifiedDateTime || null };
  },

  async deleteEvent(ctx, externalCalendarId, externalEventId) {
    const mb = encodeURIComponent(externalCalendarId || mailbox(ctx));
    const r = await api(ctx, "DELETE", `${base(ctx)}/users/${mb}/events/${encodeURIComponent(externalEventId)}`);
    if (r.status === 404) return;
    expectOk("outlook_calendar", r, "delete event");
  },

  async pullChanges(ctx, cursor) {
    const mb = encodeURIComponent(mailbox(ctx));
    const changes: CalendarChange[] = [];
    let url: string | null =
      cursor ||
      `${base(ctx)}/users/${mb}/calendarView/delta?startDateTime=${encodeURIComponent(new Date(Date.now() - 86400_000).toISOString())}&endDateTime=${encodeURIComponent(new Date(Date.now() + 180 * 86400_000).toISOString())}`;
    let nextCursor: string | null = null;
    for (let page = 0; page < 20 && url; page++) {
      const r = await api(ctx, "GET", url);
      if (r.status === 410) return { changes: [], nextCursor: null };
      expectOk("outlook_calendar", r, "calendar delta");
      for (const ev of r.json?.value || []) {
        const removed = !!ev["@removed"];
        changes.push({
          externalEventId: String(ev.id),
          removed: removed || !!ev.isCancelled,
          startUtc: ev.start?.dateTime ? new Date(ev.start.dateTime + (ev.start.timeZone === "UTC" ? "Z" : "")).toISOString() : null,
          endUtc: ev.end?.dateTime ? new Date(ev.end.dateTime + (ev.end.timeZone === "UTC" ? "Z" : "")).toISOString() : null,
          title: ev.subject || null,
          updatedAt: ev.lastModifiedDateTime || null,
        });
      }
      if (r.json?.["@odata.nextLink"]) url = r.json["@odata.nextLink"];
      else {
        nextCursor = r.json?.["@odata.deltaLink"] || null;
        url = null;
      }
    }
    return { changes, nextCursor };
  },

  async testConnection(ctx) {
    const mb = ctx.credentials.organizerEmail ? encodeURIComponent(String(ctx.credentials.organizerEmail)) : null;
    const r = mb
      ? await api(ctx, "GET", `${base(ctx)}/users/${mb}/calendar?$select=id,name,owner`)
      : await api(ctx, "GET", `${base(ctx)}/organization?$select=id,displayName`);
    expectOk("outlook_calendar", r, mb ? "get calendar" : "organization");
    const detail = mb ? `${r.json?.name || "calendar"} of ${ctx.credentials.organizerEmail}` : r.json?.value?.[0]?.displayName || "tenant reachable";
    return { ok: true, detail, workspaceId: mb ? String(r.json?.id || "") : r.json?.value?.[0]?.id || null };
  },
};
