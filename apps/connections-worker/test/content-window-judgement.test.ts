// One exact window, one judgement (2026-09-30). The FORWARD content sweep with fakes for every port, over the
// REAL window policy (decideTriageWindow) and the REAL content-free manifest hash (telegramTriageWindowManifestHash).
// The fake ledger records what the gateway's ledger records -- the principal, the manifest hash, the outcome, the
// time -- and nothing else; the fake reading store records the window fingerprint. No body is kept anywhere.
//
// PROVES: a failed conversation does not block the ones after it; an answered or rejected exact window is never
// re-sent; a failed window backs off, is retried after the backoff, and at most TELEGRAM_TRIAGE_WINDOW_POLICY.
// maxFailedAttempts times, after which the cursor moves; a new message is a new window; a budget refusal costs
// no repeated call; two people's identical windows are judged separately; the judge sees identifiers only.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { conversationKeyOf } from '@emgloop/shared';
import { decideTriageWindow, telegramTriageWindowManifestHash, TELEGRAM_TRIAGE_WINDOW_POLICY } from '@emgloop/database';
import type { DueContent, TelegramConversationTriageInput, TelegramConversationTriageResult, TelegramTriageWindowVerdict, WorkPrincipal } from '@emgloop/database';

import { runContentSweep, type ContentAdapter, type ContentSweepPorts } from '../src/content-orchestrator';
import type { TelegramContentMessage, TelegramConversationWindow } from '../src/telegram/telegram-content';

const SECRET = 'conv-secret';
const ORG = 'o1';
const HOUR = 36e5;
const T0 = new Date('2026-09-30T10:00:00Z');
const keyOf = (chat: string) => conversationKeyOf('conversation', chat, SECRET);

type Outcome = 'ANSWERED' | 'REJECTED_BY_LOOP' | 'FAILED' | 'REFUSED_BY_MODEL';

/** A world: chats with message ids, a fake ledger and reading store keyed like the real ones, and a clock. */
function world(opts: { users?: string[] } = {}) {
  const users = opts.users ?? ['u1'];
  const chats = new Map<string, string[]>(); // raw chat id -> message ids (the conversation, oldest first)
  let nextId = 100;
  const ledger: { user: string; hash: string; outcome: Outcome; at: Date }[] = [];
  const readings = new Map<string, string>(); // `${user}|${subjectRef}` -> window fingerprint
  const judged: unknown[] = [];
  const cursors = new Map<string, string | null>(users.map((u) => [u, null]));
  const clock = { now: T0 };
  const outcomeFor = new Map<string, Outcome | 'NOT_AVAILABLE' | ((attempt: number) => Outcome)>();
  const calls: { user: string; chat: string }[] = [];
  const hashes = new Map<string, string>();

  const say = (chat: string, text = 'secret body text') => {
    const id = String((nextId += 1));
    chats.set(chat, [...(chats.get(chat) ?? []), id]);
    return { id, text };
  };
  const windowOf = (chat: string): TelegramConversationWindow => {
    const key = keyOf(chat);
    const messages = (chats.get(chat) ?? []).map((id) => ({ providerEventId: `${key}:${id}`, direction: 'INBOUND' as const, occurredAt: new Date(T0.getTime() + Number(id) * 1000), text: `secret body ${chat} ${id}` }));
    return { conversationKey: key, conversation: { label: null, kind: null }, messages, truncation: { includedCount: messages.length, reason: 'NONE', oldestIncludedProviderEventId: messages[0]?.providerEventId ?? null } };
  };
  const chatOfKey = (key: string) => [...chats.keys()].find((c) => keyOf(c) === key)!;

  const portsFor = (): ContentSweepPorts => {
    const adapter: ContentAdapter = {
      provider: 'TELEGRAM',
      resume: async () => ({ provider: 'TELEGRAM', handle: {} }) as never,
      async observeContent(_s, cursor) {
        const messages: TelegramContentMessage[] = [];
        for (const [chat, ids] of chats) for (const id of ids) if (Number(id) > Number(cursor ?? 0)) messages.push({ messageId: id, chatId: chat, senderId: 's', out: false, dateSeconds: 1, text: 'secret body text' });
        const next = messages.reduce((m, x) => Math.max(m, Number(x.messageId)), Number(cursor ?? 0));
        return { messages, nextCursor: next > 0 ? String(next) : cursor };
      },
      fetchConversationWindow: async (_s, request) => ({ window: windowOf(request.chatId) }),
      disconnect: async () => undefined,
    };
    return {
      dueForContent: async () => users.map((userId) => ({ organizationId: ORG, userId, provider: 'TELEGRAM', contentCursor: cursors.get(userId) ?? null }) as DueContent),
      adapterFor: () => adapter,
      openCredential: async () => 'session',
      conversationSecret: SECRET,
      async triage(principal: WorkPrincipal, input: TelegramConversationTriageInput): Promise<TelegramConversationTriageResult> {
        const chat = chatOfKey(input.conversationKey);
        calls.push({ user: principal.userId, chat });
        const plan = outcomeFor.get(chat) ?? 'ANSWERED';
        if (plan === 'NOT_AVAILABLE') return { outcome: 'NOT_AVAILABLE', refusals: ['BUDGET_TASK_EXHAUSTED'] };
        const hash = telegramTriageWindowManifestHash({ organizationId: principal.organizationId, viewerUserId: principal.userId, conversationKey: input.conversationKey, messages: input.messages, truncated: input.truncated, conversation: input.conversation ?? null });
        const attempt = ledger.filter((r) => r.user === principal.userId && r.hash === hash).length + 1;
        const outcome = typeof plan === 'function' ? plan(attempt) : plan;
        ledger.push({ user: principal.userId, hash, outcome, at: clock.now });
        if (outcome === 'FAILED') return { outcome: 'FAILED', failure: 'TIMEOUT' };
        if (outcome === 'REJECTED_BY_LOOP') return { outcome: 'REJECTED_OUTPUT', rejections: ['ANSWER_TOO_LONG', 'TOO_LONG_LIMITATION'] };
        if (outcome === 'REFUSED_BY_MODEL') return { outcome: 'REFUSED_BY_MODEL' };
        return { outcome: 'TRIAGED', items: [], conversation: null, limitations: [], provenance: { invocationId: `inv_${ledger.length}`, taskId: 'telegram.content.triage', taskVersion: '4.0.0' } as never, evaluatedFloorProviderEventId: input.messages[0]!.providerEventId };
      },
      raiseWorkItem: async () => undefined,
      resolveObligations: async () => undefined,
      async recordConversationIntelligence(principal, digest) {
        readings.set(`${principal.userId}|${digest.subjectRef}`, digest.fingerprint);
        return { outcome: 'WRITTEN' };
      },
      async recordContentProgress(item, p) {
        cursors.set(item.userId, p.contentCursor);
      },
      async judgeWindow(principal, window, now): Promise<TelegramTriageWindowVerdict> {
        judged.push(window);
        hashes.set(window.subjectRef, window.manifestHash);
        const rows = ledger.filter((r) => r.user === principal.userId && r.hash === window.manifestHash && now.getTime() - r.at.getTime() < TELEGRAM_TRIAGE_WINDOW_POLICY.handledForMs);
        const failed = rows.filter((r) => r.outcome === 'FAILED');
        return decideTriageWindow(
          {
            answered: rows.filter((r) => r.outcome === 'ANSWERED').length,
            rejected: rows.filter((r) => r.outcome === 'REJECTED_BY_LOOP').length,
            refusedByModel: rows.filter((r) => r.outcome === 'REFUSED_BY_MODEL').length,
            failed: failed.length,
            lastFailedAt: failed.length ? failed[failed.length - 1]!.at : null,
            readingStored: readings.get(`${principal.userId}|${window.subjectRef}`) === window.digestFingerprint,
          },
          now,
        );
      },
      contentPageSize: 50,
      contentWindowDays: 30,
      now: () => clock.now,
    };
  };
  const sweep = () => runContentSweep(portsFor());
  const advance = (ms: number) => void (clock.now = new Date(clock.now.getTime() + ms));
  return { say, sweep, advance, calls, ledger, cursors, outcomeFor, judged, hashes };
}

test('1. a FAILED conversation no longer blocks the ones after it: A answered, B failed, C answered -- all in the same sweep', async () => {
  const w = world();
  w.say('A');
  w.say('B');
  w.say('C');
  w.outcomeFor.set('B', 'FAILED');
  const s = await w.sweep();
  assert.deepEqual(w.calls.map((c) => c.chat).sort(), ['A', 'B', 'C'], 'every conversation was reviewed');
  assert.deepEqual([s.failed, s.digestsWritten, s.held], [1, 2, 1], 'A and C written; B owed');
  assert.equal(w.cursors.get('u1'), null, 'the cursor is held while B is owed, so B is seen again');
});

test('2-4. the next cycle re-sends nothing already judged; the failed window backs off; after the backoff it is retried', async () => {
  const w = world();
  w.say('A');
  w.say('B');
  w.say('C');
  w.outcomeFor.set('B', 'FAILED');
  await w.sweep();
  w.advance(10 * 60 * 1000);
  const second = await w.sweep();
  assert.equal(w.calls.length, 3, 'the second cycle made no call at all');
  assert.deepEqual([second.deduped, second.backedOff], [2, 1]);
  w.advance(TELEGRAM_TRIAGE_WINDOW_POLICY.failureBackoffMs);
  w.outcomeFor.set('B', 'ANSWERED');
  const third = await w.sweep();
  assert.deepEqual(w.calls.slice(3).map((c) => c.chat), ['B'], 'only B, after its backoff');
  assert.equal(third.deduped, 2);
  assert.notEqual(w.cursors.get('u1'), null, 'nothing owed: the cursor moves');
});

test('3. a REJECTED exact window is not re-sent, cycle after cycle', async () => {
  const w = world();
  w.say('R');
  w.say('X');
  w.outcomeFor.set('R', 'REJECTED_BY_LOOP');
  w.outcomeFor.set('X', 'FAILED'); // holds the cursor, so R's page is read again and again
  for (let i = 0; i < 6; i += 1) {
    await w.sweep();
    w.advance(10 * 60 * 1000);
  }
  assert.equal(w.calls.filter((c) => c.chat === 'R').length, 1, 'rejected once, never paid for again');
});

test('5-6. a failed window is retried at most maxFailedAttempts times, then abandoned -- and the cursor moves', async () => {
  const w = world();
  w.say('B');
  w.say('A');
  w.outcomeFor.set('B', 'FAILED');
  let abandoned = 0;
  for (let i = 0; i < TELEGRAM_TRIAGE_WINDOW_POLICY.maxFailedAttempts + 3; i += 1) {
    abandoned += (await w.sweep()).abandoned;
    w.advance(TELEGRAM_TRIAGE_WINDOW_POLICY.failureBackoffMs + 60_000);
  }
  assert.equal(w.calls.filter((c) => c.chat === 'B').length, TELEGRAM_TRIAGE_WINDOW_POLICY.maxFailedAttempts, 'bounded');
  assert.equal(w.calls.filter((c) => c.chat === 'A').length, 1, 'A judged once, never re-sent');
  assert.equal(abandoned, 1, 'abandoned once: counted, not silently dropped');
  assert.notEqual(w.cursors.get('u1'), null, 'a permanently failing window does not hold the authorization forever');
});

test('7. a new message is a new window: the conversation is judged again, with a fresh allowance', async () => {
  const w = world();
  w.say('A');
  await w.sweep();
  const first = w.hashes.get(`telegram_conversation:${keyOf('A')}`) ?? [...w.hashes.values()][0];
  w.say('A');
  w.advance(10 * 60 * 1000);
  await w.sweep();
  assert.equal(w.calls.filter((c) => c.chat === 'A').length, 2);
  assert.notEqual([...w.hashes.values()].pop(), first, 'a different manifest');
});

test('8. the judge sees identifiers only: no message text reaches it, and the manifest does not change with the text', async () => {
  const w = world();
  w.say('A');
  await w.sweep();
  assert.equal(JSON.stringify(w.judged).includes('secret body'), false);
  const key = keyOf('A');
  const msgs = (text: string) => [{ providerEventId: `${key}:1`, direction: 'INBOUND' as const, occurredAt: T0, text }];
  const h = (text: string) => telegramTriageWindowManifestHash({ organizationId: ORG, viewerUserId: 'u1', conversationKey: key, messages: msgs(text), truncated: false, conversation: null });
  assert.equal(h('one text'), h('a completely different text'), 'the window identity is its ids, never its words');
});

test('13. a budget refusal costs no call and repeats no paid call: already judged windows stay judged', async () => {
  const w = world();
  w.say('A');
  w.say('Z');
  w.outcomeFor.set('Z', 'NOT_AVAILABLE');
  for (let i = 0; i < 5; i += 1) {
    await w.sweep();
    w.advance(10 * 60 * 1000);
  }
  assert.equal(w.ledger.filter((r) => r.outcome === 'ANSWERED').length, 1, 'A was paid for once');
  assert.equal(w.ledger.length, 1, 'a refusal is never a paid call');
});

test('14-15. two people with the identical window are judged separately; one person’s judgement never answers for another', async () => {
  const w = world({ users: ['u1', 'u2'] });
  w.say('A');
  await w.sweep();
  assert.deepEqual(w.calls.map((c) => c.user).sort(), ['u1', 'u2'], 'each person’s window is its own');
  w.advance(10 * 60 * 1000);
  await w.sweep();
  assert.equal(w.calls.length, 2, 'and each is then deduped for its own person only');
});

test('a judge that cannot answer spends nothing: no call, the window stays owed', async () => {
  // Ports whose judge throws (the ledger cannot be read).
  const calls: string[] = [];
  const summary = await runContentSweep({
    dueForContent: async () => [{ organizationId: ORG, userId: 'u1', provider: 'TELEGRAM', contentCursor: null } as DueContent],
    adapterFor: () => ({ provider: 'TELEGRAM', resume: async () => ({}) as never, observeContent: async () => ({ messages: [{ messageId: '1', chatId: 'A', senderId: 's', out: false, dateSeconds: 1, text: 't' }], nextCursor: '1' }), fetchConversationWindow: async () => ({ window: { conversationKey: keyOf('A'), conversation: null, messages: [{ providerEventId: `${keyOf('A')}:1`, direction: 'INBOUND', occurredAt: T0, text: 't' }], truncation: { includedCount: 1, reason: 'NONE', oldestIncludedProviderEventId: null } } as never }), disconnect: async () => undefined }),
    openCredential: async () => 's',
    conversationSecret: SECRET,
    triage: async () => (calls.push('call'), { outcome: 'REFUSED_BY_MODEL' }),
    raiseWorkItem: async () => undefined,
    resolveObligations: async () => undefined,
    recordConversationIntelligence: async () => ({ outcome: 'WRITTEN' }),
    recordContentProgress: async () => undefined,
    judgeWindow: async () => {
      throw new Error('ledger down');
    },
    contentPageSize: 50,
    contentWindowDays: 30,
    now: () => T0,
  });
  assert.deepEqual([calls.length, summary.backedOff, summary.held], [0, 1, 1]);
});
