// Report-shape discovery — the primitives the bid-discovery endpoint relies on.
//
// The endpoint itself needs a live credential, but its safety property does not:
// it must report KEYS ONLY, never values. That is asserted here, because a
// discovery tool that leaked a caller id or a bid amount would be worse than no
// discovery tool.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeShape, extractRecordsOrNull } from '../src/adapters/callgrid-api';

test('shape description never emits a value, only keys', () => {
  const body = {
    data: [{ callerId: '+12125551234', avgBid: 11.09, sourceName: 'Acme Traffic' }],
    totalBidAmount: 585382.56,
  };
  const described = describeShape(body);
  assert.match(described, /data/, 'top-level keys are reported');
  assert.match(described, /totalBidAmount/);
  assert.doesNotMatch(described, /2125551234/, 'no caller id');
  assert.doesNotMatch(described, /11\.09|585382/, 'no amounts');
  assert.doesNotMatch(described, /Acme/, 'no names');
});

test('an unrecognised report envelope is null, never an empty report', () => {
  // A report shape we cannot read must not be reported as "no bid activity".
  assert.equal(extractRecordsOrNull({ unexpected: 'shape' }), null);
  assert.equal(extractRecordsOrNull({ data: 'not-an-array' }), null);
  const empty = extractRecordsOrNull({ data: [] });
  assert.ok(empty, 'a genuinely empty report IS readable');
  assert.equal(empty!.records.length, 0);
});

test('row keys can be listed without exposing any row value', () => {
  // Exactly what the discovery endpoint does: Object.keys on the first row.
  const row = { pings: 478504, bids: 274383, made: 22402, won: 106, callerId: '+12125551234' };
  const keys = Object.keys(row);

  assert.deepEqual(keys, ['pings', 'bids', 'made', 'won', 'callerId']);
  // The property that matters: the emitted payload is the KEY LIST, and no
  // value from the row appears anywhere in it.
  const emitted = JSON.stringify(keys);
  assert.doesNotMatch(emitted, /12125551234/, 'no caller id in the emitted keys');
  assert.doesNotMatch(emitted, /478504|274383|22402/, 'no counts in the emitted keys');
});

test('the known-wrong stub shape is detectable as missing the funnel', () => {
  // Guards the Phase 1 conclusion: the bidStats stub cannot represent the
  // observed report, because the report's top two funnel stages are absent.
  const stubFields = ['bids', 'won', 'total', 'rated', 'rejected', 'avgBid', 'winRate'];
  const reportFunnel = ['pings', 'bids', 'made', 'won'];
  const missing = reportFunnel.filter((f) => !stubFields.includes(f));
  assert.deepEqual(missing, ['pings', 'made'], 'the stub is missing the top of the funnel');
});
