// Campaign Intelligence workspace (read-only). Composes existing repositories via the Loop OS design system; no backend/API/DB/schema/Brain/CallGrid changes.
import Link from "next/link";
import { hasValue } from "@emgloop/shared";
import { MarketplaceDecisionQueue } from "../_MarketplaceDecisionQueue";
import type { MarketplaceDecisionItem } from "../_MarketplaceDecisionQueue";
import { loadOrFallback } from "../../../../../demo/db-health";
import { crmRepos, requireCrmContext } from "../../../../../crm/crm-data";
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
  PartialDataNotice,
  Bar,
  IntegrationPill,
  ContextGroup,
} from "../../../_loop-os";

export const dynamic = "force-dynamic";

type Pill = { name: string; state: "connected" | "needs" | "error" };

export default async function CampaignIntelligencePage() {
  const { organizationId: org } = await requireCrmContext();

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

  // The repository now produces Truth. Unwrap once here: a non-value state
  // (ERROR / UNKNOWN) becomes null, which this page already renders as absent.
  const rev = revenueR.ok && hasValue(revenueR.data) ? revenueR.data.value : null;
  const traffic = trafficR.ok && hasValue(trafficR.data) ? trafficR.data.value : null;
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

  const decisions: MarketplaceDecisionItem[] = [];
  if (errorPills.length > 0) {
    decisions.push({
      icon: "plug",
      tone: "crit",
      title: errorPills.length + " integration error" + (errorPills.length === 1 ? "" : "s"),
      detail: "Some providers report errors that can distort campaign attribution.",
    });
  }
  if (needsPills.length > 0) {
    decisions.push({
      icon: "plug",
      tone: "warn",
      title: needsPills.length + " provider" + (needsPills.length === 1 ? "" : "s") + " need setup",
      detail: "Finish connecting providers to complete campaign attribution.",
    });
  }
  if (!hasCampaignData || totalCalls === 0) {
    decisions.push({
      icon: "chart",
      tone: "idle",
      title: "No attributed campaign calls yet",
      detail: "Campaign performance appears once attributed traffic is recorded.",
    });
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


        <PartialDataNotice coverage={[rev?.coverage, traffic?.coverage]} />

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
                <p className="loop-empty__body">The Brain computes campaign intelligence on its own schedule. <Link className="loop-card__link" href="/app/admin/marketplace">Open Brain</Link></p>
              </div>
            </div>
            <MarketplaceDecisionQueue
              items={decisions}
              reviewHref="/app/admin/marketplace/campaigns"
              emptyBody="No campaign decisions are supported by the current data."
            />
          </div>

          <aside className="loop-rail">
            <div className="loop-card loop-feed">
              <div className="loop-card__head">
                <p className="loop-card__title">Live Calls <span className="loop-count">{liveCalls.length}</span></p>
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
                <p className="loop-card__title">Integration Status</p>
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
                <span className="loop-card__title">Shortcuts</span>
              </div>
              <div className="loop-brief">
                <Link className="loop-card__link" href="/app/admin/marketplace">Marketplace overview</Link>
                <Link className="loop-card__link" href="/app/admin/marketplace/buyers">Buyer Operating System</Link>
                <Link className="loop-card__link" href="/app/admin/marketplace/sources">Source / Publisher Operating System</Link>
                <Link className="loop-card__link" href="/app/admin/marketplace/vendors">Vendor Operating System</Link>
              </div>
            </div>
          
          <ContextGroup
            title="Related"
            caption="How campaigns connect across your marketplace."
            links={[
              {
                icon: "users",
                title: "Buyers",
                detail: "See who is purchasing this campaign traffic.",
                href: "/app/admin/marketplace/buyers",
              },
              {
                icon: "building",
                title: "Vendors",
                detail: "Review the vendors delivering these campaigns.",
                href: "/app/admin/marketplace/vendors",
              },
              {
                icon: "flow",
                title: "Sources",
                detail: "Trace the sources feeding this campaign.",
                href: "/app/admin/marketplace/sources",
              },
              {
                icon: "activity",
                title: "Activity",
                detail: "Follow the live event stream for these campaigns.",
                href: "/app/admin/marketplace/activity",
              },
              {
                icon: "brain",
                title: "Brain",
                detail: "See recommendations that reference campaigns.",
                href: "/app/admin/marketplace",
              },
            ]}
          />
        </aside>
        </section>
      </main>
    </div>
  );
}
