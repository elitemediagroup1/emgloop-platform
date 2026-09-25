// The ONE projection from a domain digest to what a surface shows. Loop Intelligence PR 2 (the fabric),
// 2026-09-26.
//
// SAME ARTIFACT, TWO DEPTHS. Home shows the shallow projection (statement, status, freshness, the top
// signal, one supporting metric); the domain's own page shows the same digest in depth. Both read the
// same stored digest through this function, so Home can never say something the domain page does not.
// Chats keeps its own composition (`composeChatsIntelligence`) unchanged until its reading carries the
// typed contract; every domain that adopts the contract uses this.
//
// HONEST BY CONSTRUCTION. Freshness is `digestFreshness` (the coverage the digest has NOW, not when it
// was written). A digest that may not be shown as current says so (`asCurrent: false`), and a missing
// digest is NONE -- never an empty reading, never "nothing happened".
//
// PURE. `now` is passed in.

import { mayShowAsCurrent, requiresCoverageDisclosure, type IntelligenceCoverage } from './intelligence-coverage';
import type { IntelligenceMetric, IntelligenceOrdinal, IntelligenceReadingStatus, IntelligenceSignal, IntelligenceSignalKind } from './intelligence-contract';
import { digestContentRefusals, digestFreshness, type DigestContent, type DigestFreshnessInput } from './intelligence-digest';

/** What the projection needs of a stored digest. Structural: any digest record satisfies it. */
export interface ProjectableDigest extends DigestFreshnessInput {
  readonly scope: 'PRINCIPAL' | 'ORGANIZATION';
  readonly content: DigestContent;
  readonly generatedAt: Date;
  readonly version: number;
  readonly provenance?: Readonly<Record<string, unknown>>;
}

export type DomainProjectionState = 'NONE' | 'CURRENT' | 'NOT_CURRENT';

export interface DomainProjectionSignal {
  readonly key: string;
  readonly kind: IntelligenceSignalKind;
  readonly statement: string;
  /** How the statement is known: shown as a reading unless OBSERVED or MEASURED. */
  readonly knowledge: IntelligenceSignal['knowledge'];
  readonly severity: IntelligenceOrdinal | null;
  readonly dueAt: string | null;
  readonly owedBy: IntelligenceSignal['owedBy'] | null;
}

export interface DomainProjection {
  readonly state: DomainProjectionState;
  /** The reading's statement (or the PR A synthesis). Null only for NONE. */
  readonly statement: string | null;
  readonly status: IntelligenceReadingStatus | null;
  /** The coverage NOW (freshness), never the coverage at generation. */
  readonly coverage: IntelligenceCoverage | null;
  /** Whether the surface may present this as current. False means it must say it is not. */
  readonly asCurrent: boolean;
  /** Whether the surface must disclose partial / insufficient / stale coverage beside the statement. */
  readonly disclose: boolean;
  readonly topSignal: DomainProjectionSignal | null;
  /** A supporting MEASURED figure (a RULE producer's), when the reading has one. Never a model's number. */
  readonly metric: (IntelligenceMetric & { readonly signalKey: string }) | null;
  readonly signalCount: number;
  readonly generatedAt: Date | null;
  /** Which stored version was projected, so a surface pair can prove it read the same artifact. */
  readonly version: number | null;
}

/** The order signals lead in, most pressing first. */
export const DOMAIN_SIGNAL_PRECEDENCE: readonly IntelligenceSignalKind[] = Object.freeze([
  'ATTENTION',
  'OBLIGATION',
  'RISK',
  'DECISION_PENDING',
  'STALLED',
  'UNRESOLVED',
  'UPCOMING',
  'OPPORTUNITY',
  'CHANGE',
  'OPERATIONAL',
  'QUIET',
  'RESOLVED',
]);

const SEVERITY_RANK: Readonly<Record<string, number>> = Object.freeze({ HIGH: 0, MEDIUM: 1, LOW: 2 });

/** Signals in the order a surface should show them: severity, then kind precedence, then key. */
export function rankDomainSignals(signals: readonly IntelligenceSignal[]): IntelligenceSignal[] {
  const kindRank = (k: string) => {
    const i = DOMAIN_SIGNAL_PRECEDENCE.indexOf(k as IntelligenceSignalKind);
    return i < 0 ? DOMAIN_SIGNAL_PRECEDENCE.length : i;
  };
  return [...signals].sort(
    (a, b) =>
      (SEVERITY_RANK[a.severity ?? 'LOW'] ?? 3) - (SEVERITY_RANK[b.severity ?? 'LOW'] ?? 3) ||
      kindRank(a.kind) - kindRank(b.kind) ||
      a.key.localeCompare(b.key),
  );
}

const NONE: DomainProjection = Object.freeze({
  state: 'NONE',
  statement: null,
  status: null,
  coverage: null,
  asCurrent: false,
  disclose: false,
  topSignal: null,
  metric: null,
  signalCount: 0,
  generatedAt: null,
  version: null,
});

/**
 * Project one DOMAIN digest (or null) for a surface. `context` states what the caller knows about the
 * source now: whether it is live, and whether it holds evidence newer than the digest's window.
 */
export function projectDomainDigest(
  digest: ProjectableDigest | null,
  context: { readonly connectionLive: boolean; readonly sourceLastEvidenceAt: Date | null; readonly now: Date },
): DomainProjection {
  if (!digest) return NONE;
  const producerKind = (digest.provenance as { producerKind?: unknown } | undefined)?.producerKind;
  if (digestContentRefusals(digest.content, { scope: digest.scope, producerKind: producerKind === 'RULE' || producerKind === 'MODEL' ? producerKind : null }).length > 0) {
    return { ...NONE, state: 'NOT_CURRENT', coverage: 'ERROR', generatedAt: digest.generatedAt, version: digest.version };
  }
  const coverage = digestFreshness(digest, context);
  const asCurrent = mayShowAsCurrent(coverage);
  const signals = rankDomainSignals(digest.content.signals ?? []);
  const top = signals[0];
  const measured = signals.find((s) => s.knowledge === 'MEASURED' && s.metric);
  return {
    state: asCurrent ? 'CURRENT' : 'NOT_CURRENT',
    statement: digest.content.reading?.statement ?? digest.content.synthesis ?? null,
    status: digest.content.reading?.status ?? null,
    coverage,
    asCurrent,
    disclose: requiresCoverageDisclosure(coverage),
    topSignal: top
      ? { key: top.key, kind: top.kind, statement: top.statement, knowledge: top.knowledge, severity: top.severity ?? null, dueAt: top.dueAt ?? null, owedBy: top.owedBy ?? null }
      : null,
    metric: measured?.metric && producerKind === 'RULE' ? { ...measured.metric, signalKey: measured.key } : null,
    signalCount: signals.length,
    generatedAt: digest.generatedAt,
    version: digest.version,
  };
}
