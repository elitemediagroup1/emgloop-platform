import 'server-only';

// Administration › Diagnostics › CallGrid — the call-report reconciliation panel.
//
// Runs the shared reconciliation harness for a chosen window and dimension and
// renders every line with its flag and its reason. It lives HERE, not in the
// CallGrid Intelligence tabs: operators get findings, engineers get this.
//
// The panel is deliberate about what it can and cannot prove. Overview ↔ subpage
// consistency, window resolution, comparison symmetry and zero-coercion are all
// proved automatically. The CallGrid-side figures are not fetchable — the
// provider's aggregate call-statistics endpoint has never returned 200 — so
// those lines read NOT VERIFIED until someone enters the figures from the
// CallGrid interface via the query string. It never reports agreement it did
// not check.

import {
  parseCallGridRange, resolveCallGridWindow, reconcileCallGridReport,
  type ReconciliationDimension, type ReconciliationFlag, type ReconRow,
} from '@emgloop/shared';
import { loadCallGridReport, type Dimension } from '../../../marketplace/callgrid-report';

const FLAG_CLASS: Record<ReconciliationFlag, string> = {
  MATCH: 'good',
  ROUNDING_DIFFERENCE: 'good',
  CAP_LIMITATION: 'warn',
  MISSING_PROVIDER_DATA: 'warn',
  UNKNOWN: 'warn',
  DATE_MISMATCH: 'crit',
  ENTITY_MISMATCH: 'crit',
  GRAIN_MISMATCH: 'crit',
  ZERO_COERCION: 'crit',
};

const DIMENSIONS: ReconciliationDimension[] = [
  'overview', 'buyers', 'vendors', 'sources', 'campaigns', 'bids-source', 'bids-destination',
];

function toReconRow(r: {
  key: string; label: string; calls: number; monetized: number;
  revenueCents: number | null; revenueCoverage: number | null;
}): ReconRow {
  return {
    key: r.key, label: r.label, calls: r.calls, monetized: r.monetized,
    revenueCents: r.revenueCents, revenueCoverage: r.revenueCoverage,
  };
}

/** Parse an optional operator-supplied CallGrid figure. Absent stays absent. */
function figure(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

export async function ReconciliationPanel({
  organizationId,
  searchParams,
}: {
  organizationId: string;
  searchParams?: Record<string, string | undefined>;
}) {
  const now = new Date();
  const range = parseCallGridRange({ range: searchParams?.range, s: searchParams?.s, e: searchParams?.e });
  const window = resolveCallGridWindow(range, now);
  const dimension = (DIMENSIONS.includes(searchParams?.dim as ReconciliationDimension)
    ? searchParams!.dim
    : 'buyers') as ReconciliationDimension;
  const topN = Math.max(1, Math.min(25, Number(searchParams?.topN ?? 5) || 5));

  const report = await loadCallGridReport(organizationId, window);
  const callDim: Dimension =
    dimension === 'vendors' ? 'vendors'
    : dimension === 'sources' ? 'sources'
    : dimension === 'campaigns' ? 'campaigns'
    : 'buyers';
  const rows = report.dimensions[callDim].map(toReconRow);

  const result = reconcileCallGridReport({
    organizationId,
    dimension,
    topN,
    window,
    requestedPreset: range.preset,
    reportOk: report.ok,
    totals: {
      totalCalls: report.metrics.totalCalls,
      billableCalls: report.metrics.billableCalls,
      revenueCents: report.metrics.revenueCents,
      profitCents: report.metrics.profitCents,
      revenueCoverage: report.metrics.revenueCoverage,
    },
    subpageRows: rows,
    overviewTop: rows[0] ?? null,
    rowCap: null,
    callgridFigures: {
      totalCalls: figure(searchParams?.cgCalls),
      billableCalls: figure(searchParams?.cgBillable),
      revenueCents: figure(searchParams?.cgRevenueCents),
      profitCents: figure(searchParams?.cgProfitCents),
      topEntityName: searchParams?.cgTop?.trim() || undefined,
    },
  });

  return (
    <section className="adm-card">
      <h2 className="adm-card__title">Call report reconciliation</h2>
      <p className="adm-faint">
        Window <strong>{result.normalizedWindow.label}</strong> ({result.normalizedWindow.timezone}), dimension{' '}
        <strong>{result.dimension}</strong>, top {topN}. Change with{' '}
        <code>?range=yesterday&amp;dim=buyers&amp;topN=5</code>. Supply CallGrid&rsquo;s own figures to verify the
        provider leg: <code>&amp;cgCalls=&amp;cgBillable=&amp;cgRevenueCents=&amp;cgProfitCents=&amp;cgTop=</code>.
      </p>

      <p className={'adm-faint recon-verdict recon-verdict--' + (result.defects.length > 0 ? 'crit' : result.fullyReconciled ? 'good' : 'warn')}>
        {result.defects.length > 0
          ? `${result.defects.length} defect${result.defects.length === 1 ? '' : 's'} — this window is not reconciled.`
          : result.fullyReconciled
            ? 'Fully reconciled: no defects, and nothing left unverified.'
            : `No defects, but ${result.unverified.length} check${result.unverified.length === 1 ? '' : 's'} could not be verified. This is NOT a pass.`}
      </p>

      {result.sections.map((s) => (
        <div key={s.title}>
          <h3 className="adm-subhead">{s.title}</h3>
          <div className="adm-tablewrap">
            <table className="adm-table">
              <thead>
                <tr><th>Check</th><th>Loop</th><th>CallGrid</th><th>Result</th><th>Why</th></tr>
              </thead>
              <tbody>
                {s.lines.map((l, i) => (
                  <tr key={i}>
                    <td>{l.label}</td>
                    <td>{l.loop === null ? '—' : String(l.loop)}</td>
                    <td>{l.other === null ? 'not verified' : String(l.other)}</td>
                    <td><span className={'cg-sev cg-sev--' + FLAG_CLASS[l.flag]}>{l.flag}</span></td>
                    <td className="cg-qcell">{l.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </section>
  );
}
