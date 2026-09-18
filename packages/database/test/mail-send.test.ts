// Sending a reply: once, as oneself, from what was stored -- never by a machine, and never twice.
//
// WHAT THESE PROVE
//
// THE INVARIANT: a DEFINITIVE failure may be retried; an AMBIGUOUS outcome may not be retried until
// Loop can establish whether the original message was sent.
//
// Gmail's `messages.send` has no idempotency key, so these run against a stateful fake Gmail that
// can do the four things that matter: accept a message, refuse it, accept it and LOSE THE ANSWER,
// or lose the request before doing anything -- plus a Loop process that dies between Gmail
// accepting a message and Loop writing that down. Every test counts transmissions, because the
// only failure that matters here is the second one.
//
// And the boundaries the fix must not move: AI_EMPLOYEE can never hold `employeeMail:send`; the
// service takes a person and a draft id and nothing else; an employee sends only their own draft;
// the reply is threaded; the words are never lost.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
import { IamRepository, matrixAllows, EMPLOYEE_MAIL_GRANTS } from '../src/repositories/iam.repository';
import { WorkDraftRepository, WorkGraphRepository, type WorkPrincipal } from '../src/repositories/work-state';
import { MailSendService, type MailSendPort } from '../src/services/work-state/mail-send.service';
import { WORK_SEND_POLICY, type GmailSendOutcome, type GmailSentCandidate } from '@emgloop/shared';

const ORG_A = 'org_a';
const ORG_B = 'org_b';
const SELF = 'matt@elitemediagroup.io';
const NOW = new Date('2026-09-18T12:00:00Z');
const MIN = 60_000;
const WORK_DELEGATES = ['workSourceCursor', 'workSyncRun', 'workCorrespondent', 'workThread', 'workMessage', 'workEvent', 'workDocument', 'workItem', 'workItemObservation', 'workBrief', 'workFeedback', 'workDraft', 'employeeWorkPreferences', 'workRetentionOverride'];

/** What Gmail does with the next send. */
type GmailBehaviour =
  | 'ACCEPT' // accepted, and the answer arrives
  | 'ACCEPT_ANSWER_LOST' // accepted, and the answer never arrives: the message IS in Sent
  | 'LOST_BEFORE_PROCESSING' // timed out before Gmail did anything: the message is NOT in Sent
  | 'REFUSE'; // Gmail answers 429: definitively not sent

/** What the Sent lookup can do. */
type LookupBehaviour = 'NORMAL' | 'FAIL' | 'INCOMPLETE';

const decode = (b64url: string) => Buffer.from(b64url.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

/** A fake Gmail with a real Sent mailbox, and a counter of every transmission. */
function fakeGmail(clock: () => Date) {
  const sent: GmailSentCandidate[] = [];
  const transmissions: { raw: string; threadId: string | null; principal: WorkPrincipal }[] = [];
  const behaviours: GmailBehaviour[] = [];
  let lookupBehaviour: LookupBehaviour = 'NORMAL';

  const accept = (raw: string, threadId: string | null): string => {
    const mime = decode(raw);
    const head = mime.slice(0, mime.indexOf('\r\n\r\n'));
    const body = decode(mime.slice(mime.indexOf('\r\n\r\n') + 4).replace(/\r\n/g, ''));
    const header = (name: string) => new RegExp(`^${name}: (.*)$`, 'm').exec(head)?.[1] ?? null;
    const messageId = `gmail_${sent.length + 1}`;
    sent.push({
      messageId,
      threadId: threadId ?? 'new-thread',
      internalDate: new Date(clock().getTime() + 1_000),
      subject: header('Subject'),
      recipients: [header('To'), header('Cc')].filter(Boolean).flatMap((v) => v!.split(', ')),
      text: body,
    });
    return messageId;
  };

  const port: MailSendPort = {
    identity: async () => ({ selfAddress: SELF }),
    send: async (principal, message): Promise<GmailSendOutcome> => {
      transmissions.push({ raw: message.rawMessage, threadId: message.threadId, principal });
      const behaviour = behaviours.shift() ?? 'ACCEPT';
      if (behaviour === 'REFUSE') return { delivery: 'NOT_SENT', failure: 'RATE_LIMITED' };
      if (behaviour === 'LOST_BEFORE_PROCESSING') return { delivery: 'UNKNOWN', reason: 'TIMEOUT' };
      const id = accept(message.rawMessage, message.threadId);
      if (behaviour === 'ACCEPT_ANSWER_LOST') return { delivery: 'UNKNOWN', reason: 'TIMEOUT' };
      return { delivery: 'SENT', messageId: id, threadId: message.threadId ?? 'new-thread' };
    },
    lookupSent: async (_principal, query) => {
      if (lookupBehaviour === 'FAIL') return { ok: false, failure: 'UNAVAILABLE' };
      // Every Sent message is visible; the look claims completeness only once settled -- exactly
      // what the real lookup claims.
      return { ok: true, candidates: [...sent], complete: lookupBehaviour === 'NORMAL' && query.settled };
    },
  };
  return {
    port,
    sent,
    transmissions,
    next: (...b: GmailBehaviour[]) => behaviours.push(...b),
    lookups: (b: LookupBehaviour) => {
      lookupBehaviour = b;
    },
  };
}

function world() {
  const fake: any = makeCognitivePrisma({ also: ['organization', 'invitation', 'organizationMembership', ...WORK_DELEGATES] });
  const prisma = fake as PrismaClient;
  let clock = NOW;
  const drafts = new WorkDraftRepository(prisma);
  const graph = new WorkGraphRepository(prisma);
  const gmail = fakeGmail(() => clock);
  let attempts = 0;
  const service = new MailSendService({
    drafts,
    graph,
    mail: gmail.port,
    now: () => clock,
    newAttemptId: () => `attempt_${++attempts}`,
    fingerprint: (text) => createHash('sha256').update(text, 'utf8').digest('hex'),
  });
  return {
    fake,
    prisma,
    drafts,
    graph,
    gmail,
    service,
    iam: new IamRepository(prisma),
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
  };
}
type World = ReturnType<typeof world>;

let people = 0;
async function person(w: World, organizationId: string, systemRole = 'EMPLOYEE'): Promise<WorkPrincipal> {
  people += 1;
  const user = await w.iam.createUser({ organizationId, email: `send${people}@loop.test`, name: `Send ${people}`, systemRole });
  await w.iam.activateUser(organizationId, user.id);
  return { organizationId, userId: user.id };
}

async function conversation(w: World, principal: WorkPrincipal, body = 'Pricing attached.'): Promise<string> {
  await w.graph.upsertMessage(principal, {
    provider: 'GOOGLE',
    messageId: 'm1',
    threadId: 't1',
    internalDate: new Date('2026-09-18T11:00:00Z'),
    direction: 'INBOUND',
    subject: 'Cashion pricing',
    headerMessageId: '<m1@mail.gmail.com>',
    references: ['<first@mail.gmail.com>'],
    observedAt: NOW,
  });
  await w.graph.upsertThread(principal, { provider: 'GOOGLE', threadId: 't1', subject: 'Cashion pricing' });
  return (await w.drafts.save(principal, {
    provider: 'GOOGLE',
    threadId: 't1',
    inReplyToMessageId: 'm1',
    mode: 'REPLY',
    toAddresses: ['ben@cashion.example'],
    ccAddresses: [],
    subject: 'Cashion pricing',
    body,
    source: 'MANUAL',
  }))!;
}

const row = (w: World, principal: WorkPrincipal, id: string) => w.drafts.draftById(principal, id);

// --- The boundary --------------------------------------------------------------------------------

test('11. a machine principal can never hold the authority to send, whatever a Permission row says', async () => {
  const w = world();
  assert.deepEqual([...EMPLOYEE_MAIL_GRANTS.AI_EMPLOYEE!], []);
  assert.equal(matrixAllows('AI_EMPLOYEE', 'employeeMail', 'send'), false);
  for (const role of ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE', 'READ_ONLY']) {
    assert.equal(matrixAllows(role, 'employeeMail', 'send'), true, role);
  }
  const machine = await person(w, ORG_A, 'AI_EMPLOYEE');
  await w.prisma.permission.create({
    data: { organizationId: ORG_A, userId: machine.userId, resource: 'employeeMail', action: 'send', effect: 'ALLOW' },
  });
  assert.equal(await w.iam.can({ ...machine, resource: 'employeeMail', action: 'send' }), false);
  assert.equal(await w.iam.can({ ...machine, resource: 'employeeIntelligence', action: 'view' }), false);
});

test('the send service takes a person and a draft id -- never a body, a recipient or a model', () => {
  const source = require('fs')
    .readFileSync(require('path').join(__dirname, '..', 'src', 'services', 'work-state', 'mail-send.service.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
  assert.match(source, /sendDraft\(principal: WorkPrincipal, draftId: string\)/);
  for (const forbidden of ['anthropic', 'openai', 'AiRuntimeGateway', 'aiRuntime', 'prompt']) {
    assert.equal(source.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
  }
  assert.equal(/body\s*:\s*string\s*[,)]/.test(source), false, 'no body parameter');
  // AND NO CLOCK LEADS BACK TO SENDABLE: the only transitions to DRAFT are a definitive failure,
  // proof of absence, or the employee's recorded release.
  assert.equal(source.includes('claimExpired'), false);
  assert.equal(/sendState:\s*'DRAFT'/.test(source), false, 'the service never writes DRAFT directly');
});

// --- The invariant --------------------------------------------------------------------------------

test('2. Gmail accepts and Loop records it: SENT, threaded, with the words cleared', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  const id = await conversation(w, alice);

  const result = await w.service.sendDraft(alice, id);
  assert.deepEqual(result, { outcome: 'SENT', messageId: 'gmail_1' });
  assert.equal(w.gmail.transmissions.length, 1);
  assert.deepEqual(w.gmail.transmissions[0]!.principal, alice, 'sent under her own principal');

  const mime = decode(w.gmail.transmissions[0]!.raw);
  assert.match(mime, /^In-Reply-To: <m1@mail\.gmail\.com>$/m);
  assert.match(mime, /^References: <first@mail\.gmail\.com> <m1@mail\.gmail\.com>$/m);
  assert.match(mime, /^Subject: Re: Cashion pricing$/m);
  assert.match(mime, /^From: matt@elitemediagroup\.io$/m);
  assert.equal(w.gmail.transmissions[0]!.threadId, 't1');

  const after = await row(w, alice, id);
  assert.equal(after!.sendState, 'SENT');
  assert.equal(after!.sentMessageId, 'gmail_1');
  assert.equal(after!.body, '');
});

test('1. Gmail definitively refuses: the draft comes back with its words, and may be sent again', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  const id = await conversation(w, alice);
  w.gmail.next('REFUSE');

  assert.deepEqual(await w.service.sendDraft(alice, id), { outcome: 'FAILED', failureClass: 'RATE_LIMITED' });
  let after = await row(w, alice, id);
  assert.equal(after!.sendState, 'DRAFT');
  assert.equal(after!.body, 'Pricing attached.', 'nothing lost');
  assert.equal(after!.sendFailureClass, 'RATE_LIMITED');
  assert.ok(!after!.sendAttemptId, 'no attempt lingers on a draft');

  // A definitive failure is safe to retry -- and the retry is a real transmission.
  assert.equal((await w.service.sendDraft(alice, id)).outcome, 'SENT');
  assert.equal(w.gmail.transmissions.length, 2);
  after = await row(w, alice, id);
  assert.equal(after!.sendState, 'SENT');
});

test('3 and 4. an answer that never came is not retried -- however many times Send is pressed', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  const id = await conversation(w, alice);
  w.gmail.next('LOST_BEFORE_PROCESSING');

  const first = await w.service.sendDraft(alice, id);
  assert.equal(first.outcome, 'UNCONFIRMED');
  assert.equal(w.gmail.transmissions.length, 1);
  const inDoubt = await row(w, alice, id);
  assert.equal(inDoubt!.sendState, 'SEND_UNKNOWN');
  assert.equal(inDoubt!.sendFailureClass, 'TIMEOUT', 'why Loop does not know');
  assert.equal(inDoubt!.sendAttemptId, 'attempt_1', 'the attempt identity was stored before the call');
  assert.match(inDoubt!.sendAttemptBodyHash!, /^[0-9a-f]{64}$/);
  assert.equal(inDoubt!.body, 'Pricing attached.', 'the words stay, as evidence');

  // Send, Send, Send -- each one a request to check, none a transmission.
  for (let i = 0; i < 5; i += 1) {
    w.advance(20_000);
    const again = await w.service.sendDraft(alice, id);
    assert.equal(again.outcome, 'UNCONFIRMED', `click ${i + 2}`);
  }
  const concurrent = await Promise.all([w.service.sendDraft(alice, id), w.service.sendDraft(alice, id), w.service.sendDraft(alice, id)]);
  assert.ok(concurrent.every((r) => r.outcome === 'UNCONFIRMED'));
  assert.equal(w.gmail.transmissions.length, 1, 'zero additional sends');
});

test('3b. a claim contested by concurrent requests transmits exactly once', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  const id = await conversation(w, alice);
  const results = await Promise.all([w.service.sendDraft(alice, id), w.service.sendDraft(alice, id), w.service.sendDraft(alice, id)]);
  assert.equal(results.filter((r) => r.outcome === 'SENT').length, 1);
  assert.equal(w.gmail.transmissions.length, 1);
});

test('5. time passing does not make an unconfirmed attempt sendable', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  const id = await conversation(w, alice);
  w.gmail.next('LOST_BEFORE_PROCESSING');
  await w.service.sendDraft(alice, id);

  // Gmail cannot be asked, and a day goes by: far past any claim window the old design had.
  w.gmail.lookups('FAIL');
  w.advance(24 * 60 * MIN);
  const later = await w.service.sendDraft(alice, id);
  assert.equal(later.outcome, 'UNCONFIRMED');
  assert.equal((await row(w, alice, id))!.sendState, 'SEND_UNKNOWN');
  assert.equal(w.gmail.transmissions.length, 1, 'still exactly one transmission');

  // And an edit cannot turn it into a different message either.
  const saved = await w.drafts.save(alice, {
    provider: 'GOOGLE',
    threadId: 't1',
    inReplyToMessageId: 'm1',
    mode: 'REPLY',
    toAddresses: ['ben@cashion.example', 'someone-new@example.com'],
    ccAddresses: [],
    subject: 'Cashion pricing',
    body: 'A different message.',
    source: 'MANUAL',
  });
  assert.equal(saved, null, 'frozen while in doubt');
  assert.equal(await w.drafts.discard(alice, 'GOOGLE', 't1'), false, 'and not discardable either');
  assert.equal((await row(w, alice, id))!.body, 'Pricing attached.');
});

test('6. reconciliation finds the message in Sent: SENT, with Gmail’s id, and nothing sent again', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  const id = await conversation(w, alice);
  w.gmail.next('ACCEPT_ANSWER_LOST');

  const result = await w.service.sendDraft(alice, id);
  // Found by the immediate look -- the recent-first read of Sent mail -- seconds later.
  assert.deepEqual(result, { outcome: 'SENT', messageId: 'gmail_1' });
  const after = await row(w, alice, id);
  assert.equal(after!.sendState, 'SENT');
  assert.equal(after!.sentMessageId, 'gmail_1');
  assert.equal(after!.sendResolution, 'RECONCILED_SENT', 'how the doubt was settled is recorded');
  assert.equal(w.gmail.transmissions.length, 1);
});

test('7. reconciliation proves it was never sent: the draft comes back, and only then may be sent', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  const id = await conversation(w, alice);
  w.gmail.next('LOST_BEFORE_PROCESSING');
  await w.service.sendDraft(alice, id);

  // Too soon for absence to mean anything.
  w.advance(3 * MIN);
  assert.equal((await w.service.reconcile(alice, id, { force: true })).outcome, 'UNCONFIRMED');

  // Settled, and a complete look at the window finds nothing.
  w.advance(WORK_SEND_POLICY.settleMs);
  assert.deepEqual(await w.service.reconcile(alice, id, { force: true }), { outcome: 'NOT_DELIVERED' });
  const back = await row(w, alice, id);
  assert.equal(back!.sendState, 'DRAFT');
  assert.equal(back!.sendFailureClass, 'NOT_DELIVERED');
  assert.equal(back!.sendResolution, 'RECONCILED_NOT_SENT');
  assert.equal(back!.body, 'Pricing attached.');
  assert.equal(w.gmail.transmissions.length, 1, 'reconciling sent nothing');

  // Now -- and only now, on a fresh human request -- it may be sent.
  assert.equal((await w.service.sendDraft(alice, id)).outcome, 'SENT');
  assert.equal(w.gmail.transmissions.length, 2);
});

test('8. when Gmail cannot settle it, it stays in doubt', async () => {
  // A look that fails.
  const failing = world();
  const alice = await person(failing, ORG_A);
  const a = await conversation(failing, alice);
  failing.gmail.next('LOST_BEFORE_PROCESSING');
  await failing.service.sendDraft(alice, a);
  failing.gmail.lookups('FAIL');
  failing.advance(WORK_SEND_POLICY.settleMs + MIN);
  assert.deepEqual(await failing.service.reconcile(alice, a, { force: true }), { outcome: 'UNCONFIRMED', reason: 'LOOK_FAILED' });

  // A look that could not cover the whole window.
  const partial = world();
  const bob = await person(partial, ORG_A);
  const b = await conversation(partial, bob);
  partial.gmail.next('LOST_BEFORE_PROCESSING');
  await partial.service.sendDraft(bob, b);
  partial.gmail.lookups('INCOMPLETE');
  partial.advance(WORK_SEND_POLICY.settleMs + MIN);
  assert.deepEqual(await partial.service.reconcile(bob, b, { force: true }), { outcome: 'UNCONFIRMED', reason: 'INCOMPLETE_LOOK' });

  // A Sent message that could be this reply, whose words do not match.
  const lookalike = world();
  const cara = await person(lookalike, ORG_A);
  const c = await conversation(lookalike, cara);
  lookalike.gmail.next('LOST_BEFORE_PROCESSING');
  await lookalike.service.sendDraft(cara, c);
  lookalike.gmail.sent.push({
    messageId: 'typed_in_gmail',
    threadId: 't1',
    internalDate: new Date(NOW.getTime() + 30_000),
    subject: 'Re: Cashion pricing',
    recipients: ['ben@cashion.example'],
    text: 'A different reply, typed in Gmail at the same moment.',
  });
  lookalike.advance(WORK_SEND_POLICY.settleMs + MIN);
  assert.deepEqual(await lookalike.service.reconcile(cara, c, { force: true }), { outcome: 'UNCONFIRMED', reason: 'UNATTRIBUTABLE_CANDIDATE' });

  for (const [w, p, id] of [[failing, alice, a], [partial, bob, b], [lookalike, cara, c]] as const) {
    assert.equal((await row(w, p, id))!.sendState, 'SEND_UNKNOWN');
    assert.equal(w.gmail.transmissions.length, 1);
  }
});

test('9. a process that dies after Gmail accepted the message is recovered without sending again', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  const id = await conversation(w, alice);

  // Gmail accepts; then the process dies before `sentAt` is written. No failure handler runs.
  const recordSent = w.drafts.recordSent.bind(w.drafts);
  let crashes = 1;
  w.drafts.recordSent = async (...args: Parameters<typeof recordSent>) => {
    if (crashes-- > 0) throw new Error('process killed');
    return recordSent(...args);
  };
  await assert.rejects(w.service.sendDraft(alice, id));
  assert.equal(w.gmail.transmissions.length, 1);
  assert.equal(w.gmail.sent.length, 1, 'the message IS in Sent');
  assert.equal((await row(w, alice, id))!.sendState, 'SENDING', 'and Loop never wrote that down');

  // Inside the in-flight window: it may still be running, so nothing is touched.
  w.advance(30_000);
  assert.deepEqual(await w.service.sendDraft(alice, id), { outcome: 'IN_PROGRESS' });
  assert.equal(w.gmail.transmissions.length, 1);

  // Past it: the attempt is in doubt -- not free -- and Sent mail settles it.
  w.advance(WORK_SEND_POLICY.inFlightMs);
  const recovered = await w.service.sendDraft(alice, id);
  assert.deepEqual(recovered, { outcome: 'SENT', messageId: 'gmail_1' });
  const after = await row(w, alice, id);
  assert.equal(after!.sendState, 'SENT');
  assert.equal(after!.sendResolution, 'RECONCILED_SENT');
  assert.equal(w.gmail.transmissions.length, 1, 'recovered, not resent');
});

test('the employee may release an unconfirmed reply, explicitly -- and Loop checks once more first', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  const id = await conversation(w, alice);
  w.gmail.next('LOST_BEFORE_PROCESSING');
  await w.service.sendDraft(alice, id);
  w.gmail.lookups('FAIL');

  // Not while the attempt could still be running: a person cannot race their own request.
  assert.deepEqual(await w.service.releaseUnconfirmed(alice, id), { outcome: 'TOO_SOON' });
  assert.equal((await row(w, alice, id))!.sendState, 'SEND_UNKNOWN');

  w.advance(WORK_SEND_POLICY.releaseAfterMs);
  assert.deepEqual(await w.service.releaseUnconfirmed(alice, id), { outcome: 'RELEASED' });
  const back = await row(w, alice, id);
  assert.equal(back!.sendState, 'DRAFT');
  assert.equal(back!.sendResolution, 'RELEASED_BY_EMPLOYEE', 'the decision is recorded as theirs');
  assert.equal(back!.body, 'Pricing attached.');
  assert.equal(w.gmail.transmissions.length, 1, 'releasing sends nothing');
});

test('an employee who releases a reply that DID go out is protected from their own mistake', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  const id = await conversation(w, alice);
  w.gmail.next('ACCEPT_ANSWER_LOST');
  // The immediate look cannot reach Gmail, so the attempt stays in doubt although it was sent.
  w.gmail.lookups('FAIL');
  await w.service.sendDraft(alice, id);
  assert.equal((await row(w, alice, id))!.sendState, 'SEND_UNKNOWN');

  w.gmail.lookups('NORMAL');
  w.advance(WORK_SEND_POLICY.releaseAfterMs);
  assert.deepEqual(await w.service.releaseUnconfirmed(alice, id), { outcome: 'SENT', messageId: 'gmail_1' });
  assert.equal((await row(w, alice, id))!.sendState, 'SENT', 'marked sent, not released');
  assert.equal(w.gmail.transmissions.length, 1);
});

test('an edit that slips in between reading a draft and claiming it is never sent under the old words', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  const id = await conversation(w, alice);
  const claim = w.drafts.claimForSend.bind(w.drafts);
  w.drafts.claimForSend = async (...args: Parameters<typeof claim>) => {
    // The employee's other tab saves new words at exactly the wrong moment.
    await w.prisma.workDraft.updateMany({ where: { id }, data: { body: 'Newer words.' } });
    return claim(...args);
  };
  assert.deepEqual(await w.service.sendDraft(alice, id), { outcome: 'BUSY' });
  assert.equal(w.gmail.transmissions.length, 0, 'nothing left');
  const after = await row(w, alice, id);
  assert.equal(after!.sendState, 'DRAFT', 'the claim stepped back');
  assert.equal(after!.body, 'Newer words.');
});

test('a message Loop would not build is not sent at all, and nothing is claimed', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  const id = await conversation(w, alice);
  await w.drafts.save(alice, {
    provider: 'GOOGLE',
    threadId: 't1',
    inReplyToMessageId: 'm1',
    mode: 'REPLY',
    toAddresses: [],
    ccAddresses: [],
    subject: 'Cashion pricing',
    body: 'to nobody',
    source: 'MANUAL',
  });
  assert.deepEqual(await w.service.sendDraft(alice, id), { outcome: 'FAILED', failureClass: 'REFUSED' });
  assert.equal(w.gmail.transmissions.length, 0);
  assert.equal((await row(w, alice, id))!.sendState, 'DRAFT');
});

// --- Isolation -----------------------------------------------------------------------------------

test('10. a draft belongs to one principal: nobody else can send, check, release or discard it', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  const bob = await person(w, ORG_A);
  const owner = await person(w, ORG_A, 'OWNER');
  const admin = await person(w, ORG_A, 'ADMIN');
  const elsewhere = await person(w, ORG_B, 'OWNER');
  const id = await conversation(w, alice);

  for (const [label, principal] of [['a colleague', bob], ['OWNER', owner], ['ADMIN', admin], ['another organization', elsewhere]] as const) {
    assert.equal(await w.drafts.draftById(principal, id), null, label);
    assert.equal((await w.service.sendDraft(principal, id)).outcome, 'NOT_FOUND', label);
    assert.equal((await w.service.reconcile(principal, id, { force: true })).outcome, 'NOT_FOUND', label);
    assert.equal((await w.service.releaseUnconfirmed(principal, id)).outcome, 'NOT_FOUND', label);
    assert.equal(await w.drafts.discard(principal, 'GOOGLE', 't1'), false, label);
  }
  assert.equal(w.gmail.transmissions.length, 0, 'nothing was sent on anybody else’s behalf');

  // An attempt in doubt is just as private.
  w.gmail.next('LOST_BEFORE_PROCESSING');
  await w.service.sendDraft(alice, id);
  w.advance(WORK_SEND_POLICY.releaseAfterMs);
  for (const principal of [bob, owner, admin, elsewhere]) {
    assert.equal((await w.service.releaseUnconfirmed(principal, id)).outcome, 'NOT_FOUND');
  }
  assert.equal((await row(w, alice, id))!.sendState, 'SEND_UNKNOWN');
  assert.equal(w.gmail.transmissions.length, 1);
});

test('each employee’s draft on the same conversation is their own', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  const bob = await person(w, ORG_A);
  await conversation(w, alice, 'hers');
  await conversation(w, bob, 'his');
  assert.equal((await w.drafts.draft(alice, 'GOOGLE', 't1'))!.body, 'hers');
  assert.equal((await w.drafts.draft(bob, 'GOOGLE', 't1'))!.body, 'his');
});
