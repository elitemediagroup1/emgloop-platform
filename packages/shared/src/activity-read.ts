// Reading Universal Activity -- paging and composition rules, pure.
//
// Slice A2 (docs/architecture/universal-activity.md §4 "Reading contract").
// `activity.ts` says what one item is; this says how a page of items from several
// authorities is ordered, cut and continued. Adapters live in the database package,
// because each one reads its own authority under that authority's own guard.
//
// NO AUTHORITY, NO STORE. A page is assembled per request and thrown away. Nothing
// here caches, writes, or remembers what it returned.
//
// ONE ORDER, EVERYWHERE. `compareActivityItems` is the only ordering: newest first
// by occurrence when it is known, by the moment Loop recorded it when it is not,
// then by key so equal instants never reorder between two renders. A cursor names
// exactly one point in that order, so a page boundary cannot drop or repeat an item
// while the underlying sources keep receiving new rows.
//
// EACH SOURCE READS ITS OWN PAGE. A composed page asks every source for at most
// `limit + 1` items strictly after the cursor, then merges. This is the k-way merge
// property: an item a source did not return is older than that source's last
// returned item, so it cannot belong on this page. It is what keeps the read
// bounded -- no source is ever asked for "everything" to be sorted in memory.
//
// A SHORT PAGE IS NOT AN EMPTY ONE. Duplicates suppressed across sources (one call
// recorded by two authorities) and items a viewer may not see can leave a page with
// fewer than `limit` items. `hasMore` and the cursor, not the item count, say
// whether to ask again.
//
// PURE. No clock, no I/O.

import { compareActivityItems, activitySortInstant, type ActivityItemV1 } from './activity';

export const ACTIVITY_PAGE_LIMIT_DEFAULT = 50;
export const ACTIVITY_PAGE_LIMIT_MAX = 100;

/** Fails closed to the default: a missing, absurd or non-integer limit is not a licence to read everything. */
export function activityPageLimit(requested?: number | null): number {
  if (typeof requested !== 'number' || !Number.isInteger(requested) || requested < 1) return ACTIVITY_PAGE_LIMIT_DEFAULT;
  return Math.min(requested, ACTIVITY_PAGE_LIMIT_MAX);
}

/** One point in the single order: the instant an item sorted on, and its key. */
export interface ActivityCursorV1 {
  readonly instant: string;
  readonly key: string;
}

export function activityCursorOf(item: ActivityItemV1): ActivityCursorV1 {
  return { instant: activitySortInstant(item), key: item.key };
}

/**
 * Whether an item belongs strictly after a cursor in the one order: older, or the
 * same instant with a lower key. Adapters express the same predicate in SQL, so
 * this is the definition both sides are held to by test.
 */
export function activityItemAfterCursor(item: ActivityItemV1, cursor: ActivityCursorV1 | null): boolean {
  if (cursor === null) return true;
  const at = Date.parse(activitySortInstant(item));
  const ct = Date.parse(cursor.instant);
  if (!Number.isFinite(at) || !Number.isFinite(ct)) return false;
  if (at !== ct) return at < ct;
  return item.key < cursor.key;
}

/** What one source contributed to a page, and what it could not say. Diagnostics, never UI copy. */
export interface ActivitySourceReadV1 {
  readonly domain: string;
  /** Rows the source was asked for and read. Bounded per page by design. */
  readonly rowsRead: number;
  /** Items the source produced that broke `validateActivityItem` and were refused. */
  readonly refused: number;
  /** Items suppressed as the same occurrence another authority already reported. */
  readonly suppressed: number;
  /** Not read at all, and why: the viewer lacks the authority, or the filter excludes it. */
  readonly skipped: 'NOT_AUTHORIZED' | 'FILTERED_OUT' | null;
  readonly limitations: readonly string[];
}

export interface ActivityPageV1 {
  readonly contractVersion: 'activity.v1';
  readonly items: readonly ActivityItemV1[];
  /** Opaque. Absent when the composed order has reached its end. */
  readonly nextCursor: string | null;
  readonly sources: readonly ActivitySourceReadV1[];
}

/**
 * Merge per-source pages into one. Each stream must already be in the one order.
 * A key appearing in two streams is the same record reported twice: the first
 * occurrence wins, so a suppression rule stays with the source that owns it.
 */
export function mergeActivityStreams(
  streams: readonly (readonly ActivityItemV1[])[],
  limit: number,
): { items: ActivityItemV1[]; hasMore: boolean } {
  const seen = new Set<string>();
  const all: ActivityItemV1[] = [];
  for (const item of streams.flat().sort(compareActivityItems)) {
    if (seen.has(item.key)) continue;
    seen.add(item.key);
    all.push(item);
  }
  return { items: all.slice(0, limit), hasMore: all.length > limit };
}
