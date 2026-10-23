import type { BackendGateway, McpTool } from "../types";
import { api } from "../server/gateway";
import { GatewayError } from "../errors";
import { objectSchema, f, clampLimit, seg, page } from "./helpers";

// Calendar + Meetings tools. CoLab models calendar events AS meetings, so both
// feature groups share the /meetings service. There is no single GET
// /meetings/:id route, so detail/join tools resolve from the user's meeting
// list (which the backend already scopes to meetings they can see).
async function findMeeting(gw: BackendGateway, c: any, id: unknown) {
  const list = (await gw.get(api("/meetings"), c)) as any[];
  const m = (list || []).find((x: any) => String(x.id) === String(id));
  if (!m)
    throw new GatewayError(
      "NOT_FOUND",
      "Meeting not found or not visible to you.",
      404,
    );
  return m;
}

export function calendarTools(gw: BackendGateway): McpTool[] {
  return [
    {
      name: "list_events",
      title: "List calendar events",
      category: "calendar",
      description:
        "List the user's calendar events (meetings), past and upcoming.",
      annotations: { readOnlyHint: true },
      inputSchema: objectSchema({ limit: f.limit() }),
      run: async (i, c) => {
        const list = (await gw.get(api("/meetings"), c)) as any[];
        return page(list, clampLimit(i.limit));
      },
    },
    {
      name: "upcoming_meetings",
      title: "Upcoming meetings",
      category: "meetings",
      description:
        "List the user's meetings starting now or later, soonest first.",
      annotations: { readOnlyHint: true },
      inputSchema: objectSchema({ limit: f.limit() }),
      run: async (i, c) => {
        const list = ((await gw.get(api("/meetings"), c)) as any[]) || [];
        const now = Date.now();
        const upcoming = list
          .filter(
            (m) =>
              m &&
              m.startsAt &&
              new Date(m.startsAt).getTime() >= now &&
              m.status !== "cancelled",
          )
          .sort(
            (a, b) =>
              new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
          );
        return page(upcoming, clampLimit(i.limit));
      },
    },
    {
      name: "meeting_details",
      title: "Meeting details",
      category: "meetings",
      description:
        "Get full details of one meeting by id (title, time, attendees, status, lobby/lock).",
      annotations: { readOnlyHint: true },
      inputSchema: objectSchema({ meetingId: f.id("Meeting id") }, [
        "meetingId",
      ]),
      run: (i, c) => findMeeting(gw, c, i.meetingId),
    },
    {
      name: "join_information",
      title: "Meeting join information",
      category: "meetings",
      description:
        "Get the information needed to join a meeting: meeting id, scheduled start, duration, and whether a lobby/lock is active. (Media tokens are minted by the app at join time, not here.)",
      annotations: { readOnlyHint: true },
      inputSchema: objectSchema({ meetingId: f.id("Meeting id") }, [
        "meetingId",
      ]),
      run: async (i, c) => {
        const m = await findMeeting(gw, c, i.meetingId);
        return {
          meetingId: m.id,
          title: m.title,
          startsAt: m.startsAt,
          durationMin: m.durationMin,
          status: m.status,
          lobbyEnabled: !!m.lobbyEnabled,
          locked: !!m.locked,
          conversationId: m.conversationId || null,
          note: "Open the meeting in CoLab to join; the client mints a media token at join time.",
        };
      },
    },
    {
      name: "create_meeting",
      title: "Create meeting",
      category: "calendar",
      description:
        "Schedule a meeting/event. Invites the given attendee user ids and (optionally) links it to a conversation.",
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: objectSchema(
        {
          title: f.text("Meeting title", 255),
          startsAt: f.isoDate("Start time"),
          durationMin: {
            type: "integer",
            description: "Duration in minutes (default 30).",
            minimum: 1,
            maximum: 1440,
            default: 30,
          },
          attendees: f.stringArray("Attendee user ids to invite (at least one is required)"),
          conversationId: f.id(
            "Optional conversation to link/post the invite to",
          ),
          recurrence: {
            type: "string",
            description: "Recurrence preset.",
            enum: ["none", "daily", "weekly", "monthly", "yearly"],
            default: "none",
          },
        },
        ["title", "startsAt", "attendees"],
      ),
      run: (i, c) =>
        gw.post(
          api("/meetings"),
          {
            title: i.title,
            startsAt: i.startsAt,
            durationMin: i.durationMin,
            attendees: i.attendees || [],
            conversationId: i.conversationId,
            recurrence: i.recurrence,
          },
          c,
        ),
    },
    {
      name: "update_meeting",
      title: "Update meeting",
      category: "calendar",
      description:
        "Update a meeting's title, start time, or duration. Host/co-host only (enforced by the backend).",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
      inputSchema: objectSchema(
        {
          meetingId: f.id("Meeting id"),
          title: f.text("New title", 255),
          startsAt: f.isoDate("New start time"),
          durationMin: {
            type: "integer",
            description: "New duration in minutes.",
            minimum: 1,
            maximum: 1440,
          },
        },
        ["meetingId"],
      ),
      run: (i, c) => {
        const patch: Record<string, unknown> = {};
        if (i.title !== undefined) patch.title = i.title;
        if (i.startsAt !== undefined) patch.startsAt = i.startsAt;
        if (i.durationMin !== undefined) patch.durationMin = i.durationMin;
        return gw.patch(api(`/meetings/${seg(i.meetingId)}`), patch, c);
      },
    },
    {
      name: "cancel_meeting",
      title: "Cancel meeting",
      category: "calendar",
      description:
        "Cancel a meeting. Host/co-host only (enforced by the backend). The event is marked cancelled, not hard-deleted.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
      inputSchema: objectSchema({ meetingId: f.id("Meeting id") }, [
        "meetingId",
      ]),
      run: (i, c) =>
        gw.post(api(`/meetings/${seg(i.meetingId)}/cancel`), {}, c),
    },
  ];
}
