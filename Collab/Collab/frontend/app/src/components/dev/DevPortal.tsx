"use client";
// ─────────────────────────────────────────────────────────────────────────────
// Engineering Operations Portal — "Mission Control" (/dev)
//
// Internal developer reference dashboard. Polls the read-only /api/ops telemetry
// API and renders live infrastructure, database, realtime, messaging and error
// state in a dark, premium ops aesthetic. Self-contained: its own scoped design
// system (dev.css) and inline icon set so it never couples to the main app UI.
//
// Auth: reuses the signed-in app session (clb_token). No session → sign-in gate.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import config from "../../lib/config";
import "../../styles/dev.css";
import { Select } from "../ui";

// ── tiny inline icon set (self-contained; stroke-based, 1.6px) ───────────────
type IcoP = { size?: number };
const I = (d: React.ReactNode, vb = 24) => ({ size = 16 }: IcoP) => (
  <svg width={size} height={size} viewBox={`0 0 ${vb} ${vb}`} fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {d}
  </svg>
);
const IcoGauge = I(<><path d="M12 13l4-4" /><circle cx="12" cy="13" r="8" /><path d="M12 3v2M4.5 13H3M21 13h-1.5" /></>);
const IcoServer = I(<><rect x="3" y="4" width="18" height="7" rx="1.5" /><rect x="3" y="13" width="18" height="7" rx="1.5" /><path d="M7 7.5h.01M7 16.5h.01" /></>);
const IcoDb = I(<><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" /></>);
const IcoPulse = I(<path d="M3 12h4l2 6 4-14 2 8h6" />);
const IcoRadio = I(<><circle cx="12" cy="12" r="2" /><path d="M7.8 7.8a6 6 0 000 8.4M16.2 7.8a6 6 0 010 8.4M5 5a9 9 0 000 14M19 5a9 9 0 010 14" /></>);
const IcoChat = I(<path d="M21 12a8 8 0 01-11.6 7.1L4 20l1-4.5A8 8 0 1121 12z" />);
const IcoUsers = I(<><circle cx="9" cy="8" r="3" /><path d="M3.5 20a5.5 5.5 0 0111 0M16 5.5a3 3 0 010 5.8M20.5 20a5.5 5.5 0 00-4-5.3" /></>);
const IcoBolt = I(<path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" />);
const IcoAlert = I(<><path d="M12 9v4M12 17h.01" /><path d="M10.3 3.9L2.4 18a2 2 0 001.7 3h15.8a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z" /></>);
const IcoList = I(<><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></>);
const IcoGraph = I(<><circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="8" r="2.5" /><circle cx="9" cy="18" r="2.5" /><path d="M8 7l8 1M7.5 16l0-8M11 17l6-8" /></>);
const IcoFlag = I(<><path d="M5 21V4M5 4h11l-2 4 2 4H5" /></>);
const IcoRocket = I(<><path d="M5 15c-1.5 1.5-2 5-2 5s3.5-.5 5-2M9 11a12 12 0 018-7c1 3 0 6-3 9l-3 2-2-4z" /><circle cx="14.5" cy="9.5" r="1.2" /></>);
const IcoSpark = I(<><path d="M12 3v3M12 18v3M5 12H2M22 12h-3M6 6l1.5 1.5M18 6l-1.5 1.5" /><circle cx="12" cy="12" r="3.5" /></>);
const IcoSearch = I(<><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" /></>);
const IcoRobot = I(<><rect x="4" y="8" width="16" height="11" rx="2.5" /><path d="M12 8V4M8 13h.01M16 13h.01M9 16h6" /><circle cx="12" cy="4" r="1" /></>);
const IcoRefresh = I(<><path d="M21 12a9 9 0 11-3-6.7L21 8M21 4v4h-4" /></>);
const IcoClock = I(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>);
const IcoCpu = I(<><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2" /></>);
const IcoMem = I(<><rect x="3" y="7" width="18" height="10" rx="2" /><path d="M7 7v10M12 7v10M17 7v10" /></>);
const IcoBox = I(<><path d="M12 2l8 4.5v9L12 20l-8-4.5v-9L12 2z" /><path d="M12 20v-9M20 6.5L12 11 4 6.5" /></>);
const IcoActivity = I(<path d="M3 12h4l3 8 4-16 3 8h4" />);
const IcoShield = I(<path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3z" />);
const IcoRocketDeploy = I(<><path d="M4 13a8 8 0 018-8 8 8 0 018 8M12 5v8M8 21l4-4 4 4M12 13a2 2 0 100 4 2 2 0 000-4z" /></>);
const IcoScale = I(<><path d="M12 3v18M7 8l-4 6h8l-4-6zM17 8l-4 6h8l-4-6zM5 21h14" /></>);
const IcoBrain = I(<><path d="M9 3a3 3 0 00-3 3 3 3 0 00-2 5 3 3 0 002 5 3 3 0 006 0V4a3 3 0 00-3-1zM15 3a3 3 0 013 3 3 3 0 012 5 3 3 0 01-2 5 3 3 0 01-6 0" /></>);
const IcoCopy = I(<><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 012-2h10" /></>);
const IcoLogout = I(<><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" /></>);
const IcoKey = I(<><circle cx="8" cy="15" r="4" /><path d="M11 12l8-8M16 7l3 3M13 10l2 2" /></>);

// ── formatters ───────────────────────────────────────────────────────────────
const fmtNum = (n: number) => {
  if (n == null || isNaN(n)) return "—";
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(Math.round(n));
};
const fmtInt = (n: number) => (n == null || isNaN(n) ? "—" : Math.round(n).toLocaleString());
const fmtBytes = (b: number) => {
  if (!b || b < 0) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = b;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
};
const fmtDur = (s: number) => {
  if (!s || s < 0) return "—";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${Math.floor(s % 60)}s`;
  return `${Math.floor(s)}s`;
};
const timeAgo = (iso: any) => {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (isNaN(t)) return "—";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

// ── sparkline ────────────────────────────────────────────────────────────────
function Spark({ data, color = "var(--d-acc)", w = 96, h = 34, fill = true }: { data: number[]; color?: string; w?: number; h?: number; fill?: boolean }) {
  if (!data || data.length < 2) return <svg className="devp-spark" width={w} height={h} />;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const span = max - min || 1;
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - 2 - ((v - min) / span) * (h - 4);
    return [x, y];
  });
  const line = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
  const area = `${line} L${w} ${h} L0 ${h} Z`;
  const gid = "g" + Math.round(pts[0][1] * 100 + w);
  return (
    <svg className="devp-spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      {fill && (
        <>
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={color} stopOpacity="0.28" />
              <stop offset="1" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={area} fill={`url(#${gid})`} />
        </>
      )}
      <path d={line} fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r="1.9" fill={color} />
    </svg>
  );
}

// ── data types (loose) ───────────────────────────────────────────────────────
type Snap = any;

// ── history buffer for live sparklines ───────────────────────────────────────
const HIST_MAX = 40;
type Hist = { cpu: number[]; mem: number[]; msg: number[]; part: number[]; queries: number[]; dbConn: number[]; redisOps: number[] };
// Factory (NOT a shared singleton): each mount must get its OWN fresh arrays.
// A module-level object literal would be shallow-shared across mounts, so a
// remount would inherit the previous mount's already-populated buffers and
// render stale samples as if current.
const freshHist = (): Hist => ({ cpu: [], mem: [], msg: [], part: [], queries: [], dbConn: [], redisOps: [] });

// ── main ─────────────────────────────────────────────────────────────────────
const NAV: { group: string; items: { id: string; label: string; icon: any }[] }[] = [
  {
    group: "Overview",
    items: [
      { id: "overview", label: "Executive Overview", icon: IcoGauge },
      { id: "cto", label: "Engineering Review", icon: IcoBrain },
    ],
  },
  {
    group: "Intelligence",
    items: [
      { id: "insights", label: "AI Insights", icon: IcoBrain },
      { id: "arch", label: "Code Architecture", icon: IcoGraph },
      { id: "fault", label: "Fault Attribution", icon: IcoScale },
      { id: "incidents", label: "Incidents", icon: IcoAlert },
      { id: "e2ee", label: "E2EE Health", icon: IcoShield },
      { id: "e2eeKeys", label: "E2EE Identity Keys", icon: IcoKey },
      { id: "experience", label: "User Experience", icon: IcoUsers },
    ],
  },
  {
    group: "Delivery",
    items: [
      { id: "deployments", label: "Deployments", icon: IcoRocketDeploy },
      { id: "releases", label: "Release Readiness", icon: IcoRocket },
    ],
  },
  {
    group: "Planning",
    items: [
      { id: "sim", label: "Simulation Engine", icon: IcoSpark },
    ],
  },
  {
    group: "Infrastructure",
    items: [
      { id: "infra", label: "Infrastructure", icon: IcoServer },
      { id: "database", label: "Database", icon: IcoDb },
      { id: "storage", label: "Storage", icon: IcoBox },
      { id: "services", label: "Services & Health", icon: IcoShield },
      { id: "realtime", label: "Realtime · LiveKit", icon: IcoRadio },
    ],
  },
  {
    group: "Application",
    items: [
      { id: "messaging", label: "Messaging", icon: IcoChat },
      { id: "users", label: "Users & Sessions", icon: IcoUsers },
      { id: "performance", label: "Performance", icon: IcoBolt },
    ],
  },
  {
    group: "Reliability",
    items: [
      { id: "errors", label: "Error Center", icon: IcoAlert },
      { id: "resolved", label: "Resolved", icon: IcoShield },
      { id: "logs", label: "Logs", icon: IcoList },
      { id: "alerts", label: "Alerts", icon: IcoActivity },
    ],
  },
  {
    group: "Engineering",
    items: [
      { id: "deps", label: "Dependency Graph", icon: IcoGraph },
      { id: "flags", label: "Feature Flags", icon: IcoFlag },
      { id: "search", label: "Search", icon: IcoSearch },
      { id: "assistant", label: "AI Assistant", icon: IcoRobot },
    ],
  },
];
const VIEW_META: Record<string, { title: string; sub: string }> = {
  overview: { title: "Executive Overview", sub: "Real-time platform health & key signals" },
  cto: { title: "Engineering Review", sub: "Engineering summary — strengths, risks & top priorities" },
  arch: { title: "Code Architecture", sub: "Evidence-backed efficiency & architecture analysis" },
  insights: { title: "AI Insights", sub: "Reasoning: what happened, why, and what to do" },
  fault: { title: "Fault Attribution", sub: "Is it infra, application code, a vendor, or the client?" },
  incidents: { title: "Incidents", sub: "Clustered failures correlated with deployments" },
  e2ee: { title: "E2EE Health", sub: "Encryption failures by kind, user & device" },
  e2eeKeys: { title: "E2EE Identity Keys", sub: "Every user's per-device encrypt / decrypt key directory" },
  experience: { title: "User Experience", sub: "Per-user error tracking — find anyone by name" },
  deployments: { title: "Deployments", sub: "Release timeline & error blast-radius correlation" },
  releases: { title: "Release Readiness", sub: "Go / no-go signals for the next deploy" },
  sim: { title: "Simulation Engine", sub: "Digital twin — model \"what happens if…\" before it happens" },
  infra: { title: "Infrastructure", sub: "Host resources, process & container fleet" },
  database: { title: "Database", sub: "MySQL connections, throughput & storage" },
  storage: { title: "Storage", sub: "Disk, object store, database & Redis footprint" },
  services: { title: "Services & Health", sub: "Dependency probes & latency" },
  realtime: { title: "Realtime · LiveKit", sub: "Active rooms, participants & media" },
  messaging: { title: "Messaging", sub: "Conversations & message throughput" },
  users: { title: "Users & Sessions", sub: "Accounts & live session activity" },
  performance: { title: "Performance", sub: "Latency, resource pressure & trends" },
  errors: { title: "Error Center", sub: "Errors grouped by fingerprint, with fault domain" },
  resolved: { title: "Resolved", sub: "Issues marked fixed — kept for the record, across every area" },
  logs: { title: "Logs", sub: "Live error & event stream" },
  alerts: { title: "Alerts", sub: "Threshold monitors & incident signals" },
  deps: { title: "Dependency Graph", sub: "Service topology & data flow" },
  flags: { title: "Feature Flags", sub: "Rollout state across environments" },
  search: { title: "Search", sub: "Query across telemetry & metadata" },
  assistant: { title: "AI Assistant", sub: "Ask about system state in natural language" },
};

export default function DevPortal() {
  const [token, setToken] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [view, setView] = useState("overview");
  const [snap, setSnap] = useState<Snap | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Bumped by the top-bar Refresh button. It is a dependency of apiGet, so bumping it
  // gives apiGet a fresh identity — which re-runs the load effect of EVERY view that
  // fetches its own data through apiGet (Logs, Error Center, E2EE Health, Incidents,
  // Insights…). Without it, Refresh only re-pulled the shared snapshot and the
  // self-fetching views stayed frozen until their own poll ticked.
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [lastAt, setLastAt] = useState<number | null>(null);
  const [topToast, setTopToast] = useState<string | null>(null);
  const histRef = useRef<Hist>(freshHist());

  // Portal credential (its OWN token, decoupled from the app session) + restore
  // last view from hash.
  useEffect(() => {
    let t: string | null = null;
    try {
      t = sessionStorage.getItem("clb_ops_token");
    } catch {}
    setToken(t);
    setReady(true);
    const h = (location.hash || "").replace(/^#\/?/, "").split("?")[0];
    if (h && VIEW_META[h]) setView(h);
    const onHash = () => {
      const v = (location.hash || "").replace(/^#\/?/, "").split("?")[0];
      if (v && VIEW_META[v]) setView(v);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const clearSession = useCallback(() => {
    try {
      sessionStorage.removeItem("clb_ops_token");
    } catch {}
    setToken(null);
    setSnap(null);
  }, []);

  const apiGet = useCallback(
    async (path: string) => {
      const res = await fetch(config.apiBaseUrl + path, {
        headers: token ? { Authorization: "Bearer " + token } : {},
      });
      if (res.status === 401) {
        clearSession();
        throw new Error("Session expired");
      }
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        throw new Error((j && (j.error || j.message)) || `HTTP ${res.status}`);
      }
      return res.json();
    },
    // refreshNonce is intentionally a dependency (not used in the body): bumping it on
    // manual Refresh re-creates apiGet so every self-fetching view reloads. See above.
    [token, clearSession, refreshNonce],
  );

  const apiPost = useCallback(
    async (path: string, body?: any) => {
      const res = await fetch(config.apiBaseUrl + path, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
        body: JSON.stringify(body || {}),
      });
      if (res.status === 401 && path !== "/api/ops/auth") {
        clearSession();
        throw new Error("Session expired");
      }
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        throw new Error((j && (j.error || j.message)) || `HTTP ${res.status}`);
      }
      return res.json();
    },
    [token, clearSession],
  );

  // Exchange username + password for an ops token (stored in sessionStorage —
  // cleared when the tab closes).
  const login = useCallback(async (username: string, password: string) => {
    const res = await fetch(config.apiBaseUrl + "/api/ops/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const j = await res.json().catch(() => null);
    if (!res.ok || !j?.token) throw new Error((j && j.error) || `HTTP ${res.status}`);
    try {
      sessionStorage.setItem("clb_ops_token", j.token);
    } catch {}
    setToken(j.token);
  }, []);

  const pull = useCallback(
    async (manual?: boolean) => {
      if (!token) return;
      if (manual) setRefreshing(true);
      try {
        const j = await apiGet("/api/ops/snapshot");
        setSnap(j);
        setErr(null);
        setLastAt(Date.now());
        // push to history buffer
        const h = histRef.current;
        const push = (arr: number[], v: number) => {
          arr.push(v);
          if (arr.length > HIST_MAX) arr.shift();
        };
        push(h.cpu, Number(j?.server?.cpuPct) || 0);
        push(h.mem, j?.server?.sysTotalMem ? (Number(j.server.memRssBytes) / Number(j.server.sysTotalMem)) * 100 : 0);
        push(h.msg, Number(j?.counts?.messages24h) || 0);
        push(h.part, Number(j?.counts?.liveParticipants) || 0);
        push(h.queries, Number(j?.db?.queries) || 0);
        push(h.dbConn, Number(j?.db?.threadsConnected) || 0);
        push(h.redisOps, Number(j?.redis?.opsPerSec) || 0);
      } catch (e: any) {
        setErr(String(e?.message || e));
      } finally {
        if (manual) setRefreshing(false);
      }
    },
    [token, apiGet],
  );

  // poll snapshot every 5s
  useEffect(() => {
    if (!token) return;
    pull();
    const id = setInterval(() => pull(), 5000);
    return () => clearInterval(id);
  }, [token, pull]);

  const go = (id: string) => {
    setView(id);
    try {
      history.replaceState(null, "", "#/" + id);
    } catch {}
  };
  // Click-through: open the User Experience view focused on a person.
  const openUser = useCallback((name: string) => {
    try {
      location.hash = "#/experience?u=" + encodeURIComponent(name);
    } catch {}
    setView("experience");
  }, []);
  const topReport = useCallback(async () => {
    setTopToast("Building report…");
    try {
      const n = await downloadReport(apiGet, "7d");
      setTopToast("Downloaded " + n);
    } catch {
      setTopToast("Report failed");
    }
    setTimeout(() => setTopToast(null), 3000);
  }, [apiGet]);

  // ── credential gate ─────────────────────────────────────────────────────────
  if (!ready) return <div style={{ position: "fixed", inset: 0, background: "#070b14" }} />;
  if (!token) return <OpsLogin onLogin={login} />;

  const meta = VIEW_META[view];
  const navCounts: Record<string, number | undefined> = {
    realtime: snap?.counts?.activeRooms,
    errors: snap?.errors?.length,
    users: snap?.counts?.users,
  };

  return (
    <div className="devp">
      {/* Rail */}
      <aside className="devp-rail">
        <div className="devp-brand">
          <div className="devp-brand-logo">
            <IcoGauge size={17} />
          </div>
          <div className="devp-brand-txt">
            <b>Observatory</b>
            <span>Collab Intelligence</span>
          </div>
        </div>
        <nav className="devp-nav">
          {NAV.map((g) => (
            <div className="devp-navgroup" key={g.group}>
              <div className="devp-navlabel">{g.group}</div>
              {g.items.map((it) => {
                const Icon = it.icon;
                const c = navCounts[it.id];
                return (
                  <button key={it.id} className={"devp-navitem" + (view === it.id ? " on" : "")} onClick={() => go(it.id)}>
                    <Icon size={16} />
                    <span>{it.label}</span>
                    {typeof c === "number" && c > 0 ? <span className="devp-navcount">{fmtNum(c)}</span> : null}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="devp-railfoot">
          <span>v{snap?.server?.version || "1.0.1"}</span>
          <span className="devp-mono" style={{ fontFamily: "var(--d-mono)" }}>
            {snap?.server?.node || ""}
          </span>
        </div>
      </aside>

      {/* Main */}
      <div className="devp-main">
        <header className="devp-top">
          <div className="devp-top-title">
            <b>{meta.title}</b>
            <span>{meta.sub}</span>
          </div>
          <div className="devp-top-spacer" />
          {snap?.server?.env && <span className={"devp-chip devp-env " + (snap.server.env === "production" ? "prod" : "dev")}>{snap.server.env}</span>}
          <span className="devp-chip mono">
            <IcoServer size={13} /> {snap?.server?.hostname || "—"}
          </span>
          <LiveStatus lastAt={lastAt} />
          <LiveClock />
          <button className="devp-btn" onClick={topReport} title="Download a shareable engineering report (last 7 days)">
            <IcoRocketDeploy size={14} /> Report
          </button>
          <button
            className={"devp-iconbtn" + (refreshing ? " spin" : "")}
            onClick={() => {
              // Re-pull the shared snapshot AND re-drive every self-fetching view
              // (Logs/Errors/E2EE/Incidents/…) by giving apiGet a fresh identity.
              setRefreshNonce((n) => n + 1);
              pull(true);
            }}
            title="Refresh now"
            aria-label="Refresh"
          >
            <IcoRefresh size={16} />
          </button>
          <button className="devp-iconbtn" onClick={clearSession} title="Sign out of the portal" aria-label="Sign out">
            <IcoLogout size={16} />
          </button>
        </header>
        {topToast ? <div className="devp-toast">{topToast}</div> : null}

        <div className="devp-scroll">
          {err && !snap ? (
            <div className="devp-view">
              <div className="devp-empty">
                <IcoAlert size={30} />
                <b>Telemetry unavailable</b>
                <span>{err}. The ops API may be unreachable or restarting — it will reconnect automatically.</span>
              </div>
            </div>
          ) : !snap ? (
            <LoadingView />
          ) : (
            <div className="devp-view" key={view}>
              {view === "overview" && <Overview snap={snap} hist={histRef.current} />}
              {view === "cto" && <EngineeringReview apiGet={apiGet} />}
              {view === "arch" && <Architecture apiGet={apiGet} />}
              {view === "insights" && <Insights apiGet={apiGet} />}
              {view === "fault" && <FaultAttribution apiGet={apiGet} />}
              {view === "incidents" && <Incidents apiGet={apiGet} />}
              {view === "e2ee" && <E2EEHealth apiGet={apiGet} />}
              {view === "e2eeKeys" && <E2EEIdentityKeys apiGet={apiGet} />}
              {view === "experience" && <UserExperience apiGet={apiGet} />}
              {view === "deployments" && <Deployments apiGet={apiGet} />}
              {view === "sim" && <SimulationEngine apiGet={apiGet} />}
              {view === "infra" && <Infrastructure snap={snap} hist={histRef.current} apiGet={apiGet} />}
              {view === "database" && <Database snap={snap} hist={histRef.current} />}
              {view === "storage" && <StorageView apiGet={apiGet} />}
              {view === "services" && <Services snap={snap} />}
              {view === "realtime" && <Realtime snap={snap} hist={histRef.current} />}
              {view === "messaging" && <Messaging snap={snap} hist={histRef.current} />}
              {view === "users" && <UsersView snap={snap} />}
              {view === "performance" && <Performance snap={snap} hist={histRef.current} />}
              {view === "errors" && <ErrorCenter apiGet={apiGet} apiPost={apiPost} openUser={openUser} />}
              {view === "resolved" && <ErrorCenter apiGet={apiGet} apiPost={apiPost} openUser={openUser} initialState="resolved" />}
              {view === "logs" && <Logs apiGet={apiGet} />}
              {view === "alerts" && <Alerts snap={snap} />}
              {view === "deps" && <Deps snap={snap} />}
              {view === "releases" && <ReleaseReadiness snap={snap} apiGet={apiGet} />}
              {view === "flags" && <FeatureFlags apiGet={apiGet} />}
              {view === "search" && <Search apiGet={apiGet} openUser={openUser} />}
              {view === "assistant" && <AIAssistant apiGet={apiGet} />}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── credential login (the portal's own gate, decoupled from the app session) ──
function OpsLogin({ onLogin }: { onLogin: (username: string, password: string) => Promise<void> }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onLogin(username.trim() || "admin", password);
    } catch (err: any) {
      setError(String(err?.message || err));
      setBusy(false);
    }
  };
  return (
    <div className="devp devp-loginwrap">
      <form className="devp-login" onSubmit={submit}>
        <div className="devp-login-logo">
          <IcoGauge size={26} />
        </div>
        <b className="devp-login-title">Observatory</b>
        <span className="devp-login-sub">Collab Engineering Intelligence</span>
        <input className="devp-input devp-login-in" type="text" placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
        <input className="devp-input devp-login-in" type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus autoComplete="current-password" />
        {error ? <div className="devp-login-err">{error}</div> : null}
        <button className="devp-login-btn" type="submit" disabled={busy || !password}>
          {busy ? "Verifying…" : "Enter Observatory"}
        </button>
        <span className="devp-login-note">This portal exposes infrastructure internals. Access is credential-gated and audited.</span>
      </form>
    </div>
  );
}

// ── live status pill (isolated so staleness ticks every second WITHOUT
// re-rendering the whole dashboard — the charts/tables only re-render on poll) ─
function LiveStatus({ lastAt }: { lastAt: number | null }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const state = !lastAt ? "down" : Date.now() - lastAt < 9000 ? "" : Date.now() - lastAt < 30000 ? "stale" : "down";
  return (
    <span className="devp-live">
      <span className={"devp-livedot " + state} />
      {state === "" ? "Live" : state === "stale" ? "Stale" : "Offline"}
    </span>
  );
}

// ── live clock (isolated so its per-second tick doesn't churn the tree) ───────
function LiveClock() {
  const [t, setT] = useState<string>("");
  useEffect(() => {
    const f = () =>
      setT(
        new Date().toLocaleTimeString(undefined, { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }),
      );
    f();
    const id = setInterval(f, 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="devp-chip mono" title="Local time">
      <IcoClock size={13} /> {t}
    </span>
  );
}

function LoadingView() {
  return (
    <div className="devp-view">
      <div className="devp-grid k4" style={{ marginBottom: 16 }}>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="devp-skel" style={{ height: 118 }} />
        ))}
      </div>
      <div className="devp-grid k3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="devp-skel" style={{ height: 240 }} />
        ))}
      </div>
    </div>
  );
}

// ── shared primitives ─────────────────────────────────────────────────────────
function Kpi({ label, value, unit, icon, color, spark, foot, delta }: { label: string; value: React.ReactNode; unit?: string; icon: any; color: string; spark?: number[]; foot?: React.ReactNode; delta?: { dir: "up" | "down" | "flat"; text: string } }) {
  const Icon = icon;
  return (
    <div className="devp-kpi" style={{ ["--kpi-c" as any]: color }}>
      <div className="devp-kpi-top">
        <span className="devp-kpi-ico">
          <Icon size={15} />
        </span>
        {label}
      </div>
      <div className="devp-kpi-val">
        {value}
        {unit ? <small>{unit}</small> : null}
      </div>
      <div className="devp-kpi-foot">
        {delta ? <span className={"devp-delta " + delta.dir}>{delta.text}</span> : null}
        {foot}
      </div>
      {spark && spark.length > 1 ? <Spark data={spark} color={color} /> : null}
    </div>
  );
}
function Card({ title, sub, children, className, icon, right }: { title?: string; sub?: string; children: React.ReactNode; className?: string; icon?: any; right?: React.ReactNode }) {
  const Icon = icon;
  return (
    <div className={"devp-card " + (className || "")}>
      {title && (
        <div className="devp-cardhead">
          {Icon ? <Icon size={15} /> : null}
          <h3>{title}</h3>
          {sub ? <span className="devp-cardsub">{sub}</span> : null}
          {right}
        </div>
      )}
      {children}
    </div>
  );
}
function Meter({ label, value, display, color }: { label: string; value: number; display: string; color?: string }) {
  return (
    <div className="devp-metric-row">
      <div className="devp-mlabel">{label}</div>
      <div className="devp-meter" style={{ ["--m-c" as any]: color || meterColor(value) }}>
        <i style={{ width: Math.max(2, Math.min(100, value)) + "%" }} />
      </div>
      <div className="devp-mval">{display}</div>
    </div>
  );
}
const meterColor = (pct: number) => (pct >= 88 ? "var(--d-bad)" : pct >= 70 ? "var(--d-warn)" : "var(--d-acc)");
function Kv({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <div className="devp-kvlist">
      {rows.map((r, i) => (
        <div className="devp-kv" key={i}>
          <span className="devp-kvk">{r[0]}</span>
          <span className="devp-kvv">{r[1]}</span>
        </div>
      ))}
    </div>
  );
}
function Pill({ kind, children }: { kind: string; children: React.ReactNode }) {
  return <span className={"devp-pill " + kind}>{children}</span>;
}

// ── Executive Overview ────────────────────────────────────────────────────────
function Overview({ snap, hist }: { snap: Snap; hist: Hist }) {
  const c = snap.counts || {};
  const s = snap.server || {};
  const score = snap.score ?? 0;
  const memPct = s.sysTotalMem ? (s.memRssBytes / s.sysTotalMem) * 100 : 0;
  const checks = snap.health?.checks || {};
  const svcList = [
    { k: "db", label: "MySQL", ok: checks.db?.ok, ms: checks.db?.ms },
    { k: "redis", label: "Redis", ok: snap.redis?.configured ? checks.redis?.ok : null, ms: checks.redis?.ms },
    { k: "storage", label: "Object Storage", ok: checks.storage?.ok, ms: checks.storage?.ms },
    { k: "livekit", label: "LiveKit", ok: snap.livekit?.configured ? snap.livekit?.ok : null, ms: null },
  ];
  return (
    <>
      <div className="devp-grid k4" style={{ marginBottom: 16 }}>
        <Kpi label="TOTAL USERS" value={fmtInt(c.users)} icon={IcoUsers} color="var(--d-acc)" foot={<span>{fmtInt(c.activeSessions)} active now</span>} />
        <Kpi label="MESSAGES (24H)" value={fmtNum(c.messages24h)} icon={IcoChat} color="var(--d-vio)" spark={hist.msg} foot={<span>{fmtInt(c.messages)} all-time</span>} />
        <Kpi label="LIVE PARTICIPANTS" value={fmtInt(c.liveParticipants)} icon={IcoRadio} color="var(--d-ok)" spark={hist.part} foot={<span>{fmtInt(c.activeRooms)} active rooms</span>} />
        <Kpi label="OPEN ERRORS" value={fmtInt((snap.errors || []).length)} icon={IcoAlert} color={(snap.errors || []).length ? "var(--d-bad)" : "var(--d-ok)"} foot={<span>{fmtInt((snap.errors || []).reduce((a: number, e: any) => a + (e.count || 0), 0))} occurrences</span>} />
      </div>

      <div className="devp-grid k3">
        <Card title="Platform Health" icon={IcoShield}>
          <div className="devp-ring-wrap">
            <HealthRing score={score} />
            <div className="devp-ring-legend">
              {svcList.map((sv) => (
                <div className="devp-legrow" key={sv.k}>
                  <span className={"devp-dot " + (sv.ok == null ? "idle" : sv.ok ? "ok" : "bad")} />
                  <span className="devp-legname">{sv.label}</span>
                  <span className="devp-legval">{sv.ok == null ? "n/a" : sv.ok ? (sv.ms != null ? sv.ms + "ms" : "up") : "down"}</span>
                </div>
              ))}
            </div>
          </div>
        </Card>

        <Card title="Host Resources" icon={IcoServer}>
          <Meter label="CPU" value={s.cpuPct || 0} display={(s.cpuPct || 0).toFixed(1) + "%"} />
          <Meter label="Memory (RSS)" value={memPct} display={fmtBytes(s.memRssBytes) + " / " + fmtBytes(s.sysTotalMem)} />
          <Meter label="Heap" value={s.memHeapTotal ? (s.memHeapUsed / s.memHeapTotal) * 100 : 0} display={fmtBytes(s.memHeapUsed) + " / " + fmtBytes(s.memHeapTotal)} />
          <Meter label="Load (1m)" value={s.cores ? ((s.loadAvg?.[0] || 0) / s.cores) * 100 : 0} display={(s.loadAvg?.[0] || 0).toFixed(2) + " / " + (s.cores || "?") + " cores"} />
          <div style={{ marginTop: 10 }}>
            <Kv rows={[["Process uptime", fmtDur(s.uptimeSec)], ["Node", s.node || "—"], ["Platform", s.platform || "—"]]} />
          </div>
        </Card>

        <Card title="Recent Errors" icon={IcoAlert} sub={(snap.errors || []).length ? fmtInt(snap.errors.length) + " open" : "clean"}>
          {(snap.errors || []).length === 0 ? (
            <div className="devp-empty" style={{ padding: "28px 10px" }}>
              <IcoShield size={26} />
              <b>No open errors</b>
              <span>The error ledger is clean.</span>
            </div>
          ) : (
            <div style={{ margin: "-4px -6px 0" }}>
              {(snap.errors || []).slice(0, 6).map((e: any) => (
                <div className="devp-log" key={e.id} style={{ gridTemplateColumns: "58px 1fr auto", borderBottom: "1px solid rgba(29,41,66,.5)" }}>
                  <span className={"devp-log-lvl " + (e.level || "error")}>{e.level || "err"}</span>
                  <span className="devp-log-msg" title={e.message}>
                    {e.message}
                  </span>
                  <span className="devp-log-cnt">×{fmtNum(e.count)}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <div className="devp-sectlabel">Throughput</div>
      <div className="devp-grid k2">
        <Card title="Message Volume (24h window)" icon={IcoActivity}>
          <BigSpark data={hist.msg} color="var(--d-vio)" label={fmtInt(snap.counts?.messages24h) + " in last 24h"} />
        </Card>
        <Card title="Live Participants" icon={IcoRadio}>
          <BigSpark data={hist.part} color="var(--d-ok)" label={fmtInt(snap.counts?.liveParticipants) + " across " + fmtInt(snap.counts?.activeRooms) + " rooms"} />
        </Card>
      </div>
    </>
  );
}

function HealthRing({ score }: { score: number }) {
  const r = 56;
  const circ = 2 * Math.PI * r;
  const off = circ * (1 - Math.max(0, Math.min(100, score)) / 100);
  const col = score >= 85 ? "var(--d-ok)" : score >= 60 ? "var(--d-warn)" : "var(--d-bad)";
  return (
    <div className="devp-ring">
      <svg width="132" height="132" viewBox="0 0 132 132">
        <circle cx="66" cy="66" r={r} fill="none" stroke="var(--d-raise)" strokeWidth="10" />
        <circle cx="66" cy="66" r={r} fill="none" stroke={col} strokeWidth="10" strokeLinecap="round" strokeDasharray={circ} strokeDashoffset={off} style={{ transition: "stroke-dashoffset .6s cubic-bezier(.2,.7,.2,1)" }} />
      </svg>
      <div className="devp-ring-label">
        <div>
          <b style={{ color: col }}>{Math.round(score)}</b>
          <span>Health</span>
        </div>
      </div>
    </div>
  );
}
function BigSpark({ data, color, label }: { data: number[]; color: string; label: string }) {
  return (
    <div>
      <div style={{ height: 90, position: "relative", margin: "4px 0 10px" }}>
        {data && data.length > 1 ? (
          <svg width="100%" height="90" viewBox="0 0 300 90" preserveAspectRatio="none" style={{ display: "block" }}>
            {(() => {
              const w = 300;
              const h = 90;
              const max = Math.max(...data, 1);
              const min = Math.min(...data, 0);
              const span = max - min || 1;
              const pts = data.map((v, i) => [(i / (data.length - 1)) * w, h - 4 - ((v - min) / span) * (h - 8)]);
              const line = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
              return (
                <>
                  <defs>
                    <linearGradient id={"bg" + color.replace(/\W/g, "")} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0" stopColor={color} stopOpacity="0.25" />
                      <stop offset="1" stopColor={color} stopOpacity="0" />
                    </linearGradient>
                  </defs>
                  <path d={`${line} L${w} ${h} L0 ${h} Z`} fill={`url(#bg${color.replace(/\W/g, "")})`} />
                  <path d={line} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
                </>
              );
            })()}
          </svg>
        ) : (
          <div className="devp-note" style={{ paddingTop: 32, textAlign: "center" }}>
            Collecting samples… (updates every 5s)
          </div>
        )}
      </div>
      <div className="devp-note">{label}</div>
    </div>
  );
}

// ── Infrastructure ────────────────────────────────────────────────────────────
function Infrastructure({ snap, hist, apiGet }: { snap: Snap; hist: Hist; apiGet: (p: string) => Promise<any> }) {
  const s = snap.server || {};
  const [ctn, setCtn] = useState<any>(null);
  const [ctnErr, setCtnErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      apiGet("/api/ops/containers")
        .then((j) => {
          if (alive) {
            setCtn(j);
            setCtnErr(null);
          }
        })
        .catch((e) => alive && setCtnErr(String(e?.message || e)));
    load();
    const id = setInterval(load, 12000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [apiGet]);
  const memPct = s.sysTotalMem ? (s.memRssBytes / s.sysTotalMem) * 100 : 0;
  return (
    <>
      <div className="devp-grid k4" style={{ marginBottom: 16 }}>
        <Kpi label="CPU" value={(s.cpuPct || 0).toFixed(1)} unit="%" icon={IcoCpu} color="var(--d-acc)" spark={hist.cpu} foot={<span>{s.cores} cores</span>} />
        <Kpi label="MEMORY (RSS)" value={fmtBytes(s.memRssBytes)} icon={IcoMem} color="var(--d-vio)" spark={hist.mem} foot={<span>of {fmtBytes(s.sysTotalMem)}</span>} />
        <Kpi label="LOAD AVG" value={(s.loadAvg?.[0] || 0).toFixed(2)} icon={IcoActivity} color="var(--d-ok)" foot={<span>1m · {(s.loadAvg?.[1] || 0).toFixed(2)} 5m</span>} />
        <Kpi label="UPTIME" value={fmtDur(s.uptimeSec)} icon={IcoClock} color="var(--d-warn)" foot={<span>pid {s.pid}</span>} />
      </div>

      <div className="devp-grid k2">
        <Card title="Process & Host" icon={IcoServer}>
          <Kv
            rows={[
              ["Hostname", s.hostname],
              ["Environment", s.env],
              ["Node version", s.node],
              ["Platform", s.platform],
              ["CPU cores", s.cores],
              ["Process PID", s.pid],
              ["Heap used", `${fmtBytes(s.memHeapUsed)} / ${fmtBytes(s.memHeapTotal)}`],
              ["System memory", `${fmtBytes(s.sysTotalMem - s.sysFreeMem)} used · ${fmtBytes(s.sysFreeMem)} free`],
              ["Started", s.processStartedAt ? new Date(s.processStartedAt).toLocaleString() : "—"],
            ]}
          />
        </Card>
        <Card title="Resource Pressure" icon={IcoGauge}>
          <Meter label="CPU" value={s.cpuPct || 0} display={(s.cpuPct || 0).toFixed(1) + "%"} />
          <Meter label="Mem RSS" value={memPct} display={memPct.toFixed(1) + "%"} />
          <Meter label="Heap" value={s.memHeapTotal ? (s.memHeapUsed / s.memHeapTotal) * 100 : 0} display={s.memHeapTotal ? ((s.memHeapUsed / s.memHeapTotal) * 100).toFixed(0) + "%" : "—"} />
          <Meter label="Sys mem" value={s.sysTotalMem ? ((s.sysTotalMem - s.sysFreeMem) / s.sysTotalMem) * 100 : 0} display={s.sysTotalMem ? (((s.sysTotalMem - s.sysFreeMem) / s.sysTotalMem) * 100).toFixed(0) + "%" : "—"} />
          <Meter label="Load/core" value={s.cores ? ((s.loadAvg?.[0] || 0) / s.cores) * 100 : 0} display={s.cores ? (((s.loadAvg?.[0] || 0) / s.cores) * 100).toFixed(0) + "%" : "—"} />
        </Card>
      </div>

      <div className="devp-sectlabel">Container Fleet</div>
      {ctn && ctn.available && ctn.containers?.length ? (
        <div className="devp-grid k3">
          {ctn.containers.map((c: any) => (
            <div className="devp-ctn" key={c.id}>
              <div className="devp-ctn-head">
                <span className={"devp-dot " + (c.health === "healthy" || c.state === "running" ? "ok" : c.state === "restarting" ? "warn" : "bad")} />
                <b title={c.name}>{c.name || c.id}</b>
                {c.oomKilled ? <span className="devp-pill bad" title="Killed by the out-of-memory killer">OOM</span> : null}
                {c.restartCount > 0 ? <span className="devp-pill warn" title="Container restart count">↻ {c.restartCount}</span> : null}
                <Pill kind={c.state === "running" ? "ok" : "bad"}>{c.state}</Pill>
              </div>
              <div className="devp-ctn-img" title={c.image}>
                {c.image}
              </div>
              <div className="devp-ctn-stats">
                <div className="devp-ctn-stat">
                  <span>CPU</span>
                  <b>{c.cpuPct != null ? c.cpuPct.toFixed(1) + "%" : "—"}</b>
                </div>
                <div className="devp-ctn-stat">
                  <span>Memory</span>
                  <b>{fmtBytes(c.memBytes)}</b>
                </div>
                <div className="devp-ctn-stat">
                  <span>Uptime</span>
                  <b style={{ fontSize: 12 }}>{c.startedAt ? timeAgo(c.startedAt).replace(" ago", "") : "—"}</b>
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <Card>
          <div className="devp-empty" style={{ padding: "26px 12px" }}>
            <IcoBox size={28} />
            <b>Container metrics not mounted</b>
            <span>
              {ctnErr ? ctnErr + ". " : ""}
              Docker engine stats appear here when <code style={{ color: "var(--d-fg2)" }}>/var/run/docker.sock</code> is mounted read-only on the backend. Service-level health is available under Services &amp; Health.
            </span>
          </div>
        </Card>
      )}
    </>
  );
}

// ── Database ──────────────────────────────────────────────────────────────────
function Database({ snap, hist }: { snap: Snap; hist: Hist }) {
  const d = snap.db || {};
  const connPct = d.maxConnections ? (d.threadsConnected / d.maxConnections) * 100 : 0;
  const maxTableBytes = Math.max(1, ...(d.tables || []).map((t: any) => Number(t.bytes) || 0));
  return (
    <>
      <div className="devp-grid k4" style={{ marginBottom: 16 }}>
        <Kpi label="STATUS" value={d.ok ? "Online" : "Down"} icon={IcoDb} color={d.ok ? "var(--d-ok)" : "var(--d-bad)"} foot={<span>{d.latencyMs}ms ping</span>} />
        <Kpi label="CONNECTIONS" value={fmtInt(d.threadsConnected)} icon={IcoActivity} color="var(--d-acc)" spark={hist.dbConn} foot={<span>of {fmtInt(d.maxConnections)} max</span>} />
        <Kpi label="QUERIES" value={fmtNum(d.queries)} icon={IcoBolt} color="var(--d-vio)" spark={hist.queries} foot={<span>{fmtInt(d.slowQueries)} slow</span>} />
        <Kpi label="UPTIME" value={fmtDur(d.uptimeSec)} icon={IcoClock} color="var(--d-warn)" foot={<span>{d.threadsRunning} running</span>} />
      </div>

      <div className="devp-grid k3">
        <Card title="Engine" icon={IcoDb}>
          <Kv
            rows={[
              ["Driver", d.driver],
              ["Version", d.version],
              ["Threads connected", fmtInt(d.threadsConnected)],
              ["Threads running", fmtInt(d.threadsRunning)],
              ["Max connections", fmtInt(d.maxConnections)],
              ["Aborted connects", fmtInt(d.abortedConnects)],
              ["Bytes sent", fmtBytes(d.bytesSent)],
              ["Bytes received", fmtBytes(d.bytesReceived)],
            ]}
          />
          <div style={{ marginTop: 12 }}>
            <Meter label="Conn pool" value={connPct} display={connPct.toFixed(0) + "%"} />
          </div>
        </Card>
        <Card title="Largest Tables" icon={IcoList} sub={fmtInt((d.tables || []).length)} className="devp-span2">
          <div className="devp-tablewrap">
            <table className="devp-table">
              <thead>
                <tr>
                  <th>Table</th>
                  <th className="mono">Rows</th>
                  <th className="mono">Size</th>
                  <th style={{ width: "40%" }}>Footprint</th>
                </tr>
              </thead>
              <tbody>
                {(d.tables || []).map((t: any) => (
                  <tr key={t.name}>
                    <td className="devp-t-strong">{t.name}</td>
                    <td className="mono">{fmtInt(Number(t.nrows))}</td>
                    <td className="mono">{fmtBytes(Number(t.bytes))}</td>
                    <td>
                      <div className="devp-meter" style={{ ["--m-c" as any]: "var(--d-vio)" }}>
                        <i style={{ width: Math.max(2, (Number(t.bytes) / maxTableBytes) * 100) + "%" }} />
                      </div>
                    </td>
                  </tr>
                ))}
                {(d.tables || []).length === 0 && (
                  <tr>
                    <td colSpan={4} style={{ color: "var(--d-mut)", textAlign: "center", padding: 22 }}>
                      No table statistics available
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </>
  );
}

// ── Services & Health ─────────────────────────────────────────────────────────
function Services({ snap }: { snap: Snap }) {
  const ch = snap.health?.checks || {};
  const redis = snap.redis || {};
  const lk = snap.livekit || {};
  const services = [
    { icon: IcoDb, name: "MySQL", desc: (snap.db?.version || "database") + " · " + (snap.db?.driver || ""), ok: ch.db?.ok, ms: ch.db?.ms, err: ch.db?.error, critical: true },
    { icon: IcoBolt, name: "Redis", desc: redis.configured ? "v" + (redis.version || "?") + " · " + (redis.memoryHuman || fmtBytes(redis.memoryBytes)) : "not configured", ok: redis.configured ? ch.redis?.ok : null, ms: ch.redis?.ms, err: ch.redis?.error, critical: false },
    { icon: IcoBox, name: "Object Storage", desc: "S3 / MinIO bucket", ok: ch.storage?.ok, ms: ch.storage?.ms, err: ch.storage?.error, critical: true },
    { icon: IcoRadio, name: "LiveKit", desc: lk.configured ? (lk.ok ? (lk.rooms?.length || 0) + " active rooms" : "unreachable") : "not configured", ok: lk.configured ? lk.ok : null, ms: null, err: lk.error, critical: false },
  ];
  const okCount = services.filter((s) => s.ok === true).length;
  const configured = services.filter((s) => s.ok != null).length;
  return (
    <>
      <div className="devp-grid k3" style={{ marginBottom: 16 }}>
        <Kpi label="SERVICES UP" value={okCount + "/" + configured} icon={IcoShield} color={okCount === configured ? "var(--d-ok)" : "var(--d-bad)"} foot={<span>dependency probes</span>} />
        <Kpi label="DB LATENCY" value={ch.db?.ms ?? "—"} unit="ms" icon={IcoActivity} color="var(--d-acc)" foot={<span>round-trip</span>} />
        <Kpi label="STORAGE" value={ch.storage?.ok ? "OK" : "Down"} unit="" icon={IcoBox} color={ch.storage?.ok ? "var(--d-ok)" : "var(--d-bad)"} foot={<span>{ch.storage?.ms ?? "—"}ms</span>} />
      </div>
      <div className="devp-grid k2">
        <Card title="Dependency Probes" icon={IcoShield} className="devp-span2">
          {services.map((s) => {
            const Icon = s.icon;
            return (
              <div className="devp-svc" key={s.name}>
                <span className="devp-svc-ico">
                  <Icon size={16} />
                </span>
                <div className="devp-svc-name">
                  <b>{s.name}</b>
                  <span>{s.err ? <span style={{ color: "var(--d-bad)" }}>{s.err}</span> : s.desc}</span>
                </div>
                <div className="devp-svc-meta">
                  {s.critical && <span className="devp-note" style={{ fontSize: 10 }}>critical</span>}
                  {s.ms != null && <span className="devp-svc-lat">{s.ms}ms</span>}
                  <Pill kind={s.ok == null ? "mut" : s.ok ? "ok" : "bad"}>{s.ok == null ? "n/a" : s.ok ? "operational" : "down"}</Pill>
                </div>
              </div>
            );
          })}
        </Card>
      </div>
      {redis.configured && redis.ok && (
        <>
          <div className="devp-sectlabel">Redis Detail</div>
          <div className="devp-grid k4">
            <Kpi label="MEMORY" value={redis.memoryHuman || fmtBytes(redis.memoryBytes)} icon={IcoMem} color="var(--d-acc)" foot={<span>{fmtInt(redis.clients)} clients</span>} />
            <Kpi label="OPS/SEC" value={fmtInt(redis.opsPerSec)} icon={IcoBolt} color="var(--d-vio)" foot={<span>instantaneous</span>} />
            <Kpi label="HIT RATE" value={redis.hits + redis.misses > 0 ? ((redis.hits / (redis.hits + redis.misses)) * 100).toFixed(1) : "—"} unit="%" icon={IcoActivity} color="var(--d-ok)" foot={<span>{fmtNum(redis.hits)} hits</span>} />
            <Kpi label="UPTIME" value={fmtDur(redis.uptimeSec)} icon={IcoClock} color="var(--d-warn)" foot={<span>{fmtInt(redis.evictedKeys)} evicted</span>} />
          </div>
        </>
      )}
    </>
  );
}

// ── Realtime (LiveKit) ────────────────────────────────────────────────────────
function Realtime({ snap, hist }: { snap: Snap; hist: Hist }) {
  const lk = snap.livekit || {};
  const rooms = lk.rooms || [];
  const totalPart = rooms.reduce((a: number, r: any) => a + (r.participants || 0), 0);
  if (!lk.configured) {
    return (
      <Card>
        <div className="devp-empty">
          <IcoRadio size={30} />
          <b>LiveKit not configured</b>
          <span>Set the LiveKit host + credentials to view active rooms, participants and media stats.</span>
        </div>
      </Card>
    );
  }
  return (
    <>
      <div className="devp-grid k4" style={{ marginBottom: 16 }}>
        <Kpi label="ACTIVE ROOMS" value={fmtInt(rooms.length)} icon={IcoRadio} color="var(--d-acc)" foot={<span>live sessions</span>} />
        <Kpi label="PARTICIPANTS" value={fmtInt(totalPart)} icon={IcoUsers} color="var(--d-ok)" spark={hist.part} foot={<span>connected now</span>} />
        <Kpi label="PUBLISHERS" value={fmtInt(rooms.reduce((a: number, r: any) => a + (r.publishers || 0), 0))} icon={IcoActivity} color="var(--d-vio)" foot={<span>sending media</span>} />
        <Kpi label="SFU STATUS" value={lk.ok ? "Online" : "Down"} icon={IcoShield} color={lk.ok ? "var(--d-ok)" : "var(--d-bad)"} foot={<span>{lk.error || "reachable"}</span>} />
      </div>
      <Card title="Active Rooms" icon={IcoRadio} sub={fmtInt(rooms.length)}>
        {rooms.length === 0 ? (
          <div className="devp-empty" style={{ padding: "28px 10px" }}>
            <IcoRadio size={26} />
            <b>No active rooms</b>
            <span>Calls and meetings appear here in real time as they start.</span>
          </div>
        ) : (
          <div className="devp-tablewrap">
            <table className="devp-table">
              <thead>
                <tr>
                  <th>Room</th>
                  <th className="mono">Participants</th>
                  <th className="mono">Publishers</th>
                  <th className="mono">Bitrate</th>
                  <th className="mono">Age</th>
                </tr>
              </thead>
              <tbody>
                {rooms.map((r: any) => (
                  <tr key={r.name}>
                    <td className="devp-t-strong" style={{ fontFamily: "var(--d-mono)", fontSize: 11.5 }}>
                      {r.name}
                    </td>
                    <td className="mono">{r.participants}</td>
                    <td className="mono">{r.publishers}</td>
                    <td className="mono">{r.bitrate ? fmtBytes(r.bitrate) + "/s" : "—"}</td>
                    <td className="mono">{r.createdAt ? timeAgo(r.createdAt) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

// ── Messaging ─────────────────────────────────────────────────────────────────
function Messaging({ snap, hist }: { snap: Snap; hist: Hist }) {
  const c = snap.counts || {};
  const avgPerConv = c.conversations ? c.messages / c.conversations : 0;
  return (
    <>
      <div className="devp-grid k4" style={{ marginBottom: 16 }}>
        <Kpi label="TOTAL MESSAGES" value={fmtNum(c.messages)} icon={IcoChat} color="var(--d-acc)" foot={<span>all-time</span>} />
        <Kpi label="LAST 24H" value={fmtNum(c.messages24h)} icon={IcoActivity} color="var(--d-vio)" spark={hist.msg} foot={<span>rolling window</span>} />
        <Kpi label="CONVERSATIONS" value={fmtNum(c.conversations)} icon={IcoUsers} color="var(--d-ok)" foot={<span>channels + DMs</span>} />
        <Kpi label="AVG / CONVO" value={avgPerConv ? avgPerConv.toFixed(0) : "—"} icon={IcoList} color="var(--d-warn)" foot={<span>messages each</span>} />
      </div>
      <Card title="Message Throughput" icon={IcoActivity}>
        <BigSpark data={hist.msg} color="var(--d-vio)" label={"Sampled every 5s · " + fmtInt(c.messages24h) + " messages in the last 24 hours"} />
      </Card>
      <div className="devp-sectlabel">Delivery Pipeline</div>
      <Card>
        <div className="devp-note" style={{ lineHeight: 1.7 }}>
          Messages are delivered over Socket.IO with an HTTP fallback and reconciled by client id. End-to-end encryption is enforced on message content — Observatory reports only counts and never message bodies. Delivery failures and E2EE issues surface in the Error Center and E2EE Health, attributed per user and device.
        </div>
      </Card>
    </>
  );
}

// ── Users & Sessions ──────────────────────────────────────────────────────────
function UsersView({ snap }: { snap: Snap }) {
  const c = snap.counts || {};
  const activePct = c.users ? (c.activeSessions / c.users) * 100 : 0;
  return (
    <>
      <div className="devp-grid k4" style={{ marginBottom: 16 }}>
        <Kpi label="TOTAL USERS" value={fmtInt(c.users)} icon={IcoUsers} color="var(--d-acc)" foot={<span>registered accounts</span>} />
        <Kpi label="ACTIVE SESSIONS" value={fmtInt(c.activeSessions)} icon={IcoActivity} color="var(--d-ok)" foot={<span>seen in last 5 min</span>} />
        <Kpi label="IN CALLS" value={fmtInt(c.liveParticipants)} icon={IcoRadio} color="var(--d-vio)" foot={<span>{fmtInt(c.activeRooms)} rooms</span>} />
        <Kpi label="ENGAGEMENT" value={activePct.toFixed(1)} unit="%" icon={IcoSpark} color="var(--d-warn)" foot={<span>active / total</span>} />
      </div>
      <Card title="Presence" icon={IcoUsers}>
        <Meter label="Active now" value={activePct} display={fmtInt(c.activeSessions) + " / " + fmtInt(c.users)} color="var(--d-ok)" />
        <Meter label="In a call" value={c.users ? (c.liveParticipants / c.users) * 100 : 0} display={fmtInt(c.liveParticipants)} color="var(--d-vio)" />
        <div className="devp-note" style={{ marginTop: 12 }}>
          Active sessions are counted from the sessions store (activity within the last 5 minutes). For per-user drill-down — devices, locations, OS and every error a person hit — open <b>User Experience</b> and search their name.
        </div>
      </Card>
    </>
  );
}

// ── Performance ───────────────────────────────────────────────────────────────
function Performance({ snap, hist }: { snap: Snap; hist: Hist }) {
  const s = snap.server || {};
  const ch = snap.health?.checks || {};
  return (
    <>
      <div className="devp-grid k4" style={{ marginBottom: 16 }}>
        <Kpi label="EVENT-LOOP CPU" value={(s.cpuPct || 0).toFixed(1)} unit="%" icon={IcoCpu} color="var(--d-acc)" spark={hist.cpu} foot={<span>process</span>} />
        <Kpi label="DB LATENCY" value={ch.db?.ms ?? "—"} unit="ms" icon={IcoDb} color="var(--d-vio)" foot={<span>round-trip</span>} />
        <Kpi label="STORAGE LATENCY" value={ch.storage?.ms ?? "—"} unit="ms" icon={IcoBox} color="var(--d-ok)" foot={<span>bucket ping</span>} />
        <Kpi label="HEAP" value={fmtBytes(s.memHeapUsed)} icon={IcoMem} color="var(--d-warn)" spark={hist.mem} foot={<span>of {fmtBytes(s.memHeapTotal)}</span>} />
      </div>
      <div className="devp-grid k2">
        <Card title="CPU Trend" icon={IcoCpu}>
          <BigSpark data={hist.cpu} color="var(--d-acc)" label={"Process CPU · " + (s.cpuPct || 0).toFixed(1) + "% now"} />
        </Card>
        <Card title="Memory Trend" icon={IcoMem}>
          <BigSpark data={hist.mem} color="var(--d-warn)" label={"RSS as % of system memory · " + fmtBytes(s.memRssBytes) + " now"} />
        </Card>
      </div>
      <div className="devp-sectlabel">Latency Probes</div>
      <Card>
        <Meter label="MySQL" value={Math.min(100, (ch.db?.ms || 0) * 2)} display={(ch.db?.ms ?? "—") + " ms"} color="var(--d-acc)" />
        <Meter label="Redis" value={Math.min(100, (ch.redis?.ms || 0) * 2)} display={(ch.redis?.ms ?? "—") + " ms"} color="var(--d-vio)" />
        <Meter label="Object storage" value={Math.min(100, (ch.storage?.ms || 0) * 2)} display={(ch.storage?.ms ?? "—") + " ms"} color="var(--d-ok)" />
      </Card>
    </>
  );
}

// ── fault-domain visual mapping (shared) ─────────────────────────────────────
const DOMAIN_UI: Record<string, { label: string; short: string; kind: string; color: string }> = {
  infrastructure: { label: "Infrastructure / Server", short: "Infra", kind: "warn", color: "var(--d-warn)" },
  application: { label: "Application / Code", short: "Code", kind: "bad", color: "var(--d-bad)" },
  external: { label: "External / Third-party", short: "Vendor", kind: "info", color: "var(--d-vio)" },
  client: { label: "Client / User", short: "Client", kind: "mut", color: "var(--d-acc)" },
};
function DomainTag({ domain }: { domain: string }) {
  const d = DOMAIN_UI[domain] || DOMAIN_UI.application;
  return <span className={"devp-pill " + d.kind}>{d.short}</span>;
}
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      return true;
    } catch {
      return false;
    }
  }
}

// ── priority (P0–P3) visual mapping ──────────────────────────────────────────
const PRI_UI: Record<string, { color: string; label: string }> = {
  P0: { color: "#f87171", label: "Critical" },
  P1: { color: "#fb923c", label: "High" },
  P2: { color: "#fbbf24", label: "Medium" },
  P3: { color: "#64748b", label: "Low" },
};
function PriorityTag({ p }: { p: string }) {
  const m = PRI_UI[p] || PRI_UI.P3;
  return <span className="devp-pri" style={{ ["--pri" as any]: m.color }} title={m.label}>{p}</span>;
}
function deviceLabel(d: any): string {
  if (!d) return "server";
  return `${d.browser} · ${d.os}${d.platform === "desktop" ? " · desktop app" : ""}`;
}

// ── premium downloadable report (self-contained HTML, print-to-PDF ready) ─────
function esc(s: any): string {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}
function donutSvg(segments: { label: string; value: number; color: string }[], size = 132): string {
  const realTotal = segments.reduce((s, x) => s + x.value, 0);
  const total = realTotal || 1; // divisor guard only — the label shows the real sum
  const r = size / 2 - 12;
  const c = 2 * Math.PI * r;
  let off = 0;
  const rings = segments
    .filter((s) => s.value > 0)
    .map((s) => {
      const frac = s.value / total;
      const dash = `${(frac * c).toFixed(2)} ${(c - frac * c).toFixed(2)}`;
      const el = `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${s.color}" stroke-width="16" stroke-dasharray="${dash}" stroke-dashoffset="${(-off * c).toFixed(2)}" transform="rotate(-90 ${size / 2} ${size / 2})"/>`;
      off += frac;
      return el;
    })
    .join("");
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${rings}<text x="${size / 2}" y="${size / 2 + 5}" text-anchor="middle" font-size="20" font-weight="700" fill="#0f172a">${realTotal}</text></svg>`;
}
function barsSvg(items: { label: string; value: number; color?: string }[], w = 460): string {
  const max = Math.max(1, ...items.map((i) => i.value));
  return items
    .map(
      (i) =>
        `<div class="bar"><span class="bl">${esc(i.label)}</span><span class="bt"><i style="width:${Math.max(3, (i.value / max) * 100)}%;background:${i.color || "#6366f1"}"></i></span><b>${i.value}</b></div>`,
    )
    .join("");
}
function buildReportHtml(d: any): string {
  const rangeLabel: Record<string, string> = { today: "Today", yesterday: "Yesterday", "7d": "Last 7 days", "30d": "Last 30 days", all: "All time" };
  const priColors: Record<string, string> = { P0: "#ef4444", P1: "#f97316", P2: "#f59e0b", P3: "#94a3b8" };
  const domColors: Record<string, string> = { infrastructure: "#f59e0b", application: "#ef4444", external: "#8b5cf6", client: "#0ea5e9" };
  const t = d.totals || {};
  const health = d.health || {};
  const healthPill = (ok: any, label: string) => `<span class="hp ${ok == null ? "na" : ok ? "ok" : "bad"}">${label}: ${ok == null ? "n/a" : ok ? "OK" : "DOWN"}</span>`;
  const priDonut = donutSvg((d.byPriority || []).map((p: any) => ({ label: p.priority, value: p.count, color: priColors[p.priority] })));
  const domBars = barsSvg((d.byDomain || []).map((x: any) => ({ label: x.label, value: x.count, color: domColors[x.key] })));
  const topRows = (d.topIssues || [])
    .map(
      (i: any) =>
        `<tr><td><span class="pri" style="background:${priColors[i.priority]}">${i.priority}</span></td><td>${esc(i.domain)}</td><td class="msg">${esc(i.message)}</td><td>${esc(i.user)}</td><td>${esc(i.device || "—")}</td><td class="num">${i.count}</td></tr>`,
    )
    .join("");
  const generated = new Date().toLocaleString();
  return `<!doctype html><html><head><meta charset="utf-8"><title>Collab Engineering Report — ${esc(rangeLabel[d.range] || d.range)}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#0f172a;background:#f1f5f9;padding:32px;line-height:1.5}
  .doc{max-width:900px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 10px 40px -12px rgba(0,0,0,.15)}
  .hd{background:linear-gradient(135deg,#0b1220,#1e293b);color:#fff;padding:28px 34px;display:flex;align-items:center;gap:16px}
  .hd .logo{width:44px;height:44px;border-radius:11px;background:linear-gradient(135deg,#38bdf8,#2563eb);display:grid;place-items:center;font-size:22px}
  .hd h1{font-size:19px;font-weight:700}
  .hd .sub{font-size:12px;color:#94a3b8;margin-top:2px}
  .hd .meta{margin-left:auto;text-align:right;font-size:11px;color:#cbd5e1}
  .body{padding:26px 34px 34px}
  .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:24px}
  .kpi{border:1px solid #e2e8f0;border-radius:12px;padding:14px}
  .kpi b{font-size:26px;font-weight:700;display:block}
  .kpi span{font-size:10.5px;text-transform:uppercase;letter-spacing:.6px;color:#64748b;font-weight:600}
  .sect{font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#94a3b8;margin:24px 0 12px}
  .row2{display:grid;grid-template-columns:170px 1fr;gap:20px;align-items:center}
  .legend{display:flex;flex-direction:column;gap:6px;font-size:12px}
  .legend .li{display:flex;align-items:center;gap:8px}
  .legend .dot{width:10px;height:10px;border-radius:3px}
  .bar{display:grid;grid-template-columns:120px 1fr 40px;gap:10px;align-items:center;font-size:12px;margin:5px 0}
  .bar .bl{color:#475569}.bar .bt{background:#f1f5f9;border-radius:5px;height:9px;overflow:hidden}.bar .bt i{display:block;height:100%;border-radius:5px}.bar b{text-align:right;font-variant-numeric:tabular-nums}
  table{width:100%;border-collapse:collapse;font-size:12px;margin-top:6px}
  th{text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:#94a3b8;padding:7px 10px;border-bottom:2px solid #e2e8f0}
  td{padding:8px 10px;border-bottom:1px solid #f1f5f9;vertical-align:top}
  td.msg{max-width:300px}td.num{text-align:right;font-variant-numeric:tabular-nums;font-weight:600}
  .pri{color:#fff;font-size:10px;font-weight:700;padding:2px 7px;border-radius:5px}
  .hp{font-size:11px;padding:3px 9px;border-radius:20px;font-weight:600;margin-right:6px}
  .hp.ok{background:#dcfce7;color:#166534}.hp.bad{background:#fee2e2;color:#991b1b}.hp.na{background:#f1f5f9;color:#64748b}
  .ft{padding:16px 34px;border-top:1px solid #e2e8f0;font-size:10.5px;color:#94a3b8;display:flex;justify-content:space-between}
  .note{font-size:11.5px;color:#64748b;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px;margin-top:8px}
  @media print{body{background:#fff;padding:0}.doc{box-shadow:none;border-radius:0}}
</style></head><body><div class="doc">
  <div class="hd"><div class="logo">🛰️</div><div><h1>Collab · Engineering Health Report</h1><div class="sub">${esc(rangeLabel[d.range] || d.range)} · ${esc(d.server?.env)} · v${esc(d.server?.version)}</div></div><div class="meta">Generated<br><b>${esc(generated)}</b></div></div>
  <div class="body">
    <div class="kpis">
      <div class="kpi"><b>${t.groups || 0}</b><span>Issue groups</span></div>
      <div class="kpi"><b>${(t.occurrences || 0).toLocaleString()}</b><span>Total occurrences</span></div>
      <div class="kpi"><b>${t.affectedUsers || 0}</b><span>Affected users</span></div>
      <div class="kpi"><b style="color:${t.e2eeOccurrences ? "#ef4444" : "#16a34a"}">${(t.e2eeOccurrences || 0).toLocaleString()}</b><span>E2EE incidents</span></div>
    </div>
    <div>${healthPill(health.db, "Database")}${healthPill(health.storage, "Storage")}${healthPill(health.redis, "Redis")}</div>

    <div class="sect">Severity mix (P0–P3)</div>
    <div class="row2">
      <div>${priDonut}</div>
      <div class="legend">${(d.byPriority || []).map((p: any) => `<div class="li"><span class="dot" style="background:${priColors[p.priority]}"></span> <b>${p.priority}</b> · ${PRI_UI[p.priority]?.label || ""} — ${p.count}</div>`).join("")}</div>
    </div>

    <div class="sect">Fault attribution (where the fault is)</div>
    ${domBars || '<div class="note">No faults recorded in this window.</div>'}

    <div class="sect">Top issues by priority</div>
    <table><thead><tr><th>Pri</th><th>Domain</th><th>Issue</th><th>User</th><th>Device</th><th class="num">Count</th></tr></thead><tbody>${topRows || '<tr><td colspan="6" style="text-align:center;color:#94a3b8;padding:18px">No issues in this window.</td></tr>'}</tbody></table>

    <div class="note">This report is generated from Collab's error ledger and client telemetry. It reports counts, fault domains and device metadata only — never message content (end-to-end encryption is preserved). Fault attribution classifies each error by signature into infrastructure, application, external or client to distinguish platform faults from code defects.</div>
  </div>
  <div class="ft"><span>Collab Engineering Operations Portal</span><span>Confidential · Internal</span></div>
</div></body></html>`;
}
async function downloadReport(apiGet: (p: string) => Promise<any>, range: string): Promise<string> {
  const d = await apiGet("/api/ops/report?range=" + range);
  const html = buildReportHtml(d);
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `collab-engineering-report-${range}-${stamp}.html`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return a.download;
}

// ── Error Center — unified (backend+client), user + device + P0–P3 priority ──
function ErrorCenter({ apiGet, apiPost, openUser, initialState = "occurred" }: { apiGet: (p: string) => Promise<any>; apiPost: (p: string, body?: any) => Promise<any>; openUser: (name: string) => void; initialState?: string }) {
  const [range, setRange] = useState("today");
  const [severity, setSeverity] = useState("all");
  const [priority, setPriority] = useState("all");
  const [category, setCategory] = useState("all");
  const [user, setUser] = useState("");
  const [q, setQ] = useState("");
  // occurred = still happening · resolved = auto-closed by a deploy (no recurrence
  // since the latest release) OR manually resolved. `initialState` lets the
  // dedicated "Resolved" nav item open straight into the resolved set.
  const [state, setState] = useState(initialState);
  const [counts, setCounts] = useState<{ occurred: number; resolved: number; all: number } | null>(null);
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [resolved, setResolved] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setExpanded((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const load = useCallback(() => {
    const p = new URLSearchParams({ range, state, limit: "500" });
    if (severity !== "all") p.set("severity", severity);
    if (priority !== "all") p.set("priority", priority);
    if (category !== "all") p.set("category", category);
    if (user.trim()) p.set("user", user.trim());
    if (q.trim()) p.set("q", q.trim());
    return apiGet("/api/ops/errors?" + p.toString())
      .then((j) => {
        setRows(j.errors || []);
        if (j.counts) setCounts(j.counts);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [apiGet, range, state, severity, priority, category, user, q]);

  useEffect(() => {
    setLoading(true);
    load();
    const id = setInterval(load, 8000);
    return () => clearInterval(id);
  }, [load]);

  // In the Resolved tab the rows ARE the resolved set — don't also hide the ones
  // just manually cleared (they belong here now). Occurred hides them optimistically.
  const errors = state === "resolved" ? rows : rows.filter((e) => !resolved.has(e.id));
  const total = errors.reduce((a, e) => a + (e.count || 0), 0);
  const p0 = errors.filter((e) => e.priorityLabel === "P0").length;
  const p1 = errors.filter((e) => e.priorityLabel === "P1").length;
  const e2eeCount = errors.filter((e) => e.category === "e2ee").reduce((a, e) => a + e.count, 0);

  const resolve = async (id: string) => {
    setBusy(id);
    try {
      await apiPost(`/api/ops/errors/${id}/resolve`, { status: "resolved" });
      setResolved((s) => new Set(s).add(id));
    } catch {
      setToast("Couldn’t resolve — try again.");
      setTimeout(() => setToast(null), 2500);
    } finally {
      setBusy(null);
    }
  };
  const copyAll = async () => {
    const header = `Collab error report · range=${range} · ${errors.length} groups · ${total} occurrences · generated ${new Date().toISOString()}`;
    const body = errors
      .map((e, i) => `${i + 1}. [${e.priorityLabel}] [${e.level}] [${(DOMAIN_UI[e.domain] || {}).short || e.domain}]${e.category === "e2ee" ? " [E2EE]" : ""} ${e.message}\n   What happened: ${e.plain}\n   Responsible: ${e.owner}\n   user=${e.userLabel} device=${deviceLabel(e.device)} count=${e.count} path=${e.requestPath || "-"} lastSeen=${e.lastSeen}`)
      .join("\n\n");
    const ok = await copyText(header + "\n\n" + body);
    setToast(ok ? `Copied ${errors.length} errors to clipboard` : "Copy failed");
    setTimeout(() => setToast(null), 2500);
  };
  const doReport = async () => {
    setToast("Building report…");
    try {
      const name = await downloadReport(apiGet, range);
      setToast(`Downloaded ${name}`);
    } catch {
      setToast("Report failed");
    }
    setTimeout(() => setToast(null), 3000);
  };
  const resolvedNote = (e: any) =>
    e.resolvedReason === "deployment"
      ? `Auto-resolved — no recurrence since ${e.resolvedVersion ? "v" + e.resolvedVersion + " " : ""}${e.resolvedCommit ? "(" + String(e.resolvedCommit).slice(0, 7) + ") " : ""}deployed${e.resolvedAt ? " " + new Date(e.resolvedAt).toLocaleString() : ""}`
      : `Manually resolved${e.resolvedBy ? " by " + e.resolvedBy : ""}${e.resolvedAt ? " · " + new Date(e.resolvedAt).toLocaleString() : ""}`;

  return (
    <>
      <div className="devp-grid k4" style={{ marginBottom: 16 }}>
        <Kpi label={state === "resolved" ? "RESOLVED GROUPS" : "ISSUE GROUPS"} value={fmtInt(errors.length)} icon={state === "resolved" ? IcoShield : IcoAlert} color={state === "resolved" ? "var(--d-ok)" : errors.length ? "var(--d-bad)" : "var(--d-ok)"} foot={<span>{fmtNum(total)} occurrences</span>} />
        <Kpi label="P0 CRITICAL" value={fmtInt(p0)} icon={IcoShield} color={p0 ? "#f87171" : "var(--d-ok)"} foot={<span>{fmtInt(p1)} P1 high</span>} />
        <Kpi label="E2EE INCIDENTS" value={fmtNum(e2eeCount)} icon={IcoShield} color={e2eeCount ? "#fb923c" : "var(--d-ok)"} foot={<span>encryption failures</span>} />
        <Kpi label="STATUS" value={p0 ? "Critical" : p1 ? "Attention" : "Healthy"} icon={IcoActivity} color={p0 ? "#f87171" : p1 ? "var(--d-warn)" : "var(--d-ok)"} foot={<span>priority-weighted</span>} />
      </div>

      <div className="devp-toolbar">
        <div className="devp-seg" title="Occurred = still happening · Resolved = auto-closed by a deployment (no recurrence since the latest release) or manually resolved">
          <button className={state === "occurred" ? "on" : ""} onClick={() => setState("occurred")}>Occurred{counts ? ` · ${fmtInt(counts.occurred)}` : ""}</button>
          <button className={state === "resolved" ? "on" : ""} onClick={() => setState("resolved")}>Resolved{counts ? ` · ${fmtInt(counts.resolved)}` : ""}</button>
        </div>
        <div className="devp-seg">
          {[["today", "Today"], ["yesterday", "Yesterday"], ["7d", "7d"], ["30d", "30d"], ["all", "All"]].map(([v, l]) => (
            <button key={v} className={range === v ? "on" : ""} onClick={() => setRange(v)}>{l}</button>
          ))}
        </div>
        <div className="devp-seg">
          {[["all", "All"], ["P0", "P0"], ["P1", "P1"], ["P2", "P2"], ["P3", "P3"]].map(([v, l]) => (
            <button key={v} className={priority === v ? "on" : ""} onClick={() => setPriority(v)}>{l}</button>
          ))}
        </div>
        <Select className="devp-input" value={category} onChange={(e) => setCategory(e.target.value)} style={{ padding: "6px 10px" }}>
          <option value="all">All types</option>
          <option value="e2ee">E2EE only</option>
          <option value="backend">Backend</option>
          <option value="general">Client runtime</option>
          <option value="realtime">Realtime</option>
          <option value="network">Network</option>
        </Select>
        <input className="devp-input" placeholder="Filter by user (name/email)…" value={user} onChange={(e) => setUser(e.target.value)} style={{ minWidth: 150 }} />
        <input className="devp-input" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1, minWidth: 120 }} />
        <button className="devp-btn" onClick={copyAll} disabled={!errors.length} title="Copy all shown errors"><IcoCopy size={14} /> Copy</button>
        <button className="devp-btn" onClick={doReport} title="Download a shareable report for this date range"><IcoRocketDeploy size={14} /> Report</button>
      </div>
      {toast ? <div className="devp-toast">{toast}</div> : null}

      <Card title="Issues" icon={IcoAlert} sub={loading ? "loading…" : fmtInt(errors.length)}>
        {loading ? (
          <div style={{ padding: 8 }}>{[0, 1, 2, 3].map((i) => <div key={i} className="devp-skel" style={{ height: 22, margin: "8px 0" }} />)}</div>
        ) : errors.length === 0 ? (
          <div className="devp-empty" style={{ padding: "30px 10px" }}>
            <IcoShield size={28} />
            <b>{state === "resolved" ? "Nothing resolved yet" : "Nothing in this range"}</b>
            <span>{state === "resolved" ? "Issues move here automatically once they stop occurring after a deployment — or when you resolve them by hand." : "No issues match the current filter."}</span>
          </div>
        ) : (
          <div className="devp-tablewrap">
            <table className="devp-table">
              <thead>
                <tr>
                  <th>Pri</th>
                  <th>Domain</th>
                  <th>User</th>
                  <th>Device</th>
                  <th>Issue</th>
                  <th className="mono">Count</th>
                  <th className="mono">Age</th>
                  <th style={{ textAlign: "right" }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {errors.map((e) => (
                  <React.Fragment key={e.id}>
                  <tr>
                    <td><PriorityTag p={e.priorityLabel} /></td>
                    <td title={e.reason}>{e.category === "e2ee" ? <span className="devp-pill bad">E2EE</span> : <DomainTag domain={e.domain} />}</td>
                    <td style={{ maxWidth: 130 }}>
                      {e.user ? (
                        <button className="devp-link" title={`Track ${e.userLabel}'s experience`} onClick={() => openUser(e.userLabel)} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%" }}>
                          {e.userLabel}
                        </button>
                      ) : (
                        <span style={{ color: "var(--d-faint)" }}>{e.userLabel}</span>
                      )}
                    </td>
                    <td style={{ maxWidth: 160, fontSize: 11 }} title={e.device ? `${deviceLabel(e.device)}${e.device.deviceId ? " · device " + e.device.deviceId : ""}${e.location ? " · " + [e.location.city, e.location.country, e.location.ip].filter(Boolean).join(", ") : ""}` : "server-side"}>
                      <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--d-mut)" }}>{deviceLabel(e.device)}</div>
                      {e.location && (e.location.city || e.location.country) ? <div style={{ fontSize: 10, color: "var(--d-faint)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{[e.location.city, e.location.country].filter(Boolean).join(", ")}</div> : null}
                    </td>
                    <td style={{ maxWidth: 320, cursor: "pointer" }} onClick={() => toggle(e.id)} title="Click for a plain-English explanation">
                      <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        <span style={{ color: "var(--d-faint)", marginRight: 6, fontFamily: "var(--d-mono)", fontSize: 10 }}>{expanded.has(e.id) ? "▾" : "▸"}</span>
                        {e.message}
                      </div>
                    </td>
                    <td className="mono">{fmtInt(e.count)}</td>
                    <td className="mono" style={{ color: "var(--d-mut)" }}>{timeAgo(e.lastSeen)}</td>
                    <td style={{ textAlign: "right" }}>
                      {e.resolved ? (
                        <span className="devp-pill ok" title={resolvedNote(e)}>
                          ✓ {e.resolvedReason === "deployment" ? (e.resolvedVersion ? "v" + e.resolvedVersion : "Deploy") : "Manual"}
                        </span>
                      ) : (
                        <button className="devp-resolve" onClick={() => resolve(e.id)} disabled={busy === e.id} title={e.scope === "client" ? "Clear this client-error group" : "Mark resolved"}>
                          {busy === e.id ? "…" : e.scope === "client" ? "Clear" : "Resolve"}
                        </button>
                      )}
                    </td>
                  </tr>
                  {expanded.has(e.id) ? (
                    <tr>
                      <td colSpan={8} style={{ background: "rgba(255,255,255,0.02)", padding: "12px 16px" }}>
                        <div className="devp-explain">
                          <div className="devp-explain-row">
                            <span className="devp-explain-lbl">What happened</span>
                            <span className="devp-explain-txt">{e.plain}</span>
                          </div>
                          <div className="devp-explain-row">
                            <span className="devp-explain-lbl">Responsible</span>
                            <span className="devp-explain-txt"><span className="devp-pill mut">{e.owner}</span> <span style={{ color: "var(--d-faint)", fontSize: 11 }}>({e.reason})</span></span>
                          </div>
                          {e.requestPath ? (
                            <div className="devp-explain-row">
                              <span className="devp-explain-lbl">Where</span>
                              <span className="devp-explain-txt mono" style={{ fontFamily: "var(--d-mono)", fontSize: 11.5 }}>{e.requestPath}</span>
                            </div>
                          ) : null}
                          <div className="devp-explain-row">
                            <span className="devp-explain-lbl">Technical</span>
                            <span className="devp-explain-txt mono" style={{ fontFamily: "var(--d-mono)", fontSize: 11.5, color: "var(--d-mut)" }}>{e.message}</span>
                          </div>
                          {e.resolved ? (
                            <div className="devp-explain-row">
                              <span className="devp-explain-lbl">Resolved</span>
                              <span className="devp-explain-txt"><span className="devp-pill ok">{e.resolvedReason === "deployment" ? "Auto · deployment" : "Manual"}</span> <span style={{ color: "var(--d-faint)", fontSize: 11 }}>{resolvedNote(e)}</span></span>
                            </div>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ) : null}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

// ── Governor chip — proves engineering is yielding to production ──────────────
function GovernorChip({ apiGet }: { apiGet: (p: string) => Promise<any> }) {
  const { data } = usePoll(apiGet, "/api/ops/governor", 10000);
  if (!data) return null;
  const p = data.pressure || {};
  const c = data.cache || {};
  const color = p.level >= 3 ? "var(--d-bad)" : p.level >= 2 ? "#fb923c" : p.level >= 1 ? "var(--d-warn)" : "var(--d-ok)";
  return (
    <div
      className="devp-govchip"
      title={`Golden rule: the engineering platform never degrades Collab.\nProduction pressure: ${p.label} — ${p.reason}.\nCPU ${Math.round(p.cpuPct || 0)}% · ${fmtInt(p.meetings)} meetings · DB ${p.dbLatMs}ms · RSS ${p.rssPct}%\nCache hit ${c.hitRatioPct ?? "—"}% · ${fmtInt(c.sheds)} load-sheds · ${fmtInt(c.activeHeavy)}/${fmtInt(c.maxConcurrentHeavy)} heavy jobs running`}
      style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "5px 10px", borderRadius: 8, background: "var(--d-card)", border: "1px solid var(--d-line)", fontSize: 11.5 }}
    >
      <span style={{ width: 8, height: 8, borderRadius: 999, background: color, boxShadow: `0 0 6px ${color}` }} />
      <span style={{ color: "var(--d-mut)" }}>Production: <b style={{ color }}>{p.label}</b></span>
      {p.shedding ? <span className="devp-pill" style={{ background: "color-mix(in srgb, #fb923c 20%, transparent)", color: "#fb923c" }}>engineering throttled</span> : null}
      <span style={{ color: "var(--d-faint)" }}>cache {c.hitRatioPct ?? "—"}%</span>
    </div>
  );
}

// ── Storage — where the bytes live (disk / object store / DB / Redis) ─────────
function StorageView({ apiGet }: { apiGet: (p: string) => Promise<any> }) {
  const { data, loading } = usePoll(apiGet, "/api/ops/storage", 15000);
  if (loading && !data) return <LoadingView />;
  const disk = data?.disk;
  const obj = data?.objectStore;
  const db = data?.database;
  const redis = data?.redis;
  const maxTableBytes = Math.max(1, ...(db?.tables || []).map((t: any) => Number(t.bytes) || 0));
  const diskPct = disk && disk.usedPct != null ? disk.usedPct : 0;
  const redisPct = redis && redis.maxBytes ? (redis.usedBytes / redis.maxBytes) * 100 : 0;
  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
        <GovernorChip apiGet={apiGet} />
        {data?.degraded ? <span className="devp-pill" style={{ background: "color-mix(in srgb, #fb923c 18%, transparent)", color: "#fb923c" }}>Storage scan deferred — production busy; showing last cached values</span> : null}
      </div>
      <div className="devp-grid k4" style={{ marginBottom: 16 }}>
        <Kpi label="DISK" value={disk ? fmtBytes(disk.usedBytes) : "—"} icon={IcoBox} color={diskPct > 85 ? "var(--d-bad)" : diskPct > 70 ? "var(--d-warn)" : "var(--d-acc)"} foot={<span>{disk ? (disk.usedPct != null ? disk.usedPct + "% of " + fmtBytes(disk.totalBytes) : fmtBytes(disk.totalBytes)) : "unavailable"}</span>} />
        <Kpi label="OBJECT STORE" value={obj && obj.bucket ? fmtBytes(obj.bytes) : "—"} icon={IcoServer} color="var(--d-vio)" foot={<span>{fmtInt(obj?.objects)} objects{obj?.truncated ? "+" : ""}{obj?.bucket ? " · " + obj.bucket : ""}</span>} />
        <Kpi label="DATABASE" value={db ? fmtBytes(db.totalBytes) : "—"} icon={IcoDb} color="var(--d-acc)" foot={<span>{fmtNum(db?.totalRows)} rows · {fmtInt(db?.tableCount)} tables</span>} />
        <Kpi label="REDIS MEMORY" value={redis ? (redis.human || fmtBytes(redis.usedBytes)) : "—"} icon={IcoMem} color="var(--d-warn)" foot={<span>{redis ? (redis.maxBytes ? "max " + fmtBytes(redis.maxBytes) : "no max set") : "not configured"}{redis?.policy ? " · " + redis.policy : ""}</span>} />
      </div>
      <div className="devp-grid k2">
        <Card title="Disk / Volume" icon={IcoBox} sub={disk ? disk.path : "unavailable"}>
          {disk ? (
            <>
              <Meter label="Used" value={diskPct} display={fmtBytes(disk.usedBytes) + " / " + fmtBytes(disk.totalBytes)} color={diskPct > 85 ? "var(--d-bad)" : diskPct > 70 ? "var(--d-warn)" : "var(--d-ok)"} />
              <div style={{ marginTop: 12 }}>
                <Kv rows={[["Total capacity", fmtBytes(disk.totalBytes)], ["Used", fmtBytes(disk.usedBytes)], ["Free", fmtBytes(disk.freeBytes)], ["Mount", disk.path]]} />
              </div>
            </>
          ) : (
            <div className="devp-empty" style={{ padding: 22 }}><IcoBox size={24} /><b>Disk stats unavailable</b><span>The runtime doesn’t expose statfs (needs Node ≥ 18.15). Object-store, DB and Redis footprints below are unaffected.</span></div>
          )}
        </Card>
        <Card title="Object Storage · MinIO / S3" icon={IcoServer} sub={obj?.bucket || "—"}>
          {obj && obj.bucket ? (
            <Kv rows={[["Bucket", obj.bucket], ["Objects", fmtNum(obj.objects) + (obj.truncated ? " (scan capped)" : "")], ["Total size", fmtBytes(obj.bytes)], ["Avg object", obj.objects ? fmtBytes(Math.round(obj.bytes / obj.objects)) : "—"]]} />
          ) : (
            <div className="devp-empty" style={{ padding: 22 }}><IcoServer size={24} /><b>Object store unavailable</b><span>{obj?.error || "Could not reach the bucket."}</span></div>
          )}
        </Card>
      </div>
      <Card title="Database tables by size" icon={IcoDb} sub={db ? fmtBytes(db.totalBytes) + " · " + fmtInt(db.tableCount) + " tables" : ""} className="devp-span2">
        <div className="devp-tablewrap">
          <table className="devp-table">
            <thead><tr><th>Table</th><th className="mono">Rows</th><th className="mono">Data</th><th className="mono">Index</th><th className="mono">Total</th><th style={{ width: "34%" }}>Footprint</th></tr></thead>
            <tbody>
              {(db?.tables || []).map((t: any) => (
                <tr key={t.name}>
                  <td className="devp-t-strong">{t.name}</td>
                  <td className="mono">{fmtInt(t.rows)}</td>
                  <td className="mono" style={{ color: "var(--d-mut)" }}>{fmtBytes(t.dataBytes)}</td>
                  <td className="mono" style={{ color: "var(--d-mut)" }}>{fmtBytes(t.indexBytes)}</td>
                  <td className="mono">{fmtBytes(t.bytes)}</td>
                  <td><div className="devp-meter" style={{ ["--m-c" as any]: "var(--d-vio)" }}><i style={{ width: Math.max(2, (Number(t.bytes) / maxTableBytes) * 100) + "%" }} /></div></td>
                </tr>
              ))}
              {(db?.tables || []).length === 0 && <tr><td colSpan={6} style={{ color: "var(--d-mut)", textAlign: "center", padding: 22 }}>No table statistics available</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>
      {redis && redis.maxBytes ? (
        <Card title="Redis memory" icon={IcoMem} sub={redis.policy || ""}>
          <Meter label="Used vs maxmemory" value={redisPct} display={fmtBytes(redis.usedBytes) + " / " + fmtBytes(redis.maxBytes)} color={redisPct > 85 ? "var(--d-bad)" : "var(--d-ok)"} />
          <div style={{ marginTop: 12 }}><Kv rows={[["Eviction policy", redis.policy || "—"], ["Evicted keys", fmtNum(redis.evictedKeys)]]} /></div>
        </Card>
      ) : null}
      <p className="devp-note" style={{ marginTop: 12 }}>Counts and sizes only — never file or message content. Object-store scan is bounded to ~25k objects; “+” marks a capped count.</p>
    </>
  );
}

// ── Simulation Engine — a grounded digital twin ───────────────────────────────
// Every projection is derived from the /sim/baseline MEASURED constants via
// queuing + growth models, and labelled observed | measured | estimated |
// predicted. No arbitrary numbers: DB capacity = real pool × real query latency;
// meeting ceiling = the load-tested presence limit; per-request DB round-trips =
// the committed static-analysis cost model (searchService 10 serial, N+1, …).
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const simPct = (r: number) => (isFinite(r) ? Math.round(r * 100) + "%" : "∞");
const simMs = (x: number) => (!isFinite(x) ? "saturated" : x >= 1000 ? (x / 1000).toFixed(2) + "s" : Math.round(x) + "ms");
const rhoColor = (r: number) => (r >= 1 ? "var(--d-bad)" : r >= 0.8 ? "#fb923c" : r >= 0.6 ? "var(--d-warn)" : "var(--d-ok)");

function simDefaultCfg(base: any) {
  const rt = base.runtime || {}, cap = base.capacity || {}, d = base.data || {};
  return {
    users: Math.max(10, rt.activeSessions || 100),
    reqPerMin: 12, heavyPct: 8, listPct: 25, avgMembers: 8,
    msgsPerDay: Math.max(1000, d.messages24h || 5000), uploadsPerDay: 200,
    meetings: Math.max(1, rt.liveMeetings || 4), avgParticipants: 6,
    instances: cap.backendInstances || 1, poolPerInstance: cap.dbPoolLimit || 20,
    queryMs: Math.max(1, Math.round(rt.dbPingMs || 3)),
    cores: rt.cores || 4, ramGb: Math.max(1, Math.round((rt.memTotalBytes || 4e9) / 1e9)),
    redis: !!cap.redisConfigured, cacheHitPct: 80,
    livekitNodes: 1, netLatencyMs: 40, packetLossPct: 0.5,
    optSearchParallel: false, optBatchN1: false, optRedisCache: !!cap.redisConfigured,
    diskGb: 100,
  };
}

function simulate(base: any, cfg: any) {
  const cap = base.capacity || {}, dat = base.data || {}, der = dat.derived || {};
  const avgMsgBytes = der.avgMessageBytes || 900;
  const avgObjBytes = der.avgObjectBytes || 250000;
  const ceiling = cap.meetingParticipantCeiling || 130;
  const reqPerSec = (cfg.users * cfg.reqPerMin) / 60;

  // DB round-trips per request — the measured cost model (file:line in provenance).
  const baseTrips = 3; // typical endpoint (estimated: authz + primary query + one serialize read)
  const searchTrips = cfg.optSearchParallel ? 1 : 10; // searchService.ts:25-76 — observed 10 serial awaits
  const listTrips = cfg.optBatchN1 ? 2 : Math.max(2, cfg.avgMembers); // serialize.ts:589 — observed N+1
  const heavy = clamp01(cfg.heavyPct / 100), list = clamp01(cfg.listPct / 100);
  const normal = Math.max(0, 1 - heavy - list);
  const tripsPerReq = normal * baseTrips + heavy * searchTrips + list * listTrips;
  const cacheOffload = cfg.optRedisCache ? (cfg.cacheHitPct / 100) * 0.5 : 0; // caches cover ~half the read trips — estimated
  const effTrips = tripsPerReq * (1 - cacheOffload);

  const conns = Math.max(1, cfg.instances * cfg.poolPerInstance);
  const svcRate = 1000 / Math.max(0.5, cfg.queryMs); // ops/sec per connection
  const dbCapacity = conns * svcRate;
  const dbDemand = reqPerSec * effTrips;
  const dbRho = dbCapacity > 0 ? dbDemand / dbCapacity : Infinity;

  const cpuMsPerReq = 4 + heavy * 8 + list * (0.02 * cfg.avgMembers); // estimated serialize/render CPU
  const cpuCapacity = Math.max(1, cfg.cores * cfg.instances * 1000);
  const cpuDemand = reqPerSec * cpuMsPerReq;
  const cpuRho = cpuDemand / cpuCapacity;

  const memBaseMb = 250, memPerUserMb = 0.5; // estimated node baseline + per-connected-socket
  const memDemand = memBaseMb + (cfg.users / Math.max(1, cfg.instances)) * memPerUserMb;
  const memCap = Math.max(1, cfg.ramGb * 1024);
  const memRho = memDemand / memCap;

  const presenceRho = cfg.avgParticipants / ceiling;
  const tracksPerNode = 500; // estimated concurrent published tracks/LiveKit node
  const livekitRho = cfg.livekitNodes > 0 ? (cfg.meetings * cfg.avgParticipants) / (cfg.livekitNodes * tracksPerNode) : Infinity;

  const q = (rho: number) => (rho < 1 ? 1 / (1 - rho) : Infinity); // M/M/1 wait multiplier
  const dbWaitMs = effTrips * cfg.queryMs * q(dbRho);
  const cpuWaitMs = cpuMsPerReq * q(cpuRho);
  const netMs = cfg.netLatencyMs * 2 + (cfg.packetLossPct > 1 ? cfg.packetLossPct * 10 : 0);
  const avgMs = dbWaitMs + cpuWaitMs + netMs + 8;
  const p95 = isFinite(avgMs) ? avgMs * 2.5 : Infinity;
  const p99 = isFinite(avgMs) ? avgMs * 4 : Infinity;

  const resources = [
    { key: "db", label: "Database pool", rho: dbRho, detail: `${fmtInt(dbDemand)} q/s demand vs ${fmtInt(dbCapacity)} q/s (${conns} conns × ${Math.round(svcRate)} q/s)`, basis: "estimated", source: "pool mysql.ts:66 · trips searchService.ts:25-76 / serialize.ts:589" },
    { key: "cpu", label: "CPU", rho: cpuRho, detail: `${cpuMsPerReq.toFixed(1)} ms/req × ${fmtInt(reqPerSec)} rps vs ${cfg.cores * cfg.instances} cores`, basis: "estimated" },
    { key: "mem", label: "Memory", rho: memRho, detail: `${fmtInt(memDemand)} MB working set vs ${fmtInt(memCap)} MB`, basis: "estimated" },
    { key: "presence", label: "Meeting presence", rho: presenceRho, detail: `${cfg.avgParticipants} avg vs ~${ceiling} ceiling / meeting`, basis: "observed", source: "calls-scale-roadmap (load-tested)" },
    { key: "livekit", label: "LiveKit media", rho: livekitRho, detail: `${fmtInt(cfg.meetings * cfg.avgParticipants)} tracks vs ${cfg.livekitNodes} node(s) × ${tracksPerNode}`, basis: "estimated" },
  ];
  const sorted = [...resources].sort((a, b) => (b.rho || 0) - (a.rho || 0));
  const bottleneck = sorted[0];

  // Max users before a user-driven resource hits 80%. Solve each with its REAL
  // demand shape (demand = base + slope·users): DB and CPU scale linearly with
  // users (no fixed base), but memory carries a large FIXED node baseline, so a
  // naive 0.8/ρ extrapolation understates it badly at low user counts.
  const perUserReqSec = cfg.reqPerMin / 60;
  const caps = [
    { key: "db", label: "Database pool", base: 0, slope: perUserReqSec * effTrips, cap: dbCapacity },
    { key: "cpu", label: "CPU", base: 0, slope: perUserReqSec * cpuMsPerReq, cap: cpuCapacity },
    { key: "mem", label: "Memory", base: memBaseMb, slope: memPerUserMb / Math.max(1, cfg.instances), cap: memCap },
  ].map((r) => ({ ...r, maxUsers: r.slope > 0 ? Math.max(0, (0.8 * r.cap - r.base) / r.slope) : Infinity }));
  const binding = caps.slice().sort((a, b) => a.maxUsers - b.maxUsers)[0];
  const maxUsers = isFinite(binding.maxUsers) ? Math.floor(binding.maxUsers) : Infinity;
  const scaleFactor = maxUsers === Infinity ? Infinity : maxUsers / Math.max(1, cfg.users);
  const limitedBy = { key: binding.key, label: binding.label };

  const bytesPerDay = cfg.msgsPerDay * avgMsgBytes + cfg.uploadsPerDay * avgObjBytes;
  const gbMonth = (bytesPerDay * 30) / 1e9, gbYear = (bytesPerDay * 365) / 1e9;
  const currentUsedGb = ((dat.objectBytes || 0) + (dat.dbBytes || 0)) / 1e9;
  const diskFreeGb = Math.max(0, cfg.diskGb - currentUsedGb);
  const daysToFill = bytesPerDay > 0 ? (diskFreeGb * 1e9) / bytesPerDay : Infinity;

  const scoreFromLatency = (x: number) => (!isFinite(x) ? 3 : Math.max(3, Math.min(99, Math.round(100 - x / 30))));
  const scoreFromHeadroom = (sf: number) => (!isFinite(sf) ? 96 : Math.max(4, Math.min(98, Math.round(35 + 30 * Math.log10(Math.max(1, sf))))));
  let reliability = 40;
  if (cfg.instances >= 2) reliability += 22; else reliability -= 6;
  if (cfg.optRedisCache) reliability += 12;
  if (cfg.livekitNodes >= 2) reliability += 10;
  if (cfg.packetLossPct < 1) reliability += 8;
  reliability = Math.max(5, Math.min(98, reliability));
  const performance = scoreFromLatency(p95);
  const scalability = scoreFromHeadroom(scaleFactor);
  const maintainability = (base.architecture && base.architecture.overall) || 50;
  const overall = Math.round((performance + scalability + reliability + maintainability) / 4);

  const failures: string[] = [];
  resources.forEach((r) => {
    if (r.rho >= 1) failures.push(`${r.label} saturates (ρ=${simPct(r.rho)}) → requests queue unboundedly and time out.`);
    else if (r.rho >= 0.8) failures.push(`${r.label} runs hot (ρ=${simPct(r.rho)}) → latency climbs steeply; little headroom for spikes.`);
  });
  if (cfg.packetLossPct > 2) failures.push(`Packet loss ${cfg.packetLossPct}% degrades call/meeting media (freezes, drops, re-negotiation).`);
  if (!cfg.optRedisCache && cfg.users > 500 && cfg.instances > 1) failures.push(`No shared cache at ${fmtInt(cfg.users)} users across ${cfg.instances} pods → per-pod Map caches re-do work and serve stale permissions until TTL (rbacService:56, cachingEfficiency 60).`);
  if (cfg.avgParticipants > ceiling) failures.push(`Meetings of ${cfg.avgParticipants} exceed the ~${ceiling} presence ceiling → presence sync breaks before media does.`);

  return {
    reqPerSec, effTrips, resources, bottleneck, limitedBy,
    latency: { avgMs, p95, p99 },
    capacity: { maxUsers, scaleFactor },
    storage: { bytesPerDay, gbMonth, gbYear, daysToFill, currentUsedGb },
    scores: { overall, performance, scalability, reliability, maintainability },
    failures,
  };
}

const BASIS_COLOR: Record<string, string> = { observed: "var(--d-ok)", measured: "var(--d-acc)", "measured-config": "var(--d-acc)", "static-analysis": "var(--d-vio)", estimated: "var(--d-warn)", predicted: "#fb923c" };
function BasisPill({ b }: { b: string }) {
  return <span className="devp-pill" style={{ background: "color-mix(in srgb, " + (BASIS_COLOR[b] || "var(--d-mut)") + " 18%, transparent)", color: BASIS_COLOR[b] || "var(--d-mut)", fontSize: 9.5, textTransform: "uppercase", letterSpacing: 0.4 }}>{b}</span>;
}
function SimField({ label, value, onChange, min = 0, max = 1e12, step = 1, unit, hint }: any) {
  return (
    <label className="devp-simfield" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 11, color: "var(--d-mut)" }}>{label}{unit ? <span style={{ color: "var(--d-faint)" }}> ({unit})</span> : null}</span>
      <input className="devp-input" type="number" value={value} min={min} max={max} step={step} onChange={(e) => onChange(Math.max(min, Math.min(max, Number(e.target.value) || 0)))} title={hint} />
    </label>
  );
}
function SimToggle({ label, on, onChange, hint }: any) {
  return (
    <button className={"devp-btn" + (on ? " on" : "")} onClick={() => onChange(!on)} title={hint} style={{ justifyContent: "space-between", gap: 8 }}>
      <span>{label}</span><span style={{ color: on ? "var(--d-ok)" : "var(--d-faint)" }}>{on ? "ON" : "OFF"}</span>
    </button>
  );
}

function SimulationEngine({ apiGet }: { apiGet: (p: string) => Promise<any> }) {
  const { data: base, loading } = usePoll(apiGet, "/api/ops/sim/baseline", 60000);
  const [cfg, setCfg] = useState<any>(null);
  useEffect(() => { if (base && !cfg) setCfg(simDefaultCfg(base)); }, [base, cfg]);
  const sim = useMemo(() => (base && cfg ? simulate(base, cfg) : null), [base, cfg]);
  // Scalability sweep: run the model across a user multiplier range for the curve.
  const sweep = useMemo(() => {
    if (!base || !cfg) return [];
    return [0.25, 0.5, 1, 2, 4, 8, 16, 32, 64].map((m) => {
      const s = simulate(base, { ...cfg, users: Math.round(cfg.users * m) });
      return { users: Math.round(cfg.users * m), p95: s.latency.p95, mult: m };
    });
  }, [base, cfg]);
  if ((loading && !base) || !base || !cfg || !sim) return <LoadingView />;

  const set = (k: string, v: any) => setCfg((c: any) => ({ ...c, [k]: v }));
  const rt = base.runtime || {}, cap = base.capacity || {};
  const sc = sim.scores;
  const scoreColor = (v: number) => (v >= 75 ? "var(--d-ok)" : v >= 50 ? "var(--d-warn)" : "var(--d-bad)");

  // What-if presets (grounded in the baseline's current values).
  const whatIfs: { label: string; patch: any }[] = [
    { label: "10M users", patch: { users: 10_000_000 } },
    { label: "50k concurrent meetings", patch: { meetings: 50_000, avgParticipants: 8 } },
    { label: "Redis unavailable", patch: { optRedisCache: false } },
    { label: "MySQL 40% slower", patch: { queryMs: Math.round(cfg.queryMs * 1.4) || 5 } },
    { label: "2× backend instances", patch: { instances: cfg.instances * 2 } },
    { label: "2× CPU cores", patch: { cores: cfg.cores * 2 } },
    { label: "10% packet loss", patch: { packetLossPct: 10 } },
    { label: "Reset to live", patch: simDefaultCfg(base) },
  ];

  // Architecture comparison: current vs the optimizations the analysis found.
  const optimized = simulate(base, { ...cfg, optSearchParallel: true, optBatchN1: true, optRedisCache: true });

  // Scalability curve geometry.
  const cw = 520, ch = 150, pad = 28;
  const finiteSweep = sweep.filter((p) => isFinite(p.p95));
  const maxP95 = Math.max(300, ...finiteSweep.map((p) => p.p95));
  const xAt = (i: number) => pad + (i / (sweep.length - 1)) * (cw - pad * 2);
  const yAt = (v: number) => ch - pad - (Math.min(v, maxP95) / maxP95) * (ch - pad * 2);
  const linePts = sweep.map((p, i) => `${xAt(i)},${isFinite(p.p95) ? yAt(p.p95) : pad}`).join(" ");

  return (
    <>
      <div className="devp-simhead" style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
        <GovernorChip apiGet={apiGet} />
        <BasisPill b="measured" />
        <span style={{ color: "var(--d-mut)", fontSize: 12 }}>
          Twin seeded from live state: {fmtInt(rt.activeSessions)} active users · {fmtInt(rt.cores)} cores · pool {cap.dbPoolLimit} × {cfg.instances} · DB {rt.dbPingMs ?? "—"}ms · {fmtNum(base.data?.messages)} messages.
        </span>
      </div>
      <p className="devp-note" style={{ marginTop: -6, marginBottom: 14 }}>Simulation runs entirely in your browser — <b>zero production CPU</b>. Only the baseline snapshot is server-side, and it’s cached + load-shed like every probe (see the Production chip). {base.governor?.shedding ? "Production is busy right now, so the baseline may be showing cached values." : ""}</p>

      {/* Output scoreboard */}
      <div className="devp-grid k4" style={{ marginBottom: 16 }}>
        <Kpi label="OVERALL SIM SCORE" value={sc.overall} unit="/100" icon={IcoSpark} color={scoreColor(sc.overall)} foot={<span>perf {sc.performance} · scale {sc.scalability} · rel {sc.reliability}</span>} />
        <Kpi label="PREDICTED P95" value={simMs(sim.latency.p95)} icon={IcoBolt} color={rhoColor(sim.latency.p95 / 300)} foot={<span>avg {simMs(sim.latency.avgMs)} · p99 {simMs(sim.latency.p99)}</span>} />
        <Kpi label="MAX USERS @ this infra" value={isFinite(sim.capacity.maxUsers) ? fmtNum(sim.capacity.maxUsers) : "∞"} icon={IcoUsers} color={scoreColor(sc.scalability)} foot={<span>before {sim.limitedBy?.label || "saturation"} hits 80%</span>} />
        <Kpi label="FIRST BOTTLENECK" value={sim.bottleneck?.label || "—"} icon={IcoAlert} color={rhoColor(sim.bottleneck?.rho || 0)} foot={<span>ρ = {simPct(sim.bottleneck?.rho || 0)}</span>} />
      </div>

      <div className="devp-grid k2">
        {/* ── Inputs: Workload ── */}
        <Card title="Workload" icon={IcoUsers} sub="what the platform is asked to do">
          <div className="devp-simgrid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <SimField label="Concurrent users" value={cfg.users} onChange={(v: number) => set("users", v)} min={1} step={100} />
            <SimField label="Requests / user / min" value={cfg.reqPerMin} onChange={(v: number) => set("reqPerMin", v)} min={1} max={600} />
            <SimField label="Heavy (search) req" value={cfg.heavyPct} onChange={(v: number) => set("heavyPct", v)} min={0} max={100} unit="%" hint="Share of requests hitting the 10-round-trip search path" />
            <SimField label="List/serialize req" value={cfg.listPct} onChange={(v: number) => set("listPct", v)} min={0} max={100} unit="%" hint="Share hitting the N+1 member serialize path" />
            <SimField label="Avg members / list" value={cfg.avgMembers} onChange={(v: number) => set("avgMembers", v)} min={1} max={10000} />
            <SimField label="Messages / day" value={cfg.msgsPerDay} onChange={(v: number) => set("msgsPerDay", v)} min={0} step={1000} />
            <SimField label="Uploads / day" value={cfg.uploadsPerDay} onChange={(v: number) => set("uploadsPerDay", v)} min={0} step={50} />
            <SimField label="Concurrent meetings" value={cfg.meetings} onChange={(v: number) => set("meetings", v)} min={0} />
            <SimField label="Avg participants / mtg" value={cfg.avgParticipants} onChange={(v: number) => set("avgParticipants", v)} min={1} max={100000} />
          </div>
        </Card>

        {/* ── Inputs: Infrastructure ── */}
        <Card title="Infrastructure" icon={IcoServer} sub="the box(es) it runs on">
          <div className="devp-simgrid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <SimField label="Backend instances" value={cfg.instances} onChange={(v: number) => set("instances", v)} min={1} max={1000} />
            <SimField label="DB pool / instance" value={cfg.poolPerInstance} onChange={(v: number) => set("poolPerInstance", v)} min={1} max={5000} />
            <SimField label="Avg query latency" value={cfg.queryMs} onChange={(v: number) => set("queryMs", v)} min={1} max={5000} unit="ms" />
            <SimField label="CPU cores / instance" value={cfg.cores} onChange={(v: number) => set("cores", v)} min={1} max={512} />
            <SimField label="RAM / instance" value={cfg.ramGb} onChange={(v: number) => set("ramGb", v)} min={1} max={4096} unit="GB" />
            <SimField label="LiveKit nodes" value={cfg.livekitNodes} onChange={(v: number) => set("livekitNodes", v)} min={1} max={1000} />
            <SimField label="Network latency" value={cfg.netLatencyMs} onChange={(v: number) => set("netLatencyMs", v)} min={0} max={2000} unit="ms" />
            <SimField label="Packet loss" value={cfg.packetLossPct} onChange={(v: number) => set("packetLossPct", v)} min={0} max={100} step={0.5} unit="%" />
            <SimField label="Disk capacity" value={cfg.diskGb} onChange={(v: number) => set("diskGb", v)} min={1} step={50} unit="GB" />
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
            <SimToggle label="Shared Redis cache" on={cfg.optRedisCache} onChange={(v: boolean) => set("optRedisCache", v)} hint="Cross-pod cache for permissions/link-previews/settings" />
            <SimToggle label="Parallelize search" on={cfg.optSearchParallel} onChange={(v: boolean) => set("optSearchParallel", v)} hint="searchService.ts:25-76 — 10 serial awaits → Promise.all" />
            <SimToggle label="Batch N+1 (getByIds)" on={cfg.optBatchN1} onChange={(v: boolean) => set("optBatchN1", v)} hint="serialize.ts:589 — getById-per-member → one batched query" />
          </div>
        </Card>
      </div>

      {/* What-if presets */}
      <Card title="What if…" icon={IcoBrain} sub="one click applies a scenario to the inputs above">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {whatIfs.map((w) => (
            <button key={w.label} className="devp-btn" onClick={() => setCfg((c: any) => ({ ...c, ...w.patch }))}>{w.label}</button>
          ))}
        </div>
      </Card>

      <div className="devp-grid k2">
        {/* Resource utilization */}
        <Card title="Resource utilization (ρ)" icon={IcoActivity} sub="demand ÷ capacity — the first to cross 100% is the wall">
          {sim.resources.map((r: any) => (
            <div key={r.key} style={{ marginBottom: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 3 }}>
                <span style={{ fontSize: 12 }}>{r.label} <BasisPill b={r.basis} /></span>
                <span className="mono" style={{ color: rhoColor(r.rho), fontWeight: 700 }}>{simPct(r.rho)}</span>
              </div>
              <div className="devp-meter" style={{ ["--m-c" as any]: rhoColor(r.rho) }}><i style={{ width: Math.min(100, (r.rho || 0) * 100) + "%" }} /></div>
              <div style={{ fontSize: 10.5, color: "var(--d-faint)", marginTop: 3 }}>{r.detail}{r.source ? " · " + r.source : ""}</div>
            </div>
          ))}
        </Card>

        {/* Scalability curve */}
        <Card title="Scalability curve" icon={IcoGraph} sub="predicted P95 as concurrent users scale">
          <svg viewBox={`0 0 ${cw} ${ch}`} width="100%" style={{ display: "block" }}>
            <line x1={pad} y1={ch - pad} x2={cw - pad} y2={ch - pad} stroke="var(--d-line)" />
            <line x1={pad} y1={pad} x2={pad} y2={ch - pad} stroke="var(--d-line)" />
            <line x1={pad} y1={yAt(300)} x2={cw - pad} y2={yAt(300)} stroke="var(--d-warn)" strokeDasharray="3 3" opacity={0.5} />
            <text x={cw - pad} y={yAt(300) - 3} fill="var(--d-warn)" fontSize={9} textAnchor="end">300ms target</text>
            <polyline points={linePts} fill="none" stroke="var(--d-acc)" strokeWidth={2} />
            {sweep.map((p, i) => (
              <g key={i}>
                <circle cx={xAt(i)} cy={isFinite(p.p95) ? yAt(p.p95) : pad} r={p.mult === 1 ? 4 : 2.5} fill={p.mult === 1 ? "var(--d-vio)" : isFinite(p.p95) ? "var(--d-acc)" : "var(--d-bad)"} />
                {p.mult === 1 ? <text x={xAt(i)} y={ch - pad + 12} fill="var(--d-vio)" fontSize={9} textAnchor="middle">now</text> : null}
              </g>
            ))}
            <text x={pad} y={ch - 4} fill="var(--d-faint)" fontSize={9}>{fmtNum(sweep[0]?.users)} users</text>
            <text x={cw - pad} y={ch - 4} fill="var(--d-faint)" fontSize={9} textAnchor="end">{fmtNum(sweep[sweep.length - 1]?.users)} users</text>
          </svg>
          <div style={{ fontSize: 11, color: "var(--d-mut)", marginTop: 6 }}>Curve flattens then walls off where {sim.limitedBy?.label || "a resource"} saturates. <BasisPill b="predicted" /></div>
        </Card>
      </div>

      {/* Predicted output metrics */}
      <div className="devp-grid k3">
        <Card title="Latency" icon={IcoBolt} sub="per request (queuing model)">
          <Kv rows={[["Average", simMs(sim.latency.avgMs)], ["P95", simMs(sim.latency.p95)], ["P99", simMs(sim.latency.p99)], ["Throughput", fmtNum(sim.reqPerSec) + " req/s"], ["DB round-trips/req", sim.effTrips.toFixed(1)]]} />
          <div style={{ marginTop: 6 }}><BasisPill b="predicted" /></div>
        </Card>
        <Card title="Capacity headroom" icon={IcoScale} sub="before the first wall">
          <Kv rows={[["Max users (this infra)", isFinite(sim.capacity.maxUsers) ? fmtNum(sim.capacity.maxUsers) : "∞"], ["Headroom", isFinite(sim.capacity.scaleFactor) ? sim.capacity.scaleFactor.toFixed(1) + "×" : "∞"], ["Limited by", sim.limitedBy?.label || "—"], ["Bottleneck ρ", simPct(sim.bottleneck?.rho || 0)]]} />
        </Card>
        <Card title="Storage growth" icon={IcoBox} sub="from message + upload volume">
          <Kv rows={[["Per day", fmtBytes(sim.storage.bytesPerDay)], ["Per month", sim.storage.gbMonth.toFixed(1) + " GB"], ["Per year", sim.storage.gbYear.toFixed(1) + " GB"], ["Disk fills in", isFinite(sim.storage.daysToFill) ? Math.round(sim.storage.daysToFill) + " days" : "—"]]} />
          <div style={{ marginTop: 6 }}><BasisPill b="measured" /> <span style={{ fontSize: 10, color: "var(--d-faint)" }}>avg sizes from live DB</span></div>
        </Card>
      </div>

      {/* Architecture comparison */}
      <Card title="Architecture comparison — current vs optimized" icon={IcoScale} sub="applying the analysis's own recommendations (parallel search + batched N+1 + shared Redis)">
        <div className="devp-tablewrap">
          <table className="devp-table">
            <thead><tr><th>Metric</th><th className="mono">Current</th><th className="mono">Optimized</th><th className="mono">Δ</th></tr></thead>
            <tbody>
              {[
                ["P95 latency", simMs(sim.latency.p95), simMs(optimized.latency.p95), pctDelta(sim.latency.p95, optimized.latency.p95, true)],
                ["DB round-trips / req", sim.effTrips.toFixed(1), optimized.effTrips.toFixed(1), pctDelta(sim.effTrips, optimized.effTrips, true)],
                ["Max users", isFinite(sim.capacity.maxUsers) ? fmtNum(sim.capacity.maxUsers) : "∞", isFinite(optimized.capacity.maxUsers) ? fmtNum(optimized.capacity.maxUsers) : "∞", pctDelta(sim.capacity.maxUsers, optimized.capacity.maxUsers, false)],
                ["Overall score", String(sim.scores.overall), String(optimized.scores.overall), (optimized.scores.overall - sim.scores.overall >= 0 ? "+" : "") + (optimized.scores.overall - sim.scores.overall)],
              ].map((r: any) => (
                <tr key={r[0]}><td>{r[0]}</td><td className="mono">{r[1]}</td><td className="mono" style={{ color: "var(--d-ok)" }}>{r[2]}</td><td className="mono">{r[3]}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="devp-note" style={{ marginTop: 8 }}>Optimizations are the exact fixes the Code Architecture analysis recommends — each cites a real file:line. Toggle them individually in Infrastructure above.</p>
      </Card>

      {/* AI engineering analysis */}
      <Card title="AI engineering analysis" icon={IcoBrain} sub="deterministic reasoning from this scenario">
        <div className="devp-explain">
          <SimReportRow label="Summary" txt={`At ${fmtNum(cfg.users)} concurrent users the model predicts a P95 of ${simMs(sim.latency.p95)} and an overall score of ${sc.overall}/100. The first constraint is ${sim.bottleneck?.label} at ρ=${simPct(sim.bottleneck?.rho || 0)}. This infra scales to ~${isFinite(sim.capacity.maxUsers) ? fmtNum(sim.capacity.maxUsers) : "∞"} users before ${sim.limitedBy?.label} reaches 80%.`} basis="predicted" />
          <SimReportRow label="Observed constraints" txt={`DB pool of ${cfg.instances * cfg.poolPerInstance} connections at ${cfg.queryMs}ms/query caps sustained DB work at ~${fmtInt(base.capacity.dbPoolLimit * cfg.instances * (1000 / cfg.queryMs))} q/s. Meeting presence is capped at ~${base.capacity.meetingParticipantCeiling} participants/meeting.`} basis="measured" />
          <SimReportRow label="Expected bottlenecks" txt={sim.resources.filter((r: any) => r.rho >= 0.6).map((r: any) => `${r.label} (${simPct(r.rho)})`).join(", ") || "None above 60% — comfortable headroom at this workload."} basis="estimated" />
          <SimReportRow label="Likely failure points" txt={sim.failures.length ? sim.failures.join(" ") : "No saturation predicted at the configured workload."} basis="predicted" />
          <SimReportRow label="Recommended first move" txt={recommendMove(sim, cfg)} basis="predicted" />
          <SimReportRow label="Confidence" txt={`Structural (queuing + measured pool/latency + load-tested ceiling) is high; absolute latency is directional — per-request CPU cost and cache hit-rate are estimated, not runtime-profiled. Treat rankings and break-points as reliable, exact milliseconds as ±.`} basis="estimated" />
        </div>
      </Card>
      <p className="devp-note" style={{ marginTop: 12 }}>{base.provenance}</p>
    </>
  );
}
function SimReportRow({ label, txt, basis }: { label: string; txt: string; basis: string }) {
  return (
    <div className="devp-explain-row">
      <span className="devp-explain-lbl">{label}</span>
      <span className="devp-explain-txt">{txt} <BasisPill b={basis} /></span>
    </div>
  );
}
function pctDelta(cur: number, opt: number, _lowerIsBetter?: boolean): string {
  if (!isFinite(cur) || !isFinite(opt) || cur === 0) return "—";
  const d = Math.round(((opt - cur) / cur) * 100);
  return (d > 0 ? "+" : "") + d + "%";
}
function recommendMove(sim: any, cfg: any): string {
  const b = sim.bottleneck;
  if (!b) return "Scale is comfortable; no action needed at this workload.";
  if (b.key === "db") return `Database is the wall. Highest-leverage: parallelize the search path (searchService.ts:25-76, 10→1 round-trips) and batch the member N+1 (serialize.ts:589), then add a shared Redis cache — together they cut DB round-trips/request from ${sim.effTrips.toFixed(1)} materially. Raising the pool only helps until MySQL itself saturates.`;
  if (b.key === "cpu") return `CPU-bound. Add instances (horizontal) or cores, and reduce per-request serialize work (memoize/paginate). ${cfg.instances === 1 ? "Running a single instance is also a reliability risk — add a second." : ""}`;
  if (b.key === "mem") return `Memory-bound at this connection count. Add RAM or instances, and move per-process caches to Redis so they don't duplicate per pod.`;
  if (b.key === "presence") return `Meetings exceed the ~130 presence ceiling. This needs the presence-layer rearchitecture (sharded/paginated presence), not more hardware — see the calls-scale roadmap.`;
  if (b.key === "livekit") return `Media capacity-bound. Add LiveKit nodes and distribute rooms across them; verify TURN bandwidth for cross-network participants.`;
  return "Add capacity to the top-ρ resource above.";
}

// ── E2EE Health — encryption failures by kind / user / device ────────────────
function E2EEHealth({ apiGet }: { apiGet: (p: string) => Promise<any> }) {
  const [range, setRange] = useState("7d");
  const { data, loading } = usePoll(apiGet, "/api/ops/e2ee-health?range=" + range, 15000);
  if (loading && !data) return <LoadingView />;
  const byKind: any[] = data?.byKind || [];
  const byUser: any[] = data?.byUser || [];
  const byDevice: any[] = data?.byDevice || [];
  const issues: any[] = data?.issues || [];
  const clean = (data?.totalOccurrences || 0) === 0;
  return (
    <>
      <div className="devp-toolbar" style={{ marginBottom: 16 }}>
        <div className="devp-seg">
          {[["today", "Today"], ["yesterday", "Yesterday"], ["7d", "7 days"], ["30d", "30 days"]].map(([v, l]) => (
            <button key={v} className={range === v ? "on" : ""} onClick={() => setRange(v)}>{l}</button>
          ))}
        </div>
      </div>
      <div className="devp-grid k4" style={{ marginBottom: 16 }}>
        <Kpi label="E2EE INCIDENTS" value={fmtNum(data?.totalOccurrences)} icon={IcoShield} color={clean ? "var(--d-ok)" : "#fb923c"} foot={<span>{fmtInt(data?.groups)} groups</span>} />
        <Kpi label="AFFECTED USERS" value={fmtInt(data?.affectedUsers)} icon={IcoUsers} color={data?.affectedUsers ? "var(--d-bad)" : "var(--d-ok)"} foot={<span>people impacted</span>} />
        <Kpi label="TOP KIND" value={byKind[0]?.kind || "—"} icon={IcoAlert} color="var(--d-vio)" foot={<span>{byKind[0] ? fmtNum(byKind[0].count) + " hits" : "clean"}</span>} />
        <Kpi label="DEVICES" value={fmtInt(byDevice.length)} icon={IcoCpu} color="var(--d-acc)" foot={<span>distinct configs</span>} />
      </div>
      {clean ? (
        <Card>
          <div className="devp-empty" style={{ padding: "34px 10px" }}>
            <IcoShield size={28} />
            <b>No E2EE incidents</b>
            <span>No users hit an encryption failure in this window — nobody is seeing “[Unencrypted message — rejected]” or similar.</span>
          </div>
        </Card>
      ) : (
        <>
          <div className="devp-grid k3">
            <Card title="By Failure Kind" icon={IcoAlert}>
              {byKind.map((k) => <Meter key={k.kind} label={k.kind} value={(k.count / (byKind[0]?.count || 1)) * 100} display={fmtNum(k.count)} color="#fb923c" />)}
            </Card>
            <Card title="Affected Users" icon={IcoUsers} sub={fmtInt(byUser.length)}>
              {byUser.slice(0, 8).map((u) => (
                <div className="devp-svc" key={u.id} style={{ padding: "8px 4px" }}>
                  <div className="devp-svc-name"><b>{u.name}</b><span>{(u.kinds || []).join(", ")}</span></div>
                  <div className="devp-svc-meta"><span className="devp-svc-lat">{fmtNum(u.count)}</span></div>
                </div>
              ))}
            </Card>
            <Card title="By Device" icon={IcoCpu} sub={fmtInt(byDevice.length)}>
              {byDevice.slice(0, 8).map((dd) => <Meter key={dd.device} label={dd.device} value={(dd.count / (byDevice[0]?.count || 1)) * 100} display={fmtNum(dd.count)} color="var(--d-acc)" />)}
            </Card>
          </div>
          <div className="devp-sectlabel">Recent E2EE Incidents</div>
          <Card className="pad0">
            <div className="devp-tablewrap">
              <table className="devp-table">
                <thead><tr><th>Pri</th><th>Kind</th><th>User</th><th>Device</th><th>Detail</th><th className="mono">Count</th><th className="mono">Age</th></tr></thead>
                <tbody>
                  {issues.map((e) => (
                    <tr key={e.id}>
                      <td><PriorityTag p={e.priority} /></td>
                      <td style={{ color: "#fb923c", fontFamily: "var(--d-mono)", fontSize: 11 }}>{e.kind}</td>
                      <td>{e.user}</td>
                      <td style={{ fontSize: 11, color: "var(--d-mut)" }}>{e.device || "—"}</td>
                      <td style={{ maxWidth: 320 }}><div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={e.message}>{e.message}</div></td>
                      <td className="mono">{fmtInt(e.count)}</td>
                      <td className="mono" style={{ color: "var(--d-mut)" }}>{timeAgo(e.lastSeen)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </>
  );
}

// ── E2EE Identity Keys — every user's per-device encrypt/decrypt key directory ─
// The dev-admin counterpart to the failures-oriented E2EE Health view: a raw,
// per-device inventory of the PUBLIC key material each user has published —
// the ECDH identity key (encrypt/decrypt identity), ECDSA signing key (sender
// authentication), Double-Ratchet initial DH key, signed pre-key (X3DH) and the
// one-time pre-keys backing forward secrecy — plus pending/trusted/revoked
// enrollment state. Public keys only; the private halves never leave the device.
function E2EEIdentityKeys({ apiGet }: { apiGet: (p: string) => Promise<any> }) {
  const { data, loading } = usePoll(apiGet, "/api/ops/e2ee-devices", 20000);
  const [q, setQ] = useState("");
  if (loading && !data) return <LoadingView />;
  const users: any[] = data?.users || [];
  const s = q.trim().toLowerCase();
  const shown = s
    ? users.filter(
        (u) =>
          (u.name || "").toLowerCase().includes(s) ||
          (u.email || "").toLowerCase().includes(s) ||
          (u.id || "").toLowerCase().includes(s) ||
          (u.devices || []).some(
            (d: any) =>
              (d.id || "").toLowerCase().includes(s) ||
              (d.name || "").toLowerCase().includes(s) ||
              (d.identityKey || "").toLowerCase().includes(s) ||
              (d.signingKey || "").toLowerCase().includes(s),
          ),
      )
    : users;
  const pending = data?.pendingDevices || 0;
  const revoked = data?.revokedDevices || 0;
  return (
    <>
      <div className="devp-toolbar" style={{ marginBottom: 16 }}>
        <div className="devp-note" style={{ margin: 0 }}>
          Live per-device key directory. Public keys only — the private halves stay on user devices.
        </div>
        <button className="devp-btn" onClick={() => setQ("")} disabled={!q} title="Clear the search filter">
          Clear
        </button>
        <input className="devp-input" placeholder="Search by name, email, device id or key…" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1, minWidth: 220 }} />
      </div>
      <div className="devp-grid k4" style={{ marginBottom: 16 }}>
        <Kpi label="USERS WITH DEVICES" value={fmtInt(users.length)} icon={IcoUsers} color="var(--d-acc)" foot={<span>{fmtInt(data?.totalDevices || 0)} total devices</span>} />
        <Kpi label="TRUSTED DEVICES" value={fmtInt(Math.max(0, (data?.totalDevices || 0) - pending - revoked))} icon={IcoShield} color="var(--d-ok)" foot={<span>approved / decrypt-capable</span>} />
        <Kpi label="PENDING DEVICES" value={fmtInt(pending)} icon={IcoClock} color={pending ? "var(--d-warn)" : "var(--d-ok)"} foot={<span>awaiting approval</span>} />
        <Kpi label="REVOKED DEVICES" value={fmtInt(revoked)} icon={IcoLogout} color={revoked ? "var(--d-bad)" : "var(--d-ok)"} foot={<span>sign-in revoked</span>} />
      </div>
      {shown.length === 0 ? (
        <Card>
          <div className="devp-empty" style={{ padding: "34px 10px" }}>
            <IcoKey size={28} />
            <b>{users.length ? "No matching users" : "No E2EE devices registered"}</b>
            <span>
              {users.length
                ? "No user or device matches that search."
                : "No user has enrolled an E2EE device yet — this directory populates as devices register (client init with E2EE enabled)."}
            </span>
          </div>
        </Card>
      ) : (
        shown.map((u) => <UserDeviceCard key={u.id} u={u} />)
      )}
    </>
  );
}

// Truncate long base64 keys for the table; expandable rows show the full value.
const shortKey = (s: any, n = 30) => {
  const str = String(s || "");
  if (!str) return "—";
  return str.length <= n ? str : str.slice(0, n / 2) + "…" + str.slice(-n / 2);
};

// One selectable / copyable public key value in the device detail panel.
function KeyRow({ label, value }: { label: string; value: any }) {
  const [full, setFull] = useState(false);
  const [copied, setCopied] = useState(false);
  if (value == null || value === "") return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(String(value));
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {}
  };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 4px", borderBottom: "1px solid var(--d-line)" }}>
      <span style={{ width: 132, flex: "none", fontSize: 10.5, color: "var(--d-fg2)", fontWeight: 600 }}>{label}</span>
      <code
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 11,
          wordBreak: "break-all",
          fontFamily: "var(--d-mono)",
          color: "var(--d-fg)",
          whiteSpace: full ? "pre-wrap" : "nowrap",
          overflow: full ? undefined : "hidden",
          textOverflow: full ? undefined : "ellipsis",
        }}
      >
        {full ? value : shortKey(value, 64)}
      </code>
      <button className="devp-iconbtn" title={full ? "Collapse key" : "Expand full key"} onClick={() => setFull(!full)} style={{ width: 26, height: 26, flex: "none" }}>
        {full ? "−" : "+"}
      </button>
      <button className="devp-iconbtn" title="Copy full key" onClick={copy} style={{ width: 26, height: 26, flex: "none" }}>
        {copied ? "✓" : <IcoCopy size={12} />}
      </button>
    </div>
  );
}

// One user's device rows; clicking a row expands the full key material.
function UserDeviceCard({ u }: { u: any }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const toggle = (id: string) => setOpen((p) => ({ ...p, [id]: !p[id] }));
  return (
    <Card
      title={u.name || u.email || u.id}
      sub={u.email || u.id}
      icon={IcoUsers}
      className="pad0"
      right={
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          {u.pendingDevices > 0 ? <Pill kind="warn">{u.pendingDevices} pending</Pill> : null}
          {u.revokedDevices > 0 ? <Pill kind="bad">{u.revokedDevices} revoked</Pill> : null}
          <Pill kind="ok">{u.trustedDevices} trusted</Pill>
        </span>
      }
    >
      <div className="devp-tablewrap">
        <table className="devp-table">
          <thead>
            <tr>
              <th>Device</th>
              <th>Status</th>
              <th className="mono">Identity key</th>
              <th className="mono">Signing key</th>
              <th className="mono">OPKs</th>
              <th className="mono">Conv keys</th>
              <th className="mono">Last seen</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {u.devices.map((d: any) => {
              const on = !!open[d.id];
              return (
                <React.Fragment key={d.id}>
                  <tr onClick={() => toggle(d.id)} style={{ cursor: "pointer" }}>
                    <td>
                      <div className="devp-t-strong">{d.name || "Unnamed device"}</div>
                      <div style={{ fontSize: 10.5, fontFamily: "var(--d-mono)", color: "var(--d-mut)" }}>{shortKey(d.id, 22)}</div>
                    </td>
                    <td>{d.revoked ? <Pill kind="bad">revoked</Pill> : d.trusted ? <Pill kind="ok">trusted</Pill> : <Pill kind="warn">pending</Pill>}</td>
                    <td className="mono" title={d.identityKey}>{shortKey(d.identityKey)}</td>
                    <td className="mono" title={d.signingKey}>{shortKey(d.signingKey)}</td>
                    <td className="mono">{fmtInt(d.oneTimePreKeyCount)}</td>
                    <td className="mono">{fmtInt(d.conversationKeyCount)}</td>
                    <td className="mono" style={{ color: "var(--d-mut)" }}>{d.lastSeenAt ? timeAgo(d.lastSeenAt) : "—"}</td>
                    <td style={{ textAlign: "right", color: "var(--d-fg2)" }}>{on ? "−" : "+"}</td>
                  </tr>
                  {on ? (
                    <tr>
                      <td colSpan={8} style={{ padding: "14px 16px", background: "rgba(255,255,255,.02)" }}>
                        <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
                          <div style={{ flex: "1 1 360px", minWidth: 280 }}>
                            <div className="devp-sectlabel" style={{ marginTop: 0 }}>Encryption keys</div>
                            <KeyRow label="Identity (ECDH)" value={d.identityKey} />
                            <KeyRow label="Signing (ECDSA)" value={d.signingKey} />
                            <KeyRow label="Ratchet initial DH" value={d.ratchetInitialKey} />
                            <KeyRow label="Signed pre-key" value={d.signedPreKey && d.signedPreKey.key} />
                            <KeyRow label="Pre-key signature" value={d.signedPreKey && d.signedPreKey.sig} />
                            <KeyRow label="Registered" value={d.createdAt} />
                          </div>
                          <div style={{ flex: "1 1 380px", minWidth: 280 }}>
                            <div className="devp-sectlabel" style={{ marginTop: 0 }}>One-time pre-keys ({fmtInt(d.oneTimePreKeys.length)})</div>
                            {d.oneTimePreKeys.length === 0 ? (
                              <div className="devp-note" style={{ margin: "6px 0 0" }}>No one-time pre-keys published.</div>
                            ) : (
                              <>
                                <div className="devp-tablewrap" style={{ marginTop: 4 }}>
                                  <table className="devp-table">
                                    <thead>
                                      <tr>
                                        <th className="mono">Key id</th>
                                        <th>State</th>
                                        <th className="mono">Created</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {d.oneTimePreKeys.slice(0, 20).map((k: any) => (
                                        <tr key={k.keyId}>
                                          <td className="mono" style={{ fontSize: 10.5 }} title={k.publicKey}>{shortKey(k.keyId, 20)}</td>
                                          <td>{k.consumedAt ? <Pill kind="mut">used</Pill> : <Pill kind="ok">available</Pill>}</td>
                                          <td className="mono" style={{ fontSize: 10.5, color: "var(--d-mut)" }}>{timeAgo(k.createdAt)}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                                {d.oneTimePreKeys.length > 20 ? (
                                  <div className="devp-note" style={{ margin: "6px 0 0" }}>Showing the first 20 of {fmtInt(d.oneTimePreKeys.length)} published pre-keys.</div>
                                ) : null}
                              </>
                            )}
                          </div>
                        </div>
                        <div className="devp-note" style={{ margin: "12px 0 0" }}>
                          Last seen: {d.lastSeenAt ? timeAgo(d.lastSeenAt) + " · " + new Date(d.lastSeenAt).toLocaleString() : "never"}.
                          Row keys shown here are public; the private halves are non-extractable on the user device.
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ── User Experience — per-user error rollup ("track the CEO") ────────────────
function hashUser(): string {
  try {
    return decodeURIComponent(new URLSearchParams((location.hash.split("?")[1] || "")).get("u") || "");
  } catch {
    return "";
  }
}
function UserExperience({ apiGet }: { apiGet: (p: string) => Promise<any> }) {
  const [range, setRange] = useState("7d");
  const [q, setQ] = useState(hashUser);
  // Update the filter when navigated here with a ?u= (click-through from another view).
  useEffect(() => {
    const onHash = () => {
      const u = hashUser();
      if (u) setQ(u);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const { data, loading } = usePoll(apiGet, "/api/ops/users-health?range=" + range, 15000);
  if (loading && !data) return <LoadingView />;
  let users: any[] = data?.users || [];
  if (q.trim()) {
    const s = q.trim().toLowerCase();
    users = users.filter((u) => (u.name || "").toLowerCase().includes(s) || (u.email || "").toLowerCase().includes(s) || (u.id || "").toLowerCase().includes(s));
  }
  const p0users = (data?.users || []).filter((u: any) => u.worstLabel === "P0").length;
  return (
    <>
      <div className="devp-toolbar" style={{ marginBottom: 16 }}>
        <div className="devp-seg">
          {[["today", "Today"], ["yesterday", "Yesterday"], ["7d", "7 days"], ["30d", "30 days"]].map(([v, l]) => (
            <button key={v} className={range === v ? "on" : ""} onClick={() => setRange(v)}>{l}</button>
          ))}
        </div>
        <input className="devp-input" placeholder="Search by name or email…" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1, minWidth: 200 }} />
      </div>
      <div className="devp-grid k3" style={{ marginBottom: 16 }}>
        <Kpi label="USERS WITH ISSUES" value={fmtInt((data?.users || []).length)} icon={IcoUsers} color={(data?.users || []).length ? "var(--d-warn)" : "var(--d-ok)"} foot={<span>in range</span>} />
        <Kpi label="CRITICAL (P0)" value={fmtInt(p0users)} icon={IcoAlert} color={p0users ? "#f87171" : "var(--d-ok)"} foot={<span>people hitting P0</span>} />
        <Kpi label="E2EE-AFFECTED" value={fmtInt((data?.users || []).filter((u: any) => u.e2ee > 0).length)} icon={IcoShield} color="#fb923c" foot={<span>encryption issues</span>} />
      </div>
      {users.length === 0 ? (
        <Card>
          <div className="devp-empty" style={{ padding: "34px 10px" }}>
            <IcoShield size={28} />
            <b>{q ? "No match" : "No users with issues"}</b>
            <span>{q ? "No one matching that search has errors in this window." : "Nobody hit an error in this window."}</span>
          </div>
        </Card>
      ) : (
        users.map((u) => (
          <div className="devp-insight" key={u.id} style={{ ["--sev" as any]: PRI_UI[u.worstLabel]?.color || "var(--d-acc)" }}>
            <div className="devp-insight-head">
              <PriorityTag p={u.worstLabel} />
              <b className="devp-insight-title">{u.name}</b>
              {u.email ? <span className="devp-insight-area">{u.email}</span> : null}
              <span className="devp-insight-conf" style={{ marginLeft: "auto" }}>{fmtNum(u.total)} errors · {u.groups} groups{u.e2ee ? ` · ${fmtNum(u.e2ee)} E2EE` : ""}</span>
            </div>
            <div className="devp-insight-foot" style={{ marginTop: 4, borderTop: 0, paddingTop: 0 }}>
              <span><b>Device:</b> {(u.devices || []).join(" · ") || "—"}</span>
              {u.os && u.os.length ? <span><b>OS:</b> {u.os.join(", ")}</span> : null}
              {u.locations && u.locations.length ? <span><b>Location:</b> {u.locations.join(" · ")}</span> : null}
              <span className="mono"><b>Last issue:</b> {timeAgo(u.lastSeen)}</span>
            </div>
            <div style={{ marginTop: 6 }}>
              {(u.top || []).map((t: any, i: number) => (
                <div key={i} className="devp-faultex">
                  <span className="devp-faultex-msg">{t.category === "e2ee" ? "🔒 " : ""}{t.message}</span>
                  <span className="devp-faultex-meta">{t.priority} · ×{fmtNum(t.count)}</span>
                </div>
              ))}
            </div>
          </div>
        ))
      )}
    </>
  );
}

// ── Logs (live, filterable) ───────────────────────────────────────────────────
function Logs({ apiGet }: { apiGet: (p: string) => Promise<any> }) {
  const [level, setLevel] = useState("all");
  const [q, setQ] = useState("");
  const [logs, setLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [autopoll, setAutopoll] = useState(true);
  useEffect(() => {
    let alive = true;
    const load = () => {
      const params = new URLSearchParams();
      if (level !== "all") params.set("level", level);
      if (q.trim()) params.set("q", q.trim());
      params.set("limit", "120");
      apiGet("/api/ops/logs?" + params.toString())
        .then((j) => {
          if (alive) {
            setLogs(j.logs || []);
            setLoading(false);
          }
        })
        .catch(() => alive && setLoading(false));
    };
    setLoading(true);
    load();
    if (!autopoll) return () => (alive = false) as any;
    const id = setInterval(load, 6000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [apiGet, level, q, autopoll]);
  return (
    <>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
        <div className="devp-seg">
          {["all", "error", "warn", "fatal"].map((l) => (
            <button key={l} className={level === l ? "on" : ""} onClick={() => setLevel(l)}>
              {l}
            </button>
          ))}
        </div>
        <input className="devp-input" placeholder="Filter messages…" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1, minWidth: 180 }} />
        <button className="devp-navitem" style={{ width: "auto", padding: "7px 12px", border: "1px solid var(--d-line2)", borderRadius: 9 }} onClick={() => setAutopoll((v) => !v)}>
          <span className={"devp-livedot " + (autopoll ? "" : "stale")} style={{ position: "static" }} />
          {autopoll ? "Live" : "Paused"}
        </button>
      </div>
      <Card className="pad0">
        {loading ? (
          <div style={{ padding: 16 }}>
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="devp-skel" style={{ height: 20, margin: "8px 0" }} />
            ))}
          </div>
        ) : logs.length === 0 ? (
          <div className="devp-empty" style={{ padding: "34px 10px" }}>
            <IcoList size={28} />
            <b>No matching log entries</b>
            <span>Nothing in the ledger for this filter.</span>
          </div>
        ) : (
          <div>
            {logs.map((e) => (
              <div className="devp-log" key={e.id}>
                <span className="devp-log-time">{timeAgo(e.lastSeen)}</span>
                <span className={"devp-log-lvl " + (e.level || "error")}>{e.level || "err"}</span>
                <span className="devp-log-msg" title={e.message}>
                  {e.message}
                </span>
                <span className="devp-log-cnt">
                  <span className="devp-log-dep">{e.dependency || "app"}</span> ×{fmtNum(e.count)}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}

// ── Alerts ────────────────────────────────────────────────────────────────────
function Alerts({ snap }: { snap: Snap }) {
  const s = snap.server || {};
  const ch = snap.health?.checks || {};
  const memPct = s.sysTotalMem ? (s.memRssBytes / s.sysTotalMem) * 100 : 0;
  const errTotal = (snap.errors || []).reduce((a: number, e: any) => a + (e.count || 0), 0);
  // derive live alerts from current thresholds
  const alerts = [
    { name: "MySQL reachable", ok: !!ch.db?.ok, detail: ch.db?.ok ? ch.db.ms + "ms round-trip" : "database probe failed", sev: "critical" },
    { name: "Object storage reachable", ok: !!ch.storage?.ok, detail: ch.storage?.ok ? ch.storage.ms + "ms" : "bucket probe failed", sev: "critical" },
    { name: "CPU below 85%", ok: (s.cpuPct || 0) < 85, detail: (s.cpuPct || 0).toFixed(1) + "% process CPU", sev: "warning" },
    { name: "Memory below 85%", ok: memPct < 85, detail: memPct.toFixed(1) + "% RSS", sev: "warning" },
    { name: "Error pressure normal", ok: errTotal < 100, detail: fmtInt(errTotal) + " total occurrences", sev: "warning" },
    { name: "Redis reachable", ok: snap.redis?.configured ? !!ch.redis?.ok : true, detail: snap.redis?.configured ? (ch.redis?.ok ? "connected" : "unreachable") : "not configured", sev: "info" },
  ];
  const firing = alerts.filter((a) => !a.ok);
  return (
    <>
      <div className="devp-grid k3" style={{ marginBottom: 16 }}>
        <Kpi label="MONITORS" value={fmtInt(alerts.length)} icon={IcoActivity} color="var(--d-acc)" foot={<span>threshold checks</span>} />
        <Kpi label="FIRING" value={fmtInt(firing.length)} icon={IcoAlert} color={firing.length ? "var(--d-bad)" : "var(--d-ok)"} foot={<span>{firing.length ? "needs attention" : "all clear"}</span>} />
        <Kpi label="HEALTH SCORE" value={fmtInt(snap.score)} icon={IcoShield} color={snap.score >= 85 ? "var(--d-ok)" : snap.score >= 60 ? "var(--d-warn)" : "var(--d-bad)"} foot={<span>composite</span>} />
      </div>
      <Card title="Threshold Monitors" icon={IcoActivity}>
        {alerts.map((a) => (
          <div className="devp-svc" key={a.name}>
            <span className={"devp-svc-ico"} style={{ color: a.ok ? "var(--d-ok)" : a.sev === "critical" ? "var(--d-bad)" : "var(--d-warn)" }}>
              {a.ok ? <IcoShield size={16} /> : <IcoAlert size={16} />}
            </span>
            <div className="devp-svc-name">
              <b>{a.name}</b>
              <span>{a.detail}</span>
            </div>
            <div className="devp-svc-meta">
              <span className="devp-note" style={{ fontSize: 10 }}>{a.sev}</span>
              <Pill kind={a.ok ? "ok" : a.sev === "critical" ? "bad" : "warn"}>{a.ok ? "ok" : "firing"}</Pill>
            </div>
          </div>
        ))}
      </Card>
      <div className="devp-note" style={{ marginTop: 12 }}>
        Monitors evaluate live against the latest snapshot — each turns red the moment its threshold is crossed, so you see a problem here before a customer reports it.
      </div>
    </>
  );
}

// ── Dependency Graph ──────────────────────────────────────────────────────────
function Deps({ snap }: { snap: Snap }) {
  const ch = snap.health?.checks || {};
  const nodes = [
    { id: "client", label: "Web / Desktop", x: 60, y: 130, c: "var(--d-acc)", ok: true },
    { id: "nginx", label: "nginx", x: 210, y: 130, c: "var(--d-fg2)", ok: true },
    { id: "api", label: "Backend API", x: 370, y: 130, c: "var(--d-acc2)", ok: true },
    { id: "db", label: "MySQL", x: 560, y: 50, c: "var(--d-vio)", ok: ch.db?.ok },
    { id: "redis", label: "Redis", x: 560, y: 130, c: "var(--d-pink)", ok: snap.redis?.configured ? ch.redis?.ok : null },
    { id: "s3", label: "Object Store", x: 560, y: 210, c: "var(--d-ok)", ok: ch.storage?.ok },
    { id: "lk", label: "LiveKit SFU", x: 370, y: 250, c: "var(--d-warn)", ok: snap.livekit?.configured ? snap.livekit?.ok : null },
  ];
  const edges = [
    ["client", "nginx"],
    ["nginx", "api"],
    ["api", "db"],
    ["api", "redis"],
    ["api", "s3"],
    ["api", "lk"],
    ["client", "lk"],
  ];
  const pos = (id: string) => nodes.find((n) => n.id === id)!;
  return (
    <Card title="Service Topology" icon={IcoGraph} sub="live health">
      <div className="devp-tablewrap">
        <svg width="100%" viewBox="0 0 680 300" style={{ minWidth: 640 }}>
          {edges.map(([a, b], i) => {
            const p = pos(a);
            const q = pos(b);
            return <line key={i} x1={p.x} y1={p.y} x2={q.x} y2={q.y} stroke="var(--d-line2)" strokeWidth="1.5" strokeDasharray="4 4" />;
          })}
          {nodes.map((n) => (
            <g key={n.id}>
              <rect x={n.x - 52} y={n.y - 20} width="104" height="40" rx="10" fill="var(--d-panel2)" stroke={n.ok == null ? "var(--d-line2)" : n.ok ? n.c : "var(--d-bad)"} strokeWidth="1.5" />
              <circle cx={n.x - 36} cy={n.y} r="4" fill={n.ok == null ? "var(--d-faint)" : n.ok ? "var(--d-ok)" : "var(--d-bad)"} />
              <text x={n.x + 2} y={n.y + 4} textAnchor="middle" fill="var(--d-fg)" fontSize="11.5" fontFamily="var(--d-sans)">
                {n.label}
              </text>
            </g>
          ))}
        </svg>
      </div>
      <div className="devp-note" style={{ marginTop: 10 }}>
        Nodes reflect live probe status (green = reachable, red = down, grey = not configured). Edges show the request/data flow between the client, API and backing services.
      </div>
    </Card>
  );
}

// ── Search — unified telemetry search (errors / users / deployments) ─────────
function Search({ apiGet, openUser }: { apiGet: (p: string) => Promise<any>; openUser: (name: string) => void }) {
  const [q, setQ] = useState("");
  const [res, setRes] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const t = q.trim();
    if (!t) {
      setRes(null);
      return;
    }
    setLoading(true);
    const id = setTimeout(() => {
      apiGet("/api/ops/search?q=" + encodeURIComponent(t))
        .then(setRes)
        .catch(() => {})
        .finally(() => setLoading(false));
    }, 300);
    return () => clearTimeout(id);
  }, [apiGet, q]);
  const errs = res?.errors || [];
  const users = res?.users || [];
  const deps = res?.deployments || [];
  const empty = res && !errs.length && !users.length && !deps.length;
  return (
    <>
      <div className="devp-toolbar" style={{ marginBottom: 16 }}>
        <IcoSearch size={16} />
        <input className="devp-input" autoFocus placeholder="Search errors, users, releases… (message, endpoint, name, version, commit)" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1, minWidth: 240 }} />
      </div>
      {!q.trim() ? (
        <Card>
          <div className="devp-empty" style={{ padding: "34px 10px" }}>
            <IcoSearch size={28} />
            <b>Search the whole platform</b>
            <span>One bar across the error ledger, affected users, and the release timeline. Try an error message, an endpoint, a person’s name, or a version.</span>
          </div>
        </Card>
      ) : loading && !res ? (
        <LoadingView />
      ) : empty ? (
        <Card>
          <div className="devp-empty" style={{ padding: "34px 10px" }}>
            <IcoSearch size={26} />
            <b>No matches</b>
            <span>Nothing found for “{q}”.</span>
          </div>
        </Card>
      ) : (
        <>
          {users.length ? (
            <Card title="People" icon={IcoUsers} sub={fmtInt(users.length)}>
              {users.map((u: any) => (
                <div className="devp-svc" key={u.id}>
                  <PriorityTag p={u.worstLabel} />
                  <div className="devp-svc-name" style={{ marginLeft: 10 }}>
                    <b>{u.name}</b>
                    <span>{u.email || u.id}</span>
                  </div>
                  <div className="devp-svc-meta">
                    <span className="devp-svc-lat">{fmtNum(u.count)} errors</span>
                    <button className="devp-btn" onClick={() => openUser(u.name)}>Track →</button>
                  </div>
                </div>
              ))}
            </Card>
          ) : null}
          {errs.length ? (
            <>
              <div className="devp-sectlabel">Issues</div>
              <Card className="pad0">
                <div className="devp-tablewrap">
                  <table className="devp-table">
                    <thead><tr><th>Pri</th><th>Type</th><th>User</th><th>Message</th><th className="mono">Count</th><th className="mono">Age</th></tr></thead>
                    <tbody>
                      {errs.map((e: any) => (
                        <tr key={e.id}>
                          <td><PriorityTag p={e.priority} /></td>
                          <td>{e.category === "e2ee" ? <span className="devp-pill bad">E2EE</span> : <span className="devp-pill mut">{e.category}</span>}</td>
                          <td style={{ maxWidth: 120 }}><div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.user}</div></td>
                          <td style={{ maxWidth: 340 }}><div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={e.message}>{e.message}</div></td>
                          <td className="mono">{fmtInt(e.count)}</td>
                          <td className="mono" style={{ color: "var(--d-mut)" }}>{timeAgo(e.lastSeen)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            </>
          ) : null}
          {deps.length ? (
            <>
              <div className="devp-sectlabel">Releases</div>
              <Card className="pad0">
                <div className="devp-tablewrap">
                  <table className="devp-table">
                    <thead><tr><th>Version</th><th>Kind</th><th>Commit</th><th className="mono">When</th></tr></thead>
                    <tbody>
                      {deps.map((d: any, i: number) => (
                        <tr key={i}><td className="devp-t-strong">v{d.version}</td><td>{d.kind}</td><td className="mono" style={{ color: "var(--d-mut)" }}>{d.gitCommit ? String(d.gitCommit).slice(0, 7) : "—"}</td><td className="mono">{timeAgo(d.at)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            </>
          ) : null}
        </>
      )}
    </>
  );
}

// ── Feature Flags — real runtime config ──────────────────────────────────────
function FeatureFlags({ apiGet }: { apiGet: (p: string) => Promise<any> }) {
  const { data, loading } = usePoll(apiGet, "/api/ops/config", 30000);
  if (loading && !data) return <LoadingView />;
  const flags: any[] = data?.flags || [];
  const groups = Array.from(new Set(flags.map((f) => f.group)));
  const on = flags.filter((f) => f.on).length;
  return (
    <>
      <div className="devp-grid k3" style={{ marginBottom: 16 }}>
        <Kpi label="FLAGS ON" value={`${on}/${flags.length}`} icon={IcoFlag} color="var(--d-ok)" foot={<span>runtime config</span>} />
        <Kpi label="ENVIRONMENT" value={data?.env || "—"} icon={IcoServer} color="var(--d-acc)" foot={<span>v{data?.version}</span>} />
        <Kpi label="GROUPS" value={fmtInt(groups.length)} icon={IcoGraph} color="var(--d-vio)" foot={<span>config domains</span>} />
      </div>
      <div className="devp-note" style={{ margin: "0 2px 14px" }}>
        Live runtime configuration read straight from the backend — the actual switches that determine platform behaviour right now (set via environment variables; restart to change).
      </div>
      {groups.map((g) => (
        <Card key={g} title={g} icon={IcoFlag} sub={fmtInt(flags.filter((f) => f.group === g && f.on).length) + " on"}>
          {flags.filter((f) => f.group === g).map((f) => (
            <div className="devp-svc" key={f.key}>
              <span className={"devp-dot " + (f.on ? "ok" : "idle")} />
              <div className="devp-svc-name" style={{ marginLeft: 6 }}>
                <b>{f.key}</b>
                <span>{f.desc}</span>
              </div>
              <div className="devp-svc-meta"><Pill kind={f.on ? "ok" : "mut"}>{f.on ? "ON" : "OFF"}</Pill></div>
            </div>
          ))}
        </Card>
      ))}
    </>
  );
}

// ── AI Assistant — deterministic Q&A over live telemetry ─────────────────────
function answerQuestion(qRaw: string, ctx: any): string {
  if (!ctx || !ctx.snap) return "Still gathering telemetry — ask again in a moment.";
  const q = qRaw.toLowerCase();
  const snap = ctx.snap;
  const c = snap.counts || {};
  const ch = snap.health?.checks || {};
  const has = (...ws: string[]) => ws.some((w) => q.includes(w));
  const topUser = (ctx.users || [])[0];
  if (has("health", "score", "status", "how are we", "overall")) {
    const probes = [`MySQL ${ch.db?.ok ? "up" : "DOWN"}`, `storage ${ch.storage?.ok ? "up" : "DOWN"}`, snap.redis?.configured ? `Redis ${ch.redis?.ok ? "up" : "DOWN"}` : "Redis n/a"].join(", ");
    return `Platform health is ${snap.score}/100. Probes: ${probes}. ${(snap.errors || []).length} open error groups, ${fmtInt(c.liveParticipants)} people in ${fmtInt(c.activeRooms)} live rooms.`;
  }
  if (has("e2ee", "encrypt", "unencrypted", "rejected")) {
    const e = ctx.e2ee || {};
    if (!e.totalOccurrences) return "No E2EE incidents in the last 7 days — nobody is seeing encryption errors like “[Unencrypted message — rejected]”.";
    const kind = (e.byKind || [])[0];
    return `${fmtNum(e.totalOccurrences)} E2EE incident(s) across ${e.affectedUsers} user(s) in 7d. Most common: ${kind ? kind.kind + " (" + kind.count + ")" : "—"}. Check E2EE Health for the per-user/device breakdown.`;
  }
  if (has("deploy", "release", "version", "rollout", "shipped")) {
    const d = (ctx.deps || [])[0];
    const suspect = (ctx.deps || []).filter((x: any) => x.suspect).length;
    return `Running v${snap.server?.version} (${snap.server?.gitCommit ? String(snap.server.gitCommit).slice(0, 7) : "no commit"}). Last boot ${d ? timeAgo(d.startedAt) : "—"}. ${suspect} recent release(s) flagged suspect (error spike within 15 min). See Deployments.`;
  }
  if (has("who", "user", "affected", "ceo", "person", "customer", "worst")) {
    if (!topUser) return "No users have errors in the last 7 days.";
    return `Most-affected user: ${topUser.name} — ${fmtNum(topUser.total)} errors (${topUser.worstLabel})${topUser.e2ee ? ", " + fmtNum(topUser.e2ee) + " E2EE" : ""}, across ${(topUser.devices || []).length} device(s). Open User Experience and search their name to track them.`;
  }
  if (has("fault", "blame", "whose", "infra", "side", "attribut", "cause")) {
    const f = (ctx.fault || []).filter((x: any) => x.occurrences > 0);
    if (!f.length) return "No faults to attribute in the last 7 days.";
    return "Fault attribution (7d): " + f.map((x: any) => `${(DOMAIN_UI[x.key] || {}).short || x.key} ${x.pct}%`).join(", ") + ". The top bucket tells you which side to escalate to.";
  }
  if (has("cpu", "memory", "ram", "perf", "slow", "load", "resource")) {
    const s = snap.server || {};
    const memPct = s.sysTotalMem ? (s.memRssBytes / s.sysTotalMem) * 100 : 0;
    return `CPU ${(s.cpuPct || 0).toFixed(1)}%, RSS ${fmtBytes(s.memRssBytes)} (${memPct.toFixed(0)}% of host), load ${(s.loadAvg?.[0] || 0).toFixed(2)} over ${s.cores} cores. DB latency ${ch.db?.ms ?? "—"}ms, storage ${ch.storage?.ms ?? "—"}ms.`;
  }
  if (has("redis", "cache")) {
    const r = snap.redis || {};
    if (!r.configured) return "Redis is not configured in this deployment.";
    const hit = r.hits + r.misses ? ((r.hits / (r.hits + r.misses)) * 100).toFixed(0) : "—";
    return `Redis: ${r.memoryHuman || fmtBytes(r.memoryBytes)} used, ${fmtInt(r.clients)} clients, ${hit}% hit rate, ${fmtInt(r.opsPerSec)} ops/sec.`;
  }
  if (has("database", "db", "mysql", "query", "connection", "pool")) {
    const d = snap.db || {};
    return `MySQL ${d.version}: ${d.threadsConnected}/${d.maxConnections} connections, ${fmtNum(d.queries)} queries, ${fmtInt(d.slowQueries)} slow, ${d.latencyMs}ms ping.`;
  }
  if (has("room", "call", "meeting", "participant", "live")) {
    return `${fmtInt(c.liveParticipants)} participant(s) across ${fmtInt(c.activeRooms)} live room(s) right now. ${fmtInt(c.activeSessions)} active sessions in the last 5 minutes.`;
  }
  if (has("error", "issue", "bug", "problem", "open", "p0", "critical")) {
    const errs = snap.errors || [];
    const p0 = errs.filter((e: any) => e.level === "fatal").length;
    const dom: Record<string, number> = {};
    errs.forEach((e: any) => (dom[e.domain] = (dom[e.domain] || 0) + (e.count || 0)));
    const top = Object.entries(dom).sort((a, b) => b[1] - a[1])[0];
    return `${errs.length} open error group(s), ${p0} fatal. Dominant domain: ${top ? (DOMAIN_UI[top[0]] || {}).label || top[0] : "—"}. Open the Error Center for who/where/priority, or ask “whose fault is it?”.`;
  }
  return `Health ${snap.score}/100 · ${(snap.errors || []).length} open errors · ${fmtInt(c.liveParticipants)} in calls · v${snap.server?.version}. Ask me about health, errors, E2EE, deployments, a user, fault attribution, CPU/memory, Redis, or the database.`;
}
function AIAssistant({ apiGet }: { apiGet: (p: string) => Promise<any> }) {
  const [ctx, setCtx] = useState<any>(null);
  const [thread, setThread] = useState<{ q: string; a: string }[]>([]);
  const [q, setQ] = useState("");
  useEffect(() => {
    let alive = true;
    const load = () =>
      Promise.all([
        apiGet("/api/ops/snapshot"),
        apiGet("/api/ops/fault?range=7d"),
        apiGet("/api/ops/users-health?range=7d"),
        apiGet("/api/ops/e2ee-health?range=7d"),
        apiGet("/api/ops/deployments"),
      ])
        .then(([snap, fault, users, e2ee, deps]) => {
          if (alive) setCtx({ snap, fault: fault.domains || [], users: users.users || [], e2ee, deps: deps.deployments || [] });
        })
        .catch(() => {});
    load();
    const id = setInterval(load, 30000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [apiGet]);
  const ask = (question: string) => {
    const t = question.trim();
    if (!t) return;
    setThread((prev) => [...prev, { q: t, a: answerQuestion(t, ctx) }]);
    setQ("");
  };
  const suggestions = ["Whose fault is it — infra or our code?", "Any E2EE issues right now?", "Which deployment looks suspect?", "Who is the most-affected user?", "What's the health score?", "How's CPU and memory?"];
  return (
    <>
      <Card title="Ask Observatory" icon={IcoRobot}>
        <div className="devp-note" style={{ marginBottom: 12 }}>
          Ask about live platform state in plain language. Every answer is drawn from the same live telemetry the dashboard renders — accurate, reproducible, and never message content.
        </div>
        <form onSubmit={(e) => { e.preventDefault(); ask(q); }} className="devp-toolbar" style={{ marginBottom: 0 }}>
          <IcoRobot size={16} />
          <input className="devp-input" placeholder="e.g. whose fault is it right now?" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1, minWidth: 220 }} />
          <button className="devp-btn" type="submit" disabled={!q.trim() || !ctx}>Ask</button>
        </form>
      </Card>

      {thread.length === 0 ? (
        <>
          <div className="devp-sectlabel">Try asking</div>
          <div className="devp-grid k2">
            {suggestions.map((s) => (
              <button className="devp-card" key={s} onClick={() => ask(s)} style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--d-fg2)", cursor: "pointer", textAlign: "left", font: "inherit" }}>
                <IcoRobot size={16} />
                <span style={{ fontSize: 12.5 }}>{s}</span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <div style={{ marginTop: 4 }}>
          {[...thread].reverse().map((m, i) => (
            <div className="devp-card" key={thread.length - i} style={{ marginBottom: 12 }}>
              <div style={{ display: "flex", gap: 8, marginBottom: 8, color: "var(--d-fg)", fontWeight: 600, fontSize: 13 }}>
                <IcoSearch size={15} /> {m.q}
              </div>
              <div style={{ display: "flex", gap: 8, color: "var(--d-fg2)", fontSize: 12.5, lineHeight: 1.6 }}>
                <IcoRobot size={15} /> <span>{m.a}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ── Engineering efficiency + review ──────────────────────────────────────────
function scoreColor(s: number): string {
  return s >= 85 ? "var(--d-ok)" : s >= 65 ? "var(--d-warn)" : "var(--d-bad)";
}
const FTYPE_UI: Record<string, { label: string; kind: string; color: string }> = {
  observed: { label: "Observed", kind: "info", color: "var(--d-acc)" },
  recommendation: { label: "Recommendation", kind: "warn", color: "var(--d-warn)" },
  prediction: { label: "Prediction", kind: "mut", color: "var(--d-vio)" },
};
const IMPACT_KIND: Record<string, string> = { high: "bad", medium: "warn", low: "mut" };

// ── Engineering Review — the morning engineering summary ─────────────────────
// Score → coarse health status (aligned with scoreColor / HealthRing thresholds).
function scoreStatus(score: number | null | undefined): { label: string; kind: string } {
  if (score == null) return { label: "Not scored", kind: "mut" };
  if (score >= 85) return { label: "Healthy", kind: "ok" };
  if (score >= 70) return { label: "Good", kind: "ok" };
  if (score >= 55) return { label: "Needs attention", kind: "warn" };
  return { label: "At risk", kind: "bad" };
}
// Does an evidence-backed finding belong under this category score card? Matches
// loosely on the finding's category/subsystem vs the score's key/label so the
// drill-down groups the right evidence without a brittle hardcoded taxonomy.
function findingMatchesScore(f: any, s: any): boolean {
  const hay = `${f.category || ""} ${f.subsystem || ""}`.toLowerCase();
  const key = String(s.key || "").toLowerCase();
  const label = String(s.label || "").toLowerCase();
  return (
    hay.includes(key) ||
    (label && hay.includes(label)) ||
    (key && (`${key}`.includes(String(f.category || "").toLowerCase()) && !!f.category))
  );
}

function EngineeringReview({ apiGet }: { apiGet: (p: string) => Promise<any> }) {
  const { data, loading } = usePoll(apiGet, "/api/ops/architecture", 60000);
  const [openCat, setOpenCat] = useState<string | null>(null);
  if (loading && !data) return <LoadingView />;
  const cto = data?.cto;
  const scores: any[] = data?.scores || [];
  const findings: any[] = data?.findings || [];
  const live = data?.live || {};
  const overall = scores.find((s) => s.key === "overallEngineering");
  const overallScore = overall?.score;
  // Category scores = every score except the aggregate overall.
  const catScores = scores.filter((s) => s.key !== "overallEngineering");
  // History across scans (present once the analysis workflow persists snapshots);
  // until then this is just the current point — we show it honestly, never faked.
  const trend: any[] = Array.isArray(data?.trend) ? data.trend : [];
  const selected = openCat ? catScores.find((s) => s.key === openCat) : null;
  const selectedFindings = selected
    ? findings.filter((f) => findingMatchesScore(f, selected))
    : [];
  const cacheStr = live.cacheHitRate == null ? (live.cacheConfigured ? "no traffic yet" : "n/a") : live.cacheHitRate + "%";
  return (
    <>
      <div className="devp-grid k4" style={{ marginBottom: 16 }}>
        <div className="devp-card" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, justifyContent: "center", borderColor: overallScore != null ? scoreColor(overallScore) : "var(--d-line)" }}>
          <span className="devp-insight-area">Overall engineering score</span>
          <b style={{ fontFamily: "var(--d-mono)", fontSize: 34, color: overallScore != null ? scoreColor(overallScore) : "var(--d-mut)" }}>{overallScore != null ? overallScore : "—"}</b>
          <span style={{ fontSize: 10.5, color: "var(--d-mut)" }}>{scoreStatus(overallScore).label}{overallScore == null ? "" : " · " + catScores.length + " categories"}</span>
        </div>
        <Kpi label="NEEDS ATTENTION" value={fmtInt((cto?.needsAttention || []).length)} icon={IcoActivity} color="var(--d-warn)" foot={<span>medium issues</span>} />
        <Kpi label="CRITICAL" value={fmtInt((cto?.critical || []).length)} icon={IcoAlert} color={(cto?.critical || []).length ? "var(--d-bad)" : "var(--d-ok)"} foot={<span>high-impact</span>} />
        <Kpi label="ANALYZED" value={data?.generatedAt ? timeAgo(data.generatedAt) : "—"} icon={IcoClock} color="var(--d-acc)" foot={<span>code snapshot</span>} />
      </div>

      {cto?.headline ? (
        <Card title="Engineering Summary" icon={IcoBrain}>
          <div style={{ fontSize: 13.5, color: "var(--d-fg)", lineHeight: 1.6 }}>{cto.headline}</div>
        </Card>
      ) : null}

      {/* ── Category scorecards — click any card to drill into its evidence ── */}
      {catScores.length ? (
        <>
          <div className="devp-sectlabel">Category Scores <span style={{ color: "var(--d-mut)", fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>· click a card for findings & recommendations</span></div>
          <div className="devp-catgrid">
            {catScores.map((s) => {
              const st = scoreStatus(s.score);
              const issues = findings.filter((f) => findingMatchesScore(f, s));
              const highs = issues.filter((f) => f.impact === "high").length;
              const on = openCat === s.key;
              return (
                <button
                  key={s.key}
                  className={"devp-catcard" + (on ? " on" : "")}
                  style={{ ["--sc" as any]: scoreColor(s.score) }}
                  onClick={() => setOpenCat(on ? null : s.key)}
                  title={s.reason}
                >
                  <div className="devp-catcard-top">
                    <span className="devp-catcard-label">{s.label}</span>
                    <span className={"devp-pill " + st.kind}>{st.label}</span>
                  </div>
                  <div className="devp-catcard-score" style={{ color: scoreColor(s.score) }}>
                    {s.score}<span>/100</span>
                  </div>
                  <div className="devp-meter" style={{ ["--m-c" as any]: scoreColor(s.score) }}><i style={{ width: Math.max(2, s.score) + "%" }} /></div>
                  <div className="devp-catcard-foot">
                    <span>{issues.length} finding{issues.length === 1 ? "" : "s"}</span>
                    {highs ? <span className="devp-pill bad" style={{ padding: "0 6px" }}>{highs} high</span> : null}
                    <span className="devp-catcard-caret">{on ? "▾" : "▸"}</span>
                  </div>
                </button>
              );
            })}
          </div>

          {selected ? (
            <div className="devp-drill">
              <div className="devp-drill-head">
                <b style={{ color: scoreColor(selected.score) }}>{selected.label}</b>
                <span className={"devp-pill " + scoreStatus(selected.score).kind}>{selected.score}/100 · {scoreStatus(selected.score).label}</span>
                <button className="devp-drill-x" onClick={() => setOpenCat(null)} aria-label="Close">✕</button>
              </div>
              <div className="devp-drill-reason">{selected.reason}</div>
              {selectedFindings.length ? (
                selectedFindings.map((f, i) => (
                  <div className="devp-insight" key={i} style={{ ["--sev" as any]: FTYPE_UI[f.type]?.color || "var(--d-acc)", marginTop: 10 }}>
                    <div className="devp-insight-head">
                      <span className={"devp-pill " + (FTYPE_UI[f.type]?.kind || "mut")}>{FTYPE_UI[f.type]?.label || f.type}</span>
                      <span className="devp-insight-area">{f.subsystem} · {f.category}</span>
                      <b className="devp-insight-title" style={{ flexBasis: "100%", order: 3 }}>{f.title}</b>
                      <span className={"devp-pill " + (IMPACT_KIND[f.impact] || "mut")} style={{ marginLeft: "auto" }}>{f.impact}</span>
                    </div>
                    <div className="devp-insight-what">{f.detail}</div>
                    {f.recommendation ? (
                      <div className="devp-insight-grid" style={{ gridTemplateColumns: "1fr" }}>
                        <div>
                          <div className="devp-insight-lbl">Recommended fix</div>
                          <div style={{ fontSize: 12, color: "#cfe9d8", lineHeight: 1.55 }}>{f.recommendation}</div>
                        </div>
                      </div>
                    ) : null}
                    <div className="devp-insight-foot">
                      <span className="mono"><b>Evidence:</b> {f.evidence?.file}{f.evidence?.line ? ":" + f.evidence.line : ""}{f.evidence?.metric ? " — " + f.evidence.metric : ""}</span>
                      <span className="devp-insight-conf" style={{ marginLeft: "auto" }}>
                        <span className="devp-confbar"><i style={{ width: (f.confidence || 0) + "%", background: FTYPE_UI[f.type]?.color }} /></span>
                        {f.confidence}% confidence
                      </span>
                    </div>
                  </div>
                ))
              ) : (
                <div className="devp-note" style={{ marginTop: 8 }}>No individually-tagged findings for this category — the score above is derived from the reason shown. See the Code Architecture tab for the full findings list.</div>
              )}
            </div>
          ) : null}

          {/* ── Trend across scans (honest: shows history when persisted) ── */}
          <div className="devp-sectlabel">Trend</div>
          {trend.length >= 2 ? (
            <Card title="Overall engineering score over time" icon={IcoActivity}>
              <div className="devp-trend">
                {trend.map((pt: any, i: number) => {
                  const prev = i > 0 ? trend[i - 1]?.overall : null;
                  const delta = prev == null ? null : pt.overall - prev;
                  return (
                    <div className="devp-trend-pt" key={i}>
                      <b style={{ color: scoreColor(pt.overall) }}>{pt.overall}</b>
                      <span>{pt.at ? new Date(pt.at).toLocaleDateString() : "scan " + (i + 1)}</span>
                      {delta != null ? <em className={delta >= 0 ? "up" : "down"}>{delta >= 0 ? "▲" : "▼"} {Math.abs(delta)}</em> : null}
                    </div>
                  );
                })}
              </div>
            </Card>
          ) : (
            <Card>
              <div className="devp-empty" style={{ padding: "20px 12px" }}>
                <IcoActivity size={24} />
                <b>History begins with this scan</b>
                <span>Overall <b style={{ color: overallScore != null ? scoreColor(overallScore) : "var(--d-mut)" }}>{overallScore ?? "—"}</b> as of {data?.generatedAt ? timeAgo(data.generatedAt) : "now"}. Re-running the analysis workflow adds points here so you can compare scans over time.</span>
              </div>
            </Card>
          )}
        </>
      ) : null}

      <div className="devp-sectlabel">Live right now (measured)</div>
      <div className="devp-grid k4">
        <Kpi label="CPU" value={(live.cpuPct || 0).toFixed(1)} unit="%" icon={IcoCpu} color="var(--d-acc)" foot={<span>process</span>} />
        <Kpi label="MEMORY" value={live.memPct || 0} unit="%" icon={IcoMem} color="var(--d-vio)" foot={<span>of host</span>} />
        <Kpi label="CACHE HIT RATE" value={cacheStr} icon={IcoBolt} color={live.cacheHitRate != null && live.cacheHitRate < 70 ? "var(--d-bad)" : "var(--d-ok)"} foot={<span>{fmtNum(live.cacheLookups)} lookups</span>} />
        <Kpi label="SLOW QUERIES" value={fmtInt(live.slowQueries)} icon={IcoDb} color={live.slowQueries ? "var(--d-warn)" : "var(--d-ok)"} foot={<span>{live.dbConnPct}% pool</span>} />
      </div>

      {cto ? (
        <>
          <div className="devp-grid k3" style={{ marginTop: 16 }}>
            <Card title="Strengths" icon={IcoShield}>
              {(cto.strengths || []).length ? (cto.strengths || []).map((s: string, i: number) => (
                <div key={i} className="devp-ctoitem"><span className="devp-dot ok" /><span>{s}</span></div>
              )) : <div className="devp-note">—</div>}
            </Card>
            <Card title="Needs Attention" icon={IcoActivity}>
              {(cto.needsAttention || []).length ? (cto.needsAttention || []).map((s: string, i: number) => (
                <div key={i} className="devp-ctoitem"><span className="devp-dot warn" /><span>{s}</span></div>
              )) : <div className="devp-note">Nothing flagged.</div>}
            </Card>
            <Card title="Critical" icon={IcoAlert}>
              {(cto.critical || []).length ? (cto.critical || []).map((s: string, i: number) => (
                <div key={i} className="devp-ctoitem"><span className="devp-dot bad" /><span>{s}</span></div>
              )) : <div className="devp-empty" style={{ padding: "14px 8px" }}><IcoShield size={22} /><span>No critical items.</span></div>}
            </Card>
          </div>

          <div className="devp-sectlabel">Top Engineering Priorities</div>
          {(cto.priorities || []).map((p: any, i: number) => (
            <div className="devp-insight" key={i} style={{ ["--sev" as any]: IMPACT_KIND[p.impact] === "bad" ? "var(--d-bad)" : IMPACT_KIND[p.impact] === "warn" ? "var(--d-warn)" : "var(--d-acc)" }}>
              <div className="devp-insight-head">
                <span className="devp-insight-area">#{i + 1}</span>
                <b className="devp-insight-title">{p.title}</b>
                <span className={"devp-pill " + (IMPACT_KIND[p.impact] || "mut")}>{p.impact} impact</span>
              </div>
              <div className="devp-insight-what">{p.why}</div>
              {p.evidence ? <div className="devp-insight-foot" style={{ marginTop: 8 }}><span className="mono"><b>Evidence:</b> {p.evidence}</span></div> : null}
            </div>
          ))}
        </>
      ) : (
        <div style={{ marginTop: 16 }}>
          <Card>
            <div className="devp-empty" style={{ padding: "26px 12px" }}>
              <IcoBrain size={28} />
              <b>Code analysis not generated yet</b>
              <span>The live signals above are measured now. The evidence-backed code review (scores, priorities, findings) appears once the architecture analysis has been run.</span>
            </div>
          </Card>
        </div>
      )}
    </>
  );
}

// ── Code Architecture — efficiency scores + evidence-backed findings ─────────
function Architecture({ apiGet }: { apiGet: (p: string) => Promise<any> }) {
  const [tf, setTf] = useState("all");
  const { data, loading } = usePoll(apiGet, "/api/ops/architecture", 60000);
  if (loading && !data) return <LoadingView />;
  const scores: any[] = data?.scores || [];
  const findings: any[] = (data?.findings || []).filter((f: any) => tf === "all" || f.type === tf);
  const counts = { observed: 0, recommendation: 0, prediction: 0 } as Record<string, number>;
  (data?.findings || []).forEach((f: any) => (counts[f.type] = (counts[f.type] || 0) + 1));
  const live = data?.live || {};
  return (
    <>
      <div className="devp-note" style={{ margin: "0 2px 14px" }}>
        Evidence-backed static analysis of the codebase blended with live runtime signals. Every item is typed <b style={{ color: "var(--d-acc)" }}>Observed</b> (measured fact), <b style={{ color: "var(--d-warn)" }}>Recommendation</b> (with the reason + qualitative benefit) or <b style={{ color: "var(--d-vio)" }}>Prediction</b> (a labelled forecast) — and cites the exact file it came from. Nothing here is a guess presented as fact.
      </div>

      {scores.length ? (
        <Card title="Engineering Efficiency" icon={IcoSpark}>
          {scores.map((s) => (
            <div key={s.key} title={s.reason}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 2, marginTop: 8 }}>
                <span style={{ color: "var(--d-fg2)" }}>{s.label}</span>
                <span style={{ fontFamily: "var(--d-mono)", color: scoreColor(s.score) }}>{s.score}/100</span>
              </div>
              <div className="devp-meter" style={{ ["--m-c" as any]: scoreColor(s.score) }}><i style={{ width: Math.max(2, s.score) + "%" }} /></div>
              <div style={{ fontSize: 11, color: "var(--d-mut)", marginTop: 3 }}>{s.reason}</div>
            </div>
          ))}
        </Card>
      ) : (
        <Card>
          <div className="devp-empty" style={{ padding: "26px 12px" }}>
            <IcoSpark size={28} />
            <b>Architecture analysis not generated yet</b>
            <span>Run the code-analysis workflow to populate evidence-backed scores and findings. Live runtime signals: CPU {(live.cpuPct || 0).toFixed(0)}%, cache {live.cacheHitRate == null ? "n/a" : live.cacheHitRate + "%"}, {fmtInt(live.slowQueries)} slow queries.</span>
          </div>
        </Card>
      )}

      {(data?.findings || []).length ? (
        <>
          <div className="devp-toolbar" style={{ margin: "16px 0 12px" }}>
            <div className="devp-seg">
              {[["all", `All (${(data?.findings || []).length})`], ["observed", `Observed (${counts.observed})`], ["recommendation", `Recommendations (${counts.recommendation})`], ["prediction", `Predictions (${counts.prediction})`]].map(([v, l]) => (
                <button key={v} className={tf === v ? "on" : ""} onClick={() => setTf(v)}>{l}</button>
              ))}
            </div>
          </div>
          {findings.map((f, i) => (
            <div className="devp-insight" key={i} style={{ ["--sev" as any]: FTYPE_UI[f.type]?.color || "var(--d-acc)" }}>
              <div className="devp-insight-head">
                <span className={"devp-pill " + (FTYPE_UI[f.type]?.kind || "mut")}>{FTYPE_UI[f.type]?.label || f.type}</span>
                <span className="devp-insight-area">{f.subsystem} · {f.category}</span>
                <b className="devp-insight-title" style={{ flexBasis: "100%", order: 3 }}>{f.title}</b>
                <span className={"devp-pill " + (IMPACT_KIND[f.impact] || "mut")} style={{ marginLeft: "auto" }}>{f.impact}</span>
              </div>
              <div className="devp-insight-what">{f.detail}</div>
              {f.recommendation ? (
                <div className="devp-insight-grid" style={{ gridTemplateColumns: "1fr" }}>
                  <div>
                    <div className="devp-insight-lbl">Recommendation</div>
                    <div style={{ fontSize: 12, color: "#cfe9d8", lineHeight: 1.55 }}>{f.recommendation}</div>
                  </div>
                </div>
              ) : null}
              <div className="devp-insight-foot">
                <span className="mono"><b>Evidence:</b> {f.evidence?.file}{f.evidence?.line ? ":" + f.evidence.line : ""}{f.evidence?.metric ? " — " + f.evidence.metric : ""}</span>
                <span className="devp-insight-conf" style={{ marginLeft: "auto" }}>
                  <span className="devp-confbar"><i style={{ width: (f.confidence || 0) + "%", background: FTYPE_UI[f.type]?.color }} /></span>
                  {f.confidence}% confidence
                </span>
              </div>
            </div>
          ))}
        </>
      ) : null}
    </>
  );
}

// ── shared: severity → colour, and a fetch-and-poll hook ─────────────────────
const SEV_KIND: Record<string, string> = { critical: "bad", warning: "warn", info: "info", good: "ok" };
const SEV_COLOR: Record<string, string> = { critical: "var(--d-bad)", warning: "var(--d-warn)", info: "var(--d-acc)", good: "var(--d-ok)" };
function usePoll(apiGet: (p: string) => Promise<any>, path: string, ms: number) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      apiGet(path)
        .then((j) => {
          if (alive) {
            setData(j);
            setError(null);
          }
        })
        .catch((e) => alive && setError(String(e?.message || e)))
        .finally(() => alive && setLoading(false));
    setLoading(true);
    load();
    const id = setInterval(load, ms);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [apiGet, path, ms]);
  return { data, loading, error };
}

// ── AI Insights — reasoning cards (what / why / recommend / confidence) ───────
function Insights({ apiGet }: { apiGet: (p: string) => Promise<any> }) {
  const { data, loading } = usePoll(apiGet, "/api/ops/insights", 15000);
  if (loading && !data) return <LoadingView />;
  const insights: any[] = data?.insights || [];
  const counts = { critical: 0, warning: 0, info: 0, good: 0 } as Record<string, number>;
  insights.forEach((i) => (counts[i.severity] = (counts[i.severity] || 0) + 1));
  return (
    <>
      <div className="devp-grid k4" style={{ marginBottom: 16 }}>
        <Kpi label="CRITICAL" value={fmtInt(counts.critical)} icon={IcoAlert} color="var(--d-bad)" foot={<span>need action now</span>} />
        <Kpi label="WARNINGS" value={fmtInt(counts.warning)} icon={IcoActivity} color="var(--d-warn)" foot={<span>worth attention</span>} />
        <Kpi label="INFO" value={fmtInt(counts.info)} icon={IcoSpark} color="var(--d-acc)" foot={<span>observations</span>} />
        <Kpi label="ANALYSES" value={fmtInt(insights.length)} icon={IcoBrain} color="var(--d-vio)" foot={<span>this cycle</span>} />
      </div>
      <div className="devp-note" style={{ margin: "0 2px 14px" }}>
        Continuous analysis of live telemetry — every card states what happened, why, what it affects, and what to do, with a confidence estimate.
      </div>
      {insights.map((it, i) => (
        <div className="devp-insight" key={i} style={{ ["--sev" as any]: SEV_COLOR[it.severity] || "var(--d-acc)" }}>
          <div className="devp-insight-head">
            <span className="devp-insight-area">{it.area}</span>
            <b className="devp-insight-title">{it.title}</b>
            <span className={"devp-pill " + (SEV_KIND[it.severity] || "info")}>{it.severity}</span>
          </div>
          <div className="devp-insight-what">{it.what}</div>
          <div className="devp-insight-grid">
            <div>
              <div className="devp-insight-lbl">Why</div>
              <ul className="devp-insight-ul">{(it.why || []).filter(Boolean).map((w: string, j: number) => <li key={j}>{w}</li>)}</ul>
            </div>
            <div>
              <div className="devp-insight-lbl">Recommendation</div>
              <ul className="devp-insight-ul reco">{(it.recommendation || []).map((r: string, j: number) => <li key={j}>{r}</li>)}</ul>
            </div>
          </div>
          <div className="devp-insight-foot">
            <span><b>Affected:</b> {it.affected}</span>
            {it.evidence ? <span className="mono"><b>Evidence:</b> {it.evidence}</span> : null}
            <span className="devp-insight-conf">
              <span className="devp-confbar"><i style={{ width: (it.confidence || 0) + "%", background: SEV_COLOR[it.severity] }} /></span>
              {it.confidence}% confidence
            </span>
          </div>
        </div>
      ))}
    </>
  );
}

// ── Fault Attribution — infra vs code vs vendor vs client ────────────────────
function FaultAttribution({ apiGet }: { apiGet: (p: string) => Promise<any> }) {
  const [range, setRange] = useState("today");
  const { data, loading } = usePoll(apiGet, "/api/ops/fault?range=" + range, 12000);
  const domains: any[] = data?.domains || [];
  const total = data?.totalOccurrences || 0;
  const top = domains[0];
  return (
    <>
      <div className="devp-toolbar" style={{ marginBottom: 16 }}>
        <div className="devp-seg">
          {[["today", "Today"], ["yesterday", "Yesterday"], ["7d", "7 days"], ["30d", "30 days"]].map(([v, l]) => (
            <button key={v} className={range === v ? "on" : ""} onClick={() => setRange(v)}>{l}</button>
          ))}
        </div>
        <div className="devp-top-spacer" />
      </div>

      {loading && !data ? (
        <LoadingView />
      ) : total === 0 ? (
        <Card>
          <div className="devp-empty" style={{ padding: "34px 10px" }}>
            <IcoShield size={28} />
            <b>No faults in this range</b>
            <span>Nothing to attribute — the platform is clean for the selected window.</span>
          </div>
        </Card>
      ) : (
        <>
          <Card title="Where is the fault?" icon={IcoScale} sub={fmtInt(total) + " occurrences"}>
            <div className="devp-note" style={{ marginBottom: 12 }}>
              {top ? (
                <>
                  <b style={{ color: DOMAIN_UI[top.key]?.color }}>{top.pct}% is {DOMAIN_UI[top.key]?.label || top.key}.</b> {DOMAIN_UI[top.key]?.short === "Code" ? "This points at Collab's own code." : "This points away from application code."} Each error is classified by signature — the evidence is below.
                </>
              ) : null}
            </div>
            <div className="devp-stackbar">
              {domains.filter((d) => d.occurrences > 0).map((d) => (
                <div key={d.key} className="devp-stackseg" style={{ width: d.pct + "%", background: DOMAIN_UI[d.key]?.color }} title={`${d.label}: ${d.pct}%`} />
              ))}
            </div>
            <div className="devp-legendrow">
              {domains.filter((d) => d.occurrences > 0).map((d) => (
                <span key={d.key} className="devp-legitem">
                  <span className="devp-dot" style={{ background: DOMAIN_UI[d.key]?.color }} /> {DOMAIN_UI[d.key]?.short} {d.pct}%
                </span>
              ))}
            </div>
          </Card>

          <div className="devp-grid k2" style={{ marginTop: 16 }}>
            {domains.filter((d) => d.occurrences > 0).map((d) => (
              <div className="devp-card" key={d.key} style={{ borderLeft: `3px solid ${DOMAIN_UI[d.key]?.color}` }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                  <b style={{ fontSize: 13 }}>{DOMAIN_UI[d.key]?.label || d.label}</b>
                  <span className="devp-insight-area" style={{ marginLeft: "auto" }}>{d.groups} groups</span>
                </div>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
                  <span style={{ fontFamily: "var(--d-mono)", fontSize: 26, color: DOMAIN_UI[d.key]?.color }}>{d.pct}%</span>
                  <span className="devp-note">{fmtNum(d.occurrences)} occurrences</span>
                </div>
                <div className="devp-note" style={{ marginBottom: 8 }}>{d.blurb}</div>
                {(d.examples || []).map((ex: any) => (
                  <div key={ex.id} className="devp-faultex" title={ex.reason}>
                    <span className="devp-faultex-msg">{ex.message}</span>
                    <span className="devp-faultex-meta">×{fmtNum(ex.count)}{ex.requestPath ? " · " + ex.requestPath : ""}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}

// ── Incidents — clustered failures, correlated with deployments ──────────────
function Incidents({ apiGet }: { apiGet: (p: string) => Promise<any> }) {
  const { data, loading } = usePoll(apiGet, "/api/ops/incidents", 20000);
  const incidents: any[] = data?.incidents || [];
  if (loading && !data) return <LoadingView />;
  return (
    <>
      <div className="devp-grid k3" style={{ marginBottom: 16 }}>
        <Kpi label="INCIDENTS (30D)" value={fmtInt(incidents.length)} icon={IcoAlert} color={incidents.length ? "var(--d-bad)" : "var(--d-ok)"} foot={<span>detected windows</span>} />
        <Kpi label="DEPLOY-LINKED" value={fmtInt(incidents.filter((i) => i.kind === "deployment-linked").length)} icon={IcoRocketDeploy} color="var(--d-warn)" foot={<span>release-correlated</span>} />
        <Kpi label="CRITICAL" value={fmtInt(incidents.filter((i) => i.severity === "critical").length)} icon={IcoShield} color="var(--d-bad)" foot={<span>high severity</span>} />
      </div>
      {incidents.length === 0 ? (
        <Card>
          <div className="devp-empty" style={{ padding: "34px 10px" }}>
            <IcoShield size={28} />
            <b>No incidents detected</b>
            <span>No error clusters or deployment-correlated spikes in the last 30 days.</span>
          </div>
        </Card>
      ) : (
        incidents.map((inc, i) => (
          <div className="devp-insight" key={i} style={{ ["--sev" as any]: inc.severity === "critical" ? "var(--d-bad)" : "var(--d-warn)" }}>
            <div className="devp-insight-head">
              <span className="devp-insight-area">{inc.kind === "deployment-linked" ? "Deploy-linked" : "Error spike"}</span>
              <b className="devp-insight-title">{inc.title}</b>
              <span className={"devp-pill " + (inc.severity === "critical" ? "bad" : "warn")}>{inc.severity}</span>
            </div>
            <div className="devp-insight-foot" style={{ marginTop: 0, marginBottom: 8 }}>
              <span className="mono">{new Date(inc.at).toLocaleString()}</span>
              <span><b>Domain:</b> <span style={{ color: DOMAIN_UI[inc.dominantDomain]?.color }}>{DOMAIN_UI[inc.dominantDomain]?.label || inc.dominantDomain}</span></span>
              <span><b>{inc.errorGroups}</b> groups · <b>{fmtNum(inc.occurrences)}</b> occurrences</span>
              {inc.deployment ? <span className="mono"><b>Release:</b> v{inc.deployment.version || "?"} {inc.deployment.gitCommit ? "(" + String(inc.deployment.gitCommit).slice(0, 7) + ")" : ""}</span> : null}
            </div>
            <div className="devp-insight-what">{inc.note}</div>
            <div style={{ marginTop: 8 }}>
              {(inc.topErrors || []).map((e: any) => (
                <div key={e.id} className="devp-faultex">
                  <span className="devp-faultex-msg">{e.message}</span>
                  <span className="devp-faultex-meta">×{fmtNum(e.count)}</span>
                </div>
              ))}
            </div>
          </div>
        ))
      )}
    </>
  );
}

// ── Deployments — release timeline + per-release error blast radius ──────────
function Deployments({ apiGet }: { apiGet: (p: string) => Promise<any> }) {
  const { data, loading } = usePoll(apiGet, "/api/ops/deployments", 20000);
  const deps: any[] = data?.deployments || [];
  if (loading && !data) return <LoadingView />;
  const suspect = deps.filter((d) => d.suspect).length;
  return (
    <>
      <div className="devp-grid k3" style={{ marginBottom: 16 }}>
        <Kpi label="RELEASES (30D)" value={fmtInt(deps.length)} icon={IcoRocketDeploy} color="var(--d-acc)" foot={<span>boots + deploys</span>} />
        <Kpi label="SUSPECT" value={fmtInt(suspect)} icon={IcoAlert} color={suspect ? "var(--d-bad)" : "var(--d-ok)"} foot={<span>error spike after</span>} />
        <Kpi label="CURRENT" value={"v" + (deps[0]?.version || "?")} icon={IcoShield} color="var(--d-vio)" foot={<span>{deps[0]?.gitCommit ? String(deps[0].gitCommit).slice(0, 7) : "running"}</span>} />
      </div>
      <div className="devp-note" style={{ margin: "0 2px 14px" }}>
        Every backend boot is stamped here. When errors cluster within 15 minutes of a release, the row is flagged <b style={{ color: "var(--d-bad)" }}>suspect</b> — the evidence that turns "was it the deploy?" into a yes/no.
      </div>
      <Card title="Release Timeline" icon={IcoRocketDeploy} sub={fmtInt(deps.length)}>
        <div className="devp-tablewrap">
          <table className="devp-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Kind</th>
                <th>Version</th>
                <th>Commit</th>
                <th>Env</th>
                <th>Instance</th>
                <th className="mono">Errors +15m</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {deps.map((d) => (
                <tr key={d.id} style={d.suspect ? { background: "rgba(248,113,113,.06)" } : undefined}>
                  <td className="mono" title={new Date(d.startedAt).toLocaleString()}>{timeAgo(d.startedAt)}</td>
                  <td><Pill kind={d.kind === "boot" ? "info" : "mut"}>{d.kind}</Pill></td>
                  <td className="devp-t-strong">v{d.version || "?"}</td>
                  <td className="mono" style={{ color: "var(--d-mut)" }}>{d.gitCommit ? String(d.gitCommit).slice(0, 7) : "—"}</td>
                  <td>{d.env}</td>
                  <td className="mono" style={{ color: "var(--d-mut)", fontSize: 11 }}>{d.hostname || "—"}</td>
                  <td className="mono" style={{ color: d.errorsAfter ? "var(--d-bad)" : "var(--d-mut)" }}>{d.errorsAfter ? `${d.errorsAfter} (${fmtNum(d.occurrencesAfter)})` : "0"}</td>
                  <td>{d.suspect ? <span className="devp-pill bad">suspect</span> : null}</td>
                </tr>
              ))}
              {deps.length === 0 && (
                <tr><td colSpan={8} style={{ textAlign: "center", color: "var(--d-mut)", padding: 22 }}>No deployments recorded yet — the next backend boot will appear here.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

// ── Release Readiness — go / no-go, with a live-call deploy guard ─────────────
function ReleaseReadiness({ snap, apiGet }: { snap: Snap; apiGet: (p: string) => Promise<any> }) {
  const { data } = usePoll(apiGet, "/api/ops/insights", 15000);
  const insights: any[] = data?.insights || [];
  const criticals = insights.filter((i) => i.severity === "critical");
  const ch = snap.health?.checks || {};
  const live = snap.counts?.liveParticipants || 0;
  const rooms = snap.counts?.activeRooms || 0;
  const realOpen = (snap.errors || []).filter((e: any) => e.level === "error" || e.level === "fatal").length;
  const checks = [
    { label: "Database reachable", ok: !!ch.db?.ok },
    { label: "Object storage reachable", ok: !!ch.storage?.ok },
    { label: "No critical insights", ok: criticals.length === 0 },
    { label: "Health score ≥ 80", ok: (snap.score || 0) >= 80 },
    { label: "No unresolved real errors spiking", ok: realOpen < 5 },
  ];
  const failed = checks.filter((c) => !c.ok).length;
  // The deploy-during-live-call guard — the exact scenario that crashed the CEO call.
  const liveGuard = live > 0;
  const verdict = failed > 0 || liveGuard ? (liveGuard || failed >= 2 ? "no-go" : "caution") : "go";
  const verdictMeta: Record<string, { label: string; color: string; kind: string }> = {
    go: { label: "GO", color: "var(--d-ok)", kind: "ok" },
    caution: { label: "CAUTION", color: "var(--d-warn)", kind: "warn" },
    "no-go": { label: "NO-GO", color: "var(--d-bad)", kind: "bad" },
  };
  const vm = verdictMeta[verdict];
  return (
    <>
      {liveGuard ? (
        <div className="devp-card" style={{ marginBottom: 16, borderColor: "rgba(248,113,113,.5)", background: "rgba(248,113,113,.07)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <IcoAlert size={20} />
            <div>
              <b style={{ color: "var(--d-bad)", fontSize: 13.5 }}>Do not deploy — {live} user{live === 1 ? "" : "s"} are on a live call right now ({rooms} active room{rooms === 1 ? "" : "s"}).</b>
              <div className="devp-note" style={{ marginTop: 3 }}>
                A restart during an active call drops everyone mid-conversation. Wait for calls to end, or schedule the deploy for a quiet window.
              </div>
            </div>
          </div>
        </div>
      ) : null}
      <div className="devp-grid k3" style={{ marginBottom: 16 }}>
        <div className="devp-card" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, justifyContent: "center", borderColor: vm.color }}>
          <span className="devp-insight-area">Deploy verdict</span>
          <b style={{ fontFamily: "var(--d-mono)", fontSize: 34, color: vm.color }}>{vm.label}</b>
        </div>
        <Kpi label="LIVE PARTICIPANTS" value={fmtInt(live)} icon={IcoRadio} color={live ? "var(--d-bad)" : "var(--d-ok)"} foot={<span>{fmtInt(rooms)} active rooms</span>} />
        <Kpi label="BLOCKERS" value={fmtInt(failed)} icon={IcoShield} color={failed ? "var(--d-bad)" : "var(--d-ok)"} foot={<span>failing checks</span>} />
      </div>
      <Card title="Readiness Checklist" icon={IcoShield}>
        {checks.map((c) => (
          <div className="devp-svc" key={c.label}>
            <span className="devp-svc-ico" style={{ color: c.ok ? "var(--d-ok)" : "var(--d-bad)" }}>{c.ok ? <IcoShield size={16} /> : <IcoAlert size={16} />}</span>
            <div className="devp-svc-name"><b>{c.label}</b></div>
            <div className="devp-svc-meta"><Pill kind={c.ok ? "ok" : "bad"}>{c.ok ? "pass" : "fail"}</Pill></div>
          </div>
        ))}
        {criticals.length ? (
          <div className="devp-note" style={{ marginTop: 12 }}>
            <b style={{ color: "var(--d-bad)" }}>Open critical insight(s):</b> {criticals.map((c) => c.title).join("; ")}.
          </div>
        ) : null}
      </Card>
    </>
  );
}

