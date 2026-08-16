// The Commercial Signal contract, v1 -- an observed fact that may matter to a
// Performance Objective.
//
// WHY THIS FILE EXISTS. Stage 1 gave Loop a referent: `performance-objective.ts`
// declares what an organization or a person is trying to accomplish. This file
// declares the other half of the sentence -- that a fact Loop already observes
// MAY BE RELEVANT to one of those objectives. Nothing more is claimed. A
// Commercial Signal does not establish that something is important, that a human
// should look at it, that an investigation should begin, or that any action is
// warranted. Those are later stages and different words.
//
// THIS IS NOT THE INCUMBENT `Signal`. `schema.prisma`'s `Signal` model is
// BEHAVIOURAL enrichment attached to a customer or a conversation -- churn risk,
// intent, journey stage -- produced by `services/signal-registry.ts` and read by
// four repositories. It has no concept of an objective, its `confidence` means
// "how sure the behavioural rule is", and nine active call sites depend on those
// semantics. The two concepts share an English word and nothing else. Neither
// this file nor anything downstream of it renames, wraps, aliases, extends or
// reads that model.
//
// PRISMA-FREE, deliberately -- the rule `performance-objective.ts`,
// `decision-contract.ts` and `cognitive-context.ts` already follow. Callers
// depend on this contract, never on persistence.
//
// FACT AND INFERENCE ARE STRUCTURALLY SEPARATE. `CommercialSignalView` nests the
// source's statement under `observation` and Loop's conclusion under
// `relevance`, rather than flattening both into one bag of fields where a reader
// has to know which is which. "Nike hired Jane Smith as CMO" and "this may
// matter to growing brand partnerships" are not the same kind of statement, and
// a shape that cannot tell them apart will eventually present the second as the
// first.
//
// WHAT THIS FILE IS NOT. There is no score, no confidence percentage, no weight,
// no ranking and no priority. Their absence is the design: Loop has no approved
// relevance model, and a number here would be a fabricated certainty of exactly
// the kind this platform has already paid for. The extension point for a real
// model is `evaluatorId` / `evaluatorVersion` plus the `relevanceBasis`
// vocabulary -- not a float somebody has to interpret.

import type { PerformanceObjectiveView } from './performance-objective';

export const COMMERCIAL_SIGNAL_CONTRACT_VERSION = 'commercial-signal.v1';

// --- The observed fact --------------------------------------------------------

/**
 * One thing Loop observed, as its owning domain states it.
 *
 * COMMERCIAL INTELLIGENCE DOES NOT OWN ANY OF THIS. The fact belongs to the
 * domain that produced it -- a CallGrid call, a CRM record, an external report
 * -- and CI holds a reference plus enough of a human-readable restatement to
 * explain itself later. It never copies the source record, and it never becomes
 * the place someone reads that record from.
 */
export interface CommercialObservation {
  /**
   * The producer that owns this fact. Opaque to CI and never parsed: 'CALLGRID'
   * today, a plain string so the second producer is a value rather than a
   * migration. This is the same reasoning `OperationalPriority.sourceSystem`
   * already follows.
   */
  sourceSystem: string;
  /**
   * Stable identity of this observation WITHIN `sourceSystem`. Re-observing the
   * same fact must produce the same key, or idempotency has nothing to bind to.
   */
  sourceKey: string;
  /**
   * The producer's own handle for the subject, opaque here and never parsed --
   * a call id, an invoice number, a page path. Null when the producer offers
   * none.
   */
  sourceReference?: string | null;
  /**
   * When the fact occurred AT THE SOURCE. Not when CI evaluated it, and not when
   * the row was written. Those are three different instants and collapsing them
   * makes the history unreadable.
   */
  observedAt: Date;
  /** The fact in one line, in the source's terms. Human-readable, not parsed. */
  summary: string;
  /**
   * Additional descriptors the source ALREADY OWNS -- labels, categories,
   * geography. Supplied separately from `summary` so an evaluator can read the
   * source's own vocabulary without CI having to re-parse a sentence it
   * assembled itself.
   */
  descriptors?: readonly string[];
}

// --- CI's inference -----------------------------------------------------------

/**
 * How relevance was established. A CLOSED VOCABULARY, deliberately small.
 *
 * `TERM_MATCH` is the Stage 2 reference mechanism and is explicitly NOT the
 * approved long-term model of commercial relevance -- see `evaluateTermMatch`
 * below. Adding a member is a contract change here and requires no migration,
 * because the column is a string: the same reasoning
 * `OperationalPriority.severity` gives for not being an enum.
 */
export const COMMERCIAL_SIGNAL_RELEVANCE_BASES = ['TERM_MATCH'] as const;
export type CommercialSignalRelevanceBasis = (typeof COMMERCIAL_SIGNAL_RELEVANCE_BASES)[number];

export function isCommercialSignalRelevanceBasis(v: string): v is CommercialSignalRelevanceBasis {
  return (COMMERCIAL_SIGNAL_RELEVANCE_BASES as readonly string[]).includes(v);
}

export const COMMERCIAL_SIGNAL_RELEVANCE_BASIS_LABELS: Record<
  CommercialSignalRelevanceBasis,
  string
> = {
  TERM_MATCH: 'Shared terms',
};

/**
 * A POSITIVE relevance determination, and the reason for it.
 *
 * There is no negative form of this type, and that is the persistence model
 * expressed in the type system: an evaluator returns `null` when it finds no
 * relevance, and nothing is stored. The absence of a Commercial Signal therefore
 * means ONLY that no positive determination was recorded -- never that an
 * observation was examined and found irrelevant. Stage 2 keeps no
 * negative-evaluation history, and no caller may read one into the data.
 */
export interface CommercialRelevance {
  basis: CommercialSignalRelevanceBasis;
  /**
   * Why this observation may matter to this objective, in a sentence a human can
   * check. This is CI's statement, never the source's.
   */
  rationale: string;
  /**
   * WHICH evaluator concluded this, and WHICH build of it. Recorded so a
   * determination stays reproducible and interpretable after the evaluator's
   * logic changes -- the reasoning `OperationalPriority.producerVersion`
   * already follows.
   */
  evaluatorId: string;
  evaluatorVersion: string;
}

// --- The view -----------------------------------------------------------------

/**
 * One Commercial Signal, as every caller outside the persistence layer sees it.
 *
 * Dates are ISO strings, matching how every other repository view in this
 * platform crosses the boundary, so a server component can render one without
 * importing a Prisma type.
 */
export interface CommercialSignalView {
  id: string;
  performanceObjectiveId: string;
  /**
   * Denormalized for display only, so a list does not need a second query --
   * the same accommodation `PerformanceObjectiveView.scopeUserName` makes. It is
   * NOT a stored column: an objective's title is the objective's to change, and
   * a copy in this table would be a second version of it that drifts.
   */
  objectiveTitle: string | null;

  /** WHAT THE SOURCE SAID. Owned by its domain; CI restates, never asserts. */
  observation: {
    sourceSystem: string;
    sourceKey: string;
    sourceReference: string | null;
    observedAt: string;
    summary: string;
  };

  /** WHAT CI CONCLUDED. Never presented as the source's statement. */
  relevance: {
    basis: CommercialSignalRelevanceBasis;
    rationale: string;
    evaluatorId: string;
    evaluatorVersion: string;
  };

  /**
   * The determination is established once and never rewritten. Re-evaluating the
   * same observation against the same objective moves `lastEvaluatedAt` and
   * `evaluationCount` and touches nothing else -- the same shape
   * `OperationalPriority.firstDetectedAt` / `lastDetectedAt` / `detectionCount`
   * uses, and for the same reason: a record of what CI believed is worthless if
   * a later run can quietly overwrite it.
   */
  firstEvaluatedAt: string;
  lastEvaluatedAt: string;
  evaluationCount: number;
  createdAt: string;
}

// --- The Stage 2 reference evaluator ------------------------------------------
//
// READ THIS BEFORE EXTENDING IT.
//
// `TERM_MATCH` is a DETERMINISTIC VALIDATION MECHANISM, not the approved model
// of commercial relevance. It exists to prove one architectural claim -- that an
// observation can be evaluated against a human-authored objective and produce an
// objective-relative signal with inspectable provenance -- using the smallest
// mechanism that could possibly work.
//
// IT IS DELIBERATELY DUMB. Commercial relevance is not lexical overlap. "Nike
// hires a new CMO" may matter enormously to "grow brand-partnership revenue"
// while sharing no word with it, and this function will find nothing there.
// That limit is understood and accepted for Stage 2; what must NOT happen is
// keyword matching quietly becoming the definition of relevance because it was
// the first thing that shipped.
//
// THE ENDURING CONCEPT IS OBJECTIVE-RELATIVE RELEVANCE. `TERM_MATCH` is one
// mechanism for establishing it. A later evaluator is added by producing a
// different `CommercialRelevance` -- a new basis, a new evaluatorId -- with no
// change to `CommercialSignalView`, the table, or what a Signal means.
//
// NOT PRESENT, AND NOT TO BE ADDED HERE WITHOUT APPROVAL: scores, confidence,
// weights, fuzzy or partial matching, stemming, embeddings, synonym expansion,
// an ontology, or an LLM.

export const TERM_MATCH_EVALUATOR_ID = 'term-match';
export const TERM_MATCH_EVALUATOR_VERSION = 'v1';

/**
 * Words carrying no subject matter, dropped before comparison.
 *
 * A STOPWORD LIST, NOT AN ONTOLOGY. It asserts no relationship between any two
 * words and encodes no domain knowledge; it removes tokens that would otherwise
 * match everything. Two groups, and the second is the one worth reading:
 *
 *   1. Ordinary English function words.
 *   2. INTENT VERBS -- grow, increase, improve. Nearly every objective begins
 *      with one, so leaving them in would make every objective relevant to every
 *      observation that happened to use the same verb, and the mechanism would
 *      look like it worked while meaning nothing.
 *
 * Visible in one file, on purpose. A list like this is only defensible while
 * anybody can read the whole of it.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  // Function words.
  'a', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'do',
  'for', 'from', 'has', 'have', 'in', 'into', 'is', 'it', 'its', 'not', 'of',
  'on', 'or', 'our', 'out', 'over', 'per', 'that', 'the', 'their', 'them',
  'then', 'there', 'these', 'they', 'this', 'to', 'up', 'us', 'was', 'we',
  'were', 'when', 'which', 'while', 'who', 'will', 'with', 'you', 'your',
  // Intent verbs and their inflections. See note 2 above.
  'achieve', 'add', 'boost', 'build', 'close', 'cut', 'deliver', 'drive',
  'expand', 'gain', 'get', 'grow', 'growing', 'improve', 'improving',
  'increase', 'increasing', 'keep', 'lift', 'lower', 'maintain', 'make', 'more',
  'raise', 'reduce', 'reducing', 'run', 'scale', 'win',
]);

/** Terms shorter than this are dropped. Keeps 'tx' and 'hr'; drops 'a'. */
const MIN_TERM_LENGTH = 2;

/**
 * Free text to a set of comparable terms.
 *
 * Lowercased, split on anything that is not a letter or a digit, stopwords and
 * one-character tokens removed. Exported because the test suite asserts on it
 * directly: a normalizer whose behaviour is only observable through its caller
 * is a normalizer nobody can reason about.
 */
export function commercialTerms(...text: ReadonlyArray<string | null | undefined>): Set<string> {
  const out = new Set<string>();
  for (const chunk of text) {
    if (!chunk) continue;
    for (const raw of chunk.toLowerCase().split(/[^a-z0-9]+/)) {
      if (raw.length < MIN_TERM_LENGTH) continue;
      if (STOPWORDS.has(raw)) continue;
      out.add(raw);
    }
  }
  return out;
}

/**
 * Does this observation share subject matter with this objective?
 *
 * Returns a positive determination, or `null` when there is nothing to say. The
 * null is the whole persistence model: no relevance, no record.
 *
 * PURE. No clock, no I/O, no randomness, no persistence -- so the same call
 * gives the same answer in a test, in a repository and in a re-run six months
 * from now. That is what makes a stored determination reproducible rather than
 * merely recorded.
 *
 * OBJECTIVE-RELATIVE BY CONSTRUCTION. The same observation is evaluated
 * separately against each objective and can succeed for one while returning null
 * for another. There is no notion here of a fact being "important" on its own,
 * because commercial significance is not a property a fact carries.
 */
export function evaluateTermMatch(
  objective: Pick<PerformanceObjectiveView, 'title' | 'description'>,
  observation: CommercialObservation,
): CommercialRelevance | null {
  const wanted = commercialTerms(objective.title, objective.description);
  if (wanted.size === 0) return null;

  const observed = commercialTerms(observation.summary, ...(observation.descriptors ?? []));

  // Sorted so the rationale is stable across runs: an explanation that reorders
  // itself between two identical evaluations reads as a change that did not
  // happen.
  const matched = [...wanted].filter((t) => observed.has(t)).sort();
  if (matched.length === 0) return null;

  return {
    basis: 'TERM_MATCH',
    rationale: `Objective and observation share the terms: ${matched.join(', ')}.`,
    evaluatorId: TERM_MATCH_EVALUATOR_ID,
    evaluatorVersion: TERM_MATCH_EVALUATOR_VERSION,
  };
}
