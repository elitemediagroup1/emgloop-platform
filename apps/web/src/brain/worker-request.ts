// Authenticating an execution-environment worker's request to Loop. Slice B5.
//
// Architecture: brain-execution-infrastructure.md §5.3, and `brainWorkerRequestCheck`.
//
// THE TOKEN PROVES A WORKER; THE JOB PROVES EVERYTHING ELSE. A request carries a short
// ES256 token signed by a key only the execution environment holds (a non-exportable
// key-service key in B6), verified here against public keys this deployment pinned. The
// token binds the request to one job, one generation, one purpose and the SHA-256 of the
// exact body sent. Loop then loads THAT job, and the job -- never the request -- names
// the organization and the principal every answer is decided for.
//
// FAILS CLOSED, SAYS LITTLE. With no worker trust configured (every deployment today)
// every request is refused. A request whose signature does not verify learns nothing
// about jobs; one that does is told which rule it broke, because only a worker holding a
// pinned key can get that far.
//
// NO SESSION, NO COOKIE, NO ORGANIZATION IN THE REQUEST. This is not a user endpoint.

import 'server-only';

import { createHash } from 'crypto';
import type { BrainJobSnapshot, BrainWorkerClaims, BrainWorkerPurpose, BrainWorkerRequestRefusal } from '@emgloop/shared';
import { brainWorkerRequestCheck } from '@emgloop/shared';

import { readBrainWorkerTrust, type BrainWorkerTrust } from './brain-environment';
import { verifyEs256 } from './jws';

export const BRAIN_WORKER_MAX_BODY_BYTES = 256 * 1024;

export type BrainWorkerAuthentication =
  | { readonly ok: true; readonly job: BrainJobSnapshot; readonly body: unknown; readonly worker: string; readonly tokenId: string }
  | { readonly ok: false; readonly status: 400 | 401 | 403 | 413; readonly refusals: readonly (BrainWorkerRequestRefusal | 'UNAUTHENTICATED' | 'MALFORMED_BODY' | 'BODY_TOO_LARGE')[] };

export interface BrainWorkerAuthDeps {
  readonly trust?: BrainWorkerTrust;
  /** Loads a job by id, from Loop's records, in whatever organization it belongs to. */
  readonly loadJob: (jobId: string) => Promise<BrainJobSnapshot | null>;
  readonly nowSeconds?: () => number;
}

const ID = /^[A-Za-z0-9_-]{8,128}$/;

function claimsOf(payload: Readonly<Record<string, unknown>>): BrainWorkerClaims | null {
  const p = payload;
  const aud = p.aud;
  if (
    typeof p.iss !== 'string' ||
    typeof p.sub !== 'string' ||
    typeof p.jti !== 'string' ||
    typeof p.iat !== 'number' ||
    typeof p.exp !== 'number' ||
    typeof p.jobId !== 'string' ||
    !ID.test(p.jobId) ||
    !Number.isInteger(p.generation) ||
    typeof p.purpose !== 'string' ||
    typeof p.bodySha256 !== 'string' ||
    !(typeof aud === 'string' || (Array.isArray(aud) && aud.every((a) => typeof a === 'string')))
  ) {
    return null;
  }
  return {
    iss: p.iss,
    aud: aud as string | readonly string[],
    sub: p.sub,
    jti: p.jti,
    iat: p.iat,
    exp: p.exp,
    jobId: p.jobId,
    generation: p.generation as number,
    purpose: p.purpose,
    bodySha256: p.bodySha256,
  };
}

async function readBody(request: Request): Promise<Buffer | null> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > BRAIN_WORKER_MAX_BODY_BYTES) return null;
  const buffer = Buffer.from(await request.arrayBuffer());
  return buffer.byteLength > BRAIN_WORKER_MAX_BODY_BYTES ? null : buffer;
}

/** Authenticate one worker request for one purpose. */
export async function authenticateBrainWorkerRequest(
  request: Request,
  purpose: BrainWorkerPurpose,
  deps: BrainWorkerAuthDeps,
): Promise<BrainWorkerAuthentication> {
  const trust = deps.trust ?? readBrainWorkerTrust();
  if (trust.state !== 'CONFIGURED') return { ok: false, status: 401, refusals: ['UNAUTHENTICATED'] };
  const header = request.headers.get('authorization') ?? '';
  const token = /^Bearer\s+(\S+)$/i.exec(header)?.[1] ?? '';
  const verified = verifyEs256(token, trust.keys);
  if (!verified.ok) return { ok: false, status: 401, refusals: ['UNAUTHENTICATED'] };
  const claims = claimsOf(verified.payload);
  if (!claims) return { ok: false, status: 401, refusals: ['UNAUTHENTICATED'] };

  const bytes = await readBody(request);
  if (!bytes) return { ok: false, status: 413, refusals: ['BODY_TOO_LARGE'] };
  const bodySha256 = createHash('sha256').update(bytes).digest('hex');

  const job = await deps.loadJob(claims.jobId);
  const nowSeconds = deps.nowSeconds ? deps.nowSeconds() : Math.floor(Date.now() / 1000);
  const check = brainWorkerRequestCheck(claims, { purpose, bodySha256 }, job, {
    nowSeconds,
    trustedIssuers: trust.issuers,
    trustedWorkers: trust.subjects,
  });
  if (!check.ok) return { ok: false, status: 403, refusals: check.refusals };

  let body: unknown;
  try {
    body = bytes.byteLength === 0 ? {} : JSON.parse(bytes.toString('utf8'));
  } catch {
    return { ok: false, status: 400, refusals: ['MALFORMED_BODY'] };
  }
  return { ok: true, job: job!, body, worker: check.worker, tokenId: check.tokenId };
}
