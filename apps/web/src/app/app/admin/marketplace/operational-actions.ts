'use server';

// The decision lifecycle — the actions that make the queue a queue.
//
// EVERY ACTION FOLLOWS THE SAME FIVE STEPS, deliberately, so there is no
// interesting one to get wrong:
//
//   1. `requirePermission('intelligence', 'update')` — server-side, at the top,
//      before anything is read. The UI hiding a button is not access control.
//   2. The organization comes from the signed session. Never from the form.
//      A form field named organizationId would be a vulnerability, which is why
//      no action here reads one.
//   3. The priority is resolved WITHIN that organization by the repository, which
//      fails closed to null. A cross-org id is not-found, never forbidden.
//   4. The DECISION ENGINE performs the write. These actions never touch a
//      repository, never append an observation themselves and never write a
//      projection column — the engine owns the transaction, the projection and
//      the domain event, and doing any of it here would skip the other two.
//   5. The affected routes are revalidated.
//
// There is no action that edits or deletes an observation, because there is no
// repository method that could. A queue whose history can be rewritten is worth
// less than no history at all.

import { revalidatePath } from 'next/cache';

import { requirePermission } from '../../../../auth/guard';
import { decisionEngine, repositories } from '@emgloop/database';
import type { OperationalOutcome, OperationalObservationType } from '@emgloop/database';
import { OPERATIONAL_OUTCOMES } from '@emgloop/shared';

const MARKETPLACE_ROOT = '/app/admin/marketplace';

/** Where the operator was, so they land back on the same period after acting. */
function backTo(formData: FormData): string {
  const raw = String(formData.get('returnTo') ?? '').trim();
  // Only ever an in-app marketplace path. A returnTo that can point anywhere is
  // an open redirect, and this one is written into a redirect-shaped API.
  if (!raw.startsWith(MARKETPLACE_ROOT)) return MARKETPLACE_ROOT;
  if (raw.includes('//') || raw.includes('\\')) return MARKETPLACE_ROOT;
  return raw;
}

function requiredField(formData: FormData, name: string): string {
  const value = String(formData.get(name) ?? '').trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function optionalText(formData: FormData, name: string, max = 2_000): string | null {
  const value = String(formData.get(name) ?? '').trim();
  if (!value) return null;
  return value.slice(0, max);
}

/**
 * Parse an outcome from the form, failing closed to UNKNOWN.
 *
 * UNKNOWN is a real answer, not a fallback for laziness: an operator closing
 * something they genuinely cannot classify must be able to say so, and forcing a
 * choice would put invented values into the exact dataset Loop will later use to
 * measure whether its own recommendations were any good.
 */
function parseOutcome(formData: FormData, name = 'outcome'): OperationalOutcome {
  const raw = String(formData.get(name) ?? '').trim();
  return (OPERATIONAL_OUTCOMES as readonly string[]).includes(raw)
    ? (raw as OperationalOutcome)
    : 'UNKNOWN';
}

/**
 * Parse a measured business effect in dollars into cents.
 *
 * Returns null for anything that is not a finite number, INCLUDING an empty
 * field. Null means "not measured" and renders as such; it must never become 0,
 * because "$0 recovered" is a claim about the world and "nobody measured it" is
 * not.
 */
function parseEffectCents(formData: FormData, name = 'effectDollars'): number | null {
  const raw = String(formData.get(name) ?? '').trim();
  if (!raw) return null;
  const parsed = Number(raw.replace(/[$,\s]/g, ''));
  if (!Number.isFinite(parsed)) return null;
  return Math.round(parsed * 100);
}

/** The one write path. Every action below is a thin, named wrapper over it. */
async function record(
  formData: FormData,
  observationType: OperationalObservationType,
  build: (formData: FormData) => {
    note?: string | null;
    reason?: string | null;
    outcome?: OperationalOutcome | null;
    measuredEffectCents?: number | null;
    measuredEffectBasis?: string | null;
  } = () => ({}),
): Promise<void> {
  const session = await requirePermission('intelligence', 'update');
  const priorityId = requiredField(formData, 'priorityId');

  await decisionEngine.addObservation(session.organizationId, priorityId, {
    observationType,
    // The operator is recording something as it happens. A backdating control is
    // deliberately absent: it would let the durations Loop reports be shaped by
    // hand, and nothing here needs it.
    actor: { type: 'HUMAN', userId: session.userId, source: 'operator' },
    ...build(formData),
  });

  revalidatePath(MARKETPLACE_ROOT);
  revalidatePath(backTo(formData));
}

// --- Reviewing --------------------------------------------------------------

/**
 * Record that a human read it.
 *
 * Does NOT clear the item from the queue — that is the point. This queue is
 * cleared by deciding, not by reading, and the distinction between "nobody has
 * looked at this" and "somebody looked and chose not to act yet" is exactly the
 * thing an operations lead needs to know.
 */
export async function markReviewedAction(formData: FormData): Promise<void> {
  await record(formData, 'REVIEWED', (f) => ({ note: optionalText(f, 'note') }));
}

// --- Ownership --------------------------------------------------------------

export async function assignAction(formData: FormData): Promise<void> {
  const session = await requirePermission('intelligence', 'update');
  const priorityId = requiredField(formData, 'priorityId');
  const assignee = requiredField(formData, 'assignedToUserId');

  // The assignee must be a real member of THIS organization. Without this check
  // the form could name any user id on the platform and the queue would show an
  // owner from another tenant — a cross-tenant write dressed as an assignment.
  const members = await repositories.iam.listUsers(session.organizationId);
  if (!members.some((m) => m.id === assignee && m.status === 'ACTIVE')) {
    throw new Error('That person is not an active member of this organization');
  }

  // The engine decides whether this is a first assignment or a handover, and
  // resolves the decision within the organization. A cross-org id throws
  // DecisionNotFoundError, which is not-found rather than forbidden.
  try {
    await decisionEngine.assign(session.organizationId, priorityId, {
      actor: { type: 'HUMAN', userId: session.userId, source: 'operator' },
      assigneeUserId: assignee,
      note: optionalText(formData, 'note'),
    });
  } catch (e) {
    if ((e as { code?: string })?.code === 'DECISION_NOT_FOUND') return;
    throw e;
  }

  revalidatePath(MARKETPLACE_ROOT);
  revalidatePath(backTo(formData));
}

// --- Watching ---------------------------------------------------------------

export async function watchAction(formData: FormData): Promise<void> {
  await record(formData, 'WATCH_STARTED', (f) => ({ note: optionalText(f, 'note') }));
}

export async function escalateDecisionAction(formData: FormData): Promise<void> {
  await record(formData, 'ESCALATED', (f) => ({ note: optionalText(f, 'note') }));
}

export async function stopWatchingAction(formData: FormData): Promise<void> {
  await record(formData, 'WATCH_STOPPED', (f) => ({ note: optionalText(f, 'note') }));
}

// --- Progress ---------------------------------------------------------------

export async function addNoteAction(formData: FormData): Promise<void> {
  const note = optionalText(formData, 'note');
  if (!note) return; // An empty note is not an event.
  await record(formData, 'NOTE_ADDED', () => ({ note }));
}

export async function recordContactAction(formData: FormData): Promise<void> {
  const reached = String(formData.get('reached') ?? '') === 'yes';
  await record(formData, reached ? 'CONTACT_COMPLETED' : 'CONTACT_ATTEMPTED', (f) => ({
    note: optionalText(f, 'note'),
  }));
}

export async function awaitResponseAction(formData: FormData): Promise<void> {
  await record(formData, 'AWAITING_RESPONSE', (f) => ({ note: optionalText(f, 'note') }));
}

export async function recordResponseAction(formData: FormData): Promise<void> {
  await record(formData, 'RESPONSE_RECEIVED', (f) => ({ note: optionalText(f, 'note') }));
}

export async function escalateAction(formData: FormData): Promise<void> {
  await record(formData, 'ESCALATED', (f) => ({ note: optionalText(f, 'note') }));
}

// --- Outcome ----------------------------------------------------------------

/**
 * Record what actually happened, without closing the item.
 *
 * The measured effect is a number the operator OBSERVED — money that came back,
 * volume that resumed. Loop does not compute it and never estimates it, because
 * the counterfactual (what would have happened anyway) is not something it can
 * see. `measuredEffectBasis` carries the operator's own words for where the
 * figure came from, so a reader can judge it later.
 */
export async function recordOutcomeAction(formData: FormData): Promise<void> {
  await record(formData, 'OUTCOME_RECORDED', (f) => ({
    outcome: parseOutcome(f),
    measuredEffectCents: parseEffectCents(f),
    measuredEffectBasis: optionalText(f, 'effectBasis', 500),
    note: optionalText(f, 'note'),
  }));
}

// --- Closing ----------------------------------------------------------------

export async function resolveAction(formData: FormData): Promise<void> {
  const session = await requirePermission('intelligence', 'update');
  const priorityId = requiredField(formData, 'priorityId');
  await decisionEngine.resolve(session.organizationId, priorityId, {
    actor: { type: 'HUMAN', userId: session.userId, source: 'operator' },
    outcome: parseOutcome(formData),
    measuredEffectCents: parseEffectCents(formData),
    measuredEffectBasis: optionalText(formData, 'effectBasis', 500),
    note: optionalText(formData, 'note'),
  });
  revalidatePath(MARKETPLACE_ROOT);
  revalidatePath(backTo(formData));
}

/**
 * Close without acting.
 *
 * The outcome here is the honest part: FALSE_POSITIVE says Loop should not have
 * raised it, ACCEPTED_RISK says it was real and the business chose to live with
 * it, NOT_ACTIONABLE says it was real and nothing could be done. Those are three
 * completely different verdicts on the intelligence, and collapsing them into
 * "dismissed" would destroy the only feedback Loop gets about its own accuracy.
 */
export async function dismissAction(formData: FormData): Promise<void> {
  const session = await requirePermission('intelligence', 'update');
  const priorityId = requiredField(formData, 'priorityId');
  // `ignore` is the action; the OUTCOME carries why. "Dismissed" alone records
  // what the operator did and nothing about what was true.
  await decisionEngine.ignore(session.organizationId, priorityId, {
    actor: { type: 'HUMAN', userId: session.userId, source: 'operator' },
    outcome: parseOutcome(formData),
    reason: optionalText(formData, 'note'),
    note: optionalText(formData, 'note'),
  });
  revalidatePath(MARKETPLACE_ROOT);
  revalidatePath(backTo(formData));
}
