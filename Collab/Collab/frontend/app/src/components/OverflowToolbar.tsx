import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { IconMoreVertical } from "../lib/icons";
import { useEsc } from "../lib/escStack";

export type ToolbarItem = { id: string; label: string; badge?: number };

// ── Generic responsive overflow toolbar ──────────────────────────────────────
// A reusable Slack/GitHub/VS-Code-style adaptive toolbar. It renders as many
// items inline as the available width allows and collapses the rest into a ⋮
// overflow menu — it NEVER wraps. The behaviour the callers get for free:
//
//   • Width-driven, not text-wrap: a ResizeObserver measures the container; the
//     item widths are measured once from a hidden mirror. Which items are inline
//     is pure arithmetic from those two numbers, so it re-flows smoothly as the
//     sidebar is dragged, with no layout jumps.
//   • The ACTIVE item is always promoted to the toolbar — it can never hide
//     inside the overflow menu. When it wouldn't fit naturally, the last inline
//     item yields its slot to it.
//   • The overflow menu always contains exactly the items NOT currently inline.
//   • Single source of truth: `activeId` + `onSelect`. No filter state is
//     duplicated here, so it stays correct however the caller manages selection,
//     and scales if more items are added later.
//   • Accessible: the trigger is a real menu button (aria-haspopup/expanded); the
//     menu is a keyboard-navigable listbox — ↑/↓ move, Enter/Space select, Escape
//     closes and returns focus, Home/End jump. Inline chips expose aria-pressed.
//
// Styling is delegated via className props so it can adopt any toolbar's existing
// look (the chat filter passes fb/ft/ft-c/ft-more/ft-more-lab). Drop it into any
// toolbar that is "a row of selectable chips with one active".
export default function OverflowToolbar({
  items,
  activeId,
  onSelect,
  gap = 4,
  className = "",
  itemClassName = "",
  activeItemClassName = "active",
  badgeClassName = "",
  moreClassName = "",
  ariaLabel = "Filters",
}: {
  items: ToolbarItem[];
  activeId: string;
  onSelect: (id: string) => void;
  /** Horizontal gap between chips, in px — must match the container's CSS gap. */
  gap?: number;
  className?: string;
  itemClassName?: string;
  activeItemClassName?: string;
  badgeClassName?: string;
  moreClassName?: string;
  ariaLabel?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const menuWrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const itemWidthsRef = useRef<number[]>([]);
  const moreWidthRef = useRef<number>(40);
  const [avail, setAvail] = useState(0);
  // Bumped on every SUCCESSFUL (real, non-zero) measurement so the split memo
  // recomputes even when `avail` itself didn't change (chip widths live in a ref).
  const [measureTick, setMeasureTick] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuIdx, setMenuIdx] = useState(0);

  // Re-measure only when the labels/badges actually change (a stable signature),
  // NOT on every render — otherwise a fresh `items` array identity each render
  // would thrash the layout effect.
  const sig = useMemo(
    () => items.map((it) => `${it.id}:${it.label}:${it.badge ?? ""}`).join("|"),
    [items],
  );

  // Content-box width of the container (clientWidth minus horizontal padding).
  // The chips live inside the container's padding, so this — NOT clientWidth — is
  // the space they actually get. The ResizeObserver reports the same content-box
  // width via contentRect, so every read of `avail` is on the same basis.
  const readAvail = useCallback(() => {
    const el = containerRef.current;
    if (!el) return 0;
    const cs = getComputedStyle(el);
    const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    return Math.max(0, el.clientWidth - pad);
  }, []);

  // Measure the chip widths (from the off-screen mirror) AND the container's inner
  // width together, and COMMIT only when both are real. A toolbar can mount while
  // its sidebar is hidden/zero-width (e.g. the app boots on another module); if we
  // cached those zero widths, totalAll would be 0 ≤ avail and the row would NEVER
  // collapse — it would just overflow off-screen. So we ignore zero reads and keep
  // retrying until the real layout is available.
  const measure = useCallback((): boolean => {
    const m = measureRef.current;
    const el = containerRef.current;
    if (!m || !el) return false;
    const chips = Array.from(m.querySelectorAll("[data-mt-item]")) as HTMLElement[];
    const widths = chips.map((c) => Math.ceil(c.getBoundingClientRect().width));
    const moreEl = m.querySelector("[data-mt-more]") as HTMLElement | null;
    const moreW = moreEl ? Math.ceil(moreEl.getBoundingClientRect().width) : 0;
    const a = readAvail();
    if (a > 0 && widths.length === items.length && widths.every((w) => w > 0)) {
      itemWidthsRef.current = widths;
      if (moreW > 0) moreWidthRef.current = moreW;
      setAvail(a);
      setMeasureTick((t) => t + 1);
      return true;
    }
    return false;
  }, [readAvail, items.length]);

  // Measure on mount + whenever the item set changes, retrying across animation
  // frames until the toolbar is actually laid out (handles a hidden-at-mount).
  useLayoutEffect(() => {
    let raf = 0;
    let tries = 0;
    const tick = () => {
      if (measure()) return;
      if (tries++ < 180) raf = requestAnimationFrame(tick); // ~3s of retries
    };
    if (!measure()) raf = requestAnimationFrame(tick);
    return () => {
      if (raf) cancelAnimationFrame(raf);
    };
  }, [measure, sig]);

  // Re-measure on any container resize — drag-resize of the sidebar, window
  // resize, AND the hidden→shown transition (the RO fires with the real size the
  // moment the toolbar becomes visible, which recovers a hidden-at-mount toolbar).
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      measure();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  // Split items into inline vs overflow from the measured widths + available room.
  const { inline, overflow } = useMemo(() => {
    const widths = itemWidthsRef.current;
    if (!avail || widths.length !== items.length) {
      // Pre-measurement: render everything (the mirror measures next frame). This
      // avoids a flash of "active + ⋮" before widths are known.
      return { inline: items, overflow: [] as ToolbarItem[] };
    }
    const totalAll = widths.reduce((s, w) => s + w, 0) + gap * (items.length - 1);
    if (totalAll <= avail) return { inline: items, overflow: [] as ToolbarItem[] };

    // Something overflows → the ⋮ trigger will be shown; budget for it.
    const budget = avail - (moreWidthRef.current + gap);
    let used = 0;
    let count = 0;
    for (let i = 0; i < items.length; i++) {
      const w = widths[i] + (count > 0 ? gap : 0);
      if (used + w <= budget) {
        used += w;
        count++;
      } else break;
    }
    count = Math.max(1, count); // always keep at least one chip inline

    let visible = items.slice(0, count);
    if (!visible.some((it) => it.id === activeId)) {
      // Promote the active item so it is never buried in the menu. Width-aware:
      // reserve the active chip's own width first (it may be wider than the chip
      // it displaces), then greedily refill the slots before it. This keeps the
      // inline row within budget instead of blindly swapping the last chip.
      const activeIdx = items.findIndex((it) => it.id === activeId);
      const active = items[activeIdx];
      if (active) {
        const budget2 = budget - (widths[activeIdx] + gap);
        let used2 = 0;
        const pre: ToolbarItem[] = [];
        for (let i = 0; i < items.length; i++) {
          if (i === activeIdx) continue;
          const w = widths[i] + (pre.length > 0 ? gap : 0);
          if (used2 + w <= budget2) {
            used2 += w;
            pre.push(items[i]);
          } else break;
        }
        // Active always stays inline, even if nothing else fits beside it.
        visible = [...pre, active];
      }
    }
    const inlineIds = new Set(visible.map((it) => it.id));
    return {
      inline: visible,
      overflow: items.filter((it) => !inlineIds.has(it.id)),
    };
    // measureTick: chip widths live in a ref, so recompute when a real measurement lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [avail, items, activeId, gap, measureTick]);

  // If the container widens until nothing overflows, the ⋮ trigger unmounts. Reset
  // menuOpen so the state can't survive that and force an already-open menu when a
  // later re-narrow remounts the trigger (data-open would render "1" with no click).
  useEffect(() => {
    if (overflow.length === 0 && menuOpen) setMenuOpen(false);
  }, [overflow.length, menuOpen]);

  // Close on outside click.
  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (menuWrapRef.current && !menuWrapRef.current.contains(e.target as Node))
        setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menuOpen]);

  // On open, focus the active overflow item (or the first) for keyboard use.
  useEffect(() => {
    if (!menuOpen) return;
    const activeInMenu = overflow.findIndex((it) => it.id === activeId);
    setMenuIdx(activeInMenu >= 0 ? activeInMenu : 0);
  }, [menuOpen, overflow, activeId]);
  useEffect(() => {
    if (!menuOpen) return;
    const el = menuRef.current?.querySelectorAll<HTMLElement>("[role='menuitem']")[menuIdx];
    el?.focus();
  }, [menuOpen, menuIdx]);

  const choose = useCallback(
    (id: string) => {
      onSelect(id);
      setMenuOpen(false);
      triggerRef.current?.focus();
    },
    [onSelect],
  );

  // Esc closes the overflow menu via the app-wide LIFO stack (user-action based)
  // so it consumes the keypress — otherwise the React onKeyDown below closed the
  // menu but the same Esc still bubbled to the global handler and navigated Back.
  useEsc(menuOpen, () => {
    setMenuOpen(false);
    triggerRef.current?.focus();
  });

  const onMenuKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setMenuIdx((i) => (i + 1) % overflow.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setMenuIdx((i) => (i - 1 + overflow.length) % overflow.length);
    } else if (e.key === "Home") {
      e.preventDefault();
      setMenuIdx(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setMenuIdx(overflow.length - 1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const it = overflow[menuIdx];
      if (it) choose(it.id);
    }
  };

  const chip = (it: ToolbarItem, measuring = false) => (
    <button
      key={(measuring ? "m-" : "") + it.id}
      {...(measuring ? { "data-mt-item": "" } : {})}
      type="button"
      className={itemClassName + (it.id === activeId ? " " + activeItemClassName : "")}
      aria-pressed={it.id === activeId}
      onClick={measuring ? undefined : () => onSelect(it.id)}
      tabIndex={measuring ? -1 : 0}
    >
      {it.label}
      {it.badge ? <span className={badgeClassName}>{it.badge}</span> : null}
    </button>
  );

  return (
    <>
      <div ref={containerRef} className={className} role="toolbar" aria-label={ariaLabel}>
        {inline.map((it) => chip(it))}
        {overflow.length > 0 ? (
          <div
            ref={menuWrapRef}
            style={{ position: "relative", display: "inline-flex" }}
          >
            <button
              ref={triggerRef}
              type="button"
              className={moreClassName}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label="More filters"
              onClick={() => setMenuOpen((o) => !o)}
            >
              <IconMoreVertical size={16} />
            </button>
            <div
              ref={menuRef}
              role="menu"
              aria-label={ariaLabel}
              onKeyDown={onMenuKey}
              className="mt-overflow-menu"
              data-open={menuOpen ? "1" : "0"}
            >
              {overflow.map((it, i) => (
                <button
                  key={it.id}
                  type="button"
                  role="menuitem"
                  className="mt-overflow-item"
                  data-active={it.id === activeId ? "1" : "0"}
                  tabIndex={menuOpen && i === menuIdx ? 0 : -1}
                  onClick={() => choose(it.id)}
                >
                  <span>{it.label}</span>
                  {it.badge ? <span className={badgeClassName}>{it.badge}</span> : null}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
      {/* Off-screen mirror: every item + the ⋮ trigger at full size, so their
          widths can be measured without affecting layout. aria-hidden so it is
          invisible to AT and not tabbable. */}
      <div
        ref={measureRef}
        aria-hidden="true"
        style={{
          position: "absolute",
          left: -99999,
          top: 0,
          display: "inline-flex",
          gap,
          whiteSpace: "nowrap",
          visibility: "hidden",
          pointerEvents: "none",
        }}
      >
        {items.map((it) => chip(it, true))}
        <button data-mt-more="" type="button" className={moreClassName} tabIndex={-1}>
          <IconMoreVertical size={16} />
        </button>
      </div>
    </>
  );
}
