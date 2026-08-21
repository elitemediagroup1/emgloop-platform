// Recover an explicit historical CallGrid interval.
//
// WHAT IT IS
//
// The same bounded read and the same canonical write path routine polling uses,
// pointed at an interval a person named, and labelled API_RECOVERY so the rows it
// produces are distinguishable forever from traffic that arrived the ordinary way.
// It splits the interval into Eastern business-day chunks and runs them in order,
// stopping at the first chunk that cannot be recovered.
//
// WHAT MAKES IT A RECOVERY RATHER THAN A POLL IS PROVENANCE, AND ONLY PROVENANCE.
// Identity, occurrence, observation, fact convergence, the completeness gate, the
// fail-closed refusal policy and the partial-apply semantics are all the ones
// already shipped. A recovery that ran through its own engine would be a second
// engine, and the platform has spent four PRs removing the last one.
//
// IT CANNOT MOVE ROUTINE COVERAGE. Not by rule -- by construction. This runner
// calls `CallGridPollService.executeRecovery`, which has never had access to a
// checkpoint; routine coverage is advanced by a different service that this file
// does not import and cannot reach. So there is nothing to remember not to do.
//
// NO INCIDENT IS BUILT IN. There is no default interval, no remembered window and
// no date anywhere in this file. The bounds are typed by an operator every time,
// and a run that is not given them does nothing.
//
// WHY BUSINESS-DAY CHUNKS RATHER THAN ONE INTERVAL. The reader would accept the
// whole thing -- 31 days, 50,000 records -- and three things make that the wrong
// shape anyway: the interval is held in memory before any of it is written; ONE
// unmappable provider record fails the whole interval closed, so a single
// malformed row would block the entire recovery instead of one day; and a partial
// apply twenty thousand records in is a state nobody can reason about. Days are
// also the unit the verification afterwards uses, so what was recovered and what
// gets checked are the same unit.
//
// USAGE
//
//   npm run recover:callgrid -- --organization <slug> \
//     --since <ISO instant> --until <ISO instant>
//
// That is a DRY RUN. It reads the provider and reports, per business day, what it
// would create and re-observe. Writing requires --apply, deliberately.
//
// Credentials come from the environment and are never printed:
//   DATABASE_URL       the DIRECT (non-pooled) production endpoint
//   CALLGRID_API_KEY   the provider credential

import { createHash } from 'crypto';
import {
  MAX_RECOVERY_CHUNKS,
  planRecoveryChunks,
  type RecoveryChunk,
} from '@emgloop/shared';
import {
  CALLGRID_POLL_PROVIDER,
  CALLGRID_POLL_STREAM,
  RECOVERY_OBSERVATION_SOURCE,
  pollSucceeded,
  type CallGridPollExecution,
  type CallGridPollInput,
  type CallGridPollObserver,
} from '@emgloop/database';

// --- The seams this file is tested through -----------------------------------

/** The one write-capable operation this runner may perform. */
export interface RecoveryExecutor {
  executeRecovery(
    input: CallGridPollInput,
    observer?: CallGridPollObserver,
  ): Promise<CallGridPollExecution>;
}

/** Read-only organization lookup. This runner may never provision one. */
export interface OrganizationLookup {
  findBySlug(slug: string): Promise<{ id: string; slug: string; name: string; status: string } | null>;
}

export interface RecoveryDeps {
  executor: RecoveryExecutor;
  organizations: OrganizationLookup;
  /** Injected so tests can read every line, and so nothing writes to stdout directly. */
  log: (line: string) => void;
  /** Injected so the caller owns the clock. Used for elapsed time and nothing else. */
  now: () => Date;
}

export interface RecoveryRequest {
  organizationSlug: string;
  since: Date;
  until: Date;
  apiKey: string;
  /** TRUE performs zero mutations. The default everywhere, including main(). */
  dryRun: boolean;
}

/**
 * How a whole recovery ended.
 *
 * A RECOVERY IS ALL-OR-IT-SAYS-SO. There is no outcome meaning "mostly": a run
 * that stopped part-way through its chunks names the chunk it stopped on and
 * reports how many were never attempted.
 */
export const RECOVERY_RESULTS = [
  /** Every chunk was read and reported. Nothing was written. */
  'DRY_RUN_READY',
  /** Every chunk was read completely and applied. */
  'RECOVERED',
  /** As RECOVERED, and at least one provider fact disagreed with what Loop holds. */
  'RECOVERED_WITH_CONFLICTS',
  /** Some chunks are live and a later one could not be recovered. */
  'PARTIALLY_RECOVERED',
  /** The first chunk could not be recovered. Nothing is live. */
  'NOT_RECOVERED',
  /** Refused before reading anything: bad bounds, unknown organization, no credential. */
  'REFUSED',
] as const;

export type RecoveryResult = (typeof RECOVERY_RESULTS)[number];

export interface ChunkOutcome {
  businessDate: string;
  since: string;
  until: string;
  partialDay: boolean;
  outcome: string;
  providerRecordsFetched: number;
  newEvents: number;
  duplicateObservations: number;
  strengthenedCalls: number;
  conflicts: number;
  refusedRecords: number;
  failedProcessing: number;
  notAttempted: number;
  recovered: boolean;
}

export interface RecoveryRunResult {
  overall: RecoveryResult;
  organizationSlug: string;
  since: string;
  until: string;
  dryRun: boolean;
  chunks: ChunkOutcome[];
  /** Chunks planned but never attempted, because an earlier one stopped the run. */
  chunksNotAttempted: number;
  /** Set on every non-success. One sentence, never a credential. */
  reason: string | null;
  elapsedMs: number;
}

// --- Input validation ---------------------------------------------------------

/** Organization statuses this tool refuses to operate against. */
export const REFUSED_ORGANIZATION_STATUSES = ['SUSPENDED', 'CANCELED'] as const;

/**
 * An instant, or nothing.
 *
 * REQUIRES AN EXPLICIT OFFSET, for the same reason the manual poll does: a bare
 * date or a zoneless time is midnight somewhere, and which somewhere depends on
 * the machine that happened to run the job. A recovery pointed at an interval
 * nobody chose is worse than one that refuses to start.
 */
export function parseInstant(raw: string): Date | null {
  const value = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return null;
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms);
}

/** Names of the environment values this run needs. Values are never returned. */
export interface RequiredEnvironment {
  databaseUrl: string;
  apiKey: string;
}

/** Resolve required credentials, or say which are missing BY NAME ONLY. */
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

export interface ParsedArgs {
  organization: string;
  since: string;
  until: string;
  /** TRUE unless --apply was given. Contradictory flags set `contradiction`. */
  dryRun: boolean;
  contradiction: boolean;
}

/**
 * Minimal flag parsing. Deliberately not a CLI framework.
 *
 * DRY RUN IS THE DEFAULT and writing is spelled `--apply`, matching the manual
 * bounded poll. A recovery writes more rows than anything else in this platform
 * and it must not be able to happen because somebody forgot a flag.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  let organization = '';
  let since = '';
  let until = '';
  let apply = false;
  let dryRunFlag = false;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1] ?? '';
    if (flag === '--organization' || flag === '--org') {
      organization = value.trim();
      i += 1;
    } else if (flag === '--since') {
      since = value.trim();
      i += 1;
    } else if (flag === '--until') {
      until = value.trim();
      i += 1;
    } else if (flag === '--apply') {
      apply = true;
    } else if (flag === '--dry-run') {
      dryRunFlag = true;
    }
  }
  return { organization, since, until, dryRun: !apply, contradiction: apply && dryRunFlag };
}

// --- Reporting -----------------------------------------------------------------

function line(fields: Record<string, string | number | boolean | null>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${k}=${v === null ? '' : String(v)}`)
    .join(' ');
}

/**
 * A stable, non-reversible handle for one provider record.
 *
 * The raw CallGrid identity is deliberately not printed, for the same reason the
 * manual poll withholds it: a log line needs enough to correlate two mentions of
 * one record, and the durable evidence for a conflict is a
 * `provider_fact_revisions` row that carries the real identity inside the
 * database, already scoped to a tenant.
 */
export function identityDigest(externalId: string): string {
  return createHash('sha256').update(externalId).digest('hex').slice(0, 12);
}

// --- The run ------------------------------------------------------------------

/**
 * Recover each business-day chunk in order, stopping at the first that fails.
 *
 * SEQUENTIAL, AND IT STOPS. A recovery that kept going past a chunk it could not
 * read would produce a range that looks worked through and has a hole in it --
 * which is the exact shape of the incident being recovered. Every later chunk is
 * left untouched and reported as not attempted, so an operator can see where
 * reality stopped matching the plan and re-run from there.
 */
export async function runRecovery(
  request: RecoveryRequest,
  deps: RecoveryDeps,
): Promise<RecoveryRunResult> {
  const startedAt = deps.now().getTime();
  const result: RecoveryRunResult = {
    overall: 'REFUSED',
    organizationSlug: request.organizationSlug,
    since: request.since.toISOString(),
    until: request.until.toISOString(),
    dryRun: request.dryRun,
    chunks: [],
    chunksNotAttempted: 0,
    reason: null,
    elapsedMs: 0,
  };
  const finish = (): RecoveryRunResult => {
    result.elapsedMs = deps.now().getTime() - startedAt;
    deps.log(
      line({
        event: 'SUMMARY',
        ORGANIZATION: result.organizationSlug,
        SINCE: result.since,
        UNTIL: result.until,
        DRY_RUN: result.dryRun,
        OBSERVATION_SOURCE: RECOVERY_OBSERVATION_SOURCE,
        CHUNKS_PLANNED: result.chunks.length + result.chunksNotAttempted,
        CHUNKS_RECOVERED: result.chunks.filter((c) => c.recovered).length,
        CHUNKS_NOT_ATTEMPTED: result.chunksNotAttempted,
        PROVIDER_RECORDS_FETCHED: result.chunks.reduce((n, c) => n + c.providerRecordsFetched, 0),
        NEW_EVENTS: result.chunks.reduce((n, c) => n + c.newEvents, 0),
        DUPLICATE_OBSERVATIONS: result.chunks.reduce((n, c) => n + c.duplicateObservations, 0),
        STRENGTHENED_CALLS: result.chunks.reduce((n, c) => n + c.strengthenedCalls, 0),
        CONFLICTS: result.chunks.reduce((n, c) => n + c.conflicts, 0),
        FAILED_PROCESSING: result.chunks.reduce((n, c) => n + c.failedProcessing, 0),
        ELAPSED_MS: result.elapsedMs,
        OVERALL_RESULT: result.overall,
      }),
    );
    return result;
  };
  const refuse = (reason: string): RecoveryRunResult => {
    result.overall = 'REFUSED';
    result.reason = reason;
    deps.log(line({ event: 'PRECONDITION_FAILED', reason }));
    return finish();
  };

  if (!request.organizationSlug) return refuse('--organization <slug> is required.');
  if (!request.apiKey) return refuse('No provider credential was supplied.');

  // THE CHUNK PLAN IS JUDGED BEFORE ANYTHING IS READ. Bad bounds, a reversed
  // interval or a span wide enough to be a backfill all refuse here, with nothing
  // attempted.
  const plan = planRecoveryChunks(request.since, request.until);
  if (!plan.ok) return refuse(plan.reason);

  const organization = await deps.organizations.findBySlug(request.organizationSlug);
  if (!organization) {
    // NOT-FOUND, not forbidden, and never provisioned.
    return refuse(`No organization with slug "${request.organizationSlug}".`);
  }
  if ((REFUSED_ORGANIZATION_STATUSES as readonly string[]).includes(organization.status)) {
    return refuse(`Organization "${organization.slug}" is ${organization.status}.`);
  }

  deps.log(
    line({
      event: 'RECOVERY_START',
      organization: organization.slug,
      organizationName: organization.name,
      provider: CALLGRID_POLL_PROVIDER,
      stream: CALLGRID_POLL_STREAM,
      since: result.since,
      until: result.until,
      chunks: plan.chunks.length,
      maxChunks: MAX_RECOVERY_CHUNKS,
      businessDates: plan.chunks.map((c) => c.businessDate).join(','),
      observationSource: RECOVERY_OBSERVATION_SOURCE,
      dryRun: request.dryRun,
      note: 'The routine polling checkpoint is not reachable from this operation.',
    }),
  );

  for (let index = 0; index < plan.chunks.length; index += 1) {
    const chunk = plan.chunks[index];
    if (!chunk) continue;
    const outcome = await oneChunk(chunk, organization.id, request, deps);
    result.chunks.push(outcome);
    if (!outcome.recovered) {
      result.chunksNotAttempted = plan.chunks.length - index - 1;
      const applied = result.chunks.filter((c) => c.recovered).length;
      result.overall = applied > 0 ? 'PARTIALLY_RECOVERED' : 'NOT_RECOVERED';
      result.reason =
        `Chunk ${chunk.businessDate} ended ${outcome.outcome}. ` +
        `${result.chunksNotAttempted} later chunk(s) were left untouched.`;
      deps.log(
        line({
          event: 'RECOVERY_STOPPED',
          businessDate: chunk.businessDate,
          outcome: outcome.outcome,
          chunksRecovered: applied,
          chunksNotAttempted: result.chunksNotAttempted,
          note: 'Re-running the identical interval is safe: recovered chunks re-observe.',
        }),
      );
      return finish();
    }
  }

  if (request.dryRun) {
    result.overall = 'DRY_RUN_READY';
    result.reason = 'Nothing was written. Re-run with --apply to recover.';
  } else {
    const conflicts = result.chunks.reduce((n, c) => n + c.conflicts, 0);
    result.overall = conflicts > 0 ? 'RECOVERED_WITH_CONFLICTS' : 'RECOVERED';
    if (conflicts > 0) {
      result.reason =
        `${conflicts} provider fact(s) disagreed with what Loop already holds. ` +
        'No canonical value was moved for any of them; each is recorded as a revision.';
    }
  }
  return finish();
}

async function oneChunk(
  chunk: RecoveryChunk,
  organizationId: string,
  request: RecoveryRequest,
  deps: RecoveryDeps,
): Promise<ChunkOutcome> {
  deps.log(
    line({
      event: 'CHUNK_START',
      businessDate: chunk.businessDate,
      since: chunk.since.toISOString(),
      until: chunk.until.toISOString(),
      partialDay: chunk.partialDay,
    }),
  );

  const observer: CallGridPollObserver = {
    onStrengthened: (info) =>
      deps.log(
        line({
          event: 'CALL_STRENGTHENED',
          businessDate: chunk.businessDate,
          index: info.index,
          identity: info.identityDigest,
          facts: info.facts.join(','),
        }),
      ),
    onConflict: (info) =>
      deps.log(
        line({
          event: 'FACT_CONFLICT',
          businessDate: chunk.businessDate,
          index: info.index,
          identity: info.identityDigest,
          facts: info.facts.join(','),
          note: 'The canonical value did NOT move. A revision row records the disagreement.',
        }),
      ),
    onProgress: (info) =>
      deps.log(
        line({
          event: 'PROGRESS',
          businessDate: chunk.businessDate,
          done: info.done,
          of: info.of,
          created: info.created,
          reObserved: info.reObserved,
        }),
      ),
    onFailure: (info) =>
      deps.log(
        line({
          event: 'RECORD_FAILED',
          businessDate: chunk.businessDate,
          index: info.index,
          identity: info.identityDigest,
          applied: info.applied,
          notAttempted: info.notAttempted,
          detail: info.detail,
        }),
      ),
  };

  const execution = await deps.executor.executeRecovery(
    {
      organizationId,
      apiKey: request.apiKey,
      since: chunk.since,
      until: chunk.until,
      dryRun: request.dryRun,
    },
    observer,
  );

  for (const refusal of execution.refusals) {
    deps.log(
      line({
        event: 'RECORD_REFUSED',
        businessDate: chunk.businessDate,
        page: refusal.page,
        kind: refusal.kind ?? '',
        reason: refusal.reason,
      }),
    );
  }

  // A CHUNK COUNTS AS RECOVERED ONLY IF THE POLL VOCABULARY SAYS SO. In a dry run
  // that means DRY_RUN_READY -- the read completed and every record was
  // classified -- and in an apply it means the interval was read completely and
  // every record applied. `pollSucceeded` is the shared rule, so an outcome added
  // to the vocabulary later is judged by both this file and the poll on the same
  // day rather than falling through a hard-coded list.
  const recovered = pollSucceeded(execution.outcome);

  const outcome: ChunkOutcome = {
    businessDate: chunk.businessDate,
    since: chunk.since.toISOString(),
    until: chunk.until.toISOString(),
    partialDay: chunk.partialDay,
    outcome: execution.outcome,
    providerRecordsFetched: execution.providerRecordsFetched,
    newEvents: execution.newEvents,
    duplicateObservations: execution.duplicateObservations,
    strengthenedCalls: execution.strengthenedCalls,
    conflicts: execution.conflicts,
    refusedRecords: execution.refusedRecords,
    failedProcessing: execution.failedProcessing,
    notAttempted: execution.notAttempted,
    recovered,
  };

  deps.log(
    line({
      event: 'CHUNK_RESULT',
      businessDate: chunk.businessDate,
      outcome: execution.outcome,
      fetchOutcome: execution.fetchOutcome ?? '',
      recovered: recovered ? 'YES' : 'NO',
      providerRecordsFetched: execution.providerRecordsFetched,
      acceptedRecords: execution.acceptedRecords,
      refusedRecords: execution.refusedRecords,
      newEvents: execution.newEvents,
      duplicateObservations: execution.duplicateObservations,
      strengthenedCalls: execution.strengthenedCalls,
      conflicts: execution.conflicts,
      failedProcessing: execution.failedProcessing,
      notAttempted: execution.notAttempted,
      pages: execution.pages,
      rateLimitRetries: execution.rateLimitRetries,
      failedAtIndex: execution.failedAtIndex,
      failedIdentity: execution.failedIdentityDigest ?? '',
      reason: execution.reason ?? '',
    }),
  );
  return outcome;
}

// --- Wiring -------------------------------------------------------------------

async function main(): Promise<number> {
  const log = (l: string) => process.stdout.write(l + '\n');

  const args = parseArgs(process.argv.slice(2));
  if (args.contradiction) {
    log(line({ event: 'PRECONDITION_FAILED', reason: '--apply and --dry-run are contradictory' }));
    return 2;
  }
  if (!args.organization) {
    log(line({ event: 'PRECONDITION_FAILED', reason: '--organization <slug> is required' }));
    return 2;
  }
  const since = parseInstant(args.since);
  const until = parseInstant(args.until);
  if (!since || !until) {
    log(
      line({
        event: 'PRECONDITION_FAILED',
        reason: '--since and --until must be explicit instants, e.g. 2026-01-15T05:00:00Z',
        since: args.since,
        until: args.until,
      }),
    );
    return 2;
  }

  const env = readEnvironment(process.env);
  if (!env.ok) {
    log(line({ event: 'PRECONDITION_FAILED', reason: 'missing environment', missing: env.missing.join(',') }));
    return 2;
  }

  // Imported here rather than at module scope so the pure orchestration above can
  // be tested without a database client being constructed as a side effect.
  const { prisma, repositories, CallGridPollService } = await import('@emgloop/database');

  try {
    const result = await runRecovery(
      {
        organizationSlug: args.organization,
        since,
        until,
        apiKey: env.value.apiKey,
        dryRun: args.dryRun,
      },
      {
        // THE SAME PRIMITIVE THE MANUAL POLL AND THE ADMIN SYNC USE, through its
        // recovery entry point. Not a variant of it, and not a copy.
        executor: new CallGridPollService(prisma),
        organizations: repositories.organizations,
        log,
        now: () => new Date(),
      },
    );
    return result.overall === 'DRY_RUN_READY' ||
      result.overall === 'RECOVERED' ||
      result.overall === 'RECOVERED_WITH_CONFLICTS'
      ? 0
      : 1;
  } finally {
    await prisma.$disconnect();
  }
}

// Executed only when run directly, so importing this file does not start a
// recovery. The match is ANCHORED to the exact filename.
const ENTRY_POINT = /[\\/]recover-callgrid-interval\.ts$/;
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
