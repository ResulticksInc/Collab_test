"use client";

import { useEffect, useState } from "react";

// Custom premium title bar for the Electron shell. The browser never sees it —
// `window.collabDesktop` is the gate. We hide the native chrome via frame:false
// + titleBarStyle:"hidden" in main.js and paint the entire bar ourselves:
//   • Drag region across the full width
//   • Three theme-blended pill buttons on the RIGHT (min / max-restore / close)
//   • No "Collab" title text, no File/Edit/View menu lane
//
// The bar height is reserved by `body.has-desktop-chrome { padding-top }` so
// nothing slips underneath.
export default function DesktopChrome() {
  const [maximized, setMaximized] = useState(false);
  const [platform, setPlatform] = useState<string>("");
  // Hydration safety: the server has no `window`, but Electron's preload makes
  // `window.collabDesktop` exist BEFORE first client paint — so reading it during
  // the initial render diverges from the server HTML (hydration mismatch). Gate
  // the chrome behind a post-mount flag: SSR and the first client render both
  // return null (matching), and we only paint the bar after hydration.
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const cd: any = (typeof window !== "undefined") ? (window as any).collabDesktop : null;
    if (!cd || !cd.window) return;

    const plat = (cd.appInfo && cd.appInfo.platform) || "";
    setPlatform(plat);
    // Linux runs a NATIVE window frame (main.js) → apply NO custom web chrome at
    // all. macOS + Windows get has-desktop-chrome + an os-* class so the CSS
    // reserves the correct side: LEFT for macOS's native traffic lights, RIGHT for
    // the Windows custom pills.
    if (plat !== "linux") {
      document.body.classList.add("has-desktop-chrome");
      document.body.classList.add(plat === "darwin" ? "os-mac" : "os-win");
    }

    // Seed initial state (the maximize-changed event won't have fired yet).
    cd.window.getState?.().then?.((s: any) => {
      if (s && typeof s.maximized === "boolean") setMaximized(s.maximized);
    }).catch?.(() => {});

    const off = cd.window.onMaximizeChanged?.((isMax: boolean) => {
      setMaximized(isMax);
    });

    return () => {
      try { off && off(); } catch {}
      document.body.classList.remove("has-desktop-chrome", "os-mac", "os-win");
    };
  }, []);

  // Guard: render nothing in a browser, and nothing until after hydration (so
  // the first client render matches the server's empty <body>). In Electron, cd
  // exists immediately because preload runs before page scripts.
  const cd: any = (typeof window !== "undefined") ? (window as any).collabDesktop : null;
  if (!mounted || !cd || !cd.window) return null;
  // Custom min/max/close pills are Windows-ONLY. macOS uses its native traffic
  // lights (top-left) and Linux uses the native window frame — drawing our pills
  // there would duplicate/misplace the controls, so render nothing.
  if (platform !== "win32") return null;

  return (
    <div className="desktop-chrome" role="presentation">
      {/* DRAG REGION fills the left so the window controls sit on the RIGHT
          (standard Windows/Linux placement; theme-blended pills). */}
      <div className="desktop-chrome-drag" data-platform={platform} />
      {/* RIGHT: three premium pill buttons */}
      <div className="desktop-chrome-controls">
        <button
          type="button"
          className="dc-btn dc-min"
          title="Minimize"
          aria-label="Minimize window"
          onClick={() => cd.window.minimize()}
        >
          <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
            <line x1="2" y1="5" x2="8" y2="5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        </button>
        <button
          type="button"
          className="dc-btn dc-max"
          title={maximized ? "Restore" : "Maximize"}
          aria-label={maximized ? "Restore window" : "Maximize window"}
          onClick={() => cd.window.toggleMaximize()}
        >
          {maximized ? (
            <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
              <rect x="2.4" y="3.4" width="5" height="5" fill="none" stroke="currentColor" strokeWidth="1.1" />
              <path d="M3.6 3.4 V2.4 H8.6 V7.4 H7.6" fill="none" stroke="currentColor" strokeWidth="1.1" />
            </svg>
          ) : (
            <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
              <rect x="2" y="2" width="6" height="6" fill="none" stroke="currentColor" strokeWidth="1.2" />
            </svg>
          )}
        </button>
        <button
          type="button"
          className="dc-btn dc-close"
          title="Close"
          aria-label="Close window"
          onClick={() => cd.window.close()}
        >
          <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
            <line x1="2.5" y1="2.5" x2="7.5" y2="7.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            <line x1="7.5" y1="2.5" x2="2.5" y2="7.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}
