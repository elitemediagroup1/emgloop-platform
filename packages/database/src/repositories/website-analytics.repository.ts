// WebsiteAnalyticsRepository — Sprint 14 (Website Intelligence).
//
// Read-only website analytics computed ENTIRELY from real Brain events in Neon
// (Interaction + Signal rows whose eventType is web.*). No embedded GA reports,
// no third-party SDK — every widget is derived from the same events the Brain
// already ingested through the WebsiteProvider. Org-scoped and read-only.
//
// It does NOT change the existing AnalyticsRepository; it is an additive sibling
// so the Analytics page can render website widgets alongside the core dashboard.

import type { PrismaClient } from '@prisma/client';

export interface WebsiteRankedItem {
  label: string;
  count: number;
}

export interface WebsiteAnalytics {
  organizationId: string;
  period: { start: string; end: string };
  totals: {
    events: number;
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
}

function str(meta: Record<string, unknown>, key: string): string | undefined {
  const v = meta[key];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
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

export class WebsiteAnalyticsRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async getWebsiteAnalytics(
    organizationId: string,
    start: Date,
    end: Date,
  ): Promise<WebsiteAnalytics> {
    // Pull website interactions (provider 'website') and website signals in range.
    const [interactions, signals] = await Promise.all([
      this.prisma.interaction.findMany({
        where: { organizationId, provider: 'website', occurredAt: { gte: start, lte: end } },
        select: { customerId: true, occurredAt: true, metadata: true },
        orderBy: { occurredAt: 'asc' },
        take: 5000,
      }),
      this.prisma.signal.findMany({
        where: {
          organizationId,
          source: 'signal-registry',
          createdAt: { gte: start, lte: end },
          key: { in: [
            'web_preference', 'research_intent', 'comparison_shopper', 'buying_intent',
            'appointment_intent', 'download_intent', 'returning_visitor', 'highly_engaged',
            'high_value_prospect', 'newsletter_subscriber', 'commercial_buyer',
            'pet_owner', 'caregiver', 'wedding_planning', 'moving_soon', 'website_source',
          ] },
        },
        select: { key: true, label: true },
        take: 5000,
      }),
    ]);

    const pages = new Map<string, number>();
    const searches = new Map<string, number>();
    const ctas = new Map<string, number>();
    const sources = new Map<string, number>();
    const cities = new Map<string, number>();
    const categories = new Map<string, number>();
    const eventTypes = new Map<string, number>();
    const journeysByCustomer = new Map<string, string[]>();

    let sessions = 0;
    let searchCount = 0;
    let ctaCount = 0;
    let formSubmits = 0;
    let appointmentRequests = 0;

    for (const i of interactions) {
      const meta = (i.metadata ?? {}) as Record<string, unknown>;
      const eventType = str(meta, 'eventType') ?? 'web.page_view';
      bump(eventTypes, eventType.replace(/^web\./, ''));

      if (eventType === 'web.session_start') sessions++;
      if (eventType.startsWith('web.search')) {
        searchCount++;
        bump(searches, str(meta, 'query') ?? str(meta, 'category') ?? str(meta, 'city'));
      }
      if (eventType === 'web.cta_click' || eventType === 'web.phone_click') {
        ctaCount++;
        bump(ctas, str(meta, 'cta') ?? str(meta, 'page') ?? eventType.replace(/^web\./, ''));
      }
      if (eventType === 'web.form_submit') formSubmits++;
      if (eventType === 'web.appointment_request') appointmentRequests++;

      if (eventType === 'web.page_view' || eventType === 'web.guide_view') {
        bump(pages, str(meta, 'page') ?? str(meta, 'title'));
      }
      bump(sources, str(meta, 'source') ?? str(meta, 'property'));
      bump(cities, str(meta, 'city'));
      bump(categories, str(meta, 'category'));

      // Build per-customer journeys from the event-type sequence.
      if (i.customerId) {
        const step = eventType.replace(/^web\./, '');
        const arr = journeysByCustomer.get(i.customerId) ?? [];
        if (arr[arr.length - 1] !== step) arr.push(step);
        journeysByCustomer.set(i.customerId, arr);
      }
    }

    // Summarize the most common 3-step journey patterns.
    const journeyPatterns = new Map<string, number>();
    for (const steps of journeysByCustomer.values()) {
      if (steps.length < 2) continue;
      const pattern = steps.slice(0, 4).join(' → ');
      bump(journeyPatterns, pattern);
    }

    // Website signal breakdown (by label).
    const signalMap = new Map<string, number>();
    for (const s of signals) {
      bump(signalMap, s.label ?? s.key);
    }

    return {
      organizationId,
      period: { start: start.toISOString(), end: end.toISOString() },
      totals: {
        events: interactions.length,
        sessions,
        searches: searchCount,
        ctaClicks: ctaCount,
        formSubmits,
        appointmentRequests,
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
    };
  }
}
