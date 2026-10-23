import React, { useEffect, useState } from "react";
import { adminApi } from "../../lib/adminApi";

interface OrganizationDetailViewProps {
  orgId: string;
  onBack: () => void;
  onSelectMeeting: (meetingId: string) => void;
  onToast: (msg: string, type?: "success" | "error") => void;
}

export default function OrganizationDetailView({
  orgId,
  onBack,
  onSelectMeeting,
  onToast,
}: OrganizationDetailViewProps) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"members" | "meetings" | "activity">("members");

  const fetchDetails = async () => {
    setLoading(true);
    const res = await adminApi.getOrganization(orgId);
    if (res.ok && res.data) {
      setData(res.data);
    } else {
      onToast(res.error || "Failed to load organization details", "error");
    }
    setLoading(false);
  };

  useEffect(() => {
    if (orgId) fetchDetails();
  }, [orgId]);

  if (loading && !data) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 300 }}>
        <span style={{ color: "var(--adm-text-muted)", fontSize: 14 }}>Loading organization details...</span>
      </div>
    );
  }

  if (!data?.organization) {
    return (
      <div className="adm-panel" style={{ padding: 32, textAlign: "center" }}>
        <div style={{ fontSize: 16, fontWeight: 600, color: "#fff", marginBottom: 8 }}>
          Organization Not Found
        </div>
        <div style={{ color: "var(--adm-text-subtle)", marginBottom: 16 }}>
          The requested organization could not be retrieved or has been deleted.
        </div>
        <button className="adm-btn adm-btn-secondary" onClick={onBack}>
          ← Back to Organizations
        </button>
      </div>
    );
  }

  const { organization: org, stats, members = [], meetings = [], activity = [] } = data;

  return (
    <div>
      {/* Back bar & Organization Banner */}
      <div style={{ marginBottom: 20, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <button className="adm-btn adm-btn-secondary adm-btn-sm" onClick={onBack}>
          <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          Back to Organizations
        </button>
        <button className="adm-btn adm-btn-secondary adm-btn-sm" onClick={fetchDetails}>
          <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
            <path d="M23 4v6h-6M1 20v-6h6" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
          Refresh
        </button>
      </div>

      {/* Org Header Card */}
      <div className="adm-panel" style={{ padding: 24, marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap" }}>
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 14,
              background: "linear-gradient(135deg, #6366f1, #8b5cf6)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 22,
              fontWeight: 800,
              color: "#fff",
              boxShadow: "0 8px 16px rgba(99, 102, 241, 0.3)",
            }}
          >
            {org.name.slice(0, 2).toUpperCase()}
          </div>
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
              <h2 style={{ fontSize: 20, fontWeight: 800, color: "#fff", margin: 0 }}>{org.name}</h2>
              <span className={`adm-badge ${org.status === "active" ? "adm-badge-success" : "adm-badge-neutral"}`}>
                {org.status}
              </span>
              <span className="adm-badge adm-badge-info">{org.kind}</span>
            </div>
            <div style={{ fontSize: 13, color: "var(--adm-text-muted)", display: "flex", gap: 16, flexWrap: "wrap" }}>
              <span>ID: <code style={{ color: "var(--adm-primary)" }}>{org.id}</code></span>
              <span>Slug: <strong>{org.slug}</strong></span>
              <span>
                Created: {new Date(org.createdAt).toLocaleDateString([], { dateStyle: "medium" })}
              </span>
              <span>Owner: {org.ownerName ? `${org.ownerName} (${org.ownerEmail})` : "None"}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Stats KPI Row */}
      <div className="adm-kpi-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", marginBottom: 24 }}>
        <div className="adm-kpi-card">
          <div className="adm-kpi-label">Total Members</div>
          <div className="adm-kpi-value">{stats?.totalMembers ?? 0}</div>
          <div className="adm-kpi-sub" style={{ color: "var(--adm-success)" }}>
            <span className="adm-presence-dot online" /> {stats?.onlineMembers ?? 0} online now
          </div>
        </div>
        <div className="adm-kpi-card">
          <div className="adm-kpi-label">Total Meetings</div>
          <div className="adm-kpi-value">{stats?.totalMeetings ?? 0}</div>
          <div className="adm-kpi-sub">All time recorded</div>
        </div>
        <div className="adm-kpi-card">
          <div className="adm-kpi-label">Today's Meetings</div>
          <div className="adm-kpi-value" style={{ color: "var(--adm-warning)" }}>{stats?.todayMeetings ?? 0}</div>
          <div className="adm-kpi-sub">Scheduled today</div>
        </div>
        <div className="adm-kpi-card">
          <div className="adm-kpi-label">Upcoming Meetings</div>
          <div className="adm-kpi-value" style={{ color: "var(--adm-info)" }}>{stats?.upcomingMeetings ?? 0}</div>
          <div className="adm-kpi-sub">Future schedule</div>
        </div>
        <div className="adm-kpi-card">
          <div className="adm-kpi-label">Completed Meetings</div>
          <div className="adm-kpi-value" style={{ color: "var(--adm-success)" }}>{stats?.completedMeetings ?? 0}</div>
          <div className="adm-kpi-sub">{stats?.recurringMeetings ?? 0} recurring</div>
        </div>
      </div>

      {/* Section Sub-Tabs */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <button
          className={`adm-btn ${activeTab === "members" ? "adm-btn-primary" : "adm-btn-secondary"}`}
          onClick={() => setActiveTab("members")}
        >
          Members ({members.length})
        </button>
        <button
          className={`adm-btn ${activeTab === "meetings" ? "adm-btn-primary" : "adm-btn-secondary"}`}
          onClick={() => setActiveTab("meetings")}
        >
          Meetings ({meetings.length})
        </button>
        <button
          className={`adm-btn ${activeTab === "activity" ? "adm-btn-primary" : "adm-btn-secondary"}`}
          onClick={() => setActiveTab("activity")}
        >
          Activity Log ({activity.length})
        </button>
      </div>

      {/* Tab 1: Members Roster */}
      {activeTab === "members" && (
        <div className="adm-panel">
          <div className="adm-table-wrap">
            <table className="adm-table">
              <thead>
                <tr>
                  <th>Member</th>
                  <th>Role</th>
                  <th>Presence</th>
                  <th>Status</th>
                  <th>Primary Team</th>
                  <th>Joined Date</th>
                </tr>
              </thead>
              <tbody>
                {members.length ? (
                  members.map((m: any) => (
                    <tr key={m.userId}>
                      <td>
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <div
                            style={{
                              width: 32,
                              height: 32,
                              borderRadius: "50%",
                              background: m.color || "var(--adm-primary)",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              color: "#fff",
                              fontWeight: 700,
                              fontSize: 12,
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
                        <span className="adm-badge adm-badge-info">{m.role}</span>
                      </td>
                      <td>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12 }}>
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
                          {m.presence === "on" ? "Online" : m.presence || "Offline"}
                        </span>
                      </td>
                      <td>
                        <span className={`adm-badge ${m.status === "active" ? "adm-badge-success" : "adm-badge-neutral"}`}>
                          {m.status}
                        </span>
                      </td>
                      <td>{m.teamName || "—"}</td>
                      <td>
                        <div style={{ fontSize: 12, color: "var(--adm-text-muted)" }}>
                          {new Date(m.joinedAt).toLocaleDateString([], { dateStyle: "medium" })}
                        </div>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={6} style={{ textAlign: "center", padding: 32, color: "var(--adm-text-subtle)" }}>
                      No members in this organization
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Tab 2: Meetings List */}
      {activeTab === "meetings" && (
        <div className="adm-panel">
          <div className="adm-table-wrap">
            <table className="adm-table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Organizer</th>
                  <th>Date & Time</th>
                  <th>Duration</th>
                  <th>Status</th>
                  <th>Attendees</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {meetings.length ? (
                  meetings.map((mtg: any) => (
                    <tr key={mtg.id}>
                      <td>
                        <div style={{ fontWeight: 600, color: "#fff" }}>{mtg.title}</div>
                        {mtg.recurrence !== "none" && (
                          <span className="adm-badge adm-badge-warning" style={{ fontSize: 10, marginTop: 2 }}>
                            {mtg.recurrence}
                          </span>
                        )}
                      </td>
                      <td>
                        <div>{mtg.organizerName}</div>
                        <div style={{ fontSize: 11, color: "var(--adm-text-subtle)" }}>{mtg.organizerEmail}</div>
                      </td>
                      <td>
                        <div style={{ fontSize: 12.5 }}>
                          {new Date(mtg.startsAt).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}
                        </div>
                      </td>
                      <td>{mtg.durationMin} mins</td>
                      <td>
                        <span
                          className={`adm-badge ${
                            mtg.status === "active"
                              ? "adm-badge-warning"
                              : mtg.status === "ended"
                              ? "adm-badge-success"
                              : "adm-badge-info"
                          }`}
                        >
                          {mtg.status}
                        </span>
                      </td>
                      <td>{mtg.attendeesCount} participants</td>
                      <td>
                        <button
                          className="adm-btn adm-btn-primary adm-btn-sm"
                          onClick={() => onSelectMeeting(mtg.id)}
                        >
                          Details & Members
                        </button>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={7} style={{ textAlign: "center", padding: 32, color: "var(--adm-text-subtle)" }}>
                      No meetings found for this organization
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Tab 3: Activity Log */}
      {activeTab === "activity" && (
        <div className="adm-panel">
          <div className="adm-table-wrap">
            <table className="adm-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Action</th>
                  <th>Actor</th>
                  <th>Target</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {activity.length ? (
                  activity.map((a: any) => (
                    <tr key={a.id}>
                      <td>
                        <div style={{ fontSize: 12, color: "var(--adm-text-muted)", whiteSpace: "nowrap" }}>
                          {new Date(a.createdAt).toLocaleString([], { dateStyle: "short", timeStyle: "medium" })}
                        </div>
                      </td>
                      <td>
                        <span className="adm-badge adm-badge-info">{a.action}</span>
                      </td>
                      <td>
                        <div style={{ fontWeight: 600 }}>{a.actorName}</div>
                        <div style={{ fontSize: 11, color: "var(--adm-text-subtle)" }}>{a.actorEmail || a.actorId}</div>
                      </td>
                      <td>
                        <code style={{ fontSize: 11.5, color: "var(--adm-text-muted)" }}>{a.target || "—"}</code>
                      </td>
                      <td>
                        <div style={{ fontSize: 11.5, color: "var(--adm-text-subtle)", maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis" }}>
                          {JSON.stringify(a.meta || {})}
                        </div>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={5} style={{ textAlign: "center", padding: 32, color: "var(--adm-text-subtle)" }}>
                      No activity logs recorded for this organization
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
