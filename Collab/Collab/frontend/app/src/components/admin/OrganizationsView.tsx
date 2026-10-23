import React, { useEffect, useState } from "react";
import { adminApi } from "../../lib/adminApi";
import { Select } from "../ui";

interface OrganizationsViewProps {
  onSelectOrg: (orgId: string) => void;
  onToast: (msg: string, type?: "success" | "error") => void;
}

export default function OrganizationsView({ onSelectOrg, onToast }: OrganizationsViewProps) {
  const [organizations, setOrganizations] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const limit = 15;

  const fetchOrgs = async () => {
    setLoading(true);
    const res = await adminApi.getOrganizations({
      q: search,
      status,
      limit,
      offset: page * limit,
    });
    if (res.ok && res.data) {
      setOrganizations(res.data.organizations || []);
      setTotal(res.data.total || 0);
    } else {
      onToast(res.error || "Failed to load organizations", "error");
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchOrgs();
  }, [search, status, page]);

  return (
    <div className="adm-panel">
      <div className="adm-panel-header">
        <h3 className="adm-panel-title">
          <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
            <path d="M3 21h18M3 7v14M21 7v14M6 11h4M6 15h4M14 11h4M14 15h4M9 3h6v4H9z" />
          </svg>
          Organizations Directory ({total})
        </h3>
        <div className="adm-panel-toolbar">
          <input
            type="text"
            className="adm-input"
            placeholder="Search by name, slug, or ID..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
            style={{ width: 240 }}
          />
          <Select
            className="adm-select"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(0);
            }}
          >
            <option value="all">All Statuses</option>
            <option value="active">Active</option>
            <option value="suspended">Suspended</option>
            <option value="archived">Archived</option>
          </Select>
          <button className="adm-btn adm-btn-secondary" onClick={fetchOrgs} title="Refresh list">
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
              <th>Organization</th>
              <th>Status</th>
              <th>Members</th>
              <th>Online</th>
              <th>Meetings</th>
              <th>Owner</th>
              <th>Created Date</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={8} style={{ textAlign: "center", padding: 36, color: "var(--adm-text-muted)" }}>
                  Loading organizations...
                </td>
              </tr>
            ) : organizations.length ? (
              organizations.map((org) => (
                <tr key={org.id}>
                  <td>
                    <div style={{ fontWeight: 600, color: "#fff", display: "flex", alignItems: "center", gap: 8 }}>
                      <span
                        style={{
                          width: 28,
                          height: 28,
                          borderRadius: 6,
                          background: "var(--adm-surface-3)",
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontSize: 12,
                          fontWeight: 700,
                          color: "var(--adm-primary)",
                        }}
                      >
                        {org.name.slice(0, 2).toUpperCase()}
                      </span>
                      <div>
                        <div>{org.name}</div>
                        <div style={{ fontSize: 11, color: "var(--adm-text-subtle)" }}>slug: {org.slug}</div>
                      </div>
                    </div>
                  </td>
                  <td>
                    <span
                      className={`adm-badge ${
                        org.status === "active"
                          ? "adm-badge-success"
                          : org.status === "suspended"
                          ? "adm-badge-danger"
                          : "adm-badge-neutral"
                      }`}
                    >
                      {org.status}
                    </span>
                  </td>
                  <td>
                    <span style={{ fontWeight: 600 }}>{org.totalMembers}</span>
                  </td>
                  <td>
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                        color: org.onlineMembers > 0 ? "var(--adm-success)" : "var(--adm-text-subtle)",
                      }}
                    >
                      <span className={`adm-presence-dot ${org.onlineMembers > 0 ? "online" : "offline"}`} />
                      {org.onlineMembers}
                    </span>
                  </td>
                  <td>
                    <span className="adm-badge adm-badge-info">{org.totalMeetings}</span>
                  </td>
                  <td>
                    <div style={{ fontSize: 12.5 }}>{org.ownerName || "No Owner"}</div>
                    <div style={{ fontSize: 11, color: "var(--adm-text-subtle)" }}>{org.ownerEmail || "—"}</div>
                  </td>
                  <td>
                    <div style={{ fontSize: 12, color: "var(--adm-text-muted)" }}>
                      {new Date(org.createdAt).toLocaleDateString([], {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                      })}
                    </div>
                  </td>
                  <td>
                    <button
                      className="adm-btn adm-btn-primary adm-btn-sm"
                      onClick={() => onSelectOrg(org.id)}
                    >
                      Manage
                    </button>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={8}>
                  <div className="adm-empty">
                    <div className="adm-empty-title">No organizations found</div>
                    <div className="adm-empty-desc">Try modifying your search query or status filter.</div>
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
          Showing {organizations.length ? page * limit + 1 : 0} to {Math.min((page + 1) * limit, total)} of {total} organizations
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
