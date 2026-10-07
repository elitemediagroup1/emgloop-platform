// CRM slice 5 against a REAL Postgres: the governed outreach importer end to end.
// OPT-IN AND LOCAL ONLY: LOOP_TEST_POSTGRES_URL. Synthetic data only (example.test addresses).
//
// Proves:
//   - authorization: the decided act table per role; AI_EMPLOYEE and CREATOR refused;
//   - reviewed mappings: recorded through the governed path, cross-tenant Parties refused,
//     changes append-only and refused without --replace;
//   - dry run: writes zero CRM rows, a deterministic plan, provenance with no raw values;
//   - APPLY: only an approved plan whose source, version, configuration and plan still match;
//     Companies and People established MANUAL by the operator; Contact Points IMPORTED with the
//     decided classifications; one Opportunity per creator x brand titled `<Creator> × <Brand>`,
//     BRAND + every PRIMARY_CONTACT, no owner, no Relationship, nothing creator-visible;
//   - never: AFFILIATION, IdentityEvidence, a Party from an unnamed address, a raw value in
//     provenance, audit or outbox;
//   - the stage gate: with no stage mapping, nothing is written;
//   - idempotency: a re-run creates nothing; a changed row is review;
//   - atomicity: a unit that fails leaves no half-created Company; resumption completes it once;
//   - approval consumption: an approval is consumed when an APPLY run CLAIMS it -- succeeded, failed or
//     abandoned alike; the database itself refuses a second claim and a dangling reference;
//   - concurrency: one APPLY at a time (database lock); a contested import key admits one subject;
//   - the production path is refused.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { CRM_IMPORT_CONFIG_VERSION, type CrmImportConfig } from '@emgloop/shared';

import { CrmImportService } from '../src/crm-import/crm-import.service';
import { CrmImportConfigService } from '../src/crm-import/crm-import-config.service';
import { CrmImportRepository } from '../src/crm-import/crm-import.repository';
import { CrmContactPointService } from '../src/services/crm-contact-point.service';
import { PartyService } from '../src/services/party.service';

const LOCAL = (url: string) => /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url);
const URL = process.env.LOOP_TEST_POSTGRES_URL ?? '';
const skip = !URL ? 'LOOP_TEST_POSTGRES_URL is not set' : !LOCAL(URL) ? 'refusing a non-local database' : false;

const ROLES = ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE', 'READ_ONLY', 'AI_EMPLOYEE', 'CREATOR'] as const;
type Role = (typeof ROLES)[number];

async function tenant(prisma: PrismaClient, label: string) {
  const organizationId = `0imp_${label}_${randomUUID()}`;
  await prisma.organization.create({ data: { id: organizationId, name: `IMP ${label}`, slug: organizationId } });
  const users = {} as Record<Role, string>;
  for (const role of ROLES) {
    const id = `user_imp_${role.toLowerCase()}_${randomUUID()}`;
    await prisma.user.create({ data: { id, organizationId, email: `${id}@example.test`, name: `${role} person`, status: 'ACTIVE', metadata: { systemRole: role } } });
    await prisma.organizationMembership.create({ data: { organizationId, userId: id, systemRole: role, status: 'ACTIVE', effectiveFrom: new Date('2026-01-01T00:00:00Z') } });
    users[role] = id;
  }
  const actor = (role: Role) => ({ organizationId, userId: users[role] });
  const party = async (type: 'PERSON' | 'COMPANY', displayName: string) =>
    (
      await prisma.cognitiveIdentity.create({
        data: { organizationId, entityType: type, canonicalKey: `party:${randomUUID()}`, displayName, status: 'KNOWN', establishedAt: new Date('2026-09-01T00:00:00Z'), establishmentBasis: 'MANUAL', establishedByUserId: users.OWNER },
      })
    ).id;
  return { organizationId, users, actor, party };
}

const HEADER = 'source_row_key,creator_alias,route_key,source_status,route_name,brand_name,contact_name,contact_name_verified,contact_kind,contact_title,email,phone,source_notes,source_last_contacted_at';
const csv = (rows: string[][]) => [HEADER, ...rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(','))].join('\n') + '\n';
//            key    creator          route        status     route_name    brand          contact              ver     kind          title            email                     phone           notes               last
const ROWS: string[][] = [
  ['r1', 'Trevon Hill', 'lund', 'Mapped', 'Lund heading', 'Lund', 'Pat Rivera', 'TRUE', 'INDIVIDUAL', 'VP Marketing', 'pat@lund.example.test', '', 'call after the boat show', '2026-08-01'],
  ['r2', 'Trevon Hill', 'lund', 'Mapped', '', '', '', '', 'ROLE_INBOX', '', 'team@lund.example.test', '', '', ''],
  ['r3', 'Trevon Hill', 'lund', 'Mapped', '', '', 'Name not verified', 'TRUE', 'INDIVIDUAL', '', 'jane.doe@lund.example.test', '', '', ''],
  ['r4', 'Katrina', 'brother', 'Mapped', '', 'Brother', 'Sam Lee', 'TRUE', 'INDIVIDUAL', 'Brand Lead', 'sam@brother.example.test', '+1 (415) 555-0100', '', ''],
  ['r5', 'trevon   HILL', 'agency-x', 'Mapped', '', '', 'Alex Kim', 'TRUE', 'INDIVIDUAL', '', 'alex@agencyx.example.test', '', '', ''],
  ['r6', 'Trevon Hill', 'gmail', 'Mapped', '', '', '', '', '', '', 'someone@gmail.example.test', '', '', ''],
  ['r7', 'Trevon Hill', 'emg', 'Mapped', '', '', '', '', '', '', 'staff@emg.example.test', '', '', ''],
  ['r8', 'Unmapped Creator', 'lund', 'Mapped', '', '', '', '', '', '', 'other@lund.example.test', '', '', ''],
  ['r9', 'Katrina', 'lund', 'Not due', '', '', '', '', '', '', 'notdue@lund.example.test', '', '', ''],
  ['r10', 'Trevon Hill', 'nobody-reviewed', 'Mapped', '', '', '', '', '', '', 'x@unreviewed.example.test', '', '', ''],
];
const SECRETS = ['pat@lund', 'team@lund', 'jane.doe', 'sam@brother', '4155550100', '555-0100', 'alex@agencyx', 'someone@gmail', 'VP Marketing', 'Brand Lead', 'call after the boat show', 'notdue@'];

function config(t: { creators: { trevon: string; katrina: string }; brother: string }, stageMapping: CrmImportConfig['stageMapping'] = [
  { sourceStatus: 'Mapped', action: 'OPPORTUNITY', category: 'OPEN', stage: 'Imported' },
]): CrmImportConfig {
  return {
    version: CRM_IMPORT_CONFIG_VERSION,
    creatorAliases: [
      { alias: 'Trevon Hill', creatorPartyId: t.creators.trevon },
      { alias: 'Katrina', creatorPartyId: t.creators.katrina },
    ],
    routes: [
      { routeKey: 'lund', classification: 'BRAND_COMPANY', proposedCompanyName: 'Lund Boats' },
      { routeKey: 'brother', classification: 'BRAND_COMPANY', targetCompanyPartyId: t.brother },
      { routeKey: 'agency-x', classification: 'AGENCY', proposedCompanyName: 'Agency X', representedBrandRouteKey: 'lund' },
      { routeKey: 'gmail', classification: 'PERSONAL_GENERIC' },
      { routeKey: 'emg', classification: 'INTERNAL' },
    ],
    stageMapping,
  };
}

async function crmCounts(prisma: PrismaClient, organizationId: string) {
  const [parties, contactPoints, opportunities, participants, relationships, evidence, transitions] = await Promise.all([
    prisma.cognitiveIdentity.count({ where: { organizationId } }),
    prisma.crmContactPoint.count({ where: { organizationId } }),
    prisma.crmOpportunity.count({ where: { organizationId } }),
    prisma.crmParticipant.count({ where: { organizationId } }),
    prisma.crmRelationship.count({ where: { organizationId } }),
    prisma.identityEvidence.count({ where: { organizationId } }),
    prisma.crmOpportunityTransition.count({ where: { organizationId } }),
  ]);
  return { parties, contactPoints, opportunities, participants, relationships, evidence, transitions };
}

async function setup(prisma: PrismaClient, label: string) {
  const t = await tenant(prisma, label);
  const creators = { trevon: await t.party('PERSON', 'Trevon Hill'), katrina: await t.party('PERSON', 'Katrina') };
  const brother = await t.party('COMPANY', 'Brother');
  const cfg = config({ creators, brother });
  const recorded = await new CrmImportConfigService(prisma).record(t.actor('ADMIN'), cfg);
  assert.equal(recorded.outcome, 'RECORDED');
  return { ...t, creators, brother, cfg };
}

const local = (prisma: PrismaClient, deps: ConstructorParameters<typeof CrmImportService>[1] = {}) => new CrmImportService(prisma, { applyTargetGuard: () => true, ...deps });

test('the full path: dry run writes no CRM row; an approved APPLY writes exactly the governed result', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  try {
    const t = await setup(prisma, 'full');
    const service = local(prisma);
    const source = { csvText: csv(ROWS), sourceRef: 'local' };

    const before = await crmCounts(prisma, t.organizationId);
    const dry = await service.dryRun(t.actor('EMPLOYEE'), source, t.cfg.stageMapping);
    assert.equal(dry.outcome, 'OK');
    if (dry.outcome !== 'OK') return;
    assert.deepEqual(await crmCounts(prisma, t.organizationId), before, 'a dry run writes no CRM row');
    const outcomes = Object.fromEntries(dry.prepared.plan.rows.map((r) => [r.sourceRowKey, r.outcome]));
    assert.deepEqual(outcomes, {
      r1: 'READY',
      r2: 'READY',
      r3: 'READY',
      r4: 'READY',
      r5: 'READY',
      r6: 'NO_COMPANY_CONTEXT',
      r7: 'ROUTE_NOT_IMPORTABLE',
      r8: 'CREATOR_ALIAS_UNMAPPED',
      r9: 'STAGE_MAPPING_REQUIRED',
      r10: 'ROUTE_UNMAPPED',
    });
    // Deterministic: the same source and configuration give the same plan.
    const again = await service.dryRun(t.actor('EMPLOYEE'), source, t.cfg.stageMapping);
    assert.ok(again.outcome === 'OK');
    assert.equal(again.prepared.planDigest, dry.prepared.planDigest);
    assert.deepEqual(again.prepared.plan, dry.prepared.plan);

    // Provenance: ids, codes and keyed fingerprints -- no value, name, title or note.
    const runRow = await prisma.crmImportRun.findUniqueOrThrow({ where: { id: dry.runId } });
    assert.deepEqual([runRow.mode, runRow.state, runRow.importerVersion, runRow.startedByUserId], ['DRY_RUN', 'SUCCEEDED', 'crm-outreach-import.v2', t.users.EMPLOYEE]);
    const entries = await prisma.crmImportEntry.findMany({ where: { importRunId: dry.runId } });
    assert.equal(entries.length, ROWS.length);
    for (const e of entries) {
      for (const a of e.contactPointActions as Record<string, unknown>[]) assert.deepEqual(Object.keys(a).sort(), ['action', 'classification', 'kind'], 'kind, classification and action only -- never a value or its hash');
    }
    const provenance = JSON.stringify([runRow, entries]);
    for (const s of [...SECRETS, 'Pat Rivera', 'Alex Kim', 'Sam Lee']) assert.ok(!provenance.includes(s), `provenance never holds "${s}"`);

    // APPLY needs an approval, by OWNER/ADMIN.
    assert.deepEqual(await service.approve(t.actor('EMPLOYEE'), dry.runId), { outcome: 'NOT_AUTHORIZED' });
    const approval = await service.approve(t.actor('OWNER'), dry.runId);
    assert.equal(approval.outcome, 'APPROVED');
    if (approval.outcome !== 'APPROVED') return;
    assert.deepEqual(await service.approve(t.actor('OWNER'), dry.runId), { outcome: 'ALREADY_APPROVED' });

    const auditBefore = await prisma.auditLog.count({ where: { organizationId: t.organizationId } });
    const applied = await service.apply(t.actor('OWNER'), { source, stageMapping: t.cfg.stageMapping, approvalId: approval.approvalId, executionTarget: 'LOCAL_TEST' });
    assert.equal(applied.outcome, 'APPLIED', JSON.stringify(applied));
    const after = await crmCounts(prisma, t.organizationId);
    assert.deepEqual(
      { ...after, parties: after.parties - before.parties },
      { parties: 5, contactPoints: 7, opportunities: 2, participants: 5, relationships: 0, evidence: before.evidence, transitions: 2 },
      'Lund Boats + Agency X + Pat + Sam + Alex; 7 Contact Points; Trevon × Lund Boats and Katrina × Brother; no Relationship, no IdentityEvidence',
    );

    // Companies and People: established MANUAL by the operator; no Person from an unnamed address.
    const created = await prisma.cognitiveIdentity.findMany({ where: { organizationId: t.organizationId, id: { notIn: [t.creators.trevon, t.creators.katrina, t.brother] } }, orderBy: { displayName: 'asc' } });
    assert.deepEqual(
      created.map((p) => [p.displayName, p.entityType, p.establishmentBasis, p.establishedByUserId]),
      [
        ['Agency X', 'COMPANY', 'MANUAL', t.users.OWNER],
        ['Alex Kim', 'PERSON', 'MANUAL', t.users.OWNER],
        ['Lund Boats', 'COMPANY', 'MANUAL', t.users.OWNER],
        ['Pat Rivera', 'PERSON', 'MANUAL', t.users.OWNER],
        ['Sam Lee', 'PERSON', 'MANUAL', t.users.OWNER],
      ],
    );
    const byName = new Map(created.map((p) => [p.displayName, p.id]));

    // Contact Points: the decided classifications, basis IMPORTED, sourced to the row.
    const points = await prisma.crmContactPoint.findMany({ where: { organizationId: t.organizationId }, orderBy: { value: 'asc' } });
    assert.deepEqual(
      points.map((p) => [p.value, p.partyId === byName.get('Lund Boats') ? 'Lund Boats' : created.find((c) => c.id === p.partyId)?.displayName, p.classification, p.basis]),
      [
        ['+14155550100', 'Sam Lee', 'INDIVIDUAL', 'IMPORTED'],
        ['alex@agencyx.example.test', 'Alex Kim', 'INDIVIDUAL', 'IMPORTED'],
        ['jane.doe@lund.example.test', 'Lund Boats', 'UNATTRIBUTED', 'IMPORTED'],
        ['other@lund.example.test', 'Lund Boats', 'UNATTRIBUTED', 'IMPORTED'],
        ['pat@lund.example.test', 'Pat Rivera', 'INDIVIDUAL', 'IMPORTED'],
        ['sam@brother.example.test', 'Sam Lee', 'INDIVIDUAL', 'IMPORTED'],
        ['team@lund.example.test', 'Lund Boats', 'ROLE_INBOX', 'IMPORTED'],
      ],
    );
    const patPoint = points.find((p) => p.value === 'pat@lund.example.test')!;
    assert.deepEqual([patPoint.sourceRef, patPoint.lastHumanContactAt?.toISOString().slice(0, 10)], ['crm-outreach-import.v2:r1', '2026-08-01']);

    // Opportunities: creator x brand, the exact title, BRAND + every PRIMARY_CONTACT, no owner, no Relationship.
    const opps = await prisma.crmOpportunity.findMany({ where: { organizationId: t.organizationId }, include: { participants: true, transitions: true }, orderBy: { title: 'asc' } });
    assert.deepEqual(opps.map((o) => o.title), ['Katrina × Brother', 'Trevon Hill × Lund Boats']);
    for (const o of opps) {
      assert.deepEqual(
        [o.category, o.stage, o.ownerUserId, o.relationshipId, o.createdByUserId, o.creatorVisibleState, o.brandVisibleToCreator, o.brandLabel, o.internalNotes],
        ['OPEN', 'Imported', null, null, t.users.OWNER, null, false, null, null],
        `${o.title}: no owner, no Relationship, nothing creator-visible, no notes`,
      );
      assert.deepEqual(o.transitions.map((x) => [x.sequence, x.note, x.creatorVisible]), [[1, null, false]], 'the first transition records the lifecycle fact only');
    }
    const lund = opps.find((o) => o.title.endsWith('Lund Boats'))!;
    assert.equal(lund.creatorPartyId, t.creators.trevon, 'the creator is creatorPartyId, never a Participant');
    assert.deepEqual(
      lund.participants.map((p) => [p.role, created.find((c) => c.id === p.partyId)?.displayName, p.state]).sort(),
      [['BRAND', 'Lund Boats', 'ACTIVE'], ['PRIMARY_CONTACT', 'Alex Kim', 'ACTIVE'], ['PRIMARY_CONTACT', 'Pat Rivera', 'ACTIVE']],
      'Pat and the agency contact Alex are both PRIMARY_CONTACT for this Opportunity -- no AFFILIATION implied',
    );
    assert.ok(!lund.participants.some((p) => p.partyId === t.creators.trevon));

    // Privacy: audit and outbox written by the import carry no value, name, title or note.
    const audits = await prisma.auditLog.findMany({ where: { organizationId: t.organizationId }, skip: auditBefore });
    const outbox = await prisma.stateChangeOutbox.findMany({ where: { organizationId: t.organizationId } });
    const importRows = await Promise.all([prisma.crmImportRun.findMany({ where: { organizationId: t.organizationId } }), prisma.crmImportEntry.findMany({ where: { organizationId: t.organizationId } }), prisma.crmImportKey.findMany({ where: { organizationId: t.organizationId } }), prisma.crmImportApproval.findMany({ where: { organizationId: t.organizationId } })]);
    const trail = JSON.stringify([audits, outbox, importRows]);
    for (const s of [...SECRETS, 'Pat Rivera', 'Alex Kim', 'Lund Boats', 'Trevon Hill ×']) assert.ok(!trail.includes(s), `no "${s}" in audit, outbox or import provenance`);
    assert.ok(audits.some((a) => a.action === 'opportunity.created'), 'the governed create writes its audit row');
    const appliedEntries = await prisma.crmImportEntry.findMany({ where: { importRunId: applied.outcome === 'APPLIED' ? applied.runId : '' }, orderBy: { line: 'asc' } });
    assert.deepEqual(appliedEntries.filter((e) => e.appliedAt).map((e) => e.sourceRowKey).sort(), ['r1', 'r2', 'r3', 'r4', 'r5', 'r8'].sort(), 'applied rows are marked; blocked rows are not');
    assert.ok(appliedEntries.find((e) => e.sourceRowKey === 'r1')?.opportunityId === lund.id);

    // A successful APPLY consumed its approval: a second attempt is refused as already executed.
    assert.deepEqual(await service.apply(t.actor('OWNER'), { source, stageMapping: t.cfg.stageMapping, approvalId: approval.approvalId, executionTarget: 'LOCAL_TEST' }), { outcome: 'APPROVAL_ALREADY_EXECUTED' });
    assert.equal(await prisma.crmImportRun.count({ where: { approvalId: approval.approvalId } }), 1, 'exactly one APPLY run owns the approval');

    // Re-run: identical source -> nothing new; rows already imported are skipped.
    const rerun = await service.dryRun(t.actor('OWNER'), source, t.cfg.stageMapping);
    assert.ok(rerun.outcome === 'OK');
    assert.deepEqual(rerun.prepared.plan.rows.filter((r) => r.outcome === 'ALREADY_IMPORTED_UNCHANGED').map((r) => r.sourceRowKey).sort(), ['r1', 'r2', 'r3', 'r4', 'r5'].sort());
    const rerunApproval = await service.approve(t.actor('OWNER'), rerun.runId);
    assert.ok(rerunApproval.outcome === 'APPROVED');
    const reapplied = await service.apply(t.actor('ADMIN'), { source, stageMapping: t.cfg.stageMapping, approvalId: rerunApproval.approvalId, executionTarget: 'LOCAL_TEST' });
    assert.equal(reapplied.outcome, 'APPLIED');
    assert.deepEqual(await crmCounts(prisma, t.organizationId), after, 'a re-run creates nothing');

    // A LATER file with a new row on the same route and pursuit reuses the imported Company and
    // Opportunity through their import keys: never a second Lund Boats, never a second pursuit.
    const later = [...ROWS, ['r11', 'Trevon Hill', 'lund', 'Mapped', '', '', 'Robin Vale', 'TRUE', 'INDIVIDUAL', '', 'robin@lund.example.test', '', '', '']];
    const laterSource = { csvText: csv(later), sourceRef: 'local' };
    const laterRun = await service.dryRun(t.actor('OWNER'), laterSource, t.cfg.stageMapping);
    assert.ok(laterRun.outcome === 'OK');
    const r11 = laterRun.prepared.plan.rows.find((r) => r.sourceRowKey === 'r11')!;
    assert.deepEqual([r11.outcome, r11.companyAction, r11.opportunityAction], ['READY', 'IMPORTED', 'RECONCILE']);
    const laterApproval = await service.approve(t.actor('OWNER'), laterRun.runId);
    assert.ok(laterApproval.outcome === 'APPROVED');
    assert.equal((await service.apply(t.actor('OWNER'), { source: laterSource, stageMapping: t.cfg.stageMapping, approvalId: laterApproval.approvalId, executionTarget: 'LOCAL_TEST' })).outcome, 'APPLIED');
    assert.equal(await prisma.cognitiveIdentity.count({ where: { organizationId: t.organizationId, displayName: 'Lund Boats' } }), 1);
    assert.equal(await prisma.crmOpportunity.count({ where: { organizationId: t.organizationId } }), 2);
    assert.equal(await prisma.crmParticipant.count({ where: { opportunityId: lund.id, role: 'PRIMARY_CONTACT', state: 'ACTIVE' } }), 3, 'Robin joins the same pursuit as a third PRIMARY_CONTACT');

    // A changed row is never silently re-applied.
    const changed = ROWS.map((r) => (r[0] === 'r2' ? [...r.slice(0, 10), 'newteam@lund.example.test', ...r.slice(11)] : r));
    const changedRun = await service.dryRun(t.actor('OWNER'), { csvText: csv(changed), sourceRef: 'local' }, t.cfg.stageMapping);
    assert.ok(changedRun.outcome === 'OK');
    assert.equal(changedRun.prepared.plan.rows.find((r) => r.sourceRowKey === 'r2')?.outcome, 'SOURCE_ROW_CHANGED');
  } finally {
    await prisma.$disconnect();
  }
});

test('authorization: the decided act table, per role; AI_EMPLOYEE and CREATOR get nothing', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  try {
    const t = await setup(prisma, 'auth');
    const service = local(prisma);
    const source = { csvText: csv(ROWS.slice(0, 2)), sourceRef: 'local' };
    for (const role of ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE'] as const) {
      assert.equal((await service.dryRun(t.actor(role), source, t.cfg.stageMapping)).outcome, 'OK', `${role} may dry-run`);
    }
    await prisma.permission.create({ data: { organizationId: t.organizationId, userId: t.users.AI_EMPLOYEE, resource: 'crmImports', action: 'view', effect: 'ALLOW' } });
    for (const role of ['READ_ONLY', 'AI_EMPLOYEE', 'CREATOR'] as const) {
      assert.deepEqual(await service.dryRun(t.actor(role), source, t.cfg.stageMapping), { outcome: 'NOT_AUTHORIZED' }, role);
    }
    // The coarse gate holds on its own: a DENY row refuses a role the act table allows.
    await prisma.permission.create({ data: { organizationId: t.organizationId, userId: t.users.MANAGER, resource: 'crmImports', action: 'view', effect: 'DENY' } });
    assert.deepEqual(await service.dryRun(t.actor('MANAGER'), source, t.cfg.stageMapping), { outcome: 'NOT_AUTHORIZED' }, 'a DENY on crmImports:view');
    const configs = new CrmImportConfigService(prisma);
    for (const role of ['MANAGER', 'EMPLOYEE', 'READ_ONLY', 'AI_EMPLOYEE', 'CREATOR'] as const) {
      assert.deepEqual(await configs.record(t.actor(role), t.cfg), { outcome: 'NOT_AUTHORIZED' }, `${role} may not change mappings`);
    }
    const dry = await service.dryRun(t.actor('EMPLOYEE'), source, t.cfg.stageMapping);
    assert.ok(dry.outcome === 'OK');
    for (const role of ['MANAGER', 'EMPLOYEE', 'AI_EMPLOYEE', 'CREATOR'] as const) assert.deepEqual(await service.approve(t.actor(role), dry.runId), { outcome: 'NOT_AUTHORIZED' }, role);
    const approval = await service.approve(t.actor('ADMIN'), dry.runId);
    assert.ok(approval.outcome === 'APPROVED');
    for (const role of ['MANAGER', 'EMPLOYEE', 'READ_ONLY'] as const) {
      assert.deepEqual(await service.apply(t.actor(role), { source, stageMapping: t.cfg.stageMapping, approvalId: approval.approvalId, executionTarget: 'LOCAL_TEST' }), { outcome: 'NOT_AUTHORIZED' }, role);
    }
  } finally {
    await prisma.$disconnect();
  }
});

test('the production path is refused; the default guard refuses a non-local database; a mismatch is refused', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  try {
    const t = await setup(prisma, 'gates');
    const source = { csvText: csv(ROWS.slice(0, 2)), sourceRef: 'local' };
    const service = local(prisma);
    const dry = await service.dryRun(t.actor('OWNER'), source, t.cfg.stageMapping);
    assert.ok(dry.outcome === 'OK');
    const approval = await service.approve(t.actor('OWNER'), dry.runId);
    assert.ok(approval.outcome === 'APPROVED');
    const input = { source, stageMapping: t.cfg.stageMapping, approvalId: approval.approvalId, executionTarget: 'LOCAL_TEST' as const };

    assert.deepEqual(await service.apply(t.actor('OWNER'), { ...input, executionTarget: 'PRODUCTION' }), { outcome: 'PRODUCTION_APPLY_NOT_COMMISSIONED' });
    assert.deepEqual(await new CrmImportService(prisma, { applyTargetGuard: () => false }).apply(t.actor('OWNER'), input), { outcome: 'TARGET_REFUSED' });
    const saved = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgresql://user:pw@prod-db.example.neon.tech/loop';
    try {
      assert.deepEqual(await new CrmImportService(prisma).apply(t.actor('OWNER'), input), { outcome: 'TARGET_REFUSED' }, 'the default guard reads the host');
    } finally {
      if (saved === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = saved;
    }

    assert.deepEqual(await service.apply(t.actor('OWNER'), { ...input, source: { ...source, csvText: source.csvText + 'r99,Katrina,brother,Mapped,,,,,,,,,,\n' } }), { outcome: 'APPROVAL_MISMATCH', mismatched: ['SOURCE', 'PLAN'] });
    assert.deepEqual(await service.apply(t.actor('OWNER'), { ...input, stageMapping: [{ sourceStatus: 'Mapped', action: 'OPPORTUNITY', category: 'OPEN', stage: 'Other' }] }), { outcome: 'APPROVAL_MISMATCH', mismatched: ['CONFIGURATION', 'PLAN'] });
    assert.deepEqual(await service.apply(t.actor('OWNER'), { ...input, approvalId: 'no-such-approval' }), { outcome: 'APPROVAL_NOT_FOUND' });
    assert.deepEqual(await crmCounts(prisma, t.organizationId).then((c) => [c.opportunities, c.contactPoints]), [0, 0], 'nothing written by any refusal');
  } finally {
    await prisma.$disconnect();
  }
});

test('the stage gate: with no reviewed stage mapping, an approved APPLY writes nothing', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  try {
    const t = await setup(prisma, 'stage');
    const service = local(prisma);
    const source = { csvText: csv(ROWS), sourceRef: 'local' };
    const before = await crmCounts(prisma, t.organizationId);
    const dry = await service.dryRun(t.actor('OWNER'), source, []);
    assert.ok(dry.outcome === 'OK');
    assert.equal(dry.prepared.counts['outcome.STAGE_MAPPING_REQUIRED'], 7, 'r1-r5, r8 and r9: every row that reaches the status check');
    const approval = await service.approve(t.actor('OWNER'), dry.runId);
    assert.ok(approval.outcome === 'APPROVED');
    assert.equal((await service.apply(t.actor('OWNER'), { source, stageMapping: [], approvalId: approval.approvalId, executionTarget: 'LOCAL_TEST' })).outcome, 'APPLIED');
    assert.deepEqual(await crmCounts(prisma, t.organizationId), before, 'every row is blocked, so nothing is created');
    assert.deepEqual(
      await service.apply(t.actor('OWNER'), { source, stageMapping: [], approvalId: approval.approvalId, executionTarget: 'LOCAL_TEST' }),
      { outcome: 'APPROVAL_ALREADY_EXECUTED' },
      'an approval is executed once, even when the plan is unchanged',
    );
  } finally {
    await prisma.$disconnect();
  }
});

test('reviewed mappings: governed, append-only, and never across tenants', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  try {
    const t = await setup(prisma, 'mappings');
    const other = await tenant(prisma, 'mappings_other');
    const foreignCreator = await other.party('PERSON', 'Foreign Creator');
    const foreignBrand = await other.party('COMPANY', 'Foreign Brand');
    const configs = new CrmImportConfigService(prisma);

    assert.deepEqual((await configs.record(t.actor('OWNER'), t.cfg)).outcome, 'RECORDED', 'recording the same file again changes nothing');
    const items = (await configs.record(t.actor('OWNER'), t.cfg)) as { items: { outcome: string }[] };
    assert.ok(items.items.every((i) => i.outcome === 'UNCHANGED'));

    const crossTenant = await configs.record(t.actor('OWNER'), {
      ...t.cfg,
      creatorAliases: [{ alias: 'Foreign', creatorPartyId: foreignCreator }],
      routes: [{ routeKey: 'foreign', classification: 'BRAND_COMPANY', targetCompanyPartyId: foreignBrand }],
    });
    assert.equal(crossTenant.outcome, 'REFUSED');
    assert.deepEqual(
      'items' in crossTenant ? crossTenant.items.map((i) => [i.kind, i.outcome, i.reason]) : null,
      [['CREATOR_ALIAS', 'PARTY_REFUSED', 'NOT_FOUND'], ['ROUTE', 'PARTY_REFUSED', 'NOT_FOUND']],
      'another tenant\'s Party is simply not found',
    );
    const wrongType = await configs.record(t.actor('OWNER'), { ...t.cfg, creatorAliases: [{ alias: 'Brother', creatorPartyId: t.brother }], routes: [] });
    assert.equal('items' in wrongType && wrongType.items[0]?.reason, 'WRONG_PARTY_TYPE', 'a creator alias must name a PERSON');

    const remap = { ...t.cfg, creatorAliases: [{ alias: 'Trevon Hill', creatorPartyId: t.creators.katrina }], routes: [] };
    const refused = await configs.record(t.actor('OWNER'), remap);
    assert.deepEqual('items' in refused ? refused.items.map((i) => i.outcome) : null, ['CHANGE_REQUIRES_REPLACE']);
    assert.equal((await configs.record(t.actor('OWNER'), remap, { replace: true })).outcome, 'RECORDED');
    const history = await prisma.crmImportCreatorAlias.findMany({ where: { organizationId: t.organizationId, aliasKey: 'trevon hill' }, orderBy: { createdAt: 'asc' } });
    assert.deepEqual(history.map((h) => [h.state, h.creatorPartyId]), [['RETIRED', t.creators.trevon], ['ACTIVE', t.creators.katrina]], 'append-only: the old mapping is retired, not edited');
    assert.equal(history[0]!.replacedById, history[1]!.id);

    // Another tenant's import sees none of these mappings.
    const otherCreator = await other.party('PERSON', 'Other Trevon');
    void otherCreator;
    const otherDry = await local(prisma).dryRun(other.actor('OWNER'), { csvText: csv(ROWS.slice(0, 1)), sourceRef: 'local' }, t.cfg.stageMapping);
    assert.ok(otherDry.outcome === 'OK');
    assert.equal(otherDry.prepared.plan.rows[0]?.outcome, 'ROUTE_UNMAPPED');
  } finally {
    await prisma.$disconnect();
  }
});

test('Contact Point matching is exact and per tenant: an existing holder is reused, another tenant\'s is invisible', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  try {
    const t = await setup(prisma, 'match');
    const other = await tenant(prisma, 'match_other');
    const points = new CrmContactPointService(prisma);
    // The same address exists in ANOTHER tenant: it must not influence this one.
    const foreignPerson = await other.party('PERSON', 'Foreign Pat');
    assert.equal((await points.add(other.actor('OWNER'), { partyId: foreignPerson, kind: 'EMAIL', value: 'pat@lund.example.test', classification: 'INDIVIDUAL', basis: 'OPERATOR_RECORDED' })).outcome, 'RECORDED');
    // And Sam already exists HERE, holding his address: he is reused, not duplicated.
    const sam = await t.party('PERSON', 'Sam Lee');
    assert.equal((await points.add(t.actor('OWNER'), { partyId: sam, kind: 'EMAIL', value: 'sam@brother.example.test', classification: 'INDIVIDUAL', basis: 'OPERATOR_RECORDED' })).outcome, 'RECORDED');

    const dry = await local(prisma).dryRun(t.actor('OWNER'), { csvText: csv(ROWS.slice(0, 5)), sourceRef: 'local' }, t.cfg.stageMapping);
    assert.ok(dry.outcome === 'OK');
    const persons = Object.fromEntries(dry.prepared.plan.persons.map((p) => [p.name, [p.action, p.partyId]]));
    assert.deepEqual(persons['Pat Rivera'], ['PROPOSED', null], 'another tenant\'s holder is invisible');
    assert.deepEqual(persons['Sam Lee'], ['EXISTING_BY_CONTACT_POINT', sam], 'an exact, single, current holder here is reused');
  } finally {
    await prisma.$disconnect();
  }
});

test('a dry run under a different identifier key than the organization\'s Contact Points is refused, never planned', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  try {
    const t = await setup(prisma, 'hashkey');
    const sam = await t.party('PERSON', 'Sam Lee');
    const added = await new CrmContactPointService(prisma).add(t.actor('OWNER'), { partyId: sam, kind: 'EMAIL', value: 'sam@brother.example.test', classification: 'INDIVIDUAL', basis: 'OPERATOR_RECORDED' });
    assert.ok(added.outcome === 'RECORDED');
    const source = { csvText: csv(ROWS.slice(0, 1)), sourceRef: 'local' };
    const ok = await local(prisma).dryRun(t.actor('OWNER'), source, t.cfg.stageMapping);
    assert.ok(ok.outcome === 'OK' && /^[0-9a-f]{16}$/.test(ok.prepared.keyFingerprint), 'the same key: planned, with the key fingerprint (never the key)');
    // As if the Contact Point had been written by a runtime holding another key.
    await prisma.crmContactPoint.update({ where: { id: added.value.id }, data: { hashKeyFingerprint: '0000000000000000' } });
    const runs = await prisma.crmImportRun.count({ where: { organizationId: t.organizationId } });
    const refused = await local(prisma).dryRun(t.actor('OWNER'), source, t.cfg.stageMapping);
    assert.deepEqual(refused.outcome, 'HASH_KEY_MISMATCH');
    assert.equal('mismatchedContactPoints' in refused && refused.mismatchedContactPoints, 1);
    assert.equal(await prisma.crmImportRun.count({ where: { organizationId: t.organizationId } }), runs, 'nothing recorded for a refused plan');
  } finally {
    await prisma.$disconnect();
  }
});

test('atomicity and resumption: a failed unit leaves no half-created Company; a later approved run completes it once', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  try {
    const t = await setup(prisma, 'atomic');
    const source = { csvText: csv(ROWS.slice(0, 3)), sourceRef: 'local' };
    // A Contact Point authority that refuses one value: the Lund Boats unit must roll back WHOLE.
    class RefusingPoints extends CrmContactPointService {
      override async add(...args: Parameters<CrmContactPointService['add']>) {
        if (args[1].value === 'team@lund.example.test') return { outcome: 'INVALID' as const, violations: ['TEST_REFUSAL'] };
        return super.add(...args);
      }
    }
    const failing = local(prisma, { contactPoints: new RefusingPoints(prisma) });
    const dry = await failing.dryRun(t.actor('OWNER'), source, t.cfg.stageMapping);
    assert.ok(dry.outcome === 'OK');
    const approval = await failing.approve(t.actor('OWNER'), dry.runId);
    assert.ok(approval.outcome === 'APPROVED');
    const partial = await failing.apply(t.actor('OWNER'), { source, stageMapping: t.cfg.stageMapping, approvalId: approval.approvalId, executionTarget: 'LOCAL_TEST' });
    assert.equal(partial.outcome, 'APPLIED_WITH_FAILURES');
    assert.deepEqual('failureCodes' in partial ? partial.failureCodes : null, ['CONTACT_POINT_INVALID', 'DEPENDENCY_NOT_APPLIED']);
    assert.equal(await prisma.cognitiveIdentity.count({ where: { organizationId: t.organizationId, displayName: 'Lund Boats' } }), 0, 'the Company rolled back with its Contact Points');
    assert.equal(await prisma.crmImportKey.count({ where: { organizationId: t.organizationId, keyKind: 'COMPANY' } }), 0);
    assert.equal(await prisma.crmOpportunity.count({ where: { organizationId: t.organizationId } }), 0, 'no Opportunity without its brand');
    assert.equal(await prisma.cognitiveIdentity.count({ where: { organizationId: t.organizationId, displayName: 'Pat Rivera' } }), 1, 'the independent Person unit committed');

    // A FAILED APPLY consumed its approval too: it is never retried blindly, by anyone.
    const failedRun = await prisma.crmImportRun.findFirstOrThrow({ where: { approvalId: approval.approvalId } });
    assert.equal(failedRun.state, 'FAILED');
    for (const svc of [failing, local(prisma)]) {
      assert.deepEqual(await svc.apply(t.actor('OWNER'), { source, stageMapping: t.cfg.stageMapping, approvalId: approval.approvalId, executionTarget: 'LOCAL_TEST' }), { outcome: 'APPROVAL_ALREADY_EXECUTED' });
    }
    assert.equal(await prisma.crmImportRun.count({ where: { approvalId: approval.approvalId } }), 1);

    // Resume: a fresh dry run, human review and a NEW approval complete exactly the remaining work.
    const service = local(prisma);
    const resumeDry = await service.dryRun(t.actor('OWNER'), source, t.cfg.stageMapping);
    assert.ok(resumeDry.outcome === 'OK');
    assert.equal(resumeDry.prepared.plan.persons[0]?.action, 'IMPORTED', 'the committed Person is found by its import key');
    const resumeApproval = await service.approve(t.actor('OWNER'), resumeDry.runId);
    assert.ok(resumeApproval.outcome === 'APPROVED');
    assert.equal((await service.apply(t.actor('OWNER'), { source, stageMapping: t.cfg.stageMapping, approvalId: resumeApproval.approvalId, executionTarget: 'LOCAL_TEST' })).outcome, 'APPLIED');
    assert.equal(await prisma.cognitiveIdentity.count({ where: { organizationId: t.organizationId, displayName: 'Lund Boats' } }), 1);
    assert.equal(await prisma.cognitiveIdentity.count({ where: { organizationId: t.organizationId, displayName: 'Pat Rivera' } }), 1, 'never a second Pat');
    assert.equal(await prisma.crmOpportunity.count({ where: { organizationId: t.organizationId } }), 1);
    assert.equal(await prisma.crmContactPoint.count({ where: { organizationId: t.organizationId } }), 3);
  } finally {
    await prisma.$disconnect();
  }
});

test('concurrency: one APPLY at a time per organization; a contested import key admits exactly one subject', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  try {
    const t = await setup(prisma, 'race');
    const service = local(prisma);
    const source = { csvText: csv(ROWS.slice(0, 5)), sourceRef: 'local' };
    const dry = await service.dryRun(t.actor('OWNER'), source, t.cfg.stageMapping);
    assert.ok(dry.outcome === 'OK');
    const approval = await service.approve(t.actor('OWNER'), dry.runId);
    assert.ok(approval.outcome === 'APPROVED');
    const input = { source, stageMapping: t.cfg.stageMapping, approvalId: approval.approvalId, executionTarget: 'LOCAL_TEST' as const };
    const results = await Promise.all([service.apply(t.actor('OWNER'), input), local(prisma).apply(t.actor('ADMIN'), input), local(prisma).apply(t.actor('OWNER'), input)]);
    assert.equal(results.filter((r) => r.outcome === 'APPLIED').length, 1, JSON.stringify(results.map((r) => r.outcome)));
    // Every loser is told precisely why: the approval was claimed -- never a generic "in progress".
    assert.deepEqual(results.filter((x) => x.outcome !== 'APPLIED').map((r) => r.outcome), ['APPROVAL_ALREADY_EXECUTED', 'APPROVAL_ALREADY_EXECUTED']);
    assert.equal(await prisma.crmImportRun.count({ where: { approvalId: approval.approvalId } }), 1, 'exactly one APPLY run owns the approval');
    assert.equal(await prisma.crmOpportunity.count({ where: { organizationId: t.organizationId } }), 2);
    assert.equal(await prisma.cognitiveIdentity.count({ where: { organizationId: t.organizationId, displayName: 'Lund Boats' } }), 1);

    // A process claims approval B and dies: its run stays RUNNING and holds the organization's lock.
    const repo = new CrmImportRepository(prisma);
    const fresh = async () => {
      const d = await service.dryRun(t.actor('OWNER'), source, t.cfg.stageMapping);
      assert.ok(d.outcome === 'OK');
      const a = await service.approve(t.actor('OWNER'), d.runId);
      assert.ok(a.outcome === 'APPROVED');
      return a.approvalId;
    };
    const runFor = (approvalId: string) => ({ mode: 'APPLY' as const, importerVersion: 'crm-outreach-import.v2', sourceRef: 'local', sourceSha256: 'x', configFingerprint: 'y', startedByUserId: t.users.OWNER, approvalId, planDigest: null, rowCount: 0, counts: {} });
    const approvalB = await fresh();
    const stuck = await repo.createRun(t.organizationId, runFor(approvalB));

    // A different, unclaimed approval meets the lock: in progress -- and it is NOT consumed.
    const approvalC = await fresh();
    assert.deepEqual(await service.apply(t.actor('OWNER'), { ...input, approvalId: approvalC }), { outcome: 'APPLY_IN_PROGRESS' });
    assert.equal(await prisma.crmImportRun.count({ where: { approvalId: approvalC } }), 0, 'a refused attempt claims nothing');

    // Abandoning releases the lock, never the approval.
    assert.deepEqual(await service.abandon(t.actor('EMPLOYEE'), stuck.id), { outcome: 'NOT_AUTHORIZED' });
    assert.deepEqual(await service.abandon(t.actor('OWNER'), stuck.id), { outcome: 'ABANDONED' });
    assert.deepEqual(await service.abandon(t.actor('OWNER'), stuck.id), { outcome: 'NOT_RUNNING' });
    assert.deepEqual(await service.apply(t.actor('OWNER'), { ...input, approvalId: approvalB }), { outcome: 'APPROVAL_ALREADY_EXECUTED' }, 'an abandoned run keeps its approval consumed');
    assert.equal((await prisma.crmImportRun.findUniqueOrThrow({ where: { id: stuck.id } })).approvalId, approvalB);
    // Recovery is the new approval, which still matches the unchanged plan.
    assert.equal((await service.apply(t.actor('OWNER'), { ...input, approvalId: approvalC })).outcome, 'APPLIED');
    assert.equal(await prisma.crmOpportunity.count({ where: { organizationId: t.organizationId } }), 2, 'and it created nothing twice');

    // THE DATABASE ITSELF: with the lock free, a second run still cannot claim a consumed approval;
    // nothing can claim an approval, approve a dry run, or key a subject to a run that does not exist.
    await assert.rejects(repo.createRun(t.organizationId, runFor(approvalB)), /Unique constraint failed on the fields: \(`approvalId`\)/);
    await assert.rejects(repo.createRun(t.organizationId, runFor('no-such-approval')), /Foreign key constraint/);
    await assert.rejects(repo.createApproval(t.organizationId, { dryRunId: 'no-such-run', sourceSha256: 'x', importerVersion: 'v', configFingerprint: 'y', planDigest: 'z', approvedByUserId: t.users.OWNER }), /Foreign key constraint/);
    await assert.rejects(prisma.$transaction((tx) => repo.claimKey(t.organizationId, { keyKind: 'COMPANY', keyValue: 'route:ghost', subjectId: 'p', importRunId: 'no-such-run' }, tx)), /Foreign key constraint/);
    // Provenance is never erased by a cascade from other provenance: a dry run an approval references,
    // or a run its entries reference, cannot be deleted on its own.
    const approvedDryRun = (await prisma.crmImportApproval.findUniqueOrThrow({ where: { id: approvalB } })).dryRunId;
    await assert.rejects(prisma.crmImportRun.delete({ where: { id: approvedDryRun } }), /Foreign key constraint/);
    const runWithEntries = await prisma.crmImportRun.findFirstOrThrow({ where: { organizationId: t.organizationId, mode: 'APPLY', state: 'SUCCEEDED' } });
    await assert.rejects(prisma.crmImportRun.delete({ where: { id: runWithEntries.id } }), /Foreign key constraint/);

    // Two transactions racing to create the same Company under one import key: exactly one survives.
    const parties = new PartyService(prisma);
    const race = await Promise.allSettled(
      [1, 2].map(() =>
        prisma.$transaction(async (tx) => {
          const created = await parties.create(t.organizationId, t.users.OWNER, { partyType: 'COMPANY', displayName: 'Raced Co' }, { tx });
          if (created.outcome !== 'RECORDED') throw new Error('create refused');
          await repo.claimKey(t.organizationId, { keyKind: 'COMPANY', keyValue: 'route:raced', subjectId: created.party.id, importRunId: stuck.id }, tx);
        }),
      ),
    );
    assert.deepEqual(race.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
    assert.equal(await prisma.cognitiveIdentity.count({ where: { organizationId: t.organizationId, displayName: 'Raced Co' } }), 1, 'the loser rolled back its Party');
  } finally {
    await prisma.$disconnect();
  }
});

test('deleting an organization still removes all its import provenance in one statement (NO ACTION, not RESTRICT)', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  try {
    const t = await setup(prisma, 'orgdelete');
    const service = local(prisma);
    const source = { csvText: csv(ROWS.slice(0, 2)), sourceRef: 'local' };
    const dry = await service.dryRun(t.actor('OWNER'), source, t.cfg.stageMapping);
    assert.ok(dry.outcome === 'OK');
    const approval = await service.approve(t.actor('OWNER'), dry.runId);
    assert.ok(approval.outcome === 'APPROVED');
    assert.equal((await service.apply(t.actor('OWNER'), { source, stageMapping: t.cfg.stageMapping, approvalId: approval.approvalId, executionTarget: 'LOCAL_TEST' })).outcome, 'APPLIED');
    assert.ok((await prisma.crmImportKey.count({ where: { organizationId: t.organizationId } })) > 0);
    await prisma.organization.delete({ where: { id: t.organizationId } });
    const left = await Promise.all([
      prisma.crmImportRun.count({ where: { organizationId: t.organizationId } }),
      prisma.crmImportApproval.count({ where: { organizationId: t.organizationId } }),
      prisma.crmImportEntry.count({ where: { organizationId: t.organizationId } }),
      prisma.crmImportKey.count({ where: { organizationId: t.organizationId } }),
    ]);
    assert.deepEqual(left, [0, 0, 0, 0]);
  } finally {
    await prisma.$disconnect();
  }
});

test('v2: rows naming no creator import their governed Company, Person and Contact Points -- and never an Opportunity', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  try {
    const t = await setup(prisma, 'nocreator');
    const service = local(prisma);
    const stageMapping: CrmImportConfig['stageMapping'] = [
      { sourceStatus: 'Mapped', action: 'OPPORTUNITY', category: 'OPEN', stage: 'Imported' },
      { sourceStatus: 'Contacts', action: 'CONTACTS_ONLY' },
    ];
    //            key   creator   route    status      route_name brand contact          ver     kind          title  email                         phone notes last
    const rows: string[][] = [
      ['g1', '', 'lund', 'Contacts', '', '', 'Robin Vale', 'TRUE', 'INDIVIDUAL', 'Buyer', 'robin@lund.example.test', '', '', ''],
      ['g2', '', 'lund', 'Contacts', '', '', '', '', 'ROLE_INBOX', '', 'press@lund.example.test', '', '', ''],
      ['g3', '', 'brother', 'Mapped', '', '', 'Ann Hale', 'TRUE', 'INDIVIDUAL', '', 'ann@brother.example.test', '', '', ''],
    ];
    const source = { csvText: csv(rows), sourceRef: 'local' };
    const before = await crmCounts(prisma, t.organizationId);
    const dry = await service.dryRun(t.actor('OWNER'), source, stageMapping);
    assert.ok(dry.outcome === 'OK');
    assert.deepEqual(Object.fromEntries(dry.prepared.plan.rows.map((r) => [r.sourceRowKey, r.outcome])), { g1: 'CONTACTS_ONLY', g2: 'CONTACTS_ONLY', g3: 'OPPORTUNITY_REQUIRES_CREATOR' });
    assert.deepEqual(await crmCounts(prisma, t.organizationId), before, 'the dry run writes no CRM row');
    const approval = await service.approve(t.actor('OWNER'), dry.runId);
    assert.ok(approval.outcome === 'APPROVED');
    assert.equal((await service.apply(t.actor('OWNER'), { source, stageMapping, approvalId: approval.approvalId, executionTarget: 'LOCAL_TEST' })).outcome, 'APPLIED');

    const after = await crmCounts(prisma, t.organizationId);
    assert.deepEqual(
      { parties: after.parties - before.parties, contactPoints: after.contactPoints - before.contactPoints, opportunities: after.opportunities, participants: after.participants, relationships: after.relationships, evidence: after.evidence - before.evidence },
      { parties: 2, contactPoints: 2, opportunities: 0, participants: 0, relationships: 0, evidence: 0 },
      'Lund Boats and Robin; Robin\'s address and the press inbox; no Opportunity, Participant, Relationship (so no AFFILIATION) or IdentityEvidence; nothing at all for the held row',
    );
    const points = await prisma.crmContactPoint.findMany({ where: { organizationId: t.organizationId }, orderBy: { value: 'asc' } });
    assert.deepEqual(points.map((p) => [p.value, p.classification, p.basis, p.sourceRef]), [
      ['press@lund.example.test', 'ROLE_INBOX', 'IMPORTED', 'crm-outreach-import.v2:g2'],
      ['robin@lund.example.test', 'INDIVIDUAL', 'IMPORTED', 'crm-outreach-import.v2:g1'],
    ]);
    assert.equal(await prisma.cognitiveIdentity.count({ where: { organizationId: t.organizationId, displayName: 'Ann Hale' } }), 0, 'the held row created nothing');
    const trail = JSON.stringify([
      await prisma.auditLog.findMany({ where: { organizationId: t.organizationId } }),
      await prisma.stateChangeOutbox.findMany({ where: { organizationId: t.organizationId } }),
      await prisma.crmImportEntry.findMany({ where: { organizationId: t.organizationId } }),
    ]);
    for (const s of ['robin@', 'press@', 'ann@', 'Buyer', 'Robin Vale']) assert.ok(!trail.includes(s), `no "${s}" in audit, outbox or provenance`);
    assert.deepEqual(
      await service.apply(t.actor('OWNER'), { source, stageMapping, approvalId: approval.approvalId, executionTarget: 'PRODUCTION' }),
      { outcome: 'PRODUCTION_APPLY_NOT_COMMISSIONED' },
      'production APPLY is still impossible',
    );
  } finally {
    await prisma.$disconnect();
  }
});
