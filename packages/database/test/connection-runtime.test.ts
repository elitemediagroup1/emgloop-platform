import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runConnectionCycle } from '../src/services/connections/connection-runtime';
import type { ConnectionAdapter, AdapterSession, ObservationResult } from '../src/services/connections/connection-adapter';
import type { CapabilityStatus } from '@emgloop/shared';

const NOW = new Date('2026-09-19T18:25:10Z');
const input = { organizationId: 'org_a', userId: 'u1', cursor: 'c0', secret: 'sealed-open' };

function adapter(over: Partial<ConnectionAdapter> & { bg?: CapabilityStatus } = {}): ConnectionAdapter {
  const session: AdapterSession = { provider: 'TELEGRAM', handle: {} };
  return {
    provider: 'TELEGRAM',
    resume: over.resume ?? (async () => session),
    observe: over.observe ?? (async (): Promise<ObservationResult> => ({ events: [], cursor: 'c1', backgroundObservation: over.bg ?? 'OPERATIONAL' })),
    disconnect: over.disconnect ?? (async () => undefined),
  };
}

test('operational background observation is READY and advances the cursor', async () => {
  let disconnected = false;
  const a = adapter({ disconnect: async () => { disconnected = true; }, observe: async () => ({ events: [{} as never, {} as never], cursor: 'c1', backgroundObservation: 'OPERATIONAL' }) });
  const r = await runConnectionCycle(a, input, NOW);
  assert.deepEqual([r.state, r.cursor, r.observed, r.failure], ['READY', 'c1', 2, null]);
  assert.equal(disconnected, true, 'session always released');
});

test('authenticated but gated background observation is CONNECTED_LIMITED, never READY', async () => {
  const r = await runConnectionCycle(adapter({ bg: 'GATED' }), input, NOW);
  assert.equal(r.state, 'CONNECTED_LIMITED');
  assert.equal(r.failure, null);
});

test('auth loss on resume becomes RECONNECT_REQUIRED, cursor preserved, no throw', async () => {
  const a = adapter({ resume: async () => { const e = new Error('x'); e.name = 'AuthError'; throw e; } });
  const r = await runConnectionCycle(a, input, NOW);
  assert.deepEqual([r.state, r.cursor, r.observed, r.failure], ['RECONNECT_REQUIRED', 'c0', 0, 'AUTH']);
});

test('a transient observe error becomes FAILED, cursor preserved, session released', async () => {
  let disconnected = false;
  const a = adapter({ observe: async () => { throw new Error('network blip'); }, disconnect: async () => { disconnected = true; } });
  const r = await runConnectionCycle(a, input, NOW);
  assert.deepEqual([r.state, r.cursor, r.failure], ['FAILED', 'c0', 'TRANSIENT']);
  assert.equal(disconnected, true);
});
