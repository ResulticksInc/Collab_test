import { config, db } from "../platform";

// Resolves the effective GIF-search provider + key. Precedence:
//   1. the ACTIVE org's admin-set key (organizations.gif_api_key), if any
//   2. the deployment-wide env key (GIPHY_API_KEY)
//   3. { provider:"", key:"" } → not configured (the picker shows the keyless
//      built-in sticker pack + the create-your-own studio; search is off)
//
// No caching: a per-request indexed SELECT is cheap (searches are debounced +
// rate-limited), and reading fresh avoids both the "poison the cache on a
// transient DB error" and the "stale across horizontally-scaled instances"
// pitfalls — an admin-pasted key takes effect on the very next search everywhere.

export type GifConfig = { provider: "giphy" | ""; key: string };

export async function resolveGifConfig(orgId?: string | null): Promise<GifConfig> {
  if (orgId) {
    try {
      const c = (await (db as any).orgs.getGifConfig(orgId)) as { provider?: string; key?: string };
      if (c && c.key) return { provider: "giphy", key: c.key };
    } catch {
      /* DB hiccup → fall through to the env key */
    }
  }
  const envKey = config.media.giphyKey || "";
  if (envKey) return { provider: "giphy", key: envKey };
  return { provider: "", key: "" };
}
