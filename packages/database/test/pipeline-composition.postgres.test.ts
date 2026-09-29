// What the Pipeline reading is counting, against a REAL Postgres (2026-09-29). OPT-IN AND LOCAL ONLY.
// Mixed statuses (ABSENT, known values, OTHER), old and new records, a lastSeenAt that never moved and one
// that did, real recent activity of each kind, provenance that is VERIFIED from a creator's mark, HEURISTIC
// from a convention, and UNKNOWN when a record merely looks like a legacy caller -- all on the read-only
// client, counts only, nothing written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

import { readOnlyClient } from '../src/repositories/read-only-client';
import { PipelineCompositionRepository } from '../src/repositories/intelligence/pipeline-composition.repository';

const LOCAL = (url: string) => /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url);
const URL = process.env.LOOP_TEST_POSTGRES_URL ?? '';
const skip = !URL ? 'LOOP_TEST_POSTGRES_URL is not set' : !LOCAL(URL) ? 'refusing a non-local database' : false;
const DAY = 864e5;

test('PIPELINE COMPOSITION: status, provenance with its basis, human work, the clock, the cutoff, real activity and nameable ids -- exact, read-only, no content', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const organizationId = `org_pipe_${randomUUID()}`;
  const otherOrg = `org_pipe_other_${randomUUID()}`;
  try {
    for (const id of [organizationId, otherOrg]) await prisma.organization.create({ data: { id, name: 'PIPE', slug: id } });
    const userId = `user_pipe_${randomUUID()}`;
    await prisma.user.create({ data: { id: userId, organizationId, email: `${userId}@example.test`, name: 'P', status: 'ACTIVE', metadata: { systemRole: 'OWNER' } } });
    const now = new Date();
    const ago = (d: number) => new Date(now.getTime() - d * DAY);
    const slice1 = ago(30);
    const old = ago(60);
    const customer = (data: Record<string, unknown>) =>
      prisma.customer.create({ data: { organizationId, createdAt: old, lastSeenAt: old, updatedAt: old, ...data } as never });

    // 1. The legacy caller, PROVEN: the creator's mark, a phone, no name or email; its clock never moved.
    const callerOnly = await customer({ phone: '+15550101', metadata: { createdFrom: 'callgrid' }, attributes: { pipelineStatus: 'New', firstSource: 'callgrid' }, tags: ['lead'] });
    // 2. Created from a call, later given a name: a person's CRM note three days ago.
    const withIdentity = await customer({ phone: '+15550102', firstName: 'Dana', metadata: { createdFrom: 'callgrid' }, attributes: { pipelineStatus: 'Contacted' } });
    // 3. An anonymous visitor, PROVEN (the creator's externalId and mark).
    await customer({ externalId: `web-visitor:${randomUUID()}`, metadata: { createdFrom: 'website', visitorId: 'v' }, tags: ['anonymous-visitor'], attributes: { pipelineStatus: 'New' } });
    // 4. A web lead, Booked: not working.
    await customer({ email: 'lead@secret.test', metadata: { createdFrom: 'website' }, attributes: { pipelineStatus: 'Booked' } });
    // 5. Demo by convention only (HEURISTIC); no status at all (ABSENT reads as New); its lastSeenAt moved.
    await customer({ externalId: `sic-demo-${randomUUID()}`, lastSeenAt: ago(40) });
    // 6. A visitor tag and nothing else (HEURISTIC); an unrecognised status (OTHER reads as New); created after
    //    the cutoff and recently, so working but not stalled.
    await customer({ tags: ['anonymous-visitor'], attributes: { pipelineStatus: 'Weird' }, createdAt: ago(2), lastSeenAt: ago(2), updatedAt: ago(2) });
    // 7. Nothing recorded; Archived.
    await customer({ attributes: { pipelineStatus: 'Archived' } });
    // 8. An external id with no mark (UNKNOWN); Quoted; recent activity of several kinds, none of it human.
    const extOnly = await customer({ externalId: `crm-import-${randomUUID()}`, attributes: { pipelineStatus: 'Quoted' } });
    // 9. LOOKS like a legacy caller -- phone only, the ingestion tags -- but carries no creator mark: UNKNOWN.
    await customer({ phone: '+15550109', tags: ['lead', 'inbound-call'], attributes: { pipelineStatus: 'New' } });
    // 10. Created after the cutoff but still carrying the ingestion mark (the deploy gap); old enough to stall.
    await customer({ phone: '+15550110', metadata: { createdFrom: 'callgrid' }, attributes: { pipelineStatus: 'New' }, createdAt: ago(20), lastSeenAt: ago(20), updatedAt: ago(20) });
    // Another organization's record: never counted.
    await prisma.customer.create({ data: { organizationId: otherOrg, phone: '+15550199', metadata: { createdFrom: 'callgrid' }, attributes: { pipelineStatus: 'New' }, createdAt: old, lastSeenAt: old } as never });

    // Activity: a person's note (recent), an old user audit, a recent system audit, a recent booking, a recent
    // workflow run naming the record, and a recent interaction on the caller.
    await prisma.interaction.create({ data: { organizationId, customerId: withIdentity.id, channel: 'PHONE', kind: 'NOTE', direction: 'INTERNAL', occurredAt: ago(3), payload: { loopKind: 'crm_note', actorType: 'HUMAN_AGENT', actorUserId: userId, actorName: 'P', body: 'Secret note' } } as never });
    await prisma.interaction.create({ data: { organizationId, customerId: callerOnly.id, channel: 'PHONE', direction: 'INBOUND', occurredAt: ago(1), payload: {} } as never });
    await prisma.auditLog.create({ data: { organizationId, userId, action: 'customer.updated', entityType: 'customer', entityId: extOnly.id, createdAt: ago(45) } as never });
    await prisma.auditLog.create({ data: { organizationId, action: 'customer.tagged', entityType: 'customer', entityId: extOnly.id, createdAt: ago(2) } as never });
    await prisma.booking.create({ data: { organizationId, customerId: extOnly.id, startAt: ago(-3), updatedAt: ago(2) } as never });
    const workflow = await prisma.workflow.create({ data: { organizationId, name: 'Secret workflow' } as never });
    await prisma.workflowRun.create({ data: { organizationId, workflowId: workflow.id, input: { context: { customerId: extOnly.id, caller: '+15550108' } }, createdAt: ago(1) } as never });

    const before = await Promise.all([prisma.customer.count(), prisma.interaction.count(), prisma.auditLog.count()]);
    const p = await new PipelineCompositionRepository(readOnlyClient(prisma)).read(organizationId, now, slice1);
    assert.deepEqual(await Promise.all([prisma.customer.count(), prisma.interaction.count(), prisma.auditLog.count()]), before, 'nothing written');

    assert.equal(p.records, 10);
    assert.equal(p.complete, true);
    assert.deepEqual(p.incomplete, []);
    const status = Object.fromEntries(p.byStatus.map((s) => [s.status, [s.total, s.working, s.stalled]]));
    assert.deepEqual(status, {
      ABSENT: [1, 1, 1], NEW: [4, 4, 4], CONTACTED: [1, 1, 1], QUOTED: [1, 1, 1],
      BOOKED: [1, 0, 0], COMPLETED: [0, 0, 0], ARCHIVED: [1, 0, 0], OTHER: [1, 1, 0],
    });
    const prov = Object.fromEntries(p.byProvenance.map((r) => [r.provenance, [r.basis, r.total, r.working, r.stalled, r.humanWork]]));
    assert.deepEqual(prov, {
      CALLGRID_INGESTION_CALLER_ONLY: ['VERIFIED', 2, 2, 2, 0],
      CALLGRID_INGESTION_WITH_IDENTITY: ['VERIFIED', 1, 1, 1, 1],
      WEB_VISITOR_INGESTION: ['VERIFIED', 1, 1, 1, 0],
      WEB_LEAD_INGESTION: ['VERIFIED', 1, 0, 0, 0],
      OTHER_INGESTION: ['VERIFIED', 0, 0, 0, 0],
      SEED_OR_DEMO_PREFIX: ['HEURISTIC', 1, 1, 1, 0],
      VISITOR_TAG_ONLY: ['HEURISTIC', 1, 1, 0, 0],
      EXTERNAL_ID_UNMARKED: ['UNKNOWN', 1, 1, 1, 1],
      UNKNOWN: ['UNKNOWN', 2, 1, 1, 0],
    }, 'the phone-only, ingestion-tagged record without a mark is UNKNOWN, never a proven caller');
    assert.deepEqual(p.humanWork, { bySignal: { HUMAN_NOTE: 1, USER_ACTION: 1, USER_PARTY_LINK: 0 }, any: 2, stalledAny: 2 });
    assert.deepEqual(p.clock.all, { lastSeenEqualsCreated: 9, lastSeenAfterCreated: 1, lastSeenBeforeCreated: 0 });
    assert.deepEqual(p.clock.stalled, { lastSeenEqualsCreated: 6, lastSeenAfterCreated: 1, lastSeenBeforeCreated: 0 });
    assert.deepEqual(p.cutoff, { at: slice1.toISOString(), createdBefore: { total: 8, working: 6, stalled: 6 }, createdAfter: { total: 2, working: 2, stalled: 1 }, afterWithIngestionMark: 1 });
    assert.deepEqual(p.stalledActivity, {
      windowDays: 14,
      byKind: { ROW_UPDATED: 0, INTERACTION: 2, HUMAN_NOTE: 1, CONVERSATION: 0, BOOKING: 1, ORDER: 0, SERVICE_REQUEST: 0, USER_ACTION: 0, SYSTEM_AUDIT: 1, WORKFLOW_RUN: 1, PARTY_LINK: 0 },
      any: 3,
      human: 1,
      none: 4,
    });
    assert.deepEqual(p.nameable, { stalled: 7, nameable: 7 });
    assert.equal(p.months.reduce((n, m) => n + m.total, 0), 10);

    // Counts and codes only.
    const text = JSON.stringify(p);
    for (const secret of ['+1555', 'Dana', 'secret', 'Secret', 'web-visitor:', 'sic-demo-', 'crm-import-', 'Weird', callerOnly.id, extOnly.id, organizationId, userId]) assert.equal(text.includes(secret), false, secret);
  } finally {
    for (const id of [organizationId, otherOrg]) await prisma.organization.delete({ where: { id } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});

test('PIPELINE COMPOSITION pages through the whole population: more records than one page, still complete and exact', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const organizationId = `org_pipe_pages_${randomUUID()}`;
  try {
    await prisma.organization.create({ data: { id: organizationId, name: 'PIPE', slug: organizationId } });
    const old = new Date(Date.now() - 60 * DAY);
    await prisma.customer.createMany({ data: Array.from({ length: 2_150 }, () => ({ organizationId, metadata: { createdFrom: 'callgrid' }, attributes: { pipelineStatus: 'New' }, createdAt: old, lastSeenAt: old, updatedAt: old })) });
    const p = await new PipelineCompositionRepository(readOnlyClient(prisma)).read(organizationId, new Date(), new Date(Date.now() - 30 * DAY));
    assert.equal(p.records, 2_150);
    assert.equal(p.complete, true);
    assert.deepEqual(p.nameable, { stalled: 2_150, nameable: 2_150 }, 'uncapped: the true population, not a page');
    assert.equal(p.byProvenance.find((r) => r.provenance === 'CALLGRID_INGESTION_CALLER_ONLY')!.stalled, 2_150);
    // A read that stops at its bound says so: never complete, and it names the reads that stopped.
    const cut = await new PipelineCompositionRepository(readOnlyClient(prisma), { maxRows: 2_000 }).read(organizationId, new Date(), new Date(Date.now() - 30 * DAY));
    assert.equal(cut.complete, false);
    assert.ok(cut.incomplete.includes('RECORDS') && cut.incomplete.includes('WORKING'), cut.incomplete.join(','));
  } finally {
    await prisma.organization.delete({ where: { id: organizationId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});
