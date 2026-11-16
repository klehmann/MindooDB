# Invitation links and the join-request inbox

Getting a new person into a tenant used to take two hand-offs: the joining device produced a `mdb://join-request/...` URI, someone carried it to an admin (mail, chat, QR code), the admin approved it and either carried a `mdb://join-response/...` back or pushed the directory so the device could find its grant by **discovery**.

Invitations remove the first hand-off. An admin creates an invitation and sends each person a link. The person's device creates its keys, as before, and posts its join request to the server, where it lands in an inbox only admins can read. The admin opens the inbox, sees which requests match which people on the invitation list, and admits them in one go. The way back stays discovery.

What does **not** change:

- Key pairs are created on the joining device and never leave it.
- Only admins sign grants. The server stores requests; it cannot admit anyone.
- The server reads no tenant data: it sees the public part of an invitation and an outer envelope, never the request itself or the list of invited people.
- No grant-signing key is ever on the server or in a link.

## The pieces

| Piece | Where | Who can read it |
|---|---|---|
| Invitation `invite_<id>` | `directory`, encrypted with `$publicinfos` | public fields: every member and the server; the sealed part: admins only |
| Invitation key pair (RSA-OAEP 3072) | public half in the invitation, private half in its sealed part | requests are encrypted to it |
| Invitation list (first/last name, username, e-mail, sign-in, status, per-link nonce) | sealed part of the invitation | admins only |
| Join request `jr_<id>` | built-in database `joinrequests`, `$publicinfos` | admins only (read gate); inside it, the request itself only with the invitation key |

### The invitation

```text
invite_<id>  (directory, $publicinfos)
  invitationId, kind: "personal" | "open"
  publicKey, keyFingerprint            ← requests are encrypted to this key
  createdAt, expiresAt, maxUses?, ended
  nonceHashes[]                        ← one per personal link
  serverSigningPublicKey, serverUrl    ← the server that stores the requests
  sealed: { ciphertext, wraps: { <admin key fingerprint>: <RSA-wrapped AES key> } }
           └─ { privateKey, rows[], label }
```

`personal` invitations carry one row per person, each with a random 128-bit nonce. Only the hash of the nonce is public; the nonce itself is in the person's link and in the sealed list. `open` invitations have one shared link without a nonce, optionally capped by `maxUses` (distinct devices).

**Admin seal.** The sealed part is AES-256-GCM encrypted once and the AES key is wrapped to the RSA encryption key of every admin: the root admin key and every active delegated admin (docs/accesscontrol.md §6.13). An admin who is added later has no wrap yet; the next admin device that opens the invitations adds it (`resealInvitationsForAdmins`). The `directory` database can hold this because only the field is sealed: the document itself stays `$publicinfos`-encrypted, so the server can still read the public fields it needs to check requests. A sealed *document* (docs/userkeys.md) would have hidden those fields from the server as well, and admins are keys rather than persons with a User-Key, so document sealing would not address them anyway.

### The link

```text
https://<haven>/welcome/join#s=<server>&t=<tenantId>&i=<invitationId>&n=<nonce>&f=<keyFingerprint>&l=<tenant label>
```

Everything after `#` stays in the browser; the web server that serves Haven never sees it. `f` is the first 128 bits of SHA-256 over the invitation's public key. The joining device fetches the public part from the server (`GET /:tenantId/invitations/:invitationId`) and refuses to continue when the key does not match `f`: a server cannot hand out a key of its own and read the requests. Shared links have no `n`.

`l` is the tenant label for "Invitation to …" (optional, at most 80 characters). The real label is encrypted under `default`, which neither the joining device nor the server holds, so the admin's device puts it into the link. Being in the fragment, it never reaches the server. It is for display only: whoever forwards a link can change it, and nothing depends on it — the key fingerprint `f` is what protects the request.

### The request

The device builds its usual join request (`factory.createJoinRequest(user, { format: "uri" })`), then two envelopes:

- **Inner** (encrypted to the invitation key): the join-request URI, an optional message, and for personal links `hmac = HMAC-SHA256(nonce, hash(tenantId, invitationId, request))`. The field `proof` is reserved for stage 2 (an OIDC id token or a Domino proof of the invited sign-in).
- **Outer** (readable by the server): tenant, invitation, nonce hash, the device signing key, a timestamp and the sealed inner envelope, signed by the device key under the domain `mindoodb-joinrequest/v1`.

`POST /:tenantId/join-requests` checks, without reading tenant data:

- the invitation exists, is not ended or expired, and names this server,
- personal links: the nonce hash is on the invitation and not used by another device (one request per link; the same device may send again, and the newer request replaces the older),
- open links: `maxUses` distinct devices at most,
- the device signature and a clock skew of at most 15 minutes,
- body ≤ 16 KB, 5 requests per IP and hour, 500 pending requests per tenant, 10 000 on the server (configurable in `config.json` under `joinRequests`).

Proof-of-work for open links is not implemented; the IP and quota limits are the only brake for now.

The server then writes the outer envelope as `jr_<random>` into `joinrequests`, signed with its own identity key, with `status: "pending"` and an expiry of 14 days.

### Endpoints

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /:tenantId/invitations/:invitationId` | none | public part (key, kind, expiry, ended) |
| `POST /:tenantId/join-requests` | device signature in the body | store a request; returns `{ id, expiresAt }` |
| `GET /:tenantId/join-requests/:id` | none (the id is 128 random bits) | `pending`, `accepted`, `rejected`, `withdrawn`, `expired`, `replaced` or `unknown` |
| `POST /:tenantId/join-requests/:id/withdraw` | signature of the device that sent it | take the request back; the server purges it |
| `POST /:tenantId/join-requests/summary` | signature of a member device (active grant or admin key) | `{ pending }`, the number of open requests, for a "new requests" hint before an admin key is unlocked |

The status endpoint reports decisions for 30 days after the purge. It is a convenience for the waiting screen; the device learns that it is in from discovery.

## Why the server may write into a tenant database

`joinrequests` is a built-in database with a hard-wired rule (`builtinDbInvariants.ts`), enforced on the client write path, the client load path and the server push path:

| Operation | Allowed for |
|---|---|
| `doc_create` | a join-request server, and only for ids starting with `jr_` |
| `doc_change`, `doc_undelete` | tenant admins (root and delegated) |
| `doc_delete` | tenant admins and the join-request server |

Read and sync: tenant admins only, whatever a policy says. An admin device syncs it with the admin key (`connectToServer(..., { authAs })`); the root key authenticates by key even when the tenant was registered without an admin username.

**Which key is a join-request server?** A trusted witness of the tenant (§6.4), or the server an admin named in an invitation (`serverSigningPublicKey`). The first alone would have been enough, but making a server a trusted witness is a root-only act that most tenants never did, and delegated admins could not use invitations at all. Naming the server in the admin-signed invitation keeps the same property — only a server an admin chose can put requests into the inbox — without that prerequisite. The key is the server's identity key (the same one it stamps receipts with). The two uses cannot be confused: entries are signed over the entry layout (version byte first), receipts over their own layout, and the server only ever signs payloads it built itself. This trust is scoped to `joinrequests`; in every other database the server key is as untrusted as before.

## Deciding and purging

Requests are short-lived. Once an admin sets a status other than `pending` (`accepted`, `rejected`, `withdrawn`) and pushes it, the server purges the document physically (not just a delete) and records the id so a stale replica cannot upload it again. Expired requests are purged the same way when the server next looks at the inbox. The next inbox sync on an admin device notices that the server no longer holds the document and purges the local copy (`syncJoinRequestInbox`).

What survives a purge on the server is bookkeeping without content: which nonce hash was used by which device fingerprint, and how many devices used an open link (`<tenant>/join-requests.json`).

## API

All functions are exported from the package root.

### Admin

```ts
import {
  unlockInvitationAdmin, createInvitation, listInvitations, setInvitationRows,
  setInvitationRowStatus, endInvitation, resealInvitationsForAdmins, invitationLinkFragment,
  syncJoinRequestInbox, listJoinRequests, admitJoinRequests, setJoinRequestStatus,
} from "mindoodb";

const admin = await unlockInvitationAdmin(cryptoAdapter, adminIdentity, adminPassword);

const invitation = await createInvitation(tenant, admin, {
  kind: "personal",
  serverUrl: "https://sync.example.com",
  label: "Kollegium 2027",
  rows: [{ firstName: "Anna", lastName: "Muster", username: "Anna Muster/Schule", email: "anna@example.com" }],
});
// push `directory`, then send each row its link:
const link = `https://haven.example/welcome/join#${invitationLinkFragment(tenant.getId(), invitation, invitation.rows![0], {
  tenantLabel: "Schule am See",
})}`;

// later
await syncJoinRequestInbox(tenant, serverUrl, admin);
const items = await listJoinRequests(tenant, admin);
const matching = items.filter((item) => item.match === "match");
await admitJoinRequests(tenant, admin, matching, { serverUrl });
// push `directory` and `userdirectory`, then sync the inbox again so the decisions reach the server
await syncJoinRequestInbox(tenant, serverUrl, admin);
```

Usernames typed in abbreviated form (`Anna Muster/Schule`) are stored canonical (`cn=Anna Muster/o=Schule`).

`listJoinRequests` reports per request:

- `match: "match"` — personal link, the HMAC proves the link, `row` is the invited person. Safe to admit in bulk.
- `match: "unverified"` — open link. Compare `verificationCode` with the person before admitting.
- `match: "invalid"` — `problems` says why (`bad_link_proof`, `device_key_mismatch`, `unknown_invitation`, `cannot_decrypt`, …). `admitJoinRequests` refuses these.

`admitJoinRequests` calls the existing `approveJoinRequest` with the row's username (or the one in the request, or `usernames[docId]`), sets the request to `accepted` and the row to `admitted`.

### Joining device

```ts
import {
  parseInvitationLinkFragment, fetchInvitationForLink, submitJoinRequest,
  fetchJoinRequestStatus, withdrawJoinRequest,
} from "mindoodb";

const link = parseInvitationLinkFragment(location.hash)!;
const invitation = await fetchInvitationForLink(cryptoAdapter, link); // throws on key mismatch
const { id, expiresAt, verificationCode } = await submitJoinRequest(cryptoAdapter, {
  link,
  invitation,
  joinRequestUri: factory.createJoinRequest(user, { format: "uri" }),
  deviceSigningKey,
});
// then poll discovery (below)
```

## Discovery: the way back

Discovery (`factory.discoverTenantsOnServer` + `bootstrapTenantFromDelivery`) is unchanged and is how an admitted device learns that it is in:

- **Register as often as you like.** Discovery proves possession of the device signing key and lists every tenant on that server with a grant for it. A device that sent requests to several tenants finds each one as it is admitted.
- **The first device of a person gets `default` immediately.** The join request carries the person's User-Key (`userPublicKey`); approving it publishes the pending `userkey_*` document and wraps `default` to it, so the device can read the tenant as soon as it bootstraps.
- **Further devices of the same person wait for one of their own devices.** Only the owner can wrap their User-Key to a new device (docs/userkeys.md). Until one of the person's existing devices is online and approves, the new device sees the directory but not `default`.

A device that has sent a request polls discovery (Haven: every 15 s for 5 minutes, then every minute, then on each app start) until the tenant shows up or the request expires.

## Stage 2 (not implemented)

- `proof` in the inner envelope: an OIDC id token (`entra`, `email`) or a Domino proof that the requester owns the invited sign-in; the admin side checks it against `loginType`/`loginValue` of the row.
- Proof-of-work for open links.
- Sending invitation links through a mail account in Haven.
