// Read stored reconciliation evidence — READ-ONLY, and structurally incapable of
// anything else.
//
// WHAT IT IS
//
// A printer. `reconcileDay` already stored, for every business date it ran, a
// block of counts describing how trustworthy the comparison was — how many local
// rows it scanned, how many fell inside the day, how many carried no resolvable
// occurrence, how many carried no identity, and whether the provider read was
// truncated. The sweep runner prints the verdict and the set arithmetic. It does
// not print that block, so the evidence exists in production and has never been
// read.
//
// WHY THAT MATTERS RIGHT NOW
//
// The 2026-08-06 to 2026-08-19 evidence pass found three consecutive days —
// 08-11, 08-12, 08-13 — where the provider held 9,984 call identities and Loop
// held NONE. Two very different faults produce that same zero:
//
//   localRowsScanned = 0   nothing was ever received. The deliveries did not
//                          arrive, or were rejected before a row was written.
//   localRowsScanned > 0   rows arrived and something about them — occurrence,
//   with localInWindow = 0 identity, attribution — kept them out of the day.
//
// One is an ingestion outage and the other is a data defect, they need opposite
// responses, and the number that separates them is already sitting in the rows.
// This reads it.
//
// WHAT IT IS NOT
//
// It is not reconciliation. It computes no set difference, contacts no provider,
// holds no provider credential and CANNOT acquire one: `reconcileDay` is not on
// its seam, and there is a test asserting the name does not appear in this file.
// Running it changes nothing, and running it twice changes nothing twice.
//
// It is not recovery, and it is not a judgement. A stored state of
// UNKNOWN_EXPECTATION or INCONCLUSIVE is what this tool exists to show, so it is
// printed and the run stays green. Exiting non-zero on a finding would make an
// inspection tool look like a gate, and somebody would eventually stop running it.
//
// USAGE
//
//   npm run read:reconciliation-evidence -- --organization <slug> --dates 2026-08-11,2026-08-12
//
// Credentials come from the environment and are never printed:
//   DATABASE_URL   the production endpoint. NO PROVIDER CREDENTIAL IS READ.

import { isBusinessDate, type BusinessDate, type ReconciliationState } from '@emgloop/shared';
import type { ReconciliationDayView } from '@emgloop/database';

// --- The seams this file is tested through -----------------------------------
//
// Two reads, and nothing else exists to be called. There is no write method on
// either interface, so "it cannot mutate production" is a property of the type
// rather than of somebody's care at review time — the same shape the sweep
// runner uses, minus its one write.

/** The single stored-row read. Scoped by organization, provider and stream. */
export interface ReconciliationReader {
  findDay(
    organizationId: string,
    provider: string,
    stream: string,
    businessDate: BusinessDate,
  ): Promise<ReconciliationDayView | null>;
}

/** Read-only organization lookup. This runner may never provision one. */
export interface OrganizationLookup {
  findBySlug(slug: string): Promise<{ id: string; slug: string; name: string; status: string } | null>;
}

export interface ReadDeps {
  reconciliations: ReconciliationReader;
  organizations: OrganizationLookup;
  /** Injected so tests can read every line, and so nothing writes to stdout directly. */
  log: (line: string) => void;
}

export interface ReadRequest {
  organizationSlug: string;
  dates: readonly BusinessDate[];
}

export interface DateEvidence {
  businessDate: BusinessDate;
  rowFound: boolean;
  state: ReconciliationState | null;
  reconciled: boolean;
}

export interface ReadResult {
  overall: 'READ' | 'FAILED_PRECONDITION';
  requested: readonly BusinessDate[];
  found: BusinessDate[];
  missing: BusinessDate[];
  dates: DateEvidence[];
  /** Set only on a precondition failure. Never contains a credential. */
  error: string | null;
}

/** Organization statuses this tool refuses to operate against. */
export const REFUSED_ORGANIZATION_STATUSES = ['SUSPENDED', 'CANCELED'] as const;

// --- Fixed scope --------------------------------------------------------------
//
// NOT INPUTS, DELIBERATELY, and for the reason the expectation bridge already
// established: the stored rows this reads exist only for the Stage 3 CallGrid
// call stream, and offering provider and stream as inputs would let an operator
// ask a question that can only ever come back MISSING while looking like a
// finding about the data.

export const PROVIDER = 'callgrid';
export const STREAM = 'calls';

// --- Input validation ---------------------------------------------------------

/**
 * Parse the operator's `--dates` value into business dates.
 *
 * The predicate is `isBusinessDate` from business-time.ts, the same one the
 * reconciliation write applied, so a date this tool accepts cannot be one the
 * stored row is keyed differently by.
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
export function readEnvironment(
  env: NodeJS.ProcessEnv,
): { ok: true } | { ok: false; missing: string[] } {
  // ONE CREDENTIAL, AND IT IS THE DATABASE. There is no provider read here, so
  // asking for a provider key would be asking for a capability this tool must
  // not have.
  const databaseUrl = env.DATABASE_URL?.trim() || '';
  if (!databaseUrl) return { ok: false, missing: ['DATABASE_URL'] };
  return { ok: true };
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

// --- The read -----------------------------------------------------------------

function line(fields: Record<string, string | number | boolean | null>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${k}=${v === null ? '' : String(v)}`)
    .join(' ');
}

/**
 * Print what the record already says about each requested date.
 *
 * A MISSING ROW IS A RESULT, NOT A GAP IN THE OUTPUT. "That day was never
 * reconciled" and "that day reconciled and found nothing" are different facts,
 * and a printer that skipped the first would let a reader scanning the list
 * conclude the window was covered. Every requested date gets a line.
 */
export async function runRead(request: ReadRequest, deps: ReadDeps): Promise<ReadResult> {
  const result: ReadResult = {
    overall: 'READ',
    requested: request.dates,
    found: [],
    missing: [],
    dates: [],
    error: null,
  };

  const refuse = (reason: string): ReadResult => {
    deps.log(line({ event: 'PRECONDITION_FAILED', reason }));
    return { ...result, overall: 'FAILED_PRECONDITION', error: reason };
  };

  if (request.dates.length === 0) return refuse('No dates were supplied.');

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
      event: 'READ_START',
      organization: organization.slug,
      provider: PROVIDER,
      stream: STREAM,
      dates: request.dates.join(','),
    }),
  );

  for (const businessDate of request.dates) {
    // TENANT SCOPE COMES FROM THE RESOLVED ORGANIZATION, through the repository's
    // own scoped read. There is no raw query here and no path by which another
    // tenant's row could be reached.
    const day = await deps.reconciliations.findDay(organization.id, PROVIDER, STREAM, businessDate);

    if (!day) {
      result.missing.push(businessDate);
      result.dates.push({ businessDate, rowFound: false, state: null, reconciled: false });
      deps.log(
        line({
          event: 'DAY_EVIDENCE',
          businessDate,
          rowFound: false,
          result: 'MISSING',
          detail: 'no reconciliation has been recorded for this date',
        }),
      );
      continue;
    }

    // `state` is null when the stored vocabulary cannot be read by this build.
    // Printed as-is rather than guessed at: an unreadable state is a fact about
    // the row, and this tool's job is to report the row.
    const reconciled = day.state === 'RECONCILED';
    result.found.push(businessDate);
    result.dates.push({ businessDate, rowFound: true, state: day.state, reconciled });

    deps.log(
      line({
        event: 'DAY_EVIDENCE',
        businessDate,
        rowFound: true,
        state: day.state,
        reconciled,
        // The set arithmetic, so the evidence block below can be read against it.
        providerUnique: day.counts.providerUnique,
        localUnique: day.counts.localUnique,
        intersection: day.counts.intersection,
        providerOnly: day.counts.providerOnly,
        localOnly: day.counts.localOnly,
        providerOnlyExpected: day.counts.providerOnlyExpected,
        providerOnlyNotConfigured: day.counts.providerOnlyNotConfigured,
        providerOnlyExcluded: day.counts.providerOnlyExcluded,
        providerOnlyUnknownMember: day.counts.providerOnlyUnknownMember,
      }),
    );

    // THE BLOCK THIS TOOL EXISTS FOR. `localRowsScanned` is the one that
    // separates "nothing arrived" from "things arrived and did not belong to
    // this day", and it has never been printed anywhere.
    deps.log(
      line({
        event: 'DAY_LOCAL_EVIDENCE',
        businessDate,
        localRowsScanned: day.evidence.localRowsScanned,
        localInWindow: day.evidence.localInWindow,
        localUnresolvedOccurrence: day.evidence.localUnresolvedOccurrence,
        localMissingIdentity: day.evidence.localMissingIdentity,
        truncated: day.evidence.truncated,
      }),
    );

    deps.log(
      line({
        event: 'DAY_PROVIDER_EVIDENCE',
        businessDate,
        providerRecords: day.evidence.providerRecords,
        providerUnattributed: day.evidence.providerUnattributed,
        pagesFetched: day.evidence.pagesFetched,
        pageCap: day.evidence.pageCap,
        localStage: day.localStage,
        ruleVersion: day.ruleVersion,
        timezone: day.timezone,
        observedAt: day.observedAt,
        reconciledAt: day.reconciledAt,
        reason: day.reason,
      }),
    );

    // Member lines carry ids the organization already owns and its own
    // declarations. There is no call identity, no label, no phone number and no
    // payload anywhere in this file — the stored view exposes counts and member
    // facts only, and the allowlist above is the whole of what is printed.
    for (const member of day.members) {
      deps.log(
        line({
          event: 'MEMBER_EVIDENCE',
          businessDate,
          member: member.memberExternalId,
          dimension: member.dimension,
          expectation: member.expectationState,
          expectationMatches: member.expectationMatches,
          providerCount: member.providerCount,
          localCount: member.localCount,
          providerOnly: member.providerOnly,
          localOnly: member.localOnly,
        }),
      );
    }
  }

  deps.log(
    line({
      event: 'READ_COMPLETE',
      REQUESTED_DATES: result.requested.join(','),
      FOUND_DATES: result.found.join(','),
      MISSING_DATES: result.missing.join(','),
      // READ means the record was inspected and printed. It says nothing about
      // whether what it found is good news, and it deliberately cannot: a tool
      // that went red on a finding would be a gate wearing an inspector's name.
      OVERALL_RESULT: 'READ',
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
  // can be tested without a database client existing.
  const { prisma, repositories } = await import('@emgloop/database');

  try {
    const result = await runRead(
      { organizationSlug: args.organization, dates: parsed.dates },
      {
        reconciliations: repositories.providerReconciliations,
        organizations: repositories.organizations,
        log,
      },
    );
    // A MISSING ROW IS NOT AN ERROR EITHER. It is the answer to "was this day
    // ever reconciled", and the summary names which dates it was. Only a
    // precondition failure — no organization, no valid dates, no credential —
    // is a red run.
    return result.overall === 'READ' ? 0 : 1;
  } finally {
    await prisma.$disconnect();
  }
}

// Executed only when run directly, so importing this file starts nothing. The
// match is ANCHORED to the exact filename — a substring check lets the test
// file, whose name contains this one, run main() as an import side effect.
const ENTRY_POINT = /[\\/]read-reconciliation-evidence\.ts$/;
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
