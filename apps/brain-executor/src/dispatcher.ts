// The dispatcher: from a stored command to a queued reference. Slice B6.
//
// Architecture: brain-execution-infrastructure.md §5.2 and §6.
//
// THE RING NAMES A COMMAND; LOOP'S RECORDS DECIDE. The dispatcher checks the ring's body
// against its already-verified claims, reads the command and its job from Neon, and acts
// only on an EXECUTE disposition. It sends a reference -- job, generation, reason,
// command -- to the queue that the JOB's execution class selects, then records the
// hand-over. It is the only component that records a dispatch.
//
// TWO ENTRANCES. A ring from Loop (through the authorizer), and a recovery hand-over from
// the sweeper for a command whose ring was lost. Both end in the same checks.
//
// SAYS LITTLE. Whatever the outcome after authentication, the caller learns only that
// the ring was received.

import { brainDoorbellCheck, type BrainAdvanceMessage, type BrainAdvanceReason, type BrainDoorbellClaims } from '@emgloop/shared';

import type { BrainLogger } from './log';
import type { BrainDispatcherStore, BrainQueueName, BrainWorkQueues } from './ports';
import type { RingTrust } from './doorbell-authorizer';

export const BRAIN_RING_MAX_BODY_BYTES = 1024;
const COMMAND_ID = /^[A-Za-z0-9_-]{8,128}$/;

export type DispatchInput =
  | { readonly kind: 'RING'; readonly claims: BrainDoorbellClaims; readonly rawBody: string }
  | { readonly kind: 'RECOVERY'; readonly commandId: string };

export type DispatchOutcome = 'DISPATCHED' | 'ALREADY_DONE' | 'REFUSED' | 'NOT_FOUND' | 'BAD_REQUEST';

export async function dispatch(
  input: DispatchInput,
  deps: {
    readonly store: BrainDispatcherStore;
    readonly queues: BrainWorkQueues;
    readonly trust: Pick<RingTrust, 'trustedIssuers' | 'trustedCallers'>;
    readonly now: () => Date;
    readonly log: BrainLogger;
  },
): Promise<DispatchOutcome> {
  const { log } = deps;
  let commandId: string;
  if (input.kind === 'RING') {
    if (Buffer.byteLength(input.rawBody, 'utf8') > BRAIN_RING_MAX_BODY_BYTES) return bad(log, ['BODY_TOO_LARGE']);
    let body: unknown;
    try {
      body = JSON.parse(input.rawBody);
    } catch {
      return bad(log, ['MALFORMED_BODY']);
    }
    const check = brainDoorbellCheck(input.claims, body, {
      nowSeconds: Math.floor(deps.now().getTime() / 1000),
      trustedIssuers: deps.trust.trustedIssuers,
      trustedCallers: deps.trust.trustedCallers,
    });
    if (!check.ok) return bad(log, check.refusals);
    commandId = check.commandId;
  } else {
    if (!COMMAND_ID.test(input.commandId)) return bad(log, ['MALFORMED_COMMAND_ID']);
    commandId = input.commandId;
  }

  const lookup = await deps.store.command(commandId);
  if (!lookup.ok) {
    log.warn('dispatch.not_found', { commandId, outcome: 'NOT_FOUND', reason: input.kind });
    log.metric('DispatchOutcome', 1, { outcome: 'NOT_FOUND' });
    return 'NOT_FOUND';
  }
  const fields = { commandId, commandType: lookup.commandType, jobId: lookup.job.jobId, generation: lookup.job.generation, organizationId: lookup.job.organizationId, reason: input.kind };
  if (lookup.disposition.action === 'REFUSE') {
    log.error('dispatch.refused', { ...fields, outcome: 'REFUSED', refusals: lookup.disposition.refusals });
    log.metric('DispatchOutcome', 1, { outcome: 'REFUSED' });
    return 'REFUSED';
  }
  if (lookup.disposition.action === 'ALREADY_DONE') {
    log.info('dispatch.already_done', { ...fields, outcome: 'ALREADY_DONE' });
    log.metric('DispatchOutcome', 1, { outcome: 'ALREADY_DONE' });
    return 'ALREADY_DONE';
  }
  const queue: BrainQueueName = lookup.executionClass === 'DURABLE' ? 'DURABLE' : 'INTERACTIVE';
  const message: BrainAdvanceMessage = {
    jobId: lookup.job.jobId,
    generation: lookup.job.generation,
    reason: lookup.commandType as BrainAdvanceReason,
    commandId,
  };
  const sent = await deps.queues.send(queue, message);
  // Sent first, recorded second: a crash between them re-sends later, and a re-sent
  // reference is harmless (the lease and the disposition absorb it).
  await deps.store.markDispatched(lookup.job, commandId, deps.now());
  log.info('dispatch.sent', { ...fields, outcome: 'DISPATCHED', queue, messageId: sent.messageId });
  log.metric('DispatchOutcome', 1, { outcome: 'DISPATCHED' });
  return 'DISPATCHED';
}

function bad(log: BrainLogger, refusals: readonly string[]): DispatchOutcome {
  log.warn('dispatch.bad_request', { outcome: 'BAD_REQUEST', refusals: [...refusals] });
  log.metric('DispatchOutcome', 1, { outcome: 'BAD_REQUEST' });
  return 'BAD_REQUEST';
}
