import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import jwt from "jsonwebtoken";
import { useTestDatabase } from "./_setup";

// AUTH critical-path tests. Two layers, matching the existing backend style
// (node:test + node:assert, real MySQL with skip-if-absent like
// calls-signalling.test.ts; pure-function cases like identity.test.ts always run):
//
//   1. credentialPolicy — PURE validators (email + password). No DB. Always run.
//   2. signup / login / tokenFor / auth-middleware — boots the real Express app
//      against the seeded `colab` MySQL DB and drives it over HTTP, exactly like
//      calls-signalling.test.ts. DB cases skip when MySQL is unreachable.

let server: any;
let base = "";
let dbUp = false;
let dbRef: any;
let validateEmail: any;
let validatePassword: any;
let normalizeEmail: any;
const JWT_SECRET = "test-secret-colab";

before(async () => {
  await useTestDatabase();
  process.env.AUTH_JWT_SECRET = JWT_SECRET;
  // These tests exercise the sign-up MECHANISM, so enable it here. Production
  // defaults to AUTH_SIGNUP_ENABLED=false (enforced 403 — see the disabled case
  // below), so this must be set before config is imported by platform.
  process.env.AUTH_SIGNUP_ENABLED = "true";
  process.env.LIVEKIT_API_KEY = "testkey";
  process.env.LIVEKIT_API_SECRET = "testsecret_at_least_32_characters_long_xx";
  process.env.LIVEKIT_WS_URL = "ws://localhost:7534";

  // Pure validators — imported directly, no DB needed.
  ({ validateEmail, validatePassword, normalizeEmail } = await import(
    "../src/services/credentialPolicy"
  ));

  try {
    const { migrate } = await import("../../../database/src");
    const { seedDemo } = await import("../../../database/seeds/demo.seed");
    const { seedIfNeeded, config, db } = await import("../src/platform");
    dbRef = db;
    await migrate(config.database.url);
    await seedIfNeeded();
    await seedDemo(db, { usersOnly: true });
    const { createApp } = await import("../src/app");
    const app = createApp();
    server = http.createServer(app);
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    base = `http://127.0.0.1:${server.address().port}`;
    dbUp = true;
  } catch (e: any) {
    console.error("[test] MySQL unavailable — DB cases will skip:", e.message);
  }
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (dbRef?.pool?.end) await dbRef.pool.end();
});

const dbTest = (name: string, fn: any) =>
  test(name, async (t) => {
    if (!dbUp) {
      t.skip("MySQL not available");
      return;
    }
    await fn(t);
  });

const post = (path: string, body: any, token?: string) =>
  fetch(base + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    body: JSON.stringify(body),
  });

// A unique email per run so re-running the suite never collides with a prior
// signup (the users table persists across runs). KEEP IT SHORT: signup derives
// the user id as `u_<local-with-_>_<domain-with-_>` and users.id is VARCHAR(36),
// so a long local part overflows the column (see the long-email finding in the
// suite header). A 10-char base36 token in a tiny local part stays well inside 36.
let _seq = 0;
const uniqEmail = () =>
  `t${(Date.now() % 1e6).toString(36)}${(_seq++).toString(36)}@ex.com`;

// ---------------------------------------------------------------------------
// 1. credentialPolicy — pure, always-run
// ---------------------------------------------------------------------------

test("normalizeEmail trims + lowercases", () => {
  assert.equal(normalizeEmail("  Foo@Bar.COM "), "foo@bar.com");
  assert.equal(normalizeEmail(undefined), "");
  assert.equal(normalizeEmail(null), "");
});

test("validateEmail accepts a well-formed address", () => {
  assert.equal(validateEmail("alice@example.com"), null);
  assert.equal(validateEmail("a.b+tag@sub.example.co"), null);
});

test("validateEmail rejects malformed addresses", () => {
  for (const bad of ["", "notanemail", "no@tld", "a@b..c", "@example.com", "spaces in@x.com"]) {
    const issue = validateEmail(bad);
    assert.ok(issue, `expected "${bad}" to be rejected`);
    assert.equal(issue.field, "email");
  }
});

test("validateEmail rejects disposable/throwaway domains", () => {
  const issue = validateEmail("throwaway@mailinator.com");
  assert.ok(issue, "mailinator is a known disposable domain");
  assert.match(issue.message, /disposable|temporary/i);
});

test("validatePassword enforces length + composition", () => {
  // too short
  assert.equal(validatePassword("Ab1!x")?.field, "password");
  // missing classes
  assert.ok(validatePassword("alllowercase1!"), "needs uppercase");
  assert.ok(validatePassword("ALLUPPERCASE1!"), "needs lowercase");
  assert.ok(validatePassword("NoDigitsHere!"), "needs a number");
  assert.ok(validatePassword("NoSpecial123"), "needs a special char");
  // a strong password passes
  assert.equal(validatePassword("Str0ng&Secure!"), null);
});

test("validatePassword rejects common passwords even when decorated", () => {
  assert.ok(validatePassword("password"), "bare common password");
  // "Password1234!" decorates a common alnum core and must still be rejected.
  const decorated = validatePassword("Password1234!");
  assert.ok(decorated, "decorated common password is still too common");
  assert.match(decorated.message, /common/i);
});

// ---------------------------------------------------------------------------
// 2. signup / login / token / middleware — DB-backed integration over HTTP
// ---------------------------------------------------------------------------

dbTest("signup rejects a weak password with 400 (policy is server-side)", async () => {
  const r = await post("/api/auth/signup", {
    email: uniqEmail(),
    name: "Weak User",
    password: "short",
  });
  assert.equal(r.status, 400, "weak password is rejected by the server");
});

dbTest("signup rejects a disposable email with 400", async () => {
  const r = await post("/api/auth/signup", {
    email: "x@mailinator.com",
    name: "Disposable",
    password: "Str0ng&Secure!",
  });
  assert.equal(r.status, 400);
});

dbTest("signup then login succeeds; wrong password is rejected", async () => {
  const email = uniqEmail();
  const password = "Str0ng&Secure!";

  const signupRes = await post("/api/auth/signup", { email, name: "New User", password });
  assert.equal(signupRes.status, 200, "signup succeeds with a strong password");
  const signup = (await signupRes.json()) as any;
  assert.ok(signup.data.token, "signup mints a token");
  // pubUser (the auth response shape) intentionally omits email; assert the
  // public fields it DOES return instead.
  assert.ok(signup.data.user.id, "signup returns the new user id");
  assert.equal(signup.data.user.name, "New User");

  // Correct credentials log in.
  const okRes = await post("/api/auth/login", { email, password });
  assert.equal(okRes.status, 200, "login with correct password succeeds");
  const ok = (await okRes.json()) as any;
  assert.ok(ok.data.token, "login mints a token");

  // The minted token is a valid JWT carrying the user id as `sub`.
  const decoded: any = jwt.verify(ok.data.token, JWT_SECRET);
  assert.equal(decoded.sub, signup.data.user.id, "token sub = user id");

  // Wrong password is rejected with 401.
  const badRes = await post("/api/auth/login", { email, password: "Wr0ng&Pass!" });
  assert.equal(badRes.status, 401, "wrong password is rejected");

  // Unknown email is rejected with 401 (same generic message — no user enumeration).
  const unknownRes = await post("/api/auth/login", {
    email: "nobody_" + email,
    password,
  });
  assert.equal(unknownRes.status, 401, "unknown email is rejected");
});

dbTest("duplicate signup on a registered email returns 409", async () => {
  const email = uniqEmail();
  const password = "Str0ng&Secure!";
  const first = await post("/api/auth/signup", { email, name: "Dup", password });
  assert.equal(first.status, 200);
  const second = await post("/api/auth/signup", { email, name: "Dup Again", password });
  assert.equal(second.status, 409, "second signup on the same email is a conflict");
});

dbTest("signup is REJECTED (403) when self-service sign-up is disabled", async () => {
  // Enterprise default: public /api/auth/signup is off. signup() reads
  // config.auth.signupEnabled at call time, so flip it and hit the real route.
  const platform = await import("../src/platform");
  const prev = platform.config.auth.signupEnabled;
  platform.config.auth.signupEnabled = false;
  try {
    const res = await post("/api/auth/signup", {
      email: uniqEmail(),
      name: "Blocked",
      password: "Str0ng&Secure!",
    });
    assert.equal(res.status, 403, "self-service signup is forbidden when disabled");
  } finally {
    platform.config.auth.signupEnabled = prev;
  }
});

dbTest("signup with a very long email succeeds (derived id capped to fit users.id)", async () => {
  // Regression: a long local part used to make the derived `u_<local>_<domain>`
  // id overflow users.id VARCHAR(36) -> raw HTTP 500 ("Data too long"). The id is
  // now capped to a readable prefix + a deterministic hash, so it always fits.
  const password = "Str0ng&Secure!";
  const longLocal = "a.very.long.local.part.well.over.thirty.six.characters.long";
  const email = `${longLocal}.${(Date.now() % 1e6).toString(36)}@example-domain.com`;
  const res = await post("/api/auth/signup", { email, name: "Long Email", password });
  assert.equal(res.status, 200, "long-email signup succeeds (no 500 overflow)");
  const body = (await res.json()) as any;
  assert.ok(body.data.user.id, "returns a user id");
  assert.ok(
    body.data.user.id.length <= 36,
    `derived id must fit VARCHAR(36), got ${body.data.user.id.length}`,
  );
});

dbTest(
  "tokenFor OMITS an unowned/unknown deviceId, BINDS a validly-owned one",
  async () => {
    // The ownership-validated tokenFor only binds a deviceId that exists, belongs
    // to THIS user, and isn't revoked. A garbage/foreign id must be dropped so the
    // token never asserts a device the user doesn't own.
    const email = uniqEmail();
    const password = "Str0ng&Secure!";
    const signupRes = await post("/api/auth/signup", { email, name: "Dev User", password });
    const signup = (await signupRes.json()) as any;
    const userId = signup.data.user.id;

    // (a) login with a deviceId that doesn't exist → token must NOT carry it.
    const unknownRes = await post("/api/auth/login", {
      email,
      password,
      deviceId: "device_does_not_exist_" + Math.random().toString(36).slice(2),
    });
    const unknown = (await unknownRes.json()) as any;
    const decUnknown: any = jwt.verify(unknown.data.token, JWT_SECRET);
    assert.equal(
      decUnknown.deviceId,
      undefined,
      "an unknown deviceId is NOT bound into the token",
    );

    // (b) register a real device for this user, then login with it → token binds it.
    const realDeviceId = "dev_" + Math.random().toString(36).slice(2);
    await dbRef.e2ee.registerDevice({
      id: realDeviceId,
      userId,
      identityKey: "pk_" + realDeviceId,
      trusted: true,
    });
    const ownedRes = await post("/api/auth/login", { email, password, deviceId: realDeviceId });
    const owned = (await ownedRes.json()) as any;
    const decOwned: any = jwt.verify(owned.data.token, JWT_SECRET);
    assert.equal(decOwned.deviceId, realDeviceId, "an owned device IS bound into the token");

    // (c) a deviceId owned by a DIFFERENT user must NOT bind to this user's token.
    const otherEmail = uniqEmail();
    const otherRes = await post("/api/auth/signup", {
      email: otherEmail,
      name: "Other",
      password,
    });
    const otherUserId = ((await otherRes.json()) as any).data.user.id;
    const foreignDeviceId = "dev_foreign_" + Math.random().toString(36).slice(2);
    await dbRef.e2ee.registerDevice({
      id: foreignDeviceId,
      userId: otherUserId,
      identityKey: "pk_" + foreignDeviceId,
      trusted: true,
    });
    const foreignBindRes = await post("/api/auth/login", {
      email, // logging in as the FIRST user
      password,
      deviceId: foreignDeviceId, // but claiming the OTHER user's device
    });
    const foreignBind = (await foreignBindRes.json()) as any;
    const decForeign: any = jwt.verify(foreignBind.data.token, JWT_SECRET);
    assert.equal(
      decForeign.deviceId,
      undefined,
      "a device owned by another user is NOT bound (ownership validated at mint)",
    );
  },
);

// ---------------------------------------------------------------------------
// 3. Active sessions (#66) — durable session list + revoke, middleware enforcement
// ---------------------------------------------------------------------------

// Small helpers for these tests.
const get = (path: string, token?: string) =>
  fetch(base + path, {
    headers: { ...(token ? { Authorization: "Bearer " + token } : {}) },
  });
const del = (path: string, token?: string) =>
  fetch(base + path, {
    method: "DELETE",
    headers: { ...(token ? { Authorization: "Bearer " + token } : {}) },
  });

// Sign up a fresh user and return { token, jti, userId }.
async function freshUser() {
  const email = uniqEmail();
  const password = "Str0ng&Secure!";
  const r = (await (
    await post("/api/auth/signup", { email, name: "Sess User", password })
  ).json()) as any;
  const token = r.data.token;
  const decoded: any = jwt.verify(token, JWT_SECRET);
  return { token, jti: decoded.jti, userId: r.data.user.id, email, password };
}

dbTest("login/signup mints a token carrying a session jti, and lists it", async () => {
  const { token, jti } = await freshUser();
  assert.ok(jti, "the token carries a jti (durable session id)");

  const listed = (await (await get("/api/sessions", token)).json()) as any;
  assert.ok(Array.isArray(listed.data.sessions), "sessions is an array");
  const mine = listed.data.sessions.find((s: any) => s.id === jti);
  assert.ok(mine, "the current session appears in the list");
  assert.equal(mine.current, true, "the current session is flagged current");
  assert.equal(mine.revoked, false, "the current session is not revoked");
});

dbTest("a REVOKED session → 401 on the next authed request", async () => {
  const { token, jti, userId } = await freshUser();
  // Sanity: the token works before revocation.
  assert.equal((await get("/api/auth/me", token)).status, 200, "works pre-revoke");
  // Revoke the session row directly (simulating a sign-out from another device).
  const did = await dbRef.sessions.revoke(userId, jti);
  assert.equal(did, true, "the session row was revoked");
  // The same access token is now rejected — the middleware enforces the session.
  assert.equal(
    (await get("/api/auth/me", token)).status,
    401,
    "a revoked session 401s even with a structurally-valid JWT",
  );
});

dbTest("an EXPIRED session → 401 on the next authed request", async () => {
  const { token, jti, userId } = await freshUser();
  assert.equal((await get("/api/auth/me", token)).status, 200, "works pre-expiry");
  // Backdate expiry into the past (the durable anchor lapsed).
  await dbRef.pool.query(
    "UPDATE auth_sessions SET expires_at = now(3) - INTERVAL 1 DAY WHERE id=?",
    [jti],
  );
  assert.equal(
    (await get("/api/auth/me", token)).status,
    401,
    "an expired session 401s",
  );
});

dbTest("FAIL-OPEN: a sessions lookup error must NOT lock the user out", async () => {
  const { token } = await freshUser();
  const original = dbRef.sessions.getForAuth;
  // Force the hot-path lookup to throw (a sessions-infra hiccup).
  dbRef.sessions.getForAuth = async () => {
    throw new Error("simulated sessions DB outage");
  };
  try {
    const r = await get("/api/auth/me", token);
    assert.equal(
      r.status,
      200,
      "a sessions-infra error fails OPEN — the request is allowed, no mass logout",
    );
  } finally {
    dbRef.sessions.getForAuth = original;
  }
});

dbTest("IDOR: one user cannot revoke ANOTHER user's session", async () => {
  const attacker = await freshUser();
  const victim = await freshUser();
  // Attacker tries to revoke the victim's session id via their OWN token.
  const r = (await (
    await del("/api/sessions/" + victim.jti, attacker.token)
  ).json()) as any;
  assert.equal(r.data.revoked, false, "cross-user revoke is a no-op (IDOR-guarded)");
  // The victim's session is untouched — still works.
  assert.equal(
    (await get("/api/auth/me", victim.token)).status,
    200,
    "the victim's session is unaffected",
  );
  // The victim's row is genuinely still un-revoked in the DB.
  const row = await dbRef.sessions.getForAuth(victim.jti);
  assert.equal(row.revoked, false, "victim row is not revoked");
});

dbTest("list-scoping: /api/sessions returns ONLY the caller's sessions", async () => {
  const a = await freshUser();
  const b = await freshUser();
  const listA = (await (await get("/api/sessions", a.token)).json()) as any;
  const ids = listA.data.sessions.map((s: any) => s.id);
  assert.ok(ids.includes(a.jti), "A sees A's session");
  assert.ok(!ids.includes(b.jti), "A does NOT see B's session");
});

dbTest("revoke-others signs out every session EXCEPT the current one", async () => {
  const { email, password } = await freshUser();
  // Two more logins for the same user → three sessions total.
  const t2 = ((await (await post("/api/auth/login", { email, password })).json()) as any)
    .data.token;
  const t3 = ((await (await post("/api/auth/login", { email, password })).json()) as any)
    .data.token;
  const jti2: any = (jwt.verify(t2, JWT_SECRET) as any).jti;
  // From session t2, revoke all OTHERS.
  const out = (await (
    await fetch(base + "/api/sessions/revoke-others", {
      method: "POST",
      headers: { Authorization: "Bearer " + t2 },
    })
  ).json()) as any;
  assert.ok(out.data.revoked >= 2, "at least the two other sessions were revoked");
  // t2 (current) still works; t3 (an "other") is now 401.
  assert.equal((await get("/api/auth/me", t2)).status, 200, "current session kept");
  assert.equal((await get("/api/auth/me", t3)).status, 401, "other session revoked");
  // And the kept session is still listed as current + un-revoked.
  const list = (await (await get("/api/sessions", t2)).json()) as any;
  const kept = list.data.sessions.find((s: any) => s.id === jti2);
  assert.ok(kept && kept.revoked === false && kept.current === true, "kept = current");
});

dbTest("auth middleware: missing token → 401, valid token → 200", async () => {
  // The /api/auth/me route sits behind authMiddleware. With E2EE off (the live
  // default) the middleware is permissive: a valid password-auth token always
  // passes; a missing/garbage token is rejected.
  const email = uniqEmail();
  const password = "Str0ng&Secure!";
  const signup = (await (
    await post("/api/auth/signup", { email, name: "Me User", password })
  ).json()) as any;

  // No token at all → 401.
  const noTok = await fetch(base + "/api/auth/me");
  assert.equal(noTok.status, 401, "missing token is rejected");

  // Garbage token → 401.
  const badTok = await fetch(base + "/api/auth/me", {
    headers: { Authorization: "Bearer not.a.jwt" },
  });
  assert.equal(badTok.status, 401, "invalid token is rejected");

  // Valid token → 200 and resolves the right user.
  const ok = await fetch(base + "/api/auth/me", {
    headers: { Authorization: "Bearer " + signup.data.token },
  });
  assert.equal(ok.status, 200, "valid token passes the permissive middleware");
  const me = (await ok.json()) as any;
  assert.equal(me.data.id, signup.data.user.id);
});
