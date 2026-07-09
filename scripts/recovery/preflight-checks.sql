-- EMG Loop — Prisma baseline recovery preflight checks (READ-ONLY).
-- Aborts the recovery if production is not in the expected pre-recovery state.
-- Safe to run repeatedly; makes no writes.

DO $$
DECLARE
    has_prisma_migrations boolean;
    workos_table_count int;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = '_prisma_migrations'
    ) INTO has_prisma_migrations;

    IF has_prisma_migrations THEN
        RAISE EXCEPTION 'ABORT: _prisma_migrations already exists. This database may already be under Prisma Migrate management. Stop and review before continuing.';
    END IF;

    SELECT count(*) INTO workos_table_count
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN (
        'blueprints', 'blueprint_stages', 'work_instances',
        'work_stages', 'work_assignments', 'work_notifications', 'work_comments'
      );

    IF workos_table_count > 0 THEN
        RAISE EXCEPTION 'ABORT: % Work OS table(s) already exist before the migration step. Expected zero.', workos_table_count;
    END IF;

    RAISE NOTICE 'Preflight OK: no _prisma_migrations and no Work OS tables present. Safe to baseline.';
END $$;
