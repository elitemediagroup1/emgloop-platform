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
// NOTHING HERE IS INTELLIGENT. These actions persist typed human intent. No
// scoring, no ranking, no inference, no AI, no measurement of anything.

import { redirect } from 'next/navigation';
import { repositories } from '@emgloop/database';
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
