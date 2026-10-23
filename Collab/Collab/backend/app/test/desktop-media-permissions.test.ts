import { test } from "node:test";
import assert from "node:assert/strict";
// Plain CommonJS, no electron import — that is why the policy lives in its own
// module instead of inside desktop/main.js.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createPermissionGate } = require("../../../desktop/mediaPermissions");

// Guards the desktop camera fix. The permission handler IS the whole policy in
// Electron, so both directions matter: too narrow broke SSO face verification
// ("Camera permission was blocked"), too wide hands the camera to any page the
// shell happens to load.

const APP = "https://collab.resulticks.com";
const IDP = "https://oa.re.cx";
const IDP2 = "http://10.200.1.58:7505";
const gate = createPermissionGate({ appOrigin: APP, authOrigins: [IDP, IDP2] });

test("THE BUG: the SSO page may use the camera for face verification", () => {
  assert.equal(gate.grant("media", IDP + "/verify"), true);
  assert.equal(gate.grant("media", IDP2 + "/mfa"), true);
});

test("our own app keeps camera, mic and screen capture", () => {
  assert.equal(gate.grant("media", APP + "/chat"), true);
  assert.equal(gate.grant("display-capture", APP + "/meeting/1"), true);
});

test("an IdP must NOT get screen capture — no sign-in flow needs it", () => {
  assert.equal(gate.grant("display-capture", IDP + "/verify"), false);
  assert.equal(gate.grant("display-capture", IDP2 + "/verify"), false);
});

test("an unrelated origin gets neither camera nor screen", () => {
  assert.equal(gate.grant("media", "https://evil.example/steal"), false);
  assert.equal(gate.grant("display-capture", "https://evil.example/steal"), false);
});

test("a look-alike origin does not match", () => {
  // Substring/suffix matching is the classic way this check gets broken.
  assert.equal(gate.grant("media", "https://oa.re.cx.evil.example/x"), false);
  assert.equal(gate.grant("media", "https://notoa.re.cx/x"), false);
  assert.equal(gate.grant("media", "http://oa.re.cx/x"), false, "scheme must match");
});

test("permissions outside the allow-list are always denied", () => {
  assert.equal(gate.grant("geolocation", APP + "/chat"), false);
  assert.equal(gate.grant("midi", APP + "/chat"), false);
  assert.equal(gate.grant("openExternal", APP + "/chat"), false);
});

test("benign permissions stay broadly granted, as before", () => {
  for (const p of ["fullscreen", "clipboard-read", "notifications", "pointerLock"]) {
    assert.equal(gate.grant(p, IDP + "/x"), true, p);
  }
});

test("an unparseable requester never gets camera or screen", () => {
  for (const bad of ["", "about:blank", "null", "not a url", undefined as any]) {
    assert.equal(gate.grant("media", bad), false, String(bad));
    assert.equal(gate.grant("display-capture", bad), false, String(bad));
  }
});

test("a broken app origin can't make every unparseable page match it", () => {
  const broken = createPermissionGate({ appOrigin: "not a url", authOrigins: [] });
  assert.deepEqual(broken.cameraOrigins, []);
  assert.equal(broken.grant("media", "about:blank"), false);
  assert.equal(broken.grant("media", "https://anything.example"), false);
  assert.equal(broken.grant("display-capture", "https://anything.example"), false);
});

test("no configured auth origins leaves the original app-only behaviour", () => {
  const alone = createPermissionGate({ appOrigin: APP });
  assert.deepEqual(alone.cameraOrigins, [APP]);
  assert.equal(alone.grant("media", APP + "/x"), true);
  assert.equal(alone.grant("media", IDP + "/x"), false);
});

test("junk entries in authOrigins are dropped, not treated as wildcards", () => {
  const g = createPermissionGate({ appOrigin: APP, authOrigins: ["", "   ", "nonsense", IDP] });
  assert.deepEqual(g.cameraOrigins, [APP, IDP]);
  assert.equal(g.grant("media", "https://random.example"), false);
});

test("paths and queries on the requester are ignored — only the origin counts", () => {
  assert.equal(gate.grant("media", IDP + "/a/b?c=d#e"), true);
  assert.equal(gate.grant("media", APP + "/deep/link?x=1"), true);
});

// ── Sub-frames (the second half of the desktop camera fix) ───────────────────
// Face-verification widgets are commonly served from another host inside an
// <iframe allow="camera"> on the IdP page. Electron reports the IFRAME's URL as
// the requester, so an origin-only rule refused it even after the IdP itself was
// allowed — same "Camera permission was blocked" message, different cause.

const WIDGET = "https://face.vendor.example";

test("THE BUG (2): a frame embedded by a trusted page may use the camera", () => {
  assert.equal(gate.grant("media", WIDGET + "/capture", { topUrl: IDP + "/verify" }), true);
  assert.equal(gate.grant("media", WIDGET + "/capture", { topUrl: APP + "/settings" }), true);
});

test("the embedding page is only consulted for camera/mic, never for screen capture", () => {
  assert.equal(gate.grant("display-capture", WIDGET + "/x", { topUrl: APP + "/meeting" }), false);
  assert.equal(gate.grant("display-capture", IDP + "/x", { topUrl: APP + "/meeting" }), false);
});

test("an untrusted top page cannot smuggle the camera to its frames — or itself", () => {
  assert.equal(gate.grant("media", WIDGET + "/x", { topUrl: "https://evil.example" }), false);
  assert.equal(gate.grant("media", "https://evil.example/x", { topUrl: "https://evil.example" }), false);
  assert.equal(gate.grant("media", "https://evil.example/x", { topUrl: "" }), false);
  assert.equal(gate.grant("media", "https://evil.example/x", { topUrl: "not a url" }), false);
});

test("a trusted frame inside an untrusted page is still trusted by its own origin", () => {
  assert.equal(gate.grant("media", IDP + "/embed", { topUrl: "https://evil.example" }), true);
});

test("the top-page context is optional — old call sites behave as before", () => {
  assert.equal(gate.grant("media", IDP + "/verify"), true);
  assert.equal(gate.grant("media", WIDGET + "/capture"), false);
  assert.equal(gate.grant("media", WIDGET + "/capture", {}), false);
});
