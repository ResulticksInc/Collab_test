// ─────────────────────────────────────────────────────────────────────────────
// SSO — OpenID Connect (Authorization Code + PKCE), server-side (confidential).
//
// Flow (see docs/SSO.md and the AgenXchange integration guide this mirrors):
//   1. GET /api/auth/sso/start    → mint verifier/challenge/state/nonce, 302 to the
//      IdP login (`${idpUrl}/login?return_to=<authorize URL>`).
//   2. IdP authenticates the user, 302s back to redirect_uri with ?code&state.
//   3. GET /api/auth/sso/callback → verify state (recovers the PKCE verifier +
//      nonce), exchange the code for tokens over the back-channel, VALIDATE the
//      id_token (signature via JWKS + iss/aud/exp/nonce), read the email, find-or-
//      create the user, mint the app session, hand off via a one-time code.
//   4. POST /api/auth/sso/exchange → the SPA swaps the one-time code for
//      { token, user } (so the app JWT never rides in a URL).
//
// PKCE + JWK→PEM use Node's built-in `crypto`; signature verification reuses
// `jsonwebtoken`; the ENCRYPTED PII claims (`claims_jwe`, see decryptClaimsJwe)
// are opened with `jose`. Endpoints are env-driven and auto-derived/discovered so
// only the base URL + clientId + redirectUri (+ secret, + JWE private key) must be
// set per deployment.
// ─────────────────────────────────────────────────────────────────────────────
import {
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  type KeyObject,
} from "crypto";
import { readFileSync } from "fs";
import jwt from "jsonwebtoken";
import { compactDecrypt } from "jose";
import { config } from "../platform";

// Node 18+ ships a global fetch; guard so a missing runtime fails loud, not weird.
const httpFetch: typeof fetch = (globalThis as any).fetch;

function ssoErr(status: number, message: string) {
  const e: any = new Error(message);
  e.status = status;
  return e;
}

// fetch with a hard timeout so a slow/hanging IdP call fails FAST with a clear,
// surfaced error instead of hanging the request until the dev proxy gives up with
// an opaque 500. Also normalizes network errors into a tagged ssoErr.
async function fetchT(url: string, opts: any = {}, ms = 12000): Promise<Response> {
  if (typeof httpFetch !== "function")
    throw ssoErr(500, "global fetch is unavailable (Node 18+ required).");
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    return await httpFetch(url, { ...opts, signal: ac.signal });
  } catch (e: any) {
    if (ac.signal.aborted) throw ssoErr(504, `SSO request to ${url} timed out after ${ms}ms.`);
    throw ssoErr(502, `SSO request to ${url} failed: ${e?.message || e}`);
  } finally {
    clearTimeout(timer);
  }
}

// ── PKCE + random helpers ────────────────────────────────────────────────────
function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
export function randomString(byteLen = 48): string {
  return b64url(randomBytes(byteLen));
}
export function sha256b64url(input: string): string {
  return b64url(createHash("sha256").update(input).digest());
}

// ── Signed OAuth state (carries verifier + nonce across the redirect) ─────────
// HMAC-signed, 10-minute TTL. Survives multiple backend instances with no shared
// storage (exactly like the reference implementation).
const STATE_TTL_MS = 10 * 60 * 1000;
export function createSsoState(payload: { v: string; n: string }): string {
  const body = Buffer.from(
    JSON.stringify({ v: payload.v, n: payload.n, e: Date.now() + STATE_TTL_MS }),
  ).toString("base64url");
  const sig = createHmac("sha256", config.sso.stateSecret).update(body).digest("base64url");
  return `${body}.${sig}`;
}
export function parseSsoState(state: string): { v: string; n: string } | null {
  if (!state || typeof state !== "string") return null;
  const dot = state.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  const expected = createHmac("sha256", config.sso.stateSecret).update(body).digest("base64url");
  const a = Buffer.from(sig, "base64url");
  const b = Buffer.from(expected, "base64url");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null; // forged
  let parsed: any;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed.v !== "string" || typeof parsed.n !== "string") return null;
  if (!parsed.e || parsed.e <= Date.now()) return null; // expired
  return { v: parsed.v, n: parsed.n };
}

// ── Endpoint resolution (explicit env > OIDC discovery > derived defaults) ────
type Endpoints = {
  authorizeUrl: string;
  tokenUrl: string;
  jwksUrl: string;
  userinfoUrl: string;
  issuer: string;
  // Every issuer identity we will ACCEPT in an id_token's `iss` (see resolveEndpoints).
  issuers: string[];
  // OIDC end-session (logout) endpoint, on the BROWSER-REACHABLE origin.
  endSessionUrl: string;
};
let discoveryCache: { at: number; doc: any } | null = null;
const DISCOVERY_TTL_MS = 60 * 60 * 1000;

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

async function discover(): Promise<any | null> {
  // Discover from the AUTHORIZE origin (the reachable public host), NOT the issuer —
  // the issuer can be a non-fetchable identifier (here an internal URL that only
  // appears in the id_token `iss`), which would hang until the request times out.
  const base =
    config.sso.baseUrl ||
    originOf(config.sso.authorizeUrl) ||
    originOf(config.sso.idpUrl) ||
    config.sso.issuer;
  if (!base) return null;
  if (discoveryCache && Date.now() - discoveryCache.at < DISCOVERY_TTL_MS) return discoveryCache.doc;
  const url = base.replace(/\/$/, "") + "/.well-known/openid-configuration";
  try {
    const res = await fetchT(url, { method: "GET" });
    if (!res.ok) return null;
    const doc = await res.json();
    discoveryCache = { at: Date.now(), doc };
    return doc;
  } catch {
    return null; // discovery is best-effort; fall back to derived defaults
  }
}

async function resolveEndpoints(): Promise<Endpoints> {
  const c = config.sso;
  // SSO_BASE_URL is the one-line IdP host (https://stgoa.re.cx); every endpoint not
  // set explicitly hangs off it. Falls back to the authorize/idp origins for
  // deployments that still configure each URL by hand.
  const origin = c.baseUrl || originOf(c.authorizeUrl) || originOf(c.idpUrl);
  // Skip discovery ENTIRELY when every endpoint is explicitly configured. Otherwise
  // each call pays a <issuer>/.well-known fetch — and a failing one (e.g. an issuer
  // that isn't reachable) hangs to the timeout on EVERY exchange + verify, which was
  // slow enough to trip the dev proxy before the (successful) response was sent.
  const needDiscovery = !(c.authorizeUrl && c.tokenUrl && c.jwksUrl && c.issuer);
  const doc = needDiscovery ? (await discover()) || {} : {};
  const authorizeUrl =
    c.authorizeUrl || (c.baseUrl ? c.baseUrl + "/authorize" : "") || doc.authorization_endpoint || "";
  const tokenUrl =
    c.tokenUrl ||
    (c.baseUrl ? c.baseUrl + "/token" : "") ||
    doc.token_endpoint ||
    (authorizeUrl ? authorizeUrl.replace(/\/authorize(\?|$)/, "/token$1") : origin ? origin + "/token" : "");
  // This IdP serves its key set at /jwks (not the OIDC-conventional
  // /.well-known/jwks.json) — the base-URL derivation follows the IdP.
  const jwksUrl =
    c.jwksUrl ||
    (c.baseUrl ? c.baseUrl + "/jwks" : "") ||
    doc.jwks_uri ||
    (origin ? origin + "/.well-known/jwks.json" : "");
  const userinfoUrl = c.userinfoUrl || doc.userinfo_endpoint || (origin ? origin + "/userinfo" : "");
  const issuer = c.issuer || doc.issuer || origin;
  // ACCEPTED ISSUER SET. This IdP is reachable at ONE host (e.g. https://oa.re.cx)
  // but stamps `iss` with ANOTHER identity (the internal http://10.200.1.58:7505 —
  // see the discover() note above). Pinning the single SSO_ISSUER string therefore
  // breaks EVERY sign-in the moment the IdP switches which of its own identifiers
  // it stamps (or an operator sets the other one) — "jwt issuer invalid".
  // Accept any of the identities the OPERATOR has already configured for this same
  // IdP — never an arbitrary issuer: the explicit SSO_ISSUER, the discovery
  // document's issuer, and the origins of the configured authorize/token/idp
  // endpoints. Trailing slashes normalised so ".../" and "..." are the same value.
  const issuers = Array.from(
    new Set(
      [
        c.issuer,
        doc.issuer,
        origin,
        c.baseUrl,
        originOf(c.authorizeUrl),
        originOf(c.idpUrl),
        originOf(c.tokenUrl),
      ]
        .map((s) => String(s || "").trim().replace(/\/+$/, ""))
        .filter(Boolean),
    ),
  );
  // End-session (logout) URL on the REACHABLE origin. Discovery's own value can be
  // an internal host that only appears in `iss` (same trap as the authorize URL —
  // see above), so take its PATH but the reachable origin. Explicit env wins.
  const authOrigin = originOf(authorizeUrl) || origin;
  let endSessionUrl = c.logoutUrl || "";
  if (!endSessionUrl && authOrigin) {
    let path = "/logout";
    if (doc.end_session_endpoint) {
      try {
        path = new URL(doc.end_session_endpoint).pathname || "/logout";
      } catch {
        /* keep default */
      }
    }
    endSessionUrl = authOrigin.replace(/\/$/, "") + path;
  }
  return { authorizeUrl, tokenUrl, jwksUrl, userinfoUrl, issuer, issuers, endSessionUrl };
}

// ── RP-initiated logout redirect (ends the IdP session on app logout) ─────────
// Used by GET /api/auth/sso/logout after the app has revoked its own session: the
// browser is sent to the IdP's end-session endpoint with a post_logout_redirect_uri
// (the app root). Returns "" if no logout endpoint is known.
export async function buildLogoutRedirect(returnTo: string): Promise<string> {
  const c = config.sso;
  const { endSessionUrl } = await resolveEndpoints();
  if (!endSessionUrl) return "";
  const qs = new URLSearchParams({ post_logout_redirect_uri: returnTo });
  if (c.clientId) qs.set("client_id", c.clientId);
  return `${endSessionUrl}?${qs.toString()}`;
}

// App root the IdP returns to after an app-initiated logout (see /sso/logout).
// The registered redirect_uri IS the app root, so it is the safest known-good value.
export function appRootUrl(): string {
  return config.sso.redirectUri || "/";
}

// OIDC `claims` request (AgenXchange guide v3). Asks the IdP to include the full
// profile pack — plaintext fields while the IdP still sends them, plus the RSA
// `claims_jwe` envelope that carries the PII once plaintext is switched off.
// `null` = "requested, not essential" per OIDC Core §5.5.
const PROFILE_CLAIMS_REQUEST = JSON.stringify({
  id_token: {
    email: null,
    email_verified: null,
    name: null,
    picture: null,
    department: null,
    employee_id: null,
    claims_jwe: null,
    products: null,
    entitlements: null,
  },
  userinfo: {
    email: null,
    email_verified: null,
    name: null,
    picture: null,
    department: null,
    employee_id: null,
    claims_jwe: null,
    products: null,
    entitlements: null,
  },
});

// login_hint sanity: an email-ish token the IdP launcher put on our homepage URL.
// Never forward arbitrary text into the authorize request.
export function cleanLoginHint(v: unknown): string {
  const s = String(v || "").trim();
  return s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : "";
}

// ── Authorize URL + IdP login redirect ───────────────────────────────────────
export async function buildLoginRedirect(args: {
  state: string;
  nonce: string;
  codeChallenge: string;
  loginHint?: string;
}): Promise<string> {
  const c = config.sso;
  const { authorizeUrl } = await resolveEndpoints();
  if (!authorizeUrl || !c.clientId || !c.redirectUri) {
    throw ssoErr(500, "SSO is not fully configured (need authorize URL, client id, redirect URI).");
  }
  const qs = new URLSearchParams({
    response_type: "code",
    client_id: c.clientId,
    redirect_uri: c.redirectUri,
    scope: c.scope,
    state: args.state,
    nonce: args.nonce,
    code_challenge: args.codeChallenge,
    code_challenge_method: "S256",
    claims: PROFILE_CLAIMS_REQUEST,
  });
  // IdP app launcher: the user is already signed in on the IdP dashboard and
  // clicked CoLab, which opened our homepage with ?login_hint=<email>. Forward it
  // so the IdP can complete the login against its own session for that user.
  if (args.loginHint) qs.set("login_hint", args.loginHint);
  const authorize = `${authorizeUrl}?${qs.toString()}`;
  // The IdP login UI wraps the OIDC authorize request in `return_to`. If no
  // separate login host is configured, go straight to the authorize endpoint.
  return c.idpUrl
    ? `${c.idpUrl.replace(/\/$/, "")}/login?return_to=${encodeURIComponent(authorize)}`
    : authorize;
}

// ── Token exchange (back-channel; PKCE verifier + optional client secret) ─────
async function exchangeCode(code: string, codeVerifier: string): Promise<any> {
  const c = config.sso;
  const { tokenUrl } = await resolveEndpoints();
  if (!tokenUrl) throw ssoErr(500, "SSO token endpoint could not be resolved.");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: c.redirectUri,
    client_id: c.clientId,
    code_verifier: codeVerifier,
  });
  if (c.clientSecret) body.set("client_secret", c.clientSecret);
  const res = await fetchT(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 300);
    } catch {}
    throw ssoErr(502, `Token exchange failed (${res.status}).${detail ? " " + detail : ""}`);
  }
  return res.json();
}

// ── id_token verification (JWKS signature + iss/aud/exp/nonce) ────────────────
type Jwk = { kid?: string; kty?: string; alg?: string; [k: string]: any };
let jwksCache: { at: number; keys: Jwk[] } | null = null;
const JWKS_TTL_MS = 60 * 60 * 1000;

async function getJwks(force = false): Promise<Jwk[]> {
  if (!force && jwksCache && Date.now() - jwksCache.at < JWKS_TTL_MS) return jwksCache.keys;
  const { jwksUrl } = await resolveEndpoints();
  if (!jwksUrl) throw ssoErr(500, "SSO JWKS endpoint could not be resolved.");
  const res = await fetchT(jwksUrl, { method: "GET" });
  if (!res.ok) throw ssoErr(502, `Fetching JWKS failed (${res.status}).`);
  const doc: any = await res.json();
  const keys: Jwk[] = Array.isArray(doc?.keys) ? doc.keys : [];
  jwksCache = { at: Date.now(), keys };
  return keys;
}

function jwkToPem(jwk: Jwk): string {
  // Node ≥16 imports a JWK directly; export as SPKI PEM for jsonwebtoken.verify.
  const key = createPublicKey({ key: jwk as any, format: "jwk" });
  return key.export({ type: "spki", format: "pem" }).toString();
}

async function verifyIdToken(idToken: string, expectedNonce: string): Promise<any> {
  const c = config.sso;
  const decodedHeader: any = jwt.decode(idToken, { complete: true });
  if (!decodedHeader || !decodedHeader.header) throw ssoErr(401, "Malformed id_token.");
  const { kid, alg } = decodedHeader.header;

  const verifyWithKeys = async (force: boolean) => {
    const keys = await getJwks(force);
    const jwk = keys.find((k) => (kid ? k.kid === kid : true)) || keys[0];
    if (!jwk) throw ssoErr(401, "No matching signing key for id_token.");
    const pem = jwkToPem(jwk);
    // `aud` must be OUR client id — or one of the extra ids registered for the
    // same product (the mobile app runs the OIDC exchange natively under its own
    // client_id and posts the id_token to /sso/token). Never an arbitrary aud.
    const audiences = Array.from(new Set([c.clientId, ...(c.extraClientIds || [])].filter(Boolean)));
    const opts: any = {
      algorithms: [alg || "RS256"],
      audience: audiences.length === 1 ? audiences[0] : audiences,
      clockTolerance: 60,
    };
    // jsonwebtoken accepts an ARRAY here — any ONE match passes. See resolveEndpoints
    // for why a single pinned issuer is fragile for this IdP.
    const { issuers } = await resolveEndpoints();
    if (issuers.length) opts.issuer = issuers;
    return jwt.verify(idToken, pem, opts) as any;
  };

  let payload: any;
  try {
    payload = await verifyWithKeys(false);
  } catch (e: any) {
    // A rotated signing key (kid miss) → refetch JWKS once before giving up.
    if (/no matching signing key|invalid signature/i.test(String(e?.message))) {
      try {
        payload = await verifyWithKeys(true);
      } catch (e2: any) {
        if (e2?.status) throw e2;
        throw ssoErr(401, `id_token rejected: ${e2?.message || e2}`);
      }
    } else if (/issuer invalid/i.test(String(e?.message))) {
      // SELF-DIAGNOSING. The stock message only says what we EXPECTED, never what the
      // IdP actually stamped — which made this un-actionable from the login screen.
      // Report both so the operator can set SSO_ISSUER to the exact value.
      const got = (jwt.decode(idToken) as any)?.iss;
      const { issuers } = await resolveEndpoints();
      throw ssoErr(
        401,
        `id_token issuer mismatch — the IdP stamped "${got || "(none)"}" but this server accepts ${issuers.length ? issuers.map((i) => `"${i}"`).join(", ") : "(none configured)"}. Set SSO_ISSUER to the value the IdP stamps.`,
      );
    } else if (c.insecureSkipVerify && /JWKS|resolve|ECONN|fetch|network/i.test(String(e?.message))) {
      // Dev-only escape hatch: JWKS unreachable AND operator explicitly opted out
      // of verification. Decode WITHOUT signature validation. Never in production.
      if (config.env === "production")
        throw ssoErr(500, "id_token signature verification unavailable (refusing in production).");
      // eslint-disable-next-line no-console
      console.warn("[sso] SSO_INSECURE_SKIP_VERIFY=true — decoding id_token WITHOUT signature verification.");
      payload = jwt.decode(idToken) as any;
    } else if (e?.status) {
      throw e; // already a tagged SSO error (JWKS fetch, key resolution, …)
    } else {
      // jsonwebtoken errors (invalid signature, expired, audience/issuer/alg
      // mismatch) carry no HTTP status; they are a REJECTED token → 401, not a
      // server fault → 502. Keep the library's reason for the operator.
      throw ssoErr(401, `id_token rejected: ${e?.message || e}`);
    }
  }
  if (!payload) throw ssoErr(401, "id_token verification produced no claims.");
  // Nonce binds this id_token to the login we started (replay protection).
  if (expectedNonce && payload.nonce && payload.nonce !== expectedNonce)
    throw ssoErr(401, "id_token nonce mismatch.");
  return payload;
}

// ── Encrypted PII claims (`claims_jwe`) ──────────────────────────────────────
// The AgenXchange IdP never puts PII in the id_token in the clear. The verified
// id_token carries a `claims_jwe` claim: a compact JWE (RSA-OAEP / RSA-OAEP-256 key
// wrap, AES-GCM content) whose plaintext is a JSON object with the PII —
// { email, department, employee_id, picture } — encrypted to the public half of
// keys/collab_private.pem (scripts/gen-sso-keys.sh). This is the Node twin of the
// reference Python:
//     jwe = JsonWebEncryption()
//     data = jwe.deserialize_compact(id_token_claims["claims_jwe"], private_pem)
//     pii  = json.loads(data["payload"])
export interface SsoPii {
  email?: string;
  name?: string;
  department?: string;
  employee_id?: string;
  picture?: string;
  [k: string]: any;
}

let jwePrivateKeyCache: { src: string; key: KeyObject } | null = null;

// Resolve the private key from config: inline PEM (raw or base64 — secret stores
// often can't hold multi-line values) or a file path. Cached per source string so
// the PEM is parsed once, not per login. Returns null when nothing is configured.
export function loadJwePrivateKey(): KeyObject | null {
  const c = config.sso;
  let src = String(c.jwePrivateKey || "").trim();
  if (!src && c.jwePrivateKeyFile) {
    try {
      src = readFileSync(c.jwePrivateKeyFile, "utf8").trim();
    } catch (e: any) {
      throw ssoErr(500, `SSO_JWE_PRIVATE_KEY_FILE could not be read (${c.jwePrivateKeyFile}): ${e?.message || e}`);
    }
  }
  if (!src) return null;
  if (jwePrivateKeyCache && jwePrivateKeyCache.src === src) return jwePrivateKeyCache.key;
  // Inline values may arrive base64-wrapped (one line) rather than as raw PEM.
  const pem = src.includes("-----BEGIN") ? src : Buffer.from(src, "base64").toString("utf8");
  let key: KeyObject;
  try {
    // createPrivateKey accepts BOTH PKCS#1 ("BEGIN RSA PRIVATE KEY", what
    // `openssl genrsa` writes on OpenSSL 1.x/LibreSSL) and PKCS#8 ("BEGIN PRIVATE
    // KEY", OpenSSL 3.x) — jose's own importPKCS8 only takes the latter.
    key = createPrivateKey(pem);
  } catch (e: any) {
    throw ssoErr(500, `SSO JWE private key is not a valid RSA private key PEM: ${e?.message || e}`);
  }
  if (key.asymmetricKeyType !== "rsa")
    throw ssoErr(500, `SSO JWE private key must be RSA (got ${key.asymmetricKeyType}).`);
  jwePrivateKeyCache = { src, key };
  return key;
}

export function jweConfigured(): boolean {
  const c = config.sso;
  return !!(String(c.jwePrivateKey || "").trim() || c.jwePrivateKeyFile);
}

// Decrypt one compact JWE and parse its JSON payload. `key` overrides the configured
// private key (tests); otherwise the configured key is REQUIRED — a `claims_jwe`
// we cannot open is a hard failure, never a silent fall-through to plaintext.
export async function decryptClaimsJwe(compact: string, key?: KeyObject): Promise<SsoPii> {
  const k = key || loadJwePrivateKey();
  if (!k)
    throw ssoErr(
      500,
      "id_token carries encrypted claims (claims_jwe) but no SSO_JWE_PRIVATE_KEY / SSO_JWE_PRIVATE_KEY_FILE is configured.",
    );
  if (typeof compact !== "string" || compact.split(".").length !== 5)
    throw ssoErr(401, "claims_jwe is not a compact JWE (expected 5 dot-separated parts).");
  let plaintext: Uint8Array;
  try {
    ({ plaintext } = await compactDecrypt(compact, k, {
      // RSA key-wrap algorithms authlib's JsonWebEncryption() produces for an RSA key.
      // RSA1_5 is deliberately absent (Bleichenbacher; jose deprecates it too).
      keyManagementAlgorithms: ["RSA-OAEP", "RSA-OAEP-256", "RSA-OAEP-384", "RSA-OAEP-512"],
    }));
  } catch (e: any) {
    // Wrong key / tampered ciphertext / unsupported alg all land here. Keep the
    // library's reason (it names the alg on a mismatch) — no PII is in it.
    throw ssoErr(401, `claims_jwe could not be decrypted: ${e?.message || e}`);
  }
  let pii: any;
  try {
    pii = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw ssoErr(401, "claims_jwe payload is not valid JSON.");
  }
  if (!pii || typeof pii !== "object" || Array.isArray(pii))
    throw ssoErr(401, "claims_jwe payload is not a claims object.");
  return pii as SsoPii;
}

// ── Fernet-encrypted profile copies (`*_enc`) ────────────────────────────────
// Guide v3: the IdP may ship each profile field ALSO (or only) as a Fernet token —
// email_enc, name_enc, picture_enc, department_enc, employee_id_enc — keyed by a
// shared secret: key = base64url(SHA256(secret)). Fernet = AES-128-CBC + HMAC-SHA256
// (spec: https://github.com/fernet/spec). Implemented on Node's crypto so there is
// no dependency; verified against Python `cryptography` in sso.test.ts.
function fernetKey(secret: string): { sign: Buffer; enc: Buffer } {
  const raw = createHash("sha256").update(secret, "utf8").digest(); // 32 bytes
  return { sign: raw.subarray(0, 16), enc: raw.subarray(16, 32) };
}
export function fernetDecrypt(token: string, secret: string): string {
  const { sign, enc } = fernetKey(secret);
  const buf = Buffer.from(String(token).trim(), "base64url");
  // version(1) | timestamp(8) | iv(16) | ciphertext(16n) | hmac(32)
  if (buf.length < 1 + 8 + 16 + 16 + 32 || buf[0] !== 0x80) throw new Error("not a Fernet token");
  const body = buf.subarray(0, buf.length - 32);
  const mac = buf.subarray(buf.length - 32);
  const expected = createHmac("sha256", sign).update(body).digest();
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected))
    throw new Error("Fernet HMAC mismatch (wrong SSO_PROFILE_ENC_SECRET or tampered token)");
  const iv = buf.subarray(9, 25);
  const ciphertext = buf.subarray(25, buf.length - 32);
  if (ciphertext.length % 16 !== 0) throw new Error("Fernet ciphertext length");
  const d = createDecipheriv("aes-128-cbc", enc, iv); // PKCS#7 unpadding is the default
  return Buffer.concat([d.update(ciphertext), d.final()]).toString("utf8");
}

// Decrypt every `<field>_enc` in a claims object into `<field>` (decrypted value
// WINS over any plaintext copy). No-op without SSO_PROFILE_ENC_SECRET. Returns the
// list of fields it decrypted so the caller can log keys (never values).
export function resolveEncClaims(claims: Record<string, any>): { claims: Record<string, any>; decrypted: string[] } {
  const secret = String(config.sso.profileEncSecret || "").trim();
  const out: Record<string, any> = { ...claims };
  const decrypted: string[] = [];
  if (!secret) return { claims: out, decrypted };
  for (const [k, v] of Object.entries(claims)) {
    if (!k.endsWith("_enc") || typeof v !== "string" || !v) continue;
    const field = k.slice(0, -4);
    try {
      out[field] = fernetDecrypt(v, secret);
      decrypted.push(field);
    } catch (e: any) {
      throw ssoErr(401, `Encrypted profile field ${k} could not be decrypted: ${e?.message || e}`);
    }
    delete out[k];
  }
  return { claims: out, decrypted };
}

// ── Profile extraction (email is the account key) ─────────────────────────────
async function userinfo(accessToken: string): Promise<any | null> {
  const { userinfoUrl } = await resolveEndpoints();
  if (!userinfoUrl) return null;
  try {
    const res = await fetchT(userinfoUrl, { headers: { Authorization: "Bearer " + accessToken } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export interface SsoProfile {
  email: string;
  name: string;
  groups: string[];
  // From the decrypted PII (claims_jwe) when the IdP sends it; otherwise empty.
  picture: string;
  department: string;
  employeeId: string;
}

// Run the whole callback back-channel: exchange → verify → profile. Returns the
// verified profile (email + best-effort name). Throws a status-tagged error on
// any failure so the route can redirect to a friendly error.
export async function completeSsoCallback(code: string, codeVerifier: string, nonce: string): Promise<SsoProfile> {
  // Step logging so a crash/hang shows WHERE it died in the backend terminal.
  // eslint-disable-next-line no-console
  console.log("[sso] step 1/4 — exchanging code for tokens…");
  const tokens = await exchangeCode(code, codeVerifier);
  // eslint-disable-next-line no-console
  console.log("[sso] step 2/4 — token response received (id_token:", !!tokens.id_token, ")");
  return resolveSsoProfile(tokens, nonce);
}

// NATIVE / MOBILE SIGN-IN (POST /api/auth/sso/token). The Flutter app runs the
// OIDC Authorization Code + PKCE exchange itself (system browser → IdP → app via
// its own registered redirect) and hands us the RESULT: the IdP's id_token (+ the
// access_token for /userinfo, + the nonce it generated). We never see its code or
// verifier — so the id_token signature/iss/aud/exp/nonce check is the entire trust
// boundary here, exactly as in the web callback, and the same profile pipeline
// (userinfo → *_enc → claims_jwe) runs on top of it.
export async function completeSsoTokenLogin(
  body: { id_token?: unknown; access_token?: unknown; nonce?: unknown },
): Promise<SsoProfile> {
  const idToken = typeof body.id_token === "string" ? body.id_token.trim() : "";
  const accessToken = typeof body.access_token === "string" ? body.access_token.trim() : "";
  const nonce = typeof body.nonce === "string" ? body.nonce.trim() : "";
  if (!idToken || idToken.split(".").length !== 3) throw ssoErr(400, "id_token is required (compact JWS).");
  // eslint-disable-next-line no-console
  console.log("[sso] token login — id_token received (access_token:", !!accessToken, ", nonce:", !!nonce, ")");
  return resolveSsoProfile({ id_token: idToken, access_token: accessToken || undefined }, nonce);
}

// Shared tail of both sign-in paths: verify the id_token, then resolve the profile.
async function resolveSsoProfile(
  tokens: { id_token?: string; access_token?: string },
  nonce: string,
): Promise<SsoProfile> {
  let claims: any = null;
  if (tokens.id_token) {
    // eslint-disable-next-line no-console
    console.log("[sso] step 3/4 — verifying id_token (JWKS + iss/aud/exp/nonce)…");
    claims = await verifyIdToken(tokens.id_token, nonce);
    // eslint-disable-next-line no-console
    console.log("[sso] step 3/4 — id_token verified OK");
  } else if (tokens.access_token) {
    // OAuth-only IdP (no id_token): fall back to the userinfo endpoint.
    claims = await userinfo(tokens.access_token);
  }
  if (!claims) throw ssoErr(502, "SSO returned no identity (no id_token or userinfo).");
  // eslint-disable-next-line no-console
  console.log("[sso] step 3/4 — id_token claim keys:", Object.keys(claims).join(","));
  // PROFILE RESOLUTION (guide v3 order): id_token → (+ /userinfo when the id_token
  // has no identity) → decrypt Fernet *_enc → decrypt RSA claims_jwe → decrypted
  // values win over plaintext. Only ever run on claims from a signature-verified
  // id_token or from /userinfo fetched with the access token we just received.
  const usableEmail = (c: any) => {
    const e = String(c?.email || c?.preferred_username || "").trim().toLowerCase();
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) ? e : "";
  };
  const decryptAll = async (c: Record<string, any>, from: string) => {
    const enc = resolveEncClaims(c);
    c = enc.claims;
    if (enc.decrypted.length) {
      // eslint-disable-next-line no-console
      console.log(`[sso] step 3/4 — ${from}: decrypted *_enc fields:`, enc.decrypted.join(","));
    }
    if (c.claims_jwe) {
      // eslint-disable-next-line no-console
      console.log(`[sso] step 3/4 — ${from}: decrypting claims_jwe (encrypted PII)…`);
      const pii = await decryptClaimsJwe(String(c.claims_jwe));
      const { claims_jwe: _drop, ...rest } = c;
      c = { ...rest, ...pii };
      // eslint-disable-next-line no-console
      console.log(`[sso] step 3/4 — ${from}: claims_jwe decrypted OK (keys: ${Object.keys(pii).join(",")})`);
    }
    return c;
  };
  claims = await decryptAll(claims, "id_token");
  // The IdP may keep PII out of the id_token entirely and serve it at /userinfo
  // (our `claims` request asks for both). Fetch it only when the id_token alone
  // did not yield an identity — one extra round-trip, only when needed.
  if (!usableEmail(claims) && tokens.access_token) {
    // eslint-disable-next-line no-console
    console.log("[sso] step 3/4 — no email in id_token; fetching /userinfo…");
    const ui = await userinfo(tokens.access_token);
    if (ui && typeof ui === "object") {
      // eslint-disable-next-line no-console
      console.log("[sso] step 3/4 — /userinfo claim keys:", Object.keys(ui).join(","));
      // id_token claims are signature-verified, so they win where both exist.
      const merged = await decryptAll({ ...ui, ...claims }, "userinfo");
      claims = merged;
    } else {
      // eslint-disable-next-line no-console
      console.log("[sso] step 3/4 — /userinfo returned nothing usable");
    }
  }
  const email = usableEmail(claims);
  if (!email) {
    // SELF-DIAGNOSING: say what WAS there and which PII channel is missing, so the
    // operator can act (register our public key / set the Fernet secret / ask the
    // SSO team to enable profile claims) without tailing the server log.
    const keys = Object.keys(claims);
    const encKeys = keys.filter((k) => k.endsWith("_enc"));
    const hints: string[] = [];
    if (!keys.includes("claims_jwe") && !keys.some((k) => k === "email"))
      hints.push("no claims_jwe — CoLab's public key (keys/agenxchange_public.pem) may not be registered on the IdP yet");
    if (encKeys.length && !String(config.sso.profileEncSecret || "").trim())
      hints.push(`encrypted fields present (${encKeys.join(",")}) but SSO_PROFILE_ENC_SECRET is not set`);
    if (!keys.some((k) => /email|claims_jwe|_enc$/.test(k)))
      hints.push("the IdP sent no profile claims at all — check that client `collab` has scope `profile email` and profile claims enabled");
    throw ssoErr(
      400,
      `SSO identity has no usable email claim. Claims received: [${keys.join(", ")}].${hints.length ? " " + hints.join("; ") + "." : ""}`,
    );
  }
  const name = String(claims.name || claims.given_name || email.split("@")[0] || "").trim();
  // IdP group/role claims (only if the IdP is configured to send them) — feed
  // SSO_GROUP_ROLE_MAP so SSO users land in the right role. Claim name varies by IdP.
  const groupsRaw = claims.groups ?? claims.roles ?? claims.role ?? [];
  const groups = Array.isArray(groupsRaw)
    ? groupsRaw.map((g: any) => String(g))
    : groupsRaw
      ? [String(groupsRaw)]
      : [];
  const picture = typeof claims.picture === "string" && /^https?:\/\//i.test(claims.picture) ? claims.picture : "";
  const department = String(claims.department || "").trim();
  const employeeId = String(claims.employee_id ?? claims.employeeId ?? "").trim();
  return { email, name, groups, picture, department, employeeId };
}

export function ssoConfigured(): boolean {
  const c = config.sso;
  return !!(c.enabled && c.clientId && c.redirectUri && (c.authorizeUrl || c.issuer));
}
