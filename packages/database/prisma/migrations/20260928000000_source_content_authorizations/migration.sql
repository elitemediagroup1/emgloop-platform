-- Employee content-processing consent for a background source (Telegram, content-triage slice).
--
-- ADDITIVE ONLY. One new table. No existing table, column, index or constraint is touched, and
-- nothing is backfilled. This is a deliberate SIBLING of source_baseline_checkpoints: a separate
-- table so the content sweep can never move the live observation cursor (source_connections.cursor)
-- or the baseline checkpoint. It records the employee's EXPLICIT, revocable consent to process
-- message CONTENT with AI, which is distinct from connecting the source and from the content-free
-- history baseline.
--
-- CONTENT-FREE BY SHAPE. contentCursor is an opaque content-free message id; there is no column that
-- can hold a message, a name or a raw id. The provider vocabulary (CONNECTION_PROVIDERS) is enforced
-- in the shared contract and the repository, matching the other source_* tables (no DB CHECK there).
--
-- USER-FIRST. organizationId AND userId are on the row, and the composite foreign key is to
-- organization_memberships, so a row cannot be filed under an organization the person does not belong
-- to and offboarding cascades it away.
--
-- ASCII only: an em-dash in a migration once blocked replay of an entire ledger.

-- CreateTable
CREATE TABLE "source_content_authorizations" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "authorizedAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "contentCursor" TEXT,
    "lastRunAt" TIMESTAMP(3),
    "lastFailureClass" TEXT,
    "backoffUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "source_content_authorizations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "source_content_authorizations_revokedAt_lastRunAt_idx" ON "source_content_authorizations"("revokedAt", "lastRunAt");

-- CreateIndex
CREATE UNIQUE INDEX "source_content_authorizations_organizationId_userId_provide_key" ON "source_content_authorizations"("organizationId", "userId", "provider");

-- AddForeignKey
ALTER TABLE "source_content_authorizations" ADD CONSTRAINT "source_content_authorizations_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_content_authorizations" ADD CONSTRAINT "source_content_authorizations_userId_organizationId_fkey" FOREIGN KEY ("userId", "organizationId") REFERENCES "organization_memberships"("userId", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;
