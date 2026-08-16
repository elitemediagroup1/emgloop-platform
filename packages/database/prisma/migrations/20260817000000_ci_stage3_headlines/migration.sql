-- Commercial Intelligence Stage 3 v1: Objective Measure Bindings and Headlines.
--
-- ADDITIVE ONLY. Two new tables, six indexes, eight foreign keys.
-- Zero ALTER against an existing table. Zero DROP. Zero rename. Zero column-type
-- change. No existing table is touched, including performance_objectives,
-- commercial_signals, signals, marketplace_calls and operational_priorities.
--
-- ASCII ONLY. A leading em-dash in the sprint_11 migration blocked replay of the
-- entire ledger once (see PR #152); this header is deliberately plain ASCII.
--
-- objective_measure_bindings
--   What a Performance Objective means in measurable terms: one metric, a
--   human-confirmed population of provider external ids, and a direction.
--   Immutable after confirmation and supersede-only, because a binding that can
--   be edited retroactively rewrites the meaning of every headline produced under
--   it. No target, no baseline, no unit, no formula: those are a KPI product and
--   a separate approval.
--
-- headlines
--   A measured development in one objective's world. This is NOT a decision and
--   carries no work lifecycle: no ownerUserId, no assigneeUserId, no lane, no
--   state machine, no outcome vocabulary, no reopen counter and no observation
--   log. Judgement and action live in operational_priorities, which is untouched
--   here. Promotion from a headline to a decision is Stage 3 v1.1 and no column
--   for it exists yet.
--
-- Identity on headlines is timestamp-free (binding version + metric + rule +
-- direction of the move), so a persisting condition resights one row rather than
-- accumulating one per period. The window a measurement covers is evidence, not
-- identity.
--
-- Tenancy: real foreign keys with defined delete behaviour, following the
-- performance_objectives and commercial_signals precedent. There is deliberately
-- NO foreign key to marketplace_calls, whose (provider, externalId) is globally
-- unique and whose organizationId has no FK; external ids are opaque handles.

-- CreateTable
CREATE TABLE "objective_measure_bindings" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "performanceObjectiveId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "metric" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "campaignExternalIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sourceExternalIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "buyerExternalIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "vendorExternalIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "callerStates" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "memberLabels" JSONB NOT NULL DEFAULT '{}',
    "confirmedByUserId" TEXT,
    "confirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersededAt" TIMESTAMP(3),
    "supersededByBindingId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "objective_measure_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "headlines" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "performanceObjectiveId" TEXT NOT NULL,
    "measureBindingId" TEXT NOT NULL,
    "recurrenceKey" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "ruleVersion" TEXT NOT NULL,
    "producerVersion" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "movement" TEXT NOT NULL,
    "againstObjective" BOOLEAN NOT NULL,
    "statement" TEXT NOT NULL,
    "currentValue" DOUBLE PRECISION,
    "priorValue" DOUBLE PRECISION,
    "absoluteChange" DOUBLE PRECISION,
    "percentageChange" DOUBLE PRECISION,
    "currentDenominator" INTEGER NOT NULL,
    "priorDenominator" INTEGER NOT NULL,
    "currentCoverage" DOUBLE PRECISION,
    "priorCoverage" DOUBLE PRECISION,
    "comparisonBasis" TEXT NOT NULL,
    "currentWindowStart" TIMESTAMP(3) NOT NULL,
    "currentWindowEnd" TIMESTAMP(3) NOT NULL,
    "priorWindowStart" TIMESTAMP(3) NOT NULL,
    "priorWindowEnd" TIMESTAMP(3) NOT NULL,
    "limitations" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "unknowns" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "firstDetectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastDetectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "detectionCount" INTEGER NOT NULL DEFAULT 1,
    "lastDetectionKey" TEXT NOT NULL,
    "dismissedAt" TIMESTAMP(3),
    "dismissedByUserId" TEXT,
    "dismissalBasis" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "headlines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "objective_measure_bindings_supersededByBindingId_key" ON "objective_measure_bindings"("supersededByBindingId");

-- CreateIndex
CREATE INDEX "objective_measure_bindings_org_objective_active_idx" ON "objective_measure_bindings"("organizationId", "performanceObjectiveId", "supersededAt");

-- CreateIndex
CREATE UNIQUE INDEX "objective_measure_bindings_objective_version_key" ON "objective_measure_bindings"("performanceObjectiveId", "version");

-- CreateIndex
CREATE INDEX "headlines_org_lastDetectedAt_idx" ON "headlines"("organizationId", "lastDetectedAt");

-- CreateIndex
CREATE INDEX "headlines_org_objective_dismissed_idx" ON "headlines"("organizationId", "performanceObjectiveId", "dismissedAt");

-- CreateIndex
CREATE UNIQUE INDEX "headlines_org_objective_recurrence_key" ON "headlines"("organizationId", "performanceObjectiveId", "recurrenceKey");

-- AddForeignKey
ALTER TABLE "objective_measure_bindings" ADD CONSTRAINT "objective_measure_bindings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "objective_measure_bindings" ADD CONSTRAINT "objective_measure_bindings_performanceObjectiveId_fkey" FOREIGN KEY ("performanceObjectiveId") REFERENCES "performance_objectives"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "objective_measure_bindings" ADD CONSTRAINT "objective_measure_bindings_confirmedByUserId_fkey" FOREIGN KEY ("confirmedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "objective_measure_bindings" ADD CONSTRAINT "objective_measure_bindings_supersededByBindingId_fkey" FOREIGN KEY ("supersededByBindingId") REFERENCES "objective_measure_bindings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "headlines" ADD CONSTRAINT "headlines_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "headlines" ADD CONSTRAINT "headlines_performanceObjectiveId_fkey" FOREIGN KEY ("performanceObjectiveId") REFERENCES "performance_objectives"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "headlines" ADD CONSTRAINT "headlines_measureBindingId_fkey" FOREIGN KEY ("measureBindingId") REFERENCES "objective_measure_bindings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "headlines" ADD CONSTRAINT "headlines_dismissedByUserId_fkey" FOREIGN KEY ("dismissedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

