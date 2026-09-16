'use server';

// Request an explanation of one Case. Slice AI-5.
//
// GUARDED HERE, whatever the page offered: the ADMIN workspace and
// `commercialIntelligence:view` before anything, and the service then re-decides
// the invoker (OWNER or ADMIN, never AI_EMPLOYEE), activation, kill switches and the
// budget. The organization and the person come from the signed session; the only
// thing taken from the browser is the Case id, which is resolved inside the session's
// organization and is simply not found anywhere else.
//
// READ-ONLY. It changes nothing about the Case. What comes back is the validated
// answer or a plain reason it is not shown -- never a partial answer.

import { requirePermission } from '../../../../auth/guard';
import { requireWorkspace } from '../../../../workspaces/guard';
import { explainCase } from '../../../../ai/case-explanation';
import { explanationViewOf, type ExplanationView } from './explanation-view';

export async function explainCaseAction(caseId: string): Promise<ExplanationView> {
  await requireWorkspace('ADMIN');
  const session = await requirePermission('commercialIntelligence', 'view');
  const id = typeof caseId === 'string' ? caseId.trim() : '';
  if (!id || id.length > 200) return explanationViewOf({ outcome: 'NOT_FOUND' });
  const result = await explainCase({ organizationId: session.organizationId, userId: session.userId }, id, session.name ?? null);
  return explanationViewOf(result);
}
