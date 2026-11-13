-- CreateTable
CREATE TABLE "tiktok_business_connections" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "creatorProfileId" TEXT,
    "externalId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DISCONNECTED',
    "tokenSealed" BYTEA,
    "connectedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revision" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "tiktok_business_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tiktok_business_oauth_states" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "creatorProfileId" TEXT,
    "connectionRevision" INTEGER NOT NULL,
    "stateHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "tiktok_business_oauth_states_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tiktok_business_connections_organizationId_userId_kind_key" ON "tiktok_business_connections"("organizationId", "userId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "tiktok_business_oauth_states_stateHash_key" ON "tiktok_business_oauth_states"("stateHash");

-- CreateIndex
CREATE INDEX "tiktok_business_oauth_states_organizationId_userId_expiresA_idx" ON "tiktok_business_oauth_states"("organizationId", "userId", "expiresAt");

-- AddForeignKey
ALTER TABLE "tiktok_business_connections" ADD CONSTRAINT "tiktok_business_connections_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tiktok_business_connections" ADD CONSTRAINT "tiktok_business_connections_userId_organizationId_fkey" FOREIGN KEY ("userId", "organizationId") REFERENCES "organization_memberships"("userId", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tiktok_business_oauth_states" ADD CONSTRAINT "tiktok_business_oauth_states_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tiktok_business_oauth_states" ADD CONSTRAINT "tiktok_business_oauth_states_userId_organizationId_fkey" FOREIGN KEY ("userId", "organizationId") REFERENCES "organization_memberships"("userId", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tiktok_business_oauth_states" ADD CONSTRAINT "tiktok_business_oauth_states_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "user_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

