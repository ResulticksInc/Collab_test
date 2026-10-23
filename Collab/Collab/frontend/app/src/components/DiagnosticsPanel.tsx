"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  LogEntry,
  LogLevel,
  subscribeLogs,
  clearLogs,
  buildReport,
  initGlobalLogging,
} from "../lib/logger";
import { installTelemetry } from "../lib/telemetry";
import { useDraggableResizable } from "../lib/useDraggableResizable";
import { IconCheck, IconX, IconLightbulb } from "../lib/icons";

// User-friendly diagnostics overlay. Anyone — engineer or not — can open it to
// see a plain-English health summary + event log with directions, and copy a
// shareable report. Toggle: Ctrl+Alt+D, ?diag=1, or window.__colabDiag().

const COLOR: Record<LogLevel, string> = {
  info: "#64748b",
  success: "#16a34a",
  warn: "#d97706",
  error: "#dc2626",
};
// Stroke Lucide status marks (design system: no glyph-as-icon). info/warn keep
// their typographic marks — they read as text, not icons, at this size.
const ICON: Record<LogLevel, ReactNode> = {
  info: "•",
  success: <IconCheck size={11} />,
  warn: "!",
  error: <IconX size={11} />,
};

// Health groups — the most recent matching event decides the status; default OK.
const GROUPS: { key: string; cats: LogEntry["category"][]; ok: string }[] = [
  { key: "Server", cats: ["server"], ok: "Requests succeeding" },
  { key: "Realtime", cats: ["realtime"], ok: "Live channel connected" },
  {
    key: "Calls & media",
    cats: ["call", "meeting", "media"],
    ok: "No issues logged",
  },
  { key: "App", cats: ["app", "auth"], ok: "No errors" },
];

function groupStatus(entries: LogEntry[], cats: LogEntry["category"][]) {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (cats.includes(entries[i].category)) {
      const e = entries[i];
      return { level: e.level, text: e.message, hint: e.hint };
    }
  }
  return { level: "success" as LogLevel, text: "OK", hint: "" };
}

function fmtTime(iso: string) {
  return iso.slice(11, 19);
}

export default function DiagnosticsPanel({
  enabled,
}: {
  enabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [copied, setCopied] = useState(false);
  const [unseenError, setUnseenError] = useState(false);
  // The floating "Connection issue" pill can be dismissed by the user; it
  // re-appears only when a NEW problem is detected (reset once the error clears).
  const [pillDismissed, setPillDismissed] = useState(false);
  const dr = useDraggableResizable({
    storageKey: "colab_diag",
    defaultW: 420,
    defaultH: 560,
    minW: 300,
    maxW: 720,
    minH: 320,
    maxH: 820,
    persist: true,
  });
  useEffect(() => {
    if (!unseenError) setPillDismissed(false);
  }, [unseenError]);
  const lastSeenId = useRef(0);
  const openRef = useRef(false);
  openRef.current = open;

  // Subscribe to the log stream + start global capture once.
  useEffect(() => {
    initGlobalLogging();
    // Forward client errors to the server for aggregation (operator dashboard).
    // Both are idempotent + no-op-safe; order matters only in that telemetry taps
    // the logger's error stream, which initGlobalLogging feeds.
    installTelemetry();
    return subscribeLogs((all) => {
      setEntries(all);
      const newest = all[all.length - 1];
      if (
        newest &&
        !openRef.current &&
        all.some((e) => e.id > lastSeenId.current && e.level === "error")
      ) {
        setUnseenError(true);
      }
    });
  }, []);

  // Toggle: keyboard, URL, window hook.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey || e.metaKey) &&
        e.altKey &&
        (e.key === "d" || e.key === "D")
      ) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    (window as any).__colabDiag = () => setOpen(true);
    try {
      const p = new URLSearchParams(window.location.search);
      if (
        p.get("diag") === "1" ||
        localStorage.getItem("colab_diag") === "1"
      )
        setOpen(true);
    } catch {
      /* ignore */
    }
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Opening marks everything seen + clears the alert.
  useEffect(() => {
    if (open) {
      const last = entries[entries.length - 1];
      if (last) lastSeenId.current = last.id;
      setUnseenError(false);
    }
  }, [open, entries]);

  const copy = () => {
    try {
      navigator.clipboard.writeText(buildReport());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  // Worst health level across all groups — drives the passive float dot colour.
  const worstLevel: LogLevel = GROUPS.reduce<LogLevel>((acc, g) => {
    const lv = groupStatus(entries, g.cats).level;
    const rank: Record<LogLevel, number> = {
      success: 0,
      info: 0,
      warn: 1,
      error: 2,
    };
    return rank[lv] > rank[acc] ? lv : acc;
  }, "success");

  // Mirror the worst health level to the Rail's foot "Diagnostics" item so its
  // status dot reflects real health without the panel needing to be open.
  useEffect(() => {
    try {
      (window as any).__colabDiagLevel = worstLevel;
      window.dispatchEvent(
        new CustomEvent("colab:diag-level", { detail: worstLevel }),
      );
    } catch {}
  }, [worstLevel]);

  // Closed: render nothing. The Rail's Diagnostics foot item (with the live
  // health-level dot) is the single entry point — a separate floating pill
  // duplicated it AND overlapped the rail, so we removed both that and the
  // unseen-error variant. A real problem still surfaces via the Rail dot.
  if (!open) return null;

  const recent = entries.slice(-120).reverse();

  return (
    <div
      ref={dr.rootRef}
      role="dialog"
      aria-label="Diagnostics"
      style={{
        position: "fixed",
        ...(dr.pos
          ? { left: dr.pos.left, top: dr.pos.top }
          : { right: 16, bottom: 16 }),
        zIndex: 4500,
        width: dr.size.w,
        height: dr.size.h,
        display: "flex",
        flexDirection: "column",
        background: "var(--card, #fff)",
        color: "var(--g900, #0f172a)",
        border: "1px solid var(--g200, #e2e8f0)",
        borderRadius: 14,
        boxShadow: "0 24px 60px -18px rgba(0,0,0,0.55)",
        overflow: "hidden",
        font: "13px/1.45 var(--font, system-ui, sans-serif)",
      }}
    >
      {/* Header — drag handle (buttons stay clickable via the hook's guard). */}
      <div
        {...dr.dragHandlers}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "10px 12px",
          borderBottom: "1px solid var(--g200, #e2e8f0)",
          cursor: "grab",
          touchAction: "none",
        }}
      >
        <span style={{ fontWeight: 700, fontSize: 13.5 }}>Diagnostics</span>
        <span style={{ color: "var(--g500, #64748b)", fontSize: 11.5 }}>
          live status &amp; recent events
        </span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          <button onClick={copy} style={{ ...btn, display: "inline-flex", alignItems: "center", gap: 4 }}>
            {copied ? <>Copied <IconCheck size={11} /></> : "Copy report"}
          </button>
          <button onClick={() => clearLogs()} style={btn}>
            Clear
          </button>
          <button onClick={() => setOpen(false)} style={{ ...btn, display: "inline-flex", alignItems: "center" }} aria-label="Close">
            <IconX size={12} />
          </button>
        </div>
      </div>

      {/* Health chips */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 8,
          padding: 12,
          borderBottom: "1px solid var(--g200, #e2e8f0)",
        }}
      >
        {GROUPS.map((g) => {
          const s = groupStatus(entries, g.cats);
          const c = COLOR[s.level];
          const ok = s.level === "success";
          return (
            <div
              key={g.key}
              title={s.hint || (ok ? g.ok : s.text)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "8px 10px",
                borderRadius: 10,
                border: "1px solid var(--g200, #e2e8f0)",
                background: "var(--g50, #f8fafc)",
                minWidth: 0,
              }}
            >
              <span
                style={{
                  width: 18,
                  height: 18,
                  flexShrink: 0,
                  borderRadius: "50%",
                  display: "grid",
                  placeItems: "center",
                  background: c,
                  color: "#fff",
                  fontSize: 11,
                  fontWeight: 800,
                }}
              >
                {ICON[s.level]}
              </span>
              <span style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 12.5 }}>{g.key}</div>
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--g500, #64748b)",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {ok ? g.ok : s.text}
                </div>
              </span>
            </div>
          );
        })}
      </div>

      {/* Event log */}
      <div style={{ flex: 1, overflowY: "auto", padding: "4px 0" }}>
        {recent.length === 0 ? (
          <div
            style={{
              padding: 20,
              textAlign: "center",
              color: "var(--g500, #64748b)",
            }}
          >
            No events yet — everything looks healthy.
          </div>
        ) : (
          recent.map((e) => (
            <div
              key={e.id}
              style={{
                display: "flex",
                gap: 8,
                padding: "7px 12px",
                borderBottom: "1px solid var(--g100, #f1f5f9)",
                alignItems: "flex-start",
              }}
            >
              <span
                style={{
                  color: COLOR[e.level],
                  fontWeight: 800,
                  fontSize: 12,
                  width: 12,
                  flexShrink: 0,
                  textAlign: "center",
                }}
              >
                {ICON[e.level]}
              </span>
              <span style={{ minWidth: 0, flex: 1 }}>
                <div
                  style={{ display: "flex", gap: 6, alignItems: "baseline" }}
                >
                  <span
                    style={{
                      fontSize: 10,
                      color: "var(--g400, #94a3b8)",
                      fontVariantNumeric: "tabular-nums",
                      flexShrink: 0,
                    }}
                  >
                    {fmtTime(e.iso)}
                  </span>
                  <span
                    style={{
                      fontSize: 9.5,
                      fontWeight: 700,
                      textTransform: "uppercase",
                      letterSpacing: 0.4,
                      color: "var(--g400, #94a3b8)",
                      flexShrink: 0,
                    }}
                  >
                    {e.category}
                  </span>
                </div>
                <div style={{ fontSize: 12.5, wordBreak: "break-word" }}>
                  {e.message}
                </div>
                {e.hint ? (
                  <div
                    style={{
                      fontSize: 11.5,
                      color: "var(--g600, #475569)",
                      marginTop: 1,
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 4,
                    }}
                  >
                    <IconLightbulb size={12} style={{ flexShrink: 0, marginTop: 1 }} /> <span>{e.hint}</span>
                  </div>
                ) : null}
              </span>
            </div>
          ))
        )}
      </div>

      {/* Footer hint */}
      <div
        style={{
          padding: "7px 12px",
          borderTop: "1px solid var(--g200, #e2e8f0)",
          fontSize: 11,
          color: "var(--g500, #64748b)",
        }}
      >
        Toggle with <b>Ctrl+Alt+D</b> · drag the header to move · drag the
        corner to resize.
      </div>

      {/* Bottom-right resize handle */}
      <div
        {...dr.resizeHandlers}
        title="Drag to resize"
        style={{
          position: "absolute",
          right: 0,
          bottom: 0,
          width: 16,
          height: 16,
          cursor: "nwse-resize",
          touchAction: "none",
        }}
      >
        <svg
          viewBox="0 0 10 10"
          width="10"
          height="10"
          style={{ position: "absolute", right: 2, bottom: 2, opacity: 0.5 }}
        >
          <path
            d="M9 1 L1 9 M9 4.5 L4.5 9 M9 8 L8 9"
            stroke="var(--g400,#94a3b8)"
            strokeWidth="1"
          />
        </svg>
      </div>
    </div>
  );
}

const btn: React.CSSProperties = {
  fontSize: 11.5,
  fontWeight: 600,
  padding: "4px 9px",
  borderRadius: 8,
  border: "1px solid var(--g200, #e2e8f0)",
  background: "var(--g50, #f8fafc)",
  color: "var(--g700, #334155)",
  cursor: "pointer",
};
