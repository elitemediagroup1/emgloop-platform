-- CRM slice 3 (2026-10-06): accountable Opportunity ownership, and Opportunity Participants on
-- the ONE existing participation table. Additive, except the participant shape CHECK, which is
-- replaced by the same rule extended to a second subject. Every existing (Relationship) row
-- satisfies the new clause: its branch is the old rule verbatim.

-- The User accountable for a pursuit. Accountability, never access (PD-F-11 decides access).
-- SET NULL on user deletion, as `crm_relationships.ownerUserId`: owner changes stay in the audit
-- trail (users are soft-removed in this platform, so the FK rarely fires).
ALTER TABLE "crm_opportunities" ADD COLUMN "ownerUserId" TEXT;
CREATE INDEX "crm_opportunities_organizationId_ownerUserId_idx" ON "crm_opportunities"("organizationId", "ownerUserId");
ALTER TABLE "crm_opportunities" ADD CONSTRAINT "crm_opportunities_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The second subject of the participant exclusive arc.
ALTER TABLE "crm_participants" ADD COLUMN "opportunityId" TEXT;
CREATE INDEX "crm_participants_organizationId_opportunityId_state_idx" ON "crm_participants"("organizationId", "opportunityId", "state");
ALTER TABLE "crm_participants" ADD CONSTRAINT "crm_participants_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "crm_opportunities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- EXACTLY ONE SUBJECT. On a Relationship, exactly one of side or acts-for (unchanged). On an
-- Opportunity, no side at all, and only BRAND held by a COMPANY or PRIMARY_CONTACT held by a
-- PERSON -- so neither a service bug nor a hand-written INSERT can make a Person a brand or a
-- Company a contact. The rest of the rule is the original clause.
ALTER TABLE "crm_participants" DROP CONSTRAINT "crm_participants_shape";
ALTER TABLE "crm_participants" ADD CONSTRAINT "crm_participants_shape"
  CHECK (
    (("relationshipId" IS NOT NULL) <> ("opportunityId" IS NOT NULL))
    AND "state" IN ('ACTIVE', 'ENDED', 'VOIDED')
    AND "partyType" IN ('PERSON', 'COMPANY')
    AND "roleFamily" IN ('CAPACITY', 'ENGAGEMENT')
    AND (
      ("relationshipId" IS NOT NULL AND (("side" IS NULL) <> ("actsForSide" IS NULL)))
      OR (
        "opportunityId" IS NOT NULL
        AND "side" IS NULL
        AND "actsForSide" IS NULL
        AND (("role" = 'BRAND' AND "partyType" = 'COMPANY') OR ("role" = 'PRIMARY_CONTACT' AND "partyType" = 'PERSON'))
      )
    )
    AND ("side" IS NULL OR "side" IN ('COUNTERPARTY', 'A', 'B'))
    AND ("actsForSide" IS NULL OR "actsForSide" IN ('COUNTERPARTY', 'A', 'B'))
    AND ("state" = 'ACTIVE') = ("activeKey" IS NOT NULL)
    AND ("state" <> 'ENDED' OR "endedAt" IS NOT NULL)
    AND ("state" <> 'VOIDED' OR "voidedAt" IS NOT NULL)
    AND ("state" <> 'ACTIVE' OR ("endedAt" IS NULL AND "voidedAt" IS NULL))
    AND ("effectiveTo" IS NULL OR "effectiveFrom" IS NULL OR "effectiveTo" >= "effectiveFrom")
  );

-- An ended or voided Opportunity Participant carries its reason, as the Relationship log requires
-- for the same acts (an Opportunity Participant has no event log of its own; the row and the audit
-- trail are its history).
ALTER TABLE "crm_participants" ADD CONSTRAINT "crm_participants_opportunity_close_reason"
  CHECK (
    "opportunityId" IS NULL
    OR ("state" <> 'ENDED' OR ("endReason" IS NOT NULL AND btrim("endReason") <> ''))
  );
ALTER TABLE "crm_participants" ADD CONSTRAINT "crm_participants_opportunity_void_reason"
  CHECK (
    "opportunityId" IS NULL
    OR ("state" <> 'VOIDED' OR ("voidReason" IS NOT NULL AND btrim("voidReason") <> ''))
  );
