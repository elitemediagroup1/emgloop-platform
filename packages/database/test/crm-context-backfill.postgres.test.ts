// CRM slice 6 against a REAL Postgres: the historical-context backfill, end to end over a real
// CONTACTS_ONLY import. OPT-IN AND LOCAL ONLY: LOOP_TEST_POSTGRES_URL. Synthetic data only.
//
// Proves:
//   - the backfill reads the import's OWN source, pinned by SHA-256 (SOURCE_MISMATCH otherwise), and
//     matches rows by line + key + keyed fingerprint (a changed row is skipped, never guessed);
//   - a dry run writes nothing and returns counts and a plan digest; APPLY refuses a different digest;
//   - it attaches title, notes, status, last-contacted (DATE precision), creator and company context to
//     the subjects the import created -- no new Party, Contact Point, Opportunity, Relationship,
//     Participant or identity evidence;
//   - imported text is redacted of contact values, counted, and kept out of audit and outbox;
//   - idempotent and retry-safe: a rerun records nothing new;
//   - OWNER/ADMIN only; another tenant's run is RUN_NOT_FOUND; production is refused outside the
//     commissioned workflow;
//   - the People directory then shows the context, and an imported-only contact is REVIEW_REQUIRED
//     with an unknown cadence position.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { CRM_IMPORT_CONFIG_VERSION, type CrmImportConfig } from '@emgloop/shared';

import { CrmImportService } from '../src/crm-import/crm-import.service';
import { CrmImportConfigService } from '../src/crm-import/crm-import-config.service';
import { CrmContextBackfillService } from '../src/crm-outreach/crm-context-backfill.service';
import { CrmPeopleCommandService } from '../src/crm-outreach/crm-people-command.service';

const LOCAL = (url: string) => /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url);
const URL = process.env.LOOP_TEST_POSTGRES_URL ?? '';
const skip = !URL ? 'LOOP_TEST_POSTGRES_URL is not set' : !LOCAL(URL) ? 'refusing a non-local database' : false;

const ROLES = ['OWNER', 'ADMIN', 'EMPLOYEE', 'READ_ONLY', 'AI_EMPLOYEE'] as const;
type Role = (typeof ROLES)[number];

async function tenant(prisma: PrismaClient, label: string) {
  const organizationId = `0bkf_${label}_${randomUUID()}`;
  await prisma.organization.create({ data: { id: organizationId, name: `BKF ${label}`, slug: organizationId } });
  const users = {} as Record<Role, string>;
  for (const role of ROLES) {
    const id = `user_bkf_${role.toLowerCase()}_${randomUUID()}`;
    await prisma.user.create({ data: { id, organizationId, email: `${id}@example.test`, name: `${role} person`, status: 'ACTIVE', metadata: { systemRole: role } } });
    await prisma.organizationMembership.create({ data: { organizationId, userId: id, systemRole: role, status: 'ACTIVE', effectiveFrom: new Date('2026-01-01T00:00:00Z') } });
    users[role] = id;
  }
  const actor = (role: Role) => ({ organizationId, userId: users[role] });
  const party = async (type: 'PERSON' | 'COMPANY', displayName: string) =>
    (await prisma.cognitiveIdentity.create({ data: { organizationId, entityType: type, canonicalKey: `party:${randomUUID()}`, displayName, status: 'KNOWN', establishedAt: new Date('2026-09-01T00:00:00Z'), establishmentBasis: 'MANUAL', establishedByUserId: users.OWNER } })).id;
  return { organizationId, users, actor, party };
}

const HEADER = 'source_row_key,creator_alias,route_key,source_status,route_name,brand_name,contact_name,contact_name_verified,contact_kind,contact_title,email,phone,source_notes,source_last_contacted_at';
const csv = (rows: string[][]) => [HEADER, ...rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(','))].join('\n') + '\n';
const ROWS: string[][] = [
  ['r1', 'Trevon Hill', 'lund', 'Followed up', 'Lund heading', 'Lund', 'Pat Rivera', 'TRUE', 'INDIVIDUAL', 'VP Marketing', 'pat@lund.example.test', '', 'call after the boat show; cell 415 555 0100 or pat.home@else.example.test', '2026-08-01'],
  ['r2', '', 'lund', 'Followed up', '', '', '', '', 'ROLE_INBOX', '', 'team@lund.example.test', '', 'shared inbox', ''],
  ['r3', 'Trevon Hill', 'lund', 'Followed up', '', 'Lund', 'Sam Lee', 'TRUE', 'INDIVIDUAL', 'Brand Lead', 'sam@lund.example.test', '', '', ''],
];
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

async function imported(prisma: PrismaClient, label: string) {
  const t = await tenant(prisma, label);
  const trevon = await t.party('PERSON', 'Trevon Hill');
  const cfg: CrmImportConfig = {
    version: CRM_IMPORT_CONFIG_VERSION,
    creatorAliases: [{ alias: 'Trevon Hill', creatorPartyId: trevon }],
    routes: [{ routeKey: 'lund', classification: 'BRAND_COMPANY', proposedCompanyName: 'Lund Boats' }],
    stageMapping: [{ sourceStatus: 'Followed up', action: 'CONTACTS_ONLY' }],
  };
  assert.equal((await new CrmImportConfigService(prisma).record(t.actor('ADMIN'), cfg)).outcome, 'RECORDED');
  const service = new CrmImportService(prisma, { applyTargetGuard: () => true });
  const source = { csvText: csv(ROWS), sourceRef: 'local' };
  const dry = await service.dryRun(t.actor('OWNER'), source, cfg.stageMapping);
  assert.equal(dry.outcome, 'OK');
  if (dry.outcome !== 'OK') throw new Error('dry run');
  const approval = await service.approve(t.actor('OWNER'), dry.runId);
  assert.equal(approval.outcome, 'APPROVED');
  if (approval.outcome !== 'APPROVED') throw new Error('approve');
  const applied = await service.apply(t.actor('OWNER'), { source, stageMapping: cfg.stageMapping, approvalId: approval.approvalId, executionTarget: 'LOCAL_TEST' });
  assert.equal(applied.outcome, 'APPLIED');
  const run = await prisma.crmImportRun.findFirstOrThrow({ where: { organizationId: t.organizationId, mode: 'APPLY' } });
  return { ...t, trevon, runId: run.id, csvText: source.csvText };
}

async function counts(prisma: PrismaClient, organizationId: string) {
  return {
    parties: await prisma.cognitiveIdentity.count({ where: { organizationId } }),
    contactPoints: await prisma.crmContactPoint.count({ where: { organizationId } }),
    opportunities: await prisma.crmOpportunity.count({ where: { organizationId } }),
    relationships: await prisma.crmRelationship.count({ where: { organizationId } }),
    participants: await prisma.crmParticipant.count({ where: { organizationId } }),
    evidence: await prisma.identityEvidence.count({ where: { organizationId } }),
  };
}

test('backfill: pinned, dry-run first, digest-bound, no new CRM subjects, redacted, idempotent', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  try {
    const t = await imported(prisma, 'main');
    const other = await tenant(prisma, 'other');
    const svc = new CrmContextBackfillService(prisma, { targetGuard: () => true });
    const before = await counts(prisma, t.organizationId);

    // Authority, tenancy, pinning.
    assert.equal((await svc.dryRun(t.actor('EMPLOYEE'), t.runId, t.csvText)).outcome, 'NOT_AUTHORIZED');
    assert.equal((await svc.dryRun(t.actor('AI_EMPLOYEE'), t.runId, t.csvText)).outcome, 'NOT_AUTHORIZED');
    assert.equal((await svc.dryRun(other.actor('OWNER'), t.runId, t.csvText)).outcome, 'RUN_NOT_FOUND');
    const tampered = t.csvText.replace('VP Marketing', 'VP Sales');
    assert.deepEqual(await svc.dryRun(t.actor('OWNER'), t.runId, tampered), { outcome: 'SOURCE_MISMATCH', expected: sha(t.csvText), actual: sha(tampered) });
    const dryRunRun = await prisma.crmImportRun.findFirstOrThrow({ where: { organizationId: t.organizationId, mode: 'DRY_RUN' } });
    assert.equal((await svc.dryRun(t.actor('OWNER'), dryRunRun.id, t.csvText)).outcome, 'RUN_NOT_APPLY');

    // Dry run: counts and a digest; nothing written.
    const dry = await svc.dryRun(t.actor('ADMIN'), t.runId, t.csvText);
    assert.equal(dry.outcome, 'DRY_RUN');
    if (dry.outcome !== 'DRY_RUN') return;
    assert.equal(await prisma.crmSubjectContextFact.count({ where: { organizationId: t.organizationId } }), 0);
    assert.deepEqual(dry.plan.planned, { TITLE: 2, NOTE: 2, SOURCE_STATUS: 3, SOURCE_LAST_CONTACTED: 1, CREATOR_CONTEXT: 2, COMPANY_CONTEXT: 2, ORIGIN: 0 });
    assert.deepEqual(dry.plan.subjects, { people: 2, companies: 1 });
    assert.equal(dry.plan.redactions, 2);
    assert.equal(dry.plan.alreadyRecorded, 0);
    assert.equal(dry.plan.entries.used, 3);
    // The plan output is printable: no title, note, address or name in it.
    const printed = JSON.stringify(dry);
    for (const s of ['VP Marketing', 'boat show', 'pat@', '415', 'Pat Rivera', 'Trevon']) assert.equal(printed.includes(s), false, s);

    // APPLY needs the reviewed digest, and production needs the commissioned workflow.
    assert.equal((await svc.apply(t.actor('OWNER'), t.runId, t.csvText, 'not-the-digest')).outcome, 'PLAN_CHANGED');
    assert.equal((await svc.apply(t.actor('OWNER'), t.runId, t.csvText, dry.plan.planDigest, 'PRODUCTION')).outcome, 'PRODUCTION_NOT_COMMISSIONED');
    assert.equal((await new CrmContextBackfillService(prisma, { targetGuard: () => false }).apply(t.actor('OWNER'), t.runId, t.csvText, dry.plan.planDigest)).outcome, 'TARGET_REFUSED');
    assert.equal(await prisma.crmSubjectContextFact.count({ where: { organizationId: t.organizationId } }), 0);

    const applied = await svc.apply(t.actor('OWNER'), t.runId, t.csvText, dry.plan.planDigest);
    assert.equal(applied.outcome, 'APPLIED');
    if (applied.outcome !== 'APPLIED') return;
    assert.deepEqual([applied.recorded, applied.unchanged], [12, 0]);
    assert.deepEqual(await counts(prisma, t.organizationId), before, 'no Party, Contact Point, Opportunity, Relationship, Participant or evidence');

    const pat = (await prisma.crmImportEntry.findFirstOrThrow({ where: { importRunId: t.runId, line: 2 } })).personPartyId!;
    const company = (await prisma.crmImportEntry.findFirstOrThrow({ where: { importRunId: t.runId, line: 2 } })).companyPartyId!;
    const facts = await prisma.crmSubjectContextFact.findMany({ where: { organizationId: t.organizationId, partyId: pat } });
    const of = (k: string) => facts.find((f) => f.kind === k)!;
    assert.equal(of('TITLE').text, 'VP Marketing');
    assert.equal(of('NOTE').text, 'call after the boat show; cell [contact value withheld] or [contact value withheld]');
    assert.equal(of('NOTE').redactions, 2);
    assert.equal(of('NOTE').occurredAtPrecision, 'UNKNOWN');
    assert.equal(of('NOTE').occurredAt, null);
    assert.deepEqual([of('SOURCE_LAST_CONTACTED').occurredAt?.toISOString(), of('SOURCE_LAST_CONTACTED').occurredAtPrecision], ['2026-08-01T00:00:00.000Z', 'DATE']);
    assert.deepEqual([of('CREATOR_CONTEXT').text, of('CREATOR_CONTEXT').relatedPartyId], ['Trevon Hill', t.trevon]);
    assert.deepEqual([of('COMPANY_CONTEXT').relatedPartyId, of('COMPANY_CONTEXT').basis], [company, 'IMPORTED']);
    assert.ok(facts.every((f) => f.importRunId === t.runId && f.importLine === 2 && f.sourceRef === `crm-context-backfill.v1:${t.runId}:2`));
    // The shared inbox's note sits on the Company, never on a person.
    assert.deepEqual((await prisma.crmSubjectContextFact.findMany({ where: { organizationId: t.organizationId, partyId: company } })).map((f) => f.kind).sort(), ['NOTE', 'SOURCE_STATUS']);

    // No text in audit or outbox; one summary audit row.
    const blob = JSON.stringify([await prisma.auditLog.findMany({ where: { organizationId: t.organizationId, action: 'crm_context.backfill_applied' } }), await prisma.stateChangeOutbox.findMany({ where: { organizationId: t.organizationId } })]);
    for (const s of ['VP Marketing', 'boat show', 'Brand Lead', '[contact value withheld]']) assert.equal(blob.includes(s), false, s);
    assert.equal(await prisma.auditLog.count({ where: { organizationId: t.organizationId, action: 'crm_context.backfill_applied' } }), 1);

    // Idempotent: the same plan again records nothing, and its digest is unchanged.
    const again = await svc.dryRun(t.actor('OWNER'), t.runId, t.csvText);
    assert.equal(again.outcome === 'DRY_RUN' && again.plan.planDigest, dry.plan.planDigest);
    assert.equal(again.outcome === 'DRY_RUN' && again.plan.alreadyRecorded, 12);
    const rerun = await svc.apply(t.actor('OWNER'), t.runId, t.csvText, dry.plan.planDigest);
    assert.deepEqual(rerun.outcome === 'APPLIED' && [rerun.recorded, rerun.unchanged], [0, 12]);
    assert.equal(await prisma.crmSubjectContextFact.count({ where: { organizationId: t.organizationId } }), 12);
    assert.equal(await prisma.auditLog.count({ where: { organizationId: t.organizationId, action: 'crm_context.backfill_applied' } }), 1, 'no audit row for a rerun that wrote nothing');

    // The directory now carries the context; an imported-only contact is REVIEW_REQUIRED, cadence unknown.
    const dir = await new CrmPeopleCommandService(prisma).directory(t.actor('ADMIN'), { gmail: { freshness: 'CURRENT', lastReadAt: new Date('2026-10-08T14:00:00Z') }, calendar: null }, { now: new Date('2026-10-08T15:00:00Z'), timeZone: 'UTC' });
    assert.equal(dir.outcome, 'OK');
    if (dir.outcome !== 'OK') return;
    const row = dir.rows.find((r) => r.partyId === pat)!;
    assert.deepEqual([row.title?.text, row.company?.name, row.creator?.label, row.origin, row.sourceStatus], ['VP Marketing', 'Lund Boats', 'Trevon Hill', 'IMPORTED', 'Followed up']);
    assert.equal(row.outreach.state, 'REVIEW_REQUIRED');
    assert.equal(row.outreach.reviewReason, 'IMPORTED_HISTORY_ONLY');
    assert.equal(row.outreach.cadence.status, 'UNKNOWN');
    assert.deepEqual(row.outreach.lastTouch, { at: new Date('2026-08-01T00:00:00Z'), source: 'IMPORT', precision: 'DATE' });
  } finally {
    await prisma.$disconnect();
  }
});
