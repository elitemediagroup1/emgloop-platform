-- CreateTable
CREATE TABLE "managed_creator_mail_captures" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "creatorProfileId" TEXT NOT NULL,
    "recipientUserId" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "mailboxId" TEXT NOT NULL,
    "mailboxRevision" TEXT NOT NULL,
    "scopeHash" TEXT NOT NULL,
    "generation" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "cycleStartedAt" TIMESTAMP(3) NOT NULL,
    "query" TEXT NOT NULL,
    "pendingThreadIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "nextPageToken" TEXT,
    "listedCount" INTEGER NOT NULL DEFAULT 0,
    "searchComplete" BOOLEAN NOT NULL DEFAULT false,
    "capped" BOOLEAN NOT NULL DEFAULT false,
    "readings" JSONB NOT NULL DEFAULT '[]',
    "lastCheckedAt" TIMESTAMP(3),
    "lastFailureClass" TEXT,
    "nextCheckAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "managed_creator_mail_captures_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "managed_creator_mail_captures_nextCheckAt_leaseUntil_idx" ON "managed_creator_mail_captures"("nextCheckAt", "leaseUntil");

-- CreateIndex
CREATE UNIQUE INDEX "managed_creator_mail_captures_organizationId_creatorProfile_key" ON "managed_creator_mail_captures"("organizationId", "creatorProfileId", "mailboxId");

-- AddForeignKey
ALTER TABLE "managed_creator_mail_captures" ADD CONSTRAINT "managed_creator_mail_captures_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "managed_creator_mail_captures" ADD CONSTRAINT "managed_creator_mail_captures_organizationId_creatorProfil_fkey" FOREIGN KEY ("organizationId", "creatorProfileId") REFERENCES "creator_profiles"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "managed_creator_mail_captures" ADD CONSTRAINT "managed_creator_mail_captures_organizationId_mailboxId_fkey" FOREIGN KEY ("organizationId", "mailboxId") REFERENCES "managed_google_mailboxes"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "managed_creator_mail_captures" ADD CONSTRAINT "managed_creator_mail_captures_ownerUserId_organizationId_fkey" FOREIGN KEY ("ownerUserId", "organizationId") REFERENCES "organization_memberships"("userId", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "managed_creator_mail_captures" ADD CONSTRAINT "managed_creator_mail_captures_recipientUserId_organization_fkey" FOREIGN KEY ("recipientUserId", "organizationId") REFERENCES "organization_memberships"("userId", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "managed_creator_mail_captures" ADD CONSTRAINT "creator_capture_lease_shape" CHECK (("leaseToken" IS NULL) = ("leaseUntil" IS NULL));
ALTER TABLE "managed_creator_mail_captures" ADD CONSTRAINT "creator_capture_bounds" CHECK (
  "listedCount" BETWEEN 0 AND 100 AND cardinality("pendingThreadIds") <= 100
  AND jsonb_typeof("readings") = 'array' AND jsonb_array_length("readings") <= 100
  AND length("query") BETWEEN 1 AND 1500
);
ALTER TABLE "managed_creator_mail_captures" ADD CONSTRAINT "creator_capture_pause_shape" CHECK ("enabled" OR ("leaseToken" IS NULL AND "leaseUntil" IS NULL AND "readings" = '[]'::jsonb));
