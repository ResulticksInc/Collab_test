import { registry } from "./registry";
import { createDispatcher } from "./dispatch";
import { startStdio } from "./transports/stdio";
import { startHttp, startSse } from "./transports/sse";

// Public surface for embedding/tests.
export { registry, createDispatcher, startStdio, startHttp, startSse };

// CLI entrypoint. Default transport is stdio (desktop MCP clients); pass --http
// (alias --sse) for the multi-user HTTP server.
if (require.main === module) {
  const useHttp =
    process.argv.includes("--http") || process.argv.includes("--sse");
  if (useHttp) startHttp();
  else startStdio();
}
