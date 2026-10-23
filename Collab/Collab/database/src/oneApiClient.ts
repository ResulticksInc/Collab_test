// "One API" — structured-JSON DB-access gateway client (a DB-protection layer).
//
// The gateway accepts a STRUCTURED payload (NOT raw SQL): { db_type, database,
// table, columns, joins?, conditions?, limit?, offset?, order_by?, export } and
// converts it to a query against the live DB. So this is an EXPLICIT helper for
// the specific calls that fit the structured shape — it is NOT (and cannot be) a
// transparent drop-in for CoLab's SQL driver, because the structured format can't
// express FULLTEXT search, window functions (ROW_NUMBER), ON DUPLICATE KEY
// upserts, or FOR UPDATE transactions. CoLab's own complex queries stay on the
// direct MySQL pool; use this client only where a simple structured read/write
// suffices (or to reach shared company data via the gateway).
//
// Controlled by the ONE_API_ENABLED switch (OFF by default — the DB team flagged
// the gateway as a performance hit). request() throws when disabled or on error.
//
// ✅ CONTRACT CONFIRMED 2026-06-19 by probing the live gateway directly
// (scripts/oneapi-probe-insert.cjs + oneapi-crud-confirm.cjs):
//   • READ    — { table, columns?, conditions?, limit?, order_by? }. Filters via
//               `conditions: [{ column, operator, value }]` (operator optional →
//               defaults to "="); `where: {col: val}` also accepted.
//   • INSERT  — { table, action:"insert", values: {col: val} }  (NOT `data`).
//   • UPDATE  — { table, action:"update", values: {col: val}, conditions:[…] }.
//   • DELETE  — currently returns a server-side error ("'NoneType' … to_dict")
//               for every payload shape tried; treat as gateway-side TODO.
//   • Response — { status, records, data:[…] }; writes return
//               data:[{ status:"inserted"|"updated", affected_rows }].
//   • Auth: Authorization: Bearer <ONE_API_KEY> only if set (gateway accepts none).

export interface OneApiConfig {
  enabled: boolean;
  url: string;
  dbType: string;
  database: string;
  apiKey: string;
  timeoutMs: number;
}

export interface FetchPayload {
  table: string;
  columns?: string[];
  joins?: Array<{ type: string; table: string; on: string }>;
  conditions?: Array<{ column: string; operator?: string; value: any }>; // operator defaults to "="
  limit?: number;
  offset?: number;
  order_by?: string;
  export?: "json" | "csv";
}

// CONFIRMED write shape (see header). insert/update column values go in `values`
// (NOT `data` — that field is silently ignored by the gateway and inserts an
// empty row). `conditions` targets update/delete rows.
export interface MutatePayload {
  table: string;
  action: "insert" | "update" | "delete";
  values?: Record<string, any>; // insert/update column values
  conditions?: Array<{ column: string; operator?: string; value: any }>; // update/delete target (operator defaults to "=")
}

function ensureEnabled(cfg: OneApiConfig) {
  if (!cfg || !cfg.enabled) throw new Error("One API is disabled (ONE_API_ENABLED=false)");
  if (!cfg.url) throw new Error("ONE_API_URL is not set");
}

// Low-level: POST a structured payload to the gateway and return parsed rows.
// db_type/database are injected from config so callers pass only the operation.
export async function request(payload: Record<string, any>, cfg: OneApiConfig): Promise<{ rows: any[]; rowCount: number; raw: any }> {
  ensureEnabled(cfg);
  const fetchFn: any = (globalThis as any).fetch;
  if (typeof fetchFn !== "function")
    throw new Error("global fetch unavailable (Node 18+ required for One API)");
  const body = { db_type: cfg.dbType || "mysql", database: cfg.database || undefined, export: "json", ...payload };
  const doFetch = fetchFn(cfg.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const timeout = new Promise<never>((_, rej) =>
    setTimeout(() => rej(new Error("One API request timed out")), cfg.timeoutMs || 15000),
  );
  const res: any = await Promise.race([doFetch, timeout]);
  if (!res || !res.ok) throw new Error(`One API HTTP ${res ? res.status : "no-response"}`);
  const json = await res.json().catch(() => null);
  // Response shape varies by gateway version — accept a bare array or any of the
  // documented envelope keys. Mirrors the reference (aanswer) login route's
  // parsing (.data || .results || .rows || .values || .records) and keeps
  // .result for older gateway builds.
  let rows: any[] = [];
  if (Array.isArray(json)) rows = json;
  else if (json && Array.isArray(json.data)) rows = json.data;
  else if (json && Array.isArray(json.results)) rows = json.results;
  else if (json && Array.isArray(json.rows)) rows = json.rows;
  else if (json && Array.isArray(json.values)) rows = json.values;
  else if (json && Array.isArray(json.records)) rows = json.records;
  else if (json && Array.isArray(json.result)) rows = json.result;
  const affected = json && (json.affectedRows ?? json.rowCount);
  return { rows, rowCount: typeof affected === "number" ? affected : rows.length, raw: json };
}

// Structured READ (matches the shared sample payload).
export async function fetchData(payload: FetchPayload, cfg: OneApiConfig) {
  return request({ ...payload }, cfg);
}

// Structured WRITE (insert/update — values in `values`; delete is gateway-TODO).
export async function mutate(payload: MutatePayload, cfg: OneApiConfig) {
  return request({ ...payload }, cfg);
}
