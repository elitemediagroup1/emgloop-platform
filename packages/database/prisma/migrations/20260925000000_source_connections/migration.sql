-- CreateTable
CREATE TABLE "source_connections" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "adapter" TEXT,
    "state" TEXT NOT NULL DEFAULT 'NOT_CONNECTED',
    "credentialKind" TEXT,
    "secretSealed" BYTEA,
    "sealVersion" TEXT,
    "keyRef" TEXT,
    "accountLabel" TEXT,
    "backgroundObservation" TEXT NOT NULL DEFAULT 'UNAVAILABLE',
    "cursor" TEXT,
    "lastFailureClass" TEXT,
    "connectingStartedAt" TIMESTAMP(3),
    "connectedAt" TIMESTAMP(3),
    "lastObservedAt" TIMESTAMP(3),
    "reconnectRequiredAt" TIMESTAMP(3),
    "disconnectedAt" TIMESTAMP(3),
    "disconnectedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "source_connections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "source_connections_organizationId_state_idx" ON "source_connections"("organizationId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "source_connections_organizationId_userId_provider_key" ON "source_connections"("organizationId", "userId", "provider");

-- AddForeignKey
ALTER TABLE "source_connections" ADD CONSTRAINT "source_connections_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_connections" ADD CONSTRAINT "source_connections_userId_organizationId_fkey" FOREIGN KEY ("userId", "organizationId") REFERENCES "organization_memberships"("userId", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_connections" ADD CONSTRAINT "source_connections_disconnectedByUserId_fkey" FOREIGN KEY ("disconnectedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

