import type { AccessDecision, RuleType } from "./types";

/**
 * Thrown by the client-side write-policy prechecks when a `createDocument`,
 * `changeDoc`, `deleteDoc`, or `undeleteDoc` is denied by the active access
 * control rules (docs/accesscontrol.md §9). Carries the full
 * {@link AccessDecision} so applications can surface a meaningful message
 * (e.g. in a database-browser editor) and inspect which rule decided.
 *
 * The precheck is a UX/early-feedback layer for honest clients; the server
 * witness (Tier 1) and quarantine-on-materialization (Tier 2) remain the
 * authoritative enforcers.
 */
export class AccessDeniedError extends Error {
  /** The operation that was attempted. */
  public readonly op: RuleType;
  /** The target database id. */
  public readonly dbid: string;
  /** The full evaluation result (with `allowed: false`). */
  public readonly decision: AccessDecision;

  constructor(op: RuleType, dbid: string, decision: AccessDecision) {
    const rulePart = decision.matchedRuleId ? ` (rule ${decision.matchedRuleId})` : "";
    super(
      `[ACL] ${op} denied in database "${dbid}"${rulePart} [${decision.tier}]: ${decision.reason}`,
    );
    this.name = "AccessDeniedError";
    this.op = op;
    this.dbid = dbid;
    this.decision = decision;
    // Preserve the prototype chain for `instanceof` across transpilation targets.
    Object.setPrototypeOf(this, AccessDeniedError.prototype);
  }
}
