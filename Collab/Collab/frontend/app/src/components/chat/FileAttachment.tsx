"use client";
import React, { useState, useEffect, useCallback } from "react";
import { downloadAttachment, useDownloaded } from "../../lib/downloadAttachment";
import { humanBytes } from "../../lib/fileLimits";
import { mimeOf, dragOutProps } from "../../lib/desktopFiles";
import { bestMime, canDecryptFile, extAvatar, fileTypeIcon } from "../../lib/fileThumbs";
import { api } from "../../lib/api";
import { requestRestore } from "../../lib/e2ee/manager";
import { useRecoveryState } from "./E2EEBanners";
import { decryptBlob, decryptChunkedToBlob } from "../../lib/e2ee/media";
import { registerStreamVideo, dropStreamVideo } from "../../lib/e2eeVideoStream";
import {
  IconCloud,
  IconDownload,
  IconLock,
  IconImage,
  IconPlay,
  IconX,
  IconMusic,
  IconFileText,
} from "../../lib/icons";
import { AlbumLightbox } from "./MediaAlbum";

export function voiceMimeToExt(mime: string): string {
  const m = (mime || "").toLowerCase().split(";")[0].trim();
  if (m.includes("ogg") || m.includes("opus")) return "ogg";
  if (m.includes("webm")) return "webm";
  if (m.includes("wav")) return "wav";
  if (m.includes("mpeg") || m === "audio/mp3" || m.includes("mp3")) return "mp3";
  if (m.includes("aac")) return "aac";
  if (m.includes("flac")) return "flac";
  return "m4a";
}

const _blobCache = new Map<string, string>();
const _BLOB_CACHE_MAX = 60;

export function _blobCacheTouch(id: string): string | undefined {
  const u = _blobCache.get(id);
  if (u) {
    _blobCache.delete(id);
    _blobCache.set(id, u);
  }
  return u;
}

export function _blobCachePut(id: string, url: string): void {
  const prev = _blobCache.get(id);
  if (prev && prev !== url) {
    try {
      URL.revokeObjectURL(prev);
    } catch {}
  }
  _blobCache.delete(id);
  _blobCache.set(id, url);
  while (_blobCache.size > _BLOB_CACHE_MAX) {
    const oldest = _blobCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    const ou = _blobCache.get(oldest);
    _blobCache.delete(oldest);
    if (ou) {
      try {
        URL.revokeObjectURL(ou);
      } catch {}
    }
  }
}

const _MEDIA_FETCH_MAX = 4;
let _mediaInflight = 0;
const _mediaWaiters: Array<() => void> = [];

export function _acquireMediaSlot(): Promise<void> {
  if (_mediaInflight < _MEDIA_FETCH_MAX) {
    _mediaInflight++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => _mediaWaiters.push(resolve));
}

export function _releaseMediaSlot(): void {
  const next = _mediaWaiters.shift();
  if (next) next();
  else _mediaInflight = Math.max(0, _mediaInflight - 1);
}

export function useFileBlob(file: any, token: string) {
  const [url, setUrl] = useState<string | null>(
    () => file?.url || (file?.id ? _blobCache.get(String(file.id)) : null) || null,
  );
  const [failed, setFailed] = useState(false);
  // HTTP status of the failed fetch (503 = storage outage, 404 = object gone,
  // 0 = network/decrypt). Lets the UI say WHY, and `retry()` re-runs the fetch
  // without a page refresh — a MinIO blip used to leave "Couldn't load" stuck
  // on screen until the user reloaded the whole app.
  const [failStatus, setFailStatus] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => {
    setFailed(false);
    setFailStatus(0);
    setProgress(0);
    setAttempt((n) => n + 1);
  }, []);
  const [progress, setProgress] = useState(() =>
    file?.id && _blobCache.has(String(file.id)) ? 100 : 0,
  );

  useEffect(() => {
    if (!file || file.url || !file.id) return;
    const hit = _blobCacheTouch(String(file.id));
    if (hit) {
      setUrl(hit);
      setProgress(100);
      return;
    }
    let cancelled = false;
    let activeObjectUrl: string | null = null;
    let released = false;

    const run = async () => {
      await _acquireMediaSlot();
      if (cancelled) {
        _releaseMediaSlot();
        return;
      }
      const releaseOnce = () => {
        if (!released) {
          released = true;
          _releaseMediaSlot();
        }
      };

      try {
        const id = String(file.id);
        const r = await fetch(
          api.fileLinkUrl(`/api/files/${id}/download`),
          token ? { headers: { Authorization: "Bearer " + token } } : {},
        );
        if (!r.ok) {
          const err: any = new Error("HTTP " + r.status);
          err.status = r.status;
          throw err;
        }
        const mimeType = mimeOf(file) || r.headers.get("Content-Type") || "";
        const total = Number(r.headers.get("Content-Length") || 0);

        let blob: Blob;
        if (r.body && r.body.getReader && total > 0) {
          const reader = r.body.getReader();
          const chunks: BlobPart[] = [];
          let loaded = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (cancelled) break;
            if (value) {
              chunks.push(value);
              loaded += value.length;
              setProgress(Math.min(99, Math.round((loaded / total) * 100)));
            }
          }
          if (cancelled) {
            releaseOnce();
            return;
          }
          blob = new Blob(chunks, { type: mimeType });
        } else {
          blob = await r.blob();
        }

        releaseOnce();

        if (cancelled) return;
        if (file._e2eeKey && file._e2eeStream) {
          blob = await decryptChunkedToBlob(blob, file._e2eeKey, file._e2eeStream, mimeType);
        } else if (file._e2eeKey && file._e2eeIv) {
          blob = await decryptBlob(blob, file._e2eeKey, file._e2eeIv, mimeType);
        }
        if (cancelled) return;

        activeObjectUrl = URL.createObjectURL(blob);
        _blobCachePut(id, activeObjectUrl);
        setUrl(activeObjectUrl);
        setProgress(100);
      } catch (e: any) {
        releaseOnce();
        if (!cancelled) {
          setFailStatus(Number(e?.status) || 0);
          setFailed(true);
        }
      }
    };

    void run();
    return () => {
      cancelled = true;
      if (!released) _releaseMediaSlot();
    };
  }, [file, token, attempt]);

  return { url, failed, setFailed, failStatus, retry, progress };
}

export function LargeFileCard({ file, token }: { file: any; token: string }) {
  const [busy, setBusy] = useState(false);
  const downloaded = useDownloaded(file?.id);

  const openAuthed = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      await downloadAttachment(file, token);
    } catch {
      /* downloadAttachment already toasted the reason */
    } finally {
      setBusy(false);
    }
  };

  const iconBtnStyle: React.CSSProperties = {
    position: "absolute",
    top: "50%",
    right: 10,
    transform: "translateY(-50%)",
    width: 28,
    height: 28,
    borderRadius: "50%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "var(--g100,#f3f4f6)",
    color: "var(--g600,#4b5563)",
    border: "none",
    cursor: busy ? "default" : "pointer",
    opacity: busy ? 0.5 : 1,
  };

  // The whole card is the download target (a 28px corner button is easy to
  // miss, especially on touch); the icon only says "not on this device yet"
  // and disappears once the file has been saved here.
  return (
    <div
      className="fb-bub"
      style={{ position: "relative", paddingRight: downloaded ? 14 : 44, cursor: busy ? "default" : "pointer" }}
      role="button"
      tabIndex={0}
      aria-label={"Download " + (file.name || "file")}
      onClick={openAuthed}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") openAuthed(e as any);
      }}
      {...dragOutProps(file, token)}
    >
      <div className="fi" style={{ background: "#0ea5e922", color: "#0ea5e9" }}>
        <IconCloud size={20} />
      </div>
      <div className="fm">
        <h4>{file.name}</h4>
        <p>Large file · {humanBytes(file.sizeBytes ?? file.size ?? 0)}</p>
      </div>
      {downloaded ? null : (
        <button
          type="button"
          aria-label={"Download " + (file.name || "file")}
          disabled={busy}
          style={iconBtnStyle}
          onClick={openAuthed}
        >
          <IconDownload size={15} />
        </button>
      )}
    </div>
  );
}

/** Why an attachment failed, in words a user can act on. */
export function failLabel(status: number): string {
  if (status === 503 || status === 502 || status === 504) return "Storage unavailable";
  if (status === 404) return "File no longer available";
  return "Couldn't load";
}

function RetryButton({ onRetry, status }: { onRetry: () => void; status: number }) {
  if (status === 404) return null; // the object is gone — retrying can't help
  return (
    <button
      type="button"
      className="msg-video-cancel-lite"
      onClick={(e) => {
        e.stopPropagation();
        onRetry();
      }}
    >
      Retry
    </button>
  );
}

export const chatImageOpenerRef: { current: ((file: any) => void) | null } = { current: null };

export function FileAttachment({ file, token, convId }: { file: any; token: string; convId?: string }) {
  const mime = mimeOf(file);
  const isImage = mime.startsWith("image/");
  const isVideo = mime.startsWith("video/");
  const isAudio = mime.startsWith("audio/");
  const isLarge = !!(file?.largeFile || file?.collabLink);
  const isLocked = !!(file?.e2ee && !file?.url && !file?._e2eeKey);
  const needsBlob = !isLarge && !isLocked && (isImage || isAudio);

  const [playRequested, setPlayRequested] = useState(
    () => !!(file?.id && _blobCache.has(String(file.id))),
  );
  const [autoPlayNow, setAutoPlayNow] = useState(false);
  const [streamSrc, setStreamSrc] = useState<string | null>(null);
  const canStream = isVideo && !isLarge && !isLocked && !!file?._e2eeStream && !!file?._e2eeKey;

  useEffect(() => {
    return () => {
      if (file?.id) dropStreamVideo(String(file.id));
    };
  }, [file?.id]);

  const wantsVideoBlob = isVideo && !isLarge && !isLocked && playRequested;
  const { url, failed, setFailed, failStatus, retry, progress } = useFileBlob(
    needsBlob || wantsVideoBlob ? file : null,
    token,
  );
  const [dlPct, setDlPct] = useState<number | null>(null);
  const [zoom, setZoom] = useState(false);
  const downloaded = useDownloaded(file?.id);
  // A locked attachment (its wrapped key is in a message envelope this device
  // can't open yet) is a decrypt gap like any other: ask for it ONCE, then let
  // the automatic recovery — cached backup key, keychain secret, sibling devices
  // — deliver it. No retry button: the card mirrors the live recovery state.
  const rec = useRecoveryState();
  useEffect(() => {
    if (!isLocked) return;
    requestRestore(convId, false);
  }, [isLocked, convId]);
  // The spinner used to stay up for as long as the recovery phase wasn't
  // "exhausted" — but "done" (this device holds a backup key, yet THIS file's
  // key wasn't in it) and "idle" are not running anything either, so a
  // recipient on a new browser watched "Restoring…" forever with no way to
  // download. After a short grace the card says what is actually true and
  // offers to ask the other devices again.
  const LOCKED_GRACE_MS = 15_000;
  const [lockedSince, setLockedSince] = useState(() => Date.now());
  const [graceOver, setGraceOver] = useState(false);
  useEffect(() => {
    if (!isLocked) return;
    setGraceOver(false);
    const t = setTimeout(() => setGraceOver(true), LOCKED_GRACE_MS);
    return () => clearTimeout(t);
  }, [isLocked, lockedSince, file?.id]);

  if (isLarge) {
    return <LargeFileCard file={file} token={token} />;
  }

  if (isLocked) {
    const restoring = rec.phase === "restoring" || (!graceOver && rec.phase !== "exhausted");
    const askAgain = (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setLockedSince(Date.now());
      requestRestore(convId, true);
    };
    return (
      <div className="fb-bub" style={{ position: "relative" }} role="status" aria-live="polite">
        <div className="fi" style={{ background: "#64748b22", color: "#64748b", display: "flex", alignItems: "center", justifyContent: "center" }}>
          {restoring ? <span className="e2ee-restore-spin" aria-hidden /> : <IconLock size={20} />}
        </div>
        <div className="fm">
          <h4>{file.name || "Encrypted file"}</h4>
          {restoring ? (
            <p>Restoring…</p>
          ) : (
            <>
              <p>Encrypted file · key not on this device yet</p>
              <span className="e2ee-restore-hint">
                It appears automatically once one of your other devices or the sender is
                online, or when your backup is unlocked here.{" "}
                <button type="button" className="msg-video-cancel-lite" onClick={askAgain}>
                  Try again
                </button>
              </span>
            </>
          )}
        </div>
      </div>
    );
  }

  const openZoom = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setZoom(true);
  };

  // One shared path (lib/downloadAttachment): desktop native save, oversized
  // ticket link, or fetch + decrypt + Save-As — with the picker opened BEFORE
  // the fetch so the click gesture isn't lost, and a toast when it fails
  // instead of silently doing nothing.
  const saveAs = async (e: React.MouseEvent | React.KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (dlPct != null) return;
    if (!url && !file?.id) return;
    if (!url) setDlPct(0);
    try {
      await downloadAttachment(file, token, { url, onProgress: setDlPct });
    } catch {
      setFailed(true);
    } finally {
      setDlPct(null);
    }
  };

  const dlBusy = dlPct != null;
  const dlDisabled = dlBusy || (needsBlob && !url);
  // Hidden once the file has been saved on this device (messaging-app
  // convention: the icon means "not downloaded here yet").
  const DownloadCorner = ({ style }: { style?: React.CSSProperties }) =>
    downloaded && !dlBusy ? null : (
    <button
      type="button"
      aria-label={`Download ${file.name || "file"}`}
      title={dlBusy ? `Downloading ${dlPct}%` : "Download"}
      onClick={saveAs}
      disabled={dlDisabled}
      style={{
        position: "absolute",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 28,
        height: 28,
        borderRadius: "50%",
        border: "none",
        cursor: dlDisabled ? "default" : "pointer",
        background: "rgba(0,0,0,0.55)",
        color: "#fff",
        backdropFilter: "blur(2px)",
        opacity: dlDisabled && !dlBusy ? 0.5 : 1,
        fontSize: 10,
        fontWeight: 700,
        ...style,
      }}
    >
      {dlBusy ? `${dlPct}%` : <IconDownload size={15} />}
    </button>
  );

  if (isImage) {
    return url ? (
      <figure
        className="msg-image"
        onClick={(e) =>
          chatImageOpenerRef.current ? chatImageOpenerRef.current(file) : openZoom(e)
        }
        {...dragOutProps(file, token)}
      >
        <img
          src={url}
          alt={file.name}
          onError={() => setFailed(true)}
          draggable={false}
        />
        <DownloadCorner style={{ top: 10, right: 10 }} />
        {zoom ? (
          <AlbumLightbox
            run={[{ file }]}
            token={token}
            index={0}
            onIndex={() => {}}
            onClose={() => setZoom(false)}
          />
        ) : null}
      </figure>
    ) : (
      <div className="msg-image msg-image-loading" aria-busy={!failed}>
        <IconImage aria-hidden />
        <div className="msg-image-meta">
          <span className="name">{file.name}</span>
          <span className="state">
            {failed ? failLabel(failStatus) : `Downloading… ${progress}%`}
          </span>
          {!failed ? (
            <div className="dl-meter" aria-label={`Downloading ${progress}%`}>
              <div className="dl-meter-bar" style={{ width: `${progress}%` }} />
            </div>
          ) : (
            <RetryButton onRetry={retry} status={failStatus} />
          )}
        </div>
      </div>
    );
  }

  if (isVideo) {
    if (streamSrc) {
      return (
        <div
          style={{ position: "relative", display: "inline-block", maxWidth: 320 }}
          {...dragOutProps(file, token)}
        >
          <video
            src={streamSrc}
            controls
            autoPlay={autoPlayNow}
            poster={file.thumb || undefined}
            controlsList="nodownload"
            playsInline
            draggable={false}
            onError={() => {
              try {
                dropStreamVideo(String(file.id));
              } catch (_) {}
              setStreamSrc(null);
              setPlayRequested(true);
            }}
            style={{ maxWidth: "100%", maxHeight: 280, borderRadius: 10, display: "block" }}
          />
          <DownloadCorner style={{ top: 8, right: 8 }} />
        </div>
      );
    }
    if (!playRequested) {
      const vsize = file?.sizeBytes ?? file?.size;
      return (
        <div
          style={{ position: "relative", display: "inline-block", maxWidth: 320 }}
          {...dragOutProps(file, token)}
        >
          <button
            type="button"
            className={"msg-video-poster" + (file.thumb ? " has-thumb" : "")}
            aria-label={`Play ${file.name || "video"}`}
            onClick={async (e) => {
              e.stopPropagation();
              setAutoPlayNow(true);
              if (canStream) {
                const su = await registerStreamVideo(
                  String(file.id),
                  file._e2eeStream,
                  file._e2eeKey,
                  mimeOf(file) || "video/mp4",
                  token,
                ).catch(() => null);
                if (su) {
                  setStreamSrc(su);
                  return;
                }
              }
              setPlayRequested(true);
            }}
          >
            {file.thumb ? (
              <img className="msg-video-thumb" src={file.thumb} alt="" draggable={false} />
            ) : null}
            <span className="msg-video-play" aria-hidden>
              <IconPlay />
            </span>
            <span className="msg-video-cap">
              <span className="name">{file.name || "Video"}</span>
              {vsize ? <span className="size">{humanBytes(vsize)}</span> : null}
            </span>
          </button>
          <DownloadCorner style={{ top: 8, right: 8 }} />
        </div>
      );
    }
    if (!url) {
      if (file.thumb && !failed) {
        return (
          <div
            style={{ position: "relative", display: "inline-block", maxWidth: 320 }}
            {...dragOutProps(file, token)}
          >
            <div className="msg-video-poster has-thumb loading">
              <img className="msg-video-thumb" src={file.thumb} alt="" draggable={false} />
              <span className="msg-video-play spin" aria-hidden />
              <button
                type="button"
                className="msg-video-cancel"
                aria-label="Cancel"
                title="Cancel"
                onClick={(e) => {
                  e.stopPropagation();
                  setAutoPlayNow(false);
                  setPlayRequested(false);
                }}
              >
                <IconX size={16} />
              </button>
              <span className="msg-video-cap">
                <span className="name">Loading… {progress}%</span>
              </span>
              <div className="msg-video-meter" aria-label={`Loading ${progress}%`}>
                <div className="msg-video-meter-bar" style={{ width: `${progress}%` }} />
              </div>
            </div>
          </div>
        );
      }
      return (
        <div className="msg-image msg-image-loading" aria-busy={!failed} style={{ maxWidth: 320 }}>
          <IconPlay aria-hidden />
          <div className="msg-image-meta">
            <span className="name">{file.name}</span>
            <span className="state">
              {failed ? failLabel(failStatus) : `Loading video… ${progress}%`}
            </span>
            {!failed ? (
              <div className="dl-meter" aria-label={`Loading ${progress}%`}>
                <div className="dl-meter-bar" style={{ width: `${progress}%` }} />
              </div>
            ) : (
              <RetryButton onRetry={retry} status={failStatus} />
            )}
            {!failed ? (
              <button
                type="button"
                className="msg-video-cancel-lite"
                onClick={(e) => {
                  e.stopPropagation();
                  setAutoPlayNow(false);
                  setPlayRequested(false);
                }}
              >
                Cancel
              </button>
            ) : null}
          </div>
        </div>
      );
    }
    return (
      <div
        style={{ position: "relative", display: "inline-block", maxWidth: 320 }}
        {...dragOutProps(file, token)}
      >
        <video
          src={url}
          controls
          poster={file.thumb || undefined}
          autoPlay={autoPlayNow}
          controlsList="nodownload"
          playsInline
          draggable={false}
          style={{
            maxWidth: "100%",
            maxHeight: 280,
            borderRadius: 10,
            display: "block",
          }}
        />
        <DownloadCorner style={{ top: 8, right: 8 }} />
      </div>
    );
  }

  if (isAudio) {
    return (
      <div className="msg-audio-player" {...dragOutProps(file, token)}>
        <div className="msg-audio-icon">
          <IconMusic aria-hidden />
        </div>
        <div className="msg-audio-content">
          <span className="msg-audio-name">{file.name || "Audio"}</span>
          {url ? (
            <audio controls className="msg-audio-el" preload="metadata">
              <source src={url} type={mime || "audio/mpeg"} />
            </audio>
          ) : (
            <span className="msg-audio-loading">
              {failed ? failLabel(failStatus) : `Downloading… ${progress}%`}
              {failed ? <RetryButton onRetry={retry} status={failStatus} /> : null}
            </span>
          )}
        </div>
        <DownloadCorner
          style={{
            top: "50%",
            right: 8,
            transform: "translateY(-50%)",
            background: "var(--g100,#f3f4f6)",
            color: "var(--g600,#4b5563)",
            backdropFilter: "none",
          }}
        />
      </div>
    );
  }

  // A document bubble is itself the download target — clicking the name/icon
  // works everywhere, including browsers and touch devices where the small
  // corner button was hard to hit or not reacting. The corner icon stays until
  // the file has been saved on this device, then disappears.
  return (
    <div
      className="fb-bub"
      style={{ position: "relative", paddingRight: downloaded ? 14 : 44, cursor: dlBusy ? "progress" : "pointer" }}
      role="button"
      tabIndex={0}
      aria-label={`${downloaded ? "Download again" : "Download"} ${file.name || "file"}`}
      onClick={saveAs}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") void saveAs(e);
      }}
      {...dragOutProps(file, token)}
    >
      <div
        className="fi"
        style={{
          background: (file.color || "#4f46e5") + "22",
          color: file.color || "#4f46e5",
        }}
      >
        {file.icon || <IconFileText size={20} />}
      </div>
      <div className="fm">
        <h4 title={file.name}>{file.name}</h4>
        <p>
          {(() => {
            const ext = String(file.name || "").split(".").pop() || "";
            const showExt = !!ext && ext.length <= 5 && ext !== file.name;
            const sizeStr =
              typeof file.size === "number"
                ? humanBytes(file.size)
                : file.size || "File";
            return (
              <>
                {showExt ? (
                  <>
                    <span className="fm-type">{ext}</span>
                    {" · "}
                  </>
                ) : null}
                {sizeStr}
              </>
            );
          })()}
          {dlPct != null
            ? ` · Downloading… ${dlPct}%`
            : failed
              ? ` · ${failLabel(failStatus)}`
              : ""}
        </p>
        {dlPct != null ? (
          <div className="dl-meter" aria-label={`Downloading ${dlPct}%`}>
            <div className="dl-meter-bar" style={{ width: `${dlPct}%` }} />
          </div>
        ) : null}
      </div>
      <DownloadCorner
        style={{
          top: "50%",
          right: 10,
          transform: "translateY(-50%)",
          background: "var(--g100, #f3f4f6)",
          color: "var(--g600, #4b5563)",
          backdropFilter: "none",
        }}
      />
    </div>
  );
}

/** File-type art: the Word / Excel / PowerPoint / PDF icon when the extension
 *  matches, else a tinted chip carrying the extension. The fallback for
 *  anything that isn't a viewable image. */
export function FileExtAvatar({
  name,
  size = 42,
  radius = 11,
  className = "",
}: {
  name?: string;
  size?: number;
  radius?: number;
  className?: string;
}) {
  const icon = fileTypeIcon(name);
  if (icon) {
    return (
      <span
        className={"file-thumb file-type-icon " + className}
        style={{ width: size, height: size, borderRadius: radius }}
        aria-label={extAvatar(name).label + " file"}
      >
        <img src={icon} alt="" width={size} height={size} draggable={false} />
      </span>
    );
  }
  const av = extAvatar(name);
  return (
    <span
      className={"file-thumb file-ext-avatar " + className}
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        color: av.color,
        background: `color-mix(in srgb, ${av.color} 13%, var(--sb, #fff))`,
        fontSize: size >= 44 ? 12 : 10.5,
      }}
      aria-label={av.label + " file"}
    >
      {av.label}
    </span>
  );
}

/** List thumbnail (Files tab rows): the real image for image attachments —
 *  fetched and, for E2EE files whose key the client holds, decrypted exactly
 *  like a message bubble — else the extension avatar. Pass a STABLE `file`
 *  object (memoise the list) so the blob hook doesn't refetch on every render. */
export function FileThumb({
  file,
  token,
  size = 42,
  radius = 11,
}: {
  file: any;
  token: string;
  size?: number;
  radius?: number;
}) {
  const mime = bestMime(file);
  const isImage = mime.startsWith("image/");
  const decryptable = canDecryptFile(file);
  const { url, failed } = useFileBlob(isImage && decryptable ? file : null, token);
  const [imgErr, setImgErr] = useState(false);
  useEffect(() => {
    setImgErr(false);
  }, [url]);
  const box = { width: size, height: size, borderRadius: radius };
  if (isImage && url && !failed && !imgErr) {
    return (
      <span className="file-thumb" style={box}>
        <img src={url} alt="" draggable={false} onError={() => setImgErr(true)} />
      </span>
    );
  }
  if (isImage && decryptable && !failed && !imgErr) {
    return <span className="file-thumb file-thumb-load" style={box} aria-hidden="true" />;
  }
  return <FileExtAvatar name={file?.name} size={size} radius={radius} />;
}

export function InfoMediaTile({
  file,
  token,
  onOpen,
  more,
}: {
  file: any;
  token: string;
  onOpen: () => void;
  more?: number;
}) {
  const mime = bestMime(file);
  const isImage = mime.startsWith("image/");
  const isVideo = mime.startsWith("video/");
  // Locked = an E2EE file whose key this client doesn't hold (its message isn't
  // loaded / decrypted). With the key merged in from the message (see
  // lib/fileThumbs) the tile decrypts and shows the real thumbnail.
  const locked = !!file?.e2ee && !file?.url && !file?._e2eeKey;
  const { url, failed } = useFileBlob(
    (isImage || isVideo) && !locked ? file : null,
    token,
  );
  const [imgErr, setImgErr] = useState(false);
  useEffect(() => {
    setImgErr(false);
  }, [url]);

  let inner: React.ReactNode;
  if (!isImage && !isVideo) {
    // Documents never need the key to be identified: show the extension avatar.
    inner = (
      <span className="info-media-doc">
        <FileExtAvatar name={file.name} size={46} radius={12} />
      </span>
    );
  } else if (locked) {
    inner = (
      <span className="info-media-doc">
        <IconLock />
      </span>
    );
  } else if (isImage && url && !failed && !imgErr) {
    inner = (
      <img
        src={url}
        alt={file.name}
        className="info-media-img"
        onError={() => setImgErr(true)}
      />
    );
  } else if (isVideo && url && !failed && !imgErr) {
    inner = (
      <>
        <video
          src={url}
          className="info-media-img"
          muted
          preload="metadata"
          playsInline
          onError={() => setImgErr(true)}
        />
        <span className="info-media-play">
          <IconPlay />
        </span>
      </>
    );
  } else if (!failed && !imgErr) {
    inner = <span className="info-media-load" />;
  } else {
    inner = (
      <span className="info-media-doc">
        <FileExtAvatar name={file.name} size={46} radius={12} />
      </span>
    );
  }

  return (
    <div className="info-media-cell">
      <button
        className={"info-media-thumb" + (isVideo ? " is-video" : "")}
        title={file.name}
        onClick={onOpen}
      >
        {inner}
        {more ? <span className="info-media-more">+{more}</span> : null}
      </button>
      <span className="info-media-name" title={file.name}>
        {file.name || "File"}
      </span>
    </div>
  );
}

export default FileAttachment;
