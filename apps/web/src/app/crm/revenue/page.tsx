import { loadOrFallback, DbNotConfigured } from '../../../demo/db-health';
import { crmRepos, requireCrmContext } from '../../../crm/crm-data';
import { requirePermission } from '../../../auth/guard';
import { PartialDataNotice } from '../../app/_loop-os';
import type { RankedRevenue } from '@emgloop/database';

// Revenue Intelligence — Sprint 15, real-data hotfix.
//
// HONEST revenue posture. Realized revenue comes ONLY from Orders in
// PLACED / IN_PROGRESS / READY / FULFILLED (no Stripe, no AI, no accounting).
// When there is no realized revenue we say so plainly, and separately surface
// revenue PENDING (draft orders) and revenue-INFLUENCED journeys (customers
// with activity but no realized order). Demo/QA/test customers are excluded.
// Permission-gated by 'analytics'. Every figure is evidence-backed.

export const dynamic = 'force-dynamic';

function money(cents: number): string {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function pct(value: number, max: number): string {
  if (max <= 0) return '0%';
  return Math.min(100, Math.round((value / max) * 100)) + '%';
}

function RevenuePanel({ title, rows, empty }: { title: string; rows: RankedRevenue[]; empty: string }) {
  const max = Math.max(1, ...rows.map((r) => r.revenueCents));
  return (
    <div className="crm-analytics-panel">
      <div className="crm-analytics-panel-title">{title}</div>
      {rows.length === 0 ? (
        <p className="crm-empty" style={{ margin: 0 }}>{empty}</p>
      ) : (
        rows.map((r) => (
          <div key={r.key} className="crm-analytics-bar-row">
            <span className="crm-analytics-bar-label" title={r.label}>{r.label}</span>
            <div className="crm-analytics-bar-track">
              <div className="crm-analytics-bar-fill" style={{ width: pct(r.revenueCents, max) }} />
            </div>
            <span className="crm-analytics-bar-value">{money(r.revenueCents)}</span>
          </div>
        ))
      )}
    </div>
  );
}

export default async function RevenueIntelligencePage() {
  await requirePermission('analytics', 'view');

  const { organizationId: orgId } = await requireCrmContext();

  const result = await loadOrFallback(async () => {
    if (!orgId) return null;
    return crmRepos.revenueIntelligence.revenueByDimension(orgId);
  });

  if (!result.ok || !result.data) {
    return (
      <>
        <h1 className="crm-h1">Revenue Intelligence</h1>
        <DbNotConfigured />
      </>
    );
  }

  const rev = result.data;

  return (
    <>
      <div className="crm-wf-head">
        <div>
          <h1 className="crm-h1">Revenue Intelligence</h1>
          <p className="crm-sub">Realized revenue attributed across every dimension. Deterministic, evidence-backed, real Neon data — no Stripe, no AI · {rev.rangeLabel}.</p>
        </div>
      </div>

      <PartialDataNotice coverage={rev.coverage} />

      <div className="crm-analytics-hero">
        <div className="crm-analytics-kpi">
          <div className="crm-analytics-kpi-label">Realized Revenue</div>
          <div className="crm-analytics-kpi-value">{money(rev.realizedRevenueCents)}</div>
          <div className="crm-analytics-kpi-unit">{rev.realizedOrders} order{rev.realizedOrders === 1 ? '' : 's'}</div>
        </div>
        <div className="crm-analytics-kpi">
          <div className="crm-analytics-kpi-label">Revenue Pending</div>
          <div className="crm-analytics-kpi-value">{money(rev.pendingRevenueCents)}</div>
          <div className="crm-analytics-kpi-unit">{rev.pendingOrders} draft order{rev.pendingOrders === 1 ? '' : 's'}</div>
        </div>
        <div className="crm-analytics-kpi">
          <div className="crm-analytics-kpi-label">Revenue-influenced journeys</div>
          <div className="crm-analytics-kpi-value">{rev.influencedJourneys}</div>
          <div className="crm-analytics-kpi-unit">active, no realized order yet</div>
        </div>
      </div>

      {!rev.hasRealizedRevenue ? (
        <div className="crm-panel">
          <p className="crm-empty" style={{ margin: 0 }}>
            <strong>No realized revenue yet.</strong> The system is currently tracking calls and website
            activity, not completed sales. As Orders reach PLACED / IN&nbsp;PROGRESS / READY / FULFILLED,
            the Brain will attribute every dollar back to the website, vendor, source, campaign, signal and
            journey that produced it.
          </p>
          {(rev.pendingRevenueCents > 0 || rev.influencedJourneys > 0) ? (
            <p className="crm-sub" style={{ marginTop: '0.6rem' }}>
              Right now: {money(rev.pendingRevenueCents)} in revenue opportunity across {rev.pendingOrders} draft
              order{rev.pendingOrders === 1 ? '' : 's'}, and {rev.influencedJourneys} revenue-influenced
              journey{rev.influencedJourneys === 1 ? '' : 's'} with no realized order yet.
            </p>
          ) : null}
        </div>
      ) : (
        <>
          <div className="crm-analytics-grid">
            <RevenuePanel title="Revenue by Website" rows={rev.byWebsite} empty="No website-attributed revenue yet." />
            <RevenuePanel title="Revenue by Vendor" rows={rev.byVendor} empty="No vendor-attributed revenue yet." />
          </div>
          <div className="crm-analytics-grid">
            <RevenuePanel title="Revenue by Source" rows={rev.bySource} empty="No source-attributed revenue yet." />
            <RevenuePanel title="Revenue by Campaign" rows={rev.byCampaign} empty="No campaign-attributed revenue yet." />
          </div>
          <div className="crm-analytics-grid">
            <RevenuePanel title="Revenue by Buyer" rows={rev.byBuyer} empty="No buyer-attributed revenue yet." />
            <RevenuePanel title="Revenue by Channel" rows={rev.byChannel} empty="No channel-attributed revenue yet." />
          </div>
          <div className="crm-analytics-grid">
            <RevenuePanel title="Revenue by Signal" rows={rev.bySignal} empty="No signal-attributed revenue yet." />
            <RevenuePanel title="Revenue by Customer Journey" rows={rev.byJourney} empty="No journey-attributed revenue yet." />
          </div>
        </>
      )}
    </>
  );
}
