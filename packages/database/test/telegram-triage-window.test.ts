// Telegram triage reliability (2026-09-30), through the REAL AiRuntimeGateway and TelegramContentTriageService (a
// RecordedModelProvider for Anthropic: no key, no network). Proves:
//   - the window's manifest hash computed BEFORE a call is exactly the `contextManifestHash` the ledger stores for
//     it -- the property exact-window dedupe rests on -- and it is made of identifiers, never text;
//   - the window policy (handled / exhausted / backed off / new);
//   - template v7 states every enforced limit, with a target below each; answers within the targets pass;
//   - an answer past a HARD limit is still refused whole, and the ledger records WHICH field, never its text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RecordedModelProvider, aiCatalogCapabilities, AI_ROUTING_POLICY, AI_BUDGET_POLICY, AI_MAX_ATTEMPTS_PER_TARGET } from '@emgloop/providers';
import { AI_CHATS_LIMITS, AI_TRIAGE_LIMITS, type AiModelResult, type AiProviderPolicy } from '@emgloop/shared';

import { AiRuntimeGateway, InMemoryAiUsageLedger } from '../src/services/ai-runtime/gateway';
import { aiContextManifestHash } from '../src/repositories/ai-usage-ledger.repository';
import { TelegramContentTriageService } from '../src/services/ai-runtime/telegram-content-triage.service';
import { renderTelegramContentTriageInstructions, TELEGRAM_CONTENT_TRIAGE_TEMPLATE_VERSION } from '../src/services/ai-runtime/templates/telegram-content-triage';
import { telegramTriageManifestRefs } from '../src/services/ai-runtime/telegram-content-triage-context';
import { decideTriageWindow, telegramTriageWindowManifestHash, TELEGRAM_TRIAGE_WINDOW_POLICY } from '../src/services/ai-runtime/telegram-triage-window';

const ORG = 'org_tw';
const USER = 'user_tw';
const CONV = 'ck_window';
const NOW = new Date('2026-09-30T10:00:00Z');
const HOUR = 36e5;
const POLICY: readonly AiProviderPolicy[] = [{ providerId: 'anthropic', state: 'ACTIVE', ceiling: 'COMMUNICATION_CONTENT', version: 1, recordedAtMs: 0 }];
const message = (id: number, text: string) => ({ providerEventId: `${CONV}:${id}`, direction: 'INBOUND' as const, occurredAt: new Date(NOW.getTime() - (10 - id) * 60_000), text });
const input = (texts: string[]) => ({ conversationKey: CONV, messages: texts.map((t, i) => message(i + 1, t)), truncated: false, evaluatedFloorProviderEventId: `${CONV}:1`, conversation: null });
const principal = { organizationId: ORG, userId: USER };

const WITHIN = {
  schemaId: 'telegram-content-triage.v5',
  items: [{ anchorOrdinal: 1, category: 'REQUEST', oneLineMeaning: 'Dana wants the signed contract back', topic: 'Contract', nextStep: 'Countersign and send it to Dana', deadline: 'by Thursday', owedBy: 'VIEWER', who: null }],
  conversation: { relevance: 'BUSINESS', summary: 'Dana is waiting on the countersigned contract.', topics: ['Contract'], stateChange: null, signals: [{ kind: 'UNRESOLVED', anchorOrdinal: 1, statement: 'The contract has not gone back yet', severity: 'MEDIUM', owedBy: null, who: null }], attention: { needed: true, reason: 'Dana set a deadline' }, confidence: 'MEDIUM' },
  limitations: [],
};
const result = (json: unknown): AiModelResult => ({ output: { json }, toolCalls: [], stopReason: 'END', usage: { inputTokens: 500, outputTokens: 80 }, providerRequestId: 'req', reportedModel: 'claude-opus-5', latencyMs: 40 });

function triage(json: unknown) {
  const ledger = new InMemoryAiUsageLedger();
  const provider = new RecordedModelProvider('anthropic', [{ modelId: 'claude-opus-5', result: result(json) }], (m) => aiCatalogCapabilities('anthropic', m));
  const gateway = new AiRuntimeGateway(
    { activation: { enabled: true, organizations: [ORG], tasks: ['telegram.content.triage'], providers: ['anthropic'] }, policy: AI_ROUTING_POLICY, budget: AI_BUDGET_POLICY, killSwitches: [], maxAttemptsPerTarget: AI_MAX_ATTEMPTS_PER_TARGET },
    { providers: [provider], ledger, authorize: async () => true, now: () => NOW, newInvocationId: () => `inv_${Math.random().toString(36).slice(2)}`, providerPolicies: async () => POLICY },
  );
  return { service: new TelegramContentTriageService({ runtime: gateway }), ledger };
}
const TEXTS = ['Can you send the signed contract back by Thursday?', 'Let me check', 'Thanks'];

test('the manifest hash computed before the call IS the ledger’s contextManifestHash for that window -- identifiers only', async () => {
  const { service, ledger } = triage(WITHIN);
  const r = await service.triage(principal, input(TEXTS));
  assert.equal(r.outcome, 'TRIAGED');
  const stored = aiContextManifestHash(ledger.calls[0]!.contextSourceRefs as string[]);
  const pre = telegramTriageWindowManifestHash({ organizationId: ORG, viewerUserId: USER, ...input(TEXTS) });
  assert.equal(pre, stored, 'the same hash, so the ledger can answer "already judged?" before paying');
  const refs = telegramTriageManifestRefs({ organizationId: ORG, viewerUserId: USER, ...input(TEXTS) });
  for (const t of TEXTS) assert.equal(refs.join('|').includes(t.slice(0, 8)), false, 'no text in the refs');
  assert.equal(telegramTriageWindowManifestHash({ organizationId: ORG, viewerUserId: USER, ...input(['other words', 'entirely', 'here']) }), pre, 'ids, not words');
  assert.notEqual(telegramTriageWindowManifestHash({ organizationId: ORG, viewerUserId: USER, ...input([...TEXTS, 'a new message']) }), pre, 'a new message is a new window');
});

test('the window policy: stored or rejected is handled; an answer whose writes failed is asked once more; failures back off, then run out', () => {
  const none = { answered: 0, rejected: 0, refusedByModel: 0, failed: 0, lastFailedAt: null, readingStored: false };
  const P = TELEGRAM_TRIAGE_WINDOW_POLICY;
  assert.equal(decideTriageWindow(none, NOW), 'NEW');
  assert.equal(decideTriageWindow({ ...none, readingStored: true }, NOW), 'HANDLED');
  assert.equal(decideTriageWindow({ ...none, rejected: 1 }, NOW), 'HANDLED');
  assert.equal(decideTriageWindow({ ...none, refusedByModel: 1 }, NOW), 'HANDLED');
  assert.equal(decideTriageWindow({ ...none, answered: 1 }, NOW), 'NEW', 'answered but the reading is not stored: once more, to finish the writes');
  assert.equal(decideTriageWindow({ ...none, answered: 2 }, NOW), 'HANDLED', 'never forever');
  assert.equal(decideTriageWindow({ ...none, failed: 1, lastFailedAt: new Date(NOW.getTime() - HOUR) }, NOW), 'BACKED_OFF');
  assert.equal(decideTriageWindow({ ...none, failed: 1, lastFailedAt: new Date(NOW.getTime() - P.failureBackoffMs - 1) }, NOW), 'NEW', 'retried after the backoff');
  assert.equal(decideTriageWindow({ ...none, failed: P.maxFailedAttempts, lastFailedAt: new Date(NOW.getTime() - 5 * HOUR) }, NOW), 'EXHAUSTED');
  assert.equal(decideTriageWindow({ ...none, failed: P.maxFailedAttempts, rejected: 1, lastFailedAt: NOW }, NOW), 'HANDLED', 'a judged window is judged');
  assert.deepEqual([P.failureBackoffMs, P.maxFailedAttempts, P.handledForMs], [3 * HOUR, 4, 7 * 24 * HOUR], 'the conventions Loop already uses');
});

test('template v7 states every enforced limit, with a target below each hard limit, and makes empty answers correct', () => {
  assert.equal(TELEGRAM_CONTENT_TRIAGE_TEMPLATE_VERSION, '7');
  const L = AI_TRIAGE_LIMITS;
  const text = renderTelegramContentTriageInstructions({ truncated: true, labelled: true });
  const hard: [string, number][] = [
    ['oneLineMeaning', L.maxMeaningChars],
    ['topic', L.maxTopicChars],
    ['nextStep', L.maxNextStepChars],
    ['deadline', L.maxDeadlineChars],
    ['summary', L.maxSummaryChars],
    ['stateChange', AI_CHATS_LIMITS.maxStateChangeChars],
    ['attention', L.maxAttentionReasonChars],
  ];
  for (const [field, max] of hard) assert.match(text, new RegExp(`${field}[^\\n]*hard ${max}`), `${field} states its hard limit ${max}`);
  for (const [field, target, max] of [['oneLineMeaning', 100, 140], ['topic', 40, 60], ['nextStep', 90, 120], ['summary', 150, 200], ['stateChange', 120, 160]] as const) {
    assert.match(text, new RegExp(`${field} \\(target ${target}, hard ${max}[,)]`));
    assert.ok(target < max);
  }
  assert.match(text, new RegExp(`hard limit ${L.maxObligations}`), 'obligations');
  assert.match(text, new RegExp(`topics: usually 1 to 3 \\(hard limit ${L.maxConversationTopics}\\), each target 25, hard ${L.maxConversationTopicChars}`));
  assert.match(text, new RegExp(`signals: usually 0 to 5 \\(hard limit ${AI_CHATS_LIMITS.maxSignals}\\), each target 100, hard ${L.maxStatementChars}`));
  assert.match(text, new RegExp(`LIMITATIONS: usually 0 or 1 \\(hard limit ${L.maxLimitations}\\), each one short sentence, target 120, hard ${L.maxLimitationChars}`));
  assert.match(text, /Shorter is\s+always better than complete/);
  assert.match(text, /Empty lists are correct answers/);
  assert.equal(/which document, job, amount or\s+decision, and with whom/.test(text), false, 'no longer demands detail that cannot fit');
  assert.match(text, /say so in ONE short limitation/, 'the truncation note is bounded too');
});

test('an Anthropic-shaped answer within the targets validates; empty lists are a complete answer', async () => {
  assert.equal((await triage(WITHIN).service.triage(principal, input(TEXTS))).outcome, 'TRIAGED');
  const empty = { ...WITHIN, items: [], conversation: { ...WITHIN.conversation, topics: [], signals: [], attention: { needed: false, reason: null } }, limitations: [] };
  assert.equal((await triage(empty).service.triage(principal, input(TEXTS))).outcome, 'TRIAGED');
});

test('an answer past a HARD limit is still refused whole, and the ledger records WHICH field -- never the text', async () => {
  const L = AI_TRIAGE_LIMITS;
  const long = (n: number) => 'x'.repeat(n + 1);
  const item = WITHIN.items[0]!;
  const c = WITHIN.conversation;
  const cases: [string, unknown][] = [
    ['TOO_LONG_OBLIGATION_MEANING', { ...WITHIN, items: [{ ...item, oneLineMeaning: long(L.maxMeaningChars) }] }],
    ['TOO_LONG_OBLIGATION_TOPIC', { ...WITHIN, items: [{ ...item, topic: long(L.maxTopicChars) }] }],
    ['TOO_LONG_NEXT_STEP', { ...WITHIN, items: [{ ...item, nextStep: long(L.maxNextStepChars) }] }],
    ['TOO_LONG_OBLIGATIONS', { ...WITHIN, items: Array.from({ length: L.maxObligations + 1 }, () => item) }],
    ['TOO_LONG_SUMMARY', { ...WITHIN, conversation: { ...c, summary: long(L.maxSummaryChars) } }],
    ['TOO_LONG_TOPICS', { ...WITHIN, conversation: { ...c, topics: Array.from({ length: L.maxConversationTopics + 1 }, (_, i) => `t${i}`) } }],
    ['TOO_LONG_TOPIC', { ...WITHIN, conversation: { ...c, topics: [long(L.maxConversationTopicChars)] } }],
    ['TOO_LONG_STATE_CHANGE', { ...WITHIN, conversation: { ...c, stateChange: long(AI_CHATS_LIMITS.maxStateChangeChars) } }],
    ['TOO_LONG_SIGNALS', { ...WITHIN, conversation: { ...c, signals: Array.from({ length: AI_CHATS_LIMITS.maxSignals + 1 }, () => c.signals[0]) } }],
    ['TOO_LONG_SIGNAL', { ...WITHIN, conversation: { ...c, signals: [{ ...c.signals[0]!, statement: long(L.maxStatementChars) }] } }],
    ['TOO_LONG_ATTENTION_REASON', { ...WITHIN, conversation: { ...c, attention: { needed: true, reason: long(L.maxAttentionReasonChars) } } }],
    ['TOO_LONG_LIMITATIONS', { ...WITHIN, limitations: Array.from({ length: L.maxLimitations + 1 }, () => 'A gap.') }],
    ['TOO_LONG_LIMITATION', { ...WITHIN, limitations: [long(L.maxLimitationChars)] }],
  ];
  for (const [code, json] of cases) {
    const { service, ledger } = triage(json);
    const r = await service.triage(principal, input(TEXTS));
    assert.equal(r.outcome, 'REJECTED_OUTPUT', code);
    const codes = (r as { rejections: string[] }).rejections;
    assert.ok(codes.includes('ANSWER_TOO_LONG') && codes.includes(code), `${code}: ${codes.join(',')}`);
    const recorded = ledger.calls[0]!.reconciliation!;
    assert.deepEqual([recorded.outcome, recorded.failureClass], ['REJECTED_BY_LOOP', 'OUTPUT_INVALID']);
    assert.ok(recorded.rejectionCodes.includes(code), 'the ledger names the field');
    assert.equal(JSON.stringify(recorded).includes('xxxxxxxxxx'), false, 'never the offending text');
  }
});
