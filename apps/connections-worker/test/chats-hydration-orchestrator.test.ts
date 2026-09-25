// The Chats Intelligence HYDRATION sweep (digest-only initialization), with fake ports. No network, no
// database, no model. (The end-to-end proof against real repositories is chats-hydration.postgres.test.ts.)
//
// WHAT IT PROVES
//   DIGEST-ONLY IS STRUCTURAL: the ports have no obligation writer; spies bolted onto the object are never
//   called, although the answer carries obligations.
//   BOUNDS: at most `conversationsPerSweep` calls per authorization per sweep, each page asks for at most
//   the calls still allowed, and at most HYDRATION_MAX_PAGES_PER_SWEEP pages.
//   CURSOR TABLE: FLOOD_WAIT holds + backs off; a governed refusal holds with its specific class; AUTH
//   holds; NOT_MIGRATED holds; no adapter / no credential skips without a write.
//   BUDGET: the headroom is read before every call; at or below the reserve the pass stops; the cap is
//   read from the reviewed budget policy through the task's route, never a literal.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { DueChatsHydration, TelegramConversationTriageInput, TelegramConversationTriageResult, WorkPrincipal } from '@emgloop/database';
import { AI_BUDGET_POLICY, AI_ROUTING_POLICY } from '@emgloop/providers';
import { AI_NO_SPEND, conversationKeyOf } from '@emgloop/shared';

import { triageInvocationHeadroom } from '../src/ai-runtime';
import {
  HYDRATION_MAX_PAGES_PER_SWEEP,
  runChatsHydrationSweep,
  type ChatsHydrationProgressToRecord,
  type ChatsHydrationSweepPorts,
} from '../src/chats-hydration-orchestrator';
import type { HistoricalContentAdapter, HistoricalConversationsResult } from '../src/historical-content-orchestrator';
import type { ConversationIntelligenceWrite } from '../src/content-orchestrator';
import type { TelegramConversationWindow } from '../src/telegram/telegram-content';

const NOW = new Date('2026-09-25T12:00:00Z');
const DUE: DueChatsHydration = { organizationId: 'o1', userId: 'u1', provider: 'TELEGRAM', hydrationCursor: null, historicalWindowFloorAt: new Date('2026-08-01T00:00:00Z') };

function conv(i: number): TelegramConversationWindow {
  const key = conversationKeyOf('conversation', `raw-${i}`, 'secret');
  return {
    conversationKey: key,
    conversation: { label: null, kind: null },
    messages: [{ providerEventId: `${key}:1`, direction: 'INBOUND', occurredAt: new Date(NOW.getTime() - 3_600_000), text: 'hello' }],
    truncation: { includedCount: 1, reason: 'NONE', oldestIncludedProviderEventId: `${key}:1` },
  };
}

function triaged(input: TelegramConversationTriageInput): TelegramConversationTriageResult {
  const anchor = input.messages[0]!.providerEventId;
  return {
    outcome: 'TRIAGED',
    items: [{ anchorProviderEventId: anchor, category: 'REQUEST', oneLineMeaning: 'x', topic: 't', nextStep: 'n', deadline: null }],
    conversation: {
      relevance: 'BUSINESS', summary: 's', topics: [], developments: [], decisions: [], commitments: [], signals: [],
      unresolved: null, attention: { needed: false, reason: null }, confidence: 'MEDIUM',
    },
    limitations: [],
    provenance: { invocationId: `inv-${input.conversationKey.slice(0, 6)}`, taskId: 'telegram.content.triage', taskVersion: '3.0.0' },
    evaluatedFloorProviderEventId: input.evaluatedFloorProviderEventId,
  } as never;
}

function harness(opts: {
  total?: number;
  perSweep?: number;
  headroom?: number;
  triage?: (input: TelegramConversationTriageInput) => TelegramConversationTriageResult;
  page?: (cursor: string | null, max: number) => HistoricalConversationsResult;
  write?: ConversationIntelligenceWrite;
  resumeThrows?: boolean;
  adapter?: boolean;
  credential?: boolean;
}) {
  const all = Array.from({ length: opts.total ?? 3 }, (_, i) => conv(i));
  const requests: { cursor: string | null; max: number }[] = [];
  const progress: ChatsHydrationProgressToRecord[] = [];
  const calls: string[] = [];
  const obligationSpy = { raised: 0, resolved: 0 };
  const adapter: HistoricalContentAdapter = {
    provider: 'TELEGRAM',
    resume: async () => {
      if (opts.resumeThrows) throw new Error('auth');
      return { provider: 'TELEGRAM', handle: {} } as never;
    },
    async observeHistoricalConversations(_s, req) {
      requests.push({ cursor: req.cursor, max: req.maxConversations });
      if (opts.page) return opts.page(req.cursor, req.maxConversations);
      const from = req.cursor === null ? 0 : Number(req.cursor);
      const to = Math.min(all.length, from + req.maxConversations);
      return { conversations: all.slice(from, to), nextCursor: String(to), reachedEnd: to >= all.length };
    },
    disconnect: async () => undefined,
  };
  const ports: ChatsHydrationSweepPorts & Record<string, unknown> = {
    dueForChatsHydration: async () => [DUE],
    adapterFor: () => (opts.adapter === false ? null : adapter),
    openCredential: async () => (opts.credential === false ? null : 'session'),
    triage: async (_p: WorkPrincipal, input) => {
      calls.push(input.conversationKey);
      return (opts.triage ?? triaged)(input);
    },
    hasCurrentConversationDigest: async () => false,
    recordConversationIntelligence: async () => opts.write ?? { outcome: 'WRITTEN' },
    triageHeadroom: async () => opts.headroom ?? 50,
    recordChatsHydrationProgress: async (_d, p) => {
      progress.push(p);
    },
    conversationsPerSweep: opts.perSweep ?? 5,
    budgetReserve: 20,
    now: () => NOW,
    // Bolted on: an obligation writer the hydration must never reach, however it is offered.
    raiseWorkItem: async () => {
      obligationSpy.raised += 1;
    },
    resolveObligations: async () => {
      obligationSpy.resolved += 1;
    },
  };
  return { ports, requests, progress, calls, obligationSpy };
}

test('DIGEST-ONLY (structural): obligations in the answer are never raised and nothing is reconciled, even with writers offered', async () => {
  const h = harness({ total: 3 });
  const s = await runChatsHydrationSweep(h.ports);
  assert.equal(s.invoked, 3);
  assert.equal(s.digestsWritten, 3);
  assert.deepEqual(h.obligationSpy, { raised: 0, resolved: 0 });
  assert.equal(h.progress.at(-1)!.state, 'COMPLETE');
  assert.equal(h.progress.at(-1)!.schemaId, 'telegram-content-triage.v4');
});

test('BOUND: never more calls than conversationsPerSweep; every page asks for at most the calls still allowed', async () => {
  const h = harness({ total: 12, perSweep: 5 });
  const s = await runChatsHydrationSweep(h.ports);
  assert.equal(s.invoked, 5);
  assert.deepEqual(h.requests.map((r) => r.max), [5]);
  assert.equal(h.progress.at(-1)!.cursor, '5');
  assert.equal(h.progress.at(-1)!.state, 'IN_PROGRESS');
});

test('BOUND: pages of already-digested conversations cost no call, and the pass stops after HYDRATION_MAX_PAGES_PER_SWEEP pages', async () => {
  const h = harness({ total: 200, perSweep: 5 });
  h.ports.hasCurrentConversationDigest = async () => true;
  const s = await runChatsHydrationSweep(h.ports);
  assert.equal(s.invoked, 0);
  assert.equal(s.pages, HYDRATION_MAX_PAGES_PER_SWEEP);
  assert.equal(s.skippedHasDigest, HYDRATION_MAX_PAGES_PER_SWEEP * 5);
  assert.equal(h.progress.at(-1)!.cursor, String(HYDRATION_MAX_PAGES_PER_SWEEP * 5), 'the frontier advanced past what was read');
});

test('FLOOD_WAIT holds the frontier and backs off', async () => {
  const h = harness({ page: (cursor) => ({ conversations: [], nextCursor: cursor, reachedEnd: false, floodWaitSeconds: 30 }) });
  const s = await runChatsHydrationSweep(h.ports);
  assert.equal(s.floodWaits, 1);
  const p = h.progress.at(-1)!;
  assert.equal(p.cursor, null);
  assert.equal(p.failureClass, 'FLOOD_WAIT');
  assert.equal(p.backoffUntil!.toISOString(), new Date(NOW.getTime() + 30_000).toISOString());
});

test('a governed refusal holds with its SPECIFIC class; AUTH holds; NOT_MIGRATED holds after one call', async () => {
  const refused = harness({ triage: () => ({ outcome: 'NOT_AVAILABLE', refusals: ['BUDGET_TASK_EXHAUSTED'] }) as never });
  await runChatsHydrationSweep(refused.ports);
  assert.equal(refused.progress.at(-1)!.failureClass, 'REFUSED_BY_LOOP:BUDGET_TASK_EXHAUSTED');
  assert.equal(refused.progress.at(-1)!.cursor, null);
  assert.equal(refused.calls.length, 1, 'the page stops at the refusal');

  const auth = harness({ resumeThrows: true });
  await runChatsHydrationSweep(auth.ports);
  assert.equal(auth.progress.at(-1)!.failureClass, 'AUTH');
  assert.equal(auth.calls.length, 0);

  const notMigrated = harness({ write: { outcome: 'NOT_MIGRATED' } });
  const s = await runChatsHydrationSweep(notMigrated.ports);
  assert.equal(notMigrated.calls.length, 1);
  assert.equal(notMigrated.progress.at(-1)!.failureClass, 'NOT_MIGRATED');
  assert.deepEqual(s.heldBy, { NOT_MIGRATED: 1 });
});

test('no adapter or no credential: skipped, nothing read, nothing recorded', async () => {
  for (const h of [harness({ adapter: false }), harness({ credential: false })]) {
    const s = await runChatsHydrationSweep(h.ports);
    assert.equal(s.skipped, 1);
    assert.deepEqual(h.requests, []);
    assert.deepEqual(h.progress, []);
  }
});

test('BUDGET: at or below the reserve, no call is made and the pass holds with HYDRATION_BUDGET_RESERVE (no backoff)', async () => {
  const at = harness({ headroom: 20 });
  await runChatsHydrationSweep(at.ports);
  assert.deepEqual(at.calls, []);
  assert.equal(at.progress.at(-1)!.failureClass, 'HYDRATION_BUDGET_RESERVE');
  assert.equal(at.progress.at(-1)!.backoffUntil, null);
  const above = harness({ headroom: 21, total: 1 });
  await runChatsHydrationSweep(above.ports);
  assert.equal(above.calls.length, 1);
});

test('the headroom is the tightest of the task, organization and global windows, with the task cap read from the reviewed policy', () => {
  const route = AI_ROUTING_POLICY.tasks['telegram.content.triage']!;
  const cap = AI_BUDGET_POLICY.classes[route.budgetClass]!.taskDaily.maxInvocations;
  const spend = (task: number, org: number, global: number) => ({
    task: { ...AI_NO_SPEND, invocations: task },
    organization: { ...AI_NO_SPEND, invocations: org },
    global: { ...AI_NO_SPEND, invocations: global },
  });
  assert.equal(triageInvocationHeadroom(spend(0, 0, 0)), Math.min(cap, AI_BUDGET_POLICY.organizationDaily.maxInvocations, AI_BUDGET_POLICY.globalDaily.maxInvocations));
  assert.equal(triageInvocationHeadroom(spend(30, 30, 30)), cap - 30);
  assert.equal(triageInvocationHeadroom(spend(0, AI_BUDGET_POLICY.organizationDaily.maxInvocations - 3, 0)), 3, 'other tasks spending the organization window count');
  assert.equal(triageInvocationHeadroom(spend(cap + 5, 0, 0)), 0, 'never negative');
  assert.equal(triageInvocationHeadroom(spend(0, 0, 0), { ...AI_BUDGET_POLICY, classes: {} }), 0, 'no class -> fail closed');
});
