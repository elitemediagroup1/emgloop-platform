// Read membership coverage -- CRM Phase Zero P0.2b.
//
// READ-ONLY, COUNTS ONLY. For one organization, compares every User row with the
// OrganizationMembership row it implies and prints aggregate counts. It writes
// nothing, backfills nothing, repairs nothing and prints no id, email or name.
//
// THE QUESTION IT ANSWERS. P0.2c moves session and permission authority from the
// User row to membership. That is only truthful if every User who can act today
// has the membership that says so. The P0.2b migration backfills memberships once;
// application code keeps them in step afterwards. Two things can still leave a
// gap, and only production can say whether they did:
//
//   - a User lifecycle write made by the previous deploy in the window between
//     the migration running and the new code going live;
//   - a User row whose role or status the backfill refused to guess about.
//
// `READY_FOR_AUTHORITY=true` means neither happened in this organization: no
// missing membership, no role or status disagreement, no orphan, nothing
// underivable and no removed marker on a user who is not disabled. Anything else
// is a fact for a human to decide about, never something this runner fixes.
//
// NO SCHEDULE, NO PUSH, NO PULL_REQUEST, NO WORKFLOW_CALL. Reading production is
// still touching production, and a human should be the one asking.

/** Read-only organization lookup. This runner may never provision one. */
export interface OrganizationLookup {
  findBySlug(slug: string): Promise<{ id: string; slug: string } | null>;
}

/** The counts-only comparison `MembershipRepository.coverage` returns. */
export interface MembershipCoverageCounts {
  users: number;
  memberships: number;
  missingMemberships: number;
  roleMismatches: number;
  statusMismatches: number;
  underivableRole: number;
  underivableStatus: number;
  removedMarkerNotDisabled: number;
  orphanMemberships: number;
}

export interface CoverageReader {
  coverage(organizationId: string): Promise<MembershipCoverageCounts>;
}

export interface MembershipCoverageDeps {
  organizations: OrganizationLookup;
  memberships: CoverageReader;
  log: (line: string) => void;
}

export interface MembershipCoverageResult {
  overall: 'READ' | 'FAILED_PRECONDITION';
  counts: MembershipCoverageCounts | null;
  readyForAuthority: boolean;
  error: string | null;
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Names of the environment values this run needs. Values are never returned. */
export function readEnvironment(
  env: NodeJS.ProcessEnv,
): { ok: true } | { ok: false; missing: string[] } {
  return env.DATABASE_URL?.trim() ? { ok: true } : { ok: false, missing: ['DATABASE_URL'] };
}

/** Minimal flag parsing. Deliberately not a CLI framework. */
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

function line(fields: Record<string, string | number | boolean | null>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${k}=${v === null ? '' : String(v)}`)
    .join(' ');
}

/** Whether authority can move to membership in this organization without anyone losing or gaining access. */
export function readyForAuthority(c: MembershipCoverageCounts): boolean {
  return (
    c.missingMemberships === 0 &&
    c.roleMismatches === 0 &&
    c.statusMismatches === 0 &&
    c.orphanMemberships === 0 &&
    c.underivableRole === 0 &&
    c.underivableStatus === 0 &&
    c.removedMarkerNotDisabled === 0
  );
}

export async function runMembershipCoverage(
  request: { organizationSlug: string },
  deps: MembershipCoverageDeps,
): Promise<MembershipCoverageResult> {
  const refuse = (reason: string): MembershipCoverageResult => {
    deps.log(line({ event: 'PRECONDITION_FAILED', reason }));
    return { overall: 'FAILED_PRECONDITION', counts: null, readyForAuthority: false, error: reason };
  };
  if (!SLUG.test(request.organizationSlug)) {
    return refuse('--organization must be lowercase letters, digits and hyphens');
  }
  const org = await deps.organizations.findBySlug(request.organizationSlug);
  if (!org) return refuse('unknown organization');

  const counts = await deps.memberships.coverage(org.id);
  const ready = readyForAuthority(counts);
  deps.log(
    line({
      event: 'MEMBERSHIP_COVERAGE',
      organization: org.slug,
      USERS: counts.users,
      MEMBERSHIPS: counts.memberships,
      MISSING_MEMBERSHIPS: counts.missingMemberships,
      ROLE_MISMATCHES: counts.roleMismatches,
      STATUS_MISMATCHES: counts.statusMismatches,
      ORPHAN_MEMBERSHIPS: counts.orphanMemberships,
      UNDERIVABLE_ROLE: counts.underivableRole,
      UNDERIVABLE_STATUS: counts.underivableStatus,
      REMOVED_MARKER_NOT_DISABLED: counts.removedMarkerNotDisabled,
    }),
  );
  deps.log(line({ event: 'VERDICT', READY_FOR_AUTHORITY: ready, OVERALL_RESULT: 'READ' }));
  return { overall: 'READ', counts, readyForAuthority: ready, error: null };
}

// --- Wiring -------------------------------------------------------------------
//
// Everything above is pure over two injected seams, which is what the tests
// drive. Below is the only place real dependencies are constructed.

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

  // Imported here so the aggregation above can be tested without a database client.
  const { prisma, repositories } = await import('@emgloop/database');
  try {
    const result = await runMembershipCoverage(
      { organizationSlug: args.organization },
      { organizations: repositories.organizations, memberships: repositories.memberships, log },
    );
    // A gap is an ANSWER, not a failure: a red run would make an inspection tool
    // look like a gate. Only a failed precondition exits non-zero.
    return result.overall === 'READ' ? 0 : 1;
  } finally {
    await prisma.$disconnect();
  }
}

// Executed only when run directly; the match is anchored to the exact filename so
// importing this file from its test starts nothing.
const ENTRY_POINT = /[\\/]read-membership-coverage\.ts$/;
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
