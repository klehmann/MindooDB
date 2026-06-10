# MindooDB Access Control Layer

This document describes how fine-grained, document-level access control works in
MindooDB.

## 1. Goals and non-goals

MindooDB already restricts **read** access cryptographically: a document can only
be read by someone who holds the encryption key it was encrypted with (`default`
or a named key). That is strong but coarse — anyone who can read a database can
also create, change and delete documents in it.

The access control layer adds fine-grained control over **write** operations
(`doc_create`, `doc_change`, `doc_delete`, `doc_undelete`, `doc_snapshot`,
`doc_purge`) on top of the existing encryption model.

**Goals**

- Restrict which users (or groups) may create, change, delete, snapshot or purge
  documents, optionally scoped to a database and to the document's content.
- Enforce those restrictions even though users work **offline** and **cannot be
  trusted to report an honest `createdAt`** on their store entries.
- Make decisions **auditable and reproducible for any point in time** ("was user
  X allowed to change this document when the change actually entered the tenant?").
- Stay opt-in: existing tenants behave exactly as before until an admin enables
  access control.

**Non-goals (v1)**

- This layer does **not** add cryptographic read enforcement beyond the existing
  encryption keys. If a user can decrypt a document, they can read it.
- It does **not** prevent a fully malicious, tampered client from *locally*
  authoring an entry. It prevents that entry from being **accepted into the
  tenant** (see the two-tier model below).
- It does **not** introduce multi-key-per-user identities. That is sketched as
  future work in section 13 and partially enabled by the join-request key-rollover
  flow.

## 2. The two-tier model (the core idea)

The central design decision is to split every rule into one of two tiers, based on
**what the sync server can see**. The server only ever sees ciphertext plus a small
set of cleartext/`$publicinfos`-encrypted metadata fields; it can never read
document bodies.

| Tier | Checks | Enforced by | Strength |
|------|--------|-------------|----------|
| **Tier 1 — Identity rules** | Author identity, target database, operation type | **Server _and_ clients** | Cryptographically enforced: the server refuses to witness a violating entry, so it cannot propagate |
| **Tier 2 — Content rules** | The actual document content (`withfields`) | **Clients only** | Policy-enforced: gates honest clients and shapes UX; a tampered client could bypass it |

A rule is **Tier 2 if and only if it has a `withfields` clause**. Everything else
is Tier 1.

This split is the whole architecture. It lets us make a clear, honest promise:

> MindooDB cryptographically enforces **who may write what kind of entry, and
> where**. It enforces **what the content must look like** by policy among
> cooperating clients.

Giving the server the ability to enforce Tier 2 would require handing it the tenant
encryption key, which would break MindooDB's zero-trust-server promise. We
deliberately do not do that.

## 3. Trust chain

```
Admin Ed25519 key                                   ← root of trust (already exists)
   │ signs
   ▼
Directory entries: default policy, DB policies,      ← admin-signed, synced to everyone
   rules, groups, grants, trusted-witness list
   │ defines
   ▼
Trusted witness keys (your sync servers)             ← added on first publish, or manually
   │ each push, the witness signs a receipt
   ▼
Witness receipt on every entry from elsewhere        ← new StoreEntry fields (section 5)
   │ proves
   ▼
"This entry was accepted at receivedAt and
 satisfied Tier 1 at that moment"                    ← other replicas trust this attestation
```

The admin signing key is the existing root of trust. The only new cryptographic
primitive is the **witness receipt**: an attestation, signed by a trusted witness
(the sync server), that an entry was accepted at a specific time. Everything else
is rule data stored in the directory database that all participants already sync.

## 4. Lifecycle: three scenarios

The hardest part of the design is "which clock do we trust?". The answer falls out
naturally once each enforcement point uses exactly one well-defined clock.

### Scenario A — A user writes locally (online or offline)

The SDK evaluates **Tier 1 + Tier 2** against the user's local directory state at
the **current local time**. If allowed, the entry is created and stored locally
with **no witness fields** (`receivedAt` is absent). The change is visible
immediately on this device.

A user's own clock governs their own local view. That is acceptable: a local-only
entry has not entered the shared tenant yet.

### Scenario B — The user pushes to a server

The server evaluates **Tier 1** against **its own directory state at server time**:

- **Allowed:** the server stamps `receivedAt = serverTime`,
  `receivedByPublicKey = serverSigningKey`, computes `receivedDateSignature`, stores
  the entry, **and returns the witness fields in the sync response** so they flow
  back to the sender and onward to any other servers the user syncs with.
- **Denied:** the server returns a structured `AccessDenied` (rule id, op, dbid,
  reason). The entry stays in the user's local store but **cannot propagate**.

This is the key answer to the offline-clock problem: a user who has lost a right
**cannot sync** the offending changes. If they regain the right later, the next push
succeeds and the entry is witnessed with the (correct, current) `receivedAt` at that
moment.

### Scenario C — Another user pulls from the server

The receiver verifies `receivedDateSignature` against the **trusted-witness list**
in their directory:

- If the signature is valid, the receiver **trusts that Tier 1 was satisfied at
  `receivedAt`** and, by default, does **not** re-evaluate Tier 1.
- **Optional client-side Tier 1 re-check (defense in depth).** A tenant setting
  `clientSideTier1Recheck` (default off; recommended on for high-security tenants)
  makes the receiver **also** re-evaluate Tier 1 itself, against its own directory
  state **at the entry's trusted time** (`receivedAt`). This bounds the blast radius
  of a compromised or buggy witness that admitted an entry it should have denied.
  Because the re-check is evaluated at `receivedAt` against the directory-state node
  covering that time (section 8), it is deterministic and convergent: every replica
  that has synced the directory past `receivedAt` reaches the same verdict. To avoid
  spurious denials from a not-yet-synced directory, a replica only applies the
  re-check once its directory is known-synced past `receivedAt`; otherwise it defers
  the entry. A re-check failure routes the entry to quarantine, exactly like a Tier 2
  failure.
- The receiver then evaluates **Tier 2** locally, checking each `withfields` clause
  against its `when` state — the current document for **before** clauses, and a clone
  with the incoming change applied for **after** clauses (see section 6.3) — and
  either materializes the change or routes it to a local **quarantine log** (surfaced
  in Haven's audit view) without materializing it.

Trusting the witness for Tier 1 by default — rather than having every replica
re-evaluate it forever — is what keeps the system stable under eventual consistency.
A decision never silently flips from *allow* to *deny* on a replica that already
accepted an entry. The optional re-check above does not change that property: it is
evaluated at the fixed trusted time `receivedAt`, so it converges to one verdict
rather than tracking later policy changes.

### Clock-skew guard (prerequisite for B)

Because the witness clock anchors all later checks, **sync must be refused when the
two parties' clocks disagree by more than a tolerance.**

- `GET /sync/capabilities` advertises `serverTime` (and `supportsAccessControlV1`).
- Before pushing/pulling against an ACL-enabled tenant, the client compares
  `serverTime` to its own clock. If `|serverTime − localTime| > skewToleranceMs`,
  the sync is aborted with a clear "clock out of sync" error.
- `skewToleranceMs` is a tenant setting with a conservative default (suggested:
  120000 ms / 2 minutes).

## 5. Witness receipt

### 5.1 New `StoreEntryMetadata` fields

```ts
interface StoreEntryMetadata {
  // ...existing fields...

  /** Time the entry was accepted into the tenant by a trusted witness (ms epoch,
   *  witness-local time). Set once, by the first witness; never modified afterwards. */
  receivedAt?: number;

  /** Ed25519 public key (PEM) of the witness that accepted the entry. */
  receivedByPublicKey?: string;

  /** Ed25519 signature by the witness over the canonical byte layout in 5.2. */
  receivedDateSignature?: Uint8Array;
}
```

Rules:

- The witness fields are set **once**, by the **first** trusted witness that accepts
  the entry, and are **never modified** on subsequent syncs.
- A witness only stamps an entry whose `createdByPublicKey` **differs from its own**
  (dual-control: the witness does not witness its own authored entries).
- After stamping, the witness returns the fields in the sync response so they
  propagate back to the author and on to other servers the author syncs with.

### 5.2 Canonical signing layout

`receivedDateSignature` is an Ed25519 signature, made with the witness's signing
key, over a **fixed, versioned, length-prefixed** byte layout (not JSON, to avoid
canonicalization ambiguity):

```
version(1 byte = 0x01)
|| len(entryType)          || entryType
|| len(dbid)               || dbid
|| len(contentHash)        || contentHash
|| len(id)                 || id
|| len(docId)              || docId
|| len(decryptionKeyId)    || decryptionKeyId
|| int64BE(createdAt)
|| len(createdByPublicKey) || createdByPublicKey
|| int64BE(receivedAt)
|| len(receivedByPublicKey)|| receivedByPublicKey
```

(`len(x)` = 32-bit big-endian byte length of the UTF-8 / raw bytes of `x`.) The
signature therefore covers **all** of `entryType`, `dbid`, `contentHash`, `id`,
`docId`, `decryptionKeyId`, `createdAt`, `createdByPublicKey`, `receivedAt`,
`receivedByPublicKey`. Changing the layout requires bumping the version byte.

Why the extra fields are bound (they are exactly what Tier 1 depends on):

- **`entryType`** — the operation type (`doc_create` / `doc_change` / `doc_delete` /
  …) is **not encoded in the entry id** (doc entries all share the `<docId>_d_…`
  form), so without binding it a relay could re-label a witnessed `doc_change` as a
  `doc_delete` and keep the receipt valid. Tier 1 rules are keyed by operation type,
  so this must be signed.
- **`dbid`** — the database the witness accepted the entry under (the store context,
  not necessarily a standalone metadata field). Binding it prevents an entry
  witnessed for one database from being presented as belonging to another where the
  author has different rights.
- **`decryptionKeyId`** — prevents tampering with the claimed key id.

As **defense in depth**, a receiver that decrypts the payload to materialize it MUST
re-derive the operation type from the decoded Automerge change and **reject on
mismatch** with the signed `entryType`. This catches relabeling even if a future
layout version were to drop a field.

### 5.3 p2p note (v1 scope)

In server-mediated sync, the server is the witness. In pure p2p with no server,
there is no inherently trusted witness, so a group either (a) runs a small witness
peer whose key the admin signed into the trusted-witness list, or (b) accepts that
Tier 1 is enforced **locally only** between peers. v1 targets server-mediated sync;
richer p2p witnessing is future work.

### 5.4 Receipt-time validation (anti-backdating)

A valid signature proves *who* signed and *what* it covers, but not that the
`receivedAt` value is honest. A compromised witness could backdate `receivedAt` to
slip an entry "before" a policy that would have denied it (or, symmetrically, to
make an entry look newer). Receivers therefore validate `receivedAt`, not just the
signature:

- **Per-witness monotonicity.** For each trusted witness key, `receivedAt` must be
  **non-decreasing** in the order entries are accepted from that witness. A receipt
  whose `receivedAt` is earlier than one already accepted from the same witness is
  rejected (a witness cannot rewind its own clock). Receivers persist the last-seen
  `receivedAt` per witness key for this check.
- **Wall-clock sanity at receive time.** When an entry first arrives, the receiver
  compares `receivedAt` to its own wall clock: **reject far-future** values (beyond
  the clock-skew tolerance) and **flag implausible-past** values for the audit log.
  This is done once, at receive time, so it does not introduce per-query
  non-determinism.
- **Same dependency for policy/directory entries.** Directory and policy entries are
  ordinary store entries whose trusted time is *also* witness-assigned. Policy-history
  integrity therefore rests on the same monotonicity + sanity checks. A backdated
  policy entry is exactly as dangerous as a backdated data entry, and is guarded the
  same way. (A second, independent timestamping witness for the directory database is
  a possible future hardening, but out of scope for v1.)

## 6. Directory schema

All access-control state lives in the admin-only `directory` database and syncs to
every participant. Several documents use **fixed document IDs** so they can be read
by direct lookup without building an index/view.

> **ID constraint.** Custom document IDs must match
> `^[A-Za-z][A-Za-z0-9_]*$` (`CUSTOM_DOC_ID_REGEX` in `types.ts`), because IDs are
> embedded in store-entry IDs and on-disk filenames. All fixed ACL IDs therefore use
> underscores, and any embedded `<dbid>`/`<ruleId>`/`<fingerprint>` must itself be
> made of `[A-Za-z0-9_]`.

| Purpose | Fixed/Pattern ID | Singleton? |
|---------|------------------|------------|
| Default tenant policy | `acl_defaultpolicy` | yes |
| Per-database policy | `acl_dbpolicy_<dbid>` | per DB |
| Trusted witness entry | `acl_trustedwitness_<fingerprint>` | per witness |
| ACL rule | `acl_rule_<ruleId>` | per rule |

> **Encryption choice.** Every field the **server** must evaluate for Tier 1
> (`users_hashes`, `dbid`, `type`, `action`, group `members_hashes`, witness keys,
> the default/DB policies) is encrypted with the **`$publicinfos`** key,
> never the `default` key — so the server can read it without holding the default tenant key.
> `withfields` (Tier 2) is never readable by the server.

> **Key-based read gate.** The server enforces read access from the
> **authenticated device signing key** (carried in the JWT as `deviceSigningKey`),
> not a cleartext username — the challenge username is optional and may be
> omitted entirely. The server resolves the reader's identity by looking up the
> grant document for that signing key and reading its precomputed,
> `$publicinfos`-readable `identity_hashes` bundle (the v1+v2 hashes of every DN
> wildcard variant of the name, written at grant time). Wildcard and group read
> rules are then matched purely in hash space (set-intersection against
> `users_hashes` / `members_hashes`), so the server never needs the cleartext
> name. Legacy grants without the bundle (`identity_hashes_v` absent/0) degrade
> to exact `username_hash` matching and are flagged for backfill; saving the user
> in the admin "Manage user" dialog (or any `updateUserGrant`) recomputes and
> stores the current bundle.

### 6.1 Default policy (`acl_defaultpolicy`)

```ts
interface DefaultAccessPolicyDoc {
  form: "accesscontrol";
  type: "defaultpolicy";

  /** Explicit master off switch. When true, ALL access checks AND rules
   *  (including standalone deny rules) are bypassed for the whole tenant.
   *  Defaults to false WHEN THIS DOCUMENT EXISTS (an admin who wrote a policy
   *  wants it enforced). A brand-new tenant has no acl_defaultpolicy document at
   *  all and therefore runs with no checks anyway — see the note below. */
  disableAllAccessChecksAndPolicies?: boolean;

  denyDocCreate: boolean;    // default false
  denyDocChange: boolean;    // default false
  denyDocDelete: boolean;    // default false
  denyDocUndelete: boolean;  // default false
  denyDocSnapshot: boolean;  // default true  (snapshots are admin-only by default)
  denyDocPurge: boolean;     // default true  (purge is admin-only by default)

  /** Optional allowlist of decryptionKeyIds a doc_create may use in this scope.
   *  Absent/empty = unconstrained. Non-empty = a doc_create whose
   *  decryptionKeyId is not in the set is denied (a hard Tier 1 create-key gate
   *  that an allow rule cannot override). See section 6.6. */
  allowedCreateKeyIds?: string[];

  /** Optional default decryptionKeyId a doc_create uses when the caller does
   *  not specify one in this scope (replacing the hardcoded "default" fallback).
   *  This is a client-side convenience, NOT a security control — the server
   *  never selects keys — so allowedCreateKeyIds remains the authoritative gate.
   *  When set together with a non-empty allowedCreateKeyIds on the SAME document
   *  it must be a member of that allowlist (rejected at write time otherwise).
   *  See section 6.6. */
  defaultCreateKeyId?: string;

  /** Governs which databases tenant members may open/sync. TENANT-LEVEL ONLY —
   *  read solely from acl_defaultpolicy, never layered through a per-db policy.
   *  "open" (default) allows any valid database id. "directory-restricted"
   *  allows only "directory" (always implicit) and the ids in allowedDbIds; the
   *  tenant admin is exempt. See section 6.8. */
  databaseCreationPolicy?: "open" | "directory-restricted";

  /** The database ids permitted when databaseCreationPolicy is
   *  "directory-restricted". "directory" is always allowed and need not be
   *  listed; every other id (including "main") must appear explicitly. Ignored
   *  in "open" mode. Tenant-level only. See section 6.8. */
  allowedDbIds?: string[];
}
```

**Two distinct "off" states — do not conflate them:**

- **No `acl_defaultpolicy` document exists** (the state of every brand-new tenant).
  Access control has never been enabled, so there is nothing to evaluate and all
  operations are allowed. This — not a field default — is why a new tenant has no
  checks. The implicit behavior is equivalent to all `deny*` set to `false` for the
  lifecycle operations and `true` for snapshot/purge.
- **The document exists** (an admin has started configuring ACL). Now the document's
  fields govern enforcement, and any omitted field takes its stated default. In
  particular `disableAllAccessChecksAndPolicies` defaults to `false` here, because an
  admin who deliberately wrote a policy expects it to be enforced — defaulting it to
  `true` would silently bypass the very `deny*` flags they just set.

`disableAllAccessChecksAndPolicies` is the explicit master on/off switch for a tenant
that already has a policy. Setting it to `true` short-circuits the entire evaluation
algorithm (section 7), including standalone `deny` rules, which a baseline `deny*`
flip alone would **not** neutralize. Because the switch is just another revision of
the append-only `acl_defaultpolicy` document, the exact disabled window — and
therefore every entry whose trusted time falls inside it — stays fully auditable
through directory history and time travel.

### 6.2 Per-database policy (`acl_dbpolicy_<dbid>`)

Same shape as the default policy but scoped to one database. Layering order during
evaluation (section 7): tenant default → DB default → matching allow rules →
matching deny rules. Exception: `databaseCreationPolicy` / `allowedDbIds` are
tenant-level only and are ignored if set on a per-database policy (see section 6.8).

### 6.3 ACL rule (`acl_rule_<ruleId>`)

```ts
type RuleType =
  | "doc_create" | "doc_change" | "doc_delete"
  | "doc_undelete" | "doc_snapshot" | "doc_purge";

type Operator =
  | "equals" | "notEquals"
  | "contains" | "containsAny" | "containsAll"
  | "exists" | "notExists"
  | "gt" | "gte" | "lt" | "lte";

/** Placeholders are resolved at evaluation time against the acting user.
 *  NOTE: there is deliberately NO "${now}" / wall-clock placeholder. ACL
 *  evaluation must be a pure, deterministic function of the entry plus directory
 *  state (see section 10); a wall-clock value would make replicas disagree. If a
 *  rule ever needs a notion of "current time", it must bind to the entry's trusted
 *  time (receivedAt) — richer time operators are deferred to future work. */
type Placeholder =
  | "${user.username}"   // acting user's canonical username
  | "${user.usernames}"  // canonical + name variants + groups (+ nested groups)
  | "${user.groups}";    // groups only

interface WithFieldClause {
  key: string;                                   // dot-path inside the document
  op: Operator;
  value: string | number | boolean | string[] | Placeholder;

  /** Which document state the clause is evaluated against:
   *  - "before": the document as it currently exists, before the candidate change
   *              (authorization — "you must ALREADY satisfy this to change/delete").
   *  - "after":  the document with the candidate change applied
   *              (result constraint — "the creator must add themselves").
   *  Defaults are op-appropriate (see withfields semantics below):
   *  doc_create => "after" (no before state exists);
   *  doc_change / doc_delete / doc_undelete => "before". */
  when?: "before" | "after";
}

interface AclRuleDoc {
  form: "accesscontrol";
  type: RuleType;
  ruleId: string;                 // stable; surfaced in AccessDecision.matchedRuleId
  description?: string;
  dbid: string | "*";             // "*" = all databases in the tenant
  withfields?: WithFieldClause[]; // presence makes the rule Tier 2 (client-only)
  users_hashes: string[];         // user + group hashes, plus reserved pseudo-tokens
  users_encrypted: string;        // usernames encrypted with $publicinfos
  action: "allow" | "deny";
}
```

**Reserved pseudo-tokens** (stored literally in `users_hashes`, they are not
secret): `$everyone` (all registered users), `$admin` (admin only), `$author` (the
original creator of the document being modified).

**`$author` — ownership rules.** `$author` is only meaningful on `doc_change`,
`doc_delete` and `doc_undelete` rules. It expresses the ownership model "only the
user who created a document may modify or delete it" (personal notes, comment
threads, drafts). It is **Tier 1 (server-enforceable)** and needs no extra
encrypted metadata, because the server resolves it from data it already has:

1. The document's `doc_create` entry carries the creator's `createdByPublicKey`
   (plaintext metadata).
2. The incoming change carries the signer's `createdByPublicKey`.
3. Grant documents (in `$publicinfos`) map both keys to a `username_hash`,
   including key arrays after rollover.

`$author` matches when the creator key and the signer key resolve to the **same
grant/user**. The alternative — storing an `owner` content field and matching it
with `("owner","equals","${user.username}")` — also works but is **Tier 2**
(client-only) and requires the app to maintain the field.

**`withfields` semantics**

- Each clause is evaluated against either the **before** state (the document as it
  currently exists, prior to the change) or the **after** state (the document with
  the candidate change applied), selected by the clause's `when` field.
- **Op-appropriate defaults**, because the two need opposite states:
  - `doc_change` / `doc_delete` / `doc_undelete` default to **before**. Authorization
    must look at the existing document: "only someone already listed in `myeditors`
    may change it". Evaluating *after* would be a security hole — a non-editor could
    add themselves to `myeditors` in the same change and authorize their own edit.
  - `doc_create` defaults to **after** (and cannot use `before`, since the document
    does not exist yet): "the creator must add themselves to `myeditors`".
- Computing each state:
  - **before** = read the current document as it stands (no change applied). During
    materialization this is the reconstructed state at the change's parents.
  - **after** = clone the document and apply the candidate change to the clone, then
    evaluate. (`Automerge.clone()` + `Automerge.loadIncremental()` are already used in
    `BaseMindooDB`, so no live-doc rollback is needed.) A rule may mix clauses with
    different `when` values (e.g. "must already be an editor" before + "must not
    remove yourself" after).
- `("myeditors", "containsAny", "${user.usernames}")` passes when the `myeditors`
  array shares any value with the acting user's resolved usernames list.
- Operators and placeholders are a **closed set**; an unknown operator or
  placeholder is a validation error at rule-creation time. No regex in v1.

### 6.4 Trusted witness (`acl_trustedwitness_<fingerprint>`)

```ts
interface TrustedWitnessDoc {
  form: "accesscontrol";
  type: "trustedwitness";
  witnessPublicKey: string;  // Ed25519 PEM
  serverUrl?: string;
}
```

A witness is added automatically on the **first push of the tenant to a server**
(the publish flow asks the server for its signing key) and can also be added/removed
manually via `MindooTenantDirectory` (section 9). Rotation is "add the new witness
doc, drop the old one".

### 6.5 Grants, groups, and revocation-by-key-removal

User registration and group membership reuse the existing directory documents, with
two refinements.

**Key arrays instead of separate revocation docs.** The grant document holds
**arrays** of the user's public keys:

```ts
// grantaccess document (form "useroperation")
{
  form: "useroperation",
  type: "grantaccess",
  username_hash: string,                 // see hashing note below
  user_details_encrypted: string,        // JSON user details
  user_details_encrypted_key: string,    // key id; defaults to "default"

  // Current form: one object per ACTIVE device, pairing its signing and
  // encryption keys and carrying an optional human-readable label (e.g. a date
  // or a note about the device type). The label is editable by the admin later.
  // This list holds active devices ONLY — a revoked device is moved to the
  // separate `revokedUserKeyPairs` list below — so any reader that treats
  // `userKeyPairs` as "the keys with access" is correct without understanding
  // revocation.
  userKeyPairs: Array<{
    signingPublicKey: string,
    encryptionPublicKey: string,
    label?: string,
  }>,

  // Retained revoked devices: a revoked device is moved here (not deleted) with
  // its `revokedAt` timestamp (trusted-time ms), so admin UIs can list "devices
  // with revoked access" and optionally restore them. Membership in this list —
  // not a per-entry flag — is what marks a device revoked. Revoked pairs are
  // EXCLUDED from `userKeyPairs` and the mirrored active-key arrays below, so the
  // server/auth never treat them as granting access.
  revokedUserKeyPairs?: Array<{
    signingPublicKey: string,
    encryptionPublicKey: string,
    label?: string,
    revokedAt?: number,
  }>,

  // Mirrored legacy forms, kept in sync on every write so that older clients
  // (which predate userKeyPairs) keep working. These mirror only the ACTIVE
  // pairs:
  userSigningPublicKeys: string[],       // mirror of userKeyPairs[].signingPublicKey
  userEncryptionPublicKeys: string[],    // mirror of userKeyPairs[].encryptionPublicKey

  // Precomputed, $publicinfos-readable identity-hash bundle: the v1+v2 hashes of
  // every DN-hierarchy username variant (e.g. for "cn=alice/ou=ceo/o=acme":
  // self, "*/ou=ceo/o=acme", "*/o=acme", "*"), computed from the cleartext name
  // at grant time. Lets the server resolve wildcard/group read rules purely in
  // hash space from the authenticated device key, without ever seeing the
  // cleartext username. `identity_hashes_v` versions the variant-generation
  // algorithm (starts at 1); absent/0 means a legacy grant (exact-match only,
  // flagged for backfill).
  identity_hashes?: string[],
  identity_hashes_v?: number,

  // Remote-wipe directive: signing public keys whose device must delete the whole
  // local tenant (all local DBs incl. the directory DB) on next connect, after it
  // has synced the directory and discovered this directive (stolen device, departed
  // user). Explicit/opt-in: NOT implied by key removal. Self-contained copies of the
  // key values, NOT references into userKeyPairs.
  wipeRequestedForSigningKeys?: string[],
}
```

Because the grant doc is an admin-signed CRDT, the admin **edits `userKeyPairs`**
instead of writing separate revocation documents:

- **Add a key pair** → key rollover or a new device (a returning user can re-run
  the join-request flow with a freshly generated key pair; the admin appends the
  new pair, optionally with a label). This is the v1 answer to per-user key
  rollover.
- **Set/clear a label** → annotate a device (`setKeyPairLabel`), identified by
  its signing public key.
- **Revoke a key pair** → move that device's pair from `userKeyPairs` into
  `revokedUserKeyPairs` with a `revokedAt` timestamp (identified by signing key).
  The pair is **retained** on the grant doc (for the admin "devices with revoked
  access" list) but excluded from the active key arrays, so the server stops
  accepting it.
- **Restore a key pair** → move the pair back from `revokedUserKeyPairs` into
  `userKeyPairs` (dropping its `revokedAt` and any pending wipe flag).
- **Revoke all key pairs** → fully revoke the user (no active pairs remain);
  they can rejoin later with new keys.
- **Batch edit** → `updateUserGrant` applies a whole staged diff in one
  admin-signed change: rewrite user details, recompute `identity_hashes`, set
  per-device labels, revoke/restore devices, and set the remote-wipe set. This
  backs the admin "Manage user" dialog's single Save and is the per-user
  `identity_hashes` backfill trigger.

> **Compatibility.** Active devices are read most-specific first: (1)
> `userKeyPairs`; (2) the parallel `userSigningPublicKeys` /
> `userEncryptionPublicKeys` arrays; (3) the oldest scalar `userSigningPublicKey`
> / `userEncryptionPublicKey`. Revoked devices are read from
> `revokedUserKeyPairs`. A present-but-**empty** higher form is authoritative —
> an empty `userKeyPairs` (and the mirrored empty arrays) is exactly how a grant
> with no active devices is represented, so a leftover lower form must never
> resurrect access. New writes always emit both `userKeyPairs` and
> `revokedUserKeyPairs` and keep the parallel arrays/scalars mirrored (active
> pairs only). The old standalone `revokeaccess` document model has been
> **removed**: revocation is now performed by moving the pair into
> `revokedUserKeyPairs` (with `revokedAt`) on the grant document — the pair is
> retained for admin display but dropped from the active arrays the server reads.

**Remote wipe (`wipeRequestedForSigningKeys`).** To handle a stolen device or a
departed employee, the admin can list **signing public keys** whose device must drop
its local copy of the tenant the next time it connects. The signing key is the right
identifier because it is the per-device identity already present on every store entry
(`createdByPublicKey`) and the key the device presents during sync — the encryption
(RSA-OAEP) key is about decrypting key material, not identity, so it is a poor wipe
target. Targeting by signing key wipes exactly one device and leaves the user's other
devices intact; list several keys to wipe several devices.

The wipe is an **explicit, opt-in directive** — it is deliberately **not** triggered
automatically when a signing key disappears from `userSigningPublicKeys`. Revocation
(removing keys) and wipe (this field) are independent: an admin can revoke without
wiping (e.g. re-provisioning a device) or wipe without revoking, and must set this
field on purpose for any data to be destroyed.

Three properties are essential:

- **Self-contained key values.** The wipe list stores the actual signing public key,
  not a reference into `userSigningPublicKeys`. Revocation removes keys from those
  arrays, so a reference would vanish exactly when it is needed; a copied value
  survives.
- **The directive is delivered without exposing the rest of the directory.** Rather
  than letting a wipe-targeted (and likely revoked) device pull the whole **directory
  database**, the **sync protocol returns only the admin-signed grant document** that
  carries `wipeRequestedForSigningKeys` — and no other directory data. The client
  **verifies the admin signature** on that document (so it knows the directive is
  genuine and was not injected by the server), confirms its **own signing key** is
  listed, and then deletes **all local databases for that tenant, including the
  directory database itself** — removing the entire local tenant from the device.
  (There is no need to wipe data databases selectively; once the directive is read,
  the tenant goes away as a unit.) Because only the signed grant document is served,
  revocation does not leak ongoing directory metadata to the targeted/revoked key.
  Only that tenant is removed; other tenants on the same device (Haven is
  multi-tenant) are untouched.
- **Best-effort.** A device kept permanently offline can never be reached, consistent
  with the revocation trade-offs in the README and the limitations section. The wipe
  is also idempotent: once the local tenant is gone there is nothing left to delete.

**Username hashing (backward compatible).** Today usernames are hashed as unsalted
`SHA-256(lowercase(canonicalUsername))` (hex). Going forward we add a tenant salt:

```
hashV2 = SHA-256(tenantId + "/" + lowercase(canonicalUsername))   // hex
```

Lookups must match against **both** the legacy unsalted hash and `hashV2` so that
pre-existing directory data keeps working; new documents write `hashV2`. Record the
hash version on the document (e.g. `username_hash_v: 1 | 2`) to avoid ambiguity.

### 6.6 Create-key allowlist (`allowedCreateKeyIds`)

A policy may pin which encryption keys new documents are created with. When a
policy's `allowedCreateKeyIds` is non-empty, a `doc_create` is denied unless its
`decryptionKeyId` is in the set. This is a **Tier 1** constraint: `decryptionKeyId`
is cleartext entry metadata the witness already reads (it is covered by the witness
signature, section 5.2), so the server enforces it at push time and every honest
client re-checks it on materialization — no tenant key required, unlike `withfields`
(Tier 2). It is a **hard gate**: it overrides allow rules (a matching allow rule does
not rescue a `doc_create` that uses a disallowed key) but is additive to the normal
baseline/rule check (passing the gate still leaves the usual evaluation to run).

Typical uses:

- **Forbid the shared default key.** Omit `"default"` from the list (the stored id
  for default-key documents is the literal `"default"`, `DEFAULT_TENANT_KEY_ID`), so
  every new document must use a named key with a narrower audience.
- **Enforce key rotation.** Point the allowlist at the current rotation key; when the
  schedule advances, write a new policy revision listing the next key. Manual key
  creation and sharing still works exactly as before — this only constrains which key
  a *new* document may be created under.

**Scope.** Only `doc_create` is gated. `doc_change`/`doc_delete`/… reuse the
document's existing `decryptionKeyId`, so they are unaffected. A per-database policy's
`allowedCreateKeyIds` (when set) fully overrides the tenant default's for that
database — it is not unioned — so a database can both tighten and loosen the
tenant-wide constraint.

**No retroactive invalidation (rotation = policy revision).** Because evaluation runs
against the directory state at each entry's *trusted time* (section 8), a document
created under an earlier policy is judged against that earlier policy forever.
Tightening the allowlist later never reaches back to quarantine valid history; a
document that was compliant when it entered the tenant stays readable and valid. Only
*new* `doc_create` entries see the new constraint. Each rotation is just another
append-only revision of `acl_defaultpolicy` / `acl_dbpolicy_<dbid>`, so the exact
window each key was mandatory stays fully auditable, and
`wasAllowedAt("doc_create", user, dbid, t, { decryptionKeyId })` reproduces the
verdict that applied at `t` — not today's policy.

### 6.7 Default create key (`defaultCreateKeyId`)

A policy may also set a single `defaultCreateKeyId`: the `decryptionKeyId` a
`doc_create` uses when the caller does not pass one. It replaces the historical
hardcoded `"default"` fallback, so `createDocument()` (no key) under a policy
that sets `defaultCreateKeyId: "projkey"` creates the document under `projkey`.

This is a **client-side create-time convenience, not a security control**. The
sync server never selects keys; it only enforces `allowedCreateKeyIds`
(section 6.6). The resolution order at create time is:

1. the caller's explicit `decryptionKeyId`, else
2. the effective policy's `defaultCreateKeyId` for the database, else
3. the literal `"default"`.

**Where to set it (tenant-wide or a single database).** The default key can be
configured at either scope, on the same policy documents as every other field:

- **Tenant-wide** — applies to every database that has no per-db default:

  ```ts
  await directory.setDefaultAccessPolicy(
    { defaultCreateKeyId: "tenantkey" },
    adminPrivateKey, adminPassword,
  );
  ```

- **A single database** — applies only to `dbid`:

  ```ts
  await directory.setDatabaseAccessPolicy(
    "crm",
    { defaultCreateKeyId: "crmkey" },
    adminPrivateKey, adminPassword,
  );
  ```

**Layering.** Like every policy field, a per-database `defaultCreateKeyId` fully
overrides the tenant default's for that database (it is not merged). So a tenant
can set a tenant-wide default and let individual databases opt into their own.

**Must be allowed.** When a policy document sets both `defaultCreateKeyId` and a
non-empty `allowedCreateKeyIds`, the default must be a member of the allowlist —
otherwise the default would be self-denying. This is rejected at write time
(`setDefaultAccessPolicy` / `setDatabaseAccessPolicy`). Because the allowlist and
default can in principle come from different layers (a per-db default over a
tenant allowlist), the client resolver also drops a resolved default that is not
in the effective allowlist, falling back to step 3 so the create-key gate
produces a clear error instead of silently choosing a key the witness rejects.

### 6.8 Directory-restricted database policy (`databaseCreationPolicy` / `allowedDbIds`)

By default any tenant member may open — and therefore implicitly create — a
database with any syntactically valid id, which is convenient for experimentation
but undesirable in a locked-down enterprise tenant. The tenant default policy can
switch this off with two **tenant-level** fields on `acl_defaultpolicy`:

- `databaseCreationPolicy: "open" | "directory-restricted"` — defaults to
  `"open"` (today's behavior).
- `allowedDbIds: string[]` — the databases permitted in restricted mode.

In `"directory-restricted"` mode only the `"directory"` database (always
implicitly allowed, since every participant must sync it to evaluate access
control at all) and the ids listed in `allowedDbIds` may be opened or synced.
Every other id — **including `"main"`** — must be listed explicitly. The tenant
**admin is exempt** and may open/sync any id.

Unlike the create-key gate, these fields are **never** layered through a per-db
`acl_dbpolicy_<dbid>` document (a per-db restriction would be circular — you would
have to be allowed into the database to read its own gate). They are read only
from the tenant `acl_defaultpolicy`, which is `$publicinfos`-encrypted, so the
sync server can evaluate them without the tenant key — no new sync plumbing.

**Enforcement points (defense in depth):**

1. **Client open path** — `MindooTenant.openDB` (via
   `assertCurrentUserCanOpenDB`) rejects opening a non-allowed database for a
   granted, non-admin user. Reading the policy opens `"directory"`, which is
   short-circuited before the check, so there is no recursion.
2. **Server sync choke point** — every authenticated sync operation (reads and
   writes) passes through `ServerNetworkContentAddressedStore`; a non-allowed
   database is rejected with `NetworkError(ACCESS_DENIED)`. Admin bypass is
   resolved from the request principal's device signing key against the
   administration key. The `"directory"` store is never gated.
3. **Haven UI** — the open/add dialogs render a strict dropdown of `allowedDbIds`
   in restricted mode instead of free-text input.

**Validation & history.** `setDefaultAccessPolicy` validates the enum and that
every `allowedDbIds` entry is a valid database id. Like every policy field, the
restriction is just another append-only revision of `acl_defaultpolicy`, so
tightening or relaxing the allowlist is fully auditable through directory history.

**Backward compatibility.** Tenants with no `acl_defaultpolicy`, or whose policy
omits these fields, behave exactly as before (`"open"`). Local "play" tenants
created by users carry no restrictive policy, so they remain the intended escape
hatch for ad-hoc data.

**Out of scope.** Server-to-server `ServerSync` uses `getStore` and bypasses the
network-store layer, so it is not gated by this policy (noted as a follow-up).

## 7. Evaluation algorithm

For an operation `op` on database `dbid` by user `U`, evaluated at time `T`:

0. **Master switch.** If the effective default policy at `T` has
   `disableAllAccessChecksAndPolicies === true`, return **allowed** immediately
   (`tier: "tier1"`) without evaluating the baseline or any rules. This is what makes
   a true disable safe: a baseline `deny*` flip alone would not neutralize standalone
   `deny` rules, but the master switch bypasses them too.
1. **Resolve the directory state at `T`** (section 8) — default policy, DB policy,
   rules, groups, grants as they were at `T`.
1b. **Create-key gate (Tier 1).** If `op === "doc_create"` and the effective policy's
   `allowedCreateKeyIds` is non-empty, the entry's `decryptionKeyId` must be in that
   set; otherwise return **denied** immediately (`tier: "tier1"`). This is a hard gate
   that an allow rule cannot override (section 6.6). It runs identically on server and
   client because it depends only on cleartext metadata.
2. **Baseline** = the effective `deny<Op>` from the DB policy if present, else the
   tenant default policy. `deny = true` means "denied unless an allow rule matches".
3. **Resolve `U`'s identity set**: `username_hash` (legacy + v2), all group hashes
   (including nested groups), plus applicable pseudo-tokens (`$everyone`, and
   `$admin`/`$author` when they apply).
4. **Collect matching rules** of type `op` whose `dbid` is `dbid` or `"*"` and whose
   `users_hashes` intersect `U`'s identity set. For Tier 2 rules, also require all
   `withfields` clauses to pass, each evaluated against the document state selected by
   its `when` (the **before** state for `doc_change`/`doc_delete`/`doc_undelete` by
   default; the **after** state for `doc_create`).
5. **Decide with deny-overrides-allow** (set-based, order-independent):
   - if any matching **deny** rule → **denied**;
   - else if any matching **allow** rule → **allowed**;
   - else → the **baseline** decides.

Deny-overrides-allow is a single, well-known security model and needs no rule
ordering, which matters because rule documents merge across replicas via Automerge.

**Return type** (used by the SDK, server, and Haven UI):

```ts
interface AccessDecision {
  allowed: boolean;
  reason: string;            // human-readable
  matchedRuleId?: string;    // set for the rule that decided
  tier: "tier1" | "tier2";
}
```

Servers can only reach a Tier 1 decision; if the only thing standing between
allow/deny is a Tier 2 rule, the server treats the entry as Tier 1-allowed and
leaves the Tier 2 check to clients.

## 8. Time-travel directory state

To answer "what was allowed at time `T`?" quickly — including while materializing a
database from scratch — we keep an in-memory, copy-on-write chain of directory
snapshots keyed by the **trusted time** of directory changes.

```ts
interface DirectoryStateNode {
  /** Covers all directory entries whose trusted time ≤ this bound. */
  trustedTimeUpperBound: number;

  defaultPolicy: DefaultAccessPolicyDoc | null;
  dbPolicies: Map<string, DefaultAccessPolicyDoc>;
  rulesByType: Map<RuleType, AclRuleDoc[]>;
  groupsByName: Map<string, GroupDoc>;
  usersByHash: Map<string, UserGrant>;     // includes key arrays
  trustedWitnessKeys: Set<string>;

  prev: DirectoryStateNode | null;         // unchanged lists point back to prev
}
```

- **Trusted time of an entry** = its `receivedAt` if set, otherwise its `createdAt`
  (a local, not-yet-synced entry). This single definition is reused everywhere.
- The chain is built incrementally from `iterateChangesSince(cursor)`; the cursor and
  the latest node are serialized to disk between sessions and only the delta is
  replayed on startup.
- Memory stays compact because unchanged lists are shared by pointer with `prev`.
- `doc_snapshot` entries are treated as trusted checkpoints during materialization
  (see snapshot rule in section 10), so replay does not have to revisit full history.

This structure answers audit questions directly:

- *Has user X ever had write access to this document?* — walk the chain.
- *How did a user's access level change over time?* — diff successive nodes.

### 8.1 Reimplementing `BaseMindooTenantDirectory` on the unified chain

The existing `BaseMindooTenantDirectory` keeps several **flat, latest-state-only**
caches that are **rebuilt from scratch on every write** and held **only in memory**.
The `DirectoryStateNode` chain above is intended to **subsume all of them**: instead
of a handful of ad-hoc maps plus a single rewind-to-zero cursor, there is one
incrementally-built, copy-on-write chain that additionally gives us time travel and
on-disk persistence. The current per-type caches then become simple **reads over the
head node** (the node covering "now"), and historic checks (sections 7 and 11) read
an **earlier node** instead.

**Cache → chain-derived view.** Each structure in `BaseMindooTenantDirectory` maps
onto the unified chain as follows:

- `trustedKeysCache` (key → active bool) → derived from the head node's `usersByHash`
  (the per-user signing-key arrays). "Trusted" means the key appears in a non-revoked
  grant. The admin key and `getAdditionalTrustedKeys()` stay special-cased and are
  checked first, exactly as today.
- `grantDocIdToSigningKeys` (grant doc id → its current signing keys) → the source
  of truth from which `trustedKeysCache` is rebuilt as the union of all grants'
  current keys. Revocation is **key removal from the grant arrays** (section 6.5);
  the legacy standalone `revokeaccess` document model has been removed.
- `userLookupCache` (signing key → `DirectoryUserLookup`) → the head node's
  `usersByHash` plus a reverse `bySigningKey` index built alongside it.
- `groupsCache` → the node's `groupsByName`, preserving today's offline-merge of
  same-named group docs and case-insensitive name normalization.
- `tenantSettingsCache` / `dbSettingsCache` → folded into the **same single-pass chain
  builder**; they already ride the same `iterateChangesSince` loop that the current
  `updateUnifiedCache` uses, so they cost nothing extra to carry on the node.
- `unifiedCacheLastCursor` → the chain's **persisted cursor**. The key behavioral
  change: writes stop resetting the cursor to `null` (which today forces a full
  rebuild on the next read) and instead **append a new node incrementally**.

**Public methods become thin reads over the head node.** With the chain in place, the
current API surface keeps the same behavior but is implemented as lookups against the
head node:

- `validatePublicSigningKey`, `getUserPublicKeys`, `getUserBySigningPublicKey`,
  `isUserRevoked`, `findGrantAccessDocuments` → head-node `usersByHash` / reverse
  index.
- `getGroups`, `getGroupMembers`, `getUserNamesList`, `resolveGroupsForUser` →
  head-node `groupsByName`.
- `getTenantSettings` / `getDBSettings` / `changeTenantSettings` / `changeDBSettings`
  → node-held settings.
- **New capability:** time-travel variants of these lookups — evaluating against the
  node that covers an arbitrary `T` rather than the head — are what the evaluation
  algorithm (section 7) and the audit query `wasAllowedAt` (section 9) consume.

**Prerequisites.** A full migration is partly blocked on work that does not exist yet,
so it is staged:

- Witness-receipt fields `receivedAt` / `receivedByPublicKey` / `receivedDateSignature`
  on `StoreEntryMetadata` (section 5) supply the **trusted time** used to order nodes.
  Until they land, the chain falls back to `createdAt` / current iteration order, so
  the structure can be introduced **before** witness receipts exist (with no
  time-travel guarantees yet).
- The ACL rule/policy/witness document types (sections 6.1–6.4) are needed to populate
  `defaultPolicy`, `dbPolicies`, `rulesByType`, and `trustedWitnessKeys`. Before they
  exist those node fields are simply empty.
- Grant key arrays and the salted `hashV2` (section 6.5).
- A serialized on-disk format for the persisted chain node plus its cursor.

**Compatibility invariants to preserve.** The rewrite must keep today's observable
behavior:

- the admin key is always trusted, and `getAdditionalTrustedKeys()` is honored first;
- legacy scalar `userSigningPublicKey` / `userEncryptionPublicKey` fields are still
  read, but only when no key array is present (an empty array means fully revoked);
- group documents with the same name are merged across offline edits;
- group names are case-insensitive (normalized to lowercase);
- username wildcard variants (`generateUsernameVariants`, e.g. `*/o=org`) continue to
  participate in group/rule matching.

## 9. Public API (`MindooTenantDirectory`)

All mutating calls are admin-signed.

```ts
// Enable / configure / disable (no separate enable/disable call needed)
setDefaultAccessPolicy(policy: Partial<DefaultAccessPolicyDoc>,
                       adminKey: EncryptedPrivateKey, adminPassword: string): Promise<void>;
setDbAccessPolicy(dbid: string, policy: Partial<DefaultAccessPolicyDoc>,
                  adminKey, adminPassword): Promise<void>;

// Rules
createRule(rule: Omit<AclRuleDoc, "form">, adminKey, adminPassword): Promise<string /*ruleId*/>;
deleteRule(ruleId: string, adminKey, adminPassword): Promise<void>;
listRules(filter?: { type?: RuleType; dbid?: string }): Promise<AclRuleDoc[]>;

// Trusted witnesses
addTrustedWitness(witness: Omit<TrustedWitnessDoc, "form" | "type">,
                  adminKey, adminPassword): Promise<void>;
removeTrustedWitness(fingerprint: string, adminKey, adminPassword): Promise<void>;

// Grants (key arrays)
addUserKeys(username: string, signingKeys: string[], encryptionKeys: string[],
            adminKey, adminPassword): Promise<void>;
removeUserKeys(username: string, signingKeys: string[], encryptionKeys: string[],
               adminKey, adminPassword): Promise<void>;

// Remote wipe: target devices by signing public key; cancel clears the directive.
requestDeviceWipe(username: string, signingKeys: string[],
                  adminKey, adminPassword): Promise<void>;
cancelDeviceWipe(username: string, signingKeys: string[],
                 adminKey, adminPassword): Promise<void>;

// Prediction for UIs (no mutation)
canDo(op: RuleType, dbid: string, candidateDoc?: unknown): Promise<AccessDecision>;

// Audit / time travel. `options.decryptionKeyId` reproduces the create-key gate
// (section 6.6) verdict for a doc_create as decided at `at`.
wasAllowedAt(op: RuleType, username: string, dbid: string,
             at: number, candidateDoc?: unknown,
             options?: { decryptionKeyId?: string }): Promise<AccessDecision>;
```

There is no dedicated enable/disable call: `setDefaultAccessPolicy` is the single
mechanism. Setting one or more `deny*` flags enables enforcement; setting
`disableAllAccessChecksAndPolicies: true` is the explicit master off switch (and
reverting it re-enables). Every such change is just another revision of the
append-only `acl_defaultpolicy` document, so the full enable/disable timeline is
auditable via time travel.

`MindooDB.createDocument()` gains optional **initial values** so a `doc_create`
Tier 2 rule (e.g. "the creator must put themselves into `myeditors`") can be
evaluated against the very first change.

### 9.1 Client-side write prechecks (immediate feedback)

`MindooDB.createDocument()`, `changeDoc()`, `deleteDocument()`, and
`undeleteDocument()` evaluate the **full Tier 1 + Tier 2 ruleset synchronously at
the call site**, before persisting locally, and throw `AccessDeniedError` when the
write is denied. This gives applications immediate, meaningful feedback (for
example, a database-browser editor that lets the user edit a document's JSON can
catch the error and show `decision.reason`) instead of an optimistic local write
that is only rejected later by the server witness or quarantined on
materialization.

```ts
class AccessDeniedError extends Error {
  readonly op: RuleType;          // doc_create | doc_change | doc_delete | doc_undelete
  readonly dbid: string;
  readonly decision: AccessDecision; // { allowed: false, reason, matchedRuleId?, tier }
}
```

The precheck reuses the cached directory head state, evaluates against
`trustedTime = now`, resolves `$author` from the document's `doc_create` signer,
and only materializes the before/after document (Automerge → JS) when the active
policy actually has a Tier 2 (`withfields`) content rule for that operation and
database. It **fails open** on any directory/infra error — the server witness
(Tier 1) and quarantine-on-materialization (Tier 2) remain the authoritative
enforcers, so a transient directory error never blocks a legitimate local write.
The create-key allowlist gate (section 6.6) is enforced through this same path.

Each write method accepts `bypassAccessControlPrecheck?: boolean` (default
`false`) on its options for trusted/bulk paths; it skips only the local precheck
and does **not** weaken server/materialization enforcement.

Three non-throwing prediction helpers let a UI disable actions and surface the
reason up front (they return an `allowed: true` decision when access control is
not enforced):

```ts
canCreate(options?: CreateOptions): Promise<AccessDecision>;
canChange(doc: MindooDoc, candidateAfter: Record<string, unknown>,
          signingKeyPair?: SigningKeyPair): Promise<AccessDecision>;
canDelete(doc: MindooDoc, signingKeyPair?: SigningKeyPair): Promise<AccessDecision>;
```

Note on custom-id documents: they cannot take `initialValues` (their first change
is a deterministic, content-free seed for hash convergence), so a `doc_create`
content rule sees an empty "after" state. For create-time content validation use a
generated UUID with `initialValues`; otherwise the meaningful content check lands
on the first `changeDoc` (which also throws synchronously).

## 10. Sync and materialization behavior

- **Client precheck (honest client, immediate):** `createDocument` / `changeDoc` /
  `deleteDocument` / `undeleteDocument` evaluate the full ruleset before writing and
  throw `AccessDeniedError` (section 9.1) when denied, so a denied write never lands
  locally in the first place. This is a UX/early-feedback layer only — it fails open
  on infra errors and can be bypassed — so the server and materialization checks
  below remain the authoritative enforcers against tampered or offline clients.
- **Push violation (Tier 1, server):** rejected with a structured `AccessDenied`
  (HTTP 4xx). The entry remains local and is retried only if access is regained.
- **Materialization violation (Tier 2, client):** the entry is **not materialized**;
  its bytes remain in the append-only store but are excluded from queries and from
  re-sync, and the event is added to a per-tenant quarantine/audit log that Haven can
  display.
- **Tier 2 is a pure, deterministic function** — this is what keeps "quarantine on
  receipt" compatible with eventual consistency. The verdict for an entry is computed
  purely from:
  1. the **entry** itself (its decoded change and signed metadata),
  2. the **directory state at the entry's trusted time** (`receivedAt`), obtained
     from the directory-state node covering that time (section 8), and
  3. the set of **causally-prior _accepted_ entries** (which defines the `before`
     state for `when: "before"` clauses).

  Because all three inputs are identical on every honest replica that has synced up
  to the same point, every replica computes the **same accepted set** and the **same
  `before` state**, and therefore the same verdict. There is no wall-clock input
  (`${now}` was removed for exactly this reason): any time notion is pinned to the
  entry's trusted time.
- **Dependent handling (cascade-quarantine).** When an entry is quarantined, every
  entry that **causally depends on** it (transitively, via Automerge change deps) is
  also quarantined — a replica never materializes a change whose ancestor it rejected.
  The accepted set is thus always a causally-closed prefix, identical across replicas.
  (We cascade rather than try to rebase the subtree; rebasing would not be
  deterministic across replicas.)
- **Snapshots (`doc_snapshot`).** A snapshot adds no new information — it just
  combines already-verified heads. A snapshot is **trusted** iff **both**: (a) every
  head it covers (`snapshotHeadHashes` / `snapshotHeadEntryIds`, already present in
  `StoreEntryMetadata`) maps to an **already-trusted** entry, **and** (b) when the
  client decodes the `doc_snapshot` payload, the **Automerge heads of the decoded
  snapshot equal the covered dep heads declared in the store entry**. This head-match
  check is **mandatory** (not an optional setting): it guarantees the snapshot is a
  faithful checkpoint of exactly the verified history and cannot smuggle content the
  author was not allowed to write. A snapshot that fails either check is quarantined,
  and the underlying heads are materialized from their individual trusted entries
  instead. Authoring a snapshot is governed by `denyDocSnapshot` (admin-only by
  default).
- **Purge (`doc_purge`).** `purgeDocHistory()` is gated by a `doc_purge` rule;
  default is admin-only. A purge instruction from a non-authorized signer is ignored.

## 11. Worked example: a CRM with per-record editors

This walks one realistic policy end-to-end so the moving parts line up. The tenant
has a `crm` database. The rules we want:

1. Everyone in the tenant may **create** CRM contacts, but the creator must put
   themselves into the document's `myeditors` list (checked on the **after** state).
2. A contact may only be **changed** by someone **already** listed in its `myeditors`
   (checked on the **before** state, so a non-editor cannot add themselves in the
   same change).
3. A contact may only be **deleted** by its original creator.
4. The HR group may change anything in `crm` (an escape hatch / supervisor role).

### Setup (admin, once)

```ts
// Enable access control: deny doc lifecycle ops by default in crm.
await directory.setDbAccessPolicy("crm", {
  denyDocCreate: true,
  denyDocChange: true,
  denyDocDelete: true,
}, adminKey, adminPassword);

// Rule 1 — anyone may create, IF they add themselves to myeditors (Tier 2).
// "after" (the default for doc_create): the new doc must include the creator.
await directory.createRule({
  type: "doc_create",
  ruleId: "crm_create_self_editor",
  dbid: "crm",
  withfields: [{ key: "myeditors", op: "containsAny", value: "${user.usernames}",
                when: "after" }],
  users_hashes: ["$everyone"],
  users_encrypted: encryptForPublicInfos(["$everyone"]),
  action: "allow",
}, adminKey, adminPassword);

// Rule 2 — only ALREADY-listed editors may change (Tier 2).
// "before" (the default for doc_change): the editor check runs against the existing
// doc, so a non-editor cannot add themselves in the same change to authorize it.
await directory.createRule({
  type: "doc_change",
  ruleId: "crm_change_if_editor",
  dbid: "crm",
  withfields: [{ key: "myeditors", op: "containsAny", value: "${user.usernames}",
                when: "before" }],
  users_hashes: ["$everyone"],
  users_encrypted: encryptForPublicInfos(["$everyone"]),
  action: "allow",
}, adminKey, adminPassword);

// Rule 3 — only the creator may delete (Tier 1 via $author).
await directory.createRule({
  type: "doc_delete",
  ruleId: "crm_delete_by_author",
  dbid: "crm",
  users_hashes: ["$author"],
  users_encrypted: encryptForPublicInfos(["$author"]),
  action: "allow",
}, adminKey, adminPassword);

// Rule 4 — HR supervisor escape hatch (Tier 1, no withfields).
await directory.createRule({
  type: "doc_change",
  ruleId: "crm_change_hr",
  dbid: "crm",
  users_hashes: [hashGroup("hr")],
  users_encrypted: encryptForPublicInfos(["hr"]),
  action: "allow",
}, adminKey, adminPassword);
```

### Alice creates a contact

```ts
// createDocument with initial values lets the doc_create Tier 2 rule see myeditors.
const contact = await crm.createDocument({
  initialValues: { form: "CRMContact", name: "ACME GmbH",
                   myeditors: ["cn=alice/o=acme"] },
});
```

- **Local check (Scenario A):** baseline is *deny*. Rule 1 matches (`$everyone`),
  and its `withfields` passes because the **after** state's `myeditors` contains
  Alice → **allowed**.
- **Push (Scenario B):** Rule 1 is Tier 2, so the server only confirms Tier 1
  (`$everyone`, db `crm`, op `doc_create`) is not denied, then witnesses the entry.
- If Alice had forgotten to add herself, the local create would have been **denied**
  with `matchedRuleId: "crm_create_self_editor"` and never reached the server.

### Bob (not an editor) tries to change it

- **Local check:** Rule 2 matches by `$everyone`, but its `withfields` fails because
  the **before** state's `myeditors` does not contain Bob → no allow rule applies →
  baseline *deny* → **denied** locally; the SDK greys out the edit via
  `canDo("doc_change", "crm", contact)`. Note this holds even if Bob's change tries to
  add himself to `myeditors`: the editor check runs against the document *before* the
  change, so self-insertion cannot authorize the edit.
- If a tampered client authored the change anyway, the **server** lets it through
  Tier 1 (it can't see content), but **every honest receiver** (Scenario C) re-checks
  Tier 2 on materialization, fails it, and routes the change to quarantine instead of
  applying it. Bob's edit never becomes visible to anyone.

### Alice deletes her contact

- **Server check (Tier 1):** Rule 3 matches via `$author` — the `doc_create` entry's
  `createdByPublicKey` resolves to Alice, and so does the delete's signer → **allowed**
  and witnessed. A delete signed by anyone else fails Tier 1 at the server and is
  rejected on push.

### A member of HR changes any contact

- **Server check (Tier 1):** Rule 4 matches the `hr` group hash with no `withfields`,
  so it is fully server-enforced → **allowed** regardless of `myeditors`.

This example shows the division of labor: Tier 1 rules (`$author`, group `hr`) are
enforced at the server and survive a malicious client; Tier 2 rules (the `myeditors`
content checks) are enforced by every honest client and quarantined on receipt if
violated.

## 12. Migration and rollout

- **Enabling, disabling, and pre-existing data.** There is no separate epoch
  marker. The append-only history of `acl_defaultpolicy` (and the per-DB policies) is
  itself the source of truth for when access control was active:
  - The **first policy revision that sets a `deny*` flag** is the de-facto
    activation point. Its trusted time is derivable from directory history, so
    nothing extra needs to be stored.
  - An entry whose **trusted time precedes any restrictive policy** resolves against
    the implicit all-allow default — so pre-existing data created before ACL was
    enabled is allowed automatically, with no grandfathering logic.
  - **Temporary disable** = set `disableAllAccessChecksAndPolicies: true`, then
    revert it later. Every entry whose trusted time falls in that window is judged by
    the disabled policy and the window is fully reconstructable (and auditable) from
    the append-only directory history.
  - This relies on the **trusted-time** definition (`receivedAt` if present, else
    `createdAt`): each entry is evaluated against the policy state as of its trusted
    time. Because a not-yet-witnessed local entry uses `createdAt` only until it is
    pushed — at which point the witness stamps a real `receivedAt` — a malicious early
    `createdAt` cannot be used to slip a change past a restrictive policy.
- **Capability negotiation.** `GET /sync/capabilities` advertises
  `supportsAccessControlV1` and `serverTime`. Older clients may still pull (the
  server enforces Tier 1 on push regardless). A per-tenant **strict mode** can refuse
  pushes from clients that do not understand witness fields; new tenants may start in
  strict mode.

## 13. Read access control

Sections 1–12 govern **writes** (who may create/change/delete). Read access is the
mirror image: who may *see* already-encrypted data. It reuses the same machinery —
admin-signed, `$publicinfos`-encrypted directory documents; identity-set evaluation;
time-travel auditability — but with three deliberate differences from the write side:
read rules are **metadata-only** (no `withfields`), carry **no client-trusted dates**,
and are enforced by a **server delivery gate** plus a cooperative client purge rather
than by a per-entry materialization guard.

Read access control is **opt-in and absent by default**: with no read policy document,
read access is unrestricted (key possession is the only gate, exactly as before).

### 13.1 What read revocation can and cannot do

The author's Ed25519 signature is computed over the **ciphertext** (`signPayload`
runs on the encrypted payload; verification checks the encrypted bytes). History
therefore **cannot be re-encrypted in place** without destroying authorship. Read
revocation is consequently forward-looking and has three mechanisms:

1. **Gate future delivery** — the server stops shipping entries for a `(db, key)`
   scope to a user who is no longer entitled (the strong layer).
2. **Cooperative local purge** — an honest client that loses entitlement deletes the
   already-synced ciphertext and crypto-shreds the affected key (best-effort).
3. **Crypto-shred** — destroying a symmetric key makes every entry encrypted with it
   permanently unreadable everywhere (tenant-wide erasure; designed separately).

There is no in-place re-encryption of history, and field-level read control remains
future work (section 14).

### 13.2 Schema (all `form: "accesscontrol"`, `$publicinfos`-encrypted)

So the sync server can evaluate them, every read document is encrypted with
`$publicinfos` (the server holds that key) and carries only **metadata** — never
plaintext document content.

- **Default read policy** — id `acl_readpolicy` (tenant singleton); per-database
  `acl_dbreadpolicy_<dbid>`:
  - `type: "readpolicy"`
  - `defaultReadAccess: "allow" | "deny"` — the baseline. **Absent document = allow**
    (preserves today's key-only behavior). A per-DB policy overrides the tenant
    default for that database.
  - `disableAllReadChecks?: boolean` — master off switch (read equivalent of
    `disableAllAccessChecksAndPolicies`).
- **Read rule** — id `acl_readrule_<ruleId>`:
  - `type: "doc_read"`, `ruleId`, optional `description`
  - `dbid: string | "*"`
  - `decryptionKeyIds?: string[]` — optional key scope. Absent/empty = the rule
    applies to **every** key in the database (document-level read control); present =
    the rule only covers entries encrypted with those key ids (sub-document / column
    read control via differently-keyed fields).
  - `users_hashes: string[]` — user + group hashes plus the pseudo-tokens
    `$everyone` / `$admin` (same hashing as membership entries; `$author` is not
    used on the read side in v1). A group target is **expanded to its members at
    evaluation time** via the acting user's identity set (which carries a hash of
    every group the user belongs to, including nested groups). Group names are
    matched **case-insensitively** — both the rule and the identity set hash the
    normalized (lower-cased) group name — so `"Analysts"` and `"analysts"` are the
    same target. (The same applies to write rules, §6.3.)
  - `users_encrypted: string` — the targeted usernames/groups, JSON-encoded and
    encrypted with the **tenant default key** (not `$publicinfos`), base64. This is a
    **display aid** for admin UIs (e.g. Haven) so they can show *who* a rule targets
    without reversing the salted hashes — mirroring how `grantaccess` and group
    documents keep an encrypted member list. Because it is under the tenant key, it
    stays **opaque to the sync server** while remaining readable by tenant clients.
    Empty when the rule was authored from raw hashes / pseudo-tokens only.
  - `action: "allow" | "deny"`
  - **No `notBefore` / `notAfter` and no `withfields`.**
- **Key delivery** — id `acl_keydelivery_<keyId>_<fingerprint>`:
  - `type: "keydelivery"`, `keyId`, `preparedByPublicKey` (the key-holder who
    wrapped it; audit)
  - `recipients: Array<{ username_hash, versions }>` where each entry carries
    **all** stored versions of the key:
    `versions: Array<{ keyVersionCreatedAt, wrappedKey }>` and
    `wrappedKey = RSA-OAEP(keyBytes, recipient's encryption public key)`.
  - **All versions are delivered, not just the latest.** A `keyId` can hold
    several versions after rotation, and decryption tries them all; shipping only
    the newest would leave the recipient unable to read documents encrypted under
    an earlier version. Each version is wrapped individually per recipient, and
    `keyVersionCreatedAt` lets the recipient re-create the rotation timeline in
    its `KeyBag` (import is idempotent per version).

### 13.3 No client-trusted dates — revocation by policy revision

The write side forbids a client-supplied wall clock (`${now}`) because it is
spoofable. Read rules inherit that rule: there is **no `notAfter`** a client could
evade by setting its clock back. Instead, **time-bound access = revocation by policy
revision**: an admin (or a scheduled automation) flips the allow rule to deny / removes
the user, and on the next directory sync the client purges the scope. The server gate
enforces against **trusted server time**, so a revoked user is cut off from new data
immediately regardless of their local clock. A future declarative "expires at T" must
likewise be enforced at the server against server time, never the client clock.

### 13.4 Evaluation (`evaluateReadAccess`)

A pure function, modeled on the write evaluator and equally clock-free:

- Inputs: `{ dbid, decryptionKeyId, identity, node }` (the `DirectoryStateNode` at the
  point in time being evaluated).
- No read policy / rules at this node → **allow**; master switch engaged → **allow**.
- Baseline from `defaultReadAccess`, **per-DB policy over tenant default**.
- Candidate rules: `type: "doc_read"`, `dbid` matches or `*`, the key scope covers
  `decryptionKeyId` (rule has no key scope, or the id is listed), and `users_hashes`
  intersects the acting user's identity set.
- **Deny overrides allow.** Returns the shared `AccessDecision`.

For audit, `wasAllowedToReadAt(username, dbid, decryptionKeyId, at)` evaluates against
the **historical** directory-state node covering trusted time `at` — `at` only selects
which node to read, it is never compared as a `notAfter`. This is the read analogue of
`wasAllowedAt` (section 9) and gives a reproducible answer to "could this user read
this scope at that moment?" across the join → department-change → leave lifecycle.

The directory time-travel chain (section 8) carries `readPolicy`, `dbReadPolicies`,
and `readRules` on each node so read decisions are reconstructable at any past time,
exactly like write decisions.

### 13.5 Enforcement

```
admin signs read policy/rules + key-delivery ─┐
key-holder wraps key to recipients ───────────┘→ directory ($publicinfos)
                                                   │
                          ┌────────────────────────┴───────────────────────┐
                          ▼                                                  ▼
                    sync server                                          client
   evaluateReadAccess at server time:                  entitlement lost → delete keys + purge scope
   filter entries by dbid + decryptionKeyId            key-delivery for me → RSA-unwrap → KeyBag.set
                          │                                                  │
                          ▼                                                  ▼
                       client                                       reveal-on-add (existing)
```

- **Server delivery gate (the strong layer).** In the server store's read endpoints
  (`handleGetEntries`, `handleScanEntriesSince`, `handleFindNewEntries(ForDoc)`,
  `handleFindEntries`, `handleGetAllIds`, metadata/has endpoints), the server resolves
  the authenticated user, then filters every returned entry/metadata/id by
  `evaluateReadAccess` using the cleartext `dbid` + `decryptionKeyId` + server time.
  Disallowed entries are silently omitted (not an error). Evaluation **fails closed**
  on error. The **directory database is never read-gated** — it carries the policies
  the gate itself depends on and must always be readable.
- **Client local purge (cooperative; works in p2p too).** `reconcileKeyVisibility`
  already hides/reveals documents as keys come and go. It is extended so that when the
  client *holds* a key but the policy now *denies* the `(db, key)` scope
  (`hasKey && !entitled`), it (a) purges the materialized plaintext, (b) deletes the
  already-synced ciphertext from the local store, and (c) **crypto-shreds** the named
  key from the `KeyBag` so the scope cannot be re-materialized. This is policy-state
  driven (one directory sync after revocation) with no client-clock dependency. It is
  best-effort and **fails open** (a transient evaluation error never destroys local
  data — the server gate is the authority). The shared **tenant default key is never
  shredded**, and the directory DB is never gated (same reason as the server).

### 13.6 Admin-blind key delivery (key push)

Granting read access usually means giving a user a key. To let an admin *distribute* a
key without ever *seeing* it:

1. A **key-holder** (any regular user who has the key) runs `prepareKeyDelivery(keyId,
   targets)`. It RSA-OAEP-wraps **every stored version** of the key bytes (not just the
   latest — see §13.2) to each target's encryption public key, producing a
   `KeyDeliveryPayload` with `preparedByPublicKey` set to the holder.
2. An **admin** runs `publishKeyDelivery(payload, adminKey, adminPassword)`: it signs
   and writes the `acl_keydelivery_*` directory document. The admin only ever handles
   the **wrapped** bytes — an admin outside the recipient set can never unwrap the key.
   (`pushKey(keyId, targets, …)` is a convenience for when the admin legitimately holds
   the key and performs both steps.)
3. On directory sync, each client runs `importKeyDeliveriesForUser(...)`: it finds
   deliveries addressed to its `username_hash`, RSA-unwraps **all** key versions with
   its encryption private key, and `KeyBag.set`s each new one — which triggers the
   existing, tested **reveal-on-add** path so the newly readable documents surface
   automatically. Import is idempotent per version, and reconciliation runs once after
   all versions are written. Manual key sharing (`sharePassword`) continues to work
   unchanged.

### 13.7 Public API additions (`MindooTenantDirectory`)

- `setDefaultReadPolicy(policy, adminKey, adminPassword)`,
  `setDatabaseReadPolicy(dbid, policy, adminKey, adminPassword)`
- `createReadRule({ dbid, decryptionKeyIds?, usernames?, groups?, users_hashes?,
  action }, adminKey, adminPassword) → ruleId`, `deleteReadRule(ruleId, …)`,
  `listReadRules(filter?)` — each listed rule carries decrypted `targets`
  (usernames/groups) for display when authored with cleartext names; revoke = delete
  the allow rule or add a deny rule.
- `canRead(dbid, decryptionKeyId?) → AccessDecision`,
  `wasAllowedToReadAt(username, dbid, decryptionKeyId, at) → AccessDecision`
- `prepareKeyDelivery(keyId, targets) → KeyDeliveryPayload` (key-holder),
  `publishKeyDelivery(payload, adminKey, adminPassword)` (admin-blind),
  `pushKey(keyId, targets, adminKey, adminPassword)`,
  `importKeyDeliveriesForUser(username, encryptionPrivateKey, password) → string[]`
  (client; returns the key ids imported).

`listRules` (the write-side listing, section 9) gains the same decrypted `targets`
display field for symmetry.

## 14. Open questions and future work

- **Multi-key user identities (full).** v1 enables key rollover via grant-doc key
  arrays and the join-request flow. A complete model (per-key revocation semantics,
  whether users may self-rotate without admin approval, device naming) is a separate
  proposal.
- **p2p witnessing.** Trusted witness peers / threshold witnessing for serverless
  groups.
- **Field-level read access.** Document- and key-level read control ships in section
  13 (a read rule scoped by `decryptionKeyIds`). True *field*-level read control would
  require additional keying so different parts of one document can be encrypted with
  different keys. The intended **naming convention** (not yet implemented) extends the
  existing `<field>_encrypted` / `<field>_encrypted_key` pattern already used for
  `user_details_encrypted` (section 6.5): a sensitive field is stored as a `_encrypted`
  payload alongside a `_encrypted_key` field naming the key id it was encrypted with —
  for example `usernames_encrypted` + `usernames_encrypted_key`. This makes it
  explicit, per field, which key a reader needs, so a user without that key sees only
  ciphertext for that field while still reading the rest of the document. A read rule's
  `decryptionKeyIds` scope then governs that field's key directly.
- **Declarative read expiry ("expires at T").** Deferred. If added, it must be enforced
  at the **server** against trusted server time, so the client evaluator stays
  clock-free; for now, scheduled expiry = an automation that flips the policy at T.
- **Regex / richer operators** in `withfields` (including time-based comparisons
  bound to the entry's trusted time) once the closed v1 set proves insufficient.
- **Independent directory timestamping witness** to further harden policy-history
  integrity against a single compromised witness (section 5.4).
- **Server-side audit docs.** Optional `acl_audit_*` directory entries (encrypted
  with `$publicinfos`) recording rejections for compliance, off by default.
- **Regex / richer operators** in `withfields` (including time-based comparisons
  bound to the entry's trusted time) once the closed v1 set proves insufficient.
- **Independent directory timestamping witness** to further harden policy-history
  integrity against a single compromised witness (section 5.4).
- **Server-side audit docs.** Optional `acl_audit_*` directory entries (encrypted
  with `$publicinfos`) recording rejections for compliance, off by default.
