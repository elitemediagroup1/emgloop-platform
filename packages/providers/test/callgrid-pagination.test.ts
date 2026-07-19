// CallGrid response-shape and pagination contract.
//
// Pins the live failure of 2026-07-19: the reconciliation route received an
// OBJECT where it expected an array and died on `.slice is not a function`.
// The root cause was a double cast in the route, but these tests pin the
// provider boundary that the route should have been using all along.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchCallGridCallsPage,
  extractRecordsOrNull,
  describeShape,
} from '../src/adapters/callgrid-api';

const opts = (body: unknown, status = 200) => ({
  apiKey: 'test-key-not-a-real-secret',
  since: new Date('2026-07-18T00:00:00.000Z'),
  until: new Date('2026-07-19T00:00:00.000Z'),
  fetchImpl: (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch,
});

const rec = (id: string) => ({ id, revenue: '10.00' });

// --- Envelope extraction ---------------------------------------------------

test('every documented envelope shape yields its records', async () => {
  const shapes: Array<[string, unknown]> = [
    ['array', [rec('a')]],
    ['data', { data: [rec('a')] }],
    ['calls', { calls: [rec('a')] }],
    ['results', { results: [rec('a')] }],
    ['items', { items: [rec('a')] }],
    ['records', { records: [rec('a')] }],
  ];
  for (const [envelope, body] of shapes) {
    const parsed = extractRecordsOrNull(body);
    assert.ok(parsed, `${envelope} must parse`);
    assert.equal(parsed!.envelope, envelope);
    assert.equal(parsed!.records.length, 1);
  }
});

test('an EMPTY page is distinguishable from an unrecognised shape', () => {
  // This distinction is the whole point: an empty day and a shape we cannot
  // read must never look the same, or a parse failure reports "0 calls,
  // reconciled clean" against a marketplace that had traffic.
  const empty = extractRecordsOrNull({ data: [] });
  assert.ok(empty, 'an empty data array is a VALID empty page');
  assert.equal(empty!.records.length, 0);

  assert.equal(extractRecordsOrNull({ unexpected: 'shape' }), null, 'unknown envelope is null');
  assert.equal(extractRecordsOrNull({ data: 'not-an-array' }), null, 'non-array data is null');
  assert.equal(extractRecordsOrNull(null), null);
  assert.equal(extractRecordsOrNull('a string'), null);
  assert.equal(extractRecordsOrNull(42), null);
});

// --- The live failure, pinned ---------------------------------------------

test('the object returned by fetchAllCallGridCalls is NOT a records array', () => {
  // `{ events, pages, records }` was cast to an array and reached `.slice()`.
  const wrong = { events: [], pages: 1, records: 3 };
  assert.equal(Array.isArray(wrong), false);
  // `records` here is a COUNT, not the rows — the shape is doubly wrong.
  assert.equal(typeof wrong.records, 'number');
  assert.equal(extractRecordsOrNull(wrong), null, 'it is not a valid CallGrid envelope either');
});

// --- Shape diagnostics are safe -------------------------------------------

test('shape description reports keys only, never values', () => {
  const sensitive = {
    data: [{ callerId: '+12125551234', recording_url: 'https://cdn/rec/abc' }],
    apiKey: 'super-secret',
  };
  const described = describeShape(sensitive);
  assert.match(described, /object\{/);
  assert.match(described, /data/, 'top-level keys are reported');
  assert.doesNotMatch(described, /2125551234/, 'no phone number');
  assert.doesNotMatch(described, /cdn|rec\/abc/, 'no recording URL');
  assert.doesNotMatch(described, /super-secret/, 'no credential value');
});

test('describeShape handles every primitive without throwing', () => {
  assert.equal(describeShape([]), 'array');
  assert.equal(describeShape(null), 'null');
  assert.equal(describeShape(undefined), 'undefined');
  assert.equal(describeShape('x'), 'string');
  assert.equal(describeShape(1), 'number');
});

// --- Page fetching ---------------------------------------------------------

test('a valid page returns raw records', async () => {
  const page = await fetchCallGridCallsPage(opts({ data: [rec('a'), rec('b')] }) as never);
  assert.equal(page.records.length, 2);
  assert.equal(page.records[0]!.id, 'a');
});

test('an empty page is returned as empty, not as an error', async () => {
  const page = await fetchCallGridCallsPage(opts({ data: [] }) as never);
  assert.equal(page.records.length, 0);
  assert.equal(page.hasMore, false, 'an empty page never claims more');
});

test('an unrecognised shape throws with the observed keys and no values', async () => {
  await assert.rejects(
    fetchCallGridCallsPage(opts({ unexpected: 'shape', callerId: '+12125551234' }) as never),
    (err: Error) => {
      assert.match(err.message, /unrecognised response shape/i);
      assert.match(err.message, /unexpected/, 'names the observed key');
      assert.doesNotMatch(err.message, /2125551234/, 'never leaks a value');
      return true;
    },
  );
});

test('a non-array data field is rejected rather than silently emptied', async () => {
  await assert.rejects(
    fetchCallGridCallsPage(opts({ data: { nested: 'object' } }) as never),
    /unrecognised response shape/i,
  );
});

test('pagination continues only while the provider says there is more', async () => {
  const withCursor = await fetchCallGridCallsPage(
    opts({ data: [rec('a')], hasMore: true, nextCursor: 'c1' }) as never,
  );
  assert.equal(withCursor.hasMore, true);
  assert.equal(withCursor.nextCursor, 'c1');

  const last = await fetchCallGridCallsPage(opts({ data: [rec('z')], hasMore: false }) as never);
  assert.equal(last.hasMore, false, 'no cursor and hasMore:false terminates');
});

test('an error status is reported without echoing the Authorization header', async () => {
  await assert.rejects(
    fetchCallGridCallsPage(opts({ error: 'nope' }, 401) as never),
    (err: Error) => {
      assert.match(err.message, /401/);
      assert.doesNotMatch(err.message, /Bearer|test-key-not-a-real-secret/, 'never echoes the key');
      return true;
    },
  );
});
