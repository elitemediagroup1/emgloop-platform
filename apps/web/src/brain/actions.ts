'use server';

// Brain work, as a signed-in person starts, answers and stops it. Slice B5.
//
// THE SESSION IS THE ONLY AUTHORITY TAKEN FROM THE REQUEST'S CONTEXT. Each action
// resolves the signed session first; the organization and the person come from it and
// nothing else. What the browser sends is a submission, a reply or an id, and the Brain
// boundary re-decides everything about it (brain-work.service.ts).
//
// NOTHING HERE CALLS A MODEL. Accepting work records it; an executor runs it elsewhere.

import type { BrainCancelWorkOutcome, BrainRespondOutcome, BrainSubmitOutcome } from '@emgloop/database';

import { getSession } from '../auth/auth';
import { brainWork } from './brain-runtime';

const ID = /^[A-Za-z0-9_-]{1,128}$/;

type Unauthenticated = { readonly ok: false; readonly refusal: 'UNAUTHENTICATED' };
const UNAUTHENTICATED: Unauthenticated = { ok: false, refusal: 'UNAUTHENTICATED' };

export async function submitBrainWorkAction(submission: unknown): Promise<BrainSubmitOutcome | Unauthenticated> {
  const session = await getSession();
  if (!session) return UNAUTHENTICATED;
  return brainWork().submit({ organizationId: session.organizationId, userId: session.userId }, submission);
}

export async function respondToBrainQuestionAction(waitId: string, reply: unknown): Promise<BrainRespondOutcome | Unauthenticated> {
  const session = await getSession();
  if (!session) return UNAUTHENTICATED;
  if (typeof waitId !== 'string' || !ID.test(waitId)) return { ok: false, refusal: 'WAIT_NOT_FOUND' };
  return brainWork().respond({ organizationId: session.organizationId, userId: session.userId }, waitId, reply);
}

export async function cancelBrainWorkAction(jobId: string): Promise<BrainCancelWorkOutcome | Unauthenticated> {
  const session = await getSession();
  if (!session) return UNAUTHENTICATED;
  if (typeof jobId !== 'string' || !ID.test(jobId)) return { ok: false, refusal: 'JOB_NOT_FOUND' };
  return brainWork().cancel({ organizationId: session.organizationId, userId: session.userId }, jobId);
}
