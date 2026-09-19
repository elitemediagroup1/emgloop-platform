// Read Intelligence State against a REAL Postgres: the reader returns the recorded Cases, the
// outbox, creator eligibility, deliveries, subscriptions and per-member counts -- and writes
// nothing, which is proved by every table it touches being identical before and after.
//
// OPT-IN AND LOCAL ONLY (LOOP_TEST_POSTGRES_URL, localhost). See google-connection.postgres.test.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

import { WorkGraphRepository } from '../src/repositories/work-state';
import { IntelligenceStateRepository, CALLGRID_CASE_PRODUCER } from '../src/repositories/intelligence-state.repository';
import { readOnlyClient, ReadOnlyViolation } from '../src/repositories/read-only-client';
import { DecisionEngine } from '../src/services/decision/decision-engine';
import { declareIntelligenceSubscriptions } from '../src/services/intelligence';

const URL = process.env.LOOP_TEST_POSTGRES_URL ?? '';
const LOCAL = /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(URL);
const skip = !URL ? 'LOOP_TEST_POSTGRES_URL is not set' : !LOCAL ? 'refusing a non-local database' : false;
const key = (v: string) => createHash('sha256').update(v).digest('hex');

async function member(prisma: PrismaClient, organizationId: string, label: string) {
  const userId = `user_${label}_${randomUUID()}`;
  await prisma.user.create({ data: { id: userId, organizationId, email: `${userId}@example.test`, name: label, status: 'ACTIVE', metadata: { systemRole: 'OWNER' } } });
  await prisma.organizationMembership.create({ data: { organizationId, userId, systemRole: 'OWNER', status: 'ACTIVE' } });
  return { organizationId, userId };
}

/** Every table the reader touches: row count and newest update, for one organization. */
async function snapshot(prisma: PrismaClient, organizationId: string) {
  const where = { organizationId };
  const out: Record<string, unknown> = {};
  const models = [
    'operationalPriority',
    'operationalObservation',
    'decisionEvidence',
    'intelligenceHypothesis',
    'stateChangeOutbox',
    'stateChangeDelivery',
    'stateChangeSubscription',
    'workDraft',
    'workEvent',
    'crmRelationship',
    'crmParticipant',
    'organizationMembership',
  ] as const;
  for (const m of models) {
    const delegate = prisma[m] as unknown as { count(a: unknown): Promise<number>; findMany(a: unknown): Promise<Record<string, unknown>[]> };
    out[m] = { count: await delegate.count({ where }), rows: JSON.stringify(await delegate.findMany({ where })) };
  }
  return out;
}

test('the reader reports real rows as ids and counts, stays inside its organization, and writes nothing', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const orgA = `org_state_a_${randomUUID()}`;
  const orgB = `org_state_b_${randomUUID()}`;
  try {
    for (const id of [orgA, orgB]) await prisma.organization.create({ data: { id, name: id, slug: id } });
    const matt = await member(prisma, orgA, 'matt');
    const engine = new DecisionEngine(prisma);
    const at = new Date('2026-09-19T18:25:10Z');
    const situation = (org: string, recurrenceKey: string, title: string, entityName: string, entityId?: string) =>
      engine.create(org, {
        producer: CALLGRID_CASE_PRODUCER,
        recurrenceKey,
        detectionKey: 'daily:2026-09-19',
        detectedAt: at,
        title,
        severity: 'HIGH',
        sourceReference: entityId ?? null,
        evidence: [{ source: 'summary-report', metricKey: 'billableCalls', window: 'day', ruleId: recurrenceKey.split('::')[0], ruleVersion: 'v1', observedAt: at, entityType: 'buyer', entityId, entityName }],
      } as never);
    const one = await situation(orgA, 'volume-drop::buyer-7781', 'Buyer Acme fell 40%', 'Buyer Acme', 'buyer-7781');
    const two = await situation(orgA, 'revenue-concentration::Acme Insurance Group', 'Acme Insurance Group is 60%', 'Acme Insurance Group');
    await situation(orgB, 'volume-drop::buyer-9', 'Org B', 'Org B Buyer', 'buyer-9');
    await declareIntelligenceSubscriptions(prisma, orgA, { apply: true });
    await new WorkGraphRepository(prisma).upsertEvent(matt, {
      provider: 'GOOGLE', eventId: 'e1', startsAt: at, endsAt: at, status: 'CONFIRMED', attendanceKnown: true, attendeeCount: 2,
      attendeeHashes: [key('dana@acme.test')], observedAt: at,
    });

    const before = await snapshot(prisma, orgA);
    const reader = new IntelligenceStateRepository(readOnlyClient(prisma));
    assert.deepEqual(await reader.organizationBySlug(orgA), { id: orgA, slug: orgA });
    const state = await reader.read(orgA, new Date(Date.now() - 3_600_000));
    assert.deepEqual(await snapshot(prisma, orgA), before, 'no row changed in any table the reader touches');

    assert.deepEqual(state.cases.rows.map((c) => [c.id, c.rule, c.entityType, c.state, c.timesSeen]), [
      [one.decision.id, 'volume-drop', 'buyer', 'NEEDS_REVIEW', 1],
      [two.decision.id, 'revenue-concentration', 'buyer', 'NEEDS_REVIEW', 1],
    ]);
    assert.ok(state.cases.rows.every((c) => c.organizationId === orgA), 'only this organization');
    assert.deepEqual(state.cases.rows[0]!.sightings.map((s) => [s.type, s.actorType, s.detectionKey]), [['SITUATION_DETECTED', 'SYSTEM', 'daily:2026-09-19']]);
    assert.deepEqual(state.duplicates.groups, []);
    assert.equal(state.writesSince.casesCreated, 2);
    assert.equal(state.subscriptions.length, 2);
    const employee = state.employees.find((e) => e.userId === matt.userId)!;
    assert.deepEqual([employee.events, employee.eventsWithAttendeeKeys, employee.attendeeKeys], [1, 1, 1]);
    const text = JSON.stringify(state);
    for (const secret of ['Buyer Acme', 'Acme Insurance Group', 'buyer-7781', 'Org B', key('dana@acme.test')]) {
      assert.equal(text.includes(secret), false, `${secret} must not leave the reader`);
    }

    // And the client it runs on cannot write, whatever a future edit tries.
    const guarded = readOnlyClient(prisma) as unknown as Record<string, Record<string, unknown>>;
    assert.throws(() => guarded.operationalPriority!.update, ReadOnlyViolation);
    assert.throws(() => (guarded as unknown as { $executeRawUnsafe: unknown }).$executeRawUnsafe, ReadOnlyViolation);
  } finally {
    for (const id of [orgA, orgB]) {
      await prisma.decisionEvidence.deleteMany({ where: { organizationId: id } }).catch(() => undefined);
      await prisma.operationalObservation.deleteMany({ where: { organizationId: id } }).catch(() => undefined);
      await prisma.operationalPriority.deleteMany({ where: { organizationId: id } }).catch(() => undefined);
      await prisma.intelligenceHypothesis.deleteMany({ where: { organizationId: id } }).catch(() => undefined);
      await prisma.stateChangeDelivery.deleteMany({ where: { organizationId: id } }).catch(() => undefined);
      await prisma.stateChangeOutbox.deleteMany({ where: { organizationId: id } }).catch(() => undefined);
      await prisma.stateChangeSubscription.deleteMany({ where: { organizationId: id } }).catch(() => undefined);
      await prisma.organization.delete({ where: { id } }).catch(() => undefined);
    }
    await prisma.$disconnect();
  }
});
