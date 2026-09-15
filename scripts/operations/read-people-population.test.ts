// Read people population -- the aggregate production read historical remediation is designed from.
//
// What must hold before it touches production:
//   - it measures what it says: provenance, visitor residue, withheld callers,
//     duplicates, attachment, human work, workflow damage, governance, bursts and
//     Slice 1 exposure, over a synthetic population built the ways production was;
//   - it prints nothing identifying, and a line of any other shape stops the run;
//   - it cannot write: no mutation path in source, and a read-only session in the
//     database;
//   - an answer it could not complete is UNKNOWN, never a partial number;
//   - it is human-started, proves itself before reading, and interpolates no input.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { makeCognitivePrisma } from '../../packages/database/test/helpers/cognitive-prisma-fake';
import {
  PeoplePopulationAuditRepository,
  callAttachment,
  phoneClass,
  provenanceClass,
  weekOf,
  withheldForm,
} from '../../packages/database/src/repositories/people-population-audit.repository';
import {
  SLICE1_MERGED_AT,
  parseArgs,
  printable,
  readEnvironment,
  readOnlySessionUrl,
  runPeoplePopulationAudit,
} from './read-people-population';

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
const RUNNER_SOURCE = readFileSync(new URL('./read-people-population.ts', import.meta.url), 'utf8');
const RUNNER_CODE = strip(RUNNER_SOURCE);
const READER_CODE = strip(
  readFileSync(new URL('../../packages/database/src/repositories/people-population-audit.repository.ts', import.meta.url), 'utf8'),
);
const WORKFLOW_SOURCE = readFileSync(new URL('../../.github/workflows/read-people-population.yml', import.meta.url), 'utf8');

const ORG = 'org_live';
const OTHER = 'org_other';
const SLICE1 = new Date(SLICE1_MERGED_AT);
const AS_OF = new Date('2026-09-15T18:00:00.000Z');
const at = (iso: string) => new Date(iso);
type Row = Record<string, any>;

const PII = [
  '+13128675309', '(213) 867-5309', '312-867-5309', '+17738675309', 'Anonymous', 'Restricted',
  'pat@northsideplumbing.co', 'maria@example.com', 'Jordan', 'Lee', 'Pat Rivera', 'web-visitor:v-1',
  'sic-demo-maria', 'vip-client', 'First touch', 'integration.call.inbound', 'v-1',
];

async function world() {
  const prisma: Row = makeCognitivePrisma({
    also: ['customer', 'interaction', 'conversation', 'booking', 'order', 'serviceRequest', 'workflow', 'workflowRun', 'customerPartyLink', 'integrationEvent'],
  });
  const ids: Record<string, string> = {};
  const customer = async (key: string, data: Row) => {
    const row = await prisma.customer.create({ data: { organizationId: ORG, tags: [], attributes: {}, metadata: {}, ...data } });
    ids[key] = row.id;
    return row.id as string;
  };

  // Ingestion callers: one worked by a person, one sharing only the last seven
  // digits, one the same number written another way.
  const booked = await customer('booked', { phone: '+13128675309', tags: ['lead', 'inbound-call'], attributes: { pipelineStatus: 'Booked' }, metadata: { createdFrom: 'callgrid' }, createdAt: at('2026-08-11T15:00:00Z') });
  const last7 = await customer('last7', { phone: '(213) 867-5309', tags: ['lead'], attributes: { pipelineStatus: 'New' }, metadata: { createdFrom: 'callgrid' }, createdAt: at('2026-08-11T15:05:00Z') });
  await customer('format', { phone: '312-867-5309', tags: ['lead'], attributes: { pipelineStatus: 'New' }, metadata: { createdFrom: 'callgrid' }, createdAt: at('2026-08-11T16:00:00Z') });
  // A record a person worked whose status the call workflow reset.
  const reset = await customer('reset', { phone: '+17735551212', tags: ['lead', 'inbound-call', 'vip-client'], attributes: { pipelineStatus: 'New' }, metadata: { createdFrom: 'callgrid' }, createdAt: at('2026-08-12T10:00:00Z') });
  // Withheld callers.
  const anon = await customer('anon', { phone: 'Anonymous', tags: ['lead', 'missed-call'], attributes: { pipelineStatus: 'Contacted' }, metadata: { createdFrom: 'callgrid' }, createdAt: at('2026-08-12T11:00:00Z') });
  await customer('restricted', { phone: 'Restricted', tags: ['lead'], attributes: { pipelineStatus: 'New' }, metadata: { createdFrom: 'callgrid' }, createdAt: at('2026-08-12T11:30:00Z') });
  await customer('short', { phone: '12345', tags: ['lead'], attributes: { pipelineStatus: 'New' }, metadata: { createdFrom: 'callgrid' }, createdAt: at('2026-08-13T09:00:00Z') });
  // Website.
  const visitor = await customer('visitor', { externalId: 'web-visitor:v-1', tags: ['anonymous-visitor'], attributes: { pipelineStatus: 'New', anonymous: true }, metadata: { createdFrom: 'website', visitorId: 'v-1' }, createdAt: at('2026-09-01T12:00:00Z') });
  await customer('webLead', { email: 'pat@northsideplumbing.co', tags: ['lead'], attributes: { pipelineStatus: 'New' }, metadata: { createdFrom: 'website' }, createdAt: at('2026-09-01T12:30:00Z') });
  // Seed and operator records.
  await customer('seed', { externalId: 'sic-demo-maria', email: 'maria@example.com', createdAt: at('2026-06-24T00:00:00Z') });
  const operator = await customer('operator', { firstName: 'Jordan', lastName: 'Lee', attributes: { pipelineStatus: 'Quoted' }, createdAt: at('2026-09-10T09:00:00Z') });
  await customer('afterSlice1', { firstName: 'Pat', lastName: 'Rivera', createdAt: at('2026-09-15T15:00:00Z') });
  await customer('afterAsOf', { phone: '+13128675309', metadata: { createdFrom: 'callgrid' }, createdAt: at('2026-09-15T19:00:00Z') });
  await prisma.customer.create({ data: { organizationId: OTHER, phone: '+13128675309', tags: ['lead'], attributes: {}, metadata: { createdFrom: 'callgrid' }, createdAt: at('2026-08-11T15:00:00Z') } });

  const interaction = (data: Row) => prisma.interaction.create({ data: { organizationId: ORG, payload: {}, metadata: {}, kind: 'PHONE_CALL', channel: 'PHONE', ...data } });
  await interaction({ customerId: booked, provider: 'callgrid', externalId: 'cg-1', metadata: { fromNumber: '+13128675309' }, createdAt: at('2026-08-11T15:00:00Z') });
  await interaction({ customerId: booked, provider: 'callgrid', externalId: 'cg-2', metadata: { fromNumber: '+17738675309' }, createdAt: at('2026-08-14T15:00:00Z') });
  await interaction({ customerId: last7, provider: 'callgrid', externalId: 'cg-3', metadata: { caller: '(213) 867-5309' }, createdAt: at('2026-08-11T15:05:00Z') });
  await interaction({ customerId: anon, provider: 'callgrid', externalId: 'cg-4', metadata: { fromNumber: 'Anonymous' }, createdAt: at('2026-08-12T11:00:00Z') });
  await interaction({ customerId: visitor, provider: 'website', channel: 'OTHER', kind: 'OTHER', externalId: 'web-1', metadata: { visitorId: 'v-1' }, createdAt: at('2026-09-01T12:00:00Z') });
  await interaction({ customerId: booked, provider: null, channel: 'OTHER', kind: 'NOTE', payload: { loopKind: 'crm_note', actorUserId: 'u_1', body: 'Called back' }, createdAt: at('2026-08-15T10:00:00Z') });
  await interaction({ customerId: anon, provider: null, channel: 'OTHER', kind: 'NOTE', payload: { source: 'workflow' }, createdAt: at('2026-08-12T11:00:01Z') });
  await interaction({ customerId: null, provider: 'callgrid', externalId: 'cg-after', metadata: { fromNumber: '+13128675309' }, createdAt: at('2026-09-15T16:00:00Z') });
  await interaction({ customerId: null, provider: 'callgrid', externalId: 'cg-after-asof', createdAt: at('2026-09-15T19:30:00Z') });

  await prisma.booking.create({ data: { organizationId: ORG, customerId: booked, createdAt: at('2026-08-16T10:00:00Z') } });
  await prisma.conversation.create({ data: { organizationId: ORG, customerId: reset, createdAt: at('2026-08-12T12:00:00Z') } });
  await prisma.order.create({ data: { organizationId: ORG, customerId: operator, createdAt: at('2026-09-11T10:00:00Z') } });
  await prisma.auditLog.create({ data: { organizationId: ORG, userId: 'u_1', entityType: 'customer', entityId: reset, action: 'customer.merged', createdAt: at('2026-08-20T10:00:00Z') } });
  await prisma.auditLog.create({ data: { organizationId: ORG, userId: null, entityType: 'customer', entityId: last7, action: 'system', createdAt: at('2026-08-20T10:00:00Z') } });
  await prisma.customerPartyLink.create({ data: { organizationId: ORG, customerId: operator, partyId: 'party_1', basis: 'MANUAL', activeCustomerId: operator, createdAt: at('2026-09-12T10:00:00Z') } });
  await prisma.cognitiveIdentity.create({ data: { organizationId: ORG, entityType: 'PERSON', canonicalKey: 'party:x', status: 'KNOWN', establishedAt: at('2026-09-12T10:00:00Z'), establishmentBasis: 'MANUAL' } });

  const wf = await prisma.workflow.create({ data: { organizationId: ORG, name: 'First touch', trigger: 'EVENT', isActive: true, triggerConfig: { eventName: 'integration.call.inbound' }, definition: { steps: [{ type: 'add_tag', config: { tag: 'inbound-call' } }, { type: 'set_pipeline_status', config: { status: 'New' } }] }, createdAt: at('2026-07-01T00:00:00Z') } });
  await prisma.workflowRun.create({ data: { organizationId: ORG, workflowId: wf.id, status: 'SUCCEEDED', input: { context: { customerId: reset } }, createdAt: at('2026-08-21T10:00:00Z') } });
  await prisma.workflowRun.create({ data: { organizationId: ORG, workflowId: wf.id, status: 'SUCCEEDED', input: { context: { customerId: booked } }, createdAt: at('2026-08-14T15:00:00Z') } });
  await prisma.workflowRun.create({ data: { organizationId: ORG, workflowId: wf.id, status: 'FAILED', input: { context: {} }, createdAt: at('2026-09-02T10:00:00Z') } });

  const event = (receivedAt: string, source: string, occurredAt?: string) =>
    prisma.integrationEvent.create({ data: { organizationId: ORG, provider: 'callgrid', externalId: 'e-' + receivedAt + source, status: 'PROCESSED', receivedAt: at(receivedAt), occurredAt: at(occurredAt ?? receivedAt), firstIngestionSource: source, createdAt: at(receivedAt) } });
  await event('2026-08-11T15:00:00Z', 'WEBHOOK');
  await event('2026-08-11T15:05:00Z', 'API_RECOVERY', '2026-08-09T12:00:00Z');
  await event('2026-08-11T16:00:00Z', 'API_RECOVERY', '2026-08-09T13:00:00Z');

  const lines: string[] = [];
  const identityReads = { count: 0 };
  const deps = (options: ConstructorParameters<typeof PeoplePopulationAuditRepository>[1] = {}) => ({
    organizations: { findBySlug: async (slug: string) => (slug === 'servicesinmycity-demo' ? { id: ORG, slug } : null) },
    population: new PeoplePopulationAuditRepository(prisma as never, options),
    identities: {
      footprint: async () => {
        identityReads.count += 1;
        return { identities: { total: 1, partyTyped: 1 }, satellites: { evidence: 0, resolutionLinks: 0, linksByStatus: {} }, exceededBound: false };
      },
    },
    now: () => AS_OF,
    log: (l: string) => lines.push(l),
  });
  return { prisma, ids, lines, deps, identityReads };
}

const request = { organizationSlug: 'servicesinmycity-demo', slice1At: SLICE1_MERGED_AT };

function field(lines: string[], event: string, key: string): string | undefined {
  const l = lines.find((x) => x.startsWith(`event=${event} `) || x === `event=${event}`);
  return l?.split(' ').find((t) => t.startsWith(key + '='))?.slice(key.length + 1);
}

// --- What it measures ---------------------------------------------------------------------

test('provenance: every record is placed by the mark its creator left, before the cut-off, in this organization only', async () => {
  const w = await world();
  const r = await runPeoplePopulationAudit(request, w.deps());
  const p = r.audit!.provenance!;
  assert.equal(p.customers, 12, 'the record created after AS_OF and the other organization are not counted');
  assert.deepEqual(p.byClass, {
    INGESTION_CALL: 7, INGESTION_WEB_VISITOR: 1, INGESTION_WEB_LEAD: 1, INGESTION_OTHER_SOURCE: 0,
    SEED_OR_DEMO: 1, EXTERNAL_IMPORT: 0, UNMARKED: 2,
  });
  assert.equal(p.testOrDemoMarked, 2, 'the seed record, and the 555 placeholder number');
  assert.equal(p.tags.OUTSIDE_INGESTION, 1);
  assert.equal(field(w.lines, 'PROVENANCE', 'CLASS_INGESTION_CALL'), '7');
  assert.ok(w.lines.some((l) => l.startsWith('event=PROVENANCE_MONTH month=2026-08 ')));
});

test('withheld callers and duplicate phones are counted without keeping a single number', async () => {
  const w = await world();
  const a = (await runPeoplePopulationAudit(request, w.deps())).audit!;
  assert.equal(a.withheldCallers!.withheld, 3);
  assert.equal(a.withheldCallers!.byForm.ANONYMOUS, 1);
  assert.equal(a.withheldCallers!.byForm.RESTRICTED, 1);
  assert.equal(a.withheldCallers!.byForm.SHORT_NUMBER, 1);
  assert.equal(a.withheldCallers!.placeholderPhones, 1, '773-555-1212 is a 555 placeholder');
  assert.equal(a.duplicatePhones!.sameNumberGroups, 1, '+1 312 867 5309 and 312-867-5309 are one number');
  assert.equal(a.duplicatePhones!.formatVariantGroups, 1, 'written two ways');
  assert.equal(a.duplicatePhones!.last7CollisionGroups, 1, '312 and 213 share 867-5309');
  assert.equal(a.duplicatePhones!.last7CollisionNumbers, 2);
});

test('interaction attachment: a call attached on the last seven digits alone is found', async () => {
  const w = await world();
  const ia = (await runPeoplePopulationAudit(request, w.deps())).audit!.interactionAttachment!;
  assert.equal(ia.interactions, 8, 'the interaction after AS_OF is not counted');
  assert.equal(ia.attached, 7);
  assert.equal(ia.byProvider.CALLGRID_UNATTACHED, 1);
  assert.equal(ia.callAttachment!.CALLER_EXACT, 2);
  assert.equal(ia.callAttachment!.CALLER_LAST7_ONLY, 1);
  assert.equal(ia.callAttachment!.CALLER_WITHHELD, 1);
  assert.equal(ia.customersWithLast7OnlyCalls, 1);
  assert.equal(ia.customersWithTwoOrMoreCallers, 1);
  assert.deepEqual(ia.notes, { HUMAN: 1, WORKFLOW: 1, OTHER: 0 });
});

test('human work: strong evidence, weak evidence and none are told apart', async () => {
  const w = await world();
  const h = (await runPeoplePopulationAudit(request, w.deps())).audit!.humanWork!;
  assert.equal(h.bySignal.BOOKING, 1);
  assert.equal(h.bySignal.HUMAN_NOTE, 1);
  assert.equal(h.bySignal.CONVERSATION, 1);
  assert.equal(h.bySignal.HUMAN_AUDIT, 1, 'an audit entry with no user is not human work');
  assert.equal(h.bySignal.PARTY_LINK, 1);
  assert.equal(h.bySignal.STATUS_BEYOND_CONTACTED, 2, 'Booked and Quoted; Contacted is what the missed-call workflow set');
  assert.equal(h.strongSignal, 3);
  assert.equal(h.weakOnly, 1, 'a name typed in, and nothing else');
  assert.equal(h.noSignal, 8);
  const calls = h.byClass.find((c) => c.cls === 'INGESTION_CALL')!;
  assert.deepEqual(calls, { cls: 'INGESTION_CALL', total: 7, strong: 2, weakOnly: 0, none: 5 });
});

test('workflow damage: call workflows that touched worked records, and statuses they likely overwrote', async () => {
  const w = await world();
  const wf = (await runPeoplePopulationAudit(request, w.deps())).audit!.workflowDamage!;
  assert.equal(wf.byClass.EVENT_CALL, 1);
  assert.equal(wf.workflowsSettingStatus.SETS_NEW, 1);
  assert.equal(wf.runs, 3);
  assert.equal(wf.customersTouchedByCallWorkflows, 2);
  assert.equal(wf.touchedWithStrongHumanWork, 2);
  assert.equal(wf.likelyStatusOverwritten, 1, 'worked, call-tagged, and back at New');
  assert.equal(wf.customersWithWorkflowNotes, 1);
  assert.equal(wf.runsAfterSlice1, 0);
});

test('governance, creation bursts and Slice 1 exposure', async () => {
  const w = await world();
  const a = (await runPeoplePopulationAudit(request, w.deps())).audit!;
  assert.equal(a.governance.partiesEstablished, 1);
  assert.equal(a.governance.activeLinks, 1);
  assert.equal(a.governance.customersWithActiveLink, 1);
  const top = a.creationBursts!.topDays[0]!;
  assert.equal(top.day, '2026-08-11');
  assert.equal(top.ingestionCustomers, 3);
  assert.equal(top.eventsBySource.API_RECOVERY, 2);
  assert.equal(top.eventsOccurredEarlier, 2);
  const x = a.slice1Exposure!;
  assert.equal(x.customersCreatedAfter, 1);
  assert.equal(x.ingestionCustomersCreatedAfter, 0, 'nothing ingestion-marked after Slice 1');
  assert.equal(x.interactionsAfter, 1);
  assert.equal(x.attachedProviderInteractionsAfter, 0);
  assert.equal(x.bookingsOnIngestionCustomers, 1);
  assert.equal(x.excludedOnlyViaCustomer!.CALLGRID, 0);
  assert.ok(x.peopleAddedByWeek.length > 0);
  assert.match(w.lines.at(-1)!, /^event=VERDICT EXCEEDED_BOUND=false OVERALL_RESULT=READ$/);
});

// --- Privacy ------------------------------------------------------------------------------

test('no name, email, phone number, tag, workflow name, event name or record id is printed', async () => {
  const w = await world();
  await runPeoplePopulationAudit(request, w.deps());
  const out = w.lines.join('\n');
  for (const secret of [...PII, ...Object.values(w.ids), ORG]) {
    assert.equal(out.includes(secret), false, `must not print ${secret}`);
  }
  assert.equal(/@|\+\d|\d{7,}/.test(out), false, 'no email or phone shape');
  for (const l of w.lines) assert.ok(printable(l, request.organizationSlug), l);
});

test('the print guard accepts only counts, booleans, UNKNOWN and fixed shapes', () => {
  const slug = 'servicesinmycity-demo';
  assert.ok(printable('event=PROVENANCE CUSTOMERS=12 CLASS_INGESTION_CALL=7 MERGED_MARKER=UNKNOWN', slug));
  assert.ok(printable('event=AUDIT_SCOPE organization=servicesinmycity-demo AS_OF=2026-09-15T18:00:00.000Z READ_ONLY_SESSION_REQUESTED=true', slug));
  assert.ok(printable('event=CREATION_DAY day=2026-08-11 CUSTOMERS=3', slug));
  for (const bad of [
    'event=PROVENANCE NAME=pat',
    'event=PROVENANCE EMAIL=pat@northsideplumbing.co',
    'event=PROVENANCE PHONE=+13128675309',
    'event=PROVENANCE ID=cmu2ps3u90007ilfox5pyyf62',
    'event=AUDIT_SCOPE organization=another-org',
    'event=provenance CUSTOMERS=1',
    'event=CREATION_DAY day=Tuesday',
    'event=PROVENANCE CUSTOMERS=1 stray',
    'event=HUMAN_WORK_CLASS class=pat',
  ]) {
    assert.equal(printable(bad, slug), false, bad);
  }
});

test('a line outside the vocabulary stops the run instead of printing', async () => {
  const w = await world();
  const d = w.deps();
  const real = d.population;
  const leaking = {
    audit: async (...args: Parameters<typeof real.audit>) => {
      const a = await real.audit(...args);
      return { ...a, provenance: { ...a.provenance!, byMonth: [{ month: 'pat@northsideplumbing.co', byClass: a.provenance!.byClass }] } };
    },
  };
  await assert.rejects(() => runPeoplePopulationAudit(request, { ...d, population: leaking }), /refusing to print/);
  assert.equal(w.lines.join('\n').includes('pat@'), false);
});

// --- Completeness and bounds --------------------------------------------------------------

test('paging through the tables gives exactly the answer a single page gives', async () => {
  const w = await world();
  const whole = (await runPeoplePopulationAudit(request, w.deps())).audit!;
  const paged = (await runPeoplePopulationAudit(request, w.deps({ pageSize: 2 }))).audit!;
  assert.deepEqual(paged, whole);
});

test('a read past its bound makes the answers built on it UNKNOWN, never partial', async () => {
  const w = await world();
  const r = await runPeoplePopulationAudit(request, w.deps({ pageSize: 2, bounds: { customers: 5 } }));
  assert.equal(r.audit!.exceededBound, true);
  assert.equal(r.audit!.provenance, null);
  assert.equal(r.audit!.humanWork, null);
  assert.equal(field(w.lines, 'PROVENANCE', 'CUSTOMERS'), 'UNKNOWN');
  assert.match(w.lines.at(-1)!, /EXCEEDED_BOUND=true/);

  const i = await world();
  const partial = (await runPeoplePopulationAudit(request, i.deps({ pageSize: 2, bounds: { interactions: 3, attachedProviderInteractions: 1 } }))).audit!;
  assert.equal(partial.interactionAttachment, null);
  assert.equal(partial.anonymousVisitors, null);
  assert.equal(partial.slice1Exposure!.excludedOnlyViaCustomer, null);
  assert.notEqual(partial.provenance, null, 'the Customer read itself completed');
});

test('unknown or malformed requests fail closed before any read', async () => {
  const w = await world();
  let reads = 0;
  const d = w.deps();
  const counting = { ...d, population: { audit: async (...a: Parameters<typeof d.population.audit>) => { reads += 1; return d.population.audit(...a); } } };
  for (const bad of [
    { organizationSlug: 'nope', slice1At: SLICE1_MERGED_AT },
    { organizationSlug: 'SERVICES', slice1At: SLICE1_MERGED_AT },
    { organizationSlug: "x' or 1=1", slice1At: SLICE1_MERGED_AT },
    { organizationSlug: 'servicesinmycity-demo', slice1At: 'yesterday' },
    { organizationSlug: 'servicesinmycity-demo', slice1At: '2026-09-15 13:49' },
  ]) {
    const r = await runPeoplePopulationAudit(bad, counting);
    assert.equal(r.overall, 'FAILED_PRECONDITION', JSON.stringify(bad));
  }
  assert.equal(reads, 0);
  assert.equal(w.identityReads.count, 0);
});

// --- Classification ----------------------------------------------------------------------

test('classification is fixed-vocabulary and exact', () => {
  assert.equal(phoneClass(null), 'ABSENT');
  assert.equal(phoneClass('Anonymous'), 'NO_DIGITS');
  assert.equal(phoneClass('12345'), 'SHORT_DIGITS');
  assert.equal(phoneClass('+1 (312) 867-5309'), 'NANP');
  assert.equal(phoneClass('+44 20 7946 0958'), 'OTHER_LENGTH');
  assert.equal(withheldForm('RESTRICTED'), 'RESTRICTED');
  assert.equal(withheldForm('No Caller ID'), 'NO_CALLER_ID');
  assert.equal(withheldForm('Jordan'), 'OTHER_TEXT');
  assert.equal(provenanceClass({ externalId: 'web-visitor:x', tags: [], metadata: { createdFrom: 'website' } }), 'INGESTION_WEB_VISITOR');
  assert.equal(provenanceClass({ externalId: null, tags: ['anonymous-visitor'], metadata: {} }), 'INGESTION_WEB_VISITOR');
  assert.equal(provenanceClass({ externalId: 'e2e-7', tags: [], metadata: {} }), 'SEED_OR_DEMO');
  assert.equal(provenanceClass({ externalId: 'simc-123', tags: [], metadata: {} }), 'EXTERNAL_IMPORT');
  assert.equal(callAttachment('+1 773 867 5309', '+13128675309'), 'CALLER_LAST7_ONLY');
  assert.equal(callAttachment('Restricted', '+13128675309'), 'CALLER_WITHHELD');
  assert.equal(callAttachment('+13128675309', 'Anonymous'), 'CUSTOMER_NO_USABLE_PHONE');
  assert.equal(weekOf(at('2026-09-15T23:00:00Z')), '2026-09-14', 'weeks start on the UTC Monday');
});

// --- It cannot write ------------------------------------------------------------------------

test('the session is read-only in the database: the connection string forces it, and keeps what was there', () => {
  const url = new URL(readOnlySessionUrl('postgresql://u:p@db.example.neon.tech/loop?sslmode=require'));
  assert.equal(url.searchParams.get('sslmode'), 'require');
  assert.equal(url.searchParams.get('options'), '-c default_transaction_read_only=on -c statement_timeout=120000');
  const extended = new URL(readOnlySessionUrl('postgres://u:p@h/db?options=' + encodeURIComponent('-c statement_timeout=60000')));
  assert.equal(extended.searchParams.get('options'), '-c statement_timeout=60000 -c default_transaction_read_only=on', 'a stricter existing timeout is kept');
  const again = readOnlySessionUrl(readOnlySessionUrl('postgresql://u:p@h/db'));
  assert.equal(new URL(again).searchParams.get('options'), '-c default_transaction_read_only=on -c statement_timeout=120000', 'idempotent');
  assert.throws(() => readOnlySessionUrl('mysql://u:p@h/db'), /not a PostgreSQL/);
});

test('the runner forces the read-only session before the database package loads', () => {
  const forced = RUNNER_CODE.indexOf('process.env.DATABASE_URL = readOnlySessionUrl(');
  const loaded = RUNNER_CODE.indexOf("await import('@emgloop/database')");
  assert.ok(forced > 0 && loaded > forced);
  assert.equal(/^import .*@emgloop\/database/m.test(RUNNER_CODE), false, 'no static import that would construct the client first');
});

test('neither the reader nor the runner has a mutation path, and every reader query is organization-scoped', () => {
  for (const code of [RUNNER_CODE, READER_CODE]) {
    for (const symbol of ['create(', 'update(', 'upsert(', 'delete(', 'createMany(', 'updateMany(', 'deleteMany(', '$executeRaw', '$queryRaw', '$transaction', 'fetch(']) {
      assert.ok(!code.includes(symbol), `must not name ${symbol}`);
    }
    assert.ok(!/\bSELECT\s|\bINSERT\s|\bUPDATE\s+\w+\s+SET\b/.test(code));
  }
  assert.ok(!/prisma\.\w+\./.test(RUNNER_CODE), 'the runner goes through the repository');
  const scans = [...READER_CODE.matchAll(/this\.scan\(\s*[^,]+,\s*([^\n]+)/g)].map((m) => m[1]!);
  assert.ok(scans.length >= 8);
  for (const where of scans) assert.match(where, /before/, `every scan is bounded by the organization and the cut-off: ${where}`);
  assert.match(READER_CODE, /const before = \{ organizationId, createdAt: \{ lt: asOf \} \}/);
  const counts = [...READER_CODE.matchAll(/\.count\(\{ where: \{([^}]*)/g)].map((m) => m[1]!);
  assert.ok(counts.length >= 4);
  for (const where of counts) assert.match(where, /organizationId/);
  assert.match(READER_CODE, /withCustomer = \(delegate: Finder, bound: number\) =>[\s\S]*?\{ \.\.\.before, customerId: \{ not: null \} \}/);
  assert.ok(!/process\.stdout|console\./.test(READER_CODE), 'the reader prints nothing itself');
  assert.ok(!/error\.message|\.message\b/.test(RUNNER_CODE.slice(RUNNER_CODE.indexOf('ENTRY_POINT'))), 'a failure never prints its message');
});

test('the workflow is human-started only, proves safety before reading, and interpolates no input', () => {
  assert.ok(WORKFLOW_SOURCE.includes('workflow_dispatch:'));
  for (const trigger of ['\n  schedule:', '\n  push:', '\n  pull_request:', '\n  workflow_call:']) {
    assert.ok(!WORKFLOW_SOURCE.includes(trigger), `no ${trigger.trim()}`);
  }
  const proof = WORKFLOW_SOURCE.indexOf('npm run test:operations');
  const read = WORKFLOW_SOURCE.indexOf('npm run read:people-population');
  assert.ok(proof > 0 && proof < read);
  assert.ok(WORKFLOW_SOURCE.includes('permissions:\n  contents: read'));
  assert.ok(!WORKFLOW_SOURCE.includes('migrate deploy'));
  for (const body of WORKFLOW_SOURCE.split(/\n\s+run: \|/).slice(1)) {
    const step = body.split(/\n\s+- name:/)[0] ?? '';
    assert.ok(!/\$\{\{\s*(inputs|secrets)\./.test(step), 'no input or secret interpolated into a run body');
  }
});

test('flags and environment', () => {
  assert.deepEqual(parseArgs(['--org', 'acme']), { organization: 'acme', slice1At: SLICE1_MERGED_AT });
  assert.deepEqual(parseArgs(['--organization', 'acme', '--slice1-at', '2026-09-15T14:05:00Z']), { organization: 'acme', slice1At: '2026-09-15T14:05:00Z' });
  assert.deepEqual(readEnvironment({} as NodeJS.ProcessEnv), { ok: false, missing: ['DATABASE_URL'] });
});
