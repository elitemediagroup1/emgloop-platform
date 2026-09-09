// The Stage 4 semantic event vocabulary, and the one place that knows what the
// rows written before it meant.
//
// WHAT THIS REPLACES. Stage 4 shipped ten distinct meanings on two generic
// observation types. "A finding was recorded", "a person was released from an
// investigation", "somebody selected one of Loop's options" were all
// `NOTE_ADDED`, separated only by an exact English sentence in `reason`. Four
// files each carried their own predicate matching that sentence, and every one
// of them documented the same debt in its header. This module retires it: the
// meaning now lives in `OperationalObservationType`, which is a database enum
// and therefore a governed fact.
//
// WHY THAT MATTERED, CONCRETELY. A downstream reader had exactly two ways to
// learn that a human authorized an investigation: import a predicate from
// `@emgloop/shared`, or compare a paragraph of prose it had copied. The second
// works until somebody fixes a typo in the sentence, at which point the history
// silently stops being readable and no test fails. Prose is written for people;
// behaviour must not depend on it.
//
// THE REASON LINE STAYS, AND IS NOW ONLY WHAT IT CLAIMS TO BE. Every event
// below still writes its sentence onto the observation, because a person
// reading a timeline needs to know what the row means and `PARTICIPANT_RELEASED`
// is not an explanation. It is description. Nothing reads it back.
//
// THE OLD ROWS ARE STILL RIGHT. Production history written before the migration
// carries the generic type and the sentence, and it is not rewritten — a
// migration that edited history to match a newer vocabulary would be forging the
// record. `caseEventKind` recognises both shapes: the typed member first, the
// legacy pair second. That fallback is marked legacy in one place so it can be
// deleted when the last pre-migration row ages out, rather than living on in
// four files that each believe they are the only one doing it.

import type { ObservationType } from './operational-lifecycle';

/**
 * The Stage 4 meanings a Case's log can carry.
 *
 * SMALLEST COHERENT SET, ARRIVED AT BY AUDIT RATHER THAN BY GUESS. Every member
 * here is a meaning the repository was ALREADY recording and already had to tell
 * apart; none was invented for symmetry. Three shapes that looked like obvious
 * additions are deliberately absent:
 *
 *   · FINDING_ACCEPTED / FINDING_REJECTED. `CaseFindingService.accept` and
 *     `.reject` write to the hypothesis, not to the Case log — acceptance is a
 *     property of the claim, and duplicating it onto the Case would create a
 *     second place to ask whether a Finding was accepted.
 *   · RECOMMENDATION_APPROVED. Approval is `CognitiveDecision.requiresApproval`
 *     plus `approvedAt`/`approvedBy`, which already exist and are already
 *     authoritative. Selecting an option is not approving it, and this
 *     vocabulary must not blur the two.
 *   · A generic CASE_EVENT with a subtype field. That is the debt being retired,
 *     wearing a column instead of a sentence.
 */
export const CASE_EVENT_KINDS = [
  'INVESTIGATION_AUTHORIZED',
  'FINDING_RECORDED',
  'FINDING_SUPERSEDED',
  'RECOMMENDATION_RECORDED',
  'RECOMMENDATION_SELECTED',
  'RECOMMENDATION_DISMISSED',
  'RECOMMENDATION_REVISED',
  'PARTICIPANT_ADDED',
  'PARTICIPANT_CHANGED',
  'PARTICIPANT_RELEASED',
] as const;

export type CaseEventKind = (typeof CASE_EVENT_KINDS)[number];

export function isCaseEventKind(value: string): value is CaseEventKind {
  return (CASE_EVENT_KINDS as readonly string[]).includes(value);
}

/**
 * The observation type each meaning is written as, from this build onwards.
 *
 * ONE-TO-ONE, AND THAT IS THE POINT. The map is an identity today because the
 * vocabulary was designed to make it one: if two meanings shared a type, a
 * reader would be back to separating them by something else. It exists as a map
 * rather than as a naming convention so that "which type carries this meaning"
 * is answerable by reading a value instead of by trusting that two identifiers
 * happen to be spelled the same.
 */
export const CASE_EVENT_TYPE: Record<CaseEventKind, ObservationType> = {
  INVESTIGATION_AUTHORIZED: 'INVESTIGATION_AUTHORIZED',
  FINDING_RECORDED: 'FINDING_RECORDED',
  FINDING_SUPERSEDED: 'FINDING_SUPERSEDED',
  RECOMMENDATION_RECORDED: 'RECOMMENDATION_RECORDED',
  RECOMMENDATION_SELECTED: 'RECOMMENDATION_SELECTED',
  RECOMMENDATION_DISMISSED: 'RECOMMENDATION_DISMISSED',
  RECOMMENDATION_REVISED: 'RECOMMENDATION_REVISED',
  PARTICIPANT_ADDED: 'PARTICIPANT_ADDED',
  PARTICIPANT_CHANGED: 'PARTICIPANT_CHANGED',
  PARTICIPANT_RELEASED: 'PARTICIPANT_RELEASED',
};

// --- The human-readable line -------------------------------------------------------------

/**
 * What each event says on a timeline a person is reading.
 *
 * DESCRIPTIVE, NOT AUTHORITATIVE. These sentences are written onto every new
 * observation and read back by nobody. They are here rather than in the four
 * feature modules so that the legacy signatures below sit next to the text they
 * have to match, where a well-meaning copy-edit is visibly a compatibility
 * change rather than a wording change.
 *
 * Each one is verbatim what the corresponding pre-migration build wrote, so a
 * timeline spanning the migration reads continuously.
 */
export const CASE_EVENT_REASONS: Record<CaseEventKind, string> = {
  INVESTIGATION_AUTHORIZED:
    'A person authorized this Headline for organizational investigation. ' +
    'That is a decision to look into it, not a judgement that it is correct.',
  FINDING_RECORDED:
    'Loop recorded a finding on this investigation. A finding is a claim about what is ' +
    'happening, not a decision about what to do.',
  FINDING_SUPERSEDED:
    'A newer finding replaced the previous one on this investigation. The previous finding is ' +
    'kept in full.',
  RECOMMENDATION_RECORDED:
    'Loop recorded what could be done about this finding. These are options for a person to ' +
    'weigh, not decisions, and nothing here has been approved or acted on.',
  RECOMMENDATION_SELECTED:
    'A person selected one of the options Loop proposed. Selecting is a decision to pursue it; ' +
    'it is not the same as having done it, and it changes nothing outside Loop.',
  RECOMMENDATION_DISMISSED:
    'A person set one of the options aside. Loop keeps what it proposed exactly as it was.',
  RECOMMENDATION_REVISED:
    'A person revised one of the options. The version Loop proposed is kept unchanged alongside it.',
  PARTICIPANT_ADDED:
    'A person was asked to contribute to this investigation. Being asked is not being ' +
    'assigned work, and nothing was created anywhere else.',
  PARTICIPANT_CHANGED:
    'What a person is being asked to contribute to this investigation changed. The previous ' +
    'request is kept on this log.',
  PARTICIPANT_RELEASED:
    'A person was released from this investigation. What they were asked for is kept.',
};

// --- Legacy compatibility ------------------------------------------------------------------

/**
 * LEGACY. How each meaning was written BEFORE the vocabulary migration.
 *
 * DO NOT ADD TO THIS. A new Stage 4 meaning gets a typed member and no entry
 * here; an entry here exists only because rows already in the database carry
 * that shape and cannot be changed. This table is a read of history, not a
 * writing convention.
 *
 * WHEN IT CAN GO. When no `operational_observations` row predates the vocabulary
 * migration — which is checkable with a single query on `createdAt` — this
 * constant and the fallback in `caseEventKind` delete together, and the four
 * feature predicates keep working unchanged because they never look here
 * directly.
 */
export const LEGACY_CASE_EVENT_SIGNATURES: Record<
  CaseEventKind,
  { observationType: ObservationType; reason: string }
> = {
  INVESTIGATION_AUTHORIZED: {
    observationType: 'REVIEWED',
    reason: CASE_EVENT_REASONS.INVESTIGATION_AUTHORIZED,
  },
  FINDING_RECORDED: { observationType: 'NOTE_ADDED', reason: CASE_EVENT_REASONS.FINDING_RECORDED },
  FINDING_SUPERSEDED: {
    observationType: 'NOTE_ADDED',
    reason: CASE_EVENT_REASONS.FINDING_SUPERSEDED,
  },
  RECOMMENDATION_RECORDED: {
    observationType: 'NOTE_ADDED',
    reason: CASE_EVENT_REASONS.RECOMMENDATION_RECORDED,
  },
  RECOMMENDATION_SELECTED: {
    observationType: 'NOTE_ADDED',
    reason: CASE_EVENT_REASONS.RECOMMENDATION_SELECTED,
  },
  RECOMMENDATION_DISMISSED: {
    observationType: 'NOTE_ADDED',
    reason: CASE_EVENT_REASONS.RECOMMENDATION_DISMISSED,
  },
  RECOMMENDATION_REVISED: {
    observationType: 'NOTE_ADDED',
    reason: CASE_EVENT_REASONS.RECOMMENDATION_REVISED,
  },
  PARTICIPANT_ADDED: { observationType: 'NOTE_ADDED', reason: CASE_EVENT_REASONS.PARTICIPANT_ADDED },
  PARTICIPANT_CHANGED: {
    observationType: 'NOTE_ADDED',
    reason: CASE_EVENT_REASONS.PARTICIPANT_CHANGED,
  },
  PARTICIPANT_RELEASED: {
    observationType: 'NOTE_ADDED',
    reason: CASE_EVENT_REASONS.PARTICIPANT_RELEASED,
  },
};

/** The shape every reader has: whatever a log row exposes about what it is. */
export interface CaseEventObservation {
  observationType: string;
  reason: string | null;
  /** 'HUMAN' | 'SYSTEM'. Optional because most callers only have the two above. */
  actorType?: string | null;
}

/**
 * Events that are only themselves when a person did them.
 *
 * AUTHORIZATION IS THE HUMAN GATE, AND A TYPE NAME IS NOT A HUMAN. The whole
 * point of `INVESTIGATION_AUTHORIZED` is that somebody chose to open an
 * investigation; a row carrying that type with `actorType: 'SYSTEM'` is a
 * machine having written the word, and it must not read back as authorization.
 * The type made the meaning governed — it did not make the actor irrelevant.
 */
const HUMAN_ONLY: readonly CaseEventKind[] = ['INVESTIGATION_AUTHORIZED'];

function actorSatisfies(kind: CaseEventKind, observation: CaseEventObservation): boolean {
  if (!HUMAN_ONLY.includes(kind)) return true;
  return observation.actorType === 'HUMAN';
}

/**
 * What this log row means, or null when it is not a Stage 4 event at all.
 *
 * TYPED FIRST, LEGACY SECOND, AND NEVER THE OTHER WAY ROUND. A row carrying a
 * typed member is that event regardless of what its reason line says, because
 * the type is the governed fact and the sentence is decoration. Only a row whose
 * type is one of the old generic members is compared against prose, and only
 * then against the exact historical sentence.
 *
 * A ROW CANNOT MEAN TWO THINGS. The typed members are disjoint and the legacy
 * signatures are disjoint within each generic type, so the first match is the
 * only match.
 */
export function caseEventKind(observation: CaseEventObservation): CaseEventKind | null {
  for (const kind of CASE_EVENT_KINDS) {
    if (observation.observationType !== CASE_EVENT_TYPE[kind]) continue;
    return actorSatisfies(kind, observation) ? kind : null;
  }
  // LEGACY PATH. Pre-migration rows only.
  for (const kind of CASE_EVENT_KINDS) {
    const legacy = LEGACY_CASE_EVENT_SIGNATURES[kind];
    if (observation.observationType !== legacy.observationType) continue;
    if (observation.reason !== legacy.reason) continue;
    return actorSatisfies(kind, observation) ? kind : null;
  }
  return null;
}

/** Whether this row records the given Stage 4 event, in either representation. */
export function isCaseEvent(observation: CaseEventObservation, kind: CaseEventKind): boolean {
  return caseEventKind(observation) === kind;
}

/**
 * Whether this row is a Stage 4 event recorded in the pre-migration shape.
 *
 * FOR OPERATIONS, NOT FOR BEHAVIOUR. Nothing may branch on this to decide what
 * an event means — `caseEventKind` already answered that identically for both
 * shapes. It exists so somebody can ask "is there still legacy history in this
 * organization", which is the question that decides when the fallback above may
 * be deleted.
 */
export function isLegacyCaseEvent(observation: CaseEventObservation): boolean {
  const kind = caseEventKind(observation);
  if (kind === null) return false;
  return observation.observationType !== CASE_EVENT_TYPE[kind];
}
