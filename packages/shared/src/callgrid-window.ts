// CallGrid reporting date-window contract — the ONE definition of every reporting
// preset and its comparison period. Pure and deterministic: `now` is injected, and
// every boundary is an Eastern (America/New_York) calendar boundary resolved
// through the shared business-time helpers (DST-aware). No page, service, or
// component may redefine a preset — they resolve it here.
//
// A window is half-open [start, end): `start` inclusive, `end` exclusive. Live
// presets (today, this week, this month, YTD, trailing-N-days) end at `now`;
// completed presets (yesterday, last week/2-weeks/month) end on a day boundary.

import {
  easternYmd, easternWallTimeToUtc, easternTimeOfDay,
  BUSINESS_TIME_ZONE, BUSINESS_TIME_ZONE_LABEL, type EasternYmd,
} from './business-time';

export const CALLGRID_PRESETS = [
  'today',
  'yesterday',
  'this_week',
  'last_2_days',
  'last_7_days',
  'last_14_days',
  'last_30_days',
  'last_week',
  'last_2_weeks',
  'this_month',
  'last_month',
  'year_to_date',
  'custom',
] as const;
export type CallGridPreset = (typeof CALLGRID_PRESETS)[number];

/** Preset display metadata for the picker, grouped as the spec's expanded panel. */
export const CALLGRID_PRESET_GROUPS: { group: string; items: { preset: CallGridPreset; label: string }[] }[] = [
  { group: 'Days', items: [
    { preset: 'last_2_days', label: 'Last 2 Days' },
    { preset: 'last_7_days', label: 'Last 7 Days' },
    { preset: 'last_14_days', label: 'Last 14 Days' },
    { preset: 'last_30_days', label: 'Last 30 Days' },
  ] },
  { group: 'Weeks', items: [
    { preset: 'last_week', label: 'Last Week' },
    { preset: 'last_2_weeks', label: 'Last 2 Weeks' },
  ] },
  { group: 'Months', items: [
    { preset: 'this_month', label: 'This Month' },
    { preset: 'last_month', label: 'Last Month' },
  ] },
  { group: 'Year', items: [
    { preset: 'year_to_date', label: 'Year to Date' },
  ] },
];

export const CALLGRID_PRESET_LABELS: Record<CallGridPreset, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  this_week: 'This Week',
  last_2_days: 'Last 2 Days',
  last_7_days: 'Last 7 Days',
  last_14_days: 'Last 14 Days',
  last_30_days: 'Last 30 Days',
  last_week: 'Last Week',
  last_2_weeks: 'Last 2 Weeks',
  this_month: 'This Month',
  last_month: 'Last Month',
  year_to_date: 'Year to Date',
  custom: 'Custom',
};

/**
 * How the comparison window was built.
 *
 * `elapsed_matched` — the selected window is still in progress, so the comparison
 *   is cut at the SAME wall-clock point of its own period. "Today so far" is
 *   compared against "yesterday to the same time", never against all of yesterday.
 * `complete_period` — the selected window is a finished period, compared against
 *   the equally-long finished period immediately before it.
 * `none` — no comparison is defined.
 */
export type CallGridComparisonBasis = 'elapsed_matched' | 'complete_period' | 'none';

export interface CallGridWindow {
  start: Date;
  end: Date;
  timezone: string; // always America/New_York
  preset: CallGridPreset;
  comparisonStart: Date | null;
  comparisonEnd: Date | null;
  /** How the comparison was cut — the difference between an honest and a fake delta. */
  comparisonBasis: CallGridComparisonBasis;
  /** Plain description of the comparison period, e.g. "Yesterday to the same time". */
  comparisonLabel: string | null;
  label: string; // e.g. "Jul 22, 2026" or "Jul 16 – Jul 22, 2026"
  /** True when the window's last included day is the current Eastern day. */
  includesLiveData: boolean;
  /** True when the window spans exactly one Eastern calendar day. */
  isSingleDay: boolean;
  /** True when the window is a finished period (no live data inside it). */
  isCompleted: boolean;
  /** False when the requested range was malformed and we fell back to Today. */
  isValid: boolean;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY = 24 * 60 * 60 * 1000;

// --- Eastern calendar arithmetic (via a UTC cursor, which has no DST) ---------
function shiftDays(ymd: EasternYmd, delta: number): EasternYmd {
  const d = new Date(Date.UTC(ymd.year, ymd.month - 1, ymd.day) + delta * DAY);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}
function weekdayOf(ymd: EasternYmd): number {
  return new Date(Date.UTC(ymd.year, ymd.month - 1, ymd.day)).getUTCDay(); // 0=Sun..6=Sat
}
function firstOfMonth(ymd: EasternYmd): EasternYmd {
  return { year: ymd.year, month: ymd.month, day: 1 };
}
function prevMonth(first: EasternYmd): EasternYmd {
  return first.month === 1 ? { year: first.year - 1, month: 12, day: 1 } : { year: first.year, month: first.month - 1, day: 1 };
}
function dayStart(ymd: EasternYmd): Date {
  return easternWallTimeToUtc(ymd.year, ymd.month, ymd.day, 0, 0, 0, 0);
}
function fmt(ymd: EasternYmd): string {
  return `${MONTHS[ymd.month - 1]} ${ymd.day}, ${ymd.year}`;
}
/** The last Eastern calendar day included in a half-open window ending at `end`. */
function lastIncludedYmd(end: Date): EasternYmd {
  return easternYmd(new Date(end.getTime() - 1));
}
function rangeLabel(start: Date, end: Date, startYmd: EasternYmd): string {
  const endYmd = lastIncludedYmd(end);
  if (startYmd.year === endYmd.year && startYmd.month === endYmd.month && startYmd.day === endYmd.day) {
    return fmt(startYmd);
  }
  const sameYear = startYmd.year === endYmd.year;
  const left = sameYear ? `${MONTHS[startYmd.month - 1]} ${startYmd.day}` : fmt(startYmd);
  return `${left} – ${fmt(endYmd)}`;
}

function sameYmdPair(a: EasternYmd, b: EasternYmd): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
/** The instant of `now`'s Eastern wall-clock time of day, on the Eastern day `ymd`.
 *  DST-safe: it re-anchors to the wall clock, not to elapsed milliseconds. */
function wallClockOn(ymd: EasternYmd, now: Date): Date {
  const t = easternTimeOfDay(now);
  return easternWallTimeToUtc(ymd.year, ymd.month, ymd.day, t.hour, t.minute, t.second, t.ms);
}
/** Whole Eastern calendar days from `from` to `to`, inclusive of both ends. */
function inclusiveDaySpan(from: EasternYmd, to: EasternYmd): number {
  const a = Date.UTC(from.year, from.month - 1, from.day);
  const b = Date.UTC(to.year, to.month - 1, to.day);
  return Math.round((b - a) / DAY) + 1;
}

function parseYmd(s: string | undefined): EasternYmd | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

// --- Window construction -----------------------------------------------------

interface RawWindow {
  preset: CallGridPreset;
  start: Date;
  end: Date;
  startYmd: EasternYmd;
  comparisonStart: Date | null;
  comparisonEnd: Date | null;
  comparisonBasis: CallGridComparisonBasis;
  comparisonLabel: string | null;
  isValid?: boolean;
}

/** Finish a raw window: derive the live/single-day/completed flags and the label. */
function build(raw: RawWindow, now: Date): CallGridWindow {
  const today = easternYmd(now);
  const firstDay = easternYmd(raw.start);
  const lastDay = lastIncludedYmd(raw.end);
  const includesLiveData = sameYmdPair(lastDay, today);
  return {
    start: raw.start,
    end: raw.end,
    timezone: BUSINESS_TIME_ZONE,
    preset: raw.preset,
    comparisonStart: raw.comparisonStart,
    comparisonEnd: raw.comparisonEnd,
    comparisonBasis: raw.comparisonBasis,
    comparisonLabel: raw.comparisonLabel,
    label: rangeLabel(raw.start, raw.end, raw.startYmd),
    includesLiveData,
    isSingleDay: sameYmdPair(firstDay, lastDay),
    isCompleted: !includesLiveData,
    isValid: raw.isValid ?? true,
  };
}

/**
 * A trailing-N-Eastern-day window ending at `now` (so it is N-1 complete days plus
 * the elapsed part of today), compared against the immediately preceding N-day
 * period **cut at the same wall-clock time**.
 *
 * This elapsed match is the whole point. Comparing a partial window against N
 * COMPLETE prior days manufactures a decline that is really just the clock — at
 * 9am "Today" would read -85% against a full yesterday every single morning. The
 * economics source accepts arbitrary instants, so there is no reason to accept
 * that distortion. N=1 is Today vs yesterday-to-the-same-time.
 */
function trailingDays(today: EasternYmd, now: Date, n: number, preset: CallGridPreset): RawWindow {
  const startYmd = shiftDays(today, -(n - 1));
  return {
    preset,
    start: dayStart(startYmd),
    end: now,
    startYmd,
    comparisonStart: dayStart(shiftDays(startYmd, -n)),
    comparisonEnd: wallClockOn(shiftDays(today, -n), now),
    comparisonBasis: 'elapsed_matched',
    comparisonLabel: n === 1 ? 'Yesterday to the same time' : `The previous ${n} days to the same time`,
  };
}

/**
 * Resolve a preset (or custom range) into a fully-specified window with its
 * comparison period. Every boundary is Eastern. A malformed custom range falls
 * back to Today and reports `isValid: false` rather than failing silently.
 */
export function resolveCallGridWindow(
  input: { preset: CallGridPreset; start?: string; end?: string },
  now: Date,
): CallGridWindow {
  const today = easternYmd(now);

  switch (input.preset) {
    case 'today':
      return build(trailingDays(today, now, 1, 'today'), now);
    case 'last_2_days': return build(trailingDays(today, now, 2, 'last_2_days'), now);
    case 'last_7_days': return build(trailingDays(today, now, 7, 'last_7_days'), now);
    case 'last_14_days': return build(trailingDays(today, now, 14, 'last_14_days'), now);
    case 'last_30_days': return build(trailingDays(today, now, 30, 'last_30_days'), now);

    case 'yesterday': {
      const y = shiftDays(today, -1);
      return build({
        preset: 'yesterday',
        start: dayStart(y), end: dayStart(today), startYmd: y,
        comparisonStart: dayStart(shiftDays(today, -2)), comparisonEnd: dayStart(y),
        comparisonBasis: 'complete_period', comparisonLabel: 'The day before',
      }, now);
    }
    case 'this_week': {
      const offset = (weekdayOf(today) + 6) % 7; // days since Monday
      const weekStartYmd = shiftDays(today, -offset);
      // Comparison: last week cut at the same weekday and wall-clock time.
      return build({
        preset: 'this_week',
        start: dayStart(weekStartYmd), end: now, startYmd: weekStartYmd,
        comparisonStart: dayStart(shiftDays(weekStartYmd, -7)),
        comparisonEnd: wallClockOn(shiftDays(today, -7), now),
        comparisonBasis: 'elapsed_matched', comparisonLabel: 'Last week to the same point',
      }, now);
    }
    case 'last_week': {
      const offset = (weekdayOf(today) + 6) % 7;
      const weekStartYmd = shiftDays(today, -offset);
      const lwStartYmd = shiftDays(weekStartYmd, -7);
      return build({
        preset: 'last_week',
        start: dayStart(lwStartYmd), end: dayStart(weekStartYmd), startYmd: lwStartYmd,
        comparisonStart: dayStart(shiftDays(weekStartYmd, -14)), comparisonEnd: dayStart(lwStartYmd),
        comparisonBasis: 'complete_period', comparisonLabel: 'The prior week',
      }, now);
    }
    case 'last_2_weeks': {
      const offset = (weekdayOf(today) + 6) % 7;
      const weekStartYmd = shiftDays(today, -offset);
      const startYmd = shiftDays(weekStartYmd, -14);
      return build({
        preset: 'last_2_weeks',
        start: dayStart(startYmd), end: dayStart(weekStartYmd), startYmd,
        comparisonStart: dayStart(shiftDays(weekStartYmd, -28)), comparisonEnd: dayStart(startYmd),
        comparisonBasis: 'complete_period', comparisonLabel: 'The prior 2 weeks',
      }, now);
    }
    case 'this_month': {
      const monthStartYmd = firstOfMonth(today);
      const lastMonthStart = prevMonth(monthStartYmd);
      // Same day-of-month and wall clock last month, clamped when last month is
      // shorter (Mar 31 has no Feb 31 — it compares against Feb 28/29).
      const cmpDay = Math.min(today.day, daysInMonth(lastMonthStart.year, lastMonthStart.month));
      return build({
        preset: 'this_month',
        start: dayStart(monthStartYmd), end: now, startYmd: monthStartYmd,
        comparisonStart: dayStart(lastMonthStart),
        comparisonEnd: wallClockOn({ ...lastMonthStart, day: cmpDay }, now),
        comparisonBasis: 'elapsed_matched', comparisonLabel: 'Last month to the same point',
      }, now);
    }
    case 'last_month': {
      const monthStartYmd = firstOfMonth(today);
      const lmStartYmd = prevMonth(monthStartYmd);
      return build({
        preset: 'last_month',
        start: dayStart(lmStartYmd), end: dayStart(monthStartYmd), startYmd: lmStartYmd,
        comparisonStart: dayStart(prevMonth(lmStartYmd)), comparisonEnd: dayStart(lmStartYmd),
        comparisonBasis: 'complete_period', comparisonLabel: 'The prior month',
      }, now);
    }
    case 'year_to_date': {
      const yearStartYmd: EasternYmd = { year: today.year, month: 1, day: 1 };
      const priorYear = today.year - 1;
      // Same calendar date and wall clock last year (Feb 29 clamps to Feb 28).
      const cmpDay = Math.min(today.day, daysInMonth(priorYear, today.month));
      return build({
        preset: 'year_to_date',
        start: dayStart(yearStartYmd), end: now, startYmd: yearStartYmd,
        comparisonStart: dayStart({ year: priorYear, month: 1, day: 1 }),
        comparisonEnd: wallClockOn({ year: priorYear, month: today.month, day: cmpDay }, now),
        comparisonBasis: 'elapsed_matched', comparisonLabel: 'Last year to the same point',
      }, now);
    }
    case 'custom': {
      const s = parseYmd(input.start);
      const e = parseYmd(input.end);
      if (!s || !e) {
        return { ...resolveCallGridWindow({ preset: 'today' }, now), isValid: false };
      }
      // Order-tolerant, inclusive end date.
      const a = Date.UTC(s.year, s.month - 1, s.day);
      const b = Date.UTC(e.year, e.month - 1, e.day);
      const [startD, lastRequested] = a <= b ? [s, e] : [e, s];
      const todayMs = Date.UTC(today.year, today.month - 1, today.day);
      const startMs = Date.UTC(startD.year, startD.month - 1, startD.day);
      // A range that starts in the future has no reportable period at all.
      if (startMs > todayMs) {
        return { ...resolveCallGridWindow({ preset: 'today' }, now), isValid: false };
      }
      // Never report past now: an end date of today (or later) ends at `now`.
      const lastMs = Date.UTC(lastRequested.year, lastRequested.month - 1, lastRequested.day);
      const endsToday = lastMs >= todayMs;
      const lastD = endsToday ? today : lastRequested;
      const span = inclusiveDaySpan(startD, lastD);

      if (endsToday) {
        // Live custom range: same elapsed-matched treatment as a trailing window.
        return build({
          preset: 'custom',
          start: dayStart(startD), end: now, startYmd: startD,
          comparisonStart: dayStart(shiftDays(startD, -span)),
          comparisonEnd: wallClockOn(shiftDays(today, -span), now),
          comparisonBasis: 'elapsed_matched',
          comparisonLabel: `The previous ${span} days to the same time`,
        }, now);
      }
      const start = dayStart(startD);
      const end = dayStart(shiftDays(lastD, 1)); // exclusive end = day after the last included day
      return build({
        preset: 'custom',
        start, end, startYmd: startD,
        comparisonStart: dayStart(shiftDays(startD, -span)), comparisonEnd: start,
        comparisonBasis: 'complete_period',
        comparisonLabel: `The preceding ${span} day${span === 1 ? '' : 's'}`,
      }, now);
    }
    default:
      return resolveCallGridWindow({ preset: 'today' }, now);
  }
}

// --- Live / completed presentation ------------------------------------------
// The ONE definition of how a window is described to the operator: whether it is
// live (in progress) or completed, its header line, its selected-period title and
// its comparison-period title. Pure — every CallGrid surface derives its status
// language here so the wording never drifts between Overview and a subpage.

const sameYmd = sameYmdPair;

/** Eastern wall-clock time of day, e.g. "2:30 PM" — used to state exactly where an
 *  in-progress window (and therefore its comparison) was cut. */
export function easternTimeLabel(instant: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TIME_ZONE, hour: 'numeric', minute: '2-digit',
  }).format(instant);
}

export type CallGridStatusWord = 'Live' | 'Completed' | 'Includes Live Data';

export interface CallGridWindowDescription {
  /** True when the window's last included day is the current Eastern day. */
  live: boolean;
  /** True when the window spans exactly one Eastern calendar day. */
  isSingleDay: boolean;
  statusWord: CallGridStatusWord;
  /** Full line for beneath the page title, e.g. "Today · Live · Jul 22, 2026 · Eastern Time". */
  headerLine: string;
  /** Selected-period section heading, e.g. "Today · Live" / "Jul 15, 2026 · Completed" / "Last 7 Days". */
  periodTitle: string;
  /** Comparison-period heading, e.g. "Yesterday · through 2:30 PM" / "Prior Week". */
  comparisonTitle: string;
  /** One plain sentence on how the comparison was cut, or null when there is none. */
  comparisonNote: string | null;
}

// Base comparison headings. For an in-progress window these are suffixed with the
// exact Eastern cut time, so the operator can see the comparison is like-for-like
// ("Yesterday · through 2:30 PM") rather than guessing whether a partial period is
// being measured against a complete one.
const COMPARISON_TITLES: Partial<Record<CallGridPreset, string>> = {
  today: 'Yesterday',
  last_2_days: 'Previous 2 Days',
  last_7_days: 'Previous 7 Days',
  last_14_days: 'Previous 14 Days',
  last_30_days: 'Previous 30 Days',
  this_week: 'Last Week',
  last_week: 'Prior Week',
  last_2_weeks: 'Prior 2 Weeks',
  this_month: 'Last Month',
  last_month: 'Prior Month',
  year_to_date: 'Last Year',
};

/** Describe a resolved window's live/completed status and its headings. `now` is
 *  injected so "today" is the current Eastern day (never a browser-local date). */
export function describeCallGridWindow(window: CallGridWindow, now: Date): CallGridWindowDescription {
  const today = easternYmd(now);
  const yesterday = shiftDays(today, -1);
  const firstDay = easternYmd(window.start);
  const lastDay = lastIncludedYmd(window.end);
  const isSingleDay = sameYmd(firstDay, lastDay);
  const isToday = isSingleDay && sameYmd(firstDay, today);
  const isYesterday = isSingleDay && sameYmd(firstDay, yesterday);
  // The last included day is today (live presets end at `now`; a range or custom
  // window whose final day is today also counts as containing live data).
  const live = sameYmd(lastDay, today);

  let statusWord: CallGridStatusWord;
  let headerLine: string;
  let periodTitle: string;

  if (isToday) {
    statusWord = 'Live';
    headerLine = `Today · Live · ${fmt(today)} · ${BUSINESS_TIME_ZONE_LABEL}`;
    periodTitle = 'Today · Live';
  } else if (isSingleDay) {
    statusWord = 'Completed';
    if (isYesterday) {
      headerLine = `Yesterday · Completed · ${fmt(firstDay)} · ${BUSINESS_TIME_ZONE_LABEL}`;
      periodTitle = 'Yesterday · Completed';
    } else {
      headerLine = `Completed · ${fmt(firstDay)} · ${BUSINESS_TIME_ZONE_LABEL}`;
      periodTitle = `${fmt(firstDay)} · Completed`;
    }
  } else if (live) {
    statusWord = 'Includes Live Data';
    headerLine = `${window.label} · Includes Live Data · ${BUSINESS_TIME_ZONE_LABEL}`;
    periodTitle = presetOrLabel(window);
  } else {
    statusWord = 'Completed';
    headerLine = `${window.label} · Completed · ${BUSINESS_TIME_ZONE_LABEL}`;
    periodTitle = presetOrLabel(window);
  }

  const baseComparison = isSingleDay && !isToday
    ? 'Previous Day'
    : COMPARISON_TITLES[window.preset] ?? 'Prior Period';

  // An in-progress window is compared against the same wall-clock point of the
  // prior period, and says so. Naming the cut time is what makes a delta on a
  // live window trustworthy rather than a function of what time it is.
  const elapsedMatched = window.comparisonBasis === 'elapsed_matched';
  const cutLabel = elapsedMatched && window.comparisonEnd ? easternTimeLabel(window.comparisonEnd) : null;
  const comparisonTitle = cutLabel ? `${baseComparison} · through ${cutLabel}` : baseComparison;

  let comparisonNote: string | null;
  if (window.comparisonBasis === 'none' || !window.comparisonEnd) {
    comparisonNote = null;
  } else if (elapsedMatched) {
    comparisonNote =
      `${baseComparison} is measured only up to ${cutLabel} ${BUSINESS_TIME_ZONE_LABEL} — the same point ` +
      `${isToday ? 'of the day' : 'of the period'} the selected window has reached — so the two periods cover the same elapsed time.`;
  } else {
    comparisonNote = `${baseComparison} is a complete period of the same length, so the two are directly comparable.`;
  }

  return { live, isSingleDay, statusWord, headerLine, periodTitle, comparisonTitle, comparisonNote };
}

/** The section title for a multi-day window: the preset's name, or the date range
 *  for a custom span. */
function presetOrLabel(window: CallGridWindow): string {
  return window.preset === 'custom' ? window.label : CALLGRID_PRESET_LABELS[window.preset];
}

function ymdQuery(ymd: EasternYmd): string {
  const s = `${ymd.year}-${String(ymd.month).padStart(2, '0')}-${String(ymd.day).padStart(2, '0')}`;
  return `range=custom&s=${s}&e=${s}`;
}

export interface CallGridDayNav {
  /** Query string for the previous Eastern calendar day. */
  prevQuery: string;
  /** Query string for the next Eastern calendar day, or null when the current day
   *  is today (Next Day is disabled — you cannot report a future day). */
  nextQuery: string | null;
}

/** Previous-/next-day navigation for a single-day window. Returns null for any
 *  multi-day range (the day arrows are hidden). Moving forward from a historical
 *  day eventually lands on Today (as the `today` preset, so it reads as Live). */
export function callGridDayNav(window: CallGridWindow, now: Date): CallGridDayNav | null {
  const today = easternYmd(now);
  const firstDay = easternYmd(window.start);
  const lastDay = lastIncludedYmd(window.end);
  if (!sameYmd(firstDay, lastDay)) return null; // not a single day

  const prevQuery = ymdQuery(shiftDays(firstDay, -1));
  if (sameYmd(firstDay, today)) {
    return { prevQuery, nextQuery: null }; // Next Day disabled on Today
  }
  const next = shiftDays(firstDay, 1);
  const nextQuery = sameYmd(next, today) ? 'range=today' : ymdQuery(next);
  return { prevQuery, nextQuery };
}

/** Parse a URL query into a resolvable range input. Defaults to today; unknown
 *  presets and malformed custom dates fall back safely. Persisted in the URL so a
 *  selection survives navigation between CallGrid tabs. */
export function parseCallGridRange(params: { range?: string | null; s?: string | null; e?: string | null }): {
  preset: CallGridPreset;
  start?: string;
  end?: string;
} {
  const raw = (params.range ?? '').trim();
  const preset = (CALLGRID_PRESETS as readonly string[]).includes(raw) ? (raw as CallGridPreset) : 'today';
  if (preset === 'custom') {
    return { preset, start: params.s ?? undefined, end: params.e ?? undefined };
  }
  return { preset };
}

/** Serialize a range selection back to a query string fragment (for nav links so
 *  the selection persists across tabs). The active preset is always explicit —
 *  including `range=today` — so every in-product URL is normalized to the selected
 *  period and Today never silently reverts to an ambiguous bare URL. */
export function callGridRangeQuery(preset: CallGridPreset, custom?: { start?: string; end?: string }): string {
  if (preset === 'custom') {
    const s = custom?.start ?? '';
    const e = custom?.end ?? '';
    return `range=custom&s=${encodeURIComponent(s)}&e=${encodeURIComponent(e)}`;
  }
  return `range=${preset}`;
}

// --- Detection identity ------------------------------------------------------

/**
 * The identity of the analysis period a detection came from.
 *
 * Used as the idempotency key when a producer records that it saw a situation:
 * the same period may be re-analysed any number of times (the Overview is
 * server-rendered and re-runs the engine on every request) and must record
 * exactly one sighting. Built from the window's Eastern calendar span, so a
 * refresh at 9:05 and one at 4:40 on the same day produce the same key while
 * tomorrow produces a different one.
 *
 * Deliberately NOT built from `end` directly: a live window's end moves with the
 * clock, so keying on the instant would make every request a new period.
 */
export function callGridDetectionKey(window: CallGridWindow): string {
  const from = easternYmd(window.start);
  const to = lastIncludedYmd(window.end);
  const iso = (y: EasternYmd) =>
    `${y.year}-${String(y.month).padStart(2, '0')}-${String(y.day).padStart(2, '0')}`;
  const span = iso(from) === iso(to) ? iso(from) : `${iso(from)}..${iso(to)}`;
  return `${window.preset}:${span}`;
}

/**
 * The instant a detection from this window should be stamped with.
 *
 * The end of the period being analysed, clamped to `now` for a live window —
 * a sighting must never be dated in the future, and a completed period's
 * sighting belongs to that period rather than to whenever somebody opened the
 * page to look at it.
 */
export function callGridDetectedAt(window: CallGridWindow, now: Date): Date {
  return window.end.getTime() > now.getTime() ? now : window.end;
}
