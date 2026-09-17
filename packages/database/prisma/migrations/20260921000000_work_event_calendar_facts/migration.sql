-- Daily Loop: the Calendar facts a work event has to carry (DL-3).
--
-- Architecture: docs/architecture/daily-loop-employee-intelligence.md SS8, SS13.3 and SS17;
-- the sensor contract these columns receive is packages/shared/src/calendar-sensor.ts (DL-2).
--
-- ADDITIVE ONLY, AND ONLY TO work_events. Ten nullable or defaulted columns and one CHECK. No
-- existing column changes type, no index is rebuilt, no row is backfilled, and migration 38 is
-- not touched. Both migrations are unapplied in production; 38 runs first, then this one.
--
-- WHY THIS EXISTS. DL-1 sketched work_events before DL-2 established what a calendar fact
-- actually is, and two gaps showed up when the sensor met the table:
--
--   1. THE TITLE. "Your Day" lists meetings, and a day of times with no names is not a day
--      view. `summary` is the minimum content the approved experience needs -- and it is the
--      ONLY content column here. There is deliberately no description, no location, no
--      attendee address, no joining link and no attachment.
--
--   2. ALL-DAY EVENTS ARE DATES, NOT INSTANTS. "18 September" begins at a different moment in
--      Chicago than in Zurich, so writing a UTC midnight into startsAt would bake one reader's
--      zone into a stored fact and be wrong for every other. startDate/endDateExclusive are
--      DATE columns carrying exactly what the provider said, with Google's exclusive end kept
--      as an exclusive end, and eventTimeZone records the calendar's own zone so the
--      presentation layer can resolve them later through the Loop Time Authority.
--
-- The rest (kind, blocking, originalStartsAt, organizerIsSelf, attendanceKnown, selfResponse)
-- are facts DL-2 already produces and DL-3 is asked to persist. attendanceKnown is the one
-- worth naming: FALSE means the provider omitted attendees, so the counts are UNKNOWN rather
-- than zero -- "I could not count" and "nobody is invited" must never render the same.
--
-- ASCII only.

-- AlterTable
ALTER TABLE "work_events" ADD COLUMN     "attendanceKnown" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "blocking" TEXT,
ADD COLUMN     "endDateExclusive" DATE,
ADD COLUMN     "eventTimeZone" TEXT,
ADD COLUMN     "kind" TEXT,
ADD COLUMN     "organizerIsSelf" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "originalStartsAt" TIMESTAMP(3),
ADD COLUMN     "selfResponse" TEXT,
ADD COLUMN     "startDate" DATE,
ADD COLUMN     "summary" TEXT;


-- The vocabularies these columns carry, enforced by the database exactly as DL-1 enforces its
-- own: a word packages/shared/src/calendar-sensor.ts does not know cannot be stored, even by a
-- caller that bypassed the contract.
ALTER TABLE "work_events" ADD CONSTRAINT "work_events_calendar_facts_check" CHECK (
  ("status" IS NULL OR "status" IN ('CONFIRMED', 'TENTATIVE', 'CANCELLED'))
  AND ("kind" IS NULL OR "kind" IN ('DEFAULT', 'OUT_OF_OFFICE', 'FOCUS_TIME', 'WORKING_LOCATION', 'BIRTHDAY', 'FROM_GMAIL', 'OTHER'))
  AND ("blocking" IS NULL OR "blocking" IN ('BLOCKING', 'FREE'))
  AND ("selfResponse" IS NULL OR "selfResponse" IN ('ACCEPTED', 'DECLINED', 'TENTATIVE', 'NEEDS_ACTION'))
  -- An all-day event has dates and no instants; a timed one has instants and no dates. The two
  -- shapes never mix, so nothing downstream has to guess which it is looking at.
  AND (NOT "allDay" OR ("startsAt" IS NULL AND "endsAt" IS NULL))
  AND ("allDay" OR ("startDate" IS NULL AND "endDateExclusive" IS NULL))
  AND ("endDateExclusive" IS NULL OR ("startDate" IS NOT NULL AND "endDateExclusive" > "startDate"))
  -- Counts exist only when the provider said who is attending.
  AND ("attendanceKnown" OR ("attendeeCount" IS NULL AND "externalAttendeeCount" IS NULL))
  -- The one content column is bounded: a title, not a document.
  AND ("summary" IS NULL OR length("summary") <= 1024)
);
