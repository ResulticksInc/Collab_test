// Shared screen-share "pop out" logic for BOTH the meeting stage (MeetingStage)
// and the 1:1/group call path (useCallSessionMedia) — the doc's "what we do in
// meetings, we do in calls" rule. Only the window plumbing lives here (it is
// identical for both and would otherwise drift); each caller keeps its own
// button + placeholder chrome so it uses its own tile CSS classes (ms-* vs cv-*).
//
// Covers POP-02 (independently resizable, min/max), POP-03 (video only, audio
// stays in the main window), POP-05 (closing restores), POP-06 (cap 3),
// POP-09 (minimal controls), plus §9.2 telemetry via the optional onEvent hook.
//
// WINDOW MODE vs PIP MODE
// ----------------------
// The default is a REAL browser window (window.open). A Document-PiP surface is
// an always-on-top panel the OS gives no title bar to: it cannot be maximized by
// the window manager, it has no taskbar/dock entry, and it reads to people as a
// modal that is stuck at one size. A real window is an ordinary OS window — it
// maximizes, minimizes, snaps, moves to a second monitor and shows up in the
// task switcher like every other window, which is what "pop out" is supposed to
// mean. Document PiP is still available on demand (the header's "PiP" button)
// because always-on-top is genuinely useful while you work in another app, and
// it is the automatic fallback when a popup blocker refuses the window. Plain
// <video> Picture-in-Picture is the last resort.

export function popoutCapability(): { hasDocPip: boolean; hasVidPip: boolean } {
  return {
    hasDocPip: typeof window !== "undefined" && "documentPictureInPicture" in window,
    hasVidPip:
      typeof document !== "undefined" && !!(document as any).pictureInPictureEnabled,
  };
}

export function closePopout(pipWindows: Map<string, Window>, pid: string): void {
  const w = pipWindows.get(pid);
  if (w) {
    pipWindows.delete(pid);
    try { w.close(); } catch (_) {}
  }
}

export function closeAllPopouts(pipWindows: Map<string, Window>): void {
  pipWindows.forEach((w) => {
    try { w.close(); } catch (_) {}
  });
  pipWindows.clear();
}

export interface OpenPopoutOpts {
  tile: HTMLElement;
  pid: string;
  participantName: string;
  video: HTMLVideoElement | null;
  pipWindows: Map<string, Window>;
  onToast?: (msg: string) => void;
  onEvent?: (name: string) => void;
  // Path-specific placeholder chrome (uses the caller's own tile classes).
  addPlaceholder: () => void;
  removePlaceholder: () => void;
}

type PopoutMode = "window" | "pip";

const CHROME_CSS =
  ".pp-btn{border:1px solid #475569;background:transparent;color:#cbd5e1;font-size:12px;padding:4px 10px;border-radius:6px;cursor:pointer;line-height:1;}" +
  ".pp-btn:hover{background:#2a3140;}" +
  ".pp-btn:focus-visible{outline:2px solid #8a89ff;outline-offset:1px;}";

// `position:fixed; inset:0` rather than 100vw/100vh: viewport units include the
// scrollbar gutter, so a 100vw box on a body with any margin overflows and the
// window gains scrollbars — which is what "not adapting to the window size"
// looked like. Anchoring to the viewport edges makes the shell track every
// resize, maximize and monitor change exactly.
const RESET_CSS =
  "html,body{margin:0;padding:0;height:100%;overflow:hidden;background:#0d0f12;}" +
  "*{box-sizing:border-box;}";
const SHELL_CSS =
  "position:fixed;inset:0;background:#0d0f12;display:flex;flex-direction:column;" +
  "margin:0;padding:0;overflow:hidden;font-family:system-ui,-apple-system,sans-serif;";

interface ChromeOpts {
  win: Window;
  doc: Document;
  container: HTMLElement;
  name: string;
  // "Switch to the other surface" — null when that surface isn't available.
  altLabel: string;
  altTitle: string;
  onAlt: (() => void) | null;
  onBringBack: () => void;
  // A real window already has the operating system's own minimize / maximize /
  // restore in its title bar, and those behave the way people expect (snapping,
  // double-click to zoom, keyboard shortcuts, the taskbar). Drawing our own
  // buttons next to them is duplicate, worse chrome — so the real window gets
  // none, and only the Document-PiP surface (which the OS gives no title bar at
  // all) keeps them, because there they are the only way to resize.
  nativeControls: boolean;
}

// The header is built once for both surfaces. In a real window it is just the
// participant's name plus the app actions; in PiP it also carries the size
// controls the OS is not providing.
function buildChrome(o: ChromeOpts): HTMLElement {
  const { win, doc, container } = o;
  const st = doc.createElement("style");
  st.textContent = CHROME_CSS;
  (doc.head || doc.documentElement).appendChild(st);

  const hdr = doc.createElement("div");
  hdr.style.cssText =
    "height:36px;flex:none;display:flex;align-items:center;gap:8px;padding:0 12px;" +
    "background:#1e242c;color:#cbd5e1;font-size:12px;border-bottom:1px solid #334155;";
  const who = doc.createElement("span");
  who.style.cssText =
    "font-weight:600;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;";
  who.textContent = o.name || "Screen share";

  const mkBtn = (label: string, title: string) => {
    const b = doc.createElement("button");
    b.type = "button";
    b.className = "pp-btn";
    b.textContent = label;
    b.title = title;
    b.setAttribute("aria-label", title);
    return b;
  };

  // Remember size AND position before a min/max so Restore puts the window back
  // exactly where it was.
  let restoreRect: { x: number; y: number; w: number; h: number } | null = null;
  let sizeMode: "normal" | "min" = "normal";
  const winX = () =>
    typeof (win as any).screenX === "number" ? (win as any).screenX : (win as any).screenLeft || 0;
  const winY = () =>
    typeof (win as any).screenY === "number" ? (win as any).screenY : (win as any).screenTop || 0;
  const move = (x: number, y: number) => {
    try { (win as any).moveTo(x, y); } catch (_) {}
  };
  const isFs = () => !!(doc.fullscreenElement || (doc as any).webkitFullscreenElement);

  const btnMin = mkBtn("—", "Minimize");
  const btnMax = mkBtn("⛶", "Maximize");

  const syncBtns = () => {
    const fs = isFs();
    btnMin.textContent = sizeMode === "min" ? "❐" : "—";
    btnMin.title = sizeMode === "min" ? "Restore size" : "Minimize";
    btnMin.setAttribute("aria-label", btnMin.title);
    btnMax.textContent = fs ? "❐" : "⛶";
    btnMax.title = fs ? "Restore" : "Maximize";
    btnMax.setAttribute("aria-label", btnMax.title);
  };

  // resizeTo() is clamped by the window manager (it cannot reliably fill the
  // screen and misbehaves across a second monitor) — the Fullscreen API fills
  // the physical screen exactly, header + video, on whichever monitor the window
  // sits on. Resize is only the fallback where fullscreen is refused.
  const resizeFallbackMax = () => {
    try {
      if (typeof (win as any).resizeTo !== "function") return;
      const scr: any = (win as any).screen || {};
      move(scr.availLeft || 0, scr.availTop || 0);
      (win as any).resizeTo(scr.availWidth || scr.width || 1280, scr.availHeight || scr.height || 800);
      sizeMode = "normal";
      syncBtns();
    } catch (_) {}
  };
  const toggleMax = () => {
    try {
      if (isFs()) {
        (doc.exitFullscreen || (doc as any).webkitExitFullscreen)?.call(doc);
        return;
      }
      const el: any = container;
      const req = el.requestFullscreen || el.webkitRequestFullscreen;
      if (req) {
        const r = req.call(el);
        if (r && typeof r.catch === "function") r.catch(() => resizeFallbackMax());
      } else {
        resizeFallbackMax();
      }
    } catch (_) {
      resizeFallbackMax();
    }
  };
  // MINIMIZE → compact corner thumbnail (a real window resize; toggles back).
  const toggleMin = () => {
    try {
      if (isFs()) (doc.exitFullscreen || (doc as any).webkitExitFullscreen)?.call(doc);
      if (typeof (win as any).resizeTo !== "function") return;
      const scr: any = (win as any).screen || {};
      if (sizeMode === "min") {
        if (restoreRect) {
          move(restoreRect.x, restoreRect.y);
          (win as any).resizeTo(restoreRect.w, restoreRect.h);
        }
        sizeMode = "normal";
      } else {
        restoreRect = { x: winX(), y: winY(), w: win.outerWidth, h: win.outerHeight };
        const w = 360, h = 240;
        const aw = scr.availWidth || scr.width || 1280;
        const ah = scr.availHeight || scr.height || 800;
        const ox = scr.availLeft || 0, oy = scr.availTop || 0;
        (win as any).resizeTo(w, h);
        move(ox + Math.max(0, aw - w - 24), oy + Math.max(0, ah - h - 24));
        sizeMode = "min";
      }
    } catch (_) {}
    syncBtns();
  };

  doc.addEventListener("fullscreenchange", syncBtns);
  doc.addEventListener("webkitfullscreenchange", syncBtns);
  btnMin.onclick = toggleMin;
  btnMax.onclick = toggleMax;

  hdr.appendChild(who);
  if (!o.nativeControls) {
    hdr.appendChild(btnMin);
    hdr.appendChild(btnMax);
  }
  if (o.onAlt) {
    const btnAlt = mkBtn(o.altLabel, o.altTitle);
    btnAlt.onclick = o.onAlt;
    hdr.appendChild(btnAlt);
  }
  const backBtn = mkBtn("Bring back", "Bring back to the call");
  backBtn.onclick = o.onBringBack;
  hdr.appendChild(backBtn);
  return hdr;
}

function mirrorVideo(doc: Document, src: HTMLVideoElement): HTMLVideoElement {
  const v = doc.createElement("video");
  (v as any).srcObject = (src as any).srcObject;
  v.autoplay = true;
  (v as any).playsInline = true;
  // POP-03: video only — audio stays in the main window (no renegotiation).
  v.muted = true;
  v.style.cssText = "width:100%;flex:1;min-height:0;object-fit:contain;background:#000;";
  return v;
}

// Opens (or focuses) the pop-out for a screen tile. Safe to call repeatedly:
// a second click on an already-popped tile focuses its window rather than
// stacking a duplicate.
export async function openScreenPopout(opts: OpenPopoutOpts): Promise<void> {
  const { pid, pipWindows, onToast } = opts;

  // Re-click focuses the existing window (never a duplicate).
  const existing = pipWindows.get(pid);
  if (existing) {
    try { existing.focus(); } catch (_) {}
    return;
  }
  // POP-06: cap simultaneous pop-outs to protect the decode budget.
  if (pipWindows.size >= 3) {
    onToast && onToast("Up to 3 pop-outs at a time — close one first.");
    return;
  }
  if (!opts.video) return;

  // A real window must be opened SYNCHRONOUSLY inside the click gesture or the
  // popup blocker refuses it, so window mode is attempted before any await.
  if (openWindowMode(opts)) return;
  // Degrading silently to a floating panel is what made this look broken: the
  // panel has no OS title bar, so it cannot be maximized, and nothing said why.
  // Say what happened and what fixes it, THEN fall back.
  onToast && onToast(windowRefusedMessage(true));
  await openPipMode(opts);
}

// The desktop shell (Electron) has no per-site pop-up setting the user could
// change — telling them to "allow pop-ups for this site" there is a dead end.
// Its main process must allow the `colab_share_*` window (desktop/main.js); if
// it still refuses, the honest message is that the app couldn't open a window.
function isDesktopShell(): boolean {
  return typeof window !== "undefined" && !!(window as any).collabDesktop;
}
function windowRefusedMessage(fallingBack: boolean): string {
  const tail = fallingBack ? " Showing a floating window for now." : "";
  if (isDesktopShell())
    return "Couldn't open the share in its own window." + tail;
  return (
    "Pop-ups are blocked for this site — allow them to open the share in its own window." +
    tail
  );
}

// Switching surfaces must not look like "the pop-out closed" to the caller — the
// tile placeholder stays put across the swap. This flag suppresses the teardown
// callback for the window we are deliberately replacing.
function teardown(
  opts: OpenPopoutOpts,
  win: Window,
  switchingRef: { on: boolean },
): void {
  if (switchingRef.on) return;
  opts.onEvent && opts.onEvent("popout.close");
  // POP-05: closing the window (any way) returns the content to the stage — the
  // tile never left, so restoring is just dropping the placeholder state.
  if (opts.pipWindows.get(opts.pid) === win) opts.pipWindows.delete(opts.pid);
  opts.removePlaceholder();
}

// A genuine OS window: maximizes, minimizes, snaps, lives in the task switcher,
// and can be dragged to another monitor.
function openWindowMode(opts: OpenPopoutOpts): boolean {
  const { pid, participantName, video: vid, pipWindows } = opts;
  if (typeof window === "undefined" || !vid) return false;
  let win: Window | null = null;
  try {
    const scr: any = window.screen || {};
    const w = Math.min(1280, Math.max(640, Math.round((scr.availWidth || 1440) * 0.6)));
    const h = Math.round((w * 9) / 16) + 36;
    const left = Math.max(0, Math.round(((scr.availWidth || 1440) - w) / 2) + (scr.availLeft || 0));
    const top = Math.max(0, Math.round(((scr.availHeight || 900) - h) / 2) + (scr.availTop || 0));
    win = window.open(
      "",
      "colab_share_" + pid.replace(/[^A-Za-z0-9_]/g, "_"),
      `popup=yes,width=${w},height=${h},left=${left},top=${top}`,
    );
  } catch (_) {
    return false;
  }
  if (!win || win.closed) return false; // blocked → caller falls back to PiP

  const switching = { on: false };
  try {
    const doc = win.document;
    // about:blank is same-origin and synchronously available, but writing a
    // skeleton is what makes <head>/<body> reliably present in every engine.
    doc.write(
      "<!doctype html><html><head><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><style>" +
        RESET_CSS +
        "</style></head><body></body></html>",
    );
    doc.close();
    doc.title = (participantName || "Screen share") + " — Collab";

    const container = doc.createElement("div");
    container.style.cssText = SHELL_CSS;
    const hdr = buildChrome({
      win,
      doc,
      container,
      name: participantName,
      // The OS title bar owns minimize / maximize / restore here.
      nativeControls: true,
      altLabel: "Keep on top",
      altTitle: "Keep on top (Picture-in-Picture)",
      onAlt: popoutCapability().hasDocPip
        ? () => {
            switching.on = true;
            try { win && win.close(); } catch (_) {}
            pipWindows.delete(pid);
            void openPipMode(opts);
          }
        : null,
      onBringBack: () => { try { win && win.close(); } catch (_) {} },
    });
    container.appendChild(hdr);
    container.appendChild(mirrorVideo(doc, vid));
    doc.body.appendChild(container);

    pipWindows.set(pid, win);
    opts.onEvent && opts.onEvent("popout.open.window");
    opts.addPlaceholder();

    const done = () => teardown(opts, win as Window, switching);
    // A script-opened about:blank window fires pagehide inconsistently across
    // engines (and never at all when the OS close button is used in some
    // builds), so `closed` is polled as the authoritative signal.
    const poll = window.setInterval(() => {
      if (!win || win.closed) {
        window.clearInterval(poll);
        done();
      }
    }, 400);
    win.addEventListener("pagehide", () => {
      window.clearInterval(poll);
      done();
    });
    try { win.focus(); } catch (_) {}
    return true;
  } catch (_) {
    try { win && win.close(); } catch (_) {}
    pipWindows.delete(pid);
    return false;
  }
}

// Always-on-top surface. Document PiP where available, otherwise plain <video>
// Picture-in-Picture (which has no chrome of ours at all).
async function openPipMode(opts: OpenPopoutOpts): Promise<void> {
  const { pid, participantName, video: vid, pipWindows } = opts;
  const { hasDocPip } = popoutCapability();
  if (!vid) return;

  if (hasDocPip) {
    try {
      const pipWin: Window = await (window as any).documentPictureInPicture.requestWindow({
        width: 960,
        height: 540,
      });
      const switching = { on: false };
      pipWindows.set(pid, pipWin);
      opts.onEvent && opts.onEvent("popout.open.docpip");
      pipWin.addEventListener("pagehide", () => teardown(opts, pipWin, switching));
      opts.addPlaceholder();

      const doc = pipWin.document;
      doc.title = (participantName || "Screen share") + " — Collab";
      const reset = doc.createElement("style");
      reset.textContent = RESET_CSS;
      (doc.head || doc.documentElement).appendChild(reset);
      const container = doc.createElement("div");
      container.style.cssText = SHELL_CSS;
      const hdr = buildChrome({
        win: pipWin,
        doc,
        container,
        name: participantName,
        // A PiP surface has no OS title bar, so these are the only size
        // controls it can offer.
        nativeControls: false,
        altLabel: "Window",
        altTitle: "Move to a resizable window",
        onAlt: () => {
          switching.on = true;
          try { pipWin.close(); } catch (_) {}
          pipWindows.delete(pid);
          // The click is a user gesture, so window.open is allowed here.
          if (!openWindowMode(opts)) {
            switching.on = false;
            opts.onToast && opts.onToast(windowRefusedMessage(false));
            opts.removePlaceholder();
          }
        },
        onBringBack: () => { try { pipWin.close(); } catch (_) {} },
      });
      container.appendChild(hdr);
      container.appendChild(mirrorVideo(doc, vid));
      doc.body.style.margin = "0";
      doc.body.appendChild(container);
      return;
    } catch (_) {
      /* fall through to video PiP */
    }
  }
  if ((vid as any).requestPictureInPicture) {
    try {
      opts.addPlaceholder();
      opts.onEvent && opts.onEvent("popout.open.videopip");
      const onLeave = () => {
        opts.onEvent && opts.onEvent("popout.close");
        opts.removePlaceholder();
        vid.removeEventListener("leavepictureinpicture", onLeave);
      };
      vid.addEventListener("leavepictureinpicture", onLeave);
      await (vid as any).requestPictureInPicture();
    } catch (_) {
      opts.removePlaceholder();
    }
  }
}
