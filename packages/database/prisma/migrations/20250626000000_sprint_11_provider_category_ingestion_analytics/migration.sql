—-- Sprint 11 — First Live Integration (ServicesInMyCity + CallGrid)
--
-- Adds the INGESTION and ANALYTICS members to the ProviderCategory enum.
-- These were introduced in the schema during Sprint 10 but never captured in a
-- migration, so production databases provisioned from migrations were missing
-- them. This migration is the source-of-truth schema record; it replaces the
-- previous runtime ALTER TYPE self-heal.
--
-- ADD VALUE IF NOT EXISTS makes this safe to apply against databases that were
-- already healed at runtime, and idempotent on re-run.

ALTER TYPE "ProviderCategory" ADD VALUE IF NOT EXISTS 'INGESTION';
ALTER TYPE "ProviderCategory" ADD VALUE IF NOT EXISTS 'ANALYTICS';
