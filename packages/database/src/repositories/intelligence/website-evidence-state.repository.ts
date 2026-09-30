// Website evidence state -- what Read Intelligence State reports about one organization's website evidence
// (2026-09-30). READ-ONLY, and COUNTS AND CODES ONLY: how many properties are registered and in which status,
// which bindings exist (as counts, never the property keys, ids or domains), how many governed website events
// arrived by event class (exact, over integration_events), when the newest did, the organization's refusal counters, and -- per declared website
// source -- its connection state and its newest stored window's end, finality and quality flags.
//
// It never returns a property key, a domain, a URL, a page path, a visitor or session id, an email, a phone
// number, a payload, a credential or any one visitor's behavior.

import type { PrismaClient } from '@prisma/client';
import {
  INTELLIGENCE_SOURCE_REGISTRY,
  WEBSITE_EVENT_CLASSES,
  WEBSITE_SOURCE_CONNECTIONS,
  organizationConnectionState,
  websiteEventClass,
  type OrganizationConnectionState,
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
    readonly active: number;
    readonly disabled: number;
    readonly withoutDomains: number;
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
      select: { status: true, allowedDomains: true, ga4PropertyId: true, searchConsoleSiteUrl: true, bingSiteUrl: true, clarityProjectId: true },
    });
    const properties = {
      total: props.length,
      active: props.filter((p) => p.status === 'ACTIVE').length,
      disabled: props.filter((p) => p.status !== 'ACTIVE').length,
      withoutDomains: props.filter((p) => p.allowedDomains.length === 0).length,
      ga4Bound: props.filter((p) => p.ga4PropertyId).length,
      searchConsoleBound: props.filter((p) => p.searchConsoleSiteUrl).length,
      bingBound: props.filter((p) => p.bingSiteUrl).length,
      clarityBound: props.filter((p) => p.clarityProjectId).length,
    };

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
        return { sourceId: s.sourceId, stream: s.stream, basis: s.basis, connection, newestWindowEnd: newest?.occurredAt ?? null, finality: null, sampled: null, thresholded: null, rolledUp: null, truncated: null };
      }
      const w = newestWindows.get(s.sourceId) ?? null;
      return {
        sourceId: s.sourceId,
        stream: s.stream,
        basis: s.basis,
        connection: states.get(WEBSITE_SOURCE_CONNECTIONS[s.sourceId]!.provider) ?? organizationConnectionState(null, now),
        newestWindowEnd: w?.windowEnd ?? null,
        finality: w?.finality ?? null,
        sampled: w ? (typeof w.quality['sampledPercent'] === 'number' ? true : flag(w.quality, 'sampled')) : null,
        thresholded: w ? flag(w.quality, 'thresholded') : null,
        rolledUp: w ? flag(w.quality, 'rolledUp') : null,
        truncated: w ? flag(w.quality, 'truncated') : null,
      };
    });

    return {
      properties,
      events: { total, byClass, newestAt: newest?.occurredAt ?? null },
      refusals,
      sources,
    };
  }
}
