-- Sprint 27D — Business Process Engine · PR B (Runtime & Persistence)
-- Additive, non-destructive: creates three new tables and touches NOTHING else.
-- No existing table is altered, so this migration is fully reversible with zero
-- data loss to any other table.
--
-- Design invariants encoded here (frozen constitutional decisions):
--   1. process_transitions is APPEND-ONLY and is the SOLE source of truth. There
--      is intentionally no current-state / current-phase / readiness column on
--      process_instances — current state is always projected from the log.
--   2. The readiness/verification snapshots are AUDIT only; readiness is always
--      re-derived fresh before a commit and never authorized from a snapshot.
--
-- ROLLBACK (in FK-safe order):
--     DROP TABLE "process_transitions";
--     DROP TABLE "process_instances";
--     DROP TABLE "process_definitions";
-- No other table references these, so rollback is clean.

-- CreateTable — immutable, versioned, org-scoped process templates.
CREATE TABLE "process_definitions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "objectiveKey" TEXT NOT NULL,
    "objectiveLabel" TEXT,
    "subjectType" TEXT NOT NULL,
    "allowBackward" BOOLEAN NOT NULL DEFAULT false,
    "allowRestart" BOOLEAN NOT NULL DEFAULT false,
    "phases" JSONB NOT NULL DEFAULT '[]',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "publishedAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "process_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable — a subject's run of a pinned definition version. References only;
-- no projected state is stored here.
CREATE TABLE "process_instances" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "definitionId" TEXT NOT NULL,
    "definitionKey" TEXT NOT NULL,
    "definitionVersion" INTEGER NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectLabel" TEXT NOT NULL,
    "subjectExternalId" TEXT,
    "objectiveKey" TEXT NOT NULL,
    "objectiveLabel" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "archivedAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "process_instances_pkey" PRIMARY KEY ("id")
);

-- CreateTable — the append-only transition log (the source of truth).
CREATE TABLE "process_transitions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "processInstanceId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "fromPhaseKey" TEXT,
    "toPhaseKey" TEXT,
    "proposer" TEXT NOT NULL,
    "proposedByUserId" TEXT,
    "confirmedByUserId" TEXT,
    "readinessSnapshot" JSONB NOT NULL DEFAULT '{}',
    "verificationSnapshot" JSONB NOT NULL DEFAULT '{}',
    "rationale" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "process_transitions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "process_definitions_organizationId_key_version_key" ON "process_definitions"("organizationId", "key", "version");
CREATE INDEX "process_definitions_organizationId_key_status_idx" ON "process_definitions"("organizationId", "key", "status");

CREATE INDEX "process_instances_organizationId_definitionKey_idx" ON "process_instances"("organizationId", "definitionKey");
CREATE INDEX "process_instances_organizationId_createdAt_idx" ON "process_instances"("organizationId", "createdAt");

-- Append-only integrity: exactly one row per (instance, sequence).
CREATE UNIQUE INDEX "process_transitions_processInstanceId_sequence_key" ON "process_transitions"("processInstanceId", "sequence");
CREATE INDEX "process_transitions_organizationId_processInstanceId_sequence_idx" ON "process_transitions"("organizationId", "processInstanceId", "sequence");

-- AddForeignKey — pin instances to their exact definition version (never deleted
-- while instances exist).
ALTER TABLE "process_instances" ADD CONSTRAINT "process_instances_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "process_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "process_transitions" ADD CONSTRAINT "process_transitions_processInstanceId_fkey" FOREIGN KEY ("processInstanceId") REFERENCES "process_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;
