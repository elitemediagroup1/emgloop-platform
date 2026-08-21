// Bounded, complete CallGrid interval retrieval.
//
// WHAT THIS IS
//
// The one primitive that can say "I read this exact interval from CallGrid, and
// I got all of it" -- or say precisely why it could not. A poller may only
// advance a checkpoint past an interval this function returned COMPLETE for, and
// a recovery may only claim a window it read the same way.
//
// WHAT IT IS NOT. Not a poller, not a schedule, not a checkpoint, and it writes
// nothing. It fetches, it partitions, it reports. Ingestion is a separate act
// deliberately performed after the whole interval is in hand, because page 1
// writing 100 calls and page 37 failing must never leave Loop believing the
// interval was polled.
//
// THREE THINGS THIS EXISTS TO STOP
//
// 1. A TRUNCATED READ WEARING A COMPLETE READ'S SHAPE. `fetchAllCallGridCalls`
//    already distinguishes "the provider said there is no more" from "we ran out
//    of budget" -- that was fixed when a 6,918-call window came back as a clean
//    2,500. What it could not distinguish is everything else that ends a loop
//    early, so those become named outcomes here rather than a boolean.
//
// 2. AN IMPLICIT CLOCK. The page fetcher defaults `until` to `new Date()`, which
//    makes the same request return different populations depending on when it
//    ran. A bounded reader cannot have a clock inside it and still be rerunnable,
//    so `until` is REQUIRED here and no `now()` appears in this file.
//
// 3. A THROTTLED PAGE READ AS THE END OF THE DATA. CallGrid has returned 429 in
//    real Stage 3 production runs. Without handling, the page throws, the loop
//    ends and the caller sees an error -- which is at least honest. With naive
//    handling it would look like exhaustion, which would not be.
//
// HALF-OPEN, [since, until). One convention, stated once: `since` is included,
// `until` is not. Two adjacent intervals therefore tile without overlap and
// without a gap, which is what makes a poller's windows composable. CallGrid's
// own filter is inclusive on both ends, so the upper bound is nudged by one
// millisecond on the wire -- see `boundedPageOptions`.
//
// INSTANTS, NOT BUSINESS DATES. This reader takes UTC instants. Translating an
// Eastern business date into an interval belongs to the operation that knows it
// is talking about a business day, and `easternBusinessDayWindow` already does
// it. A reader that took dates would need a timezone, and a timezone in here is
// a second opinion about what a day is.

import type { InboundEvent } from '../interfaces/ingestion.provider';
import {
  CallGridApiError,
  fetchCallGridCallsPage,
  mapCallGridApiRecord,
  type CallGridApiFetchOptions,
} from './callgrid-api';

/** How an interval read ended. A CLOSED LIST, and only one of them is success. */
export const INTERVAL_READ_OUTCOMES = [
  /** The provider proved the interval was exhausted. The only complete answer. */
  'COMPLETE',
  /** Our page budget ran out while CallGrid still had pages. A lower bound. */
  'TRUNCATED',
  /** Throttled, retried within budget, and still throttled. Nothing is known. */
  'RATE_LIMIT_EXHAUSTED',
  /** The provider failed or answered in a shape we do not recognise. */
  'PROVIDER_ERROR',
  /** Pagination itself misbehaved: a cursor that repeats, or more-without-more. */
  'INVALID_PAGINATION',
  /** The request was refused before any provider call. Nothing was read. */
  'REFUSED',
] as const;

export type IntervalReadOutcome = (typeof INTERVAL_READ_OUTCOMES)[number];

/** One provider record this reader could not turn into a canonical event. */
export interface RefusedRecord {
  /** Page number, 1-based, so an operator can find it again. */
  page: number;
  /** Why the mapper refused it. From the shipped contract, never invented. */
  reason: string;
  /** The mapper's error kind when it had one: no-identity, no-occurrence. */
  kind?: string;
}

export interface IntervalReadResult {
  outcome: IntervalReadOutcome;
  /** INCLUSIVE lower bound, as requested. */
  since: Date;
  /** EXCLUSIVE upper bound, as requested. */
  until: Date;
  /** Records that mapped to a canonical event. Empty unless something was read. */
  events: InboundEvent[];
  /**
   * Records the provider returned and the mapper refused.
   *
   * A COMPLETE READ MAY STILL CONTAIN THESE, and that is the distinction this
   * type exists to make: "CallGrid omitted data" and "CallGrid returned 4,239
   * records and one of them cannot be mapped" are different incidents with
   * different responses, and a single boolean cannot tell them apart.
   */
  refused: RefusedRecord[];
  pages: number;
  /** Raw records seen, including refused ones. */
  records: number;
  pageCap: number;
  /** How many times a page was retried after a 429. */
  rateLimitRetries: number;
  /** The cursor the read stopped at, when it stopped early. */
  nextCursor?: unknown;
  /** Provider-reported total for the interval, when it supplies one. Advisory. */
  providerTotal?: number;
  /** Set on every non-COMPLETE outcome. One plain sentence, never a credential. */
  reason?: string;
}

/** Page budget. A safety bound against a provider that always says "more". */
export const INTERVAL_DEFAULT_MAX_PAGES = 500;

/** Records per page. CallGrid caps this server-side; this is the ask. */
export const INTERVAL_PAGE_SIZE = 100;

/**
 * The widest interval this reader will accept, in days.
 *
 * REFUSED RATHER THAN TRUNCATED. A month of CallGrid traffic at the observed
 * 2026-08-10 rate of 7,298 calls is on the order of 200,000 records, and this
 * reader holds the interval in memory so the caller can decide what to do with
 * the whole of it. Beyond that, the honest answer is "ask me for smaller
 * intervals", not a quiet partial read -- and a caller chunking a recovery month
 * by month is a caller who knows what it is doing.
 */
export const INTERVAL_MAX_SPAN_DAYS = 31;

/** Retries per page after a 429, before the interval is abandoned. */
export const RATE_LIMIT_MAX_RETRIES = 5;

/** Backoff floor between throttled attempts, doubling each time. */
export const RATE_LIMIT_BASE_DELAY_MS = 500;

export interface IntervalReadRequest {
  apiKey: string;
  /** INCLUSIVE lower bound. */
  since: Date;
  /** EXCLUSIVE upper bound. REQUIRED -- there is no clock in this file. */
  until: Date;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  maxPages?: number;
  pageSize?: number;
  maxSpanDays?: number;
  maxRateLimitRetries?: number;
  /** Injected so a test can prove backoff without waiting for it. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function refuse(since: Date, until: Date, reason: string): IntervalReadResult {
  return {
    outcome: 'REFUSED',
    since,
    until,
    events: [],
    refused: [],
    pages: 0,
    records: 0,
    pageCap: 0,
    rateLimitRetries: 0,
    reason,
  };
}

/**
 * Judge the requested interval before a single provider request is made.
 *
 * EQUAL BOUNDS ARE REFUSED. Half-open means `[t, t)` contains no instant at all,
 * so a caller asking for one is asking for nothing and almost certainly meant
 * something else. Reversed bounds are refused for the same reason.
 */
export function validateInterval(
  since: Date,
  until: Date,
  maxSpanDays = INTERVAL_MAX_SPAN_DAYS,
): { ok: true } | { ok: false; reason: string } {
  if (!(since instanceof Date) || Number.isNaN(since.getTime())) {
    return { ok: false, reason: 'since is not a valid instant' };
  }
  if (!(until instanceof Date) || Number.isNaN(until.getTime())) {
    return { ok: false, reason: 'until is not a valid instant' };
  }
  if (until.getTime() <= since.getTime()) {
    return {
      ok: false,
      reason: 'until is EXCLUSIVE and must be strictly after since; equal bounds describe no interval',
    };
  }
  const spanDays = (until.getTime() - since.getTime()) / 86_400_000;
  if (spanDays > maxSpanDays) {
    return {
      ok: false,
      reason: `the interval spans ${spanDays.toFixed(1)} days, beyond the ${maxSpanDays}-day maximum; ask for smaller intervals rather than receiving a partial read`,
    };
  }
  return { ok: true };
}

/**
 * The page request for a half-open interval.
 *
 * CallGrid's `startDate`/`endDate` filter is INCLUSIVE on both ends, so the
 * exclusive upper bound is expressed as one millisecond earlier. Without this,
 * two adjacent intervals would both claim a call landing exactly on the boundary
 * -- which a poller re-reading overlapping windows would hit constantly.
 */
function boundedPageOptions(request: IntervalReadRequest, cursor: unknown): CallGridApiFetchOptions {
  return {
    apiKey: request.apiKey,
    since: request.since,
    until: new Date(request.until.getTime() - 1),
    limit: request.pageSize ?? INTERVAL_PAGE_SIZE,
    ...(request.baseUrl ? { baseUrl: request.baseUrl } : {}),
    ...(request.fetchImpl ? { fetchImpl: request.fetchImpl } : {}),
    ...(cursor === undefined ? {} : { cursor }),
  };
}

/** A stable key for a cursor, so a repeat can be detected whatever its shape. */
function cursorKey(cursor: unknown): string {
  if (cursor === undefined || cursor === null) return '';
  if (typeof cursor === 'string') return cursor;
  try {
    return JSON.stringify(cursor);
  } catch {
    return String(cursor);
  }
}

/** Seconds from a Retry-After header, when the provider supplies a usable one. */
export function retryAfterMs(header: string | null | undefined): number | null {
  if (!header) return null;
  const raw = header.trim();
  if (raw === '') return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(raw);
  if (Number.isFinite(at)) {
    // A past date means "now"; a caller must not sleep backwards.
    return Math.max(0, at - Date.now());
  }
  return null;
}

/**
 * Read one bounded interval completely, or say exactly why not.
 *
 * WHY EVERY EARLY EXIT IS A NAMED OUTCOME. A loop can end for six reasons and
 * only one of them means the caller holds the whole interval. Collapsing the
 * other five into an error or a boolean is how a checkpoint advances past data
 * nobody read.
 */
export async function readCallGridInterval(
  request: IntervalReadRequest,
): Promise<IntervalReadResult> {
  const valid = validateInterval(request.since, request.until, request.maxSpanDays);
  if (!valid.ok) return refuse(request.since, request.until, valid.reason);

  const pageCap = request.maxPages && request.maxPages > 0 ? request.maxPages : INTERVAL_DEFAULT_MAX_PAGES;
  const retryBudget = request.maxRateLimitRetries ?? RATE_LIMIT_MAX_RETRIES;
  const sleep = request.sleep ?? defaultSleep;

  const events: InboundEvent[] = [];
  const refused: RefusedRecord[] = [];
  const seenCursors = new Set<string>();
  let cursor: unknown;
  let pages = 0;
  let records = 0;
  let rateLimitRetries = 0;
  let providerTotal: number | undefined;

  const stop = (outcome: IntervalReadOutcome, reason: string): IntervalReadResult => ({
    outcome,
    since: request.since,
    until: request.until,
    events,
    refused,
    pages,
    records,
    pageCap,
    rateLimitRetries,
    ...(cursor === undefined ? {} : { nextCursor: cursor }),
    ...(providerTotal === undefined ? {} : { providerTotal }),
    reason,
  });

  for (;;) {
    // --- one page, with bounded throttling patience ---------------------------
    let page;
    let attempt = 0;
    for (;;) {
      try {
        page = await fetchCallGridCallsPage(boundedPageOptions(request, cursor));
        break;
      } catch (error) {
        const throttled = error instanceof CallGridApiError && error.status === 429;
        if (!throttled) {
          // A MALFORMED RECORD, A BAD ENVELOPE OR A 500 IS NOT A TRANSIENT
          // FAILURE. Retrying a contract defect turns one bad answer into five,
          // and none of them gets better.
          const detail = error instanceof Error ? error.message : 'unknown provider failure';
          return stop('PROVIDER_ERROR', detail);
        }
        attempt += 1;
        rateLimitRetries += 1;
        if (attempt > retryBudget) {
          return stop(
            'RATE_LIMIT_EXHAUSTED',
            `CallGrid throttled this page ${attempt} times; the interval was not fully read`,
          );
        }
        const advised = retryAfterMs(error.retryAfter);
        await sleep(advised ?? RATE_LIMIT_BASE_DELAY_MS * 2 ** (attempt - 1));
      }
    }

    pages += 1;
    records += page.records.length;
    if (typeof page.totalCount === 'number' && Number.isFinite(page.totalCount)) {
      providerTotal = page.totalCount;
    }

    // --- map, partitioning refusals instead of losing the page ----------------
    for (const record of page.records) {
      try {
        events.push(mapCallGridApiRecord(record));
      } catch (error) {
        // NEITHER DROPPED NOR FATAL. A record with no id or no occurrence is
        // refused by the shipped contract and stays refused -- PR #178's rule is
        // untouched -- but one such record does not make the other 4,238
        // unreadable. It is counted, located and reported.
        refused.push({
          page: pages,
          reason: error instanceof Error ? error.message : 'unmappable provider record',
          ...(error instanceof CallGridApiError ? { kind: error.kind } : {}),
        });
      }
    }

    const nextKey = cursorKey(page.nextCursor);

    // --- did the provider prove exhaustion? -----------------------------------
    if (!page.hasMore) {
      cursor = undefined;
      return stop('COMPLETE', 'the provider reported no further pages');
    }
    if (page.nextCursor === undefined || page.nextCursor === null) {
      // MORE WITHOUT A WAY TO ASK FOR IT. Treating this as the end would be a
      // guess, and the guess would silently drop everything after it.
      return stop(
        'INVALID_PAGINATION',
        'the provider reported more pages but supplied no cursor to reach them',
      );
    }
    if (seenCursors.has(nextKey)) {
      return stop('INVALID_PAGINATION', 'the provider returned a cursor it had already returned');
    }
    seenCursors.add(nextKey);
    cursor = page.nextCursor;

    if (pages >= pageCap) {
      return stop(
        'TRUNCATED',
        `the ${pageCap}-page budget was reached while CallGrid still had pages; what was read is a lower bound`,
      );
    }
  }
}

/**
 * Whether the interval may be treated as the whole population.
 *
 * The one question a checkpoint may ask, expressed once so no caller writes its
 * own version of it. Note that a COMPLETE read MAY carry refusals: a record the
 * mapper could not accept is an ingestion problem, not a gap in the read.
 */
export function intervalWasComplete(result: IntervalReadResult): boolean {
  return result.outcome === 'COMPLETE';
}
