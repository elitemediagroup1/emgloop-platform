// Routine CallGrid polling — the scheduled completeness pass.
//
// WHAT IT IS
//
// One pass over each configured organization: ask the checkpoint what has been
// proven, ask the planner what to read next, run the canonical poll, and record
// coverage only if the poll proved it. It is the thinnest possible front end over
// `CallGridRoutinePollService.run`, which is itself a thin coordinator over
// components that already existed.
//
// IT DECIDES ALMOST NOTHING, AND THE LIST IS SHORT ON PURPOSE:
//
//   which organizations   from an explicit configured list, never inferred
//   what to print         structured lines, no payload and no identity
//   what the exit code is the difference between "the process ran" and
//                         "provider coverage was proven"
//
// Everything else is somewhere else and must stay there: the overlap, the
// bootstrap lookback, the safety lag and the span ceiling belong to
// `planPollInterval`; completeness, the refusal policy and the apply loop belong
// to `CallGridPollService.execute`; identity, occurrence, provenance and fact
// convergence belong to ingestion; and monotonic advancement belongs to the
// checkpoint repository. There are assertions saying this file reaches none of
// them.
//
// IT IS NOT RECOVERY. Every interval it reads is chosen by the planner from the
// durable checkpoint. There is no `--since`, no `--until` and no date anywhere in
// this file, so there is no way to point it at a historical window -- not by
// argument, not by workflow input, not by accident. Recovering the August outage
// is a different operation with a different provenance label and a person behind
// it, and it stays that way.
//
// WHY A RED RUN IS NOT AN ALERT HERE, AND WHAT THIS FILE DOES ABOUT IT
//
// `drain-outbox.yml` is this repository's only other scheduled workflow. Its last
// hundred runs all failed, for months, because two secrets were never set --
// nobody was watching the colour of a scheduled job. Exiting non-zero is
// necessary and is demonstrably not sufficient. So every run also prints
// COVERAGE_LAG_MS: how far behind the clock proven coverage now sits. That number
// comes from a durable row rather than from a run's exit status, it is wrong in
// exactly one direction, and it is the thing an external alert should watch.
//
// USAGE
//
//   npm run poll:callgrid-routine -- --organizations <slug>[,<slug>]
//
// Credentials come from the environment and are never printed:
//   DATABASE_URL       the DIRECT (non-pooled) production endpoint
//   CALLGRID_API_KEY   the provider credential

import {
  DEFAULT_COVERAGE_HEALTH_POLICY,
  assessCoverageHealth,
} from '@emgloop/shared';
import {
  CALLGRID_POLL_POLICY,
  CALLGRID_POLL_PROVIDER,
  CALLGRID_POLL_STREAM,
  checkpointMayAdvance,
  type RoutinePollResult,
} from '@emgloop/database';

// --- The seams this file is tested through -----------------------------------
//
// Two capabilities: run one routine pass for a resolved organization, and look an
// organization up. It cannot reach a Prisma model, a provider client, ingestion,
// a planner or a checkpoint directly.

/** The one operation this runner may perform. */
export interface RoutinePoller {
  run(input: { organizationId: string; apiKey: string; now: Date }): Promise<RoutinePollResult>;
}

/** Read-only organization lookup. This runner may never provision one. */
export interface OrganizationLookup {
  findBySlug(slug: string): Promise<{ id: string; slug: string; name: string; status: string } | null>;
}

export interface RoutineDeps {
  poller: RoutinePoller;
  organizations: OrganizationLookup;
  /** Injected so tests can read every line, and so nothing writes to stdout directly. */
  log: (line: string) => void;
  /** Injected so the caller owns the clock. */
  now: () => Date;
}

export interface RoutineRequest {
  organizationSlugs: readonly string[];
  apiKey: string;
}

/**
 * What one organization's pass did.
 *
 * TWO OF THESE ARE SUCCESSES AND FOUR ARE NOT, and the difference is never
 * "did the process throw". A pass that ran perfectly and could not prove coverage
 * is a failure of the thing this job exists to do.
 */
export const ROUTINE_RESULTS = [
  /** The poll proved the interval and the checkpoint moved to its upper bound. */
  'COVERAGE_ADVANCED',
  /** The poll proved it and another run had already proven at least as much. */
  'COVERAGE_ALREADY_PROVEN',
  /** The poll ran and did not prove the interval. Nothing moved. */
  'COVERAGE_NOT_ADVANCED',
  /** The poll proved it and the checkpoint did NOT reach the boundary. */
  'CHECKPOINT_BEHIND_POLL',
  /** The planner declined to propose an interval at all. */
  'NOTHING_PLANNED',
  /** The organization could not be resolved, or refused. */
  'PRECONDITION_FAILED',
] as const;

export type RoutineResult = (typeof ROUTINE_RESULTS)[number];

/** Outcomes that mean provider coverage is proven up to date. Nothing else does. */
export function routineSucceeded(result: RoutineResult): boolean {
  return result === 'COVERAGE_ADVANCED' || result === 'COVERAGE_ALREADY_PROVEN';
}

export interface OrganizationPass {
  organizationSlug: string;
  result: RoutineResult;
  /** How far behind the clock proven coverage sits, after this pass. */
  coverageLagMs: number | null;
  reason: string;
}

export interface RoutineRunResult {
  /** The worst pass, because one organization failing is the run failing. */
  overall: RoutineResult;
  passes: OrganizationPass[];
  elapsedMs: number;
}

// --- Input validation ---------------------------------------------------------

/** Organization statuses this tool refuses to operate against. */
export const REFUSED_ORGANIZATION_STATUSES = ['SUSPENDED', 'CANCELED'] as const;

/** Names of the environment values this run needs. Values are never returned. */
export interface RequiredEnvironment {
  databaseUrl: string;
  apiKey: string;
}

/**
 * Resolve required credentials, or say which are missing BY NAME ONLY.
 *
 * CALLGRID_API_KEY IS NOT CALLGRID_WEBHOOK_SECRET. They authenticate different
 * things in different directions -- one is Loop calling CallGrid, the other is
 * CallGrid calling Loop -- and a fallback between them would be a credential
 * confusion bug wearing a convenience.
 */
export function readEnvironment(
  env: NodeJS.ProcessEnv,
): { ok: true; value: RequiredEnvironment } | { ok: false; missing: string[] } {
  const missing: string[] = [];
  const databaseUrl = env.DATABASE_URL?.trim() || '';
  const apiKey = env.CALLGRID_API_KEY?.trim() || '';
  if (!databaseUrl) missing.push('DATABASE_URL');
  if (!apiKey) missing.push('CALLGRID_API_KEY');
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, value: { databaseUrl, apiKey } };
}

/**
 * Parse the configured organization list.
 *
 * A LIST, THOUGH TODAY IT HOLDS ONE. Making it plural costs nothing and keeps
 * multi-organization scheduling a configuration change rather than a rewrite.
 * It does NOT mean routine polling is multi-tenant: `integration_events` is still
 * uniquely keyed `(provider, externalId)` globally, so two organizations polling
 * the same CallGrid account would collide on identity. That is the platform's
 * known tenancy debt and this runner does not pretend to have fixed it.
 */
export function parseOrganizations(raw: string): string[] {
  const seen = new Set<string>();
  for (const segment of raw.split(',')) {
    const slug = segment.trim();
    if (slug !== '') seen.add(slug);
  }
  return [...seen];
}

/** Minimal flag parsing. Deliberately not a CLI framework. */
export function parseArgs(argv: readonly string[]): { organizations: string } {
  let organizations = '';
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--organizations' || flag === '--organization' || flag === '--org') {
      organizations = (argv[i + 1] ?? '').trim();
      i += 1;
    }
  }
  return { organizations };
}

// --- Reporting -----------------------------------------------------------------

function line(fields: Record<string, string | number | boolean | null>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${k}=${v === null ? '' : String(v)}`)
    .join(' ');
}

/** The worst of a set of results, so one bad organization fails the run. */
export function worstResult(results: readonly RoutineResult[]): RoutineResult {
  let worst: RoutineResult = 'COVERAGE_ADVANCED';
  for (const result of results) {
    if (ROUTINE_RESULTS.indexOf(result) > ROUTINE_RESULTS.indexOf(worst)) worst = result;
  }
  return worst;
}

// --- The pass ------------------------------------------------------------------

/**
 * Run one routine pass per configured organization, in order.
 *
 * SEQUENTIAL BY CONSTRUCTION. There is no `Promise.all` here and there must never
 * be one: each pass is a bounded run of provider requests followed by thousands of
 * ingestion writes, and running several at once would multiply provider load on an
 * API already observed returning 429, for no operator benefit.
 */
export async function runRoutine(
  request: RoutineRequest,
  deps: RoutineDeps,
): Promise<RoutineRunResult> {
  const startedAt = deps.now().getTime();
  const passes: OrganizationPass[] = [];

  deps.log(
    line({
      event: 'ROUTINE_START',
      provider: CALLGRID_POLL_PROVIDER,
      stream: CALLGRID_POLL_STREAM,
      organizations: request.organizationSlugs.join(','),
      count: request.organizationSlugs.length,
      // Stated every run so the policy in force is visible beside its effects,
      // rather than being something a reader has to go and look up.
      overlapMs: CALLGRID_POLL_POLICY.overlapMs,
      bootstrapLookbackMs: CALLGRID_POLL_POLICY.bootstrapLookbackMs,
      safetyLagMs: CALLGRID_POLL_POLICY.safetyLagMs,
    }),
  );

  if (request.organizationSlugs.length === 0) {
    const reason = 'No organizations are configured for routine polling.';
    passes.push({ organizationSlug: '', result: 'PRECONDITION_FAILED', coverageLagMs: null, reason });
    deps.log(line({ event: 'PRECONDITION_FAILED', reason }));
    return finish(passes, startedAt, deps);
  }

  for (const slug of request.organizationSlugs) {
    passes.push(await onePass(slug, request.apiKey, deps));
  }

  return finish(passes, startedAt, deps);
}

async function onePass(slug: string, apiKey: string, deps: RoutineDeps): Promise<OrganizationPass> {
  const organization = await deps.organizations.findBySlug(slug);
  if (!organization) {
    // NOT-FOUND, not forbidden, and never provisioned.
    const reason = `No organization with slug "${slug}".`;
    deps.log(line({ event: 'PASS_REFUSED', organization: slug, reason }));
    return { organizationSlug: slug, result: 'PRECONDITION_FAILED', coverageLagMs: null, reason };
  }
  if ((REFUSED_ORGANIZATION_STATUSES as readonly string[]).includes(organization.status)) {
    const reason = `Organization "${organization.slug}" is ${organization.status}.`;
    deps.log(line({ event: 'PASS_REFUSED', organization: slug, reason }));
    return { organizationSlug: slug, result: 'PRECONDITION_FAILED', coverageLagMs: null, reason };
  }

  const now = deps.now();
  const outcome = await deps.poller.run({ organizationId: organization.id, apiKey, now });
  const plan = outcome.plan;
  const execution = outcome.execution;

  deps.log(
    line({
      event: 'PASS_RESULT',
      organization: organization.slug,
      checkpointBefore: outcome.checkpointBefore?.toISOString() ?? '',
      plan: plan.plan,
      basis: plan.basis,
      since: plan.plan === 'POLL' ? plan.since.toISOString() : '',
      until: plan.plan === 'POLL' ? plan.until.toISOString() : '',
      cappedBySpan: plan.plan === 'POLL' ? plan.cappedBySpan : '',
      pollOutcome: execution?.outcome ?? '',
      fetchOutcome: execution?.fetchOutcome ?? '',
      providerRecordsFetched: execution?.providerRecordsFetched ?? 0,
      acceptedRecords: execution?.acceptedRecords ?? 0,
      refusedRecords: execution?.refusedRecords ?? 0,
      newEvents: execution?.newEvents ?? 0,
      duplicateObservations: execution?.duplicateObservations ?? 0,
      strengthenedCalls: execution?.strengthenedCalls ?? 0,
      conflicts: execution?.conflicts ?? 0,
      failedProcessing: execution?.failedProcessing ?? 0,
      notAttempted: execution?.notAttempted ?? 0,
      pages: execution?.pages ?? 0,
      rateLimitRetries: execution?.rateLimitRetries ?? 0,
      advancement: outcome.advancement,
      checkpointAfter: outcome.checkpointAfter?.toISOString() ?? '',
    }),
  );

  const result = classify(outcome);
  // THE SAME RULE THE HEALTH ENDPOINT APPLIES. A run and an external watcher
  // disagreeing about whether coverage is late would mean whichever one somebody
  // happened to look at decided the answer.
  const health = assessCoverageHealth({
    completedThrough: outcome.checkpointAfter,
    now,
    policy: DEFAULT_COVERAGE_HEALTH_POLICY,
  });
  const coverageLagMs = health.lagMs;

  deps.log(
    line({
      event: 'COVERAGE',
      organization: organization.slug,
      COVERAGE_STATUS: health.status,
      // THE NUMBER AN ALERT SHOULD WATCH. It comes from a durable row rather than
      // from this run's exit status, so it stays true when nobody is looking at
      // the colour of a scheduled job -- which is the failure mode that left the
      // outbox drain red for a hundred consecutive runs. It is also what
      // /api/internal/coverage/health serves to an external watcher, so a poller
      // that STOPS RUNNING is visible without this line ever being printed.
      COVERAGE_LAG_MS: coverageLagMs,
      coverageProvenThrough: outcome.checkpointAfter?.toISOString() ?? '',
      result,
    }),
  );

  return { organizationSlug: organization.slug, result, coverageLagMs, reason: outcome.reason };
}

/**
 * Turn a routine outcome into a result, refusing to call anything a success it
 * cannot prove.
 *
 * THE POLL OUTCOME IS JUDGED BY THE VOCABULARY'S OWN RULE. `checkpointMayAdvance`
 * is the same predicate the routine service used to decide whether to attempt
 * advancement, so this file cannot come to a different conclusion about what
 * counts as proof, and an outcome added later is refused by both on the same day.
 */
function classify(outcome: RoutinePollResult): RoutineResult {
  if (outcome.plan.plan !== 'POLL') return 'NOTHING_PLANNED';
  if (!outcome.execution || !checkpointMayAdvance(outcome.execution.outcome)) {
    return 'COVERAGE_NOT_ADVANCED';
  }
  // The poll proved the interval. Coverage is only actually recorded if the
  // durable boundary now reaches the interval's exclusive upper bound -- checked
  // against the stored value rather than trusted from the advancement label,
  // because "we asked it to move" and "it moved" are different facts.
  const proven = outcome.checkpointAfter;
  if (!proven || proven.getTime() < outcome.plan.until.getTime()) return 'CHECKPOINT_BEHIND_POLL';
  return outcome.advancement === 'ADVANCED' ? 'COVERAGE_ADVANCED' : 'COVERAGE_ALREADY_PROVEN';
}

function finish(passes: OrganizationPass[], startedAt: number, deps: RoutineDeps): RoutineRunResult {
  const overall = worstResult(passes.map((p) => p.result));
  const elapsedMs = deps.now().getTime() - startedAt;
  const lags = passes.map((p) => p.coverageLagMs).filter((l): l is number => l !== null);
  deps.log(
    line({
      event: 'SUMMARY',
      ORGANIZATIONS: passes.map((p) => p.organizationSlug).join(','),
      ADVANCED: passes.filter((p) => p.result === 'COVERAGE_ADVANCED').length,
      ALREADY_PROVEN: passes.filter((p) => p.result === 'COVERAGE_ALREADY_PROVEN').length,
      NOT_ADVANCED: passes.filter((p) => !routineSucceeded(p.result)).length,
      // The worst lag across the run, so a multi-organization pass cannot hide one
      // stalled tenant behind another that is healthy.
      MAX_COVERAGE_LAG_MS: lags.length > 0 ? Math.max(...lags) : null,
      ELAPSED_MS: elapsedMs,
      OVERALL_RESULT: overall,
    }),
  );
  return { overall, passes, elapsedMs };
}

// --- Wiring -------------------------------------------------------------------
//
// Everything above is pure orchestration over two injected seams, which is what
// the tests drive. Below is the only place real dependencies are constructed.

async function main(): Promise<number> {
  const log = (l: string) => process.stdout.write(l + '\n');

  const args = parseArgs(process.argv.slice(2));
  const organizationSlugs = parseOrganizations(args.organizations);
  if (organizationSlugs.length === 0) {
    log(
      line({
        event: 'PRECONDITION_FAILED',
        reason: '--organizations <slug>[,<slug>] is required',
      }),
    );
    return 2;
  }

  // Credentials first, so a missing one fails before a connection or a request.
  const env = readEnvironment(process.env);
  if (!env.ok) {
    log(line({ event: 'PRECONDITION_FAILED', reason: 'missing environment', missing: env.missing.join(',') }));
    return 2;
  }

  // Imported here rather than at module scope so the pure orchestration above can
  // be tested without a database client being constructed as a side effect.
  const { prisma, repositories, CallGridRoutinePollService } = await import('@emgloop/database');

  try {
    const result = await runRoutine(
      { organizationSlugs, apiKey: env.value.apiKey },
      {
        // THE SAME COORDINATOR PR #187 SHIPPED. It owns the checkpoint lookup, the
        // planner call and the monotonic advancement; this file supplies an
        // organization and a clock.
        poller: new CallGridRoutinePollService(prisma),
        organizations: repositories.organizations,
        log,
        now: () => new Date(),
      },
    );
    return routineSucceeded(result.overall) ? 0 : 1;
  } finally {
    await prisma.$disconnect();
  }
}

// Executed only when run directly, so importing this file does not start a pass.
// The match is ANCHORED to the exact filename: a substring check would fire on
// the test file, whose own name contains this one.
const ENTRY_POINT = /[\\/]poll-callgrid-routine\.ts$/;
if (process.argv[1] && ENTRY_POINT.test(process.argv[1])) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stdout.write(
        line({ event: 'FATAL', detail: error instanceof Error ? error.message : 'unknown' }) + '\n',
      );
      process.exitCode = 1;
    },
  );
}
