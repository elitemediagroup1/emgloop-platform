// Poll one bounded CallGrid interval — the first WRITE-CAPABLE REST read.
//
// WHAT IT IS
//
// An operator names an explicit half-open interval `[since, until)`. This runner
// reads that interval from CallGrid completely, and only if the read completed
// hands every record to the same ingestion pipeline a webhook uses. It is a
// composition of two things that already exist and decides almost nothing:
//
//   readCallGridInterval  (PR #183/#184)  the one bounded, paginated, 429-aware
//                                         CallGrid read. Owns completeness.
//   IngestionService      (PR #178-#182)  the one write path. Owns identity,
//                                         occurrence, provenance, projection and
//                                         provider-fact convergence.
//
// WHAT IT IS NOT
//
// It is NOT a schedule, and it holds NO checkpoint. Nothing in this file records
// where a previous run finished or works out what to read next; the operator
// supplies both bounds every time, and re-running yesterday is exactly as
// available as running today. "Loop knows what interval to poll next" is a
// different problem with a durable watermark in it, and there are tests below
// asserting this file contains none of that machinery.
//
// It is NOT the historical recovery operation. Recovery is the same read through
// the same pipeline labelled API_RECOVERY, started by a person who went looking
// for a known gap. This run labels everything API_POLL, because that is what it
// is: routine polling, on demand.
//
// It does not certify a day, does not reconcile, does not measure, and produces
// no Headline. A run that ingests four thousand calls changes no verdict
// anywhere; what it changes is what Loop holds.
//
// THE RULE THAT SHAPES THE WHOLE FILE
//
//   NO INTERVAL IS WRITTEN AS A SUCCESSFUL POLL UNLESS THE PROVIDER READ FOR
//   THAT INTERVAL COMPLETED.
//
// The read happens first, in full, in memory, and the result is judged before a
// single row is written. A truncated read, an exhausted 429 budget, a pagination
// fault or a provider error writes NOTHING — not the pages that did come back,
// not "most of the day". Half a day written and reported as a poll is precisely
// the shape a later checkpoint would advance past, and it would take the missing
// half with it.
//
// USAGE
//
//   npm run poll:callgrid -- --organization <slug> \
//     --since 2026-08-19T04:00:00Z --until 2026-08-20T04:00:00Z
//
// That is a DRY RUN. It reads the provider and reports what it would do. Writing
// requires --apply, deliberately and explicitly.
//
// Credentials come from the environment and are never printed:
//   DATABASE_URL       the DIRECT (non-pooled) production endpoint
//   CALLGRID_API_KEY   the provider credential

import { INTERVAL_MAX_SPAN_DAYS, validateInterval } from '@emgloop/providers';
import {
  CALLGRID_POLL_OUTCOMES,
  CALLGRID_POLL_PROVIDER,
  CALLGRID_POLL_STREAM,
  POLL_OBSERVATION_SOURCE,
  pollSucceeded,
  type CallGridPollExecution,
  type CallGridPollInput,
  type CallGridPollObserver,
  type CallGridPollOutcome,
} from '@emgloop/database';

// --- The seams this file is tested through -----------------------------------
//
// TWO capabilities, each the narrowest thing that does the job: run one bounded
// poll, and look an organization up. There were four until PR 9, when the read,
// the completeness gate, the refusal policy and the apply loop moved into
// `CallGridPollService` so the admin sync route could reach the SAME primitive
// rather than keeping its own unsafe one. What is left here is a command-line
// front end: parse, resolve a slug, invoke, print.

/** The one write-capable operation this runner may perform. */
export interface PollExecutor {
  execute(input: CallGridPollInput, observer?: CallGridPollObserver): Promise<CallGridPollExecution>;
}

/** Read-only organization lookup. This runner may never provision one. */
export interface OrganizationLookup {
  findBySlug(slug: string): Promise<{ id: string; slug: string; name: string; status: string } | null>;
}

export interface PollDeps {
  executor: PollExecutor;
  organizations: OrganizationLookup;
  /** Injected so tests can read every line, and so nothing writes to stdout directly. */
  log: (line: string) => void;
  /** Injected so the caller owns the clock. Used for elapsed time and nothing else. */
  now: () => Date;
}

export interface PollRequest {
  organizationSlug: string;
  /** INCLUSIVE lower bound. Always explicit; this runner never invents one. */
  since: Date;
  /** EXCLUSIVE upper bound. Always explicit; there is no "until now" here. */
  until: Date;
  apiKey: string;
  /** TRUE performs zero mutations. The default everywhere, including main(). */
  dryRun: boolean;
}

/**
 * The outcome vocabulary, re-exported rather than restated.
 *
 * It belongs to the primitive that produces it. A copy here would be a second
 * list of what a poll can do, and the two would disagree the first time one of
 * them gained a member.
 */
export const POLL_RESULTS = CALLGRID_POLL_OUTCOMES;
export type PollOutcome = CallGridPollOutcome;

/** The primitive's own result, plus the two things only a runner knows. */
export type PollResult = CallGridPollExecution & {
  organizationSlug: string;
  elapsedMs: number;
};

// --- Input validation ---------------------------------------------------------

/** Organization statuses this tool refuses to operate against. */
export const REFUSED_ORGANIZATION_STATUSES = ['SUSPENDED', 'CANCELED'] as const;

/**
 * An instant, or nothing.
 *
 * REQUIRES AN EXPLICIT OFFSET. `2026-08-19T00:00` is midnight somewhere, and
 * which somewhere depends on the machine that happens to run the job — that is a
 * production read pointed at an interval nobody chose. `Z` or `+HH:MM` is
 * mandatory, and a bare date is refused for the same reason: a day is a business
 * decision with a timezone in it, and this operation takes instants.
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

/**
 * Resolve required credentials, or say which are missing BY NAME ONLY.
 *
 * Checked before anything is constructed, so a missing credential fails closed
 * before a provider request or a database connection is attempted.
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
 * DRY RUN IS THE DEFAULT, which is a deliberate divergence from the Stage 3
 * declaration runners: those default to writing and rely on their workflow's
 * `dry_run: true` input for safety. A declaration writes one guarded row. This
 * writes thousands, into the operational read model, from a provider read — so
 * the safe behaviour must not depend on the caller remembering a flag. Writing
 * is spelled `--apply` and cannot happen by omission.
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
      // Accepted so an operator can state the default out loud. Combining it
      // with --apply is a contradiction, and a contradictory instruction about
      // whether to write production is refused rather than resolved.
      dryRunFlag = true;
    }
  }
  return { organization, since, until, dryRun: !apply, contradiction: apply && dryRunFlag };
}

// --- Reporting helpers --------------------------------------------------------

function line(fields: Record<string, string | number | boolean | null>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${k}=${v === null ? '' : String(v)}`)
    .join(' ');
}

function emptyResult(request: PollRequest): PollResult {
  return {
    outcome: 'REFUSED',
    organizationSlug: request.organizationSlug,
    since: request.since.toISOString(),
    until: request.until.toISOString(),
    dryRun: request.dryRun,
    reason: null,
    fetchOutcome: null,
    providerRecordsFetched: 0,
    acceptedRecords: 0,
    refusedRecords: 0,
    refusals: [],
    newEvents: 0,
    duplicateObservations: 0,
    strengthenedCalls: 0,
    conflicts: 0,
    failedProcessing: 0,
    notAttempted: 0,
    pages: 0,
    pageCap: 0,
    rateLimitRetries: 0,
    providerTotal: null,
    failedAtIndex: null,
    failedIdentityDigest: null,
    elapsedMs: 0,
  };
}

// --- The run ------------------------------------------------------------------

/**
 * Resolve an organization, invoke the canonical poll, and print what happened.
 *
 * EVERY DECISION THAT MATTERS IS SOMEWHERE ELSE. Whether the read completed,
 * whether a refused record aborts the interval, whether a mid-batch failure is
 * partial or total, what the counts mean — all of that lives in
 * `CallGridPollService.execute`, which the admin sync route calls too. This
 * function computes none of it and must never begin to: the moment a runner and
 * a route each decide what "complete" means, one of them is wrong and nobody
 * knows which.
 */
export async function runPoll(request: PollRequest, deps: PollDeps): Promise<PollResult> {
  const startedAt = deps.now().getTime();
  const result = emptyResult(request);
  const finish = (): PollResult => {
    result.elapsedMs = deps.now().getTime() - startedAt;
    deps.log(
      line({
        event: 'SUMMARY',
        ORGANIZATION: result.organizationSlug,
        SINCE: result.since,
        UNTIL: result.until,
        DRY_RUN: result.dryRun,
        FETCH_OUTCOME: result.fetchOutcome ?? '',
        PROVIDER_RECORDS_FETCHED: result.providerRecordsFetched,
        ACCEPTED_RECORDS: result.acceptedRecords,
        REFUSED_RECORDS: result.refusedRecords,
        NEW_EVENTS: result.newEvents,
        DUPLICATE_OBSERVATIONS: result.duplicateObservations,
        STRENGTHENED_CALLS: result.strengthenedCalls,
        CONFLICTS: result.conflicts,
        FAILED_PROCESSING: result.failedProcessing,
        NOT_ATTEMPTED: result.notAttempted,
        PAGES: result.pages,
        RATE_LIMIT_RETRIES: result.rateLimitRetries,
        FAILED_AT_INDEX: result.failedAtIndex,
        FAILED_IDENTITY: result.failedIdentityDigest ?? '',
        ELAPSED_MS: result.elapsedMs,
        OVERALL_RESULT: result.outcome,
      }),
    );
    return result;
  };
  const refuse = (reason: string): PollResult => {
    result.outcome = 'REFUSED';
    result.reason = reason;
    deps.log(line({ event: 'PRECONDITION_FAILED', reason }));
    return finish();
  };

  if (!request.organizationSlug) return refuse('--organization <slug> is required.');
  if (!request.apiKey) return refuse('No provider credential was supplied.');

  // THE SAME RULE THE PRIMITIVE APPLIES, applied earlier. `validateInterval` is
  // what `readCallGridInterval` uses and what `execute` uses, so this is not a
  // second opinion — it is the same opinion, reached before a database client or
  // a provider request is constructed for an interval that was never going to be
  // read.
  const bounds = validateInterval(request.since, request.until);
  if (!bounds.ok) return refuse(bounds.reason);

  const organization = await deps.organizations.findBySlug(request.organizationSlug);
  if (!organization) {
    // NOT-FOUND, not forbidden, and never provisioned. This tool resolves an
    // organization that already exists and may not create one.
    return refuse(`No organization with slug "${request.organizationSlug}".`);
  }
  if ((REFUSED_ORGANIZATION_STATUSES as readonly string[]).includes(organization.status)) {
    return refuse(`Organization "${organization.slug}" is ${organization.status}.`);
  }

  deps.log(
    line({
      event: 'RUN_START',
      organization: organization.slug,
      organizationName: organization.name,
      provider: CALLGRID_POLL_PROVIDER,
      stream: CALLGRID_POLL_STREAM,
      since: result.since,
      until: result.until,
      maxSpanDays: INTERVAL_MAX_SPAN_DAYS,
      observationSource: POLL_OBSERVATION_SOURCE,
      dryRun: request.dryRun,
    }),
  );

  // Streamed while the apply is running, because a four-thousand-record interval
  // that prints nothing for twenty minutes looks identical to a hung one.
  const observer: CallGridPollObserver = {
    onStrengthened: (info) =>
      deps.log(
        line({
          event: 'CALL_STRENGTHENED',
          index: info.index,
          identity: info.identityDigest,
          facts: info.facts.join(','),
        }),
      ),
    onConflict: (info) =>
      deps.log(
        line({
          event: 'FACT_CONFLICT',
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
          index: info.index,
          identity: info.identityDigest,
          applied: info.applied,
          notAttempted: info.notAttempted,
          detail: info.detail,
        }),
      ),
  };

  const execution = await deps.executor.execute(
    {
      organizationId: organization.id,
      apiKey: request.apiKey,
      since: request.since,
      until: request.until,
      dryRun: request.dryRun,
    },
    observer,
  );
  Object.assign(result, execution);

  if (result.fetchOutcome !== null) {
    deps.log(
      line({
        event: 'FETCH_RESULT',
        outcome: result.fetchOutcome,
        complete: result.fetchOutcome === 'COMPLETE' ? 'YES' : 'NO',
        records: result.providerRecordsFetched,
        accepted: result.acceptedRecords,
        refused: result.refusedRecords,
        pages: result.pages,
        pageCap: result.pageCap,
        rateLimitRetries: result.rateLimitRetries,
        providerTotal: result.providerTotal,
      }),
    );
  }

  // Each refusal is named, so it cannot vanish into a count.
  for (const refusal of result.refusals) {
    deps.log(
      line({
        event: 'RECORD_REFUSED',
        page: refusal.page,
        kind: refusal.kind ?? '',
        reason: refusal.reason,
      }),
    );
  }

  if (result.outcome === 'FETCH_INCOMPLETE' || (result.outcome === 'REFUSED' && result.refusals.length > 0)) {
    deps.log(
      line({
        event: 'WRITES_SKIPPED',
        reason: result.outcome === 'FETCH_INCOMPLETE' ? 'retrieval incomplete' : 'refused records',
        outcome: result.fetchOutcome ?? '',
        notAttempted: result.notAttempted,
        note: 'Nothing was written.',
      }),
    );
  }

  if (result.outcome === 'DRY_RUN_READY') {
    deps.log(
      line({
        event: 'DRY_RUN_PLAN',
        wouldCreate: result.newEvents,
        wouldReObserve: result.duplicateObservations,
        note: 'Zero rows were written.',
      }),
    );
    deps.log(
      line({
        // Said out loud rather than implied by a zero. A dry run that reported
        // strengthened=0 would be read as "nothing will change", which is a claim
        // it cannot make.
        event: 'DRY_RUN_CAVEAT',
        convergencePredicted: 'NO',
        note: result.reason ?? '',
      }),
    );
  }

  if (result.reason && result.outcome !== 'DRY_RUN_READY') {
    deps.log(line({ event: 'RUN_NOTE', outcome: result.outcome, reason: result.reason }));
  }

  return finish();
}

// --- Wiring -------------------------------------------------------------------
//
// Everything above is pure orchestration over four injected seams, which is what
// the tests drive. Below is the only place real dependencies are constructed, and
// it does nothing but construct them.

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
        reason: '--since and --until must be explicit instants, e.g. 2026-08-19T04:00:00Z',
        since: args.since,
        until: args.until,
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
  const { prisma, repositories, CallGridPollService } = await import('@emgloop/database');

  try {
    const result = await runPoll(
      {
        organizationSlug: args.organization,
        since,
        until,
        apiKey: env.value.apiKey,
        dryRun: args.dryRun,
      },
      {
        // THE SAME PRIMITIVE THE ADMIN SYNC ROUTE CALLS. Not a copy of it, not a
        // variant of it, and not a CLI the route shells out to.
        executor: new CallGridPollService(prisma),
        organizations: repositories.organizations,
        log,
        // The ONLY clock in this operation, and it measures elapsed time. Neither
        // bound is ever derived from it: an interval this runner invented is an
        // interval nobody asked for.
        now: () => new Date(),
      },
    );
    // Whether an outcome counts as a success belongs to the vocabulary, not to a
    // list of names retyped here.
    return pollSucceeded(result.outcome) ? 0 : 1;
  } finally {
    await prisma.$disconnect();
  }
}

// Executed only when run directly, so importing this file does not start a poll.
// The match is ANCHORED to the exact filename: a substring check would fire on
// the test file, whose own name contains this one.
const ENTRY_POINT = /[\\/]poll-callgrid-interval\.ts$/;
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
