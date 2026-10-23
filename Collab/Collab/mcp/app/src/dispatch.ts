import { config } from "./config";
import { registry } from "./registry";
import { resolveContext } from "./auth/jwt";
import { validateInput } from "./validation/schema";
import { RpcError, RpcCode, toSafeError } from "./errors";
import { log, safeId } from "./audit/logger";
import type { McpContext, McpResource } from "./types";

// Transport-agnostic MCP JSON-RPC 2.0 dispatcher. Both the stdio and HTTP
// transports parse a message and hand it here with the request's auth material.
// This is the single place the MCP wire protocol lives (initialize handshake,
// capability listing, tool/resource/prompt execution, error envelopes).

type AuthInput = { token?: string; tenantId?: string };
type JsonRpc = {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: any;
};

function ok(id: any, result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}
function err(id: any, code: number, message: string, data?: unknown) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message, ...(data ? { data } : {}) },
  };
}

// Cap a serialized payload so a tool/resource can never dump an unbounded blob
// into the model context (pagination already bounds counts; this bounds bytes).
function serialize(data: unknown): string {
  let text = "";
  try {
    text = JSON.stringify(data, null, 2);
  } catch {
    text = String(data);
  }
  const MAX = 200_000;
  return text.length > MAX ? text.slice(0, MAX) + "\n…[truncated]" : text;
}

export function createDispatcher() {
  const reg = registry();
  const toolByName = new Map(reg.tools.map((t) => [t.name, t]));
  const promptByName = new Map(reg.prompts.map((p) => [p.name, p]));
  // Captured at initialize for audit attribution (best-effort; stdio is one
  // session, HTTP may re-send it per request).
  let clientInfo: { name?: string; version?: string } | undefined;

  function listTools() {
    return reg.tools.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: t.annotations,
    }));
  }
  function listResources() {
    return reg.resources
      .filter((r) => !r.isTemplate)
      .map((r) => ({
        uri: r.uri,
        name: r.name,
        description: r.description,
        mimeType: r.mimeType,
      }));
  }
  function listTemplates() {
    return reg.resources
      .filter((r) => r.isTemplate)
      .map((r) => ({
        uriTemplate: r.uri,
        name: r.name,
        description: r.description,
        mimeType: r.mimeType,
      }));
  }
  function listPrompts() {
    return reg.prompts.map((p) => ({
      name: p.name,
      description: p.description,
      arguments: p.arguments || [],
    }));
  }

  // Resolve a requested resource URI to a resource + extracted params (path
  // template placeholders + query string).
  function matchResource(
    uri: string,
  ): { resource: McpResource; params: Record<string, unknown> } | null {
    const [base, query] = String(uri).split("?");
    const qp: Record<string, unknown> = {};
    if (query) for (const [k, v] of new URLSearchParams(query)) qp[k] = v;
    // Exact (collection) match first.
    for (const r of reg.resources) {
      if (!r.isTemplate && r.uri === base) return { resource: r, params: qp };
    }
    // Template match.
    for (const r of reg.resources) {
      if (!r.isTemplate) continue;
      const names: string[] = [];
      const pattern =
        "^" +
        r.uri
          .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
          .replace(/\\\{(\w+)\\\}/g, (_m, n) => {
            names.push(n);
            return "([^/]+)";
          }) +
        "$";
      const m = base.match(new RegExp(pattern));
      if (m) {
        names.forEach((n, idx) => (qp[n] = decodeURIComponent(m[idx + 1])));
        return { resource: r, params: qp };
      }
    }
    return null;
  }

  // Resolve auth → context, logging auth failures. Throws RpcError on failure.
  function authedContext(auth: AuthInput, id: any): McpContext {
    try {
      return resolveContext({
        token: auth.token,
        tenantId: auth.tenantId,
        requestId: id,
        clientInfo,
      });
    } catch (e) {
      log.audit({
        event: "auth",
        ok: false,
        errorCode: "UNAUTHENTICATED",
        client: clientInfo?.name,
      });
      throw e;
    }
  }

  async function callTool(params: any, auth: AuthInput, id: any) {
    const name = params?.name;
    const tool = toolByName.get(name);
    if (!tool)
      throw new RpcError(RpcCode.InvalidParams, `Unknown tool: ${name}`);
    const context = authedContext(auth, id);
    const start = Date.now();
    const args = (params && params.arguments) || {};
    const resource = safeId(
      args.conversationId ||
        args.meetingId ||
        args.taskId ||
        args.fileId ||
        args.userId,
    );
    try {
      const clean = validateInput(tool.inputSchema, args);
      const data = await tool.run(clean, context);
      log.audit({
        event: "tool.call",
        name,
        user: context.userId,
        tenant: context.tenantId,
        resource,
        ok: true,
        durationMs: Date.now() - start,
        client: context.clientInfo?.name,
      });
      return {
        content: [{ type: "text", text: serialize(data) }],
        structuredContent: data,
        isError: false,
      };
    } catch (e) {
      const safe = toSafeError(e);
      log.audit({
        event: "tool.call",
        name,
        user: context.userId,
        tenant: context.tenantId,
        resource,
        ok: false,
        errorCode: safe.code,
        durationMs: Date.now() - start,
        client: context.clientInfo?.name,
      });
      // Tool execution failures are returned as an isError RESULT (so the model
      // can read + recover), not a transport error.
      return {
        content: [{ type: "text", text: `${safe.code}: ${safe.message}` }],
        isError: true,
      };
    }
  }

  async function readResource(params: any, auth: AuthInput, id: any) {
    const uri = params?.uri;
    const matched = matchResource(String(uri || ""));
    if (!matched)
      throw new RpcError(RpcCode.InvalidParams, `Unknown resource: ${uri}`);
    const context = authedContext(auth, id);
    const start = Date.now();
    try {
      const data = await matched.resource.read(matched.params, context);
      log.audit({
        event: "resource.read",
        name: matched.resource.uri,
        user: context.userId,
        tenant: context.tenantId,
        resource: safeId(
          matched.params.conversationId || matched.params.messageId,
        ),
        ok: true,
        durationMs: Date.now() - start,
      });
      return {
        contents: [
          {
            uri: String(uri),
            mimeType: matched.resource.mimeType || "application/json",
            text: serialize(data),
          },
        ],
      };
    } catch (e) {
      const safe = toSafeError(e);
      log.audit({
        event: "resource.read",
        name: matched.resource.uri,
        user: context.userId,
        ok: false,
        errorCode: safe.code,
        durationMs: Date.now() - start,
      });
      // Resource read failures ARE protocol errors (no model-recovery envelope).
      throw new RpcError(
        RpcCode.InternalError,
        `${safe.code}: ${safe.message}`,
      );
    }
  }

  function getPrompt(params: any) {
    const p = promptByName.get(params?.name);
    if (!p)
      throw new RpcError(
        RpcCode.InvalidParams,
        `Unknown prompt: ${params?.name}`,
      );
    const args = (params && params.arguments) || {};
    for (const a of p.arguments || [])
      if (a.required && !args[a.name])
        throw new RpcError(
          RpcCode.InvalidParams,
          `Missing required prompt argument: ${a.name}`,
        );
    const messages = p
      .build(args)
      .map((m) => ({ role: m.role, content: { type: "text", text: m.text } }));
    log.audit({ event: "prompt.get", name: p.name, ok: true });
    return { description: p.description, messages };
  }

  function initializeResult(params: any) {
    if (params && params.clientInfo) clientInfo = params.clientInfo;
    log.audit({
      event: "server",
      name: "initialize",
      ok: true,
      client: clientInfo?.name,
    });
    return {
      protocolVersion: config.protocolVersion,
      capabilities: {
        tools: { listChanged: false },
        resources: { listChanged: false },
        prompts: { listChanged: false },
        logging: {},
      },
      serverInfo: { name: config.name, version: config.version },
      instructions:
        "CoLab MCP server. Tools and resources act on behalf of the authenticated user; " +
        "the CoLab backend enforces all permissions. Prefer read tools (list_*, *_summary, " +
        "global_search) before write tools (send_message, create_*, update_*).",
    };
  }

  // Returns a JSON-RPC response object, or null for notifications (no id).
  async function handle(
    message: JsonRpc,
    auth: AuthInput,
  ): Promise<object | null> {
    const { id, method, params } = message || {};
    // Notifications (initialized, cancelled, …) carry no id and expect no reply.
    if (method && method.startsWith("notifications/")) return null;
    if (method === "initialized") return null;
    if (id === undefined && !method)
      return err(null, RpcCode.InvalidRequest, "Invalid request");

    try {
      switch (method) {
        case "initialize":
          return ok(id, initializeResult(params));
        case "ping":
          return ok(id, {});
        case "tools/list":
          return ok(id, { tools: listTools() });
        case "tools/call":
          return ok(id, await callTool(params, auth, id));
        case "resources/list":
          return ok(id, { resources: listResources() });
        case "resources/templates/list":
          return ok(id, { resourceTemplates: listTemplates() });
        case "resources/read":
          return ok(id, await readResource(params, auth, id));
        case "prompts/list":
          return ok(id, { prompts: listPrompts() });
        case "prompts/get":
          return ok(id, getPrompt(params));
        default:
          throw new RpcError(
            RpcCode.MethodNotFound,
            `Unknown method: ${method}`,
          );
      }
    } catch (e) {
      if (e instanceof RpcError) return err(id, e.code, e.message, e.data);
      // Never leak internals.
      log.error("dispatch.internal", {
        method,
        msg: e instanceof Error ? e.message : String(e),
      });
      return err(id, RpcCode.InternalError, "Internal server error");
    }
  }

  return { handle, registry: reg };
}
