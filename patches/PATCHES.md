# Patches

This project uses [patch-package](https://github.com/ds300/patch-package) to fix bugs in dependencies. Patches are applied automatically on `npm install` via the `postinstall` script.

All patches target the specific dependency versions listed below. After upgrading a patched dependency, verify whether the upstream fix has been merged and remove the patch if so.

> **Note:** `react-native-quick-crypto` contains symlinks in its bundled `OpenSSL.xcframework`, which prevents `patch-package` from auto-generating patches. To regenerate that patch, use `git diff` manually against a clean copy of the package (see procedure below).

---

## react-native+0.76.9.patch

**File changed:** `ReactCommon/jsc/JSCRuntime.cpp`

### Problem

React Native's JSC (JavaScriptCore) runtime has `JSCRuntime::createArrayBuffer()` stubbed as:

```cpp
throw std::logic_error("Not implemented");
```

This breaks any NitroModules HybridObject method that returns an `ArrayBuffer` from native to JS (e.g., `Hash.digest()` in react-native-quick-crypto). The error surfaces as:

```
Hash.digest(...): Not implemented
```

### Fix

Implements `createArrayBuffer()` using the JSC C API function `JSObjectMakeArrayBufferWithBytesNoCopy`. The implementation:

1. Moves the `shared_ptr<MutableBuffer>` onto the heap so it outlives the function call.
2. Creates a JSC ArrayBuffer that points directly to the buffer's data (zero-copy).
3. Registers a deallocator callback that deletes the shared_ptr when the JS garbage collector collects the ArrayBuffer.
4. Cleans up the heap allocation on failure before re-throwing.

### Upstream status

Not yet fixed in react-native 0.76.x. The Hermes engine implements this method; only JSC is missing it.

---

## react-native-quick-crypto+1.0.7.patch

**Files changed:**
- `cpp/random/HybridRandom.cpp`
- `src/random.ts`

### Problem 1: NULL pointer crash in native randomFillSync (SIGSEGV)

After extended runtime (~9 hours), the app crashes with a SIGSEGV in OpenSSL's `RAND_bytes` writing to address `0x0`. The crash originates from `HybridRandom::randomFillSync()` at line 42.

**Root cause:** `buffer.get()->data()` can return `nullptr` when the JS ArrayBuffer reference has been invalidated. NitroModules' `JSArrayBuffer::data()` is explicitly marked `NULLABLE` and returns `nullptr` when:
- The JS garbage collector has collected the underlying ArrayBuffer
- WASM memory growth has detached the ArrayBuffer
- The `BorrowingReference` to the JS object is no longer valid

The native code had **no null check** before passing the pointer to `RAND_bytes()`.

**Fix (HybridRandom.cpp):** Added a null check on the data pointer before calling `RAND_bytes`. If null, throws a descriptive `std::runtime_error` that surfaces as a catchable JS exception instead of a fatal SIGSEGV.

### Problem 2: WASM memory corruption from TypedArray view handling

The original `randomFillSync` TypeScript implementation calls `abvToArrayBuffer(buffer)` which extracts the underlying `.buffer` property from TypedArray views. This **discards the view's `byteOffset` and `byteLength`**, using the full underlying ArrayBuffer's `byteLength` instead.

When automerge's WASM module calls `crypto.getRandomValues(wasmMemoryView)`:
- The TypedArray's `.buffer` is `WebAssembly.Memory.buffer` (the entire WASM linear memory, potentially megabytes)
- `abvToArrayBuffer()` returns this full buffer
- `size ?? buffer.byteLength` resolves to the entire WASM memory size
- The native side writes random bytes to the **entire WASM linear memory**, destroying the heap, stack, and all data

This causes automerge to crash with `RuntimeError: Out of bounds memory access` on the next WASM allocation (e.g., `dlmalloc::malloc` during `AutoCommit::new`).

> This bug exists in the **unpatched original code** as well, not just our patch. It is masked when WASM rarely calls `getRandomValues`, but is triggered reliably when automerge's Rust code needs random bytes for HashMap seeding.

**Fix (random.ts):** Rewrote `randomFillSync` to:

1. **Preserve TypedArray view info** before extracting the underlying buffer: reads `buffer.byteOffset` and `buffer.byteLength` from the original TypedArray, so we know exactly which portion of the underlying buffer to fill.
2. **Create an owned ArrayBuffer** of just the fill size (not the entire underlying buffer). This ensures the native side always receives a valid, correctly-sized buffer that won't be detached by WASM memory growth or GC.
3. **Copy random bytes back** to the exact correct position in the original buffer using `viewByteOffset + offset`.

### Upstream status

Neither fix has been submitted upstream to react-native-quick-crypto.

---

## Regenerating the quick-crypto patch

Because `patch-package` cannot handle symlinks in `OpenSSL.xcframework`, use this manual procedure:

```bash
# 1. Get a clean copy of the package
npm pack react-native-quick-crypto@1.0.7 --pack-destination /tmp
mkdir -p /tmp/qc-orig && tar -xzf /tmp/react-native-quick-crypto-1.0.7.tgz -C /tmp/qc-orig

# 2. Set up a temp git repo for diffing
mkdir /tmp/qc-git && cd /tmp/qc-git && git init
mkdir -p node_modules/react-native-quick-crypto/{cpp/random,src}
cp /tmp/qc-orig/package/cpp/random/HybridRandom.cpp node_modules/react-native-quick-crypto/cpp/random/
cp /tmp/qc-orig/package/src/random.ts node_modules/react-native-quick-crypto/src/
git add . && git commit -m "original"

# 3. Copy in your modified files
cp <project>/node_modules/react-native-quick-crypto/cpp/random/HybridRandom.cpp node_modules/react-native-quick-crypto/cpp/random/
cp <project>/node_modules/react-native-quick-crypto/src/random.ts node_modules/react-native-quick-crypto/src/

# 4. Generate the patch
git diff --no-color > <project>/patches/react-native-quick-crypto+1.0.7.patch
```
