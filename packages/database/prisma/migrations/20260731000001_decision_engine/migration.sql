-- The Decision Engine: owner/assignee split, canonical outcomes, first-class evidence.
--
-- Additive only. Zero DROP, zero rename, zero column-type change. Verified by
-- from-zero replay against PostgreSQL 16 (see the PR).
--
-- POSTGRES NOTE: this adds several enum values. Prisma warns that PostgreSQL 11
-- and earlier cannot do that in one migration. Production is Neon (PostgreSQL 15+),
-- and no new value is USED by any statement in this file, which is the condition
-- that matters inside a transaction. If this ever has to run on <= 11, split it
-- one value per migration.
--
-- ASCII only. See docs/architecture/migration-remediation-plan.md.

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "OperationalObservationType" ADD VALUE 'REASSIGNED';
ALTER TYPE "OperationalObservationType" ADD VALUE 'UNASSIGNED';
ALTER TYPE "OperationalObservationType" ADD VALUE 'PRIORITY_CHANGED';
ALTER TYPE "OperationalObservationType" ADD VALUE 'SEVERITY_CHANGED';
ALTER TYPE "OperationalObservationType" ADD VALUE 'EVIDENCE_ADDED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "OperationalOutcome" ADD VALUE 'DUPLICATE';
ALTER TYPE "OperationalOutcome" ADD VALUE 'MERGED';
ALTER TYPE "OperationalOutcome" ADD VALUE 'SUPPRESSED';
ALTER TYPE "OperationalOutcome" ADD VALUE 'EXPIRED';
ALTER TYPE "OperationalOutcome" ADD VALUE 'CONVERTED_TO_WORK';

-- AlterTable
ALTER TABLE "operational_priorities" ADD COLUMN     "assigneeUserId" TEXT,
ADD COLUMN     "confidence" DOUBLE PRECISION,
ADD COLUMN     "priority" TEXT,
ADD COLUMN     "producerVersion" TEXT,
ADD COLUMN     "sourceReference" TEXT;

-- AlterTable
ALTER TABLE "operational_observations" ADD COLUMN     "destinationId" TEXT,
ADD COLUMN     "destinationSystem" TEXT,
ADD COLUMN     "destinationType" TEXT,
ADD COLUMN     "evidenceId" TEXT,
ADD COLUMN     "newState" "OperationalPriorityState",
ADD COLUMN     "previousState" "OperationalPriorityState",
ADD COLUMN     "reason" TEXT;

-- CreateTable
CREATE TABLE "decision_evidence" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "priorityId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "metricKey" TEXT NOT NULL,
    "window" TEXT,
    "ruleId" TEXT,
    "ruleVersion" TEXT,
    "formulaVersion" TEXT,
    "calculationVersion" TEXT,
    "producerVersion" TEXT,
    "confidence" DOUBLE PRECISION,
    "rawValue" DOUBLE PRECISION,
    "normalizedValue" DOUBLE PRECISION,
    "derivedValue" DOUBLE PRECISION,
    "completeness" DOUBLE PRECISION,
    "entityType" TEXT,
    "entityId" TEXT,
    "entityName" TEXT,
    "limitations" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "unknowns" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "payload" JSONB NOT NULL DEFAULT '{}',
    "observedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "decision_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "decision_evidence_organizationId_priorityId_observedAt_idx" ON "decision_evidence"("organizationId", "priorityId", "observedAt");

-- CreateIndex
CREATE INDEX "decision_evidence_organizationId_metricKey_idx" ON "decision_evidence"("organizationId", "metricKey");

-- CreateIndex
CREATE INDEX "operational_priorities_organizationId_assigneeUserId_state_idx" ON "operational_priorities"("organizationId", "assigneeUserId", "state");

-- CreateIndex
CREATE INDEX "operational_observations_evidenceId_idx" ON "operational_observations"("evidenceId");

-- AddForeignKey
ALTER TABLE "operational_observations" ADD CONSTRAINT "operational_observations_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "decision_evidence"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decision_evidence" ADD CONSTRAINT "decision_evidence_priorityId_fkey" FOREIGN KEY ("priorityId") REFERENCES "operational_priorities"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Backfill: assignment is EXECUTION, ownership is ACCOUNTABILITY, and until now
-- there was only one column. Every existing value was written by an ASSIGNED
-- observation, which meant "who is working this" -- so it becomes the assignee.
-- ownerUserId is deliberately left as-is rather than duplicated: claiming that
-- whoever picked a task up is also accountable for it would be inventing an
-- accountability record that nobody ever set.
UPDATE "operational_priorities"
   SET "assigneeUserId" = "ownerUserId"
 WHERE "assigneeUserId" IS NULL
   AND "ownerUserId" IS NOT NULL;
