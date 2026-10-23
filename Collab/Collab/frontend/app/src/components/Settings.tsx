"use client";
import React, { useState, useRef, useEffect, useCallback } from "react";
import { api } from "../lib/api";
import { confirmDialog } from "../lib/dialog";
import PremiumSelect from "./PremiumSelect";
import Select from "./ui/Select";
import ConnectionCheck from "./ConnectionCheck";
import CameraTestModal from "./CameraTestModal";
import { resolveMediaUrl } from "../lib/image";
import { BUBBLE_ACCENTS, bubbleAccentColor } from "../lib/bubbleAccent";
import ConcernComposer from "./ConcernComposer";
import { sanitizeMessageHtml } from "../lib/sanitizeHtml";
import AvatarCropModal from "./AvatarCropModal";
// import E2EESecurityPanel from "./E2EESecurityPanel"; // hidden — see Security section
import { previewRingtone } from "../lib/sounds";
import { isDesktopApp } from "../lib/platform";
import { localTime, localDay } from "../lib/time";
import { useT } from "../lib/i18n";
import SearchableSelect from "./SearchableSelect";
import {
  IconPlay,
  IconContrast,
  IconVideo,
  IconMessageSquare,
  IconBell,
  IconPersonStanding,
  IconGlobe,
  IconShield,
  IconShieldCheck,
  IconAlertTriangle,
  IconClock,
  IconMonitor,
  IconLock,
  IconMic,
  IconVolume2,
  IconUser,
} from "../lib/icons";
import { ENTERPRISE_ZONES } from "../lib/timezones";

// Enterprise-standard timezone picker. The zone CATALOGUE now lives in
// lib/timezones (shared with the meeting scheduler, so the two can never offer
// different zones); this just decorates it with the LIVE UTC offset (DST-aware
// via Intl) and sorts west→east. "auto" (default) follows the OS zone.
const TZ_OPTIONS: [string, string][] = (() => {
  const auto: [string, string][] = [["auto", "Use system timezone"]];
  const info = (tz: string): { off: number; label: string } => {
    const city = (tz.split("/").pop() || tz).replace(/_/g, " ");
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        timeZoneName: "longOffset",
      }).formatToParts(new Date());
      const name = (parts.find((p) => p.type === "timeZoneName") || ({} as any)).value || "GMT+00:00";
      const m = name.match(/([+-])(\d{1,2})(?::(\d{2}))?/);
      const off = m ? (m[1] === "-" ? -1 : 1) * (parseInt(m[2], 10) * 60 + (m[3] ? parseInt(m[3], 10) : 0)) : 0;
      const utc = name.replace(/^GMT/, "UTC").replace(/^UTC$/, "UTC+00:00");
      return { off, label: tz === "UTC" ? "(UTC+00:00) UTC" : `(${utc}) ${city}` };
    } catch {
      return { off: 9999, label: city };
    }
  };
  const rows = ENTERPRISE_ZONES.map((tz) => ({ tz, ...info(tz) })).sort((a, b) => a.off - b.off);
  return auto.concat(rows.map((r) => [r.tz, r.label] as [string, string]));
})();

// Downscale a chosen wallpaper image to a compact JPEG data URL so it can live
// in synced settings (no auth-gated URL, no expiry). Caps the longest edge.
function downscaleToDataURL(
  file: File,
  maxEdge = 1280,
  quality = 0.72,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("read failed"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("decode failed"));
      img.onload = () => {
        const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return reject(new Error("no canvas ctx"));
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

// Chat wallpaper was removed (#12) in favour of a messenger-style sent-bubble color
// (see lib/bubbleAccent.ts). Conversations now keep a clean, plain background.

const ACCENTS = [
  // Keep the VALUE "indigo" — it is the stored default for ~100 users and what
  // CoLabV1 compares against; changing it would need a settings migration. Only
  // the label + swatch move to the brand purple.
  ["indigo", "Collab Purple", "#8b29be"],
  ["cobalt", "Cobalt", "#2563EB"],
  ["emerald", "Emerald", "#10B981"],
  ["violet", "Violet", "#8B5CF6"],
  ["rose", "Rose", "#F43F5E"],
  ["amber", "Amber", "#F59E0B"],
  ["slate", "Slate", "#64748B"],
];
const ZOOMS = ["0.85", "0.9", "1", "1.1", "1.2"];
const FONTS = [
  ["12px", "Smaller"],
  ["13px", "Small"],
  ["14px", "Default"],
  ["15px", "Large"],
];
const FONT_CHOICES = [
  ["inter", "Inter", '"Inter", "Segoe UI", system-ui, sans-serif'],
  [
    "plus-jakarta",
    "Plus Jakarta Sans",
    '"Plus Jakarta Sans", "Segoe UI", system-ui, sans-serif',
  ],
  ["geist", "Geist", '"Geist", "Inter", "Segoe UI", system-ui, sans-serif'],
  [
    "ibm-plex",
    "IBM Plex Sans",
    '"IBM Plex Sans", "Inter", "Segoe UI", system-ui, sans-serif',
  ],
  [
    "poppins",
    "Poppins",
    '"Poppins", "Inter", "Segoe UI", system-ui, sans-serif',
  ],
  ["system", "System", 'system-ui, -apple-system, "Segoe UI", sans-serif'],
];

const ACTION_LABEL: Record<string, string> = {
  "auth.login": "Signed in",
  "auth.signup": "Account created",
  "conversation.create": "Created a conversation",
  "conversation.delete": "Deleted a conversation",
  "member.add": "Added members",
  "message.delete": "Deleted a message",
};
function fmtWhen(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const NAV: [string, string, React.ReactNode][] = [
  [
    "profile",
    "Profile",
    <IconUser key="p" size={16} />,
  ],
  [
    "appearance",
    "Appearance",
    <IconContrast key="a" size={16} />,
  ],
  [
    "av",
    "Audio & Video",
    <IconVideo key="v" size={16} />,
  ],
  [
    "chat",
    "Chat Display",
    <IconMessageSquare key="c" size={16} />,
  ],
  [
    "notif",
    "Notifications",
    <IconBell key="n" size={16} />,
  ],
  [
    "accessibility",
    "Accessibility",
    <IconPersonStanding key="ax" size={16} />,
  ],
  [
    "region",
    "Language & Region",
    <IconGlobe key="lr" size={16} />,
  ],
  [
    "security",
    "Security",
    <IconShield key="s" size={16} />,
  ],
  [
    "activity",
    "Activity log",
    <IconClock key="ac" size={16} />,
  ],
  [
    "devices",
    "Devices",
    <IconMonitor key="d" size={16} />,
  ],
  [
    "privacy",
    "Privacy",
    <IconLock key="pv" size={16} />,
  ],
  [
    "safety",
    "Safety",
    <IconShieldCheck key="sf" size={16} />,
  ],
  [
    "concern",
    "Report a concern",
    <IconAlertTriangle key="rc" size={16} />,
  ],
  [
    "desktop",
    "Desktop",
    <IconMonitor key="dt" size={16} />,
  ],
];

// Live preview of the current (possibly-unsaved) appearance + wallpaper. It
// reuses the REAL chat CSS classes (.msgs/.mw/.mb/.bub/.mm/.msnd) so it inherits
// theme/accent/density/font exactly as the chat does — those are applied live on
// <body> by applySettings — and applies the wallpaper inline so the preview
// reflects the choice immediately without leaving Settings.
function ChatPreview({ settings, meName }: { settings: any; meName?: string }) {
  // Reflect the (possibly-unsaved) sent-bubble color inline — applySettings only
  // sets the global --me-bub on save, so the preview applies it directly here.
  const bub = bubbleAccentColor(settings?.bubbleAccent || "accent");
  return (
    <div className="chat-preview" aria-hidden="true">
      <div className="chat-preview-lbl">Live preview</div>
      <div
        className="msgs"
        style={{
          flex: "none",
          minHeight: 120,
          borderRadius: 12,
          padding: 14,
          overflow: "hidden",
          background: "var(--main)",
        }}
      >
        <div className="mw gstart">
          <div className="mav">
            <span className="cp-av">A</span>
          </div>
          <div className="mb">
            <div className="mm">
              <span className="msnd">Alex Rivera</span>
              <span className="mtm">9:41</span>
            </div>
            <div className="bub">
              Pick a theme, accent or message color — it updates right here. ✨
            </div>
          </div>
        </div>
        <div className="mw gstart me">
          <div className="mb">
            <div className="mm">
              <span className="msnd">{meName || "You"}</span>
              <span className="mtm">9:42</span>
            </div>
            <div className="bub" style={bub ? { background: bub } : undefined}>
              Looks great — no need to leave Settings to check.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Toggle({ on, onClick }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      style={{
        width: 40,
        height: 22,
        borderRadius: 11,
        border: "none",
        cursor: "pointer",
        background: on ? "var(--ac)" : "var(--g300)",
        position: "relative",
        transition: ".15s",
        flexShrink: 0,
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 2,
          left: on ? 20 : 2,
          width: 18,
          height: 18,
          borderRadius: "50%",
          background: "#fff",
          transition: ".15s",
        }}
      />
    </button>
  );
}

function deviceLabel() {
  if (typeof navigator === "undefined") return "This device";
  const ua = navigator.userAgent || "";
  let os = "Unknown OS";
  if (/Windows/i.test(ua)) os = "Windows";
  else if (/Mac OS X|Macintosh/i.test(ua)) os = "macOS";
  else if (/Android/i.test(ua)) os = "Android";
  else if (/iPhone|iPad|iPod/i.test(ua)) os = "iOS";
  else if (/Linux/i.test(ua)) os = "Linux";
  let br = "Browser";
  if (/Edg\//i.test(ua)) br = "Edge";
  else if (/OPR\//i.test(ua)) br = "Opera";
  else if (/Chrome\//i.test(ua)) br = "Chrome";
  else if (/Firefox\//i.test(ua)) br = "Firefox";
  else if (/Safari\//i.test(ua)) br = "Safari";
  return br + " on " + os;
}

// Relative "last active" label from a raw ISO timestamp, formatted CLIENT-SIDE so
// it reflects the user's local time (never the backend server TZ). Falls back to the
// absolute local day/time for anything older than a day.
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

import ActiveSessionsPanel from "./settings/ActiveSessionsPanel";

export default function Settings({
  settings,
  onChange,
  onClose,
  token,
  saveStatus,
  me,
  onUploadAvatar,
  onUpdateProfile,
  onReopenOnboarding,
}) {
  const tr = useT(); // localized labels (Language & Region); English fallback per key
  const [aboutDraft, setAboutDraft] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  // Structured profile fields (title/pronouns/phone/timezone) — one draft map so
  // we don't add a useState per field.
  const [pdraft, setPdraft] = useState<Record<string, string | null>>({});
  const [section, setSection] = useState("profile");
  const wallpaperFileRef = useRef<HTMLInputElement>(null);
  const [wallpaperBusy, setWallpaperBusy] = useState(false);
  const [connCheckOpen, setConnCheckOpen] = useState(false);
  const [blockedUsers, setBlockedUsers] = useState<any[] | null>(null);
  const [reportedUsers, setReportedUsers] = useState<any[] | null>(null);
  const [blockedSearch, setBlockedSearch] = useState("");
  // Picked avatar file awaiting crop (null = cropper closed).
  const [avatarCropFile, setAvatarCropFile] = useState<File | null>(null);

  // Desktop-only prefs (background presence). Read from / written to the Electron
  // bridge — independent of synced `settings` (they're per-machine OS prefs). Null
  // until loaded; the section only renders inside the desktop app anyway.
  const [desktopPrefs, setDesktopPrefs] = useState<{
    closeToTray: boolean;
    openAtLogin: boolean;
    globalShortcuts: boolean;
    protectContent: boolean;
    autoUpdate: boolean;
  } | null>(null);
  useEffect(() => {
    if (!isDesktopApp) return;
    const cd = (window as any).collabDesktop;
    if (!cd || typeof cd.getDesktopPrefs !== "function") return;
    let alive = true;
    cd.getDesktopPrefs()
      .then((p: any) => {
        if (alive && p) {
          setDesktopPrefs({
            closeToTray: p.closeToTray !== false,
            openAtLogin: p.openAtLogin === true,
            globalShortcuts: p.globalShortcuts !== false,
            protectContent: p.protectContent === true,
            autoUpdate: p.autoUpdate !== false,
          });
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  const setDesktopPref = (
    key: "closeToTray" | "openAtLogin" | "globalShortcuts" | "protectContent" | "autoUpdate",
    value: boolean,
  ) => {
    setDesktopPrefs((prev) => (prev ? { ...prev, [key]: value } : prev));
    const cd = (window as any).collabDesktop;
    if (cd && typeof cd.setDesktopPref === "function") {
      try {
        cd.setDesktopPref(key, value);
      } catch {}
    }
  };

  const loadBlocked = React.useCallback(() => {
    api
      .getBlockedUsers(token)
      .then((r) => setBlockedUsers(r || []))
      .catch(() => setBlockedUsers([]));
  }, [token]);
  const loadReports = React.useCallback(() => {
    api
      .getReportedUsers(token)
      .then((r) => setReportedUsers(r || []))
      .catch(() => setReportedUsers([]));
  }, [token]);
  useEffect(() => {
    if (section === "privacy" && blockedUsers === null) loadBlocked();
  }, [section, blockedUsers, loadBlocked]);
  useEffect(() => {
    if (section === "safety" && reportedUsers === null) loadReports();
  }, [section, reportedUsers, loadReports]);
  // Report a concern (Skype/Teams-style): my filed reports + their status.
  const [myConcerns, setMyConcerns] = useState<any[] | null>(null);
  const [concernNote, setConcernNote] = useState<string | null>(null);
  useEffect(() => {
    if (section !== "concern" || !token) return;
    // Re-fetch EVERY time the section opens (not once per mount) and poll while
    // it stays open — the status chip and the handler's response must reflect
    // reality without the user having to reopen Settings.
    let cancelled = false;
    const load = () =>
      api
        .myConcerns(token)
        .then((rows) => {
          if (!cancelled) setMyConcerns(Array.isArray(rows) ? rows : []);
        })
        .catch(() => {
          if (!cancelled) setMyConcerns((prev) => prev || []);
        });
    load();
    const t = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [section, token]);

  const doUnblock = (userId: string) => {
    setBlockedUsers((prev) => (prev || []).filter((u) => u.id !== userId)); // optimistic
    api.unblockUser(token, userId).catch(() => loadBlocked());
  };
  const doRemoveReport = (reportId: string) => {
    setReportedUsers((prev) => (prev || []).filter((r) => r.id !== reportId)); // optimistic
    api.removeReport(token, reportId).catch(() => loadReports());
  };
  const [micOn, setMicOn] = useState(false);
  const [camTestOpen, setCamTestOpen] = useState(false);
  const [notifPerm, setNotifPerm] = useState(
    typeof Notification !== "undefined" ? Notification.permission : "default",
  );
  const [audit, setAudit] = useState<any>(null);
  const [auditLoading, setAuditLoading] = useState(false);
  useEffect(() => {
    if (section !== "activity" || !token) return;
    let alive = true;
    setAuditLoading(true);
    api
      .getAuditLog(token)
      .then((r: any) => {
        if (alive) {
          setAudit(Array.isArray(r) ? r : []);
          setAuditLoading(false);
        }
      })
      .catch(() => {
        if (alive) {
          setAudit([]);
          setAuditLoading(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [section, token]);
  const micStream = useRef<any>(null);
  const [avDevices, setAvDevices] = useState<any>({
    mics: [],
    speakers: [],
    cams: [],
  });
  const refreshDevices = async () => {
    try {
      const ds = await navigator.mediaDevices.enumerateDevices();
      setAvDevices({
        mics: ds.filter((d) => d.kind === "audioinput"),
        speakers: ds.filter((d) => d.kind === "audiooutput"),
        cams: ds.filter((d) => d.kind === "videoinput"),
      });
    } catch (_) {}
  };
  useEffect(() => {
    refreshDevices();
    const md: any = navigator.mediaDevices;
    if (md && md.addEventListener)
      md.addEventListener("devicechange", refreshDevices);
    return () => {
      if (md && md.removeEventListener)
        md.removeEventListener("devicechange", refreshDevices);
    };
  }, []);

  useEffect(
    () => () => {
      stopStream(micStream);
    },
    [],
  );
  const stopStream = (ref) => {
    try {
      if (ref.current) ref.current.getTracks().forEach((t) => t.stop());
    } catch (_) {}
    ref.current = null;
  };

  useEffect(() => {
    const escClose = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Claim Escape so the global window handler can't ALSO fire a Back
      // navigation on the same keypress. Deps array (previously missing) stops
      // this listener rebinding on every render.
      e.stopPropagation();
      onClose && onClose();
    };
    document.addEventListener("keydown", escClose);
    return () => document.removeEventListener("keydown", escClose);
  }, [onClose]);

  const testMic = async () => {
    if (micOn) {
      stopStream(micStream);
      setMicOn(false);
      return;
    }
    try {
      micStream.current = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      setMicOn(true);
      refreshDevices();
    } catch (_) {
      setMicOn(false);
    }
  };
  const testSpeaker = () => {
    try {
      const Ctx = window.AudioContext || (window as any).webkitAudioContext;
      const ac = new Ctx();
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.connect(g);
      g.connect(ac.destination);
      o.frequency.value = 440;
      g.gain.value = 0.06;
      o.start();
      setTimeout(() => {
        o.stop();
        ac.close();
      }, 500);
    } catch (_) {}
  };
  const enableNotifs = async () => {
    try {
      const p = await Notification.requestPermission();
      setNotifPerm(p);
      if (p === "granted") {
        new Notification("Collab", { body: "Desktop notifications are on." });
        import("../lib/pushRegistration").then((m) => m.registerPush(token)).catch(() => {});
      }
    } catch (_) {}
  };

  return (
    <div id="settings" className="screen">
      <div className="sp" role="region" aria-label="Settings">
        <div className="sp-nav">
          {/* Module title now lives in the shared top bar; the nav column no
              longer repeats it. */}
          {/* BA/CEO #17: the persistent "All changes saved" line was removed —
              saves now surface as a transient toast (fired from changeSetting). */}
          {NAV.filter(([id]) => id !== "desktop" || isDesktopApp).map(
            ([id, label, icon]) => (
              <button
                key={id}
                className={"spn" + (section === id ? " active" : "")}
                onClick={() => setSection(id)}
              >
                {icon}
                <span>{tr("settings." + id, label as string)}</span>
              </button>
            ),
          )}
          <div style={{ marginTop: "auto", padding: "12px 14px 0", display: "flex", flexDirection: "column", gap: 8 }}>
            {/* BA/CEO #23: "Run setup again" relocated here (was above the profile). */}
            {onReopenOnboarding ? (
              <button
                type="button"
                className="btn-c"
                style={{ width: "100%" }}
                onClick={onReopenOnboarding}
              >
                Run setup again
              </button>
            ) : null}
            <button
              className="btn-c"
              style={{ width: "100%" }}
              onClick={onClose}
            >
              {tr("common.close", "Close")}
            </button>
          </div>
        </div>
        <div className="sp-content">
          {section === "profile" && (
            <div className="sp-section active">
              <h3>Profile</h3>
              <div className="sp-row">
                <label>Profile Picture</label>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div
                    style={{
                      position: "relative",
                      width: 56,
                      height: 56,
                      borderRadius: "50%",
                      overflow: "hidden",
                      background: "var(--g200)",
                      flexShrink: 0,
                    }}
                  >
                    {me ? (
                      <div
                        style={{
                          width: "100%",
                          height: "100%",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontSize: 20,
                          fontWeight: 700,
                          color: "var(--g500)",
                          background: "var(--g200)",
                        }}
                      >
                        {(me.name || "").charAt(0).toUpperCase()}
                      </div>
                    ) : null}
                    {me && me.avatarUrl ? (
                      <img
                        src={resolveMediaUrl(me.avatarUrl)}
                        alt=""
                        onError={(e) => {
                          (e.currentTarget as HTMLImageElement).style.display =
                            "none";
                        }}
                        style={{
                          position: "absolute",
                          inset: 0,
                          width: "100%",
                          height: "100%",
                          objectFit: "cover",
                        }}
                      />
                    ) : null}
                  </div>
                  <div
                    style={{ display: "flex", flexDirection: "column", gap: 4 }}
                  >
                    <label
                      className="sp-btn"
                      style={{
                        fontSize: 12,
                        padding: "4px 12px",
                        borderRadius: 6,
                        background: "var(--brand-cta-gradient)",
                        color: "#fff",
                        cursor: "pointer",
                        display: "inline-block",
                        textAlign: "center",
                      }}
                    >
                      {me && me.avatarUrl ? "Change" : "Upload"}
                      <input
                        type="file"
                        accept="image/*"
                        style={{ display: "none" }}
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) setAvatarCropFile(f);
                          e.target.value = "";
                        }}
                      />
                    </label>
                    {me && me.avatarUrl ? (
                      <button
                        type="button"
                        style={{
                          fontSize: 11,
                          color: "var(--red)",
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                          padding: 0,
                        }}
                        onClick={() =>
                          onUpdateProfile && onUpdateProfile({ avatarUrl: "" })
                        }
                      >
                        Remove
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
              <div className="sp-row">
                <label>Display name</label>
                <input
                  className="su-search"
                  style={{ marginBottom: 0 }}
                  value={nameDraft !== null ? nameDraft : (me && me.name) || ""}
                  maxLength={60}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onBlur={() => {
                    if (
                      nameDraft !== null &&
                      nameDraft.trim() &&
                      nameDraft !== (me && me.name) &&
                      onUpdateProfile
                    )
                      onUpdateProfile({ name: nameDraft.trim() });
                    setNameDraft(null);
                  }}
                />
              </div>
              <div className="sp-row">
                <label>About</label>
                <input
                  className="su-search"
                  style={{ marginBottom: 0 }}
                  placeholder="Add a status, e.g. “Available” or “In a meeting”"
                  value={
                    aboutDraft !== null ? aboutDraft : (me && me.about) || ""
                  }
                  maxLength={140}
                  onChange={(e) => setAboutDraft(e.target.value)}
                  onBlur={() => {
                    if (
                      aboutDraft !== null &&
                      aboutDraft !== ((me && me.about) || "") &&
                      onUpdateProfile
                    )
                      onUpdateProfile({ about: aboutDraft });
                    setAboutDraft(null);
                  }}
                />
                <p>Shown on your profile in direct messages.</p>
              </div>
              {(
                [
                  ["title", "Job title", "e.g. Product Designer", 120],
                  [
                    "pronouns",
                    "Pronouns",
                    "e.g. he/him, she/her, they/them",
                    40,
                  ],
                  ["phone", "Phone", "e.g. +1 555 0100", 40],
                  ["timezone", "Time zone", "e.g. America/New York", 64],
                ] as [string, string, string, number][]
              ).map(([key, label, ph, max]) => {
                const current = (me && (me as any)[key]) || "";
                const val =
                  pdraft[key] !== undefined && pdraft[key] !== null
                    ? pdraft[key]
                    : current;
                return (
                  <div className="sp-row" key={key}>
                    <label>{label}</label>
                    <input
                      className="su-search"
                      style={{ marginBottom: 0 }}
                      placeholder={ph}
                      value={val as string}
                      maxLength={max}
                      onChange={(e) =>
                        setPdraft((p) => ({ ...p, [key]: e.target.value }))
                      }
                      onBlur={() => {
                        const d = pdraft[key];
                        if (
                          d !== undefined &&
                          d !== null &&
                          d !== current &&
                          onUpdateProfile
                        )
                          onUpdateProfile({ [key]: d.trim() });
                        setPdraft((p) => {
                          const n = { ...p };
                          delete n[key];
                          return n;
                        });
                      }}
                    />
                  </div>
                );
              })}
            </div>
          )}
          {section === "appearance" && (
            <div className="sp-section active">
              <h3>Appearance</h3>
              <div className="sp-row">
                <label>Theme</label>
                <PremiumSelect
                  ariaLabel="Theme"
                  value="light"
                  onChange={(v) => onChange("theme", v)}
                  // Collab is always light: applySettings forces it regardless
                  // of any saved value, so Light is the only choice offered.
                  options={[{ value: "light", label: "Light" }]}
                />
              </div>
              <div className="sp-row">
                <label>Accent Color</label>
                <PremiumSelect
                  ariaLabel="Accent colour"
                  value={settings.accent || "indigo"}
                  onChange={(v) => onChange("accent", v)}
                  options={ACCENTS.map(([v, label, c]) => ({
                    value: v,
                    label,
                    swatch: c,
                  }))}
                />
              </div>
              <div className="sp-row">
                <label>Ambiance</label>
                <PremiumSelect
                  ariaLabel="Ambiance"
                  value={settings.ambiance || "default"}
                  onChange={(v) => onChange("ambiance", v)}
                  options={[
                    { value: "default", label: "Accent Glow" },
                    { value: "borealis", label: "Aurora Borealis" },
                    { value: "none", label: "None" },
                  ]}
                />
                <p>Ambient background effect, shown on the dashboard.</p>
              </div>
              <div className="sp-row">
                <label>Typeface</label>
                <PremiumSelect
                  ariaLabel="Typeface"
                  value={settings.fontFamily || "poppins"}
                  onChange={(v) => onChange("fontFamily", v)}
                  options={FONT_CHOICES.map(([v, lb, stack]) => ({
                    value: v,
                    label: lb,
                    fontFamily: stack,
                  }))}
                />
                <p>The typeface used across the workspace.</p>
              </div>
              <div className="sp-row">
                <label>Application Zoom</label>
                <div className="zoom-opts">
                  {ZOOMS.map((z) => (
                    <button
                      key={z}
                      className={"zo" + (settings.zoom === z ? " active" : "")}
                      onClick={() => onChange("zoom", z)}
                    >
                      {Math.round(Number(z) * 100)}%
                    </button>
                  ))}
                </div>
                <p>Adjust the overall size of the application.</p>
              </div>
            </div>
          )}
          {section === "av" && (
            <div className="sp-section active">
              <h3>Audio &amp; Video</h3>
              <div className="av-test">
                <h4>Microphone</h4>
                <Select
                  className="av-select"
                  value={settings.micId || ""}
                  onChange={(e) => onChange("micId", e.target.value)}
                >
                  <option value="">System default</option>
                  {avDevices.mics.map((d, i) => (
                    <option key={d.deviceId || i} value={d.deviceId}>
                      {d.label || `Microphone ${i + 1}`}
                    </option>
                  ))}
                </Select>
                <label className="av-ns">
                  <span>Noise suppression</span>
                  <Toggle
                    on={settings.noiseSuppression !== false}
                    onClick={() =>
                      onChange(
                        "noiseSuppression",
                        !(settings.noiseSuppression !== false),
                      )
                    }
                  />
                </label>
                <label className="av-ns">
                  <span>Echo cancellation</span>
                  <Toggle
                    on={settings.echoCancellation !== false}
                    onClick={() =>
                      onChange(
                        "echoCancellation",
                        !(settings.echoCancellation !== false),
                      )
                    }
                  />
                </label>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <button className="av-test-btn" onClick={testMic}>
                    <IconMic size={14} />
                    {micOn ? "Stop" : "Test Microphone"}
                  </button>
                  {micOn && (
                    <div className="eq-bars">
                      <div className="eq-bar" />
                      <div className="eq-bar" />
                      <div className="eq-bar" />
                      <div className="eq-bar" />
                      <div className="eq-bar" />
                    </div>
                  )}
                </div>
              </div>
              <div className="av-test">
                <h4>Speaker</h4>
                <Select
                  className="av-select"
                  value={settings.speakerId || ""}
                  onChange={(e) => onChange("speakerId", e.target.value)}
                >
                  <option value="">System default</option>
                  {avDevices.speakers.map((d, i) => (
                    <option key={d.deviceId || i} value={d.deviceId}>
                      {d.label || `Speaker ${i + 1}`}
                    </option>
                  ))}
                </Select>
                <button className="av-test-btn" onClick={testSpeaker}>
                  <IconVolume2 size={14} />
                  Play Test Sound
                </button>
              </div>
              <div className="av-test">
                <h4>Camera</h4>
                <Select
                  className="av-select"
                  value={settings.cameraId || ""}
                  onChange={(e) => onChange("cameraId", e.target.value)}
                >
                  <option value="">System default</option>
                  {avDevices.cams.map((d, i) => (
                    <option key={d.deviceId || i} value={d.deviceId}>
                      {d.label || `Camera ${i + 1}`}
                    </option>
                  ))}
                </Select>
                <button className="av-test-btn" onClick={() => setCamTestOpen(true)}>
                  <IconVideo size={14} />
                  Test Camera
                </button>
              </div>
              <div className="av-test">
                <h4>Connection check</h4>
                <p
                  style={{
                    fontSize: 12.5,
                    color: "var(--g600)",
                    margin: "0 0 8px",
                  }}
                >
                  Verify calls &amp; meetings will work on this device and
                  network — run this before an important call.
                </p>
                <button
                  className="btn-p"
                  style={{ height: 34, padding: "0 16px", fontSize: 12.5 }}
                  onClick={() => setConnCheckOpen(true)}
                >
                  Run connection check
                </button>
              </div>
              {/* BA/CEO #27: opt-in — use the full Chat module (with the call
                  minimized to PiP) instead of the compact in-call side panel. */}
              <div className="av-test">
                <h4>Chat during calls &amp; meetings</h4>
                <p
                  style={{
                    fontSize: 12.5,
                    color: "var(--g600)",
                    margin: "0 0 8px",
                  }}
                >
                  When on, opening a chat during a call or meeting shows the full
                  Chat module and minimizes the call to a floating window
                  (Picture-in-Picture). When off, chats open in a compact side
                  panel inside the call.
                </p>
                <label className="av-ns">
                  <span>Open chats full-screen (call goes Picture-in-Picture)</span>
                  <Toggle
                    on={settings.inMeetingChatMode === true}
                    onClick={() =>
                      onChange(
                        "inMeetingChatMode",
                        !(settings.inMeetingChatMode === true),
                      )
                    }
                  />
                </label>
              </div>
            </div>
          )}
          {section === "chat" && (
            <div className="sp-section active">
              <h3>Chat Display</h3>
              <div className="sp-twocol">
                <div className="sp-twocol-main">
                  <div className="sp-row">
                    <label>Density</label>
                    <div className="density-opts">
                      {[
                        ["comfy", "Comfortable"],
                        ["compact", "Compact"],
                      ].map(([v, lb]) => (
                        <button
                          type="button"
                          key={v}
                          className={
                            "do" + (settings.density === v ? " active" : "")
                          }
                          onClick={() => onChange("density", v)}
                          aria-pressed={settings.density === v}
                        >
                          <div
                            className="do-line"
                            style={{
                              height: 3,
                              background: "var(--g300)",
                              borderRadius: 2,
                              margin: "3px 0",
                            }}
                          />
                          <div
                            className="do-line"
                            style={{
                              height: 3,
                              background: "var(--g300)",
                              borderRadius: 2,
                              margin: "3px 0",
                            }}
                          />
                          <span>{lb}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="sp-row">
                    <label>Message Color</label>
                    <p style={{ marginTop: -2 }}>
                      The color of the bubbles you send. Conversations keep a
                      clean, plain background.
                    </p>
                    <PremiumSelect
                      ariaLabel="Message color"
                      value={settings.bubbleAccent || "accent"}
                      onChange={(v) => onChange("bubbleAccent", v)}
                      options={BUBBLE_ACCENTS.map(({ key, label, color }) => ({
                        value: key,
                        label,
                        swatch: color || "var(--ac)",
                      }))}
                    />
                  </div>
                  <div className="sp-row">
                    <label>Message Font Size</label>
                    <div className="zoom-opts">
                      {FONTS.map(([v, lb]) => (
                        <button
                          key={v}
                          className={
                            "zo" + (settings.fontSize === v ? " active" : "")
                          }
                          onClick={() => onChange("fontSize", v)}
                        >
                          {lb}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="sp-row">
                    <label>Composer</label>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                      }}
                    >
                      <span style={{ fontSize: 13, color: "var(--g700)" }}>
                        Press Enter to send
                      </span>
                      <Toggle
                        on={settings.enterToSend !== false}
                        onClick={() =>
                          onChange(
                            "enterToSend",
                            !(settings.enterToSend !== false),
                          )
                        }
                      />
                    </div>
                  </div>
                  <div className="sp-row">
                    <label>Message Ordering</label>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                      }}
                    >
                      <span style={{ fontSize: 13, color: "var(--g700)" }}>
                        Newest messages at top (reverse chronological)
                      </span>
                      <Toggle
                        on={settings.newestAtTop === true}
                        onClick={() =>
                          onChange(
                            "newestAtTop",
                            !(settings.newestAtTop === true),
                          )
                        }
                      />
                    </div>
                  </div>
                  <div className="sp-row">
                    <label>Read Receipts</label>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                      }}
                    >
                      <span style={{ fontSize: 13, color: "var(--g700)" }}>
                        Send and see read receipts (✓✓). When off, you won’t
                        send them and won’t see others’.
                      </span>
                      <Toggle
                        on={settings.readReceipts !== false}
                        onClick={() =>
                          onChange(
                            "readReceipts",
                            !(settings.readReceipts !== false),
                          )
                        }
                      />
                    </div>
                  </div>
                  <div className="sp-row">
                    <label>Last Seen &amp; Online</label>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                      }}
                    >
                      <span style={{ fontSize: 13, color: "var(--g700)" }}>
                        Share your last-seen / online status. When off, you
                        can’t see anyone else’s either.
                      </span>
                      <Toggle
                        on={settings.lastSeen !== false}
                        onClick={() =>
                          onChange("lastSeen", !(settings.lastSeen !== false))
                        }
                      />
                    </div>
                  </div>
                  <div className="sp-row">
                    <label>Chat Backup</label>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                      }}
                    >
                      <span style={{ fontSize: 13, color: "var(--g700)" }}>
                        Automatically back up your encrypted chat history so it
                        restores when you sign in on a new device. When off, new
                        messages aren’t backed up.
                      </span>
                      <Toggle
                        on={settings.chatBackup !== false}
                        onClick={() =>
                          onChange("chatBackup", !(settings.chatBackup !== false))
                        }
                      />
                    </div>
                  </div>
                  <div className="sp-row">
                    <label>Conversation List</label>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                      }}
                    >
                      <span style={{ fontSize: 13, color: "var(--g700)" }}>
                        Compact list (hide message preview)
                      </span>
                      <Toggle
                        on={!!settings.compactList}
                        onClick={() =>
                          onChange("compactList", !settings.compactList)
                        }
                      />
                    </div>
                  </div>
                </div>
                <div className="sp-twocol-side">
                  <ChatPreview settings={settings} meName={me && me.name} />
                </div>
              </div>
            </div>
          )}
          {section === "notif" && (
            <div className="sp-section active">
              <h3>Notifications</h3>
              <div className="sp-row">
                <label>Desktop Notifications</label>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                >
                  <span style={{ fontSize: 13, color: "var(--g700)" }}>
                    {notifPerm === "granted"
                      ? "Enabled in this browser"
                      : notifPerm === "denied"
                        ? "Blocked in browser settings"
                        : "Not enabled"}
                  </span>
                  <button
                    className="btn-p"
                    style={{ height: 32, padding: "0 14px", fontSize: 12 }}
                    disabled={notifPerm !== "default"}
                    onClick={enableNotifs}
                  >
                    {notifPerm === "granted" ? "On" : "Enable"}
                  </button>
                </div>
                <p>Uses your browser&apos;s native notification permission.</p>
              </div>
              <div className="sp-row">
                <label>Notify me about</label>
                <div className="zoom-opts">
                  {[
                    ["all", "All messages"],
                    ["mentions", "Mentions only"],
                    ["none", "None"],
                  ].map(([v, lb]) => (
                    <button
                      key={v}
                      className={
                        "zo" +
                        ((settings.notifyLevel || "all") === v ? " active" : "")
                      }
                      onClick={() => onChange("notifyLevel", v)}
                    >
                      {lb}
                    </button>
                  ))}
                </div>
                <p>
                  Which messages trigger a desktop notification. Suppressed
                  only while you are viewing the same conversation.
                </p>
              </div>
              <div className="sp-row">
                <label>Notification sound</label>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                >
                  <span style={{ fontSize: 13, color: "var(--g700)" }}>
                    Play a sound for new notifications
                  </span>
                  <Toggle
                    on={settings.notifSound !== false}
                    onClick={() =>
                      onChange("notifSound", !(settings.notifSound !== false))
                    }
                  />
                </div>
                <p>A short chime plays when a desktop notification fires.</p>
              </div>
              <div className="sp-row">
                <label>Unread badge</label>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                >
                  <span style={{ fontSize: 13, color: "var(--g700)" }}>
                    Show unread count in the browser tab
                  </span>
                  <Toggle
                    on={settings.notifBadge !== false}
                    onClick={() =>
                      onChange("notifBadge", !(settings.notifBadge !== false))
                    }
                  />
                </div>
                <p>
                  The page title shows a (N) badge while you have unread
                  messages.
                </p>
              </div>
              <div className="sp-row">
                <label>Incoming calls</label>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                >
                  <span style={{ fontSize: 13, color: "var(--g700)" }}>
                    Desktop notification when someone calls you
                  </span>
                  <Toggle
                    on={settings.notifyCalls !== false}
                    onClick={() =>
                      onChange("notifyCalls", !(settings.notifyCalls !== false))
                    }
                  />
                </div>
              </div>
              <div className="sp-row">
                <label>New version alerts</label>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                >
                  <span style={{ fontSize: 13, color: "var(--g700)" }}>
                    Show a banner when a new version of Collab is available
                  </span>
                  <Toggle
                    on={settings.notifyUpdates !== false}
                    onClick={() =>
                      onChange(
                        "notifyUpdates",
                        !(settings.notifyUpdates !== false),
                      )
                    }
                  />
                </div>
                <p>
                  Collab updates seamlessly in the background. When on, a
                  dismissible banner lets you refresh right away to pick up the
                  latest version.
                </p>
              </div>
              <div className="sp-row">
                <label>Presentation Mode</label>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                >
                  <span style={{ fontSize: 13, color: "var(--g700)" }}>
                    Automatically enable Do Not Disturb while screen sharing
                  </span>
                  <Toggle
                    on={settings.presentationDnd !== false}
                    onClick={() =>
                      onChange(
                        "presentationDnd",
                        !(settings.presentationDnd !== false),
                      )
                    }
                  />
                </div>
                <p>
                  While you present (screen share or presenter mode, in calls
                  and meetings) every Collab notification — banners, toasts,
                  sounds, incoming-call pop-ups — is paused, then restored
                  exactly as before when you stop. Your own Do Not Disturb /
                  quiet-hours settings are never changed.
                </p>
                {settings.presentationDnd !== false ? (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      marginTop: 8,
                    }}
                  >
                    <span style={{ fontSize: 13, color: "var(--g700)" }}>
                      Show “Presentation Mode enabled/disabled” messages
                    </span>
                    <Toggle
                      on={settings.presentationDndToasts !== false}
                      onClick={() =>
                        onChange(
                          "presentationDndToasts",
                          !(settings.presentationDndToasts !== false),
                        )
                      }
                    />
                  </div>
                ) : null}
              </div>
              <div className="sp-row">
                <label>Ringtone</label>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Select
                    className="av-select"
                    value={settings.ringtone || "default"}
                    onChange={(e) => {
                      onChange("ringtone", e.target.value);
                      // Play the chosen melody so the picker is audible, not blind.
                      previewRingtone(e.target.value);
                    }}
                  >
                    <option value="default">Aurora (default)</option>
                    <option value="classic">Chime</option>
                    <option value="modern">Pulse</option>
                    <option value="minimal">Tap</option>
                  </Select>
                  <button
                    type="button"
                    className="av-btn"
                    title="Preview ringtone"
                    aria-label="Preview ringtone"
                    onClick={() =>
                      previewRingtone(settings.ringtone || "default")
                    }
                  >
                    <IconPlay size={15} />
                  </button>
                </div>
              </div>
              <div className="sp-row">
                <label>Quiet hours</label>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                >
                  <span style={{ fontSize: 13, color: "var(--g700)" }}>
                    Silence all desktop notifications during a time window
                  </span>
                  <Toggle
                    on={!!settings.quietHours}
                    onClick={() => onChange("quietHours", !settings.quietHours)}
                  />
                </div>
                {settings.quietHours ? (
                  <div className="qh-times">
                    <label className="qh-lab">
                      From
                      <input
                        type="time"
                        value={settings.quietStart || "22:00"}
                        onChange={(e) => onChange("quietStart", e.target.value)}
                      />
                    </label>
                    <label className="qh-lab">
                      To
                      <input
                        type="time"
                        value={settings.quietEnd || "07:00"}
                        onChange={(e) => onChange("quietEnd", e.target.value)}
                      />
                    </label>
                  </div>
                ) : null}
                <p>
                  Notifications are paused during this window. Overnight ranges
                  (e.g. 22:00–07:00) are supported.
                </p>
              </div>
            </div>
          )}
          {section === "accessibility" && (
            <div className="sp-section active">
              <h3>Accessibility</h3>
              {[
                ["highContrast", "High Contrast Mode"],
                ["reduceMotion", "Reduce Motion"],
                ["largerText", "Larger Text"],
                ["keyboardNavigation", "Keyboard Navigation Support"],
                ["dyslexiaFont", "Dyslexia-friendly text"],
                ["blurMedia", "Blur media until hovered (privacy)"],
                [
                  "autoCollapseSidebar",
                  "Collapse navigation when viewing a chat",
                ],
              ].map(([key, label]) => (
                <div className="sp-row" key={key}>
                  <div className="setting-line">
                    <span>{label}</span>
                    <Toggle
                      on={settings[key] !== false && !!settings[key]}
                      onClick={() => onChange(key, !settings[key])}
                    />
                  </div>
                </div>
              ))}
              {/* Post-call/meeting feedback (#67). THE source of truth for the
                  feedback dialog's visibility — the dialog's "Don't show this
                  again" checkbox writes this exact same setting. Default ON. */}
              <div className="sp-row">
                <div className="setting-line">
                  <span>Enable Post-Call Feedback</span>
                  <Toggle
                    on={settings.callFeedback !== false}
                    onClick={() =>
                      onChange("callFeedback", settings.callFeedback === false)
                    }
                  />
                </div>
                <p>
                  Show a feedback dialog after completed calls and meetings to
                  help improve call quality.
                </p>
              </div>
            </div>
          )}
          {section === "region" && (
            <div className="sp-section active">
              <h3>{tr("region.title", "Language & Region")}</h3>
              {[
                // Language picker intentionally hidden: the product ships
                // English-only for now (full localization is a large, separate
                // effort). The i18n engine stays wired + dormant — re-add this
                // ["language", "Language", LANGUAGES] row to turn it back on.
                ["timezone", "Timezone", TZ_OPTIONS],
                [
                  "dateFormat",
                  "Date Format",
                  [
                    ["MMM D, YYYY", "Jun 9, 2026"],
                    ["D MMM YYYY", "9 Jun 2026"],
                    ["MM/DD/YYYY", "06/09/2026"],
                    ["DD/MM/YYYY", "09/06/2026"],
                    ["YYYY-MM-DD", "2026-06-09"],
                  ],
                ],
                [
                  "timeFormat",
                  "Time Format",
                  [
                    ["12h", "12-hour"],
                    ["24h", "24-hour"],
                  ],
                ],
              ].map(([key, label, opts]: any) => (
                <div className="sp-row" key={key}>
                  <label>{tr("region." + key, label)}</label>
                  {key === "timezone" ? (
                    // Long list (~400 zones) → a type-to-search combobox.
                    <SearchableSelect
                      value={settings[key] || opts[0][0]}
                      options={opts}
                      onChange={(v) => onChange(key, v)}
                      placeholder="Type to search timezones…"
                    />
                  ) : (
                    <Select
                      className="av-select"
                      value={settings[key] || opts[0][0]}
                      onChange={(e) => onChange(key, e.target.value)}
                    >
                      {opts.map(([value, text]) => (
                        <option key={value} value={value}>
                          {text}
                        </option>
                      ))}
                    </Select>
                  )}
                </div>
              ))}
            </div>
          )}
          {section === "security" && (
            <div className="sp-section active">
              <h3>Security</h3>
              {/* Active sessions (#66): real, server-backed list across web + every
                  OS app, with per-device + bulk sign-out. */}
              {section === "security" && <ActiveSessionsPanel token={token} />}
              {/* E2EE panel (End-to-end encryption, Message backup, Recovery
                  passphrase, Reset encryption on this device) — hidden for now.
                  Re-enable by restoring the import above and this line:
              <E2EESecurityPanel token={token} />
              */}
            </div>
          )}
          {section === "activity" && (
            <div className="sp-section active">
              <h3>Activity log</h3>
              <p
                className="agt-note"
                style={{ padding: 0, margin: "0 0 12px" }}
              >
                Recent security-relevant actions on your account.
              </p>
              {auditLoading ? (
                <div className="ev-empty">Loading…</div>
              ) : !audit || audit.length === 0 ? (
                <div className="ev-empty">No recorded activity yet.</div>
              ) : (
                <div className="ev-list">
                  {audit.map((a: any) => (
                    <div className="ev-row" key={a.id}>
                      <span className="ev-dot" />
                      <div className="ev-body">
                        <div className="ev-act">
                          {ACTION_LABEL[a.action] || a.action}
                        </div>
                        {a.detail && a.detail.userIds ? (
                          <div className="ev-meta">
                            {a.detail.userIds.length} member
                            {a.detail.userIds.length === 1 ? "" : "s"}
                          </div>
                        ) : a.targetType ? (
                          <div className="ev-meta">{a.targetType}</div>
                        ) : null}
                      </div>
                      <span className="ev-when">{fmtWhen(a.createdAt)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {section === "devices" && (
            <div className="sp-section active">
              <h3>Devices</h3>
              <div className="dev-row">
                <div className="dev-ic">
                  <IconMonitor size={20} />
                </div>
                <div className="dev-body">
                  <div className="dev-name">{deviceLabel()}</div>
                  <div className="dev-meta">This device · Active now</div>
                </div>
                <span className="dev-badge">Current</span>
              </div>
              {/* AUDIT P2 (#39): the old copy said remote sign-out wasn't available,
                  contradicting the working Active Sessions control. Point users to it. */}
              <p
                style={{
                  fontSize: 12,
                  color: "var(--g500)",
                  marginTop: 14,
                  lineHeight: 1.6,
                }}
              >
                To see every device signed in to your account &mdash; and sign
                any of them out remotely &mdash; open{" "}
                <button
                  type="button"
                  onClick={() => setSection("security")}
                  style={{ background: "none", border: 0, padding: 0, color: "var(--ac)", cursor: "pointer", font: "inherit", textDecoration: "underline" }}
                >
                  Security &rarr; Active sessions
                </button>
                .
              </p>
            </div>
          )}
          {section === "privacy" && (
            <div className="sp-section active">
              <h3>Privacy</h3>
              <div className="sp-row">
                <label>Typing indicators</label>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                >
                  <span style={{ fontSize: 13, color: "var(--g700)" }}>
                    Let others see when you’re typing
                  </span>
                  <Toggle
                    on={settings.sendTyping !== false}
                    onClick={() =>
                      onChange("sendTyping", !(settings.sendTyping !== false))
                    }
                  />
                </div>
              </div>
              <div className="sp-row">
                <label>Blocked users</label>
                <p
                  style={{
                    fontSize: 12.5,
                    color: "var(--g600)",
                    margin: "0 0 10px",
                  }}
                >
                  Blocked people can&apos;t message or call you, and you
                  can&apos;t message or call them. Unblock to restore
                  communication.
                </p>
                {blockedUsers === null ? (
                  <div className="su-empty">Loading…</div>
                ) : blockedUsers.length === 0 ? (
                  <div className="su-empty">
                    You haven&apos;t blocked anyone.
                  </div>
                ) : (
                  <>
                    <input
                      className="su-search"
                      placeholder="Search blocked users…"
                      value={blockedSearch}
                      onChange={(e) => setBlockedSearch(e.target.value)}
                    />
                    <div className="su-list">
                      {blockedUsers
                        .filter((u) =>
                          (u.name || "")
                            .toLowerCase()
                            .includes(blockedSearch.toLowerCase()),
                        )
                        .map((u) => (
                          <div className="su-row" key={u.id}>
                            <span
                              className="su-av"
                              style={{ background: u.color || "#64748b" }}
                            >
                              {u.initials || "?"}
                            </span>
                            <span className="su-name">{u.name}</span>
                            <button
                              className="su-action"
                              onClick={() => doUnblock(u.id)}
                            >
                              Unblock
                            </button>
                          </div>
                        ))}
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
          {section === "concern" && (
            <div className="sp-section active">
              <h3>Report a concern</h3>
              <p style={{ fontSize: 12.5, color: "var(--g600)", margin: "0 0 12px", lineHeight: 1.5 }}>
                Raise anything that worries you — harassment, a safety or privacy
                issue, inappropriate content, or a technical problem. Reports go
                to your organization's administrators, and you'll be notified as
                yours is reviewed and resolved.
              </p>
              <ConcernComposer
                token={token}
                onSent={() => {
                  setConcernNote("Thank you — your report has been submitted for review.");
                  setMyConcerns(null); // refetch the list with the new report
                }}
                onError={(m) => setConcernNote(m)}
              />
              {concernNote ? (
                <div style={{ fontSize: 12.5, color: "var(--g700)", margin: "10px 0" }}>{concernNote}</div>
              ) : null}
              <div className="sp-row" style={{ marginTop: 14 }}>
                <label>Your reports</label>
                {myConcerns === null ? (
                  <div className="su-empty">Loading…</div>
                ) : myConcerns.length === 0 ? (
                  <div className="su-empty">You haven't reported anything.</div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {myConcerns.map((c: any) => (
                      <div key={c.id} style={{ border: "1px solid var(--g150, var(--g200))", borderRadius: 10, padding: "8px 10px", fontSize: 12.5 }}>
                        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                          <span style={{ flex: "0 0 auto", fontSize: 10.5, fontWeight: 700, borderRadius: 6, padding: "1px 6px", color: "#fff", background: c.status === "closed" ? "#16a34a" : c.status === "in_review" ? "#d97706" : "var(--ac, #6366f1)" }}>
                            {c.status === "in_review" ? "IN REVIEW" : c.status.toUpperCase()}
                          </span>
                          <span style={{ flex: "0 0 auto", fontSize: 10.5, fontWeight: 600, color: "var(--g600)", background: "var(--g100, #f3f4f6)", borderRadius: 6, padding: "1px 6px" }}>
                            {c.module || "other"}
                          </span>
                          <span style={{ flex: 1, minWidth: 0, fontWeight: 600, color: "var(--g900)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                            {c.subject || c.category}
                          </span>
                          <span style={{ flex: "0 0 auto", fontSize: 11, color: "var(--g500)" }}>
                            {c.createdAt ? new Date(c.createdAt).toLocaleString() : ""}
                          </span>
                        </div>
                        <div
                          style={{ marginTop: 4, color: "var(--g700)", maxHeight: 72, overflow: "hidden" }}
                          dangerouslySetInnerHTML={{ __html: sanitizeMessageHtml(c.body || "") }}
                        />
                        {c.response ? (
                          <div style={{ marginTop: 6, fontSize: 12, color: "var(--g700)", borderLeft: "3px solid var(--ac)", paddingLeft: 8 }}>
                            <strong style={{ color: "var(--g900)" }}>Response:</strong> {c.response}
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
          {section === "safety" && (
            <div className="sp-section active">
              <h3>Safety</h3>
              <div className="sp-row">
                <label>Links</label>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                >
                  <span style={{ fontSize: 13, color: "var(--g700)" }}>
                    Confirm before opening external links
                  </span>
                  <Toggle
                    on={settings.linkConfirm === true}
                    onClick={() =>
                      onChange("linkConfirm", !(settings.linkConfirm === true))
                    }
                  />
                </div>
              </div>
              <div className="sp-row">
                <label>Reported users</label>
                <p
                  style={{
                    fontSize: 12.5,
                    color: "var(--g600)",
                    margin: "0 0 10px",
                  }}
                >
                  People you&apos;ve reported. Removing a report withdraws it
                  from review.
                </p>
                {reportedUsers === null ? (
                  <div className="su-empty">Loading…</div>
                ) : reportedUsers.length === 0 ? (
                  <div className="su-empty">
                    You haven&apos;t reported anyone.
                  </div>
                ) : (
                  <div className="su-list">
                    {reportedUsers.map((r) => (
                      <div className="su-row" key={r.id}>
                        <span
                          className="su-av"
                          style={{ background: r.color || "#64748b" }}
                        >
                          {r.initials || "?"}
                        </span>
                        <span className="su-body">
                          <span className="su-name">{r.name}</span>
                          {r.reason ? (
                            <span className="su-reason">{r.reason}</span>
                          ) : null}
                          {r.createdAt ? (
                            <span className="su-date">
                              {new Date(r.createdAt).toLocaleDateString()}
                            </span>
                          ) : null}
                        </span>
                        <button
                          className="su-action"
                          onClick={() => doRemoveReport(r.id)}
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
          {section === "desktop" && isDesktopApp && (
            <div className="sp-section active">
              <h3>Desktop</h3>
              <div className="sp-row">
                <label>Background &amp; startup</label>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                >
                  <span style={{ fontSize: 13, color: "var(--g700)" }}>
                    Keep Collab running in the background
                  </span>
                  <Toggle
                    on={desktopPrefs ? desktopPrefs.closeToTray : true}
                    onClick={() =>
                      setDesktopPref(
                        "closeToTray",
                        !(desktopPrefs ? desktopPrefs.closeToTray : true),
                      )
                    }
                  />
                </div>
                <p>
                  Closing the window keeps Collab running in the system tray so
                  you still receive messages and calls. Quit from the tray icon to
                  exit fully. When off, closing the window quits the app.
                </p>
              </div>
              <div className="sp-row">
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                >
                  <span style={{ fontSize: 13, color: "var(--g700)" }}>
                    Open Collab at login
                  </span>
                  <Toggle
                    on={desktopPrefs ? desktopPrefs.openAtLogin : false}
                    onClick={() =>
                      setDesktopPref(
                        "openAtLogin",
                        !(desktopPrefs ? desktopPrefs.openAtLogin : false),
                      )
                    }
                  />
                </div>
                <p>
                  Start Collab automatically when you sign in to this computer.
                </p>
              </div>
              <div className="sp-row">
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                >
                  <span style={{ fontSize: 13, color: "var(--g700)" }}>
                    Global keyboard shortcuts
                  </span>
                  <Toggle
                    on={desktopPrefs ? desktopPrefs.globalShortcuts : true}
                    onClick={() =>
                      setDesktopPref(
                        "globalShortcuts",
                        !(desktopPrefs ? desktopPrefs.globalShortcuts : true),
                      )
                    }
                  />
                </div>
                <p>
                  System-wide hotkeys that work even when Collab isn&apos;t
                  focused: Ctrl/Cmd+Shift+C show or hide Collab,
                  Ctrl/Cmd+Shift+M toggle your microphone in a call,
                  Ctrl/Cmd+Shift+D toggle the floating call window, and
                  Ctrl/Cmd+Shift+A / Ctrl/Cmd+Shift+J answer or decline an
                  incoming call.
                </p>
              </div>
              <div className="sp-row">
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                >
                  <span style={{ fontSize: 13, color: "var(--g700)" }}>
                    Hide app from screen capture &amp; screenshots
                  </span>
                  <Toggle
                    on={desktopPrefs ? desktopPrefs.protectContent : false}
                    onClick={() =>
                      setDesktopPref(
                        "protectContent",
                        !(desktopPrefs ? desktopPrefs.protectContent : false),
                      )
                    }
                  />
                </div>
                <p>
                  Blanks the Collab window in screenshots, screen recordings and
                  screen sharing (including OBS and Teams) so confidential
                  conversations can&apos;t be captured. Off by default.
                </p>
              </div>
              <div className="sp-row">
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                >
                  <span style={{ fontSize: 13, color: "var(--g700)" }}>
                    Automatic updates
                  </span>
                  <Toggle
                    on={desktopPrefs ? desktopPrefs.autoUpdate : true}
                    onClick={() =>
                      setDesktopPref(
                        "autoUpdate",
                        !(desktopPrefs ? desktopPrefs.autoUpdate : true),
                      )
                    }
                  />
                </div>
                <p>
                  Download and install new versions automatically in the
                  background — you&apos;ll get a &ldquo;Restart to update&rdquo;
                  prompt when it&apos;s ready, and your data and sign-in are kept.
                  When off, check for updates manually below.
                </p>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    marginTop: 10,
                    gap: 12,
                  }}
                >
                  <span style={{ fontSize: 12, color: "var(--g500)" }}>
                    {(() => {
                      const v = (window as any).collabDesktop?.appInfo?.version;
                      return v ? `Current version ${v}` : "Desktop app";
                    })()}
                  </span>
                  <button
                    type="button"
                    className="btn-c"
                    onClick={() => {
                      const cd = (window as any).collabDesktop;
                      if (cd && typeof cd.checkForUpdates === "function") {
                        try {
                          cd.checkForUpdates();
                        } catch {}
                      }
                    }}
                    style={{ whiteSpace: "nowrap" }}
                  >
                    Check for updates
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
      {camTestOpen ? (
        <CameraTestModal
          deviceId={settings.cameraId || undefined}
          onClose={() => setCamTestOpen(false)}
          onReady={refreshDevices}
        />
      ) : null}
      {connCheckOpen ? (
        <ConnectionCheck
          token={token}
          onClose={() => setConnCheckOpen(false)}
        />
      ) : null}
      {avatarCropFile ? (
        <AvatarCropModal
          file={avatarCropFile}
          onCancel={() => setAvatarCropFile(null)}
          onConfirm={(cropped) => {
            setAvatarCropFile(null);
            if (onUploadAvatar) onUploadAvatar(cropped);
          }}
        />
      ) : null}
    </div>
  );
}
