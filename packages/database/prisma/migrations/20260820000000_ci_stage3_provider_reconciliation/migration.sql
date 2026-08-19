-- Commercial Intelligence Stage 3 correctness: provider reconciliation.
--
-- ADDITIVE ONLY. Two new tables, three indexes, four foreign keys and seven
-- CHECK constraints. Zero DROP. Zero rename. Zero column-type change. No
-- existing table is altered, no existing row is read, rewritten or backfilled,
-- and NOTHING IS SEEDED -- a reconciliation fact is produced by comparing two
-- populations, and inventing one would fabricate the evidence these tables exist
-- to record.
--
-- ASCII ONLY. A leading em-dash in the sprint_11 migration blocked replay of the
-- entire ledger once (see PR #152); this header is deliberately plain ASCII.
--
-- WHAT THESE TABLES ANSWER, AND WHAT THEY DELIBERATELY DO NOT
--
--   provider_observation_days       did Loop LOOK at this business date?
--   provider_reconciliation_days    did what it saw ARRIVE?           <-- here
--   provider_member_expectations    was it SUPPOSED to arrive?
--
-- On 2026-08-05 the first table said yes: SUCCESS, 974 records read across 11
-- unbroken pages. Loop held 867. Both statements were true simultaneously,
-- because an observation row persists a COUNT and never the identity SET. That
-- is the entire reason this table is a SECOND fact rather than a column on the
-- first: redefining SUCCESS to mean "and the data is here" would destroy the one
-- completeness claim Loop currently gets right.
--
-- THE VERDICT IS AT THE DAY; THE DIFFERENCE IS IN CAMPAIGNS. 106 of those 107
-- absences belonged to three campaigns. A day-level verdict alone would let one
-- broken campaign block every objective in the organization, including the ones
-- that never measured it, so the member table carries the detail a later
-- readiness gate evaluates per binding.
--
-- NOTE ON WHAT IS NOT IN THIS FILE. `prisma migrate diff` also emits a rename of
-- the index `observation_day_identity`, created by the Stage 3 observation
-- migration under a `name:` that Prisma treats as client-facing only. That drift
-- is PRE-EXISTING, belongs to that change, and renaming a production index is not
-- this migration's authorized business. The two tables below set `map:`
-- explicitly so they can never contribute the same drift.

-- CreateTable
CREATE TABLE "provider_reconciliation_days" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "stream" TEXT NOT NULL,
    "businessDate" DATE NOT NULL,
    "timezone" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "scanStart" TIMESTAMP(3) NOT NULL,
    "scanEnd" TIMESTAMP(3) NOT NULL,
    "state" TEXT NOT NULL,
    "ruleVersion" TEXT NOT NULL,
    "localStage" TEXT NOT NULL,
    "providerRecords" INTEGER NOT NULL,
    "providerUnique" INTEGER NOT NULL,
    "providerDuplicateIds" INTEGER NOT NULL,
    "providerUnattributed" INTEGER NOT NULL DEFAULT 0,
    "localRowsScanned" INTEGER NOT NULL,
    "localInWindow" INTEGER NOT NULL,
    "localUnique" INTEGER NOT NULL,
    "localDuplicateIds" INTEGER NOT NULL,
    "localUnresolvedOccurrence" INTEGER NOT NULL DEFAULT 0,
    "localMissingIdentity" INTEGER NOT NULL DEFAULT 0,
    "intersection" INTEGER NOT NULL,
    "providerOnly" INTEGER NOT NULL,
    "localOnly" INTEGER NOT NULL,
    "providerOnlyExpected" INTEGER NOT NULL,
    "providerOnlyNotConfigured" INTEGER NOT NULL,
    "providerOnlyExcluded" INTEGER NOT NULL,
    "providerOnlyUnknownMember" INTEGER NOT NULL,
    "pagesFetched" INTEGER NOT NULL,
    "pageCap" INTEGER NOT NULL,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "reconciledAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_reconciliation_days_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_reconciliation_members" (
    "id" TEXT NOT NULL,
    "reconciliationDayId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "memberDimension" TEXT NOT NULL,
    "memberExternalId" TEXT NOT NULL,
    "providerCount" INTEGER NOT NULL,
    "providerOnly" INTEGER NOT NULL,
    "localCount" INTEGER NOT NULL,
    "localOnly" INTEGER NOT NULL,
    "expectationState" TEXT NOT NULL,
    "expectationId" TEXT,
    "expectationMatches" INTEGER NOT NULL DEFAULT 0,
    "labelAtObservation" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_reconciliation_members_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "reconciliation_day_identity" ON "provider_reconciliation_days"("organizationId", "provider", "stream", "businessDate");

-- CreateIndex
CREATE INDEX "reconciliation_member_lookup" ON "provider_reconciliation_members"("organizationId", "memberDimension", "memberExternalId");

-- CreateIndex
CREATE UNIQUE INDEX "reconciliation_member_identity" ON "provider_reconciliation_members"("reconciliationDayId", "memberDimension", "memberExternalId");

-- AddForeignKey
ALTER TABLE "provider_reconciliation_days" ADD CONSTRAINT "provider_reconciliation_days_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_reconciliation_members" ADD CONSTRAINT "provider_reconciliation_members_reconciliationDayId_fkey" FOREIGN KEY ("reconciliationDayId") REFERENCES "provider_reconciliation_days"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_reconciliation_members" ADD CONSTRAINT "provider_reconciliation_members_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_reconciliation_members" ADD CONSTRAINT "provider_reconciliation_members_expectationId_fkey" FOREIGN KEY ("expectationId") REFERENCES "provider_member_expectations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- HAND-WRITTEN SQL BELOW. Everything above this line was generated by
-- `prisma migrate diff`, minus the pre-existing index rename described in the
-- header. Prisma cannot express a CHECK constraint, and each one below enforces
-- an invariant this table would otherwise be trusting its one caller to keep.
-- ---------------------------------------------------------------------------

-- THE SET EQUATIONS, ENFORCED BY POSTGRES.
--
-- The service checks these before it writes and refuses to persist a comparison
-- that does not add up. These constraints exist because that refusal is
-- application-level, and application-level invariants are exactly what Sprint 29A
-- proved cannot be sustained by review: the next caller, the next backfill script
-- or a direct psql session all bypass it. A stored reconciliation fact that does
-- not add up is worse than no fact, because the whole point of this table is to
-- be the thing a measurement gate trusts.
--
-- These hold for EVERY state including INCONCLUSIVE. A truncated read still adds
-- up over what was read -- it is a lower bound, not an incoherent set -- and a
-- provider record carrying no member attribution is counted in
-- providerOnlyUnknownMember, because no declaration can be in force for a member
-- that was never named. What cannot be stored at all is a comparison whose own
-- arithmetic disagrees with itself.
ALTER TABLE "provider_reconciliation_days"
    ADD CONSTRAINT "provider_reconciliation_days_provider_equation"
    CHECK ("intersection" + "providerOnly" = "providerUnique");

ALTER TABLE "provider_reconciliation_days"
    ADD CONSTRAINT "provider_reconciliation_days_local_equation"
    CHECK ("intersection" + "localOnly" = "localUnique");

ALTER TABLE "provider_reconciliation_days"
    ADD CONSTRAINT "provider_reconciliation_days_split_equation"
    CHECK (
        "providerOnlyExpected" + "providerOnlyNotConfigured" +
        "providerOnlyExcluded" + "providerOnlyUnknownMember" = "providerOnly"
    );

-- A negative count is not a small comparison, it is a broken one. Postgres will
-- accept -1 in an INTEGER column all day; the equations above would even balance
-- with matched signs.
ALTER TABLE "provider_reconciliation_days"
    ADD CONSTRAINT "provider_reconciliation_days_counts_nonnegative"
    CHECK (
        "providerRecords" >= 0 AND "providerUnique" >= 0 AND
        "providerDuplicateIds" >= 0 AND "providerUnattributed" >= 0 AND
        "localRowsScanned" >= 0 AND "localInWindow" >= 0 AND
        "localUnique" >= 0 AND "localDuplicateIds" >= 0 AND
        "localUnresolvedOccurrence" >= 0 AND "localMissingIdentity" >= 0 AND
        "intersection" >= 0 AND "providerOnly" >= 0 AND "localOnly" >= 0 AND
        "providerOnlyExpected" >= 0 AND "providerOnlyNotConfigured" >= 0 AND
        "providerOnlyExcluded" >= 0 AND "providerOnlyUnknownMember" >= 0 AND
        "pagesFetched" >= 0 AND "pageCap" >= 0
    );

-- Records the provider returned can never be fewer than the identities in them,
-- and unattributed records can never exceed the population they came from.
ALTER TABLE "provider_reconciliation_days"
    ADD CONSTRAINT "provider_reconciliation_days_population_bounds"
    CHECK (
        "providerRecords" >= "providerUnique" AND
        "providerUnattributed" <= "providerUnique" AND
        "localRowsScanned" >= "localInWindow"
    );

-- A member cannot be missing more identities than the provider held for it, and
-- cannot hold more unmatched local identities than it holds local identities.
ALTER TABLE "provider_reconciliation_members"
    ADD CONSTRAINT "provider_reconciliation_members_member_bounds"
    CHECK (
        "providerCount" >= 0 AND "localCount" >= 0 AND
        "providerOnly" >= 0 AND "localOnly" >= 0 AND
        "expectationMatches" >= 0 AND
        "providerOnly" <= "providerCount" AND
        "localOnly" <= "localCount"
    );

-- PROVENANCE, IN BOTH DIRECTIONS.
--
-- The whole reason this table stores one current answer per day rather than an
-- append-only history is that a member row NAMES the declaration it resolved to,
-- and PR 2 never rewrites a declaration. That argument only holds if the naming
-- is total: a row saying NOT_CONFIGURED with no declaration behind it records a
-- classification nobody can later justify, which is precisely the situation the
-- expectation table was built to end.
--
-- So the rule is a BICONDITIONAL, not an implication. Every declarable state
-- must name its source, and UNKNOWN must name none -- UNKNOWN is what "nobody
-- had said" and what "two people said different things" both resolve to, and
-- attaching a declaration id to it would contradict the state it is recording.
-- An implication would have permitted UNKNOWN + an id, leaving a row that points
-- at a declaration it did not use.
ALTER TABLE "provider_reconciliation_members"
    ADD CONSTRAINT "provider_reconciliation_members_expectation_source"
    CHECK (
        ("expectationState" = 'UNKNOWN' AND "expectationId" IS NULL)
        OR ("expectationState" <> 'UNKNOWN' AND "expectationId" IS NOT NULL)
    );

-- WHAT THIS CONSTRAINT DOES NOT PROVE, STATED HERE SO NOBODY READS MORE INTO IT.
--
-- The foreign key above proves the declaration EXISTS. Neither it nor this CHECK
-- proves it belongs to the SAME member: a row for campaign A could name a
-- declaration made about campaign B, or about another organization entirely, and
-- Postgres would accept it. That invariant is enforced in
-- ProviderReconciliationRepository.recordDay, which resolves every named
-- declaration WITHIN the organization and refuses the write when its provider,
-- stream, dimension or member id disagrees with the row naming it.
--
-- Enforcing it in the database would need `provider` and `stream` columns added
-- to this table, a redundant six-column unique on provider_member_expectations
-- to serve as the target, and a composite foreign key with
-- `ON DELETE SET NULL ("expectationId")` -- syntax Prisma cannot express, which
-- would leave `migrate diff` reporting permanent drift against this schema. That
-- is a deliberate open item, not an oversight.
