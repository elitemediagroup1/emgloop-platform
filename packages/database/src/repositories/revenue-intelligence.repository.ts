// RevenueIntelligenceRepository — Sprint 15.
//
// Deterministic Revenue & Traffic Intelligence. NO AI, NO Stripe, NO accounting
// integrations. Revenue is realized from Orders (totalCents) already persisted
// in Neon. Attribution dimensions (vendor / source / campaign / website / channel
// / signal / journey) come from each customer's Interaction.metadata, written by
// the NormalizationEngine. Every revenue figure is traceable to its evidence.
//
// Sprint 15 real-data hotfix:
//  - Demo / QA / E2E / test customers are EXCLUDED (never deleted) from active
//    intelligence via operational-filters.isExcludedCustomer.
//  - Fabricated attribution labels become honest 'Unknown ...' via realAttr.
//  - Revenue is reported as realized vs pending vs opportunity, so the page is
//    honest when there are calls/visits but no realized orders.
//  - Traffic distinguishes known attribution from missing attribution.

import type { PrismaClient, Prisma } from '@prisma/client';
import { isExcludedCustomer, realAttr, UNKNOWN, since, TRAFFIC_DEFAULT_WINDOW_MS } from './operational-filters';

function jsonStr(value: Prisma.JsonValue | null | undefined, key: string): string | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const v = (value as Record<string, unknown>)[key];
    if (typeof v === 'string' && v.trim()) return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  }
  return null;
}

// Orders in these states count as realized revenue.
const REVENUE_STATUSES = new Set(['PLACED', 'IN_PROGRESS', 'READY', 'FULFILLED']);
// Orders in these states are pending (not yet realized, not lost).
const PENDING_STATUSES = new Set(['DRAFT']);

export interface RankedRevenue {
  key: string;
  label: string;
  orders: number;
  revenueCents: number;
}

export interface RevenueByDimension {
  byWebsite: RankedRevenue[];
  byVendor: RankedRevenue[];
  bySource: RankedRevenue[];
  byCampaign: RankedRevenue[];
  byBuyer: RankedRevenue[];
  byChannel: RankedRevenue[];
  bySignal: RankedRevenue[];
  byJourney: RankedRevenue[];
  totalRevenueCents: number;
  totalOrders: number;
  // Honest revenue posture.
  realizedRevenueCents: number;
  realizedOrders: number;
  pendingRevenueCents: number;
  pendingOrders: number;
  influencedJourneys: number; // customers with activity but no realized revenue
  hasRealizedRevenue: boolean;
  rangeLabel: string;
}

export interface TrafficVendorRow {
  vendor: string;
  attributed: boolean;
  calls: number;
  qualified: number;
  qualifiedPct: number;
  bookings: number;
  revenueCents: number;
  marginCents: number | null;
  conversionPct: number;
  insight: string;
}

export interface TrafficSourceRow {
  vendor: string;
  source: string;
  campaign: string;
  calls: number;
  bookings: number;
  revenueCents: number;
}

export interface TrafficCampaignRow {
  campaign: string;
  vendor: string;
  calls: number;
  bookings: number;
  revenueCents: number;
  conversionPct: number;
}

export interface TrafficBuyerRow {
  buyer: string;
  callsDelivered: number;
  revenueCents: number;
  conversionPct: number;
  qualityPct: number;
}

export interface TrafficIntelligence {
  vendors: TrafficVendorRow[];
  sources: TrafficSourceRow[];
  campaigns: TrafficCampaignRow[];
  buyers: TrafficBuyerRow[];
  // Attribution posture for the whole window.
  totalCalls: number;
  attributedCalls: number; // calls with a real vendor
  unattributedCalls: number; // calls missing vendor/source/campaign
  qualifiedCalls: number;
  bookings: number;
  realizedRevenueCents: number;
  pendingRevenueCents: number;
  rangeLabel: string;
}

export interface RevenueTimelineEntry {
  kind: 'website' | 'call' | 'signal' | 'booking' | 'order';
  label: string;
  detail: string | null;
  amountCents: number | null;
  at: string;
}

export interface CustomerRevenueTimeline {
  entries: RevenueTimelineEntry[];
  lifetimeValueCents: number;
  firstTouchAt: string | null;
  conversionAt: string | null;
  influencedBy: string[];
}

type CustomerWithRelations = Prisma.CustomerGetPayload<{
  include: { interactions: true; bookings: true; orders: true; signals: true };
}>;

function bump(map: Map<string, RankedRevenue>, key: string | null, label: string | null, cents: number) {
  const k = key && key.trim() ? key : UNKNOWN.vendor;
  const existing = map.get(k);
  if (existing) {
    existing.orders += 1;
    existing.revenueCents += cents;
  } else {
    map.set(k, { key: k, label: label && label.trim() ? label : k, orders: 1, revenueCents: cents });
  }
}

function ranked(map: Map<string, RankedRevenue>): RankedRevenue[] {
  return Array.from(map.values()).sort((a, b) => b.revenueCents - a.revenueCents);
}

export class RevenueIntelligenceRepository {
  constructor(private readonly prisma: PrismaClient) {}

  // Pick a customer's dominant attribution from their interactions (latest wins).
  // Fabricated labels are treated as missing (realAttr -> null).
  private attributionFor(customer: CustomerWithRelations): {
    vendor: string | null;
    source: string | null;
    campaign: string | null;
    website: string | null;
    channel: string | null;
    buyer: string | null;
    signal: string | null;
    journey: string | null;
  } {
    const interactions = [...customer.interactions].sort(
      (a, b) => b.occurredAt.getTime() - a.occurredAt.getTime(),
    );
    let vendor: string | null = null;
    let source: string | null = null;
    let campaign: string | null = null;
    let website: string | null = null;
    let channel: string | null = null;
    let buyer: string | null = null;
    let journey: string | null = null;
    for (const i of interactions) {
      vendor = vendor ?? realAttr(jsonStr(i.metadata, 'vendor'));
      source = source ?? realAttr(jsonStr(i.metadata, 'source'));
      campaign = campaign ?? realAttr(jsonStr(i.metadata, 'campaign'));
      website = website ?? jsonStr(i.metadata, 'property') ?? jsonStr(i.metadata, 'website');
      channel = channel ?? (i.channel as string);
      buyer = buyer ?? realAttr(jsonStr(i.metadata, 'buyer'));
      journey = journey ?? jsonStr(i.metadata, 'journeyStage') ?? jsonStr(i.metadata, 'intent');
    }
    const signal = customer.signals.length
      ? [...customer.signals].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]!.type
      : null;
    return { vendor, source, campaign, website, channel, buyer, signal, journey };
  }

  private revenueOf(customer: CustomerWithRelations): {
    realizedCents: number;
    realizedOrders: number;
    pendingCents: number;
    pendingOrders: number;
  } {
    let realizedCents = 0;
    let realizedOrders = 0;
    let pendingCents = 0;
    let pendingOrders = 0;
    for (const o of customer.orders) {
      const st = String(o.status);
      if (REVENUE_STATUSES.has(st)) {
        realizedCents += o.totalCents ?? 0;
        realizedOrders += 1;
      } else if (PENDING_STATUSES.has(st)) {
        pendingCents += o.totalCents ?? 0;
        pendingOrders += 1;
      }
    }
    return { realizedCents, realizedOrders, pendingCents, pendingOrders };
  }

  async revenueByDimension(organizationId: string): Promise<RevenueByDimension> {
    const all = await this.prisma.customer.findMany({
      where: { organizationId },
      include: { interactions: true, bookings: true, orders: true, signals: true },
    });
    const customers = all.filter((c) => !isExcludedCustomer(c));

    const byWebsite = new Map<string, RankedRevenue>();
    const byVendor = new Map<string, RankedRevenue>();
    const bySource = new Map<string, RankedRevenue>();
    const byCampaign = new Map<string, RankedRevenue>();
    const byBuyer = new Map<string, RankedRevenue>();
    const byChannel = new Map<string, RankedRevenue>();
    const bySignal = new Map<string, RankedRevenue>();
    const byJourney = new Map<string, RankedRevenue>();

    let realizedRevenueCents = 0;
    let realizedOrders = 0;
    let pendingRevenueCents = 0;
    let pendingOrders = 0;
    let influencedJourneys = 0;

    for (const c of customers) {
      const { realizedCents, realizedOrders: ro, pendingCents, pendingOrders: po } = this.revenueOf(c);
      pendingRevenueCents += pendingCents;
      pendingOrders += po;
      if (ro === 0) {
        // Activity without realized revenue = an influenced (pending) journey.
        if (c.interactions.length > 0) influencedJourneys += 1;
        continue;
      }
      const a = this.attributionFor(c);
      realizedRevenueCents += realizedCents;
      realizedOrders += ro;
      bump(byWebsite, a.website, a.website, realizedCents);
      bump(byVendor, a.vendor ?? UNKNOWN.vendor, a.vendor ?? UNKNOWN.vendor, realizedCents);
      bump(bySource, a.source ?? UNKNOWN.source, a.source ?? UNKNOWN.source, realizedCents);
      bump(byCampaign, a.campaign ?? UNKNOWN.campaign, a.campaign ?? UNKNOWN.campaign, realizedCents);
      bump(byBuyer, a.buyer ?? UNKNOWN.buyer, a.buyer ?? UNKNOWN.buyer, realizedCents);
      bump(byChannel, a.channel, a.channel, realizedCents);
      bump(bySignal, a.signal, a.signal, realizedCents);
      bump(byJourney, a.journey, a.journey, realizedCents);
    }

    return {
      byWebsite: ranked(byWebsite),
      byVendor: ranked(byVendor),
      bySource: ranked(bySource),
      byCampaign: ranked(byCampaign),
      byBuyer: ranked(byBuyer),
      byChannel: ranked(byChannel),
      bySignal: ranked(bySignal),
      byJourney: ranked(byJourney),
      totalRevenueCents: realizedRevenueCents,
      totalOrders: realizedOrders,
      realizedRevenueCents,
      realizedOrders,
      pendingRevenueCents,
      pendingOrders,
      influencedJourneys,
      hasRealizedRevenue: realizedOrders > 0,
      rangeLabel: 'All time',
    };
  }

  async trafficIntelligence(organizationId: string): Promise<TrafficIntelligence> {
    const cutoff = since(TRAFFIC_DEFAULT_WINDOW_MS);
    const allCalls = await this.prisma.interaction.findMany({
      where: { organizationId, channel: 'PHONE', occurredAt: { gte: cutoff } },
      include: { customer: { include: { orders: true, bookings: true } } },
    });
    const calls = allCalls.filter((i) => !isExcludedCustomer(i.customer));

    interface Acc {
      calls: number;
      qualified: number;
      bookings: number;
      revenueCents: number;
    }
    const blank = (): Acc => ({ calls: 0, qualified: 0, bookings: 0, revenueCents: 0 });

    const vendors = new Map<string, Acc & { attributed: boolean }>();
    const sources = new Map<string, { vendor: string; source: string; campaign: string } & Acc>();
    const campaigns = new Map<string, { campaign: string; vendor: string } & Acc>();
    const buyers = new Map<string, Acc & { quality: number }>();

    let totalCalls = 0;
    let attributedCalls = 0;
    let qualifiedCalls = 0;
    let totalBookings = 0;
    let realizedRevenueCents = 0;
    let pendingRevenueCents = 0;

    for (const i of calls) {
      const vendorReal = realAttr(jsonStr(i.metadata, 'vendor'));
      const sourceReal = realAttr(jsonStr(i.metadata, 'source'));
      const campaignReal = realAttr(jsonStr(i.metadata, 'campaign'));
      const buyerReal = realAttr(jsonStr(i.metadata, 'buyer'));
      const vendor = vendorReal ?? UNKNOWN.vendor;
      const source = sourceReal ?? UNKNOWN.source;
      const campaign = campaignReal ?? UNKNOWN.campaign;
      const buyer = buyerReal ?? UNKNOWN.buyer;
      const attributed = Boolean(vendorReal);
      const qualified = jsonStr(i.metadata, 'qualified') === 'true';
      const realizedOrders = i.customer ? i.customer.orders.filter((o) => REVENUE_STATUSES.has(String(o.status))) : [];
      const pendingOrders = i.customer ? i.customer.orders.filter((o) => PENDING_STATUSES.has(String(o.status))) : [];
      const bookings = i.customer ? i.customer.bookings.length : 0;
      const rev = realizedOrders.reduce((s, o) => s + (o.totalCents ?? 0), 0);
      const pend = pendingOrders.reduce((s, o) => s + (o.totalCents ?? 0), 0);

      totalCalls += 1;
      if (attributed) attributedCalls += 1;
      if (qualified) qualifiedCalls += 1;
      if (bookings) totalBookings += 1;
      realizedRevenueCents += rev;
      pendingRevenueCents += pend;

      const v = vendors.get(vendor) ?? { ...blank(), attributed };
      v.calls += 1;
      if (qualified) v.qualified += 1;
      v.bookings += bookings ? 1 : 0;
      v.revenueCents += rev;
      v.attributed = v.attributed || attributed;
      vendors.set(vendor, v);

      const sKey = vendor + ' › ' + source + ' › ' + campaign;
      const s = sources.get(sKey) ?? { vendor, source, campaign, ...blank() };
      s.calls += 1;
      s.bookings += bookings ? 1 : 0;
      s.revenueCents += rev;
      sources.set(sKey, s);

      const c = campaigns.get(campaign) ?? { campaign, vendor, ...blank() };
      c.calls += 1;
      c.bookings += bookings ? 1 : 0;
      c.revenueCents += rev;
      campaigns.set(campaign, c);

      const b = buyers.get(buyer) ?? { ...blank(), quality: 0 };
      b.calls += 1;
      if (qualified) b.qualified += 1;
      b.bookings += bookings ? 1 : 0;
      b.revenueCents += rev;
      buyers.set(buyer, b);
    }

    const pct = (num: number, den: number): number => (den > 0 ? Math.round((num / den) * 1000) / 10 : 0);

    const vendorRows: TrafficVendorRow[] = Array.from(vendors.entries())
      .map(([vendor, a]) => {
        const qualifiedPct = pct(a.qualified, a.calls);
        const conversionPct = pct(a.bookings, a.calls);
        const insight = !a.attributed
          ? 'Missing attribution — vendor/source not provided on these calls.'
          : conversionPct >= 40
            ? 'High-converting partner — scale spend.'
            : qualifiedPct < 25 && a.calls >= 3
              ? 'Low qualified rate — review lead quality.'
              : 'Steady performance.';
        return {
          vendor,
          attributed: a.attributed,
          calls: a.calls,
          qualified: a.qualified,
          qualifiedPct,
          bookings: a.bookings,
          revenueCents: a.revenueCents,
          marginCents: null,
          conversionPct,
          insight,
        };
      })
      .sort((x, y) => Number(y.attributed) - Number(x.attributed) || y.calls - x.calls);

    const sourceRows: TrafficSourceRow[] = Array.from(sources.values())
      .map((s) => ({ vendor: s.vendor, source: s.source, campaign: s.campaign, calls: s.calls, bookings: s.bookings, revenueCents: s.revenueCents }))
      .sort((x, y) => y.calls - x.calls);

    const campaignRows: TrafficCampaignRow[] = Array.from(campaigns.values())
      .map((c) => ({ campaign: c.campaign, vendor: c.vendor, calls: c.calls, bookings: c.bookings, revenueCents: c.revenueCents, conversionPct: pct(c.bookings, c.calls) }))
      .sort((x, y) => y.calls - x.calls);

    const buyerRows: TrafficBuyerRow[] = Array.from(buyers.entries())
      .map(([buyer, a]) => ({ buyer, callsDelivered: a.calls, revenueCents: a.revenueCents, conversionPct: pct(a.bookings, a.calls), qualityPct: pct(a.qualified, a.calls) }))
      .sort((x, y) => y.callsDelivered - x.callsDelivered);

    return {
      vendors: vendorRows,
      sources: sourceRows,
      campaigns: campaignRows,
      buyers: buyerRows,
      totalCalls,
      attributedCalls,
      unattributedCalls: totalCalls - attributedCalls,
      qualifiedCalls,
      bookings: totalBookings,
      realizedRevenueCents,
      pendingRevenueCents,
      rangeLabel: 'Last 7 days',
    };
  }

  async customerRevenueTimeline(organizationId: string, customerId: string): Promise<CustomerRevenueTimeline | null> {
    const customer = await this.prisma.customer.findFirst({
      where: { id: customerId, organizationId },
      include: { interactions: true, bookings: true, orders: true, signals: true },
    });
    if (!customer) return null;

    const entries: RevenueTimelineEntry[] = [];

    for (const i of customer.interactions) {
      const et = jsonStr(i.metadata, 'eventType') ?? '';
      const kind: RevenueTimelineEntry['kind'] = et.startsWith('web.') || i.provider === 'website' ? 'website' : 'call';
      entries.push({ kind, label: i.summary ?? i.kind, detail: i.provider, amountCents: null, at: i.occurredAt.toISOString() });
    }
    for (const s of customer.signals) {
      entries.push({ kind: 'signal', label: 'Signal: ' + s.type, detail: null, amountCents: null, at: s.createdAt.toISOString() });
    }
    for (const b of customer.bookings) {
      entries.push({ kind: 'booking', label: b.title ?? 'Booking ' + String(b.status).toLowerCase(), detail: String(b.status), amountCents: null, at: b.createdAt.toISOString() });
    }
    let lifetimeValueCents = 0;
    let conversionAt: string | null = null;
    for (const o of customer.orders) {
      const realized = REVENUE_STATUSES.has(String(o.status));
      if (realized) {
        lifetimeValueCents += o.totalCents ?? 0;
        if (!conversionAt) conversionAt = o.createdAt.toISOString();
      }
      entries.push({ kind: 'order', label: 'Order ' + String(o.status).toLowerCase(), detail: o.number ?? null, amountCents: o.totalCents ?? 0, at: o.createdAt.toISOString() });
    }

    entries.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

    const a = this.attributionFor(customer);
    const influencedBy: string[] = [];
    if (a.website) influencedBy.push('Website: ' + a.website);
    if (customer.interactions.some((i) => i.channel === 'PHONE')) influencedBy.push('CallGrid');
    if (a.signal) influencedBy.push('Signal: ' + a.signal);
    if (a.vendor) influencedBy.push('Vendor: ' + a.vendor);
    if (a.campaign) influencedBy.push('Campaign: ' + a.campaign);

    return {
      entries,
      lifetimeValueCents,
      firstTouchAt: entries.length ? entries[0]!.at : null,
      conversionAt,
      influencedBy,
    };
  }
}
