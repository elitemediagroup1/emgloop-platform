// Gmail ingestion: one employee's mailbox, into their own work state, and nobody else's.
//
// WHAT THESE PROVE
//
// The isolation first, because it is the one that matters most: a sync belongs to one principal,
// a colleague, an OWNER and an ADMIN each get their own mailbox and never another employee's
// rows, and another organization is not reachable at all.
//
// Then the synchronization itself, against the real service: the bounded first read, Gmail's own
// incremental mechanism, a history position Gmail has forgotten, and a periodic baseline. The
// cursor advances only for a complete read, and a failure never replaces one.
//
// Then the two things that are easy to get wrong and impossible to see: re-reading a message must
// not double-count a correspondent, and a thread's aggregate must be recomputed from the rows
// Loop holds rather than from the handful one pass happened to see.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
import { IamRepository } from '../src/repositories/iam.repository';
import { WorkGraphRepository, WorkSourceRepository, type WorkPrincipal } from '../src/repositories/work-state';
import { GmailSyncService, type GmailSensorPort } from '../src/services/work-state/gmail-sync.service';
import type { GmailMessageFact, GmailReadResult } from '@emgloop/shared';

const ORG_A = 'org_a';
const ORG_B = 'org_b';
const NOW = new Date('2026-09-18T12:00:00Z');
const SELF = 'matt@elitemediagroup.io';
const hash = (v: string) => createHash('sha256').update(v.trim().toLowerCase()).digest('hex');
const WORK_DELEGATES = ['workSourceCursor', 'workSyncRun', 'workCorrespondent', 'workThread', 'workMessage', 'workEvent', 'workDocument', 'workItem', 'workItemObservation', 'workBrief', 'workFeedback', 'employeeWorkPreferences', 'workRetentionOverride'];

function fact(over: Partial<GmailMessageFact> = {}): GmailMessageFact {
  return {
    provider: 'GOOGLE',
    messageId: 'm1',
    threadId: 't1',
    internalDate: new Date('2026-09-18T11:00:00Z'),
    labels: ['INBOX', 'UNREAD'],
    from: { address: 'ben@cashion.example', name: 'Ben Cashion' },
    to: [{ address: SELF, name: null }],
    cc: [],
    subject: 'Cashion pricing',
    headerMessageId: '<m1@mail.gmail.com>',
    inReplyTo: null,
    references: [],
    fromSelf: false,
    ...over,
  };
}

const okPage = (
  messages: GmailMessageFact[],
  over: { historyId?: string | null; truncated?: boolean; removed?: string[] } = {},
): GmailReadResult => ({
  ok: true,
  page: {
    messages,
    removedMessageIds: over.removed ?? [],
    nextHistoryId: over.historyId === undefined ? '9100' : over.historyId,
    nextPageToken: null,
    truncated: over.truncated ?? false,
    pagesRead: 1,
  },
});

function sensorDouble() {
  const windowCalls: { accessToken: string; newerThanDays: number }[] = [];
  const changeCalls: { accessToken: string; startHistoryId: string }[] = [];
  let windowAnswer: GmailReadResult = okPage([]);
  let changesAnswer: GmailReadResult = okPage([]);
  const port: GmailSensorPort = {
    readWindow: async (request) => {
      windowCalls.push({ accessToken: request.accessToken, newerThanDays: request.newerThanDays });
      return windowAnswer;
    },
    readChanges: async (request) => {
      changeCalls.push({ accessToken: request.accessToken, startHistoryId: request.startHistoryId });
      return changesAnswer;
    },
  };
  return {
    port,
    windowCalls,
    changeCalls,
    onWindow: (answer: GmailReadResult) => {
      windowAnswer = answer;
    },
    onChanges: (answer: GmailReadResult) => {
      changesAnswer = answer;
    },
  };
}

function world(options: { connection?: 'OK' | 'NOT_CONNECTED' | 'INSUFFICIENT_SCOPE' | 'EXPIRED' | 'UNAVAILABLE' } = {}) {
  const fake: any = makeCognitivePrisma({ also: ['organization', 'invitation', 'organizationMembership', ...WORK_DELEGATES] });
  const prisma = fake as PrismaClient;
  const sensor = sensorDouble();
  const tokenRequests: WorkPrincipal[] = [];
  let connectionState = options.connection ?? 'OK';
  let clock = NOW;
  const service = new GmailSyncService({
    sources: new WorkSourceRepository(prisma),
    graph: new WorkGraphRepository(prisma),
    sensor: sensor.port,
    addressHash: hash,
    now: () => clock,
    access: {
      accessToken: async (principal) => {
        tokenRequests.push(principal);
        return connectionState === 'OK' ? { ok: true, accessToken: `token-for-${principal.userId}` } : { ok: false, state: connectionState };
      },
      identity: async () => ({ selfAddress: SELF, internalDomains: ['elitemediagroup.io'] }),
    },
  });
  return {
    fake,
    prisma,
    sensor,
    service,
    tokenRequests,
    iam: new IamRepository(prisma),
    sources: new WorkSourceRepository(prisma),
    graph: new WorkGraphRepository(prisma),
    connection: (state: typeof connectionState) => {
      connectionState = state;
    },
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
  };
}
type World = ReturnType<typeof world>;

let people = 0;
async function person(w: World, organizationId: string, systemRole = 'EMPLOYEE'): Promise<WorkPrincipal> {
  people += 1;
  const user = await w.iam.createUser({ organizationId, email: `mail${people}@loop.test`, name: `Mail ${people}`, systemRole });
  await w.iam.activateUser(organizationId, user.id);
  return { organizationId, userId: user.id };
}

const messagesOf = (w: World, p: WorkPrincipal) => w.fake.workMessage.__rows.filter((r: any) => r.organizationId === p.organizationId && r.userId === p.userId);
const threadsOf = (w: World, p: WorkPrincipal) => w.fake.workThread.__rows.filter((r: any) => r.organizationId === p.organizationId && r.userId === p.userId);
const correspondentsOf = (w: World, p: WorkPrincipal) => w.fake.workCorrespondent.__rows.filter((r: any) => r.organizationId === p.organizationId && r.userId === p.userId);

// --- Isolation -----------------------------------------------------------------------------------

test('a mailbox belongs to one principal: nobody else can start it, and nobody else sees the rows', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  const bob = await person(w, ORG_A);
  const owner = await person(w, ORG_A, 'OWNER');
  const admin = await person(w, ORG_A, 'ADMIN');
  const elsewhere = await person(w, ORG_B, 'OWNER');

  w.sensor.onWindow(okPage([fact()]));
  const result = await w.service.syncGmail(alice);
  assert.equal(result.outcome, 'SUCCEEDED');
  assert.equal(messagesOf(w, alice).length, 1);
  assert.deepEqual(w.tokenRequests, [alice], 'the token was requested for Alice, and nobody else');

  // Everybody else syncing gets THEIR OWN mailbox (empty here) and cannot reach hers.
  w.sensor.onWindow(okPage([]));
  for (const [label, principal] of [['a colleague', bob], ['OWNER', owner], ['ADMIN', admin], ['another organization', elsewhere]] as const) {
    const theirs = await w.service.syncGmail(principal);
    assert.equal(theirs.written, 0, label);
    assert.equal(messagesOf(w, principal).length, 0, label);
    assert.equal(threadsOf(w, principal).length, 0, label);
    assert.equal(correspondentsOf(w, principal).length, 0, label);
  }
  assert.equal(messagesOf(w, alice).length, 1, 'and hers are untouched');

  // Every row carries both ids, so there is no shape of query that is org-only.
  for (const row of [...messagesOf(w, alice), ...threadsOf(w, alice), ...correspondentsOf(w, alice)]) {
    assert.equal(row.organizationId, ORG_A);
    assert.equal(row.userId, alice.userId);
  }
});

// --- Synchronization ------------------------------------------------------------------------------

test('the first pass is a bounded window and stores the boundary it was given', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  w.sensor.onWindow(okPage([fact()], { historyId: '9001' }));

  const result = await w.service.syncGmail(alice);
  assert.equal(result.mode, 'WINDOW');
  assert.equal(result.cursorAdvanced, true);
  assert.equal(w.sensor.windowCalls[0]!.newerThanDays, 14);
  const cursor = await w.sources.cursor(alice, 'GMAIL');
  assert.equal(cursor?.cursor, '9001');
  assert.equal(cursor?.cursorKind, 'GMAIL_HISTORY_ID');
});

test('every pass after the first is incremental, against the stored position', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  w.sensor.onWindow(okPage([fact()], { historyId: '9001' }));
  await w.service.syncGmail(alice);

  w.advance(60_000);
  w.sensor.onChanges(okPage([fact({ messageId: 'm2' })], { historyId: '9200' }));
  const second = await w.service.syncGmail(alice);

  assert.equal(second.mode, 'INCREMENTAL');
  assert.deepEqual(w.sensor.changeCalls.map((c) => c.startHistoryId), ['9001']);
  assert.equal(w.sensor.windowCalls.length, 1, 'the window is not re-read');
  assert.equal((await w.sources.cursor(alice, 'GMAIL'))?.cursor, '9200');
});

test('a history position Gmail has forgotten causes ONE bounded re-baseline, not a crawl', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  w.sensor.onWindow(okPage([fact()], { historyId: '9001' }));
  await w.service.syncGmail(alice);

  w.advance(8 * 86_400_000);
  w.sensor.onChanges({ ok: false, failure: 'CURSOR_EXPIRED' });
  w.sensor.onWindow(okPage([fact({ messageId: 'm2' })], { historyId: '9500' }));
  const recovered = await w.service.syncGmail(alice);

  assert.equal(recovered.mode, 'REBASELINE');
  assert.equal(recovered.outcome, 'SUCCEEDED');
  assert.equal(w.sensor.windowCalls.length, 2, 'exactly one more window read');
  assert.equal((await w.sources.cursor(alice, 'GMAIL'))?.cursor, '9500');
});

test('a requested baseline re-reads the window although a position exists, and replaces it', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  w.sensor.onWindow(okPage([fact()], { historyId: '9001' }));
  await w.service.syncGmail(alice);

  w.advance(7 * 86_400_000);
  w.sensor.onWindow(okPage([fact({ messageId: 'm2' })], { historyId: '9900' }));
  const baseline = await w.service.syncGmail(alice, { baseline: true });

  assert.equal(baseline.mode, 'REBASELINE');
  assert.equal(w.sensor.changeCalls.length, 0, 'the stored position was not used');
  assert.equal((await w.sources.cursor(alice, 'GMAIL'))?.cursor, '9900');
});

test('a failed or truncated pass leaves the employee exactly where they were', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  w.sensor.onWindow(okPage([fact()], { historyId: '9001' }));
  await w.service.syncGmail(alice);

  // Failure: the position stays, the rows stay, and the class is recorded.
  w.sensor.onChanges({ ok: false, failure: 'RATE_LIMITED' });
  const failed = await w.service.syncGmail(alice);
  assert.equal(failed.outcome, 'FAILED');
  assert.equal(failed.failure, 'RATE_LIMITED');
  assert.equal(failed.cursorAdvanced, false);
  let cursor = await w.sources.cursor(alice, 'GMAIL');
  assert.equal(cursor?.cursor, '9001');
  assert.equal(cursor?.lastFailureClass, 'RATE_LIMITED');
  assert.equal(messagesOf(w, alice).length, 1, 'a failed read is never an empty inbox');

  // Truncation: what was read is kept, and no boundary is stored.
  w.sensor.onChanges(okPage([fact({ messageId: 'm2' })], { historyId: null, truncated: true }));
  const truncated = await w.service.syncGmail(alice);
  assert.equal(truncated.outcome, 'TRUNCATED');
  assert.equal(truncated.cursorAdvanced, false);
  cursor = await w.sources.cursor(alice, 'GMAIL');
  assert.equal(cursor?.cursor, '9001');
  assert.equal(messagesOf(w, alice).length, 2);
});

test('every connection refusal keeps its own class, and reads no mailbox at all', async () => {
  for (const [state, recorded] of [
    ['NOT_CONNECTED', 'AUTH'],
    ['INSUFFICIENT_SCOPE', 'AUTH'],
    ['EXPIRED', 'AUTH'],
    ['UNAVAILABLE', 'UNAVAILABLE'],
  ] as const) {
    const w = world({ connection: state });
    const alice = await person(w, ORG_A);
    const result = await w.service.syncGmail(alice);
    assert.equal(result.outcome, 'FAILED', state);
    assert.equal(w.sensor.windowCalls.length, 0, state);
    assert.equal(w.sensor.changeCalls.length, 0, state);
    const runs = await w.sources.recentRuns(alice);
    assert.equal(runs[0]!.failureClass, recorded, state);
    assert.equal(runs[0]!.source, 'GMAIL');
  }
});

// --- Idempotency and aggregates -------------------------------------------------------------------

test('re-reading a message changes nothing, and never counts a correspondent twice', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  const first = fact();
  w.sensor.onWindow(okPage([first], { historyId: '1' }));
  await w.service.syncGmail(alice);

  const before = correspondentsOf(w, alice);
  assert.equal(before.length, 1, 'the employee is not their own correspondent');
  assert.equal(before[0].displayAddress, 'ben@cashion.example');
  assert.equal(before[0].displayName, 'Ben Cashion');
  assert.equal(before[0].inboundCount, 1);
  assert.equal(before[0].domain, 'cashion.example');

  // The same message again, through a baseline: an upsert, not a second row and not a second count.
  w.sensor.onWindow(okPage([first], { historyId: '2' }));
  await w.service.syncGmail(alice, { baseline: true });
  const after = correspondentsOf(w, alice);
  assert.equal(after.length, 1);
  assert.equal(after[0].inboundCount, 1, 'a re-read is not a new observation');
  assert.equal(messagesOf(w, alice).length, 1);
  assert.equal(threadsOf(w, alice).length, 1);
});

test('a thread is counted, spanned and attributed from the rows Loop holds', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  const inbound = fact({ messageId: 'm1', internalDate: new Date('2026-09-18T09:00:00Z'), subject: 'Cashion pricing' });
  const mine = fact({
    messageId: 'm2',
    internalDate: new Date('2026-09-18T10:00:00Z'),
    subject: 'Re: Cashion pricing',
    from: { address: SELF, name: 'Matt' },
    to: [{ address: 'ben@cashion.example', name: null }],
    fromSelf: true,
    labels: ['SENT'],
  });
  w.sensor.onWindow(okPage([inbound, mine], { historyId: '1' }));
  await w.service.syncGmail(alice);

  const [thread] = threadsOf(w, alice);
  assert.equal(thread.messageCount, 2);
  assert.equal(thread.subject, 'Cashion pricing', 'the conversation keeps its first subject');
  assert.equal(new Date(thread.firstMessageAt).toISOString(), '2026-09-18T09:00:00.000Z');
  assert.equal(new Date(thread.lastMessageAt).toISOString(), '2026-09-18T10:00:00.000Z');
  assert.equal(thread.lastDirection, 'OUTBOUND', 'the employee answered last');
  assert.equal(thread.lastMessageId, 'm2');
  assert.deepEqual([...thread.labels], ['SENT'], 'the newest message decides what the thread is');
  assert.equal(thread.participantHashes.includes(hash('ben@cashion.example')), true);

  // A direction is the message's own, and the employee's own message is outbound.
  const rows = messagesOf(w, alice).sort((a: any, b: any) => a.messageId.localeCompare(b.messageId));
  assert.deepEqual(rows.map((r: any) => r.direction), ['INBOUND', 'OUTBOUND']);
  assert.deepEqual(rows[1].labels, ['SENT']);
});

test('a message Gmail says is gone, goes -- and its thread is recounted without it', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  w.sensor.onWindow(okPage([fact({ messageId: 'm1' }), fact({ messageId: 'm2', internalDate: new Date('2026-09-18T11:30:00Z') })], { historyId: '1' }));
  await w.service.syncGmail(alice);
  assert.equal(threadsOf(w, alice)[0].messageCount, 2);

  w.sensor.onChanges(okPage([], { historyId: '2', removed: ['m2'] }));
  const result = await w.service.syncGmail(alice);
  assert.equal(result.removed, 1);
  assert.equal(messagesOf(w, alice).length, 1);
  assert.equal(threadsOf(w, alice)[0].messageCount, 1);

  // The last message of a thread going takes the thread with it: a conversation with no
  // messages would still be listed, and Gmail no longer has one.
  w.sensor.onChanges(okPage([], { historyId: '3', removed: ['m1'] }));
  await w.service.syncGmail(alice);
  assert.equal(messagesOf(w, alice).length, 0);
  assert.equal(threadsOf(w, alice).length, 0);
});

test('the service reaches no network, no model and no other employee', () => {
  const source = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'services', 'work-state', 'gmail-sync.service.ts'), 'utf8');
  for (const forbidden of ['fetch(', 'googleapis.com', 'anthropic', 'openai', 'AiRuntimeGateway', 'console.', 'process.env', 'findMany({ where: { organizationId }']) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
  assert.match(source, /syncGmail\(principal: WorkPrincipal, options: GmailSyncOptions = \{\}\)/);
  // It writes no body, because it is never given one: the fact it persists has no such field.
  for (const forbidden of ['body:', 'snippet:', 'html:', 'attachment']) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});
