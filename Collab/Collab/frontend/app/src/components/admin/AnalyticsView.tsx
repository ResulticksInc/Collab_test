import React, { useEffect, useState } from "react";
import { adminApi } from "../../lib/adminApi";
import { Select } from "../ui";

interface AnalyticsViewProps {
  onSelectOrg?: (orgId: string) => void;
  onToast: (msg: string, type?: "success" | "error") => void;
}

export default function AnalyticsView({ onSelectOrg, onToast }: AnalyticsViewProps) {
  const [data, setData] = useState<any>(null);
  const [organizations, setOrganizations] = useState<any[]>([]);
  const [selectedOrg, setSelectedOrg] = useState("all");
  const [loading, setLoading] = useState(true);

  // Load organizations for filter
  useEffect(() => {
    adminApi.getOrganizations({ limit: 100 }).then((res) => {
      if (res.ok && res.data) {
        setOrganizations(res.data.organizations || []);
      }
    });
  }, []);

  const fetchAnalytics = async () => {
    setLoading(true);
    const res = await adminApi.getAnalytics(selectedOrg);
    if (res.ok && res.data) {
      setData(res.data);
    } else {
      onToast(res.error || "Failed to load analytics data", "error");
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchAnalytics();
  }, [selectedOrg]);

  const summary = data?.summary || {};
  const daily = data?.dailyDistribution || [];
  const orgBreakdown = data?.organizationBreakdown || [];
  const statusDist = data?.statusDistribution || [];

  const maxCount = Math.max(...daily.map((d: any) => d.count), 1);

  return (
    <div>
      {/* Header & Org Filter */}
      <div className="adm-panel" style={{ padding: 20, marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 800, color: "#fff", margin: 0 }}>Organization Meeting Analytics</h2>
            <div style={{ fontSize: 13, color: "var(--adm-text-muted)" }}>
              Detailed metrics on meeting volume, recurrence, and organization activity
            </div>
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <Select
              className="adm-select"
              value={selectedOrg}
              onChange={(e) => setSelectedOrg(e.target.value)}
              style={{ width: 220 }}
            >
              <option value="all">All Organizations (Global)</option>
              {organizations.map((org) => (
                <option key={org.id} value={org.id}>
                  {org.name}
                </option>
              ))}
            </Select>
            <button className="adm-btn adm-btn-secondary" onClick={fetchAnalytics}>
              Refresh
            </button>
          </div>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="adm-kpi-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", marginBottom: 24 }}>
        <div className="adm-kpi-card">
          <div className="adm-kpi-label">Total Meetings</div>
          <div className="adm-kpi-value">{summary.totalMeetings ?? 0}</div>
          <div className="adm-kpi-sub">In selected scope</div>
        </div>
        <div className="adm-kpi-card">
          <div className="adm-kpi-label">Today's Meetings</div>
          <div className="adm-kpi-value" style={{ color: "var(--adm-warning)" }}>{summary.todayMeetings ?? 0}</div>
          <div className="adm-kpi-sub">Occurring today</div>
        </div>
        <div className="adm-kpi-card">
          <div className="adm-kpi-label">Upcoming Meetings</div>
          <div className="adm-kpi-value" style={{ color: "var(--adm-info)" }}>{summary.upcomingMeetings ?? 0}</div>
          <div className="adm-kpi-sub">Future scheduled</div>
        </div>
        <div className="adm-kpi-card">
          <div className="adm-kpi-label">Completed Meetings</div>
          <div className="adm-kpi-value" style={{ color: "var(--adm-success)" }}>{summary.completedMeetings ?? 0}</div>
          <div className="adm-kpi-sub">Finished meetings</div>
        </div>
        <div className="adm-kpi-card">
          <div className="adm-kpi-label">Recurring Meetings</div>
          <div className="adm-kpi-value" style={{ color: "#a855f7" }}>{summary.recurringMeetings ?? 0}</div>
          <div className="adm-kpi-sub">Repeat pattern active</div>
        </div>
      </div>

      {/* Daily Meeting Trends Chart */}
      <div className="adm-panel">
        <div className="adm-panel-header">
          <h3 className="adm-panel-title">
            <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
              <line x1="18" y1="20" x2="18" y2="10" />
              <line x1="12" y1="20" x2="12" y2="4" />
              <line x1="6" y1="20" x2="6" y2="14" />
            </svg>
            Meeting Activity Trend (Past 14 Days & Upcoming Week)
          </h3>
        </div>
        <div style={{ padding: "16px 24px" }}>
          {daily.length ? (
            <div className="adm-bar-chart">
              {daily.map((d: any, idx: number) => {
                const heightPct = Math.round((d.count / maxCount) * 100);
                const dateObj = new Date(d.date);
                const formattedDate = dateObj.toLocaleDateString([], { month: "numeric", day: "numeric" });
                return (
                  <div key={idx} className="adm-bar-col">
                    <span className="adm-bar-val">{d.count}</span>
                    <div
                      className="adm-bar"
                      style={{
                        height: `${Math.max(heightPct, 6)}%`,
                        background:
                          dateObj.toDateString() === new Date().toDateString()
                            ? "linear-gradient(180deg, #f59e0b, #d97706)"
                            : "linear-gradient(180deg, #6366f1, #4f46e5)",
                      }}
                      title={`${d.date}: ${d.count} meetings`}
                    />
                    <span className="adm-bar-label">{formattedDate}</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={{ textAlign: "center", padding: 36, color: "var(--adm-text-subtle)" }}>
              No meeting activity data in the current date range
            </div>
          )}
        </div>
      </div>

      {/* Organization Meeting Comparison Table */}
      <div className="adm-panel">
        <div className="adm-panel-header">
          <h3 className="adm-panel-title">
            <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
              <path d="M3 21h18M3 7v14M21 7v14M6 11h4M6 15h4M14 11h4M14 15h4M9 3h6v4H9z" />
            </svg>
            Organization Activity Breakdown
          </h3>
        </div>
        <div className="adm-table-wrap">
          <table className="adm-table">
            <thead>
              <tr>
                <th>Organization</th>
                <th>Total Meetings</th>
                <th>Today</th>
                <th>Upcoming</th>
                <th>Completed</th>
                <th>Recurring</th>
              </tr>
            </thead>
            <tbody>
              {orgBreakdown.length ? (
                orgBreakdown.map((org: any) => (
                  <tr key={org.orgId}>
                    <td>
                      <div
                        style={{
                          fontWeight: 600,
                          color: "#fff",
                          cursor: onSelectOrg ? "pointer" : "default",
                        }}
                        onClick={() => onSelectOrg && onSelectOrg(org.orgId)}
                      >
                        {org.orgName}
                      </div>
                    </td>
                    <td>
                      <span className="adm-badge adm-badge-info">{org.totalMeetings}</span>
                    </td>
                    <td>
                      <span style={{ color: org.todayMeetings > 0 ? "var(--adm-warning)" : "var(--adm-text-subtle)", fontWeight: 600 }}>
                        {org.todayMeetings}
                      </span>
                    </td>
                    <td>{org.upcomingMeetings}</td>
                    <td>
                      <span style={{ color: "var(--adm-success)", fontWeight: 500 }}>{org.completedMeetings}</span>
                    </td>
                    <td>{org.recurringMeetings}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={6} style={{ textAlign: "center", padding: 32, color: "var(--adm-text-subtle)" }}>
                    No organization meeting data available
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
