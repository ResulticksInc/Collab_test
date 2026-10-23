import crypto from "node:crypto";
import { config } from "../config";
import { RpcError, RpcCode } from "../errors";
import type { McpContext } from "../types";

// MCP-boundary authentication. CoLab issues HS256 JWTs (AUTH_JWT_SECRET) whose
// payload is { sub: userId, name, deviceId, ... }. We do DEFENSE-IN-DEPTH here:
//   • verifyJwtLocally + secret present → verify signature + expiry locally and
//     reject bad tokens before any backend round-trip.
//   • otherwise → presence/shape check only (decode for audit context); the
//     backend still verifies authoritatively on every gateway call.
// Either way the backend remains the source of truth for authorization.

function b64urlToBuf(s: string): Buffer {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64");
}

function decodePayload(token: string): Record<string, any> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(b64urlToBuf(parts[1]).toString("utf8"));
  } catch {
    return null;
  }
}

// Constant-time HS256 signature check.
function verifySignature(token: string, secret: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(parts[0] + "." + parts[1])
    .digest();
  const got = b64urlToBuf(parts[2]);
  if (got.length !== expected.length) return false;
  return crypto.timingSafeEqual(got, expected);
}

// Resolve a request's auth into an McpContext, or throw an RpcError(InvalidParams)
// — surfaced as a clean 401-equivalent. `tenantId` is forwarded opaquely (CoLab
// is single-workspace today; this keeps the boundary multi-tenant-ready).
export function resolveContext(input: {
  token?: string;
  tenantId?: string;
  requestId?: string | number;
  clientInfo?: { name?: string; version?: string };
}): McpContext {
  const token = (input.token || config.serverToken || "").trim();
  if (!token)
    throw new RpcError(
      RpcCode.InvalidParams,
      "Authentication required: no bearer token provided.",
    );

  const payload = decodePayload(token);
  if (!payload || !payload.sub)
    throw new RpcError(
      RpcCode.InvalidParams,
      "Authentication failed: malformed token.",
    );

  if (config.verifyJwtLocally && config.jwtSecret) {
    if (!verifySignature(token, config.jwtSecret))
      throw new RpcError(
        RpcCode.InvalidParams,
        "Authentication failed: invalid token signature.",
      );
    if (payload.exp && Date.now() / 1000 > Number(payload.exp))
      throw new RpcError(
        RpcCode.InvalidParams,
        "Authentication failed: token expired.",
      );
  }

  return {
    token,
    userId: String(payload.sub),
    name: payload.name ? String(payload.name) : undefined,
    deviceId: payload.deviceId ? String(payload.deviceId) : undefined,
    // Prefer an explicit tenant claim if the token ever carries one; else the
    // transport-supplied tenant; else undefined (single-workspace default).
    tenantId: payload.tenantId ? String(payload.tenantId) : input.tenantId,
    requestId: input.requestId,
    clientInfo: input.clientInfo,
  };
}
