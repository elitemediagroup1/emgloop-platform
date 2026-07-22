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
