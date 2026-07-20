-- Sprint 27 — Work Intelligence Foundation (PR #121A)
-- ---------------------------------------------------------------------------
-- HAND-WRITTEN, ADDITIVE migration (same convention as the PR #75 runtime
-- migration). It matches the models appended/altered in schema.prisma in this
-- PR. Before applying in an environment with database access, run
-- `prisma migrate diff` / `prisma migrate dev` to validate against the live
-- schema. Column/table/index names are kept in sync with the Prisma models by
-- hand and use Prisma's default naming so drift stays minimal.
--
-- DESTRUCTIVE-STATEMENT SCAN: none. This migration performs only
--   ADD COLUMN, CREATE TABLE, CREATE INDEX, ADD CONSTRAINT (FK),
--   UPDATE (backfill of a newly-added column), and ALTER COLUMN SET NOT NULL
--   (after backfill). There is NO DROP, DELETE, TRUNCATE, or destructive
--   type/rename ALTER. Existing rows remain valid.
--
-- Two partial unique indexes (active-only) cannot be expressed in the Prisma
-- schema; they are created here and additionally enforced in the repository:
--   * at most one ACTIVE responsibility assignment per (responsibility,user,type)
--   * at most one ACTIVE 'proposed' handoff per work instance
-- ---------------------------------------------------------------------------

-- === Alter: work_instances — additive nullable columns (source defaults 'manual') ===
ALTER TABLE "work_instances"
    ADD COLUMN "workType" TEXT,
    ADD COLUMN "priority" TEXT,
    ADD COLUMN "source" TEXT NOT NULL DEFAULT 'manual',
    ADD COLUMN "reason" TEXT,
    ADD COLUMN "dedupeKey" TEXT,
    ADD COLUMN "dueAt" TIMESTAMP(3),
    ADD COLUMN "businessContextTag" TEXT,
    ADD COLUMN "attributionType" TEXT,
    ADD COLUMN "attributionLabel" TEXT,
    ADD COLUMN "attributionExternalId" TEXT,
    ADD COLUMN "ownerUserId" TEXT,
    ADD COLUMN "currentResponsibilityId" TEXT,
    ADD COLUMN "waitingOnType" TEXT,
    ADD COLUMN "waitingOnLabel" TEXT,
    ADD COLUMN "completedByUserId" TEXT,
    ADD COLUMN "verifiedAt" TIMESTAMP(3),
    ADD COLUMN "verifiedByUserId" TEXT,
    ADD COLUMN "reopenedAt" TIMESTAMP(3),
    ADD COLUMN "archivedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "work_instances_organizationId_dedupeKey_key" ON "work_instances"("organizationId", "dedupeKey");
CREATE INDEX "work_instances_organizationId_workType_status_idx" ON "work_instances"("organizationId", "workType", "status");
CREATE INDEX "work_instances_organizationId_currentResponsibilityId_idx" ON "work_instances"("organizationId", "currentResponsibilityId");
CREATE INDEX "work_instances_organizationId_ownerUserId_status_idx" ON "work_instances"("organizationId", "ownerUserId", "status");

-- === Alter: work_assignments — add organizationId, backfill, then enforce NOT NULL ===
ALTER TABLE "work_assignments" ADD COLUMN "organizationId" TEXT;
UPDATE "work_assignments" wa
    SET "organizationId" = wi."organizationId"
    FROM "work_instances" wi
    WHERE wa."workInstanceId" = wi."id";
ALTER TABLE "work_assignments" ALTER COLUMN "organizationId" SET NOT NULL;
CREATE INDEX "work_assignments_organizationId_idx" ON "work_assignments"("organizationId");

-- === Alter: work_comments — add organizationId, backfill, then enforce NOT NULL ===
ALTER TABLE "work_comments" ADD COLUMN "organizationId" TEXT;
UPDATE "work_comments" wc
    SET "organizationId" = wi."organizationId"
    FROM "work_instances" wi
    WHERE wc."workInstanceId" = wi."id";
ALTER TABLE "work_comments" ALTER COLUMN "organizationId" SET NOT NULL;
CREATE INDEX "work_comments_organizationId_idx" ON "work_comments"("organizationId");

-- === CreateTable: responsibilities ===
CREATE TABLE "responsibilities" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "responsibilities_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "responsibilities_organizationId_key_key" ON "responsibilities"("organizationId", "key");
CREATE INDEX "responsibilities_organizationId_active_idx" ON "responsibilities"("organizationId", "active");

-- === CreateTable: responsibility_assignments ===
CREATE TABLE "responsibility_assignments" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "responsibilityId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "assignmentType" TEXT NOT NULL DEFAULT 'primary',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "assignedByUserId" TEXT,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unassignedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "responsibility_assignments_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "responsibility_assignments_organizationId_responsibilityId_active_idx" ON "responsibility_assignments"("organizationId", "responsibilityId", "active");
CREATE INDEX "responsibility_assignments_organizationId_userId_active_idx" ON "responsibility_assignments"("organizationId", "userId", "active");
-- Partial unique: at most one ACTIVE assignment per (responsibility, user, type).
CREATE UNIQUE INDEX "responsibility_assignments_active_unique" ON "responsibility_assignments"("responsibilityId", "userId", "assignmentType") WHERE "active";
ALTER TABLE "responsibility_assignments" ADD CONSTRAINT "responsibility_assignments_responsibilityId_fkey" FOREIGN KEY ("responsibilityId") REFERENCES "responsibilities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- === CreateTable: work_requirements ===
CREATE TABLE "work_requirements" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workInstanceId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "category" TEXT,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'unknown',
    "satisfiedAt" TIMESTAMP(3),
    "satisfiedByUserId" TEXT,
    "evidenceLinkId" TEXT,
    "attestedAt" TIMESTAMP(3),
    "attestedByUserId" TEXT,
    "expiresAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "work_requirements_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "work_requirements_workInstanceId_key_key" ON "work_requirements"("workInstanceId", "key");
CREATE INDEX "work_requirements_organizationId_workInstanceId_idx" ON "work_requirements"("organizationId", "workInstanceId");
ALTER TABLE "work_requirements" ADD CONSTRAINT "work_requirements_workInstanceId_fkey" FOREIGN KEY ("workInstanceId") REFERENCES "work_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- === CreateTable: work_links ===
CREATE TABLE "work_links" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workInstanceId" TEXT NOT NULL,
    "linkType" TEXT NOT NULL,
    "refId" TEXT,
    "externalRef" TEXT,
    "label" TEXT,
    "provenance" TEXT NOT NULL DEFAULT 'manual',
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "work_links_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "work_links_organizationId_workInstanceId_idx" ON "work_links"("organizationId", "workInstanceId");
CREATE INDEX "work_links_organizationId_linkType_refId_idx" ON "work_links"("organizationId", "linkType", "refId");
ALTER TABLE "work_links" ADD CONSTRAINT "work_links_workInstanceId_fkey" FOREIGN KEY ("workInstanceId") REFERENCES "work_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- === CreateTable: work_blockers ===
CREATE TABLE "work_blockers" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workInstanceId" TEXT NOT NULL,
    "blockerType" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "waitingOnType" TEXT,
    "waitingOnLabel" TEXT,
    "linkedRequirementId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "openedByUserId" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedByUserId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolution" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "work_blockers_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "work_blockers_organizationId_workInstanceId_active_idx" ON "work_blockers"("organizationId", "workInstanceId", "active");
ALTER TABLE "work_blockers" ADD CONSTRAINT "work_blockers_workInstanceId_fkey" FOREIGN KEY ("workInstanceId") REFERENCES "work_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- === CreateTable: work_handoffs ===
CREATE TABLE "work_handoffs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workInstanceId" TEXT NOT NULL,
    "fromUserId" TEXT,
    "fromResponsibilityId" TEXT,
    "toUserId" TEXT,
    "toResponsibilityId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "reason" TEXT,
    "nextAction" TEXT,
    "unresolvedWarnings" JSONB NOT NULL DEFAULT '[]',
    "readinessSnapshot" JSONB NOT NULL DEFAULT '{}',
    "proposedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "proposedByUserId" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "acceptedByUserId" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "rejectedByUserId" TEXT,
    "rejectionReason" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelledByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "work_handoffs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "work_handoffs_organizationId_workInstanceId_status_idx" ON "work_handoffs"("organizationId", "workInstanceId", "status");
CREATE INDEX "work_handoffs_organizationId_toUserId_status_idx" ON "work_handoffs"("organizationId", "toUserId", "status");
-- Partial unique: at most one ACTIVE 'proposed' handoff per work instance.
CREATE UNIQUE INDEX "work_handoffs_active_proposed_unique" ON "work_handoffs"("workInstanceId") WHERE "status" = 'proposed';
ALTER TABLE "work_handoffs" ADD CONSTRAINT "work_handoffs_workInstanceId_fkey" FOREIGN KEY ("workInstanceId") REFERENCES "work_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- === CreateTable: work_assets ===
CREATE TABLE "work_assets" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workInstanceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "currentVersion" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "externalUrl" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "work_assets_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "work_assets_organizationId_workInstanceId_idx" ON "work_assets"("organizationId", "workInstanceId");
ALTER TABLE "work_assets" ADD CONSTRAINT "work_assets_workInstanceId_fkey" FOREIGN KEY ("workInstanceId") REFERENCES "work_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- === CreateTable: work_asset_versions ===
CREATE TABLE "work_asset_versions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workAssetId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "fileRef" TEXT,
    "url" TEXT,
    "checksum" TEXT,
    "notes" TEXT,
    "submittedByUserId" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersededAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "work_asset_versions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "work_asset_versions_workAssetId_version_key" ON "work_asset_versions"("workAssetId", "version");
CREATE INDEX "work_asset_versions_organizationId_workAssetId_idx" ON "work_asset_versions"("organizationId", "workAssetId");
ALTER TABLE "work_asset_versions" ADD CONSTRAINT "work_asset_versions_workAssetId_fkey" FOREIGN KEY ("workAssetId") REFERENCES "work_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- === CreateTable: work_asset_approvals ===
CREATE TABLE "work_asset_approvals" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workAssetId" TEXT NOT NULL,
    "workAssetVersionId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "approverUserId" TEXT,
    "approverResponsibilityId" TEXT,
    "comments" TEXT,
    "evidenceLinkId" TEXT,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedByUserId" TEXT,
    "revokeReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "work_asset_approvals_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "work_asset_approvals_organizationId_workAssetId_scope_idx" ON "work_asset_approvals"("organizationId", "workAssetId", "scope");
CREATE INDEX "work_asset_approvals_workAssetVersionId_scope_idx" ON "work_asset_approvals"("workAssetVersionId", "scope");
ALTER TABLE "work_asset_approvals" ADD CONSTRAINT "work_asset_approvals_workAssetId_fkey" FOREIGN KEY ("workAssetId") REFERENCES "work_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "work_asset_approvals" ADD CONSTRAINT "work_asset_approvals_workAssetVersionId_fkey" FOREIGN KEY ("workAssetVersionId") REFERENCES "work_asset_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- === CreateTable: work_events ===
CREATE TABLE "work_events" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workInstanceId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "actorType" TEXT NOT NULL DEFAULT 'user',
    "actorUserId" TEXT,
    "actorResponsibilityId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "summary" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "work_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "work_events_organizationId_workInstanceId_occurredAt_idx" ON "work_events"("organizationId", "workInstanceId", "occurredAt");
ALTER TABLE "work_events" ADD CONSTRAINT "work_events_workInstanceId_fkey" FOREIGN KEY ("workInstanceId") REFERENCES "work_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;
