-- AlterTable
ALTER TABLE "tiktok_business_connections" ADD COLUMN     "importEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "ttoAccountId" TEXT;

-- CreateTable
CREATE TABLE "tto_creator_snapshots" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "creatorProfileId" TEXT NOT NULL,
    "connectionId" TEXT,
    "sourceRevision" INTEGER,
    "handle" TEXT,
    "report" JSONB NOT NULL DEFAULT '{}',
    "lastReadAt" TIMESTAMP(3),
    "lastAttemptAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastFailure" TEXT,
    "leaseId" TEXT,
    "leaseUntil" TIMESTAMP(3),

    CONSTRAINT "tto_creator_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tto_creator_snapshots_nextAttemptAt_idx" ON "tto_creator_snapshots"("nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "tto_creator_snapshots_organizationId_creatorProfileId_key" ON "tto_creator_snapshots"("organizationId", "creatorProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "tiktok_business_connections_organizationId_id_key" ON "tiktok_business_connections"("organizationId", "id");

-- AddForeignKey
ALTER TABLE "tto_creator_snapshots" ADD CONSTRAINT "tto_creator_snapshots_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tto_creator_snapshots" ADD CONSTRAINT "tto_creator_snapshots_organizationId_creatorProfileId_fkey" FOREIGN KEY ("organizationId", "creatorProfileId") REFERENCES "creator_profiles"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tto_creator_snapshots" ADD CONSTRAINT "tto_creator_snapshots_organizationId_connectionId_fkey" FOREIGN KEY ("organizationId", "connectionId") REFERENCES "tiktok_business_connections"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

