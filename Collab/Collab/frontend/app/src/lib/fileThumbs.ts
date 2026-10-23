// fileThumbs.ts — helpers for file LISTS (chat Files tab, Details media strip).
//
// Server file rows (`/conversations/:id/files`) are the raw stored attachment
// metadata: for an E2EE conversation that means no decryption key, so a list
// can't show a thumbnail on its own. The keys DO exist client-side — the
// E2EE manager attaches `_e2eeKey/_e2eeIv/_e2eeStream` to `message.file` when it
// decrypts a message. `fileKeyIndex` harvests those from the loaded messages and
// `withFileKeys` merges them into a list row, after which the normal blob hook
// (useFileBlob) can fetch + decrypt an image thumbnail exactly as a bubble does.
import { mimeOf } from "./desktopFiles";

export function fileKeyIndex(messages: any[] | null | undefined): Map<string, any> {
  const idx = new Map<string, any>();
  for (const m of messages || []) {
    const f = m && m.file;
    if (!f || !f.id) continue;
    if (f._e2eeKey || f.url) idx.set(String(f.id), f);
  }
  return idx;
}

export function withFileKeys(file: any, idx: Map<string, any>): any {
  const k = file && file.id ? idx.get(String(file.id)) : null;
  if (!k) return file;
  return {
    ...file,
    type: file.type || k.type,
    mime: file.mime || k.mime,
    url: file.url || k.url,
    e2ee: file.e2ee || k.e2ee,
    _e2eeKey: k._e2eeKey,
    _e2eeIv: k._e2eeIv,
    _e2eeStream: k._e2eeStream,
  };
}

/** True when a thumbnail can be produced: plain file, a ready URL, or a key. */
export function canDecryptFile(file: any): boolean {
  return !file?.e2ee || !!file?.url || !!file?._e2eeKey;
}

/** MIME for classification; falls back to the extension when the stored type
 *  is the opaque octet-stream an encrypted upload can carry. */
export function bestMime(file: any): string {
  const m = mimeOf(file);
  if (m && m !== "application/octet-stream") return m;
  return mimeOf({ name: file?.name || "" });
}

export function extOf(name: string | undefined | null): string {
  const n = String(name || "");
  const dot = n.lastIndexOf(".");
  const ext = dot >= 0 ? n.slice(dot + 1) : "";
  return ext.replace(/[^a-z0-9]/gi, "").slice(0, 4).toUpperCase();
}

// One accent colour per family; the chip background is a tint of it so it
// reads in light and dark themes alike.
const EXT_COLOR: Record<string, string> = {
  pdf: "#b91c1c",
  doc: "#1d4ed8", docx: "#1d4ed8", odt: "#1d4ed8", rtf: "#1d4ed8",
  xls: "#15803d", xlsx: "#15803d", csv: "#15803d", ods: "#15803d",
  ppt: "#c2410c", pptx: "#c2410c", key: "#c2410c", odp: "#c2410c",
  zip: "#374151", rar: "#374151", "7z": "#374151", gz: "#374151", tar: "#374151",
  txt: "#475569", md: "#475569", log: "#475569",
  mp4: "#6d28d9", mov: "#6d28d9", mkv: "#6d28d9", webm: "#6d28d9", avi: "#6d28d9",
  mp3: "#be185d", wav: "#be185d", m4a: "#be185d", ogg: "#be185d", aac: "#be185d", flac: "#be185d",
  png: "#0369a1", jpg: "#0369a1", jpeg: "#0369a1", gif: "#0369a1", webp: "#0369a1", svg: "#0369a1", heic: "#0369a1", bmp: "#0369a1",
  json: "#a16207", js: "#a16207", ts: "#a16207", html: "#a16207", css: "#a16207", py: "#a16207", xml: "#a16207",
};

export function extAvatar(name: string | undefined | null): { label: string; color: string } {
  const ext = extOf(name);
  const color = EXT_COLOR[ext.toLowerCase()] || "#4338ca";
  return { label: ext || "FILE", color };
}

// Brand art for the Office / PDF families (public/file-icons/*.svg). Anything
// else returns null and the caller falls back to the coloured extension avatar.
const TYPE_ICON: Record<string, string> = {
  doc: "word", docx: "word", dot: "word", dotx: "word", rtf: "word", odt: "word",
  xls: "xl", xlsx: "xl", xlsm: "xl", csv: "xl", ods: "xl",
  ppt: "ppt", pptx: "ppt", pps: "ppt", ppsx: "ppt", odp: "ppt",
  pdf: "pdf",
};

export function fileTypeIcon(name: string | undefined | null): string | null {
  const n = String(name || "");
  const dot = n.lastIndexOf(".");
  if (dot < 0) return null;
  const key = TYPE_ICON[n.slice(dot + 1).toLowerCase()];
  return key ? `/file-icons/${key}.svg` : null;
}
