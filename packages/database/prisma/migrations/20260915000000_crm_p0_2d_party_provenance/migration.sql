-- CRM Phase Zero P0.2d: the provenance that makes a Party canonical identity.
--
-- ADDITIVE ONLY. Six nullable columns, two foreign keys, one CHECK constraint.
-- Zero DROP. Zero rename. Zero column-type change. Zero backfill. No existing row
-- is read, written or re-meant: every column starts NULL on every row, and a NULL
-- establishment is exactly what every existing row already is -- not established.
--
-- ASCII ONLY. A leading em-dash in the sprint_11 migration blocked replay of the
-- entire ledger once (see PR #152); this file is deliberately plain ASCII.
--
-- ================== WHY, AND WHY NOT A NEW UNIQUENESS ==================
--
-- P0.2a defined an established Party as a PERSON or COMPANY record with a
-- governed basis: who established it, on what basis, when. Nothing persisted that,
-- so no row could ever be established. These columns persist it, written only by
-- PartyService.establish under identityResolution:approve.
--
-- The uniqueness change once planned here -- (organizationId, canonicalKey) without
-- entityType -- is deliberately NOT made (Product decision, Option D). Prisma 5.22
-- cannot express a partial unique index limited to Party types, and a table-wide
-- one would constrain the eighteen non-Party entity types the dormant cognitive
-- pipeline uses. Governed Party creation instead mints an opaque key
-- ('party:' + a random UUID) that is never derived from an email, phone or name,
-- so there is nothing for Party records to collide on.
--
-- Supersession columns ship now with nothing writing them, so the first governed
-- same-Party confirmation never has to add them under a live dataset.
--
-- Read Identity Footprint for servicesinmycity-demo read EMPTY=true before this
-- migration was written (run 34734190578).

-- AlterTable
ALTER TABLE "cognitive_identities" ADD COLUMN     "establishedAt" TIMESTAMP(3),
ADD COLUMN     "establishedByUserId" TEXT,
ADD COLUMN     "establishmentBasis" "IdentityResolutionMethod",
ADD COLUMN     "supersededAt" TIMESTAMP(3),
ADD COLUMN     "supersededByIdentityId" TEXT,
ADD COLUMN     "supersededByUserId" TEXT;

-- AddForeignKey
ALTER TABLE "cognitive_identities" ADD CONSTRAINT "cognitive_identities_establishedByUserId_fkey" FOREIGN KEY ("establishedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cognitive_identities" ADD CONSTRAINT "cognitive_identities_supersededByUserId_fkey" FOREIGN KEY ("supersededByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Establishment is all-or-nothing, and only a governed basis can be recorded.
-- `establishedByUserId` is deliberately not part of it: SET NULL on a deleted User
-- must not invalidate the historical fact that the Party was established.
-- Prisma does not model CHECK constraints; this is enforced by the database alone.
ALTER TABLE "cognitive_identities" ADD CONSTRAINT "cognitive_identities_establishment_complete"
  CHECK (
    ("establishedAt" IS NULL) = ("establishmentBasis" IS NULL)
    AND ("establishmentBasis" IS NULL OR "establishmentBasis" IN ('AUTHENTICATED', 'EXPLICIT_LINK', 'MANUAL', 'VERIFIED_EMAIL', 'VERIFIED_PHONE'))
    AND ("establishedAt" IS NULL OR "entityType" IN ('PERSON', 'COMPANY'))
  );
