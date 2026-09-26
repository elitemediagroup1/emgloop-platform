// Loop Intelligence Phase E against a REAL Postgres. OPT-IN AND LOCAL ONLY: LOOP_TEST_POSTGRES_URL.
//
// Proves on the real schema: the domain facts are scoped to their organization (another tenant's rows
// never move a count), an organization producer runs end to end through the scheduled pass and writes an
// ORGANIZATION digest, a second pass over unchanged records skips BEFORE its read, and a person's own
// Work reading counts only their own assigned steps.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

import { CrmRepository } from '../src/repositories/crm.repository';
import { DomainFactsRepository } from '../src/repositories/intelligence/domain-facts.repository';
import { IntelligenceDigestRepository } from '../src/repositories/intelligence/intelligence-digest.repository';
import { IntelligenceRefreshQueueRepository } from '../src/repositories/intelligence/intelligence-refresh-queue.repository';
import { pipelineDomainProducer, myWorkProducer, workDomainProducer } from '../src/services/intelligence-fabric/domains/records';
import { IntelligenceProducerRegistry } from '../src/services/intelligence-fabric/producer';
import { runIntelligencePass } from '../src/services/intelligence-fabric/intelligence-pass';

const LOCAL = (url: string) => /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url);
const URL = process.env.LOOP_TEST_POSTGRES_URL ?? '';
const skip = !URL ? 'LOOP_TEST_POSTGRES_URL is not set' : !LOCAL(URL) ? 'refusing a non-local database' : false;

const NOW = new Date();
const DAY = 864e5;
const KIT = { modelEnabled: () => false, reader: null, principalFor: async () => null };

async function tenant(prisma: PrismaClient, label: string) {
  const organizationId = `org_dom_${label}_${randomUUID()}`;
  await prisma.organization.create({ data: { id: organizationId, name: `DOM ${label}`, slug: organizationId } });
  const users: string[] = [];
  for (const role of ['OWNER', 'EMPLOYEE'] as const) {
    const userId = `user_dom_${label}_${role}_${randomUUID()}`;
    await prisma.user.create({ data: { id: userId, organizationId, email: `${userId}@example.test`, name: 'DOM', status: 'ACTIVE', metadata: { systemRole: role } } });
    await prisma.organizationMembership.create({ data: { organizationId, userId, systemRole: role, status: 'ACTIVE', effectiveFrom: new Date('2026-01-01T00:00:00Z') } });
    users.push(userId);
  }
  return { organizationId, users };
}

async function customers(prisma: PrismaClient, organizationId: string, n: number, status: string, lastSeenDaysAgo: number) {
  for (let i = 0; i < n; i += 1) await prisma.customer.create({ data: { organizationId, attributes: { pipelineStatus: status }, lastSeenAt: new Date(NOW.getTime() - lastSeenDaysAgo * DAY) } });
}

async function work(prisma: PrismaClient, organizationId: string, createdBy: string, owner: string | null, dueDaysFromNow: number) {
  await prisma.workInstance.create({
    data: { organizationId, title: 'W', createdByUserId: createdBy, status: 'active', stages: { create: [{ name: 'S', position: 0, status: 'ready', ownerUserId: owner, dueAt: new Date(NOW.getTime() + dueDaysFromNow * DAY) }] } },
  });
}

test('domain facts are scoped to their organization: another tenant never moves a count', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  try {
    const a = await tenant(prisma, 'a');
    const b = await tenant(prisma, 'b');
    await customers(prisma, a.organizationId, 2, 'Quoted', 30);
    await customers(prisma, b.organizationId, 5, 'Quoted', 30);
    await work(prisma, a.organizationId, a.users[0]!, a.users[1]!, -1);
    await work(prisma, b.organizationId, b.users[0]!, null, -1);
    await work(prisma, b.organizationId, b.users[0]!, null, -1);
    const facts = new DomainFactsRepository(prisma);
    assert.deepEqual(await facts.staleByStatus(a.organizationId, ['Quoted'], new Date(NOW.getTime() - 14 * DAY)), { Quoted: 2 });
    const wa = await facts.workFacts(a.organizationId, null, NOW, new Date(NOW.getTime() + DAY), new Date(NOW.getTime() - 7 * DAY), new Date(NOW.getTime() - 14 * DAY));
    assert.equal(wa.activeInstances, 1);
    assert.equal(wa.overdue, 1);
    assert.equal(wa.unassigned, 0);
    // A person's own work: only their own assigned steps.
    const mine = await facts.workFacts(a.organizationId, a.users[1]!, NOW, new Date(NOW.getTime() + DAY), new Date(NOW.getTime() - 7 * DAY), new Date(NOW.getTime() - 14 * DAY));
    assert.equal(mine.openStages, 1);
    const owner = await facts.workFacts(a.organizationId, a.users[0]!, NOW, new Date(NOW.getTime() + DAY), new Date(NOW.getTime() - 7 * DAY), new Date(NOW.getTime() - 14 * DAY));
    assert.equal(owner.openStages, 0, 'the owner has none assigned; organization work is not "theirs"');
    // An acting operator must be a member of THAT organization.
    assert.ok(await facts.actingOperator(a.organizationId, a.users[0]!, NOW));
    assert.equal(await facts.actingOperator(a.organizationId, a.users[1]!, NOW), null, 'an EMPLOYEE is not an operator');
    assert.equal(await facts.actingOperator(b.organizationId, a.users[0]!, NOW), null, 'another tenant’s owner is nobody here');
  } finally {
    await prisma.$disconnect();
  }
});

test('the scheduled pass writes ORGANIZATION digests end to end, then skips unchanged records before any read', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  try {
    const a = await tenant(prisma, 'pass');
    await customers(prisma, a.organizationId, 3, 'Quoted', 30);
    await work(prisma, a.organizationId, a.users[0]!, a.users[1]!, -2);
    const facts = new DomainFactsRepository(prisma);
    // Discovery narrowed to this tenant so a shared test database's other rows do not enter the pass.
    const only = <T extends { discover?: unknown }>(p: T) => ({ ...p, discover: async () => [{ scope: 'ORGANIZATION', organizationId: a.organizationId, domain: (p as unknown as { domain: string }).domain, subjectKind: 'DOMAIN', subjectRef: 'domain' }] });
    const pipeline = only(pipelineDomainProducer(new CrmRepository(prisma), facts, KIT));
    const orgWork = only(workDomainProducer(facts, KIT));
    const mineRaw = myWorkProducer(facts, KIT);
    const mine = { ...mineRaw, discover: async () => [{ scope: 'PRINCIPAL' as const, organizationId: a.organizationId, userId: a.users[1]!, domain: 'WORK' as const, subjectKind: 'DOMAIN' as const, subjectRef: 'domain' }] };
    const registry = new IntelligenceProducerRegistry([pipeline, orgWork, mine] as never, ['pipeline.domain@1', 'work.domain@1', 'work.mine@1']);
    const deps = { registry, queue: new IntelligenceRefreshQueueRepository(prisma), digests: new IntelligenceDigestRepository(prisma), leaseOwner: 'test', now: () => new Date() };
    const opts = { limit: 50, leaseMs: 60_000, maxAttempts: 3, discoverLimit: 10 };
    const first = await runIntelligencePass(deps, opts);
    assert.equal(first.enqueued, 3);
    assert.ok(first.cycle!.written >= 3, JSON.stringify(first.cycle));
    const digests = new IntelligenceDigestRepository(prisma);
    const intake = await digests.organizationCurrent(a.organizationId, 'PIPELINE', { now: new Date() });
    assert.ok(intake, 'an organization Intake digest exists');
    assert.equal(intake!.scope, 'ORGANIZATION');
    assert.equal(intake!.userId, null);
    assert.match(JSON.stringify(intake!.content), /3 records in Quoted with no activity/);
    const personal = await digests.current({ organizationId: a.organizationId, userId: a.users[1]! }, 'WORK', { now: new Date() });
    assert.ok(personal, 'the person’s own Work digest exists');
    assert.equal(await digests.current({ organizationId: a.organizationId, userId: a.users[0]! }, 'WORK', { now: new Date() }), null, 'nobody else’s');
    const second = await runIntelligencePass(deps, opts);
    assert.equal(second.cycle!.written, 0);
    assert.equal(second.cycle!.skippedUnchangedBeforeRead, 3);
  } finally {
    await prisma.$disconnect();
  }
});
