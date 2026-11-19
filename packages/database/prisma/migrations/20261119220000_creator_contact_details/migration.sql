CREATE TABLE "creator_contact_details" (
  "creatorProfileId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "personalEmail" VARCHAR(254) NOT NULL,
  "phone" VARCHAR(40) NOT NULL,
  "dateOfBirth" VARCHAR(10) NOT NULL,
  "addressLine1" VARCHAR(200) NOT NULL,
  "addressLine2" VARCHAR(200) NOT NULL DEFAULT '',
  "city" VARCHAR(100) NOT NULL,
  "region" VARCHAR(100) NOT NULL DEFAULT '',
  "postalCode" VARCHAR(24) NOT NULL,
  "country" VARCHAR(80) NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "creator_contact_details_pkey" PRIMARY KEY ("creatorProfileId"),
  CONSTRAINT "creator_contact_details_profile_fkey" FOREIGN KEY ("organizationId", "creatorProfileId") REFERENCES "creator_profiles"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "creator_contact_details_organizationId_idx" ON "creator_contact_details"("organizationId");
CREATE UNIQUE INDEX "creator_contact_details_organizationId_creatorProfileId_key" ON "creator_contact_details"("organizationId", "creatorProfileId");
