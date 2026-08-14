-- Commercial Intelligence Stage 1 -- Performance Objectives.
--
-- The first Commercial Intelligence concept to reach the schema, and the only
-- one in this stage. Human-authored intent: what an organization or a person is
-- trying to accomplish. No signal, no headline, no case, no finding, no metric.
--
-- ADDITIVE ONLY: 2 new enums, 1 new table, 3 new indexes, 3 new foreign keys.
-- Zero DROP, zero rename, zero column-type change, and NO EXISTING TABLE IS
-- ALTERED -- the two back-relations added to Organization and User are Prisma
-- virtual fields and emit no DDL against organizations or users. It therefore
-- applies safely on top of the current production schema and replays cleanly
-- from an empty database.
--
-- BACKWARD-COMPATIBLE WITH THE CURRENTLY DEPLOYED APPLICATION. The running
-- build has no knowledge of this table and never queries it; nothing existing
-- reads or writes it. Applying this migration ahead of the application deploy is
-- safe, and so is deploying the application without it (every read path fails
-- closed rather than returning wrong data).
--
-- LOCKING. CREATE TABLE and CREATE TYPE take no lock on existing data. The three
-- ALTER TABLE ... ADD CONSTRAINT statements lock only performance_objectives,
-- which is empty at creation time, so they are effectively instantaneous. The
-- referenced tables (organizations, users) take a brief SHARE ROW EXCLUSIVE lock
-- while the FK is validated against zero rows. No table rewrite, no index build
-- over existing data, no blocking of production traffic.
--
-- DELETE BEHAVIOUR (approved product decision P-6). Objectives are tenant data
-- and die with the tenant: organizationId cascades. scopeUserId cascades because
-- a USER-scoped objective whose user is gone would violate the scope invariant
-- and cannot be left in the table; it also keeps organization deletion from
-- deadlocking against a restricted user reference. createdByUserId is SET NULL
-- because authorship is attribution and should outlive the author leaving --
-- the same reasoning audit_logs.userId already follows.
--
-- ASCII only, deliberately. The sprint_11 migration is unreplayable because a
-- Unicode em-dash precedes its leading comment marker; see
-- docs/architecture/migration-remediation-plan.md.

-- CreateEnum
CREATE TYPE "PerformanceObjectiveScope" AS ENUM ('ORGANIZATION', 'USER');

-- CreateEnum
CREATE TYPE "PerformanceObjectiveStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateTable
CREATE TABLE "performance_objectives" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "scope" "PerformanceObjectiveScope" NOT NULL,
    "scopeUserId" TEXT,
    "status" "PerformanceObjectiveStatus" NOT NULL DEFAULT 'ACTIVE',
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "performance_objectives_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "performance_objectives_organizationId_status_idx" ON "performance_objectives"("organizationId", "status");

-- CreateIndex
CREATE INDEX "performance_objectives_organizationId_scope_status_idx" ON "performance_objectives"("organizationId", "scope", "status");

-- CreateIndex
CREATE INDEX "performance_objectives_organizationId_scopeUserId_idx" ON "performance_objectives"("organizationId", "scopeUserId");

-- AddForeignKey
ALTER TABLE "performance_objectives" ADD CONSTRAINT "performance_objectives_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_objectives" ADD CONSTRAINT "performance_objectives_scopeUserId_fkey" FOREIGN KEY ("scopeUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_objectives" ADD CONSTRAINT "performance_objectives_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
