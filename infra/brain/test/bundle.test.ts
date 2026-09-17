// The shipped bundles: dark, minimal, and loadable. Slice B6.
//
// Builds the bundles, then checks what went into each one. The strongest proof that no
// provider call can happen in B6 is that no provider client or endpoint is in any bundle.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { BRAIN_FUNCTIONS, BUNDLE_TARGET } from '../scripts/bundle';

const DIST = resolve(__dirname, '..', 'dist');

before(() => {
  execFileSync(process.execPath, ['--import', 'tsx', resolve(__dirname, '..', 'scripts', 'bundle.ts')], { stdio: 'pipe' });
});

const meta = (name: string) => JSON.parse(readFileSync(join(DIST, 'meta', `${name}.json`), 'utf8')) as { inputs: Record<string, unknown> };

test('no bundle contains a provider client, a provider endpoint or the provider package', () => {
  for (const f of BRAIN_FUNCTIONS) {
    const code = readFileSync(join(DIST, f.name, 'index.js'), 'utf8');
    assert.doesNotMatch(code, /api\.anthropic\.com|api\.openai\.com|@anthropic-ai\/sdk|anthropic-version|x-api-key/i, f.name);
    const inputs = Object.keys(meta(f.name).inputs);
    assert.ok(!inputs.some((i) => /packages\/providers\/|node_modules\/(openai|@anthropic-ai)\//.test(i)), `${f.name} bundles provider code`);
    assert.ok(!inputs.some((i) => /packages\/database\/src\/index\.ts$/.test(i)), `${f.name} bundles the database barrel and its singleton`);
    assert.ok(!inputs.some((i) => /apps\/web\//.test(i)), `${f.name} bundles web code`);
  }
});

test('each function carries only the cloud clients and database access it uses', () => {
  const clients = (name: string) => [...new Set(Object.keys(meta(name).inputs).map((i) => /@aws-sdk\/(client-[a-z-]+)/.exec(i)?.[1]).filter(Boolean))].sort();
  assert.deepEqual(clients('authorizer'), ['client-dynamodb', 'client-ssm']);
  assert.deepEqual(clients('dispatcher'), ['client-secrets-manager', 'client-sqs', 'client-ssm']);
  assert.deepEqual(clients('worker-interactive'), ['client-kms', 'client-secrets-manager', 'client-sqs', 'client-ssm']);
  assert.deepEqual(clients('sweeper'), ['client-lambda', 'client-secrets-manager', 'client-sqs', 'client-ssm']);
  assert.ok(!Object.keys(meta('authorizer').inputs).some((i) => /prisma/.test(i)), 'the authorizer has no database client');
  assert.ok(!existsSync(join(DIST, 'authorizer', 'node_modules')));
  for (const name of ['dispatcher', 'worker-interactive', 'worker-durable', 'sweeper']) {
    const engines = readdirSync(join(DIST, name, 'node_modules', '.prisma', 'client')).filter((f) => f.startsWith('libquery_engine'));
    assert.deepEqual(engines, ['libquery_engine-rhel-openssl-3.0.x.so.node'], `${name}: only the Lambda engine`);
  }
});

const LOAD_ENV = {
  ...process.env,
  AWS_REGION: 'us-east-1',
  AWS_EC2_METADATA_DISABLED: 'true',
  BRAIN_PARAMETER_PREFIX: '/loop/brain/test',
  BRAIN_REPLAY_TABLE: 'replay',
  BRAIN_INTERACTIVE_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/1/i',
  BRAIN_DURABLE_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/1/d',
  BRAIN_DATABASE_SECRET: 'db',
  BRAIN_CHECKPOINT_SECRET: 'ck',
  BRAIN_SIGNING_KEY_ARN: 'arn:aws:kms:us-east-1:1:key/x',
  BRAIN_WORKER_ISSUER: 'loop-brain-test',
  BRAIN_WORKER_SUBJECT: 'worker-durable',
  BRAIN_DISPATCHER_FUNCTION: 'dispatcher',
};

test('every bundle loads and exports a handler, with no network at load time', () => {
  for (const f of BRAIN_FUNCTIONS) {
    const out = execFileSync(process.execPath, ['-e', `const m = require(${JSON.stringify(join(DIST, f.name, 'index.js'))}); process.stdout.write(typeof m.handler)`], { env: LOAD_ENV, stdio: 'pipe' }).toString();
    assert.equal(out, 'function', f.name);
  }
});

// Node.js 24 on Lambda supports only async (or promise-returning) handlers; the callback
// form ends at Node.js 22. A handler with a third parameter would be a callback handler.
test('every handler is async and takes no callback, as the nodejs24.x runtime requires', () => {
  assert.equal(BUNDLE_TARGET, 'node24', 'the bundles are built for the runtime the stack declares');
  for (const f of BRAIN_FUNCTIONS) {
    const script = `const { handler } = require(${JSON.stringify(join(DIST, f.name, 'index.js'))}); process.stdout.write(JSON.stringify([handler.constructor.name, handler.length]))`;
    const [kind, arity] = JSON.parse(execFileSync(process.execPath, ['-e', script], { env: LOAD_ENV, stdio: 'pipe' }).toString()) as [string, number];
    assert.equal(kind, 'AsyncFunction', f.name);
    assert.ok(arity <= 2, `${f.name} declares ${arity} parameters`);
  }
});

test('with no configuration, the authorizer refuses every ring', async () => {
  const env = { ...process.env, AWS_REGION: 'us-east-1', AWS_EC2_METADATA_DISABLED: 'true', AWS_ACCESS_KEY_ID: '', AWS_SECRET_ACCESS_KEY: '', AWS_PROFILE: 'none-such', BRAIN_PARAMETER_PREFIX: '/p', BRAIN_REPLAY_TABLE: 't' };
  const script = `
    const { handler } = require(${JSON.stringify(join(DIST, 'authorizer', 'index.js'))});
    handler({ headers: { authorization: 'Bearer a.b.c' }, requestContext: { requestId: 'r' } }).then((r) => process.stdout.write(JSON.stringify(r)));
  `;
  const out = execFileSync(process.execPath, ['-e', script], { env, stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000 }).toString();
  assert.deepEqual(JSON.parse(out.trim().split('\n').at(-1)!), { isAuthorized: false });
});
