-- Loop Intelligence Phase C (2026-09-26): Promote to Work -- the ONE bridge from intelligence to Work OS.
--
-- WHAT CHANGES
--   1. work_origins: where a piece of work was promoted from (a digest signal, a Daily Loop item, a Case),
--      keys only -- the kind, the scope, a keyed reference, the fingerprint of what the person confirmed,
--      the NAMES of the fields they chose to share. One promotion per origin (unique). Cascades with the
--      work instance and the organization.
--   2. OperationalObservationType gains WORK_LINKED: a Case records that a person promoted it to work.
--      It moves no lane and closes nothing (Work OS owns the work from there).
--   3. work_item_observations may record WORK_LINKED: a person's own Daily Loop item records that they
--      promoted it. The CHECK is replaced with the same list plus that one value; nothing else moves.
--
-- ADDITIVE. No row is rewritten, and every existing row satisfies the new CHECKs. Code deployed before
-- this migration refuses to promote (NOT_MIGRATED) rather than creating work it cannot link.
--
-- ASCII only.

-- AlterEnum
ALTER TYPE "OperationalObservationType" ADD VALUE 'WORK_LINKED';

-- CreateTable
CREATE TABLE "work_origins" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workInstanceId" TEXT NOT NULL,
    "originKind" TEXT NOT NULL,
    "originScope" TEXT NOT NULL,
    "originUserId" TEXT,
    "originRef" TEXT NOT NULL,
    "originFingerprint" TEXT NOT NULL,
    "promotedByUserId" TEXT NOT NULL,
    "promotedAt" TIMESTAMP(3) NOT NULL,
    "sharedFields" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_origins_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "work_origins_organizationId_workInstanceId_idx" ON "work_origins"("organizationId", "workInstanceId");

-- CreateIndex
CREATE UNIQUE INDEX "work_origins_organizationId_originKind_originRef_key" ON "work_origins"("organizationId", "originKind", "originRef");

-- AddForeignKey
ALTER TABLE "work_origins" ADD CONSTRAINT "work_origins_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_origins" ADD CONSTRAINT "work_origins_workInstanceId_fkey" FOREIGN KEY ("workInstanceId") REFERENCES "work_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "work_origins" ADD CONSTRAINT "work_origins_shape_check" CHECK (
  "originKind" IN ('DIGEST_SIGNAL', 'WORK_ITEM', 'CASE')
  AND "originScope" IN ('PRINCIPAL', 'ORGANIZATION')
  -- A private origin is the promoter's own, and only theirs.
  AND (("originScope" = 'PRINCIPAL') = ("originUserId" IS NOT NULL))
  AND ("originUserId" IS NULL OR "originUserId" = "promotedByUserId")
  -- A Daily Loop item is always private; a Case is always the organization's.
  AND ("originKind" <> 'WORK_ITEM' OR "originScope" = 'PRINCIPAL')
  AND ("originKind" <> 'CASE' OR "originScope" = 'ORGANIZATION')
  AND length("originRef") BETWEEN 1 AND 256
  AND length("originFingerprint") BETWEEN 1 AND 128
  AND cardinality(COALESCE("sharedFields", ARRAY[]::TEXT[])) <= 8
);

-- 3. A person's own item may record that they promoted it.
ALTER TABLE "work_item_observations" DROP CONSTRAINT "work_item_observations_shape_check";
ALTER TABLE "work_item_observations" ADD CONSTRAINT "work_item_observations_shape_check" CHECK (
  "observationType" IN ('DETECTED', 'REDETECTED', 'SNOOZED', 'UNSNOOZED', 'RESOLVED', 'DISMISSED', 'REOPENED', 'WORK_LINKED')
  AND "actorType" IN ('HUMAN', 'SYSTEM')
  -- A human act names the human; a system act never claims one.
  AND (("actorType" = 'HUMAN') = ("actorUserId" IS NOT NULL))
  AND "sequence" >= 1
  AND ("previousState" IS NULL OR "previousState" IN ('OPEN', 'SNOOZED', 'RESOLVED', 'DISMISSED'))
  AND ("newState" IS NULL OR "newState" IN ('OPEN', 'SNOOZED', 'RESOLVED', 'DISMISSED'))
);
