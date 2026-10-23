import React, { useEffect, useState } from "react";
import { adminApi } from "../../lib/adminApi";

interface OnlineUsersViewProps {
  onSelectMeeting?: (meetingId: string) => void;
  onToast: (msg: string, type?: "success" | "error") => void;
}

export default function OnlineUsersView({ onSelectMeeting, onToast }: OnlineUsersViewProps) {
  const [users, setUsers] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const limit = 25;

  const fetchOnlineUsers = async (showLoading = false) => {
    if (showLoading) setLoading(true);
    const res = await adminApi.getOnlineUsers({
      q: search,
      limit,
      offset: page * limit,
    });
    if (res.ok && res.data) {
      setUsers(res.data.users || []);
      setTotal(res.data.total || 0);
    } else if (showLoading) {
      onToast(res.error || "Failed to load online users", "error");
    }
    if (showLoading) setLoading(false);
  };

  useEffect(() => {
    fetchOnlineUsers(true);
  }, [search, page]);

  // Auto-refresh interval (every 10s)
  useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(() => {
      fetchOnlineUsers(false);
    }, 10000);
    return () => clearInterval(timer);
  }, [autoRefresh, search, page]);

  return (
    <div className="adm-panel">
      <div className="adm-panel-header">
        <h3 className="adm-panel-title">
          <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 6v6l4 2" />
          </svg>
          Currently Online Users ({total})
        </h3>
        <div className="adm-panel-toolbar">
          <input
            type="text"
            className="adm-input"
            placeholder="Search online users..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
            style={{ width: 220 }}
          />
          <button
            className={`adm-btn ${autoRefresh ? "adm-btn-primary" : "adm-btn-secondary"}`}
            onClick={() => setAutoRefresh(!autoRefresh)}
            title={autoRefresh ? "Live polling is ON (every 10s)" : "Live polling is paused"}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: autoRefresh ? "var(--adm-success)" : "var(--adm-text-subtle)",
                display: "inline-block",
              }}
            />
            {autoRefresh ? "Live Polling ON" : "Polling Paused"}
          </button>
          <button className="adm-btn adm-btn-secondary" onClick={() => fetchOnlineUsers(true)} title="Manual refresh">
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
              <th>User</th>
              <th>Status</th>
              <th>Organizations</th>
              <th>Current Meeting</th>
              <th>Last Active</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={5} style={{ textAlign: "center", padding: 36, color: "var(--adm-text-muted)" }}>
                  Loading online users...
                </td>
              </tr>
            ) : users.length ? (
              users.map((u) => (
                <tr key={u.userId}>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <div
                        style={{
                          width: 34,
                          height: 34,
                          borderRadius: "50%",
                          background: u.color || "var(--adm-primary)",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          color: "#fff",
                          fontWeight: 700,
                          fontSize: 13,
                        }}
                      >
                        {u.initials || u.name.slice(0, 2).toUpperCase()}
                      </div>
                      <div>
                        <div style={{ fontWeight: 600, color: "#fff" }}>{u.name}</div>
                        <div style={{ fontSize: 11.5, color: "var(--adm-text-subtle)" }}>{u.email}</div>
                      </div>
                    </div>
                  </td>
                  <td>
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                        fontSize: 12.5,
                        fontWeight: 600,
                      }}
                    >
                      <span className="adm-presence-dot online" />
                      <span style={{ color: "var(--adm-success)" }}>
                        {u.presence === "on" ? "Active / Online" : u.presence}
                      </span>
                    </span>
                  </td>
                  <td>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                      {u.organizations?.length ? (
                        u.organizations.map((orgName: string, idx: number) => (
                          <span key={idx} className="adm-badge adm-badge-info">
                            {orgName}
                          </span>
                        ))
                      ) : (
                        <span style={{ fontSize: 12, color: "var(--adm-text-subtle)" }}>None</span>
                      )}
                    </div>
                  </td>
                  <td>
                    {u.currentMeeting ? (
                      <span
                        className="adm-badge adm-badge-warning"
                        style={{ cursor: onSelectMeeting ? "pointer" : "default" }}
                        onClick={() => onSelectMeeting && onSelectMeeting(u.currentMeeting.id)}
                        title="Click to view meeting"
                      >
                        🎥 In Meeting: {u.currentMeeting.title}
                      </span>
                    ) : (
                      <span style={{ color: "var(--adm-text-subtle)", fontSize: 12 }}>Not in meeting</span>
                    )}
                  </td>
                  <td>
                    <div style={{ fontSize: 12, color: "var(--adm-text-muted)" }}>
                      {u.lastSeen
                        ? new Date(u.lastSeen).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
                        : "Just now"}
                    </div>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={5}>
                  <div className="adm-empty">
                    <div className="adm-empty-title">No online users found</div>
                    <div className="adm-empty-desc">There are currently no users logged in and reporting online presence.</div>
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
          Showing {users.length ? page * limit + 1 : 0} to {Math.min((page + 1) * limit, total)} of {total} online users
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
