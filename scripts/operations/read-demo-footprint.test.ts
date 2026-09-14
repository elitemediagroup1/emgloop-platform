import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { DemoFootprint } from '@emgloop/database';
import { parseArgs, readEnvironment, runDemoFootprint } from './read-demo-footprint';

const ORG = { id: 'org_live', slug: 'servicesinmycity-demo' };

function footprint(overrides: Partial<DemoFootprint> = {}): DemoFootprint {
  return {
    organization: { id: ORG.id, createdAt: '2026-06-24T00:00:00.000Z', nameMatchesSeedUpsert: true },
    totals: { markedInteractions: 5, mockMessages: 1, scriptedReplies: 1, mockBookings: 1, identityMatches: 1 },
    suspects: [{
      id: 'cust_web_a',
      createdAt: '2026-07-01T12:01:00.000Z',
      attribution: 'WEB_DEMO_LOOP',
      flags: ['MOCK_SMS_INTERACTION', 'MOCK_CALENDAR_BOOKING'],
      legitimacySignals: [],
      dependencies: {
        interactions: ['ix_1', 'ix_2'], demoInteractions: ['ix_1', 'ix_2'], conversations: ['conv_1'],
        messages: ['msg_1'], mockMessages: ['msg_1'], bookings: ['bk_1'], mockBookings: ['bk_1'],
        orders: [], serviceRequests: [], signals: ['sig_1'], partyLinks: [], domainEvents: ['ev_1'],
        auditEntries: [], humanAuditEntries: [], outboxEntries: [], decisionEvidence: [],
      },
    }],
    orphans: [{ table: 'booking', id: 'bk_orphan', createdAt: '2026-07-02T00:00:00.000Z', reason: 'NO_CUSTOMER' }],
    exceededBound: false,
    ...overrides,
  };
}

function deps(f: DemoFootprint, known = true) {
  const lines: string[] = [];
  return {
    lines,
    deps: {
      organizations: { findBySlug: async (slug: string) => (known && slug === ORG.slug ? ORG : null) },
      reader: { footprint: async (id: string) => { assert.equal(id, ORG.id); return f; } },
      log: (l: string) => lines.push(l),
    },
  };
}

test('refuses a malformed slug before reading anything', async () => {
  const { deps: d, lines } = deps(footprint());
  const result = await runDemoFootprint({ organizationSlug: 'Bad Slug; drop' }, d);
  assert.equal(result.overall, 'FAILED_PRECONDITION');
  assert.match(lines[0]!, /event=PRECONDITION_FAILED/);
});

test('refuses an unknown organization; it never provisions one', async () => {
  const { deps: d } = deps(footprint(), false);
  const result = await runDemoFootprint({ organizationSlug: 'servicesinmycity-demo' }, d);
  assert.equal(result.overall, 'FAILED_PRECONDITION');
  assert.equal(result.error, 'unknown organization');
});

test('prints each suspect, its dependency ids, orphans and a verdict', async () => {
  const { deps: d, lines } = deps(footprint());
  const result = await runDemoFootprint({ organizationSlug: ORG.slug }, d);
  assert.equal(result.overall, 'READ');
  const out = lines.join('\n');
  assert.match(out, /event=SUSPECT_CUSTOMER id=cust_web_a createdAt=2026-07-01T12:01:00.000Z attribution=WEB_DEMO_LOOP FLAGS=MOCK_SMS_INTERACTION,MOCK_CALENDAR_BOOKING LEGITIMACY_SIGNALS=NONE/);
  assert.match(out, /event=SUSPECT_DEPENDENCIES customer=cust_web_a interactions=ix_1,ix_2 conversations=conv_1 messages=msg_1 bookings=bk_1 orders=NONE/);
  assert.match(out, /event=ORPHAN_ARTIFACT table=booking id=bk_orphan/);
  assert.match(out, /event=VERDICT SUSPECTED_CUSTOMERS=1 WEB_DEMO_LOOP=1 PRISMA_SEED=0 DEMO_IDENTITY_ONLY=0 WITH_LEGITIMACY_SIGNALS=0 ORPHANS=1 EXCEEDED_BOUND=false OVERALL_RESULT=READ/);
});

test('an exceeded bound is printed, not hidden', async () => {
  const { deps: d, lines } = deps(footprint({ exceededBound: true }));
  await runDemoFootprint({ organizationSlug: ORG.slug }, d);
  assert.match(lines.at(-1)!, /EXCEEDED_BOUND=true/);
});

test('an empty footprint is an answer', async () => {
  const { deps: d, lines } = deps(footprint({ suspects: [], orphans: [], totals: { markedInteractions: 0, mockMessages: 0, scriptedReplies: 0, mockBookings: 0, identityMatches: 0 } }));
  await runDemoFootprint({ organizationSlug: ORG.slug }, d);
  assert.match(lines.at(-1)!, /SUSPECTED_CUSTOMERS=0 .* ORPHANS=0 EXCEEDED_BOUND=false OVERALL_RESULT=READ/);
});

test('arguments and environment', () => {
  assert.deepEqual(parseArgs(['--organization', ' servicesinmycity-demo ']), { organization: 'servicesinmycity-demo' });
  assert.deepEqual(readEnvironment({}), { ok: false, missing: ['DATABASE_URL'] });
  assert.deepEqual(readEnvironment({ DATABASE_URL: 'postgres://x' }), { ok: true });
});

test('the runner and its workflow cannot write', () => {
  const runner = readFileSync(new URL('./read-demo-footprint.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const symbol of ['create(', 'update(', 'upsert(', 'delete(', 'Many(', '$executeRaw', '$queryRaw', 'fetch(', 'writeFile']) {
    assert.equal(runner.includes(symbol), false, symbol);
  }
  const workflow = readFileSync(new URL('../../.github/workflows/read-demo-footprint.yml', import.meta.url), 'utf8');
  assert.match(workflow, /on:\s*\n\s*workflow_dispatch:/);
  assert.equal(/^\s*(push|pull_request|schedule|workflow_call):/m.test(workflow), false, 'dispatch only');
  assert.match(workflow, /permissions:\s*\n\s*contents: read/);
  assert.match(workflow, /npm run read:demo-footprint -- --organization "\$\{ORG_SLUG\}"/);
});
