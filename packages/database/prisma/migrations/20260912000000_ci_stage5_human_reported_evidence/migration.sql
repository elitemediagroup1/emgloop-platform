-- Commercial Intelligence Stage 5: a person can put what they know on a Case,
-- and Loop records that they reported it -- not that it is true.
--
-- ADDITIVE, WITH ONE APPROVED RELAXATION. Three new columns, one index, one
-- foreign key, and metricKey loses its NOT NULL. Zero DROP COLUMN. Zero rename.
-- Zero data deletion. Zero backfill: no UPDATE statement runs, and no existing
-- row's meaning changes.
--
-- ASCII ONLY. A leading em-dash in the sprint_11 migration blocked replay of the
-- entire ledger once (see PR #152); this header is deliberately plain ASCII.
--
-- ================== WHY THE EXISTING EVIDENCE TABLE ==================
--
-- decision_evidence already means "one immutable piece of evidence behind a
-- Case", it is already append-only, it already keeps observedAt (when the
-- evidence describes the world) apart from createdAt (when Loop learned it), and
-- its own header already names a person as a legitimate source. A separate
-- human_evidence table would split "what is the evidence on this Case?" into two
-- answers, and every reader -- the brief, the 5Ws, the Finding gate -- would have
-- to ask both and merge them. This repository has paid for that pattern enough
-- times.
--
-- ================== WHAT THIS ADDS ==================
--
-- evidenceClass     HOW the evidence entered Loop: MEASURED or HUMAN_REPORTED.
--                   It ranks nothing. It carries no trust, authority,
--                   reliability or confidence -- those are properties of a claim
--                   plus its evidence, they differ by claim type, and the
--                   standards that decide them do not exist yet. What it decides
--                   is which columns mean anything on a row, and whether the
--                   Stage 3 measurement gate may read the row at all.
--
--                   A TEXT COLUMN, NOT AN ENUM, following severity and
--                   case_participants.contribution: the vocabulary is narrow
--                   today and will gain members (a deterministic diagnostic, a
--                   document, an outcome), and each should be a value rather
--                   than another migration.
--
--                   DEFAULT 'MEASURED' IS A STATEMENT OF FACT, NOT A GUESS.
--                   Until this migration there was exactly one way for a row to
--                   arrive -- a producer measuring something -- so every
--                   existing row IS measured. The default makes that true
--                   without an UPDATE touching a single row.
--
-- statement         What a person reported, in their own words, exactly as they
--                   wrote it. Never normalized, never rewritten, never replaced
--                   by a summary: on a human report that sentence IS the
--                   evidence. NULL on measured rows.
--
-- reportedByUserId  Who reported it. Written by the engine from the session
--                   actor and never from a caller's field, so no path exists for
--                   filing a report under somebody else's name. ON DELETE SET
--                   NULL rather than CASCADE, following
--                   case_participants.addedByUserId: attribution should survive
--                   somebody leaving the organization, and deleting the evidence
--                   because the reporter left would destroy the Case's record of
--                   what was known.
--
-- ================== WHY metricKey LOSES NOT NULL ==================
--
-- A human statement is not necessarily about a metric. "The API token expired"
-- names no measure, no window and no population.
--
-- The alternative was a sentinel -- HUMAN_REPORT, NON_METRIC, MANUAL, UNKNOWN --
-- and that is worse than a null in a way that compounds: it is a measured
-- referent that nothing measures. Every GROUP BY metricKey would carry a fake
-- member, the contradiction check would treat two unrelated sentences as
-- measurements of the same thing, and the fake would be indistinguishable from a
-- real metric the day somebody added one with that name.
--
-- DROPPING NOT NULL DELETES NOTHING and widens no existing row: every row that
-- has a metric keeps it. It is the one non-additive step here, it was approved
-- explicitly, and nothing in the codebase writes a measured row without a metric
-- -- the engine refuses it.
--
-- ================== DEPLOY ORDER ==================
--
-- THIS MIGRATION MUST BE APPLIED BEFORE THE CODE THAT WRITES THESE COLUMNS.
-- It sits behind the four Stage 4 migrations (case_participants, case event
-- vocabulary, work_os_execution_governance, monitoring vocabulary), which must
-- already be applied in production. Migrations reach production only through the
-- manual Deploy Prisma Migrations workflow; nothing here applies itself.

-- AlterTable
ALTER TABLE "decision_evidence" ADD COLUMN IF NOT EXISTS "evidenceClass" TEXT NOT NULL DEFAULT 'MEASURED';
ALTER TABLE "decision_evidence" ADD COLUMN IF NOT EXISTS "statement" TEXT;
ALTER TABLE "decision_evidence" ADD COLUMN IF NOT EXISTS "reportedByUserId" TEXT;

-- AlterColumn
ALTER TABLE "decision_evidence" ALTER COLUMN "metricKey" DROP NOT NULL;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "decision_evidence_organizationId_reportedByUserId_idx" ON "decision_evidence"("organizationId", "reportedByUserId");

-- AddForeignKey
ALTER TABLE "decision_evidence" DROP CONSTRAINT IF EXISTS "decision_evidence_reportedByUserId_fkey";
ALTER TABLE "decision_evidence" ADD CONSTRAINT "decision_evidence_reportedByUserId_fkey" FOREIGN KEY ("reportedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
