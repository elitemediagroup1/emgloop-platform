-- One outbox for the platform, not one per subsystem.
--
-- Loop has exactly one publishing mechanism. Active state was its first subject;
-- decisions are the second. This generalizes the SUBJECT without touching the
-- publisher, the deliveries, the subscriptions or any existing row semantics.
--
-- Safety:
--   * three ADD COLUMN, each with a DEFAULT, so existing rows stay valid;
--   * one DROP NOT NULL, which is a relaxation and can never fail on data;
--   * one backfill UPDATE that only fills the new descriptive columns;
--   * zero DROP, zero rename, zero type change, no table touched but this one.
--
-- identityId becomes nullable because most decisions describe the business
-- rather than a person ("revenue concentration increased"). Fabricating an
-- identity to satisfy the column would pollute the identity graph.
--
-- ASCII only. See docs/architecture/migration-remediation-plan.md.

-- CreateEnum
CREATE TYPE "OutboxSubjectType" AS ENUM ('ACTIVE_STATE', 'DECISION', 'WORK_ITEM', 'MEMORY', 'KNOWLEDGE', 'IDENTITY');

-- AlterTable
ALTER TABLE "state_change_outbox" ADD COLUMN     "eventType" TEXT NOT NULL DEFAULT 'ActiveStateChanged',
ADD COLUMN     "subjectId" TEXT,
ADD COLUMN     "subjectType" "OutboxSubjectType" NOT NULL DEFAULT 'ACTIVE_STATE',
ALTER COLUMN "identityId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "state_change_outbox_organizationId_subjectType_subjectId_idx" ON "state_change_outbox"("organizationId", "subjectType", "subjectId");


-- Backfill: every existing row is an active-state change, and its subject is the
-- active-state record it was written for. The column defaults already make new
-- rows correct; this makes the history correct too, so a subscriber reading
-- subjectId never sees NULL for a row that has one.
UPDATE "state_change_outbox"
   SET "subjectId" = "activeStateRecordId"
 WHERE "subjectId" IS NULL
   AND "activeStateRecordId" IS NOT NULL;
