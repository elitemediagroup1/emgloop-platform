-- The durable AI usage ledger.
--
-- ADDITIVE ONLY. One new table, one unique index, three read indexes, two foreign
-- keys. Zero DROP, zero rename, zero column change on any existing table, zero
-- backfill. No existing row is read, written or moved by this migration.
--
-- ASCII ONLY. A leading em-dash in the sprint_11 migration blocked replay of the
-- entire ledger once (see PR #152); this file is deliberately plain ASCII.
--
-- ================== WHY THIS TABLE EXISTS ==================
--
-- The S1 AI runtime gateway reads an organization's daily budget through an
-- interface whose only implementation counts invocations in a process's memory.
-- Netlify runs serverless: instances share no memory, they come and go, and a cap
-- enforced per-instance is that cap multiplied by however many instances happen to
-- be warm. It is the same shape as the webhook replay map CLAUDE.md calls "close to
-- decorative" -- and a budget that is decorative is worse than no budget, because it
-- is a control somebody will trust.
--
-- ================== NOTHING WRITES THIS TABLE YET ==================
--
-- This migration is schema plus repository plus service. The AI runtime is NOT
-- activated, no provider credential is read, and no live model request exists
-- anywhere in this repository. After this migration the table is empty and every
-- existing code path behaves exactly as it did before.
--
-- ================== ONE ROW PER ATTEMPT ==================
--
-- Answered, refused, rejected, failed and cancelled alike. A failure that consumed
-- input tokens cost real money, and a refusal is as much a fact about the system as
-- an answer is. An attempt that is retried updates ONE row, because invocationId is
-- stable across retries and unique per organization -- otherwise a flaky provider
-- would quietly consume an organization's cap several times over.
--
-- ================== COST STAYS REPRODUCIBLE (Product, 2026-09-16) ==================
--
-- The row keeps the provider's RAW reported usage, plus "unitCostBasis": the
-- identifier of the price list those tokens should be valued with. A final dollar
-- amount is never the only record. When a price is corrected, history is re-valued
-- by reading it again -- it is not rewritten, and rewriting financial history to fix
-- a pricing error is not a thing this system should be able to do.
--
-- "estimatedCostMicros", "estimatedInputTokens" and "estimatedOutputTokens" are the
-- RESERVE and are explicitly not the cost of record. They exist so that concurrent
-- requests cannot each read a spend-to-date of zero; see the reserve-then-reconcile
-- note below. Estimate and report are separate columns and stay separate forever: a
-- row still carrying only an estimate is a row that never reconciled, and that is
-- worth being able to see.
--
-- Token columns are NULLABLE ON PURPOSE. A provider that did not report a count
-- leaves NULL, never 0 -- a zero would read as "this was free", which is a different
-- and false claim.
--
-- ================== BUSINESS DATE (Product, 2026-09-16) ==================
--
-- "businessDate" is a DATE, in the organization's own governed reporting calendar,
-- and it exists for exactly one reason: a business-day budget needs a day somebody
-- recognises. It is NOT a display timezone and it is not a general reading of when
-- something happened. The canonical instants -- requestedAt, completedAt, createdAt,
-- updatedAt -- are timestamptz on the server clock, UTC, per the Loop Time Authority.
--
-- ================== NO PROMPT, NO RESPONSE ==================
--
-- There is no column for the prompt and no column for the model's output, and that
-- is the single most important line in this file. Storing bodies "for observability"
-- would copy customer data and model output into a table whose retention, access
-- rules and audience differ from the sources they came from. That is the one change
-- that turns a usage ledger into a privacy incident.
--
-- "contextManifestHash" is a hash of the ORDERED source refs. It proves two
-- invocations saw the same evidence and is useless for reconstructing any of it. The
-- row NAMES the evidence; the evidence is read from its own authority under its own
-- guard.
--
-- ================== RESERVE, THEN RECONCILE ==================
--
-- A row is INSERTed before the provider call carrying the estimate, then UPDATEd
-- with the reported usage after it. A crash between the two leaves a row that
-- over-counts slightly, which is the safe direction: the organization is briefly
-- billed-against for work it may not have received. Counting only after the call
-- would let N concurrent requests each read a spend-to-date of zero and all pass a
-- cap that only one of them should have.
--
-- ================== RETENTION ==================
--
-- Rows are kept indefinitely: they are financial and governance facts and they are
-- small. Deleting an organization cascades them, as every other tenant-owned table
-- does. A deleted user's rows survive with a NULL principal -- the spend happened
-- and the organization was billed for it whether or not the person still has an
-- account.

-- CreateTable
CREATE TABLE "ai_invocations" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "invocationId" TEXT NOT NULL,
    "principalUserId" TEXT,
    "taskId" TEXT NOT NULL,
    "taskVersion" TEXT NOT NULL,
    "profile" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "requestedModelId" TEXT NOT NULL,
    "servedModel" TEXT,
    "routingPolicyVersion" TEXT NOT NULL,
    "providerRequestId" TEXT,
    "fellBackFrom" TEXT,
    "templateId" TEXT NOT NULL,
    "templateVersion" TEXT NOT NULL,
    "contextManifestHash" TEXT NOT NULL,
    "contextSourceCount" INTEGER NOT NULL,
    "estimatedInputTokens" INTEGER,
    "estimatedOutputTokens" INTEGER,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "cachedInputTokens" INTEGER,
    "reasoningTokens" INTEGER,
    "unitCostBasis" TEXT,
    "estimatedCostMicros" INTEGER,
    "outcome" TEXT NOT NULL,
    "failureClass" TEXT,
    "rejectionCodes" TEXT[],
    "attemptCount" INTEGER NOT NULL DEFAULT 1,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "latencyMs" INTEGER,
    "businessDate" DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_invocations_pkey" PRIMARY KEY ("id")
);

-- Idempotent under retry: one attempt is one row, however many times it is retried.
-- CreateIndex
CREATE UNIQUE INDEX "ai_invocations_organizationId_invocationId_key" ON "ai_invocations"("organizationId", "invocationId");

-- The budget read. It happens before EVERY invocation, so it must be one indexed
-- range scan and never a scan of the organization's history.
-- CreateIndex
CREATE INDEX "ai_invocations_organizationId_businessDate_idx" ON "ai_invocations"("organizationId", "businessDate");

-- Per-task cost review: what does answering this question actually cost us.
-- CreateIndex
CREATE INDEX "ai_invocations_organizationId_taskId_requestedAt_idx" ON "ai_invocations"("organizationId", "taskId", "requestedAt");

-- Refusal and failure rates over time. A rising REJECTED_BY_LOOP rate is the signal
-- that a template or a contract has drifted, and nobody finds it without this index.
-- CreateIndex
CREATE INDEX "ai_invocations_organizationId_outcome_requestedAt_idx" ON "ai_invocations"("organizationId", "outcome", "requestedAt");

-- Tenancy, with a real foreign key. Ten existing tables carry organizationId with no
-- FK and orphan on organization deletion; this table does not join them.
-- AddForeignKey
ALTER TABLE "ai_invocations" ADD CONSTRAINT "ai_invocations_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- SET NULL, not CASCADE: the spend is the organization's fact and it survives the
-- departure of the person who triggered it.
-- AddForeignKey
ALTER TABLE "ai_invocations" ADD CONSTRAINT "ai_invocations_principalUserId_fkey" FOREIGN KEY ("principalUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
