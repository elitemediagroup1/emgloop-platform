// Read integration event coverage — READ-ONLY, counts only.
//
// WHAT IT ANSWERS
//
// For a bounded range of delivery dates: how many CallGrid IntegrationEvent rows
// does this organization hold, WHEN were they received, WHEN did the calls they
// describe actually occur, and how do those two answers line up?
//
// WHY THAT LAST QUESTION IS THE POINT
//
// Reconciliation selects local rows by DELIVERY time — `receivedAt` within two
// days of the business date — and then judges them by OCCURRENCE. That is the
// right shape for live traffic and it has one blind spot: a call that occurred on
// the 11th and was delivered on the 20th is outside every band the 11th ever
// scans, so it is invisible to reconciliation whether or not the row exists.
//
// The 2026-08-11 to 2026-08-13 evidence read showed `localRowsScanned` in the
// thousands, `localInWindow` at zero and `localUnresolvedOccurrence` at zero, and
// the scanned totals were exactly the neighbouring days' known populations — no
// residue at all. That proves nothing occurred on those dates WITHIN the two-day
// band. It cannot see outside it. This can.
//
//   Occurrence buckets empty across a wide range  -> the rows are not here at all.
//   Occurrence buckets populated, delivery later  -> they arrived late, and
//                                                    reconciliation could never
//                                                    have counted them.
//
// Those need opposite responses, and nothing in the platform can currently tell
// them apart.
//
// WHAT IT IS NOT
//
// It is not reconciliation, and it computes no verdict: no set difference, no
// expectation, no authority, no state. It is not recovery and not an importer.
// It contacts no provider and holds no provider credential — the only thing it
// borrows from `@emgloop/providers` is `resolveCallOccurrence`, the CANONICAL
// pure occurrence resolver that reconciliation itself uses. Reimplementing that
// precedence here would be a second occurrence resolver, and the two would
// eventually disagree about exactly the rows being investigated.
//
// COUNTS ONLY, AND THAT IS ENFORCED BY SHAPE. Every row is reduced to three
// values — a delivery date, an occurrence date and a status — the instant it is
// read. No payload, external id, label, phone number or name is ever held beyond
// that reduction, let alone printed.
//
// USAGE
//
//   npm run read:event-coverage -- --organization <slug> --from 2026-08-01 --to 2026-08-19
//
// Credentials come from the environment and are never printed:
//   DATABASE_URL   the production endpoint. NO PROVIDER CREDENTIAL IS READ.

import {
  easternBusinessDate,
  easternBusinessDayWindow,
  isBusinessDate,
  normalizeExternalIdentity,
  type BusinessDate,
} from '@emgloop/shared';

// --- The seams this file is tested through -----------------------------------
//
// Three, all reads, none with a write method. The occurrence resolver is INJECTED
// rather than imported at module scope so the aggregation above can be tested
// without a provider package existing — and `main` wires the canonical one, which
// a test asserts by name.

/** One page of raw rows, exactly as `listEventsReceivedBetween` returns them. */
export interface RawEventRow {
  id: string;
  externalId: string | null;
  status: string;
  receivedAt: Date;
  payload: unknown;
}

export interface EventReader {
  listEventsReceivedBetween(
    organizationId: string,
    options: { provider: string; since: Date; until: Date; batchSize?: number; afterId?: string },
  ): Promise<RawEventRow[]>;
}

/** Read-only organization lookup. This runner may never provision one. */
export interface OrganizationLookup {
  findBySlug(slug: string): Promise<{ id: string; slug: string; name: string; status: string } | null>;
}

/** The CANONICAL resolver's shape. Injected; never reimplemented here. */
export type OccurrenceResolver = (payload: Record<string, unknown>) => { at: Date | null };

export interface CoverageDeps {
  events: EventReader;
  organizations: OrganizationLookup;
  resolveOccurrence: OccurrenceResolver;
  /** Injected so tests can read every line, and so nothing writes to stdout directly. */
  log: (line: string) => void;
}

export interface CoverageRequest {
  organizationSlug: string;
  /** INCLUSIVE first Eastern business date of delivery. */
  from: BusinessDate;
  /** INCLUSIVE last Eastern business date of delivery. See §Date boundary. */
  to: BusinessDate;
}

/** Organization statuses this tool refuses to operate against. */
export const REFUSED_ORGANIZATION_STATUSES = ['SUSPENDED', 'CANCELED'] as const;

/**
 * Fixed scope. NOT AN INPUT, deliberately.
 *
 * The question is about the CallGrid call stream. Offering a provider input would
 * let an operator ask about a provider that has never written a row and read the
 * empty answer as a finding.
 */
export const PROVIDER = 'callgrid';

/** Rows per batch. The same bound reconciliation's local scan uses. */
export const BATCH_SIZE = 500;

/**
 * The stored status vocabulary, from the schema enum.
 *
 * A row carrying anything else is counted under OTHER rather than dropped: an
 * unrecognised status is a fact about the row, and silently excluding it would
 * make the per-day totals stop adding up — which is the one property that makes
 * these buckets checkable.
 */
export const EVENT_STATUSES = ['RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED', 'IGNORED'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];
export const OTHER_STATUS = 'OTHER';

export interface StatusCounts {
  total: number;
  RECEIVED: number;
  PROCESSING: number;
  PROCESSED: number;
  FAILED: number;
  IGNORED: number;
  OTHER: number;
}

export interface CoverageResult {
  overall: 'READ' | 'FAILED_PRECONDITION';
  from: BusinessDate | null;
  to: BusinessDate | null;
  totalRows: number;
  resolvedOccurrenceRows: number;
  unresolvedOccurrenceRows: number;
  missingIdentityRows: number;
  /** Delivery date -> status counts. Sorted ascending by date. */
  byReceivedDate: Array<{ receivedDate: BusinessDate; counts: StatusCounts }>;
  /** Occurrence date -> row count. Sorted ascending. Resolvable rows only. */
  byOccurrenceDate: Array<{ occurrenceDate: BusinessDate; total: number }>;
  /** (occurrence, delivery) -> count. Sorted by occurrence then delivery. */
  crossTiming: Array<{ occurrenceDate: BusinessDate; receivedDate: BusinessDate; count: number }>;
  /** Set only on a precondition failure. Never contains a credential. */
  error: string | null;
}

function emptyCounts(): StatusCounts {
  return { total: 0, RECEIVED: 0, PROCESSING: 0, PROCESSED: 0, FAILED: 0, IGNORED: 0, OTHER: 0 };
}

function countStatus(counts: StatusCounts, status: string): void {
  counts.total += 1;
  if ((EVENT_STATUSES as readonly string[]).includes(status)) {
    counts[status as EventStatus] += 1;
  } else {
    counts[OTHER_STATUS] += 1;
  }
}

// --- Input validation ---------------------------------------------------------

/**
 * Judge the requested range, with the shipped business-date predicate.
 *
 * INVERTED IS REFUSED, EQUAL IS NOT. A single-day range is a legitimate question
 * and `from === to` means exactly that one Eastern day, because `to` is
 * INCLUSIVE. A `to` before `from` describes no day at all.
 */
export function validateRange(
  from: string,
  to: string,
): { ok: true; from: BusinessDate; to: BusinessDate } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  if (!isBusinessDate(from)) problems.push(`--from must be YYYY-MM-DD, not ${String(from)}`);
  if (!isBusinessDate(to)) problems.push(`--to must be YYYY-MM-DD, not ${String(to)}`);
  if (isBusinessDate(from) && isBusinessDate(to) && to < from) {
    problems.push('--to is INCLUSIVE and must not be earlier than --from');
  }
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, from: from as BusinessDate, to: to as BusinessDate };
}

/** Names of the environment values this run needs. Values are never returned. */
export function readEnvironment(
  env: NodeJS.ProcessEnv,
): { ok: true } | { ok: false; missing: string[] } {
  // ONE CREDENTIAL, AND IT IS THE DATABASE. There is no provider read here.
  const databaseUrl = env.DATABASE_URL?.trim() || '';
  if (!databaseUrl) return { ok: false, missing: ['DATABASE_URL'] };
  return { ok: true };
}

/** Minimal flag parsing. Deliberately not a CLI framework. */
export function parseArgs(argv: readonly string[]): { organization: string; from: string; to: string } {
  let organization = '';
  let from = '';
  let to = '';
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1] ?? '';
    if (flag === '--organization' || flag === '--org') {
      organization = value.trim();
      i += 1;
    } else if (flag === '--from' || flag === '--from-date') {
      from = value.trim();
      i += 1;
    } else if (flag === '--to' || flag === '--to-date') {
      to = value.trim();
      i += 1;
    }
  }
  return { organization, from, to };
}

// --- The read -----------------------------------------------------------------

function line(fields: Record<string, string | number | boolean | null>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${k}=${v === null ? '' : String(v)}`)
    .join(' ');
}

/**
 * Count what the delivery record holds, and say nothing else about it.
 *
 * THE RANGE IS INCLUSIVE OF BOTH BUSINESS DATES. `--from` opens at the start of
 * its Eastern day and `--to` closes at the END of its Eastern day, both taken
 * from `easternBusinessDayWindow` — the one place allowed to decide what an
 * Eastern day is, and the same helper reconciliation uses. A range of
 * 2026-08-01..2026-08-19 therefore covers 19 whole Eastern days, not 18.
 *
 * EVERY ROW IS REDUCED THE INSTANT IT IS READ. A delivery date, an occurrence
 * date and a status. The payload is handed to the canonical resolver and dropped;
 * the external id is tested for presence and dropped. Nothing else survives the
 * loop, so there is no later line that could print an identity by accident.
 */
export async function runCoverage(
  request: CoverageRequest,
  deps: CoverageDeps,
): Promise<CoverageResult> {
  const result: CoverageResult = {
    overall: 'READ',
    from: null,
    to: null,
    totalRows: 0,
    resolvedOccurrenceRows: 0,
    unresolvedOccurrenceRows: 0,
    missingIdentityRows: 0,
    byReceivedDate: [],
    byOccurrenceDate: [],
    crossTiming: [],
    error: null,
  };

  const refuse = (reason: string): CoverageResult => {
    deps.log(line({ event: 'PRECONDITION_FAILED', reason }));
    return { ...result, overall: 'FAILED_PRECONDITION', error: reason };
  };

  const range = validateRange(request.from, request.to);
  if (!range.ok) return refuse(range.problems.join('; '));
  result.from = range.from;
  result.to = range.to;

  const organization = await deps.organizations.findBySlug(request.organizationSlug);
  if (!organization) {
    // NOT-FOUND, not forbidden, and never provisioned.
    return refuse(`No organization with slug "${request.organizationSlug}".`);
  }
  if ((REFUSED_ORGANIZATION_STATUSES as readonly string[]).includes(organization.status)) {
    return refuse(`Organization "${organization.slug}" is ${organization.status}.`);
  }

  const since = easternBusinessDayWindow(range.from).start;
  const until = easternBusinessDayWindow(range.to).end;

  deps.log(
    line({
      event: 'COVERAGE_START',
      organization: organization.slug,
      provider: PROVIDER,
      from: range.from,
      to: range.to,
      toIsInclusive: true,
      sinceUtc: since.toISOString(),
      untilUtcExclusive: until.toISOString(),
    }),
  );

  const received = new Map<BusinessDate, StatusCounts>();
  const occurrence = new Map<BusinessDate, number>();
  const cross = new Map<string, { occurrenceDate: BusinessDate; receivedDate: BusinessDate; count: number }>();

  let afterId: string | undefined;
  for (;;) {
    // The SAME batched, organization-scoped read reconciliation uses. There is no
    // second query path here and no raw SQL anywhere in this file.
    const batch = await deps.events.listEventsReceivedBetween(organization.id, {
      provider: PROVIDER,
      since,
      until,
      batchSize: BATCH_SIZE,
      ...(afterId ? { afterId } : {}),
    });
    if (batch.length === 0) break;

    for (const row of batch) {
      result.totalRows += 1;

      const receivedDate = easternBusinessDate(row.receivedAt);
      const bucket = received.get(receivedDate) ?? emptyCounts();
      countStatus(bucket, row.status);
      received.set(receivedDate, bucket);

      // MISSING IDENTITY IS EVALUATED OVER EVERY SCANNED ROW, and that is a
      // deliberate difference from reconciliation. There, the counter is computed
      // AFTER the in-window filter, so on a day with no in-window rows it reports
      // zero and means nothing — which is exactly how it read on 08-11 to 08-13.
      // Here it is unconditional, so a zero is a fact rather than an artefact.
      if (normalizeExternalIdentity(row.externalId) === null) {
        result.missingIdentityRows += 1;
      }

      const payload =
        row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
          ? (row.payload as Record<string, unknown>)
          : {};
      const at = deps.resolveOccurrence(payload).at;
      if (at === null) {
        // COUNTED, NEVER GUESSED. A row whose occurrence cannot be established
        // cannot be filed under a date, and inventing one would put a call on a
        // day nobody can defend.
        result.unresolvedOccurrenceRows += 1;
        continue;
      }
      result.resolvedOccurrenceRows += 1;

      const occurrenceDate = easternBusinessDate(at);
      occurrence.set(occurrenceDate, (occurrence.get(occurrenceDate) ?? 0) + 1);

      const key = `${occurrenceDate}|${receivedDate}`;
      const pair = cross.get(key);
      if (pair) pair.count += 1;
      else cross.set(key, { occurrenceDate, receivedDate, count: 1 });
    }

    const last = batch[batch.length - 1];
    if (!last) break;
    afterId = last.id;
    if (batch.length < BATCH_SIZE) break;
  }

  // SORTED ON THE WAY OUT, not relied upon from a Map's insertion order. Two runs
  // over the same rows must print byte-identical output whatever order the
  // database returned them in, and a test asserts exactly that.
  result.byReceivedDate = [...received.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([receivedDate, counts]) => ({ receivedDate, counts }));
  result.byOccurrenceDate = [...occurrence.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([occurrenceDate, total]) => ({ occurrenceDate, total }));
  result.crossTiming = [...cross.values()].sort((a, b) =>
    a.occurrenceDate === b.occurrenceDate
      ? a.receivedDate < b.receivedDate
        ? -1
        : a.receivedDate > b.receivedDate
          ? 1
          : 0
      : a.occurrenceDate < b.occurrenceDate
        ? -1
        : 1,
  );

  for (const { receivedDate, counts } of result.byReceivedDate) {
    deps.log(
      line({
        event: 'RECEIVED_AT_DAY',
        receivedDate,
        total: counts.total,
        RECEIVED: counts.RECEIVED,
        PROCESSING: counts.PROCESSING,
        PROCESSED: counts.PROCESSED,
        FAILED: counts.FAILED,
        IGNORED: counts.IGNORED,
        OTHER: counts.OTHER,
      }),
    );
  }
  for (const { occurrenceDate, total } of result.byOccurrenceDate) {
    deps.log(line({ event: 'OCCURRENCE_DAY', occurrenceDate, total }));
  }
  for (const { occurrenceDate, receivedDate, count } of result.crossTiming) {
    // THE LINE THIS TOOL EXISTS FOR. `occurrenceDate=2026-08-11 receivedDate=2026-08-20`
    // is the shape that would mean the calls arrived late; its absence, with the
    // occurrence bucket empty, is the shape that means they are not here at all.
    deps.log(line({ event: 'CROSS_TIMING', occurrenceDate, receivedDate, count }));
  }

  deps.log(
    line({
      event: 'QUALITY',
      unresolvedOccurrence: result.unresolvedOccurrenceRows,
      missingIdentity: result.missingIdentityRows,
      missingIdentityScope: 'every scanned row, not only in-window rows',
    }),
  );

  deps.log(
    line({
      event: 'COVERAGE_COMPLETE',
      REQUESTED_FROM: result.from,
      REQUESTED_TO: result.to,
      TOTAL_ROWS: result.totalRows,
      RESOLVED_OCCURRENCE_ROWS: result.resolvedOccurrenceRows,
      UNRESOLVED_OCCURRENCE_ROWS: result.unresolvedOccurrenceRows,
      MISSING_IDENTITY_ROWS: result.missingIdentityRows,
      OVERALL_RESULT: 'READ',
    }),
  );
  return result;
}

// --- Wiring -------------------------------------------------------------------
//
// Everything above is pure aggregation over three injected seams, which is what
// the tests drive. Below is the only place real dependencies are constructed,
// and it does nothing but construct them.

async function main(): Promise<number> {
  const log = (l: string) => process.stdout.write(l + '\n');

  const args = parseArgs(process.argv.slice(2));
  if (!args.organization) {
    log(line({ event: 'PRECONDITION_FAILED', reason: '--organization <slug> is required' }));
    return 2;
  }
  const range = validateRange(args.from, args.to);
  if (!range.ok) {
    log(line({ event: 'PRECONDITION_FAILED', reason: range.problems.join('; ') }));
    return 2;
  }
  const env = readEnvironment(process.env);
  if (!env.ok) {
    log(line({ event: 'PRECONDITION_FAILED', reason: 'missing environment', missing: env.missing.join(',') }));
    return 2;
  }

  // Imported here rather than at module scope so the aggregation above can be
  // tested without a database client or the providers package existing.
  const { prisma, repositories } = await import('@emgloop/database');
  // THE CANONICAL RESOLVER, borrowed rather than reimplemented. It is a pure
  // function over a payload: no client, no credential, no network.
  const { resolveCallOccurrence } = await import('@emgloop/providers');

  try {
    const result = await runCoverage(
      { organizationSlug: args.organization, from: range.from, to: range.to },
      {
        events: repositories.integrations,
        organizations: repositories.organizations,
        resolveOccurrence: resolveCallOccurrence,
        log,
      },
    );
    // AN EMPTY RANGE IS NOT AN ERROR. "No rows were delivered in this window" is
    // the answer to a question somebody asked, and a red run would make an
    // inspection tool look like a gate.
    return result.overall === 'READ' ? 0 : 1;
  } finally {
    await prisma.$disconnect();
  }
}

// Executed only when run directly, so importing this file starts nothing. The
// match is ANCHORED to the exact filename — a substring check lets the test file,
// whose name contains this one, run main() as an import side effect.
const ENTRY_POINT = /[\\/]read-integration-event-coverage\.ts$/;
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
