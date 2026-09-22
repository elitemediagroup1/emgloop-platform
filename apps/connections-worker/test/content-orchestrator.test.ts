// The FORWARD content sweep (v2.1 conversation triage), with fakes for every port. No network, no
// database, no model -- a fake triage stands in for the governed runtime, exactly as a
// RecordedModelProvider would behind it.
//
// WHAT IT PROVES
//   - discovery -> window -> obligations: a new inbound message triggers a conversation-window read whose
//     obligations become minimized, employee-private WorkItems (distinct recurrenceKeys, same subjectRef);
//   - PERIODIC REVIEW is activity-driven: a conversation is eligible on ANY new text since the frontier --
//     INBOUND or OUTBOUND. Several new messages in a cycle -> ONE review; an unchanged conversation is not
//     reread; activity in A does not reread B; an OUTBOUND reply drives the reconcile that closes an item;
//   - RECONCILE runs with the kept anchors and the evaluated-window boundary (the guard itself lives in the
//     repository, proven against Postgres);
//   - RESOLUTION: an empty obligation list raises nothing and still reconciles (closing prior items);
//   - two-gate fail-closed: no credential -> skipped; a governed refusal (NOT_AVAILABLE) -> no WorkItem and
//     the content cursor HOLDS; nothing due -> nothing happens; a window flood -> hold + backoff;
//   - MINIMIZATION: a distinctive body string never reaches the WorkItem detection or its evidence, and the
//     raw chat/sender id and any per-message sender name never appear -- only keyed refs, the model's
//     minimized paraphrase fields, and the ONE conversation label Telegram itself gave the window;
//   - WHO IS NEVER INVENTED: the label on the item is the adapter's (Telegram's), never the model's; with no
//     label from Telegram the item carries none;
//   - the sweep has NO port that could write the live observation cursor or the baseline checkpoint.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { conversationKeyOf } from '@emgloop/shared';
import type { DueContent, TelegramConversationTriageInput, TelegramConversationTriageResult, TelegramTriageObligation, TelegramTriageConversation, WorkItemDetection, WorkPrincipal } from '@emgloop/database';

import { runContentSweep, type ContentSweepPorts, type ContentAdapter, type ContentObservationResult, type ContentWindowResult } from '../src/content-orchestrator';
import type { TelegramContentMessage, TelegramConversationWindow } from '../src/telegram/telegram-content';

const SECRET = 'conv-secret';
const ORG = 'o1';
const USER = 'u1';
const RAW_CHAT = 'rawchat-778';
const RAW_SENDER = 'rawsender-991';
const DISPLAY_NAME = 'Alice Displayname';
const GROUP_SENDER = 'Bob Groupsender';
const CONV_KEY = conversationKeyOf('conversation', RAW_CHAT, SECRET);
const NO_LABEL: TelegramTriageConversation = { label: null, kind: null };

function newMsg(id: string, over: Partial<TelegramContentMessage> = {}): TelegramContentMessage {
  return { messageId: id, chatId: RAW_CHAT, senderId: RAW_SENDER, out: false, dateSeconds: 1_700_000_000 + Number(id), text: `body-${id}`, ...over };
}

function windowOf(
  ids: string[],
  reason: TelegramConversationWindow['truncation']['reason'] = 'NONE',
  bodyOver: Record<string, string> = {},
  conversation: TelegramTriageConversation = NO_LABEL,
  senderLabel?: string,
): TelegramConversationWindow {
  const messages = ids.map((id) => ({
    providerEventId: `${CONV_KEY}:${id}`,
    direction: 'INBOUND' as const,
    occurredAt: new Date((1_700_000_000 + Number(id)) * 1000),
    text: bodyOver[id] ?? `body-${id}`,
    ...(senderLabel ? { senderLabel } : {}),
  }));
  return {
    conversationKey: CONV_KEY,
    conversation,
    messages,
    truncation: { includedCount: messages.length, reason, oldestIncludedProviderEventId: messages.length ? messages[0]!.providerEventId : null },
  };
}

// A second and third conversation for the multi-conversation cases (A has activity, B does not).
const RAW_CHAT_A = 'rawchat-AAA';
const RAW_CHAT_B = 'rawchat-BBB';
const CONV_KEY_A = conversationKeyOf('conversation', RAW_CHAT_A, SECRET);
const CONV_KEY_B = conversationKeyOf('conversation', RAW_CHAT_B, SECRET);

function windowForChat(rawChat: string, ids: string[]): TelegramConversationWindow {
  const convKey = conversationKeyOf('conversation', rawChat, SECRET);
  const messages = ids.map((id) => ({
    providerEventId: `${convKey}:${id}`,
    direction: 'INBOUND' as const,
    occurredAt: new Date((1_700_000_000 + Number(id)) * 1000),
    text: `body-${id}`,
  }));
  return {
    conversationKey: convKey,
    conversation: NO_LABEL,
    messages,
    truncation: { includedCount: messages.length, reason: 'NONE', oldestIncludedProviderEventId: messages.length ? messages[0]!.providerEventId : null },
  };
}

const PROVENANCE = {
  invocationId: 'inv-777',
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

function triaged(items: readonly TelegramTriageObligation[], evaluatedFloor: string): TelegramConversationTriageResult {
  return { outcome: 'TRIAGED', items, limitations: [], provenance: PROVENANCE, evaluatedFloorProviderEventId: evaluatedFloor };
}

const obligation = (
  anchorId: string,
  oneLineMeaning: string,
  category: TelegramTriageObligation['category'] = 'REQUEST',
  over: Partial<Pick<TelegramTriageObligation, 'topic' | 'nextStep' | 'deadline'>> = {},
): TelegramTriageObligation => ({
  anchorProviderEventId: `${CONV_KEY}:${anchorId}`,
  category,
  oneLineMeaning,
  topic: '',
  nextStep: 'Reply in Telegram',
  deadline: null,
  ...over,
});

interface Recorder {
  raised: { principal: WorkPrincipal; detection: WorkItemDetection }[];
  reconciled: { subjectRef: string; kept: readonly string[]; evaluatedFloor: string }[];
  progress: { due: DueContent; contentCursor: string | null; failureClass: string | null; backoffUntil: Date | null }[];
  triageInputs: TelegramConversationTriageInput[];
  windows: string[]; // the raw chat ids a window was fetched for -- one entry per conversation reviewed
}

function ports(opts: {
  due: DueContent[];
  messages?: readonly TelegramContentMessage[];
  window?: (chatId: string) => ContentWindowResult;
  credential?: string | null;
  triage?: (input: TelegramConversationTriageInput) => TelegramConversationTriageResult;
  observeFlood?: number;
}): { ports: ContentSweepPorts; rec: Recorder } {
  const rec: Recorder = { raised: [], reconciled: [], progress: [], triageInputs: [], windows: [] };
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
      rec.windows.push(request.chatId);
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

test('non-text activity does not trigger a review: empty/whitespace messages (inbound or outbound) never triage, but the cursor still advances', async () => {
  // The empty-text skip is preserved from the inbound-only era: only TEXT is activity. Direction no longer
  // gates the trigger (see the OUTBOUND-activity test below), so both a blank inbound and a blank outbound
  // message are non-events -- yet discovery still advances the content frontier past them.
  const { ports: p, rec } = ports({ due: [due('5')], messages: [newMsg('10', { text: '   ' }), newMsg('11', { out: true, text: '' })] });
  await runContentSweep(p);
  assert.equal(rec.triageInputs.length, 0, 'no text activity -> no window read, no triage');
  assert.equal(rec.raised.length, 0);
  // The content cursor still advances past the seen (non-text) messages.
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

test('MINIMIZATION + keyed identity: no body, no raw id, no per-message sender name; keyed refs, the minimized fields and provenance present', async () => {
  const MARKER = 'BODYMARKER-should-never-persist-55';
  // A GROUP window: Telegram labelled the conversation, and the inbound message carries its sender's label
  // (context for the model). The obligation the model returns is specific and dated.
  const window = (): ContentWindowResult => ({ window: windowOf(['42'], 'TOKENS', { '42': MARKER }, { label: DISPLAY_NAME, kind: 'GROUP' }, GROUP_SENDER) });
  const triage = (i: TelegramConversationTriageInput): TelegramConversationTriageResult =>
    triaged(
      [obligation('42', 'Client asks to reschedule the call', 'REQUEST', { topic: 'Kickoff call', nextStep: 'Propose a new time', deadline: 'this week' })],
      i.evaluatedFloorProviderEventId,
    );
  const { ports: p, rec } = ports({ due: [due('5')], messages: [newMsg('42', { senderLabel: GROUP_SENDER })], window, triage });
  await runContentSweep(p);
  assert.equal(rec.raised.length, 1);
  const detection = rec.raised[0]!.detection;
  const json = JSON.stringify(detection);

  // NEVER: the body, the raw ids, a per-message sender name.
  assert.ok(!json.includes(MARKER), 'the raw message body never reaches the WorkItem');
  assert.equal((detection.evidence as any).body, undefined, 'the evidence has no body field');
  assert.ok(!json.includes(RAW_CHAT), 'the raw chat id never reaches the WorkItem');
  assert.ok(!json.includes(RAW_SENDER), 'the raw sender id never reaches the WorkItem');
  assert.ok(!json.includes(GROUP_SENDER), 'a per-message sender label is context only; it is never stored');
  // ALWAYS: keyed refs, provenance, and the minimized fields a person can act on.
  assert.equal(detection.title, 'Client asks to reschedule the call', 'WHAT, as the model paraphrased it');
  assert.equal((detection.evidence as any).providerEventId, `${CONV_KEY}:42`, 'the keyed anchor is the evidence');
  assert.equal((detection.evidence as any).conversationKey, CONV_KEY);
  assert.equal(detection.subjectRef, `telegram_conversation:${CONV_KEY}`);
  assert.equal((detection.evidence as any).aiInvocationId, 'inv-777');
  assert.equal((detection.evidence as any).aiTaskVersion, '2.1.0');
  assert.equal((detection.evidence as any).category, 'REQUEST');
  assert.equal((detection.evidence as any).contextTruncated, true);
  assert.equal((detection.evidence as any).topic, 'Kickoff call');
  assert.equal((detection.evidence as any).nextStep, 'Propose a new time', 'what the person must DO');
  assert.equal((detection.evidence as any).deadline, 'this week', 'the (grounded) deadline');
  // WHO: the ONE label Telegram gave the conversation -- and only that.
  assert.equal((detection.evidence as any).counterpartyLabel, DISPLAY_NAME, "Telegram's own conversation label is kept");
  assert.equal((detection.evidence as any).conversationKind, 'GROUP');
  assert.equal(detection.class, 'NEEDS_YOU');
  assert.equal(detection.producerKind, 'MODEL');
});

test('WHO is Telegram\'s, never the model\'s: the label comes from the gathered window, and with no label the item carries none (nothing invented)', async () => {
  // The model has no field for identity (TelegramTriageObligation has no who/counterparty), so the only
  // way a label reaches the item is the adapter's window. Here Telegram gave none.
  const window = (): ContentWindowResult => ({ window: windowOf(['7'], 'NONE', {}, NO_LABEL) });
  const triage = (i: TelegramConversationTriageInput): TelegramConversationTriageResult =>
    triaged([obligation('7', 'Someone asks for the paperwork', 'REQUEST', { nextStep: 'Send it' })], i.evaluatedFloorProviderEventId);
  const { ports: p, rec } = ports({ due: [due('5')], messages: [newMsg('7')], window, triage });
  await runContentSweep(p);
  assert.equal(rec.raised.length, 1);
  const evidence = rec.raised[0]!.detection.evidence as any;
  assert.equal(evidence.counterpartyLabel, null, 'no label from Telegram -> none on the item, not a guess');
  assert.equal(evidence.conversationKind, null);
  assert.ok(!('who' in (rec.triageInputs[0] as any)), 'the triage input names the conversation only through `conversation`');
  assert.deepEqual(rec.triageInputs[0]!.conversation, NO_LABEL, 'and the model was told nothing about who it is with');

  // With a label, the triage input carries exactly the window's label (Telegram's), and the item records it.
  const labelled = (): ContentWindowResult => ({ window: windowOf(['8'], 'NONE', {}, { label: DISPLAY_NAME, kind: 'PRIVATE' }) });
  const { ports: p2, rec: rec2 } = ports({ due: [due('5')], messages: [newMsg('8')], window: labelled, triage });
  await runContentSweep(p2);
  assert.deepEqual(rec2.triageInputs[0]!.conversation, { label: DISPLAY_NAME, kind: 'PRIVATE' });
  assert.equal((rec2.raised[0]!.detection.evidence as any).counterpartyLabel, DISPLAY_NAME);
});

test('the sweep has NO port that could write the live observation cursor or the baseline checkpoint', async () => {
  const { ports: p } = ports({ due: [due('5')], messages: [newMsg('10')] });
  const keys = Object.keys(p);
  assert.ok(!keys.includes('recordCycle'), 'no live-cursor writer');
  assert.ok(!keys.includes('recordBaselineProgress'), 'no baseline writer');
  assert.ok(!keys.includes('recordHistoricalProgress'), 'the forward sweep never writes the historical cursor');
  assert.ok(!keys.includes('sink'), 'no observation sink -- the content path never writes SourceObservation');
});

// --- Periodic conversation review: activity-driven eligibility (inbound OR outbound) ---------------
// These six prove the amendment that turns the forward path from "triage on a new inbound message" into an
// autonomous periodic review keyed on ANY new text since the content frontier.

test('ACTIVITY (inbound): a new inbound text makes the conversation eligible -> reviewed exactly once', async () => {
  const { ports: p, rec } = ports({ due: [due('5')], messages: [newMsg('10')] });
  const summary = await runContentSweep(p);
  assert.equal(summary.swept, 1);
  assert.equal(rec.triageInputs.length, 1, 'inbound activity -> the conversation is reviewed once');
  assert.equal(rec.windows.length, 1, 'exactly one window read');
});

test('ACTIVITY (outbound): a new OUTBOUND text with no inbound still makes the conversation eligible -> reviewed', async () => {
  // Matt replying/confirming is activity: the conversation must be reviewed so RECONCILE can close the item.
  const { ports: p, rec } = ports({ due: [due('5')], messages: [newMsg('9', { out: true })] });
  const summary = await runContentSweep(p);
  assert.equal(summary.swept, 1);
  assert.equal(rec.triageInputs.length, 1, 'outbound-only activity -> the conversation IS reviewed');
  assert.equal(rec.windows.length, 1, 'the window is read for the outbound-active conversation');
});

test('ONE review per conversation: several new messages (in+out) in a cycle -> exactly one triage call', async () => {
  // Three new messages in ONE conversation within the interval must collapse to a single review/one AI call.
  const messages = [newMsg('7'), newMsg('8', { out: true }), newMsg('9')];
  const { ports: p, rec } = ports({ due: [due('5')], messages });
  await runContentSweep(p);
  assert.equal(rec.triageInputs.length, 1, 'several messages in one conversation -> ONE triage call');
  assert.deepEqual(rec.windows, [RAW_CHAT], 'exactly one window fetch, for the single conversation');
  // Discovery still advances the frontier to the highest new message id seen this cycle.
  assert.equal(rec.progress[0]!.contentCursor, '9');
});

test('UNCHANGED conversations are not reread: no new message since the frontier -> zero triage calls, cursor unchanged', async () => {
  // A due authorization whose discovery page is empty (nothing new since the content cursor): no review runs.
  const { ports: p, rec } = ports({ due: [due('5')] });
  const summary = await runContentSweep(p);
  assert.equal(summary.swept, 1, 'the authorization is processed');
  assert.equal(summary.held, 0, 'nothing held: an empty page is a clean no-op, not a failure');
  assert.equal(rec.triageInputs.length, 0, 'no new message -> no AI invocation');
  assert.equal(rec.windows.length, 0, 'no window is even read for an unchanged conversation');
  assert.equal(rec.raised.length, 0);
  assert.equal(rec.progress[0]!.contentCursor, '5', 'the content cursor is unchanged (advances to the same value)');
  assert.equal(rec.progress[0]!.failureClass, null);
});

test('OUTBOUND resolution -> RECONCILE closes the open obligation: outbound reply, model judges resolved, reconcile runs with the empty kept-list and the evaluated-window boundary', async () => {
  // An open obligation exists for conversation C (raised on an earlier inbound). Matt then sends an OUTBOUND
  // reply that resolves it. The outbound message makes C eligible; the model returns NO remaining obligations;
  // the sweep raises nothing and RECONCILES with an empty kept-list at the evaluated-window boundary -- the
  // exact call that closes the open WorkItem. The close itself and the truncation guard are proven against a
  // real Postgres in packages/database/test/work-item-reconcile.postgres.test.ts, which this PR does not touch.
  const window = () => ({ window: windowOf(['7', '8']) }); // the bounded window; oldest included is CONV_KEY:7
  const triage = (i: TelegramConversationTriageInput): TelegramConversationTriageResult => triaged([], i.evaluatedFloorProviderEventId);
  const { ports: p, rec } = ports({ due: [due('5')], messages: [newMsg('9', { out: true })], window, triage });
  await runContentSweep(p);
  assert.equal(rec.triageInputs.length, 1, 'the outbound reply triggered the review');
  assert.equal(rec.raised.length, 0, 'nothing unresolved remains -> no new WorkItem');
  assert.equal(rec.reconciled.length, 1, 'reconcile runs to close prior open obligations');
  assert.deepEqual([...rec.reconciled[0]!.kept], [], 'no kept anchors -> the in-window open obligation closes');
  assert.equal(rec.reconciled[0]!.subjectRef, `telegram_conversation:${CONV_KEY}`);
  assert.equal(rec.reconciled[0]!.evaluatedFloor, `${CONV_KEY}:7`, 'the evaluated-window boundary the guard reads is preserved');
});

test('A-activity does not reread B: a new message in conversation A triages A only, never the unchanged B', async () => {
  // Only A has new activity this cycle; B has no new message since the frontier and is not in the page.
  const window = (chatId: string): ContentWindowResult => ({ window: windowForChat(chatId, ['10']) });
  const triage = (i: TelegramConversationTriageInput): TelegramConversationTriageResult => triaged([], i.evaluatedFloorProviderEventId);
  const { ports: p, rec } = ports({ due: [due('5')], messages: [newMsg('10', { chatId: RAW_CHAT_A })], window, triage });
  await runContentSweep(p);
  assert.deepEqual(rec.windows, [RAW_CHAT_A], 'only A is read; B is never fetched');
  assert.equal(rec.triageInputs.length, 1, 'exactly one conversation reviewed');
  assert.equal(rec.triageInputs[0]!.conversationKey, CONV_KEY_A, 'the review is for A');
  assert.ok(!rec.triageInputs.some((i) => i.conversationKey === CONV_KEY_B), 'B (unchanged) is never reread');
});
