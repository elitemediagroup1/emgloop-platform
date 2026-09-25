// Loop Intelligence Phase F against a REAL Postgres. OPT-IN AND LOCAL ONLY: LOOP_TEST_POSTGRES_URL (migrated
// through 20261008000000) and LOOP_TEST_PRE_FABRIC_POSTGRES_URL (a database without it).
//
// Proves: a private situation is visible to its ONE owner and to no organization Case path (Case reads,
// lists, counts, history, evidence, activity) and to no other person, whatever their role; an organization
// pass clusters, synthesizes, verifies (or honestly cannot) and records a Case; an unchanged cluster costs no
// call; an independent check that supports nothing records nothing; offboarding erases a person's private
// situations; before the migration nothing is written and every existing Case read still works.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { aiOutputContract, PRIVATE_SITUATION_SOURCE, SITUATION_SOURCE, type AiTaskOutput } from '@emgloop/shared';

import { forgetIntelligenceFabricPresence } from '../src/repositories/intelligence/intelligence-fabric-presence';
import { IntelligenceDigestRepository, type IntelligenceDigestInput } from '../src/repositories/intelligence/intelligence-digest.repository';
import { SituationRepository, SITUATION_RECORD_SCHEMA, type SituationRecord } from '../src/repositories/intelligence/situation.repository';
import { OperationalPriorityRepository } from '../src/repositories/operational-priority.repository';
import { WorkErasureRepository } from '../src/repositories/work-state/work-erasure.repository';
import { DecisionEngine } from '../src/services/decision/decision-engine';
import { SituationService } from '../src/services/intelligence-fabric/situations';

const LOCAL = (url: string) => /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url);
const URL = process.env.LOOP_TEST_POSTGRES_URL ?? '';
const PRE_URL = process.env.LOOP_TEST_PRE_FABRIC_POSTGRES_URL ?? '';
const skip = !URL ? 'LOOP_TEST_POSTGRES_URL is not set' : !LOCAL(URL) ? 'refusing a non-local database' : false;
const skipPre = !PRE_URL ? 'LOOP_TEST_PRE_FABRIC_POSTGRES_URL is not set' : !LOCAL(PRE_URL) ? 'refusing a non-local database' : false;

const NOW = new Date();
const DAY = 864e5;
const at = (d: number) => new Date(NOW.getTime() + d * DAY);

async function tenant(prisma: PrismaClient, label: string) {
  const organizationId = `org_sit_${label}_${randomUUID()}`;
  await prisma.organization.create({ data: { id: organizationId, name: `SIT ${label}`, slug: organizationId } });
  const users: string[] = [];
  for (const role of ['OWNER', 'EMPLOYEE', 'EMPLOYEE'] as const) {
    const userId = `user_sit_${label}_${users.length}_${randomUUID()}`;
    await prisma.user.create({ data: { id: userId, organizationId, email: `${userId}@example.test`, name: 'SIT', status: 'ACTIVE', metadata: { systemRole: role } } });
    await prisma.organizationMembership.create({ data: { organizationId, userId, systemRole: role, status: 'ACTIVE', effectiveFrom: new Date('2026-01-01T00:00:00Z') } });
    users.push(userId);
  }
  return { organizationId, owner: users[0]!, a: users[1]!, b: users[2]! };
}

const digest = (domain: IntelligenceDigestInput['domain'], key: string, statement: string, entity: string, patch: Partial<IntelligenceDigestInput> = {}): IntelligenceDigestInput => ({
  domain,
  subjectKind: 'DOMAIN',
  provider: null,
  consentBasis: 'LOOP_RECORDS',
  content: { reading: { statement, status: 'WATCH', confidence: 'MEDIUM' }, signals: [{ key, kind: 'RISK', knowledge: 'OBSERVED', statement, entities: [entity], evidenceRefs: [`${domain.toLowerCase()}:x`], severity: 'HIGH', occurredAt: at(-1).toISOString() }] },
  coverage: 'CONNECTED_SUFFICIENT',
  windowStart: at(-7),
  windowEnd: at(0),
  evidenceCount: 5,
  lastEvidenceAt: at(-1),
  provenance: { sourceRefs: [`${domain.toLowerCase()}:x`], producerVersion: `${domain.toLowerCase()}.domain@1#1`, producerKind: 'RULE', sources: [{ sourceId: domain === 'WORK' ? 'LOOP_WORK' : 'CALLGRID', asOf: at(-1).toISOString(), coverage: 'CONNECTED_SUFFICIENT' }] },
  aiInvocationId: null,
  entityRefs: [entity],
  fingerprint: `${domain.toLowerCase()}:${key.replace(/[^a-z0-9]/gi, '')}${statement.length}`,
  generatedAt: NOW,
  ...patch,
});

/** A gateway stand-in: scripted answers per task, judged by the REAL registered contracts, recording calls. */
function fakeRuntime(script: Record<string, (req: { evidence: unknown; context: { items: { sourceRef: string }[] } }) => unknown>, calls: { taskId: string; subjectProvider?: string }[]) {
  return {
    async run(_principal: unknown, req: any) {
      calls.push({ taskId: req.task.taskId, subjectProvider: req.subjectProvider });
      const answer = script[req.task.taskId]?.(req);
      if (answer === 'NO_INDEPENDENT') return { outcome: 'REFUSED_BY_LOOP', refusals: ['NO_INDEPENDENT_PROVIDER'] };
      const contract = aiOutputContract(req.task.outputSchemaId)!;
      const parsed = contract.parse(answer) as AiTaskOutput;
      const rejections = contract.validate(parsed, req.task, new Set(req.context.items.map((i: { sourceRef: string }) => i.sourceRef)), req.evidence);
      const provenance = { invocationId: `inv_${calls.length}`, taskVersion: req.task.version, templateVersion: '1', requestedModel: { providerId: req.task.taskId.startsWith('situation.verify') ? 'openai' : 'anthropic', modelId: 'm' } };
      if (rejections.length) return { outcome: 'REJECTED_OUTPUT', rejections, provenance };
      return { outcome: 'ANSWERED', output: parsed, provenance };
    },
  } as never;
}

const NEW_ANSWER = (req: { context: { items: { sourceRef: string }[] } }) => ({
  schemaId: 'situation-synthesis.v1',
  decision: 'NEW',
  situationId: null,
  title: 'One campaign is moving in two places at once',
  narrative: 'The same campaign shows a risk in call economics and in campaign movement in the same week.',
  claims: [{ kind: 'CONNECTION', statement: 'Both readings name the same campaign in the same week.', citations: req.context.items.map((i) => i.sourceRef).slice(0, 2) }],
  limitations: [],
});

test('an ORGANIZATION pass clusters, synthesizes, records a Case, degrades honestly without an independent verifier, and skips unchanged', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  forgetIntelligenceFabricPresence();
  try {
    const t = await tenant(prisma, 'org');
    const digests = new IntelligenceDigestRepository(prisma);
    assert.equal((await digests.upsertOrganization(t.organizationId, digest('CALLGRID', 'calls-change', 'Calls are down on one campaign.', 'provider_member:callgrid:campaign:c1'))).outcome, 'WRITTEN');
    assert.equal((await digests.upsertOrganization(t.organizationId, digest('CAMPAIGNS', 'campaign.c1', 'A campaign carried calls nobody bought.', 'provider_member:callgrid:campaign:c1'))).outcome, 'WRITTEN');
    const calls: { taskId: string; subjectProvider?: string }[] = [];
    const service = (verify: boolean) =>
      new SituationService({
        prisma,
        runtime: fakeRuntime({ 'situation.synthesis': NEW_ANSWER, 'situation.verify': () => 'NO_INDEPENDENT' }, calls),
        modelEnabled: (id) => id === 'situation.synthesis' || (verify && id === 'situation.verify'),
        principalFor: async () => ({ organizationId: t.organizationId, userId: t.owner }),
        now: () => NOW,
      });
    const first = await service(true).pass({ scope: 'ORGANIZATION', organizationId: t.organizationId });
    assert.equal(first.candidates, 1);
    assert.deepEqual(first.decisions, { NEW: 1 });
    assert.deepEqual(first.verification, { UNAVAILABLE: 1 }, 'no independent provider: said, never faked');
    assert.deepEqual(calls.map((c) => c.taskId), ['situation.synthesis', 'situation.verify']);
    assert.equal(calls[1]!.subjectProvider, 'anthropic', 'the verifier is told whose claims it checks');
    const open = await new SituationRepository(prisma).open({ scope: 'ORGANIZATION', organizationId: t.organizationId });
    assert.equal(open.length, 1);
    assert.equal(open[0]!.record!.verification.state, 'UNAVAILABLE');
    assert.deepEqual(open[0]!.record!.domains, ['CALLGRID', 'CAMPAIGNS']);
    // It is an ordinary organization Case: the Case authority sees it.
    const kase = await new OperationalPriorityRepository(prisma).findById(t.organizationId, open[0]!.id);
    assert.equal(kase?.sourceSystem, SITUATION_SOURCE);
    // Unchanged: no call at all.
    const second = await service(true).pass({ scope: 'ORGANIZATION', organizationId: t.organizationId });
    assert.equal(second.unchanged, 1);
    assert.equal(calls.length, 2);
  } finally {
    await prisma.$disconnect();
  }
});

test('an independent check that supports no claim records no situation; a model not activated is never called', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  forgetIntelligenceFabricPresence();
  try {
    const t = await tenant(prisma, 'dispute');
    const digests = new IntelligenceDigestRepository(prisma);
    await digests.upsertOrganization(t.organizationId, digest('CALLGRID', 'k1', 'Calls are down on one campaign.', 'provider_member:callgrid:campaign:c2'));
    await digests.upsertOrganization(t.organizationId, digest('CAMPAIGNS', 'k2', 'A campaign went quiet.', 'provider_member:callgrid:campaign:c2'));
    const calls: { taskId: string }[] = [];
    const off = await new SituationService({ prisma, runtime: fakeRuntime({}, calls), modelEnabled: () => false, principalFor: async () => ({ organizationId: t.organizationId, userId: t.owner }), now: () => NOW }).pass({ scope: 'ORGANIZATION', organizationId: t.organizationId });
    assert.equal(off.notAsked, 1);
    assert.equal(calls.length, 0);
    const disputed = await new SituationService({
      prisma,
      runtime: fakeRuntime({ 'situation.synthesis': NEW_ANSWER, 'situation.verify': () => ({ schemaId: 'situation-verification.v1', verdicts: [{ claimIndex: 0, verdict: 'UNSUPPORTED' }], limitations: [] }) }, calls),
      modelEnabled: () => true,
      principalFor: async () => ({ organizationId: t.organizationId, userId: t.owner }),
      now: () => NOW,
    }).pass({ scope: 'ORGANIZATION', organizationId: t.organizationId });
    assert.deepEqual(disputed.verification, { DISPUTED: 1 });
    assert.equal((await new SituationRepository(prisma).open({ scope: 'ORGANIZATION', organizationId: t.organizationId })).length, 0);
  } finally {
    await prisma.$disconnect();
  }
});

test('a PRIVATE situation is its owner’s alone: no organization Case path returns it, no other person -- not the OWNER -- can read it; erasure removes it', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  forgetIntelligenceFabricPresence();
  try {
    const t = await tenant(prisma, 'priv');
    const digests = new IntelligenceDigestRepository(prisma);
    const me = { organizationId: t.organizationId, userId: t.a };
    assert.equal((await digests.upsert(me, digest('WORK', 'overdue', 'A piece of work is overdue.', 'work_instance:w1', { scope: 'PRINCIPAL' }))).outcome, 'WRITTEN');
    assert.equal((await digests.upsert(me, digest('CALENDAR', 'prep.w1', 'A meeting ahead concerns the same work.', 'work_instance:w1', { scope: 'PRINCIPAL', provider: 'GOOGLE_CALENDAR', consentBasis: 'SOURCE_CONNECTION_GRANT', provenance: { sourceRefs: ['work_events:day'], producerVersion: 'calendar.domain@1#1', producerKind: 'RULE', sources: [{ sourceId: 'GOOGLE_CALENDAR', asOf: at(-1).toISOString(), coverage: 'CONNECTED_SUFFICIENT' }] } }))).outcome, 'WRITTEN');
    const calls: { taskId: string }[] = [];
    const report = await new SituationService({
      prisma,
      runtime: fakeRuntime({ 'situation.synthesis.private': NEW_ANSWER }, calls),
      modelEnabled: (id) => id === 'situation.synthesis.private',
      principalFor: async (o) => (o.scope === 'PRINCIPAL' ? { organizationId: o.organizationId, userId: o.userId } : null),
      now: () => NOW,
    }).pass({ scope: 'PRINCIPAL', ...me });
    assert.deepEqual(report.decisions, { NEW: 1 });
    const repo = new SituationRepository(prisma);
    const mine = await repo.open({ scope: 'PRINCIPAL', ...me });
    assert.equal(mine.length, 1);
    assert.equal(mine[0]!.visibility, 'PRINCIPAL');
    const id = mine[0]!.id;
    // Nobody else, whatever their role.
    assert.equal((await repo.open({ scope: 'PRINCIPAL', organizationId: t.organizationId, userId: t.b })).length, 0);
    assert.equal((await repo.open({ scope: 'PRINCIPAL', organizationId: t.organizationId, userId: t.owner })).length, 0);
    assert.equal(await repo.get({ scope: 'PRINCIPAL', organizationId: t.organizationId, userId: t.owner }, id), null);
    assert.equal(await repo.get({ scope: 'ORGANIZATION', organizationId: t.organizationId }, id), null);
    // No organization Case path.
    const cases = new OperationalPriorityRepository(prisma);
    assert.equal(await cases.findById(t.organizationId, id), null);
    assert.equal(await cases.findWithLog(t.organizationId, id), null);
    assert.deepEqual(await cases.listObservations(t.organizationId, id), []);
    assert.ok(!(await cases.list(t.organizationId)).some((c) => c.id === id));
    assert.equal(Object.values(await cases.countsByState(t.organizationId)).reduce((a, b) => a + b, 0), 0);
    assert.equal(await cases.recordObservation(t.organizationId, id, { observationType: 'NOTE_ADDED', occurredAt: NOW, actorType: 'HUMAN', actorUserId: t.owner, source: 'test', note: 'x' }), null, 'an organization action cannot touch it');
    const engine = new DecisionEngine(prisma);
    assert.equal(await engine.get(t.organizationId, id), null);
    assert.deepEqual(await engine.getHistory(t.organizationId, id), []);
    assert.deepEqual(await engine.getEvidence(t.organizationId, id), []);
    assert.ok(!(await engine.list(t.organizationId, {})).some((c: { id: string }) => c.id === id));
    // Its sourceSystem says what it is; the scope row names its owner.
    assert.equal((await prisma.operationalPriority.findUnique({ where: { id }, select: { sourceSystem: true } }))?.sourceSystem, PRIVATE_SITUATION_SOURCE);
    // Offboarding erases the person's private situations and candidates.
    const erased = await new WorkErasureRepository(prisma).eraseAll(me);
    assert.equal(erased.case_private_scopes, 1);
    assert.ok(erased.situation_candidates >= 1);
    assert.equal(await prisma.operationalPriority.count({ where: { id } }), 0);
  } finally {
    await prisma.$disconnect();
  }
});

test('an UPDATE may only name the owner’s OWN open situation', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  forgetIntelligenceFabricPresence();
  try {
    const t = await tenant(prisma, 'upd');
    const repo = new SituationRepository(prisma);
    const rec = (clusterKey: string): SituationRecord => ({ schema: SITUATION_RECORD_SCHEMA, clusterKey, fingerprint: `situation:${clusterKey}`, narrative: 'n', refs: ['work_instance:w1'], citations: ['digest:a/b'], domains: ['WORK', 'CALENDAR'], claims: [], limitations: [], verification: { state: 'UNAVAILABLE', providerId: null }, synthesis: { invocationId: 'i', providerId: 'anthropic', taskId: 'situation.synthesis.private', taskVersion: '1.0.0' }, windowStart: NOW.toISOString(), windowEnd: NOW.toISOString() });
    const a = { scope: 'PRINCIPAL' as const, organizationId: t.organizationId, userId: t.a };
    const b = { scope: 'PRINCIPAL' as const, organizationId: t.organizationId, userId: t.b };
    const opened = await repo.record(a, { decision: 'NEW', caseId: null, title: 'T', narrative: 'N', severity: 'LOW', record: rec('k1'), at: NOW });
    assert.equal(opened.outcome, 'OPENED');
    const theirs = await repo.record(b, { decision: 'UPDATE', caseId: (opened as { caseId: string }).caseId, title: 'T2', narrative: 'N2', severity: 'LOW', record: rec('k1'), at: NOW });
    assert.deepEqual(theirs, { outcome: 'REFUSED', refusal: 'NOT_FOUND' });
    // Identical clusters for two people are two situations, never one.
    const same = await repo.record(b, { decision: 'NEW', caseId: null, title: 'T', narrative: 'N', severity: 'LOW', record: rec('k1'), at: NOW });
    assert.equal(same.outcome, 'OPENED');
    assert.notEqual((same as { caseId: string }).caseId, (opened as { caseId: string }).caseId);
  } finally {
    await prisma.$disconnect();
  }
});

test('PRE-MIGRATION: nothing is written, candidates and private reads are empty, and organization Case reads still work', { skip: skipPre }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: PRE_URL } } });
  forgetIntelligenceFabricPresence();
  try {
    const organizationId = `org_sit_pre_${randomUUID()}`;
    await prisma.organization.create({ data: { id: organizationId, name: 'SIT pre', slug: organizationId } });
    const repo = new SituationRepository(prisma);
    assert.equal(await repo.present(), false);
    assert.deepEqual(await repo.open({ scope: 'ORGANIZATION', organizationId }), []);
    assert.equal((await repo.record({ scope: 'ORGANIZATION', organizationId }, { decision: 'NEW', caseId: null, title: 't', narrative: 'n', severity: 'LOW', record: {} as never, at: NOW })).outcome, 'REFUSED');
    const report = await new SituationService({ prisma, runtime: null, modelEnabled: () => true, principalFor: async () => null, now: () => NOW }).pass({ scope: 'ORGANIZATION', organizationId });
    assert.equal(report.state, 'NOT_MIGRATED');
    // The organization filter is by value: existing Case reads are unaffected before the migration.
    const cases = new OperationalPriorityRepository(prisma);
    const opened = await cases.detect(organizationId, { sourceSystem: 'CALLGRID', recurrenceKey: 'r1', detectionKey: 'd1', detectedAt: NOW, title: 'A', severity: 'HIGH' });
    assert.ok(await cases.findById(organizationId, opened.priority.id));
    assert.equal((await cases.listObservations(organizationId, opened.priority.id)).length, 1);
    assert.equal(Object.values(await cases.countsByState(organizationId)).reduce((a, b) => a + b, 0), 1);
  } finally {
    await prisma.$disconnect();
  }
});
