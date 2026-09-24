// What Loop can honestly say about how much it knows. The coverage contract, 2026-09-24.
//
// Architecture: the Loop Intelligence layering approved 2026-09-24 -- AUTHORITATIVE EVIDENCE ->
// DOMAIN INTELLIGENCE (`intelligence_digests`) -> domain UI / Briefing / connective intelligence
// -> Headlines -> Investigation -> Work. Every piece of domain intelligence carries ONE of these
// values, and every surface that shows intelligence shows the value's governed words with it.
//
// WHY A CONTRACT AND NOT A BOOLEAN. "Do we have a digest?" collapses six different situations,
// four of which a reader would otherwise mistake for "nothing happened". An empty panel above a
// disconnected source reads exactly like a quiet week; the only defence is saying which one it is
// (ENGINEERING_PRINCIPLES Rule 7: unknown is more truthful than fabricated certainty).
//
// EACH VALUE STATES WHAT IT DOES NOT MEAN. That is the part surfaces get wrong, so it is written
// next to the value, and the tests pin it through the pure helpers below.
//
// PURE. No clock, no I/O.

export const INTELLIGENCE_COVERAGE = [
  /**
   * The source is connected and live, and Loop read enough of it, recently enough, for the
   * intelligence to stand as the current picture of this subject.
   * DOES NOT MEAN the intelligence is correct, complete in every detail, or approved by anyone --
   * only that the evidence it was drawn from was sufficient. It is still a reading, never a fact.
   */
  'CONNECTED_SUFFICIENT',
  /**
   * The source is connected, but the evidence Loop holds is too thin to conclude anything.
   * DOES NOT MEAN nothing happened. It means Loop cannot tell: a quiet source and an unread
   * source look the same from here.
   */
  'CONNECTED_INSUFFICIENT',
  /**
   * The source is connected and Loop concluded something, but from part of the evidence (a
   * truncated window, a conversation read only in part, one capability missing).
   * DOES NOT MEAN complete. What is shown is true of what was read, and says so.
   */
  'CONNECTED_PARTIAL',
  /**
   * The source is not connected (disconnected, consent withdrawn, or never connected).
   * DOES NOT MEAN zero. No count, no "all clear", no empty list may stand in for it: Loop is
   * not looking, so it knows nothing about now.
   */
  'DISCONNECTED',
  /**
   * The intelligence exists but is older than the evidence behind it (the source has moved on),
   * or it is about to expire.
   * DOES NOT MEAN current. It may be shown only as of when it was generated, and never as today.
   */
  'STALE',
  /**
   * Loop could not produce or read the intelligence (a failed read, a refused model call, an
   * unreadable row).
   * DOES NOT MEAN no intelligence exists, and does not mean nothing happened. It means Loop does
   * not know, for a reason an operator can look at.
   */
  'ERROR',
] as const;
export type IntelligenceCoverage = (typeof INTELLIGENCE_COVERAGE)[number];

export function isIntelligenceCoverage(value: unknown): value is IntelligenceCoverage {
  return typeof value === 'string' && (INTELLIGENCE_COVERAGE as readonly string[]).includes(value);
}

/**
 * Whether the intelligence is the whole picture of what the source holds. Only SUFFICIENT is.
 * PARTIAL is true of what was read; everything else is not a picture at all.
 */
export function isCoverageComplete(coverage: IntelligenceCoverage): boolean {
  return coverage === 'CONNECTED_SUFFICIENT';
}

/**
 * Whether the intelligence may be presented as the CURRENT state of its subject. SUFFICIENT may;
 * PARTIAL may, carrying its words. STALE may be shown only "as of" its generation time, so it is
 * not current. DISCONNECTED, INSUFFICIENT and ERROR have nothing current to show.
 */
export function mayShowAsCurrent(coverage: IntelligenceCoverage): boolean {
  return coverage === 'CONNECTED_SUFFICIENT' || coverage === 'CONNECTED_PARTIAL';
}

/**
 * Whether an ABSENCE (no digest, no development, an empty list) may be read as "nothing
 * happened". Only under SUFFICIENT coverage: the source is live and Loop read enough of it.
 * Under every other value an absence is unknown, and a surface must say so rather than render a
 * zero, an empty state or "all clear".
 */
export function mayReadAbsenceAsNothingHappened(coverage: IntelligenceCoverage): boolean {
  return coverage === 'CONNECTED_SUFFICIENT';
}

/**
 * Whether a surface must show the coverage's governed words next to the intelligence. Everything
 * but SUFFICIENT carries a limitation the reader has to see.
 */
export function requiresCoverageDisclosure(coverage: IntelligenceCoverage): boolean {
  return coverage !== 'CONNECTED_SUFFICIENT';
}

/** Whether the source is connected at all, for the three CONNECTED_* values. */
export function isConnectedCoverage(coverage: IntelligenceCoverage): boolean {
  return coverage === 'CONNECTED_SUFFICIENT' || coverage === 'CONNECTED_INSUFFICIENT' || coverage === 'CONNECTED_PARTIAL';
}

/** The values a producer may RECORD on a digest it generated. The rest are decided at read time. */
export const INTELLIGENCE_GENERATED_COVERAGE = ['CONNECTED_SUFFICIENT', 'CONNECTED_INSUFFICIENT', 'CONNECTED_PARTIAL'] as const;
export type IntelligenceGeneratedCoverage = (typeof INTELLIGENCE_GENERATED_COVERAGE)[number];
