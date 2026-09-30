// The governed entity-link projector and the independent-source gate against a REAL Postgres (2026-09-29).
// OPT-IN AND LOCAL ONLY: LOOP_TEST_POSTGRES_URL.
//
// Proves: only a governed record joins two entities -- an ACTIVE Customer->Party link to an established Party of
// the same organization, a CreatorProfile's own Party, a person's WorkOrigin promotion from an organization
// digest signal -- and every other shape is rejected with a code; nothing crosses a tenant; a Pipeline record
// that is not intake is never named, so its Party link joins nothing; a Situation reaches synthesis only when
// its evidence spans two DISTINCT governed sources (CallGrid + Campaigns is one source seen twice); every
// digest-eligibility, kind and time rule still holds; and no model is ever called. The last test scans the
// source: nothing here matches identity by phone, email, name, label or time.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';

import { CrmRepository } from '../src/repositories/crm.repository';
import { DomainFactsRepository } from '../src/repositories/intelligence/domain-facts.repository';
import { GovernedEntityLinkProjector } from '../src/repositories/intelligence/governed-entity-links.repository';
import { forgetIntelligenceFabricPresence } from '../src/repositories/intelligence/intelligence-fabric-presence';
import { IntelligenceDigestRepository, type IntelligenceDigestInput } from '../src/repositories/intelligence/intelligence-digest.repository';
import { IntakeEligibilityRepository } from '../src/repositories/intake-eligibility.repository';
import { pipelineDomainProducer, workDomainProducer } from '../src/services/intelligence-fabric/domains/records';
import { SituationService } from '../src/services/intelligence-fabric/situations';

const LOCAL = (url: string) => /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url);
const URL = process.env.LOOP_TEST_POSTGRES_URL ?? '';
const skip = !URL ? 'LOOP_TEST_POSTGRES_URL is not set' : !LOCAL(URL) ? 'refusing a non-local database' : false;

const NOW = new Date();
const DAY = 864e5;
const at = (d: number) => new Date(NOW.getTime() + d * DAY);
const SOURCE_OF: Record<string, string> = { CALLGRID: 'CALLGRID', CAMPAIGNS: 'CALLGRID', WORK: 'LOOP_WORK', PIPELINE: 'LOOP_INTAKE', CRM: 'LOOP_CRM', CREATORS: 'LOOP_CREATORS' };

async function tenant(prisma: PrismaClient, label: string) {
  const organizationId = `0gel_${label}_${randomUUID()}`;
  await prisma.organization.create({ data: { id: organizationId, name: `GEL ${label}`, slug: organizationId } });
  const userId = `user_gel_${label}_${randomUUID()}`;
  await prisma.user.create({ data: { id: userId, organizationId, email: `${userId}@example.test`, name: 'GEL', status: 'ACTIVE', metadata: { systemRole: 'OWNER' } } });
  await prisma.organizationMembership.create({ data: { organizationId, userId, systemRole: 'OWNER', status: 'ACTIVE', effectiveFrom: new Date('2026-01-01T00:00:00Z') } });
  return { organizationId, userId };
}

const party = (prisma: PrismaClient, organizationId: string, patch: Record<string, unknown> = { establishedAt: at(-30), establishmentBasis: 'MANUAL' }) =>
  prisma.cognitiveIdentity.create({ data: { organizationId, entityType: 'PERSON', canonicalKey: `gel:${randomUUID()}`, ...patch } as never });

const quoted = (prisma: PrismaClient, organizationId: string, email: string) =>
  prisma.customer.create({ data: { organizationId, email, phone: '+15550100', firstName: 'Dana', attributes: { pipelineStatus: 'Quoted' }, lastSeenAt: at(-30) } });

const digest = (domain: IntelligenceDigestInput['domain'], key: string, entity: string, patch: Partial<IntelligenceDigestInput> & { kind?: string; occurredAt?: Date } = {}): IntelligenceDigestInput => {
  const { kind, occurredAt, ...rest } = patch;
  return {
    domain,
    subjectKind: 'DOMAIN',
    provider: null,
    consentBasis: 'LOOP_RECORDS',
    content: { reading: { statement: 'Secret statement.', status: 'WATCH', confidence: 'MEDIUM' }, signals: [{ key, kind: kind ?? 'RISK', knowledge: 'OBSERVED', statement: 'Secret statement.', entities: [entity], evidenceRefs: [`${domain.toLowerCase()}:x`], severity: 'HIGH', occurredAt: (occurredAt ?? at(-1)).toISOString() }] },
    coverage: 'CONNECTED_SUFFICIENT',
    windowStart: at(-7),
    windowEnd: at(0),
    evidenceCount: 5,
    lastEvidenceAt: at(-1),
    provenance: { sourceRefs: [`${domain.toLowerCase()}:x`], producerVersion: `${domain.toLowerCase()}.domain@1#1`, producerKind: 'RULE', sources: [{ sourceId: SOURCE_OF[domain]!, asOf: at(-1).toISOString(), coverage: 'CONNECTED_SUFFICIENT' }] },
    aiInvocationId: null,
    entityRefs: [entity],
    fingerprint: `${domain.toLowerCase()}:${key}:${randomUUID()}`,
    generatedAt: NOW,
    ...rest,
  };
};

async function write(prisma: PrismaClient, organizationId: string, d: IntelligenceDigestInput): Promise<string> {
  const r = await new IntelligenceDigestRepository(prisma).upsertOrganization(organizationId, d);
  assert.equal(r.outcome, 'WRITTEN', JSON.stringify(r));
  return (r as { digest: { id: string } }).digest.id;
}

/** A read-only diagnosis with every AI task switched ON and a runtime that fails the test if it is ever called. */
function service(prisma: PrismaClient, calls: string[]) {
  return new SituationService({
    prisma,
    runtime: { run: async (_p: unknown, req: { task: { taskId: string } }) => (calls.push(req.task.taskId), assert.fail('no model may be called')) } as never,
    modelEnabled: () => true,
    principalFor: async () => null,
    now: () => NOW,
  });
}

test('CUSTOMER_PARTY: only an ACTIVE link to an ESTABLISHED Party of the SAME organization projects; reversed, missing, unestablished and cross-tenant Parties never do', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const a = await tenant(prisma, 'cp');
  const b = await tenant(prisma, 'cpx');
  try {
    const p = await party(prisma, a.organizationId);
    const pending = await party(prisma, a.organizationId, {});
    const superseded = await party(prisma, a.organizationId, { establishedAt: at(-30), establishmentBasis: 'MANUAL', supersededAt: at(-2) });
    const foreign = await party(prisma, b.organizationId);
    const link = async (partyId: string, patch: Record<string, unknown> = {}) => {
      const c = await quoted(prisma, a.organizationId, `${randomUUID()}@secret.test`);
      await prisma.customerPartyLink.create({ data: { organizationId: a.organizationId, customerId: c.id, partyId, basis: 'MANUAL', activeCustomerId: c.id, linkedByUserId: a.userId, linkedAt: at(-30), ...patch } });
      return c.id;
    };
    const active = await link(p.id);
    const reversed = await link(p.id, { activeCustomerId: null, reversedAt: at(-1), reversedByUserId: a.userId });
    const toPending = await link(pending.id);
    const toSuperseded = await link(superseded.id);
    const toForeign = await link(foreign.id);
    const toMissing = await link(`party_that_does_not_exist_${randomUUID()}`);
    // A link row of THIS organization whose customer belongs to another (nothing in the schema forbids it).
    const theirs = await quoted(prisma, b.organizationId, 'theirs@secret.test');
    await prisma.customerPartyLink.create({ data: { organizationId: a.organizationId, customerId: theirs.id, partyId: p.id, basis: 'MANUAL', activeCustomerId: theirs.id, linkedByUserId: a.userId, linkedAt: at(-30) } });

    const projector = new GovernedEntityLinkProjector(prisma);
    const all = await projector.project(a.organizationId, null);
    assert.deepEqual(all.links.filter((l) => l.linkClass === 'CUSTOMER_PARTY'), [{ fromRef: `customer:${active}`, toRef: `party:${p.id}`, linkClass: 'CUSTOMER_PARTY' }]);
    assert.deepEqual(all.classes.find((c) => c.linkClass === 'CUSTOMER_PARTY'), { linkClass: 'CUSTOMER_PARTY', records: 6, links: 1, rejected: { PARTY_NOT_ESTABLISHED: 4, CUSTOMER_NOT_IN_ORGANIZATION: 1 } }, 'the reversed link is not a record at all');
    assert.deepEqual((await projector.project(a.organizationId, [`customer:${theirs.id}`])).links, [], 'another tenant’s customer is never joined to our Party');

    // Scoped to the references in play: only what they name.
    const inPlay = await projector.project(a.organizationId, [`customer:${reversed}`, `customer:${toPending}`, `customer:${toSuperseded}`, `customer:${toForeign}`, `customer:${toMissing}`]);
    assert.equal(inPlay.links.length, 0);
    assert.deepEqual((await projector.project(a.organizationId, [`customer:${active}`])).links.length, 1);
    assert.deepEqual((await projector.project(a.organizationId, [])).links, [], 'nothing in play, nothing read');

    // Tenancy: another organization never sees these links, even when it names the very reference.
    const other = await projector.project(b.organizationId, [`customer:${active}`, `party:${p.id}`]);
    assert.deepEqual([other.links, other.classes.map((c) => c.records)], [[], [0, 0, 0]]);
    assert.deepEqual((await projector.project('', null)).links, [], 'no organization, nothing');
  } finally {
    await prisma.organization.deleteMany({ where: { id: { in: [a.organizationId, b.organizationId] } } });
    await prisma.$disconnect();
  }
});

test('CREATOR_PARTY: the profile’s governed Party, established and in the same organization -- missing and cross-tenant Parties are rejected', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const a = await tenant(prisma, 'cr');
  const b = await tenant(prisma, 'crx');
  try {
    const p = await party(prisma, a.organizationId);
    const foreign = await party(prisma, b.organizationId);
    const governed = await prisma.creatorProfile.create({ data: { organizationId: a.organizationId, partyId: p.id, displayName: 'Secret Creator' } });
    const missing = await prisma.creatorProfile.create({ data: { organizationId: a.organizationId, partyId: `party_gone_${randomUUID()}`, displayName: 'Secret Creator 2' } });
    const crossTenant = await prisma.creatorProfile.create({ data: { organizationId: a.organizationId, partyId: foreign.id, displayName: 'Secret Creator 3' } });
    const unset = await prisma.creatorProfile.create({ data: { organizationId: a.organizationId, partyId: '', displayName: 'Secret Creator 4' } });

    const projector = new GovernedEntityLinkProjector(prisma);
    const all = await projector.project(a.organizationId, null);
    assert.deepEqual(all.links.filter((l) => l.linkClass === 'CREATOR_PARTY'), [{ fromRef: `creator:${governed.id}`, toRef: `party:${p.id}`, linkClass: 'CREATOR_PARTY' }]);
    assert.deepEqual(all.classes.find((c) => c.linkClass === 'CREATOR_PARTY'), { linkClass: 'CREATOR_PARTY', records: 4, links: 1, rejected: { PARTY_NOT_ESTABLISHED: 2, NO_PARTY: 1 } });
    assert.equal((await projector.project(a.organizationId, [`creator:${missing.id}`, `creator:${crossTenant.id}`, `creator:${unset.id}`])).links.length, 0);
    // The other tenant names this creator: nothing -- and its own Party is not joined to a profile it does not own.
    assert.deepEqual((await projector.project(b.organizationId, [`creator:${governed.id}`, `creator:${crossTenant.id}`])).links, []);
  } finally {
    await prisma.organization.deleteMany({ where: { id: { in: [a.organizationId, b.organizationId] } } });
    await prisma.$disconnect();
  }
});

test('WORK_ORIGIN: a promotion from an organization signal resolves to that signal’s entities; unresolved and unrelated work join nothing', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  forgetIntelligenceFabricPresence();
  const a = await tenant(prisma, 'wo');
  const b = await tenant(prisma, 'wox');
  try {
    const CAMP = 'provider_member:callgrid:campaign:camp-1';
    const campaigns = await write(prisma, a.organizationId, digest('CAMPAIGNS', 'campaign.camp-1', CAMP));
    const noEntity = await write(prisma, a.organizationId, { ...digest('CRM', 'k', 'party:x'), content: { reading: { statement: 's', status: 'WATCH', confidence: 'MEDIUM' }, signals: [{ key: 'bare', kind: 'RISK', knowledge: 'OBSERVED', statement: 's', entities: [], evidenceRefs: ['crm:x'], severity: 'HIGH' }] }, entityRefs: [] } as never);
    const foreignDigest = await write(prisma, b.organizationId, digest('CAMPAIGNS', 'campaign.camp-1', CAMP));
    const work = async () => (await prisma.workInstance.create({ data: { organizationId: a.organizationId, title: 'Secret work title', createdByUserId: a.userId } })).id;
    const origin = (workInstanceId: string, originRef: string, patch: Record<string, unknown> = {}) =>
      prisma.workOrigin.create({ data: { organizationId: a.organizationId, workInstanceId, originKind: 'DIGEST_SIGNAL', originScope: 'ORGANIZATION', originRef, originFingerprint: 'f', promotedByUserId: a.userId, promotedAt: at(-1), sharedFields: [], submissionKey: `sub_${randomUUID()}`, ...patch } });
    const resolvable = await work();
    await origin(resolvable, `${campaigns}#campaign.camp-1`);
    await origin(await work(), `${campaigns}#no-such-signal`);
    await origin(await work(), `${noEntity}#bare`);
    await origin(await work(), `${foreignDigest}#campaign.camp-1`); // another tenant's digest: gone, for us
    const unrelated = await work(); // no origin at all

    const projector = new GovernedEntityLinkProjector(prisma);
    const all = await projector.project(a.organizationId, null);
    assert.deepEqual(all.links.filter((l) => l.linkClass === 'WORK_ORIGIN'), [{ fromRef: `work_instance:${resolvable}`, toRef: CAMP, linkClass: 'WORK_ORIGIN' }]);
    assert.deepEqual(all.classes.find((c) => c.linkClass === 'WORK_ORIGIN'), { linkClass: 'WORK_ORIGIN', records: 4, links: 1, rejected: { SIGNAL_GONE: 1, SIGNAL_NAMES_NO_ENTITY: 1, DIGEST_GONE: 1 } });
    assert.deepEqual((await projector.project(a.organizationId, [`work_instance:${unrelated}`])).links, []);
    assert.deepEqual((await projector.project(b.organizationId, [`work_instance:${resolvable}`])).links, [], 'another tenant never resolves our work');
  } finally {
    await prisma.organization.deleteMany({ where: { id: { in: [a.organizationId, b.organizationId] } } });
    await prisma.$disconnect();
  }
});

test('the gate: CallGrid + Campaigns (one source) never synthesizes; Work + Campaigns (two sources) would; eligibility, kind and time still rule; no model call', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  forgetIntelligenceFabricPresence();
  const t = await tenant(prisma, 'gate');
  try {
    const CAMP = 'provider_member:callgrid:campaign:camp-9';
    await write(prisma, t.organizationId, digest('CALLGRID', 'calls-change', CAMP));
    await write(prisma, t.organizationId, digest('CAMPAIGNS', 'campaign.camp-9', CAMP));
    const calls: string[] = [];
    const s = service(prisma, calls);
    const same = await s.diagnose({ scope: 'ORGANIZATION', organizationId: t.organizationId });
    assert.deepEqual([same.clusters, same.sourceIndependentClusters, same.eliminatedSameSource, same.wouldSynthesize, same.reason], [1, 0, 1, 0, 'NO_INDEPENDENT_SOURCES']);
    assert.deepEqual(same.composition, [{ domains: ['CALLGRID', 'CAMPAIGNS'], sources: ['CALLGRID'], streams: ['CALLS'], count: 1, sourceIndependent: false }]);
    const pass = await s.pass({ scope: 'ORGANIZATION', organizationId: t.organizationId });
    assert.deepEqual([pass.candidates, pass.sameSourceOnly], [1, 1]);

    // A digest that cannot be synthesized from -- stale, errored, disconnected, insufficient, or a plain
    // measurement, or evidence outside the window -- never makes the pair independent.
    // STALE and WITHDRAWN (disconnected) are the digest's status, and an unreadable body is ERROR -- set on the row.
    const blocked: [string, Partial<IntelligenceDigestInput> & { kind?: string; occurredAt?: Date }, Record<string, unknown> | null][] = [
      ['stale', {}, { status: 'STALE' }],
      ['disconnected', {}, { status: 'WITHDRAWN' }],
      ['error', {}, { content: { bogus: true } }],
      ['insufficient', { coverage: 'CONNECTED_INSUFFICIENT' }, null],
      ['kind', { kind: 'OPERATIONAL' }, null],
      ['time', { occurredAt: at(-20) }, null],
    ];
    for (const [label, patch, row] of blocked) {
      const u = await tenant(prisma, `blk${label}`);
      try {
        await write(prisma, u.organizationId, digest('CAMPAIGNS', 'campaign.camp-9', CAMP));
        await write(prisma, u.organizationId, digest('WORK', 'overdue', CAMP, patch));
        if (row) await prisma.intelligenceDigest.updateMany({ where: { organizationId: u.organizationId, domain: 'WORK' }, data: row as never });
        const d = await s.diagnose({ scope: 'ORGANIZATION', organizationId: u.organizationId });
        assert.deepEqual([d.sourceIndependentClusters, d.wouldSynthesize], [0, 0], label);
      } finally {
        await prisma.organization.delete({ where: { id: u.organizationId } }).catch(() => undefined);
      }
    }

    // A second, genuinely independent source naming the same campaign: synthesis would be reached.
    await write(prisma, t.organizationId, digest('WORK', 'overdue', CAMP));
    const two = await s.diagnose({ scope: 'ORGANIZATION', organizationId: t.organizationId });
    assert.deepEqual([two.sourceIndependentClusters, two.eliminatedSameSource, two.wouldSynthesize, two.reason], [1, 0, 1, 'WOULD_SYNTHESIZE']);
    assert.deepEqual(two.composition, [{ domains: ['CALLGRID', 'CAMPAIGNS', 'WORK'], sources: ['CALLGRID', 'LOOP_WORK'], streams: ['CALLS', 'WORK_RECORDS'], count: 1, sourceIndependent: true }]);
    assert.deepEqual(calls, [], 'diagnosis and a same-source pass never reach a model');
    assert.equal(await prisma.aiInvocation.count({ where: { organizationId: t.organizationId } }), 0);
  } finally {
    await prisma.organization.delete({ where: { id: t.organizationId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});

test('Pipeline: an ELIGIBLE linked intake record joins a Creator on the same Party (independent); a legacy non-intake Customer with the same link is never named', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  forgetIntelligenceFabricPresence();
  const t = await tenant(prisma, 'pipe');
  try {
    const p = await party(prisma, t.organizationId);
    // Worked: a person linked it to its Party 30 days ago -- intake work, and stalled by the work clock.
    const worked = await quoted(prisma, t.organizationId, 'worked@secret.test');
    await prisma.customerPartyLink.create({ data: { organizationId: t.organizationId, customerId: worked.id, partyId: p.id, basis: 'MANUAL', activeCustomerId: worked.id, linkedByUserId: t.userId, linkedAt: at(-30) } });
    // Legacy: a caller row linked by no person (an import) -- not intake, whatever its link says.
    const legacy = await quoted(prisma, t.organizationId, 'legacy@secret.test');
    await prisma.customerPartyLink.create({ data: { organizationId: t.organizationId, customerId: legacy.id, partyId: p.id, basis: 'MANUAL', activeCustomerId: legacy.id, linkedAt: at(-30) } });
    const creator = await prisma.creatorProfile.create({ data: { organizationId: t.organizationId, partyId: p.id, displayName: 'Secret Creator' } });
    await write(prisma, t.organizationId, digest('CREATORS', 'needs-emg', `creator:${creator.id}`));

    // The REAL Pipeline reading, through its producer: it names the stalled eligible record, and only it.
    const kit = { modelEnabled: () => false, reader: null, principalFor: async () => null };
    const producer = pipelineDomainProducer(new CrmRepository(prisma), new IntakeEligibilityRepository(prisma), new DomainFactsRepository(prisma), kit as never);
    const subject = { scope: 'ORGANIZATION' as const, organizationId: t.organizationId, domain: 'PIPELINE' as const, subjectKind: 'DOMAIN' as const, subjectRef: 'domain' };
    const gathered = await producer.gather(subject as never, NOW);
    assert.equal(gathered.status, 'READY');
    const out = await producer.read(subject as never, (gathered as { context: never }).context, (gathered as { fingerprint: string }).fingerprint, NOW);
    assert.equal(out.status, 'READ');
    if (out.status !== 'READ') return;
    const named = (out.digest.content as { signals: { entities?: string[] }[] }).signals.flatMap((s) => s.entities ?? []);
    assert.ok(named.includes(`customer:${worked.id}`), JSON.stringify(named.length));
    assert.equal(named.includes(`customer:${legacy.id}`), false, 'a record that is not intake is never a participant');
    await write(prisma, t.organizationId, out.digest);

    const calls: string[] = [];
    const d = await service(prisma, calls).diagnose({ scope: 'ORGANIZATION', organizationId: t.organizationId });
    assert.equal(d.explicitLinks, 0, 'no link was persisted');
    assert.equal(d.projectedLinks, 2, 'customer->party and creator->party, for the references in play');
    assert.deepEqual([d.sourceIndependentClusters, d.wouldSynthesize, d.reason], [1, 1, 'WOULD_SYNTHESIZE']);
    assert.deepEqual(d.composition, [{ domains: ['CREATORS', 'PIPELINE'], sources: ['LOOP_CREATORS', 'LOOP_INTAKE'], streams: ['CREATOR_RECORDS', 'INTAKE_RECORDS'], count: 1, sourceIndependent: true }]);
    assert.deepEqual(calls, []);
    assert.equal(await prisma.entityLink.count({ where: { organizationId: t.organizationId } }), 0, 'projection writes nothing');
  } finally {
    await prisma.organization.delete({ where: { id: t.organizationId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});

// --- Adversarial review (2026-09-29) ---------------------------------------------------------------

const KIT = { modelEnabled: () => false, reader: null, principalFor: async () => null };

/** Run a REAL organization producer once and store what it read (as the scheduled pass would). */
async function produce(prisma: PrismaClient, producer: { gather: Function; read: Function }, organizationId: string, domain: string): Promise<IntelligenceDigestInput | null> {
  const target = { scope: 'ORGANIZATION', organizationId, domain, subjectKind: 'DOMAIN', subjectRef: 'domain' };
  const g = await producer.gather(target, new Date());
  if (g.status !== 'READY') return null;
  const r = await producer.read(target, g.context, g.fingerprint, new Date());
  assert.equal(r.status, 'READ');
  await write(prisma, organizationId, r.digest);
  return r.digest;
}
const namedBy = (d: IntelligenceDigestInput | null) => (d?.content as { signals?: { entities?: string[] }[] } | undefined)?.signals?.flatMap((x) => x.entities ?? []) ?? [];

/** A person promotes one organization digest signal to Work (the WorkOrigin Promote to Work records). */
async function promote(prisma: PrismaClient, t: { organizationId: string; userId: string }, digestId: string, key: string, work: { dueAt?: Date; expectedReturnAt?: Date } = {}) {
  const w = await prisma.workInstance.create({
    data: { organizationId: t.organizationId, title: 'Secret promoted work', createdByUserId: t.userId, status: 'active', ...(work.expectedReturnAt ? { expectedReturnAt: work.expectedReturnAt } : {}), stages: { create: [{ name: 'S', position: 1, status: 'ready', ownerUserId: t.userId, ...(work.dueAt ? { dueAt: work.dueAt } : {}) }] } },
  });
  await prisma.workOrigin.create({ data: { organizationId: t.organizationId, workInstanceId: w.id, originKind: 'DIGEST_SIGNAL', originScope: 'ORGANIZATION', originRef: `${digestId}#${key}`, originFingerprint: 'f', promotedByUserId: t.userId, promotedAt: at(-1), sharedFields: [], submissionKey: `sub_${randomUUID()}` } });
  return w.id;
}

test('LAUNDERING (A): promoting a Campaigns, Pipeline or Creators signal to Work -- with no Work-state fact -- never makes its evidence independent', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  forgetIntelligenceFabricPresence();
  try {
    for (const [domain, key, entity] of [['CAMPAIGNS', 'campaign.x', 'provider_member:callgrid:campaign:x'], ['PIPELINE', 'stale.quoted', `customer:c_${randomUUID()}`], ['CREATORS', 'needs-emg', `creator:r_${randomUUID()}`]] as const) {
      const t = await tenant(prisma, `ld${domain.toLowerCase()}`);
      try {
        const origin = await write(prisma, t.organizationId, digest(domain, key, entity));
        // Promoted: open, owned, not due, no committed return passed -- and even a return committed for later.
        await promote(prisma, t, origin, key, { expectedReturnAt: at(5) });
        const work = await produce(prisma, workDomainProducer(new DomainFactsRepository(prisma), KIT as never), t.organizationId, 'WORK');
        assert.ok(work, 'the Work reading exists');
        assert.deepEqual(namedBy(work), [], `${domain}: Work names nothing -- no Work-state fact is about the promoted item`);
        const calls: string[] = [];
        const d = await service(prisma, calls).diagnose({ scope: 'ORGANIZATION', organizationId: t.organizationId });
        assert.equal(d.projectedLinks, 0, 'the promoted work is not even in play');
        assert.deepEqual([d.sourceIndependentClusters, d.wouldSynthesize], [0, 0], domain);
        assert.deepEqual(calls, []);
      } finally {
        await prisma.organization.delete({ where: { id: t.organizationId } }).catch(() => undefined);
      }
    }
  } finally {
    await prisma.$disconnect();
  }
});

test('LEGITIMATE (B): when Work ITSELF says the promoted item is late, that Work-state fact is a second governed source', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  forgetIntelligenceFabricPresence();
  const CAMP = 'provider_member:callgrid:campaign:x';
  try {
    for (const late of [{ dueAt: at(-2) }, { expectedReturnAt: at(-2) }]) {
      const t = await tenant(prisma, 'legit');
      try {
        const origin = await write(prisma, t.organizationId, digest('CAMPAIGNS', 'campaign.x', CAMP));
        const w = await promote(prisma, t, origin, 'campaign.x', late);
        const work = await produce(prisma, workDomainProducer(new DomainFactsRepository(prisma), KIT as never), t.organizationId, 'WORK');
        const signals = (work!.content as { signals: { key: string; entities?: string[] }[] }).signals;
        const which = 'dueAt' in late ? 'overdue' : 'past-return';
        assert.deepEqual(signals.find((x) => x.key === which)?.entities, [`work_instance:${w}`], `${which} names the late instance`);
        assert.equal(signals.find((x) => x.key === (which === 'overdue' ? 'past-return' : 'overdue'))?.entities, undefined, 'and only the signal whose fact it is');
        const calls: string[] = [];
        const d = await service(prisma, calls).diagnose({ scope: 'ORGANIZATION', organizationId: t.organizationId });
        assert.deepEqual([d.sourceIndependentClusters, d.reason], [1, 'WOULD_SYNTHESIZE'], which);
        assert.deepEqual(d.composition, [{ domains: ['CAMPAIGNS', 'WORK'], sources: ['CALLGRID', 'LOOP_WORK'], streams: ['CALLS', 'WORK_RECORDS'], count: 1, sourceIndependent: true }]);
        assert.deepEqual(calls, []);
      } finally {
        await prisma.organization.delete({ where: { id: t.organizationId } }).catch(() => undefined);
      }
    }
  } finally {
    await prisma.$disconnect();
  }
});

test('WORK STATE: the overdue signal names only work with a step past due; past-return only work past its committed return', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  forgetIntelligenceFabricPresence();
  const t = await tenant(prisma, 'ws');
  try {
    const stageLate = await promote(prisma, t, 'd_none', 'k', { dueAt: at(-2) });
    const returnLate = await promote(prisma, t, 'd_none', 'k', { expectedReturnAt: at(-2) });
    const work = await produce(prisma, workDomainProducer(new DomainFactsRepository(prisma), KIT as never), t.organizationId, 'WORK');
    const signals = (work!.content as { signals: { key: string; entities?: string[] }[] }).signals;
    assert.deepEqual(signals.find((x) => x.key === 'overdue')?.entities, [`work_instance:${stageLate}`]);
    assert.deepEqual(signals.find((x) => x.key === 'past-return')?.entities, [`work_instance:${returnLate}`]);
  } finally {
    await prisma.organization.delete({ where: { id: t.organizationId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});

test('LINEAGE: a multi-source digest’s signal claims no source, and a model’s addition to a rule reading never joins a Situation', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  forgetIntelligenceFabricPresence();
  const CAMP = 'provider_member:callgrid:campaign:x';
  const t = await tenant(prisma, 'lineage');
  try {
    await write(prisma, t.organizationId, digest('CAMPAIGNS', 'campaign.x', CAMP));
    // A WEBSITE digest that read two sources, one of them CALLGRID, with a signal naming the campaign: which source
    // said it is unknown, so it cannot be the second source.
    const multi = digest('WEBSITE', 'site.x', CAMP);
    await write(prisma, t.organizationId, { ...multi, provenance: { ...multi.provenance, sources: [{ sourceId: 'WEBSITE_EVENTS', asOf: at(-1).toISOString(), coverage: 'CONNECTED_SUFFICIENT' }, { sourceId: 'CALLGRID', asOf: at(-1).toISOString(), coverage: 'CONNECTED_SUFFICIENT' }] } });
    const calls: string[] = [];
    const s = service(prisma, calls);
    let d = await s.diagnose({ scope: 'ORGANIZATION', organizationId: t.organizationId });
    assert.deepEqual([d.clusters, d.sourceIndependentClusters, d.reason], [1, 0, 'NO_INDEPENDENT_SOURCES']);
    assert.deepEqual(d.composition[0]!.sources, ['CALLGRID']);

    // A RULE_AND_MODEL Work reading whose MODEL signal names the campaign: a model choosing what belongs together.
    const work = digest('WORK', 'open', 'work_instance:none', { kind: 'OPERATIONAL' });
    await write(prisma, t.organizationId, {
      ...work,
      content: { ...work.content, signals: [...(work.content as { signals: unknown[] }).signals, { key: 'm.campaign', kind: 'RISK', knowledge: 'INFERRED', statement: 'Secret model claim.', entities: [CAMP], evidenceRefs: ['work:x'], severity: 'HIGH', occurredAt: at(-1).toISOString() }] },
      provenance: { ...work.provenance, producerKind: 'RULE_AND_MODEL' },
    } as IntelligenceDigestInput);
    d = await s.diagnose({ scope: 'ORGANIZATION', organizationId: t.organizationId });
    assert.equal(d.sourceIndependentClusters, 0, 'the model signal is not evidence here');
    assert.equal(d.domains.find((x) => x.domain === 'WORK')?.clusterable ?? 0, 0);
    assert.deepEqual(calls, []);
  } finally {
    await prisma.organization.delete({ where: { id: t.organizationId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});

test('CHAINS: work -> origin customer -> Party <- creator joins, in the pass AND the probe alike; an aggregate origin bridges nothing', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  forgetIntelligenceFabricPresence();
  const { readOnlyClient } = await import('../src/repositories/read-only-client');
  const t = await tenant(prisma, 'chain');
  try {
    const p = await party(prisma, t.organizationId);
    const c = await quoted(prisma, t.organizationId, 'chain@secret.test');
    await prisma.customerPartyLink.create({ data: { organizationId: t.organizationId, customerId: c.id, partyId: p.id, basis: 'MANUAL', activeCustomerId: c.id, linkedByUserId: t.userId, linkedAt: at(-30) } });
    const creator = await prisma.creatorProfile.create({ data: { organizationId: t.organizationId, partyId: p.id, displayName: 'Secret Creator' } });
    // A Pipeline signal about ONE record, promoted; then that reading goes stale (its evidence is out -- the
    // bridge the person made remains). Work is late on it; a Creator on the same Party waits on EMG.
    const origin = await write(prisma, t.organizationId, digest('PIPELINE', 'stale.one', `customer:${c.id}`));
    const w = await promote(prisma, t, origin, 'stale.one', { dueAt: at(-2) });
    await prisma.intelligenceDigest.updateMany({ where: { organizationId: t.organizationId, domain: 'PIPELINE' }, data: { status: 'STALE' } });
    await produce(prisma, workDomainProducer(new DomainFactsRepository(prisma), KIT as never), t.organizationId, 'WORK');
    await write(prisma, t.organizationId, digest('CREATORS', 'needs-emg', `creator:${creator.id}`));

    const s = new SituationService({ prisma: readOnlyClient(prisma), runtime: null, modelEnabled: () => false, principalFor: async () => null, now: () => new Date() });
    const d = await s.diagnose({ scope: 'ORGANIZATION', organizationId: t.organizationId });
    assert.equal(d.projectedLinks, 3, 'work->customer, customer->party, creator->party');
    assert.deepEqual([d.sourceIndependentClusters, d.reason], [1, 'WOULD_SYNTHESIZE']);
    assert.deepEqual(d.composition, [{ domains: ['CREATORS', 'WORK'], sources: ['LOOP_CREATORS', 'LOOP_WORK'], streams: ['CREATOR_RECORDS', 'WORK_RECORDS'], count: 1, sourceIndependent: true }]);
    // PARITY: the probe's PROJECTOR is the same clusterer over the same prepared links.
    const c2 = await s.connectivity(t.organizationId);
    assert.deepEqual([c2.projector.crossDomain, c2.projector.sourceIndependent, c2.projector.eliminatedSameSource], [d.clusters, d.sourceIndependentClusters, d.eliminatedSameSource]);
    assert.deepEqual(c2.projector.composition, d.composition);
    assert.deepEqual([c2.current.crossDomain, c2.current.sourceIndependent], [0, 0], 'without the projection, nothing joins');
    const text = JSON.stringify([d, c2]);
    for (const secret of [c.id, p.id, creator.id, w, origin, t.userId, t.organizationId, 'Secret', 'chain@']) assert.equal(text.includes(secret), false, 'codes and counts only');

    // An origin signal naming several records is about the set: its work is linked to none of them.
    const c3 = await quoted(prisma, t.organizationId, 'three@secret.test');
    const many = await write(prisma, t.organizationId, { ...digest('CAMPAIGNS', 'set', `customer:${c.id}`), content: { reading: { statement: 's', status: 'WATCH', confidence: 'MEDIUM' }, signals: [{ key: 'set', kind: 'STALLED', knowledge: 'OBSERVED', statement: 's', entities: [`customer:${c.id}`, `customer:${c3.id}`], evidenceRefs: ['x:y'], severity: 'HIGH' }] } } as never);
    const hub = await promote(prisma, t, many, 'set');
    // A signal naming one entity twice is refused before storage (the contract), and the projector dedupes anyway.
    const dup = await new IntelligenceDigestRepository(prisma).upsertOrganization(t.organizationId, { ...digest('CAMPAIGNS', 'dup', `customer:${c3.id}`), content: { reading: { statement: 's', status: 'WATCH', confidence: 'MEDIUM' }, signals: [{ key: 'dup', kind: 'RISK', knowledge: 'OBSERVED', statement: 's', entities: [`customer:${c3.id}`, `customer:${c3.id}`], evidenceRefs: ['x:y'], severity: 'HIGH' }] } } as never);
    assert.equal(dup.outcome, 'REFUSED');
    const proj = await new GovernedEntityLinkProjector(prisma).project(t.organizationId, [`work_instance:${hub}`]);
    assert.deepEqual(proj.links.filter((l) => l.linkClass === 'WORK_ORIGIN'), [], 'the set is not a relationship among its members');
    assert.equal(proj.classes.find((x) => x.linkClass === 'WORK_ORIGIN')!.rejected.SIGNAL_NAMES_SEVERAL, 1);
  } finally {
    await prisma.organization.delete({ where: { id: t.organizationId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});

test('FRESHNESS: a projected link never lets an ineligible reading in -- stale, withdrawn, error, insufficient and unresolved-refresh block; PARTIAL is allowed and says so', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  forgetIntelligenceFabricPresence();
  try {
    const cases: [string, Partial<IntelligenceDigestInput>, Record<string, unknown> | null, boolean, number][] = [
      ['current', {}, null, false, 1],
      ['partial', { coverage: 'CONNECTED_PARTIAL' }, null, false, 1],
      ['stale', {}, { status: 'STALE' }, false, 0],
      ['withdrawn', {}, { status: 'WITHDRAWN' }, false, 0],
      ['error', {}, { content: { bogus: true } }, false, 0],
      ['insufficient', { coverage: 'CONNECTED_INSUFFICIENT' }, null, false, 0],
      ['unresolved', {}, null, true, 0],
    ];
    for (const [label, patch, row, unresolved, expected] of cases) {
      const t = await tenant(prisma, `fr${label}`);
      try {
        const p = await party(prisma, t.organizationId);
        const c = await quoted(prisma, t.organizationId, `${label}@secret.test`);
        await prisma.customerPartyLink.create({ data: { organizationId: t.organizationId, customerId: c.id, partyId: p.id, basis: 'MANUAL', activeCustomerId: c.id, linkedByUserId: t.userId, linkedAt: at(-30) } });
        const creator = await prisma.creatorProfile.create({ data: { organizationId: t.organizationId, partyId: p.id, displayName: 'Secret Creator' } });
        await write(prisma, t.organizationId, digest('PIPELINE', 'stale.one', `customer:${c.id}`, { kind: 'STALLED' }));
        await write(prisma, t.organizationId, digest('CREATORS', 'needs-emg', `creator:${creator.id}`, patch));
        if (row) await prisma.intelligenceDigest.updateMany({ where: { organizationId: t.organizationId, domain: 'CREATORS' }, data: row as never });
        if (unresolved) await prisma.intelligenceRefreshRequest.create({ data: { organizationId: t.organizationId, scope: 'ORGANIZATION', domain: 'CREATORS', subjectKind: 'DOMAIN', subjectRef: 'domain', reason: 'SCHEDULED', firstRequestedAt: NOW, lastRequestedAt: NOW, notBefore: NOW, state: 'HELD', attempts: 3, lastOutcome: 'FAILED' } });
        const d = await service(prisma, []).diagnose({ scope: 'ORGANIZATION', organizationId: t.organizationId });
        // Projection starts from ELIGIBLE signals only: a blocked reading's reference is not even in play.
        assert.equal(d.projectedLinks, expected ? 2 : 1, label);
        assert.equal(d.sourceIndependentClusters, expected, label);
      } finally {
        await prisma.organization.delete({ where: { id: t.organizationId } }).catch(() => undefined);
      }
    }
  } finally {
    await prisma.$disconnect();
  }
});

test('FINGERPRINTS: governed evidence changes re-open a decided cluster; unrelated projector inventory never does', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  forgetIntelligenceFabricPresence();
  const t = await tenant(prisma, 'fp');
  try {
    const p = await party(prisma, t.organizationId);
    const other = await party(prisma, t.organizationId);
    const third = await party(prisma, t.organizationId);
    const c = await quoted(prisma, t.organizationId, 'fp@secret.test');
    const link = await prisma.customerPartyLink.create({ data: { organizationId: t.organizationId, customerId: c.id, partyId: p.id, basis: 'MANUAL', activeCustomerId: c.id, linkedByUserId: t.userId, linkedAt: at(-30) } });
    const creator = await prisma.creatorProfile.create({ data: { organizationId: t.organizationId, partyId: p.id, displayName: 'Secret Creator' } });
    await write(prisma, t.organizationId, digest('PIPELINE', 'stale.one', `customer:${c.id}`, { kind: 'STALLED' }));
    await write(prisma, t.organizationId, digest('CREATORS', 'needs-emg', `creator:${creator.id}`));
    // A synthesis that answers NONE: the pass records the decided fingerprint (the cheapest decided state).
    const calls: string[] = [];
    const none = { schemaId: 'situation-synthesis.v1', decision: 'NONE', situationId: null, title: null, narrative: null, claims: [], limitations: [] };
    const s = new SituationService({
      prisma,
      runtime: { run: async (_p: unknown, req: { task: { taskId: string } }) => (calls.push(req.task.taskId), { outcome: 'ANSWERED', output: { situationSynthesis: none }, provenance: { invocationId: 'i', taskVersion: '1', templateVersion: '1', requestedModel: { providerId: 'anthropic', modelId: 'm' } } }) } as never,
      modelEnabled: (id) => id === 'situation.synthesis',
      principalFor: async () => ({ organizationId: t.organizationId, userId: t.userId }),
      now: () => NOW,
    });
    const owner = { scope: 'ORGANIZATION', organizationId: t.organizationId } as const;
    const pass = async () => s.pass(owner);
    assert.deepEqual((await pass()).decisions, { NONE: 1 });
    assert.equal(calls.length, 1);

    // Unrelated inventory: another record joins the same Party (not named by any signal), another creator on
    // another Party, a work origin nobody's reading names. Nothing the cluster rests on changed: no call.
    const c9 = await quoted(prisma, t.organizationId, 'c9@secret.test');
    await prisma.customerPartyLink.create({ data: { organizationId: t.organizationId, customerId: c9.id, partyId: p.id, basis: 'MANUAL', activeCustomerId: c9.id, linkedByUserId: t.userId, linkedAt: at(-3) } });
    await prisma.creatorProfile.create({ data: { organizationId: t.organizationId, partyId: other.id, displayName: 'Secret Creator 2' } });
    let r = await pass();
    assert.deepEqual([r.unchanged, calls.length], [1, 1], 'unrelated inventory churns nothing');

    // The evidence changes (the Creators reading moves): a new decision is owed.
    await write(prisma, t.organizationId, digest('CREATORS', 'needs-emg', `creator:${creator.id}`, { content: { reading: { statement: 'Secret.', status: 'WATCH', confidence: 'MEDIUM' }, signals: [{ key: 'needs-emg', kind: 'OBLIGATION', knowledge: 'OBSERVED', statement: 'Now two productions wait.', entities: [`creator:${creator.id}`], evidenceRefs: ['creators:x'], severity: 'HIGH', occurredAt: at(-1).toISOString() }] } } as never));
    r = await pass();
    assert.deepEqual([r.unchanged, calls.length], [0, 2], 'changed evidence is decided again');

    // The Creator's Party changes: the governed link is gone, and so is the cluster -- nothing is synthesized.
    await prisma.creatorProfile.update({ where: { id: creator.id }, data: { partyId: third.id } });
    r = await pass();
    assert.deepEqual([r.candidates, calls.length], [0, 2]);
    await prisma.creatorProfile.update({ where: { id: creator.id }, data: { partyId: p.id } });
    r = await pass();
    assert.deepEqual([r.candidates, r.unchanged, calls.length], [1, 1, 2], 'restored: the same cluster, still decided');

    // The Party link is reversed: no cluster.
    await prisma.customerPartyLink.update({ where: { id: link.id }, data: { activeCustomerId: null, reversedAt: at(0), reversedByUserId: t.userId } });
    r = await pass();
    assert.deepEqual([r.candidates, calls.length], [0, 2]);

    // One source disappears (the Pipeline reading goes stale): no cluster either.
    await prisma.customerPartyLink.create({ data: { organizationId: t.organizationId, customerId: c.id, partyId: p.id, basis: 'MANUAL', activeCustomerId: c.id, linkedByUserId: t.userId, linkedAt: at(0) } });
    assert.equal((await pass()).candidates, 1);
    await prisma.intelligenceDigest.updateMany({ where: { organizationId: t.organizationId, domain: 'PIPELINE' }, data: { status: 'STALE' } });
    assert.equal((await pass()).candidates, 0);
    assert.equal(calls.length, 2);
  } finally {
    await prisma.organization.delete({ where: { id: t.organizationId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});

test('PIPELINE ELIGIBILITY: an AI’s Party link, an assignment, a workflow step or a future-dated note never makes a record a Pipeline participant', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const t = await tenant(prisma, 'pe');
  try {
    const ai = `u_ai_${randomUUID()}`;
    await prisma.user.create({ data: { id: ai, organizationId: t.organizationId, email: `${ai}@example.test`, name: 'AI', status: 'ACTIVE', metadata: { systemRole: 'AI_EMPLOYEE' } } });
    await prisma.organizationMembership.create({ data: { organizationId: t.organizationId, userId: ai, systemRole: 'AI_EMPLOYEE', status: 'ACTIVE', effectiveFrom: new Date('2026-01-01T00:00:00Z') } });
    const p = await party(prisma, t.organizationId);
    const rec = async () => (await prisma.customer.create({ data: { organizationId: t.organizationId, phone: '+15550000000', metadata: { createdFrom: 'callgrid' }, attributes: { pipelineStatus: 'Quoted' }, createdAt: at(-60), lastSeenAt: at(-60) } })).id;
    const note = (customerId: string, payload: Record<string, unknown>, occurredAt: Date) => prisma.interaction.create({ data: { organizationId: t.organizationId, customerId, channel: 'OTHER', kind: 'NOTE', direction: 'INTERNAL', occurredAt, payload } as never });
    const human = { loopKind: 'crm_note', actorType: 'HUMAN_AGENT', actorUserId: t.userId, actorName: 'x', body: 'b' };
    const aiLinked = await rec();
    await prisma.customerPartyLink.create({ data: { organizationId: t.organizationId, customerId: aiLinked, partyId: p.id, basis: 'MANUAL', activeCustomerId: aiLinked, linkedByUserId: ai, linkedAt: at(-30) } });
    const assigned = await rec();
    await prisma.auditLog.create({ data: { organizationId: t.organizationId, action: 'customer.assignment_changed', entityType: 'customer', entityId: assigned, actorType: 'HUMAN_AGENT', userId: t.userId, createdAt: at(-30) } as never });
    const workflow = await rec();
    await note(workflow, { source: 'workflow' }, at(-30));
    const future = await rec();
    await note(future, human, at(30));
    const worked = await rec();
    await note(worked, human, at(-30));
    const producer = pipelineDomainProducer(new CrmRepository(prisma), new IntakeEligibilityRepository(prisma), new DomainFactsRepository(prisma), KIT as never);
    const named = namedBy(await produce(prisma, producer as never, t.organizationId, 'PIPELINE'));
    assert.deepEqual(named, [`customer:${worked}`], 'only the record a human operator worked');
  } finally {
    await prisma.organization.delete({ where: { id: t.organizationId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});

test('no invented identity: the projector and the Situation clusterer match on governed ids only -- never a phone, email, name, label or time', () => {
  const root = join(__dirname, '..', '..', '..');
  const strip = (path: string) => readFileSync(join(root, path), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ').replace(/\/\/ .*$/gm, ' ');
  const files = [
    'packages/database/src/repositories/intelligence/governed-entity-links.repository.ts',
    'packages/database/src/services/intelligence-fabric/situations.ts',
    'packages/shared/src/situation.ts',
  ];
  for (const file of files) {
    const code = strip(file);
    for (const forbidden of [/\bphone\b/i, /\bemail\b/i, /firstName|lastName|displayName/, /callerNumber|callerId|\bani\b/i, /campaignLabel|buyerLabel/, /\blevenshtein|similarity|fuzzy|soundex/i]) {
      assert.equal(forbidden.test(code), false, `${file} must not match identity by ${forbidden}`);
    }
  }
  // The projector reads only ids and governed columns: no name, contact or label is ever selected.
  const projector = strip(files[0]!);
  const selected = [...projector.matchAll(/select: \{([^}]*)\}/g)].flatMap((m) => m[1]!.split(',').map((s) => s.trim().replace(/: true$/, '')).filter(Boolean));
  assert.deepEqual([...new Set(selected)].sort(), ['content', 'customerId', 'id', 'originKind', 'originRef', 'originScope', 'partyId', 'workInstanceId']);
  assert.equal(/\bmodel\b|runtime|\.run\(/.test(projector), false, 'no model authors a link');
});
