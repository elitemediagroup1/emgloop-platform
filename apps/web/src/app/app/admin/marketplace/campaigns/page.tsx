import Link from "next/link";
import { SidebarIcon } from "../../../../crm/_brand/SidebarIcon";
import { loadOrFallback } from "../../../../../demo/db-health";
import { crmRepos, resolveCrmOrganizationId } from "../../../../../crm/crm-data";
import { loadProviderCards, computeSystemHealth, connectionLabel } from "../../../../../crm/integration-os";
import type { Tone, Ranked } from "../../../_loop-os";
import {
  money,
  num,
  relTime,
  clockDuration,
  todayLabel,
  Module,
  RankedList,
  Bar,
  IntegrationPill,
} from "../../../_loop-os";

export const dynamic = "force-dynamic";

type Pill = { name: string; state: "connected" | "needs" | "error" };

export default async function CampaignIntelligencePage() {
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

  const campaignRows: Ranked[] = rev ? rev.byCampaign : [];
  const buyerRows: Ranked[] = rev ? rev.byBuyer : [];
  const sourceRows: Ranked[] = rev ? rev.bySource : [];
  const vendorRows: Ranked[] = rev ? rev.byVendor : [];

  const totalCampaigns = campaignRows.length;
  const totalCalls = traffic ? traffic.totalCalls : 0;
  const qualified = traffic ? traffic.qualifiedCalls : 0;
  const bookings = traffic ? traffic.bookings : 0;
  const attributed = traffic ? traffic.attributedCalls : 0;
  const totalRevenue = rev ? rev.totalRevenueCents : 0;

  const denom = totalCalls > 0 ? totalCalls : 1;
  const attributionPct = Math.round((attributed / denom) * 100);
  const qualifiedPct = Math.round((qualified / denom) * 100);
  const bookingsPct = Math.round((bookings / denom) * 100);

  const hasCampaignData = totalCampaigns > 0;

  const rankedCampaigns = campaignRows
    .slice()
    .sort((a, b) => (b.revenueCents || 0) - (a.revenueCents || 0));
  const topCampaign = rankedCampaigns.length > 0 ? rankedCampaigns[0] : null;

  const pills: Pill[] = cards.map((card: any) => {
    const name = card.spec.displayName || "Provider";
    const conn = card.status ? card.status.connection : undefined;
    const label = String(connectionLabel(conn) || "").toLowerCase();
    let state: Pill["state"] = "needs";
    if (label.indexOf("fail") >= 0) state = "error";
    else if (label.indexOf("connect") >= 0 && label.indexOf("not") < 0) state = "connected";
    return { name, state };
  });
  const connectedPills = pills.filter((p) => p.state === "connected");
  const needsPills = pills.filter((p) => p.state === "needs");
  const errorPills = pills.filter((p) => p.state === "error");
  const orderedPills = connectedPills.concat(errorPills, needsPills).slice(0, 6);

  const marketplaceHealthy = errorPills.length === 0 && hasCampaignData;
  const summaryTone: Tone = !hasCampaignData ? "idle" : marketplaceHealthy ? "good" : "warn";
  const summaryLine = !hasCampaignData
    ? "No campaign data yet. Campaign intelligence will populate as attributed traffic arrives."
    : marketplaceHealthy
    ? num(totalCampaigns) + " campaigns tracked. Attribution and integrations look healthy."
    : num(totalCampaigns) + " campaigns tracked. Some integrations need attention before totals are complete.";

  function campaignTone(r: Ranked): Tone {
    const cents = r.revenueCents || 0;
    if (cents > 0) return "good";
    if ((r.orders || 0) > 0) return "warn";
    return "idle";
  }

  return (
    <div className="loop-os loop-os--v3 loop-os--v4 loop-os--v5">
      <main className="loop-os__main">
        <header className="loop-os__brief">
          <div className="loop-os__brief-main">
            <p className="loop-os__brief-lead">Campaign Intelligence</p>
            <p className="loop-os__brief-body">{summaryLine}</p>
            <div className="loop-os__brief-cta">
              <span className="loop-os__brief-chip loop-os__brief-chiptoday">Today</span>
              <span className="loop-os__brief-chip loop-os__brief-chipdate">{dateLabel}</span>
            </div>
          </div>
        </header>

        <section className="loop-modgrid">
          <Module icon="chart" title="Campaigns" metric={num(totalCampaigns)} detail="Tracked in marketplace" tone={summaryTone} href="/app/admin/marketplace" seed={11} />
          <Module icon="chat" title="Calls" metric={num(totalCalls)} detail={num(attributed) + " attributed"} tone="idle" href="/app/admin/marketplace" seed={22} />
          <Module icon="star" title="Qualified" metric={num(qualified)} detail={qualifiedPct + "% of calls"} tone="idle" href="/app/admin/marketplace" seed={33} />
          <Module icon="calendar" title="Bookings" metric={num(bookings)} detail={bookingsPct + "% of calls"} tone="idle" href="/app/admin/marketplace" seed={44} />
          <Module icon="revenue" title="Revenue" metric={money(totalRevenue)} detail="Across campaigns" tone="idle" href="/app/admin/marketplace" seed={55} />
          <Module icon="activity" title="Attribution" metric={attributionPct + "%"} detail="Calls with known source" tone={attributionPct >= 90 ? "good" : "warn"} href="/app/admin/marketplace" seed={66} />
        </section>

        <section className="loop-grid">
          <div className="loop-grid__content">
            <div className="loop-card loop-market">
              <div className="loop-card__head">
                <p className="loop-card__title">Campaign health</p>
                <Link className="loop-card__link" href="/app/admin/marketplace">Marketplace overview</Link>
              </div>
              <div className="loop-market__body">
                {hasCampaignData ? (
                  <div className="loop-market__bars">
                    <Bar label="Attributed calls" value={num(attributed)} pct={attributionPct} tone="good" />
                    <Bar label="Qualified calls" value={num(qualified)} pct={qualifiedPct} tone="idle" />
                    <Bar label="Bookings" value={num(bookings)} pct={bookingsPct} tone="idle" />
                  </div>
                ) : (
                  <div className="loop-empty">
                    <p className="loop-empty__title">No campaign health data yet</p>
                    <p className="loop-empty__body">Health bars appear once attributed traffic is recorded.</p>
                  </div>
                )}
                {hasCampaignData ? (
                  <RankedList icon="chart" title="Campaigns by revenue" rows={rankedCampaigns} metric="revenue" />
                ) : null}
              </div>
            </div>

            <div className="loop-card">
              <div className="loop-card__head">
                <p className="loop-card__title">Top campaign detail</p>
              </div>
              {topCampaign ? (
                <div className="loop-market__bars">
                  <Bar label={"Campaign " + (topCampaign.label || topCampaign.key || "Unknown")} value={money(topCampaign.revenueCents || 0)} pct={100} tone="good" />
                  <Bar label="Orders" value={num(topCampaign.orders || 0)} pct={Math.min(100, (topCampaign.orders || 0))} tone="idle" />
                </div>
              ) : (
                <div className="loop-empty">
                  <p className="loop-empty__title">No lead campaign yet</p>
                  <p className="loop-empty__body">The strongest campaign will surface here once revenue is attributed.</p>
                </div>
              )}
            </div>

            <div className="loop-card loop-market">
              <div className="loop-card__head">
                <p className="loop-card__title">Buyer / source / vendor breakdown</p>
              </div>
              <div className="loop-market__body">
                {buyerRows.length > 0 ? (
                  <RankedList icon="users" title="Top buyers" rows={buyerRows} metric="revenue" />
                ) : (
                  <div className="loop-empty">
                    <p className="loop-empty__title">No buyer breakdown yet</p>
                    <p className="loop-empty__body">Buyer performance appears once revenue is attributed.</p>
                  </div>
                )}
                {sourceRows.length > 0 ? (
                  <RankedList icon="activity" title="Top sources" rows={sourceRows} metric="revenue" />
                ) : null}
                {vendorRows.length > 0 ? (
                  <RankedList icon="building" title="Top vendors" rows={vendorRows} metric="revenue" />
                ) : null}
              </div>
            </div>

            <div className="loop-card loop-feed">
              <div className="loop-card__head">
                <p className="loop-card__title">Recent activity</p>
                <Link className="loop-card__link" href="/app/admin/marketplace">Marketplace overview</Link>
              </div>
              {liveActivity.length > 0 ? (
                <ul className="loop-feed__list">
                  {liveActivity.slice(0, 6).map((a: any) => (
                    <li className="loop-feed__item" key={a.id}>
                      <span className="loop-feed__dot" />
                      <span className="loop-feed__label">{a.label || a.kind || "Event"}</span>
                      <span className="loop-feed__time">{relTime(a.at)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="loop-empty">
                  <p className="loop-empty__title">Campaign activity not available yet</p>
                  <p className="loop-empty__body">Recent marketplace activity will appear here as events are recorded.</p>
                </div>
              )}
            </div>

            <div className="loop-card">
              <div className="loop-card__head">
                <p className="loop-card__title">Campaign briefing</p>
                <span className="loop-badge loop-badge--idle">Standby</span>
              </div>
              <div className="loop-empty loop-empty--good">
                <p className="loop-empty__title">Campaign briefing waiting for persisted Brain insights</p>
                <p className="loop-empty__body">The Brain computes campaign intelligence on its own schedule. <Link className="loop-card__link" href="/app/admin/brain">Open Brain</Link></p>
              </div>
            </div>
          </div>

          <aside className="loop-rail">
            <div className="loop-card loop-feed">
              <div className="loop-card__head">
                <p className="loop-card__title">Live calls <span className="loop-count">{liveCalls.length}</span></p>
                <Link className="loop-card__link" href="/app/admin/marketplace">View all</Link>
              </div>
              {liveCalls.length > 0 ? (
                <ul className="loop-feed__list">
                  {liveCalls.slice(0, 6).map((c: any) => (
                    <li className="loop-feed__item" key={c.id}>
                      <span className="loop-feed__phone">{c.caller}</span>
                      <span className="loop-feed__time">{clockDuration(c.durationSeconds)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="loop-quiet">No live calls right now.</p>
              )}
            </div>

            <div className="loop-card loop-intg">
              <div className="loop-card__head">
                <p className="loop-card__title">Integration status</p>
                <Link className="loop-card__link" href="/app/admin/integrations">View all</Link>
              </div>
              <div className="loop-intg__summary">
                <span className="loop-intg__stat loop-intg__stat--connected">{connectedPills.length} Connected</span>
                <span className="loop-intg__stat loop-intg__stat--needs">{needsPills.length} Needs Setup</span>
                <span className="loop-intg__stat loop-intg__stat--error">{errorPills.length} Errors</span>
              </div>
              {orderedPills.length > 0 ? (
                <div className="loop-intg__grid">
                  {orderedPills.map((p) => (
                    <IntegrationPill key={p.name} name={p.name} state={p.state} />
                  ))}
                </div>
              ) : (
                <p className="loop-quiet">No integrations connected yet.</p>
              )}
            </div>

            <div className="loop-card">
              <div className="loop-card__head">
                <p className="loop-card__title">Quick links</p>
              </div>
              <ul className="loop-feed__list">
                <li className="loop-feed__item"><SidebarIcon name="grid" /><Link className="loop-card__link" href="/app/admin/marketplace">Marketplace overview</Link></li>
                <li className="loop-feed__item"><SidebarIcon name="grid" /><Link className="loop-card__link" href="/app/admin/marketplace-intelligence">Marketplace intelligence</Link></li>
              </ul>
            </div>
          </aside>
        </section>
      </main>
    </div>
  );
}
