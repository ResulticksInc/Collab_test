"use client";
import React, { useState, useEffect, useCallback } from "react";
import { api } from "../../lib/api";
import { confirmDialog } from "../../lib/dialog";
import { localTime, localDay } from "../../lib/time";
import { IconMonitor, IconShield } from "../../lib/icons";

function relativeTime(iso: string | number | Date | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!isFinite(t)) return "—";
  const diff = Date.now() - t;
  if (diff < 0) return "just now";
  const min = Math.floor(diff / 60000);
  if (min < 1) return "Active now";
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  return `${localDay(iso)} ${localTime(iso)}`;
}

export default function ActiveSessionsPanel({ token }: { token: string | null }) {
  const [sessions, setSessions] = useState<any[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!token) return;
    setErr(null);
    api
      .listSessions(token)
      .then((r: any) => setSessions((r && r.sessions) || []))
      .catch(() => setErr("Couldn't load your active sessions."));
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  const revokeOne = async (id: string, isCurrent?: boolean) => {
    if (!token) return;
    if (isCurrent) {
      const okToGo = await confirmDialog(
        "Sign out of THIS device? You'll be returned to the sign-in screen.",
        { title: "Sign out", confirmText: "Sign out", danger: true },
      );
      if (!okToGo) return;
    }
    setBusy(id);
    try {
      await api.revokeSession(token, id);
      if (isCurrent) {
        if (typeof window !== "undefined")
          window.dispatchEvent(new Event("colab:unauthorized"));
        return;
      }
      setSessions((prev) => (prev || []).filter((s) => s.id !== id));
    } catch {
      setErr("Couldn't sign out that session.");
    } finally {
      setBusy(null);
    }
  };

  const revokeOthers = async () => {
    if (!token) return;
    setBusy("__others__");
    try {
      await api.revokeOtherSessions(token);
      setSessions((prev) => (prev || []).filter((s) => s.current));
      load();
    } catch {
      setErr("Couldn't sign out the other sessions.");
    } finally {
      setBusy(null);
    }
  };

  const visible = (sessions || []).filter((s) => !s.revoked);
  const others = visible.filter((s) => !s.current);

  return (
    <div className="sessions-panel" style={{ marginTop: 18 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 8,
        }}
      >
        <h4 style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>Active sessions</h4>
        {others.length > 0 && (
          <button
            className="btn-c"
            disabled={busy === "__others__"}
            onClick={revokeOthers}
            style={{ fontSize: 12, padding: "5px 10px" }}
          >
            {busy === "__others__" ? "Signing out…" : "Sign out all other sessions"}
          </button>
        )}
      </div>
      <p className="agt-note" style={{ marginTop: 0 }}>
        Devices and browsers where you are signed in. Sign out any you don&apos;t
        recognise.
      </p>
      {err && (
        <div style={{ color: "#dc2626", fontSize: 12, margin: "6px 0" }}>{err}</div>
      )}
      {sessions === null ? (
        <div className="agt-note">Loading…</div>
      ) : visible.length === 0 ? (
        <div className="agt-note">No active sessions.</div>
      ) : (
        visible.map((s) => (
          <div className="dev-row" key={s.id}>
            <div className="dev-ic">
              {s.platform === "desktop" || s.deviceType === "desktop" ? (
                <IconMonitor size={20} />
              ) : (
                <IconShield size={20} />
              )}
            </div>
            <div className="dev-body">
              <div className="dev-name">
                {s.deviceLabel || "Unknown device"}
                {s.current && (
                  <span className="dev-badge" style={{ marginLeft: 8 }}>
                    This device
                  </span>
                )}
                {!s.current && s.status === "idle" && (
                  <span
                    className="dev-badge"
                    style={{
                      marginLeft: 8,
                      background: "var(--g100)",
                      color: "var(--g500)",
                    }}
                  >
                    Idle
                  </span>
                )}
              </div>
              <div className="dev-meta">
                {relativeTime(s.lastActiveAt)}
                {s.location
                  ? ` · ${s.location}`
                  : s.ip
                    ? ` · ${s.ip}`
                    : ""}{" "}
                · Signed in {localDay(s.createdAt)}
              </div>
            </div>
            <button
              className="btn-c"
              disabled={busy === s.id}
              onClick={() => revokeOne(s.id, s.current)}
              style={{ fontSize: 12, padding: "5px 10px" }}
            >
              {busy === s.id
                ? "…"
                : s.current
                  ? "Sign out this device"
                  : "Sign out"}
            </button>
          </div>
        ))
      )}
    </div>
  );
}
