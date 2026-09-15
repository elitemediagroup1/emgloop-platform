// Reading activity that belongs to no Person.
//
// Ingestion links no call and no website event to a Customer. Two readers assumed
// a Customer was there:
//
//   - The inbox named a call with no Customer "Unknown customer", which says a
//     customer exists and is merely unnamed.
//   - Website journeys were built per Customer, so with none they would be empty.
//
// Both now work from the event's own facts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CrmRepository, unidentifiedSubjectLabel } from '../src/repositories/crm.repository';
import { WebsiteAnalyticsRepository, journeyKey } from '../src/repositories/website-analytics.repository';
import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';

const ORG = 'org_live';
type Row = Record<string, any>;

// --- The inbox -------------------------------------------------------------------------

async function withInteractions(rows: Row[]) {
  const prisma: Row = makeCognitivePrisma({ also: ['interaction'] });
  for (const r of rows) await prisma.interaction.create({ data: { organizationId: ORG, ...r } });
  return prisma;
}

test('the inbox says who an interaction with no Person was: nobody identified yet', async () => {
  assert.equal(unidentifiedSubjectLabel({ channel: 'PHONE', provider: 'callgrid' }), 'Unidentified caller');
  assert.equal(unidentifiedSubjectLabel({ channel: 'OTHER', provider: 'website' }), 'Unidentified visitor');
  assert.equal(unidentifiedSubjectLabel({ channel: 'EMAIL', provider: null }), 'No person linked');

  const at = new Date('2026-09-15T14:05:00.000Z');
  const prisma = await withInteractions([
    { id: 'int_call', channel: 'PHONE', kind: 'PHONE_CALL', direction: 'INBOUND', provider: 'callgrid', occurredAt: at, payload: {} },
    { id: 'int_web', channel: 'OTHER', kind: 'FORM_SUBMISSION', direction: 'INBOUND', provider: 'website', occurredAt: new Date(at.getTime() - 1000), payload: {} },
  ]);
  const feed = await new CrmRepository(prisma as never).inboxFeed(ORG);
  assert.deepEqual(
    feed.map((i) => [i.id, i.customerName]),
    [
      ['int_call', 'Unidentified caller'],
      ['int_web', 'Unidentified visitor'],
    ],
  );
  assert.ok(feed.every((i) => i.customerName !== 'Unknown customer'));
});

// --- Website journeys follow the visitor ---------------------------------------------

test('a website journey belongs to the visitor, or to the session when there is no visitor id', () => {
  assert.equal(journeyKey({ visitorId: 'v-1', sessionId: 's-1' }), 'visitor:v-1');
  assert.equal(journeyKey({ sessionId: 's-1' }), 'session:s-1');
  assert.equal(journeyKey({}), null);
});

test('anonymous visitors still produce journeys with no Customer anywhere', async () => {
  const start = new Date('2026-09-15T00:00:00.000Z');
  const end = new Date('2026-09-16T00:00:00.000Z');
  const t = (m: number) => new Date(start.getTime() + m * 60_000);
  const prisma: Row = makeCognitivePrisma({ also: ['interaction', 'signal'] });
  const visit = (id: string, at: Date, eventType: string, visitorId: string) =>
    prisma.interaction.create({
      data: { id, organizationId: ORG, provider: 'website', channel: 'OTHER', occurredAt: at, metadata: { eventType, visitorId, sessionId: 's-' + visitorId } },
    });
  await visit('w1', t(1), 'web.search', 'v-a');
  await visit('w2', t(2), 'web.cta_click', 'v-a');
  await visit('w3', t(3), 'web.form_submit', 'v-a');
  await visit('w4', t(4), 'web.search', 'v-b');
  await visit('w5', t(5), 'web.cta_click', 'v-b');
  await visit('w6', t(6), 'web.form_submit', 'v-b');

  const analytics = await new WebsiteAnalyticsRepository(prisma as never).getWebsiteAnalytics(ORG, start, end);
  assert.deepEqual(analytics.commonJourneys, [{ label: 'search → cta_click → form_submit', count: 2 }]);
});
