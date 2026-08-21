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

import { createHash } from 'node:crypto';
import {
  INTERVAL_MAX_SPAN_DAYS,
  intervalWasComplete,
  validateInterval,
  type IntervalReadResult,
} from '@emgloop/providers';
import { isDuplicateObservation, type IngestInput, type IngestResult } from '@emgloop/database';

// --- The seams this file is tested through -----------------------------------
//
// Four capabilities, each the narrowest thing that does the job. The runner can
// read an interval, ingest a batch, ask whether it already holds a delivery, and
// look an organization up. It cannot reach a Prisma model, a repository, a
// service or a provider client, which is what makes "it cannot certify, measure
// or recover" a property of the type rather than of somebody's care at review.

/** The one provider read this runner may perform. Completeness lives inside it. */
export interface IntervalReader {
  read(request: { apiKey: string; since: Date; until: Date }): Promise<IntervalReadResult>;
}

/** The one write path. This runner never touches a row any other way. */
export interface Ingestor {
  ingest(input: IngestInput): Promise<IngestResult[]>;
}

/** A read used only by the dry run, to say what ingestion WOULD do. */
export interface EventStatusLookup {
  statusOfEvent(organizationId: string, provider: string, externalId: string): Promise<string | null>;
}

/** Read-only organization lookup. This runner may never provision one. */
export interface OrganizationLookup {
  findBySlug(slug: string): Promise<{ id: string; slug: string; name: string; status: string } | null>;
}

export interface PollDeps {
  reader: IntervalReader;
  ingestor: Ingestor;
  events: EventStatusLookup;
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
  /**
   * The canonical REST event-type mapper, supplied rather than written here.
   *
   * `mapReconEventType` already translates a CallGrid `callStatus` into a Loop
   * event type and already refuses to guess at an unrecognised one. A second
   * mapper in a runner would disagree with it on the first status CallGrid adds.
   */
  mapEventType: (rawEventType: string) => string;
}

/**
 * What a run did, in the only seven ways it can end.
 *
 * FOUR OF THESE MEAN NOTHING WAS WRITTEN, and they are separate names rather
 * than one failure because the operator's next move differs: REFUSED is
 * something to fix in the request, FETCH_INCOMPLETE is something to retry,
 * PROCESSING_FAILED is a bug, and DRY_RUN_READY is a success.
 */
export const POLL_RESULTS = [
  /** Read completed, nothing written, this is what would happen. */
  'DRY_RUN_READY',
  /** Read completed and every accepted record was processed. */
  'APPLIED',
  /** As APPLIED, and at least one provider fact DISAGREED with what Loop holds. */
  'APPLIED_WITH_CONFLICTS',
  /** Processing stopped part-way. Some rows are live. NEVER a success. */
  'PARTIALLY_APPLIED',
  /** Processing failed on the first record. Nothing is live. */
  'PROCESSING_FAILED',
  /** The provider read did not complete. Nothing was written. */
  'FETCH_INCOMPLETE',
  /** The run refused before writing anything: bad request, or a refused record. */
  'REFUSED',
] as const;

export type PollOutcome = (typeof POLL_RESULTS)[number];

export interface PollResult {
  overall: PollOutcome;
  organizationSlug: string;
  since: string;
  until: string;
  dryRun: boolean;
  /** Set on REFUSED and FETCH_INCOMPLETE. One sentence, never a credential. */
  reason: string | null;
  /** The retrieval outcome verbatim, when a read was attempted. */
  fetchOutcome: string | null;
  /** Raw provider records seen, including ones the mapper refused. */
  providerRecordsFetched: number;
  /** Records that mapped to a canonical event. */
  acceptedRecords: number;
  /** Records the provider returned and the mapper would not map. */
  refusedRecords: number;
  /** Deliveries Loop had never held. */
  newEvents: number;
  /** Deliveries Loop already held, re-observed. */
  duplicateObservations: number;
  /** CALLS whose canonical facts moved. Not a count of facts. */
  strengthenedCalls: number;
  /** FACTS that disagreed. Not a count of calls. Nothing moved for any of them. */
  conflicts: number;
  /** Records that raised during processing. At most one: the run stops. */
  failedProcessing: number;
  /** Accepted records never handed to ingestion, for any reason. */
  notAttempted: number;
  pages: number;
  pageCap: number;
  rateLimitRetries: number;
  /** Provider-reported total for the interval when it supplies one. Advisory. */
  providerTotal: number | null;
  /** Where processing stopped, when it stopped. Never a raw provider identity. */
  failedAtIndex: number | null;
  failedIdentityDigest: string | null;
  elapsedMs: number;
}

// --- Input validation ---------------------------------------------------------

/** Organization statuses this tool refuses to operate against. */
export const REFUSED_ORGANIZATION_STATUSES = ['SUSPENDED', 'CANCELED'] as const;

/** The provider and stream this operation is for. Fixed, not a parameter. */
export const POLL_PROVIDER = 'callgrid';
export const POLL_STREAM = 'calls';

/**
 * How rows written by this run are labelled. A constant, not an input.
 *
 * The operator cannot choose this. API_RECOVERY means a person went looking for
 * a known gap, and letting a routine poll claim that label — or letting a
 * recovery hide as routine traffic — would make the provenance field answer a
 * different question than the one it was added to answer.
 */
export const POLL_OBSERVATION_SOURCE = 'API_POLL' as const;

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

/**
 * A stable, non-reversible handle for one provider record.
 *
 * The raw CallGrid identity is deliberately not printed. An operator does not
 * need it: re-running the same interval converges, and the durable evidence for
 * a conflict is a `provider_fact_revisions` row that carries the real identity
 * inside the database where it is already scoped to a tenant. What a log line
 * needs is enough to correlate two mentions of the same record, and that is all
 * this gives.
 */
export function identityDigest(externalId: string): string {
  return createHash('sha256').update(externalId).digest('hex').slice(0, 12);
}

function emptyResult(request: PollRequest): PollResult {
  return {
    overall: 'REFUSED',
    organizationSlug: request.organizationSlug,
    since: request.since.toISOString(),
    until: request.until.toISOString(),
    dryRun: request.dryRun,
    reason: null,
    fetchOutcome: null,
    providerRecordsFetched: 0,
    acceptedRecords: 0,
    refusedRecords: 0,
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

/** How often a long apply reports progress. Not a batch size: writes are one at a time. */
export const PROGRESS_EVERY = 250;

// --- The run ------------------------------------------------------------------

/**
 * Read one bounded interval, and write it only if the read completed.
 *
 * SEQUENTIAL BY CONSTRUCTION. There is no `Promise.all` here and there must never
 * be one. Two records for the same call processed concurrently would race on the
 * same `(provider, externalId)` row and on the same canonical facts, and — the
 * reason that actually matters — a parallel apply cannot stop at the first
 * failure, because by then it has already written the others.
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
        OVERALL_RESULT: result.overall,
      }),
    );
    return result;
  };
  const refuse = (reason: string): PollResult => {
    result.overall = 'REFUSED';
    result.reason = reason;
    deps.log(line({ event: 'PRECONDITION_FAILED', reason }));
    return finish();
  };

  if (!request.organizationSlug) return refuse('--organization <slug> is required.');
  if (!request.apiKey) return refuse('No provider credential was supplied.');

  // THE BOUNDS ARE JUDGED BY THE READER'S OWN RULE, not by a second opinion
  // written here. `validateInterval` is what `readCallGridInterval` applies, so a
  // span limit or an ordering rule that changes there changes here on the same
  // day rather than drifting into disagreement.
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
      provider: POLL_PROVIDER,
      stream: POLL_STREAM,
      since: result.since,
      until: result.until,
      maxSpanDays: INTERVAL_MAX_SPAN_DAYS,
      observationSource: POLL_OBSERVATION_SOURCE,
      dryRun: request.dryRun,
    }),
  );

  // --- 1. Read the whole interval, before anything is written ------------------
  let read: IntervalReadResult;
  try {
    read = await deps.reader.read({ apiKey: request.apiKey, since: request.since, until: request.until });
  } catch (error) {
    // The reader classifies provider failures into outcomes and does not throw
    // for them, so reaching here is structural. Nothing was written either way.
    const detail = error instanceof Error ? error.message : 'unknown error';
    result.overall = 'FETCH_INCOMPLETE';
    result.reason = detail;
    result.fetchOutcome = 'THREW';
    deps.log(line({ event: 'FETCH_ERROR', detail }));
    return finish();
  }

  result.fetchOutcome = read.outcome;
  result.providerRecordsFetched = read.records;
  result.acceptedRecords = read.events.length;
  result.refusedRecords = read.refused.length;
  result.pages = read.pages;
  result.pageCap = read.pageCap;
  result.rateLimitRetries = read.rateLimitRetries;
  result.providerTotal = typeof read.providerTotal === 'number' ? read.providerTotal : null;

  deps.log(
    line({
      event: 'FETCH_RESULT',
      outcome: read.outcome,
      complete: intervalWasComplete(read) ? 'YES' : 'NO',
      records: read.records,
      accepted: read.events.length,
      refused: read.refused.length,
      pages: read.pages,
      pageCap: read.pageCap,
      rateLimitRetries: read.rateLimitRetries,
      providerTotal: result.providerTotal,
      reason: read.reason ?? '',
    }),
  );

  // THE LOAD-BEARING LINE. `intervalWasComplete` is the shared predicate, so an
  // outcome added to the reader later is treated as incomplete here on the day it
  // is added rather than falling through a hard-coded list of today's failures.
  if (!intervalWasComplete(read)) {
    result.overall = 'FETCH_INCOMPLETE';
    result.reason =
      read.reason ?? `The provider read ended ${read.outcome} rather than COMPLETE.`;
    result.notAttempted = read.events.length;
    deps.log(
      line({
        event: 'WRITES_SKIPPED',
        reason: 'retrieval incomplete',
        outcome: read.outcome,
        notAttempted: result.notAttempted,
        note: 'What came back is a LOWER BOUND on this interval. Nothing was written.',
      }),
    );
    return finish();
  }

  // --- 2. A complete read may still hold records the mapper refused ------------
  //
  // FAIL CLOSED, ALL OR NOTHING. The alternative — write the accepted records and
  // report the interval as covered-with-exceptions — is the option that a future
  // checkpoint would eventually advance past, taking the refused records with it
  // permanently. There is no resumable contract in this repository that could
  // carry "this interval is done except for these three", so the honest answer is
  // that the interval is not done. A refused record means the provider returned
  // something the shipped mapper does not recognise, which is a contract change
  // worth a person's attention rather than a rounding error.
  if (read.refused.length > 0) {
    result.overall = 'REFUSED';
    result.reason =
      `${read.refused.length} provider record(s) in a COMPLETE read could not be mapped. ` +
      'No records were written: an interval containing an unmapped record is not a polled interval.';
    result.notAttempted = read.events.length;
    for (const refusedRecord of read.refused) {
      deps.log(
        line({
          event: 'RECORD_REFUSED',
          page: refusedRecord.page,
          kind: refusedRecord.kind ?? '',
          reason: refusedRecord.reason,
        }),
      );
    }
    deps.log(
      line({
        event: 'WRITES_SKIPPED',
        reason: 'refused records',
        refused: read.refused.length,
        notAttempted: result.notAttempted,
      }),
    );
    return finish();
  }

  // --- 3. Dry run: say what would happen, mutate nothing -----------------------
  if (request.dryRun) {
    for (const ev of read.events) {
      const status = await deps.events.statusOfEvent(organization.id, POLL_PROVIDER, ev.externalId);
      // The SAME predicate ingestion branches on. Re-spelling the status literal
      // here is how a dry run starts describing a run that no longer exists.
      if (status !== null && isDuplicateObservation(status)) result.duplicateObservations += 1;
      else result.newEvents += 1;
    }
    result.notAttempted = read.events.length;
    result.overall = 'DRY_RUN_READY';
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
        event: 'DRY_RUN_CAVEAT',
        // Said out loud rather than implied by a zero. A dry run that reported
        // strengthened=0 would be read as "nothing will change", which is a claim
        // it cannot make.
        convergencePredicted: 'NO',
        note:
          'Whether a re-observation strengthens or conflicts with a canonical fact is decided ' +
          'by convergeFact against the stored value at write time and is NOT predicted here. ' +
          'Duplicate classification is organization-scoped; ingestion matches (provider, externalId) ' +
          'globally, so a delivery held by another tenant is counted as new above and would be ' +
          'recognised as existing on apply.',
      }),
    );
    return finish();
  }

  // --- 4. Apply, one record at a time, stopping on an unexpected failure -------
  //
  // FETCHING IS ALL-OR-NOTHING; PROCESSING IS NOT, and cannot be. Thousands of
  // records through the full pipeline is not one database transaction and pretending
  // otherwise would mean holding a transaction open for the length of a provider
  // day. So the guarantee here is different and is stated rather than implied: a
  // run that stops part-way reports PARTIALLY_APPLIED, names where it stopped, and
  // is never a success. Re-running the identical interval converges, because every
  // row already written is recognised by `(provider, externalId)` and re-observed
  // rather than duplicated.
  //
  // A PROVIDER FACT CONFLICT IS NOT A FAILURE. It is a business outcome PR #182
  // exists to produce: two settled values disagree, the canonical value did not
  // move, and a revision row records the disagreement. The run continues and
  // reports APPLIED_WITH_CONFLICTS, because stopping would leave the rest of a
  // real interval unwritten over a question about one call's revenue.
  for (let index = 0; index < read.events.length; index += 1) {
    const ev = read.events[index];
    if (!ev) continue;
    let outcome: IngestResult | undefined;
    try {
      const results = await deps.ingestor.ingest({
        organizationId: organization.id,
        provider: POLL_PROVIDER,
        mapEventType: request.mapEventType,
        events: [ev],
        observationSource: POLL_OBSERVATION_SOURCE,
      });
      outcome = results[0];
    } catch (error) {
      outcome = undefined;
      result.reason = error instanceof Error ? error.message : 'unknown error';
    }

    if (!outcome || outcome.status === 'failed') {
      result.failedProcessing += 1;
      result.failedAtIndex = index;
      result.failedIdentityDigest = identityDigest(ev.externalId);
      result.notAttempted = read.events.length - index - 1;
      result.reason = outcome?.error ?? result.reason ?? 'Ingestion reported no result.';
      const applied = result.newEvents + result.duplicateObservations;
      result.overall = applied > 0 ? 'PARTIALLY_APPLIED' : 'PROCESSING_FAILED';
      deps.log(
        line({
          event: 'RECORD_FAILED',
          index,
          identity: result.failedIdentityDigest,
          applied,
          notAttempted: result.notAttempted,
          detail: result.reason,
        }),
      );
      return finish();
    }

    if (outcome.status === 'duplicate') result.duplicateObservations += 1;
    else result.newEvents += 1;

    if (outcome.strengthenedFacts.length > 0) {
      result.strengthenedCalls += 1;
      deps.log(
        line({
          event: 'CALL_STRENGTHENED',
          index,
          identity: identityDigest(ev.externalId),
          facts: outcome.strengthenedFacts.join(','),
        }),
      );
    }
    if (outcome.conflictedFacts.length > 0) {
      result.conflicts += outcome.conflictedFacts.length;
      deps.log(
        line({
          event: 'FACT_CONFLICT',
          index,
          identity: identityDigest(ev.externalId),
          facts: outcome.conflictedFacts.join(','),
          note: 'The canonical value did NOT move. A revision row records the disagreement.',
        }),
      );
    }

    const done = index + 1;
    if (done % PROGRESS_EVERY === 0) {
      deps.log(
        line({
          event: 'PROGRESS',
          done,
          of: read.events.length,
          created: result.newEvents,
          reObserved: result.duplicateObservations,
        }),
      );
    }
  }

  result.overall = result.conflicts > 0 ? 'APPLIED_WITH_CONFLICTS' : 'APPLIED';
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
  const providers = await import('@emgloop/providers');
  const { prisma, repositories, IngestionService, mapReconEventType } = await import('@emgloop/database');
  const ingestion = new IngestionService(prisma);

  try {
    const result = await runPoll(
      {
        organizationSlug: args.organization,
        since,
        until,
        apiKey: env.value.apiKey,
        dryRun: args.dryRun,
        mapEventType: mapReconEventType,
      },
      {
        reader: {
          read: (r) => providers.readCallGridInterval({ apiKey: r.apiKey, since: r.since, until: r.until }),
        },
        ingestor: ingestion,
        events: repositories.integrations,
        organizations: repositories.organizations,
        log,
        // The ONLY clock in this operation, and it measures elapsed time. Neither
        // bound is ever derived from it: an interval this runner invented is an
        // interval nobody asked for.
        now: () => new Date(),
      },
    );
    return result.overall === 'DRY_RUN_READY' ||
      result.overall === 'APPLIED' ||
      result.overall === 'APPLIED_WITH_CONFLICTS'
      ? 0
      : 1;
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
