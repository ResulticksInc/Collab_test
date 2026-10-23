import React, { useEffect, useState } from "react";
import { adminApi } from "../../lib/adminApi";
import { Select } from "../ui";

interface AuditLogsViewProps {
  onToast: (msg: string, type?: "success" | "error") => void;
}

export default function AuditLogsView({ onToast }: AuditLogsViewProps) {
  const [logs, setLogs] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");
  const [actionFilter, setActionFilter] = useState("all");
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const limit = 25;

  const fetchLogs = async () => {
    setLoading(true);
    const res = await adminApi.getAuditLogs({
      q: search,
      action: actionFilter,
      limit,
      offset: page * limit,
    });
    if (res.ok && res.data) {
      setLogs(res.data.logs || []);
      setTotal(res.data.total || 0);
    } else {
      onToast(res.error || "Failed to load audit logs", "error");
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchLogs();
  }, [search, actionFilter, page]);

  return (
    <div className="adm-panel">
      <div className="adm-panel-header">
        <h3 className="adm-panel-title">
          <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          </svg>
          System & Administrative Audit Trail ({total})
        </h3>
        <div className="adm-panel-toolbar">
          <input
            type="text"
            className="adm-input"
            placeholder="Search action, actor, target..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
            style={{ width: 240 }}
          />
          <Select
            className="adm-select"
            value={actionFilter}
            onChange={(e) => {
              setActionFilter(e.target.value);
              setPage(0);
            }}
          >
            <option value="all">All Actions</option>
            <option value="admin.login">Admin Logins</option>
            <option value="meeting.member">Meeting Changes</option>
            <option value="org.">Organization Events</option>
          </Select>
          <button className="adm-btn adm-btn-secondary" onClick={fetchLogs}>
            <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
              <path d="M23 4v6h-6M1 20v-6h6" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
            Refresh
          </button>
        </div>
      </div>

      <div className="adm-table-wrap">
        <table className="adm-table">
          <thead>
            <tr>
              <th>Timestamp</th>
              <th>Action</th>
              <th>Actor</th>
              <th>Target</th>
              <th>Organization</th>
              <th>Metadata Details</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={6} style={{ textAlign: "center", padding: 36, color: "var(--adm-text-muted)" }}>
                  Loading audit logs...
                </td>
              </tr>
            ) : logs.length ? (
              logs.map((log) => (
                <tr key={log.id}>
                  <td>
                    <div style={{ fontSize: 12, color: "var(--adm-text-muted)", whiteSpace: "nowrap" }}>
                      {new Date(log.createdAt).toLocaleString([], { dateStyle: "short", timeStyle: "medium" })}
                    </div>
                  </td>
                  <td>
                    <span
                      className={`adm-badge ${
                        log.action.includes("failed") || log.action.includes("remove") || log.action.includes("delete")
                          ? "adm-badge-danger"
                          : log.action.includes("login") || log.action.includes("add") || log.action.includes("create")
                          ? "adm-badge-success"
                          : "adm-badge-info"
                      }`}
                    >
                      {log.action}
                    </span>
                  </td>
                  <td>
                    <div style={{ fontWeight: 600, color: "#fff" }}>{log.actor}</div>
                  </td>
                  <td>
                    <code style={{ fontSize: 11.5, color: "var(--adm-primary)" }}>{log.target || "—"}</code>
                  </td>
                  <td>
                    {log.organizationName ? (
                      <span className="adm-badge adm-badge-neutral">{log.organizationName}</span>
                    ) : (
                      <span style={{ fontSize: 11.5, color: "var(--adm-text-subtle)" }}>Global / System</span>
                    )}
                  </td>
                  <td>
                    <div
                      style={{
                        fontSize: 11.5,
                        color: "var(--adm-text-subtle)",
                        maxWidth: 320,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        fontFamily: "monospace",
                      }}
                      title={JSON.stringify(log.meta, null, 2)}
                    >
                      {JSON.stringify(log.meta)}
                    </div>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={6}>
                  <div className="adm-empty">
                    <div className="adm-empty-title">No audit logs found</div>
                    <div className="adm-empty-desc">No events matched your search query.</div>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination Footer */}
      <div className="adm-pagination">
        <div>
          Showing {logs.length ? page * limit + 1 : 0} to {Math.min((page + 1) * limit, total)} of {total} events
        </div>
        <div className="adm-pagination-actions">
          <button
            className="adm-btn adm-btn-secondary adm-btn-sm"
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            Previous
          </button>
          <button
            className="adm-btn adm-btn-secondary adm-btn-sm"
            disabled={(page + 1) * limit >= total}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
