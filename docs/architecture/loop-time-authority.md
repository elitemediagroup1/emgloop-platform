# Loop Time Authority — Decision Record

**Status:** Product decision by Matt, 2026-09-15. Locked. Amended the same day with Product decisions
PD-1 and PD-2 (below). Reopening any rule requires an explicit product decision, not an implementation
convenience.

**Scope:** how Loop represents, stamps, resolves and presents time, everywhere: storage, server
operations, the web application (`/app` and `/crm`, one shell), and any future AI layer.

## Context

On 2026-09-14 at about 8:37 PM Eastern, CRM People showed recently ingested CallGrid records as
"Last interaction 8m ago · Created Sep 15, 2026". The stored instants were correct UTC. Server-rendered
formatters called `toLocaleString`/`toLocaleDateString` with no timezone, so they used the server
process's zone, UTC in production, while relative times were computed from epoch differences and were
right. The same pattern ran through People, customer detail, the timeline, Inbox, Audit, the Command
Center, conversations, workflows, organizations, merge, Intelligence Flow, Integration OS and CallGrid
settings. Separately, several `/app` surfaces used a hard-coded Eastern zone for greetings, dates and
"today", and the Command Center used the organization's `timezone` setting.

## Decisions

### T-01 — Canonical clock
An instant is UTC. Every persisted temporal fact (events, calls, interactions, audit entries, state
changes, messages, AI actions, workflow steps) is an absolute UTC instant. The trusted server or database
clock is the source of current time for authoritative operations. A device clock is never authoritative
for writes, audit ordering, authorization, deadlines or other consequential operations. No row updates
every second; no clock table.

### T-02 — User-local display time
Human-facing dates and times are shown in the signed-in person's current IANA timezone, detected from
their browser or device. Daylight saving follows IANA rules. There is **no default EMG business
timezone**: `2026-09-15T00:37:00Z` is Sep 14, 8:37 PM EDT in New Jersey, 7:37 PM CDT in Chicago,
5:37 PM PDT in California: one instant.

### T-03 — Current location and travel
Presentation follows the zone the current browser session reports. When the device's zone changes, Loop
re-renders in the new zone without touching stored timestamps. This is timezone detection, not
geolocation: no location permission is requested.

### T-04 — Future preference
Resolution is ordered **preference → device → fallback**. The preference is the explicit user timezone
preference of PD-2. No governed preference exists yet; the resolver accepts one, and the device never
overrides it once it does. No settings product is built now.

### T-05 — Object-specific timezones
An object that owns a timezone (appointment, campaign schedule, operating hours, routing window,
jurisdictional deadline, reporting window) is interpreted and may be shown in that zone, passed
explicitly. That is separate from the reader's display zone. No speculative schema is added. Work OS
targets follow PD-1.

### T-06 — One time authority
There is one temporal authority:
- `@emgloop/shared` `loop-time.ts` (pure): `parseTimeZone`, `resolveDisplayTimeZone`, `toInstant`,
  zone math (`zonedParts`, `zoneOffsetMinutes`, `zonedWallTimeToUtc`, `startOfZonedDay`,
  `zonedCalendarDay`, `calendarDaysBetween`), presentation (`formatInstant` with fixed presets,
  `formatCalendarDate`, `relativeTime`, `timeOfDayGreeting`), and `createTimeView`, a reader's bound view.
- `apps/web/src/time/viewer-time.ts` (server-only): `viewerTime()`, the view for the current request.
- `apps/web/src/time/TimeZoneSync.tsx` (client leaf) and `time-zone-cookie.ts`: device zone reporting.

The Eastern reporting calendar (`business-time.ts`) is that same zone math with its own zone applied;
it no longer has its own implementation. Surfaces do not format instants or bucket days by any other
means.

### T-07 — Server and client responsibilities
The server clock supplies `now` for consequential operations. The browser may report its IANA zone,
animate a visual clock, and format an already-authoritative instant for display. It never supplies audit
timestamps, event timestamps, authorization input, workflow ordering, persisted created/updated
timestamps or deadlines. Nothing writes on a timer.

### T-08 — Relative time
Relative time is derived from the same instant and the same zone as the absolute time beside it. Under a
day it is real elapsed minutes or hours; from a day on it counts **calendar days in the reader's zone**,
so "yesterday" is always the calendar day before today where the reader is.

### T-09 — AI and the Brain
No model is authoritative for the current time or a timezone. When AI reasons about time, Loop supplies
governed temporal context: the canonical current instant, the reader's display zone, any relevant object
zone, the resolved local date and time, and calendar context. The model does not guess "today",
"tomorrow morning" or "in an hour" when Loop can resolve them deterministically. No AI integration is
built in this change; this is the contract it must use.

### T-10 — Audit and provenance
A historical record keeps its instant forever. A later timezone change never mutates it. Two readers in
different zones see different local clocks for the same immutable event. Where ambiguity matters the UI
exposes the zone: timeline tooltips carry the full time with its zone, CallGrid "updated" and
"last synchronization" times name their zone, and the UTC fallback names UTC on every absolute time.

### T-11 — Security and trust
A client-submitted local timestamp is never proof of when a consequential event occurred when the
server can stamp it. A timezone is presentation context, never authorization. Malformed, over-long,
offset-shaped (`+05:00`, `UTC+5`) or unknown values fail closed to the fallback. The zone is carried in a
non-authoritative cookie (`loop_tz`, validated on read and write); nothing that authorizes, scopes a
tenant, handles a server action, serves an API route or writes a record reads it.

### T-12 — The verified defect
Every surface in the Context above now presents through the Time Authority in the reader's detected
zone. None was patched to Eastern.

## Product decisions after review (2026-09-15)

### PD-1 — Work OS target dates
A newly entered Work OS target uses the **entering user's effective timezone** (the zone T-02/T-04
resolve for them), never `BUSINESS_TIME_ZONE`. Eastern is not a default merely because CallGrid
reporting uses Eastern.
- A **calendar-only** target (a date with no time) is preserved as a calendar date. It is not
  converted into an instant.
- A target that represents an **instant** (a date and time) is persisted as the canonical UTC instant
  **together with the originating IANA timezone** it was entered in.

This is decided but **not implemented in #238**; see remaining debt item 1 for current behaviour.

### PD-2 — Explicit user timezone preference
The timezone the setup wizard collects is the concept of the **explicit user timezone preference**,
which takes precedence over the device timezone (T-04).
- Legacy setup-wizard values are **not read as authoritative** until their provenance, validity and the
  user's intent have been audited. They are stored as unvalidated free text in
  `user.metadata.profile.timezone`.
- Until the preference is governed, resolution stays as #238 established: validated device timezone,
  then labelled UTC.

### BUSINESS_TIME_ZONE scope
`BUSINESS_TIME_ZONE` (America/New_York) is limited to CallGrid's reporting calendar and other explicitly
object-owned or reporting semantics. It is never a user display timezone and never a default for
user-entered times.

## How the reader's zone reaches server rendering

Server components render before the browser runs, so the server cannot see the device's zone.
`TimeZoneSync` reads `Intl.DateTimeFormat().resolvedOptions().timeZone`, validates it, writes it to
`loop_tz`, and triggers **one** `router.refresh()`: on first visit, or when the device's zone differs
from the zone the page was rendered in (travel). It re-checks on window focus. It never refreshes twice
for the same zone and never refreshes if the cookie did not persist, so blocked cookies cannot loop. It
is mounted once, in the single Loop shell (covering `/app` and `/crm`), and on the sign-in screen
(record only, no refresh) so the first signed-in page is already local. `viewerTime()` reads the cookie
on every server render, so client navigation stays coherent.

## Fallback

**UTC, labelled.** With no valid zone (first paint before the browser reports, cookies blocked, a
malformed value, or no request such as a unit test), Loop presents in UTC and appends the zone to every
absolute time ("Sep 15, 2026, 12:37 AM UTC"). UTC is the canonical clock, so it is the only fallback
that is not an arbitrary regional choice. Labelling it means a UTC date is never mistaken for a local
one. Loop never falls back to America/New_York or to an organization's zone.

## BUSINESS_TIME_ZONE (America/New_York) reconciled

| Use | Classification | Result |
|---|---|---|
| CallGrid reporting days, windows, observation ledger, reconciliation, recovery chunking, bid report | Subsystem calendar: aligns Loop's figures with CallGrid's Eastern reporting day | **Kept** |
| Commercial Intelligence measurement windows (`easternTrailingCompleteWindows`) and their labels (Headlines, Objectives) | Subsystem calendar built on CallGrid days; labels shown on the window's own calendar | **Kept** (labels via `formatInstant(…, BUSINESS_TIME_ZONE, …)`) |
| CallGrid scorecard Yesterday/Today on Home (`dashboard-data.ts`) | CallGrid reporting days | **Kept** |
| Work OS target date entry (`start-work.ts`) | Legacy Eastern default for user-entered times; contradicts PD-1 | **Unchanged in #238; to be replaced per PD-1** (see debt item 1) |
| Workspace home greeting, date label and "today" window | Global presentation | **Removed** (reader's zone) |
| Work OS "completed today" (admin dashboard, employee queue) | Global presentation | **Removed** (reader's day) |
| Decision card timestamps and greeting; CallGrid "updated" and "last synchronization" | Presentation of instants | **Removed** (reader's zone, zone named) |
| `WorkRepository.listCompletedToday` | Unused | **Deleted** |
| `easternHour` | Only fed the workspace greeting | **Deleted** |

The Command Center's use of `Organization.timezone` for its greeting and date is also removed. The
field itself is unchanged.

## Remaining temporal debt (not changed here)

1. **Work OS target date entry: decided by PD-1, not yet implemented.** Today:
   - `buildWorkItemSubmission` interprets an entered date and time as Eastern wall time;
   - a date entered without a time becomes an instant at 5:00 PM Eastern, so the calendar date is not
     preserved;
   - the form tells the person "Times are Eastern Time";
   - the work item's metadata persists `targetAtUtc` and the Eastern wall-clock string `targetEastern`,
     but no originating timezone. The `dueTimezone` value the builder computes is not persisted.

   PD-1 requires the entering user's effective zone, a calendar-only target kept as a calendar date,
   and an instant target persisted as UTC plus its originating IANA zone. Existing items' stored values
   are historical facts; how they are read after the change is part of that work.
2. **`signal-registry.ts` `timeOfDayBucket`** buckets event hours by the server clock. Time of day for a
   customer event belongs to that customer's or property's zone (T-05); no such zone is modelled.
3. **`callgrid-poll.service.ts` `sinceForRange('today')`** uses server midnight; it should use the
   CallGrid reporting calendar. It is not called by the poll execution itself.
4. **`integration-os.service.ts` "events today"** uses server midnight.
5. **`CallGridDateRange` "today" highlight** uses the browser's local date for an Eastern reporting
   calendar.
6. **Bookings** carry no timezone, so appointment times display in the reader's zone rather than the
   appointment's own zone (T-05).
7. **The setup wizard's user `timezone`: decided by PD-2.** It is the concept of the explicit user
   preference. Its legacy values (unvalidated free text in `user.metadata.profile.timezone`) are not
   read until audited for provenance, validity and intent. Governing the preference is future work,
   outside #238.
8. **Elapsed-duration formatters** (`age()` "6d", `duration()`) remain local. They are
   timezone-independent durations, not dates.

## Enforcement

- `packages/shared/test/loop-time.test.ts`:
  - the midnight boundary in five zones;
  - DST transitions, offsets and day lengths;
  - gap and overlap resolution;
  - invalid zones and the resolution order;
  - the labelled fallback;
  - relative and absolute consistency, as a 2,000-case property test;
  - no mutation of instants;
  - calendar dates.
- `apps/web/test/time-authority.test.tsx`:
  - the cookie contract and forged values;
  - sync decisions (first visit, travel, preference);
  - one shell mount;
  - the zone never read by guards, actions, API routes, middleware or the database package;
  - audit rows take the database clock;
  - no server-clock date formatting anywhere in `apps/web/src` (allow-list of three, each explained);
  - no hard-coded Eastern display zone;
  - every defect surface on the authority;
  - the reader-local Command Center week;
  - the rendered timeline timestamp.
