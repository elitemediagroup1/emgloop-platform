-- Commercial Intelligence Stage 3 correctness: provider observation completeness.
--
-- ADDITIVE ONLY. One new table, one unique index, one lookup index, one foreign
-- key, and two defaulted columns on headlines. Zero DROP. Zero rename. Zero
-- column-type change. Zero backfill of any existing row.
--
-- ASCII ONLY. A leading em-dash in the sprint_11 migration blocked replay of the
-- entire ledger once (see PR #152); this header is deliberately plain ASCII.
--
-- provider_observation_days
--   Whether Loop actually looked at one business date, for one data stream, from
--   one provider. Every other table in this schema records PRESENCE: an
--   interaction proves a call arrived, a marketplace_call proves one projected,
--   an integration_event proves a delivery was persisted. None of them records
--   ABSENCE, so a day with no rows has been indistinguishable from a day nobody
--   queried. In August 2026 that ambiguity sat directly inside a Stage 3
--   comparison window, where three unobserved days would have been measured and
--   published as a commercial collapse.
--
--   Completeness cannot be derived from stored rows. It is asserted by a bounded
--   read against the provider covering the whole Eastern business day, and this
--   table is that assertion. SUCCESS and EMPTY certify the day; PARTIAL_PAGINATION,
--   ENDPOINT_FAILURE, MALFORMED_RESPONSE and UNKNOWN_ENVELOPE do not; and the
--   absence of a row certifies nothing, which is why no row is ever written to
--   mean "unknown".
--
--   The status column REUSES "MarketplaceReportRunStatus", the enum the auction
--   report ledger has carried since 20260719000000. Its six members already name
--   every outcome a bounded provider read can have, including EMPTY -- "read
--   cleanly, provider returned no rows, a real reportable fact" -- which is
--   exactly the proven-quiet-day concept this work needs. No new enum is created,
--   because a second vocabulary meaning the same six things is the parallel-system
--   failure mode the engineering constitution names first.
--
-- Tenancy: a real foreign key with defined delete behaviour, and organizationId
-- participates in the natural unique key. integration_events is uniquely keyed
-- (provider, externalId) GLOBALLY and cannot be repaired in callers; this table
-- deliberately does not repeat that, so one tenant's certification can never
-- satisfy another tenant's measurement gate.
--
-- headlines.observationRuleVersion / headlines.observedDayCount
--   Provenance, so a stored Headline stays auditable when the completeness rule
--   changes. The defaults are 'none' and 0, which state plainly that a row
--   PREDATES this guard. They are deliberately not a version number and not a day
--   count: rows written before observation was proven were not certified, we
--   cannot know what was observed when they were written, and stamping a version
--   onto them would manufacture the certainty this whole change exists to refuse.
--   Nothing is backfilled.

-- CreateTable
CREATE TABLE "provider_observation_days" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "stream" TEXT NOT NULL,
    "businessDate" DATE NOT NULL,
    "timezone" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "status" "MarketplaceReportRunStatus" NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,
    "recordsObserved" INTEGER NOT NULL,
    "providerStatedTotal" INTEGER,
    "pagesFetched" INTEGER NOT NULL,
    "pageCap" INTEGER NOT NULL,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_observation_days_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "provider_observation_days_organizationId_provider_stream_bu_idx" ON "provider_observation_days"("organizationId", "provider", "stream", "businessDate");

-- CreateIndex
CREATE UNIQUE INDEX "observation_day_identity" ON "provider_observation_days"("organizationId", "provider", "stream", "businessDate");

-- AddForeignKey
ALTER TABLE "provider_observation_days" ADD CONSTRAINT "provider_observation_days_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "headlines" ADD COLUMN     "observationRuleVersion" TEXT NOT NULL DEFAULT 'none',
ADD COLUMN     "observedDayCount" INTEGER NOT NULL DEFAULT 0;
