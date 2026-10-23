// Single source of truth for the per-user sent-bubble accent color (#12).
// This replaces the old chat-wallpaper feature: conversations now use a clean,
// plain background, and each user tints THEIR OWN sent bubbles with one of these
// colors. Shared by CoLabV1.applySettings (sets the global --me-bub CSS var) and
// the in-Settings live preview (applies the color inline to a mock sent bubble).
//
// "accent" (the default) means "follow the active theme accent" — it resolves to
// an empty string so callers fall back to var(--ac). Every other key is a literal
// hex chosen to read clearly with white bubble text on both light and dark themes.
export const BUBBLE_ACCENTS: Array<{ key: string; label: string; color: string }> = [
  { key: "accent", label: "Theme", color: "" }, // follow var(--ac)
  { key: "sky", label: "Sky Blue", color: "#0b93f6" },
  { key: "cobalt", label: "Cobalt", color: "#2563eb" },
  { key: "indigo", label: "Indigo", color: "#6366f1" },
  { key: "violet", label: "Violet", color: "#8b5cf6" },
  { key: "teal", label: "Teal", color: "#0d9488" },
  { key: "emerald", label: "Emerald", color: "#0f9d6f" },
  { key: "rose", label: "Rose", color: "#e11d6b" },
  { key: "amber", label: "Amber", color: "#d97706" },
  { key: "slate", label: "Slate", color: "#475569" },
  { key: "graphite", label: "Graphite", color: "#334155" },
];

// Resolve a bubbleAccent key to a CSS color. Returns "" for "accent"/unknown,
// which means "fall back to the theme accent (var(--ac))".
export function bubbleAccentColor(key = "accent"): string {
  const found = BUBBLE_ACCENTS.find((b) => b.key === key);
  return found ? found.color : "";
}
