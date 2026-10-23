"use client";
import React, { useState, useEffect } from "react";
import { api } from "../../lib/api";
import { saveBlobAs } from "../../lib/saveBlob";
import { IconDownload, IconPlay, IconFile } from "../../lib/icons";

export default function ChatAttachment({
  file,
  token,
  onToast,
}: {
  file: any;
  token: string;
  onToast?: (m: string) => void;
}) {
  const mime = file.mime || file.type || "";
  const isVideo =
    /^video\//.test(mime) || /\.(webm|mp4|mov|m4v|ogg)$/i.test(file.name || "");
  const isImage =
    /^image\//.test(mime) ||
    /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(file.name || "");
  const isAudio =
    /^audio\//.test(mime) || /\.(mp3|wav|m4a|aac|oga|opus)$/i.test(file.name || "");
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => () => { if (src) URL.revokeObjectURL(src); }, [src]);

  const load = async () => {
    if (src || loading) return;
    setLoading(true);
    try {
      const blob = await api.downloadFile(token, file.id);
      setSrc(URL.createObjectURL(blob));
    } catch {
      onToast && onToast("Couldn't load the file");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isImage) void load();
  }, [isImage, file.id]);

  const download = async () => {
    try {
      const blob = await api.downloadFile(token, file.id);
      await saveBlobAs(blob, file.name || "file");
    } catch {
      onToast && onToast("Couldn't download the file");
    }
  };

  if (isImage) {
    return (
      <div className="ms-chat-media">
        {src ? (
          <img
            className="ms-chat-img"
            src={src}
            alt={file.name || "image"}
            title="Download"
            onClick={download}
            style={{ maxWidth: "100%", borderRadius: 8, cursor: "zoom-in", display: "block" }}
          />
        ) : (
          <button type="button" className="ms-chat-video-play" onClick={load} disabled={loading}>
            <span>{loading ? "Loading…" : "Preview"}</span>
          </button>
        )}
        <button type="button" className="ms-chat-media-dl" onClick={download} title="Download">
          <IconDownload size={13} />
          <span>Download</span>
        </button>
      </div>
    );
  }

  if (isVideo || isAudio) {
    return (
      <div className="ms-chat-media">
        {src ? (
          isAudio ? (
            <audio src={src} controls autoPlay preload="metadata" style={{ width: "100%" }} />
          ) : (
            <video className="ms-chat-video" src={src} controls autoPlay playsInline preload="metadata" />
          )
        ) : (
          <button type="button" className="ms-chat-video-play" onClick={load} disabled={loading}>
            <IconPlay size={14} />
            <span>{loading ? "Loading…" : "Play"}</span>
          </button>
        )}
        <button type="button" className="ms-chat-media-dl" onClick={download} title="Download">
          <IconDownload size={13} />
          <span>Download</span>
        </button>
      </div>
    );
  }

  return (
    <button type="button" className="ms-chat-file-v2" onClick={download} title="Download">
      <IconFile size={13} />
      <span>{file.name}</span>
      <IconDownload size={12} />
    </button>
  );
}
