// Certify observation days — an OPERATOR TOOL, not product architecture.
//
// WHAT IT IS
//
// A loop, a call, and some printing. It asks the existing certification service
// whether CallGrid can prove a given Eastern business day was observed, one day
// at a time, and stops the moment the answer is anything other than yes.
//
// WHAT IT IS NOT
//
// It is not a second opinion about completeness. Every decision that matters
// lives inside `ProviderObservationService.certifyDay()` and stays there: the
// Eastern day boundary, the CallGrid request, pagination, whether the read
// exhausted, how a failure is classified, what status that becomes, and the
// ledger write. This file computes none of them and must never begin to.
// There is exactly ONE semantic path for deciding whether a provider day was
// observed, and this is not it — it is a way to invoke it from a runner that has
// hours rather than the seconds a serverless request has.
//
// IT NEVER RECOVERS. Certification records that the provider can prove a day.
// It does not repair Loop's local copy of that day, and a run that discovers
// CallGrid holds a thousand calls Loop is missing changes nothing except one
// ledger row. Recovery is a separate operation behind a separate decision, and
// there is a test asserting this file references none of its machinery.
//
// STOPS ON THE FIRST DAY IT CANNOT CERTIFY. A sweep that keeps going past a
// truncated or failed read produces a ledger full of rows and a false sense that
// the window was worked through. Recording a failure IS a successful write and
// is NOT a successful certification; the run exits non-zero and leaves every
// later date untouched, so the operator sees exactly where reality stopped
// matching the plan.
//
// USAGE
//
//   npm run certify:observation-days -- --organization <slug> --dates 2026-08-09
//   npm run certify:observation-days -- --organization <slug> --dates 2026-08-03,2026-08-04
//
// Credentials come from the environment and are never printed:
//   DATABASE_URL       the DIRECT (non-pooled) production endpoint
//   CALLGRID_API_KEY   the provider credential

import {
  certifiesObservation,
  isBusinessDate,
  BUSINESS_TIME_ZONE,
  type BusinessDate,
} from '@emgloop/shared';
import type { ObservationDayView } from '@emgloop/database';

// --- The seams this file is tested through -----------------------------------
//
// Narrow on purpose. The runner is handed the ability to certify a day and the
// ability to look an organization up, and can do nothing else — which is what
// makes "it cannot ingest, project or measure" a property of the type rather
// than of somebody's care at review time.

/** The one operation this runner is allowed to perform against a provider. */
export interface DayCertifier {
  certifyDay(input: {
    organizationId: string;
    businessDate: BusinessDate;
    apiKey: string;
    now: Date;
  }): Promise<ObservationDayView>;
}

/** Read-only organization lookup. This runner may never provision one. */
export interface OrganizationLookup {
  findBySlug(slug: string): Promise<{ id: string; slug: string; name: string; status: string } | null>;
}

export interface SweepDeps {
  certifier: DayCertifier;
  organizations: OrganizationLookup;
  /** Injected so tests can read every line, and so nothing writes to stdout directly. */
  log: (line: string) => void;
  /** Injected so the caller owns the clock. */
  now: () => Date;
}

export interface SweepRequest {
  organizationSlug: string;
  dates: readonly BusinessDate[];
  apiKey: string;
}

export interface DayOutcome {
  businessDate: BusinessDate;
  status: string;
  certified: boolean;
  recordsObserved: number;
  pagesFetched: number;
  durationMs: number;
}

export interface SweepResult {
  overall: 'SUCCESS' | 'STOPPED_NON_CERTIFYING' | 'FAILED_PRECONDITION';
  requested: readonly BusinessDate[];
  certified: BusinessDate[];
  empty: BusinessDate[];
  failedDate: BusinessDate | null;
  outcomes: DayOutcome[];
  /** Set only for FAILED_PRECONDITION. Never contains a credential. */
  error: string | null;
}

// --- Input validation ---------------------------------------------------------

/** Organization statuses this tool refuses to operate against. */
export const REFUSED_ORGANIZATION_STATUSES = ['SUSPENDED', 'CANCELED'] as const;

/**
 * Parse the operator's `--dates` value into business dates.
 *
 * Whitespace is normalised and empty segments dropped, so a value pasted out of
 * a spreadsheet or a chat message still works. Anything that is not a
 * `YYYY-MM-DD` business date is REJECTED rather than coerced — a date this tool
 * cannot understand is an operator error, and guessing at one would point a
 * production write at a day nobody asked for.
 *
 * The check is `isBusinessDate` from business-time.ts, the same predicate
 * `certifyDay` applies, so the two can never disagree about what a date is.
 */
export function parseDates(raw: string): { dates: BusinessDate[]; invalid: string[] } {
  const dates: BusinessDate[] = [];
  const invalid: string[] = [];
  for (const segment of raw.split(',')) {
    const value = segment.trim();
    if (value === '') continue;
    if (isBusinessDate(value)) dates.push(value);
    else invalid.push(value);
  }
  return { dates, invalid };
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
 * before a provider request or a database connection is attempted rather than
 * halfway through a sweep.
 */
export function readEnvironment(env: NodeJS.ProcessEnv): { ok: true; value: RequiredEnvironment } | { ok: false; missing: string[] } {
  const missing: string[] = [];
  const databaseUrl = env.DATABASE_URL?.trim() || '';
  const apiKey = env.CALLGRID_API_KEY?.trim() || '';
  if (!databaseUrl) missing.push('DATABASE_URL');
  if (!apiKey) missing.push('CALLGRID_API_KEY');
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, value: { databaseUrl, apiKey } };
}

/** Minimal flag parsing. Deliberately not a CLI framework. */
export function parseArgs(argv: readonly string[]): { organization: string; dates: string } {
  let organization = '';
  let dates = '';
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1] ?? '';
    if (flag === '--organization' || flag === '--org') {
      organization = value.trim();
      i += 1;
    } else if (flag === '--dates' || flag === '--date') {
      dates = value.trim();
      i += 1;
    }
  }
  return { organization, dates };
}

// --- The sweep ----------------------------------------------------------------

function line(fields: Record<string, string | number | boolean | null>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${k}=${v === null ? '' : String(v)}`)
    .join(' ');
}

/**
 * Certify each requested date, in the order supplied, one at a time.
 *
 * SEQUENTIAL BY CONSTRUCTION. There is no `Promise.all` here and there must
 * never be one: each date is a bounded run of provider requests, running several
 * at once would multiply the load on CallGrid for no operator benefit, and — the
 * reason that actually matters — a parallel sweep cannot stop at the first day it
 * fails to certify, because by then it has already worked through the others.
 */
export async function runSweep(request: SweepRequest, deps: SweepDeps): Promise<SweepResult> {
  const result: SweepResult = {
    overall: 'SUCCESS',
    requested: request.dates,
    certified: [],
    empty: [],
    failedDate: null,
    outcomes: [],
    error: null,
  };

  if (request.dates.length === 0) {
    result.overall = 'FAILED_PRECONDITION';
    result.error = 'No dates were supplied.';
    deps.log(line({ event: 'PRECONDITION_FAILED', reason: result.error }));
    return result;
  }

  const organization = await deps.organizations.findBySlug(request.organizationSlug);
  if (!organization) {
    // NOT-FOUND, not forbidden, and never provisioned. This tool resolves an
    // organization that already exists; it may not create one, and it must not
    // reach anything that upserts a tenant into existence. The lookup seam is a
    // read, and a test asserts this file names no provisioning helper at all.
    result.overall = 'FAILED_PRECONDITION';
    result.error = `No organization with slug "${request.organizationSlug}".`;
    deps.log(line({ event: 'PRECONDITION_FAILED', reason: result.error }));
    return result;
  }
  if ((REFUSED_ORGANIZATION_STATUSES as readonly string[]).includes(organization.status)) {
    // The platform has no organization-level gate anywhere else, so this is the
    // tool being conservative rather than a new platform rule: a tenant that has
    // been suspended or cancelled should not have production writes run against
    // it by an operator convenience. TRIAL and PAST_DUE are ordinary states and
    // are accepted.
    result.overall = 'FAILED_PRECONDITION';
    result.error = `Organization "${organization.slug}" is ${organization.status}.`;
    deps.log(line({ event: 'PRECONDITION_FAILED', reason: result.error }));
    return result;
  }

  deps.log(
    line({
      event: 'SWEEP_START',
      organization: organization.slug,
      organizationName: organization.name,
      provider: 'callgrid',
      stream: 'calls',
      timezone: BUSINESS_TIME_ZONE,
      dates: request.dates.join(','),
      count: request.dates.length,
    }),
  );

  for (const businessDate of request.dates) {
    deps.log(
      line({
        event: 'DAY_START',
        date: businessDate,
        organization: organization.slug,
        provider: 'callgrid',
        stream: 'calls',
      }),
    );

    const startedAt = deps.now().getTime();
    let view: ObservationDayView;
    try {
      view = await deps.certifier.certifyDay({
        organizationId: organization.id,
        businessDate,
        apiKey: request.apiKey,
        now: deps.now(),
      });
    } catch (error) {
      // certifyDay records provider failures as ledger rows and does not throw
      // for them, so reaching here means something structural — a bad date, a
      // database failure. Treat it as a hard stop and say so without guessing at
      // a status the service never returned.
      const detail = error instanceof Error ? error.message : 'unknown error';
      result.overall = 'STOPPED_NON_CERTIFYING';
      result.failedDate = businessDate;
      result.error = detail;
      deps.log(line({ event: 'DAY_ERROR', date: businessDate, detail }));
      deps.log(line({ event: 'SWEEP_STOPPED', date: businessDate, reason: 'certification threw' }));
      return finish(result, deps);
    }
    const durationMs = deps.now().getTime() - startedAt;

    // THE DECISION IS NOT MADE HERE. `certifiesObservation` is the shared rule,
    // so a status added later is handled correctly by this runner on the day it
    // is added — rather than falling through a hard-coded list of today's
    // failures and being treated as a pass.
    const certified = certifiesObservation(view.status);

    result.outcomes.push({
      businessDate,
      status: view.status,
      certified,
      recordsObserved: view.recordsObserved,
      pagesFetched: view.pagesFetched,
      durationMs,
    });

    deps.log(
      line({
        event: 'DAY_RESULT',
        date: view.businessDate,
        status: view.status,
        certifies: certified ? 'YES' : 'NO',
        records: view.recordsObserved,
        providerStatedTotal: view.providerStatedTotal,
        pages: view.pagesFetched,
        pageCap: view.pageCap,
        truncated: view.truncated,
        timezone: view.timezone,
        observedAt: view.observedAt,
        source: view.source,
        // The ledger row's persisted IDENTITY is its natural key, not a surrogate
        // id: (organization, provider, stream, businessDate) is what the upsert
        // targets and what an operator would query on.
        ledgerRow: `${organization.slug}/callgrid/calls/${view.businessDate}`,
        durationMs,
        reason: view.reason,
      }),
    );

    if (!certified) {
      // A ledger row WAS written — recording "we tried and could not finish" is
      // the point. That is not a certified day, and the sweep does not continue
      // past it. Every later date stays untouched and stays Unknown.
      result.overall = 'STOPPED_NON_CERTIFYING';
      result.failedDate = businessDate;
      deps.log(
        line({
          event: 'SWEEP_STOPPED',
          date: businessDate,
          status: view.status,
          remaining: request.dates.slice(request.dates.indexOf(businessDate) + 1).join(','),
          note: 'A recorded failure is a successful write, not a certified day.',
        }),
      );
      return finish(result, deps);
    }

    if (view.status === 'EMPTY') result.empty.push(businessDate);
    result.certified.push(businessDate);
  }

  return finish(result, deps);
}

function finish(result: SweepResult, deps: SweepDeps): SweepResult {
  deps.log(
    line({
      event: 'SUMMARY',
      REQUESTED_DATES: result.requested.join(','),
      CERTIFIED_DATES: result.certified.join(','),
      EMPTY_DATES: result.empty.join(','),
      FAILED_DATE: result.failedDate ?? '',
      OVERALL_RESULT: result.overall,
    }),
  );
  return result;
}

// --- Wiring -------------------------------------------------------------------
//
// Everything above is pure orchestration over two injected seams, which is what
// the tests drive. Below is the only place real production dependencies are
// constructed, and it does nothing but construct them.

async function main(): Promise<number> {
  const log = (l: string) => process.stdout.write(l + '\n');

  const args = parseArgs(process.argv.slice(2));
  if (!args.organization) {
    log(line({ event: 'PRECONDITION_FAILED', reason: '--organization <slug> is required' }));
    return 2;
  }
  const { dates, invalid } = parseDates(args.dates);
  if (invalid.length > 0) {
    log(line({ event: 'PRECONDITION_FAILED', reason: 'invalid dates', invalid: invalid.join(',') }));
    return 2;
  }
  if (dates.length === 0) {
    log(line({ event: 'PRECONDITION_FAILED', reason: '--dates 2026-08-09[,...] is required' }));
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
  const { prisma, repositories, ProviderObservationService } = await import('@emgloop/database');
  const service = new ProviderObservationService(prisma);

  try {
    const result = await runSweep(
      { organizationSlug: args.organization, dates, apiKey: env.value.apiKey },
      {
        certifier: service,
        organizations: repositories.organizations,
        log,
        now: () => new Date(),
      },
    );
    return result.overall === 'SUCCESS' ? 0 : 1;
  } finally {
    await prisma.$disconnect();
  }
}

// Executed only when run directly, so importing this file does not start a sweep.
//
// The match is ANCHORED to the exact filename. A substring check was the first
// version, and the test file — whose own name contains this one — imported the
// module, ran main(), failed its preconditions and set a non-zero exit code, so
// every individual test passed while the suite failed. An entry-point guard that
// fires on a name that merely contains the script's is the same class of mistake
// as a query that matches more rows than it names.
const ENTRY_POINT = /[\\/]certify-observation-days\.ts$/;
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
