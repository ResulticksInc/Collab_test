import React from "react";
import { fmtWhen } from "./helpers";

// ── Max-devices reached prompt ──────────────────────────────────────────────
// Shown when a login is refused because the account is at its active-session
// limit. The user picks a device to sign out (never silent) or cancels. Rows
// are sorted oldest-first so "Sign out oldest" targets the least-recently-used.
// Extracted verbatim from CoLabV1.tsx (decomposition step 2) — self-contained,
// prop-driven, no dependency on CoLabV1 state; behaviour is unchanged.
export default function MaxDevicesModal({
  prompt,
  busy,
  onSignOutDevice,
  onContinue,
  onCancel,
}: {
  prompt: any;
  busy: boolean;
  onSignOutDevice: (sid: string) => void; // revoke ONE device, keep this modal open
  onContinue: () => void; // finish sign-in on this device (only once under the cap)
  onCancel: () => void;
}) {
  const sessions = (prompt?.sessions || [])
    .slice()
    .sort((a: any, b: any) =>
      String(a.lastActiveAt || "").localeCompare(String(b.lastActiveAt || "")),
    ); // oldest first
  const max = prompt?.max ?? sessions.length;
  const active = prompt?.active != null ? prompt.active : sessions.length;
  // Room for THIS device = the active count is below the cap. `underLimit` is set by
  // the evict endpoint after each sign-out; before any sign-out we're at the cap.
  const underLimit = prompt?.underLimit != null ? prompt.underLimit : active < max;
  const needMore = underLimit ? 0 : Math.max(1, active - max + 1);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Maximum devices reached"
      onClick={busy ? undefined : onCancel}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        background: "rgba(0,0,0,.55)",
        backdropFilter: "blur(2px)",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(440px, 100%)",
          maxHeight: "88vh",
          overflow: "auto",
          // Theme tokens (were undefined --surface/--border, so the modal stayed
          // white with light text in dark mode → invisible). Use the real tokens.
          background: "var(--card, #fff)",
          color: "var(--g900, #111)",
          border: "1px solid var(--g200)",
          borderRadius: 14,
          boxShadow: "0 24px 64px rgba(0,0,0,.35)",
          padding: 22,
        }}
      >
        <h3 style={{ margin: "0 0 6px", fontSize: 18, fontWeight: 650, color: "var(--g900)" }}>
          Maximum devices reached
        </h3>
        <p style={{ margin: "0 0 16px", color: "var(--g500)", fontSize: 14, lineHeight: 1.5 }}>
          Your account is signed in on {max} device{max === 1 ? "" : "s"}. Sign out the
          ones you no longer use — you can remove several — then continue on this device.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 }}>
          {sessions.map((s: any) => (
            <div
              key={s.id}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                padding: "10px 12px",
                borderRadius: 10,
                border: "1px solid var(--g200)",
                background: "var(--bg)",
              }}
            >
              <span style={{ minWidth: 0 }}>
                <span style={{ display: "block", fontWeight: 600, fontSize: 14, color: "var(--g900)" }}>
                  {s.deviceLabel || "Unknown device"}
                </span>
                <span style={{ display: "block", fontSize: 12, color: "var(--g500)" }}>
                  {[s.location, s.platform, fmtWhen(s.lastActiveAt)]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() => onSignOutDevice(s.id)}
                style={{
                  flex: "0 0 auto",
                  padding: "6px 12px",
                  borderRadius: 8,
                  border: "1px solid var(--g200)",
                  background: "var(--card)",
                  color: "var(--ac, #6366F1)",
                  fontSize: 13,
                  fontWeight: 600,
                  whiteSpace: "nowrap",
                  cursor: busy ? "default" : "pointer",
                  opacity: busy ? 0.6 : 1,
                }}
              >
                Sign out
              </button>
            </div>
          ))}
        </div>
        {!underLimit ? (
          <p style={{ margin: "0 0 14px", fontSize: 12.5, color: "var(--g500)" }}>
            Sign out {needMore} more to continue on this device.
          </p>
        ) : null}
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            style={{
              padding: "9px 16px",
              borderRadius: 10,
              border: "1px solid var(--g200)",
              background: "transparent",
              color: "var(--g700)",
              fontWeight: 600,
              cursor: busy ? "default" : "pointer",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || !underLimit}
            onClick={onContinue}
            title={underLimit ? "" : "Sign out a device first"}
            style={{
              padding: "9px 16px",
              borderRadius: 10,
              border: "none",
              background: "var(--brand-cta-gradient)",
              color: "#fff",
              fontWeight: 650,
              cursor: busy || !underLimit ? "not-allowed" : "pointer",
              opacity: busy || !underLimit ? 0.5 : 1,
            }}
          >
            {busy ? "Working…" : "Continue on this device"}
          </button>
        </div>
      </div>
    </div>
  );
}
