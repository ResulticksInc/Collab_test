// Remote Control — native OS input injection (controlled side, Electron only).
// Uses @nut-tree-fork/nut-js (maintained robotjs successor, prebuilt N-API so no
// node-gyp at install). Loads lazily and degrades to a logged no-op if the
// native module is unavailable, so the desktop app NEVER crashes on a host where
// the binary is missing or input injection is OS-blocked (e.g. Wayland).
//
// See docs/REMOTE_CONTROL_ARCHITECTURE.md §3.

let nut = null;
let loadErr = null;
try {
  // eslint-disable-next-line global-require
  nut = require("@nut-tree-fork/nut-js");
  nut.mouse.config.mouseSpeed = 999999; // direct moves, no easing
  nut.keyboard.config.autoDelayMs = 0;
} catch (e) {
  loadErr = (e && e.message) || String(e);
}

const { screen } = require("electron");

function available() {
  return !!nut;
}

// The display the controlled user is SHARING (set by main.js from the screen
// picker's chosen source). Lets multi-monitor input land on the right monitor.
let _displayId = null;
function setDisplay(id) {
  _displayId = id != null ? String(id) : null;
}
function shareBounds() {
  if (_displayId) {
    const d = screen
      .getAllDisplays()
      .find((dd) => String(dd.id) === _displayId);
    if (d) return d.bounds;
  }
  return screen.getPrimaryDisplay().bounds; // fallback: primary monitor
}

// Normalized (0..1) over the shared surface → absolute screen pixels on the
// shared display.
function toPx(x, y) {
  const b = shareBounds();
  const cx = Math.max(0, Math.min(1, Number(x) || 0));
  const cy = Math.max(0, Math.min(1, Number(y) || 0));
  return {
    px: Math.round(b.x + cx * b.width),
    py: Math.round(b.y + cy * b.height),
  };
}

function btn(b) {
  if (!nut) return null;
  return b === "right"
    ? nut.Button.RIGHT
    : b === "middle"
      ? nut.Button.MIDDLE
      : nut.Button.LEFT;
}

// Named-key map (printable chars go through keyboard.type()).
function nutKey(ev) {
  if (!nut) return null;
  const K = nut.Key;
  const code = ev.code || "";
  const key = ev.key || "";
  const named = {
    Enter: K.Enter,
    NumpadEnter: K.Enter,
    Tab: K.Tab,
    Backspace: K.Backspace,
    Delete: K.Delete,
    Escape: K.Escape,
    ArrowLeft: K.Left,
    ArrowRight: K.Right,
    ArrowUp: K.Up,
    ArrowDown: K.Down,
    Home: K.Home,
    End: K.End,
    PageUp: K.PageUp,
    PageDown: K.PageDown,
    Space: K.Space,
    CapsLock: K.CapsLock,
    Insert: K.Insert,
  };
  if (named[code] !== undefined) return named[code];
  const fm = /^F(\d{1,2})$/.exec(key);
  if (fm && K["F" + fm[1]] !== undefined) return K["F" + fm[1]];
  return null;
}

async function withMods(ev, fn) {
  const mods = [];
  if (ev.mods) {
    if (ev.mods.ctrl) mods.push(nut.Key.LeftControl);
    if (ev.mods.alt) mods.push(nut.Key.LeftAlt);
    if (ev.mods.shift) mods.push(nut.Key.LeftShift);
    if (ev.mods.meta) mods.push(nut.Key.LeftSuper);
  }
  for (const m of mods) await nut.keyboard.pressKey(m);
  try {
    await fn();
  } finally {
    for (const m of mods.reverse()) await nut.keyboard.releaseKey(m);
  }
}

// ── Local user always wins ───────────────────────────────────────────────────
// Injected input moves the REAL OS cursor, so while a web participant is
// controlling this machine every physical mouse move was immediately overridden —
// the person who shared could not click "Stop sharing" or "Take back control"
// (the click lands wherever the controller's pointer last warped it). Detect the
// local user's own movement (the cursor is somewhere we did NOT put it) and
// ignore remote pointer/keyboard/wheel input for LOCAL_PRIORITY_MS afterwards.
// Button/key RELEASES always go through so nothing is left held down.
const LOCAL_PRIORITY_MS = 2000;
const LOCAL_MOVE_TOLERANCE_PX = 8;
let lastCursor = null; // cursor position right after our last injected move
let yieldUntil = 0;
let heldButtons = 0;
function cursorNow() {
  try {
    return screen.getCursorScreenPoint();
  } catch {
    return null;
  }
}
function noteLocalMovement() {
  if (!lastCursor) return;
  const c = cursorNow();
  if (!c) return;
  if (
    Math.abs(c.x - lastCursor.x) > LOCAL_MOVE_TOLERANCE_PX ||
    Math.abs(c.y - lastCursor.y) > LOCAL_MOVE_TOLERANCE_PX
  ) {
    yieldUntil = Date.now() + LOCAL_PRIORITY_MS;
    lastCursor = null;
  }
}
// Called when a session ends/starts so a stale yield can't swallow the next one.
function resetLocalPriority() {
  lastCursor = null;
  yieldUntil = 0;
  heldButtons = 0;
}

// Inject a single validated input event. Returns true if applied.
async function inject(ev) {
  if (!nut || !ev || typeof ev !== "object") return false;
  try {
    const isRelease = ev.k === "up" || (ev.k === "key" && ev.down === false);
    noteLocalMovement();
    const yielding = Date.now() < yieldUntil;
    if (yielding && !isRelease) return false; // local user is driving
    if (yielding && ev.k === "up" && heldButtons <= 0) return false;
    if (
      (ev.k === "move" ||
        ev.k === "down" ||
        ev.k === "up" ||
        ev.k === "click" ||
        ev.k === "dblclick") &&
      typeof ev.x === "number" &&
      typeof ev.y === "number" &&
      !yielding // a release during the yield must not warp the user's cursor
    ) {
      const { px, py } = toPx(ev.x, ev.y);
      await nut.mouse.setPosition(new nut.Point(px, py));
      lastCursor = cursorNow();
    }
    switch (ev.k) {
      case "move":
        break;
      case "down":
        await nut.mouse.pressButton(btn(ev.button));
        heldButtons++;
        break;
      case "up":
        await nut.mouse.releaseButton(btn(ev.button));
        heldButtons = Math.max(0, heldButtons - 1);
        break;
      case "click":
        await nut.mouse.click(btn(ev.button));
        break;
      case "dblclick":
        await nut.mouse.doubleClick(btn(ev.button));
        break;
      case "wheel":
        if (ev.dy)
          await (ev.dy > 0
            ? nut.mouse.scrollDown(Math.abs(ev.dy))
            : nut.mouse.scrollUp(Math.abs(ev.dy)));
        if (ev.dx)
          await (ev.dx > 0
            ? nut.mouse.scrollRight(Math.abs(ev.dx))
            : nut.mouse.scrollLeft(Math.abs(ev.dx)));
        break;
      case "key": {
        const nk = nutKey(ev);
        if (nk !== null) {
          await withMods(ev, async () => {
            if (ev.down) await nut.keyboard.pressKey(nk);
            else await nut.keyboard.releaseKey(nk);
          });
        } else if (ev.down && ev.key && ev.key.length === 1) {
          await withMods(ev, async () => {
            await nut.keyboard.type(ev.key);
          });
        }
        break;
      }
      default:
        return false;
    }
    return true;
  } catch {
    return false;
  }
}

module.exports = { available, inject, setDisplay, resetLocalPriority, loadErr: () => loadErr };
