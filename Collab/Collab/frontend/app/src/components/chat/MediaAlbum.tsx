"use client";
import React, { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import {
  IconAlertTriangle,
  IconPlay,
  IconMinus,
  IconPlus,
  IconX,
  IconChevronLeft,
  IconChevronRight,
  IconDownload,
} from "../../lib/icons";
import { mimeOf, dragOutProps } from "../../lib/desktopFiles";
import { useEscapeKey, fmtTime, renderBody } from "../ChatView";
import { useFileBlob } from "./FileAttachment";
import Avatar from "../Avatar";
import { saveBlobAs } from "../../lib/saveBlob";
import { api } from "../../lib/api";
import { downloadAttachment } from "../../lib/downloadAttachment";

export function AlbumTile({ file, token, className, onOpen, badge }: any) {
  const isVideo = mimeOf(file).startsWith("video/");
  const { url, failed } = useFileBlob(isVideo ? null : file, token);
  return (
    <button
      type="button"
      className={"album-tile " + (className || "")}
      onClick={onOpen}
      title={file.name}
      {...dragOutProps(file, token)}
    >
      {isVideo ? (
        <div className="album-tile-ph album-tile-video" />
      ) : url ? (
        <img
          src={url}
          alt={file.name}
          draggable={false}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : (
        <div className="album-tile-ph">{failed ? <IconAlertTriangle size={18} /> : "…"}</div>
      )}
      {isVideo ? <span className="album-play"><IconPlay size={20} /></span> : null}
      {badge ? <span className="album-more">+{badge}</span> : null}
    </button>
  );
}

export function useImageZoom(resetKey?: any) {
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(
    null,
  );
  const clamp = (s: number) => Math.min(5, Math.max(1, +s.toFixed(2)));
  const reset = useCallback(() => {
    setScale(1);
    setTx(0);
    setTy(0);
  }, []);
  useEffect(() => {
    reset();
  }, [resetKey, reset]);
  const zoomIn = useCallback(() => setScale((s) => clamp(s + 0.5)), []);
  const zoomOut = useCallback(
    () =>
      setScale((s) => {
        const n = clamp(s - 0.5);
        if (n === 1) {
          setTx(0);
          setTy(0);
        }
        return n;
      }),
    [],
  );
  const onWheel = useCallback((e: React.WheelEvent) => {
    setScale((s) => {
      const n = clamp(s + (e.deltaY < 0 ? 0.3 : -0.3));
      if (n === 1) {
        setTx(0);
        setTy(0);
      }
      return n;
    });
  }, []);
  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (scale <= 1) return;
      e.stopPropagation();
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      drag.current = { x: e.clientX, y: e.clientY, tx, ty };
    },
    [scale, tx, ty],
  );
  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!drag.current) return;
    setTx(drag.current.tx + (e.clientX - drag.current.x));
    setTy(drag.current.ty + (e.clientY - drag.current.y));
  }, []);
  const onPointerUp = useCallback(() => {
    drag.current = null;
  }, []);
  const imgStyle: React.CSSProperties = {
    transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
    transformOrigin: "center center",
    transition: drag.current ? "none" : "transform .13s ease",
    cursor: scale > 1 ? (drag.current ? "grabbing" : "grab") : "zoom-in",
    touchAction: "none",
  };
  return {
    scale,
    pct: Math.round(scale * 100),
    canZoomIn: scale < 5,
    canZoomOut: scale > 1,
    zoomIn,
    zoomOut,
    reset,
    imgStyle,
    handlers: {
      onWheel,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerLeave: onPointerUp,
      onDoubleClick: (e: React.MouseEvent) => {
        e.stopPropagation();
        setScale((s) => (s > 1 ? 1 : 2));
        if (scale > 1) {
          setTx(0);
          setTy(0);
        }
      },
    },
  };
}

export function LightboxControls({
  zoom,
  onClose,
  onDownload,
}: {
  zoom?: ReturnType<typeof useImageZoom>;
  onClose: () => void;
  onDownload?: () => void;
}) {
  const SURFACE = "rgba(28,28,32,0.72)";
  const BORDER = "1px solid rgba(255,255,255,0.16)";
  const zoomBtn = (
    onClick: () => void,
    label: string,
    node: React.ReactNode,
    disabled: boolean,
  ) => (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) onClick();
      }}
      onMouseEnter={(e) => {
        if (!disabled)
          (e.currentTarget as HTMLButtonElement).style.background =
            "rgba(255,255,255,0.15)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = "transparent";
      }}
      aria-label={label}
      title={label}
      disabled={disabled}
      style={{
        width: 42,
        height: 40,
        border: 0,
        background: "transparent",
        color: "#fff",
        opacity: disabled ? 0.4 : 1,
        cursor: disabled ? "default" : "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        transition: "background .12s ease",
      }}
    >
      {node}
    </button>
  );
  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        position: "absolute",
        top: 16,
        right: 16,
        display: "flex",
        alignItems: "center",
        gap: 10,
        zIndex: 3,
      }}
    >
      {zoom ? (
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            height: 40,
            background: SURFACE,
            border: BORDER,
            borderRadius: 999,
            backdropFilter: "blur(10px)",
            WebkitBackdropFilter: "blur(10px)",
            overflow: "hidden",
            boxShadow: "0 4px 16px rgba(0,0,0,0.28)",
          }}
        >
          {zoomBtn(zoom.zoomOut, "Zoom out", <IconMinus size={18} />, !zoom.canZoomOut)}
          <span
            style={{
              minWidth: 50,
              textAlign: "center",
              color: "#fff",
              fontWeight: 600,
              fontSize: 13,
              lineHeight: "40px",
              fontVariantNumeric: "tabular-nums",
              userSelect: "none",
              borderLeft: "1px solid rgba(255,255,255,0.12)",
              borderRight: "1px solid rgba(255,255,255,0.12)",
            }}
          >
            {zoom.pct}%
          </span>
          {zoomBtn(zoom.zoomIn, "Zoom in", <IconPlus size={18} />, !zoom.canZoomIn)}
        </div>
      ) : null}
      {onDownload ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDownload();
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background =
              "rgba(255,255,255,0.15)";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = SURFACE;
          }}
          aria-label="Download"
          title="Download"
          style={{
            width: 40,
            height: 40,
            borderRadius: "50%",
            border: BORDER,
            background: SURFACE,
            color: "#fff",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            backdropFilter: "blur(10px)",
            WebkitBackdropFilter: "blur(10px)",
            boxShadow: "0 4px 16px rgba(0,0,0,0.28)",
            transition: "background .12s ease",
          }}
        >
          <IconDownload size={18} />
        </button>
      ) : null}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.background =
            "rgba(255,255,255,0.15)";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.background = SURFACE;
        }}
        aria-label="Close"
        title="Close (Esc)"
        style={{
          width: 40,
          height: 40,
          borderRadius: "50%",
          border: BORDER,
          background: SURFACE,
          color: "#fff",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backdropFilter: "blur(10px)",
          WebkitBackdropFilter: "blur(10px)",
          boxShadow: "0 4px 16px rgba(0,0,0,0.28)",
          transition: "background .12s ease",
        }}
      >
        <IconX size={20} />
      </button>
    </div>
  );
}

export function AlbumLightbox({ run, token, index, onIndex, onClose }: any) {
  const file = run[index]?.file;
  const { url } = useFileBlob(file, token);
  const isVideo = file && mimeOf(file).startsWith("video/");
  const zoom = useImageZoom(index);
  useEscapeKey(onClose);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight")
        onIndex((i: number) => Math.min(run.length - 1, i + 1));
      if (e.key === "ArrowLeft") onIndex((i: number) => Math.max(0, i - 1));
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [run.length, onIndex]);

  useEffect(() => {
    try {
      window.dispatchEvent(new Event("colab:close-msg-toolbar"));
    } catch (_) {}
  }, []);

  // Shared download path (desktop native save / oversized ticket / fetch +
  // decrypt + Save-As); failures are toasted there instead of logged silently.
  const handleDownload = useCallback(async () => {
    if (!file) return;
    try {
      await downloadAttachment(file, token, { url });
    } catch {
      /* already reported to the user */
    }
  }, [file, token, url]);

  return createPortal(
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,.9)",
        zIndex: 9600,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <LightboxControls
        zoom={isVideo ? undefined : zoom}
        onClose={onClose}
        onDownload={handleDownload}
      />
      {index > 0 ? (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onIndex((i: number) => i - 1);
          }}
          style={{
            position: "absolute",
            left: 16,
            color: "#fff",
            background: "none",
            border: 0,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
          }}
        >
          <IconChevronLeft size={30} />
        </button>
      ) : null}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: "90vw", maxHeight: "90vh" }}
      >
        {url ? (
          isVideo ? (
            <video
              src={url}
              controls
              controlsList="nodownload"
              autoPlay
              playsInline
              style={{ maxWidth: "90vw", maxHeight: "90vh" }}
            />
          ) : (
            <img
              src={url}
              alt={file?.name}
              {...zoom.handlers}
              style={{
                maxWidth: "90vw",
                maxHeight: "90vh",
                objectFit: "contain",
                ...zoom.imgStyle,
              }}
            />
          )
        ) : (
          <div style={{ color: "#fff" }}>Loading…</div>
        )}
      </div>
      {index < run.length - 1 ? (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onIndex((i: number) => i + 1);
          }}
          style={{
            position: "absolute",
            right: 16,
            color: "#fff",
            background: "none",
            border: 0,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
          }}
        >
          <IconChevronRight size={30} />
        </button>
      ) : null}
    </div>,
    document.body,
  );
}

export function UrlLightbox({ url, onClose }: { url: string; onClose: () => void }) {
  useEscapeKey(onClose);
  const zoom = useImageZoom(url);
  useEffect(() => {
    try {
      window.dispatchEvent(new Event("colab:close-msg-toolbar"));
    } catch (_) {}
  }, []);

  const handleDownload = useCallback(async () => {
    if (!url) return;
    try {
      const b = await (await fetch(url)).blob();
      const filename = url.split("/").pop()?.split("?")[0] || "image.png";
      await saveBlobAs(b, filename);
    } catch {
      const a = document.createElement("a");
      a.href = url;
      a.download = url.split("/").pop()?.split("?")[0] || "image.png";
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  }, [url]);

  return createPortal(
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,.9)",
        zIndex: 9600,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <LightboxControls zoom={zoom} onClose={onClose} onDownload={handleDownload} />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt=""
        onClick={(e) => e.stopPropagation()}
        {...zoom.handlers}
        style={{
          maxWidth: "90vw",
          maxHeight: "90vh",
          objectFit: "contain",
          ...zoom.imgStyle,
        }}
      />
    </div>,
    document.body,
  );
}

export default function MediaAlbum({ run, token, first, leadId, timeFormat, meId }: any) {
  const [open, setOpen] = useState<number | null>(null);
  const lead = run[0];
  const sender = lead.sender || {};
  const me = !!lead.me;
  const n = run.length,
    MAX = 4;
  const tiles = run.slice(0, MAX);
  const extra = n - MAX;
  const layout = n === 2 ? "g2" : n === 3 ? "g3" : "g4";
  return (
    <div
      id={"msg-" + leadId}
      className={"mw " + (first ? "gstart" : "gcont") + (me ? " me" : "")}
      style={{ position: "relative" }}
    >
      <div className="mav">
        {first ? (
          <Avatar
            avatar={{
              kind: "user",
              initials: sender.initials,
              color: sender.color,
              avatarUrl: sender.avatarUrl,
            }}
            size={28}
          />
        ) : null}
      </div>
      <div className="mb">
        {first && sender && sender.name && !me ? (
          <div className="mm">
            <span className="msnd">{sender.name}</span>
          </div>
        ) : null}
        <div className={"album-grid " + layout}>
          {tiles.map((m: any, idx: number) => (
            <AlbumTile
              key={m.id}
              file={m.file}
              token={token}
              className={layout === "g3" && idx === 0 ? "tall" : ""}
              badge={idx === MAX - 1 && extra > 0 ? extra : 0}
              onOpen={() =>
                setOpen(idx === MAX - 1 && extra > 0 ? MAX - 1 : idx)
              }
            />
          ))}
        </div>
        {lead.file && lead.file.caption ? (
          <div className="album-caption msg-body">
            {renderBody(lead.file.caption, meId)}
          </div>
        ) : null}
      </div>
      {open !== null ? (
        <AlbumLightbox
          run={run}
          token={token}
          index={open}
          onIndex={setOpen}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </div>
  );
}
