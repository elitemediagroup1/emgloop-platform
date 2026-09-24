// The worker's boot-time configuration: what it refuses, and what the fatal line may say about it.
//
// The first production deploy (2026-09-24) rolled back with "Container worker exited with code 1"
// and no log to read. These tests pin the refusals a wrongly shaped operator value produces, and
// that the fatal line names the setting -- never a value -- so the next such failure is diagnosable
// from one log line.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { fatalLogFields, readWorkerConfig } from '../src/config';

const GOOD: Record<string, string> = {
  TELEGRAM_API_ID: '12345',
  TELEGRAM_API_HASH: 'abcdef0123456789abcdef0123456789',
  LOOP_CONNECTION_SECRET_KEY: randomBytes(32).toString('base64'),
  LOOP_CONNECTION_CONVERSATION_SECRET: randomBytes(32).toString('hex'),
  LOOP_CONNECTIONS_WORKER_SECRET: randomBytes(32).toString('hex'),
};

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys({ ...GOOD, ...env })) {
    saved[k] = process.env[k];
    const v = env[k] === undefined && !(k in env) ? GOOD[k] : env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('correctly shaped values configure the worker', () => {
  const config = withEnv({}, () => readWorkerConfig());
  assert.equal(config.telegram.apiId, 12345);
  assert.equal(config.connectionSecretKey.length, 32);
});

test('a sealing key that is not 32 bytes of base64 is refused, naming the setting', () => {
  const refusals: Record<string, string> = {
    'the console\'s key/value JSON': JSON.stringify({ 'connection-key': randomBytes(32).toString('base64') }),
    'hex instead of base64': randomBytes(32).toString('hex'),
    'too short': randomBytes(16).toString('base64'),
    'empty': '',
  };
  for (const [label, value] of Object.entries(refusals)) {
    assert.throws(
      () => withEnv({ LOOP_CONNECTION_SECRET_KEY: value }, () => readWorkerConfig()),
      (e: unknown) => (e as Error).name === 'NotConfigured' && /LOOP_CONNECTION_SECRET_KEY/.test((e as Error).message) && !(e as Error).message.includes(value.slice(0, 8) || '\u0000'),
      label,
    );
  }
});

test('a Telegram api_id that is not a positive integer is refused, naming the setting', () => {
  for (const value of ['', 'abc', '0', '-5', '12.5', '"12345"']) {
    assert.throws(() => withEnv({ TELEGRAM_API_ID: value }, () => readWorkerConfig()), (e: unknown) => (e as Error).name === 'NotConfigured' && /TELEGRAM_API_ID/.test((e as Error).message), JSON.stringify(value));
  }
  // Surrounding whitespace is trimmed, as a pasted value carries it.
  assert.equal(withEnv({ TELEGRAM_API_ID: ' 12345 ' }, () => readWorkerConfig()).telegram.apiId, 12345);
});

test('every required setting is refused by name when missing or blank', () => {
  for (const name of Object.keys(GOOD)) {
    for (const blank of [undefined, '', '   ']) {
      assert.throws(() => withEnv({ [name]: blank }, () => readWorkerConfig()), (e: unknown) => (e as Error).name === 'NotConfigured' && (e as Error).message.includes(name), `${name}=${JSON.stringify(blank)}`);
    }
  }
});

test('the fatal line carries the setting name for a configuration refusal, and only a name for anything else', () => {
  const refusal = (() => {
    try {
      withEnv({ LOOP_CONNECTION_SECRET_KEY: 'nope' }, () => readWorkerConfig());
      throw new Error('unreachable');
    } catch (e) {
      return e;
    }
  })();
  assert.deepEqual(fatalLogFields(refusal), { name: 'NotConfigured', message: 'connections worker not configured: LOOP_CONNECTION_SECRET_KEY (must be 32 bytes base64)' });

  const leaky = new Error('connect ECONNREFUSED db.example.internal:5432 password=hunter2');
  leaky.name = 'PrismaClientInitializationError';
  assert.deepEqual(fatalLogFields(leaky), { name: 'PrismaClientInitializationError' });
  assert.deepEqual(fatalLogFields(null), { name: 'error' });
  assert.deepEqual(fatalLogFields({ name: '' }), { name: 'error' });
});
