// Website evidence retention on the worker (2026-09-30): aggregate windows past the policy window are purged;
// raw website telemetry is purged ONLY when LOOP_WEBSITE_TELEMETRY_RETENTION=on, which nothing sets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWebsiteRetention } from '../src/website-retention';

const NOW = new Date('2026-09-30T12:00:00Z');
const DAY = 864e5;

function ports(telemetryEnabled: boolean) {
  const calls: { kind: string; cutoff: Date }[] = [];
  const logs: string[] = [];
  return {
    calls,
    logs,
    p: {
      telemetryEnabled,
      purgeTelemetry: async (cutoff: Date) => (calls.push({ kind: 'telemetry', cutoff }), { interactions: 3, integrationEvents: 4 }),
      purgeAggregates: async (cutoff: Date) => (calls.push({ kind: 'aggregates', cutoff }), { purged: 2 }),
      now: () => NOW,
      log: (e: string) => void logs.push(e),
    },
  };
}

test('22: off by default -- raw telemetry is never purged; aggregates are, at 400 days', async () => {
  const { p, calls } = ports(false);
  const r = await runWebsiteRetention(p);
  assert.deepEqual(calls.map((c) => c.kind), ['aggregates']);
  assert.equal(calls[0]!.cutoff.getTime(), NOW.getTime() - 400 * DAY);
  assert.equal(r.telemetry, null);
  assert.equal(r.aggregates, 2);
});

test('enabled explicitly: raw telemetry is purged at 90 days', async () => {
  const { p, calls, logs } = ports(true);
  const r = await runWebsiteRetention(p);
  const t = calls.find((c) => c.kind === 'telemetry')!;
  assert.equal(t.cutoff.getTime(), NOW.getTime() - 90 * DAY);
  assert.deepEqual(r.telemetry, { interactions: 3, integrationEvents: 4 });
  assert.ok(logs.includes('website_telemetry_purge'));
});

test('a failing purge is reported by name and never thrown', async () => {
  const { p, logs } = ports(true);
  await runWebsiteRetention({ ...p, purgeAggregates: async () => { throw new TypeError('boom'); }, purgeTelemetry: async () => { throw new RangeError('boom'); } });
  assert.ok(logs.includes('website_aggregate_purge_error'));
  assert.ok(logs.includes('website_telemetry_purge_error'));
});
