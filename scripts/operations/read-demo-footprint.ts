// Read demo footprint -- after the /demo exposure was closed (#232).
//
// READ-ONLY, ONE ORGANIZATION. Until 2026-09-14 the public /demo routes could
// create fabricated customer journeys in the live organization without a
// session, and the operator-run Prisma seed writes sample customers into the
// same one. This runner lists every customer that carries those generators'
// fingerprints, everything that depends on each one, and any fingerprinted row
// with no suspected customer, so cleanup can be decided from evidence.
//
// It writes nothing. It prints record ids, creation timestamps, match flags and
// counts -- never a name, email, phone number or message body.
//
// What it cannot tell you: whether the routes were requested, or by whom. That is
// in request logs, not in the database. A fingerprinted row proves a generator
// ran, not who ran it.
//
//   SUSPECTED_CUSTOMERS=0 and ORPHANS=0   no generator footprint in this organization
//   attribution=WEB_DEMO_LOOP              mock SMS/calendar artifacts or demo loop kinds
//   attribution=PRISMA_SEED                the seed's sample externalIds, no loop artifacts
//   attribution=DEMO_IDENTITY_ONLY         default/sample/reserved contact values only
//   LEGITIMACY_SIGNALS=NONE                nothing suggests a real person or real work
//   EXCEEDED_BOUND=true                    incomplete; do not act on this output
//
// NO SCHEDULE, NO PUSH, NO PULL_REQUEST, NO WORKFLOW_CALL.

import type { DemoFootprint } from '@emgloop/database';

/** Read-only organization lookup. This runner may never provision one. */
export interface OrganizationLookup {
  findBySlug(slug: string): Promise<{ id: string; slug: string } | null>;
}

export interface DemoFootprintReader {
  footprint(organizationId: string): Promise<DemoFootprint>;
}

export interface DemoFootprintDeps {
  organizations: OrganizationLookup;
  reader: DemoFootprintReader;
  log: (line: string) => void;
}

export interface DemoFootprintResult {
  overall: 'READ' | 'FAILED_PRECONDITION';
  footprint: DemoFootprint | null;
  error: string | null;
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function readEnvironment(
  env: NodeJS.ProcessEnv,
): { ok: true } | { ok: false; missing: string[] } {
  return env.DATABASE_URL?.trim() ? { ok: true } : { ok: false, missing: ['DATABASE_URL'] };
}

export function parseArgs(argv: readonly string[]): { organization: string } {
  let organization = '';
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--organization' || argv[i] === '--org') {
      organization = (argv[i + 1] ?? '').trim();
      i += 1;
    }
  }
  return { organization };
}

type Field = string | number | boolean | null;

function line(fields: Record<string, Field>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${k}=${v === null ? 'UNKNOWN' : String(v)}`)
    .join(' ');
}

const list = (ids: readonly string[]) => (ids.length ? ids.join(',') : 'NONE');

export async function runDemoFootprint(
  request: { organizationSlug: string },
  deps: DemoFootprintDeps,
): Promise<DemoFootprintResult> {
  const refuse = (reason: string): DemoFootprintResult => {
    deps.log(line({ event: 'PRECONDITION_FAILED', reason }));
    return { overall: 'FAILED_PRECONDITION', footprint: null, error: reason };
  };
  if (!SLUG.test(request.organizationSlug)) {
    return refuse('--organization must be lowercase letters, digits and hyphens');
  }
  const org = await deps.organizations.findBySlug(request.organizationSlug);
  if (!org) return refuse('unknown organization');

  const f = await deps.reader.footprint(org.id);

  deps.log(line({
    event: 'ORGANIZATION',
    organization: org.slug,
    createdAt: f.organization?.createdAt ?? null,
    NAME_MATCHES_SEED_UPSERT: f.organization?.nameMatchesSeedUpsert ?? null,
  }));
  deps.log(line({
    event: 'FINGERPRINTED_ROWS',
    MARKED_INTERACTIONS: f.totals.markedInteractions,
    MOCK_MESSAGES: f.totals.mockMessages,
    SCRIPTED_REPLIES: f.totals.scriptedReplies,
    MOCK_BOOKINGS: f.totals.mockBookings,
    IDENTITY_MATCHES: f.totals.identityMatches,
  }));

  for (const s of f.suspects) {
    const d = s.dependencies;
    deps.log(line({
      event: 'SUSPECT_CUSTOMER',
      id: s.id,
      createdAt: s.createdAt,
      attribution: s.attribution,
      FLAGS: list(s.flags),
      LEGITIMACY_SIGNALS: list(s.legitimacySignals),
      INTERACTIONS: d.interactions.length,
      DEMO_INTERACTIONS: d.demoInteractions.length,
      CONVERSATIONS: d.conversations.length,
      MESSAGES: d.messages.length,
      MOCK_MESSAGES: d.mockMessages.length,
      BOOKINGS: d.bookings.length,
      MOCK_BOOKINGS: d.mockBookings.length,
      ORDERS: d.orders.length,
      SERVICE_REQUESTS: d.serviceRequests.length,
      SIGNALS: d.signals.length,
      PARTY_LINKS: d.partyLinks.length,
      DOMAIN_EVENTS: d.domainEvents.length,
      AUDIT_ENTRIES: d.auditEntries.length,
      HUMAN_AUDIT_ENTRIES: d.humanAuditEntries.length,
      OUTBOX_ENTRIES: d.outboxEntries.length,
      DECISION_EVIDENCE: d.decisionEvidence.length,
    }));
    deps.log(line({
      event: 'SUSPECT_DEPENDENCIES',
      customer: s.id,
      interactions: list(d.interactions),
      conversations: list(d.conversations),
      messages: list(d.messages),
      bookings: list(d.bookings),
      orders: list(d.orders),
      serviceRequests: list(d.serviceRequests),
      signals: list(d.signals),
      partyLinks: list(d.partyLinks),
      domainEvents: list(d.domainEvents),
      auditEntries: list(d.auditEntries),
      outboxEntries: list(d.outboxEntries),
      decisionEvidence: list(d.decisionEvidence),
    }));
  }

  for (const o of f.orphans) {
    deps.log(line({ event: 'ORPHAN_ARTIFACT', table: o.table, id: o.id, createdAt: o.createdAt, reason: o.reason }));
  }

  const count = (a: DemoFootprint['suspects'][number]['attribution']) => f.suspects.filter((s) => s.attribution === a).length;
  deps.log(line({
    event: 'VERDICT',
    SUSPECTED_CUSTOMERS: f.suspects.length,
    WEB_DEMO_LOOP: count('WEB_DEMO_LOOP'),
    PRISMA_SEED: count('PRISMA_SEED'),
    DEMO_IDENTITY_ONLY: count('DEMO_IDENTITY_ONLY'),
    WITH_LEGITIMACY_SIGNALS: f.suspects.filter((s) => s.legitimacySignals.length > 0).length,
    ORPHANS: f.orphans.length,
    EXCEEDED_BOUND: f.exceededBound,
    OVERALL_RESULT: 'READ',
  }));
  return { overall: 'READ', footprint: f, error: null };
}

// --- Wiring -------------------------------------------------------------------

async function main(): Promise<number> {
  const log = (l: string) => process.stdout.write(l + '\n');
  const args = parseArgs(process.argv.slice(2));
  if (!args.organization) {
    log(line({ event: 'PRECONDITION_FAILED', reason: '--organization <slug> is required' }));
    return 2;
  }
  const env = readEnvironment(process.env);
  if (!env.ok) {
    log(line({ event: 'PRECONDITION_FAILED', reason: 'missing environment', missing: env.missing.join(',') }));
    return 2;
  }

  const { prisma, repositories, DemoFootprintRepository } = await import('@emgloop/database');
  try {
    const result = await runDemoFootprint(
      { organizationSlug: args.organization },
      { organizations: repositories.organizations, reader: new DemoFootprintRepository(prisma), log },
    );
    return result.overall === 'READ' ? 0 : 1;
  } finally {
    await prisma.$disconnect();
  }
}

const ENTRY_POINT = /[\\/]read-demo-footprint\.ts$/;
if (process.argv[1] && ENTRY_POINT.test(process.argv[1])) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      const detail = error instanceof Error ? error.message : 'unknown';
      process.stdout.write(line({ event: 'RUN_FAILED', reason: detail }) + '\n');
      process.exitCode = 1;
    },
  );
}
