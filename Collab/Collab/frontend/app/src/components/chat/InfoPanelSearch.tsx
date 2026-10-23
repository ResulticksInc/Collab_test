// InfoPanelSearch — search box at the top of the right-hand details panel (1:1 chats).
// Finds messages, images, files and links in this conversation; clicking a result
// jumps to the message (or opens the Files / Links tab).
import React, { useMemo, useState } from "react";
import { IconSearch, IconX, IconFile, IconLink } from "../../lib/icons";
import { mimeOf } from "../../lib/desktopFiles";

type Cat = "all" | "messages" | "images" | "files" | "links";
const CATS: [Cat, string][] = [
  ["all", "All"],
  ["messages", "Messages"],
  ["images", "Images"],
  ["files", "Files"],
  ["links", "Links"],
];

const plain = (html: string) => {
  try {
    const d = new DOMParser().parseFromString(html || "", "text/html");
    return ((d.body && d.body.textContent) || "").replace(/\s+/g, " ").trim();
  } catch {
    return String(html || "");
  }
};
const fname = (f: any) => String((f && (f.name || f.fileName || f.filename || f.originalName)) || "File");
const when = (iso: any) => {
  const d = iso ? new Date(iso) : null;
  if (!d || isNaN(d.getTime())) return "";
  return d.toLocaleDateString([], { day: "numeric", month: "short", year: "2-digit" });
};

export default function InfoPanelSearch({
  messages, infoFiles, infoLinks, onJump, onOpenTab,
}: {
  messages: any[]; infoFiles: any[] | null; infoLinks: any[] | null;
  onJump: (id: string) => void; onOpenTab: (t: string) => void;
}) {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<Cat>("all");
  const needle = q.trim().toLowerCase();

  const res = useMemo(() => {
    const msgs: any[] = [], imgs: any[] = [], files: any[] = [], links: any[] = [];
    if (!needle) return { msgs, imgs, files, links };
    const seen = new Set<string>();
    for (const m of Array.isArray(messages) ? messages : []) {
      if (!m || m.deleted) continue;
      const f = m.file;
      if (f) {
        const name = fname(f);
        if (name.toLowerCase().includes(needle)) {
          seen.add(String(f.id || m.id));
          const item = { id: m.id, name, at: m.createdAt, file: f };
          if (/^image\//.test(mimeOf(f))) imgs.push(item); else files.push(item);
        }
      }
      const t = plain(m.text);
      if (t && t.toLowerCase().includes(needle)) msgs.push({ id: m.id, text: t, at: m.createdAt });
    }
    // Older attachments the loaded message window may not include.
    for (const f of infoFiles || []) {
      const name = fname(f);
      if (!name.toLowerCase().includes(needle) || seen.has(String(f.id))) continue;
      const item = { id: f.messageId, name, at: f.createdAt, file: f };
      if (/^image\//.test(mimeOf(f))) imgs.push(item); else files.push(item);
    }
    for (const l of infoLinks || []) {
      const url = String(l.url || l.href || "");
      const title = String(l.title || "");
      if ((url + " " + title).toLowerCase().includes(needle)) links.push({ id: l.messageId || l.id, url, title, at: l.createdAt });
    }
    return { msgs: msgs.reverse(), imgs: imgs.reverse(), files: files.reverse(), links };
  }, [needle, messages, infoFiles, infoLinks]);

  const counts: Record<Cat, number> = {
    all: res.msgs.length + res.imgs.length + res.files.length + res.links.length,
    messages: res.msgs.length, images: res.imgs.length, files: res.files.length, links: res.links.length,
  };
  const show = (c: Cat) => cat === "all" || cat === c;
  const hl = (s: string) => {
    const i = s.toLowerCase().indexOf(needle);
    if (i < 0 || !needle) return s;
    const a = Math.max(0, i - 24);
    return (
      <>
        {a > 0 ? "…" : ""}{s.slice(a, i)}<mark>{s.slice(i, i + needle.length)}</mark>{s.slice(i + needle.length, i + needle.length + 70)}
      </>
    );
  };
  const go = (id: any, tab: string) => (id ? onJump(String(id)) : onOpenTab(tab));

  return (
    <div className="ips">
      <div className="ips-box">
        <IconSearch size={15} />
        <input
          className="ips-in"
          autoFocus
          value={q}
          placeholder="Search messages, images, files…"
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search this conversation"
        />
        {q ? (
          <button className="ips-x" onClick={() => setQ("")} aria-label="Clear search"><IconX size={13} /></button>
        ) : null}
      </div>
      <div className="ips-chips" role="tablist">
        {CATS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={cat === k} className={"ips-chip" + (cat === k ? " on" : "")} onClick={() => setCat(k)}>
            {label}{needle && counts[k] ? <i>{counts[k]}</i> : null}
          </button>
        ))}
      </div>
      {needle ? (
        counts[cat] === 0 ? (
          <div className="ips-empty">No {cat === "all" ? "results" : cat} for “{q.trim()}”.</div>
        ) : (
          <div className="ips-list">
            {show("messages") && res.msgs.slice(0, 30).map((r) => (
              <button key={"m" + r.id} className="ips-row" onClick={() => go(r.id, "")}>
                <span className="ips-t">{hl(r.text)}</span><span className="ips-d">{when(r.at)}</span>
              </button>
            ))}
            {show("images") && res.imgs.slice(0, 30).map((r, i) => (
              <button key={"i" + i} className="ips-row" onClick={() => go(r.id, "files")}>
                <span className="ips-ic">🖼</span><span className="ips-t">{hl(r.name)}</span><span className="ips-d">{when(r.at)}</span>
              </button>
            ))}
            {show("files") && res.files.slice(0, 30).map((r, i) => (
              <button key={"f" + i} className="ips-row" onClick={() => go(r.id, "files")}>
                <span className="ips-ic"><IconFile size={14} /></span><span className="ips-t">{hl(r.name)}</span><span className="ips-d">{when(r.at)}</span>
              </button>
            ))}
            {show("links") && res.links.slice(0, 30).map((r, i) => (
              <button key={"l" + i} className="ips-row" onClick={() => go(r.id, "links")}>
                <span className="ips-ic"><IconLink size={14} /></span><span className="ips-t">{hl(r.title || r.url)}</span><span className="ips-d">{when(r.at)}</span>
              </button>
            ))}
          </div>
        )
      ) : (
        <div className="ips-hint">Searches this conversation’s loaded messages, images, files and links.</div>
      )}
    </div>
  );
}
