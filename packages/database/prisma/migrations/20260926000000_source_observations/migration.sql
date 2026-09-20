-- CreateTable
CREATE TABLE "source_observations" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "conversationKey" TEXT NOT NULL,
    "senderKey" TEXT,
    "participantKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "direction" TEXT NOT NULL,
    "hadText" BOOLEAN NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "source_observations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "source_observations_organizationId_userId_provider_occurred_idx" ON "source_observations"("organizationId", "userId", "provider", "occurredAt");

-- CreateIndex
CREATE INDEX "source_observations_observedAt_idx" ON "source_observations"("observedAt");

-- CreateIndex
CREATE UNIQUE INDEX "source_observations_organizationId_userId_provider_provider_key" ON "source_observations"("organizationId", "userId", "provider", "providerEventId");

-- AddForeignKey
ALTER TABLE "source_observations" ADD CONSTRAINT "source_observations_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_observations" ADD CONSTRAINT "source_observations_userId_organizationId_fkey" FOREIGN KEY ("userId", "organizationId") REFERENCES "organization_memberships"("userId", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

