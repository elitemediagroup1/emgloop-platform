// Loop Intelligence Phase G against a REAL Postgres. OPT-IN AND LOCAL ONLY: LOOP_TEST_POSTGRES_URL.
//
// Proves: a Briefing always exists (Loop's deterministic one when the model is off), an unchanged Briefing
// is reused with no call and no new version, the composed one replaces a rule one once the task is on,
// every line cites supplied artifacts, and the artifacts are the person's own plus only the organization
// readings their role and permissions admit -- never another person's private situation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { aiOutputContract, type AiTaskOutput } from '@emgloop/shared';

import { forgetIntelligenceFabricPresence } from '../src/repositories/intelligence/intelligence-fabric-presence';
import { IntelligenceDigestRepository, type IntelligenceDigestInput } from '../src/repositories/intelligence/intelligence-digest.repository';
import { SituationRepository, SITUATION_RECORD_SCHEMA } from '../src/repositories/intelligence/situation.repository';
import { WorkBriefRepository } from '../src/repositories/work-state/work-brief.repository';
import { BriefingComposer, readableOrganizationDomains } from '../src/services/intelligence-fabric/briefing';

const LOCAL = (url: string) => /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url);
const URL = process.env.LOOP_TEST_POSTGRES_URL ?? '';
const skip = !URL ? 'LOOP_TEST_POSTGRES_URL is not set' : !LOCAL(URL) ? 'refusing a non-local database' : false;
const NOW = new Date();
const at = (d: number) => new Date(NOW.getTime() + d * 864e5);

async function tenant(prisma: PrismaClient) {
  const organizationId = `org_brf_${randomUUID()}`;
  await prisma.organization.create({ data: { id: organizationId, name: 'BRF', slug: organizationId } });
  const ids: Record<string, string> = {};
  for (const role of ['OWNER', 'EMPLOYEE'] as const) {
    const userId = `user_brf_${role}_${randomUUID()}`;
    await prisma.user.create({ data: { id: userId, organizationId, email: `${userId}@example.test`, name: 'BRF', status: 'ACTIVE', metadata: { systemRole: role } } });
    await prisma.organizationMembership.create({ data: { organizationId, userId, systemRole: role, status: 'ACTIVE', effectiveFrom: new Date('2026-01-01T00:00:00Z') } });
    ids[role] = userId;
  }
  return { organizationId, owner: ids.OWNER!, employee: ids.EMPLOYEE! };
}

const digest = (domain: IntelligenceDigestInput['domain'], statement: string, status: 'CALM' | 'WATCH' | 'ATTENTION', patch: Partial<IntelligenceDigestInput> = {}): IntelligenceDigestInput => ({
  domain,
  subjectKind: 'DOMAIN',
  provider: null,
  consentBasis: 'LOOP_RECORDS',
  content: { reading: { statement, status, confidence: 'HIGH' }, signals: [] },
  coverage: 'CONNECTED_SUFFICIENT',
  windowStart: at(-7),
  windowEnd: at(0),
  evidenceCount: 3,
  lastEvidenceAt: at(-0.5),
  provenance: { sourceRefs: [`${domain.toLowerCase()}:x`], producerVersion: 'test#1', producerKind: 'RULE', sources: [{ sourceId: domain === 'WORK' ? 'LOOP_WORK' : 'CALLGRID', asOf: at(-0.5).toISOString(), coverage: 'CONNECTED_SUFFICIENT' }] },
  aiInvocationId: null,
  entityRefs: [],
  fingerprint: `${domain.toLowerCase()}:${statement.length}`,
  generatedAt: NOW,
  ...patch,
});

function fakeRuntime(calls: string[][]) {
  return {
    async run(_p: unknown, req: any) {
      const refs = req.context.items.map((i: { sourceRef: string }) => i.sourceRef);
      calls.push(refs);
      const answer = { schemaId: 'loop-briefing.v1', headline: 'Your work needs you today.', lines: [{ kind: 'NEEDS_YOU', statement: 'Two of your steps are overdue.', citations: [refs.find((r: string) => r.startsWith('digest:'))] }], limitations: [] };
      const c = aiOutputContract('loop-briefing.v1')!;
      const parsed = c.parse(answer) as AiTaskOutput;
      const rejections = c.validate(parsed, req.task, new Set(refs), req.evidence);
      const provenance = { invocationId: 'inv_b', taskVersion: '1.0.0', templateVersion: '1', requestedModel: { providerId: 'anthropic', modelId: 'm' } };
      return rejections.length ? { outcome: 'REJECTED_OUTPUT', rejections, provenance } : { outcome: 'ANSWERED', output: parsed, provenance };
    },
  } as never;
}

test('read authority: the OWNER may read CallGrid readings in a Briefing; an EMPLOYEE may not', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  try {
    const t = await tenant(prisma);
    assert.ok((await readableOrganizationDomains(prisma, t.organizationId, t.owner)).includes('CALLGRID'));
    assert.ok(!(await readableOrganizationDomains(prisma, t.organizationId, t.employee)).includes('CALLGRID'));
    assert.deepEqual(await readableOrganizationDomains(prisma, t.organizationId, `user_nobody_${randomUUID()}`), []);
  } finally {
    await prisma.$disconnect();
  }
});

test('a Briefing always exists; it is reused unchanged; the composed one replaces the rule one; lines cite supplied artifacts only', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  forgetIntelligenceFabricPresence();
  try {
    const t = await tenant(prisma);
    const digests = new IntelligenceDigestRepository(prisma);
    const me = { organizationId: t.organizationId, userId: t.employee };
    assert.equal((await digests.upsert(me, digest('WORK', 'Two of your steps are overdue.', 'ATTENTION', { scope: 'PRINCIPAL' }))).outcome, 'WRITTEN');
    assert.equal((await digests.upsertOrganization(t.organizationId, digest('CALLGRID', 'Calls are down this week.', 'WATCH'))).outcome, 'WRITTEN');
    // Another person's private situation must never reach this Briefing.
    await new SituationRepository(prisma).record({ scope: 'PRINCIPAL', organizationId: t.organizationId, userId: t.owner }, { decision: 'NEW', caseId: null, title: 'Owner private', narrative: 'x', severity: 'HIGH', record: { schema: SITUATION_RECORD_SCHEMA, clusterKey: 'k', fingerprint: 'situation:k', narrative: 'x', refs: [], citations: [], domains: ['WORK', 'MAIL'], claims: [], limitations: [], verification: { state: 'UNAVAILABLE', providerId: null }, synthesis: { invocationId: 'i', providerId: 'anthropic', taskId: 'situation.synthesis.private', taskVersion: '1.0.0' }, windowStart: NOW.toISOString(), windowEnd: NOW.toISOString() }, at: NOW });

    const calls: string[][] = [];
    const composer = (on: boolean) => new BriefingComposer({ prisma, runtime: fakeRuntime(calls), modelEnabled: () => on, now: () => NOW });
    const off = await composer(false).compose(me, 'America/New_York');
    assert.equal(off.outcome, 'RULE');
    assert.equal(calls.length, 0);
    const artifacts = await composer(false).gather(me, NOW);
    assert.deepEqual(artifacts.map((a) => a.domain).sort(), ['WORK'], 'an EMPLOYEE reads their own work, not CallGrid, and nobody else’s situation');

    assert.equal((await composer(false).compose(me, 'America/New_York')).outcome, 'REUSED');
    const on = await composer(true).compose(me, 'America/New_York');
    assert.equal(on.outcome, 'COMPOSED', 'the model replaces a rule Briefing once it is switched on');
    assert.equal(calls.length, 1);
    assert.ok(calls[0]!.every((r) => r.startsWith('digest:') || r.startsWith('situation:')));
    assert.equal((await composer(true).compose(me, 'America/New_York')).outcome, 'REUSED');
    assert.equal(calls.length, 1, 'unchanged: no call');

    const brief = await new WorkBriefRepository(prisma).recent(me, 5);
    assert.equal(brief[0]!.headline, 'Your work needs you today.');
    assert.equal((brief[0]!.coverage as { composer: string }).composer, 'MODEL');
    assert.equal(brief.length, 2, 'rule then composed: two versions, nothing overwritten');
    // The OWNER's Briefing may read CallGrid.
    assert.ok((await composer(false).gather({ organizationId: t.organizationId, userId: t.owner }, NOW)).some((a) => a.domain === 'CALLGRID'));
  } finally {
    await prisma.$disconnect();
  }
});
