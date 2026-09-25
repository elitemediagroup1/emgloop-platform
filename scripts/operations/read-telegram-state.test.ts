// Read Telegram State: a read-only diagnosis that prints states, classes, times and counts -- never a
// label, a key, a cursor, a secret, a body, a user or an organization id -- and cannot write.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { readOnlyClient } from '@emgloop/database';
import { AI_TASK_TELEGRAM_CONTENT_TRIAGE, DERIVED_WORK_SUBJECT_PREFIXES, WORK_ITEM_OUTCOMES, WORK_ITEM_STATES, telegramConversationSubjectRef } from '@emgloop/shared';
import {
  LEDGER_LOOKBACK_DAYS,
  MAX_CONNECTIONS,
  PrismaTelegramStateReader,
  TELEGRAM_SUBJECT_REF_PREFIX,
  TRIAGE_TASK_ID,
  parseArgs,
  readEnvironment,
  runTelegramState,
  type TelegramState,
} from './read-telegram-state';

const NOW = new Date('2026-09-24T12:00:00Z');
const ORG = 'org_live_1';
const SLUG = 'servicesinmycity-demo';
const at = (s: string) => new Date(s);

// --- A Prisma double: the read methods only, over rows that carry everything this runner must never print.

type Row = Record<string, unknown>;

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [k, cond] of Object.entries(where)) {
    const v = row[k];
    if (cond === null) {
      if (v !== null && v !== undefined) return false;
    } else if (cond instanceof Date) {
      if (!(v instanceof Date) || v.getTime() !== cond.getTime()) return false;
    } else if (typeof cond === 'object') {
      const c = cond as Row;
      if ('not' in c && (c.not === null ? v === null || v === undefined : v === c.not)) return false;
      if ('gte' in c && (!(v instanceof Date) || v.getTime() < (c.gte as Date).getTime())) return false;
      if ('startsWith' in c && (typeof v !== 'string' || !v.startsWith(String(c.startsWith)))) return false;
    } else if (v !== cond) return false;
  }
  return true;
}

function compare(a: unknown, b: unknown): number {
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

function sort(rows: Row[], orderBy: Row | Row[] | undefined): Row[] {
  if (!orderBy) return rows;
  const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]).flatMap((o) => Object.entries(o));
  return [...rows].sort((x, y) => {
    for (const [k, dir] of keys) {
      const c = compare(x[k], y[k]);
      if (c !== 0) return dir === 'desc' ? -c : c;
    }
    return 0;
  });
}

const pick = (row: Row, select: Row | undefined): Row =>
  select ? Object.fromEntries(Object.entries(select).filter(([, on]) => on === true).map(([k]) => [k, row[k]])) : { ...row };

/** What the reader asked for, by model: every selected or aggregated column, and every `where`. */
interface Trace { selected: Set<string>; wheres: Row[] }

function model(name: string, rows: Row[], trace: Trace) {
  const note = (select: Row | undefined) => { for (const k of Object.keys(select ?? {})) trace.selected.add(`${name}.${k}`); };
  const where = (w: Row | undefined) => { trace.wheres.push({ __model: name, ...(w ?? {}) }); return rows.filter((r) => matches(r, w)); };
  return {
    async findUnique(a: { where: Row; select?: Row }) { note(a.select); const r = where(a.where)[0]; return r ? pick(r, a.select) : null; },
    async findMany(a: { where?: Row; orderBy?: Row | Row[]; take?: number; select?: Row } = {}) {
      note(a.select);
      const out = sort(where(a.where), a.orderBy);
      return (a.take === undefined ? out : out.slice(0, a.take)).map((r) => pick(r, a.select));
    },
    async count(a: { where?: Row } = {}) { return where(a.where).length; },
    async aggregate(a: { where?: Row; _count?: Row; _min?: Row; _max?: Row }) {
      const found = where(a.where);
      note(a._min); note(a._max);
      const edge = (spec: Row | undefined, pickEdge: (vals: unknown[]) => unknown) =>
        Object.fromEntries(Object.keys(spec ?? {}).map((k) => [k, found.length ? pickEdge(found.map((r) => r[k])) : null]));
      return {
        _count: { _all: found.length },
        _min: edge(a._min, (vals) => vals.reduce((m, v) => (compare(v, m) < 0 ? v : m))),
        _max: edge(a._max, (vals) => vals.reduce((m, v) => (compare(v, m) > 0 ? v : m))),
      };
    },
    async groupBy(a: { by: string[]; where?: Row; orderBy?: Row; _count?: Row; _sum?: Row }) {
      note(a._sum);
      const key = a.by[0]!;
      const groups = new Map<unknown, Row[]>();
      for (const r of where(a.where)) groups.set(r[key], [...(groups.get(r[key]) ?? []), r]);
      const out = [...groups.entries()].map(([value, members]) => ({
        [key]: value,
        _count: { _all: members.length },
        _sum: Object.fromEntries(Object.keys(a._sum ?? {}).map((k) => {
          const nums = members.map((m) => m[k]).filter((v): v is number => typeof v === 'number');
          return [k, nums.length ? nums.reduce((s, n) => s + n, 0) : null];
        })),
      }));
      return sort(out, a.orderBy);
    },
  };
}

/** Everything this runner must never print, as it would sit in production rows. */
const SENTINEL = {
  orgName: 'SENTINEL_ORG_NAME Services In My City',
  label: 'SENTINEL_LABEL @matt_handle',
  sealed: 'SENTINEL_SEALED_SESSION',
  keyRef: 'SENTINEL_KEYREF',
  liveCursor: 'SENTINEL_LIVE_CURSOR',
  checkpoint: 'SENTINEL_CHECKPOINT_CURSOR',
  contentCursor: 'SENTINEL_CONTENT_CURSOR',
  historicalCursor: 'SENTINEL_HISTORICAL_CURSOR',
  hydrationCursor: 'SENTINEL_HYDRATION_CURSOR',
  conversationKey: 'SENTINEL_CONVKEY',
  eventId: 'SENTINEL_CONVKEY:SENTINEL_EVENT_1',
  senderKey: 'SENTINEL_SENDER',
  participant: 'SENTINEL_PARTICIPANT',
  title: 'SENTINEL_TITLE call the client back about the invoice',
  evidenceLabel: 'SENTINEL_EVIDENCE_LABEL',
  invocation: 'SENTINEL_INVOCATION_1',
  manifest: 'SENTINEL_MANIFEST_HASH',
  providerRequest: 'SENTINEL_PROVIDER_REQUEST',
  email: 'matt@elitemediagroup.example',
  phone: '+15551234567',
} as const;

function connection(userId: string, over: Row = {}): Row {
  return {
    id: `conn_${userId}`, organizationId: ORG, userId, provider: 'TELEGRAM', adapter: null, state: 'READY', credentialKind: 'MTPROTO_SESSION',
    secretSealed: Buffer.from(SENTINEL.sealed), sealVersion: 'v1', keyRef: SENTINEL.keyRef, accountLabel: SENTINEL.label, backgroundObservation: 'OPERATIONAL',
    cursor: SENTINEL.liveCursor, lastFailureClass: null, connectingStartedAt: at('2026-09-20T10:00:00Z'), connectedAt: at('2026-09-20T10:05:00Z'),
    lastObservedAt: at('2026-09-24T11:50:00Z'), reconnectRequiredAt: null, disconnectedAt: null, disconnectedByUserId: null,
    createdAt: at('2026-09-20T10:00:00Z'), updatedAt: at('2026-09-24T11:50:00Z'), ...over,
  };
}

function observation(userId: string, observedAt: string, over: Row = {}): Row {
  return {
    id: `obs_${userId}_${observedAt}`, organizationId: ORG, userId, provider: 'TELEGRAM', providerEventId: SENTINEL.eventId, conversationKey: SENTINEL.conversationKey,
    senderKey: SENTINEL.senderKey, participantKeys: [SENTINEL.participant], direction: 'INBOUND', hadText: true, occurredAt: at(observedAt), observedAt: at(observedAt),
    createdAt: at(observedAt), ...over,
  };
}

function workItem(id: string, over: Row = {}): Row {
  return {
    id, organizationId: ORG, userId: 'user_matt', recurrenceKey: `telegram.content.triage:${SENTINEL.conversationKey}:${SENTINEL.eventId}`, class: 'NEEDS_YOU',
    subjectKind: 'THREAD', subjectRef: `${TELEGRAM_SUBJECT_REF_PREFIX}${SENTINEL.conversationKey}`, title: SENTINEL.title, producerKind: 'MODEL',
    producerId: 'telegram.content.triage', producerVersion: '2.1.0', evidence: { conversationLabel: SENTINEL.evidenceLabel, providerEventId: SENTINEL.eventId },
    evidenceQuote: null, evidenceQuoteRef: null, firstDetectedAt: at('2026-09-23T09:00:00Z'), lastDetectedAt: at('2026-09-23T09:00:00Z'), detectionCount: 1,
    state: 'OPEN', stateChangedAt: null, snoozedUntil: null, resolvedAt: null, outcome: null, createdAt: at('2026-09-23T09:00:00Z'), updatedAt: at('2026-09-23T09:00:00Z'), ...over,
  };
}

function invocation(id: string, over: Row = {}): Row {
  return {
    id, organizationId: ORG, invocationId: `${SENTINEL.invocation}_${id}`, principalUserId: 'user_matt', taskId: TRIAGE_TASK_ID, taskVersion: '2.1.0', profile: 'GENERAL_REASONING',
    providerId: 'anthropic', requestedModelId: 'model-x', servedModel: 'model-x', routingPolicyVersion: '1', providerRequestId: SENTINEL.providerRequest, fellBackFrom: null,
    templateId: 'telegram-triage', templateVersion: '3', contextManifestHash: SENTINEL.manifest, contextSourceCount: 12, estimatedInputTokens: 1500, estimatedOutputTokens: 400,
    inputTokens: 1200, outputTokens: 300, cachedInputTokens: 0, reasoningTokens: null, unitCostBasis: 'v1', estimatedCostMicros: 900, outcome: 'ANSWERED', failureClass: null,
    rejectionCodes: [], attemptCount: 1, requestedAt: at('2026-09-24T11:55:00Z'), completedAt: at('2026-09-24T11:55:03Z'), latencyMs: 3000, businessDate: at('2026-09-24T00:00:00Z'),
    createdAt: at('2026-09-24T11:55:00Z'), updatedAt: at('2026-09-24T11:55:03Z'), brainJobId: null, brainStepKey: null, specializationPolicyVersion: null, ...over,
  };
}

/** A production-shaped world: two Telegram connections, plus rows that must be excluded (Teams, another organization). */
function world(
  rows: Partial<Record<'sourceConnection' | 'sourceObservation' | 'sourceBaselineCheckpoint' | 'sourceContentAuthorization' | 'workItem' | 'aiInvocation', Row[]>> = {},
  options: { readonly hydrationUnmigrated?: boolean } = {},
) {
  const trace: Trace = { selected: new Set(), wheres: [] };
  const tables = {
    organization: [
      { id: ORG, name: SENTINEL.orgName, slug: SLUG, createdAt: at('2026-06-24T00:00:00Z') },
      { id: 'org_other', name: 'Other Co', slug: 'other-org', createdAt: at('2026-06-24T00:00:00Z') },
    ],
    sourceConnection: rows.sourceConnection ?? [
      connection('user_matt'),
      connection('user_charlie', {
        state: 'DISCONNECTED', backgroundObservation: 'UNAVAILABLE', secretSealed: null, keyRef: null, cursor: null, lastFailureClass: 'AUTH',
        connectingStartedAt: at('2026-09-21T09:00:00Z'), connectedAt: at('2026-09-21T09:02:00Z'), lastObservedAt: at('2026-09-21T09:30:00Z'),
        disconnectedAt: at('2026-09-22T08:00:00Z'), disconnectedByUserId: 'user_charlie', createdAt: at('2026-09-21T09:00:00Z'),
      }),
      connection('user_matt', { id: 'conn_matt_teams', provider: 'MICROSOFT_TEAMS', adapter: 'GRAPH', createdAt: at('2026-09-19T00:00:00Z') }),
      connection('user_other', { organizationId: 'org_other', createdAt: at('2026-09-19T00:00:00Z') }),
    ],
    sourceObservation: rows.sourceObservation ?? [
      observation('user_matt', '2026-09-24T11:00:00Z'),
      observation('user_matt', '2026-09-20T12:00:00Z'),
      observation('user_matt', '2026-09-01T00:00:00Z'),
      observation('user_charlie', '2026-09-21T09:00:00Z'),
      observation('user_matt', '2026-09-24T10:00:00Z', { provider: 'MICROSOFT_TEAMS' }),
      observation('user_other', '2026-09-24T10:00:00Z', { organizationId: 'org_other' }),
    ],
    sourceBaselineCheckpoint: rows.sourceBaselineCheckpoint ?? [
      {
        id: 'bl_matt', organizationId: ORG, userId: 'user_matt', provider: 'TELEGRAM', windowDays: 90, windowFloorAt: at('2026-06-22T10:05:00Z'), consentAt: at('2026-09-20T10:06:00Z'),
        state: 'IN_PROGRESS', checkpointCursor: SENTINEL.checkpoint, oldestReachedAt: at('2026-08-15T00:00:00Z'), startedAt: at('2026-09-20T10:10:00Z'), completedAt: null,
        lastRunAt: at('2026-09-24T11:00:00Z'), lastFailureClass: 'FLOOD_WAIT', backoffUntil: at('2026-09-24T12:30:00Z'), revokedAt: null, createdAt: at('2026-09-20T10:06:00Z'),
      },
      {
        id: 'bl_ghost', organizationId: ORG, userId: 'user_ghost', provider: 'TELEGRAM', windowDays: 30, windowFloorAt: at('2026-08-01T00:00:00Z'), consentAt: at('2026-09-01T00:00:00Z'),
        state: 'REVOKED', checkpointCursor: null, oldestReachedAt: null, startedAt: null, completedAt: null, lastRunAt: null, lastFailureClass: null, backoffUntil: null,
        revokedAt: at('2026-09-02T00:00:00Z'), createdAt: at('2026-09-01T00:00:00Z'),
      },
      { id: 'bl_teams', organizationId: ORG, userId: 'user_matt', provider: 'MICROSOFT_TEAMS', windowDays: 30, windowFloorAt: at('2026-08-01T00:00:00Z'), consentAt: at('2026-09-01T00:00:00Z'), state: 'COMPLETE', checkpointCursor: null, createdAt: at('2026-09-01T00:00:00Z') },
    ],
    sourceContentAuthorization: rows.sourceContentAuthorization ?? [
      {
        id: 'ca_matt', organizationId: ORG, userId: 'user_matt', provider: 'TELEGRAM', authorizedAt: at('2026-09-21T08:00:00Z'), revokedAt: null, contentCursor: SENTINEL.contentCursor,
        lastRunAt: at('2026-09-24T11:55:00Z'), lastFailureClass: 'REFUSED_BY_LOOP:BUDGET_GLOBAL_EXHAUSTED', backoffUntil: null, historicalState: 'COMPLETE', historicalCursor: null,
        historicalWindowFloorAt: at('2026-06-22T10:05:00Z'), historicalOldestReachedAt: at('2026-06-23T00:00:00Z'), historicalLastRunAt: at('2026-09-22T00:00:00Z'),
        historicalLastFailureClass: null, historicalBackoffUntil: null, historicalFailedItems: 2, createdAt: at('2026-09-21T08:00:00Z'),
        intelligenceHydrationState: 'COMPLETE', intelligenceHydrationCursor: null, intelligenceHydrationLastRunAt: at('2026-09-25T10:00:00Z'),
        intelligenceHydrationLastFailureClass: null, intelligenceHydrationBackoffUntil: null, intelligenceHydrationFailedItems: 1, intelligenceHydrationSchemaId: 'telegram-content-triage.v4',
      },
      {
        id: 'ca_charlie', organizationId: ORG, userId: 'user_charlie', provider: 'TELEGRAM', authorizedAt: at('2026-09-21T09:10:00Z'), revokedAt: at('2026-09-22T08:00:00Z'), contentCursor: null,
        lastRunAt: at('2026-09-21T10:00:00Z'), lastFailureClass: null, backoffUntil: null, historicalState: 'IN_PROGRESS', historicalCursor: SENTINEL.historicalCursor,
        historicalWindowFloorAt: at('2026-08-22T00:00:00Z'), historicalOldestReachedAt: at('2026-09-10T00:00:00Z'), historicalLastRunAt: at('2026-09-21T10:00:00Z'),
        historicalLastFailureClass: 'TRANSIENT', historicalBackoffUntil: at('2026-09-21T10:05:00Z'), historicalFailedItems: 0, createdAt: at('2026-09-21T09:10:00Z'),
        intelligenceHydrationState: 'IN_PROGRESS', intelligenceHydrationCursor: SENTINEL.hydrationCursor, intelligenceHydrationLastRunAt: at('2026-09-21T10:00:00Z'),
        intelligenceHydrationLastFailureClass: 'HYDRATION_BUDGET_RESERVE', intelligenceHydrationBackoffUntil: null, intelligenceHydrationFailedItems: 0, intelligenceHydrationSchemaId: null,
      },
    ],
    workItem: rows.workItem ?? [
      workItem('wi_1', { firstDetectedAt: at('2026-09-22T09:00:00Z'), lastDetectedAt: at('2026-09-24T11:55:00Z'), detectionCount: 3 }),
      workItem('wi_2'),
      workItem('wi_3', { state: 'RESOLVED', outcome: 'HANDLED', firstDetectedAt: at('2026-09-21T15:00:00Z'), lastDetectedAt: at('2026-09-21T15:00:00Z') }),
      workItem('wi_4', { state: 'DISMISSED', outcome: 'FALSE_POSITIVE' }),
      workItem('wi_5', { state: 'RESOLVED', outcome: 'Handled it myself, thanks' }),
      workItem('wi_rule', { producerKind: 'RULE', producerId: 'unanswered-thread', subjectRef: 'thread:abc', firstDetectedAt: at('2026-09-01T00:00:00Z') }),
      workItem('wi_teams', { subjectRef: 'teams_conversation:xyz', firstDetectedAt: at('2026-09-01T00:00:00Z') }),
      workItem('wi_other', { organizationId: 'org_other', userId: 'user_other', firstDetectedAt: at('2026-09-01T00:00:00Z') }),
    ],
    aiInvocation: rows.aiInvocation ?? [
      invocation('i1'),
      invocation('i2', { requestedAt: at('2026-09-23T10:00:00Z'), inputTokens: null, outputTokens: null, cachedInputTokens: null, estimatedCostMicros: 800 }),
      invocation('i3', { requestedAt: at('2026-09-22T10:00:00Z'), outcome: 'FAILED', failureClass: 'BUDGET_GLOBAL_EXHAUSTED', inputTokens: null, outputTokens: null, cachedInputTokens: null, estimatedCostMicros: 800 }),
      invocation('i4', { requestedAt: at('2026-09-21T10:00:00Z'), outcome: 'REJECTED_BY_LOOP', failureClass: 'BUDGET_GLOBAL_EXHAUSTED', inputTokens: null, outputTokens: null, cachedInputTokens: null, estimatedCostMicros: 800 }),
      invocation('i_old', { requestedAt: at('2026-09-10T10:00:00Z') }),
      invocation('i_case', { taskId: 'case.explanation' }),
      invocation('i_other', { organizationId: 'org_other' }),
    ],
  };
  const fake: Record<string, Record<string, (a?: any) => Promise<unknown>>> = Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name, model(name, rows, trace)]));
  if (options.hydrationUnmigrated) {
    // A database the hydration migration has not reached: any statement naming a hydration column fails P2022.
    const inner = fake.sourceContentAuthorization!;
    fake.sourceContentAuthorization = Object.fromEntries(
      Object.entries(inner).map(([k, fn]) => [
        k,
        async (a?: unknown) => {
          if (JSON.stringify(a ?? {}).includes('intelligenceHydration')) throw Object.assign(new Error('column does not exist'), { code: 'P2022' });
          return fn(a);
        },
      ]),
    );
  }
  const client = readOnlyClient(fake as unknown as PrismaClient);
  const reader = new PrismaTelegramStateReader(client);
  const out: string[] = [];
  return { trace, reader, out, deps: { reader, now: () => NOW, log: (l: string) => void out.push(l) } };
}

const field = (out: string[], event: string, name: string): string | undefined =>
  new RegExp(`(?:^| )${name}=(\\S+)`).exec(out.find((l) => l.startsWith(`event=${event} `)) ?? '')?.[1];

test('flags and environment', () => {
  assert.deepEqual(parseArgs(['--organization', '  servicesinmycity-demo  ']), { organization: 'servicesinmycity-demo' });
  assert.deepEqual(parseArgs(['--org', 'acme']), { organization: 'acme' });
  assert.deepEqual(parseArgs([]), { organization: '' });
  assert.deepEqual(readEnvironment({} as NodeJS.ProcessEnv), { ok: false, missing: ['DATABASE_URL'] });
  assert.deepEqual(readEnvironment({ DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv), { ok: true });
  assert.equal(TRIAGE_TASK_ID, AI_TASK_TELEGRAM_CONTENT_TRIAGE.taskId, 'the task id is the shared definition, never retyped');
  assert.ok(LEDGER_LOOKBACK_DAYS <= 30 && MAX_CONNECTIONS <= 500, 'a commissioning window, not a history dump');
});

test('a malformed or unknown organization is refused before anything is read', async () => {
  const w = world();
  let reads = 0;
  const reader = { organizationBySlug: w.reader.organizationBySlug.bind(w.reader), read: async () => ((reads += 1), ({} as TelegramState)) };
  for (const slug of ['Services In My City', 'no-such-org', '', 'servicesinmycity-demo\nother', 'org;rm']) {
    const out: string[] = [];
    const result = await runTelegramState({ organizationSlug: slug }, { reader, now: () => NOW, log: (l) => void out.push(l) });
    assert.equal(result.overall, 'FAILED_PRECONDITION', JSON.stringify(slug));
    assert.equal(out.length, 1);
    assert.match(out[0]!, /^event=PRECONDITION_FAILED reason=/);
  }
  assert.equal(reads, 0, 'nothing was read');
});

test('every section is printed, with exactly these fields, and connections are #n by createdAt', async () => {
  const w = world();
  const result = await runTelegramState({ organizationSlug: SLUG }, w.deps);
  assert.equal(result.overall, 'READ');
  assert.equal(result.connections, 2);
  const events = w.out.map((l) => /^event=(\S+)/.exec(l)?.[1]);
  assert.deepEqual(events, [
    'ORGANIZATION', 'CONNECTION', 'CONNECTION', 'CONNECTIONS', 'OBSERVATIONS', 'BASELINE', 'BASELINE', 'BASELINES',
    'CONTENT_AUTHORIZATION', 'CONTENT_AUTHORIZATION', 'CONTENT_AUTHORIZATIONS', 'WORK_ITEMS_BY_STATE', 'WORK_ITEMS_BY_OUTCOME', 'WORK_ITEMS',
    'AI_LEDGER_OUTCOME', 'AI_LEDGER_OUTCOME', 'AI_LEDGER_OUTCOME', 'AI_LEDGER_FAILURE', 'AI_LEDGER', 'SUMMARY',
  ]);
  const fields = (event: string) => (w.out.find((l) => l.startsWith(`event=${event} `)) ?? '').split(' ').map((kv) => kv.slice(0, kv.indexOf('=')));
  assert.deepEqual(fields('ORGANIZATION'), ['event', 'organization', 'provider', 'at']);
  assert.deepEqual(fields('CONNECTION'), ['event', 'connection', 'state', 'background', 'credential', 'cursor', 'lastFailure', 'createdAt', 'connectingStartedAt', 'connectedAt', 'lastObservedAt', 'reconnectRequiredAt', 'disconnectedAt', 'observations']);
  assert.deepEqual(fields('BASELINE'), ['event', 'connection', 'state', 'windowDays', 'windowFloorAt', 'consentAt', 'startedAt', 'lastRunAt', 'completedAt', 'oldestReachedAt', 'lastFailure', 'backoffUntil', 'revokedAt', 'checkpoint']);
  assert.deepEqual(fields('CONTENT_AUTHORIZATION'), [
    'event', 'connection', 'authorized', 'authorizedAt', 'revokedAt', 'lastRunAt', 'lastFailure', 'backoffUntil', 'cursor',
    'historicalState', 'historicalWindowFloorAt', 'historicalOldestReachedAt', 'historicalLastRunAt', 'historicalLastFailure', 'historicalBackoffUntil', 'historicalFailedItems', 'historicalCursor',
    'hydrationState', 'hydrationLastRunAt', 'hydrationLastFailure', 'hydrationBackoffUntil', 'hydrationFailedItems', 'hydrationSchema', 'hydrationCursor',
  ]);
  assert.deepEqual(fields('AI_LEDGER_OUTCOME'), ['event', 'outcome', 'count', 'inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningTokens', 'reserveCostMicros']);

  assert.equal(w.out[0], `event=ORGANIZATION organization=${SLUG} provider=TELEGRAM at=2026-09-24T12:00:00.000Z`);
  // #1 is the older connection. Credential and cursor are HELD flags; the Teams row and the other organization's row are not listed.
  assert.equal(w.out[1], 'event=CONNECTION connection=#1 state=READY background=OPERATIONAL credential=true cursor=true lastFailure=- createdAt=2026-09-20T10:00:00.000Z connectingStartedAt=2026-09-20T10:00:00.000Z connectedAt=2026-09-20T10:05:00.000Z lastObservedAt=2026-09-24T11:50:00.000Z reconnectRequiredAt=- disconnectedAt=- observations=3');
  assert.equal(w.out[2], 'event=CONNECTION connection=#2 state=DISCONNECTED background=UNAVAILABLE credential=false cursor=false lastFailure=AUTH createdAt=2026-09-21T09:00:00.000Z connectingStartedAt=2026-09-21T09:00:00.000Z connectedAt=2026-09-21T09:02:00.000Z lastObservedAt=2026-09-21T09:30:00.000Z reconnectRequiredAt=- disconnectedAt=2026-09-22T08:00:00.000Z observations=1');
  assert.ok(w.out.includes('event=CONNECTIONS total=2 live=1 bounded=false'));
  assert.ok(w.out.includes('event=OBSERVATIONS total=4 oldestObservedAt=2026-09-01T00:00:00.000Z newestObservedAt=2026-09-24T11:00:00.000Z last24h=1 last7d=3'));
  assert.ok(w.out.includes('event=BASELINE connection=#1 state=IN_PROGRESS windowDays=90 windowFloorAt=2026-06-22T10:05:00.000Z consentAt=2026-09-20T10:06:00.000Z startedAt=2026-09-20T10:10:00.000Z lastRunAt=2026-09-24T11:00:00.000Z completedAt=- oldestReachedAt=2026-08-15T00:00:00.000Z lastFailure=FLOOD_WAIT backoffUntil=2026-09-24T12:30:00.000Z revokedAt=- checkpoint=true'));
  // A baseline whose holder has no listed connection is UNMATCHED, never identified.
  assert.ok(w.out.includes('event=BASELINE connection=UNMATCHED state=REVOKED windowDays=30 windowFloorAt=2026-08-01T00:00:00.000Z consentAt=2026-09-01T00:00:00.000Z startedAt=- lastRunAt=- completedAt=- oldestReachedAt=- lastFailure=- backoffUntil=- revokedAt=2026-09-02T00:00:00.000Z checkpoint=false'));
  assert.ok(w.out.includes('event=BASELINES total=2 unmatched=1'));
  assert.ok(w.out.includes('event=CONTENT_AUTHORIZATION connection=#1 authorized=true authorizedAt=2026-09-21T08:00:00.000Z revokedAt=- lastRunAt=2026-09-24T11:55:00.000Z lastFailure=REFUSED_BY_LOOP:BUDGET_GLOBAL_EXHAUSTED backoffUntil=- cursor=true historicalState=COMPLETE historicalWindowFloorAt=2026-06-22T10:05:00.000Z historicalOldestReachedAt=2026-06-23T00:00:00.000Z historicalLastRunAt=2026-09-22T00:00:00.000Z historicalLastFailure=- historicalBackoffUntil=- historicalFailedItems=2 historicalCursor=false hydrationState=COMPLETE hydrationLastRunAt=2026-09-25T10:00:00.000Z hydrationLastFailure=- hydrationBackoffUntil=- hydrationFailedItems=1 hydrationSchema=telegram-content-triage.v4 hydrationCursor=false'));
  assert.ok(w.out.includes('event=CONTENT_AUTHORIZATION connection=#2 authorized=false authorizedAt=2026-09-21T09:10:00.000Z revokedAt=2026-09-22T08:00:00.000Z lastRunAt=2026-09-21T10:00:00.000Z lastFailure=- backoffUntil=- cursor=false historicalState=IN_PROGRESS historicalWindowFloorAt=2026-08-22T00:00:00.000Z historicalOldestReachedAt=2026-09-10T00:00:00.000Z historicalLastRunAt=2026-09-21T10:00:00.000Z historicalLastFailure=TRANSIENT historicalBackoffUntil=2026-09-21T10:05:00.000Z historicalFailedItems=0 historicalCursor=true hydrationState=IN_PROGRESS hydrationLastRunAt=2026-09-21T10:00:00.000Z hydrationLastFailure=HYDRATION_BUDGET_RESERVE hydrationBackoffUntil=- hydrationFailedItems=0 hydrationSchema=- hydrationCursor=true'));
  assert.ok(w.out.includes('event=CONTENT_AUTHORIZATIONS total=2 authorized=1 revoked=1 unmatched=0'));
  // Work items: the shared closed vocabularies as columns (every member, zero included); a free-text
  // outcome is counted as `other`, never printed; an open item's missing outcome is `none`.
  const columns = (vocabulary: readonly string[], counts: Record<string, number>) => vocabulary.map((v) => `${v}=${counts[v] ?? 0}`).join(' ');
  assert.ok(w.out.includes(`event=WORK_ITEMS_BY_STATE ${columns(WORK_ITEM_STATES, { OPEN: 2, RESOLVED: 2, DISMISSED: 1 })} other=0`));
  assert.ok(w.out.includes(`event=WORK_ITEMS_BY_OUTCOME ${columns(WORK_ITEM_OUTCOMES, { HANDLED: 1, FALSE_POSITIVE: 1 })} none=2 other=1`));
  assert.ok(w.out.includes('event=WORK_ITEMS total=5 oldestFirstDetectedAt=2026-09-21T15:00:00.000Z newestLastDetectedAt=2026-09-24T11:55:00.000Z'));
  // The ledger: seven days, this task, this organization. Provider-reported usage is summed; NULL stays NULL, never zero.
  assert.ok(w.out.includes('event=AI_LEDGER_OUTCOME outcome=ANSWERED count=2 inputTokens=1200 outputTokens=300 cachedInputTokens=0 reasoningTokens=- reserveCostMicros=1700'));
  assert.ok(w.out.includes('event=AI_LEDGER_OUTCOME outcome=FAILED count=1 inputTokens=- outputTokens=- cachedInputTokens=- reasoningTokens=- reserveCostMicros=800'));
  assert.ok(w.out.includes('event=AI_LEDGER_OUTCOME outcome=REJECTED_BY_LOOP count=1 inputTokens=- outputTokens=- cachedInputTokens=- reasoningTokens=- reserveCostMicros=800'));
  assert.ok(w.out.includes('event=AI_LEDGER_FAILURE class=BUDGET_GLOBAL_EXHAUSTED count=2'));
  assert.ok(w.out.includes(`event=AI_LEDGER task=${TRIAGE_TASK_ID} since=2026-09-17T12:00:00.000Z total=4 answeredWithoutUsage=1`));
  assert.equal(w.out.at(-1), 'event=SUMMARY connections=2 live=1 observations=4 baselines=2 contentAuthorized=1 workItems=5 ledgerInvocations=4 OVERALL_RESULT=READ');
});

test('an organization with nothing is an answer, and more connections than the bound is said, not hidden', async () => {
  const empty = world({ sourceConnection: [], sourceObservation: [], sourceBaselineCheckpoint: [], sourceContentAuthorization: [], workItem: [], aiInvocation: [] });
  assert.equal((await runTelegramState({ organizationSlug: SLUG }, empty.deps)).overall, 'READ');
  assert.ok(empty.out.includes('event=CONNECTIONS total=0 live=0 bounded=false'));
  assert.ok(empty.out.includes('event=OBSERVATIONS total=0 oldestObservedAt=- newestObservedAt=- last24h=0 last7d=0'));
  assert.ok(empty.out.includes('event=WORK_ITEMS total=0 oldestFirstDetectedAt=- newestLastDetectedAt=-'));
  assert.ok(empty.out.includes(`event=AI_LEDGER task=${TRIAGE_TASK_ID} since=2026-09-17T12:00:00.000Z total=0 answeredWithoutUsage=0`));
  assert.equal(empty.out.at(-1), 'event=SUMMARY connections=0 live=0 observations=0 baselines=0 contentAuthorized=0 workItems=0 ledgerInvocations=0 OVERALL_RESULT=READ');

  const many = world({ sourceConnection: Array.from({ length: MAX_CONNECTIONS + 1 }, (_, i) => connection(`user_${i}`, { createdAt: new Date(NOW.getTime() - (MAX_CONNECTIONS + 1 - i) * 60_000) })) });
  const result = await runTelegramState({ organizationSlug: SLUG }, many.deps);
  assert.equal(result.connections, MAX_CONNECTIONS);
  assert.ok(many.out.includes(`event=CONNECTIONS total=${MAX_CONNECTIONS} live=${MAX_CONNECTIONS} bounded=true`));
});

test('nothing private or identifying is printed: no label, key, cursor, secret, body, name, email, phone, user or organization id', async () => {
  const w = world();
  await runTelegramState({ organizationSlug: SLUG }, w.deps);
  const text = w.out.join('\n');
  for (const secret of [...Object.values(SENTINEL), 'SENTINEL', 'user_matt', 'user_charlie', 'user_ghost', 'user_other', 'conn_', 'obs_', 'wi_', 'bl_', 'ca_', 'i1', ORG, 'org_other', 'other-org', '@', 'Handled it myself']) {
    assert.equal(text.includes(secret), false, `${secret} must not be printed`);
  }
});

test('the reader never selects a content-bearing, secret or identifying column, and every query is scoped to the organization', async () => {
  const w = world();
  await runTelegramState({ organizationSlug: SLUG }, w.deps);
  // The HELD flags come from scoped `not null` filters: the sealed secret and the cursors are never read into memory.
  for (const column of [
    'sourceConnection.secretSealed', 'sourceConnection.cursor', 'sourceConnection.accountLabel', 'sourceConnection.keyRef', 'sourceConnection.id', 'sourceConnection.disconnectedByUserId',
    'sourceBaselineCheckpoint.checkpointCursor', 'sourceBaselineCheckpoint.id',
    'sourceContentAuthorization.contentCursor', 'sourceContentAuthorization.historicalCursor', 'sourceContentAuthorization.intelligenceHydrationCursor', 'sourceContentAuthorization.id',
    'organization.name',
  ]) {
    assert.equal(w.trace.selected.has(column), false, `${column} is never selected`);
  }
  // Observations, work items and the ledger are read as counts and aggregates only: no row, no id, no text.
  const selected = [...w.trace.selected];
  assert.deepEqual(selected.filter((c) => c.startsWith('sourceObservation.')), ['sourceObservation.observedAt']);
  assert.deepEqual(selected.filter((c) => c.startsWith('workItem.')).sort(), ['workItem.firstDetectedAt', 'workItem.lastDetectedAt']);
  assert.deepEqual(selected.filter((c) => c.startsWith('aiInvocation.')).sort(), ['aiInvocation.cachedInputTokens', 'aiInvocation.estimatedCostMicros', 'aiInvocation.inputTokens', 'aiInvocation.outputTokens', 'aiInvocation.reasoningTokens']);
  // Every query names the organization; the source tables name the provider too.
  const scoped = w.trace.wheres.filter((q) => q.__model !== 'organization');
  assert.ok(scoped.length >= 20);
  for (const q of scoped) {
    assert.equal(q.organizationId, ORG, `${String(q.__model)} query is organization-scoped`);
    if (String(q.__model).startsWith('source')) assert.equal(q.provider, 'TELEGRAM', `${String(q.__model)} query is provider-scoped`);
  }
  for (const q of w.trace.wheres.filter((q) => q.__model === 'workItem')) {
    assert.equal(q.producerKind, 'MODEL');
    assert.deepEqual(q.subjectRef, { startsWith: TELEGRAM_SUBJECT_REF_PREFIX });
  }
  for (const q of w.trace.wheres.filter((q) => q.__model === 'aiInvocation')) {
    assert.equal(q.taskId, TRIAGE_TASK_ID);
    assert.deepEqual(q.requestedAt, { gte: new Date(NOW.getTime() - LEDGER_LOOKBACK_DAYS * 86_400_000) });
  }
});

test('the runner has no write path, names no content column, and production runs the reader on a read-only client', () => {
  const code = readFileSync(join(__dirname, 'read-telegram-state.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  for (const forbidden of ['.create(', '.update(', '.upsert(', '.delete(', 'createMany(', 'updateMany(', 'deleteMany(', '$executeRaw', '$queryRaw', '$transaction', 'fetch(', 'writeFile']) {
    assert.equal(code.includes(forbidden), false, `${forbidden} has no place in a read-only diagnosis`);
  }
  for (const column of [
    'secretSealed: true', 'cursor: true', 'checkpointCursor: true', 'contentCursor: true', 'historicalCursor: true', 'intelligenceHydrationCursor: true', 'accountLabel', 'keyRef', 'sealVersion',
    'conversationKey', 'providerEventId', 'senderKey', 'participantKeys', 'title: true', 'evidence', 'recurrenceKey', 'name: true', 'email', 'phone',
    'principalUserId', 'invocationId', 'contextManifestHash', 'providerRequestId', 'disconnectedByUserId', 'employeeRef',
  ]) {
    assert.equal(code.includes(column), false, `the runner never names ${column}`);
  }
  assert.match(code, /new PrismaTelegramStateReader\(readOnlyClient\(prisma\)\)/, 'production wiring wraps the client');
  // Every `where` in the reader is one of the scoped shapes, or the slug lookup.
  const wheres = [...code.matchAll(/where: ([^\n]+?)(?:,\s*(?:orderBy|select|take|_count|_min|_max|_sum)|\s*\}\))/g)].map((m) => m[1]!);
  assert.ok(wheres.length >= 15, `found ${wheres.length} queries`);
  for (const w of wheres) assert.match(w, /^(scope|itemScope|ledgerScope|\{ \.\.\.(scope|itemScope|ledgerScope)\b|\{ slug \})/, `scoped: where: ${w}`);
  assert.equal(code.includes('DATABASE_URL'), true);
  assert.equal(code.includes("reason: 'UNEXPECTED'"), true, 'an unexpected failure prints a class, never a message that could carry a connection string');
});

test('the subject prefix and producer kind are the ones the worker records', () => {
  // One shared constant: the probe reads it, the worker builds every subjectRef from it.
  assert.equal(TELEGRAM_SUBJECT_REF_PREFIX, DERIVED_WORK_SUBJECT_PREFIXES.TELEGRAM);
  assert.equal(telegramConversationSubjectRef('k'), `${TELEGRAM_SUBJECT_REF_PREFIX}k`);
  const worker = readFileSync(join(__dirname, '..', '..', 'apps', 'connections-worker', 'src', 'content-orchestrator.ts'), 'utf8');
  assert.ok(worker.includes('subjectRef: telegramConversationSubjectRef(conversationKey)'), 'the worker derives subjectRef from the shared helper');
  assert.ok(!worker.includes("'telegram_conversation:'"), 'the worker holds no literal of its own');
  assert.ok(worker.includes("producerKind: 'MODEL'"));
});

// --- The workflow, and its input step executed ------------------------------------------------

const WORKFLOW = readFileSync(join(__dirname, '..', '..', '.github', 'workflows', 'read-telegram-state.yml'), 'utf8');

/** The `run: |` body of the named step, dedented. */
function stepScript(name: string): string {
  const lines = WORKFLOW.split('\n');
  const at = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  assert.ok(at >= 0, `the workflow has a step named ${name}`);
  const run = lines.findIndex((l, i) => i > at && l.trim() === 'run: |');
  const indent = lines[run]!.search(/\S/) + 2;
  const body: string[] = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim() !== '' && line.search(/\S/) < indent) break;
    body.push(line.slice(indent));
  }
  return body.join('\n');
}

function runStep(name: string, env: Record<string, string>): { code: number; stdout: string; written: string } {
  const dir = mkdtempSync(join(tmpdir(), 'rts-input-'));
  const output = join(dir, 'output');
  writeFileSync(output, '');
  // The same shell GitHub uses for `shell: bash`.
  const run = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', stepScript(name)], {
    env: { PATH: process.env.PATH ?? '', GITHUB_OUTPUT: output, ...env },
    encoding: 'utf8',
  });
  const written = readFileSync(output, 'utf8');
  rmSync(dir, { recursive: true, force: true });
  return { code: run.status ?? -1, stdout: run.stdout, written };
}

const validate = (value: string) => {
  const r = runStep('Validate the requested input', { ORG_SLUG: value });
  return { code: r.code, slug: /^slug=(.*)$/m.exec(r.written)?.[1] ?? null, stdout: r.stdout };
};

test('the workflow is human-started only, proves safety before reading, and interpolates no input', () => {
  assert.match(WORKFLOW, /\non:\n  workflow_dispatch:\n/);
  for (const trigger of ['\n  schedule:', '\n  push:', '\n  pull_request:', '\n  workflow_call:']) {
    assert.equal(WORKFLOW.includes(trigger), false, `no ${trigger.trim()}`);
  }
  assert.match(WORKFLOW, /\npermissions:\n  contents: read\n/);
  const proof = WORKFLOW.indexOf('npm run test:operations');
  const read = WORKFLOW.indexOf('npm run read:telegram-state -- --organization "${ORG_SLUG}"');
  assert.ok(proof > 0 && proof < read, 'the safety proof runs before the read');
  for (const forbidden of ['migrate deploy', 'db push', '--apply', 'OUTBOX_DRAIN', 'INTELLIGENCE_DETECT', 'CONNECTIONS_', 'TELEGRAM_API']) assert.equal(WORKFLOW.includes(forbidden), false, forbidden);
  for (const body of WORKFLOW.split(/\n\s+run: \|/).slice(1)) {
    const step = body.split(/\n\s+- name:/)[0] ?? '';
    assert.equal(/\$\{\{\s*inputs\./.test(step), false, 'no input interpolated into a run body');
    assert.equal(/\$\{\{\s*secrets\./.test(step), false, 'no secret interpolated into a run body');
  }
});

test('the database credential is checked by name and never printed, and the Read step is the only one that holds it', () => {
  const missing = runStep('Fail closed when the database credential is missing', {});
  assert.notEqual(missing.code, 0);
  assert.match(missing.stdout, /::error::Missing repository secret: DIRECT_DATABASE_URL/);
  const present = runStep('Fail closed when the database credential is missing', { DATABASE_URL: 'postgres://user:hunter2@db.example/loop' });
  assert.equal(present.code, 0);
  assert.equal(present.stdout.includes('hunter2'), false, 'the value is never echoed');
  assert.equal(present.stdout.includes('postgres://'), false);
  const holders = WORKFLOW.split(/\n\s+- name: /).slice(1).filter((s) => s.includes('secrets.DIRECT_DATABASE_URL')).map((s) => s.split('\n')[0]);
  assert.deepEqual(holders, ['Fail closed when the database credential is missing', 'Read']);
});

test('a valid slug with whitespace around it is trimmed, validated and passed on, as in Read Employee Sources (#303)', () => {
  for (const input of ['servicesinmycity-demo', '    servicesinmycity-demo', 'servicesinmycity-demo   ', '\tservicesinmycity-demo\n', ' \t servicesinmycity-demo \r\n']) {
    const result = validate(input);
    assert.equal(result.code, 0, JSON.stringify(input));
    assert.equal(result.slug, 'servicesinmycity-demo', `${JSON.stringify(input)} passes on the trimmed slug`);
    assert.match(result.stdout, /Validated organization servicesinmycity-demo\./);
  }
});

test('whitespace is only trimmed, never repaired: anything that is not one valid slug is still refused', () => {
  for (const input of ['', '   ', 'services inmycity-demo', 'servicesinmycity-demo\nother-org', 'Servicesinmycity-Demo', '-leading-hyphen', 'org;rm', '$(id)', 'a'.repeat(64)]) {
    const result = validate(input);
    assert.notEqual(result.code, 0, `${JSON.stringify(input)} must be refused`);
    assert.equal(result.slug, null, 'nothing is passed on');
  }
});

test('the read step uses the validated slug, never the raw input, and runs the script with tsx', () => {
  const read = WORKFLOW.slice(WORKFLOW.indexOf('- name: Read\n'), WORKFLOW.indexOf('- name: How to read the output'));
  assert.match(read, /ORG_SLUG: \$\{\{ steps\.input\.outputs\.slug \}\}/);
  assert.equal(read.includes('inputs.organization_slug'), false);
  assert.match(read, /npm run read:telegram-state -- --organization "\$\{ORG_SLUG\}"/);
  const summary = WORKFLOW.slice(WORKFLOW.indexOf('- name: How to read the output'));
  assert.match(summary, /if: always\(\)/);
  assert.match(summary, /\$GITHUB_STEP_SUMMARY/);
  assert.match(summary, /Nothing was written/);
});

test('before the hydration migration the probe still reads everything else, and says hydrationState=NOT_MIGRATED', async () => {
  const w = world({}, { hydrationUnmigrated: true });
  const result = await runTelegramState({ organizationSlug: SLUG }, w.deps);
  assert.equal(result.overall, 'READ');
  const auth = w.out.filter((l) => l.startsWith('event=CONTENT_AUTHORIZATION '));
  assert.equal(auth.length, 2);
  for (const l of auth) {
    assert.ok(l.includes('hydrationState=NOT_MIGRATED hydrationLastRunAt=- hydrationLastFailure=- hydrationBackoffUntil=- hydrationFailedItems=- hydrationSchema=- hydrationCursor=false'), l);
    assert.ok(l.includes('historicalState='), 'the pre-existing fields are all still there');
  }
});
