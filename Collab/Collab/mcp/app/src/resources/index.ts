import type { BackendGateway, McpResource } from "../types";
import { api, qs } from "../server/gateway";
import { config } from "../config";
import { seg } from "../tools/helpers";

// MCP resources expose CoLab data for READ/SUBSCRIBE-style access (vs tools,
// which are actions). Every read goes through the gateway with the user's token,
// so the backend scopes the data. Two kinds:
//   • Collection resources (fixed URI) — list the user's conversations, tasks,
//     meetings, files, contacts, activity, reminders, notifications.
//   • Resource templates (URI with {params}) — drill into one conversation's
//     messages or one meeting, with pagination/filter params.

function clamp(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return config.defaultPageSize;
  return Math.min(Math.trunc(n), config.maxPageSize);
}

export function createResources(gateway: BackendGateway): McpResource[] {
  const collections: Array<[string, string, string, string]> = [
    // [uri, name, description, apiPath]
    [
      "colab://conversations",
      "Conversations",
      "Conversations the user belongs to",
      "/conversations",
    ],
    ["colab://tasks", "Tasks", "The user's task board", "/tasks"],
    [
      "colab://meetings",
      "Meetings",
      "The user's meetings / calendar events",
      "/meetings",
    ],
    ["colab://files", "Files", "Files the user can access", "/files"],
    ["colab://contacts", "Contacts", "Workspace directory", "/users"],
    [
      "colab://activity",
      "Activity",
      "The user's recent activity (audit trail)",
      "/audit",
    ],
    ["colab://reminders", "Reminders", "The user's reminders", "/reminders"],
    [
      "colab://notifications",
      "Notifications",
      "The user's notification feed",
      "/notifications",
    ],
  ];

  const collectionResources: McpResource[] = collections.map(
    ([uri, name, description, path]) => ({
      uri,
      name,
      description,
      mimeType: "application/json",
      read: async (params, context) => {
        // Pagination/filter pass-through where the underlying route supports it
        // (messages/notifications take limit; others return a per-user list).
        const query = qs({ limit: clamp(params.limit) });
        const data = (await gateway.get(
          api(path) + (path === "/notifications" ? query : ""),
          context,
        )) as any;
        // Some collection routes now return a paginated envelope (e.g. /tasks →
        // { tasks, hasMore, count }) rather than a bare array. Unwrap the list.
        const arr = Array.isArray(data)
          ? data
          : (data && (data.tasks || data.items)) || [];
        const lim = clamp(params.limit);
        return {
          uri,
          count: Math.min(arr.length, lim),
          items: arr.slice(0, lim),
        };
      },
    }),
  );

  const templates: McpResource[] = [
    {
      uri: "colab://conversations/{conversationId}/messages",
      name: "Conversation messages",
      description:
        "Messages in a conversation. Params: conversationId (required), limit, before (keyset cursor = oldest seen id).",
      mimeType: "application/json",
      isTemplate: true,
      read: (params, context) =>
        gateway.get(
          api(`/conversations/${seg(params.conversationId)}/messages`) +
            qs({ limit: clamp(params.limit), before: params.before }),
          context,
        ),
    },
    {
      uri: "colab://conversations/{conversationId}/thread/{messageId}",
      name: "Message thread",
      description:
        "A message and its replies. Params: conversationId, messageId (both required).",
      mimeType: "application/json",
      isTemplate: true,
      read: (params, context) =>
        gateway.get(
          api(
            `/conversations/${seg(params.conversationId)}/thread/${seg(params.messageId)}`,
          ),
          context,
        ),
    },
  ];

  return [...collectionResources, ...templates];
}
