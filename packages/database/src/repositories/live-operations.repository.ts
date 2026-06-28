// LiveOperationsRepository — Sprint 15 (Live Operations, Traffic & Revenue Intelligence).
//
// Turns the platform into a LIVE operating system. This repository does NOT
// introduce a new persistence model: it reads the events that already flow
// through the existing pipeline (IntegrationEvent + Interaction + Booking) and
// projects them into real-time operational views.
//
// No websockets — the API routes that wrap this repository are polled by the
// client every 5–10s. Everything here is deterministic and read-only.

import type { PrismaClient, Prisma } from '@prisma/client';

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
  label: string;
  detail: string | null;
  customerId: string | null;
  status: string | null;
  at: string; // ISO timestamp, newest-first ordering key
}

export interface LiveCallRow {
  id: string;
  vendor: string | null;
  source: string | null;
  campaign: string | null;
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
  website: string | null;
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
  customerId: string | null;
  customerName: string | null;
  events: LiveWebsiteRow[];
  lastAt: string;
}

const CALL_EVENT_PREFIXES = ['call.', 'callgrid.'];
const WEBSITE_EVENT_PREFIX = 'web.';

type CustomerNameShape = { firstName: string | null; lastName: string | null; email: string | null; phone: string | null } | null;

function nameOf(c: CustomerNameShape): string | null {
  if (!c) return null;
  const n = [c.firstName, c.lastName].filter(Boolean).join(' ').trim();
  return n || c.email || c.phone || null;
}

export class LiveOperationsRepository {
  constructor(private readonly prisma: PrismaClient) {}

  // Unified live activity feed — newest first across all senses.
  async listLiveActivity(organizationId: string, limit = 40): Promise<LiveActivityItem[]> {
    const [events, interactions, bookings, customers] = await Promise.all([
      this.prisma.integrationEvent.findMany({
        where: { organizationId },
        orderBy: { receivedAt: 'desc' },
        take: limit,
      }),
      this.prisma.interaction.findMany({
        where: { organizationId },
        orderBy: { occurredAt: 'desc' },
        take: limit,
        include: { customer: { select: { firstName: true, lastName: true, email: true, phone: true } } },
      }),
      this.prisma.booking.findMany({
        where: { organizationId },
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
      this.prisma.customer.findMany({
        where: { organizationId },
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
    ]);

    const items: LiveActivityItem[] = [];

    for (const e of events) {
      const et = e.eventType ?? '';
      const kind: LiveActivityKind = et.startsWith(WEBSITE_EVENT_PREFIX)
        ? 'website'
        : CALL_EVENT_PREFIXES.some((p) => et.startsWith(p))
          ? 'call'
          : 'integration';
      items.push({
        id: 'evt:' + e.id,
        kind,
        provider: e.provider ?? null,
        eventType: e.eventType ?? null,
        label: e.eventType ?? 'Event received',
        detail: e.provider ? 'via ' + e.provider : null,
        customerId: null,
        status: e.status ?? null,
        at: e.receivedAt.toISOString(),
      });
    }

    for (const i of interactions) {
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
        label: i.summary ?? i.kind,
        detail: nameOf(i.customer),
        customerId: i.customerId ?? null,
        status: null,
        at: i.occurredAt.toISOString(),
      });
    }

    for (const b of bookings) {
      items.push({
        id: 'bk:' + b.id,
        kind: 'booking',
        provider: b.calendarProvider ?? null,
        eventType: 'booking.' + String(b.status).toLowerCase(),
        label: b.title ?? 'Booking ' + String(b.status).toLowerCase(),
        detail: null,
        customerId: b.customerId ?? null,
        status: String(b.status),
        at: b.createdAt.toISOString(),
      });
    }

    for (const c of customers) {
      items.push({
        id: 'cust:' + c.id,
        kind: 'customer',
        provider: null,
        eventType: 'customer.created',
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

  // Live call feed — every PHONE interaction, attribution-enriched. Newest first.
  async listLiveCalls(organizationId: string, limit = 50): Promise<LiveCallRow[]> {
    const rows = await this.prisma.interaction.findMany({
      where: { organizationId, channel: 'PHONE' },
      orderBy: { occurredAt: 'desc' },
      take: limit,
      include: {
        customer: {
          select: { firstName: true, lastName: true, email: true, phone: true, metadata: true },
        },
      },
    });

    return rows.map((i) => {
      const md = i.metadata;
      const qualifiedRaw = jsonVal(md, 'qualified');
      const durRaw = jsonVal(md, 'durationSeconds');
      const custMeta = i.customer ? i.customer.metadata : null;
      return {
        id: i.id,
        vendor: jsonVal(md, 'vendor'),
        source: jsonVal(md, 'source'),
        campaign: jsonVal(md, 'campaign'),
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

  // Live website feed — website interactions, grouped into sessions. Newest first.
  async listLiveWebsiteActivity(organizationId: string, limit = 60): Promise<LiveWebsiteSession[]> {
    const rows = await this.prisma.interaction.findMany({
      where: { organizationId, provider: 'website' },
      orderBy: { occurredAt: 'desc' },
      take: limit,
      include: { customer: { select: { firstName: true, lastName: true, email: true, phone: true } } },
    });

    const flat: LiveWebsiteRow[] = rows.map((i) => {
      const md = i.metadata;
      const et = jsonVal(md, 'eventType');
      return {
        id: i.id,
        website: jsonVal(md, 'property') ?? jsonVal(md, 'website'),
        sessionId: jsonVal(md, 'sessionId'),
        customerId: i.customerId ?? null,
        customerName: nameOf(i.customer),
        eventType: et,
        label: i.summary ?? et ?? 'Website activity',
        journeyStage: jsonVal(md, 'journeyStage') ?? jsonVal(md, 'intent'),
        at: i.occurredAt.toISOString(),
      };
    });

    const groups = new Map<string, LiveWebsiteSession>();
    for (const r of flat) {
      const key = r.sessionId ?? r.customerId ?? r.id;
      const existing = groups.get(key);
      if (existing) {
        existing.events.push(r);
        if (r.at > existing.lastAt) existing.lastAt = r.at;
      } else {
        groups.set(key, {
          sessionKey: key,
          website: r.website,
          customerId: r.customerId,
          customerName: r.customerName,
          events: [r],
          lastAt: r.at,
        });
      }
    }

    return Array.from(groups.values()).sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0));
  }
}
