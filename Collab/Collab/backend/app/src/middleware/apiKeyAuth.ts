// API-key authentication for the External Data API (/api/external/v1).
//
// The caller presents a key minted by an org admin or the admin portal (or a
// static EXTERNAL_API_KEYS entry) in ONE of:
//   X-API-Key: colab_…                  (preferred)
//   Authorization: ApiKey colab_…
//   Authorization: Bearer colab_…       (only keys with the colab_ prefix — a
//                                        user JWT is not accepted here)
//
// On success req.apiKey = { id, name, orgId, scopes, platform } and
// req.tenant = { orgId } — the organization every data query is pinned to:
//   • an ORG key is always pinned to its own organization;
//   • a PLATFORM key sees every organization, or ONE when it sends X-Org-Id
//     (or ?orgId=) — an org that must exist.
// Unknown / revoked / expired keys all 401 identically.
import { config, fail } from "../platform";
import * as svc from "../services/externalApiService";

const KEY_PREFIX = "colab_";

export function presentedKey(req: any): string | null {
  const x = String(req.headers["x-api-key"] || "").trim();
  if (x) return x;
  const h = String(req.headers.authorization || "").trim();
  if (/^ApiKey\s+/i.test(h)) return h.replace(/^ApiKey\s+/i, "").trim();
  if (/^Bearer\s+/i.test(h)) {
    const v = h.replace(/^Bearer\s+/i, "").trim();
    if (v.startsWith(KEY_PREFIX)) return v;
  }
  return null;
}

export default async function apiKeyAuth(req: any, res: any, next: any) {
  if (!config.externalApi.enabled)
    return res.status(404).json(fail("NOT_FOUND", "The External Data API is disabled (EXTERNAL_API_ENABLED=false)"));
  const raw = presentedKey(req);
  if (!raw)
    return res
      .status(401)
      .json(fail("UNAUTHORIZED", "Missing API key. Send it as X-API-Key: colab_… (or Authorization: ApiKey colab_…)"));
  let key: svc.ResolvedKey | null = null;
  try {
    key = await svc.verifyKey(raw);
  } catch (e: any) {
    if (e && e.status) return res.status(e.status).json(fail(e.code || "UNAVAILABLE", e.message));
    throw e;
  }
  if (!key) return res.status(401).json(fail("UNAUTHORIZED", "Invalid, revoked or expired API key"));
  // Tenant pinning. Only a platform key may choose an organization per request.
  let orgId: string | null = key.orgId;
  if (key.platform) {
    const asked = String(req.headers["x-org-id"] || req.query?.orgId || "").trim();
    if (asked) {
      if (asked.length > 36) return res.status(400).json(fail("BAD_REQUEST", "X-Org-Id is not a valid organization id"));
      if (!(await svc.orgExists(asked))) return res.status(404).json(fail("NOT_FOUND", "Organization not found"));
      orgId = asked;
    }
  }
  req.apiKey = key;
  req.tenant = { orgId };
  return next();
}

// Per-route scope guard: 403 with the scope the key is missing, so an
// integrator can ask for exactly that scope.
export function requireScope(scope: svc.Scope) {
  return (req: any, res: any, next: any) => {
    if (!req.apiKey || !svc.hasScope(req.apiKey, scope))
      return res.status(403).json(fail("FORBIDDEN_SCOPE", `This API key does not have the "${scope}" scope`, { required: scope }));
    return next();
  };
}
