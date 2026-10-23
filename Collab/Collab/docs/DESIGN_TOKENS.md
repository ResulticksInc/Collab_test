# Design tokens & shared primitives

Foundation layer for the Figma-driven redesign (Figma file "Collab-UI",
page `1477:10790`). Values are placeholders that mirror today's rendering;
retarget them to the Figma spec in ONE place and the primitives follow.

## Files

| File | Role |
|---|---|
| `frontend/app/src/styles/tokens.css` | Spacing / type / radius / motion scales, semantic colour aliases, dark×accent fix |
| `frontend/app/src/styles/ui.css` | Class-driven primitives: `.ui-btn`, `.ui-spinner`, `.ui-skel`, `.ui-empty`, `.cv-toast-stack` |
| `frontend/app/src/components/ui/` | `Button`, `Spinner` / `LoadingBlock`, `Skeleton` / `SkeletonRow`, `EmptyState` |
| `frontend/app/src/lib/breakpoints.ts` | `BP.sm 640 / md 980 / lg 1180` — the JS mirror of the CSS breakpoint reference |

Both stylesheets are imported after `v1.css` in `app/layout.tsx`; the legacy
tokens (`--g*`, `--ac`, `--r`, `--sh`, `--fs-body`…) remain valid and the
semantic aliases resolve onto them.

## Rules

- Semantic aliases (`--fg-*`, `--surface-*`, `--line-*`, `--accent*`) are
  declared on `body`, not `:root`. A `var()` alias is resolved where it is
  declared, and the theme classes override the palette on `<body>`; declaring
  aliases on `:root` freezes them to the light values.
- New / redesigned code uses tokens and the `ui/` primitives. Do not add raw
  colours, radii or spacing.
- `Btn` in `Modal.tsx` is a thin wrapper over `ui/Button` for legacy callers.
- Toasts are a queue (max 3, de-duplicated, click to dismiss) rendered in
  `.cv-toast-stack`. Fire one with `showToast(text, icon?)` from the session
  hooks, or `window.dispatchEvent(new CustomEvent("colab:toast", { detail }))`
  from code without React context.
- Use `BP` / `mqMax*` from `lib/breakpoints.ts` instead of new ad-hoc widths.

## Mapping to Figma (to fill in)

| Token group | Figma source | Status |
|---|---|---|
| Spacing scale | Auto-layout paddings / gaps | placeholder (4px base) |
| Type scale | Text styles | placeholder |
| Radius | Corner radii on components | placeholder |
| Colours | Colour styles / variables | placeholder (current brand purple) |
| Shadows | Effect styles | still `--sh/--shm/--shl` in v1.css |
