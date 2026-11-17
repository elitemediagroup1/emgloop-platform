-- CreateTable
CREATE TABLE "creator_analytics_reviews" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "creatorProfileId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "reading" JSONB,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "leaseId" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "invocationId" TEXT,
    "providerId" TEXT,
    "failure" TEXT,
    "generatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "creator_analytics_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "creator_analytics_reviews_organizationId_userId_creatorProf_idx" ON "creator_analytics_reviews"("organizationId", "userId", "creatorProfileId", "createdAt");

-- CreateIndex
CREATE INDEX "creator_analytics_reviews_expiresAt_idx" ON "creator_analytics_reviews"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "creator_analytics_reviews_organizationId_userId_creatorProf_key" ON "creator_analytics_reviews"("organizationId", "userId", "creatorProfileId", "source", "fingerprint");

-- AddForeignKey
ALTER TABLE "creator_analytics_reviews" ADD CONSTRAINT "creator_analytics_reviews_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_analytics_reviews" ADD CONSTRAINT "creator_analytics_reviews_userId_organizationId_fkey" FOREIGN KEY ("userId", "organizationId") REFERENCES "organization_memberships"("userId", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_analytics_reviews" ADD CONSTRAINT "creator_analytics_reviews_organizationId_creatorProfileId_fkey" FOREIGN KEY ("organizationId", "creatorProfileId") REFERENCES "creator_profiles"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "creator_analytics_reviews" ADD CONSTRAINT "creator_analytics_reviews_state_check" CHECK ("state" IN ('PENDING','READY','FAILED'));
ALTER TABLE "creator_analytics_reviews" ADD CONSTRAINT "creator_analytics_reviews_source_check" CHECK ("source" IN ('ACCOUNT','TIKTOK_ONE'));
