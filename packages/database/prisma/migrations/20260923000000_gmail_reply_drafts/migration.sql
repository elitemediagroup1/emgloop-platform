-- Migration 41: the reply an employee is writing (GM-2).
--
-- Architecture: docs/architecture/daily-loop-employee-intelligence.md 6.9-6.11.
-- ADDITIVE ONLY: one new table, one new array column, their indexes, foreign keys and CHECKs.
--
-- WHY LOOP STORES A BODY AT ALL, WHEN IT STORES NO OTHER ONE. `work_drafts` holds the employee's
-- OWN WORDS -- what they typed, or what Loop proposed and they then accepted and edited. It is
-- not correspondence, and the alternative is losing a half-written reply to ordinary navigation.
-- The body is CLEARED on a successful send: from that moment the message lives in Gmail, and it
-- comes back as an ordinary SENT message on the next sync. Nothing here becomes a mail archive.
--
-- WHY GMAIL DRAFTS ARE NOT USED. Creating a Gmail draft needs `gmail.compose`, which is a
-- RESTRICTED scope covering drafts and sending; Loop asks for `gmail.send`, which is sensitive
-- and can do nothing but send. A Loop-local draft also cannot be duplicated in somebody's Gmail
-- by a retry, which a create-draft-per-keystroke design eventually does.
--
-- ONE OPEN DRAFT PER THREAD PER PERSON (the unique index), so a retry updates rather than
-- multiplies, and a send CLAIMS the row before Gmail is called: `sendClaimedAt` is what stops a
-- double-click becoming two messages, and `sentMessageId` is the only proof a send happened.
--
-- `work_messages.references` is the RFC 5322 chain, in order. Header identifiers only -- no
-- address, no subject, no content -- kept so a reply can be threaded correctly without asking
-- Gmail for the whole conversation again at send time.

-- AlterTable
ALTER TABLE "work_messages" ADD COLUMN     "references" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "work_drafts" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "inReplyToMessageId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "toAddresses" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ccAddresses" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "subject" TEXT,
    "body" TEXT NOT NULL DEFAULT '',
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "aiInvocationId" TEXT,
    "aiTaskVersion" TEXT,
    "aiUnedited" BOOLEAN NOT NULL DEFAULT false,
    "sendClaimedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "sentMessageId" TEXT,
    "sendFailureClass" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "work_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "work_drafts_organizationId_userId_updatedAt_idx" ON "work_drafts"("organizationId", "userId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "work_drafts_organizationId_userId_provider_threadId_key" ON "work_drafts"("organizationId", "userId", "provider", "threadId");

-- AddForeignKey
ALTER TABLE "work_drafts" ADD CONSTRAINT "work_drafts_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_drafts" ADD CONSTRAINT "work_drafts_userId_organizationId_fkey" FOREIGN KEY ("userId", "organizationId") REFERENCES "organization_memberships"("userId", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;


-- ================== CHECK CONSTRAINTS ==================

-- CheckConstraint: closed vocabularies, and nothing a caller invents.
ALTER TABLE "work_drafts" ADD CONSTRAINT "work_drafts_mode_check"
  CHECK ("mode" IN ('REPLY', 'REPLY_ALL'));

ALTER TABLE "work_drafts" ADD CONSTRAINT "work_drafts_source_check"
  CHECK ("source" IN ('MANUAL', 'AI_PROPOSED'));

ALTER TABLE "work_drafts" ADD CONSTRAINT "work_drafts_provider_check"
  CHECK ("provider" IN ('GOOGLE'));

ALTER TABLE "work_drafts" ADD CONSTRAINT "work_drafts_send_failure_class_check"
  CHECK ("sendFailureClass" IS NULL OR "sendFailureClass" IN ('NOT_CONNECTED', 'CAPABILITY_NOT_GRANTED', 'AUTHORIZATION_EXPIRED', 'AUTH', 'FORBIDDEN', 'RATE_LIMITED', 'NETWORK', 'TIMEOUT', 'MALFORMED', 'UNAVAILABLE', 'REFUSED'));

-- CheckConstraint: a sent draft is a fact with proof, and it keeps no body.
--   * a send has both its moment and Gmail's own id, or neither;
--   * a sent draft holds no body, because the message is in Gmail from then on;
--   * a sent draft has no outstanding failure.
ALTER TABLE "work_drafts" ADD CONSTRAINT "work_drafts_sent_check"
  CHECK (
    (("sentAt" IS NULL) = ("sentMessageId" IS NULL))
    AND ("sentAt" IS NULL OR "body" = '')
    AND ("sentAt" IS NULL OR "sendFailureClass" IS NULL)
  );

-- CheckConstraint: provenance travels together. A draft Loop proposed names the invocation that
-- produced it and the task version that wrote it; one a person typed names neither.
ALTER TABLE "work_drafts" ADD CONSTRAINT "work_drafts_provenance_check"
  CHECK (
    (("source" = 'AI_PROPOSED') OR ("aiInvocationId" IS NULL AND "aiTaskVersion" IS NULL AND "aiUnedited" = false))
    AND (("source" <> 'AI_PROPOSED') OR ("aiInvocationId" IS NOT NULL AND "aiTaskVersion" IS NOT NULL))
  );

-- CheckConstraint: a body Loop will not send is not a body it stores. 100k characters is the
-- composer's own ceiling (@emgloop/shared GMAIL_MAX_BODY_CHARS).
ALTER TABLE "work_drafts" ADD CONSTRAINT "work_drafts_body_check"
  CHECK (length("body") <= 100000 AND cardinality("toAddresses") <= 100 AND cardinality("ccAddresses") <= 100);
