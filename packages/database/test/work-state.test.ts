// Daily Loop work state (DL-1): the isolation boundary, the store, and the authority.
//
// Architecture: docs/architecture/daily-loop-employee-intelligence.md §20 and §26.7.
//
// WHAT THESE PROVE
//   - One employee's work state is readable by that employee and by nobody else: not another
//     member, not OWNER, not ADMIN, not another organization -- and not through a Permission
//     row, because the boundary is the data scope, not the action.
//   - There is no repository method that can read employee-private work state from an
//     organization alone, and a source scan says a future one cannot be added quietly.
//   - `employeeIntelligence` grants exactly view and update, to every human role, for their
//     own rows; AI_EMPLOYEE holds nothing whatever a Permission row says.
//   - An item's log and its projection are written together; a closed item carries an
//     outcome and an open one cannot.
//   - A brief is versioned rather than overwritten, and retention is a window per category
//     with an organization's override applied where it recorded one.
//   - Nothing in this slice reads Google, calls a model, or stores a message body.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';

import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
import { EMPLOYEE_INTELLIGENCE_GRANTS, IamRepository, matrixAllows } from '../src/repositories/iam.repository';
import {
  WorkBriefRepository,
  WorkFootprintRepository,
  WorkGraphRepository,
  WorkItemRepository,
  WorkPreferencesRepository,
  WorkSourceRepository,
  workScope,
  type WorkPrincipal,
} from '../src/repositories/work-state';

const ORG_A = 'org_a';
const ORG_B = 'org_b';
const T0 = new Date('2026-09-17T09:00:00Z');
const hash = (v: string) => createHash('sha256').update(v).digest('hex');

const WORK_STATE_DELEGATES = [
  'workSourceCursor',
  'workSyncRun',
  'workCorrespondent',
  'workThread',
  'workMessage',
  'workEvent',
  'workDocument',
  'workItem',
  'workItemObservation',
  'workBrief',
  'workFeedback',
  'employeeWorkPreferences',
  'workRetentionOverride',
];

function world() {
  const fake: any = makeCognitivePrisma({ also: ['organization', 'invitation', 'organizationMembership', ...WORK_STATE_DELEGATES] });
  const prisma = fake as PrismaClient;
  return {
    fake,
    prisma,
    iam: new IamRepository(prisma),
    sources: new WorkSourceRepository(prisma),
    graph: new WorkGraphRepository(prisma),
    items: new WorkItemRepository(prisma),
    briefs: new WorkBriefRepository(prisma),
    preferences: new WorkPreferencesRepository(prisma),
    footprint: new WorkFootprintRepository(prisma),
  };
}
type World = ReturnType<typeof world>;

let people = 0;
async function person(w: World, organizationId: string, systemRole = 'EMPLOYEE'): Promise<WorkPrincipal> {
  people += 1;
  const user = await w.iam.createUser({ organizationId, email: `person${people}@loop.test`, name: `Person ${people}`, systemRole });
  await w.iam.activateUser(organizationId, user.id);
  return { organizationId, userId: user.id };
}

/** Everything one person can see through every read path this slice exposes. */
async function everythingVisibleTo(w: World, principal: WorkPrincipal) {
  return {
    cursors: await w.sources.cursors(principal),
    runs: await w.sources.recentRuns(principal),
    correspondents: await w.graph.correspondents(principal),
    threads: await w.graph.threads(principal),
    messages: await w.graph.messages(principal, 'thread-1'),
    events: await w.graph.events(principal, { from: new Date('2026-01-01'), to: new Date('2027-01-01') }),
    documents: await w.graph.documents(principal),
    items: await w.items.items(principal),
    briefs: await w.briefs.recent(principal),
    feedback: await w.items.feedback(principal),
  };
}

/** One employee's full work state, so the isolation tests have something to fail to see. */
async function seed(w: World, principal: WorkPrincipal) {
  await w.sources.advanceCursor(principal, 'GMAIL', { cursor: '12345', cursorKind: 'GMAIL_HISTORY_ID', startedAt: T0, completedAt: T0 });
  const run = await w.sources.startRun(principal, 'GMAIL', T0);
  await w.sources.finishRun(principal, run.id, { finishedAt: T0, outcome: 'SUCCEEDED', examined: 10, written: 4 });
  await w.graph.recordCorrespondent(principal, {
    addressHash: hash('ben@cashionrods.com'),
    displayAddress: 'ben@cashionrods.com',
    displayName: 'Ben',
    domain: 'cashionrods.com',
    seenAt: T0,
    direction: 'INBOUND',
  });
  await w.graph.upsertThread(principal, {
    provider: 'GOOGLE',
    threadId: 'thread-1',
    subject: 'Pricing',
    participantHashes: [hash('ben@cashionrods.com')],
    messageCount: 2,
    firstMessageAt: T0,
    lastMessageAt: T0,
    lastDirection: 'INBOUND',
    lastMessageId: 'msg-2',
  });
  await w.graph.upsertMessage(principal, {
    provider: 'GOOGLE',
    messageId: 'msg-2',
    threadId: 'thread-1',
    internalDate: T0,
    direction: 'INBOUND',
    fromHash: hash('ben@cashionrods.com'),
    subject: 'Pricing',
    observedAt: T0,
  });
  await w.graph.upsertEvent(principal, { provider: 'GOOGLE', eventId: 'event-1', startsAt: T0, endsAt: T0, attendeeCount: 3, externalAttendeeCount: 1, observedAt: T0 });
  await w.graph.upsertDocument(principal, { provider: 'GOOGLE', fileId: 'file-1', name: 'Proposal', modifiedAt: T0, observedAt: T0 });
  const item = await w.items.detect(principal, {
    recurrenceKey: 'unanswered-inbound.v1:thread-1',
    class: 'NEEDS_YOU',
    subjectKind: 'THREAD',
    subjectRef: 'thread-1',
    title: 'Ben is waiting on you',
    producerKind: 'RULE',
    producerId: 'unanswered-inbound',
    producerVersion: 'v1',
    evidence: { threadId: 'thread-1', lastMessageId: 'msg-2' },
    detectedAt: T0,
  });
  await w.items.recordFeedback(principal, { kind: 'NOT_IMPORTANT', subjectKind: 'THREAD', subjectRef: 'thread-1' });
  await w.briefs.write(principal, {
    localDate: new Date('2026-09-17T00:00:00Z'),
    windowStart: new Date('2026-09-16T17:00:00Z'),
    windowEnd: T0,
    coverage: { GMAIL: 'COMPLETE' },
    counts: { NEEDS_YOU: 1 },
    items: [item.id],
    generatorVersion: 'brief.v1',
  });
  return item;
}

// --- Isolation ------------------------------------------------------------------------------

test('an employee sees their own work state, and nobody else sees any of it', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  const bob = await person(w, ORG_A);
  const owner = await person(w, ORG_A, 'OWNER');
  const admin = await person(w, ORG_A, 'ADMIN');
  const otherOrg = await person(w, ORG_B, 'OWNER');
  await seed(w, alice);

  const hers = await everythingVisibleTo(w, alice);
  assert.equal(hers.threads.length, 1, 'her own thread');
  assert.equal(hers.items.length, 1);
  assert.equal(hers.briefs.length, 1);
  assert.equal(hers.correspondents.length, 1);
  assert.equal(hers.messages.length, 1);

  // A colleague, an OWNER and an ADMIN of the SAME organization, and another organization's
  // owner: every read path returns nothing. Not forbidden -- not found.
  for (const [label, principal] of [['a colleague', bob], ['OWNER', owner], ['ADMIN', admin], ['another organization', otherOrg]] as const) {
    const theirs = await everythingVisibleTo(w, principal);
    for (const [path, rows] of Object.entries(theirs)) {
      assert.deepEqual(rows, [], `${label} must not see ${path}`);
    }
  }
});

test('an operator can count one person’s stored work state, and the count never includes a colleague’s', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  const bob = await person(w, ORG_A);
  const owner = await person(w, ORG_A, 'OWNER');
  const otherOrg = await person(w, ORG_B, 'OWNER');
  await seed(w, alice);

  assert.deepEqual({ ...(await w.footprint.counts(alice)) }, { threads: 1, messages: 1, correspondents: 1, items: 1, events: 1, documents: 1 });
  for (const principal of [bob, owner, otherOrg]) {
    assert.deepEqual({ ...(await w.footprint.counts(principal)) }, { threads: 0, messages: 0, correspondents: 0, items: 0, events: 0, documents: 0 });
  }
  await assert.rejects(() => w.footprint.counts({ organizationId: ORG_A, userId: '' }), /requires both organizationId and userId/);
});

test('9–11. Matt cannot see Charlie’s mail or calendar, and Charlie cannot see Matt’s -- whichever of them is OWNER', async () => {
  const w = world();
  const matt = await person(w, ORG_A, 'OWNER');
  const charlie = await person(w, ORG_A, 'ADMIN');
  const own = async (who: WorkPrincipal, label: string) => {
    await w.sources.advanceCursor(who, 'GMAIL', { cursor: `${label}-history`, cursorKind: 'GMAIL_HISTORY_ID', startedAt: T0, completedAt: T0 });
    await w.sources.advanceCursor(who, 'CALENDAR', { cursor: `${label}-sync`, cursorKind: 'CALENDAR_SYNC_TOKEN', startedAt: T0, completedAt: T0 });
    await w.graph.upsertThread(who, { provider: 'GOOGLE', threadId: `${label}-thread`, subject: `${label} private`, participantHashes: [], messageCount: 1, firstMessageAt: T0, lastMessageAt: T0, lastDirection: 'INBOUND', lastMessageId: `${label}-msg` });
    await w.graph.upsertMessage(who, { provider: 'GOOGLE', messageId: `${label}-msg`, threadId: `${label}-thread`, internalDate: T0, direction: 'INBOUND', fromHash: hash(`${label}@x.test`), subject: `${label} private`, observedAt: T0 });
    await w.graph.upsertEvent(who, { provider: 'GOOGLE', eventId: `${label}-event`, startsAt: T0, endsAt: T0, attendeeCount: 2, externalAttendeeCount: 0, observedAt: T0 });
  };
  await own(matt, 'matt');
  await own(charlie, 'charlie');
  const window = { from: new Date('2026-01-01'), to: new Date('2027-01-01') };

  for (const [me, mine, theirs] of [[matt, 'matt', 'charlie'], [charlie, 'charlie', 'matt']] as const) {
    const threads = (await w.graph.threads(me)).map((t: any) => t.threadId);
    const events = (await w.graph.events(me, window)).map((e: any) => e.eventId);
    assert.deepEqual(threads, [`${mine}-thread`], `${mine} sees only their own mail`);
    assert.deepEqual(events, [`${mine}-event`], `${mine} sees only their own calendar`);
    assert.equal((await w.sources.cursor(me, 'GMAIL'))?.cursor, `${mine}-history`);
    assert.equal((await w.sources.cursor(me, 'CALENDAR'))?.cursor, `${mine}-sync`);
    // Asking for the other person's thread by its id is not-found, not forbidden.
    assert.deepEqual(await w.graph.messages(me, `${theirs}-thread`), []);
    assert.equal(await w.graph.thread(me, 'GOOGLE', `${theirs}-thread`), null);
    assert.deepEqual({ ...(await w.footprint.counts(me)) }, { threads: 1, messages: 1, correspondents: 0, items: 0, events: 1, documents: 0 });
  }
});

test('organization authority does not reach another person’s work state, even with a Permission row', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  const owner = await person(w, ORG_A, 'OWNER');
  await seed(w, alice);

  // The owner holds the action -- on their OWN work state.
  assert.equal(await w.iam.can({ organizationId: ORG_A, userId: owner.userId, resource: 'employeeIntelligence', action: 'view' }), true);
  // An explicit ALLOW adds nothing about WHOSE rows: the scope is the data, not the action.
  await w.fake.permission.create({ data: { organizationId: ORG_A, userId: owner.userId, resource: 'employeeIntelligence', action: 'view', effect: 'ALLOW' } });
  assert.deepEqual(await w.items.items(owner), []);
  assert.deepEqual(await w.graph.threads(owner), []);

  // And the only way to ask for Alice's rows is to be Alice: the principal IS the scope.
  const asAlice = await w.items.items(alice);
  assert.equal(asAlice.length, 1);
  assert.equal(asAlice[0]!.subjectRef, 'thread-1');

  // A principal assembled from a mismatched pair (this organization, that person) sees nothing.
  assert.deepEqual(await w.items.items({ organizationId: ORG_B, userId: alice.userId }), []);
});

test('a work-state read cannot be scoped to an organization alone', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  await seed(w, alice);

  // The scope helper refuses a half-built principal loudly rather than querying on one field.
  assert.throws(() => workScope({ organizationId: ORG_A, userId: '' }), /requires both/);
  assert.throws(() => workScope({ organizationId: '', userId: alice.userId }), /requires both/);
  assert.deepEqual(workScope(alice), { organizationId: ORG_A, userId: alice.userId });
});

test('every employee-private repository method takes the principal, and a new one cannot quietly omit it', () => {
  const dir = join(__dirname, '..', 'src', 'repositories', 'work-state');
  const files = readdirSync(dir).filter((f) => f.endsWith('.repository.ts'));
  assert.ok(files.length >= 5, 'the work-state repositories are here');

  // The ONE documented exception: the retention policy is about categories, not people, and
  // carries no employee data. Anything else that names an organization without a user fails.
  const ORGANIZATION_ONLY_ALLOWED = new Set(['effectiveRetention', 'setRetentionOverride']);

  const offenders: string[] = [];
  for (const file of files) {
    const source = readFileSync(join(dir, file), 'utf8');
    // Public async methods of the exported classes: `  async name(first: Type, ...`
    for (const match of source.matchAll(/^ {2}(?:async )?([a-zA-Z][A-Za-z0-9]*)\(\s*([^),]*)/gm)) {
      const [, name, firstParam] = match;
      if (!name || name === 'constructor' || name === 'if' || name === 'for' || name === 'catch') continue;
      if (ORGANIZATION_ONLY_ALLOWED.has(name)) {
        assert.match(firstParam ?? '', /organizationId: string/, `${file}: ${name} is the documented policy exception`);
        continue;
      }
      if (!/principal: WorkPrincipal/.test(firstParam ?? '')) offenders.push(`${file}: ${name}(${firstParam})`);
    }
  }
  assert.deepEqual(offenders, [], 'every employee-private method takes a WorkPrincipal first');

  // And no method name suggests an organization-wide read of employee-private rows.
  for (const file of files) {
    const source = readFileSync(join(dir, file), 'utf8');
    for (const forbidden of ['listForOrganization', 'countByOrganization', 'allForOrganization', 'byOrganization']) {
      assert.equal(source.includes(forbidden), false, `${file}: ${forbidden}`);
    }
  }
});

// --- Authority ---------------------------------------------------------------------------------

test('employeeIntelligence grants exactly view and update, to every human role, and nothing to a machine', async () => {
  assert.deepEqual({ ...EMPLOYEE_INTELLIGENCE_GRANTS }, {
    OWNER: ['view', 'update'],
    ADMIN: ['view', 'update'],
    MANAGER: ['view', 'update'],
    EMPLOYEE: ['view', 'update'],
    READ_ONLY: ['view', 'update'],
    AI_EMPLOYEE: [],
  });

  // No role holds anything else -- there is no `manage` and no `approve` to grow into.
  for (const action of ['view', 'create', 'update', 'delete', 'manage', 'approve'] as const) {
    for (const role of ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE', 'READ_ONLY']) {
      assert.equal(
        matrixAllows(role, 'employeeIntelligence', action),
        action === 'view' || action === 'update',
        `${role} ${action}`,
      );
    }
    assert.equal(matrixAllows('AI_EMPLOYEE', 'employeeIntelligence', action), false, `AI_EMPLOYEE ${action}`);
    assert.equal(matrixAllows('SOMETHING_NEW', 'employeeIntelligence', action), false, `unknown role ${action}`);
  }

  const w = world();
  const robot = await person(w, ORG_A, 'AI_EMPLOYEE');
  await w.fake.permission.create({ data: { organizationId: ORG_A, userId: robot.userId, resource: 'employeeIntelligence', action: 'view', effect: 'ALLOW' } });
  assert.equal(await w.iam.can({ organizationId: ORG_A, userId: robot.userId, resource: 'employeeIntelligence', action: 'view' }), false, 'no Permission row gives a machine a mailbox');
  assert.deepEqual(await w.iam.canEach(ORG_A, robot.userId, [{ resource: 'employeeIntelligence', action: 'view' }]), [false]);

  const employee = await person(w, ORG_A);
  assert.deepEqual(
    await w.iam.canEach(ORG_A, employee.userId, [
      { resource: 'employeeIntelligence', action: 'view' },
      { resource: 'employeeIntelligence', action: 'update' },
      { resource: 'employeeIntelligence', action: 'manage' },
      { resource: 'employeeIntelligence', action: 'approve' },
    ]),
    [true, true, false, false],
  );

  // DL-0 stays removed: no generic authority over another member's Google connection either.
  assert.equal(matrixAllows('OWNER', 'googleWorkspace', 'manage'), false);
  assert.equal(matrixAllows('ADMIN', 'googleWorkspace', 'manage'), false);
});

// --- The store ------------------------------------------------------------------------------------

test('the same situation tomorrow is the same row, and the log is written with the projection', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  const detection = {
    recurrenceKey: 'unanswered-inbound.v1:thread-1',
    class: 'NEEDS_YOU' as const,
    subjectKind: 'THREAD' as const,
    subjectRef: 'thread-1',
    producerKind: 'RULE' as const,
    producerId: 'unanswered-inbound',
    producerVersion: 'v1',
    detectedAt: T0,
  };
  const first = await w.items.detect(alice, detection);
  assert.equal(first.state, 'OPEN');
  assert.equal(first.detectionCount, 1);

  const tomorrow = new Date(T0.getTime() + 86_400_000);
  const again = await w.items.detect(alice, { ...detection, detectedAt: tomorrow });
  assert.equal(again.id, first.id, 'one situation, one row');
  assert.equal(again.detectionCount, 2);
  assert.equal(again.lastDetectedAt.getTime(), tomorrow.getTime());
  assert.equal(again.state, 'OPEN', 're-sighting is not a state change');
  assert.equal((await w.items.items(alice)).length, 1);

  const handled = await w.items.record(alice, first.id, { state: 'RESOLVED', observationType: 'RESOLVED', occurredAt: tomorrow, outcome: 'HANDLED' });
  assert.equal(handled?.state, 'RESOLVED');
  assert.equal(handled?.outcome, 'HANDLED');
  assert.equal(handled?.resolvedAt?.getTime(), tomorrow.getTime());

  const log = await w.items.observations(alice, first.id);
  assert.deepEqual(log.map((o: any) => o.observationType), ['DETECTED', 'REDETECTED', 'RESOLVED']);
  assert.deepEqual(log.map((o: any) => o.sequence), [1, 2, 3]);
  assert.deepEqual(log.map((o: any) => o.actorType), ['SYSTEM', 'SYSTEM', 'HUMAN']);
  assert.equal(log[2]!.actorUserId, alice.userId, 'a human act names the human');
  assert.equal(log[0]!.actorUserId, null, 'a system act claims no person');
  assert.equal(log[2]!.previousState, 'OPEN');
  assert.equal(log[2]!.newState, 'RESOLVED');
});

test('a closed item carries an outcome, an open one cannot, and a snooze needs a time to wake', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  const item = await seed(w, alice);

  await assert.rejects(
    () => w.items.record(alice, item.id, { state: 'RESOLVED', observationType: 'RESOLVED', occurredAt: T0 }),
    /requires an outcome/,
  );
  await assert.rejects(
    () => w.items.record(alice, item.id, { state: 'OPEN', observationType: 'REOPENED', occurredAt: T0, outcome: 'HANDLED' }),
    /no outcome/,
  );
  await assert.rejects(
    () => w.items.record(alice, item.id, { state: 'SNOOZED', observationType: 'SNOOZED', occurredAt: T0 }),
    /time to wake/,
  );

  // Another person's item is not found rather than refused.
  const bob = await person(w, ORG_A);
  assert.equal(await w.items.record(bob, item.id, { state: 'DISMISSED', observationType: 'DISMISSED', occurredAt: T0, outcome: 'NOT_MINE' }), null);
  assert.equal((await w.items.item(alice, item.id))?.state, 'OPEN', 'and it changed nothing');
});

test('facts are idempotent on the provider key, and a deletion at the source is honoured', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  await seed(w, alice);

  // Re-ingesting the same page changes nothing but the facts themselves.
  await w.graph.upsertThread(alice, { provider: 'GOOGLE', threadId: 'thread-1', subject: 'Pricing (updated)', messageCount: 3, lastMessageAt: T0 });
  const threads = await w.graph.threads(alice);
  assert.equal(threads.length, 1);
  assert.equal(threads[0]!.subject, 'Pricing (updated)');
  assert.equal(threads[0]!.messageCount, 3);

  // A class is written by a rule, separately from the facts, and carries its version.
  await w.graph.classifyThread(alice, 'GOOGLE', 'thread-1', { derivedClass: 'NEEDS_YOU', classRuleVersion: 'unanswered-inbound.v1' });
  const classified = await w.graph.thread(alice, 'GOOGLE', 'thread-1');
  assert.equal(classified?.derivedClass, 'NEEDS_YOU');
  assert.equal(classified?.classRuleVersion, 'unanswered-inbound.v1');

  // Deleted in Gmail is a fact: the row goes.
  assert.equal(await w.graph.forgetMessage(alice, 'GOOGLE', 'msg-2'), true);
  assert.deepEqual(await w.graph.messages(alice, 'thread-1'), []);

  // A correspondent accumulates rather than duplicating, and a suppression is the person's own.
  await w.graph.recordCorrespondent(alice, { addressHash: hash('ben@cashionrods.com'), displayAddress: 'ben@cashionrods.com', seenAt: T0, direction: 'OUTBOUND' });
  const correspondents = await w.graph.correspondents(alice);
  assert.equal(correspondents.length, 1);
  assert.equal(correspondents[0]!.inboundCount, 1);
  assert.equal(correspondents[0]!.outboundCount, 1);
  assert.equal(await w.graph.suppressCorrespondent(alice, hash('ben@cashionrods.com'), true), true);
  assert.deepEqual(await w.graph.correspondents(alice), []);
  assert.equal((await w.graph.correspondents(alice, { includeSuppressed: true })).length, 1);
});

test('a brief is versioned, never overwritten, and its window must end after it starts', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  const day = new Date('2026-09-17T00:00:00Z');
  const composition = {
    localDate: day,
    windowStart: new Date('2026-09-16T17:00:00Z'),
    windowEnd: T0,
    coverage: { GMAIL: 'COMPLETE', CALENDAR: 'COMPLETE', DRIVE: 'NOT_CONNECTED' },
    counts: { NEEDS_YOU: 3 },
    items: ['item-1'],
    generatorVersion: 'brief.v1',
  };
  const first = await w.briefs.write(alice, composition);
  const second = await w.briefs.write(alice, { ...composition, counts: { NEEDS_YOU: 4 } });
  assert.equal(first.version, 1);
  assert.equal(second.version, 2);

  const newest = await w.briefs.forDate(alice, day);
  assert.equal(newest?.version, 2);
  assert.deepEqual(newest?.counts, { NEEDS_YOU: 4 });
  assert.equal((await w.briefs.recent(alice)).length, 2, 'version 1 is still there');
  // Coverage is part of the record: "nothing needed you" and "I could not look" differ.
  assert.equal((newest?.coverage as any).DRIVE, 'NOT_CONNECTED');
  // A Stage 3 seam, empty here rather than guessed.
  assert.equal(newest?.headline, null);

  await assert.rejects(() => w.briefs.write(alice, { ...composition, windowEnd: composition.windowStart }), /ends after it starts/);
});

test('preferences default rather than being invented, and a quiet window is both ends or neither', async () => {
  const w = world();
  const alice = await person(w, ORG_A);

  const defaults = await w.preferences.get(alice);
  assert.deepEqual(defaults, { timeZone: 'UTC', dayStartMinutes: 480, quietStartMinutes: null, quietEndMinutes: null, briefEnabled: true, sources: {} });

  const set = await w.preferences.set(alice, { timeZone: 'America/New_York', dayStartMinutes: 420 });
  assert.equal(set.timeZone, 'America/New_York');
  assert.equal(set.dayStartMinutes, 420);
  await assert.rejects(() => w.preferences.set(alice, { quietStartMinutes: 1200 }), /both a start and an end/);

  // One person's settings are not another's.
  const bob = await person(w, ORG_A);
  assert.equal((await w.preferences.get(bob)).timeZone, 'UTC');
});

test('retention is a window per category, with an organization’s override applied where it recorded one', async () => {
  const w = world();
  const alice = await person(w, ORG_A);

  const approved = await w.preferences.effectiveRetention(ORG_A);
  const byName = (name: string) => approved.find((c) => c.category === name)!;
  assert.equal(byName('GMAIL_METADATA').days, 30);
  assert.equal(byName('DERIVED_WORK_FACTS').days, 365);
  assert.equal(byName('GOOGLE_RAW_RESPONSES').rule, 'NEVER_STORED');
  assert.equal(approved.every((c) => c.overridden === false), true, 'no row means the approved default');

  await w.preferences.setRetentionOverride(ORG_A, 'GMAIL_METADATA', { days: 14, reason: 'tighter by policy', setByUserId: alice.userId });
  const after = await w.preferences.effectiveRetention(ORG_A);
  const overridden = after.find((c) => c.category === 'GMAIL_METADATA')!;
  assert.equal(overridden.days, 14);
  assert.equal(overridden.overridden, true);
  assert.equal(overridden.overridePolicyVersion, 'work-retention.2026-09-17.1');
  assert.equal(after.find((c) => c.category === 'BRIEFS')!.days, 365, 'one category at a time');

  // Only a day-counted category can be a duration.
  await assert.rejects(() => w.preferences.setRetentionOverride(ORG_A, 'SECURITY_AUDIT', { days: 30 }), /only a day-counted/);
  await assert.rejects(() => w.preferences.setRetentionOverride(ORG_A, 'NOPE', { days: 30 }), /unknown retention category/);

  // Another organization's policy is untouched by this one's.
  assert.equal((await w.preferences.effectiveRetention(ORG_B)).find((c) => c.category === 'GMAIL_METADATA')!.days, 30);
});

test('cursors advance and never rewind through a setter; a run records what a pass did', async () => {
  const w = world();
  const alice = await person(w, ORG_A);

  await w.sources.advanceCursor(alice, 'GMAIL', { cursor: '100', cursorKind: 'GMAIL_HISTORY_ID', startedAt: T0 });
  await w.sources.advanceCursor(alice, 'GMAIL', { cursor: '200', cursorKind: 'GMAIL_HISTORY_ID', completedAt: T0 });
  const cursor = await w.sources.cursor(alice, 'GMAIL');
  assert.equal(cursor?.cursor, '200');
  assert.equal(cursor?.cursorKind, 'GMAIL_HISTORY_ID');
  assert.equal((await w.sources.cursors(alice)).length, 1, 'one cursor per source');

  const run = await w.sources.startRun(alice, 'CALENDAR', T0);
  assert.equal(run.outcome, null, 'in flight');
  assert.equal(await w.sources.finishRun(alice, run.id, { finishedAt: T0, outcome: 'TRUNCATED', examined: 5, written: 5 }), true);
  const runs = await w.sources.recentRuns(alice);
  assert.equal(runs[0]!.outcome, 'TRUNCATED');

  // Another person cannot finish this person's run.
  const bob = await person(w, ORG_A);
  const bobsRun = await w.sources.startRun(bob, 'GMAIL', T0);
  assert.equal(await w.sources.finishRun(alice, bobsRun.id, { finishedAt: T0, outcome: 'SUCCEEDED' }), false);
});

test('a day query returns one person’s events, timed by instant and all-day by civil date', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  const bob = await person(w, ORG_A);
  const owner = await person(w, ORG_A, 'OWNER');

  const day = { fromInstant: new Date('2026-09-18T04:00:00Z'), toInstant: new Date('2026-09-20T04:00:00Z') };
  const dates = { fromDate: new Date('2026-09-18T00:00:00Z'), toDate: new Date('2026-09-19T00:00:00Z') };

  for (const [who, prefix] of [[alice, 'a'], [bob, 'b']] as const) {
    await w.graph.upsertEvent(who, { provider: 'GOOGLE', eventId: `${prefix}-timed`, startsAt: new Date('2026-09-18T13:30:00Z'), endsAt: new Date('2026-09-18T14:00:00Z'), summary: 'Standup', observedAt: T0 });
    await w.graph.upsertEvent(who, {
      provider: 'GOOGLE', eventId: `${prefix}-allday`, allDay: true,
      startDate: new Date('2026-09-18T00:00:00Z'), endDateExclusive: new Date('2026-09-19T00:00:00Z'),
      summary: 'Conference', observedAt: T0,
    });
    // Outside the window entirely.
    await w.graph.upsertEvent(who, { provider: 'GOOGLE', eventId: `${prefix}-old`, startsAt: new Date('2026-09-01T13:30:00Z'), observedAt: T0 });
  }

  const hers = await w.graph.eventsForDays(alice, { ...day, ...dates });
  assert.deepEqual(hers.map((r: any) => r.eventId).sort(), ['a-allday', 'a-timed'], 'both shapes, and only in the window');

  // An all-day row has no instant, so an instant-only query would have missed it entirely.
  assert.equal(hers.find((r: any) => r.eventId === 'a-allday')!.startsAt, null);

  // Nobody else's day is reachable through it.
  assert.deepEqual((await w.graph.eventsForDays(bob, { ...day, ...dates })).map((r: any) => r.eventId).sort(), ['b-allday', 'b-timed']);
  assert.deepEqual(await w.graph.eventsForDays(owner, { ...day, ...dates }), [], 'OWNER sees their own day, which is empty');
  assert.deepEqual(await w.graph.eventsForDays({ organizationId: ORG_B, userId: alice.userId }, { ...day, ...dates }), [], 'and not across organizations');
});

// --- The migration ----------------------------------------------------------------------------------

test('the migration only adds, is ASCII, stores no message body, and pins every vocabulary', () => {
  const sql = readFileSync(join(__dirname, '..', 'prisma', 'migrations', '20260920000000_daily_loop_work_state', 'migration.sql'), 'utf8');
  assert.equal(/[^\x00-\x7f]/.test(sql), false, 'ASCII only');

  const statements = sql.replace(/--.*$/gm, '');
  assert.equal(/\bDROP\b|\bTRUNCATE\b|\bDELETE\s+FROM\b|\bINSERT\s+INTO\b|\bUPDATE\s+"/i.test(statements), false, 'additive only');
  assert.equal(/ALTER TABLE "(?!work_|employee_work_)/.test(statements), false, 'no existing table is touched');

  const tables = [...statements.matchAll(/CREATE TABLE "(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(tables.sort(), [
    'employee_work_preferences', 'work_briefs', 'work_correspondents', 'work_documents', 'work_events',
    'work_feedback', 'work_item_observations', 'work_items', 'work_messages', 'work_retention_overrides',
    'work_source_cursors', 'work_sync_runs', 'work_threads',
  ]);

  // No body, no snippet, no attachment, no file content -- there is nowhere to put one.
  for (const forbidden of ['"body"', '"bodyText"', '"snippet"', '"attachments"', '"content"', '"fileContent"', '"rawResponse"', '"payload"']) {
    assert.equal(statements.includes(forbidden), false, `${forbidden} must not exist`);
  }

  // Every table is user-first and bound to the membership, so offboarding cascades.
  for (const table of tables) {
    if (table === 'work_retention_overrides') continue; // a policy about categories, not a person
    assert.match(statements, new RegExp(`ALTER TABLE "${table}" ADD CONSTRAINT "${table}_userId_organizationId_fkey" FOREIGN KEY \\("userId", "organizationId"\\) REFERENCES "organization_memberships"`), table);
  }

  for (const constraint of [
    'work_source_cursors_shape_check', 'work_sync_runs_shape_check', 'work_correspondents_shape_check',
    'work_threads_shape_check', 'work_messages_shape_check', 'work_events_shape_check',
    'work_documents_shape_check', 'work_items_shape_check', 'work_item_observations_shape_check',
    'work_briefs_shape_check', 'work_feedback_shape_check', 'employee_work_preferences_shape_check',
    'work_retention_overrides_shape_check',
  ]) {
    assert.match(statements, new RegExp(`ADD CONSTRAINT "${constraint}"`), constraint);
  }

  // The Stage 2 seams exist, nullable and constrained, so Stage 2 is an addition.
  assert.match(statements, /"evidenceQuote" TEXT/);
  assert.match(statements, /"headline" TEXT/);
  assert.match(statements, /length\("evidenceQuote"\) <= 240/);
  // A raw address may never be written into a hash column.
  assert.match(statements, /"addressHash" ~ '\^\[0-9a-f\]\{64\}\$'/);
});

test('DL-1 reads no Google API, calls no model, and adds no employee-visible surface', () => {
  const dir = join(__dirname, '..', 'src', 'repositories', 'work-state');
  // Comments stripped: a comment explaining that a row exists because GMAIL said a message is
  // gone is documentation. A CALL to Gmail from a repository is the thing this forbids.
  const sources = readdirSync(dir)
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
  for (const forbidden of ['googleapis.com', 'gmail', 'fetch(', 'anthropic', 'openai', 'AiRuntimeGateway', 'accessToken(']) {
    assert.equal(sources.toLowerCase().includes(forbidden.toLowerCase()), false, `${forbidden} has no place in DL-1`);
  }
});
