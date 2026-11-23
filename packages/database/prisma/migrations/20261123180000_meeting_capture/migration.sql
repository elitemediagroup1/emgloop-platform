CREATE TABLE "meeting_captures" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "requestedById" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "meetingUrl" TEXT NOT NULL,
  "providerBotId" TEXT UNIQUE,
  "status" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "meeting_captures_requester_idx" ON "meeting_captures"("organizationId", "requestedById", "createdAt");
CREATE UNIQUE INDEX "meeting_captures_active_meeting_idx" ON "meeting_captures"("organizationId", "meetingUrl")
WHERE "status" NOT IN ('done', 'fatal');
