import { StoreEntryMetadata } from "../../types";
import type { StampedWitnessFields } from "../../crypto/WitnessReceipt";
import type { ReceiptValidationContext, ReceiptValidationResult } from "../receiptValidation";

/**
 * Pluggable trusted-time / receipt provider seam (docs/accesscontrol.md §5, §13).
 *
 * The trusted time of an entry (`receivedAt`, used for all access-control
 * time-travel evaluation) is attested by a {@link TimestampProvider}. v1 ships a
 * single implementation, the Ed25519 sync-server witness
 * (`Ed25519WitnessProvider`), but the abstraction exists so an alternative such
 * as an RFC 3161 Time-Stamping Authority (TSA) can later plug into BOTH sides:
 *  - the **issue** side: a server stamps an accepted entry ({@link TimestampProvider.stamp}), and
 *  - the **verify** side: a receiver validates the receipt ({@link TimestampVerifier}).
 *
 * Each scheme tags its receipts with a stable {@link TimestampProvider.kind}
 * value, persisted on the entry as `receiptScheme`, so receipts can later be
 * routed to the right verifier. Absence of `receiptScheme` means the default
 * Ed25519 witness scheme (the only scheme that existed before this field).
 */

/** Stable identifier of the Ed25519 sync-server witness scheme (§5). */
export const ED25519_WITNESS_SCHEME = "ed25519-witness";

/**
 * The subset of an entry's metadata a provider needs in order to stamp a
 * receipt. Mirrors the fields bound by the witness signing layout (§5.2).
 */
export type TimestampableEntry = Pick<
  StoreEntryMetadata,
  "entryType" | "contentHash" | "id" | "docId" | "decryptionKeyId" | "createdAt" | "createdByPublicKey"
>;

/** Context the provider needs to stamp a receipt onto an accepted entry. */
export interface TimestampStampContext {
  /** Database id the entry is accepted/witnessed under (bound into the receipt). */
  dbid: string;
  /** Provider-assigned acceptance time (ms epoch). */
  receivedAt: number;
}

/**
 * The fields a provider writes onto an accepted entry: the existing witness
 * receipt fields plus the {@link TimestampProvider.kind} discriminator
 * (`receiptScheme`). Merging this into an entry's metadata produces a stamped
 * entry.
 */
export interface StampedReceipt extends StampedWitnessFields {
  /** The scheme that produced this receipt (equals the provider's `kind`). */
  receiptScheme: string;
}

/**
 * A stateful verifier for a single materialization pass. Implementations may
 * carry per-issuer high-water marks (e.g. the Ed25519 per-witness `receivedAt`
 * monotonicity, §5.4), so one verifier should be used per materialization.
 */
export interface TimestampVerifier {
  /**
   * Validate the receipt on an entry. Returns `{ ok: true, noReceipt: true }`
   * for entries that carry no receipt (local, not-yet-synced). Never throws for
   * an invalid receipt — returns `{ ok: false, reason }` so the caller can
   * quarantine.
   */
  validate(entry: StoreEntryMetadata, ctx: ReceiptValidationContext): Promise<ReceiptValidationResult>;
}

/**
 * Issues and verifies trusted-time receipts for one timestamping scheme. A
 * single instance can be verify-only (no issuing identity configured) or able
 * to both issue and verify.
 */
export interface TimestampProvider {
  /** Stable scheme identifier written onto receipts as `receiptScheme`. */
  readonly kind: string;
  /**
   * The public identity of the issuer (e.g. the witness public key, PEM), or
   * undefined for a verify-only provider. Used to advertise capability and to
   * skip self-witnessing (a server need not witness its own entries).
   */
  readonly issuerPublicKey?: string;
  /** Whether this provider can issue (stamp) receipts. */
  readonly canStamp: boolean;
  /** Stamp a receipt onto an accepted entry (issue side). Throws if it cannot stamp. */
  stamp(entry: TimestampableEntry, ctx: TimestampStampContext): Promise<StampedReceipt>;
  /** Create a stateful verifier for a single materialization pass (verify side). */
  createVerifier(initialLastSeen?: Map<string, number>): TimestampVerifier;
}
