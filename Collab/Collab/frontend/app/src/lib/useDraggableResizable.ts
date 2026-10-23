import { useCallback, useRef, useState } from "react";

// Shared fixed-position drag + 2-D resize hook. Mirrors the proven
// pointer-capture idiom in CallDebugPanel.tsx (drag header + bottom-right resize
// handle), generalised to width AND height and reusable from any surface — most
// notably the shared Modal, so every modal becomes draggable + resizable.
//
// Contract:
//  - `dragHandlers` spreads onto the surface's drag region (e.g. a modal header).
//    The closest('button,a,input,...') guard keeps interactive header controls
//    (the × close button, etc.) clickable rather than initiating a drag.
//  - `resizeHandlers` spreads onto a bottom-right handle element.
//  - `started` flips true on the first drag/resize; until then the consumer can
//    keep its own centered layout. `pos`/`size` carry the live geometry.
//  - `disabled` gates the whole thing off (e.g. on phones / coarse pointers).

const clamp = (n: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, n));

export interface DragResizeOptions {
  storageKey?: string;
  defaultW: number;
  defaultH: number;
  minW?: number;
  maxW?: number;
  minH?: number;
  maxH?: number;
  persist?: boolean;
  centeredUntilDrag?: boolean;
  disabled?: boolean;
}

export interface PointerHandlers {
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
  style: React.CSSProperties;
}

export interface DragResizeReturn {
  rootRef: React.RefObject<HTMLDivElement>;
  pos: { left: number; top: number } | null;
  size: { w: number; h: number };
  started: boolean;
  dragHandlers: PointerHandlers;
  resizeHandlers: PointerHandlers;
}

export function useDraggableResizable(
  opts: DragResizeOptions,
): DragResizeReturn {
  const minW = opts.minW ?? 300;
  const maxW = opts.maxW ?? 720;
  const minH = opts.minH ?? 200;
  const maxH = opts.maxH ?? 820;

  const POS = opts.storageKey ? `${opts.storageKey}_pos` : null;
  const SIZE = opts.storageKey ? `${opts.storageKey}_size` : null;

  const loadPos = (): { left: number; top: number } | null => {
    if (!POS || !opts.persist) return null;
    try {
      const raw = localStorage.getItem(POS);
      if (!raw) return null;
      const v = JSON.parse(raw);
      if (typeof v?.left === "number" && typeof v?.top === "number")
        return { left: v.left, top: v.top };
    } catch {
      /* ignore */
    }
    return null;
  };

  const loadSize = (): { w: number; h: number } => {
    const fallback = { w: opts.defaultW, h: opts.defaultH };
    if (!SIZE || !opts.persist) return fallback;
    try {
      const raw = localStorage.getItem(SIZE);
      if (raw) {
        const v = JSON.parse(raw);
        if (typeof v?.w === "number" && typeof v?.h === "number")
          return { w: v.w, h: v.h };
      }
    } catch {
      /* ignore */
    }
    return fallback;
  };

  const rootRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(
    opts.persist ? loadPos() : null,
  );
  const [size, setSize] = useState<{ w: number; h: number }>(
    opts.persist ? loadSize() : { w: opts.defaultW, h: opts.defaultH },
  );
  const [started, setStarted] = useState<boolean>(() => pos != null);

  const drag = useRef<{ ox: number; oy: number } | null>(null);
  const rsz = useRef<{ sx: number; sy: number; sw: number; sh: number } | null>(
    null,
  );

  // ── Drag (header) — fixed-position, clamped to the viewport. ──
  const onDragDown = useCallback(
    (e: React.PointerEvent) => {
      if (opts.disabled) return;
      if (
        (e.target as HTMLElement).closest(
          "button,a,input,select,textarea,[data-no-drag]",
        )
      )
        return;
      const r = rootRef.current?.getBoundingClientRect();
      const left = pos ? pos.left : r ? r.left : 16;
      const top = pos ? pos.top : r ? r.top : 16;
      drag.current = { ox: e.clientX - left, oy: e.clientY - top };
      setPos({ left, top });
      setStarted(true);
      try {
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    },
    [opts.disabled, pos],
  );
  const onDragMove = useCallback((e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    setPos({
      left: clamp(e.clientX - d.ox, 4, window.innerWidth - 60),
      top: clamp(e.clientY - d.oy, 4, window.innerHeight - 32),
    });
  }, []);
  const onDragUp = useCallback(
    (e: React.PointerEvent) => {
      drag.current = null;
      try {
        (e.currentTarget as Element).releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      if (opts.persist && POS) {
        const r = rootRef.current?.getBoundingClientRect();
        if (r)
          try {
            localStorage.setItem(
              POS,
              JSON.stringify({
                left: Math.round(r.left),
                top: Math.round(r.top),
              }),
            );
          } catch {
            /* ignore */
          }
      }
    },
    [opts.persist, POS],
  );

  // ── Resize (bottom-right handle) — width AND height. ──
  const onRszDown = useCallback(
    (e: React.PointerEvent) => {
      if (opts.disabled) return;
      e.stopPropagation();
      rsz.current = { sx: e.clientX, sy: e.clientY, sw: size.w, sh: size.h };
      setStarted(true);
      try {
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    },
    [opts.disabled, size.w, size.h],
  );
  const onRszMove = useCallback(
    (e: React.PointerEvent) => {
      const r = rsz.current;
      if (!r) return;
      setSize({
        w: clamp(
          r.sw + (e.clientX - r.sx),
          minW,
          Math.min(maxW, window.innerWidth - 24),
        ),
        h: clamp(
          r.sh + (e.clientY - r.sy),
          minH,
          Math.min(maxH, window.innerHeight - 24),
        ),
      });
    },
    [minW, maxW, minH, maxH],
  );
  const onRszUp = useCallback(
    (e: React.PointerEvent) => {
      rsz.current = null;
      try {
        (e.currentTarget as Element).releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      if (opts.persist && SIZE)
        try {
          localStorage.setItem(SIZE, JSON.stringify(size));
        } catch {
          /* ignore */
        }
    },
    [opts.persist, SIZE, size],
  );

  return {
    rootRef,
    pos,
    size,
    started,
    dragHandlers: {
      onPointerDown: onDragDown,
      onPointerMove: onDragMove,
      onPointerUp: onDragUp,
      style: { cursor: "grab", touchAction: "none" },
    },
    resizeHandlers: {
      onPointerDown: onRszDown,
      onPointerMove: onRszMove,
      onPointerUp: onRszUp,
      style: { touchAction: "none", cursor: "nwse-resize" },
    },
  };
}
