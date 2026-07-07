import {
  createQuantizedTimeSource,
  setSemanticTimeSourceForTesting,
} from "../../core/utils/timeSource";

/**
 * Timestamp-tie stress mode. When MINDOODB_TEST_CLOCK_QUANTUM_MS is set,
 * every semantic timestamp (entry createdAt, document lastModified, ...)
 * is floored to that quantum, so operations that normally only collide on
 * a fast machine within one millisecond collide almost always. Elapsed-time
 * code (timeouts, cooldowns, perf metrics) keeps the real clock and is
 * unaffected.
 *
 * Usage: MINDOODB_TEST_CLOCK_QUANTUM_MS=50 npx jest <suites>
 *
 * Scope: this mode hardens ordering/tie-break logic (changefeed, DAG
 * analysis, sync, summary store, history iteration) AND timestamp-slice
 * semantics. "State at t" is deterministic even with tied timestamps: the
 * slice is pruned to complete causal chains and resolved via the dependency
 * DAG (see pruneToGroundedEntries / isDeletedFromHeads), never via id
 * tie-breaks, so a same-instant change→delete still resolves delete-last.
 *
 * What CAN still fail under the quantum are tests that capture a real-clock
 * instant between two operations and assert the second one is not yet
 * visible at it (e.g. "version == i at timestamps[i]"): flooring can move
 * the later operation into the same or an earlier bucket than the captured
 * instant, so it legitimately IS part of the state at that time. That is
 * coarser time resolution, not nondeterminism — such assertions describe
 * wall-clock boundaries, not causal behavior. Fix candidates: derive the
 * probe instant from entry createdAt metadata instead of Date.now(), or run
 * the suite without the quantum.
 */
const quantumRaw = process.env.MINDOODB_TEST_CLOCK_QUANTUM_MS;
if (quantumRaw) {
  const quantumMs = Number(quantumRaw);
  setSemanticTimeSourceForTesting(createQuantizedTimeSource(quantumMs));
  // eslint-disable-next-line no-console
  console.log(
    `[semantic-clock] Timestamp-tie stress mode active: semantic time quantized to ${quantumMs}ms buckets`,
  );
}
