// Read identity footprint -- CRM Phase Zero P0.2d, before any Party schema change.
//
// READ-ONLY, COUNTS ONLY, ONE ORGANIZATION. Prints what `cognitive_identities`
// and everything that points at it actually hold: rows by entity type and status,
// Party-typed rows, keys that would collide under a (organizationId, canonicalKey)
// uniqueness, satellite and cognitive-record counts, and references that resolve
// to no identity in the organization. It writes nothing, changes no constraint and
// prints no id, key, name, hash or contact value.
//
// THE QUESTION IT ANSWERS. The cognitive identity layer has no production writer
// in source. That is a fact about code, not about the database: a script, a past
// deploy or a manual insert could have left rows. Party schema alignment must not
// add a constraint that assumes the table is empty, so a human reads this first.
//
//   EMPTY=true                       nothing exists; alignment reinterprets no row
//   DUPLICATE_KEY_GROUPS=0           the new uniqueness can be added as specified
//   UNRESOLVED_REFERENCES=0          every reference in this org names a real identity
//   any value UNKNOWN                a bound was exceeded; do not proceed on it
//
// NO SCHEDULE, NO PUSH, NO PULL_REQUEST, NO WORKFLOW_CALL.

/** Read-only organization lookup. This runner may never provision one. */
export interface OrganizationLookup {
  findBySlug(slug: string): Promise<{ id: string; slug: string } | null>;
}

/** The counts-only shape `IdentityFootprintRepository.footprint` returns. */
export interface FootprintCounts {
  identities: {
    total: number;
    partyTyped: number;
    archived: number;
    byEntityType: Record<string, number>;
    byStatus: Record<string, number>;
    duplicateKeyGroups: number | null;
    duplicateKeyRows: number | null;
  };
  satellites: {
    roles: number;
    evidence: number;
    revokedEvidence: number;
    evidenceByType: Record<string, number>;
    resolutionLinks: number;
    linksByStatus: Record<string, number>;
    linksByMethod: Record<string, number>;
    relationships: number;
  };
  references: {
    memoryEventsWithIdentity: number;
    knowledgeAssertions: number;
    activeStateRecords: number;
    outboxWithIdentity: number;
    hypothesesWithSubject: number;
    decisionsWithSubject: number;
  };
  unresolvedReferences: number | null;
  exceededBound: boolean;
}

export interface FootprintReader {
  footprint(organizationId: string): Promise<FootprintCounts>;
}

export interface FootprintDeps {
  organizations: OrganizationLookup;
  identities: FootprintReader;
  log: (line: string) => void;
}

export interface FootprintResult {
  overall: 'READ' | 'FAILED_PRECONDITION';
  counts: FootprintCounts | null;
  empty: boolean | null;
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

/** Buckets with a zero count are omitted, so a line lists only what exists. */
function nonZero(prefix: string, counts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => [`${prefix}${k}`, n]));
}

/** Nothing identity-shaped exists in the organization at all. */
export function isEmptyFootprint(c: FootprintCounts): boolean {
  const s = c.satellites;
  const r = c.references;
  return (
    c.identities.total === 0 &&
    s.roles === 0 && s.evidence === 0 && s.resolutionLinks === 0 && s.relationships === 0 &&
    r.memoryEventsWithIdentity === 0 && r.knowledgeAssertions === 0 && r.activeStateRecords === 0 &&
    r.outboxWithIdentity === 0 && r.hypothesesWithSubject === 0 && r.decisionsWithSubject === 0
  );
}

export async function runIdentityFootprint(
  request: { organizationSlug: string },
  deps: FootprintDeps,
): Promise<FootprintResult> {
  const refuse = (reason: string): FootprintResult => {
    deps.log(line({ event: 'PRECONDITION_FAILED', reason }));
    return { overall: 'FAILED_PRECONDITION', counts: null, empty: null, error: reason };
  };
  if (!SLUG.test(request.organizationSlug)) {
    return refuse('--organization must be lowercase letters, digits and hyphens');
  }
  const org = await deps.organizations.findBySlug(request.organizationSlug);
  if (!org) return refuse('unknown organization');

  const c = await deps.identities.footprint(org.id);
  const empty = isEmptyFootprint(c);
  deps.log(line({
    event: 'IDENTITIES',
    organization: org.slug,
    TOTAL: c.identities.total,
    PARTY_TYPED: c.identities.partyTyped,
    ARCHIVED: c.identities.archived,
    DUPLICATE_KEY_GROUPS: c.identities.duplicateKeyGroups,
    DUPLICATE_KEY_ROWS: c.identities.duplicateKeyRows,
    ...nonZero('TYPE_', c.identities.byEntityType),
    ...nonZero('STATUS_', c.identities.byStatus),
  }));
  deps.log(line({
    event: 'SATELLITES',
    ROLES: c.satellites.roles,
    EVIDENCE: c.satellites.evidence,
    REVOKED_EVIDENCE: c.satellites.revokedEvidence,
    RESOLUTION_LINKS: c.satellites.resolutionLinks,
    RELATIONSHIPS: c.satellites.relationships,
    ...nonZero('EVIDENCE_', c.satellites.evidenceByType),
    ...nonZero('LINK_STATUS_', c.satellites.linksByStatus),
    ...nonZero('LINK_METHOD_', c.satellites.linksByMethod),
  }));
  deps.log(line({
    event: 'REFERENCES',
    MEMORY_EVENTS_WITH_IDENTITY: c.references.memoryEventsWithIdentity,
    KNOWLEDGE_ASSERTIONS: c.references.knowledgeAssertions,
    ACTIVE_STATE_RECORDS: c.references.activeStateRecords,
    OUTBOX_WITH_IDENTITY: c.references.outboxWithIdentity,
    HYPOTHESES_WITH_SUBJECT: c.references.hypothesesWithSubject,
    DECISIONS_WITH_SUBJECT: c.references.decisionsWithSubject,
    UNRESOLVED_REFERENCES: c.unresolvedReferences,
  }));
  deps.log(line({ event: 'VERDICT', EMPTY: empty, EXCEEDED_BOUND: c.exceededBound, OVERALL_RESULT: 'READ' }));
  return { overall: 'READ', counts: c, empty, error: null };
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

  const { prisma, repositories, IdentityFootprintRepository } = await import('@emgloop/database');
  try {
    const result = await runIdentityFootprint(
      { organizationSlug: args.organization },
      { organizations: repositories.organizations, identities: new IdentityFootprintRepository(prisma), log },
    );
    return result.overall === 'READ' ? 0 : 1;
  } finally {
    await prisma.$disconnect();
  }
}

const ENTRY_POINT = /[\\/]read-identity-footprint\.ts$/;
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
