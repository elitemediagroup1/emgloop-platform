// WebsiteAnalyticsRepository -- Loop's FIRST-PARTY website analytics, from the governed record of every website
// event Loop received (integration_events, provider 'website'), org-scoped and read-only. No third-party data.
//
// WHY integration_events AND NOT interactions (2026-09-30). The normalizer has never turned a page view or a
// session start into an Interaction -- only intent-bearing events (search, CTA/phone click, forms, chat...) get
// one -- so counting sessions and page views from interactions read zero for real traffic. Every admitted website
// event IS an integration event (one row per event, deduplicated on its property-namespaced id), with its
// canonical type in `eventType`; that is the complete record, and the one these counts come from.
//
// EXACT TOTALS, NO SILENT CEILING. Totals are database counts over the whole window (a GROUP BY on the event
// type). Rankings and journeys need each event's attributes, so they come from a keyset-paginated scan bounded by
// WEBSITE_RANKING_SCAN_LIMIT that says when it stopped (`rankingsComplete: false`). It once read `take: 5000` and
// presented the first 5,000 rows as the whole window.
//
// WHAT AN EVENT IS. Before 2026-09-30 an unknown event (heartbeat, scroll depth, identify) was stored as
// `web.page_view`; those legacy rows are recognised by the raw event name their payload kept and counted as
// telemetry, never as page views. Only PAGE_VIEW-class events count as page views.
//
// NOTHING UNMINIMIZED IS SHOWN. Every payload is read back through `minimizeWebsiteEvent`, so a legacy row that
// still holds a full URL, a query string, an email or a phone number contributes only its minimized attributes.
// Search rankings use the ZIP / category / city a search carried -- never free text.
//
// Journeys follow a VISITOR, not a Customer: website activity is linked to no Person.

import type { Prisma, PrismaClient } from '@prisma/client';
import { mapWebsiteEventType } from '@emgloop/providers';
import { minimizeWebsiteEvent, websiteEventClass } from '@emgloop/shared';

/** The most website events one analytics read scans for rankings and journeys. Totals are never capped. */
export const WEBSITE_RANKING_SCAN_LIMIT = 50_000;
const SCAN_PAGE = 2_000;

/** Raw names the tracker sent that were stored as `web.page_view` before 2026-09-30. */
const LEGACY_TELEMETRY_RAW = ['heartbeat', 'scroll_depth', 'scroll', 'identify'];

/**
 * The canonical type of a stored website event: its raw event name re-mapped when the payload kept one (rows
 * written before 2026-09-30 carry `event`), otherwise the type it was stored with.
 */
export function storedWebsiteEventType(meta: Record<string, unknown>, storedType?: string | null): string {
  const raw = meta['event'];
  if (typeof raw === 'string' && raw.trim()) return mapWebsiteEventType(raw);
  const stored = storedType ?? meta['eventType'];
  return typeof stored === 'string' && stored.startsWith('web.') ? stored : 'web.other';
}

/** Website events of one organization in a window: by the provider's occurrence, else (legacy) by receipt. */
export function websiteEventsInWindow(organizationId: string, start: Date, end: Date): Prisma.IntegrationEventWhereInput {
  return {
    organizationId,
    provider: 'website',
    OR: [{ occurredAt: { gte: start, lte: end } }, { occurredAt: null, receivedAt: { gte: start, lte: end } }],
  };
}

/** Exact per-type counts over a window, with legacy telemetry rows moved out of `web.page_view`. */
export async function websiteEventTypeCounts(prisma: PrismaClient, where: Prisma.IntegrationEventWhereInput): Promise<Map<string, number>> {
  const [groups, legacyTelemetry] = await Promise.all([
    prisma.integrationEvent.groupBy({ by: ['eventType'], where, _count: { _all: true } }),
    prisma.integrationEvent.count({
      where: { AND: [where, { eventType: 'web.page_view' }, { OR: LEGACY_TELEMETRY_RAW.map((e) => ({ payload: { path: ['event'], equals: e } })) }] },
    }),
  ]);
  const counts = new Map<string, number>();
  for (const g of groups) counts.set(g.eventType, (counts.get(g.eventType) ?? 0) + g._count._all);
  if (legacyTelemetry > 0) {
    counts.set('web.page_view', (counts.get('web.page_view') ?? 0) - legacyTelemetry);
    counts.set('web.heartbeat', (counts.get('web.heartbeat') ?? 0) + legacyTelemetry);
  }
  return counts;
}

export interface WebsiteRankedItem {
  label: string;
  count: number;
}

export interface WebsiteAnalytics {
  organizationId: string;
  period: { start: string; end: string };
  totals: {
    events: number;
    /** PAGE_VIEW-class events only. Exact. */
    pageViews: number;
    sessions: number;
    searches: number;
    ctaClicks: number;
    formSubmits: number;
    appointmentRequests: number;
  };
  topLandingPages: WebsiteRankedItem[];
  topSearches: WebsiteRankedItem[];
  topCtas: WebsiteRankedItem[];
  sessionSources: WebsiteRankedItem[];
  topCities: WebsiteRankedItem[];
  topCategories: WebsiteRankedItem[];
  commonJourneys: WebsiteRankedItem[];
  signalBreakdown: WebsiteRankedItem[];
  eventTypeBreakdown: WebsiteRankedItem[];
  /** False when the window held more events than one read scans: rankings and journeys are then partial. Totals never are. */
  rankingsComplete: boolean;
  scannedEvents: number;
}

function str(meta: Record<string, unknown>, key: string): string | undefined {
  const v = meta[key];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/**
 * Whose journey a website event belongs to: the visitor the site reported, or
 * failing that the session. Null when the event carries neither, and then it
 * belongs to no journey.
 */
export function journeyKey(meta: Record<string, unknown>): string | null {
  const visitor = str(meta, 'visitorId');
  if (visitor) return 'visitor:' + visitor;
  const session = str(meta, 'sessionId');
  return session ? 'session:' + session : null;
}

function rank(map: Map<string, number>, limit = 8): WebsiteRankedItem[] {
  return [...map.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

function bump(map: Map<string, number>, key: string | undefined): void {
  if (!key) return;
  map.set(key, (map.get(key) ?? 0) + 1);
}

const WEBSITE_SIGNAL_KEYS = [
  'web_preference', 'research_intent', 'comparison_shopper', 'buying_intent',
  'appointment_intent', 'download_intent', 'returning_visitor', 'highly_engaged',
  'high_value_prospect', 'newsletter_subscriber', 'commercial_buyer',
  'pet_owner', 'caregiver', 'wedding_planning', 'moving_soon', 'website_source',
];

function sum(counts: Map<string, number>, pick: (eventType: string) => boolean): number {
  let n = 0;
  for (const [t, c] of counts) if (pick(t)) n += c;
  return n;
}

export class WebsiteAnalyticsRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly scanLimit: number = WEBSITE_RANKING_SCAN_LIMIT,
  ) {}

  async getWebsiteAnalytics(
    organizationId: string,
    start: Date,
    end: Date,
  ): Promise<WebsiteAnalytics> {
    const where = websiteEventsInWindow(organizationId, start, end);

    // EXACT totals over the whole window.
    const [counts, signalGroups] = await Promise.all([
      websiteEventTypeCounts(this.prisma, where),
      this.prisma.signal.groupBy({
        by: ['key', 'label'],
        where: { organizationId, source: 'signal-registry', createdAt: { gte: start, lte: end }, key: { in: WEBSITE_SIGNAL_KEYS } },
        _count: { _all: true },
      }),
    ]);

    const pages = new Map<string, number>();
    const searches = new Map<string, number>();
    const ctas = new Map<string, number>();
    const sources = new Map<string, number>();
    const cities = new Map<string, number>();
    const categories = new Map<string, number>();
    const eventTypes = new Map<string, number>();
    const journeysByVisitor = new Map<string, string[]>();

    // Rankings and journeys: a keyset-paginated scan in occurrence order, bounded and reported as such.
    let scanned = 0;
    let cursor: { id: string } | undefined;
    while (scanned < this.scanLimit) {
      const page = await this.prisma.integrationEvent.findMany({
        where,
        select: { id: true, eventType: true, payload: true },
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
        take: Math.min(SCAN_PAGE, this.scanLimit - scanned),
        ...(cursor ? { cursor, skip: 1 } : {}),
      });
      if (page.length === 0) break;
      for (const e of page) {
        const raw = (e.payload ?? {}) as Record<string, unknown>;
        const eventType = storedWebsiteEventType(raw, e.eventType);
        const meta = minimizeWebsiteEvent(raw, typeof raw['property'] === 'string' ? (raw['property'] as string) : '') as Record<string, unknown>;
        const cls = websiteEventClass(eventType);
        bump(eventTypes, eventType.replace(/^web\./, ''));
        if (cls === 'TELEMETRY') continue;

        if (eventType.startsWith('web.search')) bump(searches, str(meta, 'zip') ?? str(meta, 'category') ?? str(meta, 'city'));
        if (eventType === 'web.cta_click' || eventType === 'web.phone_click') {
          bump(ctas, str(meta, 'cta') ?? str(meta, 'page') ?? eventType.replace(/^web\./, ''));
        }
        if (cls === 'PAGE_VIEW') bump(pages, str(meta, 'page') ?? str(meta, 'title'));
        bump(sources, str(meta, 'source') ?? str(meta, 'property'));
        bump(cities, str(meta, 'city'));
        bump(categories, str(meta, 'category'));

        const visitor = journeyKey(meta);
        if (visitor) {
          const step = eventType.replace(/^web\./, '');
          const arr = journeysByVisitor.get(visitor) ?? [];
          if (arr[arr.length - 1] !== step) arr.push(step);
          journeysByVisitor.set(visitor, arr);
        }
      }
      scanned += page.length;
      cursor = { id: page[page.length - 1]!.id };
      if (page.length < SCAN_PAGE) break;
    }

    const journeyPatterns = new Map<string, number>();
    for (const steps of journeysByVisitor.values()) {
      if (steps.length < 2) continue;
      bump(journeyPatterns, steps.slice(0, 4).join(' → '));
    }

    const signalMap = new Map<string, number>();
    for (const g of signalGroups) {
      const k = g.label ?? g.key;
      signalMap.set(k, (signalMap.get(k) ?? 0) + g._count._all);
    }

    const events = sum(counts, () => true);
    return {
      organizationId,
      period: { start: start.toISOString(), end: end.toISOString() },
      totals: {
        events,
        pageViews: sum(counts, (t) => websiteEventClass(t) === 'PAGE_VIEW'),
        sessions: counts.get('web.session_start') ?? 0,
        searches: sum(counts, (t) => t.startsWith('web.search')),
        ctaClicks: (counts.get('web.cta_click') ?? 0) + (counts.get('web.phone_click') ?? 0),
        formSubmits: counts.get('web.form_submit') ?? 0,
        appointmentRequests: counts.get('web.appointment_request') ?? 0,
      },
      topLandingPages: rank(pages),
      topSearches: rank(searches),
      topCtas: rank(ctas),
      sessionSources: rank(sources),
      topCities: rank(cities),
      topCategories: rank(categories),
      commonJourneys: rank(journeyPatterns, 6),
      signalBreakdown: rank(signalMap),
      eventTypeBreakdown: rank(eventTypes, 12),
      rankingsComplete: events <= scanned,
      scannedEvents: scanned,
    };
  }
}
