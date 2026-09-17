// The runner's trust edges: tokens, the doorbell authorizer, the dispatcher, the client for
// Loop's internal API, configuration and logging. No network, no provider, no cloud.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as nodeSign, verify as nodeVerify, createHash, type KeyObject } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { BRAIN_DOORBELL_AUDIENCE, BRAIN_DOORBELL_SCOPE, BRAIN_WORKER_AUDIENCE, type BrainDoorbellClaims } from '@emgloop/shared';
import { AesGcmBrainPayloadSealer } from '../../../packages/database/src/services/brain/brain-payload-sealer';

import { authorizeRing } from '../src/doorbell-authorizer';
import { dispatch } from '../src/dispatcher';
import { base64url, derToJoseP256, p256PublicKey, pinnedKeysFromJson, signEs256Jwt, verifyEs256Jwt, JwsError } from '../src/jws';
import { createLoopClient, loopBaseUrl } from '../src/loop-client';
import { BRAIN_FLOOR_STOPPED, checkpointSealerFromSecret, parseAiFloor, parseNameList, parseSwitch } from '../src/config';
import { memoryLogger } from '../src/log';
import { BRAIN_EXECUTOR_OBLIGATION_EVIDENCE, BRAIN_EXECUTOR_REVISION, brainExecutorObligationsWithoutEvidence } from '../src/revision';
import { memoryQueues, memoryReplay, testSigner, world, reviewSubmission, caseSubmission } from './world';

const NOW = 1_800_000_000;

function doorbellClaims(over: Partial<BrainDoorbellClaims> & Record<string, unknown> = {}): Record<string, unknown> {
  return { iss: 'loop-web-test', sub: 'netlify-test', aud: BRAIN_DOORBELL_AUDIENCE, scope: BRAIN_DOORBELL_SCOPE, jti: 'ring-1', iat: NOW - 1, exp: NOW + 59, ...over };
}

const RING_TRUST = (key: KeyObject) => ({ keys: new Map([['ring-1', key]]), trustedIssuers: ['loop-web-test'], trustedCallers: ['netlify-test'] });

test('revision 1 names how it keeps every executor obligation', () => {
  assert.equal(BRAIN_EXECUTOR_REVISION, 'loop-step-runner.r1');
  assert.deepEqual(brainExecutorObligationsWithoutEvidence(), []);
  assert.equal(Object.keys(BRAIN_EXECUTOR_OBLIGATION_EVIDENCE).length, 12);
});

test('a key-service DER signature becomes the 64-byte JOSE form, including short and padded integers', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  for (let i = 0; i < 200; i += 1) {
    const data = Buffer.from(`message-${i}`);
    const der = nodeSign('sha256', data, { key: privateKey, dsaEncoding: 'der' });
    const jose = derToJoseP256(der);
    assert.equal(jose.length, 64);
    assert.ok(nodeVerify('sha256', data, { key: publicKey, dsaEncoding: 'ieee-p1363' }, jose), `sample ${i}`);
  }
  // r with a leading 0x00 (high bit set) and a one-byte s.
  const r = Buffer.concat([Buffer.from([0x00, 0x80]), Buffer.alloc(31, 1)]);
  const der = Buffer.concat([Buffer.from([0x30, 2 + r.length + 3, 0x02, r.length]), r, Buffer.from([0x02, 0x01, 0x05])]);
  const jose = derToJoseP256(der);
  assert.equal(jose[0], 0x80);
  assert.equal(jose[63], 0x05);
  assert.equal(jose[32], 0x00);
  for (const bad of [Buffer.from([]), Buffer.from([0x31, 0x00]), Buffer.from([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01]), Buffer.concat([der, Buffer.from([0x00])]), Buffer.concat([Buffer.from([0x30, 0x25, 0x02, 0x21]), Buffer.alloc(33, 1), Buffer.from([0x02, 0x00])])]) {
    assert.throws(() => derToJoseP256(bad), JwsError);
  }
});

test('tokens verify only with a pinned P-256 key and the ES256 header, and a private key is never pinned', async () => {
  const signer = testSigner('k1');
  const keys = new Map([['k1', signer.publicKey]]);
  const token = await signEs256Jwt({ a: 1 }, signer);
  assert.deepEqual(verifyEs256Jwt(token, keys), { ok: true, kid: 'k1', payload: { a: 1 } });
  const [h, p, s] = token.split('.') as [string, string, string];
  assert.equal(verifyEs256Jwt(`${h}.${base64url(JSON.stringify({ a: 2 }))}.${s}`, keys).ok, false);
  assert.deepEqual(verifyEs256Jwt(`${base64url(JSON.stringify({ alg: 'none', kid: 'k1' }))}.${p}.${s}`, keys), { ok: false, refusal: 'WRONG_ALGORITHM' });
  assert.deepEqual(verifyEs256Jwt(`${base64url(JSON.stringify({ alg: 'ES256', kid: 'k2' }))}.${p}.${s}`, keys), { ok: false, refusal: 'UNKNOWN_KEY' });
  assert.deepEqual(verifyEs256Jwt('x'.repeat(5000), keys), { ok: false, refusal: 'MALFORMED' });
  await assert.rejects(signEs256Jwt({}, { ...signer, keyId: 'arn:aws:kms:us-east-1:1:key/x' }), JwsError, 'a key-service ARN is not a key id');

  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const privatePem = pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const publicPem = pair.publicKey.export({ format: 'pem', type: 'spki' }).toString();
  assert.throws(() => p256PublicKey(privatePem), JwsError);
  assert.equal(pinnedKeysFromJson(JSON.stringify({ k1: publicPem })).size, 1);
  assert.equal(pinnedKeysFromJson(JSON.stringify({ k1: publicPem.replace(/\n/g, '\\n') })).size, 1, 'escaped newlines are accepted');
  for (const raw of ['', 'nope', '[]', JSON.stringify({ k1: privatePem }), JSON.stringify({ 'bad kid': publicPem }), JSON.stringify({ k1: publicPem, k2: 'x' })]) {
    assert.equal(pinnedKeysFromJson(raw).size, 0, raw.slice(0, 20));
  }
  const p384 = generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).publicKey.export({ format: 'pem', type: 'spki' }).toString();
  assert.throws(() => p256PublicKey(p384), JwsError);
});

test('the authorizer admits a fresh, trusted ring once, and says nothing about why others fail', async () => {
  const ring = testSigner('ring-1');
  const trust = RING_TRUST(ring.publicKey);
  const replay = memoryReplay();
  const log = memoryLogger({ component: 'authorizer' });
  const authorize = async (claims: Record<string, unknown>, deps: Partial<Parameters<typeof authorizeRing>[1]> = {}) =>
    authorizeRing(`Bearer ${await signEs256Jwt(claims, ring)}`, { trust, replay, nowSeconds: NOW, log, ...deps });

  const ok = await authorize(doorbellClaims());
  assert.equal(ok.authorized, true);
  assert.deepEqual(await authorize(doorbellClaims()), { authorized: false, refusal: 'REPLAYED' }, 'a second use is refused');
  const refusal = async (claims: Record<string, unknown>) => {
    const out = await authorize(claims);
    return out.authorized ? 'AUTHORIZED' : out.refusal;
  };
  assert.equal(await refusal(doorbellClaims({ jti: 'r2', aud: 'loop-brain-internal' })), 'WRONG_AUDIENCE');
  assert.equal(await refusal(doorbellClaims({ jti: 'r3', scope: 'brain.admin' })), 'WRONG_SCOPE');
  assert.equal(await refusal(doorbellClaims({ jti: 'r4', iss: 'someone' })), 'ISSUER_NOT_TRUSTED');
  assert.equal(await refusal(doorbellClaims({ jti: 'r5', sub: 'someone' })), 'CALLER_NOT_TRUSTED');
  assert.equal(await refusal(doorbellClaims({ jti: 'r6', iat: NOW - 400, exp: NOW - 200 })), 'EXPIRED');
  assert.equal(await refusal(doorbellClaims({ jti: 'r7', iat: NOW, exp: NOW + 3600 })), 'LIFETIME_TOO_LONG');
  assert.equal(await refusal(doorbellClaims({ jti: 'r8', iat: NOW + 600, exp: NOW + 650 })), 'NOT_YET_VALID');
  assert.equal(await refusal(doorbellClaims({ jti: 'r9', organizationId: 'org_b' })), 'MALFORMED_CLAIMS', 'no authority may ride on a ring');
  assert.equal(await refusal({ ...doorbellClaims({ jti: 'r10' }), exp: '9999999999' }), 'MALFORMED_CLAIMS');
  assert.deepEqual([...replay.seen.keys()], ['ring-1'], 'refused tokens never occupy the ledger');

  const stranger = testSigner('ring-1');
  assert.deepEqual(await authorizeRing(`Bearer ${await signEs256Jwt(doorbellClaims({ jti: 's1' }), stranger)}`, { trust, replay, nowSeconds: NOW, log }), { authorized: false, refusal: 'UNVERIFIED' });
  assert.deepEqual(await authorizeRing(undefined, { trust, replay, nowSeconds: NOW, log }), { authorized: false, refusal: 'NO_TOKEN' });
  assert.deepEqual(await authorizeRing('Basic abc', { trust, replay, nowSeconds: NOW, log }), { authorized: false, refusal: 'NO_TOKEN' });
  assert.deepEqual(await authorize(doorbellClaims({ jti: 'x1' }), { trust: { ...trust, keys: new Map() } }), { authorized: false, refusal: 'NOT_CONFIGURED' });
  assert.deepEqual(await authorize(doorbellClaims({ jti: 'x2' }), { trust: { ...trust, trustedIssuers: [] } }), { authorized: false, refusal: 'NOT_CONFIGURED' });
  assert.deepEqual(await authorize(doorbellClaims({ jti: 'x3' }), { trust: { ...trust, trustedCallers: [] } }), { authorized: false, refusal: 'NOT_CONFIGURED' });
  assert.ok(!JSON.stringify(log.lines).includes('eyJ'), 'no token is ever logged');
});

test('the dispatcher queues only an EXECUTE disposition, by the job’s class, and records the hand-over', async () => {
  const w = await world();
  const log = memoryLogger({ component: 'dispatcher' });
  const trust = { trustedIssuers: ['loop-web-test'], trustedCallers: ['netlify-test'] };
  const claims = doorbellClaims({ iat: Math.floor(w.now().getTime() / 1000), exp: Math.floor(w.now().getTime() / 1000) + 60 }) as unknown as BrainDoorbellClaims;
  const deps = { store: w.store, queues: w.queues, trust, now: w.now, log };

  const durable = await w.work.submit(w.people.manager, reviewSubmission());
  const interactive = await w.work.submit(w.people.owner, caseSubmission());
  assert.equal(durable.kind, 'ACCEPTED');
  assert.equal(interactive.kind, 'ACCEPTED');
  const [durableCommand, interactiveCommand] = w.rings as [string, string];

  for (const [label, body] of [
    ['authority in the body', JSON.stringify({ commandId: durableCommand, organizationId: 'org_b' })],
    ['an extra field', JSON.stringify({ commandId: durableCommand, priority: 'high' })],
    ['not JSON', '{nope'],
    ['no command', '{}'],
    ['too large', JSON.stringify({ commandId: durableCommand, pad: 'x'.repeat(2000) })],
  ] as const) {
    assert.equal(await dispatch({ kind: 'RING', claims, rawBody: body }, deps), 'BAD_REQUEST', label);
  }
  assert.deepEqual(log.lines.filter((l) => l.event === 'dispatch.bad_request').at(-1)!.refusals, ['BODY_TOO_LARGE'], 'size is refused before parsing');
  assert.equal(await dispatch({ kind: 'RING', claims: { ...claims, iss: 'someone' }, rawBody: JSON.stringify({ commandId: durableCommand }) }, deps), 'BAD_REQUEST', 'the claims are re-checked with the body');
  assert.equal(w.queues.sent.length, 0);

  assert.equal(await dispatch({ kind: 'RING', claims, rawBody: JSON.stringify({ commandId: durableCommand }) }, deps), 'DISPATCHED');
  assert.equal(await dispatch({ kind: 'RECOVERY', commandId: interactiveCommand }, deps), 'DISPATCHED');
  assert.deepEqual(
    w.queues.sent.map((s) => [s.queue, s.message.reason, s.message.commandId]),
    [
      ['DURABLE', 'START', durableCommand],
      ['INTERACTIVE', 'START', interactiveCommand],
    ],
  );
  const row = w.fake.brainCommand.__rows.find((c: any) => c.id === durableCommand);
  assert.ok(row.dispatchedAt instanceof Date, 'the dispatch is recorded');

  assert.equal(await dispatch({ kind: 'RECOVERY', commandId: 'cmd_does_not_exist_01' }, deps), 'NOT_FOUND');
  assert.equal(await dispatch({ kind: 'RECOVERY', commandId: 'bad id' }, deps), 'BAD_REQUEST');

  // A START whose recorded issuer is not the job's principal is refused by disposition,
  // and nothing is queued.
  row.issuerUserId = w.people.owner.userId;
  const before = w.queues.sent.length;
  assert.equal(await dispatch({ kind: 'RECOVERY', commandId: durableCommand }, deps), 'REFUSED');
  assert.equal(w.queues.sent.length, before);
  assert.ok(log.lines.some((l) => l.event === 'dispatch.refused' && (l.refusals as string[]).includes('ISSUER_NOT_PERMITTED')));
});

test('the Loop client signs one token per call, bound to the job, the purpose and the exact body', async () => {
  const signer = testSigner();
  const seen: { url: string; token: Record<string, unknown>; bodySha: string; init: RequestInit }[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    const token = String((init.headers as Record<string, string>).authorization).replace('Bearer ', '');
    const v = verifyEs256Jwt(token, new Map([[signer.keyId, signer.publicKey]]));
    assert.ok(v.ok);
    seen.push({ url, token: v.payload as Record<string, unknown>, bodySha: createHash('sha256').update(Buffer.from(init.body as Uint8Array)).digest('hex'), init });
    return new Response(JSON.stringify({ ok: true, decision: { allowed: true }, principal: null, ref: { artifactId: 'a1' }, commitKey: 'k' }), { status: 200 });
  }) as unknown as typeof fetch;
  let n = 0;
  const client = createLoopClient({ baseUrl: 'https://loop.example.test/', issuer: 'loop-brain-test', subject: 'worker-a' }, { signer, fetch: fakeFetch, nowSeconds: () => NOW, tokenId: () => `t-${++n}` });
  const job = { jobId: 'cjob00000000000000000001', generation: 3 };
  await client.access(job);
  await client.context(job);
  await client.commit(job, 'commit.result', { claims: [] } as never);
  assert.deepEqual(seen.map((s) => s.url), [
    'https://loop.example.test/api/internal/brain/access',
    'https://loop.example.test/api/internal/brain/context',
    'https://loop.example.test/api/internal/brain/commit',
  ]);
  for (const [i, s] of seen.entries()) {
    assert.deepEqual(Object.keys(s.token).sort(), ['aud', 'bodySha256', 'exp', 'generation', 'iat', 'iss', 'jobId', 'jti', 'purpose', 'sub']);
    assert.equal(s.token.aud, BRAIN_WORKER_AUDIENCE);
    assert.equal(s.token.jobId, job.jobId);
    assert.equal(s.token.generation, 3);
    assert.equal((s.token.exp as number) - (s.token.iat as number), 60);
    assert.equal(s.token.bodySha256, s.bodySha, 'the hash is of the bytes actually sent');
    assert.equal(s.token.jti, `t-${i + 1}`);
    assert.equal(s.init.redirect, 'error');
  }
  assert.deepEqual(seen.map((s) => s.token.purpose), ['ACCESS_DECISION', 'CONTEXT', 'COMMIT_RESULT']);
  assert.equal(signer.calls, 3);

  const answers = async (status: number, body: unknown) =>
    createLoopClient({ baseUrl: 'https://loop.example.test', issuer: 'i', subject: 's' }, { signer, fetch: (async () => new Response(JSON.stringify(body), { status })) as never }).context(job);
  assert.deepEqual(await answers(503, {}), { ok: false, failureClass: 'UNAVAILABLE', status: 503 });
  assert.deepEqual(await answers(429, {}), { ok: false, failureClass: 'UNAVAILABLE', status: 429 });
  assert.deepEqual(await answers(403, { ok: false, refusals: ['NOT_PERMITTED'] }), { ok: false, failureClass: 'REFUSED', status: 403, refusals: ['NOT_PERMITTED'] });
  const down = createLoopClient({ baseUrl: 'https://loop.example.test', issuer: 'i', subject: 's' }, { signer, fetch: (async () => { throw new Error('down'); }) as never });
  assert.deepEqual(await down.access(job), { ok: false, failureClass: 'UNAVAILABLE', status: null });
  for (const bad of ['http://loop.example.test', 'https://user:pw@loop.example.test', 'ftp://x', 'not a url', 'https://loop.example.test/?q=1']) assert.equal(loopBaseUrl(bad), null, bad);
  assert.equal(loopBaseUrl('http://127.0.0.1:3000'), 'http://127.0.0.1:3000', 'loopback only, for local verification');
  const unset = createLoopClient({ baseUrl: 'UNSET', issuer: 'i', subject: 's' }, { signer, fetch: fakeFetch });
  assert.deepEqual(await unset.access(job), { ok: false, failureClass: 'UNAVAILABLE', status: null });
});

test('configuration fails closed', () => {
  assert.deepEqual(parseAiFloor(undefined), BRAIN_FLOOR_STOPPED);
  for (const raw of ['', 'nope', '[]', '{}', JSON.stringify({ enabled: 'true', organizations: [], tasks: [], providers: [], killSwitches: [] }), JSON.stringify({ enabled: true, organizations: ['a'], tasks: [], providers: [], killSwitches: [{ scope: 'TASK' }] }), JSON.stringify({ enabled: false, organizations: [], tasks: [], providers: [], killSwitches: [], extra: 1 })]) {
    assert.deepEqual(parseAiFloor(raw), BRAIN_FLOOR_STOPPED, raw);
  }
  const floor = parseAiFloor(JSON.stringify({ enabled: false, organizations: ['org_a'], tasks: ['case.explanation'], providers: [], killSwitches: [{ scope: 'TASK', value: 'x.y' }, { scope: 'GLOBAL' }] }));
  assert.deepEqual(floor, { activation: { enabled: false, organizations: ['org_a'], tasks: ['case.explanation'], providers: [] }, killSwitches: [{ scope: 'TASK', value: 'x.y' }, { scope: 'GLOBAL' }] });
  assert.equal(parseSwitch('true'), true);
  for (const raw of [undefined, 'TRUE', 'yes', '1', ' true', 'UNSET']) assert.equal(parseSwitch(raw), false, String(raw));
  assert.deepEqual(parseNameList(' a, b ,,c d, a'), ['a', 'b']);
});

test('the checkpoint key is derived from the secret, and opens across processes', async () => {
  const secret = 'x'.repeat(40) + 'random-looking-secret-text';
  const a = checkpointSealerFromSecret(secret, 'secretsmanager:loop/brain/staging/checkpoint-key:v1');
  const b = checkpointSealerFromSecret(secret, 'secretsmanager:loop/brain/staging/checkpoint-key:v1');
  const ctx = { organizationId: 'o', jobId: 'cjob00000000000000000001', stepKey: 'context.load', inputFingerprint: 'fp', purpose: 'CHECKPOINT' as const };
  const sealed = await a.seal(ctx, Buffer.from('{"k":1}'));
  assert.deepEqual(Buffer.from(await b.open(ctx, sealed)).toString(), '{"k":1}');
  const other = checkpointSealerFromSecret(secret + 'x', 'secretsmanager:loop/brain/staging/checkpoint-key:v1');
  await assert.rejects(other.open(ctx, sealed));
  assert.throws(() => checkpointSealerFromSecret('short', 'k'));
  assert.ok(a instanceof AesGcmBrainPayloadSealer);
});

test('a log line carries identifiers and codes only', () => {
  const log = memoryLogger({ component: 'worker' });
  log.info('worker.step_started', { jobId: 'j1', stepKey: 'context.load', ...({ prompt: 'SECRET PROMPT', apiKey: 'sk-live-x', content: 'x' } as object) });
  log.warn('Not An Event!', { outcome: 'X', durationMs: Number.NaN });
  log.metric('WorkerOutcome', 1, { outcome: 'FAILED' });
  log.metric('bad name!', 1);
  const text = JSON.stringify(log.lines);
  assert.doesNotMatch(text, /SECRET PROMPT|sk-live|"content"/);
  assert.equal(log.lines[0]!.droppedFields, 3);
  assert.equal(log.lines[1]!.event, 'invalid.event');
  assert.equal(log.lines[2]!.Component, 'worker');
  assert.equal(log.lines.length, 3, 'an invalid metric name writes nothing');
});

test('fence: the runtime names no provider, reads no environment and uses no cloud SDK', () => {
  const dir = join(__dirname, '..', 'src');
  for (const file of readdirSync(dir)) {
    const src = readFileSync(join(dir, file), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(src, /@emgloop\/providers|@anthropic-ai|from ['"]openai|api\.anthropic\.com|api\.openai\.com|sdk-clients/i, `${file} names a provider`);
    assert.doesNotMatch(src, /process\.env/, `${file} reads the environment`);
    assert.doesNotMatch(src, /@aws-sdk|aws-lambda/, `${file} binds to a cloud SDK`);
    assert.doesNotMatch(src, /from ['"]@emgloop\/database['"]/, `${file} imports the database barrel (and its singleton client)`);
  }
  const loop = readFileSync(join(dir, 'loop-client.ts'), 'utf8');
  const others = readdirSync(dir).filter((f) => f !== 'loop-client.ts').map((f) => readFileSync(join(dir, f), 'utf8'));
  assert.match(loop, /doFetch\(/);
  for (const src of others) assert.doesNotMatch(src.replace(/^\s*\/\/.*$/gm, ''), /\bfetch\(/, 'only the Loop client makes network calls');
});

void memoryQueues;
