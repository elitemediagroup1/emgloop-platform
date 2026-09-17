// The doorbell's front gate: is this ring from a trusted Loop deployment, and is it new? Slice B6.
//
// Architecture: brain-execution-infrastructure.md §5.2, brain-boundary.md §7.
//
// RUNS WITH NO DATA ACCESS. The authorizer reads pinned public keys and trusted names from
// configuration and writes one token id to the replay ledger. It never sees the body (an
// HTTP API authorizer is not given it), never reads Neon, never sends to a queue.
//
// A RING IS A WAKEUP. Passing here means only "a trusted deployment asked, once, within
// its lifetime". The dispatcher still checks the body and re-reads the command and its
// job before anything moves.

import type { KeyObject } from 'node:crypto';
import { brainDoorbellCheck, type BrainDoorbellClaims, type BrainDoorbellRefusal } from '@emgloop/shared';

import type { BrainLogger } from './log';
import type { BrainReplayLedger } from './ports';
import { verifyEs256Jwt } from './jws';

export interface RingTrust {
  readonly keys: ReadonlyMap<string, KeyObject>;
  readonly trustedIssuers: readonly string[];
  readonly trustedCallers: readonly string[];
}

export type RingAuthorization =
  | { readonly authorized: true; readonly claims: BrainDoorbellClaims }
  | { readonly authorized: false; readonly refusal: 'NOT_CONFIGURED' | 'NO_TOKEN' | 'UNVERIFIED' | 'MALFORMED_CLAIMS' | 'REPLAYED' | BrainDoorbellRefusal };

/** Refusals that concern the body; the authorizer cannot see it, so the dispatcher decides them. */
const BODY_REFUSALS: readonly BrainDoorbellRefusal[] = ['MALFORMED_BODY', 'CLIENT_SUPPLIED_AUTHORITY', 'UNEXPECTED_FIELD'];

const SKEW_SECONDS = 30;

function claimsOf(p: Readonly<Record<string, unknown>>): BrainDoorbellClaims | null {
  const aud = p.aud;
  if (
    typeof p.iss !== 'string' ||
    typeof p.sub !== 'string' ||
    typeof p.scope !== 'string' ||
    typeof p.jti !== 'string' ||
    typeof p.iat !== 'number' ||
    typeof p.exp !== 'number' ||
    !(typeof aud === 'string' || (Array.isArray(aud) && aud.every((a) => typeof a === 'string')))
  ) {
    return null;
  }
  const allowed = ['iss', 'sub', 'aud', 'scope', 'jti', 'iat', 'exp'];
  if (Object.keys(p).some((k) => !allowed.includes(k))) return null;
  return { iss: p.iss, sub: p.sub, aud: aud as string | readonly string[], scope: p.scope, jti: p.jti, iat: p.iat, exp: p.exp };
}

export async function authorizeRing(
  authorizationHeader: string | undefined,
  deps: { readonly trust: RingTrust; readonly replay: BrainReplayLedger; readonly nowSeconds: number; readonly log: BrainLogger },
): Promise<RingAuthorization> {
  const refuse = (refusal: Exclude<RingAuthorization, { authorized: true }>['refusal']): RingAuthorization => {
    deps.log.warn('doorbell.refused', { outcome: 'REFUSED', refusals: [refusal] });
    deps.log.metric('DoorbellRefused', 1, { outcome: refusal });
    return { authorized: false, refusal };
  };
  const { trust } = deps;
  if (trust.keys.size === 0 || trust.trustedIssuers.length === 0 || trust.trustedCallers.length === 0) return refuse('NOT_CONFIGURED');
  const token = /^Bearer\s+(\S+)$/i.exec(authorizationHeader ?? '')?.[1];
  if (!token) return refuse('NO_TOKEN');
  const verified = verifyEs256Jwt(token, trust.keys);
  if (!verified.ok) return refuse('UNVERIFIED');
  const claims = claimsOf(verified.payload);
  if (!claims) return refuse('MALFORMED_CLAIMS');
  const check = brainDoorbellCheck(claims, undefined, {
    nowSeconds: deps.nowSeconds,
    trustedIssuers: trust.trustedIssuers,
    trustedCallers: trust.trustedCallers,
  });
  const claimRefusals = check.ok ? [] : check.refusals.filter((r) => !BODY_REFUSALS.includes(r));
  if (claimRefusals.length > 0) return refuse(claimRefusals[0]!);
  // Only a token that passed every other check may occupy the ledger.
  if (!(await deps.replay.recordOnce(claims.jti, claims.exp + SKEW_SECONDS))) return refuse('REPLAYED');
  deps.log.info('doorbell.authorized', { outcome: 'AUTHORIZED', tokenId: claims.jti, caller: claims.sub });
  return { authorized: true, claims };
}
