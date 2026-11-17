import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PublishedCreatorBrandUpdate, CreatorTask } from '@emgloop/database';
import { creatorPriorities, actionableBrand } from '../src/creator/creator-priorities';
const now = new Date('2026-11-17T12:00:00Z');
const update = (patch: Partial<PublishedCreatorBrandUpdate> = {}) =>
  ({
    stage: 'AWAITING_CREATOR',
    current: true,
    evidenceAt: new Date('2026-11-16T12:00:00Z'),
    nextStep: 'Share your content preference with EMG.',
    ...patch,
  }) as PublishedCreatorBrandUpdate;
test('Home and Tasks receive the same grounded current brand priorities; stale MyMedic is not a new assignment', () => {
  const brands = [
    { id: 'current', brand: 'A brand', update: update() },
    {
      id: 'old',
      brand: 'MyMedic',
      update: update({ evidenceAt: new Date('2026-09-14T12:00:00Z') }),
    },
    { id: 'brand', brand: 'Brand turn', update: update({ stage: 'AWAITING_BRAND' }) },
    { id: 'withheld', brand: 'Earlier', update: update({ current: false }) },
  ];
  const tasks: CreatorTask[] = [
    {
      key: 'review',
      kind: 'REVIEW',
      title: 'Review video',
      detail: null,
      href: '/video',
      dueAt: '2026-11-18T12:00:00Z',
      bucket: 'NEEDS_ATTENTION',
    },
  ];
  const result = creatorPriorities(tasks, brands, now);
  assert.equal(result.length, 2);
  assert.equal(result.filter((r) => r.kind === 'PARTNERSHIP').length, 1);
  assert.match(
    result.find((r) => r.kind === 'PARTNERSHIP')!.href,
    /brand=current#creator-response/,
  );
  assert.equal(
    result.some((r) => r.title.includes('MyMedic')),
    false,
  );
  assert.equal(actionableBrand(undefined, now), false);
  assert.equal(actionableBrand(update({ evidenceAt: new Date('2027-01-01') }), now), false);
});
