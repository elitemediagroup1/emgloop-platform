// HELD intelligence refresh requests in the worker's retention sweep (Loop Intelligence).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { workRetentionCategory } from '@emgloop/shared';

import { heldRefreshCutoff, runHeldRefreshRetention } from '../src/refresh-retention';

const NOW = new Date('2026-09-26T12:00:00Z');

test('the cutoff is the governed INTELLIGENCE_REFRESH_REQUESTS window, read from the policy', () => {
  const policy = workRetentionCategory('INTELLIGENCE_REFRESH_REQUESTS')!;
  assert.equal(policy.rule, 'DAYS');
  assert.match(policy.anchor, /HELD request last changing/);
  assert.deepEqual(heldRefreshCutoff(NOW), new Date(NOW.getTime() - policy.days! * 86_400_000));
  assert.equal(policy.days, 7, 'the policy states a week, and the sweep uses exactly it');
});

test('the step calls purgeHeld with that cutoff and logs a count only; a failure is logged by name and never thrown', async () => {
  const calls: Date[] = [];
  const logs: [string, Record<string, unknown> | undefined][] = [];
  const log = (e: string, f?: Record<string, unknown>) => void logs.push([e, f]);
  const ok = await runHeldRefreshRetention({ purgeHeld: async (cutoff) => (calls.push(cutoff), { purged: 3 }), now: () => NOW, log });
  assert.deepEqual(ok, { purged: 3 });
  assert.deepEqual(calls, [heldRefreshCutoff(NOW)]);
  assert.deepEqual(logs, [['refresh_purge', { purged: 3 }]], 'a count, never an organization, person, domain or subject');
  logs.length = 0;
  const failed = await runHeldRefreshRetention({ purgeHeld: async () => { throw new TypeError('org_secret user_secret'); }, now: () => NOW, log });
  assert.equal(failed, null);
  assert.deepEqual(logs, [['refresh_purge_error', { name: 'TypeError' }]]);
  assert.equal(JSON.stringify(logs).includes('secret'), false, 'the error message never reaches a log');
  logs.length = 0;
  await runHeldRefreshRetention({ purgeHeld: async () => ({ purged: 0 }), now: () => NOW, log });
  assert.deepEqual(logs, [], 'nothing purged, nothing said');
});

test('the worker sweep runs it as its own step, after the others, on the unconditional retention timer', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf8');
  const purge = src.slice(src.indexOf('  async function purge(): Promise<void> {'), src.indexOf('  // --- Disconnect'));
  const brief = purge.indexOf("log('brief_purge_error'");
  const refresh = purge.indexOf('runHeldRefreshRetention({ purgeHeld: (cutoff) => queue.purgeHeld(cutoff)');
  assert.ok(brief > 0 && refresh > brief, 'a step of its own, after the earlier ones');
  assert.match(purge.slice(brief), /try \{[\s\S]*IntelligenceRefreshQueueRepository[\s\S]*runHeldRefreshRetention[\s\S]*\} catch \(err\) \{\s*log\('refresh_purge_error'/, 'isolated: its failure cannot interrupt another step');
  assert.match(src, /const purgeTimer = setInterval\(\(\) => void purge\(\), RETENTION_SWEEP_MS\);/, 'not gated on any intelligence activation');
  const code = purge.slice(brief).replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /\b7\b|86_?400/, 'no magic number: the window is the policy\'s');
});
