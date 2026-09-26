// Review blocker 1 on #341, against a REAL Postgres (LOOP_TEST_POSTGRES_URL, local only).
//
// An ORGANIZATION (Loop-record) digest has no connection to go stale on, so its runtime freshness is the
// fabric's own refresh state. Driven through the real producer loop and refresh queue, this proves:
//   - a pending refresh keeps a CURRENT reading out of situations AND the Briefing;
//   - a retrying refresh, and a HELD one (even after its row is purged), do too;
//   - NO_EVIDENCE leaves the old reading STALE, never current;
//   - an unchanged successful refresh re-affirms it (no read), and it is eligible again;
//   - a changed successful refresh replaces it, and only the new reading is used.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

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
