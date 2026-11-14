import type { CryptoAdapter } from "../crypto/CryptoAdapter";
import { entryTrustedTime } from "../storeEntryTime";
import type { MindooDB, StoreEntryMetadata } from "../types";
import { normalizePublicKeyPem } from "./fingerprint";
import {
  generationValueKey,
  userKeyGenerationSigningMessage,
  verifyEd25519,
} from "./generationSignature";
import type { UserKeyDocumentPayload, UserKeyGeneration } from "./types";

/**
 * Which User-Key generations count (docs/userkeys.md §9.3).
 *
 * Anyone on a person's grant may change their User-Key document, including a
 * device the person never approved. A generation therefore only counts when
 * one of these holds for the change that gave it its current value
 * (`publicKey` + `signingPublicKey`):
 *
 * 1. **Root:** the value was already in the document's `doc_create`. Only the
 *    admin (from the join request) or the person may create it.
 * 2. **Signed:** a signature over the generation verifies with the person's
 *    device self-grant key from their admin-signed grant (not revoked at that
 *    trusted time), or with the `signingPublicKey` of the previous accepted
 *    generation.
 * 3. **Adoption:** the lowest epoch was replaced while the document had no
 *    device wraps at all (a pending document nobody could use yet), signed by
 *    its own new `signingPublicKey`.
 * 4. **Legacy:** the change's trusted (witness) time is before the cutoff.
 *    The cutoff is the earlier of the tenant's
 *    `requireUserKeyGenerationSignatureSince` and the person's
 *    `deviceSelfGrant.grantedAt`. Without either, every generation counts, as
 *    before.
 *
 * When the current value of an epoch does not count, an earlier value of the
 * same epoch that did count is used instead, so overwriting a generation in
 * place cannot take it away from its owner either.
 */

export interface GenerationValidityPolicy {
  usernameHash: string;
  /** Trusted time from which unsigned generations stop counting. */
  cutoff?: number;
  /** The person's admin-granted self-grant key. */
  selfGrant?: { signingPublicKey: string; revokedAt?: number } | null;
}

/** One value an epoch had, as first set by one change. */
export interface GenerationVersion {
  valueKey: string;
  /** The generation object as of that change. */
  generation: UserKeyGeneration;
  trustedTime: number;
  /** Set by the document's `doc_create`. */
  isCreate: boolean;
  /** The document had no device wrap in any generation right before. */
  pendingBefore: boolean;
}

export type GenerationHistory = Map<string, GenerationVersion[]>;

interface CacheEntry {
  stamp: string;
  history: GenerationHistory;
}

const historyCache = new WeakMap<object, Map<string, CacheEntry>>();

function hasAnyWrap(payload: Partial<UserKeyDocumentPayload> | null | undefined): boolean {
  for (const gen of Object.values(payload?.userKeys ?? {})) {
    if (Object.keys(gen?.deviceWraps ?? {}).length > 0) return true;
  }
  return false;
}

/**
 * Record, per epoch, each distinct value with the trusted time of the change
 * that introduced it. Works on the signed change DAG: for every entry the
 * state at its parents is compared with the state at the entry, so a change
 * with a backdated `createdAt` cannot pose as part of the create. Cached per
 * database and document until the document gains entries.
 */
export async function loadGenerationHistory(
  db: MindooDB,
  docId: string,
): Promise<GenerationHistory> {
  const metas: StoreEntryMetadata[] = await db.getStore().findNewEntriesForDoc([], docId);
  const ids = metas.map((m) => m.id).sort();
  const stamp = `${ids.length}:${ids.join(",").length}:${ids[ids.length - 1] ?? ""}`;
  let perDb = historyCache.get(db);
  if (!perDb) {
    perDb = new Map();
    historyCache.set(db, perDb);
  }
  const cached = perDb.get(docId);
  if (cached && cached.stamp === stamp) return cached.history;

  const now = Date.now();
  const history: GenerationHistory = new Map();
  const stateCache = new Map<string, Partial<UserKeyDocumentPayload> | null>();
  const stateAt = async (heads: string[]): Promise<Partial<UserKeyDocumentPayload> | null> => {
    if (heads.length === 0) return null;
    const key = [...heads].sort().join(",");
    if (stateCache.has(key)) return stateCache.get(key)!;
    const result = await db.materializeDocumentAtHeads(docId, heads);
    const data = result ? (result.doc.getData() as Partial<UserKeyDocumentPayload>) : null;
    stateCache.set(key, data);
    return data;
  };

  for (const meta of metas) {
    if (meta.entryType !== "doc_create" && meta.entryType !== "doc_change") continue;
    const before = meta.entryType === "doc_create" ? null : await stateAt(meta.dependencyIds ?? []);
    const after = await stateAt([meta.id]);
    if (!after) continue;
    const trustedTime = entryTrustedTime(meta, now);
    const isCreate = meta.entryType === "doc_create";
    const pendingBefore = !hasAnyWrap(before);
    for (const [epoch, gen] of Object.entries(after.userKeys ?? {})) {
      if (!/^\d+$/.test(epoch) || !gen) continue;
      const valueKey = generationValueKey(gen);
      const prior = before?.userKeys?.[epoch];
      if (prior && generationValueKey(prior) === valueKey) continue;
      const versions = history.get(epoch) ?? [];
      const existing = versions.find((v) => v.valueKey === valueKey);
      const version: GenerationVersion = {
        valueKey,
        generation: JSON.parse(JSON.stringify(gen)) as UserKeyGeneration,
        trustedTime,
        isCreate,
        pendingBefore,
      };
      if (!existing) {
        versions.push(version);
      } else if (isCreate || (!existing.isCreate && trustedTime < existing.trustedTime)) {
        versions[versions.indexOf(existing)] = version;
      }
      history.set(epoch, versions);
    }
  }
  for (const versions of history.values()) {
    versions.sort((a, b) => a.trustedTime - b.trustedTime);
  }
  perDb.set(docId, { stamp, history });
  return history;
}

async function signedBy(
  crypto: CryptoAdapter,
  usernameHash: string,
  epoch: string,
  gen: UserKeyGeneration,
  acceptedSigners: string[],
): Promise<boolean> {
  if (!gen.signatures?.length || acceptedSigners.length === 0) return false;
  const accepted = new Set(acceptedSigners.map(normalizePublicKeyPem));
  const message = userKeyGenerationSigningMessage(usernameHash, epoch, gen);
  for (const sig of gen.signatures) {
    if (!sig?.signerPublicKey || !sig.signature) continue;
    if (!accepted.has(normalizePublicKeyPem(sig.signerPublicKey))) continue;
    if (await verifyEd25519(crypto, sig.signerPublicKey, sig.signature, message)) return true;
  }
  return false;
}

/**
 * The payload with only the generations that count, each at its newest value
 * that counts. Wraps on the live value are kept; a fallback to an earlier
 * value uses that value's own snapshot.
 */
export async function filterValidGenerations(input: {
  payload: UserKeyDocumentPayload;
  history: GenerationHistory;
  policy: GenerationValidityPolicy;
  crypto: CryptoAdapter;
}): Promise<{ payload: UserKeyDocumentPayload; rejectedEpochs: string[] }> {
  const { payload, history, policy, crypto } = input;
  const epochs = Object.keys(payload.userKeys ?? {})
    .filter((e) => /^\d+$/.test(e))
    .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
  const accepted: Record<string, UserKeyGeneration> = {};
  const rejectedEpochs: string[] = [];
  let previous: UserKeyGeneration | null = null;

  for (const epoch of epochs) {
    const live = payload.userKeys[epoch];
    const versions = history.get(epoch) ?? [];
    const liveKey = generationValueKey(live);
    // Live value first, then older values newest first.
    const candidates: Array<{ gen: UserKeyGeneration; version?: GenerationVersion }> = [];
    const liveVersion = versions.find((v) => v.valueKey === liveKey);
    candidates.push({ gen: live, version: liveVersion });
    for (const version of [...versions].reverse()) {
      if (version.valueKey === liveKey) continue;
      candidates.push({ gen: version.generation, version });
    }

    let chosen: UserKeyGeneration | null = null;
    for (const candidate of candidates) {
      if (await counts(candidate.gen, candidate.version, epoch, previous, policy, crypto)) {
        chosen = candidate.gen;
        break;
      }
    }
    if (chosen) {
      accepted[epoch] = chosen;
      previous = chosen;
    } else {
      rejectedEpochs.push(epoch);
    }
  }
  return { payload: { ...payload, userKeys: accepted }, rejectedEpochs };
}

async function counts(
  gen: UserKeyGeneration,
  version: GenerationVersion | undefined,
  epoch: string,
  previous: UserKeyGeneration | null,
  policy: GenerationValidityPolicy,
  crypto: CryptoAdapter,
): Promise<boolean> {
  if (!gen?.publicKey) return false;
  // Not seen in history (not yet materialized): treat as brand new.
  const trustedTime = version?.trustedTime ?? Number.POSITIVE_INFINITY;
  if (version?.isCreate) return true;

  const signers: string[] = [];
  const selfGrant = policy.selfGrant;
  if (
    selfGrant?.signingPublicKey &&
    (selfGrant.revokedAt === undefined || trustedTime < selfGrant.revokedAt)
  ) {
    signers.push(selfGrant.signingPublicKey);
  }
  if (previous?.signingPublicKey) signers.push(previous.signingPublicKey);
  if (await signedBy(crypto, policy.usernameHash, epoch, gen, signers)) return true;

  if (
    !previous &&
    version?.pendingBefore &&
    gen.signingPublicKey &&
    (await signedBy(crypto, policy.usernameHash, epoch, gen, [gen.signingPublicKey]))
  ) {
    return true;
  }

  if (policy.cutoff === undefined) return true;
  return trustedTime < policy.cutoff;
}
