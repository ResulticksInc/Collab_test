// Structured audit + diagnostic logging for the MCP server.
//
// CRITICAL: everything is written to STDERR. On the stdio transport, STDOUT is
// the JSON-RPC protocol channel — any stray byte there corrupts the stream. So
// no module may ever console.log to stdout; they log through here.
//
// Audit records capture WHO did WHAT, WHEN, on WHICH resource, with what
// OUTCOME and DURATION — never message bodies / file contents / token values.

export type AuditEvent = {
  event:
    | "tool.call"
    | "resource.read"
    | "prompt.get"
    | "rpc"
    | "auth"
    | "server";
  // Actor identity (from the verified JWT). Tokens themselves are never logged.
  user?: string;
  tenant?: string;
  // The tool / resource / method name.
  name?: string;
  // A non-sensitive resource identifier (id, not content) when applicable.
  resource?: string;
  ok: boolean;
  errorCode?: string;
  durationMs?: number;
  client?: string;
  meta?: Record<string, unknown>;
};

function emit(
  level: "info" | "warn" | "error",
  record: Record<string, unknown>,
) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    ...record,
  });
  process.stderr.write(line + "\n");
}

export const log = {
  audit(e: AuditEvent) {
    emit(e.ok ? "info" : "warn", { kind: "audit", ...e });
  },
  info(msg: string, meta?: Record<string, unknown>) {
    emit("info", { kind: "log", msg, ...(meta || {}) });
  },
  warn(msg: string, meta?: Record<string, unknown>) {
    emit("warn", { kind: "log", msg, ...(meta || {}) });
  },
  error(msg: string, meta?: Record<string, unknown>) {
    emit("error", { kind: "log", msg, ...(meta || {}) });
  },
};

// Truncate/normalize a value into a safe single-token resource identifier for
// audit (defends against accidentally logging a long/sensitive string).
export function safeId(v: unknown): string | undefined {
  if (v == null) return undefined;
  const s = String(v);
  return s.length > 64 ? s.slice(0, 64) : s;
}
