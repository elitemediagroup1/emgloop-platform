// Re-offer FAILED integration events through the canonical pipeline. BOUNDED,
// HUMAN-DISPATCHED, ONE ATTEMPT PER ROW PER RUN.
//
// WHAT WAS ACTUALLY WRONG
//
// The CallGrid settings panel has rendered a "Retry Queue" since Sprint 17 —
// every FAILED, RECEIVED and PROCESSING event, counted and listed. Nothing has
// ever drained it. There is no retry action, no endpoint and no operation behind
// that panel: it is a queue in name, and a list in fact.
//
// The pipeline itself was always ready. `ingestOne` short-circuits only on
// PROCESSED; a FAILED row is reused and re-run from PROCESSING, and PR #181 added
// a test saying so. What was missing was something to hand it the row again.
//
// WHAT THIS IS NOT
//
// It is not a second ingestion engine — every row goes back through
// `IngestionService.ingest`, the same call the webhook and the poller make. It is
// not an automatic retry loop: nothing schedules it, it attempts each row exactly
// once per run, and a row that fails again stays FAILED and is named in the
// report rather than being tried harder. A retry loop that hides a permanent
// failure behind repetition is how a broken row becomes invisible.
//
// It also cannot fix a call that was CAPTURED and never PROJECTED. That row is
// PROCESSED, so re-offering it short-circuits as a duplicate by design. The read
// model has its own repair path (`projectWindow`) and conflating the two would
// give the platform two answers to "how do I fix this row".
//
// PROVENANCE: LOCAL_REPROCESS, AND THAT NAME IS THE POINT. No provider request
// happens here. Labelling a reprocess WEBHOOK or API_POLL would say CallGrid was
// asked when it was not; labelling it API_RECOVERY would say somebody went and
// got it when the evidence never left. So the vocabulary gained a fourth member
// rather than this operation borrowing the nearest available lie.
//
// THE TIME CONTRACT IS UNTOUCHED. `receivedAt` is not rewritten — Loop received
// this delivery when it received it, and re-running the pipeline does not change
// that. `occurredAt` comes from the stored column, or from the canonical resolver
// over the stored payload for a legacy row, and a row whose occurrence cannot be
// established at all is REFUSED rather than stamped with now().
//
// USAGE
//
//   npm run drain:failed-events -- --organization <slug> [--provider callgrid] [--limit 50]
//
// That is a DRY RUN. Writing requires --apply.
//
// Credentials come from the environment and are never printed:
//   DATABASE_URL   the DIRECT (non-pooled) production endpoint

import { isObservationSource } from '@emgloop/shared';
import type { IngestInput, IngestResult } from '@emgloop/database';

// --- The seams this file is tested through -----------------------------------

/** One stored FAILED delivery, exactly as the repository returns it. */
export interface FailedEventRow {
  id: string;
  externalId: string | null;
  /** The row's OWN provider, so a mixed drain re-offers each row as what it is. */
  provider: string | null;
  eventType: string;
  receivedAt: Date;
  occurredAt: Date | null;
  error: string | null;
  payload: unknown;
}

export interface FailedEventReader {
  listFailedEvents(
    organizationId: string,
    options: { provider?: string; limit: number },
  ): Promise<FailedEventRow[]>;
}

/** The one write path. This runner never touches a row any other way. */
export interface Ingestor {
  ingest(input: IngestInput): Promise<IngestResult[]>;
}

/** The canonical occurrence resolver, injected so this file holds no copy of it. */
export type OccurrenceResolver = (payload: Record<string, unknown>) => { at: Date | null };

/** Read-only organization lookup. This runner may never provision one. */
export interface OrganizationLookup {
  findBySlug(slug: string): Promise<{ id: string; slug: string; name: string; status: string } | null>;
}

export interface DrainDeps {
  events: FailedEventReader;
  ingestor: Ingestor;
  resolveOccurrence: OccurrenceResolver;
  organizations: OrganizationLookup;
  log: (line: string) => void;
  now: () => Date;
}

export interface DrainRequest {
  organizationSlug: string;
  /** Optional. Absent means every provider's failures for this organization. */
  provider?: string | undefined;
  limit: number;
  dryRun: boolean;
}

/** The observation this operation records. A constant, never an input. */
export const REPROCESS_OBSERVATION_SOURCE = 'LOCAL_REPROCESS' as const;

/** How many rows one run will attempt unless told otherwise. */
export const DEFAULT_DRAIN_LIMIT = 50;
/** The most any one run will attempt, whatever is asked for. */
export const MAX_DRAIN_LIMIT = 500;

export const DRAIN_RESULTS = [
  /** Read and classified. Nothing was written. */
  'DRY_RUN_READY',
  /** Every attempted row processed. */
  'DRAINED',
  /** Some rows processed and some did not. Both counts are reported. */
  'PARTIALLY_DRAINED',
  /** Rows were attempted and none processed. */
  'NOT_DRAINED',
  /** There was nothing to drain. */
  'NOTHING_TO_DRAIN',
  /** Refused before reading anything. */
  'REFUSED',
] as const;

export type DrainResult = (typeof DRAIN_RESULTS)[number];

/** Why a stored row could not even be offered back to the pipeline. */
export const REFUSAL_REASONS = ['NO_IDENTITY', 'NO_OCCURRENCE', 'NO_PAYLOAD', 'NO_PROVIDER'] as const;
export type RefusalReason = (typeof REFUSAL_REASONS)[number];

export interface RowOutcome {
  /** The stored row id. Loop's own id, not a provider identity. */
  eventId: string;
  status: 'processed' | 'duplicate' | 'failed' | 'refused' | 'planned';
  refusalReason: RefusalReason | null;
  /** The failure this row carried BEFORE the attempt. Evidence, not a new error. */
  priorError: string | null;
  /** The failure the re-offer produced, when it produced one. */
  error: string | null;
}

export interface DrainRunResult {
  overall: DrainResult;
  organizationSlug: string;
  provider: string | null;
  dryRun: boolean;
  limit: number;
  /** Rows the reader returned. */
  found: number;
  /** Rows that could be reconstructed and were offered to the pipeline. */
  attempted: number;
  processed: number;
  duplicates: number;
  failedAgain: number;
  refused: number;
  rows: RowOutcome[];
  reason: string | null;
  elapsedMs: number;
}

// --- Input validation ---------------------------------------------------------

export const REFUSED_ORGANIZATION_STATUSES = ['SUSPENDED', 'CANCELED'] as const;

export interface RequiredEnvironment {
  databaseUrl: string;
}

export function readEnvironment(
  env: NodeJS.ProcessEnv,
): { ok: true; value: RequiredEnvironment } | { ok: false; missing: string[] } {
  const databaseUrl = env.DATABASE_URL?.trim() || '';
  if (!databaseUrl) return { ok: false, missing: ['DATABASE_URL'] };
  return { ok: true, value: { databaseUrl } };
}

export interface ParsedArgs {
  organization: string;
  provider: string;
  limit: number;
  dryRun: boolean;
  contradiction: boolean;
}

/**
 * Minimal flag parsing. Deliberately not a CLI framework.
 *
 * DRY RUN IS THE DEFAULT and writing is spelled `--apply`, matching every other
 * write-capable operation in this directory.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  let organization = '';
  let provider = '';
  let limit = DEFAULT_DRAIN_LIMIT;
  let apply = false;
  let dryRunFlag = false;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1] ?? '';
    if (flag === '--organization' || flag === '--org') {
      organization = value.trim();
      i += 1;
    } else if (flag === '--provider') {
      provider = value.trim();
      i += 1;
    } else if (flag === '--limit') {
      const parsed = Number(value.trim());
      // An unparseable limit keeps the default rather than becoming NaN and
      // silently meaning "no bound at all".
      if (Number.isFinite(parsed) && parsed > 0) limit = Math.min(Math.floor(parsed), MAX_DRAIN_LIMIT);
      i += 1;
    } else if (flag === '--apply') {
      apply = true;
    } else if (flag === '--dry-run') {
      dryRunFlag = true;
    }
  }
  return { organization, provider, limit, dryRun: !apply, contradiction: apply && dryRunFlag };
}

// --- Reconstruction -------------------------------------------------------------

/**
 * The contact keys BOTH CallGrid adapters write into the payload they store.
 *
 * WHY THIS LIST EXISTS AT ALL. A stored row keeps the adapter's normalized
 * payload, not the original InboundEvent, so `customerPhone` has to be recovered
 * from it. Re-running an adapter would mean choosing which adapter — the webhook
 * body and the REST record are different shapes — and getting that choice wrong
 * silently degrades the reprocess rather than failing it.
 *
 * These are the keys the adapters themselves write beside every call
 * (`caller`, `fromNumber`), and a test proves that by mapping a real provider
 * record through the shipped mapper and asserting this function recovers the same
 * phone. That is a behavioural guard rather than a promise.
 */
export const STORED_PHONE_KEYS = ['caller', 'fromNumber', 'callerId'] as const;
export const STORED_EMAIL_KEYS = ['email', 'customerEmail'] as const;

function firstString(payload: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

export interface Reconstructed {
  ok: true;
  externalId: string;
  provider: string;
  rawEventType: string;
  occurredAt: Date;
  payload: Record<string, unknown>;
  customerPhone?: string;
  customerEmail?: string;
}

/**
 * Rebuild the InboundEvent a stored FAILED row was created from.
 *
 * REFUSES RATHER THAN GUESSES, three times over. A row with no provider identity
 * cannot be re-offered without inventing one, which PR #178 deleted the ability
 * to do. A row whose occurrence cannot be established cannot be stamped with
 * now() without turning a historical call into a call that happened during the
 * drain. A row with no usable payload has nothing to reprocess. Each refusal is
 * named and reported; none of them is silently skipped.
 */
export function reconstruct(
  row: FailedEventRow,
  resolveOccurrence: OccurrenceResolver,
): Reconstructed | { ok: false; reason: RefusalReason } {
  const payload =
    row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
      ? (row.payload as Record<string, unknown>)
      : null;
  if (!payload || Object.keys(payload).length === 0) return { ok: false, reason: 'NO_PAYLOAD' };
  if (!row.externalId || row.externalId.trim() === '') return { ok: false, reason: 'NO_IDENTITY' };
  // Idempotency is keyed on (provider, externalId). A row that cannot say which
  // provider it came from cannot be re-offered without guessing at half of its
  // own identity, and an empty string would collide with every other such row.
  if (!row.provider || row.provider.trim() === '') return { ok: false, reason: 'NO_PROVIDER' };

  // The column where it exists; the canonical resolver over the stored payload
  // only for a row written before occurrence was a column. Never the clock.
  const occurredAt = row.occurredAt ?? resolveOccurrence(payload).at;
  if (!occurredAt || !Number.isFinite(occurredAt.getTime())) {
    return { ok: false, reason: 'NO_OCCURRENCE' };
  }

  const phone = firstString(payload, STORED_PHONE_KEYS);
  const email = firstString(payload, STORED_EMAIL_KEYS);
  return {
    ok: true,
    externalId: row.externalId,
    provider: row.provider,
    // The stored eventType is ALREADY CANONICAL — it was mapped on the way in.
    // The drain passes it through unchanged rather than re-mapping, because a
    // second mapping of an already-mapped value is where a `call.completed`
    // quietly becomes a `call.inbound`.
    rawEventType: row.eventType,
    occurredAt,
    payload,
    ...(phone ? { customerPhone: phone } : {}),
    ...(email ? { customerEmail: email } : {}),
  };
}

// --- Reporting -----------------------------------------------------------------

function line(fields: Record<string, string | number | boolean | null>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${k}=${v === null ? '' : String(v)}`)
    .join(' ');
}

// --- The drain ------------------------------------------------------------------

/**
 * Offer each FAILED row back to the pipeline once, in order, and report each one.
 *
 * IT DOES NOT STOP AT THE FIRST FAILURE, unlike the bounded poll — and for a
 * reason that is the opposite of that one's. A poll's records are an interval that
 * is only meaningful whole. These rows are independent deliveries that already
 * failed once; stopping at the first would mean one permanently broken row blocks
 * every other row behind it forever, which is what a queue with no drain already
 * did to this platform.
 */
export async function runDrain(request: DrainRequest, deps: DrainDeps): Promise<DrainRunResult> {
  const startedAt = deps.now().getTime();
  const result: DrainRunResult = {
    overall: 'REFUSED',
    organizationSlug: request.organizationSlug,
    provider: request.provider ?? null,
    dryRun: request.dryRun,
    limit: request.limit,
    found: 0,
    attempted: 0,
    processed: 0,
    duplicates: 0,
    failedAgain: 0,
    refused: 0,
    rows: [],
    reason: null,
    elapsedMs: 0,
  };
  const finish = (): DrainRunResult => {
    result.elapsedMs = deps.now().getTime() - startedAt;
    deps.log(
      line({
        event: 'SUMMARY',
        ORGANIZATION: result.organizationSlug,
        PROVIDER: result.provider ?? '(all)',
        DRY_RUN: result.dryRun,
        OBSERVATION_SOURCE: REPROCESS_OBSERVATION_SOURCE,
        LIMIT: result.limit,
        FOUND: result.found,
        ATTEMPTED: result.attempted,
        PROCESSED: result.processed,
        DUPLICATES: result.duplicates,
        FAILED_AGAIN: result.failedAgain,
        REFUSED_ROWS: result.refused,
        ELAPSED_MS: result.elapsedMs,
        OVERALL_RESULT: result.overall,
      }),
    );
    return result;
  };
  const refuse = (reason: string): DrainRunResult => {
    result.overall = 'REFUSED';
    result.reason = reason;
    deps.log(line({ event: 'PRECONDITION_FAILED', reason }));
    return finish();
  };

  if (!request.organizationSlug) return refuse('--organization <slug> is required.');
  if (request.limit <= 0) return refuse('--limit must be a positive number of rows.');

  const organization = await deps.organizations.findBySlug(request.organizationSlug);
  if (!organization) return refuse(`No organization with slug "${request.organizationSlug}".`);
  if ((REFUSED_ORGANIZATION_STATUSES as readonly string[]).includes(organization.status)) {
    return refuse(`Organization "${organization.slug}" is ${organization.status}.`);
  }

  const rows = await deps.events.listFailedEvents(organization.id, {
    ...(request.provider ? { provider: request.provider } : {}),
    limit: Math.min(request.limit, MAX_DRAIN_LIMIT),
  });
  result.found = rows.length;

  deps.log(
    line({
      event: 'DRAIN_START',
      organization: organization.slug,
      provider: result.provider ?? '(all)',
      limit: result.limit,
      found: result.found,
      observationSource: REPROCESS_OBSERVATION_SOURCE,
      dryRun: request.dryRun,
      note: 'Each row is offered ONCE. Nothing here retries a row that fails again.',
    }),
  );

  if (rows.length === 0) {
    result.overall = 'NOTHING_TO_DRAIN';
    result.reason = 'No FAILED events matched.';
    return finish();
  }

  for (const row of rows) {
    const rebuilt = reconstruct(row, deps.resolveOccurrence);
    if (!rebuilt.ok) {
      result.refused += 1;
      result.rows.push({
        eventId: row.id,
        status: 'refused',
        refusalReason: rebuilt.reason,
        priorError: row.error,
        error: null,
      });
      deps.log(
        line({
          event: 'ROW_REFUSED',
          eventId: row.id,
          reason: rebuilt.reason,
          priorError: row.error ?? '',
          note: 'Not re-offered. Nothing was invented to make it offerable.',
        }),
      );
      continue;
    }

    if (request.dryRun) {
      result.rows.push({
        eventId: row.id,
        status: 'planned',
        refusalReason: null,
        priorError: row.error,
        error: null,
      });
      deps.log(
        line({
          event: 'ROW_PLANNED',
          eventId: row.id,
          eventType: rebuilt.rawEventType,
          occurredAt: rebuilt.occurredAt.toISOString(),
          priorError: row.error ?? '',
        }),
      );
      continue;
    }

    result.attempted += 1;
    let outcome: IngestResult | undefined;
    let thrown: string | null = null;
    try {
      const results = await deps.ingestor.ingest({
        organizationId: organization.id,
        // The ROW'S OWN provider, so a drain with no filter re-offers each row as
        // what it is rather than as whatever the operator happened to type.
        provider: rebuilt.provider,
        // ALREADY CANONICAL. Pass-through, never a second mapping.
        mapEventType: (raw: string) => raw,
        events: [
          {
            externalId: rebuilt.externalId,
            rawEventType: rebuilt.rawEventType,
            occurredAt: rebuilt.occurredAt,
            payload: rebuilt.payload,
            ...(rebuilt.customerPhone ? { customerPhone: rebuilt.customerPhone } : {}),
            ...(rebuilt.customerEmail ? { customerEmail: rebuilt.customerEmail } : {}),
          },
        ],
        observationSource: REPROCESS_OBSERVATION_SOURCE,
      });
      outcome = results[0];
    } catch (error) {
      thrown = error instanceof Error ? error.message : 'unknown error';
    }

    const status = outcome?.status ?? 'failed';
    const error = outcome?.error ?? thrown ?? (outcome ? null : 'Ingestion reported no result.');
    if (status === 'processed') result.processed += 1;
    else if (status === 'duplicate') result.duplicates += 1;
    else result.failedAgain += 1;

    result.rows.push({
      eventId: row.id,
      status,
      refusalReason: null,
      priorError: row.error,
      error: status === 'failed' ? error : null,
    });
    deps.log(
      line({
        event: 'ROW_RESULT',
        eventId: row.id,
        status,
        priorError: row.error ?? '',
        // THE ROW STAYS FAILED and is named. A drain that quietly tried again
        // would turn a permanent failure into an invisible one.
        detail: status === 'failed' ? (error ?? '') : '',
      }),
    );
  }

  if (request.dryRun) {
    result.overall = 'DRY_RUN_READY';
    result.reason = 'Nothing was written. Re-run with --apply to re-offer these rows.';
  } else if (result.attempted === 0) {
    result.overall = result.refused > 0 ? 'NOT_DRAINED' : 'NOTHING_TO_DRAIN';
    result.reason = 'No stored row could be reconstructed well enough to re-offer.';
  } else if (result.failedAgain === 0 && result.refused === 0) {
    result.overall = 'DRAINED';
  } else if (result.processed + result.duplicates > 0) {
    result.overall = 'PARTIALLY_DRAINED';
    result.reason = `${result.failedAgain} row(s) failed again and ${result.refused} could not be re-offered.`;
  } else {
    result.overall = 'NOT_DRAINED';
    result.reason = `Every attempted row failed again (${result.failedAgain}).`;
  }
  return finish();
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
  if (args.provider && !/^[a-z0-9-]{1,40}$/.test(args.provider)) {
    log(line({ event: 'PRECONDITION_FAILED', reason: 'invalid --provider', provider: args.provider }));
    return 2;
  }

  const env = readEnvironment(process.env);
  if (!env.ok) {
    log(line({ event: 'PRECONDITION_FAILED', reason: 'missing environment', missing: env.missing.join(',') }));
    return 2;
  }

  const providers = await import('@emgloop/providers');
  const { prisma, repositories, IngestionService } = await import('@emgloop/database');

  try {
    const result = await runDrain(
      {
        organizationSlug: args.organization,
        ...(args.provider ? { provider: args.provider } : {}),
        limit: args.limit,
        dryRun: args.dryRun,
      },
      {
        events: repositories.integrations,
        // THE SAME SERVICE THE WEBHOOK AND THE POLLER CALL. Not a variant.
        ingestor: new IngestionService(prisma),
        resolveOccurrence: providers.resolveCallOccurrence,
        organizations: repositories.organizations,
        log,
        now: () => new Date(),
      },
    );
    return result.overall === 'DRY_RUN_READY' ||
      result.overall === 'DRAINED' ||
      result.overall === 'NOTHING_TO_DRAIN'
      ? 0
      : 1;
  } finally {
    await prisma.$disconnect();
  }
}

// Executed only when run directly. The match is ANCHORED to the exact filename.
const ENTRY_POINT = /[\\/]drain-failed-events\.ts$/;
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

/** Exported so a test can assert the label this operation records is a real one. */
export const REPROCESS_SOURCE_IS_KNOWN = isObservationSource(REPROCESS_OBSERVATION_SOURCE);
