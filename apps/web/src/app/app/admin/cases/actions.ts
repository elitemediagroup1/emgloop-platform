'use server';

// The governed Case actions, and nothing beside them.
//
// EVERY ONE OF THESE CALLS A MUTATION THAT ALREADY EXISTED. Not one new write
// path, not one new domain rule, and no generic `updateCase`. This file is a
// guard, a session, a form-to-contract translation and a redirect -- the moment
// it starts deciding something, it has become a second authority for a fact the
// backend already owns.
//
// THE FOUR STEPS EVERY GOVERNED ACTION IN THIS REPOSITORY USES:
//
//   1. `requirePermission` at the top, server-side, before anything is read. The
//      UI hiding a control is not access control, and these actions are
//      reachable by anybody who can POST to them.
//   2. The organization comes from the SIGNED SESSION. Never from the form. A
//      field named organizationId would be the vulnerability CLAUDE.md's
//      multi-tenant rules exist to prevent, which is why none is read here.
//   3. The service resolves the row WITHIN that organization and fails closed to
//      not-found. A cross-organization id is not-found, never forbidden, and
//      never reveals whether the object exists.
//   4. The actor is the session's user. `actorUserId` is never read from a form:
//      an action that could name its own actor would make every attributed row
//      on the Case log worthless.
//
// HISTORY LIVES IN THE OWNING DOMAIN. Each of these appends a typed observation
// to the Case's own append-only log through the service that owns it. The
// platform AuditLog stays supplementary -- it is not, and must not become, the
// source of truth for Case state.
//
// NO EXTERNAL ACTION. Nothing here sends, contacts, routes, spends or commits.
// Selecting an option records that a person intends to pursue it; it does not do
// it, and the copy on the screen says so.

import { redirect } from 'next/navigation';

import {
  CaseFindingService,
  CaseMonitoringService,
  CaseParticipationService,
  CaseRecommendationService,
  createDecisionEngine,
  prisma,
} from '@emgloop/database';
import {
  isCaseContribution,
  isOperationalOutcome,
  isRecommendationVerb,
  type MonitoringPlan,
  type RecommendedAction,
} from '@emgloop/shared';

import { requirePermission } from '../../../../auth/guard';

/**
 * Everything a Case action needs, resolved once and identically.
 *
 * `commercialIntelligence:update` IS THE AUTHORING GRANT, deliberately the
 * narrower of the two intelligence resources: `intelligence` governs READING
 * what Loop concluded and is granted down to READ_ONLY. Acting on an
 * investigation is a different act by different people, and the Headline surface
 * already uses this same grant for Investigate and Dismiss.
 */
async function actorFor() {
  const session = await requirePermission('commercialIntelligence', 'update');
  return {
    session,
    // FROM THE SESSION, ALWAYS. Never from the form.
    actor: { type: 'HUMAN' as const, userId: session.userId, source: 'operator' },
  };
}

function text(formData: FormData, key: string): string {
  return String(formData.get(key) ?? '').trim();
}

function backTo(caseId: string, message: string, kind: 'notice' | 'error'): string {
  return (
    '/app/admin/cases/' + encodeURIComponent(caseId) + '?' + kind + '=' + encodeURIComponent(message)
  );
}

/**
 * A redirect is thrown, and must never be swallowed as a validation failure.
 *
 * Next signals navigation by throwing an object carrying `digest`. A catch that
 * treated one as an error would turn every successful action into a misleading
 * message, which is a bug that only shows up on the happy path.
 */
function rethrowRedirect(e: unknown): void {
  if (e && typeof e === 'object' && 'digest' in e) throw e;
}

/**
 * A Case id from a form is an IDENTIFIER, not an authority.
 *
 * It names which row to act on; it grants nothing. Every service below resolves
 * it within the session's organization and returns not-found otherwise, so a
 * pasted id from another tenant lands on exactly the message a deleted one does.
 */
function requireCaseId(formData: FormData): string {
  const caseId = text(formData, 'caseId');
  if (!caseId) {
    redirect('/app/admin/headlines?error=' + encodeURIComponent('No investigation selected.'));
  }
  return caseId;
}

// =========================================================================
// Recommendations
// =========================================================================

/**
 * A person decides to pursue one of the options Loop recorded.
 *
 * SELECTING IS NOT DOING, and it is not approving the finding underneath. The
 * service fills the existing approval columns on that option's own
 * `CognitiveDecision` row and appends `RECOMMENDATION_SELECTED` to the Case log.
 * Every other option is left exactly as Loop wrote it.
 */
export async function selectRecommendationAction(formData: FormData): Promise<void> {
  const { session, actor } = await actorFor();
  const caseId = requireCaseId(formData);
  const optionKey = text(formData, 'optionKey');
  if (!optionKey) redirect(backTo(caseId, 'No option selected.', 'error'));

  const chosen = await new CaseRecommendationService(prisma).select(
    session.organizationId,
    caseId,
    optionKey,
    actor,
  );
  redirect(
    chosen
      ? backTo(caseId, 'Recorded: you are pursuing this option. Nothing has happened outside Loop.', 'notice')
      : backTo(caseId, 'That option is no longer available.', 'error'),
  );
}

/** A person sets an option aside. Loop keeps what it proposed, unchanged. */
export async function dismissRecommendationAction(formData: FormData): Promise<void> {
  const { session, actor } = await actorFor();
  const caseId = requireCaseId(formData);
  const optionKey = text(formData, 'optionKey');
  if (!optionKey) redirect(backTo(caseId, 'No option selected.', 'error'));

  const ok = await new CaseRecommendationService(prisma).dismiss(
    session.organizationId,
    caseId,
    optionKey,
    actor,
  );
  redirect(
    ok
      ? backTo(caseId, 'Set aside. Loop keeps what it proposed as written.', 'notice')
      : backTo(caseId, 'That option is no longer available.', 'error'),
  );
}

/**
 * A person proposes their own version of a sequence.
 *
 * THE MACHINE'S SEQUENCE IS NEVER TOUCHED. The service writes a NEW decision row
 * carrying `author: 'HUMAN'` and `derivedFromDecisionId`, so both versions stand
 * and the screen shows them side by side.
 *
 * FIELDS ARE INDEXED, NOT DELIMITED. `step.0.keep` / `step.0.verb` /
 * `step.0.rest` rather than one encoded string: an unchecked box submits
 * nothing, so parallel `getAll` arrays would silently misalign and a person
 * would remove one step and see a different one disappear.
 *
 * THE FORM CANNOT SMUGGLE AN UNSAFE ACTION PAST THE GUARD. Verbs come from a
 * select over the shipped vocabulary and the statement is composed as
 * `${verb} ${rest}` exactly as the contract requires. The service still runs
 * `validateRecommendationSet`; this only stops a person hitting a rejection they
 * could not have anticipated.
 */
export async function reviseSequenceAction(formData: FormData): Promise<void> {
  const { session, actor } = await actorFor();
  const caseId = requireCaseId(formData);
  const optionKey = text(formData, 'optionKey');
  if (!optionKey) redirect(backTo(caseId, 'No option selected.', 'error'));

  const count = Math.min(50, Math.max(0, Number(text(formData, 'stepCount')) || 0));
  const revised: RecommendedAction[] = [];

  for (let i = 0; i < count; i += 1) {
    // An unchecked checkbox submits nothing at all, which is how a step is
    // removed. There is no "delete" verb in the contract and none is invented.
    if (text(formData, 'step.' + i + '.keep') !== 'on') continue;
    const verb = text(formData, 'step.' + i + '.verb');
    const rest = text(formData, 'step.' + i + '.rest');
    if (!isRecommendationVerb(verb)) {
      redirect(backTo(caseId, 'That step uses a verb Loop cannot record.', 'error'));
    }
    revised.push({
      position: revised.length + 1,
      verb,
      // THE STATEMENT MUST OPEN WITH ITS VERB. Composed here rather than trusted
      // from the form, so the two can never disagree.
      statement: rest ? verb + ' ' + rest : verb,
      intent: null,
    });
  }

  const addRest = text(formData, 'addRest');
  if (addRest) {
    const addVerb = text(formData, 'addVerb');
    if (!isRecommendationVerb(addVerb)) {
      redirect(backTo(caseId, 'Choose a verb Loop can record for the new step.', 'error'));
    }
    revised.push({
      position: revised.length + 1,
      verb: addVerb,
      statement: addVerb + ' ' + addRest,
      intent: null,
    });
  }

  if (revised.length === 0) {
    // An empty sequence is not a revision, it is a deletion -- and the contract
    // has no deletion. Setting the option aside is the act they meant.
    redirect(
      backTo(caseId, 'A revision needs at least one step. To drop the option, set it aside.', 'error'),
    );
  }

  try {
    const result = await new CaseRecommendationService(prisma).revise(
      session.organizationId,
      caseId,
      optionKey,
      revised,
      actor,
    );
    redirect(
      result
        ? backTo(caseId, "Your version is recorded. Loop's original is kept alongside it.", 'notice')
        : backTo(caseId, 'That option is no longer available.', 'error'),
    );
  } catch (e) {
    rethrowRedirect(e);
    // The service's own guard refused it, and its message names the rejection.
    redirect(backTo(caseId, 'Loop cannot record that revision: ' + String((e as Error).message), 'error'));
  }
}

// =========================================================================
// Finding
// =========================================================================

/**
 * A person accepts or rejects the claim.
 *
 * THIS IS NOT EDITING A FINDING. Nothing here changes what the claim SAYS.
 * Acceptance is a governed act on the hypothesis -- the repository refuses an
 * unattributed actor -- and it is the one way a NON_MEASUREMENT claim becomes
 * established, precisely because a person is answerable for it.
 *
 * IT DOES NOT FREEZE AN INVALID CONCLUSION. Establishment for a
 * MEASUREMENT_BACKED claim is derived on every read from live evidence, so a
 * claim whose readiness later degrades stops reading as established regardless
 * of who accepted it. Acceptance is one input to that gate, never a bypass.
 */
export async function judgeFindingAction(formData: FormData): Promise<void> {
  const { session, actor } = await actorFor();
  const caseId = requireCaseId(formData);
  const findingId = text(formData, 'findingId');
  const verdict = text(formData, 'verdict');
  if (!findingId) redirect(backTo(caseId, 'No finding selected.', 'error'));
  if (verdict !== 'ACCEPT' && verdict !== 'REJECT') {
    // No default. Which of the two a person meant is the entire content of the act.
    redirect(backTo(caseId, 'Say whether you accept or reject this claim.', 'error'));
  }

  const findings = new CaseFindingService(prisma);
  const userId = actor.userId;
  const result =
    verdict === 'ACCEPT'
      ? await findings.accept(session.organizationId, findingId, userId)
      : await findings.reject(session.organizationId, findingId, userId);

  redirect(
    result
      ? backTo(
          caseId,
          verdict === 'ACCEPT'
            ? 'Recorded: you accept this claim. Whether Loop can establish it still depends on the evidence.'
            : 'Recorded: you reject this claim. It stays on the investigation as history.',
          'notice',
        )
      : backTo(caseId, 'That claim is no longer available to judge.', 'error'),
  );
}

// =========================================================================
// Participation
// =========================================================================

/**
 * Ask somebody to contribute, or change what they are being asked for.
 *
 * ASKING IS NOT ASSIGNING WORK. This writes a `CaseParticipant` row and appends
 * to the Case log. It creates no work item, no task and no assignee, and the
 * service's own suite already proves Work OS is untouched by it.
 *
 * THE REQUEST IS REQUIRED, because a participant with no stated reason is a name
 * on a list and whoever arrives next has to guess what was wanted from them.
 */
export async function addParticipantAction(formData: FormData): Promise<void> {
  const { session, actor } = await actorFor();
  const caseId = requireCaseId(formData);
  const userId = text(formData, 'userId');
  const contribution = text(formData, 'contribution');
  const request = text(formData, 'request');

  if (!userId) redirect(backTo(caseId, 'Choose who you are asking.', 'error'));
  if (!isCaseContribution(contribution)) {
    redirect(backTo(caseId, 'Choose what you are asking them for.', 'error'));
  }
  if (!request) redirect(backTo(caseId, 'Say what you are asking them for.', 'error'));

  const result = await new CaseParticipationService(prisma).add(session.organizationId, caseId, {
    userId,
    contribution,
    request,
    actor,
  });

  redirect(
    result.outcome === 'ADDED' || result.outcome === 'CHANGED'
      ? backTo(
          caseId,
          result.outcome === 'ADDED'
            ? 'Asked. Nothing was created anywhere else.'
            : 'Updated what you are asking for. The previous request is kept on the log.',
          'notice',
        )
      : backTo(caseId, 'That person or investigation is no longer available.', 'error'),
  );
}

/** Release somebody. What they were asked for is kept. */
export async function releaseParticipantAction(formData: FormData): Promise<void> {
  const { session, actor } = await actorFor();
  const caseId = requireCaseId(formData);
  const userId = text(formData, 'userId');
  const contribution = text(formData, 'contribution');
  if (!userId || !isCaseContribution(contribution)) {
    redirect(backTo(caseId, 'Nobody selected to release.', 'error'));
  }

  const result = await new CaseParticipationService(prisma).release(
    session.organizationId,
    caseId,
    userId,
    contribution,
    actor,
  );
  redirect(
    result.outcome === 'RELEASED'
      ? backTo(caseId, 'Released. What they were asked for is kept.', 'notice')
      : backTo(caseId, 'That person is no longer on this investigation.', 'error'),
  );
}

// =========================================================================
// Monitoring
// =========================================================================

/**
 * Set or correct what Loop is watching.
 *
 * ONE MUTATION FOR BOTH, because the service already distinguishes them: the
 * first plan appends `MONITORING_STARTED` and every later one appends
 * `MONITORING_REVISED`, with every earlier plan kept in full. That is what makes
 * "what did we say we would accept" answerable after the numbers are in, and it
 * is why a correction is an append rather than an edit.
 *
 * THE CRITERIA ARE DECLARED, NOT DERIVED. Loop does not propose them; a person
 * writes down what would count before the answer is known, which is the only
 * reason a verdict later means anything.
 */
export async function reviseMonitoringAction(formData: FormData): Promise<void> {
  const { session, actor } = await actorFor();
  const caseId = requireCaseId(formData);

  const condition = text(formData, 'condition');
  const metric = text(formData, 'metric');
  const successStatement = text(formData, 'successStatement');
  const failureStatement = text(formData, 'failureStatement');
  const start = text(formData, 'observationStart');
  const end = text(formData, 'observationEnd');

  if (!condition || !metric || !successStatement || !failureStatement || !start || !end) {
    redirect(
      backTo(caseId, 'A monitoring plan needs a condition, a metric, both criteria and a window.', 'error'),
    );
  }
  if (Number.isNaN(Date.parse(start)) || Number.isNaN(Date.parse(end))) {
    redirect(backTo(caseId, 'That observation window is not a pair of real dates.', 'error'));
  }
  if (Date.parse(end) <= Date.parse(start)) {
    redirect(backTo(caseId, 'The window has to end after it starts.', 'error'));
  }

  const num = (key: string): number | null => {
    const raw = text(formData, key);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  const successThreshold = num('successThreshold');
  const failureThreshold = num('failureThreshold');
  if (successThreshold === null || failureThreshold === null) {
    redirect(backTo(caseId, 'Both criteria need a number to compare against.', 'error'));
  }
  const baselineValue = num('baselineValue');

  const plan: MonitoringPlan = {
    condition,
    // NULL IS A REAL ANSWER. A monitor with no baseline can still detect a
    // threshold breach; it cannot report a recovery, and the assessor says so
    // rather than inventing a starting point.
    baseline:
      baselineValue === null
        ? null
        : {
            metric,
            value: baselineValue,
            unit: text(formData, 'baselineUnit') || 'RATIO',
            denominator: null,
          },
    success: {
      metric,
      comparison: text(formData, 'successComparison') === 'AT_OR_BELOW' ? 'AT_OR_BELOW' : 'AT_OR_ABOVE',
      threshold: successThreshold,
      statement: successStatement,
    },
    failure: {
      metric,
      comparison: text(formData, 'failureComparison') === 'AT_OR_ABOVE' ? 'AT_OR_ABOVE' : 'AT_OR_BELOW',
      threshold: failureThreshold,
      statement: failureStatement,
    },
    observationStart: new Date(start).toISOString(),
    observationEnd: new Date(end).toISOString(),
    requires: {
      minimumObservations: Math.max(1, Math.round(num('minimumObservations') ?? 1)),
      minimumCoverage: num('minimumCoverage'),
      requiresCompleteWindow: text(formData, 'requiresCompleteWindow') === 'on',
    },
    plannedByUserId: actor.userId,
    plannedAt: new Date().toISOString(),
    note: text(formData, 'note') || null,
  };

  const result = await new CaseMonitoringService(prisma).start(
    session.organizationId,
    caseId,
    plan,
    actor,
  );
  redirect(
    result.outcome === 'STARTED' || result.outcome === 'REVISED'
      ? backTo(
          caseId,
          result.outcome === 'STARTED'
            ? 'Loop is watching this. What would count was written down before the answer.'
            : 'Plan corrected. Every earlier version is kept in full.',
          'notice',
        )
      : backTo(caseId, 'That investigation is no longer available.', 'error'),
  );
}

// =========================================================================
// Lifecycle
// =========================================================================

/**
 * Close an investigation.
 *
 * TWO WAYS TO CLOSE, AND THE DIFFERENCE IS THE POINT. `resolve` means somebody
 * acted; `ignore` means it did not need action. Both take an OUTCOME, because
 * "closed" alone says what the operator did and nothing about what was true, and
 * only the second is worth anything a year later.
 *
 * A SECOND PRESS IS A REAL ANSWER, NOT A FAILURE. The engine refuses to close
 * something already closed, and two people pressing at once converge on that
 * message rather than producing two closes.
 */
export async function closeCaseAction(formData: FormData): Promise<void> {
  const { session, actor } = await actorFor();
  const caseId = requireCaseId(formData);
  const outcome = text(formData, 'outcome');
  const acted = text(formData, 'acted') === 'yes';
  const reason = text(formData, 'reason');

  if (!isOperationalOutcome(outcome)) {
    // No default. The outcome is the whole content of a close.
    redirect(backTo(caseId, 'Say what actually happened before closing this.', 'error'));
  }
  if (!reason) {
    redirect(backTo(caseId, 'Say why you are closing this. It goes on the record.', 'error'));
  }

  const engine = createDecisionEngine(prisma);
  try {
    if (acted) {
      await engine.resolve(session.organizationId, caseId, { actor, outcome, reason });
    } else {
      await engine.ignore(session.organizationId, caseId, { actor, outcome, reason });
    }
  } catch (e) {
    rethrowRedirect(e);
    redirect(backTo(caseId, 'This investigation is already closed, or is no longer available.', 'error'));
  }
  redirect(backTo(caseId, acted ? 'Resolved.' : 'Closed without acting.', 'notice'));
}

/**
 * Bring a closed investigation back.
 *
 * THE EARLIER RESOLUTION SURVIVES. The projection clears `resolvedAt` and
 * increments `reopenCount`, and both the close and the reopen stay on the log --
 * a resolution that did not hold is the most informative event a Case can carry,
 * and it must never be silently overwritten.
 */
export async function reopenCaseAction(formData: FormData): Promise<void> {
  const { session, actor } = await actorFor();
  const caseId = requireCaseId(formData);
  const reason = text(formData, 'reason');
  if (!reason) redirect(backTo(caseId, 'Say why this is being reopened.', 'error'));

  const engine = createDecisionEngine(prisma);
  try {
    await engine.reopen(session.organizationId, caseId, { actor, reason });
  } catch (e) {
    rethrowRedirect(e);
    redirect(backTo(caseId, 'This investigation is already open, or is no longer available.', 'error'));
  }
  redirect(backTo(caseId, 'Reopened. The earlier resolution is kept on the log.', 'notice'));
}
