// The AWS adapters send exactly what the runner asked, and fail closed. Slice B6.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';

import { SqsWorkQueues } from '../src/aws/queues';
import { DynamoReplayLedger } from '../src/aws/replay';
import { KmsEs256Signer } from '../src/aws/signer';
import { LambdaDispatcherInvoker } from '../src/aws/invoker';
import { SecretsSealerSource } from '../src/aws/sealers';
import { cachedParameter, requiredEnv, NotConfigured } from '../src/config';
import { connectionUrl, databaseUrl, prismaFor } from '../src/database';
import { DISPATCHER_RECOVERY_SOURCE } from '../src/recovery';

function recording(reply: (input: any) => unknown = () => ({})) {
  const sent: { name: string; input: any }[] = [];
  return {
    sent,
    client: {
      send: async (command: { constructor: { name: string }; input: unknown }) => {
        sent.push({ name: command.constructor.name, input: command.input });
        return reply(command.input);
      },
    } as any,
  };
}

test('queues: a reference message, to the queue named, with a bounded delay', async () => {
  const r = recording(() => ({ MessageId: 'm-1' }));
  const queues = new SqsWorkQueues({ INTERACTIVE: 'https://sqs/i', DURABLE: 'https://sqs/d' }, r.client);
  const message = { jobId: 'cjob00000000000000000001', generation: 1, reason: 'CONTINUE' as const, commandId: null };
  assert.deepEqual(await queues.send('DURABLE', message, { delaySeconds: 5000 }), { messageId: 'm-1' });
  assert.deepEqual(r.sent, [{ name: 'SendMessageCommand', input: { QueueUrl: 'https://sqs/d', MessageBody: JSON.stringify(message), DelaySeconds: 900 } }]);
  await assert.rejects(new SqsWorkQueues({ DURABLE: 'https://sqs/d' }, r.client).send('INTERACTIVE', message), /no INTERACTIVE queue/);
});

test('replay ledger: a token id is recorded once, conditionally', async () => {
  const seen = new Set<string>();
  const client = {
    send: async (command: { input: any }) => {
      const id = command.input.Item.jti.S;
      assert.equal(command.input.ConditionExpression, 'attribute_not_exists(jti)');
      if (seen.has(id)) throw new ConditionalCheckFailedException({ message: 'exists', $metadata: {} });
      seen.add(id);
      return {};
    },
  } as any;
  const ledger = new DynamoReplayLedger('ring-replay', client);
  assert.equal(await ledger.recordOnce('t1', 1800000090.7), true);
  assert.equal(await ledger.recordOnce('t1', 1800000090), false);
  const broken = new DynamoReplayLedger('ring-replay', { send: async () => { throw new Error('throttled'); } } as any);
  await assert.rejects(broken.recordOnce('t2', 1), /throttled/, 'an outage is an error, never an acceptance');
});

test('signer: raw message, ECDSA_SHA_256, the configured key; the label is what Loop pins', async () => {
  const r = recording(() => ({ Signature: new Uint8Array([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x02]) }));
  const signer = new KmsEs256Signer('worker-2026-1', 'arn:aws:kms:us-east-1:111111111111:key/abc', r.client);
  assert.equal(signer.keyId, 'worker-2026-1');
  const der = await signer.sign(new TextEncoder().encode('h.p'));
  assert.equal(der.length, 8);
  assert.equal(r.sent[0]!.input.KeyId, 'arn:aws:kms:us-east-1:111111111111:key/abc');
  assert.equal(r.sent[0]!.input.MessageType, 'RAW');
  assert.equal(r.sent[0]!.input.SigningAlgorithm, 'ECDSA_SHA_256');
  await assert.rejects(new KmsEs256Signer('k', 'arn', recording(() => ({})).client).sign(new Uint8Array([1])), /no signature/);
});

test('invoker: an asynchronous hand-over carrying only the command id', async () => {
  const r = recording();
  await new LambdaDispatcherInvoker('loop-brain-staging-dispatcher', r.client).recover('ccmd00000000000000000001');
  assert.equal(r.sent[0]!.input.InvocationType, 'Event');
  assert.deepEqual(JSON.parse(Buffer.from(r.sent[0]!.input.Payload).toString()), { source: DISPATCHER_RECOVERY_SOURCE, kind: 'RECOVERY', commandId: 'ccmd00000000000000000001' });
});

test('sealers: new checkpoints name the current secret version; old ones open with theirs', async () => {
  const versions: Record<string, string> = { v1: 'a'.repeat(64), v2: 'b'.repeat(64) };
  let current = 'v1';
  let reads = 0;
  const client = {
    send: async (command: { input: { VersionId?: string } }) => {
      reads += 1;
      const id = command.input.VersionId ?? current;
      if (!versions[id]) throw new Error('no such version');
      return { SecretString: versions[id], VersionId: id };
    },
  } as any;
  const source = new SecretsSealerSource('loop/brain/staging/checkpoint-key', client);
  const ctx = { organizationId: 'o', jobId: 'cjob00000000000000000001', stepKey: 'context.load', inputFingerprint: 'fp', purpose: 'CHECKPOINT' as const };
  const old = await (await source.current()).seal(ctx, new TextEncoder().encode('{"n":1}'));
  assert.equal(old.keyRef, 'secretsmanager:loop/brain/staging/checkpoint-key:v1');
  current = 'v2';
  const fresh = await (await source.current()).seal(ctx, new TextEncoder().encode('{"n":2}'));
  assert.equal(fresh.keyRef, 'secretsmanager:loop/brain/staging/checkpoint-key:v2');
  const opener = await source.forKeyRef(old.keyRef);
  assert.equal(new TextDecoder().decode(await opener!.open(ctx, old)), '{"n":1}');
  const readsBefore = reads;
  assert.equal(await source.forKeyRef('secretsmanager:another/secret:v1'), null);
  // Same length as this source's prefix, so only the prefix check tells them apart.
  assert.equal(await source.forKeyRef('secretsmanager:loop/brain/staging/checkpoint-kez:v1'), null);
  assert.equal(reads, readsBefore, 'a key reference for another secret is never looked up');
  assert.equal(await source.forKeyRef('secretsmanager:loop/brain/staging/checkpoint-key:v9'), null);
});

test('configuration: parameters fail closed; database secrets must hold a URL that verifies TLS', async () => {
  let calls = 0;
  const flaky = cachedParameter('/p', 60_000, { send: async () => { calls += 1; throw new Error('denied'); } } as any);
  assert.equal(await flaky(), undefined);
  assert.equal(await flaky(), undefined);
  assert.equal(calls, 1, 'cached, including a failure');
  const good = cachedParameter('/p', 0, { send: async () => ({ Parameter: { Value: 'true' } }) } as any);
  assert.equal(await good(), 'true');
  assert.throws(() => requiredEnv('BRAIN_DOES_NOT_EXIST'), NotConfigured);

  const secret = (value: string) => ({ send: async () => ({ SecretString: value }) }) as any;
  await assert.rejects(databaseUrl('s', secret(JSON.stringify({ state: 'UNSET', placeholder: 'x' }))), NotConfigured);
  await assert.rejects(databaseUrl('s', secret('not json')), NotConfigured);
  await assert.rejects(databaseUrl('s', secret(JSON.stringify({ url: 'mysql://x' }))), NotConfigured);
  // Fixture URLs carry no user or password: a credential never appears in this repository.
  const url = (u: string) => databaseUrl('s', secret(JSON.stringify({ url: u })));
  assert.equal(await url('postgresql://db.invalid/fixture?sslmode=require'), 'postgresql://db.invalid/fixture?sslmode=require');
  assert.equal(await url('postgres://db.invalid/fixture?sslmode=require&sslaccept=strict'), 'postgres://db.invalid/fixture?sslmode=require&sslaccept=strict');
  for (const weak of [
    'postgresql://db.invalid/fixture',
    'postgresql://db.invalid/fixture?sslmode=prefer',
    'postgresql://db.invalid/fixture?sslmode=disable',
    'postgresql://db.invalid/fixture?sslmode=require&sslaccept=accept_invalid_certs',
    'postgresql://db.invalid/fixture?sslmode=require&sslaccept=',
  ]) {
    await assert.rejects(url(weak), NotConfigured, weak);
  }
  // Refusals never carry the URL.
  await assert.rejects(url('postgresql://db.invalid/unique-marker?sslmode=disable'), (err: Error) => !err.message.includes('unique-marker'));

  assert.equal(connectionUrl('postgresql://db.invalid/fixture?sslmode=require'), 'postgresql://db.invalid/fixture?sslmode=require&connection_limit=1&sslaccept=strict');
  assert.equal(connectionUrl('postgresql://db.invalid/fixture'), 'postgresql://db.invalid/fixture?connection_limit=1&sslaccept=strict');
  assert.equal(connectionUrl('postgresql://db.invalid/fixture?sslmode=require&connection_limit=3&sslaccept=strict'), 'postgresql://db.invalid/fixture?sslmode=require&connection_limit=3&sslaccept=strict');
  const a = prismaFor('postgresql://localhost:5/fixture');
  assert.equal(prismaFor('postgresql://localhost:5/fixture'), a, 'one client per warm instance');
});
