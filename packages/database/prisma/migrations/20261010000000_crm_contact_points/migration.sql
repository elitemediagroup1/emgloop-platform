-- CRM Contact Points (PD-F-05, Product 2026-10-06). docs/architecture/crm-contact-points.md.
--
-- A business email or phone a person recorded or imported for an established Party. An
-- operational CRM record, NOT identity evidence: nothing here writes identity_evidence, a tier,
-- an attribution or a Party. Additive only: two new tables and one enum value.
--
-- Vocabularies are strings validated by `@emgloop/shared` crm-contact-point.ts AND by the CHECKs
-- below, so neither a service bug nor a hand-written INSERT can store a point that does not fit
-- its Party type, an unnormalized value, or a current-key that disagrees with the state.

-- AlterEnum
ALTER TYPE "OutboxSubjectType" ADD VALUE 'CONTACT_POINT';

-- CreateTable
CREATE TABLE "crm_contact_points" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "partyId" TEXT NOT NULL,
    "partyType" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "classification" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'BUSINESS_CONTACT',
    "value" TEXT,
    "valueErasedAt" TIMESTAMP(3),
    "valueHash" TEXT NOT NULL,
    "hashKeyFingerprint" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "lastSequence" INTEGER NOT NULL DEFAULT 0,
    "currentKey" TEXT,
    "basis" TEXT NOT NULL,
    "sourceRef" TEXT,
    "retentionPolicy" TEXT NOT NULL DEFAULT 'crm.contact_point.retention.v1',
    "lastHumanContactAt" TIMESTAMP(3),
    "addedByUserId" TEXT,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "undeliverableAt" TIMESTAMP(3),
    "retiredAt" TIMESTAMP(3),
    "voidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_contact_points_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_contact_point_events" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "contactPointId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "occurredAtBasis" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorType" TEXT NOT NULL,
    "actorUserId" TEXT,
    "reason" TEXT,
    "fromState" TEXT,
    "toState" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crm_contact_point_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "crm_contact_points_organizationId_partyId_state_idx" ON "crm_contact_points"("organizationId", "partyId", "state");

-- CreateIndex
CREATE INDEX "crm_contact_points_organizationId_kind_valueHash_idx" ON "crm_contact_points"("organizationId", "kind", "valueHash");

-- CreateIndex
CREATE UNIQUE INDEX "crm_contact_points_organizationId_currentKey_key" ON "crm_contact_points"("organizationId", "currentKey");

-- CreateIndex
CREATE INDEX "crm_contact_point_events_organizationId_contactPointId_sequ_idx" ON "crm_contact_point_events"("organizationId", "contactPointId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "crm_contact_point_events_contactPointId_sequence_key" ON "crm_contact_point_events"("contactPointId", "sequence");

-- AddForeignKey
ALTER TABLE "crm_contact_points" ADD CONSTRAINT "crm_contact_points_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_contact_points" ADD CONSTRAINT "crm_contact_points_addedByUserId_fkey" FOREIGN KEY ("addedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_contact_point_events" ADD CONSTRAINT "crm_contact_point_events_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_contact_point_events" ADD CONSTRAINT "crm_contact_point_events_contactPointId_fkey" FOREIGN KEY ("contactPointId") REFERENCES "crm_contact_points"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_contact_point_events" ADD CONSTRAINT "crm_contact_point_events_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- The row's claims must agree: its classification fits its Party type, an import carries a
-- source reference and nothing else does, exactly the current states hold the key, the stamps
-- match the state, and the value (until erased) is in its one normalized form. Prisma does not
-- model CHECK constraints; the database alone enforces these.
ALTER TABLE "crm_contact_points" ADD CONSTRAINT "crm_contact_points_shape"
  CHECK (
    "kind" IN ('EMAIL', 'PHONE')
    AND "partyType" IN ('PERSON', 'COMPANY')
    AND (
      ("classification" = 'INDIVIDUAL' AND "partyType" = 'PERSON')
      OR ("classification" IN ('ROLE_INBOX', 'UNATTRIBUTED') AND "partyType" = 'COMPANY')
    )
    AND "purpose" = 'BUSINESS_CONTACT'
    AND "basis" IN ('OPERATOR_RECORDED', 'IMPORTED')
    AND (("basis" = 'IMPORTED') = ("sourceRef" IS NOT NULL))
    AND ("sourceRef" IS NULL OR "sourceRef" !~ '@')
    AND "state" IN ('ACTIVE', 'UNDELIVERABLE', 'RETIRED', 'VOIDED')
    AND ("state" IN ('ACTIVE', 'UNDELIVERABLE')) = ("currentKey" IS NOT NULL)
    AND ("state" <> 'ACTIVE' OR ("undeliverableAt" IS NULL AND "retiredAt" IS NULL AND "voidedAt" IS NULL))
    AND ("state" <> 'UNDELIVERABLE' OR "undeliverableAt" IS NOT NULL)
    AND ("state" <> 'RETIRED' OR "retiredAt" IS NOT NULL)
    AND ("state" <> 'VOIDED' OR "voidedAt" IS NOT NULL)
    AND (("value" IS NULL) = ("valueErasedAt" IS NOT NULL))
    AND (
      "value" IS NULL
      OR ("kind" = 'EMAIL' AND "value" = lower(btrim("value")) AND "value" ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
      OR ("kind" = 'PHONE' AND "value" ~ '^\+[1-9][0-9]{7,14}$')
    )
    AND length("valueHash") = 64
    AND "lastSequence" >= 0
  );

-- An event is a human act with a time basis; every act after ADDED says no or undoes, so it
-- carries a reason. Sequence starts at 1.
ALTER TABLE "crm_contact_point_events" ADD CONSTRAINT "crm_contact_point_events_shape"
  CHECK (
    "sequence" >= 1
    AND "actorType" = 'HUMAN'
    AND "occurredAtBasis" IN ('PROVIDER_REPORTED', 'LOOP_CLOCK', 'OPERATOR_STATED', 'REPORTING_WINDOW', 'UNKNOWN')
    AND "type" IN ('CONTACT_POINT_ADDED', 'CONTACT_POINT_MARKED_UNDELIVERABLE', 'CONTACT_POINT_RETIRED', 'CONTACT_POINT_VOIDED')
    AND "toState" IN ('ACTIVE', 'UNDELIVERABLE', 'RETIRED', 'VOIDED')
    AND ("fromState" IS NULL OR "fromState" IN ('ACTIVE', 'UNDELIVERABLE', 'RETIRED'))
    AND (("type" = 'CONTACT_POINT_ADDED') = ("fromState" IS NULL))
    AND ("type" = 'CONTACT_POINT_ADDED' OR ("reason" IS NOT NULL AND btrim("reason") <> ''))
  );
