// Ringing the Brain doorbell. Slice B5.
//
// Architecture: brain-execution-infrastructure.md §5.2 and §6, and the claim check the
// receiving side applies (`brainDoorbellCheck`).
//
// A RING IS A NUDGE, NOT AN INSTRUCTION. It says "a trusted Loop deployment asks you to
// look at stored command X". It carries the command id and nothing else: no
// organization, principal, job, input or content. The receiver re-reads the command and
// its job from Neon and decides for itself (`brainCommandDisposition`). A forged,
// replayed or duplicated ring can only make it look again at work already authorized and
// recorded.
//
// MINIMAL, SHORT-LIVED, UNIQUE. The token names this deployment as issuer and subject,
// the doorbell as audience, `brain.dispatch` as its only scope, a random id the receiver
// records to refuse a replay, and a lifetime of sixty seconds.
//
// NEVER AWAITED FOR CORRECTNESS. The command is committed before the ring. A ring that
// fails, times out, or is not configured changes nothing that was recorded: the executor's
// sweeper finds undispatched commands. So a ring never throws and is never retried here.

import 'server-only';

import { randomUUID } from 'crypto';
import { BRAIN_DOORBELL_AUDIENCE, BRAIN_DOORBELL_SCOPE } from '@emgloop/shared';

import { readBrainDoorbell, type BrainDoorbellConfig } from './brain-environment';
import { signEs256 } from './jws';

export const BRAIN_RING_LIFETIME_SECONDS = 60;
export const BRAIN_RING_TIMEOUT_MS = 2000;

const COMMAND_ID = /^[A-Za-z0-9_-]{8,128}$/;

export type BrainRingOutcome = 'RUNG' | 'NOT_CONFIGURED' | 'FAILED';

/** The token a ring carries. Exported so its claims can be checked against the receiver's rules. */
export function brainRingToken(config: Extract<BrainDoorbellConfig, { state: 'CONFIGURED' }>, nowSeconds: number, tokenId: string = randomUUID()): string {
  return signEs256(
    config.keyId,
    {
      iss: config.issuer,
      sub: config.subject,
      aud: BRAIN_DOORBELL_AUDIENCE,
      scope: BRAIN_DOORBELL_SCOPE,
      jti: tokenId,
      iat: nowSeconds,
      exp: nowSeconds + BRAIN_RING_LIFETIME_SECONDS,
    },
    config.signingKey,
  );
}

export interface BrainRingDeps {
  readonly config?: BrainDoorbellConfig;
  readonly fetch?: typeof fetch;
  readonly nowSeconds?: () => number;
}

/** Ask the executor to look at one stored command. Never throws. */
export async function ringBrainDoorbell(commandId: string, deps: BrainRingDeps = {}): Promise<BrainRingOutcome> {
  const config = deps.config ?? readBrainDoorbell();
  if (config.state !== 'CONFIGURED') return 'NOT_CONFIGURED';
  if (!COMMAND_ID.test(commandId)) return 'FAILED';
  const nowSeconds = deps.nowSeconds ? deps.nowSeconds() : Math.floor(Date.now() / 1000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BRAIN_RING_TIMEOUT_MS);
  try {
    const response = await (deps.fetch ?? fetch)(config.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${brainRingToken(config, nowSeconds)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ commandId }),
      signal: controller.signal,
      redirect: 'error',
      cache: 'no-store',
    });
    return response.ok ? 'RUNG' : 'FAILED';
  } catch {
    return 'FAILED';
  } finally {
    clearTimeout(timer);
  }
}
