import Link from "next/link";
import { SidebarIcon } from "../../../crm/_brand/SidebarIcon";
import { loadOrFallback } from "../../../../demo/db-health";
import { crmRepos, resolveCrmOrganizationId } from "../../../../crm/crm-data";
import { loadProviderCards, computeSystemHealth, connectionLabel } from "../../../../crm/integration-os";
import type { Tone } from "../../_loop-os";
import {
  money,
  num,
  todayLabel,
  relTime,
  clockDuration,
  Module,
  Bar,
  RankedList,
  IntegrationPill,
} from "../../_loop-os";

export const dynamic = "force-dynamic";

export default async function MarketplaceCommandCenter() {
  const org = await resolveCrmOrganizationId();

  const revenueR = org
    ? await loadOrFallback(async () => crmRepos.revenueIntelligence.revenueByDimension(org))
    : { ok: false as const };
  const trafficR = org
    ? await loadOrFallback(async () => crmRepos.revenueIntelligence.trafficIntelligence(org))
    : { ok: false as const };
  const liveCallsR = org
    ? await loadOrFallback(async () => crmRepos.liveOperations.listLiveCalls(org))
    : { ok: false as const };
  const liveActivityR = org
    ? await loadOrFallback(async () => crmRepos.liveOperations.listLiveActivity(org))
    : { ok: false as const };
  const integrationsR = org
    ? await loadOrFallback(async () => loadProviderCards(org))
    : { ok: false as const };

  const rev = revenueR.ok ? revenueR.data : null;
  const traffic = trafficR.ok ? trafficR.data : null;
  const liveCalls = liveCallsR.ok ? liveCallsR.data : [];
  const liveActivity = liveActivityR.ok ? liveActivityR.data : [];
  const cards = integrationsR.ok ? integrationsR.data : [];
  const health = computeSystemHealth(cards);

  const dateLabel = todayLabel();

  const totalCalls = traffic ? traffic.totalCalls : 0;
  const attributed = traffic ? traffic.attributedCalls : 0;
  const qualified = traffic ? traffic.qualifiedCalls : 0;
  const bookings = traffic ? traffic.bookings : 0;
  const unattributed = traffic ? traffic.unattributedCalls : 0;

  const totalRevenue = rev ? rev.totalRevenueCents : 0;
  const realizedRevenue = rev ? rev.realizedRevenueCents : 0;
  const totalOrders = rev ? rev.totalOrders : 0;

  const buyerRows = rev ? rev.byBuyer : [];
  const campaignRows = rev ? rev.byCampaign : [];
  const sourceRows = rev ? rev.bySource : [];
  const vendorRows = rev ? rev.byVendor : [];
  const activeBuyers = buyerRows.length;

  const liveCount = liveCalls.length;
  const connectedCount = health.connected;

  const denom = totalCalls > 0 ? totalCalls : 1;
  const attributedPct = Math.round((attributed / denom) * 100);
  const qualifiedPct = Math.round((qualified / denom) * 100);
  const bookingsPct = Math.round((bookings / denom) * 100);

  type Pill = { name: string; state: "connected" | "needs" | "error" };

  const pills: Pill[] = (cards || []).map((card: any) => {
    const name = (card && card.spec && (card.spec.displayName || card.spec.name)) || "Provider";
    const conn = card && card.status ? card.status.connection : undefined;
    const label = String(connectionLabel(conn) || "").toLowerCase();
    let state: "connected" | "needs" | "error" = "needs";
    if (label.indexOf("error") >= 0 || label.indexOf("fail") >= 0) state = "error";
    else if (label.indexOf("connect") >= 0 && label.indexOf("not") < 0) state = "connected";
    return { name, state };
  });
  const connectedPills = pills.filter((p) => p.state === "connected");
  const needsPills = pills.filter((p) => p.state === "needs");
  const errorPills = pills.filter((p) => p.state === "error");
  const orderedPills = connectedPills.concat(errorPills, needsPills).slice(0, 6);

  const marketplaceHealthy = errorPills.length === 0;
  const summaryTone: Tone = errorPills.length > 0 ? "warn" : marketplaceHealthy ? "good" : "idle";

  return (
    <div className="loop-os loop-os--v3 loop-os--v4 loop-os--v5">
      <div className="loop-os__main">
        {/* 1. Marketplace executive summary */}
        <header className="loop-os__brief">
          <div className="loop-os__brief-main">
            <p className="loop-os__brief-lead">Marketplace</p>
            <h1 className={"loop-os__brief-title loop-os__brief-title--" + summaryTone}>
              Command Center
            </h1>
            <p className="loop-os__brief-body">
              {num(totalCalls)} calls tracked {"\u00b7"} {num(attributed)} attributed {"\u00b7"}{" "}
              {money(totalRevenue)} revenue across {num(activeBuyers)} buyers.
            </p>
            <Link href="/app/admin" className="loop-os__brief-cta">
              Back to Overview <span aria-hidden="true">{"\u2192"}</span>
            </Link>
          </div>
          <div className="loop-os__brief-chip">
            <SidebarIcon name="calendar" />
            <span className="loop-os__brief-chiptoday">Today</span>
            <span className="loop-os__brief-chipdate">{dateLabel}</span>
          </div>
        </header>

        {/* 2. Revenue / Calls / Qualified / Bookings / Buyers / Sources modules */}
        <section className="loop-modgrid" aria-label="Marketplace metrics">
          <Module icon="dollar" title="Revenue" metric={money(totalRevenue)} detail={money(realizedRevenue) + " realized"} tone="good" href="/app/admin/marketplace" seed={2} />
          <Module icon="phone" title="Calls" metric={num(totalCalls)} unit="calls" detail={num(attributed) + " attributed"} tone="good" href="/app/admin/marketplace" seed={5} />
          <Module icon="check" title="Qualified" metric={num(qualified)} unit="calls" detail={qualifiedPct + "% of calls"} tone={qualified > 0 ? "good" : "idle"} href="/app/admin/marketplace" seed={8} />
          <Module icon="calendar" title="Bookings" metric={num(bookings)} unit="booked" detail={num(totalOrders) + " orders"} tone={bookings > 0 ? "good" : "idle"} href="/app/admin/marketplace" seed={11} />
          <Module icon="users" title="Buyers" metric={num(activeBuyers)} unit="active" detail="In your marketplace" tone={activeBuyers > 0 ? "good" : "idle"} href="/app/admin/marketplace" seed={14} />
          <Module icon="grid" title="Sources" metric={num(sourceRows.length)} unit="live" detail={num(unattributed) + " unattributed"} tone={sourceRows.length > 0 ? "good" : "idle"} href="/app/admin/marketplace" seed={17} />
        </section>

        <div className="loop-grid">
          <div className="loop-grid__content">
            {/* Attribution health */}
            <section className="loop-card loop-market">
              <div className="loop-card__head">
                <h2 className="loop-card__title">Marketplace Health</h2>
                <span className="loop-card__link">{attributedPct}% attributed</span>
              </div>
              <div className="loop-market__body">
                <div className="loop-market__bars">
                  <Bar label="Attributed Calls" value={num(attributed)} pct={attributedPct} tone="good" />
                  <Bar label="Qualified Calls" value={num(qualified)} pct={qualifiedPct} tone={qualified > 0 ? "good" : "idle"} />
                  <Bar label="Bookings" value={num(bookings)} pct={bookingsPct} tone={bookings > 0 ? "good" : "idle"} />
                </div>
              </div>
            </section>

            {/* 3. Campaign health */}
            <section className="loop-card">
              <div className="loop-card__head">
                <h2 className="loop-card__title">Campaign Health</h2>
                <Link href="/app/admin/marketplace" className="loop-card__link">View all</Link>
              </div>
              {campaignRows.length === 0 ? (
                <div className="loop-empty">
                  <div className="loop-empty__title">No campaign data yet</div>
                  <div className="loop-empty__body">Campaign performance will appear here once attributed calls are recorded.</div>
                </div>
              ) : (
                <RankedList icon="target" title="Top Campaigns" rows={campaignRows} metric="revenue" />
              )}
            </section>

            {/* 4. Buyer performance */}
            <section className="loop-card">
              <div className="loop-card__head">
                <h2 className="loop-card__title">Buyer Performance</h2>
                <Link href="/app/admin/marketplace" className="loop-card__link">View all</Link>
              </div>
              {buyerRows.length === 0 ? (
                <div className="loop-empty">
                  <div className="loop-empty__title">No buyers yet</div>
                  <div className="loop-empty__body">Buyer performance will appear here once buyers are active in your marketplace.</div>
                </div>
              ) : (
                <RankedList icon="users" title="Top Buyers" rows={buyerRows} metric="revenue" />
              )}
            </section>

            {/* 5. Source / publisher performance */}
            <section className="loop-card">
              <div className="loop-card__head">
                <h2 className="loop-card__title">Source &amp; Publisher Performance</h2>
                <Link href="/app/admin/marketplace" className="loop-card__link">View all</Link>
              </div>
              {sourceRows.length === 0 ? (
                <div className="loop-empty">
                  <div className="loop-empty__title">No source data yet</div>
                  <div className="loop-empty__body">Source and publisher quality will appear here once traffic is attributed.</div>
                </div>
              ) : (
                <RankedList icon="grid" title="Top Sources" rows={sourceRows} metric="revenue" />
              )}
            </section>

            {/* 6. Vendor performance */}
            <section className="loop-card">
              <div className="loop-card__head">
                <h2 className="loop-card__title">Vendor Performance</h2>
                <Link href="/app/admin/marketplace" className="loop-card__link">View all</Link>
              </div>
              {vendorRows.length === 0 ? (
                <div className="loop-empty">
                  <div className="loop-empty__title">No vendor data yet</div>
                  <div className="loop-empty__body">Vendor performance will appear here once vendors deliver attributed calls.</div>
                </div>
              ) : (
                <RankedList icon="briefcase" title="Top Vendors" rows={vendorRows} metric="revenue" />
              )}
            </section>

            {/* 8. Brain insights placeholder */}
            <section className="loop-card">
              <div className="loop-card__head">
                <h2 className="loop-card__title">Brain Insights</h2>
                <span className="loop-badge loop-badge--idle">Standby</span>
              </div>
              <div className="loop-empty loop-empty--good">
                <div className="loop-empty__title">The Brain is preparing marketplace intelligence.</div>
                <div className="loop-empty__body">Recommendations, risks, and opportunities will appear here once the Brain has persisted a marketplace briefing.</div>
              </div>
            </section>
          </div>

          {/* 9. Right rail: live calls + integration status */}
          <aside className="loop-rail">
            {/* 7. Live marketplace activity */}
            <section className="loop-card loop-feed">
              <div className="loop-card__head">
                <h2 className="loop-card__title">Live Activity</h2>
                <Link href="/app/admin" className="loop-card__link">View all</Link>
              </div>
              {liveActivity.length === 0 ? (
                <div className="loop-quiet">No recent marketplace activity.</div>
              ) : (
                <ul className="loop-feed__list">
                  {liveActivity.slice(0, 6).map((a, i) => (
                    <li className="loop-feed__item" key={i}>
                      <span className="loop-feed__dot" aria-hidden="true" />
                      <span className="loop-feed__label">{a.label || a.kind || "Event"}</span>
                      <span className="loop-feed__time">{relTime(a.at)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="loop-card loop-feed">
              <div className="loop-card__head">
                <h2 className="loop-card__title">Live Calls</h2>
                <span className="loop-count">{num(liveCount)}</span>
              </div>
              {liveCalls.length === 0 ? (
                <div className="loop-quiet">No live calls right now.</div>
              ) : (
                <ul className="loop-feed__list">
                  {liveCalls.slice(0, 6).map((c, i) => (
                    <li className="loop-feed__item" key={i}>
                      <span className="loop-feed__dot" aria-hidden="true" />
                      <span className="loop-feed__phone">{c.caller}</span>
                      <span className="loop-feed__time">{clockDuration(c.durationSeconds)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="loop-card loop-intg">
              <div className="loop-card__head">
                <h2 className="loop-card__title">Integration Status</h2>
                <Link href="/app/admin/integrations" className="loop-card__link">View all</Link>
              </div>
              <div className="loop-intg__summary">
                <span className="loop-intg__stat loop-intg__stat--connected">{num(connectedCount)} Connected</span>
                <span className="loop-intg__stat loop-intg__stat--needs">{num(needsPills.length)} Needs Setup</span>
                <span className="loop-intg__stat loop-intg__stat--error">{num(errorPills.length)} Errors</span>
              </div>
              {orderedPills.length === 0 ? (
                <div className="loop-quiet">No providers configured.</div>
              ) : (
                <div className="loop-intg__grid">
                  {orderedPills.map((p, i) => (
                    <IntegrationPill key={p.name + i} name={p.name} state={p.state} />
                  ))}
                </div>
              )}
            </section>
          </aside>
        </div>
      </div>
    </div>
  );
}

