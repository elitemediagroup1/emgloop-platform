-- CRM slice R2: the Relationship and Participant authority, and two read indexes.
--
-- ADDITIVE ONLY. Three new tables, one new enum VALUE, two new indexes on existing
-- tables. Zero DROP, zero rename, zero column change on any existing table, zero
-- backfill. No existing row is read, written or moved by this migration.
--
-- ASCII ONLY. A leading em-dash in the sprint_11 migration blocked replay of the
-- entire ledger once (see PR #152); this file is deliberately plain ASCII.
--
-- ================== WHAT THIS ADDS ==================
--
-- crm_relationships        a commercial connection a person asserted exists
-- crm_relationship_events  its append-only history; nothing is ever deleted
-- crm_participants         an established Party's contextual role in a subject
--
-- NOTHING WRITES THESE TABLES YET. Slice R2 is schema plus repositories; the
-- governed services, authorization and outbox land in R3. After this migration the
-- three tables are empty and every existing code path behaves exactly as before.
--
-- ================== VOCABULARIES ARE TEXT ==================
--
-- kind, structure, state, role, side and event type are TEXT validated in
-- `@emgloop/shared`, not Postgres enums. Product approved the starting kinds and
-- roles as a versioned contract (PD-F-03), and adding one must be a reviewed
-- contract change rather than a schema migration on a live database. CHECK
-- constraints below pin the values that are structural rather than vocabulary.
--
-- ================== THE TWO UNIQUE INDEXES ==================
--
-- crm_relationships(organizationId, nonVoidedNaturalKey): the key is the kind and
-- its side Party ids. It is held while ACTIVE or ENDED -- an ended Relationship
-- keeps its key, so renewing reactivates rather than duplicates -- and NULL once
-- VOIDED. Postgres treats rows with a NULL in the index as distinct, so this binds
-- exactly the non-voided rows and needs no partial index (Prisma 5.22 cannot
-- express one). The same device as customer_party_links.activeCustomerId.
--
-- crm_participants(organizationId, activeKey): at most one ACTIVE row per subject,
-- Party and role. Ending or voiding sets it NULL, which releases the key, so the
-- same Party holding the same role again later writes a NEW row and the old row
-- stays as history.
--
-- ================== THE TWO PERFORMANCE INDEXES ==================
--
-- interactions(organizationId, customerId, occurredAt) and
-- audit_logs(organizationId, entityType, entityId, createdAt) serve Universal
-- Activity's per-subject reads (slice A2). PERFORMANCE ONLY: both queries already
-- return exactly these rows today by reading a less specific index and sorting.
-- No result changes; no behaviour depends on them.

-- AlterEnum
-- Safe inside the transaction Prisma wraps a migration in: PostgreSQL 12 and later
-- allow ADD VALUE there provided the new value is not USED in the same transaction,
-- and nothing below writes an outbox row. Production is PostgreSQL 18.
ALTER TYPE "OutboxSubjectType" ADD VALUE 'RELATIONSHIP';

-- CreateTable
CREATE TABLE "crm_relationships" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "structure" TEXT NOT NULL,
    "nonVoidedNaturalKey" TEXT,
    "state" TEXT NOT NULL,
    "projectionVersion" INTEGER NOT NULL DEFAULT 1,
    "lastSequence" INTEGER NOT NULL DEFAULT 0,
    "label" TEXT,
    "description" TEXT,
    "ownerUserId" TEXT,
    "businessStartDate" DATE,
    "businessEndDate" DATE,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "voidedAt" TIMESTAMP(3),

    CONSTRAINT "crm_relationships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_relationship_events" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "relationshipId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "occurredAtBasis" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorType" TEXT NOT NULL,
    "actorUserId" TEXT,
    "reason" TEXT,
    "participantId" TEXT,
    "fromState" TEXT,
    "toState" TEXT,
    "changedFields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crm_relationship_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_participants" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "relationshipId" TEXT,
    "partyId" TEXT NOT NULL,
    "partyType" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "roleFamily" TEXT NOT NULL,
    "side" TEXT,
    "actsForSide" TEXT,
    "state" TEXT NOT NULL,
    "effectiveFrom" DATE,
    "effectiveTo" DATE,
    "activeKey" TEXT,
    "addedByUserId" TEXT,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "endedByUserId" TEXT,
    "endReason" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidedByUserId" TEXT,
    "voidReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_participants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "crm_relationships_organizationId_nonVoidedNaturalKey_key" ON "crm_relationships"("organizationId", "nonVoidedNaturalKey");

-- CreateIndex
CREATE INDEX "crm_relationships_organizationId_state_createdAt_idx" ON "crm_relationships"("organizationId", "state", "createdAt");

-- CreateIndex
CREATE INDEX "crm_relationships_organizationId_kind_state_idx" ON "crm_relationships"("organizationId", "kind", "state");

-- CreateIndex
CREATE INDEX "crm_relationships_organizationId_ownerUserId_idx" ON "crm_relationships"("organizationId", "ownerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "crm_relationship_events_relationshipId_sequence_key" ON "crm_relationship_events"("relationshipId", "sequence");

-- CreateIndex
CREATE INDEX "crm_relationship_events_organizationId_relationshipId_sequen_idx" ON "crm_relationship_events"("organizationId", "relationshipId", "sequence");

-- CreateIndex
CREATE INDEX "crm_relationship_events_organizationId_type_occurredAt_idx" ON "crm_relationship_events"("organizationId", "type", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "crm_participants_organizationId_activeKey_key" ON "crm_participants"("organizationId", "activeKey");

-- CreateIndex
CREATE INDEX "crm_participants_organizationId_relationshipId_state_idx" ON "crm_participants"("organizationId", "relationshipId", "state");

-- CreateIndex
CREATE INDEX "crm_participants_organizationId_partyId_state_idx" ON "crm_participants"("organizationId", "partyId", "state");

-- CreateIndex
CREATE INDEX "interactions_organizationId_customerId_occurredAt_idx" ON "interactions"("organizationId", "customerId", "occurredAt");

-- CreateIndex
CREATE INDEX "audit_logs_organizationId_entityType_entityId_createdAt_idx" ON "audit_logs"("organizationId", "entityType", "entityId", "createdAt");

-- AddForeignKey
ALTER TABLE "crm_relationships" ADD CONSTRAINT "crm_relationships_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_relationships" ADD CONSTRAINT "crm_relationships_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_relationships" ADD CONSTRAINT "crm_relationships_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_relationship_events" ADD CONSTRAINT "crm_relationship_events_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_relationship_events" ADD CONSTRAINT "crm_relationship_events_relationshipId_fkey" FOREIGN KEY ("relationshipId") REFERENCES "crm_relationships"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_relationship_events" ADD CONSTRAINT "crm_relationship_events_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_participants" ADD CONSTRAINT "crm_participants_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_participants" ADD CONSTRAINT "crm_participants_relationshipId_fkey" FOREIGN KEY ("relationshipId") REFERENCES "crm_relationships"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_participants" ADD CONSTRAINT "crm_participants_addedByUserId_fkey" FOREIGN KEY ("addedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_participants" ADD CONSTRAINT "crm_participants_endedByUserId_fkey" FOREIGN KEY ("endedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_participants" ADD CONSTRAINT "crm_participants_voidedByUserId_fkey" FOREIGN KEY ("voidedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The lifecycle a row claims and the stamps it carries must agree, and the natural
-- key must be released by exactly the state that releases it. Prisma does not model
-- CHECK constraints; the database alone enforces these.
ALTER TABLE "crm_relationships" ADD CONSTRAINT "crm_relationships_state_consistent"
  CHECK (
    "state" IN ('ACTIVE', 'ENDED', 'VOIDED')
    AND "structure" IN ('OWN', 'THIRD_PARTY')
    AND ("state" = 'VOIDED') = ("nonVoidedNaturalKey" IS NULL)
    AND ("state" <> 'ENDED' OR "endedAt" IS NOT NULL)
    AND ("state" <> 'VOIDED' OR "voidedAt" IS NOT NULL)
    AND ("state" <> 'ACTIVE' OR ("endedAt" IS NULL AND "voidedAt" IS NULL))
    AND ("endedAt" IS NULL OR "endedAt" >= "createdAt")
    AND ("voidedAt" IS NULL OR "voidedAt" >= "createdAt")
    AND ("businessEndDate" IS NULL OR "businessStartDate" IS NULL OR "businessEndDate" >= "businessStartDate")
    AND "lastSequence" >= 0
  );

-- An event is a human act with a time basis, and a reason where the act says no or
-- undoes. Sequence starts at 1: a log with a zeroth entry is not a history.
ALTER TABLE "crm_relationship_events" ADD CONSTRAINT "crm_relationship_events_shape"
  CHECK (
    "sequence" >= 1
    AND "actorType" = 'HUMAN'
    AND "occurredAtBasis" IN ('PROVIDER_REPORTED', 'LOOP_CLOCK', 'OPERATOR_STATED', 'REPORTING_WINDOW', 'UNKNOWN')
    AND (
      "type" NOT IN ('RELATIONSHIP_ENDED', 'RELATIONSHIP_VOIDED', 'PARTICIPANT_ENDED', 'PARTICIPANT_VOIDED')
      OR ("reason" IS NOT NULL AND btrim("reason") <> '')
    )
  );

-- EXACTLY ONE SUBJECT (the exclusive arc), exactly one of side or acts-for, a Party
-- type the Party authority can actually report, and an active key held by exactly
-- the ACTIVE rows. `opportunityId` and `campaignId` join the first clause when
-- those authorities exist.
ALTER TABLE "crm_participants" ADD CONSTRAINT "crm_participants_shape"
  CHECK (
    "relationshipId" IS NOT NULL
    AND "state" IN ('ACTIVE', 'ENDED', 'VOIDED')
    AND "partyType" IN ('PERSON', 'COMPANY')
    AND "roleFamily" IN ('CAPACITY', 'ENGAGEMENT')
    AND (("side" IS NULL) <> ("actsForSide" IS NULL))
    AND ("side" IS NULL OR "side" IN ('COUNTERPARTY', 'A', 'B'))
    AND ("actsForSide" IS NULL OR "actsForSide" IN ('COUNTERPARTY', 'A', 'B'))
    AND ("state" = 'ACTIVE') = ("activeKey" IS NOT NULL)
    AND ("state" <> 'ENDED' OR "endedAt" IS NOT NULL)
    AND ("state" <> 'VOIDED' OR "voidedAt" IS NOT NULL)
    AND ("state" <> 'ACTIVE' OR ("endedAt" IS NULL AND "voidedAt" IS NULL))
    AND ("effectiveTo" IS NULL OR "effectiveFrom" IS NULL OR "effectiveTo" >= "effectiveFrom")
  );
