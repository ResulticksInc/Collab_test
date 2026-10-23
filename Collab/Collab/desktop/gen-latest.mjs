#!/usr/bin/env node
// Generate the desktop download/update manifest (latest.json) from a directory of
// built installers — so version, per-OS URLs, and REAL file sizes never have to
// be hand-maintained. Uses same-origin "/desktop/<file>" URLs (the web app serves
// installers from its own public/desktop), matching DownloadModal + updater.js.
//
// Usage:  node gen-latest.mjs <distDir> [channel=stable]
// Then publish the installers + the written manifest to the served /desktop/ path
// (stable → latest.json, beta → latest-beta.json, dev → latest-dev.json).

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const dir = process.argv[2];
const channel = (process.argv[3] || "stable").toLowerCase();
if (!dir || !fs.existsSync(dir)) {
  console.error("usage: node gen-latest.mjs <distDir> [channel]");
  process.exit(1);
}

const files = fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile());
const url = (f) => "/desktop/" + encodeURIComponent(f); // same-origin; spaces → %20
const size = (f) => fs.statSync(path.join(dir, f)).size;
// AUDIT #13: SHA-256 of an installer, so the strict updater can hash-pin the
// downloaded bytes before executing them (tamper-evidence against a swapped file).
const sha256 = (f) =>
  crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, f))).digest("hex");
const find = (re) => files.find((f) => re.test(f));

const winInstaller = find(/setup .*\.exe$/i) || find(/\.exe$/i);
const winPortable = find(/portable .*\.exe$/i);
// Prefer the .pkg (what the in-app updater opens and what latest.json ships); fall back to .dmg.
const mac = find(/\.pkg$/i) || find(/\.dmg$/i);
const appimage = find(/\.appimage$/i);
const deb = find(/\.deb$/i);

// Version from a filename (…1.2.3…) or the desktop package.json as a fallback.
let version = "";
const anyName = [winInstaller, mac, appimage, deb].find(Boolean) || "";
const mv = anyName.match(/(\d+\.\d+\.\d+)/);
if (mv) version = mv[1];
if (!version) {
  try {
    version = JSON.parse(
      fs.readFileSync(new URL("./package.json", import.meta.url), "utf8"),
    ).version;
  } catch {}
}

const manifest = {
  version,
  url: winInstaller ? url(winInstaller) : "",
  // AUDIT #13: top-level digest for the flat `url` (older single-OS manifest shape).
  sha256: winInstaller ? sha256(winInstaller) : "",
  notes: `What's new in ${version} — the latest Collab desktop build.`,
  channels: {},
};
if (winInstaller) {
  manifest.channels.windows = { x64: { installer: url(winInstaller), size: size(winInstaller), sha256: sha256(winInstaller) } };
  if (winPortable) manifest.channels.windows.x64.portable = url(winPortable);
}
if (mac) manifest.channels.mac = { universal: { installer: url(mac), size: size(mac), sha256: sha256(mac) } };
if (appimage || deb) {
  manifest.channels.linux = { x64: {} };
  if (appimage) {
    manifest.channels.linux.x64.appimage = url(appimage);
    manifest.channels.linux.x64.appimageSize = size(appimage);
  }
  if (deb) {
    manifest.channels.linux.x64.deb = url(deb);
    manifest.channels.linux.x64.debSize = size(deb);
  }
}

const outName =
  channel === "beta" ? "latest-beta.json" : channel === "dev" ? "latest-dev.json" : "latest.json";
const outPath = path.join(dir, outName);
fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(`Wrote ${outPath}:\n${JSON.stringify(manifest, null, 2)}`);
