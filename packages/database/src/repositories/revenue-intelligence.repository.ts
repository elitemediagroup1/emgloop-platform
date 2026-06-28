// RevenueIntelligenceRepository — Sprint 15.
//
// Deterministic Revenue & Traffic Intelligence. NO AI, NO Stripe, NO accounting
// integrations. Revenue is realized from Orders (totalCents) already persisted
// in Neon. Attribution dimensions (vendor / source / campaign / website / channel
// / signal / journey) come from each customer's Interaction.metadata, written by
// the NormalizationEngine. Every revenue figure is traceable to its evidence.

import type { PrismaClient, Prisma } from '@prisma/client';

function jsonStr(value: Prisma.JsonValue | null | undefined, key: string): string | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const v = (value as Record<string, unknown>)[key];
    if (typeof v === 'string' && v.trim()) return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  }
  return null;
}

const UNATTRIBUTED = '(unattributed)';

// Orders in these states count as realized revenue.
const REVENUE_STATUSES = new Set(['PLACED', 'IN_PROGRESS', 'READY', 'FULFILLED']);

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
}

export interface TrafficVendorRow {
  vendor: string;
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
  const k = key && key.trim() ? key : UNATTRIBUTED;
  const existing = map.get(k);
  if (existing) {
    existing.orders += 1;
    existing.revenueCents += cents;
  } else {
    map.set(k, { key: k, label: label && label.trim() ? label : UNATTRIBUTED, orders: 1, revenueCents: cents });
  }
}

function ranked(map: Map<string, RankedRevenue>): RankedRevenue[] {
  return Array.from(map.values()).sort((a, b) => b.revenueCents - a.revenueCents);
}

export class RevenueIntelligenceRepository {
  constructor(private readonly prisma: PrismaClient) {}

  // Pick a customer's dominant attribution from their interactions (latest wins).
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
      vendor = vendor ?? jsonStr(i.metadata, 'vendor');
      source = source ?? jsonStr(i.metadata, 'source');
      campaign = campaign ?? jsonStr(i.metadata, 'campaign');
      website = website ?? jsonStr(i.metadata, 'property') ?? jsonStr(i.metadata, 'website');
      channel = channel ?? (i.channel as string);
      buyer = buyer ?? jsonStr(i.metadata, 'buyer');
      journey = journey ?? jsonStr(i.metadata, 'journeyStage') ?? jsonStr(i.metadata, 'intent');
    }
    const signal = customer.signals.length
      ? [...customer.signals].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]!.type
      : null;
    return { vendor, source, campaign, website, channel, buyer, signal, journey };
  }

  private revenueOf(customer: CustomerWithRelations): { cents: number; orders: number } {
    let cents = 0;
    let orders = 0;
    for (const o of customer.orders) {
      if (REVENUE_STATUSES.has(String(o.status))) {
        cents += o.totalCents ?? 0;
        orders += 1;
      }
    }
    return { cents, orders };
  }

  async revenueByDimension(organizationId: string): Promise<RevenueByDimension> {
    const customers = await this.prisma.customer.findMany({
      where: { organizationId },
      include: { interactions: true, bookings: true, orders: true, signals: true },
    });

    const byWebsite = new Map<string, RankedRevenue>();
    const byVendor = new Map<string, RankedRevenue>();
    const bySource = new Map<string, RankedRevenue>();
    const byCampaign = new Map<string, RankedRevenue>();
    const byBuyer = new Map<string, RankedRevenue>();
    const byChannel = new Map<string, RankedRevenue>();
    const bySignal = new Map<string, RankedRevenue>();
    const byJourney = new Map<string, RankedRevenue>();

    let totalRevenueCents = 0;
    let totalOrders = 0;

    for (const c of customers) {
      const { cents, orders } = this.revenueOf(c);
      if (orders === 0) continue;
      const a = this.attributionFor(c);
      totalRevenueCents += cents;
      totalOrders += orders;
      bump(byWebsite, a.website, a.website, cents);
      bump(byVendor, a.vendor, a.vendor, cents);
      bump(bySource, a.source, a.source, cents);
      bump(byCampaign, a.campaign, a.campaign, cents);
      bump(byBuyer, a.buyer, a.buyer, cents);
      bump(byChannel, a.channel, a.channel, cents);
      bump(bySignal, a.signal, a.signal, cents);
      bump(byJourney, a.journey, a.journey, cents);
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
      totalRevenueCents,
      totalOrders,
    };
  }

  async trafficIntelligence(organizationId: string): Promise<TrafficIntelligence> {
    const calls = await this.prisma.interaction.findMany({
      where: { organizationId, channel: 'PHONE' },
      include: { customer: { include: { orders: true, bookings: true } } },
    });

    interface Acc {
      calls: number;
      qualified: number;
      bookings: number;
      revenueCents: number;
    }
    const blank = (): Acc => ({ calls: 0, qualified: 0, bookings: 0, revenueCents: 0 });

    const vendors = new Map<string, Acc>();
    const sources = new Map<string, { vendor: string; source: string; campaign: string } & Acc>();
    const campaigns = new Map<string, { campaign: string; vendor: string } & Acc>();
    const buyers = new Map<string, Acc & { quality: number }>();

    for (const i of calls) {
      const vendor = jsonStr(i.metadata, 'vendor') ?? UNATTRIBUTED;
      const source = jsonStr(i.metadata, 'source') ?? UNATTRIBUTED;
      const campaign = jsonStr(i.metadata, 'campaign') ?? UNATTRIBUTED;
      const buyer = jsonStr(i.metadata, 'buyer') ?? UNATTRIBUTED;
      const qualified = jsonStr(i.metadata, 'qualified') === 'true';
      const orders = i.customer ? i.customer.orders.filter((o) => REVENUE_STATUSES.has(String(o.status))) : [];
      const bookings = i.customer ? i.customer.bookings.length : 0;
      const rev = orders.reduce((s, o) => s + (o.totalCents ?? 0), 0);

      const v = vendors.get(vendor) ?? blank();
      v.calls += 1;
      if (qualified) v.qualified += 1;
      v.bookings += bookings ? 1 : 0;
      v.revenueCents += rev;
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
        const insight =
          conversionPct >= 40
            ? 'High-converting partner — scale spend.'
            : qualifiedPct < 25 && a.calls >= 3
              ? 'Low qualified rate — review lead quality.'
              : 'Steady performance.';
        return {
          vendor,
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
      .sort((x, y) => y.revenueCents - x.revenueCents);

    const sourceRows: TrafficSourceRow[] = Array.from(sources.values())
      .map((s) => ({ vendor: s.vendor, source: s.source, campaign: s.campaign, calls: s.calls, bookings: s.bookings, revenueCents: s.revenueCents }))
      .sort((x, y) => y.revenueCents - x.revenueCents);

    const campaignRows: TrafficCampaignRow[] = Array.from(campaigns.values())
      .map((c) => ({ campaign: c.campaign, vendor: c.vendor, calls: c.calls, bookings: c.bookings, revenueCents: c.revenueCents, conversionPct: pct(c.bookings, c.calls) }))
      .sort((x, y) => y.revenueCents - x.revenueCents);

    const buyerRows: TrafficBuyerRow[] = Array.from(buyers.entries())
      .map(([buyer, a]) => ({ buyer, callsDelivered: a.calls, revenueCents: a.revenueCents, conversionPct: pct(a.bookings, a.calls), qualityPct: pct(a.qualified, a.calls) }))
      .sort((x, y) => y.revenueCents - x.revenueCents);

    return { vendors: vendorRows, sources: sourceRows, campaigns: campaignRows, buyers: buyerRows };
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
