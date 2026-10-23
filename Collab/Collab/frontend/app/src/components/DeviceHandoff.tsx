import { useEffect, useState } from "react";
import { EVENTS } from "../lib/socket";

// ── Device Handoff (P0-12) ──────────────────────────────────────────────────
// Move (or extend) an active call / group call / meeting to another of the
// user's OWN signed-in devices — Teams' "Move to another device".
//
// Flow: source opens the picker (devices come from the authenticated session
// list + live socket presence, no codes/links/re-auth) → HANDOFF_REQUEST →
// the target device shows the offer prompt → Accept joins the same room and
// HANDOFF_ACCEPT routes back → the source (mode "move") quietly drops its
// media while the call/meeting itself keeps running. "Continue here too"
// (mode "join") joins WITHOUT the source leaving — LiveKit identities are
// per-join (userId__uuid), so one user can hold two live devices.

export type HandoffContext = {
  kind: "call" | "meeting";
  callId?: string | null;
  conversationId?: string | null;
  meetingId?: string | null;
  title?: string | null;
  video?: boolean;
  peer?: any;
};

const backdrop: any = {
  position: "fixed",
  inset: 0,
  background: "rgba(15,10,25,0.45)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 4200,
};
const sheet: any = {
  width: "min(420px, 92vw)",
  background: "var(--meet-pop, #1b1f2a)",
  border: "1px solid var(--meet-pop-line, rgba(255,255,255,0.12))",
  borderRadius: 14,
  boxShadow: "0 24px 60px rgba(0,0,0,0.45)",
  padding: 16,
  color: "var(--meet-fg, #fff)",
};
const rowBtn: any = {
  height: 30,
  padding: "0 12px",
  borderRadius: 8,
  border: "1px solid var(--meet-pop-line, rgba(255,255,255,0.16))",
  background: "transparent",
  color: "inherit",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};

function platformGlyph(p: string) {
  return p === "desktop" ? "🖥️" : "🌐";
}

export function DeviceHandoffPicker({
  socket,
  ctx,
  onClose,
  showToast,
}: {
  socket: any;
  ctx: HandoffContext;
  onClose: () => void;
  showToast: (m: string) => void;
}) {
  const [devices, setDevices] = useState<any[] | null>(null);
  useEffect(() => {
    let alive = true;
    if (!socket) {
      setDevices([]);
      return;
    }
    try {
      socket.emit(EVENTS.DEVICES_LIST, {}, (res: any) => {
        if (alive) setDevices((res && res.devices) || []);
      });
    } catch (_) {
      setDevices([]);
    }
    return () => {
      alive = false;
    };
  }, [socket]);

  const others = (devices || []).filter((d) => !d.current);
  const send = (d: any, mode: "move" | "join") => {
    try {
      socket &&
        socket.emit(EVENTS.HANDOFF_REQUEST, { toSessionId: d.id, mode, ...ctx });
      showToast(
        mode === "move"
          ? `Asking ${d.deviceLabel} to take over…`
          : `Asking ${d.deviceLabel} to join too…`,
      );
    } catch (_) {}
    onClose();
  };

  return (
    <div style={backdrop} onClick={onClose} role="dialog" aria-label="Move to another screen">
      <div style={sheet} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontSize: 14.5, fontWeight: 700, marginBottom: 2 }}>
          {/* Title renamed by request. The body below deliberately still says
              "signed-in devices", because that is literally what this lists and
              what the user has to act on — calling them "screens" would send
              someone hunting for a second monitor. */}
          Move {ctx.kind === "meeting" ? "meeting" : "call"} to another screen
        </div>
        <div style={{ fontSize: 12, color: "var(--meet-sub, #9aa3b2)", marginBottom: 12 }}>
          Your signed-in devices. <b>Move</b> switches over (this device leaves);{" "}
          <b>Join too</b> adds the other device while this one stays connected.
        </div>
        {devices === null ? (
          <div style={{ fontSize: 12.5, color: "var(--meet-sub, #9aa3b2)", padding: "10px 0" }}>
            Finding your devices…
          </div>
        ) : others.length === 0 ? (
          <div style={{ fontSize: 12.5, color: "var(--meet-sub, #9aa3b2)", padding: "10px 0" }}>
            No other signed-in devices. Sign in to Collab on your other device
            (browser or desktop app), then try again.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: "48vh", overflowY: "auto" }}>
            {others.map((d) => (
              <div
                key={d.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "9px 10px",
                  borderRadius: 10,
                  border: "1px solid var(--meet-pop-line, rgba(255,255,255,0.1))",
                  opacity: d.online ? 1 : 0.55,
                }}
              >
                <span aria-hidden="true" style={{ fontSize: 17 }}>
                  {platformGlyph(d.platform)}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {d.deviceLabel}
                  </div>
                  <div style={{ fontSize: 11, color: d.online ? "#22c55e" : "var(--meet-sub, #9aa3b2)" }}>
                    {d.online ? "● Online now" : "Offline"}
                  </div>
                </div>
                <button
                  style={{ ...rowBtn, opacity: d.online ? 1 : 0.4, cursor: d.online ? "pointer" : "not-allowed" }}
                  disabled={!d.online}
                  onClick={() => send(d, "move")}
                >
                  Move
                </button>
                <button
                  style={{ ...rowBtn, opacity: d.online ? 1 : 0.4, cursor: d.online ? "pointer" : "not-allowed" }}
                  disabled={!d.online}
                  onClick={() => send(d, "join")}
                >
                  Join too
                </button>
              </div>
            ))}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 14 }}>
          <button style={rowBtn} onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// Meeting duplicate-device prompt (Session Mgmt Phase 3c). Shown on the device
// that JUST joined a meeting it's already in on another device. "Move here" tells
// the other device to leave; "Join on both" keeps both (companion); "Cancel"
// leaves the meeting on THIS device.
export function MeetingDuplicatePrompt({
  dup,
  onMove,
  onCompanion,
  onCancel,
}: {
  dup: any;
  onMove: () => void;
  onCompanion: () => void;
  onCancel: () => void;
}) {
  if (!dup) return null;
  const devices: any[] = Array.isArray(dup.devices) ? dup.devices : [];
  const other =
    devices.length === 1
      ? devices[0].deviceLabel || "another device"
      : devices.length > 1
        ? `${devices.length} other devices`
        : "another device";
  return (
    <div style={backdrop} role="alertdialog" aria-label="Already in this meeting elsewhere">
      <div style={sheet}>
        <div style={{ fontSize: 14.5, fontWeight: 700, marginBottom: 4 }}>
          You're already in this meeting
        </div>
        <div style={{ fontSize: 12.5, color: "var(--meet-sub, #9aa3b2)", marginBottom: 14 }}>
          You joined this meeting on <b>{other}</b>. Move it here, stay on both, or
          cancel joining on this device.
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
          <button style={rowBtn} onClick={onCancel}>
            Cancel
          </button>
          <button style={rowBtn} onClick={onCompanion}>
            Join on both
          </button>
          <button
            style={{
              ...rowBtn,
              background: "var(--ac, #6366f1)",
              borderColor: "var(--ac, #6366f1)",
              color: "#fff",
            }}
            onClick={onMove}
          >
            Move here
          </button>
        </div>
      </div>
    </div>
  );
}

export function HandoffOfferPrompt({
  offer,
  onAccept,
  onDecline,
}: {
  offer: any;
  onAccept: () => void;
  onDecline: () => void;
}) {
  if (!offer) return null;
  const what =
    offer.kind === "meeting"
      ? `the meeting${offer.title ? ` “${offer.title}”` : ""}`
      : `your current call${offer.title ? ` with ${offer.title}` : ""}`;
  return (
    <div style={backdrop} role="alertdialog" aria-label="Continue on this device">
      <div style={sheet}>
        <div style={{ fontSize: 14.5, fontWeight: 700, marginBottom: 4 }}>
          Continue on this device?
        </div>
        <div style={{ fontSize: 12.5, color: "var(--meet-sub, #9aa3b2)", marginBottom: 14 }}>
          {offer.fromLabel || "Another device"} wants this device to{" "}
          {offer.mode === "join" ? "ALSO join" : "take over"} {what}.
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button style={rowBtn} onClick={onDecline}>
            Not now
          </button>
          <button
            style={{
              ...rowBtn,
              background: "var(--ac, #6366f1)",
              borderColor: "var(--ac, #6366f1)",
              color: "#fff",
            }}
            onClick={onAccept}
          >
            Continue here
          </button>
        </div>
      </div>
    </div>
  );
}
