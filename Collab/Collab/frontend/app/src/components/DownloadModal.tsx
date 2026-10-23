import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import QrCode from "./QrCode";
import { Select } from "./ui";

// Enterprise "Download Collab" modal — leads with ONE big "Download for <your
// OS>" button (device-detected), the rest of the platforms tucked behind an
// "Other platforms" toggle (Slack/Zoom/Discord pattern) so most visitors never
// see a platform list at all. Data comes from the same /desktop/latest.json
// manifest the rail already fetches. Self-contained styling.

export type DlOpt = {
  key: string;
  os: "win" | "mac" | "linux";
  label: string;
  sub: string;
  url: string;
  size?: number;
  // Manifest's explicit "is this build published?" flag. When set it is
  // AUTHORITATIVE (true → always offer Download, false → always "Coming soon"),
  // overriding the runtime HEAD probe below. Undefined → fall back to the probe.
  available?: boolean;
};

function fmtSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return "";
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? (mb / 1024).toFixed(1) + " GB" : Math.round(mb) + " MB";
}

function detectOS(): string {
  if (typeof navigator === "undefined") return "";
  const p = (
    (navigator as any).userAgentData?.platform ||
    navigator.platform ||
    navigator.userAgent ||
    ""
  ).toLowerCase();
  if (p.includes("win")) return "win";
  if (p.includes("mac") || p.includes("iphone") || p.includes("ipad")) return "mac";
  if (p.includes("linux") || p.includes("x11")) return "linux";
  return "";
}

function osDisplayName(os: string): string {
  return os === "win" ? "Windows" : os === "mac" ? "macOS" : "Linux";
}

// ── Mobile apps (App Store / Google Play) ────────────────────────────────────
// Published store listings. Overridable per deployment via NEXT_PUBLIC_* so a
// white-label or regional build can point elsewhere without a code change.
export type MobileOpt = { key: "ios" | "android"; label: string; sub: string; url: string };
export const MOBILE_APPS: MobileOpt[] = [
  {
    key: "ios",
    label: "App Store",
    sub: "iPhone & iPad",
    url: process.env.NEXT_PUBLIC_APP_STORE_URL || "https://apps.apple.com/us/app/collab-resulticks/id6793890710",
  },
  {
    key: "android",
    label: "Google Play",
    sub: "Android",
    url: process.env.NEXT_PUBLIC_PLAY_STORE_URL || "https://play.google.com/store/apps/details?id=com.resulticks.collab",
  },
];

// A phone/tablet visitor should be sent to its own store first, not to a
// desktop installer it can't run (detectOS maps iPhone/iPad to "mac").
function detectMobile(): "ios" | "android" | "" {
  if (typeof navigator === "undefined") return "";
  const ua = (navigator.userAgent || "").toLowerCase();
  const touchMac = ua.includes("macintosh") && (navigator as any).maxTouchPoints > 1; // iPadOS desktop UA
  if (/iphone|ipad|ipod/.test(ua) || touchMac) return "ios";
  if (ua.includes("android")) return "android";
  return "";
}

function StoreIcon({ store }: { store: "ios" | "android" }) {
  if (store === "ios") return <OSIcon os="mac" />;
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M4.2 2.6c-.3.3-.5.8-.5 1.4v16c0 .6.2 1.1.5 1.4l9.3-9.4-9.3-9.4z" />
      <path d="M16.6 15.1 6.2 21.1c-.5.3-.9.3-1.3.2l9.3-9.3 2.4 3.1z" />
      <path d="m19.8 13.2-3.2 1.9-2.4-3.1 2.4-3.1 3.2 1.9c1 .6 1 1.8 0 2.4z" />
      <path d="M16.6 8.9 6.2 2.9c-.5-.3-.9-.3-1.3-.2L14.2 12l2.4-3.1z" />
    </svg>
  );
}

function OSIcon({ os }: { os: string }) {
  const c = "currentColor";
  if (os === "win")
    return (
      <svg width="22" height="22" viewBox="0 0 24 24" fill={c} aria-hidden="true">
        <path d="M3 5.5 10.5 4.4v7.1H3zM11.5 4.25 21 3v8.5h-9.5zM3 12.5h7.5v7.1L3 18.5zM11.5 12.5H21V21l-9.5-1.3z" />
      </svg>
    );
  if (os === "mac")
    return (
      <svg width="22" height="22" viewBox="0 0 24 24" fill={c} aria-hidden="true">
        <path d="M16.36 12.9c.02 2.36 2.07 3.14 2.1 3.15-.02.06-.33 1.13-1.08 2.23-.65.96-1.32 1.91-2.38 1.93-1.04.02-1.37-.61-2.56-.61-1.19 0-1.56.59-2.54.63-1.02.04-1.8-1.04-2.46-2-1.34-1.95-2.37-5.5-.99-7.9.68-1.19 1.9-1.95 3.23-1.97 1-.02 1.95.68 2.56.68.61 0 1.76-.84 2.97-.72.51.02 1.93.21 2.85 1.55-.07.05-1.7 1-1.68 2.98zM14.4 5.5c.54-.66.9-1.57.8-2.48-.78.03-1.72.52-2.28 1.17-.5.58-.94 1.5-.82 2.39.87.07 1.76-.44 2.3-1.08z" />
      </svg>
    );
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <ellipse cx="12" cy="10" rx="4.5" ry="6" />
      <circle cx="10.4" cy="8.5" r="0.9" fill={c} stroke="none" />
      <circle cx="13.6" cy="8.5" r="0.9" fill={c} stroke="none" />
      <path d="M11 11.2c.5.5 1.5.5 2 0" />
      <path d="M7.6 15.5c-1.2 1.4-2.6 2.9-1.6 4 1 1.1 3-.2 4-.2M16.4 15.5c1.2 1.4 2.6 2.9 1.6 4-1 1.1-3-.2-4-.2" />
    </svg>
  );
}

export default function DownloadModal({
  open,
  version,
  notes,
  opts,
  onClose,
}: {
  open: boolean;
  version?: string;
  notes?: string;
  opts: DlOpt[];
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onEsc, true);
    return () => document.removeEventListener("keydown", onEsc, true);
  }, [open, onClose]);

  // Confirm each installer actually exists before offering it — a HEAD check so a
  // not-yet-built OS (e.g. mac/Linux binaries not uploaded) shows "Coming soon"
  // instead of a Download that dies with "file wasn't available on site".
  // undefined = checking, true = present, false = missing.
  const [avail, setAvail] = useState<Record<string, boolean>>({});
  // The "Other platforms" panel starts collapsed every time the modal opens —
  // most visitors want the one big button, not a list.
  const [showOthers, setShowOthers] = useState(false);
  // Mobile section (desktop visitors): nothing is shown until the visitor
  // picks their phone platform — then that store's QR code + button appear.
  const [mobilePick, setMobilePick] = useState<"" | "ios" | "android">("");
  useEffect(() => {
    if (open) {
      setShowOthers(false);
      setMobilePick("");
    }
  }, [open]);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setAvail({});
    opts.forEach((o) => {
      // Entries with an explicit manifest flag are authoritative — skip the
      // probe (a flaky HEAD, e.g. a static host that 405s HEAD, must never
      // hide a genuinely-published build).
      if (typeof o.available === "boolean") return;
      fetch(o.url, { method: "HEAD" })
        .then((r) => alive && setAvail((a) => ({ ...a, [o.key]: r.ok })))
        .catch(() => alive && setAvail((a) => ({ ...a, [o.key]: false })));
    });
    return () => {
      alive = false;
    };
  }, [open, opts]);

  if (!open) return null;
  const myOS = detectOS();
  const myMobile = detectMobile();
  // On a phone/tablet the matching store leads; the desktop builds (and the
  // other store) ride the collapsed list. On a desktop the store links sit in
  // their own small section under the desktop CTA.
  const mobilePrimary = myMobile ? MOBILE_APPS.find((m) => m.key === myMobile) || null : null;
  const mobileOthers = mobilePrimary ? MOBILE_APPS.filter((m) => m.key !== mobilePrimary.key) : MOBILE_APPS;
  const sorted = myOS
    ? [...opts].sort((a, b) => (b.os === myOS ? 1 : 0) - (a.os === myOS ? 1 : 0))
    : opts;
  // Manifest flag wins; otherwise the HEAD probe decides. "Coming soon" only
  // when explicitly unavailable or the probe failed.
  const isSoon = (o: DlOpt) =>
    o.available === true ? false : o.available === false ? true : avail[o.key] === false;
  // The device-detected match leads (falls back to the first listed platform
  // when the visitor's OS has no build at all, e.g. a Linux visitor with only
  // Windows/macOS published) — everyone else rides the collapsed list.
  const primary = sorted[0];
  const others = sorted.slice(1);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Download Collab"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 6200,
        background: "rgba(15,18,28,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
    >
      <style>{DL_CSS}</style>
      <div className="dlm-card" onClick={(e) => e.stopPropagation()}>
        <button className="dlm-x" aria-label="Close" onClick={onClose}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
        <div className="dlm-head">
          <div className="dlm-badge" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12M7 10l5 5 5-5" /><path d="M5 21h14" /></svg>
          </div>
          <div style={{ minWidth: 0 }}>
            <div className="dlm-title">Download Collab</div>
            <div className="dlm-sub">
              Desktop{version ? ` v${version}` : ""} · iOS · Android
            </div>
          </div>
        </div>

        {notes ? <p className="dlm-notes">{notes}</p> : null}

        {mobilePrimary ? (
          <a
            className="dlm-primary"
            href={mobilePrimary.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            <span className="dlm-primary-icon"><StoreIcon store={mobilePrimary.key} /></span>
            <span className="dlm-primary-info">
              <span className="dlm-primary-title">Get it on the {mobilePrimary.label}</span>
              <span className="dlm-primary-sub">{mobilePrimary.sub}</span>
            </span>
            <span className="dlm-primary-btn">Open store</span>
          </a>
        ) : null}

        {primary ? (
          <>
            {mobilePrimary ? null : isSoon(primary) ? (
              <div
                className="dlm-primary dlm-primary-soon"
                aria-disabled="true"
                title="This build isn't published yet"
              >
                <span className="dlm-primary-icon"><OSIcon os={primary.os} /></span>
                <span className="dlm-primary-info">
                  <span className="dlm-primary-title">Download for {osDisplayName(primary.os)}</span>
                  <span className="dlm-primary-sub">
                    {primary.sub}
                    {primary.size ? ` · ${fmtSize(primary.size)}` : ""}
                  </span>
                </span>
                <span className="dlm-primary-btn dlm-primary-btn-soon">Coming soon</span>
              </div>
            ) : (
              <a
                className="dlm-primary"
                href={primary.url}
                download
                target="_blank"
                rel="noopener noreferrer"
              >
                <span className="dlm-primary-icon"><OSIcon os={primary.os} /></span>
                <span className="dlm-primary-info">
                  <span className="dlm-primary-title">Download for {osDisplayName(primary.os)}</span>
                  <span className="dlm-primary-sub">
                    {primary.sub}
                    {primary.size ? ` · ${fmtSize(primary.size)}` : ""}
                  </span>
                </span>
                <span className="dlm-primary-btn">Download</span>
              </a>
            )}

            {(mobilePrimary ? [primary, ...others] : others).length > 0 && (
              <button
                type="button"
                className="dlm-other-toggle"
                aria-expanded={showOthers}
                onClick={() => setShowOthers((v) => !v)}
              >
                {showOthers
                  ? "Hide other platforms"
                  : `Other platforms (${(mobilePrimary ? [primary, ...others] : others).length + (mobilePrimary ? mobileOthers.length : 0)})`}
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </button>
            )}

            {showOthers && (
              <div className="dlm-rows dlm-rows-others">
                {mobilePrimary
                  ? mobileOthers.map((m) => (
                      <div className="dlm-row" key={m.key}>
                        <span className="dlm-os"><StoreIcon store={m.key} /></span>
                        <span className="dlm-info">
                          <span className="dlm-os-name">{m.label}</span>
                          <span className="dlm-os-sub">{m.sub}</span>
                        </span>
                        <a className="dlm-dl" href={m.url} target="_blank" rel="noopener noreferrer">Open store</a>
                      </div>
                    ))
                  : null}
                {(mobilePrimary ? [primary, ...others] : others).map((o) => {
                  const soon = isSoon(o);
                  return (
                    <div className="dlm-row" key={o.key}>
                      <span className="dlm-os"><OSIcon os={o.os} /></span>
                      <span className="dlm-info">
                        <span className="dlm-os-name">{o.label}</span>
                        <span className="dlm-os-sub">
                          {o.sub}
                          {o.size ? ` · ${fmtSize(o.size)}` : ""}
                        </span>
                      </span>
                      {soon ? (
                        <span className="dlm-dl dlm-soon" aria-disabled="true" title="This build isn't published yet">
                          Coming soon
                        </span>
                      ) : (
                        <a
                          className="dlm-dl"
                          href={o.url}
                          download
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Download
                        </a>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        ) : mobilePrimary ? null : (
          <div className="dlm-empty">
            Desktop builds aren&apos;t available to download yet. Please check back
            shortly.
          </div>
        )}

        {/* Mobile apps — on a desktop visitor's screen both stores sit here,
            each with a QR code so the phone can be pointed at the screen
            (the store link is what the code encodes). On a phone the matching
            store already leads above, where a QR would be pointless. */}
        {!mobilePrimary && (() => {
          const picked = MOBILE_APPS.find((m) => m.key === mobilePick) || null;
          return (
            <div className="dlm-mobile">
              <div className="dlm-section-head">
                <div className="dlm-section-title">Get the mobile app</div>
              </div>
              <div className="dlm-mobile-pick">
                <label className="dlm-pick-label" htmlFor="dlm-platform">Your phone</label>
                <Select
                  id="dlm-platform"
                  className="dlm-pick-select"
                  value={mobilePick}
                  placeholder="Select platform…"
                  ariaLabel="Select your phone platform"
                  onValueChange={(v) => setMobilePick(v === "ios" || v === "android" ? v : "")}
                  options={[
                    { value: "android", label: "Android" },
                    { value: "ios", label: "iOS (iPhone & iPad)" },
                  ]}
                />
              </div>
              {picked ? (
                <div className="dlm-store-card dlm-store-card-wide" key={picked.key}>
                  <a
                    className="dlm-qr-wrap"
                    href={picked.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`QR code: Collab on the ${picked.label}`}
                    title={picked.url}
                  >
                    <QrCode value={picked.url} size={132} title={`Scan to get Collab on the ${picked.label}`} className="dlm-qr" />
                  </a>
                  <div className="dlm-store-side">
                    <div className="dlm-store-scan">Scan the QR code with your phone&apos;s camera</div>
                    <div className="dlm-store-or">or</div>
                    <a
                      className="dlm-store"
                      href={picked.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`Download Collab from the ${picked.label}`}
                    >
                      <span className="dlm-store-icon"><StoreIcon store={picked.key} /></span>
                      <span className="dlm-store-info">
                        <span className="dlm-store-kicker">Download from</span>
                        <span className="dlm-store-name">{picked.label}</span>
                      </span>
                    </a>
                    <span className="dlm-store-sub">{picked.sub}</span>
                  </div>
                </div>
              ) : (
                <div className="dlm-pick-hint">Choose Android or iOS to see the QR code and download button.</div>
              )}
            </div>
          );
        })()}
      </div>
    </div>,
    document.body,
  );
}

const DL_CSS = `
.dlm-card {
  position: relative;
  width: 440px;
  max-width: 100%;
  background: var(--card, #fff);
  border: 1px solid var(--g200, #e5e7eb);
  border-radius: 16px;
  box-shadow: 0 24px 60px rgba(0,0,0,.3);
  padding: 22px;
  /* The QR cards make the dialog taller than a phone-sized window: scroll the
     card itself instead of clipping the store badges off the bottom. */
  max-height: calc(100vh - 40px);
  overflow-y: auto;
}
.dlm-x {
  position: absolute; top: 12px; right: 12px;
  width: 28px; height: 28px; display: flex; align-items: center; justify-content: center;
  border: 0; background: transparent; color: var(--g500, #6b7280); border-radius: 8px; cursor: pointer;
}
.dlm-x:hover { background: color-mix(in srgb, var(--g500,#6b7280) 14%, transparent); }
.dlm-head { display: flex; align-items: center; gap: 13px; padding-right: 26px; }
.dlm-badge { flex: 0 0 auto; width: 42px; height: 42px; border-radius: 11px; display: flex; align-items: center; justify-content: center; background: linear-gradient(45deg, #8b29be, #381354); }
.dlm-title { font-size: 17px; font-weight: 700; color: var(--g900, #111827); }
.dlm-sub { font-size: 12.5px; color: var(--g500, #6b7280); margin-top: 1px; }
.dlm-notes { font-size: 12.5px; color: var(--g500, #6b7280); line-height: 1.5; margin: 14px 0 0; }
.dlm-rows { display: flex; flex-direction: column; gap: 8px; margin-top: 18px; }
.dlm-rows-others { margin-top: 8px; }

/* Primary CTA: one big "Download for <OS>" button — device-detected, the whole
   card is the click target. */
.dlm-primary { display: flex; align-items: center; gap: 14px; padding: 16px 18px; border-radius: 14px; margin-top: 18px; background: var(--brand-cta-gradient); color: #fff; text-decoration: none; }
.dlm-primary:hover { filter: brightness(1.06); }
.dlm-primary-icon { flex: 0 0 auto; width: 42px; height: 42px; border-radius: 11px; display: flex; align-items: center; justify-content: center; background: rgba(255,255,255,.16); }
.dlm-primary-info { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.dlm-primary-title { font-size: 15px; font-weight: 700; }
.dlm-primary-sub { font-size: 12px; opacity: .85; }
.dlm-primary-btn { flex: 0 0 auto; font-size: 12.5px; font-weight: 700; padding: 8px 16px; border-radius: 9px; background: rgba(255,255,255,.18); white-space: nowrap; }
.dlm-primary-soon { background: var(--g200, #e5e7eb); color: var(--g500, #6b7280); cursor: not-allowed; }
.dlm-primary-soon:hover { filter: none; }
.dlm-primary-soon .dlm-primary-icon { background: rgba(0,0,0,.06); color: var(--g500, #6b7280); }
.dlm-primary-btn-soon { background: rgba(0,0,0,.06); color: var(--g500, #6b7280); }

/* "Other platforms" toggle — collapsed by default, matches the empty-state's
   quiet tone rather than competing with the primary CTA above it. */
.dlm-other-toggle { display: flex; align-items: center; justify-content: center; gap: 6px; width: 100%; margin-top: 10px; padding: 9px; border: 0; background: transparent; border-radius: 8px; font-size: 12.5px; font-weight: 600; color: var(--g500, #6b7280); cursor: pointer; }
.dlm-other-toggle:hover { background: color-mix(in srgb, var(--g500,#6b7280) 10%, transparent); color: var(--g900, #111827); }
.dlm-other-toggle svg { transition: transform .15s ease; }
.dlm-other-toggle[aria-expanded="true"] svg { transform: rotate(180deg); }

.dlm-row { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border: 1px solid var(--g200, #e5e7eb); border-radius: 12px; }
.dlm-row.rec { border-color: color-mix(in srgb, var(--ac) 55%, transparent); background: color-mix(in srgb, var(--ac) 6%, transparent); }
.dlm-os { flex: 0 0 auto; color: var(--g700, #374151); display: inline-flex; }
.dlm-info { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.dlm-os-name { font-size: 13.5px; font-weight: 600; color: var(--g900, #111827); display: flex; align-items: center; gap: 8px; }
.dlm-rec { font-size: 10.5px; font-weight: 700; letter-spacing: .02em; text-transform: uppercase; color: var(--ac, #5e6ad2); background: color-mix(in srgb, var(--ac) 14%, transparent); padding: 2px 7px; border-radius: 999px; }
.dlm-os-sub { font-size: 12px; color: var(--g500, #6b7280); }
.dlm-dl { flex: 0 0 auto; font-size: 12.5px; font-weight: 700; text-decoration: none; padding: 8px 16px; border-radius: 9px; background: var(--brand-cta-gradient); color: #fff; white-space: nowrap; }
.dlm-dl:hover { filter: brightness(1.07); }
.dlm-soon { background: var(--g200, #e5e7eb); color: var(--g500, #6b7280); cursor: not-allowed; }
.dlm-soon:hover { filter: none; }
.dlm-empty { margin-top: 18px; padding: 16px; border: 1px dashed var(--g200, #e5e7eb); border-radius: 12px; font-size: 13px; color: var(--g500, #6b7280); text-align: center; }

/* Mobile apps: a platform dropdown first; the chosen store's QR code (it
   encodes the store link) + download button appear only after a pick. */
.dlm-mobile-pick { display: flex; align-items: center; gap: 12px; }
.dlm-pick-label { flex: 0 0 auto; font-size: 13px; font-weight: 600; color: var(--g700, #374151); }
.dlm-pick-select { flex: 1 1 auto; min-width: 0; }
.dlm-pick-hint { margin-top: 12px; padding: 12px 14px; border: 1px dashed var(--g200, #e5e7eb); border-radius: 12px; font-size: 12.5px; color: var(--g500, #6b7280); text-align: center; }
.dlm-store-card-wide { margin-top: 12px; padding: 16px; }
.dlm-store-side { width: 100%; display: flex; flex-direction: column; align-items: stretch; gap: 8px; }
.dlm-store-scan { font-size: 12.5px; color: var(--g700, #374151); line-height: 1.4; }
.dlm-store-or { font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--g500, #6b7280); text-align: center; }
.dlm-store-side .dlm-store-sub { text-align: center; }
.dlm-mobile { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--g200, #e5e7eb); }
.dlm-section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
.dlm-section-title { font-size: 11.5px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--g500, #6b7280); }
.dlm-section-hint { font-size: 11.5px; color: var(--g500, #6b7280); }
.dlm-mobile-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
@media (max-width: 420px) { .dlm-mobile-grid { grid-template-columns: 1fr; } }
.dlm-store-card { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 14px 12px 12px; border: 1px solid var(--g200, #e5e7eb); border-radius: 14px; background: var(--card, #fff); }
.dlm-qr-wrap { display: inline-flex; padding: 6px; border-radius: 10px; background: #fff; border: 1px solid var(--g200, #e5e7eb); line-height: 0; }
.dlm-qr-wrap:hover { border-color: color-mix(in srgb, var(--ac, #5e6ad2) 60%, transparent); }
.dlm-qr { display: block; }
.dlm-store-sub { font-size: 11.5px; color: var(--g500, #6b7280); }
.dlm-store { display: flex; align-items: center; gap: 11px; padding: 10px 14px; width: 100%; box-sizing: border-box; border-radius: 12px; background: var(--g900, #111827); color: #fff; text-decoration: none; border: 1px solid transparent; }
.dlm-store:hover { filter: brightness(1.15); }
.dlm-store-icon { flex: 0 0 auto; display: inline-flex; color: #fff; }
.dlm-store-info { display: flex; flex-direction: column; min-width: 0; line-height: 1.15; }
.dlm-store-kicker { font-size: 10px; opacity: .8; }
.dlm-store-name { font-size: 15px; font-weight: 700; white-space: nowrap; }
`;
