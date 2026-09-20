// The observation sweep: dispatch by provider, sink-before-cursor, skip what it cannot honour.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runObservationSweep, type ObservationSink, type SweepPorts } from '../src/orchestrator';
import { TelegramAdapter, type TelegramClientPort } from '../src/telegram/telegram-adapter';
import type { ConnectionAdapter, DueConnection } from '@emgloop/database';
import type { ConversationEvent } from '@emgloop/shared';
import type { TelegramMessageFacts } from '../src/telegram/content-free-mapping';

const NOW = new Date('2026-09-20T12:00:00Z');
const due = (over: Partial<DueConnection> = {}): DueConnection => ({ organizationId: 'o', userId: 'u', provider: 'TELEGRAM', cursor: '5', ...over });
const facts = (id: string): TelegramMessageFacts => ({ messageId: id, chatId: 'c', senderId: 's', participantIds: ['self', 's'], out: false, dateSeconds: Math.floor(NOW.getTime() / 1000), hadText: true });

function tgAdapter(fetch: () => Promise<readonly TelegramMessageFacts[]>): TelegramAdapter {
  const port: TelegramClientPort = { async connectFromSession() { return { kind: 'telegram-mtproto', client: {} }; }, fetchSince: fetch, async close() {} };
  return new TelegramAdapter({ conversationSecret: 'sec', port });
}

interface Recorded { cursor: string | null; state: string; failureClass: string | null }

function ports(over: Partial<SweepPorts> & { dueList: readonly DueConnection[]; adapters?: Record<string, ConnectionAdapter | null>; sink?: ObservationSink }): { ports: SweepPorts; recorded: Map<string, Recorded>; sunk: ConversationEvent[] } {
  const recorded = new Map<string, Recorded>();
  const sunk: ConversationEvent[] = [];
  const key = (c: DueConnection) => `${c.organizationId}:${c.userId}:${c.provider}`;
  const p: SweepPorts = {
    async due() { return over.dueList; },
    adapterFor: (provider) => (over.adapters ? over.adapters[provider] ?? null : tgAdapter(async () => [facts('10')])),
    openCredential: over.openCredential ?? (async () => 'session-string'),
    async recordCycle(c, o) { recorded.set(key(c), { cursor: o.cursor, state: o.state, failureClass: o.failureClass }); },
    sink: over.sink ?? { async accept(_c, events) { sunk.push(...events); } },
    now: () => NOW,
  };
  return { ports: p, recorded, sunk };
}

test('a healthy connection is cycled: observations sink, then the cursor advances', async () => {
  const { ports: p, recorded, sunk } = ports({ dueList: [due()] });
  const summary = await runObservationSweep(p);
  assert.deepEqual(summary, { due: 1, cycled: 1, skipped: 0, sinkFailures: 0 });
  assert.equal(sunk.length, 1);
  assert.equal(recorded.get('o:u:TELEGRAM')?.cursor, '10'); // advanced
  assert.equal(recorded.get('o:u:TELEGRAM')?.state, 'READY');
});

test('the cursor never outruns the sink: a sink failure holds the cursor', async () => {
  const failingSink: ObservationSink = { async accept() { throw new Error('sink down'); } };
  const { ports: p, recorded } = ports({ dueList: [due({ cursor: '5' })], sink: failingSink });
  const summary = await runObservationSweep(p);
  assert.equal(summary.sinkFailures, 1);
  assert.equal(recorded.get('o:u:TELEGRAM')?.cursor, '5'); // held, not advanced to 10
  assert.equal(recorded.get('o:u:TELEGRAM')?.failureClass, 'SINK_UNAVAILABLE');
});

test('a provider with no adapter wired is skipped, untouched', async () => {
  const { ports: p, recorded } = ports({ dueList: [due({ provider: 'MICROSOFT_TEAMS' })], adapters: { MICROSOFT_TEAMS: null } });
  const summary = await runObservationSweep(p);
  assert.deepEqual(summary, { due: 1, cycled: 0, skipped: 1, sinkFailures: 0 });
  assert.equal(recorded.size, 0); // nothing recorded
});

test('a credential that will not open is skipped, not guessed', async () => {
  const { ports: p, recorded } = ports({ dueList: [due()], openCredential: async () => null });
  const summary = await runObservationSweep(p);
  assert.deepEqual(summary, { due: 1, cycled: 0, skipped: 1, sinkFailures: 0 });
  assert.equal(recorded.size, 0);
});

test('an empty batch still records health and advances the cursor, sinks nothing', async () => {
  const { ports: p, recorded, sunk } = ports({ dueList: [due({ cursor: '5' })], adapters: { TELEGRAM: tgAdapter(async () => []) } });
  const summary = await runObservationSweep(p);
  assert.equal(summary.cycled, 1);
  assert.equal(sunk.length, 0);
  assert.equal(recorded.get('o:u:TELEGRAM')?.cursor, '5'); // cursorAfter([]) holds at 5
  assert.equal(recorded.get('o:u:TELEGRAM')?.state, 'READY');
});

test('a stale session records RECONNECT_REQUIRED and sinks nothing', async () => {
  const staleAdapter = tgAdapter(async () => { throw Object.assign(new Error('x'), { name: 'AuthError' }); });
  const authFailPort: TelegramClientPort = { async connectFromSession() { throw Object.assign(new Error('x'), { name: 'AuthError' }); }, async fetchSince() { return []; }, async close() {} };
  const adapter = new TelegramAdapter({ conversationSecret: 'sec', port: authFailPort });
  const { ports: p, recorded, sunk } = ports({ dueList: [due()], adapters: { TELEGRAM: adapter } });
  const summary = await runObservationSweep(p);
  assert.equal(summary.cycled, 1);
  assert.equal(sunk.length, 0);
  assert.equal(recorded.get('o:u:TELEGRAM')?.state, 'RECONNECT_REQUIRED');
  void staleAdapter;
});
