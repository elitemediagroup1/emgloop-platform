// Intake eligibility against a REAL Postgres, shaped like production (2026-09-29). OPT-IN AND LOCAL ONLY.
//
// THE FAILURE THIS PINS. Production held 24,590 Intake Records: 24,579 created by the retired automatic call
// ingestion (verified mark, caller-only, historical New/Contacted/Archived statuses, lastSeenAt never moved),
// 8 anonymous visitors, 1 web lead, 2 of unproven origin -- and the Pipeline reading, Home, CRM home and the
// Intake Board all presented ~24.5k of them as active intake, 24,575 "stalled". Here they must NOT become
// intake simply because they exist or carry a status. Then every legitimate way in, and every way that is
// not one, is exercised through the real repositories, and every surface reads the same answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

import { CrmRepository } from '../src/repositories/crm.repository';
import { IntakeEligibilityRepository, intakeStatusOf } from '../src/repositories/intake-eligibility.repository';
import { readOnlyClient } from '../src/repositories/read-only-client';
import { PipelineCompositionRepository } from '../src/repositories/intelligence/pipeline-composition.repository';
import { DomainFactsRepository } from '../src/repositories/intelligence/domain-facts.repository';
import { pipelineDomainProducer } from '../src/services/intelligence-fabric/domains/records';

const LOCAL = (url: string) => /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url);
const URL = process.env.LOOP_TEST_POSTGRES_URL ?? '';
const skip = !URL ? 'LOOP_TEST_POSTGRES_URL is not set' : !LOCAL(URL) ? 'refusing a non-local database' : false;
const DAY = 864e5;
const KIT = { modelEnabled: () => false, reader: null, principalFor: async () => null };

test('the status an eligible record reads as: explicit if known; New only for a web lead; otherwise UNSET, never New', () => {
  assert.equal(intakeStatusOf('Quoted', 'HUMAN_WORK'), 'Quoted');
  assert.equal(intakeStatusOf(undefined, 'WEB_LEAD'), 'New');
  assert.equal(intakeStatusOf('contacted', 'WEB_LEAD'), 'New');
  assert.equal(intakeStatusOf(undefined, 'HUMAN_WORK'), 'UNSET');
  assert.equal(intakeStatusOf('Weird', 'HUMAN_WORK'), 'UNSET');
});

test('PRODUCTION SHAPE: 24,579 legacy caller records, visitors and unproven records are not intake; only the web lead is -- and every surface agrees', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const organizationId = `org_intake_${randomUUID()}`;
  try {
    await prisma.organization.create({ data: { id: organizationId, name: 'INTAKE', slug: organizationId } });
    const person = `user_intake_${randomUUID()}`;
    const aiLogin = `user_intake_ai_${randomUUID()}`;
    await prisma.user.create({ data: { id: person, organizationId, email: `${person}@example.test`, name: 'Dana', status: 'ACTIVE', metadata: { systemRole: 'OWNER' } } });
    await prisma.user.create({ data: { id: aiLogin, organizationId, email: `${aiLogin}@example.test`, name: 'Ava', status: 'ACTIVE', metadata: { systemRole: 'AI_EMPLOYEE' } } });
    const now = new Date();
    const ago = (d: number) => new Date(now.getTime() - d * DAY);
    const old = ago(60);

    // 24,579 legacy caller records: the retired creator's mark, a phone, no name or email, the statuses
    // ingestion and its call workflows wrote, lastSeenAt == createdAt.
    const status = (i: number) => (i < 860 ? 'Contacted' : i < 863 ? 'Archived' : 'New');
    const legacy = Array.from({ length: 24_579 }, (_, i) => ({ organizationId, phone: `+1555${String(i).padStart(7, '0')}`, tags: ['lead'], metadata: { createdFrom: 'callgrid' }, attributes: { pipelineStatus: status(i), firstSource: 'callgrid' }, createdAt: old, lastSeenAt: old, updatedAt: old }));
    for (let i = 0; i < legacy.length; i += 5_000) await prisma.customer.createMany({ data: legacy.slice(i, i + 5_000) });
    await prisma.customer.createMany({ data: Array.from({ length: 8 }, () => ({ organizationId, externalId: `web-visitor:${randomUUID()}`, tags: ['anonymous-visitor'], metadata: { createdFrom: 'website', visitorId: 'v' }, attributes: { pipelineStatus: 'New' }, createdAt: old, lastSeenAt: old, updatedAt: old })) });
    const lead = await prisma.customer.create({ data: { organizationId, email: 'lead@example.test', tags: ['lead'], metadata: { createdFrom: 'website' }, attributes: { pipelineStatus: 'New' }, createdAt: old, lastSeenAt: old, updatedAt: old } });
    await prisma.customer.createMany({ data: [
      { organizationId, phone: '+15559990001', tags: ['lead', 'inbound-call'], attributes: { pipelineStatus: 'New' }, createdAt: old, lastSeenAt: old, updatedAt: old },
      { organizationId, externalId: `sic-demo-${randomUUID()}`, attributes: { pipelineStatus: 'Contacted' }, createdAt: old, lastSeenAt: old, updatedAt: old },
    ] });
    assert.equal(await prisma.customer.count({ where: { organizationId } }), 24_590);

    const intake = new IntakeEligibilityRepository(prisma);
    const crm = new CrmRepository(prisma);

    // 1. Nothing but the web lead is intake: ~24.5k legacy records never become active or stalled intake.
    const c0 = await intake.counts(organizationId, now);
    assert.deepEqual(
      { eligible: c0.eligible, excluded: c0.excluded, working: c0.working, basis: c0.byBasis, stalled: c0.stalled, complete: c0.complete },
      { eligible: 1, excluded: 24_589, working: 1, basis: { WEB_LEAD: 1, HUMAN_WORK: 0 }, stalled: { New: 1, Contacted: 0, Quoted: 0 }, complete: true },
      'one web lead waiting 60 days -- the one true stall -- and not 24,575',
    );
    assert.deepEqual(c0.byStatus, { New: 1, Contacted: 0, Quoted: 0, Booked: 0, Completed: 0, Archived: 0, UNSET: 0 });
    // Intake Board: one column card, and the rest counted apart.
    const b0 = await crm.kanbanBoard(organizationId, now);
    assert.deepEqual(b0.columns.map((c) => [c.status, c.count]), [['New', 1], ['Contacted', 0], ['Quoted', 0], ['Booked', 0], ['Completed', 0], ['Archived', 0]]);
    assert.deepEqual(b0.columns[0]!.cards.map((c) => c.id), [lead.id]);
    assert.equal(b0.notIntake, 24_589);
    // The Pipeline reading: one record in progress, the population said as not counted.
    const pipeline = pipelineDomainProducer(crm, intake, new DomainFactsRepository(prisma), KIT);
    const target = { scope: 'ORGANIZATION', organizationId, domain: 'PIPELINE', subjectKind: 'DOMAIN', subjectRef: 'domain' } as const;
    const g0 = await pipeline.gather(target, now);
    assert.equal(g0.status, 'READY');
    const r0 = await pipeline.read(target, (g0 as { context: never }).context, (g0 as { fingerprint: string }).fingerprint, now);
    const d0 = (r0 as { digest: { content: { reading: { statement: string }; limitations: string[]; signals: { key: string; statement: string }[] } } }).digest.content;
    assert.equal(d0.reading.statement, '1 intake record in progress, 0 new this week; 1 with no recorded work for 14 days.');
    assert.match(d0.limitations.join(' '), /24589 other records are not counted as intake/);
    assert.ok(!JSON.stringify(d0).includes('24575'), 'never the pre-repair stall');

    // 2. Every way in -- and every way that is not one.
    // Legacy callers carrying ingestion's historical New.
    const pick = async (n: number) => (await prisma.customer.findMany({ where: { organizationId, AND: [{ metadata: { path: ['createdFrom'], equals: 'callgrid' } }, { attributes: { path: ['pipelineStatus'], equals: 'New' } }] }, select: { id: true }, orderBy: { id: 'asc' }, skip: n, take: 1 }))[0]!.id;
    const [noted, statusChanged, assignedOnly, workflowWritten, aiStatus, partyLinked, aiNoted] = await Promise.all([0, 1, 2, 3, 4, 5, 6].map((n) => pick(n)));
    const unproven = (await prisma.customer.findFirst({ where: { organizationId, phone: '+15559990001' }, select: { id: true } }))!.id;
    const human = { userId: person, name: 'Dana', systemRole: 'OWNER' };
    const ai = { userId: aiLogin, name: 'Ava', systemRole: 'AI_EMPLOYEE' };
    const note = (customerId: string, actorType: string, at: Date) => prisma.interaction.create({ data: { organizationId, customerId, channel: 'OTHER', kind: 'NOTE', direction: 'INTERNAL', occurredAt: at, payload: { loopKind: 'crm_note', actorType, actorUserId: person, actorName: 'Dana', body: 'called back' } } as never });
    await note(noted, 'HUMAN_AGENT', ago(20)); //              a person's note, 20 days ago -> intake, stalled
    await crm.setPipelineStatus(organizationId, statusChanged, 'Quoted', human); // a person's status change -> intake, fresh
    await crm.setAssignment(organizationId, assignedOnly, { humanName: 'Dana' }, human); // routing only -> NOT intake
    // A workflow's status step (WorkflowsRepository writes attributes directly, unattributed) -> NOT intake.
    await prisma.customer.update({ where: { id: workflowWritten }, data: { attributes: { pipelineStatus: 'Quoted', firstSource: 'callgrid' } } });
    await crm.setPipelineStatus(organizationId, aiStatus, 'Contacted', ai); // an AI employee's login -> NOT intake
    const party = await prisma.cognitiveIdentity.create({ data: { organizationId, entityType: 'PERSON', canonicalKey: `intake:${randomUUID()}`, establishedAt: ago(40), establishmentBasis: 'MANUAL' } });
    await prisma.customerPartyLink.create({ data: { organizationId, customerId: partyLinked, partyId: party.id, basis: 'MANUAL', activeCustomerId: partyLinked, linkedByUserId: person, linkedAt: ago(30) } }); // a person's Party link -> intake
    await note(aiNoted, 'AI_AGENT', ago(1)); //                  an AI's note -> NOT intake
    await prisma.customer.update({ where: { id: unproven }, data: { attributes: {} } });
    await note(unproven, 'HUMAN_AGENT', ago(1)); //              unproven origin, worked, no status -> intake, UNSET (never New)
    // lastSeenAt is not an activity clock: moving it changes nothing.
    await prisma.customer.updateMany({ where: { organizationId, id: { in: [noted, assignedOnly] } }, data: { lastSeenAt: now } });

    const audits = await prisma.auditLog.findMany({ where: { organizationId }, select: { action: true, entityId: true, userId: true, actorType: true } });
    assert.deepEqual(audits.map((a) => [a.action, a.entityId, a.userId, a.actorType]).sort(), [
      ['customer.assignment_changed', assignedOnly, person, 'HUMAN_AGENT'],
      ['customer.status_changed', aiStatus, aiLogin, 'AI_AGENT'],
      ['customer.status_changed', statusChanged, person, 'HUMAN_AGENT'],
    ].sort(), 'status and assignment are attributed; the workflow write is not');

    const read = await intake.read(organizationId, now);
    const byId = new Map(read.records.map((r) => [r.id, r]));
    assert.deepEqual([...byId.keys()].sort(), [lead.id, noted, statusChanged, partyLinked, unproven].sort(), 'exactly the web lead and the four records a person worked');
    for (const notIn of [assignedOnly, workflowWritten, aiStatus, aiNoted]) assert.equal(byId.has(notIn), false);
    assert.deepEqual([byId.get(noted)!.basis, byId.get(noted)!.status, byId.get(noted)!.stalled, byId.get(noted)!.workEvents], ['HUMAN_WORK', 'New', true, ['HUMAN_NOTE']], 'its note was 20 days ago; its moved lastSeenAt does not matter');
    assert.deepEqual([byId.get(statusChanged)!.status, byId.get(statusChanged)!.stalled, byId.get(statusChanged)!.workEvents], ['Quoted', false, ['STATUS_CHANGE']]);
    assert.deepEqual([byId.get(partyLinked)!.status, byId.get(partyLinked)!.stalled, byId.get(partyLinked)!.workEvents], ['New', true, ['PARTY_LINK']]);
    assert.deepEqual([byId.get(unproven)!.status, byId.get(unproven)!.stalled], ['UNSET', false], 'no status on a worked record reads UNSET, never New');
    assert.deepEqual([byId.get(lead.id)!.basis, byId.get(lead.id)!.lastWorkedAt, byId.get(lead.id)!.stalled], ['WEB_LEAD', null, true]);

    const c1 = await intake.counts(organizationId, now);
    assert.deepEqual([c1.eligible, c1.excluded, c1.working, c1.byStatus.New, c1.byStatus.Quoted, c1.byStatus.UNSET, c1.stalled.New], [5, 24_585, 4, 3, 1, 1, 3]);
    const b1 = await crm.kanbanBoard(organizationId, now);
    assert.deepEqual(b1.columns.map((c) => [c.status, c.count]), [['New', 3], ['Contacted', 0], ['Quoted', 1], ['Booked', 0], ['Completed', 0], ['Archived', 0], ['UNSET', 1]]);
    assert.equal(b1.columns.flatMap((c) => c.cards).length, 5);
    assert.ok(b1.columns[0]!.cards.every((c) => [lead.id, noted, partyLinked].includes(c.id)));

    // 3. The diagnostic proves the same thing independently, on the read-only client, counts only.
    const before = [await prisma.customer.count(), await prisma.auditLog.count({ where: { organizationId } })];
    const p = await new PipelineCompositionRepository(readOnlyClient(prisma)).read(organizationId, now, ago(14));
    assert.deepEqual([await prisma.customer.count(), await prisma.auditLog.count({ where: { organizationId } })], before, 'reads write nothing');
    assert.deepEqual({ eligible: p.intake.counts.eligible, excluded: p.intake.counts.excluded, basis: p.intake.counts.byBasis, work: p.intake.byWorkEvent, worked: p.intake.worked, neverWorked: p.intake.neverWorked }, { eligible: 5, excluded: 24_585, basis: { WEB_LEAD: 1, HUMAN_WORK: 4 }, work: { HUMAN_NOTE: 2, STATUS_CHANGE: 1, PARTY_LINK: 1 }, worked: 4, neverWorked: 1 });
    const caller = p.byProvenance.find((r) => r.provenance === 'CALLGRID_INGESTION_CALLER_ONLY')!;
    assert.deepEqual([caller.total, caller.eligible], [24_579, 3], 'of 24,579 legacy callers, only the 3 a person worked are intake');
    assert.equal(p.byProvenance.find((r) => r.provenance === 'WEB_VISITOR_INGESTION')!.eligible, 0);
    assert.equal(p.byProvenance.find((r) => r.provenance === 'WEB_LEAD_INGESTION')!.eligible, 1);
    assert.ok(caller.working > 24_000, 'the pre-repair definition still counts them -- which is what the diagnostic compares against');
  } finally {
    await prisma.organization.delete({ where: { id: organizationId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});
