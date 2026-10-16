import test from 'node:test';
import assert from 'node:assert/strict';
import { callGridHost, readCallGridHostConfig, type CallGridHostPorts } from '../src/callgrid-host';
import type { RoutinePollResult } from '@emgloop/database';

function fixture() {
  let now = new Date('2026-10-16T00:00:00Z');
  let calls = 0, changed = 0;
  const logs: unknown[] = [];
  const result = { plan: { plan: 'POLL', until: now }, checkpointAfter: now,
    execution: { outcome: 'APPLIED', newEvents: 1, strengthenedCalls: 0 } } as RoutinePollResult;
  const ports: CallGridHostPorts = {
    organization: async () => ({ id: 'bound-org', status: 'ACTIVE' }),
    poll: async (input) => { calls++; assert.equal(input.organizationId, 'bound-org'); assert.equal(input.mode, 'frontier'); assert.equal(input.policy.safetyLagMs, 0); return result; },
    changed: () => { changed++; }, now: () => now,
    log: (...args) => { logs.push(args); },
  };
  return { ports, result, logs, advance: (ms: number) => { now = new Date(now.getTime() + ms); }, calls: () => calls, changed: () => changed };
}
const config = { organizationSlug: 'our-org', apiKey: 'test-credential-never-logged' };
test('disabled host touches no source; malformed activation or missing credential fails closed', async () => {
  const f = fixture();
  const host = callGridHost(readCallGridHostConfig({}), f.ports);
  assert.equal(host.scheduled, false); await host.pass(); assert.equal(f.calls(), 0);
  assert.throws(() => readCallGridHostConfig({ LOOP_CALLGRID_ORGANIZATION: 'org' }), /MISSING_CALLGRID_API_KEY/);
  assert.throws(() => readCallGridHostConfig({ LOOP_CALLGRID_ORGANIZATION: 'org,other' }), /INVALID_LOOP_CALLGRID_ORGANIZATION/);
});
test('changed API records request synthesis; unchanged reads do not; logs contain no credentials', async () => {
  const f = fixture(), host = callGridHost(config, f.ports);
  await host.pass(); assert.equal(f.changed(), 1);
  f.result.execution!.newEvents = 0;
  await host.pass(); assert.equal(f.changed(), 1);
  assert.ok(!JSON.stringify(f.logs).includes(config.apiKey));
});
test('single-flight reads never overlap and stop waits for the active read', async () => {
  const f = fixture(); let finish!: (r: RoutinePollResult) => void;
  f.ports.poll = async () => { await new Promise<RoutinePollResult>(resolve => { finish = resolve; }); return f.result; };
  const host = callGridHost(config, f.ports);
  const first = host.pass(); await Promise.resolve();
  assert.equal(host.pass(), first);
  let stopped = false; const stop = host.stop().then(() => { stopped = true; });
  await Promise.resolve(); assert.equal(stopped, false);
  finish(f.result); await stop; assert.equal(f.changed(), 0);
  await host.pass(); assert.equal(stopped, true);
});
test('incomplete coverage backs off; changed partial writes still request synthesis without claiming proof', async () => {
  const f = fixture(); f.result.execution!.outcome = 'PARTIALLY_APPLIED';
  f.result.checkpointAfter = null;
  const host = callGridHost(config, f.ports);
  await host.pass(); await host.pass(); assert.equal(f.calls(), 1);
  assert.equal(f.changed(), 1); assert.match(JSON.stringify(f.logs), /"proven":false/);
  f.advance(60_000); await host.pass(); assert.equal(f.calls(), 2);
});
test('unavailable or suspended organizations never call the API; errors never log raw failure values', async () => {
  const f = fixture(); f.ports.organization = async () => ({ id: 'bound-org', status: 'SUSPENDED' });
  const host = callGridHost(config, f.ports); await host.pass(); assert.equal(f.calls(), 0);
  f.advance(60_000); f.ports.organization = async () => { throw new Error(config.apiKey); };
  await host.pass(); assert.ok(!JSON.stringify(f.logs).includes(config.apiKey));
});
