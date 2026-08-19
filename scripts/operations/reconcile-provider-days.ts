// Reconcile provider days — an OPERATOR TOOL, not product architecture.
//
// WHAT IT IS
//
// A loop, a call, and some printing. It asks the existing reconciliation service
// whether the identities CallGrid held for one Eastern business day actually
// reached Loop, and records the answer.
//
// WHAT IT IS NOT
//
// It is not a second opinion about completeness. Every decision that matters
// lives inside `ProviderReconciliationService.reconcileDay()` and stays there:
// the Eastern day boundary, the CallGrid request, pagination, the widened local
// delivery scan, occurrence resolution, identity normalisation, member
// attribution, expectation resolution, the set arithmetic, the verdict, and the
// write. This file computes none of them and must never begin to. There is
// exactly ONE semantic path for deciding whether a provider day reconciled, and
// this is not it — it is a way to invoke it from a runner that has hours rather
// than the seconds a serverless request has.
//
// IT NEVER REPAIRS. Reconciliation records what arrived. It does not import a
// missing call, does not trigger a sync, does not touch either downstream
// projection, and does not write a declaration. A run that discovers
// CallGrid holds a hundred calls Loop is missing changes nothing except one
// reconciliation row and its member facts. Recovery is a separate operation
// behind a separate decision, and there is a test asserting this file references
// none of its machinery.
//
// ONE DATE PER DISPATCH IS THE DEFAULT, DELIBERATELY. A historical sweep is a
// different operation with a different risk profile, and this is a correctness
// tool before it is a backfill tool. Several dates may be supplied, and the run
// stops at the first one that does not reconcile — a sweep that keeps going past
// an inconclusive comparison produces a table full of rows and a false sense
// that the window was worked through.
//
// A REFUSAL IS NOT A VERDICT. If the comparison's own arithmetic disagrees with
// itself, the service writes NOTHING and this runner exits non-zero. An
// INCONCLUSIVE row would still assert that a comparison happened.
//
// USAGE
//
//   npm run reconcile:provider-days -- --organization <slug> --dates 2026-08-05
//
// Credentials come from the environment and are never printed:
//   DATABASE_URL       the DIRECT (non-pooled) production endpoint
//   CALLGRID_API_KEY   the provider credential

import {
  BUSINESS_TIME_ZONE,
  isBusinessDate,
  reconciliationCertifies,
  type BusinessDate,
  type ReconciliationState,
} from '@emgloop/shared';
import type { ReconciliationDayView } from '@emgloop/database';

// --- The seams this file is tested through -----------------------------------
//
// Narrow on purpose. The runner is handed the ability to reconcile a day and the
// ability to look an organization up, and can do nothing else — which is what
// makes "it cannot ingest, project, recover or declare" a property of the type
// rather than of somebody's care at review time.

/** The one operation this runner is allowed to perform. */
export interface DayReconciler {
  reconcileDay(input: {
    organizationId: string;
    businessDate: BusinessDate;
    apiKey: string;
    now: Date;
  }): Promise<
    | { ok: true; day: ReconciliationDayView }
    | { ok: false; reason: string; problems: readonly string[] }
  >;
}

/** Read-only organization lookup. This runner may never provision one. */
export interface OrganizationLookup {
  findBySlug(slug: string): Promise<{ id: string; slug: string; name: string; status: string } | null>;
}

export interface SweepDeps {
  reconciler: DayReconciler;
  organizations: OrganizationLookup;
  /** Injected so tests can read every line, and so nothing writes to stdout directly. */
  log: (line: string) => void;
  /** Injected so the invoker owns the clock. */
  now: () => Date;
}

export interface SweepRequest {
  organizationSlug: string;
  dates: readonly BusinessDate[];
  apiKey: string;
}

export interface DayOutcome {
  businessDate: BusinessDate;
  state: ReconciliationState | 'REFUSED' | null;
  reconciled: boolean;
  providerUnique: number;
  localUnique: number;
  providerOnly: number;
  localOnly: number;
  durationMs: number;
}

export interface SweepResult {
  overall: 'SUCCESS' | 'STOPPED_NOT_RECONCILED' | 'DIAGNOSTIC_DEFECT' | 'FAILED_PRECONDITION';
  requested: readonly BusinessDate[];
  reconciled: BusinessDate[];
  failedDate: BusinessDate | null;
  outcomes: DayOutcome[];
  /** Set only on a refusal or a precondition failure. Never contains a credential. */
  error: string | null;
}

// --- Input validation ---------------------------------------------------------

/** Organization statuses this tool refuses to operate against. */
export const REFUSED_ORGANIZATION_STATUSES = ['SUSPENDED', 'CANCELED'] as const;

/**
 * Parse the operator's `--dates` value into business dates.
 *
 * Whitespace is normalised and empty segments dropped, so a value pasted out of
 * a spreadsheet still works. Anything that is not a `YYYY-MM-DD` business date
 * is REJECTED rather than coerced. The check is `isBusinessDate` from
 * business-time.ts, the same predicate `reconcileDay` applies, so the two can
 * never disagree about what a date is.
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
 * Reconcile each requested date, in the order supplied, one at a time.
 *
 * SEQUENTIAL BY CONSTRUCTION. There is no concurrent fan-out here and there
 * must never be one: each date is a bounded run of provider requests plus a
 * batched local scan, and — the reason that actually matters — a parallel sweep
 * cannot stop at the first day that fails to reconcile, because by then it has
 * already worked through the others. The absence of a fan-out is asserted by
 * test, so this stays a property rather than an intention.
 *
 * THE DECISION IS `reconciliationCertifies`, not a list of today's blocking
 * states. A fifth state added later is handled correctly on the day it is added.
 */
export async function runSweep(request: SweepRequest, deps: SweepDeps): Promise<SweepResult> {
  const result: SweepResult = {
    overall: 'SUCCESS',
    requested: request.dates,
    reconciled: [],
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
    // organization that already exists; a test asserts it names no provisioning
    // helper at all.
    result.overall = 'FAILED_PRECONDITION';
    result.error = `No organization with slug "${request.organizationSlug}".`;
    deps.log(line({ event: 'PRECONDITION_FAILED', reason: result.error }));
    return result;
  }
  if ((REFUSED_ORGANIZATION_STATUSES as readonly string[]).includes(organization.status)) {
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
    }),
  );

  for (const businessDate of request.dates) {
    const started = deps.now();
    const outcome = await deps.reconciler.reconcileDay({
      organizationId: organization.id,
      businessDate,
      apiKey: request.apiKey,
      now: started,
    });
    const durationMs = deps.now().getTime() - started.getTime();

    if (!outcome.ok) {
      // The comparison contradicted itself and NOTHING was written. That is a
      // defect in Loop, not a finding about the data, and it is reported as a
      // different colour of failure from a day that simply did not reconcile.
      result.overall = 'DIAGNOSTIC_DEFECT';
      result.failedDate = businessDate;
      result.error = outcome.problems.join('; ');
      result.outcomes.push({
        businessDate,
        state: 'REFUSED',
        reconciled: false,
        providerUnique: 0,
        localUnique: 0,
        providerOnly: 0,
        localOnly: 0,
        durationMs,
      });
      deps.log(
        line({
          event: 'DAY_RESULT',
          businessDate,
          state: 'REFUSED',
          reconciled: false,
          written: false,
          reason: result.error,
          durationMs,
        }),
      );
      deps.log(line({ event: 'SWEEP_STOPPED', reason: 'the comparison did not add up; nothing was written' }));
      return result;
    }

    const day = outcome.day;
    // A recorded non-reconciliation IS a successful write and is NOT a
    // reconciled day. Reading the write as a pass is how a sweep goes green
    // through an outage.
    const reconciled = reconciliationCertifies(day.state);
    result.outcomes.push({
      businessDate,
      state: day.state,
      reconciled,
      providerUnique: day.counts.providerUnique,
      localUnique: day.counts.localUnique,
      providerOnly: day.counts.providerOnly,
      localOnly: day.counts.localOnly,
      durationMs,
    });
    deps.log(
      line({
        event: 'DAY_RESULT',
        businessDate,
        state: day.state,
        reconciled,
        written: true,
        providerUnique: day.counts.providerUnique,
        localUnique: day.counts.localUnique,
        intersection: day.counts.intersection,
        providerOnly: day.counts.providerOnly,
        localOnly: day.counts.localOnly,
        providerOnlyExpected: day.counts.providerOnlyExpected,
        providerOnlyNotConfigured: day.counts.providerOnlyNotConfigured,
        providerOnlyExcluded: day.counts.providerOnlyExcluded,
        providerOnlyUnknownMember: day.counts.providerOnlyUnknownMember,
        members: day.members.length,
        truncated: day.evidence.truncated,
        reason: day.reason,
        durationMs,
      }),
    );
    // Member lines carry ids the organization already owns and NEVER a call
    // identity. There is no line anywhere in this file that prints one.
    for (const member of day.members) {
      deps.log(
        line({
          event: 'MEMBER_RESULT',
          businessDate,
          member: member.memberExternalId,
          expectation: member.expectationState,
          providerCount: member.providerCount,
          localCount: member.localCount,
          providerOnly: member.providerOnly,
          localOnly: member.localOnly,
        }),
      );
    }

    if (!reconciled) {
      result.overall = 'STOPPED_NOT_RECONCILED';
      result.failedDate = businessDate;
      deps.log(
        line({
          event: 'SWEEP_STOPPED',
          businessDate,
          state: day.state,
          remaining: request.dates.slice(request.dates.indexOf(businessDate) + 1).join(','),
        }),
      );
      return result;
    }
    result.reconciled.push(businessDate);
  }

  deps.log(
    line({
      event: 'SWEEP_COMPLETE',
      requested: result.requested.length,
      reconciled: result.reconciled.length,
    }),
  );
  return result;
}

// --- Wiring -------------------------------------------------------------------
//
// Everything above is pure orchestration over two injected seams, which is what
// the tests drive. Below is the only place real dependencies are constructed,
// and it does nothing but construct them.

async function main(): Promise<number> {
  const log = (l: string) => process.stdout.write(l + '\n');

  const args = parseArgs(process.argv.slice(2));
  if (!args.organization) {
    log(line({ event: 'PRECONDITION_FAILED', reason: '--organization <slug> is required' }));
    return 2;
  }
  const parsed = parseDates(args.dates);
  if (parsed.invalid.length > 0) {
    log(line({ event: 'PRECONDITION_FAILED', reason: 'not a business date', invalid: parsed.invalid.join(',') }));
    return 2;
  }
  if (parsed.dates.length === 0) {
    log(line({ event: 'PRECONDITION_FAILED', reason: '--dates YYYY-MM-DD is required' }));
    return 2;
  }

  const env = readEnvironment(process.env);
  if (!env.ok) {
    log(line({ event: 'PRECONDITION_FAILED', reason: 'missing environment', missing: env.missing.join(',') }));
    return 2;
  }

  // Imported here rather than at module scope so the pure orchestration above
  // can be tested without a database client or a provider adapter existing.
  const { prisma, repositories, ProviderReconciliationService } = await import('@emgloop/database');
  const service = new ProviderReconciliationService(prisma);

  try {
    const result = await runSweep(
      { organizationSlug: args.organization, dates: parsed.dates, apiKey: env.value.apiKey },
      {
        reconciler: service,
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

// Executed only when run directly, so importing this file starts nothing. The
// match is ANCHORED to the exact filename — a substring check lets the test
// file, whose name contains this one, run main() as an import side effect.
const ENTRY_POINT = /[\\/]reconcile-provider-days\.ts$/;
if (process.argv[1] && ENTRY_POINT.test(process.argv[1])) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      const detail =
        error instanceof Error ? error.message.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]') : 'unknown';
      process.stdout.write(line({ event: 'RUN_FAILED', reason: detail }) + '\n');
      process.exitCode = 1;
    },
  );
}
