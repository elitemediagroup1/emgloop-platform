// Website evidence state -- what Read Intelligence State reports about one organization's website evidence
// (2026-09-30). READ-ONLY, and COUNTS AND CODES ONLY: how many properties are registered, by lifecycle, by
// ingestion and by admission state (KNOWN_NOT_LIVE / LIVE_INGESTING / LIVE_INGESTION_DISABLED),
// which bindings exist (as counts, never the property keys, ids or domains), how many governed website events
// arrived by event class (exact, over integration_events), when the newest did, the organization's refusal counters, and -- per declared website
// source -- its connection state, its newest stored window's end, finality and quality flags, and its COVERAGE
// VERDICT: a source is expected only for LIVE properties, so an organization whose properties are all OWNED /
// BUILDING / PAUSED / RETIRED sees NOT_APPLICABLE, never a NOT_CONNECTED gap.
//
// It never returns a property key, a domain, a URL, a page path, a visitor or session id, an email, a phone
// number, a payload, a credential or any one visitor's behavior.

import type { PrismaClient } from '@prisma/client';
import {
  INTELLIGENCE_SOURCE_REGISTRY,
  WEB_PROPERTY_ADMISSION_STATES,
  WEB_PROPERTY_LIFECYCLES,
  WEBSITE_EVENT_CLASSES,
  WEBSITE_SOURCE_CONNECTIONS,
  organizationConnectionState,
  webPropertyAdmissionState,
  WEBSITE_COLLECTION_WINDOW_DAYS,
  webPropertyAdmitsTelemetry,
  websiteCollectionVerdict,
  websiteCoverageVerdict,
  websiteEventAgeBucket,
  websiteEventClass,
  type OrganizationConnectionState,
  type WebPropertyAdmissionState,
  type WebPropertyLifecycle,
  type WebsiteCollectionVerdict,
  type WebsiteCoverageVerdict,
  type WebsiteEventAgeBucket,
  type WebsiteEventClass,
} from '@emgloop/shared';
import { websiteEventTypeCounts, websiteEventsInWindow } from '../website-analytics.repository';
import { OrganizationConnectionRepository } from '../organization-connection.repository';
import { SourceMetricWindowRepository } from '../source-metric-window.repository';


export interface WebsiteSourceCoverage {
  readonly sourceId: string;
  readonly stream: string;
  readonly basis: string;
  readonly connection: OrganizationConnectionState;
  /** Whether its absence is a gap, given the registry: NOT_APPLICABLE while no property is LIVE. */
  readonly coverage: WebsiteCoverageVerdict;
  readonly newestWindowEnd: Date | null;
  readonly finality: string | null;
  readonly sampled: boolean | null;
  readonly thresholded: boolean | null;
  readonly rolledUp: boolean | null;
  readonly truncated: boolean | null;
}

export interface WebsiteEvidenceState {
  readonly properties: {
    readonly total: number;
    readonly byLifecycle: Readonly<Record<WebPropertyLifecycle, number>>;
    readonly byAdmission: Readonly<Record<Exclude<WebPropertyAdmissionState, 'UNREGISTERED'>, number>>;
    /** Stored values outside the vocabulary (never admitting). */
    readonly unrecognized: number;
    readonly ga4Bound: number;
    readonly searchConsoleBound: number;
    readonly bingBound: number;
    readonly clarityBound: number;
  };
  readonly events: {
    readonly total: number;
    readonly byClass: Readonly<Record<WebsiteEventClass, number>>;
    readonly newestAt: Date | null;
  };
  /** The organization's refusal counters (codes -> counts), or null when it has no website connection yet. */
  readonly refusals: Readonly<Record<string, number>> | null;
  readonly sources: readonly WebsiteSourceCoverage[];
  /**
   * Per registered property: is its tracker actually delivering? Exact counts over the last
   * WEBSITE_COLLECTION_WINDOW_DAYS of admitted events, the newest event's age as a bucket, and a verdict.
   * Ordered by key. Never an id, URL, payload or person.
   */
  readonly collection: readonly WebsiteCollection[];
}

export interface WebsiteCollection {
  readonly key: string;
  readonly lifecycle: string;
  readonly ingestion: string;
  readonly events: number;
  /** Sessions STARTED in the window (the tracker's session_start events). */
  readonly sessions: number;
  readonly pageViews: number;
  readonly lastEventAge: WebsiteEventAgeBucket;
  readonly verdict: WebsiteCollectionVerdict;
}

function flag(quality: Readonly<Record<string, unknown>>, key: string): boolean | null {
  const v = quality[key];
  return typeof v === 'boolean' ? v : null;
}

export class WebsiteEvidenceStateRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async read(organizationId: string, since: Date, now: Date): Promise<WebsiteEvidenceState> {
    const props = await this.prisma.webProperty.findMany({
      where: { organizationId },
      select: { key: true, lifecycle: true, ingestion: true, ga4PropertyId: true, searchConsoleSiteUrl: true, bingSiteUrl: true, clarityProjectId: true },
    });
    const byLifecycle = Object.fromEntries(WEB_PROPERTY_LIFECYCLES.map((l) => [l, 0])) as Record<WebPropertyLifecycle, number>;
    const byAdmission = Object.fromEntries(WEB_PROPERTY_ADMISSION_STATES.filter((a) => a !== 'UNREGISTERED').map((a) => [a, 0])) as Record<Exclude<WebPropertyAdmissionState, 'UNREGISTERED'>, number>;
    let unrecognized = 0;
    for (const p of props) {
      if ((WEB_PROPERTY_LIFECYCLES as readonly string[]).includes(p.lifecycle)) byLifecycle[p.lifecycle as WebPropertyLifecycle]++;
      else unrecognized++;
      const a = webPropertyAdmissionState(p);
      if (a !== 'UNREGISTERED') byAdmission[a]++;
    }
    const properties = {
      total: props.length,
      byLifecycle,
      byAdmission,
      unrecognized,
      ga4Bound: props.filter((p) => p.ga4PropertyId).length,
      searchConsoleBound: props.filter((p) => p.searchConsoleSiteUrl).length,
      bingBound: props.filter((p) => p.bingSiteUrl).length,
      clarityBound: props.filter((p) => p.clarityProjectId).length,
    };
    const liveProperties = byLifecycle.LIVE;
    const liveIngestingProperties = byAdmission.LIVE_INGESTING;

    const where = websiteEventsInWindow(organizationId, since, now);
    const [counts, newest] = await Promise.all([
      websiteEventTypeCounts(this.prisma, where),
      this.prisma.integrationEvent.findFirst({ where: { organizationId, provider: 'website', occurredAt: { not: null, lte: now } }, select: { occurredAt: true }, orderBy: { occurredAt: 'desc' } }),
    ]);
    const byClass = Object.fromEntries(WEBSITE_EVENT_CLASSES.map((c) => [c, 0])) as Record<WebsiteEventClass, number>;
    let total = 0;
    for (const [eventType, n] of counts) {
      byClass[websiteEventClass(eventType)] += n;
      total += n;
    }

    const website = await this.prisma.providerConnection.findFirst({
      where: { organizationId, category: 'INGESTION', provider: 'website' },
      select: { config: true },
    });
    let refusals: Record<string, number> | null = null;
    if (website) {
      refusals = {};
      const raw = (website.config as Record<string, unknown> | null)?.['refusalCounts'];
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const [k, v] of Object.entries(raw)) if (typeof v === 'number' && Number.isFinite(v)) refusals[k] = v;
      }
    }

    const declared = INTELLIGENCE_SOURCE_REGISTRY.filter((s) => s.domains.includes('WEBSITE'));
    const external = declared.filter((s) => WEBSITE_SOURCE_CONNECTIONS[s.sourceId]);
    const states = await new OrganizationConnectionRepository(this.prisma).states(organizationId, external.map((s) => WEBSITE_SOURCE_CONNECTIONS[s.sourceId]!), now);
    const newestWindows = await new SourceMetricWindowRepository(this.prisma).newestBySource(organizationId, external.map((s) => s.sourceId));
    const sources: WebsiteSourceCoverage[] = declared.map((s) => {
      if (!WEBSITE_SOURCE_CONNECTIONS[s.sourceId]) {
        // First-party: "connected" means governed events have actually arrived for this organization.
        const connection: OrganizationConnectionState = newest ? 'CONNECTED' : 'NOT_CONNECTED';
        const coverage = websiteCoverageVerdict({ firstParty: true, liveProperties, liveIngestingProperties, connection, hasRecentEvidence: total > 0 });
        return { sourceId: s.sourceId, stream: s.stream, basis: s.basis, connection, coverage, newestWindowEnd: newest?.occurredAt ?? null, finality: null, sampled: null, thresholded: null, rolledUp: null, truncated: null };
      }
      const w = newestWindows.get(s.sourceId) ?? null;
      const connection = states.get(WEBSITE_SOURCE_CONNECTIONS[s.sourceId]!.provider) ?? organizationConnectionState(null, now);
      return {
        sourceId: s.sourceId,
        stream: s.stream,
        basis: s.basis,
        connection,
        coverage: websiteCoverageVerdict({ firstParty: false, liveProperties, liveIngestingProperties, connection, hasRecentEvidence: w !== null }),
        newestWindowEnd: w?.windowEnd ?? null,
        finality: w?.finality ?? null,
        sampled: w ? (typeof w.quality['sampledPercent'] === 'number' ? true : flag(w.quality, 'sampled')) : null,
        thresholded: w ? flag(w.quality, 'thresholded') : null,
        rolledUp: w ? flag(w.quality, 'rolledUp') : null,
        truncated: w ? flag(w.quality, 'truncated') : null,
      };
    });

    // Collection health, per property. Only LIVE + ENABLED properties are counted (the verdict for anything else is
    // NOT_APPLICABLE); a property's events are the admitted events bound to its key.
    const windowStart = new Date(now.getTime() - WEBSITE_COLLECTION_WINDOW_DAYS * 86_400_000);
    const collection: WebsiteCollection[] = [];
    for (const p of [...props].sort((a, b) => a.key.localeCompare(b.key))) {
      if (!webPropertyAdmitsTelemetry(p)) {
        collection.push({ key: p.key, lifecycle: p.lifecycle, ingestion: p.ingestion, events: 0, sessions: 0, pageViews: 0, lastEventAge: 'NEVER', verdict: 'NOT_APPLICABLE' });
        continue;
      }
      const ofProperty = { organizationId, provider: 'website', payload: { path: ['property'], equals: p.key } } as const;
      const [counts, newestRow] = await Promise.all([
        websiteEventTypeCounts(this.prisma, { AND: [websiteEventsInWindow(organizationId, windowStart, now), ofProperty] }),
        this.prisma.integrationEvent.findFirst({ where: { ...ofProperty, occurredAt: { not: null, lte: now } }, select: { occurredAt: true }, orderBy: { occurredAt: 'desc' } }),
      ]);
      let events = 0;
      let pageViews = 0;
      for (const [eventType, n] of counts) {
        events += n;
        if (websiteEventClass(eventType) === 'PAGE_VIEW') pageViews += n;
      }
      const sessions = counts.get('web.session_start') ?? 0;
      const newestAt = newestRow?.occurredAt ?? null;
      collection.push({
        key: p.key,
        lifecycle: p.lifecycle,
        ingestion: p.ingestion,
        events,
        sessions,
        pageViews,
        lastEventAge: websiteEventAgeBucket(newestAt, now),
        verdict: websiteCollectionVerdict({ lifecycle: p.lifecycle, ingestion: p.ingestion, events, pageViews, newestAt, now }),
      });
    }

    return {
      collection,
      properties,
      events: { total, byClass, newestAt: newest?.occurredAt ?? null },
      refusals,
      sources,
    };
  }
}
