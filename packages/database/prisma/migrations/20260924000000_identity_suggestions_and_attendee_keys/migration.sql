-- Identity match suggestions (D1) and calendar attendee keys (D2). Approved 2026-09-19.
--
-- Architecture: docs/architecture/intelligence-foundation.md (D1, D2);
-- docs/architecture/identity-evidence-resolution.md SS5, SS6 and SS13;
-- docs/architecture/daily-loop-employee-intelligence.md SS8.3 and SS11.4.
--
-- ADDITIVE ONLY. Five nullable columns on intelligence_hypotheses and one defaulted array on
-- work_events, with one unique index, one index, one foreign key and four CHECKs. No existing
-- column changes, no row is backfilled, and every existing row satisfies every CHECK (all new
-- columns are NULL or empty on them).
--
-- D1: A MACHINE IDENTITY SUGGESTION IS A BELIEF, SO IT LIVES ON THE ONE BELIEF AUTHORITY.
-- intelligence_hypotheses already holds "what Loop thinks, created PROPOSED, accepted only by an
-- attributed person". A suggestion that a correspondent is an established Party is one more
-- such belief. There is no second suggestion table and no new identity authority:
--
--   privateToUserId      the person whose PRIVATE evidence it rests on. Only they read or decide
--                        it. The composite key to their membership means it can only belong to a
--                        member of the same organization, and it is also deleted explicitly
--                        when their membership ends (ending one is soft, so the cascade alone
--                        would never fire).
--   matchKey             scope + the subject's one-way key + the candidate Party.
--   evidenceFingerprint  one-way fingerprint of the exact evidence records used. UNIQUE with the
--                        match key: the same evidence can produce the same suggestion once,
--                        ever, so a rejection is remembered. New evidence is a new fingerprint
--                        and a new row, and the rejected row stays as history.
--   evidenceRefs         references (ids, one-way keys), method, reason, source and time. The
--                        evidence stays in the authority that owns it; nothing is copied.
--   decisionReason       the deciding person's words (required to reject, identity SS13).
--
-- D2: ATTENDEE KEYS, NOT ATTENDEES. The same SHA-256 key organizerHash and a correspondent's
-- addressHash already use, one per invited person other than the connected person. The CHECK
-- refuses anything that is not a 64-character lowercase hex key, so an address cannot be stored
-- here by mistake, and refuses keys when the provider did not say who attends.
--
-- ASCII only.

-- AlterTable
ALTER TABLE "intelligence_hypotheses" ADD COLUMN     "decisionReason" TEXT,
ADD COLUMN     "evidenceFingerprint" TEXT,
ADD COLUMN     "evidenceRefs" JSONB,
ADD COLUMN     "matchKey" TEXT,
ADD COLUMN     "privateToUserId" TEXT;

-- AlterTable
ALTER TABLE "work_events" ADD COLUMN     "attendeeHashes" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateIndex
CREATE INDEX "intelligence_hypotheses_organizationId_privateToUserId_hypo_idx" ON "intelligence_hypotheses"("organizationId", "privateToUserId", "hypothesisType", "status");

-- CreateIndex
CREATE UNIQUE INDEX "intelligence_hypotheses_organizationId_matchKey_evidenceFin_key" ON "intelligence_hypotheses"("organizationId", "matchKey", "evidenceFingerprint");

-- AddForeignKey
ALTER TABLE "intelligence_hypotheses" ADD CONSTRAINT "intelligence_hypotheses_privateToUserId_organizationId_fkey" FOREIGN KEY ("privateToUserId", "organizationId") REFERENCES "organization_memberships"("userId", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- A suggestion is keyed, fingerprinted and evidenced together, or it is not a suggestion.
ALTER TABLE "intelligence_hypotheses" ADD CONSTRAINT "intelligence_hypotheses_suggestion_shape_check"
  CHECK (
    ("matchKey" IS NULL AND "evidenceFingerprint" IS NULL AND "evidenceRefs" IS NULL AND "privateToUserId" IS NULL)
    OR ("matchKey" IS NOT NULL AND "evidenceFingerprint" IS NOT NULL AND "evidenceRefs" IS NOT NULL AND "subjectIdentityId" IS NOT NULL)
  );

-- A suggestion is only ever decided by an attributed person: no ACCEPTED or REJECTED suggestion
-- without who and when, and no rejection without a reason.
ALTER TABLE "intelligence_hypotheses" ADD CONSTRAINT "intelligence_hypotheses_suggestion_decision_check"
  CHECK (
    "matchKey" IS NULL
    OR (
      ("status" <> 'ACCEPTED' OR ("acceptedBy" IS NOT NULL AND "acceptedAt" IS NOT NULL))
      AND ("status" <> 'REJECTED' OR ("rejectedBy" IS NOT NULL AND "rejectedAt" IS NOT NULL AND "decisionReason" IS NOT NULL))
    )
  );

-- Keys only, bounded, and only when the provider said who attends.
ALTER TABLE "work_events" ADD CONSTRAINT "work_events_attendee_keys_check"
  CHECK (
    "attendeeHashes" IS NULL
    OR (
      cardinality("attendeeHashes") <= 50
      AND ("attendanceKnown" OR cardinality("attendeeHashes") = 0)
      AND array_to_string("attendeeHashes", ',') ~ '^([0-9a-f]{64}(,[0-9a-f]{64})*)?$'
    )
  );
