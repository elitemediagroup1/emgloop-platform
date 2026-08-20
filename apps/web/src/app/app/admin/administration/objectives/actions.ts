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
import { repositories, CommercialSignalEvaluationService, HeadlineDetectionService } from '@emgloop/database';
import {
  BINDING_REJECTION_MESSAGES,
  COMPARISON_SPAN_DAYS,
  HEADLINE_DISMISSAL_BASIS_LABELS,
  MEASURE_METRIC_DEFINITIONS,
  PERFORMANCE_OBJECTIVE_REJECTION_MESSAGES,
  isBindingDimension,
  isHeadlineDismissalBasis,
  isPerformanceObjectiveScope,
  type BindingDimension,
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

// --- Commercial Intelligence Stage 3 v1 --------------------------------------
//
// Three actions: confirm what an objective means in measurable terms, run the
// deterministic detector over the last two complete weeks, and record that a
// human did not need a Headline.
//
// NONE OF THEM CREATE A DECISION. No OperationalPriority, no DecisionEvidence, no
// work item, no notification, no event. Promotion from a Headline into a Decision
// is Stage 3 v1.1 and no action here anticipates it.

/**
 * Confirm what Loop should measure for one objective.
 *
 * THE SELECTION IS THE DEFINITION. This action stores exactly what a person
 * ticked. It parses no label, infers no vertical, derives no geography and reads
 * no Commercial Signal — a signal is a lexical relevance determination, and using
 * one as a measurement population would make a documented limitation into a
 * percentage.
 *
 * IMMUTABLE AFTER CONFIRMATION. There is no edit action and there must not be.
 * Confirming again writes a new version and supersedes the old, so every Headline
 * ever produced keeps the exact definition it was produced under.
 *
 * GUARDED BY `commercialIntelligence:update` — the same grant Stage 2's
 * evaluation uses. No new resource, action or role is invented.
 */
export async function confirmMeasureBindingAction(formData: FormData): Promise<void> {
  const session = await requirePermission('commercialIntelligence', 'update');

  const objectiveId = text(formData, 'objectiveId');
  if (!objectiveId) redirect(backTo('No objective selected.', 'error'));

  // Each checkbox posts "<DIMENSION>:<externalId>", and the matching hidden field
  // carries the label as it read on screen. The label travels for display only;
  // the external id is the identity, which is why a member the provider never
  // identified is not offered in the first place.
  const members: Array<{ dimension: BindingDimension; externalId: string; label: string | null }> = [];
  for (const raw of formData.getAll('member')) {
    const value = String(raw ?? '').trim();
    if (!value) continue;
    const at = value.indexOf(':');
    if (at <= 0) continue;
    const dimension = value.slice(0, at);
    const externalId = value.slice(at + 1);
    if (!isBindingDimension(dimension) || !externalId) continue;
    const label = String(formData.get(`label:${value}`) ?? '').trim();
    members.push({ dimension, externalId, label: label || null });
  }

  // EMPTY MEANS NO RESTRICTION. A caller-state filter is opt-in, and its absence
  // is never read as "unknown" or as a filter matching nothing. One comma- or
  // space-separated field rather than a picker, because Loop has no canonical
  // list of states and offering one it invented would be a fabricated taxonomy;
  // the shape validator rejects anything that is not a two-letter code.
  const callerStates = text(formData, 'callerState')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const result = await repositories.measureBindings.confirm(session.organizationId, {
    performanceObjectiveId: objectiveId,
    metric: text(formData, 'metric'),
    direction: text(formData, 'direction'),
    members,
    callerStates,
    confirmedByUserId: session.userId,
  });

  // null = the objective did not resolve inside this organization. Same answer a
  // genuinely missing objective gets, and no audit row either way.
  if (result === null) {
    redirect(backTo('That objective no longer exists.', 'error'));
  }
  if (!result.ok) {
    redirect(backTo(BINDING_REJECTION_MESSAGES[result.reason], 'error'));
  }

  await repositories.audit.record({
    organizationId: session.organizationId,
    userId: session.userId,
    actorName: session.name,
    action: 'objective_measure_binding.confirmed',
    entityType: 'objective_measure_binding',
    entityId: result.binding.id,
    after: {
      metric: result.binding.metric,
      direction: result.binding.direction,
      memberCount: result.binding.members.length,
      callerStates: result.binding.callerStates,
      version: result.binding.version,
    },
    metadata: { supersededBindingId: result.supersededBindingId },
  });

  redirect(
    backTo(
      `Loop will measure ${MEASURE_METRIC_DEFINITIONS[result.binding.metric].label.toLowerCase()} ` +
        `for this objective across ${result.binding.members.length} selected item` +
        `${result.binding.members.length === 1 ? '' : 's'}` +
        `${result.supersededBindingId ? ' (version ' + result.binding.version + '; the previous definition is kept on record)' : ''}.`,
      'notice',
    ),
  );
}

/**
 * Stop measuring an objective, without replacing the definition.
 *
 * Leaves it NOT MEASURABLE YET, which is a legitimate state rather than an error.
 * Past Headlines are untouched and keep the binding version they were produced
 * under.
 */
export async function retireMeasureBindingAction(formData: FormData): Promise<void> {
  const session = await requirePermission('commercialIntelligence', 'update');

  const bindingId = text(formData, 'bindingId');
  if (!bindingId) redirect(backTo('No measure selected.', 'error'));

  const retired = await repositories.measureBindings.retire(session.organizationId, bindingId);
  if (!retired) {
    redirect(backTo('That measure is no longer active.', 'error'));
  }

  await repositories.audit.record({
    organizationId: session.organizationId,
    userId: session.userId,
    actorName: session.name,
    action: 'objective_measure_binding.retired',
    entityType: 'objective_measure_binding',
    entityId: retired.id,
    after: { version: retired.version, supersededAt: retired.supersededAt },
  });

  redirect(backTo('Loop is no longer measuring that objective. Past headlines are kept.', 'notice'));
}

/**
 * Run the deterministic detector over the last two complete weeks.
 *
 * AN ADMINISTRATIVE VALIDATION ACTION, NOT A PRODUCT FEATURE — the same standing
 * `evaluateActivityAction` has. It exists so the Stage 3 path can be exercised end
 * to end against real data: objective → confirmed binding → aggregate → measured
 * change → materiality rule → Headline. It is not a "run intelligence" button and
 * must not become one.
 *
 * NOTHING DOWNSTREAM. No decision, no evidence, no work item, no notification, no
 * outbound message, no event. It writes Headlines and returns.
 */
export async function detectHeadlinesAction(): Promise<void> {
  const session = await requirePermission('commercialIntelligence', 'update');

  const service = new HeadlineDetectionService(
    repositories.performanceObjectives,
    repositories.measureBindings,
    repositories.marketplaceCalls,
    repositories.headlines,
    repositories.providerObservations,
    repositories.providerReconciliations,
    repositories.measurementSources,
  );
  // The organization comes from the signed session and is the only tenant this
  // run can read or write. The clock is passed in; the service never reads one.
  const summary = await service.detect(session.organizationId, new Date());

  // The run happened, so it is recorded — including a run that concluded nothing,
  // which is a real outcome and not a failed write.
  await repositories.audit.record({
    organizationId: session.organizationId,
    userId: session.userId,
    actorName: session.name,
    action: 'headline.detected',
    entityType: 'headline_detection_run',
    entityId: session.organizationId,
    metadata: {
      comparisonSpanDays: COMPARISON_SPAN_DAYS,
      currentWindowStart: summary.currentWindowStart.toISOString(),
      currentWindowEnd: summary.currentWindowEnd.toISOString(),
      priorWindowStart: summary.priorWindowStart.toISOString(),
      priorWindowEnd: summary.priorWindowEnd.toISOString(),
      objectivesConsidered: summary.objectivesConsidered,
      objectivesMeasurable: summary.objectivesMeasurable,
      established: summary.established,
      resighted: summary.resighted,
      alreadyRecorded: summary.alreadyRecorded,
      withheld: summary.withheld,
      // What the run could actually see. Recorded on every run, including the ones
      // that measured normally, so "Loop found nothing" and "Loop could not look"
      // are distinguishable in the audit trail months later rather than only in
      // whatever was on screen at the time.
      observationRuleVersion: summary.observation.ruleVersion,
      observedDayCount: summary.observation.observedDayCount,
      comparisonDayCount: summary.observation.dates.length,
      unobservedDates: summary.observation.uncertified.map((u) => u.businessDate),
    },
  });

  if (summary.objectivesConsidered === 0) {
    redirect(backTo('No active objectives to measure. Add one first.', 'error'));
  }
  if (summary.objectivesMeasurable === 0) {
    // An honest empty state. Loop had nothing it was allowed to measure, which is
    // different from having measured and found nothing.
    redirect(
      backTo(
        'No objective has a confirmed measure yet, so there was nothing to measure. Choose what Loop should measure for an objective first.',
        'notice',
      ),
    );
  }

  const nothing = summary.established === 0 && summary.resighted === 0;
  redirect(
    backTo(
      `Measured ${summary.objectivesMeasurable} objective${summary.objectivesMeasurable === 1 ? '' : 's'} ` +
        `over the last ${COMPARISON_SPAN_DAYS} complete days against the ${COMPARISON_SPAN_DAYS} before them: ` +
        `${summary.established} new headline${summary.established === 1 ? '' : 's'}, ` +
        `${summary.resighted} still happening, ` +
        `${summary.withheld} below the threshold or not measurable.` +
        (nothing ? ' Nothing crossed the threshold, which is a result rather than a failure.' : ''),
      'notice',
    ),
  );
}

/**
 * Record that a human did not need a Headline.
 *
 * ATTENTION FEEDBACK, NOT AN OUTCOME. `WRONG` says the measurement or the
 * population was incorrect and Loop should retune detection; `IMMATERIAL` says it
 * was correct and still not worth surfacing, and Loop should retune attention.
 * There is no ACCEPTED_RISK and no NO_ACTION_NEEDED here: both assert what the
 * organization will DO, which is a Decision's vocabulary.
 *
 * Dismissal never reopens and never stops recurrence. A dismissed Headline keeps
 * accumulating sightings, because how long a condition somebody called immaterial
 * persisted is exactly the fact that says whether that call was right.
 */
export async function dismissHeadlineAction(formData: FormData): Promise<void> {
  const session = await requirePermission('commercialIntelligence', 'update');

  const headlineId = text(formData, 'headlineId');
  if (!headlineId) redirect(backTo('No headline selected.', 'error'));

  const basisRaw = text(formData, 'basis');
  if (!isHeadlineDismissalBasis(basisRaw)) {
    // Deliberately no default. Which of the two a person meant is the entire
    // value of the feedback, and guessing it would corrupt the only signal Loop
    // gets about whether it earns attention.
    redirect(backTo('Say whether Loop got this wrong, or whether it was simply not worth surfacing.', 'error'));
  }

  const dismissed = await repositories.headlines.dismiss(session.organizationId, headlineId, {
    basis: basisRaw,
    userId: session.userId,
    at: new Date(),
  });

  if (!dismissed) {
    redirect(backTo('That headline no longer exists, or was already dismissed.', 'error'));
  }

  await repositories.audit.record({
    organizationId: session.organizationId,
    userId: session.userId,
    actorName: session.name,
    action: 'headline.dismissed',
    entityType: 'headline',
    entityId: dismissed.id,
    after: { dismissalBasis: dismissed.dismissalBasis, detectionCount: dismissed.detectionCount },
  });

  redirect(
    backTo(
      `Recorded: ${HEADLINE_DISMISSAL_BASIS_LABELS[basisRaw].toLowerCase()}. Loop keeps watching whether it persists.`,
      'notice',
    ),
  );
}
