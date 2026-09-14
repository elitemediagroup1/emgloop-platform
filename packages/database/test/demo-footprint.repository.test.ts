// DemoFootprintRepository -- fingerprints, attribution, dependencies, tenancy,
// and that nothing identifying or writable leaves the reader.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DemoFootprintRepository, DEMO_FOOTPRINT_BOUND } from '../src/repositories/demo-footprint.repository';

const ORG = 'org_live';
const OTHER = 'org_other';
const T = (n: number) => new Date(Date.UTC(2026, 6, 1, 12, n));

type Row = Record<string, unknown>;

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Row[]).some((w) => matches(row, w));
    if (key === 'AND') return (cond as Row[]).every((w) => matches(row, w));
    const value = row[key];
    if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
      const c = cond as Row;
      if ('path' in c) {
        const at = (c.path as string[]).reduce<unknown>((o, p) => (o && typeof o === 'object' ? (o as Row)[p] : undefined), value);
        return at === c.equals;
      }
      if ('in' in c) return (c.in as unknown[]).includes(value);
      if ('startsWith' in c) return typeof value === 'string' && value.startsWith(c.startsWith as string);
      if ('endsWith' in c) return typeof value === 'string' && value.endsWith(c.endsWith as string);
      return false;
    }
    return value === cond;
  });
}

function fakePrisma(tables: Record<string, Row[]>) {
  const calls: { model: string; method: string; where: Row }[] = [];
  const pick = (row: Row, select?: Record<string, boolean>) =>
    select ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k] ?? null])) : row;
  const model = (name: string) => ({
    findMany: async (args: { where?: Row; select?: Record<string, boolean>; take?: number }) => {
      calls.push({ model: name, method: 'findMany', where: args.where ?? {} });
      const rows = (tables[name] ?? []).filter((r) => matches(r, args.where));
      return rows.slice(0, args.take ?? rows.length).map((r) => pick(r, args.select));
    },
    findUnique: async (args: { where: Row; select?: Record<string, boolean> }) => {
      calls.push({ model: name, method: 'findUnique', where: args.where });
      const row = (tables[name] ?? []).find((r) => matches(r, args.where));
      return row ? pick(row, args.select) : null;
    },
  });
  const client = new Proxy({}, { get: (_t, name: string) => model(name) });
  return { client: client as never, calls };
}

/** One journey exactly as the removed web demo loop wrote it. */
function webDemoJourney(org: string, suffix: string): Record<string, Row[]> {
  const c = `cust_web_${suffix}`;
  return {
    customer: [{ id: c, organizationId: org, createdAt: T(1), firstName: 'Demo', lastName: 'Customer', email: 'demo@example.com', phone: '+15555550000', externalId: null }],
    interaction: [
      { id: `ix_q_${suffix}`, organizationId: org, customerId: c, provider: null, externalId: null, createdAt: T(1), payload: { loopKind: 'quote_request', actorType: 'customer' } },
      { id: `ix_a_${suffix}`, organizationId: org, customerId: c, provider: null, externalId: null, createdAt: T(1), payload: { loopKind: 'assignment', actorType: 'system' } },
      { id: `ix_o_${suffix}`, organizationId: org, customerId: c, provider: 'mock', externalId: `mock-sms-${suffix}`, createdAt: T(1), payload: { loopKind: 'outbound_message' } },
      { id: `ix_i_${suffix}`, organizationId: org, customerId: c, provider: null, externalId: null, createdAt: T(1), payload: { loopKind: 'inbound_message', body: 'Yes, tomorrow morning works great!' } },
      { id: `ix_bc_${suffix}`, organizationId: org, customerId: c, provider: null, externalId: null, createdAt: T(1), payload: { loopKind: 'booking_confirmed' } },
    ],
    conversation: [{ id: `conv_${suffix}`, organizationId: org, customerId: c }],
    message: [
      { id: `msg_out_${suffix}`, organizationId: org, conversationId: `conv_${suffix}`, externalId: `mock-sms-${suffix}`, body: 'We can come tomorrow.', createdAt: T(1) },
      { id: `msg_in_${suffix}`, organizationId: org, conversationId: `conv_${suffix}`, externalId: null, body: 'Yes, tomorrow morning works great!', createdAt: T(1) },
    ],
    booking: [{ id: `bk_${suffix}`, organizationId: org, customerId: c, calendarProvider: 'mock', calendarEventId: `mock-cal-${suffix}`, createdAt: T(1) }],
    signal: [{ id: `sig_${suffix}`, organizationId: org, customerId: c }],
    domainEvent: [
      { id: `ev_c_${suffix}`, organizationId: org, aggregateId: c },
      { id: `ev_b_${suffix}`, organizationId: org, aggregateId: `bk_${suffix}` },
    ],
  };
}

function merge(...sets: Record<string, Row[]>[]): Record<string, Row[]> {
  const out: Record<string, Row[]> = {};
  for (const s of sets) for (const [k, rows] of Object.entries(s)) out[k] = [...(out[k] ?? []), ...rows];
  return out;
}

const orgRow = { organization: [{ id: ORG, name: 'ServicesInMyCity (Demo)', createdAt: T(0) }] };

test('a web demo loop journey is attributed, flagged and fully enumerated', async () => {
  const { client } = fakePrisma(merge(orgRow, webDemoJourney(ORG, 'a')));
  const f = await new DemoFootprintRepository(client).footprint(ORG);
  assert.equal(f.suspects.length, 1);
  const s = f.suspects[0]!;
  assert.equal(s.id, 'cust_web_a');
  assert.equal(s.attribution, 'WEB_DEMO_LOOP');
  for (const flag of ['MOCK_SMS_INTERACTION', 'DEMO_LOOP_KIND', 'MOCK_SMS_MESSAGE', 'SCRIPTED_REPLY', 'MOCK_CALENDAR_BOOKING', 'EMAIL_DEMO_FORM_DEFAULT', 'PHONE_DEMO_FORM_DEFAULT', 'NAME_DEMO_FORM_DEFAULT', 'RESERVED_EMAIL_DOMAIN']) {
    assert.ok(s.flags.includes(flag), flag);
  }
  assert.deepEqual(s.legitimacySignals, []);
  assert.equal(s.dependencies.interactions.length, 5);
  assert.equal(s.dependencies.demoInteractions.length, 5);
  assert.deepEqual(s.dependencies.bookings, ['bk_a']);
  assert.deepEqual(s.dependencies.mockBookings, ['bk_a']);
  assert.deepEqual(s.dependencies.messages.sort(), ['msg_in_a', 'msg_out_a']);
  assert.deepEqual(s.dependencies.domainEvents.sort(), ['ev_b_a', 'ev_c_a'], 'events on the customer and on its booking');
  assert.deepEqual(s.dependencies.signals, ['sig_a']);
  assert.equal(f.organization?.nameMatchesSeedUpsert, true);
  assert.equal(f.exceededBound, false);
});

test('a Prisma seed sample is attributed to the seed, not to the public routes', async () => {
  const { client } = fakePrisma(merge(orgRow, {
    customer: [{ id: 'cust_seed', organizationId: ORG, createdAt: T(2), firstName: 'Maria', lastName: 'Gonzalez', email: 'maria@example.com', phone: '+15125550133', externalId: 'sic-demo-maria' }],
    interaction: [{ id: 'ix_seed', organizationId: ORG, customerId: 'cust_seed', provider: null, externalId: null, createdAt: T(2), payload: { loopKind: 'quote_request' } }],
  }));
  const [s] = (await new DemoFootprintRepository(client).footprint(ORG)).suspects;
  assert.equal(s!.attribution, 'PRISMA_SEED');
  assert.ok(s!.flags.includes('SEED_SAMPLE_EXTERNAL_ID'));
  assert.ok(s!.flags.includes('QUOTE_REQUEST_LOOP_KIND'));
  assert.equal(s!.flags.includes('DEMO_LOOP_KIND'), false);
});

test('a real ingested customer with no fingerprint is not a suspect', async () => {
  const { client } = fakePrisma(merge(orgRow, {
    customer: [{ id: 'cust_real', organizationId: ORG, createdAt: T(3), firstName: 'Real', lastName: 'Caller', email: 'caller@gmail.test', phone: '+13125551234', externalId: 'cg_123' }],
    interaction: [{ id: 'ix_real', organizationId: ORG, customerId: 'cust_real', provider: 'callgrid', externalId: 'cg-call-9', createdAt: T(3), payload: { actorType: 'CUSTOMER' } }],
    booking: [{ id: 'bk_real', organizationId: ORG, customerId: 'cust_real', calendarProvider: 'google', calendarEventId: 'g-1', createdAt: T(3) }],
  }));
  const f = await new DemoFootprintRepository(client).footprint(ORG);
  assert.equal(f.suspects.length, 0);
  assert.equal(f.orphans.length, 0);
});

test('work done on a fingerprinted record surfaces as legitimacy signals', async () => {
  const journey = webDemoJourney(ORG, 'b');
  const { client } = fakePrisma(merge(orgRow, journey, {
    interaction: [{ id: 'ix_note', organizationId: ORG, customerId: 'cust_web_b', provider: null, externalId: null, createdAt: T(9), payload: { loopKind: 'crm_note', actorUserId: 'user_1' } }],
    order: [{ id: 'ord_1', organizationId: ORG, customerId: 'cust_web_b' }],
    auditLog: [
      { id: 'aud_h', organizationId: ORG, entityId: 'cust_web_b', userId: 'user_1' },
      { id: 'aud_s', organizationId: ORG, entityId: 'cust_web_b', userId: null },
    ],
    customerPartyLink: [{ id: 'pl_1', organizationId: ORG, customerId: 'cust_web_b' }],
  }));
  const [s] = (await new DemoFootprintRepository(client).footprint(ORG)).suspects;
  assert.deepEqual(s!.legitimacySignals.sort(), ['HUMAN_AUDIT_ENTRIES', 'NON_DEMO_INTERACTIONS', 'ORDERS', 'PARTY_LINKS']);
  assert.deepEqual(s!.dependencies.humanAuditEntries, ['aud_h']);
  assert.deepEqual(s!.dependencies.partyLinks, ['pl_1']);
});

test('another organization\'s identical rows are never read or returned', async () => {
  const { client, calls } = fakePrisma(merge(orgRow, webDemoJourney(ORG, 'mine'), webDemoJourney(OTHER, 'theirs')));
  const f = await new DemoFootprintRepository(client).footprint(ORG);
  assert.deepEqual(f.suspects.map((s) => s.id), ['cust_web_mine']);
  const everyId = JSON.stringify(f);
  assert.equal(everyId.includes('theirs'), false);
  for (const c of calls.filter((c) => c.model !== 'organization')) {
    assert.equal(c.where.organizationId, ORG, `${c.model}.${c.method} is scoped to the organization`);
  }
});

test('fingerprinted rows without a suspected customer are reported as orphans', async () => {
  const { client } = fakePrisma(merge(orgRow, {
    booking: [{ id: 'bk_orphan', organizationId: ORG, customerId: null, calendarProvider: 'mock', calendarEventId: 'mock-cal-9', createdAt: T(4) }],
    interaction: [{ id: 'ix_orphan', organizationId: ORG, customerId: null, provider: 'mock', externalId: 'mock-sms-9', createdAt: T(4), payload: {} }],
  }));
  const f = await new DemoFootprintRepository(client).footprint(ORG);
  assert.deepEqual(f.orphans.map((o) => `${o.table}:${o.id}:${o.reason}`).sort(), [
    'booking:bk_orphan:NO_CUSTOMER',
    'interaction:ix_orphan:NO_CUSTOMER',
  ]);
});

test('no name, email, phone number or message body leaves the reader', async () => {
  const { client } = fakePrisma(merge(orgRow, webDemoJourney(ORG, 'pii'), {
    customer: [{ id: 'cust_seed', organizationId: ORG, createdAt: T(2), firstName: 'Maria', lastName: 'Gonzalez', email: 'maria@example.com', phone: '+15125550133', externalId: 'sic-demo-maria' }],
  }));
  const out = JSON.stringify(await new DemoFootprintRepository(client).footprint(ORG));
  for (const secret of ['Demo', 'Customer"', 'demo@example.com', '+15555550000', 'Maria', 'Gonzalez', 'maria@example.com', '+15125550133', 'tomorrow morning', 'We can come', 'sic-demo-maria']) {
    assert.equal(out.includes(secret), false, `leaked ${secret}`);
  }
});

test('past the bound the answer is marked incomplete', async () => {
  const many: Row[] = Array.from({ length: DEMO_FOOTPRINT_BOUND + 1 }, (_, i) => ({
    id: `ix_${i}`, organizationId: ORG, customerId: null, provider: 'mock', externalId: `mock-sms-${i}`, createdAt: T(5), payload: {},
  }));
  const { client } = fakePrisma(merge(orgRow, { interaction: many }));
  const f = await new DemoFootprintRepository(client).footprint(ORG);
  assert.equal(f.exceededBound, true);
  assert.equal(f.totals.markedInteractions, DEMO_FOOTPRINT_BOUND);
});

test('the reader contains no write, raw-query or network call', () => {
  const src = readFileSync(new URL('../src/repositories/demo-footprint.repository.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const symbol of ['create(', 'update(', 'upsert(', 'delete(', 'createMany(', 'updateMany(', 'deleteMany(', '$executeRaw', '$queryRaw', '$transaction', 'fetch(']) {
    assert.equal(src.includes(symbol), false, symbol);
  }
});
