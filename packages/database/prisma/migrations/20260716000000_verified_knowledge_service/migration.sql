-- Verified Knowledge Service (kg.v1)
-- Additive migration: creates the verified knowledge graph tables (vk_*).
-- No changes to existing tables. No foreign keys to existing core tables
-- (mirrors the loop_events precedent) so the migration stays purely additive
-- and does not require a provisioned Organization row. Tenant/platform scope is
-- carried as plain scalar columns and enforced at the query layer.

-- CreateTable
CREATE TABLE "vk_sources" (
    "id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "property" TEXT NOT NULL,
    "organizationId" TEXT,
    "sourceKey" TEXT NOT NULL,
    "tier" INTEGER,
    "kind" TEXT,
    "title" TEXT,
    "publisher" TEXT,
    "url" TEXT,
    "accessed" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "quote" TEXT,
    "capturedBy" TEXT,
    "authorityScope" TEXT,
    "limitations" TEXT,
    "reviewCadence" TEXT,
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vk_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vk_entities" (
    "id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "property" TEXT NOT NULL,
    "organizationId" TEXT,
    "entityKey" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT,
    "confidence" TEXT,
    "verification" TEXT,
    "safetyCritical" BOOLEAN NOT NULL DEFAULT false,
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "currentVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vk_entities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vk_entity_versions" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT,
    "confidence" TEXT,
    "verification" TEXT,
    "safetyCritical" BOOLEAN NOT NULL DEFAULT false,
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "importBatchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vk_entity_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vk_claims" (
    "id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "property" TEXT NOT NULL,
    "organizationId" TEXT,
    "claimKey" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "predicate" TEXT NOT NULL,
    "value" JSONB NOT NULL DEFAULT '{}',
    "confidence" TEXT,
    "verification" TEXT,
    "safetyCritical" BOOLEAN NOT NULL DEFAULT false,
    "validFrom" TIMESTAMP(3),
    "validUntil" TIMESTAMP(3),
    "expires" TIMESTAMP(3),
    "reviewBy" TIMESTAMP(3),
    "note" TEXT,
    "currentVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vk_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vk_claim_versions" (
    "id" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "subject" TEXT NOT NULL,
    "predicate" TEXT NOT NULL,
    "value" JSONB NOT NULL DEFAULT '{}',
    "confidence" TEXT,
    "verification" TEXT,
    "safetyCritical" BOOLEAN NOT NULL DEFAULT false,
    "validFrom" TIMESTAMP(3),
    "validUntil" TIMESTAMP(3),
    "expires" TIMESTAMP(3),
    "reviewBy" TIMESTAMP(3),
    "note" TEXT,
    "importBatchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vk_claim_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vk_relationships" (
    "id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "property" TEXT NOT NULL,
    "organizationId" TEXT,
    "edgeKey" TEXT NOT NULL,
    "edge" TEXT NOT NULL,
    "fromKey" TEXT NOT NULL,
    "toKey" TEXT NOT NULL,
    "confidence" TEXT,
    "verification" TEXT,
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "currentVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vk_relationships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vk_provenance" (
    "id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "property" TEXT NOT NULL,
    "organizationId" TEXT,
    "sourceId" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetKey" TEXT NOT NULL,
    "supports" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "verifier" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vk_provenance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vk_lifecycle_events" (
    "id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "property" TEXT NOT NULL,
    "organizationId" TEXT,
    "objectType" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "previousStatus" TEXT,
    "newStatus" TEXT,
    "transitionAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor" TEXT,
    "reason" TEXT,
    "supportingRef" TEXT,
    "importBatchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vk_lifecycle_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vk_import_batches" (
    "id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "property" TEXT NOT NULL,
    "organizationId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "contractVersion" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'completed',
    "inserted" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "traceId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vk_import_batches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vk_sources_platform_property_sourceKey_key" ON "vk_sources"("platform", "property", "sourceKey");
CREATE INDEX "vk_sources_platform_property_organizationId_idx" ON "vk_sources"("platform", "property", "organizationId");

CREATE UNIQUE INDEX "vk_entities_platform_property_entityKey_key" ON "vk_entities"("platform", "property", "entityKey");
CREATE INDEX "vk_entities_platform_property_organizationId_idx" ON "vk_entities"("platform", "property", "organizationId");
CREATE INDEX "vk_entities_platform_property_type_idx" ON "vk_entities"("platform", "property", "type");

CREATE UNIQUE INDEX "vk_entity_versions_entityId_version_key" ON "vk_entity_versions"("entityId", "version");
CREATE INDEX "vk_entity_versions_entityId_idx" ON "vk_entity_versions"("entityId");

CREATE UNIQUE INDEX "vk_claims_platform_property_claimKey_key" ON "vk_claims"("platform", "property", "claimKey");
CREATE INDEX "vk_claims_platform_property_organizationId_subject_idx" ON "vk_claims"("platform", "property", "organizationId", "subject");
CREATE INDEX "vk_claims_platform_property_subject_predicate_idx" ON "vk_claims"("platform", "property", "subject", "predicate");

CREATE UNIQUE INDEX "vk_claim_versions_claimId_version_key" ON "vk_claim_versions"("claimId", "version");
CREATE INDEX "vk_claim_versions_claimId_idx" ON "vk_claim_versions"("claimId");

CREATE UNIQUE INDEX "vk_relationships_platform_property_edgeKey_key" ON "vk_relationships"("platform", "property", "edgeKey");
CREATE INDEX "vk_relationships_platform_property_organizationId_idx" ON "vk_relationships"("platform", "property", "organizationId");
CREATE INDEX "vk_relationships_platform_property_fromKey_edge_idx" ON "vk_relationships"("platform", "property", "fromKey", "edge");
CREATE INDEX "vk_relationships_platform_property_toKey_edge_idx" ON "vk_relationships"("platform", "property", "toKey", "edge");

CREATE UNIQUE INDEX "vk_provenance_sourceId_targetType_targetKey_key" ON "vk_provenance"("sourceId", "targetType", "targetKey");
CREATE INDEX "vk_provenance_platform_property_targetType_targetKey_idx" ON "vk_provenance"("platform", "property", "targetType", "targetKey");

CREATE INDEX "vk_lifecycle_events_platform_property_objectType_objectKey_idx" ON "vk_lifecycle_events"("platform", "property", "objectType", "objectKey");

CREATE UNIQUE INDEX "vk_import_batches_platform_property_idempotencyKey_key" ON "vk_import_batches"("platform", "property", "idempotencyKey");
CREATE INDEX "vk_import_batches_platform_property_organizationId_idx" ON "vk_import_batches"("platform", "property", "organizationId");

-- AddForeignKey
ALTER TABLE "vk_entity_versions" ADD CONSTRAINT "vk_entity_versions_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "vk_entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "vk_claim_versions" ADD CONSTRAINT "vk_claim_versions_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "vk_claims"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "vk_provenance" ADD CONSTRAINT "vk_provenance_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "vk_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;
