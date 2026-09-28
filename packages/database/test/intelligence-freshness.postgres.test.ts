// Review blocker 1 on #341, against a REAL Postgres (LOOP_TEST_POSTGRES_URL, local only).
//
// An ORGANIZATION (Loop-record) digest has no connection to go stale on, so its runtime freshness is the
// fabric's own refresh state. Driven through the real producer loop and refresh queue, this proves:
//   - a pending refresh keeps a CURRENT reading out of situations AND the Briefing;
//   - a retrying refresh, and a HELD one (even after its row is purged), do too;
//   - NO_EVIDENCE leaves the old reading STALE, never current;
//   - an unchanged successful refresh re-affirms it (no read), and it is eligible again;
//   - a changed successful refresh replaces it, and only the new reading is used.
//   - (2026-09-28) commissioning a domain model task over an existing rule digest, through the real gateway.
//   - (2026-09-28) Campaigns: a campaign that is both a mover and unsold is named once, so the refresh writes
//     CURRENT instead of being HELD as INVALID_ENTITY_REFS; production's HELD rows recover by the normal path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { workRetentionCategory, type AiModelResult, type AiProviderPolicy } from '@emgloop/shared';
import { RecordedModelProvider, aiCatalogCapabilities, AI_ROUTING_POLICY, AI_BUDGET_POLICY, AI_MAX_ATTEMPTS_PER_TARGET } from '@emgloop/providers';
import { AiRuntimeGateway, InMemoryAiUsageLedger } from '../src/services/ai-runtime/gateway';
import { DomainReadingService } from '../src/services/ai-runtime/domain-reading.service';
import { callgridDomainProducer, campaignsDomainProducer } from '../src/services/intelligence-fabric/domains/callgrid';

import { forgetIntelligenceFabricPresence } from '../src/repositories/intelligence/intelligence-fabric-presence';
import { IntelligenceDigestRepository, type IntelligenceDigestInput } from '../src/repositories/intelligence/intelligence-digest.repository';
import { IntelligenceRefreshQueueRepository, type IntelligenceRefreshTarget } from '../src/repositories/intelligence/intelligence-refresh-queue.repository';
import { BriefingComposer } from '../src/services/intelligence-fabric/briefing';
import { IntelligenceProducerRegistry, type IntelligenceProducer } from '../src/services/intelligence-fabric/producer';
import { runIntelligenceProducerCycle } from '../src/services/intelligence-fabric/producer-loop';
import { SituationService } from '../src/services/intelligence-fabric/situations';

const LOCAL = (url: string) => /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url);
const URL = process.env.LOOP_TEST_POSTGRES_URL ?? '';
const skip = !URL ? 'LOOP_TEST_POSTGRES_URL is not set' : !LOCAL(URL) ? 'refusing a non-local database' : false;
const NOW = new Date();
const ENTITY = 'provider_member:callgrid:campaign:fresh1';

const orgDigest = (domain: 'CALLGRID' | 'CAMPAIGNS', statement: string, fingerprint: string): IntelligenceDigestInput => ({
  domain,
  subjectKind: 'DOMAIN',
  provider: null,
  consentBasis: 'LOOP_RECORDS',
  content: { reading: { statement, status: 'WATCH', confidence: 'HIGH' }, signals: [{ key: `${domain.toLowerCase()}.risk`, kind: 'RISK', knowledge: 'OBSERVED', statement, entities: [ENTITY], evidenceRefs: [`${domain.toLowerCase()}:x`], severity: 'HIGH', occurredAt: new Date(NOW.getTime() - 864e5).toISOString() }] },
  coverage: 'CONNECTED_SUFFICIENT',
  windowStart: new Date(NOW.getTime() - 7 * 864e5),
  windowEnd: NOW,
  evidenceCount: 5,
  lastEvidenceAt: NOW,
  provenance: { sourceRefs: [`${domain.toLowerCase()}:x`], producerVersion: `${domain.toLowerCase()}.domain@1#1`, producerKind: 'RULE', sources: [{ sourceId: 'CALLGRID', asOf: NOW.toISOString(), coverage: 'CONNECTED_SUFFICIENT' }] },
  aiInvocationId: null,
  entityRefs: [ENTITY],
  fingerprint,
  generatedAt: NOW,
});

test('ORGANIZATION readings: pending, retrying and HELD refreshes, NO_EVIDENCE, and unchanged and changed refreshes -- through the real loop', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  forgetIntelligenceFabricPresence();
  try {
    const organizationId = `org_fresh_${randomUUID()}`;
    await prisma.organization.create({ data: { id: organizationId, name: 'FRESH', slug: organizationId } });
    const owner = `user_fresh_${randomUUID()}`;
    await prisma.user.create({ data: { id: owner, organizationId, email: `${owner}@example.test`, name: 'F', status: 'ACTIVE', metadata: { systemRole: 'OWNER' } } });
    await prisma.organizationMembership.create({ data: { organizationId, userId: owner, systemRole: 'OWNER', status: 'ACTIVE', effectiveFrom: new Date('2026-01-01T00:00:00Z') } });

    const digests = new IntelligenceDigestRepository(prisma);
    assert.equal((await digests.upsertOrganization(organizationId, orgDigest('CALLGRID', 'Calls are down on one campaign.', 'callgrid:v1'))).outcome, 'WRITTEN');
    assert.equal((await digests.upsertOrganization(organizationId, orgDigest('CAMPAIGNS', 'A campaign carried calls nobody bought.', 'campaigns:v1'))).outcome, 'WRITTEN');

    // The Campaigns producer, driven by `mode`; `reads` counts how often it had to read.
    let mode: { kind: 'READY'; fingerprint: string; statement: string } | { kind: 'NO_EVIDENCE' } | { kind: 'UNAVAILABLE' } = { kind: 'UNAVAILABLE' };
    let reads = 0;
    const producer: IntelligenceProducer<{ statement: string }> = {
      id: 'campaigns.domain@1', domain: 'CAMPAIGNS', scope: 'ORGANIZATION', subjectKinds: ['DOMAIN'], kind: 'RULE', taskId: null,
      gather: async () => (mode.kind === 'READY' ? { status: 'READY', context: { statement: mode.statement }, fingerprint: mode.fingerprint } : mode.kind === 'NO_EVIDENCE' ? { status: 'NO_EVIDENCE' } : { status: 'UNAVAILABLE', reason: 'test' }),
      read: async (_t, ctx, fingerprint) => {
        reads += 1;
        return { status: 'READ', digest: orgDigest('CAMPAIGNS', ctx.statement, fingerprint) };
      },
    };
    let clock = NOW.getTime();
    const now = () => new Date(clock);
    const queue = new IntelligenceRefreshQueueRepository(prisma);
    const target: IntelligenceRefreshTarget = { scope: 'ORGANIZATION', organizationId, domain: 'CAMPAIGNS', subjectKind: 'DOMAIN', subjectRef: 'domain' };
    const cycle = (maxAttempts: number) => {
      clock += 10 * 60_000; // past any backoff
      return runIntelligenceProducerCycle({ queue, digests, registry: new IntelligenceProducerRegistry([producer], ['campaigns.domain@1']), leaseOwner: 'test', now }, { limit: 10, leaseMs: 60_000, maxAttempts });
    };

    // Is the Campaigns reading usable for synthesis right now -- by situations AND by the Briefing?
    const situations = new SituationService({ prisma, runtime: null, modelEnabled: () => false, principalFor: async () => null, now });
    const briefing = new BriefingComposer({ prisma, runtime: null, modelEnabled: () => false, now, observed: { principal: [], organization: ['CALLGRID', 'CAMPAIGNS'] } });
    const usable = async () => {
      const s = await situations.pass({ scope: 'ORGANIZATION', organizationId });
      const b = await briefing.gather({ organizationId, userId: owner }, now());
      const art = b.artifacts.find((a) => a.domain === 'CAMPAIGNS');
      assert.equal(s.candidates === 1, !!art, 'situations and the Briefing agree');
      return art ? art.statement : null;
    };

    assert.equal(await usable(), 'A campaign carried calls nobody bought.', 'baseline: current and eligible');

    // 1. A PENDING refresh: Loop asked and does not know yet.
    assert.equal((await queue.enqueue(target, { reason: 'SCHEDULED' }, now())).outcome, 'ENQUEUED');
    assert.equal(await usable(), null, 'a pending refresh keeps the reading out');

    // 2. RETRYING: the gather failed transiently; the request is PENDING again with an attempt recorded.
    mode = { kind: 'UNAVAILABLE' };
    assert.equal((await cycle(3)).retried, 1);
    assert.equal(await usable(), null, 'a retrying refresh keeps it out');
    assert.equal((await prisma.intelligenceDigest.findFirst({ where: { organizationId, domain: 'CAMPAIGNS' } }))!.status, 'CURRENT', 'still stored as it was');

    // 3. HELD: attempts exhausted. The reading is STALE, and stays out even after the HELD row is purged.
    assert.equal((await cycle(2)).held, 1);
    assert.equal((await prisma.intelligenceRefreshRequest.findFirst({ where: { organizationId } }))!.state, 'HELD');
    assert.equal((await prisma.intelligenceDigest.findFirst({ where: { organizationId, domain: 'CAMPAIGNS' } }))!.status, 'STALE');
    await prisma.intelligenceRefreshRequest.deleteMany({ where: { organizationId } });
    assert.equal(await usable(), null, 'a held refresh never falls back to current');

    // 4. An UNCHANGED successful refresh re-affirms it -- no read -- and it is eligible again.
    mode = { kind: 'READY', fingerprint: 'campaigns:v1', statement: 'ignored: not read' };
    await queue.enqueue(target, { reason: 'SCHEDULED' }, now());
    const unchanged = await cycle(3);
    assert.equal(unchanged.skippedUnchangedBeforeRead, 1);
    assert.equal(reads, 0, 'nothing was read');
    assert.equal(await usable(), 'A campaign carried calls nobody bought.');

    // 5. NO_EVIDENCE: the evidence behind the reading is gone; it cannot keep feeding synthesis.
    mode = { kind: 'NO_EVIDENCE' };
    await queue.enqueue(target, { reason: 'SCHEDULED' }, now());
    assert.equal((await cycle(3)).noEvidence, 1);
    assert.equal(await prisma.intelligenceRefreshRequest.count({ where: { organizationId } }), 0, 'the request completed');
    assert.equal(await usable(), null, 'an old positive reading does not survive NO_EVIDENCE');

    // 6. A CHANGED successful refresh: a new current reading, and only it is used.
    mode = { kind: 'READY', fingerprint: 'campaigns:v2', statement: 'The campaign is buying again.' };
    await queue.enqueue(target, { reason: 'SCHEDULED' }, now());
    assert.equal((await cycle(3)).written, 1);
    assert.equal(reads, 1);
    assert.equal(await usable(), 'The campaign is buying again.');
    assert.equal(await prisma.intelligenceDigest.count({ where: { organizationId, domain: 'CAMPAIGNS' } }), 1, 'one reading: the old one is replaced, not kept beside it');
  } finally {
    await prisma.$disconnect();
  }
});

// --- Fail-closed failure handling (review round 3) -------------------------------------------------------

/** One organization with a current CallGrid + Campaigns pair, a Campaigns producer, and the probes. */
async function world(prisma: PrismaClient, opts: { staleFails?: () => boolean } = {}) {
  const organizationId = `org_fc_${randomUUID()}`;
  await prisma.organization.create({ data: { id: organizationId, name: 'FC', slug: organizationId } });
  const owner = `user_fc_${randomUUID()}`;
  await prisma.user.create({ data: { id: owner, organizationId, email: `${owner}@example.test`, name: 'F', status: 'ACTIVE', metadata: { systemRole: 'OWNER' } } });
  await prisma.organizationMembership.create({ data: { organizationId, userId: owner, systemRole: 'OWNER', status: 'ACTIVE', effectiveFrom: new Date('2026-01-01T00:00:00Z') } });
  const real = new IntelligenceDigestRepository(prisma);
  await real.upsertOrganization(organizationId, orgDigest('CALLGRID', 'Calls are down on one campaign.', 'callgrid:v1'));
  await real.upsertOrganization(organizationId, orgDigest('CAMPAIGNS', 'A campaign carried calls nobody bought.', 'campaigns:v1'));
  // The loop's digest door, with an injectable stale-transition failure; everything else is the real repository.
  const digests = new Proxy(real, {
    get(target, key) {
      if (key === 'markTargetStale' && opts.staleFails?.()) return async () => { throw new Error('transient database failure'); };
      const v = Reflect.get(target, key);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  }) as IntelligenceDigestRepository;
  const state = { mode: { kind: 'NO_EVIDENCE' } as { kind: 'READY'; fingerprint: string; statement: string } | { kind: 'NO_EVIDENCE' } | { kind: 'UNAVAILABLE' } | { kind: 'TERMINAL' }, reads: 0 };
  const producer: IntelligenceProducer<{ statement: string }> = {
    id: 'campaigns.domain@1', domain: 'CAMPAIGNS', scope: 'ORGANIZATION', subjectKinds: ['DOMAIN'], kind: 'RULE', taskId: null,
    gather: async () => {
      const m = state.mode;
      if (m.kind === 'READY') return { status: 'READY', context: { statement: m.statement }, fingerprint: m.fingerprint };
      if (m.kind === 'NO_EVIDENCE') return { status: 'NO_EVIDENCE' };
      if (m.kind === 'TERMINAL') return { status: 'NOT_PERMITTED', reason: 'test' };
      return { status: 'UNAVAILABLE', reason: 'test' };
    },
    read: async (_t, ctx, fingerprint) => {
      state.reads += 1;
      return { status: 'READ', digest: orgDigest('CAMPAIGNS', ctx.statement, fingerprint) };
    },
  };
  let clock = NOW.getTime();
  const now = () => new Date(clock);
  const queue = new IntelligenceRefreshQueueRepository(prisma);
  const target: IntelligenceRefreshTarget = { scope: 'ORGANIZATION', organizationId, domain: 'CAMPAIGNS', subjectKind: 'DOMAIN', subjectRef: 'domain' };
  const cycle = (maxAttempts = 3) => {
    clock += 10 * 60_000;
    return runIntelligenceProducerCycle({ queue, digests, registry: new IntelligenceProducerRegistry([producer], ['campaigns.domain@1']), leaseOwner: 'test', now }, { limit: 10, leaseMs: 60_000, maxAttempts });
  };
  const situations = new SituationService({ prisma, runtime: null, modelEnabled: () => false, principalFor: async () => null, now });
  const briefing = new BriefingComposer({ prisma, runtime: null, modelEnabled: () => false, now, observed: { principal: [], organization: ['CALLGRID', 'CAMPAIGNS'] } });
  const usable = async () => {
    const s = await situations.pass({ scope: 'ORGANIZATION', organizationId });
    const art = (await briefing.gather({ organizationId, userId: owner }, now())).artifacts.find((a) => a.domain === 'CAMPAIGNS');
    assert.equal(s.candidates === 1, !!art, 'situations and the Briefing agree');
    return art ? art.statement : null;
  };
  const status = async () => (await prisma.intelligenceDigest.findFirst({ where: { organizationId, domain: 'CAMPAIGNS' }, select: { status: true } }))!.status;
  const rows = () => prisma.intelligenceRefreshRequest.findMany({ where: { organizationId }, select: { state: true, lastOutcome: true } });
  return { organizationId, state, queue, target, cycle, usable, status, rows, now };
}

test('FAIL CLOSED: NO_EVIDENCE with a failed stale transition keeps the barrier (the request is retried, not completed) and the CURRENT reading out', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  forgetIntelligenceFabricPresence();
  try {
    let fail = true;
    const w = await world(prisma, { staleFails: () => fail });
    w.state.mode = { kind: 'NO_EVIDENCE' };
    await w.queue.enqueue(w.target, { reason: 'SCHEDULED' }, w.now());
    const report = await w.cycle();
    assert.equal(report.outcomes.STALE_TRANSITION_FAILED, 2, 'recorded, not swallowed');
    assert.equal(await w.status(), 'CURRENT', 'the stale write failed');
    assert.deepEqual(await w.rows(), [{ state: 'PENDING', lastOutcome: 'STALE_TRANSITION_FAILED' }], 'the barrier was NOT removed');
    assert.equal(await w.usable(), null, 'the old CURRENT reading does not become eligible');
    // The database recovers: the next pass marks it STALE and only THEN removes the barrier.
    fail = false;
    await w.cycle();
    assert.equal(await w.status(), 'STALE');
    assert.deepEqual(await w.rows(), []);
    assert.equal(await w.usable(), null, 'with the queue row gone, the reading stays STALE and out');
  } finally {
    await prisma.$disconnect();
  }
});

test('FAIL CLOSED: a terminal failure with a failed stale write stays blocked; HELD cleanup moves the reading and removes the row together', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  forgetIntelligenceFabricPresence();
  try {
    const w = await world(prisma, { staleFails: () => true });
    w.state.mode = { kind: 'TERMINAL' };
    await w.queue.enqueue(w.target, { reason: 'SCHEDULED' }, w.now());
    await w.cycle();
    assert.equal(await w.status(), 'CURRENT', 'the stale write failed');
    assert.deepEqual((await w.rows()).map((r) => r.state), ['HELD'], 'held regardless: the barrier stays');
    assert.equal(await w.usable(), null);
    // Retries that exhaust into HELD, with the stale write failing: still blocked.
    const w2 = await world(prisma, { staleFails: () => true });
    w2.state.mode = { kind: 'UNAVAILABLE' };
    await w2.queue.enqueue(w2.target, { reason: 'SCHEDULED' }, w2.now());
    await w2.cycle(1);
    await w2.cycle(1);
    assert.deepEqual((await w2.rows()).map((r) => r.state), ['HELD']);
    assert.equal(await w2.status(), 'CURRENT');
    assert.equal(await w2.usable(), null);
    // Cleanup of HELD work: the reading leaves CURRENT in the same transaction the row is deleted in.
    const { purged } = await w.queue.purgeHeld(new Date(Date.now() + 864e5), { organizationIds: [w.organizationId, w2.organizationId] });
    assert.ok(purged >= 2);
    for (const x of [w, w2]) {
      assert.deepEqual(await x.rows(), []);
      assert.equal(await x.status(), 'STALE', 'cleanup could not expose a CURRENT reading');
      assert.equal(await x.usable(), null);
    }
  } finally {
    await prisma.$disconnect();
  }
});

test('with the stale transition working: NO_EVIDENCE leaves the reading STALE after its row is gone; an unchanged refresh re-affirms it; a changed one replaces it', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  forgetIntelligenceFabricPresence();
  try {
    const w = await world(prisma);
    w.state.mode = { kind: 'NO_EVIDENCE' };
    await w.queue.enqueue(w.target, { reason: 'SCHEDULED' }, w.now());
    await w.cycle();
    assert.deepEqual(await w.rows(), []);
    assert.equal(await w.status(), 'STALE');
    assert.equal(await w.usable(), null);
    w.state.mode = { kind: 'READY', fingerprint: 'campaigns:v1', statement: 'not read' };
    await w.queue.enqueue(w.target, { reason: 'SCHEDULED' }, w.now());
    await w.cycle();
    assert.equal(w.state.reads, 0, 're-affirmed without a read');
    assert.equal(await w.usable(), 'A campaign carried calls nobody bought.');
    w.state.mode = { kind: 'READY', fingerprint: 'campaigns:v2', statement: 'The campaign is buying again.' };
    await w.queue.enqueue(w.target, { reason: 'SCHEDULED' }, w.now());
    await w.cycle();
    assert.equal(await w.usable(), 'The campaign is buying again.');
  } finally {
    await prisma.$disconnect();
  }
});

test('the unresolved-refresh lookup asks for EXACT targets: 5,100 unrelated queued rows cannot crowd out the one that matters', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const cleanup: string[] = [];
  forgetIntelligenceFabricPresence();
  try {
    const w = await world(prisma);
    // Unrelated unresolved work, in the same organization and domain, created first. CLAIMED under a
    // far-future lease: unresolved (so it would crowd any capped scan) yet never claimable by other tests'
    // loops, which claim platform-wide, and never purged.
    const t0 = new Date(NOW.getTime() - 3600_000);
    await prisma.intelligenceRefreshRequest.createMany({
      data: Array.from({ length: 5100 }, (_, i) => ({ organizationId: w.organizationId, scope: 'ORGANIZATION', userId: null, domain: 'CAMPAIGNS', subjectKind: 'ENTITY', subjectRef: `provider_member:callgrid:campaign:other${i}`, reason: 'SCHEDULED', firstRequestedAt: t0, lastRequestedAt: t0, notBefore: t0, state: 'CLAIMED', leaseOwner: 'unrelated', leaseExpiresAt: new Date(NOW.getTime() + 365 * 864e5) })),
    });
    cleanup.push(w.organizationId);
    assert.equal(await w.usable(), 'A campaign carried calls nobody bought.', 'unrelated work does not block this reading');
    await w.queue.enqueue(w.target, { reason: 'SCHEDULED' }, w.now());
    assert.equal(await prisma.intelligenceRefreshRequest.count({ where: { organizationId: w.organizationId } }), 5101);
    assert.equal(await w.usable(), null, 'the exact target is found, whatever else is queued');
  } finally {
    for (const organizationId of cleanup) await prisma.intelligenceRefreshRequest.deleteMany({ where: { organizationId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});

// --- HELD retention (the worker's retention sweep calls purgeHeld with the governed cutoff) ---------------

test('HELD retention: newer HELD stays; older HELD is purged with its CURRENT reading moved STALE; a failed transaction leaves both; PENDING and CLAIMED are never removed', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  forgetIntelligenceFabricPresence();
  const orgs: string[] = [];
  try {
    const DAY = 864e5;
    const policyDays = 7; // asserted against the governed policy below
    assert.equal(workRetentionCategory('INTELLIGENCE_REFRESH_REQUESTS')!.days, policyDays);
    const cutoff = new Date(Date.now() - policyDays * DAY);
    const old = new Date(cutoff.getTime() - DAY);
    const held = async (fresh: boolean) => {
      const w = await world(prisma);
      orgs.push(w.organizationId);
      const row = await prisma.intelligenceRefreshRequest.create({ data: { organizationId: w.organizationId, scope: 'ORGANIZATION', userId: null, domain: 'CAMPAIGNS', subjectKind: 'DOMAIN', subjectRef: 'domain', reason: 'SCHEDULED', firstRequestedAt: old, lastRequestedAt: old, notBefore: old, state: 'HELD', lastOutcome: 'NOT_PERMITTED' } });
      if (!fresh) await prisma.intelligenceRefreshRequest.updateMany({ where: { id: row.id }, data: { updatedAt: old } });
      return w;
    };
    const recent = await held(true);
    const expired = await held(false);
    const failing = await held(false);
    // Unresolved work that is not HELD, older than the window: never the retention sweep's to remove.
    const other = await world(prisma);
    orgs.push(other.organizationId);
    const base = { organizationId: other.organizationId, scope: 'ORGANIZATION', userId: null, domain: 'WEBSITE', reason: 'SCHEDULED', firstRequestedAt: old, lastRequestedAt: old, notBefore: new Date(Date.now() + 365 * DAY) };
    await prisma.intelligenceRefreshRequest.create({ data: { ...base, subjectKind: 'ENTITY', subjectRef: 'web_property:pending', state: 'PENDING' } });
    await prisma.intelligenceRefreshRequest.create({ data: { ...base, subjectKind: 'ENTITY', subjectRef: 'web_property:claimed', state: 'CLAIMED', leaseOwner: 'someone', leaseExpiresAt: new Date(Date.now() + 365 * DAY) } });
    await prisma.intelligenceRefreshRequest.updateMany({ where: { organizationId: other.organizationId }, data: { updatedAt: old } });

    // A transaction that fails: both the HELD barrier and the CURRENT reading remain.
    const broken = new Proxy(prisma, { get: (t, k) => (k === '$transaction' ? async () => { throw new Error('transaction failed'); } : Reflect.get(t, k)) }) as PrismaClient;
    assert.deepEqual(await new IntelligenceRefreshQueueRepository(broken).purgeHeld(cutoff, { organizationIds: [failing.organizationId] }), { purged: 0 });
    assert.deepEqual((await failing.rows()).map((r) => r.state), ['HELD']);
    assert.equal(await failing.status(), 'CURRENT');
    assert.equal(await failing.usable(), null, 'still blocked');

    const { purged } = await new IntelligenceRefreshQueueRepository(prisma).purgeHeld(cutoff, { organizationIds: orgs });
    assert.equal(purged, 2, 'the two HELD rows past the window, nothing else');
    assert.deepEqual((await recent.rows()).map((r) => r.state), ['HELD'], 'a HELD request inside the window remains');
    assert.equal(await recent.status(), 'CURRENT', 'and its reading is untouched (the row still blocks it)');
    for (const x of [expired, failing]) {
      assert.deepEqual(await x.rows(), []);
      assert.equal(await x.status(), 'STALE', 'moved out of CURRENT with the row, never after');
      assert.equal(await x.usable(), null);
    }
    assert.deepEqual((await prisma.intelligenceRefreshRequest.findMany({ where: { organizationId: other.organizationId }, select: { state: true }, orderBy: { state: 'asc' } })).map((r) => r.state), ['CLAIMED', 'PENDING']);
  } finally {
    for (const organizationId of orgs) await prisma.intelligenceRefreshRequest.deleteMany({ where: { organizationId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});

// --- Commissioning a domain model task over an existing rule digest (2026-09-28) --------------------------
// In this file so it runs sequentially with the other loop-driving tests (lease recovery is platform-wide).

const COMMISSIONING_POLICY: readonly AiProviderPolicy[] = [{ providerId: 'anthropic', state: 'ACTIVE', ceiling: 'COMMUNICATION_CONTENT', version: 1, recordedAtMs: 0 }];

const answer: AiModelResult = {
  output: { json: { schemaId: 'domain-reading.v1', reading: { statement: 'Calls held steady this week.', status: 'CALM', confidence: 'MEDIUM' }, signals: [{ key: 'steady', kind: 'OPERATIONAL', knowledge: 'INFERRED', statement: 'Calls held steady.', entities: [], evidenceRefs: ['marketplace_calls:7d'], occurredAt: null, dueAt: null, confidence: 'MEDIUM', severity: 'LOW', owedBy: null }], limitations: [] } },
  toolCalls: [],
  stopReason: 'END',
  usage: { inputTokens: 900, outputTokens: 120 },
  providerRequestId: 'req_1',
  reportedModel: 'claude-opus-5',
  latencyMs: 40,
};

test('COMMISSIONING: activating callgrid.domain.reading over an unchanged rule digest makes exactly one model-backed refresh; no repeats; disabling is honest; refusals are observable and re-attempted', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  forgetIntelligenceFabricPresence();
  try {
    const organizationId = `org_comm_${randomUUID()}`;
    await prisma.organization.create({ data: { id: organizationId, name: 'COMM', slug: organizationId } });
    const operator = 'user_operator';

    // The real gateway; its activation is read on every call, so the test can commission and decommission.
    const activation = { enabled: true, organizations: [organizationId] as string[], tasks: ['telegram.content.triage'] as string[], providers: ['anthropic'] as string[] };
    const ledger = new InMemoryAiUsageLedger();
    const provider = new RecordedModelProvider('anthropic', [{ modelId: 'claude-opus-5', result: answer }], (m) => aiCatalogCapabilities('anthropic', m));
    const gateway = new AiRuntimeGateway(
      { activation, policy: AI_ROUTING_POLICY, budget: AI_BUDGET_POLICY, killSwitches: [], maxAttemptsPerTarget: AI_MAX_ATTEMPTS_PER_TARGET },
      { providers: [provider], ledger, authorize: async () => true, now: () => new Date(), newInvocationId: () => `inv_${randomUUID()}`, providerPolicies: async () => COMMISSIONING_POLICY },
    );
    const dim = { key: 'c1', label: 'c1', calls: 40, monetized: 30, converted: 0, revenueCents: 400000, payoutCents: 200000, costCents: 0, callsWithRevenue: 40, callsWithPayout: 40, callsWithCost: 0 };
    const agg = { calls: 40, monetized: 30, converted: 0, revenueCents: 400000, payoutCents: 200000, costCents: 0, callsWithRevenue: 40, callsWithPayout: 40, callsWithCost: 0, buyers: [dim], vendors: [], sources: [], campaigns: [dim] };
    const calls = { firstCallAt: async () => new Date('2026-01-01'), aggregateWindow: async () => agg, organizationIdsWithCallsSince: async () => [] };
    // The worker's modelEnabled is its activation list: the same list the gateway enforces.
    const producer = callgridDomainProducer(calls as never, { modelEnabled: (id) => activation.tasks.includes(id), reader: new DomainReadingService(gateway), principalFor: async () => ({ organizationId, userId: operator }) });

    // Frozen at the real start time: the evidence fingerprint (bucketed hourly) is genuinely unchanged across
    // passes, and lease recovery (platform-wide) never sees a skewed clock from this test.
    const frozen = new Date();
    const now = () => frozen;
    const queue = new IntelligenceRefreshQueueRepository(prisma);
    const digests = new IntelligenceDigestRepository(prisma);
    const target: IntelligenceRefreshTarget = { scope: 'ORGANIZATION', organizationId, domain: 'CALLGRID', subjectKind: 'DOMAIN', subjectRef: 'domain' };
    const pass = async () => {
      await queue.enqueue(target, { reason: 'SCHEDULED' }, now());
      return runIntelligenceProducerCycle({ queue, digests, registry: new IntelligenceProducerRegistry([producer], ['callgrid.domain@1']), leaseOwner: 'commissioning-test', now }, { limit: 50, leaseMs: 60_000, maxAttempts: 3 });
    };
    const stored = async () => {
      const row = await prisma.intelligenceDigest.findFirst({ where: { organizationId, domain: 'CALLGRID' }, select: { provenance: true, fingerprint: true, content: true } });
      return { kind: (row!.provenance as { producerKind: string }).producerKind, fingerprint: row!.fingerprint, statement: (row!.content as { reading: { statement: string } }).reading.statement };
    };

    // 1. Rule only: the task is not activated.
    const r1 = await pass();
    assert.equal(r1.written, 1);
    assert.deepEqual(r1.modelStages, { MODEL_NOT_ACTIVATED: 1 });
    assert.equal((await stored()).kind, 'RULE');
    assert.equal(ledger.calls.length, 0);

    // 2. Commission the task: the evidence is unchanged, the reading configuration is not -> ONE model call.
    activation.tasks.push('callgrid.domain.reading');
    const r2 = await pass();
    assert.equal(r2.skippedUnchangedBeforeRead, 0, 'the cost gate saw the new reading configuration');
    assert.deepEqual(r2.modelStages, { MODEL_READ: 1 });
    assert.equal(ledger.calls.length, 1);
    assert.equal(ledger.calls[0]!.taskId, 'callgrid.domain.reading');
    assert.equal(ledger.calls[0]!.lane, 'BACKGROUND');
    const commissioned = await stored();
    assert.equal(commissioned.kind, 'RULE_AND_MODEL');
    assert.equal(commissioned.statement, 'Calls held steady this week.');

    // 3. Unchanged after that: skipped before the read, zero repeat calls.
    for (let i = 0; i < 3; i += 1) assert.equal((await pass()).skippedUnchangedBeforeRead, 1);
    assert.equal(ledger.calls.length, 1, 'no repeat calls');

    // 4. Decommission: the stored model reading is replaced by an honest RULE reading -- no call, no pretence.
    activation.tasks.splice(activation.tasks.indexOf('callgrid.domain.reading'), 1);
    const r4 = await pass();
    assert.deepEqual(r4.modelStages, { MODEL_NOT_ACTIVATED: 1 });
    assert.equal((await stored()).kind, 'RULE');
    assert.equal(ledger.calls.length, 1);

    // 5. A Loop refusal (the organization is not enabled): named, no reservation, the rule reading stays
    //    honest, and it is re-attempted next pass (its fingerprint is unsatisfied, never `expected`).
    activation.tasks.push('callgrid.domain.reading');
    activation.organizations.splice(0, 1);
    const r5 = await pass();
    assert.deepEqual(r5.modelStages, { 'REFUSED_BY_LOOP:ORGANIZATION_NOT_ENABLED': 1 });
    assert.equal(ledger.calls.length, 1, 'refused before any reservation');
    assert.equal((await stored()).kind, 'RULE');
    const r5b = await pass();
    assert.equal(r5b.skippedUnchangedBeforeRead, 0, 're-attempted, not frozen');
    assert.deepEqual(r5b.modelStages, { 'REFUSED_BY_LOOP:ORGANIZATION_NOT_ENABLED': 1 });
    // The configuration is fixed: the next pass commissions it.
    activation.organizations.push(organizationId);
    const r6 = await pass();
    assert.deepEqual(r6.modelStages, { MODEL_READ: 1 });
    assert.equal((await stored()).kind, 'RULE_AND_MODEL');
    assert.equal(ledger.calls.length, 2);
    assert.equal((await pass()).skippedUnchangedBeforeRead, 1);
    assert.equal(ledger.calls.length, 2);
    // The report carries codes and counts only.
    assert.equal(JSON.stringify([r1, r2, r4, r5, r6]).includes(organizationId), false);
  } finally {
    await prisma.$disconnect();
  }
});

// --- Campaigns: INVALID_ENTITY_REFS (production, 2026-09-28) ----------------------------------------------
// Every Campaigns refresh was HELD with INVALID_ENTITY_REFS. campaignsRule named a campaign that both moved
// sharply AND sold nothing twice in the digest's entityRefs; the real repository refuses a repeated reference
// (DUPLICATE_KEY). Here, against the real repository, queue and gateway.

test('CAMPAIGNS: a campaign that moved AND sold nothing is named once; from production state the repaired pass writes CURRENT and resolves exactly its superseded HELD rows; malformed refs are still refused', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  forgetIntelligenceFabricPresence();
  try {
    const organizationId = `org_camp_${randomUUID()}`;
    await prisma.organization.create({ data: { id: organizationId, name: 'CAMP', slug: organizationId } });
    const REF = 'provider_member:callgrid:campaign:c1';
    const dim = (key: string, calls: number, monetized: number) => ({ key, label: key, calls, monetized, converted: 0, revenueCents: 0, payoutCents: 0, costCents: 0, callsWithRevenue: 0, callsWithPayout: 0, callsWithCost: 0 });
    const agg = (campaigns: ReturnType<typeof dim>[]) => ({ calls: campaigns.reduce((n, c) => n + c.calls, 0), monetized: campaigns.reduce((n, c) => n + c.monetized, 0), converted: 0, revenueCents: 0, payoutCents: 0, costCents: 0, callsWithRevenue: 0, callsWithPayout: 0, callsWithCost: 0, buyers: [], vendors: [], sources: [], campaigns });
    // c1: 10 -> 40 calls (+300%, a mover) and none billable (unsold). c2: steady and sold.
    const current = agg([dim('c1', 40, 0), dim('c2', 30, 30)]);
    const prior = agg([dim('c1', 10, 0), dim('c2', 30, 30)]);
    // Only this organization has calls: a claim of anyone else's CAMPAIGNS request gathers nothing.
    const calls = {
      firstCallAt: async (org: string) => (org === organizationId ? new Date('2026-01-01') : null),
      aggregateWindow: async (_org: string, from: Date) => (from.getTime() < Date.now() - 8 * 24 * 3600_000 ? prior : current),
      organizationIdsWithCallsSince: async () => [organizationId],
    };
    // A model answer that cites the campaign too (a model-added signal naming a supplied entity).
    const modelAnswer: AiModelResult = {
      ...answer,
      output: { json: { schemaId: 'domain-reading.v1', reading: { statement: 'One campaign is growing on calls nobody buys.', status: 'ATTENTION', confidence: 'MEDIUM' }, signals: [{ key: 'unsold-growth', kind: 'RISK', knowledge: 'INFERRED', statement: 'A growing campaign is not being bought.', entities: [REF], evidenceRefs: ['marketplace_calls:7d'], occurredAt: null, dueAt: null, confidence: 'MEDIUM', severity: 'HIGH', owedBy: null }], limitations: [] } },
    };
    const ledger = new InMemoryAiUsageLedger();
    const gateway = new AiRuntimeGateway(
      { activation: { enabled: true, organizations: [organizationId], tasks: ['campaigns.domain.reading'], providers: ['anthropic'] }, policy: AI_ROUTING_POLICY, budget: AI_BUDGET_POLICY, killSwitches: [], maxAttemptsPerTarget: AI_MAX_ATTEMPTS_PER_TARGET },
      { providers: [new RecordedModelProvider('anthropic', [{ modelId: 'claude-opus-5', result: modelAnswer }], (m) => aiCatalogCapabilities('anthropic', m))], ledger, authorize: async () => true, now: () => new Date(), newInvocationId: () => `inv_${randomUUID()}`, providerPolicies: async () => COMMISSIONING_POLICY },
    );
    const producer = campaignsDomainProducer(calls as never, { modelEnabled: (id) => id === 'campaigns.domain.reading', reader: new DomainReadingService(gateway), principalFor: async () => ({ organizationId, userId: 'user_operator' }) });
    const frozen = new Date();
    // The loop's clock. Moved past the seeded rows before the pass, as a real later pass would be.
    let clock = frozen;
    const now = () => clock;
    const queue = new IntelligenceRefreshQueueRepository(prisma);
    const digests = new IntelligenceDigestRepository(prisma);
    const target: IntelligenceRefreshTarget = { scope: 'ORGANIZATION', organizationId, domain: 'CAMPAIGNS', subjectKind: 'DOMAIN', subjectRef: 'domain' };
    const owner = { scope: 'ORGANIZATION', organizationId } as const;

    // 1. The root cause, reproduced on the REAL repository: the digest this producer wrote before the fix
    //    (the same campaign named twice) is refused -- INVALID_ENTITY_REFS, exactly what production held.
    const g = await producer.gather(target, frozen);
    assert.equal(g.status, 'READY');
    const read = await producer.read(target, (g as { context: never }).context, 'campaigns:repro', frozen);
    assert.equal(read.status, 'READ');
    const digest = (read as { digest: IntelligenceDigestInput }).digest;
    assert.deepEqual(digest.entityRefs, [REF], 'named once, canonical identity unchanged');
    assert.deepEqual(
      (digest.content.signals as { key: string; entities?: string[] }[]).filter((s) => s.entities?.includes(REF)).map((s) => s.key).sort(),
      ['campaign.provider_member_callgrid_campaign_c1', 'm.unsold-growth', 'unsold.c1'],
      'both rule signals and the model signal still name the campaign',
    );
    assert.equal((await digests.upsertOrganization(organizationId, { ...digest, entityRefs: [REF, REF] })).outcome, 'REFUSED');
    assert.deepEqual(await digests.upsertOrganization(organizationId, { ...digest, entityRefs: [REF, REF] }), { outcome: 'REFUSED', refusal: 'INVALID_ENTITY_REFS' });

    // 2. Malformed references are still refused -- the validation is not weakened.
    for (const [refs, refusal] of [
      [['provider_member:callgrid:campaign:has space'], 'INVALID_ENTITY_REFS'],
      [['provider_member:callgrid:planet:c1'], 'INVALID_ENTITY_REFS'],
      [['campaign_name:Acme'], 'INVALID_ENTITY_REFS'],
      [['c1'], 'INVALID_ENTITY_REFS'],
      [Array.from({ length: 33 }, (_, i) => `provider_member:callgrid:campaign:c${i}`), 'INVALID_ENTITY_REFS'],
      [['work_event:ev1'], 'PRIVATE_EVIDENCE'],
    ] as const) {
      assert.deepEqual(await digests.upsertOrganization(organizationId, { ...digest, entityRefs: [...refs] }), { outcome: 'REFUSED', refusal }, JSON.stringify(refs).slice(0, 60));
    }
    assert.equal(await prisma.intelligenceDigest.count({ where: { organizationId } }), 0, 'nothing refused was written');

    // 3. Production's state: an older reading now STALE, and three HELD INVALID_ENTITY_REFS requests for the
    //    exact target -- plus HELD rows that are NOT this target's (another domain, another organization's
    //    CAMPAIGNS, another subject), which must come through byte-identical.
    const stale = { ...digest, entityRefs: [REF], fingerprint: 'campaigns:before', content: { ...digest.content, reading: { statement: 'An older reading.', status: 'CALM' as const, confidence: 'MEDIUM' as const } } };
    assert.equal((await digests.upsertOrganization(organizationId, stale)).outcome, 'WRITTEN');
    await digests.markTargetStale(owner, target);
    const heldRow = (org: string, patch: Record<string, unknown> = {}) =>
      prisma.intelligenceRefreshRequest.create({ data: { organizationId: org, scope: 'ORGANIZATION', userId: null, domain: 'CAMPAIGNS', subjectKind: 'DOMAIN', subjectRef: 'domain', reason: 'SCHEDULED', firstRequestedAt: frozen, lastRequestedAt: frozen, notBefore: frozen, state: 'HELD', attempts: 1, lastOutcome: 'INVALID_ENTITY_REFS', ...patch } });
    const held: string[] = [];
    for (let i = 0; i < 3; i += 1) held.push((await heldRow(organizationId)).id);
    const otherOrg = `org_camp_other_${randomUUID()}`;
    await prisma.organization.create({ data: { id: otherOrg, name: 'CAMP OTHER', slug: otherOrg } });
    const unrelated = [
      (await heldRow(organizationId, { domain: 'CALLGRID', lastOutcome: 'NOT_PERMITTED' })).id,
      (await heldRow(organizationId, { subjectKind: 'ENTITY', subjectRef: REF })).id,
      (await heldRow(otherOrg)).id,
    ];
    const unrelatedBefore = await prisma.intelligenceRefreshRequest.findMany({ where: { id: { in: unrelated } }, orderBy: { id: 'asc' } });
    const heldFor = () => prisma.intelligenceRefreshRequest.count({ where: { organizationId, scope: 'ORGANIZATION', userId: null, domain: 'CAMPAIGNS', subjectKind: 'DOMAIN', subjectRef: 'domain', state: 'HELD' } });
    assert.equal(await heldFor(), 3);

    // 4. Enqueueing or claiming a fresh request clears nothing: the barrier stands until a reading lands.
    clock = new Date(Date.now() + 5);
    assert.equal((await queue.enqueue(target, { reason: 'SCHEDULED' }, now())).outcome, 'ENQUEUED');
    assert.equal(await heldFor(), 3, 'an enqueue is not a success');

    // 5. The normal repaired pass: the fresh request is claimed, read and written CURRENT -- and, in the same
    //    breath, the three superseded HELD rows for this exact target are resolved.
    const report = await runIntelligenceProducerCycle({ queue, digests, registry: new IntelligenceProducerRegistry([producer], ['campaigns.domain@1']), leaseOwner: 'campaigns-test', now }, { limit: 50, leaseMs: 60_000, maxAttempts: 3 });
    assert.equal(report.held, 0, 'not held');
    assert.ok(report.written >= 1);
    assert.deepEqual(report.modelStages, { MODEL_READ: 1 });
    assert.equal(report.outcomes.SUPERSEDED_HELD_RESOLVED, 3);
    const row = await prisma.intelligenceDigest.findFirst({ where: { organizationId, domain: 'CAMPAIGNS' }, select: { status: true, entityRefs: true, provenance: true } });
    assert.equal(row!.status, 'CURRENT', 'the STALE reading is replaced by a CURRENT one');
    assert.deepEqual(row!.entityRefs, [REF]);
    assert.equal((row!.provenance as { producerKind: string }).producerKind, 'RULE_AND_MODEL');
    assert.equal(await heldFor(), 0, 'CURRENT digest + 0 HELD rows for that target');
    assert.equal(await prisma.intelligenceRefreshRequest.count({ where: { id: { in: held } } }), 0);
    assert.equal(await prisma.intelligenceRefreshRequest.count({ where: { organizationId, domain: 'CAMPAIGNS', subjectKind: 'DOMAIN', state: { not: 'HELD' } } }), 0, 'the fresh request completed');
    assert.deepEqual(await prisma.intelligenceRefreshRequest.findMany({ where: { id: { in: unrelated } }, orderBy: { id: 'asc' } }), unrelatedBefore, 'every other target’s HELD row is byte-identical');

    // 6. And the synthesis barrier is gone for this target only.
    const { DigestSourceStateRepository } = await import('../src/repositories/intelligence/digest-source-state.repository');
    const records = await digests.organizationForDomain(organizationId, 'CAMPAIGNS', { now: now() });
    const state = await new DigestSourceStateRepository(prisma).resolve(records);
    assert.equal(state.get(records[0]!.id)!.refreshUnresolved, false);
  } finally {
    await prisma.intelligenceRefreshRequest.deleteMany({ where: { organizationId: { startsWith: 'org_camp_' } } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});

test('SELF-HEALING is fail closed: only a successful refresh of the EXACT target resolves its older HELD rows; refusals, failures, NO_EVIDENCE, enqueue and claim never do; unsuperseded HELD keeps its retention', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  forgetIntelligenceFabricPresence();
  const organizationId = `org_heal_${randomUUID()}`;
  try {
    await prisma.organization.create({ data: { id: organizationId, name: 'HEAL', slug: organizationId } });
    const users: string[] = [];
    for (const n of [0, 1]) {
      const userId = `user_heal_${n}_${randomUUID()}`;
      await prisma.user.create({ data: { id: userId, organizationId, email: `${userId}@example.test`, name: 'H', status: 'ACTIVE', metadata: { systemRole: 'OWNER' } } });
      await prisma.organizationMembership.create({ data: { organizationId, userId, systemRole: 'OWNER', status: 'ACTIVE', effectiveFrom: new Date('2026-01-01T00:00:00Z') } });
      users.push(userId);
    }
    const digests = new IntelligenceDigestRepository(prisma);
    const queue = new IntelligenceRefreshQueueRepository(prisma);
    const target: IntelligenceRefreshTarget = { scope: 'ORGANIZATION', organizationId, domain: 'CAMPAIGNS', subjectKind: 'DOMAIN', subjectRef: 'domain' };
    const exact = { organizationId, scope: 'ORGANIZATION', userId: null, domain: 'CAMPAIGNS', subjectKind: 'DOMAIN', subjectRef: 'domain' };
    const held = (patch: Record<string, unknown> = {}) =>
      prisma.intelligenceRefreshRequest.create({ data: { ...exact, reason: 'SCHEDULED', firstRequestedAt: NOW, lastRequestedAt: NOW, notBefore: NOW, state: 'HELD', attempts: 1, lastOutcome: 'INVALID_ENTITY_REFS', ...patch } });
    const heldCount = () => prisma.intelligenceRefreshRequest.count({ where: { ...exact, state: 'HELD' } });

    // --- The repository guard, directly ----------------------------------------------------------------
    await held();
    await held();
    const started = new Date(Date.now() + 5);
    // No digest at all: nothing to stand on.
    assert.deepEqual(await queue.resolveSupersededHeld(target, { fingerprint: 'campaigns:v1', refreshStartedAt: started, now: new Date() }), { resolved: 0 });
    assert.equal((await digests.upsertOrganization(organizationId, orgDigest('CAMPAIGNS', 'A campaign carried calls nobody bought.', 'campaigns:v1'))).outcome, 'WRITTEN');
    // A different fingerprint than the stored CURRENT reading: not this refresh's reading.
    assert.deepEqual(await queue.resolveSupersededHeld(target, { fingerprint: 'campaigns:other', refreshStartedAt: started, now: new Date() }), { resolved: 0 });
    // The reading is STALE: not current.
    await digests.markTargetStale({ scope: 'ORGANIZATION', organizationId }, target);
    assert.deepEqual(await queue.resolveSupersededHeld(target, { fingerprint: 'campaigns:v1', refreshStartedAt: started, now: new Date() }), { resolved: 0 });
    await digests.reaffirmTarget({ scope: 'ORGANIZATION', organizationId }, target, 'campaigns:v1');
    // Expired: not a valid reading.
    assert.deepEqual(await queue.resolveSupersededHeld(target, { fingerprint: 'campaigns:v1', refreshStartedAt: started, now: new Date(Date.now() + 400 * 864e5) }), { resolved: 0 });
    // A malformed target: refused before anything is read.
    assert.deepEqual(await queue.resolveSupersededHeld({ ...target, organizationId: '' }, { fingerprint: 'campaigns:v1', refreshStartedAt: started, now: new Date() }), { resolved: 0 });
    assert.equal(await heldCount(), 2, 'every guard held the barrier');

    // Rows it must never touch: a HELD row newer than the refresh, PENDING and CLAIMED rows for the target,
    // other targets' HELD rows (another domain, subject, person, organization).
    const otherOrg = `org_heal_other_${randomUUID()}`;
    await prisma.organization.create({ data: { id: otherOrg, name: 'HEAL O', slug: otherOrg } });
    const newer = (await held({ lastOutcome: 'NOT_PERMITTED' })).id;
    await prisma.intelligenceRefreshRequest.update({ where: { id: newer }, data: { updatedAt: new Date(started.getTime() + 60_000) } });
    const untouchable = [
      newer,
      (await prisma.intelligenceRefreshRequest.create({ data: { ...exact, reason: 'SCHEDULED', firstRequestedAt: NOW, lastRequestedAt: NOW, notBefore: NOW, state: 'PENDING' } })).id,
      (await held({ domain: 'CALLGRID' })).id,
      (await held({ subjectKind: 'ENTITY', subjectRef: ENTITY })).id,
      (await held({ scope: 'PRINCIPAL', userId: users[0], domain: 'WORK' })).id,
      (await held({ scope: 'PRINCIPAL', userId: users[1], domain: 'WORK' })).id,
      (await held({ organizationId: otherOrg })).id,
    ];
    const before = await prisma.intelligenceRefreshRequest.findMany({ where: { id: { in: untouchable } }, orderBy: { id: 'asc' } });
    assert.deepEqual(await queue.resolveSupersededHeld(target, { fingerprint: 'campaigns:v1', refreshStartedAt: started, now: new Date() }), { resolved: 2 }, 'exactly the two older HELD rows of this target');
    assert.deepEqual(await prisma.intelligenceRefreshRequest.findMany({ where: { id: { in: untouchable } }, orderBy: { id: 'asc' } }), before, 'nothing else changed');
    await prisma.intelligenceDigest.deleteMany({ where: { organizationId } });
    await prisma.intelligenceRefreshRequest.deleteMany({ where: { organizationId: { in: [organizationId, otherOrg] } } });

    // --- Through the real loop: failure paths never clear the barrier -----------------------------------
    let mode: { kind: 'READY'; fingerprint: string; statement: string; bad?: boolean } | { kind: 'NO_EVIDENCE' } | { kind: 'UNAVAILABLE' } = { kind: 'UNAVAILABLE' };
    const producer: IntelligenceProducer<{ statement: string; bad?: boolean }> = {
      id: 'campaigns.domain@1', domain: 'CAMPAIGNS', scope: 'ORGANIZATION', subjectKinds: ['DOMAIN'], kind: 'RULE', taskId: null,
      gather: async () => (mode.kind === 'READY' ? { status: 'READY', context: { statement: mode.statement, bad: mode.bad }, fingerprint: mode.fingerprint } : mode.kind === 'NO_EVIDENCE' ? { status: 'NO_EVIDENCE' } : { status: 'UNAVAILABLE', reason: 'test' }),
      read: async (_t, ctx, fingerprint) => {
        const d = orgDigest('CAMPAIGNS', ctx.statement, fingerprint);
        // The production defect's shape: a repeated reference, refused by the real repository.
        return { status: 'READ', digest: ctx.bad ? { ...d, entityRefs: [ENTITY, ENTITY] } : d };
      },
    };
    let clock = Date.now();
    const now = () => new Date(clock);
    const pass = async (enqueue = true) => {
      clock = Date.now() + 10 * 60_000; // later than every seeded row, and past any backoff
      if (enqueue) await queue.enqueue(target, { reason: 'SCHEDULED' }, new Date(Date.now()));
      return runIntelligenceProducerCycle({ queue, digests, registry: new IntelligenceProducerRegistry([producer], ['campaigns.domain@1']), leaseOwner: 'heal-test', now }, { limit: 50, leaseMs: 60_000, maxAttempts: 1 });
    };
    assert.equal((await digests.upsertOrganization(organizationId, orgDigest('CAMPAIGNS', 'An older reading.', 'campaigns:old'))).outcome, 'WRITTEN');
    await digests.markTargetStale({ scope: 'ORGANIZATION', organizationId }, target);
    for (let i = 0; i < 3; i += 1) await held();

    mode = { kind: 'READY', fingerprint: 'campaigns:bad', statement: 'Refused.', bad: true };
    const refused = await pass();
    assert.equal(refused.held, 1, 'the refused write is HELD, as before');
    assert.equal(await heldCount(), 4, 'a refused write resolves nothing');
    mode = { kind: 'UNAVAILABLE' };
    await pass();
    assert.equal(await heldCount(), 5, 'a failed gather resolves nothing (and exhausts into HELD)');
    mode = { kind: 'NO_EVIDENCE' };
    await pass();
    assert.equal(await heldCount(), 5, 'NO_EVIDENCE resolves nothing');
    assert.equal((await prisma.intelligenceDigest.findFirst({ where: { organizationId, domain: 'CAMPAIGNS' } }))!.status, 'STALE');

    // --- A successful re-affirm (unchanged evidence over a STALE reading) resolves them -------------------
    mode = { kind: 'READY', fingerprint: 'campaigns:old', statement: 'An older reading.' };
    const reaffirmed = await pass();
    assert.equal(reaffirmed.skippedUnchangedBeforeRead, 1, 'no read: the stored reading stands for this evidence');
    assert.equal(reaffirmed.outcomes.SUPERSEDED_HELD_RESOLVED, 5);
    assert.equal(await heldCount(), 0);
    assert.equal((await prisma.intelligenceDigest.findFirst({ where: { organizationId, domain: 'CAMPAIGNS' } }))!.status, 'CURRENT');

    // --- Retention still governs a HELD row no successful refresh supersedes -----------------------------
    const orphan = (await held({ subjectKind: 'ENTITY', subjectRef: ENTITY, lastOutcome: 'NOT_PERMITTED' })).id;
    await prisma.intelligenceRefreshRequest.update({ where: { id: orphan }, data: { updatedAt: new Date(Date.now() - 8 * 864e5) } });
    const { purged } = await queue.purgeHeld(new Date(Date.now() - 7 * 864e5), { organizationIds: [organizationId] });
    assert.equal(purged, 1);
    assert.equal(await prisma.intelligenceRefreshRequest.count({ where: { id: orphan } }), 0);
  } finally {
    await prisma.intelligenceRefreshRequest.deleteMany({ where: { organizationId: { startsWith: 'org_heal_' } } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});
