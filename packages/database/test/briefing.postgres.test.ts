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
import { aiOutputContract, PARTIAL_COVERAGE_LIMITATION, type AiTaskOutput } from '@emgloop/shared';

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
    const composer = (on: boolean) => new BriefingComposer({ prisma, runtime: fakeRuntime(calls), modelEnabled: () => on, now: () => NOW, observed: { principal: ['WORK'], organization: ['CALLGRID'] } });
    const off = await composer(false).compose(me, 'America/New_York');
    assert.equal(off.outcome, 'RULE');
    assert.equal(calls.length, 0);
    const { artifacts } = await composer(false).gather(me, NOW);
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
    assert.ok((await composer(false).gather({ organizationId: t.organizationId, userId: t.owner }, NOW)).artifacts.some((a) => a.domain === 'CALLGRID'));
  } finally {
    await prisma.$disconnect();
  }
});

// --- Truthfulness (review blocker 2): the Briefing uses only current intelligence and never overstates it ---

test('TRUTHFULNESS: stale and insufficient readings are gaps, not statements; "nothing pressing" is said only when coverage justifies it (AI off)', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  forgetIntelligenceFabricPresence();
  try {
    const t = await tenant(prisma);
    const owner = { organizationId: t.organizationId, userId: t.owner };
    const digests = new IntelligenceDigestRepository(prisma);
    // This deployment observes a person's own work only, so a calm, sufficient Work reading is the complete set.
    const composer = new BriefingComposer({ prisma, runtime: null, modelEnabled: () => false, now: () => NOW, observed: { principal: ['WORK'], organization: [] } });
    // All SUFFICIENT and calm: the absence is justified.
    assert.equal((await digests.upsert(owner, digest('WORK', 'Your work is on track.', 'CALM', { scope: 'PRINCIPAL' }))).outcome, 'WRITTEN');
    assert.equal((await composer.compose(owner, 'UTC')).outcome, 'RULE');
    const calm = (await new WorkBriefRepository(prisma).recent(owner, 1))[0]!;
    assert.equal(calm.headline, 'Nothing pressing in what Loop can read for you today.');
    // An INSUFFICIENT organization reading the owner may read: a gap, and no absence claim.
    assert.equal((await digests.upsertOrganization(t.organizationId, digest('CALLGRID', 'Too few calls to read.', 'CALM', { coverage: 'CONNECTED_INSUFFICIENT' }))).outcome, 'WRITTEN');
    const g1 = await composer.gather(owner, NOW);
    assert.deepEqual(g1.gaps, [{ domain: 'CALLGRID', coverage: 'CONNECTED_INSUFFICIENT', reason: 'NOT_CURRENT' }]);
    assert.ok(!g1.artifacts.some((a) => a.domain === 'CALLGRID'), 'no statement from an insufficient reading');
    await composer.compose(owner, 'UTC');
    const insufficient = (await new WorkBriefRepository(prisma).recent(owner, 1))[0]!;
    assert.doesNotMatch(insufficient.headline!, /nothing pressing/i);
    assert.ok(((insufficient.coverage as { limitations: string[] }).limitations).some((l) => l.startsWith('CallGrid has too little')));
    // A STALE personal reading: excluded as a statement, said as a gap.
    await prisma.intelligenceDigest.updateMany({ where: { organizationId: t.organizationId, userId: t.owner, domain: 'WORK' }, data: { status: 'STALE' } });
    const g2 = await composer.gather(owner, NOW);
    assert.ok(!g2.artifacts.some((a) => a.domain === 'WORK'));
    assert.ok(g2.gaps.some((g) => g.domain === 'WORK' && g.coverage === 'STALE'));
    assert.equal((await composer.compose(owner, 'UTC')).outcome, 'RULE');
    const stale = (await new WorkBriefRepository(prisma).recent(owner, 1))[0]!;
    assert.match(stale.headline!, /cannot say nothing is pressing/);
    const notCurrent = (stale.coverage as { notCurrent: { domain: string; coverage: string }[] }).notCurrent.map((g) => `${g.domain}:${g.coverage}`).sort();
    assert.deepEqual(notCurrent, ['CALLGRID:CONNECTED_INSUFFICIENT', 'WORK:STALE'], 'the record says what could not be used, and why');
  } finally {
    await prisma.$disconnect();
  }
});

test('TRUTHFULNESS: a PARTIAL reading reaches the model WITH its coverage and limitation; a composed absence claim it cannot justify is refused for Loop’s own Briefing', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  forgetIntelligenceFabricPresence();
  try {
    const t = await tenant(prisma);
    const me = { organizationId: t.organizationId, userId: t.employee };
    const partial = digest('WORK', 'Your work reads as calm.', 'CALM', { scope: 'PRINCIPAL', coverage: 'CONNECTED_PARTIAL' });
    assert.equal((await new IntelligenceDigestRepository(prisma).upsert(me, { ...partial, content: { ...partial.content, limitations: ['Two steps have no due date.'] } })).outcome, 'WRITTEN');
    const requests: any[] = [];
    const runtime = {
      async run(_p: unknown, req: any) {
        requests.push(req);
        const refs = req.context.items.map((i: { sourceRef: string }) => i.sourceRef);
        const answer = { schemaId: 'loop-briefing.v1', headline: 'Nothing pressing today.', lines: [{ kind: 'WATCH', statement: 'Your work is calm.', citations: [refs[0]] }], limitations: [] };
        const c = aiOutputContract('loop-briefing.v1')!;
        return { outcome: 'ANSWERED', output: c.parse(answer), provenance: { invocationId: 'inv_p', taskVersion: '1.0.0', templateVersion: '2', requestedModel: { providerId: 'anthropic', modelId: 'm' } } };
      },
    } as never;
    const out = await new BriefingComposer({ prisma, runtime, modelEnabled: () => true, now: () => NOW, observed: { principal: ['WORK'], organization: [] } }).compose(me, 'UTC');
    assert.deepEqual(out, { outcome: 'RULE', version: 1, reason: 'UNJUSTIFIED_ABSENCE' });
    const item = JSON.parse(requests[0].context.items[0].content);
    assert.equal(item.coverage, 'CONNECTED_PARTIAL', 'the model knows the reading is partial');
    assert.ok(item.limitations.includes(PARTIAL_COVERAGE_LIMITATION) && item.limitations.includes('Two steps have no due date.'));
    assert.match(requests[0].instructions, /Loop cannot conclude an absence today/);
    const brief = (await new WorkBriefRepository(prisma).recent(me, 1))[0]!;
    assert.match(brief.headline!, /cannot say nothing is pressing/);
    assert.ok((brief.coverage as { limitations: string[] }).limitations.includes(PARTIAL_COVERAGE_LIMITATION), 'the partial limitation stays with the Briefing');
    assert.deepEqual((brief.coverage as { coverages: Record<string, string> }).coverages, { [requests[0].context.items[0].sourceRef]: 'CONNECTED_PARTIAL' });
  } finally {
    await prisma.$disconnect();
  }
});

test('RETENTION: a Loop Briefing older than the approved 90 days is purged; a newer one is kept', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  try {
    const t = await tenant(prisma);
    const me = { organizationId: t.organizationId, userId: t.employee };
    const briefs = new WorkBriefRepository(prisma);
    const write = (daysAgo: number) => {
      const d = new Date(NOW.getTime() - daysAgo * 864e5);
      const localDate = new Date(`${d.toISOString().slice(0, 10)}T00:00:00.000Z`);
      return briefs.write(me, { localDate, windowStart: localDate, windowEnd: new Date(localDate.getTime() + 1000), coverage: {}, counts: {}, items: [], generatorVersion: 'test', headline: `d${daysAgo}` });
    };
    await write(91);
    await write(89);
    const { purged } = await briefs.purgeExpired(NOW);
    assert.ok(purged >= 1);
    const left = (await briefs.recent(me, 10)).map((b) => b.headline);
    assert.deepEqual(left, ['d89']);
  } finally {
    await prisma.$disconnect();
  }
});

// --- Expected coverage (review blocker 2): a missing reading is unknown, never quiet ---------------------

async function connectGoogle(prisma: PrismaClient, organizationId: string, userId: string) {
  await prisma.googleConnection.create({ data: { organizationId, userId, googleSubject: `g_${userId}`, activeGoogleSubject: `g_${userId}`, emailAtLink: 'person@example.test', status: 'CONNECTED', connectedAt: new Date(NOW.getTime() - 30 * 864e5), refreshTokenSealed: Buffer.alloc(40, 1), sealVersion: 'v1', keyRef: 'test-key' } as never });
}

test('EXPECTED COVERAGE: calm Work + a connected Google account with NO Mail or Calendar reading => both are gaps, and no absence is claimed', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  forgetIntelligenceFabricPresence();
  try {
    const t = await tenant(prisma);
    const me = { organizationId: t.organizationId, userId: t.employee };
    assert.equal((await new IntelligenceDigestRepository(prisma).upsert(me, digest('WORK', 'Your work is on track.', 'CALM', { scope: 'PRINCIPAL' }))).outcome, 'WRITTEN');
    await connectGoogle(prisma, t.organizationId, t.employee);
    const composer = new BriefingComposer({ prisma, runtime: null, modelEnabled: () => false, now: () => NOW, observed: { principal: ['WORK'], organization: [] } });
    const { artifacts, gaps } = await composer.gather(me, NOW);
    assert.deepEqual(artifacts.map((a) => [a.domain, a.coverage]), [['WORK', 'CONNECTED_SUFFICIENT']]);
    assert.deepEqual(gaps.map((g) => `${g.domain}:${g.reason}`).sort(), ['CALENDAR:NO_CURRENT_READING', 'MAIL:NO_CURRENT_READING']);
    await composer.compose(me, 'UTC');
    const brief = (await new WorkBriefRepository(prisma).recent(me, 1))[0]!;
    assert.doesNotMatch(brief.headline!, /nothing pressing/i);
    const limits = (brief.coverage as { limitations: string[] }).limitations;
    assert.ok(limits.includes('Loop has no current reading of Mail, so it cannot say Mail is quiet.'));
    assert.ok(limits.includes('Loop has no current reading of Calendar, so it cannot say Calendar is quiet.'));
  } finally {
    await prisma.$disconnect();
  }
});

test('EXPECTED COVERAGE: an observed Calendar with no connection, and a Telegram connection needing reconnect, are said as not connected -- never quiet', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  forgetIntelligenceFabricPresence();
  try {
    const t = await tenant(prisma);
    const me = { organizationId: t.organizationId, userId: t.employee };
    await new IntelligenceDigestRepository(prisma).upsert(me, digest('WORK', 'Your work is on track.', 'CALM', { scope: 'PRINCIPAL' }));
    await prisma.sourceConnection.create({ data: { organizationId: t.organizationId, userId: t.employee, provider: 'TELEGRAM', state: 'RECONNECT_REQUIRED', backgroundObservation: 'UNAVAILABLE', connectedAt: new Date(NOW.getTime() - 90 * 864e5) } });
    const composer = new BriefingComposer({ prisma, runtime: null, modelEnabled: () => false, now: () => NOW, observed: { principal: ['WORK', 'CALENDAR'], organization: [] } });
    const { gaps } = await composer.gather(me, NOW);
    assert.deepEqual(gaps.map((g) => `${g.domain}:${g.coverage}:${g.reason}`).sort(), ['CALENDAR:DISCONNECTED:NOT_CONNECTED', 'CHATS:DISCONNECTED:NOT_CONNECTED']);
    await composer.compose(me, 'UTC');
    const brief = (await new WorkBriefRepository(prisma).recent(me, 1))[0]!;
    assert.doesNotMatch(brief.headline!, /nothing pressing/i);
    const limits = (brief.coverage as { limitations: string[] }).limitations;
    assert.ok(limits.includes('Calendar is not connected, so Loop cannot see it and cannot say it is quiet.'));
    assert.ok(limits.includes('Chats is not connected, so Loop cannot see it and cannot say it is quiet.'));
  } finally {
    await prisma.$disconnect();
  }
});

test('EXPECTED COVERAGE: an observed organization domain the person may read with no current reading is a disclosed gap; only the complete SUFFICIENT set says "nothing pressing"', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  forgetIntelligenceFabricPresence();
  try {
    const t = await tenant(prisma);
    const owner = { organizationId: t.organizationId, userId: t.owner };
    const digests = new IntelligenceDigestRepository(prisma);
    await digests.upsert(owner, digest('WORK', 'Your work is on track.', 'CALM', { scope: 'PRINCIPAL' }));
    const composer = new BriefingComposer({ prisma, runtime: null, modelEnabled: () => false, now: () => NOW, observed: { principal: ['WORK'], organization: ['CALLGRID'] } });
    const missing = await composer.gather(owner, NOW);
    assert.deepEqual(missing.gaps, [{ domain: 'CALLGRID', coverage: 'CONNECTED_INSUFFICIENT', reason: 'NO_CURRENT_READING' }]);
    await composer.compose(owner, 'UTC');
    const first = (await new WorkBriefRepository(prisma).recent(owner, 1))[0]!;
    assert.doesNotMatch(first.headline!, /nothing pressing/i);
    assert.ok((first.coverage as { limitations: string[] }).limitations.includes('Loop has no current reading of CallGrid, so it cannot say CallGrid is quiet.'));
    // The expected set is now complete and SUFFICIENT: the absence is justified.
    await digests.upsertOrganization(t.organizationId, digest('CALLGRID', 'Calls are steady.', 'CALM'));
    const complete = await composer.gather(owner, NOW);
    assert.deepEqual(complete.gaps, []);
    await composer.compose(owner, 'UTC');
    const second = (await new WorkBriefRepository(prisma).recent(owner, 1))[0]!;
    assert.equal(second.headline, 'Nothing pressing in what Loop can read for you today.');
    // A domain the person may NOT read is never expected of them (an EMPLOYEE and CallGrid).
    const employee = { organizationId: t.organizationId, userId: t.employee };
    await digests.upsert(employee, digest('WORK', 'Your work is on track.', 'CALM', { scope: 'PRINCIPAL' }));
    assert.deepEqual((await composer.gather(employee, NOW)).gaps, []);
  } finally {
    await prisma.$disconnect();
  }
});

test('EXPECTED COVERAGE: with nothing said about what is observed, the default is conservative -- it can only add gaps', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  forgetIntelligenceFabricPresence();
  try {
    const t = await tenant(prisma);
    const me = { organizationId: t.organizationId, userId: t.employee };
    await new IntelligenceDigestRepository(prisma).upsert(me, digest('WORK', 'Your work is on track.', 'CALM', { scope: 'PRINCIPAL' }));
    const composer = new BriefingComposer({ prisma, runtime: null, modelEnabled: () => false, now: () => NOW });
    const { gaps } = await composer.gather(me, NOW);
    assert.ok(gaps.some((g) => g.domain === 'CALENDAR'), 'calendars are assumed observed: an unconnected one is a gap');
    await composer.compose(me, 'UTC');
    assert.doesNotMatch((await new WorkBriefRepository(prisma).recent(me, 1))[0]!.headline!, /nothing pressing/i);
  } finally {
    await prisma.$disconnect();
  }
});
