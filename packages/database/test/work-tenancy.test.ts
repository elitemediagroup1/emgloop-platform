// Reading one work item cannot reach another tenant's work.
//
// WHY THIS TEST EXISTS AT ALL. `getWorkInstance` was a `findUnique` on a primary
// key with no organization argument. Both call sites compared
// `instance.organizationId` afterwards and were correct -- which is precisely
// the shape Sprint 29A concluded cannot be sustained: the safe call and the
// unsafe call look identical at the call site, and the next caller inherits
// nothing but a convention.
//
// AND WHY NOW. Commercial Intelligence is about to read Work state on behalf of
// a Case. That read must not be the one that finally gets the convention wrong.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';

import { WorkRepository } from '../src/repositories/work.repository';

const ORG = 'org_alpha';
const OTHER = 'org_beta';

type Row = Record<string, unknown>;

/**
 * The narrowest possible double: enough to tell a scoped read from an
 * unscoped one, and deliberately no more.
 *
 * `findUnique` IGNORES EVERY KEY BUT `id`, exactly as Prisma does. That is what
 * makes this test meaningful -- a double that filtered on `organizationId`
 * inside `findUnique` would pass whether the repository was fixed or not, and
 * would have reported this defect as absent.
 */
function workInstanceTable(seed: Row[]) {
  const rows = [...seed];
  return {
    rows,
    async findUnique({ where }: { where: Row }) {
      return rows.find((r) => r.id === where.id) ?? null;
    },
    async findFirst({ where }: { where: Row }) {
      return (
        rows.find((r) => Object.entries(where).every(([k, v]) => r[k] === v)) ?? null
      );
    },
  };
}

function repo() {
  const workInstance = workInstanceTable([
    { id: 'wi_alpha', organizationId: ORG, title: 'Contact CEM', status: 'active', stages: [], comments: [] },
    { id: 'wi_beta', organizationId: OTHER, title: "Another tenant's work", status: 'active', stages: [], comments: [] },
  ]);
  const prisma = { workInstance } as unknown as PrismaClient;
  return { repo: new WorkRepository(prisma), workInstance };
}

test('1. a work item in my organization reads back', async () => {
  const { repo: r } = repo();
  const found = await r.getWorkInstance(ORG, 'wi_alpha');
  assert.equal(found?.id, 'wi_alpha');
});

test('2. another tenant\'s work item is NOT FOUND, not forbidden', async () => {
  const { repo: r } = repo();
  const found = await r.getWorkInstance(ORG, 'wi_beta');
  // Null, and indistinguishable from a deleted id. A distinguishable "forbidden"
  // would confirm the row exists, which is a disclosure about another tenant.
  assert.equal(found, null);
  const missing = await r.getWorkInstance(ORG, 'wi_does_not_exist');
  assert.equal(missing, null, 'the same answer, on purpose');
});

test('3. the scope reaches the query, not a comparison after it', async () => {
  // The defect this replaced would have loaded the row and then rejected it.
  // Asserting on the double proves the organization is part of the WHERE: the
  // unscoped `findUnique` path must not be taken at all.
  const { repo: r, workInstance } = repo();
  let unscopedCalls = 0;
  const original = workInstance.findUnique.bind(workInstance);
  workInstance.findUnique = async (args: { where: Row }) => {
    unscopedCalls += 1;
    return original(args);
  };
  await r.getWorkInstance(ORG, 'wi_beta');
  assert.equal(unscopedCalls, 0, 'no primary-key lookup that ignores the tenant');
});

test('4. the signature takes the organization FIRST, so the unsafe call will not compile', () => {
  // `getWorkInstance(id)` is now a type error rather than a working call that
  // relies on the caller remembering a guard. This assertion is about shape:
  // two parameters, organization leading, matching every other tenant-scoped
  // read in this repository (`getWorkType`, `getWorkflowTemplate`, `listMyWork`).
  assert.equal(WorkRepository.prototype.getWorkInstance.length, 2);
});
