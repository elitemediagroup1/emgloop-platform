// IngestionService â Sprint 11 (First Live Integration, Phases 2-4 + 7).
//
// The orchestration spine for live events. Given verified InboundEvents from a
// provider adapter, this service runs the full Loop pipeline for each one:
//
//  1. Record the raw event as an IntegrationEvent FIRST, in RECEIVED state
//     (idempotent on provider + externalId). This durably captures the
//     delivery before any processing, so a crash mid-pipeline leaves a
//     retryable row rather than a lost event.
//  2. Transition the event to PROCESSING.
//  3. Build a provider-agnostic NormalizedEvent and run it through the
//     NormalizationEngine -> Interaction + Signal + DomainEvent + Workflow,
//     then project a call into MarketplaceCall.
//  4. Enrich the Brain via the SignalRegistry (Phase 4 signals).
//  5. Run the rules-based NextBestActionService (Phase 7).
//  6. Mark the IntegrationEvent PROCESSED, or FAILED with the error so the
//     admin retry queue can replay it.
//
// INGESTION RECORDS FACTS. IT NEVER DECIDES WHO SOMEONE IS.
//
// Nothing on this path creates, looks up, attaches to or changes a Customer. A
// caller number, a form's email or phone, a website visitor or session id: each
// is what a source REPORTED, and it stays on the event and the Interaction as a
// fact. Every row written here carries no customer. A Person is established only
// through governed identity resolution (packages/shared/src/party.ts), which this
// path must not reach either. ingestion-identity-boundary.test.ts fences the
// Customer table; party-contract.test.ts and customer-party-link.test.ts fence
// resolution and linking.
//
// (Ingestion used to resolve a Customer for every event. A caller number matched
// whichever Customer shared its last seven digits, an email matched the first
// Customer holding it, a withheld caller ID created a new Customer on every call,
// and every anonymous website visitor became one. Event workflows then reset the
// matched Customer's intake status. That is how People filled with callers and
// visitors nobody had identified.)
//
// Status lifecycle: RECEIVED -> PROCESSING -> PROCESSED | FAILED. A FAILED (or
// orphaned RECEIVED) row is retryable: re-delivering the same externalId reuses
// the row and re-runs from PROCESSING. Only PROCESSED short-circuits as a
// duplicate.
//
// NO provider-specific logic lives here. The adapter already translated the wire
// format into InboundEvent; everything below is generic. A different provider
// produces InboundEvents the same way and flows through this identical pipeline.
//
// Sprint 14 (Website Intelligence) makes this same spine carry the web.* event
// family â the Brain's second sense â by recognizing web.* canonical types. No
// new pipeline; just more event types.

import type { PrismaClient, Prisma } from '@prisma/client';
import type { NormalizedEvent, LoopEventType } from '@emgloop/shared';
import type { InboundEvent } from '@emgloop/providers';
import { withObservation, type ObservationSource } from '@emgloop/shared';
import {
  ProviderFactRevisionRepository,
  renderFactValue,
} from '../repositories/provider-fact-revision.repository';
import { NormalizationEngine } from '../repositories/normalization.repository';
import { MarketplaceCallRepository, isUniqueViolation } from '../repositories/marketplace-call.repository';
import { projectCallObservation } from '../repositories/marketplace-call-projection';
import { WorkflowsRepository } from '../repositories/workflows.repository';
import { deriveSignals } from './signal-registry';
import { NextBestActionService } from './next-best-action.service';

const LOOP_EVENT_TYPES_SET = new Set<string>([
  'call.inbound', 'call.outbound', 'call.answered', 'call.missed',
  'call.completed', 'call.voicemail', 'call.transferred',
  // Web / website intelligence (Sprint 10 baseline + Sprint 14 additions).
  'web.session_start', 'web.session_end', 'web.page_view', 'web.guide_view',
  'web.search', 'web.search_zip', 'web.search_city', 'web.search_category',
  'web.cta_click', 'web.phone_click', 'web.email_click',
  'web.external_link', 'web.affiliate_click',
  'web.form_start', 'web.form_submit', 'web.appointment_request', 'web.newsletter_signup',
  'web.chat_start', 'web.chat_complete',
  'web.download', 'web.quiz_start', 'web.quiz_complete',
  'web.planner_start', 'web.planner_save', 'web.planner_print',
  'web.video_play', 'web.error', 'web.goal_conversion',
  'sms.inbound', 'sms.outbound',
  'email.sent', 'email.delivered', 'email.opened', 'email.clicked',
  'ai.conversation_start', 'ai.conversation_end', 'ai.escalation',
  'ads.lead_form_submit',
]);

export interface IngestResult {
  externalId: string;
  status: 'processed' | 'duplicate' | 'failed';
  integrationEventId: string | null;
  interactionId: string | null;
  signalIds: string[];
  domainEventId: string | null;
  nextBestActions: string[];
  error?: string;
  /**
   * Canonical facts this observation MOVED, by name. Empty when this delivery
   * created the call -- there is nothing to strengthen about a call being
   * created -- and filled when it merged into a call another delivery of the same
   * CallId had already stored.
   */
  strengthenedFacts: string[];
  /**
   * Canonical facts this observation DISAGREED with. Nothing was moved for any
   * of them.
   *
   * SURFACED RATHER THAN LOGGED. A conflict is a settled amount disagreeing with
   * another settled amount, which is a question for a person; a caller that runs
   * thousands of observations in one batch cannot find that in a log line, and a
   * run that reports plain success while two revenue figures disagree is exactly
   * the silence PR #182 existed to end.
   */
  conflictedFacts: string[];
}

/** What one re-observation moved, and what it disagreed with. */
interface FactConvergenceSummary {
  strengthened: string[];
  conflicted: string[];
}

export interface IngestInput {
  organizationId: string;
  provider: string; // e.g. 'callgrid', 'website'
  /** Maps the adapter's rawEventType string to a canonical LoopEventType. */
  mapEventType: (rawEventType: string) => string;
  events: InboundEvent[];
  providerConnectionId?: string | null;
  /**
   * How this batch reached Loop.
   *
   * REQUIRED, DELIBERATELY. An optional field would default to something, and
   * every default is wrong for somebody: defaulting to WEBHOOK would relabel a
   * recovery as live traffic, and defaulting to API_POLL would relabel the live
   * webhook. Making it required means each caller states its own transport at
   * the one place it knows the answer, and a new caller cannot forget.
   */
  observationSource: ObservationSource;
}

/**
 * How long a delivery that is RECEIVED or PROCESSING is presumed to be in flight in
 * another request. A first ingestion is a few dozen queries -- well under a second
 * -- so five minutes is far past any live request and still short enough that a
 * crashed one is taken over by the next observation of the same call (a
 * reconciliation poll, for instance).
 */
export const INGESTION_IN_FLIGHT_LEASE_MS = 5 * 60_000;

/**
 * Whether an already-stored delivery is only OBSERVED again -- its call converged
 * with this delivery's facts -- rather than processed.
 *
 * ONE RULE, TWO READERS. `ingestOne` applies it to decide whether to observe or
 * process; a caller that wants to say what a batch WOULD do without writing
 * anything applies the identical predicate to the identical columns. Writing
 * `status === 'PROCESSED'` a second time somewhere else is how a dry run starts
 * disagreeing with the run it is supposed to describe.
 *
 * TWO CASES ARE OBSERVATIONS:
 *   * PROCESSED -- the call is fully ingested;
 *   * RECEIVED or PROCESSING, seen within the lease -- ANOTHER REQUEST IS
 *     INGESTING THIS VERY CALL RIGHT NOW. CallGrid fires Ended, Billable and
 *     Payable together, so this is the ordinary case, not an edge. Processing it
 *     a second time used to re-run normalization beside the first (duplicate
 *     Interactions), overwrite the delivery's payload, rebuild the call from the
 *     first delivery's copy, and skip convergence -- so Billable's revenue and
 *     Payable's payout were silently lost with an HTTP 200.
 *
 * FAILED, IGNORED, and a RECEIVED/PROCESSING row older than the lease (a crashed
 * request) are NOT observations: they are taken over and processed, by exactly one
 * request (see `ingestOne`).
 */
export function isDuplicateObservation(
  status: string,
  lastObservedAt: Date | null = null,
  now: Date = new Date(),
): boolean {
  if (status === 'PROCESSED') return true;
  const inFlight = status === 'RECEIVED' || status === 'PROCESSING';
  return inFlight && lastObservedAt !== null && now.getTime() - lastObservedAt.getTime() < INGESTION_IN_FLIGHT_LEASE_MS;
}

export class IngestionService {
  private readonly normalizer: NormalizationEngine;
  private readonly marketplaceCalls: MarketplaceCallRepository;
  private readonly nextBestAction: NextBestActionService;
  private readonly factRevisions: ProviderFactRevisionRepository;

  constructor(private readonly prisma: PrismaClient) {
    this.normalizer = new NormalizationEngine(prisma, new WorkflowsRepository(prisma));
    this.marketplaceCalls = new MarketplaceCallRepository(prisma);
    this.nextBestAction = new NextBestActionService(prisma);
    this.factRevisions = new ProviderFactRevisionRepository(prisma);
  }

  /** Process a batch of inbound events. Each event is isolated: one failure
      does not abort the others. Returns a per-event result for the caller. */
  async ingest(input: IngestInput): Promise<IngestResult[]> {
    const results: IngestResult[] = [];
    for (const ev of input.events) {
      results.push(await this.ingestOne(input, ev));
    }
    return results;
  }

  /**
   * Bring the canonical call up to date with THIS delivery's own facts.
   *
   * EVERY DELIVERY DOES THIS, whichever path it takes: the first delivery of a call
   * creates the row, and every other one -- a duplicate, one that arrived while
   * the first was still being ingested, a poll, a recovery -- merges into it. That
   * is what makes the order in which CallGrid's near-simultaneous webhooks arrive
   * irrelevant: the stored call converges to the strongest facts any of them
   * stated.
   *
   * THE DECISION IS NOT MADE HERE. `convergeCallObservation` applies the one pure
   * rule (`convergeFact`, kinds from `CALLGRID_FACT_KINDS`) fact by fact, and the
   * repository writes only what it approved, atomically. There is no
   * field-specific branching in this file and there must never be: the moment
   * "revenue is special" is written in two places, the two will disagree about a
   * postback.
   *
   * A CONFLICT WRITES NOTHING TO THE CALL. Two settled amounts that disagree are a
   * question for a person, not a race between observations. The disagreement is
   * recorded with appliedAt NULL so the record says the canonical value did not
   * move.
   *
   * BEST-EFFORT AT THE EDGE. A failure here must not turn a successful
   * observation into a failed ingestion: the delivery was real and is already
   * recorded. The error is reported and the run continues.
   */
  private async observeCall(
    input: IngestInput,
    ev: InboundEvent,
    canonicalType: string,
    integrationEventId: string,
    observedAt: Date,
  ): Promise<FactConvergenceSummary> {
    const summary: FactConvergenceSummary = { strengthened: [], conflicted: [] };
    try {
      const projection = projectCallObservation({
        organizationId: input.organizationId,
        provider: input.provider,
        externalId: ev.externalId,
        channel: channelFor(canonicalType),
        occurredAt: ev.occurredAt,
        // Exactly the metadata the Interaction for this delivery carries.
        metadata: { ...ev.payload, eventType: canonicalType },
        interactionId: null,
      });
      // Not a projectable call (not a phone call, or test traffic): nothing to converge.
      if (!projection) return summary;

      const observed = await this.marketplaceCalls.observe(projection);
      if (observed.outcome === 'FOREIGN' || observed.outcome === 'CONTENDED') {
        // eslint-disable-next-line no-console
        console.warn(JSON.stringify({ evt: 'marketplace_call_observation_not_applied', provider: input.provider, outcome: observed.outcome }));
      }
      for (const { fact, existing, converged } of observed.decisions) {
        if (converged.decision === 'UPDATE' && observed.outcome === 'MERGED') summary.strengthened.push(fact);
        if (converged.decision === 'CONFLICT') summary.conflicted.push(fact);
        await this.recordIfNotable(input, ev, integrationEventId, observedAt, fact, converged, existing, observed.outcome === 'MERGED');
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(
        JSON.stringify({
          evt: 'provider_fact_convergence_failed',
          provider: input.provider,
          reason: error instanceof Error ? error.message : 'unknown',
        }),
      );
    }
    return summary;
  }

  /** A revision row exists only for a change or a disagreement. Never for silence. */
  private async recordIfNotable(
    input: IngestInput,
    ev: InboundEvent,
    integrationEventId: string,
    observedAt: Date,
    fact: string,
    converged: { decision: string; value?: unknown; reason: string },
    existing: unknown,
    applied: boolean,
  ): Promise<void> {
    if (converged.decision !== 'UPDATE' && converged.decision !== 'CONFLICT') return;
    // An UPDATE that lost its race to an identical one was not applied by THIS
    // observation, and a revision says what happened, not what was intended.
    if (converged.decision === 'UPDATE' && !applied) return;
    await this.factRevisions.record(input.organizationId, {
      provider: input.provider,
      externalId: ev.externalId,
      fact,
      decision: converged.decision,
      fromValue: renderFactValue(existing),
      toValue: renderFactValue(
        converged.decision === 'UPDATE' ? converged.value : (ev.payload as Record<string, unknown>)[fact],
      ),
      observationSource: input.observationSource,
      observedAt,
      integrationEventId,
      applied: converged.decision === 'UPDATE',
      reason: converged.reason,
    });
  }

  private async ingestOne(input: IngestInput, ev: InboundEvent): Promise<IngestResult> {
    const { organizationId, provider } = input;
    const eventType = input.mapEventType(ev.rawEventType);

    const base: IngestResult = {
      externalId: ev.externalId,
      status: 'failed',
      integrationEventId: null,
      interactionId: null,
      signalIds: [],
      domainEventId: null,
      nextBestActions: [],
      strengthenedFacts: [],
      conflictedFacts: [],
    };

    // The canonical event type decides the Interaction's shape and whether this
    // delivery is a phone call at all. Computed once, for every path below.
    const canonicalType = (LOOP_EVENT_TYPES_SET.has(eventType)
      ? eventType
      : (provider === 'website' ? 'web.page_view' : 'call.inbound')) as LoopEventType;

    // 1. WHO INGESTS THIS CALL, AND WHO ONLY OBSERVES IT.
    //
    // provider + externalId is unique in the schema, and for CallGrid the
    // externalId is the CallId -- the SAME on every webhook for one call. CallGrid
    // fires Ended, Billable and Payable for a call at essentially the same moment,
    // so several requests for one call are the normal case. Exactly ONE of them
    // runs the pipeline (Interaction, signals, domain event, workflows); every
    // other one is an observation that converges the call with its own facts.
    // The unique key decides the first; a conditional update decides any takeover.
    const now = new Date();
    let existing = await this.prisma.integrationEvent.findFirst({
      where: { provider, externalId: ev.externalId },
    });
    let owned: { id: string } | null = null;

    if (!existing) {
      // 2. Persist the raw event FIRST in RECEIVED state. This durably records the
      //    delivery before any processing runs, so failures are always retryable
      //    from a known row.
      try {
        owned = await this.prisma.integrationEvent.create({
          data: {
            organizationId,
            providerConnectionId: input.providerConnectionId ?? null,
            category: 'INGESTION',
            provider,
            eventType,
            externalId: ev.externalId,
            status: 'RECEIVED',
            payload: ev.payload as object,
            // WHEN THE CALL HAPPENED, taken from the occurrence the ADAPTER
            // already resolved. Persistence does not re-resolve it: the
            // canonical resolver runs once, in the provider layer, and its
            // answer is carried here. A second resolution would eventually
            // disagree with the first about the same row.
            //
            // `receivedAt` is deliberately not set and never will be. It
            // defaults to now(), which is exactly right -- it means when LOOP
            // received this -- and a historical recovery must be able to say
            // occurredAt = August 11 and receivedAt = today at the same time.
            occurredAt: ev.occurredAt,
            // WRITTEN ONCE AND NEVER AGAIN. A webhook call the poller later
            // re-reads must keep saying WEBHOOK; the poller's visit is recorded
            // in observedSources beside it, not on top of it.
            firstIngestionSource: input.observationSource,
            observedSources: [input.observationSource],
            lastObservedAt: now,
          },
        });
      } catch (err) {
        // ANOTHER DELIVERY OF THE SAME CALL WON THE INSERT, a moment ago. This
        // used to escape as an unhandled error -- an HTTP 500 to CallGrid, and
        // this delivery's facts lost unless it retried. It is an observation.
        if (!isUniqueViolation(err)) throw err;
        existing = await this.prisma.integrationEvent.findFirst({ where: { provider, externalId: ev.externalId } });
        if (!existing) throw err;
      }
    }

    if (existing && !owned && !isDuplicateObservation(existing.status, existing.lastObservedAt ?? null, now)) {
      // FAILED, IGNORED, or orphaned by a crashed request: taken over and processed
      // -- by exactly one request. The update is conditional on the row still
      // being what was read, so of several deliveries racing to retry it, one
      // wins and the rest are observations.
      const takeover = await this.prisma.integrationEvent.updateMany({
        where: { id: existing.id, status: existing.status, lastObservedAt: existing.lastObservedAt ?? null },
        data: {
          status: 'RECEIVED',
          error: null,
          payload: ev.payload as object,
          // The payload is being rewritten in this same statement, so the
          // occurrence derived from it is written with it -- a row whose
          // payload says August 11 while its occurredAt says nothing would be
          // internally inconsistent. This is not a backfill: it touches only
          // rows the provider is re-delivering right now.
          //
          // receivedAt is NOT in this object and must never be. Re-observing a
          // call Loop already holds does not change when Loop first held it.
          occurredAt: ev.occurredAt,
          // The observation is recorded here too. firstIngestionSource is
          // absent from this object and must stay absent: this row already
          // exists, so something already observed it first.
          lastObservedAt: now,
          observedSources: withObservation(existing.observedSources ?? [], input.observationSource),
        },
      });
      if (takeover.count === 1) owned = { id: existing.id };
    }

    if (!owned) {
      // AN OBSERVATION IS RECORDED EVEN WHEN NOTHING IS INGESTED.
      //
      // This branch used to return without writing anything, so asking the
      // provider again -- and being answered -- left no trace. That is the fact
      // a poller exists to produce, and it was being discarded.
      //
      // ONLY the observation is written. The payload is NOT replaced: it is the
      // evidence that produced this row's Interaction and MarketplaceCall, and
      // overwriting it would orphan a projection from its source. receivedAt,
      // occurredAt, firstIngestionSource and status are all untouched.
      const observed = existing!;
      await this.prisma.integrationEvent.update({
        where: { id: observed.id },
        data: {
          lastObservedAt: now,
          observedSources: withObservation(observed.observedSources ?? [], input.observationSource),
        },
      });

      // AND THEN, SEPARATELY, WHAT THIS OBSERVATION SAYS ABOUT THE CALL. The call
      // is converged with this delivery's own facts -- created from them if the
      // delivery that owns the pipeline has not reached it yet.
      const converged = await this.observeCall(input, ev, canonicalType, observed.id, now);
      return {
        ...base,
        status: 'duplicate',
        integrationEventId: observed.id,
        strengthenedFacts: converged.strengthened,
        conflictedFacts: converged.conflicted,
      };
    }

    const record = owned;
    base.integrationEventId = record.id;

    // Transition RECEIVED -> PROCESSING now that the raw event is safely stored.
    await this.prisma.integrationEvent.update({
      where: { id: record.id },
      data: { status: 'PROCESSING', error: null },
    });

    try {
      // 3. THE CALL FIRST. This delivery's facts reach the canonical call before
      // anything slower runs, so the economics CallGrid just sent are visible
      // within this request even if a later step fails -- and every delivery of
      // the call, owner or not, converges it by the same rule.
      const converged = await this.observeCall(input, ev, canonicalType, record.id, now);
      base.strengthenedFacts = converged.strengthened;
      base.conflictedFacts = converged.conflicted;

      // 3a. Build the provider-agnostic NormalizedEvent and normalize it. What the
      // source reported about who was involved travels in the payload, as a fact.
      const normalized: NormalizedEvent = {
        organizationId,
        source: provider,
        externalId: ev.externalId,
        eventType: canonicalType,
        occurredAt: ev.occurredAt,
        durationSeconds: numberFrom(ev.payload, ['durationSeconds', 'duration', 'duration_seconds', 'billable_duration']),
        summary: summaryFor(canonicalType, ev.payload),
        metadata: { ...ev.payload, eventType: canonicalType },
      };
      const normResult = await this.normalizer.normalize(normalized);
      base.interactionId = normResult.interactionId;
      base.domainEventId = normResult.domainEventId;
      base.signalIds = [...normResult.signalIds];

      // 3b. Link the call to its Interaction -- the canonical operational read
      // model. The call already holds this delivery's facts (step 3); projecting
      // the Interaction MERGES, so it can only fill the link or confirm what is
      // there, never overwrite it.
      //
      // This was the gap that made the read model empty. Ingestion wrote the
      // Interaction and stopped; nothing here referenced MarketplaceCall at
      // all. The only population path was a lazy backfill triggered by loading
      // the Brain admin page, scoped to that page's own 7-day window and only
      // when the window was already empty. Live reconciliation proved the
      // result: 108 calls at CallGrid, 0 rows in Loop.
      //
      // NON-FATAL BY DESIGN. The Interaction is the source of truth and the
      // projection is rebuildable from it via projectWindow(), so a projection
      // failure must never fail ingestion — that would turn a read-model bug
      // into lost provider data, and the webhook would return non-2xx and
      // trigger CallGrid retries for an event we already stored.
      //
      // Test traffic is recognised from the call's own identifiers (see
      // isExcludedInteraction), never from a Customer record.
      if (normResult.interactionId) {
        try {
          const row = await this.prisma.interaction.findUnique({
            where: { id: normResult.interactionId },
            select: {
              id: true, organizationId: true, provider: true, externalId: true,
              channel: true, occurredAt: true, metadata: true,
            },
          });
          if (row) await this.marketplaceCalls.projectInteraction(row);
        } catch (error) {
          // Recorded, never rethrown. projectWindow() can rebuild this row later.
          console.warn(
            JSON.stringify({
              evt: 'marketplace_call_projection_failed',
              interactionId: normResult.interactionId,
              provider,
              reason: error instanceof Error ? error.message : 'unknown',
            }),
          );
        }
      }

      // 4. SignalRegistry enrichment (Phase 4). Append-only, advisory. A signal
      // describes the event, so it is written for every new event and names the
      // Interaction it came from; it is not a fact about a person.
      if (!normResult.wasIdempotent) {
        const derived = deriveSignals(normalized);
        for (const d of derived) {
          try {
            const s = await this.prisma.signal.create({
              data: {
                organizationId,
                type: d.type,
                key: d.key,
                label: d.label,
                valueString: d.valueString ?? null,
                valueNumber: d.valueNumber ?? null,
                confidence: d.confidence ?? null,
                source: 'signal-registry',
                metadata: {
                  externalId: ev.externalId,
                  eventType: canonicalType,
                  interactionId: normResult.interactionId,
                } as object,
              },
            });
            base.signalIds.push(s.id);
          } catch {
            // enrichment is advisory
          }
        }
      }

      // 5. Next Best Action (Phase 7) - rules-based recommendations. There is no
      // person, so there is no accumulated signal pool to read: the rules see this
      // interaction alone.
      if (base.interactionId) {
        const nba = await this.nextBestAction.run({
          organizationId,
          customerId: null,
          interaction: {
            id: base.interactionId,
            channel: channelFor(canonicalType),
            kind: kindFor(canonicalType),
            direction: directionFor(canonicalType),
            summary: normalized.summary ?? null,
            occurredAt: normalized.occurredAt,
            metadata: { eventType: canonicalType },
          },
          signals: [],
        });
        base.nextBestActions = nba.actions.map((a) => a.kind);
        // Surface the top recommendation on the interaction itself so the
        // Live Calls feed can show a Next Best Action (it reads
        // metadata.nextBestAction). Advisory + append-only: merge into
        // existing metadata, never overwrite a real value, never delete.
        const topAction = nba.actions[0];
        const interactionId = base.interactionId;
        if (topAction && interactionId) {
          const current = await this.prisma.interaction.findUnique({
            where: { id: interactionId },
            select: { metadata: true },
          });
          const md =
            current && current.metadata && typeof current.metadata === 'object' && !Array.isArray(current.metadata)
              ? (current.metadata as Record<string, unknown>)
              : {};
          if (md['nextBestAction'] == null) {
            await this.prisma.interaction.update({
              where: { id: interactionId },
              data: {
                metadata: {
                  ...md,
                  nextBestAction: topAction.title,
                  nextBestActionKind: topAction.kind,
                } as Prisma.InputJsonValue,
              },
            });
          }
        }
      }

      // 6. Done - mark PROCESSED.
      await this.prisma.integrationEvent.update({
        where: { id: record.id },
        data: { status: 'PROCESSED', processedAt: new Date(), error: null },
      });
      return { ...base, status: 'processed' };
    } catch (err) {
      // Mark FAILED with the error message; the row stays retryable (re-delivery
      // of the same externalId reuses it and re-runs the pipeline).
      const message = err instanceof Error ? err.message : 'Unknown ingestion error';
      await this.prisma.integrationEvent.update({
        where: { id: record.id },
        data: { status: 'FAILED', error: message },
      });
      return { ...base, status: 'failed', error: message };
    }
  }
}

function numberFrom(payload: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = payload[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  }
  return undefined;
}

function summaryFor(eventType: string, payload: Record<string, unknown>): string {
  if (eventType.startsWith('web.')) return websiteSummary(eventType, payload);
  const num =
    (typeof payload['caller_number'] === 'string' && payload['caller_number']) ||
    (typeof payload['from'] === 'string' && payload['from']) ||
    '';
  const label: Record<string, string> = {
    'call.inbound': 'Inbound call',
    'call.answered': 'Call answered',
    'call.missed': 'Missed call',
    'call.completed': 'Call completed',
    'call.voicemail': 'Voicemail left',
    'call.transferred': 'Call transferred',
  };
  const base = label[eventType] ?? 'Call event';
  return num ? base + ' from ' + num : base;
}

function pickStr(payload: Record<string, unknown>, key: string): string {
  const v = payload[key];
  return typeof v === 'string' && v.trim() ? v.trim() : '';
}

function websiteSummary(eventType: string, payload: Record<string, unknown>): string {
  const property = pickStr(payload, 'property') || 'website';
  const page = pickStr(payload, 'page') || pickStr(payload, 'title');
  const query = pickStr(payload, 'query');
  const cta = pickStr(payload, 'cta');
  const category = pickStr(payload, 'category');
  const label: Record<string, string> = {
    'web.session_start': 'Website session started',
    'web.session_end': 'Website session ended',
    'web.page_view': 'Viewed page',
    'web.guide_view': 'Viewed guide',
    'web.search': 'Searched',
    'web.search_zip': 'ZIP search',
    'web.search_city': 'City search',
    'web.search_category': 'Category search',
    'web.cta_click': 'Clicked CTA',
    'web.phone_click': 'Clicked call',
    'web.email_click': 'Clicked email',
    'web.external_link': 'Clicked external link',
    'web.affiliate_click': 'Clicked affiliate link',
    'web.form_start': 'Started a form',
    'web.form_submit': 'Submitted a form',
    'web.appointment_request': 'Requested an appointment',
    'web.newsletter_signup': 'Newsletter signup',
    'web.chat_start': 'Started chat',
    'web.chat_complete': 'Completed chat',
    'web.download': 'Downloaded a resource',
    'web.quiz_start': 'Started a quiz',
    'web.quiz_complete': 'Completed a quiz',
    'web.planner_start': 'Started a planner',
    'web.planner_save': 'Saved a planner',
    'web.planner_print': 'Printed a planner',
    'web.video_play': 'Played a video',
    'web.error': 'Encountered an error',
    'web.goal_conversion': 'Converted a goal',
  };
  const verb = label[eventType] ?? 'Website event';
  const detail = query || cta || page || category;
  const base = verb + ' on ' + property;
  return detail ? base + ' â ' + detail : base;
}

function channelFor(eventType: string): 'PHONE' | 'SMS' | 'EMAIL' | 'WEB_CHAT' | 'OTHER' {
  if (eventType.startsWith('call.')) return 'PHONE';
  if (eventType.startsWith('sms.')) return 'SMS';
  if (eventType.startsWith('email.')) return 'EMAIL';
  if (eventType.startsWith('ai.')) return 'WEB_CHAT';
  if (eventType === 'web.chat_start' || eventType === 'web.chat_complete') return 'WEB_CHAT';
  return 'OTHER';
}

function kindFor(
  eventType: string,
): 'PHONE_CALL' | 'SMS' | 'EMAIL' | 'CHAT' | 'APPOINTMENT' | 'FORM_SUBMISSION' | 'NOTE' | 'OTHER' {
  if (eventType.startsWith('call.')) return 'PHONE_CALL';
  if (eventType.startsWith('sms.')) return 'SMS';
  if (eventType.startsWith('email.')) return 'EMAIL';
  if (eventType === 'web.chat_start' || eventType === 'web.chat_complete' || eventType.startsWith('ai.')) return 'CHAT';
  if (eventType === 'web.appointment_request') return 'APPOINTMENT';
  if (eventType === 'web.form_start' || eventType === 'web.form_submit' || eventType === 'web.newsletter_signup') {
    return 'FORM_SUBMISSION';
  }
  if (eventType.startsWith('web.')) return 'OTHER';
  return 'OTHER';
}

function directionFor(eventType: string): 'INBOUND' | 'OUTBOUND' | 'INTERNAL' {
  if (eventType === 'call.outbound' || eventType === 'sms.outbound' || eventType.startsWith('email.')) {
    return 'OUTBOUND';
  }
  return 'INBOUND';
}
