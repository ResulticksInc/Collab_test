/** @type {import('next').NextConfig} */
const webpack = require("webpack");

// Next only auto-loads .env from this app directory, but CoLab keeps a single
// source of truth at the monorepo root. Load it here so root NEXT_PUBLIC_* config
// (API/socket URLs, feature flags like NEXT_PUBLIC_FEATURE_SIGNUP) reaches the
// client build. Existing process.env values win — this never overrides them.
(() => {
  const fs = require("fs");
  const path = require("path");
  try {
    const rootEnv = path.resolve(__dirname, "..", "..", ".env");
    for (const line of fs.readFileSync(rootEnv, "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
  } catch (_) {
    /* no root .env — fall back to built-in defaults in config.ts */
  }
})();

/**
 * @signalapp/libsignal-client uses node-gyp-build to load compiled Rust NAPI bindings.
 * These native modules cannot run in the browser and must never be included in client bundles.
 * See docs/RUNTIME_ROOT_CAUSE_REPORT.md for full analysis.
 *
 * Strategy: Use resolve.alias=false so webpack does not bundle Signal native code into
 * client-side output. At runtime, dynamic imports fail gracefully (caught by loadSignal()
 * try/catch in e2ee/manager.ts). E2EE is disabled by default; set
 * NEXT_PUBLIC_E2EE_ENABLED=true only when a browser-compatible Signal implementation
 * (e.g. WASM) is available.
 */

const nextConfig = {
  reactStrictMode: true,
  // BUILD RELIABILITY: `next build`'s "Collecting page data" step spawns parallel
  // worker processes to evaluate each route. Those workers intermittently crash
  // with "PageNotFoundError: Cannot find module for page: /X" (a different page
  // each run) — a nondeterministic worker race/OOM that FAILS the whole build.
  // In the deploy pipeline a failed build = a full outage (containers are torn
  // down before the build and only come back up on success). Serializing page
  // data collection into the main process (no worker threads, one CPU) removes
  // the race and lowers peak memory. Verified 3/3 clean builds (was 1/3).
  experimental: {
    workerThreads: false,
    cpus: 1,
  },
  // Lint is a SEPARATE gate (npm run lint:*), not a deploy blocker. Cosmetic
  // ESLint errors (e.g. react/no-unescaped-entities) must never fail a
  // production build / auto-deploy. TypeScript type errors STILL fail the build
  // (tsc runs during next build), so real bugs are caught.
  eslint: { ignoreDuringBuilds: true },
  // CRITICAL for realtime: socket.io's endpoint is "/socket.io/" (with a
  // trailing slash). Next's default trailing-slash handling 308-redirects
  // "/socket.io/?..." -> "/socket.io?..." (no slash), which then no longer
  // matches the "/socket.io/:path*" rewrite below — so the proxy breaks and the
  // socket can never connect (the recipient never receives calls/messages).
  // Disabling the redirect lets the rewrite match and the long-poll handshake
  // reach the backend. (HTTP /api worked already because it has no trailing
  // slash.) See lib/socket.ts for the matching polling-first transport order.
  skipTrailingSlashRedirect: true,
  // Reverse-proxy the API and realtime socket through the Next server so the
  // browser only ever talks to its own origin (see lib/config.ts: same-origin
  // base). This is what lets CoLab run on ANY host/port/device without a
  // per-host rebuild or CORS configuration:
  //   • /api/*        → backend REST (messages, files, avatars, public links)
  //   • /socket.io/*  → Socket.IO (HTTP long-poll AND WebSocket upgrade)
  // The backend address is server-side only (never shipped to the browser);
  // it defaults to localhost:4000 and is overridable for Docker/other hosts.
  // The app-shell HTML is statically optimized, so Next serves it with a default
  // `Cache-Control: s-maxage=31536000, stale-while-revalidate` — a ONE-YEAR cache.
  // Browsers then keep serving the stale page (which references the OLD hashed
  // CSS/JS chunks), so a fresh deploy doesn't appear until a manual hard-refresh.
  // Force the shell to revalidate every load (cheap 304 when unchanged, new HTML
  // right after a deploy). Content-hashed /_next/ assets are EXCLUDED so they keep
  // their immutable caching — their URLs change per build, so they're never stale.
  // /api/* is excluded too (the backend owns those responses' caching).
  async headers() {
    return [
      {
        source: "/((?!_next/|api/).*)",
        headers: [
          { key: "Cache-Control", value: "no-cache, must-revalidate" },
        ],
      },
      // iOS Universal Links. Apple's CDN fetches this file at install time and
      // REQUIRES application/json; the file has no extension (Apple's rule),
      // so Next would otherwise serve public/.well-known/apple-app-site-association
      // as application/octet-stream and iOS would silently ignore it. Pairs
      // with the Associated Domains entitlement in the Collab_mobile app and
      // with /.well-known/assetlinks.json for Android App Links (that one is a
      // .json file, so its type is already right). See docs/MOBILE_APP_LINKS.md.
      {
        source: "/.well-known/apple-app-site-association",
        headers: [
          { key: "Content-Type", value: "application/json" },
          { key: "Cache-Control", value: "public, max-age=3600" },
        ],
      },
      {
        source: "/.well-known/assetlinks.json",
        headers: [
          { key: "Content-Type", value: "application/json" },
          { key: "Cache-Control", value: "public, max-age=3600" },
        ],
      },
    ];
  },
  async rewrites() {
    // Use 127.0.0.1 (NOT "localhost") for the local default: Node resolves
    // "localhost" to IPv6 ::1 first, but the backend binds IPv4 (0.0.0.0:4000)
    // and is NOT on ::1 — so proxying to localhost:4000 hits "ECONNREFUSED
    // ::1:4000" (this broke the WebSocket upgrade proxy and made HTTP proxying
    // non-deterministic). 127.0.0.1 forces IPv4 and matches where the backend
    // actually listens. Docker/other hosts still override via BACKEND_INTERNAL_URL.
    const backend =
      process.env.BACKEND_INTERNAL_URL ||
      process.env.NEXT_PUBLIC_API_BASE_URL ||
      "http://127.0.0.1:4000";
    // LiveKit signalling. In production the edge can route /livekit straight to
    // THIS Next.js server (confirmed by an x-powered-by:Next.js 404 on
    // /livekit/rtc) — so the frontend must proxy /livekit to the LiveKit server,
    // exactly like /api and /socket.io. Strips the /livekit prefix (LiveKit
    // serves at /rtc). Overridable via LIVEKIT_INTERNAL_URL for non-docker hosts.
    const livekit =
      process.env.LIVEKIT_INTERNAL_URL || "http://livekit:7534";
    return [
      { source: "/api/:path*", destination: `${backend}/api/:path*` },
      { source: "/socket.io/:path*", destination: `${backend}/socket.io/:path*` },
      { source: "/livekit/:path*", destination: `${livekit}/:path*` },
      // Static marketing site, co-hosted at /site (files live in public/site/).
      // A bare directory path has no file, so serve its index.html for BOTH the
      // slashless and trailing-slash forms. NO redirect between them (a /site →
      // /site/ redirect self-loops because Next's source match is slash-tolerant);
      // instead the pages carry <base href="/site/"> so their RELATIVE asset +
      // download links resolve under /site/ regardless of which URL was entered.
      { source: "/site", destination: "/site/index.html" },
      { source: "/site/", destination: "/site/index.html" },
      { source: "/site/download", destination: "/site/download.html" },
    ];
  },
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
        crypto: false,
        os: false,
        assert: false,
        net: false,
        tls: false,
      };

      // Prevent webpack from bundling native Signal modules into client output.
      config.resolve.alias = {
        ...config.resolve.alias,
        "@signalapp/libsignal-client": false,
        "node-gyp-build": false,
      };

      config.plugins.push(
        new webpack.NormalModuleReplacementPlugin(/^node:/, (resource) => {
          resource.request = resource.request.replace(/^node:/, "");
        })
      );

      // Granular bundle splitting to keep initial chunk minimal (< 150KB)
      config.optimization = {
        ...config.optimization,
        splitChunks: {
          chunks: "all",
          cacheGroups: {
            default: false,
            vendors: false,
            framework: {
              name: "framework",
              chunks: "all",
              test: /(?<!node_modules.*)[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/,
              priority: 40,
              enforce: true,
            },
            livekit: {
              name: "livekit",
              test: /[\\/]node_modules[\\/](livekit-client)[\\/]/,
              chunks: "async",
              priority: 30,
              reuseExistingChunk: true,
            },
            tiptap: {
              name: "tiptap",
              test: /[\\/]node_modules[\\/](@tiptap|lowlight|highlight\.js)[\\/]/,
              chunks: "async",
              priority: 30,
              reuseExistingChunk: true,
            },
            commons: {
              name: "commons",
              minChunks: 2,
              priority: 20,
              reuseExistingChunk: true,
            },
          },
        },
      };
    }
    return config;
  },
};

// @next/bundle-analyzer is optional: ANALYZE=true npm run analyze
let withAnalyzer = (cfg) => cfg;
try {
  withAnalyzer = require("@next/bundle-analyzer")({
    enabled: process.env.ANALYZE === "true",
  });
} catch (_) {
  /* analyzer not installed in this environment */
}

// Cloudflare Workers build (CF_STATIC=1): the app is a client-only SPA shell, so it
// ships as a static export served by Workers Assets. Rewrites/headers are server
// features and don't exist in an export — the browser talks to the API host directly
// (NEXT_PUBLIC_API_BASE_URL / NEXT_PUBLIC_SOCKET_URL), and cache headers live in
// public/_headers. The default (Docker / next start) build is unchanged.
if (process.env.CF_STATIC === "1") {
  nextConfig.output = "export";
  nextConfig.images = { ...(nextConfig.images || {}), unoptimized: true };
  delete nextConfig.rewrites;
  delete nextConfig.headers;
  delete nextConfig.skipTrailingSlashRedirect;
}

module.exports = withAnalyzer(nextConfig);