// Repository test — VerifiedKnowledgeRepository (kg.v1).
//
// Runs with the built-in Node test runner (node --import tsx --test). Requires NO
// database and NO production credentials: it drives the repository against a
// small in-memory fake Prisma client that mimics the vk_* delegates used by the
// repository (create / update / findUnique / findFirst / findMany / count) plus
// $transaction and the `include: { source: true }` relation on provenance. This
// verifies tenant scoping, idempotency, and append-only versioning behaviour
// deterministically.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { VerifiedKnowledgeRepository } from '../src/repositories/verified-knowledge.repository';
import {
  CONTRACT_FIXTURE_BATCH,
  CONTRACT_FIXTURE_IDEMPOTENCY_KEY,
} from '@emgloop/shared';

// ---- Minimal in-memory Prisma fake ---------------------------------------

type Row = Record<string, any>;
let idSeq = 0;
const nextId = () => 'id_' + (++idSeq);

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      // compound unique selector, e.g. platform_property_sourceKey: {...}
      return Object.entries(v).every(([k2, v2]) => row[k2] === v2);
    }
    return row[k] === v;
  });
}

// A delegate optionally resolves relations named in an `include` via a resolver
// map keyed by relation name -> (row) => relatedRow.
function makeDelegate(resolvers: Record<string, (row: Row) => Row | null> = {}) {
  const rows: Row[] = [];
  function withIncludes(row: Row, include?: Row): Row {
    if (!include) return row;
    const out = { ...row };
    for (const [rel, on] of Object.entries(include)) {
      if (on && resolvers[rel]) out[rel] = resolvers[rel](row);
    }
    return out;
  }
  return {
    __rows: rows,
    async findUnique({ where }: { where: Row }) {
      return rows.find((r) => matches(r, where)) ?? null;
    },
    async findFirst({ where }: { where: Row }) {
      return rows.find((r) => matches(r, where ?? {})) ?? null;
    },
    async findMany({ where, include }: { where?: Row; include?: Row } = {}) {
      return rows.filter((r) => matches(r, where ?? {})).map((r) => withIncludes(r, include));
    },
    async count({ where }: { where?: Row } = {}) {
      return rows.filter((r) => matches(r, where ?? {})).length;
    },
    async create({ data }: { data: Row }) {
      const row = { id: data.id ?? nextId(), ...data };
      rows.push(row);
      return row;
    },
    async update({ where, data }: { where: Row; data: Row }) {
      const row = rows.find((r) => matches(r, where));
      if (!row) throw new Error('update: not found');
      Object.assign(row, data);
      return row;
    },
  };
}

function makeFakePrisma() {
  const delegates: Row = {};
  delegates.verifiedKnowledgeSource = makeDelegate();
  delegates.verifiedKnowledgeEntity = makeDelegate();
  delegates.verifiedKnowledgeEntityVersion = makeDelegate();
  delegates.verifiedKnowledgeClaim = makeDelegate();
  delegates.verifiedKnowledgeClaimVersion = makeDelegate();
  delegates.verifiedKnowledgeRelationship = makeDelegate();
  // Provenance resolves its `source` relation by the source's internal id.
  delegates.verifiedKnowledgeProvenance = makeDelegate({
    source: (row: Row) =>
      delegates.verifiedKnowledgeSource.__rows.find((s: Row) => s.id === row.sourceId) ?? null,
  });
  delegates.verifiedKnowledgeImportBatch = makeDelegate();
  delegates.$transaction = async (fn: (tx: Row) => Promise<unknown>) => fn(delegates);
  return delegates;
}

const SCOPE_A = { platform: 'petsinmycity', property: 'austin', organizationId: null };
const SCOPE_B = { platform: 'petsinmycity', property: 'dallas', organizationId: null };

// ---- Tests ----------------------------------------------------------------

test('import applies a batch and returns insert counts', async () => {
  const prisma = makeFakePrisma();
  const repo = new VerifiedKnowledgeRepository(prisma as any);
  const out = await repo.importBatch(SCOPE_A, CONTRACT_FIXTURE_IDEMPOTENCY_KEY, CONTRACT_FIXTURE_BATCH);
  assert.equal(out.duplicate, false);
  assert.ok(out.result.inserted >= 3, 'expected sources+entities+claims inserted');
});

test('identical retry with same key is idempotent (no duplicates)', async () => {
  const prisma = makeFakePrisma();
  const repo = new VerifiedKnowledgeRepository(prisma as any);
  const first = await repo.importBatch(SCOPE_A, CONTRACT_FIXTURE_IDEMPOTENCY_KEY, CONTRACT_FIXTURE_BATCH);
  const second = await repo.importBatch(SCOPE_A, CONTRACT_FIXTURE_IDEMPOTENCY_KEY, CONTRACT_FIXTURE_BATCH);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  const entityCount = await prisma.verifiedKnowledgeEntity.count({ where: SCOPE_A });
  assert.equal(entityCount, (CONTRACT_FIXTURE_BATCH.entities ?? []).length);
});

test('same key + different payload throws IDEMPOTENCY_CONFLICT', async () => {
  const prisma = makeFakePrisma();
  const repo = new VerifiedKnowledgeRepository(prisma as any);
  await repo.importBatch(SCOPE_A, CONTRACT_FIXTURE_IDEMPOTENCY_KEY, CONTRACT_FIXTURE_BATCH);
  const mutated = { ...CONTRACT_FIXTURE_BATCH, entities: [] };
  await assert.rejects(
    () => repo.importBatch(SCOPE_A, CONTRACT_FIXTURE_IDEMPOTENCY_KEY, mutated as any),
    (err: any) => err.code === 'IDEMPOTENCY_CONFLICT',
  );
});

test('re-import of a changed entity appends a version (append-only)', async () => {
  const prisma = makeFakePrisma();
  const repo = new VerifiedKnowledgeRepository(prisma as any);
  await repo.importBatch(SCOPE_A, 'k1', CONTRACT_FIXTURE_BATCH);
  const changed = {
    ...CONTRACT_FIXTURE_BATCH,
    entities: (CONTRACT_FIXTURE_BATCH.entities ?? []).map((e) => ({ ...e, name: (e.name ?? '') + ' (updated)' })),
  };
  await repo.importBatch(SCOPE_A, 'k2', changed as any);
  const versions = prisma.verifiedKnowledgeEntityVersion.__rows.length;
  assert.ok(versions >= 2, 'expected an appended entity version');
});

test('reads are tenant-scoped: another property cannot see scope A claims', async () => {
  const prisma = makeFakePrisma();
  const repo = new VerifiedKnowledgeRepository(prisma as any);
  await repo.importBatch(SCOPE_A, 'k1', CONTRACT_FIXTURE_BATCH);
  const subject = (CONTRACT_FIXTURE_BATCH.claims ?? [])[0].subject;
  const inA = await repo.queryClaims(SCOPE_A, subject);
  const inB = await repo.queryClaims(SCOPE_B, subject);
  assert.ok(inA.length >= 1, 'scope A sees its own claim');
  assert.equal(inB.length, 0, 'scope B sees nothing from scope A');
});

test('getEntity is tenant-scoped and returns null cross-tenant', async () => {
  const prisma = makeFakePrisma();
  const repo = new VerifiedKnowledgeRepository(prisma as any);
  await repo.importBatch(SCOPE_A, 'k1', CONTRACT_FIXTURE_BATCH);
  const id = (CONTRACT_FIXTURE_BATCH.entities ?? [])[0].id;
  const a = await repo.getEntity(SCOPE_A, id);
  const b = await repo.getEntity(SCOPE_B, id);
  assert.ok(a && a.id === id);
  assert.equal(b, null);
});

test('claims carry provenance sources', async () => {
  const prisma = makeFakePrisma();
  const repo = new VerifiedKnowledgeRepository(prisma as any);
  await repo.importBatch(SCOPE_A, 'k1', CONTRACT_FIXTURE_BATCH);
  const subject = (CONTRACT_FIXTURE_BATCH.claims ?? [])[0].subject;
  const claims = await repo.queryClaims(SCOPE_A, subject);
  assert.ok(claims[0].sources.length >= 1, 'claim resolves its linked sources');
});
