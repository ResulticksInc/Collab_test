// Cross-browser, cross-context clipboard copy.
//
// `navigator.clipboard` exists only in a SECURE context (HTTPS / localhost) and
// recent browsers; calling it elsewhere throws or rejects. Several call sites used
// it directly, so a copy could silently fail (or throw) on plain-HTTP origins or
// older Safari/Firefox. This routes every copy through one helper that falls back
// to a hidden-textarea + execCommand("copy"), so "Copy" behaves the same in every
// browser. Returns true on success.
export async function copyText(text: string): Promise<boolean> {
  const s = String(text ?? "");
  try {
    if (
      typeof navigator !== "undefined" &&
      navigator.clipboard &&
      typeof navigator.clipboard.writeText === "function"
    ) {
      await navigator.clipboard.writeText(s);
      return true;
    }
  } catch (_) {
    /* fall through to the legacy path below */
  }
  try {
    if (typeof document === "undefined") return false;
    const ta = document.createElement("textarea");
    ta.value = s;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.left = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      ta.setSelectionRange(0, s.length);
    } catch (_) {
      /* some browsers don't allow setSelectionRange on textarea — select() is enough */
    }
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch (_) {
    return false;
  }
}
