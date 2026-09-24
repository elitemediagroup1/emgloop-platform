// The derived-work retention sweep (§21.2 "voluntary disconnect: frozen, deleted at 30 days"), with
// fakes for both ports. No database: the scoped delete and its audit row are the repository's and are
// proven against Postgres in packages/database/test/work-withdrawal.postgres.test.ts.
//
// WHAT IT PROVES
//   - every connection discovery returns is offered to the scoped delete, once, with the sweep's clock;
//   - a delete the repository refuses (live again, inside the window, nothing there) is counted as skipped,
//     never as deleted;
//   - one principal's failure never stops the sweep, and is counted;
//   - the summary is counts only, and nothing due means nothing happens.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { DerivedExpiryOutcome, DueDerivedExpiry } from '@emgloop/database';

import { runDerivedRetentionSweep, type DerivedRetentionPorts } from '../src/derived-retention';

const NOW = new Date('2026-10-25T06:00:00Z');
const due = (userId: string): DueDerivedExpiry => ({ organizationId: 'o1', userId, provider: 'TELEGRAM' });

function ports(
  dueList: readonly DueDerivedExpiry[],
  outcomes: Record<string, DerivedExpiryOutcome | Error>,
): { ports: DerivedRetentionPorts; calls: { due: DueDerivedExpiry; now: Date }[]; discoveredAt: Date[] } {
  const calls: { due: DueDerivedExpiry; now: Date }[] = [];
  const discoveredAt: Date[] = [];
  return {
    calls,
    discoveredAt,
    ports: {
      async dueForDerivedExpiry(now) { discoveredAt.push(now); return dueList; },
      async expireDerivedWork(d, now) {
        calls.push({ due: d, now });
        const outcome = outcomes[d.userId] ?? { outcome: 'NOTHING_TO_DO' as const };
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
      now: () => NOW,
    },
  };
}

test('every due connection is offered to the scoped delete once, with the sweep clock; deleted and skipped are counted apart', async () => {
  const { ports: p, calls, discoveredAt } = ports([due('past'), due('reconnected'), due('empty')], {
    past: { outcome: 'EXPIRED', items: 4, observations: 9 },
    reconnected: { outcome: 'NOTHING_TO_DO' },
    empty: { outcome: 'NOTHING_TO_DO' },
  });
  const summary = await runDerivedRetentionSweep(p);
  assert.deepEqual(summary, { due: 3, principals: 1, deleted: 4, skipped: 2, failed: 0 });
  assert.deepEqual(calls.map((c) => c.due.userId), ['past', 'reconnected', 'empty']);
  assert.ok(calls.every((c) => c.now === NOW), 'one clock for discovery and delete');
  assert.deepEqual(discoveredAt, [NOW]);
});

test('one principal failing never stops the sweep; the failure is counted and the rest still run', async () => {
  const { ports: p, calls } = ports([due('a'), due('broken'), due('c')], {
    a: { outcome: 'EXPIRED', items: 1, observations: 2 },
    broken: new Error('db down'),
    c: { outcome: 'EXPIRED', items: 2, observations: 3 },
  });
  const summary = await runDerivedRetentionSweep(p);
  assert.deepEqual(summary, { due: 3, principals: 2, deleted: 3, skipped: 0, failed: 1 });
  assert.equal(calls.length, 3);
});

test('nothing due: nothing is offered, and the summary says so', async () => {
  const { ports: p, calls } = ports([], {});
  assert.deepEqual(await runDerivedRetentionSweep(p), { due: 0, principals: 0, deleted: 0, skipped: 0, failed: 0 });
  assert.equal(calls.length, 0);
});

test('the summary carries counts only: no organization, user or item identifiers', async () => {
  const { ports: p } = ports([due('u-secret')], { 'u-secret': { outcome: 'EXPIRED', items: 1, observations: 1 } });
  const summary = await runDerivedRetentionSweep(p);
  assert.equal(JSON.stringify(summary).includes('u-secret'), false);
  assert.equal(JSON.stringify(summary).includes('o1'), false);
  for (const value of Object.values(summary)) assert.equal(typeof value, 'number');
});
