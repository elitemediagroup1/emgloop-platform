// The margin Loop shows is NET profit, and it is labelled as such.
//
// CallGrid reports two margins: "Profit" = Revenue - Payout, and "Net Profit" =
// Revenue - Payout - Cost (telco). Loop computes revenue - payout - cost -- CallGrid's
// Net Profit -- and used to label it "Profit", so the smaller number sat beside
// CallGrid's larger one under the same name and read as a discrepancy. The math is
// unchanged; the label now says what the number is.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { CALLGRID_METRICS, profitCents } from '@emgloop/shared';
import { callGridKpis } from '@emgloop/shared';

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

describe('11. Net profit labelling matches the math', () => {
  it('the one profit formula subtracts payout AND cost', () => {
    assert.equal(profitCents(2500, 1000, 4), 1496, '$25.00 - $10.00 - $0.04');
    assert.equal(profitCents(null, 1000, 4), null, 'unknown revenue is unknown profit, never a number');
  });

  it('the metric contract names it Net profit, and its formula carries the cost', () => {
    const profit = CALLGRID_METRICS.find((m) => m.metricKey === 'profit')!;
    assert.equal(profit.displayName, 'Net profit');
    assert.match(profit.formula, /- sum\(costCents\)/);
    const perBillable = CALLGRID_METRICS.find((m) => m.metricKey === 'profitPerBillableCall')!;
    assert.match(perBillable.displayName, /^Net Profit/);
  });

  it('Home and the Marketplace overview label the figure Net profit, and compute it with cost', () => {
    // Home's pulse labels the figure Net profit and reads the day score's own profitCents (2026-09-24:
    // the executive Home became the briefing; the label and the source column are the same).
    const home = read('../src/app/app/_home/briefing.ts');
    assert.match(home, /label: 'Net profit', yv: y\.profitCents, tv: t\.profitCents/);
    assert.equal(/label: 'Profit'/.test(home), false);
    const dashboard = read('../src/app/app/admin/dashboard-data.ts');
    assert.match(dashboard, /agg\.revenueCents - agg\.payoutCents - agg\.costCents/);

    // The CallGrid KPI row: labelled Net Profit, and its value is the canonical report's
    // own profitCents -- revenue − payout − telco cost -- never recomputed on the page.
    const kpis = callGridKpis({
      metrics: { available: true, totalCalls: 3, billableCalls: 2, revenueCents: 2500, profitCents: 1496, costCents: 4, revenueCoverage: 1, profitCoverage: 1 },
      comparison: null,
      series: [],
    });
    assert.equal(kpis[0]!.label, 'Net Profit');
    assert.equal(kpis[0]!.value, 1496);
    assert.equal(kpis.some((k) => k.label === 'Profit'), false);
    const command = read('../src/app/app/admin/marketplace/command-data.ts');
    assert.match(command, /callGridKpis\(\{\s*metrics: report\.metrics,\s*comparison: report\.comparison,/);
    const money = read('../src/app/app/admin/marketplace/money/page.tsx');
    assert.match(money, /label: "Net profit", cur: m\.profitCents/);
    assert.match(money, /label: "Telco cost", cur: m\.costCents/);
    const report = read('../src/app/app/admin/marketplace/callgrid-report.ts');
    assert.match(report, /profitCents\(revenue, agg\.payoutCents, agg\.costCents\)/);
  });
});
