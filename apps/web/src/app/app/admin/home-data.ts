import 'server-only';

// The operational Home — one composed read.
//
// Home is not a new surface. It is the owner's existing workspace home
// (workspace-home-data.ts: attention, next action, my work, activity) with the
// Executive Brain woven INTO it, so a single landing page answers what happened,
// why it matters, and what to do next across BOTH work and the business — and
// every section is a doorway into a deeper CallGrid / Work OS drill-down.
//
// Honest by construction:
//   - Business health is PROJECTED from the Brain's own System Health band; it is
//     never authored here and a failed read reads as "unmeasured", never "healthy".
//   - Risks and recommended actions are the Brain's own observations, each already
//     traced to a metric that cleared the Evidence Engine upstream. We reshape
//     them for the row; we do not invent, score, or re-rank them.
//   - The Brain read is wrapped so a database outage degrades Home to its work
//     half rather than showing a healthy-looking empty brief.

import {
  loadWorkspaceHome,
  type WorkspaceHomeData,
  type WorkFilter,
} from './workspace-home-data';
import { loadExecutiveBrain } from './_executive/executive-brain-data';
import { loadOrFallback } from '../../../demo/db-health';
import type {
  ExecutiveBrainReport,
  ExecutiveObservation,
  ObservationSeverity,
} from '@emgloop/intelligence';

// The one place any CallGrid Intelligence drill-down starts from Home.
const CALLGRID_OVERVIEW = '/app/admin/marketplace';

// System Health band -> a single honest headline. The band is computed upstream;
// this only chooses the words and the tone class (reused from .mkt-intel__health--*).
const HEALTH_BAND: Record<string, { label: string; tone: string; line: string }> = {
  healthy: {
    label: 'Healthy',
    tone: 'healthy',
    line: 'Your business is operating within normal bounds. Nothing needs a decision from the Brain right now.',
  },
  watch: {
    label: 'Watch',
    tone: 'degraded',
    line: 'A few signals are worth a look, but nothing is urgent.',
  },
  at_risk: {
    label: 'At risk',
    tone: 'impaired',
    line: 'The Brain has surfaced something that needs a decision today.',
  },
};

const UNMEASURED = {
  label: 'Unmeasured',
  tone: 'unmeasured',
  line: 'No sensor is instrumented yet, so the Brain has nothing it can trust to explain. Connect CallGrid to begin.',
};

// Severity -> the row tone used by the attention icons (crit / warn / info).
function severityTone(sev: ObservationSeverity): 'crit' | 'warn' | 'info' {
  if (sev === 'critical' || sev === 'high') return 'crit';
  if (sev === 'notable') return 'warn';
  return 'info';
}

function severityLabel(sev: ObservationSeverity): string {
  return sev === 'critical'
    ? 'Critical'
    : sev === 'high'
      ? 'High'
      : sev === 'notable'
        ? 'Watch'
        : 'FYI';
}

export interface HomeHealth {
  label: string;
  tone: string;
  line: string;
  measured: boolean;
}

/** A Brain risk, shaped for the unified attention list. */
export interface BrainSignal {
  id: string;
  sevLabel: string;
  tone: 'crit' | 'warn' | 'info';
  title: string;
  why: string;
  href: string;
}

/** A Brain recommendation, shaped for the Recommended Actions list. */
export interface BrainAction {
  id: string;
  title: string;
  why: string;
  impact: string;
  confidencePct: number;
  href: string;
}

export interface HomeBrain {
  /** True only when the Brain read succeeded. False -> Home shows its work half + honest empty intelligence. */
  present: boolean;
  health: HomeHealth;
  signals: BrainSignal[];
  actions: BrainAction[];
  summary: string[];
  sensors: { instrumented: number; total: number } | null;
}

export interface HomeData {
  workspace: WorkspaceHomeData;
  brain: HomeBrain;
}

function toSignal(o: ExecutiveObservation): BrainSignal {
  return {
    id: o.id,
    sevLabel: severityLabel(o.severity),
    tone: severityTone(o.severity),
    title: o.observation,
    why: o.businessImpact ?? 'The Brain flagged this from evidence that cleared the Evidence Engine.',
    href: CALLGRID_OVERVIEW,
  };
}

function toAction(o: ExecutiveObservation): BrainAction {
  return {
    id: o.id,
    title: o.recommendation ? o.recommendation.action : o.observation,
    why: o.businessImpact ?? o.observation,
    impact: o.recommendation?.expectedImpact ?? '',
    confidencePct: Math.round(o.confidence * 100),
    href: CALLGRID_OVERVIEW,
  };
}

function projectBrain(report: ExecutiveBrainReport | null): HomeBrain {
  if (!report) {
    return {
      present: false,
      health: { ...UNMEASURED, measured: false },
      signals: [],
      actions: [],
      summary: [],
      sensors: null,
    };
  }

  const band = HEALTH_BAND[report.systemHealth.band] ?? UNMEASURED;
  const measured = report.evidenceCoverage.instrumentedSensors > 0;

  return {
    present: true,
    health: { ...(measured ? band : UNMEASURED), measured },
    // Most severe first is already the Brain's order; take the top few for Home.
    signals: report.risks.slice(0, 4).map(toSignal),
    actions: report.recommendations.slice(0, 4).map(toAction),
    summary: report.summary.slice(0, 4).map((o) => o.observation),
    sensors: {
      instrumented: report.evidenceCoverage.instrumentedSensors,
      total: report.evidenceCoverage.totalSensors,
    },
  };
}

export async function loadHome(filter: WorkFilter): Promise<HomeData> {
  // The work home resolves + guards the session and scopes every read.
  const workspace = await loadWorkspaceHome(filter);

  // The Brain over the SAME organization. Wrapped so an outage degrades Home to
  // its work half instead of surfacing a healthy-looking empty briefing.
  const brainR = await loadOrFallback(async () => loadExecutiveBrain(workspace.organizationId));
  const report: ExecutiveBrainReport | null =
    brainR.ok && brainR.data.report.state === 'success' ? brainR.data.report.value : null;

  return { workspace, brain: projectBrain(report) };
}
