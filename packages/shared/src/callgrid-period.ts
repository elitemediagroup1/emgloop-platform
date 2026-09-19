// CallGrid reporting PERIODS — Daily, Weekly and Monthly, each anchored on one
// Eastern calendar date, with the navigation between them. Pure: `now` is injected.
//
// A period is a way of CHOOSING a window, not a second window definition. Every
// period resolves through `resolveCallGridWindow` (callgrid-window.ts), so the
// boundaries, the live/completed flags and — above all — the comparison rule are
// the ones every CallGrid surface already uses:
//
//   • a period still in progress (today, this week, this month) is compared with
//     the prior period CUT AT THE SAME ELAPSED POINT, never with the whole of it;
//   • a finished period is compared with the finished period of the same kind
//     immediately before it (the day before, the prior Mon–Sun week, the prior
//     calendar month).
//
// The one place this module goes beyond a preset is a past calendar month: a
// custom range would compare it with "the preceding N days", which for a 31-day
// month starts a day inside the month before last. It is compared with the prior
// calendar month instead, and says so.
//
// The legacy `?range=` presets keep working everywhere; a URL carries either a
// period (`?period=weekly&date=2026-09-14`) or a range, and a period wins.

import { easternYmd, type EasternYmd } from './business-time';
import {
  resolveCallGridWindow, parseCallGridRange, callGridRangeQuery,
  type CallGridWindow,
} from './callgrid-window';

export const CALLGRID_PERIODS = ['daily', 'weekly', 'monthly'] as const;
export type CallGridPeriod = (typeof CALLGRID_PERIODS)[number];

export const CALLGRID_PERIOD_LABELS: Readonly<Record<CallGridPeriod, string>> = Object.freeze({
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly',
});

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY = 86_400_000;

// --- Calendar arithmetic on Eastern dates (a UTC cursor, which has no DST) -----

function toUtc(d: EasternYmd): number {
  return Date.UTC(d.year, d.month - 1, d.day);
}
function fromUtc(ms: number): EasternYmd {
  const d = new Date(ms);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}
function addDays(d: EasternYmd, n: number): EasternYmd {
  return fromUtc(toUtc(d) + n * DAY);
}
function addMonths(d: EasternYmd, n: number): EasternYmd {
  const total = d.year * 12 + (d.month - 1) + n;
  return { year: Math.floor(total / 12), month: (total % 12) + 1, day: 1 };
}
function daysIn(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
function cmp(a: EasternYmd, b: EasternYmd): number {
  return toUtc(a) - toUtc(b);
}
export function ymdString(d: EasternYmd): string {
  return `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
}
function parseYmd(raw: string | null | undefined): EasternYmd | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((raw ?? '').trim());
  if (!m) return null;
  const d = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  if (d.month < 1 || d.month > 12 || d.day < 1 || d.day > daysIn(d.year, d.month)) return null;
  return d;
}

/** The Monday of the Mon–Sun week containing `d` (CallGrid weeks, as `this_week`). */
function weekStart(d: EasternYmd): EasternYmd {
  const weekday = new Date(toUtc(d)).getUTCDay(); // 0 = Sunday
  return addDays(d, -((weekday + 6) % 7));
}
function monthStart(d: EasternYmd): EasternYmd {
  return { year: d.year, month: d.month, day: 1 };
}

// --- The selection ----------------------------------------------------------------

export interface CallGridPeriodSelection {
  readonly period: CallGridPeriod;
  /** The first Eastern day of the period (the day, the Monday, the 1st). */
  readonly start: EasternYmd;
  /** True when the period contains today — it is in progress. */
  readonly current: boolean;
}

/**
 * Normalize a requested period and date. Unknown periods are Daily; a missing,
 * malformed or future date is the current period. Never throws.
 */
export function selectCallGridPeriod(
  params: { period?: string | null; date?: string | null },
  now: Date,
): CallGridPeriodSelection {
  const period: CallGridPeriod = (CALLGRID_PERIODS as readonly string[]).includes((params.period ?? '').trim())
    ? ((params.period ?? '').trim() as CallGridPeriod)
    : 'daily';
  const today = easternYmd(now);
  const requested = parseYmd(params.date);
  const anchor = requested && cmp(requested, today) <= 0 ? requested : today;
  const start = period === 'daily' ? anchor : period === 'weekly' ? weekStart(anchor) : monthStart(anchor);
  const currentStart = period === 'daily' ? today : period === 'weekly' ? weekStart(today) : monthStart(today);
  return { period, start, current: cmp(start, currentStart) === 0 };
}

/**
 * The window for a period — through the ONE window contract. A period in progress
 * uses the live preset (elapsed-matched comparison); the period just before it
 * uses its named preset; anything older is a custom range, with a past month
 * compared against the prior calendar month.
 */
export function callGridPeriodWindow(sel: CallGridPeriodSelection, now: Date): CallGridWindow {
  const today = easternYmd(now);
  if (sel.period === 'daily') {
    if (sel.current) return resolveCallGridWindow({ preset: 'today' }, now);
    if (cmp(sel.start, addDays(today, -1)) === 0) return resolveCallGridWindow({ preset: 'yesterday' }, now);
    const s = ymdString(sel.start);
    return resolveCallGridWindow({ preset: 'custom', start: s, end: s }, now);
  }
  if (sel.period === 'weekly') {
    if (sel.current) return resolveCallGridWindow({ preset: 'this_week' }, now);
    if (cmp(sel.start, addDays(weekStart(today), -7)) === 0) return resolveCallGridWindow({ preset: 'last_week' }, now);
    return resolveCallGridWindow({ preset: 'custom', start: ymdString(sel.start), end: ymdString(addDays(sel.start, 6)) }, now);
  }
  if (sel.current) return resolveCallGridWindow({ preset: 'this_month' }, now);
  if (cmp(sel.start, addMonths(monthStart(today), -1)) === 0) return resolveCallGridWindow({ preset: 'last_month' }, now);
  const last = { ...sel.start, day: daysIn(sel.start.year, sel.start.month) };
  const custom = resolveCallGridWindow({ preset: 'custom', start: ymdString(sel.start), end: ymdString(last) }, now);
  // The prior CALENDAR month, complete — not "the preceding N days".
  const prior = addMonths(sel.start, -1);
  const priorWindow = resolveCallGridWindow(
    { preset: 'custom', start: ymdString(prior), end: ymdString({ ...prior, day: daysIn(prior.year, prior.month) }) },
    now,
  );
  return {
    ...custom,
    comparisonStart: priorWindow.start,
    comparisonEnd: priorWindow.end,
    comparisonBasis: 'complete_period',
    comparisonLabel: 'The prior month',
  };
}

/** The period's own name, e.g. "Fri, Sep 18, 2026", "Sep 14 – 20, 2026", "September 2026". */
export function callGridPeriodLabel(sel: CallGridPeriodSelection): string {
  const s = sel.start;
  if (sel.period === 'daily') {
    const weekday = WEEKDAYS_SHORT[new Date(toUtc(s)).getUTCDay()]!;
    return `${weekday}, ${MONTHS_SHORT[s.month - 1]} ${s.day}, ${s.year}`;
  }
  if (sel.period === 'weekly') {
    const e = addDays(s, 6);
    if (s.year !== e.year) return `${MONTHS_SHORT[s.month - 1]} ${s.day}, ${s.year} – ${MONTHS_SHORT[e.month - 1]} ${e.day}, ${e.year}`;
    if (s.month !== e.month) return `${MONTHS_SHORT[s.month - 1]} ${s.day} – ${MONTHS_SHORT[e.month - 1]} ${e.day}, ${e.year}`;
    return `${MONTHS_SHORT[s.month - 1]} ${s.day} – ${e.day}, ${e.year}`;
  }
  return `${MONTHS[s.month - 1]} ${s.year}`;
}

/**
 * The query for a period. The current period carries no date, so a bookmark of
 * "this week" stays this week; a past one names its first day.
 */
export function callGridPeriodQuery(period: CallGridPeriod, start: EasternYmd | null): string {
  return start ? `period=${period}&date=${ymdString(start)}` : `period=${period}`;
}

export interface CallGridPeriodNav {
  /** Query for the period before. Always defined — there is always a past. */
  readonly prevQuery: string;
  /** Query for the period after, or null when this period is the current one. */
  readonly nextQuery: string | null;
  /** Query for the current period of the same kind, or null when already there. */
  readonly currentQuery: string | null;
  /** The same date viewed as each period, so switching Daily → Weekly keeps the reader's place. */
  readonly switchQuery: Readonly<Record<CallGridPeriod, string>>;
}

export function callGridPeriodNav(sel: CallGridPeriodSelection, now: Date): CallGridPeriodNav {
  const step = (n: number): EasternYmd =>
    sel.period === 'daily' ? addDays(sel.start, n) : sel.period === 'weekly' ? addDays(sel.start, 7 * n) : addMonths(sel.start, n);
  const queryFor = (period: CallGridPeriod, anchor: EasternYmd): string => {
    const s = selectCallGridPeriod({ period, date: ymdString(anchor) }, now);
    return callGridPeriodQuery(period, s.current ? null : s.start);
  };
  // Switching keeps the reader's place: the day they were on, or the first day of
  // the week or month they were on (today, when that period is the current one).
  const today = easternYmd(now);
  const place = sel.current ? today : sel.start;
  return {
    prevQuery: queryFor(sel.period, step(-1)),
    nextQuery: sel.current ? null : queryFor(sel.period, step(1)),
    currentQuery: sel.current ? null : callGridPeriodQuery(sel.period, null),
    switchQuery: {
      daily: queryFor('daily', place),
      weekly: queryFor('weekly', place),
      monthly: queryFor('monthly', place),
    },
  };
}

// --- One reader for every CallGrid URL ---------------------------------------------------

export interface CallGridSelection {
  /** The resolved reporting window. */
  readonly window: CallGridWindow;
  /** The period, or null when the URL carried a legacy `range` (custom or preset). */
  readonly period: CallGridPeriodSelection | null;
  /** How to put this selection on every CallGrid link, so it survives navigation. */
  readonly query: string;
  /** The selection's own name for the header. */
  readonly label: string;
  /** Period navigation; null for a legacy range. */
  readonly nav: CallGridPeriodNav | null;
}

/**
 * Read the reporting selection from a CallGrid URL.
 *
 * `period`/`date` win. A URL with only a legacy `range` (a bookmark, a link from
 * Home, a custom range) resolves exactly as it always did. A URL with neither is
 * today, Daily.
 */
export function readCallGridSelection(
  params: Readonly<Record<string, string | string[] | undefined>> | undefined,
  now: Date,
): CallGridSelection {
  const one = (key: string): string | undefined => {
    const v = params?.[key];
    return typeof v === 'string' ? v : Array.isArray(v) ? v[0] : undefined;
  };
  const periodParam = one('period');
  const rangeParam = one('range');
  if (!periodParam && rangeParam) {
    const range = parseCallGridRange({ range: rangeParam, s: one('s'), e: one('e') });
    const window = resolveCallGridWindow(range, now);
    return {
      window,
      period: null,
      query: callGridRangeQuery(window.preset, { start: range.start, end: range.end }),
      label: window.label,
      nav: null,
    };
  }
  const sel = selectCallGridPeriod({ period: periodParam, date: one('date') }, now);
  return {
    window: callGridPeriodWindow(sel, now),
    period: sel,
    query: callGridPeriodQuery(sel.period, sel.current ? null : sel.start),
    label: callGridPeriodLabel(sel),
    nav: callGridPeriodNav(sel, now),
  };
}
