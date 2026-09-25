// Chats Intelligence INITIALIZATION ("hydration") end to end against a REAL Postgres: the digest-only
// hydration sweep with a fake pager and a fake triage (no network, no model), writing through the REAL
// repositories and the REAL digest sink the worker wires. OPT-IN AND LOCAL ONLY (LOOP_TEST_POSTGRES_URL).
//
// WHAT IT PROVES
//   - an already-authorized person whose historical backfill COMPLETED before Chats Intelligence is due
//     and gets a CHATS digest with NO new message, ONE triage call per reviewed conversation;
//   - a conversation that already holds a current digest, one older than the 30-day retention and one
//     below the baseline floor are skipped with ZERO calls;
//   - RESTART: a new orchestrator instance resumes from the persisted cursor; a COMPLETE hydration is
//     never due, never re-run;
//   - a TRANSIENT failure holds the cursor and is retried next sweep; a PERMANENT rejection advances,
//     counts, and does not loop;
//   - a revoked authorization is never due; a revoke mid-page stops the writes;
//   - ownership: only that principal's digest; nobody else reads it; no body, sender or raw id stored;
//   - DIGEST-ONLY: work_items and work_item_observations are byte-identical (an OPEN and a RESOLVED item
//     for the same conversation included) although the answer carried obligations;
//   - the BUDGET RESERVE, read from the real ledger, stops hydration while forward triage stays admitted;
//   - forward triage continues normally afterwards: a later new message writes version 2.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import {
  AiUsageLedgerRepository,
  IntelligenceDigestRepository,
  PrismaClient,
  SourceContentAuthorizationRepository,
  WorkItemRepository,
  type DueChatsHydration,
  type TelegramConversationTriageInput,
  type TelegramConversationTriageResult,
  type WorkPrincipal,
} from '@emgloop/database';
import { AI_BUDGET_POLICY, AI_ROUTING_POLICY } from '@emgloop/providers';
import { aiBudgetRefusals, conversationKeyOf, telegramConversationSubjectRef } from '@emgloop/shared';

import { ledgerTriageHeadroom } from '../src/ai-runtime';
import { runChatsHydrationSweep, type ChatsHydrationSweepPorts } from '../src/chats-hydration-orchestrator';
import { runContentSweep, type ContentAdapter, type ContentSweepPorts } from '../src/content-orchestrator';
import { createConversationIntelligenceRecorder } from '../src/conversation-intelligence-sink';
import type { HistoricalContentAdapter, HistoricalConversationsResult } from '../src/historical-content-orchestrator';
import type { TelegramContentMessage, TelegramConversationWindow } from '../src/telegram/telegram-content';

const URL = process.env.LOOP_TEST_POSTGRES_URL ?? '';
const LOCAL = /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(URL);
const skip = !URL ? 'LOOP_TEST_POSTGRES_URL is not set' : !LOCAL ? 'refusing a non-local database' : false;

const SECRET = 'conv-secret-hydr';
const NOW = new Date('2026-09-25T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const FLOOR = new Date('2026-08-01T00:00:00Z');
const MARKER = 'BODYMARKER-hydration-never-stored-77';
const SENDER = 'rawsender-hydr-9';

async function tenant(prisma: PrismaClient, label: string, people: number) {
  const organizationId = `org_hy_${label}_${randomUUID()}`;
  await prisma.organization.create({ data: { id: organizationId, name: `HY ${label}`, slug: organizationId } });
  const users: string[] = [];
  for (let i = 0; i < people; i += 1) {
    const userId = `user_hy_${label}_${i}_${randomUUID()}`;
    const role = i === 0 ? 'OWNER' : 'EMPLOYEE';
    await prisma.user.create({ data: { id: userId, organizationId, email: `${userId}@example.test`, name: 'HY', status: 'ACTIVE', metadata: { systemRole: role } } });
    await prisma.organizationMembership.create({ data: { organizationId, userId, systemRole: role, status: 'ACTIVE', effectiveFrom: new Date('2026-01-01T00:00:00Z') } });
    users.push(userId);
  }
  return { organizationId, users };
}

/** Authorized, baseline COMPLETE, historical backfill armed AND COMPLETED -- the pre-#338 population. */
async function backfilledBeforeChats(prisma: PrismaClient, consent: SourceContentAuthorizationRepository, organizationId: string, userId: string) {
  await prisma.sourceConnection.create({
    data: { organizationId, userId, provider: 'TELEGRAM', state: 'READY', connectedAt: new Date('2026-09-10T00:00:00Z'), cursor: 'LIVE-1', backgroundObservation: 'OPERATIONAL' },
  });
  assert.equal((await consent.authorize(organizationId, userId, 'TELEGRAM', { now: new Date('2026-09-20T00:00:00Z'), actor: { userId } })).outcome, 'AUTHORIZED');
  assert.equal(await consent.enableHistoricalBackfill(organizationId, userId, 'TELEGRAM', { floorAt: FLOOR }), true);
  await consent.recordHistoricalProgress(organizationId, userId, 'TELEGRAM', { historicalCursor: 'HIST-END', state: 'COMPLETE', now: new Date('2026-09-21T00:00:00Z') });
}

/** A conversation window whose newest message is `newestAt`. The first message carries the body marker. */
function conv(raw: string, ids: number[], newestAt: Date): TelegramConversationWindow {
  const key = conversationKeyOf('conversation', raw, SECRET);
  const last = ids[ids.length - 1]!;
  const messages = ids.map((id) => ({
    providerEventId: `${key}:${id}`,
    direction: 'INBOUND' as const,
    occurredAt: new Date(newestAt.getTime() - (last - id) * 60_000),
    text: id === ids[0] ? `${MARKER} from ${SENDER}` : `body-${id}`,
  }));
  return {
    conversationKey: key,
    conversation: { label: 'Dana Reyes', kind: 'PRIVATE' },
    messages,
    truncation: { includedCount: messages.length, reason: 'NONE', oldestIncludedProviderEventId: messages[0]!.providerEventId },
  };
}

function triaged(input: TelegramConversationTriageInput, principal: WorkPrincipal, anchorOverride?: string): TelegramConversationTriageResult {
  const anchor = anchorOverride ?? input.messages[input.messages.length - 1]!.providerEventId;
  return {
    outcome: 'TRIAGED',
    // Obligations ARE in the answer: hydration must drop them.
    items: [{ anchorProviderEventId: anchor, category: 'REQUEST', oneLineMeaning: 'Dana wants the signed contract back', topic: 'Contract', nextStep: 'Countersign and send it', deadline: null }],
    conversation: {
      relevance: 'BUSINESS',
      summary: 'Dana is waiting on the countersigned contract.',
      topics: ['Contract'],
      developments: [{ anchorProviderEventId: anchor, statement: 'Dana asked for the signed contract' }],
      decisions: [],
      commitments: [],
      signals: [],
      unresolved: 'The contract is not back yet',
      attention: { needed: true, reason: 'Dana is waiting on it' },
      confidence: 'HIGH',
    },
    limitations: [],
    provenance: {
      invocationId: `inv-${principal.userId}-${input.conversationKey.slice(0, 8)}-${input.messages.length}`,
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

/** A pager over a fixed dialog list; the cursor is the index reached. It records every request. */
function pager(conversations: TelegramConversationWindow[], opts: { throwOnce?: boolean } = {}) {
  const requests: { cursor: string | null; floorAt: Date; maxConversations: number }[] = [];
  let thrown = false;
  const adapter: HistoricalContentAdapter = {
    provider: 'TELEGRAM',
    resume: async () => ({ provider: 'TELEGRAM', handle: {} }) as never,
    async observeHistoricalConversations(_s, request): Promise<HistoricalConversationsResult> {
      requests.push({ cursor: request.cursor, floorAt: request.floorAt, maxConversations: request.maxConversations });
      if (opts.throwOnce && !thrown) {
        thrown = true;
        throw new Error('network');
      }
      const from = request.cursor === null ? 0 : Number(request.cursor);
      const to = Math.min(conversations.length, from + request.maxConversations);
      return { conversations: conversations.slice(from, to), nextCursor: String(to), reachedEnd: to >= conversations.length };
    },
    disconnect: async () => undefined,
  };
  return { adapter, requests };
}

function hydrationPorts(
  prisma: PrismaClient,
  opts: {
    organizationId: string;
    adapter: HistoricalContentAdapter;
    triage?: (principal: WorkPrincipal, input: TelegramConversationTriageInput) => Promise<TelegramConversationTriageResult>;
    perSweep?: number;
    reserve?: number;
    headroom?: (organizationId: string, at: Date) => Promise<number>;
  },
) {
  const consent = new SourceContentAuthorizationRepository(prisma);
  const digests = new IntelligenceDigestRepository(prisma);
  const recorder = createConversationIntelligenceRecorder(digests, 'chats_hydration', () => undefined);
  const calls: string[] = [];
  const ports: ChatsHydrationSweepPorts = {
    dueForChatsHydration: async () => (await consent.dueForChatsHydration(500)).filter((d: DueChatsHydration) => d.organizationId === opts.organizationId),
    adapterFor: () => opts.adapter,
    openCredential: async () => 'session',
    triage: async (principal, input) => {
      calls.push(input.conversationKey);
      return opts.triage ? opts.triage(principal, input) : triaged(input, principal);
    },
    hasCurrentConversationDigest: async (principal, subjectRef, now) =>
      (await digests.current(principal, 'CHATS', { subjectKind: 'CONVERSATION', subjectRef, now })) !== null,
    recordConversationIntelligence: recorder.record,
    triageHeadroom: opts.headroom ?? ledgerTriageHeadroom(prisma, [opts.organizationId]),
    recordChatsHydrationProgress: async (due, p) => {
      await consent.recordChatsHydrationProgress(due.organizationId, due.userId, due.provider, p);
    },
    conversationsPerSweep: opts.perSweep ?? 5,
    budgetReserve: opts.reserve ?? 20,
    now: () => NOW,
  };
  return { ports, calls, consent, digests };
}

async function row(prisma: PrismaClient, organizationId: string, userId: string) {
  return prisma.sourceContentAuthorization.findFirstOrThrow({ where: { organizationId, userId } });
}

async function workSnapshot(prisma: PrismaClient, organizationId: string) {
  const items = await prisma.workItem.findMany({ where: { organizationId }, orderBy: { id: 'asc' } });
  const observations = await prisma.workItemObservation.findMany({ where: { organizationId }, orderBy: { id: 'asc' } });
  return JSON.stringify({ items, observations });
}

test('a person whose backfill COMPLETED before Chats Intelligence gets a digest with NO new message: one call per conversation, owner-only, minimized; hydration COMPLETES and is never re-run', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const { organizationId, users: [owner, alice, bob] } = await tenant(prisma, 'e2e', 3);
  const other = await tenant(prisma, 'other', 1);
  try {
    const consent = new SourceContentAuthorizationRepository(prisma);
    await backfilledBeforeChats(prisma, consent, organizationId, alice!);
    const a = conv('raw-a', [10, 11], new Date(NOW.getTime() - 2 * DAY));
    const b = conv('raw-b', [20, 21, 22], new Date(NOW.getTime() - 5 * DAY));
    const { adapter, requests } = pager([a, b]);
    const { ports, calls, digests } = hydrationPorts(prisma, { organizationId, adapter });

    const summary = await runChatsHydrationSweep(ports);
    assert.equal(summary.due, 1);
    assert.deepEqual(calls, [a.conversationKey, b.conversationKey], 'exactly ONE triage per reviewed conversation');
    assert.equal(summary.invoked, 2);
    assert.equal(summary.digestsWritten, 2);
    assert.equal(summary.completed, 1);
    // The pager was handed the LATER of the baseline floor and the 30-day retention horizon.
    assert.equal(requests[0]!.floorAt.toISOString(), new Date(NOW.getTime() - 30 * DAY).toISOString());

    const mine = await digests.forDomain({ organizationId, userId: alice! }, 'CHATS', { now: NOW });
    assert.equal(mine.length, 2);
    const d = mine.find((x) => x.subjectRef === telegramConversationSubjectRef(a.conversationKey))!;
    assert.equal(d.subjectKind, 'CONVERSATION');
    assert.equal(d.version, 1);
    assert.equal(d.provenance.schemaId, 'telegram-content-triage.v4');
    assert.equal(d.provenance.consentBasis, 'CONTENT_AUTHORIZATION');
    const stored = JSON.stringify(await prisma.intelligenceDigest.findMany({ where: { organizationId } }));
    for (const forbidden of [MARKER, SENDER, 'raw-a', 'raw-b', 'body-11']) assert.ok(!stored.includes(forbidden), `no ${forbidden} in any stored digest`);

    // Nobody else reads it.
    assert.deepEqual(await digests.forDomain({ organizationId, userId: owner! }, 'CHATS', { now: NOW }), []);
    assert.deepEqual(await digests.forDomain({ organizationId, userId: bob! }, 'CHATS', { now: NOW }), []);
    assert.deepEqual(await digests.forDomain({ organizationId: other.organizationId, userId: other.users[0]! }, 'CHATS', { now: NOW }), []);

    const r = await row(prisma, organizationId, alice!);
    assert.equal(r.intelligenceHydrationState, 'COMPLETE');
    assert.equal(r.intelligenceHydrationSchemaId, 'telegram-content-triage.v4');
    assert.equal(r.historicalCursor, 'HIST-END', 'the historical backfill columns are untouched');
    assert.equal(r.contentCursor, null, 'the forward cursor is untouched');

    // COMPLETE is never due again: a new instance does nothing at all.
    const again = hydrationPorts(prisma, { organizationId, adapter });
    const second = await runChatsHydrationSweep(again.ports);
    assert.equal(second.due, 0);
    assert.deepEqual(again.calls, []);
  } finally {
    await prisma.organization.delete({ where: { id: organizationId } }).catch(() => undefined);
    await prisma.organization.delete({ where: { id: other.organizationId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});

test('ZERO calls for a conversation that already has a current digest, one older than 30 days, and one below the baseline floor', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const { organizationId, users: [, alice] } = await tenant(prisma, 'skip', 2);
  try {
    const consent = new SourceContentAuthorizationRepository(prisma);
    await backfilledBeforeChats(prisma, consent, organizationId, alice!);
    // A later floor, so a conversation can be inside 30 days and still below it.
    await prisma.sourceContentAuthorization.updateMany({ where: { organizationId, userId: alice! }, data: { historicalWindowFloorAt: new Date('2026-09-15T00:00:00Z') } });
    const has = conv('raw-has', [1, 2], new Date(NOW.getTime() - 1 * DAY));
    const old = conv('raw-old', [3, 4], new Date(NOW.getTime() - 40 * DAY));
    const belowFloor = conv('raw-floor', [5, 6], new Date('2026-09-12T00:00:00Z'));
    const fresh = conv('raw-fresh', [7, 8], new Date(NOW.getTime() - 3 * HOUR));

    // `has` already holds a digest (the forward path wrote it).
    const seed = hydrationPorts(prisma, { organizationId, adapter: pager([has]).adapter });
    await runChatsHydrationSweep(seed.ports);
    await prisma.sourceContentAuthorization.updateMany({ where: { organizationId, userId: alice! }, data: { intelligenceHydrationState: 'NOT_STARTED', intelligenceHydrationCursor: null } });

    const { adapter, requests } = pager([has, old, belowFloor, fresh]);
    const { ports, calls } = hydrationPorts(prisma, { organizationId, adapter });
    const summary = await runChatsHydrationSweep(ports);
    assert.deepEqual(calls, [fresh.conversationKey], 'only the fresh conversation reached the model');
    assert.equal(summary.skippedHasDigest, 1);
    assert.equal(summary.skippedOld, 2);
    assert.equal(summary.invoked, 1);
    assert.equal(summary.completed, 1);
    assert.equal(requests[0]!.floorAt.toISOString(), '2026-09-15T00:00:00.000Z', 'the later floor is the baseline one here');
  } finally {
    await prisma.organization.delete({ where: { id: organizationId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});

test('RESTART: a new instance resumes from the persisted cursor within the per-sweep bound; a transient failure holds and retries; a permanent rejection advances, counts and does not loop', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const { organizationId, users: [, alice] } = await tenant(prisma, 'restart', 2);
  try {
    const consent = new SourceContentAuthorizationRepository(prisma);
    await backfilledBeforeChats(prisma, consent, organizationId, alice!);
    const list = [0, 1, 2, 3, 4].map((i) => conv(`raw-r${i}`, [100 + i * 10, 101 + i * 10], new Date(NOW.getTime() - (i + 1) * HOUR)));
    const rejected = list[1]!.conversationKey;
    let transientLeft = 1;
    const triage = async (principal: WorkPrincipal, input: TelegramConversationTriageInput): Promise<TelegramConversationTriageResult> => {
      if (input.conversationKey === rejected) return { outcome: 'REJECTED_OUTPUT', rejections: ['SCHEMA'] } as never;
      if (input.conversationKey === list[3]!.conversationKey && transientLeft > 0) {
        transientLeft -= 1;
        return { outcome: 'FAILED' } as never;
      }
      return triaged(input, principal);
    };

    // Sweep 1 (instance A): at most 2 calls. #0 written, #1 rejected (advance, counted).
    const one = hydrationPorts(prisma, { organizationId, adapter: pager(list).adapter, triage, perSweep: 2 });
    const s1 = await runChatsHydrationSweep(one.ports);
    assert.deepEqual(one.calls, [list[0]!.conversationKey, rejected]);
    assert.equal(s1.failedItems, 1);
    let r = await row(prisma, organizationId, alice!);
    assert.equal(r.intelligenceHydrationCursor, '2');
    assert.equal(r.intelligenceHydrationState, 'IN_PROGRESS');
    assert.equal(r.intelligenceHydrationFailedItems, 1);

    // Sweep 2 (instance B, "after a restart"): resumes at '2'. #2 written, #3 FAILED -> hold at '2'.
    const two = pager(list);
    const b = hydrationPorts(prisma, { organizationId, adapter: two.adapter, triage, perSweep: 2 });
    const s2 = await runChatsHydrationSweep(b.ports);
    assert.equal(two.requests[0]!.cursor, '2', 'resumed from the persisted cursor');
    assert.deepEqual(b.calls, [list[2]!.conversationKey, list[3]!.conversationKey]);
    assert.equal(s2.held, 1);
    r = await row(prisma, organizationId, alice!);
    assert.equal(r.intelligenceHydrationCursor, '2', 'TRANSIENT holds the frontier');
    assert.equal(r.intelligenceHydrationLastFailureClass, 'TRANSIENT');

    // Sweep 3 (instance C): #2 already has a digest (zero calls), #3 retried and written, #4 written -> COMPLETE.
    const c = hydrationPorts(prisma, { organizationId, adapter: pager(list).adapter, triage, perSweep: 2 });
    const s3 = await runChatsHydrationSweep(c.ports);
    assert.deepEqual(c.calls, [list[3]!.conversationKey, list[4]!.conversationKey], 'the rejected one is NOT retried; the digested one costs nothing');
    assert.equal(s3.skippedHasDigest, 1);
    r = await row(prisma, organizationId, alice!);
    assert.equal(r.intelligenceHydrationState, 'COMPLETE');
    assert.equal(r.intelligenceHydrationFailedItems, 1, 'the rejection was counted once');
    assert.equal(await prisma.intelligenceDigest.count({ where: { organizationId, userId: alice! } }), 4, 'every conversation but the rejected one');

    // Never re-run.
    const d = hydrationPorts(prisma, { organizationId, adapter: pager(list).adapter, triage });
    assert.equal((await runChatsHydrationSweep(d.ports)).due, 0);
    assert.deepEqual(d.calls, []);
  } finally {
    await prisma.organization.delete({ where: { id: organizationId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});

test('a thrown page read holds the frontier (TRANSIENT) and the next sweep succeeds', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const { organizationId, users: [, alice] } = await tenant(prisma, 'throw', 2);
  try {
    const consent = new SourceContentAuthorizationRepository(prisma);
    await backfilledBeforeChats(prisma, consent, organizationId, alice!);
    const list = [conv('raw-t', [1, 2], new Date(NOW.getTime() - HOUR))];
    const p = pager(list, { throwOnce: true });
    const first = hydrationPorts(prisma, { organizationId, adapter: p.adapter });
    assert.equal((await runChatsHydrationSweep(first.ports)).held, 1);
    assert.deepEqual(first.calls, []);
    assert.equal((await row(prisma, organizationId, alice!)).intelligenceHydrationLastFailureClass, 'TRANSIENT');
    const second = hydrationPorts(prisma, { organizationId, adapter: p.adapter });
    assert.equal((await runChatsHydrationSweep(second.ports)).completed, 1);
  } finally {
    await prisma.organization.delete({ where: { id: organizationId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});

test('REVOKED is never due; a revoke mid-page is refused at the write, stops the page, and leaves the hydration columns as they were', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const { organizationId, users: [, alice, bob] } = await tenant(prisma, 'revoke', 3);
  try {
    const consent = new SourceContentAuthorizationRepository(prisma);
    await backfilledBeforeChats(prisma, consent, organizationId, alice!);
    await backfilledBeforeChats(prisma, consent, organizationId, bob!);
    await consent.revoke(organizationId, bob!, 'TELEGRAM', { now: NOW, actor: { userId: bob! } });
    const list = [conv('raw-v1', [1, 2], new Date(NOW.getTime() - HOUR)), conv('raw-v2', [3, 4], new Date(NOW.getTime() - HOUR))];
    const { ports, calls } = hydrationPorts(prisma, {
      organizationId,
      adapter: pager(list).adapter,
      triage: async (principal, input) => {
        await consent.revoke(organizationId, alice!, 'TELEGRAM', { now: NOW, actor: { userId: alice! } });
        return triaged(input, principal);
      },
    });
    const summary = await runChatsHydrationSweep(ports);
    assert.equal(summary.due, 1, 'bob (revoked) is not due');
    assert.deepEqual(calls, [list[0]!.conversationKey], 'no further body is read after the write said consent ended');
    assert.equal(summary.digestsRefused, 1);
    assert.equal(await prisma.intelligenceDigest.count({ where: { organizationId } }), 0);
    const r = await row(prisma, organizationId, alice!);
    assert.equal(r.intelligenceHydrationState, 'NOT_STARTED', 'the progress write was refused by revokedAt');
    assert.equal(r.intelligenceHydrationCursor, null);
    assert.equal((await consent.dueForChatsHydration(500)).some((d) => d.organizationId === organizationId), false);
  } finally {
    await prisma.organization.delete({ where: { id: organizationId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});

test('DIGEST-ONLY: no WorkItem is created, re-sighted, reopened or reconciled -- work_items and work_item_observations are byte-identical, including a RESOLVED item for the same conversation', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const { organizationId, users: [, alice] } = await tenant(prisma, 'nowork', 2);
  try {
    const consent = new SourceContentAuthorizationRepository(prisma);
    await backfilledBeforeChats(prisma, consent, organizationId, alice!);
    const items = new WorkItemRepository(prisma);
    const P = { organizationId, userId: alice! };
    const raw = 'raw-work';
    const key = conversationKeyOf('conversation', raw, SECRET);
    const subjectRef = telegramConversationSubjectRef(key);

    // Forward triage raised an obligation at :11, reconciliation RESOLVED it, then a new one at :12 is OPEN.
    const forward = (ids: number[]) => forwardPorts(prisma, organizationId, raw, ids);
    await runContentSweep(forward([10, 11]).ports);
    await items.resolveObligationsNotIn(P, subjectRef, [], `${key}:10`, NOW);
    await runContentSweep(forward([10, 11, 12]).ports);
    assert.equal(await prisma.workItem.count({ where: { organizationId, state: 'RESOLVED' } }), 1);
    assert.equal(await prisma.workItem.count({ where: { organizationId, state: 'OPEN' } }), 1);
    // The conversation has no digest (as for the pre-#338 population).
    await prisma.intelligenceDigest.deleteMany({ where: { organizationId } });
    const before = await workSnapshot(prisma, organizationId);

    // The answer names the RESOLVED anchor (:11) only -- detect would re-sight/reopen it, and reconcile
    // would supersede the OPEN :12. Neither may happen.
    const window = conv(raw, [10, 11, 12], new Date(NOW.getTime() - HOUR));
    const { ports, calls } = hydrationPorts(prisma, { organizationId, adapter: pager([window]).adapter, triage: async (p, input) => triaged(input, p, `${key}:11`) });
    const summary = await runChatsHydrationSweep(ports);
    assert.equal(calls.length, 1);
    assert.equal(summary.digestsWritten, 1);
    assert.equal(await workSnapshot(prisma, organizationId), before, 'work_items and work_item_observations are byte-identical');
  } finally {
    await prisma.organization.delete({ where: { id: organizationId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});

test('BUDGET RESERVE (real ledger): with 30 of 50 triage invocations used, hydration makes no call and holds; forward triage is still admitted', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const { organizationId, users: [, alice] } = await tenant(prisma, 'budget', 2);
  try {
    const consent = new SourceContentAuthorizationRepository(prisma);
    await backfilledBeforeChats(prisma, consent, organizationId, alice!);
    const ledger = new AiUsageLedgerRepository(prisma);
    const route = AI_ROUTING_POLICY.tasks['telegram.content.triage']!;
    const cap = AI_BUDGET_POLICY.classes[route.budgetClass]!.taskDaily.maxInvocations;
    const reserve = 20;
    for (let i = 0; i < cap - reserve; i += 1) {
      await ledger.insertReservation(organizationId, {
        invocationId: `seed-${i}-${randomUUID()}`,
        principalUserId: alice!,
        taskId: 'telegram.content.triage',
        taskVersion: '3.0.0',
        capabilityRoute: 'test',
        providerId: 'anthropic',
        requestedModelId: 'test-model',
        routingPolicyVersion: 'routing.test',
        templateId: 't',
        templateVersion: '1',
        contextSourceRefs: [],
        estimatedInputTokens: 100,
        estimatedOutputTokens: 100,
        estimatedCostMicros: null,
        unitCostBasis: null,
        businessDate: '2026-09-25',
        requestedAt: new Date(NOW.getTime() - HOUR),
      });
    }
    const headroom = ledgerTriageHeadroom(prisma, [organizationId]);
    assert.equal(await headroom(organizationId, NOW), reserve, 'headroom = cap - used, read from the ledger');

    const { ports, calls } = hydrationPorts(prisma, { organizationId, adapter: pager([conv('raw-b1', [1, 2], new Date(NOW.getTime() - HOUR))]).adapter, reserve, headroom });
    const summary = await runChatsHydrationSweep(ports);
    assert.deepEqual(calls, [], 'no model call at the reserve');
    assert.equal(summary.heldBy.HYDRATION_BUDGET_RESERVE, 1);
    const r = await row(prisma, organizationId, alice!);
    assert.equal(r.intelligenceHydrationLastFailureClass, 'HYDRATION_BUDGET_RESERVE');
    assert.equal(r.intelligenceHydrationBackoffUntil, null, 'no backoff beyond the next sweep');
    assert.equal(r.intelligenceHydrationCursor, null, 'held');

    // Forward triage keeps its headroom: the gateway's own admission rule, on the same ledger windows, admits a call.
    const snapshot = await new (await import('@emgloop/database')).DurableAiUsageLedger(prisma).spend(organizationId, 'telegram.content.triage', NOW, [organizationId]);
    assert.deepEqual(aiBudgetRefusals(AI_BUDGET_POLICY, route.budgetClass, { inputTokens: 4000, outputTokens: 1000 }, snapshot), []);
  } finally {
    await prisma.aiInvocation.deleteMany({ where: { organizationId } }).catch(() => undefined);
    await prisma.organization.delete({ where: { id: organizationId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});

test('forward triage continues normally after hydration: a later new message updates the hydrated digest to version 2', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const { organizationId, users: [, alice] } = await tenant(prisma, 'fwd', 2);
  try {
    const consent = new SourceContentAuthorizationRepository(prisma);
    await backfilledBeforeChats(prisma, consent, organizationId, alice!);
    const raw = 'raw-fwd';
    const window = conv(raw, [10, 11], new Date(Date.UTC(2026, 8, 25, 9, 11, 0)));
    const { ports, digests } = hydrationPorts(prisma, { organizationId, adapter: pager([window]).adapter });
    await runChatsHydrationSweep(ports);
    const P = { organizationId, userId: alice! };
    assert.equal((await digests.forDomain(P, 'CHATS', { now: NOW }))[0]!.version, 1);

    await runContentSweep(forwardPorts(prisma, organizationId, raw, [10, 11, 12]).ports);
    const d = (await digests.forDomain(P, 'CHATS', { now: NOW }))[0]!;
    assert.equal(d.version, 2, 'the forward path owns updates');
    assert.equal(d.evidenceCount, 3);
    assert.equal(await prisma.intelligenceDigest.count({ where: { organizationId } }), 1);
  } finally {
    await prisma.organization.delete({ where: { id: organizationId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});

// --- The forward sweep, as the worker wires it (obligations + reconcile + digest) --------------------

const MSG_T0 = Date.UTC(2026, 8, 25, 9, 0, 0);

function forwardPorts(prisma: PrismaClient, organizationId: string, raw: string, ids: number[]) {
  const consent = new SourceContentAuthorizationRepository(prisma);
  const items = new WorkItemRepository(prisma);
  const recorder = createConversationIntelligenceRecorder(new IntelligenceDigestRepository(prisma), 'content', () => undefined);
  const key = conversationKeyOf('conversation', raw, SECRET);
  const window: TelegramConversationWindow = {
    conversationKey: key,
    conversation: { label: 'Dana Reyes', kind: 'PRIVATE' },
    messages: ids.map((id) => ({ providerEventId: `${key}:${id}`, direction: 'INBOUND' as const, occurredAt: new Date(MSG_T0 + id * 60_000), text: `body-${id}` })),
    truncation: { includedCount: ids.length, reason: 'NONE', oldestIncludedProviderEventId: `${key}:${ids[0]}` },
  };
  const newMessage = (id: number): TelegramContentMessage => ({ messageId: String(id), chatId: raw, senderId: 's', out: false, dateSeconds: Math.floor((MSG_T0 + id * 60_000) / 1000), text: `body-${id}` });
  const adapter: ContentAdapter = {
    provider: 'TELEGRAM',
    resume: async () => ({ provider: 'TELEGRAM', handle: {} }) as never,
    observeContent: async () => ({ messages: ids.map(newMessage), nextCursor: String(Math.max(...ids)) }),
    fetchConversationWindow: async () => ({ window }),
    disconnect: async () => undefined,
  };
  const ports: ContentSweepPorts = {
    dueForContent: async () => (await consent.dueForContent(500)).filter((d) => d.organizationId === organizationId),
    adapterFor: () => adapter,
    openCredential: async () => 'session',
    conversationSecret: SECRET,
    triage: async (principal, input) => triaged(input, principal),
    raiseWorkItem: async (principal, detection) => {
      await items.detect(principal, detection);
    },
    resolveObligations: async (principal, subjectRef, kept, floor, at) => {
      await items.resolveObligationsNotIn(principal, subjectRef, kept, floor, at);
    },
    recordConversationIntelligence: recorder.record,
    recordContentProgress: async (due, p) => {
      await consent.recordContentProgress(due.organizationId, due.userId, due.provider, { contentCursor: null, failureClass: p.failureClass, backoffUntil: p.backoffUntil, now: p.now });
    },
    contentPageSize: 50,
    contentWindowDays: 30,
    now: () => NOW,
  };
  return { ports };
}
