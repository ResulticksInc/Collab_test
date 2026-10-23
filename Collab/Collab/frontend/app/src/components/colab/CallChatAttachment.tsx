import React, { useState, useEffect } from "react";
import { IconDownload, IconPlay, IconFile } from "../../lib/icons";
import { saveBlobAs } from "../../lib/saveBlob";
import { api } from "../../lib/api";

// In-call / meeting chat attachment renderer — inline image/video/audio preview
// with a download fallback. Extracted verbatim from CoLabV1.tsx (decomposition
// step 3): a module-level, prop-driven component with no dependency on CoLabV1's
// state, so the move is behaviour-preserving. Call-chat files are always plain
// non-E2EE uploads/recordings, so fetching a preview blob is safe.
export default function CallChatAttachment({
  file,
  token,
  onToast,
}: {
  file: any;
  token: string;
  onToast?: (m: string) => void;
}) {
  const mime = String((file && (file.mime || file.type)) || "");
  const name = String((file && file.name) || "");
  const isVideo =
    /^video\//.test(mime) || (!mime && /\.(mp4|mov|m4v)$/i.test(name));
  const isAudio =
    !isVideo &&
    (/^audio\//.test(mime) || /\.(mp3|m4a|wav|opus)$/i.test(name));
  const isImage =
    !isVideo &&
    !isAudio &&
    (/^image\//.test(mime) || /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(name));
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(
    () => () => {
      if (src) URL.revokeObjectURL(src);
    },
    [src],
  );
  const load = async () => {
    if (src || loading) return;
    setLoading(true);
    try {
      const blob = await api.downloadFile(token, file.id);
      setSrc(URL.createObjectURL(blob));
    } catch {
      onToast && onToast("Couldn't load the recording");
    } finally {
      setLoading(false);
    }
  };
  // Auto-fetch image thumbnails so they preview inline (main-chat parity). Call
  // chat files are always plain non-E2EE uploads/recordings, so this is safe.
  useEffect(() => {
    if (isImage) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isImage, file && file.id]);
  const download = async () => {
    try {
      const blob = await api.downloadFile(token, file.id);
      await saveBlobAs(blob, name || "file");
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
            alt={name || "image"}
            title="Download"
            onClick={download}
            style={{ maxWidth: "100%", borderRadius: 8, cursor: "zoom-in", display: "block" }}
          />
        ) : (
          <button type="button" className="ms-chat-video-play" onClick={load} disabled={loading}>
            <span>{loading ? "Loading…" : "Preview"}</span>
          </button>
        )}
        <button type="button" className="ms-chat-media-dl" onClick={download} aria-label="Download">
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
          isVideo ? (
            <video
              className="ms-chat-video"
              src={src}
              controls
              autoPlay
              playsInline
              preload="metadata"
            />
          ) : (
            <audio
              src={src}
              controls
              autoPlay
              preload="metadata"
              style={{ width: 220, maxWidth: "100%" }}
            />
          )
        ) : (
          <button
            type="button"
            className="ms-chat-video-play"
            onClick={load}
            disabled={loading}
          >
            <IconPlay size={14} />
            <span>{loading ? "Loading…" : "Play"}</span>
          </button>
        )}
        <button
          type="button"
          className="ms-chat-media-dl"
          onClick={download}
          aria-label="Download"
        >
          <IconDownload size={13} />
          <span>Download</span>
        </button>
      </div>
    );
  }
  return (
    <button type="button" className="ms-chat-file-v2" onClick={download} title="Download">
      <IconFile size={13} />
      <span>{name || "Attachment"}</span>
      <IconDownload size={12} />
    </button>
  );
}
