// The Evidence Engine — platform-level, domain-agnostic.
//
// WHAT CHANGED AND WHY
//
// This supersedes the Marketplace Confidence Engine. Confidence was the wrong
// thing to build a layer around: it is a single derived number, and making it
// the headline meant everything else a reader needs to judge a metric —
// provenance, freshness, contradictions — had nowhere to live.
//
// Confidence is now ONE derived property among eight. The layer owns:
//
//   Coverage · Sample Size · Confidence · Freshness
//   Provenance · Unknowns · Contradictions · Missing Provider Data
//
// DOMAIN-AGNOSTIC BY CONSTRUCTION
//
// Nothing here mentions calls, marketplaces, buyers or CallGrid. A domain
// supplies OBSERVATIONS; the engine derives everything else uniformly. Adding
// CRM, Talent, Care or Web means writing a contributor that emits observations
// — the engine itself does not change.
//
// The test of that claim is not intent, it is the type signature: if a future
// domain needed a field this file does not have, the generalisation failed.

/** How much of the intended population a metric actually covers. */
export interface EvidenceCoverage {
  observed: number;
  /**
   * The true denominator, or null when the denominator is ITSELF unknown.
   * Null is honest; defaulting it to `observed` would fake completeness.
   */
  total: number | null;
}

/** Where a value came from, and how it was derived. */
export interface Provenance {
  /** The system that supplied it — a provider, a repository, a computation. */
  sourceId: string;
  sourceLabel: string;
  /** How the value was produced. Never "unknown" — if it cannot be stated, it should not be trusted. */
  derivation: string;
  /** Where the claim can be checked, when a citation exists. */
  citation: string | null;
}

/**
 * How current the evidence is.
 *
 * A metric can be perfectly covered and completely stale. Separating freshness
 * from confidence keeps that distinction visible: an operator may reasonably
 * act on a partial-but-current figure and refuse a complete-but-week-old one.
 */
export interface Freshness {
  /** When the measurement was taken. */
  measuredAt: string;
  /** When the underlying data was last known to change, if the source says. */
  sourceObservedAt: string | null;
  /** Age in milliseconds, or null when the source gives no timestamp. */
  ageMs: number | null;
  /** Beyond this age the domain considers the metric stale. */
  staleAfterMs: number | null;
  stale: boolean;
  /** Stated whenever staleness cannot be determined, rather than assuming fresh. */
  note: string | null;
}

/**
 * Two sources disagreeing about the same fact.
 *
 * First-class because a contradiction is not an unknown: an unknown is silence,
 * a contradiction is conflicting speech, and the second is more dangerous. A
 * metric carrying one is withheld regardless of how good its coverage looks.
 */
export interface Contradiction {
  statement: string;
  /** The sources that disagree. */
  betweenSources: readonly string[];
  detail: string;
}

/** The complete evidential position on one metric. */
export interface MetricEvidence {
  metricId: string;
  label: string;
  /** The domain that contributed it: 'marketplace', 'crm', 'talent', … */
  domain: string;

  coverage: EvidenceCoverage | null;
  sampleSize: number;
  /** DERIVED from coverage, sample size, freshness and contradictions. */
  confidence: number;
  freshness: Freshness;

  provenance: readonly Provenance[];
  unknowns: readonly string[];
  contradictions: readonly Contradiction[];
  missingProviderData: readonly string[];

  /** True when this metric must not be reasoned over at all. */
  withheld: boolean;
  withheldReason: string | null;
}

/**
 * What a domain emits. The ONLY thing a domain must produce.
 *
 * Deliberately minimal: a domain states what it saw and where it came from. It
 * does not compute confidence, decide staleness, or judge whether it may be
 * used — those are uniform platform decisions, and letting each domain make
 * them is how two domains end up disagreeing about the same evidential rules.
 */
export interface MetricObservation {
  metricId: string;
  label: string;
  /** Records carrying this metric. */
  observed: number;
  /** Records examined, or null when the denominator is unknown. */
  total: number | null;
  /**
   * Set when the metric CANNOT exist in this system — no field, no source.
   * Distinct from observing zero: absence is structural, zero is measured.
   */
  structurallyAbsent: { reason: string; unblockedBy: string | null } | null;
  provenance: readonly Provenance[];
  unknowns?: readonly string[];
  contradictions?: readonly Contradiction[];
  missingProviderData?: readonly string[];
  /** When the source says the underlying data was current, if it says. */
  sourceObservedAt?: string | null;
}

/** What a domain implements to join the platform. */
export interface EvidenceContributor<TInput> {
  /** 'marketplace' | 'crm' | 'talent' | 'care' | 'web' | … */
  domain: string;
  /** Records in the population examined. Drives sample-size gating. */
  populationSize(input: TInput): number;
  /** Human label for the window or scope examined. */
  scopeLabel(input: TInput): string;
  /** Beyond this age the domain considers its evidence stale. Null = no policy. */
  staleAfterMs: number | null;
  /**
   * The domain's own sentence for "nothing was examined".
   *
   * The engine cannot write this: it does not know whether the domain counts
   * calls, candidates, sessions or tickets. Supplying it here keeps the engine
   * domain-free while the operator still reads natural language.
   */
  emptyScopeReason(input: TInput): string;
  observe(input: TInput): readonly MetricObservation[];
}

export interface EvidenceReport {
  domain: string;
  scopeLabel: string;
  measuredAt: string;
  populationSize: number;
  metrics: readonly MetricEvidence[];
  /** Safe to reason over. A consumer receives ONLY these. */
  available: readonly MetricEvidence[];
  /** Withheld, with reasons. Surfaced, never dropped. */
  withheld: readonly MetricEvidence[];
}
