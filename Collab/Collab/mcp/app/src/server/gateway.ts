import { config } from "../config";
import { GatewayError } from "../errors";
import { log } from "../audit/logger";
import type { BackendGateway, McpContext } from "../types";

// The ONLY bridge between the MCP server and CoLab. Every call goes over HTTP to
// the existing backend REST API carrying the user's Bearer token, so the backend
// enforces authentication, membership, and authorization on each request — the
// MCP server adds NO privileged path and duplicates NO business logic. This is
// what makes the MCP server a thin, secure orchestration layer.

// Bound concurrent in-flight calls so a runaway client can't exhaust the backend
// pool through MCP. Excess calls wait briefly for a slot.
let inFlight = 0;
const waiters: (() => void)[] = [];
async function acquire(): Promise<void> {
  if (inFlight < config.maxConcurrentCalls) {
    inFlight++;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  inFlight++;
}
function release(): void {
  inFlight--;
  const next = waiters.shift();
  if (next) next();
}

function headersFor(
  context: McpContext,
  extra?: Record<string, string>,
): Record<string, string> {
  if (!context || !context.token)
    throw new GatewayError("UNAUTHENTICATED", "Missing token", 401);
  return {
    Authorization: "Bearer " + context.token,
    // Forward tenant opaquely (single-workspace today; future multi-tenant uses it).
    ...(context.tenantId ? { "X-CoLab-Tenant": context.tenantId } : {}),
    "X-CoLab-Client": "mcp/" + config.version,
    ...(extra || {}),
  };
}

async function request(
  method: string,
  path: string,
  context: McpContext,
  body?: Record<string, unknown> | null,
  rawBody?: { bytes: Uint8Array; contentType: string },
): Promise<unknown> {
  const url = config.baseUrl + path;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.gatewayTimeoutMs);
  await acquire();
  try {
    const init: any = {
      method,
      headers: headersFor(context),
      signal: controller.signal,
    };
    if (rawBody) {
      init.headers["Content-Type"] = rawBody.contentType;
      init.body = rawBody.bytes;
    } else if (body !== undefined && body !== null) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    let res: any;
    try {
      res = await fetch(url, init);
    } catch (e: any) {
      // Network / DNS / connection refused / abort (timeout).
      if (e && e.name === "AbortError")
        throw new GatewayError("TIMEOUT", "Backend request timed out", 504);
      throw new GatewayError("UNAVAILABLE", "Cannot reach CoLab backend", 503);
    }

    // Some endpoints (file download) stream binary; the JSON tools never hit
    // those, but guard anyway so a non-JSON body becomes a clean error.
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    if (!res.ok || !json || json.ok !== true) {
      const code = (json && json.error && json.error.code) || "BACKEND_ERROR";
      const message =
        (json && json.error && json.error.message) ||
        `Backend request failed (${res.status})`;
      // Log the failure (status + code only — never the response body).
      log.warn("gateway.error", { method, path, status: res.status, code });
      throw new GatewayError(code, message, res.status);
    }
    return json.data;
  } finally {
    clearTimeout(timer);
    release();
  }
}

export const backendGateway: BackendGateway = {
  get: (path, context) => request("GET", path, context),
  post: (path, body, context) => request("POST", path, context, body),
  patch: (path, body, context) => request("PATCH", path, context, body),
  delete: (path, context) => request("DELETE", path, context, null),
  postRaw: (path, bytes, contentType, context) =>
    request("POST", path, context, undefined, { bytes, contentType }),
};

// Build a query string from a sparse params object (skips null/undefined/empty).
export function qs(params: Record<string, unknown>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    u.set(k, String(v));
  }
  const s = u.toString();
  return s ? "?" + s : "";
}

// API path builder — prefixes the configured /api mount so tool definitions read
// cleanly (e.g. api("/conversations")). Encodes path segments passed via tpl.
export function api(path: string): string {
  return config.apiPrefix + path;
}
