const { Notification } = require("electron");

const DEDUP_MS = 5000;
const recentTags = new Map();
const activeNotifications = new Map();

function isDup(tag) {
  if (!tag) return false;
  const now = Date.now();
  const last = recentTags.get(tag);
  if (last && now - last < DEDUP_MS) return true;
  recentTags.set(tag, now);
  if (recentTags.size > 100) {
    for (const [k, v] of recentTags) {
      if (now - v > DEDUP_MS * 2) recentTags.delete(k);
    }
  }
  return false;
}

function createDesktopNotification(opts, mainWindow) {
  if (isDup(opts.tag)) return null;

  try {
    // Optional action buttons (e.g. Answer / Decline for an incoming call). Only
    // accept a small, well-formed array of { type:"button", text }. On macOS the
    // OS shows the FIRST button inline + the rest under "actions" on hover; on
    // Windows/Linux Electron's Notification has limited/no native button support,
    // so the notification still shows (clicking the body routes "click"), and the
    // taskbar flash + in-app ring remain the answer path. We never throw on this.
    const actions = Array.isArray(opts.actions)
      ? opts.actions
          .filter((a) => a && typeof a.text === "string")
          .slice(0, 2)
          .map((a) => ({ type: "button", text: a.text }))
      : [];

    // Electron's Notification.icon requires a native image (PNG on Linux/Windows,
    // ICNS on macOS). Use the default app icon by not setting an icon path.
    const notif = new Notification({
      title: opts.title,
      body: opts.body || "",
      silent: opts.silent !== false,
      urgency: opts.requireInteraction ? "critical" : "normal",
      actions,
    });

    const id = String(Date.now()) + "-" + Math.random().toString(36).slice(2, 6);

    notif.on("click", () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
      }
      if (opts.data && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("desktop:notification-action", "click", opts.data);
      }
    });

    // An action button was clicked (index into `actions`). Map it back to the
    // caller-supplied semantic key (opts.actions[i].action, e.g. "answer" /
    // "decline") and forward to the renderer with the original data. For a hidden
    // window, show it first so an answered call is actually visible.
    notif.on("action", (_event, index) => {
      const src = Array.isArray(opts.actions) ? opts.actions[index] : null;
      const action = src && typeof src.action === "string" ? src.action : "click";
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (action === "answer") {
          if (mainWindow.isMinimized()) mainWindow.restore();
          if (!mainWindow.isVisible()) mainWindow.show();
          mainWindow.focus();
        }
        mainWindow.webContents.send("desktop:notification-action", action, opts.data);
      }
    });

    notif.on("close", () => {
      activeNotifications.delete(id);
    });

    notif.show();
    activeNotifications.set(id, notif);

    return id;
  } catch (e) {
    return null;
  }
}

// Clean up all active notifications on shutdown to prevent leaks.
function clearAllNotifications() {
  for (const [id, notif] of activeNotifications) {
    try { notif.close(); } catch {}
  }
  activeNotifications.clear();
}

module.exports = { createDesktopNotification, clearAllNotifications };
