-- Operational Decision Lifecycle -- platform primitives for turning intelligence into work.
--
-- Additive only: 4 new enums, 2 new tables, 3 new foreign keys, 10 indexes.
-- Zero DROP, zero rename, zero column-type change, and no existing table is
-- altered, so this applies safely on top of the current production schema and
-- replays cleanly from an empty database.
--
-- ASCII only, deliberately. The sprint_11 migration is unreplayable because a
-- Unicode em-dash precedes its leading comment marker; see
-- docs/architecture/migration-remediation-plan.md.

-- CreateEnum
CREATE TYPE "OperationalPriorityState" AS ENUM ('NEEDS_REVIEW', 'ASSIGNED', 'WATCHING', 'RESOLVED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "OperationalActorType" AS ENUM ('HUMAN', 'SYSTEM');

-- CreateEnum
CREATE TYPE "OperationalObservationType" AS ENUM ('SITUATION_DETECTED', 'SITUATION_RESIGHTED', 'REOPENED', 'REVIEWED', 'ASSIGNED', 'OWNER_CHANGED', 'WATCH_STARTED', 'WATCH_STOPPED', 'NOTE_ADDED', 'CONTACT_ATTEMPTED', 'CONTACT_COMPLETED', 'AWAITING_RESPONSE', 'RESPONSE_RECEIVED', 'ESCALATED', 'OUTCOME_RECORDED', 'RESOLVED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "OperationalOutcome" AS ENUM ('RECOVERED', 'PARTIALLY_RECOVERED', 'NOT_RECOVERED', 'NO_ACTION_NEEDED', 'FALSE_POSITIVE', 'ACCEPTED_RISK', 'NOT_ACTIONABLE', 'UNKNOWN');

-- CreateTable
CREATE TABLE "operational_priorities" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "sourceSystem" TEXT NOT NULL,
    "recurrenceKey" TEXT NOT NULL,
    "hypothesisId" TEXT,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "firstDetectedAt" TIMESTAMP(3) NOT NULL,
    "lastDetectedAt" TIMESTAMP(3) NOT NULL,
    "detectionCount" INTEGER NOT NULL DEFAULT 1,
    "severity" TEXT NOT NULL,
    "impactCents" INTEGER,
    "impactLabel" TEXT,
    "state" "OperationalPriorityState" NOT NULL DEFAULT 'NEEDS_REVIEW',
    "ownerUserId" TEXT,
    "stateChangedAt" TIMESTAMP(3),
    "reopenCount" INTEGER NOT NULL DEFAULT 0,
    "resolvedAt" TIMESTAMP(3),
    "outcome" "OperationalOutcome",
    "measuredEffectCents" INTEGER,
    "observationCount" INTEGER NOT NULL DEFAULT 0,
    "lastObservationAt" TIMESTAMP(3),
    "projectionVersion" TEXT NOT NULL DEFAULT 'v1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "operational_priorities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operational_observations" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "priorityId" TEXT NOT NULL,
    "decisionId" TEXT,
    "observationType" "OperationalObservationType" NOT NULL,
    "detectionKey" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sequence" INTEGER NOT NULL,
    "actorType" "OperationalActorType" NOT NULL,
    "actorUserId" TEXT,
    "source" TEXT NOT NULL,
    "note" TEXT,
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "assignedToUserId" TEXT,
    "outcome" "OperationalOutcome",
    "measuredEffectCents" INTEGER,
    "measuredEffectBasis" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operational_observations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "operational_priorities_organizationId_state_idx" ON "operational_priorities"("organizationId", "state");

-- CreateIndex
CREATE INDEX "operational_priorities_organizationId_ownerUserId_state_idx" ON "operational_priorities"("organizationId", "ownerUserId", "state");

-- CreateIndex
CREATE INDEX "operational_priorities_organizationId_sourceSystem_lastDete_idx" ON "operational_priorities"("organizationId", "sourceSystem", "lastDetectedAt");

-- CreateIndex
CREATE INDEX "operational_priorities_hypothesisId_idx" ON "operational_priorities"("hypothesisId");

-- CreateIndex
CREATE UNIQUE INDEX "operational_priorities_organizationId_sourceSystem_recurren_key" ON "operational_priorities"("organizationId", "sourceSystem", "recurrenceKey");

-- CreateIndex
CREATE INDEX "operational_observations_organizationId_priorityId_sequence_idx" ON "operational_observations"("organizationId", "priorityId", "sequence");

-- CreateIndex
CREATE INDEX "operational_observations_organizationId_observationType_occ_idx" ON "operational_observations"("organizationId", "observationType", "occurredAt");

-- CreateIndex
CREATE INDEX "operational_observations_organizationId_actorUserId_idx" ON "operational_observations"("organizationId", "actorUserId");

-- CreateIndex
CREATE INDEX "operational_observations_decisionId_idx" ON "operational_observations"("decisionId");

-- CreateIndex
CREATE UNIQUE INDEX "operational_observations_priorityId_sequence_key" ON "operational_observations"("priorityId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "operational_observations_priorityId_detectionKey_key" ON "operational_observations"("priorityId", "detectionKey");

-- AddForeignKey
ALTER TABLE "operational_priorities" ADD CONSTRAINT "operational_priorities_hypothesisId_fkey" FOREIGN KEY ("hypothesisId") REFERENCES "intelligence_hypotheses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operational_observations" ADD CONSTRAINT "operational_observations_priorityId_fkey" FOREIGN KEY ("priorityId") REFERENCES "operational_priorities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operational_observations" ADD CONSTRAINT "operational_observations_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "cognitive_decisions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

