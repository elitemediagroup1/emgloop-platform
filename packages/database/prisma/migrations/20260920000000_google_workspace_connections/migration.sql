-- Google Workspace connection, Private V1 (google-workspace-connection.md section 11).
--
-- ADDITIVE ONLY. Two new tables, their indexes, foreign keys and CHECK constraints.
-- Zero DROP, zero rename, zero column-type change, zero UPDATE/DELETE/INSERT, zero
-- backfill. No existing row is read, written or moved; after this migration both tables
-- are empty and every existing code path behaves exactly as before.
--
-- ASCII ONLY, like every migration since PR #152.
--
-- ================== WHAT THIS ADDS ==================
--
-- google_connections    one Google connection per Loop user per organization: the
--                       Google account (sub), the capability scopes asked for and
--                       granted, the lifecycle, and the SEALED refresh token
-- google_oauth_states   one connect attempt: the hashed OAuth state and nonce, bound to
--                       organization, user and browser session; single-use; ten minutes
--
-- ================== WHAT THE DATABASE ITSELF ENFORCES ==================
--
-- - A connection and an attempt belong to a MEMBERSHIP (composite foreign key onto
--   organization_memberships), so neither can be filed under another organization.
-- - One connection per (organization, user); one live link per (organization, Google
--   account) -- activeGoogleSubject is NULL once revoked, and NULLs never collide.
-- - The sealed refresh token exists exactly while the connection is CONNECTED, and its
--   format and key reference travel with it. Revoked and expired rows hold no credential.
-- - Only the three approved capability scopes can ever be recorded:
--     gmail.metadata, calendar.events.readonly, drive.metadata.readonly.
--   A broader scope cannot be stored even by a caller that bypassed the contract.
-- - Only hashes of the state and nonce are stored.
--
-- The encryption key is NOT in the database: it is a server-only environment secret of
-- the web tier (LOOP_GOOGLE_TOKEN_KEY). Nothing in this migration holds a secret.

-- CreateTable
CREATE TABLE "google_connections" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "googleSubject" TEXT NOT NULL,
    "activeGoogleSubject" TEXT,
    "emailAtLink" TEXT NOT NULL,
    "hostedDomain" TEXT,
    "status" TEXT NOT NULL,
    "grantedScopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "requestedScopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "refreshTokenSealed" BYTEA,
    "sealVersion" TEXT,
    "keyRef" TEXT,
    "connectedAt" TIMESTAMP(3) NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "expiredAt" TIMESTAMP(3),
    "lastFailureClass" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokedByUserId" TEXT,
    "revocationReason" TEXT,
    "revocationConfirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "google_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "google_oauth_states" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "stateHash" TEXT NOT NULL,
    "nonceHash" TEXT NOT NULL,
    "capabilities" TEXT[],
    "returnTo" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "google_oauth_states_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "google_connections_organizationId_userId_key" ON "google_connections"("organizationId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "google_connections_organizationId_activeGoogleSubject_key" ON "google_connections"("organizationId", "activeGoogleSubject");

-- CreateIndex
CREATE UNIQUE INDEX "google_oauth_states_stateHash_key" ON "google_oauth_states"("stateHash");

-- CreateIndex
CREATE INDEX "google_oauth_states_organizationId_userId_expiresAt_idx" ON "google_oauth_states"("organizationId", "userId", "expiresAt");

-- AddForeignKey
ALTER TABLE "google_connections" ADD CONSTRAINT "google_connections_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "google_connections" ADD CONSTRAINT "google_connections_userId_organizationId_fkey" FOREIGN KEY ("userId", "organizationId") REFERENCES "organization_memberships"("userId", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "google_connections" ADD CONSTRAINT "google_connections_revokedByUserId_fkey" FOREIGN KEY ("revokedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "google_oauth_states" ADD CONSTRAINT "google_oauth_states_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "google_oauth_states" ADD CONSTRAINT "google_oauth_states_userId_organizationId_fkey" FOREIGN KEY ("userId", "organizationId") REFERENCES "organization_memberships"("userId", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "google_oauth_states" ADD CONSTRAINT "google_oauth_states_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "user_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ================== CHECK CONSTRAINTS ==================

-- CheckConstraint
ALTER TABLE "google_connections" ADD CONSTRAINT "google_connections_status_check"
  CHECK ("status" IN ('CONNECTED', 'EXPIRED', 'REVOKED'));

-- CheckConstraint: the credential exists exactly while CONNECTED, with its format and key.
ALTER TABLE "google_connections" ADD CONSTRAINT "google_connections_credential_check"
  CHECK (
    (("status" = 'CONNECTED') = ("refreshTokenSealed" IS NOT NULL))
    AND (("refreshTokenSealed" IS NULL) = ("sealVersion" IS NULL))
    AND (("refreshTokenSealed" IS NULL) = ("keyRef" IS NULL))
    AND ("refreshTokenSealed" IS NULL OR octet_length("refreshTokenSealed") BETWEEN 33 AND 8192)
  );

-- CheckConstraint: the live link is the linked account, and exists exactly while not revoked.
ALTER TABLE "google_connections" ADD CONSTRAINT "google_connections_active_subject_check"
  CHECK (
    (("status" = 'REVOKED') = ("activeGoogleSubject" IS NULL))
    AND ("activeGoogleSubject" IS NULL OR "activeGoogleSubject" = "googleSubject")
    AND length("googleSubject") BETWEEN 1 AND 255
  );

-- CheckConstraint: a revocation always records when and why; nothing else does.
ALTER TABLE "google_connections" ADD CONSTRAINT "google_connections_revocation_check"
  CHECK (
    (("status" = 'REVOKED') = ("revokedAt" IS NOT NULL))
    AND (("revokedAt" IS NULL) = ("revocationReason" IS NULL))
    AND ("revocationReason" IS NULL OR "revocationReason" IN ('SELF_DISCONNECT', 'CAPABILITY_REMOVED', 'MEMBER_DISABLED', 'MEMBER_REMOVED'))
    AND ("revocationConfirmedAt" IS NULL OR "revokedAt" IS NOT NULL)
    AND (("status" = 'EXPIRED') = ("expiredAt" IS NOT NULL))
  );

-- CheckConstraint: failure CLASSES only, never provider text.
ALTER TABLE "google_connections" ADD CONSTRAINT "google_connections_failure_class_check"
  CHECK ("lastFailureClass" IS NULL OR "lastFailureClass" IN ('REFRESH_REFUSED', 'REVOKE_UNCONFIRMED', 'REVOKE_SKIPPED_SHARED_GRANT', 'TOKEN_UNOPENABLE'));

-- CheckConstraint: the approved capability scopes and nothing else.
ALTER TABLE "google_connections" ADD CONSTRAINT "google_connections_scopes_check"
  CHECK (
    "grantedScopes" IS NOT NULL
    AND "requestedScopes" IS NOT NULL
    AND "grantedScopes" <@ ARRAY[
      'https://www.googleapis.com/auth/gmail.metadata',
      'https://www.googleapis.com/auth/calendar.events.readonly',
      'https://www.googleapis.com/auth/drive.metadata.readonly'
    ]::TEXT[]
    AND "requestedScopes" <@ ARRAY[
      'https://www.googleapis.com/auth/gmail.metadata',
      'https://www.googleapis.com/auth/calendar.events.readonly',
      'https://www.googleapis.com/auth/drive.metadata.readonly'
    ]::TEXT[]
  );

-- CheckConstraint: an attempt asks for one to three known capabilities.
ALTER TABLE "google_oauth_states" ADD CONSTRAINT "google_oauth_states_capabilities_check"
  CHECK (
    "capabilities" IS NOT NULL
    AND cardinality("capabilities") BETWEEN 1 AND 3
    AND "capabilities" <@ ARRAY['gmail', 'calendar', 'drive']::TEXT[]
  );

-- CheckConstraint: hashes only, a known return target, a real expiry.
ALTER TABLE "google_oauth_states" ADD CONSTRAINT "google_oauth_states_shape_check"
  CHECK (
    "stateHash" ~ '^[0-9a-f]{64}$'
    AND "nonceHash" ~ '^[0-9a-f]{64}$'
    AND "returnTo" IN ('ONBOARDING', 'CONNECTIONS')
    AND "expiresAt" > "createdAt"
    AND ("consumedAt" IS NULL OR "consumedAt" >= "createdAt")
  );
