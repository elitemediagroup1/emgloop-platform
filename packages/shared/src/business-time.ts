// EMG Loop — the authoritative business timezone.
//
// Every business-reporting boundary (today/yesterday, start/end of day, reporting
// windows, dashboard + CallGrid metric periods, activity/completion dates as they
// are attributed to a business day) MUST be derived here. This is the ONE source
// of truth — no page, service, provider, query, or component may pick its own
// timezone for reporting.
//
// The identifier is an IANA zone, never a fixed offset: Eastern alternates between
// EST (UTC-5) and EDT (UTC-4) across daylight saving. DST is handled by the
// platform's Intl/ICU timezone database — never computed by hand here.
//
// UTC remains the persistence format for timestamps. These helpers convert those
// UTC instants into Eastern to decide which business day they belong to.

export const BUSINESS_TIME_ZONE = 'America/New_York';

/** Human-facing label. UI copy may say this; all math uses BUSINESS_TIME_ZONE. */
export const BUSINESS_TIME_ZONE_LABEL = 'Eastern Time';

export interface EasternYmd {
  year: number;
  month: number; // 1-12
  day: number;
}

/** Half-open reporting window [start, end) as UTC instants derived in Eastern. */
export interface DayWindow {
  start: Date;
  end: Date;
}

// The offset (minutes east of UTC) that `timeZone` is at `instant`. Intl/ICU
// knows DST, so this returns -300 during EST and -240 during EDT automatically.
function offsetMinutes(instant: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p: Record<string, number> = {};
  for (const part of dtf.formatToParts(instant)) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  const wallAsUtc = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
  return Math.round((wallAsUtc - instant.getTime()) / 60000);
}

/** The UTC instant of a given Eastern wall-clock date/time, DST-aware. */
export function easternWallTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  ms = 0,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  const off1 = offsetMinutes(new Date(naive), BUSINESS_TIME_ZONE);
  let utc = naive - off1 * 60000;
  // Re-check at the candidate: on a DST-transition day the offset can differ.
  const off2 = offsetMinutes(new Date(utc), BUSINESS_TIME_ZONE);
  if (off2 !== off1) utc = naive - off2 * 60000;
  return new Date(utc);
}

/** The Eastern calendar date an instant falls on. */
export function easternYmd(instant: Date): EasternYmd {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const p: Record<string, number> = {};
  for (const part of dtf.formatToParts(instant)) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  return { year: p.year!, month: p.month!, day: p.day! };
}

/** The Eastern wall-clock time of day at `instant`. */
export interface EasternTimeOfDay {
  hour: number; // 0-23
  minute: number;
  second: number;
  ms: number;
}

/**
 * The Eastern wall-clock time of day at `instant`.
 *
 * Used to anchor an elapsed-matched comparison window: "yesterday through the
 * same time" must mean the same WALL-CLOCK time, not the same number of elapsed
 * milliseconds — on a DST-transition day those differ by an hour, and matching
 * raw elapsed time would silently compare 14 hours of today against 13 or 15
 * hours of yesterday. Hour and minute come from ICU (DST-aware); second and
 * millisecond carry straight through because zone offsets are whole minutes.
 */
export function easternTimeOfDay(instant: Date): EasternTimeOfDay {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TIME_ZONE,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p: Record<string, number> = {};
  for (const part of dtf.formatToParts(instant)) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  return { hour: p.hour!, minute: p.minute!, second: p.second!, ms: instant.getUTCMilliseconds() };
}

/** The Eastern wall-clock hour (0-23) at `instant` — for time-of-day greetings. */
export function easternHour(instant: Date): number {
  const s = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TIME_ZONE,
    hour: '2-digit',
    hourCycle: 'h23',
  }).format(instant);
  return Number(s);
}

/** 00:00:00.000 Eastern of the business day `instant` belongs to (as a UTC instant). */
export function startOfEasternDay(instant: Date): Date {
  const { year, month, day } = easternYmd(instant);
  return easternWallTimeToUtc(year, month, day, 0, 0, 0, 0);
}

/** Start of the NEXT Eastern day. (+36h always lands in the next Eastern day, even across DST, then floor.) */
export function startOfNextEasternDay(instant: Date): Date {
  const start = startOfEasternDay(instant);
  return startOfEasternDay(new Date(start.getTime() + 36 * 3600 * 1000));
}

/** Start of the PREVIOUS Eastern day. (-12h lands in the previous Eastern day, then floor.) */
export function startOfPreviousEasternDay(instant: Date): Date {
  const start = startOfEasternDay(instant);
  return startOfEasternDay(new Date(start.getTime() - 12 * 3600 * 1000));
}

/** 23:59:59.999 Eastern of the business day `instant` belongs to (inclusive last instant). */
export function endOfEasternDay(instant: Date): Date {
  return new Date(startOfNextEasternDay(instant).getTime() - 1);
}

/**
 * YESTERDAY reporting window: the previous, COMPLETED Eastern business day,
 * as half-open [prevDay 00:00 ET, today 00:00 ET).
 */
export function easternYesterdayWindow(now: Date): DayWindow {
  return { start: startOfPreviousEasternDay(now), end: startOfEasternDay(now) };
}

/**
 * TODAY reporting window: the LIVE, in-progress Eastern business day,
 * as half-open [today 00:00 ET, now).
 */
export function easternTodayWindow(now: Date): DayWindow {
  return { start: startOfEasternDay(now), end: now };
}

/** A period and the equal-length period immediately before it. */
export interface ComparisonWindows {
  /** The most recent COMPLETE span. Never includes the in-progress day. */
  current: DayWindow;
  /** The equal-length span immediately before `current`. */
  prior: DayWindow;
}

/**
 * The trailing `days` COMPLETE Eastern days, and the equal span before them.
 *
 * COMPLETE MEANS COMPLETE. Both windows end on an Eastern midnight boundary and
 * neither can touch the in-progress day, because comparing a partial period
 * against a whole one is the defect that made "Today" report an ~85% revenue
 * collapse every morning until PR #149. A caller that wants live data must ask
 * for it explicitly somewhere else; it can never arrive through this function.
 *
 * Boundaries are walked one Eastern day at a time rather than subtracting
 * `days * 86_400_000`, because a DST transition day is 23 or 25 hours long and
 * millisecond arithmetic would silently shift every boundary by an hour twice a
 * year — which shows up as a phantom change in whatever is being compared.
 */
export function easternTrailingCompleteWindows(now: Date, days: number): ComparisonWindows {
  const span = Math.max(1, Math.floor(days));
  // The first instant of today Eastern is the first instant that is NOT complete.
  const currentEnd = startOfEasternDay(now);
  const currentStart = shiftBackEasternDays(currentEnd, span);
  const priorStart = shiftBackEasternDays(currentStart, span);
  return {
    current: { start: currentStart, end: currentEnd },
    prior: { start: priorStart, end: currentStart },
  };
}

/** `count` Eastern days earlier than `instant`, one calendar day at a time. */
function shiftBackEasternDays(instant: Date, count: number): Date {
  let cursor = startOfEasternDay(instant);
  for (let i = 0; i < count; i += 1) cursor = startOfPreviousEasternDay(cursor);
  return cursor;
}

// --- Business dates ------------------------------------------------------------
//
// A BUSINESS DATE is a calendar day in Eastern, written 'YYYY-MM-DD'. It is the
// unit an observation ledger certifies and the unit a comparison window is made
// of, so the two must be derived from the SAME helpers or a window could be
// measured over instants nobody certified. That is why these live here rather
// than beside either consumer.

/** A calendar day in the business timezone, 'YYYY-MM-DD'. Never a UTC date. */
export type BusinessDate = string;

const BUSINESS_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Whether `value` is a syntactically valid business date. Fails closed. */
export function isBusinessDate(value: unknown): value is BusinessDate {
  return typeof value === 'string' && BUSINESS_DATE_PATTERN.test(value);
}

/** The Eastern business date `instant` belongs to. */
export function easternBusinessDate(instant: Date): BusinessDate {
  const { year, month, day } = easternYmd(instant);
  return (
    String(year).padStart(4, '0') +
    '-' +
    String(month).padStart(2, '0') +
    '-' +
    String(day).padStart(2, '0')
  );
}

/**
 * The half-open UTC interval [start, end) covering one Eastern business date.
 *
 * DST-CORRECT BY CONSTRUCTION. The end is the start of the NEXT Eastern day, not
 * start + 24h, so the spring-forward day is 23 hours and the fall-back day is 25.
 * Adding a fixed 86_400_000 would silently drop an hour of calls from one day a
 * year and double-count an hour on another, and both would present as a real
 * change in whatever was measured over them.
 */
export function easternBusinessDayWindow(date: BusinessDate): DayWindow {
  if (!isBusinessDate(date)) {
    throw new Error(`Not a business date: ${String(date)} (expected YYYY-MM-DD)`);
  }
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  const start = easternWallTimeToUtc(year, month, day, 0, 0, 0, 0);
  return { start, end: startOfNextEasternDay(start) };
}

/**
 * Every complete Eastern business date inside `window`, in order.
 *
 * The window is half-open, so a window ending exactly at an Eastern midnight
 * yields the day BEFORE that boundary as its last entry and never the boundary
 * day itself — which is what makes this agree with
 * `easternTrailingCompleteWindows`, whose windows always end on one.
 *
 * Walked one Eastern day at a time for the same DST reason as the windows.
 */
export function easternBusinessDatesIn(window: DayWindow): BusinessDate[] {
  const dates: BusinessDate[] = [];
  let cursor = startOfEasternDay(window.start);
  // A hard bound so a malformed window can never spin. 400 days is far beyond
  // any comparison this platform makes and still terminates immediately.
  for (let guard = 0; guard < 400 && cursor.getTime() < window.end.getTime(); guard += 1) {
    dates.push(easternBusinessDate(cursor));
    cursor = startOfNextEasternDay(cursor);
  }
  return dates;
}

/**
 * A half-open range of business dates: [effectiveFrom, effectiveTo).
 *
 * The shape every effective-dated declaration in the platform shares. Half-open
 * for the same reason `DayWindow` is: two adjacent ranges must meet without
 * overlapping, and a closed upper bound makes "the day it changed" belong to
 * both. `effectiveTo === null` means still in force.
 */
export interface EffectiveDateRange {
  effectiveFrom: BusinessDate;
  /** EXCLUSIVE. Null means open-ended. */
  effectiveTo: BusinessDate | null;
}

/**
 * Whether a range is in force on one business date.
 *
 * String comparison is correct and deliberate: a business date is
 * zero-padded 'YYYY-MM-DD', so lexical order IS calendar order, and comparing
 * strings avoids constructing a Date — which would drag a timezone into a
 * question that has none. Fails closed on a malformed date.
 */
export function isEffectiveOn(range: EffectiveDateRange, on: BusinessDate): boolean {
  if (!isBusinessDate(on) || !isBusinessDate(range.effectiveFrom)) return false;
  if (range.effectiveTo !== null && !isBusinessDate(range.effectiveTo)) return false;
  if (on < range.effectiveFrom) return false;
  return range.effectiveTo === null || on < range.effectiveTo;
}

/** Whether a range is well formed. An empty or inverted range is a defect. */
export function isEffectiveRangeValid(range: EffectiveDateRange): boolean {
  if (!isBusinessDate(range.effectiveFrom)) return false;
  if (range.effectiveTo === null) return true;
  return isBusinessDate(range.effectiveTo) && range.effectiveTo > range.effectiveFrom;
}

/**
 * Whether two half-open business-date ranges cover any date in common.
 *
 * PROMOTED FROM THE EXPECTATION REPOSITORY so the platform has ONE definition of
 * overlap. Two effective-dated tables now depend on it, and a second copy would
 * eventually disagree with the first about the boundary date -- which is the one
 * case that matters, because closing a declaration and opening its successor
 * produces exactly that adjacency. Half-open means [Aug 1, Sep 1) and
 * [Sep 1, NULL) touch at Sep 1 and overlap on NO date.
 *
 * A null upper bound is an unbounded future, so two open-ended ranges for the
 * same subject always overlap. Lexical comparison is calendar comparison for
 * zero-padded business dates; see `isEffectiveOn`.
 */
export function effectiveRangesOverlap(a: EffectiveDateRange, b: EffectiveDateRange): boolean {
  const aEndsAfterBStarts = a.effectiveTo === null || a.effectiveTo > b.effectiveFrom;
  const bEndsAfterAStarts = b.effectiveTo === null || b.effectiveTo > a.effectiveFrom;
  return aEndsAfterBStarts && bEndsAfterAStarts;
}

/**
 * What writing one effective-dated declaration would do to the ones already there.
 *
 * PURE, AND THE ONLY PLACE THIS IS DECIDED for any effective-dated table in the
 * platform. Provider member expectation and measurement source authority both use
 * it, and a third will: the reasoning is identical every time, and the failure
 * mode of copying it is that the copies disagree about the boundary date long
 * after anybody remembers there were two.
 *
 * The rules, and why each one:
 *
 * EQUIVALENT — an existing declaration already covers the whole new range and
 * says the same thing, so writing would split one interval into two identical
 * rows and put a second author on half of a statement one person made. What
 * "the same thing" means is the CALLER'S, because only the caller knows which of
 * its columns constitute the statement.
 *
 * BLOCKED on a declaration that starts ON OR AFTER the new one — making room
 * would mean deleting or re-dating somebody else's statement, and that is not a
 * write's decision to make.
 *
 * BLOCKED on more than one overlapping predecessor — under the database's
 * exclusion constraint that is impossible, so seeing it means the table has been
 * written around, and truncating several rows on a guess is not a repair.
 *
 * CREATE otherwise, ending the single earlier declaration at the new start date:
 * one column, written once, and everything it said about the dates it covered
 * stays exactly as it was.
 */
export type EffectiveDatedDecision<TRow> =
  | { kind: 'EQUIVALENT'; row: TRow }
  | { kind: 'BLOCKED'; problems: string[] }
  | { kind: 'CREATE'; predecessor: TRow | null };

export function decideEffectiveDatedWrite<TRow>(
  rows: readonly TRow[],
  candidate: EffectiveDateRange,
  rangeOf: (row: TRow) => EffectiveDateRange,
  /** Whether this row already says what the candidate says. Caller-defined. */
  saysTheSameThing: (row: TRow) => boolean,
): EffectiveDatedDecision<TRow> {
  const overlapping = rows.filter((row) => effectiveRangesOverlap(rangeOf(row), candidate));

  const equivalent = overlapping.find((row) => {
    if (!saysTheSameThing(row)) return false;
    const range = rangeOf(row);
    // It must also COVER the whole candidate range, not merely intersect it:
    // a shorter agreeing declaration leaves dates the candidate speaks for and
    // it does not.
    if (range.effectiveFrom > candidate.effectiveFrom) return false;
    if (range.effectiveTo === null) return true;
    return candidate.effectiveTo !== null && range.effectiveTo >= candidate.effectiveTo;
  });
  if (equivalent) return { kind: 'EQUIVALENT', row: equivalent };

  const laterOrSameStart = overlapping.filter(
    (row) => rangeOf(row).effectiveFrom >= candidate.effectiveFrom,
  );
  if (laterOrSameStart.length > 0) {
    return {
      kind: 'BLOCKED',
      problems: laterOrSameStart.map(
        (row) => `a declaration already starts on ${rangeOf(row).effectiveFrom}`,
      ),
    };
  }
  if (overlapping.length > 1) {
    return {
      kind: 'BLOCKED',
      problems: [`${overlapping.length} declarations are already in force`],
    };
  }
  return { kind: 'CREATE', predecessor: overlapping[0] ?? null };
}
