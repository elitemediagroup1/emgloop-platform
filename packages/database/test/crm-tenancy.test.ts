// The CRM customer surface, and who is allowed to reach a row in it.
//
// WHAT THESE PROVE
//
// TENANCY IS DECIDED BY THE QUERY, NOT BY THE CALLER. Every read and write in
// this file is attempted with the wrong organization, and each one must come
// back not-found having written nothing. Before CRM Phase Zero these methods
// took a bare id and ran `update({ where: { id } })`, so isolation held only as
// long as every call site remembered a guard -- which is the exact shape of the
// three cross-tenant writes Sprint 29A found, introduced during four consecutive
// org-scoping PRs by people actively thinking about tenancy.
//
// NOT-FOUND, NEVER FORBIDDEN. A row in another tenant answers exactly as a row
// that does not exist, so none of these can be used to discover that another
// organization holds one.
//
// THE BULK PATHS RESOLVE FIRST. They select within the organization and then act
// only on what came back, so an id belonging to someone else is absent from the
// set rather than refused at the end.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeCognitivePrisma, OPTIONAL_DELEGATES } from './helpers/cognitive-prisma-fake';
import { CrmRepository } from '../src/repositories/crm.repository';
import { WorkflowsRepository } from '../src/repositories/workflows.repository';

const ORG = 'org_emg';
const OTHER_ORG = 'org_someone_else';

async function world() {
  // THE CRM DELEGATES ARE REQUESTED, NOT ASSUMED. They are off by default so
  // that another suite can keep proving the Commercial Signal subsystem never
  // touches the incumbent `Signal` model.
  const prisma = makeCognitivePrisma({ also: OPTIONAL_DELEGATES });
  const crm = new CrmRepository(prisma as never);
  const workflows = new WorkflowsRepository(prisma as never);

  const mine = await prisma.customer.create({
    data: {
      id: 'cus_mine',
      organizationId: ORG,
      firstName: 'Dana',
      lastName: 'Reed',
      email: 'dana@emg.test',
      tags: ['lead'],
      attributes: { pipelineStatus: 'New', company: 'Acme' },
    },
  });
  const theirs = await prisma.customer.create({
    data: {
      id: 'cus_theirs',
      organizationId: OTHER_ORG,
      firstName: 'Someone',
      lastName: 'Else',
      email: 'someone@other.test',
      tags: ['lead'],
      attributes: { pipelineStatus: 'New' },
    },
  });
  return { prisma, crm, workflows, mine, theirs };
}

const read = (prisma: ReturnType<typeof makeCognitivePrisma>, id: string) =>
  prisma.customer.findFirst({ where: { id } });

// --- 1. Writes ---------------------------------------------------------------------------

test('1. a pipeline move across a tenant boundary writes nothing', async () => {
  const { prisma, crm, theirs } = await world();
  const before = await read(prisma, theirs.id);

  const result = await crm.setPipelineStatus(ORG, theirs.id, 'Quoted');

  assert.equal(result, null, 'not-found, never forbidden');
  assert.deepEqual(await read(prisma, theirs.id), before, 'their row is untouched');
});

test('2. tagging, untagging and assigning across a tenant boundary write nothing', async () => {
  const { prisma, crm, theirs } = await world();
  const before = await read(prisma, theirs.id);

  assert.equal(await crm.addTag(ORG, theirs.id, 'hot'), null);
  assert.equal(await crm.removeTag(ORG, theirs.id, 'lead'), null);
  assert.equal(await crm.setAssignment(ORG, theirs.id, { humanName: 'Me' }), null);

  assert.deepEqual(await read(prisma, theirs.id), before);
});

test('3. editing customer fields across a tenant boundary writes nothing', async () => {
  const { prisma, crm, theirs } = await world();
  const before = await read(prisma, theirs.id);

  const result = await crm.updateCustomerFields(ORG, theirs.id, {
    firstName: 'Renamed',
    company: 'Taken Over',
  });

  assert.equal(result, null);
  assert.deepEqual(await read(prisma, theirs.id), before);
});

test('4. the same writes succeed inside the organization', async () => {
  // THE COUNTER-PROPERTY. A guard that refuses everything is safe and useless.
  const { prisma, crm, mine } = await world();

  assert.ok(await crm.setPipelineStatus(ORG, mine.id, 'Quoted'));
  assert.ok(await crm.addTag(ORG, mine.id, 'hot'));
  assert.ok(await crm.setAssignment(ORG, mine.id, { humanName: 'Dana' }));
  assert.ok(await crm.updateCustomerFields(ORG, mine.id, { company: 'Acme Inc' }));

  const after = await read(prisma, mine.id);
  assert.equal((after!.attributes as Record<string, unknown>).pipelineStatus, 'Quoted');
  assert.ok((after!.tags as string[]).includes('hot'));
  assert.equal((after!.attributes as Record<string, unknown>).assignedHumanName, 'Dana');
  assert.equal((after!.attributes as Record<string, unknown>).company, 'Acme Inc');
});

test('5. an unrelated attribute is preserved, not overwritten, by a scoped write', async () => {
  const { prisma, crm, mine } = await world();
  await crm.setPipelineStatus(ORG, mine.id, 'Contacted');
  const after = await read(prisma, mine.id);
  assert.equal((after!.attributes as Record<string, unknown>).company, 'Acme');
});

// --- 2. Reads ----------------------------------------------------------------------------

test('6. a customer workspace in another tenant is not found', async () => {
  const { crm, theirs, mine } = await world();
  assert.equal(await crm.getWorkspace(ORG, theirs.id), null);
  assert.ok(await crm.getWorkspace(ORG, mine.id), 'and the tenant reads its own');
  // A customer that does not exist answers identically.
  assert.equal(await crm.getWorkspace(ORG, 'cus_nope'), null);
});

// --- 3. Bulk paths -----------------------------------------------------------------------

test('7. a bulk operation cannot capture a row from another tenant', async () => {
  const { prisma, crm, mine, theirs } = await world();
  const before = await read(prisma, theirs.id);

  const n = await crm.bulkSetStatus(ORG, [mine.id, theirs.id], 'Booked');

  assert.equal(n, 1, 'only the row this organization owns');
  assert.deepEqual(await read(prisma, theirs.id), before);
  assert.equal(
    ((await read(prisma, mine.id))!.attributes as Record<string, unknown>).pipelineStatus,
    'Booked',
  );
});

// --- 4. The automation switch ------------------------------------------------------------

test('8. a workflow in another tenant cannot be switched on', async () => {
  // THE SWITCH THAT STARTS UNSUPERVISED MUTATION. Once active, a workflow
  // rewrites customer tags, pipeline status and assignment on every matching
  // event, so this is the last place that should have trusted the caller.
  const { prisma, workflows } = await world();
  const theirs = await prisma.workflow.create({
    data: {
      id: 'wf_theirs',
      organizationId: OTHER_ORG,
      name: 'Theirs',
      trigger: 'EVENT',
      triggerConfig: {},
      definition: { steps: [] },
      isActive: false,
    },
  });

  assert.equal(await workflows.setActive(ORG, theirs.id, true), null);
  assert.equal((await prisma.workflow.findFirst({ where: { id: theirs.id } }))!.isActive, false);
  assert.equal(await workflows.getWorkflow(ORG, theirs.id), null, 'and it cannot be read either');
});
