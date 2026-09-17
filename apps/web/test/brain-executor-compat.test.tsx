// The two ends of the Brain trust boundary agree. Slice B6.
//
// Loop's web tier (apps/web/src/brain) and the execution runtime (apps/brain-executor)
// each implement the ES256 token format on their own side. These tests use the real
// code from both: a ring signed here is admitted by the runtime's authorizer, and a
// worker token signed by the runtime -- through a key-service stand-in that returns DER,
// as the real one does -- is admitted by this tier's worker authentication.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import type { BrainJobSnapshot } from '@emgloop/shared';
import { authorizeRing, createLoopClient, memoryLogger } from '@emgloop/brain-executor';

import { readBrainDoorbell, readBrainWorkerTrust, BRAIN_ENVIRONMENT } from '../src/brain/brain-environment';
import { brainRingToken } from '../src/brain/doorbell';
import { authenticateBrainWorkerRequest } from '../src/brain/worker-request';

const NOW = 1_800_000_000;

describe('Loop and the execution runtime accept each other’s tokens, and nothing else', () => {
  it('a ring signed by Loop is admitted once by the runtime’s authorizer', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const config = readBrainDoorbell({
      [BRAIN_ENVIRONMENT.doorbellUrl]: 'https://doorbell.example.test/v1/doorbell',
      [BRAIN_ENVIRONMENT.doorbellIssuer]: 'loop-web-production',
      [BRAIN_ENVIRONMENT.doorbellSubject]: 'netlify-emgloop2',
      [BRAIN_ENVIRONMENT.doorbellKeyId]: 'doorbell-2026-1',
      [BRAIN_ENVIRONMENT.doorbellSigningKey]: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    });
    assert.equal(config.state, 'CONFIGURED');
    if (config.state !== 'CONFIGURED') return;
    const token = brainRingToken(config, NOW);
    const seen = new Set<string>();
    const deps = {
      trust: { keys: new Map([['doorbell-2026-1', publicKey]]), trustedIssuers: ['loop-web-production'], trustedCallers: ['netlify-emgloop2'] },
      replay: { recordOnce: async (id: string) => (seen.has(id) ? false : (seen.add(id), true)) },
      nowSeconds: NOW,
      log: memoryLogger(),
    };
    const first = await authorizeRing(`Bearer ${token}`, deps);
    assert.equal(first.authorized, true);
    assert.deepEqual(await authorizeRing(`Bearer ${token}`, deps), { authorized: false, refusal: 'REPLAYED' });
    const wrongKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey;
    assert.deepEqual(await authorizeRing(`Bearer ${brainRingToken(config, NOW)}`, { ...deps, trust: { ...deps.trust, keys: new Map([['doorbell-2026-1', wrongKey]]) } }), {
      authorized: false,
      refusal: 'UNVERIFIED',
    });
  });

  it('a worker token signed by the runtime (DER from the key service) is admitted by Loop for exactly its job and body', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const trust = readBrainWorkerTrust({
      [BRAIN_ENVIRONMENT.workerIssuers]: 'loop-brain-staging',
      [BRAIN_ENVIRONMENT.workerSubjects]: 'worker-interactive,worker-durable',
      [BRAIN_ENVIRONMENT.workerPublicKeys]: JSON.stringify({ 'worker-2026-1': publicKey.export({ format: 'pem', type: 'spki' }).toString() }),
    });
    assert.equal(trust.state, 'CONFIGURED');
    const job: BrainJobSnapshot = {
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
    };
    const signer = {
      keyId: 'worker-2026-1',
      sign: async (input: Uint8Array) => new Uint8Array(nodeSign('sha256', input, { key: privateKey, dsaEncoding: 'der' })),
    };
    const outcomes: string[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      const request = new Request(url, { method: 'POST', headers: init.headers as Record<string, string>, body: init.body as BodyInit });
      const purpose = url.endsWith('/context') ? 'CONTEXT' : url.endsWith('/access') ? 'ACCESS_DECISION' : 'COMMIT_RESULT';
      const auth = await authenticateBrainWorkerRequest(request, purpose, { trust, loadJob: async (id) => (id === job.jobId ? job : null), nowSeconds: () => NOW });
      outcomes.push(auth.ok ? `ok:${purpose}` : `${auth.status}:${auth.refusals.join(',')}`);
      return new Response(JSON.stringify(auth.ok ? { ok: true, decision: { allowed: true }, principal: null } : { ok: false, refusals: auth.refusals }), {
        status: auth.ok ? 200 : auth.status,
      });
    }) as unknown as typeof fetch;
    const client = (subject: string) =>
      createLoopClient({ baseUrl: 'https://app.example.test', issuer: 'loop-brain-staging', subject }, { signer, fetch: fakeFetch, nowSeconds: () => NOW });
    assert.equal((await client('worker-durable').access({ jobId: job.jobId, generation: 1 })).ok, true);
    assert.equal((await client('worker-interactive').context({ jobId: job.jobId, generation: 1 })).ok, true);
    assert.equal((await client('worker-rogue').access({ jobId: job.jobId, generation: 1 })).ok, false);
    assert.equal((await client('worker-durable').access({ jobId: job.jobId, generation: 2 })).ok, false);
    assert.equal((await client('worker-durable').access({ jobId: 'cjob00000000000000000009', generation: 1 })).ok, false);
    assert.deepEqual(outcomes, ['ok:ACCESS_DECISION', 'ok:CONTEXT', '403:CALLER_NOT_TRUSTED', '403:GENERATION_MISMATCH', '403:JOB_NOT_FOUND']);

    // A token whose body was swapped in transit is refused.
    let tamper = true;
    const tamperingFetch = (async (url: string, init: RequestInit) => {
      const body: BodyInit = tamper ? '{"x":1}' : (init.body as BodyInit);
      tamper = false;
      return fakeFetch(url, { ...init, body });
    }) as unknown as typeof fetch;
    const tampered = await createLoopClient({ baseUrl: 'https://app.example.test', issuer: 'loop-brain-staging', subject: 'worker-durable' }, { signer, fetch: tamperingFetch, nowSeconds: () => NOW }).access({ jobId: job.jobId, generation: 1 });
    assert.equal(tampered.ok, false);
    assert.equal(outcomes.at(-1), '403:BODY_MISMATCH');
  });
});
