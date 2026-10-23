import type { BackendGateway, McpTool } from "../types";
import { api, qs } from "../server/gateway";
import { objectSchema, f, clampLimit, page } from "./helpers";

// Global search — the unified /search endpoint returns matches across messages,
// people, conversations, tasks, reminders, meetings, and files, each already
// scoped to what the user can access.
export function searchTools(gw: BackendGateway): McpTool[] {
  return [
    {
      name: "global_search",
      title: "Global search",
      category: "search",
      description:
        "Search everything the user can access in one call — messages, people, conversations, tasks, reminders, meetings, and files. Optionally restrict to specific result types.",
      annotations: { readOnlyHint: true },
      inputSchema: objectSchema(
        {
          query: f.text("Search text", 200),
          types: {
            type: "array",
            description: "Optional subset to return; omit for all.",
            items: {
              type: "string",
              enum: [
                "messages",
                "people",
                "conversations",
                "tasks",
                "reminders",
                "meetings",
                "files",
              ],
            },
          },
          limit: f.limit(),
        },
        ["query"],
      ),
      run: async (i, c) => {
        const r =
          ((await gw.get(api("/search") + qs({ q: i.query }), c)) as any) || {};
        const limit = clampLimit(i.limit);
        const allTypes = [
          "messages",
          "people",
          "conversations",
          "tasks",
          "reminders",
          "meetings",
          "files",
        ];
        const want =
          Array.isArray(i.types) && i.types.length
            ? (i.types as string[])
            : allTypes;
        const out: Record<string, unknown> = {};
        let total = 0;
        for (const t of allTypes) {
          if (!want.includes(t)) continue;
          const p = page((r[t] as any[]) || [], limit);
          out[t] = p.items;
          total += p.count;
        }
        return { query: i.query, totalResults: total, results: out };
      },
    },
  ];
}
