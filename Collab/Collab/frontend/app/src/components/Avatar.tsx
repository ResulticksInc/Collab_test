import React from "react";
import { resolveMediaUrl } from "../lib/image";
import { presenceDotClass } from "../lib/presence";
import { IconPhone, IconVideo } from "../lib/icons";
// Renders from the backend's avatar shape: {kind:'user'|'icon', initials, color, avatarUrl, icon}
// Canonical presence→dot-class mapper (handles both self "auto/away/busy" and
// peer "on/away/off" vocabularies). See lib/presence.ts.
export const statusClass = presenceDotClass;
// Call/meeting groups are auto-tagged with an emoji marker (📞 / 📹). Render
// those as crisp Lucide glyphs instead of the OS emoji so the iconography
// matches the rest of the app. User-picked group emojis render unchanged.
const LUCIDE_ICON: Record<string, React.ComponentType<{ size?: number }>> = {
  "📞": IconPhone,
  "📹": IconVideo,
};
// One face inside the merged (call/meeting group) avatar.
function MosaicCell({ m, size }: { m: any; size: number }) {
  return (
    <span
      className="ca-cell"
      style={{ background: m.color || "#94A3B8", fontSize: Math.max(9, Math.round(size * 0.24)) }}
    >
      {m.initials || "?"}
      {m.avatarUrl ? (
        <img
          src={resolveMediaUrl(m.avatarUrl)}
          alt=""
          loading="lazy"
          decoding="async"
          onLoad={(e) => {
            e.currentTarget.style.opacity = "1";
          }}
          onError={(e) => {
            e.currentTarget.style.display = "none";
          }}
        />
      ) : null}
    </span>
  );
}

export default function Avatar({ avatar, size = 32 }) {
  const a = avatar || {};
  // Call/meeting group: merge the members' avatars (2–4 faces) into one disc —
  // halves for 2, a half + two quarters for 3, a 2×2 grid for 4.
  if (a.kind === "icon" && Array.isArray(a.members) && a.members.length >= 2) {
    const faces = a.members.slice(0, 4);
    return (
      <div
        className={"ca ca-mosaic ca-mosaic-" + faces.length}
        style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}
        aria-hidden="true"
      >
        {faces.map((m: any, i: number) => (
          <MosaicCell key={i} m={m} size={size} />
        ))}
      </div>
    );
  }
  if (a.kind === "icon") {
    const Glyph = LUCIDE_ICON[a.icon as string];
    // Lucide glyph inherits the tile's text colour (contrasts with the tinted
    // --b100 tile in every theme); emoji icons keep their own colours.
    return (
      <div className="gi" style={{ width: size, height: size }}>
        {Glyph ? <Glyph size={Math.round(size * 0.52)} /> : a.icon || "#"}
      </div>
    );
  }
  const fs = Math.round(size * 0.4);
  return (
    <div
      className="ca"
      style={{
        position: "relative",
        overflow: "hidden",
        background: a.color || "#94A3B8",
        width: size,
        height: size,
        fontSize: fs,
      }}
    >
      {a.initials || "?"}
      {a.avatarUrl ? (
        <img
          src={resolveMediaUrl(a.avatarUrl)}
          alt=""
          loading="lazy"
          decoding="async"
          width={size}
          height={size}
          // Fade the photo in over the initials placeholder once it has actually
          // decoded — avoids the harsh pop / late-resize feel when avatars stream
          // in at different times. Cached images fire onLoad immediately, so they
          // still appear effectively instantly.
          onLoad={(e) => {
            e.currentTarget.style.opacity = "1";
          }}
          onError={(e) => {
            e.currentTarget.style.display = "none";
          }}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
            opacity: 0,
            transition: "opacity .25s ease",
          }}
        />
      ) : null}
    </div>
  );
}
