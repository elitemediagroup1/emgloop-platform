-- CreateTable
CREATE TABLE "CreatorPayoutBank" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "creatorProfileId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "sealed" TEXT,
    "mask" TEXT NOT NULL,
    "institution" TEXT NOT NULL,
    "legalName" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "consentVersion" TEXT NOT NULL,
    "consentAt" TIMESTAMP(3) NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "state" TEXT NOT NULL DEFAULT 'CONNECTED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorPayoutBank_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreatorPayoutLink" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "creatorProfileId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "nonceHash" TEXT NOT NULL,
    "legalName" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreatorPayoutLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreatorPayout" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "creatorProfileId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "compensationEntryId" TEXT NOT NULL,
    "earningReference" TEXT NOT NULL,
    "approvalSubmission" TEXT NOT NULL,
    "approvedByUserId" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "amountMinor" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "payoutLedgerId" TEXT,
    "fundingAccountId" TEXT,
    "fundingAccountLabel" TEXT,
    "fundingLedgerId" TEXT,
    "fundingRequestedAt" TIMESTAMP(3),
    "fundingRequestedByUserId" TEXT,
    "fundingSweepId" TEXT,
    "fundingStatus" TEXT,
    "fundingLeaseUntil" TIMESTAMP(3),
    "fundingCheckedAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "releasedByUserId" TEXT,
    "bankId" TEXT,
    "bankRevision" INTEGER,
    "requestedAt" TIMESTAMP(3),
    "authorizationId" TEXT,
    "transferId" TEXT,
    "providerStatus" TEXT,
    "failure" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "checkedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorPayout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CreatorPayoutBank_organizationId_creatorProfileId_environme_key" ON "CreatorPayoutBank"("organizationId", "creatorProfileId", "environment");

-- CreateIndex
CREATE UNIQUE INDEX "CreatorPayoutLink_nonceHash_key" ON "CreatorPayoutLink"("nonceHash");

-- CreateIndex
CREATE INDEX "CreatorPayoutLink_expiresAt_idx" ON "CreatorPayoutLink"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "CreatorPayout_compensationEntryId_key" ON "CreatorPayout"("compensationEntryId");

-- CreateIndex
CREATE UNIQUE INDEX "CreatorPayout_fundingSweepId_key" ON "CreatorPayout"("fundingSweepId");

-- CreateIndex
CREATE UNIQUE INDEX "CreatorPayout_authorizationId_key" ON "CreatorPayout"("authorizationId");

-- CreateIndex
CREATE UNIQUE INDEX "CreatorPayout_transferId_key" ON "CreatorPayout"("transferId");

-- CreateIndex
CREATE INDEX "CreatorPayout_environment_state_checkedAt_idx" ON "CreatorPayout"("environment", "state", "checkedAt");

-- CreateIndex
CREATE INDEX "CreatorPayout_organizationId_creatorProfileId_userId_idx" ON "CreatorPayout"("organizationId", "creatorProfileId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "CreatorPayout_organizationId_approvalSubmission_key" ON "CreatorPayout"("organizationId", "approvalSubmission");

-- CreateIndex
CREATE UNIQUE INDEX "CreatorPayout_organizationId_environment_earningReference_key" ON "CreatorPayout"("organizationId", "environment", "earningReference");

-- AddForeignKey
ALTER TABLE "CreatorPayoutBank" ADD CONSTRAINT "CreatorPayoutBank_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreatorPayoutBank" ADD CONSTRAINT "CreatorPayoutBank_organizationId_creatorProfileId_fkey" FOREIGN KEY ("organizationId", "creatorProfileId") REFERENCES "creator_profiles"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreatorPayoutLink" ADD CONSTRAINT "CreatorPayoutLink_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreatorPayoutLink" ADD CONSTRAINT "CreatorPayoutLink_organizationId_creatorProfileId_fkey" FOREIGN KEY ("organizationId", "creatorProfileId") REFERENCES "creator_profiles"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreatorPayout" ADD CONSTRAINT "CreatorPayout_compensationEntryId_fkey" FOREIGN KEY ("compensationEntryId") REFERENCES "creator_compensation_entries"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreatorPayout" ADD CONSTRAINT "CreatorPayout_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreatorPayout" ADD CONSTRAINT "CreatorPayout_organizationId_creatorProfileId_fkey" FOREIGN KEY ("organizationId", "creatorProfileId") REFERENCES "creator_profiles"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Fail closed for invalid financial state, including accidental direct writes.
ALTER TABLE "CreatorPayout" ADD CONSTRAINT "creator_payout_amount_positive" CHECK ("amountMinor" > 0 AND "amountMinor" <= 100000000);
ALTER TABLE "CreatorPayout" ADD CONSTRAINT "creator_payout_environment" CHECK ("environment" IN ('sandbox','production'));
ALTER TABLE "CreatorPayout" ADD CONSTRAINT "creator_payout_state" CHECK ("state" IN ('PENDING','AVAILABLE','REQUESTED','PROCESSING','PAID','REVIEW','RETURNED','CANCELLED'));
ALTER TABLE "CreatorPayout" ADD CONSTRAINT "creator_payout_requested_binding" CHECK ("state" IN ('PENDING','AVAILABLE','CANCELLED') OR ("requestedAt" IS NOT NULL AND "bankId" IS NOT NULL AND "bankRevision" IS NOT NULL));
ALTER TABLE "CreatorPayout" ADD CONSTRAINT "creator_payout_paid_proof" CHECK ("state" <> 'PAID' OR ("transferId" IS NOT NULL AND "providerStatus" = 'settled'));

ALTER TABLE "CreatorPayout" ADD CONSTRAINT "creator_payout_release_proof" CHECK ("state" NOT IN ('AVAILABLE','REQUESTED','PROCESSING','PAID','REVIEW','RETURNED') OR ("releasedAt" IS NOT NULL AND "releasedByUserId" IS NOT NULL AND "payoutLedgerId" IS NOT NULL AND length("payoutLedgerId") > 0));
ALTER TABLE "CreatorPayout" ADD CONSTRAINT "creator_payout_funding_source" CHECK ("fundingRequestedAt" IS NULL OR ("fundingAccountId" IS NOT NULL AND "fundingLedgerId" IS NOT NULL AND length("fundingAccountId") > 0 AND length("fundingLedgerId") > 0 AND "fundingRequestedByUserId" IS NOT NULL));
