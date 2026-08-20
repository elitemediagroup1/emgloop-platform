// CallGridReconciliationService - Sprint 17 (API reconciliation / backfill)
// + Sprint 18 ingestion truth fix (PR #41).
//
// Webhooks are the real-time ingress; the CallGrid REST API is the SOURCE OF
// TRUTH. This service pulls recent calls from the API and brings the Loop in
// sync with CallGrid reporting WITHOUT fabricating data and WITHOUT deleting
// anything:
//
// - fetched:          calls returned by the CallGrid API in the window
// - imported:          calls the webhook never delivered, ingested in full
// - skippedDuplicate:  calls already PROCESSED with complete attribution
// - enriched:          existing webhook calls that were MISSING attribution and
//                      had it filled in from the API (metadata merge only)
// - failed:            calls that errored during import
//
// Import reuses IngestionService (idempotent on provider+externalId), so the
// full Loop pipeline (Customer/Interaction/Signal/NBA) runs for new calls.
// Enrichment updates ONLY the Interaction.metadata of an already-PROCESSED
// call, adding canonical attribution keys that were absent or fabricated.
//
// PR #41: mapReconEventType() no longer falls back to 'call.completed' for an
// unrecognized/empty status - see the function below for the full rationale.
// ENRICH_STRING_KEYS / ENRICH_OTHER_KEYS were extended to include the id-based
// attribution (buyerId/sourceId/campaignId/destinationId) and cost/telco/
// completed/noRoute/converted fields the REST client now maps, so an already-
// PROCESSED call can still be enriched with them.

import type { PrismaClient, Prisma } from '@prisma/client';
import type { InboundEvent } from '@emgloop/providers';
import type { ObservationSource } from '@emgloop/shared';
import { IngestionService } from './ingestion.service';

/** Canonical attribution keys the reconciliation enriches (string-valued). */
const ENRICH_STRING_KEYS = [
    'vendor',
    'source',
    'campaign',
    'buyer',
    'destination',
    'callerState',
    'callerZip',
    'caller',
    'fromNumber',
    'buyerId',
    'sourceId',
    'campaignId',
    'destinationId',
    'destinationNumber',
  ] as const;

/** Numeric/boolean keys the reconciliation enriches. */
const ENRICH_OTHER_KEYS = [
    'durationSeconds',
    'revenue',
    'payout',
    'billable',
    'paid',
    'converted',
    'completed',
    'noRoute',
    'cost',
    'telco',
    'rate',
  ] as const;

/** Fabricated/placeholder attribution labels that count as MISSING. */
const FABRICATED = [
    /^vendor\s+[a-z]$/i,
    /^buyer\s+[a-z]$/i,
    /^source\s+[a-z]$/i,
    /^campaign\s+[a-z]$/i,
    /^partner\s+[a-z]$/i,
    /^e2e\b/i,
    /^demo\b/i,
    /^test\b/i,
    /^sample\b/i,
    /^\(unattributed\)$/i,
    /^unknown$/i,
  ];

function isRealValue(v: unknown): boolean {
    if (typeof v === 'number') return Number.isFinite(v);
    if (typeof v === 'boolean') return true;
    if (typeof v !== 'string') return false;
    const s = v.trim();
    if (!s) return false;
    return !FABRICATED.some((re) => re.test(s));
}

export type SyncRange = 'today' | '24h' | '7d';

/** What a run compared against: a clock-relative preset, or an explicit interval. */
export type ReconciliationBasis = SyncRange | 'explicit';

/** An explicit bounded interval, half-open [since, until). */
export interface ExplicitWindow {
    since: Date;
    until: Date;
}

export interface ReconciliationInput {
    organizationId: string;
    apiKey: string;
    /** Clock-relative preset. IGNORED when `window` is supplied. */
  range: SyncRange;
    /**
     * An explicit bounded interval, which takes precedence over `range`.
     *
     * WHY THIS EXISTS. Every range was resolved against `new Date()` with an
     * implicit upper bound of now, so there was no way to ask for one past day --
     * the closest available was `7d`, which on any busy week is far more records
     * than the page budget allows and therefore truncates. A caller that needs one
     * complete Eastern business day derives it from `business-time.ts` and passes
     * it here; this service does not compute business days itself, because two
     * places deciding what a day is means two answers across a DST boundary.
     */
  window?: ExplicitWindow;
    apiBaseUrl?: string;
    providerConnectionId?: string | null;
    events?: InboundEvent[];
    /** Adapter page budget. A safety bound, never a completeness claim. */
  maxPages?: number;
  /**
   * How rows written by this run should be labelled. Defaults to API_POLL.
   *
   * The seam a later recovery uses. Recovery is the SAME read through the SAME
   * ingestion path -- what differs is that a person went looking, and that is
   * provenance rather than a different engine.
   */
  observationSource?: ObservationSource;
}

export interface ReconciliationResult {
    /** 'explicit' when an interval was supplied, else the preset that was used. */
  range: ReconciliationBasis;
    since: string;
    until: string;
    fetched: number;
    imported: number;
    skippedDuplicate: number;
    enriched: number;
    failed: number;
    callers: string[];
    errors: string[];
    at: string;
    // --- Pagination evidence -------------------------------------------------
    /** Pages actually requested from the provider. */
  pagesFetched: number;
    /** The page budget that applied. */
  pageCap: number;
    /**
     * TRUE WHEN THE PROVIDER STILL HAD PAGES AND WE STOPPED.
     *
     * A truncated run has imported real rows, but what it read is a LOWER BOUND on
     * the window. No caller may report it as a completed sync, and it can never
     * certify the window as observed. This is the same rule
     * `marketplace_report_runs.truncated` states for auction reports; before this
     * field existed, a 6,918-call day came back as a clean 2,500.
     */
  truncated: boolean;
}

/** Resolve the lower bound of a sync range relative to now. */
export function sinceForRange(range: SyncRange, now: Date = new Date()): Date {
    if (range === 'today') {
          const d = new Date(now);
          d.setHours(0, 0, 0, 0);
          return d;
    }
    if (range === '7d') return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    return new Date(now.getTime() - 24 * 60 * 60 * 1000);
}

export class CallGridReconciliationService {
    private readonly ingestion: IngestionService;

  constructor(private readonly prisma: PrismaClient) {
        this.ingestion = new IngestionService(prisma);
  }

  /**
     * Fetch recent CallGrid calls and reconcile them into the Loop. Returns a
     * per-call breakdown. Never deletes; never fabricates; idempotent.
     */
  async reconcile(input: ReconciliationInput): Promise<ReconciliationResult> {
        const now = new Date();
        // An explicit interval wins. Both bounds are then real, which is what makes
        // a bounded historical read possible at all -- a preset's upper bound is
        // always "now" and can never name a past day.
        const since = input.window ? input.window.since : sinceForRange(input.range, now);
        const until = input.window ? input.window.until : now;
        const at = now.toISOString();
        const result: ReconciliationResult = {
                range: input.window ? 'explicit' : input.range,
                since: since.toISOString(),
                until: until.toISOString(),
                fetched: 0,
                imported: 0,
                skippedDuplicate: 0,
                enriched: 0,
                failed: 0,
                callers: [],
                errors: [],
                at,
                pagesFetched: 0,
                pageCap: 0,
                truncated: false,
        };

      let events: InboundEvent[];
        try {
                if (input.events) {
                          events = input.events;
                } else {
                          const page = await this.fetchEvents(input, since, until);
                          events = page.events;
                          result.pagesFetched = page.pagesFetched;
                          result.pageCap = page.pageCap;
                          result.truncated = page.truncated;
                }
        } catch (err) {
                result.errors.push(err instanceof Error ? err.message : 'fetch failed');
                return result;
        }
        result.fetched = events.length;
        if (result.truncated) {
                // Recorded as an ERROR, not a note. A caller that reads `errors` to
          // decide whether a run succeeded must not see a truncated read as clean:
          // the rows imported are real, but the window is not covered.
          result.errors.push(
                    `Truncated: stopped at the ${result.pageCap}-page budget while the provider ` +
                      'still had pages. What was read is a lower bound over this window.',
                  );
        }
        const callerSet = new Set<string>();

      for (const ev of events) {
              if (ev.customerPhone) callerSet.add(ev.customerPhone);
              try {
                        const existing = await this.prisma.integrationEvent.findFirst({
                                    where: { provider: 'callgrid', externalId: ev.externalId },
                        });

                if (existing && existing.status === 'PROCESSED') {
                            const didEnrich = await this.enrichExisting(input.organizationId, ev);
                            if (didEnrich) result.enriched += 1;
                            else result.skippedDuplicate += 1;
                            continue;
                }

                const ingestResults = await this.ingestion.ingest({
                            organizationId: input.organizationId,
                            provider: 'callgrid',
                            providerConnectionId: input.providerConnectionId ?? null,
                            mapEventType: mapReconEventType,
                            events: [ev],
                            // Routine polling by default. A recovery operation
                            // passes API_RECOVERY instead, so the rows it writes
                            // are distinguishable from traffic that arrived the
                            // ordinary way -- without a second ingestion engine
                            // and without this PR performing any recovery.
                            observationSource: input.observationSource ?? 'API_POLL',
                });
                        const res = ingestResults[0];
                        if (!res) {
                                    result.failed += 1;
                                    continue;
                        }
                        if (res.status === 'processed') result.imported += 1;
                        else if (res.status === 'duplicate') result.skippedDuplicate += 1;
                        else {
                                    result.failed += 1;
                                    if (res.error) result.errors.push(res.error);
                        }
              } catch (err) {
                        result.failed += 1;
                        result.errors.push(err instanceof Error ? err.message : 'reconcile error');
              }
      }

      result.callers = [...callerSet];
        return result;
  }

  /**
     * Fetch events from CallGrid via the registered provider adapter poll().
     *
     * PAGINATION BELONGS TO THE ADAPTER, AND ONLY THE ADAPTER. This used to wrap
     * poll() in its own 25-iteration cursor loop, which never ran more than once
     * because poll() returned a hardcoded `hasMore: false` -- so the loop was dead
     * code that read like a safeguard, and the real 25-page / 2,500-record ceiling
     * inside the adapter was invisible from here. Two nested page budgets would
     * also have multiplied into a limit nobody had chosen. poll() now reports its
     * own exhaustion truthfully, so this asks once and carries the answer up.
     */
  private async fetchEvents(
        input: ReconciliationInput,
        since: Date,
        until: Date,
      ): Promise<{ events: InboundEvent[]; pagesFetched: number; pageCap: number; truncated: boolean }> {
        const providers = await import('@emgloop/providers');
        const provider = providers.getCallGridProvider();
        const page = await provider.poll(
          {
                      organizationId: input.organizationId,
                      credentials: { apiKey: input.apiKey },
                      config: input.apiBaseUrl ? { apiBaseUrl: input.apiBaseUrl } : {},
          },
          { since, until, maxPages: input.maxPages },
                );
        return {
                events: page.events,
                pagesFetched: page.pagesFetched ?? 0,
                pageCap: page.pageCap ?? 0,
                truncated: page.truncated === true,
        };
  }

  /**
     * Enrich an already-PROCESSED CallGrid Interaction with attribution that was
     * missing or fabricated. Merges canonical keys into Interaction.metadata only;
     * never overwrites a real existing value; never deletes. Returns true if any
     * field was added.
     */
  private async enrichExisting(organizationId: string, ev: InboundEvent): Promise<boolean> {
        const interaction = await this.prisma.interaction.findFirst({
                where: { organizationId, provider: 'callgrid', externalId: ev.externalId },
        });
        if (!interaction) return false;

      const current = (interaction.metadata && typeof interaction.metadata === 'object'
                             ? (interaction.metadata as Record<string, unknown>)
                             : {}) as Record<string, unknown>;
        const incoming = ev.payload as Record<string, unknown>;

      const patch: Record<string, unknown> = {};
        for (const key of [...ENRICH_STRING_KEYS, ...ENRICH_OTHER_KEYS]) {
                const have = isRealValue(current[key]);
                const next = incoming[key];
                if (!have && isRealValue(next)) patch[key] = next;
        }

      if (Object.keys(patch).length === 0) return false;

      const merged = { ...current, ...patch, reconciledFromApiAt: new Date().toISOString() };
        await this.prisma.interaction.update({
                where: { id: interaction.id },
                data: { metadata: merged as Prisma.InputJsonValue },
        });
        return true;
  }
}

/**
 * Map a reconciliation rawEventType to a canonical Loop event type.
 * PR #41: an unrecognized/empty status (rawEventType is now 'unknown' rather
 * than a fabricated 'completed' - see mapCallGridApiRecord) falls through to
 * the generic 'call.inbound' bucket. It is NEVER mapped to 'call.completed'.
 * Widened to also recognize the real CallGrid callStatus enum values (BUSY,
 * FAILED, CANCELED, REJECTED, BLOCKED, IN_PROGRESS, CONNECTED) so fewer real
 * calls fall into the generic inbound bucket.
 */
export function mapReconEventType(raw: string): string {
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
