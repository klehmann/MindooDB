# MindooDB Access Control & Governance

> **A Haven Enterprise capability.** Fine-grained access control, group & identity
> management, and cryptographic key governance ship with **Haven Enterprise
> Edition**. Haven Community Edition gives every member of a tenant the same
> powerful, end-to-end-encrypted, local-first database. Enterprise Edition adds the
> *governance layer* an organization needs on top of it — so apps running inside
> Haven behave according to your organization's rules.

## What this layer is for

MindooDB is zero-trust and local-first: data is end-to-end encrypted, the sync
server never sees plaintext, and every device keeps working without a network. That
foundation is identical in every edition, and it is excellent for individuals and
small, fully-trusted teams.

At organizational scale, a new need appears: **rules**. Not everyone should be able to
create, change, delete, or read everything; encryption keys should follow a deliberate
plan rather than "one shared key for all"; and a compliance officer must be able to
answer *"who was allowed to do what, and when?"* long after the fact — even though
people work offline and their device clocks cannot be taken at face value.

This document describes the layer that delivers exactly that, **without giving up** the
zero-trust-server, end-to-end-encrypted, eventually-consistent foundation. With it,
Haven can support a whole organization in **storing, distributing, and collaborating on
data securely and auditably** — turning a great personal database into governed,
enterprise-ready infrastructure.

## Why it is worth Enterprise Edition

| Capability | Community Edition | Haven Enterprise Edition |
|------------|:-----------------:|:------------------------:|
| End-to-end encryption, local-first sync, zero-trust server | ✅ | ✅ |
| Read access by key possession | ✅ | ✅ |
| **Write governance** — who may create / change / delete / snapshot / purge, scoped to database *and* content | — | ✅ (§2–§12) |
| **Read governance** — who may *see* which data, by encryption-key possession (admin-blind key distribution + revoke/rotate) | — | ✅ (§13) |
| **Group & identity management** — DN-hierarchy identities, nested groups, wildcard targeting | — | ✅ (§6.5, §8.1) |
| **Cryptographic key guidelines** — choose & rotate the keys new documents use, admin-blind key distribution, crypto-shred | — | ✅ (§6.6, §13.6) |
| **Organizational lockdown** — control which databases may even exist | — | ✅ (§6.7) |
| **Auditability & time travel** — reproduce any past decision; inspect the quarantine log | — | ✅ (§8, §9, §10) |
| **Offline-honest enforcement** — decisions hold even when clients are offline and clocks are untrusted | — | ✅ (§4–§5) |

In one line: **Community Edition secures the *data*; Enterprise Edition lets you govern
*how an organization uses that data* — provably, offline, and over time.**

## The mental model in one minute

Four ideas carry the whole design; if you remember these, the rest reads easily:

1. **Two tiers (§2).** Rules split by *what the zero-trust server can see*. **Tier 1**
   (identity / database / key / operation) is cryptographically enforced by the server
   against everyone. **Tier 2** (document content) is enforced by every honest client on
   receipt. Both are real protection — see §14.1 for *when to use which*.
2. **One new primitive: the witness receipt (§5).** When the server accepts an entry it
   signs *"accepted at this time"*. That attestation is the trusted clock everything else
   builds on.
3. **Trusted time, not wall-clock (§4, §8).** Every decision is evaluated against the
   policy that was in force at an entry's *trusted time*, so replicas always agree and
   offline clients cannot rewind the clock to slip a change through.
4. **It's all just signed documents.** Policies, rules, groups, and grants are
   admin-signed entries in the directory database that everyone already syncs. The
   complete enable / change / disable timeline is therefore inherently auditable.

## How to read this document

| If you want to… | Read |
|-----------------|------|
| Understand the design and trust model | §1 goals · §2 two-tier model · §3 trust chain · §4 clocks |
| Understand the one new cryptographic primitive | §5 witness receipt |
| See the configurable building blocks | §6 directory schema (policies, rules, groups, keys, DB lockdown) |
| Understand how a decision is computed | §7 evaluation · §8 time-travel state |
| Call it from an app | §9 public API · §9.1 client prechecks |
| Know how it behaves during sync | §10 materialization & quarantine |
| See it all working end-to-end | §11 worked example (CRM) |
| Turn it on safely | §12 migration & rollout |
| Govern *reads* | §13 read access control |
| **Set it up well in an enterprise** | **§14 deployment guide & best practices** |
| Know what's coming next | §15 future work |

> **New to this?** Read §1–§2, then jump straight to the **§11 worked example** and the
> **§14 best-practices guide** — those two make everything else concrete.

## 1. Goals and scope

MindooDB already restricts **read** access cryptographically: a document can only
be read by someone who holds the encryption key it was encrypted with (`default`
or a named key). That is strong but coarse on its own — anyone who can read a database
can also create, change and delete documents in it. This layer adds the *fine-grained*
controls an organization needs on top of that solid base.

The access control layer adds governance over **write** operations
(`doc_create`, `doc_change`, `doc_delete`, `doc_undelete`, `doc_snapshot`,
`doc_purge`) on top of the existing encryption model (read governance follows the same
shape in §13).

**Goals**

- Govern which users (or groups) may create, change, delete, snapshot or purge
  documents, optionally scoped to a database and to the document's content.
- Keep those guarantees intact even when users work **offline** and their device clock
  cannot be taken at face value.
- Make every decision **auditable and reproducible for any point in time** ("was user
  X allowed to change this document when the change actually entered the tenant?").
- Stay **opt-in and backward-compatible**: existing tenants behave exactly as before
  until an admin enables governance, and pre-existing data is never retroactively
  invalidated.

**Scope — and where each adjacent concern is handled**

- **Read confidentiality** is provided by encryption keys plus the read-governance layer
  (§13) and **key scoping** (§14.4), rather than by re-encrypting history on every rule
  change. Key possession stays the cryptographic read gate.
- **A tampered client** can always author an entry on *its own* device — that is true of
  any local-first system. What matters is the shared organizational state, and the
  two-tier model (§2) keeps a violating entry from being **accepted into the tenant**
  (Tier 1) or **materialized by honest clients** (Tier 2). The blast radius is bounded,
  audited, and reversible.
- **Full multi-key-per-user identities** are future work (§15); v1 already supports key
  rollover today via grant-document key arrays and the join-request flow.

## 2. The two-tier model (the core idea)

The central design decision is to split every rule into one of two tiers, based on
**what the sync server can see**. The server only ever sees ciphertext plus a small
set of cleartext/`$publicinfos`-encrypted metadata fields; it can never read
document bodies.

| Tier | Checks | Enforced by | What it guarantees |
|------|--------|-------------|--------------------|
| **Tier 1 — Identity rules** | Author identity, target database, operation type, create-key | **Server _and_ clients** | Cryptographically enforced everywhere: the server refuses to witness a violating entry, so it can never propagate — this holds even against a fully tampered client |
| **Tier 2 — Content rules** | The actual document content (`withfields`) | **Every client, on receipt** | Protects the organization's shared data integrity: every honest client re-checks the content on materialization and quarantines a violation (§10), so it never becomes visible to anyone and cannot be built upon |

A rule is **Tier 2 if and only if it has a `withfields` clause**. Everything else
is Tier 1.

This split is the whole architecture, and it lets us make a clear, honest promise:

> MindooDB cryptographically enforces **who may write what kind of entry, and where**.
> It enforces **what the content must look like** across every client running the
> official software — quarantining any violation on receipt.

Both tiers are genuine protection; they simply do different jobs. The reason Tier 2 is
client-enforced rather than server-enforced is a **feature, not a compromise**: enforcing
content on the server would mean handing it the tenant encryption key, which would
break the zero-trust-server promise that makes MindooDB safe to host anywhere. Keeping
content checks on the clients preserves zero-trust while still protecting the honest
organization. For practical guidance on **which tier to use for which requirement**, see
§14.1.

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

> **Identity resolution for the revoked-key blacklist.** The server resolves the
> caller from the **authenticated device signing key** (carried in the JWT as
> `deviceSigningKey`), not a cleartext username — the challenge username is
> optional and may be omitted entirely. It looks up the grant document for that
> signing key and reads its precomputed, `$publicinfos`-readable `identity_hashes`
> bundle (the v1+v2 hashes of every DN wildcard variant of the name, written at
> grant time). The per-user revoked-key blacklist (§13.3) is then matched purely
> in hash space (set-intersection of those hashes against each key distribution's
> `pullfrom_users_hashes`), so the server never needs the cleartext name. Legacy
> grants without the bundle (`identity_hashes_v` absent/0) degrade to exact
> `username_hash` matching and are flagged for backfill; saving the user in the
> admin "Manage user" dialog (or any `updateUserGrant`) recomputes and stores the
> current bundle.

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

  /** Database read/sync gate. When true, members may not open or sync the
   *  governed database(s) unless a doc_read allow rule grants them access; when
   *  false (default) reading is open and key possession alone decides what can
   *  actually be decrypted. This is the COARSE per-database gate in front of
   *  every sync operation — a denied user can neither pull nor push, so they
   *  cannot create data either (read is required to create). Layers per-db over
   *  the tenant default like the other deny* flags; admin exempt; "directory"
   *  never gated. See section 6.8. */
  denyDocRead: boolean;      // default false  (reading open unless explicitly denied)

  /** Optional default decryptionKeyId a doc_create uses when the caller does
   *  not specify one in this scope (replacing the hardcoded "default" fallback).
   *  This is a client-side convenience, NOT a security control — the server
   *  never selects keys; read/write access is governed by key possession
   *  (distribution + rotation, §13). See section 6.6. */
  defaultCreateKeyId?: string;

  /** Governs which databases tenant members may open/sync. TENANT-LEVEL ONLY —
   *  read solely from acl_defaultpolicy, never layered through a per-db policy.
   *  "open" (default) allows any valid database id. "directory-restricted"
   *  allows only "directory" (always implicit) and the ids in allowedDbIds; the
   *  tenant admin is exempt. See section 6.7. */
  databaseCreationPolicy?: "open" | "directory-restricted";

  /** The database ids permitted when databaseCreationPolicy is
   *  "directory-restricted". "directory" is always allowed and need not be
   *  listed; every other id (including "main") must appear explicitly. Ignored
   *  in "open" mode. Tenant-level only. See section 6.7. */
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
tenant-level only and are ignored if set on a per-database policy (see section 6.7).

### 6.3 ACL rule (`acl_rule_<ruleId>`)

```ts
type RuleType =
  | "doc_create" | "doc_change" | "doc_delete"
  | "doc_undelete" | "doc_snapshot" | "doc_purge"
  | "doc_read";  // database-level read/sync gate (section 6.8); dbid-scoped, no withfields

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
  // at grant time. Lets the server resolve wildcard/group targets (e.g. the
  // per-user revoked-key blacklist, §13.3) purely in hash space from the
  // authenticated device key, without ever seeing the
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

### 6.6 Default create key (`defaultCreateKeyId`)

A policy may also set a single `defaultCreateKeyId`: the `decryptionKeyId` a
`doc_create` uses when the caller does not pass one. It replaces the historical
hardcoded `"default"` fallback, so `createDocument()` (no key) under a policy
that sets `defaultCreateKeyId: "projkey"` creates the document under `projkey`.

This is a **client-side create-time convenience, not a security control**. The
sync server never selects keys; read/write access is governed by key possession
(§13). The resolution order at create time is:

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

### 6.7 Directory-restricted database policy (`databaseCreationPolicy` / `allowedDbIds`)

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
Every other id must be listed explicitly. The tenant
**admin is exempt** and may open/sync any id.

Unlike most policy fields, these fields are **never** layered through a per-db
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

### 6.8 Database read/sync access (`denyDocRead` + `doc_read` rules)

§6.7 decides *which database ids exist* tenant-wide. This section decides *who*
may open and sync a given database. It is **not** about decryption key ids
(what a user can decrypt is still governed by key possession, §13) — it is a
membership gate: which users and groups may read/sync a database at all.

It reuses the ordinary policy + rule machinery, so it behaves exactly like the
write side:

- **Default policy.** `denyDocRead` on `acl_defaultpolicy` (and, layered per-db,
  on `acl_dbpolicy_<dbid>`) sets the baseline. It defaults to `false` (reading
  open), so existing tenants are unaffected until an admin opts in to
  default-deny.
- **Rules.** A `doc_read` rule (`acl_rule_<ruleId>`, `action: "allow" | "deny"`,
  `dbid`, `users_hashes` + groups + `$everyone`) grants or revokes read access to
  specific users/groups. `doc_read` is a database-level decision, so its rules
  are always Tier 1 and **may not** carry `withfields` (rejected at authoring).
  `deny` overrides `allow` like everywhere else.

**Read is the master per-database gate, so it also gates writes.** Because the
check sits in front of *every* sync operation for a database, a user denied read
access can neither pull nor push it — which means they cannot create data in it
either. This is intentional: a user who could write but not read would create
documents they can never see. So **read access is required to create data**, and
no separate coupling is needed — the read gate is simply the precondition for
all sync on that database; write rules (§6.3) then apply on top for users who
pass it.

**Enforcement points (defense in depth)** — the same two choke points as §6.7,
plus the admin/`"directory"` exemptions:

1. **Client open path** — `MindooTenant.openDB` (via `assertCurrentUserCanOpenDB`
   → `MindooTenantDirectory.canReadDatabase`) refuses to open a database the
   current user has no read access to. `"directory"` and the tenant admin are
   exempt.
2. **Server sync choke point** — the database-open gate
   (`evaluateDbAccessForSigningKey`, the same hook §6.7 uses) additionally
   evaluates `doc_read` for the request principal's signing key and rejects
   serving *and* accepting pushes when it denies. Evaluated server-side at
   acceptance time (Tier 1) from the `$publicinfos`-readable policy/rules — no
   tenant key, no new plumbing. The `"directory"` store is never gated; the admin
   is exempt.

The §6.7 database-id allowlist and the §6.8 read gate are **orthogonal**: a
database must clear *both* — the id must be permitted, and the user must have
read access to it.

## 7. Evaluation algorithm

For an operation `op` on database `dbid` by user `U`, evaluated at time `T`:

0. **Master switch.** If the effective default policy at `T` has
   `disableAllAccessChecksAndPolicies === true`, return **allowed** immediately
   (`tier: "tier1"`) without evaluating the baseline or any rules. This is what makes
   a true disable safe: a baseline `deny*` flip alone would not neutralize standalone
   `deny` rules, but the master switch bypasses them too.
1. **Resolve the directory state at `T`** (section 8) — default policy, DB policy,
   rules, groups, grants as they were at `T`.
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

// Audit / time travel. Reproduces the access verdict for `op` as decided at `at`.
wasAllowedAt(op: RuleType, username: string, dbid: string,
             at: number, candidateDoc?: unknown): Promise<AccessDecision>;
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
mirror image: who may *see* already-encrypted data. In the current model read access is
**key possession**: a document is readable iff the reader's `KeyBag` holds a key that
decrypts it. There is no read-policy / read-rule subsystem and no per-entry server read
evaluator — those were removed. Two mechanisms remain, both admin-signed and
`$publicinfos`-encrypted so the sync server can read the metadata it needs:

1. **Key distribution** (`acl_keydistribution_<keyId>`, §13.2/§13.6) — the authoritative
   `pushto` / `pullfrom` lists and version manifest per key. Clients **reconcile** their
   KeyBag against the directory head: import keys pushed to them, remove keys revoked from
   them.
2. **Per-user revoked-key blacklist** (§13.3) — derived from the `pullfrom` lists, the
   sync server silently withholds entries for a user's revoked `decryptionKeyId`s and
   rejects pushes carrying them. This is a defence-in-depth bandwidth/forward-secrecy
   gate, **not** the confidentiality boundary — ciphertext without the key is unreadable
   regardless of the server.

### 13.1 What read revocation can and cannot do

The author's Ed25519 signature is computed over the **ciphertext** (`signPayload`
runs on the encrypted payload; verification checks the encrypted bytes). History
therefore **cannot be re-encrypted in place** without destroying authorship. Read
revocation is consequently forward-looking and has three mechanisms:

1. **Remove the key from the user** — `pullfrom` causes the client to drop the key from
   its KeyBag; the server stops delivering (and rejects pushes of) entries under that
   key id for that user. A removed-but-dishonest client that kept a key copy can still
   decrypt *old* ciphertext it already holds — see rotation below.
2. **Cooperative local purge** — dropping the key triggers `reconcileKeyVisibility`,
   which forgets the now-inaccessible documents (purges materialized plaintext, marks the
   index entries inaccessible) so they leave caches and views.
3. **Rotate (the only cryptographic cutoff)** — mint a new key version and distribute it
   to the remaining recipients only, so future writes use a version the removed user
   never received. Destroying a symmetric key entirely (crypto-shred) makes every entry
   under it permanently unreadable everywhere (tenant-wide erasure; designed separately).

There is no in-place re-encryption of history, and field-level read control remains
future work (section 15).

### 13.2 Schema (all `form: "accesscontrol"`, `$publicinfos`-encrypted)

So the sync server can read the metadata it needs, every read document is encrypted with
`$publicinfos` (the server holds that key) and carries only **metadata** — never
plaintext document content. There is a single read document type:

- **Key distribution** — id `acl_keydistribution_<keyId>` (one singleton document
  per key; supersedes the former per-recipient `acl_keydelivery_*` model). Publish
  is always an upsert of the key's full desired distribution state. See §13.6 for
  the authoring flow and the reconcile contract.
  - `type: "keydistribution"`, `keyId`, `preparedByPublicKey` (the key-holder who
    wrapped the material; audit trail).
  - `keyVersions: Array<{ createdAt, fingerprint }>` — the **manifest** of
    distributed versions. `fingerprint` = SHA-256 hex of the raw key bytes. It is
    the authoritative list of what this distribution delivers on **push**: imports
    verify unwrapped bytes against the fingerprint. (On **pull**, revocation is
    whole-key — see §13.6 — so the manifest is not consulted for removal.)
  - `title_encrypted` / `comment_encrypted` (+ `_key: "default"`) — display
    metadata encrypted with the **tenant default key**, opaque to the sync server.
  - `pushto_users_hashes: string[]` — users whose KeyBags receive the key.
    `pushto_users_encrypted` (+ `_key: "default"`) is an index-aligned encrypted
    JSON array of the plaintext usernames (display aid; hashes stay authoritative).
  - `pushto_users_keys: Record<"<userHash>|<deviceEncKeyFingerprint>",
    Record<versionFingerprint, wrappedKey>>` — the wrapped material, one entry per
    **active device** of each pushto user, with `wrappedKey = RSA-OAEP(keyBytes,
    device encryption public key)`. **Every device entry covers all manifest
    versions** (validated at publish): a recipient must be able to materialize any
    document encrypted under any distributed version.
  - `pullfrom_users_hashes: string[]` (+ optional `pullfrom_users_encrypted`) —
    users whose KeyBags must **not** hold the manifest's versions. No device keys
    are needed for a revocation. `pushto` and `pullfrom` are disjoint within the
    doc (validated; pull wins as the merge tie-break).

### 13.3 Server-side per-user revoked-key blacklist

The sync server derives, per principal, the set of **revoked decryption key ids** from
the `pullfrom_users_hashes` lists at the directory head (matched against the
authenticated user's `usernameHashCandidates`, excluding the protected key ids `default`
/ `$publicinfos`). This set is the only read-side enforcement the server performs — there
is no general read-policy evaluator. It is computed from the cached distribution state
(see §13.6 cache), so it is O(cache size) with no per-request document scans.

- **Pull (silent omit).** All read endpoints — `handleFindNewEntries(ForDoc)`,
  `handleFindEntries`, `handleScanEntriesSince`, `handleGetEntries`, `handleGetAllIds`,
  `handleHasEntries`, `handleResolveDependencies` — drop any entry/id whose cleartext
  `decryptionKeyId` is in the caller's revoked set. Omission is silent (not an error) so
  a revoked entry simply ceases to exist for that user. `handleGetEntryMetadata` **fails
  closed**: it refuses metadata for a revoked entry rather than returning it.
- **Push (reject).** `handlePutEntries` rejects any entry whose `decryptionKeyId` is in
  the caller's revoked set with `ACCESS_DENIED`, so a revoked-but-dishonest client cannot
  re-upload data under a key it lost.
- **Directory is exempt.** The `directory` database is never blacklisted — it carries the
  distribution documents the blacklist itself is derived from and must always sync.

Wiring: `TenantManager.buildRevokedKeyResolver()` provides a `ServerRevokedKeyResolver`
to `ServerNetworkContentAddressedStore` (skipped for `dbId === "directory"`), which calls
`directory.getRevokedDecryptionKeyIdsForSigningKey(signingKey)`.

This gate is **not** the confidentiality boundary. Ciphertext without the key is
unreadable, so the blacklist is a forward-secrecy / bandwidth measure layered on top of
the cryptographic cutoff (key removal + rotation, §13.1).

### 13.4 SDK-driven reconcile (automatic, after every directory pull and on bring-up)

Reconcile lives **in the SDK**, not just the Haven UI, so standalone apps using the
`mindoodb` npm package get it for free. `BaseMindooTenant.reconcileKeyDistributionsForCurrentUser()`
runs two independent passes against the directory head:

- **Revoke pass (no key required).** Take the revoked key-id list from the head cache
  (`directory.getRevokedDecryptionKeyIdsForUser(username)`) and bulk-call
  `removeNamedDecryptionKey(keyId)` for each. This is a no-op when the key is absent, so
  it is idempotent and needs no bag-vs-head fingerprint diff. Removing a key drives
  `reconcileKeyVisibility`, which forgets now-inaccessible documents.
- **Import pass (needs the encryption private key).** For `pushto` entries addressed to
  this user's devices, unwrap each manifest version, verify the bytes against the
  fingerprint, and merge the missing versions (idempotent, never destructive). The key
  comes from `getEncryptionPrivateKeyForReconcile()` — an injected session key
  (`setSessionEncryptionKey`, used by live-session hosts like Haven) or the
  password-derived key. If neither is available (locked), imports are skipped with a
  warning; the revoke pass still runs.

**Triggers (run-always, idempotent).** A directory-only "dirty" check is insufficient:
the regression to defend against is a user restoring an *older KeyBag backup that still
contains revoked keys*, which happens with no directory change — and `KeyBag.load()`
replaces keys silently (no `onChanges`, no cursor bump). So reconcile runs:

- on directory **bring-up / open** (first `getDirectoryDB` use), and
- after each directory **`pullChangesFrom`** (right after `syncStoreChanges()` when
  `store.getId() === "directory"`).

`reconcileKeyDistributionsForCurrentUserSafe()` wraps it with a single-flight in-flight
flag (the only guard) so reconcile's own `getDirectoryDB` / `updateUnifiedCache` /
`syncStoreChanges` calls do not recurse. It is best-effort (`try/catch`) and never blocks
or fails sync.

**Persistence.** Key mutations from reconcile fire `keyBag.onChanges`. Hosts must persist
the in-memory bag on that signal — the SDK holds it in memory only. Haven subscribes via
`registerKeyBagPersistence` (debounced save onto the identity record); this also
self-heals a restored backup, because the revoke pass's removal emits `onChanges` and the
cleaned bag is re-saved over the restored one.

**Backfill ordering.** A grant surfaces without an explicit re-pull by the natural sync
sequence: sync `directory` → reconcile imports the key → the next content-DB pull (the
server no longer blacklists it) delivers the previously-withheld entries → reveal-on-add
surfaces them. Hosts that sync the directory and content DBs in one cycle therefore see
newly granted documents on the following content-DB pull.

### 13.5 Changefeed: inaccessible vs deleted

Dropping a key marks the affected index entries **inaccessible** (plaintext purged). Both
changefeeds emit a removal signal so consumers (e.g. virtual views) drop the documents:

- `iterateChangeMetadataSince` already yields every index entry with `isDeleted: true`
  for inaccessible rows — `MindooDBVirtualViewDataProvider.update()` calls
  `removeEntry(docId)` on those, so views update with no extra refresh.
- `iterateChangesSince` (full-body feed) previously **skipped** a now-inaccessible doc,
  giving incremental consumers no removal signal. It now emits an **inaccessible
  tombstone** instead: `isDeleted() === true`, `isAccessible() === false`,
  `getData() === {}`, `getHeads() === []`, no attachments. `getData()` returns `{}`
  (rather than throwing) so full-scan consumers that branch on `data.form` / `data.type`
  simply skip it.

`MindooDoc.isAccessible()` lets consumers distinguish a genuine deletion
(`isDeleted && isAccessible`) from a missing-key situation (`isDeleted && !isAccessible`).
Normally-loaded docs report `true`.

### 13.6 Admin-blind key distribution

Granting read access usually means giving a user a key. The **key distribution** model
(`acl_keydistribution_<keyId>`, §13.2) is a declarative, auditable evolution of the old
key-push: one admin-signed document per key holds the authoritative `pushto` / `pullfrom`
lists and a version manifest, and every syncing client **reconciles** its KeyBag against
the directory head. A single unified dialog authors a distribution; the admin step and
the key-holder prepare step are the same form.

**Authoring (any user).** Pick a `keyId` (locked after first save), set title/comment,
and choose recipients. A key-versions section reads `createdAt` + `fingerprint` from the
caller's KeyBag (refreshable). If the current identity **holds** the key,
`wrapKeyForUserDevices(keyId, username)` RSA-OAEP-wraps **every** manifest version to
**each** of the recipient's active device encryption keys, producing the
`"<userHash>|<deviceFingerprint>" → { versionFingerprint → wrappedKey }` map; if not, the
versions are read-only and only **removal** (move to `pullfrom`) is possible.

**Finalize, two paths from the same form:**

1. **Has admin id + password** → `publishKeyDistribution(input, adminKey, adminPassword)`
   signs and upserts the `acl_keydistribution_<keyId>` document. The admin only ever
   handles the **wrapped** bytes — an admin outside the recipient set can never unwrap
   the key (admin-blind).
2. **No admin rights** → export the full unsigned document (incl. the locally wrapped
   material) as an `mdb://key-distribution/...` **request URI**
   (`encodeKeyDistributionRequest`). An admin imports it
   (`decodeKeyDistributionRequest`), reviews/edits, then signs and saves — letting a
   normal key-holder do the heavy lifting and hand a ready-to-sign request to the admin.

**Reconcile (every syncing client, after each directory pull and on bring-up; §13.4).**
A pure, idempotent function of (directory head cache, local bag). Driven from the cached
distribution state, matched against the user's `usernameHashCandidates`:

- **Me in `pullfrom`** → remove the whole key id from the bag via
  `removeNamedDecryptionKey(keyId)` (a no-op when absent; refuses the protected
  `default` / `$publicinfos` ids). This purges the local scope (plaintext + index
  tombstones) through the existing key-visibility machinery. Pull wins on any list
  overlap. (The revoke pass takes its key-id list straight from
  `getRevokedDecryptionKeyIdsForUser`, so it needs no per-doc scan or fingerprint diff.)
- **Me in `pushto`** → look up my `"<myHash>|<myDeviceFingerprint>"` entries, RSA-unwrap
  each version, **verify the bytes against the manifest fingerprint** (reject + log on
  mismatch), and merge the missing versions (idempotent, never destructive). This
  triggers the existing **reveal-on-add** path so newly readable documents surface.

Push is a version merge, never destructive; destruction happens only via explicit
`pullfrom`. Self-healing: a locally deleted pushed key is re-imported on the next
reconcile. `default` and `$publicinfos` are rejected as a distribution `keyId` at publish
time and guarded again in the client reconcile. Manual key sharing (`sharePassword`)
continues to work unchanged.

**Managed status is derived, not persisted:** a key id is *managed* iff its distribution
document exists at the local directory head and lists the user in `pushto`. The KeyBag
format is unchanged; clients compute the badge and the export/duplicate/rotation
guardrails from the directory. The guardrail is **UX-level only** — there is no
cryptographic way to stop a user who legitimately holds a key from exfiltrating it.

**Rotation is the only cryptographic cutoff.** The server blacklist (§13.3) withholds
*future* delivery, but a revoked-but-dishonest client that kept a key copy can still
decrypt
*new* ciphertext encrypted under a version it already holds. The cryptographic remedy is
to **rotate**: mint a new key version and distribute it to the remaining recipients only,
so future writes use a version the removed user never received. The authoring dialog
therefore offers "remove & rotate" as the default revocation gesture.

### 13.7 Public API additions

On `MindooTenantDirectory`:

- `wrapKeyForUserDevices(keyId, username) → { username_hash, devices }` (key-holder;
  wraps every manifest version to each of the user's active device encryption keys),
  `publishKeyDistribution(input, adminKey, adminPassword)` (admin-blind upsert of
  `acl_keydistribution_<keyId>`), `listKeyDistributions() → KeyDistributionView[]`
  (decrypts the `*_encrypted` blobs when the tenant key is held; null-tolerant),
  `deleteKeyDistribution(keyId, adminKey, adminPassword)`,
  `getManagedKeyIds() → string[]` (key ids the active user receives via `pushto` at
  head). The `mdb://key-distribution/...` request
  URI is built/parsed with `encodeKeyDistributionRequest` /
  `decodeKeyDistributionRequest`. The client reconcile is NOT a directory method:
  it runs only through `MindooTenant.reconcileKeyDistributionsForCurrentUser()`
  (below), which sources the RSA session key from the tenant itself (no foreign
  key crosses the directory API) — see §13.4.
- `getRevokedDecryptionKeyIdsForUser(username) → string[]` and
  `getRevokedDecryptionKeyIdsForSigningKey(signingKey) → string[]` — the per-user
  revoked-key set the server blacklist (§13.3) and the client revoke pass (§13.4) both
  read; derived from the cached `pullfrom` lists, protected ids excluded.

On `MindooTenant`:

- `setSessionEncryptionKey(cryptoKey)` (prime the session encryption key so reconcile's
  import pass can unwrap without a password), `reconcileKeyDistributionsForCurrentUser()`
  and its single-flight wrapper `reconcileKeyDistributionsForCurrentUserSafe()` (the
  SDK-driven driver, §13.4). Hosts persist the mutated bag by subscribing to
  `keyBag.onChanges`.

On `MindooDoc`:

- `isAccessible() → boolean` — `false` only for changefeed tombstones whose key the
  current KeyBag cannot resolve (§13.5); `isDeleted()` is also `true` in that case so
  legacy consumers still drop the doc.

Server wiring (`ServerNetworkContentAddressedStore` / `TenantManager`):
`ServerRevokedKeyResolver` + `buildRevokedKeyResolver()` plumb the revoked-key set into
the read/push handlers (skipped for the `directory` database).

`listRules` (the write-side listing, section 9) carries decrypted `targets`
(usernames/groups) for display.

## 14. Enterprise deployment guide and best practices

Sections 1–13 describe the *mechanism*. This section is *operational* guidance for
rolling the policy system out in a real, locked-down enterprise tenant. It introduces
no new primitives — it tells you which of the existing ones to reach for, in what
order, and which mistakes turn a strong design into a false sense of security.

### 14.1 The one rule that governs everything

Internalize the two-tier model (section 2) before you write a single policy, because
every good decision below follows from it:

> **Tier 1 is cryptographically enforced against everyone — including a tampered
> client. Tier 2 protects the integrity of your organization's data across every
> client that runs the official software, and contains, audits, and lets you reverse
> the rare violation.**

Both tiers are real protection; they simply do *different jobs*, because the
zero-trust server can never read document content.

| You want to guarantee… | Tier | Enforced by | What a tampered author can do |
|------------------------|------|-------------|-------------------------------|
| *who* may write (user/group/`$author`) | Tier 1 | server + crypto | nothing — the push is refused and cannot propagate |
| *which database* a write lands in | Tier 1 | server + crypto | nothing — refused at push |
| *which databases exist* (`databaseCreationPolicy`) | Tier 1 | server + crypto | nothing — refused at push |
| *who may read* a document | crypto | key possession | nothing — ciphertext is unreadable without the key (§13) |
| *what the content looks like* (`withfields`) | Tier 2 | every honest client, on receipt | author locally; **every honest client quarantines it on materialization**, so it never becomes visible, cascades to no dependents, is logged, and the author is revocable |

**What Tier 2 genuinely buys you.** A `withfields` violation is not "caught late" — it
is *never applied* by any honest client. On receipt the entry is routed to quarantine,
excluded from queries and from re-sync, and every change that causally depends on it is
quarantined too (section 10). Because the whole tenant is the official-app population,
this keeps the organization's shared, materialized state well-formed and authorized.
A malicious client's garbage stays inert in the append-only store, visible to no one,
surfaced in the quarantine/audit log, and the author can be cut off at Tier 1 by
revoking their keys. The blast radius is **bounded, isolated, auditable, and
reversible** — which is exactly the protection an organization wants.

**Where to reach for Tier 1 / key-scoping instead.** Two guarantees are *structurally*
outside what content rules can deliver, so model them at Tier 1:

- **Confidentiality.** Quarantine governs *writes/materialization*, not *reads*. "User
  X must never *read* Y" is a key-possession concern (section 13) — give X the key or
  not — never a `withfields` rule.
- **A guarantee the *server* must enforce, or that must hold even on the violator's own
  device.** The server cannot see content, so identity / database gates (Tier 1) are the
  lever — most powerfully by **scoping the encryption key** (section 14.4), the strongest
  control in the system.

A related subtlety to keep in mind when *designing create-time content rules*: a
`doc_create withfields` clause is evaluated against the "after" state, which is empty
for custom (fixed) document ids (their first change is a content-free convergence seed,
sections 9.1, 6.3). So create-time content validation belongs on generated-id documents
(`initialValues`) or on the first `changeDoc`; for fixed-id documents, gate creation by
identity and key (Tier 1) instead.

### 14.2 Bootstrap sequence (recommended order)

Set a tenant up once, in this order, so each step rests on the previous one:

1. **Publish to your server first.** The first push registers the server's signing
   key as a trusted witness (section 6.4). Without a witness there is no trusted time,
   and Tier 1's offline-clock guarantees (section 4) do not hold.
2. **Turn on strict mode and a tight clock-skew tolerance.** New tenants should start
   in strict mode (refuse pushes from clients that do not understand witness fields,
   section 12) with a conservative `skewToleranceMs` (section 4).
3. **Define groups and the identity model** (section 14.3) before rules, so rules can
   target groups rather than individuals.
4. **Create your encryption keys and key-distribution plan** (section 14.4) before
   data is written, because keys are hard to retrofit.
5. **Write the policies and rules**, starting from deny baselines per database
   (section 14.5), validating each with a dry run (section 14.9) before enforcing.
6. **Lock down database creation** with `databaseCreationPolicy: "directory-restricted"`
   (section 6.7) once you know which databases you need.
7. **Enable defense-in-depth re-checks** (`clientSideTier1Recheck`, section 4) for
   high-security tenants.
8. **Stand up your audit process** (section 14.10) so you can answer "who could do
   what, when" from day one.

### 14.3 Model identities with groups and the DN hierarchy

- **Target rules at groups, never individuals.** A rule keyed to `hashGroup("hr")`
  keeps working as people join and leave; a rule keyed to a person's hash rots. Group
  membership lives in directory documents that merge across offline edits, names are
  case-insensitive, and nested groups are expanded at evaluation time (section 8.1).
- **Use DN-style usernames and lean on wildcard variants.** `cn=alice/ou=ceo/o=acme`
  expands to `*/ou=ceo/o=acme`, `*/o=acme`, `*` (section 6.5). A single rule targeting
  `*/ou=finance/o=acme` then covers an entire org unit without enumerating members.
- **Least privilege by default.** Start every database from a deny baseline and grant
  narrow allow rules. Reserve broad allows (e.g. an "HR may change anything" escape
  hatch, section 11) for explicit supervisor groups, and keep them Tier 1.
- **Keep `$admin` rare.** Admin bypasses many checks; it is the root of trust, not an
  everyday role.

### 14.4 Make the encryption key the primary boundary (read *and* write)

Key scoping is the strongest control in the system because it is enforced by
cryptography and the server, not by client cooperation:

- **Use a named key (not the shared default) for sensitive databases.** Set a
  per-database `defaultCreateKeyId` to a named key with a narrower audience (section 6.6)
  and distribute it only to that audience, so the documents are unreadable to everyone
  else — the lever to reach for when a `withfields` create rule would be too weak
  (section 14.1).
- **One key per sensitivity domain.** Model "who can read what" as "who holds which
  key" — read access *is* key possession (section 13). Distributing a key (`pushto`)
  grants read; revoking it (`pullfrom` + rotation) removes it, and the server's
  per-user revoked-key blacklist (section 13.3) stops delivering that key's entries.
- **Distribute keys admin-blind.** Author an `acl_keydistribution_<keyId>` document
  (section 13.6) — directly with admin credentials, or by importing a key-holder's
  `mdb://key-distribution/...` request URI — so an admin can grant read access
  without ever seeing the key. Recipients reconcile it into their KeyBags on sync;
  revoke with `pullfrom` + rotation.
- **Set `defaultCreateKeyId` for ergonomics, not security.** It removes the hardcoded
  `"default"` fallback so app code need not pass a key (section 6.6), but the server
  never selects keys — key possession (distribution + rotation) is the authority.
- **Understand the revocation limits.** Read revocation is forward-looking: `pullfrom`
  drops the key from honest clients on reconcile (which forgets the now-inaccessible
  docs) and the server blacklist withholds future delivery, but a dishonest client that
  kept a key copy can still read *old* ciphertext under a version it already holds — so
  **rotate** to mint a version it never received, and remember history cannot be
  re-encrypted in place (section 13.1). Plan key boundaries up front rather than relying
  on after-the-fact revocation.

### 14.5 Write rules that hold under a malicious client

- **Express ownership with `$author`** (Tier 1) rather than an `owner` content field
  (Tier 2) wherever the model is "only the creator may change/delete" (section 6.3).
- **Rely on deny-overrides-allow** (section 7). It is order-independent (rules merge
  via Automerge), so a standalone `deny` rule is an effective, replica-safe kill
  switch for a user or group that no ordering of allows can resurrect.
- **Keep snapshot and purge admin-only** (their defaults, section 6.1). Loosen them
  only deliberately.
- **Use `withfields` to protect data integrity across the organization.** It greys out
  illegal edits in the UI (`canDo` / `canChange`, section 9.1) and quarantines both
  honest mistakes and a tampered client's content violations on receipt, so the shared
  state every honest client sees stays valid. Reserve Tier 1 / key-scoping for the two
  jobs content rules can't do — *confidentiality* and *server-enforced* invariants
  (section 14.1). Pair `withfields` with `clientSideTier1Recheck` where the *identity*
  decision should be double-checked too, remembering the re-check covers Tier 1 only.

### 14.6 Lock down which databases can exist

Once the database list is known, set `databaseCreationPolicy: "directory-restricted"`
with an explicit `allowedDbIds` on `acl_defaultpolicy` (section 6.7). This is enforced
both at the client open path and at the server sync choke point, with the admin
exempt. It is the difference between "anyone
can spin up an ungoverned database" and "only the databases we intended exist".

### 14.7 Server and witness trust

- **Run a witness you control** and add its key to the trusted-witness list; treat
  witness rotation as "add the new, drop the old" (section 6.4).
- **Dual-control is automatic:** a witness never stamps its own authored entries
  (section 5.1). Keep server signing keys and admin keys separate.
- **Receipt validation is on by default** (per-witness monotonicity + wall-clock
  sanity, section 5.4); do not disable it. A compromised witness that backdates
  `receivedAt` is the one thing that can subvert trusted-time, and these checks bound
  the damage.
- **p2p caveat:** with no server there is no inherently trusted witness (section 5.3).
  For serverless groups, either run a small witness peer the admin signed in, or accept
  that Tier 1 is enforced locally only.

### 14.8 Lifecycle runbook: onboarding, rollover, revocation, wipe

| Event | Action | Mechanism |
|-------|--------|-----------|
| New user / new device | `addUserKeys` (or the join-request flow) appends a key pair, optionally labeled | section 6.5 |
| Key rollover | append the new pair, then revoke the old | section 6.5 |
| Revoke a device | `updateUserGrant` moves the pair into `revokedUserKeyPairs` with `revokedAt` | section 6.5 |
| Fully offboard a user | revoke all pairs; they can rejoin later with fresh keys | section 6.5 |
| Stolen device | set `wipeRequestedForSigningKeys`; the device drops the whole local tenant on next connect | section 6.5 |
| Lose read access | move the user to `pullfrom` in `acl_keydistribution_<keyId>` and rotate; clients drop the key and forget its docs on reconcile, the server blacklist withholds them | sections 13.3, 13.4 |

Note that **revocation and wipe are independent and both opt-in** (section 6.5): removing
keys does not wipe a device, and wiping requires explicitly listing its signing key.

### 14.9 Roll out in stages: observe before you enforce

There is no built-in "report-only" mode, so simulate one:

1. **Author the policy but do not enable it.** Keep `deny*` flags off (or the master
   `disableAllAccessChecksAndPolicies: true`) while you validate.
2. **Dry-run the decisions.** Use `wasAllowedAt` / `canDo` (section 9) against real
   users, databases, and documents to confirm the verdicts match intent *before*
   flipping any deny flag.
3. **Enable per operation, per database.** Flip one `deny*` flag on one database, then
   watch the quarantine/audit log (section 10) for unexpected Tier 2 rejections.
4. **Keep the break-glass switch ready.** `disableAllAccessChecksAndPolicies: true`
   instantly short-circuits all checks *and* standalone deny rules (section 7), and the
   exact disabled window stays auditable through directory history. A baseline `deny*`
   flip alone does **not** neutralize standalone deny rules — use the master switch for
   a true emergency stop.

Because evaluation is pinned to each entry's trusted time (section 8), tightening a
policy never retroactively quarantines already-accepted history — so you
can ratchet restrictions up safely over time.

### 14.10 Audit and compliance

- **The directory history *is* the audit trail.** Every policy, rule, grant, and group
  is an append-only, admin-signed document; the trusted-time chain (section 8) lets you
  reconstruct the exact policy in force at any moment.
- **Answer point-in-time write questions directly** with `wasAllowedAt` — "could user X
  change this at time T?" — across the join → role-change → leave lifecycle (section 9).
  Read access is key possession, so "could X read this?" reduces to "did X hold the
  key then?": the `acl_keydistribution_<keyId>` history (its `pushto` / `pullfrom`
  revisions) is the auditable record (section 13).
- **Monitor the quarantine log** (section 10) for Tier 2 rejections; a spike often
  signals either an attack or a client/policy mismatch worth investigating.
- For regulated environments, plan for the optional `acl_audit_*` records (section 15)
  once they ship, or export the quarantine log on your own cadence.

### 14.11 Anti-patterns to avoid

- **Using a `withfields` rule for *confidentiality* or as a *server-side* gate.**
  Tier 2 protects organizational data integrity well (violations are quarantined on
  receipt), but it cannot keep data secret from a reader and the server cannot evaluate
  it. Put confidentiality and server-enforced invariants on Tier 1 / key-scoping
  (section 14.1).
- **Enabling ACL with no trusted witness.** Without witnessed trusted time, the
  offline-clock guarantees collapse to local-only enforcement.
- **Targeting rules at individual users.** They rot on personnel changes; target
  groups and DN wildcards instead.
- **Relying on the shared default key for sensitive data,** then trying to revoke read
  access later. History cannot be re-encrypted in place — scope keys up front.
- **Treating revocation as a wipe** (or vice versa). They are independent, opt-in
  actions.
- **Flipping `deny*` flags blind.** Always dry-run with `wasAllowedAt` / `canDo` first
  and watch the quarantine log after.
- **Assuming a per-database policy can gate database *creation*.** `databaseCreationPolicy`
  is tenant-level only (section 6.7); a per-db gate would be circular.

## 15. Open questions and future work

- **Multi-key user identities (full).** v1 enables key rollover via grant-doc key
  arrays and the join-request flow. A complete model (per-key revocation semantics,
  whether users may self-rotate without admin approval, device naming) is a separate
  proposal.
- **p2p witnessing.** Trusted witness peers / threshold witnessing for serverless
  groups.
- **Field-level read access.** Document- and key-level read control ships in section
  13 as **key possession** (a reader sees a document iff it holds a key that decrypts
  it). True *field*-level read control would require additional keying so different
  parts of one document can be encrypted with different keys. The intended **naming
  convention** (not yet implemented) extends the existing `<field>_encrypted` /
  `<field>_encrypted_key` pattern already used for `user_details_encrypted`
  (section 6.5): a sensitive field is stored as a `_encrypted` payload alongside a
  `_encrypted_key` field naming the key id it was encrypted with — for example
  `usernames_encrypted` + `usernames_encrypted_key`. This makes it explicit, per field,
  which key a reader needs, so a user without that key sees only ciphertext for that
  field while still reading the rest of the document — the key distribution for that
  field's key id then governs who can read it.
- **Declarative read expiry ("expires at T").** Deferred. If added, it must be enforced
  at the **server** against trusted server time, so the client evaluator stays
  clock-free; for now, scheduled expiry = an automation that flips the policy at T.
- **Regex / richer operators** in `withfields` (including time-based comparisons
  bound to the entry's trusted time) once the closed v1 set proves insufficient.
- **Independent directory timestamping witness** to further harden policy-history
  integrity against a single compromised witness (section 5.4).
- **Server-side audit docs.** Optional `acl_audit_*` directory entries (encrypted
  with `$publicinfos`) recording rejections for compliance, off by default.
