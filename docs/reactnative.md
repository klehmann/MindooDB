# MindooDB for React Native

This guide covers setting up MindooDB in a React Native / Expo project with **native Automerge** for maximum performance.

## Why MindooDB for React Native?

🔐 **End-to-end encrypted** - Your data is encrypted on the device before it ever touches a server
📴 **Offline-first** - Full functionality without network; sync when connected
🚀 **Native performance** - Uses Rust instead of WebAssembly for CRDT operations
🤝 **Real-time collaboration** - Automatic conflict resolution for concurrent edits
✍️ **Signed changes** - Every change is cryptographically signed and tamper-proof

Perfect for: secure messaging apps, collaborative tools, offline-capable productivity apps, healthcare apps, and any app where data privacy matters.

## Prerequisites

- **Expo SDK 52+** with a development build (not Expo Go)
- **Node.js 20+**
- **iOS 13+** or **Android 6.0+ (API level 23+)**

## Quick Start

### 0. Fastest setup (recommended)

If you already have an Expo / React Native app, run:

```bash
npx mindoodb setup-react-native
```

This setup helper copies required patch files, configures `patch-package`, installs missing dependencies (including `react-native-automerge-generated`), and prints the Metro snippet you need.

Then continue with the initialization steps below.

> Recommended for real apps: run on an Expo dev build or production build with native modules enabled, not Expo Go.

### Runtime support matrix

| Runtime | Status | Recommendation |
|---------|--------|----------------|
| React Native dev build / production (Hermes + native modules) | Fully supported | Use native Automerge + `react-native-quick-crypto` |
| React Native with JSC | Supported with bundled patch flow | Prefer Hermes unless you have a strict JSC requirement |
| Expo Go | Limited fallback mode | Use only for prototyping; not recommended for production performance |

### 1. Install Dependencies

```bash
npm install mindoodb react-native-automerge-generated
npm install react-native-quick-crypto react-native-nitro-modules
npm install expo-standard-web-crypto expo-crypto
npm install text-encoding react-native-url-polyfill
npm install --save-dev patch-package
```

### 2. Copy Patches

MindooDB's known-good React Native setup currently uses two patches:

```bash
mkdir -p patches
cp node_modules/mindoodb/patches/react-native*.patch patches/
cp node_modules/mindoodb/patches/PATCHES.md patches/
```

Add `patch-package` to your `postinstall` script in `package.json`:

```json
{
  "scripts": {
    "postinstall": "patch-package"
  }
}
```

Then apply the patches:

```bash
npx patch-package
```

#### What the patches fix

**`react-native+0.76.9.patch`**
- Implements JSC `createArrayBuffer()` to prevent `Hash.digest(...): Not implemented` in affected runtime paths.

**`react-native-quick-crypto+1.0.7.patch`**
- Fixes two bugs in the crypto library:
1. **NULL pointer crash** in `randomFillSync` C++ code when ArrayBuffer is detached (e.g., by garbage collection)
2. **Incorrect buffer size** in TypeScript wrapper - uses full ArrayBuffer size instead of TypedArray view's `byteOffset`/`byteLength`

These are generic bugs in react-native-quick-crypto that affect any usage, not specific to MindooDB.

See `node_modules/mindoodb/patches/PATCHES.md` for technical details and upstream status.

### 3. Add Polyfills

Create a `mindoodb-polyfills.js` file in your project root:

```js
// mindoodb-polyfills.js
import 'react-native-url-polyfill/auto';
import { polyfillGlobal } from 'react-native/Libraries/Utilities/PolyfillFunctions';
import { TextEncoder, TextDecoder } from 'text-encoding';

// Text encoding (required by URL polyfill and native Automerge)
polyfillGlobal('TextEncoder', () => TextEncoder);
polyfillGlobal('TextDecoder', () => TextDecoder);

// Crypto (Expo's crypto.getRandomValues for basic randomness)
import { getRandomValues } from 'expo-standard-web-crypto';
if (typeof crypto === 'undefined') {
  global.crypto = { getRandomValues };
} else if (!crypto.getRandomValues) {
  crypto.getRandomValues = getRandomValues;
}

console.log('✅ MindooDB polyfills loaded');
```

Then import it at the **very top** of your entry point (`index.js` or `App.js`):

```js
// index.js — FIRST line
import './mindoodb-polyfills';
import { registerRootComponent } from 'expo';
import App from './App';

registerRootComponent(App);
```

### 4. Initialize Native Automerge

In your entry point, after polyfills, initialize the native Automerge backend:

```js
import './mindoodb-polyfills';

// Initialize native Automerge backend
import { UseApi } from '@automerge/automerge/slim';
import { nativeApi } from 'react-native-automerge-generated';

UseApi(nativeApi);
console.log('✅ Native Automerge initialized');

// Now register your app
import { registerRootComponent } from 'expo';
import App from './App';

registerRootComponent(App);
```

### 5. Configure App

In `app.json`, enable the new architecture:

```json
{
  "expo": {
    "name": "My App",
    "slug": "my-app",
    "newArchEnabled": true,
    "ios": {
      "bundleIdentifier": "com.example.myapp"
    },
    "android": {
      "package": "com.example.myapp"
    }
  }
}
```

**Note:** You can use either **Hermes** (default) or **JSC** - native Automerge works with both! No WebAssembly, no JavaScript engine restrictions.

### 6. Build and Run

```bash
# iOS
npx expo prebuild --clean
npx expo run:ios

# Android
npx expo prebuild --clean
npx expo run:android
```

### Optional: tune PBKDF2 iterations for Expo Go fallback

MindooDB defaults to strong PBKDF2 settings (`310000` iterations).  
For Expo Go or JavaScript-only fallback where this is too slow, you can set a lower runtime override:

```ts
// Example: set before creating users/keys
(globalThis as any).__MINDOODB_PBKDF2_ITERATIONS = 120000;
```

Or in Node-like environments:

```bash
MINDOODB_PBKDF2_ITERATIONS=120000
```

Notes:
- A safety floor is enforced (`60000` minimum).
- This should be used only for fallback/dev scenarios.
- Native crypto path should keep the stronger default whenever possible.

## Usage Example

Here's a complete example creating an encrypted document database:

```typescript
import {
  BaseMindooTenantFactory,
  InMemoryContentAddressedStoreFactory,
  QuickCryptoAdapter,
  KeyBag,
  PUBLIC_INFOS_KEY_ID,
} from 'mindoodb';
import * as quickCrypto from 'react-native-quick-crypto';

// 1. Set up infrastructure
const storeFactory = new InMemoryContentAddressedStoreFactory();
const cryptoAdapter = new QuickCryptoAdapter(quickCrypto);
const factory = new BaseMindooTenantFactory(storeFactory, cryptoAdapter);

// 2. Create a user (generates signing + encryption keys)
const password = 'user-password';
const user = await factory.createUserId('CN=alice/O=myorg', password);

// 3. Create admin user (signing + encryption keys used for tenant administration)
const adminUser = await factory.createUserId('CN=admin/O=myorg', 'admin-pw');

// 4. Set up key bag (stores decrypted keys locally)
const keyBag = new KeyBag(
  user.userEncryptionKeyPair.privateKey,
  password,
  cryptoAdapter
);
await keyBag.createDocKey(PUBLIC_INFOS_KEY_ID);
await keyBag.createTenantKey('my-tenant');

// 5. Open tenant
const tenant = await factory.openTenant(
  'my-tenant',
  adminUser.userSigningKeyPair.publicKey,
  adminUser.userEncryptionKeyPair.publicKey,
  user, password, keyBag
);

// 6. Register user in directory
const directory = await tenant.openDirectory();
await directory.registerUser(
  factory.toPublicUserId(user),
  adminUser.userSigningKeyPair.privateKey, 'admin-pw'
);

// 7. Create and modify documents
const db = await tenant.openDB('notes');
const doc = await db.createDocument();

await db.changeDoc(doc, (d) => {
  d.getData().title = 'My First Note';
  d.getData().content = 'Hello from React Native!';
  d.getData().tags = ['personal', 'important'];
  d.getData().createdAt = Date.now();
});

// 8. Read documents
const allDocs = await db.getAllDocumentIds();
console.log(`Created ${allDocs.length} documents`);

for await (const { doc } of db.iterateChangesSince(null)) {
  console.log(doc.getId(), doc.getData());
  // {
  //   title: 'My First Note',
  //   content: 'Hello from React Native!',
  //   tags: ['personal', 'important'],
  //   createdAt: 1738876543210
  // }
}
```

## Architecture

### Native Automerge (No WebAssembly!)

MindooDB now uses **react-native-automerge-generated** - a native Rust implementation of Automerge exposed through React Native's JSI (JavaScript Interface):

```
Your App (JavaScript)
       │
@automerge/automerge/slim ← UseApi(nativeApi)
       │
react-native-automerge-generated (JSI bridge)
       │
Native Rust Automerge v0.7.3 (compiled into your app)
```

**Benefits:**
- ✅ **Works with Hermes** - No WebAssembly, no JSC requirement
- ✅ **Native performance** - Direct Rust calls via JSI, ~10x faster than WASM
- ✅ **Smaller bundle** - No 2MB WASM blob
- ✅ **Android support** - WASM-based Automerge had Android issues
- ✅ **Simpler setup** - No WASM initialization path

### Why Patches Are Needed

**`react-native-quick-crypto` patch** - Fixes generic bugs in the crypto library:
1. **NULL pointer check** in C++ to prevent SIGSEGV crashes when ArrayBuffer is detached
2. **Correct TypedArray handling** - Uses view's `byteOffset`/`byteLength` instead of underlying ArrayBuffer size

These are defensive fixes that improve the library's robustness for all users.

**`react-native` JSC patch** - Implements `createArrayBuffer()` in JSC runtime.
This matters in JSC runtime paths involving NitroModules returning ArrayBuffer to JS. Hermes users are typically unaffected, but keeping the patch in the known-good setup avoids runtime-specific surprises.

### Crypto Adapter

MindooDB uses `QuickCryptoAdapter` on React Native, which wraps `react-native-quick-crypto` (NitroModules + OpenSSL). This provides:
- **AES-256-GCM** - Document encryption
- **RSA-OAEP** - Key wrapping
- **Ed25519** - Change signatures
- **PBKDF2** - Key derivation (310,000 iterations)
- **SHA-256** - Hashing

Native performance, battle-tested OpenSSL implementation.

## Storage Options

### In-Memory (Development/Testing)

```typescript
import { InMemoryContentAddressedStoreFactory } from 'mindoodb';
const storeFactory = new InMemoryContentAddressedStoreFactory();
```

**Use for:** Quick prototypes, testing, demos
**Limitation:** Data lost when app closes

### File-Based (Production)

For production apps, implement a file-backed store using:
- **expo-file-system** for Expo apps
- **react-native-fs** for bare React Native
- **SQLite** for structured storage with indices

Example with expo-file-system:

```typescript
import * as FileSystem from 'expo-file-system';
import { ContentAddressedStore } from 'mindoodb';

class FileBackedStore extends ContentAddressedStore {
  constructor(tenantId: string, databaseId: string) {
    super();
    this.basePath = `${FileSystem.documentDirectory}${tenantId}/${databaseId}/`;
  }

  async put(hash: string, content: Uint8Array): Promise<void> {
    const path = `${this.basePath}${hash}`;
    await FileSystem.writeAsStringAsync(
      path,
      Buffer.from(content).toString('base64'),
      { encoding: FileSystem.EncodingType.Base64 }
    );
  }

  async get(hash: string): Promise<Uint8Array | null> {
    const path = `${this.basePath}${hash}`;
    const exists = await FileSystem.getInfoAsync(path);
    if (!exists.exists) return null;

    const base64 = await FileSystem.readAsStringAsync(path, {
      encoding: FileSystem.EncodingType.Base64
    });
    return new Uint8Array(Buffer.from(base64, 'base64'));
  }

  // Implement other methods: has, delete, getAllHashes, estimateSize, clear
}
```

### Server-Backed (Sync)

For real-time sync, implement a store that talks to your server:

```typescript
class ServerBackedStore extends ContentAddressedStore {
  async put(hash: string, content: Uint8Array): Promise<void> {
    await fetch(`https://api.example.com/store/${hash}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: content
    });
  }

  async get(hash: string): Promise<Uint8Array | null> {
    const response = await fetch(`https://api.example.com/store/${hash}`);
    if (response.status === 404) return null;
    return new Uint8Array(await response.arrayBuffer());
  }

  // Implement other methods...
}
```

Server only sees encrypted blobs - it can't decrypt your data!

## Sync Between Devices

```typescript
// Alice's device
const aliceDB = await aliceTenant.openDB('projects');
const project = await aliceDB.createDocument();
await aliceDB.changeDoc(project, (d) => {
  d.getData().title = 'Secret Project';
  d.getData().budget = 50000;
});

// Bob's device pulls Alice's changes
const bobDB = await bobTenant.openDB('projects');
await bobDB.pullChangesFrom(aliceDB.getStore());

// Bob sees Alice's document (if he has the decryption key)
const projectDoc = await bobDB.getDocument(project.id);
console.log(projectDoc.getData());
// { title: 'Secret Project', budget: 50000 }

// Bob makes changes
await bobDB.changeDoc(projectDoc, (d) => {
  d.getData().status = 'In Progress';
});

// Alice pulls Bob's changes
await aliceDB.pullChangesFrom(bobDB.getStore());
// Alice now sees both her changes and Bob's
```

Sync works through **content-addressed stores** - devices exchange only the encrypted entries they're missing. Works P2P, client-server, or any combination.

## Document Indexing

Build incremental search indices that only process changed documents:

```typescript
import Flexsearch from 'flexsearch';

const searchIndex = new Flexsearch.Index({ tokenize: 'forward' });
let cursor = null;

// Incremental indexing loop
setInterval(async () => {
  for await (const { doc, cursor: newCursor } of db.iterateChangesSince(cursor)) {
    if (doc.isDeleted()) {
      searchIndex.remove(doc.getId());
    } else {
      const data = doc.getData();
      searchIndex.add(doc.getId(), `${data.title} ${data.content}`);
    }
    cursor = newCursor;
  }
}, 1000);

// Search
const results = await searchIndex.search('important');
```

See [Data Indexing](./dataindexing.md) and [Virtual Views](./virtualview.md) for advanced patterns.

## Troubleshooting

### "randomFillSync" crash or SIGSEGV in native code

The `react-native-quick-crypto` patch hasn't been applied. Run:

```bash
npx patch-package
npx expo prebuild --clean && npx expo run:ios
```

### "Cannot find module 'react-native-automerge-generated'"

Make sure you installed the native module:

```bash
npm install react-native-automerge-generated
npx expo prebuild --clean
```

### "UseApi is not a function"

Import from the correct path:

```typescript
import { UseApi } from '@automerge/automerge/slim';
import { nativeApi } from 'react-native-automerge-generated';

UseApi(nativeApi);
```

### Build errors on Android

Make sure your `android/build.gradle` has:

```gradle
buildscript {
    ext {
        minSdkVersion = 23
        compileSdkVersion = 34
        targetSdkVersion = 34
        ndkVersion = "26.1.10909125"
    }
}
```

The native module requires NDK r26 or later.

### "Cannot decrypt" or signature verification errors

Check that:
1. User is registered in the directory: `await directory.registerUser(...)`
2. KeyBag has the correct decryption keys: `await keyBag.decryptAndImportKey(...)`
3. User has access to the document's encryption key

## Performance Tips

- **Batch changes** - Use `changeDoc()` once with multiple operations instead of many small changes
- **Incremental sync** - Use cursors with `iterateChangesSince()` to only process new changes
- **Lazy loading** - Don't load all documents at once; fetch on demand
- **Index strategically** - Only index fields you actually search on
- **Native Automerge** - Already 10x faster than WASM, no additional optimization needed!

## Example Apps

Complete working examples:

- **mindoodb-test-app** - Full integration test at `/Users/klehmann/expo/mindoodb-test-app`
- **Template files** - Starter code at `node_modules/mindoodb/templates/reactnative/`

## Learn More

- [MindooDB Architecture](./specification.md) - Technical deep dive
- [Attachments](./attachments.md) - File storage and streaming
- [P2P Sync](./p2psync.md) - Peer-to-peer synchronization
- [Virtual Views](./virtualview.md) - Aggregations and cross-database queries
- [Security Audit](./securityaudit.md) - Cryptographic guarantees

## What's Next?

Now that you have MindooDB running:

1. **Implement file-backed storage** for production use
2. **Set up a sync server** to enable multi-device collaboration
3. **Build search indices** for fast full-text search
4. **Add attachments** for file uploads (photos, PDFs, etc.)
5. **Create virtual views** for dashboard aggregations

**Your data. Your keys. Your control.** 🔒

---

Need help? Open an issue on [GitHub](https://github.com/klehmann/mindoodb/issues) or check [Discussions](https://github.com/klehmann/mindoodb/discussions).
