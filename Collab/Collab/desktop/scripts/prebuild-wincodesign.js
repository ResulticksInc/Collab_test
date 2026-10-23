// Windows build prerequisite — seed electron-builder's winCodeSign cache.
//
// WHY: electron-builder's exe-stamping (rcedit) downloads winCodeSign-2.6.0.7z,
// which contains macOS `.dylib` SYMLINKS. Extracting a symlink on Windows needs
// the "Create symbolic links" privilege (Developer Mode ON, or an elevated/admin
// shell). On a standard, non-Developer-Mode machine the build fails with
// "Cannot create symbolic link : A required privilege is not held by the client".
//
// FIX (no admin, no Developer Mode): pre-extract the archive INTO the cache while
// EXCLUDING the `darwin/` folder (the only symlinks; a Windows build never uses
// the macOS openssl libs). app-builder then finds winCodeSign already cached and
// skips its own symlink-laden extraction. On machines that DO have Developer Mode
// this script is a harmless no-op speed-up.
//
// Idempotent. Safe to run before every Windows build:  node scripts/prebuild-wincodesign.js

const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const { execFileSync } = require("child_process");

const VERSION = "winCodeSign-2.6.0";
const URL = `https://github.com/electron-userland/electron-builder-binaries/releases/download/${VERSION}/${VERSION}.7z`;
const CACHE_ROOT = path.join(os.homedir(), "AppData", "Local", "electron-builder", "Cache", "winCodeSign");
const SEED_DIR = path.join(CACHE_ROOT, VERSION);
const MARKER = path.join(SEED_DIR, "rcedit-x64.exe");

function find7za() {
  // 7zip-bin is a transitive dep of electron-builder, hoisted to the repo root.
  const candidates = [
    path.resolve(__dirname, "../../node_modules/7zip-bin/win/x64/7za.exe"),
    path.resolve(__dirname, "../node_modules/7zip-bin/win/x64/7za.exe"),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error("7za.exe not found (install deps first: npm install)");
}

function download(url, dest, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (redirects <= 0) return reject(new Error("too many redirects"));
        res.resume();
        return resolve(download(res.headers.location, dest, redirects - 1));
      }
      if (res.statusCode !== 200) return reject(new Error("HTTP " + res.statusCode + " for " + url));
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on("finish", () => out.close(resolve));
      out.on("error", reject);
    }).on("error", reject);
  });
}

async function main() {
  if (process.platform !== "win32") {
    console.log("Not Windows — winCodeSign seed not needed.");
    return;
  }
  if (fs.existsSync(MARKER)) {
    console.log("✓ winCodeSign already seeded:", SEED_DIR);
    return;
  }
  const sevenZa = find7za();
  fs.mkdirSync(SEED_DIR, { recursive: true });
  const tmp7z = path.join(os.tmpdir(), `${VERSION}-${Date.now()}.7z`);
  console.log("Downloading", URL);
  await download(URL, tmp7z);
  console.log("Extracting (excluding darwin/ symlinks) →", SEED_DIR);
  // -x!darwin* skips the only symlink-bearing folder, so no symlink privilege is needed.
  execFileSync(sevenZa, ["x", tmp7z, "-x!darwin", "-o" + SEED_DIR, "-y"], { stdio: "ignore" });
  try { fs.unlinkSync(tmp7z); } catch {}
  if (!fs.existsSync(MARKER)) throw new Error("seed failed — rcedit-x64.exe missing after extract");
  console.log("✓ winCodeSign seeded:", SEED_DIR);
}

main().catch((e) => { console.error("prebuild-wincodesign failed:", e.message); process.exit(1); });
