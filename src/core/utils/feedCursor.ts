import type { ProcessChangesCursor } from "../types";

/**
 * A persisted changefeed cursor written before cursors carried their
 * `feedEpoch`. Such a cursor may belong to an older numbering of the feed
 * (an index rebuilt since) and would then skip documents; consumers that
 * restore one from a cache read the feed once from the beginning instead.
 */
export function isPreEpochFeedCursor(cursor: ProcessChangesCursor | null | undefined): boolean {
  return !!cursor && cursor.feedEpoch === undefined && (cursor.changeSeq ?? 0) > 0;
}
