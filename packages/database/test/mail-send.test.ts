// Sending a reply: once, as oneself, from what was stored -- and never by a machine.
//
// WHAT THESE PROVE
//
// The rule the whole milestone rests on: GENERATION AND TRANSMISSION ARE SEPARATE ACTS. A draft
// Loop proposed is a stored draft like any other, the send takes a draft id and a human
// principal, and `employeeMail:send` is denied to AI_EMPLOYEE by the matrix AND by a hard rule
// that an explicit ALLOW row cannot override.
//
// Then the things that make a send safe to offer at all: it happens once however many times it is
// asked for, it sends what was stored rather than what a request carried, it is addressed by
// Gmail's own threading contract, and a failure leaves the employee's words exactly where they
// were.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';

import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
import { IamRepository, matrixAllows, EMPLOYEE_MAIL_GRANTS } from '../src/repositories/iam.repository';
import { WorkDraftRepository, WorkGraphRepository, type WorkPrincipal } from '../src/repositories/work-state';
import { MailSendService, type MailSendPort } from '../src/services/work-state/mail-send.service';
import type { GmailSendResult } from '@emgloop/shared';

const ORG_A = 'org_a';
const ORG_B = 'org_b';
const SELF = 'matt@elitemediagroup.io';
const NOW = new Date('2026-09-18T12:00:00Z');
const WORK_DELEGATES = ['workSourceCursor', 'workSyncRun', 'workCorrespondent', 'workThread', 'workMessage', 'workEvent', 'workDocument', 'workItem', 'workItemObservation', 'workBrief', 'workFeedback', 'workDraft', 'employeeWorkPreferences', 'workRetentionOverride'];

function world(options: { send?: (raw: string, threadId: string | null) => GmailSendResult; selfAddress?: string | null } = {}) {
  const fake: any = makeCognitivePrisma({ also: ['organization', 'invitation', 'organizationMembership', ...WORK_DELEGATES] });
  const prisma = fake as PrismaClient;
  const sends: { raw: string; threadId: string | null; principal: WorkPrincipal }[] = [];
  let clock = NOW;
  const drafts = new WorkDraftRepository(prisma);
  const graph = new WorkGraphRepository(prisma);
  const mail: MailSendPort = {
    identity: async () => ({ selfAddress: options.selfAddress === undefined ? SELF : options.selfAddress }),
    send: async (principal, message) => {
      sends.push({ raw: message.rawMessage, threadId: message.threadId, principal });
      return options.send ? options.send(message.rawMessage, message.threadId) : { ok: true, messageId: 'sent1', threadId: message.threadId ?? 't1' };
    },
  };
  return {
    fake,
    prisma,
    drafts,
    graph,
    sends,
    iam: new IamRepository(prisma),
    service: new MailSendService({ drafts, graph, mail, now: () => clock }),
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
    decode: (raw: string) => Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
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

async function conversation(w: World, principal: WorkPrincipal) {
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
  return w.drafts.save(principal, {
    provider: 'GOOGLE',
    threadId: 't1',
    inReplyToMessageId: 'm1',
    mode: 'REPLY',
    toAddresses: ['ben@cashion.example'],
    ccAddresses: [],
    subject: 'Cashion pricing',
    body: 'Pricing attached.',
    source: 'MANUAL',
  });
}

// --- The boundary --------------------------------------------------------------------------------

test('a machine principal can never hold the authority to send, whatever a Permission row says', async () => {
  const w = world();
  // The matrix denies it outright...
  assert.deepEqual([...EMPLOYEE_MAIL_GRANTS.AI_EMPLOYEE!], []);
  assert.equal(matrixAllows('AI_EMPLOYEE', 'employeeMail', 'send'), false);
  for (const role of ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE', 'READ_ONLY']) {
    assert.equal(matrixAllows(role, 'employeeMail', 'send'), true, role);
  }
  // ...and so does an explicit grant, which is the one that matters: a Permission row is how a
  // capability usually gets widened, and this one cannot be.
  const machine = await person(w, ORG_A, 'AI_EMPLOYEE');
  await w.prisma.permission.create({
    data: { organizationId: ORG_A, userId: machine.userId, resource: 'employeeMail', action: 'send', effect: 'ALLOW' },
  });
  assert.equal(await w.iam.can({ ...machine, resource: 'employeeMail', action: 'send' }), false);
  // And it holds no employee work state either, so there is nothing for it to send FROM.
  assert.equal(await w.iam.can({ ...machine, resource: 'employeeIntelligence', action: 'view' }), false);
});

test('the send service takes a person and a draft id -- never a body, a recipient or a model', () => {
  // Comments stripped: the file EXPLAINS that no model reaches it, and that explanation is the
  // point of the rule rather than a breach of it.
  const source = require('fs')
    .readFileSync(require('path').join(__dirname, '..', 'src', 'services', 'work-state', 'mail-send.service.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
  assert.match(source, /sendDraft\(principal: WorkPrincipal, draftId: string\)/);
  for (const forbidden of ['anthropic', 'openai', 'AiRuntimeGateway', 'aiRuntime', 'generate', 'prompt', 'model']) {
    assert.equal(source.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
  }
  // It cannot be handed a body: the only strings it takes are ids.
  assert.equal(/body\s*:\s*string/.test(source), false);
});

// --- Sending -------------------------------------------------------------------------------------

test('a send carries all three parts of Gmail’s threading contract, built from stored headers', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  const draftId = await conversation(w, alice);

  const result = await w.service.sendDraft(alice, draftId);
  assert.equal(result.outcome, 'SENT');
  assert.equal(w.sends.length, 1);
  assert.deepEqual(w.sends[0]!.principal, alice, 'sent under the employee’s own principal');
  assert.equal(w.sends[0]!.threadId, 't1');

  const mime = w.decode(w.sends[0]!.raw);
  assert.match(mime, /^In-Reply-To: <m1@mail\.gmail\.com>$/m);
  assert.match(mime, /^References: <first@mail\.gmail\.com> <m1@mail\.gmail\.com>$/m);
  assert.match(mime, /^Subject: Re: Cashion pricing$/m);
  assert.match(mime, /^From: matt@elitemediagroup\.io$/m);
  assert.match(mime, /^To: ben@cashion\.example$/m);

  // The draft keeps the send as a fact and keeps the words nowhere: they are in Gmail now.
  const row = await w.drafts.draftById(alice, draftId);
  assert.equal(row!.sentMessageId, 'sent1');
  assert.equal(row!.body, '');
  assert.ok(row!.sentAt);
});

test('a send happens once, however many times it is asked for', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  const draftId = await conversation(w, alice);

  const [first, second, third] = await Promise.all([
    w.service.sendDraft(alice, draftId),
    w.service.sendDraft(alice, draftId),
    w.service.sendDraft(alice, draftId),
  ]);
  const sent = [first, second, third].filter((r) => r.outcome === 'SENT');
  assert.equal(sent.length, 1, 'one message, not three');
  assert.equal(w.sends.length, 1);
  assert.equal([first, second, third].filter((r) => r.outcome === 'ALREADY_SENDING').length, 2);

  // And afterwards, asking again is still not a second message.
  const later = await w.service.sendDraft(alice, draftId);
  assert.equal(later.outcome, 'ALREADY_SENDING');
  assert.equal(w.sends.length, 1);
});

test('what is sent is what was stored, not what a later edit or a request says', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  const draftId = await conversation(w, alice);
  // The employee changes their mind before sending: the send uses the saved row.
  await w.drafts.save(alice, {
    provider: 'GOOGLE',
    threadId: 't1',
    inReplyToMessageId: 'm1',
    mode: 'REPLY',
    toAddresses: ['ben@cashion.example', 'trevon@cashion.example'],
    ccAddresses: ['lexi@elitemediagroup.io'],
    subject: 'Cashion pricing',
    body: 'Second thoughts: here is the revised number.',
    source: 'MANUAL',
  });

  await w.service.sendDraft(alice, draftId);
  const mime = w.decode(w.sends[0]!.raw);
  assert.match(mime, /^To: ben@cashion\.example, trevon@cashion\.example$/m);
  assert.match(mime, /^Cc: lexi@elitemediagroup\.io$/m);
  const body = Buffer.from(mime.slice(mime.indexOf('\r\n\r\n') + 4).replace(/\r\n/g, ''), 'base64').toString('utf8');
  assert.equal(body, 'Second thoughts: here is the revised number.');
});

test('a failure leaves the words where they were, and says what class of failure it was', async () => {
  const w = world({ send: () => ({ ok: false, failure: 'RATE_LIMITED' }) });
  const alice = await person(w, ORG_A);
  const draftId = await conversation(w, alice);

  const result = await w.service.sendDraft(alice, draftId);
  assert.equal(result.outcome, 'FAILED');
  assert.equal(result.outcome === 'FAILED' && result.failureClass, 'RATE_LIMITED');
  const row = await w.drafts.draftById(alice, draftId);
  assert.equal(row!.body, 'Pricing attached.', 'nothing was lost');
  assert.ok(!row!.sentAt, 'nothing was delivered');
  assert.equal(row!.sendFailureClass, 'RATE_LIMITED');
  assert.ok(!row!.sendClaimedAt, 'the claim is released so they can try again');

  // And they can: a second attempt is a real attempt, not a refused duplicate.
  const retry = await w.service.sendDraft(alice, draftId);
  assert.equal(retry.outcome, 'FAILED');
  assert.equal(w.sends.length, 2);
});

test('a message Loop would not build is not sent at all', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  const draftId = await conversation(w, alice);
  // No recipient: Loop refuses to build it, and nothing reaches Gmail.
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
  const result = await w.service.sendDraft(alice, draftId);
  assert.equal(result.outcome, 'FAILED');
  assert.equal(result.outcome === 'FAILED' && result.failureClass, 'REFUSED');
  assert.equal(w.sends.length, 0);
});

test('a mailbox Loop cannot identify sends nothing, rather than sending as somebody else', async () => {
  const w = world({ selfAddress: null });
  const alice = await person(w, ORG_A);
  const draftId = await conversation(w, alice);
  const result = await w.service.sendDraft(alice, draftId);
  assert.equal(result.outcome, 'FAILED');
  assert.equal(result.outcome === 'FAILED' && result.failureClass, 'NOT_CONNECTED');
  assert.equal(w.sends.length, 0);
});

// --- Isolation -----------------------------------------------------------------------------------

test('a draft belongs to one principal: nobody else can read it, send it or discard it', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  const bob = await person(w, ORG_A);
  const owner = await person(w, ORG_A, 'OWNER');
  const admin = await person(w, ORG_A, 'ADMIN');
  const elsewhere = await person(w, ORG_B, 'OWNER');
  const draftId = await conversation(w, alice);

  for (const [label, principal] of [['a colleague', bob], ['OWNER', owner], ['ADMIN', admin], ['another organization', elsewhere]] as const) {
    assert.equal(await w.drafts.draftById(principal, draftId), null, label);
    assert.equal(await w.drafts.draft(principal, 'GOOGLE', 't1'), null, label);
    assert.equal((await w.service.sendDraft(principal, draftId)).outcome, 'NOT_FOUND', label);
    assert.equal(await w.drafts.discard(principal, 'GOOGLE', 't1'), false, label);
  }
  assert.equal(w.sends.length, 0, 'nothing was sent on anybody else’s behalf');

  // Hers is untouched, and hers alone sends.
  assert.equal((await w.drafts.draftById(alice, draftId))!.body, 'Pricing attached.');
  assert.equal((await w.service.sendDraft(alice, draftId)).outcome, 'SENT');
});

test('each employee’s draft on the same conversation is their own', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  const bob = await person(w, ORG_A);
  await conversation(w, alice);
  await conversation(w, bob);

  await w.drafts.save(alice, { provider: 'GOOGLE', threadId: 't1', inReplyToMessageId: 'm1', mode: 'REPLY', toAddresses: ['ben@cashion.example'], ccAddresses: [], subject: 's', body: 'hers', source: 'MANUAL' });
  await w.drafts.save(bob, { provider: 'GOOGLE', threadId: 't1', inReplyToMessageId: 'm1', mode: 'REPLY', toAddresses: ['ben@cashion.example'], ccAddresses: [], subject: 's', body: 'his', source: 'MANUAL' });

  assert.equal((await w.drafts.draft(alice, 'GOOGLE', 't1'))!.body, 'hers');
  assert.equal((await w.drafts.draft(bob, 'GOOGLE', 't1'))!.body, 'his');
});
