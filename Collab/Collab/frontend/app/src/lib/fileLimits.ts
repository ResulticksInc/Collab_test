// Platform-aware attachment limits. Desktop app gets the advantage.
export const isDesktopApp =
  typeof window !== "undefined" &&
  !!(window as any).collabDesktop;
// Inline (rendered) attachment cap. Over this → uploaded + sent as a Collab link.
export const INLINE_MAX = isDesktopApp ? 500 * 1024 * 1024 : 100 * 1024 * 1024;
// Absolute ceiling (matches backend/nginx/caddy 2GB). Over this → rejected.
export const HARD_MAX = 2 * 1024 * 1024 * 1024;
export function humanBytes(n: number): string {
  if (!n || n < 0) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}
