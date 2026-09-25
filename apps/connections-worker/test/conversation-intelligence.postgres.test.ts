// Chats Intelligence end to end against a REAL Postgres: the forward content sweep, with a fake adapter
// and a fake triage (no network, no model), writing through the REAL repositories and the REAL digest
// sink the worker wires (conversation-intelligence-sink.ts). OPT-IN AND LOCAL ONLY (LOOP_TEST_POSTGRES_URL).
//
// WHAT IT PROVES, THAT A FAKE PORT CANNOT
//   - OWNERSHIP: the digest is written for the authorization's own principal; the OWNER of the same
//     organization, a colleague, and a person in another organization read nothing;
//   - MINIMIZED: no body in the stored row; provenance names the invocation, the task, the schema and
//     the keyed anchors;
//   - ONE CALL: one triage per conversation produced both the WorkItem and the digest;
//   - FINGERPRINT on the real upsert: the same evidence re-read is UNCHANGED (version 1); a new message
//     overwrites at version 2;
//   - CONSENT AT THE WRITE: a revoke that commits between the triage and the write is refused inside the
//     write (CONSENT_NOT_IN_FORCE) -- nothing is written for that person, their run stops, and the sweep
//     carries on for the next authorization;
//   - and PR A's revoke path deletes a digest this producer wrote.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import {
  IntelligenceDigestRepository,
  PrismaClient,
  SourceContentAuthorizationRepository,
  WorkItemRepository,
  type DueContent,
  type TelegramConversationTriageInput,
  type TelegramConversationTriageResult,
  type WorkPrincipal,
} from '@emgloop/database';
import { conversationKeyOf } from '@emgloop/shared';

import { runContentSweep, type ContentAdapter, type ContentSweepPorts } from '../src/content-orchestrator';
import { createConversationIntelligenceRecorder } from '../src/conversation-intelligence-sink';
import type { TelegramContentMessage, TelegramConversationWindow } from '../src/telegram/telegram-content';

const URL = process.env.LOOP_TEST_POSTGRES_URL ?? '';
const LOCAL = /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(URL);
const skip = !URL ? 'LOOP_TEST_POSTGRES_URL is not set' : !LOCAL ? 'refusing a non-local database' : false;

const SECRET = 'conv-secret-pg';
const RAW_CHAT = 'rawchat-pg-1';
const CONV_KEY = conversationKeyOf('conversation', RAW_CHAT, SECRET);
const MARKER = 'BODYMARKER-pg-never-stored-31';
const NOW = new Date('2026-09-25T12:00:00Z');
const MSG_T0 = Date.UTC(2026, 8, 25, 9, 0, 0);

async function tenant(prisma: PrismaClient, label: string, people: number) {
  const organizationId = `org_ci_${label}_${randomUUID()}`;
  await prisma.organization.create({ data: { id: organizationId, name: `CI ${label}`, slug: organizationId } });
  const users: string[] = [];
  for (let i = 0; i < people; i += 1) {
    const userId = `user_ci_${label}_${i}_${randomUUID()}`;
    const role = i === 0 ? 'OWNER' : 'EMPLOYEE';
    await prisma.user.create({ data: { id: userId, organizationId, email: `${userId}@example.test`, name: 'CI', status: 'ACTIVE', metadata: { systemRole: role } } });
    await prisma.organizationMembership.create({ data: { organizationId, userId, systemRole: role, status: 'ACTIVE', effectiveFrom: new Date('2026-01-01T00:00:00Z') } });
    users.push(userId);
  }
  return { organizationId, users };
}

async function consented(prisma: PrismaClient, consent: SourceContentAuthorizationRepository, organizationId: string, userId: string) {
  await prisma.sourceConnection.create({
    data: { organizationId, userId, provider: 'TELEGRAM', state: 'READY', connectedAt: new Date('2026-09-10T00:00:00Z'), cursor: 'LIVE-1', backgroundObservation: 'OPERATIONAL' },
  });
  assert.equal((await consent.authorize(organizationId, userId, 'TELEGRAM', { now: new Date('2026-09-20T00:00:00Z'), actor: { userId } })).outcome, 'AUTHORIZED');
}

function window(ids: number[]): TelegramConversationWindow {
  const messages = ids.map((id) => ({
    providerEventId: `${CONV_KEY}:${id}`,
    direction: 'INBOUND' as const,
    occurredAt: new Date(MSG_T0 + id * 60_000),
    text: id === ids[0] ? MARKER : `body-${id}`,
  }));
  return {
    conversationKey: CONV_KEY,
    conversation: { label: 'Dana Reyes', kind: 'PRIVATE' },
    messages,
    truncation: { includedCount: messages.length, reason: 'NONE', oldestIncludedProviderEventId: messages[0]!.providerEventId },
  };
}

function newMessage(id: number): TelegramContentMessage {
  return { messageId: String(id), chatId: RAW_CHAT, senderId: 'rawsender', out: false, dateSeconds: Math.floor((MSG_T0 + id * 60_000) / 1000), text: `body-${id}` };
}

function triaged(input: TelegramConversationTriageInput, principal: WorkPrincipal): TelegramConversationTriageResult {
  const anchor = input.messages[input.messages.length - 1]!.providerEventId;
  return {
    outcome: 'TRIAGED',
    items: [{ anchorProviderEventId: anchor, category: 'REQUEST', oneLineMeaning: 'Dana wants the signed contract back', topic: 'Contract', nextStep: 'Countersign and send it', deadline: null }],
    conversation: {
      relevance: 'BUSINESS',
      summary: 'Dana is waiting on the countersigned contract.',
      topics: ['Contract'],
      developments: [{ anchorProviderEventId: anchor, statement: 'Dana asked for the signed contract' }],
      decisions: [],
      commitments: [],
      signals: [{ kind: 'OPPORTUNITY', anchorProviderEventId: anchor, statement: 'Returning it closes the job' }],
      unresolved: 'The contract is not back yet',
      attention: { needed: true, reason: 'Dana is waiting on it' },
      confidence: 'HIGH',
    },
    limitations: [],
    provenance: {
      invocationId: `inv-${principal.userId}-${input.messages.length}`,
      organizationId: principal.organizationId,
      taskId: 'telegram.content.triage',
      taskVersion: '3.0.0',
      templateId: 'telegram-content-triage',
      templateVersion: '5',
      routingPolicyVersion: 'routing.test',
      requestedModel: { providerId: 'anthropic', modelId: 'claude-opus-5' },
      servedModel: 'claude-opus-5',
      providerRequestId: 'req',
      viewerUserId: principal.userId,
      contextSourceRefs: [],
      usage: null,
      calls: 1,
      latencyMs: 1,
      outcome: 'ANSWERED',
      recordedAt: NOW.toISOString(),
    },
    evaluatedFloorProviderEventId: input.evaluatedFloorProviderEventId,
  };
}

function sweepPorts(
  prisma: PrismaClient,
  opts: {
    organizationId: string;
    ids: number[];
    triage?: (principal: WorkPrincipal, input: TelegramConversationTriageInput) => Promise<TelegramConversationTriageResult>;
  },
) {
  const consent = new SourceContentAuthorizationRepository(prisma);
  const items = new WorkItemRepository(prisma);
  const recorder = createConversationIntelligenceRecorder(new IntelligenceDigestRepository(prisma), 'content', () => undefined);
  const calls: string[] = [];
  const adapter: ContentAdapter = {
    provider: 'TELEGRAM',
    resume: async () => ({ provider: 'TELEGRAM', handle: {} }) as never,
    // The fake provider always reports the same new messages; the REAL content cursor is what moves.
    observeContent: async () => ({ messages: opts.ids.map(newMessage), nextCursor: String(Math.max(...opts.ids)) }),
    fetchConversationWindow: async () => ({ window: window(opts.ids) }),
    disconnect: async () => undefined,
  };
  const ports: ContentSweepPorts = {
    dueForContent: async () => (await consent.dueForContent(500)).filter((d: DueContent) => d.organizationId === opts.organizationId),
    adapterFor: () => adapter,
    openCredential: async () => 'session',
    conversationSecret: SECRET,
    triage: async (principal, input) => {
      calls.push(principal.userId);
      return opts.triage ? opts.triage(principal, input) : triaged(input, principal);
    },
    raiseWorkItem: async (principal, detection) => {
      await items.detect(principal, detection);
    },
    resolveObligations: async (principal, subjectRef, kept, floor, at) => {
      await items.resolveObligationsNotIn(principal, subjectRef, kept, floor, at);
    },
    recordConversationIntelligence: recorder.record,
    recordContentProgress: async (due, p) => {
      await consent.recordContentProgress(due.organizationId, due.userId, due.provider, { contentCursor: p.contentCursor, failureClass: p.failureClass, backoffUntil: p.backoffUntil, now: p.now });
    },
    contentPageSize: 50,
    contentWindowDays: 30,
    now: () => NOW,
  };
  return { ports, calls, consent };
}

test('the digest is written for the authorization principal only, minimized, from the SAME one call; nobody else reads it', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const { organizationId, users: [owner, alice, bob] } = await tenant(prisma, 'own', 3);
  const other = await tenant(prisma, 'other', 1);
  try {
    const consent = new SourceContentAuthorizationRepository(prisma);
    await consented(prisma, consent, organizationId, alice!);
    const { ports, calls } = sweepPorts(prisma, { organizationId, ids: [10, 11] });
    const summary = await runContentSweep(ports);
    assert.deepEqual(calls, [alice], 'ONE invocation, for the one authorized person');
    assert.equal(summary.raised, 1);
    assert.equal(summary.digestsWritten, 1);

    const digests = new IntelligenceDigestRepository(prisma);
    const mine = await digests.forDomain({ organizationId, userId: alice! }, 'CHATS', { now: NOW });
    assert.equal(mine.length, 1);
    const d = mine[0]!;
    assert.equal(d.subjectRef, `telegram_conversation:${CONV_KEY}`);
    assert.equal(d.subjectKind, 'CONVERSATION');
    assert.equal(d.provider, 'TELEGRAM');
    assert.equal(d.coverage, 'CONNECTED_SUFFICIENT');
    assert.equal(d.evidenceCount, 2);
    assert.equal(d.version, 1);
    assert.equal(d.content.relevance, 'BUSINESS');
    assert.equal(d.content.attention, 'Dana is waiting on it');
    assert.deepEqual(d.content.opportunities, ['Returning it closes the job']);
    assert.equal(d.provenance.taskId, 'telegram.content.triage');
    assert.equal(d.provenance.schemaId, 'telegram-content-triage.v4');
    assert.equal(d.provenance.consentBasis, 'CONTENT_AUTHORIZATION');
    assert.deepEqual(d.provenance.anchorEventIds, [`${CONV_KEY}:11`]);
    assert.equal(d.aiInvocationId, `inv-${alice}-2`);
    const row = JSON.stringify(await prisma.intelligenceDigest.findMany({ where: { organizationId } }));
    assert.ok(!row.includes(MARKER), 'no message body is stored');
    assert.ok(!row.includes(RAW_CHAT), 'no raw chat id is stored');

    // The obligation from the same call is a WorkItem on the same keyed subject.
    assert.equal(await prisma.workItem.count({ where: { organizationId, userId: alice!, subjectRef: d.subjectRef } }), 1);
    // The content cursor advanced only after both writes.
    assert.equal((await consent.get(organizationId, alice!, 'TELEGRAM'))!.contentCursor, '11');

    // Nobody else reads it: not the OWNER, not a colleague, not another organization.
    assert.deepEqual(await digests.forDomain({ organizationId, userId: owner! }, 'CHATS', { now: NOW }), []);
    assert.deepEqual(await digests.forDomain({ organizationId, userId: bob! }, 'CHATS', { now: NOW }), []);
    assert.deepEqual(await digests.forDomain({ organizationId: other.organizationId, userId: other.users[0]! }, 'CHATS', { now: NOW }), []);
    assert.equal(await digests.current({ organizationId, userId: owner! }, 'CHATS', { subjectKind: 'CONVERSATION', subjectRef: d.subjectRef, now: NOW }), null);

    // PR A's revoke path deletes what this producer wrote, in the revoke's own transaction.
    await consent.revoke(organizationId, alice!, 'TELEGRAM', { now: NOW, actor: { userId: alice! } });
    assert.equal(await prisma.intelligenceDigest.count({ where: { organizationId } }), 0);
  } finally {
    await prisma.organization.delete({ where: { id: organizationId } }).catch(() => undefined);
    await prisma.organization.delete({ where: { id: other.organizationId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});

test('FINGERPRINT on the real upsert: the same evidence re-read is UNCHANGED; a new message is version 2', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const { organizationId, users: [, alice] } = await tenant(prisma, 'fp', 2);
  try {
    const consent = new SourceContentAuthorizationRepository(prisma);
    await consented(prisma, consent, organizationId, alice!);
    const P = { organizationId, userId: alice! };
    const digests = new IntelligenceDigestRepository(prisma);

    assert.equal((await runContentSweep(sweepPorts(prisma, { organizationId, ids: [10, 11] }).ports)).digestsWritten, 1);
    const again = await runContentSweep(sweepPorts(prisma, { organizationId, ids: [10, 11] }).ports);
    assert.equal(again.digestsUnchanged, 1, 'identical evidence -> UNCHANGED');
    assert.equal((await digests.forDomain(P, 'CHATS', { now: NOW }))[0]!.version, 1);

    const moved = await runContentSweep(sweepPorts(prisma, { organizationId, ids: [10, 11, 12] }).ports);
    assert.equal(moved.digestsWritten, 1, 'a new message -> a new reading');
    const d = (await digests.forDomain(P, 'CHATS', { now: NOW }))[0]!;
    assert.equal(d.version, 2);
    assert.equal(d.evidenceCount, 3);
    assert.equal(await prisma.intelligenceDigest.count({ where: { organizationId } }), 1, 'one current row per conversation');
  } finally {
    await prisma.organization.delete({ where: { id: organizationId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});

test('CONSENT AT THE WRITE: a revoke between triage and write is refused inside the write; nothing is written; the sweep continues', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const { organizationId, users: [, alice, bob] } = await tenant(prisma, 'race', 3);
  try {
    const consent = new SourceContentAuthorizationRepository(prisma);
    await consented(prisma, consent, organizationId, alice!);
    await consented(prisma, consent, organizationId, bob!);
    const { ports } = sweepPorts(prisma, {
      organizationId,
      ids: [10, 11],
      // Alice revokes while her conversation is with the model: the answer comes back AFTER the revoke committed.
      triage: async (principal, input) => {
        if (principal.userId === alice) await consent.revoke(organizationId, alice!, 'TELEGRAM', { now: NOW, actor: { userId: alice! } });
        return triaged(input, principal);
      },
    });
    const summary = await runContentSweep(ports);
    assert.equal(summary.digestsRefused, 1, "alice's digest was refused at the write");
    assert.equal(summary.digestsWritten, 1, "bob's was written: the sweep carried on");
    assert.equal(await prisma.intelligenceDigest.count({ where: { organizationId, userId: alice! } }), 0, 'nothing written for alice');
    assert.equal(await prisma.intelligenceDigest.count({ where: { organizationId, userId: bob! } }), 1);
    assert.equal(await prisma.workItem.count({ where: { organizationId, userId: alice!, state: 'OPEN' } }), 0, 'and no open WorkItem either (detect re-checks too)');
  } finally {
    await prisma.organization.delete({ where: { id: organizationId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});
