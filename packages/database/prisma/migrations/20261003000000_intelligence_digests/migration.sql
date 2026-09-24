-- Loop Intelligence PR A (approved 2026-09-24): intelligence_digests, one person's minimized
-- DOMAIN INTELLIGENCE, one current row per subject.
--
-- ADDITIVE ONLY. One new table, its indexes, its foreign keys and its CHECK constraints. No
-- existing table, column, index or constraint is touched, and nothing is backfilled. After this
-- migration the table is empty and NOTHING WRITES IT: PR A ships no producer. Safe to apply to a
-- live database.
--
-- LAYERING. AUTHORITATIVE EVIDENCE -> DOMAIN INTELLIGENCE (this table) -> domain UI / Briefing ->
-- Headlines -> Investigation -> Work. Intelligence is NOT Work: nothing here is a work item.
--
-- A REBUILDABLE PROJECTION. One current row per (organization, user, domain, subjectKind,
-- subjectRef), overwritten on regeneration ("version" counts regenerations that changed the
-- fingerprint). Append-only governs truth (ENGINEERING_PRINCIPLES Rule 1); this is a projection of
-- evidence that stays where it is, and "provenance" names that evidence (Rule 3).
--
-- PRINCIPAL-PRIVATE. "scope" admits PRINCIPAL and ORGANIZATION, but ORGANIZATION is RESERVED:
-- intelligence_digests_organization_scope_reserved refuses it outright, and the repository refuses
-- it before the database is asked. Enabling it is a separate, approved migration that drops that
-- one constraint. A PRINCIPAL row names its user, and the composite foreign key to
-- organization_memberships means it cannot be filed under an organization the person does not
-- belong to (and cascades with the membership row, like every work table).
--
-- MINIMIZED BY SHAPE. "content" is a JSON object bounded in size, and no top-level key may name
-- the evidence itself (body, text, quote, message); the repository validates the full shape
-- (@emgloop/shared digestContentRefusals) before writing. "subjectRef" is a keyed reference, never a
-- raw provider id. "provider" (TELEGRAM, GMAIL, ...) is how a consent revoke finds the rows to
-- delete.
--
-- RETENTION. "expiresAt" is stamped at write (30 days from the newest evidence for a subject
-- digest, 30 days from generation for a DOMAIN rollup; policy dated 2026-09-24) and the worker's
-- sweep deletes past it.
--
-- ASCII only: an em-dash in a migration once blocked replay of an entire ledger.

-- CreateTable
CREATE TABLE "intelligence_digests" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "userId" TEXT,
    "domain" TEXT NOT NULL,
    "subjectKind" TEXT NOT NULL,
    "subjectRef" TEXT NOT NULL,
    "provider" TEXT,
    "content" JSONB NOT NULL,
    "coverage" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "evidenceCount" INTEGER NOT NULL,
    "lastEvidenceAt" TIMESTAMP(3),
    "provenance" JSONB NOT NULL,
    "aiInvocationId" TEXT,
    "fingerprint" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "intelligence_digests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "intelligence_digests_organizationId_userId_domain_subjectKi_key" ON "intelligence_digests"("organizationId", "userId", "domain", "subjectKind", "subjectRef");

-- CreateIndex
CREATE INDEX "intelligence_digests_organizationId_userId_domain_status_idx" ON "intelligence_digests"("organizationId", "userId", "domain", "status");

-- CreateIndex
CREATE INDEX "intelligence_digests_organizationId_userId_provider_idx" ON "intelligence_digests"("organizationId", "userId", "provider");

-- CreateIndex
CREATE INDEX "intelligence_digests_expiresAt_idx" ON "intelligence_digests"("expiresAt");

-- AddForeignKey
ALTER TABLE "intelligence_digests" ADD CONSTRAINT "intelligence_digests_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intelligence_digests" ADD CONSTRAINT "intelligence_digests_userId_organizationId_fkey" FOREIGN KEY ("userId", "organizationId") REFERENCES "organization_memberships"("userId", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Prisma cannot express CHECK constraints; the database alone enforces these.

-- The shape every row must have. Vocabularies mirror @emgloop/shared (intelligence-digest.ts,
-- intelligence-coverage.ts); a test reads this file against those constants.
ALTER TABLE "intelligence_digests" ADD CONSTRAINT "intelligence_digests_shape_check" CHECK (
  "scope" IN ('PRINCIPAL', 'ORGANIZATION')
  -- A person's digest names the person.
  AND ("scope" <> 'PRINCIPAL' OR "userId" IS NOT NULL)
  AND "domain" IN ('CHATS', 'MAIL', 'CALENDAR', 'CALLGRID', 'CREATORS', 'WORK', 'CRM', 'CAMPAIGNS')
  AND "subjectKind" IN ('CONVERSATION', 'THREAD', 'DOMAIN')
  AND length("subjectRef") BETWEEN 1 AND 256
  -- A domain rollup is the one row per (person, domain).
  AND ("subjectKind" <> 'DOMAIN' OR "subjectRef" = 'domain')
  AND ("provider" IS NULL OR "provider" ~ '^[A-Z][A-Z0-9_]{0,63}$')
  AND "coverage" IN ('CONNECTED_SUFFICIENT', 'CONNECTED_INSUFFICIENT', 'CONNECTED_PARTIAL', 'DISCONNECTED', 'STALE', 'ERROR')
  AND "status" IN ('CURRENT', 'STALE', 'WITHDRAWN')
  AND "windowEnd" >= "windowStart"
  AND "evidenceCount" >= 0
  -- Evidence counted is evidence dated.
  AND ("evidenceCount" = 0 OR "lastEvidenceAt" IS NOT NULL)
  AND "version" >= 1
  AND length("fingerprint") BETWEEN 1 AND 128
  AND ("aiInvocationId" IS NULL OR length("aiInvocationId") BETWEEN 1 AND 200)
);

-- Minimized: an object, bounded, and never carrying the evidence under its own name.
ALTER TABLE "intelligence_digests" ADD CONSTRAINT "intelligence_digests_content_check" CHECK (
  jsonb_typeof("content") = 'object'
  AND pg_column_size("content") <= 16384
  AND NOT ("content" ?| ARRAY['body', 'text', 'quote', 'message'])
  AND jsonb_typeof("provenance") = 'object'
  AND pg_column_size("provenance") <= 16384
);

-- RESERVED: nothing may write organization-scope intelligence until a separate, approved decision
-- drops this constraint. PR A, B and C write PRINCIPAL rows only.
ALTER TABLE "intelligence_digests" ADD CONSTRAINT "intelligence_digests_organization_scope_reserved" CHECK (
  "scope" = 'PRINCIPAL'
);
