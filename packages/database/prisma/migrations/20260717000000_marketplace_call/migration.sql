-- MarketplaceCall — sensor-neutral operational call projection.
-- Additive, non-destructive: creates one new table. It does NOT touch
-- interactions, integration_events, or any existing table. The raw Interaction
-- record and Interaction.metadata remain the source of truth; this table is a
-- rebuildable projection (see projectWindow / the read-path backfill).
--
-- ROLLBACK: this migration is fully reversible with no data loss to any other
-- table, because nothing else is modified. To roll back:
--     DROP TABLE "marketplace_calls";
-- The projection can be regenerated at any time from interactions via
-- MarketplaceCallRepository.projectWindow(), so dropping it loses no source data.

-- CreateTable
CREATE TABLE "marketplace_calls" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "interactionId" TEXT,
    "sourceOccurredAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT,
    "rawStatus" TEXT,
    "endedBy" TEXT,
    "durationSeconds" INTEGER,
    "buyerExternalId" TEXT,
    "buyerLabel" TEXT,
    "vendorExternalId" TEXT,
    "vendorLabel" TEXT,
    "sourceExternalId" TEXT,
    "sourceLabel" TEXT,
    "campaignExternalId" TEXT,
    "campaignLabel" TEXT,
    "destinationExternalId" TEXT,
    "callerState" TEXT,
    "callerZip" TEXT,
    "revenueCents" INTEGER,
    "payoutCents" INTEGER,
    "costCents" INTEGER,
    "rateCents" INTEGER,
    "qualified" BOOLEAN,
    "billable" BOOLEAN,
    "converted" BOOLEAN,
    "paid" BOOLEAN,
    "completed" BOOLEAN,
    "noRoute" BOOLEAN,
    "duplicate" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "marketplace_calls_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (idempotency key)
CREATE UNIQUE INDEX "marketplace_calls_provider_externalId_key" ON "marketplace_calls"("provider", "externalId");

-- CreateIndex (query paths for the Intelligence layer)
CREATE INDEX "marketplace_calls_organizationId_sourceOccurredAt_idx" ON "marketplace_calls"("organizationId", "sourceOccurredAt");
CREATE INDEX "marketplace_calls_organizationId_buyerExternalId_idx" ON "marketplace_calls"("organizationId", "buyerExternalId");
CREATE INDEX "marketplace_calls_organizationId_vendorExternalId_idx" ON "marketplace_calls"("organizationId", "vendorExternalId");
CREATE INDEX "marketplace_calls_organizationId_sourceExternalId_idx" ON "marketplace_calls"("organizationId", "sourceExternalId");
CREATE INDEX "marketplace_calls_organizationId_campaignExternalId_idx" ON "marketplace_calls"("organizationId", "campaignExternalId");
CREATE INDEX "marketplace_calls_organizationId_status_idx" ON "marketplace_calls"("organizationId", "status");
CREATE INDEX "marketplace_calls_organizationId_qualified_idx" ON "marketplace_calls"("organizationId", "qualified");
CREATE INDEX "marketplace_calls_organizationId_billable_idx" ON "marketplace_calls"("organizationId", "billable");
CREATE INDEX "marketplace_calls_organizationId_converted_idx" ON "marketplace_calls"("organizationId", "converted");
