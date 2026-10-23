import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import config from "../lib/config";
import type { PickedMedia } from "./GifPicker";
import { EMOJI_CATEGORIES } from "../lib/emojiData";
import { encodeGif, type GifFrame } from "../lib/studio/gif";
import { cutoutPerson } from "../lib/studio/cutout";

// The in-app sticker / GIF creation studio — a WhatsApp/Instagram-style editor.
// Fully offline, cost-free, no external service: a photo or short camera clip is
// composited on a <canvas> with draggable text + emoji overlays, freehand draw,
// and optional one-tap background removal (reusing the local MediaPipe model),
// then exported as a transparent still sticker (WebP) or an animated .gif and
// uploaded into the user's sticker tray via the existing keyless upload path.

const STAGE = 300; // on-screen editor square (px)
const STICKER_OUT = 512; // exported still-sticker resolution
const GIF_OUT = 320; // exported animated-gif resolution
const GIF_FPS = 12;
const GIF_MAX_MS = 3000;

type Mode = "sticker" | "gif";
type Tool = "move" | "draw";

type Overlay = {
  id: number;
  kind: "text" | "emoji";
  content: string;
  x: number; // centre, in stage px
  y: number;
  scale: number;
  rot: number; // degrees
  color: string;
};

type Stroke = { color: string; size: number; pts: { x: number; y: number }[] };

// A captured base frame: the source drawn cover-fit into an OUT×OUT canvas.
type BaseFrame = { canvas: HTMLCanvasElement };

const PALETTE = ["#ffffff", "#111827", "#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#a855f7", "#ec4899"];

function abs(u: string): string {
  if (!u) return u;
  if (/^https?:\/\//i.test(u)) return u;
  return (config.apiBaseUrl || "") + u;
}

// Draw a source (image/canvas/video) cover-fit (crop overflow) into a square ctx,
// honouring an optional pan/zoom expressed in OUT-space.
function drawCover(
  ctx: CanvasRenderingContext2D,
  src: CanvasImageSource,
  sw: number,
  sh: number,
  out: number,
  zoom = 1,
  panX = 0,
  panY = 0,
) {
  if (!sw || !sh) return;
  const base = Math.max(out / sw, out / sh);
  const s = base * zoom;
  const dw = sw * s;
  const dh = sh * s;
  ctx.drawImage(src, (out - dw) / 2 + panX, (out - dh) / 2 + panY, dw, dh);
}

export default function MediaStudio({
  getToken,
  mode: initialMode = "sticker",
  onClose,
}: {
  // A getter (not a snapshot) so uploads read the CURRENT token — the auth token
  // can rotate (Phase 5) between the studio opening and the user hitting Send.
  getToken: () => string | null;
  mode?: Mode;
  onClose: (media: PickedMedia | null) => void;
}) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [step, setStep] = useState<"source" | "edit">("source");
  const [tool, setTool] = useState<Tool>("move");
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");

  // Base content: one frame for a sticker, many for a GIF.
  const framesRef = useRef<BaseFrame[]>([]);
  const [hasBase, setHasBase] = useState(false);
  const [transparentBase, setTransparentBase] = useState(false); // blank / cut-out

  // Base pan/zoom (still sticker only), in OUT-space px.
  const [zoom, setZoom] = useState(1);
  const panRef = useRef({ x: 0, y: 0 });

  // Overlays + freehand strokes.
  const [overlays, setOverlays] = useState<Overlay[]>([]);
  const [selId, setSelId] = useState<number | null>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const seqRef = useRef(1);

  const [drawColor, setDrawColor] = useState("#ef4444");
  const [drawSize, setDrawSize] = useState(6);

  // Emoji + text entry UI.
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [emojiQ, setEmojiQ] = useState("");
  const [textEntry, setTextEntry] = useState<{ id: number | null; value: string } | null>(null);

  // Camera.
  const [cam, setCam] = useState(false);
  const camStreamRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [recording, setRecording] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const baseCanvasRef = useRef<HTMLCanvasElement | null>(null); // preview (STAGE)
  const drawCanvasRef = useRef<HTMLCanvasElement | null>(null); // OUT backing, css-scaled
  const drawingRef = useRef<Stroke | null>(null);
  const dragRef = useRef<{ id: number; dx: number; dy: number } | null>(null);
  const panDragRef = useRef<{ x: number; y: number; px: number; py: number } | null>(null);

  const OUT = mode === "gif" ? GIF_OUT : STICKER_OUT;

  // ---- lifecycle ------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        cancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return () => stopCamera();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopCamera = () => {
    try {
      camStreamRef.current?.getTracks().forEach((t) => t.stop());
    } catch {
      /* noop */
    }
    camStreamRef.current = null;
  };

  const cancel = () => {
    stopCamera();
    onClose(null);
  };

  // ---- base ingestion -------------------------------------------------------
  const makeCanvas = (w: number, h: number) => {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
  };

  const setSingleBase = (canvas: HTMLCanvasElement, transparent: boolean) => {
    framesRef.current = [{ canvas }];
    setTransparentBase(transparent);
    setHasBase(true);
    setStep("edit");
    setZoom(1);
    panRef.current = { x: 0, y: 0 };
    requestAnimationFrame(renderPreview);
  };

  const ingestImageFile = (file: File) => {
    setErr("");
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => {
      const c = makeCanvas(OUT, OUT);
      const ctx = c.getContext("2d")!;
      drawCover(ctx, im, im.naturalWidth, im.naturalHeight, OUT);
      URL.revokeObjectURL(url);
      // store the raw image too so re-cropping (pan/zoom) can re-cover-fit
      (c as any)._src = im;
      setSingleBase(c, false);
    };
    im.onerror = () => {
      URL.revokeObjectURL(url);
      setErr("Couldn't read that image.");
    };
    im.src = url;
  };

  const startBlank = () => {
    const c = makeCanvas(OUT, OUT); // fully transparent
    setSingleBase(c, true);
  };

  // ---- camera ---------------------------------------------------------------
  const openCamera = async () => {
    setErr("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 720 }, height: { ideal: 720 } },
        audio: false,
      });
      camStreamRef.current = stream;
      setCam(true);
      requestAnimationFrame(() => {
        const v = videoRef.current;
        if (v) {
          v.srcObject = stream;
          v.play().catch(() => {});
        }
      });
    } catch {
      setErr("Camera unavailable — check permissions, or upload a photo.");
    }
  };

  // Capture the current camera frame into an OUT×OUT canvas, MIRRORED to match the
  // mirrored selfie preview (the <video> has scaleX(-1)) so the saved sticker/GIF
  // matches what the user framed — no surprise left-right flip.
  const captureFrame = (v: HTMLVideoElement): HTMLCanvasElement => {
    const c = makeCanvas(OUT, OUT);
    const ctx = c.getContext("2d")!;
    ctx.save();
    ctx.translate(OUT, 0);
    ctx.scale(-1, 1);
    drawCover(ctx, v, v.videoWidth, v.videoHeight, OUT);
    ctx.restore();
    return c;
  };

  const snapPhoto = () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    const c = captureFrame(v);
    stopCamera();
    setCam(false);
    setSingleBase(c, false);
  };

  const recordClip = async () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    setRecording(true);
    const frames: BaseFrame[] = [];
    const interval = 1000 / GIF_FPS;
    const start = performance.now();
    await new Promise<void>((resolve) => {
      let last = 0;
      const tick = (now: number) => {
        if (now - last >= interval - 2) {
          last = now;
          frames.push({ canvas: captureFrame(v) });
        }
        if (now - start < GIF_MAX_MS && camStreamRef.current) {
          requestAnimationFrame(tick);
        } else {
          resolve();
        }
      };
      requestAnimationFrame(tick);
    });
    setRecording(false);
    stopCamera();
    setCam(false);
    if (!frames.length) {
      setErr("Recording failed — try again.");
      return;
    }
    framesRef.current = frames;
    setTransparentBase(false);
    setHasBase(true);
    setStep("edit");
    requestAnimationFrame(renderPreview);
  };

  // ---- background cutout ----------------------------------------------------
  const doCutout = async () => {
    if (!framesRef.current.length) return;
    setBusy("Removing background…");
    setErr("");
    try {
      const next: BaseFrame[] = [];
      for (const f of framesRef.current) {
        // Bake the CURRENT pan/zoom framing into the pixels first, so segmentation
        // runs on what the user framed (not the raw un-zoomed image) and the result
        // preserves that framing. The cut canvas has no _src, so pan/zoom no longer
        // applies afterward — reset the controls below to match.
        const src: any = (f.canvas as any)._src || f.canvas;
        const framed = makeCanvas(OUT, OUT);
        const fctx = framed.getContext("2d")!;
        if ((f.canvas as any)._src) {
          drawCover(fctx, src, src.naturalWidth || src.width, src.naturalHeight || src.height, OUT, zoom, panRef.current.x, panRef.current.y);
        } else {
          fctx.drawImage(f.canvas, 0, 0, OUT, OUT);
        }
        const cut = await cutoutPerson(framed);
        const c = makeCanvas(OUT, OUT);
        c.getContext("2d")!.drawImage(cut, 0, 0, OUT, OUT);
        next.push({ canvas: c });
      }
      framesRef.current = next;
      setTransparentBase(true);
      setZoom(1);
      panRef.current = { x: 0, y: 0 };
      renderPreview();
    } catch {
      setErr("Background removal isn't available here — the image is unchanged.");
    } finally {
      setBusy("");
    }
  };

  // ---- preview render -------------------------------------------------------
  // The base preview canvas shows frame 0 (still) or the first frame (gif),
  // cover-fit with the current pan/zoom; strokes live on a separate scaled
  // canvas; overlays are DOM elements. Export re-composites everything.
  const renderPreview = useCallback(() => {
    const c = baseCanvasRef.current;
    const frame = framesRef.current[0];
    if (!c) return;
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, c.width, c.height);
    if (!frame) return;
    const src: any = (frame.canvas as any)._src || frame.canvas;
    const sw = src.naturalWidth || src.width;
    const sh = src.naturalHeight || src.height;
    // If we have the raw image, re-cover-fit with pan/zoom; else blit the frame.
    if ((frame.canvas as any)._src) {
      const scale = STAGE / OUT;
      ctx.save();
      ctx.scale(scale, scale);
      drawCover(ctx, src, sw, sh, OUT, zoom, panRef.current.x, panRef.current.y);
      ctx.restore();
    } else {
      ctx.drawImage(frame.canvas, 0, 0, STAGE, STAGE);
    }
  }, [zoom, OUT]);

  useEffect(() => {
    renderPreview();
  }, [renderPreview, hasBase, transparentBase]);

  // ---- freehand draw --------------------------------------------------------
  const drawStrokeLive = (s: Stroke) => {
    const c = drawCanvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    if (s.pts.length < 2) return;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.size * (OUT / STAGE);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const a = s.pts[s.pts.length - 2];
    const b = s.pts[s.pts.length - 1];
    const k = OUT / STAGE;
    ctx.beginPath();
    ctx.moveTo(a.x * k, a.y * k);
    ctx.lineTo(b.x * k, b.y * k);
    ctx.stroke();
  };

  const redrawAllStrokes = () => {
    const c = drawCanvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, c.width, c.height);
    const k = OUT / STAGE;
    for (const s of strokesRef.current) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.size * k;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      s.pts.forEach((p, i) => (i ? ctx.lineTo(p.x * k, p.y * k) : ctx.moveTo(p.x * k, p.y * k)));
      ctx.stroke();
    }
  };

  const stagePoint = (e: React.PointerEvent) => {
    const r = stageRef.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * STAGE, y: ((e.clientY - r.top) / r.height) * STAGE };
  };

  const onStagePointerDown = (e: React.PointerEvent) => {
    if (step !== "edit") return;
    setSelId(null);
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    if (tool === "draw") {
      const p = stagePoint(e);
      drawingRef.current = { color: drawColor, size: drawSize, pts: [p] };
    } else if (mode === "sticker" && framesRef.current[0] && (framesRef.current[0].canvas as any)._src) {
      panDragRef.current = { x: e.clientX, y: e.clientY, px: panRef.current.x, py: panRef.current.y };
    }
  };
  const onStagePointerMove = (e: React.PointerEvent) => {
    if (drawingRef.current) {
      drawingRef.current.pts.push(stagePoint(e));
      drawStrokeLive(drawingRef.current);
    } else if (panDragRef.current) {
      const k = OUT / (stageRef.current!.getBoundingClientRect().width);
      panRef.current = {
        x: panDragRef.current.px + (e.clientX - panDragRef.current.x) * k,
        y: panDragRef.current.py + (e.clientY - panDragRef.current.y) * k,
      };
      renderPreview();
    }
  };
  const onStagePointerUp = () => {
    if (drawingRef.current) {
      if (drawingRef.current.pts.length > 1) strokesRef.current.push(drawingRef.current);
      drawingRef.current = null;
    }
    panDragRef.current = null;
  };

  // ---- overlays -------------------------------------------------------------
  const addEmoji = (ch: string) => {
    setOverlays((o) => [...o, { id: seqRef.current++, kind: "emoji", content: ch, x: STAGE / 2, y: STAGE / 2, scale: 1, rot: 0, color: "#000" }]);
    setEmojiOpen(false);
  };
  const commitText = () => {
    if (!textEntry) return;
    const value = textEntry.value.trim();
    if (!value) {
      setTextEntry(null);
      return;
    }
    if (textEntry.id != null) {
      setOverlays((o) => o.map((v) => (v.id === textEntry.id ? { ...v, content: value } : v)));
    } else {
      setOverlays((o) => [...o, { id: seqRef.current++, kind: "text", content: value, x: STAGE / 2, y: STAGE / 2, scale: 1, rot: 0, color: "#ffffff" }]);
    }
    setTextEntry(null);
  };

  const onOverlayPointerDown = (e: React.PointerEvent, id: number) => {
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    setSelId(id);
    const ov = overlays.find((o) => o.id === id)!;
    const p = stagePoint(e);
    dragRef.current = { id, dx: ov.x - p.x, dy: ov.y - p.y };
  };
  const onOverlayPointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const p = stagePoint(e);
    const { id, dx, dy } = dragRef.current;
    setOverlays((o) => o.map((v) => (v.id === id ? { ...v, x: p.x + dx, y: p.y + dy } : v)));
  };
  const onOverlayPointerUp = () => {
    dragRef.current = null;
  };

  const updateSel = (patch: Partial<Overlay>) => {
    if (selId == null) return;
    setOverlays((o) => o.map((v) => (v.id === selId ? { ...v, ...patch } : v)));
  };
  const removeSel = () => {
    if (selId == null) return;
    setOverlays((o) => o.filter((v) => v.id !== selId));
    setSelId(null);
  };

  const clearDraw = () => {
    strokesRef.current = [];
    redrawAllStrokes();
  };

  // ---- export ---------------------------------------------------------------
  // Composite base(frame) + strokes + overlays into an OUT×OUT canvas.
  const composite = (frame: BaseFrame): HTMLCanvasElement => {
    const c = makeCanvas(OUT, OUT);
    // willReadFrequently here (not at the later getImageData call) so the GIF
    // export's per-frame readbacks actually get CPU-backed storage — a repeat
    // getContext with different options returns the same, already-created context.
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    const src: any = (frame.canvas as any)._src || frame.canvas;
    const sw = src.naturalWidth || src.width;
    const sh = src.naturalHeight || src.height;
    if ((frame.canvas as any)._src) {
      drawCover(ctx, src, sw, sh, OUT, zoom, panRef.current.x, panRef.current.y);
    } else {
      ctx.drawImage(frame.canvas, 0, 0, OUT, OUT);
    }
    // strokes
    const dc = drawCanvasRef.current;
    if (dc) ctx.drawImage(dc, 0, 0, OUT, OUT);
    // overlays
    const k = OUT / STAGE;
    for (const ov of overlays) {
      ctx.save();
      ctx.translate(ov.x * k, ov.y * k);
      ctx.rotate((ov.rot * Math.PI) / 180);
      if (ov.kind === "emoji") {
        const size = 64 * ov.scale * k;
        ctx.font = `${size}px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(ov.content, 0, 0);
      } else {
        const size = 34 * ov.scale * k;
        ctx.font = `800 ${size}px system-ui,-apple-system,"Segoe UI",sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        // Match the DOM preview's soft drop-shadow (textShadow "0 2px 6px …"),
        // scaled to export resolution — NOT a hard outline, so WYSIWYG holds.
        ctx.shadowColor = "rgba(0,0,0,.5)";
        ctx.shadowBlur = 6 * k;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 2 * k;
        ctx.fillStyle = ov.color;
        ctx.fillText(ov.content, 0, 0);
      }
      ctx.restore();
    }
    return c;
  };

  const exportStill = (): Promise<{ blob: Blob; mime: string }> =>
    new Promise((resolve, reject) => {
      const c = composite(framesRef.current[0]);
      // WebP keeps smooth alpha; PNG fallback if the browser can't encode webp.
      c.toBlob(
        (b) => (b ? resolve({ blob: b, mime: "image/webp" }) : c.toBlob((p) => (p ? resolve({ blob: p, mime: "image/png" }) : reject(new Error("encode failed"))), "image/png")),
        "image/webp",
        0.92,
      );
    });

  const exportGif = (): { blob: Blob; mime: string } => {
    const frames: GifFrame[] = [];
    const delay = 1000 / GIF_FPS;
    const list = framesRef.current;
    for (const f of list) {
      const comp = composite(f);
      const ctx = comp.getContext("2d", { willReadFrequently: true })!;
      const img = ctx.getImageData(0, 0, OUT, OUT);
      frames.push({ data: img.data, delayMs: delay });
    }
    const blob = encodeGif(frames, OUT, OUT, { transparent: transparentBase, maxColors: 256 });
    return { blob, mime: "image/gif" };
  };

  // Rendered output held for the PREVIEW step — the user sees the final sticker
  // (or the actual ANIMATED gif, via the blob URL) before it's uploaded/sent.
  const [preview, setPreview] = useState<{ url: string; blob: Blob; mime: string } | null>(null);

  // Render the composed output to a blob and show the preview overlay (does NOT
  // upload). A real GIF blob animates in the <img>, so "what you see is what sends".
  const buildPreview = async () => {
    if (!framesRef.current.length) return;
    setBusy(mode === "gif" ? "Rendering GIF…" : "Rendering…");
    setErr("");
    try {
      let blob: Blob;
      let mime: string;
      if (mode === "gif") {
        await new Promise((r) => setTimeout(r, 30)); // let the overlay paint first
        ({ blob, mime } = exportGif());
      } else {
        ({ blob, mime } = await exportStill());
      }
      setPreview({ url: URL.createObjectURL(blob), blob, mime });
    } catch (e: any) {
      setErr(e?.message || "Couldn't render that. Try a smaller image.");
    } finally {
      setBusy("");
    }
  };
  const closePreview = () => {
    setPreview((p) => {
      if (p) {
        try {
          URL.revokeObjectURL(p.url);
        } catch {
          /* noop */
        }
      }
      return null;
    });
  };

  // Upload the already-rendered preview blob and finish (send=true → send it now;
  // false → save to tray only).
  const commitPreview = async (send: boolean) => {
    const token = getToken();
    if (!token || !preview) return;
    setBusy("Saving…");
    setErr("");
    try {
      const kind = mode === "gif" ? "gif" : "sticker";
      const ext = preview.mime === "image/gif" ? "gif" : preview.mime === "image/png" ? "png" : "webp";
      const name = `${kind}-${Date.now()}.${ext}`;
      const data: any = await api.uploadSticker(token, preview.blob, preview.mime, name, kind, OUT, OUT);
      const media: PickedMedia = { url: abs(data.url), type: preview.mime, name, width: OUT, height: OUT, kind };
      try {
        URL.revokeObjectURL(preview.url);
      } catch {
        /* noop */
      }
      onClose(send ? media : null);
    } catch (e: any) {
      setErr(e?.message || "Couldn't save that. Try a smaller image.");
      setBusy("");
    }
  };

  // ---- UI -------------------------------------------------------------------
  const sel = overlays.find((o) => o.id === selId) || null;
  const emojiList = (() => {
    const q = emojiQ.trim().toLowerCase();
    const all = EMOJI_CATEGORIES.flatMap((c) => c.emojis);
    if (!q) return all.slice(0, 64);
    return all.filter((e) => e.char === q || e.keywords.includes(q)).slice(0, 64);
  })();

  const iconBtn = (active: boolean): React.CSSProperties => ({
    width: 40,
    height: 40,
    borderRadius: 10,
    border: active ? "1.5px solid var(--ac)" : "1px solid var(--g200,#e3e7ee)",
    background: active ? "color-mix(in srgb, var(--ac) 12%, transparent)" : "var(--sb,#fff)",
    color: "var(--g900,#111)",
    cursor: "pointer",
    fontSize: 17,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  });

  return (
    <div
      role="dialog"
      aria-label="Create a sticker or GIF"
      style={{ position: "fixed", inset: 0, zIndex: "var(--z-studio, 4700)" as any, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(6,8,15,.62)", backdropFilter: "blur(3px)" }}
      onPointerDown={cancel}
    >
      <div
        onPointerDown={(e) => e.stopPropagation()}
        // Also stop mousedown: the studio is portaled to <body>, a sibling of the
        // GIF picker, whose document-level outside-click listener would otherwise
        // treat a click inside the studio as "outside" and close the picker
        // beneath it — breaking the return-to-picker-on-save/cancel flow.
        onMouseDown={(e) => e.stopPropagation()}
        style={{ width: "min(420px, 94vw)", maxHeight: "94vh", overflow: "hidden", display: "flex", flexDirection: "column", background: "var(--bg,#fff)", color: "var(--g900,#111)", border: "1px solid var(--g200,#e3e7ee)", borderRadius: 18, boxShadow: "0 24px 70px rgba(0,0,0,.45)" }}
      >
        {/* header */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 14px", borderBottom: "1px solid var(--g150,var(--g200))" }}>
          <div style={{ display: "inline-flex", background: "var(--g100,#f1f3f8)", borderRadius: 9, padding: 2 }}>
            {(["sticker", "gif"] as Mode[]).map((m) => (
              <button
                key={m}
                onClick={() => step === "source" && setMode(m)}
                disabled={step !== "source"}
                title={step !== "source" ? "Start over to switch" : ""}
                style={{ border: 0, background: mode === m ? "var(--sb,#fff)" : "transparent", color: mode === m ? "var(--g900,#111)" : "var(--g600,#667)", fontWeight: 700, fontSize: 12.5, padding: "6px 14px", borderRadius: 7, cursor: step === "source" ? "pointer" : "default", boxShadow: mode === m ? "0 1px 2px rgba(0,0,0,.08)" : "none" }}
              >
                {m === "sticker" ? "Sticker" : "GIF"}
              </button>
            ))}
          </div>
          <div style={{ fontSize: 13, fontWeight: 700, marginLeft: 4 }}>Studio</div>
          <button onClick={cancel} aria-label="Close" style={{ marginLeft: "auto", width: 28, height: 28, borderRadius: 8, border: "1px solid var(--g200,#e3e7ee)", background: "var(--sb,#fff)", color: "var(--g600,#667)", cursor: "pointer", fontSize: 15 }}>×</button>
        </div>

        {err ? <div style={{ fontSize: 12, color: "var(--red,#c0392b)", padding: "8px 14px 0" }}>{err}</div> : null}

        {step === "source" ? (
          <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
            {cam ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 12, alignItems: "center" }}>
                <video ref={videoRef} playsInline muted style={{ width: STAGE, height: STAGE, objectFit: "cover", borderRadius: 14, background: "#000", transform: "scaleX(-1)" }} />
                <div style={{ display: "flex", gap: 10 }}>
                  {mode === "sticker" ? (
                    <button onClick={snapPhoto} style={primaryBtn}>Capture</button>
                  ) : (
                    <button onClick={recordClip} disabled={recording} style={primaryBtn}>{recording ? "Recording…" : `Record ${GIF_MAX_MS / 1000}s`}</button>
                  )}
                  <button onClick={() => { stopCamera(); setCam(false); }} style={ghostBtn}>Cancel</button>
                </div>
              </div>
            ) : (
              <>
                <div style={{ fontSize: 12.5, color: "var(--g600,#667)", textAlign: "center", lineHeight: 1.6 }}>
                  {mode === "sticker" ? "Make a sticker from a photo, the camera, or a blank canvas — add text, emoji, drawing, and remove the background." : "Record a short clip from your camera and add text/emoji to make an animated GIF."}
                </div>
                <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (e.target) e.target.value = ""; if (f) ingestImageFile(f); }} />
                <div style={{ display: "grid", gridTemplateColumns: mode === "sticker" ? "1fr 1fr" : "1fr", gap: 10 }}>
                  {mode === "sticker" ? (
                    <button onClick={() => fileRef.current?.click()} style={sourceBtn}>🖼️<span>Upload photo</span></button>
                  ) : null}
                  <button onClick={openCamera} style={sourceBtn}>📷<span>{mode === "sticker" ? "Camera" : "Record GIF"}</span></button>
                  {mode === "sticker" ? <button onClick={startBlank} style={{ ...sourceBtn, gridColumn: "1 / -1" }}>✨<span>Blank canvas (text & emoji)</span></button> : null}
                </div>
              </>
            )}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: 14, overflowY: "auto" }}>
            {/* stage */}
            <div style={{ position: "relative", width: STAGE, height: STAGE, alignSelf: "center", borderRadius: 14, overflow: "hidden", background: transparentBase ? "repeating-conic-gradient(#e9edf4 0% 25%, #f7f9fc 0% 50%) 50% / 20px 20px" : "#0b0f14", touchAction: "none" }}>
              <canvas ref={baseCanvasRef} width={STAGE} height={STAGE} style={{ position: "absolute", inset: 0, width: STAGE, height: STAGE }} />
              <canvas ref={drawCanvasRef} width={OUT} height={OUT} style={{ position: "absolute", inset: 0, width: STAGE, height: STAGE, pointerEvents: "none" }} />
              <div
                ref={stageRef}
                onPointerDown={onStagePointerDown}
                onPointerMove={(e) => { onStagePointerMove(e); onOverlayPointerMove(e); }}
                onPointerUp={() => { onStagePointerUp(); onOverlayPointerUp(); }}
                style={{ position: "absolute", inset: 0 }}
              >
                {overlays.map((ov) => (
                  <div
                    key={ov.id}
                    onPointerDown={(e) => onOverlayPointerDown(e, ov.id)}
                    onDoubleClick={() => ov.kind === "text" && setTextEntry({ id: ov.id, value: ov.content })}
                    style={{
                      position: "absolute",
                      left: ov.x,
                      top: ov.y,
                      transform: `translate(-50%,-50%) rotate(${ov.rot}deg) scale(${ov.scale})`,
                      cursor: "move",
                      userSelect: "none",
                      touchAction: "none",
                      padding: 4,
                      outline: selId === ov.id ? "1.5px dashed var(--ac)" : "none",
                      borderRadius: 6,
                      fontSize: ov.kind === "emoji" ? 64 : 34,
                      fontWeight: 800,
                      lineHeight: 1,
                      color: ov.kind === "text" ? ov.color : undefined,
                      textShadow: ov.kind === "text" ? "0 2px 6px rgba(0,0,0,.5)" : undefined,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {ov.content}
                  </div>
                ))}
              </div>
              {busy ? <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,.45)", color: "#fff", fontSize: 13, fontWeight: 600 }}>{busy}</div> : null}
            </div>

            {/* selected-overlay controls */}
            {sel ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", background: "var(--g50,#f8fafc)", border: "1px solid var(--g150,var(--g200))", borderRadius: 10 }}>
                <span style={{ fontSize: 11.5, color: "var(--g600,#667)" }}>Size</span>
                <input type="range" min={0.4} max={3} step={0.01} value={sel.scale} onChange={(e) => updateSel({ scale: parseFloat(e.target.value) })} style={{ flex: 1 }} />
                <span style={{ fontSize: 11.5, color: "var(--g600,#667)" }}>Turn</span>
                <input type="range" min={-180} max={180} step={1} value={sel.rot} onChange={(e) => updateSel({ rot: parseFloat(e.target.value) })} style={{ flex: 1 }} />
                {sel.kind === "text" ? (
                  <input type="color" value={sel.color} onChange={(e) => updateSel({ color: e.target.value })} title="Text colour" style={{ width: 26, height: 26, padding: 0, border: 0, background: "none" }} />
                ) : null}
                <button onClick={removeSel} title="Delete" style={{ border: 0, background: "none", cursor: "pointer", fontSize: 15 }}>🗑️</button>
              </div>
            ) : null}

            {/* tools */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <button style={iconBtn(tool === "move")} title="Move / pan" onClick={() => setTool("move")}>✋</button>
              <button style={iconBtn(tool === "draw")} title="Draw" onClick={() => setTool("draw")}>✏️</button>
              <button style={iconBtn(false)} title="Add text" onClick={() => setTextEntry({ id: null, value: "" })}>🅰️</button>
              <button style={iconBtn(emojiOpen)} title="Add emoji" onClick={() => setEmojiOpen((v) => !v)}>😀</button>
              <button style={iconBtn(false)} title="Remove background" onClick={doCutout}>🪄</button>
              {mode === "sticker" && framesRef.current[0] && (framesRef.current[0].canvas as any)._src ? (
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: 4 }}>
                  <span style={{ fontSize: 11.5, color: "var(--g600,#667)" }}>Zoom</span>
                  <input type="range" min={1} max={3} step={0.01} value={zoom} onChange={(e) => { setZoom(parseFloat(e.target.value)); }} style={{ width: 80 }} />
                </div>
              ) : null}
            </div>

            {/* draw options */}
            {tool === "draw" ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                {PALETTE.map((c) => (
                  <button key={c} onClick={() => setDrawColor(c)} aria-label={c} style={{ width: 22, height: 22, borderRadius: "50%", background: c, border: drawColor === c ? "2px solid var(--ac)" : "1px solid var(--g300,#c8d0dd)", cursor: "pointer" }} />
                ))}
                <input type="range" min={2} max={22} step={1} value={drawSize} onChange={(e) => setDrawSize(parseInt(e.target.value))} style={{ width: 90 }} />
                <button onClick={clearDraw} style={{ ...ghostBtn, padding: "4px 10px", fontSize: 12 }}>Clear</button>
              </div>
            ) : null}

            {/* emoji strip */}
            {emojiOpen ? (
              <div style={{ border: "1px solid var(--g150,var(--g200))", borderRadius: 10, padding: 8 }}>
                <input value={emojiQ} onChange={(e) => setEmojiQ(e.target.value)} placeholder="Search emoji…" style={{ width: "100%", font: "inherit", fontSize: 12.5, padding: "6px 9px", borderRadius: 8, border: "1px solid var(--g200,#e3e7ee)", background: "var(--sb,#fff)", color: "var(--g900,#111)", marginBottom: 6 }} />
                <div style={{ display: "grid", gridTemplateColumns: "repeat(8, 1fr)", gap: 2, maxHeight: 130, overflowY: "auto" }}>
                  {emojiList.map((e, i) => (
                    <button key={i} onClick={() => addEmoji(e.char)} style={{ border: 0, background: "none", cursor: "pointer", fontSize: 20, padding: 3, borderRadius: 6, lineHeight: 1 }}>{e.char}</button>
                  ))}
                </div>
              </div>
            ) : null}

            {/* text entry */}
            {textEntry ? (
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  autoFocus
                  value={textEntry.value}
                  onChange={(e) => setTextEntry({ ...textEntry, value: e.target.value })}
                  onKeyDown={(e) => { if (e.key === "Enter") commitText(); if (e.key === "Escape") setTextEntry(null); }}
                  placeholder="Type text…"
                  maxLength={40}
                  style={{ flex: 1, font: "inherit", fontSize: 13, padding: "8px 11px", borderRadius: 9, border: "1px solid var(--g200,#e3e7ee)", background: "var(--sb,#fff)", color: "var(--g900,#111)" }}
                />
                <button onClick={commitText} style={{ ...primaryBtn, padding: "8px 14px" }}>Done</button>
              </div>
            ) : null}

            {/* actions */}
            <div style={{ display: "flex", gap: 10, marginTop: 2 }}>
              <button onClick={() => { stopCamera(); setStep("source"); framesRef.current = []; setHasBase(false); setOverlays([]); strokesRef.current = []; setSelId(null); }} style={ghostBtn}>Start over</button>
              <button onClick={() => buildPreview()} disabled={!!busy} style={{ ...primaryBtn, marginLeft: "auto" }}>{mode === "gif" ? "Preview GIF →" : "Preview →"}</button>
            </div>
          </div>
        )}
      </div>

      {/* Preview-before-send: the rendered sticker/GIF (a real GIF blob animates
          here, so what you see is exactly what sends). Confirm to upload. */}
      {preview ? (
        <div
          style={{ position: "fixed", inset: 0, zIndex: 5, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(6,8,15,.72)" }}
          onPointerDown={(e) => { e.stopPropagation(); closePreview(); }}
        >
          <div
            onPointerDown={(e) => e.stopPropagation()}
            style={{ width: "min(360px, 92vw)", background: "var(--bg,#fff)", color: "var(--g900,#111)", border: "1px solid var(--g200,#e3e7ee)", borderRadius: 16, boxShadow: "0 24px 70px rgba(0,0,0,.5)", padding: 16, display: "flex", flexDirection: "column", gap: 14 }}
          >
            <div style={{ fontSize: 13, fontWeight: 700 }}>Preview{mode === "gif" ? " · plays as it will send" : ""}</div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: 12, borderRadius: 12, background: "repeating-conic-gradient(#e9edf4 0% 25%, #f7f9fc 0% 50%) 50% / 20px 20px" }}>
              <img src={preview.url} alt="Preview" style={{ maxWidth: "100%", maxHeight: 260, display: "block" }} />
            </div>
            {err ? <div style={{ fontSize: 12, color: "var(--red,#c0392b)" }}>{err}</div> : null}
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <button onClick={closePreview} disabled={!!busy} style={ghostBtn}>← Edit</button>
              <button onClick={() => commitPreview(false)} disabled={!!busy} style={{ ...ghostBtn, marginLeft: "auto" }}>Save to tray</button>
              <button onClick={() => commitPreview(true)} disabled={!!busy} style={primaryBtn}>{busy ? "…" : "Send"}</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const primaryBtn: React.CSSProperties = { border: 0, background: "var(--ac)", color: "#fff", fontWeight: 700, fontSize: 13, padding: "9px 18px", borderRadius: 10, cursor: "pointer" };
const ghostBtn: React.CSSProperties = { border: "1px solid var(--g200,#e3e7ee)", background: "var(--sb,#fff)", color: "var(--g800,#222)", fontWeight: 600, fontSize: 13, padding: "9px 14px", borderRadius: 10, cursor: "pointer" };
const sourceBtn: React.CSSProperties = { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6, padding: "18px 10px", border: "1.5px dashed var(--g300,#c8d0dd)", borderRadius: 14, background: "var(--g50,#f8fafc)", color: "var(--g800,#222)", cursor: "pointer", fontSize: 12.5, fontWeight: 600 };
