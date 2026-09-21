// The FORWARD content sweep (v2 conversation triage), with fakes for every port. No network, no
// database, no model -- a fake triage stands in for the governed runtime, exactly as a
// RecordedModelProvider would behind it.
//
// WHAT IT PROVES
//   - discovery -> window -> obligations: a new inbound message triggers a conversation-window read whose
//     obligations become minimized, employee-private WorkItems (distinct recurrenceKeys, same subjectRef);
//   - RECONCILE runs with the kept anchors and the evaluated-window boundary (the guard itself lives in the
//     repository, proven against Postgres);
//   - RESOLUTION: an empty obligation list raises nothing and still reconciles (closing prior items);
//   - two-gate fail-closed: no credential -> skipped; a governed refusal (NOT_AVAILABLE) -> no WorkItem and
//     the content cursor HOLDS; nothing due -> nothing happens; a window flood -> hold + backoff;
//   - MINIMIZATION: a distinctive body string never reaches the WorkItem detection or its evidence, and the
//     raw chat/sender id and any display name never appear -- only keyed refs do;
//   - the sweep has NO port that could write the live observation cursor or the baseline checkpoint.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { conversationKeyOf } from '@emgloop/shared';
import type { DueContent, TelegramConversationTriageInput, TelegramConversationTriageResult, TelegramTriageObligation, WorkItemDetection, WorkPrincipal } from '@emgloop/database';

import { runContentSweep, type ContentSweepPorts, type ContentAdapter, type ContentObservationResult, type ContentWindowResult } from '../src/content-orchestrator';
import type { TelegramContentMessage, TelegramConversationWindow } from '../src/telegram/telegram-content';

const SECRET = 'conv-secret';
const ORG = 'o1';
const USER = 'u1';
const RAW_CHAT = 'rawchat-778';
const RAW_SENDER = 'rawsender-991';
const DISPLAY_NAME = 'Alice Displayname';
const CONV_KEY = conversationKeyOf('conversation', RAW_CHAT, SECRET);

function newMsg(id: string, over: Partial<TelegramContentMessage> = {}): TelegramContentMessage {
  return { messageId: id, chatId: RAW_CHAT, senderId: RAW_SENDER, out: false, dateSeconds: 1_700_000_000 + Number(id), text: `body-${id}`, ...over };
}

function windowOf(ids: string[], reason: TelegramConversationWindow['truncation']['reason'] = 'NONE', bodyOver: Record<string, string> = {}): TelegramConversationWindow {
  const messages = ids.map((id) => ({
    providerEventId: `${CONV_KEY}:${id}`,
    direction: 'INBOUND' as const,
    occurredAt: new Date((1_700_000_000 + Number(id)) * 1000),
    text: bodyOver[id] ?? `body-${id}`,
  }));
  return {
    conversationKey: CONV_KEY,
    messages,
    truncation: { includedCount: messages.length, reason, oldestIncludedProviderEventId: messages.length ? messages[0]!.providerEventId : null },
  };
}

const PROVENANCE = {
  invocationId: 'inv-777',
  organizationId: ORG,
  taskId: 'telegram.content.triage',
  taskVersion: '2.0.0',
  templateId: 'telegram-content-triage',
  templateVersion: '3',
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

function triaged(items: readonly TelegramTriageObligation[], evaluatedFloor: string): TelegramConversationTriageResult {
  return { outcome: 'TRIAGED', items, limitations: [], provenance: PROVENANCE, evaluatedFloorProviderEventId: evaluatedFloor };
}

const obligation = (anchorId: string, oneLineMeaning: string, category: TelegramTriageObligation['category'] = 'REQUEST'): TelegramTriageObligation => ({
  anchorProviderEventId: `${CONV_KEY}:${anchorId}`,
  category,
  oneLineMeaning,
});

interface Recorder {
  raised: { principal: WorkPrincipal; detection: WorkItemDetection }[];
  reconciled: { subjectRef: string; kept: readonly string[]; evaluatedFloor: string }[];
  progress: { due: DueContent; contentCursor: string | null; failureClass: string | null; backoffUntil: Date | null }[];
  triageInputs: TelegramConversationTriageInput[];
}

function ports(opts: {
  due: DueContent[];
  messages?: readonly TelegramContentMessage[];
  window?: (chatId: string) => ContentWindowResult;
  credential?: string | null;
  triage?: (input: TelegramConversationTriageInput) => TelegramConversationTriageResult;
  observeFlood?: number;
}): { ports: ContentSweepPorts; rec: Recorder } {
  const rec: Recorder = { raised: [], reconciled: [], progress: [], triageInputs: [] };
  const adapter: ContentAdapter = {
    provider: 'TELEGRAM',
    async resume() {
      return { provider: 'TELEGRAM', handle: {} } as any;
    },
    async observeContent(_s, cursor): Promise<ContentObservationResult> {
      if (opts.observeFlood !== undefined) return { messages: [], nextCursor: cursor, floodWaitSeconds: opts.observeFlood };
      const messages = opts.messages ?? [];
      const nextCursor = messages.reduce((max, m) => Math.max(max, Number(m.messageId)), Number(cursor ?? 0));
      return { messages, nextCursor: nextCursor > 0 ? String(nextCursor) : cursor };
    },
    async fetchConversationWindow(_s, request): Promise<ContentWindowResult> {
      return (opts.window ?? ((chatId) => ({ window: windowOf(['10']) })))(request.chatId);
    },
    async disconnect() {},
  };
  return {
    rec,
    ports: {
      dueForContent: async () => opts.due,
      adapterFor: (p) => (p === 'TELEGRAM' ? adapter : null),
      openCredential: async () => (opts.credential === undefined ? 'session' : opts.credential),
      conversationSecret: SECRET,
      triage: async (_principal, input) => {
        rec.triageInputs.push(input);
        return (opts.triage ?? ((i) => triaged([obligation('10', 'paraphrase, no body')], i.evaluatedFloorProviderEventId)))(input);
      },
      raiseWorkItem: async (principal, detection) => {
        rec.raised.push({ principal, detection });
      },
      resolveObligations: async (_principal, subjectRef, kept, evaluatedFloor) => {
        rec.reconciled.push({ subjectRef, kept, evaluatedFloor });
      },
      recordContentProgress: async (due, p) => {
        rec.progress.push({ due, contentCursor: p.contentCursor, failureClass: p.failureClass, backoffUntil: p.backoffUntil });
      },
      contentPageSize: 50,
      contentWindowDays: 30,
      now: () => new Date('2026-09-21T10:00:00Z'),
    },
  };
}

const due = (contentCursor: string | null): DueContent => ({ organizationId: ORG, userId: USER, provider: 'TELEGRAM', contentCursor });

test('discovery -> window -> obligations: two obligations become two WorkItems (distinct recurrenceKeys, same subjectRef)', async () => {
  const window = () => ({ window: windowOf(['8', '9', '10']) });
  const triage = (i: TelegramConversationTriageInput): TelegramConversationTriageResult =>
    triaged([obligation('8', 'Confirm the cap'), obligation('10', 'Send the invoice')], i.evaluatedFloorProviderEventId);
  const { ports: p, rec } = ports({ due: [due('5')], messages: [newMsg('10')], window, triage });
  const summary = await runContentSweep(p);
  assert.equal(summary.swept, 1);
  assert.equal(rec.raised.length, 2, 'two obligations -> two WorkItems');
  const keys = rec.raised.map((r) => r.detection.recurrenceKey);
  assert.equal(new Set(keys).size, 2, 'distinct recurrenceKeys');
  assert.equal(keys[0], `telegram.content.triage:${CONV_KEY}:${CONV_KEY}:8`);
  assert.equal(keys[1], `telegram.content.triage:${CONV_KEY}:${CONV_KEY}:10`);
  const subjects = new Set(rec.raised.map((r) => r.detection.subjectRef));
  assert.deepEqual([...subjects], [`telegram_conversation:${CONV_KEY}`], 'same subjectRef');
  // Reconcile ran with both kept anchors and the evaluated-window boundary (the oldest included).
  assert.equal(rec.reconciled.length, 1);
  assert.deepEqual([...rec.reconciled[0]!.kept], [`${CONV_KEY}:8`, `${CONV_KEY}:10`]);
  assert.equal(rec.reconciled[0]!.evaluatedFloor, `${CONV_KEY}:8`);
  // Discovery advanced the content cursor to the highest new message id.
  assert.equal(rec.progress[0]!.contentCursor, '10');
});

test('RESOLUTION: an empty obligation list raises nothing but still reconciles (closing prior items)', async () => {
  const window = () => ({ window: windowOf(['9', '10']) });
  const triage = (i: TelegramConversationTriageInput): TelegramConversationTriageResult => triaged([], i.evaluatedFloorProviderEventId);
  const { ports: p, rec } = ports({ due: [due('5')], messages: [newMsg('10')], window, triage });
  await runContentSweep(p);
  assert.equal(rec.raised.length, 0, 'nothing unresolved -> no WorkItem');
  assert.equal(rec.reconciled.length, 1, 'reconcile still runs');
  assert.deepEqual([...rec.reconciled[0]!.kept], [], 'no kept anchors -> in-window prior obligations close');
});

test('only conversations with a NEW inbound text message are triaged; outbound/empty do not trigger', async () => {
  const { ports: p, rec } = ports({ due: [due('5')], messages: [newMsg('10', { out: true }), newMsg('11', { text: '   ' })] });
  await runContentSweep(p);
  assert.equal(rec.triageInputs.length, 0, 'no inbound text -> no window read, no triage');
  assert.equal(rec.raised.length, 0);
  // The cursor still advances past the seen (outbound/empty) messages.
  assert.equal(rec.progress[0]!.contentCursor, '11');
});

test('fail-closed: a governed refusal raises NO WorkItem and HOLDS the cursor', async () => {
  const triage = (): TelegramConversationTriageResult => ({ outcome: 'NOT_AVAILABLE', refusals: ['NOT_ACTIVATED'] });
  const { ports: p, rec } = ports({ due: [due('5')], messages: [newMsg('10')], triage });
  await runContentSweep(p);
  assert.equal(rec.raised.length, 0, 'no WorkItem when the runtime refuses');
  assert.equal(rec.progress[0]!.contentCursor, '5', 'the cursor holds at where it was');
  assert.equal(rec.progress[0]!.failureClass, 'REFUSED_BY_LOOP:NOT_ACTIVATED', 'the specific admission refusal is preserved for diagnosis');
});

test('DIAGNOSTIC: the specific admission refusal(s) are preserved in failureClass, never a body or secret', async () => {
  const refuse = (): TelegramConversationTriageResult => ({ outcome: 'NOT_AVAILABLE', refusals: ['ORGANIZATION_NOT_ENABLED', 'CONTEXT_REFUSED'] });
  const { ports: p, rec } = ports({ due: [due('5')], messages: [newMsg('10')], triage: refuse });
  await runContentSweep(p);
  assert.equal(rec.progress[0]!.failureClass, 'REFUSED_BY_LOOP:ORGANIZATION_NOT_ENABLED+CONTEXT_REFUSED', 'the exact gate(s) are named, joined');
  // Only the fixed AiAdmissionRefusal enum + separators -- no message body, secret or free text.
  assert.match(rec.progress[0]!.failureClass!, /^REFUSED_BY_LOOP:[A-Z_+]+$/);
});

test('two-gate fail-closed: no live credential is skipped, with no WorkItem and no progress write', async () => {
  const { ports: p, rec } = ports({ due: [due('5')], messages: [newMsg('10')], credential: null });
  const summary = await runContentSweep(p);
  assert.equal(summary.skipped, 1);
  assert.equal(rec.raised.length, 0);
  assert.equal(rec.progress.length, 0, 'a skipped authorization writes nothing');
});

test('revoke/disconnect stop processing: nothing due means nothing happens', async () => {
  const { ports: p, rec } = ports({ due: [], messages: [newMsg('10')] });
  const summary = await runContentSweep(p);
  assert.equal(summary.due, 0);
  assert.equal(rec.raised.length, 0);
  assert.equal(rec.triageInputs.length, 0, 'no body is even read when nothing is due (revoked)');
});

test('a window flood-wait holds the cursor and backs off, raising nothing', async () => {
  const window = (): ContentWindowResult => ({ window: windowOf([]), floodWaitSeconds: 30 });
  const { ports: p, rec } = ports({ due: [due('5')], messages: [newMsg('10')], window });
  const summary = await runContentSweep(p);
  assert.equal(summary.floodWaits, 1);
  assert.equal(rec.raised.length, 0);
  assert.equal(rec.progress[0]!.contentCursor, '5');
  assert.equal(rec.progress[0]!.failureClass, 'FLOOD_WAIT');
  assert.ok(rec.progress[0]!.backoffUntil instanceof Date);
});

test('an observeContent flood-wait holds the cursor and backs off', async () => {
  const { ports: p, rec } = ports({ due: [due('5')], observeFlood: 42 });
  const summary = await runContentSweep(p);
  assert.equal(summary.floodWaits, 1);
  assert.equal(rec.progress[0]!.failureClass, 'FLOOD_WAIT');
});

test('MINIMIZATION + keyed identity: no body, no raw id, no name; keyed refs and provenance present', async () => {
  const MARKER = 'BODYMARKER-should-never-persist-55';
  const window = (): ContentWindowResult => ({ window: windowOf(['42'], 'TOKENS', { '42': MARKER }) });
  const triage = (i: TelegramConversationTriageInput): TelegramConversationTriageResult =>
    triaged([obligation('42', 'Client asks to reschedule the call')], i.evaluatedFloorProviderEventId);
  const { ports: p, rec } = ports({ due: [due('5')], messages: [newMsg('42')], window, triage });
  await runContentSweep(p);
  assert.equal(rec.raised.length, 1);
  const detection = rec.raised[0]!.detection;
  const json = JSON.stringify(detection);

  assert.ok(!json.includes(MARKER), 'the raw message body never reaches the WorkItem');
  assert.equal(detection.title, 'Client asks to reschedule the call');
  assert.equal((detection.evidence as any).body, undefined, 'the evidence has no body field');
  assert.ok(!json.includes(RAW_CHAT), 'the raw chat id never reaches the WorkItem');
  assert.ok(!json.includes(RAW_SENDER), 'the raw sender id never reaches the WorkItem');
  assert.ok(!json.includes(DISPLAY_NAME), 'no display name is stored (keyed identifiers only)');
  assert.equal((detection.evidence as any).providerEventId, `${CONV_KEY}:42`, 'the keyed anchor is the evidence');
  assert.equal((detection.evidence as any).conversationKey, CONV_KEY);
  assert.equal(detection.subjectRef, `telegram_conversation:${CONV_KEY}`);
  assert.equal((detection.evidence as any).aiInvocationId, 'inv-777');
  assert.equal((detection.evidence as any).aiTaskVersion, '2.0.0');
  assert.equal((detection.evidence as any).category, 'REQUEST');
  assert.equal((detection.evidence as any).contextTruncated, true);
  assert.equal(detection.class, 'NEEDS_YOU');
  assert.equal(detection.producerKind, 'MODEL');
});

test('the sweep has NO port that could write the live observation cursor or the baseline checkpoint', async () => {
  const { ports: p } = ports({ due: [due('5')], messages: [newMsg('10')] });
  const keys = Object.keys(p);
  assert.ok(!keys.includes('recordCycle'), 'no live-cursor writer');
  assert.ok(!keys.includes('recordBaselineProgress'), 'no baseline writer');
  assert.ok(!keys.includes('recordHistoricalProgress'), 'the forward sweep never writes the historical cursor');
  assert.ok(!keys.includes('sink'), 'no observation sink -- the content path never writes SourceObservation');
});
