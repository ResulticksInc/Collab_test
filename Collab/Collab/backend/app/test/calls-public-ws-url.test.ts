import { test, before } from "node:test";
import assert from "node:assert/strict";

// Unit test for routes/calls.ts publicWsUrl(): the browser-facing LiveKit
// signalling URL handed out with every call/meeting token. Pure — no DB, no
// server. Covers the operator-override precedence AND the localhost exception
// (live stack run on a dev machine, opened at http://localhost:<port>).

let publicWsUrl: (req: any) => string | undefined;
let config: any;

const req = (headers: Record<string, any>, secure = false) => ({ headers, secure });

before(async () => {
  process.env.AUTH_JWT_SECRET = "test-secret-colab";
  process.env.LIVEKIT_API_KEY = "testkey";
  process.env.LIVEKIT_API_SECRET = "testsecret_at_least_32_characters_long_xx";
  process.env.LIVEKIT_WS_URL = "ws://localhost:7534";
  ({ config } = await import("../src/platform"));
  ({ publicWsUrl } = await import("../src/routes/calls"));
});

test("explicit public LIVEKIT_WS_URL wins for a real host", () => {
  config.livekit.wsUrl = "wss://collab.resulticks.com/livekit";
  assert.equal(
    publicWsUrl(req({ host: "collab.resulticks.com", "x-forwarded-proto": "https" })),
    "wss://collab.resulticks.com/livekit",
  );
  assert.equal(
    publicWsUrl(req({ host: "10.200.3.17:7524" })),
    "wss://collab.resulticks.com/livekit",
  );
});

test("localhost browser gets the same-origin /livekit proxy even with a public URL configured", () => {
  config.livekit.wsUrl = "wss://collab.resulticks.com/livekit";
  assert.equal(publicWsUrl(req({ host: "localhost:7524" })), "ws://localhost:7524/livekit");
  assert.equal(publicWsUrl(req({ host: "127.0.0.1:7524" })), "ws://127.0.0.1:7524/livekit");
  // nginx in front forwards the real proto; https page => wss
  assert.equal(
    publicWsUrl(req({ host: "localhost:7524", "x-forwarded-proto": "http" })),
    "ws://localhost:7524/livekit",
  );
  assert.equal(
    publicWsUrl(req({ host: "localhost:8443", "x-forwarded-proto": "https" })),
    "wss://localhost:8443/livekit",
  );
  // X-Forwarded-Host takes precedence over Host
  assert.equal(
    publicWsUrl(req({ host: "frontend:3000", "x-forwarded-host": "localhost:7524" })),
    "ws://localhost:7524/livekit",
  );
});

test("loopback LIVEKIT_WS_URL is derived behind a TLS proxy, kept on plain http", () => {
  config.livekit.wsUrl = "ws://localhost:7534";
  assert.equal(
    publicWsUrl(req({ host: "collab.example.com", "x-forwarded-proto": "https" })),
    "wss://collab.example.com/livekit",
  );
  assert.equal(publicWsUrl(req({ host: "192.168.1.20:7530" })), "ws://localhost:7534");
  // local dev at localhost keeps working via the same-origin proxy too
  assert.equal(publicWsUrl(req({ host: "localhost:7524" })), "ws://localhost:7524/livekit");
});

test("blank LIVEKIT_WS_URL: derived when possible, otherwise undefined", () => {
  config.livekit.wsUrl = "";
  assert.equal(
    publicWsUrl(req({ host: "collab.example.com", "x-forwarded-proto": "https" })),
    "wss://collab.example.com/livekit",
  );
  assert.equal(publicWsUrl(req({ host: "collab.example.com" })), undefined);
});
