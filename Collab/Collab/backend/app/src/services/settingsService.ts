import { db } from "../platform";

const DEFAULTS = {
  theme: "light",
  accent: "indigo",
  density: "comfy",
  zoom: "1",
  fontSize: "14px", // Figma "Collab Screens" message text size
  fontFamily: "inter", // Figma typeface
  highContrast: false,
  reduceMotion: false,
  largerText: false,
  keyboardNavigation: true,
  language: "en",
  timezone: "auto",
  dateFormat: "MMM D, YYYY",
  timeFormat: "12h",
  echoCancellation: true,
  enterToSend: true,
  notifyLevel: "all",
  notifyCalls: true,
  quietHours: false,
  quietStart: "22:00",
  quietEnd: "07:00",
  micId: "",
  speakerId: "",
  cameraId: "",
  noiseSuppression: true,
  messageGrouping: true,
  readReceipts: true,
  linkPreview: true,
  notifSound: true,
  notifBadge: true,
  ringtone: "default",
  // Presentation Mode (P0-11): auto-enable Do Not Disturb while screen sharing
  // / presenting (default ON), + whether the small enable/disable info toasts
  // show. Enforceable-by-policy is a future admin follow-up.
  presentationDnd: true,
  presentationDndToasts: true,
  agentStyle: "balanced",
  sidebarWidth: 348, // Figma chat-list width
  // Chat wallpaper was removed (#12): conversations use a plain background.
  // The key is kept whitelisted so previously-saved values still load without
  // tripping the unknown-key drop, but it is no longer applied by the client.
  chatBackground: "none",
  // skye blue-style sent-bubble accent: "accent" (follow theme) or a palette key
  // (see frontend lib/bubbleAccent.ts). Whitelisted so the choice persists.
  bubbleAccent: "accent",
  // Dashboard ambient background effect: "default" (accent glow), "borealis"
  // (Aurora Borealis green), or "none". Whitelisted so the choice persists.
  ambiance: "default",
  // Messaging quality-of-life toggles (must be whitelisted here to persist).
  autoCollapseSidebar: false, // Figma keeps the full rail open beside the chat list // collapse the conversation list when a chat opens
  jumpToLatest: true, // show a "jump to latest" button when scrolled up
  blurMedia: false, // blur images/videos until hovered (privacy)
  dyslexiaFont: false, // dyslexia-friendly typeface across the app
  webrtcDebugInCalls: false, // show the full draggable WebRTC diagnostics panel in calls/meetings (the latency/throughput mini-stat stays always-on regardless)
  diagFloating: false, // show the floating diagnostics/error pill
  bubbleStyle: "rounded", // message bubble shape: rounded | pill | square
  compactList: false, // denser conversation list (hide preview line)
  linkConfirm: false, // confirm the destination before opening external links
  // ORD-01 / D-3(b): per-user chat display order — newest at top (reverse
  // chronological) when ON; newest at bottom (the default) when OFF. Was
  // missing from this whitelist, so the Settings toggle silently never
  // persisted — the store drops unknown keys.
  newestAtTop: false,
  sendTyping: true, // broadcast "typing…" to others (privacy toggle)
  lastSeen: true, // share + see "last seen"/online status (WhatsApp-style reciprocal)
  chatBackup: true, // WhatsApp-style automatic encrypted chat backup (E2EE recovery). ON keeps history restorable on a new device; OFF stops new backups (existing backup stays restorable until deleted).
  manualPresence: "auto", // manual status (Teams set): "auto" | "away" | "busy" | "dnd" | "brb" | "offline". Mirrored onto users.manual_presence by the settings route.
  statusMessage: "", // short custom status text shown under the user's name ("In a meeting", "On vacation", etc.)
  // First-run onboarding state (whitelisted so it persists; the settings store
  // silently drops unknown keys). onboardingDone gates the welcome overlay,
  // onboardingStep resumes a partial run, onboardingFocus picks the default
  // landing view (communicate→chats, organize/both→dashboard).
  onboardingDone: false,
  onboardingStep: 0,
  onboardingFocus: "both", // "communicate" | "organize" | "both"
  // Post-call/meeting feedback (#67): when ON, a "How was your call experience?"
  // dialog is shown after a connected call/meeting ends normally (gated further
  // client-side by duration + a 24h throttle). Default ENABLED. This is the ONE
  // source of truth the Settings → Accessibility toggle AND the dialog's
  // "Don't show this again" checkbox both write. MUST be whitelisted here or the
  // settings store silently drops it on save.
  callFeedback: true,
};

const ALLOWED = new Set(Object.keys(DEFAULTS));

async function get(userId) {
  const saved = (await db.settings.get(userId)) || {};
  return { ...DEFAULTS, ...saved };
}

async function update(userId, patch = {}) {
  const clean: any = {};

  for (const [k, v] of Object.entries(patch)) {
    if (ALLOWED.has(k)) clean[k] = v;
  }

  const saved = await db.settings.set(userId, clean);

  // Mirror the "Last seen" privacy setting onto the user row so the serializer
  // can gate sharing cheaply (WhatsApp-style: hide yours → can't see theirs).
  if (Object.prototype.hasOwnProperty.call(clean, "lastSeen") && db.users.setShareLastSeen) {
    try { await db.users.setShareLastSeen(userId, clean.lastSeen !== false); } catch (_) {}
  }

  return { ...DEFAULTS, ...saved };
}

export { get, update };
