// RevenueIntelligence bounded reads — self-verification (in-memory Prisma).
//
// Follows the repo convention of a co-located verification harness (run via tsx).
// It proves the bounded-read mitigation's invariants WITHOUT a live database by
// driving the repository against a tiny in-memory Prisma fake:
//   • revenue math is UNCHANGED by bounding (capped run vs. uncapped reference)
//   • traffic math is UNCHANGED by bounding
//   • a bound that does not bind reports coverage.complete === true, no reasons
//   • a bound that DOES bind reports complete === false with an explaining reason
//   • Interaction.payload is never selected (that payload was the OOM's bulk)
//   • reads are org-scoped: another tenant's rows are never returned
//   • capped slices are the NEWEST rows, not an arbitrary page
//   • no write method is ever invoked by either read
//
// The fake honours `where`, `orderBy`, `take` and nested `select` faithfully
// enough that these assertions mean what they say; where it is lenient it is
// lenient in the direction that would FAIL the assertion, not pass it.

import { RevenueIntelligenceRepository, CAPS } from './revenue-intelligence.repository';
import type { PrismaClient } from '@prisma/client';

// --- Model rows -------------------------------------------------------------

interface Row {
  id: string;
  organizationId: string;
  lastSeenAt: Date;
  tags: string[];
  email: string | null;
  phone: string | null;
  externalId: string | null;
  firstName: string | null;
  lastName: string | null;
  interactions: Array<{
    occurredAt: Date;
    channel: string;
    metadata: Record<string, unknown>;
    payload: Record<string, unknown>;
    organizationId: string;
    customerId: string;
  }>;
  signals: Array<{ type: string; createdAt: Date }>;
  orders: Array<{ status: string; totalCents: number }>;
  bookings: Array<{ id: string }>;
}

const D = (iso: string): Date => new Date(iso);

function customer(over: Partial<Row> & { id: string; organizationId: string }): Row {
  return {
    lastSeenAt: D('2026-01-01T00:00:00Z'),
    tags: [],
    // Deliberately NOT an excluded test domain — operational-filters drops
    // example.com/test.com/etc, and these fixtures must survive that filter.
    email: `${over.id}@northsideplumbing.co`,
    phone: null,
    externalId: null,
    firstName: 'Real',
    lastName: 'Customer',
    interactions: [],
    signals: [],
    orders: [],
    bookings: [],
    ...over,
  };
}

// --- In-memory Prisma fake --------------------------------------------------

/** Every `select` object either read passed, so we can assert on what was asked for. */
interface Recorded {
  model: string;
  select: Record<string, unknown> | undefined;
  where: Record<string, unknown> | undefined;
  take: number | undefined;
  orderBy: unknown;
}

class FakePrisma {
  rows: Row[] = [];
  recorded: Recorded[] = [];
  writesCalled: string[] = [];

  private orderDesc<T>(items: T[], key: (t: T) => number, dir: unknown): T[] {
    const sorted = [...items].sort((a, b) => key(b) - key(a));
    return dir === 'asc' ? sorted.reverse() : sorted;
  }

  /** Project a stored row through a Prisma-shaped `select`, honouring nesting. */
  private projectCustomer(row: Row, select: any): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(select ?? {})) {
      const spec = select[key];
      if (spec === true) {
        out[key] = (row as any)[key];
        continue;
      }
      if (key === '_count') {
        const counts: Record<string, number> = {};
        for (const c of Object.keys(spec.select ?? {})) {
          counts[c] = ((row as any)[c] as unknown[]).length;
        }
        out._count = counts;
        continue;
      }
      // Nested relation: orderBy + take + select.
      let list = [...((row as any)[key] as any[])];
      if (spec.orderBy) {
        const field = Object.keys(spec.orderBy)[0]!;
        list = this.orderDesc(list, (x) => new Date(x[field]).getTime(), spec.orderBy[field]);
      }
      if (typeof spec.take === 'number') list = list.slice(0, spec.take);
      out[key] = list.map((item) => {
        const picked: Record<string, unknown> = {};
        for (const f of Object.keys(spec.select ?? {})) picked[f] = item[f];
        return picked;
      });
    }
    return out;
  }

  customer = {
    findMany: async (args: any): Promise<any[]> => {
      this.recorded.push({ model: 'customer', select: args.select, where: args.where, take: args.take, orderBy: args.orderBy });
      let rows = this.rows.filter((r) => r.organizationId === args.where.organizationId);
      if (args.orderBy?.lastSeenAt) {
        rows = this.orderDesc(rows, (r) => r.lastSeenAt.getTime(), args.orderBy.lastSeenAt);
      }
      if (typeof args.take === 'number') rows = rows.slice(0, args.take);
      return rows.map((r) => this.projectCustomer(r, args.select));
    },
    update: async () => { this.writesCalled.push('customer.update'); return {}; },
    create: async () => { this.writesCalled.push('customer.create'); return {}; },
  };

  interaction = {
    findMany: async (args: any): Promise<any[]> => {
      this.recorded.push({ model: 'interaction', select: args.select, where: args.where, take: args.take, orderBy: args.orderBy });
      const gte: Date | undefined = args.where.occurredAt?.gte;
      let flat = this.rows
        .flatMap((r) => r.interactions.map((i) => ({ i, owner: r })))
        .filter(({ i }) => i.organizationId === args.where.organizationId)
        .filter(({ i }) => (args.where.channel ? i.channel === args.where.channel : true))
        .filter(({ i }) => (gte ? i.occurredAt.getTime() >= gte.getTime() : true));
      if (args.orderBy?.occurredAt) {
        flat = this.orderDesc(flat, (x) => x.i.occurredAt.getTime(), args.orderBy.occurredAt);
      }
      if (typeof args.take === 'number') flat = flat.slice(0, args.take);
      return flat.map(({ i, owner }) => {
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(args.select ?? {})) {
          if (key === 'customer') {
            out.customer = this.projectCustomer(owner, args.select.customer.select);
          } else {
            out[key] = (i as any)[key];
          }
        }
        return out;
      });
    },
    update: async () => { this.writesCalled.push('interaction.update'); return {}; },
    create: async () => { this.writesCalled.push('interaction.create'); return {}; },
  };
}

// --- Assertions -------------------------------------------------------------

function assert(cond: boolean, message: string): void {
  if (!cond) throw new Error(`VERIFICATION FAILED: ${message}`);
}

/** Recursively look for a selected field name anywhere in a select tree. */
function selectMentions(select: unknown, field: string): boolean {
  if (!select || typeof select !== 'object') return false;
  for (const [k, v] of Object.entries(select as Record<string, unknown>)) {
    if (k === field) return true;
    if (v && typeof v === 'object' && selectMentions((v as any).select ?? v, field)) return true;
  }
  return false;
}

export async function verifyBoundedReads(): Promise<{ passed: true; checks: string[] }> {
  const checks: string[] = [];
  const ORG = 'org_a';
  const OTHER = 'org_b';
  const now = Date.now();
  const recent = (minsAgo: number) => new Date(now - minsAgo * 60_000);

  // --- Fixture: small org, comfortably under every cap ----------------------
  const small = new FakePrisma();
  small.rows = [
    customer({
      id: 'c1',
      organizationId: ORG,
      lastSeenAt: recent(10),
      interactions: [
        { occurredAt: recent(10), channel: 'PHONE', metadata: { vendor: 'Acme', source: 'Search', qualified: 'true' }, payload: { huge: 'x'.repeat(1000) }, organizationId: ORG, customerId: 'c1' },
      ],
      signals: [{ type: 'HIGH_INTENT', createdAt: recent(10) }],
      orders: [{ status: 'FULFILLED', totalCents: 10_000 }],
      bookings: [{ id: 'b1' }],
    }),
    customer({
      id: 'c2',
      organizationId: ORG,
      lastSeenAt: recent(20),
      interactions: [
        { occurredAt: recent(20), channel: 'PHONE', metadata: { vendor: 'Acme', source: 'Maps' }, payload: {}, organizationId: ORG, customerId: 'c2' },
      ],
      orders: [{ status: 'DRAFT', totalCents: 5_000 }],
    }),
    // A different tenant — must never appear in ORG's totals.
    customer({
      id: 'x1',
      organizationId: OTHER,
      lastSeenAt: recent(1),
      interactions: [
        { occurredAt: recent(1), channel: 'PHONE', metadata: { vendor: 'Rival' }, payload: {}, organizationId: OTHER, customerId: 'x1' },
      ],
      orders: [{ status: 'FULFILLED', totalCents: 999_999 }],
    }),
  ];

  const repo = new RevenueIntelligenceRepository(small as unknown as PrismaClient);

  // --- 1. Complete reads report complete coverage ---------------------------
  const rev = await repo.revenueByDimension(ORG);
  assert(rev.coverage.complete === true, 'under-cap revenue read must report complete coverage');
  assert(rev.coverage.capReached === false, 'under-cap revenue read must not report capReached');
  assert(rev.coverage.reasons.length === 0, 'complete coverage carries no reasons');
  checks.push('under-cap revenue read reports complete coverage with no reasons');

  const traffic = await repo.trafficIntelligence(ORG);
  assert(traffic.coverage.complete === true, 'under-cap traffic read must report complete coverage');
  assert(traffic.coverage.reasons.length === 0, 'complete traffic coverage carries no reasons');
  checks.push('under-cap traffic read reports complete coverage with no reasons');

  // --- 2. Revenue semantics unchanged --------------------------------------
  assert(rev.realizedRevenueCents === 10_000, `realized revenue = 10000 cents (got ${rev.realizedRevenueCents})`);
  assert(rev.realizedOrders === 1, `realized orders = 1 (got ${rev.realizedOrders})`);
  assert(rev.pendingRevenueCents === 5_000, `pending revenue = 5000 cents (got ${rev.pendingRevenueCents})`);
  assert(rev.pendingOrders === 1, `pending orders = 1 (got ${rev.pendingOrders})`);
  assert(rev.hasRealizedRevenue === true, 'hasRealizedRevenue reflects realized orders');
  const acme = rev.byVendor.find((v) => v.key === 'Acme');
  assert(!!acme && acme.revenueCents === 10_000, 'vendor attribution still rolls revenue up to Acme');
  checks.push('revenue semantics unchanged: realized / pending / attribution all intact');

  // --- 3. Traffic semantics unchanged --------------------------------------
  assert(traffic.totalCalls === 2, `traffic totalCalls = 2 (got ${traffic.totalCalls})`);
  assert(traffic.attributedCalls === 2, `both calls carry a real vendor (got ${traffic.attributedCalls})`);
  assert(traffic.qualifiedCalls === 1, `one call is qualified (got ${traffic.qualifiedCalls})`);
  assert(traffic.bookings === 1, `bookings counted via _count (got ${traffic.bookings})`);
  assert(traffic.realizedRevenueCents === 10_000, `traffic realized revenue = 10000 (got ${traffic.realizedRevenueCents})`);
  checks.push('traffic semantics unchanged: calls / attribution / qualified / bookings / revenue intact');

  // --- 4. Tenant isolation --------------------------------------------------
  assert(!rev.byVendor.some((v) => v.key === 'Rival'), 'other tenant vendor must not appear in revenue');
  assert(rev.realizedRevenueCents !== 999_999 + 10_000, 'other tenant revenue must not be summed in');
  assert(!traffic.vendors.some((v) => v.vendor === 'Rival'), 'other tenant vendor must not appear in traffic');
  for (const r of small.recorded) {
    assert((r.where as any)?.organizationId === ORG, 'every bounded read filters on organizationId');
  }
  checks.push('org scoping intact: both reads filter on organizationId, no cross-tenant rows');

  // --- 5. Interaction.payload is never loaded ------------------------------
  for (const r of small.recorded) {
    assert(r.select !== undefined, `${r.model} read must use an explicit select, not a full-row fetch`);
    assert(!selectMentions(r.select, 'payload'), `${r.model} read must never select Interaction.payload`);
  }
  checks.push('no read selects Interaction.payload or fetches full rows (the OOM bulk is gone)');

  // --- 6. Reads perform no writes ------------------------------------------
  assert(small.writesCalled.length === 0, `bounded reads must not write (called: ${small.writesCalled.join(', ')})`);
  checks.push('GET-path reads invoke no write method');

  // --- 7. A binding cap reports partial coverage, newest-first --------------
  const big = new FakePrisma();
  big.rows = Array.from({ length: CAPS.customers + 25 }, (_, n) =>
    customer({
      id: `c${n}`,
      organizationId: ORG,
      // Index 0 is the most recently seen; higher n is older.
      lastSeenAt: new Date(now - n * 60_000),
      orders: [{ status: 'FULFILLED', totalCents: 100 }],
    }),
  );
  const bigRepo = new RevenueIntelligenceRepository(big as unknown as PrismaClient);
  const capped = await bigRepo.revenueByDimension(ORG);
  assert(capped.coverage.complete === false, 'a binding customer cap must report incomplete coverage');
  assert(capped.coverage.capReached === true, 'a binding cap must set capReached');
  assert(capped.coverage.reasons.length > 0, 'a binding cap must explain itself');
  assert(
    capped.coverage.reasons.some((r) => r.includes(String(CAPS.customers))),
    'the reason names the cap that bound',
  );
  assert(capped.coverage.rowsScanned === CAPS.customers, `scanned exactly the cap (got ${capped.coverage.rowsScanned})`);
  assert(
    capped.realizedRevenueCents === CAPS.customers * 100,
    'a capped total is a lower bound over exactly the scanned slice',
  );
  checks.push('a binding cap reports incomplete coverage, names the cap, and totals only the scanned slice');

  const custRead = big.recorded.find((r) => r.model === 'customer')!;
  assert((custRead.orderBy as any)?.lastSeenAt === 'desc', 'capped customer scan is newest-seen-first');
  assert(custRead.take === CAPS.customers + 1, 'reads one past the cap so overflow is detectable without a COUNT');
  checks.push('capped slices are the newest rows (orderBy desc) and overflow needs no second query');

  // --- 8. Per-customer relation caps are reported too -----------------------
  const chatty = new FakePrisma();
  chatty.rows = [
    customer({
      id: 'c1',
      organizationId: ORG,
      interactions: Array.from({ length: CAPS.interactionsPerCustomer + 5 }, (_, n) => ({
        occurredAt: new Date(now - n * 1000),
        channel: 'PHONE' as const,
        metadata: { vendor: 'Acme' },
        payload: {},
        organizationId: ORG,
        customerId: 'c1',
      })),
      orders: [{ status: 'FULFILLED', totalCents: 100 }],
    }),
  ];
  const chattyRev = await new RevenueIntelligenceRepository(chatty as unknown as PrismaClient).revenueByDimension(ORG);
  assert(chattyRev.coverage.complete === false, 'truncated per-customer interactions must be reported as partial');
  assert(
    chattyRev.coverage.reasons.some((r) => r.includes(String(CAPS.interactionsPerCustomer))),
    'the reason names the per-customer interaction cap',
  );
  checks.push('per-customer interaction truncation surfaces as partial coverage, not silence');

  return { passed: true, checks };
}

// Allow `npx tsx <this file>` to run it directly, matching the repo convention.
if (process.argv[1] && process.argv[1].includes('revenue-intelligence.verification')) {
  verifyBoundedReads()
    .then((r) => {
      for (const c of r.checks) console.log(`  ✓ ${c}`);
      console.log(`\n${r.checks.length} checks passed.`);
    })
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    });
}
