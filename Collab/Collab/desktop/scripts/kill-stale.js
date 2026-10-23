#!/usr/bin/env node
/**
 * Pre-launch cleanup: kill any STALE `npm run dev:desktop` Electron instance and
 * WAIT for it to fully exit before the fresh one starts.
 *
 * Why: main.js calls app.requestSingleInstanceLock(). When a previous dev
 * instance is still alive, relaunching (a) fires `second-instance` on the OLD
 * process — which shows/focuses the old, possibly-hung window — while the new one
 * continues in dev mode, and (b) leaves two instances fighting over the same
 * userData dir, which is the "Unable to move the cache / Access is denied /
 * quota database" spew you see on the second launch. Clearing the old process
 * AND waiting for its file handles to release guarantees the next launch is the
 * only instance and starts clean.
 *
 * Invoked inline from the `dev` script (not just as a predev hook) so it runs
 * every time regardless of npm's workspace pre/post-hook behavior.
 *
 * Safety: targets ONLY processes whose executable is THIS repo's electron binary
 * (resolved via `require("electron")`), so it can never touch VS Code, another
 * project's Electron dev app, or a packaged Collab.exe install. Best-effort — any
 * failure is logged and swallowed, and the script always exits 0 so `&& electron`
 * still runs.
 */
"use strict";

const { execFileSync } = require("node:child_process");

let electronPath = null;
try {
  // Required OUTSIDE Electron, the `electron` package exports the absolute path
  // to its binary as a string — the exact binary `electron . --dev` runs.
  const resolved = require("electron");
  if (typeof resolved === "string") electronPath = resolved;
} catch {
  /* electron not installed yet (fresh clone) — nothing to clean up */
}

if (!electronPath) {
  process.exit(0);
}

try {
  if (process.platform === "win32") {
    // Match by FULL executable path so only this repo's dev Electron is killed
    // (PowerShell string -eq is case-insensitive → correct for Windows paths).
    // Force-kill every matching process, then Wait-Process so the single-instance
    // lock and userData/cache handles are released before Electron relaunches.
    const p = electronPath.replace(/'/g, "''");
    const ps =
      "$p='" + p + "';" +
      "$ids=@(Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" " +
      "| Where-Object { $_.ExecutablePath -eq $p } | ForEach-Object { $_.ProcessId });" +
      "if ($ids.Count -gt 0) {" +
      "  foreach ($id in $ids) { try { Stop-Process -Id $id -Force -ErrorAction Stop } catch {} }" +
      "  try { Wait-Process -Id $ids -Timeout 6 -ErrorAction SilentlyContinue } catch {}" +
      "  Start-Sleep -Milliseconds 400;" +
      "  Write-Output $ids.Count;" +
      "}";
    const out = execFileSync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", ps],
      { encoding: "utf8" },
    );
    const n = parseInt((out || "").trim(), 10);
    console.log(
      n > 0
        ? "[dev:desktop] killed " + n + " stale Electron process(es) — starting fresh."
        : "[dev:desktop] no stale Electron instance — starting fresh.",
    );
  } else {
    // macOS / Linux: match this electron binary path in the process command line.
    // pkill exits non-zero when nothing matches — swallow that. Then pause briefly
    // so the OS releases the lock + userData handles before relaunch.
    let killed = false;
    try {
      execFileSync("pkill", ["-f", electronPath], { stdio: "ignore" });
      killed = true;
    } catch {
      /* no stale instance running */
    }
    if (killed) {
      try {
        execFileSync("sleep", ["0.4"], { stdio: "ignore" });
      } catch {
        /* sleep missing — negligible */
      }
    }
    console.log(
      killed
        ? "[dev:desktop] cleared stale Electron instance — starting fresh."
        : "[dev:desktop] no stale Electron instance — starting fresh.",
    );
  }
} catch (err) {
  // Best-effort: never block the dev launch if the cleanup itself fails.
  console.warn(
    "[dev:desktop] stale-instance cleanup skipped:",
    (err && err.message) || err,
  );
}

// Always succeed so the chained `&& electron . --dev` proceeds.
process.exit(0);
