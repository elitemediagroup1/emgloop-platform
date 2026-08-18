// Reconcile one provider day against Loop's local identities — READ-ONLY.
//
// WHAT IT IS
//
// The smallest thing that can answer one question: for a single bounded Eastern
// business day, WHICH provider call identities does CallGrid hold that Loop's
// IntegrationEvent population does not, and what non-PII characteristics do
// those records share?
//
// It exists because production SQL cannot answer it. `ProviderObservationDay`
// records the COUNT the provider returned, never the identity SET, so Neon can
// prove "974 observed, 867 held" and nothing beyond it. The difference is a set
// operation over two populations that have never been in the same place at the
// same time. This puts them there, in memory, for the duration of one run.
//
// WHAT IT IS NOT
//
// It is not certification. It writes no ProviderObservationDay row, and it does
// not decide whether a day was observed — `ProviderObservationService` owns that
// and keeps owning it. Running this changes nothing about whether Stage 3 may
// measure a day.
//
// It is not recovery. It does not ingest, normalize, project, sync, replay or
// repair anything. Discovering that CallGrid holds a hundred calls Loop is
// missing produces a printed number and nothing else. Recovery is a separate
// operation behind a separate decision.
//
// IT PERFORMS NO WRITES. The seams below are the only capabilities it has: one
// provider read, one organization lookup, one batched SELECT. There is no
// IngestionService, no NormalizationEngine, no MarketplaceCall projection, no
// sync route, no ProviderObservationRepository and no connection-diagnostic
// update anywhere in this file, and a test asserts each of those names is
// absent from its source.
//
// PII
//
// The provider payload carries caller phone numbers. This file never holds one:
// `providerFactFrom` copies an ALLOWLIST of non-PII fields off each record and
// the raw payload is dropped on the spot. Local payloads are treated the same
// way. Identities live in memory for the set comparison and are never printed —
// `--id-hashes N` emits truncated SHA-256 prefixes only, and only when an
// operator asks for something to hand to provider support.
//
// TRUNCATION IS NOT A RESULT. If the provider still had pages when the budget
// ran out, what was read is a lower bound, and a set difference computed over a
// lower bound would report absent records that were merely unread. That case
// returns INCONCLUSIVE_PROVIDER_TRUNCATED and no reconciliation verdict.
//
// USAGE
//
//   npm run reconcile:provider-day -- --organization servicesinmycity-demo --date 2026-08-05
//
// Credentials come from the environment and are never printed:
//   DATABASE_URL       the DIRECT (non-pooled) production endpoint
//   CALLGRID_API_KEY   the provider credential

import { createHash } from 'node:crypto';
import {
  BUSINESS_TIME_ZONE,
  easternBusinessDayWindow,
  isBusinessDate,
  type BusinessDate,
} from '@emgloop/shared';

// --- Bounds -------------------------------------------------------------------

/**
 * Page budget for one reconciliation read.
 *
 * The same 100 that `ProviderObservationService.CERTIFICATION_PAGE_CAP` uses, and
 * deliberately the same number rather than a second opinion about how big a day
 * can be: a diagnostic that read further than certification could report a
 * difference that certification would never have seen. August 5 needed 11 pages.
 */
export const RECONCILIATION_PAGE_CAP = 100;

/**
 * How far either side of the day's UTC interval the LOCAL delivery scan reaches.
 *
 * `integration_events` has no occurrence column — the call's own instant lives
 * inside `payload` — so rows are selected by `receivedAt` and then filtered by
 * resolved occurrence in memory. A webhook that arrived late, was retried the
 * next morning, or was imported by a sync days afterwards still belongs to the
 * day it OCCURRED on, and a scan bounded to the day itself would silently
 * classify it as absent. Two days of margin covers retry and same-week
 * reconciliation; it is a scan bound, never a claim about the window.
 */
export const LOCAL_SCAN_MARGIN_MS = 2 * 24 * 60 * 60 * 1000;

/**
 * Rows per batch when scanning local events. Bounded so a busy window is read in
 * pieces rather than materialised at once.
 */
export const LOCAL_SCAN_BATCH_SIZE = 500;

/**
 * Below this share of the smaller set, an intersection is treated as evidence
 * that the two sides are not naming the same thing — not as a reconciliation
 * result. Two id spaces that genuinely describe the same calls overlap almost
 * completely; a near-empty intersection means the comparison itself is wrong,
 * and reporting it as "everything is missing" would be a false alarm of the most
 * expensive kind.
 */
export const IDENTITY_COHERENCE_FLOOR = 0.5;

// --- Non-PII allowlist --------------------------------------------------------

/**
 * The ONLY provider fields this diagnostic copies off a record.
 *
 * An allowlist, not a denylist. A denylist has to anticipate every field a
 * provider might add; this cannot leak a field nobody thought of, because a
 * field nobody named is never read. `caller`, `callerId`, `fromNumber`, `from`,
 * `to`, `destinationNumber`, `inboundZip` and every recording/transcript URL are
 * absent by construction rather than by exclusion.
 *
 * `inboundState` is deliberately NOT here. The brief allows it "if genuinely
 * needed and safe"; it is not needed to tell an outcome class from an ordinary
 * call, and a state is a weak identifier on a small population.
 */
export const SAFE_PROVIDER_FIELDS = [
  'callStatus',
  'endedBy',
  'completed',
  'billable',
  'noRoute',
  'converted',
  'paid',
  'duplicate',
  'blocked',
  'connected',
  'connectFailed',
  'noConnect',
  'durationSeconds',
  'vendorId',
  'sourceId',
  'buyerId',
  'campaignId',
  'destinationId',
] as const;

/**
 * Payload keys whose PRESENCE distinguishes how a stored local event arrived.
 *
 * `apiSource` is stamped only by `mapCallGridApiRecord`, so a local row carrying
 * it came through the REST sync. `occurredAtUnix` is the webhook template's
 * canonical timestamp key (docs/CALLGRID_WEBHOOK_CONTRACT.md, confirmed against
 * the live template 2026-07-19) and the REST Call object has no such field.
 * Counting both across the local population answers "webhook, sync, or a mix?"
 * from the data rather than from an assumption.
 */
export const DELIVERY_PATH_MARKERS = [
  'apiSource',
  'occurredAtUnix',
  'UTCUnixTimeMs',
  'UTCISODate',
  'UTCUnixTime',
  'callSid',
  'callHash',
  'vendorName',
  'profit',
] as const;

/** Field names that must never appear in output. Asserted by test. */
export const FORBIDDEN_OUTPUT_FIELDS = [
  'caller',
  'callerId',
  'fromNumber',
  'from',
  'to',
  'destinationNumber',
  'inboundZip',
  'callerZip',
  'email',
  'recordingUrl',
  'transcript',
] as const;

// --- Shapes -------------------------------------------------------------------

/** One provider record, reduced to its identity, its instant, and safe fields. */
export interface ProviderFact {
  identity: string;
  occurredAt: Date;
  fields: Record<string, string | null>;
}

/** One local IntegrationEvent, reduced the same way. */
export interface LocalFact {
  identity: string | null;
  occurredAt: Date | null;
  status: string;
  markers: Record<string, boolean>;
}

/** What a provider read produced. */
export interface ProviderRead {
  facts: ProviderFact[];
  recordsFetched: number;
  pagesFetched: number;
  pageCap: number;
  truncated: boolean;
}

export interface DayWindow {
  businessDate: BusinessDate;
  timezone: string;
  start: Date;
  end: Date;
}

/** The one provider capability this diagnostic has. Read-only by type. */
export interface ProviderEnumerator {
  enumerate(input: {
    organizationId: string;
    apiKey: string;
    window: DayWindow;
    pageCap: number;
  }): Promise<ProviderRead>;
}

/** The one local capability. A batched SELECT and nothing else. */
export interface LocalIdentityReader {
  read(input: {
    organizationId: string;
    provider: string;
    since: Date;
    until: Date;
  }): Promise<LocalFact[]>;
}

/** Read-only organization lookup. This tool may never provision one. */
export interface OrganizationLookup {
  findBySlug(slug: string): Promise<{ id: string; slug: string; name: string; status: string } | null>;
}

export interface ReconcileDeps {
  provider: ProviderEnumerator;
  local: LocalIdentityReader;
  organizations: OrganizationLookup;
  log: (line: string) => void;
  now: () => Date;
}

export interface ReconcileRequest {
  organizationSlug: string;
  businessDate: BusinessDate;
  apiKey: string;
  providerName: string;
  /** How many truncated identity hashes to print. 0 (the default) prints none. */
  idHashes: number;
  pageCap?: number;
}

export type ReconcileVerdict =
  | 'FAILED_PRECONDITION'
  | 'INCONCLUSIVE_PROVIDER_TRUNCATED'
  | 'INCONCLUSIVE_IDENTITY_INCOHERENT'
  | 'DIAGNOSTIC_DEFECT'
  | 'RECONCILED_COMPLETE'
  | 'PROVIDER_ONLY_POPULATION'
  | 'LOCAL_ONLY_POPULATION'
  | 'BOTH_DIRECTIONS';

export interface SetReconciliation {
  providerRecords: number;
  providerUnique: number;
  providerDuplicateIds: number;
  providerExcessRows: number;
  localRows: number;
  localInWindow: number;
  localUnresolvedOccurrence: number;
  localMissingIdentity: number;
  localUnique: number;
  localDuplicateIds: number;
  intersection: number;
  providerOnly: number;
  localOnly: number;
  providerEquationHolds: boolean;
  localEquationHolds: boolean;
}

export interface Cohort {
  label: string;
  count: number;
  fields: Record<string, Record<string, number>>;
  durationBuckets: Record<string, number>;
}

export interface BoundaryAnalysis {
  earliest: string | null;
  latest: string | null;
  firstFifteenMinutes: number;
  lastFifteenMinutes: number;
  firstHour: number;
  lastHour: number;
  hourly: number[];
}

export interface ReconcileResult {
  verdict: ReconcileVerdict;
  organizationSlug: string;
  window: DayWindow | null;
  providerRead: { pagesFetched: number; pageCap: number; truncated: boolean } | null;
  sets: SetReconciliation | null;
  providerOnlyCohort: Cohort | null;
  matchedCohort: Cohort | null;
  boundary: BoundaryAnalysis | null;
  deliveryPath: Record<string, number> | null;
  localStatuses: Record<string, number> | null;
  idHashes: string[];
  error: string | null;
}

// --- Pure helpers -------------------------------------------------------------

/**
 * Normalise a raw identity for comparison.
 *
 * Trimmed and coerced to string, because the webhook template sends EVERY value
 * as a quoted string while the REST client may return a native type — the same
 * id could otherwise arrive as `"123"` on one side and `123` on the other and
 * compare unequal. Case is deliberately PRESERVED: CallGrid ids are cuids, whose
 * case is significant, and lowercasing them would merge two distinct records if
 * the provider ever issued ids differing only in case.
 */
export function normaliseIdentity(raw: unknown): string | null {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return trimmed === '' ? null : trimmed;
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  return null;
}

/** A stable, non-reversible short reference for an identity. Never the id itself. */
export function hashIdentity(identity: string): string {
  return createHash('sha256').update(identity).digest('hex').slice(0, 12);
}

/** Render a safe field value as a comparable label. Absence is a real category. */
export function labelOf(value: unknown): string {
  if (value === null || value === undefined) return '(absent)';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  const s = String(value).trim();
  return s === '' ? '(absent)' : s;
}

/** Bucket a connected duration. Absence stays its own bucket, never a zero. */
export function durationBucket(raw: unknown): string {
  if (raw === null || raw === undefined || raw === '') return '(absent)';
  const n = Number(raw);
  if (!Number.isFinite(n)) return '(absent)';
  if (n <= 0) return '0s';
  if (n <= 10) return '1-10s';
  if (n <= 30) return '11-30s';
  if (n <= 60) return '31-60s';
  return '60s+';
}

/** Copy the allowlisted fields off a raw provider payload. Raw is not retained. */
export function safeFieldsFrom(payload: Record<string, unknown>): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const key of SAFE_PROVIDER_FIELDS) {
    const value = payload[key];
    out[key] = value === undefined || value === null ? null : String(value);
  }
  return out;
}

/** Which delivery-path markers a stored local payload carries. */
export function markersFrom(payload: Record<string, unknown>): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const key of DELIVERY_PATH_MARKERS) {
    out[key] = Object.prototype.hasOwnProperty.call(payload, key);
  }
  return out;
}

/** Count values into a distribution, sorted by descending count then label. */
export function distribution(values: readonly string[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  const entries = [...counts.entries()].sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));
  const out: Record<string, number> = {};
  for (const [k, n] of entries) out[k] = n;
  return out;
}

/** Build one cohort's comparative distributions. */
export function cohortOf(label: string, facts: readonly ProviderFact[]): Cohort {
  const fields: Record<string, Record<string, number>> = {};
  for (const key of SAFE_PROVIDER_FIELDS) {
    if (key === 'durationSeconds') continue;
    fields[key] = distribution(facts.map((f) => labelOf(f.fields[key])));
  }
  return {
    label,
    count: facts.length,
    fields,
    durationBuckets: distribution(facts.map((f) => durationBucket(f.fields['durationSeconds']))),
  };
}

/**
 * Where in the day a population sits.
 *
 * A difference caused by a boundary disagreement clusters at one end; a
 * difference caused by an outcome class is spread across the day. This is the
 * cheapest test that separates them, and it needs no provider configuration.
 */
export function boundaryAnalysisOf(window: DayWindow, occurrences: readonly Date[]): BoundaryAnalysis {
  const sorted = [...occurrences].sort((a, b) => a.getTime() - b.getTime());
  const start = window.start.getTime();
  const end = window.end.getTime();
  const quarter = 15 * 60 * 1000;
  const hour = 60 * 60 * 1000;
  const hourly = new Array<number>(24).fill(0);
  for (const d of sorted) {
    const offset = d.getTime() - start;
    const index = Math.floor(offset / hour);
    if (index >= 0 && index < 24) hourly[index] = (hourly[index] ?? 0) + 1;
  }
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  return {
    earliest: first ? first.toISOString() : null,
    latest: last ? last.toISOString() : null,
    firstFifteenMinutes: sorted.filter((d) => d.getTime() < start + quarter).length,
    lastFifteenMinutes: sorted.filter((d) => d.getTime() >= end - quarter).length,
    firstHour: sorted.filter((d) => d.getTime() < start + hour).length,
    lastHour: sorted.filter((d) => d.getTime() >= end - hour).length,
    hourly,
  };
}

/**
 * The set reconciliation itself.
 *
 * Deduplicates BOTH sides before comparing, because a duplicate on either side
 * shifts the apparent difference without a single record being missing — which
 * is exactly the trap the Interaction duplicate sprang on the count-based
 * reading of this same day.
 */
export function reconcileSets(
  providerFacts: readonly ProviderFact[],
  localFacts: readonly LocalFact[],
  window: DayWindow,
): { sets: SetReconciliation; providerOnlyFacts: ProviderFact[]; matchedFacts: ProviderFact[] } {
  const providerSeen = new Map<string, ProviderFact>();
  let providerExcessRows = 0;
  const providerDuplicated = new Set<string>();
  for (const fact of providerFacts) {
    if (providerSeen.has(fact.identity)) {
      providerExcessRows += 1;
      providerDuplicated.add(fact.identity);
      continue;
    }
    providerSeen.set(fact.identity, fact);
  }

  const inWindow = localFacts.filter(
    (f) => f.occurredAt !== null && f.occurredAt >= window.start && f.occurredAt < window.end,
  );
  const localUnresolved = localFacts.filter((f) => f.occurredAt === null).length;
  const localMissingIdentity = inWindow.filter((f) => f.identity === null).length;

  const localSeen = new Set<string>();
  const localDuplicated = new Set<string>();
  for (const fact of inWindow) {
    if (fact.identity === null) continue;
    if (localSeen.has(fact.identity)) localDuplicated.add(fact.identity);
    else localSeen.add(fact.identity);
  }

  const providerOnlyFacts: ProviderFact[] = [];
  const matchedFacts: ProviderFact[] = [];
  for (const [identity, fact] of providerSeen) {
    if (localSeen.has(identity)) matchedFacts.push(fact);
    else providerOnlyFacts.push(fact);
  }
  let localOnly = 0;
  for (const identity of localSeen) if (!providerSeen.has(identity)) localOnly += 1;

  const providerUnique = providerSeen.size;
  const localUnique = localSeen.size;
  const intersection = matchedFacts.length;

  return {
    sets: {
      providerRecords: providerFacts.length,
      providerUnique,
      providerDuplicateIds: providerDuplicated.size,
      providerExcessRows,
      localRows: localFacts.length,
      localInWindow: inWindow.length,
      localUnresolvedOccurrence: localUnresolved,
      localMissingIdentity,
      localUnique,
      localDuplicateIds: localDuplicated.size,
      intersection,
      providerOnly: providerOnlyFacts.length,
      localOnly,
      providerEquationHolds: providerUnique === intersection + providerOnlyFacts.length,
      localEquationHolds: localUnique === intersection + localOnly,
    },
    providerOnlyFacts,
    matchedFacts,
  };
}

/** Decide the verdict from the sets. Truncation and incoherence outrank every result. */
export function verdictFor(sets: SetReconciliation, truncated: boolean): ReconcileVerdict {
  if (truncated) return 'INCONCLUSIVE_PROVIDER_TRUNCATED';
  if (!sets.providerEquationHolds || !sets.localEquationHolds) return 'DIAGNOSTIC_DEFECT';
  const smaller = Math.min(sets.providerUnique, sets.localUnique);
  if (smaller > 0 && sets.intersection < smaller * IDENTITY_COHERENCE_FLOOR) {
    return 'INCONCLUSIVE_IDENTITY_INCOHERENT';
  }
  if (sets.providerOnly === 0 && sets.localOnly === 0) return 'RECONCILED_COMPLETE';
  if (sets.providerOnly > 0 && sets.localOnly > 0) return 'BOTH_DIRECTIONS';
  if (sets.providerOnly > 0) return 'PROVIDER_ONLY_POPULATION';
  return 'LOCAL_ONLY_POPULATION';
}

// --- CLI ----------------------------------------------------------------------

export function parseArgs(argv: readonly string[]): {
  organization: string;
  date: string;
  idHashes: number;
} {
  let organization = '';
  let date = '';
  let idHashes = 0;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1] ?? '';
    if (flag === '--organization' || flag === '--org') {
      organization = value.trim();
      i += 1;
    } else if (flag === '--date') {
      date = value.trim();
      i += 1;
    } else if (flag === '--id-hashes') {
      const n = Number(value.trim());
      idHashes = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 25) : 0;
      i += 1;
    }
  }
  return { organization, date, idHashes };
}

export interface RequiredEnvironment {
  databaseUrl: string;
  apiKey: string;
}

/** Resolve credentials, or name the missing ones. Values are never returned in logs. */
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

/** Organization statuses this tool refuses to read against, matching the certifier. */
export const REFUSED_ORGANIZATION_STATUSES = ['SUSPENDED', 'CANCELED'] as const;

function line(fields: Record<string, string | number | boolean | null>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${k}=${v === null ? '' : String(v)}`)
    .join(' ');
}

function emptyResult(organizationSlug: string): ReconcileResult {
  return {
    verdict: 'FAILED_PRECONDITION',
    organizationSlug,
    window: null,
    providerRead: null,
    sets: null,
    providerOnlyCohort: null,
    matchedCohort: null,
    boundary: null,
    deliveryPath: null,
    localStatuses: null,
    idHashes: [],
    error: null,
  };
}

// --- The run ------------------------------------------------------------------

/**
 * Reconcile ONE day. Sequential, bounded, and read-only from end to end.
 */
export async function runReconciliation(
  request: ReconcileRequest,
  deps: ReconcileDeps,
): Promise<ReconcileResult> {
  const result = emptyResult(request.organizationSlug);

  if (!isBusinessDate(request.businessDate)) {
    result.error = `Not a business date: ${String(request.businessDate)} (expected YYYY-MM-DD)`;
    deps.log(line({ event: 'PRECONDITION_FAILED', reason: result.error }));
    return result;
  }

  const organization = await deps.organizations.findBySlug(request.organizationSlug);
  if (!organization) {
    result.error = `No organization with slug "${request.organizationSlug}".`;
    deps.log(line({ event: 'PRECONDITION_FAILED', reason: result.error }));
    return result;
  }
  if ((REFUSED_ORGANIZATION_STATUSES as readonly string[]).includes(organization.status)) {
    result.error = `Organization "${organization.slug}" is ${organization.status}.`;
    deps.log(line({ event: 'PRECONDITION_FAILED', reason: result.error }));
    return result;
  }

  // The window comes from business-time.ts, the same helper certification uses.
  // Deriving it here would put the diagnostic and the ledger on different
  // boundaries twice a year, and the whole point is to compare like with like.
  const interval = easternBusinessDayWindow(request.businessDate);
  const window: DayWindow = {
    businessDate: request.businessDate,
    timezone: BUSINESS_TIME_ZONE,
    start: interval.start,
    end: interval.end,
  };
  result.window = window;
  const pageCap = request.pageCap && request.pageCap > 0 ? request.pageCap : RECONCILIATION_PAGE_CAP;

  deps.log(
    line({
      event: 'RECONCILE_START',
      organization: organization.slug,
      provider: request.providerName,
      stream: 'calls',
      date: window.businessDate,
      timezone: window.timezone,
      windowStart: window.start.toISOString(),
      windowEnd: window.end.toISOString(),
      pageCap,
      writes: 'none',
    }),
  );

  const read = await deps.provider.enumerate({
    organizationId: organization.id,
    apiKey: request.apiKey,
    window,
    pageCap,
  });
  result.providerRead = {
    pagesFetched: read.pagesFetched,
    pageCap: read.pageCap,
    truncated: read.truncated,
  };
  deps.log(
    line({
      event: 'PROVIDER_READ',
      records: read.recordsFetched,
      mapped: read.facts.length,
      pages: read.pagesFetched,
      pageCap: read.pageCap,
      truncated: read.truncated,
    }),
  );

  if (read.truncated) {
    // A lower bound cannot support a set difference. Stop before computing one:
    // every unread record would be reported as absent, which is a false alarm
    // dressed as a finding.
    result.verdict = 'INCONCLUSIVE_PROVIDER_TRUNCATED';
    result.error =
      `Provider read stopped at the ${read.pageCap}-page budget while CallGrid still had pages. ` +
      'What was read is a lower bound, so no reconciliation verdict is issued.';
    deps.log(line({ event: 'INCONCLUSIVE', reason: 'provider read truncated' }));
    return result;
  }

  const localFacts = await deps.local.read({
    organizationId: organization.id,
    provider: request.providerName,
    since: new Date(window.start.getTime() - LOCAL_SCAN_MARGIN_MS),
    until: new Date(window.end.getTime() + LOCAL_SCAN_MARGIN_MS),
  });

  const { sets, providerOnlyFacts, matchedFacts } = reconcileSets(read.facts, localFacts, window);
  result.sets = sets;
  result.verdict = verdictFor(sets, read.truncated);

  deps.log(
    line({
      event: 'SET_RECONCILIATION',
      providerRecords: sets.providerRecords,
      providerUnique: sets.providerUnique,
      providerDuplicateIds: sets.providerDuplicateIds,
      localRowsScanned: sets.localRows,
      localInWindow: sets.localInWindow,
      localUnique: sets.localUnique,
      localDuplicateIds: sets.localDuplicateIds,
      localUnresolvedOccurrence: sets.localUnresolvedOccurrence,
      localMissingIdentity: sets.localMissingIdentity,
      intersection: sets.intersection,
      providerOnly: sets.providerOnly,
      localOnly: sets.localOnly,
      providerEquation: sets.providerEquationHolds ? 'HOLDS' : 'VIOLATED',
      localEquation: sets.localEquationHolds ? 'HOLDS' : 'VIOLATED',
    }),
  );

  if (result.verdict === 'DIAGNOSTIC_DEFECT') {
    result.error = 'A set equation failed. The comparison is wrong; no conclusion may be drawn from it.';
    deps.log(line({ event: 'DIAGNOSTIC_DEFECT', reason: result.error }));
    return result;
  }
  if (result.verdict === 'INCONCLUSIVE_IDENTITY_INCOHERENT') {
    result.error =
      `Intersection ${sets.intersection} is below ${IDENTITY_COHERENCE_FLOOR * 100}% of the smaller set. ` +
      'The two sides are probably not naming the same identifier; treat this as a mapping defect, not a data gap.';
    deps.log(line({ event: 'INCONCLUSIVE', reason: 'identity mapping incoherent' }));
    return result;
  }

  // Comparative characterisation. Both cohorts, always — a distribution over the
  // provider-only set alone cannot distinguish an outcome class from ordinary
  // provider-wide prevalence.
  result.providerOnlyCohort = cohortOf('provider-only', providerOnlyFacts);
  result.matchedCohort = cohortOf('matched', matchedFacts);
  result.boundary = boundaryAnalysisOf(window, providerOnlyFacts.map((f) => f.occurredAt));

  const inWindowLocal = localFacts.filter(
    (f) => f.occurredAt !== null && f.occurredAt >= window.start && f.occurredAt < window.end,
  );
  result.localStatuses = distribution(inWindowLocal.map((f) => f.status));
  const markerCounts: Record<string, number> = {};
  for (const key of DELIVERY_PATH_MARKERS) {
    markerCounts[key] = inWindowLocal.filter((f) => f.markers[key] === true).length;
  }
  result.deliveryPath = markerCounts;

  if (request.idHashes > 0) {
    result.idHashes = providerOnlyFacts
      .slice(0, request.idHashes)
      .map((f) => hashIdentity(f.identity));
  }

  renderReport(result, deps.log);
  return result;
}

/** Print the aggregate evidence. Counts and labels only; never an identity. */
export function renderReport(result: ReconcileResult, log: (l: string) => void): void {
  const { sets, providerOnlyCohort, matchedCohort, boundary } = result;
  if (!sets) return;

  log(line({ event: 'VERDICT', verdict: result.verdict }));

  if (result.localStatuses) {
    for (const [status, n] of Object.entries(result.localStatuses)) {
      log(line({ event: 'LOCAL_STATUS', status, events: n }));
    }
  }
  if (result.deliveryPath) {
    for (const [marker, n] of Object.entries(result.deliveryPath)) {
      log(line({ event: 'DELIVERY_MARKER', key: marker, present: n, of: sets.localUnique }));
    }
  }

  if (providerOnlyCohort && matchedCohort) {
    for (const key of Object.keys(providerOnlyCohort.fields)) {
      const only = providerOnlyCohort.fields[key] ?? {};
      const matched = matchedCohort.fields[key] ?? {};
      const labels = new Set([...Object.keys(only), ...Object.keys(matched)]);
      for (const label of labels) {
        log(
          line({
            event: 'FIELD',
            field: key,
            value: label,
            providerOnly: only[label] ?? 0,
            providerOnlyOf: providerOnlyCohort.count,
            matched: matched[label] ?? 0,
            matchedOf: matchedCohort.count,
          }),
        );
      }
    }
    const buckets = new Set([
      ...Object.keys(providerOnlyCohort.durationBuckets),
      ...Object.keys(matchedCohort.durationBuckets),
    ]);
    for (const bucket of buckets) {
      log(
        line({
          event: 'DURATION',
          bucket,
          providerOnly: providerOnlyCohort.durationBuckets[bucket] ?? 0,
          matched: matchedCohort.durationBuckets[bucket] ?? 0,
        }),
      );
    }
  }

  if (boundary) {
    log(
      line({
        event: 'BOUNDARY',
        earliest: boundary.earliest,
        latest: boundary.latest,
        first15m: boundary.firstFifteenMinutes,
        last15m: boundary.lastFifteenMinutes,
        first1h: boundary.firstHour,
        last1h: boundary.lastHour,
      }),
    );
    boundary.hourly.forEach((n, hour) => {
      log(line({ event: 'BOUNDARY_HOUR', hourFromWindowStart: hour, providerOnly: n }));
    });
  }

  for (const hash of result.idHashes) {
    log(line({ event: 'PROVIDER_ONLY_ID_HASH', sha256Prefix: hash }));
  }

  log(
    line({
      event: 'SUMMARY',
      DATE: result.window?.businessDate ?? '',
      PROVIDER_UNIQUE: sets.providerUnique,
      LOCAL_UNIQUE: sets.localUnique,
      INTERSECTION: sets.intersection,
      PROVIDER_ONLY: sets.providerOnly,
      LOCAL_ONLY: sets.localOnly,
      OVERALL_RESULT: result.verdict,
    }),
  );
}

// --- Wiring -------------------------------------------------------------------
//
// Everything above is pure orchestration over three injected seams, which is what
// the tests drive. Below is the only place real dependencies are constructed, and
// it does nothing but construct them. Every call it makes is a read.

async function main(): Promise<number> {
  const log = (l: string) => process.stdout.write(l + '\n');

  const args = parseArgs(process.argv.slice(2));
  if (!args.organization) {
    log(line({ event: 'PRECONDITION_FAILED', reason: '--organization <slug> is required' }));
    return 2;
  }
  if (!isBusinessDate(args.date)) {
    log(line({ event: 'PRECONDITION_FAILED', reason: '--date YYYY-MM-DD is required' }));
    return 2;
  }

  const env = readEnvironment(process.env);
  if (!env.ok) {
    log(line({ event: 'PRECONDITION_FAILED', reason: 'missing environment', missing: env.missing.join(',') }));
    return 2;
  }

  // Imported here rather than at module scope so the pure orchestration above can
  // be tested without a database client or a provider adapter being constructed.
  const { prisma, repositories } = await import('@emgloop/database');
  const providers = await import('@emgloop/providers');
  const callgrid = providers.getCallGridProvider();
  const resolveOccurrence = providers.resolveCallOccurrence;

  const enumerator: ProviderEnumerator = {
    async enumerate(input) {
      // The SAME poll() certification calls, with the same window and the same
      // kind of budget. Not a second opinion about what a provider day is.
      const page = await callgrid.poll(
        { organizationId: input.organizationId, credentials: { apiKey: input.apiKey }, config: {} },
        { since: input.window.start, until: input.window.end, maxPages: input.pageCap },
      );
      const facts: ProviderFact[] = [];
      for (const event of page.events) {
        const identity = normaliseIdentity(event.externalId);
        if (identity === null) continue;
        facts.push({
          identity,
          occurredAt: event.occurredAt,
          // The raw payload is read here and never leaves this expression.
          fields: safeFieldsFrom(event.payload as Record<string, unknown>),
        });
      }
      return {
        facts,
        recordsFetched: page.recordsFetched ?? page.events.length,
        pagesFetched: page.pagesFetched ?? 0,
        pageCap: page.pageCap ?? input.pageCap,
        truncated: page.truncated === true,
      };
    },
  };

  const reader: LocalIdentityReader = {
    async read(input) {
      const facts: LocalFact[] = [];
      let afterId: string | undefined;
      for (;;) {
        const batch = await repositories.integrations.listEventsReceivedBetween(input.organizationId, {
          provider: input.provider,
          since: input.since,
          until: input.until,
          batchSize: LOCAL_SCAN_BATCH_SIZE,
          ...(afterId ? { afterId } : {}),
        });
        if (batch.length === 0) break;
        for (const row of batch) {
          const payload =
            row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
              ? (row.payload as Record<string, unknown>)
              : {};
          // The CANONICAL resolver, not a hand-written JSON expression. Local and
          // provider occurrence semantics are then identical by construction.
          const occurrence = resolveOccurrence(payload);
          facts.push({
            identity: normaliseIdentity(row.externalId),
            occurredAt: occurrence.at,
            status: row.status,
            markers: markersFrom(payload),
          });
        }
        const last = batch[batch.length - 1];
        if (!last) break;
        afterId = last.id;
        if (batch.length < LOCAL_SCAN_BATCH_SIZE) break;
      }
      return facts;
    },
  };

  try {
    const result = await runReconciliation(
      {
        organizationSlug: args.organization,
        businessDate: args.date,
        apiKey: env.value.apiKey,
        providerName: 'callgrid',
        idHashes: args.idHashes,
      },
      { provider: enumerator, local: reader, organizations: repositories.organizations, log, now: () => new Date() },
    );
    // Only an inconclusive or defective run is a red run. A real provider-only
    // population is a FINDING, and a finding is a successful diagnostic.
    return result.verdict === 'FAILED_PRECONDITION' ||
      result.verdict === 'DIAGNOSTIC_DEFECT' ||
      result.verdict === 'INCONCLUSIVE_PROVIDER_TRUNCATED' ||
      result.verdict === 'INCONCLUSIVE_IDENTITY_INCOHERENT'
      ? 1
      : 0;
  } finally {
    await prisma.$disconnect();
  }
}

// Executed only when run directly, so importing this file starts nothing. The
// match is ANCHORED to the exact filename — a substring check lets the test file,
// whose name contains this one, run main() as an import side effect.
const ENTRY_POINT = /[\\/]reconcile-provider-day\.ts$/;
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
