// A LARGE reviewed configuration records atomically (CRM slice 5, 2026-10-08). OPT-IN AND LOCAL ONLY:
// LOOP_TEST_POSTGRES_URL.
//
// The first production config (719 route mappings) failed `record-config` with a
// PrismaClientKnownRequestError and rolled back whole: the recording is one interactive transaction of
// ~1,440 sequential statements, and Prisma 5.22's default 5 s window expired part-way. Proves:
//   - the failure shape: a Prisma 5.22 interactive transaction past its default 5 s window is refused
//     with P2028 (a PrismaClientKnownRequestError), as observed;
//   - 719 distinct routes record in ONE call: RECORDED, every mapping active, one audit row per write;
//   - the same under production-like latency (the whole recording well past 5 s): still RECORDED;
//   - atomicity holds: a failure part-way leaves no mapping and no audit row;
//   - a small configuration behaves exactly as before (RECORDED, then UNCHANGED).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { CRM_IMPORT_CONFIG_VERSION, type CrmImportConfig, type CrmImportRouteConfig } from '@emgloop/shared';

import { CrmImportConfigService, CRM_IMPORT_CONFIG_TRANSACTION_TIMEOUT_MS, CRM_IMPORT_CONFIG_TRANSACTION_MAX_WAIT_MS } from '../src/crm-import/crm-import-config.service';
import { AuditRepository } from '../src/repositories/audit.repository';

const LOCAL = (url: string) => /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url);
const URL = process.env.LOOP_TEST_POSTGRES_URL ?? '';
const skip = !URL ? 'LOOP_TEST_POSTGRES_URL is not set' : !LOCAL(URL) ? 'refusing a non-local database' : false;

const ROUTES = 719;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function owner(prisma: PrismaClient, label: string) {
  const organizationId = `0cfg_${label}_${randomUUID()}`;
  await prisma.organization.create({ data: { id: organizationId, name: `CFG ${label}`, slug: organizationId } });
  const userId = `user_cfg_owner_${randomUUID()}`;
  await prisma.user.create({ data: { id: userId, organizationId, email: `${userId}@example.test`, name: 'Owner person', status: 'ACTIVE', metadata: { systemRole: 'OWNER' } } });
  await prisma.organizationMembership.create({ data: { organizationId, userId, systemRole: 'OWNER', status: 'ACTIVE', effectiveFrom: new Date('2026-01-01T00:00:00Z') } });
  return { organizationId, userId };
}

/** 719 distinct, valid routes of every Party-free shape: proposed brands, agencies speaking for them, and the inert kinds. */
function largeConfig(n = ROUTES): CrmImportConfig {
  const routes: CrmImportRouteConfig[] = [];
  for (let i = 0; i < n; i += 1) {
    const key = `route-${i.toString().padStart(4, '0')}`;
    switch (i % 5) {
      case 0:
        routes.push({ routeKey: key, classification: 'BRAND_COMPANY', proposedCompanyName: `Brand ${i}` });
        break;
      case 1:
        routes.push({ routeKey: key, classification: 'AGENCY', proposedCompanyName: `Agency ${i}`, representedBrandRouteKey: `route-${(i - 1).toString().padStart(4, '0')}` });
        break;
      case 2:
        routes.push({ routeKey: key, classification: 'PERSONAL_GENERIC' });
        break;
      case 3:
        routes.push({ routeKey: key, classification: 'INTERNAL' });
        break;
      default:
        routes.push({ routeKey: key, classification: 'UNKNOWN' });
    }
  }
  return { version: CRM_IMPORT_CONFIG_VERSION, creatorAliases: [], routes, stageMapping: [] };
}

const counts = async (prisma: PrismaClient, organizationId: string) => ({
  mappings: await prisma.crmImportRouteMapping.count({ where: { organizationId, state: 'ACTIVE' } }),
  audits: await prisma.auditLog.count({ where: { organizationId, action: 'crm_import.route_mapping_recorded' } }),
});

test('the failure shape: a Prisma 5.22 interactive transaction past its default 5 s window is P2028, a PrismaClientKnownRequestError', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  try {
    await assert.rejects(
      prisma.$transaction(async (tx) => {
        await sleep(5_500);
        await tx.organization.count();
      }),
      (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2028',
    );
    assert.deepEqual([CRM_IMPORT_CONFIG_TRANSACTION_TIMEOUT_MS, CRM_IMPORT_CONFIG_TRANSACTION_MAX_WAIT_MS], [120_000, 10_000]);
  } finally {
    await prisma.$disconnect();
  }
});

test('719 distinct routes record in one atomic call: RECORDED, every mapping active, one audit row per write', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  try {
    const t = await owner(prisma, 'large');
    const r = await new CrmImportConfigService(prisma).record(t, largeConfig());
    assert.equal(r.outcome, 'RECORDED');
    assert.equal('items' in r && r.items.filter((i) => i.outcome === 'RECORDED').length, ROUTES);
    assert.deepEqual(await counts(prisma, t.organizationId), { mappings: ROUTES, audits: ROUTES });
  } finally {
    await prisma.$disconnect();
  }
});

test('the same 719 routes under production-like latency -- the whole recording well past 5 s -- still RECORDED, atomically', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  try {
    const t = await owner(prisma, 'slow');
    const real = new AuditRepository(prisma);
    // ~10 ms more per audit row, as a round trip from a CI runner to a hosted database adds.
    const audit = { record: async (...args: Parameters<AuditRepository['record']>) => (await sleep(10), real.record(...args)) };
    const started = Date.now();
    const r = await new CrmImportConfigService(prisma, { audit }).record(t, largeConfig());
    const elapsed = Date.now() - started;
    assert.equal(r.outcome, 'RECORDED');
    assert.ok(elapsed > 5_000, `the recording took ${elapsed} ms: past the 5 s default that failed in production`);
    assert.deepEqual(await counts(prisma, t.organizationId), { mappings: ROUTES, audits: ROUTES });
  } finally {
    await prisma.$disconnect();
  }
});

test('atomicity holds: a failure part-way through leaves no mapping and no audit row', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  try {
    const t = await owner(prisma, 'rollback');
    const real = new AuditRepository(prisma);
    let calls = 0;
    const audit = {
      record: async (...args: Parameters<AuditRepository['record']>) => {
        calls += 1;
        if (calls === 500) throw new Error('audit write failed part-way');
        return real.record(...args);
      },
    };
    await assert.rejects(new CrmImportConfigService(prisma, { audit }).record(t, largeConfig()), /audit write failed part-way/);
    assert.equal(calls, 500, '499 mappings and audit rows were written inside the transaction before the failure');
    assert.deepEqual(await counts(prisma, t.organizationId), { mappings: 0, audits: 0 }, 'all of it rolled back');
    // And the same configuration then records whole.
    assert.equal((await new CrmImportConfigService(prisma).record(t, largeConfig())).outcome, 'RECORDED');
    assert.deepEqual(await counts(prisma, t.organizationId), { mappings: ROUTES, audits: ROUTES });
  } finally {
    await prisma.$disconnect();
  }
});

test('a small configuration behaves exactly as before: RECORDED, then UNCHANGED, with no new audit row', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  try {
    const t = await owner(prisma, 'small');
    const service = new CrmImportConfigService(prisma);
    const small = largeConfig(3);
    assert.equal((await service.record(t, small)).outcome, 'RECORDED');
    assert.deepEqual(await counts(prisma, t.organizationId), { mappings: 3, audits: 3 });
    const again = await service.record(t, small);
    assert.deepEqual([again.outcome, 'items' in again && again.items.map((i) => i.outcome)], ['RECORDED', ['UNCHANGED', 'UNCHANGED', 'UNCHANGED']]);
    assert.deepEqual(await counts(prisma, t.organizationId), { mappings: 3, audits: 3 });
  } finally {
    await prisma.$disconnect();
  }
});
