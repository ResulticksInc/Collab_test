"use client";
import React, { useEffect, useState } from "react";
import { api } from "../lib/api";

/**
 * Enterprise onboarding gate (Teams/Slack/Notion-style). Shown ONLY when an
 * authenticated user belongs to ZERO organizations — a platform account is separate
 * from org membership. The user must Create an organization (→ becomes Owner, enters
 * immediately) or Join one (→ a pending request an admin approves; the user waits
 * outside the org until then). Self-contained styling (inline + CSS vars) so it can't
 * collide with app CSS and renders correctly in every theme.
 */
type Mode = "choose" | "create" | "join" | "sent";
// Org discovery by NAME is deliberately not offered — the org list is sensitive
// (it would let anyone enumerate every tenant). You join only with a code or an
// invite link you were given out-of-band.
type JoinBy = "code" | "link";

export default function OrgOnboarding({
  token,
  me,
  onEntered,
  onSignOut,
  onSkip,
}: {
  token: string;
  me?: any;
  onEntered: (enteredOrgId?: string) => void; // membership acquired → pivot session + enter app
  onSignOut: () => void;
  // Continue as a normal platform user WITHOUT an org (not forced to create/join).
  // Also used to close this flow when it's re-opened later from the org switcher.
  onSkip?: () => void;
}) {
  const [mode, setMode] = useState<Mode>("choose");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // Create
  const [orgName, setOrgName] = useState("");

  // Join
  const [joinBy, setJoinBy] = useState<JoinBy>("code");
  const [code, setCode] = useState("");
  const [link, setLink] = useState("");
  const [sentOrgName, setSentOrgName] = useState("");

  // A returning zero-org user who already has a pending request lands straight on
  // the "Request Sent" state instead of the chooser.
  const [loadingPending, setLoadingPending] = useState(true);
  useEffect(() => {
    if (!token) return;
    let alive = true;
    api
      .myJoinRequests(token)
      .then((rows: any[]) => {
        if (!alive) return;
        const pending = (rows || []).find((r) => r.status === "pending");
        if (pending) {
          setSentOrgName(pending.orgName || "the organization");
          setMode("sent");
        }
      })
      .catch(() => {})
      .finally(() => alive && setLoadingPending(false));
    return () => {
      alive = false;
    };
  }, [token]);

  const firstName = (me?.name || "").split(" ")[0];

  const createOrg = async () => {
    const name = orgName.trim();
    if (name.length < 2) {
      setErr("Enter an organization name (at least 2 characters).");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const created = await api.provisionOrg(token, name);
      // now an owner of a live org → hand the new org id up so the parent pivots
      // the session to it and re-hydrates the shell on that org.
      onEntered(created?.activeOrgId || created?.org?.id);
    } catch (e: any) {
      setErr(e?.message || "Couldn't create the organization. Please try again.");
      setBusy(false);
    }
  };

  const submitRequest = async (body: { orgId?: string; slug?: string }, fallbackName: string) => {
    setBusy(true);
    setErr("");
    try {
      const out = await api.requestJoinOrg(token, body);
      setSentOrgName((out && out.org && out.org.name) || fallbackName || "the organization");
      setMode("sent");
    } catch (e: any) {
      setErr(e?.message || "Couldn't send the request. Check the details and try again.");
    } finally {
      setBusy(false);
    }
  };

  // "Check again" on the Request-Sent screen: re-poll for approval. If an admin has
  // approved (the user now belongs to an org) we enter the app WITH that org; if it's
  // still pending we stay put and say so — distinct from "Continue to Collab", which
  // enters as an org-less user regardless.
  const [checked, setChecked] = useState(false);
  const checkAgain = async () => {
    setBusy(true);
    setErr("");
    try {
      const orgs = await api.listOrgs(token);
      if (Array.isArray(orgs) && orgs.length > 0) {
        // Approved → the (re)joined org is the user's only org here; hand its id
        // up so the parent pivots the session to it and re-hydrates the shell.
        onEntered(orgs[0]?.id);
        return;
      }
      setChecked(true);
    } catch (e: any) {
      setErr(e?.message || "Couldn't check your request status.");
    } finally {
      setBusy(false);
    }
  };

  // Extract a slug from a pasted invite link (…/join/<slug>) or a raw code.
  const slugFromLink = (raw: string) =>
    String(raw || "")
      .trim()
      .replace(/[?#].*$/, "")
      .split("/")
      .filter(Boolean)
      .pop() || "";

  return (
    <div style={S.overlay}>
      <div style={S.card}>
        <div style={S.brand}>Collab</div>

        {mode === "choose" && (
          <>
            <h1 style={S.h1}>Welcome to Collab{firstName ? `, ${firstName}` : ""}</h1>
            <p style={S.sub}>Choose how you would like to get started.</p>
            <div style={S.optWrap}>
              <button style={S.opt} onClick={() => { setErr(""); setMode("create"); }}>
                <span style={{ ...S.optIcon, background: "var(--ac, #6366F1)" }}>{ICON.plus}</span>
                <span style={S.optText}>
                  <span style={S.optTitle}>Create organization</span>
                  <span style={S.optDesc}>Create a new organization and become its Owner.</span>
                </span>
                <span style={S.optChevron}>{ICON.chevron}</span>
              </button>
              <button
                style={S.opt}
                onClick={() => { setErr(""); setMode("join"); }}
              >
                <span style={{ ...S.optIcon, background: "var(--g500, #64748B)" }}>{ICON.users}</span>
                <span style={S.optText}>
                  <span style={S.optTitle}>Join organization</span>
                  <span style={S.optDesc}>Request access to an existing organization.</span>
                </span>
                <span style={S.optChevron}>{ICON.chevron}</span>
              </button>
            </div>
            {onSkip ? (
              <button
                style={{ background: "none", border: "none", color: "var(--g500)", fontSize: 13, cursor: "pointer", marginTop: 16, textDecoration: "underline", padding: 4, alignSelf: "flex-start" }}
                onClick={onSkip}
              >
                Continue without an organization
              </button>
            ) : null}
          </>
        )}

        {mode === "create" && (
          <>
            <h1 style={S.h1}>Create your organization</h1>
            <p style={S.sub}>You’ll be its Owner. You can rename it and invite people afterward.</p>
            <label style={S.label}>Organization name</label>
            <input
              style={S.input}
              value={orgName}
              autoFocus
              maxLength={120}
              placeholder="e.g. Acme Inc."
              onChange={(e) => setOrgName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !busy && createOrg()}
            />
            {err ? <div style={S.err}>{err}</div> : null}
            <div style={S.row}>
              <button style={S.ghost} onClick={() => { setErr(""); setMode("choose"); }} disabled={busy}>Back</button>
              <button style={{ ...S.primary, ...(busy ? S.disabled : {}) }} onClick={createOrg} disabled={busy}>
                {busy ? "Creating…" : "Create organization"}
              </button>
            </div>
          </>
        )}

        {mode === "join" && (
          <>
            <h1 style={S.h1}>Join an organization</h1>
            <p style={S.sub}>Enter your organization’s code, or paste an invite link you were given.</p>
            <div style={S.segwrap}>
              {(["code", "link"] as JoinBy[]).map((k) => (
                <button
                  key={k}
                  style={{ ...S.seg, ...(joinBy === k ? S.segOn : {}) }}
                  onClick={() => { setJoinBy(k); setErr(""); }}
                >
                  {k === "code" ? "Organization code" : "Invite link"}
                </button>
              ))}
            </div>

            {joinBy === "code" && (
              <>
                <label style={S.label}>Organization code</label>
                <input
                  style={S.input}
                  value={code}
                  autoFocus
                  placeholder="e.g. acme"
                  onChange={(e) => setCode(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && !busy && code.trim() && submitRequest({ slug: code.trim().toLowerCase() }, code.trim())}
                />
                <button
                  style={{ ...S.primary, marginTop: 12, ...(busy || !code.trim() ? S.disabled : {}) }}
                  disabled={busy || !code.trim()}
                  onClick={() => submitRequest({ slug: code.trim().toLowerCase() }, code.trim())}
                >
                  {busy ? "Sending…" : "Request to join"}
                </button>
              </>
            )}

            {joinBy === "link" && (
              <>
                <label style={S.label}>Invite link</label>
                <input
                  style={S.input}
                  value={link}
                  autoFocus
                  placeholder="https://…/join/acme"
                  onChange={(e) => setLink(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && !busy && slugFromLink(link) && submitRequest({ slug: slugFromLink(link).toLowerCase() }, slugFromLink(link))}
                />
                <button
                  style={{ ...S.primary, marginTop: 12, ...(busy || !slugFromLink(link) ? S.disabled : {}) }}
                  disabled={busy || !slugFromLink(link)}
                  onClick={() => submitRequest({ slug: slugFromLink(link).toLowerCase() }, slugFromLink(link))}
                >
                  {busy ? "Sending…" : "Request to join"}
                </button>
              </>
            )}

            <div style={S.hint}>
              <span style={S.hintIcon}>{ICON.shield}</span>
              <span style={S.hintText}>
                <b style={S.hintLead}>Access is granted by your organization’s admins.</b>{" "}
                Don’t have a code or invite link? Reach out to your organization’s owner or an
                administrator — they can share it or add you in seconds.
              </span>
            </div>

            {err ? <div style={S.err}>{err}</div> : null}
            <div style={{ ...S.row, marginTop: 16 }}>
              <button style={S.ghost} onClick={() => { setErr(""); setMode("choose"); }} disabled={busy}>Back</button>
            </div>
          </>
        )}

        {mode === "sent" && (
          <div style={{ textAlign: "center" }}>
            <div style={S.sentIcon}>{ICON.check}</div>
            <h1 style={S.h1}>Request sent</h1>
            <p style={S.sub}>
              Your request to join <b>{sentOrgName}</b> has been sent to the organization’s administrators.
              You’ll receive a notification once it’s been reviewed.
            </p>
            {checked ? (
              <p style={{ ...S.muted, textAlign: "center", marginTop: 6 }}>
                Still pending — an administrator hasn’t approved it yet.
              </p>
            ) : null}
            <div style={{ ...S.row, justifyContent: "center", marginTop: 20, flexWrap: "wrap" }}>
              <button style={S.ghost} onClick={() => { setErr(""); setChecked(false); setMode("choose"); }} disabled={busy}>
                Create or join another
              </button>
              <button style={S.ghost} onClick={checkAgain} disabled={busy}>
                {busy ? "Checking…" : "Check again"}
              </button>
              {onSkip ? (
                <button style={S.primary} onClick={onSkip}>Continue to Collab</button>
              ) : null}
            </div>
          </div>
        )}

        <div style={S.foot}>
          <span style={S.footMe}>{me?.email || ""}</span>
          <button style={S.link} onClick={onSignOut}>Sign out</button>
        </div>
      </div>
    </div>
  );
}

const ICON = {
  plus: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
  ),
  users: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></svg>
  ),
  chevron: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6" /></svg>
  ),
  check: (
    <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
  ),
  shield: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="m9 12 2 2 4-4" /></svg>
  ),
};

const S: Record<string, React.CSSProperties> = {
  overlay: {
    position: "fixed", inset: 0, zIndex: 5000, background: "var(--bg, #f8f9fb)",
    display: "flex", alignItems: "center", justifyContent: "center", padding: 20, overflow: "auto",
  },
  card: {
    width: 520, maxWidth: "100%", background: "var(--card, #fff)",
    border: "1px solid var(--g200, #e5e7eb)", borderRadius: 16,
    boxShadow: "0 24px 60px rgba(15,18,28,.18)", padding: 28,
  },
  brand: { fontSize: 15, fontWeight: 800, letterSpacing: "-0.01em", color: "var(--ac, #6366F1)", marginBottom: 18 },
  h1: { fontSize: 22, fontWeight: 700, color: "var(--g900, #111827)", margin: "0 0 6px", lineHeight: 1.2 },
  sub: { fontSize: 13.5, color: "var(--g500, #6b7280)", margin: "0 0 18px", lineHeight: 1.5 },
  optWrap: { display: "flex", flexDirection: "column", gap: 12 },
  opt: {
    display: "flex", alignItems: "center", gap: 14, textAlign: "left", width: "100%",
    padding: 16, borderRadius: 12, border: "1px solid var(--g200, #e5e7eb)",
    background: "var(--sb, #fff)", cursor: "pointer",
  },
  optIcon: { flex: "0 0 auto", width: 42, height: 42, borderRadius: 11, display: "flex", alignItems: "center", justifyContent: "center" },
  optText: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 3 },
  optTitle: { fontSize: 15, fontWeight: 650, color: "var(--g900, #111827)" },
  optDesc: { fontSize: 12.5, color: "var(--g500, #6b7280)", lineHeight: 1.45 },
  optChevron: { flex: "0 0 auto", color: "var(--g400, #9ca3af)", display: "inline-flex" },
  label: { display: "block", fontSize: 12, fontWeight: 600, color: "var(--g700, #374151)", margin: "4px 0 6px" },
  input: {
    width: "100%", height: 42, padding: "0 14px", fontSize: 14, boxSizing: "border-box",
    border: "1px solid var(--g200, #e5e7eb)", borderRadius: 10, background: "var(--sb, #fff)",
    color: "var(--g900, #111827)", outline: "none",
  },
  segwrap: { display: "flex", gap: 6, background: "var(--bg, #f3f4f6)", padding: 4, borderRadius: 10, marginBottom: 14 },
  seg: {
    flex: 1, padding: "8px 6px", fontSize: 12.5, fontWeight: 600, borderRadius: 7, border: "none",
    background: "transparent", color: "var(--g500, #6b7280)", cursor: "pointer",
  },
  segOn: { background: "var(--card, #fff)", color: "var(--g900, #111827)", boxShadow: "0 1px 3px rgba(0,0,0,.08)" },
  results: { marginTop: 12, display: "flex", flexDirection: "column", gap: 8, maxHeight: 260, overflow: "auto" },
  resRow: { display: "flex", alignItems: "center", gap: 12, padding: "9px 12px", border: "1px solid var(--g200, #e5e7eb)", borderRadius: 10 },
  resAv: { flex: "0 0 auto", width: 34, height: 34, borderRadius: 9, background: "var(--ac, #6366F1)", color: "#fff", fontSize: 12, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center" },
  resInfo: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column" },
  resName: { fontSize: 13.5, fontWeight: 600, color: "var(--g900, #111827)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  resSub: { fontSize: 11.5, color: "var(--g500, #6b7280)" },
  row: { display: "flex", gap: 10, justifyContent: "space-between", marginTop: 18 },
  primary: {
    padding: "10px 18px", fontSize: 13.5, fontWeight: 700, border: "none", borderRadius: 10,
    // Collab brand button — the purple gradient used across the app (Modal primary,
    // org badge, etc.), not the generic indigo accent.
    background: "var(--brand-cta-gradient)", color: "#fff", cursor: "pointer",
  },
  small: { padding: "7px 14px", fontSize: 12.5, fontWeight: 700, border: "none", borderRadius: 8, background: "var(--brand-cta-gradient)", color: "#fff", cursor: "pointer", flex: "0 0 auto" },
  ghost: {
    padding: "10px 18px", fontSize: 13.5, fontWeight: 600, borderRadius: 10,
    border: "1px solid var(--g200, #e5e7eb)", background: "transparent", color: "var(--g700, #374151)", cursor: "pointer",
  },
  disabled: { opacity: 0.55, cursor: "not-allowed" },
  // Enterprise "reach out to your admin" callout on the Join screen (brand-tinted).
  hint: {
    display: "flex", gap: 11, alignItems: "flex-start", marginTop: 16, padding: "12px 14px",
    borderRadius: 11, background: "rgba(139,41,190,0.07)", border: "1px solid rgba(139,41,190,0.22)",
  },
  hintIcon: { flex: "0 0 auto", color: "#a855f7", display: "inline-flex", marginTop: 1 },
  hintText: { fontSize: 12.5, color: "var(--g600, #4b5563)", lineHeight: 1.55 },
  hintLead: { color: "var(--g900, #111827)", fontWeight: 700 },
  tag: { flex: "0 0 auto", fontSize: 11.5, fontWeight: 600, color: "var(--g500, #6b7280)", background: "var(--bg, #f3f4f6)", padding: "5px 10px", borderRadius: 999 },
  err: { marginTop: 12, fontSize: 12.5, color: "#dc2626", background: "rgba(220,38,38,.08)", border: "1px solid rgba(220,38,38,.25)", borderRadius: 8, padding: "8px 12px" },
  muted: { fontSize: 12.5, color: "var(--g500, #6b7280)", padding: "8px 2px" },
  sentIcon: { width: 60, height: 60, borderRadius: "50%", background: "var(--grn, #16a34a)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" },
  foot: { display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 22, paddingTop: 16, borderTop: "1px solid var(--g150, var(--g200, #eef0f3))" },
  footMe: { fontSize: 12, color: "var(--g500, #6b7280)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  link: { fontSize: 12.5, fontWeight: 600, color: "var(--ac, #6366F1)", background: "none", border: "none", cursor: "pointer", flex: "0 0 auto" },
};
