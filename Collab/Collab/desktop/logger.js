// Lightweight, dependency-free, local-only rotating logger for the main process.
//
// Why this exists: console.log/console.error are discarded in a packaged
// production app (no attached terminal), so field issues are undiagnosable.
// This writes timestamped, levelled entries to a rotating file under the OS
// userData dir. No external/cloud logging — everything stays on the machine.
//
//   Windows : %APPDATA%\Collab\logs\main.log
//   macOS   : ~/Library/Application Support/Collab/logs/main.log
//   Linux   : ~/.config/Collab/logs/main.log

const fs = require("fs");
const path = require("path");
const { app } = require("electron");

const MAX_SIZE = 1024 * 1024; // rotate at 1 MB
const MAX_FILES = 3; // main.1.log .. main.3.log (+ current) → ~4 MB ceiling

let logDir = null;
let logFile = null;

// Must be called once after app is ready and app.setName() has run, so the
// userData path resolves under "Collab". Before init, calls only hit console.
function init() {
  try {
    logDir = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(logDir, { recursive: true });
    logFile = path.join(logDir, "main.log");
    const v = (() => { try { return app.getVersion(); } catch { return "?"; } })();
    write("INFO", `=== Collab Desktop started — v${v} — ${process.platform} ${process.arch} — Electron ${process.versions.electron} ===`);
  } catch {
    logDir = null;
    logFile = null;
  }
}

function safeStringify(v) {
  if (v instanceof Error) return v.stack || `${v.name}: ${v.message}`;
  if (typeof v === "string") return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

// Shift main.2.log→main.3.log, main.1.log→main.2.log, main.log→main.1.log,
// dropping anything past MAX_FILES. Best-effort; never throws into a log call.
function rotateIfNeeded(size) {
  if (size < MAX_SIZE || !logDir || !logFile) return;
  try {
    const oldest = path.join(logDir, `main.${MAX_FILES}.log`);
    if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
    for (let i = MAX_FILES - 1; i >= 1; i--) {
      const src = path.join(logDir, `main.${i}.log`);
      const dst = path.join(logDir, `main.${i + 1}.log`);
      if (fs.existsSync(src)) fs.renameSync(src, dst);
    }
    if (fs.existsSync(logFile)) fs.renameSync(logFile, path.join(logDir, "main.1.log"));
  } catch {}
}

function write(level, ...args) {
  const line = `${new Date().toISOString()} [${level}] ${args.map(safeStringify).join(" ")}\n`;

  // Always mirror to console (visible in dev / when launched from a terminal).
  if (level === "ERROR") process.stderr.write(line);
  else process.stdout.write(line);

  if (!logFile) return;
  try {
    let size = 0;
    try { size = fs.statSync(logFile).size; } catch {}
    rotateIfNeeded(size);
    fs.appendFileSync(logFile, line);
  } catch {}
}

module.exports = {
  init,
  info: (...a) => write("INFO", ...a),
  warn: (...a) => write("WARN", ...a),
  error: (...a) => write("ERROR", ...a),
  getLogDir: () => logDir,
};
