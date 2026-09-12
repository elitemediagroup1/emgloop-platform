-- Commercial Intelligence Stage 5: what LATER evidence says about EARLIER
-- evidence, without editing a single word of it.
--
-- ADDITIVE ONLY. One enum value, two nullable columns, one index, one foreign
-- key. Zero DROP. Zero rename. Zero column-type change. Zero backfill. No
-- existing row is read, written or re-meant by any statement below.
--
-- ASCII ONLY. A leading em-dash in the sprint_11 migration blocked replay of the
-- entire ledger once (see PR #152); this header is deliberately plain ASCII.
--
-- ================== WHAT THIS ADDS, AND WHY HERE ==================
--
-- Evidence is immutable. When somebody discovers that a report was about staging
-- rather than production, or that a second source agrees with a measurement, or
-- that a fact stopped being true last Tuesday, NOTHING about the original row
-- changes. A separate, attributed, timed fact is appended saying how the two
-- relate.
--
-- That fact is an event in the life of an investigation -- who said it, when,
-- against what -- which is precisely what operational_observations already is:
-- append-only, attributed, tenant-scoped, sequenced per Case, and already
-- publishing one domain event per row into the transactional outbox. So the
-- relation is recorded there, and the alternative was rejected deliberately:
--
--   A SEPARATE decision_evidence_context TABLE would need its own tenancy, its
--   own append-only discipline, its own event publication and its own ordering,
--   and would create a SECOND place where "what happened on this Case" lives.
--   Every reader would then have to ask both and merge them in the right order.
--   This repository has paid for that pattern enough times.
--
-- evidenceId         already existed. On EVIDENCE_CONTEXT_RECORDED it is the
--                    evidence BEING GIVEN CONTEXT.
--
-- relatedEvidenceId  the evidence DOING it. NULL on every other observation
--                    type, and NULL on NO_LONGER_APPLICABLE, which names a
--                    change in the world rather than a second record -- and is
--                    required to say why in the actor's own words instead.
--
-- evidenceRelation   which governed relation: CORROBORATED_BY, CONTRADICTED_BY,
--                    CLARIFIED_BY, CORRECTED_BY, NO_LONGER_APPLICABLE. A TEXT
--                    column, not an enum, following severity and evidenceClass:
--                    the set is small today, the reasoning for each member lives
--                    in the shared contract, and an ungoverned value is skipped
--                    by the projection rather than rendered.
--
-- ================== WHAT IS DELIBERATELY ABSENT ==================
--
-- SUPERSEDED_BY is not a member. Two authorities already own what it would mean:
-- a producer restating its own number is a REVISION (provider_fact_revisions,
-- Stage 3), and a newer claim replacing an older one is Finding supersession
-- (intelligence_hypotheses.supersededById, Stage 4). What is left -- a person
-- replacing their own earlier report -- is CORRECTED_BY, which says the same
-- thing and says why.
--
-- No verification status, no confidence, no score, and no reporter reliability.
-- What a relation establishes is what somebody recorded; whether the underlying
-- claim is true remains the Finding's business, decided by the governed standard
-- for claims of its kind.
--
-- ================== DEPLOY ORDER ==================
--
-- THIS MIGRATION MUST BE APPLIED BEFORE THE CODE THAT WRITES THESE VALUES.
-- A build emitting EVIDENCE_CONTEXT_RECORDED against a live enum that lacks it
-- fails at the database.
--
-- It sits behind 20260912000000_ci_stage5_human_reported_evidence, which at the
-- time of writing is present in this repository and NOT yet applied in
-- production: the most recent Deploy Prisma Migrations run (2026-09-09) applied
-- the four Stage 4 migrations and nothing since. Both must be applied, in
-- repository order, through the manual workflow. Nothing here applies itself.

-- AlterEnum
ALTER TYPE "OperationalObservationType" ADD VALUE IF NOT EXISTS 'EVIDENCE_CONTEXT_RECORDED';

-- AlterTable
ALTER TABLE "operational_observations" ADD COLUMN IF NOT EXISTS "relatedEvidenceId" TEXT;
ALTER TABLE "operational_observations" ADD COLUMN IF NOT EXISTS "evidenceRelation" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "operational_observations_relatedEvidenceId_idx" ON "operational_observations"("relatedEvidenceId");

-- AddForeignKey
ALTER TABLE "operational_observations" DROP CONSTRAINT IF EXISTS "operational_observations_relatedEvidenceId_fkey";
ALTER TABLE "operational_observations" ADD CONSTRAINT "operational_observations_relatedEvidenceId_fkey" FOREIGN KEY ("relatedEvidenceId") REFERENCES "decision_evidence"("id") ON DELETE SET NULL ON UPDATE CASCADE;
