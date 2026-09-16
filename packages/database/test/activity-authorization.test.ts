// Universal Activity grants nothing. Slice A2.
//
// This is the test that matters most in this slice. Activity composes five
// authorities; if reaching it were easier than reaching any one of them, it would be
// a way around every guard in the CRM. So the property under test is not "the
// service checks a permission" -- it is that HOLDING ACTIVITY ACCESS IS WORTH
// NOTHING BY ITSELF.
//
// WHAT THESE PROVE
//
// A SOURCE THE VIEWER CANNOT READ IS NOT QUERIED. Not filtered afterwards: not
// queried. The recording proxy proves the query never happened, so a viewer cannot
// learn that a source holds rows by timing or by anything else.
//
// NOTHING READABLE IS NOT AN EMPTY TIMELINE. A viewer with no source at all is
// refused, rather than being handed an empty page that says "there is nothing here".
//
// THE ITEM IS CHECKED AGAIN AFTER THE READ. An adapter that returns an item stating
// a requirement the viewer does not hold -- or another organization's row -- has it
// dropped. The first check trusts the adapter; this one trusts nothing.
//
// WORKSPACE AUTHORITY IS ENFORCED, NOT DESCRIBED. Sources whose surface is ADMIN-only
// stay closed to a viewer who is not in that workspace, whatever their grants say.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import type { ActivityItemV1 } from '@emgloop/shared';

import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
import { IamRepository } from '../src/repositories/iam.repository';
import { ActivityReadModelRepository } from '../src/repositories/activity-read-model.repository';
import type { ActivityAdapter, ActivitySubject } from '../src/repositories/activity-read-model.repository';
import { ActivityService } from '../src/services/activity.service';

const ORG_A = 'org_a';
const ORG_B = 'org_b';
const READS = new Set(['findFirst', 'findMany', 'findUnique', 'count']);

async function world() {
  const fake: any = makeCognitivePrisma({ also: ['interaction', 'marketplaceCall', 'conversation', 'message', 'customer', 'invitation', 'organizationMembership'] });
  const queried: string[] = [];
  const prisma = new Proxy(fake, {
    get(target, delegate: string) {
      const d = target[delegate];
      if (typeof delegate === 'string' && delegate.startsWith('$')) return d;
      if (typeof d !== 'object' || d === null) return d;
      return new Proxy(d, {
        get(inner, method: string) {
          const fn = inner[method];
          if (typeof fn !== 'function') return fn;
          return (args: unknown) => {
            if (READS.has(method)) queried.push(delegate);
            else if (delegate !== 'user' && delegate !== 'organizationMembership' && delegate !== 'permission') {
              throw new Error(`activity must not write: ${delegate}.${method}`);
            }
            return fn.call(inner, args);
          };
        },
      });
    },
  }) as PrismaClient;

  const iam = new IamRepository(prisma);
  const hire = async (role: string, org = ORG_A) => {
    const u = await iam.createUser({ organizationId: org, email: `${role.toLowerCase()}-${org}@x.io`, systemRole: role });
    await iam.activateUser(org, u.id);
    return u.id;
  };

  const at = (iso: string) => new Date(iso);
  const seed = async () => {
    await fake.interaction.create({
      data: {
        id: 'int_1', organizationId: ORG_A, customerId: 'cust_1', conversationId: null, channel: 'PHONE', kind: 'PHONE_CALL',
        direction: 'INBOUND', occurredAt: at('2026-09-10T10:00:00.000Z'), createdAt: at('2026-09-10T10:00:00.000Z'),
        summary: null, provider: 'callgrid', externalId: 'e1', payload: {}, metadata: { callerId: '+15551234567' },
      },
    });
    await fake.marketplaceCall.create({
      data: {
        id: 'mc_1', organizationId: ORG_A, provider: 'callgrid', externalId: 'cg1', interactionId: null,
        sourceOccurredAt: at('2026-09-10T09:00:00.000Z'), createdAt: at('2026-09-10T09:00:00.000Z'),
        status: 'CONNECTED', rawStatus: null, buyerExternalId: null, vendorExternalId: null, sourceExternalId: null,
        campaignExternalId: null, destinationExternalId: null,
      },
    });
    await fake.auditLog.create({
      data: {
        id: 'aud_1', organizationId: ORG_A, userId: null, actorType: 'SYSTEM', action: 'customer.updated',
        entityType: 'customer', entityId: 'cust_1', metadata: {}, createdAt: at('2026-09-10T11:00:00.000Z'),
      },
    });
    await fake.operationalObservation.create({
      data: {
        id: 'obs_1', organizationId: ORG_A, priorityId: 'case_1', observationType: 'SITUATION_DETECTED',
        detectionKey: 'yesterday:2026-09-09', occurredAt: at('2026-09-09T00:00:00.000Z'), recordedAt: at('2026-09-10T08:00:00.000Z'),
        sequence: 1, actorType: 'SYSTEM', actorUserId: null, source: 'callgrid-intelligence', note: null, reason: null,
        previousState: null, newState: 'REVIEW', outcome: null, assignedToUserId: null,
      },
    });
  };

  return { fake, prisma, iam, hire, seed, queried, service: new ActivityService(prisma), at };
}

const ORGANIZATION: ActivitySubject = { kind: 'ORGANIZATION' };
const INTAKE: ActivitySubject = { kind: 'INTAKE_RECORD', customerId: 'cust_1' };
const CASE: ActivitySubject = { kind: 'CASE', priorityId: 'case_1' };

// --- 1. A source the viewer cannot read is never read ---------------------------------

test('READ_ONLY reaches the Intake timeline but not the audit rows behind it', async () => {
  const w = await world();
  await w.seed();
  // READ_ONLY holds customers:view. It does NOT hold audit:view -- and Loop Home
  // reads audit rows today without asking for it, which is the defect this adapter
  // refuses to inherit.
  const viewer = await w.hire('READ_ONLY');
  assert.deepEqual(await w.iam.canEach(ORG_A, viewer, [{ resource: 'customers', action: 'view' }, { resource: 'audit', action: 'view' }]), [true, false]);

  w.queried.length = 0;
  const result = await w.service.read({ organizationId: ORG_A, userId: viewer }, INTAKE);
  assert.equal(result.outcome, 'OK');
  const page = result.outcome === 'OK' ? result.value : null;
  assert.deepEqual(page!.items.map((i) => i.key), ['interaction:int_1']);
  assert.equal(page!.items.some((i) => i.category === 'AUDIT'), false);
  assert.equal(w.queried.includes('auditLog'), false, 'the audit table was not read at all');
  assert.equal(page!.sources.find((s) => s.domain === 'audit')!.skipped, 'NOT_AUTHORIZED');
});

test('a viewer with no readable source is refused, not handed an empty timeline', async () => {
  const w = await world();
  await w.seed();
  const viewer = await w.hire('READ_ONLY');
  // Deny the one grant that opens the Intake lane. Nothing else supports it.
  await w.fake.permission.create({ data: { id: 'p1', organizationId: ORG_A, userId: viewer, resource: 'customers', action: 'view', effect: 'DENY' } });

  w.queried.length = 0;
  const result = await w.service.read({ organizationId: ORG_A, userId: viewer }, INTAKE);
  assert.equal(result.outcome, 'NOT_AUTHORIZED', 'a refusal, so nothing is learned about what exists');
  assert.equal(w.queried.includes('interaction'), false);
  assert.equal(w.queried.includes('auditLog'), false);
});

test('the organization feed needs every grant that shows those rows today', async () => {
  const w = await world();
  await w.seed();
  const readOnly = await w.hire('READ_ONLY');
  // READ_ONLY holds both customers:view and intelligence:view, so it reads the feed.
  const both = await w.service.read({ organizationId: ORG_A, userId: readOnly, workspaceRole: 'ADMIN' }, ORGANIZATION);
  assert.equal(both.outcome, 'OK');
  assert.ok((both.outcome === 'OK' ? both.value.items : []).some((i) => i.key === 'interaction:int_1'));

  // Take away the intelligence grant and the channel lane closes, because an
  // unattached fact is only ever visible on the live feed.
  const narrowed = await w.hire('EMPLOYEE');
  await w.fake.permission.create({ data: { id: 'p2', organizationId: ORG_A, userId: narrowed, resource: 'intelligence', action: 'view', effect: 'DENY' } });
  w.queried.length = 0;
  const result = await w.service.read({ organizationId: ORG_A, userId: narrowed }, ORGANIZATION);
  assert.equal(result.outcome, 'NOT_AUTHORIZED');
  assert.equal(w.queried.includes('interaction'), false, 'the channel lane was not read');
  assert.equal(w.queried.includes('marketplaceCall'), false);
});

test('an ADMIN-workspace source stays closed to a viewer who is not in that workspace', async () => {
  const w = await world();
  await w.seed();
  const owner = await w.hire('OWNER');

  w.queried.length = 0;
  const outside = await w.service.read({ organizationId: ORG_A, userId: owner, workspaceRole: 'EMPLOYEE' }, CASE);
  assert.equal(outside.outcome, 'NOT_AUTHORIZED', 'the Case log is an ADMIN surface');
  assert.equal(w.queried.includes('operationalObservation'), false);

  const inside = await w.service.read({ organizationId: ORG_A, userId: owner, workspaceRole: 'ADMIN' }, CASE);
  assert.equal(inside.outcome, 'OK');
  assert.deepEqual((inside.outcome === 'OK' ? inside.value.items : []).map((i) => i.key), ['operational-observation:obs_1:1']);

  // A caller that names no workspace role holds none.
  const unnamed = await w.service.read({ organizationId: ORG_A, userId: owner }, CASE);
  assert.equal(unnamed.outcome, 'NOT_AUTHORIZED');
});

test('the marketplace lane needs the ADMIN workspace as well as the grant', async () => {
  const w = await world();
  await w.seed();
  const owner = await w.hire('OWNER');
  w.queried.length = 0;
  const crm = await w.service.read({ organizationId: ORG_A, userId: owner, workspaceRole: 'EMPLOYEE' }, ORGANIZATION);
  assert.equal(crm.outcome, 'OK');
  const keys = (crm.outcome === 'OK' ? crm.value.items : []).map((i) => i.key);
  assert.ok(keys.includes('interaction:int_1'), 'the CRM lane still reads');
  assert.equal(keys.includes('marketplace-call:mc_1'), false);
  assert.equal(w.queried.includes('marketplaceCall'), false, 'and the table was not touched');
});

// --- 2. The item is checked again, after the read --------------------------------------

/** An adapter that returns exactly what it is told to, however wrong. */
function plantedAdapter(items: ActivityItemV1[], requires: { resource: string; action: 'view' }[], workspace: string | null = null): ActivityAdapter {
  return {
    domain: 'planted',
    workspace,
    categories: ['FACT'],
    supports: () => true,
    requiresFor: () => requires as never,
    page: async () => ({ items, rowsRead: items.length, suppressed: 0, limitations: [] }),
  };
}

function plantedItem(patch: Partial<ActivityItemV1> = {}): ActivityItemV1 {
  return {
    contractVersion: 'activity.v1',
    key: 'planted:1',
    organizationId: ORG_A,
    category: 'FACT',
    type: 'PLANTED',
    authority: { domain: 'planted', recordType: 'planted', recordId: '1', sequence: null, href: null },
    time: { occurredAt: '2026-09-10T10:00:00.000Z', occurredAtBasis: 'PROVIDER_REPORTED', recordedAt: '2026-09-10T10:00:00.000Z', window: null },
    actor: { kind: 'SYSTEM', userId: null, producer: null, producerVersion: null },
    subjects: [],
    participants: [],
    identity: { state: 'NOT_APPLICABLE', basis: 'NONE' },
    provenance: { source: 'planted', transport: null, epistemic: 'RECORDED', ruleId: null, ruleVersion: null, evidenceCount: null, limitations: [] },
    display: { title: 'planted', channel: null, direction: null, stateChange: null, semanticStatus: null },
    access: { requires: [{ resource: 'customers', action: 'view' }], workspace: null },
    sensitivity: { class: 'OPERATIONAL', rawValuesInSource: false, contentInline: false },
    ...patch,
  };
}

async function serviceWith(w: Awaited<ReturnType<typeof world>>, adapter: ActivityAdapter): Promise<ActivityService> {
  return new ActivityService(w.prisma, { readModel: new ActivityReadModelRepository(w.prisma, { adapters: [adapter] }) });
}

test('an item stating a requirement the viewer does not hold is dropped after the read', async () => {
  const w = await world();
  const viewer = await w.hire('READ_ONLY');
  // The adapter DECLARES a grant the viewer holds, then returns an item demanding
  // one it does not. The first check passes; the second is what saves it.
  const item = plantedItem({ access: { requires: [{ resource: 'audit', action: 'view' }], workspace: null } });
  const service = await serviceWith(w, plantedAdapter([item], [{ resource: 'customers', action: 'view' }]));
  const result = await service.read({ organizationId: ORG_A, userId: viewer }, ORGANIZATION);
  assert.equal(result.outcome, 'OK');
  assert.deepEqual(result.outcome === 'OK' ? result.value.items : null, []);
});

test('an item from another organization is dropped even when the adapter returns it', async () => {
  const w = await world();
  const viewer = await w.hire('READ_ONLY');
  const item = plantedItem({ organizationId: ORG_B });
  const service = await serviceWith(w, plantedAdapter([item], [{ resource: 'customers', action: 'view' }]));
  const result = await service.read({ organizationId: ORG_A, userId: viewer }, ORGANIZATION);
  assert.deepEqual(result.outcome === 'OK' ? result.value.items : null, []);
});

test('an item claiming no requirement at all is dropped', async () => {
  const w = await world();
  const viewer = await w.hire('READ_ONLY');
  const item = plantedItem({ access: { requires: [], workspace: null } });
  const service = await serviceWith(w, plantedAdapter([item], [{ resource: 'customers', action: 'view' }]));
  const result = await service.read({ organizationId: ORG_A, userId: viewer }, ORGANIZATION);
  assert.deepEqual(result.outcome === 'OK' ? result.value.items : null, []);
});

test('an item demanding a workspace the viewer is not in is dropped', async () => {
  const w = await world();
  const viewer = await w.hire('OWNER');
  const item = plantedItem({ access: { requires: [{ resource: 'customers', action: 'view' }], workspace: 'ADMIN' } });
  const service = await serviceWith(w, plantedAdapter([item], [{ resource: 'customers', action: 'view' }]));
  const outside = await service.read({ organizationId: ORG_A, userId: viewer, workspaceRole: 'EMPLOYEE' }, ORGANIZATION);
  assert.deepEqual(outside.outcome === 'OK' ? outside.value.items : null, []);
});

test('a requirement naming a resource the matrix does not govern is denied, not guessed', async () => {
  const w = await world();
  const viewer = await w.hire('OWNER');
  const service = await serviceWith(w, plantedAdapter([plantedItem()], [{ resource: 'activity', action: 'view' }]));
  const result = await service.read({ organizationId: ORG_A, userId: viewer }, ORGANIZATION);
  assert.equal(result.outcome, 'NOT_AUTHORIZED', 'an unknown resource is not a grant');
});

// --- 3. Tenancy and the session ---------------------------------------------------------

test('a Permission row cannot invent a resource and open a source with it', async () => {
  const w = await world();
  const viewer = await w.hire('READ_ONLY');
  // Permission rows can ADD on top of the matrix. If a requirement could name any
  // string, a row granting `activity:view` would become a master key for every
  // source at once -- exactly the shortcut this slice must not create.
  await w.fake.permission.create({ data: { id: 'p_invented', organizationId: ORG_A, userId: viewer, resource: 'activity', action: 'view', effect: 'ALLOW' } });
  const service = await serviceWith(w, plantedAdapter([plantedItem()], [{ resource: 'activity', action: 'view' }]));
  const result = await service.read({ organizationId: ORG_A, userId: viewer }, ORGANIZATION);
  assert.equal(result.outcome, 'NOT_AUTHORIZED', 'a resource the matrix does not govern is not a grant, however it was written');
});

test('a viewer reads only their own organization, whatever they name', async () => {
  const w = await world();
  await w.seed();
  const theirs = await w.hire('OWNER', ORG_B);
  const result = await w.service.read({ organizationId: ORG_B, userId: theirs, workspaceRole: 'ADMIN' }, ORGANIZATION);
  assert.equal(result.outcome, 'OK');
  assert.deepEqual(result.outcome === 'OK' ? result.value.items : null, [], 'ORG_A rows are not theirs to see');

  // And a member of one organization naming another gets nothing, because their
  // membership does not resolve there.
  const ours = await w.hire('OWNER');
  const crossed = await w.service.read({ organizationId: ORG_B, userId: ours }, ORGANIZATION);
  assert.equal(crossed.outcome, 'NOT_AUTHORIZED');
});

test('a blank organization or user is refused before anything is read', async () => {
  const w = await world();
  await w.seed();
  w.queried.length = 0;
  for (const viewer of [{ organizationId: '', userId: 'u' }, { organizationId: ORG_A, userId: '' }, { organizationId: '   ', userId: '  ' }]) {
    assert.equal((await w.service.read(viewer, ORGANIZATION)).outcome, 'NOT_AUTHORIZED');
  }
  assert.deepEqual(w.queried, [], 'nothing was read');
});

test('activity mirrors the IAM matrix exactly -- including the fallback an unlisted role gets', async () => {
  const w = await world();
  await w.seed();
  // AI_EMPLOYEE IS NOT IN THE MATRIX, and `matrixAllows` falls back to READ_ONLY for
  // any role it does not list. So AI_EMPLOYEE reads `customers` and `intelligence`
  // today -- on the customer pages, on the inbox and on the live feed -- and reads
  // them through Activity for exactly the same reason. That is the property this
  // slice must hold: Activity is neither a new grant nor a new denial. Narrowing the
  // AI principal is a platform authorization decision, and it belongs in the matrix
  // where every surface inherits it, not in one read model.
  const ai = await w.hire('AI_EMPLOYEE');
  const grants = await w.iam.canEach(ORG_A, ai, [
    { resource: 'customers', action: 'view' },
    { resource: 'intelligence', action: 'view' },
    { resource: 'commercialIntelligence', action: 'view' },
    { resource: 'audit', action: 'view' },
  ]);
  assert.deepEqual(grants, [true, true, true, false], 'the READ_ONLY fallback, unchanged by this slice');

  // The role router puts an AI_EMPLOYEE in the EMPLOYEE workspace, never ADMIN, so
  // the marketplace and Case lanes stay shut by workspace authority as well.
  const feed = await w.service.read({ organizationId: ORG_A, userId: ai, workspaceRole: 'EMPLOYEE' }, ORGANIZATION);
  assert.equal(feed.outcome, 'OK', 'exactly what the matrix already allows, and nothing more');
  const keys = (feed.outcome === 'OK' ? feed.value.items : []).map((i) => i.key);
  assert.deepEqual(keys, ['interaction:int_1'], 'the channel lane only: no audit rows, no marketplace rows');
  assert.equal((await w.service.read({ organizationId: ORG_A, userId: ai, workspaceRole: 'EMPLOYEE' }, CASE)).outcome, 'NOT_AUTHORIZED');

  // The identity authority is the one place AI_EMPLOYEE is hard-denied, and this
  // read model never touches it.
  assert.deepEqual(await w.iam.canEach(ORG_A, ai, [{ resource: 'identityResolution', action: 'view' }]), [false]);
});

test('a disabled member reads nothing, however their old role read', async () => {
  const w = await world();
  await w.seed();
  const viewer = await w.hire('OWNER');
  await w.iam.disableUser(ORG_A, viewer);
  w.queried.length = 0;
  for (const subject of [ORGANIZATION, INTAKE, CASE]) {
    assert.equal((await w.service.read({ organizationId: ORG_A, userId: viewer, workspaceRole: 'ADMIN' }, subject)).outcome, 'NOT_AUTHORIZED', subject.kind);
  }
  assert.equal(w.queried.some((d) => ['interaction', 'auditLog', 'operationalObservation', 'marketplaceCall'].includes(d)), false);
});

test('a bad cursor is a bad request, not a server error and not an empty page', async () => {
  const w = await world();
  await w.seed();
  const viewer = await w.hire('READ_ONLY');
  const result = await w.service.read({ organizationId: ORG_A, userId: viewer }, INTAKE, { cursor: 'nonsense' });
  assert.equal(result.outcome, 'INVALID_CURSOR');
});
