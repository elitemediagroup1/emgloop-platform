// Whether a stored digest may feed SYNTHESIS -- a situation or a Briefing. Loop Intelligence, 2026-09-26.
//
// ONE DECISION, ON THE SHARED FRESHNESS CONTRACT. "A row exists" is not "current intelligence". A digest
// contributes only when, at `now`:
//
//   status        CURRENT (a STALE mark or a WITHDRAWN row never contributes);
//   content       passes the participation contract (else ERROR);
//   freshness     `digestFreshness` (source live, evidence no newer than what the digest read, not about to
//                 expire) says CONNECTED_SUFFICIENT or CONNECTED_PARTIAL -- `mayShowAsCurrent`.
//
// DISCONNECTED, STALE, ERROR and CONNECTED_INSUFFICIENT contribute nothing: no signal, no statement.
//
// PARTIAL IS PERMITTED, AND CARRIES ITS LIMITATION. The coverage contract says a PARTIAL reading "is true
// of what was read, and says so" -- so its claims may be used for what was read, never for an absence.
// The eligibility therefore returns the limitation (the coverage's governed words plus the digest's own
// limitations), and every consumer must hand it to synthesis and show it with anything built on it.
// Absence conclusions ("nothing pressing") are allowed only when every contributing digest is
// SUFFICIENT (`mayReadAbsenceAsNothingHappened`).
//
// PURE.

import { mayReadAbsenceAsNothingHappened, mayShowAsCurrent, type IntelligenceCoverage } from './intelligence-coverage';
import { digestContentRefusals, digestFreshness, type DigestContent, type IntelligenceDigestScope } from './intelligence-digest';

/** The governed words a PARTIAL reading carries into anything built on it. */
export const PARTIAL_COVERAGE_LIMITATION = 'Read from part of the evidence: true of what was read, not a complete picture.';

export interface SynthesisEligibilityInput {
  readonly scope: IntelligenceDigestScope;
  readonly status: string;
  readonly coverage: string;
  readonly windowEnd: Date;
  readonly expiresAt: Date;
  readonly content: DigestContent;
  readonly provenance?: Readonly<Record<string, unknown>>;
}

export interface SynthesisSourceState {
  /** Whether the digest's source is live now (Loop's own records always are). */
  readonly connectionLive: boolean;
  /** The newest evidence the source holds for this digest's subject, or null when unknown. */
  readonly sourceLastEvidenceAt: Date | null;
}

export type SynthesisEligibility =
  | { readonly eligible: true; readonly coverage: 'CONNECTED_SUFFICIENT' | 'CONNECTED_PARTIAL'; readonly limitations: readonly string[] }
  | { readonly eligible: false; readonly coverage: IntelligenceCoverage; readonly reason: 'NOT_CURRENT_STATUS' | 'INVALID_CONTENT' | 'NOT_CURRENT_COVERAGE' };

export function digestSynthesisEligibility(digest: SynthesisEligibilityInput, source: SynthesisSourceState, now: Date): SynthesisEligibility {
  if (digest.status !== 'CURRENT') return { eligible: false, coverage: digest.status === 'WITHDRAWN' ? 'DISCONNECTED' : 'STALE', reason: 'NOT_CURRENT_STATUS' };
  const kind = (digest.provenance as { producerKind?: unknown } | undefined)?.producerKind;
  const producerKind = kind === 'RULE' || kind === 'MODEL' || kind === 'RULE_AND_MODEL' ? kind : null;
  if (digestContentRefusals(digest.content, { scope: digest.scope, producerKind }).length > 0) return { eligible: false, coverage: 'ERROR', reason: 'INVALID_CONTENT' };
  const coverage = digestFreshness(digest, { ...source, now });
  if (!mayShowAsCurrent(coverage)) return { eligible: false, coverage, reason: 'NOT_CURRENT_COVERAGE' };
  const own = (digest.content.limitations ?? []).filter((l): l is string => typeof l === 'string' && l.trim() !== '');
  const limitations = coverage === 'CONNECTED_PARTIAL' ? [PARTIAL_COVERAGE_LIMITATION, ...own] : own;
  return { eligible: true, coverage: coverage as 'CONNECTED_SUFFICIENT' | 'CONNECTED_PARTIAL', limitations };
}

/**
 * Whether an ABSENCE may be concluded from a set of eligible readings ("nothing pressing"): only when
 * there is at least one and every one is SUFFICIENT. Partial or missing coverage never justifies it.
 */
export function absenceJustified(coverages: readonly IntelligenceCoverage[]): boolean {
  return coverages.length > 0 && coverages.every((c) => mayReadAbsenceAsNothingHappened(c));
}
