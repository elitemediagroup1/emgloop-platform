// Connection resilience — regression tests for the production failure:
//   prisma:error  Error in PostgreSQL connection: Error { kind: Closed, cause: None }
//
// The retry must be NARROW (connection loss only) and SINGLE (no loop). A broad
// or looping retry would hide real query bugs and turn an outage into a pile-up,
// so both properties are asserted rather than assumed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isConnectionClosedError, runWithReconnect } from '../src/connection-resilience';

test('recognises the exact production error string', () => {
  // Verbatim from the Netlify function log.
  assert.equal(
    isConnectionClosedError(new Error('Error in PostgreSQL connection: Error { kind: Closed, cause: None }')),
    true,
  );
});

test('recognises the other ways a dropped socket surfaces', () => {
  for (const m of [
    'Connection closed',
    'connection is closed',
    'Server has closed the connection.',
    'read ECONNRESET',
    'write EPIPE',
    'P1001: Can\'t reach database server',
    'P1017: Server has closed the connection',
  ]) {
    assert.equal(isConnectionClosedError(new Error(m)), true, m);
  }
});

test('does NOT treat genuine query failures as connection loss', () => {
  // Retrying these would hide real bugs behind a reconnect.
  for (const m of [
    'Unique constraint failed on the fields: (`email`)',
    'Foreign key constraint failed',
    'Invalid `prisma.user.findMany()` invocation',
    'Timed out fetching a new connection from the connection pool',
    'Argument `where` is missing',
  ]) {
    assert.equal(isConnectionClosedError(new Error(m)), false, m);
  }
});

test('a healthy query never triggers a reconnect', async () => {
  let reconnects = 0;
  const result = await runWithReconnect(
    async () => 'ok',
    async () => {
      reconnects += 1;
    },
  );
  assert.equal(result, 'ok');
  assert.equal(reconnects, 0, 'the happy path must not touch the connection');
});

test('a closed connection reconnects once and the query succeeds', async () => {
  let attempts = 0;
  let reconnects = 0;
  const result = await runWithReconnect(
    async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('Error { kind: Closed, cause: None }');
      return 'recovered';
    },
    async () => {
      reconnects += 1;
    },
  );
  assert.equal(result, 'recovered');
  assert.equal(attempts, 2, 'exactly one retry');
  assert.equal(reconnects, 1, 'exactly one reconnect');
});

test('reconnect happens BEFORE the retry, not after', async () => {
  const order: string[] = [];
  let attempts = 0;
  await runWithReconnect(
    async () => {
      attempts += 1;
      order.push(`query:${attempts}`);
      if (attempts === 1) throw new Error('kind: Closed');
      return 'ok';
    },
    async () => {
      order.push('reconnect');
    },
  );
  assert.deepEqual(order, ['query:1', 'reconnect', 'query:2']);
});

test('a persistently dead database fails rather than looping', async () => {
  let attempts = 0;
  await assert.rejects(
    runWithReconnect(
      async () => {
        attempts += 1;
        throw new Error('Error { kind: Closed, cause: None }');
      },
      async () => undefined,
    ),
    /kind: Closed/,
  );
  assert.equal(attempts, 2, 'must not retry more than once — an outage must surface');
});

test('a non-connection error propagates untouched and unretried', async () => {
  let attempts = 0;
  await assert.rejects(
    runWithReconnect(
      async () => {
        attempts += 1;
        throw new Error('Unique constraint failed on the fields: (`email`)');
      },
      async () => {
        assert.fail('must not reconnect for a query error');
      },
    ),
    /Unique constraint/,
  );
  assert.equal(attempts, 1);
});

test('a failure during reconnect surfaces rather than being swallowed', async () => {
  await assert.rejects(
    runWithReconnect(
      async () => {
        throw new Error('kind: Closed');
      },
      async () => {
        throw new Error('reconnect refused');
      },
    ),
    /reconnect refused/,
  );
});
