// The reply send state machine against a REAL Postgres (GM-2).
//
// OPT-IN AND LOCAL ONLY, exactly like work-state.postgres.test.ts: runs only when
// LOOP_TEST_POSTGRES_URL is set, and refuses any host but localhost / 127.0.0.1.
//
//   LOOP_TEST_POSTGRES_URL=postgresql://postgres:verify@127.0.0.1:55432/postgres \
//     npx tsx --test test/work-draft.postgres.test.ts
//
// WHAT IT PROVES, THAT THE IN-MEMORY DOUBLE CANNOT.
//   - The database itself refuses a send state the machine does not have: SENT without Gmail's
//     proof, an attempt in doubt that forgot what it sent, a draft still carrying an attempt, a
//     fingerprint that is not a hash -- even when the repository is bypassed entirely.
//   - The claim is ONE conditional UPDATE, so under real concurrency exactly one request wins and
//     Gmail is called exactly once, however many clicks arrive together.
//   - Every transition is conditional on the attempt: an answer for an old attempt cannot settle
//     a new one, and nothing but proof or a person moves an attempt in doubt back to DRAFT.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

import { WorkDraftRepository, WorkGraphRepository, type WorkPrincipal } from '../src/repositories/work-state';
import { MailSendService } from '../src/services/work-state/mail-send.service';
import type { GmailSendOutcome } from '@emgloop/shared';

const URL = process.env.LOOP_TEST_POSTGRES_URL ?? '';
const LOCAL = /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(URL);
const skip = !URL ? 'LOOP_TEST_POSTGRES_URL is not set' : !LOCAL ? 'refusing a non-local database' : false;

const NOW = new Date('2026-09-18T12:00:00Z');
const HASH = createHash('sha256').update('Pricing attached.').digest('hex');

async function tenant(prisma: PrismaClient, label: string, people = 2) {
  const organizationId = `org_d_${label}_${randomUUID()}`;
  await prisma.organization.create({ data: { id: organizationId, name: `D ${label}`, slug: organizationId } });
  const users: string[] = [];
  for (let i = 0; i < people; i += 1) {
    const userId = `user_d_${label}_${i}_${randomUUID()}`;
    await prisma.user.create({ data: { id: userId, organizationId, email: `${userId}@example.test`, name: 'D test', status: 'ACTIVE', metadata: { systemRole: 'EMPLOYEE' } } });
    await prisma.organizationMembership.create({ data: { organizationId, userId, systemRole: 'EMPLOYEE', status: 'ACTIVE' } });
    users.push(userId);
  }
  return { organizationId, users };
}

async function refused(promise: Promise<unknown>, what: string) {
  await assert.rejects(promise, (err: any) => {
    const text = `${err?.code ?? ''} ${err?.meta?.code ?? ''} ${err?.message ?? ''}`;
    assert.ok(/23514|check constraint|violates/i.test(text), `${what}: got ${text.slice(0, 160)}`);
    return true;
  }, what);
}

const content = {
  provider: 'GOOGLE' as const,
  threadId: 't1',
  inReplyToMessageId: 'm1',
  mode: 'REPLY' as const,
  toAddresses: ['ben@cashion.example'],
  ccAddresses: [],
  subject: 'Cashion pricing',
  body: 'Pricing attached.',
  source: 'MANUAL' as const,
};

test('the database refuses a send state the machine does not have, even without the repository', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  let organizationId = '';
  try {
    const t = await tenant(prisma, 'checks', 1);
    organizationId = t.organizationId;
    const base = { organizationId, userId: t.users[0]!, provider: 'GOOGLE', inReplyToMessageId: 'm1', mode: 'REPLY', body: 'Pricing attached.' };
    const attempt = { sendAttemptId: 'a1', sendAttemptStartedAt: NOW, sendAttemptBodyHash: HASH };
    let n = 0;
    const row = (data: Record<string, unknown>) => prisma.workDraft.create({ data: { ...base, threadId: `c${++n}`, ...data } as any });

    await refused(row({ sendState: 'QUEUED' }), 'a state the machine does not have');
    await refused(row({ sendState: 'SENT', body: '' }), 'SENT with no proof');
    await refused(row({ sendState: 'SENT', body: '', sentAt: NOW }), 'a send moment without Gmail’s id');
    await refused(row({ sendState: 'DRAFT', sentAt: NOW, sentMessageId: 'g1' }), 'proof on something not SENT');
    await refused(row({ sendState: 'SENT', sentAt: NOW, sentMessageId: 'g1' }), 'a sent reply that kept its words');
    await refused(row({ sendState: 'SENT', body: '', sentAt: NOW, sentMessageId: 'g1', sendFailureClass: 'TIMEOUT' }), 'a sent reply with a failure');
    await refused(row({ sendState: 'SEND_UNKNOWN', sendFailureClass: 'TIMEOUT' }), 'an attempt in doubt that forgot what it sent');
    await refused(row({ sendState: 'SENDING', sendAttemptId: 'a1', sendAttemptStartedAt: NOW }), 'an attempt with no fingerprint');
    await refused(row({ sendState: 'SENDING', ...attempt, sendFailureClass: 'TIMEOUT' }), 'an attempt in flight that already failed');
    await refused(row({ sendState: 'DRAFT', ...attempt }), 'a draft still carrying an attempt');
    await refused(row({ sendState: 'SENDING', ...attempt, sendAttemptBodyHash: 'Pricing attached.' }), 'words in the fingerprint column');
    await refused(row({ sendResolution: 'TIMED_OUT' }), 'a resolution nobody defined');
    await refused(row({ sendFailureClass: 'CURSOR_EXPIRED' }), 'a read failure recorded as a send failure');

    // And the legitimate shapes are accepted.
    await row({ sendState: 'DRAFT' });
    await row({ sendState: 'SENDING', ...attempt });
    await row({ sendState: 'SEND_UNKNOWN', ...attempt, sendFailureClass: 'TIMEOUT' });
    await row({ sendState: 'SENT', body: '', sentAt: NOW, sentMessageId: 'g1', sendResolution: 'RECONCILED_SENT' });
    await row({ sendState: 'DRAFT', sendFailureClass: 'NOT_DELIVERED', sendResolution: 'RECONCILED_NOT_SENT', sendReconciledAt: NOW });
  } finally {
    if (organizationId) await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.$disconnect();
  }
});

test('every transition is conditional on the state and the attempt, and only proof or a person frees one in doubt', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  let organizationId = '';
  try {
    const t = await tenant(prisma, 'machine', 2);
    organizationId = t.organizationId;
    const alice: WorkPrincipal = { organizationId, userId: t.users[0]! };
    const bob: WorkPrincipal = { organizationId, userId: t.users[1]! };
    const drafts = new WorkDraftRepository(prisma);
    const id = (await drafts.save(alice, content))!;
    const a1 = { attemptId: 'attempt-1', startedAt: NOW, bodyHash: HASH };

    // Somebody else's principal cannot claim it.
    assert.equal(await drafts.claimForSend(bob, id, a1), null);

    // Exactly one of many simultaneous claims wins -- the database decides, not the caller.
    const claims = await Promise.all(Array.from({ length: 8 }, (_, i) => drafts.claimForSend(alice, id, { ...a1, attemptId: `race-${i}` })));
    const winners = claims.filter(Boolean);
    assert.equal(winners.length, 1);
    const attemptId = winners[0]!.sendAttemptId!;

    // Frozen while in flight: no edit, no discard.
    assert.equal(await drafts.save(alice, { ...content, body: 'Something else.' }), null);
    assert.equal(await drafts.discard(alice, 'GOOGLE', 't1'), false);

    // The answer is lost.
    assert.equal(await drafts.recordUnknown(alice, id, attemptId, 'TIMEOUT'), true);
    // A failure arriving late cannot turn doubt into "sendable" -- it needs SENDING.
    assert.equal(await drafts.recordNotSent(alice, id, attemptId, 'RATE_LIMITED'), false);
    // Nor can a stale sweep, nor a release naming some other attempt.
    assert.equal(await drafts.markStaleAttemptUnknown(alice, id, new Date(NOW.getTime() + 3_600_000)), false);
    assert.equal(await drafts.releaseUnknown(alice, id, 'attempt-other', { resolution: 'RELEASED_BY_EMPLOYEE', at: NOW }), false);
    assert.equal(await drafts.releaseUnknown(bob, id, attemptId, { resolution: 'RELEASED_BY_EMPLOYEE', at: NOW }), false);
    let row = await prisma.workDraft.findUniqueOrThrow({ where: { id } });
    assert.equal(row.sendState, 'SEND_UNKNOWN');
    assert.equal(row.body, 'Pricing attached.');

    // Proof of absence frees it, with the reason on record.
    assert.equal(await drafts.releaseUnknown(alice, id, attemptId, { resolution: 'RECONCILED_NOT_SENT', at: NOW }), true);
    row = await prisma.workDraft.findUniqueOrThrow({ where: { id } });
    assert.equal(row.sendState, 'DRAFT');
    assert.equal(row.sendAttemptId, null);
    assert.equal(row.sendFailureClass, 'NOT_DELIVERED');

    // The crash path: claimed, Gmail accepted, and nobody wrote it down.
    const a2 = { attemptId: 'attempt-2', startedAt: NOW, bodyHash: HASH };
    assert.ok(await drafts.claimForSend(alice, id, a2));
    assert.equal(await drafts.markStaleAttemptUnknown(alice, id, NOW), false, 'not stale yet');
    assert.equal(await drafts.markStaleAttemptUnknown(alice, id, new Date(NOW.getTime() + 90_001)), true);
    // An answer for the OLD attempt settles nothing.
    assert.equal(await drafts.recordSent(alice, id, attemptId, { sentAt: NOW, sentMessageId: 'g-old' }), false);
    // Reconciliation found it in Sent.
    assert.equal(await drafts.recordSent(alice, id, 'attempt-2', { sentAt: NOW, sentMessageId: 'g1', resolution: 'RECONCILED_SENT' }), true);
    row = await prisma.workDraft.findUniqueOrThrow({ where: { id } });
    assert.equal(row.sendState, 'SENT');
    assert.equal(row.sentMessageId, 'g1');
    assert.equal(row.body, '');
    assert.equal(row.sendResolution, 'RECONCILED_SENT');
  } finally {
    if (organizationId) await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.$disconnect();
  }
});

test('five simultaneous Send clicks transmit once -- and an ambiguous answer is never transmitted again', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  let organizationId = '';
  try {
    const t = await tenant(prisma, 'race', 1);
    organizationId = t.organizationId;
    const alice: WorkPrincipal = { organizationId, userId: t.users[0]! };
    const drafts = new WorkDraftRepository(prisma);
    let transmissions = 0;
    let answer: GmailSendOutcome = { delivery: 'UNKNOWN', reason: 'TIMEOUT' };
    const service = new MailSendService({
      drafts,
      graph: new WorkGraphRepository(prisma),
      mail: {
        identity: async () => ({ selfAddress: 'alice@example.test' }),
        send: async () => {
          transmissions += 1;
          // Slow enough that every click is in flight together.
          await new Promise((resolve) => setTimeout(resolve, 50));
          return answer;
        },
        lookupSent: async () => ({ ok: false, failure: 'UNAVAILABLE' }),
      },
    });
    const id = (await drafts.save(alice, content))!;

    const results = await Promise.all(Array.from({ length: 5 }, () => service.sendDraft(alice, id)));
    assert.equal(transmissions, 1, 'one transmission, whoever won');
    assert.ok(results.some((r) => r.outcome === 'UNCONFIRMED'));
    assert.ok(results.every((r) => r.outcome === 'UNCONFIRMED' || r.outcome === 'IN_PROGRESS' || r.outcome === 'BUSY'));

    // In doubt, in the real database -- and it stays that way however often Send is pressed.
    answer = { delivery: 'SENT', messageId: 'g2', threadId: 't1' };
    for (let i = 0; i < 3; i += 1) assert.equal((await service.sendDraft(alice, id)).outcome, 'UNCONFIRMED');
    assert.equal(transmissions, 1);
    const row = await prisma.workDraft.findUniqueOrThrow({ where: { id } });
    assert.equal(row.sendState, 'SEND_UNKNOWN');
    assert.equal(row.sendFailureClass, 'TIMEOUT');
    assert.match(row.sendAttemptBodyHash!, /^[0-9a-f]{64}$/);
    assert.equal(row.body, 'Pricing attached.');
  } finally {
    if (organizationId) await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.$disconnect();
  }
});
