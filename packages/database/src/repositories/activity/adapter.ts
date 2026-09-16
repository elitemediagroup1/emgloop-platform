// What every Universal Activity adapter is, and the few rules they all obey.
//
// Slice A2 (docs/architecture/universal-activity.md). An adapter reads ONE source
// authority and returns `activity.v1` items. It never writes, never joins across
// authorities to invent a fact, and never decides who a fact is about.
//
// AN ADAPTER DECLARES ITS SOURCE'S OWN GUARD. `requires` is the permission the
// source's own surface enforces today -- not a new "activity" permission. The
// service refuses to run an adapter whose requirements the viewer does not hold, so
// an unauthorized source costs zero queries and leaks not even its existence.
// Universal Activity therefore grants nothing: it can only ever show a viewer what
// some existing surface already would.
//
// KEY PRESENCE, NEVER A VALUE. Adapters look at whether a source kept a phone key,
// an email key or a continuity key. They never read the value, never compare two
// values, and never group by one -- that would be identity matching outside the
// governed authority (§3, rule 2).
//
// PAGING IS KEYSET, PER SOURCE. Each adapter returns at most `limit + 1` items
// strictly after the cursor in the one order, using an index. No adapter reads a
// window it cannot bound.

import type { Resource } from '../iam.repository';
import {
  activityItemAfterCursor,
  validateActivityItem,
  type ActivityCategory,
  type ActivityCursorV1,
  type ActivityFilter,
  type ActivityItemV1,
} from '@emgloop/shared';

/** A cursor this repository did not produce. Callers treat it as a bad request. */
export class ActivityCursorError extends Error {
  constructor() {
    super('Invalid activity cursor');
    this.name = 'ActivityCursorError';
  }
}

export function encodeActivityCursor(cursor: ActivityCursorV1): string {
  return Buffer.from(JSON.stringify({ i: cursor.instant, k: cursor.key }), 'utf8').toString('base64url');
}

export function decodeActivityCursor(raw: string): ActivityCursorV1 {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { i?: unknown; k?: unknown };
    if (typeof parsed.i !== 'string' || typeof parsed.k !== 'string' || !Number.isFinite(Date.parse(parsed.i))) {
      throw new ActivityCursorError();
    }
    return { instant: parsed.i, key: parsed.k };
  } catch {
    throw new ActivityCursorError();
  }
}

/**
 * What a read is about. Every subject is named by an id the caller already holds;
 * there is no search, and no subject is resolved from a contact value.
 */
export type ActivitySubject =
  | { readonly kind: 'ORGANIZATION' }
  | { readonly kind: 'INTAKE_RECORD'; readonly customerId: string }
  | { readonly kind: 'CASE'; readonly priorityId: string };

export interface ActivityAdapterRequest {
  readonly organizationId: string;
  readonly subject: ActivitySubject;
  readonly filter: ActivityFilter;
  readonly cursor: ActivityCursorV1 | null;
  readonly limit: number;
  /**
   * Whether the interaction adapter is reading in the same composition, so a source
   * that also records the same occurrence knows to stand down.
   */
  readonly interactionsIncluded: boolean;
}

export interface ActivityAdapterPage {
  readonly items: readonly ActivityItemV1[];
  readonly rowsRead: number;
  readonly suppressed: number;
  readonly limitations: readonly string[];
}

export type ActivityRequirement = { readonly resource: Resource; readonly action: 'view' };

export interface ActivityAdapter {
  readonly domain: string;
  /** The workspace authority the source's own surface sits behind, when it has one. */
  readonly workspace: string | null;
  /** Categories this source can produce, so a filter that excludes them skips the query. */
  readonly categories: readonly ActivityCategory[];
  supports(subject: ActivitySubject): boolean;
  /**
   * Held by the viewer before this adapter reads anything, for THIS subject. It
   * varies by lane because the source's own surfaces do: a customer's timeline is
   * `customers:view`, while an organization-wide read of the same rows must hold
   * every grant any surface showing them requires.
   */
  requiresFor(subject: ActivitySubject): readonly ActivityRequirement[];
  page(request: ActivityAdapterRequest): Promise<ActivityAdapterPage>;
}

// --- Helpers every adapter shares --------------------------------------------------

export const EMPTY_PAGE: ActivityAdapterPage = { items: [], rowsRead: 0, suppressed: 0, limitations: [] };

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * Whether a source kept any of these keys with something in it. PRESENCE ONLY: the
 * value is read to see that it is not blank and is then discarded. Nothing here
 * returns, compares, logs or hashes it.
 */
export function hasAnyKey(source: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.some((key) => {
    const v = source[key];
    if (typeof v === 'string') return v.trim() !== '';
    return typeof v === 'number' || v === true;
  });
}

export function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

/**
 * The items an adapter may return: every one valid against `activity.v1`, and every
 * one strictly after the cursor. An item that breaks either is refused rather than
 * shown, because a projection that leaks or invents is worse than a short page.
 */
export function admit(
  items: readonly ActivityItemV1[],
  cursor: ActivityCursorV1 | null,
): { items: ActivityItemV1[]; refused: ActivityItemV1[] } {
  const ok: ActivityItemV1[] = [];
  const refused: ActivityItemV1[] = [];
  for (const item of items) {
    if (!activityItemAfterCursor(item, cursor) || validateActivityItem(item).length > 0) refused.push(item);
    else ok.push(item);
  }
  return { items: ok, refused };
}

/**
 * Where a source's own page must start, given a cursor produced anywhere in the
 * composed order.
 *
 * Every key a source emits begins with the same `recordType:` prefix, so comparing
 * one of its keys with a cursor key from ANOTHER source is decided inside that
 * prefix -- the answer is the same for every row the source holds. That collapses
 * the tie-break at the cursor's instant into three cases a SQL WHERE can express:
 *
 *   ID    the cursor came from this source: continue after that record id.
 *   ALL   every key here sorts below the cursor key: the whole instant qualifies.
 *   NONE  every key here sorts above it: skip the instant entirely.
 *
 * Getting this wrong does not corrupt data, it silently drops or repeats a row at a
 * page boundary, which is why it is one tested function rather than a condition
 * copied into five adapters.
 */
export type SameInstantBound = { mode: 'ID'; idBound: string } | { mode: 'ALL' } | { mode: 'NONE' };

export function sameInstantBound(
  recordType: string,
  cursorKey: string,
  /** For a source whose key carries more than the record id, e.g. `…:<id>:<sequence>`. */
  idFromRest: (rest: string) => string = (rest) => rest,
): SameInstantBound {
  const prefix = `${recordType}:`;
  if (cursorKey.startsWith(prefix)) return { mode: 'ID', idBound: idFromRest(cursorKey.slice(prefix.length)) };
  return prefix < cursorKey ? { mode: 'ALL' } : { mode: 'NONE' };
}

/**
 * The organization-scoped time window a keyset page reads, as a Prisma `where`
 * fragment over one instant column and the record id. Ordering is always
 * (instant DESC, id DESC), matching `compareActivityItems`.
 */
export function keysetWhere(
  field: string,
  recordType: string,
  cursor: ActivityCursorV1 | null,
  idFromRest?: (rest: string) => string,
): Record<string, unknown> {
  if (!cursor) return {};
  const at = new Date(cursor.instant);
  if (!Number.isFinite(at.getTime())) throw new ActivityCursorError();
  const bound = sameInstantBound(recordType, cursor.key, idFromRest);
  if (bound.mode === 'NONE') return { [field]: { lt: at } };
  if (bound.mode === 'ALL') return { [field]: { lte: at } };
  return { OR: [{ [field]: { lt: at } }, { [field]: at, id: { lt: bound.idBound } }] };
}

/** The categories a filter admits, intersected with what a source can produce. */
export function filteredCategories(
  filter: ActivityFilter,
  produced: readonly ActivityCategory[],
  includes: (filter: ActivityFilter, category: ActivityCategory) => boolean,
): ActivityCategory[] {
  return produced.filter((category) => includes(filter, category));
}
