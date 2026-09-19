// Declare the outbox subscriptions organization intelligence needs -- an OPERATIONS BRIDGE.
//
// The publisher delivers an event only to ACTIVE subscription rows in that event's organization.
// Without them, the intelligence reviews (services/intelligence: the creator-onboarding review)
// exist and are never reached. This declares them for ONE organization, once.
//
// DRY RUN BY DEFAULT. Without --apply it prints what it would create and writes nothing. With
// --apply it creates only the rows that are missing: an existing row -- including one a person
// switched INACTIVE -- is left exactly as it is. Prints subscriber keys and results; nothing else.
//
// NO SCHEDULE, NO PUSH, NO PULL_REQUEST, NO WORKFLOW_CALL. A human runs it.

import type { DeclaredSubscription } from '@emgloop/database';

export interface DeclareDeps {
  organizations: { findBySlug(slug: string): Promise<{ id: string; slug: string } | null> };
  declare(organizationId: string, options: { apply: boolean }): Promise<readonly DeclaredSubscription[]>;
  log: (line: string) => void;
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function parseArgs(argv: readonly string[]): { organization: string; apply: boolean } {
  let organization = '';
  let apply = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--organization' || argv[i] === '--org') {
      organization = (argv[i + 1] ?? '').trim();
      i += 1;
    } else if (argv[i] === '--apply') {
      apply = true;
    }
  }
  return { organization, apply };
}

export async function runDeclareIntelligenceSubscriptions(
  request: { organizationSlug: string; apply: boolean },
  deps: DeclareDeps,
): Promise<'DECLARED' | 'DRY_RUN' | 'FAILED_PRECONDITION'> {
  if (!SLUG.test(request.organizationSlug)) {
    deps.log('event=PRECONDITION_FAILED reason=--organization must be lowercase letters, digits and hyphens');
    return 'FAILED_PRECONDITION';
  }
  const org = await deps.organizations.findBySlug(request.organizationSlug);
  if (!org) {
    deps.log('event=PRECONDITION_FAILED reason=unknown organization');
    return 'FAILED_PRECONDITION';
  }
  for (const row of await deps.declare(org.id, { apply: request.apply })) {
    deps.log(`event=SUBSCRIPTION organization=${org.slug} key=${row.subscriberKey} result=${row.result} status=${row.status ?? '-'}`);
  }
  deps.log(`event=SUMMARY organization=${org.slug} mode=${request.apply ? 'APPLY' : 'DRY_RUN'}`);
  return request.apply ? 'DECLARED' : 'DRY_RUN';
}

async function main(): Promise<number> {
  const log = (l: string) => process.stdout.write(l + '\n');
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.DATABASE_URL?.trim()) {
    log('event=PRECONDITION_FAILED reason=missing environment missing=DATABASE_URL');
    return 2;
  }
  const { prisma, repositories, declareIntelligenceSubscriptions } = await import('@emgloop/database');
  try {
    const result = await runDeclareIntelligenceSubscriptions(
      { organizationSlug: args.organization, apply: args.apply },
      { organizations: repositories.organizations, declare: (id, o) => declareIntelligenceSubscriptions(prisma, id, o), log },
    );
    return result === 'FAILED_PRECONDITION' ? 1 : 0;
  } finally {
    await prisma.$disconnect();
  }
}

const ENTRY_POINT = /[\\/]declare-intelligence-subscriptions\.ts$/;
if (process.argv[1] && ENTRY_POINT.test(process.argv[1])) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.stdout.write('event=RUN_FAILED reason=UNEXPECTED\n');
      process.exitCode = 1;
    },
  );
}
