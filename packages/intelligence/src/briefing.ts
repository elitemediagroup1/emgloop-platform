// @emgloop/intelligence — the Executive Briefing.
//
// The briefing is the owner-facing consumer of intelligence modules. It does NOT
// know about CallGrid, calls, or bids: it consumes `IntelligenceModuleOutput[]`
// and composes them. Today the list has one entry (CallGrid); when a second
// module ships, it appears here with no change to this file's logic — that is
// the point of the module contract.
//
// Two rules from the mission are enforced structurally here:
//   1. Revenue is the ONLY headline KPI. `revenue` is the single aggregated
//      number; every other field is explanation (summary, opportunities, risks,
//      what changed). There is no second KPI to add.
//   2. Nothing is fabricated. Revenue is null (not 0) when no module measured
//      it; opportunities/risks/activities are the modules' own Brain contracts,
//      projected — never re-authored — into a BrainBriefing.

import {
  projectBrainBriefing,
  type BrainActivity,
  type BrainBriefing,
  type RecommendationEnvelope,
} from '@emgloop/brain';
import {
  changePercent,
  directionOf,
  type ChangeDirection,
  type IntelligenceChange,
  type IntelligenceModuleOutput,
  type IntelligenceTimeWindow,
  type OptimizationAction,
} from './module';

/** The single aggregated KPI across all modules. */
export interface BriefingRevenue {
  currentCents: number | null;
  priorCents: number | null;
  changePercent: number | null;
  direction: ChangeDirection;
}

/** Lightweight provenance for each module that fed the briefing. */
export interface BriefingModuleRef {
  id: string;
  label: string;
  confidence: number;
  revenueCents: number | null;
}

/**
 * The owner-facing Executive Briefing. Read-only composition of module outputs:
 * one revenue headline, a merged narrative, ranked opportunities/risks/changes,
 * and a projected BrainBriefing over every module's activities. The full module
 * outputs are carried in `modules`/`moduleOutputs` so a surface can drill into
 * transcript/market/predictive detail without this layer flattening it away.
 */
export interface ExecutiveBriefing {
  generatedAt: string;
  window: IntelligenceTimeWindow;
  /** The ONLY top-level KPI. */
  revenue: BriefingRevenue;
  /** The merged executive read (4–6 sentences per module, labelled when >1). */
  narrative: string[];
  /** Opportunities across modules, most-confident first. */
  opportunities: RecommendationEnvelope[];
  /** Risks across modules, most-confident first. */
  risks: RecommendationEnvelope[];
  /** Changes across modules, most-significant first. */
  whatChanged: IntelligenceChange[];
  /** Optimizations across modules, most-confident first. */
  optimizations: OptimizationAction[];
  /** The Brain briefing projected from every module's activities. */
  brainBriefing: BrainBriefing;
  /** Provenance of the modules that contributed. */
  modules: BriefingModuleRef[];
  /** The full module outputs, for per-module drill-down (transcript/market/etc). */
  moduleOutputs: IntelligenceModuleOutput[];
  unknowns: string[];
  missingEvidence: string[];
  /** True when at least one module observed real activity. */
  hasData: boolean;
}

const SIG_RANK: Record<IntelligenceChange['significance'], number> = { major: 0, notable: 1, minor: 2 };

function aggregateRevenue(modules: IntelligenceModuleOutput[]): BriefingRevenue {
  const currents = modules.map((m) => m.revenue.currentCents).filter((v): v is number => v !== null);
  const priors = modules.map((m) => m.revenue.priorCents).filter((v): v is number => v !== null);
  const currentCents = currents.length > 0 ? currents.reduce((a, b) => a + b, 0) : null;
  const priorCents = priors.length > 0 ? priors.reduce((a, b) => a + b, 0) : null;
  const pct =
    currentCents !== null && priorCents !== null ? changePercent(currentCents, priorCents) ?? null : null;
  const direction =
    currentCents !== null && priorCents !== null ? directionOf(currentCents, priorCents) : 'flat';
  return { currentCents, priorCents, changePercent: pct, direction };
}

/**
 * Compose an Executive Briefing from module outputs. Pure and deterministic:
 * `now` is supplied, ordering is derived from the outputs, and nothing is
 * invented. Given the same module outputs it returns the same briefing.
 */
export function assembleExecutiveBriefing(
  modules: IntelligenceModuleOutput[],
  now: Date,
): ExecutiveBriefing {
  const window: IntelligenceTimeWindow =
    modules[0]?.window ?? { label: 'No window', since: now.toISOString(), until: now.toISOString() };

  const narrative: string[] =
    modules.length === 1
      ? (modules[0]?.executiveSummary ?? [])
      : modules.flatMap((m) => m.executiveSummary.map((s, i) => (i === 0 ? `${m.moduleLabel}: ${s}` : s)));

  const opportunities = modules
    .flatMap((m) => m.opportunities)
    .sort((a, b) => (b.trust.confidence ?? 0) - (a.trust.confidence ?? 0));
  const risks = modules
    .flatMap((m) => m.risks)
    .sort((a, b) => (b.trust.confidence ?? 0) - (a.trust.confidence ?? 0));
  const whatChanged = modules
    .flatMap((m) => m.whatChanged)
    .sort((a, b) => {
      if (SIG_RANK[a.significance] !== SIG_RANK[b.significance]) return SIG_RANK[a.significance] - SIG_RANK[b.significance];
      return Math.abs(b.changePercent ?? 0) - Math.abs(a.changePercent ?? 0);
    });
  const optimizations = modules.flatMap((m) => m.optimizations).sort((a, b) => b.confidence - a.confidence);

  const activities: BrainActivity[] = modules.flatMap((m) => m.activities);
  const brainBriefing = projectBrainBriefing({ activities });

  const modulesRef: BriefingModuleRef[] = modules.map((m) => ({
    id: m.moduleId,
    label: m.moduleLabel,
    confidence: m.confidence,
    revenueCents: m.revenue.currentCents,
  }));

  const unknowns = [...new Set(modules.flatMap((m) => m.unknowns))];
  const missingEvidence = [...new Set(modules.flatMap((m) => m.missingEvidence))];
  const hasData = modules.some((m) => m.coverage.calls > 0);

  return {
    generatedAt: now.toISOString(),
    window,
    revenue: aggregateRevenue(modules),
    narrative,
    opportunities,
    risks,
    whatChanged,
    optimizations,
    brainBriefing,
    modules: modulesRef,
    moduleOutputs: modules,
    unknowns,
    missingEvidence,
    hasData,
  };
}
