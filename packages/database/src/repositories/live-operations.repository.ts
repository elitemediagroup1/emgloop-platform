// LiveOperationsRepository — Sprint 15 (Live Operations, Traffic & Revenue Intelligence).
//
// Turns the platform into a LIVE operating system. This repository does NOT
// introduce a new persistence model: it reads the events that already flow
// through the existing pipeline (IntegrationEvent + Interaction + Booking) and
// projects them into real-time operational views.
//
// Sprint 15 real-data hotfix:
//  - Active views are time-windowed (recent only) so 'live' means live.
//  - Demo / QA / E2E / test records are filtered OUT of active views (never
//    deleted) via operational-filters.isExcludedCustomer / isExcludedExternalId.
//  - Fabricated attribution labels (e.g. 'Vendor A') are shown honestly as
//    missing (null) rather than as a fake partner.
//  - Rows carry traceability: provider, externalId, processed time.
//
// No websockets — the API routes that wrap this repository are polled by the
// client every 5-10s. Everything here is deterministic and read-only.

import type { PrismaClient, Prisma } from '@prisma/client';
import {
  isExcludedCustomer,
  isExcludedExternalId,
  realAttr,
  propertyNameOf,
  propertyKeyOf,
  since,
  LIVE_ACTIVITY_WINDOW_MS,
  LIVE_CALLS_WINDOW_MS,
  LIVE_WEBSITE_WINDOW_MS,
} from './operational-filters';

function jsonVal(value: Prisma.JsonValue | null | undefined, key: string): string | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const v = (value as Record<string, unknown>)[key];
    if (v === null || v === undefined) return null;
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  }
  return null;
}

export type LiveActivityKind = 'website' | 'call' | 'workflow' | 'customer' | 'booking' | 'integration';

export interface LiveActivityItem {
  id: string;
  kind: LiveActivityKind;
  provider: string | null;
  eventType: string | null;
  externalId: string | null;
  label: string;
  detail: string | null;
  customerId: string | null;
  status: string | null;
  at: string; // ISO timestamp, newest-first ordering key
}

export interface LiveCallRow {
  id: string;
  provider: string | null;
  externalId: string | null;
  vendor: string | null;
  source: string | null;
  campaign: string | null;
  buyer: string | null;
  attributionMissing: boolean;
  caller: string | null;
  customerId: string | null;
  customerName: string | null;
  status: string | null;
  durationSeconds: number | null;
  qualified: boolean | null;
  assignedAi: string | null;
  assignedHuman: string | null;
  nextBestAction: string | null;
  at: string;
}

export interface LiveWebsiteRow {
  id: string;
  provider: string | null;
  externalId: string | null;
  website: string | null;
  propertyKey: string | null;
  sessionId: string | null;
  customerId: string | null;
  customerName: string | null;
  eventType: string | null;
  label: string;
  journeyStage: string | null;
  at: string;
}

export interface LiveWebsiteSession {
  sessionKey: string;
  website: string | null;
  propertyKey: string | null;
  customerId: string | null;
  customerName: string | null;
  events: LiveWebsiteRow[];
  lastAt: string;
}

const CALL_EVENT_PREFIXES = ['call.', 'callgrid.'];
const WEBSITE_EVENT_PREFIX = 'web.';

type CustomerNameShape = {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  tags?: string[];
  externalId?: string | null;
} | null;

function nameOf(c: CustomerNameShape): string | null {
  if (!c) return null;
  const n = [c.firstName, c.lastName].filter(Boolean).join(' ').trim();
  return n || c.email || c.phone || null;
}

// Customer columns needed to BOTH name a record and decide if it is test data.
const CUSTOMER_SELECT = {
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
  tags: true,
  externalId: true,
} as const;

export class LiveOperationsRepository {
  constructor(private readonly prisma: PrismaClient) {}

  // Unified live activity feed — newest first across all senses. Last 24h.
  async listLiveActivity(organizationId: string, limit = 40): Promise<LiveActivityItem[]> {
    const cutoff = since(LIVE_ACTIVITY_WINDOW_MS);
    const [events, interactions, bookings, customers] = await Promise.all([
      this.prisma.integrationEvent.findMany({
        where: { organizationId, receivedAt: { gte: cutoff } },
        orderBy: { receivedAt: 'desc' },
        take: limit * 2,
      }),
      this.prisma.interaction.findMany({
        where: { organizationId, occurredAt: { gte: cutoff } },
        orderBy: { occurredAt: 'desc' },
        take: limit * 2,
        include: { customer: { select: CUSTOMER_SELECT } },
      }),
      this.prisma.booking.findMany({
        where: { organizationId, createdAt: { gte: cutoff } },
        orderBy: { createdAt: 'desc' },
        take: limit,
        include: { customer: { select: CUSTOMER_SELECT } },
      }),
      this.prisma.customer.findMany({
        where: { organizationId, createdAt: { gte: cutoff } },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: { id: true, createdAt: true, ...CUSTOMER_SELECT },
      }),
    ]);

    const items: LiveActivityItem[] = [];

    for (const e of events) {
      if (isExcludedExternalId(e.externalId)) continue;
      const et = e.eventType ?? '';
      const kind: LiveActivityKind = et.startsWith(WEBSITE_EVENT_PREFIX)
        ? 'website'
        : CALL_EVENT_PREFIXES.some((pre) => et.startsWith(pre))
          ? 'call'
          : 'integration';
      items.push({
        id: 'evt:' + e.id,
        kind,
        provider: e.provider ?? null,
        eventType: e.eventType ?? null,
        externalId: e.externalId ?? null,
        label: e.eventType ?? 'Event received',
        detail: e.provider ? 'via ' + e.provider : null,
        customerId: null,
        status: e.status ?? null,
        at: e.receivedAt.toISOString(),
      });
    }

    for (const i of interactions) {
      if (isExcludedCustomer(i.customer)) continue;
      if (isExcludedExternalId(i.externalId)) continue;
      const et = jsonVal(i.metadata, 'eventType') ?? '';
      const kind: LiveActivityKind = et.startsWith(WEBSITE_EVENT_PREFIX)
        ? 'website'
        : i.channel === 'PHONE'
          ? 'call'
          : 'integration';
      items.push({
        id: 'int:' + i.id,
        kind,
        provider: i.provider ?? null,
        eventType: et || i.kind,
        externalId: i.externalId ?? null,
        label: i.summary ?? i.kind,
        detail: nameOf(i.customer),
        customerId: i.customerId ?? null,
        status: null,
        at: i.occurredAt.toISOString(),
      });
    }

    for (const b of bookings) {
      if (isExcludedCustomer(b.customer)) continue;
      items.push({
        id: 'bk:' + b.id,
        kind: 'booking',
        provider: b.calendarProvider ?? null,
        eventType: 'booking.' + String(b.status).toLowerCase(),
        externalId: b.calendarEventId ?? null,
        label: b.title ?? 'Booking ' + String(b.status).toLowerCase(),
        detail: null,
        customerId: b.customerId ?? null,
        status: String(b.status),
        at: b.createdAt.toISOString(),
      });
    }

    for (const c of customers) {
      if (isExcludedCustomer(c)) continue;
      items.push({
        id: 'cust:' + c.id,
        kind: 'customer',
        provider: null,
        eventType: 'customer.created',
        externalId: c.externalId ?? null,
        label: 'Customer created: ' + (nameOf(c) ?? 'New lead'),
        detail: (c.tags ?? []).join(', ') || null,
        customerId: c.id,
        status: null,
        at: c.createdAt.toISOString(),
      });
    }

    items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    return items.slice(0, limit);
  }

  // Live call feed — every recent PHONE interaction, attribution-enriched.
  async listLiveCalls(organizationId: string, limit = 50): Promise<LiveCallRow[]> {
    const cutoff = since(LIVE_CALLS_WINDOW_MS);
    const rows = await this.prisma.interaction.findMany({
      where: { organizationId, channel: 'PHONE', occurredAt: { gte: cutoff } },
      orderBy: { occurredAt: 'desc' },
      take: limit * 2,
      include: {
        customer: {
          select: { ...CUSTOMER_SELECT, metadata: true },
        },
      },
    });

    return rows
      .filter((i) => !isExcludedCustomer(i.customer) && !isExcludedExternalId(i.externalId))
      .slice(0, limit)
      .map((i) => {
        const md = i.metadata;
        const qualifiedRaw = jsonVal(md, 'qualified');
        const durRaw = jsonVal(md, 'durationSeconds');
        const custMeta = i.customer ? i.customer.metadata : null;
        const vendor = realAttr(jsonVal(md, 'vendor'));
        const source = realAttr(jsonVal(md, 'source'));
        const campaign = realAttr(jsonVal(md, 'campaign'));
        const buyer = realAttr(jsonVal(md, 'buyer'));
        return {
          id: i.id,
          provider: i.provider ?? null,
          externalId: i.externalId ?? null,
          vendor,
          source,
          campaign,
          buyer,
          attributionMissing: !vendor && !source && !campaign,
          caller: jsonVal(md, 'fromNumber') ?? jsonVal(md, 'caller') ?? (i.customer ? i.customer.phone : null),
          customerId: i.customerId ?? null,
          customerName: nameOf(i.customer),
          status: jsonVal(md, 'callStatus') ?? jsonVal(md, 'eventType') ?? i.kind,
          durationSeconds: durRaw !== null ? Number(durRaw) : null,
          qualified: qualifiedRaw === null ? null : qualifiedRaw === 'true',
          assignedAi: jsonVal(custMeta, 'assignedAiName'),
          assignedHuman: jsonVal(custMeta, 'assignedHumanName'),
          nextBestAction: jsonVal(md, 'nextBestAction') ?? jsonVal(md, 'recommendation'),
          at: i.occurredAt.toISOString(),
        };
      });
  }

  // Live website feed — recent website interactions grouped into sessions.
  // Optional propertyKey filters to a single EMG property.
  async listLiveWebsiteActivity(
    organizationId: string,
    limit = 60,
    propertyKey?: string | null,
  ): Promise<LiveWebsiteSession[]> {
    const cutoff = since(LIVE_WEBSITE_WINDOW_MS);
    const rows = await this.prisma.interaction.findMany({
      where: { organizationId, provider: 'website', occurredAt: { gte: cutoff } },
      orderBy: { occurredAt: 'desc' },
      take: limit * 2,
      include: { customer: { select: CUSTOMER_SELECT } },
    });

    const flat: LiveWebsiteRow[] = rows
      .filter((i) => !isExcludedCustomer(i.customer) && !isExcludedExternalId(i.externalId))
      .map((i) => {
        const md = i.metadata;
        const et = jsonVal(md, 'eventType');
        const rawSite = jsonVal(md, 'property') ?? jsonVal(md, 'website');
        return {
          id: i.id,
          provider: i.provider ?? null,
          externalId: i.externalId ?? null,
          website: propertyNameOf(rawSite) ?? rawSite,
          propertyKey: propertyKeyOf(rawSite),
          sessionId: jsonVal(md, 'sessionId'),
          customerId: i.customerId ?? null,
          customerName: nameOf(i.customer),
          eventType: et,
          label: i.summary ?? et ?? 'Website activity',
          journeyStage: jsonVal(md, 'journeyStage') ?? jsonVal(md, 'intent'),
          at: i.occurredAt.toISOString(),
        };
      });

    const filtered = propertyKey ? flat.filter((r) => r.propertyKey === propertyKey) : flat;

    const groups = new Map<string, LiveWebsiteSession>();
    for (const r of filtered) {
      const key = r.sessionId ?? r.customerId ?? r.id;
      const existing = groups.get(key);
      if (existing) {
        existing.events.push(r);
        if (r.at > existing.lastAt) existing.lastAt = r.at;
      } else {
        groups.set(key, {
          sessionKey: key,
          website: r.website,
          propertyKey: r.propertyKey,
          customerId: r.customerId,
          customerName: r.customerName,
          events: [r],
          lastAt: r.at,
        });
      }
    }

    return Array.from(groups.values())
      .sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0))
      .slice(0, limit);
  }
}
