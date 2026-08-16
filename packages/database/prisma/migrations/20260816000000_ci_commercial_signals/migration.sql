-- Commercial Intelligence Stage 2 -- Commercial Signals.
--
-- A fact Loop observed, evaluated relative to a Performance Objective, together
-- with the reason it may be relevant. No headline, no case, no subject, no
-- evidence subsystem, no finding, no opportunity, no score.
--
-- ADDITIVE ONLY: 1 new table, 2 new indexes, 1 new unique index, 2 new foreign
-- keys, 0 new enums. Zero DROP, zero rename, zero column-type change, and NO
-- EXISTING TABLE IS ALTERED -- the two back-relations added to Organization and
-- PerformanceObjective are Prisma virtual fields and emit no DDL against
-- organizations or performance_objectives. It applies safely on top of the
-- current production schema and replays cleanly from an empty database.
--
-- THE INCUMBENT `signals` TABLE IS NOT TOUCHED. There is no statement in this
-- file that names it. `signals` holds behavioural enrichment attached to a
-- customer or conversation and is written by the signal registry and read by
-- four repositories; `commercial_signals` is a different concept that happens to
-- share an English word. Nothing here renames, alters, migrates from, or
-- references that table.
--
-- BACKWARD-COMPATIBLE WITH THE CURRENTLY DEPLOYED APPLICATION. The running build
-- has no knowledge of this table and never queries it; nothing existing reads or
-- writes it. Applying this migration ahead of the application deploy is safe,
-- and so is deploying the application without it (every read path fails closed
-- rather than returning wrong data).
--
-- LOCKING. CREATE TABLE takes no lock on existing data. The two ALTER TABLE ...
-- ADD CONSTRAINT statements lock only commercial_signals, which is empty at
-- creation time, so they are effectively instantaneous. The referenced tables
-- (organizations, performance_objectives) take a brief SHARE ROW EXCLUSIVE lock
-- while the FK is validated against zero rows. No table rewrite, no index build
-- over existing data, no blocking of production traffic.
--
-- NO FOREIGN KEY TO THE SOURCE DOMAIN, DELIBERATELY. sourceSystem + sourceKey
-- are opaque handles. A real FK to marketplace_calls was considered and
-- rejected: that table carries a scalar organizationId with no FK and a GLOBALLY
-- unique (provider, externalId), so a reference would inherit both defects.
-- Commercial Intelligence points at another domain's truth; it does not adopt
-- that domain's tenancy debt, and it does not take ownership of the record.
--
-- DELETE BEHAVIOUR. Signals are tenant data and die with the tenant, so
-- organizationId cascades. They also die with the objective they were defined
-- against, because relevance is a relation: a signal whose objective is gone is
-- relative to nothing and cannot be interpreted, so performanceObjectiveId
-- cascades too. Objectives are ARCHIVED rather than deleted in normal operation
-- (performance_objectives has no delete path), so this cascade fires on tenant
-- deletion, which is exactly when it should.
--
-- IDEMPOTENCY. The unique index is TENANT-SCOPED, unlike marketplace_calls'
-- global (provider, externalId). Re-running an evaluation over the same window
-- updates the two counters instead of accumulating duplicate determinations.
-- evaluatorId is part of the key so a future evaluator reaching the same
-- observation records its own determination rather than overwriting another's.
--
-- ASCII only, deliberately. The sprint_11 migration is unreplayable because a
-- Unicode em-dash precedes its leading comment marker; see
-- docs/architecture/migration-remediation-plan.md.

-- CreateTable
CREATE TABLE "commercial_signals" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "performanceObjectiveId" TEXT NOT NULL,
    "sourceSystem" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "sourceReference" TEXT,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "observationSummary" TEXT NOT NULL,
    "relevanceBasis" TEXT NOT NULL,
    "relevanceRationale" TEXT NOT NULL,
    "evaluatorId" TEXT NOT NULL,
    "evaluatorVersion" TEXT NOT NULL,
    "firstEvaluatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastEvaluatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "evaluationCount" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commercial_signals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "commercial_signals_organizationId_observedAt_idx" ON "commercial_signals"("organizationId", "observedAt");

-- CreateIndex
CREATE INDEX "commercial_signals_org_objective_observedAt_idx" ON "commercial_signals"("organizationId", "performanceObjectiveId", "observedAt");

-- CreateIndex
CREATE UNIQUE INDEX "commercial_signals_org_objective_source_evaluator_key" ON "commercial_signals"("organizationId", "performanceObjectiveId", "sourceSystem", "sourceKey", "evaluatorId");

-- AddForeignKey
ALTER TABLE "commercial_signals" ADD CONSTRAINT "commercial_signals_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commercial_signals" ADD CONSTRAINT "commercial_signals_performanceObjectiveId_fkey" FOREIGN KEY ("performanceObjectiveId") REFERENCES "performance_objectives"("id") ON DELETE CASCADE ON UPDATE CASCADE;
