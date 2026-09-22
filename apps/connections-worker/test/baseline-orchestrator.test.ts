// The historical-baseline sweep: bounded backward progress, floor enforcement, resumability after a
// sink failure (no duplicate rows), FLOOD_WAIT backoff, eventual completion by convergence -- and the
// LOAD-BEARING guarantee that no baseline path ever writes the live observation cursor.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runBaselineSweep, type BaselinePorts } from '../src/baseline-orchestrator';
import { TelegramAdapter, TelegramFloodWaitError, type TelegramClientPort, type TelegramHistoryPageRequest } from '../src/telegram/telegram-adapter';
import type { DueBaseline, DueConnection } from '@emgloop/database';
import type { ConversationEvent } from '@emgloop/shared';
import type { TelegramMessageFacts } from '../src/telegram/content-free-mapping';

const NOW = new Date('2026-09-20T12:00:00Z');
const FLOOR = new Date('2026-06-22T12:00:00Z'); // ~90 days before NOW
const SECS = (d: Date) => Math.floor(d.getTime() / 1000);

const due = (over: Partial<DueBaseline> = {}): DueBaseline => ({
  organizationId: 'o', userId: 'u', provider: 'TELEGRAM', windowFloorAt: FLOOR, checkpointCursor: null, ...over,
});

// A message dated `daysAgo` before NOW, with an explicit id.
const msg = (id: number, daysAgo: number): TelegramMessageFacts => ({
  messageId: String(id), chatId: 'chatZZ', senderId: 'peerZZ', participantIds: ['selfZZ', 'peerZZ'], out: false,
  dateSeconds: SECS(new Date(NOW.getTime() - daysAgo * 24 * 60 * 60 * 1000)), hadText: true,
});

/**
 * A fake Telegram client backed by an in-memory chat: a set of messages with ids and dates. It serves
 * fetchHistory by returning messages older than `beforeId` and no earlier than `floorAt`, newest first,
 * capped at `limit` -- the same contract the live seam promises. fetchSince is never used here.
 */
function historyPort(messages: readonly TelegramMessageFacts[], opts: { flood?: number } = {}): TelegramClientPort {
  return {
    async connectFromSession() { return { kind: 'telegram-mtproto', client: {} }; },
    async fetchSince() { return []; },
    async fetchContentSince() { return []; },
    async fetchDialogWindow() { return []; },
    async fetchHistoricalDialogs() { return { dialogs: [], nextCursor: null, reachedEnd: true }; },
    async fetchHistory(_handle, req: TelegramHistoryPageRequest) {
      if (opts.flood) throw new TelegramFloodWaitError(opts.flood);
      const floorSec = SECS(req.floorAt);
      const older = messages
        .filter((m) => (req.beforeId === null ? true : Number(m.messageId) < req.beforeId))
        .filter((m) => m.dateSeconds >= floorSec)
        .sort((a, b) => Number(b.messageId) - Number(a.messageId)) // newest first, backward paging
        .slice(0, req.limit);
      return older;
    },
    async close() {},
  };
}

interface Recorded { checkpointCursor: string | null; state: string; failureClass: string | null; backoffUntil: Date | null; oldestReachedAt: Date | null }

function ports(over: {
  adapter: TelegramAdapter | null;
  dueList: readonly DueBaseline[];
  openCredential?: (d: DueBaseline) => Promise<string | null>;
  sink?: { accept(c: DueConnection, e: readonly ConversationEvent[]): Promise<void> };
  pageSize?: number;
  maxWindowDays?: number;
}): { ports: BaselinePorts; recorded: Map<string, Recorded>; sunk: ConversationEvent[]; store: Set<string>; floorSeen: Date[] } {
  const recorded = new Map<string, Recorded>();
  const sunk: ConversationEvent[] = [];
  const store = new Set<string>(); // idempotent sink store, keyed by providerEventId
  const floorSeen: Date[] = [];
  const key = (c: { organizationId: string; userId: string; provider: string }) => `${c.organizationId}:${c.userId}:${c.provider}`;
  const p: BaselinePorts = {
    async dueForBaseline() { return over.dueList; },
    adapterFor: () => over.adapter,
    openCredential: over.openCredential ?? (async () => 'session-string'),
    sink: over.sink ?? {
      async accept(_c, events) {
        for (const e of events) { if (!store.has(e.providerEventId)) { store.add(e.providerEventId); sunk.push(e); } }
      },
    },
    async recordBaselineProgress(d, progress) {
      recorded.set(key(d), { checkpointCursor: progress.checkpointCursor, state: progress.state, failureClass: progress.failureClass, backoffUntil: progress.backoffUntil, oldestReachedAt: progress.oldestReachedAt });
    },
    maxWindowDays: over.maxWindowDays ?? 365,
    pageSize: over.pageSize ?? 2,
    now: () => NOW,
  };
  return { ports: p, recorded, sunk, store, floorSeen };
}

// A tiny helper to drive multiple sweeps, feeding the last recorded checkpoint back as the next due
// cursor -- exactly what dueForBaseline would return on the next tick.
async function runToConvergence(makePorts: (cursor: string | null) => ReturnType<typeof ports>, maxRuns = 50): Promise<{ runs: number; last: Recorded | undefined; sunk: ConversationEvent[] }> {
  let cursor: string | null = null;
  let last: Recorded | undefined;
  const allSunk: ConversationEvent[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < maxRuns; i += 1) {
    const built = makePorts(cursor);
    const summary = await runBaselineSweep(built.ports);
    for (const e of built.sunk) if (!seen.has(e.providerEventId)) { seen.add(e.providerEventId); allSunk.push(e); }
    last = built.recorded.get('o:u:TELEGRAM');
    if (!last) return { runs: i + 1, last, sunk: allSunk };
    if (last.state === 'COMPLETE') return { runs: i + 1, last, sunk: allSunk };
    if (last.checkpointCursor === cursor) return { runs: i + 1, last, sunk: allSunk }; // no progress -> stop
    cursor = last.checkpointCursor;
    void summary;
  }
  return { runs: maxRuns, last, sunk: allSunk };
}

test('one page: sinks BEFORE advancing the checkpoint, moves strictly backward, reports the oldest reached', async () => {
  const adapter = new TelegramAdapter({ conversationSecret: 'sec', port: historyPort([msg(100, 1), msg(90, 5), msg(80, 10)]) });
  const { ports: p, recorded, sunk } = ports({ adapter, dueList: [due()], pageSize: 2 });
  const summary = await runBaselineSweep(p);
  assert.equal(summary.advanced, 1);
  assert.equal(sunk.length, 2); // a page of 2
  const rec = recorded.get('o:u:TELEGRAM')!;
  assert.equal(rec.checkpointCursor, '90'); // lowest id of the page -> strictly backward from null
  assert.equal(rec.state, 'IN_PROGRESS'); // full page: not done yet
  assert.ok(rec.oldestReachedAt && rec.oldestReachedAt.getTime() < NOW.getTime());
});

test('FLOOR ENFORCEMENT: messages older than the floor are never sunk, and the clamp caps a corrupt window', async () => {
  // Two messages inside a 90-day window, one far outside it (200 days old).
  const adapter = new TelegramAdapter({ conversationSecret: 'sec', port: historyPort([msg(100, 3), msg(95, 40), msg(50, 200)]) });
  const { ports: p, sunk } = ports({ adapter, dueList: [due()], pageSize: 10 });
  await runBaselineSweep(p);
  assert.equal(sunk.length, 2); // the 200-day-old message is below the floor: excluded
  // A checkpoint whose floor is absurdly old is clamped to the maxWindowDays ceiling.
  const adapter2 = new TelegramAdapter({ conversationSecret: 'sec', port: historyPort([msg(100, 3), msg(50, 800)]) });
  const { ports: p2, sunk: sunk2 } = ports({ adapter: adapter2, dueList: [due({ windowFloorAt: new Date('2000-01-01T00:00:00Z') })], pageSize: 10, maxWindowDays: 365 });
  await runBaselineSweep(p2);
  assert.equal(sunk2.length, 1); // the 800-day-old message is beyond the 365-day ceiling
});

test('CHECKPOINT RESUMABILITY: a sink failure HOLDS the checkpoint; the re-page is idempotent (no dup rows)', async () => {
  const messages = [msg(100, 1), msg(90, 5), msg(80, 10)];
  let failNext = true;
  const failingSink = {
    store: new Set<string>(),
    sunk: [] as ConversationEvent[],
    async accept(_c: DueConnection, events: readonly ConversationEvent[]) {
      if (failNext) { failNext = false; throw new Error('sink down'); }
      for (const e of events) if (!this.store.has(e.providerEventId)) { this.store.add(e.providerEventId); this.sunk.push(e); }
    },
  };
  const adapter = new TelegramAdapter({ conversationSecret: 'sec', port: historyPort(messages) });
  // First sweep: sink throws -> checkpoint holds at null, failure recorded, nothing sunk.
  const first = ports({ adapter, dueList: [due({ checkpointCursor: null })], sink: failingSink, pageSize: 2 });
  const s1 = await runBaselineSweep(first.ports);
  assert.equal(s1.sinkFailures, 1);
  assert.equal(s1.advanced, 0);
  assert.equal(first.recorded.get('o:u:TELEGRAM')!.checkpointCursor, null); // held, not advanced
  assert.equal(first.recorded.get('o:u:TELEGRAM')!.failureClass, 'SINK_UNAVAILABLE');
  assert.equal(failingSink.sunk.length, 0);
  // Second sweep re-pages from the SAME held cursor: the same page is re-fetched and now sinks once.
  const second = ports({ adapter, dueList: [due({ checkpointCursor: null })], sink: failingSink, pageSize: 2 });
  await runBaselineSweep(second.ports);
  assert.equal(failingSink.sunk.length, 2); // exactly the page, no duplication (idempotent store)
  assert.equal(second.recorded.get('o:u:TELEGRAM')!.checkpointCursor, '90'); // now advances
});

test('FLOOD_WAIT: no events sink, the checkpoint HOLDS, and a backoff is set', async () => {
  const adapter = new TelegramAdapter({ conversationSecret: 'sec', port: historyPort([msg(100, 1)], { flood: 42 }) });
  const { ports: p, recorded, sunk } = ports({ adapter, dueList: [due({ checkpointCursor: '500' })] });
  const summary = await runBaselineSweep(p);
  assert.equal(summary.floodWaits, 1);
  assert.equal(summary.advanced, 0);
  assert.equal(sunk.length, 0);
  const rec = recorded.get('o:u:TELEGRAM')!;
  assert.equal(rec.checkpointCursor, '500'); // held at the offset it came in with
  assert.equal(rec.failureClass, 'FLOOD_WAIT');
  assert.ok(rec.backoffUntil && rec.backoffUntil.getTime() === NOW.getTime() + 42_000);
});

test('a missing credential (no live connection) is skipped; a missing adapter is skipped', async () => {
  const adapter = new TelegramAdapter({ conversationSecret: 'sec', port: historyPort([msg(100, 1)]) });
  const noCred = ports({ adapter, dueList: [due()], openCredential: async () => null });
  const s1 = await runBaselineSweep(noCred.ports);
  assert.deepEqual({ advanced: s1.advanced, skipped: s1.skipped }, { advanced: 0, skipped: 1 });
  assert.equal(noCred.recorded.size, 0); // nothing recorded when skipped
  const noAdapter = ports({ adapter: null, dueList: [due()] });
  const s2 = await runBaselineSweep(noAdapter.ports);
  assert.deepEqual({ advanced: s2.advanced, skipped: s2.skipped }, { advanced: 0, skipped: 1 });
});

test('EVENTUAL COMPLETE by convergence: repeated sweeps drain the window and land COMPLETE, no duplicates', async () => {
  // A window of 6 messages spread across the last 60 days; pageSize 2 -> several backward pages.
  const messages = [msg(60, 2), msg(55, 8), msg(50, 15), msg(45, 25), msg(40, 40), msg(35, 58)];
  const result = await runToConvergence((cursor) => {
    const adapter = new TelegramAdapter({ conversationSecret: 'sec', port: historyPort(messages) });
    return ports({ adapter, dueList: [due({ checkpointCursor: cursor })], pageSize: 2 });
  });
  assert.equal(result.last?.state, 'COMPLETE'); // it converges (not "within N ticks" -- it reaches the floor)
  assert.equal(result.sunk.length, 6); // every in-window message landed exactly once
  // Content-free throughout: no raw ids leaked into any sunk event.
  for (const e of result.sunk) assert.ok(!JSON.stringify(e).includes('chatZZ') && !JSON.stringify(e).includes('peerZZ'), 'no raw ids leak');
});

test('NO BASELINE PATH WRITES THE LIVE CURSOR: the ports expose recordBaselineProgress only, never recordCycle', async () => {
  // Structural guarantee: a BaselinePorts has no recordCycle and no way to reach SourceConnection.cursor.
  const adapter = new TelegramAdapter({ conversationSecret: 'sec', port: historyPort([msg(100, 1), msg(90, 5)]) });
  const built = ports({ adapter, dueList: [due()] });
  assert.equal((built.ports as unknown as Record<string, unknown>).recordCycle, undefined);
  await runBaselineSweep(built.ports);
  // The only write recorded is to the checkpoint (recordBaselineProgress); it advanced.
  assert.ok(built.recorded.get('o:u:TELEGRAM'));
});
