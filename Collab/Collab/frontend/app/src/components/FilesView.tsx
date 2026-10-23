import React, { useRef, useState, useEffect, useCallback } from "react";
import { api } from "../lib/api";
import { copyText } from "../lib/clipboard";
import { isDesktopApp } from "../lib/platform";
import { dragOutProps, maybeNativeSaveAs } from "../lib/desktopFiles";
import { IconX, IconTrash, IconFile, IconShare2, IconDownload, IconStar } from "../lib/icons";
import { Select } from "./ui";

const fmtSize = (n) => {
  const b = Number(n) || 0;
  if (b < 1024) return b + " B";
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
  if (b < 1024 * 1024 * 1024) return (b / (1024 * 1024)).toFixed(1) + " MB";
  return (b / (1024 * 1024 * 1024)).toFixed(2) + " GB";
};
const fmtDate = (v) => {
  try {
    return new Date(v).toLocaleDateString([], {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return "";
  }
};
const extOf = (name) => {
  const m = /\.([a-z0-9]+)$/i.exec(name || "");
  return m ? m[1].slice(0, 4).toUpperCase() : "FILE";
};
// Categorise a file by extension so each row shows a COLOUR-CODED media tile
// (images, video, audio, docs, sheets…) instead of one flat accent badge — a
// media-first read of what's actually been shared across the messaging module.
const FILE_CATS: Record<string, string> = {
  jpg: "image", jpeg: "image", png: "image", gif: "image", webp: "image",
  svg: "image", heic: "image", bmp: "image", tiff: "image", avif: "image",
  mp4: "video", mov: "video", webm: "video", mkv: "video", avi: "video", m4v: "video",
  mp3: "audio", wav: "audio", ogg: "audio", m4a: "audio", flac: "audio", aac: "audio",
  pdf: "pdf",
  doc: "doc", docx: "doc", txt: "doc", rtf: "doc", md: "doc", pages: "doc",
  xls: "sheet", xlsx: "sheet", csv: "sheet", numbers: "sheet",
  ppt: "slide", pptx: "slide", key: "slide",
  zip: "archive", rar: "archive", "7z": "archive", tar: "archive", gz: "archive",
  js: "code", ts: "code", tsx: "code", jsx: "code", json: "code", html: "code",
  css: "code", py: "code", java: "code", c: "code", cpp: "code", go: "code",
  rs: "code", sh: "code", yml: "code", yaml: "code",
};
const fileCat = (name: string) => {
  const m = /\.([a-z0-9]+)$/i.exec(name || "");
  return (m && FILE_CATS[m[1].toLowerCase()]) || "other";
};

// UI tab → server `tab` param. The server paginates WITHIN the tab, so the count
// and pages stay correct per tab. "recent" is just the default newest-first order
// the server already returns, so it maps to the full accessible set ("all").
const SERVER_TAB: Record<string, string> = {
  all: "all",
  recent: "all",
  shared: "shared",
  favorites: "starred",
};

export default function FilesView({
  files,
  onUpload,
  onDelete, // (id) => Promise<boolean> — soft-deletes; true on success
  onRestore, // (id) => Promise<boolean> — restores a soft-deleted file
  onDownload,
  onToggleStar,
  token,
  users,
  conversations,
  onRefresh,
  externalSearch,
  // Server-side pagination (mirrors Tasks/Reminders).
  totalCount = 0,
  hasMore = false,
  loadingMore = false,
  // True while the FIRST page of the active tab/search is loading — drives a
  // "Loading…" placeholder so the live list never flashes "No files yet" (#48).
  loading = false,
  onLoadMore,
  // Server-driven tab + search. Changing either re-pages from scratch.
  activeTab = "all",
  onTabChange,
  onSearch,
  // Recycle bin: (opts) => Promise<{ files, hasMore, nextCursor }>.
  listDeleted,
  // Bumped by the parent on every FILE_CHANGED. While the recycle bin is open,
  // a change to this re-loads the bin so a delete/restore from another
  // device/tab shows up live (the live-list refetch never touches trash state).
  fileChangeTick = 0,
  // Deep-link focus: a file-share notification opens Files focused on this id.
  openFileId,
  onOpenedFile,
  onToast,
}) {
  const inputRef = useRef<any>(null);
  // Local search box state. The query is debounced into the SERVER search so it
  // spans ALL the user's files, not just the loaded page. Seeded from the global
  // search bar (externalSearch) so a search there lands here too.
  const [q, setQ] = useState("");
  useEffect(() => {
    setQ(externalSearch || "");
  }, [externalSearch]);

  // "trash" is a CLIENT-only tab (the recycle bin), the others map to a SERVER
  // tab. FilesView OWNS the UI tab; the parent only needs the server tab (for
  // paging). `activeTab` seeds the initial value; we do NOT mirror it back after
  // mount (the parent stores the SERVER tab, e.g. "starred", which is not a UI
  // tab key like "favorites", so echoing it would corrupt the selection).
  const [uiTab, setUiTab] = useState<string>(activeTab || "all");

  // The parent passes fresh arrow callbacks on EVERY render (CoLabV1 re-render
  // storm). Reading them from refs keeps effects/handlers stable so unrelated
  // parent re-renders (presence/message sockets) don't churn timer-bearing
  // effects. Without this, the debounce effect below would reset its 300ms timer
  // on every socket event and never dispatch the search under steady activity.
  const onSearchRef = useRef(onSearch);
  const onTabChangeRef = useRef(onTabChange);
  useEffect(() => {
    onSearchRef.current = onSearch;
    onTabChangeRef.current = onTabChange;
  });

  // Debounce the search box → server. Skip while on Trash (the recycle bin has
  // its own client-side filter so we don't churn the live-list pagination).
  // Depends ONLY on [q, uiTab] (onSearch read from a ref) so an unrelated parent
  // re-render can't reset the timer and perpetually defer the dispatch.
  const lastSentSearch = useRef("");
  useEffect(() => {
    if (uiTab === "trash") return;
    const t = setTimeout(() => {
      const s = q.trim();
      if (s === lastSentSearch.current) return;
      lastSentSearch.current = s;
      onSearchRef.current && onSearchRef.current(s);
    }, 300);
    return () => clearTimeout(t);
  }, [q, uiTab]);

  const selectTab = (k: string) => {
    if (k === uiTab) return;
    setUiTab(k);
    if (k === "trash") {
      // Entering the recycle bin: load its first page. Leave the live-list
      // search/pagination as-is so returning restores the prior view.
      loadTrash(true);
    } else {
      // A server tab: re-page from scratch (the parent clears the cursor) in a
      // SINGLE refetch that carries BOTH the new tab and the current search box
      // value. Doing it in one call (instead of onTabChange + a separate
      // onSearch) avoids two racing /api/files requests, while still honouring a
      // query the user typed but the 300ms debounce hasn't flushed yet. Sync
      // `lastSentSearch` so the debounce effect treats it as already-dispatched.
      const s = q.trim();
      lastSentSearch.current = s;
      onTabChangeRef.current &&
        onTabChangeRef.current(SERVER_TAB[k] || "all", s);
    }
  };

  // ── Recycle bin (Trash) ────────────────────────────────────────────────────
  const [trash, setTrash] = useState<any[]>([]);
  const [trashCursor, setTrashCursor] = useState<string | null>(null);
  const [trashHasMore, setTrashHasMore] = useState(false);
  const [trashLoading, setTrashLoading] = useState(false);
  // AUDIT #47: authoritative WHOLE-BIN tally from the server (not just the loaded
  // page). null until the first page resolves, then the header uses these instead
  // of the loaded-row counts so a paginated bin isn't under-reported.
  const [trashTotalCount, setTrashTotalCount] = useState<number | null>(null);
  const [trashTotalBytes, setTrashTotalBytes] = useState<number | null>(null);
  const loadTrash = useCallback(
    async (fresh: boolean) => {
      if (!listDeleted) return;
      setTrashLoading(true);
      try {
        const res: any = await listDeleted(
          fresh ? {} : { cursor: trashCursor },
        );
        const more = (res && res.files) || [];
        setTrash((prev) => {
          if (fresh) return more;
          const seen = new Set(prev.map((f) => f.id));
          return [...prev, ...more.filter((f) => !seen.has(f.id))];
        });
        setTrashCursor((res && res.nextCursor) || null);
        setTrashHasMore(!!(res && res.hasMore));
        if (res && typeof res.count === "number") setTrashTotalCount(res.count);
        if (res && typeof res.totalBytes === "number")
          setTrashTotalBytes(res.totalBytes);
      } catch {
        /* ignore */
      } finally {
        setTrashLoading(false);
      }
    },
    [listDeleted, trashCursor],
  );

  // Live-refresh the recycle bin when a FILE_CHANGED arrives WHILE the bin is
  // open (a delete/restore from another device or tab). We read loadTrash from a
  // ref and depend only on [fileChangeTick, uiTab] so paging the bin (which
  // rebuilds loadTrash via trashCursor) can't retrigger a fresh reload. Skip the
  // initial mount: selectTab('trash') already does the first load, and we don't
  // want a reload when the user isn't even on the bin.
  const loadTrashRef = useRef(loadTrash);
  useEffect(() => {
    loadTrashRef.current = loadTrash;
  });
  const lastTrashTick = useRef(fileChangeTick);
  useEffect(() => {
    if (lastTrashTick.current === fileChangeTick) return; // mount / no change
    lastTrashTick.current = fileChangeTick;
    if (uiTab === "trash") loadTrashRef.current(true);
  }, [fileChangeTick, uiTab]);

  // ── Delete confirm + undo ───────────────────────────────────────────────────
  // confirmId: the row currently asking "Delete?". undo: the just-deleted file we
  // can still restore. A short-lived inline confirm (no modal) + an undo toast.
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [undo, setUndo] = useState<{ id: string; name: string } | null>(null);
  const undoTimer = useRef<any>(null);
  useEffect(
    () => () => {
      if (undoTimer.current) clearTimeout(undoTimer.current);
    },
    [],
  );
  const doDelete = async (f: any) => {
    setConfirmId(null);
    if (!onDelete) return;
    const okDel = await onDelete(f.id);
    if (!okDel) return;
    // Offer UNDO for ~7s. Restoring brings the file straight back into the list.
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setUndo({ id: f.id, name: f.name });
    undoTimer.current = setTimeout(() => setUndo(null), 7000);
  };
  const doUndo = async () => {
    if (!undo || !onRestore) return;
    const id = undo.id;
    setUndo(null);
    if (undoTimer.current) clearTimeout(undoTimer.current);
    await onRestore(id);
    onToast && onToast("File restored");
  };
  const doRestoreFromTrash = async (f: any) => {
    if (!onRestore) return;
    const okR = await onRestore(f.id);
    if (okR) {
      setTrash((prev) => prev.filter((x) => x.id !== f.id));
      onToast && onToast("File restored");
    }
  };

  // ── Deep-link focus / highlight ─────────────────────────────────────────────
  const [flashId, setFlashId] = useState<string | null>(null);
  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({});
  useEffect(() => {
    if (!openFileId) return;
    const el = rowRefs.current[openFileId];
    if (el) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      setFlashId(openFileId);
      const t = setTimeout(() => setFlashId(null), 1800);
      onOpenedFile && onOpenedFile();
      return () => clearTimeout(t);
    }
    // The target row isn't on screen. A file-share target is never in Trash, and
    // the scoped server tabs ("shared"/"starred") may legitimately EXCLUDE the
    // freshly-shared file (the recipient already owns/shares it, or it isn't
    // starred), so re-paging the SAME tab would never surface it. Only "all" and
    // "recent" (both the full accessible set) are guaranteed to carry a newly
    // shared file on page 1 — so on any other tab, fall back to "all" and let
    // the parent re-page there. We keep openFileId set (don't ack) so the effect
    // re-runs on the new "all" page and then scrolls/flashes the row. The trash
    // search box uses its own client filter, so the live search doesn't apply.
    if (uiTab !== "all" && uiTab !== "recent") {
      setUiTab("all");
      onTabChangeRef.current && onTabChangeRef.current("all");
      return;
    }
    // Already on a full-set tab but the row still isn't loaded (a later page or
    // an active search hiding it). Acknowledge the deep-link so it doesn't loop;
    // the share also fires FILE_CHANGED which re-pages page 1 where it appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openFileId, files, uiTab]);

  // ── Share panel (unchanged behaviour) ───────────────────────────────────────
  const [panelFor, setPanelFor] = useState<any>(null);
  const [details, setDetails] = useState<any>(null);
  const [sharePerm, setSharePerm] = useState("view");
  const [targetQuery, setTargetQuery] = useState("");
  const [shareErr, setShareErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const reloadDetails = (id) => {
    if (!token) return;
    api
      .fileDetails(token, id)
      .then(setDetails)
      .catch(() => setDetails(null));
  };
  const openPanel = (f) => {
    setPanelFor(f);
    setDetails(null);
    setShareErr(null);
    setCopied(false);
    setTargetQuery("");
    reloadDetails(f.id);
  };
  const closePanel = () => {
    setPanelFor(null);
    setDetails(null);
  };
  const afterChange = () => {
    if (panelFor) reloadDetails(panelFor.id);
    if (onRefresh) onRefresh();
  };
  const doShare = (subjectType, subjectId) => {
    if (!token || !panelFor) return;
    setShareErr(null);
    api
      .shareFile(token, panelFor.id, subjectType, subjectId, sharePerm)
      .then(afterChange)
      .catch((e) => setShareErr((e && e.message) || "Couldn't share"));
  };
  const doUnshare = (shareId) => {
    if (!token || !panelFor) return;
    api
      .unshareFile(token, panelFor.id, shareId)
      .then(afterChange)
      .catch((e) => setShareErr((e && e.message) || "Couldn't update"));
  };
  const doCreateLink = () => {
    if (!token || !panelFor) return;
    api
      .createFileLink(token, panelFor.id, sharePerm)
      .then(afterChange)
      .catch((e) => setShareErr((e && e.message) || "Couldn't create link"));
  };
  const doRevokeLink = () => {
    if (!token || !panelFor) return;
    api
      .revokeFileLink(token, panelFor.id)
      .then(afterChange)
      .catch((e) => setShareErr((e && e.message) || "Couldn't revoke link"));
  };
  const copyLink = (path) => {
    try {
      copyText(api.fileLinkUrl(path));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (_) {
      /* clipboard unavailable */
    }
  };
  const canShare =
    details &&
    (details.permission === "owner" || details.permission === "edit");
  const isOwner = details && details.permission === "owner";
  const tq = targetQuery.trim().toLowerCase();
  const sharedSubjectIds = new Set(
    (details && details.shares ? details.shares : []).map((s) => s.subjectId),
  );
  const targetUsers = (users || [])
    .filter(
      (u) =>
        u.id !== (details && details.owner && details.owner.id) &&
        !sharedSubjectIds.has(u.id) &&
        (!tq || (u.name || "").toLowerCase().includes(tq)),
    )
    .slice(0, 6);
  const targetConvs = (conversations || [])
    .filter(
      (c) =>
        c &&
        (c.kind === "group" || c.kind === "channel") &&
        !sharedSubjectIds.has(c.id) &&
        (!tq || (c.name || "").toLowerCase().includes(tq)),
    )
    .slice(0, 6);

  // ── Desktop "Save as…" / Reveal context menu (gated on isDesktopApp) ────────
  // Reuses the SAME IPC as chat attachments (lib/desktopFiles): maybeNativeSaveAs
  // pops the native Save dialog and reveals the saved file. On the web this menu
  // never opens — rows keep their normal download button.
  const [ctx, setCtx] = useState<{ x: number; y: number; file: any } | null>(
    null,
  );
  useEffect(() => {
    if (!ctx) return;
    const close = () => setCtx(null);
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [ctx]);
  const onRowContextMenu = (e: React.MouseEvent, f: any) => {
    if (!isDesktopApp) return; // web → browser's native menu
    e.preventDefault();
    setCtx({ x: e.clientX, y: e.clientY, file: f });
  };
  const ctxSaveAs = async () => {
    const f = ctx?.file;
    setCtx(null);
    if (!f) return;
    // Native save → reveal. Falls back to the standard download if it can't.
    if (!(await maybeNativeSaveAs(f, token))) onDownload(f.id, f.name);
  };

  // ── Live list (already server-searched + server-paged) ──────────────────────
  const all = files || [];
  // "recent" re-sorts the loaded page newest-first (the server already returns
  // newest-first, so this is a no-op for "all" but keeps the tab meaningful).
  const list =
    uiTab === "recent"
      ? [...all].sort(
          (a, b) =>
            new Date(b.createdAt || 0).getTime() -
            new Date(a.createdAt || 0).getTime(),
        )
      : uiTab === "favorites"
        ? all.filter((f) => f.starred)
        : all;

  const onTrash = uiTab === "trash";
  // Trash has its own client-side name filter over the loaded bin pages.
  const ql = q.trim().toLowerCase();
  const trashList = ql
    ? trash.filter((f) => (f.name || "").toLowerCase().includes(ql))
    : trash;

  const shownCount = onTrash ? trashList.length : list.length;
  const totalSize = (onTrash ? trashList : list).reduce(
    (n, f) => n + (f.size || 0),
    0,
  );
  // Header tally: the authoritative SERVER count for the active tab+search (live
  // tabs), or the loaded trash count (recycle bin). Falls back to the loaded
  // length if the count hasn't arrived. EXCEPTION: "favorites" applies a
  // CLIENT-side `starred` filter on top of the server page, so an optimistic
  // un-star (which drops the row locally before any refetch) would leave the
  // server `totalCount` stale — show the rendered-row count there so the tally
  // always matches the list. "all"/"recent"/"shared" map 1:1 to the server set,
  // so their server count stays authoritative (and survives partial pages).
  const headerCount = onTrash
    ? trashTotalCount ?? trashList.length
    : uiTab === "favorites"
      ? shownCount
      : totalCount || shownCount;
  // Byte tally for the subtitle: the authoritative whole-bin total in the recycle
  // bin (#47), else the sum over the loaded live rows.
  const headerSize = onTrash ? trashTotalBytes ?? totalSize : totalSize;

  return (
    <div className="view active" id="vfiles">
      <div className="fls-hdr">
        <div>
          <h2 className="fls-title">{onTrash ? "Recycle bin" : "Files"}</h2>
          <p className="fls-sub">
            {headerCount} file{headerCount === 1 ? "" : "s"}
            {headerSize > 0 ? ` · ${fmtSize(headerSize)}` : ""}
          </p>
        </div>
        {!onTrash && (
          <>
            <button
              className="btn-p fls-up"
              onClick={() => inputRef.current && inputRef.current.click()}
            >
              Upload file
            </button>
            <input
              ref={inputRef}
              type="file"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files && e.target.files[0];
                if (f) onUpload(f);
                e.target.value = "";
              }}
            />
          </>
        )}
      </div>

      {/* Local file-search box removed — the persistent GLOBAL top-bar search
         (scope: Files) already feeds this view via the `externalSearch` prop
         (see the setQ sync above), so a second box here was redundant. */}

      <div className="ibx-tabs" role="tablist" aria-label="Filter files">
        {[
          ["all", "All"],
          ["recent", "Recent"],
          ["shared", "Shared"],
          ["favorites", "Favorites"],
          ["trash", "Recycle bin"],
        ].map(([k, lb]) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={uiTab === k}
            className={"ibx-tab" + (uiTab === k ? " active" : "")}
            onClick={() => selectTab(k)}
          >
            {lb}
          </button>
        ))}
      </div>

      <div className="fls-body">
        {onTrash ? (
          // ── Recycle bin ──────────────────────────────────────────────────
          trashList.length === 0 ? (
            <div className="fls-empty">
              <div className="fls-empty-ic">
                <IconTrash size={26} />
              </div>
              <div className="fls-empty-t">
                {trashLoading ? "Loading…" : "Recycle bin is empty"}
              </div>
              <div className="fls-empty-s">
                Deleted files appear here. Restore one to bring it back to your
                files.
              </div>
            </div>
          ) : (
            <>
              <div className="fls-list">
                {trashList.map((f) => (
                  <div className="fls-row" key={f.id}>
                    <span className={"fls-ic cat-" + fileCat(f.name)}>{extOf(f.name)}</span>
                    <span className="fls-info">
                      <span className="fls-name" title={f.name}>
                        {f.name}
                      </span>
                      <span className="fls-meta">
                        {fmtSize(f.size)} · Deleted {fmtDate(f.deletedAt)}
                      </span>
                    </span>
                    <span className="fls-actions">
                      <button
                        className="fls-restore"
                        onClick={() => doRestoreFromTrash(f)}
                      >
                        Restore
                      </button>
                    </span>
                  </div>
                ))}
              </div>
              {trashHasMore ? (
                <button
                  className="fls-more"
                  disabled={trashLoading}
                  onClick={() => loadTrash(false)}
                >
                  {trashLoading ? "Loading…" : "Load more"}
                </button>
              ) : null}
            </>
          )
        ) : list.length === 0 ? (
          // ── Empty live list ──────────────────────────────────────────────
          // While the first page is still loading, show a neutral "Loading…"
          // placeholder — NOT the "No files yet" empty state, which would flash
          // a false "you have nothing" before the list arrives (#48).
          loading ? (
            <div className="fls-empty">
              <div className="fls-empty-ic">
                <IconFile size={26} />
              </div>
              <div className="fls-empty-t">Loading…</div>
            </div>
          ) : (
            <div className="fls-empty">
              <div className="fls-empty-ic">
                <IconFile size={26} />
              </div>
              <div className="fls-empty-t">
                {q.trim() ? "No files match" : "No files yet"}
              </div>
              <div className="fls-empty-s">
                {q.trim()
                  ? "Try a different search."
                  : uiTab === "shared"
                    ? "Files shared with you will appear here."
                    : uiTab === "favorites"
                      ? "Star a file to keep it handy here."
                      : "Upload a file to get started — files are stored in your workspace."}
              </div>
            </div>
          )
        ) : (
          <>
            <div className="fls-list">
              {list.map((f) => (
                <div
                  className={
                    "fls-row" + (flashId === f.id ? " fls-row-flash" : "")
                  }
                  key={f.id}
                  ref={(el) => {
                    rowRefs.current[f.id] = el;
                  }}
                  onContextMenu={(e) => onRowContextMenu(e, f)}
                  {...dragOutProps(f, token)}
                >
                  <span className={"fls-ic cat-" + fileCat(f.name)}>{extOf(f.name)}</span>
                  <span className="fls-info">
                    <span className="fls-name" title={f.name}>
                      {f.name}
                    </span>
                    <span className="fls-meta">
                      {fmtSize(f.size)} · {fmtDate(f.createdAt)}
                    </span>
                  </span>
                  {confirmId === f.id ? (
                    // Inline confirm (no modal) — quick + non-annoying.
                    <span className="fls-confirm">
                      <span className="fls-confirm-t">Delete?</span>
                      <button
                        className="fls-confirm-yes"
                        onClick={() => doDelete(f)}
                      >
                        Delete
                      </button>
                      <button
                        className="fls-confirm-no"
                        onClick={() => setConfirmId(null)}
                      >
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <span className="fls-actions">
                      <button
                        className="fls-act"
                        onClick={() => openPanel(f)}
                        aria-label="Share"
                        title="Share"
                      >
                        <IconShare2 size={17} />
                      </button>
                      {f.owned && (
                        <button
                          className="fls-act"
                          style={f.starred ? { color: "var(--ac)" } : undefined}
                          onClick={() =>
                            onToggleStar && onToggleStar(f.id, !f.starred)
                          }
                          aria-label={
                            f.starred
                              ? "Remove from favorites"
                              : "Add to favorites"
                          }
                          aria-pressed={!!f.starred}
                          title={
                            f.starred
                              ? "Remove from favorites"
                              : "Add to favorites"
                          }
                        >
                          <IconStar
                            size={17}
                            fill={f.starred ? "currentColor" : "none"}
                          />
                        </button>
                      )}
                      <button
                        className="fls-act"
                        onClick={() => onDownload(f.id, f.name)}
                        aria-label="Download"
                        title={
                          isDesktopApp
                            ? "Download (right-click to Save as / Reveal)"
                            : "Download"
                        }
                      >
                        <IconDownload size={17} />
                      </button>
                      {f.owned && (
                        <button
                          className="fls-act fls-del"
                          onClick={() => setConfirmId(f.id)}
                          aria-label="Delete"
                          title="Delete"
                        >
                          <IconTrash size={17} />
                        </button>
                      )}
                    </span>
                  )}
                </div>
              ))}
            </div>
            {hasMore ? (
              <button
                className="fls-more"
                disabled={loadingMore}
                onClick={() => onLoadMore && onLoadMore()}
              >
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            ) : null}
          </>
        )}
      </div>

      {/* Undo toast after a delete. */}
      {undo && (
        <div className="fls-undo" role="status">
          <span className="fls-undo-t" title={undo.name}>
            Deleted “{undo.name}”
          </span>
          <button className="fls-undo-btn" onClick={doUndo}>
            Undo
          </button>
        </div>
      )}

      {/* Desktop right-click menu: Save as… / Reveal (reuses chat IPC). */}
      {ctx && isDesktopApp && (
        <div
          className="fls-ctx"
          style={{ left: ctx.x, top: ctx.y }}
          onClick={(e) => e.stopPropagation()}
          role="menu"
        >
          <button className="fls-ctx-i" onClick={ctxSaveAs} role="menuitem">
            Save as…
          </button>
          <button
            className="fls-ctx-i"
            role="menuitem"
            onClick={() => {
              const f = ctx.file;
              setCtx(null);
              // Reveal-in-folder needs the file on disk first → native save,
              // which itself reveals on success. Falls back to download.
              maybeNativeSaveAs(f, token).then((handled) => {
                if (!handled) onDownload(f.id, f.name);
              });
            }}
          >
            Save &amp; reveal in folder
          </button>
        </div>
      )}

      {panelFor && (
        <div className="fsh-overlay" onClick={closePanel}>
          <div
            className="fsh-panel"
            role="dialog"
            aria-label="File sharing"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="fsh-hd">
              <div className="fsh-hd-t">
                <span className="fsh-ic">{extOf(panelFor.name)}</span>
                <span className="fsh-name" title={panelFor.name}>
                  {panelFor.name}
                </span>
              </div>
              <button
                className="fsh-close"
                onClick={closePanel}
                aria-label="Close"
              >
                <IconX size={16} />
              </button>
            </div>
            {!details ? (
              <div className="fsh-muted fsh-loading">Loading…</div>
            ) : (
              <div className="fsh-body">
                <div className="fsh-perm">
                  {details.permission === "owner"
                    ? "You own this file"
                    : `Shared with you · ${details.permission}`}
                </div>
                {shareErr && <div className="fsh-err">{shareErr}</div>}

                {canShare && (
                  <div className="fsh-sec">
                    <div className="fsh-sec-h">
                      Share with people &amp; channels
                    </div>
                    <div className="fsh-share-row">
                      <input
                        className="fsh-input"
                        placeholder="Search a person or channel to share with…"
                        value={targetQuery}
                        onChange={(e) => setTargetQuery(e.target.value)}
                      />
                      <Select
                        className="fsh-sel"
                        value={sharePerm}
                        onChange={(e) => setSharePerm(e.target.value)}
                        aria-label="Permission"
                      >
                        <option value="view">Can view</option>
                        <option value="comment">Can comment</option>
                        <option value="edit">Can edit</option>
                      </Select>
                    </div>
                    <div className="fsh-targets">
                      {!targetQuery.trim() ? (
                        <div className="fsh-muted">
                          Start typing a name above, then tap a result to give
                          them access.
                        </div>
                      ) : targetUsers.length || targetConvs.length ? (
                        <>
                          {targetUsers.map((u) => (
                            <button
                              key={"u" + u.id}
                              className="fsh-target"
                              onClick={() => doShare("user", u.id)}
                            >
                              <span className="fsh-target-n">{u.name}</span>
                              <span className="fsh-target-k">Person</span>
                            </button>
                          ))}
                          {targetConvs.map((c) => (
                            <button
                              key={"c" + c.id}
                              className="fsh-target"
                              onClick={() => doShare("conversation", c.id)}
                            >
                              <span className="fsh-target-n">{c.name}</span>
                              <span className="fsh-target-k">
                                {c.kind === "channel" ? "Channel" : "Group"}
                              </span>
                            </button>
                          ))}
                        </>
                      ) : (
                        <div className="fsh-muted">
                          No people or channels match “{targetQuery.trim()}”.
                        </div>
                      )}
                    </div>
                  </div>
                )}

                <div className="fsh-sec">
                  <div className="fsh-sec-h">Shared with</div>
                  {details.shares.length === 0 ? (
                    <div className="fsh-muted">Not shared with anyone yet</div>
                  ) : (
                    details.shares.map((s) => (
                      <div className="fsh-share" key={s.id}>
                        <span className="fsh-share-n" title={s.subjectName}>
                          {s.subjectName}
                        </span>
                        <span className="fsh-share-k">
                          {s.subjectType === "user"
                            ? "Person"
                            : "Channel/Group"}
                        </span>
                        <span className="fsh-share-p">{s.permission}</span>
                        {isOwner && (
                          <button
                            className="fsh-rm"
                            onClick={() => doUnshare(s.id)}
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    ))
                  )}
                </div>

                {isOwner && (
                  <div className="fsh-sec">
                    <div className="fsh-sec-h">Share link</div>
                    {details.link ? (
                      <div className="fsh-link">
                        <span className="fsh-link-p">
                          Anyone with the link · {details.link.permission}
                        </span>
                        <button
                          className="fsh-go"
                          onClick={() => copyLink(details.link.path)}
                        >
                          {copied ? "Copied!" : "Copy link"}
                        </button>
                        <button className="fsh-x" onClick={doRevokeLink}>
                          Remove link
                        </button>
                      </div>
                    ) : (
                      <button className="fsh-go" onClick={doCreateLink}>
                        Create link ({sharePerm})
                      </button>
                    )}
                  </div>
                )}

                {details.linkedConversation && (
                  <div className="fsh-sec">
                    <div className="fsh-sec-h">In conversation</div>
                    <div className="fsh-muted">
                      {details.linkedConversation.name}
                    </div>
                  </div>
                )}

                <div className="fsh-sec">
                  <div className="fsh-sec-h">Activity</div>
                  {details.activity.length === 0 ? (
                    <div className="fsh-muted">No sharing activity yet</div>
                  ) : (
                    details.activity.map((a, i) => (
                      <div className="fsh-act-row" key={i}>
                        <span className="fsh-act-t">{a.text}</span>
                        <span className="fsh-act-w">{fmtDate(a.when)}</span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
