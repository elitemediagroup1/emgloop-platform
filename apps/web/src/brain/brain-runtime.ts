// The Loop-side Brain boundary, assembled for a web request. Slice B5. SERVER ONLY.
//
// This is where the pieces meet: the IAM authorizer, this deployment's AI floor (read by
// ai-environment.ts and nowhere else), the reviewed routing and specialization policies,
// the doorbell, and the worker trust (read by brain-environment.ts and nowhere else).
// Nothing here decides anything those pieces do not already decide, and nothing here
// names a provider, a model or an execution environment.
//
// WITH THE DEFAULT ENVIRONMENT NOTHING RUNS. The AI floor is off, so every submission is
// refused as NOT_ENABLED before anything is recorded; the doorbell is not configured, so
// nothing is rung; worker trust is not configured, so every internal request is refused.

import 'server-only';

import {
  BrainExecutionReferences,
  BrainInternalService,
  BrainJobRepository,
  BrainWorkService,
  iamAiAuthorizer,
  prisma,
} from '@emgloop/database';
import { AI_PROVIDER_SPECIALIZATION_POLICY, AI_ROUTING_POLICY } from '@emgloop/providers';
import type { BrainJobSnapshot } from '@emgloop/shared';

import { readAiControlFloor } from '../ai/ai-environment';
import { ringBrainDoorbell } from './doorbell';

export interface BrainSessionPrincipal {
  readonly organizationId: string;
  readonly userId: string;
}

/** The boundary a signed-in person reaches. The principal is always the signed session's. */
export function brainWork(): BrainWorkService {
  return new BrainWorkService(prisma, {
    authorize: iamAiAuthorizer(prisma),
    controlFloor: () => readAiControlFloor(),
    routing: AI_ROUTING_POLICY,
    specialization: AI_PROVIDER_SPECIALIZATION_POLICY,
    ring: (commandId) => ringBrainDoorbell(commandId),
  });
}

/** The three questions an authenticated worker may ask. */
export function brainInternal(): BrainInternalService {
  const jobs = new BrainJobRepository(prisma);
  return new BrainInternalService(prisma, {
    authorize: iamAiAuthorizer(prisma),
    readInput: (organizationId, jobId) => jobs.input(organizationId, jobId),
  });
}

/** The job a verified worker token names, from Loop's records. */
export async function loadBrainJobForWorker(jobId: string): Promise<BrainJobSnapshot | null> {
  const located = await new BrainExecutionReferences(prisma).locateJob(jobId);
  if (!located) return null;
  const record = await new BrainJobRepository(prisma).get(located.organizationId, located.jobId);
  return record?.job ?? null;
}
