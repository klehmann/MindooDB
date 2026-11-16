# Account Recovery

What happens when a person loses every device that holds their User-Key, which ways back MindooDB offers, how each one works, and — above all — why they are built the way they are.

This document is the overview and the design rationale. The protocol details, document schemas and API live in [userkeys.md](userkeys.md) §12 (recovery contacts, paper rescue devices, admin approval) and §9 (device self-grant, device certificates, cloned identities).

---

## 1) The problem

A person's User-Key (userkeys.md §1) is what opens their sealed documents, their personal data and every named key distributed to them, `default` included. Its private half exists only as wraps to the person's approved devices. The server never holds it, the administrator never holds it, and nothing derives it from a password. That is the point of the design — and it means that **a person who loses every device loses the key**, unless a way back was prepared while a device still existed.

A way back is necessarily a second copy of access to the User-Key, kept somewhere else. Every recovery mechanism is therefore a trade-off between *who can use it* and *who must cooperate to abuse it*. MindooDB offers the following, all opt-in:

| Way back | Who must cooperate to use it | Prepared with |
|---|---|---|
| **Recovery contacts** | any 2 of the n colleagues the person picked | Preferences → User ids → Recovery contacts |
| **Paper rescue device** | whoever holds the printed sheet and knows the answer to its secret question | Backup → Recovery printout |
| **Legacy printout** (before paper rescue devices) | as above, but the sheet is a clone of a device | older Haven versions; still restorable |
| **Encrypted backup file** | whoever holds the file and its password | Backup → encrypted backup (a clone, like the legacy printout) |
| Another own device | the person | device pairing (userkeys.md §9.6) |

Each of the first two exists in two variants, depending on whether the person has **device self-grant** (userkeys.md §9.4):

- **with self-grant**: the person's own devices certify the rescue device and, on recovery, the rescue device certifies the new device. No administrator is involved at any point.
- **without self-grant**: the administrator puts the rescue device on the person's grant once, and on recovery approves the new device, exactly like approving any additional device. The administrator still learns nothing and gains nothing (§4.3).

---

## 2) The common building block: the rescue device

Recovery contacts and the paper sheet are two front ends for the same mechanism, the **rescue device**.

A rescue device is an ordinary device of the person — an Ed25519 signing key and an RSA-OAEP 3072 encryption key — that **no hardware holds**. It is admitted like a real device (certified with the self-grant key, or put on the grant by the administrator), so it receives a wrap of every User-Key generation and of the self-grant key, and `rotateUserKey()` keeps wrapping it. A rescue device therefore never goes stale.

Its private keys exist in exactly one form:

```
rescue blob = AES-256-GCM( K, Ed25519 seed ‖ RSA prime p ‖ RSA prime q )
K           = 32 random bytes
```

What is stored where:

| Item | Where | Readable by |
|---|---|---|
| Public keys of the rescue device, how it was admitted (`certificate` / `admin`), attestation | `rcv_` / `rpp_` document in `userdirectory` | every tenant member (tenant `default` key); not the server |
| Rescue blob (private keys, encrypted with K) | recovery contacts: in the `rcv_` document; paper: only on the sheet | the blob alone opens nothing |
| K | contacts: split 2-of-n with Shamir, one share sealed to each contact's User-Key; paper: on the sheet, which is encrypted with the answer to its secret question | 2 contacts together, or sheet + answer |
| Certificate or grant entry of the rescue device | `dcert_` document / grant | members and the server, as for any device |

So nothing secret is stored in the clear anywhere, and no single place — not the server, not the `userdirectory`, not one contact, not the sheet without its answer — is enough to open the rescue device.

---

## 3) The variants step by step

### 3.1 Recovery contacts, with self-grant

**Setup** (person's device, no interaction with the contacts):
1. Pick n ≥ 2 contacts. Haven shows how long each account has existed and flags new accounts and duplicate names (§5.5).
2. Generate the rescue device and K; certify the rescue device with the self-grant key.
3. Split K 2-of-n; seal each share to the contact's current User-Key.
4. Publish the `rcv_` document (public keys, blob, sealed shares). Contacts see in their settings that they were picked.

**Recovery**:
1. Two contacts each press *Help with recovery*. Their device opens their share and builds a package (`mdbrescue1.…`, QR/text/file) encrypted with a one-time password shown separately.
2. On the new device: enter both packages and passwords. Haven combines K, opens the rescue device **in memory only**, signs in to the server *as the rescue device* and certifies **fresh keys of the new device**.
3. The new device joins like any certified device and opens the User-Key from its own wrap.
4. Haven renews the setup automatically: a new rescue device and new shares for the same contacts; the used rescue device is withdrawn at once.

### 3.2 Recovery contacts, without self-grant

As 3.1, except:
- **Setup**: instead of certifying, the person's device shows a join request for the rescue device. The administrator grants it under the person's name (Haven recognises it as "rescue device of …"). The person's next sync wraps the User-Key to it without asking, because its `rcv_` document is attested with the person's User-Key (§5.7).
- **Recovery**: the new device sends a normal join request and waits. Once the administrator approved it, the rescue device (opened in memory) wraps the User-Key to it. Renewal then creates a new rescue device that again waits for the administrator, and Haven lists the used rescue device for the administrator to remove. **Until the administrator removes it, the used packages keep working** (§6).

### 3.3 Paper rescue device

**Printing**: for a person who may add their own devices and whose tenant has a server, the sheet carries a paper rescue device of its own — independent of the contacts' one — plus the tenant's document keys. The sheet is encrypted with the answer to its secret question and split into erasure-coded QR codes. A new printout withdraws the person's previous paper rescue device, so only the newest sheet works. The tenant keeps the public half in an `rpp_` document.

**Restoring**: Haven creates a new user id on this device (unlocked with the answer, changeable later), opens the rescue device in memory, certifies the new device's fresh keys (without self-grant: waits for the administrator, as in 3.2) and attaches the tenant with its server and sync setup from the sheet.

**Lifetime**: the sheet stays valid after use, like a printout in a drawer. It is retired by printing a new one (or by `removePaperRescueDevices()`).

### 3.4 Fallbacks and legacy

- **Admin ids** are printed as copies of the identity, as before: an admin key cannot be "rescued" by the self-grant key or approved by itself.
- **Tenants without a server**, and devices on an older MindooDB, fall back to printing a copy of the device identity.
- **Legacy printouts** (made before paper rescue devices) and **encrypted backups** restore a **clone of the device**: same keys, same identity. They keep working, but see §5.1 for why a clone is the weaker option.

### 3.5 When each rescue device expires

| Rescue device | Withdrawn when |
|---|---|
| Contacts, with self-grant | the person renews or removes the contacts (automatically after every recovery) |
| Contacts, without self-grant | the administrator removes it from the grant (Haven asks for this after renewal and after a recovery) |
| Paper | a new printout is made, or `removePaperRescueDevices()` |
| Any | the administrator revokes it on the grant; or the person's self-grant is revoked (stops new certificates) |

---

## 4) What each party can see and do

| Party | Sees | Can do alone |
|---|---|---|
| Sync server | ciphertext; certificates and grant entries of rescue devices | nothing: holds no share, no K, no answer |
| Administrator | that a person has recovery contacts or a paper rescue device, and (as a member) who the contacts are | nothing; without self-grant they also approve rescue and new devices, which yields no key |
| One contact | their own share | nothing: one share is uniformly random |
| Two contacts together | K, hence the rescue device | everything the person can do: read, write, act in their name (§6) |
| Finder of a sheet | the encrypted sheet and its printed question | must guess the answer; each guess costs PBKDF2 |

---

## 5) Design rationale

### 5.1 After a recovery: fresh device keys, never the rescue device

The obvious shortcut would be to keep working with the rescue device's keys once they are open. We deliberately do not, and recovery always ends with **fresh keys generated on the new device**, admitted by the rescue device (certificate) or by the administrator (grant) and then given the User-Key. The rescue device is only the bridge.

1. **After a recovery the rescue key is no longer a secret of one device.** It was reconstructed from material that travelled: two packages that went by mail, chat or a photo of a screen, with passwords told over the phone; or a sheet and its answer. Anyone who kept copies can reconstruct it again, at any time, without anybody noticing. A working device built on that key would have invisible twins forever.
2. **A clone cannot be told apart and cannot be cut off alone.** As userkeys.md §9.5 explains for restored backups, devices sharing keys share an identity: their writes carry the same `createdByPublicKey`, per-device records overwrite each other, and revoking or wiping the key hits every copy. With a fresh key, the new device is a device of its own, and the rescue device can be withdrawn without touching it.
3. **Used means burned.** A rescue path that has been exercised has been exposed. Recovery contacts are therefore renewed automatically right after a recovery — new rescue device, new K, new shares — and the used rescue device is withdrawn. Only a fresh device key lets us do that without pulling the floor from under the device that was just recovered: rescue path and working device are renewed independently.
4. **For paper, "sheet = device" would be fatal.** If the restored device used the sheet's keys, everybody who ever finds the sheet would *be* that device, permanently, and replacing the sheet would mean replacing the device. With a separate rescue device the sheet stays a pure way back that a new printout retires.
5. **Recoveries remain visible.** The new device appears as its own device: a certificate *issued by the rescue device*, or a grant entry the administrator approved. Other devices of the person and the administrator can see that and when a recovery took place (`listRescueDeviceSigningKeys()`), and revoke individual devices.

The cost is one extra admission step: automatic with self-grant, an administrator approval without it. We considered letting the new device work temporarily *as* the rescue device until the administrator approves its own keys, to avoid the wait. It was rejected: for that period the device would have all the clone problems above, the shortcut would have to be undone reliably afterwards, and waiting for an administrator who has to act anyway is acceptable.

### 5.2 Why no recovery phrase and no server-side key escrow

- **A phrase that derives keys** (or decrypts a server-stored copy) turns recovery into a single secret the person must keep for years. It is either weak (memorable) or stored somewhere (a password manager on a device that is also lost). Whoever learns it alone becomes the person, silently. Rescue devices split that power (two contacts) or bind it to a physical object plus a question (paper).
- **Storing a recoverable copy on the server** would make the server a target holding everyone's keys under some secret, which contradicts the threat model (userkeys.md §8: the server is not trusted with plaintext or keys). The `rcv_` document holds only material that is useless without K, and the paper blob is not stored in the tenant at all.

### 5.3 Why no administrator recovery

Administrators are deliberately not trusted with content (userkeys.md §8.2, "There is no administrator recovery"). Escrow to an administrator, or to a quorum the administrator controls, would make every admin account a master key for every person. In MindooDB the administrator decides **who belongs** (grants, approvals) but never **what they can read**. Even in the variant without self-grant, the administrator's approvals only put devices on the grant; the User-Key reaches them solely from the rescue device, which the administrator cannot open.

### 5.4 Why Shamir, and why fixed at 2-of-n

- **Shamir** gives information-theoretic hiding: one share reveals nothing about K, and any two give it back exactly. Shares are tiny, so packages fit a QR code. The implementation is a small GF(256) one using the share layout of the audited `shamir-secret-sharing` package (cross-checked against it), with randomness from the `CryptoAdapter`.
- **Threshold 2, always.** One would be no protection at all (any single contact could take over). Three or more makes recovery fail exactly when it is needed: someone is on holiday, has left, has lost their own device. Two is the smallest number at which nobody can act alone, and n ≥ 2 contacts let the person tolerate unavailable contacts by naming more of them. A configurable threshold was left out to keep the security statement simple enough to explain in one sentence: *any two of these people together can become you.*

### 5.5 Why no key comparison when picking contacts

Sealing a share to a contact uses the contact's *published* User-Key, whose authenticity rests on the grant binding of userkeys.md §7.3. An extra out-of-band fingerprint comparison per contact would add a ceremony people skip. The realistic attack at this point is social — a freshly created look-alike account ("Ada Lovelace", created yesterday) — so the picker addresses that instead: manual selection only (no suggestions), the age of each account, and warnings for new accounts and duplicate display names. The consent text states the consequence plainly.

### 5.6 Why the package password is separate and one-time

A helper package contains a share and the encrypted rescue device. It is encrypted with a fresh one-time password (about 59 bits, no look-alike characters) that Haven shows separately, so the package can travel over a convenient channel (mail, chat, file) while the password travels another way (phone, in person). A leaked package alone gives nothing; a leaked package with its password gives one share, still nothing. The helper is also asked to confirm they spoke to the person themselves, because the main attack on contacts is impersonating the person who "lost their phone".

### 5.7 Why rescue devices are attested with the User-Key

Without self-grant, a rescue device is admitted by the administrator and then must receive the User-Key from the person's device **without a dialog** — otherwise the person would be asked to approve a device they cannot recognise. But "a device on my grant that I did not approve" is exactly what userkeys.md §4.7 forbids wrapping to automatically: the administrator could have planted it.

The `rcv_`/`rpp_` document therefore carries an **attestation**: a signature over the rescue device's public keys, made with the generation signing key of the person's current User-Key (userkeys.md §9.2). Only a holder of the User-Key can produce it. A device the administrator plants can write an `rcv_` document under the person's name (any device on the grant can), but not the attestation, so the person's devices never wrap to it.

The same check guards readers. Without it, a planted device could publish a forged `rcv_` that contacts would take for the person's newest setup. Every reader — the person, the contacts and the administrator's views — accepts a setup only if its rescue device is attested by the person's published User-Key (admin variant) or currently certified with the self-grant key (self-grant variant).

### 5.8 Why `rcv_` uses the tenant `default` key

Contacts must read the document to find their share; the recovering device never needs it (everything travels in the packages or on the sheet). `$publicinfos` would let the hosting server learn who vouches for whom, which is not its business — the same reasoning as for `dev_` and `qtn_` records (userkeys.md §7.6).

---

## 6) Limits

- **Two contacts can combine their shares without the person noticing beforehand.** That is the feature, not a flaw: two of the people named can become the person. Using the result is visible — a new device appears, certified by the rescue device or approved by the administrator — but the combination itself is not. Pick contacts accordingly and renew them when the team changes.
- **Without self-grant, used packages work until the administrator removes the used rescue device.** Haven tells the person which fingerprints to ask the administrator to remove, and the renewed setup lists earlier rescue devices still on the grant. Rescue devices certified with self-grant are withdrawn by the person's own device immediately.
- **A paper sheet is valid until replaced**, including after it was used. A sheet that may have been seen should be replaced by printing a new one.
- **A contact who has lost their own keys cannot help**, and a contact who left the tenant but kept a device still holds a share. Two shares remain necessary, so one departure does not matter; renew the contacts when people leave.
- **Legacy printouts and backup files are clones** of a device (§5.1, userkeys.md §9.5): revoking or wiping that device revokes the restored copy too, and a stolen copy cannot be cut off alone.
- **Losing everything without any prepared way back is still final** for content encrypted to the lost User-Key generations (userkeys.md §7.4).

---

## 7) Related documents

- [userkeys.md](userkeys.md) §12 — recovery contacts, paper rescue devices and admin approval: schemas, API, tests; §9 — device self-grant, signed generations, device certificates, cloned identities.
- [accesscontrol.md](accesscontrol.md) — grants, administrators and revocation.
- [haven-handbook.md](haven-handbook.md) — how the recovery options look in Haven.
