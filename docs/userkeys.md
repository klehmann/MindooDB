# User Keys and Personal Encryption

## Why User Keys Exist

MindooDB encrypts every document payload with a symmetric AES-256-GCM key. Each document names the key it uses through its `decryptionKeyId`, and each user holds the keys they are allowed to have in a local KeyBag. That model is a good fit for shared, long-lived audiences: everyone in HR holds the `hr-confidential` key, everyone in the tenant holds `default`, and an administrator distributes those keys to the people who should have them.

The model runs out of room as soon as the audience is a *person* rather than a *group*. Consider three ordinary requests: "back up my data so only I can restore it", "sync my drafts and settings between my laptop and my phone", and "share this one document with Bob". None of them is a cohort. Serving them with shared keys means either creating a named key per person — an administrative act for a private matter — or encrypting to each of a person's devices individually, which breaks every time somebody buys a laptop.

A **user key** closes that gap. It is an RSA-OAEP 3072 keypair that belongs to a person rather than to a device or to the tenant. Its public half is published inside the tenant so anyone can encrypt for that person; its private half exists only on the devices that person has explicitly approved. "Encrypt this for Alice" becomes a single stable operation that survives her replacing every device she owns.

User keys do not replace the shared key model — they extend it. Payloads are still encrypted with symmetric keys; what changes is how those symmetric keys reach a person.

This document explains the design, walks through integration, and provides the full technical reference. It is structured so that different readers can find what they need:

- **Sections 1-2** are for anyone evaluating user keys or meeting the concept for the first time.
- **Section 3** is the quickest path to a working integration.
- **Sections 4-5** cover device enrollment and key rotation, the two operations most applications need to get right.
- **Sections 6-8** cover per-document sharing, the underlying architecture, and the security model.
- **Section 9** is the reference appendix with the API, schema, and verified behaviour.

---

## 1) The Core Idea

A user key is an extra layer of *addressing* placed on top of the encryption model MindooDB already has. Nothing about payload encryption changes: a document is still encrypted with a symmetric key, and that key is still selected by `decryptionKeyId`. The question a user key answers is narrower — how does a symmetric key get to a specific human being?

### An extension of the shared key model

Both mechanisms coexist in the same tenant, and most applications use both. The difference is who the key is addressed to and who has to act to share it.

| | Shared named key (existing) | User key (new) |
|---|---|---|
| Belongs to | a group or the whole tenant | one person |
| Typical key ids | `default`, `hr-confidential` | not a KeyBag key at all |
| Addressed to | every device of every recipient | the person's published public key |
| Who can extend access | an administrator must sign the distribution | anyone who can already read the data |
| Effect of a new device | the distribution must be rewritten | nothing to rewrite |
| Best for | stable audiences: teams, departments, whole-tenant data | "just me", "me and Bob", per-document sharing |

The two connect at exactly one point, and it is worth understanding because it explains the whole bootstrap sequence. The tenant `default` key is itself distributed **to user keys**: its bytes are RSA-wrapped to each person's published public key rather than to each of their devices. So a device that holds a person's user key can unwrap `default` on its own, without an administrator re-issuing anything.

### Addressing people instead of devices

A person is a set of devices that changes over time. Encrypting "to Alice" by listing her current devices means every device she adds or retires invalidates the addressing of everything already encrypted for her. That is tolerable for a handful of tenant-wide keys and unworkable for per-document sharing: one new laptop would require a new entry in every document Alice can read — and she could only write those entries where she has write permission, so she could not even enroll her own device for documents she may only read.

Publishing one stable public key per person reduces all of that to a single directory write when a device is added.

Readership can still be narrowed *below* the person when that is genuinely wanted. The same mechanism can address a device encryption key directly, which is how kiosks, service accounts, bots, and offline backup vaults are handled — targets that have no human to approve an enrollment. Person-level is the default; device-level stays available as a special case.

### Two hops, not one

A device that has just been added to a tenant needs two things, delivered by two different documents in two different databases. Confusing them is the most common source of bootstrap bugs.

| Hop | Database | Delivers | How it is addressed |
|---|---|---|---|
| 1 | `userdirectory` | the person's **user key private half** | RSA-wrapped to this specific device's encryption key |
| 2 | `directory` | the tenant **`default` key** and any other named keys | RSA-wrapped to the person's **user key** |

Hop 2 can only be completed once hop 1 has succeeded, because the wrap in hop 2 is addressed to the key that hop 1 delivers. This is why enrollment always reconciles user keys first and key distributions second, and why a device that is waiting for approval sees empty databases rather than an error: it has the grant it needs to sync, but not the key it needs to decrypt.

Neither the join response nor device discovery carries `default`. Both carry only `$publicinfos`, the key that protects the directory itself — which is the minimum a device needs to look anything up.

### What does not change

Two boundaries are worth stating explicitly, because blurring them is the most common source of confusion when adopting the feature.

**User keys are addressing, not payload encryption.** Documents keep a symmetric data encryption key for the payload. The user key wraps that symmetric key. `decryptionKeyId`, the KeyBag, and AES-GCM payload encryption all work exactly as before.

**User keys are not an authorization mechanism.** Who may *write* a document remains the job of the access control system described in [accesscontrol.md](accesscontrol.md). User keys decide who can *read ciphertext*; rules decide who can *change state*. A person can be a recipient of a document they have no permission to edit, and a writer can append entries to a document they cannot read.

---

## 2) Deciding Whether User Keys Fit Your Needs

This section is for engineering leaders and architects evaluating platform options.

### What you get

- **Personal data that survives device churn.** A backup or a settings document sealed to a user key is readable on every device that person owns, now and after they have replaced all of them, while staying opaque to administrators, colleagues, and the sync server.
- **Sharing without an administrator.** Adding a reader to a document is an ordinary write by anyone who can already read it. No key distribution, no admin signature, no KeyBag churn.
- **Device enrollment without re-keying.** Approving a new device is one directory write. Nothing that was already encrypted needs to be rewritten.
- **Administrator-blind personal content.** An administrator can add a device to a person's grant — that is their job — but cannot thereby read that person's personal data. A human on an already-enrolled device has to approve the new device first.
- **A cheaper second device.** Because `default` is wrapped to the user key, an additional device that receives the user key imports `default` by itself. Adding your own second device needs no key distribution round trip.

### What it costs to adopt

For most applications, adopting user keys means:

- Calling one method to create the key before a user joins a tenant.
- Running two reconcile calls, in order, after syncing the directory databases.
- Building one approval screen: a list of devices that can open the user's personal data, with approve, decline, and undo actions.
- Deciding a policy for lost devices — specifically, whether removing a device should also rotate the key (see section 5).

The first three are a small integration, typically a day or two, and the sequence is the same whether the device arrives through a join flow or through device discovery. The fourth is a product decision rather than an integration task, and it is the one worth thinking about early.

There is one behaviour change to plan for if you are coming from a device-addressed distribution model: a grant alone no longer admits a device to named keys. A device that the user has not approved will sync ciphertext it cannot open. That is the intended gate, but the affected device must explain *why* its databases look empty instead of appearing broken.

### Key questions to consider

- Does your application store anything whose audience is exactly one person — backups, drafts, credentials, per-device settings? Named keys serve these badly.
- Do users need to share individual records with named colleagues, without an administrator in the loop? That is what per-document recipients are for.
- Do your users own more than one device? If so, user keys remove the re-keying work that device churn otherwise creates.
- Must personal content stay unreadable to tenant administrators? User keys provide that, with the honest limits set out in section 8.
- Who in your product is expected to approve a new device, and on which screen? This is the one piece of UI that user keys genuinely require.

---

## 3) Integration Guide

This section walks through one realistic scenario end to end. Alice is joining tenant `contoso` with her laptop, later adds her phone, and shares a document with Bob. Every example uses those names.

### 3.1 Step 1: Create the user key before joining

The user key must exist before the join request is built, because the request carries its public half. Creating it is idempotent — if the identity already has a pair, the existing one is returned.

```ts
const factory = new BaseMindooTenantFactory(storeFactory, crypto);
const alice = await factory.createUserId("CN=alice/O=contoso", "alice-password");

await factory.ensureUserKeyPair(alice, "alice-password");

const request = factory.createJoinRequest(alice, { label: "Alice's laptop" });
```

`createJoinRequest` includes `userPublicKey` only when the identity already has a user key, which is why the order matters. Pass `{ format: "uri" }` instead if you need a QR code or deep link.

If you are founding a tenant rather than joining one, call `ensureUserKeyPair` before `createTenant` and you are done — `createTenant` publishes the key, wraps `default` to it, and completes enrollment for the founding device by itself.

### 3.2 Step 2: Approve the join request

Approval is an administrative act: it needs the admin signing key. It registers the device on the grant, publishes Alice's user key document, and wraps `default` to her user key.

```ts
const response = await adminTenant.approveJoinRequest(request, {
  adminSigningKey: admin.userSigningKeyPair.privateKey,
  adminPassword: "admin-password",
  label: "Alice's laptop",
  serverUrl: "https://sync.contoso.example",
});
```

A device label is required, either here or in the request. It is shown to the user in the approval dialog, so make it recognizable.

### 3.3 Step 3: Finish enrollment on the joining device

`joinTenant` imports `$publicinfos` and opens the tenant. It does **not** deliver `default` — that is hop 2, and it needs the two reconcile calls.

```ts
const { tenant, keyBag, user: joined } = await factory.joinTenant(response, {
  user: alice,
  password: "alice-password",
});

// Sync both directory databases before reconciling.
await (await tenant.openDB("directory")).syncStoreChanges();
await (await tenant.openDB(USER_DIRECTORY_DB_ID)).syncStoreChanges();

tenant.noteUserDirectoryFetched();
await tenant.reconcileUserKeys();                        // hop 1: the user key
await tenant.reconcileKeyDistributionsForCurrentUser();   // hop 2: default

await tenant.hasDecryptionKey(DEFAULT_TENANT_KEY_ID);     // true
```

Persist `joined` rather than the identity you started with: the directory may have registered a different username, and `joined` carries it.

Two details matter here. `noteUserDirectoryFetched()` tells the SDK that `userdirectory` reflects the server, which is what allows it to publish a key document when none exists; without it, a device that simply has not synced yet could create a competing key document. And the two reconcile calls must run in that order, because hop 2 needs the key hop 1 delivers.

If the device arrived through device discovery rather than a join response, `bootstrapTenantFromDelivery` runs this whole sequence for you when you pass `serverUrl`:

```ts
const deliveries = await factory.discoverTenantsOnServer("https://sync.contoso.example", {
  user: alice,
  password: "alice-password",
});

for (const delivery of deliveries) {
  const { tenant } = await factory.bootstrapTenantFromDelivery(delivery, {
    user: alice,
    password: "alice-password",
    serverUrl: "https://sync.contoso.example",
  });
}
```

### 3.4 Step 4: Give an additional device access

Alice now adds her phone. Whether the phone is ready immediately or has to wait depends on who approves its join request — section 4 covers all four cases. If it has to wait, an already-enrolled device grants it access:

```ts
// On Alice's laptop, which already holds the user key.
const pending = await tenant.listPendingUserKeyDevices();
// [{ fingerprint: "3f:a1:9c:…", label: "Alice's phone", signingPublicKey, encryptionPublicKey }]

await tenant.approveUserKeyDevice(pending[0].fingerprint);
await (await tenant.openDB(USER_DIRECTORY_DB_ID)).syncStoreChanges();
```

Show the user the label and the fingerprint, and let them compare the fingerprint against what the new device displays. That comparison is what makes the approval meaningful.

The phone then finishes enrollment with the same two calls as step 3:

```ts
// On Alice's phone.
tenant.noteUserDirectoryFetched();
const status = await tenant.reconcileUserKeys();          // { state: "approved", … }
await tenant.reconcileKeyDistributionsForCurrentUser();
```

If the user does not recognize the device, `declineUserKeyDevice(fingerprint)` records the refusal and syncs it, so no other device asks again. `undoDeclineUserKeyDevice(fingerprint)` reverses it and returns the device to the pending list.

### 3.5 Step 5: Seal a document to named people

With user keys in place, sharing a single document takes one call. The document gets its own data encryption key, wrapped to each recipient's published public key.

```ts
const doc = await db.createDocument({
  id: "q3_review",
  recipients: ["CN=bob/O=contoso"],
  initialValues: { subject: "Q3 review" },
});

doc.isSealed();                            // true
doc.getRecipients();                       // Alice (author) + Bob
doc.isEncryptedFor("CN=bob/O=contoso");    // true
```

The author is always included unless you pass `recipientOptions: { includeSelf: false }`. For personal data, `recipients: []` means "just me, on all my devices":

```ts
const prefs = await db.createDocument({ id: "workspace_prefs", recipients: [] });
```

Changing the list later is `addRecipients`, `removeRecipients`, or `setRecipients`. Section 6 covers what each one costs.

### 3.6 Handling errors

Most problems in this area are ordering or timing issues rather than genuine failures, and they surface as a device that cannot decrypt anything.

| Symptom | Cause | What to do |
|---|---|---|
| `reconcileUserKeys` returns `state: "waiting"` | This device has no wrap yet — nobody has approved it | Expected. Show the waiting message from section 4.6 and prompt the user to approve on another device. |
| `hasDecryptionKey("default")` is false after enrollment | Hop 2 did not run, or ran before hop 1 | Call `reconcileUserKeys()` first, then `reconcileKeyDistributionsForCurrentUser()`. |
| `approveJoinRequest` throws about a missing `userPublicKey` | `ensureUserKeyPair` was not called before `createJoinRequest`, and the person has no published key | Create the user key on the joining device and build a new request. |
| `reconcileUserKeys` returns `state: "unknown"` | `userdirectory` has not been fetched, or the fetch failed | Sync `userdirectory`, call `noteUserDirectoryFetched()`, and retry. |
| `reconcileUserKeys` returns `state: "approved"` with no user-key document | This person already holds `default` from key distribution (a newly granted first device). Minting a user-key document is refused so a second pair cannot desync `acl_keydistribution_default`. | Do not show a waiting banner. Shared tenant data already works; personal-data enrollment is not missing another device's approval. |
| A second key document appears for one person | A device published before it had synced | Do not call `reconcileUserKeys({ allowSelfCreate: true })` on a device that has not fetched `userdirectory`. Lookup tolerates the fork, but avoid creating it. |
| Adding a recipient reports them as skipped | That person has no published user key yet | Wait until they enroll a device, or pass `strict: true` to fail loudly instead of skipping. |
| A recipient is listed but cannot read the document | Intent was recorded but no wrap exists yet | Expected and self-healing: `getRecipients()` reports `sealed: false` until a client that can read the document re-seals it. |
| A document is listed but `getDocument` fails | The client holds only older key generations | Treated as inaccessible rather than an error; the document is hidden until the client is a current recipient. |

---

## 4) Adding a Device to a Tenant

Getting a device onto a tenant involves two independent decisions, and keeping them apart is the key to understanding this section. An administrator decides whether the device may **sync** — that is the grant. The person's own already-enrolled devices decide whether it may **hold their user key**. Appearing on the grant is necessary but never sufficient.

That separation is deliberate. If a grant entry were enough to receive the user key, an administrator could generate a keypair, add it to Alice's grant, and read everything she owns. The approval step is what prevents that.

### 4.1 What decides whether a device waits

When a join request is approved, the user key is wrapped for the joining device immediately **if the replica performing the approval is operated as the joining person**. If somebody else approves, the wrap is deferred, because no replica may write another person's key document.

This is not a question of who holds the admin key. The admin signing key is required to approve any join request, so it is present in every case below. What matters is whether the approver *is* the person receiving the device.

| Who approves | User key wrapped during approval? | Device ready after sync? |
|---|---|---|
| The same person, holding the admin identity | Yes | Yes, immediately |
| An administrator who is a different person | No | No, waits for approval |
| Nobody yet — device added directly to the grant | No | No, waits for approval |

### 4.2 Scenario A: the first device of a new person

Alice has no devices and no published user key.

Her laptop creates the user key and puts its public half on the join request. On approval, the administrator registers the grant, publishes a **pending** user key document containing only the public key, and wraps `default` to that public key. A pending document is one with no device wraps at all — the key is published but nobody can open it yet.

When the laptop pulls `userdirectory` and reconciles, it *seals* that pending document by writing its own device wrap. It can do this because it holds the matching private key locally. Then hop 2 imports `default`.

No prompts, no waiting. This is the ordinary new-user path.

### 4.3 Scenario B: your own additional device

Alice already uses her laptop, holds the admin identity, and now adds her phone. Because she approves her own device's join request from a replica opened as herself, the user key is wrapped for the phone during that approval — using the **already published** key, never a fresh pair the phone generated.

The phone then discovers the tenant, bootstraps, and finds the wrap already waiting in the document the first time it reads it. Both hops complete inside the bootstrap call, so `default` is available immediately.

This is the fast path, and it is worth designing for: there is no dialog, no second step, and nothing for the user to confirm. It applies whenever the person adding the device is the person approving it.

### 4.4 Scenario C: an additional device approved by an administrator

Alice does not hold the admin identity, so an administrator approves her phone. The administrator is a different person, so the user key wrap is deferred and the phone lands in a genuine waiting state.

What the phone has and does not have:

| Has | Does not have |
|---|---|
| A grant, so it syncs on the wire | The user key private half |
| `$publicinfos`, so it can read `directory` and `userdirectory` | `default`, so content databases stay opaque |

Concretely, `reconcileUserKeys()` returns `{ state: "waiting", missingKeys: ["default"] }` and `hasDecryptionKey("default")` is false. The phone is not broken and not misconfigured — it is waiting for a human.

The wait ends when Alice approves it on her laptop, exactly as shown in step 3.4: `listPendingUserKeyDevices()` to find it, `approveUserKeyDevice(fingerprint)` to write the wrap for every generation of her key, then sync. The phone reconciles and is ready.

### 4.5 Scenario D: devices from before user keys

A person whose devices predate user keys has several grant entries and no key document. The first of those devices to reconcile creates the key and wraps it for **every device currently active on that person's grant**, so the siblings import their wrap on the next sync with no dialog.

This is a deliberate one-time convenience: without it, every existing device of every existing user would need a manual approval before anything worked. The trade-off is that it trusts the grant as it stands at that moment. A device already on the grant when the key is first published is included; a device added afterwards is not, and falls back to Scenario C.

### 4.6 What a waiting device should say

A device that is on the grant but holds no wrap can detect this itself at startup: the key document exists and its own fingerprint is not in it. Rather than showing databases that look empty or broken, it should say what is happening and what to do — "This device can't open your personal data yet. Open the app on your other device and confirm this one."

Derive the message from the keys the device actually holds rather than hard-coding it. Without `default`, almost nothing opens and the message should be prominent. With `default` but without the user key, only personal and per-recipient content is waiting, and the message belongs on those views.

Per database, `db.getInaccessibleDocumentCount()` says how much is actually being withheld, which turns a vague warning into a fact — "3 documents, 7 hidden" rather than a list that looks like the database is nearly empty. The number cannot be derived from the listing APIs: a document that was never readable on this device gets no index entry at all, so `getAllDocumentIds()` and the change feed have nothing to report about it. It is a synchronous read of a tally maintained while syncing and reconciling and persisted with the metadata checkpoint, so it costs nothing to poll after a sync. It counts what has arrived on this device, not what the tenant holds, and includes deleted documents — the presence of a document we cannot decrypt is knowable, its lifecycle state is not.

### 4.7 Why approval is never automatic

A device is never wrapped on the strength of an admin signature, a join response, or a matching username alone. The attack this prevents is specific: an administrator generates a keypair, appends it to Alice's grant, and waits for one of Alice's honest clients to wrap the key for it. A single client that wraps without asking would hand over everything Alice owns.

The dialog is the required control, but it is not the only one. Planting a device requires an admin-signed change to the grant, which lands as an entry in the append-only directory and stays attributable permanently. There is no quiet path: an administrator has to leave durable evidence *and* persuade a human to approve.

| Control | Mechanism | Stops a silently planted device? |
|---|---|---|
| Required | Approve/decline dialog on an already-enrolled device | Yes, if the user reads it |
| Recommended | Matching short fingerprints shown on both devices | Yes, and makes blind-tap approval harder |
| Optional | Pairing flow started from a device that already holds the key | Yes, and removes the dialog from the common case |

Declining is persistent and shared. It is recorded in the synced key document, so no other device asks again — which also means undoing it requires a write, not a local reset. Provide one screen listing the devices that can open the user's personal data, including declined ones with an "allow after all" action. Declining does not remove the device from the grant; that stays an administrative action on the sync plane.

---

## 5) Removing a Device and Rotating the Key

When a device is lost, stolen, or retired, two different things can happen to the user key, and they have very different consequences. Conflating them is the easiest way to make a promise your application cannot keep.

### 5.1 Dropping wraps is not revoking access

When a device is revoked on the grant, the next reconcile on any remaining device removes that device's wraps from **every** generation of the key and republishes the document. This happens automatically.

It also takes nothing away from the removed device. That device already unwrapped the private key and holds it in its own storage; the wrap in the document was only the delivery mechanism, not the lock. Removing wraps stops future deliveries and tidies the readership list. It does not cut anybody off.

### 5.2 What rotation does

Cutting a device off going forward requires **rotation**, and rotation is an explicit call:

```ts
await tenant.rotateUserKey();
```

Rotation is deliberately **not** triggered by a grant change. When you call it, it:

1. Generates a new keypair and adds it as the next generation.
2. Wraps it only for devices that are still active on the grant **and** already held the previous generation. A removed device fails both tests and is excluded.
3. Marks the previous generation retired but **keeps** it, along with its remaining wraps, so the devices that stayed can still open everything encrypted to the old key.
4. Becomes the key that new content is addressed to. Named key distributions listing this person are re-wrapped to the new public key.

Keeping retired generations is what makes rotation safe to use. Without them, rotating would lock a person out of their own history.

### 5.3 What rotation cannot do

Rotation is a forward cutoff. It does not reach backwards, and your interface must not imply that it does.

Content the removed device could already read stays readable on that device forever. Existing documents are deliberately **not** re-encrypted: doing so would mean rewriting every document as its author with a fresh recipient list, which only the author can do and which would touch everything that person ever had access to. The practical control against a removed device is the sync plane, not cryptography — the tenant blocks its access and a remote wipe can be requested.

So "create a new personal key so that device cannot open your personal data **going forward**" is an honest description. "Revoke access" is not.

### 5.4 What your application should do

Because rotation has a cost, the SDK leaves the decision to you. Rotating forces every named key distribution listing that person to be re-wrapped by a key holder and re-signed by an administrator, so it is not something to fire on every grant change.

A reasonable policy:

- **Device retired benignly** — sold, replaced, decommissioned. Revoke the grant and let the wraps drop. Do not rotate: there is nothing to cut off, and rotating pays the re-wrap cost for no gain.
- **Device lost, stolen, or no longer trusted.** Revoke the grant, sync, then rotate and re-publish the affected distributions. The timing is favourable here: a device you no longer trust already holds your named key bytes in its own KeyBag, so those keys need rotating anyway.

Be aware of the gap this leaves if you skip the second case. An application that revokes a device but never calls `rotateUserKey()` leaves that device able to open everything addressed to the still-current generation. Removal alone is not revocation.

```ts
// The full sequence for a lost device.
const directory = await adminTenant.openDirectory();
await directory.updateUserGrant(
  "CN=alice/O=contoso",
  { revokeSigningKeys: [lostDevice.signingPublicKey] },
  admin.userSigningKeyPair.privateKey,
  "admin-password",
);

// On a remaining device of that person:
await tenant.reconcileUserKeys();   // drops the wraps
await tenant.rotateUserKey();       // creates the forward cutoff
await (await tenant.openDB(USER_DIRECTORY_DB_ID)).syncStoreChanges();
```

---

## 6) Sharing Individual Documents

Per-document recipients are the first feature built on user keys, and for most applications they are the main reason to care about them. A document carries a list of the people who may read it, and that list can be changed by anyone who can already read the document.

### 6.1 When to use recipients, when to use a named key

Both are available, and choosing correctly matters more than any other decision in this document.

**Use a named key** when the audience is stable and shared: all tenant data under `default`, a department's records under `hr-confidential`, anything where the answer to "who can read this" is a role rather than a list of names. Named keys cost one distribution and are then free per document.

**Use recipients** when the audience is specific to the document or to one person: personal backups and settings, a document shared with two named colleagues, a drop box that its author cannot read back. Recipients cost one key wrap per reader per document, and they need no administrator.

Do not use recipients to model a group. Directory membership changes over time, so a group wrap would make "who can decrypt this" depend on the group's current members rather than on the document itself — and queries could no longer answer the question from the document alone. If you want to share with everyone in a group, expand the membership in your application and pass the resulting usernames.

### 6.2 Creating a sealed document

A document created with `recipients` gets its own data encryption key rather than a shared one. This is mutually exclusive with passing `decryptionKeyId`.

```ts
// Shared with named people.
const review = await db.createDocument({
  id: "q3_review",
  recipients: ["CN=bob/O=contoso", "cn=Carol/o=Contoso"],
  initialValues: { subject: "Q3 review" },
});

// Personal: only me, on all my devices, now and after I replace them.
const prefs = await db.createDocument({ id: "workspace_prefs", recipients: [] });

// Sealed to a backup vault that is not a tenant device.
const backup = await db.createDocument({
  recipients: [{ devicePem: vaultPublicKey, label: "offsite vault" }],
});

// A drop box the author cannot read back.
const dropbox = await db.createDocument({
  recipients: ["CN=bob/O=contoso"],
  recipientOptions: { includeSelf: false },
});
```

Usernames are matched case-insensitively and canonically, so `Alice/Contoso`, `cn=Alice/o=Contoso`, and `CN=alice/O=contoso` all mean the same person. The name must include an `O=` component after expansion; a bare `alice` is rejected, because the tenant id is a random string and not an organization name.

An empty recipient list with `includeSelf: false` is rejected — it would produce a document nobody can read.

Because a writer with `includeSelf: false` cannot change the document after the create, attachments can go into the create entry itself:

```ts
await db.createDocument({
  recipients: ["CN=bob/O=contoso"],
  recipientOptions: { includeSelf: false },
  initialValues: { subject: "Invoice" },
  attachments: [{ data: pdfBytes, fileName: "invoice.pdf", mimeType: "application/pdf" }],
});
```

The chunks are encrypted with the document's own key and referenced from the `doc_create` entry, so the document arrives complete in one entry. This is what a writer without read access needs: a `doc_deposit` principal (docs/accesscontrol.md §6.10) may push only sealed creates and their chunks into a database it cannot read, which is how a mail gateway delivers into a person's mailbox. For MindooMail's `mmail_<grantDocId>` this right is built in and granted on the gateway's grant (`depositPrefixes`, docs/accesscontrol.md §6.11). Attachments in the create are not supported on the convergent custom-id path or in `createDocuments()`.

### 6.3 Changing the recipient list

Three methods change the list, and the difference between adding and removing is the most important thing to understand about them.

```ts
await db.addRecipients(review, ["CN=dave/O=contoso"]);

const removed = await db.removeRecipients(review, ["CN=bob/O=contoso"]);
removed.rotated;   // true — a new key generation was created

await db.setRecipients(review, ["CN=carol/O=contoso"]);   // diffs both ways
await db.canChangeRecipients(review, ["CN=alice/O=contoso"]);   // dry run

// Combine a content edit with a share so no empty change is written.
await db.addRecipients(review, ["CN=dave/O=contoso"], {
  change: (d) => { d.getData().sharedAt = Date.now(); },
});
```

| Operation | Cost | Effect on history |
|---|---|---|
| `addRecipients` | One key wrap per new reader. No rotation. | The new reader can decrypt the **entire** past. |
| `removeRecipients` | A new key generation, plus one wrap per remaining reader. | The removed reader keeps what they already had; they cannot read anything written afterwards. |
| `setRecipients` | Whatever the diff requires. The author stays unless `includeSelf: false`. | As above, per side of the diff. |

The `rotated` flag is the honest part of this API: it tells you whether the operation had a confidentiality consequence or was merely additive.

Two semantics deserve to be in your own documentation, not buried here. **Removal is a forward cutoff, never retroactive** — the removed reader has already synced and possibly cached the plaintext, exactly as with device rotation in section 5.3. And **adding a recipient grants the whole past**, which matches what named keys already do; the alternative, a reader who sees only the tail, cannot be made trustworthy because verifying a partial history requires trust that only an administrator has.

Sharing requires read access **and** write permission: you must hold the current document key and pass the `doc_change` check. A read-only recipient therefore cannot re-share, which is a useful property that falls out for free.

### 6.4 Reading the list

These accessors are synchronous, because everything they read is already loaded when the document handle is materialized.

| Method | Meaning |
|---|---|
| `isSealed()` | The document has its own key series rather than a shared named key. |
| `getRecipients()` | The active recipient list, each entry reporting whether it is actually sealed yet. |
| `getRecipientEpoch()` | The current recipient-set generation. |
| `isEncryptedFor(users)` | True when every listed person has an active entry **and** a key wrap. Accepts a string or an array. |

`getRecipients()` can report a recipient with `sealed: false`. That means the intent was recorded but no wrap addresses them yet — typically because their user key could not be resolved when they were added. It is a normal, self-healing state: the next client that can read the document writes the missing wrap. Surface it as "pending" rather than as an error.

### 6.5 Queries, views and visibility

The recipient list lives in the document payload, so views and queries can filter on it directly. Use the canonical form of the username, and remember that removed recipients keep a tombstone entry that must not match:

```text
_encryptFor["CN=alice/O=contoso"] != null
&& _encryptFor["CN=alice/O=contoso"].removedAt == null
```

`isEncryptedFor()` is the equivalent in application code and is usually the better choice; the raw field is for view formulas that cannot call methods.

Visibility needs no special handling. Sealed documents participate in the ordinary key-visibility machinery, so a person added to a document sees it appear, and a person removed from one sees it disappear along with any cached plaintext. Callers who cannot decrypt a document cannot see its recipient list at all — views only index plaintext the current user can already read.

Removal takes effect on the removed reader's very next sync; no follow-up edit is needed to push them out. The recipient change is itself carried by a document change, encrypted under the freshly rotated key, so there is always something the removed reader cannot decrypt waiting for them. When they sync, that failure is treated as a lost key rather than an error: cached plaintext is purged, the document drops out of `getAllDocumentIds()`, `getDocument()` reports it as missing, views drop it, and the change feed emits a single tombstone so incremental consumers can evict it. A decryption exception never reaches the caller, even though the reader still holds the older generations of that document's key.

---

### 6.6 Group documents: one member list for many documents

A chat has one member list and any number of messages. Making every message a sealed
document would cost one wrap per member per message, put the member fingerprints on
every message, and turn "remove Bob" into a change of every message. Instead, one
sealed **group document** holds the members, and the other documents borrow its key
series:

```ts
const group = await db.createDocument({ recipients: ["CN=bob/O=contoso"], initialValues: { name: "Project X" } });
const message = await db.createDocument({ groupKeyDocId: group.getId(), initialValues: { text: "Hi" } });

message.getDecryptionKeyId();   // "$sealed:<group id>"
message.getGroupKeyDocId();     // the group id; isSealed() is false
await db.addRecipients(group, ["CN=carol/O=contoso"]);    // Carol reads every message so far
await db.removeRecipients(group, ["CN=bob/O=contoso"]);   // rotates: Bob reads nothing written afterwards
```

- **Same key, same rules.** The documents are encrypted with the group's newest
  generation and decrypted with any of them, exactly like changes to the group
  document itself (§7.5). Adding a member reveals the whole history (unless added
  with `history: "none"`, §6.7), removing one is a forward cutoff (§6.3).
- **Membership changes touch one document.** The recipient block lives only on the
  group document; documents that use it carry none. A replica that is added or removed
  re-runs the key visibility reconcile once after the sync pass that changed its access,
  so the documents appear or disappear (with cached plaintext purged) together with
  the group.
- **Creating** requires the group document to be a sealed document of the same
  database and the caller to be a member (`createDocument` fails with "not a member"
  otherwise). `groupKeyDocId` is mutually exclusive with `decryptionKeyId` and
  `recipients`, and like `recipients` it needs `assumeUniqueId` with a custom id.
- **Recipient mutators** refuse documents that use a group key: change the members on
  the group document.
- **What the server sees:** documents of a group carry only the key id
  `$sealed:<group id>`, no wraps; the group's member fingerprints are on the group
  document alone.

### 6.7 Adding readers without the history

By default (`history: "all"`) a new reader gets every key generation and reads
everything that was ever written, including the document's existing attachments. For a class chat that a family joins in the middle of the year, or a group
that discussed something before a person was added, that is not wanted:

```ts
await db.addRecipients(group, ["CN=carol/O=contoso"], { history: "none" });
// ... later, if it was a mistake or the group decides otherwise:
await db.revealHistory(group, ["CN=carol/O=contoso"]);
```

- **`history: "none"` rotates first.** A new generation is created and Carol gets a
  bundle of her own that holds only that generation. Everything encrypted before is
  cryptographically unreadable for her, not just filtered out: older documents of the
  group do not appear on her replica (their origin entry is test-decrypted once).
- **The limit sticks.** Her entry in `_encryptFor` records `historyFrom` (the first
  epoch she holds). Every later re-seal, by any member, honours it: a rotation after a
  removal hands her only the generations from `historyFrom` on. `getRecipients()`
  reports `historyFrom` for such readers.
- **`revealHistory`** clears the limit and re-seals without a rotation; after the next
  sync her replica reveals the older documents. It cannot be undone for what she has
  already received: taking the history away again only protects later content
  (remove and re-add with `history: "none"`).
- **Who can change the list.** Every reader, including one without the earlier
  history. A replica seals what it holds: the unbroken run of generations that ends
  at the current epoch. A late reader who removes someone rotates and publishes a
  block whose bundles start at their own first epoch (`bundleFrom`); the other
  readers keep taking the older generations from the earlier blocks they can open
  and merge them. Adding with `history: "all"` and `revealHistory` reach back only as
  far as the caller's own history; the new reader's `historyFrom` says how far.
  Who is *allowed* to change the list is a matter of the access rules, not of keys.
- **The document itself stays readable.** Its older entries are under the old
  generations too, so `history: "none"` writes a snapshot of the current state under
  the new key. For a group document the new reader therefore sees the group's current
  content (name, member list) but none of the older documents that use its key.
- **Limits.** Existing readers can of course pass on what they can read. A later
  snapshot of an *older* group-encrypted document (written automatically after many
  changes to that one document) is encrypted with the newest generation and so becomes
  readable for readers without history; documents that are written once, like chat
  messages, are never snapshotted.
- **Wire format.** A recipient block gains an optional `partial` list (one bundle per
  distinct first epoch, with its own wraps) and an optional `bundleFrom` (first epoch
  of the main bundle when the sealing replica did not hold epoch 1). Blocks sealed by
  a reader with the whole history for readers with the whole history are
  byte-identical to before. A reader's series is the union of the newest block (which
  decides membership) and the older blocks it can open.

## 7) Architecture

This section is for engineers who need to reason about correctness, concurrency, and failure behaviour rather than just call the API.

### 7.1 The `userdirectory` database

User key documents live in a dedicated system database, `userdirectory`. It exists separately from `directory` for one structural reason: `directory` is admin-write-only by a hard-coded invariant, not by policy. Letting people publish their own key material there would mean either breaking that invariant or putting an administrator in charge of private material. A separate database keeps the admin rule authoritative in `directory` while letting each person maintain their own document in `userdirectory`.

To the sync server it is ordinary content. It never needs a user private key.

### 7.2 Who may write what

`userdirectory` has a builtin write invariant that holds **even when no access control policy is configured and even when the access control master switch is engaged**. A configured policy may tighten it but never loosen it.

| Operation | Who may perform it |
|---|---|
| Create | the administrator, or the person the document belongs to |
| Change | **only** the person the document belongs to |
| Delete | the administrator only |
| Undelete | the administrator, or the person the document belongs to |
| Read | everyone in the tenant |

The change rule is the load-bearing one, and it is worth being precise about how ownership is decided. It is not the document author and not a username string comparison. The check compares the `username_hash` stored **in the document** against the `username_hash` of the signer's grant at the entry's trusted time. Three consequences follow:

- **Every one of Alice's devices may edit her document**, because they all resolve to the same grant hash. That is what makes concurrent wraps and co-editing work.
- **Nobody else may, including the administrator.** An administrator can create a pending document during a join and can delete a document, but changing somebody else's is explicitly denied — so a planted public key cannot be swapped in after the fact.
- **The tenant founder is both administrator and owner**, so the hash match still lets them wrap their own key.

The same check runs on the server before its own access control evaluation, so a modified client cannot plant entries. Clients that nonetheless receive a hostile change drop it on load and keep the last valid state.

The table above describes key documents. `userdirectory` also holds each person's **personal documents**, which follow a different ownership rule for a reason that section 7.6 explains.

### 7.3 The user key document

Each person has one document holding every generation of their key. Generations are a map keyed by epoch, never an array, because two devices that rotate while partitioned write different generations and a map merges per key.

The private half of each generation appears only as RSA wraps to specific device encryption keys. Old generations are never dropped: a device that loses grant access is removed from the wraps, but the remaining devices keep their wrap of the retired key so that content encrypted to it stays readable.

The current generation is the highest epoch present. It is derived rather than stored, because a scalar "current epoch" field is exactly the value two concurrently rotating devices would overwrite for each other. The full schema is in section 10.2. Section 9.3 explains which generations count; the current one is the highest of those.

**Document identity has a fast path and a fallback.** The canonical id is derived from the person's grant document id. But no access control rule can express "this id belongs to that signer" — rules match on database, operation, and identity, not on document ids — and grant ids are visible to every member. So anyone could occupy Alice's canonical id before she does.

Lookup therefore tries the canonical id first and falls back to scanning for a document whose `username_hash` matches the person, filtered by the same signature binding that validates any key document. Squatting an id costs a scan rather than a lockout, and Alice simply publishes under a generated id instead.

**Validity is established by binding to the grant**, not by an admin signature. A key document is valid for a person only if its creator is the administrator or a signer whose grant resolves to the document's `username_hash`, and if that hash matches the person. Anyone may create a document claiming Alice's hash, but every client rejects it because the signer is not on her grant. A forgery is litter, not a compromise.

Note the limit of that binding: it proves that some device currently on Alice's grant published the document. It does not prove that an administrator did not insert that device. Confidentiality rests on the approval step in section 4.7, not on administrator honesty.

### 7.4 Keeping it healthy

The published document is best understood as a **distribution cache, not the master copy**. Every wrap in it can only be opened by a device that already holds the private key, and those devices hold their own copies. So losing the document does not lose the key.

That reframing answers most of the failure cases. Deleting the document costs one republish, and republishing is idempotent — the same public key at the same epoch — so **nothing anywhere needs re-encrypting**. Deletion is restricted to administrators anyway, and a delete in MindooDB is a tombstone rather than an erasure, so creating the document again resurrects it. Even a genuine administrative purge is self-healing: on the next unlock, any device that still holds the private key republishes the same key at the same epoch. An administrator can repeat a purge as denial of service, but it never yields read access.

Because all of these repairs are idempotent, clients run them unconditionally. On every startup and after every `userdirectory` sync, a client compares the published state against the private key it holds and fixes the difference: republish if missing, undelete if tombstoned, add its own wrap if absent, drop wraps for devices no longer on the grant.

**Losing every device is the one genuinely unrecoverable case.** If no device holds the private key, no wrap in the document can be opened. A replacement device may write to the same document and add a new generation for itself — once signed generations are required (section 9.3) only after the administrator deleted the old document — so nothing blocks recovery of the *account* — but content encrypted to the dead generations stays unreadable until it is written again. Flag those generations so your interface can explain the gap rather than showing broken content.

This is also why deleting or purging an unopenable document would be actively harmful: the wraps of the dead generations are exactly what makes an old device backup valuable. Restore that device's identity and its wrap still opens the old key, and with it the whole history. Where your platform already has an identity backup mechanism, that mechanism is the user key recovery story too — a separate user-key recovery code would add a second secret with the same failure mode.

### 7.5 How sealed documents store their keys

A sealed document uses a `decryptionKeyId` that names a **series** rather than a single key. That indirection is required by two existing invariants.

First, `decryptionKeyId` is immutable: it is written when the document is created and copied onto every later entry, with no re-key API. A design that encoded the recipient set in the key id could therefore never change that set. Naming a series sidesteps this — generations rotate inside the series while the id stays put.

Second, decryption already tries every version of a key until authentication succeeds. Feeding it the generations of a series means reading the full history works with no change to the crypto path at all, which is what makes "a new recipient can read the whole past" nearly free.

**The list and the key material are stored separately, because they have opposite requirements.** The list is *intent*: it changes over time, it is edited concurrently, and only someone who can already read the document needs to see it. The key material is *realization*, and it must be readable **before** anything is decrypted. So the list goes into the document payload as a managed field, and the wraps go onto entry metadata — putting them in the payload would be circular.

Keeping the list in the document is what makes concurrent edits safe. As a per-entry snapshot, two people editing offline would resolve as last-writer-wins over a whole set, and "Alice removed Bob" against "someone added Carol" would silently lose one edit. As a merging map keyed per recipient, both survive. Removals are tombstones that are only ever set, so remove always wins over a concurrent re-add — a security decision should not depend on how a merge algorithm happens to order a delete against a put. Re-adding a removed person is a new entry in a new generation, which is also what it means cryptographically: they get the current key, not the one they lost.

Crucially, **intent is not access**. Nothing in the list grants anything; access comes from a wrap. A hostile writer who adds themselves gains nothing until a client that can actually read the document re-seals it — and to edit the field at all they must already be able to read it.

The key material itself is stored efficiently. Only entries that *change* the recipient set carry a recipient block, so ordinary writes pay nothing. Within a block, the key generations are bundled under a single symmetric key and only that key is wrapped per recipient, which makes the cost `generations + recipients` rather than `generations × recipients`. Each block carries the full bundle for its generation plus only the new wraps, so a recipient needs exactly one entry — the newest one addressing them — to reconstruct every generation. Sealed keys are cached in memory per session rather than in the KeyBag, which is persisted as a single blob and would otherwise grow with the document count and be rewritten on every share.

### 7.6 Personal documents

Once documents can be sealed to a person, `userdirectory` becomes the natural home for a person's own data — the kind that should follow them between devices without any administrator provisioning a database for it. Three prefixes exist so far, and the shared property that makes `userdirectory` the right home is not privacy but **writability**: it is the one database where every member can create their own documents without anybody granting them anything.

| Prefix | What it is | Who may read it | Id |
|---|---|---|---|
| `wks_` | The roamed workspace and application list, one document per save id | sealed to its owner | generated |
| `dev_` | Where a device can be dialled over Iroh (§7.6.1) | every member, via the tenant `default` key | derived from the device key fingerprint |
| `qtn_` | A write the server turned away, kept so it can be found and offered again (§7.6.2) | every member, via the tenant `default` key | derived from author, database, document and rejection class |

These documents need the opposite of what a key document needs. A key document is published: everybody must read it, and its owner is named inside it by `username_hash`. A personal document is not: it is encrypted so that the hoster cannot read it, which means ownership cannot be read out of the payload — exactly what the rule in section 7.2 does.

The ownership rule is about *who may write*, and it is deliberately independent of *who may read*. A personal document may be sealed to its owner alone, or encrypted with the tenant `default` key so that every member can read it; either way only the person who signed the create may change it. Both variants exist, as the table shows.

**Ownership is the person who signed the create.** That is available to everyone without decrypting anything: the create entry names its signing key, and grants map that key to a person's `username_hash`, the same resolution the change rule already uses. Every device of that person resolves to the same hash, so roaming across your own devices works, while another member's devices never match.

| Operation | Who may perform it |
|---|---|
| Create | any granted device (the creator becomes the owner) |
| Change | **only** the owning person |
| Delete | the owning person, or the administrator |
| Undelete | the owning person, or the administrator |
| Read | whoever the document was encrypted for — its sealed recipients, or every member when it uses the tenant `default` key |

Two entries in that table differ from key documents, both deliberately. **The owner may delete**, because a person who stops roaming a workspace must be able to remove it — for a key document deletion is an administrative repair, here it is ordinary use. **The administrator may delete but not change**, so a departed member's data can be cleaned up while editing a document nobody but its owner can read stays impossible; the write would only ever produce garbage or a downgrade attempt.

The prefix is what marks a document as personal, and that is a deliberate choice over a payload field: the server must apply the rule to a document it cannot decrypt, so the discriminator has to live in plain metadata. Ids are generated (`wks_` plus an object id) rather than derived from the save id, which keeps two devices from racing for the same id and lets the document carry `recipients` — a caller-chosen convergent id and recipient sealing are mutually exclusive, because a convergent id needs a derived document key while sealing generates one.

Because ids are generated, two devices enabling roaming for the same save id while partitioned create two documents. They converge by rule rather than by merge: the lexicographically smallest id wins (object ids are time-sortable, so this is the older one), the loser is absorbed once and then deleted by its owner. This costs one extra document in a race that heals on the first sync, which is cheaper than the alternative of a convergent id without sealing.

#### 7.6.1 Peer-device records (`dev_`)

A device that wants to sync directly with another device of the same tenant has to publish where it can be reached: its Iroh endpoint id. That is a personal document under the prefix `dev_`, and it is the case where "personal" and "sealed" come apart.

**It uses the tenant `default` key, not recipient sealing.** Sealing it to its owner would defeat the purpose — the whole point is that *other* members can find the device and dial it. `$publicinfos` is not an option either, because the hoster holds that key, and who syncs with whom is not the hoster's business. `default` is distributed to members and never leaves the tenant, which lands exactly between the two: every member reads it, the server stores bytes it cannot open.

**The id is derived, not generated.** `dev_<fingerprint of the device signing key>`, with the colons stripped so it satisfies `^[a-z][a-z0-9_]*$`. Deriving it means a device republishing after a reload updates one record rather than accumulating one per session — the opposite trade-off from `wks_`, and available here precisely because the document is not sealed.

**A record is a claim until it is verified.** Any member can write a `dev_` document naming any endpoint id, so a reader must accept one only when all three hold:

1. the id is the fingerprint of the `signingPublicKey` in the payload,
2. the `doc_create` entry was signed by exactly that key, and
3. that key is an active, non-revoked grant.

Together these mean only the device that owns a signing key can publish a record under it. `listPeerDeviceRecords` applies all three and silently drops what fails — an unverifiable record is the expected shape of an attack, not an error worth surfacing.

**Known limit — id squatting.** A member can create `dev_<another device's fingerprint>` before that device does. The squatted record fails check 2 and so can never impersonate anyone, but the real device then cannot claim its own id and stays invisible to peer pickers. The symptom is a record that is present yet unverifiable.

Publishing a record is not the same as accepting connections. A device advertises so others can dial it; whether it answers is a separate, off-by-default choice, and the endpoint only exists while the app is running. See [iroh.md](iroh.md) for the listener-side checks.

#### 7.6.2 Quarantine records (`qtn_`)

When a device pushes a change and the server refuses it — the author's write right was withdrawn in the meantime, most often on a change that arrived over peer-to-peer sync from somebody else — the push moves on rather than blocking the database, and leaves a record behind. See [accesscontrol.md](accesscontrol.md) §10.1 for what the record is for and how re-submitting works; this section is about why it lives here.

**It cannot live in the database it is about.** That is the whole reason for the prefix. The record documents the loss of a write right on some database, so writing it *there* would earn exactly the same refusal as the entry it documents — a log that cannot be written precisely when there is something to log. `userdirectory` is the one database where a member can create their own documents unconditionally.

**It uses the tenant `default` key.** Same reasoning as `dev_`, arrived at from the other end: `$publicinfos` is out because the hoster holds that key, and which of a tenant's writes were refused is none of the hoster's business. `default` makes the record readable to every member, which is what turns it into an audit trail rather than one device's private note, while the server stores bytes it cannot open.

**The id is derived, and the author's key fingerprint is part of the derivation.** Deriving it from (author fingerprint, database, document, rejection class) makes recording idempotent: a retry that fails the same way updates one record instead of adding another, and a cascade of refused entries on one document collapses into a single record carrying a capped list of entry ids. Folding in the *author* is load-bearing rather than decorative. Without it, two members refused on the same document for the same reason would derive the same id — and since the rule in §7.2 only lets the creator write a personal document, the second member's record would be refused by the very invariant that is supposed to protect it. Including the fingerprint keeps id and ownership in agreement.

**A record is a claim until it is verified**, and here the stakes are higher than for `dev_`: the record says *this person tried to write something they were not allowed to write*. An unverified one is a way to put words in someone else's mouth. `verifyQuarantineRecord` applies the same three checks as `dev_` — the id derives from the payload's own fields including the fingerprint of the `signingPublicKey` it names, the `doc_create` was signed by exactly that key, and that key is an active non-revoked grant.

**Known limit — silence proves nothing.** Nothing compels a device to write a record, so the absence of one is not evidence that nothing was refused. Like `dev_`, this is a tool for auditing cooperating devices, not for catching an uncooperative one.

---

## 8) Security Model

User keys add a person-level addressing layer to a system that already encrypts payloads and authenticates every sync. This section states what that buys, and — more importantly — what it does not.

### 8.1 What the design defends against

- **Administrators and the sync server cannot read content addressed to user keys.** The private half never leaves the devices a human approved.
- **A planted grant device gains nothing.** An administrator who adds a device to a person's grant obtains neither that person's user key nor named keys addressed to it, absent human approval on an already-enrolled device. This holds for new content only once generations must be signed (section 9.3): before that, a planted device could write a generation of its own at a higher epoch, and new content would be encrypted to it.
- **Planting a device is never quiet.** It requires an admin-signed grant change, which stays in the append-only directory permanently and is attributable.
- **A planted public key cannot be swapped in later.** Administrators may create and delete key documents but may not change somebody else's.
- **Forged key documents are rejected** by grant binding, and squatting a canonical document id costs a scan rather than access.
- **Senders learn only published public keys.** Encrypting for someone reveals nothing else about them.
- **Device churn is free.** Approving or removing a device invalidates no ciphertext and rewrites no distribution.
- **Losing the published document is not a compromise or a data loss event.** It costs one idempotent republish and re-encrypts nothing.

### 8.2 Known limits

These are properties of the design, not defects to be fixed later. State them in your own product documentation rather than implying stronger guarantees.

- **A removed device keeps what it had.** It retains the private key it already unwrapped and can read the content it could already read, indefinitely. Rotation only cuts off future generations, and existing documents are deliberately not re-encrypted. Blocking that device relies on the sync plane and remote wipe.
- **Removal does not rotate by itself.** An application that revokes a device but never calls `rotateUserKey()` leaves it able to open everything addressed to the current generation. This is a policy decision the SDK deliberately leaves to you (section 5.4).
- **Approval is only as strong as the human performing it.** A user who confirms a device without comparing fingerprints can authorize a planted one, handing over every key they hold at once.
- **The first device is trusted on first use.** A trust chain rooted in a planted device is compromised from the start, and the initial publish wraps every device already on the grant.
- **The policy plane stays administrator-trusted.** An administrator can still edit groups or add themselves to a distribution. User key addressing stops device planting, not malicious policy.
- **A copied identity is the same device.** A restored backup, a paper recovery or an exported `.json` identity carries the same device keys, user key and self-grant key. Revoking or wiping that device hits every copy, and a stolen copy cannot be cut off alone (section 9.5).
- **An approved device can always export the private key.** This is an exfiltration path at the application layer, not a protocol flaw.
- **An administrator can repeatedly purge a key document** as denial of service. It never grants read access.
- **There is no administrator recovery.** User private keys are deliberately not wrapped to an administrator or a recovery quorum. If that is ever offered it must be opt-in and visually distinct from device approval, so that "approve my phone" is never confused with "give IT a copy".

### 8.3 What each party can see

Encryption hides content, but it does not hide the shape of who is talking to whom. It is worth knowing exactly where that line falls before you decide what to put in a sealed document.

| Party | Can see | Cannot see |
|---|---|---|
| Sync server | Published public keys; which device fingerprints hold a wrap; which key fingerprints a document is sealed to, and when that changed; that `dev_` and `qtn_` records exist and who created them | Any plaintext; recipient display names; any private key; the endpoint ids inside `dev_` records, so not which devices sync with each other; the contents of `qtn_` records, so not which of its own refusals a tenant is tracking |
| Tenant member (not a recipient) | Published public keys; the existence of sealed documents and their recipient fingerprints; every `dev_` record, including endpoint ids and device labels; every `qtn_` record, so which member was refused on which document and why | The contents of a sealed document or its recipient list |
| Recipient | The document contents and its full recipient list with names | Other people's private keys |
| Administrator | Everything a member sees, plus the grant | Content addressed to a user key they were not approved for |

Two exposures are worth calling out because they are structural. Because key documents are encrypted with `$publicinfos`, the sync server — not just members — can read the published public keys and see which device fingerprints hold a wrap. And because entry metadata is cleartext, the graph of recipient fingerprints and its timeline leak, which is strictly more than a named key exposes. Mitigating the latter would mean encrypting the wrap list, which would destroy the cheap "am I addressed here" check that visibility depends on.

---

## 9) Device Self-Grant and Signed Generations

Section 4 describes two separate decisions per device: the administrator puts its signing key on the person's grant (sync and write access), and the person approves it on an already-enrolled device (the user key, and with it read access). This section adds two things on top of that model. Generations of the user key now have to be signed, which closes a gap in section 8.1. And a person can receive a **device self-grant key**, an admin-signed right to vouch for their own devices.

### 9.1 The gap signed generations close

Anyone whose signing key is on Alice's grant may change Alice's key document (section 7.2). That includes a device the administrator added but Alice never approved. Before signed generations, such a device could write a new generation with a key pair only it knew at a higher epoch. Every client takes the highest epoch as current, so new sealed documents for Alice and new key distributions to her would have been encrypted to that device. `UserKeyGenerationSignature.test.ts` reproduces this.

The fix makes every generation accountable to a holder of the previous one, or to the person's self-grant key.

### 9.2 The keys involved

| Key | Type | Where it lives | Who holds the private half |
|---|---|---|---|
| Device signing key | Ed25519 | grant (`userKeyPairs`) | one device |
| User key, one per generation | RSA-OAEP 3072 | key document (`userKeys[epoch].publicKey`) | approved devices, via wraps |
| Generation signing key | Ed25519 | key document (`userKeys[epoch].signingPublicKey`) | derived by every holder of that generation |
| Device self-grant key | Ed25519 | grant (`deviceSelfGrant.signingPublicKey`), admin-signed | approved devices, via wraps |

The **generation signing key** is not stored anywhere. Every device that holds a generation's private user key derives it with HKDF-SHA-256 (`info = "mindoodb-userkey-generation-signing-v1"`) and uses the result as an Ed25519 seed. Only the public half is written to the generation. A signature with it therefore proves "this was written by someone holding generation N", and nobody can check the derivation without the private key, which is exactly the point.

The **device self-grant key** is one key per person. `factory.ensureUserKeyPair()` creates it together with the user key, stores it password-encrypted on the identity (`PrivateUserId.deviceSelfGrantKeyPair`, salt `"deviceselfgrant"`), and `createJoinRequest()` sends its public half (`deviceSelfGrantPublicKey`). Every approved device receives it next to its user key wrap (`deviceWraps[fp].wrappedSelfGrantKey`), so it is bound to the same approval as the user key. A person who has a user key but no self-grant key gets one from the first updated device that holds the user key; that device wraps it to the other approved devices on its next reconcile.

The private half is generated on the person's device, never by the administrator. If the administrator generated it, they could vouch for devices in the person's name.

### 9.3 When a generation counts

A generation counts only when the change that gave it its current value (`publicKey` and `signingPublicKey`) meets one of these rules:

1. **Root.** The value was already in the document's `doc_create`. Only the administrator (from the join request) or the person may create the document.
2. **Signed.** One of its `signatures` verifies over the generation with the `signingPublicKey` of the previous generation that counts, or with the person's self-grant key from the grant. The self-grant key does not count for changes after its `revokedAt`.
3. **Adoption.** The lowest epoch was replaced while the document had no device wrap at all, self-signed with its new `signingPublicKey`. This is the pending document of section 4.2, which nobody could use yet.
4. **Legacy.** The change's trusted time (its witness time, section 8 of [accesscontrol.md](accesscontrol.md)) is before the cutoff.

The **cutoff** is the earlier of two values. The first is the tenant-wide `requireUserKeyGenerationSignatureSince` in the admin-signed default policy. New tenants are created with it set; for an existing tenant, `directory.requireUserKeyGenerationSignatures(adminKey, password)` sets it once. The second is the person's `deviceSelfGrant.grantedAt`. Without either, every generation counts as before, so existing tenants keep working until the administrator turns the check on.

Generations that do not count are ignored when clients decide what is current: `resolveUserKeyDocument()` returns them in `rejectedEpochs`, `payload` lists only the generations that count, and `rawPayload` is the document as stored. If a device overwrites a generation in place, the last earlier value of that epoch that counted is used instead. Rotation always picks an epoch above every stored one, so a planted epoch cannot block it.

The signed bytes are `JSON.stringify(["mindoodb-userkey-generation-v1", username_hash, epoch, publicKey, fingerprint, signingPublicKey, createdAt])`, with whitespace removed from both PEM keys. Wraps and `retiredAt` are left out because they change during a generation's life.

What the client does for you:

- `rotateUserKey()` signs the new generation with the previous generation's key and, when held, with the self-grant key. When it can sign with neither and the cutoff has passed, it refuses: the generation would not count.
- `reconcileUserKeys()` gives the current generation its `signingPublicKey` when it has none, but only when that change will count (pending document, before the cutoff, or signed with a granted self-grant key). A generation created before signed generations existed therefore gets its key on the first reconcile of an updated device.
- A person who loses every device cannot add a new generation after the cutoff, because there is nothing to sign it with. The administrator deletes the key document (`deletePublishedUserKeyFor`) and the new device creates a new one, which counts as a root.

### 9.4 Granting the right to vouch for own devices

The delegation lives only in the admin-signed grant:

```ts
// grantaccess document
deviceSelfGrant?: {
  signingPublicKey: string,   // the person's self-grant key, PEM
  grantedAt: number,
  revokedAt?: number,         // set on revoke, the key stays
}
```

The key document never carries this right. The administrator may create a key document but never change it, so a copy there could neither be revoked nor be kept from being swapped by the person.

| Call | Effect |
|---|---|
| `tenant.approveJoinRequest(request, { ..., allowDeviceSelfGrant: true })` | Names the self-grant key from the request in the grant, only for the person's first device (the request's user key became the published one). |
| `tenant.getDeviceSelfGrantPublicKey()` | The person's key as held by this device, for an administrator to grant later. |
| `directory.setDeviceSelfGrant(username, publicKey, adminKey, password)` | Grant or replace the delegation. |
| `directory.setDeviceSelfGrant(username, null, adminKey, password)` | Revoke: sets `revokedAt` and keeps the key, so what was signed before stays valid. |
| `directory.getDeviceSelfGrant(username)` | Read it. |
| `directory.updateUserGrant(username, { deviceSelfGrant }, ...)` | The same as part of a batched grant edit. |

Granting it also moves the person's cutoff to `grantedAt`: from then on their unsigned generations stop counting, whatever the tenant policy says.

### 9.5 Cloned identities and backups

A device, as far as MindooDB is concerned, is its signing and encryption key pair, not a piece of hardware. The identity object holds those keys, the user key and the self-grant key. Whoever copies the identity copies all of them. Haven offers three official ways to do that: the encrypted backup, paper recovery per tenant, and the identity export as `.json`.

So **a restored backup is the same device today**, not a new one:

- the grant shows one device where there are two,
- revoking or wiping its signing key hits every copy (see [accesscontrol.md](accesscontrol.md) §6.5),
- writes cannot be told apart, because `createdByPublicKey` is the same,
- per-device records keyed by the signing key, such as `dev_<fingerprint>`, overwrite each other,
- a stolen copy cannot be cut off without cutting off the original.

For a second device, the join and approval flow of section 4 is the right path. Device certificates signed with the self-grant key, which turn a restore into a new device with its own keys, are the next step of this design.

### 9.6 Limits

- **The pending window.** Until the first device seals a new person's document, any device on the grant may adopt it, as before.
- **Legacy generations stay as trustworthy as they were.** A generation that counts because of the cutoff is not more trustworthy than before; the cutoff only stops new unsigned ones.
- **Unwitnessed changes.** A change no trusted witness has stamped yet takes the current time as its trusted time, so it counts as after the cutoff. In tenants without a witness, every unsigned generation stops counting once a cutoff is set. New tenants avoid this because all their generations are signed or roots.
- **Several self-grant keys.** Two devices without a self-grant key that reconcile at the same time may each create one. The key the administrator grants decides; devices prefer a wrap of the granted key.

---

## 10) Reference Appendix

### 10.1 API reference

Ordering rule for the whole table: sync the directory databases, then reconcile user keys, then reconcile key distributions. Reversing the last two leaves `default` unimported, because its wrap is addressed to the key the first call delivers.

**Setup and enrollment**

| Call | Purpose |
|---|---|
| `factory.ensureUserKeyPair(user, password)` | Create the person's keypair on the identity if absent. Call before `createJoinRequest` or `createTenant`. |
| `factory.createJoinRequest(user, { format?, label? })` | Build a join request. Includes the user public key when the pair exists. |
| `tenant.approveJoinRequest(request, { adminSigningKey, adminPassword, label, serverUrl? })` | Register the grant, publish the key document, wrap `default`, and wrap the key for the device when the approver is the same person. |
| `factory.joinTenant(response, { user, password })` | Import `$publicinfos`, open the tenant, adopt the registered username. |
| `factory.discoverTenantsOnServer(url, { user, password })` | List tenants where this device's signing key has an active grant. |
| `factory.bootstrapTenantFromDelivery(delivery, { user, password, serverUrl? })` | Open a tenant from a discovery result; with `serverUrl`, run the full reconcile sequence. |
| `tenant.noteUserDirectoryFetched()` | Declare that `userdirectory` reflects the server. Required before a first publish. |
| `tenant.reconcileUserKeys({ allowSelfCreate? })` | Hop 1. Resolve, create or seal the document, import this device's wrap, drop revoked wraps. |
| `tenant.reconcileKeyDistributionsForCurrentUser()` | Hop 2. Import `default` and other named keys addressed to the user key. |

**Device management**

| Call | Purpose |
|---|---|
| `tenant.listPendingUserKeyDevices()` | Grant devices with no wrap and no recorded refusal. |
| `tenant.listUserKeyDevices()` | All grant devices with status `approved`, `pending`, or `declined`. |
| `tenant.approveUserKeyDevice(fingerprint)` | Write the private key wrap for every generation. |
| `tenant.declineUserKeyDevice(fingerprint)` | Record a persistent, synced refusal. |
| `tenant.undoDeclineUserKeyDevice(fingerprint)` | Reverse a refusal and return the device to pending. |
| `tenant.rotateUserKey()` | Create a new generation for the remaining devices and retire the current one. Signs it (section 9.3). |
| `tenant.getDeviceSelfGrantPublicKey()` | The person's device self-grant key as held by this device (section 9.4). |

**Device self-grant and signed generations (section 9)**

| Call | Purpose |
|---|---|
| `tenant.approveJoinRequest(request, { ..., allowDeviceSelfGrant: true })` | Also name the person's self-grant key from the request in the grant (first device only). |
| `directory.setDeviceSelfGrant(username, publicKey \| null, adminKey, password)` | Grant, replace or revoke the delegation on the grant. |
| `directory.getDeviceSelfGrant(username)` | Read the delegation. |
| `directory.requireUserKeyGenerationSignatures(adminKey, password)` | Set the tenant cutoff for unsigned generations to now (idempotent). |
| `directory.getRequireUserKeyGenerationSignatureSince()` | Read that cutoff. |

**Queries and per-document recipients**

| Call | Purpose |
|---|---|
| `tenant.hasDecryptionKey(keyId)` | Whether a symmetric key such as `default` is available locally. |
| `db.createDocument({ recipients, recipientOptions })` | Create a sealed document. Mutually exclusive with `decryptionKeyId`. |
| `db.addRecipients(doc, recipients, options?)` | Add readers. One wrap each, no rotation. |
| `db.removeRecipients(doc, recipients, options?)` | Remove readers. Creates a new generation. |
| `db.setRecipients(doc, recipients, options?)` | Declarative form; diffs and does both. |
| `db.canChangeRecipients(doc, next)` | Access control dry run. |
| `doc.isSealed()` / `getRecipients()` / `getRecipientEpoch()` / `isEncryptedFor(users)` | Inspect a sealed document's readership. |

`RecipientChangeResult` reports `epoch`, `rotated`, `added`, `removed`, `skipped`, and `entryId`. `skipped` lists recipients passed over because they have no published user key; pass `strict: true` to fail instead.

### 10.2 User key document schema

One document per person in `userdirectory`, encrypted with `$publicinfos`.

```ts
{
  form: "userdirectory",
  type: "userkey",
  schemaVersion: 1,

  // Copied from the person's grant. This field, not the document id, is what
  // the fallback lookup matches on and what the write invariant compares the
  // signer against.
  username_hash: string,
  username_hash_v: number,

  // Every generation, keyed by epoch as a decimal string ("1", "2", ...).
  // A map rather than an array so that two devices rotating while partitioned
  // merge per generation instead of producing two array entries.
  userKeys: Record<string, {
    publicKey: string,          // RSA-OAEP 3072, PEM
    fingerprint: string,
    createdAt: number,
    retiredAt?: number,         // set when a newer generation supersedes it

    // The private half of THIS generation, only ever as wraps to device
    // encryption keys the person explicitly approved. Never populated from
    // grant membership alone. Keyed by device encryption-key fingerprint.
    deviceWraps: Record<string, {
      wrappedKey: string,
      label?: string,           // from the grant, shown in the approval dialog
      approvedAt: number,
      approvedBySigningPublicKey: string,
      // The person's device self-grant key (Ed25519 PKCS8), wrapped to the
      // same device key (section 9.2).
      wrappedSelfGrantKey?: string,
    }>,

    // Ed25519 key derived from this generation's private key (section 9.2),
    // and signatures over the generation by the previous generation's key
    // and/or the person's self-grant key (section 9.3).
    signingPublicKey?: string,
    signatures?: Array<{ signerPublicKey: string, signature: string }>,
  }>,

  // Written by "don't ask about this device again" and cleared by
  // "allow after all". Synced, so the choice holds on every device. Does not
  // affect the grant.
  rejectedDevices?: Record<string, {
    signingPublicKey?: string,
    rejectedAt: number,
    rejectedBySigningPublicKey: string,
  }>,
}
```

Invariants the publisher maintains:

- Every wrap targets an **active** device of the publisher's own grant that the user **approved**. Grant membership alone never adds a wrap.
- A newly approved device receives a wrap for **every generation the approving device can open**, not only the newest — otherwise it cannot read older content.
- A generation's `publicKey` and `fingerprint` match the private key sealed in its wraps.
- Epochs only ever grow; reusing or lowering one is rejected.
- A new generation is signed (section 9.3); one that does not count is ignored, not deleted.
- Wraps for devices no longer active on the grant are dropped on the next reconcile.
- A document with no wraps in any generation is **pending**: published but not yet openable.

### 10.3 Recipient specs and types

```ts
type RecipientSpec =
  /** Shorthand for { user: name }, resolved through userdirectory. */
  | string
  | { user: string }
  /**
   * A single device: either an encryption-key fingerprint resolved through the
   * grant, or a raw RSA-OAEP public key for a target that is not a tenant
   * device, such as an offline backup vault. `label` is display only.
   */
  | { device: string; label?: string }
  | { devicePem: string; label: string };

interface RecipientOptions {
  /** Default true. Setting it false is how you write a document you cannot read. */
  includeSelf?: boolean;
  /** Fail instead of skipping when a recipient has no published user key. */
  strict?: boolean;
}

interface ResolvedRecipient {
  kind: "user" | "device";
  /** Username for people, encryption-key fingerprint for devices. */
  id: string;
  keyFingerprint: string;
  label?: string;
  addedInEpoch: number;
  /** False while the document lists this recipient but no wrap addresses them. */
  sealed: boolean;
}
```

Names are display only — fingerprints stay authoritative for every access decision — and a label is attacker-supplied text: render it, never interpret it, and never let a name decide access.

Older documents may carry a `viaGroup` field on recipient entries, left from when recipients could be expanded from a directory group. It is ignored on read and no longer written.

### 10.4 What users see

Wording matters here more than in most features, because the concepts are unfamiliar and the consequences are permanent. Use **device** language throughout; never say "user key", "wrap", or "KeyBag" in an interface.

| Situation | What to show |
|---|---|
| First device joins | Nothing. The key is created silently. |
| Newly granted user already holds `default` | Nothing. Key distribution delivered shared tenant access; there is no other device of this person that could approve a user key. |
| Existing user, first launch with user keys | Nothing. The key is published and every existing device is wrapped. |
| Your own additional device, approved by yourself | Nothing to confirm. It is ready once it has synced. |
| A new device is waiting for access | "**Your laptop 'Alice's laptop' wants access to your personal data.** Your private notes, backups and settings are locked so that only your own devices can open them. If you just set this device up, allow it. If not, someone else is trying to reach your data." Show the device label and a short fingerprint to compare. Offer *Yes, that's my device*, *Not now*, and *Don't ask about this device again*. |
| The user chooses *Not now* | Close the dialog, write nothing, ask again next time. An unresolved device should stay visible rather than quietly disappearing. |
| The user chooses *Don't ask again* | "We won't give that device access to your personal data. It may still sync shared team data your administrator controls." Record and sync the refusal so no other device asks. |
| The user changes their mind | Show declined devices in the device list with *allow after all*, which returns the device to pending. |
| This device is waiting for approval | "This device can't open your personal data yet. Open the app on your other device and confirm this one." Show this instead of empty-looking databases. |
| A device is lost or stolen | "Create a new personal key so that device can't open your personal data going forward." Never imply that data already on the device disappears. |
| All devices lost | "We'll start a new personal key on this device. Things you saved earlier stay locked until they are saved again — unless you still have a backup of one of your old devices, which brings them back." |

The recurring dialog is the safety net against a planted device. *Don't ask again* exists so that repetition never becomes the reason somebody approves.

### 10.5 Verified behaviour

The behaviour described in this document is covered by the SDK test suite. Run it with:

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest \
  src/__tests__/UserKey \
  src/__tests__/UserDirectoryInvariant \
  src/__tests__/Sealed \
  src/__tests__/JoinUserKeyWrap.test.ts \
  src/__tests__/JoinSecondDeviceServer.test.ts \
  src/__tests__/JoinFlow.test.ts \
  src/__tests__/KeyDistributionUserKeyTargets.test.ts \
  src/__tests__/CreateTenantIdentityUserKey.test.ts \
  --testTimeout=240000
```

The `NODE_OPTIONS` flag is needed only by `JoinSecondDeviceServer.test.ts`, which starts a local HTTP server and reaches the network store through a dynamic import.

| Behaviour | Section | Suite |
|---|---|---|
| An administrator publishes a pending document from a join; the first wrap ends pending | 4.2 | `UserKeyDocumentLifecycle` |
| The first device imports `default` after writing its own wrap | 3.3, 4.2 | `JoinFlow` |
| Same-person approval wraps the key for the joining device | 4.3 | `JoinUserKeyWrap` |
| A second device discovers and unwraps `default` with no separate approval | 4.3 | `JoinSecondDeviceServer` |
| Another person's device stays pending until they wrap it | 4.4 | `JoinUserKeyWrap` |
| An unapproved device does not import `default`; an approved one does | 4.4 | `KeyDistributionUserKeyTargets` |
| An approved device holds the identical private half | 4.4 | `UserKeyDeviceRemovalRotation` |
| Approval wraps every generation | 10.2 | `UserKeyDeviceRemovalRotation`, `UserKeyDeviceEnrollment` |
| A grant-only device is never wrapped automatically | 4.7 | `UserKeyDeviceEnrollment` |
| A first publish wraps every device already on the grant | 4.5 | `UserKeyDeviceEnrollment` |
| No document is published before `userdirectory` has been fetched | 3.3 | `UserKeyDeviceEnrollment` |
| Declining hides the device everywhere; undo restores it | 4.7 | `UserKeyDeviceEnrollment` |
| A planted, unsigned generation is ignored once signatures are required; without a cutoff it still counts | 9.1, 9.3 | `UserKeyGenerationSignature` |
| A planted generation signed with its own key is ignored | 9.3 | `UserKeyGenerationSignature` |
| An overwritten generation falls back to its earlier value | 9.3 | `UserKeyGenerationSignature` |
| Granting device self-grant closes the gap for that person; rotation stays signed and counts | 9.3, 9.4 | `UserKeyGenerationSignature` |
| The join request carries the self-grant key; approval names it in the grant; revoke keeps the key | 9.4 | `UserKeyGenerationSignature` |
| An approved device receives the person's self-grant key, replacing one it made before joining | 9.2 | `UserKeyGenerationSignature` |
| Removal drops wraps from every generation but does not rotate | 5.1 | `UserKeyDeviceRemovalRotation` |
| Rotation excludes the removed device from the new generation | 5.2 | `UserKeyDeviceRemovalRotation` |
| A removed device cannot obtain the rotated generation | 5.2 | `UserKeyDeviceRemovalRotation` |
| Rotation keeps old generations readable for remaining devices | 5.2 | `UserKeyRotation`, `UserKeyDeviceRemovalRotation` |
| Named keys are wrapped once per person, and to the new key after rotation | 1, 5.2 | `KeyDistributionUserKeyTargets` |
| Forged documents are rejected; lookup survives a squatted id | 7.3 | `UserKeyDocumentLifecycle` |
| Creating over a tombstone restores rather than duplicates | 7.4 | `UserKeyDocumentLifecycle` |
| Owner-only change, admin-only delete, everyone reads | 7.2 | `UserDirectoryInvariant` |
| Sealed documents, recipient changes, stale generations, visibility | 6 | `SealedDocumentRecipients`, `SealedRecipientMutation`, `SealedRecipientVisibility`, `SealedStaleGeneration`, `SealedRecipientConcurrency` |
| Removal hides the document on the next sync, with no follow-up edit | 6.5 | `SealedStaleGeneration` |
| A removed reader gets a tombstone, never a decryption exception | 6.5 | `SealedStaleGeneration`, `SealedRecipientVisibility` |
| Re-adding a reader restores the document with its full history | 6.5 | `SealedRecipientVisibility` |

---

## 11) Related Documents

- [accesscontrol.md](accesscontrol.md) — who may read and write, the directory, grants, and key distribution. User keys decide who can decrypt; these rules decide who can change state.
- [getting-started.md](getting-started.md) — tenant creation, the join flow, the KeyBag, and identity persistence.
- [network-sync-protocol.md](network-sync-protocol.md) — how encrypted entries move between devices and servers, and how device discovery works.
- [attachments.md](attachments.md) — attachment encryption, which follows the document's key.
- [specification.md](specification.md) — the underlying data model and entry format.
