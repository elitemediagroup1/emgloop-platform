// The HISTORICAL content backfill sweep (v2), and the pure adaptive window it rests on. No network, no
// database, no model.
//
// WHAT IT PROVES
//   ADAPTIVE WINDOW (gatherConversationWindow): skips empty/non-text (no slot consumed), stops at the
//   count cap OR the input-token budget, NEVER crosses the floor, returns chronological, records the
//   truncation reason + the oldest-included keyed boundary; a 40-message chunk stays within the 8000 cap.
//   HISTORICAL SWEEP: bounded conversations/sweep; resumes from the historical cursor; a TRANSIENT AI
//   failure HOLDS the frontier (retried, never lost); a PERMANENT model outcome advances + is counted; a
//   FLOOD_WAIT backs off; the backfill reaches COMPLETE at the end; and there is NO port that could write
//   the live observation cursor, the baseline checkpoint or the forward content cursor. No raw body persists.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AI_TRIAGE_LIMITS, conversationKeyOf } from '@emgloop/shared';
import { estimateTelegramTriageContextTokens } from '@emgloop/database';
import type {
  DueHistoricalContent,
  IntelligenceDigestInput,
  TelegramConversationTriageInput,
  TelegramConversationTriageResult,
  TelegramTriageObligation,
  WorkItemDetection,
  WorkPrincipal,
} from '@emgloop/database';
import type { ConversationIntelligenceWrite } from '../src/content-orchestrator';

import { gatherConversationWindow, minimizeDisplayLabel, type TelegramContentMessage, type TelegramConversationWindow } from '../src/telegram/telegram-content';
import { runHistoricalContentSweep, type HistoricalContentSweepPorts, type HistoricalContentAdapter, type HistoricalConversationsResult } from '../src/historical-content-orchestrator';

const SECRET = 'conv-secret';
const ORG = 'o1';
const USER = 'u1';
const RAW_CHAT = 'rawchat-778';
const CONV_KEY = conversationKeyOf('conversation', RAW_CHAT, SECRET);
const BASE = 1_700_000_000;

function cand(id: number, over: Partial<TelegramContentMessage> = {}): TelegramContentMessage {
  return { messageId: String(id), chatId: RAW_CHAT, senderId: 's', out: false, dateSeconds: BASE + id, text: `body-${id}`, ...over };
}

// --- The pure adaptive window -----------------------------------------------------------------

test('adaptive window: skips empty/non-text, returns chronological, records the oldest-included boundary', async () => {
  // Newest first, with two empties interleaved (they must not consume a slot).
  const candidates = [cand(5), cand(4, { text: '' }), cand(3), cand(2, { text: '   ' }), cand(1)];
  const w = gatherConversationWindow(RAW_CHAT, candidates, SECRET, { floorAt: new Date(0), maxMessages: 40, tokenBudget: 1_000_000 });
  assert.deepEqual(w.messages.map((m) => m.providerEventId), [`${CONV_KEY}:1`, `${CONV_KEY}:3`, `${CONV_KEY}:5`], 'text only, chronological');
  assert.equal(w.truncation.reason, 'NONE');
  assert.equal(w.truncation.includedCount, 3);
  assert.equal(w.truncation.oldestIncludedProviderEventId, `${CONV_KEY}:1`, 'the evaluated-window lower boundary');
});

test('adaptive window: stops at the hard count cap (COUNT)', async () => {
  const candidates = Array.from({ length: 10 }, (_, i) => cand(10 - i)); // newest first: 10..1
  const w = gatherConversationWindow(RAW_CHAT, candidates, SECRET, { floorAt: new Date(0), maxMessages: 3, tokenBudget: 1_000_000 });
  assert.equal(w.truncation.reason, 'COUNT');
  assert.equal(w.messages.length, 3);
  assert.deepEqual(w.messages.map((m) => m.providerEventId), [`${CONV_KEY}:8`, `${CONV_KEY}:9`, `${CONV_KEY}:10`], 'the 3 newest, chronological');
});

test('adaptive window: stops at the input-token budget (TOKENS)', async () => {
  const candidates = Array.from({ length: 10 }, (_, i) => cand(10 - i));
  // An injected estimator that grows 3000 per message; a budget of 8000 admits 2 (6000) and stops before 3 (9000).
  const w = gatherConversationWindow(RAW_CHAT, candidates, SECRET, {
    floorAt: new Date(0),
    maxMessages: 40,
    tokenBudget: 8000,
    estimateContextTokens: ({ messages }) => messages.length * 3000,
  });
  assert.equal(w.truncation.reason, 'TOKENS');
  assert.equal(w.messages.length, 2);
});

test('adaptive window: never crosses the floor (FLOOR)', async () => {
  const candidates = [cand(5), cand(4), cand(3), cand(2), cand(1)];
  // Floor between id2 and id3: id3,4,5 are in window; id2 and older are out.
  const floorAt = new Date((BASE + 3) * 1000);
  const w = gatherConversationWindow(RAW_CHAT, candidates, SECRET, { floorAt, maxMessages: 40, tokenBudget: 1_000_000 });
  assert.equal(w.truncation.reason, 'FLOOR');
  assert.deepEqual(w.messages.map((m) => m.providerEventId), [`${CONV_KEY}:3`, `${CONV_KEY}:4`, `${CONV_KEY}:5`], 'nothing below the floor');
});

test('adaptive window: a 40-message worst-case chunk stays within the reviewed 8000-token input cap', async () => {
  // 40 short messages, newest first. With the REAL gateway-matching estimator, all 40 fit and the whole
  // context is within the reviewed input cap (the budget class was NOT raised).
  const candidates = Array.from({ length: AI_TRIAGE_LIMITS.maxWindowMessages }, (_, i) => cand(AI_TRIAGE_LIMITS.maxWindowMessages - i, { text: `msg ${i} please confirm` }));
  const w = gatherConversationWindow(RAW_CHAT, candidates, SECRET, {
    floorAt: new Date(0),
    maxMessages: AI_TRIAGE_LIMITS.maxWindowMessages,
    tokenBudget: AI_TRIAGE_LIMITS.maxContextInputTokens,
  });
  assert.equal(w.messages.length, AI_TRIAGE_LIMITS.maxWindowMessages, 'all 40 short messages fit');
  const estimate = estimateTelegramTriageContextTokens({ organizationId: ORG, viewerUserId: USER, conversationKey: w.conversationKey, messages: w.messages, truncated: true, conversation: w.conversation });
  assert.ok(estimate <= AI_TRIAGE_LIMITS.maxContextInputTokens, `the 40-message chunk (${estimate} tok) stays within the ${AI_TRIAGE_LIMITS.maxContextInputTokens} cap`);
});

test('adaptive window: the ONE label Loop keeps is Telegram\'s, minimized -- trimmed, collapsed, no @handle, no phone, capped; never invented', async () => {
  assert.equal(minimizeDisplayLabel('  @Dana   Reyes  '), 'Dana Reyes');
  assert.equal(minimizeDisplayLabel('Acme Roofing Crew'), 'Acme Roofing Crew');
  assert.equal(minimizeDisplayLabel('+1 415 555 0134'), null, 'a phone number is not a label');
  assert.equal(minimizeDisplayLabel('   '), null);
  assert.equal(minimizeDisplayLabel(undefined), null);
  assert.equal(minimizeDisplayLabel(12345), null, 'an id is not a label');
  assert.equal(minimizeDisplayLabel('x'.repeat(200))!.length, AI_TRIAGE_LIMITS.maxCounterpartyLabelChars, 'capped');

  const w = gatherConversationWindow(RAW_CHAT, [cand(2), cand(1)], SECRET, {
    floorAt: new Date(0), maxMessages: 40, tokenBudget: 1_000_000, conversation: { label: '  @Dana   Reyes ', kind: 'PRIVATE' },
  });
  assert.deepEqual(w.conversation, { label: 'Dana Reyes', kind: 'PRIVATE' }, 'the window carries the minimized label');
  const none = gatherConversationWindow(RAW_CHAT, [cand(2), cand(1)], SECRET, { floorAt: new Date(0), maxMessages: 40, tokenBudget: 1_000_000 });
  assert.deepEqual(none.conversation, { label: null, kind: null }, 'no description from the provider -> no label, not a guess');
});

test('adaptive window: a sender label rides along ONLY for an inbound message in a GROUP -- never in a private chat, never for the person\'s own messages', async () => {
  const candidates = [cand(3, { senderLabel: 'Bob Chen' }), cand(2, { out: true, senderLabel: 'Me Myself' }), cand(1, { senderLabel: '  Ann  ' })];
  const group = gatherConversationWindow(RAW_CHAT, candidates, SECRET, { floorAt: new Date(0), maxMessages: 40, tokenBudget: 1_000_000, conversation: { label: 'Crew', kind: 'GROUP' } });
  assert.deepEqual(group.messages.map((m) => m.senderLabel ?? null), ['Ann', null, 'Bob Chen'], 'inbound group messages are attributed; the outbound one is not');
  const priv = gatherConversationWindow(RAW_CHAT, candidates, SECRET, { floorAt: new Date(0), maxMessages: 40, tokenBudget: 1_000_000, conversation: { label: 'Bob Chen', kind: 'PRIVATE' } });
  assert.deepEqual(priv.messages.map((m) => m.senderLabel ?? null), [null, null, null], 'in a private chat the counterparty IS the conversation label');
});

// --- The historical sweep ---------------------------------------------------------------------

const PROVENANCE = {
  invocationId: 'inv-hist',
  organizationId: ORG,
  taskId: 'telegram.content.triage',
  taskVersion: '2.1.0',
  templateId: 'telegram-content-triage',
  templateVersion: '4',
  routingPolicyVersion: 'routing.test',
  requestedModel: { providerId: 'anthropic', modelId: 'claude-opus-5' },
  servedModel: 'claude-opus-5',
  providerRequestId: 'req',
  viewerUserId: USER,
  contextSourceRefs: [],
  usage: null,
  calls: 1,
  latencyMs: 10,
  outcome: 'ANSWERED' as const,
  recordedAt: '2026-09-21T10:00:00Z',
};

function windowOf(key: string, ids: number[], bodyOver: Record<number, string> = {}, label: string | null = null): TelegramConversationWindow {
  const messages = ids.map((id) => ({ providerEventId: `${key}:${id}`, direction: 'INBOUND' as const, occurredAt: new Date((BASE + id) * 1000), text: bodyOver[id] ?? `body-${id}` }));
  return {
    conversationKey: key,
    conversation: { label, kind: label ? 'PRIVATE' : null },
    messages,
    truncation: { includedCount: messages.length, reason: 'NONE', oldestIncludedProviderEventId: messages.length ? messages[0]!.providerEventId : null },
  };
}

function triaged(items: readonly TelegramTriageObligation[], evaluatedFloor: string): TelegramConversationTriageResult {
  const key = evaluatedFloor.split(':')[0] ?? CONV_KEY;
  const conversation = {
    relevance: 'BUSINESS' as const,
    summary: 'A client is chasing an answer.',
    topics: ['Answer'],
    stateChange: null,
    signals: [{ kind: 'CHANGE' as const, anchorProviderEventId: evaluatedFloor || `${key}:10`, statement: 'The client asked for an answer', severity: 'MEDIUM' as const, owedBy: null, who: null }],
    attention: { needed: false, reason: null },
    confidence: 'MEDIUM' as const,
  };
  return { outcome: 'TRIAGED', items, conversation, limitations: [], provenance: PROVENANCE, evaluatedFloorProviderEventId: evaluatedFloor };
}

interface Recorder {
  raised: WorkItemDetection[];
  reconciled: { subjectRef: string; kept: readonly string[]; evaluatedFloor: string }[];
  progress: { historicalCursor: string | null; state: string; failureClass: string | null; backoffUntil: Date | null; failedItemsDelta: number }[];
  observeCalls: { cursor: string | null; maxConversations: number; floorAt: Date }[];
  digests: { principal: WorkPrincipal; digest: IntelligenceDigestInput }[];
  triaged: string[]; // the conversation keys a triage ran for
}

function ports(opts: {
  due?: DueHistoricalContent[];
  page?: HistoricalConversationsResult;
  triage?: (input: TelegramConversationTriageInput) => TelegramConversationTriageResult;
  conversationsPerSweep?: number;
  digest?: (digest: IntelligenceDigestInput, principal: WorkPrincipal) => ConversationIntelligenceWrite;
}): { ports: HistoricalContentSweepPorts; rec: Recorder } {
  const rec: Recorder = { raised: [], reconciled: [], progress: [], observeCalls: [], digests: [], triaged: [] };
  const adapter: HistoricalContentAdapter = {
    provider: 'TELEGRAM',
    async resume() {
      return { provider: 'TELEGRAM', handle: {} } as any;
    },
    async observeHistoricalConversations(_s, request): Promise<HistoricalConversationsResult> {
      rec.observeCalls.push({ cursor: request.cursor, maxConversations: request.maxConversations, floorAt: request.floorAt });
      return opts.page ?? { conversations: [windowOf(CONV_KEY, [10, 11])], nextCursor: 'C-next', reachedEnd: true };
    },
    async disconnect() {},
  };
  return {
    rec,
    ports: {
      dueForHistoricalContent: async () => opts.due ?? [{ organizationId: ORG, userId: USER, provider: 'TELEGRAM', historicalCursor: 'C0', historicalWindowFloorAt: new Date((BASE) * 1000) }],
      adapterFor: (p) => (p === 'TELEGRAM' ? adapter : null),
      openCredential: async () => 'session',
      conversationSecret: SECRET,
      triage: async (_principal, input) =>
        (rec.triaged.push(input.conversationKey), opts.triage ?? ((i) => triaged([{ anchorProviderEventId: `${input.conversationKey}:10`, category: 'REQUEST', oneLineMeaning: 'do the thing', topic: '', nextStep: 'Do it', deadline: null, owedBy: 'VIEWER', who: null }], i.evaluatedFloorProviderEventId)))(input),
      raiseWorkItem: async (_principal: WorkPrincipal, detection) => {
        rec.raised.push(detection);
      },
      resolveObligations: async (_principal, subjectRef, kept, evaluatedFloor) => {
        rec.reconciled.push({ subjectRef, kept, evaluatedFloor });
      },
      recordConversationIntelligence: async (principal, digest) => {
        const outcome = (opts.digest ?? (() => ({ outcome: 'WRITTEN' as const })))(digest, principal);
        rec.digests.push({ principal, digest });
        return outcome;
      },
      recordHistoricalProgress: async (_due, p) => {
        rec.progress.push({ historicalCursor: p.historicalCursor, state: p.state, failureClass: p.failureClass, backoffUntil: p.backoffUntil, failedItemsDelta: p.failedItemsDelta });
      },
      conversationsPerSweep: opts.conversationsPerSweep ?? 10,
      now: () => new Date('2026-09-21T10:00:00Z'),
    },
  };
}

test('historical: resumes from the historical cursor, bounded per sweep, raises obligations, reconciles, and reaches COMPLETE', async () => {
  const { ports: p, rec } = ports({ conversationsPerSweep: 7 });
  const summary = await runHistoricalContentSweep(p);
  assert.equal(rec.observeCalls[0]!.cursor, 'C0', 'resumes from the stored frontier');
  assert.equal(rec.observeCalls[0]!.maxConversations, 7, 'bounded conversations per sweep');
  assert.equal(rec.raised.length, 1, 'the obligation became a WorkItem');
  assert.equal(rec.raised[0]!.subjectRef, `telegram_conversation:${CONV_KEY}`);
  assert.equal(rec.reconciled.length, 1);
  assert.equal(rec.progress[0]!.state, 'COMPLETE', 'reachedEnd -> COMPLETE');
  assert.equal(rec.progress[0]!.historicalCursor, 'C-next', 'advanced to the next frontier');
  assert.equal(summary.completed, 1);
});

test('historical: a TRANSIENT model failure HOLDS the frontier (retried, never lost)', async () => {
  const page: HistoricalConversationsResult = { conversations: [windowOf(CONV_KEY, [10])], nextCursor: 'C-next', reachedEnd: false };
  const { ports: p, rec } = ports({ page, triage: () => ({ outcome: 'FAILED', failure: 'timeout' }) });
  await runHistoricalContentSweep(p);
  assert.equal(rec.raised.length, 0);
  assert.equal(rec.progress[0]!.historicalCursor, 'C0', 'the frontier holds, so the page is retried');
  assert.equal(rec.progress[0]!.state, 'IN_PROGRESS');
  assert.equal(rec.progress[0]!.failureClass, 'TRANSIENT');
});

test('historical: a governed refusal HOLDS the frontier and names the specific gate (#320), like the forward sweep', async () => {
  const { ports: p, rec } = ports({ triage: () => ({ outcome: 'NOT_AVAILABLE', refusals: ['NOT_ACTIVATED'] }) });
  await runHistoricalContentSweep(p);
  assert.equal(rec.progress[0]!.historicalCursor, 'C0');
  assert.equal(rec.progress[0]!.failureClass, 'REFUSED_BY_LOOP:NOT_ACTIVATED', 'the exact admission refusal, never the opaque class');
  assert.match(rec.progress[0]!.failureClass!, /^REFUSED_BY_LOOP:[A-Z_+]+$/, 'only the fixed enum + separators');
});

test('historical: a PERMANENT model outcome advances past the conversation and is COUNTED', async () => {
  const page: HistoricalConversationsResult = { conversations: [windowOf(CONV_KEY, [10])], nextCursor: 'C-next', reachedEnd: true };
  const { ports: p, rec } = ports({ page, triage: () => ({ outcome: 'REJECTED_OUTPUT', rejections: ['WRONG_SCHEMA'] }) });
  const summary = await runHistoricalContentSweep(p);
  assert.equal(rec.raised.length, 0);
  assert.equal(rec.progress[0]!.historicalCursor, 'C-next', 'advanced past the permanently-failed conversation');
  assert.equal(rec.progress[0]!.failedItemsDelta, 1, 'the permanent failure was counted');
  assert.equal(summary.failedItems, 1);
});

test('historical: a FLOOD_WAIT holds the frontier and backs off', async () => {
  const page: HistoricalConversationsResult = { conversations: [], nextCursor: 'C0', reachedEnd: false, floodWaitSeconds: 30 };
  const { ports: p, rec } = ports({ page });
  const summary = await runHistoricalContentSweep(p);
  assert.equal(summary.floodWaits, 1);
  assert.equal(rec.progress[0]!.historicalCursor, 'C0');
  assert.equal(rec.progress[0]!.failureClass, 'FLOOD_WAIT');
  assert.ok(rec.progress[0]!.backoffUntil instanceof Date);
});

test('historical: no raw body reaches the WorkItem, Telegram\'s label does, and there is NO port that could write the other three cursors', async () => {
  const MARKER = 'HISTMARKER-never-persist-88';
  const page: HistoricalConversationsResult = { conversations: [windowOf(CONV_KEY, [10], { 10: MARKER }, 'Dana Reyes')], nextCursor: 'C-next', reachedEnd: true };
  const { ports: p, rec } = ports({ page });
  await runHistoricalContentSweep(p);
  assert.ok(!JSON.stringify(rec.raised).includes(MARKER), 'the raw body never reaches the WorkItem');
  assert.equal((rec.raised[0]!.evidence as any).counterpartyLabel, 'Dana Reyes', 'the historical seed carries the same conversation label the forward path does');
  assert.equal((rec.raised[0]!.evidence as any).nextStep, 'Do it');
  const keys = Object.keys(p);
  assert.ok(!keys.includes('recordCycle'), 'no live-cursor writer');
  assert.ok(!keys.includes('recordBaselineProgress'), 'no baseline writer');
  assert.ok(!keys.includes('recordContentProgress'), 'no forward content-cursor writer');
  assert.ok(!keys.includes('sink'), 'no observation sink');
});

// --- Chats Intelligence in the historical backfill -----------------------------------------------

test('historical: each TRIAGED conversation also yields its digest from the SAME call -- principal-private, keyed, v4', async () => {
  const { ports: p, rec } = ports({});
  const summary = await runHistoricalContentSweep(p);
  assert.equal(rec.triaged.length, 1, 'one invocation for the conversation');
  assert.equal(rec.raised.length, 1, 'its obligation');
  assert.equal(rec.digests.length, 1, 'and its digest');
  const { principal, digest } = rec.digests[0]!;
  assert.deepEqual(principal, { organizationId: ORG, userId: USER });
  assert.equal(digest.subjectRef, `telegram_conversation:${CONV_KEY}`);
  assert.equal(digest.consentBasis, 'CONTENT_AUTHORIZATION');
  assert.equal(digest.evidenceCount, 2);
  assert.equal(digest.provenance.schemaId, 'telegram-content-triage.v5');
  assert.equal(summary.digestsWritten, 1);
  assert.equal(rec.progress[0]!.state, 'COMPLETE');
});

test('historical: a failed or rejected triage writes no digest (and the page semantics are unchanged)', async () => {
  const page: HistoricalConversationsResult = { conversations: [windowOf(CONV_KEY, [10])], nextCursor: 'C-next', reachedEnd: false };
  const failed = ports({ page, triage: () => ({ outcome: 'FAILED', failure: 'timeout' }) });
  await runHistoricalContentSweep(failed.ports);
  assert.equal(failed.rec.digests.length, 0);
  assert.equal(failed.rec.progress[0]!.historicalCursor, 'C0', 'held');
  const rejected = ports({ page, triage: () => ({ outcome: 'REJECTED_OUTPUT', rejections: ['VERBATIM_CONTENT'] }) });
  await runHistoricalContentSweep(rejected.ports);
  assert.equal(rejected.rec.digests.length, 0);
  assert.equal(rejected.rec.progress[0]!.historicalCursor, 'C-next', 'permanent: advanced and counted');
  assert.equal(rejected.rec.progress[0]!.failedItemsDelta, 1);
});

test('historical: CONSENT_NOT_IN_FORCE on a digest stops the page (no further body is read) and HOLDS the frontier', async () => {
  const KEY_B = conversationKeyOf('conversation', 'rawchat-other', SECRET);
  const page: HistoricalConversationsResult = { conversations: [windowOf(CONV_KEY, [10]), windowOf(KEY_B, [20])], nextCursor: 'C-next', reachedEnd: true };
  const { ports: p, rec } = ports({ page, digest: () => ({ outcome: 'REFUSED', refusal: 'CONSENT_NOT_IN_FORCE' }) });
  const summary = await runHistoricalContentSweep(p);
  assert.deepEqual(rec.triaged, [CONV_KEY], 'the second conversation was never sent to the model');
  assert.equal(rec.progress[0]!.historicalCursor, 'C0', 'held');
  assert.equal(rec.progress[0]!.failureClass, 'CONSENT_NOT_IN_FORCE');
  assert.equal(summary.digestsRefused, 1);
});

test('historical: EXPIRED_AT_WRITE (a conversation older than digest retention) is counted, and the backfill still advances', async () => {
  const { ports: p, rec } = ports({ digest: () => ({ outcome: 'REFUSED', refusal: 'EXPIRED_AT_WRITE' }) });
  const summary = await runHistoricalContentSweep(p);
  assert.equal(rec.raised.length, 1, 'the obligation stands');
  assert.equal(rec.progress[0]!.state, 'COMPLETE');
  assert.equal(summary.digestsRefused, 1);
});

test('historical: a digest write that THROWS holds the backfill (sink before frontier)', async () => {
  const { ports: p, rec } = ports({ digest: () => { throw new Error('database unavailable'); } });
  const summary = await runHistoricalContentSweep(p);
  assert.equal(summary.held, 1);
  assert.equal(rec.progress.length, 0, 'no progress recorded: the frontier stays where it was');
});

