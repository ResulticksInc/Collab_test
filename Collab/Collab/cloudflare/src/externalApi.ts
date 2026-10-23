// Client for the CoLab External Data API (docs/EXTERNAL_DATA_API.html), used by the Worker-side
// routes in src/edgeApi.ts. This is the ONLY data path the Worker has: there is no MySQL driver,
// no DB gateway and no tunnel in this deployment. Every read is an HTTPS GET to
//   <API_ORIGIN>/api/external/v1/...   with   X-API-Key: <COLAB_API_KEY>
// and comes back in CoLab's envelope { ok, data, meta? } / { ok:false, error:{ code, message } }.
//
// Env (wrangler.jsonc vars + dashboard secrets):
//   API_ORIGIN    https://collab-uat.resulticks.com   (var; default below)
//   COLAB_API_KEY colab_…                             (secret; org key or platform key)
//   COLAB_ORG_ID  org_…                               (var; only for a platform key → sent as X-Org-Id)

export const DEFAULT_API_ORIGIN = "https://collab-uat.resulticks.com";
export const EXTERNAL_API_PATH = "/api/external/v1";

export interface ExternalApiEnv {
  API_ORIGIN?: string;
  COLAB_API_KEY?: string;
  COLAB_ORG_ID?: string;
  [key: string]: unknown;
}

export function apiOrigin(env: ExternalApiEnv): string {
  const raw = typeof env.API_ORIGIN === "string" && env.API_ORIGIN.trim() ? env.API_ORIGIN.trim() : DEFAULT_API_ORIGIN;
  return raw.replace(/\/+$/, "");
}

export class ExternalApiError extends Error {
  constructor(message: string, public status: number, public code: string, public retryAfter?: string) {
    super(message);
  }
}

export interface Meta {
  limit: number;
  offset: number;
  count: number;
  hasMore: boolean;
  nextOffset: number | null;
  [key: string]: unknown;
}

export type Params = Record<string, string | number | boolean | null | undefined>;

interface Envelope<T> {
  ok?: boolean;
  data?: T;
  meta?: Meta;
  error?: { code?: string; message?: string; details?: unknown };
}

const REQUEST_TIMEOUT_MS = 20_000;
export const MAX_PAGE = 500; // EXTERNAL_API_MAX_PAGE_SIZE on the backend

export class ExternalApi {
  readonly base: string;
  private readonly headers: Record<string, string>;

  constructor(env: ExternalApiEnv) {
    const key = typeof env.COLAB_API_KEY === "string" ? env.COLAB_API_KEY.trim() : "";
    if (!key) throw new ExternalApiError("COLAB_API_KEY secret is not set", 503, "MISCONFIGURED");
    this.base = apiOrigin(env) + EXTERNAL_API_PATH;
    this.headers = { "x-api-key": key, accept: "application/json" };
    const org = typeof env.COLAB_ORG_ID === "string" ? env.COLAB_ORG_ID.trim() : "";
    if (org) this.headers["x-org-id"] = org;
  }

  private url(path: string, params?: Params): string {
    const u = new URL(this.base + path);
    for (const [k, v] of Object.entries(params ?? {})) {
      if (v === undefined || v === null || v === "") continue;
      u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  private async call<T>(method: "GET" | "POST" | "DELETE", path: string, params?: Params, body?: unknown): Promise<{ data: T; meta?: Meta }> {
    let res: Response;
    try {
      res = await fetch(this.url(path, params), {
        method,
        headers: body === undefined ? this.headers : { ...this.headers, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      throw new ExternalApiError(`external API unreachable: ${String(e).slice(0, 150)}`, 503, "UPSTREAM_UNREACHABLE");
    }
    const env = (await res.json().catch(() => ({}))) as Envelope<T>;
    if (res.ok && env.ok !== false) return { data: env.data as T, meta: env.meta };
    const code = env.error?.code || `HTTP_${res.status}`;
    const message = env.error?.message || res.statusText || "error";
    // 401 = OUR key is unknown/revoked/expired → a deployment problem, not the caller's.
    if (res.status === 401) throw new ExternalApiError(`external API rejected COLAB_API_KEY: ${message}`, 503, "MISCONFIGURED");
    if (res.status === 429) throw new ExternalApiError(message, 429, "RATE_LIMITED", res.headers.get("retry-after") ?? "5");
    if (res.status >= 500) throw new ExternalApiError(`external API ${res.status}: ${message}`, 503, code);
    throw new ExternalApiError(message, res.status, code);
  }

  get<T>(path: string, params?: Params) { return this.call<T>("GET", path, params); }
  post<T>(path: string, body: unknown, params?: Params) { return this.call<T>("POST", path, params, body); }

  /** GET that turns a 404 into null (row outside the key's organization, or gone). */
  async maybe<T>(path: string, params?: Params): Promise<T | null> {
    try {
      return (await this.get<T>(path, params)).data;
    } catch (e) {
      if (e instanceof ExternalApiError && e.status === 404) return null;
      throw e;
    }
  }

  /** Follow meta.nextOffset until hasMore is false (or `maxPages` is reached). */
  async list<T>(path: string, params?: Params, opts: { maxPages?: number; limit?: number } = {}): Promise<T[]> {
    const limit = Math.min(MAX_PAGE, Math.max(1, opts.limit ?? MAX_PAGE));
    const maxPages = Math.max(1, opts.maxPages ?? 20);
    const out: T[] = [];
    let offset = 0;
    for (let page = 0; page < maxPages; page++) {
      const { data, meta } = await this.get<T[]>(path, { ...params, limit, offset });
      out.push(...(Array.isArray(data) ? data : []));
      if (!meta?.hasMore || meta.nextOffset === null || meta.nextOffset === undefined) break;
      offset = meta.nextOffset;
    }
    return out;
  }
}

/** Liveness of the External API itself (no key needed): GET /api/external/v1/health. */
export async function externalHealth(env: ExternalApiEnv): Promise<{ ok: boolean; status: number; body?: unknown; error?: string }> {
  try {
    const res = await fetch(apiOrigin(env) + EXTERNAL_API_PATH + "/health", { signal: AbortSignal.timeout(8_000) });
    const body = await res.json().catch(() => undefined);
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    return { ok: false, status: 0, error: String(e).slice(0, 150) };
  }
}
