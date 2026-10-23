// E2EE kill switch: when NEXT_PUBLIC_E2EE_ENABLED is not "true", all blob
// encryption/decryption is bypassed. The codebase is preserved intact.
const E2EE_ENABLED = process.env.NEXT_PUBLIC_E2EE_ENABLED === "true";

// Browser-native base64 (no Node `Buffer`). Webpack 5 does NOT polyfill Buffer
// in the client bundle, so the previous `Buffer.from(...)` calls threw a
// ReferenceError the moment file-E2EE actually ran. Mirror manager.ts's helpers.
function b64enc(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}
function b64dec(s: string): Uint8Array {
  if (!s) return new Uint8Array(0);
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch (_) {
    return new Uint8Array(0);
  }
}

export async function generateSymmetricKey() {
  return await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
}

export async function exportKey(key: CryptoKey) {
  const exported = await crypto.subtle.exportKey("raw", key);
  return b64enc(exported);
}

export async function importKey(keyBase64: string) {
  const keyBuffer = b64dec(keyBase64);
  return await crypto.subtle.importKey(
    "raw",
    keyBuffer as BufferSource,
    { name: "AES-GCM" },
    true,
    ["encrypt", "decrypt"]
  );
}

export async function encryptBlob(blob: Blob): Promise<{ encryptedBlob: Blob; key: string; iv: string }> {
  // When E2EE is disabled, return the blob unmodified with empty key/iv so
  // callers that check isE2EEEnabled() won't reach this, but if they do, it's safe.
  if (!E2EE_ENABLED) {
    return { encryptedBlob: blob, key: "", iv: "" };
  }
  const key = await generateSymmetricKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const arrayBuffer = await blob.arrayBuffer();

  const encryptedBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    arrayBuffer
  );

  const exportedKey = await exportKey(key);
  const ivBase64 = b64enc(iv);

  return {
    encryptedBlob: new Blob([encryptedBuffer], { type: blob.type }),
    key: exportedKey,
    iv: ivBase64,
  };
}

export async function decryptBlob(encryptedBlob: Blob, keyBase64: string, ivBase64: string, type: string): Promise<Blob> {
  const key = await importKey(keyBase64);
  const iv = b64dec(ivBase64);
  const arrayBuffer = await encryptedBlob.arrayBuffer();

  const decryptedBuffer = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    arrayBuffer
  );

  return new Blob([decryptedBuffer], { type });
}

// ─── Chunked (streamable) E2EE for video ─────────────────────────────────────
//
// A whole-file AES-GCM blob (encryptBlob above) can only be decrypted AFTER the
// entire ciphertext + trailing tag has downloaded — so a large video must fully
// download before a single frame plays. For streaming we instead encrypt the
// video in fixed PLAINTEXT chunks, each an independent AES-GCM message, so any
// byte range can be decrypted from just the chunks that cover it (what the
// decrypt-on-play Service Worker does).
//
// Format: for chunk index i, nonce = ivPrefix(8 random bytes) || uint32BE(i);
// ciphertext = concat of [ct_i || 16B tag] for every chunk, so chunk i lives at a
// DETERMINISTIC offset i*chunkCipher in the body. The per-file key never repeats
// and each chunk's nonce is unique (unique prefix + unique index), so GCM is safe.
// The key encoding (raw 32-byte, base64) is identical to encryptBlob, so the
// envelope + per-device key-wrapping are unchanged — only env.stream is added.

export interface StreamManifest {
  v: number;
  chunkPlain: number; // plaintext bytes per chunk
  chunkCipher: number; // ciphertext bytes per full chunk (= chunkPlain + 16 tag)
  count: number; // number of chunks
  plainSize: number; // total plaintext length
  ivPrefix: string; // base64 of the 8-byte per-file nonce prefix
}

function u32be(n: number): Uint8Array {
  const b = new Uint8Array(4);
  b[0] = (n >>> 24) & 0xff;
  b[1] = (n >>> 16) & 0xff;
  b[2] = (n >>> 8) & 0xff;
  b[3] = n & 0xff;
  return b;
}

const STREAM_CHUNK_PLAIN = 1 << 20; // 1 MiB
const GCM_TAG = 16;

export async function encryptBlobChunked(
  blob: Blob,
  chunkPlain: number = STREAM_CHUNK_PLAIN,
): Promise<{ encryptedBlob: Blob; key: string; manifest: StreamManifest }> {
  if (!E2EE_ENABLED) {
    return {
      encryptedBlob: blob,
      key: "",
      manifest: { v: 1, chunkPlain, chunkCipher: chunkPlain + GCM_TAG, count: 0, plainSize: blob.size, ivPrefix: "" },
    };
  }
  const key = await generateSymmetricKey();
  const ivPrefix = crypto.getRandomValues(new Uint8Array(8));
  const buf = new Uint8Array(await blob.arrayBuffer());
  const plainSize = buf.length;
  const count = Math.max(1, Math.ceil(plainSize / chunkPlain));
  const parts: BlobPart[] = [];
  for (let i = 0; i < count; i++) {
    const start = i * chunkPlain;
    const slice = buf.subarray(start, Math.min(start + chunkPlain, plainSize));
    const nonce = new Uint8Array(12);
    nonce.set(ivPrefix, 0);
    nonce.set(u32be(i), 8);
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce },
      key,
      slice as BufferSource,
    );
    parts.push(ct);
  }
  return {
    encryptedBlob: new Blob(parts, { type: blob.type }),
    key: await exportKey(key),
    manifest: { v: 1, chunkPlain, chunkCipher: chunkPlain + GCM_TAG, count, plainSize, ivPrefix: b64enc(ivPrefix) },
  };
}

// Fallback (no Service Worker / streaming unavailable): decrypt EVERY chunk and
// concatenate into one plaintext blob — the download-then-play path for a chunked
// video. The SW does the same math but per-range.
export async function decryptChunkedToBlob(
  encryptedBlob: Blob,
  keyBase64: string,
  manifest: StreamManifest,
  type: string,
): Promise<Blob> {
  const key = await importKey(keyBase64);
  const ivPrefix = b64dec(manifest.ivPrefix);
  const buf = new Uint8Array(await encryptedBlob.arrayBuffer());
  const { chunkCipher, count } = manifest;
  const parts: BlobPart[] = [];
  for (let i = 0; i < count; i++) {
    const start = i * chunkCipher;
    const end = i === count - 1 ? buf.length : start + chunkCipher;
    const nonce = new Uint8Array(12);
    nonce.set(ivPrefix, 0);
    nonce.set(u32be(i), 8);
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce },
      key,
      buf.subarray(start, end) as BufferSource,
    );
    parts.push(pt);
  }
  return new Blob(parts, { type });
}
