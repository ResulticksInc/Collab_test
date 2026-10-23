import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../lib/api";
import config from "../lib/config";
import { openStudio } from "../lib/studio";
import { ALL_EMOJI_CHARS, searchEmojis } from "../lib/emojiData";

// Cost-free media picker for the composer:
//  • GIFs + Stickers tabs — GIPHY search, proxied server-side (/api/media/gifs).
//    When search isn't configured, Stickers shows a keyless built-in pack and GIFs
//    offers "create your own" (the studio) — never a dead end.
//  • "Yours" tab — WhatsApp-style CUSTOM stickers the user uploads/creates into a
//    personal tray (self-hosted, no external key). Picking any item sends it as an
//    inline media message carrying the image URL (no upload at send time; the
//    renderer short-circuits on file.url). The "Yours" tab always works.

export type PickedMedia = {
  url: string;
  type: string;
  name: string;
  width: number;
  height: number;
  // Message kind. "gif"/"sticker" render bubble-less; undefined = normal media.
  kind?: "sticker" | "gif";
};

// A keyless, license-clean built-in sticker set: single emoji rendered to a small
// transparent PNG on the fly (no external service, no upload). Shown in the
// Stickers tab whenever Tenor search isn't configured, so the tab is never empty.
const BUILTIN_STICKER_EMOJI = [
  "😂", "❤️", "👍", "🎉", "🔥", "😍", "😭", "🙏", "👏", "💯", "😎", "🥳",
  "😅", "🤔", "😴", "🤯", "🙌", "👀", "💪", "✨", "🎈", "🌟", "😇", "🤩",
  "😜", "🤗", "😱", "🥺", "😤", "🤣", "👌", "💜", "☕", "🍕", "🐶", "🌈",
];

function emojiToSticker(ch: string): PickedMedia {
  const S = 160;
  const c = document.createElement("canvas");
  c.width = S;
  c.height = S;
  const ctx = c.getContext("2d")!;
  ctx.font = `${Math.round(S * 0.78)}px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(ch, S / 2, S / 2 + S * 0.04);
  return { url: c.toDataURL("image/png"), type: "image/png", name: `${ch}.png`, width: S, height: S, kind: "sticker" };
}

type Item = { id: string; url: string; preview: string; width: number; height: number; desc: string };
type Mine = { id: string; url: string; mime: string; name: string; kind: string; width?: number; height?: number };

// Build an absolute URL for a same-origin API path so it renders for every
// recipient (their <img src>), regardless of the client's API base.
function abs(u: string): string {
  if (!u) return u;
  if (/^https?:\/\//i.test(u)) return u;
  return (config.apiBaseUrl || "") + u;
}

// Master switch for the ONLINE GIF/sticker search (GIPHY). OFF for now per the
// BA/CEO call — creating GIFs/stickers via the studio and reusing "Yours" stay
// on. Flip to true to bring back online search.
const ONLINE_GIFS = false;

export default function GifPicker({
  token,
  onPick,
  onEmoji,
  onClose,
  anchorRef,
  zIndex = 4600,
}: {
  token: string | null;
  onPick: (m: PickedMedia) => void;
  // When provided, the picker gains a leading Emoji tab (Teams-style single
  // popover for Emoji / GIFs / Stickers). Each pick inserts a character and
  // leaves the popover open (multi-insert), matching the old inline picker.
  onEmoji?: (char: string) => void;
  onClose: () => void;
  // The trigger element (the GIF button/wrapper). The picker is PORTALED to
  // document.body and positioned fixed against this anchor, so no ancestor
  // overflow can clip it and it always layers above the composer / call PiP.
  anchorRef?: { current: HTMLElement | null };
  // Stacking order (matches the --z-gifpicker token, 4600). Kept a prop so a
  // caller that ever nests the picker above another overlay can raise it.
  zIndex?: number;
}) {
  const [tab, setTab] = useState<"emoji" | "gif" | "sticker" | "mine">(
    onEmoji ? "emoji" : "gif",
  );
  const [q, setQ] = useState("");
  // Separate query for the Emoji tab so switching tabs doesn't cross-filter.
  const [emojiQ, setEmojiQ] = useState("");
  const [items, setItems] = useState<Item[] | null>(null);
  const [configured, setConfigured] = useState(true);
  const [provider, setProvider] = useState(""); // "giphy" when search is on (for attribution)
  const [loading, setLoading] = useState(false);
  const [mine, setMine] = useState<Mine[] | null>(null);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState("");
  const deb = useRef<any>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // True while the creation studio (portaled sibling) is open over the picker, so
  // the picker's own outside-click/Escape dismissal stands down until it closes.
  const studioOpenRef = useRef(false);

  // Fixed position (portaled to body), computed from the anchor's viewport rect
  // and clamped so the picker is always fully on-screen — opens ABOVE the trigger
  // (composer sits at the bottom), left-aligned but shifted in if it would spill.
  const [pos, setPos] = useState<{ left: number; bottom: number; width: number; maxH: number } | null>(null);
  useLayoutEffect(() => {
    const compute = () => {
      const a = anchorRef?.current;
      if (!a) return;
      const r = a.getBoundingClientRect();
      // When the picker is anchored inside the embedded comms sidebar (the calls
      // / meetings global chat), clamp it to THAT column's rect instead of the
      // whole viewport — otherwise a 360px fixed popover spills left over the
      // chat log and right over the call stage (the overflow bug). In the main
      // chat there's no such host, so it falls back to viewport clamping.
      const host = a.closest(".comms-sidebar") as HTMLElement | null;
      const b = host ? host.getBoundingClientRect() : null;
      const leftBound = b ? b.left + 8 : 8;
      const rightBound = b ? b.right - 8 : window.innerWidth - 8;
      const w = Math.min(360, Math.max(200, rightBound - leftBound));
      const left = Math.max(leftBound, Math.min(r.left, rightBound - w));
      const bottom = Math.max(8, window.innerHeight - r.top + 8);
      // Cap the height at the space above the anchor (no floor) so the picker's
      // top edge never clips above the viewport on short windows.
      const maxH = Math.min(430, Math.max(0, r.top - 16));
      setPos({ left, bottom, width: w, maxH });
    };
    compute();
    window.addEventListener("resize", compute);
    // capture-phase so a scroll in ANY ancestor (chat list, sidebar) repositions it.
    window.addEventListener("scroll", compute, true);
    return () => {
      window.removeEventListener("resize", compute);
      window.removeEventListener("scroll", compute, true);
    };
  }, [anchorRef]);

  // Own dismissal: the picker is portaled OUT of the trigger's subtree, so the
  // parent's outside-click detection can't see it. Close on a click outside BOTH
  // the picker and the anchor (the anchor's own click toggles), and on Escape.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      // The creation studio is portaled to <body> as a SIBLING of the picker, so a
      // click inside it looks "outside" here. Don't dismiss the picker while the
      // studio is open — it must survive so we can return to the Yours tray on
      // save/cancel (Escape is likewise the studio's to handle).
      if (studioOpenRef.current) return;
      const t = e.target as Node;
      if (rootRef.current && rootRef.current.contains(t)) return;
      if (anchorRef?.current && anchorRef.current.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (studioOpenRef.current) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose, anchorRef]);

  useEffect(() => {
    // The Emoji tab has its own search input; only autofocus the GIF/sticker
    // search field so we don't steal focus to the wrong control.
    if (tab === "gif" || tab === "sticker") inputRef.current?.focus();
  }, [tab]);

  // Online GIF/sticker SEARCH (GIPHY) is turned OFF for now — flip ONLINE_GIFS
  // back to true to re-enable it. Creating GIFs/stickers (the studio) and
  // "Yours" are unaffected; the gif/sticker tabs fall back to the keyless
  // create/built-in UI (same path as an unconfigured GIPHY key).
  useEffect(() => {
    if (tab === "mine") return;
    if (!ONLINE_GIFS) {
      setConfigured(false);
      setItems([]);
      setLoading(false);
      return;
    }
    if (deb.current) clearTimeout(deb.current);
    const query = q.trim();
    deb.current = setTimeout(
      async () => {
        if (!token) return;
        setLoading(true);
        try {
          const r: any = await api.gifSearch(token, query, tab, "");
          setConfigured(r?.configured !== false);
          setProvider(r?.provider || "");
          setItems((r && r.results) || []);
        } catch {
          setItems([]);
        } finally {
          setLoading(false);
        }
      },
      query ? 280 : 0,
    );
    return () => clearTimeout(deb.current);
  }, [q, tab, token]);

  const loadMine = async () => {
    if (!token) return;
    try {
      const r: any = await api.listStickers(token);
      setMine((r && r.stickers) || []);
    } catch {
      setMine([]);
    }
  };
  useEffect(() => {
    if (tab === "mine" && mine === null) loadMine();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const pickTenor = (it: Item) => {
    onPick({
      url: it.url,
      type: "image/gif",
      name: (it.desc || (tab === "sticker" ? "sticker" : "gif")).slice(0, 60) + ".gif",
      width: it.width,
      height: it.height,
      kind: tab === "sticker" ? "sticker" : "gif",
    });
    onClose();
  };
  const pickMine = (m: Mine) => {
    onPick({ url: abs(m.url), type: m.mime || "image/png", name: m.name || "sticker", width: m.width || 0, height: m.height || 0, kind: m.kind === "gif" ? "gif" : "sticker" });
    onClose();
  };
  const pickBuiltin = (ch: string) => {
    onPick(emojiToSticker(ch));
    onClose();
  };

  // Open the full creation studio. On send, forward the created media; on
  // save-only / cancel, return to the picker and refresh the personal tray.
  const launchStudio = async (m: "sticker" | "gif") => {
    studioOpenRef.current = true;
    try {
      const media = await openStudio({ mode: m });
      if (media) {
        onPick(media);
        onClose();
      } else {
        setTab("mine");
        loadMine();
      }
    } finally {
      studioOpenRef.current = false;
    }
  };

  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (e.target) e.target.value = "";
    if (!files.length || !token) return;
    setErr("");
    setUploading(true);
    try {
      for (const f of files) {
        if (!/^image\//.test(f.type)) {
          setErr("Only images (PNG, GIF, WebP, JPEG) can be stickers.");
          continue;
        }
        if (f.size > 16 * 1024 * 1024) {
          setErr(`"${f.name}" is too large (16 MB max).`);
          continue;
        }
        await api.uploadSticker(token, f, f.type, f.name, f.type === "image/gif" ? "gif" : "sticker");
      }
      await loadMine();
    } catch (ex: any) {
      setErr(ex?.message || "Couldn't add that sticker.");
    } finally {
      setUploading(false);
    }
  };
  const removeMine = async (id: string, ev: React.MouseEvent) => {
    ev.stopPropagation();
    if (!token) return;
    setMine((prev) => (prev || []).filter((m) => m.id !== id));
    try {
      await api.deleteSticker(token, id);
    } catch {
      loadMine();
    }
  };

  const seg: any = { border: 0, background: "transparent", font: "inherit", fontSize: 12.5, fontWeight: 600, padding: "5px 11px", borderRadius: 7, cursor: "pointer", color: "var(--g600, #667)" };
  const segOn: any = { ...seg, background: "var(--sb, #fff)", color: "var(--g900, #111)", boxShadow: "0 1px 2px rgba(0,0,0,.08)" };

  const picker = (
    <div
      ref={rootRef}
      role="dialog"
      aria-label="Pick a GIF or sticker"
      style={{
        // Portaled to <body> + fixed against the anchor rect: no ancestor overflow
        // can clip it. z-index must clear the comms/global-chat sidebar (4100) and
        // handoff prompts (4200) — it's anchored to a button INSIDE that sidebar,
        // so a lower z made it render BEHIND the sidebar (only the overflow showed).
        position: "fixed",
        left: pos ? pos.left : 0,
        bottom: pos ? pos.bottom : 0,
        visibility: pos ? "visible" : "hidden",
        zIndex,
        width: pos ? pos.width : 360,
        maxHeight: pos ? pos.maxH : 430,
        display: "flex",
        flexDirection: "column",
        background: "var(--bg, #fff)",
        color: "var(--g900, #111)",
        border: "1px solid var(--g200, #e3e7ee)",
        borderRadius: 14,
        boxShadow: "0 18px 48px rgba(0,0,0,.28)",
        overflow: "hidden",
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 10px 8px" }}>
        <div style={{ display: "inline-flex", background: "var(--g100, #f1f3f8)", borderRadius: 9, padding: 2 }}>
          {onEmoji ? (
            <button style={tab === "emoji" ? segOn : seg} onClick={() => setTab("emoji")}>Emoji</button>
          ) : null}
          <button style={tab === "gif" ? segOn : seg} onClick={() => setTab("gif")}>GIFs</button>
          <button style={tab === "sticker" ? segOn : seg} onClick={() => setTab("sticker")}>Stickers</button>
          <button style={tab === "mine" ? segOn : seg} onClick={() => setTab("mine")}>Yours</button>
        </div>
        <button
          onClick={onClose}
          aria-label="Close"
          style={{ marginLeft: "auto", width: 26, height: 26, borderRadius: 7, border: "1px solid var(--g200,#e3e7ee)", background: "var(--sb,#fff)", color: "var(--g600,#667)", cursor: "pointer", lineHeight: 1 }}
        >
          ×
        </button>
      </div>

      {tab === "emoji" && onEmoji ? (
        <>
          <div style={{ padding: "0 10px 8px" }}>
            <input
              value={emojiQ}
              onChange={(e) => setEmojiQ(e.target.value)}
              placeholder="Search emoji…"
              aria-label="Search emoji"
              style={{ width: "100%", font: "inherit", fontSize: 13, padding: "7px 11px", borderRadius: 9, border: "1px solid var(--g200,#e3e7ee)", background: "var(--sb,#fff)", color: "var(--g900,#111)" }}
            />
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: "0 10px 6px" }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(8, 1fr)", gap: 2 }}>
              {(emojiQ.trim()
                ? searchEmojis(emojiQ).map((x) => x.char)
                : ALL_EMOJI_CHARS
              ).map((ch, i) => (
                <button
                  key={ch + i}
                  onClick={() => onEmoji(ch)}
                  style={{ aspectRatio: "1", border: 0, background: "none", borderRadius: 8, cursor: "pointer", fontSize: 21, lineHeight: 1 }}
                >
                  {ch}
                </button>
              ))}
            </div>
          </div>
        </>
      ) : tab === "mine" ? (
        <div style={{ flex: 1, overflowY: "auto", padding: "2px 10px 6px" }}>
          <input ref={fileRef} type="file" accept="image/*" multiple style={{ display: "none" }} onChange={onUpload} />
          {err ? <div style={{ fontSize: 11.5, color: "var(--red,#c0392b)", padding: "2px 2px 8px" }}>{err}</div> : null}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
            <button
              onClick={() => launchStudio("sticker")}
              style={{ aspectRatio: "1", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4, border: 0, borderRadius: 11, background: "var(--ac)", color: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 700 }}
            >
              <span style={{ fontSize: 20, lineHeight: 1 }}>🎨</span>
              Create
            </button>
            <button
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              style={{ aspectRatio: "1", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4, border: "1.5px dashed var(--g300, #c8d0dd)", borderRadius: 11, background: "var(--g50, #f8fafc)", color: "var(--g600,#667)", cursor: uploading ? "default" : "pointer", fontSize: 12, fontWeight: 600 }}
            >
              <span style={{ fontSize: 22, lineHeight: 1 }}>{uploading ? "…" : "+"}</span>
              {uploading ? "Adding" : "Add"}
            </button>
            {(mine || []).map((m) => (
              <div key={m.id} style={{ position: "relative" }}>
                <button
                  onClick={() => pickMine(m)}
                  title={m.name}
                  style={{ width: "100%", aspectRatio: "1", padding: 0, border: "1px solid var(--g150, var(--g200))", borderRadius: 11, overflow: "hidden", cursor: "pointer", background: "var(--g100,#f1f3f8)" }}
                >
                  {/* Animated sticker/GIF from a remote/same-origin URL —
                      next/image would freeze it and need remotePatterns. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={abs(m.url)} alt={m.name} loading="lazy" style={{ width: "100%", height: "100%", objectFit: "contain" }} />
                </button>
                <button
                  onClick={(ev) => removeMine(m.id, ev)}
                  aria-label="Remove sticker"
                  style={{ position: "absolute", top: 3, right: 3, width: 18, height: 18, borderRadius: "50%", border: 0, background: "rgba(0,0,0,.55)", color: "#fff", fontSize: 12, lineHeight: 1, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          {mine !== null && mine.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--g600,#667)", padding: "14px 4px 8px", textAlign: "center", lineHeight: 1.6 }}>
              Add your own stickers or GIFs — upload any image and reuse it any time.
            </div>
          ) : null}
        </div>
      ) : (
        <>
          {configured ? (
            <div style={{ padding: "0 10px 8px" }}>
              <input
                ref={inputRef}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={tab === "sticker" ? "Search stickers…" : "Search GIFs…"}
                style={{ width: "100%", font: "inherit", fontSize: 13, padding: "7px 11px", borderRadius: 9, border: "1px solid var(--g200,#e3e7ee)", background: "var(--sb,#fff)", color: "var(--g900,#111)" }}
              />
            </div>
          ) : null}
          <div style={{ flex: 1, overflowY: "auto", padding: "0 10px 6px" }}>
            {!configured ? (
              tab === "sticker" ? (
                // Keyless built-in sticker pack — never an empty tab, no key needed.
                <div>
                  <div style={{ fontSize: 11.5, color: "var(--g600,#667)", padding: "4px 2px 8px", textAlign: "center" }}>
                    Tap a sticker, or{" "}
                    <button onClick={() => launchStudio("sticker")} style={{ background: "none", border: 0, color: "var(--ac)", cursor: "pointer", font: "inherit", fontWeight: 700 }}>create your own</button>.
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6 }}>
                    {BUILTIN_STICKER_EMOJI.map((ch) => (
                      <button key={ch} onClick={() => pickBuiltin(ch)} style={{ aspectRatio: "1", border: 0, background: "var(--g100,#f1f3f8)", borderRadius: 10, cursor: "pointer", fontSize: 30, lineHeight: 1 }}>{ch}</button>
                    ))}
                  </div>
                </div>
              ) : (
                // No keyless GIF SEARCH exists — offer creation + the admin hint.
                <div style={{ textAlign: "center", padding: "16px 8px", lineHeight: 1.6 }}>
                  <div style={{ fontSize: 32, marginBottom: 6 }}>🎬</div>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>Make your own GIF</div>
                  <div style={{ fontSize: 12, color: "var(--g600,#667)", margin: "4px 0 12px" }}>Record a short clip and add text or emoji.</div>
                  <button onClick={() => launchStudio("gif")} style={{ border: 0, background: "var(--ac)", color: "#fff", fontWeight: 700, fontSize: 13, padding: "9px 18px", borderRadius: 10, cursor: "pointer" }}>Create a GIF</button>
                </div>
              )
            ) : loading && !items ? (
              <div style={{ fontSize: 12.5, color: "var(--g600,#667)", padding: "22px 8px", textAlign: "center" }}>Loading…</div>
            ) : items && items.length === 0 ? (
              <div style={{ fontSize: 12.5, color: "var(--g600,#667)", padding: "22px 8px", textAlign: "center" }}>
                {q.trim() ? "No results — try another search." : "No results."}
              </div>
            ) : (
              <div style={{ columnCount: 2, columnGap: 6 }}>
                {(items || []).map((it) => (
                  <button
                    key={it.id}
                    onClick={() => pickTenor(it)}
                    title={it.desc}
                    style={{ display: "block", width: "100%", marginBottom: 6, padding: 0, border: 0, borderRadius: 9, overflow: "hidden", cursor: "pointer", background: "var(--g100,#f1f3f8)", breakInside: "avoid" }}
                  >
                    {/* next/image would freeze these animated GIFs (needs
                        unoptimized) and require remotePatterns for the remote
                        GIPHY/Tenor URLs — a plain lazy <img> is correct here. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={it.preview || it.url} alt={it.desc || "GIF"} loading="lazy" style={{ display: "block", width: "100%", height: "auto" }} />
                  </button>
                ))}
              </div>
            )}
          </div>
          {configured ? (
            <div style={{ fontSize: 10.5, color: "var(--g500,#8a93a3)", textAlign: "right", padding: "4px 12px 8px" }}>
              Powered by {provider ? provider.toUpperCase() : "GIPHY"}
            </div>
          ) : null}
        </>
      )}
    </div>
  );

  return createPortal(picker, document.body);
}
