// Single source of truth for turning a presence value into a status-dot CSS
// class (.s-on / .s-aw / .s-bs, defined in v1.css). The app has TWO presence
// vocabularies that must map to the same colors:
//   • self status (manualPresence): "auto" | "away" | "busy"
//   • peer presence (server / PRESENCE_UPDATE socket): "on" | "away" | "off"
// Historically each render site had its own mapper that only understood
// "on"/"away" and dumped everything else — including the DEFAULT "auto"
// ("Active") — into s-bs (red/busy). That made "Active" users render as busy
// and let self/peer dots disagree. Route every dot through this one function.
export function presenceDotClass(p?: string | null): string {
  switch (String(p || "").toLowerCase()) {
    case "on":
    case "auto":
    case "active":
    case "online":
    case "available":
      return "s-on"; // green
    case "away":
    case "idle":
    case "brb": // Be right back — amber, like Away
      return "s-aw"; // amber
    case "busy":
    case "dnd":
      return "s-bs"; // red (Busy / Do not disturb)
    case "off":
    case "offline":
      return "s-off"; // grey/hollow — AUDIT P2 (#19): distinct from busy red
    default:
      // Unknown → treat as offline (grey), never the busy red.
      return "s-off";
  }
}
