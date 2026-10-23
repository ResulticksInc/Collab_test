// Generate native app icons from the brand SVG.
//   build/icon.svg  →  build/icon.png (1024), build/icon.ico (Windows),
//                       build/iconset PNGs, and notification icon.
//
// electron-builder derives macOS .icns from build/icon.png automatically; on
// Windows we ship an explicit multi-resolution .ico. Run from desktop/:
//   node scripts/gen-icons.js
//
// Requires: sharp, png-to-ico (installed in desktop/).

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const _pti = require("png-to-ico");
const pngToIco = typeof _pti === "function" ? _pti : _pti.default;

const ROOT = path.resolve(__dirname, "..");
const SVG = path.join(ROOT, "build", "icon.svg");
const BUILD = path.join(ROOT, "build");

async function main() {
  if (!fs.existsSync(SVG)) throw new Error("missing build/icon.svg");
  const svg = fs.readFileSync(SVG);

  // High-res master PNG — electron-builder uses this to derive .icns + Linux.
  const masterPng = path.join(BUILD, "icon.png");
  await sharp(svg, { density: 384 }).resize(1024, 1024, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toFile(masterPng);
  console.log("✓ build/icon.png (1024x1024)");

  // Windows .ico — pack the standard sizes Explorer/taskbar/installer use.
  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const tmp = [];
  for (const s of icoSizes) {
    const p = path.join(BUILD, `_ico_${s}.png`);
    await sharp(svg, { density: 384 }).resize(s, s, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toFile(p);
    tmp.push(p);
  }
  const icoBuf = await pngToIco(tmp);
  fs.writeFileSync(path.join(BUILD, "icon.ico"), icoBuf);
  tmp.forEach((p) => { try { fs.unlinkSync(p); } catch {} });
  console.log("✓ build/icon.ico (" + icoSizes.join(",") + ")");

  console.log("\nNote: macOS .icns is derived from build/icon.png by electron-builder.");
  console.log("If you build the mac target ON macOS, also run `iconutil` or let electron-builder convert icon.png.");
}

main().catch((e) => { console.error(e); process.exit(1); });
