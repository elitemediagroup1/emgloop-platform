// Repair removed marker -- restore administrators' removals the legacy demo
// bootstrap undid.
//
// WHAT HAPPENED. Until 2026-07-21 (#134) the demo bootstrap called `activateUser`
// on each seed member on every cold start. Members an administrator had removed
// (DISABLED + `metadata.removedAt`) came back ACTIVE with the marker still set:
// hidden from the Team page by `listUsers`, still able to sign in, and impossible
// to remove from any screen. The Read Membership Coverage gate counts them as
// REMOVED_MARKER_NOT_DISABLED and withholds READY_FOR_AUTHORITY until they are
// resolved.
//
// WHAT THIS DOES. For one organization it finds every such row itself -- no user
// id is typed in, and none is printed, because this repository's workflow logs
// are public -- and applies the deterministic rule in
// `RemovedMarkerRepairRepository`: the member's last lifecycle act was an
// administrator's `user.removed`, with no reactivation, re-invitation or role
// change after it and no invitation since. Rows that pass are removed again
// through the EXISTING governed path -- `IamRepository.softRemoveUser` (which also
// moves the membership to REMOVED), `AuthRepository.revokeAllForUser`, and a
// `user.removed` audit entry that says it was this repair and records the original
// removal marker. Rows that fail are refused with a reason and never touched.
//
// DRY RUN FIRST, AND BY DEFAULT. Anything other than DRY_RUN=false writes nothing.
// A real run additionally refuses unless the eligible count equals
// `--expected` and no candidate was refused: a surprise is a reason to stop and
// look, not to repair the rows that happen to pass.
//
// IDEMPOTENT. A repaired row is DISABLED, so it is no longer a candidate; a rerun
// finds nothing and writes nothing.

export const REPAIR_TAG = 'legacy-bootstrap-resurrection';

export interface Candidate {
  id: string;
  email: string;
  metadata: unknown;
}

export type Assessment =
  | { userId: string; eligible: true; lastRemovalAt: Date; markerValue: unknown }
  | { userId: string; eligible: false; reason: string };

export interface RepairDeps {
  organizations: { findBySlug(slug: string): Promise<{ id: string; slug: string } | null> };
  repair: {
    candidates(organizationId: string): Promise<Candidate[]>;
    assess(organizationId: string, user: Candidate): Promise<Assessment>;
  };
  iam: {
    softRemoveUser(organizationId: string, userId: string): Promise<void>;
    getUser(organizationId: string, id: string): Promise<{ status: string; metadata: unknown } | null>;
  };
  auth: { revokeAllForUser(userId: string): Promise<void> };
  audit: {
    record(args: {
      organizationId: string;
      action: string;
      userId?: string | null;
      actorType?: 'SYSTEM';
      actorName?: string;
      entityType?: string | null;
      entityId?: string | null;
      metadata?: Record<string, unknown>;
    }): Promise<unknown>;
  };
  memberships: {
    coverage(organizationId: string): Promise<{ removedMarkerNotDisabled: number }>;
  };
  log: (line: string) => void;
}

export interface RepairRequest {
  organizationSlug: string;
  expected: number;
  apply: boolean;
}

export interface RepairResult {
  overall: 'DRY_RUN' | 'REPAIRED' | 'FAILED_PRECONDITION' | 'STOPPED';
  candidates: number;
  eligible: number;
  refused: Record<string, number>;
  repaired: number;
  error: string | null;
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

function line(fields: Record<string, string | number | boolean | null>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${k}=${v === null ? '' : String(v)}`)
    .join(' ');
}

function hasMarker(metadata: unknown): boolean {
  return Boolean(
    metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)['removedAt']
      : undefined,
  );
}

/** Only an explicit DRY_RUN=false applies. Anything else, including absent, is a dry run. */
export function readApply(env: NodeJS.ProcessEnv): boolean {
  return env.DRY_RUN === 'false';
}

export function readEnvironment(env: NodeJS.ProcessEnv): { ok: true } | { ok: false; missing: string[] } {
  return env.DATABASE_URL?.trim() ? { ok: true } : { ok: false, missing: ['DATABASE_URL'] };
}

export function parseArgs(argv: readonly string[]): { organization: string; expected: string } {
  let organization = '';
  let expected = '';
  for (let i = 0; i < argv.length; i += 1) {
    const value = (argv[i + 1] ?? '').trim();
    if (argv[i] === '--organization' || argv[i] === '--org') {
      organization = value;
      i += 1;
    } else if (argv[i] === '--expected') {
      expected = value;
      i += 1;
    }
  }
  return { organization, expected };
}

export function parseExpected(raw: string): number | null {
  return /^(0|[1-9][0-9]{0,3})$/.test(raw) ? Number(raw) : null;
}

export async function runRepair(request: RepairRequest, deps: RepairDeps): Promise<RepairResult> {
  const result: RepairResult = {
    overall: request.apply ? 'REPAIRED' : 'DRY_RUN',
    candidates: 0,
    eligible: 0,
    refused: {},
    repaired: 0,
    error: null,
  };
  const refuse = (reason: string): RepairResult => {
    deps.log(line({ event: 'PRECONDITION_FAILED', reason, WROTE: false }));
    return { ...result, overall: 'FAILED_PRECONDITION', error: reason };
  };

  if (!SLUG.test(request.organizationSlug)) return refuse('organization must be lowercase letters, digits and hyphens');
  if (!Number.isInteger(request.expected) || request.expected < 0) return refuse('expected must be a non-negative integer');
  const org = await deps.organizations.findBySlug(request.organizationSlug);
  if (!org) return refuse('unknown organization');

  const candidates = await deps.repair.candidates(org.id);
  const assessed: Array<{ candidate: Candidate; assessment: Assessment }> = [];
  for (const candidate of candidates) {
    assessed.push({ candidate, assessment: await deps.repair.assess(org.id, candidate) });
  }
  result.candidates = candidates.length;
  result.eligible = assessed.filter((a) => a.assessment.eligible).length;
  for (const { assessment } of assessed) {
    if (!assessment.eligible) result.refused[assessment.reason] = (result.refused[assessment.reason] ?? 0) + 1;
  }
  const refusedTotal = Object.values(result.refused).reduce((a, n) => a + n, 0);

  deps.log(line({
    event: 'ASSESSMENT',
    organization: org.slug,
    CANDIDATES: result.candidates,
    ELIGIBLE: result.eligible,
    EXPECTED: request.expected,
    ...Object.fromEntries(Object.entries(result.refused).map(([k, n]) => [`REFUSED_${k}`, n])),
  }));

  if (!request.apply) {
    deps.log(line({
      event: 'VERDICT',
      DRY_RUN: true,
      WOULD_REPAIR: result.eligible,
      MATCHES_EXPECTED: result.eligible === request.expected && refusedTotal === 0,
      WROTE: false,
    }));
    return result;
  }

  if (refusedTotal > 0) return refuse('a candidate was refused; resolve it before repairing any row');
  if (result.eligible !== request.expected) return refuse('eligible count does not equal --expected');
  if (result.eligible === 0) return refuse('nothing to repair');

  for (const { candidate } of assessed) {
    // Re-assess against a fresh read immediately before writing: a human act
    // between the assessment and now wins over this repair.
    const fresh = (await deps.repair.candidates(org.id)).find((c) => c.id === candidate.id);
    const now = fresh ? await deps.repair.assess(org.id, fresh) : null;
    if (!fresh || !now || !now.eligible) {
      deps.log(line({ event: 'STOPPED', reason: 'a candidate changed after assessment', REPAIRED: result.repaired }));
      return { ...result, overall: 'STOPPED', error: 'candidate changed after assessment' };
    }

    await deps.iam.softRemoveUser(org.id, candidate.id);
    const after = await deps.iam.getUser(org.id, candidate.id);
    if (!after || after.status !== 'DISABLED' || !hasMarker(after.metadata)) {
      // No audit entry for a write that did not happen.
      deps.log(line({ event: 'STOPPED', reason: 'removal did not take effect', REPAIRED: result.repaired }));
      return { ...result, overall: 'STOPPED', error: 'removal did not take effect' };
    }
    await deps.auth.revokeAllForUser(candidate.id);
    await deps.audit.record({
      organizationId: org.id,
      userId: null,
      actorType: 'SYSTEM',
      actorName: 'operations: repair-removed-marker',
      action: 'user.removed',
      entityType: 'user',
      entityId: candidate.id,
      metadata: {
        soft: true,
        repair: REPAIR_TAG,
        originalRemovedAt: typeof now.markerValue === 'string' ? now.markerValue : null,
        lastRemovalAuditAt: now.lastRemovalAt.toISOString(),
      },
    });
    result.repaired += 1;
  }

  const coverage = await deps.memberships.coverage(org.id);
  deps.log(line({
    event: 'VERDICT',
    DRY_RUN: false,
    REPAIRED: result.repaired,
    REMOVED_MARKER_NOT_DISABLED_AFTER: coverage.removedMarkerNotDisabled,
    WROTE: true,
  }));
  return result;
}

// --- Wiring -------------------------------------------------------------------

async function main(): Promise<number> {
  const log = (l: string) => process.stdout.write(l + '\n');
  const args = parseArgs(process.argv.slice(2));
  const expected = parseExpected(args.expected);
  if (!args.organization || expected === null) {
    log(line({ event: 'PRECONDITION_FAILED', reason: '--organization <slug> and --expected <n> are required', WROTE: false }));
    return 2;
  }
  const env = readEnvironment(process.env);
  if (!env.ok) {
    log(line({ event: 'PRECONDITION_FAILED', reason: 'missing environment', missing: env.missing.join(','), WROTE: false }));
    return 2;
  }

  const { prisma, repositories, RemovedMarkerRepairRepository } = await import('@emgloop/database');
  try {
    const result = await runRepair(
      { organizationSlug: args.organization, expected, apply: readApply(process.env) },
      {
        organizations: repositories.organizations,
        repair: new RemovedMarkerRepairRepository(prisma),
        iam: repositories.iam,
        auth: repositories.auth,
        audit: repositories.audit,
        memberships: repositories.memberships,
        log,
      },
    );
    return result.overall === 'DRY_RUN' || result.overall === 'REPAIRED' ? 0 : 1;
  } finally {
    await prisma.$disconnect();
  }
}

const ENTRY_POINT = /[\\/]repair-removed-marker\.ts$/;
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
