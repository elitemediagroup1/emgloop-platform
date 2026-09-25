-- Loop Intelligence Phase F (2026-09-26): case_private_scopes and situation_candidates -- a Case that cites one person's private
-- intelligence belongs to that person alone.
--
-- WHAT CHANGES
--   1. case_private_scopes: the ONE owner of a private situation (a Case whose sourceSystem is
--      'loop-situation:private'). One row per Case (unique), cascading with the Case, the organization and
--      the user. Keys only.
--   2. situation_candidates: the last model decision per deterministic cluster (NEW / UPDATE / NONE) and
--      the fingerprint it was made on, so an UNCHANGED cluster is never sent to a model again -- including
--      a cluster the model said was nothing. userId NULL is the organization's; set, that person's own.
--      One row per (organization, cluster) and per (organization, user, cluster): partial unique indexes,
--      because a NULL userId would defeat a plain one. Keys and hashes only.
--
-- WHY A TABLE AND NOT A COLUMN. Existing Case reads select whole rows; a new column on
-- operational_priorities would make every one of them fail on a database this has not reached. A new
-- table leaves every existing read untouched.
--
-- FAIL CLOSED BOTH WAYS. Every organization-level Case read already excludes the private sourceSystem
-- (by value, so it holds before this migration too); the private read requires a scope row naming the
-- reader. A private Case with no scope row is visible to nobody.
--
-- ADDITIVE. No row is rewritten. Code deployed before this migration writes no private situation
-- (NOT_MIGRATED) and every existing Case surface behaves exactly as before.
--
-- ASCII only.

-- CreateTable
CREATE TABLE "case_private_scopes" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "case_private_scopes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "case_private_scopes_caseId_key" ON "case_private_scopes"("caseId");

-- CreateIndex
CREATE INDEX "case_private_scopes_organizationId_userId_idx" ON "case_private_scopes"("organizationId", "userId");

-- AddForeignKey
ALTER TABLE "case_private_scopes" ADD CONSTRAINT "case_private_scopes_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_private_scopes" ADD CONSTRAINT "case_private_scopes_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "operational_priorities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_private_scopes" ADD CONSTRAINT "case_private_scopes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "situation_candidates" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT,
    "clusterKey" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "caseId" TEXT,
    "verification" TEXT,
    "decidedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "situation_candidates_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "situation_candidates_decision_check" CHECK ("decision" IN ('NEW', 'UPDATE', 'NONE'))
);

-- CreateIndex
CREATE INDEX "situation_candidates_organizationId_userId_idx" ON "situation_candidates"("organizationId", "userId");

-- One organization row per cluster; one private row per (person, cluster).
CREATE UNIQUE INDEX "situation_candidates_org_cluster_key" ON "situation_candidates"("organizationId", "clusterKey") WHERE "userId" IS NULL;
CREATE UNIQUE INDEX "situation_candidates_user_cluster_key" ON "situation_candidates"("organizationId", "userId", "clusterKey") WHERE "userId" IS NOT NULL;

-- AddForeignKey
ALTER TABLE "situation_candidates" ADD CONSTRAINT "situation_candidates_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "situation_candidates" ADD CONSTRAINT "situation_candidates_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
