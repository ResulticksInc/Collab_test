#!/usr/bin/env node
/*
 * free-port.cjs <port> [<port> ...]
 *
 * Kill whatever process is LISTENING on the given TCP port(s) before the dev
 * server tries to bind them, so `npm run dev:local` never dies with
 * `EADDRINUSE: address already in use 0.0.0.0:3002` from a stale/previous run.
 *
 * WHY IN NODE (not a shell one-liner): npm on Windows runs scripts through
 * cmd.exe, but this project is developed from Git Bash — a bash-only `lsof`/`fuser`
 * line would break in cmd. Running through `node` is shell-agnostic; the
 * platform branch below picks netstat+taskkill (Windows) or lsof+kill (POSIX).
 *
 * SAFETY:
 *   - Only targets the LISTEN-state owner of the EXACT port (not a process that
 *     merely holds a client connection to it, and not a look-alike port like
 *     13002 — the `:<port>` match is colon-anchored).
 *   - Never kills this helper's own PID.
 *   - A missing tool / no-match / probe error is a clean no-op: a free port must
 *     never fail the bootstrap. We only ever escalate to exit!=0 on nothing.
 */

const { execSync } = require("node:child_process");

const ports = process.argv
  .slice(2)
  .map((p) => parseInt(p, 10))
  .filter((p) => Number.isInteger(p) && p > 0 && p < 65536);

if (ports.length === 0) {
  console.log("[free-port] no valid port argument — nothing to do");
  process.exit(0);
}

const isWin = process.platform === "win32";

// Return the set of PIDs LISTENING on `port`. Empty set = port is free.
function pidsOnPort(port) {
  const pids = new Set();
  try {
    if (isWin) {
      // netstat cols (TCP): Proto | Local Address | Foreign Address | State | PID.
      // Detect listeners by the NUMERIC foreign-address wildcard (0.0.0.0:0 /
      // [::]:0 / *:*), NOT the "LISTENING" state word — netstat TRANSLATES that
      // word on non-English Windows (e.g. German "ABHÖREN"), which would make a
      // word match silently find nothing and fail to free the port. The wildcard
      // is locale-independent and also naturally excludes TIME_WAIT/ESTABLISHED
      // rows (those carry a real remote address). Local match is colon-anchored
      // (`:<port>`) so 13002/36002 can't masquerade as 3002; covers 0.0.0.0:P,
      // 127.0.0.1:P and [::]:P.
      const out = execSync("netstat -ano -p TCP", { encoding: "utf8" });
      for (const line of out.split(/\r?\n/)) {
        const cols = line.trim().split(/\s+/);
        if (cols.length < 5 || cols[0].toUpperCase() !== "TCP") continue;
        const local = cols[1];
        const foreign = cols[2];
        const pid = cols[cols.length - 1];
        const isListener = /^(0\.0\.0\.0:0|\[::\]:0|\*:\*)$/.test(foreign);
        if (isListener && local.endsWith(`:${port}`) && /^\d+$/.test(pid) && pid !== "0")
          pids.add(pid);
      }
    } else {
      // -t: PIDs only; -sTCP:LISTEN: listeners only; -nP: no DNS/port-name lookup.
      const out = execSync(`lsof -tiTCP:${port} -sTCP:LISTEN -nP`, {
        encoding: "utf8",
      });
      for (const pid of out.split(/\s+/)) if (/^\d+$/.test(pid)) pids.add(pid);
    }
  } catch {
    // Non-zero exit from netstat/lsof (typically "no match") or the tool being
    // absent → treat the port as free. Bootstrap must not fail over a probe.
  }
  return [...pids];
}

function kill(pid) {
  try {
    // /T also ends child processes (next dev spawns a worker); /F forces it.
    if (isWin) execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
    else execSync(`kill -9 ${pid}`, { stdio: "ignore" });
    return true;
  } catch {
    return false; // already gone / not permitted — nothing to do
  }
}

let killed = 0;
for (const port of ports) {
  for (const pid of pidsOnPort(port)) {
    if (String(pid) === String(process.pid)) continue; // never self-kill
    if (kill(pid)) {
      killed++;
      console.log(`[free-port] freed :${port} (stopped PID ${pid})`);
    }
  }
}
if (killed === 0) {
  console.log(`[free-port] port(s) ${ports.join(", ")} already free`);
}
process.exit(0);
