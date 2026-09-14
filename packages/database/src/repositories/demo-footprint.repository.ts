// Demo footprint -- what the removed /demo generators may have left behind.
//
// READ-ONLY, ONE ORGANIZATION. Until 2026-09-14 the public /demo routes wrote
// fabricated customer journeys into the live organization, and the operator-run
// Prisma seed writes three sample customers into the same one. This reader finds
// rows that carry those generators' fingerprints and everything that depends on
// them, so a human can decide on cleanup from evidence. It writes nothing.
//
// FINGERPRINTS, strongest first. Nothing in production code uses a mock provider,
// so a mock artifact can only have come from the demo loop:
//   - interaction provider 'mock' or externalId 'mock-…'   (simulated SMS)
//   - message externalId 'mock-…'                          (simulated SMS)
//   - booking calendarProvider 'mock' / eventId 'mock-…'   (simulated calendar)
//   - interaction payload.loopKind the demo loop wrote
//   - the loop's scripted customer reply
//   - the demo form's default contact values, the seed's sample identities, and
//     the reserved example.com domain
//
// WHAT LEAVES THIS FILE. Record ids, creation timestamps, match flags and counts.
// Names, emails, phone numbers and message bodies are read only to evaluate a
// flag and are never returned.
//
// BOUNDED. Every read takes at most DEMO_FOOTPRINT_BOUND + 1 rows. Past the bound
// `exceededBound` is true and the answer is incomplete, reported as such.

import type { PrismaClient } from '@prisma/client';

export const DEMO_FOOTPRINT_BOUND = 5_000;

/** Every payload.loopKind the demo loop wrote. The Prisma seed writes quote_request too. */
export const DEMO_LOOP_KINDS = [
  'quote_request',
  'assignment',
  'outbound_message',
  'inbound_message',
  'booking_created',
  'booking_confirmed',
] as const;
const ALL_LOOP_KINDS: ReadonlySet<string> = new Set(DEMO_LOOP_KINDS);
const DEMO_ONLY_LOOP_KINDS: readonly string[] = DEMO_LOOP_KINDS.filter((k) => k !== 'quote_request');

export const DEMO_FORM_DEFAULTS = { email: 'demo@example.com', phone: '+15555550000', firstName: 'Demo', lastName: 'Customer' };
export const SEED_SAMPLES = [
  { externalId: 'sic-demo-maria', email: 'maria@example.com', phone: '+15125550133' },
  { externalId: 'sic-demo-james', email: 'james@example.com', phone: '+14155550178' },
  { externalId: 'sic-demo-priya', email: 'priya@example.com', phone: '+12065550190' },
] as const;
export const DEMO_SCRIPTED_REPLY = 'Yes, tomorrow morning works great!';
const RESERVED_EMAIL_DOMAIN = '@example.com';

export type DemoAttribution = 'WEB_DEMO_LOOP' | 'PRISMA_SEED' | 'DEMO_IDENTITY_ONLY';

export interface DemoDependencies {
  interactions: string[];
  demoInteractions: string[];
  conversations: string[];
  messages: string[];
  mockMessages: string[];
  bookings: string[];
  mockBookings: string[];
  orders: string[];
  serviceRequests: string[];
  signals: string[];
  partyLinks: string[];
  domainEvents: string[];
  auditEntries: string[];
  humanAuditEntries: string[];
  outboxEntries: string[];
  decisionEvidence: string[];
}

export interface SuspectedDemoCustomer {
  id: string;
  createdAt: string;
  attribution: DemoAttribution;
  flags: string[];
  dependencies: DemoDependencies;
  /** Evidence the record may be real or was worked on by a person. Empty = none found. */
  legitimacySignals: string[];
}

export interface DemoOrphanArtifact {
  table: 'interaction' | 'message' | 'booking';
  id: string;
  createdAt: string;
  reason: string;
}

export interface DemoFootprint {
  organization: { id: string; createdAt: string; nameMatchesSeedUpsert: boolean } | null;
  totals: {
    markedInteractions: number;
    mockMessages: number;
    scriptedReplies: number;
    mockBookings: number;
    identityMatches: number;
  };
  suspects: SuspectedDemoCustomer[];
  orphans: DemoOrphanArtifact[];
  exceededBound: boolean;
}

const SEED_UPSERT_ORG_NAME = 'ServicesInMyCity (Demo)';

function record(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function iso(d: Date): string {
  return d.toISOString();
}

export class DemoFootprintRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async footprint(organizationId: string): Promise<DemoFootprint> {
    const take = DEMO_FOOTPRINT_BOUND + 1;
    let exceededBound = false;
    const bounded = <T>(rows: T[]): T[] => {
      if (rows.length > DEMO_FOOTPRINT_BOUND) {
        exceededBound = true;
        return rows.slice(0, DEMO_FOOTPRINT_BOUND);
      }
      return rows;
    };

    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true, name: true, createdAt: true },
    });

    // --- 1. Fingerprinted rows -----------------------------------------------
    const markedInteractions = bounded(await this.prisma.interaction.findMany({
      where: {
        organizationId,
        OR: [
          { provider: 'mock' },
          { externalId: { startsWith: 'mock-' } },
          ...DEMO_LOOP_KINDS.map((k) => ({ payload: { path: ['loopKind'], equals: k } })),
        ],
      },
      select: { id: true, customerId: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      take,
    }));
    const mockMessages = bounded(await this.prisma.message.findMany({
      where: { organizationId, externalId: { startsWith: 'mock-' } },
      select: { id: true, conversationId: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      take,
    }));
    const scriptedReplies = bounded(await this.prisma.message.findMany({
      where: { organizationId, body: DEMO_SCRIPTED_REPLY },
      select: { id: true, conversationId: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      take,
    }));
    const mockBookings = bounded(await this.prisma.booking.findMany({
      where: {
        organizationId,
        OR: [{ calendarProvider: 'mock' }, { calendarEventId: { startsWith: 'mock-' } }],
      },
      select: { id: true, customerId: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      take,
    }));
    const identityMatches = bounded(await this.prisma.customer.findMany({
      where: {
        organizationId,
        OR: [
          { email: { in: [DEMO_FORM_DEFAULTS.email, ...SEED_SAMPLES.map((s) => s.email)] } },
          { phone: { in: [DEMO_FORM_DEFAULTS.phone, ...SEED_SAMPLES.map((s) => s.phone)] } },
          { externalId: { in: SEED_SAMPLES.map((s) => s.externalId) } },
          { AND: [{ firstName: DEMO_FORM_DEFAULTS.firstName }, { lastName: DEMO_FORM_DEFAULTS.lastName }] },
          { email: { endsWith: RESERVED_EMAIL_DOMAIN } },
        ],
      },
      select: { id: true },
      take,
    }));

    const messageConversationIds = [...new Set([...mockMessages, ...scriptedReplies].map((m) => m.conversationId))];
    const messageConversations = messageConversationIds.length
      ? bounded(await this.prisma.conversation.findMany({
          where: { organizationId, id: { in: messageConversationIds } },
          select: { id: true, customerId: true },
          take,
        }))
      : [];
    const customerOfConversation = new Map(messageConversations.map((c) => [c.id, c.customerId]));

    const suspectIds = [...new Set([
      ...markedInteractions.map((i) => i.customerId),
      ...mockBookings.map((b) => b.customerId),
      ...messageConversations.map((c) => c.customerId),
      ...identityMatches.map((c) => c.id),
    ].filter((id): id is string => typeof id === 'string'))];

    const customers = suspectIds.length
      ? bounded(await this.prisma.customer.findMany({
          where: { organizationId, id: { in: suspectIds } },
          select: {
            id: true, createdAt: true, email: true, phone: true,
            firstName: true, lastName: true, externalId: true,
          },
          orderBy: { createdAt: 'asc' },
          take,
        }))
      : [];
    const ids = customers.map((c) => c.id);
    const idSet = new Set(ids);

    // --- 2. Everything that depends on a suspected customer ------------------
    const byCustomer = <T extends { customerId: string | null }>(rows: T[]) => {
      const m = new Map<string, T[]>();
      for (const r of rows) {
        if (!r.customerId) continue;
        m.set(r.customerId, [...(m.get(r.customerId) ?? []), r]);
      }
      return m;
    };
    const none = ids.length === 0;
    const interactions = none ? [] : bounded(await this.prisma.interaction.findMany({
      where: { organizationId, customerId: { in: ids } },
      select: { id: true, customerId: true, provider: true, externalId: true, payload: true },
      take,
    }));
    const conversations = none ? [] : bounded(await this.prisma.conversation.findMany({
      where: { organizationId, customerId: { in: ids } },
      select: { id: true, customerId: true },
      take,
    }));
    const conversationIds = conversations.map((c) => c.id);
    const messages = conversationIds.length === 0 ? [] : bounded(await this.prisma.message.findMany({
      where: { organizationId, conversationId: { in: conversationIds } },
      select: { id: true, conversationId: true, externalId: true },
      take,
    }));
    const bookings = none ? [] : bounded(await this.prisma.booking.findMany({
      where: { organizationId, customerId: { in: ids } },
      select: { id: true, customerId: true, calendarProvider: true, calendarEventId: true },
      take,
    }));
    const orders = none ? [] : bounded(await this.prisma.order.findMany({
      where: { organizationId, customerId: { in: ids } }, select: { id: true, customerId: true }, take,
    }));
    const serviceRequests = none ? [] : bounded(await this.prisma.serviceRequest.findMany({
      where: { organizationId, customerId: { in: ids } }, select: { id: true, customerId: true }, take,
    }));
    const signals = none ? [] : bounded(await this.prisma.signal.findMany({
      where: { organizationId, customerId: { in: ids } }, select: { id: true, customerId: true }, take,
    }));
    const partyLinks = none ? [] : bounded(await this.prisma.customerPartyLink.findMany({
      where: { organizationId, customerId: { in: ids } }, select: { id: true, customerId: true }, take,
    }));

    const aggregateOwner = new Map<string, string>();
    for (const c of ids) aggregateOwner.set(c, c);
    for (const i of interactions) if (i.customerId) aggregateOwner.set(i.id, i.customerId);
    for (const b of bookings) if (b.customerId) aggregateOwner.set(b.id, b.customerId);
    const aggregateIds = [...aggregateOwner.keys()];
    const domainEvents = aggregateIds.length === 0 ? [] : bounded(await this.prisma.domainEvent.findMany({
      where: { organizationId, aggregateId: { in: aggregateIds } }, select: { id: true, aggregateId: true }, take,
    }));
    const auditEntries = none ? [] : bounded(await this.prisma.auditLog.findMany({
      where: { organizationId, entityId: { in: ids } }, select: { id: true, entityId: true, userId: true }, take,
    }));
    const outboxEntries = aggregateIds.length === 0 ? [] : bounded(await this.prisma.stateChangeOutbox.findMany({
      where: { organizationId, subjectId: { in: aggregateIds } }, select: { id: true, subjectId: true }, take,
    }));
    const decisionEvidence = aggregateIds.length === 0 ? [] : bounded(await this.prisma.decisionEvidence.findMany({
      where: { organizationId, entityId: { in: aggregateIds } }, select: { id: true, entityId: true }, take,
    }));

    // --- 3. Classify -----------------------------------------------------------
    const isMockInteraction = (i: { provider: string | null; externalId: string | null }) =>
      i.provider === 'mock' || (i.externalId ?? '').startsWith('mock-');
    const loopKindOf = (payload: unknown) => {
      const k = record(payload).loopKind;
      return typeof k === 'string' ? k : null;
    };
    const interactionsBy = byCustomer(interactions);
    const conversationsBy = byCustomer(conversations);
    const bookingsBy = byCustomer(bookings);
    const ownerOf = (rows: { id: string; key: string | null }[]) => {
      const m = new Map<string, string[]>();
      for (const r of rows) {
        const owner = r.key ? aggregateOwner.get(r.key) : undefined;
        if (!owner) continue;
        m.set(owner, [...(m.get(owner) ?? []), r.id]);
      }
      return m;
    };
    const eventsBy = ownerOf(domainEvents.map((e) => ({ id: e.id, key: e.aggregateId })));
    const outboxBy = ownerOf(outboxEntries.map((e) => ({ id: e.id, key: e.subjectId })));
    const evidenceBy = ownerOf(decisionEvidence.map((e) => ({ id: e.id, key: e.entityId })));
    const scriptedIds = new Set(scriptedReplies.map((m) => m.id));
    const idsOf = <T extends { id: string }>(rows: T[] | undefined) => (rows ?? []).map((r) => r.id);
    const simpleBy = <T extends { id: string; customerId: string | null }>(rows: T[], customerId: string) =>
      rows.filter((r) => r.customerId === customerId).map((r) => r.id);

    const suspects: SuspectedDemoCustomer[] = customers.map((c) => {
      const own = interactionsBy.get(c.id) ?? [];
      const demoInteractions = own.filter((i) => isMockInteraction(i) || ALL_LOOP_KINDS.has(loopKindOf(i.payload) ?? ''));
      const otherInteractions = own.filter((i) => !demoInteractions.includes(i));
      const convIds = new Set(idsOf(conversationsBy.get(c.id)));
      const ownMessages = messages.filter((m) => convIds.has(m.conversationId));
      const ownMockMessages = ownMessages.filter((m) => (m.externalId ?? '').startsWith('mock-'));
      const ownBookings = bookingsBy.get(c.id) ?? [];
      const ownMockBookings = ownBookings.filter((b) => b.calendarProvider === 'mock' || (b.calendarEventId ?? '').startsWith('mock-'));
      const audits = auditEntries.filter((a) => a.entityId === c.id);

      const flags: string[] = [];
      if (own.some(isMockInteraction)) flags.push('MOCK_SMS_INTERACTION');
      if (own.some((i) => DEMO_ONLY_LOOP_KINDS.includes(loopKindOf(i.payload) ?? ''))) flags.push('DEMO_LOOP_KIND');
      if (own.some((i) => loopKindOf(i.payload) === 'quote_request')) flags.push('QUOTE_REQUEST_LOOP_KIND');
      if (ownMockMessages.length) flags.push('MOCK_SMS_MESSAGE');
      if (ownMessages.some((m) => scriptedIds.has(m.id))) flags.push('SCRIPTED_REPLY');
      if (ownMockBookings.length) flags.push('MOCK_CALENDAR_BOOKING');
      if (c.email === DEMO_FORM_DEFAULTS.email) flags.push('EMAIL_DEMO_FORM_DEFAULT');
      if (c.phone === DEMO_FORM_DEFAULTS.phone) flags.push('PHONE_DEMO_FORM_DEFAULT');
      if (c.firstName === DEMO_FORM_DEFAULTS.firstName && c.lastName === DEMO_FORM_DEFAULTS.lastName) flags.push('NAME_DEMO_FORM_DEFAULT');
      if (SEED_SAMPLES.some((s) => s.externalId === c.externalId)) flags.push('SEED_SAMPLE_EXTERNAL_ID');
      if (SEED_SAMPLES.some((s) => s.email === c.email || s.phone === c.phone)) flags.push('SEED_SAMPLE_CONTACT');
      if ((c.email ?? '').toLowerCase().endsWith(RESERVED_EMAIL_DOMAIN)) flags.push('RESERVED_EMAIL_DOMAIN');

      const webLoop = flags.some((f) => ['MOCK_SMS_INTERACTION', 'DEMO_LOOP_KIND', 'MOCK_SMS_MESSAGE', 'MOCK_CALENDAR_BOOKING', 'SCRIPTED_REPLY'].includes(f));
      const attribution: DemoAttribution = webLoop
        ? 'WEB_DEMO_LOOP'
        : flags.includes('SEED_SAMPLE_EXTERNAL_ID') ? 'PRISMA_SEED' : 'DEMO_IDENTITY_ONLY';

      const orderIds = simpleBy(orders, c.id);
      const requestIds = simpleBy(serviceRequests, c.id);
      const linkIds = simpleBy(partyLinks, c.id);
      const humanAudits = audits.filter((a) => a.userId !== null);
      const legitimacySignals: string[] = [];
      if (otherInteractions.length) legitimacySignals.push('NON_DEMO_INTERACTIONS');
      if (ownMessages.some((m) => !ownMockMessages.includes(m) && !scriptedIds.has(m.id))) {
        legitimacySignals.push('NON_DEMO_MESSAGES');
      }
      if (ownBookings.length > ownMockBookings.length) legitimacySignals.push('NON_MOCK_BOOKINGS');
      if (orderIds.length) legitimacySignals.push('ORDERS');
      if (requestIds.length) legitimacySignals.push('SERVICE_REQUESTS');
      if (linkIds.length) legitimacySignals.push('PARTY_LINKS');
      if (humanAudits.length) legitimacySignals.push('HUMAN_AUDIT_ENTRIES');
      if (!flags.some((f) => f !== 'RESERVED_EMAIL_DOMAIN')) legitimacySignals.push('ONLY_RESERVED_EMAIL_DOMAIN');

      return {
        id: c.id,
        createdAt: iso(c.createdAt),
        attribution,
        flags,
        dependencies: {
          interactions: idsOf(own),
          demoInteractions: idsOf(demoInteractions),
          conversations: [...convIds],
          messages: idsOf(ownMessages),
          mockMessages: idsOf(ownMockMessages),
          bookings: idsOf(ownBookings),
          mockBookings: idsOf(ownMockBookings),
          orders: orderIds,
          serviceRequests: requestIds,
          signals: simpleBy(signals, c.id),
          partyLinks: linkIds,
          domainEvents: eventsBy.get(c.id) ?? [],
          auditEntries: idsOf(audits),
          humanAuditEntries: idsOf(humanAudits),
          outboxEntries: outboxBy.get(c.id) ?? [],
          decisionEvidence: evidenceBy.get(c.id) ?? [],
        },
        legitimacySignals,
      };
    });

    const orphans: DemoOrphanArtifact[] = [
      ...markedInteractions
        .filter((i) => !i.customerId || !idSet.has(i.customerId))
        .map((i) => ({ table: 'interaction' as const, id: i.id, createdAt: iso(i.createdAt), reason: i.customerId ? 'CUSTOMER_NOT_IN_ORGANIZATION' : 'NO_CUSTOMER' })),
      ...[...mockMessages, ...scriptedReplies.filter((r) => !mockMessages.some((m) => m.id === r.id))]
        .filter((m) => {
          const owner = customerOfConversation.get(m.conversationId);
          return !owner || !idSet.has(owner);
        })
        .map((m) => ({ table: 'message' as const, id: m.id, createdAt: iso(m.createdAt), reason: 'CONVERSATION_WITHOUT_SUSPECTED_CUSTOMER' })),
      ...mockBookings
        .filter((b) => !b.customerId || !idSet.has(b.customerId))
        .map((b) => ({ table: 'booking' as const, id: b.id, createdAt: iso(b.createdAt), reason: b.customerId ? 'CUSTOMER_NOT_IN_ORGANIZATION' : 'NO_CUSTOMER' })),
    ];

    return {
      organization: org ? { id: org.id, createdAt: iso(org.createdAt), nameMatchesSeedUpsert: org.name === SEED_UPSERT_ORG_NAME } : null,
      totals: {
        markedInteractions: markedInteractions.length,
        mockMessages: mockMessages.length,
        scriptedReplies: scriptedReplies.length,
        mockBookings: mockBookings.length,
        identityMatches: identityMatches.length,
      },
      suspects,
      orphans,
      exceededBound,
    };
  }
}
