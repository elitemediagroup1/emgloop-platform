// How a piece of evidence entered Loop -- and the four things that fact does NOT
// say about it.
//
// TWO MEMBERS, DELIBERATELY, AND NOT A TAXONOMY. `MEASURED` is evidence produced
// by a measurement path Loop can trace to a rule, a source and a window.
// `HUMAN_REPORTED` is a person writing down what they know. A richer set --
// deterministic diagnostic, document, outcome -- is real and is NOT invented
// here: a vocabulary whose members nothing produces is the same failure as a
// button that does nothing, and every member added now would have to be guessed.
//
// IT SAYS HOW EVIDENCE ARRIVED. IT SAYS NOTHING ABOUT WHETHER TO BELIEVE IT.
// Evidence class carries no trust, no authority, no reliability, no diagnostic
// power and no confidence. Those are properties of a CLAIM plus the evidence
// under it, they differ by claim type, and they are decided by standards that do
// not exist yet. A reader that treats `MEASURED` as "true" and `HUMAN_REPORTED`
// as "doubtful" has invented a hierarchy this file refuses to state -- an
// authoritative deterministic diagnostic and a stale number are both MEASURED,
// and which of them settles an argument is not a question about how they
// arrived.
//
// WHAT A HUMAN REPORT ESTABLISHES ON ITS OWN. That the person reported it. Loop
// may say "Matt reported that the API token expired" the moment it is written,
// and may not say "the API token expired" until the governed standard for that
// claim is separately satisfied. Organizational authority never closes that gap:
// the most senior person in the company writing a sentence produces a report,
// not a measurement.
//
// PURE. No clock, no I/O.

export const EVIDENCE_CLASSES = ['MEASURED', 'HUMAN_REPORTED'] as const;
export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number];

/**
 * The class every piece of evidence written before this vocabulary existed has.
 *
 * TRUE OF EVERY ONE OF THEM. Until human reports there was exactly one way for
 * evidence to arrive -- a producer measuring something -- so the column's
 * default is a statement of fact about the existing rows rather than a guess
 * that had to be backfilled.
 */
export const DEFAULT_EVIDENCE_CLASS: EvidenceClass = 'MEASURED';

export function isEvidenceClass(value: unknown): value is EvidenceClass {
  return typeof value === 'string' && (EVIDENCE_CLASSES as readonly string[]).includes(value);
}

/**
 * Whether this evidence came from a measurement path.
 *
 * THE ONE QUESTION THE STAGE 3 GATE MAY ASK. Readiness is a statement about
 * instrumentation -- days observed, populations reconciled, authority declared --
 * and a sentence somebody typed is not an input to any of it. Everything the gate
 * reads is filtered through this.
 *
 * TAKES THE STORED SHAPE, so the same answer serves the database row (where the
 * column is a plain string) and the product contract. A class this build does not
 * recognise is NOT measured: an unknown value must never be the one that reaches
 * the measurement gate.
 */
export function isMeasuredEvidence(e: { evidenceClass: string }): boolean {
  return e.evidenceClass === 'MEASURED';
}

/**
 * The `source` a human report is recorded under.
 *
 * THE ACTOR VOCABULARY THE DECISION CENTER ALREADY USES. Every human-recorded
 * observation on a Case carries `source: 'operator'`, and a report is one more
 * thing a person did on the Case rather than a new kind of producer. Inventing
 * `'human'` or `'manual'` here would give one act its own source word while every
 * other human act on the same log kept the existing one.
 */
export const HUMAN_REPORT_SOURCE = 'operator';
