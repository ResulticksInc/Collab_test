import http from "node:http";
import { createDispatcher } from "../../dispatch";
import { config } from "../../config";
import { log } from "../../audit/logger";

// HTTP transport — the MULTI-USER path for remote AI clients. Each request
// carries its own `Authorization: Bearer <jwt>`, so one server process serves
// many users with full isolation (the token determines identity and the backend
// scopes every call). This is the enterprise deployment mode.
//
// Endpoints:
//   POST /mcp                — JSON-RPC (single message or batch array). Auth via
//                              Authorization header. Returns JSON-RPC response(s).
//   GET  /mcp/capabilities   — unauthenticated capability discovery (lists only).
//   GET  /healthz            — liveness.

const MAX_BODY = 16 * 1024 * 1024; // 16MB ceiling (covers base64 uploads).

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("Payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function bearer(req: http.IncomingMessage): string {
  const h = String(req.headers["authorization"] || "");
  return h.startsWith("Bearer ") ? h.slice(7).trim() : "";
}

export function startHttp(port = config.port) {
  const dispatcher = createDispatcher();

  const server = http.createServer(async (req, res) => {
    const origin = config.corsOrigin;
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader(
      "Access-Control-Allow-Headers",
      "authorization,content-type,x-colab-tenant",
    );
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (req.method === "OPTIONS") return res.writeHead(204).end();

    const url = (req.url || "").split("?")[0];

    if (req.method === "GET" && url === "/healthz") {
      res.setHeader("Content-Type", "application/json");
      return res.end(
        JSON.stringify({
          ok: true,
          server: config.name,
          version: config.version,
        }),
      );
    }

    // Unauthenticated discovery — capability lists carry NO user data.
    if (req.method === "GET" && url === "/mcp/capabilities") {
      const reg = dispatcher.registry;
      res.setHeader("Content-Type", "application/json");
      return res.end(
        JSON.stringify({
          serverInfo: { name: config.name, version: config.version },
          protocolVersion: config.protocolVersion,
          tools: reg.tools.map((t) => ({
            name: t.name,
            description: t.description,
            annotations: t.annotations,
          })),
          resources: reg.resources
            .filter((r) => !r.isTemplate)
            .map((r) => ({ uri: r.uri, name: r.name })),
          resourceTemplates: reg.resources
            .filter((r) => r.isTemplate)
            .map((r) => ({ uriTemplate: r.uri, name: r.name })),
          prompts: reg.prompts.map((p) => ({
            name: p.name,
            description: p.description,
          })),
        }),
      );
    }

    if (req.method === "POST" && url === "/mcp") {
      let body: string;
      try {
        body = await readBody(req);
      } catch {
        res.writeHead(413, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32600, message: "Payload too large" },
          }),
        );
      }
      let parsed: any;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "Parse error" },
          }),
        );
      }
      const auth = {
        token: bearer(req),
        tenantId: req.headers["x-colab-tenant"]
          ? String(req.headers["x-colab-tenant"])
          : undefined,
      };
      try {
        // Support JSON-RPC batches.
        const handleOne = (m: any) => dispatcher.handle(m, auth);
        const result = Array.isArray(parsed)
          ? (await Promise.all(parsed.map(handleOne))).filter(Boolean)
          : await handleOne(parsed);
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify(result ?? null));
      } catch (e) {
        log.error("http.unhandled", {
          msg: e instanceof Error ? e.message : String(e),
        });
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: parsed?.id ?? null,
            error: { code: -32603, message: "Internal server error" },
          }),
        );
      }
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  server.listen(port, () =>
    log.info("http.start", {
      port,
      baseUrl: config.baseUrl,
      tools: dispatcher.registry.tools.length,
    }),
  );
  return server;
}

// Backwards-compatible alias (the entrypoint historically called startSse).
export const startSse = startHttp;
