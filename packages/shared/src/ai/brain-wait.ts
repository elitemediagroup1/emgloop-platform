// How a person answers a Brain job that stopped to ask them something. Slice B4.
//
// Architecture: docs/architecture/brain-execution-infrastructure.md §11, and the
// persistence record docs/architecture/brain-persistence.md.
//
// ONLY THE PERSON WHO ASKED (V1, Matt 2026-09-16). A wait belongs to its job's
// principal. Nobody else may answer it, and there is no delegation.
//
// ONE ACCEPTED REPLY PER WAIT. The first reply that is recorded is the answer. The
// same reply sent again -- a double click, a retried request -- returns what was
// recorded and changes nothing. A different reply to an answered wait is refused.
//
// A LATE REPLY IS REFUSED BY NAME. A wait that has expired, or was closed because the
// job stopped, never takes an answer, whatever the page still shows.
//
// RECORDING A REPLY DOES NOT MOVE THE JOB. The job stays WAITING_FOR_USER until its
// executor, told by a RESUME command, re-decides access and applies
// USER_INPUT_RECEIVED. The reply is read from Loop's records at that point; no message
// carries it.
//
// PURE. Instants are supplied by the caller from Loop's clock.

import type { BrainJobSnapshot } from './brain-job';

export const BRAIN_WAIT_STATUSES = ['OPEN', 'ANSWERED', 'EXPIRED', 'CLOSED'] as const;
export type BrainWaitStatus = (typeof BRAIN_WAIT_STATUSES)[number];

/** A wait as Loop records it. The question and the reply live beside it, never in it. */
export interface BrainWaitRecord {
  readonly waitId: string;
  readonly jobId: string;
  readonly organizationId: string;
  /** The only person who may answer: the job's principal when the wait opened. */
  readonly principalUserId: string;
  readonly status: BrainWaitStatus;
  readonly expiresAtMs: number;
  /** A digest of the recorded reply, so an identical repeat is recognised. Null until answered. */
  readonly replyFingerprint: string | null;
}

/** A reply as the Brain API received it: who sent it, to which wait, and its digest. */
export interface BrainWaitReply {
  readonly waitId: string;
  readonly responderUserId: string;
  readonly replyFingerprint: string;
}

export const BRAIN_WAIT_REPLY_REFUSALS = [
  'WAIT_NOT_FOUND',
  'WAIT_MISMATCH',
  'RESPONDER_IS_NOT_PRINCIPAL',
  'WAIT_ALREADY_ANSWERED',
  'WAIT_EXPIRED',
  'WAIT_CLOSED',
] as const;
export type BrainWaitReplyRefusal = (typeof BRAIN_WAIT_REPLY_REFUSALS)[number];

export type BrainWaitReplyDecision =
  | { readonly action: 'RECORD' }
  | { readonly action: 'RETURN_RECORDED' }
  | { readonly action: 'REFUSE'; readonly refusal: BrainWaitReplyRefusal };

/**
 * What to do with a reply. Somebody who is not the principal learns only that they may
 * not answer -- not whether the wait was answered, expired or closed.
 */
export function brainWaitReplyDecision(
  job: Pick<BrainJobSnapshot, 'jobId' | 'organizationId' | 'principalUserId' | 'state' | 'wait'> | null,
  wait: BrainWaitRecord | null,
  reply: BrainWaitReply,
  nowMs: number,
): BrainWaitReplyDecision {
  if (!wait || !job || wait.waitId !== reply.waitId) return refuse('WAIT_NOT_FOUND');
  if (wait.jobId !== job.jobId || wait.organizationId !== job.organizationId) return refuse('WAIT_MISMATCH');
  if (reply.responderUserId !== wait.principalUserId || reply.responderUserId !== job.principalUserId) {
    return refuse('RESPONDER_IS_NOT_PRINCIPAL');
  }
  if (wait.status === 'ANSWERED') {
    return wait.replyFingerprint !== null && wait.replyFingerprint === reply.replyFingerprint
      ? { action: 'RETURN_RECORDED' }
      : refuse('WAIT_ALREADY_ANSWERED');
  }
  if (wait.status === 'EXPIRED') return refuse('WAIT_EXPIRED');
  if (wait.status !== 'OPEN') return refuse('WAIT_CLOSED');
  if (!(nowMs < wait.expiresAtMs)) return refuse('WAIT_EXPIRED');
  // The job must still be waiting on exactly this question.
  if (job.state !== 'WAITING_FOR_USER' || !job.wait || job.wait.waitId !== wait.waitId) return refuse('WAIT_MISMATCH');
  return { action: 'RECORD' };
}

function refuse(refusal: BrainWaitReplyRefusal): BrainWaitReplyDecision {
  return { action: 'REFUSE', refusal };
}

/** Whether an OPEN wait may be expired now: only once its time has actually passed. */
export function brainWaitExpiryDue(wait: Pick<BrainWaitRecord, 'status' | 'expiresAtMs'>, nowMs: number): boolean {
  return wait.status === 'OPEN' && nowMs >= wait.expiresAtMs;
}
