// Verify a CallGrid business day, three populations wide. READ-ONLY.
//
// WHAT IT ANSWERS
//
// For each Eastern business date, the same day seen from three places, and every
// way they can disagree:
//
//   PROVIDER      what CallGrid holds for the day, through the canonical reader
//   CAPTURED      what integration_events holds, by PROVIDER OCCURRENCE
//   PROJECTED     what marketplace_calls holds, by the projection's copy of it
//
//   provider-only            CallGrid has it, Loop never captured it
//   captured-not-projected   Loop captured it and the read model never got it
//   projected-not-captured   the projection holds a call with no delivery behind
//                            it, which should be impossible and is worth seeing
//
// Those three are different incidents with different responses, and a single
// "missing: 107" cannot tell them apart. That distinction is the entire reason
// this exists as its own operation rather than a bigger number on an existing one.
//
// WHAT IT WILL NOT DO
//
// It writes nothing. No ingestion, no projection, no reconciliation row, no
// checkpoint, no measurement, no Headline. There is no --apply flag to forget.
// It also does not manufacture equality: a day whose populations legitimately
// differ is reported as differing, and a provider read that did not COMPLETE is
// reported as a LOWER BOUND rather than compared as if it were the whole day.
//
// WHAT IT CANNOT ESTABLISH, SAID OUT LOUD
//
// Whether CallGrid ATTEMPTED webhook delivery for a given call, and what Loop
// answered, lives on the per-call detail endpoint. Reading it for a busy day is
// thousands of extra provider requests, and this operation deliberately does not
// make them. So it can prove a call is absent from Loop; it cannot prove from
// here whether it was never sent or was sent and rejected. Every run says so.
//
// USAGE
//
//   npm run verify:callgrid -- --organization <slug> --dates YYYY-MM-DD[,YYYY-MM-DD]
//
// Credentials come from the environment and are never printed:
//   DATABASE_URL       the DIRECT (non-pooled) production endpoint
//   CALLGRID_API_KEY   the provider credential

import {
  OBSERVATION_SOURCES,
  easternBusinessDayWindow,
  isBusinessDate,
  normalizeExternalIdentity,
  type BusinessDate,
} from '@emgloop/shared';

// --- The seams this file is tested through -----------------------------------
//
// Four READS and nothing else. There is no seam here through which a row could be
// written, which is what makes "it cannot repair what it is auditing" a property
// of the type rather than of somebody's care at review time.

/** One provider record, reduced to what a comparison needs. Never a payload. */
export interface ProviderIdentity {
  identity: string | null;
}

export interface ProviderDayRead {
  /** The reader's own outcome, verbatim. COMPLETE is the only whole answer. */
  outcome: string;
  records: ProviderIdentity[];
  /** Raw records seen, including ones the mapper refused. */
  recordsFetched: number;
  /** Provider records the canonical mapper would not map. */
  refused: Array<{ page: number; reason: string; kind?: string }>;
  pages: number;
  providerTotal: number | null;
}

export interface ProviderDayReader {
  read(input: { apiKey: string; since: Date; until: Date }): Promise<ProviderDayRead>;
}

/** One captured delivery, reduced to what a comparison needs. */
export interface CapturedEvent {
  externalId: string | null;
  status: string;
  occurredAt: Date | null;
  firstIngestionSource: string | null;
  observedSources: string[];
}

export interface CapturedReader {
  read(input: {
    organizationId: string;
    provider: string;
    since: Date;
    until: Date;
    legacySince: Date;
    legacyUntil: Date;
  }): Promise<CapturedEvent[]>;
}

/** The projected identity set. Identities only: the row is never loaded. */
export interface ProjectedReader {
  read(input: { organizationId: string; since: Date; until: Date }): Promise<string[]>;
}

/** Stored evidence that already exists elsewhere, read rather than recomputed. */
export interface StoredEvidenceReader {
  reconciliationState(input: {
    organizationId: string;
    businessDate: BusinessDate;
  }): Promise<{ state: string | null; reconciledAt: string } | null>;
  coverage(input: { organizationId: string }): Promise<{ completedThrough: string } | null>;
  unresolvedConflicts(input: {
    organizationId: string;
  }): Promise<{ identities: string[]; capped: boolean }>;
}

/** Read-only organization lookup. This tool may never provision one. */
export interface OrganizationLookup {
  findBySlug(slug: string): Promise<{ id: string; slug: string; name: string; status: string } | null>;
}

export interface VerifyDeps {
  provider: ProviderDayReader;
  captured: CapturedReader;
  projected: ProjectedReader;
  stored: StoredEvidenceReader;
  organizations: OrganizationLookup;
  log: (line: string) => void;
  now: () => Date;
}

export interface VerifyRequest {
  organizationSlug: string;
  dates: readonly BusinessDate[];
  apiKey: string;
}

/**
 * How much of a day this run could actually establish.
 *
 * INCONCLUSIVE IS NOT A FAILURE OF THE TOOL. It is the honest answer when the
 * provider read did not complete: what came back is a lower bound, so every
 * "provider-only" and "local-only" count derived from it is a lower bound too,
 * and calling that a comparison would be the thing this whole stage exists to
 * stop.
 */
export const DAY_VERDICTS = [
  /** Provider read COMPLETE and the three populations agree. */
  'AGREED',
  /** Provider read COMPLETE and they do not. The counts say how. */
  'DIFFERS',
  /** The provider read did not complete. Nothing can be concluded. */
  'INCONCLUSIVE',
  /** The day could not be read at all. */
  'FAILED',
] as const;

export type DayVerdict = (typeof DAY_VERDICTS)[number];

export interface DayReport {
  businessDate: BusinessDate;
  verdict: DayVerdict;
  providerOutcome: string;
  /** True when the provider population is a lower bound rather than the day. */
  providerLowerBound: boolean;
  providerRecordsFetched: number;
  providerIdentities: number;
  providerMissingIdentity: number;
  providerRefused: number;
  providerTotal: number | null;
  capturedRows: number;
  capturedIdentities: number;
  capturedMissingIdentity: number;
  /** Rows with no occurrence COLUMN, judged from the payload. Legacy shape. */
  capturedLegacyOccurrence: number;
  capturedByStatus: Record<string, number>;
  capturedByFirstSource: Record<string, number>;
  capturedObservedBySource: Record<string, number>;
  projectedIdentities: number;
  providerOnly: number;
  capturedNotProjected: number;
  projectedNotCaptured: number;
  intersection: number;
  unresolvedConflicts: number;
  conflictsCapped: boolean;
  reconciliationState: string | null;
  reconciledAt: string | null;
  reason: string | null;
}

export interface VerifyResult {
  overall: 'COMPLETE' | 'INCOMPLETE' | 'FAILED_PRECONDITION';
  organizationSlug: string;
  days: DayReport[];
  coverageProvenThrough: string | null;
  elapsedMs: number;
  error: string | null;
}

// --- Input validation ---------------------------------------------------------

export const REFUSED_ORGANIZATION_STATUSES = ['SUSPENDED', 'CANCELED'] as const;
export const VERIFY_PROVIDER = 'callgrid';
export const VERIFY_STREAM = 'calls';

/**
 * How far either side of the day the LEGACY capture scan reaches.
 *
 * Matches `LOCAL_SCAN_MARGIN_MS` in reconciliation deliberately: this operation
 * exists to check reconciliation's own question, and reaching for a different set
 * of rows than the verdict path would make agreement or disagreement meaningless.
 */
export const LEGACY_SCAN_MARGIN_MS = 2 * 24 * 60 * 60 * 1000;

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

export interface RequiredEnvironment {
  databaseUrl: string;
  apiKey: string;
}

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

// --- Reporting -----------------------------------------------------------------

function line(fields: Record<string, string | number | boolean | null>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${k}=${v === null ? '' : String(v)}`)
    .join(' ');
}

const tally = (counts: Record<string, number>): string =>
  Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k}:${n}`)
    .join('|');

// --- The sweep ------------------------------------------------------------------

/**
 * Verify each requested date, in order, and never stop early.
 *
 * IT DOES NOT STOP AT THE FIRST BAD DAY, which is the opposite of what the
 * certification sweep does — and deliberately. Certification WRITES, so a run
 * that continued past a failure would fill a ledger with rows nobody had looked
 * at. This one writes nothing, and an operator checking a recovery wants the
 * whole picture in one pass, including which days are inconclusive and why.
 */
export async function runVerification(
  request: VerifyRequest,
  deps: VerifyDeps,
): Promise<VerifyResult> {
  const startedAt = deps.now().getTime();
  const result: VerifyResult = {
    overall: 'COMPLETE',
    organizationSlug: request.organizationSlug,
    days: [],
    coverageProvenThrough: null,
    elapsedMs: 0,
    error: null,
  };
  const finish = (): VerifyResult => {
    result.elapsedMs = deps.now().getTime() - startedAt;
    deps.log(
      line({
        event: 'SUMMARY',
        ORGANIZATION: result.organizationSlug,
        DATES: result.days.map((d) => d.businessDate).join(','),
        AGREED: result.days.filter((d) => d.verdict === 'AGREED').length,
        DIFFERS: result.days.filter((d) => d.verdict === 'DIFFERS').length,
        INCONCLUSIVE: result.days.filter((d) => d.verdict === 'INCONCLUSIVE').length,
        FAILED: result.days.filter((d) => d.verdict === 'FAILED').length,
        PROVIDER_ONLY_TOTAL: result.days.reduce((n, d) => n + d.providerOnly, 0),
        CAPTURED_NOT_PROJECTED_TOTAL: result.days.reduce((n, d) => n + d.capturedNotProjected, 0),
        COVERAGE_PROVEN_THROUGH: result.coverageProvenThrough ?? '',
        ELAPSED_MS: result.elapsedMs,
        OVERALL_RESULT: result.overall,
      }),
    );
    // Said on every run, not only when it matters, so nobody reads a clean report
    // as more than it is.
    deps.log(
      line({
        event: 'EVIDENCE_LIMIT',
        webhookDeliveryAttested: 'NO',
        note:
          'Whether CallGrid ATTEMPTED webhook delivery for a call, and what Loop answered, ' +
          'lives on the per-call detail endpoint and is NOT read here. This run can prove a ' +
          'call is absent from Loop; it cannot say from here whether it was never sent or was ' +
          'sent and rejected.',
      }),
    );
    return result;
  };

  if (request.dates.length === 0) {
    result.overall = 'FAILED_PRECONDITION';
    result.error = 'No dates were supplied.';
    deps.log(line({ event: 'PRECONDITION_FAILED', reason: result.error }));
    return finish();
  }

  const organization = await deps.organizations.findBySlug(request.organizationSlug);
  if (!organization) {
    result.overall = 'FAILED_PRECONDITION';
    result.error = `No organization with slug "${request.organizationSlug}".`;
    deps.log(line({ event: 'PRECONDITION_FAILED', reason: result.error }));
    return finish();
  }
  if ((REFUSED_ORGANIZATION_STATUSES as readonly string[]).includes(organization.status)) {
    result.overall = 'FAILED_PRECONDITION';
    result.error = `Organization "${organization.slug}" is ${organization.status}.`;
    deps.log(line({ event: 'PRECONDITION_FAILED', reason: result.error }));
    return finish();
  }

  const coverage = await deps.stored.coverage({ organizationId: organization.id });
  result.coverageProvenThrough = coverage?.completedThrough ?? null;
  const conflicts = await deps.stored.unresolvedConflicts({ organizationId: organization.id });
  const conflictIdentities = new Set(conflicts.identities.map((id) => normalizeExternalIdentity(id) ?? id));

  deps.log(
    line({
      event: 'VERIFY_START',
      organization: organization.slug,
      provider: VERIFY_PROVIDER,
      stream: VERIFY_STREAM,
      dates: request.dates.join(','),
      count: request.dates.length,
      coverageProvenThrough: result.coverageProvenThrough ?? '',
      unresolvedConflictsKnown: conflictIdentities.size,
      conflictsCapped: conflicts.capped,
    }),
  );

  for (const businessDate of request.dates) {
    const report = await oneDay(businessDate, organization.id, request.apiKey, conflictIdentities, conflicts.capped, deps);
    result.days.push(report);
    if (report.verdict === 'INCONCLUSIVE' || report.verdict === 'FAILED') result.overall = 'INCOMPLETE';
  }

  return finish();
}

async function oneDay(
  businessDate: BusinessDate,
  organizationId: string,
  apiKey: string,
  conflictIdentities: ReadonlySet<string>,
  conflictsCapped: boolean,
  deps: VerifyDeps,
): Promise<DayReport> {
  const window = easternBusinessDayWindow(businessDate);
  const report: DayReport = {
    businessDate,
    verdict: 'FAILED',
    providerOutcome: '',
    providerLowerBound: true,
    providerRecordsFetched: 0,
    providerIdentities: 0,
    providerMissingIdentity: 0,
    providerRefused: 0,
    providerTotal: null,
    capturedRows: 0,
    capturedIdentities: 0,
    capturedMissingIdentity: 0,
    capturedLegacyOccurrence: 0,
    capturedByStatus: {},
    capturedByFirstSource: {},
    capturedObservedBySource: {},
    projectedIdentities: 0,
    providerOnly: 0,
    capturedNotProjected: 0,
    projectedNotCaptured: 0,
    intersection: 0,
    unresolvedConflicts: 0,
    conflictsCapped,
    reconciliationState: null,
    reconciledAt: null,
    reason: null,
  };

  let providerRead: ProviderDayRead;
  try {
    providerRead = await deps.provider.read({ apiKey, since: window.start, until: window.end });
  } catch (error) {
    report.reason = error instanceof Error ? error.message : 'unknown error';
    report.providerOutcome = 'THREW';
    deps.log(line({ event: 'DAY_FAILED', date: businessDate, detail: report.reason }));
    return report;
  }

  report.providerOutcome = providerRead.outcome;
  report.providerLowerBound = providerRead.outcome !== 'COMPLETE';
  report.providerRecordsFetched = providerRead.recordsFetched;
  report.providerRefused = providerRead.refused.length;
  report.providerTotal = providerRead.providerTotal;

  const providerIds = new Set<string>();
  for (const record of providerRead.records) {
    const identity = record.identity === null ? null : normalizeExternalIdentity(record.identity);
    if (identity === null) report.providerMissingIdentity += 1;
    else providerIds.add(identity);
  }
  report.providerIdentities = providerIds.size;

  for (const refusal of providerRead.refused) {
    deps.log(
      line({
        event: 'PROVIDER_RECORD_REFUSED',
        date: businessDate,
        page: refusal.page,
        kind: refusal.kind ?? '',
        reason: refusal.reason,
      }),
    );
  }

  // --- Captured ---------------------------------------------------------------
  const captured = await deps.captured.read({
    organizationId,
    provider: VERIFY_PROVIDER,
    since: window.start,
    until: window.end,
    legacySince: new Date(window.start.getTime() - LEGACY_SCAN_MARGIN_MS),
    legacyUntil: new Date(window.end.getTime() + LEGACY_SCAN_MARGIN_MS),
  });
  const capturedIds = new Set<string>();
  for (const row of captured) {
    // A LEGACY ROW IS JUDGED, NOT ASSUMED IN. It arrived through the delivery
    // fallback and only belongs to this day if its occurrence says so; a row whose
    // occurrence cannot be established at all is counted and kept, because it
    // cannot be ruled out either.
    if (row.occurredAt !== null) {
      if (row.occurredAt < window.start || row.occurredAt >= window.end) continue;
    } else {
      report.capturedLegacyOccurrence += 1;
    }
    report.capturedRows += 1;
    report.capturedByStatus[row.status] = (report.capturedByStatus[row.status] ?? 0) + 1;
    const first = row.firstIngestionSource ?? 'UNRECORDED';
    report.capturedByFirstSource[first] = (report.capturedByFirstSource[first] ?? 0) + 1;
    for (const source of row.observedSources.length > 0 ? row.observedSources : ['UNRECORDED']) {
      report.capturedObservedBySource[source] = (report.capturedObservedBySource[source] ?? 0) + 1;
    }
    const identity = row.externalId === null ? null : normalizeExternalIdentity(row.externalId);
    if (identity === null) report.capturedMissingIdentity += 1;
    else capturedIds.add(identity);
  }
  report.capturedIdentities = capturedIds.size;

  // --- Projected ---------------------------------------------------------------
  const projected = await deps.projected.read({
    organizationId,
    since: window.start,
    until: window.end,
  });
  const projectedIds = new Set<string>();
  for (const externalId of projected) {
    const identity = normalizeExternalIdentity(externalId);
    if (identity !== null) projectedIds.add(identity);
  }
  report.projectedIdentities = projectedIds.size;

  // --- The comparisons ----------------------------------------------------------
  for (const identity of providerIds) {
    if (capturedIds.has(identity)) report.intersection += 1;
    else report.providerOnly += 1;
  }
  for (const identity of capturedIds) {
    // THE DISTINCTION THIS OPERATION EXISTS FOR. A captured call with no
    // projection is a read-model gap; a provider call with no capture is a
    // delivery gap. One number covering both would hide whichever was smaller.
    if (!projectedIds.has(identity)) report.capturedNotProjected += 1;
    if (conflictIdentities.has(identity)) report.unresolvedConflicts += 1;
  }
  for (const identity of projectedIds) {
    if (!capturedIds.has(identity)) report.projectedNotCaptured += 1;
  }

  const stored = await deps.stored.reconciliationState({ organizationId, businessDate });
  report.reconciliationState = stored?.state ?? null;
  report.reconciledAt = stored?.reconciledAt ?? null;

  if (report.providerLowerBound) {
    report.verdict = 'INCONCLUSIVE';
    report.reason =
      `The provider read ended ${providerRead.outcome}. What came back is a LOWER BOUND on the ` +
      'day, so every difference below is a lower bound too and none of them is a conclusion.';
  } else if (
    report.providerOnly === 0 &&
    report.capturedNotProjected === 0 &&
    report.projectedNotCaptured === 0 &&
    report.providerRefused === 0
  ) {
    report.verdict = 'AGREED';
  } else {
    report.verdict = 'DIFFERS';
  }

  deps.log(
    line({
      event: 'DAY_REPORT',
      date: businessDate,
      verdict: report.verdict,
      providerOutcome: report.providerOutcome,
      providerLowerBound: report.providerLowerBound,
      providerRecordsFetched: report.providerRecordsFetched,
      providerIdentities: report.providerIdentities,
      providerMissingIdentity: report.providerMissingIdentity,
      providerRefused: report.providerRefused,
      providerStatedTotal: report.providerTotal,
      capturedRows: report.capturedRows,
      capturedIdentities: report.capturedIdentities,
      capturedMissingIdentity: report.capturedMissingIdentity,
      capturedLegacyOccurrence: report.capturedLegacyOccurrence,
      capturedByStatus: tally(report.capturedByStatus),
      capturedByFirstSource: tally(report.capturedByFirstSource),
      capturedObservedBySource: tally(report.capturedObservedBySource),
      projectedIdentities: report.projectedIdentities,
      intersection: report.intersection,
      PROVIDER_ONLY: report.providerOnly,
      CAPTURED_NOT_PROJECTED: report.capturedNotProjected,
      PROJECTED_NOT_CAPTURED: report.projectedNotCaptured,
      unresolvedConflicts: report.unresolvedConflicts,
      conflictsCapped: report.conflictsCapped,
      reconciliationState: report.reconciliationState ?? '',
      reconciledAt: report.reconciledAt ?? '',
      reason: report.reason ?? '',
    }),
  );
  return report;
}

// --- Wiring -------------------------------------------------------------------

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
    log(line({ event: 'PRECONDITION_FAILED', reason: '--dates YYYY-MM-DD[,...] is required' }));
    return 2;
  }

  const env = readEnvironment(process.env);
  if (!env.ok) {
    log(line({ event: 'PRECONDITION_FAILED', reason: 'missing environment', missing: env.missing.join(',') }));
    return 2;
  }

  const providers = await import('@emgloop/providers');
  const {
    prisma,
    repositories,
    CALLGRID_POLL_PROVIDER,
    CALLGRID_POLL_STREAM,
  } = await import('@emgloop/database');

  try {
    const result = await runVerification(
      { organizationSlug: args.organization, dates, apiKey: env.value.apiKey },
      {
        provider: {
          // THE CANONICAL READER, which is also what the poll and the recovery
          // use. A verification that enumerated the provider differently could
          // disagree with the thing it is verifying and nobody would know which
          // was wrong.
          async read(input) {
            const read = await providers.readCallGridInterval({
              apiKey: input.apiKey,
              since: input.since,
              until: input.until,
            });
            return {
              outcome: read.outcome,
              records: read.events.map((event) => ({ identity: event.externalId })),
              recordsFetched: read.records,
              refused: read.refused.map((r) => ({
                page: r.page,
                reason: r.reason,
                ...(r.kind ? { kind: r.kind } : {}),
              })),
              pages: read.pages,
              providerTotal: typeof read.providerTotal === 'number' ? read.providerTotal : null,
            };
          },
        },
        captured: {
          async read(input) {
            const out: CapturedEvent[] = [];
            let afterId: string | undefined;
            for (;;) {
              const batch = await repositories.integrations.listEventsForOccurrenceWindow(
                input.organizationId,
                {
                  provider: input.provider,
                  since: input.since,
                  until: input.until,
                  legacySince: input.legacySince,
                  legacyUntil: input.legacyUntil,
                  batchSize: 500,
                  ...(afterId ? { afterId } : {}),
                },
              );
              if (batch.length === 0) break;
              for (const row of batch) {
                const payload =
                  row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
                    ? (row.payload as Record<string, unknown>)
                    : {};
                out.push({
                  externalId: row.externalId,
                  status: row.status,
                  // The column where it exists; the canonical resolver only for a
                  // legacy row, exactly as reconciliation does it.
                  occurredAt: row.occurredAt ?? providers.resolveCallOccurrence(payload).at,
                  firstIngestionSource: row.firstIngestionSource,
                  observedSources: row.observedSources,
                });
              }
              const last = batch[batch.length - 1];
              if (!last) break;
              afterId = last.id;
              if (batch.length < 500) break;
            }
            return out;
          },
        },
        projected: {
          async read(input) {
            const out: string[] = [];
            let afterId: string | undefined;
            for (;;) {
              const batch = await repositories.marketplaceCalls.listIdentitiesInWindow(
                input.organizationId,
                input.since,
                input.until,
                { batchSize: 500, ...(afterId ? { afterId } : {}) },
              );
              if (batch.length === 0) break;
              for (const row of batch) out.push(row.externalId);
              const last = batch[batch.length - 1];
              if (!last) break;
              afterId = last.id;
              if (batch.length < 500) break;
            }
            return out;
          },
        },
        stored: {
          async reconciliationState(input) {
            const view = await repositories.providerReconciliations.findDay(
              input.organizationId,
              CALLGRID_POLL_PROVIDER,
              CALLGRID_POLL_STREAM,
              input.businessDate,
            );
            return view ? { state: view.state, reconciledAt: view.reconciledAt } : null;
          },
          async coverage(input) {
            const view = await repositories.pollCheckpoints.find(
              input.organizationId,
              CALLGRID_POLL_PROVIDER,
              CALLGRID_POLL_STREAM,
            );
            return view ? { completedThrough: view.completedThrough.toISOString() } : null;
          },
          async unresolvedConflicts(input) {
            const rows = await repositories.providerFactRevisions.conflicts(input.organizationId, 500);
            return { identities: rows.map((r) => r.externalId), capped: rows.length >= 500 };
          },
        },
        organizations: repositories.organizations,
        log,
        now: () => new Date(),
      },
    );
    return result.overall === 'COMPLETE' ? 0 : 1;
  } finally {
    await prisma.$disconnect();
  }
}

// Executed only when run directly. The match is ANCHORED to the exact filename.
const ENTRY_POINT = /[\\/]verify-callgrid-recovery\.ts$/;
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

/** Exported so a test can assert the vocabulary it reports is the shipped one. */
export const OBSERVATION_SOURCE_VOCABULARY = OBSERVATION_SOURCES;
