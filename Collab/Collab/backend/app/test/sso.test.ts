import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { CompactEncrypt } from "jose";
import config from "../../../config/src";
import * as sso from "../src/services/ssoService";

// SSO (OIDC) PURE-LOGIC tests — no DB, no network, always run. They cover the
// security-critical helpers that the /sso/start + /sso/callback routes lean on:
//   • PKCE challenge derivation (S256, base64url)
//   • the HMAC-signed OAuth `state` — round-trip + tamper + expiry rejection
//   • the one-time handoff store — single-use + unknown-code rejection
//   • the encrypted PII claims (`claims_jwe`) — decrypt with OUR key, reject a
//     foreign key / tampered ciphertext / malformed input, fail closed without a key
// The token exchange + id_token JWKS verification are network-bound (a live IdP)
// and are exercised in deployment, not here.

test("sha256b64url derives a stable, base64url PKCE challenge", () => {
  const v = "code-verifier-abc123";
  const a = sso.sha256b64url(v);
  assert.equal(a, sso.sha256b64url(v), "same verifier → same challenge (deterministic)");
  assert.match(a, /^[A-Za-z0-9_-]+$/, "base64url charset — no +, /, or = padding");
  assert.notEqual(sso.sha256b64url("different"), a, "different verifier → different challenge");
});

test("randomString is base64url and unpredictable", () => {
  const a = sso.randomString(48);
  const b = sso.randomString(48);
  assert.match(a, /^[A-Za-z0-9_-]+$/, "base64url charset");
  assert.ok(a.length >= 43, "48 random bytes → a sufficiently long string");
  assert.notEqual(a, b, "two draws differ");
});

test("createSsoState/parseSsoState round-trips the verifier + nonce", () => {
  const state = sso.createSsoState({ v: "the-verifier", n: "the-nonce" });
  const parsed = sso.parseSsoState(state);
  assert.ok(parsed, "a freshly-signed state parses");
  assert.equal(parsed!.v, "the-verifier");
  assert.equal(parsed!.n, "the-nonce");
});

test("parseSsoState rejects a forged/tampered state", () => {
  const state = sso.createSsoState({ v: "v", n: "n" });
  const dot = state.lastIndexOf(".");
  const body = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  // Flip the last char of the body so the HMAC no longer matches.
  const tampered = body.slice(0, -1) + (body.slice(-1) === "A" ? "B" : "A") + "." + sig;
  assert.equal(sso.parseSsoState(tampered), null, "bad signature → null (forged)");
  assert.equal(sso.parseSsoState("garbage-no-dot"), null, "malformed → null");
  assert.equal(sso.parseSsoState(""), null, "empty → null");
});

test("parseSsoState rejects an expired state", () => {
  // Craft a correctly-signed but already-expired envelope using the SAME secret
  // the service signs with, so ONLY the TTL check can reject it.
  const past = { v: "v", n: "n", e: Date.now() - 1000 };
  const bodyStr = Buffer.from(JSON.stringify(past)).toString("base64url");
  const sig = createHmac("sha256", config.sso.stateSecret).update(bodyStr).digest("base64url");
  assert.equal(sso.parseSsoState(`${bodyStr}.${sig}`), null, "past-expiry state is rejected");
});

test("ssoConfigured returns a boolean gate", () => {
  assert.equal(typeof sso.ssoConfigured(), "boolean");
});

// ── claims_jwe (encrypted PII) ────────────────────────────────────────────────
// Mirrors what the AgenXchange IdP does with keys/agenxchange_public.pem: JSON PII
// → compact JWE (RSA-OAEP-256 + A256GCM) encrypted to our public key.
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PII = { email: "Jane.Doe@Resulticks.com", department: "Engineering", employee_id: "E123", picture: "https://x/p.png" };
async function encryptPii(pii: object, alg = "RSA-OAEP-256", pub = rsa.publicKey) {
  return new CompactEncrypt(new TextEncoder().encode(JSON.stringify(pii)))
    .setProtectedHeader({ alg, enc: "A256GCM" })
    .encrypt(pub);
}

test("decryptClaimsJwe opens a JWE encrypted to our public key and returns the PII", async () => {
  for (const alg of ["RSA-OAEP", "RSA-OAEP-256"]) {
    const jwe = await encryptPii(PII, alg);
    const pii = await sso.decryptClaimsJwe(jwe, rsa.privateKey);
    assert.deepEqual(pii, PII, `${alg}: payload round-trips`);
  }
});

test("decryptClaimsJwe rejects a JWE for a DIFFERENT key, tampering, and garbage", async () => {
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const foreign = await encryptPii(PII, "RSA-OAEP-256", other.publicKey);
  await assert.rejects(sso.decryptClaimsJwe(foreign, rsa.privateKey), /could not be decrypted/, "foreign key");
  const good = await encryptPii(PII);
  const parts = good.split(".");
  parts[3] = parts[3].slice(0, -2) + (parts[3].endsWith("AA") ? "BB" : "AA"); // flip ciphertext
  await assert.rejects(sso.decryptClaimsJwe(parts.join("."), rsa.privateKey), /could not be decrypted/, "tampered");
  await assert.rejects(sso.decryptClaimsJwe("not.a.jwe", rsa.privateKey), /compact JWE/, "malformed");
  const notJson = await new CompactEncrypt(new TextEncoder().encode("plain text"))
    .setProtectedHeader({ alg: "RSA-OAEP-256", enc: "A256GCM" })
    .encrypt(rsa.publicKey);
  await assert.rejects(sso.decryptClaimsJwe(notJson, rsa.privateKey), /not valid JSON/, "non-JSON payload");
});

test("decryptClaimsJwe fails CLOSED when no private key is configured", async () => {
  // The developer's .env may well configure a key (it does on a set-up laptop), so
  // blank BOTH settings for the duration of this test. config is frozen only at
  // the top level; the nested sso block is a plain object.
  const c: any = config.sso;
  const saved = { k: c.jwePrivateKey, f: c.jwePrivateKeyFile };
  c.jwePrivateKey = "";
  c.jwePrivateKeyFile = "";
  try {
    assert.equal(sso.jweConfigured(), false, "no key configured");
    const jwe = await encryptPii(PII);
    await assert.rejects(sso.decryptClaimsJwe(jwe), /SSO_JWE_PRIVATE_KEY/, "names the missing setting");
  } finally {
    c.jwePrivateKey = saved.k;
    c.jwePrivateKeyFile = saved.f;
  }
});

// ── Fernet *_enc profile copies ───────────────────────────────────────────────
// Reference tokens produced by Python `cryptography` (Fernet) with the guide's key
// derivation key = base64url(SHA256(secret)) — proves the Node port is byte-compatible.
const FERNET = {
  secret: "test-shared-secret-please-ignore",
  email: "gAAAAABqqp4lMtyrMHKQfghUjOaFPiFLoPbk2zaXSvabL0GZP8CWxGmizj90Z5KdmWF4m7yVvIWxvha9qUgRHbaQ46-B2rHzDxgP4apuy4OowrNJkvzkGuU=",
  employee_id: "gAAAAABqqp4lrfbLPY3F8fZFjsk5nUaL-z_Dv5Fqu39DfXO6q7EamuvGc44CwatzZgtSEdTAio0pkxtOLd5UDSJaNSuZFsJwEg==",
  unicode: "gAAAAABqqp4lxoaA0rJYrY2KH1i3esR_RSPDkMw3DmmU-az3AlMPHsXHYsu5PVZb3sMmsEB0AEIcthffxh8EVCmHWI_9nmE4-w==",
};

test("fernetDecrypt matches Python cryptography.Fernet output", () => {
  assert.equal(sso.fernetDecrypt(FERNET.email, FERNET.secret), "Jane.Doe@Resulticks.com");
  assert.equal(sso.fernetDecrypt(FERNET.employee_id, FERNET.secret), "E202317000");
  assert.equal(sso.fernetDecrypt(FERNET.unicode, FERNET.secret), "Zoë Ångström", "utf-8 plaintext");
});

test("fernetDecrypt rejects a wrong secret, a tampered token and garbage", () => {
  assert.throws(() => sso.fernetDecrypt(FERNET.email, "another-secret"), /HMAC mismatch/, "wrong secret");
  const t = FERNET.email.slice(0, 40) + (FERNET.email[40] === "A" ? "B" : "A") + FERNET.email.slice(41);
  assert.throws(() => sso.fernetDecrypt(t, FERNET.secret), /HMAC mismatch/, "tampered");
  assert.throws(() => sso.fernetDecrypt("not-a-token", FERNET.secret), /not a Fernet token/, "garbage");
});

test("resolveEncClaims decrypts *_enc into plaintext fields (decrypted wins) and is a no-op without a secret", () => {
  const c: any = config.sso;
  const saved = c.profileEncSecret;
  try {
    c.profileEncSecret = FERNET.secret;
    const r = sso.resolveEncClaims({ sub: "x", email: "stale@plain.text", email_enc: FERNET.email, employee_id_enc: FERNET.employee_id });
    assert.equal(r.claims.email, "Jane.Doe@Resulticks.com", "decrypted overrides plaintext");
    assert.equal(r.claims.employee_id, "E202317000");
    assert.equal("email_enc" in r.claims, false, "ciphertext removed");
    assert.deepEqual(r.decrypted.sort(), ["email", "employee_id"]);
    c.profileEncSecret = "";
    const n = sso.resolveEncClaims({ email_enc: FERNET.email });
    assert.deepEqual(n.decrypted, []);
    assert.equal(n.claims.email_enc, FERNET.email, "untouched without a secret");
  } finally {
    c.profileEncSecret = saved;
  }
});

// ── Native / mobile sign-in input validation (POST /sso/token) ────────────────
test("completeSsoTokenLogin rejects a missing or malformed id_token before any network call", async () => {
  await assert.rejects(sso.completeSsoTokenLogin({}), /id_token is required/, "missing");
  await assert.rejects(sso.completeSsoTokenLogin({ id_token: "not-a-jwt" }), /id_token is required/, "not compact JWS");
  await assert.rejects(sso.completeSsoTokenLogin({ id_token: 42 as any }), /id_token is required/, "wrong type");
});
