// Evidence never changes. What later evidence does is add CONTEXT to it.
//
// THE DOCTRINE THIS IMPLEMENTS. A piece of evidence is immutable: the sentence a
// person wrote, or the number a producer measured, stays exactly as it was
// recorded, for ever. When somebody later discovers it was about staging rather
// than production, or that a second source agrees with it, or that it stopped
// being true last Tuesday, NOTHING about the original row is edited. A separate,
// attributed, timed fact is appended that says how the two relate. Both remain
// readable, and the order they were learned in remains readable too.
//
// WHY THIS IS NOT A GRAPH. Five relations, all of them between two pieces of
// evidence ON THE SAME CASE, all of them recorded as facts on that Case's own
// append-only log. There is no node table, no edge table and no traversal: the
// question a surface asks is "what context does this piece of evidence have",
// and the answer is a replay of one Case's log, which every reader already does.
// A general graph would be a second place where investigation history lives.
//
// WHAT A RELATION IS NOT ALLOWED TO DO:
//
//   · It does not edit, replace or hide the evidence it is about.
//   · It does not change an evidence class. A corroborated human report is a
//     human report that somebody corroborated -- agreement is not measurement,
//     and no number of people saying the same thing turns a sentence into one.
//   · It does not reach the Stage 3 measurement gate, which reads measured
//     evidence and nothing else.
//   · It does not establish the CLAIM the evidence is about. That is the
//     Finding's business, decided by the governed standard for claims of its
//     kind.
//
// WHO MAY AUTHOR ONE. A person, attributed, or a deterministic producer naming
// its policy. Nothing in this repository authors one from text similarity, and a
// model may not: "these two sentences sound contradictory" is a guess about
// language, and a contradiction between two pieces of evidence is a claim about
// the world. Where a governed comparison exists it computes the answer itself --
// arithmetic disagreement between two measurements is already derived in
// `case-finding.ts` and is not recorded here. Everything else fails closed until
// such a comparison exists.
//
// PURE. No clock, no I/O.

export const EVIDENCE_RELATIONS = [
  /** Other evidence on this Case supports it. */
  'CORROBORATED_BY',
  /** Other evidence on this Case disagrees with it. */
  'CONTRADICTED_BY',
  /** Later evidence narrows or qualifies what it covers. */
  'CLARIFIED_BY',
  /** Later evidence says it was wrong. The original stays, in full. */
  'CORRECTED_BY',
  /**
   * It described the world truthfully and no longer does.
   *
   * THE ONE THAT IS NOT ABOUT BEING WRONG, and the distinction is the reason it
   * exists: "Loop could establish this then and cannot now" is a different fact
   * from "this was a mistake", and collapsing them would turn every change in
   * the world into somebody's error.
   */
  'NO_LONGER_APPLICABLE',
] as const;
export type EvidenceRelation = (typeof EVIDENCE_RELATIONS)[number];

export function isEvidenceRelation(value: unknown): value is EvidenceRelation {
  return typeof value === 'string' && (EVIDENCE_RELATIONS as readonly string[]).includes(value);
}

/**
 * Relations that only mean something against a second piece of evidence.
 *
 * "CORRECTED_BY" WITH NOTHING DOING THE CORRECTING is an assertion, not
 * evidence. Four of the five name a basis; the fifth names a moment in the world
 * instead, and is required to say why in the actor's own words.
 */
export const RELATIONS_REQUIRING_BASIS: readonly EvidenceRelation[] = [
  'CORROBORATED_BY',
  'CONTRADICTED_BY',
  'CLARIFIED_BY',
  'CORRECTED_BY',
];

export function relationRequiresBasis(relation: EvidenceRelation): boolean {
  return RELATIONS_REQUIRING_BASIS.includes(relation);
}

/**
 * WHY `SUPERSEDED_BY` IS NOT HERE.
 *
 * Two authorities already own the two things it would mean. A producer restating
 * its own number is a REVISION, and `provider_fact_revisions` has owned that
 * since Stage 3 -- recording it again here would be a second answer to "which
 * number is current". A newer CLAIM replacing an older one is Finding
 * supersession, which `intelligence_hypotheses.supersededById` has owned since
 * Stage 4. What is left over -- one person's report replacing their own earlier
 * one -- is `CORRECTED_BY`, which says the same thing and says why.
 *
 * Kept as a written refusal rather than an absence, so the next reader finds the
 * reasoning instead of the gap.
 */
export const SUPERSEDED_BY_BELONGS_ELSEWHERE =
  'Provider restatements are revisions (provider_fact_revisions); a newer claim replacing an ' +
  'older one is Finding supersession. A person replacing their own report is CORRECTED_BY.';

/** One context fact, as a surface reads it. Projected from the log, never stored twice. */
export interface EvidenceContextEntry {
  /**
   * The context fact's own identity: the id of the observation that recorded it.
   *
   * DURABLE WITHOUT A TABLE. The log row is immutable and already unique, so the
   * relation has an identity to cite without a second store inventing one.
   */
  id: string;
  /** The evidence being given context. */
  evidenceId: string;
  relation: EvidenceRelation;
  /** The evidence doing it, when the relation names one. */
  basisEvidenceId: string | null;
  /** Why, in the actor's words. */
  note: string | null;
  /** WHO SAID SO. A person, or a deterministic producer naming itself. */
  actorType: 'HUMAN' | 'SYSTEM';
  actorUserId: string | null;
  /** What produced it: 'operator', a policy id, a rule name. Never a model. */
  source: string;
  occurredAt: string;
  recordedAt: string;
}

/** The shape this reducer reads. A Case observation, in plain values. */
export interface ContextObservation {
  id: string;
  observationType: string;
  evidenceId: string | null;
  relatedEvidenceId: string | null;
  evidenceRelation: string | null;
  note: string | null;
  actorType: string;
  actorUserId: string | null;
  source: string;
  occurredAt: string;
  recordedAt: string;
}

/** The observation type a context fact is recorded as. */
export const EVIDENCE_CONTEXT_EVENT = 'EVIDENCE_CONTEXT_RECORDED';

/**
 * Every context fact on a Case, by the evidence it is about.
 *
 * FAILS CLOSED, ROW BY ROW. A row naming no evidence, or a relation this build
 * does not govern, is skipped rather than guessed into the nearest member: an
 * ungoverned relation rendered as a governed one is exactly the silent upgrade
 * this whole stage exists to prevent.
 *
 * ORDER IS THE ORDER IT WAS LEARNED IN, which is the order the log is in.
 */
export function projectEvidenceContext(
  log: readonly ContextObservation[],
): Map<string, EvidenceContextEntry[]> {
  const byEvidence = new Map<string, EvidenceContextEntry[]>();
  for (const o of log) {
    if (o.observationType !== EVIDENCE_CONTEXT_EVENT) continue;
    if (!o.evidenceId) continue;
    if (!isEvidenceRelation(o.evidenceRelation)) continue;
    if (relationRequiresBasis(o.evidenceRelation) && !o.relatedEvidenceId) continue;
    if (o.actorType !== 'HUMAN' && o.actorType !== 'SYSTEM') continue;

    const entry: EvidenceContextEntry = {
      id: o.id,
      evidenceId: o.evidenceId,
      relation: o.evidenceRelation,
      basisEvidenceId: o.relatedEvidenceId,
      note: o.note,
      actorType: o.actorType,
      actorUserId: o.actorUserId,
      source: o.source,
      occurredAt: o.occurredAt,
      recordedAt: o.recordedAt,
    };
    byEvidence.set(o.evidenceId, [...(byEvidence.get(o.evidenceId) ?? []), entry]);
  }
  return byEvidence;
}

/**
 * Whether a piece of evidence has been contradicted or corrected by a person.
 *
 * A READING AID, NOT A VERDICT. It says what was recorded about the evidence; it
 * says nothing about which side is right, and nothing here resolves the
 * disagreement. Resolution needs a governed comparison, and where one exists it
 * lives with the measurement rather than here.
 */
export function isContested(context: readonly EvidenceContextEntry[]): boolean {
  return context.some((c) => c.relation === 'CONTRADICTED_BY' || c.relation === 'CORRECTED_BY');
}
