import React, { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import config from "../lib/config";
// Brand icon + wordmark are inline SVG components (theme-aware), see components/brand/Logo.tsx.
import { CollabIcon, CollabWordmark } from "./brand/Logo";
import { useT } from "../lib/i18n";
import DownloadModal, { DlOpt } from "./DownloadModal";
import OrgSwitcher from "./OrgSwitcher"; // BA/CEO #10: org switcher in the main rail
import { HIDDEN_MODULES } from "../lib/hiddenModules";
import {
  IconLayoutDashboard,
  IconBell,
  IconSearch,
  IconMessageSquare,
  IconSparkles,
  IconFile,
  IconVideo,
  IconPhone,
  IconUsers,
  IconSquareCheck,
  IconList,
  IconCalendarDays,
  IconSettings,
  IconDownload,
  IconHelpCircle,
  IconActivity,
  IconLogOut,
  IconChevronLeft,
  IconChevronRight,
  IconPencil,
  IconCheck,
  IconX,
  IconUser,
} from "../lib/icons";


// Canonical Lucide, drawn from the shared lib/icons module so the rail is the
// SAME icon source as every other surface (no per-file drift). `.rb svg` in
// v1.css sizes them to 18px / stroke 1.8, overriding the components' defaults.
const ICONS: Record<string, React.ReactNode> = {
  dashboard: <IconLayoutDashboard />,
  activity: <IconBell />,
  search: <IconSearch />,
  chats: <IconMessageSquare />,
  agents: <IconSparkles />,
  files: <IconFile />,
  meetings: <IconVideo />,
  calls: <IconPhone />,
  contacts: <IconUsers />,
  tasks: <IconSquareCheck />,
  reminders: <IconList />,
  calendar: <IconCalendarDays />,
};

const LABELS: Record<string, string> = {
  dashboard: "Dashboard",
  activity: "Activity",
  search: "Search",
  chats: "Messages",
  agents: "Agents",
  files: "Files",
  meetings: "Meetings",
  calls: "Calls",
  contacts: "Contacts",
  tasks: "Tasks",
  reminders: "Reminders",
  calendar: "Calendar",
};

// Only modes that actually exist are wired, so there are no dead nav items.
// Meetings / Files / Agents get their entries when those modules are built.
// Section headers removed per request — "Workspace" and "Operations" both. The
// items stay and now render as one continuous, unlabelled list, which is what
// the nav had effectively become once Operations lost its header: a single
// heading over a list that is already obviously the workspace nav was labelling
// the obvious. The render site skips the header whenever `label` is absent.
const ALL_GROUPS: { label?: string; items: string[] }[] = [
  // WORKSPACE header restored per the Figma "Collab Screens" dashboard.
  { label: "Workspace", items: ["dashboard", "chats", "calls", "contacts", "calendar"] },
  { items: ["activity", "tasks", "reminders", "files"] },
  { items: ["search", "agents"] },
];
// Product feature flags. Global Search (P1.1) and Agents (P1.10) are hidden by
// default — their components/routes/APIs stay intact; flipping the flag in
// config restores the nav entry. Empty groups (e.g. Automation) are dropped.
const HIDDEN_NAV = new Set<string>([
  // Tasks / Reminders / Files come from the SHARED list in lib/hiddenModules so
  // the nav and the router can never disagree. They used to be listed here only,
  // which hid the nav entries while leaving the modules fully reachable through
  // notifications, deep links and restored state — clicking an Activity
  // notification landed the user in Files. CoLabV1 now gates setMode on the same
  // list, so this is presentation and that is enforcement, from one source.
  ...HIDDEN_MODULES,
  ...(config.features.globalSearch ? [] : ["search"]),
  ...(config.features.agents ? [] : ["agents"]),
]);
const GROUPS = ALL_GROUPS.map((g) => ({
  ...g,
  items: g.items.filter((id) => !HIDDEN_NAV.has(id)),
})).filter((g) => g.items.length > 0);

// Fixed sidebar width (drag-resize removed). Pulled in from 248 → 212 so the nav
// labels aren't marooned with a wide empty gutter on the right.
// 230px per the Figma "Collab Screens" rail (Rectangle 6279); keep in sync
// with --rail-w in styles/tokens.css.
const DEFAULT_W = 230;

// Presence options for the profile popover (Teams-style status picker). Mirrors
// the SELF_STATUS_OPTS the old "You"-conversation status setter used, so the dot
// classes (s-on/s-bs/s-aw/s-off) and manualPresence values stay identical.
const PRESENCE_OPTS = [
  { value: "auto", dot: "s-on", label: "Available" },
  { value: "busy", dot: "s-bs", label: "Busy" },
  { value: "dnd", dot: "s-bs", label: "Do not disturb" },
  { value: "brb", dot: "s-aw", label: "Be right back" },
  { value: "away", dot: "s-aw", label: "Appear away" },
  { value: "offline", dot: "s-off", label: "Appear offline" },
];
const presenceLabelOf = (p: string) =>
  (PRESENCE_OPTS.find((o) => o.value === p) || PRESENCE_OPTS[0]).label;
const presenceDotOf = (p: string) =>
  (PRESENCE_OPTS.find((o) => o.value === p) || PRESENCE_OPTS[0]).dot;

function RailImpl({
  mode,
  onMode,
  onLogout,
  onOpenSettings,
  onOpenHelp,
  diagEnabled = false,
  unread,
  notifUnread,
  // BA #5: unread org-scoped notifications → dot on the org switcher toggle.
  orgNotifUnread = 0,
  taskCount,
  reminderCount,
  requestCount,
  me,
  collapsed: collapsedPref = false,
  onToggleCollapse,
  presence = "auto",
  statusMessage = "",
  onPresenceChange,
  onStatusMessageChange,
  onUpdateName,
  token = null,
}) {
  // Localized nav label (Language & Region). Falls back to the English literal for
  // any key a catalog hasn't translated, so partial coverage never shows a raw key.
  const tr = useT();
  const label = (id: string) => tr("nav." + id, LABELS[id]);
  // v1.css squeezes the rail to 64px at ≤1024px. Render it genuinely collapsed
  // there too, so the .collapsed rules (hidden wordmark, 40px icon column,
  // pinned badges, compact org tile) and the icon tooltips apply — otherwise
  // the expanded layout gets crushed into the narrow strip. The user's own
  // collapse preference is left untouched for when the window widens again.
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 1024px)");
    const sync = () => setNarrow(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  const collapsed = collapsedPref || narrow;
  // Sidebar width is FIXED — drag-resize was removed, so this is a constant
  // (no width state, no persisted clb_nav_w, no resize handle).
  const width = DEFAULT_W;
  // Profile toggle (Teams-style): a self avatar + name/status button in the foot,
  // ABOVE Settings, opening a popover (identity + presence picker + status message
  // + Sign out). The popover is PORTALED to <body> (like every other floating menu
  // in the app — see ChatView's Portal) and fixed-positioned from the button rect,
  // so it escapes the rail's stacking/overflow AND the `#app { zoom: var(--uzoom) }`
  // scaling that would otherwise offset a fixed descendant from its trigger. Closes
  // on a click outside BOTH the trigger and the portaled popover.
  const POP_W = 300;
  const [profileOpen, setProfileOpen] = useState(false);
  const [profilePos, setProfilePos] = useState<{ left: number; bottom: number } | null>(null);
  const [statusDraft, setStatusDraft] = useState("");
  // Inline "edit your name" (Teams-style pencil on the identity row). Held local
  // so a mid-edit draft never mutates the live profile until Save.
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  // Teams-style: presence + status message are BURIED under their own expanders
  // (a single current-status row that opens the picker; a "Set status message" row
  // that opens the input) — not listed inline. Collapsed by default each open.
  const [presenceExpanded, setPresenceExpanded] = useState(false);
  const [statusExpanded, setStatusExpanded] = useState(false);
  // Fall back to initials if the profile photo fails to load (avatarUrl can be a
  // stale / unreachable URL) — avoids the broken-image icon in the rail chip.
  const [avatarBroken, setAvatarBroken] = useState(false);
  useEffect(() => {
    setAvatarBroken(false);
  }, [me?.avatarUrl]);
  const showAvatarImg = !!(me?.avatarUrl && !avatarBroken);
  const profileRef = useRef<HTMLDivElement>(null);
  const profileBtnRef = useRef<HTMLButtonElement>(null);
  const profilePopRef = useRef<HTMLDivElement>(null);
  const openProfile = useCallback(() => {
    setProfileOpen((v) => {
      const next = !v;
      if (next && profileBtnRef.current) {
        setStatusDraft(statusMessage || "");
        setEditingName(false);
        setPresenceExpanded(false);
        setStatusExpanded(false);
        const r = profileBtnRef.current.getBoundingClientRect();
        // Clamp into the viewport so a narrow window can't push it off either edge.
        const left = Math.max(8, Math.min(r.left, window.innerWidth - 8 - POP_W));
        setProfilePos({ left, bottom: window.innerHeight - r.top + 8 });
      }
      return next;
    });
  }, [statusMessage]);
  useEffect(() => {
    if (!profileOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      // The popover is portaled under <body>, so it is NOT a DOM descendant of the
      // trigger wrapper — check both, else clicking the popover dismisses it before
      // an item's handler runs.
      if (profileRef.current && profileRef.current.contains(t)) return;
      if (profilePopRef.current && profilePopRef.current.contains(t)) return;
      setProfileOpen(false);
    };
    const t = setTimeout(() => document.addEventListener("mousedown", onDown), 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", onDown);
    };
  }, [profileOpen]);
  const meInitials =
    (me && me.initials) ||
    ((me && me.name ? String(me.name) : "?").trim().slice(0, 1).toUpperCase());
  // Update/Download button: in the desktop app it checks for a new app build;
  // in a browser it downloads the latest installer. Read collabDesktop AFTER
  // mount (it exists only in the Electron shell) to avoid a hydration mismatch.
  const [isDesktop, setIsDesktop] = useState(false);
  // Live health level for the foot "Diagnostics" dot, mirrored from the panel.
  const [diagLevel, setDiagLevel] = useState<string>("success");
  useEffect(() => {
    try {
      const cur = (window as any).__colabDiagLevel;
      if (typeof cur === "string") setDiagLevel(cur);
    } catch { }
    const h = (e: any) => setDiagLevel((e && e.detail) || "success");
    window.addEventListener("colab:diag-level", h as any);
    return () => window.removeEventListener("colab:diag-level", h as any);
  }, []);
  useEffect(() => {
    try { setIsDesktop(!!(window as any).collabDesktop); } catch { }
  }, []);
  // Desktop-only: is a newer build available? Compare the running app version vs
  // /desktop/latest.json "version" using the SAME dotted-numeric compare as the
  // native updater (desktop/updater.js cmpVersion) so the badge and OS updater
  // never disagree. Browser → no badge (download menu shown instead).
  const [updateAvail, setUpdateAvail] = useState(false);
  useEffect(() => {
    const cd: any = typeof window !== "undefined" ? (window as any).collabDesktop : null;
    const current: string | undefined = cd?.appInfo?.version;
    if (!current) return;
    let alive = true;
    const cmp = (a: string, b: string) => {
      const pa = String(a || "0").split(".").map((n) => parseInt(n, 10) || 0);
      const pb = String(b || "0").split(".").map((n) => parseInt(n, 10) || 0);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const x = pa[i] || 0, y = pb[i] || 0;
        if (x > y) return 1;
        if (x < y) return -1;
      }
      return 0;
    };
    const check = async () => {
      try {
        const r = await fetch("/desktop/latest.json", { cache: "no-store" });
        const j = await r.json();
        const latest: string | undefined = j && j.version;
        if (alive && latest) setUpdateAvail(cmp(latest, current) > 0);
      } catch { /* offline / missing manifest → leave the badge as-is */ }
    };
    check();
    // Re-check on an interval AND when the window regains focus, so the badge
    // self-corrects after a release changes the manifest. Without this, a mount-time
    // read taken while the manifest still showed an older version stays stuck even
    // once the app matches "latest" (the native updater re-fetches, this didn't).
    const iv = setInterval(check, 30 * 60 * 1000);
    const onFocus = () => check();
    window.addEventListener("focus", onFocus);
    return () => {
      alive = false;
      clearInterval(iv);
      window.removeEventListener("focus", onFocus);
    };
  }, []);
  // Web download modal — version + per-OS installers, lazily loaded from the
  // /desktop/latest.json manifest (the same one the update badge reads).
  const [dlOpen, setDlOpen] = useState(false);
  const [dlOpts, setDlOpts] = useState<DlOpt[]>([]);
  const [dlMeta, setDlMeta] = useState<{ version?: string; notes?: string }>({});
  const onAppUpdate = useCallback(async () => {
    const cd: any = typeof window !== "undefined" ? (window as any).collabDesktop : null;
    // Desktop app → update ONLY this OS's build via the native updater.
    if (cd && cd.checkForUpdates) {
      try { cd.checkForUpdates(); } catch { }
      return;
    }
    // Browser → open the enterprise download modal with all OS installers.
    try {
      const r = await fetch("/desktop/latest.json", { cache: "no-store" });
      const j = await r.json();
      const ch = (j && j.channels) || {};
      const opts: DlOpt[] = [];
      // `available` comes straight from the manifest (the team's source of truth
      // for what's actually built) so a genuinely-published build (Windows) is
      // offered even if a runtime HEAD probe is flaky, while not-yet-built OSes
      // (mac/Linux) stay "Coming soon". Undefined → the modal falls back to HEAD.
      const w = ch.windows && ch.windows.x64;
      if (w && w.installer) opts.push({ key: "win", os: "win", label: "Windows", sub: ".exe installer", url: w.installer, size: w.size, available: w.available });
      const m = ch.mac && (ch.mac.universal || ch.mac.x64);
      if (m && m.installer) opts.push({ key: "mac", os: "mac", label: "macOS", sub: ".pkg (universal)", url: m.installer, size: m.size, available: m.available });
      const l = ch.linux && ch.linux.x64;
      if (l && l.appimage) opts.push({ key: "lin-app", os: "linux", label: "Linux", sub: "AppImage", url: l.appimage, size: l.appimageSize, available: l.available });
      if (l && l.deb) opts.push({ key: "lin-deb", os: "linux", label: "Linux", sub: ".deb (Debian / Ubuntu)", url: l.deb, size: l.debSize, available: l.available });
      if (!opts.length && j && j.url) opts.push({ key: "any", os: "win", label: "Collab", sub: "Installer", url: j.url });
      setDlOpts(opts);
      setDlMeta({ version: j && j.version, notes: j && j.notes });
    } catch {
      // Manifest unreachable → open the modal with an empty/honest state.
      setDlOpts([]);
      setDlMeta({});
    }
    setDlOpen(true);
  }, []);

  // Expose the rail's live width so overlays (e.g. #sb-expand) can sit just to
  // its right instead of overlapping the rail at a hard-coded offset.
  useEffect(() => {
    try { document.documentElement.style.setProperty("--railw", (collapsed ? 64 : width) + "px"); } catch (_) { }
  }, [collapsed, width]);

  const toggleCollapse = useCallback(() => {
    onToggleCollapse && onToggleCollapse();
  }, [onToggleCollapse]);

  // (Sidebar drag-resize + keyboard-resize removed — the width is now fixed.)

  const badgeFor = (id) =>
    id === "chats"
      ? unread
      : id === "activity"
        ? notifUnread
        : id === "contacts"
          ? requestCount
          : id === "tasks"
            ? taskCount
            : id === "reminders"
              ? reminderCount
              : 0;

  return (
    <nav
      id="rail"
      className={collapsed ? "collapsed" : ""}
      style={{ width: collapsed ? 64 : width }}
    >
      <div className="rl">
        {/* Brand: logo + "Collab" wordmark, left-aligned. When collapsed the
            wordmark hides and the logo stays; hovering the header swaps the logo
            for the expand chevron in-place, so the two never collide. */}
        <div className="rl-brand">
          <CollabIcon className="rl-logo" title={config.appName} />
          {/* "Collab" wordmark as the brand SVG (not HTML text). One component: the
              lettering is gradient on light and white on dark (body.dark) by itself.
              .rl-name lets the collapsed rule hide it like the old text span. */}
          <CollabWordmark className="rl-name" />
        </div>
        {/* Collapse/expand handle: a round tab centred on the header row's RIGHT
            edge (= the rail↔content divider). It lives INSIDE .rl (which is
            position:relative), so it's positioned against that concrete 52px ×
            rail-width header box — never the viewport — and thus can't be thrown
            off by any app frame. Out of flow (absolute), so it adds no width. */}
        <button
          className="rl-collapse"
          onClick={toggleCollapse}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          data-tip={collapsed ? "Expand" : "Collapse"}
        >
          {collapsed ? <IconChevronRight /> : <IconChevronLeft />}
        </button>
      </div>
      {/* BA/CEO #10 + org-dropdown clipping fix: the Organization switcher is a
          DIRECT child of the rail (NOT inside .rl-scroll) so its dropdown menu
          isn't clipped by the scroll container's overflow. Renders nothing when
          the session has no org (single-tenant unchanged). */}
      <div className="rl-org">
        <OrgSwitcher
          token={token}
          variant="rail"
          collapsed={collapsed}
          orgNotifUnread={orgNotifUnread}
          // BA #7: routes to the Organization MODULE (mode === "org") instead of
          // opening a modal/overlay, so it participates in normal navigation.
          onOpenOrg={() => onMode("org")}
          orgActive={mode === "org"}
        />
        {/* WhatsApp (Trustsignal) — sits directly under the org entry. Opens the
            WhatsApp module (mode === "whatsapp"): connect an account, then send and
            receive customer messages. */}
        {/* Temporarily hidden from the rail.
        <button
          className={"rb rb-wa" + (mode === "whatsapp" ? " active" : "")}
          data-tip={collapsed ? "WhatsApp" : undefined}
          aria-label="WhatsApp"
          aria-current={mode === "whatsapp" ? "page" : undefined}
          onClick={() => onMode("whatsapp")}
        >
          <span className="rb-ico"><IconWhatsApp /></span>
          <span className="rb-lbl">WhatsApp</span>
        </button>
        */}
      </div>
      <div className="rl-scroll">
        {GROUPS.map((g, gi) => (
          <div className="rl-group" key={gi}>
            {/* {g.label ? (
              <div className="rl-grouphdr">{tr("group." + g.label.toLowerCase(), g.label)}</div>
            ) : null} */}
            {g.items.map((id) => {
              const b = badgeFor(id);
              return (
                <button
                  key={id}
                  className={"rb" + (mode === id ? " active" : "")}
                  data-tip={
                    collapsed ? label(id) + (b ? " · " + (b > 99 ? "99+" : b) : "") : undefined
                  }
                  aria-label={label(id)}
                  aria-current={mode === id ? "page" : undefined}
                  onClick={() => onMode(id)}
                >
                  <span className="rb-ico">{ICONS[id]}</span>
                  <span className="rb-lbl">{label(id)}</span>
                  {/* The badge circle grows with the digits (rail.css); on the
                      40px collapsed icon cap it at 99+ so it can't swallow the icon. */}
                  {b ? <span className="rbadge">{collapsed && b > 99 ? "99+" : b}</span> : null}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <div
        style={{
          height: '1px',
          // background: 'var(--g150, var(--g200))',
          margin: '5px 4px 3px 8px',
          width: 'calc(100% - 12px)',
          border: "1px solid var(--g150, var(--g200))"
        }}
      />
      <div className="rl-foot">
        {/* Settings gear */}
        <button
          className={"rb rb-accent" + (mode === "settings" ? " active" : "")}
          onClick={onOpenSettings}
          aria-label="Settings"
          aria-current={mode === "settings" ? "page" : undefined}
          data-tip={collapsed ? "Settings" : undefined}
        >
          <span className="rb-ico">
            <IconSettings />
          </span>
          <span className="rb-lbl">{tr("common.settings", "Settings")}</span>
        </button>
        <button
          className={"rb rb-accent" + (mode === "help" ? " active" : "")}
          onClick={onOpenHelp}
          aria-label="Help"
          aria-current={mode === "help" ? "page" : undefined}
          data-tip={collapsed ? "Help" : undefined}
        >
          <span className="rb-ico">
            <IconHelpCircle />
          </span>
          <span className="rb-lbl">{tr("common.help", "Help")}</span>
        </button>
        {/* Download app — placed BELOW Help (user request). */}
        <div className="rb-dl-wrap" style={{ position: "relative" }}>
          <DownloadModal
            open={dlOpen && !isDesktop}
            version={dlMeta.version}
            notes={dlMeta.notes}
            opts={dlOpts}
            onClose={() => setDlOpen(false)}
          />
          {!isDesktop ? (
            <button
              className="rb rb-update"
              onClick={onAppUpdate}
              aria-label="Download app (desktop and mobile)"
              data-tip={collapsed ? "Download app" : undefined}
            >
              <span className="rb-ico">
                <IconDownload />
              </span>
              <span className="rb-lbl">{tr("common.download", "Download app")}</span>
            </button>
          ) : null}
        </div>
        {diagEnabled ? (
          <button
            className="rb"
            onClick={() => { try { (window as any).__colabDiag?.(); } catch { } }}
            aria-label="Diagnostics"
            data-tip={collapsed ? "Diagnostics" : undefined}
          >
            <span className="rb-ico" style={{ position: "relative" }}>
              <IconActivity />
              <span
                aria-hidden
                style={{
                  position: "absolute",
                  top: -1,
                  right: -1,
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  border: "2px solid var(--sb)",
                  boxSizing: "content-box",
                  background:
                    diagLevel === "error"
                      ? "var(--red, #dc2626)"
                      : diagLevel === "warn"
                        ? "#d97706"
                        : "#16a34a",
                }}
              />
            </span>
            <span className="rb-lbl">Diagnostics</span>
          </button>
        ) : null}
        {/* Profile (Teams-style): your avatar + name/status, opening a popover
            with your identity, a presence picker, a status-message field, and
            Sign out (top-right). Placed below Download app. */}
        <div className="rl-profile-wrap" ref={profileRef}>
          <button
            ref={profileBtnRef}
            className={"rb rl-profile" + (profileOpen ? " active" : "")}
            onClick={openProfile}
            aria-label="Profile"
            aria-expanded={profileOpen}
            data-tip={collapsed ? me?.name || "Profile" : undefined}
          >
            <span className="rb-ico">
              <span className="rl-profile-av" style={{ background: me?.color || "var(--ac, #6366F1)" }}>
                {showAvatarImg ? (
                  <img
                    className="rl-profile-av-img"
                    src={me.avatarUrl}
                    alt=""
                    onError={() => setAvatarBroken(true)}
                  />
                ) : (
                  meInitials
                )}
                <span className={"rl-profile-pdot " + presenceDotOf(presence)} />
              </span>
            </span>
            <span className="rb-lbl rl-profile-lbl">
              <span className="rl-profile-name" title={me?.name || "You"}>{me?.name || "You"}</span>
              <span className="rl-profile-status" title={statusMessage || presenceLabelOf(presence)}>
                {statusMessage || presenceLabelOf(presence)}
              </span>
            </span>
          </button>
          {profileOpen && profilePos
            ? createPortal(
              <div
                ref={profilePopRef}
                className="rl-profile-pop"
                role="menu"
                style={{ position: "fixed", left: profilePos.left, bottom: profilePos.bottom, width: POP_W }}
              >
                <div className="rl-profile-pop-hd">
                  <span className="rl-profile-pop-eyebrow">Personal</span>
                  <button
                    className="rl-profile-pop-signout"
                    onClick={() => {
                      setProfileOpen(false);
                      onLogout && onLogout();
                    }}
                  >
                    <IconLogOut size={13} /> {tr("common.signout", "Sign out")}
                  </button>
                </div>
                <div className="rl-profile-pop-id">
                  <span className="rl-profile-av lg" style={{ background: me?.color || "var(--ac, #6366F1)" }}>
                    {showAvatarImg ? (
                      <img
                        className="rl-profile-av-img"
                        src={me.avatarUrl}
                        alt=""
                        onError={() => setAvatarBroken(true)}
                      />
                    ) : (
                      meInitials
                    )}
                  </span>
                  <div className="rl-profile-pop-idtext">
                    {editingName ? (
                      <div className="rl-profile-pop-nameedit">
                        <input
                          className="rl-profile-pop-nameinput"
                          type="text"
                          autoFocus
                          maxLength={60}
                          value={nameDraft}
                          placeholder="Your name"
                          onChange={(e) => setNameDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              const v = nameDraft.trim();
                              if (v && v !== me?.name) onUpdateName && onUpdateName(v);
                              setEditingName(false);
                            } else if (e.key === "Escape") {
                              setEditingName(false);
                            }
                          }}
                        />
                        <button
                          className="rl-profile-pop-nameok"
                          aria-label="Save name"
                          onClick={() => {
                            const v = nameDraft.trim();
                            if (v && v !== me?.name) onUpdateName && onUpdateName(v);
                            setEditingName(false);
                          }}
                        >
                          <IconCheck size={14} />
                        </button>
                        <button
                          className="rl-profile-pop-namecancel"
                          aria-label="Cancel"
                          onClick={() => setEditingName(false)}
                        >
                          <IconX size={14} />
                        </button>
                      </div>
                    ) : (
                      <div className="rl-profile-pop-namerow">
                        <div className="rl-profile-pop-name" title={me?.name || "You"}>{me?.name || "You"}</div>
                        {onUpdateName ? (
                          <button
                            className="rl-profile-pop-nameedit-btn"
                            aria-label="Edit name"
                            data-tip="Edit name"
                            onClick={() => {
                              setNameDraft(me?.name || "");
                              setEditingName(true);
                            }}
                          >
                            <IconPencil size={13} />
                          </button>
                        ) : null}
                      </div>
                    )}
                    <div className="rl-profile-pop-mail" title={me?.email || ""}>{me?.email || ""}</div>
                  </div>
                </div>
                {/* View profile — a Teams-style row toggle (icon · label · chevron),
                  consistent with the presence / status rows below. → Settings. */}
                {onOpenSettings ? (
                  <button
                    className="rl-profile-pop-item"
                    onClick={() => {
                      setProfileOpen(false);
                      onOpenSettings();
                    }}
                  >
                    <IconUser size={15} className="rl-profile-pop-optic" />
                    <span className="rl-profile-pop-optlbl">View profile</span>
                    <IconChevronRight size={14} className="rl-profile-pop-chev" />
                  </button>
                ) : null}
                {onPresenceChange ? (
                  <>
                    {/* Presence — a SINGLE row showing the current status; clicking it
                      expands the picker (Teams-style "Available ›"). */}
                    <button
                      className={"rl-profile-pop-item rl-profile-pop-expander" + (presenceExpanded ? " open" : "")}
                      aria-expanded={presenceExpanded}
                      onClick={() => setPresenceExpanded((v) => !v)}
                    >
                      <span className={"cv-ss-dot " + presenceDotOf(presence)} />
                      <span className="rl-profile-pop-optlbl">{presenceLabelOf(presence)}</span>
                      <IconChevronRight size={14} className="rl-profile-pop-chev" />
                    </button>
                    {presenceExpanded ? (
                      <div className="rl-profile-pop-sub">
                        {PRESENCE_OPTS.map((opt) => (
                          <button
                            key={opt.value}
                            className={"rl-profile-pop-item" + (presence === opt.value ? " active" : "")}
                            onClick={() => {
                              onPresenceChange(opt.value);
                              setPresenceExpanded(false);
                            }}
                          >
                            <span className={"cv-ss-dot " + opt.dot} />
                            <span className="rl-profile-pop-optlbl">{opt.label}</span>
                            {presence === opt.value ? <span className="rl-profile-pop-check">✓</span> : null}
                          </button>
                        ))}
                      </div>
                    ) : null}
                    {/* Status message — a SINGLE row; clicking it expands the input. */}
                    <button
                      className={"rl-profile-pop-item rl-profile-pop-expander" + (statusExpanded ? " open" : "")}
                      aria-expanded={statusExpanded}
                      onClick={() => setStatusExpanded((v) => !v)}
                    >
                      <IconPencil size={15} className="rl-profile-pop-optic" />
                      <span className="rl-profile-pop-optlbl">
                        {statusMessage ? statusMessage : "Set status message"}
                      </span>
                      <IconChevronRight size={14} className="rl-profile-pop-chev" />
                    </button>
                    {statusExpanded ? (
                      <div className="rl-profile-pop-sub">
                        <div className="rl-profile-pop-msg">
                          <input
                            className="rl-profile-pop-input"
                            type="text"
                            autoFocus
                            placeholder="Set a status message"
                            maxLength={60}
                            value={statusDraft}
                            onChange={(e) => setStatusDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                onStatusMessageChange && onStatusMessageChange(statusDraft);
                                setProfileOpen(false);
                              } else if (e.key === "Escape") {
                                setStatusExpanded(false);
                              }
                            }}
                          />
                          <button
                            className="rl-profile-pop-save"
                            onClick={() => {
                              onStatusMessageChange && onStatusMessageChange(statusDraft);
                              setProfileOpen(false);
                            }}
                          >
                            Save
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </>
                ) : null}
              </div>,
              document.body,
            )
            : null}
        </div>
      </div>
    </nav>
  );
}

// Memoized: the nav rail is mounted on every screen, so without this it
// re-rendered on every background socket event. Its props (mode, counts, me,
// stable onMode/onOpenSettings/onLogout) only change on real navigation/state
// changes, so the default shallow compare lets it skip chat/presence traffic.
export default React.memo(RailImpl);
