import { StoreEntryMetadata } from "../types";
import { verifyWitnessReceipt, witnessFieldsFromEntry } from "../crypto/WitnessReceipt";

/**
 * Receipt-time validation and the clock-skew guard (docs/accesscontrol.md §4,
 * §5.4).
 *
 * A valid witness signature proves *who* signed and *what* it covers, but not
 * that the `receivedAt` value is honest. A compromised witness could backdate
 * `receivedAt` to slip an entry "before" a policy that would have denied it.
 * Receivers therefore validate `receivedAt` in addition to the signature:
 * per-witness monotonicity plus a wall-clock sanity check at receive time.
 */

/** Default tolerance for the client/server clock-skew guard (§4). */
export const DEFAULT_CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000; // 5 minutes

/** How far in the past a `receivedAt` may be before it is *flagged* (not rejected). */
export const DEFAULT_IMPLAUSIBLE_PAST_MS = 365 * 24 * 60 * 60 * 1000; // ~1 year

/** Result of the clock-skew guard. */
export interface ClockSkewResult {
  ok: boolean;
  skewMs: number;
  toleranceMs: number;
}

/**
 * Compare the local wall clock to the server's reported time (from
 * `/sync/.../capabilities`), aborting sync if they diverge beyond tolerance
 * (§4). This bounds how wrong a `createdAt` (and therefore a trusted-time
 * decision) can be when a client edits offline then syncs.
 */
export function checkClockSkew(
  localTimeMs: number,
  serverTimeMs: number,
  toleranceMs: number = DEFAULT_CLOCK_SKEW_TOLERANCE_MS
): ClockSkewResult {
  const skewMs = Math.abs(localTimeMs - serverTimeMs);
  return { ok: skewMs <= toleranceMs, skewMs, toleranceMs };
}

/** Capabilities a client reads from `GET /sync/.../capabilities` (§4, §12). */
export interface NegotiableCapabilities {
  /** Server wall clock (ms epoch), used for the clock-skew guard. */
  serverTime?: number;
  /** Whether the server understands witness fields / access control v1. */
  supportsAccessControlV1?: boolean;
}

/** Outcome of the pre-sync capability negotiation (§12). */
export interface SyncNegotiationResult {
  /** Whether sync may proceed. */
  ok: boolean;
  /** Why sync was refused, when not ok. */
  reason?: string;
  /** The clock-skew measurement, when the server reported its time. */
  clockSkew?: ClockSkewResult;
  /** Whether the server enforces access control v1 (advisory for the client). */
  accessControlAvailable: boolean;
}

/**
 * Decide whether a client may proceed to sync, given the server's advertised
 * capabilities (§12). Two gates:
 *
 * 1. **Clock-skew guard** (§4): if the server reported its time and the local
 *    clock diverges beyond tolerance, refuse — a wrong local clock would make
 *    `createdAt`-based trusted-time decisions unsafe.
 * 2. **Strict mode** (§12): a per-tenant policy may refuse to sync against a
 *    server that does not understand witness fields / access control v1.
 *
 * Pure and deterministic so it is trivially testable; the transport layer is a
 * thin consumer.
 */
export function negotiateSync(
  localTimeMs: number,
  capabilities: NegotiableCapabilities,
  options?: { strictMode?: boolean; skewToleranceMs?: number }
): SyncNegotiationResult {
  const accessControlAvailable = capabilities.supportsAccessControlV1 === true;

  let clockSkew: ClockSkewResult | undefined;
  if (typeof capabilities.serverTime === "number") {
    clockSkew = checkClockSkew(localTimeMs, capabilities.serverTime, options?.skewToleranceMs);
    if (!clockSkew.ok) {
      return {
        ok: false,
        reason: `clock skew ${clockSkew.skewMs}ms exceeds tolerance ${clockSkew.toleranceMs}ms`,
        clockSkew,
        accessControlAvailable,
      };
    }
  }

  if (options?.strictMode && !accessControlAvailable) {
    return {
      ok: false,
      reason: "strict mode: server does not support access control v1",
      clockSkew,
      accessControlAvailable,
    };
  }

  return { ok: true, clockSkew, accessControlAvailable };
}

/** Outcome of validating a single entry's witness receipt. */
export interface ReceiptValidationResult {
  /** Whether the receipt is acceptable (trusted witness, valid sig, sane time). */
  ok: boolean;
  /** Human-readable reason when not ok, or a flag note when ok-but-suspicious. */
  reason?: string;
  /** True when the entry carried no receipt at all (a local, not-yet-synced entry). */
  noReceipt?: boolean;
  /** True when the time looked implausibly old (accepted, but logged for audit). */
  flaggedImplausiblePast?: boolean;
}

/** Inputs the validator needs that are not on the entry itself. */
export interface ReceiptValidationContext {
  /** Database id the entry belongs to (bound into the receipt signature). */
  dbid: string;
  /** Currently-trusted witness public keys (from the directory-state node, §6.4). */
  trustedWitnessKeys: Set<string>;
  /** Receiver wall clock at receive time (ms epoch). */
  nowMs: number;
  /** Clock-skew tolerance for the far-future rejection. */
  skewToleranceMs?: number;
  /** How far in the past is "implausible" (flagged, not rejected). */
  implausiblePastMs?: number;
}

/**
 * Validates witness receipts on incoming entries (§5.4). One instance should be
 * kept per store so per-witness `receivedAt` monotonicity is enforced across
 * the entries accepted from each witness.
 */
export class WitnessReceiptValidator {
  /** Last accepted `receivedAt` per witness key (monotonicity, §5.4). */
  private lastSeenByWitness = new Map<string, number>();

  /** Seed the per-witness high-water marks (e.g. from persisted state). */
  constructor(initialLastSeen?: Map<string, number>) {
    if (initialLastSeen) {
      this.lastSeenByWitness = new Map(initialLastSeen);
    }
  }

  /** The last-seen `receivedAt` for a witness, or undefined if none yet. */
  getLastSeen(witnessPublicKey: string): number | undefined {
    return this.lastSeenByWitness.get(witnessPublicKey);
  }

  /**
   * Validate the witness receipt on an entry. Returns `{ ok: true, noReceipt:
   * true }` for entries with no receipt (local, not-yet-synced). Throws no
   * exceptions for invalid receipts — it returns `{ ok: false, reason }` so the
   * caller can quarantine.
   */
  async validate(
    entry: StoreEntryMetadata,
    ctx: ReceiptValidationContext,
    subtle: SubtleCrypto
  ): Promise<ReceiptValidationResult> {
    const { receivedAt, receivedByPublicKey, receivedDateSignature } = entry;

    // No receipt: a purely local entry. Nothing to validate here.
    if (receivedAt === undefined || !receivedByPublicKey || !receivedDateSignature) {
      return { ok: true, noReceipt: true };
    }

    // The witness must be currently trusted (§6.4).
    if (!ctx.trustedWitnessKeys.has(receivedByPublicKey)) {
      return { ok: false, reason: "receipt from an untrusted witness key" };
    }

    // Cryptographically verify the signature over the §5.2 layout.
    const fields = witnessFieldsFromEntry(entry, {
      dbid: ctx.dbid,
      receivedAt,
      receivedByPublicKey,
    });
    const sigValid = await verifyWitnessReceipt(fields, receivedDateSignature, receivedByPublicKey, subtle);
    if (!sigValid) {
      return { ok: false, reason: "invalid witness signature" };
    }

    // Per-witness monotonicity: a witness cannot rewind its own clock (§5.4).
    const lastSeen = this.lastSeenByWitness.get(receivedByPublicKey);
    if (lastSeen !== undefined && receivedAt < lastSeen) {
      return {
        ok: false,
        reason: `non-monotonic receivedAt (${receivedAt} < last-seen ${lastSeen}) from witness`,
      };
    }

    // Wall-clock sanity at receive time (§5.4): reject far-future values.
    const tolerance = ctx.skewToleranceMs ?? DEFAULT_CLOCK_SKEW_TOLERANCE_MS;
    if (receivedAt > ctx.nowMs + tolerance) {
      return { ok: false, reason: "receivedAt is implausibly in the future" };
    }

    // Flag (but accept) implausibly old values for the audit log.
    const implausiblePast = ctx.implausiblePastMs ?? DEFAULT_IMPLAUSIBLE_PAST_MS;
    const flaggedImplausiblePast = receivedAt < ctx.nowMs - implausiblePast;

    // Accept and advance the monotonicity high-water mark.
    this.lastSeenByWitness.set(receivedByPublicKey, receivedAt);
    return { ok: true, flaggedImplausiblePast };
  }
}

/**
 * The trusted time of an entry for all access-control evaluation: `receivedAt`
 * when present (witness-assigned), otherwise `createdAt` (local entry). §5.1.
 */
export function trustedTimeOf(entry: Pick<StoreEntryMetadata, "receivedAt" | "createdAt">): number {
  return entry.receivedAt ?? entry.createdAt;
}
