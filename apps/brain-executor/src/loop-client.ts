// The worker's three questions to Loop, signed for one job, one purpose and one body. Slice B6.
//
// Architecture: brain-execution-infrastructure.md §5.3; brain-boundary.md §6.2.
//
// Each call carries a fresh ES256 token that names this worker, the job and its
// generation, the purpose, and the SHA-256 of the exact bytes sent, and lives sixty
// seconds. Loop verifies it against the public key it pinned, loads the job the token
// names, and answers for that job alone. The worker never sends an organization, a
// principal or a role, and holds no key: the signer is the key service.

import { randomUUID } from 'node:crypto';
import {
  BRAIN_WORKER_AUDIENCE,
  type AiContentTrustLevel,
  type BrainAccessDecision,
  type BrainJobRef,
  type BrainPrincipalRecord,
  type BrainResultEnvelope,
  type BrainWorkerPurpose,
} from '@emgloop/shared';

import { sha256Hex, signEs256Jwt, type Es256Signer } from './jws';

export const BRAIN_WORKER_TOKEN_LIFETIME_SECONDS = 60;
export const BRAIN_LOOP_CALL_TIMEOUT_MS = 10_000;

const PATHS: Readonly<Record<BrainWorkerPurpose, string>> = Object.freeze({
  ACCESS_DECISION: '/api/internal/brain/access',
  CONTEXT: '/api/internal/brain/context',
  COMMIT_RESULT: '/api/internal/brain/commit',
});

export interface LoopClientConfig {
  readonly baseUrl: string;
  readonly issuer: string;
  readonly subject: string;
}

/** Why a call did not produce an answer, as a step failure class. */
export type LoopCallFailure =
  | { readonly failureClass: 'UNAVAILABLE'; readonly status: number | null }
  | { readonly failureClass: 'REFUSED'; readonly status: number; readonly refusals: readonly string[] };

export type LoopCall<T> = { readonly ok: true; readonly value: T } | ({ readonly ok: false } & LoopCallFailure);

export interface LoopAccessAnswer {
  readonly principal: BrainPrincipalRecord | null;
  readonly decision: BrainAccessDecision;
}

export interface LoopContextAnswer {
  readonly supplied: readonly { readonly ref: string; readonly trust: AiContentTrustLevel }[];
  readonly withheld: Readonly<Record<string, number>>;
  readonly itemCount: number;
  readonly decision: BrainAccessDecision;
  readonly principal: BrainPrincipalRecord | null;
  readonly commitGate: 'AVAILABLE' | 'UNAVAILABLE';
}

export interface LoopClient {
  access(job: BrainJobRef): Promise<LoopCall<LoopAccessAnswer>>;
  context(job: BrainJobRef): Promise<LoopCall<LoopContextAnswer>>;
  commit(job: BrainJobRef, stepKey: string, envelope: BrainResultEnvelope): Promise<LoopCall<{ readonly artifactId: string; readonly commitKey: string }>>;
}

/** Only HTTPS, except a loopback address for local verification. */
export function loopBaseUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.username || url.password || url.search || url.hash) return null;
    const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function createLoopClient(
  config: LoopClientConfig,
  deps: {
    readonly signer: Es256Signer;
    readonly fetch?: typeof fetch;
    readonly nowSeconds?: () => number;
    readonly tokenId?: () => string;
  },
): LoopClient {
  const origin = loopBaseUrl(config.baseUrl);
  const doFetch = deps.fetch ?? fetch;
  const nowSeconds = deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000));

  async function call(purpose: BrainWorkerPurpose, job: BrainJobRef, body: unknown): Promise<LoopCall<Record<string, unknown>>> {
    if (!origin) return { ok: false, failureClass: 'UNAVAILABLE', status: null };
    const bytes = Buffer.from(JSON.stringify(body ?? {}), 'utf8');
    const iat = nowSeconds();
    const token = await signEs256Jwt(
      {
        iss: config.issuer,
        sub: config.subject,
        aud: BRAIN_WORKER_AUDIENCE,
        jti: (deps.tokenId ?? randomUUID)(),
        iat,
        exp: iat + BRAIN_WORKER_TOKEN_LIFETIME_SECONDS,
        jobId: job.jobId,
        generation: job.generation,
        purpose,
        bodySha256: sha256Hex(bytes),
      },
      deps.signer,
    );
    let response: Response;
    try {
      response = await doFetch(`${origin}${PATHS[purpose]}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: bytes,
        redirect: 'error',
        signal: AbortSignal.timeout(BRAIN_LOOP_CALL_TIMEOUT_MS),
      });
    } catch {
      return { ok: false, failureClass: 'UNAVAILABLE', status: null };
    }
    let parsed: Record<string, unknown> = {};
    try {
      const value: unknown = await response.json();
      if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value as Record<string, unknown>;
    } catch {
      parsed = {};
    }
    if (response.status >= 500 || response.status === 429) return { ok: false, failureClass: 'UNAVAILABLE', status: response.status };
    if (!response.ok || parsed.ok !== true) {
      const refusals = Array.isArray(parsed.refusals) ? parsed.refusals.filter((r): r is string => typeof r === 'string').slice(0, 10) : [];
      return { ok: false, failureClass: 'REFUSED', status: response.status, refusals };
    }
    return { ok: true, value: parsed };
  }

  return {
    async access(job) {
      const r = await call('ACCESS_DECISION', job, {});
      if (!r.ok) return r;
      return { ok: true, value: { principal: (r.value.principal as BrainPrincipalRecord | null) ?? null, decision: r.value.decision as BrainAccessDecision } };
    },
    async context(job) {
      const r = await call('CONTEXT', job, {});
      if (!r.ok) return r;
      const context = (r.value.context ?? {}) as { supplied?: unknown; withheld?: unknown; package?: { items?: unknown } };
      const supplied = Array.isArray(context.supplied)
        ? context.supplied.filter((s): s is { ref: string; trust: AiContentTrustLevel } => !!s && typeof (s as { ref?: unknown }).ref === 'string')
        : [];
      const withheld =
        context.withheld && typeof context.withheld === 'object' ? Object.fromEntries(Object.entries(context.withheld as Record<string, unknown>).filter(([, v]) => typeof v === 'number')) : {};
      return {
        ok: true,
        value: {
          supplied: supplied.map((s) => ({ ref: s.ref, trust: s.trust })),
          withheld: withheld as Record<string, number>,
          itemCount: Array.isArray(context.package?.items) ? context.package.items.length : 0,
          decision: r.value.decision as BrainAccessDecision,
          principal: (r.value.principal as BrainPrincipalRecord | null) ?? null,
          commitGate: r.value.commitGate === 'AVAILABLE' ? 'AVAILABLE' : 'UNAVAILABLE',
        },
      };
    },
    async commit(job, stepKey, envelope) {
      const r = await call('COMMIT_RESULT', job, { stepKey, envelope });
      if (!r.ok) return r;
      const ref = r.value.ref as { artifactId?: unknown } | undefined;
      return { ok: true, value: { artifactId: String(ref?.artifactId ?? ''), commitKey: String(r.value.commitKey ?? '') } };
    },
  };
}
