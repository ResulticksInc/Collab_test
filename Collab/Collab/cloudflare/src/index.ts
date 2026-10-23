// colab-edge: Cloudflare Worker in front of CoLab.
//
//   browser ──► Worker ──► Workers Assets        (the SPA, frontend/app/out)
//                      ├─► /api/edge/*           answered here from the External Data API (src/edgeApi.ts)
//                      ├─► /join/<token>         the exported guest-join page (/join/_, see below)
//                      └─► /api/*, /socket.io/*, /uploads/*   reverse-proxied to API_ORIGIN (src/upstream.ts)
//
// There is no backend container, no database driver, no DB gateway and no tunnel in this Worker.
// The application API (and its MySQL) lives on API_ORIGIN = https://collab-uat.resulticks.com.
import { handleEdgeApi, isEdgeApiRequest, type EdgeApiEnv } from "./edgeApi";
import { isProxiedPath, proxyToUpstream } from "./upstream";

interface Env extends EdgeApiEnv {
  ASSETS: Fetcher;
}

// The public meeting link is a dynamic Next route (/join/[token]). A static export cannot
// pre-render arbitrary tokens, so the build emits ONE placeholder page at /join/_ (see
// frontend/app/src/app/join/[token]/layout.tsx) and the page reads the real token from the
// browser URL. Serve that page for every /join/<token>; without this, Workers Assets'
// single-page-application fallback would hand guests the signed-in app shell instead.
const JOIN_PAGE_PATH = "/join/_";

function isJoinPage(url: URL): boolean {
  return /^\/join\/[^/]+\/?$/.test(url.pathname) && url.pathname !== JOIN_PAGE_PATH;
}

async function serveJoinPage(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  url.pathname = JOIN_PAGE_PATH;
  let res = await env.ASSETS.fetch(new Request(url.toString(), { method: "GET", headers: request.headers }));
  // html_handling may answer with a trailing-slash redirect depending on how the file was
  // exported (_.html vs _/index.html); follow it once so the guest gets the page, not a 3xx.
  const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
  if (location) {
    res = await env.ASSETS.fetch(new Request(new URL(location, url).toString(), { method: "GET", headers: request.headers }));
  }
  return res;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (isEdgeApiRequest(url)) return handleEdgeApi(request, env, ctx);
    if (isProxiedPath(url)) return proxyToUpstream(request, env);
    if (isJoinPage(url) && (request.method === "GET" || request.method === "HEAD")) return serveJoinPage(request, env);
    // Only /api, /socket.io, /uploads and /join run the Worker (wrangler.jsonc run_worker_first);
    // anything else that still lands here is an asset.
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
