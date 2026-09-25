-- Loop Intelligence PR 2 (the fabric), 2026-09-26: intelligence_refresh_queue, the durable, coalescing
-- request that one intelligence target (scope, owner, domain, subject) be refreshed.
--
-- METADATA ONLY. A reason, an optional source id and revision, an optional fingerprint -- never a body,
-- a message or any content; the CHECK bounds every text column so nothing larger can hide in one.
--
-- COALESCING. At most one PENDING request per target, per scope (two partial unique indexes): a second
-- request for a pending target bumps its count instead of adding a row, and a principal request and an
-- organization request never collapse into each other. A CLAIMED request may coexist with one new
-- PENDING request for the same target (evidence that arrived while the first ran).
--
-- LEASED. A worker claims a request by compare-and-set with a lease; completing deletes it; a failure
-- returns it to PENDING with a backoff, and past the attempt limit it is HELD for an operator. An
-- expired lease is recovered by the next claimer.
--
-- ADDITIVE ONLY: one new table; nothing existing is touched. Empty after the migration, and nothing
-- enqueues until a producer is commissioned. ASCII only.

-- CreateTable
CREATE TABLE "intelligence_refresh_queue" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "userId" TEXT,
    "domain" TEXT NOT NULL,
    "subjectKind" TEXT NOT NULL,
    "subjectRef" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "sourceId" TEXT,
    "sourceRevision" TEXT,
    "fingerprint" TEXT,
    "requestCount" INTEGER NOT NULL DEFAULT 1,
    "firstRequestedAt" TIMESTAMP(3) NOT NULL,
    "lastRequestedAt" TIMESTAMP(3) NOT NULL,
    "notBefore" TIMESTAMP(3) NOT NULL,
    "state" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "lastOutcome" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "intelligence_refresh_queue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "intelligence_refresh_queue_state_notBefore_idx" ON "intelligence_refresh_queue"("state", "notBefore");

-- CreateIndex
CREATE INDEX "intelligence_refresh_queue_state_leaseExpiresAt_idx" ON "intelligence_refresh_queue"("state", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "intelligence_refresh_queue_organizationId_scope_domain_stat_idx" ON "intelligence_refresh_queue"("organizationId", "scope", "domain", "state");

-- CreateIndex
CREATE INDEX "intelligence_refresh_queue_organizationId_userId_idx" ON "intelligence_refresh_queue"("organizationId", "userId");

-- At most one PENDING request per target, per scope.
CREATE UNIQUE INDEX "intelligence_refresh_queue_principal_pending_key" ON "intelligence_refresh_queue"("organizationId", "userId", "domain", "subjectKind", "subjectRef") WHERE "scope" = 'PRINCIPAL' AND "state" = 'PENDING';
CREATE UNIQUE INDEX "intelligence_refresh_queue_organization_pending_key" ON "intelligence_refresh_queue"("organizationId", "domain", "subjectKind", "subjectRef") WHERE "scope" = 'ORGANIZATION' AND "state" = 'PENDING';

-- AddForeignKey
ALTER TABLE "intelligence_refresh_queue" ADD CONSTRAINT "intelligence_refresh_queue_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intelligence_refresh_queue" ADD CONSTRAINT "intelligence_refresh_queue_userId_organizationId_fkey" FOREIGN KEY ("userId", "organizationId") REFERENCES "organization_memberships"("userId", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "intelligence_refresh_queue" ADD CONSTRAINT "intelligence_refresh_queue_shape_check" CHECK (
  (("scope" = 'PRINCIPAL' AND "userId" IS NOT NULL) OR ("scope" = 'ORGANIZATION' AND "userId" IS NULL AND "domain" NOT IN ('CHATS', 'MAIL', 'CALENDAR')))
  AND "domain" ~ '^[A-Z][A-Z_]{1,31}$'
  AND "subjectKind" ~ '^[A-Z][A-Z_]{1,31}$'
  AND length("subjectRef") BETWEEN 1 AND 256
  AND "reason" ~ '^[A-Z][A-Z_]{1,47}$'
  AND ("sourceId" IS NULL OR "sourceId" ~ '^[A-Z][A-Z0-9_]{0,63}$')
  AND ("sourceRevision" IS NULL OR length("sourceRevision") BETWEEN 1 AND 128)
  AND ("fingerprint" IS NULL OR length("fingerprint") BETWEEN 1 AND 128)
  AND "state" IN ('PENDING', 'CLAIMED', 'HELD')
  AND "requestCount" >= 1
  AND "attempts" >= 0
  AND "lastRequestedAt" >= "firstRequestedAt"
  AND ("state" <> 'CLAIMED' OR ("leaseOwner" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL))
  AND ("leaseOwner" IS NULL OR length("leaseOwner") BETWEEN 1 AND 128)
  AND ("lastOutcome" IS NULL OR "lastOutcome" ~ '^[A-Z][A-Z_]{1,63}$')
);
