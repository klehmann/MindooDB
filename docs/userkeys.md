# User Keys & `userdirectory`

A stable, person-bound encryption identity that outlives individual devices, so
content can be addressed **to people (or to specific devices)** without
distributing shared symmetric keys.

Status: implemented. `userdirectory` is a system database with a hard-wired write
invariant; `userkey_*` documents live there. See `src/core/userkeys/` and
`src/core/builtinDbInvariants.ts`.

---

## 1. Motivation

### 1.1 What we can do today, and what it costs

MindooDB encrypts document payloads with symmetric AES-256-GCM keys held in the
KeyBag and selected per document by `decryptionKeyId`. Getting such a key to a
person means **distributing the key itself**: an admin publishes
`acl_keydistribution_<keyId>`, and the key bytes are RSA-wrapped once per
**device** of every recipient (`wrapKeyForUserDevices`,
`src/core/BaseMindooTenantDirectory.ts:2060`), keyed by
`<username_hash>|<deviceEncKeyFingerprint>` (`src/core/accesscontrol/types.ts:644`).

That model is right for organizational cohorts — "everyone in HR holds
`hr-confidential`" — but it has three structural consequences:

1. **Sharing needs the admin as the writer, though not as a reader.** The wrapped
   bytes are produced by a key *holder* against each recipient device's public
   key, so an admin outside the recipient set never sees the plaintext key — the
   distribution itself is admin-blind
   (`src/core/accesscontrol/types.ts:611`). But only an admin can sign and save
   the document: a holder prepares a `KeyDistributionRequest` and hands it over
   ready to sign (`src/core/accesscontrol/types.ts:669`). Every act of sharing
   therefore still requires an administrative act.
2. **Withdrawal works, but only on cooperating clients.** `pullfrom` names the
   users whose KeyBags must *not* hold the manifest's versions
   (`src/core/accesscontrol/types.ts:648`); a syncing client deletes exactly
   those versions and purges the scope when nothing remains
   (`removeDecryptionKeyVersionsByFingerprint`,
   `src/core/BaseMindooTenant.ts:2300`). The key does not simply stay on the
   device forever. What the mechanism cannot reach is a modified client, an
   exported copy, or plaintext already cached — against a holder who does not
   cooperate, restricting readership still means rotating the key and
   re-encrypting forward.
3. **Addressing is per device.** A person is a set of device keys that changes
   over time. Encrypting "to Alice" means enumerating her current devices, so
   every device she adds or loses invalidates the addressing of everything
   already sealed for her.

### 1.2 What user keys buy

A user key is an RSA-OAEP keypair that belongs to a **person**, not a device.
Its public half is published so that anybody in the tenant can encrypt for that
person; its private half exists only on the devices that person has approved.
Addressing "to Alice" becomes a single, stable operation.

This unlocks cases that shared named keys serve badly or not at all:

**Personal backup.** A user exports an encrypted backup of their own data.
Sealed to their own user public key, the backup is readable on every device they
own — now and after replacing all of them — while remaining opaque to the admin,
the sync server, and every colleague. With named keys, a personal backup either
rides on a key others hold, or on a device key that dies with the device.

**Workspace sync between a user's own devices.** Preferences, layouts, drafts,
credentials, per-device workspace state: content whose readership is exactly
"me". Today that requires either a named key nobody else may receive — an admin
operation for a private matter — or per-device wraps that must be rewritten on
every device change. With a user key the workspace is sealed once to one
recipient, and enrolling a new device grants access to all of it without
touching a single document.

**Per-document recipient lists.** A document carries wraps of its DEK for its
current recipients (the Notes/Domino `PublicEncryptionKeys` model). Adding a
reader is an ordinary write by anyone who can already read the document; no
admin, no shared key, no KeyBag churn. This only scales if the wrap targets are
stable: with device targets, one person buying a laptop would require a new
entry in **every** document they can read — and they could only write those
entries where they hold write permission, so a user could not even enroll their
own device for documents they may only read. Person-level targets reduce that to
a single `userdirectory` write.

**Device-scoped readership where it is genuinely wanted.** Because the same
mechanism can address a device encryption key directly, readership can be
narrowed below the person: a kiosk, a service account, a bot, or a deliberately
restricted guest device. Person-level is the default; device-level stays
available as a special case.

**Closing the planted-device hole in named-key distribution.** Even the existing
path benefits: wrapping a named key version once per recipient **user** instead
of once per device removes the device-churn rewrite and closes a hole where an
admin who plants a device on a grant is included in the next re-wrap (§8).

### 1.3 What does not change

User keys are **addressing**, not payload encryption. Documents keep a symmetric
DEK for the payload; the DEK is what gets wrapped to user public keys. Nothing
about `decryptionKeyId`, the KeyBag, or AES-GCM payload encryption is replaced.

User keys are also **not** an authorization mechanism. Who may *write* a
document remains the job of the access-control system (`docs/accesscontrol.md`).
User keys decide who can *read ciphertext*; rules decide who can *change state*.
Conflating the two is the most common way to design this wrong.

---

## 2. Starting point in the code

| Fact | Where |
|------|-------|
| A device has an Ed25519 signing key and an RSA-OAEP 3072 encryption key | `src/core/BaseMindooTenantFactory.ts:176` |
| Devices of one person are entries in `grantaccess.userKeyPairs`, admin-signed | `src/core/types.ts:2652`, `docs/accesscontrol.md` §6.5 |
| `grantaccess` documents have **random** ids and are resolved by scanning for `username_hash`; several docs sharing a hash union their device keys | `src/core/utils/idGeneration.ts:88`, `docs/accesscontrol.md` §8.1 |
| `username_hash` (write version 3) is `SHA-256(tenantId + "/" + lower(NFKC(username)))` | `src/core/BaseMindooTenantDirectory.ts:4110` |
| Device encryption-key fingerprint is SHA-256 over the SPKI body, first 8 bytes as colon-hex | `src/core/BaseMindooTenantDirectory.ts:2026` |
| RSA wrapping is hybrid RSA-OAEP + AES-256-GCM, so payload size is not limited to one RSA block | `src/core/crypto/RSAEncryption.ts:105` |
| The KeyBag stores only symmetric `"doc"` keys, versioned, scoped `doc:<tenantId>:<keyId>` | `src/core/keys/KeyContext.ts:1` |
| The `directory` database is hard-coded admin-write-only | `src/core/BaseMindooDB.ts:8156` |
| A caller-provided document id must match `/^[a-z][a-z0-9_]*$/`, so it cannot start with a digit | `src/core/types.ts:1737` |
| `$publicinfos` is mandatory in the join response and required to open a tenant at all; `default` arrives later through distribution reconciliation | `src/core/BaseMindooTenantFactory.ts:581`, `:723`, `:894` |
| `changeDoc` applies only top-level property assignments (`automergeDoc[key] = value`); nested mutation through `getData()` is silently dropped | `src/core/BaseMindooDB.ts:9351` |
| `applyJsonPatch` writes a single nested path (`path: Array<string \| number>`), which is what merges per key | `src/core/types.ts:2536` |

**There is no person-level keypair today.** Every key in the system belongs to a
device or to the tenant. This document introduces the first identity that
belongs to a human being.

---

## 3. Mental model

```text
document payload
      │  AES-256-GCM
      ▼
    DEK ──── RSA-OAEP wrap ────►  recipient's public user key    (§9)
                                        ▲
                                        │ published, world-readable
                                        │ inside the tenant
                              ┌─────────┴──────────┐
                              │   userdirectory    │
                              │   userkey document │
                              └─────────┬──────────┘
                                        │ userPrivateKey, only as
                                        │ RSA wraps to devices the
                                        │ user explicitly approved
                                        ▼
                              approved devices of that user
```

Two planes that must never be confused:

| Plane | Authority | Question it answers |
|-------|-----------|---------------------|
| **Grant / sync** | Tenant admin | May this device speak as Alice on the wire? |
| **User-key access** | Alice's already-approved devices | May this device hold Alice's user private key? |

Appearing on `grantaccess` is **necessary but never sufficient** to receive the
user private key. An admin who mints a keypair and appends it to Alice's grant
must not thereby gain her private key — otherwise admin-blindness is theatre.
§6.2 is the gate that enforces this.

---

## 4. The `userdirectory` database

Canonical database id: **`userdirectory`** (lowercase, fixed).

### 4.1 Why a separate database

`directory` mutations are admin-only, and not by policy but by a hard-coded
check (`_isAdminOnlyDb`, `src/core/BaseMindooDB.ts:8156`). Users publishing
their own key material there would require either breaking that invariant or
letting the admin handle private material. A dedicated database keeps the admin
ACL authoritative in `directory` and lets users self-publish under ordinary
document-authorship rules in `userdirectory`.

### 4.2 Sync contract

Hosts open and sync `userdirectory` for every signed-in tenant member, the same
way `directory` is always brought up:

1. After identity unlock, ensure the local `userdirectory` exists.
2. Include it in the default sync set.
3. On bring-up and after each sync, reconcile the current user's own key
   document: import device wraps, and republish if the document is missing,
   deleted, or stale (§6.5).

The sync server treats it as an ordinary content database. It never needs a user
private key.

### 4.3 Payload encryption

The key document is encrypted with **`$publicinfos`**, the same key the grant
uses — not the tenant `default` key.

The deciding argument is bootstrap ordering, not visibility. `$publicinfos` is
delivered in the join response as a required field and a tenant cannot even be
opened without it (`src/core/BaseMindooTenantFactory.ts:581`, `:723`, `:894`).
`default` arrives later, through key-distribution reconciliation. Since the key
document is created **during the join flow** (§6.1), `$publicinfos` is the only
key guaranteed to be present at that moment. It also permanently avoids a
circular dependency if `default` is ever re-sealed to user keys (§12).

The cost is that the sync server can read the public keys and see which device
fingerprints hold a wrap. That is a small addition to what it already knows: the
full device list per user is in the grant, which is `$publicinfos` too. The new
information is only which subset of those devices was approved for the user key.

Confidentiality of the private key does not depend on this choice: it is
RSA-wrapped inside the payload regardless.

---

## 5. Document schema

### 5.1 Document id: canonical, with a fallback

The document mirrors the identity it belongs to: its id is derived from the id
of that user's `grantaccess` document in `directory`.

```text
userkey_<grantDocId>      e.g. userkey_65f2a1c4b8e0d9a7f3c21b04
```

The prefix is not cosmetic. A caller-provided id must match
`/^[a-z][a-z0-9_]*$/` (`src/core/types.ts:1801`), so it has to start with a
letter and may not contain uppercase. Current grant ids are 24-character hex
ObjectIds (leading digits); older grants used mixed-case ids
(e.g. `033p0Fh2PNGwn0yTqWp7UE`). `userKeyDocumentId` prefixes `userkey_` and
runs the grant id through `encodeAclIdComponent` so both forms are valid
custom ids. Hex object ids pass through unchanged.

**But the canonical id cannot be the only lookup path.** An ACL rule matches on
`dbid`, operation type and identity hashes only; `AclRuleDoc` has no document-id
field and no pattern operator (`src/core/accesscontrol/types.ts:279`). No rule
can express "this id belongs to that signer". Since grant ids are visible to
every member through `$publicinfos`, anyone could create Alice's
`userkey_<grantDocId>` **before she does**, and `$author` (§6.5) would then bind
change rights to the squatter, locking her out of her own canonical id.

So resolution takes the canonical id as a fast path and falls back to the same
content scan that grants already use:

```text
lookup(alice):
  1. try userkey_<grantDocId of alice>
     -> valid per §6.4 ?  use it.                        (normal case, O(1))
  2. otherwise scan userdirectory for type == "userkey"
     and username_hash ∈ hashCandidates(alice)
     valid  := filtered by §6.4 signature binding
     winner := max(valid) by (highest epoch, then lowest fingerprint)
```

Alice publishes under the canonical id, or — if it is already occupied by an
invalid document — under a generated id. Squatting therefore costs a scan
instead of a lockout, and the admin break-glass rule (§6.5) can clean the
occupied id up afterwards rather than being the only remedy.

A user with several `grantaccess` documents (they union their device keys,
`docs/accesscontrol.md` §8.1) has several canonical ids. Step 1 tries each; step
2 catches the rest. In the normal case exactly one key document exists per
person: the first device creates it, and every later device finds it and
**co-edits** it. Concurrent additions merge (§5.2), so two devices approving a
third in parallel do not conflict. The winner rule matters only after a genuine
fork and must be byte-deterministic so every client picks the same document.

### 5.2 Payload

```ts
{
  form: "userdirectory",
  type: "userkey",              // what kind of userdirectory document this is
  schemaVersion: 1,

  // Copied verbatim from the user's grantaccess document. This field, not the
  // doc id, is what the fallback lookup of §5.1 matches on.
  username_hash: string,
  username_hash_v: number,

  // Every generation of the person's encryption identity, keyed by epoch as a
  // decimal string ("1", "2", ...). A MAP, not an array: two devices that
  // rotate while partitioned write different generations, and Automerge merges
  // maps per key instead of leaving two array entries in arbitrary order.
  //
  // Old generations are never dropped. A device that loses grant access is
  // removed from the wraps below, but the remaining devices keep their wrap of
  // the retired key so that content sealed to it stays readable (§6.3).
  userKeys: Record<string, {
    publicKey: string,          // RSA-OAEP 3072, PEM SPKI
    fingerprint: string,        // SHA-256 hex over the SPKI body
    createdAt: number,
    retiredAt?: number,         // set when a newer generation supersedes it

    // The private key of THIS generation, only ever as RSA wraps to device
    // encryption keys the user has EXPLICITLY approved (§6.2). Never populated
    // from the grant alone.
    //   key = device encryption-key fingerprint (same scheme as
    //         encryptionKeyFingerprint(), BaseMindooTenantDirectory.ts:2026)
    // Also a map, for the same merge reason: two devices approving a third one
    // concurrently must not overwrite each other.
    deviceWraps: Record<string, {
      wrappedKey: string,       // base64(RSAEncryption.encrypt(privateKeyBytes, devicePem))
      label?: string,           // copied from grantaccess, shown in the approval dialog
      approvedAt: number,
      approvedBySigningPublicKey: string,
    }>,
  }>,

  // Only written by the explicit "don't ask about this device again" action,
  // and removed again by "allow after all" (§6.2). Keyed by device
  // encryption-key fingerprint. Synced, so the choice holds on every device --
  // which is also why undoing it needs a document write, not a local reset.
  // Does not affect grantaccess.
  rejectedDevices?: Record<string, {
    signingPublicKey?: string,
    rejectedAt: number,
    rejectedBySigningPublicKey: string,
  }>,
}
```

The current generation is the highest epoch in `userKeys`; it is derived, not
stored, because a scalar "current epoch" field would be exactly the value two
concurrently rotating devices overwrite for each other.

**Write through `applyJsonPatch`, never through `changeDoc`.** `changeDoc`
collects top-level property assignments and applies them as
`automergeDoc[key] = value` (`src/core/BaseMindooDB.ts:9351`). Reassigning a
whole map replaces it, so of two devices adding different wraps concurrently one
addition is lost — and mutating a nested object obtained from `getData()` is
silently dropped altogether. The granular path writes one nested key
(`src/core/types.ts:2536`), which is what merges:

```ts
await db.applyJsonPatch(doc, {
  set: [{
    path: ["userKeys", "2", "deviceWraps", deviceFingerprint],
    value: { wrappedKey, label, approvedAt, approvedBySigningPublicKey },
  }],
});
```

### 5.3 Publish-time invariants

- Every `deviceWraps` key is an **active** device of the publisher's own grant
  and was **user-approved** (§6.2). Grant membership alone never adds a wrap.
- A newly approved device receives a wrap for **every generation the approving
  device can open**, not only the newest — otherwise it cannot read content
  sealed to earlier generations.
- `publicKey` and `fingerprint` of a generation match the private key sealed in
  that generation's wraps. The publisher verifies locally before writing.
- Every generation has at least one wrap while the user has ≥ 1 approved device.
- Epochs only ever grow. Reusing or lowering an epoch is invalid.
- Wraps for devices no longer active on the grant are removed on the next write
  (hygiene — it does not take anything away from that device, see §6.3).

---

## 6. Key management

This is the heart of the design: when the key comes into existence, who may hold
it, and how the published document survives hostile or careless neighbours.

### 6.1 Creation — silently, by the user's client

The key is created by **the user's own client**, never by the admin and never by
the server. Two triggers:

- **Join.** The joining device generates the User-Key **before** the Join-Request
  and puts `userPublicKey` on the request. The admin creates a *pending*
  `userkey_*` document (public key only) and wraps `default` to that public key.
  The Join-Response is only `$publicinfos`. The first device writes its own wrap
  after it can read `userdirectory`.
- **Existing tenant members** (Haven, first launch of a User-Key-aware client).
  After a successful **server pull** of `directory` then `userdirectory`, if no
  valid document exists for this person, the client mints a keypair, wraps the
  private half to **every active device on the current grant**, and **pushes**
  `userdirectory`. Local emptiness alone never mints (Trap 1). Devices added to
  the grant *after* that document exists still need explicit approval (§6.2).

Steps for the missing-document mint:

1. The device already has its Ed25519 + RSA keypair and is on `grantaccess`
   (admin-signed), and it holds `$publicinfos`.
2. Pull `directory`, then `userdirectory`. Look the document up per §5.1.
3. If none exists, generate a fresh RSA-OAEP 3072 keypair locally.
4. Wrap the private half to every active grant device (not only this one) and
   copy `username_hash` / `username_hash_v` from the grant.
5. Create the document at `userkey_<grantDocId>` with epoch `"1"`, encrypted
   with `$publicinfos` and signed with the device signing key, then push
   `userdirectory` and pull again (closes a two-device mint race).
6. Keep the private key in the session / KeyBag-protected storage.

No prompt for that first mint. Sibling devices that were already on the grant
import their wrap on the next pull and do not see an approval dialog. The user
learns about "devices that can read your personal data" when a **later** device
appears on the grant.

**This is trust-on-first-use of the grant snapshot, and that limit is real.**
The minting device becomes the root of the person's device-trust chain, and
every device already listed on the grant at that moment receives a wrap. A
device planted on the grant before this mint is included. A device planted
*after* the document exists is not — §6.2 is the gate. If an admin later
deletes the `userkey` document, the next honest client recreates it the same
way (again wrapping the current grant). That is noisy: content sealed to the
old public key stops opening, which is why it is an unlikely stealth attack.

### 6.2 Enrolling additional devices

The private key reaches a new device only as a wrap written by a device that
**already holds it**. There is no other path: not the admin, not the server, not
the grant. The devices of one person keep each other supplied, but only after
the human has said yes.

**The reconciliation loop.** On every Haven start, after `directory` has synced,
the client processes directory changes — it already does this for its internal
caches in `BaseMindooTenantDirectory` — and checks whether its own
`grantaccess` document changed. It then diffs the grant against the key
document:

| Difference | Action |
|---|---|
| Device on the grant, no wrap, not in `rejectedDevices` | **Pending.** Ask the user (below). Write nothing yet. |
| Device approved by the user | Wrap the private key of **every generation this device can open** for it, via `applyJsonPatch` |
| Device revoked on the grant or marked for wipe | Remove its wraps (hygiene only, §6.3) and offer rotation |

**The approval dialog.** A pending device produces a dialog at Haven start,
worded for people who do not know what a key is. It names the device using the
`label` from the grant when one is set, and shows a short fingerprint so the
user can compare it with what the new device displays.

Declining closes the dialog and persists nothing, so the question returns at the
next Haven start. That is deliberate: an unresolved device stays visible instead
of quietly disappearing, and an admin gains nothing from waiting. To protect
against the failure mode where a recurring dialog is what finally makes someone
tap *Approve*, the dialog carries a third, secondary action — *don't ask about
this device again* — which writes `rejectedDevices` and is synced to every other
device of the user.

**Undoing a refusal needs a real UI, however plain.** `rejectedDevices` lives in
the synced key document, so clearing local state does not help: the entry comes
straight back from the other devices, and even alone the client would have to
write a change to drop it. There must therefore be one screen — the list of
devices that can open the user's personal data — that also shows the declined
ones with an *allow after all* action. It removes the entry, which returns the
device to pending, and the ordinary dialog then handles the fingerprint
comparison and the wrap. One code path, no second approval flow, and it makes
the state inspectable instead of hiding it in a modal the user already
dismissed.

Declining does **not** remove the device from the grant; that stays an admin
action on the sync plane. It only refuses to extend read access.

**Never auto-approve** on the basis of an admin signature, a join response, or a
matching username. The attack this prevents is precise: the admin generates a
keypair, appends it to Alice's grant, and waits for an honest client to wrap for
it. A single client that wraps without asking destroys admin-blindness for all
of Alice's data.

The deterrent is stronger than the dialog alone. A planted device requires an
admin-signed change to the grant, which lands as an entry in the append-only
directory and stays attributable forever. There is no quiet path: the admin has
to leave permanent evidence *and* get a human to approve.

| Approval strength | Mechanism | Stops a silently planted device? |
|---|---|---|
| L1 (required) | Approve / decline dialog on an enrolled device at Haven start | Yes, if the user actually reads it |
| L2 (recommended) | Matching short fingerprints on both devices | Yes, and blind-tap phishing gets harder |
| L3 (optional) | Pairing wizard started on a device that already holds the key, which approves the new device in the same flow and makes the dialog rare | Yes, classic pairing |

### 6.3 Rotation when a device loses the grant

Removing a wrap takes nothing away from the device it belonged to. That device
already unwrapped the private key and holds it locally; the wrap in the document
was only the delivery mechanism. Wrap removal is hygiene. **Revocation is
rotation.**

The trigger is loss of trust, not any grant change. A device retired benignly —
sold, replaced, decommissioned — only loses its wraps; there is nothing to cut
off, and rotating would pay the §8 fanout for no gain. Rotation is for a device
marked for wipe, marked stolen, or otherwise no longer trusted. Then:

1. Generate a new keypair and add it to `userKeys` under `epoch + 1`, wrapped
   for the devices that still have access.
2. Set `retiredAt` on the previous generation and remove the departing device's
   wrap from every generation.
3. **Keep the retired generation and its remaining wraps.** The other devices
   must still open everything that was sealed to the old public key; dropping it
   would lock the user out of their own history.
4. New content is sealed to the new public key. Named-key distributions listing
   this user are re-wrapped to it (§8).

Old ciphertext stays readable by the removed device — the honest limit that no
key management can remove. Rotation is a forward-looking cutoff, and the UI must
say so rather than implying the stolen laptop forgets anything.

**Documents that device could already read are deliberately left alone.**
Re-sealing them would mean rewriting each one as its author with the current
device list, which only the author can do and which touches every document the
user ever had access to. It is not worth it, because the operative control
against a removed device is the sync plane, not cryptography: the tenant blocks
its access and a remote wipe can be issued (`revokedUserKeyPairs`,
`wipeRequestedForSigningKeys`, `src/core/accesscontrol/grantKeys.ts`).

Because rotation has fanout into named-key distributions, it is offered as a
deliberate action with an explanation rather than performed silently on every
grant change.

### 6.4 Authenticity: why a forged document is harmless

There is no admin signature on the key document, so validity is established by
binding to the grant. A `userkey` document is valid for user `U` if and only if:

1. Its `createdByPublicKey` (and the signer of the change being evaluated)
   appears in an **active** `userKeyPairs` entry of a `grantaccess` document
   for `U`; and
2. its `username_hash` matches one of `U`'s hash candidates
   (`usernameHashCandidates`, `src/core/BaseMindooTenantDirectory.ts:4189`); and
3. the §5.3 invariants hold.

Anyone may *create* a document in `userdirectory` claiming Alice's
`username_hash`, or occupy her canonical id — no rule can prevent either (§5.1).
But every client rejects such a document, because the signer is not on Alice's
grant. A forgery is therefore **litter, not a compromise**: it costs storage and
is ignored. And because the canonical id is only a fast path, a squatted id
downgrades lookup to the `username_hash` scan instead of displacing Alice's real
document.

Note what this binding does and does not prove. It proves "some device currently
listed on Alice's grant published this". It does **not** prove the admin did not
insert that device. Confidentiality rests on §6.2 — a human approving a wrap —
not on admin honesty.

### 6.5 Durability: surviving deletion of the published document

The concern is concrete: if any tenant member can delete Alice's key document,
they can either lock her out or force a key regeneration. Four distinct threats,
four distinct answers.

#### The reframing that makes this tractable

**The published document contains no secret that is not already on Alice's
devices.** Every wrap in it can only be opened by a device that already holds
the private key. The document is a *convenience cache* for distribution, not the
master copy. The master copies live in the KeyBag-protected storage of each
approved device.

So deleting the document does not destroy the key and does not force
regeneration. It costs one republish. Republishing is idempotent: same
public key, same fingerprint, same epoch, and therefore **no content
anywhere needs re-encryption**. The user's fallback — "restore it from an old
client state" — is not a disaster-recovery procedure, it is the normal operation
of §4.2 step 3.

Regeneration becomes necessary only if *every* approved device loses the private
key simultaneously. At that point the document's contents would be worthless
anyway, since its wraps target keys nobody holds.

#### Threat 1 — Deletion by a tenant member

A delete in MindooDB is a **tombstone entry**, not an erasure. The lifecycle
entry only bumps `_lastModified`; the body and all prior entries remain in the
append-only store (`src/core/BaseMindooDB.ts:8214`). A deleted document is
recovered with `doc_undelete` (`src/core/BaseMindooDB.ts:8416`), and
`createDocument` on a tombstone resurrects instead of creating
(`src/core/BaseMindooDB.ts:4968`). Even in the worst case, the key material is
still there.

Beyond that, deletion is blocked by a **builtin write invariant** for
`userdirectory` (`src/core/builtinDbInvariants.ts`), independent of
`acl_defaultpolicy` and of the access-control master switch. The invariant is a
floor that a configured policy may tighten but never loosen:

- **Create:** the tenant admin (from a join request) **or** the person named by
  the document's `username_hash` (the self-publish path for legacy users).
- **Change:** only a device whose grant at the entry's trusted time resolves to
  the `username_hash` **in the document**. That includes the tenant founder,
  who signs with the admin key. The admin may not change anyone else's
  document — otherwise they could swap a planted public key after the fact.
- **Delete:** the tenant admin only.
- **Read:** everyone (`$publicinfos`).

The same check runs on the server in `handlePutEntries` before Tier 1, so a
modified client cannot plant entries. Clients that still receive a hostile
change drop it on load and keep the last valid state.

A configured `acl_dbpolicy_userdirectory` can add further denies (for example
`denyDocCreate` for everyone except the admin), but an `$everyone` allow on
`doc_change` does **not** let a stranger edit Alice's key document.

Rotation never needs a delete either: it adds a generation to the same document
and keeps the previous ones (§6.3).

#### Threat 2 — Overwrite or hijack by a tenant member

The builtin invariant of Threat 1 is the whole of this: only the person named
by `username_hash` may change the document, historically resolved at the
entry's trusted time. `$author` is **not** used here — the check compares the
signer against a field in the document, not against the creator (who is often
the admin). Every device of Alice may edit her document; nobody else may.
The admin key may edit it only when that key is also Alice (the tenant
founder wrapping their own userkey). Enforced on both client write paths and
the server push gate.

This is the mechanism that replaces the doc-id binding earlier drafts of this
document assumed. It is strictly better: it does not depend on id patterns, and
it does not depend on ACL being configured.

#### Threat 3 — Id squatting

The canonical id is derivable from the grant, so a hostile member can occupy it
(§5.1). The fallback lookup is what makes that harmless: Alice publishes under a
generated id instead, and every client finds her document by `username_hash` and
signature validation rather than by id alone. Squatting costs a scan, not a
lockout.

Two consequences worth stating. The admin break-glass rule below is **required**
rather than optional, since clearing an occupied canonical id is the only way
back to the fast path. And the residual cost is litter — a hostile member can
create many invalid `userkey` documents, which clients ignore; quota and abuse
limits are out of scope here.

#### Threat 4 — Admin purge

`purgeDocHistory` genuinely removes every entry of a document
(`src/core/appendonlystores/InMemoryContentAddressedStore.ts:602`), and it is
reachable only through an admin-signed `acl_dochistorypurge_*` request
(`docs/accesscontrol.md` §10). An admin can therefore erase Alice's published
document for real.

This is self-healing, not fatal. On the next unlock, any device that still holds
the private key finds no valid document and republishes the same key at the same
epoch. The purge cost is a sync round-trip. An admin can repeat it to deny
service, but denial of service is already within an admin's power in far simpler
ways, and it never yields read access.

#### What clients must do for this to hold

Durability is a client responsibility, not just a policy one. On every bring-up
and after every `userdirectory` sync, the client compares the published state to
the private key it holds and repairs the difference: republish if missing or
purged, undelete if tombstoned, re-add its own wrap if absent, drop wraps for
devices no longer on the grant. Because all of these are idempotent, this
reconciliation can run unconditionally.

### 6.6 Losing every device

The case the design has to answer honestly: no device holds the private key any
more, so no wrap in the document can be opened by anybody.

**Nothing needs to be deleted.** A replacement device that the admin puts on
Alice's grant may write to the same document — the `$author` rule of §6.5
resolves to the grant/user, not to a device — so it simply adds a new generation
under the next epoch and wraps it for itself. The dead generations stay where
they are as unopenable relics, flagged so the UI can explain the gap rather than
show broken content. Nothing about the document blocks recovery; the lost private
keys do.

**Deleting or purging it would be actively harmful.** The wraps of the dead
generations are exactly what makes an old device backup valuable: restore that
device's identity and its wrap still opens the old user key, and with it the
whole history. A delete is only a tombstone and survivable
(§6.5, Threat 1), but a purge destroys the one artefact that makes recovery
possible. So the admin break-glass rule stays scoped to squatted ids and litter;
it is not the answer here.

**Content sealed to the dead generations stays unreadable until it is
re-written**, which is the honest cost and matches what a lost named key would
cost today. The UI must say "content from before <date> cannot be opened on this
device", not fail silently.

**A separate recovery phrase is redundant, because Haven already has one.** The
paper backup carries the device identity and the KeyBag
(`PaperBackupIdentityEntry.identity` / `keyBagBase64`,
`mindoodb-haven/src/features/backup/lib/paperBackup.ts:20`), encrypted with
PBKDF2-SHA256 at 250k iterations under an answer to a self-chosen question and
printed as erasure-coded QR shards. Restoring it restores a device that already
has a wrap in the key document, so the user key and the full history come back
with it. Adding a user-key-specific recovery code would introduce a second secret
with the same failure mode — one more thing to lose — while the existing backup
already covers the case end to end. The remaining work is to make sure the paper
backup is offered at a moment when the user understands it, and that §7 points at
it when every device is gone.

On passkeys as an alternative: a plain WebAuthn credential only signs challenges,
so it cannot wrap a key at all. The `prf` extension does yield a stable secret
and would make a genuinely nicer recovery anchor than a printed phrase, but where
the passkey syncs through a platform password manager the vendor's account
becomes the recovery anchor — a different trust model, not a worse one, but one
to choose deliberately. PRF is also not universally available, so a fallback is
needed regardless. If this is ever added it should be an *additional* wrap
alongside the paper backup, opt-in and visually distinct from device approval
(§10).

---

## 7. User-visible behaviour

Use **device** language. Never say "user key", "wrap", or "certstore".

| Situation | What the user sees |
|---|---|
| First device (join) | Nothing. The key is created silently during the join flow. |
| Existing user, first Haven with User-Keys | Nothing. After `userdirectory` is pulled and found empty, Haven mints a key, wraps every device already on the grant, and pushes. Other already-enrolled devices import the wrap on their next pull. |
| A new device is waiting for access | Dialog at Haven start: "**Your laptop “Work MacBook” wants access to your personal data.** Your private notes, backups and settings are locked so that only your own devices can open them. If you just set this device up, allow it. If not, someone else is trying to reach your data." Device label from the grant plus a short code to compare. Buttons: *Yes, that's my device* / *Not now* / *Don't ask about this device again*. |
| They choose *Not now* | Dialog closes, nothing is written, the device stays without access and the question returns at the next start. |
| They choose *Don't ask again* | "We won't give that device access to your personal data. It may still sync shared team data your administrator controls. If you did not expect this device, tell your administrator." Written to `rejectedDevices` and synced, so no other device asks either. |
| They change their mind later | The device list shows declined devices with *allow after all*. Choosing it puts the device back in the pending state, so the normal dialog with the code comparison appears. |
| This device is waiting for approval | "This device can't open your personal data yet. Open Haven on your other device — it will ask you to confirm this one." Shown instead of empty-looking databases. Name only what is actually locked (§8): say "your personal data" while shared team data still opens, and widen the wording only once named keys hang off the user key. |
| Device lost or stolen | "Create a new personal key so that device can't open your personal data going forward." Never imply old data on that device disappears. |
| All devices lost | "We'll start a new personal key on this device. Things you saved earlier stay locked until they are saved again — unless you still have a paper backup of one of your old devices, which brings them back." Point at the paper backup import (§6.6). |

The recurring dialog is the safety net against a planted device: an unresolved
device stays visible instead of quietly going away. *Don't ask again* exists so
that repetition never becomes the reason somebody approves. A pairing wizard
started from a device that already holds the key (§6.2, L3) approves the new
device in the same flow and makes the dialog rare.

---

## 8. Named-key distribution should target user keys

The distribution document is already admin-blind for the key bytes (§1.1). What
is wrong is not who can *read* the wraps, but who they are *addressed to*:
`wrapKeyForUserDevices` wraps each key version to **every active device** of
every `pushto` user (`src/core/BaseMindooTenantDirectory.ts:2060`). Two problems
follow, and both are the ones user keys exist to solve:

- An admin who plants a device on Alice's grant is included in the next
  distribution re-wrap and receives the named key **without** Alice's approval
  step. The wrap is produced by an honest key holder who has no way to tell a
  planted device from a real one — the grant is all they can see.
- Every device change forces re-publishing every distribution that lists the
  user, which needs a key holder to re-wrap *and* an admin to sign.

Target design: wrap each key version **once per recipient user**, to their
current public user key.

This also makes the two halves of the document speak the same language.
`pullfrom` is already user-level and explicitly needs no device keys
(`src/core/accesscontrol/types.ts:648`); only `pushto` was per-device. The change
is with the grain of the existing design, not against it.

| Topic | Design |
|---|---|
| Wrap map | `<username_hash>\|<userKeyFingerprint>` → `{ versionFp → wrappedKey }` |
| Coverage invariant | `validateKeyDistribution` currently requires every *device* entry to cover exactly the manifest's versions (`src/core/accesscontrol/types.ts:769`); it becomes per *user* entry |
| API | `wrapKeyForUser(keyId, username)`; fails if the user has no valid key document |
| Device add | `userdirectory` only. No distribution rewrite, no admin involvement. |
| Device revoke | Wrap removal in `userdirectory`; a distribution rewrite only if the user key is rotated (below) |
| Recipients without a key | Cannot be added to `pushto` until they publish one — the admin UI must show this as a pending state, not an error |
| Service accounts, kiosks, bots | Keep device-targeted entries as a supported variant in the same map. A bot has no human to approve an enrolment, so a user-key-only design would lock it out |
| Naming | Every entry carries a display name, person or device alike (below) |
| Admin-blindness | A planted grant device gains nothing without §6.2 approval |

**Name every recipient, uniformly.** A wrap map keyed by hashes and fingerprints
is unreadable in a UI, and it gets worse once device entries sit next to user
entries — "who can read this, and who changed it" should not require looking up a
fingerprint. So both kinds of entry carry a display name: for a person it is the
username, which the document already stores as an encrypted, index-aligned array
(`pushto_users_encrypted`, `src/core/accesscontrol/types.ts:636`); for a device
it is the label, taken from the `userKeyPairs` entry in the grant where the
device is a tenant device (`src/core/types.ts:2642`) and given explicitly where
it is not, as `recipients.md` already does for `{ devicePem, label }`. The same
name is what attribution and audit views should show.

Two constraints come with that. Names are **display only** — hashes and
fingerprints stay authoritative for enforcement, exactly as the existing comment
on `pushto_users_encrypted` says about alignment drift being cosmetic. And a
label is attacker-supplied text: render it, never interpret it, and never let a
name decide access.

**The waiting device should say what to do — and no more than that.** A device
that is on the grant but holds no wrap can detect this itself at startup: the key
document exists, its own fingerprint is not in it. Instead of showing databases
that look empty or broken, it says so directly — "open Haven on your other device
to confirm this one" — which is the exact counterpart of the approval dialog in
§7 and turns a confusing state into a two-step instruction.

How much is actually locked depends on whether this section has shipped, and the
message must be derived from the keys the device holds rather than hard-coded.
Before the change, an unapproved device still reads everything under `default`
and the named keys, because those are wrapped to its own device key; only
user-key-sealed content — personal backups, workspace sync, per-document
recipient lists — waits for approval. Afterwards the named keys hang off the user
key too, so the same device reads almost nothing beyond the directory. That is
not a regression against today, where a brand-new device also cannot read
named-key content until a holder re-wraps every distribution — the wait simply
moves from "an admin and a key holder must act" to "you confirm on your other
device", which is faster whenever another device exists. It is worth deciding
consciously, though, because it makes approval the gate for *all* content rather
than only personal content.

**What rotation costs, and why the timing is favourable.** Rotating a user key
forces every distribution listing that user to be re-wrapped, by a key holder and
signed by an admin. That sounds expensive until you look at when it happens. The
case that forces rotation is a device you no longer trust — and that device
already holds the named key bytes in its KeyBag, so the named key has to be
rotated anyway, independently of user keys. The fanout coincides with work the
compromise created regardless. A device retired benignly needs no rotation at
all: dropping its wrap is enough, because the concern is not that the device
keeps reading (it can) but that it should not follow along into the future, and
`pullfrom` handles the cooperating case. This is why §6.3 offers rotation as a
deliberate action rather than firing it on every grant change.

**One behaviour change to carry into the UI.** Today a grant alone gets a device
into every named key. Afterwards, a device the user has not approved for the user
key syncs ciphertext it cannot open. That is the intended gate, but the affected
device must say *why* its databases look empty and point at the approval dialog
on another device, rather than presenting itself as broken.

There are no production tenants depending on per-device wrap maps, so this can
change in place. No dual-read migration is planned.

---

## 9. Encrypting content for user keys

Payloads stay symmetric; only the DEK is addressed asymmetrically. Storage and
merge rules live in `docs/recipients.md`. This section is the SDK surface Haven
and apps use.

- **Personal data** (backup, workspace sync): DEK wrapped to the owner's
  public user key only (`recipients: []`, `includeSelf` defaults true).
- **Peer share**: DEK wrapped to each recipient's public user key, plus the
  author's own.
- **Groups**: expand membership from `directory`, wrap per member. Membership
  changes are forward-looking — adding a member adds a wrap, removing one
  requires a new DEK.

Because a document's DEK may be renewed over its lifetime, a recipient added
later needs the **whole DEK history** to read the existing history. A key-bundle
indirection keeps the cost additive: encrypt the list of DEK generations under
one AES key, and RSA-wrap only that AES key per recipient. Adding a recipient is
then one wrap; the bundle key rotates when a recipient is **removed**.

### 9.1 `_encryptFor` — queryable recipient intent

Sealed documents (`decryptionKeyId` = `$sealed:<docId>`) store intent on the
Automerge payload:

```ts
_encryptFor: Record<string, {
  kind: "user" | "device" | "group";
  label?: string;
  addedAt: number;
  addedBy: string;
  keyFingerprint?: string;
  viaGroup?: string;
  removedAt?: number;
  removedBy?: string;
}>
```

**Map keys for users are the canonical username**, not a hash:

- Abbreviated Notes names expand the same way as Haven: first segment `cn=`,
  last segment `o=`, middle segments `ou=` (`Alice/HR/Acme` → `cn=Alice/ou=HR/o=Acme`).
- Attribute types uppercased (`CN`, `OU`, `O`).
- Values NFKC-normalized and **lowercased** (case-insensitive).
- The value **must include `O=`** after expand. A bare common name such as
  `alice` is rejected: the tenant id is a random string and is not an
  organization name.
- `Alice/Contoso`, `cn=Alice/o=Contoso`, and `CN=alice/O=contoso` write the
  same key.

`canonicalizeUsername(name)` in `src/core/userid/canonicalUsername.ts` is the
function both the mutators and a view formula should use (or just write the
canonical string). Device entries stay keyed by encryption-key fingerprint.

The wraps themselves are **not** in `_encryptFor`. They sit on store-entry
metadata so they can be read before the payload is decrypted. `_encryptFor` is
intent + a fingerprint pointer; `doc.isEncryptedFor(name)` is true only when
the wrap is also present.

**Virtual views.** `_encryptFor` is a normal payload field, so a view can filter
documents sealed for a person:

```text
_encryptFor["CN=alice/O=contoso"] != null
&& _encryptFor["CN=alice/O=contoso"].removedAt == null
```

Use the canonical key (uppercase types, lowercase values, `O=` from the
username — not the tenant id). Tombstoned recipients keep the key with
`removedAt` set — they must not match.
Callers who cannot decrypt the document cannot see `_encryptFor`; the view
indexes plaintext the current user can already read.

### 9.2 Create with recipients

`CreateOptions.recipients` is mutually exclusive with `decryptionKeyId`. The
author is always included unless `recipientOptions.includeSelf` is `false`.

```ts
const doc = await db.createDocument({
  recipients: ["CN=bob/O=contoso", "cn=Carol/o=Contoso", { group: "hr" }],
  initialValues: { subject: "Q3 review" },
});

doc.isSealed();            // true
doc.getDecryptionKeyId();  // "$sealed:<docId>"
doc.getRecipients();       // author + bob + carol (+ expanded group members)
doc.isEncryptedFor("CN=bob/O=contoso"); // true — case-insensitive, canonical match
doc.isEncryptedFor(["CN=alice/O=contoso", "cn=carol/o=contoso"]);
```

`recipients: []` with default `includeSelf: true` means "just me". Empty *and*
`includeSelf: false` is rejected.

### 9.3 Read the list and test membership

On `MindooDoc`:

| Method | Meaning |
|---|---|
| `isSealed()` | Document uses `$sealed:<docId>` instead of a named KeyBag key. |
| `getRecipients()` | Active intent list (`ResolvedRecipient[]`), including `sealed` (wrap present or not). |
| `getRecipientEpoch()` | Current recipient-set generation. |
| `isEncryptedFor(users)` | Every listed user has an **active** `_encryptFor` entry **and** a DEK wrap. Accepts a string or an array. Names are canonicalized and must include `O=` (a bare name throws). Returns `false` if the document is not sealed or any listed user is missing. |

```ts
if (doc.isEncryptedFor(["CN=alice/O=contoso", "cn=bob/o=contoso"])) {
  // DEK is wrapped to both people
}
```

`isEncryptedFor` is the SDK form of the virtual-view predicate. Prefer it in
application code; use `_encryptFor["CN=…"]` in view formulas that cannot call
methods.

### 9.4 Add, remove, and replace

On `MindooDB`. All four write `_encryptFor` (managed field — not via
`changeDoc` / `initialValues`) and attach wraps on the store entry.

```ts
await db.addRecipients(doc, ["CN=dave/O=contoso", "CN=Eve/O=contoso"]);
// Cheap: one wrap each. Dave and Eve can read the whole history.

const removed = await db.removeRecipients(doc, ["CN=bob/O=contoso"]);
removed.rotated; // true — new DEK generation; Bob cannot read later changes

await db.setRecipients(doc, ["carol"]); // diffs: add carol, remove everyone else except author

await db.refreshRecipients(doc); // re-expand group specs against current membership

await db.canChangeRecipients(doc, ["alice", "bob"]); // ACL dry-run
```

| Method | Cost | History |
|---|---|---|
| `addRecipients` | One RSA wrap per new reader. No rotation. | New reader decrypts the **entire** past. |
| `removeRecipients` | New document-key generation; wrap remaining readers. | Removed reader keeps what they already have; cannot read later writes. |
| `setRecipients` | Add and/or remove as needed. Author stays unless `includeSelf: false`. | As above per side of the diff. |
| `refreshRecipients` | Diff against current group membership. | Rotates only if someone left the group. |

Removal is a **forward cutoff**, never retroactive. Do not present it as
"revoke access" to already-synced plaintext.

Sharing requires holding the current document key (you can already read) **and**
passing `doc_change`. A read-only recipient cannot re-share.

Internals, Automerge merge, and the metadata wrap block: `docs/recipients.md`.

---

## 10. Threat model

**Defended**

- The admin and the sync server cannot read content sealed to user keys, as long
  as clients never auto-wrap to grant-only devices (§6.2).
- A planted grant device obtains neither the user private key nor named keys
  addressed to the user key, absent human approval on an enrolled device.
- Senders learn only published public keys.
- Device churn after approval invalidates no ciphertext and rewrites no
  distribution.
- Forged key documents are rejected by grant binding (§6.4), and squatting the
  canonical id costs a scan rather than access (§5.1).
- Deleting or purging a key document does not force regeneration and does not
  cause re-encryption (§6.5).
- Planting a device is never quiet. It requires an admin-signed grant change,
  which stays in the append-only directory permanently and is attributable, and
  it still needs a human to approve the wrap.

**Limits**

- A device that already held the private key keeps it after revocation, and can
  read the content it could already read forever. Rotation only cuts off future
  generations, and existing documents are deliberately not re-sealed (§6.3);
  blocking that device relies on the sync plane and remote wipe.
- A user who taps *Yes, that's my device* without comparing the code can still
  authorize a planted device. Once §8 lands, that single approval hands over
  every named key the user holds at once, instead of only those re-wrapped after
  the planting. Same class of failure, faster and wider.
- First-device TOFU: a chain rooted in a planted device is born compromised.
- The policy plane stays admin-trusted. An admin can still add themselves to
  `pushto` or edit groups. User-key addressing stops **device planting**, not
  malicious policy.
- An approved device can always export the private key. This is a UX-level
  exfiltration path, not a protocol flaw.
- An admin can repeatedly purge the key document as denial of service.
- `$publicinfos` encryption (§4.3) means the sync server, not just members,
  reads the public keys and sees which device fingerprints hold a wrap. Recipient
  wraps leak addressing metadata even when content stays sealed.
- No admin recovery. v1 deliberately does not wrap user private keys to the admin
  or a recovery quorum. If that is ever added it must be opt-in and visually
  distinct from device approval, so "approve my phone" is never confused with
  "give IT a copy".

---

## 11. Rollout

1. `userdirectory` auto-sync in hosts; an empty database is fine.
2. Builtin write invariant for `userdirectory` (`src/core/builtinDbInvariants.ts`),
   independent of `acl_defaultpolicy`. A configured policy may tighten it.
3. SDK: create and publish during the join flow at `userkey_<grantDocId>`;
   lookup via canonical id with `username_hash` fallback and §6.4 validation;
   the reconciliation loop of §6.2.
4. SDK: pending-device detection off the grant diff, approve / decline / don't
   ask again. Missing-document mint wraps every current grant device; devices
   added later are never silent wraps.
5. Haven: pull `directory` then `userdirectory` before reconcile, push after a
   mint or wrap write; approval dialog of §7; device list that can undo a
   refusal.
6. Rotation on grant removal, keeping retired generations readable (§6.3).
7. Switch key distribution to per-user wraps, with display names on every
   recipient entry and the waiting-device notice (§8).
8. First consumer: personal workspace or backup sealed to the owner's user key.
9. Peer share, then group expansion.
10. Update `docs/accesscontrol.md` §13 to reference user-key addressing; policy
    semantics stay as they are.

---

## 12. Open questions

1. **Deterministic fork resolution** — is `(highest epoch, lowest fingerprint)` the
   right winner rule, and how do clients converge the losing document's wraps?
2. **Multi-grant users** — several `grantaccess` documents union device keys
   (`docs/accesscontrol.md` §8.1). Is the union authoritative for pending-device
   detection, or should each grant be evaluated separately?
3. **Who re-wraps named-key distributions** after rotation: any key holder, a
   job, or a required admin republish?
4. **Bootstrap** — `default` arrives via the join flow before a user key
   exists. Does that stay a share-password path forever, or is it re-sealed to
   the user key after first publish? (§4.3 keeps `$publicinfos` usable either
   way.)
5. **Publish validation** — should `publishKeyDistribution` refuse a `pushto`
   user who has no valid key document yet?
6. **Paper backup at the right moment** — §6.6 makes Haven's existing paper
   backup the recovery path, so should creating one be part of the join flow,
   nagged later, or left entirely to the user?
7. **Litter control** in `userdirectory` — quota, or admin cleanup via the
   break-glass rule?
8. **Pairing strength for v1** — is the QR/SAS wizard in scope immediately, or
   does the L1 dialog ship first?
9. **Squatted canonical id** — should a client that had to publish under a
   generated id retry the canonical one after an admin cleanup, or keep the
   generated id for good?
10. **PRF-based recovery anchor** — is a `prf`-capable passkey worth offering as
   an additional wrap next to the paper backup (§6.6), given that it moves the
   anchor to a platform account and needs a fallback where PRF is missing?

---

## 13. Summary

- A user key is a person-level RSA keypair. It makes "encrypt for Alice" a
  stable operation that survives her buying and losing devices, which is what
  personal backups, own-device workspace sync, and per-document recipient lists
  all need.
- It is created silently by the user's client: during join, or on first Haven
  launch for an existing member after `userdirectory` is pulled and found empty
  (then wrapping every device already on the grant and pushing). Never by the
  admin.
- Additional devices added to the grant after that document exists receive the
  key only through explicit human approval on a device that already holds it.
  The grant authorizes sync, never key access — except the one-time wrap of the
  grant snapshot at mint time.
- Sealed documents store queryable recipient intent in `_encryptFor`, keyed by
  canonical username (`CN=alice/O=contoso`, case-insensitive; `O=` from the
  username). Apps use
  `isEncryptedFor` / `addRecipients` / `removeRecipients`; virtual views filter
  on `_encryptFor["CN=…"]`.
- The published document is a cache, not the master. Deleting it costs one
  idempotent republish and re-encrypts nothing; only simultaneous loss of every
  device is fatal.
- Deletion is blocked by `denyDocDelete: true` on the database policy and
  hijacking by baseline `denyDocChange: true` plus an `$author` allow rule — both
  Tier‑1 and server-enforced. Squatting the canonical `userkey_<grantDocId>` is
  survivable rather than blocked: lookup falls back to a `username_hash` scan
  with signature validation.
- Every generation of the key is kept, in a map keyed by epoch, so a revoked
  device can be dropped from the wraps without locking the remaining devices out
  of older content.
- Lost device means rotating the key, not dropping a wrap. Old ciphertext on that
  device stays readable, existing documents are not re-sealed, and the sync plane
  does the actual blocking. The UI must say so.
