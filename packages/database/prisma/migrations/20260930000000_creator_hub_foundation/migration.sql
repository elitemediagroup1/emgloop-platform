-- Creator Hub foundation (2026-09-22). ADDITIVE ONLY: one enum value, two column
-- additions on Work OS tables, fourteen new tables, foreign keys. Nothing is dropped,
-- renamed or rewritten; no data is touched. Safe to apply to a live database.
--
--   SystemRole + CREATOR            a managed creator's own login (holds nothing in the matrix)
--   work_instances                  requested vs expected return (two facts, never one)
--   work_comments.visibility        internal (default) | creator_visible
--   work_instructions               instruction sets with provenance on a work item
--   creator_profiles, creator_contents, content_versions, content_version_approvals,
--   content_publications, content_productions          the creator domain
--   crm_opportunities(+_transitions), crm_campaigns(+_transitions), campaign_deliverables
--                                   CRM commercial records at their minimum, append-only history
--   creator_performance_snapshots, creator_audience_snapshots, creator_compensation_entries
--                                   evidence rows; every row names its source (SEEDED_DEMO is labelled)

-- AlterEnum
ALTER TYPE "SystemRole" ADD VALUE 'CREATOR';

-- AlterTable
ALTER TABLE "work_comments" ADD COLUMN     "visibility" TEXT NOT NULL DEFAULT 'internal';

-- AlterTable
ALTER TABLE "work_instances" ADD COLUMN     "expectedReturnAt" TIMESTAMP(3),
ADD COLUMN     "expectedReturnSetAt" TIMESTAMP(3),
ADD COLUMN     "expectedReturnSetByUserId" TEXT,
ADD COLUMN     "requestedReturnAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "work_instructions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workInstanceId" TEXT NOT NULL,
    "workStageId" TEXT,
    "sequence" INTEGER NOT NULL,
    "originatorKind" TEXT NOT NULL,
    "originatorLabel" TEXT,
    "enteredByUserId" TEXT NOT NULL,
    "refersToVersionId" TEXT,
    "summary" TEXT,
    "notes" JSONB NOT NULL DEFAULT '[]',
    "requestedReturnAt" TIMESTAMP(3),
    "answeredByVersionId" TEXT,
    "answeredAt" TIMESTAMP(3),
    "addressed" JSONB NOT NULL DEFAULT '[]',
    "visibleToCreator" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_instructions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creator_profiles" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "partyId" TEXT NOT NULL,
    "userId" TEXT,
    "displayName" TEXT NOT NULL,
    "handle" TEXT,
    "bio" TEXT,
    "categories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "socialAccounts" JSONB NOT NULL DEFAULT '[]',
    "payoutState" TEXT NOT NULL DEFAULT 'NOT_SET_UP',
    "rateInfo" JSONB NOT NULL DEFAULT '{}',
    "documents" JSONB NOT NULL DEFAULT '[]',
    "preferences" JSONB NOT NULL DEFAULT '{}',
    "defaultEditorUserId" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "creator_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creator_contents" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "creatorProfileId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "campaignId" TEXT,
    "deliverableId" TEXT,
    "opportunityId" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "creator_contents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_versions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "contentId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "byteSize" INTEGER,
    "fileName" TEXT,
    "uploadState" TEXT NOT NULL DEFAULT 'PENDING',
    "durationSeconds" DOUBLE PRECISION,
    "width" INTEGER,
    "height" INTEGER,
    "clientFacts" JSONB NOT NULL DEFAULT '{}',
    "uploadedByUserId" TEXT NOT NULL,
    "uploadedByKind" TEXT NOT NULL,
    "producedByWorkInstanceId" TEXT,
    "answersInstructionId" TEXT,
    "noteToCreator" TEXT,
    "internalNote" TEXT,
    "visibleToCreator" BOOLEAN NOT NULL DEFAULT true,
    "readyAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_version_approvals" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "contentId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "requirementKey" TEXT NOT NULL,
    "approverKind" TEXT NOT NULL,
    "approvedByUserId" TEXT NOT NULL,
    "originatorLabel" TEXT,
    "note" TEXT,
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_version_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_publications" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "contentId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "url" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL,
    "markedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_publications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_productions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "contentId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'EDIT',
    "workInstanceId" TEXT NOT NULL,
    "sourceVersionId" TEXT NOT NULL,
    "requestedByUserId" TEXT NOT NULL,
    "requestedReturnAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "content_productions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_opportunities" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'OPEN',
    "stage" TEXT NOT NULL,
    "creatorPartyId" TEXT NOT NULL,
    "creatorVisibleState" TEXT,
    "brandLabel" TEXT,
    "brandVisibleToCreator" BOOLEAN NOT NULL DEFAULT false,
    "summaryForCreator" TEXT,
    "internalNotes" TEXT,
    "forecastProbability" INTEGER,
    "forecastAuthoredByUserId" TEXT,
    "forecastAuthoredAt" TIMESTAMP(3),
    "amountMinor" INTEGER,
    "currency" TEXT,
    "expectedCloseDate" DATE,
    "outcome" TEXT,
    "lossReason" TEXT,
    "relationshipId" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_opportunities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_opportunity_transitions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "fromCategory" TEXT,
    "fromStage" TEXT,
    "toCategory" TEXT NOT NULL,
    "toStage" TEXT NOT NULL,
    "actorUserId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    "creatorVisible" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "crm_opportunity_transitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_campaigns" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'DRAFT',
    "opportunityId" TEXT,
    "creatorPartyId" TEXT NOT NULL,
    "brandLabel" TEXT,
    "brandVisibleToCreator" BOOLEAN NOT NULL DEFAULT false,
    "startDate" DATE,
    "endDate" DATE,
    "creatorBrief" TEXT,
    "termsSummary" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_campaign_transitions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "fromState" TEXT,
    "toState" TEXT NOT NULL,
    "actorUserId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    "creatorVisible" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "crm_campaign_transitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_deliverables" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "creatorPartyId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "deliverableType" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3),
    "requirements" JSONB NOT NULL DEFAULT '[]',
    "acceptsUnedited" BOOLEAN NOT NULL DEFAULT false,
    "contentId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "completedAt" TIMESTAMP(3),
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaign_deliverables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creator_performance_snapshots" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "creatorProfileId" TEXT NOT NULL,
    "contentId" TEXT,
    "versionId" TEXT,
    "platform" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "metrics" JSONB NOT NULL,
    "source" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "creator_performance_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creator_audience_snapshots" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "creatorProfileId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "followers" INTEGER NOT NULL,
    "growth30dPct" DOUBLE PRECISION,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "creator_audience_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creator_compensation_entries" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "creatorProfileId" TEXT NOT NULL,
    "campaignId" TEXT,
    "deliverableId" TEXT,
    "description" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "state" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "creator_compensation_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "work_instructions_organizationId_workInstanceId_idx" ON "work_instructions"("organizationId", "workInstanceId");

-- CreateIndex
CREATE UNIQUE INDEX "work_instructions_workInstanceId_sequence_key" ON "work_instructions"("workInstanceId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "creator_profiles_userId_key" ON "creator_profiles"("userId");

-- CreateIndex
CREATE INDEX "creator_profiles_organizationId_idx" ON "creator_profiles"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "creator_profiles_organizationId_partyId_key" ON "creator_profiles"("organizationId", "partyId");

-- CreateIndex
CREATE INDEX "creator_contents_organizationId_creatorProfileId_createdAt_idx" ON "creator_contents"("organizationId", "creatorProfileId", "createdAt");

-- CreateIndex
CREATE INDEX "creator_contents_organizationId_campaignId_idx" ON "creator_contents"("organizationId", "campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "content_versions_storageKey_key" ON "content_versions"("storageKey");

-- CreateIndex
CREATE INDEX "content_versions_organizationId_contentId_idx" ON "content_versions"("organizationId", "contentId");

-- CreateIndex
CREATE UNIQUE INDEX "content_versions_contentId_number_key" ON "content_versions"("contentId", "number");

-- CreateIndex
CREATE INDEX "content_version_approvals_organizationId_contentId_idx" ON "content_version_approvals"("organizationId", "contentId");

-- CreateIndex
CREATE UNIQUE INDEX "content_version_approvals_versionId_requirementKey_key" ON "content_version_approvals"("versionId", "requirementKey");

-- CreateIndex
CREATE INDEX "content_publications_organizationId_contentId_idx" ON "content_publications"("organizationId", "contentId");

-- CreateIndex
CREATE UNIQUE INDEX "content_productions_workInstanceId_key" ON "content_productions"("workInstanceId");

-- CreateIndex
CREATE INDEX "content_productions_organizationId_contentId_idx" ON "content_productions"("organizationId", "contentId");

-- CreateIndex
CREATE UNIQUE INDEX "content_productions_contentId_number_key" ON "content_productions"("contentId", "number");

-- CreateIndex
CREATE INDEX "crm_opportunities_organizationId_creatorPartyId_idx" ON "crm_opportunities"("organizationId", "creatorPartyId");

-- CreateIndex
CREATE INDEX "crm_opportunities_organizationId_category_idx" ON "crm_opportunities"("organizationId", "category");

-- CreateIndex
CREATE UNIQUE INDEX "crm_opportunity_transitions_opportunityId_sequence_key" ON "crm_opportunity_transitions"("opportunityId", "sequence");

-- CreateIndex
CREATE INDEX "crm_campaigns_organizationId_creatorPartyId_idx" ON "crm_campaigns"("organizationId", "creatorPartyId");

-- CreateIndex
CREATE UNIQUE INDEX "crm_campaign_transitions_campaignId_sequence_key" ON "crm_campaign_transitions"("campaignId", "sequence");

-- CreateIndex
CREATE INDEX "campaign_deliverables_organizationId_campaignId_idx" ON "campaign_deliverables"("organizationId", "campaignId");

-- CreateIndex
CREATE INDEX "campaign_deliverables_organizationId_creatorPartyId_idx" ON "campaign_deliverables"("organizationId", "creatorPartyId");

-- CreateIndex
CREATE INDEX "creator_performance_snapshots_organizationId_creatorProfile_idx" ON "creator_performance_snapshots"("organizationId", "creatorProfileId", "platform", "windowEnd");

-- CreateIndex
CREATE INDEX "creator_performance_snapshots_organizationId_contentId_idx" ON "creator_performance_snapshots"("organizationId", "contentId");

-- CreateIndex
CREATE INDEX "creator_audience_snapshots_organizationId_creatorProfileId__idx" ON "creator_audience_snapshots"("organizationId", "creatorProfileId", "platform", "observedAt");

-- CreateIndex
CREATE INDEX "creator_compensation_entries_organizationId_creatorProfileI_idx" ON "creator_compensation_entries"("organizationId", "creatorProfileId", "occurredAt");

-- AddForeignKey
ALTER TABLE "work_instructions" ADD CONSTRAINT "work_instructions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_instructions" ADD CONSTRAINT "work_instructions_workInstanceId_fkey" FOREIGN KEY ("workInstanceId") REFERENCES "work_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_profiles" ADD CONSTRAINT "creator_profiles_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_contents" ADD CONSTRAINT "creator_contents_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_contents" ADD CONSTRAINT "creator_contents_creatorProfileId_fkey" FOREIGN KEY ("creatorProfileId") REFERENCES "creator_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_versions" ADD CONSTRAINT "content_versions_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "creator_contents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_version_approvals" ADD CONSTRAINT "content_version_approvals_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "creator_contents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_version_approvals" ADD CONSTRAINT "content_version_approvals_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "content_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_publications" ADD CONSTRAINT "content_publications_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "creator_contents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_publications" ADD CONSTRAINT "content_publications_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "content_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_productions" ADD CONSTRAINT "content_productions_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "creator_contents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_opportunities" ADD CONSTRAINT "crm_opportunities_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_opportunity_transitions" ADD CONSTRAINT "crm_opportunity_transitions_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "crm_opportunities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_campaigns" ADD CONSTRAINT "crm_campaigns_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_campaigns" ADD CONSTRAINT "crm_campaigns_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "crm_opportunities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_campaign_transitions" ADD CONSTRAINT "crm_campaign_transitions_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "crm_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_deliverables" ADD CONSTRAINT "campaign_deliverables_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_deliverables" ADD CONSTRAINT "campaign_deliverables_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "crm_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_performance_snapshots" ADD CONSTRAINT "creator_performance_snapshots_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_audience_snapshots" ADD CONSTRAINT "creator_audience_snapshots_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_compensation_entries" ADD CONSTRAINT "creator_compensation_entries_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "source_content_authorizations_historicalState_historicalLa_idx" RENAME TO "source_content_authorizations_historicalState_historicalLas_idx";
