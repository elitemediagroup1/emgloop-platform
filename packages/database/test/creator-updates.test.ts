import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import { CreatorRecordService } from '../src/creator/creator-record.service';
import type { CreatorRepository } from '../src/creator/creator.repository';
import type { CrmCommercialRepository } from '../src/creator/crm-commercial.repository';
import type { WorkRepository } from '../src/repositories/work.repository';

const actor = { organizationId: 'org', creatorProfileId: 'creator', userId: 'user' };
function fixture() {
  let marked = 0;
  const calls: unknown[][] = [];
  const rows = ['Creator review', 'Creator review · round 2', 'Edit', 'Internal approval'].map((stageName, i) => ({
    id: `n${i}`, contentId: 'content', contentTitle: 'My video', stageName,
    at: new Date('2026-11-05T12:00:00Z'), readAt: null,
    body: 'PRIVATE_WORK_BODY', title: 'PRIVATE_WORK_TITLE',
  }));
  const creator = {
    notificationsForCreator: async (...args: unknown[]) => { calls.push(args); return rows; },
    markCreatorNotificationRead: async (...args: unknown[]) => { marked++; calls.push(args); return true; },
  } as unknown as CreatorRepository;
  return { service: new CreatorRecordService({} as PrismaClient, creator, {} as WorkRepository, {} as CrmCommercialRepository), calls, marked: () => marked };
}

test('creator update projection includes review rounds and discards all private notification text', async () => {
  const f = fixture();
  const updates = await f.service.updates(actor);
  assert.deepEqual(updates.map(u => u.id), ['n0', 'n1']);
  assert.equal(updates[0]?.title, 'Edit ready for review');
  assert.equal(updates[0]?.at, '2026-11-05T12:00:00.000Z');
  assert.doesNotMatch(JSON.stringify(updates), /PRIVATE_WORK|stageName|workInstance/);
  assert.deepEqual(f.calls[0], ['org', 'user', 'creator']);
});

test('only a visible creator review update can be marked read, with session scope passed to persistence', async () => {
  const f = fixture();
  assert.equal(await f.service.markUpdateRead(actor, 'unknown'), false);
  assert.equal(await f.service.markUpdateRead(actor, 'n2'), false);
  assert.equal(f.marked(), 0);
  assert.equal(await f.service.markUpdateRead(actor, 'n1'), true);
  assert.deepEqual(f.calls.at(-1), ['org', 'user', 'creator', 'n1']);
  assert.equal(f.marked(), 1);
});
