CREATE TABLE "access_requests" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "accessType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "invitationId" TEXT,
    "claimId" TEXT,
    "processingAt" TIMESTAMP(3),
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "access_requests_pkey" PRIMARY KEY ("id")
);


CREATE INDEX "access_requests_organizationId_status_submittedAt_id_idx" ON "access_requests"("organizationId", "status", "submittedAt", "id");

CREATE UNIQUE INDEX "access_requests_organizationId_email_key" ON "access_requests"("organizationId", "email");

ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_invitationId_fkey" FOREIGN KEY ("invitationId") REFERENCES "invitations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
