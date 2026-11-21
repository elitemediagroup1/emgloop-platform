CREATE TABLE "qualification_intakes" (
 "id" TEXT NOT NULL PRIMARY KEY, "organizationId" TEXT NOT NULL, "partyId" TEXT NOT NULL,
 "opportunityId" TEXT, "templateKey" TEXT NOT NULL, "subtype" TEXT NOT NULL, "templateVersion" INTEGER NOT NULL,
 "templateSnapshot" JSONB NOT NULL, "requestKey" TEXT NOT NULL, "currentRevision" INTEGER NOT NULL DEFAULT 1,
 "state" TEXT NOT NULL DEFAULT 'DRAFT', "createdByUserId" TEXT NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "qualification_intakes_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "qualification_intakes_state_check" CHECK ("state" IN ('DRAFT', 'SUBMITTED', 'NEEDS_CLARIFICATION', 'QUALIFIED')),
 CONSTRAINT "qualification_intakes_revision_check" CHECK ("currentRevision" > 0 AND "templateVersion" > 0)
);
CREATE UNIQUE INDEX "qualification_intakes_organizationId_id_key" ON "qualification_intakes"("organizationId", "id");
CREATE UNIQUE INDEX "qualification_intakes_organizationId_requestKey_key" ON "qualification_intakes"("organizationId", "requestKey");
CREATE INDEX "qualification_intakes_organizationId_partyId_idx" ON "qualification_intakes"("organizationId", "partyId");
CREATE INDEX "qualification_intakes_organizationId_opportunityId_idx" ON "qualification_intakes"("organizationId", "opportunityId");
CREATE TABLE "qualification_intake_revisions" (
 "id" TEXT NOT NULL PRIMARY KEY, "organizationId" TEXT NOT NULL, "intakeId" TEXT NOT NULL,
 "number" INTEGER NOT NULL, "state" TEXT NOT NULL, "content" JSONB NOT NULL, "recordedByUserId" TEXT NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "qualification_intake_revisions_organizationId_intakeId_fkey" FOREIGN KEY ("organizationId", "intakeId") REFERENCES "qualification_intakes"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "qualification_intake_revisions_number_check" CHECK ("number" > 0),
 CONSTRAINT "qualification_intake_revisions_state_check" CHECK ("state" IN ('DRAFT', 'SUBMITTED', 'NEEDS_CLARIFICATION', 'QUALIFIED'))
);
CREATE UNIQUE INDEX "qualification_intake_revisions_organizationId_intakeId_number_key" ON "qualification_intake_revisions"("organizationId", "intakeId", "number");
