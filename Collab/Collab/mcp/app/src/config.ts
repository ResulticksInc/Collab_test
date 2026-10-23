// Centralized MCP server configuration. The MCP server is a SELF-CONTAINED
// orchestration layer that talks to the existing CoLab backend over HTTP only
// (it never imports backend/database code — see .dependency-cruiser.cjs). It
// reads its own environment here and nowhere else.

function str(key: string, fallback: string): string {
  const v = process.env[key];
  return v == null || v === "" ? fallback : v;
}
function num(key: string, fallback: number): number {
  const v = Number(process.env[key]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}
function bool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v == null || v === "") return fallback;
  return v === "true" || v === "1" || v === "yes";
}

export const config = {
  // Identity advertised in the MCP `initialize` handshake.
  name: "colab-mcp",
  version: "1.0.0",
  // MCP wire protocol revision this server implements.
  protocolVersion: "2024-11-05",

  // Backend REST origin. In Docker compose set BACKEND_INTERNAL_URL=http://backend:4000.
  baseUrl: str(
    "COLAB_API_BASE_URL",
    str("BACKEND_INTERNAL_URL", "http://localhost:4000"),
  ),
  // API mount prefix (backend mounts every route under this — config.constants.api.prefix).
  apiPrefix: str("COLAB_API_PREFIX", "/api"),

  // HTTP transport listen port (multi-user / remote AI clients).
  port: num("COLAB_MCP_PORT", 4015),
  corsOrigin: str("COLAB_MCP_CORS_ORIGIN", "*"),

  // Default Bearer token for the stdio transport (single-user desktop clients
  // like Claude Desktop launch the server with this in the environment). The
  // HTTP transport ignores this and uses each request's Authorization header
  // (multi-user). Per-request `token` in a stdio message overrides it.
  serverToken: str("COLAB_MCP_TOKEN", ""),

  // Local JWT verification at the MCP boundary (defense-in-depth — the backend
  // ALSO verifies authoritatively on every call). HS256 against AUTH_JWT_SECRET.
  // When the secret is absent the boundary falls back to pass-through (presence/
  // shape check only); the backend remains the authoritative gate either way.
  jwtSecret: str("AUTH_JWT_SECRET", ""),
  verifyJwtLocally: bool("COLAB_MCP_VERIFY_JWT", true),

  // Gateway resilience.
  gatewayTimeoutMs: num("COLAB_MCP_TIMEOUT_MS", 15000),
  // Bound concurrent in-flight backend calls per process so a runaway client
  // can't saturate the backend pool through MCP.
  maxConcurrentCalls: num("COLAB_MCP_MAX_CONCURRENCY", 32),

  // Pagination ceilings — never let a tool/resource pull an unbounded dataset.
  defaultPageSize: 50,
  maxPageSize: num("COLAB_MCP_MAX_PAGE", 100),

  // Cap inbound text sizes (sanitization) so a tool argument can't be abused as
  // a giant payload tunnelled to the backend.
  maxStringLen: num("COLAB_MCP_MAX_STRING", 16000),
};

export type Config = typeof config;
