// The Loop-side Brain boundary on the web tier. Slice B5.
//
// WHAT THESE PROVE
//
// TOKENS ARE NARROW. ES256 only, pinned keys only, the JOSE signature form only; `none`,
// another algorithm, an unknown key id, a tampered payload or an oversized token is
// refused before any trust is extended.
//
// THE DOORBELL IS A NUDGE. It rings only when fully configured, carries the command id
// and nothing else, signs exactly the claims the receiver checks (`brainDoorbellCheck`),
// lives sixty seconds, never throws, and never waits for anything that matters.
//
// A WORKER IS TRUSTED ONLY FOR ONE JOB, ONE PURPOSE, ONE BODY. With no trust configured
// every request is refused; with it, the token must verify, name the job Loop loads, match
// the body's hash, the route's purpose and the job's state.
//
// OFF BY DEFAULT, NO CREDENTIAL NEEDED. The AI floor this tier contributes reads no
// provider key, and the environment reader is the only file that reads the Brain names.
//
// NO VALUE HERE IS A REAL KEY. Every key pair is generated for the test and discarded.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  BRAIN_DOORBELL_AUDIENCE,
  BRAIN_WORKER_AUDIENCE,
  brainDoorbellCheck,
  type BrainJobSnapshot,
} from '@emgloop/shared';

import { readAiControlFloor } from '../src/ai/ai-environment';
import { BRAIN_ENVIRONMENT, brainBoundaryConfiguration, readBrainDoorbell, readBrainWorkerTrust } from '../src/brain/brain-environment';
import { BRAIN_RING_LIFETIME_SECONDS, brainRingToken, ringBrainDoorbell } from '../src/brain/doorbell';
import { JwsKeyError, es256PrivateKey, es256PublicKey, signEs256, verifyEs256 } from '../src/brain/jws';
import { BRAIN_WORKER_MAX_BODY_BYTES, authenticateBrainWorkerRequest } from '../src/brain/worker-request';

const WEB = resolve(__dirname, '..');
const SRC = join(WEB, 'src');

function pair(curve = 'prime256v1') {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: curve });
  return {
    privateKey,
    publicKey,
    privatePem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  };
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

describe('ES256 tokens: pinned keys, one algorithm, nothing else', () => {
  const k = pair();
  const keys = new Map<string, KeyObject>([['k1', k.publicKey]]);

  it('a token signed with a pinned key verifies and returns its payload', () => {
    const token = signEs256('k1', { sub: 'worker', n: 1 }, k.privateKey);
    const out = verifyEs256(token, keys);
    assert.deepEqual(out, { ok: true, kid: 'k1', payload: { sub: 'worker', n: 1 } });
    assert.equal(Buffer.from(token.split('.')[2]!, 'base64url').length, 64, 'JOSE R||S, not DER');
  });

  it('anything else is refused before it is trusted', () => {
    const token = signEs256('k1', { sub: 'worker' }, k.privateKey);
    const [h, p, s] = token.split('.') as [string, string, string];
    assert.deepEqual(verifyEs256(`${h}.${b64({ sub: 'admin' })}.${s}`, keys), { ok: false, refusal: 'BAD_SIGNATURE' }, 'tampered payload');
    assert.deepEqual(verifyEs256(`${b64({ alg: 'none', kid: 'k1' })}.${p}.${s}`, keys), { ok: false, refusal: 'WRONG_ALGORITHM' });
    assert.deepEqual(verifyEs256(`${b64({ alg: 'HS256', kid: 'k1' })}.${p}.${s}`, keys), { ok: false, refusal: 'WRONG_ALGORITHM' });
    assert.deepEqual(verifyEs256(`${b64({ alg: 'ES256', kid: 'k1', crit: ['x'] })}.${p}.${s}`, keys), { ok: false, refusal: 'WRONG_ALGORITHM' });
    assert.deepEqual(verifyEs256(`${b64({ alg: 'ES256', kid: 'k2' })}.${p}.${s}`, keys), { ok: false, refusal: 'UNKNOWN_KEY' });
    assert.deepEqual(verifyEs256(`${b64({ alg: 'ES256' })}.${p}.${s}`, keys), { ok: false, refusal: 'UNKNOWN_KEY' });
    const other = pair();
    assert.deepEqual(verifyEs256(signEs256('k1', { sub: 'worker' }, other.privateKey), keys), { ok: false, refusal: 'BAD_SIGNATURE' }, 'right kid, wrong key');
    for (const bad of ['', 'a.b', 'a.b.c.d', `${h}.${p}.`, `${h}.${p}.${s}=`, 'x'.repeat(5000)]) {
      assert.equal(verifyEs256(bad, keys).ok, false, bad.slice(0, 20));
    }
    assert.deepEqual(verifyEs256(`${h}.${p}.${Buffer.alloc(70).toString('base64url')}`, keys), { ok: false, refusal: 'BAD_SIGNATURE' });
  });

  it('only P-256 keys are accepted, and a refused key is never echoed', () => {
    assert.ok(es256PrivateKey(k.privatePem));
    assert.ok(es256PublicKey(k.publicPem));
    const p384 = pair('secp384r1');
    assert.throws(() => es256PrivateKey(p384.privatePem), JwsKeyError);
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    assert.throws(() => es256PublicKey(rsa.publicKey.export({ format: 'pem', type: 'spki' }).toString()), JwsKeyError);
    assert.throws(() => es256PublicKey(k.privatePem), JwsKeyError, 'a private key is not a pinned public key');
    try {
      // A PEM-shaped value that is not a key, built so no scanner mistakes it for one.
      const label = ['PRIVATE', 'KEY'].join(' ');
      es256PrivateKey(`-----BEGIN ${label}-----\nnot-a-key-SECRET-MATERIAL\n-----END ${label}-----`);
      assert.fail('should throw');
    } catch (err) {
      assert.doesNotMatch(String((err as Error).message), /SECRET-MATERIAL/);
    }
    assert.throws(() => signEs256('bad kid!', {}, k.privateKey), JwsKeyError);
  });
});

function doorbellEnv(k = pair()): Record<string, string> {
  return {
    [BRAIN_ENVIRONMENT.doorbellUrl]: 'https://doorbell.example.test/v1/doorbell',
    [BRAIN_ENVIRONMENT.doorbellIssuer]: 'loop-web-test',
    [BRAIN_ENVIRONMENT.doorbellSubject]: 'deployment-test',
    [BRAIN_ENVIRONMENT.doorbellKeyId]: 'ring-1',
    // Netlify holds PEM on one line with escaped newlines.
    [BRAIN_ENVIRONMENT.doorbellSigningKey]: k.privatePem.replace(/\n/g, '\\n'),
  };
}

describe('The Brain environment is off until it is completely and correctly configured', () => {
  it('nothing set is NOT_CONFIGURED; anything half-set or malformed is INVALID', () => {
    assert.deepEqual(brainBoundaryConfiguration({}), { doorbell: 'NOT_CONFIGURED', workerTrust: 'NOT_CONFIGURED' });
    const full = doorbellEnv();
    assert.equal(readBrainDoorbell(full).state, 'CONFIGURED');
    for (const name of Object.keys(full)) {
      assert.equal(readBrainDoorbell({ ...full, [name]: '' }).state, 'INVALID', `${name} empty`);
      const { [name]: _unset, ...partial } = full;
      assert.equal(readBrainDoorbell(partial).state, 'INVALID', `${name} unset`);
    }
    assert.equal(readBrainDoorbell({ ...full, [BRAIN_ENVIRONMENT.doorbellUrl]: 'http://doorbell.example.test/' }).state, 'INVALID', 'https only');
    assert.equal(readBrainDoorbell({ ...full, [BRAIN_ENVIRONMENT.doorbellUrl]: 'https://user:pass@doorbell.example.test/' }).state, 'INVALID');
    assert.equal(readBrainDoorbell({ ...full, [BRAIN_ENVIRONMENT.doorbellSigningKey]: 'not a key' }).state, 'INVALID');
    assert.equal(readBrainDoorbell({ ...full, [BRAIN_ENVIRONMENT.doorbellKeyId]: 'has space' }).state, 'INVALID');

    const k = pair();
    const trust = {
      [BRAIN_ENVIRONMENT.workerIssuers]: 'loop-brain-worker-test',
      [BRAIN_ENVIRONMENT.workerSubjects]: 'worker-a, worker-b',
      [BRAIN_ENVIRONMENT.workerPublicKeys]: JSON.stringify({ w1: k.publicPem }),
    };
    const read = readBrainWorkerTrust(trust);
    assert.equal(read.state, 'CONFIGURED');
    assert.deepEqual(read.state === 'CONFIGURED' && read.subjects, ['worker-a', 'worker-b']);
    assert.equal(readBrainWorkerTrust({ ...trust, [BRAIN_ENVIRONMENT.workerPublicKeys]: '{"w1":"nope"}' }).state, 'INVALID');
    assert.equal(readBrainWorkerTrust({ ...trust, [BRAIN_ENVIRONMENT.workerPublicKeys]: '[]' }).state, 'INVALID');
    assert.equal(readBrainWorkerTrust({ ...trust, [BRAIN_ENVIRONMENT.workerPublicKeys]: '{}' }).state, 'INVALID');
    assert.equal(readBrainWorkerTrust({ ...trust, [BRAIN_ENVIRONMENT.workerSubjects]: '' }).state, 'INVALID');
    assert.equal(readBrainWorkerTrust({ ...trust, [BRAIN_ENVIRONMENT.workerPublicKeys]: JSON.stringify({ w1: pair().privatePem }) }).state, 'INVALID', 'a private key is never pinned');
  });

  it('what an operator sees never contains a key', () => {
    const env = doorbellEnv();
    const shown = JSON.stringify(brainBoundaryConfiguration(env));
    assert.doesNotMatch(shown, /PRIVATE KEY|BEGIN/);
  });

  it('the AI floor this tier contributes needs no provider credential and is off by default', () => {
    assert.deepEqual(readAiControlFloor({}), { activation: { enabled: false, organizations: [], tasks: [], providers: [] }, killSwitches: [] });
    const floor = readAiControlFloor({
      LOOP_AI_ENABLED: 'true',
      LOOP_AI_ORGANIZATIONS: 'org_a',
      LOOP_AI_TASKS: 'case.explanation',
      LOOP_AI_PROVIDERS: 'anthropic,openai',
      // No longer read (G2 is a recorded provider policy since 2026-09-24): it narrows nothing.
      LOOP_AI_PROVIDER_TERMS_CONFIRMED: 'anthropic',
      LOOP_AI_KILL_SWITCHES: 'MODEL:m-1',
    });
    assert.deepEqual(floor.activation, { enabled: true, organizations: ['org_a'], tasks: ['case.explanation'], providers: ['anthropic', 'openai'] }, 'listed; no key needed (G2 is a recorded provider policy, not this floor)');
    assert.deepEqual(floor.killSwitches, [{ scope: 'MODEL', value: 'm-1' }]);
    assert.equal(readAiControlFloor({ LOOP_AI_ENABLED: 'TRUE' }).activation.enabled, false, 'exactly "true"');
    assert.deepEqual(readAiControlFloor({ LOOP_AI_KILL_SWITCHES: 'garbage entry' }).killSwitches, [{ scope: 'GLOBAL' }]);
  });
});

describe('The doorbell carries a command id, nothing else, and never blocks work', () => {
  it('rings only when configured, with exactly the claims the receiver checks', async () => {
    const k = pair();
    const config = readBrainDoorbell(doorbellEnv(k));
    assert.equal(config.state, 'CONFIGURED');
    const sent: { url: string; init: RequestInit }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      sent.push({ url, init });
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch;
    const now = 1_800_000_000;
    assert.equal(await ringBrainDoorbell('cmd_00000001', { config, fetch: fakeFetch, nowSeconds: () => now }), 'RUNG');
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.url, 'https://doorbell.example.test/v1/doorbell');
    assert.equal(sent[0]!.init.method, 'POST');
    assert.equal(sent[0]!.init.redirect, 'error');
    assert.deepEqual(JSON.parse(String(sent[0]!.init.body)), { commandId: 'cmd_00000001' }, 'the body names one stored command');
    const auth = (sent[0]!.init.headers as Record<string, string>).authorization!;
    const token = auth.replace(/^Bearer /, '');
    const verified = verifyEs256(token, new Map([['ring-1', k.publicKey]]));
    assert.equal(verified.ok, true);
    const claims = verified.ok ? verified.payload : {};
    assert.deepEqual(Object.keys(claims).sort(), ['aud', 'exp', 'iat', 'iss', 'jti', 'scope', 'sub']);
    assert.equal(claims.aud, BRAIN_DOORBELL_AUDIENCE);
    assert.equal((claims.exp as number) - (claims.iat as number), BRAIN_RING_LIFETIME_SECONDS);
    const check = brainDoorbellCheck(claims as never, { commandId: 'cmd_00000001' }, {
      nowSeconds: now,
      trustedIssuers: ['loop-web-test'],
      trustedCallers: ['deployment-test'],
    });
    assert.deepEqual(check, { ok: true, caller: { kind: 'DEPLOYMENT', subject: 'deployment-test', tokenId: claims.jti }, commandId: 'cmd_00000001' });
    // Every ring is a new token, so the receiver's replay ledger can tell them apart.
    const a = brainRingToken(config as never, now);
    const b = brainRingToken(config as never, now);
    const jti = (t: string) => {
      const v = verifyEs256(t, new Map([['ring-1', k.publicKey]]));
      assert.ok(v.ok);
      return v.payload.jti;
    };
    assert.notEqual(jti(a), jti(b));
  });

  it('not configured, bad id, refused, unreachable or slow: nothing throws and nothing else happens', async () => {
    let calls = 0;
    const counting = (async () => {
      calls += 1;
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch;
    assert.equal(await ringBrainDoorbell('cmd_00000001', { config: { state: 'NOT_CONFIGURED' }, fetch: counting }), 'NOT_CONFIGURED');
    assert.equal(await ringBrainDoorbell('cmd_00000001', { config: { state: 'INVALID' }, fetch: counting }), 'NOT_CONFIGURED');
    const config = readBrainDoorbell(doorbellEnv());
    assert.equal(await ringBrainDoorbell('bad id', { config, fetch: counting }), 'FAILED');
    assert.equal(calls, 0, 'nothing was sent');
    const refused = (async () => new Response(null, { status: 401 })) as unknown as typeof fetch;
    assert.equal(await ringBrainDoorbell('cmd_00000001', { config, fetch: refused }), 'FAILED');
    const broken = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    assert.equal(await ringBrainDoorbell('cmd_00000001', { config, fetch: broken }), 'FAILED');
    const hanging = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as typeof fetch;
    const started = Date.now();
    assert.equal(await ringBrainDoorbell('cmd_00000001', { config, fetch: hanging }), 'FAILED');
    assert.ok(Date.now() - started < 5000, 'a slow doorbell is abandoned, not waited on');
  });
});

function job(over: Partial<BrainJobSnapshot> = {}): BrainJobSnapshot {
  return {
    jobId: 'cjob00000000000000000001',
    generation: 1,
    organizationId: 'org_a',
    principalUserId: 'user_1',
    taskId: 'case.explanation',
    taskVersion: '2.0.0',
    capabilityRoute: 'TECHNICAL_ANALYSIS',
    resultType: 'ANALYSIS',
    resultOwner: { authority: 'COMMERCIAL_INTELLIGENCE', subjectType: 'CASE' },
    subject: { type: 'CASE', id: 'case_1' },
    executionClass: 'INTERACTIVE',
    promoted: false,
    state: 'RUNNING',
    cancelRequest: null,
    wait: null,
    resultRefs: [],
    endReason: null,
    resumesJobId: null,
    ...over,
  };
}

describe('A worker request is trusted for one job, one purpose and one body', () => {
  const k = pair();
  const trust = readBrainWorkerTrust({
    [BRAIN_ENVIRONMENT.workerIssuers]: 'loop-brain-worker-test',
    [BRAIN_ENVIRONMENT.workerSubjects]: 'worker-a',
    [BRAIN_ENVIRONMENT.workerPublicKeys]: JSON.stringify({ w1: k.publicPem }),
  });
  const NOW = 1_800_000_000;
  const body = JSON.stringify({ stepKey: 'commit.result' });
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');
  const claims = (over: Record<string, unknown> = {}) => ({
    iss: 'loop-brain-worker-test',
    aud: BRAIN_WORKER_AUDIENCE,
    sub: 'worker-a',
    jti: 'tok-1',
    iat: NOW - 5,
    exp: NOW + 55,
    jobId: 'cjob00000000000000000001',
    generation: 1,
    purpose: 'CONTEXT',
    bodySha256: sha(body),
    ...over,
  });
  const request = (token: string, text = body, headers: Record<string, string> = {}) =>
    new Request('https://loop.example.test/api/internal/brain/context', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
      body: text,
    });
  const loads: string[] = [];
  const deps = (found: BrainJobSnapshot | null = job()) => ({
    trust,
    nowSeconds: () => NOW,
    loadJob: async (id: string) => {
      loads.push(id);
      return found && found.jobId === id ? found : null;
    },
  });
  const sign = (over: Record<string, unknown> = {}) => signEs256('w1', claims(over), k.privateKey);

  it('with no trust configured, every request is refused before anything is read', async () => {
    loads.length = 0;
    const out = await authenticateBrainWorkerRequest(request(sign()), 'CONTEXT', { ...deps(), trust: { state: 'NOT_CONFIGURED' } });
    assert.deepEqual(out, { ok: false, status: 401, refusals: ['UNAUTHENTICATED'] });
    assert.deepEqual(loads, [], 'no job was looked up');
  });

  it('a valid request yields the job Loop loaded, and nothing from the request decides who it is for', async () => {
    const out = await authenticateBrainWorkerRequest(request(sign({ organizationId: 'org_b', principalUserId: 'user_9' })), 'CONTEXT', deps());
    assert.equal(out.ok, true);
    assert.equal(out.ok && out.job.organizationId, 'org_a');
    assert.equal(out.ok && out.job.principalUserId, 'user_1');
    assert.deepEqual(out.ok && out.body, { stepKey: 'commit.result' });
    assert.equal(out.ok && out.worker, 'worker-a');
  });

  it('a token that does not verify learns nothing about any job', async () => {
    loads.length = 0;
    const stranger = pair();
    for (const token of ['', 'garbage', signEs256('w1', claims(), stranger.privateKey), signEs256('w9', claims(), k.privateKey)]) {
      const out = await authenticateBrainWorkerRequest(request(token), 'CONTEXT', deps());
      assert.deepEqual(out, { ok: false, status: 401, refusals: ['UNAUTHENTICATED'] });
    }
    const noBearer = new Request('https://loop.example.test/x', { method: 'POST', headers: { authorization: sign() }, body });
    assert.equal((await authenticateBrainWorkerRequest(noBearer, 'CONTEXT', deps())).ok, false);
    const malformedClaims = signEs256('w1', { ...claims(), generation: '1' }, k.privateKey);
    assert.deepEqual(await authenticateBrainWorkerRequest(request(malformedClaims), 'CONTEXT', deps()), { ok: false, status: 401, refusals: ['UNAUTHENTICATED'] });
    assert.deepEqual(loads, []);
  });

  it('the token binds the purpose, the body, the audience, the time, the job, its generation and its state', async () => {
    const refusal = async (token: string, purpose: 'CONTEXT' | 'COMMIT_RESULT' | 'ACCESS_DECISION' = 'CONTEXT', found: BrainJobSnapshot | null = job(), text = body) => {
      const out = await authenticateBrainWorkerRequest(request(token, text), purpose, deps(found));
      return out.ok ? 'OK' : `${out.status}:${out.refusals.join(',')}`;
    };
    assert.equal(await refusal(sign(), 'COMMIT_RESULT'), '403:PURPOSE_MISMATCH');
    assert.equal(await refusal(sign(), 'CONTEXT', job(), JSON.stringify({ stepKey: 'other.step' })), '403:BODY_MISMATCH', 'a different body than the one signed');
    assert.equal(await refusal(sign({ aud: 'loop-brain-doorbell' })), '403:WRONG_AUDIENCE', 'a ring token is not a worker token');
    assert.equal(await refusal(sign({ iss: 'someone-else' })), '403:ISSUER_NOT_TRUSTED');
    assert.equal(await refusal(sign({ sub: 'worker-z' })), '403:CALLER_NOT_TRUSTED');
    assert.equal(await refusal(sign({ iat: NOW - 200, exp: NOW - 100 })), '403:EXPIRED');
    assert.equal(await refusal(sign({ iat: NOW - 10, exp: NOW + 600 })), '403:LIFETIME_TOO_LONG');
    assert.equal(await refusal(sign({ jobId: 'cjob00000000000000000099' })), '403:JOB_NOT_FOUND');
    assert.equal(await refusal(sign(), 'CONTEXT', null), '403:JOB_NOT_FOUND');
    assert.equal(await refusal(sign({ generation: 2 })), '403:GENERATION_MISMATCH');
    assert.equal(await refusal(sign(), 'CONTEXT', job({ state: 'WAITING_FOR_USER' })), '403:JOB_STATE_REFUSES_PURPOSE');
    assert.equal(await refusal(sign({ purpose: 'ACCESS_DECISION' }), 'ACCESS_DECISION', job({ state: 'WAITING_FOR_USER' })), 'OK', 'access may be re-decided while waiting');
    assert.equal(await refusal(sign({ bodySha256: sha('{nope') }), 'CONTEXT', job(), '{nope'), '400:MALFORMED_BODY', 'a signed body that is not JSON');
    const big = 'x'.repeat(BRAIN_WORKER_MAX_BODY_BYTES + 1);
    assert.equal(await refusal(sign({ bodySha256: sha(big) }), 'CONTEXT', job(), big), '413:BODY_TOO_LARGE');
  });
});

// --- Fences -------------------------------------------------------------------------------

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (['node_modules', '.next'].includes(f)) return [];
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
  });
}

const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('Fences: the Brain boundary stays narrow', () => {
  const files = walk(SRC);

  it('only the Brain environment module reads the Brain variables, and none is public', () => {
    const readers = files.filter((f) => /LOOP_BRAIN_/.test(code(readFileSync(f, 'utf8')))).map((f) => relative(SRC, f));
    assert.deepEqual(readers, ['brain/brain-environment.ts']);
    for (const f of files) assert.doesNotMatch(readFileSync(f, 'utf8'), /NEXT_PUBLIC_LOOP_BRAIN/, relative(SRC, f));
  });

  it('every Brain module is server-only, names no provider, and needs no cloud credential', () => {
    for (const f of walk(join(SRC, 'brain'))) {
      const src = readFileSync(f, 'utf8');
      const rel = relative(SRC, f);
      if (rel === 'brain/actions.ts') assert.match(src.trimStart(), /^'use server';/);
      else assert.match(src.replace(/^(\/\/.*\n|\s*\n)*/, ''), /^import 'server-only';/, rel);
      const body = code(src);
      assert.doesNotMatch(body, /['"`](anthropic|openai)['"`]|claude-|gpt-|@anthropic-ai|from ['"]openai/i, `${rel} names no provider`);
      assert.doesNotMatch(body, /aws-sdk|@aws-sdk|AWS_ACCESS_KEY|AWS_SECRET|AWS_SESSION_TOKEN/, `${rel} needs no cloud credential`);
      assert.doesNotMatch(body, /ANTHROPIC_API_KEY|OPENAI_API_KEY/, `${rel} reads no provider credential`);
    }
  });

  it('each person-facing Brain entry point resolves the signed session before anything else', () => {
    const actions = readFileSync(join(SRC, 'brain', 'actions.ts'), 'utf8');
    for (const fn of ['submitBrainWorkAction', 'respondToBrainQuestionAction', 'cancelBrainWorkAction']) {
      const bodyStart = actions.indexOf(`export async function ${fn}`);
      const firstAwait = actions.indexOf('await ', bodyStart);
      assert.equal(actions.slice(firstAwait, firstAwait + 'await getSession()'.length), 'await getSession()', fn);
    }
    assert.doesNotMatch(code(actions), /organizationId:\s*(submission|reply|waitId|jobId)|formData/, 'no organization from the request');
    for (const route of ['app/api/brain/work/route.ts', 'app/api/brain/work/[jobId]/route.ts', 'app/api/brain/questions/[waitId]/route.ts']) {
      const src = code(readFileSync(join(SRC, route), 'utf8'));
      const fnStart = src.indexOf('export async function GET');
      assert.equal(src.slice(src.indexOf('await ', fnStart), src.indexOf('await ', fnStart) + 'await getSession()'.length), 'await getSession()', route);
      assert.doesNotMatch(src, /searchParams|request\.json|organizationId:\s*params/, `${route} takes nothing but an id from the request`);
    }
  });

  it('each internal Brain route authenticates the worker first, and never trusts a session', () => {
    for (const [route, purpose] of [
      ['app/api/internal/brain/access/route.ts', 'ACCESS_DECISION'],
      ['app/api/internal/brain/context/route.ts', 'CONTEXT'],
      ['app/api/internal/brain/commit/route.ts', 'COMMIT_RESULT'],
    ] as const) {
      const src = code(readFileSync(join(SRC, route), 'utf8'));
      const fnStart = src.indexOf('export async function POST');
      const first = src.indexOf('await ', fnStart);
      assert.equal(src.slice(first, first + 'await authenticateBrainWorkerRequest('.length), 'await authenticateBrainWorkerRequest(', route);
      assert.match(src, new RegExp(`authenticateBrainWorkerRequest\\(request, '${purpose}'`), `${route} states its purpose`);
      assert.doesNotMatch(src, /getSession|cookies\(|organizationId/, `${route} is not a user endpoint`);
      assert.doesNotMatch(src, /export async function (GET|PUT|PATCH|DELETE)/, `${route} answers POST only`);
    }
  });
});
