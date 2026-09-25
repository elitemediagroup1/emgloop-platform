-- Loop Intelligence PR 2 (the fabric), 2026-09-26: entity_links, EXPLICIT governed relationships between
-- canonical entity references (@emgloop/shared entity-ref.ts).
--
-- NOT IDENTITY RESOLUTION AND NOT A MODEL'S GUESS. A link's basis is HUMAN_DECLARED, RULE or IMPORTED --
-- never MODEL -- and it names its source. A SAME_AS link lets intelligence treat two references as one
-- business thing; it merges nothing and changes no Party (identity resolution keeps that authority).
-- Reversal is a stamp (reversedAt), so what Loop believed when stays readable.
--
-- SCOPE as intelligence_digests: PRINCIPAL rows are one person's (composite FK to the membership,
-- cascade) and may name that person's private evidence; ORGANIZATION rows name nobody and may not
-- reference a principal-only kind (telegram_conversation, work_thread, work_event, correspondent).
--
-- ADDITIVE ONLY: one new table; nothing existing is touched. Empty after the migration. ASCII only.

-- CreateTable
CREATE TABLE "entity_links" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "userId" TEXT,
    "fromRef" TEXT NOT NULL,
    "toRef" TEXT NOT NULL,
    "relation" TEXT NOT NULL,
    "basis" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceRef" TEXT,
    "declaredByUserId" TEXT,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "reversedAt" TIMESTAMP(3),
    "reversedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entity_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "entity_links_organizationId_scope_fromRef_idx" ON "entity_links"("organizationId", "scope", "fromRef");

-- CreateIndex
CREATE INDEX "entity_links_organizationId_scope_toRef_idx" ON "entity_links"("organizationId", "scope", "toRef");

-- CreateIndex
CREATE INDEX "entity_links_organizationId_userId_idx" ON "entity_links"("organizationId", "userId");

-- One ACTIVE link per (owner, from, relation, to), per scope.
CREATE UNIQUE INDEX "entity_links_principal_active_key" ON "entity_links"("organizationId", "userId", "fromRef", "relation", "toRef") WHERE "scope" = 'PRINCIPAL' AND "reversedAt" IS NULL;
CREATE UNIQUE INDEX "entity_links_organization_active_key" ON "entity_links"("organizationId", "fromRef", "relation", "toRef") WHERE "scope" = 'ORGANIZATION' AND "reversedAt" IS NULL;

-- AddForeignKey
ALTER TABLE "entity_links" ADD CONSTRAINT "entity_links_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_links" ADD CONSTRAINT "entity_links_userId_organizationId_fkey" FOREIGN KEY ("userId", "organizationId") REFERENCES "organization_memberships"("userId", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "entity_links" ADD CONSTRAINT "entity_links_shape_check" CHECK (
  "relation" IN ('SAME_AS', 'PART_OF', 'LOCATED_IN', 'REPRESENTS')
  AND "basis" IN ('HUMAN_DECLARED', 'RULE', 'IMPORTED')
  AND "fromRef" ~ '^[a-z_]{1,32}:.+$' AND length("fromRef") <= 256
  AND "toRef" ~ '^[a-z_]{1,32}:.+$' AND length("toRef") <= 256
  AND "fromRef" <> "toRef"
  AND "source" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'
  AND ("sourceRef" IS NULL OR length("sourceRef") BETWEEN 1 AND 256)
  AND ("basis" <> 'HUMAN_DECLARED' OR "declaredByUserId" IS NOT NULL)
  AND ("reversedByUserId" IS NULL OR "reversedAt" IS NOT NULL)
  AND ("reversedAt" IS NULL OR "reversedAt" >= "effectiveFrom")
);

ALTER TABLE "entity_links" ADD CONSTRAINT "entity_links_scope_check" CHECK (
  ("scope" = 'PRINCIPAL' AND "userId" IS NOT NULL)
  OR (
    "scope" = 'ORGANIZATION'
    AND "userId" IS NULL
    AND split_part("fromRef", ':', 1) NOT IN ('telegram_conversation', 'work_thread', 'work_event', 'correspondent')
    AND split_part("toRef", ':', 1) NOT IN ('telegram_conversation', 'work_thread', 'work_event', 'correspondent')
  )
);
