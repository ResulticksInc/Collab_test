#!/usr/bin/env node
/*
 * dev-demo — run the whole app on localhost:3002 with the FULL sample workspace.
 *
 *   npm run dev:demo
 *
 * What it does (never edits .env, never touches a remote database):
 *   1) makes sure a throwaway local MySQL 8 container (colab-dev-db, host port
 *      3307) is running, creating it + the colab_demo database on first use,
 *   2) starts the backend (:4000) and Next.js (:3002) with DEMO_MODE=yes pointed
 *      at that local DB. On boot the backend seeds the demo workspace whenever
 *      colab_demo is empty (users, DMs, groups, channels, tasks, meetings, ...),
 *   3) overrides the .env values that would otherwise send a local run at the
 *      edge/production config (NODE_ENV, DB_PROFILE, SSO, API base URL).
 *
 * Sign in with you@colab.app / demo1234 (also emily@, marcus@, priya@, david@,
 * lena@colab.app — same password).
 *
 * Re-seed from scratch:  npm run dev:demo -- --reset
 * Knobs (env): DEMO_DB_PORT (default 3307), DEMO_DB_CONTAINER (default colab-dev-db)
 */
const { spawn, spawnSync } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const CONTAINER = process.env.DEMO_DB_CONTAINER || "colab-dev-db";
const PORT = Number(process.env.DEMO_DB_PORT) || 3307;
const RESET = process.argv.includes("--reset");
const DOCKER = ["docker", "/usr/local/bin/docker", "/opt/homebrew/bin/docker"].find(
  (b) => spawnSync(b, ["--version"], { stdio: "ignore" }).status === 0,
);

const log = (m) => console.log("[dev-demo] " + m);
const sh = (args, opts = {}) =>
  spawnSync(DOCKER, args, { encoding: "utf8", ...opts });

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: "127.0.0.1" });
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
  });
}

async function ensureDb() {
  if (!DOCKER) {
    console.error("[dev-demo] Docker CLI not found. Install/start Docker Desktop, or run `npm run dev:json` for the file-based demo.");
    process.exit(1);
  }
  if (sh(["info"], { stdio: "ignore" }).status !== 0) {
    console.error("[dev-demo] Docker engine is not running — start Docker Desktop and retry.");
    process.exit(1);
  }
  if (RESET) {
    log(`--reset: removing ${CONTAINER}`);
    sh(["rm", "-f", "-v", CONTAINER]);
  }
  const state = sh(["inspect", "-f", "{{.State.Running}}", CONTAINER]);
  if (state.status !== 0) {
    if (await portOpen(PORT)) {
      console.error(`[dev-demo] port ${PORT} is already taken by something else — set DEMO_DB_PORT.`);
      process.exit(1);
    }
    log(`creating ${CONTAINER} (mysql:8 on :${PORT})`);
    const r = sh([
      "run", "-d", "--name", CONTAINER, "-p", `${PORT}:3306`,
      "-e", "MYSQL_ROOT_PASSWORD=colab", "-e", "MYSQL_DATABASE=colab",
      "-e", "MYSQL_USER=colab", "-e", "MYSQL_PASSWORD=colab",
      "mysql:8", "--log-bin-trust-function-creators=ON",
    ]);
    if (r.status !== 0) { console.error(r.stderr); process.exit(1); }
  } else if (state.stdout.trim() !== "true") {
    log(`starting ${CONTAINER}`);
    const r = sh(["start", CONTAINER]);
    if (r.status !== 0) { console.error(r.stderr); process.exit(1); }
  }
  // Wait for MySQL, then make sure colab_demo exists. It MUST be utf8mb4_0900_ai_ci
  // (migration 0068 fails on utf8mb4_unicode_ci with "Illegal mix of collations").
  log("waiting for MySQL...");
  const sql =
    "CREATE DATABASE IF NOT EXISTS colab_demo CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;" +
    "GRANT ALL ON colab_demo.* TO 'colab'@'%'; FLUSH PRIVILEGES;";
  for (let i = 0; i < 90; i++) {
    const r = sh(["exec", CONTAINER, "mysql", "-uroot", "-pcolab", "-e", sql], { stdio: "pipe" });
    if (r.status === 0) { log("MySQL ready, colab_demo present."); return; }
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.error("[dev-demo] MySQL did not become ready in time.");
  process.exit(1);
}

(async () => {
  await ensureDb();
  const env = {
    ...process.env,
    NODE_ENV: "development",
    DB_PROFILE: "",
    DEMO_MODE: "yes",
    DEMO_DATABASE_URL: `mysql://colab:colab@127.0.0.1:${PORT}/colab_demo`,
    NEXT_PUBLIC_SSO_ENABLED: "false",
    NEXT_PUBLIC_API_BASE_URL: "",
    NEXT_PUBLIC_SOCKET_URL: "http://127.0.0.1:4000",
    BACKEND_INTERNAL_URL: "http://127.0.0.1:4000",
    LIVEKIT_INTERNAL_URL: process.env.LIVEKIT_INTERNAL_URL || "http://127.0.0.1:7534",
  };
  // Free a stale dev server still holding the ports.
  spawnSync(process.execPath, [path.join(ROOT, "scripts", "free-port.cjs"), "3002"], { stdio: "ignore", cwd: ROOT });
  spawnSync(process.execPath, [path.join(ROOT, "scripts", "free-port.cjs"), "4000"], { stdio: "ignore", cwd: ROOT });

  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const kids = [
    spawn(npm, ["run", "dev:backend"], { cwd: ROOT, env, stdio: "inherit" }),
    spawn(npm, ["--workspace", "frontend/app", "run", "dev"], { cwd: ROOT, env, stdio: "inherit" }),
  ];
  const stop = () => kids.forEach((k) => { try { k.kill("SIGTERM"); } catch {} });
  process.on("SIGINT", () => { stop(); process.exit(0); });
  process.on("SIGTERM", () => { stop(); process.exit(0); });
  kids.forEach((k) => k.on("exit", (c) => { stop(); process.exit(c || 0); }));
  log("app → http://localhost:3002   login: you@colab.app / demo1234");
})();
