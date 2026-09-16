// Reading Universal Activity: paging and composition, pure. Slice A2.
//
// WHAT THESE PROVE
//
// ONE ORDER, AND A CURSOR THAT NAMES ONE POINT IN IT. Walking a fixed set page by
// page returns every item exactly once, in the same order a single unpaged read
// would give -- the property a feed over five authorities lives or dies by.
//
// A LIMIT IS A LIMIT. A missing, absurd or fractional page size falls back to the
// default rather than being treated as permission to read everything.
//
// THE SAME RECORD FROM TWO SOURCES IS ONE ITEM. Merging keeps the first, so a
// suppression rule stays with the authority that owns it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ACTIVITY_PAGE_LIMIT_DEFAULT,
  ACTIVITY_PAGE_LIMIT_MAX,
  activityCursorOf,
  activityItemAfterCursor,
  activityPageLimit,
  compareActivityItems,
  mergeActivityStreams,
  type ActivityItemV1,
} from '../src/index';

function item(key: string, occurredAt: string | null, recordedAt = '2026-09-01T00:00:00.000Z'): ActivityItemV1 {
  const [recordType, recordId] = key.split(':') as [string, string];
  return {
    contractVersion: 'activity.v1',
    key,
    organizationId: 'org_a',
    category: 'FACT',
    type: 'THING',
    authority: { domain: 'test', recordType, recordId, sequence: null, href: null },
    time: { occurredAt, occurredAtBasis: occurredAt ? 'PROVIDER_REPORTED' : 'UNKNOWN', recordedAt, window: null },
    actor: { kind: 'SYSTEM', userId: null, producer: null, producerVersion: null },
    subjects: [],
    participants: [],
    identity: { state: 'NOT_APPLICABLE', basis: 'NONE' },
    provenance: { source: 'test', transport: null, epistemic: 'RECORDED', ruleId: null, ruleVersion: null, evidenceCount: null, limitations: [] },
    display: { title: 'a thing', channel: null, direction: null, stateChange: null, semanticStatus: null },
    access: { requires: [{ resource: 'customers', action: 'view' }], workspace: null },
    sensitivity: { class: 'OPERATIONAL', rawValuesInSource: false, contentInline: false },
  };
}

test('a page size is bounded, and anything unusable falls back to the default', () => {
  assert.equal(activityPageLimit(25), 25);
  assert.equal(activityPageLimit(ACTIVITY_PAGE_LIMIT_MAX + 1), ACTIVITY_PAGE_LIMIT_MAX);
  assert.equal(activityPageLimit(1_000_000), ACTIVITY_PAGE_LIMIT_MAX);
  for (const bad of [null, undefined, 0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(activityPageLimit(bad as number), ACTIVITY_PAGE_LIMIT_DEFAULT, String(bad));
  }
});

test('an item is after a cursor when it is older, or level with it and lower-keyed', () => {
  const at = '2026-09-01T10:00:00.000Z';
  const cursor = activityCursorOf(item('b:2', at));
  assert.equal(activityItemAfterCursor(item('a:1', '2026-09-01T09:00:00.000Z'), cursor), true);
  assert.equal(activityItemAfterCursor(item('c:3', '2026-09-01T11:00:00.000Z'), cursor), false);
  assert.equal(activityItemAfterCursor(item('a:1', at), cursor), true, 'same instant, lower key');
  assert.equal(activityItemAfterCursor(item('c:3', at), cursor), false, 'same instant, higher key');
  assert.equal(activityItemAfterCursor(item('b:2', at), cursor), false, 'the cursor item itself is never repeated');
  assert.equal(activityItemAfterCursor(item('a:1', at), null), true, 'no cursor is the start, not the end');
  // Fails closed rather than throwing on a time nothing can parse.
  assert.equal(activityItemAfterCursor(item('a:1', 'not-a-time'), cursor), false);
});

test('an item with no occurrence sorts on when Loop recorded it', () => {
  const unknown = item('a:1', null, '2026-09-01T12:00:00.000Z');
  const known = item('b:2', '2026-09-01T11:00:00.000Z');
  assert.deepEqual([unknown, known].sort(compareActivityItems).map((i) => i.key), ['a:1', 'b:2']);
  assert.equal(activityCursorOf(unknown).instant, '2026-09-01T12:00:00.000Z');
});

test('paging a fixed set returns every item exactly once, in the unpaged order', () => {
  const instants = ['2026-09-01T10:00:00.000Z', '2026-09-01T09:00:00.000Z', '2026-09-01T10:00:00.000Z'];
  const all = [
    item('alpha:1', instants[0]!), item('beta:2', instants[1]!), item('gamma:3', instants[2]!),
    item('alpha:4', instants[0]!), item('beta:5', instants[1]!), item('gamma:6', instants[2]!),
    item('alpha:7', '2026-08-30T08:00:00.000Z'),
  ];
  const expected = [...all].sort(compareActivityItems).map((i) => i.key);

  for (const limit of [1, 2, 3, 7, 50]) {
    const walked: string[] = [];
    let cursor = null as ReturnType<typeof activityCursorOf> | null;
    for (let guard = 0; guard < 50; guard++) {
      // Every source returns only what is after the cursor, as the adapters do.
      const available = all.filter((i) => activityItemAfterCursor(i, cursor));
      const { items, hasMore } = mergeActivityStreams([available], limit);
      walked.push(...items.map((i) => i.key));
      const last = items[items.length - 1];
      if (!hasMore || !last) break;
      cursor = activityCursorOf(last);
    }
    assert.deepEqual(walked, expected, `limit ${limit}`);
    assert.equal(new Set(walked).size, walked.length, `limit ${limit}: nothing repeated`);
  }
});

test('the same record reported by two authorities becomes one item', () => {
  const a = item('call:1', '2026-09-01T10:00:00.000Z');
  const b = item('call:1', '2026-09-01T10:00:00.000Z');
  const merged = mergeActivityStreams([[a], [b]], 10);
  assert.equal(merged.items.length, 1);
  assert.equal(merged.hasMore, false);
});

test('a merge takes the limit and says whether more is waiting', () => {
  const stream = ['a:1', 'a:2', 'a:3'].map((k, i) => item(k, `2026-09-0${i + 1}T10:00:00.000Z`));
  const merged = mergeActivityStreams([stream], 2);
  assert.equal(merged.items.length, 2);
  assert.equal(merged.hasMore, true);
  assert.equal(mergeActivityStreams([[]], 2).hasMore, false);
  assert.deepEqual(mergeActivityStreams([], 2).items, []);
});

test('fence: the read contract is pure, stores nothing, and knows no contact values', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'activity-read.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(src, /Date\.now|new Date\(|Math\.random|process\.env|fetch\(|prisma/i);
  assert.doesNotMatch(src, /email|phone|displayName|confidence|score/i);
});
