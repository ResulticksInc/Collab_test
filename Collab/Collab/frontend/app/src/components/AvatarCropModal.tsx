import React, { useCallback, useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom";

/**
 * Dependency-free avatar cropper. Shows a square viewport with a circular mask;
 * the user drags to reposition and uses the slider / wheel to zoom. On Save it
 * renders the cropped square region to a 256×256 canvas and returns a JPEG File,
 * so it drops into the existing avatar-upload handlers (which downscale a File)
 * with no other changes. Used by Settings (profile pic) and the group/channel
 * Manage modal.
 */
const VIEW = 280; // on-screen viewport (px)
const OUT = 256; // exported avatar size (px)

export default function AvatarCropModal({
  file,
  onCancel,
  onConfirm,
}: {
  file: File;
  onCancel: () => void;
  onConfirm: (cropped: File) => void;
}) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [minZoom, setMinZoom] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const urlRef = useRef<string>("");
  const dragRef = useRef<{ x: number; y: number; px: number; py: number } | null>(null);

  // Keep the image fully covering the viewport at all times.
  const clamp = useCallback((p: { x: number; y: number }, z: number, im: HTMLImageElement) => {
    const w = im.width * z;
    const h = im.height * z;
    return {
      x: Math.min(0, Math.max(VIEW - w, p.x)),
      y: Math.min(0, Math.max(VIEW - h, p.y)),
    };
  }, []);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    urlRef.current = url;
    const im = new Image();
    im.onload = () => {
      const cover = Math.max(VIEW / im.width, VIEW / im.height);
      setMinZoom(cover);
      setZoom(cover);
      setPos({ x: (VIEW - im.width * cover) / 2, y: (VIEW - im.height * cover) / 2 });
      setImg(im);
    };
    im.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // ESC to cancel. Capture phase + stopPropagation so the cropper (the topmost
  // overlay) claims Escape BEFORE the parent ManageGroup/Settings modal or the
  // global Back handler can also fire on the same keypress.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onCancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  const applyZoom = (z: number) => {
    if (!img) return;
    const c = VIEW / 2;
    const ratio = z / zoom;
    const nx = c - (c - pos.x) * ratio;
    const ny = c - (c - pos.y) * ratio;
    setZoom(z);
    setPos(clamp({ x: nx, y: ny }, z, img));
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, px: pos.x, py: pos.y };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current || !img) return;
    const nx = dragRef.current.px + (e.clientX - dragRef.current.x);
    const ny = dragRef.current.py + (e.clientY - dragRef.current.y);
    setPos(clamp({ x: nx, y: ny }, zoom, img));
  };
  const onPointerUp = () => { dragRef.current = null; };

  const onWheel = (e: React.WheelEvent) => {
    if (!img) return;
    const next = Math.min(minZoom * 5, Math.max(minZoom, zoom * (e.deltaY < 0 ? 1.08 : 0.92)));
    applyZoom(next);
  };

  const confirm = () => {
    if (!img) return;
    const canvas = document.createElement("canvas");
    canvas.width = OUT;
    canvas.height = OUT;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const s = OUT / VIEW; // viewport → output scale
    ctx.imageSmoothingEnabled = true;
    (ctx as any).imageSmoothingQuality = "high";
    ctx.drawImage(img, pos.x * s, pos.y * s, img.width * zoom * s, img.height * zoom * s);
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        onConfirm(new File([blob], "avatar.jpg", { type: "image/jpeg" }));
      },
      "image/jpeg",
      0.9,
    );
  };

  const modalContent = (
    <div className="acm-overlay" onClick={onCancel}>
      <div className="acm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="acm-title">Adjust photo</div>
        <div
          className="acm-stage"
          style={{ width: VIEW, height: VIEW }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onWheel={onWheel}
        >
          {img ? (
            <img
              src={urlRef.current}
              alt=""
              draggable={false}
              style={{
                position: "absolute",
                left: pos.x,
                top: pos.y,
                width: img.width * zoom,
                height: img.height * zoom,
                maxWidth: "none",
                maxHeight: "none",
                userSelect: "none",
                pointerEvents: "none",
              }}
            />
          ) : (
            <div className="acm-loading">Loading…</div>
          )}
          <div className="acm-mask" />
        </div>
        <input
          type="range"
          className="acm-zoom"
          min={minZoom}
          max={minZoom * 5}
          step={0.0001}
          value={zoom}
          onChange={(e) => applyZoom(parseFloat(e.target.value))}
          aria-label="Zoom"
        />
        <div className="acm-actions">
          <button type="button" className="acm-btn" onClick={onCancel}>Cancel</button>
          <button type="button" className="acm-btn primary" onClick={confirm} disabled={!img}>Save</button>
        </div>
      </div>
    </div>
  );

  if (typeof document !== "undefined") {
    return ReactDOM.createPortal(modalContent, document.body);
  }
  return modalContent;
}
