-- Loop Intelligence PR 2 (the fabric), 2026-09-26: ORGANIZATION digests become real, for governed Loop
-- records only; entity references on digests.
--
-- WHAT CHANGES
--   1. Uniqueness is split by scope. The PR A unique index covered (organizationId, userId, domain,
--      subjectKind, subjectRef); with userId NULL for an organization row, Postgres treats every NULL as
--      distinct, so that index could never make an organization digest unique. Two PARTIAL unique
--      indexes replace it: one per (org, user, domain, subject) for PRINCIPAL rows, one per (org, domain,
--      subject) for ORGANIZATION rows. The new indexes are created BEFORE the old one is dropped, so
--      there is no instant at which a principal subject is not unique.
--   2. The scope/userId relationship is checked both ways, and an ORGANIZATION row is confined to
--      governed Loop records: no user, no provider, consent basis LOOP_RECORDS, and never a private
--      domain (CHATS, MAIL, CALENDAR). Private communication cannot become organization intelligence
--      even through a repository bug.
--   3. The reservation constraint (intelligence_digests_organization_scope_reserved) is dropped.
--   4. The domain and subject vocabularies are replaced by a pattern: the code registry
--      (@emgloop/shared INTELLIGENCE_DOMAIN_REGISTRY) is the authority, and a new domain no longer needs
--      a migration to widen a list. Scope rules for the PRIVATE domains stay spelled out here.
--   5. "entityRefs" text[]: canonical entity references (@emgloop/shared entity-ref.ts), at most 32,
--      default empty so every existing row is valid and readable unchanged.
--   6. The content bound rises from 16384 to 32768 bytes for typed signals.
--
-- NOT PURELY ADDITIVE: it DROPS one unique index and three CHECK constraints and REPLACES them (the
-- per-scope partial unique indexes are created BEFORE the old unique index is dropped). It is
-- BACKWARD-COMPATIBLE AND REWRITES NO ROW: every existing row (all PRINCIPAL, all Chats) satisfies every
-- replacement constraint, and the new "entityRefs" column has a database default. Code deployed before
-- this migration never writes ORGANIZATION rows or entityRefs (it probes for the column), and code deployed
-- after it reads both.
--
-- ASCII only.

-- 1. Uniqueness, per scope. New indexes first.
CREATE UNIQUE INDEX "intelligence_digests_principal_subject_key" ON "intelligence_digests"("organizationId", "userId", "domain", "subjectKind", "subjectRef") WHERE "scope" = 'PRINCIPAL';
CREATE UNIQUE INDEX "intelligence_digests_organization_subject_key" ON "intelligence_digests"("organizationId", "domain", "subjectKind", "subjectRef") WHERE "scope" = 'ORGANIZATION';
DROP INDEX "intelligence_digests_organizationId_userId_domain_subjectKi_key";
-- The non-unique lookup index Prisma's schema now declares in its place.
CREATE INDEX "intelligence_digests_organizationId_userId_domain_subjectKi_idx" ON "intelligence_digests"("organizationId", "userId", "domain", "subjectKind", "subjectRef");
CREATE INDEX "intelligence_digests_organizationId_scope_domain_status_idx" ON "intelligence_digests"("organizationId", "scope", "domain", "status");

-- 5. Entity references.
ALTER TABLE "intelligence_digests" ADD COLUMN "entityRefs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
CREATE INDEX "intelligence_digests_entityRefs_idx" ON "intelligence_digests" USING GIN ("entityRefs");

-- 2-4, 6. Constraints.
ALTER TABLE "intelligence_digests" DROP CONSTRAINT "intelligence_digests_organization_scope_reserved";
ALTER TABLE "intelligence_digests" DROP CONSTRAINT "intelligence_digests_shape_check";
ALTER TABLE "intelligence_digests" DROP CONSTRAINT "intelligence_digests_content_check";

ALTER TABLE "intelligence_digests" ADD CONSTRAINT "intelligence_digests_shape_check" CHECK (
  "scope" IN ('PRINCIPAL', 'ORGANIZATION')
  AND "domain" ~ '^[A-Z][A-Z_]{1,31}$'
  AND "subjectKind" ~ '^[A-Z][A-Z_]{1,31}$'
  AND length("subjectRef") BETWEEN 1 AND 256
  -- A domain rollup is the one row per (scope owner, domain).
  AND ("subjectKind" <> 'DOMAIN' OR "subjectRef" = 'domain')
  AND ("provider" IS NULL OR "provider" ~ '^[A-Z][A-Z0-9_]{0,63}$')
  AND "coverage" IN ('CONNECTED_SUFFICIENT', 'CONNECTED_INSUFFICIENT', 'CONNECTED_PARTIAL', 'DISCONNECTED', 'STALE', 'ERROR')
  AND "status" IN ('CURRENT', 'STALE', 'WITHDRAWN')
  AND "windowEnd" >= "windowStart"
  AND "evidenceCount" >= 0
  AND ("evidenceCount" = 0 OR "lastEvidenceAt" IS NOT NULL)
  AND "version" >= 1
  AND length("fingerprint") BETWEEN 1 AND 128
  AND ("aiInvocationId" IS NULL OR length("aiInvocationId") BETWEEN 1 AND 200)
  AND cardinality("entityRefs") <= 32
);

-- Who a row belongs to. A person's digest names the person; an organization's names nobody, carries no
-- consent provider, rests on Loop's own records, and is never in a private domain.
ALTER TABLE "intelligence_digests" ADD CONSTRAINT "intelligence_digests_scope_check" CHECK (
  ("scope" = 'PRINCIPAL' AND "userId" IS NOT NULL)
  OR (
    "scope" = 'ORGANIZATION'
    AND "userId" IS NULL
    AND "provider" IS NULL
    AND COALESCE("provenance"->>'consentBasis', '') = 'LOOP_RECORDS'
    AND "domain" NOT IN ('CHATS', 'MAIL', 'CALENDAR')
  )
);

ALTER TABLE "intelligence_digests" ADD CONSTRAINT "intelligence_digests_content_check" CHECK (
  jsonb_typeof("content") = 'object'
  AND pg_column_size("content") <= 32768
  AND NOT ("content" ?| ARRAY['body', 'text', 'quote', 'message'])
  AND jsonb_typeof("provenance") = 'object'
  AND pg_column_size("provenance") <= 16384
);
