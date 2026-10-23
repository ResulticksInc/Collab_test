import React, { useEffect, useMemo, useRef, useState } from "react";
import { IconChevronDown, IconCheck } from "../lib/icons";

// A filterable dropdown (combobox) for long option lists like the ~400 IANA
// timezones, where a native <select> only offers first-letter type-ahead. Click to
// open, type to filter (matches the label OR the value, e.g. "kolkata" or "asia"),
// click a result to pick. Styled to match the chat more popup style.
export default function SearchableSelect({
  value,
  options,
  onChange,
  placeholder = "Type to search…",
}: {
  value: string;
  options: [string, string][];
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const current = options.find((o) => o[0] === value);
  const label = current ? current[1] : value || "";

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return options;
    return options.filter(
      ([v, t]) => t.toLowerCase().includes(s) || v.toLowerCase().includes(s),
    );
  }, [q, options]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // Reset the filter and focus the search box each time the menu opens, so typing
  // starts filtering immediately (task: "when I type it should search").
  useEffect(() => {
    if (open) {
      setQ("");
      const id = setTimeout(() => inputRef.current && inputRef.current.focus(), 0);
      return () => clearTimeout(id);
    }
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        className={`av-select ${open ? "open" : ""}`}
        onClick={() => setOpen((o) => !o)}
        style={{
          textAlign: "left",
          width: "100%",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {label}
        </span>
        <span
          style={{
            color: "var(--g400)",
            marginLeft: 8,
            display: "inline-flex",
            alignItems: "center",
            transition: "transform 0.18s ease",
            transform: open ? "rotate(180deg)" : "none",
          }}
        >
          <IconChevronDown size={14} />
        </span>
      </button>
      {open ? (
        <div
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            right: 0,
            zIndex: 3000,
            marginTop: 4,
            background: "var(--sb, #fff)",
            border: "1px solid var(--g200)",
            borderRadius: 10,
            boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
            padding: 4,
            overflow: "hidden",
            animation: "fm-slide-in 0.12s ease-out",
          }}
        >
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={placeholder}
            style={{
              width: "100%",
              boxSizing: "border-box",
              padding: "8px 10px",
              border: "1px solid var(--g200)",
              borderRadius: 6,
              marginBottom: 4,
              outline: "none",
              fontSize: 13,
              background: "var(--surface-hover, var(--g50))",
              color: "var(--g900)",
            }}
          />
          <div style={{ maxHeight: 240, overflowY: "auto" }}>
            {filtered.length ? (
              filtered.map(([v, t]) => {
                const isSelected = v === value;
                return (
                  <button
                    type="button"
                    key={v}
                    onClick={() => {
                      onChange(v);
                      setOpen(false);
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      width: "100%",
                      textAlign: "left",
                      padding: "8px 10px",
                      borderRadius: 6,
                      border: "none",
                      background: isSelected ? "var(--g100)" : "transparent",
                      cursor: "pointer",
                      fontSize: 13,
                      fontWeight: isSelected ? 600 : 500,
                      color: isSelected ? "var(--brand-500, var(--ac))" : "var(--g900)",
                      transition: "background 0.1s",
                    }}
                    onMouseEnter={(e) => {
                      if (!isSelected) e.currentTarget.style.background = "var(--g100)";
                    }}
                    onMouseLeave={(e) => {
                      if (!isSelected) e.currentTarget.style.background = "transparent";
                    }}
                  >
                    <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {t}
                    </span>
                    {isSelected ? <IconCheck size={14} style={{ color: "var(--brand-500, var(--ac))", flexShrink: 0 }} /> : null}
                  </button>
                );
              })
            ) : (
              <div style={{ padding: "10px 12px", fontSize: 13, color: "var(--g500)" }}>No matches</div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

