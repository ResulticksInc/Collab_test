// Plain-text preview the SENDER attaches to an end-to-end-encrypted message so
// the server can use it as the push-notification body (product decision,
// 22 Sep 2026: notification bodies are human-readable even for E2EE chats).
// The server never has the plaintext otherwise. It is sanitised again server
// side, used ONLY for the push body, never stored or echoed.
export const PUSH_PREVIEW_MAX = 140;

export function pushPreviewOf(text: unknown): string | undefined {
  const t = String(text ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, PUSH_PREVIEW_MAX);
  return t || undefined;
}

/** Preview for an encrypted attachment: caption if any, else the same hint the app shows. */
export function pushPreviewForFile(opts: { caption?: string | null; fileName?: string | null; voice?: boolean }): string | undefined {
  const cap = pushPreviewOf(opts.caption);
  if (cap) return cap;
  if (opts.voice) return "🎤 Voice message";
  const name = pushPreviewOf(opts.fileName);
  return name ? `📎 ${name}` : "📎 Attachment";
}
