// CoLab session hook — segment 0 (Core).
// Mechanical extraction from CoLabV1.tsx (statements 0–209),
// plus statements pulled forward so this hook is self-contained.

import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useEsc } from "../../../lib/escStack";
import { CallFeedbackMeta } from "../../CallFeedback";
import { api } from "../../../lib/api";
import { installErrorReporter } from "../../../lib/errorReporter";
import { messagePreview } from "../../../lib/messageText";
import { setTimeZonePref } from "../../../lib/time";
import { setLang } from "../../../lib/i18n";
import { bubbleAccentColor } from "../../../lib/bubbleAccent";
import { EVENTS } from "../../../lib/socket";
import { decryptMessageList, clearSessions, setChatBackupEnabled } from "../../../lib/e2ee/manager";
import { playPattern, RINGTONE_PATTERNS, MESSAGE_TONE } from "../../../lib/sounds";
import { tagFor, shouldPush, fire as fireNotif, type NotifGate, type NotifPayload } from "../../../lib/dispatchNotif";
import { isPresenting, onPresentingChange } from "../../../lib/presentation";
import { type HandoffContext } from "../../DeviceHandoff";
import { clearToken, clearRefreshToken } from "../../../lib/tokenStore";
import { isHiddenModule, HIDDEN_MODULE_FALLBACK } from "../../../lib/hiddenModules";

export function useCoLab0() {

  // ---- CoLabV1.tsx statements 0–209 (and pulled) ----
  const [mode, _setMode] = useState("dashboard");
  const setMode = useCallback((next: any) => {
    _setMode((prev: any) => {
      const resolved = typeof next === "function" ? next(prev) : next;
      return isHiddenModule(resolved) ? HIDDEN_MODULE_FALLBACK : resolved;
    });
  }, []);
  const [gxQuery, setGxQuery] = useState("");
  const [gxScope, setGxScope] = useState("all");
  const [gxOpen, setGxOpen] = useState(false);
  const [sidebarSearchTick, setSidebarSearchTick] = useState(0);
  const gxRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!gxOpen) return;
    const h = (e: MouseEvent) => {
      if (gxRef.current && !gxRef.current.contains(e.target as Node))
        setGxOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [gxOpen]);
  useEsc(gxOpen, () => setGxOpen(false));
  useEffect(() => {
    const SCOPE_MODES = new Set([
      "chats",
      "calls",
      "activity",
      "contacts",
      "calendar",
      "help",
    ]);
    setGxScope(SCOPE_MODES.has(mode) ? mode : "all");
  }, [mode]);
  const onGlobalSearchScope = useCallback((scope: string, query: string) => {
    setGxScope(scope);
    setGxQuery(query);
    // "all" opens the aggregate Search page; every other scope navigates to /
    // filters its own module in place (Help opens the Help Center).
    if (scope === "all") {
      setSearchSeed(query);
      setMode("search");
    } else {
      setMode(scope);
    }
  }, []);
  const [navHistory, setNavHistory] = useState<
    Array<{ mode: string; activeId?: any; pane?: string }>
  >([]);
  const [forwardStack, setForwardStack] = useState<
    Array<{ mode: string; activeId?: any; pane?: string }>
  >([]);
  const [theme, setTheme] = useState("light");
  const [filter, setFilter] = useState("all");
  const [commsFilter, setCommsFilter] = useState("all");
  const [callsScope, setCallsScope] = useState<"all" | "missed" | "dialled">(
    "all",
  );
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<any>(null);
  const [searchSeed, setSearchSeed] = useState("");
  const [conversations, setConversations] = useState<any[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>(() => {
    const m: Record<string, string> = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith("clb_draft_")) {
          const v = localStorage.getItem(k);
          if (v) m[k.slice("clb_draft_".length)] = v;
        }
      }
    } catch (_) {}
    return m;
  });
  const [convLoaded, setConvLoaded] = useState(false);
  const [activeId, setActiveId] = useState<any>(null);
  const [jumpMsgId, setJumpMsgId] = useState<string | null>(null);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [focusReminderId, setFocusReminderId] = useState<string | null>(null);
  const [focusMeetingId, setFocusMeetingId] = useState<string | null>(null);
  // Default: icon-only (collapsed) rail until the user expands it and saves a preference.
  const [railCollapsed, setRailCollapsed] = useState(true);
  const toggleRailCollapse = useCallback(() => {
    setRailCollapsed((c) => {
      const n = !c;
      try {
        localStorage.setItem("clb_nav_collapsed", n ? "1" : "0");
      } catch (_) {}
      return n;
    });
  }, []);
  useEffect(() => {
    try {
      const saved = localStorage.getItem("clb_nav_collapsed");
      setRailCollapsed(saved === null ? true : saved === "1");
    } catch (_) {}
  }, []);
  const activeIdRef = useRef<any>(null);
  const commsConvIdRef = useRef<string | null>(null);
  const commsOpenRef = useRef<boolean>(false);
  const modeRef = useRef<string>("dashboard");
  const mobilePaneRef = useRef<string>("list");
  const modalRef = useRef<any>(null);
  const goBackRef = useRef<() => void>(() => {});
  const onModeRef = useRef<(m: string) => void>(() => {});
  const userSelectedAtRef = useRef<number>(0);
  const seenMsgIdsRef = useRef<Set<string>>(new Set());
  const seenMsgOrderRef = useRef<string[]>([]);
  const [messagesByConv, setMessagesByConv] = useState<any>({});
  const [msgLoadStatus, setMsgLoadStatus] = useState<
    Record<string, "loading" | "loaded" | "error">
  >({});
  const msgLoadStatusRef = useRef<Record<string, "loading" | "loaded" | "error">>(
    {},
  );
  msgLoadStatusRef.current = msgLoadStatus;
  const loadMessagesRef = useRef<(id: string, force?: boolean) => Promise<void>>(
    async () => {},
  );
  const [scheduledByConv, setScheduledByConv] = useState<any>({});
  const [readState, setReadState] = useState<any>({});
  const [taskTick, setTaskTick] = useState(0);
  const [users, setUsers] = useState<any[]>([]);
  const [frequentUsers, setFrequentUsers] = useState<any[]>([]);
  const [meetings, setMeetings] = useState<any[]>([]);
  const endedMeetingIds = useMemo(
    () =>
      new Set(
        (meetings || [])
          .filter(
            (m: any) =>
              m &&
              (m.status === "completed" ||
                m.status === "cancelled" ||
                m.status === "ended"),
          )
          .map((m: any) => m.id),
      ),
    [meetings],
  );
  const [calls, setCalls] = useState<any[]>([]);
  const [voicemails, setVoicemails] = useState<any[]>([]);
  const [notifications, setNotifications] = useState<any[]>([]);
  const [notifUnread, setNotifUnread] = useState(0);
  const [callsSeenAt, setCallsSeenAt] = useState<number>(() => {
    try {
      return parseInt(localStorage.getItem("colab_calls_seen") || "0", 10) || 0;
    } catch {
      return 0;
    }
  });
  const [invites, setInvites] = useState<any[]>([]);
  const [blockedIds, setBlockedIds] = useState<Set<string>>(new Set());
  const [activeCall, setActiveCall] = useState<any>(null);
  const [feedbackMeta, setFeedbackMeta] = useState<CallFeedbackMeta | null>(
    null,
  );
  const [huddles, setHuddles] = useState<any>({});
  const [roomState, setRoomState] = useState<any>(null);
  const [preJoin, setPreJoin] = useState<any>(null);
  const joinPrefsRef = useRef<any>({ mic: true, cam: false });
  const [callPip, setCallPip] = useState(false);
  useEffect(() => {
    const d =
      typeof window !== "undefined" ? (window as any).collabDesktop : null;
    if (d && typeof d.setPictureInPicture === "function") {
      try {
        d.setPictureInPicture(callPip);
      } catch (_) {}
    }
    if (typeof document !== "undefined") {
      document.body.classList.toggle("in-pip", !!callPip);
    }
  }, [callPip]);
  const [authed, setAuthed] = useState(false);
  const [orgCount, setOrgCount] = useState<number | null>(null);
  const [orgOnboardingSkipped, setOrgOnboardingSkipped] = useState<boolean>(
    () => typeof window !== "undefined" && window.localStorage.getItem("colab.orgOnboardingSkipped") === "1",
  );
  const [orgFlowOpen, setOrgFlowOpen] = useState(false);
  const [authResolving, setAuthResolving] = useState(true);
  const refetchFilesRef = useRef<null | (() => void)>(null);
  const refetchTasksRef = useRef<null | (() => void)>(null);
  const refetchRemindersRef = useRef<null | (() => void)>(null);
  const [me, setMe] = useState<any>(null);
  const [loginError, setLoginError] = useState<any>(null);
  const [loginBusy, setLoginBusy] = useState(false);
  const [limitPrompt, setLimitPrompt] = useState<any>(null);
  const [e2eeRestoreOpen, setE2eeRestoreOpen] = useState(false);
  const [e2eeRestorePw, setE2eeRestorePw] = useState("");
  const [e2eeRestoreBusy, setE2eeRestoreBusy] = useState(false);
  const [e2eeRestoreErr, setE2eeRestoreErr] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [tasks, setTasks] = useState<any[]>([]);
  const [taskCount, setTaskCount] = useState(0);
  const [taskCursor, setTaskCursor] = useState<string | null>(null);
  const [taskHasMore, setTaskHasMore] = useState(false);
  const [taskLoadingMore, setTaskLoadingMore] = useState(false);
  const [taskConflict, setTaskConflict] = useState<any>(null);
  const [taskProjects, setTaskProjects] = useState<any[]>([]);
  const [taskViews, setTaskViews] = useState<any[]>([]);
  const [taskProjectFilter, setTaskProjectFilter] = useState<string>("");
  const taskProjectFilterRef = useRef<string>("");
  useEffect(() => {
    taskProjectFilterRef.current = taskProjectFilter;
  }, [taskProjectFilter]);
  const [files, setFiles] = useState<any[]>([]);
  const [fileCount, setFileCount] = useState(0);
  const [fileCursor, setFileCursor] = useState<string | null>(null);
  const [fileHasMore, setFileHasMore] = useState(false);
  const [fileLoadingMore, setFileLoadingMore] = useState(false);
  const [fileLoading, setFileLoading] = useState(true);
  const [fileTab, setFileTab] = useState("all");
  const [fileSearch, setFileSearch] = useState("");
  const fileTabRef = useRef("all");
  const fileSearchRef = useRef("");
  const [fileChangeTick, setFileChangeTick] = useState(0);
  const [openFileId, setOpenFileId] = useState<string | null>(null);
  const [orgTab, setOrgTab] = useState<string | null>(null);
  const isOrgNotif = useCallback(
    (n: any) =>
      !!n &&
      (n.targetType === "org" || String(n.type || "").startsWith("org_")),
    [],
  );
  const orgNotifClearedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (mode !== "org") return;
    const ids = (notifications || [])
      .filter((n) => !n.isRead && isOrgNotif(n))
      .map((n) => n.id)
      .filter((id) => id != null && !orgNotifClearedRef.current.has(String(id)));
    if (!ids.length) return;
    ids.forEach((id) => orgNotifClearedRef.current.add(String(id)));
    // Optimistic locally; the server calls are best-effort and idempotent, and
    // NOTIFICATION_COUNT remains the authoritative correction if one fails.
    setNotifications((prev) =>
      prev.map((n) => (ids.includes(n.id) ? { ...n, isRead: true } : n)),
    );
    setNotifUnread((c) => Math.max(0, c - ids.length));
    ids.forEach((id) => {
      api.markNotificationRead(tokenRef.current, id).catch(() => {});
    });
  }, [mode, notifications, isOrgNotif]);
  useEffect(() => {
    if (mode === "org") window.dispatchEvent(new Event("colab:org-notif"));
  }, [mode]);
  const [reminders, setReminders] = useState<any[]>([]);
  const [reminderCount, setReminderCount] = useState(0);
  const [reminderCounts, setReminderCounts] = useState<any>({});
  const [reminderCursor, setReminderCursor] = useState<string | null>(null);
  const [reminderHasMore, setReminderHasMore] = useState(false);
  const [reminderLoadingMore, setReminderLoadingMore] = useState(false);
  const [folders, setFolders] = useState<any[]>([]);
  const [typingBy, setTypingBy] = useState<any>({});
  const typingTimersRef = useRef<Record<string, any>>({});
  const [connected, setConnected] = useState(false);
  const [offlineDemo, setOfflineDemo] = useState(false);
  const [mobilePane, setMobilePane] = useState("list");
  const [modal, setModal] = useState<any>(null);
  const [meetingTitle, setMeetingTitle] = useState<string | null>(null);
  const [meetingAttendees, setMeetingAttendees] = useState<string[]>([]);
  const [settings, setSettings] = useState({
    theme: "light",
    accent: "indigo",
    density: "comfy",
    zoom: "1",
    fontSize: "14px",
    // Poppins is the Type Interface default typeface.
    fontFamily: "poppins",
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
    ringtone: "default",
    notifBadge: true,
    // Show the "A new version is available" banner when a fresh build is deployed
    // under a long-open session. On by default; the seamless background update
    // still happens regardless — this only governs the visible alert.
    notifyUpdates: true,
    // Presentation Mode (P0-11): auto-DND while screen sharing / presenting.
    presentationDnd: true,
    presentationDndToasts: true,
    agentStyle: "balanced",
    sidebarWidth: 348, // Figma chat list width (x 232→580)
    chatBackground: "none",
    bubbleAccent: "accent",
    autoCollapseSidebar: false, // Figma keeps the full rail open beside the chat list
    diagFloating: false,
    jumpToLatest: true,
    blurMedia: false,
    dyslexiaFont: false,
    compactList: false,
    linkConfirm: false,
    sendTyping: true,
    lastSeen: true,
    chatBackup: true,
    manualPresence: "auto",
    statusMessage: "",
    // BA/CEO #27: when ON, opening a chat during a live call/meeting shows the
    // FULL Chat module with the session minimized to a floating PiP, instead of
    // the compact in-session comms side panel. ON by default (per BA/CEO); users
    // can switch back to the compact side panel in Settings → Audio & Video.
    inMeetingChatMode: true,
  });
  const [saveStatus, setSaveStatus] = useState("saved");
  useEffect(() => {
    // Tag the body with the current module so CSS can scope rules to one module
    // (e.g. the #sb-expand floating "expand list" button — chat only). This MUST
    // run regardless of the auto-collapse setting: when the user manually
    // collapses the conversation list, #sb-expand only appears if `mode-chats`
    // is present, so gating this behind autoCollapseSidebar left the collapsed
    // list with no way to re-open it. Also clear any stale sb-collapsed class
    // when leaving chats so the expand button never lingers on other modules.
    try {
      const b = document.body;
      [
        "dashboard",
        "chats",
        "calls",
        "meetings",
        "contacts",
        "calendar",
        "activity",
        "tasks",
        "reminders",
        "files",
        "settings",
      ].forEach((m) => b.classList.toggle("mode-" + m, mode === m));
      if (mode !== "chats") b.classList.remove("sb-collapsed");
    } catch (_) {}
    // Auto-collapse the nav rail on chat entry only when that accessibility
    // setting is enabled.
    if (settings.autoCollapseSidebar) {
      setRailCollapsed(mode === "chats" && !!activeId);
    }
  }, [mode, activeId, settings.autoCollapseSidebar]);
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [manageConvId, setManageConvId] = useState<string | null>(null);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  useEffect(() => {
    const isTyping = (t: any) =>
      t &&
      (t.tagName === "INPUT" ||
        t.tagName === "TEXTAREA" ||
        t.tagName === "SELECT" ||
        t.isContentEditable);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "?" && !isTyping(e.target)) {
        e.preventDefault();
        setShortcutsOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const [toast, setToast] = useState<any>(null);
  const tokenRef = useRef<any>(null);
  useEffect(() => {
    installErrorReporter(tokenRef);
  }, []);
  const messagesByConvRef = useRef<any>({});
  const tasksRef = useRef<any[]>([]);
  const socketRef = useRef<any>(null);
  const lastRealtimeAtRef = useRef<number>(0);
  const sentFileEnvRef = useRef<Map<string, string>>(new Map());
  const uploadAbortRef = useRef<Map<string, AbortController>>(new Map());
  const keysUpdatedTimersRef = useRef<Map<string, any>>(new Map());
  const rekeyRecheckRef = useRef<Set<string>>(new Set());
  const deepLinkRef = useRef<any>(undefined);
  const deepLinkDoneRef = useRef(false);
  const activeCallRef = useRef<any>(null);
  const toastTimer = useRef<any>(null);
  const settingsRef = useRef<any>(null);
  const meRef = useRef<any>(null);
  const roomStateRef = useRef<any>(null);
  const usersRef = useRef<any[]>([]);
  const conversationsRef = useRef<any[]>([]);
  const showToast = useCallback((msg: any, icon: any = null) => {
    setToast(icon ? { text: msg, icon } : msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2400);
  }, []);
  useEffect(() => {
    const onToast = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (typeof detail === "string" && detail) showToast(detail);
    };
    window.addEventListener("colab:toast", onToast as EventListener);
    return () => window.removeEventListener("colab:toast", onToast as EventListener);
  }, [showToast]);
  useEffect(() => {
    if (!settings?.autoCollapseSidebar) return;
    try {
      if (localStorage.getItem("colab_collapsenav_notice") === "1") return;
      localStorage.setItem("colab_collapsenav_notice", "1");
      showToast("Collapsed nav is on — you can turn it off in Settings.");
    } catch (_) {}
  }, [settings?.autoCollapseSidebar, showToast]);
  const applySettings = useCallback((s) => {
    // Language & Region: make the timezone preference live so all date/time helpers
    // (lib/time.ts) render in the chosen zone. "auto"/empty follows the OS zone.
    setTimeZonePref(s && s.timezone);
    // WhatsApp-style chat-backup toggle: gate the AUTOMATIC E2EE backup writers.
    // Default ON (undefined → on); OFF stops new backups without touching restore.
    setChatBackupEnabled(!s || s.chatBackup !== false);
    // English-only for now: the language picker is hidden and the app forces
    // English regardless of any previously-saved language, so no one is stranded
    // on a half-translated locale. To re-enable localization later, restore this
    // to setLang(s && s.language) and un-hide the Settings language row.
    setLang("en");
    if (typeof document === "undefined") return;
    // MIDNIGHT and SLATE were removed. Anyone whose saved settings still name
    // one is MIGRATED rather than dropped: midnight was dark-based so it lands
    // on "dark", slate was light-based so it lands on "light". Without this an
    // existing midnight user would have snapped to a white app on next load
    // with no explanation and no matching option left in Settings. The
    // localStorage write below then persists the migrated value, so the
    // pre-paint script stops seeing the dead name too.
    //
    // Collab is ALWAYS light now: whatever theme was saved (dark, oled, auto,
    // midnight…) is overridden here, and Settings > Appearance offers Light only.
    const theme = "light";
    document.body.classList.remove("dark", "oled");
    // Strip the retired classes in case a previous session left one on the body.
    document.body.classList.remove("midnight", "slate");
    // Cache the chosen theme so the pre-paint script in app/layout.tsx can apply it
    // on the NEXT hard refresh BEFORE first paint — otherwise a dark-mode refresh
    // flashes the light splash until the server settings load. Fail-silent.
    try { localStorage.setItem("clb_theme", theme || "light"); } catch (_) {}
    // Ambiance (background effect) is independent of the theme.
    document.body.classList.toggle("amb-borealis", s.ambiance === "borealis");
    document.body.classList.toggle("amb-none", s.ambiance === "none");
    document.body.classList.remove(
      "accent-blue",
      "accent-cobalt",
      "accent-emerald",
      "accent-graphite",
      "accent-slate",
      "accent-purple",
      "accent-violet",
      "accent-teal",
      "accent-rose",
      "accent-amber",
    );
    if (s.accent && s.accent !== "indigo")
      document.body.classList.add("accent-" + s.accent);
    document.body.classList.remove("compact", "cozy", "spacious");
    if (s.density && s.density !== "comfy")
      document.body.classList.add(s.density);
    document.body.classList.remove(
      "font-inter",
      "font-plus-jakarta",
      "font-geist",
      "font-ibm-plex",
      "font-poppins",
      "font-system",
      "high-contrast",
      "reduce-motion",
      "larger-text",
    );
    const font = s.fontFamily || "poppins";
    document.body.classList.add("font-" + font);
    document.body.classList.toggle("high-contrast", !!s.highContrast);
    document.body.classList.toggle("reduce-motion", !!s.reduceMotion);
    document.body.classList.toggle("larger-text", !!s.largerText);
    document.body.classList.toggle("blur-media", !!s.blurMedia);
    document.body.classList.toggle("dyslexia-font", !!s.dyslexiaFont);
    document.body.classList.toggle("compact-list", !!s.compactList);
    try {
      // Application Zoom. Applied to #app (NOT the body) via the --uzoom var, with
      // #app's height + margin compensated by the same factor in CSS. Zooming the
      // BODY broke the layout: the body holds the 100vh shell + the ambient
      // gradient, and `vh` does NOT scale with `zoom`, so at <100% the shell fell
      // short of the viewport (the gradient band at the bottom) and at >100% it
      // overflowed/clipped. Keeping the body un-zoomed (gradient always fills) and
      // scaling #app with a compensated height fixes both. No-op at 100%.
      document.body.style.zoom = "";
      document.documentElement.style.setProperty("--uzoom", String(s.zoom || "1"));
    } catch (_) {}
    document.documentElement.style.setProperty("--msgfs", s.fontSize || "14px");
    // Chat wallpaper was removed (#12, messenger-style): conversations use a clean,
    // plain background. Clear any --chat-bg-* vars that earlier builds set on
    // <html> OR <body> so .msgs falls back to var(--main) for everyone, even
    // users who had previously saved a wallpaper/colour.
    const root = document.body.style;
    try {
      for (const el of [document.documentElement.style, root]) {
        el.removeProperty("--chat-bg-image");
        el.removeProperty("--chat-bg-size");
        el.removeProperty("--chat-bg-color");
      }
    } catch (_) {}
    // messenger-style sent-bubble accent → --me-bub (consumed by .mw.me .bub).
    // "accent"/empty means follow the theme accent, so we clear the override.
    const bubColor = bubbleAccentColor(s.bubbleAccent || "accent");
    if (bubColor) {
      root.setProperty("--me-bub", bubColor);
      // Premium gradient stops derived from the chosen colour (light → base → deep).
      root.setProperty("--me-bub-1", `color-mix(in srgb, ${bubColor} 78%, #fff)`);
      root.setProperty("--me-bub-2", bubColor);
      root.setProperty("--me-bub-3", `color-mix(in srgb, ${bubColor} 80%, #000)`);
    } else {
      root.removeProperty("--me-bub");
      root.removeProperty("--me-bub-1");
      root.removeProperty("--me-bub-2");
      root.removeProperty("--me-bub-3");
    }
    // Message bubble shape is now fixed (rounded, small radius) — see .bub /
    // .mw.me .bub in v1.css. No user-facing bubble-shape setting anymore.
  }, []);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      if (settings.theme === "auto") applySettings(settings);
    };
    if (mq.addEventListener) mq.addEventListener("change", handler);
    else if (mq.addListener) mq.addListener(handler);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", handler);
      else if (mq.removeListener) mq.removeListener(handler);
    };
  }, [settings, applySettings]);
  const changeSetting = useCallback(
    (key, value) => {
      setSettings((prev) => {
        const next = { ...prev, [key]: value };
        applySettings(next);
        return next;
      });
      if (key === "theme")
        showToast(value.charAt(0).toUpperCase() + value.slice(1) + " theme");
      if (!offlineDemo && tokenRef.current) {
        setSaveStatus("saving");
        api
          .updateSettings(tokenRef.current, { [key]: value })
          .then(() => {
            setSaveStatus("saved");
            // BA/CEO #17: Teams-style transient confirmation — a green-check pill,
            // not the old persistent "All changes saved" line. Theme already toasts
            // above, so don't double-toast it.
            if (key !== "theme")
              showToast(
                "Changes saved",
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 18,
                    height: 18,
                    borderRadius: "50%",
                    background: "#22c55e",
                    color: "#fff",
                    fontSize: 11,
                    fontWeight: 900,
                    flexShrink: 0,
                  }}
                >
                  ✓
                </span>,
              );
          })
          .catch(() => {
            setSaveStatus("error");
            showToast(
              "Couldn't save changes",
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 18,
                  height: 18,
                  borderRadius: "50%",
                  background: "#ef4444",
                  color: "#fff",
                  fontSize: 11,
                  fontWeight: 900,
                  flexShrink: 0,
                }}
              >
                !
              </span>,
            );
          });
      }
    },
    [applySettings, showToast, offlineDemo],
  );
  useEffect(() => {
    settingsRef.current = settings;
    meRef.current = me;
    roomStateRef.current = roomState;
    usersRef.current = users;
  }, [settings, me, roomState, users]);
  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);
  useEffect(() => {
    messagesByConvRef.current = messagesByConv;
  }, [messagesByConv]);
  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);
  const loadEarlierMessages = useCallback(async (convId: string) => {
    const cur = messagesByConvRef.current?.[convId] || [];
    const oldest = cur[0];
    if (!oldest || !tokenRef.current) return 0;
    try {
      const older = await api.getMessages(tokenRef.current, convId, {
        before: oldest.id,
      });
      const dec = await decryptMessageList(older);
      if (!dec.length) return 0;
      let added = 0;
      setMessagesByConv((p: any) => {
        const existing = p[convId] || [];
        const seen = new Set(existing.map((m: any) => m.id));
        const fresh = dec.filter((m: any) => !seen.has(m.id));
        added = fresh.length;
        if (!added) return p;
        return { ...p, [convId]: [...fresh, ...existing] };
      });
      return added;
    } catch {
      return 0;
    }
  }, []);
  const presentationDndActive = () =>
    isPresenting() &&
    (settingsRef.current ? settingsRef.current.presentationDnd !== false : true);
  const [presentingNow, setPresentingNow] = useState(false);
  useEffect(
    () =>
      onPresentingChange((on) => {
        setPresentingNow(on);
        const s = settingsRef.current || {};
        if (s.presentationDnd === false) return; // auto-DND turned off
        if (s.presentationDndToasts === false) return; // info messages off
        // Smart behaviour: if the user already silenced everything themselves
        // (manual DND / notifications off), we change nothing — say nothing.
        if (s.notifyLevel === "none") return;
        // Do not disturb suppresses notification toasts; Busy does NOT (Teams parity).
        if (meRef.current && meRef.current.manualPresence === "dnd") return;
        showToast(
          on
            ? "Presentation Mode enabled. Notifications are temporarily paused."
            : "Presentation Mode disabled. Notifications restored.",
        );
      }),
    [showToast],
  );
  const [moveDeviceFor, setMoveDeviceFor] = useState<HandoffContext | null>(
    null,
  );
  const [handoffOffer, setHandoffOffer] = useState<any>(null);
  const [meetingDup, setMeetingDup] = useState<any>(null);
  const dupHandledRef = useRef<Set<string>>(new Set());
  const [commsOpen, setCommsOpen] = useState(false);
  const openComms = useCallback(() => setCommsOpen((o) => !o), []);
  const [commsConvId, setCommsConvId] = useState<string | null>(null);
  const [commsJumpMsgId, setCommsJumpMsgId] = useState<string | null>(null);
  useEffect(() => {
    if (!commsOpen) {
      setCommsConvId(null);
      // Don't leave a filter or a half-finished jump behind for the NEXT call —
      // the panel should always reopen on the plain conversation list.
      setCommsFilter("all");
      setCommsJumpMsgId(null);
    }
  }, [commsOpen]);
  useEffect(() => {
    const cls = "comms-pushed";
    if (commsOpen) {
      // SEAMLESS OPEN: publish the final rail width in the SAME commit that adds
      // the push class. Rail's own effect writes --railw a frame later, which
      // made the sidebar + stage paint at the old width and then jump — the
      // residual open flicker. Only do this when the rail is actually about to
      // be force-collapsed (the call/meeting case below); otherwise we'd assert
      // a width the rail never takes and the sidebar would sit UNDER it.
      if (hasCallSessionRef.current) {
        try { document.documentElement.style.setProperty("--railw", "64px"); } catch (_) {}
      }
      document.body.classList.add(cls);
    } else document.body.classList.remove(cls);
    return () => document.body.classList.remove(cls);
  }, [commsOpen]);
  const railWasCollapsedRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (commsOpen && hasCallSessionRef.current) {
      if (railWasCollapsedRef.current === null) {
        railWasCollapsedRef.current = railCollapsed;
        if (!railCollapsed) setRailCollapsed(true);
      }
    } else if (railWasCollapsedRef.current !== null) {
      setRailCollapsed(railWasCollapsedRef.current);
      railWasCollapsedRef.current = null;
    }
    // Only react to open/close, not to the user toggling the rail mid-session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commsOpen]);
  const COMMS_MIN_W = 260;
  const COMMS_MAX_W = 560;
  const COMMS_DEFAULT_W = 320; // fixed compact width the sidebar opens at
  const [commsWidth, setCommsWidth] = useState(COMMS_DEFAULT_W);
  useEffect(() => {
    if (commsOpen) setCommsWidth(COMMS_DEFAULT_W);
  }, [commsOpen]);
  useEffect(() => {
    document.documentElement.style.setProperty(
      "--comms-w",
      `min(${commsWidth}px, 92vw)`,
    );
  }, [commsWidth]);
  const startCommsResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const base = commsWidth;
      document.body.classList.add("comms-resizing");
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      let latest = base;
      const move = (ev: MouseEvent) => {
        let w = base + (ev.clientX - startX); // delta math → works at any left offset
        if (w < COMMS_MIN_W) w = COMMS_MIN_W;
        if (w > COMMS_MAX_W) w = COMMS_MAX_W;
        latest = w;
        // Write the var DIRECTLY during drag — no setState — so the huge CoLabV1
        // tree doesn't re-render on every mousemove (smooth 1:1 tracking).
        document.documentElement.style.setProperty("--comms-w", w + "px");
      };
      const up = () => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        document.body.classList.remove("comms-resizing");
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        setCommsWidth(latest); // commit (in-session only; resets to compact on next open)
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    },
    [commsWidth],
  );
  const nudgeCommsWidth = useCallback((e: React.KeyboardEvent) => {
    const STEP = e.shiftKey ? 32 : 8;
    let delta = 0;
    if (e.key === "ArrowLeft") delta = -STEP;
    else if (e.key === "ArrowRight") delta = STEP;
    else if (e.key === "Home") delta = -Infinity;
    else if (e.key === "End") delta = Infinity;
    else return;
    e.preventDefault();
    setCommsWidth((w) => {
      let nw =
        delta === -Infinity ? COMMS_MIN_W : delta === Infinity ? COMMS_MAX_W : w + delta;
      if (nw < COMMS_MIN_W) nw = COMMS_MIN_W;
      if (nw > COMMS_MAX_W) nw = COMMS_MAX_W;
      return nw;
    });
  }, []);
  const commsResizeHandle = (
    <div
      className="comms-resize"
      onMouseDown={startCommsResize}
      onKeyDown={nudgeCommsWidth}
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label="Resize chat sidebar"
      aria-valuenow={Math.round(commsWidth)}
      aria-valuemin={COMMS_MIN_W}
      aria-valuemax={COMMS_MAX_W}
      title="Drag to resize"
    />
  );
  useEffect(() => {
    if (callPip) setCommsOpen(false);
  }, [callPip]);
  useEffect(() => {
    if (!roomState && !activeCall) setCommsOpen(false);
  }, [roomState, activeCall]);
  useEffect(() => {
    const id = commsConvId;
    if (!commsOpen || !id || offlineDemo || !tokenRef.current) return;
    setMessagesByConv((prev) => {
      if (prev[id]) return prev;
      api
        .getMessages(tokenRef.current!, id)
        .then(async (msgs) => {
          const dec = await decryptMessageList(msgs);
          setMessagesByConv((p) => ({ ...p, [id]: dec }));
        })
        .catch(() => {});
      return prev;
    });
    // Read-path parity with onSelect (which is how the MAIN pane opens a chat):
    // opening a conversation in the in-call sidebar must ALSO mark it read —
    // clear the local unread badge, tell the server (which broadcasts
    // CONVERSATION_READ to this user's other sessions and a read receipt to the
    // peer), and pull the peer's receipts. Previously the sidebar only loaded
    // history + joined the room, so reading in-call left the badge lit, never
    // receipted the sender, and never synced unread across the user's devices.
    setConversations((prev) =>
      // Same unreadAtOpen stash as the main select path (ORD-08 divider).
      prev.map((c) =>
        c.id === id ? { ...c, unread: 0, unreadAtOpen: c.unread || 0 } : c,
      ),
    );
    api
      .setRead(
        tokenRef.current!,
        id,
        true,
        settingsRef.current?.readReceipts !== false,
      )
      .catch(() => {});
    api
      .getReceipts(tokenRef.current!, id)
      .then((rs) => {
        const map: any = {};
        (rs || []).forEach((r) => {
          map[r.userId] = Date.parse(r.lastReadAt);
        });
        setReadState((p) => ({ ...p, [id]: map }));
      })
      .catch(() => {});
    if (socketRef.current && connected)
      socketRef.current.emit(EVENTS.CONVERSATION_JOIN, { conversationId: id });
  }, [commsOpen, commsConvId, connected, offlineDemo]);
  const openMoveDevice = useCallback(() => {
    const c = activeCallRef.current;
    const rs = roomStateRef.current;
    if (rs && rs.meeting && rs.meeting.id) {
      setMoveDeviceFor({
        kind: "meeting",
        meetingId: rs.meeting.id,
        title: rs.meeting.title || "Meeting",
      });
      return;
    }
    if (c) {
      const p = c.peer || null;
      setMoveDeviceFor({
        kind: "call",
        callId: c.callId || null,
        conversationId: c.conversationId || null,
        title: (p && p.name) || c.name || null,
        video: c.kind === "video",
        peer: p
          ? {
              id: p.id,
              name: p.name,
              initials: p.initials,
              color: p.color,
              avatarUrl: p.avatarUrl,
            }
          : null,
      });
    }
  }, []);
  const playNotifSound = useCallback(() => {
    try {
      const sx = settingsRef.current;
      if (sx && sx.notifSound === false) return;
      // Presentation Mode (P0-11): no notification sounds while presenting.
      if (presentationDndActive()) return;
      const Ctx =
        (window as any).AudioContext || (window as any).webkitAudioContext;
      if (!Ctx) return;
      const ac = new Ctx();
      try {
        if (ac.state === "suspended" && ac.resume) ac.resume();
      } catch (_) {}
      // Messages get a brief, soft ding — NOT the looping call ringtone — so a
      // notification never sounds like an incoming call.
      const total = playPattern(ac, MESSAGE_TONE, 0.1);
      setTimeout(
        () => {
          try {
            ac.close();
          } catch (_) {}
        },
        (total + 0.5) * 1000,
      );
    } catch (_) {}
  }, []);
  const ringtoneRef = useRef<{ ac: any; timer: any } | null>(null);
  const stopRingtone = useCallback(() => {
    const r = ringtoneRef.current;
    ringtoneRef.current = null;
    if (r) {
      try {
        clearInterval(r.timer);
      } catch (_) {}
      try {
        r.ac.close();
      } catch (_) {}
    }
  }, []);
  const startRingtone = useCallback(() => {
    if (ringtoneRef.current) return; // already ringing
    const sx = settingsRef.current;
    if (sx && sx.notifSound === false) return;
    // Presentation Mode (P0-11): an incoming call must never ring out loud
    // through a live presentation (it still lands as a missed call + Activity).
    if (isPresenting() && (!sx || sx.presentationDnd !== false)) return;
    const Ctx =
      (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return;
    let ac: any;
    try {
      ac = new Ctx();
    } catch (_) {
      return;
    }
    try {
      if (ac.state === "suspended" && ac.resume) ac.resume();
    } catch (_) {}
    const pattern =
      RINGTONE_PATTERNS[(sx && sx.ringtone) || "default"] ||
      RINGTONE_PATTERNS.default;
    const playOnce = () => {
      try {
        playPattern(ac, pattern, 0.16);
      } catch (_) {}
    };
    playOnce();
    // Re-ring on a phone-like cadence: the melody, then a short silence — derived
    // from the chosen melody's own length so each preset breathes naturally.
    const patternTotal = pattern.reduce((s, n) => s + n.dur + n.gap, 0);
    const period = Math.max(2400, Math.round((patternTotal + 1.1) * 1000));
    const timer = setInterval(playOnce, period);
    ringtoneRef.current = { ac, timer };
  }, []);
  useEffect(() => {
    let primed = false;
    const prime = () => {
      if (primed) return;
      primed = true;
      try {
        const Ctx =
          (window as any).AudioContext || (window as any).webkitAudioContext;
        if (!Ctx) return;
        const ac = new Ctx();
        if (ac.state === "suspended" && ac.resume) ac.resume();
        setTimeout(() => {
          try {
            ac.close();
          } catch (_) {}
        }, 400);
      } catch (_) {}
    };
    window.addEventListener("pointerdown", prime);
    window.addEventListener("keydown", prime);
    return () => {
      window.removeEventListener("pointerdown", prime);
      window.removeEventListener("keydown", prime);
    };
  }, []);
  const notifGateContext = (): NotifGate => ({
    settings: settingsRef.current,
    me: meRef.current,
    roomState: roomStateRef.current,
    activeCall: activeCallRef.current,
    activeId: activeIdRef.current,
    // Presentation Mode (P0-11): suppress everything while presenting (unless
    // the user turned the auto-DND setting off).
    presenting:
      isPresenting() &&
      (settingsRef.current ? settingsRef.current.presentationDnd !== false : true),
  });
  const maybeNotify = useCallback(
    (m) => {
      // Reading a chat in the in-call sidebar counts as "active" too: suppress the
      // toast/sound for the conversation currently open there. shouldPush only
      // knows about the main pane's activeId, so this covers the sidebar case.
      if (
        m &&
        commsOpenRef.current &&
        m.conversationId === commsConvIdRef.current &&
        typeof document !== "undefined" &&
        !document.hidden
      )
        return;
      // Respect per-conversation MUTE. With join-all + the user-room fan-out we
      // now receive live messages for muted chats too, but a muted conversation
      // must never sound/pop an in-app notification — mirrors the server web-push
      // mute filter and the bumpPreview priority gate.
      if (m && m.conversationId) {
        const mc = conversationsRef.current.find(
          (c) => c.id === m.conversationId,
        );
        if (mc && mc.muted) return;
      }
      const gate = notifGateContext();
      const text = (m && m.text) || "";
      const senderName = (m && m.sender && m.sender.name) || "New message";
      const body = text ? messagePreview(text).slice(0, 140) : "Sent a message";
      const payload: NotifPayload = {
        type: "message",
        id: m && m.id,
        title: senderName,
        body,
        conversationId: m && m.conversationId,
        senderId: m && m.sender && m.sender.id,
      };

      // Mentions-only mode: check text for @username before notifying
      const lvl = (gate.settings && gate.settings.notifyLevel) || "all";
      if (lvl === "mentions") {
        const meNow = gate.me;
        const name = (meNow && meNow.name) || "";
        const toks = name.split(/\s+/).filter(Boolean);
        const hit =
          /@(all|here|everyone)\b/i.test(text) ||
          toks.some((t) =>
            new RegExp(
              "@" + t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b",
              "i",
            ).test(text),
          );
        if (!hit) return;
      }

      const tag = tagFor("msg", m ? m.id : undefined);
      if (!shouldPush(gate, payload)) return;
      fireNotif(tag, senderName, body, () => {
        if (m && m.conversationId) {
          onSelect(m.conversationId);
          setMode("chats");
          if (m.id) setJumpMsgId(m.id);
        }
      }, playNotifSound, payload);
    },
    [playNotifSound],
  );
  const doLogout = useCallback(() => {
    setLogoutOpen(false);
    const tok = tokenRef.current;
    if (tok) api.logout(tok);
    import("../../../lib/pushRegistration").then((m) => m.resetPushRegistration()).catch(() => {});
    try {
      if (socketRef.current) socketRef.current.close();
    } catch (_) {}
    try {
      clearSessions();
    } catch (_) {}
    // Clear the token from localStorage AND (on desktop) the OS keychain.
    clearToken().catch(() => {});
    clearRefreshToken(); // Phase 5: drop the rotating refresh token too
    tokenRef.current = null;
    setMe(null);
    // Reset the org-onboarding gate so the NEXT (possibly different, org-less) user on
    // this browser isn't wrongly treated as having chosen "continue without an org".
    try { window.localStorage.removeItem("colab.orgOnboardingSkipped"); } catch (_) {}
    setOrgOnboardingSkipped(false);
    setOrgFlowOpen(false);
    setOrgCount(null);
    setOfflineDemo(false);
    // Purge per-conversation composer drafts so the next user on this browser
    // never inherits the prior user's unsent text (drafts are keyed by conv id).
    try {
      const keys: string[] = [];
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        if (k && k.startsWith("clb_draft_")) keys.push(k);
      }
      keys.forEach((k) => window.localStorage.removeItem(k));
    } catch (_) {}
    setDrafts({});
    setConversations([]);
    setActiveId(null);
    setAuthed(false);
    setOrgCount(null);
    // SSO sessions: after the local sign-out, ALSO end the IdP's SSO cookie by a
    // full-page trip through /api/auth/sso/logout (RP-initiated logout; the IdP
    // returns to the app root). Otherwise the next "Sign in with SSO" silently
    // re-authenticates. Local state is already cleared above, so the navigation
    // cannot be cancelled by a re-render.
    try {
      if (window.localStorage.getItem("colab.authMethod") === "sso") {
        window.localStorage.removeItem("colab.authMethod");
        window.location.assign(api.ssoLogoutUrl());
      }
    } catch (_) {}
  }, []);
  const onLeftOrg = useCallback(
    (nextOrgId: string | null, orgName: string) => {
      showToast("You left " + (orgName || "the organization") + ".");
      if (nextOrgId) {
        if (typeof window !== "undefined") window.location.reload();
      } else {
        doLogout();
      }
    },
    [showToast, doLogout],
  );
  const recheckOrgs = useCallback(() => {
    const tok = tokenRef.current;
    if (!tok) return;
    api
      .listOrgs(tok)
      .then((orgs: any[]) => setOrgCount(Array.isArray(orgs) ? orgs.length : 0))
      .catch(() => setOrgCount((c) => (c == null ? 1 : c)));
  }, []);
  useEffect(() => {
    if (!authed) return;
    recheckOrgs();
  }, [authed, recheckOrgs]);
  useEffect(() => {
    const open = () => setOrgFlowOpen(true);
    window.addEventListener("colab:open-org-flow", open);
    return () => window.removeEventListener("colab:open-org-flow", open);
  }, []);
  useEffect(() => {
    const onUnauthorized = () => {
      if (!tokenRef.current) return; // already signed out — ignore duplicates
      showToast("Your session expired. Please sign in again.");
      doLogout();
    };
    window.addEventListener("colab:unauthorized", onUnauthorized);
    return () =>
      window.removeEventListener("colab:unauthorized", onUnauthorized);
  }, [doLogout, showToast]);
  useEffect(() => {
    const onRefreshed = (e: any) => {
      const t = e?.detail?.token;
      if (!t) return;
      tokenRef.current = t;
      try {
        if (socketRef.current) (socketRef.current as any).auth = { token: t };
      } catch (_) {}
    };
    window.addEventListener("colab:token-refreshed", onRefreshed);
    return () => window.removeEventListener("colab:token-refreshed", onRefreshed);
  }, []);
  useEffect(() => {
    let handling = false;
    const onOrgInvalid = async () => {
      if (handling || !tokenRef.current) return;
      handling = true;
      try {
        // null = the LIST call itself failed (transient) — that is NOT proof the
        // user has no orgs left; bail and let the next 403 re-trigger recovery.
        // Only a definitive empty list may sign the user out.
        const orgs = await api.listOrgs(tokenRef.current).catch(() => null);
        if (orgs === null) return;
        const other = (orgs || []).find((o: any) => o && o.id);
        if (other) {
          await api.switchOrg(tokenRef.current, other.id).catch(() => {});
          showToast(
            "You were removed from an organization — switched to " +
              (other.name || "another workspace") +
              ".",
          );
          if (typeof window !== "undefined") window.location.reload();
        } else {
          showToast("You were removed from your organization. Please sign in again.");
          doLogout();
        }
      } finally {
        handling = false;
      }
    };
    window.addEventListener("colab:org-invalid", onOrgInvalid);
    return () => window.removeEventListener("colab:org-invalid", onOrgInvalid);
  }, [doLogout, showToast]);
  // A FORCED reload asked for while one is already running must not be dropped:
  // the running fetch may predate the change that asked for it (a burst of
  // re-delivered envelopes lands while the first reload is mid-flight). Remember
  // it and run exactly one more reload when the current one finishes.
  const pendingForceReloadRef = useRef<Set<string>>(new Set());
  // msgLoadStatusRef lags a render behind setMsgLoadStatus, so it cannot tell a
  // second call in the same tick that a load is already running. This can.
  const loadingNowRef = useRef<Set<string>>(new Set());
  const loadMessagesSelfRef = useRef<((id: string, force?: boolean) => Promise<void>) | null>(null);
  const loadMessages = useCallback(async (id: string, force = false) => {
    if (!id || !tokenRef.current) return;
    const st = msgLoadStatusRef.current[id];
    if (st === "loading" || loadingNowRef.current.has(id)) {
      if (force) pendingForceReloadRef.current.add(id);
      return;
    }
    if (st === "loaded" && !force) return;
    loadingNowRef.current.add(id);
    setMsgLoadStatus((s) => ({ ...s, [id]: "loading" }));
    try {
      const all = (await api.getMessages(tokenRef.current, id)) || [];
      const TAIL = 60;
      if (all.length <= TAIL) {
        const dec = await decryptMessageList(all);
        setMessagesByConv((p) => ({ ...p, [id]: dec }));
      } else {
        // Progressive (#3-A): paint the visible tail first, then merge older
        // history + any live messages that arrived during the fetch.
        const head = all.slice(0, all.length - TAIL);
        const tail = all.slice(all.length - TAIL);
        const decTail = await decryptMessageList(tail);
        setMessagesByConv((p) => (p[id] ? p : { ...p, [id]: decTail }));
        const decHead = await decryptMessageList(head);
        setMessagesByConv((p) => {
          const cur = p[id] || decTail;
          const fetched = [...decHead, ...decTail];
          const fetchedIds = new Set(fetched.map((x: any) => x.id));
          const liveExtras = cur.filter(
            (x: any) => x && x.id && !fetchedIds.has(x.id),
          );
          return { ...p, [id]: [...fetched, ...liveExtras] };
        });
      }
      setMsgLoadStatus((s) => ({ ...s, [id]: "loaded" }));
    } catch (_) {
      setMsgLoadStatus((s) => ({ ...s, [id]: "error" }));
    } finally {
      loadingNowRef.current.delete(id);
      if (pendingForceReloadRef.current.delete(id)) {
        // Run the reload that arrived while this one was in flight.
        setTimeout(() => void loadMessagesSelfRef.current?.(id, true), 0);
      }
    }
  }, []);
  loadMessagesSelfRef.current = loadMessages;
  const onSelect = useCallback(
    (id) => {
      userSelectedAtRef.current = Date.now();
      // Selecting a conversation — especially from the search-results panel —
      // must drop the search state so the sidebar snaps back to the normal
      // conversation list instead of leaving the results view stuck open until a
      // manual reload (the "after dm search this happens" defect).
      setSearch("");
      setSearchResults(null);
      // Record every distinct view so Back returns to the actual previous
      // conversation OR the conversation list (active=null), not just modules.
      if (id !== activeIdRef.current) {
        setNavHistory((h) => {
          const cur = {
            mode: modeRef.current,
            activeId: activeIdRef.current,
            pane: mobilePaneRef.current,
          };
          const last = h[h.length - 1];
          if (last && last.mode === cur.mode && last.activeId === cur.activeId)
            return h;
          return [...h, cur];
        });
        setForwardStack([]);
      }
      activeIdRef.current = id;
      setActiveId(id);
      mobilePaneRef.current = "chat";
      setMobilePane("chat");
      setConversations((prev) =>
        // ORD-08: opening zeroes the badge, but the PANE still needs the
        // at-open count to place its "New messages" divider — stash it as
        // unreadAtOpen (0 when there was nothing unread, so a later reopen
        // doesn't resurrect a stale divider).
        prev.map((c) =>
          c.id === id ? { ...c, unread: 0, unreadAtOpen: c.unread || 0 } : c,
        ),
      );
      if (!offlineDemo && tokenRef.current) {
        // Suppress the read-receipt broadcast when the user has receipts off.
        api
          .setRead(
            tokenRef.current,
            id,
            true,
            settingsRef.current?.readReceipts !== false,
          )
          .catch(() => {});
        api
          .getReceipts(tokenRef.current, id)
          .then((rs) => {
            const map: any = {};
            (rs || []).forEach((r) => {
              map[r.userId] = Date.parse(r.lastReadAt);
            });
            setReadState((p) => ({ ...p, [id]: map }));
          })
          .catch(() => {});
        loadMessages(id);
        if (socketRef.current && connected) {
          socketRef.current.emit(EVENTS.CONVERSATION_JOIN, {
            conversationId: id,
          });
          socketRef.current.emit(EVENTS.HUDDLE_SYNC, { conversationId: id });
        }
      }
    },
    [offlineDemo, connected, loadMessages],
  );
  const hasCallSessionRef = useRef(false);
  const showSidebar = mode === "chats";
  const pane = showSidebar ? mobilePane : "chat";

  return {
    mode,
    _setMode,
    setMode,
    gxQuery,
    setGxQuery,
    gxScope,
    setGxScope,
    gxOpen,
    setGxOpen,
    sidebarSearchTick,
    setSidebarSearchTick,
    gxRef,
    onGlobalSearchScope,
    navHistory,
    setNavHistory,
    forwardStack,
    setForwardStack,
    theme,
    setTheme,
    filter,
    setFilter,
    commsFilter,
    setCommsFilter,
    callsScope,
    setCallsScope,
    search,
    setSearch,
    searchResults,
    setSearchResults,
    searchSeed,
    setSearchSeed,
    conversations,
    setConversations,
    drafts,
    setDrafts,
    convLoaded,
    setConvLoaded,
    activeId,
    setActiveId,
    jumpMsgId,
    setJumpMsgId,
    openTaskId,
    setOpenTaskId,
    focusReminderId,
    setFocusReminderId,
    focusMeetingId,
    setFocusMeetingId,
    railCollapsed,
    setRailCollapsed,
    toggleRailCollapse,
    activeIdRef,
    commsConvIdRef,
    commsOpenRef,
    modeRef,
    mobilePaneRef,
    modalRef,
    goBackRef,
    onModeRef,
    userSelectedAtRef,
    seenMsgIdsRef,
    seenMsgOrderRef,
    messagesByConv,
    setMessagesByConv,
    msgLoadStatus,
    setMsgLoadStatus,
    msgLoadStatusRef,
    loadMessagesRef,
    scheduledByConv,
    setScheduledByConv,
    readState,
    setReadState,
    taskTick,
    setTaskTick,
    users,
    setUsers,
    frequentUsers,
    setFrequentUsers,
    meetings,
    setMeetings,
    endedMeetingIds,
    calls,
    setCalls,
    voicemails,
    setVoicemails,
    notifications,
    setNotifications,
    notifUnread,
    setNotifUnread,
    callsSeenAt,
    setCallsSeenAt,
    invites,
    setInvites,
    blockedIds,
    setBlockedIds,
    activeCall,
    setActiveCall,
    feedbackMeta,
    setFeedbackMeta,
    huddles,
    setHuddles,
    roomState,
    setRoomState,
    preJoin,
    setPreJoin,
    joinPrefsRef,
    callPip,
    setCallPip,
    authed,
    setAuthed,
    orgCount,
    setOrgCount,
    orgOnboardingSkipped,
    setOrgOnboardingSkipped,
    orgFlowOpen,
    setOrgFlowOpen,
    authResolving,
    setAuthResolving,
    refetchFilesRef,
    refetchTasksRef,
    refetchRemindersRef,
    me,
    setMe,
    loginError,
    setLoginError,
    loginBusy,
    setLoginBusy,
    limitPrompt,
    setLimitPrompt,
    e2eeRestoreOpen,
    setE2eeRestoreOpen,
    e2eeRestorePw,
    setE2eeRestorePw,
    e2eeRestoreBusy,
    setE2eeRestoreBusy,
    e2eeRestoreErr,
    setE2eeRestoreErr,
    inviteOpen,
    setInviteOpen,
    tasks,
    setTasks,
    taskCount,
    setTaskCount,
    taskCursor,
    setTaskCursor,
    taskHasMore,
    setTaskHasMore,
    taskLoadingMore,
    setTaskLoadingMore,
    taskConflict,
    setTaskConflict,
    taskProjects,
    setTaskProjects,
    taskViews,
    setTaskViews,
    taskProjectFilter,
    setTaskProjectFilter,
    taskProjectFilterRef,
    files,
    setFiles,
    fileCount,
    setFileCount,
    fileCursor,
    setFileCursor,
    fileHasMore,
    setFileHasMore,
    fileLoadingMore,
    setFileLoadingMore,
    fileLoading,
    setFileLoading,
    fileTab,
    setFileTab,
    fileSearch,
    setFileSearch,
    fileTabRef,
    fileSearchRef,
    fileChangeTick,
    setFileChangeTick,
    openFileId,
    setOpenFileId,
    orgTab,
    setOrgTab,
    isOrgNotif,
    orgNotifClearedRef,
    reminders,
    setReminders,
    reminderCount,
    setReminderCount,
    reminderCounts,
    setReminderCounts,
    reminderCursor,
    setReminderCursor,
    reminderHasMore,
    setReminderHasMore,
    reminderLoadingMore,
    setReminderLoadingMore,
    folders,
    setFolders,
    typingBy,
    setTypingBy,
    typingTimersRef,
    connected,
    setConnected,
    offlineDemo,
    setOfflineDemo,
    mobilePane,
    setMobilePane,
    modal,
    setModal,
    meetingTitle,
    setMeetingTitle,
    meetingAttendees,
    setMeetingAttendees,
    settings,
    setSettings,
    saveStatus,
    setSaveStatus,
    logoutOpen,
    setLogoutOpen,
    shortcutsOpen,
    setShortcutsOpen,
    manageConvId,
    setManageConvId,
    onboardingOpen,
    setOnboardingOpen,
    toast,
    setToast,
    tokenRef,
    messagesByConvRef,
    tasksRef,
    socketRef,
    lastRealtimeAtRef,
    sentFileEnvRef,
    uploadAbortRef,
    keysUpdatedTimersRef,
    rekeyRecheckRef,
    deepLinkRef,
    deepLinkDoneRef,
    activeCallRef,
    toastTimer,
    settingsRef,
    meRef,
    roomStateRef,
    usersRef,
    conversationsRef,
    showToast,
    applySettings,
    changeSetting,
    loadEarlierMessages,
    presentationDndActive,
    presentingNow,
    setPresentingNow,
    moveDeviceFor,
    setMoveDeviceFor,
    handoffOffer,
    setHandoffOffer,
    meetingDup,
    setMeetingDup,
    dupHandledRef,
    commsOpen,
    setCommsOpen,
    openComms,
    commsConvId,
    setCommsConvId,
    commsJumpMsgId,
    setCommsJumpMsgId,
    railWasCollapsedRef,
    COMMS_MIN_W,
    COMMS_MAX_W,
    COMMS_DEFAULT_W,
    startCommsResize,
    nudgeCommsWidth,
    commsResizeHandle,
    openMoveDevice,
    playNotifSound,
    ringtoneRef,
    stopRingtone,
    startRingtone,
    notifGateContext,
    maybeNotify,
    doLogout,
    onLeftOrg,
    recheckOrgs,
    loadMessages,
    onSelect,
    hasCallSessionRef,
    showSidebar,
    pane,
  };
}
