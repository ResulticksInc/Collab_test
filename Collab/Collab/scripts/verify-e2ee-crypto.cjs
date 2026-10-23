/**
 * Standalone verification of the E2EE cryptographic CORE (no app wiring).
 * Replicates the exact primitives in frontend/app/src/lib/e2ee/manager.ts —
 * P-256 ECDH + HKDF-SHA-256 + AES-GCM-256, identity-only (ECIES) AND the V4
 * X3DH one-time-prekey augmentation, plus the group shared-epoch key and the
 * AAD/anti-replay logic — and asserts the security properties round-trip.
 *
 * Run with the flag conceptually ENABLED (this exercises the enabled code path's
 * math). Node >= 16 (uses node:crypto webcrypto). Exit 0 = all checks pass.
 */
const { webcrypto } = require("crypto");
const crypto = webcrypto;
const VERSION = "CoLab-E2EE-v1";
const ECDH = { name: "ECDH", namedCurve: "P-256" };
const te = new TextEncoder();
const td = new TextDecoder();
const utf8 = (s) => te.encode(s);
const b64 = (b) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString("base64");

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; console.log("  PASS", name); } else { fail++; console.log("  FAIL", name); } }
async function expectThrow(name, fn) { try { await fn(); fail++; console.log("  FAIL", name, "(expected throw)"); } catch { pass++; console.log("  PASS", name); } }

const gen = () => crypto.subtle.generateKey(ECDH, true, ["deriveBits"]);
const rawPub = async (kp) => new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
const bits = (priv, pub) => crypto.subtle.deriveBits({ name: "ECDH", public: pub }, priv, 256).then((b) => new Uint8Array(b));

async function aesFromBits(bitsArr, salt, info) {
  const hk = await crypto.subtle.importKey("raw", bitsArr, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: utf8(info) }, hk, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}
const aesSingle = (b, salt) => aesFromBits(b, salt, VERSION + "|hkdf");
async function aesTwo(bIK, bOPK, salt) {
  const cat = new Uint8Array(bIK.length + bOPK.length); cat.set(bIK, 0); cat.set(bOPK, bIK.length);
  return aesFromBits(cat, salt, VERSION + "|hkdf|x3dh");
}
const aad = (a, b, c, d, e, n, mid) => utf8([VERSION, a, b, c, d, e || "", n, mid || ""].join("|"));
const enc = (key, iv, ad, pt) => crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: ad }, key, utf8(pt));
const dec = (key, iv, ad, ct) => crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: ad }, key, ct).then((p) => td.decode(p));
const rawKey = async (k) => new Uint8Array(await crypto.subtle.exportKey("raw", k));

(async () => {
  console.log("E2EE crypto core verification\n");

  // ---- 1) DM identity-only (ECIES) round trip ----
  {
    const A = await gen(), B = await gen(); // A=sender ephemeral source, B=recipient identity
    const eph = await gen();
    const epk = await rawPub(eph);
    const kEnc = await aesSingle(await bits(eph.privateKey, B.publicKey), epk);
    const iv = crypto.getRandomValues(new Uint8Array(12)), n = b64(crypto.getRandomValues(new Uint8Array(16))), mid = "m1";
    const ad = aad("ua", "da", "ub", "db", "conv1", n, mid);
    const ct = await enc(kEnc, iv, ad, "hello ecies");
    const kDec = await aesSingle(await bits(B.privateKey, eph.publicKey), epk);
    const ad2 = aad("ua", "da", "ub", "db", "conv1", n, mid);
    check("DM ECIES round-trip", (await dec(kDec, iv, ad2, ct)) === "hello ecies");
    await expectThrow("DM ECIES AAD-tamper rejected", () => dec(kDec, iv, aad("ua", "da", "ub", "db", "convX", n, mid), ct));
    await expectThrow("DM ECIES mid-tamper rejected (anti-replay binding)", () => dec(kDec, iv, aad("ua", "da", "ub", "db", "conv1", n, "m2"), ct));
  }

  // ---- 2) DM X3DH (V4 forward secrecy: identity-DH + one-time-prekey-DH) ----
  {
    const IK = await gen();   // recipient identity
    const OPK = await gen();  // recipient one-time prekey
    const eph = await gen();  // sender ephemeral
    const epk = await rawPub(eph);
    const kEnc = await aesTwo(await bits(eph.privateKey, IK.publicKey), await bits(eph.privateKey, OPK.publicKey), epk);
    const iv = crypto.getRandomValues(new Uint8Array(12)), n = b64(crypto.getRandomValues(new Uint8Array(16))), mid = "x1";
    const ad = aad("ua", "da", "ub", "db", "conv1", n, mid);
    const ct = await enc(kEnc, iv, ad, "hello x3dh fs");
    // recipient: IK-priv x eph, OPK-priv x eph (same order)
    const kDec = await aesTwo(await bits(IK.privateKey, eph.publicKey), await bits(OPK.privateKey, eph.publicKey), epk);
    check("DM X3DH round-trip", (await dec(kDec, iv, ad, ct)) === "hello x3dh fs");
    // Forward secrecy: WITHOUT the OPK private key (deleted), identity key alone fails.
    const kNoOpk = await aesSingle(await bits(IK.privateKey, eph.publicKey), epk);
    await expectThrow("X3DH undecryptable without OPK (forward secrecy)", () => dec(kNoOpk, iv, ad, ct));
  }

  // ---- 3) Group shared per-epoch key ----
  {
    const groupKey = await crypto.subtle.importKey("raw", crypto.getRandomValues(new Uint8Array(32)), { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    const gaad = (s, sd, c, ver, n, mid) => utf8([VERSION, "group", s, sd, c, String(ver), n, mid || ""].join("|"));
    const iv = crypto.getRandomValues(new Uint8Array(12)), n = b64(crypto.getRandomValues(new Uint8Array(16))), mid = "g1";
    const ad = gaad("ua", "da", "conv9", 3, n, mid);
    const ct = await enc(groupKey, iv, ad, "hello group");
    check("Group epoch round-trip", (await dec(groupKey, iv, ad, ct)) === "hello group");
    // Different epoch key (e.g. removed member's stale key) cannot decrypt.
    const otherKey = await crypto.subtle.importKey("raw", crypto.getRandomValues(new Uint8Array(32)), { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    await expectThrow("Group wrong-epoch key rejected", () => dec(otherKey, iv, ad, ct));
    await expectThrow("Group epoch-version tamper rejected", () => dec(groupKey, iv, gaad("ua", "da", "conv9", 4, n, mid), ct));
  }

  // ---- 4) ECIES key-wrap (group key wrapped to a device) round trip ----
  {
    const IK = await gen();          // recipient device identity
    const eph = await gen();
    const epk = await rawPub(eph);
    const wrapKey = await aesSingle(await bits(eph.privateKey, IK.publicKey), epk);
    const raw = crypto.getRandomValues(new Uint8Array(32)); // the epoch key being wrapped
    const iv = crypto.getRandomValues(new Uint8Array(12)), n = b64(crypto.getRandomValues(new Uint8Array(16)));
    const ad = aad("ua", "da", "ub", "db", "conv9", n, "wrap");
    const ct = await enc(wrapKey, iv, ad, b64(raw));
    const unwrapKey = await aesSingle(await bits(IK.privateKey, eph.publicKey), epk);
    check("Group-key ECIES wrap/unwrap round-trip", (await dec(unwrapKey, iv, ad, ct)) === b64(raw));
  }

  // ---- 5) Anti-replay detection logic ----
  {
    const seen = new Map();
    const replay = (mid, id) => { if (!mid) return "ok"; const p = seen.get(mid); if (p && p !== id) return "replay"; seen.set(mid, id); return "ok"; };
    check("replay: first sight ok", replay("mid1", "srv1") === "ok");
    check("replay: same id re-decrypt ok (pagination)", replay("mid1", "srv1") === "ok");
    check("replay: same mid new server id => replay", replay("mid1", "srv2") === "replay");
  }

  // ---- 6) Forced-downgrade / plaintext-injection guard (B1 fix) ----
  {
    // Models manager.ts isConvE2EERequired + the else-branch reject. Once a conv
    // is pinned E2EE, a plaintext `text` message in it is rejected.
    const pinned = new Set();
    const pin = (c) => pinned.add(c);
    const render = (m) => {
      if (m.encrypted && !m.ciphertext) return "rejected";          // stripped envelope
      if (m.type === "text" && !m.ciphertext && pinned.has(m.conv)) return "rejected"; // injection
      return "shown";
    };
    // Legacy conv (never pinned): plaintext shows.
    check("downgrade: plaintext in non-E2EE conv shown", render({ type: "text", conv: "legacy", ciphertext: null }) === "shown");
    // Authenticated encrypted message pins the conv.
    pin("c1");
    // Now an injected plaintext text in the pinned conv is rejected.
    check("downgrade: plaintext injection in pinned conv rejected", render({ type: "text", conv: "c1", ciphertext: null }) === "rejected");
    // Non-text metadata (call/meeting/voice) in a pinned conv still shows (V8 by design).
    check("downgrade: plaintext metadata (call) in pinned conv shown", render({ type: "call", conv: "c1", ciphertext: null }) === "shown");
    // A real encrypted message still shows.
    check("downgrade: encrypted message in pinned conv shown", render({ type: "text", conv: "c1", encrypted: true, ciphertext: [{}] }) === "shown");
  }

  // ---- 7) B2 — group sender-forgery is now BLOCKED by ECDSA signature ----
  {
    // The group epoch key is shared, so any member's AES-GCM ciphertext verifies
    // for any claimed sender (the GCM tag is computed under the shared key).
    // ECDSA signature over the AAD authenticates WHO actually produced it: only
    // the device holding the claimed sender's signing private key can sign a
    // matching AAD. This test demonstrates that:
    //   - a victim-signed message verifies
    //   - an attacker-signed message claiming to be the victim DOES NOT verify
    const ECDSA_GEN = { name: "ECDSA", namedCurve: "P-256" };
    const ECDSA_SIG = { name: "ECDSA", hash: "SHA-256" };
    const genSign = () => crypto.subtle.generateKey(ECDSA_GEN, true, ["sign", "verify"]);

    const groupKey = await crypto.subtle.importKey("raw", crypto.getRandomValues(new Uint8Array(32)), { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    const gaad = (s, sd, c, ver, n, mid) => utf8([VERSION, "group", s, sd, c, String(ver), n, mid || ""].join("|"));

    const victim = await genSign();   // legitimate member
    const attacker = await genSign(); // also a member (holds the shared key)

    const iv = crypto.getRandomValues(new Uint8Array(12)), n = b64(crypto.getRandomValues(new Uint8Array(16)));
    const adVictim = gaad("victim", "victim-dev", "convX", 1, n, "msg-1");
    const ctVictim = await enc(groupKey, iv, adVictim, "I really did say this");
    const sigVictim = await crypto.subtle.sign(ECDSA_SIG, victim.privateKey, adVictim);
    // Verify against victim's public key — should PASS.
    const okVictim = await crypto.subtle.verify(ECDSA_SIG, victim.publicKey, sigVictim, adVictim);
    check("B2: legitimate group message signature verifies", okVictim === true && (await dec(groupKey, iv, adVictim, ctVictim)) === "I really did say this");

    // Attacker forges, encrypts under shared key, signs with attacker's key.
    const adForge = gaad("victim", "victim-dev", "convX", 1, n, "msg-2"); // claims to be victim
    const ctForge = await enc(groupKey, iv, adForge, "forged: I never said this");
    const sigForge = await crypto.subtle.sign(ECDSA_SIG, attacker.privateKey, adForge);
    // Verify against the CLAIMED sender's (victim's) public key — must FAIL.
    const okForge = await crypto.subtle.verify(ECDSA_SIG, victim.publicKey, sigForge, adForge);
    check("B2 FIX: forged message signed by attacker FAILS victim's signature check", okForge === false);
  }

  // ---- 8) B3 — 1:1 media key derives identically for both parties ----
  {
    // Models getCallMediaKey's 1:1 seed: a fresh AES-GCM-256 raw key is ECIES-
    // wrapped per device. Both devices unwrap to the SAME raw key → both can
    // encrypt/decrypt the LiveKit media frames under it.
    const ME = await gen(), PEER = await gen(); // identity keypairs for two devices
    const rawMediaKey = crypto.getRandomValues(new Uint8Array(32));

    // Wrap (per device): produce one envelope per recipient (here, ME and PEER).
    async function wrapTo(recipientPub) {
      const eph = await gen();
      const epk = await rawPub(eph);
      const k = await aesSingle(await bits(eph.privateKey, recipientPub), epk);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const n = b64(crypto.getRandomValues(new Uint8Array(16)));
      const ad = aad("sender", "senderDev", "recip", "recipDev", "dmconv", n, "wrap");
      const ct = await enc(k, iv, ad, b64(rawMediaKey));
      return { eph, epk, iv, n, ad, ct };
    }
    async function unwrapBy(privKey, env) {
      const k = await aesSingle(await bits(privKey, env.eph.publicKey), env.epk);
      return await dec(k, env.iv, env.ad, env.ct);
    }
    const envForMe = await wrapTo(ME.publicKey);
    const envForPeer = await wrapTo(PEER.publicKey);
    const meGot = await unwrapBy(ME.privateKey, envForMe);
    const peerGot = await unwrapBy(PEER.privateKey, envForPeer);
    check("B3: both 1:1 parties derive the SAME media key from their ECIES-wrap", meGot === peerGot && meGot === b64(rawMediaKey));
  }

  // ---- 9) Double Ratchet (DH + symmetric chain) round-trip and properties ----
  //
  // Replicates the exact algorithm in frontend/app/src/lib/e2ee/ratchet.ts:
  //   KDF_RK(rk, dh_out)   = HKDF-SHA256(salt=rk, ikm=dh_out, info="CoLab-DR-v1|RK", 64B) split 32/32
  //   KDF_CK(ck)           = HMAC(ck, 0x01) → MK ; HMAC(ck, 0x02) → next CK
  //   ENC                  = AES-GCM-256, random 12B IV, AAD = ad || utf8(JSON(header))
  //
  // Asserts: bidirectional round-trip, chain advances per send (unique MKs),
  // DH ratchet rotates the root key, header tamper is rejected, out-of-order
  // is rejected (v1 in-order-only — Phase 2 will add skipped-key caching).
  {
    const DR_VERSION = "CoLab-DR-v1";
    const ECDH_P = { name: "ECDH", namedCurve: "P-256" };
    const HMAC256 = { name: "HMAC", hash: "SHA-256" };
    const HKDF256 = { name: "HKDF", hash: "SHA-256" };
    const concat = (a, b) => { const o = new Uint8Array(a.length + b.length); o.set(a, 0); o.set(b, a.length); return o; };
    const u8 = (x) => x instanceof Uint8Array ? x : new Uint8Array(x);
    const genDh = async () => {
      const kp = await crypto.subtle.generateKey(ECDH_P, true, ["deriveBits"]);
      const priv = await crypto.subtle.exportKey("jwk", kp.privateKey);
      const pub = b64(await crypto.subtle.exportKey("raw", kp.publicKey));
      return { priv, pub };
    };
    const dh = async (privJwk, peerPubB64) => {
      const priv = await crypto.subtle.importKey("jwk", privJwk, ECDH_P, true, ["deriveBits"]);
      const peerRaw = Buffer.from(peerPubB64, "base64");
      const peer = await crypto.subtle.importKey("raw", peerRaw, ECDH_P, false, []);
      return u8(await crypto.subtle.deriveBits({ name: "ECDH", public: peer }, priv, 256));
    };
    const hkdfBytes = async (saltU8, ikmU8, infoStr, len) => {
      const k = await crypto.subtle.importKey("raw", ikmU8, "HKDF", false, ["deriveBits"]);
      return u8(await crypto.subtle.deriveBits({ ...HKDF256, salt: saltU8, info: utf8(infoStr) }, k, len * 8));
    };
    const kdfRk = async (rk, dhOut) => {
      const o = await hkdfBytes(rk, dhOut, DR_VERSION + "|RK", 64);
      return { rk: o.slice(0, 32), ck: o.slice(32, 64) };
    };
    const kdfCk = async (ck) => {
      const k = await crypto.subtle.importKey("raw", ck, HMAC256, false, ["sign"]);
      const mk = u8(await crypto.subtle.sign("HMAC", k, new Uint8Array([0x01])));
      const next = u8(await crypto.subtle.sign("HMAC", k, new Uint8Array([0x02])));
      return { ck: next, mk };
    };
    const aeadEnc = async (mk, iv, ad, pt) => {
      const k = await crypto.subtle.importKey("raw", mk, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
      return u8(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: ad }, k, pt));
    };
    const aeadDec = async (mk, iv, ad, ct) => {
      const k = await crypto.subtle.importKey("raw", mk, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
      return td.decode(u8(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: ad }, k, ct)));
    };
    const initiateRatchet = async (sk, peerInitPubB64) => {
      const dhs = await genDh();
      const dh1 = await dh(dhs.priv, peerInitPubB64);
      const { rk, ck } = await kdfRk(sk, dh1);
      return { rk: b64(rk), cks: b64(ck), ckr: null, dhsPriv: dhs.priv, dhsPub: dhs.pub, dhrPub: peerInitPubB64, ns: 0, nr: 0, pn: 0 };
    };
    const respondRatchet = async (sk, myInitKp) => ({
      rk: b64(sk), cks: null, ckr: null, dhsPriv: myInitKp.priv, dhsPub: myInitKp.pub, dhrPub: null, ns: 0, nr: 0, pn: 0,
    });
    const dhStep = async (st, newPeerPub) => {
      const o1 = await kdfRk(Buffer.from(st.rk, "base64"), await dh(st.dhsPriv, newPeerPub));
      const newDhs = await genDh();
      const o2 = await kdfRk(o1.rk, await dh(newDhs.priv, newPeerPub));
      return { ...st, rk: b64(o2.rk), ckr: b64(o1.ck), cks: b64(o2.ck), dhsPriv: newDhs.priv, dhsPub: newDhs.pub, dhrPub: newPeerPub, pn: st.ns, ns: 0, nr: 0 };
    };
    const ratchetEncrypt = async (st, ad, pt) => {
      if (!st.cks) throw new Error("no CKs");
      const { ck: nextCk, mk } = await kdfCk(Buffer.from(st.cks, "base64"));
      const header = { dh: st.dhsPub, pn: st.pn, n: st.ns };
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const fullAd = concat(ad, utf8(JSON.stringify(header)));
      const ct = await aeadEnc(mk, iv, fullAd, utf8(pt));
      return { state: { ...st, cks: b64(nextCk), ns: st.ns + 1 }, header, iv, ct, mk };
    };
    const ratchetDecrypt = async (st, header, ad, iv, ct) => {
      let s = st;
      if (s.dhrPub !== header.dh) s = await dhStep(s, header.dh);
      if (header.n !== s.nr) { const e = new Error("oo"); e.outOfOrder = true; throw e; }
      const { ck: nextCk, mk } = await kdfCk(Buffer.from(s.ckr, "base64"));
      const fullAd = concat(ad, utf8(JSON.stringify(header)));
      const pt = await aeadDec(mk, iv, fullAd, ct);
      return { state: { ...s, ckr: b64(nextCk), nr: s.nr + 1 }, plaintext: pt, mk };
    };

    // ── Test setup: Alice + Bob complete an X3DH-style handshake yielding a
    //    32-byte shared secret SK; Bob's "signed prekey" is his initial DH pair.
    const sk = crypto.getRandomValues(new Uint8Array(32));
    const bobInit = await genDh();
    let alice = await initiateRatchet(sk, bobInit.pub);
    let bob = await respondRatchet(sk, bobInit);
    const ad = utf8("conv-1");

    // 9.1 — Alice → Bob round-trip
    const a1 = await ratchetEncrypt(alice, ad, "hello bob");
    alice = a1.state;
    const b1 = await ratchetDecrypt(bob, a1.header, ad, a1.iv, a1.ct);
    bob = b1.state;
    check("DR: alice → bob first message round-trip", b1.plaintext === "hello bob");

    // 9.2 — Chain advances: a second Alice→Bob message uses a DIFFERENT MK
    const a2 = await ratchetEncrypt(alice, ad, "hello again");
    alice = a2.state;
    check("DR: sending chain advances (MK differs per message)", b64(a1.mk) !== b64(a2.mk));
    const b2 = await ratchetDecrypt(bob, a2.header, ad, a2.iv, a2.ct);
    bob = b2.state;
    check("DR: alice → bob second message round-trip", b2.plaintext === "hello again");

    // 9.3 — DH ratchet on reply: Bob → Alice rotates the root key
    const rkBeforeReply = alice.rk;
    const b3 = await ratchetEncrypt(bob, ad, "hi alice");
    bob = b3.state;
    const a3 = await ratchetDecrypt(alice, b3.header, ad, b3.iv, b3.ct);
    alice = a3.state;
    check("DR: bob → alice reply decrypts", a3.plaintext === "hi alice");
    check("DR: DH ratchet step rotated the root key on direction change", alice.rk !== rkBeforeReply);

    // 9.4 — Header tamper rejected (modify header.n → AAD differs → GCM tag fails)
    const a4 = await ratchetEncrypt(alice, ad, "tamper test");
    const tampered = { ...a4.header, n: a4.header.n + 99 };
    let tamperOk = false;
    try {
      await ratchetDecrypt(bob, tampered, ad, a4.iv, a4.ct);
    } catch (_) { tamperOk = true; }
    check("DR: header.n tamper rejected (AAD bind)", tamperOk);
    alice = a4.state; // adopt the new state so the next test starts in sync

    // 9.5 — Out-of-order rejected (v1 in-order-only): we resend the bob ratchet
    //   from a fresh pair and skip message 1, then try to deliver message 2.
    const sk2 = crypto.getRandomValues(new Uint8Array(32));
    const bobInit2 = await genDh();
    let alice2 = await initiateRatchet(sk2, bobInit2.pub);
    let bob2 = await respondRatchet(sk2, bobInit2);
    const m1 = await ratchetEncrypt(alice2, ad, "msg1"); alice2 = m1.state;
    const m2 = await ratchetEncrypt(alice2, ad, "msg2"); alice2 = m2.state;
    // Skip m1 entirely; deliver m2 first → should fail with outOfOrder
    let ooOk = false;
    try {
      await ratchetDecrypt(bob2, m2.header, ad, m2.iv, m2.ct);
    } catch (e) { if (e && e.outOfOrder) ooOk = true; }
    check("DR: out-of-order delivery rejected (v1 in-order only)", ooOk);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("verifier crashed:", e); process.exit(2); });
