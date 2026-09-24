// The margin Loop shows is NET profit, and it is labelled as such.
//
// CallGrid reports two margins: "Profit" = Revenue - Payout, and "Net Profit" =
// Revenue - Payout - Cost (telco). Loop computes revenue - payout - cost -- CallGrid's
// Net Profit -- and used to label it "Profit", so the smaller number sat beside
// CallGrid's larger one under the same name and read as a discrepancy. The math is
// unchanged; the label now says what the number is.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { CALLGRID_METRICS, profitCents } from '@emgloop/shared';
import { callGridKpis } from '@emgloop/shared';
import { HOME_KPI_KEYS, projectHomeKpis } from '../src/app/app/_home/kpis';

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
    // Home's KPI row (2026-09-24, the front door) shows the contract's own Net Profit KPI under the
    // contract's own label and value: nothing under _home computes a profit, relabels one, or reads a
    // scorecard of its own (the today-so-far vs yesterday-complete scorecard is retired).
    const kpisSrc = read('../src/app/app/_home/kpis.ts');
    assert.match(kpisSrc, /'revenue', 'netProfit', 'billableCalls', 'totalCalls'/, 'the contract KPIs Home shows, by their contract keys');
    assert.match(kpisSrc, /label: kpi\.label,/, 'the label is the contract’s');
    for (const file of ['../src/app/app/_home/kpis.ts', '../src/app/app/_home/briefing.ts', '../src/app/app/_home/tiles.ts', '../src/app/app/_home/front-door-view.tsx']) {
      const src = read(file);
      assert.equal(/label: 'Profit'|label: 'Net profit'/.test(src), false, `${file} relabels nothing`);
      assert.equal(/payoutCents|revenueCents\s*-\s*|profitCents\(/.test(src), false, `${file} computes no profit of its own`);
    }
    assert.equal(existsSync(fileURLToPath(new URL('../src/app/app/admin/dashboard-data.ts', import.meta.url))), false, 'the Home scorecard is retired');
    const strip = projectHomeKpis({
      kpis: callGridKpis({
        keys: HOME_KPI_KEYS,
        metrics: { available: true, totalCalls: 3, billableCalls: 2, revenueCents: 2500, profitCents: 1496, costCents: 4, revenueCoverage: 1, profitCoverage: 1 },
        comparison: null,
        series: [],
      }),
      window: { label: 'Sep 24, 2026', includesLiveData: true, comparisonLabel: null },
      coverage: { note: null },
      freshness: { state: 'LIVE', word: 'Live', detail: 'CallGrid delivered data 3 min ago.' },
      report: { ok: true, metrics: { available: true, totalCalls: 3, billableCalls: 2 }, dimensions: { campaigns: [] } },
      query: '',
    });
    assert.deepEqual(strip.kpis.map((k) => [k.key, k.label, k.value]).slice(0, 2), [['revenue', 'Revenue', '$25'], ['netProfit', 'Net Profit', '$15']], 'the contract’s value, in dollars, under the contract’s label');
    assert.equal(strip.kpis.some((k) => k.label === 'Profit'), false);

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
