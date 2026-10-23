import React from "react";

interface AdminSettingsViewProps {
  admin: { email: string; role: string } | null;
  onLogout: () => void;
  onToast: (msg: string, type?: "success" | "error") => void;
}

export default function AdminSettingsView({ admin, onLogout }: AdminSettingsViewProps) {
  return (
    <div style={{ maxWidth: 800 }}>
      {/* Admin Profile Panel */}
      <div className="adm-panel" style={{ padding: 24, marginBottom: 20 }}>
        <h3 className="adm-panel-title" style={{ marginBottom: 16 }}>
          <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="7" r="4" />
          </svg>
          Admin Profile & Security Information
        </h3>

        <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 20 }}>
          <div
            style={{
              width: 52,
              height: 52,
              borderRadius: "50%",
              background: "linear-gradient(135deg, #6366f1, #8b5cf6)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#fff",
              fontWeight: 800,
              fontSize: 20,
            }}
          >
            A
          </div>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: "#fff" }}>{admin?.email || "Super Admin"}</div>
            <div style={{ fontSize: 13, color: "var(--adm-text-muted)" }}>
              Role: <span className="adm-badge adm-badge-success">{admin?.role || "superadmin"}</span>
            </div>
          </div>
        </div>

        <div style={{ background: "var(--adm-surface-2)", borderRadius: "var(--adm-radius-sm)", padding: 16, marginBottom: 20 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#fff", marginBottom: 6 }}>
            Decoupled Administrative Session
          </div>
          <div style={{ fontSize: 12.5, color: "var(--adm-text-subtle)", lineHeight: 1.5 }}>
            This administrator account is authenticated independently using environment variables (<code>ADMIN_EMAIL</code> / <code>ADMIN_PASSWORD</code>) and operates outside standard tenant user sessions.
          </div>
        </div>

        <button className="adm-btn adm-btn-danger" onClick={onLogout}>
          Sign Out of Admin Panel
        </button>
      </div>

      {/* System Information Panel */}
      <div className="adm-panel" style={{ padding: 24 }}>
        <h3 className="adm-panel-title" style={{ marginBottom: 16 }}>
          <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="16" x2="12" y2="12" />
            <line x1="12" y1="8" x2="12.01" y2="8" />
          </svg>
          System Configuration & Status
        </h3>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, fontSize: 13 }}>
          <div style={{ padding: 12, background: "var(--adm-surface-2)", borderRadius: "var(--adm-radius-sm)" }}>
            <div style={{ color: "var(--adm-text-subtle)", marginBottom: 4 }}>Environment</div>
            <div style={{ fontWeight: 600, color: "#fff" }}>Production / Docker Multi-Tenant</div>
          </div>
          <div style={{ padding: 12, background: "var(--adm-surface-2)", borderRadius: "var(--adm-radius-sm)" }}>
            <div style={{ color: "var(--adm-text-subtle)", marginBottom: 4 }}>Admin Session TTL</div>
            <div style={{ fontWeight: 600, color: "#fff" }}>12 Hours</div>
          </div>
          <div style={{ padding: 12, background: "var(--adm-surface-2)", borderRadius: "var(--adm-radius-sm)" }}>
            <div style={{ color: "var(--adm-text-subtle)", marginBottom: 4 }}>Rate Limiting</div>
            <div style={{ fontWeight: 600, color: "var(--adm-success)" }}>Active (20 req / 15m)</div>
          </div>
          <div style={{ padding: 12, background: "var(--adm-surface-2)", borderRadius: "var(--adm-radius-sm)" }}>
            <div style={{ color: "var(--adm-text-subtle)", marginBottom: 4 }}>Audit Trail</div>
            <div style={{ fontWeight: 600, color: "var(--adm-success)" }}>Enabled (Append-only)</div>
          </div>
        </div>
      </div>
    </div>
  );
}
