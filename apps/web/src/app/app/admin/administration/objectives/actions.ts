'use server';

// Performance Objectives — server actions (Commercial Intelligence Stage 1).
//
// Create, edit, archive and reactivate the organization's objectives: what the
// organization or a person is trying to accomplish.
//
// THE ORGANIZATION ALWAYS COMES FROM THE SIGNED SESSION, never the form. There
// is no `organizationId` field on any form in this feature and no action reads
// one; the id a caller could tamper with is the objective id, and the repository
// resolves that WITHIN the session organization and fails closed to null.
//
// AUDIT ONLY WHAT ACTUALLY HAPPENED. Every mutation checks the repository's
// return value before writing an AuditLog row. A scoped resolve that misses
// returns null and this file returns early — no audit entry for a write that
// did not happen, which is the rule that keeps the audit trail worth reading.
//
// NOTHING HERE IS INTELLIGENT — with one bounded exception. The first four
// actions persist typed human intent: no scoring, no ranking, no inference, no
// AI, no measurement of anything. `evaluateActivityAction` (Stage 2) runs a
// DETERMINISTIC evaluator over calls Loop already recorded and writes Commercial
// Signals for the observations that share subject matter with an objective. It
// still scores nothing, ranks nothing, calls no model, and starts nothing
// downstream.

import { redirect } from 'next/navigation';
import { repositories, CommercialSignalEvaluationService } from '@emgloop/database';
import {
  PERFORMANCE_OBJECTIVE_REJECTION_MESSAGES,
  isPerformanceObjectiveScope,
  type PerformanceObjectiveScope,
} from '@emgloop/shared';
import { requirePermission } from '../../../../../auth/guard';

const PATH = '/app/admin/administration/objectives';

function backTo(message: string, kind: 'notice' | 'error'): string {
  return PATH + '?' + kind + '=' + encodeURIComponent(message);
}

function text(formData: FormData, key: string): string {
  return String(formData.get(key) ?? '').trim();
}

/**
 * A date-only form input, as a UTC instant — or null when blank.
 *
 * `<input type="date">` posts `YYYY-MM-DD`. `new Date('2026-08-14')` already
 * parses as UTC midnight, which is what we want; an invalid string yields an
 * Invalid Date, and that must become null rather than a NaN timestamp reaching
 * the database.
 */
function dateOrNull(formData: FormData, key: string): Date | null {
  const raw = text(formData, key);
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The submitted scope, or null when it is not one of the two real members. */
function scopeOrNull(formData: FormData): PerformanceObjectiveScope | null {
  const raw = text(formData, 'scope');
  return isPerformanceObjectiveScope(raw) ? raw : null;
}

export async function createObjectiveAction(formData: FormData): Promise<void> {
  const session = await requirePermission('commercialIntelligence', 'create');

  const scope = scopeOrNull(formData);
  if (!scope) {
    redirect(backTo(PERFORMANCE_OBJECTIVE_REJECTION_MESSAGES.SCOPE_INVALID, 'error'));
  }

  const result = await repositories.performanceObjectives.create(session.organizationId, {
    title: text(formData, 'title'),
    description: text(formData, 'description') || null,
    scope,
    // Only read the user field for a USER-scoped objective. A stale hidden value
    // left over from a scope toggle must not silently attach somebody.
    scopeUserId: scope === 'USER' ? text(formData, 'scopeUserId') || null : null,
    effectiveFrom: dateOrNull(formData, 'effectiveFrom'),
    effectiveTo: dateOrNull(formData, 'effectiveTo'),
    createdByUserId: session.userId,
  });

  if (!result.ok) {
    redirect(backTo(PERFORMANCE_OBJECTIVE_REJECTION_MESSAGES[result.reason], 'error'));
  }

  await repositories.audit.record({
    organizationId: session.organizationId,
    userId: session.userId,
    actorName: session.name,
    action: 'performance_objective.created',
    entityType: 'performance_objective',
    entityId: result.objective.id,
    after: { title: result.objective.title, scope: result.objective.scope },
    metadata: { scope: result.objective.scope },
  });

  redirect(backTo(`Objective “${result.objective.title}” added.`, 'notice'));
}

export async function updateObjectiveAction(formData: FormData): Promise<void> {
  const session = await requirePermission('commercialIntelligence', 'update');

  const id = text(formData, 'id');
  if (!id) redirect(backTo('No objective selected.', 'error'));

  const scope = scopeOrNull(formData);
  if (!scope) {
    redirect(backTo(PERFORMANCE_OBJECTIVE_REJECTION_MESSAGES.SCOPE_INVALID, 'error'));
  }

  const result = await repositories.performanceObjectives.update(session.organizationId, id, {
    title: text(formData, 'title'),
    description: text(formData, 'description') || null,
    scope,
    scopeUserId: scope === 'USER' ? text(formData, 'scopeUserId') || null : null,
    effectiveFrom: dateOrNull(formData, 'effectiveFrom'),
    effectiveTo: dateOrNull(formData, 'effectiveTo'),
  });

  // null = the id did not resolve inside this organization. Same answer a
  // genuinely missing objective gets, and no audit row either way.
  if (result === null) {
    redirect(backTo('That objective no longer exists.', 'error'));
  }
  if (!result.ok) {
    redirect(backTo(PERFORMANCE_OBJECTIVE_REJECTION_MESSAGES[result.reason], 'error'));
  }

  await repositories.audit.record({
    organizationId: session.organizationId,
    userId: session.userId,
    actorName: session.name,
    action: 'performance_objective.updated',
    entityType: 'performance_objective',
    entityId: result.objective.id,
    after: { title: result.objective.title, scope: result.objective.scope },
  });

  redirect(backTo(`Objective “${result.objective.title}” updated.`, 'notice'));
}

/**
 * Archive or reactivate. One action for both directions because they are the
 * same lifecycle move; the direction is a form value, validated here.
 */
export async function setObjectiveStatusAction(formData: FormData): Promise<void> {
  const session = await requirePermission('commercialIntelligence', 'update');

  const id = text(formData, 'id');
  if (!id) redirect(backTo('No objective selected.', 'error'));

  const archiving = text(formData, 'status') === 'ARCHIVED';
  const objective = await repositories.performanceObjectives.setStatus(
    session.organizationId,
    id,
    archiving ? 'ARCHIVED' : 'ACTIVE',
  );

  if (!objective) {
    redirect(backTo('That objective no longer exists.', 'error'));
  }

  await repositories.audit.record({
    organizationId: session.organizationId,
    userId: session.userId,
    actorName: session.name,
    action: archiving ? 'performance_objective.archived' : 'performance_objective.reactivated',
    entityType: 'performance_objective',
    entityId: objective.id,
    after: { status: objective.status },
  });

  redirect(
    backTo(
      archiving
        ? `Objective “${objective.title}” archived. It stays on record.`
        : `Objective “${objective.title}” is active again.`,
      'notice',
    ),
  );
}

// --- Commercial Intelligence Stage 2 -----------------------------------------

/**
 * The window a run looks back over, in days.
 *
 * Fixed rather than operator-chosen, because a chooser would be the first
 * feature of a product surface this deliberately is not. It is stated on screen
 * so a reader knows exactly what was examined.
 */
const EVALUATION_WINDOW_DAYS = 30;

/**
 * Evaluate recent observable activity against this organization's objectives.
 *
 * AN ADMINISTRATIVE VALIDATION ACTION, NOT A PRODUCT FEATURE. It exists so the
 * Stage 2 path can be exercised end to end against real data: objective →
 * observation Loop already recorded → deterministic evaluation → Commercial
 * Signal with inspectable provenance. It is not a "run intelligence" button and
 * must not become one.
 *
 * GUARDED BY `commercialIntelligence:update`, the narrowest existing grant that
 * fits: this writes tenant rows, so `view` would be wrong, and no new resource,
 * action or role is invented for it. MANAGER holds `view` only and therefore
 * cannot run it — a consequence of the Stage 1 matrix, not a statement about who
 * manages whom.
 *
 * NOTHING DOWNSTREAM. No headline, no case, no decision, no work item, no
 * notification, no outbound message. It writes Commercial Signals and returns.
 */
export async function evaluateActivityAction(): Promise<void> {
  const session = await requirePermission('commercialIntelligence', 'update');

  const until = new Date();
  const since = new Date(until.getTime() - EVALUATION_WINDOW_DAYS * 86_400_000);

  const service = new CommercialSignalEvaluationService(
    repositories.performanceObjectives,
    repositories.marketplaceCalls,
    repositories.commercialSignals,
  );
  // The organization comes from the signed session and is the only tenant this
  // run can read or write. There is no organization field on the form, because
  // there is no form.
  const summary = await service.evaluateRecentActivity(session.organizationId, { since, until });

  // The run happened, so it is recorded — including a run that concluded
  // nothing, which is a real outcome and not a failed write. What is audited is
  // the OPERATION and its counts; the determinations themselves live in
  // commercial_signals with their own provenance.
  await repositories.audit.record({
    organizationId: session.organizationId,
    userId: session.userId,
    actorName: session.name,
    action: 'commercial_signal.evaluated',
    entityType: 'commercial_signal_evaluation',
    entityId: session.organizationId,
    metadata: {
      windowDays: EVALUATION_WINDOW_DAYS,
      since: since.toISOString(),
      until: until.toISOString(),
      objectivesConsidered: summary.objectivesConsidered,
      observationsExamined: summary.observationsExamined,
      established: summary.established,
      reaffirmed: summary.reaffirmed,
    },
  });

  if (summary.objectivesConsidered === 0) {
    redirect(
      backTo('No active objectives to evaluate against. Add one first.', 'error'),
    );
  }
  if (summary.observationsExamined === 0) {
    // An honest empty state rather than a zero dressed as a result: Loop had
    // nothing to look at, which is different from having looked and found
    // nothing.
    redirect(
      backTo(
        `No recorded activity in the last ${EVALUATION_WINDOW_DAYS} days to evaluate.`,
        'notice',
      ),
    );
  }

  redirect(
    backTo(
      `Evaluated ${summary.observationsExamined} recorded observation${summary.observationsExamined === 1 ? '' : 's'} ` +
        `against ${summary.objectivesConsidered} active objective${summary.objectivesConsidered === 1 ? '' : 's'}: ` +
        `${summary.established} new signal${summary.established === 1 ? '' : 's'}, ` +
        `${summary.reaffirmed} already recorded.`,
      'notice',
    ),
  );
}
