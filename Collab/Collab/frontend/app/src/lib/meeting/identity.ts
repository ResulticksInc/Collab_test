// Participant identity helpers for meeting tiles and host controls.
//
// Extracted from MeetingStage. All pure functions — no React, no LiveKit — so
// they can be unit-tested and reused by the call dock and participant lists.

// Deterministic avatar initials + colour for camera-off tiles (Teams-style).
const TILE_COLORS = [
  "#6366f1",
  "#0ea5e9",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#ec4899",
  "#14b8a6",
];

export function initialsOf(name: string): string {
  return (
    (name || "?")
      .trim()
      .split(/\s+/)
      .map((w) => w[0])
      .slice(0, 2)
      .join("")
      .toUpperCase() || "?"
  );
}

// Same name always gets the same colour, so a person looks consistent across
// tiles, sessions and devices.
export function colorOf(key: string): string {
  let h = 0;
  for (let i = 0; i < (key || "").length; i++)
    h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return TILE_COLORS[h % TILE_COLORS.length];
}

// LiveKit identities are minted as `<userId>__<perJoinUUID>` (backend
// livekitService.makeIdentity), but host controls and role/hand comparisons need
// the BARE userId — the backend resolves the live `__<uuid>` identity from it.
// Strip the per-join suffix so mute/remove/promote/demote and the
// Host/Co-host/raised-hand labels match instead of silently no-opping.
export function baseUid(id?: string): string {
  const s = id || "";
  const i = s.indexOf("__");
  return i === -1 ? s : s.slice(0, i);
}

export { TILE_COLORS };

// Profile photo for a LiveKit participant. The backend puts the user's public,
// versioned avatar URL in the participant METADATA (livekitService.roomToken);
// LiveKit itself only carries identity + name, which is why tiles used to be
// initials-only. A participant on an older client/token has no metadata — fall
// back to the public per-user endpoint (it 404s when the user has no photo, and
// paintAvatar then simply leaves the initials showing).
export function avatarUrlOf(
  p: { metadata?: string; identity?: string } | null | undefined,
): string {
  if (!p) return "";
  let url: string | null | undefined;
  if (p.metadata) {
    try {
      const md = JSON.parse(p.metadata);
      if (md && "avatarUrl" in md) url = md.avatarUrl || "";
    } catch {
      /* not JSON — treat as absent */
    }
  }
  if (url === undefined) {
    const uid = baseUid(p.identity);
    url = uid ? `/api/public/users/${encodeURIComponent(uid)}/avatar` : "";
  }
  // Relative to the API origin — callers pass it through resolveMediaUrl.
  return url || "";
}

// Layer the photo OVER an initials circle (imperatively-built tiles). The
// initials stay underneath as the placeholder: the image fades in only once it
// has decoded and removes itself on error, so a missing photo costs nothing.
export function paintAvatar(el: HTMLElement | null, url: string): void {
  if (!el) return;
  const old = el.querySelector("img.pt-avatar-img") as HTMLImageElement | null;
  if (!url) {
    if (old) old.remove();
    return;
  }
  if (old && old.dataset.src === url) return;
  if (old) old.remove();
  const img = document.createElement("img");
  img.className = "pt-avatar-img";
  img.alt = "";
  img.decoding = "async";
  img.dataset.src = url;
  Object.assign(img.style, {
    position: "absolute",
    inset: "0",
    width: "100%",
    height: "100%",
    objectFit: "cover",
    borderRadius: "50%",
    opacity: "0",
    transition: "opacity .25s ease",
  });
  img.onload = () => {
    img.style.opacity = "1";
  };
  img.onerror = () => img.remove();
  if (!el.style.position) el.style.position = "relative";
  el.style.overflow = "hidden";
  el.appendChild(img);
  img.src = url;
}

// Server-signed role of a LiveKit participant ("host" | "co-host" |
// "participant"), from the token metadata. Participants cannot rewrite their own
// metadata, so this is safe to gate view-control messages (spotlight) on.
export function roleOf(p: { metadata?: string } | null | undefined): string {
  if (!p || !p.metadata) return "participant";
  try {
    const md = JSON.parse(p.metadata);
    return (md && typeof md.role === "string" && md.role) || "participant";
  } catch {
    return "participant";
  }
}

/**
 * Merged session avatar: the people in a call/meeting as ONE disc of 2–4
 * faces (the Avatar component's `members` mosaic — same look as the group
 * rows in the chat list). Others first (you recognise a call by who else is
 * in it), you last, capped at 4. Returns null with fewer than 2 people so the
 * caller can fall back to a single avatar.
 */
export function mergedAvatarOf(
  people: Array<{ name?: string; identity?: string; avatarUrl?: string | null; isLocal?: boolean }>,
): { kind: "icon"; icon: string; members: Array<{ initials: string; color: string; avatarUrl: string | null }> } | null {
  const list = (people || []).filter(Boolean);
  if (list.length < 2) return null;
  const ordered = [...list.filter((p) => !p.isLocal), ...list.filter((p) => p.isLocal)].slice(0, 4);
  return {
    kind: "icon",
    icon: "#",
    members: ordered.map((p) => {
      const nm = p.name || "Participant";
      return {
        initials: initialsOf(nm),
        color: colorOf(String(p.identity || "").split("__")[0] || nm),
        avatarUrl: p.avatarUrl || null,
      };
    }),
  };
}

/** Stable per-person gradient angle (90–270deg) so each camera-off tile's
 *  wash flows in its own direction — same person, same angle, every call. */
export function gradientAngleOf(key: string): number {
  let h = 0;
  for (let i = 0; i < (key || "").length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return 90 + (h % 180);
}

/**
 * Tile backdrop palette (light stop, deep stop), applied IN ORDER: the first
 * person to get a tile on this stage takes pair 1, the next pair 2, … cycling
 * after the last. The gradient STYLE cycles with the same index.
 */
export const TILE_PALETTE: ReadonlyArray<readonly [string, string]> = [
  ["#EDC1F3", "#7AA2EF"],
  ["#EBFDF5", "#60768D"],
  ["#E3ECFD", "#C6DCF2"],
  ["#C4CDF3", "#5D6AD7"],
  ["#F7CFDA", "#DB6E67"], // given as "#DB6E672" (7 digits) — read as #DB6E67
];

/**
 * Palette index for `key` — a pure hash of the person's identity, the SAME on
 * every viewer's screen and every device. (`scope` was a per-viewer "join
 * order on THIS stage" counter — removed: two viewers see participants join
 * in different orders, e.g. each sees themselves first, which is what colour
 * one person's tile inconsistently between browsers. A hash of the identity
 * itself has no viewpoint, so it can't disagree with itself.)
 */
export function tilePaletteIndexFor(_scope: HTMLElement | null | undefined, key: string): number {
  const n = TILE_PALETTE.length;
  let h = 0;
  for (let i = 0; i < (key || "").length; i++) h = (h * 33 + key.charCodeAt(i)) >>> 0;
  return h % n;
}

export function tilePaletteOf(key: string): readonly [string, string] {
  return TILE_PALETTE[tilePaletteIndexFor(null, key)];
}

/** Three gradient STYLES (call.css [data-tile-grad]): 1 = diagonal sweep,
 *  2 = radial glow, 3 = soft waves. Stable per person, independent of colour. */
export function gradientStyleOf(key: string): 1 | 2 | 3 {
  let h = 7;
  for (let i = 0; i < (key || "").length; i++) h = (h * 131 + key.charCodeAt(i)) >>> 0;
  return ((h % 3) + 1) as 1 | 2 | 3;
}

/** Apply a person's generated backdrop to a tile: --tile-a / --tile-b feed the
 *  camera-off gradient and the avatar disc, data-tile-grad picks the style
 *  (call.css). */
export function applyTilePalette(tile: HTMLElement, key: string, scope?: HTMLElement | null): void {
  const idx = tilePaletteIndexFor(scope, key);
  const [a, b] = TILE_PALETTE[idx];
  tile.style.setProperty("--tile-a", a);
  tile.style.setProperty("--tile-b", b);
  // Style cycles with the order too: 1st → sweep, 2nd → glow, 3rd → waves, …
  tile.dataset.tileGrad = String((idx % 3) + 1);
}
