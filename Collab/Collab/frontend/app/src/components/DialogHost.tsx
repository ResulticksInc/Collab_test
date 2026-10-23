import React, { useEffect, useRef, useState } from "react";
import Modal, { Btn, inp } from "./Modal";
import {
  subscribeDialogs,
  resolveDialog,
  type PendingDialog,
} from "../lib/dialog";

// AUDIT #43: the single, app-wide host that renders confirm/prompt/alert requests
// (from lib/dialog) in the Collab-styled Modal instead of the browser's native
// system dialogs. Mounted ONCE (in CoLabV1). Serves the whole app via the module
// queue, so no call site needs its own modal state — a call site just awaits
// confirmDialog/promptDialog/alertDialog.
export default function DialogHost() {
  const [current, setCurrent] = useState<PendingDialog | null>(null);
  const [value, setValue] = useState("");
  const [choice, setChoice] = useState("");
  const [remember, setRemember] = useState(false);
  // When a new request becomes current, seed the prompt input / choice selection.
  const currentId = current?.id;
  useEffect(() => {
    if (current && current.req.kind === "prompt") {
      setValue(current.req.defaultValue || "");
    } else if (current && current.req.kind === "choice") {
      setChoice(current.req.options?.[0]?.value || "");
      setRemember(false);
    }
  }, [currentId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => subscribeDialogs(setCurrent), []);

  // Focus the primary control / input once the dialog mounts.
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (current && current.req.kind === "prompt") {
      // Defer so Modal's own focus setup (runs on mount) doesn't override this.
      const t = setTimeout(() => {
        const el = inputRef.current;
        if (el) {
          el.focus();
          try {
            (el as HTMLInputElement).select();
          } catch {
            /* textarea has no select semantics we need */
          }
        }
      }, 0);
      return () => clearTimeout(t);
    }
  }, [currentId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!current) return null;
  const { id, req } = current;
  const isPrompt = req.kind === "prompt";
  const isConfirm = req.kind === "confirm";
  const isChoice = req.kind === "choice";

  // Resolve helpers. `resolveDialog` advances the queue; setCurrent follows via
  // the subscription, so we don't touch `current` directly here.
  const cancel = () => resolveDialog(id, isPrompt || isChoice ? null : false);
  const accept = () =>
    isChoice
      ? resolveDialog(id, { value: choice, remember })
      : resolveDialog(id, isPrompt ? value : true);

  const confirmLabel =
    req.confirmText ||
    (isChoice ? "Continue" : isPrompt ? "OK" : isConfirm ? "Confirm" : "OK");
  const cancelLabel = req.cancelText || "Cancel";

  const dangerBtn: React.CSSProperties = {
    padding: "8px 14px",
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    border: "none",
    background: "var(--danger-fg, #dc2626)",
    color: "#fff",
  };

  return (
    <Modal
      title={req.title || (isConfirm ? "Confirm" : isPrompt ? "" : "Notice")}
      onClose={cancel}
      draggable={false}
      // The app-wide dialog host must sit ABOVE whatever surface launched it —
      // OrgAdmin's panel (4000), pickers (9999), etc. — otherwise a confirm opened
      // from inside one of those renders BEHIND it, unclickable, so the awaited
      // promise never resolves (the "Remove member did nothing, no error" bug).
      zIndex={15000}
      footer={
        <>
          {req.kind !== "alert" ? (
            <Btn onClick={cancel}>{cancelLabel}</Btn>
          ) : null}
          {req.danger && isConfirm ? (
            <button style={dangerBtn} onClick={accept}>
              {confirmLabel}
            </button>
          ) : (
            <Btn primary onClick={accept}>
              {confirmLabel}
            </Btn>
          )}
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {req.message ? (
          <p
            style={{
              fontSize: 13.5,
              lineHeight: 1.5,
              color: "var(--g700)",
              whiteSpace: "pre-wrap",
              margin: 0,
            }}
          >
            {req.message}
          </p>
        ) : null}
        {isPrompt ? (
          req.multiline ? (
            <textarea
              ref={(el) => {
                inputRef.current = el;
              }}
              value={value}
              placeholder={req.placeholder || ""}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) accept();
              }}
              rows={4}
              style={{ ...inp, resize: "vertical", minHeight: 88 }}
            />
          ) : (
            <input
              ref={(el) => {
                inputRef.current = el;
              }}
              value={value}
              placeholder={req.placeholder || ""}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") accept();
              }}
              style={inp}
            />
          )
        ) : null}
        {isChoice && req.options ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {req.options.map((o) => {
              const on = choice === o.value;
              return (
                <label
                  key={o.value}
                  style={{
                    display: "flex",
                    gap: 10,
                    alignItems: "flex-start",
                    padding: "10px 12px",
                    border: "1.5px solid " + (on ? "var(--ac)" : "var(--g200)"),
                    borderRadius: 10,
                    cursor: "pointer",
                    background: on
                      ? "color-mix(in srgb, var(--ac) 8%, transparent)"
                      : "transparent",
                  }}
                >
                  <input
                    type="radio"
                    name="dlg-choice"
                    checked={on}
                    onChange={() => setChoice(o.value)}
                    style={{ marginTop: 2, accentColor: "var(--ac)" }}
                  />
                  <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    <span style={{ fontSize: 13.5, fontWeight: 600, color: "var(--g800)" }}>
                      {o.label}
                    </span>
                    {o.description ? (
                      <span style={{ fontSize: 12, color: "var(--g500)", lineHeight: 1.4 }}>
                        {o.description}
                      </span>
                    ) : null}
                  </span>
                </label>
              );
            })}
            {req.rememberLabel ? (
              <label
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                  marginTop: 2,
                  cursor: "pointer",
                  fontSize: 13,
                  color: "var(--g700)",
                }}
              >
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                  style={{ accentColor: "var(--ac)" }}
                />
                {req.rememberLabel}
              </label>
            ) : null}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
