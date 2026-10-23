// Google Calendar adapter (Calendar API v3).
//
// Auth: a service account with domain-wide delegation impersonating the
// organizer (credentials.impersonate), or a user-consented refresh token. A
// Google Meet link is requested on create via conferenceData.createRequest.
// Delta: events.list with a sync token (410 Gone → full window re-read).
import { callJson, expectOk } from "../http";
import { getGoogleToken } from "../oauth";
import { type AdapterCtx, type CalendarAdapter, type CalendarChange, type CalendarEventInput, PlatformError } from "../types";

const API = "https://www.googleapis.com/calendar/v3";
const SCOPES = ["https://www.googleapis.com/auth/calendar"];

const calendarId = (ctx: AdapterCtx) => String(ctx.credentials.calendarId || "primary");

async function api(ctx: AdapterCtx, method: string, path: string, body?: any, subject?: string | null) {
  const token = await getGoogleToken("google_calendar", ctx.credentials, SCOPES, subject ?? (ctx.credentials.impersonate || null), ctx.timeoutMs);
  return callJson("google_calendar", `${API}${path}`, { method, headers: { authorization: `Bearer ${token}` }, body, timeoutMs: ctx.timeoutMs });
}

function eventBody(input: CalendarEventInput, includeConference: boolean, conferenceType: string) {
  const description = [input.description || "", input.joinUrl ? `Join in CoLab: ${input.joinUrl}` : ""].filter(Boolean).join("\n\n");
  const body: any = {
    summary: input.title,
    description,
    location: input.location || undefined,
    start: { dateTime: input.startUtc, timeZone: input.timezone || "UTC" },
    end: { dateTime: input.endUtc, timeZone: input.timezone || "UTC" },
    attendees: input.attendeeEmails.map((email) => ({ email })),
    status: input.cancelled ? "cancelled" : "confirmed",
    extendedProperties: { private: { colabMeetingId: input.meetingId } },
  };
  if (includeConference)
    body.conferenceData = { createRequest: { requestId: `colab-${input.meetingId}`, conferenceSolutionKey: { type: conferenceType } } };
  return body;
}

export const googleCalendarAdapter: CalendarAdapter = {
  platform: "google_calendar",

  async upsertEvent(ctx, input, existingExternalId) {
    const cal = encodeURIComponent(calendarId(ctx));
    const conferenceType = String(ctx.account.settings?.conferenceType || "hangoutsMeet");
    const wantMeet = ctx.account.settings?.createMeetLink !== false;
    const subject = ctx.account.settings?.actAsOrganizer && input.organizerEmail ? input.organizerEmail : null;
    if (existingExternalId) {
      const r = await api(ctx, "PATCH", `/calendars/${cal}/events/${encodeURIComponent(existingExternalId)}?conferenceDataVersion=1&sendUpdates=all`, eventBody(input, false, conferenceType), subject);
      if (r.status !== 404 && r.status !== 410) {
        expectOk("google_calendar", r, "update event");
        return { externalEventId: String(r.json.id), externalCalendarId: calendarId(ctx), joinUrl: r.json.hangoutLink || null, updatedAt: r.json.updated || null };
      }
      // The event was deleted on the Google side — recreate below.
    }
    const r = await api(ctx, "POST", `/calendars/${cal}/events?conferenceDataVersion=1&sendUpdates=all`, eventBody(input, wantMeet, conferenceType), subject);
    expectOk("google_calendar", r, "create event");
    return { externalEventId: String(r.json.id), externalCalendarId: calendarId(ctx), joinUrl: r.json.hangoutLink || null, updatedAt: r.json.updated || null };
  },

  async deleteEvent(ctx, externalCalendarId, externalEventId) {
    const r = await api(ctx, "DELETE", `/calendars/${encodeURIComponent(externalCalendarId || calendarId(ctx))}/events/${encodeURIComponent(externalEventId)}?sendUpdates=all`);
    if (r.status === 404 || r.status === 410) return;
    expectOk("google_calendar", r, "delete event");
  },

  async pullChanges(ctx, cursor) {
    const cal = encodeURIComponent(calendarId(ctx));
    const changes: CalendarChange[] = [];
    let pageToken: string | null = null;
    let nextCursor: string | null = null;
    for (let page = 0; page < 20; page++) {
      const params = new URLSearchParams();
      if (cursor) params.set("syncToken", cursor);
      else {
        params.set("timeMin", new Date(Date.now() - 86400_000).toISOString());
        params.set("showDeleted", "true");
      }
      params.set("maxResults", "250");
      if (pageToken) params.set("pageToken", pageToken);
      const r = await api(ctx, "GET", `/calendars/${cal}/events?${params.toString()}`);
      if (r.status === 410) {
        // Sync token expired: the caller re-reads from scratch next time.
        return { changes: [], nextCursor: null };
      }
      expectOk("google_calendar", r, "list events");
      for (const ev of r.json?.items || []) {
        changes.push({
          externalEventId: String(ev.id),
          removed: ev.status === "cancelled",
          startUtc: ev.start?.dateTime || (ev.start?.date ? `${ev.start.date}T00:00:00Z` : null),
          endUtc: ev.end?.dateTime || (ev.end?.date ? `${ev.end.date}T00:00:00Z` : null),
          title: ev.summary || null,
          updatedAt: ev.updated || null,
        });
      }
      pageToken = r.json?.nextPageToken || null;
      if (!pageToken) {
        nextCursor = r.json?.nextSyncToken || null;
        break;
      }
    }
    return { changes, nextCursor };
  },

  async testConnection(ctx) {
    const r = await api(ctx, "GET", `/calendars/${encodeURIComponent(calendarId(ctx))}`);
    expectOk("google_calendar", r, "get calendar");
    if (!r.json?.id) throw new PlatformError("google_calendar", "calendar lookup returned no id", { status: 502 });
    return { ok: true, detail: `${r.json.summary || r.json.id} (${r.json.timeZone || "tz?"})`, workspaceId: String(r.json.id) };
  },
};
