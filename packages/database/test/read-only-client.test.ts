// The read-only client: a wrapped model offers only its read methods, and nothing else runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
import { readOnlyClient, ReadOnlyViolation, READ_ONLY_METHODS } from '../src/repositories/read-only-client';

test('reads pass through unchanged', async () => {
  const fake: any = makeCognitivePrisma();
  await fake.workDraft.create({ data: { organizationId: 'org_a', userId: 'u1', provider: 'GOOGLE', threadId: 't', inReplyToMessageId: 'm', mode: 'REPLY', body: 'b' } });
  const db = readOnlyClient(fake as PrismaClient);
  assert.equal(await db.workDraft.count({ where: { organizationId: 'org_a' } }), 1);
  assert.equal((await db.workDraft.findMany({ where: { organizationId: 'org_a' } })).length, 1);
  assert.ok(await db.workDraft.findFirst({ where: { organizationId: 'org_a' } }));
});

test('every write, raw query and transaction is refused before anything runs', async () => {
  const fake: any = makeCognitivePrisma();
  fake.$executeRaw = async () => 1;
  fake.$queryRaw = async () => [];
  fake.$executeRawUnsafe = async () => 1;
  fake.$queryRawUnsafe = async () => [];
  const db: any = readOnlyClient(fake as PrismaClient);
  for (const method of ['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany']) {
    assert.throws(() => db.operationalPriority[method], ReadOnlyViolation, `${method} is refused`);
  }
  for (const member of ['$transaction', '$executeRaw', '$queryRaw', '$executeRawUnsafe', '$queryRawUnsafe', '$use', '$extends', '$disconnect', '$connect']) {
    assert.throws(() => db[member], ReadOnlyViolation, `${member} is refused`);
  }
  assert.throws(() => {
    db.operationalPriority = {};
  }, ReadOnlyViolation);
  assert.equal(fake.operationalPriority.__rows.length, 0, 'nothing was written');
});

test('the allowed set is reads only', () => {
  for (const method of READ_ONLY_METHODS) assert.match(method, /^(find|count|aggregate|groupBy)/);
});
