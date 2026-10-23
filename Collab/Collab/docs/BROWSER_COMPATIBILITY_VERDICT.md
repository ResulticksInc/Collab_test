# Browser Compatibility Verdict: @signalapp/libsignal-client@0.94.4

## VERDICT B: Package is NOT Browser Compatible

### Evidence (Code-Level)

**File: `@signalapp/libsignal-client/dist/index.js` Line 5:**
```js
import { Buffer } from 'node:buffer';
```
This imports Node's built-in Buffer module. While Webpack can polyfill this, it's not the blocker itself.

**File: `@signalapp/libsignal-client/dist/index.js` Line 22:**
```js
import * as Native from './Native.js';
```
Every exported class/function immediately delegates to `Native.*`. This import cannot be tree-shaken away because it is evaluated synchronously at module load time.

**File: `@signalapp/libsignal-client/dist/Native.js` Line 25:**
```js
import load from 'node-gyp-build';
```
This imports `node-gyp-build`, a Node-only module that loads compiled `.node` binary files.

**File: `@signalapp/libsignal-client/dist/Native.js` Line 26:**
```js
const { ... } = load(`${import.meta.dirname}/../`);
```
This calls `load()` at module evaluation time using `import.meta.dirname`, which points to the filesystem directory containing precompiled binary files (`.so`/`.dylib`/`.dll` native extensions).

**File: `@signalapp/libsignal-client/package.json`:**
- No `"browser"` field mapping to a browser-compatible alternate implementation.
- No WASM build included in the distribution.
- Uses NAPI-RS (Rust → Node.js) bindings exclusively.
- Platform-specific binary directories exist under prebuilds:
  - `napi-linux-x64-gnu/`
  - `napi-linux-arm64-gnu/`
  - `napi-darwin-x64/`
  - `napi-darwin-arm64/`
  - `napi-win32-x64-msvc/`

### Conclusion

This package **CANNOT** execute in a browser for the following reasons:

| API | Browser Support | Where Used |
|-----|----------------|------------|
| `node-gyp-build` | ❌ Not available | Native.js L25 |
| `import.meta.dirname` | ❌ Node-only | Native.js L26 |
| `require()` in CommonJS | ❌ ES module context | node-gyp-build internals |
| Native `.node` binaries | ❌ No loading mechanism | Prebuilt NAPI bindings |

### Dynamic Import Mitigation Assessment

Dynamic imports (`await import("@signalapp/libsignal-client")`) only defer the error. In a browser environment, webpack bundling will still attempt to process the module. Even if webpack externals prevent bundling, the dynamic import will throw at runtime because there is no `@signalapp/libsignal-client` global in the browser window.

**Result: Dynamic imports alone do not make Signal work in the browser. They only provide graceful failure.**

### Current E2EE Implementation Assessment

The current implementation in `frontend/app/src/lib/e2ee/manager.ts`:

| Operation | Can It Work in Browser? |
|-----------|------------------------|
| IdentityGeneration (PrivateKey.generate) | ❌ No — requires native crypto bindings |
| PreKey Generation (SignedPreKey, OneTimePreKey) | ❌ No — requires native serialization |
| Session Creation (X3DH / processPreKeyBundle) | ❌ No |
| Message Encryption (signalEncrypt) | ❌ No |
| Message Decryption (signalDecrypt) | ❌ No |
| Sender Key Management | ❌ No |

**Current E2EE implementation cannot function in the browser.**

---

# Replacement Strategy Analysis

## Option A: Server-Side Signal Crypto

Move ALL `@signalapp/libsignal-client` operations to Next.js API routes. The client sends plaintext to an encrypted API path; the server handles all Signal protocol operations and stores ciphertext.

| Metric | Assessment |
|--------|------------|
| Browser Compatibility | ✅ Native module runs on server only |
| Security Model | Server has access to plaintext during transit between API route and storage |
| True E2EE | ❌ No — server can read messages |
| Migration Complexity | Medium — refactor all crypto calls to API routes |
| Signal Compliance | ⚠️ Violates Signal's trust model |

### Option B: libsignal-protocol-javascript (WASM)

Signal's official JavaScript implementation, compiled from the same Rust source via Emscripten/WASM.

| Metric | Assessment |
|--------|------------|
| Browser Compatibility | ✅ Pure WASM + JS |
| Security Model | ✅ True client-side encryption |
| True E2EE | ✅ Yes |
| Maintenance | Active but separate from native client |
| Migration Complexity | High — API differences, need to adapt store interfaces |
| Bundle Size | ~4-6 MB WASM blob (lazy-loaded) |

### Option C: React-Signal / Signal Protocol JS Ports

Third-party implementations such as `signal-protocol-javascript`, `libsignal-wasm`.

| Metric | Assessment |
|--------|------------|
| Browser Compatibility | ✅ Pure JS/WASM |
| Security Model | ✅ Client-side |
| True E2EE | ✅ Yes |
| Maintenance | ⚠️ Varies by project maturity |
| Migration Complexity | Medium-High |
| Bundle Size | 1-4 MB depending on implementation |

## Recommendation: Option B (libsignal WASM) with Progressive Migration Path

### Phase 0 (Immediate - Runtime Recovery)

Use server-side API route guard for Signal operations. This fixes the crash immediately and provides a functional (albeit server-mediated) encryption path until WASM migration completes.

```
Client → API Route [Server-side Signal] → Database
           ^ Native module runs here ✅
```

This means E2EE works but should be labeled as **server-mediated encryption** during the transition period, with a TODO to migrate to true client-side E2EE.

### Phase 1 (Medium-term - True E2EE)

Migrate to WASM-compatible Signal implementation:
1. Install `libsignal-protocol-javascript` or equivalent WASM build
2. Create adapter layer matching the existing store interfaces
3. Replace API route encryption with client-side WASM calls
4. Remove server-side crypto dependency

### Phase 2 (Long-term - Cleanup)

Remove `@signalapp/libsignal-client` from frontend entirely once all crypto is WASM-based.

---

# Next Steps - Focus Chain Update

1. ✅ Root cause identified
2. ✅ Browser compatibility verdict delivered (VERDICT B)
3. ⬅️ CURRENT: Implement server-side API route guard to fix crash
4. → Evaluate specific WASM Signal library candidates
5. → Phase 3A validation (after runtime is stable)
6. → Phase 3B implementation (after Phase 3A validated)