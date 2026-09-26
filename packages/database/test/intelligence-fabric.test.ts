// Loop Intelligence PR 2 (the fabric), 2026-09-26: the producer registry, the producer loop's every path,
// the governed domain-reading service, and the proof that PR 2 commissions nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AI_TASKS, DOMAIN_READING_SCHEMA, DOMAIN_READING_SCHEMA_ID, type AiTaskDefinition } from '@emgloop/shared';
import { AI_ROUTING_POLICY } from '@emgloop/providers';

import { DomainReadingService } from '../src/services/ai-runtime/domain-reading.service';
import { IntelligenceProducerRegistry, parseProducerActivation, type IntelligenceProducer } from '../src/services/intelligence-fabric/producer';
import { runIntelligenceProducerCycle, type ProducerLoopDeps } from '../src/services/intelligence-fabric/producer-loop';
import type { IntelligenceDigestInput } from '../src/repositories/intelligence/intelligence-digest.repository';
import type { IntelligenceRefreshClaim } from '../src/repositories/intelligence/intelligence-refresh-queue.repository';

const NOW = new Date('2026-09-26T12:00:00Z');

function producer(patch: Partial<IntelligenceProducer<unknown>> = {}): IntelligenceProducer<unknown> {
  return {
    id: 'test.work@1',
    domain: 'WORK',
    scope: 'ORGANIZATION',
    subjectKinds: ['DOMAIN'],
    kind: 'RULE',
    taskId: null,
    async gather() {
      return { status: 'READY', context: {}, fingerprint: 'fp-1' };
    },
    async read(_t, _c, fp) {
      return { status: 'READ', digest: { domain: 'WORK', subjectKind: 'DOMAIN', fingerprint: fp } as IntelligenceDigestInput };
    },
    ...patch,
  };
}

function claimFor(patch: Partial<IntelligenceRefreshClaim> = {}): IntelligenceRefreshClaim {
  return {
    id: 'q1',
    target: { scope: 'ORGANIZATION', organizationId: 'org_1', domain: 'WORK', subjectKind: 'DOMAIN', subjectRef: 'domain' },
    reason: 'EVIDENCE_CHANGED',
    sourceId: null,
    sourceRevision: null,
    fingerprint: null,
    requestCount: 1,
    attempts: 1,
    leaseOwner: 'w',
    leaseExpiresAt: NOW,
    ...patch,
  };
}

function world(claims: IntelligenceRefreshClaim[], opts: { stored?: string | null; storedStatus?: 'CURRENT' | 'STALE'; write?: string } = {}) {
  const log: string[] = [];
  const deps = (registry: IntelligenceProducerRegistry): ProducerLoopDeps => ({
    registry,
    leaseOwner: 'w',
    now: () => NOW,
    queue: {
      async claim(args) {
        log.push(`claim:${(args.domains ?? []).join(',')}`);
        return claims;
      },
      async complete(c) {
        log.push(`complete:${c.id}`);
        return true;
      },
      async retry(c, o) {
        log.push(`retry:${c.id}:${o.outcome}`);
        return c.attempts >= o.maxAttempts ? 'HELD' : 'RETRYING';
      },
      async hold(c, outcome) {
        log.push(`hold:${c.id}:${outcome}`);
        return true;
      },
    },
    digests: {
      async storedFingerprint() {
        return opts.stored ? { fingerprint: opts.stored, status: opts.storedStatus ?? 'CURRENT', version: 1 } : null;
      },
      async markTargetStale() {
        log.push('stale');
        return { moved: 1 };
      },
      async reaffirmTarget(_o, _t, fp) {
        log.push(`reaffirm:${fp}`);
        return { moved: 1 };
      },
      async upsert() {
        log.push('upsert');
        return opts.write ? { outcome: 'REFUSED', refusal: opts.write as never } : ({ outcome: 'WRITTEN', digest: {} } as never);
      },
      async upsertOrganization() {
        log.push('upsertOrganization');
        return opts.write ? { outcome: 'REFUSED', refusal: opts.write as never } : ({ outcome: 'WRITTEN', digest: {} } as never);
      },
    },
  });
  return { log, deps };
}

const LOOP = { limit: 10, leaseMs: 60_000, maxAttempts: 3 };

test('with no ACTIVE producer the loop claims nothing and touches nothing', async () => {
  const w = world([claimFor()]);
  const known = new IntelligenceProducerRegistry([producer()], []);
  const report = await runIntelligenceProducerCycle(w.deps(known), LOOP);
  assert.equal(report.claimed, 0);
  assert.deepEqual(w.log, [], 'not even a claim');
});

test('the loop claims only in domains with an active producer, and writes through the right door per scope', async () => {
  const w = world([claimFor()]);
  const report = await runIntelligenceProducerCycle(w.deps(new IntelligenceProducerRegistry([producer()], ['test.work@1'])), LOOP);
  assert.deepEqual(w.log, ['claim:WORK', 'upsertOrganization', 'complete:q1']);
  assert.equal(report.written, 1);
  const p = world([claimFor({ target: { scope: 'PRINCIPAL', organizationId: 'org_1', userId: 'u1', domain: 'WORK', subjectKind: 'DOMAIN', subjectRef: 'domain' } })]);
  const principalProducer = producer({ id: 'test.mywork@1', scope: 'PRINCIPAL' });
  await runIntelligenceProducerCycle(p.deps(new IntelligenceProducerRegistry([principalProducer], ['test.mywork@1'])), LOOP);
  assert.deepEqual(p.log, ['claim:WORK', 'upsert', 'complete:q1'], 'a principal target is written as that principal');
});

test('unchanged input is skipped BEFORE the read: the producer (and any model) is never asked', async () => {
  let reads = 0;
  const w = world([claimFor()], { stored: 'fp-1' });
  const p = producer({
    async read(_t, _c, fp) {
      reads += 1;
      return { status: 'READ', digest: { domain: 'WORK', subjectKind: 'DOMAIN', fingerprint: fp } as IntelligenceDigestInput };
    },
  });
  const report = await runIntelligenceProducerCycle(w.deps(new IntelligenceProducerRegistry([p], ['test.work@1'])), LOOP);
  assert.equal(reads, 0);
  assert.equal(report.skippedUnchangedBeforeRead, 1);
  assert.deepEqual(w.log, ['claim:WORK', 'complete:q1']);
});

test('every failure path: hold what will not change, retry what may, never leak a message', async () => {
  const run = async (p: IntelligenceProducer<unknown>, write?: string) => {
    const w = world([claimFor()], { write });
    const report = await runIntelligenceProducerCycle(w.deps(new IntelligenceProducerRegistry([p], [p.id])), LOOP);
    return { log: w.log, report };
  };
  // NO_EVIDENCE and every HOLD end the refresh without a reading: the prior reading is marked STALE.
  assert.deepEqual((await run(producer({ async gather() { return { status: 'NO_EVIDENCE' }; } }))).log, ['claim:WORK', 'stale', 'complete:q1']);
  assert.deepEqual((await run(producer({ async gather() { return { status: 'NOT_PERMITTED', reason: 'x' }; } }))).log, ['claim:WORK', 'hold:q1:NOT_PERMITTED', 'stale']);
  assert.deepEqual((await run(producer({ async gather() { return { status: 'UNAVAILABLE', reason: 'x' }; } }))).log, ['claim:WORK', 'retry:q1:GATHER_UNAVAILABLE']);
  assert.deepEqual((await run(producer({ async read() { return { status: 'NOT_READ', reason: 'AI_NOT_ACTIVATED', retryable: false }; } }))).log, ['claim:WORK', 'hold:q1:AI_NOT_ACTIVATED', 'stale']);
  assert.deepEqual((await run(producer({ async read() { return { status: 'NOT_READ', reason: 'AI_FAILED', retryable: true }; } }))).log, ['claim:WORK', 'retry:q1:AI_FAILED']);
  assert.deepEqual(
    (await run(producer({ async read() { return { status: 'READ', digest: { domain: 'WORK', subjectKind: 'DOMAIN', fingerprint: 'other' } as IntelligenceDigestInput }; } }))).log,
    ['claim:WORK', 'hold:q1:FINGERPRINT_MISMATCH', 'stale'],
  );
  assert.deepEqual(
    (await run(producer({ async read(_t, _c, fp) { return { status: 'READ', digest: { domain: 'CRM', subjectKind: 'DOMAIN', fingerprint: fp } as IntelligenceDigestInput }; } }))).log,
    ['claim:WORK', 'hold:q1:TARGET_MISMATCH', 'stale'],
  );
  assert.deepEqual((await run(producer(), 'PRIVATE_EVIDENCE')).log, ['claim:WORK', 'upsertOrganization', 'hold:q1:PRIVATE_EVIDENCE', 'stale']);
  assert.deepEqual((await run(producer(), 'CONTENDED')).log, ['claim:WORK', 'upsertOrganization', 'retry:q1:CONTENDED']);
  const thrown = await run(producer({ async gather() { throw new Error('secret content in a message'); } }));
  assert.deepEqual(thrown.log, ['claim:WORK', 'retry:q1:PRODUCER_ERROR']);
  assert.equal(JSON.stringify(thrown.report).includes('secret'), false, 'the report carries codes, never an error message');
});

test('a claimed request whose producer is no longer active is held, never guessed at', async () => {
  const w = world([claimFor({ target: { scope: 'ORGANIZATION', organizationId: 'o', domain: 'CRM', subjectKind: 'DOMAIN', subjectRef: 'domain' } })]);
  await runIntelligenceProducerCycle(w.deps(new IntelligenceProducerRegistry([producer()], ['test.work@1'])), LOOP);
  assert.deepEqual(w.log, ['claim:WORK', 'hold:q1:NO_ACTIVE_PRODUCER', 'stale']);
});

test('an unchanged refresh of a reading marked STALE re-affirms it without a read; a retry that is not yet HELD leaves it as it is', async () => {
  let reads = 0;
  const w = world([claimFor()], { stored: 'fp-1', storedStatus: 'STALE' });
  const p = producer({
    async read(_t, _c, fp) {
      reads += 1;
      return { status: 'READ', digest: { domain: 'WORK', subjectKind: 'DOMAIN', fingerprint: fp } as IntelligenceDigestInput };
    },
  });
  await runIntelligenceProducerCycle(w.deps(new IntelligenceProducerRegistry([p], ['test.work@1'])), LOOP);
  assert.equal(reads, 0);
  assert.deepEqual(w.log, ['claim:WORK', 'reaffirm:fp-1', 'complete:q1']);
  // Retrying (attempts below the limit): the queue row itself keeps the reading out; nothing is marked.
  const r = world([claimFor()]);
  await runIntelligenceProducerCycle(r.deps(new IntelligenceProducerRegistry([producer({ async gather() { return { status: 'UNAVAILABLE', reason: 'x' }; } })], ['test.work@1'])), LOOP);
  assert.deepEqual(r.log, ['claim:WORK', 'retry:q1:GATHER_UNAVAILABLE']);
});

test('the registry: ids are well formed, one active producer per target, MODEL names its task, unknown activations are reported', () => {
  assert.throws(() => new IntelligenceProducerRegistry([producer({ id: 'Bad Id' })], []));
  assert.throws(() => new IntelligenceProducerRegistry([producer(), producer()], []), /twice/);
  assert.throws(() => new IntelligenceProducerRegistry([producer({ kind: 'MODEL', taskId: null })], []), /names its task/);
  assert.throws(() => new IntelligenceProducerRegistry([producer({ taskId: 'x.y' })], []), /calls no task/);
  assert.throws(() => new IntelligenceProducerRegistry([producer(), producer({ id: 'test.work@2' })], ['test.work@1', 'test.work@2']), /two active/);
  const r = new IntelligenceProducerRegistry([producer()], ['test.work@1', 'nope@1']);
  assert.deepEqual(r.unknownActive, ['nope@1']);
  assert.equal(r.isActive('test.work@1'), true);
  assert.deepEqual(parseProducerActivation(' a@1, b@2 ,,a@1 '), ['a@1', 'b@2']);
  assert.deepEqual(parseProducerActivation(undefined), []);
});

test('DomainReadingService: the portable schema, the generic template, the governed gateway; a non-domain task is refused', async () => {
  const seen: any[] = [];
  const service = new DomainReadingService({
    async run(_p, request) {
      seen.push(request);
      return { outcome: 'REFUSED_BY_LOOP', refusals: ['TASK_NOT_ACTIVATED' as never] };
    },
  });
  const task = { taskId: 'x.domain.reading', outputSchemaId: DOMAIN_READING_SCHEMA_ID } as AiTaskDefinition;
  const out = await service.read(
    { organizationId: 'o', userId: 'u' },
    {
      task,
      framing: { domainDescription: 'the test domain', audience: 'ORGANIZATION', lookFor: ['what changed'] },
      context: { organizationId: 'o', viewerUserId: 'u', taskId: 'x.domain.reading', items: [{ sourceRef: 'rec:1' } as never], sensitivityCeiling: 'OPERATIONAL' },
      evidence: { figures: new Map(), dates: new Set(), entityRefs: new Set(['party:p1']) },
      lane: 'BACKGROUND',
    },
  );
  assert.deepEqual(out, { outcome: 'REFUSED_BY_LOOP', codes: ['TASK_NOT_ACTIVATED'] });
  assert.equal(seen[0].schema, DOMAIN_READING_SCHEMA);
  assert.equal(seen[0].templateId, 'domain-reading');
  assert.equal(seen[0].lane, 'BACKGROUND');
  assert.match(seen[0].instructions, /rec:1/);
  assert.match(seen[0].instructions, /party:p1/);
  const wrong = await service.read({ organizationId: 'o', userId: 'u' }, { task: { ...task, outputSchemaId: 'telegram-content-triage.v4' } as AiTaskDefinition } as never);
  assert.deepEqual(wrong, { outcome: 'REFUSED_BY_LOOP', codes: ['WRONG_OUTPUT_CONTRACT'] });
  assert.equal(seen.length, 1, 'the wrong contract never reached the gateway');
});

test('MERGING COMMISSIONS NOTHING: intelligence tasks are defined and routed, but no activation default names one, and the fabric calls no model except through the gateway', () => {
  const pre = ['case.explanation', 'mail.reply.draft', 'telegram.content.triage'];
  assert.deepEqual(AI_TASKS.slice(0, 3).map((t) => t.taskId), pre);
  for (const t of AI_TASKS) assert.ok(AI_ROUTING_POLICY.tasks[t.taskId], `${t.taskId} is routed`);
  // The only task any shipped default activates is production's existing triage.
  const infra = readFileSync(join(__dirname, '..', '..', '..', 'infra', 'connections', 'lib', 'app.ts'), 'utf8');
  const defaults = /DEFAULT_AI_TASKS[^=]*=\s*Object\.freeze\(\[([^\]]*)\]/.exec(infra)?.[1] ?? '';
  assert.deepEqual([...defaults.matchAll(/'([a-z.]+)'/g)].map((m) => m[1]), ['telegram.content.triage']);
  // The fabric services reach a model only through the gateway port handed in; no provider, no SDK, no env.
  const dir = join(__dirname, '..', 'src', 'services', 'intelligence-fabric');
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
  const code = [...walk(dir).map((f) => readFileSync(f, 'utf8')), readFileSync(join(__dirname, '..', 'src', 'services', 'ai-runtime', 'domain-reading.service.ts'), 'utf8')]
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
  for (const forbidden of ['@emgloop/providers', 'anthropic', 'openai', 'fetch(', 'googleapis', 'process.env']) {
    assert.equal(code.toLowerCase().includes(forbidden.toLowerCase()), false, `${forbidden} has no place in the fabric`);
  }
});

test('every read authority the domain registry names is a real resource:action an OWNER holds', async () => {
  const { INTELLIGENCE_DOMAIN_REGISTRY } = await import('@emgloop/shared');
  const { matrixAllows } = await import('../src/repositories/iam.repository');
  for (const d of INTELLIGENCE_DOMAIN_REGISTRY) {
    if (!d.readAuthority.permission) continue;
    const [resource, action] = d.readAuthority.permission.split(':');
    assert.equal(matrixAllows('OWNER', resource as never, action as never), true, `${d.domain}: ${d.readAuthority.permission}`);
  }
});
