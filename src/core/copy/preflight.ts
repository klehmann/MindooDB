/**
 * The write-policy preflight for a history copy.
 *
 * Access-control rules are keyed by database id, so a set of entries that was
 * perfectly legal in the source database is not automatically legal in the
 * target. This bites hardest when sharding: a graft carries the *original*
 * authors' signatures, and the server witness evaluates Tier 1 against the
 * **target** `dbid` when the shard is pushed. If the new database's policy does
 * not admit those authors, the entries are accepted locally and then rejected
 * at the witness — after the copy has already run.
 *
 * So the copy checks up front, once per distinct (signer, operation) pair
 * rather than once per entry, since the Tier 1 verdict depends only on that
 * pair. What it deliberately does NOT do is decide Tier 2 (content) rules: a
 * graft never decrypts anything, so it cannot evaluate them, and it reports
 * them as undecidable rather than guessing.
 *
 * @module
 */

import type { AccessDecision, RuleType } from "../accesscontrol/types";
import type { StoreEntryMetadata } from "../types";
import type { CopyEngineHost } from "./host";

/** One (signer, operation) pair the target database was asked about. */
export interface CopyAdmissionCheck {
  /** The key that will sign the copied entries of this kind in the target. */
  signerPublicKey: string;
  /** The operation those entries represent. */
  op: RuleType;
  /** How many entries in the copy fall under this pair. */
  entryCount: number;
  /** The target's verdict, or `null` when access control is not enforced. */
  decision: AccessDecision | null;
}

/** What the preflight established about a copy. */
export interface CopyAdmissionPreflight {
  /** True when nothing the copy will write is denied by the target policy. */
  admitted: boolean;
  /** The pairs the target denied. Empty when {@link admitted} is true. */
  denied: CopyAdmissionCheck[];
  /**
   * Operations governed by a Tier 2 content rule on the target. The copy cannot
   * evaluate those without decrypting, so the witness may still reject entries
   * this preflight passed. Advisory only.
   */
  undecidableOps: RuleType[];
  /** Every pair that was checked, for diagnostics. */
  checked: CopyAdmissionCheck[];
}

/** Entry types that are subject to a write rule. */
const RULE_OPS = new Set<string>([
  "doc_create",
  "doc_change",
  "doc_delete",
  "doc_undelete",
  "doc_snapshot",
]);

/**
 * Ask the target database whether it admits everything the copy will write.
 *
 * @param target The database being written to.
 * @param entries The source entries about to be copied.
 * @param signerFor Resolves the key that will sign a copied entry: the original
 *   author under a graft, the copying user under a replay.
 * @param documentCreatorKey The source document's creator key, used to answer
 *   `$author` ownership rules.
 */
export async function preflightCopyAdmission(
  target: CopyEngineHost,
  entries: StoreEntryMetadata[],
  signerFor: (entry: StoreEntryMetadata) => string,
  documentCreatorKey: string | null,
): Promise<CopyAdmissionPreflight> {
  const pairs = new Map<string, { signerPublicKey: string; op: RuleType; entryCount: number }>();
  for (const entry of entries) {
    if (!RULE_OPS.has(entry.entryType)) continue;
    const op = entry.entryType as RuleType;
    const signerPublicKey = signerFor(entry);
    const key = `${op}\u0000${signerPublicKey}`;
    const existing = pairs.get(key);
    if (existing) {
      existing.entryCount++;
    } else {
      pairs.set(key, { signerPublicKey, op, entryCount: 1 });
    }
  }

  const checked: CopyAdmissionCheck[] = [];
  const denied: CopyAdmissionCheck[] = [];
  const undecidableOps = new Set<RuleType>();

  for (const pair of pairs.values()) {
    const decision = await target.evaluateWriteAccess(
      pair.op,
      pair.signerPublicKey,
      documentCreatorKey !== null && pair.signerPublicKey === documentCreatorKey,
    );
    const check: CopyAdmissionCheck = { ...pair, decision };
    checked.push(check);
    if (decision && !decision.allowed) {
      denied.push(check);
      continue;
    }
    if (decision && (await target.hasWriteContentRules(pair.op))) {
      undecidableOps.add(pair.op);
    }
  }

  return {
    admitted: denied.length === 0,
    denied,
    undecidableOps: [...undecidableOps],
    checked,
  };
}

/** Render a preflight refusal as an actionable message. */
export function describeAdmissionFailure(
  preflight: CopyAdmissionPreflight,
  targetDbId: string,
): string {
  const details = preflight.denied
    .map(
      (check) =>
        `${check.op} signed by ${shortKey(check.signerPublicKey)} ` +
        `(${check.entryCount} ${check.entryCount === 1 ? "entry" : "entries"}): ` +
        `${check.decision?.reason ?? "denied"}`,
    )
    .join("; ");
  return (
    `The target database '${targetDbId}' does not admit every entry this copy would ` +
    `write, so the server witness would reject them after the copy ran. ${details}. ` +
    "Grant the original authors the corresponding rights on the target database, copy " +
    "with authorship 'reauthor' so the entries are signed by the copying user, or pass " +
    "bypassAccessControlPrecheck to write anyway."
  );
}

/** The identifying tail of a PEM key, enough to recognize it in a message. */
function shortKey(publicKeyPem: string): string {
  const body = publicKeyPem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  return body.length > 12 ? `…${body.slice(-12)}` : body;
}
