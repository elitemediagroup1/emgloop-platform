// CallGrid occurrence timestamp — pinned to a real record.
//
//   BidId          cmrr0gv2p3g8n07jv41p11p6s
//   UTCDate        Sat, 18 Jul 2026 23:41:46 GMT
//   UTCISODate     2026-07-18T23:41:46.712Z
//   UTCUnixTime    1784418106
//   UTCUnixTimeMs  1784418106712
//
// All identify the same instant. Reconciliation previously compared against
// 2026-07-18T23:42:02.716Z — `createdAt`, ~16s later, because it was first in
// the alias list. These tests make that unrepeatable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCallOccurrence, NON_OCCURRENCE_TIMESTAMP_FIELDS } from '../src/adapters/callgrid-occurrence';

const ISO = '2026-07-18T23:41:46.712Z';
const MS = 1784418106712;
const SEC = 1784418106;
const RECORD_CREATED = '2026-07-18T23:42:02.716Z'; // createdAt — NOT the call time

test('UTCUnixTimeMs resolves to the exact instant with milliseconds', () => {
  const r = resolveCallOccurrence({ UTCUnixTimeMs: MS });
  assert.equal(r.at?.toISOString(), ISO);
  assert.equal(r.field, 'UTCUnixTimeMs');
  assert.equal(r.millisecondPrecision, true);
});

test('UTCISODate resolves to the same instant', () => {
  const r = resolveCallOccurrence({ UTCISODate: ISO });
  assert.equal(r.at?.toISOString(), ISO);
  assert.equal(r.field, 'UTCISODate');
  assert.equal(r.millisecondPrecision, true);
});

test('UTCUnixTime resolves to the same second, without milliseconds', () => {
  const r = resolveCallOccurrence({ UTCUnixTime: SEC });
  assert.equal(r.at?.toISOString(), '2026-07-18T23:41:46.000Z');
  assert.equal(r.field, 'UTCUnixTime');
  assert.equal(r.millisecondPrecision, false, 'epoch seconds cannot carry ms');
});

test('all three fields agree to the second', () => {
  const a = resolveCallOccurrence({ UTCUnixTimeMs: MS }).at!.getTime();
  const b = resolveCallOccurrence({ UTCISODate: ISO }).at!.getTime();
  const c = resolveCallOccurrence({ UTCUnixTime: SEC }).at!.getTime();
  assert.equal(a, b, 'ms and ISO are identical');
  assert.equal(Math.floor(a / 1000), Math.floor(c / 1000), 'seconds field truncates only');
  assert.equal(a - c, 712, 'the difference is exactly the lost milliseconds');
});

test('UTCUnixTimeMs takes precedence over createdAt and updatedAt', () => {
  const r = resolveCallOccurrence({
    createdAt: RECORD_CREATED,
    updatedAt: RECORD_CREATED,
    UTCUnixTimeMs: MS,
  });
  assert.equal(r.at?.toISOString(), ISO, 'must use the call time, not the record time');
  assert.equal(r.field, 'UTCUnixTimeMs');
});

test('createdAt and updatedAt are NEVER used, even when nothing else exists', () => {
  // The 16-second discrepancy came from exactly this substitution.
  for (const field of NON_OCCURRENCE_TIMESTAMP_FIELDS) {
    const r = resolveCallOccurrence({ [field]: RECORD_CREATED });
    assert.equal(r.at, null, `${field} must not supply the occurrence timestamp`);
    assert.equal(r.field, null);
  }
});

test('full precedence order holds when several fields are present', () => {
  const all = { UTCUnixTimeMs: MS, UTCISODate: ISO, UTCUnixTime: SEC, createdAt: RECORD_CREATED };
  assert.equal(resolveCallOccurrence(all).field, 'UTCUnixTimeMs');
  const { UTCUnixTimeMs, ...noMs } = all;
  assert.equal(resolveCallOccurrence(noMs).field, 'UTCISODate');
  const { UTCISODate, ...noIso } = noMs;
  assert.equal(resolveCallOccurrence(noIso).field, 'UTCUnixTime');
});

test('an unusable payload is REJECTED, never stamped with now', () => {
  // Stamping "now" would drop the call into whatever window happened to be open.
  for (const payload of [{}, { UTCUnixTime: 'not-a-number' }, { UTCISODate: '' }, { UTCUnixTimeMs: null }]) {
    const r = resolveCallOccurrence(payload as Record<string, unknown>);
    assert.equal(r.at, null, 'must reject rather than fabricate');
  }
});

test('epoch classification is by magnitude, so a fractional value is not misread', () => {
  assert.equal(resolveCallOccurrence({ UTCUnixTime: 1784418106.712 }).at?.toISOString(), ISO);
});
