-- CreateTable
CREATE TABLE "source_baseline_checkpoints" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "windowDays" INTEGER NOT NULL,
    "windowFloorAt" TIMESTAMP(3) NOT NULL,
    "consentAt" TIMESTAMP(3) NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'NOT_STARTED',
    "checkpointCursor" TEXT,
    "oldestReachedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3),
    "lastFailureClass" TEXT,
    "backoffUntil" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "source_baseline_checkpoints_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "source_baseline_checkpoints_state_lastRunAt_idx" ON "source_baseline_checkpoints"("state", "lastRunAt");

-- CreateIndex
CREATE UNIQUE INDEX "source_baseline_checkpoints_organizationId_userId_provider_key" ON "source_baseline_checkpoints"("organizationId", "userId", "provider");

-- AddForeignKey
ALTER TABLE "source_baseline_checkpoints" ADD CONSTRAINT "source_baseline_checkpoints_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_baseline_checkpoints" ADD CONSTRAINT "source_baseline_checkpoints_userId_organizationId_fkey" FOREIGN KEY ("userId", "organizationId") REFERENCES "organization_memberships"("userId", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

