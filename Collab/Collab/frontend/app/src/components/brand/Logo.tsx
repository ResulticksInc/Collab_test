// Brand logo components — inline SVG React components for the supplied art in
// frontend/app/public/brand/*.svg. They replace <img src="/brand/…"> so the art can
// follow the app theme. Source files:
//   CollabIcon        <- collab-logo.svg          (square app tile, same art in both themes)
//   CollabLoadingMark <- collab-logo-loading.svg  (bare swoosh glyph)
//   CollabWordmark    <- collab-logo-text.svg     (the "Collab" lettering only, no tile)
//   CollabLogo        = CollabIcon + CollabWordmark side by side
// If the SVGs in public/brand change, update the path data below to match.
//
// THEMING (no JS, no context): the app marks dark mode with `body.dark` (set before
// first paint by the script in app/layout.tsx; OLED adds `dark` too). The wordmark
// and loading glyph are painted with the brand gradient on light surfaces and flip to
// solid white on dark ones via the `.cb-adapt` rule in styles/ui.css. The icon tile
// is the same on both. Pass theme="light" | "dark" to force a variant regardless of
// the app theme (e.g. a logo on a fixed dark banner); default "auto" follows the app.
//
// Gradient/clip ids are made unique per instance (useId) because several logos can be
// on screen at once and SVG ids are document-global.
import React, { useId } from "react";

export type BrandTheme = "auto" | "light" | "dark";

type BaseProps = {
  /** Rendered height in px (width follows the art's aspect ratio). Omit to size with CSS. */
  height?: number;
  className?: string;
  style?: React.CSSProperties;
  /** Accessible name. Omit (or pass "") for a decorative logo (aria-hidden). */
  title?: string;
  theme?: BrandTheme;
  onClick?: React.MouseEventHandler<SVGSVGElement>;
};

const useUid = () => useId().replace(/[^a-zA-Z0-9_-]/g, "");

function a11y(title?: string) {
  return title ? { role: "img" as const, "aria-label": title } : { "aria-hidden": true as const };
}

function dims(height: number | undefined, ratio: number) {
  return height ? { height, width: Math.round(height * ratio * 100) / 100 } : {};
}

// ── Icon ─────────────────────────────────────────────────────────────────────
// 100×100 app tile: purple gradient rounded square, white blossom, AI sparkle.
const ICON_RATIO = 1;

export function CollabIcon({ height, className, style, title, theme = "auto", onClick }: BaseProps) {
  const u = useUid();
  const iso: React.CSSProperties = { isolation: "isolate" };
  const overlay = (opacity: number): React.CSSProperties => ({ fill: "#fff", mixBlendMode: "overlay", opacity });
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 100 100"
      className={["cb-svg", className].filter(Boolean).join(" ")}
      data-theme={theme}
      style={style}
      onClick={onClick}
      {...dims(height, ICON_RATIO)}
      {...a11y(title)}
    >
      <defs>
        <radialGradient id={`${u}-g0`} cx="73.59" cy="32.92" fx="73.59" fy="32.92" r="54.36" gradientTransform="translate(-16.48 3.96) scale(1.07)" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#c600d9" />
          <stop offset=".67" stopColor="#75099e" />
          <stop offset="1" stopColor="#5a0d81" />
        </radialGradient>
        <radialGradient id={`${u}-g1`} cx="93.42" cy="493.58" fx="93.42" fy="493.58" r="19.51" gradientTransform="translate(223.63 -207.35) rotate(43.44) scale(.56)" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#fff" />
          <stop offset=".09" stopColor="#fff" stopOpacity=".84" />
          <stop offset=".23" stopColor="#fff" stopOpacity=".62" />
          <stop offset=".36" stopColor="#fff" stopOpacity=".43" />
          <stop offset=".5" stopColor="#fff" stopOpacity=".28" />
          <stop offset=".63" stopColor="#fff" stopOpacity=".15" />
          <stop offset=".76" stopColor="#fff" stopOpacity=".07" />
          <stop offset=".89" stopColor="#fff" stopOpacity=".02" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <filter id={`${u}-sh`} x="8" y="7" width="84" height="86" filterUnits="userSpaceOnUse">
          <feOffset dx="0" dy="0" />
          <feGaussianBlur result="blur" stdDeviation="2" />
          <feFlood floodColor="#000" floodOpacity=".35" />
          <feComposite in2="blur" operator="in" />
          <feComposite in="SourceGraphic" />
        </filter>
      </defs>
      <g style={iso}>
        <rect x="0" y="0" width="100" height="100" rx="20" ry="20" fill={`url(#${u}-g0)`} />
        <path d="M78.81,3.9c9.53,0,17.29,7.76,17.29,17.29v57.63c0,9.53-7.76,17.29-17.29,17.29H21.19c-9.53,0-17.29-7.76-17.29-17.29V21.19C3.9,11.65,11.65,3.9,21.19,3.9h57.63ZM80,0H20C9,0,0,9,0,20v60C0,91,9,100,20,100h60c11,0,20-9,20-20V20C100,9,91,0,80,0h0Z" style={overlay(0.25)} />
        <path d="M80,2c9.93,0,18,8.07,18,18v60c0,9.93-8.07,18-18,18H20c-9.93,0-18-8.07-18-18V20C2,10.07,10.07,2,20,2h60ZM80,0H20C9,0,0,9,0,20v60C0,91,9,100,20,100h60c11,0,20-9,20-20V20C100,9,91,0,80,0h0Z" style={overlay(0.9)} />
        <g style={{ mixBlendMode: "lighten" }}>
          <polygon points="72.84 28.04 80.66 34.57 73.77 27.06 80.3 19.25 72.79 26.14 64.98 19.61 71.87 27.11 65.34 34.93 72.84 28.04" fill={`url(#${u}-g1)`} />
          <path d="M74.75,28.49c.11.17.1.35-.02.48s-.31.14-.47.04c-1.13-.71-1.83-.71-2.95,0-.16.1-.34.09-.47-.04s-.13-.31-.03-.47c.71-1.12.69-1.84-.01-2.95-.1-.16-.09-.34.04-.47s.31-.13.47-.03c1.14.71,1.83.7,2.95,0,.16-.1.35-.09.47.03s.14.31.04.47c-.69,1.1-.73,1.82,0,2.94Z" fill="#fff" />
          <path d="M54.85,41.31c1.93-.82,3.72-2.48,5.13-4.14,3.12-3.69,5.61-9.21,4.9-14.14-.63-4.44-3.8-8.45-8.44-8.97-15.15-1.7-16.46,17.43-7.96,25.96,2.08,2.08,4.3,2.17,6.36,1.29ZM28.64,52.64c1.26.03,2.53-.01,3.79-.1,4.24-.3,11.54-1.17,11.75-6.72.13-3.35-1.67-6.4-3.59-9.04-3.68-5.06-10.09-10.28-16.78-8.83-2.33.5-4.44,1.84-6.05,3.59-2.63,2.86-4.32,7.37-3.51,11.26s3.54,6.94,7.21,8.46c2.27.94,4.72,1.31,7.19,1.38ZM85.48,47.93c1.22-3.65.18-8.47-2.58-10.86-2.93-2.53-6.85-2.18-10.18-.68-4.14,1.88-11.55,7.21-8.68,12.6,2.25,4.22,10.24,4.77,14.34,4.18,2.22-.32,4.49-1.18,5.88-2.94.53-.67.93-1.46,1.22-2.3ZM78.12,79.19c1.21-2.26,1.7-4.85,1.05-7.42-.71-2.82-2.63-5.19-4.75-7.18-2.41-2.26-5.15-4.16-8.11-5.63-2.67-1.33-6.44-3.25-9.26-1.28-1.44,1.01-2.23,2.73-2.58,4.45-.5,2.42-.51,4.96-.52,7.42-.02,3.77.44,7.5,2.51,10.75,2.95,4.65,8.94,6.9,14.19,5.19,3.11-1.01,5.9-3.37,7.48-6.29ZM39.34,81.63c1.06-.37,2.07-.91,2.97-1.59,1.92-1.46,3.32-3.53,4.22-5.76s1.33-4.63,1.53-7.04c.2-2.34.18-4.76-.71-6.93-.4-.98-1-1.92-1.87-2.53-1.39-.95-3.22-.91-4.88-.66-7.96,1.23-18.2,7.62-15.67,17,.94,3.48,3.7,6.42,7.11,7.58,2.35.8,4.96.74,7.29-.08Z" fill="#fff" />
        </g>
        <g filter={`url(#${u}-sh)`}>
          <path d="M84.64,25.04c-.09.44-.39.73-.8.75s-.74-.27-.83-.68c-.57-2.57-1.49-4.75-3.97-5.93-.93-.44-1.88-.74-2.89-.96-.42-.09-.71-.39-.73-.79-.01-.43.29-.75.72-.84,1.01-.22,1.96-.52,2.89-.96,1.37-.65,2.4-1.69,3.04-3.07.42-.91.71-1.84.92-2.82.09-.41.39-.71.8-.72s.74.27.83.68c.55,2.47,1.43,4.63,3.77,5.82.98.5,2.01.83,3.09,1.06.42.09.71.39.72.8s-.27.74-.68.83c-2.55.56-4.73,1.48-5.91,3.94-.44.92-.75,1.87-.97,2.9Z" fill="#fff" />
        </g>
      </g>
    </svg>
  );
}

// ── Loading mark (bare swoosh glyph) ─────────────────────────────────────────
const LOADING_D = "M56.7,53.8c.8,1.8,2.5,3.5,4.2,4.7,2.3,1.5,4.8,2.8,7.6,3.2,4.4.6,9.2-1.9,9.7-6.7,1.3-11.9-13.7-12.9-20.4-6.2-1.6,1.6-1.8,3.4-1.1,5ZM48,33.2c0,.8,0,1.6,0,2.4.2,2.4.3,5,1.4,7.1.9,1.8,1.8,2.6,3.8,2.7,1.4,0,2.6-.2,3.9-.8,3.2-1.6,6.3-4.3,8.3-7.3,1.5-2.3,2.4-5.2,1.8-7.9-.4-1.8-1.4-3.5-2.8-4.8-3.1-2.8-8.5-4.1-12-1.4-1.8,1.3-2.9,2.6-3.6,4.7-.6,1.7-.8,3.5-.9,5.3h0ZM51.7,77.8c.3,0,.7.2,1,.2,2.7.5,5.7-.2,7.5-2.2.7-.8,1.1-1.7,1.3-2.7.4-1.6,0-3.3-.6-4.8-1.3-3.2-5.8-9.6-10.1-7.3-1.6.8-2.2,2.6-2.7,4.3-.7,2.8-1.2,6.2-.1,9,.4,1,.9,1.9,1.7,2.5.6.5,1.2.8,2,1h0ZM27.1,72.1c1.4.8,3,1.2,4.6,1.1,2-.2,3.9-1.2,5.4-2.5,2.8-2.3,4.7-5.4,6.3-8.6,1.2-2.5,2.4-6-.7-7.7-1-.5-2.2-.7-3.3-.9-2.3-.3-4.7-.5-7-.3-3.4.3-7.4,1.7-9.1,4.9-1.5,2.5-2,5.4-1.1,8.2.7,2.3,2.3,4.2,4.3,5.5.2.1.4.2.6.4ZM25.1,41.7c1.2,3.5,4.7,5.7,8.5,6.4,3,.6,10.2,1.4,10.8-3,.5-3.2-1-6.7-2.7-9.5-1.3-2.1-3.1-4-5.3-5-5.6-2.5-11.8,2.3-11.8,8.2s.2,2,.5,2.8Z";
// Light surfaces paint the glyph with the brand gradient; dark surfaces use white.
const LOADING_GRADIENT = {
  x1: "10.26", y1: "62.83", x2: "86.69", y2: "26.94",
  stops: [["0", "#8b29be"], [".5", "#5a0d81"], ["1", "#381354"]] as [string, string][],
};

export function CollabLoadingMark({ height, className, style, title, theme = "auto", onClick }: BaseProps) {
  const u = useUid();
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 100 100"
      className={["cb-svg", className].filter(Boolean).join(" ")}
      data-theme={theme}
      style={style}
      onClick={onClick}
      {...dims(height, 1)}
      {...a11y(title)}
    >
      <defs>
        <linearGradient id={`${u}-lg`} gradientUnits="userSpaceOnUse" x1={LOADING_GRADIENT.x1} y1={LOADING_GRADIENT.y1} x2={LOADING_GRADIENT.x2} y2={LOADING_GRADIENT.y2}>
          {LOADING_GRADIENT.stops.map(([o, c]) => (
            <stop key={o} offset={o} stopColor={c} />
          ))}
        </linearGradient>
      </defs>
      <path className="cb-adapt" d={LOADING_D} fill={`url(#${u}-lg)`} />
    </svg>
  );
}

// ── Wordmark (lettering only) ────────────────────────────────────────────────
// The lockup file is 408.14×100 with the icon tile at the left; the lettering sits at
// x 110.9–404, y 10.9–89.1, so the viewBox crops to it (no tile).
const WM_VIEWBOX = "108 8 300 84";
const WM_RATIO = 300 / 84;
const WM_STOPS: [string, string][] = [["0", "#381354"], ["1", "#000"]];
const WM_LETTERS: { d: string; x1: string; y1: string; x2: string; y2: string }[] = [{"d": "M149.15,89.07c-11.05,0-20.19-3.65-27.43-10.96-7.24-7.31-10.86-16.42-10.86-27.33s3.62-20.02,10.86-27.32c7.24-7.31,16.38-10.96,27.43-10.96,6.64,0,12.8,1.57,18.46,4.72,5.66,3.15,10.1,7.38,13.32,12.69l-16.26,9.34c-1.4-2.59-3.48-4.63-6.24-6.14-2.76-1.5-5.86-2.25-9.28-2.25-5.87,0-10.61,1.84-14.21,5.51-3.6,3.67-5.4,8.48-5.4,14.42s1.8,10.75,5.4,14.42c3.6,3.67,8.34,5.51,14.21,5.51,3.43,0,6.52-.75,9.28-2.25,2.76-1.5,4.84-3.58,6.24-6.24l16.26,9.44c-3.22,5.39-7.64,9.63-13.27,12.74-5.63,3.11-11.8,4.67-18.51,4.67Z", "x1": "129.18", "y1": "70.46", "x2": "326.63", "y2": "-126.99"}, {"d": "M210.45,88.97c-7.76,0-14.37-2.68-19.83-8.03-5.45-5.35-8.18-11.91-8.18-19.67s2.73-14.32,8.18-19.67c5.45-5.35,12.06-8.02,19.83-8.02s14.46,2.68,19.88,8.02c5.42,5.35,8.13,11.91,8.13,19.67s-2.71,14.32-8.13,19.67c-5.42,5.35-12.05,8.03-19.88,8.03ZM210.45,72.19c3.08,0,5.61-1.01,7.6-3.04,1.99-2.03,2.99-4.65,2.99-7.87s-1-5.84-2.99-7.87c-1.99-2.03-4.53-3.04-7.6-3.04s-5.51,1.01-7.5,3.04c-1.99,2.03-2.99,4.65-2.99,7.87s1,5.84,2.99,7.87c1.99,2.03,4.49,3.04,7.5,3.04Z", "x1": "149.89", "y1": "121.86", "x2": "338.43", "y2": "-66.68"}, {"d": "M242.56,87.5V10.93h17.41v76.57h-17.41Z", "x1": "68.3", "y1": "232.18", "x2": "453.43", "y2": "-152.95"}, {"d": "M264.6,87.5V10.93h17.41v76.57h-17.41Z", "x1": "60.72", "y1": "261.8", "x2": "445.85", "y2": "-123.33"}, {"d": "M325.71,35.05h17.41v52.45h-17.41v-4.83c-3.57,4.2-8.53,6.29-14.89,6.29-6.99,0-12.85-2.64-17.57-7.92-4.72-5.28-7.08-11.87-7.08-19.77s2.36-14.49,7.08-19.77c4.72-5.28,10.58-7.92,17.57-7.92,6.36,0,11.33,2.1,14.89,6.29v-4.83ZM306.73,69.56c2.03,2.1,4.68,3.15,7.97,3.15s5.94-1.05,7.97-3.15c2.03-2.1,3.04-4.86,3.04-8.29s-1.01-6.19-3.04-8.29c-2.03-2.1-4.69-3.15-7.97-3.15s-5.94,1.05-7.97,3.15c-2.03,2.1-3.04,4.86-3.04,8.29s1.01,6.19,3.04,8.29Z", "x1": "175.47", "y1": "207.19", "x2": "383.08", "y2": "-.43"}, {"d": "M379.33,33.58c6.99,0,12.85,2.64,17.57,7.92,4.72,5.28,7.08,11.87,7.08,19.77s-2.36,14.49-7.08,19.77c-4.72,5.28-10.58,7.92-17.57,7.92-6.36,0-11.33-2.1-14.9-6.29v4.83h-17.41V14.07h17.41v25.8c3.57-4.2,8.53-6.29,14.9-6.29ZM367.48,69.56c2.03,2.1,4.68,3.15,7.97,3.15s5.94-1.05,7.97-3.15c2.03-2.1,3.04-4.86,3.04-8.29s-1.01-6.19-3.04-8.29c-2.03-2.1-4.69-3.15-7.97-3.15s-5.94,1.05-7.97,3.15c-2.03,2.1-3.04,4.86-3.04,8.29s1.01,6.19,3.04,8.29Z", "x1": "174.98", "y1": "244.57", "x2": "382.6", "y2": "36.96"}];

export function CollabWordmark({ height, className, style, title, theme = "auto", onClick }: BaseProps) {
  const u = useUid();
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={WM_VIEWBOX}
      className={["cb-svg", className].filter(Boolean).join(" ")}
      data-theme={theme}
      style={style}
      onClick={onClick}
      {...dims(height, WM_RATIO)}
      {...a11y(title)}
    >
      <defs>
        {WM_LETTERS.map((l, i) => (
          <linearGradient key={i} id={`${u}-w${i}`} gradientUnits="userSpaceOnUse" x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2}>
            {WM_STOPS.map(([o, c]) => (
              <stop key={o} offset={o} stopColor={c} />
            ))}
          </linearGradient>
        ))}
      </defs>
      {WM_LETTERS.map((l, i) => (
        <path key={i} className="cb-adapt" d={l.d} fill={`url(#${u}-w${i})`} />
      ))}
    </svg>
  );
}

// ── Lockup: icon + wordmark ──────────────────────────────────────────────────
export function CollabLogo({
  height = 36,
  gap = 9,
  className,
  style,
  title,
  theme = "auto",
}: BaseProps & { gap?: number }) {
  return (
    <span
      className={["cb-lockup", className].filter(Boolean).join(" ")}
      style={{ display: "inline-flex", alignItems: "center", gap, ...style }}
      {...(title ? { role: "img", "aria-label": title } : { "aria-hidden": true })}
    >
      <CollabIcon height={height} theme={theme} />
      {/* lettering is ~0.83 of the icon height in the supplied lockup */}
      <CollabWordmark height={Math.round(height * 0.84 * 100) / 100} theme={theme} />
    </span>
  );
}
