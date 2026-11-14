/**
 * Store-level admin-key resolution for the `directory` database
 * (docs/accesscontrol.md §6.13).
 *
 * The directory's own load path has to decide whether an entry signed by a
 * delegated admin key counts, and it cannot ask the materialized directory
 * (that would recurse into the very load being decided). Admin-key and
 * trusted-witness documents are root-only, so their history can be read
 * straight from the store: the entries of `acl_adminkey_<fingerprint>` (or
 * `acl_trustedwitness_<fingerprint>`) signed by the root key, decrypted and
 * replayed in trusted-time order. Nothing a delegated admin wrote can influence
 * the answer.
 *
 * Rules for an entry signed by a delegated admin key:
 * 1. Never for a root-only document (admin keys, trusted witnesses).
 * 2. With a witness receipt: the witness must be trusted at `receivedAt`, the
 *    receipt signature must verify, and the key must be an admin at
 *    `receivedAt`.
 * 3. Without a receipt: only when the key is one this process signs with (the
 *    entry was written here and is waiting to be pushed); judged at "now".
 *    Elsewhere such entries do not count — a P2P copy or an offline write
 *    with a backdated `createdAt` never makes it in.
 */
import { Automerge } from "../automerge-adapter";
import type { StoreEntry, StoreEntryMetadata } from "../types";
import type { ContentAddressedStore } from "../appendonlystores/types";
import { signingKeysEqual } from "./DirectoryStateNode";
import {
  ACL_TRUSTED_WITNESS_DOC_PREFIX,
  AdminKeyRevision,
  type AdminKeySnapshot,
  aclAdminKeyDocIdForKey,
  adminKeySnapshotAt,
  isAdminKeySnapshotValidAt,
  isRootOnlyDirectoryDocId,
} from "./adminKeys";
import { encodeAclIdComponent } from "./types";
import { Ed25519WitnessProvider } from "./timestamp/Ed25519WitnessProvider";
import { verifyEntrySignatureCrypto } from "../crypto/EntrySignature";

const DOC_ENTRY_TYPES = new Set(["doc_create", "doc_change", "doc_snapshot", "doc_delete", "doc_undelete"]);

export interface DirectoryAdminResolverDeps {
  store: ContentAddressedStore;
  /** The tenant's root admin key (`administrationPublicKey`). */
  rootAdminKey: () => string;
  decryptPayload: (encrypted: Uint8Array, keyId: string) => Promise<Uint8Array>;
  subtle: SubtleCrypto;
  /** Whether this process signs with `signingKey` (its writes may be un-witnessed). */
  isLocalSigningKey: (signingKey: string) => boolean;
  /** Wall clock (ms). */
  now?: () => number;
}

/** Outcome of judging one directory entry. */
export interface DirectoryAdminDecision {
  allowed: boolean;
  reason: string;
  /** The time the decision was taken at (witness time, or now for own entries). */
  at?: number;
}

interface CachedRevisions {
  knownIds: Set<string>;
  revisions: AdminKeyRevision[];
}

export class DirectoryAdminKeyResolver {
  private readonly cache = new Map<string, CachedRevisions>();
  private readonly inFlight = new Map<string, Promise<AdminKeyRevision[]>>();

  constructor(private readonly deps: DirectoryAdminResolverDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** Drop cached revisions (e.g. after a purge rewrote history). */
  clear(): void {
    this.cache.clear();
  }

  /** Whether `signingKey` is a delegated admin at `T` (the root is not checked here). */
  async isDelegatedAdminAt(signingKey: string, T: number): Promise<boolean> {
    const docId = await aclAdminKeyDocIdForKey(signingKey, this.deps.subtle);
    const revisions = await this.revisionsFor(docId);
    const snapshot = adminKeySnapshotAt(revisions, T);
    return (
      !!snapshot &&
      signingKeysEqual(snapshot.signingPublicKey, signingKey) &&
      isAdminKeySnapshotValidAt(snapshot, T)
    );
  }

  /** The delegated admin-key snapshot of `signingKey` valid at `T`, or null. */
  async delegatedAdminKeyAt(signingKey: string, T: number): Promise<AdminKeySnapshot | null> {
    const docId = await aclAdminKeyDocIdForKey(signingKey, this.deps.subtle);
    const snapshot = adminKeySnapshotAt(await this.revisionsFor(docId), T);
    if (!snapshot || !signingKeysEqual(snapshot.signingPublicKey, signingKey)) return null;
    return isAdminKeySnapshotValidAt(snapshot, T) ? snapshot : null;
  }

  /** Whether the root ever wrote an admin-key document for `signingKey` (active or not). */
  async hasAdminKeyDocument(signingKey: string): Promise<boolean> {
    const docId = await aclAdminKeyDocIdForKey(signingKey, this.deps.subtle);
    return (await this.revisionsFor(docId)).length > 0;
  }

  /** Whether `signingKey` is the root or a delegated admin at `T`. */
  async isAdminAt(signingKey: string, T: number): Promise<boolean> {
    if (signingKeysEqual(signingKey, this.deps.rootAdminKey())) return true;
    return this.isDelegatedAdminAt(signingKey, T);
  }

  /** Whether `witnessPublicKey` is a trusted witness at `T` (root-written document present). */
  async isTrustedWitnessAt(witnessPublicKey: string, T: number): Promise<boolean> {
    const digest = await this.deps.subtle.digest("SHA-256", new TextEncoder().encode(witnessPublicKey));
    const fingerprint = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const revisions = await this.revisionsFor(ACL_TRUSTED_WITNESS_DOC_PREFIX + encodeAclIdComponent(fingerprint));
    let current: AdminKeyRevision | null = null;
    for (const revision of revisions) {
      if (revision.trustedTime > T) continue;
      if (!current || revision.trustedTime >= current.trustedTime) current = revision;
    }
    return (
      !!current?.data &&
      current.data.type === "trustedwitness" &&
      typeof current.data.witnessPublicKey === "string" &&
      signingKeysEqual(current.data.witnessPublicKey, witnessPublicKey)
    );
  }

  /**
   * Judge one entry of the `directory` database signed by `entry.createdByPublicKey`.
   * Root entries are always allowed (unchanged behavior).
   */
  async judgeEntry(
    entry: Pick<
      StoreEntryMetadata,
      | "id"
      | "docId"
      | "entryType"
      | "contentHash"
      | "decryptionKeyId"
      | "createdAt"
      | "createdByPublicKey"
      | "receivedAt"
      | "receivedByPublicKey"
      | "receivedDateSignature"
      | "receiptScheme"
    >,
    options: { dbid: string; allowLocalUnwitnessed?: boolean },
  ): Promise<DirectoryAdminDecision> {
    const signer = entry.createdByPublicKey;
    if (signingKeysEqual(signer, this.deps.rootAdminKey())) {
      return { allowed: true, reason: "root admin key" };
    }
    if (isRootOnlyDirectoryDocId(entry.docId)) {
      return { allowed: false, reason: `only the root admin key may write ${entry.docId}` };
    }
    const hasReceipt =
      entry.receivedAt !== undefined && !!entry.receivedByPublicKey && !!entry.receivedDateSignature;
    if (hasReceipt) {
      const receivedAt = entry.receivedAt!;
      const witness = entry.receivedByPublicKey!;
      if (!(await this.isTrustedWitnessAt(witness, receivedAt))) {
        return { allowed: false, reason: "receipt from a witness that is not trusted at receivedAt", at: receivedAt };
      }
      const verifier = new Ed25519WitnessProvider({ subtle: this.deps.subtle }).createVerifier();
      const receipt = await verifier.validate(entry as StoreEntryMetadata, {
        dbid: options.dbid,
        trustedWitnessKeys: new Set([witness]),
        nowMs: this.now(),
      });
      if (!receipt.ok) {
        return { allowed: false, reason: receipt.reason ?? "invalid witness receipt", at: receivedAt };
      }
      const admin = await this.isDelegatedAdminAt(signer, receivedAt);
      return admin
        ? { allowed: true, reason: "delegated admin at the witness time", at: receivedAt }
        : { allowed: false, reason: "signing key is not an admin at the witness time", at: receivedAt };
    }
    if (options.allowLocalUnwitnessed !== false && this.deps.isLocalSigningKey(signer)) {
      const at = this.now();
      const admin = await this.isDelegatedAdminAt(signer, at);
      return admin
        ? { allowed: true, reason: "own delegated-admin entry waiting for a witness", at }
        : { allowed: false, reason: "signing key is not an admin now", at };
    }
    return { allowed: false, reason: "delegated-admin entry without a witness receipt" };
  }

  /** Root-signed revisions of one root-only document, oldest first. */
  private revisionsFor(docId: string): Promise<AdminKeyRevision[]> {
    const pending = this.inFlight.get(docId);
    if (pending) return pending;
    const run = this.loadRevisions(docId).finally(() => this.inFlight.delete(docId));
    this.inFlight.set(docId, run);
    return run;
  }

  private async loadRevisions(docId: string): Promise<AdminKeyRevision[]> {
    const cached = this.cache.get(docId);
    const knownIds = cached ? [...cached.knownIds] : [];
    const fresh = await this.deps.store.findNewEntriesForDoc(knownIds, docId);
    if (cached && fresh.length === 0) return cached.revisions;

    const known = new Set(knownIds);
    for (const meta of fresh) known.add(meta.id);
    const all = await this.deps.store.findNewEntriesForDoc([], docId);
    const root = this.deps.rootAdminKey();
    const candidates = all
      .filter((meta) => DOC_ENTRY_TYPES.has(meta.entryType) && signingKeysEqual(meta.createdByPublicKey, root))
      .sort((a, b) => {
        const ta = a.receivedAt ?? a.createdAt;
        const tb = b.receivedAt ?? b.createdAt;
        if (ta !== tb) return ta - tb;
        if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
        return a.id.localeCompare(b.id);
      });
    const entries = candidates.length > 0 ? await this.deps.store.getEntries(candidates.map((m) => m.id)) : [];
    const byId = new Map(entries.map((e) => [e.id, e]));

    const revisions: AdminKeyRevision[] = [];
    let doc = Automerge.init<Record<string, unknown>>();
    let deleted = false;
    for (const meta of candidates) {
      const entry = byId.get(meta.id);
      if (!entry) continue;
      if (!(await this.verifyRootEntry(entry))) continue;
      let bytes: Uint8Array;
      try {
        bytes = await this.deps.decryptPayload(entry.encryptedData, entry.decryptionKeyId);
      } catch {
        continue;
      }
      try {
        if (meta.entryType === "doc_snapshot") {
          doc = Automerge.load<Record<string, unknown>>(bytes);
        } else {
          [doc] = Automerge.applyChanges(doc, [bytes]);
        }
      } catch {
        continue;
      }
      if (meta.entryType === "doc_delete") deleted = true;
      if (meta.entryType === "doc_undelete" || meta.entryType === "doc_create") deleted = false;
      const data = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
      revisions.push({ trustedTime: meta.receivedAt ?? meta.createdAt, data: deleted ? null : data });
    }
    this.cache.set(docId, { knownIds: known, revisions });
    return revisions;
  }

  /** The root's signature must verify; a forged "root" entry from a peer is ignored. */
  private async verifyRootEntry(entry: StoreEntry): Promise<boolean> {
    try {
      return await verifyEntrySignatureCrypto(entry, entry.encryptedData, entry.createdByPublicKey, this.deps.subtle);
    } catch {
      return false;
    }
  }
}
