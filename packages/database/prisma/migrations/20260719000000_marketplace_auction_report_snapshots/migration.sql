-- Auction report snapshots — verified aggregate CallGrid bid and ping reporting.
--
-- Additive and non-destructive: creates one enum and three new tables. It does
-- NOT touch marketplace_calls, interactions, integration_events, or any
-- existing table or column. No data is read, moved, or rewritten.
--
-- These are AGGREGATE snapshots, not event tables. CallGrid exposes no
-- event-level bid or ping record on any endpoint that returned data, so there
-- is deliberately no marketplace_bids table here.
--
-- Two grains are kept apart on purpose: bid snapshots are per SOURCE, ping
-- snapshots are per DESTINATION. There is no foreign key between them because
-- the provider asserts no relationship between them.
--
-- Money is stored as integer cents; percentages as percentage points. See the
-- schema comments — the dollars premise is evidence-gated per ingestion run via
-- marketplace_report_runs.moneyUnitEvidence, not assumed by this migration.
--
-- ROLLBACK: fully reversible with no data loss to any other table, because
-- nothing else is modified. To roll back:
--     DROP TABLE "marketplace_bid_source_snapshots";
--     DROP TABLE "marketplace_ping_destination_snapshots";
--     DROP TABLE "marketplace_report_runs";
--     DROP TYPE "MarketplaceReportRunStatus";
-- Every row in all three tables is re-derivable by re-running the admin sync
-- for the affected report windows, so dropping them loses no source data.

-- CreateEnum
CREATE TYPE "MarketplaceReportRunStatus" AS ENUM ('SUCCESS', 'EMPTY', 'ENDPOINT_FAILURE', 'MALFORMED_RESPONSE', 'UNKNOWN_ENVELOPE', 'PARTIAL_PAGINATION');

-- CreateTable
CREATE TABLE "marketplace_bid_source_snapshots" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "reportWindowStart" TIMESTAMP(3) NOT NULL,
    "reportWindowEnd" TIMESTAMP(3) NOT NULL,
    "reportTimezone" TEXT NOT NULL,
    "sourceExternalId" TEXT NOT NULL,
    "sourceName" TEXT,
    "sourceEndpoint" TEXT NOT NULL,
    "sourcePage" INTEGER,
    "sourceTotalPages" INTEGER,
    "providerPayloadHash" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "total" INTEGER,
    "bids" INTEGER,
    "rated" INTEGER,
    "won" INTEGER,
    "rejected" INTEGER,
    "totalBidAmountCents" INTEGER,
    "totalWonAmountCents" INTEGER,
    "avgBidCents" INTEGER,
    "avgWinningBidCents" INTEGER,
    "winRatePercent" DOUBLE PRECISION,
    "bidRatePercent" DOUBLE PRECISION,
    "rejectRatePercent" DOUBLE PRECISION,
    "rejectedDetail" INTEGER,
    "callerIdRejected" INTEGER,
    "closed" INTEGER,
    "paused" INTEGER,
    "duplicateCaller" INTEGER,
    "duplicateBids" INTEGER,
    "failedAcceptance" INTEGER,
    "failedTagRules" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "marketplace_bid_source_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketplace_ping_destination_snapshots" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "reportWindowStart" TIMESTAMP(3) NOT NULL,
    "reportWindowEnd" TIMESTAMP(3) NOT NULL,
    "reportTimezone" TEXT NOT NULL,
    "destinationExternalId" TEXT NOT NULL,
    "destinationName" TEXT,
    "providerRowDate" TIMESTAMP(3),
    "sourceEndpoint" TEXT NOT NULL,
    "sourcePage" INTEGER,
    "sourceTotalPages" INTEGER,
    "providerPayloadHash" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "accepted" INTEGER,
    "agents" INTEGER,
    "failedAcceptance" INTEGER,
    "failedTagRules" INTEGER,
    "minRevenue" INTEGER,
    "missingAmount" INTEGER,
    "invalidNumber" INTEGER,
    "durationElapsed" INTEGER,
    "pingTimeout" INTEGER,
    "apiFailed" INTEGER,
    "rateLimited" INTEGER,
    "suppressed" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "marketplace_ping_destination_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketplace_report_runs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "sourceEndpoint" TEXT NOT NULL,
    "reportWindowStart" TIMESTAMP(3) NOT NULL,
    "reportWindowEnd" TIMESTAMP(3) NOT NULL,
    "reportTimezone" TEXT NOT NULL,
    "status" "MarketplaceReportRunStatus" NOT NULL,
    "errorClassification" TEXT,
    "errorDetail" TEXT,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "pagesFetched" INTEGER,
    "sourceTotalPages" INTEGER,
    "rowCount" INTEGER,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "inserted" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "providerFooterTotals" JSONB,
    "recomputedTotals" JSONB,
    "moneyUnitEvidence" TEXT,
    "observedRowKeys" JSONB,
    "providerPayloadHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "marketplace_report_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "marketplace_bid_source_snapshots_organizationId_reportWindo_idx" ON "marketplace_bid_source_snapshots"("organizationId", "reportWindowStart");

-- CreateIndex
CREATE INDEX "marketplace_bid_source_snapshots_organizationId_provider_so_idx" ON "marketplace_bid_source_snapshots"("organizationId", "provider", "sourceExternalId");

-- CreateIndex
CREATE UNIQUE INDEX "marketplace_bid_source_snapshots_organizationId_provider_re_key" ON "marketplace_bid_source_snapshots"("organizationId", "provider", "reportWindowStart", "reportWindowEnd", "sourceExternalId");

-- CreateIndex
CREATE INDEX "marketplace_ping_destination_snapshots_organizationId_repor_idx" ON "marketplace_ping_destination_snapshots"("organizationId", "reportWindowStart");

-- CreateIndex
CREATE INDEX "marketplace_ping_destination_snapshots_organizationId_provi_idx" ON "marketplace_ping_destination_snapshots"("organizationId", "provider", "destinationExternalId");

-- CreateIndex
CREATE UNIQUE INDEX "marketplace_ping_destination_snapshots_organizationId_provi_key" ON "marketplace_ping_destination_snapshots"("organizationId", "provider", "reportWindowStart", "reportWindowEnd", "destinationExternalId");

-- CreateIndex
CREATE INDEX "marketplace_report_runs_organizationId_provider_endpoint_fe_idx" ON "marketplace_report_runs"("organizationId", "provider", "endpoint", "fetchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "marketplace_report_runs_organizationId_provider_endpoint_re_key" ON "marketplace_report_runs"("organizationId", "provider", "endpoint", "reportWindowStart", "reportWindowEnd");

