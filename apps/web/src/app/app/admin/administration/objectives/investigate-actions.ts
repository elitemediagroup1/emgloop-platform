'use server';

// Headline → Investigate → Case, the authorization boundary.
//
// THE HUMAN DECISION LIVES HERE AND NOWHERE ELSE. Loop generates Headlines on its
// own; nothing it does creates an investigation. This action is the only path in
// the application that can, and it cannot run without an authenticated person
// holding `commercialIntelligence:update`.
//
// FOUR STEPS, THE SAME FOUR EVERY GOVERNED ACTION IN THIS REPOSITORY USES:
//
//   1. `requirePermission` at the top, server-side, before anything is read. The
//      UI hiding a button is not access control.
//   2. The organization comes from the SIGNED SESSION. Never from the form. A
//      form field named organizationId would be the vulnerability CLAUDE.md's
//      multi-tenant rules exist to prevent, which is why none is read here.
//   3. The service resolves the Headline WITHIN that organization and fails closed
//      to not-found. A cross-organization id is not-found, never forbidden.
//   4. The audit row records who authorized it, and is written only when
//      something actually happened.
//
// NO UI RENDERS THIS YET. Charlie and Lexi own the Investigate control and its
// copy; this is the contract it will call. Shipping the boundary a PR ahead of
// its button is deliberate -- it is the half that has to be right.

import { redirect } from 'next/navigation';

import { HeadlineInvestigationService, prisma, repositories } from '@emgloop/database';
import { requirePermission } from '../../../../../auth/guard';

const PATH = '/app/admin/administration/objectives';

function backTo(message: string, kind: 'notice' | 'error'): string {
  return PATH + '?' + kind + '=' + encodeURIComponent(message);
}

/**
 * Authorize an investigation into a Headline.
 *
 * WHAT THIS DOES NOT DO, said here because the list is the product contract:
 * it establishes no Finding, generates no Recommendation, creates no Work,
 * assigns nobody and calls no model. It records that a person decided this
 * deserves organizational attention -- which is not the same as deciding the
 * Headline is correct.
 */
export async function investigateHeadlineAction(formData: FormData): Promise<void> {
  // `commercialIntelligence`, matching every other Headline-surface action.
  // Deliberately the narrower of the two intelligence resources: `intelligence`
  // governs READING what Loop concluded, and authorizing an organizational
  // investigation is an authoring act by a different set of people.
  const session = await requirePermission('commercialIntelligence', 'update');

  const headlineId = String(formData.get('headlineId') ?? '').trim();
  if (!headlineId) redirect(backTo('No headline selected.', 'error'));

  const service = new HeadlineInvestigationService(prisma);
  const result = await service.promote(session.organizationId, {
    headlineId,
    // From the session, never the form. A promotion that could name its own
    // actor would make the audit row worthless.
    actorUserId: session.userId,
    note: String(formData.get('note') ?? '').trim() || null,
  });

  if (result.outcome === 'HEADLINE_NOT_FOUND') {
    // The same answer a headline belonging to another organization gets.
    redirect(backTo('That headline no longer exists.', 'error'));
  }
  if (result.outcome === 'NO_AUTHORIZING_HUMAN') {
    // Unreachable through this action -- the session supplies the actor -- and
    // handled rather than assumed, because an unattributed promotion must fail
    // loudly if the guard above ever changes shape.
    redirect(backTo('An investigation must be authorized by a person.', 'error'));
  }

  // ONLY WHEN SOMETHING HAPPENED. A repeated press opens nothing, so it writes no
  // audit row: an audit trail that records non-events is one people stop reading.
  if (result.opened) {
    await repositories.audit.record({
      organizationId: session.organizationId,
      userId: session.userId,
      actorName: session.name,
      action: 'headline.investigation_authorized',
      entityType: 'operational_priority',
      entityId: result.caseId ?? '',
      after: { headlineId: result.headlineId },
      metadata: { headlineId: result.headlineId },
    });
  }

  redirect(
    backTo(
      result.opened
        ? 'Investigation opened.'
        : 'This headline is already under investigation.',
      'notice',
    ),
  );
}
