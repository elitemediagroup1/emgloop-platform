import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signWorkerRequest, verifyWorkerRequest, WORKER_SIGNATURE_TOLERANCE_MS } from '../src/connection-worker-auth';

const SECRET = 'shared-worker-secret';
const NOW = new Date('2026-09-20T12:00:00Z');

test('a request the web signs verifies at the worker', () => {
  const body = JSON.stringify({ organizationId: 'o', userId: 'u', phone: '+1555' });
  const { signature, timestamp } = signWorkerRequest(SECRET, body, NOW);
  assert.equal(verifyWorkerRequest(SECRET, { body, signature, timestamp, now: NOW }), true);
});

test('a wrong secret, tampered body, or bad signature is rejected', () => {
  const body = JSON.stringify({ organizationId: 'o', userId: 'u' });
  const { signature, timestamp } = signWorkerRequest(SECRET, body, NOW);
  assert.equal(verifyWorkerRequest('other', { body, signature, timestamp, now: NOW }), false);
  assert.equal(verifyWorkerRequest(SECRET, { body: body + 'x', signature, timestamp, now: NOW }), false);
  assert.equal(verifyWorkerRequest(SECRET, { body, signature: 'deadbeef', timestamp, now: NOW }), false);
  assert.equal(verifyWorkerRequest(SECRET, { body, signature: null, timestamp, now: NOW }), false);
});

test('a stale timestamp is rejected (replay window)', () => {
  const body = '{}';
  const { signature, timestamp } = signWorkerRequest(SECRET, body, NOW);
  const later = new Date(NOW.getTime() + WORKER_SIGNATURE_TOLERANCE_MS + 1000);
  assert.equal(verifyWorkerRequest(SECRET, { body, signature, timestamp, now: later }), false);
  assert.equal(verifyWorkerRequest(SECRET, { body, signature, timestamp, now: new Date(NOW.getTime() + 1000) }), true);
});

test('an empty secret never verifies', () => {
  const body = '{}';
  const { signature, timestamp } = signWorkerRequest('x', body, NOW);
  assert.equal(verifyWorkerRequest('', { body, signature, timestamp, now: NOW }), false);
});
