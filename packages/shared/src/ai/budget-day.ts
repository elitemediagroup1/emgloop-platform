// Which business day an AI invocation is budgeted against.
//
// A "daily cap" has to mean a day somebody recognises, so the budget window follows
// the ORGANIZATION'S OWN governed reporting zone (`Organization.timezone`, default
// UTC). Product decision, 2026-09-16.
//
// THIS IS NOT A DISPLAY TIMEZONE, and this function is the only place the
// organization's zone is read for AI usage. Loop has no global business timezone
// (docs/architecture/loop-time-authority.md), and an organization's reporting zone
// must never become one: how a person SEES an instant is the Time Authority's job, in
// that person's own zone. `BUSINESS_TIME_ZONE` is a different calendar again --
// CallGrid's Eastern reporting day -- and has nothing to do with an AI budget.
//
// The canonical instants on an invocation row (requestedAt, completedAt) stay UTC.
// This derives ONE extra field, for ONE purpose: the business-day budget that
// actually requires it.
//
// PURE. No clock, no I/O. The instant and the zone are both passed in.

import { zonedParts } from '../loop-time';

/** A calendar date, as `YYYY-MM-DD`. Not an instant, and not comparable to one. */
export type AiBudgetDate = string;

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

/**
 * The business day `instant` falls on, in `zone`.
 *
 * An unusable zone falls back to UTC rather than throwing. A budget that cannot be
 * evaluated because of a misconfigured timezone string would fail OPEN -- no window,
 * no cap, no ceiling on spend -- and of the two wrong answers, "counted against the
 * UTC day" is the one that still enforces a limit.
 */
export function aiBudgetDate(instant: Date, zone: string | null | undefined): AiBudgetDate {
  const wanted = typeof zone === 'string' && zone.trim() !== '' ? zone.trim() : 'UTC';
  let parts: { year: number; month: number; day: number };
  try {
    parts = zonedParts(instant, wanted);
  } catch {
    parts = zonedParts(instant, 'UTC');
  }
  return `${pad(parts.year, 4)}-${pad(parts.month, 2)}-${pad(parts.day, 2)}`;
}
