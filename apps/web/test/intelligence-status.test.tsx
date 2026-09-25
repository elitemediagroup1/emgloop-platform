// Intelligence execution status (/app/admin/intelligence-status), 2026-09-24.
//
// A read-only page for an operator who may open the Executive Brain. These tests trace every
// Prisma argument the loader passes through a recording fake and prove:
//   - the guard runs before any read (ADMIN workspace, then intelligence:view);
//   - the ledger reads name only aggregate-safe columns -- never the principal, an invocation or
//     provider request id, the context hash, a template or a Brain job -- and are scoped to the
//     session organization; the principal appears only as a filter, and only as the viewer;
//   - digest metadata is the viewer's own and stripped to the allowlist; organization digest
//     figures are counts; a read the digest authority does not expose is "not exposed", and the
//     content-returning read is never used;
//   - a failed read is "could not read", never "no runs"; a figure no run reported is words, not 0.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { createTimeView } from '@emgloop/shared';
import { loadIntelligenceStatus, type DigestReader, type LedgerDb, type StatusDeps } from '../src/app/app/admin/intelligence-status/status-data';
import { IntelligenceStatusView } from '../src/app/app/admin/intelligence-status/status-view';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
const code = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

const ORG = 'org_a';
const VIEWER = 'u_viewer';
const NOW = new Date('2026-09-24T15:00:00Z');
const time = createTimeView({ timeZone: 'America/New_York', source: 'device' }, NOW);
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000);

/** Every column the loader may name anywhere in a ledger read. */
const ALLOWED_COLUMNS = new Set(['taskId', 'outcome', 'failureClass', 'providerId', 'requestedModelId', 'servedModel', 'requestedAt', 'latencyMs', 'inputTokens', 'outputTokens', 'estimatedCostMicros', '_all']);
const FORBIDDEN_COLUMNS = ['principalUserId', 'invocationId', 'providerRequestId', 'contextManifestHash', 'contextSourceCount', 'templateId', 'templateVersion', 'brainJobId', 'brainStepKey', 'rejectionCodes', 'businessDate', 'id'];

type Call = { method: 'groupBy' | 'findMany'; args: any };

function recordingLedger(opts: { fail?: boolean } = {}) {
  const calls: Call[] = [];
  const week = [
    { taskId: 'telegram.content.triage', outcome: 'ANSWERED', failureClass: null, _count: { _all: 5, inputTokens: 5, outputTokens: 5, estimatedCostMicros: 5 }, _sum: { inputTokens: 5000, outputTokens: 800, estimatedCostMicros: 12_500 }, _max: { requestedAt: hoursAgo(2) } },
    { taskId: 'telegram.content.triage', outcome: 'FAILED', failureClass: 'TRANSIENT', _count: { _all: 2, inputTokens: 0, outputTokens: 0, estimatedCostMicros: 2 }, _sum: { inputTokens: null, outputTokens: null, estimatedCostMicros: 5000 }, _max: { requestedAt: hoursAgo(30) } },
    // A task whose runs reported nothing at all: tokens and cost must read "not recorded", never 0.
    { taskId: 'mail.reply.draft', outcome: 'ANSWERED', failureClass: null, _count: { _all: 1, inputTokens: 0, outputTokens: 0, estimatedCostMicros: 0 }, _sum: { inputTokens: null, outputTokens: null, estimatedCostMicros: null }, _max: { requestedAt: hoursAgo(50) } },
  ];
  const day = [week[0]];
  const ledger = {
    aiInvocation: {
      async groupBy(args: any) {
        calls.push({ method: 'groupBy', args });
        if (opts.fail) throw new Error('relation "ai_invocations" does not exist');
        if (args.by.includes('providerId')) {
          return [
            { taskId: 'telegram.content.triage', providerId: 'openai', requestedModelId: 'model-a', servedModel: 'model-a-2026', _max: { requestedAt: hoursAgo(2) } },
            { taskId: 'telegram.content.triage', providerId: 'anthropic', requestedModelId: 'model-b', servedModel: null, _max: { requestedAt: hoursAgo(40) } },
          ];
        }
        if (args.where.principalUserId) return [{ taskId: 'telegram.content.triage', _count: { _all: 3 }, _max: { requestedAt: hoursAgo(2) } }];
        const since: Date = args.where.requestedAt.gte;
        return NOW.getTime() - since.getTime() <= 24 * 3600_000 ? day : week;
      },
      async findMany(args: any) {
        calls.push({ method: 'findMany', args });
        if (opts.fail) throw new Error('relation "ai_invocations" does not exist');
        return [
          { taskId: 'telegram.content.triage', latencyMs: 900, requestedAt: hoursAgo(2) },
          { taskId: 'telegram.content.triage', latencyMs: 1100, requestedAt: hoursAgo(3) },
          { taskId: 'telegram.content.triage', latencyMs: 5000, requestedAt: hoursAgo(40) },
        ];
      },
    },
  };
  return { ledger: ledger as unknown as LedgerDb, calls };
}

function columnsNamed(args: any): string[] {
  const out: string[] = [...(args.by ?? [])];
  for (const key of ['select', '_count', '_sum', '_max', '_min', '_avg', 'orderBy']) {
    const v = args[key];
    if (!v) continue;
    for (const entry of Array.isArray(v) ? v : [v]) out.push(...Object.keys(entry));
  }
  return out;
}

function deps(over: Partial<StatusDeps> & { failLedger?: boolean } = {}): { deps: StatusDeps; calls: Call[] } {
  const { ledger, calls } = recordingLedger({ fail: over.failLedger });
  return {
    calls,
    deps: {
      ledger: over.ledger ?? ledger,
      providerPolicies: over.providerPolicies ?? (async () => [{ providerId: 'openai', state: 'ACTIVE', ceiling: 'COMMUNICATION_CONTENT', version: 2, recordedAtMs: hoursAgo(100).getTime() }]),
      digests: over.digests ?? {},
    },
  };
}

const SESSION = { organizationId: ORG, userId: VIEWER };

describe('the page is guarded and calls no model', () => {
  it('ADMIN authority, then intelligence:view, then the read; nothing reaches a provider', () => {
    const page = code(read('app/app/admin/intelligence-status/page.tsx'));
    const a = page.indexOf("await requireWorkspace('ADMIN')");
    const b = page.indexOf("await requirePermission('intelligence', 'view')");
    const c = page.indexOf('loadIntelligenceStatus(session, time.now)');
    assert.ok(a > -1 && b > a && c > b);
    const data = code(read('app/app/admin/intelligence-status/status-data.ts'));
    assert.match(data, /^import 'server-only';/m);
    for (const forbidden of ['@emgloop/providers', 'AiRuntimeGateway', 'caseExplanation', 'mailReplyDraft', 'fetch(', 'process.env', 'forDomain', '.current(', 'searchParams', 'formData']) {
      assert.equal(data.includes(forbidden), false, forbidden);
    }
  });
});

describe('the ledger reads are aggregates over allowlisted columns, in the session organization', () => {
  it('every argument names only allowed columns; the principal is only ever the viewer, only as a filter', async () => {
    const { deps: d, calls } = deps();
    await loadIntelligenceStatus(SESSION, NOW, d);
    assert.ok(calls.length >= 5);
    for (const call of calls) {
      assert.equal(call.args.where.organizationId, ORG, 'scoped to the session organization');
      for (const col of columnsNamed(call.args)) {
        assert.ok(ALLOWED_COLUMNS.has(col), `${call.method} names ${col}`);
        assert.equal(FORBIDDEN_COLUMNS.includes(col), false, col);
      }
      if ('principalUserId' in call.args.where) assert.equal(call.args.where.principalUserId, VIEWER, 'only the viewer’s own runs are filtered by person');
      if (call.method === 'findMany') {
        assert.ok(call.args.select, 'a row read always names its columns');
        assert.ok(call.args.take > 0 && call.args.take <= 2000, 'bounded');
      }
    }
    const byPerson = calls.filter((c) => 'principalUserId' in c.args.where);
    assert.equal(byPerson.length, 2, 'the viewer’s own 24h and 7d counts, and nothing else by person');
    for (const c of byPerson) assert.deepEqual(c.args.by, ['taskId']);
  });

  it('the projection: runs, answered, not answered by class, latest route, median latency, tokens and the reserve estimate; yours apart', async () => {
    const { deps: d } = deps();
    const status = await loadIntelligenceStatus(SESSION, NOW, d);
    assert.equal(status.tasks.state, 'READ');
    if (status.tasks.state !== 'READ') return;
    const triage = status.tasks.value.rows.find((r) => r.taskId === 'telegram.content.triage')!;
    assert.equal(triage.windows['7d'].runs, 7);
    assert.equal(triage.windows['7d'].answered, 5);
    assert.deepEqual(triage.windows['7d'].notAnswered, [{ reason: 'TRANSIENT', runs: 2 }]);
    assert.equal(triage.windows['24h'].runs, 5);
    assert.deepEqual(triage.latestRoute, { providerId: 'openai', model: 'model-a', servedModel: 'model-a-2026' });
    assert.equal(triage.windows['24h'].medianLatencyMs, 1000);
    assert.equal(triage.windows['7d'].medianLatencyMs, 1100);
    assert.deepEqual(triage.windows['7d'].tokens, { input: 5000, output: 800, reported: 5 });
    assert.deepEqual(triage.windows['7d'].reservedCostMicros, { total: 17_500, recorded: 7 });
    assert.equal(triage.windows['7d'].yours, 3);
    const draft = status.tasks.value.rows.find((r) => r.taskId === 'mail.reply.draft')!;
    assert.equal(draft.windows['7d'].tokens, null, 'nothing reported is not zero');
    assert.equal(draft.windows['7d'].reservedCostMicros, null);
    const caseExplanation = status.tasks.value.rows.find((r) => r.taskId === 'case.explanation')!;
    assert.equal(caseExplanation.windows['7d'].runs, 0, 'a governed task with no rows has no runs');

    const html = renderToStaticMarkup(<IntelligenceStatusView status={status} time={time} />);
    assert.match(html, /data-status-task="mail.reply.draft"[\s\S]*?Not recorded[\s\S]*?Not recorded/);
    assert.match(html, /\$0\.02[\s\S]*?not the cost of record/);
    assert.match(html, /data-status-task="case.explanation"[\s\S]*?No runs/);
    assert.match(html, /Not answered: TRANSIENT 2/);
    assert.match(html, /3 in 7 days/);
    for (const leaked of [VIEWER, 'u_other', 'invocationId', 'providerRequestId']) assert.equal(html.toLowerCase().includes(leaked.toLowerCase()), false, leaked);
  });

  it('a failed ledger read is "could not read", never "no runs"', async () => {
    const { deps: d } = deps({ failLedger: true });
    const status = await loadIntelligenceStatus(SESSION, NOW, d);
    assert.equal(status.tasks.state, 'UNAVAILABLE');
    const html = renderToStaticMarkup(<IntelligenceStatusView status={status} time={time} />);
    assert.match(html, /Loop could not read the AI usage ledger just now/);
    assert.equal(html.includes('No runs'), false);
    assert.equal(status.providers.state, 'READ', 'the other sections fail on their own');
  });
});

describe('provider policies', () => {
  it('every provider is listed; one with no recorded policy says so; a failed read says so', async () => {
    const { deps: d } = deps();
    const status = await loadIntelligenceStatus(SESSION, NOW, d);
    assert.equal(status.providers.state, 'READ');
    if (status.providers.state !== 'READ') return;
    const byId = new Map(status.providers.value.map((p) => [p.providerId, p]));
    assert.equal(byId.get('openai')?.state, 'ACTIVE');
    assert.equal(byId.get('openai')?.ceiling, 'COMMUNICATION_CONTENT');
    assert.equal(byId.get('anthropic')?.state, 'NOT_RECORDED');
    const html = renderToStaticMarkup(<IntelligenceStatusView status={status} time={time} />);
    assert.match(html, /data-status-provider="anthropic"[\s\S]*?No policy recorded[\s\S]*?Loop sends this provider nothing/);
    const failed = await loadIntelligenceStatus(SESSION, NOW, deps({ providerPolicies: async () => { throw new Error('x'); } }).deps);
    assert.equal(failed.providers.state, 'UNAVAILABLE');
  });
});

describe('digests: the viewer’s own metadata, organization counts, never content', () => {
  it('with no metadata-only read exposed, nothing is read and the page says so -- the content read is never used', async () => {
    let contentReads = 0;
    const repoToday = { forDomain: async () => { contentReads += 1; return []; }, current: async () => { contentReads += 1; return null; } } as unknown as DigestReader;
    const status = await loadIntelligenceStatus(SESSION, NOW, deps({ digests: repoToday }).deps);
    assert.equal(status.yourDigests.state, 'NOT_EXPOSED');
    assert.equal(status.organizationDigests.state, 'NOT_EXPOSED');
    assert.equal(contentReads, 0);
    const html = renderToStaticMarkup(<IntelligenceStatusView status={status} time={time} />);
    assert.match(html, /No read of your digests is available to this page yet/);
    assert.equal(html.includes('No digests for you yet'), false, 'not exposed is not "none"');
  });

  it('when exposed: the viewer’s own rows only, stripped to metadata; organization figures are counts', async () => {
    const asked: unknown[] = [];
    const reader: DigestReader = {
      async metadataFor(principal) {
        asked.push(principal);
        return [
          {
            domain: 'CHATS', subjectKind: 'DOMAIN', coverage: 'CONNECTED_SUFFICIENT', status: 'CURRENT', generatedAt: hoursAgo(1), windowEnd: hoursAgo(1), evidenceCount: 12, version: 3, expiresAt: hoursAgo(-700),
            // Whatever else a reader hands back must not survive the projection.
            content: { summary: 'SECRET-CONTENT' }, subjectRef: 'conv:SECRET-KEY', provenance: { sourceRefs: ['SECRET-REF'] }, provider: 'TELEGRAM', userId: 'u_other',
          },
        ];
      },
      async organizationCounts(organizationId) {
        asked.push(organizationId);
        return [{ domain: 'CHATS', status: 'CURRENT', coverage: 'CONNECTED_PARTIAL', count: 4, userId: 'u_other' }];
      },
    };
    const status = await loadIntelligenceStatus(SESSION, NOW, deps({ digests: reader }).deps);
    assert.deepEqual(asked, [{ organizationId: ORG, userId: VIEWER }, ORG], 'the viewer from the session, and the organization from the session');
    assert.equal(status.yourDigests.state, 'READ');
    if (status.yourDigests.state !== 'READ' || status.organizationDigests.state !== 'READ') return;
    assert.deepEqual(Object.keys(status.yourDigests.value[0]!).sort(), ['coverage', 'domain', 'evidenceCount', 'expiresAt', 'generatedAt', 'status', 'subjectKind', 'version', 'windowEnd']);
    assert.deepEqual(Object.keys(status.organizationDigests.value[0]!).sort(), ['count', 'coverage', 'domain', 'status']);
    const html = renderToStaticMarkup(<IntelligenceStatusView status={status} time={time} />);
    for (const secret of ['SECRET-CONTENT', 'SECRET-KEY', 'SECRET-REF', 'TELEGRAM', 'u_other']) assert.equal(html.includes(secret), false, secret);
    assert.match(html, /data-status-digest="CHATS"/);
    assert.match(html, /data-status-digest-count="CHATS"[\s\S]*?>4</);
  });

  it('renders the viewer’s per-conversation CHATS digests the Chats producer writes, as metadata only', async () => {
    const row = (subjectRef: string, coverage: string, status: string) => ({
      domain: 'CHATS', subjectKind: 'CONVERSATION', coverage, status, generatedAt: hoursAgo(2), windowEnd: hoursAgo(2), evidenceCount: 7, version: 2, expiresAt: hoursAgo(-600),
      content: { relevance: 'BUSINESS', synthesis: 'SECRET-SYNTHESIS' }, subjectRef, provider: 'TELEGRAM',
    });
    const reader: DigestReader = {
      async metadataFor() {
        return [row('telegram_conversation:SECRET-CK1', 'CONNECTED_SUFFICIENT', 'CURRENT'), row('telegram_conversation:SECRET-CK2', 'CONNECTED_PARTIAL', 'STALE')];
      },
      async organizationCounts() {
        return [{ domain: 'CHATS', status: 'CURRENT', coverage: 'CONNECTED_SUFFICIENT', count: 2 }];
      },
    };
    const status = await loadIntelligenceStatus(SESSION, NOW, deps({ digests: reader }).deps);
    const html = renderToStaticMarkup(<IntelligenceStatusView status={status} time={time} />);
    assert.equal((html.match(/data-status-digest="CHATS"/g) ?? []).length, 2);
    assert.match(html, /data-status-digest="CHATS"[\s\S]*?CHATS<\/span> · CONVERSATION[\s\S]*?Up to date/);
    assert.match(html, /data-status-digest="CHATS"[\s\S]*?Partly read[\s\S]*?STALE/);
    for (const secret of ['SECRET-SYNTHESIS', 'SECRET-CK1', 'SECRET-CK2', 'TELEGRAM']) assert.equal(html.includes(secret), false, secret);
  });

  it('an exposed read that returns nothing is empty; one that fails is "could not read"', async () => {
    const empty = await loadIntelligenceStatus(SESSION, NOW, deps({ digests: { metadataFor: async () => [], organizationCounts: async () => [] } }).deps);
    const html = renderToStaticMarkup(<IntelligenceStatusView status={empty} time={time} />);
    assert.match(html, /No digests for you yet/);
    const failed = await loadIntelligenceStatus(SESSION, NOW, deps({ digests: { metadataFor: async () => { throw new Error('x'); } } }).deps);
    assert.equal(failed.yourDigests.state, 'UNAVAILABLE');
    assert.match(renderToStaticMarkup(<IntelligenceStatusView status={failed} time={time} />), /Loop could not read your digests just now/);
  });
});
