import React, { useEffect, useState } from "react";
import { adminApi } from "../../lib/adminApi";
import { Select } from "../ui";

interface MeetingsViewProps {
  onSelectMeeting: (meetingId: string) => void;
  onSelectOrg?: (orgId: string) => void;
  onToast: (msg: string, type?: "success" | "error") => void;
}

export default function MeetingsView({ onSelectMeeting, onSelectOrg, onToast }: MeetingsViewProps) {
  const [meetings, setMeetings] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [organizations, setOrganizations] = useState<any[]>([]);
  const [search, setSearch] = useState("");
  const [selectedOrg, setSelectedOrg] = useState("all");
  const [selectedStatus, setSelectedStatus] = useState("all");
  const [timeFilter, setTimeFilter] = useState<"all" | "upcoming" | "completed">("all");
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const limit = 20;

  // Load organizations for filter
  useEffect(() => {
    adminApi.getOrganizations({ limit: 100 }).then((res) => {
      if (res.ok && res.data) {
        setOrganizations(res.data.organizations || []);
      }
    });
  }, []);

  const fetchMeetings = async () => {
    setLoading(true);
    const res = await adminApi.getMeetings({
      q: search,
      organizationId: selectedOrg,
      status: selectedStatus,
      upcomingOnly: timeFilter === "upcoming",
      completedOnly: timeFilter === "completed",
      limit,
      offset: page * limit,
    });
    if (res.ok && res.data) {
      setMeetings(res.data.meetings || []);
      setTotal(res.data.total || 0);
    } else {
      onToast(res.error || "Failed to load meetings", "error");
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchMeetings();
  }, [search, selectedOrg, selectedStatus, timeFilter, page]);

  return (
    <div className="adm-panel">
      <div className="adm-panel-header">
        <h3 className="adm-panel-title">
          <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
            <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
            <line x1="16" y1="2" x2="16" y2="6" />
            <line x1="8" y1="2" x2="8" y2="6" />
            <line x1="3" y1="10" x2="21" y2="10" />
          </svg>
          Global Meetings Directory ({total})
        </h3>
        <div className="adm-panel-toolbar">
          <input
            type="text"
            className="adm-input"
            placeholder="Search meetings by title or ID..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
            style={{ width: 230 }}
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
            <option value="scheduled">Scheduled</option>
            <option value="active">Active (Live)</option>
            <option value="ended">Ended</option>
            <option value="cancelled">Cancelled</option>
          </Select>
          <Select
            className="adm-select"
            value={timeFilter}
            onChange={(e) => {
              setTimeFilter(e.target.value as any);
              setPage(0);
            }}
          >
            <option value="all">All Dates</option>
            <option value="upcoming">Upcoming Only</option>
            <option value="completed">Completed Only</option>
          </Select>
          <button className="adm-btn adm-btn-secondary" onClick={fetchMeetings}>
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
              <th>Meeting Title</th>
              <th>Organization</th>
              <th>Organizer</th>
              <th>Date & Time</th>
              <th>Duration</th>
              <th>Status</th>
              <th>Participants</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={8} style={{ textAlign: "center", padding: 36, color: "var(--adm-text-muted)" }}>
                  Loading meetings...
                </td>
              </tr>
            ) : meetings.length ? (
              meetings.map((mtg) => (
                <tr key={mtg.id}>
                  <td>
                    <div style={{ fontWeight: 600, color: "#fff" }}>{mtg.title}</div>
                    <div style={{ fontSize: 11, color: "var(--adm-text-subtle)", display: "flex", gap: 6, alignItems: "center" }}>
                      <span>ID: {mtg.id.slice(0, 8)}...</span>
                      {mtg.recurrence !== "none" && (
                        <span className="adm-badge adm-badge-warning" style={{ padding: "1px 5px", fontSize: 10 }}>
                          {mtg.recurrence}
                        </span>
                      )}
                    </div>
                  </td>
                  <td>
                    <span
                      className="adm-badge adm-badge-info"
                      style={{ cursor: onSelectOrg && mtg.organizationId ? "pointer" : "default" }}
                      onClick={() => onSelectOrg && mtg.organizationId && onSelectOrg(mtg.organizationId)}
                    >
                      {mtg.organizationName}
                    </span>
                  </td>
                  <td>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{mtg.organizerName}</div>
                    <div style={{ fontSize: 11, color: "var(--adm-text-subtle)" }}>{mtg.organizerEmail || "—"}</div>
                  </td>
                  <td>
                    <div style={{ fontSize: 12.5 }}>
                      {new Date(mtg.startsAt).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--adm-text-subtle)" }}>TZ: {mtg.timezone}</div>
                  </td>
                  <td>{mtg.durationMin} mins</td>
                  <td>
                    <span
                      className={`adm-badge ${
                        mtg.status === "active"
                          ? "adm-badge-warning"
                          : mtg.status === "ended"
                          ? "adm-badge-success"
                          : mtg.status === "cancelled"
                          ? "adm-badge-danger"
                          : "adm-badge-info"
                      }`}
                    >
                      {mtg.status}
                    </span>
                  </td>
                  <td>
                    <span className="adm-badge adm-badge-neutral">{mtg.attendeesCount} participants</span>
                  </td>
                  <td>
                    <button
                      className="adm-btn adm-btn-primary adm-btn-sm"
                      onClick={() => onSelectMeeting(mtg.id)}
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
                    <div className="adm-empty-title">No meetings found</div>
                    <div className="adm-empty-desc">Try changing the filters or search keywords.</div>
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
          Showing {meetings.length ? page * limit + 1 : 0} to {Math.min((page + 1) * limit, total)} of {total} meetings
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
