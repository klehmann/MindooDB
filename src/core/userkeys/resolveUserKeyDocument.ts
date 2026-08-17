import type { MindooDB, MindooDoc, MindooTenantDirectory } from "../types";
import { userKeyDocumentId, type UserKeyDocumentPayload } from "./types";
import { validateUserKeyDocument } from "./validateUserKeyDocument";

export interface ResolveUserKeyDocumentInput {
  db: MindooDB;
  directory: MindooTenantDirectory;
  username: string;
  usernameHashCandidates: string[];
  grantDocIds: string[];
  adminPublicKey?: string;
}

export interface ResolvedUserKeyDocument {
  doc: MindooDoc;
  payload: UserKeyDocumentPayload;
}

/**
 * §5.1 lookup: canonical `userkey_<grantDocId>` first, then a scan over
 * `username_hash`. Invalid squatters are ignored. Ties break by highest
 * epoch, then lowest fingerprint (byte-deterministic).
 */
export async function resolveUserKeyDocument(
  input: ResolveUserKeyDocumentInput,
): Promise<ResolvedUserKeyDocument | null> {
  const valid: ResolvedUserKeyDocument[] = [];

  for (const grantDocId of input.grantDocIds) {
    const canonicalId = userKeyDocumentId(grantDocId);
    try {
      const doc = await input.db.getDocument(canonicalId);
      if (doc.isDeleted()) continue;
      const resolved = await validateLoaded(doc, input);
      if (resolved) valid.push(resolved);
    } catch {
      // missing or unreadable
    }
  }

  if (valid.length === 0) {
    const ids = await input.db.getAllDocumentIds();
    for (const id of ids) {
      if (valid.some((v) => v.doc.getId() === id)) continue;
      try {
        const doc = await input.db.getDocument(id);
        if (doc.isDeleted()) continue;
        const resolved = await validateLoaded(doc, input);
        if (resolved) valid.push(resolved);
      } catch {
        // skip
      }
    }
  }

  if (valid.length === 0) return null;
  valid.sort(compareResolved);
  return valid[0];
}

async function validateLoaded(
  doc: MindooDoc,
  input: ResolveUserKeyDocumentInput,
): Promise<ResolvedUserKeyDocument | null> {
  const signerKey = await creatorSigningKey(input.db, doc.getId());
  if (!signerKey) return null;
  const payload = await validateUserKeyDocument({
    payload: doc.getData(),
    signerKey,
    usernameHashCandidates: input.usernameHashCandidates,
    directory: input.directory,
    adminPublicKey: input.adminPublicKey,
  });
  if (!payload) return null;
  return { doc, payload };
}

async function creatorSigningKey(db: MindooDB, docId: string): Promise<string | null> {
  const store = db.getStore();
  const metas = await store.findNewEntriesForDoc([], docId);
  const create = metas.find((m) => m.entryType === "doc_create");
  return create?.createdByPublicKey ?? null;
}

function compareResolved(a: ResolvedUserKeyDocument, b: ResolvedUserKeyDocument): number {
  const epochA = maxEpoch(a.payload);
  const epochB = maxEpoch(b.payload);
  if (epochA !== epochB) return epochB > epochA ? 1 : -1;
  const fpA = currentFingerprint(a.payload);
  const fpB = currentFingerprint(b.payload);
  if (fpA !== fpB) return fpA < fpB ? -1 : 1;
  return a.doc.getId() < b.doc.getId() ? -1 : 1;
}

function maxEpoch(payload: UserKeyDocumentPayload): bigint {
  const epochs = Object.keys(payload.userKeys ?? {}).filter((k) => /^\d+$/.test(k));
  if (epochs.length === 0) return 0n;
  return epochs.reduce((acc, k) => {
    const n = BigInt(k);
    return n > acc ? n : acc;
  }, 0n);
}

function currentFingerprint(payload: UserKeyDocumentPayload): string {
  const epochs = Object.keys(payload.userKeys ?? {}).filter((k) => /^\d+$/.test(k));
  if (epochs.length === 0) return "";
  const current = epochs.reduce((a, b) => (BigInt(a) > BigInt(b) ? a : b));
  return payload.userKeys[current]?.fingerprint ?? "";
}
