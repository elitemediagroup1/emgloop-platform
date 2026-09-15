// Ingestion records facts. It never decides who someone is.
//
// Loop's identity architecture is Source -> Event / Interaction -> Identity
// Evidence -> Governed Resolution -> Party / Person. Ingestion is the first two
// arrows and nothing else. It used to resolve a Customer for every event instead:
// a caller number matched whichever Customer shared its last seven digits, an
// email matched the first Customer holding it, a withheld caller ID created a new
// Customer on every call, every anonymous website visitor became a Customer, and
// the event workflows then reset the matched Customer's intake status. People
// filled with callers and visitors nobody had identified.
//
// THESE TESTS DRIVE THE REAL PIPELINE. Real CallGrid and website payloads go
// through the shipped adapters and the real IngestionService (normalization,
// MarketplaceCall projection, signal registry, next-best-action, event
// workflows) against an in-memory Prisma double whose Customer table records
// every touch. The claim is not "no Customer was created"; it is "ingestion never
// reached the Customer table at all" -- no create, no lookup, no update.
//
// The source fence at the bottom holds the same line structurally, over every
// file an ingestion path runs through, so a resolver cannot come back unseen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CallGridProvider,
  WebsiteProvider,
  mapCallgridEventType,
  mapWebsiteEventType,
} from '@emgloop/providers';
import { IngestionService } from '../src/services/ingestion.service';
import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';

const ORG = 'org_live';
const CALLED_AT_MS = Date.UTC(2026, 8, 15, 14, 5, 0);

type Row = Record<string, any>;

/** The former seeded call workflows: customer steps only. */
const CALL_WORKFLOWS: Row[] = [
  {
    name: 'New inbound call — first touch',
    trigger: 'EVENT',
    isActive: true,
    triggerConfig: { eventName: 'integration.call.inbound' },
    definition: {
      steps: [
        { type: 'add_tag', config: { tag: 'inbound-call' } },
        { type: 'set_pipeline_status', config: { status: 'New' } },
      ],
    },
  },
  {
    name: 'Missed call — recovery',
    trigger: 'EVENT',
    isActive: true,
    triggerConfig: { eventName: 'integration.call.missed' },
    definition: {
      steps: [
        { type: 'add_tag', config: { tag: 'missed-call' } },
        { type: 'set_pipeline_status', config: { status: 'Contacted' } },
        { type: 'create_note', config: { text: 'Missed inbound call — return promptly.' } },
      ],
    },
  },
];

async function harness(seed: { customers?: Row[]; workflows?: Row[] } = {}) {
  const prisma: Row = makeCognitivePrisma({
    also: [
      'customer',
      'interaction',
      'signal',
      'workflow',
      'workflowRun',
      'integrationEvent',
      'domainEvent',
      'marketplaceCall',
    ],
  });

  // MarketplaceCall is upserted on its named compound unique; the double matches
  // plain columns, so the key is unwrapped here exactly as Postgres reads it.
  const upsert = prisma.marketplaceCall.upsert.bind(prisma.marketplaceCall);
  prisma.marketplaceCall.upsert = (args: Row) =>
    upsert({ ...args, where: args.where.provider_externalId ?? args.where });

  for (const c of seed.customers ?? []) {
    await prisma.customer.create({ data: { organizationId: ORG, ...c } });
  }
  for (const w of seed.workflows ?? []) {
    await prisma.workflow.create({ data: { organizationId: ORG, ...w } });
  }

  // Every property read on the Customer delegate is recorded from here on. An
  // ingestion path that so much as names prisma.customer shows up in this list.
  const customers = prisma.customer;
  const customersBefore = structuredClone(customers.__rows);
  const customerTouches: string[] = [];
  prisma.customer = new Proxy(customers, {
    get(target, prop) {
      customerTouches.push(String(prop));
      return target[prop as keyof typeof target];
    },
  });

  const service = new IngestionService(prisma as never);
  const rows = (delegate: string): Row[] =>
    delegate === 'customer' ? customers.__rows : prisma[delegate].__rows;

  return { prisma, service, rows, customerTouches, customersBefore };
}

type Harness = Awaited<ReturnType<typeof harness>>;

async function ingestCallGrid(h: Harness, body: Row) {
  const events = await new CallGridProvider().parseWebhook({ organizationId: ORG } as never, body);
  return h.service.ingest({
    organizationId: ORG,
    provider: 'callgrid',
    providerConnectionId: null,
    mapEventType: mapCallgridEventType,
    events,
    observationSource: 'WEBHOOK',
  });
}

async function ingestWebsite(h: Harness, body: Row) {
  const events = await new WebsiteProvider().parseWebhook({ organizationId: ORG } as never, body);
  return h.service.ingest({
    organizationId: ORG,
    provider: 'website',
    providerConnectionId: null,
    mapEventType: mapWebsiteEventType,
    events,
    observationSource: 'WEBHOOK',
  });
}

const call = (over: Row = {}): Row => ({
  id: 'cg-call-1',
  callStatus: 'inbound',
  UTCUnixTimeMs: CALLED_AT_MS,
  callerId: '+13128675309',
  vendorId: 'v-1',
  vendorName: 'Northside Leads',
  sourceName: 'Search',
  campaignId: 'c-1',
  campaignName: 'Roof repair',
  buyerId: 'b-1',
  buyerName: 'Acme Roofing',
  revenue: 25.5,
  billable: true,
  durationSeconds: 94,
  ...over,
});

function assertNoCustomerReached(h: Harness) {
  assert.deepEqual(h.customerTouches, [], 'ingestion must never touch the Customer table');
  assert.deepEqual(h.rows('customer'), h.customersBefore, 'no Customer row created or changed');
}

// --- A caller ID is a fact, not a Person ----------------------------------------------

test('a call with only a caller ID is recorded in full, and no Customer is created or looked up', async () => {
  const h = await harness();
  const [result] = await ingestCallGrid(h, call());

  assert.equal(result!.status, 'processed');
  assert.ok(!('customerId' in result!), 'the ingestion result has no customer to report');
  assertNoCustomerReached(h);
  assert.equal(h.rows('customer').length, 0);

  const [event] = h.rows('integrationEvent');
  assert.equal(event!.status, 'PROCESSED');
  assert.equal(event!.payload.caller, '+13128675309', 'the raw event keeps the reported caller');

  const interactions = h.rows('interaction');
  assert.equal(interactions.length, 1);
  const interaction = interactions[0]!;
  assert.equal(interaction.customerId ?? null, null, 'the Interaction carries no customer');
  assert.equal(interaction.channel, 'PHONE');
  assert.equal(interaction.metadata.fromNumber, '+13128675309', 'the caller number is kept as a fact');
  assert.equal(interaction.metadata.caller, '+13128675309');

  const [projected] = h.rows('marketplaceCall');
  assert.ok(projected, 'the call is projected into MarketplaceCall');
  assert.equal(projected!.interactionId, interaction.id);
  assert.equal(projected!.vendorLabel, 'Northside Leads');
  assert.equal(projected!.buyerLabel, 'Acme Roofing');
  assert.equal(projected!.revenueCents, 2550);

  const signals = h.rows('signal');
  assert.ok(signals.some((s) => s.source === 'callgrid' && s.type === 'INTENT'), 'the event signal is written');
  const registry = signals.filter((s) => s.source === 'signal-registry');
  assert.ok(registry.length > 0, 'registry signals are written without a customer');
  for (const s of signals) assert.equal(s.customerId ?? null, null, 'no signal names a customer');
  for (const s of registry) assert.equal(s.metadata.interactionId, interaction.id, 'each names its Interaction');

  const domainEvents = h.rows('domainEvent');
  const fired = domainEvents.find((d) => d.name === 'integration.call.inbound');
  assert.ok(fired, 'the domain event is recorded');
  assert.ok(!('customerId' in fired!.payload), 'the domain event names no customer');
  for (const d of domainEvents) assert.notEqual(d.aggregateType, 'customer');
});

test('withheld caller IDs create no Customer, however many calls arrive', async () => {
  const h = await harness();
  await ingestCallGrid(h, call({ id: 'cg-anon-1', callerId: 'Anonymous' }));
  await ingestCallGrid(h, call({ id: 'cg-anon-2', callerId: 'Restricted' }));
  await ingestCallGrid(h, call({ id: 'cg-anon-3', callerId: undefined }));

  assertNoCustomerReached(h);
  assert.equal(h.rows('customer').length, 0, 'three withheld callers are not three People');
  assert.equal(h.rows('interaction').length, 3, 'all three calls are recorded');
  assert.equal(h.rows('integrationEvent').filter((e) => e.status === 'PROCESSED').length, 3);
  assert.equal(h.rows('marketplaceCall').length, 3);
});

// --- Existing People are neither matched nor changed ----------------------------------

const EXISTING: Row[] = [
  {
    id: 'cust_exact',
    firstName: 'Pat',
    lastName: 'Rivera',
    phone: '+13128675309',
    email: 'pat@northsideplumbing.co',
    tags: ['lead'],
    attributes: { pipelineStatus: 'Booked', assignedHumanName: 'Jordan' },
  },
  {
    // Shares only the last seven digits: a different area code, a different person.
    id: 'cust_last_seven',
    phone: '(213) 867-5309',
    tags: [],
    attributes: { pipelineStatus: 'Quoted' },
  },
];

test('a call from a number that matches existing People attaches to none of them and changes none of them', async () => {
  const h = await harness({ customers: EXISTING, workflows: CALL_WORKFLOWS });
  await ingestCallGrid(h, call({ id: 'cg-known-1', callStatus: 'inbound' }));
  await ingestCallGrid(h, call({ id: 'cg-known-2', callStatus: 'no_answer' }));

  assertNoCustomerReached(h);
  const interactions = h.rows('interaction');
  assert.equal(interactions.length, 2, 'both calls are recorded');
  for (const i of interactions) assert.equal(i.customerId ?? null, null, 'neither call is attached to a Person');
  assert.equal(interactions.filter((i) => i.kind === 'NOTE').length, 0, 'no note is written to anyone');

  // The customer-step call workflows matched the events and applied to nothing.
  assert.equal(h.rows('workflowRun').length, 0, 'no workflow run: none of its steps applies without a customer');
  assert.equal(h.rows('workflowRun').filter((r) => r.status === 'FAILED').length, 0);

  const booked = h.rows('customer').find((c) => c.id === 'cust_exact')!;
  assert.equal(booked.attributes.pipelineStatus, 'Booked', 'an operator-set status is not reset to New');
  assert.deepEqual(booked.tags, ['lead'], 'no inbound-call or missed-call tag is added');
});

test('a website form whose email and phone match an existing Person is recorded and matched against nobody', async () => {
  const h = await harness({ customers: EXISTING });
  await ingestWebsite(h, {
    property: 'servicesinmycity',
    events: [
      {
        id: 'web-form-1',
        event: 'form_submitted',
        email: 'pat@northsideplumbing.co',
        phone: '+13128675309',
        name: 'Pat Rivera',
        visitor_id: 'v-42',
        session_id: 's-42',
        timestamp: new Date(CALLED_AT_MS).toISOString(),
      },
    ],
  });

  assertNoCustomerReached(h);
  const [interaction] = h.rows('interaction');
  assert.ok(interaction, 'the submission is recorded as an Interaction');
  assert.equal(interaction!.customerId ?? null, null);
  assert.equal(interaction!.kind, 'FORM_SUBMISSION');
  assert.equal(interaction!.metadata.email, 'pat@northsideplumbing.co', 'what was submitted is kept as a fact');
  assert.equal(interaction!.metadata.phone, '+13128675309');
  assert.equal(interaction!.metadata.visitorId, 'v-42');
  assert.ok(h.rows('signal').some((s) => s.type === 'INTENT'), 'the intent signal is still written');
});

// --- Anonymous stays anonymous -----------------------------------------------------------

test('anonymous website activity creates no Person, and keeps its visitor and session ids as facts', async () => {
  const h = await harness();
  await ingestWebsite(h, {
    property: 'servicesinmycity',
    events: [
      { id: 'web-v-1', event: 'search', query: 'roof repair', visitor_id: 'v-123', session_id: 's-9', timestamp: new Date(CALLED_AT_MS).toISOString() },
      { id: 'web-v-2', event: 'cta_click', cta: 'Get quotes', visitor_id: 'v-123', session_id: 's-9', timestamp: new Date(CALLED_AT_MS + 1000).toISOString() },
      { id: 'web-v-3', event: 'page_viewed', page: '/roofing', visitor_id: 'v-123', session_id: 's-9', timestamp: new Date(CALLED_AT_MS + 2000).toISOString() },
    ],
  });

  assertNoCustomerReached(h);
  assert.equal(h.rows('customer').length, 0, 'no anonymous visitor profile');
  assert.equal(h.rows('integrationEvent').filter((e) => e.status === 'PROCESSED').length, 3, 'every event is recorded');
  const interactions = h.rows('interaction');
  assert.equal(interactions.length, 2, 'the search and the CTA click become Interactions');
  for (const i of interactions) {
    assert.equal(i.customerId ?? null, null);
    assert.equal(i.metadata.visitorId, 'v-123');
    assert.equal(i.metadata.sessionId, 's-9');
  }
  assert.ok(h.rows('signal').filter((s) => s.source === 'signal-registry').length > 0, 'website signals are still derived');
});

// --- Redelivery ------------------------------------------------------------------------

test('redelivering a call records it once and still reaches no Customer', async () => {
  const h = await harness({ customers: EXISTING, workflows: CALL_WORKFLOWS });
  const [first] = await ingestCallGrid(h, call({ id: 'cg-redeliver' }));
  const [second] = await ingestCallGrid(h, call({ id: 'cg-redeliver' }));
  assert.equal(first!.status, 'processed');
  assert.equal(second!.status, 'duplicate');

  // A FAILED row is retryable, and reprocessing it re-runs the whole pipeline.
  h.rows('integrationEvent')[0]!.status = 'FAILED';
  const [retried] = await ingestCallGrid(h, call({ id: 'cg-redeliver' }));
  assert.equal(retried!.status, 'processed');

  assertNoCustomerReached(h);
  assert.equal(h.rows('interaction').length, 1, 'one Interaction for one call');
  assert.equal(h.rows('marketplaceCall').length, 1, 'one MarketplaceCall for one call');
  assert.equal(h.rows('integrationEvent').length, 1);
  assert.equal(h.rows('workflowRun').length, 0);
});

// --- Test traffic without a Customer ----------------------------------------------------

test('a test call is still recorded, and kept out of MarketplaceCall by its own caller number', async () => {
  const h = await harness();
  await ingestCallGrid(h, call({ id: 'cg-placeholder', callerId: '+13125550142' }));
  assertNoCustomerReached(h);
  assert.equal(h.rows('interaction').length, 1, 'the fact is recorded');
  assert.equal(h.rows('marketplaceCall').length, 0, 'a placeholder caller number is test traffic');
});

// --- The source fence ------------------------------------------------------------------

const ROOT = join(__dirname, '..', '..', '..');

/** Every file an ingestion path runs through, from the route to the write. */
const INGESTION_PATH = [
  'packages/database/src/services/ingestion.service.ts',
  'packages/database/src/repositories/normalization.repository.ts',
  'packages/database/src/services/callgrid-poll.service.ts',
  'packages/database/src/services/provider-observation.service.ts',
  'packages/database/src/services/provider-reconciliation.service.ts',
  'packages/database/src/services/auction-report-ingestion.service.ts',
  'apps/web/src/app/api/webhooks/callgrid/route.ts',
  'apps/web/src/app/api/webhooks/website/route.ts',
  'apps/web/src/app/api/integrations/callgrid/sync/route.ts',
  'apps/web/src/app/api/integrations/callgrid/auction-sync/route.ts',
];

/** Source with its prose removed: the headers name Customer precisely to say it is never touched. */
function code(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|\s)\/\/.*$/, ''))
    .join('\n');
}

const FORBIDDEN: Array<[RegExp, string]> = [
  [/\.customers?\b/, 'a Customer delegate or repository'],
  [/\bcustomer\s*:/, 'a Customer relation select, include or nested write'],
  [/\bcustomerId\s*:(?!\s*null\b)/, 'a customerId other than null'],
  [/\bcustomer(Email|Phone)\b/, 'a reported identifier used as a customer key'],
  [/resolveCustomer|connectOrCreate/, 'a resolver'],
];

test('no file on an ingestion path can reach the Customer table', () => {
  for (const path of INGESTION_PATH) {
    const src = code(path);
    for (const [pattern, what] of FORBIDDEN) {
      const hit = src.match(pattern);
      assert.equal(hit, null, `${path} must not contain ${what}: found "${hit?.[0]}"`);
    }
  }
});

test('the normalizer names no customer at all, and NormalizedEvent carries none', () => {
  assert.equal(
    /customer/i.test(code('packages/database/src/repositories/normalization.repository.ts')),
    false,
    'normalization.repository.ts must not name a customer',
  );
  const shared = code('packages/shared/src/index.ts');
  const normalized = shared.slice(shared.indexOf('export interface NormalizedEvent'));
  const body = normalized.slice(0, normalized.indexOf('}'));
  assert.doesNotMatch(body, /customer/i, 'there is no field through which a customer could be passed in');
});

test('the webhook responses report no customer', () => {
  for (const path of ['apps/web/src/app/api/webhooks/callgrid/route.ts', 'apps/web/src/app/api/webhooks/website/route.ts']) {
    assert.equal(/customerId/.test(code(path)), false, `${path} must not report a customerId`);
  }
});
