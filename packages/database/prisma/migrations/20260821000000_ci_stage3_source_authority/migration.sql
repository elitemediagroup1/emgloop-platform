-- Commercial Intelligence Stage 3 correctness: measurement source authority.
--
-- ADDITIVE ONLY. Three new tables, four indexes, six foreign keys and seven
-- constraints. Zero DROP. Zero rename. Zero column-type change. No existing
-- table is altered, no existing row is read, rewritten or backfilled, and
-- NOTHING IS SEEDED -- which source an organization believes for a measure is a
-- commercial decision, and inventing one here would manufacture the very thing
-- these tables exist to record honestly.
--
-- ASCII ONLY. A leading em-dash in the sprint_11 migration blocked replay of the
-- entire ledger once (see PR #152); this header is deliberately plain ASCII.
--
-- THE FACT THIS ADDS
--
--   provider_observation_days       did Loop LOOK at this business date?
--   provider_reconciliation_days    did what it saw ARRIVE?
--   provider_member_expectations    was it SUPPOSED to arrive?
--   measure_source_authorities      WHOSE NUMBER is this measure?     <-- here
--
-- A SOURCE CONTAINING A FIELD DOES NOT MAKE IT AUTHORITATIVE FOR THAT FIELD.
-- On 2026-08-05 every one of the 974 records the provider held carried
-- `converted=false` -- present, not absent -- so a conversion rate computed from
-- them would have returned 0% at full coverage, cleared every guard Stage 3 had,
-- and stated a business falsehood as a measured fact. Authority is therefore a
-- statement a person makes, stored, resolved as of the date being measured, and
-- failing closed when it is absent.
--
-- NOTHING HERE INFERS. There is no column, default or constraint that would let
-- a non-null value, a webhook, a successful reconciliation, an import or a
-- larger number make a source authoritative.
--
-- THE GRAIN IS (member, metric, date), which is the pure contract's grain rather
-- than a choice made here. It buys the case this exists for at no extra cost:
-- the provider for call volume and a counterparty for revenue, on the SAME
-- campaign on the same day, without either being a contradiction. Provider and
-- stream are deliberately NOT in the authority key -- the member is the subject
-- and the source is the answer.
--
-- NOTE ON WHAT IS NOT IN THIS FILE. `prisma migrate diff` also emits a rename of
-- the index `observation_day_identity`, created by the Stage 3 observation
-- migration under a `name:` Prisma treats as client-facing only. That drift is
-- PRE-EXISTING, belongs to that change, and renaming a production index is not
-- this migration's authorized business. The three tables below set `map:`
-- explicitly so they can never contribute the same drift.

-- CreateTable
CREATE TABLE "measurement_sources" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "provider" TEXT,
    "stream" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "measurement_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "measurement_source_metrics" (
    "id" TEXT NOT NULL,
    "measurementSourceId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "measureDefinitionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "measurement_source_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "measure_source_authorities" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "memberDimension" TEXT NOT NULL,
    "memberExternalId" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "measurementSourceId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "declaredByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "measure_source_authorities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "measurement_source_identity" ON "measurement_sources"("organizationId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "measurement_source_tenant_ref" ON "measurement_sources"("id", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "measurement_source_metric_identity" ON "measurement_source_metrics"("measurementSourceId", "metric");

-- CreateIndex
CREATE INDEX "measure_source_authority_lookup" ON "measure_source_authorities"("organizationId", "memberDimension", "memberExternalId", "metric", "effectiveFrom");

-- AddForeignKey
ALTER TABLE "measurement_sources" ADD CONSTRAINT "measurement_sources_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "measurement_source_metrics" ADD CONSTRAINT "measurement_source_metrics_measurementSourceId_organizatio_fkey" FOREIGN KEY ("measurementSourceId", "organizationId") REFERENCES "measurement_sources"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "measurement_source_metrics" ADD CONSTRAINT "measurement_source_metrics_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "measure_source_authorities" ADD CONSTRAINT "measure_source_authorities_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "measure_source_authorities" ADD CONSTRAINT "measure_source_authorities_measurementSourceId_organizatio_fkey" FOREIGN KEY ("measurementSourceId", "organizationId") REFERENCES "measurement_sources"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "measure_source_authorities" ADD CONSTRAINT "measure_source_authorities_declaredByUserId_fkey" FOREIGN KEY ("declaredByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- HAND-WRITTEN SQL BELOW. Everything above this line was generated by
-- `prisma migrate diff`, minus the pre-existing index rename described in the
-- header. Prisma can express neither a CHECK nor an exclusion constraint, and
-- each one below enforces an invariant these tables would otherwise be trusting
-- one caller to keep.
-- ---------------------------------------------------------------------------

-- A SOURCE IS TIED TO A STREAM, OR IT IS NOT, AND THERE IS NO THIRD OPTION.
--
-- The pure contract says provider and stream are set for PROVIDER_STREAM and
-- null otherwise, and the reason is mechanical rather than tidy: the kind is what
-- SELECTS how availability is proven. A polled stream proves it by having been
-- observed and reconciled, which requires naming the stream. A report that
-- arrives proves it by having arrived, and has no stream to observe. A
-- PROVIDER_STREAM with no stream is a source whose availability can never be
-- established; a BUYER_REPORT carrying one invites a reader to go looking for
-- observation evidence that will never exist.
ALTER TABLE "measurement_sources"
    ADD CONSTRAINT "measurement_sources_stream_pairing"
    CHECK (
        ("kind" =  'PROVIDER_STREAM' AND "provider" IS NOT NULL AND "stream" IS NOT NULL)
        OR
        ("kind" <> 'PROVIDER_STREAM' AND "provider" IS     NULL AND "stream" IS     NULL)
    );

-- An identifier made of whitespace is not an identifier. The empty string would
-- otherwise be a perfectly valid source key that every lookup for a missing
-- source could accidentally match.
ALTER TABLE "measurement_sources"
    ADD CONSTRAINT "measurement_sources_identifiers_present"
    CHECK (length(btrim("key")) > 0 AND length(btrim("displayName")) > 0);

-- A SUPPORTED METRIC WITHOUT A DEFINITION IS NOT USABLE, and the pure
-- `sourceSupports()` already refuses one. Persisted as a row per metric, the gap
-- cannot exist -- but only if the definition is genuinely present, so the empty
-- string is refused here rather than being discovered at aggregation time, when
-- two sources would appear to agree because both declared "".
ALTER TABLE "measurement_source_metrics"
    ADD CONSTRAINT "measurement_source_metrics_definition_present"
    CHECK (length(btrim("measureDefinitionId")) > 0);

-- An unexplained authority is a place to hide a revenue decision.
ALTER TABLE "measure_source_authorities"
    ADD CONSTRAINT "measure_source_authorities_reason_present"
    CHECK (length(btrim("reason")) > 0 AND length(btrim("memberExternalId")) > 0);

-- A declaration that ends before it starts is a defect, and one that ends ON its
-- start date says nothing about any date at all. Postgres would accept both as
-- ordinary rows, and the exclusion constraint below would not catch the second:
-- an EMPTY range overlaps nothing and would slip past as a phantom declaration.
ALTER TABLE "measure_source_authorities"
    ADD CONSTRAINT "measure_source_authorities_effective_range_check"
    CHECK ("effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom");

-- AT MOST ONE AUTHORITY PER MEMBER PER MEASURE PER DATE, enforced by the
-- database.
--
-- Two rows covering one business date mean the organization has said two things
-- about whose number this is, and the pure resolver deliberately refuses to
-- tie-break: any precedence -- most recent, most specific, provider over local --
-- would be invented here and would settle a disagreement the organization has
-- not actually settled. It resolves CONFLICT and a person closes one.
--
-- The repository refuses an overlap first; this is the backstop for two
-- concurrent declarations that each pass their own pre-check, which is exactly
-- the guarantee Sprint 29A proved review cannot sustain.
--
-- btree_gist supplies the "=" operator class GiST needs for the scalar key
-- columns. IT IS ALREADY INSTALLED IN PRODUCTION -- migration
-- 20260819000000 created it and `Deploy Prisma Migrations` applied that on
-- 2026-08-19 (btree_gist 1.8, schema public) -- so this migration does NOT
-- create an extension and requires no privilege the deploy role has not already
-- exercised.
--
-- The range is half-open '[)' so back-to-back declarations do NOT collide:
-- [Aug 1, Sep 1) and [Sep 1, NULL) touch at Sep 1 and overlap on no date, which
-- is exactly what closing one authority and opening the next produces.
ALTER TABLE "measure_source_authorities"
    ADD CONSTRAINT "measure_source_authorities_no_overlap"
    EXCLUDE USING gist (
        "organizationId" WITH =,
        "memberDimension" WITH =,
        "memberExternalId" WITH =,
        "metric" WITH =,
        daterange("effectiveFrom", "effectiveTo", '[)') WITH &&
    );
