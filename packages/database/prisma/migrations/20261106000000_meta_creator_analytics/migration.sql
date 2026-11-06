-- CreateTable
CREATE TABLE "meta_oauth_states" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "creatorProfileId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "stateHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "tokenSealed" BYTEA,
    "metaUserId" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "meta_oauth_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meta_connections" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "creatorProfileId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "metaUserId" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "activePageId" TEXT,
    "instagramId" TEXT,
    "pageName" TEXT NOT NULL,
    "tokenSealed" BYTEA,
    "tokenExpiresAt" TIMESTAMP(3) NOT NULL,
    "scopes" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'CONNECTED',
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAttemptAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "nextSyncAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseUntil" TIMESTAMP(3),
    "leaseId" TEXT,
    "lastFailure" TEXT,
    "analysisNextAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "analysisLeaseId" TEXT,
    "analysisLeaseUntil" TIMESTAMP(3),
    "analysisFailure" TEXT,

    CONSTRAINT "meta_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meta_analytics_observations" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "creatorProfileId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "report" JSONB NOT NULL,

    CONSTRAINT "meta_analytics_observations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meta_analytics_readings" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "creatorProfileId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "sourceFingerprint" TEXT NOT NULL,
    "observationIds" TEXT[],
    "reading" JSONB NOT NULL,
    "invocationId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meta_analytics_readings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "meta_oauth_states_stateHash_key" ON "meta_oauth_states"("stateHash");

-- CreateIndex
CREATE INDEX "meta_oauth_states_organizationId_userId_sessionId_idx" ON "meta_oauth_states"("organizationId", "userId", "sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "meta_connections_creatorProfileId_key" ON "meta_connections"("creatorProfileId");

-- CreateIndex
CREATE INDEX "meta_connections_status_nextSyncAt_idx" ON "meta_connections"("status", "nextSyncAt");

-- CreateIndex
CREATE UNIQUE INDEX "meta_connections_organizationId_id_key" ON "meta_connections"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "meta_connections_organizationId_creatorProfileId_key" ON "meta_connections"("organizationId", "creatorProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "meta_connections_organizationId_activePageId_key" ON "meta_connections"("organizationId", "activePageId");

-- CreateIndex
CREATE INDEX "meta_analytics_observations_organizationId_creatorProfileId_idx" ON "meta_analytics_observations"("organizationId", "creatorProfileId", "platform", "observedAt");

-- CreateIndex
CREATE INDEX "meta_analytics_readings_organizationId_creatorProfileId_obs_idx" ON "meta_analytics_readings"("organizationId", "creatorProfileId", "observedAt");

-- CreateIndex
CREATE UNIQUE INDEX "meta_analytics_readings_organizationId_connectionId_sourceF_key" ON "meta_analytics_readings"("organizationId", "connectionId", "sourceFingerprint");

-- AddForeignKey
ALTER TABLE "meta_oauth_states" ADD CONSTRAINT "meta_oauth_states_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meta_oauth_states" ADD CONSTRAINT "meta_oauth_states_organizationId_creatorProfileId_fkey" FOREIGN KEY ("organizationId", "creatorProfileId") REFERENCES "creator_profiles"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meta_connections" ADD CONSTRAINT "meta_connections_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meta_connections" ADD CONSTRAINT "meta_connections_organizationId_creatorProfileId_fkey" FOREIGN KEY ("organizationId", "creatorProfileId") REFERENCES "creator_profiles"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meta_analytics_observations" ADD CONSTRAINT "meta_analytics_observations_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meta_analytics_observations" ADD CONSTRAINT "meta_analytics_observations_organizationId_creatorProfileI_fkey" FOREIGN KEY ("organizationId", "creatorProfileId") REFERENCES "creator_profiles"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meta_analytics_observations" ADD CONSTRAINT "meta_analytics_observations_organizationId_connectionId_fkey" FOREIGN KEY ("organizationId", "connectionId") REFERENCES "meta_connections"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meta_analytics_readings" ADD CONSTRAINT "meta_analytics_readings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meta_analytics_readings" ADD CONSTRAINT "meta_analytics_readings_organizationId_creatorProfileId_fkey" FOREIGN KEY ("organizationId", "creatorProfileId") REFERENCES "creator_profiles"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meta_analytics_readings" ADD CONSTRAINT "meta_analytics_readings_organizationId_connectionId_fkey" FOREIGN KEY ("organizationId", "connectionId") REFERENCES "meta_connections"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

