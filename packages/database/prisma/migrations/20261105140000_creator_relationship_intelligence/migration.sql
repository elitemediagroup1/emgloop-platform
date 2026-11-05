CREATE TABLE "creator_mail_evidence" (
 "id" TEXT PRIMARY KEY, "captureId" TEXT NOT NULL REFERENCES "managed_creator_mail_captures"("id") ON DELETE CASCADE,
 "generation" TEXT NOT NULL, "threadId" TEXT NOT NULL, "reading" JSONB NOT NULL, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE ("captureId", "generation", "threadId")
);
-- Preserve all existing minimized readings before the rolling cache can evict them.
INSERT INTO "creator_mail_evidence" ("id", "captureId", "generation", "threadId", "reading")
 SELECT c."id" || ':' || c."generation" || ':' || (r->>'threadId'), c."id", c."generation", r->>'threadId', r
 FROM "managed_creator_mail_captures" c CROSS JOIN LATERAL jsonb_array_elements(c."readings") r
 WHERE c."enabled" AND r->>'threadId' IS NOT NULL ON CONFLICT DO NOTHING;
CREATE TABLE "creator_mail_relationships" (
 "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL, "creatorProfileId" TEXT NOT NULL,
 "brandId" TEXT NOT NULL, "fingerprint" TEXT NOT NULL, "processed" INTEGER NOT NULL DEFAULT 0,
 "update" JSONB, "history" JSONB NOT NULL DEFAULT '[]', "generatedAt" TIMESTAMP(3),
 "nextCheckAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "leaseToken" TEXT, "leaseUntil" TIMESTAMP(3),
 "lastFailureClass" TEXT, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE ("organizationId", "creatorProfileId", "brandId"),
 FOREIGN KEY ("organizationId", "creatorProfileId") REFERENCES "creator_profiles"("organizationId", "id") ON DELETE CASCADE
);

ALTER TABLE "managed_creator_mail_captures"
 ADD COLUMN "refreshSearchComplete" BOOLEAN NOT NULL DEFAULT false,
 ADD COLUMN "refreshActive" BOOLEAN NOT NULL DEFAULT false,
 ADD COLUMN "refreshPendingThreadIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
 ADD COLUMN "refreshNextPageToken" TEXT,
 ADD COLUMN "refreshStartedAt" TIMESTAMP(3),
 ADD COLUMN "lastRefreshAt" TIMESTAMP(3),
 ADD COLUMN "morningKey" TEXT;

-- Prior code-only retention increases never updated the deployed original 100-row CHECK.
ALTER TABLE "managed_creator_mail_captures" DROP CONSTRAINT "creator_capture_bounds";
ALTER TABLE "managed_creator_mail_captures" ADD CONSTRAINT "creator_capture_bounds" CHECK (
 "listedCount" BETWEEN 0 AND 599 AND cardinality("pendingThreadIds") <= 100
 AND jsonb_typeof("readings") = 'array' AND jsonb_array_length("readings") <= 2000
 AND cardinality("refreshPendingThreadIds") <= 100
 AND length("query") BETWEEN 1 AND 1500
);
