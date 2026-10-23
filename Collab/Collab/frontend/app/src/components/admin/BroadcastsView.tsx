import React, { useEffect, useState } from "react";
import { adminApi } from "../../lib/adminApi";
import { Select } from "../ui";

interface BroadcastsViewProps {
  onSelectOrg?: (orgId: string) => void;
  onToast: (msg: string, type?: "success" | "error") => void;
}

export default function BroadcastsView({ onSelectOrg, onToast }: BroadcastsViewProps) {
  const [broadcasts, setBroadcasts] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [organizations, setOrganizations] = useState<any[]>([]);
  const [search, setSearch] = useState("");
  const [selectedOrg, setSelectedOrg] = useState("all");
  const [selectedStatus, setSelectedStatus] = useState("all");
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const limit = 20;

  // New Broadcast Modal State
  const [showModal, setShowModal] = useState(false);
  const [targetOrgId, setTargetOrgId] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [sendType, setSendType] = useState<"now" | "schedule">("now");
  const [sendAtDate, setSendAtDate] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Member exclusion state
  const [orgMembers, setOrgMembers] = useState<any[]>([]);
  const [loadingMembers, setLoadingMembers] = useState(false);
  const [excludedUserIds, setExcludedUserIds] = useState<string[]>([]);
  const [memberSearch, setMemberSearch] = useState("");

  // Load organizations for filters and creator
  useEffect(() => {
    adminApi.getOrganizations({ limit: 100 }).then((res) => {
      if (res.ok && res.data) {
        const orgs = res.data.organizations || [];
        setOrganizations(orgs);
        if (orgs.length > 0 && !targetOrgId) {
          setTargetOrgId(orgs[0].id);
        }
      }
    });
  }, []);

  // When target organization changes in modal, load its active members
  useEffect(() => {
    if (!targetOrgId || !showModal) return;
    setLoadingMembers(true);
    adminApi.getOrganizationMembers(targetOrgId).then((res) => {
      if (res.ok && res.data) {
        setOrgMembers(Array.isArray(res.data) ? res.data : []);
      } else {
        setOrgMembers([]);
      }
      setLoadingMembers(false);
    });
  }, [targetOrgId, showModal]);

  const fetchBroadcasts = async () => {
    setLoading(true);
    const res = await adminApi.getBroadcasts({
      q: search,
      organizationId: selectedOrg,
      status: selectedStatus,
      limit,
      offset: page * limit,
    });
    if (res.ok && res.data) {
      setBroadcasts(res.data.broadcasts || []);
      setTotal(res.data.total || 0);
    } else {
      onToast(res.error || "Failed to load broadcasts", "error");
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchBroadcasts();
  }, [search, selectedOrg, selectedStatus, page]);

  const handleCreateBroadcast = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!targetOrgId) {
      onToast("Please select a target organization.", "error");
      return;
    }
    if (!title.trim()) {
      onToast("Please enter a broadcast title.", "error");
      return;
    }

    setSubmitting(true);
    const res = await adminApi.createBroadcast({
      organizationId: targetOrgId,
      title: title.trim(),
      body: body.trim() || undefined,
      sendAt: sendType === "schedule" && sendAtDate ? new Date(sendAtDate).toISOString() : null,
      excludedUserIds,
    });

    if (res.ok) {
      onToast(
        sendType === "schedule"
          ? "Broadcast scheduled successfully."
          : `Broadcast sent successfully (${res.data?.deliveredCount || 0} delivered, ${excludedUserIds.length} skipped).`,
        "success",
      );
      setShowModal(false);
      setTitle("");
      setBody("");
      setSendType("now");
      setSendAtDate("");
      setExcludedUserIds([]);
      setMemberSearch("");
      fetchBroadcasts();
    } else {
      onToast(res.error || "Failed to send broadcast.", "error");
    }
    setSubmitting(false);
  };

  const handleDelete = async (id: string, isScheduled: boolean) => {
    if (!confirm(isScheduled ? "Cancel this scheduled broadcast?" : "Delete this broadcast for everyone?")) {
      return;
    }
    const res = await adminApi.deleteBroadcast(id);
    if (res.ok) {
      onToast(isScheduled ? "Scheduled broadcast cancelled." : "Broadcast deleted.", "success");
      fetchBroadcasts();
    } else {
      onToast(res.error || "Failed to delete broadcast.", "error");
    }
  };

  const toggleExcludeUser = (userId: string) => {
    setExcludedUserIds((prev) =>
      prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId],
    );
  };

  const filteredMembers = orgMembers.filter((m) => {
    if (!memberSearch.trim()) return true;
    const term = memberSearch.toLowerCase();
    return (
      (m.name && m.name.toLowerCase().includes(term)) ||
      (m.email && m.email.toLowerCase().includes(term)) ||
      (m.role && m.role.toLowerCase().includes(term))
    );
  });

  const totalPages = Math.ceil(total / limit);

  return (
    <div className="adm-panel">
      {/* Header & Controls */}
      <div className="adm-panel-header">
        <h3 className="adm-panel-title">
          <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
            <path d="M13.73 21a2 2 0 0 1-3.46 0" />
          </svg>
          Organization Broadcasts ({total})
        </h3>
        <div className="adm-panel-toolbar">
          <input
            type="text"
            className="adm-input"
            placeholder="Search by title, body, org..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
            style={{ width: 220 }}
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
            value={selectedStatus}
            onChange={(e) => {
              setSelectedStatus(e.target.value);
              setPage(0);
            }}
          >
            <option value="all">All Statuses</option>
            <option value="sent">Sent</option>
            <option value="scheduled">Scheduled</option>
            <option value="failed">Failed</option>
          </Select>

          <button
            className="adm-btn adm-btn-primary"
            onClick={() => setShowModal(true)}
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            <svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            New Broadcast
          </button>
        </div>
      </div>

      {/* Broadcasts List Table */}
      <div className="adm-table-container">
        <table className="adm-table">
          <thead>
            <tr>
              <th>Title & Message</th>
              <th>Organization</th>
              <th>Status</th>
              <th>Date / Schedule</th>
              <th style={{ textAlign: "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={5} style={{ textAlign: "center", padding: "32px 0", color: "var(--adm-text-muted)" }}>
                  Loading broadcasts...
                </td>
              </tr>
            ) : broadcasts.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ textAlign: "center", padding: "40px 0", color: "var(--adm-text-muted)" }}>
                  No broadcasts found matching the criteria.
                </td>
              </tr>
            ) : (
              broadcasts.map((b) => (
                <tr key={b.id}>
                  <td>
                    <div style={{ fontWeight: 600, color: "var(--adm-text)", marginBottom: 3 }}>
                      {b.title}
                    </div>
                    {b.body && (
                      <div
                        style={{
                          fontSize: 12.5,
                          color: "var(--adm-text-muted)",
                          maxWidth: 420,
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {b.body.replace(/<[^>]*>/g, " ").slice(0, 90)}
                      </div>
                    )}
                  </td>
                  <td>
                    <span
                      onClick={() => onSelectOrg && onSelectOrg(b.organizationId)}
                      style={{
                        cursor: onSelectOrg ? "pointer" : "default",
                        color: onSelectOrg ? "var(--adm-primary)" : "var(--adm-text)",
                        fontWeight: 500,
                      }}
                    >
                      {b.organizationName}
                    </span>
                  </td>
                  <td>
                    <span
                      className={`adm-badge ${
                        b.status === "sent"
                          ? "adm-badge-success"
                          : b.status === "scheduled"
                            ? "adm-badge-warning"
                            : "adm-badge-danger"
                      }`}
                    >
                      {b.status}
                    </span>
                  </td>
                  <td style={{ fontSize: 12.5, color: "var(--adm-text-muted)" }}>
                    {b.sendAt
                      ? `Scheduled: ${new Date(b.sendAt).toLocaleString()}`
                      : new Date(b.createdAt).toLocaleString()}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <button
                      className="adm-btn adm-btn-outline"
                      style={{ padding: "4px 8px", fontSize: 12, color: "var(--adm-danger)" }}
                      onClick={() => handleDelete(b.id, b.status === "scheduled")}
                    >
                      {b.status === "scheduled" ? "Cancel" : "Delete"}
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination Footer */}
      {totalPages > 1 && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "12px 16px",
            borderTop: "1px solid var(--adm-border)",
            fontSize: 13,
            color: "var(--adm-text-muted)",
          }}
        >
          <div>
            Showing {page * limit + 1}–{Math.min((page + 1) * limit, total)} of {total}
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              className="adm-btn adm-btn-outline"
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              Previous
            </button>
            <button
              className="adm-btn adm-btn-outline"
              disabled={page >= totalPages - 1}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </button>
          </div>
        </div>
      )}

      {/* New Broadcast Modal */}
      {showModal && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(0,0,0,0.7)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
            padding: 20,
          }}
          onClick={() => setShowModal(false)}
        >
          <div
            className="adm-card"
            style={{
              width: "100%",
              maxWidth: 620,
              background: "var(--adm-surface)",
              border: "1px solid var(--adm-border)",
              borderRadius: "var(--adm-radius-lg)",
              padding: 28,
              boxShadow: "var(--adm-shadow)",
              maxHeight: "90vh",
              overflowY: "auto",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 20,
                borderBottom: "1px solid var(--adm-border)",
                paddingBottom: 14,
              }}
            >
              <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "#fff" }}>
                Compose Organization Broadcast
              </h3>
              <button
                onClick={() => setShowModal(false)}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "var(--adm-text-muted)",
                  cursor: "pointer",
                  fontSize: 18,
                }}
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleCreateBroadcast} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div>
                <label style={{ display: "block", fontSize: 12.5, fontWeight: 600, color: "var(--adm-text-muted)", marginBottom: 6 }}>
                  Target Organization *
                </label>
                <Select
                  className="adm-select"
                  value={targetOrgId}
                  onChange={(e) => {
                    setTargetOrgId(e.target.value);
                    setExcludedUserIds([]);
                  }}
                  style={{ width: "100%" }}
                  required
                >
                  {organizations.map((org) => (
                    <option key={org.id} value={org.id}>
                      {org.name}
                    </option>
                  ))}
                </Select>
              </div>

              <div>
                <label style={{ display: "block", fontSize: 12.5, fontWeight: 600, color: "var(--adm-text-muted)", marginBottom: 6 }}>
                  Broadcast Title *
                </label>
                <input
                  type="text"
                  className="adm-input"
                  placeholder="e.g., Scheduled Maintenance Window / Policy Update"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  style={{ width: "100%" }}
                  required
                />
              </div>

              <div>
                <label style={{ display: "block", fontSize: 12.5, fontWeight: 600, color: "var(--adm-text-muted)", marginBottom: 6 }}>
                  Message Content
                </label>
                <textarea
                  className="adm-input"
                  placeholder="Type the announcement body here..."
                  rows={4}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  style={{ width: "100%", resize: "vertical", fontFamily: "inherit" }}
                />
              </div>

              {/* Exclusion Section (CEO/CTO / Member Skip) */}
              <div
                style={{
                  background: "var(--adm-surface-2)",
                  border: "1px solid var(--adm-border)",
                  borderRadius: "var(--adm-radius)",
                  padding: 14,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                  <label style={{ fontSize: 12.5, fontWeight: 600, color: "var(--adm-text)", display: "flex", alignItems: "center", gap: 6 }}>
                    <svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                      <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                      <circle cx="8.5" cy="7" r="4" />
                      <line x1="18" y1="8" x2="23" y2="13" />
                      <line x1="23" y1="8" x2="18" y2="13" />
                    </svg>
                    Skip / Exclude Specific Users ({excludedUserIds.length} selected)
                  </label>
                  {excludedUserIds.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setExcludedUserIds([])}
                      style={{
                        background: "none",
                        border: "none",
                        color: "var(--adm-primary)",
                        fontSize: 11.5,
                        cursor: "pointer",
                      }}
                    >
                      Clear All
                    </button>
                  )}
                </div>
                <div style={{ fontSize: 11.5, color: "var(--adm-text-muted)", marginBottom: 10 }}>
                  Select users who should NOT receive this broadcast (e.g., CEO, CTO, leadership).
                </div>

                <input
                  type="text"
                  className="adm-input"
                  placeholder="Filter members by name, email, or role..."
                  value={memberSearch}
                  onChange={(e) => setMemberSearch(e.target.value)}
                  style={{ width: "100%", marginBottom: 10, fontSize: 12 }}
                />

                <div
                  style={{
                    maxHeight: 140,
                    overflowY: "auto",
                    display: "flex",
                    flexDirection: "column",
                    gap: 4,
                  }}
                >
                  {loadingMembers ? (
                    <div style={{ fontSize: 12, color: "var(--adm-text-muted)", padding: 6 }}>Loading organization members...</div>
                  ) : filteredMembers.length === 0 ? (
                    <div style={{ fontSize: 12, color: "var(--adm-text-muted)", padding: 6 }}>No members found.</div>
                  ) : (
                    filteredMembers.map((m) => {
                      const isExcluded = excludedUserIds.includes(m.userId);
                      return (
                        <label
                          key={m.userId}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            padding: "6px 10px",
                            borderRadius: "var(--adm-radius-sm)",
                            background: isExcluded ? "var(--adm-danger-bg)" : "transparent",
                            cursor: "pointer",
                            fontSize: 12.5,
                            transition: "background 0.15s ease",
                          }}
                        >
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <input
                              type="checkbox"
                              checked={isExcluded}
                              onChange={() => toggleExcludeUser(m.userId)}
                            />
                            <span style={{ fontWeight: isExcluded ? 600 : 400, color: isExcluded ? "var(--adm-danger)" : "var(--adm-text)" }}>
                              {m.name || m.email}
                            </span>
                            {m.role && (
                              <span style={{ fontSize: 11, color: "var(--adm-text-subtle)", background: "var(--adm-surface-3)", padding: "1px 6px", borderRadius: 4 }}>
                                {m.role}
                              </span>
                            )}
                          </div>
                          <span style={{ fontSize: 11, color: isExcluded ? "var(--adm-danger)" : "var(--adm-text-subtle)" }}>
                            {isExcluded ? "Will Skip" : m.email}
                          </span>
                        </label>
                      );
                    })
                  )}
                </div>
              </div>

              {/* Delivery Timing */}
              <div>
                <label style={{ display: "block", fontSize: 12.5, fontWeight: 600, color: "var(--adm-text-muted)", marginBottom: 8 }}>
                  Delivery Timing
                </label>
                <div style={{ display: "flex", gap: 16, marginBottom: 8 }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer" }}>
                    <input
                      type="radio"
                      name="sendType"
                      checked={sendType === "now"}
                      onChange={() => setSendType("now")}
                    />
                    Send Immediately
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer" }}>
                    <input
                      type="radio"
                      name="sendType"
                      checked={sendType === "schedule"}
                      onChange={() => setSendType("schedule")}
                    />
                    Schedule for Later
                  </label>
                </div>

                {sendType === "schedule" && (
                  <input
                    type="datetime-local"
                    className="adm-input"
                    value={sendAtDate}
                    onChange={(e) => setSendAtDate(e.target.value)}
                    min={new Date().toISOString().slice(0, 16)}
                    required={sendType === "schedule"}
                    style={{ width: "100%", marginTop: 6 }}
                  />
                )}
              </div>

              {/* Modal Actions */}
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 8 }}>
                <button
                  type="button"
                  className="adm-btn adm-btn-outline"
                  onClick={() => setShowModal(false)}
                  disabled={submitting}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="adm-btn adm-btn-primary"
                  disabled={submitting}
                >
                  {submitting ? "Processing..." : sendType === "schedule" ? "Schedule Broadcast" : "Send Broadcast Now"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
