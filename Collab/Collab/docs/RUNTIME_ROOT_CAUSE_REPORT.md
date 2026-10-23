# Runtime Root Cause Report: `@signalapp/libsignal-client` ReferenceError

## Error Observed
```
ReferenceError: require is not defined
Stack: node-gyp-build/index.js -> @signalapp/libsignal-client/dist/Native.js -> frontend/app/.next/static/chunks/app/page.js
```

## Import Audit Results

### Files importing `@signalapp/libsignal-client`

| File | Import Type | Context |
|------|------------|---------|
| `frontend/app/src/lib/e2ee/manager.ts:3-20` | **Static top-level import** (PRIMARY CAUSE) | Shared module, eagerly pulls in entire Signal tree |
| `frontend/app/src/lib/e2ee/manager.ts:263` | Dynamic import (`await import()`) | Client code path inside `decryptMessage()` |
| `frontend/app/src/lib/e2ee/manager.ts:276` | Dynamic import (`await import()`) | Client code path inside `decryptMessage()` |
| `frontend/app/src/lib/e2ee/manager.ts:310` | Dynamic import (`await import()`) | Client code path inside `decryptMessageList()` |
| `frontend/app/src/lib/e2ee/manager.ts:352-355` | Dynamic import (`await import()`) | Client code path inside `distributeGroupSenderKey()` |

### Files importing `node-gyp-build` directly
None. The dependency is only indirect through `@signalapp/libsignal-client`.

### Import Chain to Browser Bundle
```
frontend/app/src/app/page.tsx ("use client")
  -> CoLabV1.tsx (lines 32-40, static import from e2ee/manager)
    -> manager.ts (lines 3-20, TOP-LEVEL static import of @signalapp/libsignal-client)
      -> @signalapp/libsignal-client/dist/index.js (line 5: `import { Buffer } from 'node:buffer'`)
      -> @signalapp/libsignal-client/dist/index.js (line 22: `import * as Native from './Native.js'`)
        -> @signalapp/libsignal-client/dist/Native.js (line 25: `import load from 'node-gyp-build'`)
          -> node-gyp-build calls require() at module evaluation time
            -> ReferenceError: require is not defined
```

## Runtime Analysis

### Package Type: Native Node Bindings (NOT browser-compatible)

**Evidence from `@signalapp/libsignal-client/dist/index.js`:**
- Line 5: `import { Buffer } from 'node:buffer';` — requires Node.js Buffer module
- Line 22: `import * as Native from './Native.js';` — loads native bindings

**Evidence from `@signalapp/libsignal-client/dist/Native.js`:**
- Line 25: `import load from 'node-gyp-build';` — uses node-gyp-build for loading compiled Rust NAPI bindings
- Line 26: `const { ... } = load(`${import.meta.dirname}/../`);` — loads `.node` binary files via `import.meta.dirname`

**Evidence from `@signalapp/libsignal-client/package.json`:**
- Version: 0.94.4
- Uses NAPI-RS (Rust bindings for Node.js)
- Contains precompiled native binaries in platform-specific subdirectories
- No WASM build available for this version
- No browser distribution

### Conclusion
`@signalapp/libsignal-client@0.94.4` is a **Node-only** package using compiled Rust NAPI bindings. It does NOT support:
- Browser execution
- WASM runtime
- Deno/Bun compatibility (without native addon emulation)

The `node:buffer` import, `import.meta.dirname`, and `node-gyp-build` are all Node.js-specific APIs that do not exist in browsers.

## Root Cause Summary

**Why does `require()` execute inside a browser bundle?**

The static top-level import of `@signalapp/libsignal-client` at line 3-20 of `manager.ts` causes Next.js/webpack to eagerly resolve and transpile the entire Signal dependency tree at build time. This includes `Native.js`, which imports `node-gyp-build`. Even though `CoLabV1.tsx` is marked as `"use client"`, it still gets bundled for browser execution. When webpack tries to evaluate the `node-gyp-build` module in the browser context, it encounters `require()` which does not exist in the browser JavaScript runtime.

**Which file triggers it?**
`frontend/app/src/lib/e2ee/manager.ts` — lines 3-20 (static top-level import)

**Which import chain causes it?**
`page.tsx` → `CoLabV1.tsx` → `e2ee/manager.ts` → `@signalapp/libsignal-client` → `Native.js` → `node-gyp-build`

## Fix Proposals

### Option A: Server-Side Crypto via API Routes (RECOMMENDED)
Move ALL `@signalapp/libsignal-client` operations to Next.js API routes or server actions. The client sends plaintext to the server, the server encrypts/decretes and stores Signal protocol state in database/IndexedDB. This is the only architecture that works with the current native Signal package.

**Trade-off:** True E2EE requires crypto on the client device. Moving crypto to the server means the server has access to plaintext messages. This should be clearly documented as a development workaround until a WASM-compatible Signal implementation is available.

### Option B: Externalize the Package + Graceful Degradation
Mark `@signalapp/libsignal-client` external in webpack config so it doesn't crash at build time, then wrap all crypto calls in try/catch that gracefully handles the "module not available" case. The app would load but encryption features would be disabled.

### Option C: Switch to WASM-Compatible Signal Library
Replace `@signalapp/libsignal-client` with a pure JavaScript/WASM implementation like `libsignal-protocol-javascript` or similar. This would require significant refactoring of the crypto layer.

### Selected Fix (Option B + Architecture Guard)
For immediate unblocking while maintaining code correctness:
1. Convert static top-level imports in `manager.ts` to dynamic lazy loading
2. Add `shouldExternalize` config for `@signalapp/libsignal-client` 
3. Wrap all crypto operations in environment-aware guards that return gracefully when the native module isn't available
4. This allows the app to load; encryption operations are deferred or skipped when Signal is unavailable

This is an immediate fix with clear migration path documented.