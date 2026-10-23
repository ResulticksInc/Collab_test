import type { BackendGateway, McpTool } from "../types";
import { api, qs } from "../server/gateway";
import { objectSchema, f, clampLimit, page } from "./helpers";

// Activity tools — the user's own audit trail (/audit, self-scoped) and their
// notification feed (/notifications). Both are already scoped to the requester
// by the backend.
export function activityTools(gw: BackendGateway): McpTool[] {
  return [
    {
      name: "recent_activity",
      title: "Recent activity",
      category: "activity",
      description:
        "List the user's own recent activity (their audit trail: messages sent, tasks changed, meetings created, etc.).",
      annotations: { readOnlyHint: true },
      inputSchema: objectSchema({ limit: f.limit() }),
      run: async (i, c) => {
        const data = (await gw.get(api("/audit"), c)) as any[];
        return page(data, clampLimit(i.limit));
      },
    },
    {
      name: "unread_activity",
      title: "Unread activity",
      category: "activity",
      description:
        "Get the user's unread notifications and the total unread count (mentions, assignments, invites, replies).",
      annotations: { readOnlyHint: true },
      inputSchema: objectSchema({ limit: f.limit() }),
      run: async (i, c) => {
        const limit = clampLimit(i.limit);
        const [list, countRes] = await Promise.all([
          gw.get(api("/notifications") + qs({ limit }), c) as Promise<any[]>,
          gw.get(api("/notifications/unread-count"), c) as Promise<any>,
        ]);
        const unread = (list || []).filter((n: any) => !n.isRead && !n.is_read);
        return {
          unreadCount: (countRes && countRes.count) || unread.length,
          ...page(unread, limit),
        };
      },
    },
  ];
}
