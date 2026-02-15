# MindooDB Getting Started (Node, Web, React Native)

This guide gives you the fastest path to a running "Todo-style" app in each supported runtime.

## Runtime Choice

| Runtime | Status | Recommended onboarding |
|---------|--------|------------------------|
| Node.js | Production-ready | `npm install mindoodb` + Node quickstart below |
| Web | Production-ready | `npm install mindoodb` + browser entrypoint (`mindoodb/browser`) |
| React Native / Expo dev build | Production path | `npx mindoodb setup-react-native` in your app root |
| Expo Go | Limited fallback | Use only for prototyping/validation |

## Node.js

### 1) Create project and install

```bash
mkdir mindoodb-node-todo
cd mindoodb-node-todo
npm init -y
npm install mindoodb
```

### 2) Minimal Todo example (`index.mjs`)

```javascript
import {
  BaseMindooTenantFactory,
  InMemoryContentAddressedStoreFactory,
  KeyBag,
} from "mindoodb";

const storeFactory = new InMemoryContentAddressedStoreFactory();
const factory = new BaseMindooTenantFactory(storeFactory);

const user = await factory.createUserId("CN=node-user/O=todo", "user-password");
const keyBag = new KeyBag(user.userEncryptionKeyPair.privateKey, "user-password");
const adminSigning = await factory.createSigningKeyPair("admin-password");
const adminEncryption = await factory.createEncryptionKeyPair("admin-password");

const tenant = await factory.createTenant(
  "node-todo-tenant",
  adminSigning.publicKey,
  adminEncryption.publicKey,
  "tenant-password",
  user,
  "user-password",
  keyBag
);

const db = await tenant.openDB("todos");
const doc = await db.createDocument();
await db.changeDoc(doc, async (d) => {
  d.getData().title = "Buy milk";
  d.getData().done = false;
});

const ids = await db.getAllDocumentIds();
const loaded = await db.getDocument(ids[0]);
console.log(loaded.getData());
```

Or copy `docs/examples/node-todo.mjs`.

### 3) Run

```bash
node index.mjs
```

Expected result:

```txt
Loaded todo: { title: 'Buy milk', done: false }
```

## Web Browser

### 1) Create project and install

```bash
mkdir mindoodb-web-todo
cd mindoodb-web-todo
npm init -y
npm install mindoodb
```

### 2) Use browser entrypoint

In your browser app code:

```javascript
import {
  BaseMindooTenantFactory,
  InMemoryContentAddressedStoreFactory,
  KeyBag,
  createCryptoAdapter,
} from "mindoodb/browser";

const cryptoAdapter = createCryptoAdapter();
const storeFactory = new InMemoryContentAddressedStoreFactory();
const factory = new BaseMindooTenantFactory(storeFactory, cryptoAdapter);

// Same flow as Node: create user -> tenant -> DB -> todo docs
```

Or copy `docs/examples/web-todo.js`.

### 3) Validate browser runtime

In the MindooDB repo itself, browser runtime tests are available via:

```bash
npm run test:browser:install
npm run test:browser
```

For the minimal browser snippet, expect:

- console output: `Web todo: { title: 'Ship web MVP', done: false }`
- DOM text: `Todo: Ship web MVP (done: false)`

## React Native / Expo

### 1) Install dependencies in your app

```bash
npm install mindoodb react-native-automerge-generated
```

### 2) Run setup helper (recommended)

```bash
npx mindoodb setup-react-native
```

This helper:
- copies required patch files from `mindoodb/patches`
- configures `patch-package` postinstall
- installs missing runtime deps
- prints a Metro config snippet

### 2a) Production recommendation

- Prefer native runtime (Hermes + dev build / production build).
- Keep Expo Go for convenience testing only.

### 3) Initialize native Automerge in entrypoint

```javascript
import "./mindoodb-polyfills";
import { UseApi } from "@automerge/automerge/slim";
import { nativeApi } from "react-native-automerge-generated";

UseApi(nativeApi);
```

For a screen-level starter, copy `docs/examples/react-native/App.tsx`.

Then start your app with Expo dev build.

For full details, see `docs/reactnative.md`.

For the sample screen (`docs/examples/react-native/App.tsx`), expect:

- status becomes `Done`
- UI shows: `Todo: Pay invoices (done: false)`

## Notes on simplicity

- Node and Web setup are straightforward and require no patch flow.
- React Native currently needs patch application in the host app (managed by setup helper).
- The patches are app-level concerns, not automatically applied by `mindoodb` itself.
- For Expo Go / JS fallback performance, PBKDF2 can be tuned via `globalThis.__MINDOODB_PBKDF2_ITERATIONS` (minimum `60000` enforced). Use lower values only for fallback/dev.
