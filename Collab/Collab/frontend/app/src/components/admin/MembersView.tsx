import React, { useEffect, useState } from "react";
import { adminApi } from "../../lib/adminApi";
import { Select } from "../ui";

interface MembersViewProps {
  onSelectOrg?: (orgId: string) => void;
  onToast: (msg: string, type?: "success" | "error") => void;
}

export default function MembersView({ onSelectOrg, onToast }: MembersViewProps) {
  const [members, setMembers] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [organizations, setOrganizations] = useState<any[]>([]);
  const [search, setSearch] = useState("");
  const [selectedOrg, setSelectedOrg] = useState("all");
  const [selectedPresence, setSelectedPresence] = useState("all");
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const limit = 20;

  // Fetch orgs for dropdown filter
  useEffect(() => {
    adminApi.getOrganizations({ limit: 100 }).then((res) => {
      if (res.ok && res.data) {
        setOrganizations(res.data.organizations || []);
      }
    });
  }, []);

  const fetchMembers = async () => {
    setLoading(true);
    const res = await adminApi.getMembers({
      q: search,
      organizationId: selectedOrg,
      presence: selectedPresence,
      limit,
      offset: page * limit,
    });
    if (res.ok && res.data) {
      setMembers(res.data.members || []);
      setTotal(res.data.total || 0);
    } else {
      onToast(res.error || "Failed to load members", "error");
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchMembers();
  }, [search, selectedOrg, selectedPresence, page]);

  return (
    <div className="adm-panel">
      <div className="adm-panel-header">
        <h3 className="adm-panel-title">
          <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
          </svg>
          Organization Members Directory ({total})
        </h3>
        <div className="adm-panel-toolbar">
          <input
            type="text"
            className="adm-input"
            placeholder="Search by name, email, or user ID..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
            style={{ width: 250 }}
          />
          <Select
            className="adm-select"
            value={selectedOrg}
            onChange={(e) => {
              setSelectedOrg(e.target.value);
              setPage(0);
            }}
          >
            <option value="all">All Organizations</option>
            {organizations.map((org) => (
              <option key={org.id} value={org.id}>
                {org.name}
              </option>
            ))}
          </Select>
          <Select
            className="adm-select"
            value={selectedPresence}
            onChange={(e) => {
              setSelectedPresence(e.target.value);
              setPage(0);
            }}
          >
            <option value="all">All Presence</option>
            <option value="online">Online</option>
            <option value="offline">Offline</option>
            <option value="away">Away</option>
            <option value="dnd">Do Not Disturb</option>
          </Select>
          <button className="adm-btn adm-btn-secondary" onClick={fetchMembers}>
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
              <th>Presence</th>
              <th>Organizations</th>
              <th>Meetings</th>
              <th>Last Seen</th>
              <th>Joined Date</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={6} style={{ textAlign: "center", padding: 36, color: "var(--adm-text-muted)" }}>
                  Loading members...
                </td>
              </tr>
            ) : members.length ? (
              members.map((m) => (
                <tr key={m.userId}>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <div
                        style={{
                          width: 34,
                          height: 34,
                          borderRadius: "50%",
                          background: m.color || "var(--adm-primary)",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          color: "#fff",
                          fontWeight: 700,
                          fontSize: 13,
                        }}
                      >
                        {m.initials || m.name.slice(0, 2).toUpperCase()}
                      </div>
                      <div>
                        <div style={{ fontWeight: 600, color: "#fff" }}>{m.name}</div>
                        <div style={{ fontSize: 11.5, color: "var(--adm-text-subtle)" }}>{m.email}</div>
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
                        fontWeight: 500,
                      }}
                    >
                      <span
                        className={`adm-presence-dot ${
                          m.presence === "on" || m.presence === "busy"
                            ? "online"
                            : m.presence === "away"
                            ? "away"
                            : m.presence === "dnd"
                            ? "dnd"
                            : "offline"
                        }`}
                      />
                      {m.presence === "on" ? "Online" : m.presence === "off" ? "Offline" : m.presence}
                    </span>
                  </td>
                  <td>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                      {m.organizations?.length ? (
                        m.organizations.map((org: any) => (
                          <span
                            key={org.orgId}
                            className="adm-badge adm-badge-info"
                            style={{ cursor: onSelectOrg ? "pointer" : "default" }}
                            onClick={() => onSelectOrg && onSelectOrg(org.orgId)}
                            title={`Role: ${org.role}`}
                          >
                            {org.orgName} ({org.role})
                          </span>
                        ))
                      ) : (
                        <span style={{ fontSize: 12, color: "var(--adm-text-subtle)" }}>No organization</span>
                      )}
                    </div>
                  </td>
                  <td>
                    <span className="adm-badge adm-badge-neutral">{m.meetingsCount} meetings</span>
                  </td>
                  <td>
                    <div style={{ fontSize: 12, color: "var(--adm-text-muted)" }}>
                      {m.lastSeen
                        ? new Date(m.lastSeen).toLocaleString([], { dateStyle: "short", timeStyle: "short" })
                        : "Never / Offline"}
                    </div>
                  </td>
                  <td>
                    <div style={{ fontSize: 12, color: "var(--adm-text-subtle)" }}>
                      {new Date(m.createdAt).toLocaleDateString([], { dateStyle: "medium" })}
                    </div>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={6}>
                  <div className="adm-empty">
                    <div className="adm-empty-title">No members found</div>
                    <div className="adm-empty-desc">Try modifying your search query or filters.</div>
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
          Showing {members.length ? page * limit + 1 : 0} to {Math.min((page + 1) * limit, total)} of {total} members
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
