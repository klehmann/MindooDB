/**
 * Building a Tier 1 gate out of a tenant directory.
 *
 * Tier 1 (docs/accesscontrol.md §7) is the identity tier: who signed, which
 * database, which operation. A witness — normally the server — evaluates it at
 * the moment it accepts an entry and stamps that verdict into the receipt, and
 * receivers then trust the receipt instead of re-deciding (§ Scenario C).
 *
 * That leaves a gap wherever entries arrive **without** passing a witness. A
 * peer-to-peer sync is exactly that case: the entries carry no receipt, and
 * `validateWitnessReceipt` reads "no receipt" as "purely local, nothing to
 * check". Whoever accepts such entries has to evaluate Tier 1 themselves, or
 * nobody ever does — hence this being shared rather than private to the
 * server.
 */

import type { ContentAddressedStore } from "../appendonlystores/types";
import type { StoreEntry } from "../types";

import type { AccessDecision } from "./types";

/**
 * Decides whether one entry may be written to one database.
 *
 * Kept as a callback so callers stay decoupled from the directory
 * implementation and can be unit-tested with a stub.
 */
export type Tier1Evaluator = (
  entry: StoreEntry,
  dbid: string,
) => Promise<AccessDecision>;

/**
 * The directory surface a Tier 1 evaluation needs. Structural on purpose: the
 * server and the browser reach their directory by different routes, and an
 * older directory may not answer at all (see the `undefined` return below).
 */
export interface Tier1Directory {
  evaluateAccessForSigningKey?(input: {
    op: string;
    dbid: string;
    signingKey: string;
    trustedTime: number;
    isAuthor: boolean;
  }): Promise<AccessDecision>;
  isSamePerson?(input: {
    creatorSigningKey: string;
    signerSigningKey: string;
    creatorTrustedTime: number;
    signerTrustedTime: number;
  }): Promise<boolean>;
}

/**
 * Builds the gate, or returns `undefined` when this directory cannot decide
 * Tier 1 at all.
 *
 * Note what `undefined` means for a caller: there is no verdict, not an
 * approval. A caller that must not admit unchecked entries has to treat it as
 * a refusal — see the peer listener, which does.
 *
 * `localStore` is needed only to resolve `$author`: authorship is a property
 * of the document's `doc_create`, so a later change has to be traced back to
 * it.
 */
export function buildTier1Evaluator(
  directory: Tier1Directory,
  localStore: Pick<ContentAddressedStore, "findNewEntriesForDoc">,
): Tier1Evaluator | undefined {
  if (typeof directory.evaluateAccessForSigningKey !== "function") {
    return undefined;
  }

  return async (entry, dbid) => {
    // Tier 1 is evaluated at acceptance time — the same instant a witness
    // would stamp into its receipt (docs/accesscontrol.md §5.3, §7).
    const trustedTime = Date.now();

    // Resolve `$author` at grant level: creator at the doc_create trusted
    // time, signer at acceptance time. Falls back to device-key equality when
    // the directory cannot answer.
    let isAuthor = entry.entryType === "doc_create";
    if (!isAuthor) {
      try {
        const docEntries = await localStore.findNewEntriesForDoc(
          [],
          entry.docId,
        );
        const createEntry = docEntries.find(
          (m) => m.entryType === "doc_create",
        );
        if (createEntry) {
          const samePerson = directory.isSamePerson;
          if (typeof samePerson === "function") {
            isAuthor = await samePerson({
              creatorSigningKey: createEntry.createdByPublicKey,
              signerSigningKey: entry.createdByPublicKey,
              creatorTrustedTime:
                createEntry.receivedAt ?? createEntry.createdAt,
              signerTrustedTime: trustedTime,
            });
          } else {
            isAuthor =
              createEntry.createdByPublicKey === entry.createdByPublicKey;
          }
        }
      } catch {
        // Leaving isAuthor false makes a rule that requires $author deny,
        // which is the fail-closed choice.
      }
    }

    return directory.evaluateAccessForSigningKey!({
      op: entry.entryType as string,
      dbid,
      signingKey: entry.createdByPublicKey,
      trustedTime,
      isAuthor,
    });
  };
}
