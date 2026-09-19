// One shape for surfaced intelligence, whoever produced it. PURE.
//
// Loop has two live authorities that hold something worth a person's attention, and they are kept
// apart on purpose:
//   - an employee's PRIVATE work item (`work_items`: their mail queue), readable only by them;
//   - an ORGANIZATION Case (`operational_priorities`: a CallGrid situation, a promoted headline).
// Neither is merged into the other, and nothing here is a table. This is the contract a surface
// reads -- Home, CallGrid Intelligence, a future Creator Hub -- so that no module invents its own
// reasoning format: what changed, why it matters, the evidence (still owned by its source), who and
// what it concerns, what Loop remembers, what happened the last times, what to review next, how sure
// Loop is, how current its sources are, and where the person has got to with it.
//
// SCOPE IS PART OF THE SHAPE. A PRIVATE item is built only inside one person's request and never
// leaves it; an ORGANIZATION item never carries private evidence. The builders enforce that; the
// field says which one a surface is holding.

export const INTELLIGENCE_AUTHORITIES = ['WORK_ITEM', 'CASE'] as const;
export type IntelligenceAuthority = (typeof INTELLIGENCE_AUTHORITIES)[number];

export const INTELLIGENCE_SCOPES = ['PRIVATE', 'ORGANIZATION'] as const;
export type IntelligenceScope = (typeof INTELLIGENCE_SCOPES)[number];

/** Who owns a piece of evidence. Composition cites it; it never copies or re-owns it. */
export const EVIDENCE_AUTHORITIES = ['GMAIL', 'CALENDAR', 'CALLGRID', 'CRM', 'LOOP'] as const;
export type EvidenceAuthority = (typeof EVIDENCE_AUTHORITIES)[number];

/** Where the person has got to. One vocabulary over both authorities' lifecycles. */
export const INTELLIGENCE_HUMAN_STATES = [
  'NEW',
  'REVIEWED',
  'WATCHING',
  'ASSIGNED',
  'WAITING',
  'SNOOZED',
  'HANDLED',
  'ACCEPTED',
  'DISMISSED',
  'SUPPRESSED',
] as const;
export type IntelligenceHumanState = (typeof INTELLIGENCE_HUMAN_STATES)[number];

/** What to do next, as a posture. The words come with a basis, never on their own. */
export const REVIEW_POSTURES = ['ACT', 'REVIEW', 'WATCH', 'NONE'] as const;
export type ReviewPosture = (typeof REVIEW_POSTURES)[number];

export interface IntelligenceEvidenceRef {
  /** The authority that owns this evidence; it stays theirs. */
  readonly authority: EvidenceAuthority;
  /** What kind of record the source holds: THREAD, EVENT, METRIC, RELATIONSHIP, CASE_LOG, ... */
  readonly kind: string;
  /** The source's own id for it. */
  readonly ref: string;
  /** What the source itself shows for it (a subject, a metric), exactly as its owner shows it. */
  readonly label: string | null;
  readonly observedAt: Date | null;
}

export interface IntelligenceSubjectRef {
  /** CORRESPONDENT, PARTY, BUYER, VENDOR, SOURCE, CAMPAIGN, THREAD, EVENT, ... */
  readonly kind: string;
  readonly ref: string;
  readonly label: string | null;
  /** True only when an authority (a human, or authoritative data) established it. Never a guess. */
  readonly verified: boolean;
}

/** One earlier outcome of this situation, or of a comparable one. */
export interface PriorOutcome {
  readonly at: Date;
  readonly outcome: string;
  /** The person's own words, where they gave them. */
  readonly reason: string | null;
  /** SAME: this same situation before. COMPARABLE: the same rule about a different entity. */
  readonly relation: 'SAME' | 'COMPARABLE';
  readonly subjectLabel: string | null;
}

export interface IntelligenceItem {
  /** Authority-qualified: `work_item:<id>` or `case:<id>`. */
  readonly id: string;
  readonly authority: IntelligenceAuthority;
  readonly scope: IntelligenceScope;
  readonly producer: string;
  readonly whatChanged: string;
  readonly whyItMatters: string | null;
  readonly evidence: readonly IntelligenceEvidenceRef[];
  readonly related: readonly IntelligenceSubjectRef[];
  /** Plain statements of what Loop remembers that bears on this, each from a stored record. */
  readonly remembers: readonly string[];
  readonly previously: readonly PriorOutcome[];
  readonly suggestedReview: { readonly posture: ReviewPosture; readonly text: string | null; readonly basis: string | null };
  readonly confidence: number | null;
  readonly uncertainty: readonly string[];
  readonly freshness: readonly { readonly authority: EvidenceAuthority; readonly asOf: Date | null; readonly state: string }[];
  readonly humanState: IntelligenceHumanState;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
}

// --- Learning from outcomes (durable operational learning, not statistics) ----------------------

/** Outcomes that mean "it went away without anyone doing anything". */
export const SELF_RESOLVING_OUTCOMES: readonly string[] = Object.freeze(['RECOVERED', 'NO_ACTION_NEEDED']);
/** Outcomes that mean "Loop was wrong to raise it". */
export const MISREAD_OUTCOMES: readonly string[] = Object.freeze(['FALSE_POSITIVE', 'NOT_ACTIONABLE']);
/** Outcomes that mean "it needed doing something". */
export const NEEDED_ACTION_OUTCOMES: readonly string[] = Object.freeze(['CONVERTED_TO_WORK', 'NOT_RECOVERED', 'PARTIALLY_RECOVERED']);

const OUTCOME_WORDS: Readonly<Record<string, string>> = Object.freeze({
  RECOVERED: 'recovered without action',
  PARTIALLY_RECOVERED: 'only partly recovered',
  NOT_RECOVERED: 'did not recover',
  NO_ACTION_NEEDED: 'needed no action',
  FALSE_POSITIVE: 'was a false alarm',
  ACCEPTED_RISK: 'was accepted as a risk',
  NOT_ACTIONABLE: 'was not actionable',
  SUPPRESSED: 'was suppressed',
  CONVERTED_TO_WORK: 'became work',
  EXPIRED: 'expired',
  DUPLICATE: 'was a duplicate',
  MERGED: 'was merged',
  UNKNOWN: 'ended with an unknown outcome',
  HANDLED: 'was handled',
  DISMISSED: 'was dismissed',
});

export function outcomeWords(outcome: string): string {
  return OUTCOME_WORDS[outcome] ?? outcome.toLowerCase().replace(/_/g, ' ');
}

/**
 * How what happened before changes what Loop suggests now. PURE and deterministic.
 *
 * This is the whole of "learning" at this stage: retrieve the outcomes a person recorded, and let
 * them change the posture of the next suggestion, with the reason stated. No weights, no training,
 * no hidden state -- the basis sentence names the records it rests on.
 *
 *   - this same situation was last a false alarm        -> REVIEW before acting
 *   - it last needed action                             -> ACT, as it did then
 *   - it went away on its own the last time(s)          -> WATCH before acting
 *   - no history of its own, but the same rule about other
 *     entities went away on its own at least twice, and
 *     never needed action                               -> WATCH before acting
 *   - otherwise                                         -> the producer's own suggestion stands
 */
export function learnFromHistory(
  prior: readonly PriorOutcome[],
  fallback: { readonly posture: ReviewPosture; readonly text: string | null },
): { readonly posture: ReviewPosture; readonly text: string | null; readonly basis: string | null } {
  const byRecency = [...prior].sort((a, b) => b.at.getTime() - a.at.getTime());
  const own = byRecency.filter((p) => p.relation === 'SAME');
  const last = own[0];
  if (last) {
    if (MISREAD_OUTCOMES.includes(last.outcome)) {
      return {
        posture: 'REVIEW',
        text: 'Check whether the same cause applies before acting.',
        basis: `The last time Loop raised this, it ${outcomeWords(last.outcome)}${last.reason ? ` ("${last.reason}")` : ''}.`,
      };
    }
    if (NEEDED_ACTION_OUTCOMES.includes(last.outcome)) {
      return { posture: 'ACT', text: fallback.text, basis: `The last time this happened, it ${outcomeWords(last.outcome)}.` };
    }
    const selfResolved = own.slice(0, 2).filter((p) => SELF_RESOLVING_OUTCOMES.includes(p.outcome));
    if (SELF_RESOLVING_OUTCOMES.includes(last.outcome)) {
      return {
        posture: 'WATCH',
        text: 'Watch it before acting.',
        basis:
          selfResolved.length >= 2
            ? `The last ${selfResolved.length} times this happened, it ${outcomeWords(last.outcome)}.`
            : `The last time this happened, it ${outcomeWords(last.outcome)}.`,
      };
    }
  }
  const comparable = byRecency.filter((p) => p.relation === 'COMPARABLE');
  const settled = comparable.filter((p) => SELF_RESOLVING_OUTCOMES.includes(p.outcome) || NEEDED_ACTION_OUTCOMES.includes(p.outcome));
  const selfResolving = settled.filter((p) => SELF_RESOLVING_OUTCOMES.includes(p.outcome));
  if (!last && selfResolving.length >= 2 && selfResolving.length === settled.length) {
    return {
      posture: 'WATCH',
      text: 'Watch it before acting.',
      basis: `The same pattern resolved without action the last ${selfResolving.length} times it was raised elsewhere.`,
    };
  }
  return { posture: fallback.posture, text: fallback.text, basis: null };
}
