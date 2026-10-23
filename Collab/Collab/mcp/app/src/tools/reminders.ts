import type { BackendGateway, McpTool } from "../types";
import { api } from "../server/gateway";
import { objectSchema, f, clampLimit, page } from "./helpers";

// Reminder tools — orchestrate reminderService via /reminders. Reminders are
// strictly per-user (the backend scopes every query to req.user).
const PRIORITIES = ["Low", "Medium", "High", "Urgent"];

export function reminderTools(gw: BackendGateway): McpTool[] {
  return [
    {
      name: "upcoming_reminders",
      title: "Upcoming reminders",
      category: "reminders",
      description: "List the user's open reminders, soonest due first.",
      annotations: { readOnlyHint: true },
      inputSchema: objectSchema({ limit: f.limit() }),
      run: async (i, c) => {
        const list = ((await gw.get(api("/reminders"), c)) as any[]) || [];
        const open = list.filter((r) => r && r.status !== "done" && !r.done);
        open.sort((a, b) => {
          const ta = a.dueAt ? new Date(a.dueAt).getTime() : Infinity;
          const tb = b.dueAt ? new Date(b.dueAt).getTime() : Infinity;
          return ta - tb;
        });
        return page(open, clampLimit(i.limit));
      },
    },
    {
      name: "create_reminder",
      title: "Create reminder",
      category: "reminders",
      description: "Create a personal reminder. Only `text` is required.",
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: objectSchema(
        {
          text: f.text("Reminder text", 2000),
          dueAt: f.isoDate("Due date/time"),
          dueLabel: f.shortText(
            "Human-friendly due label (e.g. 'Tomorrow 9am')",
          ),
          description: f.text("Longer description", 4000),
          priority: {
            type: "string",
            description: "Priority.",
            enum: PRIORITIES,
            default: "Medium",
          },
          folderId: f.id("Optional list/folder id"),
          recurrence: {
            type: "string",
            description: "Recurrence preset.",
            enum: ["none", "daily", "weekly", "monthly", "yearly"],
            default: "none",
          },
        },
        ["text"],
      ),
      run: (i, c) =>
        gw.post(
          api("/reminders"),
          {
            text: i.text,
            dueAt: i.dueAt,
            dueLabel: i.dueLabel,
            description: i.description,
            priority: i.priority,
            folderId: i.folderId,
            recurrence: i.recurrence,
          },
          c,
        ),
    },
  ];
}
