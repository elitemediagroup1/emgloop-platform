-- CRM Phase Zero P0.2e: governed Customer -> Party links, with their history.
--
-- ADDITIVE ONLY. One new table, three indexes, four foreign keys, one CHECK
-- constraint. Zero DROP. Zero rename. Zero change to any existing table's columns.
-- Zero backfill: no Customer is linked by this migration, and none is linked by
-- guessing afterwards (Product decision: legacy Customer data is not identity
-- authority; no email, phone or name auto-linking).
--
-- ASCII ONLY. A leading em-dash in the sprint_11 migration blocked replay of the
-- entire ledger once (see PR #152); this file is deliberately plain ASCII.
--
-- ================== WHAT THIS ADDS ==================
--
-- A row is one assertion, by a person holding identityResolution:approve, that a
-- tenant's Customer record is an ESTABLISHED canonical Party. Reversal stamps the
-- same row; linking again writes a new one. History is never overwritten.
--
-- "At most one ACTIVE link per Customer" is `activeCustomerId` (= customerId while
-- active, NULL once reversed) under a plain unique index: Postgres treats NULLs as
-- distinct, so reversed rows never collide. Prisma 5.22 cannot express a partial
-- unique index; this shape needs none.

-- CreateTable
CREATE TABLE "customer_party_links" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "partyId" TEXT NOT NULL,
    "basis" "IdentityResolutionMethod" NOT NULL,
    "linkedByUserId" TEXT,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activeCustomerId" TEXT,
    "reversedAt" TIMESTAMP(3),
    "reversedByUserId" TEXT,
    "reversalReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_party_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customer_party_links_activeCustomerId_key" ON "customer_party_links"("activeCustomerId");

-- CreateIndex
CREATE INDEX "customer_party_links_organizationId_customerId_idx" ON "customer_party_links"("organizationId", "customerId");

-- CreateIndex
CREATE INDEX "customer_party_links_organizationId_partyId_idx" ON "customer_party_links"("organizationId", "partyId");

-- AddForeignKey
ALTER TABLE "customer_party_links" ADD CONSTRAINT "customer_party_links_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_party_links" ADD CONSTRAINT "customer_party_links_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_party_links" ADD CONSTRAINT "customer_party_links_linkedByUserId_fkey" FOREIGN KEY ("linkedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_party_links" ADD CONSTRAINT "customer_party_links_reversedByUserId_fkey" FOREIGN KEY ("reversedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The active marker and the reversal agree, a link is only ever to its own
-- Customer, and only a governed human basis can be recorded. Prisma does not model
-- CHECK constraints; this is enforced by the database alone.
ALTER TABLE "customer_party_links" ADD CONSTRAINT "customer_party_links_state_consistent"
  CHECK (
    ("reversedAt" IS NULL) = ("activeCustomerId" IS NOT NULL)
    AND ("activeCustomerId" IS NULL OR "activeCustomerId" = "customerId")
    AND ("reversedAt" IS NULL OR "reversedAt" >= "linkedAt")
    AND "basis" IN ('MANUAL', 'EXPLICIT_LINK')
  );
