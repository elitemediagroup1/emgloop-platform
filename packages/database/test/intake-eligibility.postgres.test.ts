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

/** A user with a membership in the organization, in the given role (the authority eligibility reads). */
async function member(prisma: PrismaClient, organizationId: string, userId: string, role: 'OWNER' | 'EMPLOYEE' | 'AI_EMPLOYEE' | 'CREATOR') {
  await prisma.user.create({ data: { id: userId, organizationId, email: `${userId}@example.test`, name: role, status: 'ACTIVE', metadata: { systemRole: role } } });
  await prisma.organizationMembership.create({ data: { organizationId, userId, systemRole: role, status: 'ACTIVE', effectiveFrom: new Date('2026-01-01T00:00:00Z') } });
}

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
    await member(prisma, organizationId, person, 'OWNER');
    await member(prisma, organizationId, aiLogin, 'AI_EMPLOYEE');
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

test('ADVERSARIAL: only a human operator of THIS organization qualifies -- spoofed payloads, AI and creator members, non-members, missing actors, integrations, workflows and assignment never do', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const organizationId = `org_intake_adv_${randomUUID()}`;
  const otherOrg = `org_intake_adv_other_${randomUUID()}`;
  try {
    for (const id of [organizationId, otherOrg]) await prisma.organization.create({ data: { id, name: 'ADV', slug: id } });
    const human = `u_h_${randomUUID()}`;
    const ai = `u_ai_${randomUUID()}`;
    const creator = `u_cr_${randomUUID()}`;
    const outsider = `u_out_${randomUUID()}`;
    await member(prisma, organizationId, human, 'EMPLOYEE');
    await member(prisma, organizationId, ai, 'AI_EMPLOYEE');
    await member(prisma, organizationId, creator, 'CREATOR');
    await member(prisma, otherOrg, outsider, 'OWNER');
    const now = new Date();
    const ago = (d: number) => new Date(now.getTime() - d * DAY);
    const record = async (org = organizationId) => (await prisma.customer.create({ data: { organizationId: org, phone: '+15550000000', metadata: { createdFrom: 'callgrid' }, attributes: { pipelineStatus: 'New' }, createdAt: ago(60), lastSeenAt: ago(60), updatedAt: ago(60) } })).id;
    const note = (customerId: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}, org = organizationId) =>
      prisma.interaction.create({ data: { organizationId: org, customerId, channel: 'OTHER', kind: 'NOTE', direction: 'INTERNAL', occurredAt: ago(1), payload, ...extra } as never });
    const audit = (entityId: string, data: Record<string, unknown>, org = organizationId) =>
      prisma.auditLog.create({ data: { organizationId: org, action: 'customer.status_changed', entityType: 'customer', entityId, createdAt: ago(1), ...data } as never });

    const crmNote = (userId: string, actorType = 'HUMAN_AGENT') => ({ loopKind: 'crm_note', actorType, actorUserId: userId, actorName: 'x', body: 'b' });
    const cases: Record<string, string> = {};
    cases.aiSpoofedHuman = await record(); await note(cases.aiSpoofedHuman, crmNote(ai, 'HUMAN_AGENT')); //   an AI member's id under a HUMAN_AGENT claim
    cases.creatorNote = await record(); await note(cases.creatorNote, crmNote(creator));
    cases.outsiderNote = await record(); await note(cases.outsiderNote, crmNote(outsider)); //               a user of another organization
    cases.noActor = await record(); await note(cases.noActor, { loopKind: 'crm_note', actorType: 'HUMAN_AGENT', body: 'b' });
    cases.legacyHumanNote = await record(); await note(cases.legacyHumanNote, { loopKind: 'human_note', actorType: 'HUMAN_AGENT', body: 'b' });
    cases.integration = await record(); await note(cases.integration, crmNote(human), { provider: 'website', externalId: `x_${randomUUID()}` }); // an integration's payload posing as a CRM note
    cases.workflowNote = await record(); await note(cases.workflowNote, { source: 'workflow' });
    cases.systemAudit = await record(); await audit(cases.systemAudit, { actorType: 'SYSTEM', userId: null });
    cases.nullUserAudit = await record(); await audit(cases.nullUserAudit, { actorType: 'HUMAN_AGENT', userId: null });
    cases.aiAudit = await record(); await audit(cases.aiAudit, { actorType: 'HUMAN_AGENT', userId: ai }); // a human claim on an AI member
    cases.creatorAudit = await record(); await audit(cases.creatorAudit, { actorType: 'HUMAN_AGENT', userId: creator });
    cases.outsiderAudit = await record(); await audit(cases.outsiderAudit, { actorType: 'HUMAN_AGENT', userId: outsider });
    cases.assignmentOnly = await record(); await audit(cases.assignmentOnly, { action: 'customer.assignment_changed', actorType: 'HUMAN_AGENT', userId: human });
    const party = await prisma.cognitiveIdentity.create({ data: { organizationId, entityType: 'PERSON', canonicalKey: `adv:${randomUUID()}`, establishedAt: ago(40), establishmentBasis: 'MANUAL' } });
    cases.aiLink = await record();
    await prisma.customerPartyLink.create({ data: { organizationId, customerId: cases.aiLink, partyId: party.id, basis: 'MANUAL', activeCustomerId: cases.aiLink, linkedByUserId: ai, linkedAt: ago(1) } });
    // Tenancy: org B's human writes evidence naming org A's record; org A's record is untouched by it, and org B
    // cannot make a record it does not hold eligible.
    const otherHuman = `u_bh_${randomUUID()}`;
    await member(prisma, otherOrg, otherHuman, 'OWNER');
    cases.crossTenant = await record();
    await note(cases.crossTenant, crmNote(otherHuman), {}, otherOrg);
    await audit(cases.crossTenant, { actorType: 'HUMAN_AGENT', userId: otherHuman }, otherOrg);

    // And the ones that DO qualify, for contrast, with clock guards:
    const worked = await record(); await note(worked, crmNote(human)); // a human operator's note, one day ago
    // Assignment by the same human today never advances the clock of a record worked 20 days ago.
    const stale = await record();
    await prisma.interaction.create({ data: { organizationId, customerId: stale, channel: 'OTHER', kind: 'NOTE', direction: 'INTERNAL', occurredAt: ago(20), payload: crmNote(human) } as never });
    await audit(stale, { action: 'customer.assignment_changed', actorType: 'HUMAN_AGENT', userId: human, createdAt: now });
    // An AI's status change and a workflow note today do not advance it either.
    await audit(stale, { actorType: 'AI_AGENT', userId: ai, createdAt: now });
    await note(stale, { source: 'workflow' }, { occurredAt: now });

    const read = await new IntakeEligibilityRepository(prisma).read(organizationId, now);
    const ids = new Set(read.records.map((r) => r.id));
    for (const [name, id] of Object.entries(cases)) assert.equal(ids.has(id), false, `${name} must not be intake`);
    assert.deepEqual([...ids].sort(), [worked, stale].sort());
    const s = read.records.find((r) => r.id === stale)!;
    assert.equal(s.lastWorkedAt!.getTime(), ago(20).getTime(), 'assignment, AI and workflow acts do not move the work clock');
    assert.equal(s.stalled, true);
    // Org B holds no such record: its evidence makes nothing eligible there.
    assert.equal((await new IntakeEligibilityRepository(prisma).read(otherOrg, now)).records.length, 0);
  } finally {
    for (const id of [organizationId, otherOrg]) await prisma.organization.delete({ where: { id } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});

test('TIME: exactly 14 days is not stalled, one second more is; future acts beyond the skew allowance are ignored; a web lead enters at its form submission, never lastSeenAt', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const organizationId = `org_intake_time_${randomUUID()}`;
  try {
    await prisma.organization.create({ data: { id: organizationId, name: 'TIME', slug: organizationId } });
    const human = `u_t_${randomUUID()}`;
    await member(prisma, organizationId, human, 'OWNER');
    const now = new Date('2026-09-29T12:00:00.000Z');
    const at = (ms: number) => new Date(now.getTime() + ms);
    const rec = async (data: Record<string, unknown> = {}) => (await prisma.customer.create({ data: { organizationId, metadata: { createdFrom: 'callgrid' }, attributes: { pipelineStatus: 'Contacted' }, createdAt: at(-90 * DAY), lastSeenAt: at(-90 * DAY), ...data } as never })).id;
    const noteAt = (customerId: string, when: Date) => prisma.interaction.create({ data: { organizationId, customerId, channel: 'OTHER', kind: 'NOTE', direction: 'INTERNAL', occurredAt: when, payload: { loopKind: 'crm_note', actorType: 'HUMAN_AGENT', actorUserId: human, actorName: 'x', body: 'b' } } as never });
    const exactly14 = await rec(); await noteAt(exactly14, at(-14 * DAY));
    const past14 = await rec(); await noteAt(past14, at(-14 * DAY - 1000));
    const farFuture = await rec(); await noteAt(farFuture, at(DAY)); //           malformed: only act is a day ahead
    const skewed = await rec(); await noteAt(skewed, at(60_000)); //             within the 5-minute allowance
    const futurePlusOld = await rec(); await noteAt(futurePlusOld, at(-20 * DAY)); await noteAt(futurePlusOld, at(30 * DAY));
    // A web lead created (ingested) 2 days ago from a form submitted 20 days ago; its lastSeenAt says now.
    const lead = await rec({ metadata: { createdFrom: 'website' }, attributes: { pipelineStatus: 'New' }, createdAt: at(-2 * DAY), lastSeenAt: now });
    await prisma.interaction.create({ data: { organizationId, customerId: lead, channel: 'WEB_CHAT', kind: 'FORM_SUBMISSION', direction: 'INBOUND', provider: 'website', externalId: `f_${randomUUID()}`, occurredAt: at(-20 * DAY) } as never });
    const leadNoForm = await rec({ metadata: { createdFrom: 'website' }, attributes: {}, createdAt: at(-3 * DAY), lastSeenAt: at(-100 * DAY) });

    const read = await new IntakeEligibilityRepository(prisma).read(organizationId, now);
    const by = new Map(read.records.map((r) => [r.id, r]));
    assert.equal(by.get(exactly14)!.stalled, false, 'exactly 14 days is not stalled');
    assert.equal(by.get(past14)!.stalled, true, '14 days and a second is');
    assert.equal(by.has(farFuture), false, 'an act dated a day ahead is malformed: not evidence');
    assert.equal(by.get(skewed)!.lastWorkedAt!.getTime(), now.getTime(), 'within the skew allowance it counts as now, never later');
    assert.deepEqual([by.get(futurePlusOld)!.lastWorkedAt!.getTime(), by.get(futurePlusOld)!.stalled], [at(-20 * DAY).getTime(), true], 'a future act cannot keep a record fresh');
    assert.deepEqual([by.get(lead)!.enteredAt.getTime(), by.get(lead)!.clockAt.getTime(), by.get(lead)!.stalled], [at(-20 * DAY).getTime(), at(-20 * DAY).getTime(), true], 'entered at its submission; lastSeenAt ignored');
    assert.deepEqual([by.get(leadNoForm)!.enteredAt.getTime(), by.get(leadNoForm)!.status, by.get(leadNoForm)!.stalled], [at(-3 * DAY).getTime(), 'New', false], 'no submission attached: the creator stamp; a missing status on a lead reads New');
  } finally {
    await prisma.organization.delete({ where: { id: organizationId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});

test('CONSISTENCY: once a person works a record, every surface reads the same intake at once; excluded records stay reachable as records', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const organizationId = `org_intake_cons_${randomUUID()}`;
  try {
    await prisma.organization.create({ data: { id: organizationId, name: 'CONS', slug: organizationId } });
    const human = `u_c_${randomUUID()}`;
    await member(prisma, organizationId, human, 'OWNER');
    const now = new Date();
    const old = new Date(now.getTime() - 60 * DAY);
    await prisma.customer.createMany({ data: Array.from({ length: 40 }, () => ({ organizationId, metadata: { createdFrom: 'callgrid' }, attributes: { pipelineStatus: 'New' }, createdAt: old, lastSeenAt: old, updatedAt: old })) });
    const crm = new CrmRepository(prisma);
    const intake = new IntakeEligibilityRepository(prisma);
    const first = (await prisma.customer.findFirst({ where: { organizationId }, select: { id: true } }))!.id;
    await crm.setPipelineStatus(organizationId, first, 'Quoted', { userId: human, name: 'Dana', systemRole: 'OWNER' });

    const counts = await intake.counts(organizationId, now);
    assert.deepEqual([counts.eligible, counts.excluded, counts.working, counts.byStatus.Quoted], [1, 39, 1, 1], 'Home, CRM home and the organization page read exactly this');
    const board = await crm.kanbanBoard(organizationId, now);
    assert.deepEqual([board.columns.find((c) => c.status === 'Quoted')!.count, board.columns.reduce((n, c) => n + c.count, 0), board.notIntake], [1, 1, 39]);
    const { pipelineContextOf } = await import('../src/services/intelligence-fabric/domains/records');
    const ctx = pipelineContextOf(await intake.read(organizationId, now), now, { conversations: 0, conversationsAssigned: 0 });
    assert.deepEqual(ctx.intake, counts, 'the Pipeline reading counts exactly what the surfaces show');
    const probe = await new PipelineCompositionRepository(readOnlyClient(prisma)).read(organizationId, now, new Date(now.getTime() - 14 * DAY));
    assert.deepEqual(probe.intake.counts, counts, 'and so does the diagnostic');
    // Excluded records are records: the list and its counts still hold all 40, untouched.
    const list = await crm.listCustomers(organizationId, { pageSize: 50 });
    assert.equal(list.total, 40);
    assert.equal(Object.values(await crm.recordStatusCounts(organizationId)).reduce((a, b) => a + b, 0), 40);
  } finally {
    await prisma.organization.delete({ where: { id: organizationId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});

test('ATOMIC: a Party link or reversal whose audit entry fails is rolled back -- no link without its trail', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const organizationId = `org_intake_atom_${randomUUID()}`;
  try {
    await prisma.organization.create({ data: { id: organizationId, name: 'ATOM', slug: organizationId } });
    const human = `u_a_${randomUUID()}`;
    await member(prisma, organizationId, human, 'OWNER');
    const party = await prisma.cognitiveIdentity.create({ data: { organizationId, entityType: 'PERSON', canonicalKey: `atom:${randomUUID()}`, establishedAt: new Date(), establishmentBasis: 'MANUAL' } });
    const customer = await prisma.customer.create({ data: { organizationId, metadata: { createdFrom: 'callgrid' }, attributes: { pipelineStatus: 'New' } } });
    const { CustomerPartyLinkService } = await import('../src/services/customer-party-link.service');
    const { AuditRepository } = await import('../src/repositories/audit.repository');
    const deps = { iam: { can: async () => true, getUser: async () => null } as never, references: { requireReferenceable: async () => ({ ok: true, reference: { partyId: party.id } }) } as never };
    const failing = new CustomerPartyLinkService(prisma, { ...deps, audit: { record: async () => { throw new Error('audit store unavailable'); } } });
    await assert.rejects(failing.link(organizationId, human, { customerId: customer.id, partyId: party.id }));
    assert.equal(await prisma.customerPartyLink.count({ where: { organizationId } }), 0, 'the link rolled back with its audit');
    assert.equal((await new IntakeEligibilityRepository(prisma).read(organizationId, new Date())).records.length, 0, 'so it cannot make the record intake');

    const working = new CustomerPartyLinkService(prisma, { ...deps, audit: new AuditRepository(prisma) });
    assert.equal((await working.link(organizationId, human, { customerId: customer.id, partyId: party.id })).outcome, 'LINKED');
    assert.equal(await prisma.auditLog.count({ where: { organizationId, action: 'customer.party_linked', entityId: customer.id, userId: human } }), 1);
    await assert.rejects(failing.reverse(organizationId, human, { customerId: customer.id, reason: 'wrong person' }));
    assert.equal(await prisma.customerPartyLink.count({ where: { organizationId, reversedAt: null } }), 1, 'the reversal rolled back with its audit');
    assert.equal((await working.reverse(organizationId, human, { customerId: customer.id, reason: 'wrong person' })).outcome, 'REVERSED');
    assert.equal(await prisma.auditLog.count({ where: { organizationId, action: 'customer.party_link_reversed' } }), 1);
  } finally {
    await prisma.organization.delete({ where: { id: organizationId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});

test('ONE SOURCE OF TRUTH: no surface reconstructs intake -- status filters live only in the records list and the labelled v1 diagnostic, and nothing reads lastSeenAt as activity', async () => {
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const { join, relative } = await import('node:path');
  const root = join(__dirname, '..', '..', '..');
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'test' || name === '.next' || name === 'dist') continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\.|verification\.ts$/.test(name)) files.push(p);
    }
  };
  for (const d of ['apps/web/src', 'apps/connections-worker/src', 'packages/database/src', 'packages/intelligence/src', 'packages/shared/src']) walk(join(root, d));
  const code = (p: string) => readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  const using = (re: RegExp) => files.filter((f) => re.test(code(f))).map((f) => relative(root, f)).sort();
  // The per-status filter: the records list (CrmRepository) and the diagnostic's labelled pre-repair view only.
  assert.deepEqual(using(/customerStatusWhere\(/), ['packages/database/src/repositories/crm.repository.ts', 'packages/database/src/repositories/intelligence/pipeline-composition.repository.ts']);
  // All-records status counts: defined in the CRM repository, read only by the records list.
  assert.deepEqual(using(/recordStatusCounts\(/), ['apps/web/src/app/crm/customers/page.tsx', 'packages/database/src/repositories/crm.repository.ts']);
  assert.deepEqual(using(/\.statusCounts\(/), [], 'the old everyone-by-status read is gone');
  // Intake reads go through the one repository.
  for (const surface of ['apps/web/src/app/app/_home/front-door-data.ts', 'apps/web/src/crm/command-center-data.ts', 'apps/web/src/app/crm/organizations/[id]/page.tsx']) {
    assert.match(code(join(root, surface)), /intake\.counts\(/, surface);
  }
  // lastSeenAt: never in a web surface's logic; in the database package only where it is not activity (the
  // records-list sort type, the customer upsert, the v1 diagnostic comparison, a revenue scan order).
  assert.deepEqual(using(/lastSeenAt/).filter((f) => f.startsWith('apps/web/')), []);
  assert.equal(/lastSeenAt/.test(code(join(root, 'packages/database/src/repositories/intake-eligibility.repository.ts'))), false);
  assert.equal(/lastSeenAt/.test(code(join(root, 'packages/database/src/services/intelligence-fabric/domains/records.ts'))), false);
});
