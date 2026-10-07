-- CRM slice 5 (2026-10-07): the governed outreach importer's own authority. ADDITIVE ONLY: six new
-- tables, no existing table or row is touched.
--
-- The source file is evidence, not CRM authority. These tables hold the REVIEWED rules that read it
-- (creator aliases, route classifications), the runs that read it, what each row was planned and
-- applied as, and the keys that make a re-run idempotent. They are not a copy of the source: no
-- email, phone, contact name, title or note is stored -- source hashes, keyed row fingerprints,
-- codes, mapping ids and CRM subject ids only. Every CRM write still goes through the governed
-- Party, Contact Point and Opportunity services.
--
-- ONE MIGRATION: the six tables are one authority with no ordering between them, and none is
-- useful without the others.

-- PROVENANCE IS NEVER ERASED BY A CASCADE FROM OTHER PROVENANCE. The references between import rows
-- (an approval -> its dry run, an APPLY run -> the approval it claimed, an import key -> its run, an
-- entry -> its run) are real foreign keys with NO ACTION: a referenced run, approval or key cannot be
-- deleted on its own. Only the organization's deletion removes them, all in one statement (NO ACTION is
-- checked at the end of the statement, so that cascade succeeds where RESTRICT could fail mid-way). The
-- import key's CRM subject id is deliberately NOT a foreign key: it names a Party or an Opportunity, and
-- provenance must never block a governed CRM lifecycle from running.
--
-- AN APPROVAL IS CONSUMED WHEN AN APPLY RUN CLAIMS IT. `crm_import_runs.approvalId` is UNIQUE, so one
-- approval is owned by at most one APPLY run -- whatever that run's outcome (SUCCEEDED, FAILED,
-- ABANDONED). Inserting the APPLY run IS the claim, so two concurrent claims cannot both succeed.
-- Recovery after a partial APPLY is a fresh dry run and a fresh approval, never the old one.

CREATE TABLE "crm_import_creator_aliases" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "aliasKey" TEXT NOT NULL,
    "aliasText" TEXT NOT NULL,
    "creatorPartyId" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "activeKey" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retiredAt" TIMESTAMP(3),
    "retiredByUserId" TEXT,
    "replacedById" TEXT,

    CONSTRAINT "crm_import_creator_aliases_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "crm_import_route_mappings" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "routeKey" TEXT NOT NULL,
    "routeText" TEXT NOT NULL,
    "classification" TEXT NOT NULL,
    "targetCompanyPartyId" TEXT,
    "proposedCompanyName" TEXT,
    "representedBrandPartyId" TEXT,
    "representedBrandRouteKey" TEXT,
    "state" TEXT NOT NULL,
    "activeKey" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retiredAt" TIMESTAMP(3),
    "retiredByUserId" TEXT,
    "replacedById" TEXT,

    CONSTRAINT "crm_import_route_mappings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "crm_import_runs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "importerVersion" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceRef" TEXT NOT NULL,
    "sourceSha256" TEXT NOT NULL,
    "configFingerprint" TEXT NOT NULL,
    "planDigest" TEXT,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "counts" JSONB NOT NULL DEFAULT '{}',
    "failureCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "approvalId" TEXT,
    "applyLockKey" TEXT,
    "startedByUserId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "abandonedByUserId" TEXT,

    CONSTRAINT "crm_import_runs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "crm_import_approvals" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "dryRunId" TEXT NOT NULL,
    "sourceSha256" TEXT NOT NULL,
    "importerVersion" TEXT NOT NULL,
    "configFingerprint" TEXT NOT NULL,
    "planDigest" TEXT NOT NULL,
    "approvedByUserId" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crm_import_approvals_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "crm_import_entries" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "importRunId" TEXT NOT NULL,
    "line" INTEGER NOT NULL,
    "sourceRowKey" TEXT,
    "rowFingerprint" TEXT,
    "routeMappingId" TEXT,
    "routeClassification" TEXT,
    "creatorAliasId" TEXT,
    "pursuitKey" TEXT,
    "outcome" TEXT NOT NULL,
    "ambiguityCode" TEXT,
    "companyAction" TEXT,
    "personAction" TEXT,
    "opportunityAction" TEXT,
    "contactPointActions" JSONB NOT NULL DEFAULT '[]',
    "companyPartyId" TEXT,
    "personPartyId" TEXT,
    "opportunityId" TEXT,
    "contactPointIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crm_import_entries_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "crm_import_keys" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "keyKind" TEXT NOT NULL,
    "keyValue" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "importRunId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crm_import_keys_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "crm_import_creator_aliases_organizationId_aliasKey_idx" ON "crm_import_creator_aliases"("organizationId", "aliasKey");

CREATE UNIQUE INDEX "crm_import_creator_aliases_organizationId_activeKey_key" ON "crm_import_creator_aliases"("organizationId", "activeKey");

CREATE INDEX "crm_import_route_mappings_organizationId_routeKey_idx" ON "crm_import_route_mappings"("organizationId", "routeKey");

CREATE UNIQUE INDEX "crm_import_route_mappings_organizationId_activeKey_key" ON "crm_import_route_mappings"("organizationId", "activeKey");

CREATE UNIQUE INDEX "crm_import_runs_approvalId_key" ON "crm_import_runs"("approvalId");

CREATE UNIQUE INDEX "crm_import_runs_applyLockKey_key" ON "crm_import_runs"("applyLockKey");

CREATE INDEX "crm_import_runs_organizationId_startedAt_idx" ON "crm_import_runs"("organizationId", "startedAt");

CREATE INDEX "crm_import_runs_organizationId_sourceSha256_mode_state_idx" ON "crm_import_runs"("organizationId", "sourceSha256", "mode", "state");

CREATE UNIQUE INDEX "crm_import_approvals_dryRunId_key" ON "crm_import_approvals"("dryRunId");

CREATE INDEX "crm_import_entries_organizationId_sourceRowKey_idx" ON "crm_import_entries"("organizationId", "sourceRowKey");

CREATE UNIQUE INDEX "crm_import_entries_importRunId_line_key" ON "crm_import_entries"("importRunId", "line");

CREATE INDEX "crm_import_keys_organizationId_subjectId_idx" ON "crm_import_keys"("organizationId", "subjectId");

CREATE UNIQUE INDEX "crm_import_keys_organizationId_keyKind_keyValue_key" ON "crm_import_keys"("organizationId", "keyKind", "keyValue");

ALTER TABLE "crm_import_creator_aliases" ADD CONSTRAINT "crm_import_creator_aliases_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "crm_import_route_mappings" ADD CONSTRAINT "crm_import_route_mappings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "crm_import_runs" ADD CONSTRAINT "crm_import_runs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "crm_import_runs" ADD CONSTRAINT "crm_import_runs_approvalId_fkey" FOREIGN KEY ("approvalId") REFERENCES "crm_import_approvals"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "crm_import_approvals" ADD CONSTRAINT "crm_import_approvals_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "crm_import_approvals" ADD CONSTRAINT "crm_import_approvals_dryRunId_fkey" FOREIGN KEY ("dryRunId") REFERENCES "crm_import_runs"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "crm_import_entries" ADD CONSTRAINT "crm_import_entries_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "crm_import_entries" ADD CONSTRAINT "crm_import_entries_importRunId_fkey" FOREIGN KEY ("importRunId") REFERENCES "crm_import_runs"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "crm_import_keys" ADD CONSTRAINT "crm_import_keys_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "crm_import_keys" ADD CONSTRAINT "crm_import_keys_importRunId_fkey" FOREIGN KEY ("importRunId") REFERENCES "crm_import_runs"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Closed vocabularies and the active-key invariants, enforced by the database as well as the code.
ALTER TABLE "crm_import_creator_aliases" ADD CONSTRAINT "crm_import_creator_aliases_state_check"
  CHECK ("state" IN ('ACTIVE', 'RETIRED')
     AND (("state" = 'ACTIVE' AND "activeKey" = "aliasKey") OR ("state" = 'RETIRED' AND "activeKey" IS NULL)));

ALTER TABLE "crm_import_route_mappings" ADD CONSTRAINT "crm_import_route_mappings_state_check"
  CHECK ("state" IN ('ACTIVE', 'RETIRED')
     AND (("state" = 'ACTIVE' AND "activeKey" = "routeKey") OR ("state" = 'RETIRED' AND "activeKey" IS NULL)));

ALTER TABLE "crm_import_route_mappings" ADD CONSTRAINT "crm_import_route_mappings_classification_check"
  CHECK ("classification" IN ('BRAND_COMPANY', 'AGENCY', 'PARENT_COMPANY', 'ROLE_INBOX_ROUTE', 'CREATOR_ROUTE', 'INTERNAL', 'PERSONAL_GENERIC', 'UNKNOWN'));

-- Only a Company route is (or proposes) a Company, never both; only a representing route names a brand, once.
ALTER TABLE "crm_import_route_mappings" ADD CONSTRAINT "crm_import_route_mappings_company_check"
  CHECK (
    (("targetCompanyPartyId" IS NULL AND "proposedCompanyName" IS NULL) OR "classification" IN ('BRAND_COMPANY', 'AGENCY', 'PARENT_COMPANY'))
    AND NOT ("targetCompanyPartyId" IS NOT NULL AND "proposedCompanyName" IS NOT NULL)
    AND (("representedBrandPartyId" IS NULL AND "representedBrandRouteKey" IS NULL) OR "classification" IN ('AGENCY', 'PARENT_COMPANY', 'ROLE_INBOX_ROUTE', 'PERSONAL_GENERIC'))
    AND NOT ("representedBrandPartyId" IS NOT NULL AND "representedBrandRouteKey" IS NOT NULL)
  );

ALTER TABLE "crm_import_runs" ADD CONSTRAINT "crm_import_runs_shape_check"
  CHECK ("mode" IN ('DRY_RUN', 'APPLY')
     AND "state" IN ('RUNNING', 'SUCCEEDED', 'FAILED', 'ABANDONED')
     AND "sourceType" = 'CSV'
     AND ("applyLockKey" IS NULL OR ("mode" = 'APPLY' AND "state" = 'RUNNING' AND "applyLockKey" = "organizationId"))
     AND ("mode" = 'APPLY' OR "approvalId" IS NULL)
     AND ("mode" = 'DRY_RUN' OR "approvalId" IS NOT NULL));

ALTER TABLE "crm_import_keys" ADD CONSTRAINT "crm_import_keys_kind_check"
  CHECK (("keyKind" IN ('COMPANY', 'PERSON') AND "subjectType" = 'PARTY')
      OR ("keyKind" = 'OPPORTUNITY' AND "subjectType" = 'CRM_OPPORTUNITY'));
