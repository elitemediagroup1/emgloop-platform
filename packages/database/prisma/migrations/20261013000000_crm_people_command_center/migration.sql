-- CRM slice 6 (2026-10-08): the People command center. ADDITIVE ONLY: four new tables, no existing
-- table or row is touched. docs/architecture/crm-people-command-center.md.
--
--   crm_subject_context_facts  FACTS about a Party beyond its identity -- title, notes, the source's
--                              own status and last-contacted time, creator and company context, origin
--                              -- each with its basis, source and time precision. Shared across the
--                              organization. Never a contact value, never a Relationship, never an
--                              Opportunity, never identity evidence.
--   crm_outreach_states        HUMAN INTERPRETATION: the projection of crm_outreach_events, one row per
--   crm_outreach_events        Party: a conversation state and a next action a person set. Append-only.
--   crm_discovery_dismissals   ONE PERSON'S private dismissals in their own "Possible New People" queue,
--                              keyed by the address hash their own work_correspondents rows carry. It
--                              belongs to the membership (composite FK, cascade), like every work_* row.
--
-- Mail- and calendar-derived outreach (cadence, replies, meetings) is NOT stored here: it is derived
-- on every read from the viewer's own work_* rows, so it cannot outlive or escape them.
--
-- The vocabularies are strings validated by `@emgloop/shared` crm-outreach.ts AND by the CHECKs below.

-- Outbox events for this authority are filterable on their own. Added, never used in this migration.
ALTER TYPE "OutboxSubjectType" ADD VALUE 'CRM_OUTREACH';

-- CreateTable
CREATE TABLE "crm_subject_context_facts" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "partyId" TEXT NOT NULL,
    "partyType" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "text" TEXT,
    "redactions" INTEGER NOT NULL DEFAULT 0,
    "relatedPartyId" TEXT,
    "occurredAt" TIMESTAMP(3),
    "occurredAtPrecision" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "basis" TEXT NOT NULL,
    "sourceRef" TEXT,
    "importRunId" TEXT,
    "importLine" INTEGER,
    "dedupeKey" TEXT NOT NULL,
    "recordedByUserId" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retractedAt" TIMESTAMP(3),
    "retractedByUserId" TEXT,

    CONSTRAINT "crm_subject_context_facts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_outreach_states" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "partyId" TEXT NOT NULL,
    "state" TEXT,
    "stateSetAt" TIMESTAMP(3),
    "stateSetByUserId" TEXT,
    "nextAction" TEXT,
    "nextActionDueAt" TIMESTAMP(3),
    "nextActionSetAt" TIMESTAMP(3),
    "nextActionSetByUserId" TEXT,
    "lastSequence" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_outreach_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_outreach_events" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "partyId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "state" TEXT,
    "nextAction" TEXT,
    "nextActionDueAt" TIMESTAMP(3),
    "actorUserId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crm_outreach_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_discovery_dismissals" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "correspondentHash" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "dismissedAt" TIMESTAMP(3) NOT NULL,
    "restoredAt" TIMESTAMP(3),

    CONSTRAINT "crm_discovery_dismissals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "crm_subject_context_facts_organizationId_partyId_kind_idx" ON "crm_subject_context_facts"("organizationId", "partyId", "kind");

-- CreateIndex
CREATE INDEX "crm_subject_context_facts_organizationId_kind_relatedPartyI_idx" ON "crm_subject_context_facts"("organizationId", "kind", "relatedPartyId");

-- CreateIndex
CREATE UNIQUE INDEX "crm_subject_context_facts_organizationId_dedupeKey_key" ON "crm_subject_context_facts"("organizationId", "dedupeKey");

-- CreateIndex
CREATE INDEX "crm_outreach_states_organizationId_state_idx" ON "crm_outreach_states"("organizationId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "crm_outreach_states_organizationId_partyId_key" ON "crm_outreach_states"("organizationId", "partyId");

-- CreateIndex
CREATE INDEX "crm_outreach_events_organizationId_partyId_occurredAt_idx" ON "crm_outreach_events"("organizationId", "partyId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "crm_outreach_events_organizationId_partyId_sequence_key" ON "crm_outreach_events"("organizationId", "partyId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "crm_discovery_dismissals_organizationId_userId_corresponden_key" ON "crm_discovery_dismissals"("organizationId", "userId", "correspondentHash");

-- AddForeignKey
ALTER TABLE "crm_subject_context_facts" ADD CONSTRAINT "crm_subject_context_facts_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_outreach_states" ADD CONSTRAINT "crm_outreach_states_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_outreach_events" ADD CONSTRAINT "crm_outreach_events_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_discovery_dismissals" ADD CONSTRAINT "crm_discovery_dismissals_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_discovery_dismissals" ADD CONSTRAINT "crm_discovery_dismissals_userId_organizationId_fkey" FOREIGN KEY ("userId", "organizationId") REFERENCES "organization_memberships"("userId", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;


-- Vocabularies, enforced by the database as well as the contract.
ALTER TABLE "crm_subject_context_facts"
  ADD CONSTRAINT "crm_subject_context_facts_kind_check"
    CHECK ("kind" IN ('TITLE', 'NOTE', 'SOURCE_STATUS', 'SOURCE_LAST_CONTACTED', 'CREATOR_CONTEXT', 'COMPANY_CONTEXT', 'ORIGIN')),
  ADD CONSTRAINT "crm_subject_context_facts_basis_check"
    CHECK ("basis" IN ('IMPORTED', 'OPERATOR_RECORDED')),
  ADD CONSTRAINT "crm_subject_context_facts_precision_check"
    CHECK ("occurredAtPrecision" IN ('INSTANT', 'DATE', 'UNKNOWN')),
  -- A time of UNKNOWN precision has no time; a known precision has one.
  ADD CONSTRAINT "crm_subject_context_facts_time_check"
    CHECK (("occurredAtPrecision" = 'UNKNOWN') = ("occurredAt" IS NULL)),
  -- An IMPORTED fact names the run and line it came from.
  ADD CONSTRAINT "crm_subject_context_facts_import_check"
    CHECK ("basis" <> 'IMPORTED' OR ("importRunId" IS NOT NULL AND "importLine" IS NOT NULL)),
  ADD CONSTRAINT "crm_subject_context_facts_redactions_check"
    CHECK ("redactions" >= 0);

ALTER TABLE "crm_outreach_states"
  ADD CONSTRAINT "crm_outreach_states_state_check"
    CHECK ("state" IS NULL OR "state" IN ('ACTIVE_CONVERSATION', 'INTERESTED', 'MEETING_SCHEDULED', 'NEGOTIATING', 'ON_HOLD', 'CIRCLE_BACK', 'PASSED', 'CLOSED'));

ALTER TABLE "crm_outreach_events"
  ADD CONSTRAINT "crm_outreach_events_type_check"
    CHECK ("type" IN ('STATE_SET', 'STATE_CLEARED', 'NEXT_ACTION_SET', 'NEXT_ACTION_CLEARED')),
  ADD CONSTRAINT "crm_outreach_events_state_check"
    CHECK ("state" IS NULL OR "state" IN ('ACTIVE_CONVERSATION', 'INTERESTED', 'MEETING_SCHEDULED', 'NEGOTIATING', 'ON_HOLD', 'CIRCLE_BACK', 'PASSED', 'CLOSED'));

ALTER TABLE "crm_discovery_dismissals"
  ADD CONSTRAINT "crm_discovery_dismissals_reason_check"
    CHECK ("reason" IN ('IGNORE', 'NOT_A_PERSON', 'INTERNAL', 'AUTOMATED', 'NOT_RELEVANT')),
  -- The same shape every work_* address hash has: never a readable address.
  ADD CONSTRAINT "crm_discovery_dismissals_hash_check"
    CHECK ("correspondentHash" ~ '^[0-9a-f]{64}$');
