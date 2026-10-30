-- Explicit, owner-authorized creator-facing summaries; no subjects, addresses or message bodies.
CREATE UNIQUE INDEX "creator_profiles_organizationId_id_key" ON "creator_profiles"("organizationId", "id");
CREATE UNIQUE INDEX "work_threads_organizationId_userId_id_key" ON "work_threads"("organizationId", "userId", "id");
CREATE TABLE "creator_brand_mail_shares" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "ownerUserId" TEXT NOT NULL,
  "creatorProfileId" TEXT NOT NULL,
  "recipientUserId" TEXT NOT NULL,
  "brandPartyId" TEXT NOT NULL,
  "threadId" TEXT NOT NULL,
  "contentAuthorizationId" TEXT NOT NULL,
  "contentAuthorizedAt" TIMESTAMP(3) NOT NULL,
  "decisionRef" TEXT NOT NULL,
  "authorizedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMP(3),
  "summary" JSONB,
  "sourceFingerprint" TEXT,
  "evidenceAt" TIMESTAMP(3),
  "generatedAt" TIMESTAMP(3),
  "checkedAt" TIMESTAMP(3),
  "nextCheckAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseToken" TEXT,
  "leaseUntil" TIMESTAMP(3),
  "lastFailureClass" TEXT,
  "invocationId" TEXT,
  "providerId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "creator_brand_mail_shares_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "creator_brand_mail_shares_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "creator_brand_mail_shares_creator_fkey" FOREIGN KEY ("organizationId", "creatorProfileId") REFERENCES "creator_profiles"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "creator_brand_mail_shares_thread_fkey" FOREIGN KEY ("organizationId", "ownerUserId", "threadId") REFERENCES "work_threads"("organizationId", "userId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "creator_brand_mail_shares_lease_shape" CHECK (("leaseToken" IS NULL) = ("leaseUntil" IS NULL)),
  CONSTRAINT "creator_brand_mail_shares_revoked_shape" CHECK ("revokedAt" IS NULL OR ("summary" IS NULL AND "leaseToken" IS NULL AND "leaseUntil" IS NULL))
);
CREATE UNIQUE INDEX "creator_brand_mail_shares_owner_thread_key" ON "creator_brand_mail_shares"("organizationId", "ownerUserId", "threadId");
CREATE INDEX "creator_brand_mail_shares_due_idx" ON "creator_brand_mail_shares"("nextCheckAt", "leaseUntil");
CREATE INDEX "creator_brand_mail_shares_recipient_idx" ON "creator_brand_mail_shares"("organizationId", "creatorProfileId", "recipientUserId");
