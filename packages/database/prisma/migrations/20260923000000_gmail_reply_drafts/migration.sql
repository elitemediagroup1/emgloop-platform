-- Migration 41: the reply an employee is writing, and the state of sending it (GM-2).
--
-- Architecture: docs/architecture/daily-loop-employee-intelligence.md 6.9-6.11a.
-- ADDITIVE ONLY: one new table, one new array column, their indexes, foreign keys and CHECKs.
--
-- WHY LOOP STORES A BODY AT ALL, WHEN IT STORES NO OTHER ONE. `work_drafts` holds the employee's
-- OWN WORDS -- what they typed, or what Loop proposed and they then accepted and edited. It is
-- not correspondence, and the alternative is losing a half-written reply to ordinary navigation.
-- The body is CLEARED once the send is proven: from that moment the message lives in Gmail, and
-- it comes back as an ordinary SENT message on the next sync. Nothing here becomes a mail archive.
--
-- WHY GMAIL DRAFTS ARE NOT USED. Creating a Gmail draft needs `gmail.compose`, which is a
-- RESTRICTED scope covering drafts and sending; Loop asks for `gmail.send`, which is sensitive
-- and can do nothing but send.
--
-- THE SEND STATE MACHINE, AND WHY IT IS IN THE DATABASE. Gmail's `messages.send` has no
-- idempotency key. An attempt whose answer is lost -- a timeout, a dropped connection, a 5xx, or
-- a process that stops after Gmail accepted the message -- must never become "sendable again"
-- by the passage of time. So:
--
--   DRAFT         editable, sendable. A DEFINITIVE failure returns here.
--   SENDING       claimed; the attempt's id, start and body fingerprint stored BEFORE Gmail is
--                 called, in the same conditional update that claims the row.
--   SEND_UNKNOWN  the outcome could not be proven. Never retried automatically; it leaves only by
--                 reconciliation against the employee's Sent mail, or by their explicit, recorded
--                 decision (`sendResolution`).
--   SENT          terminal, with Gmail's own message id as the proof.
--
-- The CHECKs below make the invariants the database's own: a SENT row has its proof and no body;
-- an in-doubt row carries the attempt identity reconciliation needs; a DRAFT carries no attempt at
-- all, so nothing about a finished attempt can be mistaken for a live one.
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
    "sendState" TEXT NOT NULL DEFAULT 'DRAFT',
    "sendAttemptId" TEXT,
    "sendAttemptStartedAt" TIMESTAMP(3),
    "sendAttemptBodyHash" TEXT,
    "sendReconciledAt" TIMESTAMP(3),
    "sendResolution" TEXT,
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

ALTER TABLE "work_drafts" ADD CONSTRAINT "work_drafts_send_state_check"
  CHECK ("sendState" IN ('DRAFT', 'SENDING', 'SEND_UNKNOWN', 'SENT'));

ALTER TABLE "work_drafts" ADD CONSTRAINT "work_drafts_send_resolution_check"
  CHECK ("sendResolution" IS NULL OR "sendResolution" IN ('RECONCILED_SENT', 'RECONCILED_NOT_SENT', 'RELEASED_BY_EMPLOYEE'));

ALTER TABLE "work_drafts" ADD CONSTRAINT "work_drafts_send_failure_class_check"
  CHECK ("sendFailureClass" IS NULL OR "sendFailureClass" IN ('NOT_CONNECTED', 'CAPABILITY_NOT_GRANTED', 'AUTHORIZATION_EXPIRED', 'AUTH', 'FORBIDDEN', 'RATE_LIMITED', 'NETWORK', 'TIMEOUT', 'MALFORMED', 'UNAVAILABLE', 'REFUSED', 'REJECTED', 'NOT_DELIVERED'));

-- CheckConstraint: a sent draft is a fact with proof, and it keeps no body.
--   * SENT exactly when a send moment is recorded, and a moment always comes with Gmail's own id;
--   * a sent draft holds no body, because the message is in Gmail from then on;
--   * a sent draft has no outstanding failure.
ALTER TABLE "work_drafts" ADD CONSTRAINT "work_drafts_sent_check"
  CHECK (
    (("sendState" = 'SENT') = ("sentAt" IS NOT NULL))
    AND (("sentAt" IS NULL) = ("sentMessageId" IS NULL))
    AND ("sendState" <> 'SENT' OR "body" = '')
    AND ("sendState" <> 'SENT' OR "sendFailureClass" IS NULL)
  );

-- CheckConstraint: an attempt in flight or in doubt carries everything reconciliation needs; a
-- DRAFT carries no attempt at all. The fingerprint is a SHA-256, never text.
ALTER TABLE "work_drafts" ADD CONSTRAINT "work_drafts_attempt_check"
  CHECK (
    ("sendState" NOT IN ('SENDING', 'SEND_UNKNOWN') OR ("sendAttemptId" IS NOT NULL AND "sendAttemptStartedAt" IS NOT NULL AND "sendAttemptBodyHash" IS NOT NULL))
    AND ("sendState" <> 'DRAFT' OR ("sendAttemptId" IS NULL AND "sendAttemptStartedAt" IS NULL AND "sendAttemptBodyHash" IS NULL))
    AND ("sendState" <> 'SENDING' OR "sendFailureClass" IS NULL)
    AND ("sendAttemptBodyHash" IS NULL OR "sendAttemptBodyHash" ~ '^[0-9a-f]{64}$')
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
