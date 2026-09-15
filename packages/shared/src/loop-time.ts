// Loop Time Authority — the pure core.
//
// The ONE place Loop turns an instant into something a person reads, and the one
// place a timezone is validated. Decision record:
// docs/architecture/loop-time-authority.md.
//
//   - An instant is UTC. Stored timestamps are never rewritten to change how
//     they look; only their presentation varies.
//   - A person sees instants in their CURRENT display timezone: their device's
//     IANA zone today, a preference later. There is no EMG business timezone.
//   - When no valid zone is known, presentation falls back to UTC -- the
//     canonical clock -- and says so on every absolute time, so a UTC date is
//     never mistaken for a local one.
//   - Relative time ("8m ago", "yesterday") is derived from the same instant and
//     the same zone as the absolute date beside it, so the two cannot disagree.
//   - An object that owns a timezone (a schedule, a reporting window) passes that
//     zone explicitly; it is not the viewer's zone.
//
// Pure: no clock, no I/O, no environment. `now` and the zone are always passed
// in. DST comes from the platform's ICU timezone data, never computed by hand.

export const CANONICAL_TIME_ZONE = 'UTC';

/** Where a display timezone came from. A future user preference outranks the device. */
export type TimeZoneSource = 'preference' | 'device' | 'fallback';

export interface DisplayTimeZone {
  timeZone: string;
  source: TimeZoneSource;
}

// --- Validating a timezone ----------------------------------------------------

const MAX_TIME_ZONE_LENGTH = 64;
// An IANA identifier: "UTC", "America/New_York", "America/Argentina/Buenos_Aires",
// "Etc/GMT+5". No spaces, colons, quotes or anything a cookie could smuggle.
const IANA_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9][A-Za-z0-9_+-]*){0,2}$/;
// A raw offset is not a timezone: "+05:00", "-0400", "UTC+5", "GMT-4". It has no
// DST rules, so it would be wrong for half the year.
const OFFSET_LIKE = /^(?:[+-]\d|(?:UTC|GMT)[+-]\d)/i;

/**
 * The canonical IANA timezone named by `candidate`, or null.
 *
 * Fails closed: anything that is not a string, is over-long, looks like a bare
 * UTC offset, is not IANA-shaped, or is unknown to the platform's timezone data
 * is rejected rather than guessed at.
 */
export function parseTimeZone(candidate: unknown): string | null {
  if (typeof candidate !== 'string') return null;
  const value = candidate.trim();
  if (!value || value.length > MAX_TIME_ZONE_LENGTH) return null;
  if (OFFSET_LIKE.test(value) || !IANA_NAME.test(value)) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/**
 * The zone a person's dates are shown in: a valid preference, else a valid
 * device zone, else UTC. There is no organization or EMG default in between.
 */
export function resolveDisplayTimeZone(input: { preference?: unknown; device?: unknown }): DisplayTimeZone {
  const preference = parseTimeZone(input.preference);
  if (preference) return { timeZone: preference, source: 'preference' };
  const device = parseTimeZone(input.device);
  if (device) return { timeZone: device, source: 'device' };
  return { timeZone: CANONICAL_TIME_ZONE, source: 'fallback' };
}

// --- Instants -----------------------------------------------------------------

export type InstantInput = Date | string | number | null | undefined;

/** The instant `value` names, or null for a missing or unparseable value. Never mutates. */
export function toInstant(value: InstantInput): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

// --- Calendar arithmetic in a zone --------------------------------------------

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number;
  second: number;
}

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

/** The wall-clock date and time `instant` shows in `timeZone`. */
export function zonedParts(instant: Date, timeZone: string): ZonedParts {
  let dtf = partsFormatters.get(timeZone);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partsFormatters.set(timeZone, dtf);
  }
  const p: Record<string, number> = {};
  for (const part of dtf.formatToParts(instant)) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  return { year: p.year!, month: p.month!, day: p.day!, hour: p.hour! % 24, minute: p.minute!, second: p.second! };
}

/** Minutes east of UTC that `timeZone` is at `instant`: -240 in EDT, -300 in EST. */
export function zoneOffsetMinutes(instant: Date, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const wholeSeconds = instant.getTime() - instant.getUTCMilliseconds();
  return Math.round((wallAsUtc - wholeSeconds) / 60000);
}

/** The instant a wall-clock date and time in `timeZone` names, DST-aware. */
export function zonedWallTimeToUtc(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  ms = 0,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  const off1 = zoneOffsetMinutes(new Date(naive), timeZone);
  let utc = naive - off1 * 60000;
  // Re-check at the candidate: on a DST-transition day the offset can differ.
  const off2 = zoneOffsetMinutes(new Date(utc), timeZone);
  if (off2 !== off1) utc = naive - off2 * 60000;
  return new Date(utc);
}

/** 00:00 in `timeZone` of the calendar day `instant` falls on, as an instant. */
export function startOfZonedDay(instant: Date, timeZone: string): Date {
  const { year, month, day } = zonedParts(instant, timeZone);
  return zonedWallTimeToUtc(timeZone, year, month, day);
}

/** The calendar day `instant` falls on in `timeZone`, as 'YYYY-MM-DD'. */
export function zonedCalendarDay(instant: Date, timeZone: string): string {
  const { year, month, day } = zonedParts(instant, timeZone);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Whole calendar days from `earlier` to `later` as seen in `timeZone` (DST-proof). */
export function calendarDaysBetween(earlier: Date, later: Date, timeZone: string): number {
  const a = zonedParts(earlier, timeZone);
  const b = zonedParts(later, timeZone);
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000);
}

// --- Presentation -------------------------------------------------------------

/** The shapes Loop shows an instant in. One definition each, so every surface agrees. */
export type InstantFormat =
  | 'date' // Sep 14, 2026
  | 'dateTime' // Sep 14, 2026, 8:37 PM
  | 'monthDay' // Sep 14
  | 'monthDayTime' // Sep 14, 8:37 PM
  | 'time' // 8:37 PM
  | 'timeWithSeconds' // 8:37:05 PM
  | 'weekdayDate' // Monday, September 14, 2026
  | 'weekdayMonthDay' // Monday, September 14
  | 'full'; // Sep 14, 2026, 8:37:05 PM EDT — for tooltips and provenance

const FORMATS: Record<InstantFormat, Intl.DateTimeFormatOptions> = {
  date: { month: 'short', day: 'numeric', year: 'numeric' },
  dateTime: { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' },
  monthDay: { month: 'short', day: 'numeric' },
  monthDayTime: { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' },
  time: { hour: 'numeric', minute: '2-digit' },
  timeWithSeconds: { hour: 'numeric', minute: '2-digit', second: '2-digit' },
  weekdayDate: { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' },
  weekdayMonthDay: { weekday: 'long', month: 'long', day: 'numeric' },
  full: { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' },
};

const displayFormatters = new Map<string, Intl.DateTimeFormat>();

/**
 * `value` shown in `timeZone`. Missing or unparseable input renders as '' so the
 * caller chooses its own placeholder. `withZone` appends the zone ("EDT", "UTC")
 * wherever a reader could otherwise mistake whose clock this is.
 */
export function formatInstant(
  value: InstantInput,
  timeZone: string,
  format: InstantFormat,
  options: { withZone?: boolean } = {},
): string {
  const instant = toInstant(value);
  if (!instant) return '';
  const withZone = Boolean(options.withZone) && format !== 'full';
  const key = `${timeZone}|${format}|${withZone}`;
  let dtf = displayFormatters.get(key);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-US', { ...FORMATS[format], ...(withZone ? { timeZoneName: 'short' } : {}), timeZone });
    displayFormatters.set(key, dtf);
  }
  return dtf.format(instant);
}

/**
 * A calendar DATE that is not an instant -- a day someone picked in a date
 * input, stored as that day's UTC midnight. It is shown as the same calendar
 * day to everyone; converting it to a viewer's zone would move it back a day
 * west of Greenwich.
 */
export function formatCalendarDate(value: InstantInput, format: 'date' | 'monthDay' = 'date'): string {
  return formatInstant(value, CANONICAL_TIME_ZONE, format);
}

/**
 * How long ago (or until) `value` is, from `now`, in words consistent with the
 * absolute date beside it. Under a day it is minutes or hours of real elapsed
 * time; from a day on it counts CALENDAR days in `timeZone`, so "yesterday" is
 * always the calendar day before today where the reader is.
 */
export function relativeTime(
  value: InstantInput,
  now: Date,
  timeZone: string,
  options: { style?: 'short' | 'long' } = {},
): string {
  const instant = toInstant(value);
  if (!instant) return '';
  const long = options.style === 'long';
  const diff = now.getTime() - instant.getTime();
  const future = diff < 0;
  const abs = Math.abs(diff);
  const unit = (n: number, short: string, word: string) =>
    long ? `${n} ${word}${n === 1 ? '' : 's'}` : `${n}${short}`;
  const say = (phrase: string) => (future ? `in ${phrase}` : `${phrase} ago`);

  if (abs < 60_000) return 'just now';
  const minutes = Math.floor(abs / 60_000);
  if (minutes < 60) return say(unit(minutes, 'm', 'minute'));
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return say(unit(hours, 'h', 'hour'));

  const days = Math.abs(future ? calendarDaysBetween(now, instant, timeZone) : calendarDaysBetween(instant, now, timeZone));
  if (days <= 1) return future ? 'tomorrow' : 'yesterday';
  if (long && days >= 30) return say(unit(Math.floor(days / 30), 'mo', 'month'));
  return say(unit(days, 'd', 'day'));
}

/** "Good morning" / "Good afternoon" / "Good evening" where the reader is. */
export function timeOfDayGreeting(now: Date, timeZone: string): string {
  const { hour } = zonedParts(now, timeZone);
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

// --- A reader's view of time ----------------------------------------------------

/**
 * Everything a surface needs to present time to one reader: the canonical
 * `now` it was rendered at, the reader's zone and where it came from, and the
 * formatters bound to them. When the zone is the UTC fallback, every absolute
 * time carries its zone.
 */
export interface TimeView extends DisplayTimeZone {
  now: Date;
  format(value: InstantInput, format: InstantFormat): string;
  date(value: InstantInput): string;
  dateTime(value: InstantInput): string;
  monthDay(value: InstantInput): string;
  monthDayTime(value: InstantInput): string;
  time(value: InstantInput): string;
  full(value: InstantInput): string;
  relative(value: InstantInput, options?: { style?: 'short' | 'long' }): string;
  greeting(): string;
  /** 00:00 of the reader's current calendar day (or of `value`'s day), as an instant. */
  startOfDay(value?: InstantInput): Date;
  /** The canonical ISO instant, for `<time dateTime>` and machine-readable output. */
  iso(value: InstantInput): string;
}

export function createTimeView(zone: DisplayTimeZone, now: Date): TimeView {
  const { timeZone, source } = zone;
  const withZone = source === 'fallback';
  const format = (value: InstantInput, f: InstantFormat) => formatInstant(value, timeZone, f, { withZone });
  return {
    timeZone,
    source,
    now,
    format,
    date: (v) => format(v, 'date'),
    dateTime: (v) => format(v, 'dateTime'),
    monthDay: (v) => format(v, 'monthDay'),
    monthDayTime: (v) => format(v, 'monthDayTime'),
    time: (v) => format(v, 'time'),
    full: (v) => formatInstant(v, timeZone, 'full'),
    relative: (v, options) => relativeTime(v, now, timeZone, options),
    greeting: () => timeOfDayGreeting(now, timeZone),
    startOfDay: (v) => startOfZonedDay(toInstant(v) ?? now, timeZone),
    iso: (v) => toInstant(v)?.toISOString() ?? '',
  };
}
