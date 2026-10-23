import React, { useEffect, useState } from "react";
import { adminApi } from "../../lib/adminApi";

interface DashboardProps {
  onNavigate: (tab: string, param?: string) => void;
  onToast: (msg: string, type?: "success" | "error") => void;
}

export default function DashboardView({ onNavigate, onToast }: DashboardProps) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const fetchDashboard = async () => {
    setLoading(true);
    const res = await adminApi.getDashboard();
    if (res.ok && res.data) {
      setData(res.data);
    } else {
      onToast(res.error || "Failed to load dashboard metrics", "error");
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchDashboard();
  }, []);

  if (loading && !data) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 300 }}>
        <span style={{ color: "var(--adm-text-muted)", fontSize: 14 }}>Loading dashboard metrics...</span>
      </div>
    );
  }

  const kpis = [
    {
      label: "Total Organizations",
      value: data?.totalOrganizations ?? 0,
      sub: `${data?.activeOrganizations ?? 0} active`,
      color: "var(--adm-primary)",
      bg: "var(--adm-primary-bg)",
      tab: "organizations",
      icon: (
        <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
          <path d="M3 21h18M3 7v14M21 7v14M6 11h4M6 15h4M14 11h4M14 15h4M9 3h6v4H9z" />
        </svg>
      ),
    },
    {
      label: "Organization Members",
      value: data?.totalMembers ?? 0,
      sub: "Across all tenants",
      color: "var(--adm-info)",
      bg: "var(--adm-info-bg)",
      tab: "members",
      icon: (
        <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      ),
    },
    {
      label: "Online Users",
      value: data?.onlineUsers ?? 0,
      sub: "Active now",
      color: "var(--adm-success)",
      bg: "var(--adm-success-bg)",
      tab: "online-users",
      icon: (
        <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 6v6l4 2" />
        </svg>
      ),
    },
    {
      label: "Total Meetings",
      value: data?.totalMeetings ?? 0,
      sub: "All time recorded",
      color: "#a855f7",
      bg: "rgba(168, 85, 247, 0.12)",
      tab: "meetings",
      icon: (
        <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
          <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
          <line x1="16" y1="2" x2="16" y2="6" />
          <line x1="8" y1="2" x2="8" y2="6" />
          <line x1="3" y1="10" x2="21" y2="10" />
        </svg>
      ),
    },
    {
      label: "Today's Meetings",
      value: data?.todayMeetings ?? 0,
      sub: "Scheduled for today",
      color: "var(--adm-warning)",
      bg: "var(--adm-warning-bg)",
      tab: "meetings",
      icon: (
        <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
        </svg>
      ),
    },
    {
      label: "Upcoming Meetings",
      value: data?.upcomingMeetings ?? 0,
      sub: "Future occurrences",
      color: "var(--adm-info)",
      bg: "var(--adm-info-bg)",
      tab: "meetings",
      icon: (
        <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </svg>
      ),
    },
    {
      label: "Completed Meetings",
      value: data?.completedMeetings ?? 0,
      sub: "Successfully ended",
      color: "var(--adm-success)",
      bg: "var(--adm-success-bg)",
      tab: "meetings",
      icon: (
        <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
          <polyline points="22 4 12 14.01 9 11.01" />
        </svg>
      ),
    },
    {
      label: "Active Organizations",
      value: data?.activeOrganizations ?? 0,
      sub: `${Math.round(((data?.activeOrganizations || 0) / Math.max(data?.totalOrganizations || 1, 1)) * 100)}% of total`,
      color: "var(--adm-primary)",
      bg: "var(--adm-primary-bg)",
      tab: "organizations",
      icon: (
        <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
          <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
        </svg>
      ),
    },
  ];

  return (
    <div>
      {/* 8 KPI Cards Grid */}
      <div className="adm-kpi-grid">
        {kpis.map((kpi, idx) => (
          <div
            key={idx}
            className="adm-kpi-card"
            style={{ cursor: "pointer" }}
            onClick={() => onNavigate(kpi.tab)}
            title={`View ${kpi.label}`}
          >
            <div className="adm-kpi-top">
              <span className="adm-kpi-label">{kpi.label}</span>
              <div className="adm-kpi-icon" style={{ background: kpi.bg, color: kpi.color }}>
                {kpi.icon}
              </div>
            </div>
            <div className="adm-kpi-value">{kpi.value}</div>
            <div className="adm-kpi-sub">{kpi.sub}</div>
          </div>
        ))}
      </div>

      {/* 2-Column Summary Panels: Recent Organizations & Recent Meetings */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))", gap: 20 }}>
        {/* Recent Organizations */}
        <div className="adm-panel">
          <div className="adm-panel-header">
            <h3 className="adm-panel-title">
              <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
                <path d="M3 21h18M3 7v14M21 7v14M6 11h4M6 15h4M14 11h4M14 15h4M9 3h6v4H9z" />
              </svg>
              Recent Organizations
            </h3>
            <button className="adm-btn adm-btn-secondary adm-btn-sm" onClick={() => onNavigate("organizations")}>
              View all
            </button>
          </div>
          <div className="adm-table-wrap">
            <table className="adm-table">
              <thead>
                <tr>
                  <th>Organization</th>
                  <th>Status</th>
                  <th>Members</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {data?.recentOrganizations?.length ? (
                  data.recentOrganizations.map((org: any) => (
                    <tr key={org.id}>
                      <td>
                        <div style={{ fontWeight: 600, color: "#fff" }}>{org.name}</div>
                        <div style={{ fontSize: 11.5, color: "var(--adm-text-subtle)" }}>slug: {org.slug}</div>
                      </td>
                      <td>
                        <span className={`adm-badge ${org.status === "active" ? "adm-badge-success" : "adm-badge-neutral"}`}>
                          {org.status}
                        </span>
                      </td>
                      <td>{org.memberCount} members</td>
                      <td>
                        <button
                          className="adm-btn adm-btn-secondary adm-btn-sm"
                          onClick={() => onNavigate("organization-details", org.id)}
                        >
                          Details
                        </button>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={4} style={{ textAlign: "center", color: "var(--adm-text-subtle)", padding: 24 }}>
                      No organizations found
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Recent Meetings */}
        <div className="adm-panel">
          <div className="adm-panel-header">
            <h3 className="adm-panel-title">
              <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
                <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                <line x1="16" y1="2" x2="16" y2="6" />
                <line x1="8" y1="2" x2="8" y2="6" />
                <line x1="3" y1="10" x2="21" y2="10" />
              </svg>
              Recent Meetings
            </h3>
            <button className="adm-btn adm-btn-secondary adm-btn-sm" onClick={() => onNavigate("meetings")}>
              View all
            </button>
          </div>
          <div className="adm-table-wrap">
            <table className="adm-table">
              <thead>
                <tr>
                  <th>Meeting</th>
                  <th>Organization</th>
                  <th>Organizer</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {data?.recentMeetings?.length ? (
                  data.recentMeetings.map((mtg: any) => (
                    <tr key={mtg.id}>
                      <td>
                        <div style={{ fontWeight: 600, color: "#fff" }}>{mtg.title}</div>
                        <div style={{ fontSize: 11.5, color: "var(--adm-text-subtle)" }}>
                          {new Date(mtg.startsAt).toLocaleString([], { dateStyle: "short", timeStyle: "short" })} ({mtg.durationMin}m)
                        </div>
                      </td>
                      <td>
                        <span className="adm-badge adm-badge-info">{mtg.organizationName}</span>
                      </td>
                      <td>{mtg.organizerName}</td>
                      <td>
                        <button
                          className="adm-btn adm-btn-secondary adm-btn-sm"
                          onClick={() => onNavigate("meeting-details", mtg.id)}
                        >
                          View
                        </button>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={4} style={{ textAlign: "center", color: "var(--adm-text-subtle)", padding: 24 }}>
                      No meetings found
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
