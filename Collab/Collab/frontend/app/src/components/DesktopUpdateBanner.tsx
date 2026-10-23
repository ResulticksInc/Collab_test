import React, { useEffect, useRef, useState } from "react";
import { isDesktopApp } from "../lib/platform";
import { IconX } from "../lib/icons";

// Premium in-app update UI for the desktop app. Subscribes to the Electron
// updater's lifecycle (window.collabDesktop.onUpdateEvent) and renders a compact
// bottom-right card: checking → available → downloading (with a live %) →
// downloaded ("Restart to update") → installing. Everything is gated behind the
// desktop bridge, so on the web this renders nothing and the effect never binds.
//
// The whole flow is progress-driven with NO native OS dialogs — the "not a
// separate setup, auto-updates, restart applies changes" experience.

type UpdateEvt =
  | { type: "checking" }
  | { type: "available"; version?: string; notes?: string; auto?: boolean }
  | { type: "downloading"; version?: string; percent?: number; transferred?: number; total?: number }
  | { type: "downloaded"; version?: string; notes?: string }
  | { type: "uptodate"; version?: string }
  | { type: "installing"; manual?: boolean }
  | { type: "error"; stage?: string; message?: string; url?: string };

const cd = () => (window as unknown as { collabDesktop?: any }).collabDesktop;

function fmtMB(bytes?: number): string {
  if (!bytes || bytes <= 0) return "";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

export default function DesktopUpdateBanner() {
  const [evt, setEvt] = useState<UpdateEvt | null>(null);
  const [dismissed, setDismissed] = useState(false);
  // Set when the user clicked "Download & install": the button promises both
  // steps, so once the installer is downloaded we install it without a second
  // "Restart to update" click. (Background auto-downloads never set this — those
  // still wait for the user to choose when to restart.)
  const installWhenReady = useRef(false);

  useEffect(() => {
    if (!isDesktopApp) return;
    const d = cd();
    if (!d || typeof d.onUpdateEvent !== "function") return;
    const off = d.onUpdateEvent((payload: UpdateEvt) => {
      if (!payload || typeof payload.type !== "string") return;
      setEvt(payload);
      setDismissed(false);
      if (payload.type === "downloaded" && installWhenReady.current) {
        installWhenReady.current = false;
        try { d.installUpdate?.(); } catch {}
      } else if (payload.type === "error") {
        installWhenReady.current = false;
      }
    });
    // Replay the current state for a late mount (e.g. the user logged in AFTER
    // the silent startup check fired). Don't clobber a live event that arrived
    // between subscribing and this async resolve (prev || s).
    if (typeof d.getUpdateState === "function") {
      Promise.resolve(d.getUpdateState())
        .then((s: UpdateEvt | null) => {
          if (s && typeof s.type === "string") {
            setEvt((prev) => prev || s);
            setDismissed(false);
          }
        })
        .catch(() => {});
    }
    return () => {
      try {
        if (typeof off === "function") off();
      } catch {}
    };
  }, []);

  // "You're up to date" is informational — auto-dismiss it so it doesn't linger.
  useEffect(() => {
    if (evt && evt.type === "uptodate") {
      const t = setTimeout(() => setDismissed(true), 3500);
      return () => clearTimeout(t);
    }
  }, [evt]);

  if (!isDesktopApp || !evt || dismissed) return null;

  const download = () => { installWhenReady.current = true; try { cd()?.downloadUpdate?.(); } catch {} };
  const install = () => { try { cd()?.installUpdate?.(); } catch {} };
  const recheck = () => { try { cd()?.checkForUpdates?.(); } catch {} };
  const close = () => setDismissed(true);

  const accent = "var(--ac)";
  const t = evt.type;

  // Per-state content.
  let icon: React.ReactNode = null;
  let title = "";
  let body: React.ReactNode = null;
  let actions: React.ReactNode = null;
  let showBar = false;
  let pct = 0;
  let closable = true;

  if (t === "checking") {
    icon = <span className="cuupd-spin" />;
    title = "Checking for updates…";
  } else if (t === "available") {
    icon = <Glyph />;
    title = `Update available${(evt as any).version ? ` — v${(evt as any).version}` : ""}`;
    body = (evt as any).notes ? <span className="cuupd-notes">{(evt as any).notes}</span> : null;
    // auto:true means the updater is already downloading in the background; the
    // "downloading" event will replace this momentarily. Only offer a manual
    // Download when auto-update is OFF.
    actions = (evt as any).auto ? null : (
      <button type="button" className="cuupd-btn cuupd-btn-p" onClick={download}>
        Download &amp; install
      </button>
    );
  } else if (t === "downloading") {
    const e = evt as Extract<UpdateEvt, { type: "downloading" }>;
    pct = Math.max(0, Math.min(100, Math.round(e.percent || 0)));
    icon = <Glyph />;
    title = `Downloading update… ${pct}%`;
    showBar = true;
    // Dismissable: hide the card during a background download without cancelling
    // it — the "downloaded" event re-surfaces it with "Restart to update".
    closable = true;
    body =
      e.total && e.total > 0 ? (
        <span className="cuupd-sub">
          {fmtMB(e.transferred)} of {fmtMB(e.total)}
        </span>
      ) : null;
  } else if (t === "downloaded") {
    icon = <Glyph done />;
    title = `Update ready${(evt as any).version ? ` — v${(evt as any).version}` : ""}`;
    body = <span className="cuupd-sub">Restart Collab to finish installing. Your data and sign-in are kept.</span>;
    actions = (
      <>
        <button type="button" className="cuupd-btn cuupd-btn-p" onClick={install}>
          Restart to update
        </button>
        <button type="button" className="cuupd-btn cuupd-btn-t" onClick={close}>
          Later
        </button>
      </>
    );
  } else if (t === "installing") {
    // manual:true = macOS, where the OS installer opens and the user finishes it —
    // Collab does not restart by itself, so don't show a permanent spinner.
    const manual = !!(evt as any).manual;
    icon = manual ? <Glyph done /> : <span className="cuupd-spin" />;
    title = manual ? "Finish installing the update" : "Installing update…";
    body = (
      <span className="cuupd-sub">
        {manual
          ? "Follow the installer window, then reopen Collab. Your data and sign-in are kept."
          : "Collab will restart automatically."}
      </span>
    );
    closable = manual;
  } else if (t === "uptodate") {
    icon = <Glyph done />;
    title = "You're on the latest version";
  } else if (t === "error") {
    icon = <Glyph error />;
    title = "Couldn't update";
    body = <span className="cuupd-sub">{(evt as any).message || "Please try again in a moment."}</span>;
    actions = (
      <button type="button" className="cuupd-btn cuupd-btn-p" onClick={recheck}>
        Try again
      </button>
    );
  } else {
    return null;
  }

  return (
    <div className="cuupd-wrap" role="status" aria-live="polite">
      <style>{CUUPD_CSS}</style>
      <div className="cuupd-card">
        {closable ? (
          <button type="button" className="cuupd-x" aria-label="Dismiss" onClick={close}>
            <IconX size={13} />
          </button>
        ) : null}
        <div className="cuupd-row">
          <div className="cuupd-icon" style={{ color: accent }}>
            {icon}
          </div>
          <div className="cuupd-main">
            <div className="cuupd-title">{title}</div>
            {body ? <div className="cuupd-body">{body}</div> : null}
            {showBar ? (
              <div className="cuupd-bar" aria-hidden="true">
                <div className="cuupd-fill" style={{ width: pct + "%" }} />
              </div>
            ) : null}
            {actions ? <div className="cuupd-actions">{actions}</div> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

// A small "download to disk" glyph; `done` = check, `error` = alert triangle.
function Glyph({ done, error }: { done?: boolean; error?: boolean }) {
  if (done) {
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20 6 9 17l-5-5" />
      </svg>
    );
  }
  if (error) {
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
        <path d="M12 9v4M12 17h.01" />
      </svg>
    );
  }
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v12M7 10l5 5 5-5" />
      <path d="M5 21h14" />
    </svg>
  );
}

const CUUPD_CSS = `
.cuupd-wrap {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 5900;
  max-width: calc(100vw - 40px);
  animation: cuupd-in 260ms cubic-bezier(0.16, 1, 0.3, 1);
}
@keyframes cuupd-in { from { opacity: 0; transform: translateY(12px) scale(0.98); } to { opacity: 1; transform: none; } }
.cuupd-card {
  position: relative;
  width: 340px;
  max-width: 100%;
  background: var(--card, #fff);
  border: 1px solid var(--g200, #e5e7eb);
  border-radius: 14px;
  box-shadow: var(--shm, 0 8px 24px rgba(16,24,40,.12));
  padding: 14px 16px;
}
.cuupd-x {
  position: absolute; top: 8px; right: 8px;
  width: 24px; height: 24px; display: flex; align-items: center; justify-content: center;
  border: 0; background: transparent; color: var(--g500, #6b7280);
  border-radius: 7px; cursor: pointer;
}
.cuupd-x:hover { background: color-mix(in srgb, var(--g500, #6b7280) 14%, transparent); }
.cuupd-row { display: flex; gap: 12px; align-items: flex-start; }
.cuupd-icon { flex: 0 0 auto; width: 34px; height: 34px; display: flex; align-items: center; justify-content: center;
  border-radius: 9px; background: color-mix(in srgb, var(--ac) 14%, transparent); }
.cuupd-main { flex: 1 1 auto; min-width: 0; padding-right: 14px; }
.cuupd-title { font-size: 13.5px; font-weight: 650; color: var(--g900, #111827); line-height: 1.35; }
.cuupd-body { margin-top: 3px; }
.cuupd-sub, .cuupd-notes { font-size: 12px; color: var(--g500, #6b7280); line-height: 1.4; }
.cuupd-notes { display: block; max-height: 46px; overflow: hidden; }
.cuupd-bar { margin-top: 9px; height: 6px; border-radius: 999px; background: color-mix(in srgb, var(--ac) 16%, transparent); overflow: hidden; }
.cuupd-fill { height: 100%; border-radius: 999px; background: var(--ac); transition: width 220ms ease; }
.cuupd-actions { display: flex; gap: 8px; margin-top: 11px; }
.cuupd-btn { font-size: 12.5px; font-weight: 600; border-radius: 8px; padding: 7px 12px; cursor: pointer; border: 1px solid transparent; line-height: 1; }
.cuupd-btn-p { background: var(--ac); color: #fff; }
.cuupd-btn-p:hover { filter: brightness(1.06); }
.cuupd-btn-t { background: transparent; color: var(--g700, #374151); border-color: var(--g200, #e5e7eb); }
.cuupd-btn-t:hover { background: color-mix(in srgb, var(--g500, #6b7280) 10%, transparent); }
.cuupd-spin { width: 18px; height: 18px; border-radius: 50%; border: 2.4px solid color-mix(in srgb, var(--ac) 28%, transparent); border-top-color: var(--ac); animation: cuupd-spin 720ms linear infinite; display: block; }
@keyframes cuupd-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .cuupd-wrap { animation: none; }
  .cuupd-spin { animation-duration: 1400ms; }
  .cuupd-fill { transition: none; }
}
`;
