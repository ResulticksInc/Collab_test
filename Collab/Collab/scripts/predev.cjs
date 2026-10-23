#!/usr/bin/env node
/*
 * predev — make `npm run dev` reliable from a cold machine, for BOTH a local
 * Docker MySQL and a remote / managed MySQL.
 *
 * It runs automatically before `npm run dev` (npm "pre" lifecycle hook) and
 * completes the full local setup checklist so the app Just Works:
 *
 *   1) free the frontend (3000) and backend (4000) ports if a stale dev
 *      server is still holding them,
 *   2) read .env to find the database the app will ACTUALLY use
 *      (DEMO_MODE picks DEMO_DATABASE_URL vs DATABASE_URL),
 *   3) if that DB is LOCAL:
 *        a) if something already answers on the port, use it (your own MySQL),
 *        b) otherwise start Docker's MySQL — and if the Docker ENGINE itself
 *           is not running yet (the #1 cause of ECONNREFUSED on a cold
 *           Windows/macOS machine), LAUNCH Docker Desktop automatically and
 *           wait for the engine to come up before `docker compose up -d db`.
 *           If the engine is still booting when we give up waiting, a small
 *           detached helper keeps watching and starts the db container the
 *           moment the engine is ready — no re-run of `npm run dev` needed;
 *      if that DB is REMOTE -> skip Docker entirely and TCP-probe the
 *      host:port so we fail fast with a clear message,
 *   4) print a clear setup checklist.
 *
 * The backend applies migrations + seed automatically on boot and (as of this
 * version) RETRIES FOREVER on "DB not up yet" errors, so the moment MySQL
 * appears the app connects by itself. Everything here is best-effort and never
 * blocks `dev`: if a step can't complete it prints a warning and lets the
 * backend surface its own boot status.
 *
 * Opt-outs / knobs (env):
 *   PREDEV_AUTOSTART_DOCKER=no          don't launch Docker Desktop for me
 *   PREDEV_DOCKER_START_TIMEOUT_MS=...  how long to wait for the engine (default 120000)
 */
const { execSync, spawn, spawnSync } = require("node:child_process");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");

const isWin = process.platform === "win32";
const isMac = process.platform === "darwin";
const log = (m) => console.log("[predev] " + m);
// Synchronous sleep without extra deps (Atomics.wait is allowed on Node's
// main thread). Avoids pulling the whole script into async just to pause.
const sleep = (ms) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// ---- .env (no dependency on dotenv) ---------------------------------------
function loadEnv() {
  const out = {};
  try {
    const txt = fs.readFileSync(path.join(process.cwd(), ".env"), "utf8");
    for (const raw of txt.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const k = line.slice(0, eq).trim();
      let v = line.slice(eq + 1).trim();
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      )
        v = v.slice(1, -1);
      out[k] = v;
    }
  } catch (_) {
    /* no .env yet — fall back to defaults below */
  }
  return out;
}
const pick = (env, k) => process.env[k] || env[k];
const truthy = (v) => /^(1|yes|true|on)$/i.test(String(v || "").trim());
const falsy = (v) => /^(0|no|false|off)$/i.test(String(v || "").trim());

// The DB URL the backend will use, honoring DEMO_MODE.
function effectiveDb(env) {
  const demo = truthy(pick(env, "DEMO_MODE"));
  const url =
    (demo && (pick(env, "DEMO_DATABASE_URL") || "")) ||
    pick(env, "DATABASE_URL") ||
    "mysql://colab:colab@localhost:3306/colab";
  let host = "localhost";
  let port = 3306;
  try {
    const u = new URL(url);
    host = u.hostname || host;
    port = Number(u.port) || 3306;
  } catch (_) {
    /* keep defaults */
  }
  return { demo, host, port };
}
const isLocalHost = (h) =>
  ["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(h);
// Node resolves "localhost" to ::1 first; Docker's port forwarding often only
// answers on IPv4, which shows up as a spurious ECONNREFUSED. Always probe
// IPv4 explicitly (mirrors database/src/bootstrap.ts).
const probeHost = (h) => (h === "localhost" ? "127.0.0.1" : h);

// ---- ports (cross-platform) -----------------------------------------------
function listenersOnPort(port) {
  try {
    if (isWin) {
      const out =
        spawnSync("netstat", ["-ano"], { encoding: "utf8" }).stdout || "";
      const pids = new Set();
      for (const line of out.split(/\r?\n/)) {
        if (line.includes(":" + port + " ") && /LISTENING/i.test(line)) {
          const parts = line.trim().split(/\s+/);
          const pid = parts[parts.length - 1];
          if (pid && pid !== "0") pids.add(pid);
        }
      }
      return [...pids];
    }
    const out =
      spawnSync("lsof", ["-ti", "tcp:" + port, "-sTCP:LISTEN"], {
        encoding: "utf8",
      }).stdout || "";
    return out.split(/\s+/).filter(Boolean);
  } catch (_) {
    return [];
  }
}
function killPid(pid) {
  if (isWin) spawnSync("taskkill", ["/F", "/PID", pid], { stdio: "ignore" });
  else spawnSync("kill", ["-9", pid], { stdio: "ignore" });
}
function freePort(port) {
  const pids = listenersOnPort(port);
  if (!pids.length) return;
  log("port " + port + " in use (pid " + pids.join(", ") + ") — freeing it");
  pids.forEach(killPid);
}

// ---- TCP reachability ------------------------------------------------------
function tcpOnce(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
    sock.connect(port, host);
  });
}
async function waitTcp(host, port, totalMs) {
  const start = Date.now();
  let dots = 0;
  while (Date.now() - start < totalMs) {
    if (await tcpOnce(host, port, 2500)) {
      if (dots) process.stdout.write("\n");
      return true;
    }
    process.stdout.write(
      "\r[predev] waiting for DB " +
        host +
        ":" +
        port +
        ".".repeat((dots++ % 3) + 1) +
        "   ",
    );
    sleep(1000);
  }
  process.stdout.write("\n");
  return false;
}

// ---- Docker: CLI vs ENGINE, auto-start, compose v2/v1 ----------------------
// "docker --version" succeeds even when the engine is down; "docker info"
// only succeeds when the engine is actually running. Distinguishing the two
// is what lets us print the RIGHT fix instead of a generic warning.
function dockerCliAvailable() {
  try {
    return (
      spawnSync("docker", ["--version"], { stdio: "ignore", timeout: 8000 })
        .status === 0
    );
  } catch (_) {
    return false;
  }
}
function dockerEngineUp() {
  try {
    return (
      spawnSync("docker", ["info"], { stdio: "ignore", timeout: 8000 })
        .status === 0
    );
  } catch (_) {
    return false;
  }
}
// Prefer compose v2 ("docker compose"); fall back to legacy v1 ("docker-compose").
function composeCommand() {
  try {
    if (
      spawnSync("docker", ["compose", "version"], {
        stdio: "ignore",
        timeout: 8000,
      }).status === 0
    )
      return ["docker", "compose"];
  } catch (_) {}
  try {
    if (
      spawnSync("docker-compose", ["--version"], {
        stdio: "ignore",
        timeout: 8000,
      }).status === 0
    )
      return ["docker-compose"];
  } catch (_) {}
  return null;
}

// Launch Docker Desktop without blocking and without stealing focus.
// Returns true if we managed to ASK it to start (not that the engine is up).
function launchDockerDesktop() {
  try {
    if (isWin) {
      const candidates = [
        process.env.ProgramFiles &&
          path.join(
            process.env.ProgramFiles,
            "Docker",
            "Docker",
            "Docker Desktop.exe",
          ),
        process.env["ProgramFiles(x86)"] &&
          path.join(
            process.env["ProgramFiles(x86)"],
            "Docker",
            "Docker",
            "Docker Desktop.exe",
          ),
        process.env.LOCALAPPDATA &&
          path.join(
            process.env.LOCALAPPDATA,
            "Programs",
            "Docker",
            "Docker",
            "Docker Desktop.exe",
          ),
        process.env.LOCALAPPDATA &&
          path.join(process.env.LOCALAPPDATA, "Docker", "Docker Desktop.exe"),
      ].filter(Boolean);
      const exe = candidates.find((p) => {
        try {
          return fs.existsSync(p);
        } catch (_) {
          return false;
        }
      });
      if (!exe) return false;
      // Start-Process returns immediately; single-quote-escape the path so
      // "C:\Program Files\..." (spaces!) survives the PowerShell command line.
      const r = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          "Start-Process -FilePath '" + exe.replace(/'/g, "''") + "'",
        ],
        { stdio: "ignore", timeout: 15000 },
      );
      return r.status === 0;
    }
    if (isMac) {
      // -g: don't bring the app to the foreground. App is "Docker.app"
      // (older) or "Docker Desktop.app" (newer) — try both.
      for (const app of ["Docker", "Docker Desktop"]) {
        const r = spawnSync("open", ["-g", "-a", app], {
          stdio: "ignore",
          timeout: 10000,
        });
        if (r.status === 0) return true;
      }
      return false;
    }
    // Linux: a daemon, not a desktop app. Try systemd without sudo (works if
    // the user has rights / it's socket-activated); otherwise just hint.
    const r = spawnSync("systemctl", ["start", "docker"], {
      stdio: "ignore",
      timeout: 10000,
    });
    return r.status === 0;
  } catch (_) {
    return false;
  }
}

function waitForDockerEngine(timeoutMs) {
  const start = Date.now();
  let dots = 0;
  while (Date.now() - start < timeoutMs) {
    if (dockerEngineUp()) {
      if (dots) process.stdout.write("\n");
      return true;
    }
    const secs = Math.round((Date.now() - start) / 1000);
    process.stdout.write(
      "\r[predev] waiting for the Docker engine to start (" +
        secs +
        "s)" +
        ".".repeat((dots++ % 3) + 1) +
        "   ",
    );
    sleep(2000);
  }
  process.stdout.write("\n");
  return false;
}

// If the engine is STILL booting when we stop waiting, don't lose the work:
// a tiny detached helper keeps polling (up to 10 min) and runs
// `docker compose up -d db` the moment the engine answers. Combined with the
// backend's retry-forever boot, the whole stack then connects by itself.
function deferComposeUpUntilEngineReady(compose) {
  try {
    const composeLine = compose.join(" ") + " up -d --remove-orphans db";
    const code =
      "const{execSync,spawnSync}=require('node:child_process');" +
      "const t=Date.now();" +
      "(function w(){" +
      "let up=false;" +
      "try{up=spawnSync('docker',['info'],{stdio:'ignore',timeout:8000}).status===0}catch(e){}" +
      "if(up){try{execSync(" +
      JSON.stringify(composeLine) +
      ",{stdio:'ignore',cwd:" +
      JSON.stringify(process.cwd()) +
      "})}catch(e){}return}" +
      "if(Date.now()-t<600000)setTimeout(w,3000)" +
      "})();";
    const child = spawn(process.execPath, ["-e", code], {
      detached: true,
      stdio: "ignore",
      cwd: process.cwd(),
      windowsHide: true,
    });
    child.unref();
    return true;
  } catch (_) {
    return false;
  }
}

function composeUpDb(compose) {
  try {
    log("starting MySQL: " + compose.join(" ") + " up -d db ...");
    execSync(compose.join(" ") + " up -d --remove-orphans db", {
      stdio: "inherit",
      timeout: 90000,
    });
    return true;
  } catch (e) {
    if (e && e.code === "ETIMEDOUT") {
      log(
        "WARNING: compose timed out pulling/starting the db — it may still finish in the background.",
      );
    } else {
      log(
        "WARNING: `" +
          compose.join(" ") +
          " up -d db` failed (see error above). " +
          "Common cause: another service is holding port 3306. " +
          "Inspect with: " +
          compose.join(" ") +
          " logs db",
      );
    }
    return false;
  }
}

function dockerDbReady(timeoutMs, compose) {
  const start = Date.now();
  let dots = 0;
  // Probe the compose SERVICE ("db"), NOT a hardcoded container name. The old
  // `docker exec colab-db …` broke the instant the project/container was renamed
  // (colab-db → collab-db): the exec failed every iteration, so every boot waited
  // out the FULL timeout (then a slow TCP fallback) instead of returning the moment
  // MySQL was ready. `docker compose exec db` resolves the right container whatever
  // it's named.
  const [bin, ...pre] = compose && compose.length ? compose : ["docker", "compose"];
  while (Date.now() - start < timeoutMs) {
    const r = spawnSync(
      bin,
      [
        ...pre,
        "exec",
        "-T",
        "db",
        "mysqladmin",
        "ping",
        "-h",
        "127.0.0.1",
        "-u",
        "colab",
        "-pcolab",
        "--silent",
      ],
      { encoding: "utf8", timeout: 8000 },
    );
    if (r.status === 0) {
      if (dots) process.stdout.write("\n");
      return true;
    }
    process.stdout.write(
      "\r[predev] waiting for MySQL" + ".".repeat((dots++ % 3) + 1) + "   ",
    );
    sleep(1000);
  }
  process.stdout.write("\n");
  return false;
}

// Orchestrates the whole "local DB via Docker" path. Returns true if the DB
// answered before we handed over to the dev servers.
async function ensureLocalDockerDb(host, port) {
  const h = probeHost(host);

  // 0) Something already serving the port? Then it's the user's own MySQL (or
  //    a previous container) — never fight it, never touch Docker.
  if (await tcpOnce(h, port, 1200)) {
    log(
      "a MySQL is already answering on " +
        h +
        ":" +
        port +
        " — using it (skipping docker compose).",
    );
    return true;
  }

  if (!dockerCliAvailable()) {
    log("Docker CLI not found on PATH.");
    log(
      "  -> Install Docker Desktop (https://www.docker.com/products/docker-desktop/),",
    );
    log(
      "     OR run your own MySQL 8 as colab/colab on " +
        host +
        ":" +
        port +
        " (see SETUP.md).",
    );
    log(
      "  The backend keeps retrying, so once a DB is up it connects by itself.",
    );
    return false;
  }

  const compose = composeCommand();
  if (!compose) {
    log(
      "WARNING: neither `docker compose` (v2) nor `docker-compose` (v1) is available — " +
        "update Docker Desktop, or start MySQL yourself.",
    );
    return false;
  }

  // 1) Engine down? That is THE classic cold-start failure ("docker compose"
  //    errors out, nothing listens on 3306). Start Docker Desktop ourselves.
  if (!dockerEngineUp()) {
    const autostart = !falsy(process.env.PREDEV_AUTOSTART_DOCKER);
    if (!autostart) {
      log(
        "Docker engine is not running (PREDEV_AUTOSTART_DOCKER=no — not launching it). " +
          "Start Docker Desktop, then the backend will connect automatically.",
      );
      deferComposeUpUntilEngineReady(compose);
      return false;
    }
    log("Docker engine is not running — launching Docker Desktop for you ...");
    const asked = launchDockerDesktop();
    if (!asked) {
      log(
        "WARNING: could not auto-launch Docker Desktop (not found in the usual " +
          "install locations). Please start it manually" +
          (process.platform === "linux"
            ? " (e.g. `sudo systemctl start docker`)"
            : "") +
          ".",
      );
      log(
        "  A background watcher will still `" +
          compose.join(" ") +
          " up -d db` the moment the engine appears.",
      );
      deferComposeUpUntilEngineReady(compose);
      return false;
    }
    const timeoutMs =
      Number(process.env.PREDEV_DOCKER_START_TIMEOUT_MS) || 120000;
    if (!waitForDockerEngine(timeoutMs)) {
      log(
        "Docker Desktop is taking longer than " +
          Math.round(timeoutMs / 1000) +
          "s to start — continuing without blocking you.",
      );
      log(
        "  A background watcher will start the db container as soon as the engine is ready,",
      );
      log("  and the backend will then connect automatically.");
      deferComposeUpUntilEngineReady(compose);
      return false;
    }
    log("Docker engine is up.");
  }

  // 2) Engine is up — start (or reuse) the MySQL container.
  if (!composeUpDb(compose)) return false;

  // 3) Wait for MySQL inside the container to accept connections. A FIRST
  //    boot initializes the datadir and can take a while on slow disks, so be
  //    generous — this returns the moment it's ready, so the happy path pays
  //    nothing.
  if (dockerDbReady(90000, compose)) return true;
  // mysqladmin probe failed (image variants, etc.) — fall back to a plain TCP
  // probe from the host before declaring failure.
  return waitTcp(h, port, 15000);
}

// ---- local LiveKit SFU: keep its secret in sync with .env ------------------
// The browser is handed LIVEKIT_SERVER_URL / LIVEKIT_WS_URL. When that's local,
// the SFU runs as a Docker container whose LIVEKIT_KEYS MUST equal the
// LIVEKIT_API_SECRET the backend signs tokens with. If they drift — e.g. the
// secret was rotated but the already-running container kept the old one — every
// call fails with "could not establish signal connection: invalid token …
// go-jose: error in cryptographic primitive" (an HMAC mismatch). The backend
// (tsx) picks up the new .env on restart, but a separately-started container
// does not. `docker compose up -d livekit` recreates the container whenever the
// resolved env changed, so running it on every `dev` keeps the two in lockstep.
function liveKitIsLocal(env) {
  const u = pick(env, "LIVEKIT_SERVER_URL") || pick(env, "LIVEKIT_WS_URL") || "";
  return /\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i.test(u);
}
function ensureLocalMedia(compose) {
  try {
    log(
      "syncing local media (livekit/minio/redis) with .env — recreates the " +
        "LiveKit container if the LIVEKIT secret changed (prevents 'invalid token')…",
    );
    execSync(compose.join(" ") + " up -d livekit minio redis", {
      stdio: "inherit",
      timeout: 120000,
    });
    return true;
  } catch (e) {
    log(
      "WARNING: couldn't sync local media (" +
        ((e && e.message) || e) +
        "). If calls fail with 'invalid token', run: " +
        compose.join(" ") +
        " up -d --force-recreate livekit",
    );
    return false;
  }
}

// ---- run -------------------------------------------------------------------
(async () => {
  const env = loadEnv();
  const fePort = Number(pick(env, "FRONTEND_PORT")) || 3002;
  const bePort = Number(pick(env, "BACKEND_PORT")) || 4000;
  const { demo, host, port } = effectiveDb(env);
  const local = isLocalHost(host);

  const lines = [];
  const mark = (ok, label) =>
    lines.push((ok ? "  \u2713 " : "  \u2717 ") + label);

  log("setup checklist starting…");
  freePort(fePort);
  mark(true, "frontend port " + fePort + " free");
  freePort(bePort);
  mark(true, "backend port " + bePort + " free");
  log(
    "DB target: " +
      host +
      ":" +
      port +
      (demo ? " (DEMO_MODE)" : "") +
      (local ? "  [local]" : "  [remote]"),
  );

  let dbReady = false;
  if (local) {
    dbReady = await ensureLocalDockerDb(host, port);
  } else {
    log("remote DB — skipping Docker; checking reachability…");
    dbReady = await waitTcp(probeHost(host), port, 15000);
  }
  mark(
    dbReady,
    dbReady
      ? "database reachable at " + host + ":" + port
      : "database NOT reachable at " +
          host +
          ":" +
          port +
          " (yet) — the backend retries until it appears; check .env / VPN / Docker if it never does",
  );

  // Keep the LOCAL LiveKit SFU's secret aligned with .env. This is the #1 cause
  // of "invalid token" call failures after a secret change: the backend picks up
  // the new .env secret on restart, but a separately-started LiveKit container
  // keeps the old one. Recreating it here (compose up -d) closes that gap so
  // `npm run dev` always has a backend + SFU that agree on the secret.
  if (liveKitIsLocal(env) && dockerCliAvailable() && dockerEngineUp()) {
    const compose = composeCommand();
    if (compose) {
      const ok = ensureLocalMedia(compose);
      mark(
        ok,
        ok
          ? "local LiveKit/minio/redis synced with .env (secrets in lockstep)"
          : "local LiveKit sync skipped — see warning above",
      );
    }
  }

  console.log("\n[predev] setup checklist:");
  for (const l of lines) console.log(l);
  console.log(
    "  \u2022 backend applies migrations + seed automatically on boot",
  );
  console.log(
    "  \u2022 launching backend (:" +
      bePort +
      ") + frontend (:" +
      fePort +
      ") …\n",
  );
})().catch((e) => {
  // predev must NEVER block dev — log and let the dev servers start.
  console.error("[predev] non-fatal:", (e && e.message) || e);
});
