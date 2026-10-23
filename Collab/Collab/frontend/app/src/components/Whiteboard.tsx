import React, { useEffect, useRef, useState, useCallback } from "react";
import {
  IconX,
  IconTrash,
  IconPencil,
  IconPlus,
  IconChevronLeft,
  IconChevronRight,
  IconDownload,
  IconUndo,
  IconRepeat,
  IconImage,
  IconLock,
  IconLockOpen,
} from "../lib/icons";
import { canvasToPdfBlob } from "../lib/canvasPdf";

// ─────────────────────────────────────────────────────────────────────────────
// Collaborative in-call whiteboard (calls + meetings).
//
// Shared, multi-page, persistable surface — not a per-user scratchpad. Transport
// is injected (`broadcast`/`registerReceiver`), wired to the LiveKit data channel
// in calls & meetings so ops sync peer-to-peer through the SFU with no backend
// change. Coordinates are normalised 0..1 of the board, so a stroke lands in the
// same relative place on every participant's screen.
//
// Sync model: each drawing op is broadcast as an incremental "stroke" (append
// points to a stroke id). Late joiners / re-opens fire a "sync-request"; any peer
// holding state replies with a full "sync" (all pages). This is an eventually-
// consistent, op-based CRDT-lite: ops are keyed by globally-unique stroke ids so
// re-delivery is idempotent and there are no lost/duplicate strokes for the
// common case. (Server persistence + true OT/CRDT is the enterprise roadmap.)
// ─────────────────────────────────────────────────────────────────────────────

export type WbPoint = { x: number; y: number };
export type WbTool =
  | "select"
  | "pen"
  | "highlighter"
  | "eraser"
  | "rect"
  | "ellipse"
  | "line"
  | "arrow"
  | "text";
// Freehand/eraser: pts is the path. Shapes (rect/ellipse/line/arrow): pts is
// [start, end]. Text: pts is [anchor] and `text` holds the content.
export type WbStroke = {
  id: string;
  page: number;
  color: string;
  size: number;
  tool: WbTool;
  pts: WbPoint[];
  text?: string;
  // AUDIT #27: text font scale (default 1). Lets resize scale the glyphs (a text
  // stroke has a single anchor point, so scaling pts alone couldn't). Optional →
  // older saved boards deserialize as undefined and fall back to 1 (no regression).
  fontScale?: number;
};
const SHAPE_TOOLS = new Set(["rect", "ellipse", "line", "arrow"]);

// Undo/redo is an ACTION LOG (not just added strokes) so move / resize / delete /
// duplicate / reorder are ALL undoable. Each entry carries the state needed to
// reverse it. Strokes are snapshotted (deep-copied pts) so later edits don't
// mutate the history.
type WbAction =
  | { t: "add"; page: number; strokes: WbStroke[] }
  | { t: "remove"; page: number; strokes: WbStroke[] }
  | { t: "edit"; page: number; before: WbStroke[]; after: WbStroke[] }
  | { t: "reorder"; page: number; before: string[]; after: string[] };

export type WbMessage =
  | { op: "open" } // someone opened the board → peers auto-open
  | { op: "stroke"; stroke: WbStroke; pts: WbPoint[] } // append pts to stroke
  | { op: "shape"; stroke: WbStroke } // rect/ellipse/line/arrow/text (full replace)
  | { op: "clear"; page: number }
  | { op: "undo"; page: number; id: string }
  | { op: "redo"; stroke: WbStroke }
  | { op: "page-add"; at: number }
  | { op: "page-remove"; at: number }
  | { op: "lock"; locked: boolean } // presenter locks the board (guests read-only)
  | { op: "cursor"; id: string; name: string; color: string; page: number; x: number; y: number }
  | { op: "sync-request" }
  // Object manipulation. Move/resize reuse the idempotent "shape" full-replace
  // (last-write-wins by id, any tool). "reorder" carries a page's full z-order.
  | { op: "reorder"; page: number; order: string[] }
  | { op: "sync"; pages: WbStroke[][]; locked?: boolean }
  | { op: "replace"; pages: WbStroke[][]; locked?: boolean }; // authoritative full-board replace (import)

const COLORS = [
  "#e5484d",
  "#f5a623",
  "#30a46c",
  "#5e6ad2",
  "#8b29be",
  "#111827",
  "#ffffff",
];
const SIZES = [3, 6, 12];
// Resize-handle positions as a fraction of the selection bbox on each axis
// (0 = left/top, 0.5 = mid edge, 1 = right/bottom). 4 corners + 4 edge mids.
const RESIZE_HANDLES: Array<{ fx: number; fy: number }> = [
  { fx: 0, fy: 0 }, { fx: 0.5, fy: 0 }, { fx: 1, fy: 0 },
  { fx: 0, fy: 0.5 }, { fx: 1, fy: 0.5 },
  { fx: 0, fy: 1 }, { fx: 0.5, fy: 1 }, { fx: 1, fy: 1 },
];
const CURSOR_TTL = 4000; // drop a peer cursor after 4s of silence

let CURSOR_HUE = 0;
function hueColor() {
  CURSOR_HUE = (CURSOR_HUE + 67) % 360;
  return `hsl(${CURSOR_HUE} 70% 50%)`;
}
// Stable per-string hash → deterministic jitter so each client answers a
// sync-request at a slightly different, consistent offset (storm control).
function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// ── Remote-op validation (untrusted peer input) ──────────────────────────────
// Every op arrives over the data channel from another attendee — treat it as
// hostile. Bound pages, points, sizes, and string lengths so a malformed or
// malicious peer can't OOM / freeze other browsers (a P0 finding). Clamp rather
// than reject where sensible so a slightly-off op still renders.
const MAX_PAGES = 60;
const MAX_PTS_PER_MSG = 4000;
// Hard ceiling on a single stroke's accumulated points. Freehand can be long,
// but a peer streaming appends to one id forever would grow it unbounded — cap
// so one stroke can't OOM the tab.
const MAX_PTS_PER_STROKE = 100000;
const clampUnit = (n: any): number =>
  typeof n === "number" && isFinite(n) ? Math.min(1, Math.max(0, n)) : NaN;
const TOOLS = new Set([
  "pen",
  "highlighter",
  "eraser",
  "rect",
  "ellipse",
  "line",
  "arrow",
  "text",
]);
const cleanTool = (t: any): WbTool => (TOOLS.has(t) ? t : "pen");
const cleanColor = (c: any): string =>
  typeof c === "string" && c.length > 0 && c.length <= 32 ? c : "#111827";
const cleanSize = (s: any): number =>
  typeof s === "number" && isFinite(s) ? Math.min(64, Math.max(1, s)) : 6;
const cleanPageIdx = (n: any): number =>
  Number.isInteger(n) && n >= 0 && n < MAX_PAGES ? n : -1;
const cleanId = (s: any): string | null =>
  typeof s === "string" && s.length > 0 && s.length <= 80 ? s : null;
function cleanPts(pts: any): WbPoint[] {
  if (!Array.isArray(pts)) return [];
  const out: WbPoint[] = [];
  for (const p of pts) {
    if (!p) continue;
    const x = clampUnit(p.x);
    const y = clampUnit(p.y);
    if (isFinite(x) && isFinite(y)) out.push({ x, y });
    if (out.length >= MAX_PTS_PER_MSG) break;
  }
  return out;
}
function cleanStroke(st: any, page: number): WbStroke | null {
  const id = cleanId(st && st.id);
  if (!id) return null;
  const s: WbStroke = {
    id,
    page,
    color: cleanColor(st.color),
    size: cleanSize(st.size),
    tool: cleanTool(st.tool),
    pts: cleanPts(st.pts),
  };
  if (s.tool === "text" && typeof st.text === "string")
    s.text = st.text.slice(0, 500);
  return s;
}

export default function Whiteboard({
  broadcast,
  registerReceiver,
  onClose,
  title = "Whiteboard",
  selfName = "You",
  resyncNonce = 0,
  loadState,
  saveState,
  canModerate = true,
}: {
  broadcast: (msg: WbMessage) => void;
  // AUDIT #22: the receiver is now told whether the SENDER is a moderator, so it
  // can reject a locked-out peer's mutation even if that peer runs modified code
  // (sender-side guards alone are bypassable). Defense-in-depth (not server-auth).
  registerReceiver: (
    fn: (msg: WbMessage, meta?: { fromModerator?: boolean }) => void,
  ) => () => void;
  onClose: () => void;
  title?: string;
  selfName?: string;
  // Moderator (call host / meeting host) — may clear the board, remove pages,
  // and lock it. Non-moderators can draw only while the board is unlocked.
  canModerate?: boolean;
  // Bumped by the parent on LiveKit reconnect → re-pull board state so a mid-call
  // network blip doesn't leave a rejoiner with a blank board.
  resyncNonce?: number;
  // Durable persistence (server snapshot). loadState pulls the saved board on
  // open + reconnect; saveState debounce-persists it. Optional — without them the
  // board is live-only (peer-to-peer).
  loadState?: () => Promise<WbStroke[][] | null | undefined>;
  saveState?: (pages: WbStroke[][]) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);

  // Board state: one Map of strokes per page. Maps keep append-by-id O(1) and
  // preserve insertion order for repaint. pagesRef is the source of truth; a
  // version counter forces re-render of page chrome without deep state.
  const pagesRef = useRef<Array<Map<string, WbStroke>>>([new Map()]);
  const [pageIdx, setPageIdx] = useState(0);
  const pageIdxRef = useRef(0);
  pageIdxRef.current = pageIdx;
  const [pageCount, setPageCount] = useState(1);

  const drawingRef = useRef<WbStroke | null>(null);
  const flushTimer = useRef<any>(null);
  const pendingPts = useRef<WbPoint[]>([]);
  // Offscreen snapshot of the committed page, taken once when a shape drag
  // starts. Each pointermove restores this blit + draws only the in-progress
  // shape (O(1)) instead of re-stroking every committed stroke (O(page)).
  const shapeSnapRef = useRef<HTMLCanvasElement | null>(null);
  // Local undo/redo of MY strokes only (never removes a peer's work).
  const undoRef = useRef<WbAction[]>([]);
  const redoRef = useRef<WbAction[]>([]);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const refreshUndo = () => {
    setCanUndo(undoRef.current.length > 0);
    setCanRedo(redoRef.current.length > 0);
  };
  const pushAction = (a: WbAction) => {
    undoRef.current.push(a);
    if (undoRef.current.length > 200) undoRef.current.shift(); // bounded history
    redoRef.current = [];
    refreshUndo();
  };
  const cloneStroke = (s: WbStroke): WbStroke => ({
    ...s,
    pts: s.pts.map((p) => ({ x: p.x, y: p.y })),
  });

  // ── Object selection / manipulation (Select tool) ──────────────────────────
  // Selected object ids on the CURRENT page. The canvas outline is drawn by
  // repaint(); setSelVer forces the React layer (context menu / cursor) to
  // re-read selectedRef. Coordinates stay normalized (0..1), so move/resize are
  // resolution-independent and sync by stroke id — no new geometry protocol.
  const selectedRef = useRef<Set<string>>(new Set());
  const [, setSelVer] = useState(0);
  const bumpSel = () => setSelVer((v) => v + 1);
  // Active pointer gesture in Select mode: dragging object(s), or a marquee box.
  const dragRef = useRef<
    | null
    | {
        mode: "move" | "marquee" | "resize";
        start: WbPoint;
        moved: boolean;
        origins?: Map<string, WbPoint[]>; // move/resize: pts snapshot at drag start
        scales?: Map<string, number>; // resize: text fontScale snapshot at drag start (#27)
        box?: { x0: number; y0: number; x1: number; y1: number }; // marquee rect
        handle?: { fx: number; fy: number }; // resize: which handle is dragged
        startBox?: { x0: number; y0: number; x1: number; y1: number }; // resize: bbox at start
      }
  >(null);
  const moveSyncTimer = useRef<any>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);

  const [color, setColor] = useState("#e5484d");
  const [size, setSize] = useState(6);
  const [tool, setTool] = useState<WbTool>("pen");
  // AUDIT #27: inline text editor overlay. `editing` positions a real <textarea>
  // over the canvas (normalized x/y anchor) for WYSIWYG multi-line entry — no more
  // blocking single-line prompt. `id` set → editing an EXISTING stroke (double-
  // click); undefined → placing a new one. `fontScale` carries the stroke's scale
  // so an edited stroke keeps its resized size.
  const [editing, setEditing] = useState<{
    id?: string;
    x: number;
    y: number;
    value: string;
    page: number;
    fontScale: number;
  } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // Mirror of `editing`, consumed SYNCHRONOUSLY by commitEditing so a click that
  // fires BOTH the textarea onBlur AND the canvas onPointerDown commits only once.
  const editingRef = useRef<typeof editing>(null);
  editingRef.current = editing;
  const [locked, setLocked] = useState(false);
  const lockedRef = useRef(false);
  lockedRef.current = locked;
  // canModerate can change mid-session (co-host promotion) — keep a live ref so
  // the mount-time keydown closure never reads a stale value.
  const canModerateRef = useRef(canModerate);
  canModerateRef.current = canModerate;
  const readonly = locked && !canModerate;
  const [saveOpen, setSaveOpen] = useState(false);
  const selfColorRef = useRef<string>(hueColor());
  const selfIdRef = useRef<string>(
    "me-" + Math.random().toString(36).slice(2, 8),
  );

  // Remote cursors (id → {x,y,name,color,page,ts}), rendered as an overlay.
  const cursorsRef = useRef<Map<string, any>>(new Map());
  const [cursorTick, setCursorTick] = useState(0);
  const lastCursorSend = useRef(0);
  // sync-request storm control: when a room auto-opens the board, every peer
  // fires sync-request and every holder would reply with the full board (O(N^2)
  // flood). Reply with a per-client jittered delay and suppress if any peer
  // already answered, collapsing N replies to ~1.
  const syncReplyTimer = useRef<any>(null);
  const lastSyncSeen = useRef(0);

  const page = () => pagesRef.current[pageIdxRef.current] || new Map();

  // ── Canvas sizing / repaint ────────────────────────────────────────────────
  const sizeCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctxRef.current = ctx;
    }
    repaint();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyStyle = useCallback((s: WbStroke) => {
    const ctx = ctxRef.current!;
    if (s.tool === "eraser") {
      ctx.globalCompositeOperation = "destination-out";
      ctx.globalAlpha = 1;
      ctx.lineWidth = s.size * 3;
      ctx.strokeStyle = "#000";
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = s.tool === "highlighter" ? 0.35 : 1;
      ctx.lineWidth = s.tool === "highlighter" ? s.size * 2.2 : s.size;
      ctx.strokeStyle = s.color;
    }
  }, []);

  const drawSegment = useCallback(
    (s: WbStroke, from: WbPoint, to: WbPoint) => {
      const ctx = ctxRef.current;
      const wrap = wrapRef.current;
      if (!ctx || !wrap) return;
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      applyStyle(s);
      ctx.beginPath();
      ctx.moveTo(from.x * w, from.y * h);
      ctx.lineTo(to.x * w, to.y * h);
      ctx.stroke();
      if (from === to) {
        ctx.beginPath();
        ctx.arc(to.x * w, to.y * h, (ctx.lineWidth || 1) / 2, 0, Math.PI * 2);
        ctx.fillStyle = s.tool === "eraser" ? "#000" : s.color;
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    },
    [applyStyle],
  );

  // Full render of one element (shapes/text/freehand). Freehand uses drawSegment
  // for live incremental drawing; repaint uses this for everything.
  const drawStroke = useCallback(
    (s: WbStroke) => {
      const ctx = ctxRef.current;
      const wrap = wrapRef.current;
      if (!ctx || !wrap || !s.pts.length) return;
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      if (SHAPE_TOOLS.has(s.tool)) {
        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = 1;
        ctx.strokeStyle = s.color;
        ctx.fillStyle = s.color;
        ctx.lineWidth = s.size;
        const a = s.pts[0];
        const b = s.pts[s.pts.length - 1] || a;
        const ax = a.x * w, ay = a.y * h, bx = b.x * w, by = b.y * h;
        if (s.tool === "rect") {
          ctx.strokeRect(
            Math.min(ax, bx),
            Math.min(ay, by),
            Math.abs(bx - ax),
            Math.abs(by - ay),
          );
        } else if (s.tool === "ellipse") {
          ctx.beginPath();
          ctx.ellipse(
            (ax + bx) / 2,
            (ay + by) / 2,
            Math.abs(bx - ax) / 2,
            Math.abs(by - ay) / 2,
            0,
            0,
            Math.PI * 2,
          );
          ctx.stroke();
        } else {
          // line / arrow
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.lineTo(bx, by);
          ctx.stroke();
          if (s.tool === "arrow") {
            const ang = Math.atan2(by - ay, bx - ax);
            const head = Math.max(9, s.size * 3);
            ctx.beginPath();
            ctx.moveTo(bx, by);
            ctx.lineTo(
              bx - head * Math.cos(ang - Math.PI / 6),
              by - head * Math.sin(ang - Math.PI / 6),
            );
            ctx.moveTo(bx, by);
            ctx.lineTo(
              bx - head * Math.cos(ang + Math.PI / 6),
              by - head * Math.sin(ang + Math.PI / 6),
            );
            ctx.stroke();
          }
        }
        return;
      }
      if (s.tool === "text") {
        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = 1;
        ctx.fillStyle = s.color;
        const fs = Math.max(12, s.size * 3) * (s.fontScale ?? 1);
        ctx.font = `600 ${fs}px Inter, system-ui, sans-serif`;
        ctx.textBaseline = "top";
        (s.text || "").split("\n").forEach((ln, i) => {
          ctx.fillText(ln, s.pts[0].x * w, s.pts[0].y * h + i * fs * 1.25);
        });
        return;
      }
      // freehand / eraser
      if (s.pts.length === 1) drawSegment(s, s.pts[0], s.pts[0]);
      else for (let i = 1; i < s.pts.length; i++) drawSegment(s, s.pts[i - 1], s.pts[i]);
    },
    [drawSegment],
  );

  // ── Selection geometry (normalized 0..1 space) ─────────────────────────────
  const bboxOf = useCallback((s: WbStroke) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of s.pts) {
      if (p.x < x0) x0 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.x > x1) x1 = p.x;
      if (p.y > y1) y1 = p.y;
    }
    if (!isFinite(x0)) return { x0: 0, y0: 0, x1: 0, y1: 0 };
    if (s.tool === "text") {
      // Approximate the text box from content + font size (no measureText dep —
      // good enough for hit-testing + the selection outline).
      const wrap = wrapRef.current;
      const w = wrap?.clientWidth || 1;
      const h = wrap?.clientHeight || 1;
      const fs = Math.max(12, s.size * 3) * (s.fontScale ?? 1);
      const lines = (s.text || "").split("\n");
      const cols = lines.reduce((m, l) => Math.max(m, l.length), 1);
      x1 = x0 + (cols * fs * 0.58) / w;
      y1 = y0 + (lines.length * fs * 1.25) / h;
    }
    return { x0, y0, x1, y1 };
  }, []);

  // Topmost object under a point (last drawn = last in Map). Small px tolerance
  // so thin lines / small shapes are still grabbable.
  const hitTest = useCallback(
    (p: WbPoint): string | null => {
      const wrap = wrapRef.current;
      const padX = 8 / (wrap?.clientWidth || 1);
      const padY = 8 / (wrap?.clientHeight || 1);
      const pg = page();
      const ids = Array.from(pg.keys());
      for (let i = ids.length - 1; i >= 0; i--) {
        const s = pg.get(ids[i]);
        if (!s) continue;
        const b = bboxOf(s);
        if (
          p.x >= b.x0 - padX &&
          p.x <= b.x1 + padX &&
          p.y >= b.y0 - padY &&
          p.y <= b.y1 + padY
        )
          return ids[i];
      }
      return null;
    },
    [bboxOf],
  );

  // Union bounding box of the whole selection (null if nothing selected).
  const selBox = useCallback(() => {
    const pg = page();
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    let n = 0;
    selectedRef.current.forEach((id) => {
      const s = pg.get(id);
      if (!s) return;
      const b = bboxOf(s);
      if (b.x0 < x0) x0 = b.x0;
      if (b.y0 < y0) y0 = b.y0;
      if (b.x1 > x1) x1 = b.x1;
      if (b.y1 > y1) y1 = b.y1;
      n++;
    });
    if (!n || !isFinite(x0)) return null;
    return { x0, y0, x1, y1 };
  }, [bboxOf]);

  // Clean enterprise selection outline + resize handles + marquee.
  const drawSelectionOverlay = useCallback(() => {
    const ctx = ctxRef.current;
    const wrap = wrapRef.current;
    if (!ctx || !wrap) return;
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    const pg = page();
    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
    ctx.strokeStyle = "#5e6ad2";
    ctx.lineWidth = 1.5;
    selectedRef.current.forEach((id) => {
      const s = pg.get(id);
      if (!s) return;
      const b = bboxOf(s);
      const pad = 5;
      ctx.strokeRect(
        b.x0 * w - pad,
        b.y0 * h - pad,
        (b.x1 - b.x0) * w + pad * 2,
        (b.y1 - b.y0) * h + pad * 2,
      );
    });
    // Resize handles on the selection's union bbox (drag to scale).
    const ub = selBox();
    if (ub) {
      const pad = 5;
      const rx = ub.x0 * w - pad;
      const ry = ub.y0 * h - pad;
      const rw = (ub.x1 - ub.x0) * w + pad * 2;
      const rh = (ub.y1 - ub.y0) * h + pad * 2;
      const HS = 8;
      ctx.fillStyle = "#fff";
      ctx.strokeStyle = "#5e6ad2";
      ctx.lineWidth = 1.5;
      RESIZE_HANDLES.forEach((H) => {
        const hx = rx + rw * H.fx;
        const hy = ry + rh * H.fy;
        ctx.beginPath();
        ctx.rect(hx - HS / 2, hy - HS / 2, HS, HS);
        ctx.fill();
        ctx.stroke();
      });
    }
    const d = dragRef.current;
    if (d && d.mode === "marquee" && d.box) {
      const m = d.box;
      const rx = Math.min(m.x0, m.x1) * w;
      const ry = Math.min(m.y0, m.y1) * h;
      const rw = Math.abs(m.x1 - m.x0) * w;
      const rh = Math.abs(m.y1 - m.y0) * h;
      ctx.setLineDash([5, 4]);
      ctx.fillStyle = "rgba(94,106,210,0.08)";
      ctx.fillRect(rx, ry, rw, rh);
      ctx.strokeRect(rx, ry, rw, rh);
    }
    ctx.restore();
  }, [bboxOf, selBox]);

  const repaint = useCallback(() => {
    const ctx = ctxRef.current;
    const wrap = wrapRef.current;
    if (!ctx || !wrap) return;
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, wrap.clientWidth, wrap.clientHeight);
    page().forEach((s) => drawStroke(s));
    drawSelectionOverlay();
  }, [drawStroke, drawSelectionOverlay]);

  useEffect(() => {
    sizeCanvas();
    const wrap = wrapRef.current;
    if (!wrap || typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", sizeCanvas);
      return () => window.removeEventListener("resize", sizeCanvas);
    }
    const ro = new ResizeObserver(() => sizeCanvas());
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [sizeCanvas]);

  // Repaint whenever the visible page changes.
  useEffect(() => {
    repaint();
  }, [pageIdx, repaint]);

  // Selection is scoped to the Select tool + current page: clear it when LEAVING
  // Select or switching pages so a stale outline never lingers on wrong content.
  // It must NOT clear when ENTERING Select: Ctrl+A switches to Select and fills
  // the selection in the same tick, and an on-enter clear would wipe it.
  const prevSelToolRef = useRef(tool);
  const prevSelPageRef = useRef(pageIdx);
  useEffect(() => {
    const leftSelect = prevSelToolRef.current === "select" && tool !== "select";
    const pageChanged = prevSelPageRef.current !== pageIdx;
    prevSelToolRef.current = tool;
    prevSelPageRef.current = pageIdx;
    if (
      (leftSelect || pageChanged) &&
      (selectedRef.current.size > 0 || ctxMenu)
    ) {
      selectedRef.current.clear();
      setCtxMenu(null);
      bumpSel();
      repaint();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, pageIdx]);

  // Expire stale remote cursors.
  useEffect(() => {
    const iv = setInterval(() => {
      const now = Date.now();
      let changed = false;
      cursorsRef.current.forEach((c, id) => {
        if (now - c.ts > CURSOR_TTL) {
          cursorsRef.current.delete(id);
          changed = true;
        }
      });
      if (changed) setCursorTick((t) => t + 1);
    }, 1000);
    return () => clearInterval(iv);
  }, []);

  const ensurePage = useCallback((i: number) => {
    while (pagesRef.current.length <= i && pagesRef.current.length < MAX_PAGES)
      pagesRef.current.push(new Map());
  }, []);

  const serialize = useCallback(
    () => pagesRef.current.map((pg) => Array.from(pg.values())),
    [],
  );

  // Merge a snapshot/peer board into ours by stroke id — never all-or-nothing,
  // so local work is preserved and two sources converge idempotently.
  const mergePages = useCallback(
    (incoming: any) => {
      if (!Array.isArray(incoming)) return;
      incoming.slice(0, MAX_PAGES).forEach((arr: any, pi: number) => {
        ensurePage(pi);
        const pg = pagesRef.current[pi];
        if (!pg) return;
        (Array.isArray(arr) ? arr : []).forEach((raw: any) => {
          const id = cleanId(raw && raw.id);
          if (!id || pg.has(id)) return;
          const s = cleanStroke(raw, pi);
          if (s) pg.set(id, s);
        });
      });
      setPageCount(pagesRef.current.length);
      repaint();
    },
    [ensurePage, repaint],
  );

  // Debounced durable save (server snapshot). Coalesces bursts into one write.
  const saveTimer = useRef<any>(null);
  const scheduleSave = useCallback(() => {
    if (!saveState || saveTimer.current) return;
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      try {
        saveState(serialize());
      } catch {
        /* ignore */
      }
    }, 1500);
  }, [saveState, serialize]);

  // ── Remote ops ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const applyStroke = (m: any) => {
      const page = cleanPageIdx(m && m.stroke && m.stroke.page);
      if (page < 0) return;
      const id = cleanId(m.stroke.id);
      if (!id) return;
      const pts = cleanPts(m.pts);
      if (!pts.length) return;
      ensurePage(page);
      const pg = pagesRef.current[page];
      if (!pg) return;
      let s = pg.get(id);
      if (!s) {
        s = cleanStroke(m.stroke, page);
        if (!s) return;
        s.pts = [];
        pg.set(id, s);
      }
      const onVisible = page === pageIdxRef.current;
      for (const p of pts) {
        if (s.pts.length >= MAX_PTS_PER_STROKE) break;
        const prev = s.pts[s.pts.length - 1];
        s.pts.push(p);
        if (onVisible) {
          if (prev) drawSegment(s, prev, p);
          else if (pts.length === 1) drawSegment(s, p, p);
        }
      }
    };
    const unsub = registerReceiver((msg: any, meta?: any) => {
      if (!msg || typeof msg.op !== "string") return;
      // AUDIT #22: RECEIVER-SIDE lock/moderator enforcement (defense-in-depth).
      // A sender running modified code can skip its own readonly/canModerate
      // guards and publish ops directly over the data channel. So honest peers
      // independently reject: (a) any board-mutating op from a NON-moderator while
      // the board is LOCKED, and (b) any lock/unlock from a non-moderator. Cursor/
      // sync/sync-request/open stay ungated so presence + late-join still work.
      const fromModerator = !!(meta && meta.fromModerator);
      const MUTATING_OPS = new Set([
        "stroke", "shape", "reorder", "clear", "replace",
        "undo", "redo", "page-add", "page-remove",
      ]);
      if (lockedRef.current && !fromModerator && MUTATING_OPS.has(msg.op)) return;
      if (msg.op === "lock" && !fromModerator) return;
      switch (msg.op) {
        case "stroke":
          applyStroke(msg);
          break;
        case "shape": {
          // Full-replace element (shape / text).
          const p = cleanPageIdx(msg.stroke && msg.stroke.page);
          if (p < 0) break;
          const s = cleanStroke(msg.stroke, p);
          if (!s || !s.pts.length) break;
          ensurePage(p);
          pagesRef.current[p] && pagesRef.current[p].set(s.id, s);
          if (p === pageIdxRef.current) repaint();
          break;
        }
        case "reorder": {
          // z-order: rebuild the page Map in the given id order (Map insertion
          // order == paint/z-order). Ids the sender didn't have (race) are kept,
          // appended at the end. Idempotent: last order wins.
          const p = cleanPageIdx(msg.page);
          if (p < 0 || !Array.isArray(msg.order)) break;
          ensurePage(p);
          const pg = pagesRef.current[p];
          if (!pg) break;
          const next = new Map<string, WbStroke>();
          for (const rawId of msg.order.slice(0, MAX_PAGES * 5000)) {
            const id = cleanId(rawId);
            if (id && pg.has(id)) next.set(id, pg.get(id)!);
          }
          pg.forEach((s, id) => {
            if (!next.has(id)) next.set(id, s);
          });
          pagesRef.current[p] = next;
          if (p === pageIdxRef.current) repaint();
          break;
        }
        case "lock":
          setLocked(!!msg.locked);
          break;
        case "clear": {
          const p = cleanPageIdx(msg.page);
          if (p < 0) break;
          ensurePage(p);
          pagesRef.current[p] && pagesRef.current[p].clear();
          // AUDIT P2 (#24): purge undo/redo entries for the cleared page so a peer's
          // later Undo can't resurrect wiped content (mirrors local clearPage).
          undoRef.current = undoRef.current.filter((a) => a.page !== p);
          redoRef.current = redoRef.current.filter((a) => a.page !== p);
          refreshUndo();
          // If I'm mid-stroke on the page a peer just cleared, abort my draw so
          // a half-finished stroke isn't re-inserted/broadcast onto a wiped page.
          if (drawingRef.current && drawingRef.current.page === p) {
            drawingRef.current = null;
            pendingPts.current = [];
          }
          if (p === pageIdxRef.current) repaint();
          break;
        }
        case "replace": {
          // AUDIT P2 (#10): authoritative full-board replace (from an Import). Wipe
          // every page, then load the incoming board so all participants converge on
          // the identical content instead of unioning it onto their own.
          pagesRef.current = [new Map()];
          undoRef.current = [];
          redoRef.current = [];
          refreshUndo();
          mergePages(msg.pages);
          if (pagesRef.current.length === 0) pagesRef.current = [new Map()];
          setPageIdx((i) => Math.min(i, pagesRef.current.length - 1));
          if (typeof msg.locked === "boolean") setLocked(msg.locked);
          repaint();
          break;
        }
        case "undo": {
          const p = cleanPageIdx(msg.page);
          const id = cleanId(msg.id);
          if (p < 0 || !id) break;
          ensurePage(p);
          pagesRef.current[p] && pagesRef.current[p].delete(id);
          if (p === pageIdxRef.current) repaint();
          break;
        }
        case "redo": {
          const p = cleanPageIdx(msg.stroke && msg.stroke.page);
          if (p < 0) break;
          const s = cleanStroke(msg.stroke, p);
          if (!s) break;
          ensurePage(p);
          pagesRef.current[p] && pagesRef.current[p].set(s.id, s);
          if (p === pageIdxRef.current) repaint();
          break;
        }
        case "page-add": {
          // Append-only on receive (ignore msg.at). The only emitter always
          // appends; honouring an arbitrary insert index would shift every
          // peer's pages under their fixed pageIdx and desync absolute stroke
          // page indices. Appending never disturbs existing content.
          if (pagesRef.current.length >= MAX_PAGES) break;
          pagesRef.current.push(new Map());
          setPageCount(pagesRef.current.length);
          break;
        }
        case "page-remove": {
          const at = cleanPageIdx(msg.at);
          if (at < 0 || pagesRef.current.length <= 1) break;
          pagesRef.current.splice(at, 1);
          setPageCount(pagesRef.current.length);
          setPageIdx((i) => Math.min(i, pagesRef.current.length - 1));
          break;
        }
        case "cursor": {
          const x = clampUnit(msg.x);
          const y = clampUnit(msg.y);
          const id = cleanId(msg.id);
          if (!isFinite(x) || !isFinite(y) || !id) break;
          if (cursorsRef.current.size > 200 && !cursorsRef.current.has(id)) break;
          cursorsRef.current.set(id, {
            x,
            y,
            name: typeof msg.name === "string" ? msg.name.slice(0, 40) : "Guest",
            color: cleanColor(msg.color),
            page: cleanPageIdx(msg.page),
            ts: Date.now(),
          });
          setCursorTick((t) => t + 1);
          break;
        }
        case "sync-request": {
          // Don't answer with an empty board, and never let every holder reply
          // at once. Schedule a jittered reply; cancel it if another peer's sync
          // lands first. Coalesce repeat requests into the one pending timer.
          const empty = pagesRef.current.every((pg) => pg.size === 0);
          if (empty || syncReplyTimer.current) break;
          const requestedAt = Date.now();
          const jitter = 100 + (hashStr(selfIdRef.current) % 500);
          syncReplyTimer.current = setTimeout(() => {
            syncReplyTimer.current = null;
            if (lastSyncSeen.current > requestedAt) return; // already answered
            if (pagesRef.current.every((pg) => pg.size === 0)) return;
            broadcast({
              op: "sync",
              pages: pagesRef.current.map((pg) => Array.from(pg.values())),
              locked: lockedRef.current,
            });
          }, jitter);
          break;
        }
        case "sync":
          // MERGE by stroke id — never all-or-nothing (the late-joiner split-brain).
          lastSyncSeen.current = Date.now();
          mergePages(msg.pages);
          if (typeof msg.locked === "boolean") setLocked(msg.locked);
          break;
      }
    });
    // On open: announce, pull the DURABLE server snapshot (survives all-leave /
    // late-join even with no peer present), and pull live peer state.
    broadcast({ op: "open" });
    broadcast({ op: "sync-request" });
    if (loadState)
      loadState()
        .then((pages) => pages && mergePages(pages))
        .catch(() => {});
    return unsub;
  }, [registerReceiver, broadcast, drawSegment, repaint, loadState, mergePages]);

  // Re-pull board state after a reconnect (parent bumps resyncNonce on the
  // LiveKit Reconnected event). Skip the initial 0 — the mount effect handled it.
  useEffect(() => {
    if (!resyncNonce) return;
    broadcast({ op: "sync-request" });
    // AUDIT P2 (#23): also PUSH our local pages so strokes drawn DURING the blip
    // (which peers never received) reconverge — a pull-only resync can't recover
    // them, leaving "he says he drew it, I don't see it" divergence.
    if (pagesRef.current.some((pg) => pg.size > 0))
      broadcast({ op: "sync", pages: serialize(), locked: lockedRef.current });
    if (loadState)
      loadState()
        .then((pages) => pages && mergePages(pages))
        .catch(() => {});
  }, [resyncNonce, broadcast, loadState, mergePages, serialize]);

  // ── Local drawing ──────────────────────────────────────────────────────────
  const pointFromEvent = (e: React.PointerEvent): WbPoint => {
    const wrap = wrapRef.current!;
    const r = wrap.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    };
  };

  const flush = useCallback(() => {
    flushTimer.current = null;
    const s = drawingRef.current;
    if (!s || pendingPts.current.length === 0) return;
    const pts = pendingPts.current;
    pendingPts.current = [];
    broadcast({ op: "stroke", stroke: { ...s, pts: [] }, pts });
  }, [broadcast]);

  const scheduleFlush = useCallback(() => {
    if (flushTimer.current) return;
    flushTimer.current = setTimeout(flush, 40);
  }, [flush]);

  const sendCursor = (p: WbPoint) => {
    const now = Date.now();
    if (now - lastCursorSend.current < 60) return;
    lastCursorSend.current = now;
    broadcast({
      op: "cursor",
      id: selfIdRef.current,
      name: selfName,
      color: selfColorRef.current,
      page: pageIdxRef.current,
      x: p.x,
      y: p.y,
    });
  };

  const shapeTimer = useRef<any>(null);
  const scheduleShape = () => {
    if (shapeTimer.current) return;
    shapeTimer.current = setTimeout(() => {
      shapeTimer.current = null;
      const s = drawingRef.current;
      if (s && SHAPE_TOOLS.has(s.tool)) broadcast({ op: "shape", stroke: { ...s } });
    }, 50);
  };
  const newId = () =>
    selfIdRef.current +
    "-" +
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 6);

  // Capture the committed canvas so a shape rubber-band can be redrawn without
  // re-stroking the whole page each frame.
  const snapshotForShape = () => {
    const main = canvasRef.current;
    if (!main) return;
    let snap = shapeSnapRef.current;
    if (!snap) {
      snap = document.createElement("canvas");
      shapeSnapRef.current = snap;
    }
    snap.width = main.width;
    snap.height = main.height;
    const octx = snap.getContext("2d");
    if (octx) octx.drawImage(main, 0, 0);
  };
  const restoreShapeSnapshot = () => {
    const ctx = ctxRef.current;
    const snap = shapeSnapRef.current;
    if (!ctx || !snap) return;
    // Blit in device space (identity transform), then hand the dpr transform
    // back for the overlay shape drawn by drawStroke().
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, snap.width, snap.height);
    ctx.drawImage(snap, 0, 0);
    ctx.restore();
  };

  // AUDIT #27: commit the inline text editor → create a new text stroke or update
  // the one being edited, then broadcast + push undo + persist. Empty text discards
  // (and deletes the stroke if it was being edited to empty). Reads `editing` state.
  const commitEditing = () => {
    const ed = editingRef.current;
    if (!ed) return;
    editingRef.current = null; // consume now → dedupe blur + pointerdown double-fire
    setEditing(null);
    const txt = ed.value.replace(/\s+$/, ""); // trim only trailing whitespace/newlines
    const pg = pagesRef.current[ed.page];
    if (!pg) return;
    if (ed.id) {
      // Editing an existing stroke.
      const prev = pg.get(ed.id);
      if (!prev) return;
      // Emptied → revert (keep the original; use the delete tool to remove it).
      if (!txt.trim() || txt === prev.text) return;
      const after: WbStroke = { ...prev, text: txt };
      pg.set(after.id, after);
      repaint();
      broadcast({ op: "shape", stroke: { ...after } });
      pushAction({ t: "edit", page: ed.page, before: [prev], after: [after] });
      scheduleSave();
      return;
    }
    // New stroke.
    if (!txt.trim()) return;
    const s: WbStroke = {
      id: newId(),
      page: ed.page,
      color,
      size,
      tool: "text",
      pts: [{ x: ed.x, y: ed.y }],
      text: txt,
      fontScale: ed.fontScale,
    };
    pagesRef.current[ed.page] && pagesRef.current[ed.page].set(s.id, s);
    repaint();
    broadcast({ op: "shape", stroke: { ...s } });
    pushAction({ t: "add", page: s.page, strokes: [s] });
    scheduleSave();
  };

  // AUDIT #27: double-click a text stroke to re-open the inline editor on it (in
  // place), so text is editable after placement. Ignored while locked/readonly.
  const onCanvasDblClick = (e: React.MouseEvent) => {
    if (readonly) return;
    const p = pointFromEvent(e as any);
    const hit = hitTest(p);
    if (!hit) return;
    const s = page().get(hit);
    if (!s || s.tool !== "text") return;
    if (editing) commitEditing();
    setEditing({
      id: s.id,
      x: s.pts[0].x,
      y: s.pts[0].y,
      value: s.text || "",
      page: pageIdxRef.current,
      fontScale: s.fontScale ?? 1,
    });
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button != null && e.button !== 0) return;
    // While the inline text editor is open, canvas pointer-downs commit it rather
    // than starting a new drawing (except the text tool, which re-places above).
    if (editing && tool !== "text") {
      commitEditing();
      return;
    }
    if (readonly) return;
    const p = pointFromEvent(e);
    // ── Select tool: pick/marquee, then drag ──────────────────────────────
    if (tool === "select") {
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      setCtxMenu(null);
      // A resize-handle grab takes priority over selecting whatever is beneath.
      const ub = selBox();
      if (ub && selectedRef.current.size > 0 && wrapRef.current) {
        const w = wrapRef.current.clientWidth;
        const h = wrapRef.current.clientHeight;
        const pad = 5;
        const rx = ub.x0 * w - pad;
        const ry = ub.y0 * h - pad;
        const rw = (ub.x1 - ub.x0) * w + pad * 2;
        const rh = (ub.y1 - ub.y0) * h + pad * 2;
        const px = p.x * w;
        const py = p.y * h;
        const GRAB = 11;
        let handle: { fx: number; fy: number } | null = null;
        for (const H of RESIZE_HANDLES) {
          if (
            Math.abs(px - (rx + rw * H.fx)) <= GRAB &&
            Math.abs(py - (ry + rh * H.fy)) <= GRAB
          ) {
            handle = H;
            break;
          }
        }
        if (handle) {
          const origins = new Map<string, WbPoint[]>();
          const scales = new Map<string, number>();
          selectedRef.current.forEach((id) => {
            const s = page().get(id);
            if (s) {
              origins.set(id, s.pts.map((pt) => ({ ...pt })));
              // #27: snapshot text fontScale so resize can scale the glyphs.
              if (s.tool === "text") scales.set(id, s.fontScale ?? 1);
            }
          });
          dragRef.current = {
            mode: "resize",
            start: p,
            moved: false,
            origins,
            scales,
            handle,
            startBox: ub,
          };
          return;
        }
      }
      const hit = hitTest(p);
      const sel = selectedRef.current;
      if (hit) {
        if (e.shiftKey) {
          sel.has(hit) ? sel.delete(hit) : sel.add(hit);
        } else if (!sel.has(hit)) {
          sel.clear();
          sel.add(hit);
        }
        // Snapshot the pts of everything selected → drag translates from these
        // (absolute-from-origin, so it never accumulates rounding drift).
        const origins = new Map<string, WbPoint[]>();
        sel.forEach((id) => {
          const s = page().get(id);
          if (s) origins.set(id, s.pts.map((pt) => ({ ...pt })));
        });
        dragRef.current = { mode: "move", start: p, moved: false, origins };
      } else {
        if (!e.shiftKey) sel.clear();
        dragRef.current = {
          mode: "marquee",
          start: p,
          moved: false,
          box: { x0: p.x, y0: p.y, x1: p.x, y1: p.y },
        };
      }
      bumpSel();
      repaint();
      return;
    }
    // AUDIT #27: Text — click to place an INLINE editor (a real <textarea> over
    // the canvas) instead of a blocking single-line prompt. Multi-line, WYSIWYG,
    // committed on blur / Ctrl-Enter. If an editor is already open, commit it first.
    if (tool === "text") {
      if (editing) commitEditing();
      setEditing({ x: p.x, y: p.y, value: "", page: pageIdxRef.current, fontScale: 1 });
      return;
    }
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const s: WbStroke = { id: newId(), page: pageIdxRef.current, color, size, tool, pts: [p] };
    drawingRef.current = s;
    if (SHAPE_TOOLS.has(tool)) {
      // Keep the in-progress shape OUT of page() during the drag; snapshot the
      // committed page once, then preview via blit+overlay. Committed on release.
      s.pts.push(p); // [start, end]
      snapshotForShape();
      drawStroke(s);
    } else {
      page().set(s.id, s);
      pendingPts.current = [p];
      drawSegment(s, p, p);
      scheduleFlush();
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const p = pointFromEvent(e);
    if (!readonly) sendCursor(p);
    if (tool === "select") {
      const d = dragRef.current;
      if (!d) return;
      d.moved = true;
      if (d.mode === "marquee" && d.box) {
        d.box.x1 = p.x;
        d.box.y1 = p.y;
        repaint();
        return;
      }
      if (d.mode === "resize" && d.handle && d.startBox && d.origins) {
        // Scale every selected object's pts around the anchor (opposite edge),
        // driven by the dragged handle. Edge handles scale one axis only.
        const sb = d.startBox;
        const H = d.handle;
        let nx0 = sb.x0, nx1 = sb.x1, ny0 = sb.y0, ny1 = sb.y1;
        if (H.fx === 0) nx0 = Math.min(p.x, sb.x1 - 0.01);
        else if (H.fx === 1) nx1 = Math.max(p.x, sb.x0 + 0.01);
        if (H.fy === 0) ny0 = Math.min(p.y, sb.y1 - 0.01);
        else if (H.fy === 1) ny1 = Math.max(p.y, sb.y0 + 0.01);
        const ow = sb.x1 - sb.x0 || 1e-6;
        const oh = sb.y1 - sb.y0 || 1e-6;
        const sx = H.fx === 0.5 ? 1 : (nx1 - nx0) / ow;
        const sy = H.fy === 0.5 ? 1 : (ny1 - ny0) / oh;
        const ax = H.fx === 0 ? sb.x1 : sb.x0;
        const ay = H.fy === 0 ? sb.y1 : sb.y0;
        const pg = page();
        d.origins.forEach((orig, id) => {
          const s2 = pg.get(id);
          if (!s2) return;
          s2.pts = orig.map((pt) => ({
            x: Math.min(1, Math.max(0, ax + (pt.x - ax) * sx)),
            y: Math.min(1, Math.max(0, ay + (pt.y - ay) * sy)),
          }));
          // AUDIT #27: a text stroke is a single anchor point, so scaling pts
          // alone can't grow the glyphs — scale its fontScale uniformly instead.
          if (s2.tool === "text" && d.scales) {
            const base = d.scales.get(id) ?? 1;
            s2.fontScale = Math.max(0.2, Math.min(12, base * Math.max(sx, sy)));
          }
        });
        repaint();
        if (!moveSyncTimer.current) {
          moveSyncTimer.current = setTimeout(() => {
            moveSyncTimer.current = null;
            const pg2 = page();
            selectedRef.current.forEach((id) => {
              const s3 = pg2.get(id);
              if (s3) broadcast({ op: "shape", stroke: { ...s3 } });
            });
          }, 55);
        }
        return;
      }
      // Move: translate every selected object from its snapshot by the total
      // delta (relative positions preserved for multi-select).
      const dx = p.x - d.start.x;
      const dy = p.y - d.start.y;
      const pg = page();
      d.origins?.forEach((orig, id) => {
        const s2 = pg.get(id);
        if (!s2) return;
        s2.pts = orig.map((pt) => ({
          x: Math.min(1, Math.max(0, pt.x + dx)),
          y: Math.min(1, Math.max(0, pt.y + dy)),
        }));
      });
      repaint();
      // Throttled real-time sync — full-replace by id (idempotent, last-write-wins).
      if (!moveSyncTimer.current) {
        moveSyncTimer.current = setTimeout(() => {
          moveSyncTimer.current = null;
          const pg2 = page();
          selectedRef.current.forEach((id) => {
            const s3 = pg2.get(id);
            if (s3) broadcast({ op: "shape", stroke: { ...s3 } });
          });
        }, 55);
      }
      return;
    }
    const s = drawingRef.current;
    if (!s) return;
    if (SHAPE_TOOLS.has(s.tool)) {
      s.pts[1] = p;
      restoreShapeSnapshot(); // O(1) blit instead of full-page repaint
      drawStroke(s);
      scheduleShape();
      return;
    }
    const prev = s.pts[s.pts.length - 1];
    s.pts.push(p);
    pendingPts.current.push(p);
    if (prev) drawSegment(s, prev, p);
    scheduleFlush();
  };
  const endStroke = () => {
    // Select-tool gesture end: commit a move, or finalize a marquee selection.
    if (tool === "select" && dragRef.current) {
      const d = dragRef.current;
      dragRef.current = null;
      if (d.mode === "marquee") {
        if (d.box) {
          const x0 = Math.min(d.box.x0, d.box.x1);
          const y0 = Math.min(d.box.y0, d.box.y1);
          const x1 = Math.max(d.box.x0, d.box.x1);
          const y1 = Math.max(d.box.y0, d.box.y1);
          if (Math.abs(x1 - x0) > 0.004 || Math.abs(y1 - y0) > 0.004) {
            page().forEach((s, id) => {
              const b = bboxOf(s);
              if (b.x1 >= x0 && b.x0 <= x1 && b.y1 >= y0 && b.y0 <= y1)
                selectedRef.current.add(id);
            });
          }
        }
        bumpSel();
        repaint();
        return;
      }
      if (d.moved) {
        // Final full-replace of each moved object → convergence for a peer that
        // missed a throttled frame, plus a durable save + an undoable edit action.
        if (moveSyncTimer.current) {
          clearTimeout(moveSyncTimer.current);
          moveSyncTimer.current = null;
        }
        const pg = page();
        const before: WbStroke[] = [];
        const after: WbStroke[] = [];
        selectedRef.current.forEach((id) => {
          const s = pg.get(id);
          const orig = d.origins?.get(id);
          if (s && orig) {
            before.push({
              ...cloneStroke(s),
              pts: orig.map((p) => ({ x: p.x, y: p.y })),
            });
            after.push(cloneStroke(s));
            broadcast({ op: "shape", stroke: { ...s } });
          }
        });
        if (before.length)
          pushAction({ t: "edit", page: pageIdxRef.current, before, after });
        scheduleSave();
      }
      bumpSel();
      repaint();
      return;
    }
    const s = drawingRef.current;
    if (!s) return;
    if (SHAPE_TOOLS.has(s.tool)) {
      if (shapeTimer.current) {
        clearTimeout(shapeTimer.current);
        shapeTimer.current = null;
      }
      // Discard a bare click (no real drag) so a stray zero-size artifact isn't
      // committed/broadcast/persisted.
      const a = s.pts[0];
      const b = s.pts[s.pts.length - 1] || a;
      const w = wrapRef.current?.clientWidth || 1;
      const h = wrapRef.current?.clientHeight || 1;
      if (Math.hypot((b.x - a.x) * w, (b.y - a.y) * h) < 4) {
        // A mid-drag scheduleShape() may already have broadcast this shape id to
        // peers; send a compensating delete so a discarded bare-click can't leave
        // an orphan on their boards (a no-op for peers that never received it).
        broadcast({ op: "undo", page: s.page, id: s.id });
        drawingRef.current = null;
        repaint(); // clear the preview overlay
        return;
      }
      // Commit the shape (kept out of page() during the drag) and sync the final.
      page().set(s.id, s);
      repaint(); // reconcile with any peer ops that arrived mid-drag
      broadcast({ op: "shape", stroke: { ...s } });
    } else {
      if (flushTimer.current) {
        clearTimeout(flushTimer.current);
        flushTimer.current = null;
      }
      flush();
    }
    pushAction({ t: "add", page: s.page, strokes: [s] });
    drawingRef.current = null;
    scheduleSave();
  };

  // ── Toolbar actions ────────────────────────────────────────────────────────
  // Action-log primitives — each also broadcasts the matching op so undo/redo
  // stays in sync for every participant.
  const putStrokes = (pageN: number, strokes: WbStroke[]) => {
    ensurePage(pageN);
    const pg = pagesRef.current[pageN];
    if (!pg) return;
    strokes.forEach((s) => {
      pg.set(s.id, cloneStroke(s));
      broadcast({ op: "shape", stroke: cloneStroke(s) });
    });
    if (pageN === pageIdxRef.current) repaint();
  };
  const dropStrokes = (pageN: number, strokes: WbStroke[]) => {
    const pg = pagesRef.current[pageN];
    if (!pg) return;
    strokes.forEach((s) => {
      pg.delete(s.id);
      broadcast({ op: "undo", page: pageN, id: s.id });
    });
    if (pageN === pageIdxRef.current) repaint();
  };
  const applyOrder = (pageN: number, order: string[]) => {
    const pg = pagesRef.current[pageN];
    if (!pg) return;
    const next = new Map<string, WbStroke>();
    order.forEach((id) => {
      const s = pg.get(id);
      if (s) next.set(id, s);
    });
    pg.forEach((s, id) => {
      if (!next.has(id)) next.set(id, s);
    });
    pagesRef.current[pageN] = next;
    broadcast({ op: "reorder", page: pageN, order });
    if (pageN === pageIdxRef.current) repaint();
  };
  const undo = () => {
    if (readonly) return; // a locked-out guest may not mutate the shared board
    const a = undoRef.current.pop();
    if (!a) return;
    if (a.t === "add") dropStrokes(a.page, a.strokes);
    else if (a.t === "remove") putStrokes(a.page, a.strokes);
    else if (a.t === "edit") putStrokes(a.page, a.before);
    else applyOrder(a.page, a.before);
    redoRef.current.push(a);
    refreshUndo();
    scheduleSave();
  };
  const redo = () => {
    if (readonly) return; // a locked-out guest may not mutate the shared board
    const a = redoRef.current.pop();
    if (!a) return;
    if (a.t === "add") putStrokes(a.page, a.strokes);
    else if (a.t === "remove") dropStrokes(a.page, a.strokes);
    else if (a.t === "edit") putStrokes(a.page, a.after);
    else applyOrder(a.page, a.after);
    undoRef.current.push(a);
    refreshUndo();
    scheduleSave();
  };
  const toggleLock = () => {
    if (!canModerate) return;
    const next = !locked;
    setLocked(next);
    broadcast({ op: "lock", locked: next });
  };
  const clearPage = () => {
    if (!canModerate) return; // moderator-only destructive op
    page().clear();
    repaint();
    // Anything on this page is no longer undoable back into it.
    undoRef.current = undoRef.current.filter((a) => a.page !== pageIdxRef.current);
    redoRef.current = redoRef.current.filter((a) => a.page !== pageIdxRef.current);
    refreshUndo();
    broadcast({ op: "clear", page: pageIdxRef.current });
    scheduleSave();
  };
  const addPage = () => {
    if (readonly) return; // a locked-out guest may not grow the shared board
    const at = pagesRef.current.length;
    if (at >= MAX_PAGES) return;
    pagesRef.current.push(new Map());
    setPageCount(pagesRef.current.length);
    setPageIdx(at);
    broadcast({ op: "page-add", at });
    scheduleSave();
  };
  // AUDIT P2 (#26): the page-remove op existed but had no emitter/UI (dead code).
  // Remove the LAST page only — that can never shift the absolute page index of
  // strokes on other pages (the same reason page-add is append-only), so it's safe
  // to sync without re-indexing. Covers the common "added a page by mistake" case.
  const removeLastPage = () => {
    if (readonly || pagesRef.current.length <= 1) return;
    const at = pagesRef.current.length - 1;
    pagesRef.current.splice(at, 1);
    undoRef.current = undoRef.current.filter((a) => a.page !== at);
    redoRef.current = redoRef.current.filter((a) => a.page !== at);
    refreshUndo();
    setPageCount(pagesRef.current.length);
    setPageIdx((i) => Math.min(i, pagesRef.current.length - 1));
    broadcast({ op: "page-remove", at });
    scheduleSave();
  };
  const goPage = (i: number) => {
    const next = Math.max(0, Math.min(pagesRef.current.length - 1, i));
    setPageIdx(next);
  };

  // ── Selection actions (delete / duplicate / z-order) ───────────────────────
  // Guards read lockedRef/canModerateRef (not the render-time `readonly`) so the
  // mount-time keyboard closure stays correct after a co-host promotion.
  const clearSelection = () => {
    selectedRef.current.clear();
    setCtxMenu(null);
    bumpSel();
    repaint();
  };
  const deleteSelection = () => {
    if (lockedRef.current && !canModerateRef.current) return;
    const sel = selectedRef.current;
    if (sel.size === 0) return;
    const pg = page();
    const removed: WbStroke[] = [];
    sel.forEach((id) => {
      const s = pg.get(id);
      if (s) removed.push(cloneStroke(s));
    });
    removed.forEach((s) => {
      pg.delete(s.id);
      broadcast({ op: "undo", page: pageIdxRef.current, id: s.id });
    });
    if (removed.length)
      pushAction({ t: "remove", page: pageIdxRef.current, strokes: removed });
    sel.clear();
    setCtxMenu(null);
    bumpSel();
    repaint();
    scheduleSave();
  };
  const duplicateSelection = () => {
    if (lockedRef.current && !canModerateRef.current) return;
    const sel = selectedRef.current;
    if (sel.size === 0) return;
    const pg = page();
    const cloneIds: string[] = [];
    const clones: WbStroke[] = [];
    Array.from(sel).forEach((id) => {
      const s = pg.get(id);
      if (!s) return;
      const clone: WbStroke = {
        ...s,
        id: newId(),
        pts: s.pts.map((pt) => ({
          x: Math.min(1, pt.x + 0.02),
          y: Math.min(1, pt.y + 0.02),
        })),
      };
      pg.set(clone.id, clone);
      broadcast({ op: "shape", stroke: { ...clone } });
      clones.push(cloneStroke(clone));
      cloneIds.push(clone.id);
    });
    if (clones.length)
      pushAction({ t: "add", page: pageIdxRef.current, strokes: clones });
    sel.clear();
    cloneIds.forEach((id) => sel.add(id));
    setCtxMenu(null);
    bumpSel();
    repaint();
    scheduleSave();
  };
  const reorderSelection = (dir: "front" | "back") => {
    if (lockedRef.current && !canModerateRef.current) return;
    const sel = selectedRef.current;
    if (sel.size === 0) return;
    const pg = page();
    const ids = Array.from(pg.keys());
    const selIds = ids.filter((id) => sel.has(id));
    const others = ids.filter((id) => !sel.has(id));
    const order =
      dir === "front" ? [...others, ...selIds] : [...selIds, ...others];
    const next = new Map<string, WbStroke>();
    order.forEach((id) => {
      const s = pg.get(id);
      if (s) next.set(id, s);
    });
    pagesRef.current[pageIdxRef.current] = next;
    broadcast({ op: "reorder", page: pageIdxRef.current, order });
    pushAction({
      t: "reorder",
      page: pageIdxRef.current,
      before: ids,
      after: order,
    });
    setCtxMenu(null);
    repaint();
    scheduleSave();
  };
  // Right-click (desktop) / long-press (touch handled by the browser) → context
  // menu, but only over a selection. If the click landed on an unselected object,
  // select it first so the menu acts on what the user pointed at.
  const onContextMenu = (e: React.MouseEvent) => {
    if (tool !== "select" || (lockedRef.current && !canModerateRef.current)) return;
    e.preventDefault();
    const wrap = wrapRef.current;
    if (!wrap) return;
    const r = wrap.getBoundingClientRect();
    const p = {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    };
    const hit = hitTest(p);
    if (hit && !selectedRef.current.has(hit)) {
      selectedRef.current.clear();
      selectedRef.current.add(hit);
      bumpSel();
      repaint();
    }
    if (selectedRef.current.size === 0) return;
    setCtxMenu({ x: e.clientX - r.left, y: e.clientY - r.top });
  };

  // Keyboard: Ctrl/Cmd+Z undo, Ctrl/Cmd+Shift+Z (or Ctrl+Y) redo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing =
        !!t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable);
      const editable = !(lockedRef.current && !canModerateRef.current);
      // Selection shortcuts (no modifier) — ignored while typing in a field.
      if (!typing && editable) {
        if (e.key === "Delete" || e.key === "Backspace") {
          if (selectedRef.current.size > 0) {
            e.preventDefault();
            deleteSelection();
            return;
          }
        } else if (e.key === "Escape") {
          if (selectedRef.current.size > 0) {
            clearSelection();
            return;
          }
          setCtxMenu(null);
        }
      }
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      // Respect the lock: a non-moderator can't mutate a locked board.
      if (!editable) return;
      const k = e.key.toLowerCase();
      if (k === "z") {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
      } else if (k === "y") {
        e.preventDefault();
        redo();
      } else if (k === "d") {
        e.preventDefault();
        duplicateSelection();
      } else if (k === "a") {
        // Select all on the current page (switches to the Select tool).
        e.preventDefault();
        setTool("select");
        selectedRef.current = new Set(page().keys());
        bumpSel();
        repaint();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Save / export / import ─────────────────────────────────────────────────
  const download = (blob: Blob, name: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };
  // Composite the current page onto a white background WITHOUT the selection UI
  // (outline / resize handles / marquee) and hand the clean canvas to `use`.
  // Shared by PNG and PDF export so both produce identical, chrome-free output.
  const withCleanExport = (use: (out: HTMLCanvasElement) => void) => {
    const src = canvasRef.current;
    if (!src) return;
    const savedSel = selectedRef.current;
    selectedRef.current = new Set();
    repaint();
    const out = document.createElement("canvas");
    out.width = src.width;
    out.height = src.height;
    const octx = out.getContext("2d");
    if (octx) {
      octx.fillStyle = "#ffffff";
      octx.fillRect(0, 0, out.width, out.height);
      octx.drawImage(src, 0, 0);
    }
    // Selection captured off the CLEAN canvas — restore the on-screen selection.
    selectedRef.current = savedSel;
    repaint();
    if (octx) use(out);
  };
  const exportPNG = () => {
    setSaveOpen(false);
    withCleanExport((out) =>
      out.toBlob(
        (b) => b && download(b, `whiteboard-page-${pageIdx + 1}.png`),
        "image/png",
      ),
    );
  };
  // BA/CEO #22: export as a real PDF (JSON export/import removed — end users want
  // a shareable image/document, not the internal board format).
  const exportPDF = () => {
    setSaveOpen(false);
    withCleanExport((out) =>
      download(canvasToPdfBlob(out), `whiteboard-page-${pageIdx + 1}.pdf`),
    );
  };

  useEffect(
    () => () => {
      if (flushTimer.current) clearTimeout(flushTimer.current);
      if (shapeTimer.current) clearTimeout(shapeTimer.current);
      if (syncReplyTimer.current) clearTimeout(syncReplyTimer.current);
      // Flush a final durable save on close so the last strokes aren't lost.
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      if (saveState) {
        try {
          saveState(pagesRef.current.map((pg) => Array.from(pg.values())));
        } catch {
          /* ignore */
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const visibleCursors: any[] = [];
  cursorsRef.current.forEach((c, id) => {
    if (c.page === pageIdx && id !== selfIdRef.current) visibleCursors.push({ id, ...c });
  });

  return (
    <div className="wb-overlay" role="dialog" aria-label="Collaborative whiteboard">
      <div className="wb-toolbar">
        <span className="wb-title">
          <IconPencil size={14} /> {title}
        </span>
        {readonly && (
          <span className="wb-viewonly">
            <IconLock size={11} /> View only
          </span>
        )}
        <div className="wb-group">
          <button
            className={"wb-tool" + (tool === "select" ? " on" : "")}
            onClick={() => setTool("select")}
            title="Select / move objects"
            aria-label="Select"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M5 3l6 16 2-7 7-2z" />
            </svg>
          </button>
          <button
            className={"wb-tool" + (tool === "pen" ? " on" : "")}
            onClick={() => setTool("pen")}
            title="Pen"
            aria-label="Pen"
          >
            <IconPencil size={15} />
          </button>
          <button
            className={"wb-tool" + (tool === "highlighter" ? " on" : "")}
            onClick={() => setTool("highlighter")}
            title="Highlighter"
            aria-label="Highlighter"
          >
            <span className="wb-hl-dot" />
          </button>
          <button
            className={"wb-tool" + (tool === "eraser" ? " on" : "")}
            onClick={() => setTool("eraser")}
            title="Eraser"
            aria-label="Eraser"
          >
            Erase
          </button>
        </div>
        <div className="wb-group">
          <button
            className={"wb-tool" + (tool === "rect" ? " on" : "")}
            onClick={() => setTool("rect")}
            title="Rectangle"
            aria-label="Rectangle"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="4" y="6" width="16" height="12" rx="1.5" />
            </svg>
          </button>
          <button
            className={"wb-tool" + (tool === "ellipse" ? " on" : "")}
            onClick={() => setTool("ellipse")}
            title="Ellipse"
            aria-label="Ellipse"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <ellipse cx="12" cy="12" rx="9" ry="6.5" />
            </svg>
          </button>
          <button
            className={"wb-tool" + (tool === "line" ? " on" : "")}
            onClick={() => setTool("line")}
            title="Line"
            aria-label="Line"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <line x1="5" y1="19" x2="19" y2="5" />
            </svg>
          </button>
          <button
            className={"wb-tool" + (tool === "arrow" ? " on" : "")}
            onClick={() => setTool("arrow")}
            title="Arrow"
            aria-label="Arrow"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="5" y1="12" x2="18" y2="12" />
              <polyline points="12 6 18 12 12 18" />
            </svg>
          </button>
          <button
            className={"wb-tool" + (tool === "text" ? " on" : "")}
            onClick={() => setTool("text")}
            title="Text"
            aria-label="Text"
            style={{ fontWeight: 800, fontSize: 14 }}
          >
            T
          </button>
        </div>
        <div className="wb-colors">
          {COLORS.map((c) => (
            <button
              key={c}
              className={"wb-swatch" + (tool !== "eraser" && color === c ? " on" : "")}
              style={{ background: c }}
              aria-label={"Colour " + c}
              onClick={() => {
                setColor(c);
                if (tool === "eraser") setTool("pen");
              }}
            />
          ))}
        </div>
        <div className="wb-sizes">
          {SIZES.map((s) => (
            <button
              key={s}
              className={"wb-size" + (size === s ? " on" : "")}
              aria-label={"Brush size " + s}
              onClick={() => setSize(s)}
            >
              <span style={{ width: s, height: s }} />
            </button>
          ))}
        </div>
        <div className="wb-group">
          <button className="wb-tool" onClick={undo} disabled={!canUndo || readonly} title="Undo (Ctrl+Z)" aria-label="Undo">
            <IconUndo size={15} />
          </button>
          <button className="wb-tool" onClick={redo} disabled={!canRedo || readonly} title="Redo (Ctrl+Shift+Z)" aria-label="Redo">
            <IconRepeat size={15} />
          </button>
          {canModerate && (
            <button
              className={"wb-tool" + (locked ? " on" : "")}
              onClick={toggleLock}
              title={locked ? "Unlock board" : "Lock board — others view-only"}
              aria-label={locked ? "Unlock board" : "Lock board"}
            >
              {locked ? <IconLock size={15} /> : <IconLockOpen size={15} />}
            </button>
          )}
          {canModerate && (
            <button className="wb-tool" onClick={clearPage} title="Clear page" aria-label="Clear page">
              <IconTrash size={15} />
            </button>
          )}
        </div>
        <div className="wb-group wb-pages">
          <button className="wb-tool" onClick={() => goPage(pageIdx - 1)} disabled={pageIdx <= 0} aria-label="Previous page">
            <IconChevronLeft size={15} />
          </button>
          <span className="wb-page-n">
            {pageIdx + 1} / {pageCount}
          </span>
          <button className="wb-tool" onClick={() => goPage(pageIdx + 1)} disabled={pageIdx >= pageCount - 1} aria-label="Next page">
            <IconChevronRight size={15} />
          </button>
          <button className="wb-tool" onClick={addPage} disabled={readonly} title="Add page" aria-label="Add page">
            <IconPlus size={15} />
          </button>
          <button
            className="wb-tool"
            onClick={removeLastPage}
            disabled={readonly || pageCount <= 1}
            title="Remove last page"
            aria-label="Remove last page"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M5 12h14" />
            </svg>
          </button>
        </div>
        <div style={{ flex: 1 }} />
        <div className="wb-group" style={{ position: "relative" }}>
          <button className="wb-tool" onClick={() => setSaveOpen((v) => !v)} title="Save / export" aria-label="Save or export">
            <IconDownload size={15} /> Save
          </button>
          {saveOpen && (
            <div className="wb-save-menu" onMouseLeave={() => setSaveOpen(false)}>
              <button onClick={exportPNG}>
                <IconImage size={14} /> Export PNG (this page)
              </button>
              <button onClick={exportPDF}>
                <IconDownload size={14} /> Export PDF (this page)
              </button>
            </div>
          )}
        </div>
        <button className="wb-tool wb-close" onClick={onClose} title="Close whiteboard" aria-label="Close whiteboard">
          <IconX size={16} />
        </button>
      </div>
      <div className="wb-canvas-wrap" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          className={
            "wb-canvas" +
            (readonly ? " wb-readonly" : "") +
            (tool === "select" ? " wb-select" : "")
          }
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endStroke}
          onPointerCancel={endStroke}
          onPointerLeave={endStroke}
          onContextMenu={onContextMenu}
          onDoubleClick={onCanvasDblClick}
        />
        {/* AUDIT #27: inline text editor — a real <textarea> positioned over the
            canvas at the stroke's normalized anchor. Multi-line, WYSIWYG (matches
            the canvas font). Commit on blur or Ctrl/Cmd+Enter; Escape cancels;
            Shift+Enter inserts a newline. */}
        {editing ? (
          <textarea
            ref={textareaRef}
            className="wb-text-editor"
            autoFocus
            rows={Math.max(1, editing.value.split("\n").length)}
            cols={Math.max(
              6,
              editing.value.split("\n").reduce((m, l) => Math.max(m, l.length), 0) + 1,
            )}
            value={editing.value}
            onChange={(e) =>
              setEditing((ed) => (ed ? { ...ed, value: e.target.value } : ed))
            }
            onBlur={() => commitEditing()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") {
                e.preventDefault();
                setEditing(null);
              } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                commitEditing();
              }
            }}
            style={{
              position: "absolute",
              left: `${editing.x * 100}%`,
              top: `${editing.y * 100}%`,
              color,
              font: `600 ${Math.max(12, size * 3) * editing.fontScale}px Inter, system-ui, sans-serif`,
              lineHeight: 1.25,
            }}
          />
        ) : null}
        {/* Live peer cursors (data-driven, keyed off cursorTick) */}
        {visibleCursors.map((c) => (
          <div
            key={c.id}
            className="wb-cursor"
            style={{ left: `${c.x * 100}%`, top: `${c.y * 100}%`, color: c.color }}
            aria-hidden
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill={c.color} stroke="#fff" strokeWidth="1">
              <path d="M5 3l6 16 2-7 7-2z" />
            </svg>
            <span className="wb-cursor-name" style={{ background: c.color }}>
              {c.name}
            </span>
          </div>
        ))}
        <span style={{ display: "none" }}>{cursorTick}</span>
        {/* Selection context menu (right-click / long-press over a selection). */}
        {ctxMenu && (
          <>
            <div
              className="wb-ctx-scrim"
              onPointerDown={() => setCtxMenu(null)}
              onContextMenu={(e) => {
                e.preventDefault();
                setCtxMenu(null);
              }}
            />
            <div
              className="wb-ctx-menu"
              style={{ left: ctxMenu.x, top: ctxMenu.y }}
              role="menu"
            >
              <button role="menuitem" onClick={duplicateSelection}>
                Duplicate
              </button>
              <button role="menuitem" onClick={() => reorderSelection("front")}>
                Bring to front
              </button>
              <button role="menuitem" onClick={() => reorderSelection("back")}>
                Send to back
              </button>
              <div className="wb-ctx-sep" />
              <button
                role="menuitem"
                className="wb-ctx-danger"
                onClick={deleteSelection}
              >
                Delete
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
