// CallGrid reporting date-window contract — the ONE definition of every reporting
// preset and its comparison period. Pure and deterministic: `now` is injected, and
// every boundary is an Eastern (America/New_York) calendar boundary resolved
// through the shared business-time helpers (DST-aware). No page, service, or
// component may redefine a preset — they resolve it here.
//
// A window is half-open [start, end): `start` inclusive, `end` exclusive. Live
// presets (today, this week, this month, YTD, trailing-N-days) end at `now`;
// completed presets (yesterday, last week/2-weeks/month) end on a day boundary.

import { easternYmd, easternWallTimeToUtc, BUSINESS_TIME_ZONE, type EasternYmd } from './business-time';

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

export interface CallGridWindow {
  start: Date;
  end: Date;
  timezone: string; // always America/New_York
  preset: CallGridPreset;
  comparisonStart: Date | null;
  comparisonEnd: Date | null;
  label: string; // e.g. "Jul 22, 2026" or "Jul 16 – Jul 22, 2026"
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

/** A trailing-N-days window ending at `now`, with the immediately preceding N-day
 *  period as its comparison. N=1 is "today". */
function trailingDays(today: EasternYmd, now: Date, n: number, preset: CallGridPreset): CallGridWindow {
  const startYmd = shiftDays(today, -(n - 1));
  const start = dayStart(startYmd);
  const compEnd = start;
  const compStart = dayStart(shiftDays(startYmd, -n));
  return { start, end: now, timezone: BUSINESS_TIME_ZONE, preset, comparisonStart: compStart, comparisonEnd: compEnd, label: rangeLabel(start, now, startYmd) };
}

/**
 * Resolve a preset (or custom range) into a fully-specified window with its
 * comparison period. Every boundary is Eastern. Unknown presets fall back to today.
 */
export function resolveCallGridWindow(
  input: { preset: CallGridPreset; start?: string; end?: string },
  now: Date,
): CallGridWindow {
  const today = easternYmd(now);
  const tz = BUSINESS_TIME_ZONE;

  switch (input.preset) {
    case 'today': {
      const start = dayStart(today);
      const y = shiftDays(today, -1);
      return { start, end: now, timezone: tz, preset: 'today', comparisonStart: dayStart(y), comparisonEnd: start, label: fmt(today) };
    }
    case 'yesterday': {
      const y = shiftDays(today, -1);
      const start = dayStart(y);
      const end = dayStart(today);
      const before = shiftDays(today, -2);
      return { start, end, timezone: tz, preset: 'yesterday', comparisonStart: dayStart(before), comparisonEnd: start, label: fmt(y) };
    }
    case 'last_2_days': return trailingDays(today, now, 2, 'last_2_days');
    case 'last_7_days': return trailingDays(today, now, 7, 'last_7_days');
    case 'last_14_days': return trailingDays(today, now, 14, 'last_14_days');
    case 'last_30_days': return trailingDays(today, now, 30, 'last_30_days');
    case 'this_week': {
      const offset = (weekdayOf(today) + 6) % 7; // days since Monday
      const weekStartYmd = shiftDays(today, -offset);
      const start = dayStart(weekStartYmd);
      // Comparison: the corresponding elapsed portion of last week.
      const lastWeekStart = dayStart(shiftDays(weekStartYmd, -7));
      const elapsed = now.getTime() - start.getTime();
      return { start, end: now, timezone: tz, preset: 'this_week', comparisonStart: lastWeekStart, comparisonEnd: new Date(lastWeekStart.getTime() + elapsed), label: rangeLabel(start, now, weekStartYmd) };
    }
    case 'last_week': {
      const offset = (weekdayOf(today) + 6) % 7;
      const weekStartYmd = shiftDays(today, -offset);
      const lwStartYmd = shiftDays(weekStartYmd, -7);
      const start = dayStart(lwStartYmd);
      const end = dayStart(weekStartYmd);
      const compStart = dayStart(shiftDays(weekStartYmd, -14));
      return { start, end, timezone: tz, preset: 'last_week', comparisonStart: compStart, comparisonEnd: start, label: rangeLabel(start, end, lwStartYmd) };
    }
    case 'last_2_weeks': {
      const offset = (weekdayOf(today) + 6) % 7;
      const weekStartYmd = shiftDays(today, -offset);
      const startYmd = shiftDays(weekStartYmd, -14);
      const start = dayStart(startYmd);
      const end = dayStart(weekStartYmd);
      const compStart = dayStart(shiftDays(weekStartYmd, -28));
      return { start, end, timezone: tz, preset: 'last_2_weeks', comparisonStart: compStart, comparisonEnd: start, label: rangeLabel(start, end, startYmd) };
    }
    case 'this_month': {
      const monthStartYmd = firstOfMonth(today);
      const start = dayStart(monthStartYmd);
      const lastMonthStart = dayStart(prevMonth(monthStartYmd));
      const elapsed = now.getTime() - start.getTime();
      return { start, end: now, timezone: tz, preset: 'this_month', comparisonStart: lastMonthStart, comparisonEnd: new Date(lastMonthStart.getTime() + elapsed), label: rangeLabel(start, now, monthStartYmd) };
    }
    case 'last_month': {
      const monthStartYmd = firstOfMonth(today);
      const lmStartYmd = prevMonth(monthStartYmd);
      const start = dayStart(lmStartYmd);
      const end = dayStart(monthStartYmd);
      const compStart = dayStart(prevMonth(lmStartYmd));
      return { start, end, timezone: tz, preset: 'last_month', comparisonStart: compStart, comparisonEnd: start, label: rangeLabel(start, end, lmStartYmd) };
    }
    case 'year_to_date': {
      const yearStartYmd: EasternYmd = { year: today.year, month: 1, day: 1 };
      const start = dayStart(yearStartYmd);
      const priorYearStart = dayStart({ year: today.year - 1, month: 1, day: 1 });
      const span = now.getTime() - start.getTime();
      return { start, end: now, timezone: tz, preset: 'year_to_date', comparisonStart: priorYearStart, comparisonEnd: new Date(priorYearStart.getTime() + span), label: rangeLabel(start, now, yearStartYmd) };
    }
    case 'custom': {
      const s = parseYmd(input.start);
      const e = parseYmd(input.end);
      if (!s || !e) return resolveCallGridWindow({ preset: 'today' }, now); // invalid → safe default
      // Order-tolerant, inclusive end date.
      const a = dayStart(s);
      const b = dayStart(e);
      const [startD, lastD] = a.getTime() <= b.getTime() ? [s, e] : [e, s];
      const start = dayStart(startD);
      const end = dayStart(shiftDays(lastD, 1)); // exclusive end = day after the last included day
      const len = end.getTime() - start.getTime();
      return { start, end, timezone: tz, preset: 'custom', comparisonStart: new Date(start.getTime() - len), comparisonEnd: start, label: rangeLabel(start, end, startD) };
    }
    default:
      return resolveCallGridWindow({ preset: 'today' }, now);
  }
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
 *  the selection persists across tabs). Returns '' for the default (today). */
export function callGridRangeQuery(preset: CallGridPreset, custom?: { start?: string; end?: string }): string {
  if (preset === 'today') return '';
  if (preset === 'custom') {
    const s = custom?.start ?? '';
    const e = custom?.end ?? '';
    return `range=custom&s=${encodeURIComponent(s)}&e=${encodeURIComponent(e)}`;
  }
  return `range=${preset}`;
}
