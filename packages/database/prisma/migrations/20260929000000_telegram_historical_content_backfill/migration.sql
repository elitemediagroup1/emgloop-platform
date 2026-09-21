-- Telegram v2 conversation triage: HISTORICAL content backfill checkpoint (content-triage slice).
--
-- ADDITIVE ONLY. Eight new columns and one index on the EXISTING source_content_authorizations table.
-- No existing column, constraint, index or row is touched, and nothing is backfilled. The eight columns
-- track a one-off, resumable, TRANSIENT read of the already-imported recent window (the baseline floor),
-- surfacing obligations still unresolved without waiting for a new message.
--
-- PROVABLY INDEPENDENT OF EVERY OTHER CURSOR. These columns are advanced ONLY by the historical content
-- sweep. They are NOT the live observation cursor (source_connections.cursor), NOT the baseline checkpoint
-- (source_baseline_checkpoints.checkpointCursor), and NOT the forward contentCursor on this same table.
-- historicalCursor is an opaque dialog-pagination frontier.
--
-- CONTENT-FREE BY SHAPE. Not one of these columns can hold a message, a name or a raw id. The historical
-- state is a class; the cursor is an opaque frontier; the timestamps are progress markers; the failed-item
-- count is an integer. Bodies are read transiently in the worker and dropped; nothing content-bearing lands here.
--
-- ASCII only: an em-dash in a migration once blocked replay of an entire ledger.

-- AlterTable
ALTER TABLE "source_content_authorizations"
    ADD COLUMN "historicalState" TEXT NOT NULL DEFAULT 'NOT_STARTED',
    ADD COLUMN "historicalCursor" TEXT,
    ADD COLUMN "historicalWindowFloorAt" TIMESTAMP(3),
    ADD COLUMN "historicalOldestReachedAt" TIMESTAMP(3),
    ADD COLUMN "historicalLastRunAt" TIMESTAMP(3),
    ADD COLUMN "historicalLastFailureClass" TEXT,
    ADD COLUMN "historicalBackoffUntil" TIMESTAMP(3),
    ADD COLUMN "historicalFailedItems" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "source_content_authorizations_historicalState_historicalLa_idx" ON "source_content_authorizations"("historicalState", "historicalLastRunAt");
