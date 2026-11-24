ALTER TABLE "meeting_captures"
  ADD COLUMN "title" TEXT,
  ADD COLUMN "meetingAt" TIMESTAMP(3),
  ADD COLUMN "transcript" TEXT,
  ADD COLUMN "transcriptState" TEXT,
  ADD COLUMN "transcriptRequestedAt" TIMESTAMP(3),
  ADD COLUMN "summary" TEXT,
  ADD COLUMN "summaryRequestedAt" TIMESTAMP(3);

UPDATE "meeting_captures" AS capture
SET "title" = matched."title", "meetingAt" = matched."startAt"
FROM (
  SELECT DISTINCT ON (c."id") c."id", b."title", b."startAt"
  FROM "meeting_captures" c
  JOIN "bookings" b ON b."organizationId" = c."organizationId"
    AND b."attributes"->>'profileUserId' = c."requestedById"
    AND b."attributes"->>'meetUrl' = c."meetingUrl"
    AND b."calendarProvider" = 'GOOGLE_BOOKING'
  ORDER BY c."id", abs(extract(epoch FROM b."startAt" - c."createdAt"))
) AS matched
WHERE capture."id" = matched."id";
