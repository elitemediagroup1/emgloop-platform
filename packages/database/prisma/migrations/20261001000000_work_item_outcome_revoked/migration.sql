-- Work items: the REVOKED outcome (2026-09-24). ADDITIVE ONLY: one CHECK constraint is
-- re-stated with one more permitted value. No column, no row and no other table is touched;
-- every value the old constraint accepted, the new one accepts. Safe to apply to a live database.
--
-- WHY. When an employee withdraws the content authorization a model read under, the items that
-- model derived are closed "because the authorization was withdrawn" and minimized to provenance
-- (docs/architecture/daily-loop-employee-intelligence.md section 21.2). That is a distinct fact from every
-- outcome the DL-1 migration knew: it is not "handled", not "Loop was wrong", not "expired" -- and
-- recording it as any of those would poison the accuracy signal the outcomes exist to feed. The
-- DL-1 migration pins the outcome vocabulary in a CHECK, so the word needs this migration; the
-- constraint is restated in full below, and @emgloop/shared's WORK_ITEM_OUTCOMES test reads THIS
-- file for the outcome list from now on.
--
-- The constraint is dropped and re-added rather than altered because Postgres has no
-- ALTER CONSTRAINT for a CHECK; both statements run in the one migration transaction.

ALTER TABLE "work_items" DROP CONSTRAINT "work_items_shape_check";

ALTER TABLE "work_items" ADD CONSTRAINT "work_items_shape_check" CHECK (
  "class" IN ('NEEDS_YOU', 'WAITING_ON_THEM', 'GONE_QUIET', 'FYI')
  AND "subjectKind" IN ('THREAD', 'EVENT', 'DOCUMENT', 'CORRESPONDENT')
  AND "producerKind" IN ('RULE', 'MODEL')
  AND length("producerId") BETWEEN 1 AND 128
  AND length("producerVersion") BETWEEN 1 AND 64
  AND "state" IN ('OPEN', 'SNOOZED', 'RESOLVED', 'DISMISSED')
  -- REVOKED: system-only; the authorization that produced the item was withdrawn (section 21.2).
  AND ("outcome" IS NULL OR "outcome" IN ('HANDLED', 'NOT_MINE', 'NO_ACTION_NEEDED', 'FALSE_POSITIVE', 'SUPERSEDED', 'EXPIRED', 'REVOKED'))
  -- Closed means closed: resolvedAt and outcome exist exactly for RESOLVED and DISMISSED.
  AND (("state" IN ('RESOLVED', 'DISMISSED')) = ("resolvedAt" IS NOT NULL))
  AND (("resolvedAt" IS NULL) = ("outcome" IS NULL))
  AND (("state" = 'SNOOZED') = ("snoozedUntil" IS NOT NULL))
  AND "detectionCount" >= 1
  AND "lastDetectedAt" >= "firstDetectedAt"
  -- Stage 2 seam: a quote is capped, and never stored without the message it came from.
  AND ("evidenceQuote" IS NULL OR length("evidenceQuote") <= 240)
  AND (("evidenceQuote" IS NULL) = ("evidenceQuoteRef" IS NULL))
);
