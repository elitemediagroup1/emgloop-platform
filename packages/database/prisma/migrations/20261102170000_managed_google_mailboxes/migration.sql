-- CreateTable
CREATE TABLE "managed_google_mailboxes" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "creatorProfileId" TEXT,
    "authorizedByUserId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "expectedEmail" TEXT NOT NULL,
    "googleSubject" TEXT,
    "activeGoogleSubject" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "grantedScopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "refreshTokenSealed" BYTEA,
    "sealVersion" TEXT,
    "keyRef" TEXT,
    "revision" TEXT NOT NULL,
    "connectedAt" TIMESTAMP(3),
    "disconnectedAt" TIMESTAMP(3),
    "lastFailureClass" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "managed_google_mailboxes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "managed_google_oauth_states" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "mailboxId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "stateHash" TEXT NOT NULL,
    "nonceHash" TEXT NOT NULL,
    "expectedEmail" TEXT NOT NULL,
    "revision" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "managed_google_oauth_states_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "managed_google_mailboxes_organizationId_id_key" ON "managed_google_mailboxes"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "managed_google_mailboxes_organizationId_expectedEmail_key" ON "managed_google_mailboxes"("organizationId", "expectedEmail");

-- CreateIndex
CREATE UNIQUE INDEX "managed_google_mailboxes_organizationId_creatorProfileId_key" ON "managed_google_mailboxes"("organizationId", "creatorProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "managed_google_mailboxes_organizationId_activeGoogleSubject_key" ON "managed_google_mailboxes"("organizationId", "activeGoogleSubject");

-- CreateIndex
CREATE UNIQUE INDEX "managed_google_oauth_states_stateHash_key" ON "managed_google_oauth_states"("stateHash");

-- CreateIndex
CREATE INDEX "managed_google_oauth_states_organizationId_userId_expiresAt_idx" ON "managed_google_oauth_states"("organizationId", "userId", "expiresAt");

-- AddForeignKey
ALTER TABLE "managed_google_mailboxes" ADD CONSTRAINT "managed_google_mailboxes_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "managed_google_mailboxes" ADD CONSTRAINT "managed_google_mailboxes_organizationId_creatorProfileId_fkey" FOREIGN KEY ("organizationId", "creatorProfileId") REFERENCES "creator_profiles"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "managed_google_mailboxes" ADD CONSTRAINT "managed_google_mailboxes_authorizedByUserId_organizationId_fkey" FOREIGN KEY ("authorizedByUserId", "organizationId") REFERENCES "organization_memberships"("userId", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "managed_google_oauth_states" ADD CONSTRAINT "managed_google_oauth_states_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "managed_google_oauth_states" ADD CONSTRAINT "managed_google_oauth_states_organizationId_mailboxId_fkey" FOREIGN KEY ("organizationId", "mailboxId") REFERENCES "managed_google_mailboxes"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "managed_google_oauth_states" ADD CONSTRAINT "managed_google_oauth_states_userId_organizationId_fkey" FOREIGN KEY ("userId", "organizationId") REFERENCES "organization_memberships"("userId", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
CREATE UNIQUE INDEX "user_sessions_organizationId_userId_id_key" ON "user_sessions"("organizationId", "userId", "id");
ALTER TABLE "managed_google_oauth_states" ADD CONSTRAINT "managed_google_oauth_states_organizationId_userId_sessionId_fkey" FOREIGN KEY ("organizationId", "userId", "sessionId") REFERENCES "user_sessions"("organizationId", "userId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Capture scope and credential lifecycle are enforced independently of request code.
ALTER TABLE "managed_google_mailboxes" ADD CONSTRAINT "managed_mailbox_kind_shape" CHECK (
  ("kind" = 'STAFF' AND "creatorProfileId" IS NULL) OR ("kind" = 'CREATOR' AND "creatorProfileId" IS NOT NULL)
);
ALTER TABLE "managed_google_mailboxes" ADD CONSTRAINT "managed_mailbox_status" CHECK ("status" IN ('PENDING', 'CONNECTED', 'EXPIRED', 'DISCONNECTED'));
ALTER TABLE "managed_google_mailboxes" ADD CONSTRAINT "managed_mailbox_seal_shape" CHECK (
  ("status" = 'CONNECTED' AND "refreshTokenSealed" IS NOT NULL AND "sealVersion" IS NOT NULL AND "keyRef" IS NOT NULL AND "googleSubject" IS NOT NULL AND "activeGoogleSubject" = "googleSubject" AND "activeGoogleSubject" IS NOT NULL)
  OR ("status" <> 'CONNECTED' AND "refreshTokenSealed" IS NULL AND "sealVersion" IS NULL AND "keyRef" IS NULL)
);
ALTER TABLE "managed_google_mailboxes" ADD CONSTRAINT "managed_mailbox_email_normalized" CHECK ("expectedEmail" = lower(trim("expectedEmail")));
ALTER TABLE "managed_google_mailboxes" ADD CONSTRAINT "managed_mailbox_scope_shape" CHECK (
  "grantedScopes" IS NOT NULL AND "grantedScopes" <@ ARRAY['https://www.googleapis.com/auth/gmail.readonly']::text[]
  AND ("status" <> 'CONNECTED' OR "grantedScopes" = ARRAY['https://www.googleapis.com/auth/gmail.readonly']::text[])
);
