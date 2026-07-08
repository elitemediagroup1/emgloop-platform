-- Loop Event Gateway (PR #80)
-- Additive migration: creates the immutable "loop_events" store.
-- No changes to existing tables. No foreign keys (event columns are plain
-- scalars so the store stays purely additive).

-- CreateTable
CREATE TABLE "loop_events" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "site" TEXT,
    "eventType" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "anonymousId" TEXT,
    "userId" TEXT,
    "sessionId" TEXT,
    "pageUrl" TEXT,
    "referrer" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "processed" BOOLEAN NOT NULL DEFAULT false,
    "processingVersion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "loop_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "loop_events_eventId_key" ON "loop_events"("eventId");

-- CreateIndex
CREATE INDEX "loop_events_platform_eventType_idx" ON "loop_events"("platform", "eventType");

-- CreateIndex
CREATE INDEX "loop_events_platform_occurredAt_idx" ON "loop_events"("platform", "occurredAt");

-- CreateIndex
CREATE INDEX "loop_events_processed_receivedAt_idx" ON "loop_events"("processed", "receivedAt");

-- CreateIndex
CREATE INDEX "loop_events_anonymousId_idx" ON "loop_events"("anonymousId");

-- CreateIndex
CREATE INDEX "loop_events_userId_idx" ON "loop_events"("userId");
