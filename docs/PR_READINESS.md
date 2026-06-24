# Pull Request Readiness

Checklist for reviewing the `sprint-1-platform-foundation` branch before it is
merged into `main`. Do not open the PR until explicitly asked.

## Squash on merge (required)

This branch was built entirely through the GitHub web editor, so its commit
history is granular and noisy (one commit per file/edit). The final PR must be
**squash-merged** into `main` to collapse it into a single clean commit.

## Commands

These commands describe the intended local workflow. They are not run in CI yet.

- **Install:** `pnpm install` (workspace root; Turborepo monorepo).
- **Build:** `pnpm build` (runs `turbo run build` across all workspaces).
- **Typecheck:** `pnpm typecheck` (runs `tsc --noEmit` per package via Turbo).
- **Prisma generate:** `pnpm --filter @emgloop/database prisma generate`
  (regenerates the Prisma client from `packages/database/prisma/schema.prisma`).
- **Prisma validate:** `pnpm --filter @emgloop/database prisma validate`
  (validates the schema without touching a database).

## Environment variables needed

See `.env.example` for the full list. At minimum, future runtime needs:

- `DATABASE_URL` — PostgreSQL connection string (Prisma datasource).
- Provider credentials are NOT required to build or typecheck; they are stored
  per organization via ProviderConnection and resolved at runtime later.

No secrets are committed to the repository.

## What was intentionally NOT built

- Live authentication flows (only the auth foundation/architecture exists).
- Real provider integrations (Anthropic, ElevenLabs, Twilio, Telnyx, Stripe,
  email, calendars) — interfaces and abstractions only.
- Customer-facing/business features and any ServicesInMyCity ingestion.
- A permission-resolution engine wired to the database (the `isAllowed` /
  `resolvePermission` helpers exist; loading rules at request time is Sprint 3).

## Known limitations

- `OrganizationSettings.modules` is deprecated but still present in the schema
  for backward-compat migration. OrganizationCapability is the source of truth.
- `AIAgent` is retained as the lower-level execution runtime; AIEmployee is the
  high-level identity. The runtime wiring between them is documented but not
  implemented.
- No migrations have been generated yet; the schema is the source of truth and
  the first migration will be produced when a database is provisioned.
- Web/API app shells are placeholders only.

## Verification performed this sprint

- Prisma schema: 29 models, 27 enums, balanced braces, no duplicate names.
- All cross-model relations have matching back-relations.
- `identity.ts` retains all prior exports plus typed permission subjects.
- Docs updated for AI Employees, capabilities, interactions, and events.
