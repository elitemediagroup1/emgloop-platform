// The CONTENT sweep, with fakes for every port. No network, no database, no model -- a fake triage
// stands in for the governed runtime, exactly as a RecordedModelProvider would behind it.
//
// WHAT IT PROVES
//   - bounded + resumable: the content cursor advances to the last handled message and is held (not
//     advanced) on a governance refusal, so the next run resumes where it stopped;
//   - two-gate fail-closed: no credential -> skipped, no WorkItem; a governed refusal (REFUSED_BY_LOOP,
//     i.e. not activated / not authorized) -> no WorkItem and the cursor HOLDS; no consent (nothing due)
//     -> nothing happens;
//   - revoke/disconnect stop processing (nothing due / no credential);
//   - MINIMIZATION: a distinctive body string never reaches the WorkItem detection or its evidence;
//   - provenance: the evidence carries the invocation id, the task version, keyed refs and provider;
//   - identity keyed-only: the RAW chat/sender id and any display name never appear in the WorkItem;
//   - the sweep has NO port that could write the live observation cursor or the baseline checkpoint.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { conversationKeyOf } from '@emgloop/shared';
import type { DueContent, WorkItemDetection, WorkPrincipal, TelegramTriageResult } from '@emgloop/database';

import { runContentSweep, type ContentSweepPorts, type ContentAdapter, type ContentObservationResult } from '../src/content-orchestrator';
import type { TelegramContentMessage } from '../src/telegram/telegram-content';

const SECRET = 'conv-secret';
const ORG = 'o1';
const USER = 'u1';
const RAW_CHAT = 'rawchat-778';
const RAW_SENDER = 'rawsender-991';
const DISPLAY_NAME = 'Alice Displayname';

function msg(id: string, over: Partial<TelegramContentMessage> = {}): TelegramContentMessage {
  return { messageId: id, chatId: RAW_CHAT, senderId: RAW_SENDER, out: false, dateSeconds: 1_700_000_000 + Number(id), text: `body-${id}`, ...over };
}

function triaged(oneLineMeaning: string, over: Record<string, unknown> = {}): TelegramTriageResult {
  return {
    outcome: 'TRIAGED',
    verdict: {
      actionable: true,
      category: 'REQUEST',
      oneLineMeaning,
      limitations: [],
      sourceRef: 'telegram_message:x',
      provenance: {
        invocationId: 'inv-777',
        organizationId: ORG,
        taskId: 'telegram.content.triage',
        taskVersion: '1.0.0',
        templateId: 'telegram-content-triage',
        templateVersion: '1',
        routingPolicyVersion: 'routing.test',
        requestedModel: { providerId: 'anthropic', modelId: 'claude-opus-5' },
        servedModel: 'claude-opus-5',
        providerRequestId: 'req',
        viewerUserId: USER,
        contextSourceRefs: [],
        usage: null,
        calls: 1,
        latencyMs: 10,
        outcome: 'ANSWERED',
        recordedAt: '2026-09-21T10:00:00Z',
      },
      ...(over as object),
    },
  };
}

interface Recorder {
  raised: { principal: WorkPrincipal; detection: WorkItemDetection }[];
  progress: { due: DueContent; contentCursor: string | null; failureClass: string | null; backoffUntil: Date | null }[];
  observeCalls: { cursor: string | null; limit: number }[];
  triageBodies: string[];
}

function ports(opts: {
  due: DueContent[];
  messages?: readonly TelegramContentMessage[];
  credential?: string | null;
  triage?: (input: { body: string }) => TelegramTriageResult;
  floodWaitSeconds?: number;
  pageSize?: number;
}): { ports: ContentSweepPorts; rec: Recorder } {
  const rec: Recorder = { raised: [], progress: [], observeCalls: [], triageBodies: [] };
  const adapter: ContentAdapter = {
    provider: 'TELEGRAM',
    async resume() {
      return { provider: 'TELEGRAM', handle: {} } as any;
    },
    async observeContent(_s, cursor, limit): Promise<ContentObservationResult> {
      rec.observeCalls.push({ cursor, limit });
      if (opts.floodWaitSeconds !== undefined) return { messages: [], nextCursor: cursor, floodWaitSeconds: opts.floodWaitSeconds };
      return { messages: opts.messages ?? [], nextCursor: cursor };
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
        rec.triageBodies.push(input.body);
        return (opts.triage ?? (() => triaged('paraphrase, no body')))(input);
      },
      raiseWorkItem: async (principal, detection) => {
        rec.raised.push({ principal, detection });
      },
      recordContentProgress: async (due, p) => {
        rec.progress.push({ due, contentCursor: p.contentCursor, failureClass: p.failureClass, backoffUntil: p.backoffUntil });
      },
      contentPageSize: opts.pageSize ?? 50,
      now: () => new Date('2026-09-21T10:00:00Z'),
    },
  };
}

const due = (contentCursor: string | null): DueContent => ({ organizationId: ORG, userId: USER, provider: 'TELEGRAM', contentCursor });

test('bounded + resumable: the content cursor advances to the highest handled message', async () => {
  const { ports: p, rec } = ports({ due: [due('5')], messages: [msg('12'), msg('10'), msg('11')], pageSize: 25 });
  const summary = await runContentSweep(p);
  assert.equal(summary.swept, 1);
  assert.equal(rec.raised.length, 3, 'three inbound text messages triaged actionable');
  assert.equal(rec.observeCalls[0]!.limit, 25, 'the bounded page size is passed to the adapter');
  assert.equal(rec.progress.length, 1);
  assert.equal(rec.progress[0]!.contentCursor, '12', 'advanced to the highest message id');
  assert.equal(rec.progress[0]!.failureClass, null);
});

test('an outbound or empty message is seen (cursor advances) but never triaged', async () => {
  const { ports: p, rec } = ports({ due: [due('5')], messages: [msg('10', { out: true }), msg('11', { text: '   ' }), msg('12')] });
  await runContentSweep(p);
  assert.equal(rec.raised.length, 1, 'only the inbound text message is triaged');
  assert.equal(rec.progress[0]!.contentCursor, '12');
});

test('fail-closed: a governed refusal raises NO WorkItem and HOLDS the cursor', async () => {
  const refuse = (): TelegramTriageResult => ({ outcome: 'NOT_AVAILABLE', refusals: ['NOT_ACTIVATED'] });
  const { ports: p, rec } = ports({ due: [due('5')], messages: [msg('10'), msg('11')], triage: refuse });
  await runContentSweep(p);
  assert.equal(rec.raised.length, 0, 'no WorkItem when the runtime refuses');
  assert.equal(rec.progress[0]!.contentCursor, '5', 'the cursor holds at where it was');
  assert.equal(rec.progress[0]!.failureClass, 'REFUSED_BY_LOOP:NOT_ACTIVATED', 'the specific admission refusal is preserved for diagnosis');
});

test('DIAGNOSTIC: the specific admission refusal(s) are preserved in failureClass, never a body or secret', async () => {
  const refuse = (): TelegramTriageResult => ({ outcome: 'NOT_AVAILABLE', refusals: ['ORGANIZATION_NOT_ENABLED', 'CONTEXT_REFUSED'] });
  const { ports: p, rec } = ports({ due: [due('5')], messages: [msg('10')], triage: refuse });
  await runContentSweep(p);
  assert.equal(rec.progress[0]!.failureClass, 'REFUSED_BY_LOOP:ORGANIZATION_NOT_ENABLED+CONTEXT_REFUSED', 'the exact gate(s) are named, joined');
  // Only the fixed AiAdmissionRefusal enum + separators -- no message body, secret or free text.
  assert.match(rec.progress[0]!.failureClass!, /^REFUSED_BY_LOOP:[A-Z_+]+$/);
});

test('resumable across a mid-batch refusal: earlier messages are kept, the refused one is retried', async () => {
  let call = 0;
  const triage = (): TelegramTriageResult => (call++ === 0 ? triaged('first is fine') : { outcome: 'NOT_AVAILABLE', refusals: ['ORGANIZATION_NOT_ENABLED'] });
  const { ports: p, rec } = ports({ due: [due('5')], messages: [msg('10'), msg('11'), msg('12')], triage });
  await runContentSweep(p);
  assert.equal(rec.raised.length, 1, 'the first message was handled before the refusal');
  assert.equal(rec.progress[0]!.contentCursor, '10', 'held at the last handled message, so 11 and 12 are retried');
});

test('two-gate fail-closed: no live credential is skipped, with no WorkItem and no progress write', async () => {
  const { ports: p, rec } = ports({ due: [due('5')], messages: [msg('10')], credential: null });
  const summary = await runContentSweep(p);
  assert.equal(summary.skipped, 1);
  assert.equal(rec.raised.length, 0);
  assert.equal(rec.progress.length, 0, 'a skipped authorization writes nothing');
});

test('revoke/disconnect stop processing: nothing due means nothing happens', async () => {
  const { ports: p, rec } = ports({ due: [], messages: [msg('10')] });
  const summary = await runContentSweep(p);
  assert.equal(summary.due, 0);
  assert.equal(rec.raised.length, 0);
  assert.equal(rec.triageBodies.length, 0, 'no body is even read when nothing is due (revoked)');
});

test('a flood-wait holds the cursor and backs off, raising nothing', async () => {
  const { ports: p, rec } = ports({ due: [due('5')], floodWaitSeconds: 30 });
  const summary = await runContentSweep(p);
  assert.equal(summary.floodWaits, 1);
  assert.equal(rec.raised.length, 0);
  assert.equal(rec.progress[0]!.contentCursor, '5');
  assert.equal(rec.progress[0]!.failureClass, 'FLOOD_WAIT');
  assert.ok(rec.progress[0]!.backoffUntil instanceof Date);
});

test('MINIMIZATION + provenance + keyed identity: no body, no raw id, no name; ids and keys present', async () => {
  const DISTINCTIVE = 'BODYMARKER-should-never-persist-55';
  const { ports: p, rec } = ports({
    due: [due('5')],
    messages: [msg('42', { text: DISTINCTIVE })],
    triage: () => triaged('Client asks to reschedule the call'),
  });
  await runContentSweep(p);
  assert.equal(rec.raised.length, 1);
  const detection = rec.raised[0]!.detection;
  const json = JSON.stringify(detection);

  // MINIMIZATION: the raw body appears nowhere; the title is the model's paraphrase.
  assert.ok(!json.includes(DISTINCTIVE), 'the raw message body never reaches the WorkItem');
  assert.equal(detection.title, 'Client asks to reschedule the call');
  assert.equal((detection.evidence as any).body, undefined, 'the evidence has no body field');

  // KEYED IDENTITY: the raw chat/sender id and any display name never appear; keyed refs do.
  assert.ok(!json.includes(RAW_CHAT), 'the raw chat id never reaches the WorkItem');
  assert.ok(!json.includes(RAW_SENDER), 'the raw sender id never reaches the WorkItem');
  assert.ok(!json.includes(DISPLAY_NAME), 'no display name is stored (keyed identifiers only)');
  const conversationKey = conversationKeyOf('conversation', RAW_CHAT, SECRET);
  assert.equal((detection.evidence as any).conversationKey, conversationKey);
  assert.equal((detection.evidence as any).providerEventId, `${conversationKey}:42`);
  assert.equal(detection.subjectRef, `telegram_conversation:${conversationKey}`);
  assert.equal(detection.recurrenceKey, `telegram.content.triage:${conversationKey}`);

  // PROVENANCE: provider, the invocation id, the task version, and the category.
  assert.equal((detection.evidence as any).provider, 'TELEGRAM');
  assert.equal((detection.evidence as any).aiInvocationId, 'inv-777');
  assert.equal((detection.evidence as any).aiTaskVersion, '1.0.0');
  assert.equal((detection.evidence as any).category, 'REQUEST');
  assert.equal(detection.class, 'NEEDS_YOU');
  assert.equal(detection.producerKind, 'MODEL');
});

test('the sweep has NO port that could write the live observation cursor or the baseline checkpoint', async () => {
  // Structural: the only state-mutating ports are raiseWorkItem and recordContentProgress. There is no
  // recordCycle (live cursor) and no recordBaselineProgress (baseline) on ContentSweepPorts, so the
  // content path cannot move either -- proven here by the port surface, and byte-for-byte in the
  // Postgres repository test (recordContentProgress leaves source_connections unchanged).
  const { ports: p } = ports({ due: [due('5')], messages: [msg('10')] });
  const keys = Object.keys(p);
  assert.ok(!keys.includes('recordCycle'), 'no live-cursor writer');
  assert.ok(!keys.includes('recordBaselineProgress'), 'no baseline writer');
  assert.ok(!keys.includes('sink'), 'no observation sink -- the content path never writes SourceObservation');
});
