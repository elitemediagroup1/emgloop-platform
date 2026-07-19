// Buyer Operating System workspace (read-only). Composes existing repositories via the Loop OS design system; no backend/API/DB/schema/Brain/CallGrid changes.
import Link from "next/link";
import { hasValue } from "@emgloop/shared";
import { MarketplaceNav } from "../_MarketplaceNav";
import { MarketplaceDecisionQueue } from "../_MarketplaceDecisionQueue";
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
  BriefingItem,
  IntegrationPill,
  ContextGroup,
} from "../../../_loop-os";

export const dynamic = "force-dynamic";

type Pill = { name: string; state: "connected" | "needs" | "error" };

export default async function BuyerOperatingSystemPage() {
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

  const buyerRows: Ranked[] = rev ? rev.byBuyer : [];
  const campaignRows: Ranked[] = rev ? rev.byCampaign : [];
  const sourceRows: Ranked[] = rev ? rev.bySource : [];
  const vendorRows: Ranked[] = rev ? rev.byVendor : [];

  const totalBuyers = buyerRows.length;
  const activeBuyers = buyerRows.filter((b) => (b.revenueCents || 0) > 0 || (b.orders || 0) > 0).length;
  const totalRevenue = rev ? rev.totalRevenueCents : 0;
  const totalOrders = rev ? rev.totalOrders : 0;

  const hasBuyerData = totalBuyers > 0;

  const rankedBuyers = buyerRows
    .slice()
    .sort((a, b) => (b.revenueCents || 0) - (a.revenueCents || 0));
  const topBuyer = rankedBuyers.length > 0 ? rankedBuyers[0] : null;

  // Decision queue is derived ONLY from facts already present in the data.
  type Decision = { icon: string; tone: Tone; title: string; detail: string };
  const decisions: Decision[] = [];
  if (hasBuyerData) {
    const noVolume = buyerRows.filter((b) => (b.orders || 0) === 0 && (b.revenueCents || 0) === 0);
    if (noVolume.length > 0) {
      decisions.push({
        icon: "users",
        tone: "warn",
        title: num(noVolume.length) + " buyers have no recorded volume",
        detail: "No orders or revenue recorded for these buyers yet.",
      });
    }
    const withVolume = rankedBuyers.filter((b) => (b.revenueCents || 0) > 0 || (b.orders || 0) > 0);
    const lowest = withVolume.length > 1 ? withVolume[withVolume.length - 1] : null;
    if (lowest) {
      decisions.push({
        icon: "activity",
        tone: "idle",
        title: "Lowest-volume active buyer: " + (lowest.label || lowest.key || "Unknown"),
        detail: money(lowest.revenueCents || 0) + " revenue across " + num(lowest.orders || 0) + " orders.",
      });
    }
  }

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

  const attentionCount = decisions.length;
  const summaryTone: Tone = !hasBuyerData ? "idle" : attentionCount > 0 ? "warn" : "good";
  const summaryLine = !hasBuyerData
    ? "No buyer data yet. The buyer workspace will populate as demand is recorded."
    : attentionCount === 0
    ? "Buyer demand remains stable."
    : attentionCount === 1
    ? "One buyer signal needs your review."
    : num(attentionCount) + " buyer signals need your review.";

  function buyerTone(b: Ranked): Tone {
    if ((b.revenueCents || 0) > 0) return "good";
    if ((b.orders || 0) > 0) return "warn";
    return "idle";
  }
  function buyerStatus(b: Ranked): string {
    if ((b.revenueCents || 0) > 0) return "Active";
    if ((b.orders || 0) > 0) return "Pending";
    return "Idle";
  }

  return (
    <div className="loop-os loop-os--v3 loop-os--v4 loop-os--v5">
      <main className="loop-os__main">
        <header className="loop-os__brief">
          <div className="loop-os__brief-main">
            <p className="loop-os__brief-lead">Buyer Operating System</p>
            <p className="loop-os__brief-body">{summaryLine}</p>
            <div className="loop-os__brief-cta">
              <span className="loop-os__brief-chip loop-os__brief-chiptoday">Today</span>
              <span className="loop-os__brief-chip loop-os__brief-chipdate">{dateLabel}</span>
            </div>
          </div>
        </header>

        <MarketplaceNav active="buyers" />

        <PartialDataNotice coverage={[rev?.coverage, traffic?.coverage]} />

        <section className="loop-modgrid">
          <Module icon="users" title="Total Buyers" metric={num(totalBuyers)} detail="In your marketplace" tone={hasBuyerData ? "good" : "idle"} href="/app/admin/marketplace/buyers" seed={11} />
          <Module icon="team" title="Active Buyers" metric={num(activeBuyers)} detail="With recorded volume" tone={activeBuyers > 0 ? "good" : "idle"} href="/app/admin/marketplace/buyers" seed={22} />
          <Module icon="revenue" title="Revenue" metric={money(totalRevenue)} detail={num(totalOrders) + " orders"} tone="idle" href="/app/admin/marketplace/buyers" seed={33} />
          <Module icon="chart" title="Profit" metric="Not available" detail="Margin not exposed by data" tone="idle" href="/app/admin/marketplace/buyers" seed={44} />
          <Module icon="columns" title="Capacity" metric="Not available" detail="Buyer caps not exposed by data" tone="idle" href="/app/admin/marketplace/buyers" seed={55} />
          <Module icon="star" title="Quality" metric="Not available" detail="Buyer quality not exposed by data" tone="idle" href="/app/admin/marketplace/buyers" seed={66} />
        </section>

        <section className="loop-grid">
          <div className="loop-grid__content">
            <div className="loop-card loop-market">
              <div className="loop-card__head">
                <p className="loop-card__title">Buyer directory</p>
                <Link className="loop-card__link" href="/app/admin/marketplace">Marketplace overview</Link>
              </div>
              <div className="loop-market__body">
                {hasBuyerData ? (
                  <RankedList icon="users" title="Buyers by revenue" rows={rankedBuyers} metric="revenue" />
                ) : (
                  <div className="loop-empty">
                    <p className="loop-empty__title">No buyers yet</p>
                    <p className="loop-empty__body">Buyers will appear here once demand is recorded.</p>
                  </div>
                )}
              </div>
            </div>

            <div className="loop-card">
              <div className="loop-card__head">
                <p className="loop-card__title">Buyer detail preview</p>
              </div>
              {topBuyer ? (
                <div className="loop-market__bars">
                  <Bar label={"Buyer " + (topBuyer.label || topBuyer.key || "Unknown")} value={money(topBuyer.revenueCents || 0)} pct={100} tone="good" />
                  <Bar label="Orders" value={num(topBuyer.orders || 0)} pct={Math.min(100, topBuyer.orders || 0)} tone="idle" />
                  <div className="loop-empty">
                    <p className="loop-empty__title">Accepted / rejected, campaigns, sources and vendors</p>
                    <p className="loop-empty__body">Per-buyer acceptance, capacity and attribution breakdowns are not exposed by the current data.</p>
                  </div>
                </div>
              ) : (
                <div className="loop-empty">
                  <p className="loop-empty__title">No lead buyer yet</p>
                  <p className="loop-empty__body">The most active buyer will surface here once revenue is recorded.</p>
                </div>
              )}
            </div>

            <div className="loop-card loop-market">
              <div className="loop-card__head">
                <p className="loop-card__title">Related dimensions</p>
              </div>
              <div className="loop-market__body">
                {campaignRows.length > 0 ? (
                  <RankedList icon="chart" title="Top campaigns" rows={campaignRows} metric="revenue" />
                ) : null}
                {sourceRows.length > 0 ? (
                  <RankedList icon="activity" title="Top sources" rows={sourceRows} metric="revenue" />
                ) : null}
                {vendorRows.length > 0 ? (
                  <RankedList icon="building" title="Top vendors" rows={vendorRows} metric="revenue" />
                ) : null}
                {campaignRows.length === 0 && sourceRows.length === 0 && vendorRows.length === 0 ? (
                  <div className="loop-empty">
                    <p className="loop-empty__title">No related dimensions yet</p>
                    <p className="loop-empty__body">Campaigns, sources and vendors appear once attribution is recorded.</p>
                  </div>
                ) : null}
              </div>
            </div>

            <div className="loop-card loop-feed">
              <div className="loop-card__head">
                <p className="loop-card__title">Buyer timeline</p>
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
                  <p className="loop-empty__title">No buyer activity available yet</p>
                  <p className="loop-empty__body">Recent buyer events will appear here as they are recorded.</p>
                </div>
              )}
            </div>

            <MarketplaceDecisionQueue
                items={decisions}
                reviewHref="/app/admin/marketplace/buyers"
                emptyBody="No buyer decisions are supported by the current data."
              />

            <div className="loop-card">
              <div className="loop-card__head">
                <p className="loop-card__title">Buyer briefing</p>
                <span className="loop-badge loop-badge--idle">Standby</span>
              </div>
              <div className="loop-brief">
                <BriefingItem icon="brain" title="Buyer briefing waiting for persisted Brain insights" />
              </div>
              <div className="loop-empty loop-empty--good">
                <p className="loop-empty__body">The Brain computes buyer intelligence on its own schedule. <Link className="loop-card__link" href="/app/admin/brain">Open Brain</Link></p>
              </div>
            </div>
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
                <Link className="loop-card__link" href="/app/admin/marketplace/campaigns">Campaign Intelligence</Link>
                <Link className="loop-card__link" href="/app/admin/marketplace/sources">Source / Publisher Operating System</Link>
                <Link className="loop-card__link" href="/app/admin/marketplace/vendors">Vendor Operating System</Link>
              </div>
            </div>
          
          <ContextGroup
            title="Related"
            caption="How buyers connect across your marketplace."
            links={[
              {
                icon: "chart",
                title: "Campaigns",
                detail: "See the campaigns feeding these buyers.",
                href: "/app/admin/marketplace/campaigns",
              },
              {
                icon: "flow",
                title: "Sources",
                detail: "Trace the sources routed to these buyers.",
                href: "/app/admin/marketplace/sources",
              },
              {
                icon: "building",
                title: "Vendors",
                detail: "Review vendors supplying these buyers.",
                href: "/app/admin/marketplace/vendors",
              },
              {
                icon: "brain",
                title: "Brain",
                detail: "See recommendations that reference buyers.",
                href: "/app/admin/brain",
              },
              {
                icon: "activity",
                title: "Activity",
                detail: "Follow the live event stream for buyers.",
                href: "/app/admin/marketplace/activity",
              },
            ]}
          />
        </aside>
        </section>
      </main>
    </div>
  );
}
