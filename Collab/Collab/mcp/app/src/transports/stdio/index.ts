import readline from "node:readline";
import { createDispatcher } from "../../dispatch";
import { config } from "../../config";
import { log } from "../../audit/logger";

// stdio transport — the standard launch mode for desktop MCP clients (e.g.
// Claude Desktop), one user per process. The client passes its bearer token via
// the COLAB_MCP_TOKEN environment variable at launch; a per-message `token`
// field may override it (useful for testing).
//
// PROTOCOL CHANNEL DISCIPLINE: stdout carries ONLY JSON-RPC responses. All logs
// go to stderr (see audit/logger). One JSON object per line in, one per line out.
export function startStdio() {
  const dispatcher = createDispatcher();
  log.info("stdio.start", {
    tools: dispatcher.registry.tools.length,
    baseUrl: config.baseUrl,
  });

  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: any;
    try {
      message = JSON.parse(trimmed);
    } catch {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        }) + "\n",
      );
      return;
    }
    const auth = {
      token: message.token || config.serverToken || "",
      tenantId: message.tenantId,
    };
    try {
      const response = await dispatcher.handle(message, auth);
      if (response) process.stdout.write(JSON.stringify(response) + "\n");
    } catch (e) {
      // handle() is designed not to throw, but guard the transport regardless.
      log.error("stdio.unhandled", {
        msg: e instanceof Error ? e.message : String(e),
      });
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id ?? null,
          error: { code: -32603, message: "Internal server error" },
        }) + "\n",
      );
    }
  });
  rl.on("close", () => log.info("stdio.close"));
}
