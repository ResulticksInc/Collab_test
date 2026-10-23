import type { BackendGateway, McpTool } from "../types";
import { api, qs } from "../server/gateway";
import { objectSchema, f, clampLimit, seg, page } from "./helpers";

// Messaging tools — orchestrate the existing conversation/message/AI services.
// Every call carries the user's token, so the backend enforces conversation
// membership (messageService.assertMember → 403 for non-members). The MCP layer
// adds no privileged access.
export function messagingTools(gw: BackendGateway): McpTool[] {
  return [
    {
      name: "list_conversations",
      title: "List conversations",
      category: "messaging",
      description:
        "List the conversations (DMs, groups, channels) the authenticated user belongs to, with unread counts and last message.",
      annotations: { readOnlyHint: true },
      inputSchema: objectSchema({ limit: f.limit() }),
      run: async (i, c) => {
        const data = (await gw.get(api("/conversations"), c)) as any[];
        return page(data, clampLimit(i.limit));
      },
    },
    {
      name: "list_messages",
      title: "List messages",
      category: "messaging",
      description:
        "Read recent messages in a conversation, newest-anchored. Use `before` (oldest seen id) for keyset pagination into older history. Returns messages the user is authorized to see.",
      annotations: { readOnlyHint: true },
      inputSchema: objectSchema(
        {
          conversationId: f.id("Conversation id"),
          limit: f.limit(),
          before: f.cursor(),
        },
        ["conversationId"],
      ),
      run: (i, c) =>
        gw.get(
          api(`/conversations/${seg(i.conversationId)}/messages`) +
            qs({ limit: clampLimit(i.limit), before: i.before }),
          c,
        ),
    },
    {
      name: "search_messages",
      title: "Search messages",
      category: "messaging",
      description:
        "Full-text search across messages the user can access. Returns matching messages with their conversation + sender.",
      annotations: { readOnlyHint: true },
      inputSchema: objectSchema(
        { query: f.text("Search text", 200), limit: f.limit() },
        ["query"],
      ),
      run: async (i, c) => {
        const r = (await gw.get(api("/search") + qs({ q: i.query }), c)) as any;
        return page((r && r.messages) || [], clampLimit(i.limit));
      },
    },
    {
      name: "send_message",
      title: "Send message",
      category: "messaging",
      description:
        "Send a text message to a conversation the user is a member of. Returns the created message.",
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: objectSchema(
        {
          conversationId: f.id("Target conversation id"),
          text: f.text("Message body"),
        },
        ["conversationId", "text"],
      ),
      run: (i, c) =>
        gw.post(
          api(`/conversations/${seg(i.conversationId)}/messages`),
          { text: i.text },
          c,
        ),
    },
    {
      name: "reply_message",
      title: "Reply to a message",
      category: "messaging",
      description:
        "Reply to a specific message, threading the reply inline in the conversation timeline. Returns the created reply.",
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: objectSchema(
        {
          conversationId: f.id("Conversation id"),
          parentMessageId: f.id("The message being replied to"),
          text: f.text("Reply body"),
        },
        ["conversationId", "parentMessageId", "text"],
      ),
      run: (i, c) =>
        gw.post(
          api(`/conversations/${seg(i.conversationId)}/messages`),
          { text: i.text, parentMessageId: i.parentMessageId },
          c,
        ),
    },
    {
      name: "conversation_summary",
      title: "Summarize a conversation",
      category: "messaging",
      description:
        "Generate an AI summary of a conversation the user can access. Requires the deployment's AI provider to be configured (returns an UNAVAILABLE error otherwise).",
      annotations: { readOnlyHint: true },
      inputSchema: objectSchema({ conversationId: f.id("Conversation id") }, [
        "conversationId",
      ]),
      run: (i, c) =>
        gw.post(api("/ai/summarize"), { conversationId: i.conversationId }, c),
    },
  ];
}
