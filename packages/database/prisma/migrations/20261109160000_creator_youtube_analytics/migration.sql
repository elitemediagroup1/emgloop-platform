CREATE TABLE "youtube_connections" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "creatorProfileId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "channelId" TEXT NOT NULL,
  "channelTitle" TEXT NOT NULL,
  "subscriberCount" TEXT,
  "lifetimeViewCount" TEXT,
  "videoCount" TEXT,
  "refreshTokenSealed" BYTEA,
  "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "status" TEXT NOT NULL DEFAULT 'CONNECTED',
  "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSyncedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  CONSTRAINT "youtube_connections_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "youtube_oauth_states" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "creatorProfileId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "stateHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "youtube_oauth_states_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "youtube_analytics_observations" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "creatorProfileId" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "report" JSONB NOT NULL,
  CONSTRAINT "youtube_analytics_observations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "youtube_connections_creatorProfileId_key" ON "youtube_connections"("creatorProfileId");
CREATE UNIQUE INDEX "youtube_connections_organizationId_id_key" ON "youtube_connections"("organizationId", "id");
CREATE UNIQUE INDEX "youtube_connections_organizationId_channelId_key" ON "youtube_connections"("organizationId", "channelId");
CREATE UNIQUE INDEX "youtube_oauth_states_stateHash_key" ON "youtube_oauth_states"("stateHash");
CREATE INDEX "youtube_oauth_states_organizationId_userId_sessionId_expiresAt_idx" ON "youtube_oauth_states"("organizationId", "userId", "sessionId", "expiresAt");
CREATE INDEX "youtube_analytics_observations_organizationId_creatorProfileId_observedAt_idx" ON "youtube_analytics_observations"("organizationId", "creatorProfileId", "observedAt");
ALTER TABLE "youtube_connections" ADD CONSTRAINT "youtube_connections_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "youtube_connections" ADD CONSTRAINT "youtube_connections_organizationId_creatorProfileId_fkey" FOREIGN KEY ("organizationId", "creatorProfileId") REFERENCES "creator_profiles"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "youtube_oauth_states" ADD CONSTRAINT "youtube_oauth_states_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "youtube_oauth_states" ADD CONSTRAINT "youtube_oauth_states_organizationId_creatorProfileId_fkey" FOREIGN KEY ("organizationId", "creatorProfileId") REFERENCES "creator_profiles"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "youtube_analytics_observations" ADD CONSTRAINT "youtube_analytics_observations_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "youtube_analytics_observations" ADD CONSTRAINT "youtube_analytics_observations_organizationId_creatorProfileId_fkey" FOREIGN KEY ("organizationId", "creatorProfileId") REFERENCES "creator_profiles"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "youtube_analytics_observations" ADD CONSTRAINT "youtube_analytics_observations_organizationId_connectionId_fkey" FOREIGN KEY ("organizationId", "connectionId") REFERENCES "youtube_connections"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
