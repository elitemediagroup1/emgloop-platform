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

export interface ReconciliationInput {
    organizationId: string;
    apiKey: string;
    range: SyncRange;
    apiBaseUrl?: string;
    providerConnectionId?: string | null;
    events?: InboundEvent[];
}

export interface ReconciliationResult {
    range: SyncRange;
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
        const since = sinceForRange(input.range, now);
        const at = now.toISOString();
        const result: ReconciliationResult = {
                range: input.range,
                since: since.toISOString(),
                until: at,
                fetched: 0,
                imported: 0,
                skippedDuplicate: 0,
                enriched: 0,
                failed: 0,
                callers: [],
                errors: [],
                at,
        };

      let events: InboundEvent[];
        try {
                events = input.events ?? (await this.fetchEvents(input, since));
        } catch (err) {
                result.errors.push(err instanceof Error ? err.message : 'fetch failed');
                return result;
        }
        result.fetched = events.length;
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

  /** Fetch events from CallGrid via the registered provider adapter poll(). */
  private async fetchEvents(input: ReconciliationInput, since: Date): Promise<InboundEvent[]> {
        const providers = await import('@emgloop/providers');
        const provider = providers.getCallGridProvider();
        const out: InboundEvent[] = [];
        let cursor: string | undefined;
        let guard = 0;
        do {
                const page = await provider.poll(
                  {
                              organizationId: input.organizationId,
                              credentials: { apiKey: input.apiKey },
                              config: input.apiBaseUrl ? { apiBaseUrl: input.apiBaseUrl } : {},
                  },
                  { since, cursor },
                        );
                out.push(...page.events);
                cursor = page.nextCursor;
                guard += 1;
        } while (cursor && guard < 25);
        return out;
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
