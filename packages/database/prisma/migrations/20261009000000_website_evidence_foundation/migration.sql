-- Website evidence foundation (2026-09-30). ADDITIVE ONLY: no existing row is read, rewritten or deleted.
--
-- NAMING: this migration is ordered AFTER 20261008000000_case_private_scopes, which production has already
-- applied (the repository's migration names are ordinal keys, not calendar dates). A name that sorted earlier
-- would be applied out of order.
--
--   web_properties          the AUTHORITATIVE EMG website-property registry: every owned property, live or not,
--                           each belonging to one organization. Lifecycle (OWNED / BUILDING / LIVE / PAUSED /
--                           RETIRED) and ingestion (ENABLED / DISABLED) are separate columns; website ingestion
--                           admits events only for LIVE + ENABLED. EMPTY after this migration: properties are
--                           registered by an operator (register-web-property), never guessed here.
--   provider_connections    organization-owned credential columns (sealed secret, seal version, key ref, attempt /
--                           success / failure / backoff, connected-by, revoked). All NULL; nothing is connected.
--   source_metric_windows   the minimized aggregate evidence store for external website sources. EMPTY.

-- AlterTable
ALTER TABLE "provider_connections" ADD COLUMN     "backoffUntil" TIMESTAMP(3),
ADD COLUMN     "connectedByUserId" TEXT,
ADD COLUMN     "credentialKind" TEXT,
ADD COLUMN     "keyRef" TEXT,
ADD COLUMN     "lastAttemptAt" TIMESTAMP(3),
ADD COLUMN     "lastFailureClass" TEXT,
ADD COLUMN     "lastSucceededAt" TIMESTAMP(3),
ADD COLUMN     "revokedAt" TIMESTAMP(3),
ADD COLUMN     "sealVersion" TEXT,
ADD COLUMN     "secretSealed" BYTEA;

-- CreateTable
CREATE TABLE "web_properties" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT,
    "primaryDomain" TEXT NOT NULL,
    "lifecycle" TEXT NOT NULL DEFAULT 'OWNED',
    "ingestion" TEXT NOT NULL DEFAULT 'DISABLED',
    "lifecycleChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "allowedDomains" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ga4PropertyId" TEXT,
    "searchConsoleSiteUrl" TEXT,
    "bingSiteUrl" TEXT,
    "clarityProjectId" TEXT,
    "registeredByUserId" TEXT,
    "registeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "web_properties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_metric_windows" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "webPropertyId" TEXT,
    "subjectRef" TEXT NOT NULL,
    "dimension" TEXT NOT NULL,
    "dimensionValue" TEXT NOT NULL DEFAULT '',
    "granularity" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "finality" TEXT NOT NULL,
    "metrics" JSONB NOT NULL DEFAULT '{}',
    "quality" JSONB NOT NULL DEFAULT '{}',
    "contentHash" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "source_metric_windows_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "web_properties_key_key" ON "web_properties"("key");

-- CreateIndex
CREATE UNIQUE INDEX "web_properties_primaryDomain_key" ON "web_properties"("primaryDomain");

-- CreateIndex
CREATE UNIQUE INDEX "web_properties_ga4PropertyId_key" ON "web_properties"("ga4PropertyId");

-- CreateIndex
CREATE UNIQUE INDEX "web_properties_searchConsoleSiteUrl_key" ON "web_properties"("searchConsoleSiteUrl");

-- CreateIndex
CREATE UNIQUE INDEX "web_properties_bingSiteUrl_key" ON "web_properties"("bingSiteUrl");

-- CreateIndex
CREATE UNIQUE INDEX "web_properties_clarityProjectId_key" ON "web_properties"("clarityProjectId");

-- CreateIndex
CREATE INDEX "web_properties_organizationId_lifecycle_idx" ON "web_properties"("organizationId", "lifecycle");

-- CreateIndex
CREATE UNIQUE INDEX "web_properties_id_organizationId_key" ON "web_properties"("id", "organizationId");

-- CreateIndex
CREATE INDEX "source_metric_windows_organizationId_sourceId_windowEnd_idx" ON "source_metric_windows"("organizationId", "sourceId", "windowEnd");

-- CreateIndex
CREATE INDEX "source_metric_windows_windowEnd_idx" ON "source_metric_windows"("windowEnd");

-- CreateIndex
CREATE UNIQUE INDEX "source_metric_windows_organizationId_sourceId_subjectRef_di_key" ON "source_metric_windows"("organizationId", "sourceId", "subjectRef", "dimension", "dimensionValue", "granularity", "windowStart", "windowEnd");

-- AddForeignKey
ALTER TABLE "web_properties" ADD CONSTRAINT "web_properties_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_metric_windows" ADD CONSTRAINT "source_metric_windows_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_metric_windows" ADD CONSTRAINT "source_metric_windows_webPropertyId_organizationId_fkey" FOREIGN KEY ("webPropertyId", "organizationId") REFERENCES "web_properties"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Bounded vocabularies and shapes, enforced by the database as well as the repositories.
ALTER TABLE "web_properties" ADD CONSTRAINT "web_properties_shape_check" CHECK (
  "key" ~ '^[a-z0-9][a-z0-9-]{0,62}$'
  AND "primaryDomain" ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
  AND "lifecycle" IN ('OWNED', 'BUILDING', 'LIVE', 'PAUSED', 'RETIRED')
  AND "ingestion" IN ('ENABLED', 'DISABLED')
  AND cardinality("allowedDomains") <= 32
);
-- Ingestion may be ENABLED only while the property is LIVE.
ALTER TABLE "web_properties" ADD CONSTRAINT "web_properties_ingestion_requires_live_check" CHECK (
  "ingestion" = 'DISABLED' OR "lifecycle" = 'LIVE'
);
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_credential_check" CHECK (
  ("secretSealed" IS NULL OR ("credentialKind" IS NOT NULL AND "sealVersion" IS NOT NULL AND "keyRef" IS NOT NULL))
  AND ("credentialKind" IS NULL OR "credentialKind" ~ '^[A-Z][A-Z0-9_]{1,47}$')
);
ALTER TABLE "source_metric_windows" ADD CONSTRAINT "source_metric_windows_shape_check" CHECK (
  "sourceId" ~ '^[A-Z][A-Z0-9_]{0,63}$'
  AND "dimension" ~ '^[A-Z][A-Z0-9_]{0,31}$'
  AND length("dimensionValue") <= 256
  AND length("subjectRef") BETWEEN 1 AND 256
  AND "granularity" IN ('DAY', 'WINDOW')
  AND "finality" IN ('FINAL', 'PRELIMINARY')
  AND "windowEnd" > "windowStart"
  AND jsonb_typeof("metrics") = 'object'
  AND jsonb_typeof("quality") = 'object'
);
