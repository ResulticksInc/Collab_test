import React, { useEffect, useState } from "react";
import { adminApi } from "../../lib/adminApi";
import LiveMeetingControls from "./LiveMeetingControls";

interface MeetingDetailViewProps {
  meetingId: string;
  onBack: () => void;
  onSelectOrg?: (orgId: string) => void;
  onToast: (msg: string, type?: "success" | "error") => void;
}

export default function MeetingDetailView({
  meetingId,
  onBack,
  onSelectOrg,
  onToast,
}: MeetingDetailViewProps) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  // Add Member Modal State
  const [showAddModal, setShowAddModal] = useState(false);
  const [orgMembers, setOrgMembers] = useState<any[]>([]);
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const [memberSearch, setMemberSearch] = useState("");
  const [addingLoading, setAddingLoading] = useState(false);

  // Remove confirmation modal state
  const [removeTarget, setRemoveTarget] = useState<any>(null);
  const [removingLoading, setRemovingLoading] = useState(false);

  const fetchMeeting = async () => {
    setLoading(true);
    const res = await adminApi.getMeeting(meetingId);
    if (res.ok && res.data) {
      setData(res.data);
    } else {
      onToast(res.error || "Failed to load meeting details", "error");
    }
    setLoading(false);
  };

  useEffect(() => {
    if (meetingId) fetchMeeting();
  }, [meetingId]);

  // Load organization members when opening Add Members modal
  const openAddModal = async () => {
    if (!data?.meeting?.organizationId) {
      onToast("This meeting has no assigned organization", "error");
      return;
    }
    setShowAddModal(true);
    setSelectedUserIds([]);
    setMemberSearch("");

    const res = await adminApi.getMembers({
      organizationId: data.meeting.organizationId,
      limit: 100,
    });
    if (res.ok && res.data) {
      setOrgMembers(res.data.members || []);
    }
  };

  const handleAddMembers = async () => {
    if (!selectedUserIds.length) {
      onToast("Please select at least one member to add", "error");
      return;
    }
    setAddingLoading(true);
    const res = await adminApi.addMeetingMembers(meetingId, selectedUserIds);
    if (res.ok) {
      onToast(`Successfully added ${selectedUserIds.length} member(s) to meeting`, "success");
      setShowAddModal(false);
      fetchMeeting();
    } else {
      onToast(res.error || "Failed to add members", "error");
    }
    setAddingLoading(false);
  };

  const handleRemoveMember = async () => {
    if (!removeTarget) return;
    setRemovingLoading(true);
    const res = await adminApi.removeMeetingMember(meetingId, removeTarget.userId);
    if (res.ok) {
      onToast(`Removed ${removeTarget.name} from meeting`, "success");
      setRemoveTarget(null);
      fetchMeeting();
    } else {
      onToast(res.error || "Failed to remove member", "error");
    }
    setRemovingLoading(false);
  };

  if (loading && !data) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 300 }}>
        <span style={{ color: "var(--adm-text-muted)", fontSize: 14 }}>Loading meeting details...</span>
      </div>
    );
  }

  if (!data?.meeting) {
    return (
      <div className="adm-panel" style={{ padding: 32, textAlign: "center" }}>
        <div style={{ fontSize: 16, fontWeight: 600, color: "#fff", marginBottom: 8 }}>Meeting Not Found</div>
        <div style={{ color: "var(--adm-text-subtle)", marginBottom: 16 }}>
          The requested meeting could not be found or has been deleted.
        </div>
        <button className="adm-btn adm-btn-secondary" onClick={onBack}>
          ← Back to Meetings
        </button>
      </div>
    );
  }

  const { meeting, attendees = [] } = data;
  const existingAttendeeIds = new Set(attendees.map((a: any) => a.userId));

  const filteredOrgMembers = orgMembers.filter((m: any) => {
    if (existingAttendeeIds.has(m.userId)) return false;
    if (!memberSearch.trim()) return true;
    const term = memberSearch.toLowerCase();
    return m.name?.toLowerCase().includes(term) || m.email?.toLowerCase().includes(term);
  });

  return (
    <div>
      {/* Back & Actions bar */}
      <div style={{ marginBottom: 20, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <button className="adm-btn adm-btn-secondary adm-btn-sm" onClick={onBack}>
          <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          Back to Meetings
        </button>
        <div style={{ display: "flex", gap: 10 }}>
          <button className="adm-btn adm-btn-secondary adm-btn-sm" onClick={fetchMeeting}>
            Refresh
          </button>
          <button className="adm-btn adm-btn-primary adm-btn-sm" onClick={openAddModal}>
            <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            Add Participants
          </button>
        </div>
      </div>

      {/* Meeting Header Panel */}
      <div className="adm-panel" style={{ padding: 24, marginBottom: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 16 }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
              <h2 style={{ fontSize: 20, fontWeight: 800, color: "#fff", margin: 0 }}>{meeting.title}</h2>
              <span
                className={`adm-badge ${
                  meeting.status === "active"
                    ? "adm-badge-warning"
                    : meeting.status === "ended"
                    ? "adm-badge-success"
                    : "adm-badge-info"
                }`}
              >
                {meeting.status}
              </span>
              {meeting.recurrence !== "none" && (
                <span className="adm-badge adm-badge-warning">Recurrence: {meeting.recurrence}</span>
              )}
            </div>
            {meeting.description && (
              <p style={{ color: "var(--adm-text-muted)", fontSize: 13.5, margin: "6px 0 12px 0", maxWidth: 600 }}>
                {meeting.description}
              </p>
            )}
            <div style={{ display: "flex", gap: 16, fontSize: 13, color: "var(--adm-text-subtle)", flexWrap: "wrap" }}>
              <span>
                Organization:{" "}
                <strong
                  style={{ color: "var(--adm-text)", cursor: onSelectOrg && meeting.organizationId ? "pointer" : "default" }}
                  onClick={() => onSelectOrg && meeting.organizationId && onSelectOrg(meeting.organizationId)}
                >
                  {meeting.organizationName}
                </strong>
              </span>
              <span>Organizer: <strong>{meeting.organizerName}</strong> ({meeting.organizerEmail})</span>
              <span>Duration: <strong>{meeting.durationMin} mins</strong></span>
              <span>Timezone: <strong>{meeting.timezone}</strong></span>
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 12, color: "var(--adm-text-subtle)", marginBottom: 4 }}>Scheduled Start</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: "#fff" }}>
              {new Date(meeting.startsAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
            </div>
          </div>
        </div>
      </div>

      {/* Live controls — only while the meeting can have people in the room */}
      {meeting.status !== "ended" && meeting.status !== "cancelled" && (
        <LiveMeetingControls meetingId={meetingId} onToast={onToast} />
      )}

      {/* Participants Table Panel */}
      <div className="adm-panel">
        <div className="adm-panel-header">
          <h3 className="adm-panel-title">
            <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
            Meeting Participants ({attendees.length})
          </h3>
          <button className="adm-btn adm-btn-primary adm-btn-sm" onClick={openAddModal}>
            + Add Member
          </button>
        </div>

        <div className="adm-table-wrap">
          <table className="adm-table">
            <thead>
              <tr>
                <th>Participant</th>
                <th>Presence</th>
                <th>Role</th>
                <th>Attendance Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {attendees.length ? (
                attendees.map((att: any) => (
                  <tr key={att.userId}>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <div
                          style={{
                            width: 32,
                            height: 32,
                            borderRadius: "50%",
                            background: att.color || "var(--adm-primary)",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            color: "#fff",
                            fontWeight: 700,
                            fontSize: 12,
                          }}
                        >
                          {att.initials || att.name.slice(0, 2).toUpperCase()}
                        </div>
                        <div>
                          <div style={{ fontWeight: 600, color: "#fff", display: "flex", alignItems: "center", gap: 6 }}>
                            {att.name}
                            {att.isOrganizer && <span className="adm-badge adm-badge-warning" style={{ fontSize: 10 }}>Organizer</span>}
                          </div>
                          <div style={{ fontSize: 11.5, color: "var(--adm-text-subtle)" }}>{att.email}</div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                        <span
                          className={`adm-presence-dot ${
                            att.presence === "on" || att.presence === "busy"
                              ? "online"
                              : att.presence === "away"
                              ? "away"
                              : att.presence === "dnd"
                              ? "dnd"
                              : "offline"
                          }`}
                        />
                        {att.presence === "on" ? "Online" : att.presence || "Offline"}
                      </span>
                    </td>
                    <td>
                      <span className="adm-badge adm-badge-info">{att.role}</span>
                    </td>
                    <td>
                      <span
                        className={`adm-badge ${
                          att.status === "accepted" || att.status === "joined"
                            ? "adm-badge-success"
                            : att.status === "declined"
                            ? "adm-badge-danger"
                            : "adm-badge-neutral"
                        }`}
                      >
                        {att.status}
                      </span>
                    </td>
                    <td>
                      {!att.isOrganizer ? (
                        <button
                          className="adm-btn adm-btn-danger adm-btn-sm"
                          onClick={() => setRemoveTarget(att)}
                        >
                          Remove
                        </button>
                      ) : (
                        <span style={{ fontSize: 11.5, color: "var(--adm-text-subtle)" }}>Host (Locked)</span>
                      )}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={5} style={{ textAlign: "center", padding: 32, color: "var(--adm-text-subtle)" }}>
                    No participants found for this meeting
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add Members Modal Dialog */}
      {showAddModal && (
        <div className="adm-modal-backdrop" onClick={() => setShowAddModal(false)}>
          <div className="adm-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
            <div className="adm-modal-header">
              <h3 className="adm-modal-title">Add Organization Members to Meeting</h3>
              <button
                className="adm-btn adm-btn-secondary adm-btn-sm"
                style={{ padding: "4px 8px" }}
                onClick={() => setShowAddModal(false)}
              >
                ✕
              </button>
            </div>

            <div className="adm-modal-body">
              <div style={{ fontSize: 13, color: "var(--adm-text-muted)", marginBottom: 12 }}>
                Select members from <strong>{meeting.organizationName}</strong> to add as participants:
              </div>

              <input
                type="text"
                className="adm-input"
                placeholder="Search organization members..."
                value={memberSearch}
                onChange={(e) => setMemberSearch(e.target.value)}
                style={{ width: "100%", marginBottom: 14 }}
              />

              <div style={{ maxHeight: 260, overflowY: "auto", border: "1px solid var(--adm-border)", borderRadius: "var(--adm-radius-sm)", padding: 6 }}>
                {filteredOrgMembers.length ? (
                  filteredOrgMembers.map((m: any) => {
                    const isSelected = selectedUserIds.includes(m.userId);
                    return (
                      <div
                        key={m.userId}
                        onClick={() => {
                          if (isSelected) {
                            setSelectedUserIds(selectedUserIds.filter((id) => id !== m.userId));
                          } else {
                            setSelectedUserIds([...selectedUserIds, m.userId]);
                          }
                        }}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                          padding: "8px 10px",
                          borderRadius: 6,
                          cursor: "pointer",
                          background: isSelected ? "var(--adm-primary-bg)" : "transparent",
                          border: isSelected ? "1px solid rgba(99, 102, 241, 0.4)" : "1px solid transparent",
                          marginBottom: 4,
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => {}} // handled by row click
                          style={{ cursor: "pointer" }}
                        />
                        <div
                          style={{
                            width: 28,
                            height: 28,
                            borderRadius: "50%",
                            background: m.color || "var(--adm-primary)",
                            color: "#fff",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontSize: 11,
                            fontWeight: 700,
                          }}
                        >
                          {m.initials || m.name.slice(0, 2).toUpperCase()}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: "#fff" }}>{m.name}</div>
                          <div style={{ fontSize: 11, color: "var(--adm-text-subtle)" }}>{m.email}</div>
                        </div>
                        <span className="adm-badge adm-badge-neutral" style={{ fontSize: 10 }}>
                          {m.role}
                        </span>
                      </div>
                    );
                  })
                ) : (
                  <div style={{ textAlign: "center", padding: 24, color: "var(--adm-text-subtle)", fontSize: 12.5 }}>
                    {memberSearch ? "No matching members found" : "All organization members are already in this meeting"}
                  </div>
                )}
              </div>
            </div>

            <div className="adm-modal-footer">
              <button
                className="adm-btn adm-btn-secondary"
                onClick={() => setShowAddModal(false)}
                disabled={addingLoading}
              >
                Cancel
              </button>
              <button
                className="adm-btn adm-btn-primary"
                onClick={handleAddMembers}
                disabled={addingLoading || !selectedUserIds.length}
              >
                {addingLoading ? "Adding..." : `Add Selected (${selectedUserIds.length})`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Remove Confirmation Dialog */}
      {removeTarget && (
        <div className="adm-modal-backdrop" onClick={() => setRemoveTarget(null)}>
          <div className="adm-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 440 }}>
            <div className="adm-modal-header">
              <h3 className="adm-modal-title" style={{ color: "var(--adm-danger)" }}>Confirm Removal</h3>
              <button
                className="adm-btn adm-btn-secondary adm-btn-sm"
                style={{ padding: "4px 8px" }}
                onClick={() => setRemoveTarget(null)}
              >
                ✕
              </button>
            </div>

            <div className="adm-modal-body">
              <p style={{ color: "var(--adm-text)", fontSize: 13.5, margin: 0 }}>
                Are you sure you want to remove <strong>{removeTarget.name}</strong> from <strong>{meeting.title}</strong>?
              </p>
              <p style={{ color: "var(--adm-text-subtle)", fontSize: 12, marginTop: 8 }}>
                The participant will no longer have access to this meeting and will be uninvited.
              </p>
            </div>

            <div className="adm-modal-footer">
              <button
                className="adm-btn adm-btn-secondary"
                onClick={() => setRemoveTarget(null)}
                disabled={removingLoading}
              >
                Cancel
              </button>
              <button
                className="adm-btn adm-btn-danger"
                onClick={handleRemoveMember}
                disabled={removingLoading}
              >
                {removingLoading ? "Removing..." : "Confirm Removal"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
