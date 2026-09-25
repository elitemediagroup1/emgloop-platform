-- Chats Intelligence initialization ("hydration"): a DIGEST-ONLY, one-off, resumable pass that gives every
-- already-authorized person a CHATS digest for each recent conversation WITHOUT waiting for a new message.
--
-- WHY A SEPARATE LIFECYCLE. The historical content backfill (20260929000000) is one-shot per authorization
-- and replays obligation detection and reconciliation; authorizations that COMPLETED it before Chats
-- Intelligence existed never became due again, so their conversations had no digest. Re-arming that
-- backfill would re-sight and may supersede still-open WorkItems. This lifecycle writes ONLY digests.
--
-- ADDITIVE ONLY. Seven new columns, two CHECK constraints and one index on the EXISTING
-- source_content_authorizations table. No existing column, constraint, index or row is touched. Every
-- existing row takes the default NOT_STARTED, which is deliberate: every already-authorized person
-- becomes eligible with no re-authorization, reconnect or new message.
--
-- PROVABLY INDEPENDENT OF EVERY OTHER CURSOR. intelligenceHydrationCursor is an opaque dialog-pagination
-- frontier advanced ONLY by the hydration sweep. It is NOT the live observation cursor, NOT the baseline
-- checkpoint, NOT the forward contentCursor and NOT the historicalCursor.
--
-- CONTENT-FREE BY SHAPE. A state class, an opaque frontier, progress timestamps, a failure class, an
-- integer count and the triage output schema id a completed hydration covered. No message, name or raw id.
--
-- ASCII only: an em-dash in a migration once blocked replay of an entire ledger.

-- AlterTable
ALTER TABLE "source_content_authorizations"
    ADD COLUMN "intelligenceHydrationState" TEXT NOT NULL DEFAULT 'NOT_STARTED',
    ADD COLUMN "intelligenceHydrationCursor" TEXT,
    ADD COLUMN "intelligenceHydrationLastRunAt" TIMESTAMP(3),
    ADD COLUMN "intelligenceHydrationLastFailureClass" TEXT,
    ADD COLUMN "intelligenceHydrationBackoffUntil" TIMESTAMP(3),
    ADD COLUMN "intelligenceHydrationFailedItems" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "intelligenceHydrationSchemaId" TEXT;

-- Prisma cannot express CHECK constraints; the database alone enforces these.
ALTER TABLE "source_content_authorizations" ADD CONSTRAINT "source_content_authorizations_hydration_state_check"
    CHECK ("intelligenceHydrationState" IN ('NOT_STARTED', 'IN_PROGRESS', 'COMPLETE'));

ALTER TABLE "source_content_authorizations" ADD CONSTRAINT "source_content_authorizations_hydration_failed_items_check"
    CHECK ("intelligenceHydrationFailedItems" >= 0);

-- CreateIndex (discovery: state, then stalest run first)
CREATE INDEX "source_content_authorizations_hydration_due_idx" ON "source_content_authorizations"("intelligenceHydrationState", "intelligenceHydrationLastRunAt");
