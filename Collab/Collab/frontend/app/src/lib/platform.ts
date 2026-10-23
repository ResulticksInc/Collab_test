// ─────────────────────────────────────────────────────────────────────────────
// Single source of truth for PLATFORM + FEATURE GATING.
//
// CoLab ships ONE frontend codebase to two audiences — the browser (web) and the
// Electron desktop app. This module is how a feature declares who it's for, so a
// change can be deployed web-only / app-only / both WITHOUT the two affecting
// each other. See docs/DEPLOYMENT_MODEL.md.
//
// Three independent gates (use the smallest that fits):
//   1. RUNTIME  — `isDesktopApp` / `isWeb`: the actual environment at run time.
//                 An app-only feature behind `isDesktopApp` is simply inert in
//                 the browser, so it is SAFE to ship in the shared bundle.
//   2. BUILD    — `BUILD_TARGET`: which deploy this bundle is for, when you run
//                 separate web vs desktop frontend builds for hard code isolation.
//   3. FLAG     — `flag("x")`: turn an in-progress feature on/off per build,
//                 without code changes (so unfinished work never reaches web).
//
// NEVER gate calls / meetings / LiveKit behind anything here — that path is
// platform-agnostic and protected. See the deploy doc's safety section.
// ─────────────────────────────────────────────────────────────────────────────

/** True only inside the Electron desktop shell (preload injects collabDesktop). */
export const isDesktopApp: boolean =
  typeof window !== "undefined" && !!(window as unknown as { collabDesktop?: unknown }).collabDesktop;

/** True in a normal browser tab. */
export const isWeb: boolean = !isDesktopApp;

/**
 * Which deploy this bundle was built for. Set NEXT_PUBLIC_BUILD_TARGET="web" or
 * "desktop" at build time ONLY when you ship separate web vs desktop frontends
 * (hard code isolation, e.g. to keep web frozen while the desktop frontend
 * iterates). Defaults to "all" — one shared build serves both.
 */
export const BUILD_TARGET: "web" | "desktop" | "all" =
  ((process.env.NEXT_PUBLIC_BUILD_TARGET as "web" | "desktop" | "all") || "all");

/**
 * Feature flags: a comma-separated NEXT_PUBLIC_FLAGS env, e.g.
 *   NEXT_PUBLIC_FLAGS="remoteControlV2,localAI"
 * Lets in-progress / channel-specific features be ON in one build (e.g. a
 * desktop-beta channel) and OFF in another (e.g. web prod) with no code change.
 */
const FLAGS: ReadonlySet<string> = new Set(
  (process.env.NEXT_PUBLIC_FLAGS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

/** Is a named feature flag enabled in this build? */
export function flag(name: string): boolean {
  return FLAGS.has(name);
}

/**
 * Best-effort client-environment summary for analytics payloads (e.g. the
 * post-call feedback #67). Derives platform / OS / browser from the same signals
 * the Diagnostics layer uses (isDesktopApp + navigator.userAgent) — a single
 * place, so we never re-parse the UA ad hoc across the app. On desktop the app
 * version + build come from the Electron preload (window.collabDesktop); on web
 * they are undefined. NEVER used for gating or authz — display/analytics only.
 */
export interface ClientEnv {
  platform: "web" | "desktop";
  os: string;
  browser: string;
  appVersion?: string;
  buildNumber?: string;
}

function parseOS(ua: string): string {
  if (/Windows NT 10/.test(ua)) return "Windows";
  if (/Windows/.test(ua)) return "Windows";
  if (/Mac OS X|Macintosh/.test(ua)) return "macOS";
  if (/Android/.test(ua)) return "Android";
  if (/iPhone|iPad|iPod/.test(ua)) return "iOS";
  if (/Linux/.test(ua)) return "Linux";
  return "Unknown";
}

function parseBrowser(ua: string): string {
  // Order matters — Edge/Opera/Brave masquerade as Chrome, so check them first.
  if (/Edg\//.test(ua)) return "Edge";
  if (/OPR\/|Opera/.test(ua)) return "Opera";
  if (/Firefox\//.test(ua)) return "Firefox";
  if (/Chrome\//.test(ua)) return "Chrome";
  if (/Safari\//.test(ua)) return "Safari";
  return "Unknown";
}

export function getClientEnv(): ClientEnv {
  const ua =
    typeof navigator !== "undefined" && navigator.userAgent
      ? navigator.userAgent
      : "";
  const cd =
    typeof window !== "undefined"
      ? (window as any).collabDesktop
      : null;
  // Desktop exposes its version at collabDesktop.version (and appInfo.version).
  const appVersion =
    (cd && (cd.version || (cd.appInfo && cd.appInfo.version))) || undefined;
  const buildNumber =
    (cd && (cd.buildNumber || (cd.appInfo && cd.appInfo.buildNumber))) ||
    undefined;
  return {
    platform: isDesktopApp ? "desktop" : "web",
    os: parseOS(ua),
    browser: isDesktopApp ? "Electron" : parseBrowser(ua),
    appVersion: appVersion ? String(appVersion) : undefined,
    buildNumber: buildNumber ? String(buildNumber) : undefined,
  };
}

export type Audience = "all" | "desktop" | "web";

/**
 * The one helper to gate a feature by audience (+ optionally a flag).
 *
 *   feature("desktop")              → app only; false in the browser
 *   feature("web")                  → web only
 *   feature("all", "remoteControl") → both, but only when the flag is on
 *
 * Build-target wins when set: a "web" build never enables a "desktop" feature
 * even if somehow run in Electron, and vice-versa — so separate builds can be
 * fully code-isolated.
 */
export function feature(audience: Audience = "all", requireFlag?: string): boolean {
  if (requireFlag && !flag(requireFlag)) return false;
  if (BUILD_TARGET === "web" && audience === "desktop") return false;
  if (BUILD_TARGET === "desktop" && audience === "web") return false;
  if (audience === "desktop") return isDesktopApp;
  if (audience === "web") return isWeb;
  return true;
}
