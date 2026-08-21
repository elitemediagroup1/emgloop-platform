// CallGridPollService — the ONE way a CallGrid REST record changes Loop's data.
//
// Given an organization, a credential and an explicit half-open interval, this
// reads that interval from CallGrid completely and — only if the read completed
// — hands every record to IngestionService. Two callers use it and there must
// never be a third kind: the manual operations runner, and the admin sync route.
//
// WHAT IT OWNS
//
//   the completeness gate       incomplete read  -> zero writes
//   the refusal policy          unmappable record -> zero writes, whole interval
//   the apply loop              one record at a time, stop on the first failure
//   the outcome vocabulary      seven ways to end, four of which wrote nothing
//
// WHAT IT DOES NOT OWN, AND MUST NEVER BEGIN TO
//
//   retrieval + pagination + 429   readCallGridInterval (PR #183/#184)
//   identity                       resolveCallGridIdentity (PR #178)
//   occurrence                     resolveCallOccurrence (PR #180)
//   provenance / re-observation    IngestionService (PR #181)
//   provider fact convergence      convergeFact (PR #182)
//   the projection                 IngestionService
//
// WHY IT EXISTS AT ALL
//
// It replaces `CallGridReconciliationService.reconcile`, which was a second
// write-capable REST path and an unsafe one. That method ingested every record it
// had fetched and only afterwards appended a sentence to `errors[]` saying the
// read had truncated — so a 6,918-call day that returned 2,500 records left 2,500
// correct rows behind describing an interval that was not correct. Worse, it
// short-circuited PROCESSED rows into its own `enrichExisting`, a direct
// Interaction.metadata merge that never reached IngestionService: no observation
// was recorded, no provenance was written, and no provider fact converged. A
// re-observation through the admin sync was therefore invisible to PR #181 and
// unreachable by PR #182 — the two mechanisms built precisely to make repeated
// provider answers meaningful.
//
// THERE IS NO CLOCK IN THIS FILE. Both bounds are supplied. A convenience range
// like `today` or `7d` is resolved to instants by the CALLER, before it gets
// here, because a primitive that can invent its own upper bound can be asked for
// "the last seven days" by a scheduler that never states what it means.

import type { PrismaClient } from '@prisma/client';
// Unprefixed, matching every other package in this repository. The `node:`
// scheme is not resolved by the web build's webpack config, and this module is
// reachable from an API route -- `node:crypto` here fails the build of the one
// deployable with an UnhandledSchemeError.
import { createHash } from 'crypto';
import {
  intervalWasComplete,
  readCallGridInterval,
  validateInterval,
  type InboundEvent,
  type IntervalReadResult,
} from '@emgloop/providers';
import type { ObservationSource } from '@emgloop/shared';

import {
  IngestionService,
  isDuplicateObservation,
  type IngestInput,
  type IngestResult,
} from './ingestion.service';
import { IntegrationRepository } from '../repositories/integration.repository';

/**
 * How rows written by this service are labelled.
 *
 * A CONSTANT, NOT A PARAMETER. API_RECOVERY means a person went looking for a
 * known gap; letting a routine sync claim that label, or a recovery hide inside
 * routine traffic, would make `firstIngestionSource` answer a different question
 * than the one it was added to answer. Recovery will be its own operation with
 * its own decision behind it.
 */
export const POLL_OBSERVATION_SOURCE: ObservationSource = 'API_POLL';

export const CALLGRID_POLL_PROVIDER = 'callgrid';
export const CALLGRID_POLL_STREAM = 'calls';

/**
 * What a run did, in the only seven ways it can end.
 *
 * FOUR OF THESE MEAN NOTHING WAS WRITTEN, and they are separate names rather
 * than one failure because the caller's next move differs: REFUSED is something
 * to fix in the request, FETCH_INCOMPLETE is something to retry, PROCESSING_FAILED
 * is a bug, and DRY_RUN_READY is a success.
 */
export const CALLGRID_POLL_OUTCOMES = [
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

export type CallGridPollOutcome = (typeof CALLGRID_POLL_OUTCOMES)[number];

/** Outcomes a caller may report as a success. Everything else is not one. */
export function pollSucceeded(outcome: CallGridPollOutcome): boolean {
  return outcome === 'DRY_RUN_READY' || outcome === 'APPLIED' || outcome === 'APPLIED_WITH_CONFLICTS';
}

export interface CallGridPollInput {
  organizationId: string;
  apiKey: string;
  /** INCLUSIVE lower bound. Always explicit; this service never invents one. */
  since: Date;
  /** EXCLUSIVE upper bound. Always explicit; there is no "until now" here. */
  until: Date;
  apiBaseUrl?: string | undefined;
  providerConnectionId?: string | null;
  /** TRUE performs zero mutations. */
  dryRun?: boolean;
}

/** One provider record the mapper refused, as the reader reported it. */
export interface PollRefusal {
  page: number;
  reason: string;
  kind?: string;
}

export interface CallGridPollExecution {
  outcome: CallGridPollOutcome;
  since: string;
  until: string;
  dryRun: boolean;
  /** Set whenever the run did not simply apply. One sentence, never a credential. */
  reason: string | null;
  /** The retrieval outcome verbatim, when a read was attempted. */
  fetchOutcome: string | null;
  /** Raw provider records seen, including ones the mapper refused. */
  providerRecordsFetched: number;
  /** Records that mapped to a canonical event. */
  acceptedRecords: number;
  /** Records the provider returned and the mapper would not map. */
  refusedRecords: number;
  refusals: PollRefusal[];
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
}

/**
 * Optional running commentary, for a caller that has somewhere to put it.
 *
 * The operations runner prints these as log lines; the admin route passes
 * nothing, because an HTTP response is not a place to stream four thousand
 * progress notes. Neither callback may change what the run does.
 */
export interface CallGridPollObserver {
  onStrengthened?: (info: { index: number; identityDigest: string; facts: string[] }) => void;
  onConflict?: (info: { index: number; identityDigest: string; facts: string[] }) => void;
  onProgress?: (info: { done: number; of: number; created: number; reObserved: number }) => void;
  onFailure?: (info: { index: number; identityDigest: string; applied: number; notAttempted: number; detail: string }) => void;
}

/** How often a long apply reports progress. Not a batch size: writes are one at a time. */
export const POLL_PROGRESS_EVERY = 250;

/**
 * A stable, non-reversible handle for one provider record.
 *
 * The raw CallGrid identity is deliberately not surfaced to a log or an HTTP
 * response. A caller does not need it: re-running the same interval converges,
 * and the durable evidence for a conflict is a `provider_fact_revisions` row that
 * carries the real identity inside the database, already scoped to a tenant. What
 * a report needs is enough to correlate two mentions of the same record.
 */
export function identityDigest(externalId: string): string {
  return createHash('sha256').update(externalId).digest('hex').slice(0, 12);
}

/**
 * Map a CallGrid REST `callStatus` to a canonical Loop event type.
 *
 * PR #41: an unrecognized/empty status (`unknown` rather than a fabricated
 * `completed` — see mapCallGridApiRecord) falls through to the generic
 * `call.inbound` bucket. It is NEVER mapped to `call.completed`. Widened to also
 * recognize the real CallGrid callStatus enum values (BUSY, FAILED, CANCELED,
 * REJECTED, BLOCKED, IN_PROGRESS, CONNECTED) so fewer real calls fall into the
 * generic inbound bucket.
 *
 * Named `mapReconEventType` until PR 9, when the service it lived in was deleted.
 * Nothing about it was ever specific to reconciliation: it is the REST mapper.
 */
export function mapCallGridEventType(raw: string): string {
  const k = String(raw ?? '').toLowerCase().trim();
  if (!k || k === 'unknown') return 'call.inbound';
  if (k.includes('answer') || k === 'in_progress' || k === 'connected') return 'call.answered';
  if (
    k.includes('miss') ||
    k.includes('no_answer') ||
    k.includes('noanswer') ||
    k.includes('busy') ||
    k.includes('fail') ||
    k.includes('cancel') ||
    k.includes('reject') ||
    k.includes('block')
  ) {
    return 'call.missed';
  }
  if (k.includes('voicemail')) return 'call.voicemail';
  if (k.includes('transfer')) return 'call.transferred';
  if (k.includes('complete') || k.includes('hangup') || k === 'ended') return 'call.completed';
  return 'call.inbound';
}

export type SyncRange = 'today' | '24h' | '7d';

/**
 * Resolve a convenience range to explicit instants.
 *
 * DELIBERATELY NOT CALLED BY `execute`, and a test asserts it never is. A caller
 * that offers an operator a "last 7 days" button resolves what that means at the
 * edge, where the request is, and hands the primitive two instants. A primitive
 * that resolves its own upper bound is one a scheduler can ask for an interval
 * nobody named.
 */
export function sinceForRange(range: SyncRange, now: Date = new Date()): Date {
  if (range === 'today') {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d;
  }
  if (range === '7d') return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  return new Date(now.getTime() - 24 * 60 * 60 * 1000);
}

function emptyExecution(input: CallGridPollInput): CallGridPollExecution {
  return {
    outcome: 'REFUSED',
    since: input.since.toISOString(),
    until: input.until.toISOString(),
    dryRun: input.dryRun === true,
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
  };
}

/**
 * The provider seam.
 *
 * INJECTED SO THE COMPLETENESS GATE CAN BE PROVEN. The gate is the single most
 * load-bearing behaviour in this service -- an incomplete read must reach
 * ingestion zero times -- and a service that reaches the network itself can only
 * be tested against the network. `ProviderReconciliationService` takes its
 * readers the same way and for the same reason. The default is the real one, so
 * a caller that injects nothing gets production behaviour.
 */
export interface CallGridIntervalReader {
  read(input: {
    apiKey: string;
    since: Date;
    until: Date;
    baseUrl?: string | undefined;
  }): Promise<IntervalReadResult>;
}

/** The production reader: the ONE bounded multi-page CallGrid loop. */
export function callGridIntervalReader(): CallGridIntervalReader {
  return {
    read: (input) =>
      readCallGridInterval({
        apiKey: input.apiKey,
        since: input.since,
        until: input.until,
        ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
      }),
  };
}

/**
 * The write seam, and there is only ever one implementation in production.
 *
 * INJECTED FOR THE SAME REASON THE READER IS: the property this service exists to
 * guarantee is "an incomplete read reaches ingestion ZERO times", and a guarantee
 * about how many times something was called can only be proved by counting the
 * calls. The default is the real IngestionService, constructed from the same
 * client, and a test asserts that. Nothing in production passes this.
 */
export interface CallGridIngestor {
  ingest(input: IngestInput): Promise<IngestResult[]>;
}

export interface CallGridPollDeps {
  reader?: CallGridIntervalReader;
  ingestion?: CallGridIngestor;
}

export class CallGridPollService {
  private readonly ingestion: CallGridIngestor;
  private readonly integrations: IntegrationRepository;
  private readonly reader: CallGridIntervalReader;

  constructor(prisma: PrismaClient, deps: CallGridPollDeps = {}) {
    this.reader = deps.reader ?? callGridIntervalReader();
    this.ingestion = deps.ingestion ?? new IngestionService(prisma);
    this.integrations = new IntegrationRepository(prisma);
  }

  /**
   * Read one bounded interval, and write it only if the read completed.
   *
   * SEQUENTIAL BY CONSTRUCTION. There is no `Promise.all` here and there must
   * never be one. Two records for the same call processed concurrently would race
   * on the same `(provider, externalId)` row and on the same canonical facts,
   * and — the reason that actually matters — a parallel apply cannot stop at the
   * first failure, because by then it has already written the others.
   */
  async execute(
    input: CallGridPollInput,
    observer: CallGridPollObserver = {},
  ): Promise<CallGridPollExecution> {
    const result = emptyExecution(input);

    if (!input.apiKey) {
      result.reason = 'No provider credential was supplied.';
      return result;
    }

    // THE BOUNDS ARE JUDGED BY THE READER'S OWN RULE, not by a second opinion
    // written here, so a span limit or an ordering rule that changes there
    // changes here on the same day rather than drifting into disagreement.
    const bounds = validateInterval(input.since, input.until);
    if (!bounds.ok) {
      result.reason = bounds.reason;
      return result;
    }

    // --- 1. Read the whole interval, before anything is written ---------------
    let read: IntervalReadResult;
    try {
      read = await this.reader.read({
        apiKey: input.apiKey,
        since: input.since,
        until: input.until,
        baseUrl: input.apiBaseUrl,
      });
    } catch (error) {
      // The reader classifies provider failures into outcomes and does not throw
      // for them, so reaching here is structural. Nothing was written either way.
      result.outcome = 'FETCH_INCOMPLETE';
      result.fetchOutcome = 'THREW';
      result.reason = error instanceof Error ? error.message : 'unknown error';
      return result;
    }

    result.fetchOutcome = read.outcome;
    result.providerRecordsFetched = read.records;
    result.acceptedRecords = read.events.length;
    result.refusedRecords = read.refused.length;
    result.refusals = read.refused.map((r) => ({
      page: r.page,
      reason: r.reason,
      ...(r.kind ? { kind: r.kind } : {}),
    }));
    result.pages = read.pages;
    result.pageCap = read.pageCap;
    result.rateLimitRetries = read.rateLimitRetries;
    result.providerTotal = typeof read.providerTotal === 'number' ? read.providerTotal : null;

    // THE LOAD-BEARING LINE. `intervalWasComplete` is the shared predicate, so an
    // outcome added to the reader later is treated as incomplete here on the day
    // it is added rather than falling through a hard-coded list of today's
    // failures. What came back on a short read is a LOWER BOUND on the interval,
    // and a lower bound is evidence, not a poll.
    if (!intervalWasComplete(read)) {
      result.outcome = 'FETCH_INCOMPLETE';
      result.reason = read.reason ?? `The provider read ended ${read.outcome} rather than COMPLETE.`;
      result.notAttempted = read.events.length;
      return result;
    }

    // --- 2. A complete read may still hold records the mapper refused ---------
    //
    // FAIL CLOSED, ALL OR NOTHING. The alternative — write the accepted records
    // and report the interval as covered-with-exceptions — is the option a future
    // checkpoint would eventually advance past, taking the refused records with it
    // permanently. There is no resumable contract in this repository that could
    // carry "this interval is done except for these three", so the honest answer
    // is that the interval is not done. A refused record means the provider
    // returned something the shipped mapper does not recognise, which is a
    // contract change worth a person's attention rather than a rounding error.
    if (read.refused.length > 0) {
      result.outcome = 'REFUSED';
      result.reason =
        `${read.refused.length} provider record(s) in a COMPLETE read could not be mapped. ` +
        'No records were written: an interval containing an unmapped record is not a polled interval.';
      result.notAttempted = read.events.length;
      // The refusals are ON THE RESULT rather than streamed through the observer:
      // a caller that reports them wants them beside the fetch outcome that
      // explains them, not interleaved ahead of it.
      return result;
    }

    // --- 3. Dry run: say what would happen, mutate nothing --------------------
    if (input.dryRun === true) {
      for (const ev of read.events) {
        const status = await this.integrations.statusOfEvent(
          input.organizationId,
          CALLGRID_POLL_PROVIDER,
          ev.externalId,
        );
        // The SAME predicate ingestion branches on. Re-spelling the status literal
        // here is how a dry run starts describing a run that no longer exists.
        if (status !== null && isDuplicateObservation(status)) result.duplicateObservations += 1;
        else result.newEvents += 1;
      }
      result.notAttempted = read.events.length;
      result.outcome = 'DRY_RUN_READY';
      // Said out loud rather than implied by a zero. A dry run reporting
      // strengthened=0 would read as "nothing will change", which is a claim it
      // cannot make: whether a re-observation strengthens or conflicts is decided
      // by convergeFact against the stored value at write time.
      result.reason =
        'Nothing was written. Fact convergence is NOT predicted. Duplicate classification is ' +
        'organization-scoped while ingestion matches (provider, externalId) globally, so a delivery ' +
        'held by another tenant is counted as new here and would be recognised as existing on apply.';
      return result;
    }

    // --- 4. Apply, one record at a time, stopping on an unexpected failure ----
    //
    // FETCHING IS ALL-OR-NOTHING; PROCESSING IS NOT, and cannot be. Thousands of
    // records through the full pipeline is not one database transaction, and
    // pretending otherwise would mean holding a transaction open for the length of
    // a provider day. So the guarantee here is different and is stated rather than
    // implied: a run that stops part-way reports PARTIALLY_APPLIED, names where it
    // stopped, and is never a success. Re-running the identical interval converges,
    // because every row already written is recognised by `(provider, externalId)`
    // and re-observed rather than duplicated.
    //
    // A PROVIDER FACT CONFLICT IS NOT A FAILURE. It is the business outcome PR #182
    // exists to produce: two settled values disagree, the canonical value did not
    // move, and a revision row records the disagreement. The run continues and
    // reports APPLIED_WITH_CONFLICTS, because stopping would leave the rest of a
    // real interval unwritten over a question about one call's revenue.
    for (let index = 0; index < read.events.length; index += 1) {
      const ev: InboundEvent | undefined = read.events[index];
      if (!ev) continue;
      let outcome: IngestResult | undefined;
      let thrown: string | null = null;
      try {
        const results = await this.ingestion.ingest({
          organizationId: input.organizationId,
          provider: CALLGRID_POLL_PROVIDER,
          providerConnectionId: input.providerConnectionId ?? null,
          mapEventType: mapCallGridEventType,
          events: [ev],
          observationSource: POLL_OBSERVATION_SOURCE,
        });
        outcome = results[0];
      } catch (error) {
        thrown = error instanceof Error ? error.message : 'unknown error';
      }

      if (!outcome || outcome.status === 'failed') {
        const digest = identityDigest(ev.externalId);
        result.failedProcessing += 1;
        result.failedAtIndex = index;
        result.failedIdentityDigest = digest;
        result.notAttempted = read.events.length - index - 1;
        result.reason = outcome?.error ?? thrown ?? 'Ingestion reported no result.';
        const applied = result.newEvents + result.duplicateObservations;
        result.outcome = applied > 0 ? 'PARTIALLY_APPLIED' : 'PROCESSING_FAILED';
        observer.onFailure?.({
          index,
          identityDigest: digest,
          applied,
          notAttempted: result.notAttempted,
          detail: result.reason,
        });
        return result;
      }

      if (outcome.status === 'duplicate') result.duplicateObservations += 1;
      else result.newEvents += 1;

      if (outcome.strengthenedFacts.length > 0) {
        result.strengthenedCalls += 1;
        observer.onStrengthened?.({
          index,
          identityDigest: identityDigest(ev.externalId),
          facts: outcome.strengthenedFacts,
        });
      }
      if (outcome.conflictedFacts.length > 0) {
        result.conflicts += outcome.conflictedFacts.length;
        observer.onConflict?.({
          index,
          identityDigest: identityDigest(ev.externalId),
          facts: outcome.conflictedFacts,
        });
      }

      const done = index + 1;
      if (done % POLL_PROGRESS_EVERY === 0) {
        observer.onProgress?.({
          done,
          of: read.events.length,
          created: result.newEvents,
          reObserved: result.duplicateObservations,
        });
      }
    }

    result.outcome = result.conflicts > 0 ? 'APPLIED_WITH_CONFLICTS' : 'APPLIED';
    if (result.conflicts > 0) {
      result.reason =
        `${result.conflicts} provider fact(s) disagreed with what Loop already holds. ` +
        'No canonical value was moved for any of them; each is recorded as a revision.';
    }
    return result;
  }
}
