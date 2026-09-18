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
    const home = read('../src/app/app/_home/admin-home.tsx');
    assert.match(home, /label="Net profit"[^>]*profitCents/);
    assert.equal(/label="Profit"/.test(home), false);
    const dashboard = read('../src/app/app/admin/dashboard-data.ts');
    assert.match(dashboard, /agg\.revenueCents - agg\.payoutCents - agg\.costCents/);

    const overview = read('../src/app/app/admin/marketplace/page.tsx');
    assert.match(overview, /key: "Net Profit", val: money\(score\.profitCents/);
    assert.equal(/key: "Profit"/.test(overview), false);
    const report = read('../src/app/app/admin/marketplace/callgrid-report.ts');
    assert.match(report, /profitCents\(revenue, agg\.payoutCents, agg\.costCents\)/);
  });
});
