// Who may start, resume or stop Brain work, and on whose authority it runs. Slice B2.
//
// Architecture: docs/architecture/brain-execution-architecture.md §6 (the doorbell),
// approved as a direction subject to implementation review.
//
// SIX IDENTITIES, NEVER CONFUSED.
//   caller        the deployment that rang the doorbell. Proves "a trusted Loop
//                 deployment", never a tenant, never a person.
//   principal     the person on whose authority the work runs. Fixed when the job was
//                 accepted from a verified session; read from the job ever after.
//   organization  whose data it is. Read from the job, never from a request.
//   access        whether the principal may do this now, decided from Loop's
//                 membership and permission records at every consequential boundary.
//   job           which work: an id and a generation.
//   invocation    which provider call: a ledger call key, one per attempt.
//
// THE DOORBELL CARRIES NOTHING WORTH STEALING. Its token says who rang and that the
// ringer may ask for dispatch; its body names one stored command. The command, the job
// and the organization are read from Loop's database, and a body that tries to supply
// an organization, a principal or a job is refused. A replayed or forged ring can only
// make the dispatcher look again at work that was already authorized and recorded.
//
// VERIFYING THE TOKEN'S SIGNATURE IS NOT DONE HERE. That belongs to the boundary that
// receives the ring (a later slice). This file decides what a verified token must say.
//
// PURE. Clocks are supplied by the caller.

import type { BrainEventActor } from './brain-result';
import type { BrainJobSnapshot } from './brain-job';
import { brainJobIsTerminal } from './brain-job';

// --- The doorbell ---------------------------------------------------------------------

export const BRAIN_DOORBELL_AUDIENCE = 'loop-brain-doorbell';
export const BRAIN_DOORBELL_SCOPE = 'brain.dispatch';
/** A ring is good for about a minute; this bounds any token's whole life, clock skew included. */
export const BRAIN_DOORBELL_MAX_LIFETIME_SECONDS = 120;
export const BRAIN_DOORBELL_CLOCK_SKEW_SECONDS = 30;

/** What a verified doorbell token says. No organization, no principal, no job. */
export interface BrainDoorbellClaims {
  readonly iss: string;
  readonly aud: string | readonly string[];
  readonly sub: string;
  /** Space-separated scopes. */
  readonly scope: string;
  readonly jti: string;
  readonly iat: number;
  readonly exp: number;
}

export interface BrainCallerIdentity {
  readonly kind: 'DEPLOYMENT';
  readonly subject: string;
  readonly tokenId: string;
}

export const BRAIN_DOORBELL_REFUSALS = [
  'ISSUER_NOT_TRUSTED',
  'CALLER_NOT_TRUSTED',
  'WRONG_AUDIENCE',
  'WRONG_SCOPE',
  'MISSING_TOKEN_ID',
  'NOT_YET_VALID',
  'EXPIRED',
  'LIFETIME_TOO_LONG',
  'MALFORMED_BODY',
  'CLIENT_SUPPLIED_AUTHORITY',
  'UNEXPECTED_FIELD',
] as const;
export type BrainDoorbellRefusal = (typeof BRAIN_DOORBELL_REFUSALS)[number];

const COMMAND_ID = /^[A-Za-z0-9_-]{8,128}$/;
const RING_AUTHORITY_KEYS = ['organizationId', 'orgId', 'organization', 'tenantId', 'principal', 'principalUserId', 'userId', 'jobId', 'role'];

/**
 * Whether a ring may be acted on, given its already-verified claims and its body. On
 * success the dispatcher learns exactly two things: who rang, and which stored command
 * to look up.
 */
export function brainDoorbellCheck(
  claims: BrainDoorbellClaims,
  body: unknown,
  options: {
    readonly nowSeconds: number;
    readonly trustedIssuers: readonly string[];
    readonly trustedCallers: readonly string[];
    readonly maxLifetimeSeconds?: number;
    readonly clockSkewSeconds?: number;
  },
):
  | { readonly ok: true; readonly caller: BrainCallerIdentity; readonly commandId: string }
  | { readonly ok: false; readonly refusals: readonly BrainDoorbellRefusal[] } {
  const out: BrainDoorbellRefusal[] = [];
  const skew = options.clockSkewSeconds ?? BRAIN_DOORBELL_CLOCK_SKEW_SECONDS;
  const maxLifetime = options.maxLifetimeSeconds ?? BRAIN_DOORBELL_MAX_LIFETIME_SECONDS;
  if (!options.trustedIssuers.includes(claims.iss)) out.push('ISSUER_NOT_TRUSTED');
  if (!options.trustedCallers.includes(claims.sub)) out.push('CALLER_NOT_TRUSTED');
  const audiences = typeof claims.aud === 'string' ? [claims.aud] : Array.isArray(claims.aud) ? [...claims.aud] : [];
  if (!audiences.includes(BRAIN_DOORBELL_AUDIENCE)) out.push('WRONG_AUDIENCE');
  if (!String(claims.scope ?? '').split(' ').includes(BRAIN_DOORBELL_SCOPE)) out.push('WRONG_SCOPE');
  if (typeof claims.jti !== 'string' || claims.jti.trim() === '') out.push('MISSING_TOKEN_ID');
  const iat = Number(claims.iat);
  const exp = Number(claims.exp);
  if (!Number.isFinite(iat) || iat > options.nowSeconds + skew) out.push('NOT_YET_VALID');
  if (!Number.isFinite(exp) || exp + skew <= options.nowSeconds) out.push('EXPIRED');
  if (Number.isFinite(iat) && Number.isFinite(exp) && exp - iat > maxLifetime) out.push('LIFETIME_TOO_LONG');

  let commandId: string | null = null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    out.push('MALFORMED_BODY');
  } else {
    const fields = body as Record<string, unknown>;
    const keys = Object.keys(fields);
    if (keys.some((k) => RING_AUTHORITY_KEYS.includes(k))) out.push('CLIENT_SUPPLIED_AUTHORITY');
    if (keys.some((k) => k !== 'commandId' && !RING_AUTHORITY_KEYS.includes(k))) out.push('UNEXPECTED_FIELD');
    if (typeof fields.commandId === 'string' && COMMAND_ID.test(fields.commandId)) commandId = fields.commandId;
    else out.push('MALFORMED_BODY');
  }
  if (out.length > 0 || commandId === null) return { ok: false, refusals: [...new Set(out)] };
  return { ok: true, caller: { kind: 'DEPLOYMENT', subject: claims.sub, tokenId: claims.jti }, commandId };
}

// --- Commands -------------------------------------------------------------------------

export const BRAIN_COMMAND_TYPES = ['START', 'RESUME', 'CANCEL'] as const;
export type BrainCommandType = (typeof BRAIN_COMMAND_TYPES)[number];

/**
 * An instruction stored in Loop's database, in the same transaction as the change it
 * accompanies, by the Brain API after it checked the person's access. It is the only
 * thing a doorbell ring can point at.
 */
export interface BrainCommand {
  readonly commandId: string;
  readonly type: BrainCommandType;
  readonly organizationId: string;
  readonly jobId: string;
  readonly generation: number;
  /** RESUME only: the wait the stored reply answers. */
  readonly waitId: string | null;
  readonly issuedBy: BrainEventActor;
  readonly issuedAtMs: number;
}

export const BRAIN_COMMAND_REFUSALS = [
  'COMMAND_NOT_FOUND',
  'JOB_NOT_FOUND',
  'ORGANIZATION_MISMATCH',
  'GENERATION_MISMATCH',
  'ISSUER_NOT_PERMITTED',
  'STATE_DOES_NOT_ACCEPT_COMMAND',
  'WAIT_MISMATCH',
  'REPLY_NOT_RECORDED',
] as const;
export type BrainCommandRefusal = (typeof BRAIN_COMMAND_REFUSALS)[number];

export type BrainCommandDisposition =
  | { readonly action: 'EXECUTE' }
  | { readonly action: 'ALREADY_DONE' }
  | { readonly action: 'REFUSE'; readonly refusals: readonly BrainCommandRefusal[] };

/**
 * What the dispatcher does with a command it looked up. It acts only when the command
 * and the job -- both read from Loop's database -- agree. A command that has already
 * taken effect is acknowledged, not repeated, so a duplicate ring is harmless.
 */
export function brainCommandDisposition(
  command: BrainCommand | null,
  job: BrainJobSnapshot | null,
  context: { readonly replyRecorded: boolean },
): BrainCommandDisposition {
  if (!command) return { action: 'REFUSE', refusals: ['COMMAND_NOT_FOUND'] };
  if (!job || job.jobId !== command.jobId) return { action: 'REFUSE', refusals: ['JOB_NOT_FOUND'] };
  const refusals: BrainCommandRefusal[] = [];
  if (job.organizationId !== command.organizationId) refusals.push('ORGANIZATION_MISMATCH');
  if (job.generation !== command.generation) refusals.push('GENERATION_MISMATCH');

  const issuer = command.issuedBy;
  const byPrincipal = issuer.kind === 'HUMAN' && issuer.userId === job.principalUserId;
  if (command.type === 'START' || command.type === 'RESUME') {
    if (!byPrincipal) refusals.push('ISSUER_NOT_PERMITTED');
  } else if (issuer.kind === 'SYSTEM') {
    // Stopping is attributed: a person (the principal or an administrator the API
    // checked) or a named policy such as a kill switch. Never an anonymous system.
    refusals.push('ISSUER_NOT_PERMITTED');
  }
  if (refusals.length > 0) return { action: 'REFUSE', refusals };

  if (brainJobIsTerminal(job.state)) return { action: 'ALREADY_DONE' };
  switch (command.type) {
    case 'START':
      return job.state === 'ACCEPTED' ? { action: 'EXECUTE' } : { action: 'ALREADY_DONE' };
    case 'CANCEL':
      return { action: 'EXECUTE' };
    case 'RESUME':
      if (job.state === 'RUNNING') return { action: 'ALREADY_DONE' };
      if (job.state !== 'WAITING_FOR_USER' || !job.wait) return { action: 'REFUSE', refusals: ['STATE_DOES_NOT_ACCEPT_COMMAND'] };
      if (command.waitId !== job.wait.waitId) return { action: 'REFUSE', refusals: ['WAIT_MISMATCH'] };
      if (!context.replyRecorded) return { action: 'REFUSE', refusals: ['REPLY_NOT_RECORDED'] };
      return { action: 'EXECUTE' };
  }
}

// --- Access at every consequential boundary ---------------------------------------------

/** An access decision, made from Loop's records, with what it covered and when. */
export interface BrainAccessDecision {
  readonly allowed: boolean;
  readonly organizationId: string;
  readonly principalUserId: string;
  readonly taskId: string;
  readonly decidedAtMs: number;
}

/** The principal as Loop's membership records describe them now. */
export interface BrainPrincipalRecord {
  readonly userId: string;
  readonly organizationId: string;
  readonly kind: 'HUMAN' | 'AI_EMPLOYEE' | 'SERVICE';
  readonly membershipActive: boolean;
}

/** How old an access decision may be when a boundary relies on it: made just before, not at submission. */
export const BRAIN_ACCESS_DECISION_MAX_AGE_MS = 30_000;

export const BRAIN_BOUNDARY_REFUSALS = [
  'PRINCIPAL_NOT_FOUND',
  'PRINCIPAL_IN_ANOTHER_ORGANIZATION',
  'PRINCIPAL_NOT_HUMAN',
  'PRINCIPAL_NOT_ACTIVE',
  'DECISION_FOR_ANOTHER_ORGANIZATION',
  'DECISION_FOR_ANOTHER_PRINCIPAL',
  'DECISION_FOR_ANOTHER_TASK',
  'DECISION_STALE',
  'NOT_PERMITTED',
] as const;
export type BrainBoundaryRefusal = (typeof BRAIN_BOUNDARY_REFUSALS)[number];

/**
 * Whether the job may cross a consequential boundary -- a model call, a result commit
 * -- right now. Everything is compared against the JOB, because the job is the only
 * thing whose organization and principal were fixed by a verified session.
 */
export function brainBoundaryRefusals(
  job: Pick<BrainJobSnapshot, 'organizationId' | 'principalUserId' | 'taskId'>,
  principal: BrainPrincipalRecord | null,
  decision: BrainAccessDecision | null,
  options: { readonly nowMs: number; readonly maxDecisionAgeMs?: number },
): BrainBoundaryRefusal[] {
  const out: BrainBoundaryRefusal[] = [];
  if (!principal || principal.userId !== job.principalUserId) out.push('PRINCIPAL_NOT_FOUND');
  else {
    if (principal.organizationId !== job.organizationId) out.push('PRINCIPAL_IN_ANOTHER_ORGANIZATION');
    if (principal.kind !== 'HUMAN') out.push('PRINCIPAL_NOT_HUMAN');
    if (!principal.membershipActive) out.push('PRINCIPAL_NOT_ACTIVE');
  }
  if (!decision) {
    out.push('NOT_PERMITTED');
    return out;
  }
  if (decision.organizationId !== job.organizationId) out.push('DECISION_FOR_ANOTHER_ORGANIZATION');
  if (decision.principalUserId !== job.principalUserId) out.push('DECISION_FOR_ANOTHER_PRINCIPAL');
  if (decision.taskId !== job.taskId) out.push('DECISION_FOR_ANOTHER_TASK');
  const maxAge = options.maxDecisionAgeMs ?? BRAIN_ACCESS_DECISION_MAX_AGE_MS;
  if (!(options.nowMs - decision.decidedAtMs <= maxAge) || decision.decidedAtMs > options.nowMs) out.push('DECISION_STALE');
  if (decision.allowed !== true) out.push('NOT_PERMITTED');
  return out;
}

/** The identities one Brain request involves, side by side so none stands in for another. */
export interface BrainRequestIdentities {
  readonly caller: BrainCallerIdentity | null;
  readonly principalUserId: string;
  readonly organizationId: string;
  readonly access: BrainAccessDecision;
  readonly job: { readonly jobId: string; readonly generation: number };
  readonly invocationCallKey: string | null;
}
