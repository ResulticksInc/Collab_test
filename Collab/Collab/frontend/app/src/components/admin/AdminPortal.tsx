import React, { useEffect, useState } from "react";
import { CollabIcon } from "../brand/Logo";
import { adminApi, clearAdminToken, getAdminToken } from "../../lib/adminApi";
import "../../styles/admin.css";

import DashboardView from "./DashboardView";
import OrganizationsView from "./OrganizationsView";
import OrganizationDetailView from "./OrganizationDetailView";
import MembersView from "./MembersView";
import OnlineUsersView from "./OnlineUsersView";
import MeetingsView from "./MeetingsView";
import MeetingDetailView from "./MeetingDetailView";
import AnalyticsView from "./AnalyticsView";
import AuditLogsView from "./AuditLogsView";
import ServerLogsView from "./ServerLogsView";
import AdminSettingsView from "./AdminSettingsView";
import BroadcastsView from "./BroadcastsView";

export default function AdminPortal() {
  const [admin, setAdmin] = useState<{ email: string; role: string } | null>(null);
  const [authChecking, setAuthChecking] = useState(true);
  const [activeTab, setActiveTab] = useState<string>("dashboard");
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);
  const [selectedMeetingId, setSelectedMeetingId] = useState<string | null>(null);

  // Login form state
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);

  // Toast state
  const [toasts, setToasts] = useState<Array<{ id: number; msg: string; type: "success" | "error" }>>([]);

  const showToast = (msg: any, type: "success" | "error" = "success") => {
    const text =
      typeof msg === "string"
        ? msg
        : msg?.message || msg?.error || (typeof msg === "object" ? JSON.stringify(msg) : String(msg || ""));
    const id = Date.now();
    setToasts((prev) => [...prev, { id, msg: text, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  };

  // Check initial session
  useEffect(() => {
    const checkSession = async () => {
      const token = getAdminToken();
      if (!token) {
        setAuthChecking(false);
        return;
      }

      const res = await adminApi.getMe();
      if (res.ok && res.data?.admin) {
        setAdmin(res.data.admin);
      } else {
        clearAdminToken();
        setAdmin(null);
      }
      setAuthChecking(false);
    };

    checkSession();

    // Listen for 401 unauthorized event
    const handleUnauthorized = () => {
      setAdmin(null);
      showToast("Admin session expired. Please log in again.", "error");
    };

    window.addEventListener("colab:admin_unauthorized", handleUnauthorized);
    return () => window.removeEventListener("colab:admin_unauthorized", handleUnauthorized);
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError("");
    setLoginLoading(true);

    const res = await adminApi.login({
      email: loginEmail,
      password: loginPassword,
    });

    if (res.ok && res.data?.admin) {
      setAdmin(res.data.admin);
      showToast("Signed in as Admin", "success");
    } else {
      setLoginError(res.error || "Authentication failed. Check your credentials.");
    }
    setLoginLoading(false);
  };

  const handleLogout = async () => {
    await adminApi.logout();
    setAdmin(null);
    setActiveTab("dashboard");
    showToast("Signed out successfully", "success");
  };

  const handleNavigate = (tab: string, param?: string) => {
    if (tab === "organization-details" && param) {
      setSelectedOrgId(param);
      setActiveTab("organization-details");
    } else if (tab === "meeting-details" && param) {
      setSelectedMeetingId(param);
      setActiveTab("meeting-details");
    } else {
      setActiveTab(tab);
    }
  };

  if (authChecking) {
    return (
      <div className="adm-login-wrap">
        <div style={{ color: "var(--adm-text-muted)", fontSize: 14 }}>Verifying admin authorization...</div>
      </div>
    );
  }

  // ── Unauthenticated Login Screen ───────────────────────────────────────────
  if (!admin) {
    return (
      <div className="adm-login-wrap">
        <div className="adm-login-card">
          <div className="adm-login-header">
            <div className="adm-login-icon">
              <svg width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              </svg>
            </div>
            <h1 className="adm-login-title">Collab Admin Panel</h1>
            <p className="adm-login-subtitle">
              Enter administrative credentials to manage organizations, members, and meetings.
            </p>
          </div>

          {loginError && (
            <div
              style={{
                background: "var(--adm-danger-bg)",
                border: "1px solid rgba(239, 68, 68, 0.3)",
                color: "var(--adm-danger)",
                padding: "10px 14px",
                borderRadius: "var(--adm-radius-sm)",
                fontSize: 13,
                marginBottom: 16,
              }}
            >
              {loginError}
            </div>
          )}

          <form onSubmit={handleLogin} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div>
              <label style={{ display: "block", fontSize: 12.5, fontWeight: 600, color: "var(--adm-text-muted)", marginBottom: 6 }}>
                Admin Email
              </label>
              <input
                type="email"
                required
                className="adm-input"
                style={{ width: "100%" }}
                placeholder="admin@collab.local"
                value={loginEmail}
                onChange={(e) => setLoginEmail(e.target.value)}
                autoComplete="username"
              />
            </div>

            <div>
              <label style={{ display: "block", fontSize: 12.5, fontWeight: 600, color: "var(--adm-text-muted)", marginBottom: 6 }}>
                Admin Password
              </label>
              <input
                type="password"
                required
                className="adm-input"
                style={{ width: "100%" }}
                placeholder="••••••••••••"
                value={loginPassword}
                onChange={(e) => setLoginPassword(e.target.value)}
                autoComplete="current-password"
              />
            </div>

            <button
              type="submit"
              className="adm-btn adm-btn-primary"
              disabled={loginLoading}
              style={{ width: "100%", marginTop: 8, padding: "10px 16px" }}
            >
              {loginLoading ? "Authenticating..." : "Sign In to Admin Panel"}
            </button>
          </form>

          <div style={{ marginTop: 24, textAlign: "center", fontSize: 12, color: "var(--adm-text-subtle)" }}>
            Decoupled admin portal • Configured via environment variables
          </div>
        </div>

        {/* Toast notifications */}
        <div className="adm-toast-container">
          {toasts.map((t) => (
            <div key={t.id} className={`adm-toast ${t.type}`}>
              {t.msg}
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ── Authenticated Main Admin Layout ────────────────────────────────────────
  return (
    <div className="adm-shell">
      {/* Sidebar Navigation */}
      <aside className="adm-sidebar">
        <div className="adm-brand">
          <CollabIcon className="adm-brand-logo" />
          <span className="adm-brand-name">Collab Admin</span>
          <span className="adm-brand-badge">Super</span>
        </div>

        <nav className="adm-nav">
          <div className="adm-nav-section">Overview</div>
          <button
            className={`adm-nav-item ${activeTab === "dashboard" ? "active" : ""}`}
            onClick={() => setActiveTab("dashboard")}
          >
            <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
              <rect x="3" y="3" width="7" height="7" />
              <rect x="14" y="3" width="7" height="7" />
              <rect x="14" y="14" width="7" height="7" />
              <rect x="3" y="14" width="7" height="7" />
            </svg>
            Dashboard
          </button>

          <div className="adm-nav-section">Management</div>
          <button
            className={`adm-nav-item ${activeTab === "organizations" || activeTab === "organization-details" ? "active" : ""}`}
            onClick={() => setActiveTab("organizations")}
          >
            <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
              <path d="M3 21h18M3 7v14M21 7v14M6 11h4M6 15h4M14 11h4M14 15h4M9 3h6v4H9z" />
            </svg>
            Organizations
          </button>

          <button
            className={`adm-nav-item ${activeTab === "members" ? "active" : ""}`}
            onClick={() => setActiveTab("members")}
          >
            <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
            Members
          </button>

          <button
            className={`adm-nav-item ${activeTab === "online-users" ? "active" : ""}`}
            onClick={() => setActiveTab("online-users")}
          >
            <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 6v6l4 2" />
            </svg>
            Online Users
          </button>

          <button
            className={`adm-nav-item ${activeTab === "meetings" || activeTab === "meeting-details" ? "active" : ""}`}
            onClick={() => setActiveTab("meetings")}
          >
            <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
              <line x1="16" y1="2" x2="16" y2="6" />
              <line x1="8" y1="2" x2="8" y2="6" />
              <line x1="3" y1="10" x2="21" y2="10" />
            </svg>
            Meetings
          </button>

          <button
            className={`adm-nav-item ${activeTab === "broadcasts" ? "active" : ""}`}
            onClick={() => setActiveTab("broadcasts")}
          >
            <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
              <path d="M13.73 21a2 2 0 0 1-3.46 0" />
            </svg>
            Broadcasts
          </button>

          <div className="adm-nav-section">Insights & Governance</div>
          <button
            className={`adm-nav-item ${activeTab === "analytics" ? "active" : ""}`}
            onClick={() => setActiveTab("analytics")}
          >
            <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
              <line x1="18" y1="20" x2="18" y2="10" />
              <line x1="12" y1="20" x2="12" y2="4" />
              <line x1="6" y1="20" x2="6" y2="14" />
            </svg>
            Analytics
          </button>

          <button
            className={`adm-nav-item ${activeTab === "audit-logs" ? "active" : ""}`}
            onClick={() => setActiveTab("audit-logs")}
          >
            <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
            Audit Logs
          </button>

          <button
            className={`adm-nav-item ${activeTab === "server-logs" ? "active" : ""}`}
            onClick={() => setActiveTab("server-logs")}
          >
            <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
              <rect x="2" y="3" width="20" height="8" rx="2" />
              <rect x="2" y="13" width="20" height="8" rx="2" />
              <line x1="6" y1="7" x2="6.01" y2="7" />
              <line x1="6" y1="17" x2="6.01" y2="17" />
            </svg>
            Server Logs
          </button>

          <div className="adm-nav-section">System</div>
          <button
            className={`adm-nav-item ${activeTab === "settings" ? "active" : ""}`}
            onClick={() => setActiveTab("settings")}
          >
            <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            Admin Settings
          </button>
        </nav>

        {/* Sidebar Footer with Admin Profile */}
        <div className="adm-sidebar-footer">
          <div className="adm-admin-avatar">A</div>
          <div className="adm-admin-meta">
            <div className="adm-admin-role">Super Administrator</div>
            <div className="adm-admin-email" title={admin.email}>{admin.email}</div>
          </div>
          <button
            onClick={handleLogout}
            title="Sign out"
            style={{
              background: "transparent",
              border: "none",
              color: "var(--adm-text-subtle)",
              cursor: "pointer",
              padding: 4,
            }}
          >
            <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
          </button>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="adm-main">
        {/* Top Header */}
        <header className="adm-header">
          <div className="adm-breadcrumbs">
            <span>Admin</span>
            <span>/</span>
            <strong>
              {activeTab === "dashboard" && "Dashboard"}
              {activeTab === "organizations" && "Organizations"}
              {activeTab === "organization-details" && "Organization Details"}
              {activeTab === "members" && "Organization Members"}
              {activeTab === "online-users" && "Online Users"}
              {activeTab === "meetings" && "Meetings Management"}
              {activeTab === "meeting-details" && "Meeting Details"}
              {activeTab === "broadcasts" && "Organization Broadcasts"}
              {activeTab === "analytics" && "Meeting Analytics"}
              {activeTab === "audit-logs" && "Audit Logs"}
              {activeTab === "server-logs" && "Server Logs"}
              {activeTab === "settings" && "Admin Settings"}
            </strong>
          </div>

          <div className="adm-header-actions">
            <a
              href="/"
              target="_blank"
              rel="noreferrer"
              className="adm-btn adm-btn-secondary adm-btn-sm"
              title="Open main Collab workspace"
            >
              Open Collab Workspace ↗
            </a>
          </div>
        </header>

        {/* View Switcher */}
        <div className="adm-content">
          {activeTab === "dashboard" && (
            <DashboardView onNavigate={handleNavigate} onToast={showToast} />
          )}

          {activeTab === "organizations" && (
            <OrganizationsView
              onSelectOrg={(orgId) => {
                setSelectedOrgId(orgId);
                setActiveTab("organization-details");
              }}
              onToast={showToast}
            />
          )}

          {activeTab === "organization-details" && selectedOrgId && (
            <OrganizationDetailView
              orgId={selectedOrgId}
              onBack={() => setActiveTab("organizations")}
              onSelectMeeting={(meetingId) => {
                setSelectedMeetingId(meetingId);
                setActiveTab("meeting-details");
              }}
              onToast={showToast}
            />
          )}

          {activeTab === "members" && (
            <MembersView
              onSelectOrg={(orgId) => {
                setSelectedOrgId(orgId);
                setActiveTab("organization-details");
              }}
              onToast={showToast}
            />
          )}

          {activeTab === "online-users" && (
            <OnlineUsersView
              onSelectMeeting={(meetingId) => {
                setSelectedMeetingId(meetingId);
                setActiveTab("meeting-details");
              }}
              onToast={showToast}
            />
          )}

          {activeTab === "meetings" && (
            <MeetingsView
              onSelectMeeting={(meetingId) => {
                setSelectedMeetingId(meetingId);
                setActiveTab("meeting-details");
              }}
              onSelectOrg={(orgId) => {
                setSelectedOrgId(orgId);
                setActiveTab("organization-details");
              }}
              onToast={showToast}
            />
          )}

          {activeTab === "meeting-details" && selectedMeetingId && (
            <MeetingDetailView
              meetingId={selectedMeetingId}
              onBack={() => setActiveTab("meetings")}
              onSelectOrg={(orgId) => {
                setSelectedOrgId(orgId);
                setActiveTab("organization-details");
              }}
              onToast={showToast}
            />
          )}

          {activeTab === "broadcasts" && (
            <BroadcastsView
              onSelectOrg={(orgId) => {
                setSelectedOrgId(orgId);
                setActiveTab("organization-details");
              }}
              onToast={showToast}
            />
          )}

          {activeTab === "analytics" && (
            <AnalyticsView
              onSelectOrg={(orgId) => {
                setSelectedOrgId(orgId);
                setActiveTab("organization-details");
              }}
              onToast={showToast}
            />
          )}

          {activeTab === "audit-logs" && (
            <AuditLogsView onToast={showToast} />
          )}

          {activeTab === "server-logs" && (
            <ServerLogsView onToast={showToast} />
          )}

          {activeTab === "settings" && (
            <AdminSettingsView
              admin={admin}
              onLogout={handleLogout}
              onToast={showToast}
            />
          )}
        </div>
      </main>

      {/* Global Toast Notifications */}
      <div className="adm-toast-container">
        {toasts.map((t) => (
          <div key={t.id} className={`adm-toast ${t.type}`}>
            {t.msg}
          </div>
        ))}
      </div>
    </div>
  );
}
