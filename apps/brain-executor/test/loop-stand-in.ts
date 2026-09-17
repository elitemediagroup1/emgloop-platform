// Loop's internal Brain API, in process, with the same checks as the web routes
// (apps/web/src/brain/worker-request.ts and app/api/internal/brain/*). The web suite's
// compatibility test proves the real routes accept the same tokens.

import { createHash, type KeyObject } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { brainWorkerRequestCheck, type BrainWorkerClaims, type BrainWorkerPurpose } from '@emgloop/shared';

import { BrainJobRepository } from '../../../packages/database/src/repositories/brain/brain-job.repository';
import { BrainExecutionReferences } from '../../../packages/database/src/repositories/brain/brain-execution-references';
import type { BrainInternalService } from '../../../packages/database/src/services/brain/brain-internal.service';

import { verifyEs256Jwt } from '../src/jws';

export const WORKER_ISSUER = 'loop-brain-test';
export const WORKER_SUBJECT = 'worker-durable';

const PURPOSES: Record<string, BrainWorkerPurpose> = {
  '/api/internal/brain/access': 'ACCESS_DECISION',
  '/api/internal/brain/context': 'CONTEXT',
  '/api/internal/brain/commit': 'COMMIT_RESULT',
};

export function loopStandIn(options: {
  readonly prisma: PrismaClient;
  readonly internal: BrainInternalService;
  readonly keys: ReadonlyMap<string, KeyObject>;
  readonly nowSeconds: () => number;
  readonly calls: { purpose: BrainWorkerPurpose; status: number }[];
  readonly isDown?: () => boolean;
}): typeof fetch {
  const refs = new BrainExecutionReferences(options.prisma);
  const jobs = new BrainJobRepository(options.prisma);
  return (async (url: string | URL, init: RequestInit = {}) => {
    const purpose = PURPOSES[new URL(String(url)).pathname];
    const respond = (status: number, body: unknown) => {
      if (purpose) options.calls.push({ purpose, status });
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    };
    if (options.isDown?.()) throw new Error('ECONNREFUSED');
    if (!purpose) return respond(404, { ok: false });
    const headers = init.headers as Record<string, string>;
    const verified = verifyEs256Jwt((headers.authorization ?? '').replace(/^Bearer /, ''), options.keys);
    if (!verified.ok) return respond(401, { ok: false, refusals: ['UNAUTHENTICATED'] });
    const bytes = Buffer.from(init.body as Uint8Array);
    const claims = verified.payload as unknown as BrainWorkerClaims;
    const located = await refs.locateJob(String(claims.jobId));
    const record = located ? await jobs.get(located.organizationId, located.jobId) : null;
    const check = brainWorkerRequestCheck(claims, { purpose, bodySha256: createHash('sha256').update(bytes).digest('hex') }, record?.job ?? null, {
      nowSeconds: options.nowSeconds(),
      trustedIssuers: [WORKER_ISSUER],
      trustedWorkers: [WORKER_SUBJECT],
    });
    if (!check.ok) return respond(403, { ok: false, refusals: check.refusals });
    const job = record!.job;
    if (purpose === 'ACCESS_DECISION') return respond(200, { ok: true, ...(await options.internal.access(job)) });
    if (purpose === 'CONTEXT') {
      const answer = await options.internal.context(job);
      if (!answer.ok) return respond(answer.refusal === 'NOT_PERMITTED' ? 403 : 409, { ok: false, refusals: [answer.refusal] });
      return respond(200, { ok: true, context: answer.context, decision: answer.access.decision, principal: answer.access.principal, commitGate: answer.commitGate });
    }
    const body = JSON.parse(bytes.toString('utf8')) as { stepKey: string; envelope: never };
    const answer = await options.internal.commit(job, body.stepKey, body.envelope);
    if (!answer.ok) return respond(answer.refusal === 'NOT_PERMITTED' ? 403 : 409, { ok: false, refusals: [answer.refusal, ...answer.details] });
    return respond(200, { ok: true, ref: answer.ref, commitKey: answer.commitKey });
  }) as unknown as typeof fetch;
}
