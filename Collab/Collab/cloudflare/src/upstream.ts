// The CoLab application API lives on API_ORIGIN (https://collab-uat.resulticks.com). The Worker
// serves the SPA from Workers Assets and forwards /api/*, /socket.io/* and /uploads/* there, so the
// browser keeps a same-origin API and the Worker holds no database, credentials or backend process.
import { apiOrigin, type ExternalApiEnv } from "./externalApi";

export const PROXY_PREFIXES = ["/api/", "/socket.io/", "/uploads/"];

export function isProxiedPath(url: URL): boolean {
  const p = url.pathname;
  return PROXY_PREFIXES.some((pre) => p === pre.slice(0, -1) || p.startsWith(pre));
}

const HOP_BY_HOP = ["host", "cf-connecting-ip", "cf-ipcountry", "cf-ray", "cf-visitor", "cf-worker", "content-length"];

/** Reverse-proxy one request (including WebSocket upgrades) to the application API. */
export async function proxyToUpstream(request: Request, env: ExternalApiEnv): Promise<Response> {
  const inUrl = new URL(request.url);
  const target = apiOrigin(env) + inUrl.pathname + inUrl.search;
  const headers = new Headers(request.headers);
  for (const h of HOP_BY_HOP) headers.delete(h);
  headers.set("x-forwarded-host", inUrl.host);
  headers.set("x-forwarded-proto", inUrl.protocol.replace(":", ""));
  const ip = request.headers.get("cf-connecting-ip");
  if (ip) headers.set("x-forwarded-for", ip);
  // A same-origin request from the SPA carries Origin = this Worker's host, which the backend's CORS
  // allow-list does not know. The browser never enforces CORS on a same-origin call, so present the
  // request to the backend as its own origin. A genuinely cross-site Origin is left for it to judge.
  const origin = request.headers.get("origin");
  if (origin && origin === inUrl.origin) headers.set("origin", apiOrigin(env));

  const method = request.method.toUpperCase();
  const init: RequestInit = {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : request.body,
    redirect: "manual",
  };
  try {
    // `fetch` with an Upgrade: websocket header returns a 101 whose `webSocket` the runtime hands to
    // the client when the Response is returned unchanged — Socket.IO upgrades pass straight through.
    return await fetch(target, init);
  } catch (e) {
    console.log(`[proxy] ${method} ${inUrl.pathname} -> ${target} failed: ${String(e).slice(0, 200)}`);
    return Response.json(
      { ok: false, error: { code: "UPSTREAM_UNAVAILABLE", message: "The CoLab API is not reachable right now. Please retry shortly." } },
      { status: 502, headers: { "retry-after": "10", "cache-control": "no-store" } },
    );
  }
}

// ── Caller identity ───────────────────────────────────────────────────────────────────────────────
// /api/edge/* routes run as the signed-in user. The Worker does not hold AUTH_JWT_SECRET; the bearer
// token is validated by the application API itself (GET /api/auth/me), which also honours revoked
// and expired sessions. Successful lookups are cached briefly per token to save a round-trip.

export interface Caller { id: string; name?: string; email?: string | null }

const CACHE_TTL_MS = 30_000;
const CACHE_MAX = 500;
const callerCache = new Map<string, { user: Caller; exp: number }>();

export function bearerToken(request: Request): string {
  const auth = request.headers.get("authorization") ?? "";
  return auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
}

export type WhoAmI = { user: Caller; token: string } | { error: Response };

export async function whoAmI(request: Request, env: ExternalApiEnv): Promise<WhoAmI> {
  const token = bearerToken(request);
  const unauthorized = (message: string) =>
    ({ error: Response.json({ ok: false, error: { code: "UNAUTHORIZED", message } }, { status: 401, headers: { "cache-control": "no-store" } }) });
  if (!token) return unauthorized("missing bearer token");
  const now = Date.now();
  const hit = callerCache.get(token);
  if (hit && hit.exp > now) return { user: hit.user, token };
  let res: Response;
  try {
    res = await fetch(apiOrigin(env) + "/api/auth/me", {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    return { error: Response.json({ ok: false, error: { code: "UPSTREAM_UNAVAILABLE", message: String(e).slice(0, 150) } }, { status: 503 }) };
  }
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; data?: { id?: string; name?: string; email?: string | null } };
  if (res.status === 401 || res.status === 403) return unauthorized("invalid, expired or revoked token");
  if (!res.ok || !body.data?.id) {
    return { error: Response.json({ ok: false, error: { code: "UPSTREAM_ERROR", message: `auth lookup returned ${res.status}` } }, { status: 503 }) };
  }
  const user: Caller = { id: String(body.data.id), name: body.data.name, email: body.data.email ?? null };
  if (callerCache.size >= CACHE_MAX) callerCache.delete(callerCache.keys().next().value as string);
  callerCache.set(token, { user, exp: now + CACHE_TTL_MS });
  return { user, token };
}

/** Forward a JSON write to the application API as the caller (used where the External API has no write). */
export async function forwardAsUser(env: ExternalApiEnv, token: string, method: string, path: string, body?: unknown): Promise<Response> {
  const res = await fetch(apiOrigin(env) + path, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  return new Response(text, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json", "cache-control": "no-store" } });
}
