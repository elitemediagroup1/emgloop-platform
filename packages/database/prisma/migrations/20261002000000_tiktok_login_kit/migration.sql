-- TikTok Login Kit connection for the Creator Hub (2026-09-24).
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
-- tiktok_connections    one TikTok connection per Loop user per organization: the TikTok
--                       account (open_id), the four scopes asked for and granted, the
--                       lifecycle, and the SEALED refresh and access tokens
-- tiktok_oauth_states   one connect attempt: the hashed OAuth state, bound to organization,
--                       user and browser session; single-use; ten minutes
--
-- It is the TikTok sibling of google_connections / google_oauth_states (migration
-- 20260917172545) and follows the same discipline. It does NOT fork a second framework.
--
-- ================== WHAT THE DATABASE ITSELF ENFORCES ==================
--
-- - A connection and an attempt belong to a MEMBERSHIP (composite foreign key onto
--   organization_memberships), so neither can be filed under another organization.
-- - One connection per (organization, user); one live link per (organization, TikTok
--   account) -- activeTiktokOpenId is NULL once revoked, and NULLs never collide.
-- - The sealed refresh token exists exactly while the connection is CONNECTED; the sealed
--   access token and its expiry travel with it, and the seal format and key reference with
--   both. Revoked and expired rows hold no credential.
-- - Only the four registered scopes can ever be recorded:
--     user.info.basic, user.info.profile, user.info.stats, video.list.
--   A broader scope cannot be stored even by a caller that bypassed the contract.
-- - Only the hash of the state is stored.
--
-- The encryption key is NOT in the database: it is a server-only environment secret of
-- the web tier (LOOP_TIKTOK_TOKEN_KEY). Nothing in this migration holds a secret.

-- CreateTable
CREATE TABLE "tiktok_connections" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tiktokOpenId" TEXT NOT NULL,
    "activeTiktokOpenId" TEXT,
    "handleAtLink" TEXT,
    "status" TEXT NOT NULL,
    "grantedScopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "requestedScopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "refreshTokenSealed" BYTEA,
    "accessTokenSealed" BYTEA,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "sealVersion" TEXT,
    "keyRef" TEXT,
    "connectedAt" TIMESTAMP(3) NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "lastReadAt" TIMESTAMP(3),
    "expiredAt" TIMESTAMP(3),
    "lastFailureClass" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokedByUserId" TEXT,
    "revocationReason" TEXT,
    "revocationConfirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tiktok_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tiktok_oauth_states" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "stateHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tiktok_oauth_states_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tiktok_connections_organizationId_userId_key" ON "tiktok_connections"("organizationId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "tiktok_connections_organizationId_activeTiktokOpenId_key" ON "tiktok_connections"("organizationId", "activeTiktokOpenId");

-- CreateIndex
CREATE UNIQUE INDEX "tiktok_oauth_states_stateHash_key" ON "tiktok_oauth_states"("stateHash");

-- CreateIndex
CREATE INDEX "tiktok_oauth_states_organizationId_userId_expiresAt_idx" ON "tiktok_oauth_states"("organizationId", "userId", "expiresAt");

-- AddForeignKey
ALTER TABLE "tiktok_connections" ADD CONSTRAINT "tiktok_connections_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tiktok_connections" ADD CONSTRAINT "tiktok_connections_userId_organizationId_fkey" FOREIGN KEY ("userId", "organizationId") REFERENCES "organization_memberships"("userId", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tiktok_connections" ADD CONSTRAINT "tiktok_connections_revokedByUserId_fkey" FOREIGN KEY ("revokedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tiktok_oauth_states" ADD CONSTRAINT "tiktok_oauth_states_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tiktok_oauth_states" ADD CONSTRAINT "tiktok_oauth_states_userId_organizationId_fkey" FOREIGN KEY ("userId", "organizationId") REFERENCES "organization_memberships"("userId", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tiktok_oauth_states" ADD CONSTRAINT "tiktok_oauth_states_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "user_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ================== CHECK CONSTRAINTS ==================

-- CheckConstraint
ALTER TABLE "tiktok_connections" ADD CONSTRAINT "tiktok_connections_status_check"
  CHECK ("status" IN ('CONNECTED', 'EXPIRED', 'REVOKED'));

-- CheckConstraint: the credential exists exactly while CONNECTED, with its format and key;
-- the access token and its expiry travel with the refresh token.
ALTER TABLE "tiktok_connections" ADD CONSTRAINT "tiktok_connections_credential_check"
  CHECK (
    (("status" = 'CONNECTED') = ("refreshTokenSealed" IS NOT NULL))
    AND (("refreshTokenSealed" IS NULL) = ("accessTokenSealed" IS NULL))
    AND (("refreshTokenSealed" IS NULL) = ("accessTokenExpiresAt" IS NULL))
    AND (("refreshTokenSealed" IS NULL) = ("sealVersion" IS NULL))
    AND (("refreshTokenSealed" IS NULL) = ("keyRef" IS NULL))
    AND ("refreshTokenSealed" IS NULL OR octet_length("refreshTokenSealed") BETWEEN 33 AND 8192)
    AND ("accessTokenSealed" IS NULL OR octet_length("accessTokenSealed") BETWEEN 33 AND 8192)
  );

-- CheckConstraint: the live link is the linked account, and exists exactly while not revoked.
ALTER TABLE "tiktok_connections" ADD CONSTRAINT "tiktok_connections_active_open_id_check"
  CHECK (
    (("status" = 'REVOKED') = ("activeTiktokOpenId" IS NULL))
    AND ("activeTiktokOpenId" IS NULL OR "activeTiktokOpenId" = "tiktokOpenId")
    AND length("tiktokOpenId") BETWEEN 1 AND 255
  );

-- CheckConstraint: a revocation always records when and why; nothing else does.
ALTER TABLE "tiktok_connections" ADD CONSTRAINT "tiktok_connections_revocation_check"
  CHECK (
    (("status" = 'REVOKED') = ("revokedAt" IS NOT NULL))
    AND (("revokedAt" IS NULL) = ("revocationReason" IS NULL))
    AND ("revocationReason" IS NULL OR "revocationReason" IN ('SELF_DISCONNECT', 'MEMBER_DISABLED', 'MEMBER_REMOVED'))
    AND ("revocationConfirmedAt" IS NULL OR "revokedAt" IS NOT NULL)
    AND (("status" = 'EXPIRED') = ("expiredAt" IS NOT NULL))
  );

-- CheckConstraint: failure CLASSES only, never provider text.
ALTER TABLE "tiktok_connections" ADD CONSTRAINT "tiktok_connections_failure_class_check"
  CHECK ("lastFailureClass" IS NULL OR "lastFailureClass" IN ('REFRESH_REFUSED', 'REVOKE_UNCONFIRMED', 'REVOKE_SKIPPED_SHARED_GRANT', 'TOKEN_UNOPENABLE', 'READ_UNAVAILABLE', 'READ_FORBIDDEN'));

-- CheckConstraint: the four registered scopes and nothing else.
ALTER TABLE "tiktok_connections" ADD CONSTRAINT "tiktok_connections_scopes_check"
  CHECK (
    "grantedScopes" IS NOT NULL
    AND "requestedScopes" IS NOT NULL
    AND "grantedScopes" <@ ARRAY['user.info.basic', 'user.info.profile', 'user.info.stats', 'video.list']::TEXT[]
    AND "requestedScopes" <@ ARRAY['user.info.basic', 'user.info.profile', 'user.info.stats', 'video.list']::TEXT[]
  );

-- CheckConstraint: a hash only, a real expiry.
ALTER TABLE "tiktok_oauth_states" ADD CONSTRAINT "tiktok_oauth_states_shape_check"
  CHECK (
    "stateHash" ~ '^[0-9a-f]{64}$'
    AND "expiresAt" > "createdAt"
    AND ("consumedAt" IS NULL OR "consumedAt" >= "createdAt")
  );
