// Error taxonomy for the MCP server. Two layers:
//  1. JSON-RPC protocol errors (malformed request, unknown method/tool, invalid
//     params) — returned in the JSON-RPC `error` field.
//  2. Tool/gateway execution errors — surfaced to the model as a tool RESULT
//     with isError:true so it can self-correct, NOT as a transport error.
// In all cases we return a stable code + safe message. Stack traces and backend
// internals are NEVER exposed.

// Standard JSON-RPC 2.0 error codes (+ MCP conventions).
export const RpcCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

export class RpcError extends Error {
  code: number;
  data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}

// A failure from the backend gateway (HTTP/network/envelope). Carries a stable,
// client-safe code and message — derived from the backend's {ok:false,error}
// envelope where possible, otherwise a generic class.
export class GatewayError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 0) {
    super(message);
    this.name = "GatewayError";
    this.code = code;
    this.status = status;
  }
}

// Input validation failure (schema/sanitization). Aggregates field issues.
export class ValidationError extends Error {
  issues: string[];
  constructor(issues: string[]) {
    super("Input validation failed: " + issues.join("; "));
    this.name = "ValidationError";
    this.issues = issues;
  }
}

// Map ANY thrown value to a safe { code, message } the model can read. Never
// leaks stack traces or unexpected internals.
export function toSafeError(err: unknown): { code: string; message: string } {
  if (err instanceof ValidationError)
    return { code: "INVALID_INPUT", message: err.message };
  if (err instanceof GatewayError) {
    // Translate transport status to a friendly, actionable code.
    if (err.status === 401)
      return {
        code: "UNAUTHENTICATED",
        message: "Authentication failed or token expired.",
      };
    if (err.status === 403)
      return {
        code: "FORBIDDEN",
        message: "You do not have access to this resource.",
      };
    if (err.status === 404)
      return {
        code: "NOT_FOUND",
        message: err.message || "Resource not found.",
      };
    if (err.status === 429)
      return {
        code: "RATE_LIMITED",
        message: "Too many requests — slow down and retry.",
      };
    if (err.status === 503 || err.code === "UNAVAILABLE")
      return {
        code: "UNAVAILABLE",
        message: err.message || "Service temporarily unavailable.",
      };
    return {
      code: err.code || "BACKEND_ERROR",
      message: err.message || "Backend request failed.",
    };
  }
  if (err instanceof RpcError)
    return { code: "PROTOCOL_ERROR", message: err.message };
  // Unknown/unexpected — return a generic message, NOT the raw error text.
  return { code: "INTERNAL_ERROR", message: "An unexpected error occurred." };
}
