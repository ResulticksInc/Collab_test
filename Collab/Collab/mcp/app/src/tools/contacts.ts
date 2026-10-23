import type { BackendGateway, McpTool } from "../types";
import { api, qs } from "../server/gateway";
import { GatewayError } from "../errors";
import { objectSchema, f, clampLimit, page } from "./helpers";

// Contacts/directory tools. CoLab exposes the workspace directory (GET /users)
// and a server-side people search via the unified /search endpoint. There is no
// single GET /users/:id route, so contact_details resolves against the directory
// the user is authorized to see — orchestration, not a new API.
export function contactsTools(gw: BackendGateway): McpTool[] {
  return [
    {
      name: "list_contacts",
      title: "List contacts",
      category: "contacts",
      description:
        "List workspace members (the people directory) visible to the user.",
      annotations: { readOnlyHint: true },
      inputSchema: objectSchema({ limit: f.limit() }),
      run: async (i, c) => {
        const data = (await gw.get(api("/users"), c)) as any[];
        return page(data, clampLimit(i.limit));
      },
    },
    {
      name: "search_contacts",
      title: "Search contacts",
      category: "contacts",
      description:
        "Search workspace members by name/email/handle. Results are ranked by interaction frequency.",
      annotations: { readOnlyHint: true },
      inputSchema: objectSchema(
        { query: f.text("Name, email, or handle", 200), limit: f.limit() },
        ["query"],
      ),
      run: async (i, c) => {
        const r = (await gw.get(api("/search") + qs({ q: i.query }), c)) as any;
        return page((r && r.people) || [], clampLimit(i.limit));
      },
    },
    {
      name: "contact_details",
      title: "Contact details",
      category: "contacts",
      description:
        "Get a single contact's public profile by user id (resolved from the directory the user can see). Returns NOT_FOUND if the id is not in the user's directory.",
      annotations: { readOnlyHint: true },
      inputSchema: objectSchema({ userId: f.id("Target user id") }, ["userId"]),
      run: async (i, c) => {
        const data = (await gw.get(api("/users"), c)) as any[];
        const found = (data || []).find(
          (u: any) => String(u.id) === String(i.userId),
        );
        if (!found)
          throw new GatewayError(
            "NOT_FOUND",
            "Contact not found in your directory.",
            404,
          );
        return found;
      },
    },
    {
      name: "frequent_contacts",
      title: "Frequent contacts",
      category: "contacts",
      description:
        "List the user's most-interacted-with contacts, ranked by frequency.",
      annotations: { readOnlyHint: true },
      inputSchema: objectSchema({ limit: f.limit() }),
      run: async (i, c) => {
        const data = (await gw.get(api("/users/frequent"), c)) as any[];
        return page(data, clampLimit(i.limit));
      },
    },
  ];
}
