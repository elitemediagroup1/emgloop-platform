// Performance Objectives — Commercial Intelligence Stage 1.
//
// The properties these tests exist to hold, in order of how badly they would
// hurt if they broke:
//
//   1. TENANCY. No path — read, list, update, archive, or naming a user —
//      crosses an organization boundary, and a cross-organization id is
//      NOT-FOUND rather than forbidden.
//   2. NO WRITE, NO AUDIT. A scoped resolve that misses returns null and
//      performs no write, so the caller has nothing to record.
//   3. SCOPE INVARIANTS. A USER-scoped objective names a real member of the
//      SAME organization; an ORGANIZATION-scoped one names nobody.
//
// They run entirely on the in-memory Prisma double — no database. The double
// enforces the org-scoped uniques the way Postgres does, so tenant isolation is
// proven rather than assumed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
import { PerformanceObjectiveRepository } from '../src/repositories/performance-objective.repository';

const ORG = 'org-alpha';
const OTHER_ORG = 'org-beta';

// A fixed clock. Every date is passed in explicitly rather than defaulted to the
// real one: a suite whose ordering depends on when it runs is a flake this repo
// has already been bitten by.
const T0 = new Date('2026-08-14T12:00:00.000Z');
const day = (n: number) => new Date(T0.getTime() + n * 86_400_000);

async function make() {
  const prisma = makeCognitivePrisma();
  const repo = new PerformanceObjectiveRepository(prisma as never);
  // Two organizations with a member each, plus a removed member, so the
  // membership rule has something real to accept and reject.
  await prisma.user.create({
    data: { id: 'user-matt', organizationId: ORG, email: 'matt@alpha.test', name: 'Matt', status: 'ACTIVE', metadata: {} },
  });
  await prisma.user.create({
    data: { id: 'user-lexi', organizationId: ORG, email: 'lexi@alpha.test', name: 'Lexi', status: 'ACTIVE', metadata: {} },
  });
  await prisma.user.create({
    data: { id: 'user-gone', organizationId: ORG, email: 'gone@alpha.test', name: 'Departed', status: 'DISABLED', metadata: { removedAt: T0.toISOString() } },
  });
  await prisma.user.create({
    data: { id: 'user-beta', organizationId: OTHER_ORG, email: 'someone@beta.test', name: 'Beta Person', status: 'ACTIVE', metadata: {} },
  });
  return { prisma, repo };
}

function orgObjective(over: Record<string, unknown> = {}) {
  return {
    title: 'Grow brand-partnership revenue',
    description: 'Win more creator work with national brands.',
    scope: 'ORGANIZATION' as const,
    effectiveFrom: T0,
    createdByUserId: 'user-matt',
    ...over,
  };
}

function userObjective(over: Record<string, unknown> = {}) {
  return {
    title: 'Book twelve discovery calls this quarter',
    scope: 'USER' as const,
    scopeUserId: 'user-lexi',
    effectiveFrom: T0,
    createdByUserId: 'user-matt',
    ...over,
  };
}

// --- Creation ----------------------------------------------------------------

test('an organization-scoped objective is created and names nobody', async () => {
  const { repo } = await make();
  const result = await repo.create(ORG, orgObjective());

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.objective.scope, 'ORGANIZATION');
  assert.equal(result.objective.scopeUserId, null);
  assert.equal(result.objective.status, 'ACTIVE');
  assert.equal(result.objective.title, 'Grow brand-partnership revenue');
  // Open-ended intent. Distinct from archived, which is a decision.
  assert.equal(result.objective.effectiveTo, null);
});

test('a user-scoped objective is created against a member of the same organization', async () => {
  const { repo } = await make();
  const result = await repo.create(ORG, userObjective());

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.objective.scope, 'USER');
  assert.equal(result.objective.scopeUserId, 'user-lexi');
});

test('a user-scoped objective with no user is refused', async () => {
  const { repo } = await make();
  const result = await repo.create(ORG, userObjective({ scopeUserId: null }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'USER_SCOPE_REQUIRES_USER');
});

test('an organization-scoped objective that names a user is refused, not silently stripped', async () => {
  // A write that quietly discards part of its input is how somebody later
  // concludes the field does not work.
  const { repo } = await make();
  const result = await repo.create(ORG, orgObjective({ scopeUserId: 'user-lexi' }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'ORGANIZATION_SCOPE_FORBIDS_USER');
});

test('a blank title is refused', async () => {
  const { repo } = await make();
  const result = await repo.create(ORG, orgObjective({ title: '   ' }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'TITLE_REQUIRED');
});

test('an end date on or before the start date is refused', async () => {
  const { repo } = await make();
  const same = await repo.create(ORG, orgObjective({ effectiveFrom: T0, effectiveTo: T0 }));
  assert.equal(same.ok, false);
  if (same.ok) return;
  assert.equal(same.reason, 'EFFECTIVE_RANGE_INVALID');

  const backwards = await repo.create(ORG, orgObjective({ effectiveFrom: day(5), effectiveTo: day(1) }));
  assert.equal(backwards.ok, false);
});

test('a soft-removed member cannot be given a new objective', async () => {
  const { repo } = await make();
  const result = await repo.create(ORG, userObjective({ scopeUserId: 'user-gone' }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'USER_NOT_IN_ORGANIZATION');
});

// --- Tenancy -----------------------------------------------------------------

test('a user from another organization cannot be named on an objective', async () => {
  const { prisma, repo } = await make();
  const result = await repo.create(ORG, userObjective({ scopeUserId: 'user-beta' }));

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'USER_NOT_IN_ORGANIZATION');
  // And nothing was written.
  assert.equal(await prisma.performanceObjective.count(), 0);
});

test('an unknown user id and a foreign user id are refused identically', async () => {
  // Distinguishing them would confirm that an id belongs to somebody, somewhere.
  const { repo } = await make();
  const foreign = await repo.create(ORG, userObjective({ scopeUserId: 'user-beta' }));
  const unknown = await repo.create(ORG, userObjective({ scopeUserId: 'no-such-user' }));

  assert.equal(foreign.ok, false);
  assert.equal(unknown.ok, false);
  if (foreign.ok || unknown.ok) return;
  assert.equal(foreign.reason, unknown.reason);
});

test('another organization cannot read an objective by direct id', async () => {
  const { repo } = await make();
  const created = await repo.create(ORG, orgObjective());
  assert.equal(created.ok, true);
  if (!created.ok) return;

  assert.equal(await repo.get(OTHER_ORG, created.objective.id), null);
  assert.notEqual(await repo.get(ORG, created.objective.id), null);
});

test('another organization cannot list an objective', async () => {
  const { repo } = await make();
  await repo.create(ORG, orgObjective());

  assert.equal((await repo.list(ORG)).length, 1);
  assert.equal((await repo.list(OTHER_ORG)).length, 0);
});

test('another organization cannot update an objective, and nothing changes', async () => {
  const { repo } = await make();
  const created = await repo.create(ORG, orgObjective());
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const attempt = await repo.update(OTHER_ORG, created.objective.id, { title: 'Hijacked' });
  // null, NOT a rejection: the row does not exist as far as this tenant is
  // concerned. There is nothing for the caller to audit.
  assert.equal(attempt, null);

  const after = await repo.get(ORG, created.objective.id);
  assert.equal(after?.title, 'Grow brand-partnership revenue');
});

test('another organization cannot archive an objective, and nothing changes', async () => {
  const { repo } = await make();
  const created = await repo.create(ORG, orgObjective());
  assert.equal(created.ok, true);
  if (!created.ok) return;

  assert.equal(await repo.setStatus(OTHER_ORG, created.objective.id, 'ARCHIVED'), null);
  const after = await repo.get(ORG, created.objective.id);
  assert.equal(after?.status, 'ACTIVE');
});

test('an unknown id is not-found rather than an error', async () => {
  const { repo } = await make();
  assert.equal(await repo.get(ORG, 'no-such-objective'), null);
  assert.equal(await repo.update(ORG, 'no-such-objective', { title: 'x' }), null);
  assert.equal(await repo.setStatus(ORG, 'no-such-objective', 'ARCHIVED'), null);
});

// --- Update ------------------------------------------------------------------

test('an objective is edited within its own organization', async () => {
  const { repo } = await make();
  const created = await repo.create(ORG, orgObjective());
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const updated = await repo.update(ORG, created.objective.id, {
    title: 'Grow brand-partnership revenue in EMEA',
    effectiveTo: day(90),
  });
  assert.notEqual(updated, null);
  assert.equal(updated!.ok, true);
  if (!updated!.ok) return;
  assert.equal(updated!.objective.title, 'Grow brand-partnership revenue in EMEA');
  assert.equal(updated!.objective.effectiveTo, day(90).toISOString());
});

test('switching to organization scope clears the person rather than refusing', async () => {
  // "This belongs to the whole organization" is a complete instruction, not a
  // contradiction with the user already on the row.
  const { repo } = await make();
  const created = await repo.create(ORG, userObjective());
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const updated = await repo.update(ORG, created.objective.id, { scope: 'ORGANIZATION' });
  assert.equal(updated!.ok, true);
  if (!updated!.ok) return;
  assert.equal(updated!.objective.scope, 'ORGANIZATION');
  assert.equal(updated!.objective.scopeUserId, null);
});

test('switching to user scope without naming a person is refused', async () => {
  const { repo } = await make();
  const created = await repo.create(ORG, orgObjective());
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const updated = await repo.update(ORG, created.objective.id, { scope: 'USER' });
  assert.equal(updated!.ok, false);
  if (updated!.ok) return;
  assert.equal(updated!.reason, 'USER_SCOPE_REQUIRES_USER');
});

test('an edit cannot move an objective to another organization’s user', async () => {
  const { repo } = await make();
  const created = await repo.create(ORG, userObjective());
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const updated = await repo.update(ORG, created.objective.id, { scopeUserId: 'user-beta' });
  assert.equal(updated!.ok, false);
  if (updated!.ok) return;
  assert.equal(updated!.reason, 'USER_NOT_IN_ORGANIZATION');

  const after = await repo.get(ORG, created.objective.id);
  assert.equal(after?.scopeUserId, 'user-lexi');
});

// --- Lifecycle ---------------------------------------------------------------

test('archiving keeps the objective on record, and it can be reactivated', async () => {
  const { repo } = await make();
  const created = await repo.create(ORG, orgObjective());
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const archived = await repo.setStatus(ORG, created.objective.id, 'ARCHIVED');
  assert.equal(archived?.status, 'ARCHIVED');
  // Still there. Archiving is not deletion.
  assert.notEqual(await repo.get(ORG, created.objective.id), null);
  assert.equal((await repo.list(ORG)).length, 1);
  assert.equal((await repo.list(ORG, { status: 'ACTIVE' })).length, 0);
  assert.equal((await repo.list(ORG, { status: 'ARCHIVED' })).length, 1);

  const back = await repo.setStatus(ORG, created.objective.id, 'ACTIVE');
  assert.equal(back?.status, 'ACTIVE');
});

// --- Listing -----------------------------------------------------------------

test('listing filters by scope and by person without widening the tenant', async () => {
  const { repo } = await make();
  await repo.create(ORG, orgObjective());
  await repo.create(ORG, userObjective());
  await repo.create(ORG, userObjective({ title: 'Publish two case studies', scopeUserId: 'user-matt' }));

  assert.equal((await repo.list(ORG)).length, 3);
  assert.equal((await repo.list(ORG, { scope: 'ORGANIZATION' })).length, 1);
  assert.equal((await repo.list(ORG, { scope: 'USER' })).length, 2);
  assert.equal((await repo.list(ORG, { scopeUserId: 'user-lexi' })).length, 1);
  // The other tenant sees none of it, under every filter.
  assert.equal((await repo.list(OTHER_ORG, { scope: 'USER' })).length, 0);
  assert.equal((await repo.list(OTHER_ORG, { scopeUserId: 'user-lexi' })).length, 0);
});

// --- The MANAGER invariant ---------------------------------------------------

test('the repository exposes no method that resolves a user to people they manage', async () => {
  // `MANAGER` is an authorization level, never an organizational fact. Loop has
  // no reporting relationship, so no query here may imply one. This asserts on
  // the API surface because the cheapest way for that invariant to break is
  // somebody adding a convenient `listForManager(userId)` later.
  const surface = Object.getOwnPropertyNames(PerformanceObjectiveRepository.prototype);
  const forbidden = /manager|manages|managed|subordinate|report|team|division|department|hierarchy/i;
  const offenders = surface.filter((m) => forbidden.test(m));
  assert.deepEqual(offenders, []);

  // And the only user-related filter is an explicit id the caller already knows.
  assert.deepEqual(
    surface.sort(),
    ['constructor', 'create', 'get', 'isActiveMember', 'list', 'reject', 'setStatus', 'update'].sort(),
  );
});
