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

/**
 * Where a completed action returns to.
 *
 * A KEY INTO A CONSTANT, NEVER A URL FROM THE FORM. Two surfaces now offer the
 * same governed actions -- the administration list and the Headlines feed -- and
 * each needs the person to land back where they were. Reading a `returnTo` URL
 * out of the form would be an open redirect on a page behind authentication,
 * which is a vulnerability with a very old name. An unrecognised key falls back
 * to the administration surface rather than being trusted.
 */
const SURFACES: Record<string, string> = {
  objectives: PATH,
  headlines: '/app/admin/headlines',
};

function backTo(message: string, kind: 'notice' | 'error', surface?: string): string {
  const base = (surface && SURFACES[surface]) || PATH;
  return base + '?' + kind + '=' + encodeURIComponent(message);
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

  // An allow-listed key, not a URL. See SURFACES above.
  const surface = String(formData.get('surface') ?? '').trim();

  const headlineId = String(formData.get('headlineId') ?? '').trim();
  if (!headlineId) redirect(backTo('No headline selected.', 'error', surface));

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
    redirect(backTo('That headline no longer exists.', 'error', surface));
  }
  if (result.outcome === 'NO_AUTHORIZING_HUMAN') {
    // Unreachable through this action -- the session supplies the actor -- and
    // handled rather than assumed, because an unattributed promotion must fail
    // loudly if the guard above ever changes shape.
    redirect(backTo('An investigation must be authorized by a person.', 'error', surface));
  }

  // ONLY WHEN SOMETHING HAPPENED, and "something" is the AUTHORIZATION, not the
  // thread. A repeated press appends nothing and writes nothing here — an audit
  // trail that records non-events is one people stop reading. But a press that
  // completes an interrupted promotion DOES append the authorization to the
  // authoritative log, and keying this on `opened` instead would have left the
  // one reachable case where a person authorized an investigation and the
  // generic trail never said so.
  //
  // THE AUTHORITATIVE ANSWER TO "WHO AUTHORIZED THIS, AND WHEN" IS NOT HERE. It
  // is the attributed HUMAN observation on the Case's own append-only log, which
  // carries actorUserId, occurredAt and recordedAt and cannot be edited. This row
  // is the platform-wide admin trail, and it is supplementary to that.
  if (result.authorizationAppendedNow) {
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
      surface,
    ),
  );
}
