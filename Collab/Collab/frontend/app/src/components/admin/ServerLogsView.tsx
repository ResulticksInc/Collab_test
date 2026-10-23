import React, { useEffect, useState } from "react";
import { adminApi } from "../../lib/adminApi";
import { Select } from "../ui";

interface ServerLogsViewProps {
  onToast: (msg: string, type?: "success" | "error") => void;
}

// Insights & Governance → Server Logs: every platform failure the backend has
// recorded (error_logs — backend, process, socket and frontend-reported errors,
// de-duplicated by fingerprint with an occurrence count). Read-only listing;
// a row expands to show the stack and request context.

const LEVEL_BADGE: Record<string, string> = {
  fatal: "adm-badge-danger",
  error: "adm-badge-danger",
  warn: "adm-badge-warning",
};
const DOMAIN_LABEL: Record<string, string> = {
  infrastructure: "Infrastructure",
  application: "Application",
  external: "External / 3rd-party",
  client: "Client",
};
const DOMAIN_BADGE: Record<string, string> = {
  infrastructure: "adm-badge-danger",
  application: "adm-badge-info",
  external: "adm-badge-warning",
  client: "adm-badge-neutral",
};

function fmt(ts: any): string {
  if (!ts) return "—";
  const d = new Date(ts);
  return isNaN(d.getTime()) ? String(ts) : d.toLocaleString([], { dateStyle: "short", timeStyle: "medium" });
}

export default function ServerLogsView({ onToast }: ServerLogsViewProps) {
  const [logs, setLogs] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [occurrences, setOccurrences] = useState(0);
  const [bySeverity, setBySeverity] = useState<Record<string, number>>({});
  const [bySource, setBySource] = useState<Record<string, number>>({});
  const [search, setSearch] = useState("");
  const [level, setLevel] = useState("all");
  const [source, setSource] = useState("all");
  const [status, setStatus] = useState("all");
  const [range, setRange] = useState("7d");
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [push, setPush] = useState<any>(null);
  const limit = 50;

  // Boot-state lines ("[fcm] configured", "[apns] VoIP push configured") only
  // ever go to the container's stdout. The readiness probe exposes the same
  // facts live, so show them here instead of asking anyone to grep logs.
  const fetchPush = async () => {
    const res = await adminApi.getPushStatus();
    setPush(res.ok ? res.data : { unavailable: true, error: res.error });
  };

  const fetchLogs = async () => {
    setLoading(true);
    const res = await adminApi.getServerLogs({ q: search, level, source, status, range, limit, offset: page * limit });
    if (res.ok && res.data) {
      setLogs(res.data.logs || []);
      setTotal(res.data.total || 0);
      setOccurrences(res.data.occurrences || 0);
      setBySeverity(res.data.bySeverity || {});
      setBySource(res.data.bySource || {});
    } else {
      onToast(res.error || "Failed to load server logs", "error");
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchLogs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, level, source, status, range, page]);
  useEffect(() => {
    fetchPush();
  }, []);

  const resetPage = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setPage(0);
  };

  const chip = (label: string, n: number | undefined, cls = "adm-badge-neutral") =>
    n ? (
      <span key={label} className={`adm-badge ${cls}`} style={{ marginRight: 6 }}>
        {label}: {n}
      </span>
    ) : null;

  return (
    <div className="adm-panel">
      <div className="adm-panel-header">
        <h3 className="adm-panel-title">
          <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
            <rect x="2" y="3" width="20" height="8" rx="2" />
            <rect x="2" y="13" width="20" height="8" rx="2" />
            <line x1="6" y1="7" x2="6.01" y2="7" />
            <line x1="6" y1="17" x2="6.01" y2="17" />
          </svg>
          Platform Failures — Server Logs ({total})
        </h3>
        <div className="adm-panel-toolbar">
          <input
            type="text"
            className="adm-input"
            placeholder="Search message, route, code, user email..."
            value={search}
            onChange={(e) => resetPage(setSearch)(e.target.value)}
            style={{ width: 260 }}
          />
          <Select className="adm-select" style={{ width: 160, flex: "0 0 auto" }} value={range} onChange={(e) => resetPage(setRange)(e.target.value)}>
            <option value="today">Today</option>
            <option value="24h">Last 24 hours</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="all">All time</option>
          </Select>
          <Select className="adm-select" style={{ width: 160, flex: "0 0 auto" }} value={level} onChange={(e) => resetPage(setLevel)(e.target.value)}>
            <option value="all">All levels</option>
            <option value="fatal">Fatal</option>
            <option value="error">Error</option>
            <option value="warn">Warning</option>
          </Select>
          <Select className="adm-select" style={{ width: 160, flex: "0 0 auto" }} value={source} onChange={(e) => resetPage(setSource)(e.target.value)}>
            <option value="all">All sources</option>
            <option value="backend">Backend</option>
            <option value="process">Process</option>
            <option value="socket">Socket</option>
            <option value="frontend">Frontend</option>
          </Select>
          <Select className="adm-select" style={{ width: 160, flex: "0 0 auto" }} value={status} onChange={(e) => resetPage(setStatus)(e.target.value)}>
            <option value="all">Open + resolved</option>
            <option value="open">Open</option>
            <option value="resolved">Resolved</option>
            <option value="ignored">Ignored</option>
          </Select>
          <button className="adm-btn adm-btn-secondary" onClick={() => { fetchLogs(); fetchPush(); }}>
            <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
              <path d="M23 4v6h-6M1 20v-6h6" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
            Refresh
          </button>
        </div>
      </div>

      {/* Live push channels — what the backend's boot log would say, read from the readiness probe */}
      <div style={{ padding: "10px 16px 0", display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, fontSize: 12, color: "var(--adm-text-muted)" }}>
        <span style={{ marginRight: 6 }}>Push channels:</span>
        {push == null ? (
          <span>checking…</span>
        ) : push.unavailable ? (
          <span className="adm-badge adm-badge-neutral">readiness probe unavailable{push.error ? ` (${push.error})` : ""}</span>
        ) : (
          <>
            {([
              ["webPush", "Web push (VAPID)"],
              ["fcm", "FCM · Android + iOS messages"],
              ["apnsVoip", "APNs VoIP · iOS call rings"],
            ] as const).map(([k, label]) => (
              <span key={k} className={`adm-badge ${push.configured?.[k] ? "adm-badge-success" : "adm-badge-danger"}`} title={label}>
                {label}: {push.configured?.[k] ? "on" : "off"}
              </span>
            ))}
            {push.degraded ? (
              <span className="adm-badge adm-badge-warning" title={push.error || ""}>
                calls-only state{push.error ? ` — ${push.error}` : ""}
              </span>
            ) : null}
          </>
        )}
      </div>

      {/* Summary strip: distinct failures vs raw occurrences, split by level and source */}
      <div style={{ padding: "10px 16px", display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, fontSize: 12, color: "var(--adm-text-muted)" }}>
        <span style={{ marginRight: 10 }}>
          <strong style={{ color: "#fff" }}>{total}</strong> distinct failure{total === 1 ? "" : "s"} ·{" "}
          <strong style={{ color: "#fff" }}>{occurrences}</strong> occurrence{occurrences === 1 ? "" : "s"}
        </span>
        {chip("Fatal", bySeverity.fatal, "adm-badge-danger")}
        {chip("Error", bySeverity.error, "adm-badge-danger")}
        {chip("Warn", bySeverity.warn, "adm-badge-warning")}
        {Object.entries(bySource).map(([k, n]) => chip(k, n))}
      </div>

      <div className="adm-table-wrap">
        <table className="adm-table">
          <thead>
            <tr>
              <th style={{ width: 150 }}>Last seen</th>
              <th>Level</th>
              <th>Source</th>
              <th>Owner</th>
              <th>Message</th>
              <th>Route</th>
              <th style={{ textAlign: "right" }}>Count</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={8} style={{ textAlign: "center", padding: 36, color: "var(--adm-text-muted)" }}>
                  Loading server logs...
                </td>
              </tr>
            ) : logs.length ? (
              logs.map((log) => {
                const expanded = open === log.id;
                return (
                  <React.Fragment key={log.id}>
                    <tr
                      onClick={() => setOpen(expanded ? null : log.id)}
                      style={{ cursor: "pointer" }}
                      title={expanded ? "Collapse" : "Show stack and request context"}
                    >
                      <td>
                        <div style={{ fontSize: 12, color: "var(--adm-text-muted)", whiteSpace: "nowrap" }}>{fmt(log.lastSeen)}</div>
                        <div style={{ fontSize: 11, color: "var(--adm-text-subtle)", whiteSpace: "nowrap" }}>first {fmt(log.firstSeen)}</div>
                      </td>
                      <td>
                        <span className={`adm-badge ${LEVEL_BADGE[log.level] || "adm-badge-neutral"}`}>{log.level}</span>
                      </td>
                      <td>
                        <span className="adm-badge adm-badge-neutral">{log.source}</span>
                      </td>
                      <td>
                        <span className={`adm-badge ${DOMAIN_BADGE[log.domain] || "adm-badge-neutral"}`}>
                          {DOMAIN_LABEL[log.domain] || log.domain}
                        </span>
                      </td>
                      <td>
                        <div
                          style={{
                            maxWidth: 360,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: expanded ? "normal" : "nowrap",
                            fontFamily: "monospace",
                            fontSize: 12,
                            color: "#fff",
                          }}
                          title={log.message}
                        >
                          {log.code ? <span style={{ color: "var(--adm-primary)" }}>[{log.code}] </span> : null}
                          {log.message}
                        </div>
                        {log.user ? (
                          <div style={{ fontSize: 11, color: "var(--adm-text-subtle)" }}>
                            {log.user.name || log.user.email || log.user.id}
                          </div>
                        ) : null}
                      </td>
                      <td>
                        <code style={{ fontSize: 11.5, color: "var(--adm-primary)" }}>{log.requestPath || "—"}</code>
                      </td>
                      <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{log.occurrences}</td>
                      <td>
                        <span
                          className={`adm-badge ${
                            log.status === "resolved" ? "adm-badge-success" : log.status === "ignored" ? "adm-badge-neutral" : "adm-badge-warning"
                          }`}
                        >
                          {log.status}
                        </span>
                      </td>
                    </tr>
                    {expanded ? (
                      <tr>
                        <td colSpan={8} style={{ background: "rgba(255,255,255,0.03)" }}>
                          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, padding: "8px 4px" }}>
                            <div>
                              <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--adm-text-subtle)", marginBottom: 4 }}>
                                Stack trace
                              </div>
                              <pre style={{ margin: 0, fontSize: 11, whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 280, overflow: "auto", color: "var(--adm-text-muted)" }}>
                                {log.stack || "No stack recorded."}
                              </pre>
                            </div>
                            <div>
                              <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--adm-text-subtle)", marginBottom: 4 }}>
                                Request context
                              </div>
                              <pre style={{ margin: 0, fontSize: 11, whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 280, overflow: "auto", color: "var(--adm-text-muted)" }}>
                                {JSON.stringify(
                                  {
                                    env: log.env,
                                    dependency: log.dependency,
                                    organizationId: log.organizationId,
                                    user: log.user,
                                    resolvedBy: log.resolvedBy,
                                    resolvedAt: log.resolvedAt,
                                    resolution: log.resolution,
                                    context: log.context,
                                  },
                                  null,
                                  2,
                                )}
                              </pre>
                            </div>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </React.Fragment>
                );
              })
            ) : (
              <tr>
                <td colSpan={8}>
                  <div className="adm-empty">
                    <div className="adm-empty-title">No server logs found</div>
                    <div className="adm-empty-desc">No platform failures matched the current filters.</div>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="adm-pagination">
        <div>
          Showing {logs.length ? page * limit + 1 : 0} to {Math.min((page + 1) * limit, total)} of {total} failures
        </div>
        <div className="adm-pagination-actions">
          <button className="adm-btn adm-btn-secondary adm-btn-sm" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
            Previous
          </button>
          <button className="adm-btn adm-btn-secondary adm-btn-sm" disabled={(page + 1) * limit >= total} onClick={() => setPage((p) => p + 1)}>
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
