// Chats Intelligence hydration discovery when the worker is deployed AHEAD of its migration. No database:
// the Prisma client reports exactly what it reports for a missing column (P2022) or table (P2021).
//
// WHAT IT PROVES: dueForChatsHydration returns [] -- nothing is due, nothing is read -- instead of
// throwing into the worker's sweep; any other database failure still throws (never swallowed).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Prisma, type PrismaClient } from '@prisma/client';

import { SourceContentAuthorizationRepository } from '../src/repositories/source-content-authorization.repository';

function failingWith(error: unknown): PrismaClient {
  return { sourceContentAuthorization: { findMany: async () => { throw error; } } } as unknown as PrismaClient;
}

test('a missing hydration column (P2022) or table (P2021) makes nothing due', async () => {
  for (const code of ['P2022', 'P2021']) {
    const err = new Prisma.PrismaClientKnownRequestError('The column does not exist in the current database.', { code, clientVersion: 'test' });
    assert.deepEqual(await new SourceContentAuthorizationRepository(failingWith(err)).dueForChatsHydration(500), [], code);
  }
});

test('any other database failure is thrown, not swallowed', async () => {
  const err = new Prisma.PrismaClientKnownRequestError('connection refused', { code: 'P1001', clientVersion: 'test' });
  await assert.rejects(new SourceContentAuthorizationRepository(failingWith(err)).dueForChatsHydration(500), (e: unknown) => (e as { code?: string }).code === 'P1001');
});
