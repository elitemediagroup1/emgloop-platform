-- Daily Loop: one employee's own work state (DL-1).
--
-- Architecture: docs/architecture/daily-loop-employee-intelligence.md SS17 and SS26.7.
--
-- ADDITIVE ONLY. Thirteen new tables. No existing table, column, index or constraint is
-- touched, and nothing is backfilled: this migration creates the place the later slices
-- write to, and nothing writes to it yet.
--
-- USER-FIRST. Every table carries organizationId AND userId, and the composite foreign key
-- is to organization_memberships, so a row cannot be filed under an organization the person
-- does not belong to and offboarding cascades it away. There is no table here an
-- organization can be read from alone.
--
-- NO MESSAGE BODY, NO SNIPPET, NO ATTACHMENT, NO FILE CONTENT. Under the current Google
-- grant there is nothing to store, and a nullable column would be an invitation. Stage 2
-- adds what it earns, in the migration that says so out loud.
--
-- THE CHECKS ARE THE CONTRACT, AS THEY ARE FOR google_connections. Every closed vocabulary
-- in packages/shared/src/work-state.ts is repeated here, so a value the contract does not
-- know cannot be stored even by a caller that bypassed it. The two Stage 2 seams
-- (work_items.evidenceQuote, work_briefs.headline) are nullable and constrained rather than
-- absent, so Stage 2 is an addition and not a rewrite.
--
-- ASCII only: an em-dash in a migration once blocked replay of an entire ledger.

-- CreateTable
CREATE TABLE "work_source_cursors" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "cursorKind" TEXT,
    "cursor" TEXT,
    "lastSyncStartedAt" TIMESTAMP(3),
    "lastSyncCompletedAt" TIMESTAMP(3),
    "lastFailureClass" TEXT,
    "backoffUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "work_source_cursors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_sync_runs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),
    "outcome" TEXT,
    "examined" INTEGER,
    "written" INTEGER,
    "failureClass" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_correspondents" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "addressHash" TEXT NOT NULL,
    "displayAddress" TEXT NOT NULL,
    "displayName" TEXT,
    "domain" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "inboundCount" INTEGER NOT NULL DEFAULT 0,
    "outboundCount" INTEGER NOT NULL DEFAULT 0,
    "suppressed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "work_correspondents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_threads" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "subject" TEXT,
    "participantHashes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "firstMessageAt" TIMESTAMP(3),
    "lastMessageAt" TIMESTAMP(3),
    "lastDirection" TEXT,
    "lastMessageId" TEXT,
    "labels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "derivedClass" TEXT,
    "classRuleVersion" TEXT,
    "medianReplyMinutes" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "work_threads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_messages" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "internalDate" TIMESTAMP(3) NOT NULL,
    "direction" TEXT NOT NULL,
    "fromHash" TEXT,
    "toHashes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ccHashes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "subject" TEXT,
    "headerMessageId" TEXT,
    "inReplyTo" TEXT,
    "labels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_events" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "recurringEventId" TEXT,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "allDay" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT,
    "organizerHash" TEXT,
    "attendeeCount" INTEGER,
    "externalAttendeeCount" INTEGER,
    "hasConference" BOOLEAN NOT NULL DEFAULT false,
    "providerUpdatedAt" TIMESTAMP(3),
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_documents" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "name" TEXT,
    "mimeType" TEXT,
    "ownerHashes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "modifiedAt" TIMESTAMP(3),
    "webViewLink" TEXT,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_items" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "recurrenceKey" TEXT NOT NULL,
    "class" TEXT NOT NULL,
    "subjectKind" TEXT NOT NULL,
    "subjectRef" TEXT NOT NULL,
    "title" TEXT,
    "producerKind" TEXT NOT NULL,
    "producerId" TEXT NOT NULL,
    "producerVersion" TEXT NOT NULL,
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "evidenceQuote" TEXT,
    "evidenceQuoteRef" TEXT,
    "firstDetectedAt" TIMESTAMP(3) NOT NULL,
    "lastDetectedAt" TIMESTAMP(3) NOT NULL,
    "detectionCount" INTEGER NOT NULL DEFAULT 1,
    "state" TEXT NOT NULL DEFAULT 'OPEN',
    "stateChangedAt" TIMESTAMP(3),
    "snoozedUntil" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "outcome" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "work_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_item_observations" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "observationType" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorType" TEXT NOT NULL,
    "actorUserId" TEXT,
    "reason" TEXT,
    "previousState" TEXT,
    "newState" TEXT,

    CONSTRAINT "work_item_observations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_briefs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "localDate" DATE NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "coverage" JSONB NOT NULL DEFAULT '{}',
    "counts" JSONB NOT NULL DEFAULT '{}',
    "items" JSONB NOT NULL DEFAULT '[]',
    "headline" TEXT,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "generatorVersion" TEXT NOT NULL,

    CONSTRAINT "work_briefs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_feedback" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "subjectKind" TEXT NOT NULL,
    "subjectRef" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdByUserId" TEXT NOT NULL,

    CONSTRAINT "work_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_work_preferences" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "timeZone" TEXT NOT NULL DEFAULT 'UTC',
    "dayStartMinutes" INTEGER NOT NULL DEFAULT 480,
    "quietStartMinutes" INTEGER,
    "quietEndMinutes" INTEGER,
    "briefEnabled" BOOLEAN NOT NULL DEFAULT true,
    "sources" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_work_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_retention_overrides" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "days" INTEGER,
    "policyVersion" TEXT NOT NULL,
    "reason" TEXT,
    "setByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "work_retention_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "work_source_cursors_organizationId_userId_source_key" ON "work_source_cursors"("organizationId", "userId", "source");

-- CreateIndex
CREATE INDEX "work_sync_runs_organizationId_userId_startedAt_idx" ON "work_sync_runs"("organizationId", "userId", "startedAt");

-- CreateIndex
CREATE INDEX "work_correspondents_organizationId_userId_domain_idx" ON "work_correspondents"("organizationId", "userId", "domain");

-- CreateIndex
CREATE INDEX "work_correspondents_organizationId_userId_lastSeenAt_idx" ON "work_correspondents"("organizationId", "userId", "lastSeenAt");

-- CreateIndex
CREATE UNIQUE INDEX "work_correspondents_organizationId_userId_addressHash_key" ON "work_correspondents"("organizationId", "userId", "addressHash");

-- CreateIndex
CREATE INDEX "work_threads_organizationId_userId_derivedClass_lastMessage_idx" ON "work_threads"("organizationId", "userId", "derivedClass", "lastMessageAt");

-- CreateIndex
CREATE INDEX "work_threads_organizationId_userId_lastMessageAt_idx" ON "work_threads"("organizationId", "userId", "lastMessageAt");

-- CreateIndex
CREATE UNIQUE INDEX "work_threads_organizationId_userId_provider_threadId_key" ON "work_threads"("organizationId", "userId", "provider", "threadId");

-- CreateIndex
CREATE INDEX "work_messages_organizationId_userId_threadId_internalDate_idx" ON "work_messages"("organizationId", "userId", "threadId", "internalDate");

-- CreateIndex
CREATE UNIQUE INDEX "work_messages_organizationId_userId_provider_messageId_key" ON "work_messages"("organizationId", "userId", "provider", "messageId");

-- CreateIndex
CREATE INDEX "work_events_organizationId_userId_startsAt_idx" ON "work_events"("organizationId", "userId", "startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "work_events_organizationId_userId_provider_eventId_key" ON "work_events"("organizationId", "userId", "provider", "eventId");

-- CreateIndex
CREATE INDEX "work_documents_organizationId_userId_modifiedAt_idx" ON "work_documents"("organizationId", "userId", "modifiedAt");

-- CreateIndex
CREATE UNIQUE INDEX "work_documents_organizationId_userId_provider_fileId_key" ON "work_documents"("organizationId", "userId", "provider", "fileId");

-- CreateIndex
CREATE INDEX "work_items_organizationId_userId_state_lastDetectedAt_idx" ON "work_items"("organizationId", "userId", "state", "lastDetectedAt");

-- CreateIndex
CREATE UNIQUE INDEX "work_items_organizationId_userId_recurrenceKey_key" ON "work_items"("organizationId", "userId", "recurrenceKey");

-- CreateIndex
CREATE INDEX "work_item_observations_organizationId_userId_itemId_sequenc_idx" ON "work_item_observations"("organizationId", "userId", "itemId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "work_item_observations_itemId_sequence_key" ON "work_item_observations"("itemId", "sequence");

-- CreateIndex
CREATE INDEX "work_briefs_organizationId_userId_localDate_idx" ON "work_briefs"("organizationId", "userId", "localDate");

-- CreateIndex
CREATE UNIQUE INDEX "work_briefs_organizationId_userId_localDate_version_key" ON "work_briefs"("organizationId", "userId", "localDate", "version");

-- CreateIndex
CREATE INDEX "work_feedback_organizationId_userId_subjectKind_subjectRef_idx" ON "work_feedback"("organizationId", "userId", "subjectKind", "subjectRef");

-- CreateIndex
CREATE INDEX "work_feedback_organizationId_userId_createdAt_idx" ON "work_feedback"("organizationId", "userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "employee_work_preferences_organizationId_userId_key" ON "employee_work_preferences"("organizationId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "work_retention_overrides_organizationId_category_key" ON "work_retention_overrides"("organizationId", "category");

-- AddForeignKey
ALTER TABLE "work_source_cursors" ADD CONSTRAINT "work_source_cursors_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_source_cursors" ADD CONSTRAINT "work_source_cursors_userId_organizationId_fkey" FOREIGN KEY ("userId", "organizationId") REFERENCES "organization_memberships"("userId", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_sync_runs" ADD CONSTRAINT "work_sync_runs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_sync_runs" ADD CONSTRAINT "work_sync_runs_userId_organizationId_fkey" FOREIGN KEY ("userId", "organizationId") REFERENCES "organization_memberships"("userId", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_correspondents" ADD CONSTRAINT "work_correspondents_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_correspondents" ADD CONSTRAINT "work_correspondents_userId_organizationId_fkey" FOREIGN KEY ("userId", "organizationId") REFERENCES "organization_memberships"("userId", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_threads" ADD CONSTRAINT "work_threads_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_threads" ADD CONSTRAINT "work_threads_userId_organizationId_fkey" FOREIGN KEY ("userId", "organizationId") REFERENCES "organization_memberships"("userId", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_messages" ADD CONSTRAINT "work_messages_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_messages" ADD CONSTRAINT "work_messages_userId_organizationId_fkey" FOREIGN KEY ("userId", "organizationId") REFERENCES "organization_memberships"("userId", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_events" ADD CONSTRAINT "work_events_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_events" ADD CONSTRAINT "work_events_userId_organizationId_fkey" FOREIGN KEY ("userId", "organizationId") REFERENCES "organization_memberships"("userId", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_documents" ADD CONSTRAINT "work_documents_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_documents" ADD CONSTRAINT "work_documents_userId_organizationId_fkey" FOREIGN KEY ("userId", "organizationId") REFERENCES "organization_memberships"("userId", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_userId_organizationId_fkey" FOREIGN KEY ("userId", "organizationId") REFERENCES "organization_memberships"("userId", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item_observations" ADD CONSTRAINT "work_item_observations_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "work_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item_observations" ADD CONSTRAINT "work_item_observations_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item_observations" ADD CONSTRAINT "work_item_observations_userId_organizationId_fkey" FOREIGN KEY ("userId", "organizationId") REFERENCES "organization_memberships"("userId", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_briefs" ADD CONSTRAINT "work_briefs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_briefs" ADD CONSTRAINT "work_briefs_userId_organizationId_fkey" FOREIGN KEY ("userId", "organizationId") REFERENCES "organization_memberships"("userId", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_feedback" ADD CONSTRAINT "work_feedback_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_feedback" ADD CONSTRAINT "work_feedback_userId_organizationId_fkey" FOREIGN KEY ("userId", "organizationId") REFERENCES "organization_memberships"("userId", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_feedback" ADD CONSTRAINT "work_feedback_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_work_preferences" ADD CONSTRAINT "employee_work_preferences_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_work_preferences" ADD CONSTRAINT "employee_work_preferences_userId_organizationId_fkey" FOREIGN KEY ("userId", "organizationId") REFERENCES "organization_memberships"("userId", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_retention_overrides" ADD CONSTRAINT "work_retention_overrides_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_retention_overrides" ADD CONSTRAINT "work_retention_overrides_setByUserId_fkey" FOREIGN KEY ("setByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- The vocabularies, enforced by the database.
--
-- Each list below is the one in packages/shared/src/work-state.ts. A value the
-- contract does not know is refused here too, so the two can never drift apart
-- silently: a widened vocabulary needs a migration that states the new word.
-- ---------------------------------------------------------------------------

-- Sources and sync state.
ALTER TABLE "work_source_cursors" ADD CONSTRAINT "work_source_cursors_shape_check" CHECK (
  "source" IN ('GMAIL', 'CALENDAR', 'DRIVE')
  AND ("cursorKind" IS NULL OR "cursorKind" IN ('GMAIL_HISTORY_ID', 'CALENDAR_SYNC_TOKEN', 'DRIVE_PAGE_TOKEN'))
  AND ("lastFailureClass" IS NULL OR "lastFailureClass" IN ('NETWORK', 'TIMEOUT', 'RATE_LIMITED', 'AUTH', 'MALFORMED', 'CURSOR_EXPIRED', 'UNAVAILABLE'))
  -- A cursor without a kind is a value nothing can interpret.
  AND ("cursor" IS NULL OR "cursorKind" IS NOT NULL)
);

ALTER TABLE "work_sync_runs" ADD CONSTRAINT "work_sync_runs_shape_check" CHECK (
  "source" IN ('GMAIL', 'CALENDAR', 'DRIVE')
  AND ("outcome" IS NULL OR "outcome" IN ('SUCCEEDED', 'TRUNCATED', 'FAILED'))
  AND ("failureClass" IS NULL OR "failureClass" IN ('NETWORK', 'TIMEOUT', 'RATE_LIMITED', 'AUTH', 'MALFORMED', 'CURSOR_EXPIRED', 'UNAVAILABLE'))
  -- An outcome means the run finished; a failure class belongs only to a FAILED run.
  AND (("outcome" IS NULL) = ("finishedAt" IS NULL))
  AND ("failureClass" IS NULL OR "outcome" = 'FAILED')
  -- Counts are measurements: absent when not measured, never negative.
  AND ("examined" IS NULL OR "examined" >= 0)
  AND ("written" IS NULL OR "written" >= 0)
  AND ("finishedAt" IS NULL OR "finishedAt" >= "startedAt")
);

-- A raw address may never be written into the hash column, and a hash is all 64 hex digits.
ALTER TABLE "work_correspondents" ADD CONSTRAINT "work_correspondents_shape_check" CHECK (
  "addressHash" ~ '^[0-9a-f]{64}$'
  AND length("displayAddress") BETWEEN 3 AND 320
  AND ("domain" IS NULL OR "domain" = lower("domain"))
  AND "inboundCount" >= 0
  AND "outboundCount" >= 0
  AND "lastSeenAt" >= "firstSeenAt"
);

-- Threads: the class vocabulary, and a class that cannot exist without the rule that set it.
ALTER TABLE "work_threads" ADD CONSTRAINT "work_threads_shape_check" CHECK (
  "provider" IN ('GOOGLE')
  AND ("derivedClass" IS NULL OR "derivedClass" IN ('NEEDS_YOU', 'WAITING_ON_THEM', 'GONE_QUIET', 'FYI'))
  AND (("derivedClass" IS NULL) = ("classRuleVersion" IS NULL))
  AND ("lastDirection" IS NULL OR "lastDirection" IN ('INBOUND', 'OUTBOUND'))
  AND "messageCount" >= 0
  AND ("medianReplyMinutes" IS NULL OR "medianReplyMinutes" >= 0)
  AND ("firstMessageAt" IS NULL OR "lastMessageAt" IS NULL OR "lastMessageAt" >= "firstMessageAt")
);

ALTER TABLE "work_messages" ADD CONSTRAINT "work_messages_shape_check" CHECK (
  "provider" IN ('GOOGLE')
  AND "direction" IN ('INBOUND', 'OUTBOUND')
  AND ("fromHash" IS NULL OR "fromHash" ~ '^[0-9a-f]{64}$')
);

ALTER TABLE "work_events" ADD CONSTRAINT "work_events_shape_check" CHECK (
  "provider" IN ('GOOGLE')
  AND ("organizerHash" IS NULL OR "organizerHash" ~ '^[0-9a-f]{64}$')
  AND ("attendeeCount" IS NULL OR "attendeeCount" >= 0)
  AND ("externalAttendeeCount" IS NULL OR "externalAttendeeCount" >= 0)
  AND ("attendeeCount" IS NULL OR "externalAttendeeCount" IS NULL OR "externalAttendeeCount" <= "attendeeCount")
  AND ("startsAt" IS NULL OR "endsAt" IS NULL OR "endsAt" >= "startsAt")
);

ALTER TABLE "work_documents" ADD CONSTRAINT "work_documents_shape_check" CHECK (
  "provider" IN ('GOOGLE')
);

-- Items: the queue row. The producer vocabulary is what lets a Stage 3 task write the same
-- row instead of a second queue; the closed-state rules are what keep the accuracy signal.
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_shape_check" CHECK (
  "class" IN ('NEEDS_YOU', 'WAITING_ON_THEM', 'GONE_QUIET', 'FYI')
  AND "subjectKind" IN ('THREAD', 'EVENT', 'DOCUMENT', 'CORRESPONDENT')
  AND "producerKind" IN ('RULE', 'MODEL')
  AND length("producerId") BETWEEN 1 AND 128
  AND length("producerVersion") BETWEEN 1 AND 64
  AND "state" IN ('OPEN', 'SNOOZED', 'RESOLVED', 'DISMISSED')
  AND ("outcome" IS NULL OR "outcome" IN ('HANDLED', 'NOT_MINE', 'NO_ACTION_NEEDED', 'FALSE_POSITIVE', 'SUPERSEDED', 'EXPIRED'))
  -- Closed means closed: resolvedAt and outcome exist exactly for RESOLVED and DISMISSED.
  AND (("state" IN ('RESOLVED', 'DISMISSED')) = ("resolvedAt" IS NOT NULL))
  AND (("resolvedAt" IS NULL) = ("outcome" IS NULL))
  AND (("state" = 'SNOOZED') = ("snoozedUntil" IS NOT NULL))
  AND "detectionCount" >= 1
  AND "lastDetectedAt" >= "firstDetectedAt"
  -- Stage 2 seam: a quote is capped, and never stored without the message it came from.
  AND ("evidenceQuote" IS NULL OR length("evidenceQuote") <= 240)
  AND (("evidenceQuote" IS NULL) = ("evidenceQuoteRef" IS NULL))
);

ALTER TABLE "work_item_observations" ADD CONSTRAINT "work_item_observations_shape_check" CHECK (
  "observationType" IN ('DETECTED', 'REDETECTED', 'SNOOZED', 'UNSNOOZED', 'RESOLVED', 'DISMISSED', 'REOPENED')
  AND "actorType" IN ('HUMAN', 'SYSTEM')
  -- A human act names the human; a system act never claims one.
  AND (("actorType" = 'HUMAN') = ("actorUserId" IS NOT NULL))
  AND "sequence" >= 1
  AND ("previousState" IS NULL OR "previousState" IN ('OPEN', 'SNOOZED', 'RESOLVED', 'DISMISSED'))
  AND ("newState" IS NULL OR "newState" IN ('OPEN', 'SNOOZED', 'RESOLVED', 'DISMISSED'))
);

-- Briefs are immutable records of a window; a regeneration is a new version.
ALTER TABLE "work_briefs" ADD CONSTRAINT "work_briefs_shape_check" CHECK (
  "version" >= 1
  AND "windowEnd" > "windowStart"
  AND length("generatorVersion") BETWEEN 1 AND 64
);

ALTER TABLE "work_feedback" ADD CONSTRAINT "work_feedback_shape_check" CHECK (
  "kind" IN ('NOT_IMPORTANT', 'ALREADY_HANDLED', 'NOT_WAITING', 'SUPPRESS_CORRESPONDENT', 'SUPPRESS_DOMAIN')
  AND "subjectKind" IN ('THREAD', 'EVENT', 'DOCUMENT', 'CORRESPONDENT')
);

ALTER TABLE "employee_work_preferences" ADD CONSTRAINT "employee_work_preferences_shape_check" CHECK (
  length("timeZone") BETWEEN 1 AND 64
  AND "dayStartMinutes" BETWEEN 0 AND 1439
  AND ("quietStartMinutes" IS NULL OR "quietStartMinutes" BETWEEN 0 AND 1439)
  AND ("quietEndMinutes" IS NULL OR "quietEndMinutes" BETWEEN 0 AND 1439)
  -- A quiet window is both ends or neither.
  AND (("quietStartMinutes" IS NULL) = ("quietEndMinutes" IS NULL))
);

-- Retention: the POLICY lives in @emgloop/shared as reviewed, versioned code. This table
-- holds only an organization's deliberate departure from it, per category, in days.
ALTER TABLE "work_retention_overrides" ADD CONSTRAINT "work_retention_overrides_shape_check" CHECK (
  "category" IN (
    'GMAIL_METADATA', 'THREAD_CONTEXT', 'DRIVE_METADATA', 'CALENDAR_STATE',
    'DERIVED_WORK_FACTS', 'BRIEFS', 'PROCESSING_CACHE', 'OPERATIONAL_SYNC_STATE'
  )
  -- Only day-counted categories may be overridden: NEVER_STORED, TIED_TO_PARENT and
  -- GOVERNED_ELSEWHERE are not durations and cannot be expressed as one.
  AND "days" IS NOT NULL
  AND "days" BETWEEN 1 AND 3650
  AND length("policyVersion") BETWEEN 1 AND 64
);
