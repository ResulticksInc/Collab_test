import React, { useEffect, useMemo, useRef, useState } from "react";
import { IconChevronDown, IconCheck } from "../lib/icons";
import { tzAbbr, tzCity, tzOptions } from "../lib/timezones";

// Compact timezone control for the meeting scheduler.
//
// It sits inline beside the start/end times, so the CLOSED state has to stay
// pill-sized — it shows only the live abbreviation ("IST", "SGT", "AEDT"), which
// is what people read a time against. The full identity (city and UTC offset)
// belongs in the OPEN list, where there is room for it. A native <select> can't
// do that (the closed control must render the selected option's own text
// verbatim), which is why this is a button + listbox.
export default function TimeZonePicker({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (tz: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Recomputed only when the selection changes: the abbreviations are DST-aware
  // but the answer is stable for the life of a dialog.
  const options = useMemo(() => tzOptions(value), [value]);
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return options;
    return options.filter(
      (o) =>
        o.abbr.toLowerCase().includes(s) ||
        o.city.toLowerCase().includes(s) ||
        o.tz.toLowerCase().includes(s) ||
        o.offsetLabel.toLowerCase().includes(s),
    );
  }, [q, options]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    // Escape closes the picker WITHOUT bubbling to the Modal, which would
    // otherwise close the whole scheduler and lose the form.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setQ("");
    const id = setTimeout(() => {
      searchRef.current && searchRef.current.focus();
      // Open ON the current zone rather than at Midway — the list is 70+ rows.
      const sel = listRef.current?.querySelector('[aria-selected="true"]') as HTMLElement | null;
      sel && sel.scrollIntoView({ block: "center" });
    }, 0);
    return () => clearTimeout(id);
  }, [open]);

  if (!value) return null;
  const abbr = tzAbbr(value);

  return (
    <div className="sm-tz-wrap" ref={ref}>
      <button
        type="button"
        className={"sm-tz-btn" + (open ? " on" : "")}
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={`Times are in ${tzCity(value)} (${value}) — click to change`}
        aria-label={`Time zone: ${abbr}, ${tzCity(value)}. Change time zone`}
      >
        <span className="sm-tz-abbr">{abbr}</span>
        <IconChevronDown size={13} />
      </button>
      {open ? (
        <div className="sm-tz-pop" role="dialog" aria-label="Choose a time zone">
          <input
            ref={searchRef}
            className="sm-tz-search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search IST, Singapore, UTC+8…"
            aria-label="Search time zones"
          />
          <div className="sm-tz-list" role="listbox" ref={listRef}>
            {filtered.length === 0 ? (
              <div className="sm-tz-empty">No matching time zone</div>
            ) : (
              filtered.map((o) => (
                <button
                  type="button"
                  key={o.tz}
                  role="option"
                  aria-selected={o.tz === value}
                  className={"sm-tz-opt" + (o.tz === value ? " on" : "")}
                  onClick={() => {
                    onChange(o.tz);
                    setOpen(false);
                  }}
                >
                  <span className="sm-tz-opt-abbr">{o.abbr}</span>
                  <span className="sm-tz-opt-city">{o.city}</span>
                  <span className="sm-tz-opt-off">{o.offsetLabel}</span>
                  {o.tz === value ? <IconCheck size={14} /> : null}
                </button>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
