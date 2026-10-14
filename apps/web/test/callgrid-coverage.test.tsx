import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { callGridPollCoverage } from '../src/crm/callgrid-coverage';
import { CallGridCoverage } from '../src/crm/CallGridCoverage';
import { CALLGRID_KPI_LABELS, callFunnel, metricDefinition } from '@emgloop/shared';

const now = new Date('2026-10-14T15:00:00Z');
const checkpoint = (hoursAgo: number) => ({
  completedThrough: new Date(now.getTime() - hoursAgo * 3600000),
  lastIntervalSince: new Date(now.getTime() - (hoursAgo + 48) * 3600000),
  updatedAt: new Date(now.getTime() - hoursAgo * 3600000),
});

test('no checkpoint or failed read cannot claim complete coverage, even with live webhook delivery', () => {
  const missing = callGridPollCoverage({ now, readOk: true, checkpoint: null });
  assert.equal(missing.state, 'NEVER_PROVEN');
  const html = renderToStaticMarkup(<CallGridCoverage coverage={missing} />);
  assert.match(html, /No routine recovery coverage has been proven/);
  assert.match(html, /not inferred from this checkpoint/);
  assert.match(html, /not calls missing from Loop/);
  assert.equal(callGridPollCoverage({ now, readOk: false, checkpoint: checkpoint(1) }).state, 'UNAVAILABLE');
});

test('coverage falls behind independently of delivery freshness and never certifies all campaigns', () => {
  const recent = callGridPollCoverage({ now, readOk: true, checkpoint: checkpoint(1) });
  assert.equal(recent.state, 'CURRENT');
  assert.match(recent.message, /does not certify.*campaign scope/);
  const html = renderToStaticMarkup(<CallGridCoverage coverage={recent} />);
  assert.match(html, /Recovery job health: within threshold/);
  assert.match(html, /does not mean live totals are reconciled/);
  assert.match(html, /later financial updates/);
  assert.equal(callGridPollCoverage({ now, readOk: true, checkpoint: checkpoint(4) }).state, 'LAGGING');
  assert.equal(callGridPollCoverage({ now, readOk: true, checkpoint: checkpoint(13) }).state, 'STALE');
  assert.equal(callGridPollCoverage({ now, readOk: true, checkpoint: checkpoint(-1) }).state, 'INVALID');
});

test('commercial outcome metric is explicitly derived and displayed as monetized', () => {
  const metric = metricDefinition('billableCalls');
  assert.equal(metric?.displayName, 'Monetized Calls');
  assert.equal(metric?.classification, 'DERIVED');
  assert.match(metric!.description, /billable, converted, or paid/);
  assert.equal(CALLGRID_KPI_LABELS.billableCalls, 'Monetized Calls');
  const funnel = callFunnel({ calls: 3, completed: 3, completedReported: 3, monetized: 2, noRoute: 0, noRouteReported: 3 }, { revenueCents: 1000, profitCents: 200 });
  assert.equal(funnel.find((s) => s.key === 'billable')?.label, 'Monetized');
  assert.equal(funnel.find((s) => s.key === 'billable')?.value, 2);
});
