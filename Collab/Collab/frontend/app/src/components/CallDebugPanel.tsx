import { useEffect, useRef, useState } from "react";
import {
  CallDiagnostics,
  DiagSnapshot,
  isCallDebugEnabled,
} from "../lib/callDiagnostics";
import { IconChevronDown, IconChevronRight, IconX, IconCheck, IconAlertTriangle } from "../lib/icons";

// Format a kbps number compactly: 380 -> "380k", 1500 -> "1.5M".
function fmtRate(k: number | null | undefined): string {
  if (k == null) return "—";
  if (k >= 1000) return (k / 1000).toFixed(k >= 10000 ? 0 : 1) + "M";
  return Math.round(k) + "k";
}

// ── Opt-in mini-stat ─────────────────────────────────────────────────────────
// Live latency + throughput shown next to the call / meeting name. WebRTC
// diagnostics are OFF by default: the chip only appears when the user opts in via
// the "WebRTC diagnostics" setting (`enabled`) or under the QA localStorage /
// ?calldebug override — so calls stay visually clean for everyone else. Reuses
// the same diagnostics snapshot (updates each ~1.5s poll).
export function CallStatChip({
  diag,
  enabled,
}: {
  diag: CallDiagnostics | null;
  enabled?: boolean;
}) {
  const [snap, setSnap] = useState<DiagSnapshot | null>(null);
  useEffect(() => {
    if (!diag) return;
    return diag.subscribe(setSnap);
  }, [diag]);
  if (!diag || !snap || !(enabled || isCallDebugEnabled())) return null;
  const lat = snap.rttMs;
  const dot =
    lat == null
      ? "#94a3b8"
      : lat < 150
        ? "#22c55e"
        : lat < 300
          ? "#f59e0b"
          : "#ef4444";
  return (
    <span
      className="call-stat-chip"
      title={`Connection quality — ${lat == null ? "measuring…" : lat + " ms latency"} · ${fmtRate(snap.inKbps)}↓ ${fmtRate(snap.outKbps)}↑${snap.turnUsed ? " · relayed (TURN)" : ""}`}
    >
      <span className="call-stat-dot" style={{ background: dot }} />
      <span className="call-stat-num">{lat == null ? "—" : lat + "ms"}</span>
      <span className="call-stat-sep" />
      <span className="call-stat-num call-stat-tp">
        {fmtRate(snap.inKbps)}↓ {fmtRate(snap.outKbps)}↑
      </span>
    </span>
  );
}

// localStorage persistence for the draggable panel's position + width.
const POS_KEY = "colab_calldebug_pos";
const W_KEY = "colab_calldebug_w";
const DISMISS_KEY = "colab_calldebug_dismissed";
const PILL_POS_KEY = "colab_calldebug_pillpos";
const clamp = (n: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, n));
function loadPos(): { left: number; top: number } | null {
  try {
    const v = JSON.parse(localStorage.getItem(POS_KEY) || "null");
    if (v && typeof v.left === "number" && typeof v.top === "number") return v;
  } catch {
    /* ignore */
  }
  return null;
}
function loadPillPos(): { left: number; top: number } | null {
  try {
    const v = JSON.parse(localStorage.getItem(PILL_POS_KEY) || "null");
    if (v && typeof v.left === "number" && typeof v.top === "number") return v;
  } catch {
    /* ignore */
  }
  return null;
}
function loadW(): number {
  try {
    const v = parseInt(localStorage.getItem(W_KEY) || "", 10);
    if (v >= 220 && v <= 560) return v;
  } catch {
    /* ignore */
  }
  return 264;
}

// ── Full WebRTC diagnostics panel ────────────────────────────────────────────
// Draggable (grab the header), resizable (corner handle), collapsible. Gated
// behind the "Enable WebRTC diagnostics" accessibility setting (`full`) in
// production, with the dev / localStorage / ?calldebug override preserved for QA.
export default function CallDebugPanel({
  diag,
  full,
}: {
  diag: CallDiagnostics | null;
  full?: boolean;
}) {
  const [snap, setSnap] = useState<DiagSnapshot | null>(null);
  const [open, setOpen] = useState(true);
  const [showLog, setShowLog] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(loadPos);
  const [w, setW] = useState<number>(loadW);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{
    ox: number;
    oy: number;
    sx: number;
    sy: number;
    moved: boolean;
  } | null>(null);
  const rsz = useRef<{ sx: number; sw: number } | null>(null);
  const [pillPos, setPillPos] = useState(loadPillPos);
  const pillDrag = useRef<{
    ox: number;
    oy: number;
    sx: number;
    sy: number;
    moved: boolean;
  } | null>(null);
  // Dismissal: the panel could previously only collapse, never close — so it
  // sat on screen for the whole call. This adds a real close (persisted) plus a
  // reopen affordance. Reopening also happens by re-enabling the diagnostics
  // setting / ?calldebug.
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === "1";
    } catch {
      return false;
    }
  });
  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* ignore */
    }
  };
  const reopen = () => {
    setDismissed(false);
    try {
      localStorage.removeItem(DISMISS_KEY);
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    if (!diag) return;
    return diag.subscribe(setSnap);
  }, [diag]);

  if (!diag || !snap || !(full || isCallDebugEnabled())) return null;

  const iceColor =
    snap.iceState === "connected" || snap.iceState === "completed"
      ? "#22c55e"
      : snap.iceState === "failed"
        ? "#ef4444"
        : snap.iceState === "disconnected"
          ? "#f59e0b"
          : "#94a3b8";
  const turnColor = snap.turnUsed
    ? "#a855f7"
    : snap.turnAdvertised
      ? "#94a3b8"
      : "#ef4444";
  const lossColor =
    snap.packetLossPct == null
      ? "#94a3b8"
      : snap.packetLossPct > 5
        ? "#ef4444"
        : snap.packetLossPct > 1
          ? "#f59e0b"
          : "#22c55e";

  // Dismissed → collapse to an unobtrusive reopen pill (state persisted). This
  // is the close affordance the panel previously lacked; click it to bring the
  // full diagnostics back.
  if (dismissed) {
    // Draggable: drag to move (persisted), click (no movement) to reopen — frees
    // it from the fixed bottom-left spot where it overlapped the call dock.
    const onPillDown = (e: React.PointerEvent) => {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const left = pillPos ? pillPos.left : r.left;
      const top = pillPos ? pillPos.top : r.top;
      pillDrag.current = {
        ox: e.clientX - left,
        oy: e.clientY - top,
        sx: e.clientX,
        sy: e.clientY,
        moved: false,
      };
      setPillPos({ left, top });
      try {
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    };
    const onPillMove = (e: React.PointerEvent) => {
      const d = pillDrag.current;
      if (!d) return;
      if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 4)
        d.moved = true;
      if (d.moved)
        setPillPos({
          left: clamp(e.clientX - d.ox, 4, window.innerWidth - 60),
          top: clamp(e.clientY - d.oy, 4, window.innerHeight - 32),
        });
    };
    const onPillUp = (e: React.PointerEvent) => {
      const d = pillDrag.current;
      pillDrag.current = null;
      try {
        (e.currentTarget as Element).releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      if (d && d.moved) {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        try {
          localStorage.setItem(
            PILL_POS_KEY,
            JSON.stringify({ left: Math.round(r.left), top: Math.round(r.top) }),
          );
        } catch {
          /* ignore */
        }
      } else {
        reopen();
      }
    };
    return (
      <button
        onPointerDown={onPillDown}
        onPointerMove={onPillMove}
        onPointerUp={onPillUp}
        title="Drag to move · click to reopen WebRTC diagnostics"
        style={{
          position: "fixed",
          ...(pillPos
            ? { left: pillPos.left, top: pillPos.top }
            : { left: 16, bottom: 16 }),
          zIndex: 9999,
          touchAction: "none",
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 10px",
          borderRadius: 999,
          background: "rgba(20,24,34,0.92)",
          color: "#cbd5e1",
          border: "1px solid rgba(255,255,255,0.14)",
          backdropFilter: "blur(10px)",
          WebkitBackdropFilter: "blur(10px)",
          boxShadow: "0 10px 30px -12px rgba(0,0,0,0.6)",
          font: "11px/1 ui-monospace, SFMono-Regular, Menlo, monospace",
          cursor: "grab",
        }}
      >
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: iceColor,
            boxShadow: `0 0 8px ${iceColor}`,
          }}
        />
        diagnostics
      </button>
    );
  }

  // ── Drag (header) — fixed-position, clamped to the viewport, persisted. A
  //    click (no movement) toggles collapse; a drag (>4px) moves the panel. ──
  const onDragDown = (e: React.PointerEvent) => {
    const r = rootRef.current?.getBoundingClientRect();
    const left = pos ? pos.left : r ? r.left : 16;
    const top = pos ? pos.top : r ? r.top : 16;
    drag.current = {
      ox: e.clientX - left,
      oy: e.clientY - top,
      sx: e.clientX,
      sy: e.clientY,
      moved: false,
    };
    setPos({ left, top });
    try {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };
  const onDragMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 4)
      d.moved = true;
    setPos({
      left: clamp(e.clientX - d.ox, 4, window.innerWidth - 60),
      top: clamp(e.clientY - d.oy, 4, window.innerHeight - 32),
    });
  };
  const onDragUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    try {
      (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (d && d.moved) {
      const r = rootRef.current?.getBoundingClientRect();
      if (r)
        try {
          localStorage.setItem(
            POS_KEY,
            JSON.stringify({
              left: Math.round(r.left),
              top: Math.round(r.top),
            }),
          );
        } catch {
          /* ignore */
        }
    } else {
      setOpen((v) => !v); // it was a click, not a drag → toggle collapse
    }
  };

  // ── Resize (bottom-right handle) — width only; height is content-driven. ──
  const onRszDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    rsz.current = { sx: e.clientX, sw: w };
    try {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };
  const onRszMove = (e: React.PointerEvent) => {
    if (!rsz.current) return;
    setW(clamp(rsz.current.sw + (e.clientX - rsz.current.sx), 220, 560));
  };
  const onRszUp = (e: React.PointerEvent) => {
    rsz.current = null;
    try {
      (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    const r = rootRef.current?.getBoundingClientRect();
    if (r)
      try {
        localStorage.setItem(W_KEY, String(Math.round(r.width)));
      } catch {
        /* ignore */
      }
  };

  const Row = ({ k, v, color }: { k: string; v: any; color?: string }) => (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 14,
        padding: "1.5px 0",
      }}
    >
      <span style={{ color: "#8b95a7" }}>{k}</span>
      <span
        style={{
          color: color || "#e5e7eb",
          fontWeight: 600,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {v}
      </span>
    </div>
  );

  return (
    <div
      ref={rootRef}
      style={{
        position: "fixed",
        zIndex: 9999,
        ...(pos ? { left: pos.left, top: pos.top } : { left: 16, bottom: 16 }),
        width: open ? w : "auto",
        background:
          "linear-gradient(180deg, rgba(20,24,34,0.96), rgba(11,13,20,0.96))",
        backdropFilter: "blur(14px)",
        WebkitBackdropFilter: "blur(14px)",
        border: "1px solid rgba(255,255,255,0.14)",
        borderRadius: 14,
        color: "#e5e7eb",
        font: "11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace",
        boxShadow: "0 18px 50px -16px rgba(0,0,0,0.7)",
        userSelect: "none",
        overflow: "hidden",
      }}
    >
      <div
        onPointerDown={onDragDown}
        onPointerMove={onDragMove}
        onPointerUp={onDragUp}
        title="Drag to move · click to collapse"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 10px",
          cursor: "grab",
          touchAction: "none",
          borderBottom: open ? "1px solid rgba(255,255,255,0.08)" : "none",
        }}
      >
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: iceColor,
            boxShadow: `0 0 8px ${iceColor}`,
            flexShrink: 0,
          }}
        />
        <span
          style={{
            fontWeight: 700,
            letterSpacing: 0.5,
            fontSize: 10,
            textTransform: "uppercase",
            color: "#cbd5e1",
          }}
        >
          WebRTC
        </span>
        <span style={{ color: iceColor, fontWeight: 700 }}>
          {snap.iceState}
        </span>
        <span style={{ marginLeft: "auto", color: "#64748b", display: "inline-flex", alignItems: "center" }}>
          {open ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
        </span>
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            dismiss();
          }}
          title="Close diagnostics"
          aria-label="Close diagnostics"
          style={{
            padding: "0 2px",
            background: "transparent",
            border: "none",
            color: "#94a3b8",
            cursor: "pointer",
            lineHeight: 1,
            display: "inline-flex",
            alignItems: "center",
          }}
        >
          <IconX size={14} />
        </button>
      </div>

      {open && (
        <div style={{ padding: "8px 10px 10px", userSelect: "text" }}>
          <Row k="signal" v={snap.signalState} />
          <Row k="connection" v={snap.connectionState} />
          <Row k="ice" v={snap.iceState} color={iceColor} />
          <Row
            k="candidate"
            v={`${snap.selectedLocalType || "?"}/${snap.selectedProtocol || "?"} ⇄ ${snap.selectedRemoteType || "?"}`}
          />
          <Row
            k="TURN used?"
            v={snap.turnUsed ? "YES (relay)" : "no (direct)"}
            color={turnColor}
          />
          {!snap.turnAdvertised && (
            <Row k="TURN advertised" v={<>NONE <IconAlertTriangle size={11} style={{ verticalAlign: "-1px" }} /></>} color="#ef4444" />
          )}
          <Row k="latency" v={snap.rttMs == null ? "—" : snap.rttMs + " ms"} />
          <Row
            k="packet loss"
            v={snap.packetLossPct == null ? "—" : snap.packetLossPct + " %"}
            color={lossColor}
          />
          <Row
            k="throughput"
            v={`${snap.inKbps ?? "—"}↓ / ${snap.outKbps ?? "—"}↑ kbps`}
          />

          <div style={{ display: "flex", gap: 6, marginTop: 9 }}>
            <button
              onClick={() => {
                try {
                  navigator.clipboard.writeText(diag.copyText());
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1400);
                } catch {
                  /* ignore */
                }
              }}
              style={btn}
            >
              {copied ? <>copied <IconCheck size={11} style={{ verticalAlign: "-1px" }} /></> : "copy"}
            </button>
            <button onClick={() => setShowLog((v) => !v)} style={btn}>
              {showLog ? "hide log" : `log (${snap.events.length})`}
            </button>
          </div>

          {showLog && (
            <div
              style={{
                marginTop: 8,
                maxHeight: 150,
                overflowY: "auto",
                borderTop: "1px solid rgba(255,255,255,0.08)",
                paddingTop: 7,
                color: "#cbd5e1",
              }}
            >
              {snap.events
                .slice(-60)
                .reverse()
                .map((e, i) => (
                  <div
                    key={i}
                    style={{
                      padding: "1px 0",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    <span style={{ color: "#64748b" }}>
                      {e.iso.slice(11, 19)}{" "}
                    </span>
                    <span
                      style={{
                        color:
                          e.event === "ICE Failed" || e.event === "Media Error"
                            ? "#f87171"
                            : e.event === "ICE Connected" ||
                                e.event === "Room Joined"
                              ? "#4ade80"
                              : "#e5e7eb",
                        fontWeight: 600,
                      }}
                    >
                      {e.event}
                    </span>
                    {e.data ? (
                      <span style={{ color: "#8b95a7" }}>
                        {" "}
                        {JSON.stringify(e.data)}
                      </span>
                    ) : null}
                  </div>
                ))}
            </div>
          )}

          {/* Resize handle (width) */}
          <div
            onPointerDown={onRszDown}
            onPointerMove={onRszMove}
            onPointerUp={onRszUp}
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
              style={{
                position: "absolute",
                right: 2,
                bottom: 2,
                opacity: 0.55,
              }}
            >
              <path
                d="M9 1 L1 9 M9 4.5 L4.5 9 M9 8 L8 9"
                stroke="#94a3b8"
                strokeWidth="1"
              />
            </svg>
          </div>
        </div>
      )}
    </div>
  );
}

const btn: React.CSSProperties = {
  flex: 1,
  fontSize: 10,
  fontFamily: "inherit",
  padding: "5px 6px",
  borderRadius: 7,
  border: "1px solid rgba(255,255,255,0.16)",
  background: "rgba(255,255,255,0.06)",
  color: "#e5e7eb",
  cursor: "pointer",
};
