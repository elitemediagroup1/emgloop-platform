// WebsiteJourneyRepository -- anonymous visitor journeys from Loop's governed first-party website events
// (2026-10-05). READ-ONLY.
//
// SOURCE: integration_events (provider 'website') -- the complete record of every ADMITTED website event, one row
// per event, minimized at ingestion. Not interactions: page views and session starts never become Interactions,
// which is why the old Live Website Feed could not show a journey. Every payload is read back through
// `minimizeWebsiteEvent`, so a legacy row holding a full URL, a query string or a contact detail contributes only
// minimized attributes.
//
// TENANT-FIRST: every method takes `organizationId` first and every query is scoped by it; a session or visitor of
// another organization is not-found. Anonymous stays anonymous: nothing here creates or matches a Person.
//
// BOUNDED: the session list scans at most JOURNEY_SCAN_LIMIT events of the window and says so (`complete`); one
// session reads at most JOURNEY_SESSION_EVENT_LIMIT events.

import type { Prisma, PrismaClient } from '@prisma/client';
import { buildJourneySession, isWebPropertyKey, minimizeWebsiteEvent, type JourneyEvent, type JourneySession } from '@emgloop/shared';
import { storedWebsiteEventType, websiteEventsInWindow } from './website-analytics.repository';

export const JOURNEY_SCAN_LIMIT = 20_000;
export const JOURNEY_SESSION_EVENT_LIMIT = 2_000;
/** How far back a visitor's earlier sessions are looked for (new vs returning). */
export const JOURNEY_VISITOR_LOOKBACK_DAYS = 90;
const PAGE = 2_000;
const ID = /^[A-Za-z0-9._:-]{1,64}$/;

export interface JourneySessionSummary extends Omit<JourneySession, 'steps'> {
  readonly propertyKey: string;
  readonly sessionId: string;
  readonly visitorId: string | null;
  /** RETURNING: the same browser has an event on this property before this session (within the lookback). */
  readonly visitor: 'NEW' | 'RETURNING' | 'UNKNOWN';
}

export interface JourneySessionList {
  readonly sessions: readonly JourneySessionSummary[];
  /** False when the window held more events than one read scans: older sessions in it are not listed. */
  readonly complete: boolean;
  readonly scannedEvents: number;
  /** Events in the window that carried no session id (they belong to no journey). */
  readonly withoutSession: number;
}

export interface JourneyVisitorSession {
  readonly sessionId: string;
  readonly startedAt: Date;
  readonly eventCount: number;
}

export interface JourneySessionDetail {
  readonly propertyKey: string;
  readonly sessionId: string;
  readonly visitorId: string | null;
  readonly visitor: 'NEW' | 'RETURNING' | 'UNKNOWN';
  readonly journey: JourneySession;
  /** Every session of the same browser on this property within the lookback, newest first (this one included). */
  readonly visitorSessions: readonly JourneyVisitorSession[];
  readonly truncated: boolean;
}

interface Row {
  readonly id: string;
  readonly eventType: string;
  readonly occurredAt: Date | null;
  readonly receivedAt: Date;
  readonly payload: Prisma.JsonValue;
}

function toEvent(row: Row): { event: JourneyEvent; property: string; sessionId: string | null; visitorId: string | null } {
  const raw = (row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload) ? row.payload : {}) as Record<string, unknown>;
  const property = typeof raw['property'] === 'string' ? (raw['property'] as string) : '';
  const attributes = minimizeWebsiteEvent(raw, property) as Record<string, string | number | undefined>;
  return {
    event: { at: row.occurredAt ?? row.receivedAt, eventType: storedWebsiteEventType(raw, row.eventType), attributes },
    property,
    sessionId: typeof attributes['sessionId'] === 'string' ? (attributes['sessionId'] as string) : null,
    visitorId: typeof attributes['visitorId'] === 'string' ? (attributes['visitorId'] as string) : null,
  };
}

const SELECT = { id: true, eventType: true, occurredAt: true, receivedAt: true, payload: true } as const;

export class WebsiteJourneyRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly scanLimit: number = JOURNEY_SCAN_LIMIT,
  ) {}

  /** Recent sessions in [since, now], newest activity first, optionally for one property. */
  async recentSessions(
    organizationId: string,
    options: { since: Date; now: Date; propertyKey?: string | null; limit?: number },
  ): Promise<JourneySessionList> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    if (options.propertyKey && !isWebPropertyKey(options.propertyKey)) return { sessions: [], complete: true, scannedEvents: 0, withoutSession: 0 };
    const where: Prisma.IntegrationEventWhereInput = {
      AND: [
        websiteEventsInWindow(organizationId, options.since, options.now),
        ...(options.propertyKey ? [{ payload: { path: ['property'], equals: options.propertyKey } }] : []),
      ],
    };
    // Newest first, so a capped scan keeps the most recent sessions whole-ish; older ones may be partial or absent.
    const groups = new Map<string, { property: string; sessionId: string; visitorId: string | null; events: JourneyEvent[] }>();
    let scanned = 0;
    let withoutSession = 0;
    let cursor: { id: string } | undefined;
    let total = 0;
    while (scanned < this.scanLimit) {
      const page = await this.prisma.integrationEvent.findMany({
        where,
        select: SELECT,
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: Math.min(PAGE, this.scanLimit - scanned),
        ...(cursor ? { cursor, skip: 1 } : {}),
      });
      if (page.length === 0) break;
      for (const row of page) {
        const { event, property, sessionId, visitorId } = toEvent(row);
        if (!sessionId || !property) {
          withoutSession++;
          continue;
        }
        const k = `${property}\u0000${sessionId}`;
        const g = groups.get(k) ?? { property, sessionId, visitorId, events: [] };
        if (!g.visitorId && visitorId) g.visitorId = visitorId;
        g.events.push(event);
        groups.set(k, g);
      }
      scanned += page.length;
      cursor = { id: page[page.length - 1]!.id };
      if (page.length < PAGE) break;
    }
    if (scanned >= this.scanLimit) total = await this.prisma.integrationEvent.count({ where });

    const built = [...groups.values()]
      .map((g) => ({ g, journey: buildJourneySession(g.events)! }))
      .sort((a, b) => b.journey.lastAt.getTime() - a.journey.lastAt.getTime())
      .slice(0, limit);
    const sessions: JourneySessionSummary[] = [];
    for (const { g, journey } of built) {
      const { steps: _steps, ...summary } = journey;
      sessions.push({
        ...summary,
        propertyKey: g.property,
        sessionId: g.sessionId,
        visitorId: g.visitorId,
        visitor: await this.visitorKind(organizationId, g.property, g.visitorId, journey.startedAt, options.now),
      });
    }
    return { sessions, complete: scanned < this.scanLimit || total <= scanned, scannedEvents: scanned, withoutSession };
  }

  /** One session's full journey, or null when this organization has no such session for the property. */
  async session(organizationId: string, propertyKey: string, sessionId: string, now: Date): Promise<JourneySessionDetail | null> {
    if (!isWebPropertyKey(propertyKey) || !ID.test(sessionId)) return null;
    const rows = await this.prisma.integrationEvent.findMany({
      where: {
        organizationId,
        provider: 'website',
        AND: [{ payload: { path: ['property'], equals: propertyKey } }, { payload: { path: ['sessionId'], equals: sessionId } }],
      },
      select: SELECT,
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      take: JOURNEY_SESSION_EVENT_LIMIT + 1,
    });
    if (rows.length === 0) return null;
    const truncated = rows.length > JOURNEY_SESSION_EVENT_LIMIT;
    const events = rows.slice(0, JOURNEY_SESSION_EVENT_LIMIT).map(toEvent);
    const journey = buildJourneySession(events.map((e) => e.event))!;
    const visitorId = events.find((e) => e.visitorId)?.visitorId ?? null;
    return {
      propertyKey,
      sessionId,
      visitorId,
      visitor: await this.visitorKind(organizationId, propertyKey, visitorId, journey.startedAt, now),
      journey,
      visitorSessions: visitorId ? await this.visitorSessions(organizationId, propertyKey, visitorId, now) : [],
      truncated,
    };
  }

  /** NEW: no earlier event from this browser on this property within the lookback. UNKNOWN: no browser id. */
  private async visitorKind(organizationId: string, propertyKey: string, visitorId: string | null, startedAt: Date, now: Date): Promise<'NEW' | 'RETURNING' | 'UNKNOWN'> {
    if (!visitorId) return 'UNKNOWN';
    const earlier = await this.prisma.integrationEvent.findFirst({
      where: {
        organizationId,
        provider: 'website',
        occurredAt: { gte: new Date(now.getTime() - JOURNEY_VISITOR_LOOKBACK_DAYS * 86_400_000), lt: startedAt },
        AND: [{ payload: { path: ['property'], equals: propertyKey } }, { payload: { path: ['visitorId'], equals: visitorId } }],
      },
      select: { id: true },
    });
    return earlier ? 'RETURNING' : 'NEW';
  }

  private async visitorSessions(organizationId: string, propertyKey: string, visitorId: string, now: Date): Promise<JourneyVisitorSession[]> {
    const rows = await this.prisma.integrationEvent.findMany({
      where: {
        organizationId,
        provider: 'website',
        occurredAt: { gte: new Date(now.getTime() - JOURNEY_VISITOR_LOOKBACK_DAYS * 86_400_000), lte: now },
        AND: [{ payload: { path: ['property'], equals: propertyKey } }, { payload: { path: ['visitorId'], equals: visitorId } }],
      },
      select: SELECT,
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      take: JOURNEY_SCAN_LIMIT,
    });
    const bySession = new Map<string, JourneyVisitorSession>();
    for (const row of rows) {
      const { event, sessionId } = toEvent(row);
      if (!sessionId) continue;
      const s = bySession.get(sessionId);
      bySession.set(sessionId, s ? { ...s, eventCount: s.eventCount + 1 } : { sessionId, startedAt: event.at, eventCount: 1 });
    }
    return [...bySession.values()].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
  }
}
