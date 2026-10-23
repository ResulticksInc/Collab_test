const DEDUP_MS = 5000;
const DEDUP_PRUNE_MS = 10000;
const recentTags = new Map<string, number>();

function isDup(tag: string): boolean {
  const now = Date.now();
  const last = recentTags.get(tag);
  if (last && now - last < DEDUP_MS) return true;
  recentTags.set(tag, now);
  if (recentTags.size > 100) {
    for (const [k, v] of recentTags)
      if (now - v > DEDUP_PRUNE_MS) recentTags.delete(k);
  }
  return false;
}

function quietHoursActive(s: any): boolean {
  if (!s || !s.quietHours) return false;
  const parse = (t: string, d: string) => {
    const [h, m] = String(t || d).split(":").map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  const st = parse(s.quietStart, "22:00");
  const en = parse(s.quietEnd, "07:00");
  if (st === en) return false;
  return st < en ? cur >= st && cur < en : cur >= st || cur < en;
}

export interface NotifGate {
  settings: any;
  me: any;
  roomState: any;
  activeCall: any;
  activeId: string | null;
  // Presentation Mode (P0-11): true while the user is screen-sharing /
  // presenting AND their presentationDnd setting is on — every notification
  // goes quiet so nothing interrupts (or leaks into) a live presentation.
  presenting?: boolean;
}

export interface NotifPayload {
  type: string;
  id?: string;
  title: string;
  body?: string;
  conversationId?: string;
  senderId?: string;
  targetType?: string;
  targetId?: string;
}

export function tagFor(type: string, id?: string): string {
  return "colab-" + type + "-" + (id || Math.random().toString(36).slice(2, 6));
}

export function shouldPush(
  gate: NotifGate,
  payload: NotifPayload,
  options?: { checkNotifyLevel?: boolean; checkNotifyCalls?: boolean },
): boolean {
  if (typeof document === "undefined") return false;
  if (typeof Notification === "undefined") return false;
  if (Notification.permission !== "granted") return false;

  // Presentation Mode (P0-11): while presenting, NOTHING pops — messages,
  // calls, meeting invites, reminders, activity — on web and desktop alike
  // (the Electron notification path flows through this same gate).
  if (gate.presenting) return false;

  const sx = gate.settings;
  if (!sx) return false;
  if (quietHoursActive(sx)) return false;

  const meNow = gate.me;
  // Do not disturb suppresses notifications; Busy does NOT (Teams parity — this
  // is the primary OS/native-notification gate, must match CoLabV1's toast gate).
  if (meNow && meNow.manualPresence === "dnd") return false;

  if (options?.checkNotifyLevel !== false && sx.notifyLevel === "none") return false;
  if (options?.checkNotifyCalls && sx.notifyCalls === false) return false;

  if (meNow && payload.senderId && meNow.id === payload.senderId) return false;

  const isMsgType =
    payload.type === "message" ||
    payload.type === "mention" ||
    payload.type === "reply" ||
    payload.type === "reaction" ||
    payload.type === "file_shared";
  const tabVisible = typeof document !== "undefined" && !document.hidden;
  if (isMsgType && tabVisible && gate.activeId && payload.conversationId && gate.activeId === payload.conversationId)
    return false;

  return true;
}

function actionsForType(type: string): { action: string; title: string }[] {
  switch (type) {
    case "call_incoming":
      return [
        { action: "answer", title: "\u{1F4DE} Answer" },
        { action: "decline", title: "\u{274C} Decline" },
      ];
    case "message":
    case "mention":
    case "reply":
      return [
        { action: "reply", title: "\u{1F4AC} Reply" },
        { action: "mark-read", title: "\u{2713} Mark read" },
      ];
    case "meeting_invite":
    case "meeting_started":
    case "meeting_reminder":
      return [
        { action: "join", title: "\u{1F4F9} Join" },
        { action: "dismiss", title: "Dismiss" },
      ];
    case "meeting_cancelled":
    case "meeting_updated":
      return [
        { action: "view", title: "\u{1F4C5} View" },
        { action: "dismiss", title: "Dismiss" },
      ];
    case "task_assigned":
    case "task_due":
      // task_due mirrors task_assigned (Open task + Mark done). The desktop
      // onNotificationAction handler routes both "complete" (→ moveTask done)
      // and the plain click/view (→ open task) so these buttons are live.
      return [
        { action: "view", title: "\u{1F4CB} Open task" },
        { action: "complete", title: "\u{2713} Mark done" },
      ];
    case "task_completed":
      return [
        { action: "view", title: "\u{1F4CB} Open task" },
        { action: "dismiss", title: "Dismiss" },
      ];
    case "reminder":
      return [
        { action: "complete", title: "\u{2713} Complete" },
        { action: "snooze", title: "\u{23F0} Snooze 10m" },
      ];
    case "reaction":
    case "file_shared":
      return [
        { action: "view", title: "\u{1F440} View" },
        { action: "dismiss", title: "Dismiss" },
      ];
    case "org_broadcast":
      return [
        { action: "view", title: "\u{1F4E2} Open" },
        { action: "dismiss", title: "Dismiss" },
      ];
    case "org_join_request":
      return [
        { action: "view", title: "\u{1F441} Review" },
        { action: "dismiss", title: "Dismiss" },
      ];
    case "invite":
      return [
        { action: "accept", title: "\u{2705} Accept" },
        { action: "decline", title: "\u{274C} Decline" },
      ];
    default:
      return [
        { action: "view", title: "View" },
        { action: "dismiss", title: "Dismiss" },
      ];
  }
}

export function fire(
  tag: string,
  title: string,
  body: string | undefined,
  onNavigate?: () => void,
  playSound?: () => void,
  data?: NotifPayload,
): boolean {
  if (isDup(tag)) return false;
  if (playSound) playSound();

  const notifData = {
    type: data?.type || "",
    conversationId: data?.conversationId || "",
    targetType: data?.targetType || "",
    targetId: data?.targetId || "",
    id: data?.id || "",
  };

  // ── Electron native notification path ──────────────────────────────────
  // When running inside the Collab desktop app, route notifications through
  // the Electron Notification API for native OS integration with action
  // buttons (Answer/Decline, Join/Dismiss, etc.) instead of browser fallback.
  if (typeof window !== "undefined" && (window as any).collabDesktop?.showNotification) {
    const isCall = notifData.type === "call_incoming";
    const isMeetingStart = notifData.type === "meeting_started";
    (window as any).collabDesktop.showNotification({
      title,
      body,
      tag,
      icon: "/collab.svg",
      silent: true,
      requireInteraction: isCall || isMeetingStart,
      data: notifData,
      actions: actionsForType(notifData.type),
    }).catch(() => {
      fallbackNotification(tag, title, body, onNavigate);
    });
    return true;
  }

  // Only use SW path when a SW is actually controlling the page.
  // If controller is null (first load before SW claims, or private mode),
  // fall through to new Notification() so the notification is never lost.
  if (typeof navigator !== "undefined" && "serviceWorker" in navigator && navigator.serviceWorker.controller) {
    const isCall = notifData.type === "call_incoming";
    const isMeetingStart = notifData.type === "meeting_started";
    navigator.serviceWorker.ready.then((reg) => {
      reg.showNotification(title, {
        body: body || undefined,
        tag,
        icon: "/collab.svg",
        badge: "/collab.svg",
        silent: true,
        renotify: true,
        requireInteraction: isCall || isMeetingStart,
        data: notifData,
        actions: actionsForType(notifData.type),
      } as NotificationOptions);
      // Tell the SW this tag was just shown so it deduplicates the
      // subsequent web push that arrives for the same event (~100-300ms later).
      try {
        navigator.serviceWorker.controller?.postMessage({ type: "TAG_SHOWN", tag });
      } catch (_) {}
    }).catch(() => {
      fallbackNotification(tag, title, body, onNavigate);
    });
    return true;
  }

  return fallbackNotification(tag, title, body, onNavigate);
}

function fallbackNotification(
  tag: string,
  title: string,
  body: string | undefined,
  onNavigate?: () => void,
): boolean {
  try {
    const n = new Notification(title, {
      body: body || undefined,
      tag,
      icon: "/collab.svg",
      silent: true,
    });
    n.onclick = () => {
      try { window.focus(); } catch (_) {}
      if (onNavigate) onNavigate();
      try { n.close(); } catch (_) {}
    };
    return true;
  } catch {
    return false;
  }
}
