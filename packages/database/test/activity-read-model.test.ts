// Universal Activity, composed from real authorities. Slice A2.
//
// Drives the real adapters and the real read model over the in-memory Prisma double,
// through a recording proxy that FAILS THE TEST ON ANY WRITE. Activity is a
// projection; a projection that writes is a second authority.
//
// WHAT THESE PROVE
//
// AN INTAKE RECORD IS NOT A PERSON. A fact attached to a legacy Customer row reports
// UNRESOLVED / INTAKE_LINK_CONTEXT and no Party subject -- even when that Customer is
// linked to an established Party. The link is seeded in these tests precisely so its
// presence is proven not to change the answer.
//
// IDENTITY COMES FROM KEY PRESENCE, NEVER A VALUE. A caller id makes a fact
// UNRESOLVED; a visitor key makes it ANONYMOUS; neither value is read, compared or
// returned. Nothing in an emitted item contains a phone number, an email address or
// a message body -- asserted over the entire serialized item, not field by field.
//
// TIME IS REPORTED, NOT GUESSED. A provider's own time says PROVIDER_REPORTED; the
// website fallback says LOOP_CLOCK and carries the limitation; an engine's analysis
// of a period says REPORTING_WINDOW.
//
// PAGING IS KEYSET AND BOUNDED. Every adapter reads at most limit+1 rows, and walking
// a mixed feed page by page returns every item exactly once.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { validateActivityItem, type ActivityItemV1 } from '@emgloop/shared';

import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
import { ActivityReadModelRepository } from '../src/repositories/activity-read-model.repository';
import type { ActivityAdapter, ActivitySubject } from '../src/repositories/activity-read-model.repository';
import { InteractionActivityAdapter, interactionActivityItem } from '../src/repositories/activity/interaction.adapter';
import { admit } from '../src/repositories/activity/adapter';
import { MarketplaceCallActivityAdapter } from '../src/repositories/activity/marketplace-call.adapter';
import { ObservationActivityAdapter } from '../src/repositories/activity/observation.adapter';
import { MessageActivityAdapter } from '../src/repositories/activity/message.adapter';
import { AuditActivityAdapter } from '../src/repositories/activity/audit.adapter';

const ORG_A = 'org_a';
const ORG_B = 'org_b';
const READS = new Set(['findFirst', 'findMany', 'findUnique', 'count']);

/** Values planted in the sources. None of them may appear in any emitted item. */
const SECRETS = {
  phone: '+15551234567',
  email: 'caller@example.com',
  body: 'my card number is 4111 1111 1111 1111',
  visitor: 'visitor-abc-123',
  note: 'spoke to the owner about the invoice',
};

type Row = Record<string, unknown>;

function world() {
  const fake: any = makeCognitivePrisma({ also: ['interaction', 'marketplaceCall', 'conversation', 'message', 'customer', 'customerPartyLink', 'brainEvent', 'brainJob'] });
  const calls: { delegate: string; method: string; args: unknown }[] = [];
  const prisma = new Proxy(fake, {
    get(target, delegate: string) {
      const d = target[delegate];
      if (typeof delegate === 'string' && delegate.startsWith('$')) {
        return () => { throw new Error(`activity must not call ${delegate}`); };
      }
      if (typeof d !== 'object' || d === null) return d;
      return new Proxy(d, {
        get(inner, method: string) {
          const fn = inner[method];
          if (typeof fn !== 'function') return fn;
          return (args: unknown) => {
            calls.push({ delegate, method, args });
            if (!READS.has(method)) throw new Error(`activity must not write: ${delegate}.${method}`);
            return fn.call(inner, args);
          };
        },
      });
    },
  }) as PrismaClient;

  const at = (iso: string) => new Date(iso);
  let seq = 0;

  return {
    fake,
    calls,
    repo: new ActivityReadModelRepository(prisma),
    adapters: {
      interaction: new InteractionActivityAdapter(prisma),
      call: new MarketplaceCallActivityAdapter(prisma),
      observation: new ObservationActivityAdapter(prisma),
      message: new MessageActivityAdapter(prisma),
      audit: new AuditActivityAdapter(prisma),
    },
    async interaction(patch: Row = {}) {
      const id = (patch.id as string) ?? `int_${++seq}`;
      await fake.interaction.create({
        data: {
          id,
          organizationId: ORG_A,
          customerId: null,
          conversationId: null,
          channel: 'PHONE',
          kind: 'PHONE_CALL',
          direction: 'INBOUND',
          occurredAt: at('2026-09-10T10:00:00.000Z'),
          createdAt: at('2026-09-10T10:00:05.000Z'),
          summary: `Inbound call from ${SECRETS.phone}`,
          provider: 'callgrid',
          externalId: `ext_${id}`,
          payload: {},
          metadata: { callerId: SECRETS.phone, UTCUnixTimeMs: 1789041600000 },
          ...patch,
        },
      });
      return id;
    },
    async call(patch: Row = {}) {
      const id = (patch.id as string) ?? `mc_${++seq}`;
      await fake.marketplaceCall.create({
        data: {
          id,
          organizationId: ORG_A,
          provider: 'callgrid',
          externalId: `cg_${id}`,
          interactionId: null,
          sourceOccurredAt: at('2026-09-10T09:00:00.000Z'),
          createdAt: at('2026-09-10T09:00:10.000Z'),
          status: 'CONNECTED',
          rawStatus: 'ANSWERED',
          buyerExternalId: 'buyer-7',
          vendorExternalId: null,
          sourceExternalId: null,
          campaignExternalId: null,
          destinationExternalId: null,
          revenueCents: 4500,
          ...patch,
        },
      });
      return id;
    },
    async observation(patch: Row = {}) {
      const id = (patch.id as string) ?? `obs_${++seq}`;
      await fake.operationalObservation.create({
        data: {
          id,
          organizationId: ORG_A,
          priorityId: 'case_1',
          observationType: 'SITUATION_DETECTED',
          detectionKey: 'yesterday:2026-09-09',
          occurredAt: at('2026-09-09T00:00:00.000Z'),
          recordedAt: at('2026-09-10T08:00:00.000Z'),
          sequence: ++seq,
          actorType: 'SYSTEM',
          actorUserId: null,
          source: 'callgrid-intelligence',
          note: null,
          reason: null,
          previousState: null,
          newState: 'REVIEW',
          outcome: null,
          assignedToUserId: null,
          ...patch,
        },
      });
      return id;
    },
    async audit(patch: Row = {}) {
      const id = (patch.id as string) ?? `aud_${++seq}`;
      await fake.auditLog.create({
        data: {
          id,
          organizationId: ORG_A,
          userId: 'user_1',
          actorType: 'HUMAN_AGENT',
          action: 'customer.updated',
          entityType: 'customer',
          entityId: 'cust_1',
          before: { phone: SECRETS.phone },
          after: { phone: SECRETS.phone },
          metadata: {},
          createdAt: at('2026-09-10T11:00:00.000Z'),
          ...patch,
        },
      });
      return id;
    },
    async thread(patch: Row = {}, messagePatch: Row = {}) {
      const id = (patch.id as string) ?? `conv_${++seq}`;
      await fake.conversation.create({
        data: { id, organizationId: ORG_A, customerId: 'cust_1', channel: 'SMS', status: 'OPEN', ...patch },
      });
      const messageId = `msg_${++seq}`;
      await fake.message.create({
        data: {
          id: messageId,
          organizationId: ORG_A,
          conversationId: id,
          actorType: 'CUSTOMER',
          actorId: 'cust_1',
          type: 'TEXT',
          body: SECRETS.body,
          provider: 'twilio',
          externalId: null,
          attachments: [],
          metadata: {},
          sentAt: at('2026-09-10T07:00:00.000Z'),
          createdAt: at('2026-09-10T07:00:00.000Z'),
          ...messagePatch,
        },
      });
      return { conversationId: id, messageId };
    },
    at,
  };
}

const ALL: ActivityAdapter[] = [];

async function page(w: ReturnType<typeof world>, subject: ActivitySubject, opts: Record<string, unknown> = {}) {
  const permitted = w.repo.adaptersFor(subject);
  return w.repo.page(ORG_A, subject, permitted, opts);
}

function serialized(item: ActivityItemV1): string {
  return JSON.stringify(item);
}

// --- 1. Each source maps into activity.v1 ---------------------------------------------

test('every adapter emits items that satisfy the contract it was written against', async () => {
  const w = world();
  await w.interaction();
  await w.call();
  await w.observation();
  await w.audit();
  await w.thread();

  const org = await page(w, { kind: 'ORGANIZATION' });
  const intake = await page(w, { kind: 'INTAKE_RECORD', customerId: 'cust_1' });
  const kase = await page(w, { kind: 'CASE', priorityId: 'case_1' });

  const items = [...org.items, ...intake.items, ...kase.items];
  assert.ok(items.length >= 5, 'every source contributed');
  for (const item of items) {
    assert.deepEqual(validateActivityItem(item), [], `${item.key} is a valid activity.v1 item`);
    assert.equal(item.contractVersion, 'activity.v1');
    assert.equal(item.organizationId, ORG_A);
    assert.equal(item.sensitivity.contentInline, false);
    assert.ok(item.access.requires.length > 0, `${item.key} states what it needs`);
  }
});

test('a channel fact maps to its kind, its channel and the provider\'s own time', async () => {
  const w = world();
  await w.interaction({ id: 'int_call' });
  const { items } = await page(w, { kind: 'ORGANIZATION' });
  const item = items.find((i) => i.key === 'interaction:int_call')!;
  assert.equal(item.category, 'COMMUNICATION');
  assert.equal(item.type, 'PHONE_CALL');
  assert.equal(item.authority.recordType, 'interaction');
  assert.equal(item.time.occurredAt, '2026-09-10T10:00:00.000Z');
  assert.equal(item.time.occurredAtBasis, 'PROVIDER_REPORTED');
  assert.equal(item.time.recordedAt, '2026-09-10T10:00:05.000Z');
  assert.equal(item.display.channel, 'PHONE');
  assert.equal(item.display.direction, 'INBOUND');
  assert.equal(item.actor.kind, 'PROVIDER');
  assert.equal(item.sensitivity.class, 'CONTACT_IDENTIFIER');
  assert.equal(item.sensitivity.rawValuesInSource, true);
});

test('a marketplace call maps to provider dimensions, which are not Parties', async () => {
  const w = world();
  await w.call({ id: 'mc_1' });
  const { items } = await page(w, { kind: 'ORGANIZATION' });
  const item = items.find((i) => i.key === 'marketplace-call:mc_1')!;
  assert.equal(item.category, 'FACT');
  assert.equal(item.time.occurredAtBasis, 'PROVIDER_REPORTED');
  assert.deepEqual(item.subjects, [{ kind: 'PROVIDER_COUNTERPARTY', role: 'BUYER', provider: 'callgrid', externalId: 'buyer-7' }]);
  assert.deepEqual(item.identity, { state: 'NOT_APPLICABLE', basis: 'NONE' });
  assert.equal(item.access.workspace, 'ADMIN');
  // Money stays with the authority that owns it.
  assert.doesNotMatch(serialized(item), /4500|revenue/i);
});

test('a decision observation keeps its sequence, its state change and its reporting window', async () => {
  const w = world();
  await w.observation({ id: 'obs_1', sequence: 4 });
  await w.observation({ id: 'obs_2', sequence: 5, observationType: 'RESOLVED', detectionKey: null, actorType: 'HUMAN', actorUserId: 'user_9', previousState: 'REVIEW', newState: 'RESOLVED', outcome: 'RECOVERED', occurredAt: w.at('2026-09-09T12:00:00.000Z') });
  const { items } = await page(w, { kind: 'CASE', priorityId: 'case_1' });

  const detected = items.find((i) => i.key === 'operational-observation:obs_1:4')!;
  assert.equal(detected.category, 'SIGNAL');
  assert.equal(detected.provenance.epistemic, 'INTERPRETED', 'a detection is a reading, not a witnessed fact');
  assert.equal(detected.time.occurredAtBasis, 'REPORTING_WINDOW');
  assert.equal(detected.authority.sequence, 4);

  const resolved = items.find((i) => i.key === 'operational-observation:obs_2:5')!;
  assert.equal(resolved.category, 'DECISION');
  assert.equal(resolved.provenance.epistemic, 'HUMAN_REPORTED');
  assert.equal(resolved.time.occurredAtBasis, 'OPERATOR_STATED');
  assert.deepEqual(resolved.display.stateChange, { from: 'REVIEW', to: 'RESOLVED' });
  assert.equal(resolved.display.semanticStatus, 'RECOVERED', 'a label from the authority, never a number');
  assert.deepEqual(resolved.participants, [{ kind: 'USER', id: 'user_9' }]);
});

test('an audit act is category AUDIT and carries no before/after values', async () => {
  const w = world();
  await w.audit({ id: 'aud_1' });
  const { items } = await page(w, { kind: 'INTAKE_RECORD', customerId: 'cust_1' });
  const item = items.find((i) => i.key === 'audit-log:aud_1')!;
  assert.equal(item.category, 'AUDIT');
  assert.equal(item.type, 'customer.updated');
  assert.deepEqual(item.access.requires, [{ resource: 'audit', action: 'view' }]);
  assert.deepEqual(item.display.stateChange, { from: null, to: null }, 'that something changed, not what');
  assert.doesNotMatch(serialized(item), new RegExp(SECRETS.phone.replace('+', '\\+')));
});

test('a message is a communication whose body stays in the source', async () => {
  const w = world();
  const { messageId } = await w.thread();
  const { items } = await page(w, { kind: 'INTAKE_RECORD', customerId: 'cust_1' });
  const item = items.find((i) => i.key === `message:${messageId}`)!;
  assert.equal(item.category, 'COMMUNICATION');
  assert.equal(item.sensitivity.class, 'COMMUNICATION_CONTENT');
  assert.equal(item.time.occurredAtBasis, 'LOOP_CLOCK');
  assert.ok(item.provenance.limitations.some((l) => l.includes('no send time')), 'the item says the time is not the provider\'s');
  assert.doesNotMatch(serialized(item), /card number|4111/);
});

// --- 2. Identity honesty --------------------------------------------------------------

test('an Intake Record link is never a Known Party, even when the record is linked to one', async () => {
  const w = world();
  // The Intake Record IS linked to an established Party. That link is exactly what
  // must not turn these facts into that Party's activity.
  await w.fake.customerPartyLink.create({
    data: { id: 'link_1', organizationId: ORG_A, customerId: 'cust_1', partyId: 'party_1', activeCustomerId: 'cust_1' },
  });
  await w.interaction({ id: 'int_attached', customerId: 'cust_1' });
  await w.audit({ id: 'aud_attached' });
  await w.thread();

  const { items } = await page(w, { kind: 'INTAKE_RECORD', customerId: 'cust_1' });
  assert.ok(items.length >= 3);
  for (const item of items) {
    assert.equal(item.identity.state !== 'KNOWN_PARTY' && item.identity.state !== 'KNOWN_COMPANY', true, `${item.key} is not a Known Party`);
    assert.equal(item.subjects.some((s) => s.kind === 'PARTY'), false, `${item.key} names no Party`);
    assert.deepEqual(item.identity, { state: 'UNRESOLVED', basis: 'INTAKE_LINK_CONTEXT' }, item.key);
  }
  const call = items.find((i) => i.key === 'interaction:int_attached')!;
  assert.ok(call.provenance.limitations.some((l) => l.includes('legacy Intake Record')));
  // Not one read touched the link or any identity table.
  const touched = new Set(w.calls.map((c) => c.delegate));
  for (const forbidden of ['customerPartyLink', 'cognitiveIdentity', 'identityEvidence', 'identityResolutionLink']) {
    assert.equal(touched.has(forbidden), false, `activity must not read ${forbidden}`);
  }
});

test('identity state follows key presence: identifier, continuity, or nothing at all', async () => {
  const w = world();
  await w.interaction({ id: 'int_phone', metadata: { callerId: SECRETS.phone } });
  await w.interaction({ id: 'int_email', provider: 'website', kind: 'FORM_SUBMISSION', channel: 'EMAIL', metadata: { email: SECRETS.email, occurred_at: '2026-09-10T10:00:00.000Z' } });
  await w.interaction({ id: 'int_visitor', provider: 'website', kind: 'OTHER', channel: 'OTHER', metadata: { visitorId: SECRETS.visitor, property: 'servicesinmycity', occurred_at: '2026-09-10T10:00:00.000Z' } });
  await w.interaction({ id: 'int_none', provider: 'website', kind: 'OTHER', channel: 'OTHER', metadata: { page: '/pricing', occurred_at: '2026-09-10T10:00:00.000Z' } });

  const { items } = await page(w, { kind: 'ORGANIZATION' });
  const by = (key: string) => items.find((i) => i.key === key)!;
  assert.deepEqual(by('interaction:int_phone').identity, { state: 'UNRESOLVED', basis: 'FACT_IDENTIFIER_PRESENT' });
  assert.deepEqual(by('interaction:int_phone').subjects, [{ kind: 'UNRESOLVED_IDENTIFIER', identifierKind: 'PHONE', assertionMode: null, evidenceRef: null }]);
  assert.deepEqual(by('interaction:int_email').subjects, [{ kind: 'UNRESOLVED_IDENTIFIER', identifierKind: 'EMAIL', assertionMode: null, evidenceRef: null }]);
  assert.deepEqual(by('interaction:int_visitor').identity, { state: 'ANONYMOUS', basis: 'CONTINUITY_KEY_PRESENT' });
  assert.deepEqual(by('interaction:int_visitor').subjects, [{ kind: 'ANONYMOUS_CONTINUITY', continuity: 'VISITOR', property: 'servicesinmycity', evidenceRef: null }]);
  assert.deepEqual(by('interaction:int_none').identity, { state: 'NOT_APPLICABLE', basis: 'NONE' });
});

test('no emitted item anywhere contains a contact value, a body or a free-text summary', async () => {
  const w = world();
  await w.interaction({ id: 'int_1', customerId: 'cust_1' });
  await w.interaction({ id: 'int_note', provider: null, kind: 'NOTE', channel: 'OTHER', direction: 'INTERNAL', customerId: 'cust_1', summary: SECRETS.note, payload: { loopKind: 'crm_note', actorType: 'HUMAN_AGENT', actorUserId: 'user_1', actorName: 'Sam', body: SECRETS.note } });
  await w.call();
  await w.observation({ note: SECRETS.note, reason: SECRETS.note });
  await w.audit();
  await w.thread();

  const everything = [
    ...(await page(w, { kind: 'ORGANIZATION' })).items,
    ...(await page(w, { kind: 'INTAKE_RECORD', customerId: 'cust_1' })).items,
    ...(await page(w, { kind: 'CASE', priorityId: 'case_1' })).items,
  ].map(serialized).join('\n');

  for (const [name, secret] of Object.entries(SECRETS)) {
    assert.equal(everything.includes(secret), false, `${name} leaked into an activity item`);
  }
  assert.doesNotMatch(everything, /4111|card number/);
});

test('no item carries a numeric confidence, a score or a probability', async () => {
  const w = world();
  await w.interaction();
  await w.call({ revenueCents: 9900 });
  await w.observation({ measuredEffectCents: 1234 });
  const everything = [
    ...(await page(w, { kind: 'ORGANIZATION' })).items,
    ...(await page(w, { kind: 'CASE', priorityId: 'case_1' })).items,
  ];
  for (const item of everything) {
    assert.doesNotMatch(serialized(item), /confidence|probability|"score"|likelihood/i, item.key);
    assert.equal(typeof item.display.semanticStatus === 'number', false);
  }
});

// --- 3. Ordering, paging and duplicates ----------------------------------------------

test('a composed feed is newest first across sources, and pages through exactly once', async () => {
  const w = world();
  await w.interaction({ id: 'int_a', occurredAt: w.at('2026-09-10T12:00:00.000Z') });
  await w.interaction({ id: 'int_b', occurredAt: w.at('2026-09-10T11:00:00.000Z') });
  await w.call({ id: 'mc_a', sourceOccurredAt: w.at('2026-09-10T11:30:00.000Z') });
  await w.call({ id: 'mc_b', sourceOccurredAt: w.at('2026-09-10T10:00:00.000Z') });
  await w.audit({ id: 'aud_a', createdAt: w.at('2026-09-10T13:00:00.000Z') });

  const whole = await page(w, { kind: 'ORGANIZATION' }, { limit: 50 });
  assert.deepEqual(
    whole.items.map((i) => i.key),
    ['audit-log:aud_a', 'interaction:int_a', 'marketplace-call:mc_a', 'interaction:int_b', 'marketplace-call:mc_b'],
  );
  assert.equal(whole.nextCursor, null);

  for (const limit of [1, 2, 3]) {
    const walked: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 20; guard++) {
      const p: Awaited<ReturnType<typeof page>> = await page(w, { kind: 'ORGANIZATION' }, { limit, cursor });
      walked.push(...p.items.map((i) => i.key));
      if (!p.nextCursor) break;
      cursor = p.nextCursor;
    }
    assert.deepEqual(walked, whole.items.map((i) => i.key), `limit ${limit}`);
    assert.equal(new Set(walked).size, walked.length, `limit ${limit}: nothing repeated`);
  }
});

test('items sharing an instant page without dropping or repeating one', async () => {
  const w = world();
  const same = w.at('2026-09-10T10:00:00.000Z');
  for (const id of ['int_1', 'int_2', 'int_3']) await w.interaction({ id, occurredAt: same });
  await w.call({ id: 'mc_1', sourceOccurredAt: same });

  const whole = await page(w, { kind: 'ORGANIZATION' }, { limit: 50 });
  assert.equal(whole.items.length, 4);
  const walked: string[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 20; guard++) {
    const p: Awaited<ReturnType<typeof page>> = await page(w, { kind: 'ORGANIZATION' }, { limit: 1, cursor });
    walked.push(...p.items.map((i) => i.key));
    if (!p.nextCursor) break;
    cursor = p.nextCursor;
  }
  assert.deepEqual(walked, whole.items.map((i) => i.key));
});

test('a call already reported as a channel fact is shown once', async () => {
  const w = world();
  await w.interaction({ id: 'int_call' });
  await w.call({ id: 'mc_dup', interactionId: 'int_call' });
  await w.call({ id: 'mc_own', interactionId: null });

  const { items, sources } = await page(w, { kind: 'ORGANIZATION' });
  const keys = items.map((i) => i.key);
  assert.ok(keys.includes('interaction:int_call'), 'the channel fact, which knows the identity state, survives');
  assert.ok(!keys.includes('marketplace-call:mc_dup'), 'the same occurrence is not listed twice');
  assert.ok(keys.includes('marketplace-call:mc_own'), 'a call no channel fact records is still shown');
  assert.ok(sources.find((s) => s.domain === 'callgrid')!.limitations.length > 0, 'and the page says so');
});

test('a cursor from another source does not skip or repeat this source\'s rows at the same instant', async () => {
  const w = world();
  const same = w.at('2026-09-10T10:00:00.000Z');
  // Keys sort: 'audit-log:…' < 'interaction:…' < 'marketplace-call:…', and the
  // order is descending by key, so the marketplace call leads at this instant.
  await w.audit({ id: 'aud_x', createdAt: same });
  await w.interaction({ id: 'int_x', occurredAt: same });
  await w.call({ id: 'mc_x', sourceOccurredAt: same });

  const first = await page(w, { kind: 'ORGANIZATION' }, { limit: 1 });
  assert.deepEqual(first.items.map((i) => i.key), ['marketplace-call:mc_x']);
  const second = await page(w, { kind: 'ORGANIZATION' }, { limit: 1, cursor: first.nextCursor });
  assert.deepEqual(second.items.map((i) => i.key), ['interaction:int_x']);
  const third = await page(w, { kind: 'ORGANIZATION' }, { limit: 1, cursor: second.nextCursor });
  assert.deepEqual(third.items.map((i) => i.key), ['audit-log:aud_x']);
});

test('a cursor this repository did not produce is refused', async () => {
  const w = world();
  await w.interaction();
  for (const bad of ['not-a-cursor', Buffer.from('{}', 'utf8').toString('base64url'), Buffer.from(JSON.stringify({ i: 'nope', k: 'x' })).toString('base64url')]) {
    await assert.rejects(() => page(w, { kind: 'ORGANIZATION' }, { cursor: bad }), /Invalid activity cursor/);
  }
});

test('a Case log pages through its own sequence without repeating an entry', async () => {
  const w = world();
  const same = w.at('2026-09-09T00:00:00.000Z');
  for (const seq of [1, 2, 3, 4]) {
    await w.observation({ id: `obs_${seq}`, sequence: seq, occurredAt: same, observationType: 'NOTE_ADDED', detectionKey: null, actorType: 'HUMAN', actorUserId: 'user_1' });
  }
  const whole = await page(w, { kind: 'CASE', priorityId: 'case_1' }, { limit: 50 });
  assert.equal(whole.items.length, 4);

  const walked: string[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 20; guard++) {
    const p: Awaited<ReturnType<typeof page>> = await page(w, { kind: 'CASE', priorityId: 'case_1' }, { limit: 1, cursor });
    walked.push(...p.items.map((i) => i.key));
    if (!p.nextCursor) break;
    cursor = p.nextCursor;
  }
  assert.deepEqual(walked, whole.items.map((i) => i.key));
  assert.equal(new Set(walked).size, 4, 'no entry appeared twice');
});

test('an item that breaks the contract is refused by the adapter, not shown', () => {
  const good = interactionActivityItem(
    { id: 'i1', organizationId: ORG_A, customerId: null, conversationId: null, channel: 'PHONE', kind: 'PHONE_CALL', direction: 'INBOUND', occurredAt: new Date('2026-09-10T10:00:00.000Z'), createdAt: new Date('2026-09-10T10:00:00.000Z'), summary: null, provider: 'callgrid', externalId: null, payload: {}, metadata: {} } as never,
    [{ resource: 'customers', action: 'view' }],
  );
  assert.deepEqual(validateActivityItem(good), []);

  // Every way an item can be wrong that the projection must never show: an invented
  // identity, a title carrying a contact value, a reserved subject, no stated
  // authority to read it.
  const broken = [
    { ...good, identity: { state: 'KNOWN_PARTY' as const, basis: 'GOVERNED_ATTRIBUTION' as const } },
    { ...good, display: { ...good.display, title: `call from ${SECRETS.phone}` } },
    { ...good, subjects: [{ kind: 'RELATIONSHIP' as const, id: 'rel_1' }] },
    { ...good, access: { requires: [], workspace: null } },
    { ...good, time: { ...good.time, occurredAt: null } },
  ];
  for (const item of broken) {
    assert.ok(validateActivityItem(item as never).length > 0, 'the contract rejects it');
    const { items, refused } = admit([item as never], null);
    assert.deepEqual(items, [], 'and the adapter refuses to emit it');
    assert.equal(refused.length, 1);
  }
});

// --- 4. Isolation and robustness ------------------------------------------------------

test('another organization\'s rows are never returned, and a subject from another organization is empty', async () => {
  const w = world();
  await w.interaction({ id: 'int_theirs', organizationId: ORG_B });
  await w.call({ id: 'mc_theirs', organizationId: ORG_B });
  await w.audit({ id: 'aud_theirs', organizationId: ORG_B });
  await w.observation({ id: 'obs_theirs', organizationId: ORG_B });
  await w.interaction({ id: 'int_ours' });

  const org = await page(w, { kind: 'ORGANIZATION' });
  assert.deepEqual(org.items.map((i) => i.key), ['interaction:int_ours']);
  const kase = await page(w, { kind: 'CASE', priorityId: 'case_1' });
  assert.deepEqual(kase.items, []);
  const intake = await page(w, { kind: 'INTAKE_RECORD', customerId: 'cust_1' });
  assert.deepEqual(intake.items, []);
});

test('incomplete or malformed source rows are reported honestly, never dropped or invented', async () => {
  const w = world();
  await w.interaction({ id: 'int_bare', provider: null, kind: 'OTHER', channel: 'OTHER', summary: null, metadata: null, payload: null });
  await w.interaction({ id: 'int_weird_meta', provider: 'website', metadata: 'not-an-object', kind: 'OTHER', channel: 'OTHER' });
  await w.call({ id: 'mc_nostatus', status: null, rawStatus: null, buyerExternalId: null });

  const { items } = await page(w, { kind: 'ORGANIZATION' });
  assert.equal(items.length, 3, 'nothing was dropped');
  for (const item of items) assert.deepEqual(validateActivityItem(item), [], item.key);

  const bare = items.find((i) => i.key === 'interaction:int_bare')!;
  assert.equal(bare.time.occurredAtBasis, 'LOOP_CLOCK');
  assert.equal(bare.provenance.transport, 'HUMAN_ENTRY');
  const website = items.find((i) => i.key === 'interaction:int_weird_meta')!;
  assert.equal(website.time.occurredAtBasis, 'LOOP_CLOCK');
  assert.ok(website.provenance.limitations.some((l) => l.includes('no occurrence time')), 'the fallback is stated, not hidden');
  const call = items.find((i) => i.key === 'marketplace-call:mc_nostatus')!;
  assert.equal(call.type, 'UNKNOWN_STATUS');
  assert.equal(call.display.semanticStatus, null);
  assert.deepEqual(call.subjects, []);
});

test('a subject that does not exist is an empty page, not an error and not a guess', async () => {
  const w = world();
  await w.interaction({ id: 'int_1', customerId: 'cust_1' });
  const gone = await page(w, { kind: 'INTAKE_RECORD', customerId: 'cust_deleted' });
  assert.deepEqual(gone.items, []);
  assert.equal(gone.nextCursor, null);
  const noCase = await page(w, { kind: 'CASE', priorityId: 'case_missing' });
  assert.deepEqual(noCase.items, []);
});

test('a filter narrows what is read, and excludes a source entirely rather than filtering after', async () => {
  const w = world();
  await w.interaction({ id: 'int_call' });
  await w.interaction({ id: 'int_web', provider: 'website', kind: 'OTHER', channel: 'OTHER', metadata: { occurred_at: '2026-09-10T10:00:00.000Z' } });
  await w.call({ id: 'mc_1' });
  await w.audit({ id: 'aud_1' });

  const comms = await page(w, { kind: 'ORGANIZATION' }, { filter: 'COMMUNICATIONS' });
  assert.deepEqual(comms.items.map((i) => i.key), ['interaction:int_call']);
  assert.equal(comms.sources.find((s) => s.domain === 'callgrid')!.rowsRead, 0, 'a source with nothing to say is not queried');
  assert.equal(comms.sources.find((s) => s.domain === 'audit')!.rowsRead, 0);

  const changes = await page(w, { kind: 'ORGANIZATION' }, { filter: 'CHANGES' });
  assert.deepEqual(changes.items.map((i) => i.key), ['audit-log:aud_1']);
});

test('every source reads at most one page of rows, however much it holds', async () => {
  const w = world();
  for (let i = 0; i < 40; i++) {
    await w.interaction({ id: `int_${i}`, occurredAt: w.at(`2026-09-10T10:${String(i).padStart(2, '0')}:00.000Z`) });
    await w.call({ id: `mc_${i}`, sourceOccurredAt: w.at(`2026-09-10T09:${String(i).padStart(2, '0')}:00.000Z`) });
  }
  w.calls.length = 0;
  const limit = 10;
  const p = await page(w, { kind: 'ORGANIZATION' }, { limit });
  assert.equal(p.items.length, limit);
  for (const source of p.sources) {
    assert.ok(source.rowsRead <= limit + 1, `${source.domain} read ${source.rowsRead} rows for a page of ${limit}`);
  }
  // One query per source, and not one more.
  const queries = w.calls.filter((c) => c.method === 'findMany');
  assert.equal(queries.length, 4, 'interaction, marketplace call, audit and Brain events (B5): one query each, no N+1');
  assert.equal(queries.filter((c) => c.delegate === 'brainEvent').length, 1);
});

test('a thread fan-out is two queries, never one per conversation', async () => {
  const w = world();
  for (let i = 0; i < 5; i++) await w.thread({ id: `conv_${i}` });
  w.calls.length = 0;
  const p = await page(w, { kind: 'INTAKE_RECORD', customerId: 'cust_1' }, { limit: 10 });
  assert.ok(p.items.length >= 5);
  const messageQueries = w.calls.filter((c) => c.delegate === 'message');
  assert.equal(messageQueries.length, 1, 'one message query for every thread');
  assert.equal(w.calls.filter((c) => c.delegate === 'conversation').length, 1);
});

// --- 5. Fences -------------------------------------------------------------------------

const REPO_ROOT = join(__dirname, '..', '..', '..');
const ADAPTER_DIR = join(__dirname, '..', 'src', 'repositories', 'activity');

function adapterSources(): { path: string; src: string }[] {
  return readdirSync(ADAPTER_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => ({
      path: join(ADAPTER_DIR, f),
      src: readFileSync(join(ADAPTER_DIR, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''),
    }))
    .concat([
      {
        path: join(__dirname, '..', 'src', 'repositories', 'activity-read-model.repository.ts'),
        src: readFileSync(join(__dirname, '..', 'src', 'repositories', 'activity-read-model.repository.ts'), 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''),
      },
    ]);
}

test('fence: no adapter writes, resolves identity, or reaches a linking or identity table', async () => {
  const files = adapterSources();
  assert.ok(files.length >= 6, 'the fence found the adapters');
  for (const { path, src } of files) {
    const rel = relative(REPO_ROOT, path);
    assert.doesNotMatch(src, /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/, `${rel} must not write`);
    assert.doesNotMatch(src, /customerPartyLink|CustomerPartyLink/, `${rel} must not reach linking`);
    assert.doesNotMatch(src, /cognitiveIdentity|identityEvidence|identityResolutionLink|PartyRepository|PartyReferenceRepository/, `${rel} must not resolve identity`);
    assert.doesNotMatch(src, /\$transaction|\$queryRaw|\$executeRaw/, `${rel} must not transact or use raw SQL`);
    assert.doesNotMatch(src, /confidence|probability|Math\.random/i, `${rel} must not carry a number nobody can defend`);
    assert.doesNotMatch(src, /Date\.now\(\)|new Date\(\)/, `${rel} must not stamp its own time`);
  }
});

test('the website occurrence keys are the ingestion path\'s own, not a second list', () => {
  // The website adapter decides PROVIDER_REPORTED vs LOOP_CLOCK by whether one of
  // the keys the INGESTION path looked for survived in what it kept. If that list
  // ever moves and this one does not, every website fact starts claiming a
  // provider time it never had. One definition, held by this test.
  const adapter = readFileSync(join(ADAPTER_DIR, 'interaction.adapter.ts'), 'utf8');
  const provider = readFileSync(join(REPO_ROOT, 'packages/providers/src/adapters/website.provider.ts'), 'utf8');
  const keys = adapter.match(/WEBSITE_TIME_KEYS = \[([^\]]*)\]/)?.[1];
  assert.ok(keys, 'the adapter names its occurrence keys');
  const list = keys!.split(',').map((k) => k.trim().replace(/['"]/g, '')).filter(Boolean);
  assert.deepEqual(list, ['occurred_at', 'timestamp', 'time', 'created_at']);
  for (const key of list) {
    assert.match(provider, new RegExp(`occurredRaw[\\s\\S]{0,120}'${key}'`), `the website ingestion path still looks for ${key}`);
  }
});

test('fence: no adapter projects a value it only had because the source kept it', async () => {
  for (const { path, src } of adapterSources()) {
    const rel = relative(REPO_ROOT, path);
    // `summary`, `note`, `body`, `before`/`after` may be TESTED for presence, never
    // placed in an item. The emitted title is built from closed vocabularies.
    assert.doesNotMatch(src, /title:\s*[^,\n]*\b(summary|note|body|reason|label)\b/, `${rel} must not title an item with free text`);
    assert.doesNotMatch(src, /(callerId|buyerLabel|vendorLabel|sourceLabel|campaignLabel|callerZip|callerState)\s*[,;)]/, `${rel} must not project a provider label or caller detail`);
  }
});
