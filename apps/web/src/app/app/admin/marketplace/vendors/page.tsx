// Vendor Operating System workspace (read-only). Composes existing repositories via the Loop OS design system; no backend/API/DB/schema/Brain/CallGrid changes.
import Link from "next/link";
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

export default async function VendorOperatingSystemPage() {
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

  const rev = revenueR.ok ? revenueR.data : null;
  const traffic = trafficR.ok ? trafficR.data : null;
  const liveCalls = liveCallsR.ok ? liveCallsR.data : [];
  const liveActivity = liveActivityR.ok ? liveActivityR.data : [];
  const cards = integrationsR.ok ? integrationsR.data : [];
  const health = computeSystemHealth(cards);

  // Integration pills derived exactly as the Loop OS overview does.
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

  // Vendor rows from traffic intelligence expose real per-vendor metrics:
  // { vendor, attributed, calls, qualified, qualifiedPct, bookings, revenueCents, marginCents, conversionPct }.
  const vendorRows: any[] = traffic && Array.isArray(traffic.vendors) ? traffic.vendors : [];
  const vendors = vendorRows.slice().sort((a, b) => Number(b.calls || 0) - Number(a.calls || 0));
  const totalVendors = vendors.length;
  const activeVendors = vendors.filter((v) => Number(v.calls || 0) > 0).length;
  const hasVendorData = totalVendors > 0;

  // Revenue-ranked vendors from revenueByDimension (Ranked: key, label, revenueCents, orders).
  const byVendor: Ranked[] = rev && Array.isArray(rev.byVendor) ? rev.byVendor : [];
  const revenueRankedVendors: Ranked[] = byVendor.slice(0, 8);
  const hasRevenueByVendor = byVendor.length > 0;

  // Volume-ranked vendor list built only from real values.
  const volumeRankedVendors: Ranked[] = vendors.slice(0, 8).map((v) => ({
    label: String(v.vendor || "Vendor"),
    revenueCents: Number(v.revenueCents || 0),
    orders: Number(v.bookings || 0),
  }));

  // Org-wide traffic aggregates (existing values).
  const totalCalls = traffic ? Number(traffic.totalCalls || 0) : 0;
  const attributedCalls = traffic ? Number(traffic.attributedCalls || 0) : 0;
  const unattributedCalls = traffic ? Number(traffic.unattributedCalls || 0) : 0;
  const bookings = traffic ? Number(traffic.bookings || 0) : 0;
  const attributionPct = totalCalls > 0 ? Math.round((attributedCalls / totalCalls) * 100) : 0;
  const totalVendorCalls = vendors.reduce((sum, v) => sum + Number(v.calls || 0), 0);
  const totalVendorRevenueCents = vendors.reduce((sum, v) => sum + Number(v.revenueCents || 0), 0);
  const totalVendorBookings = vendors.reduce((sum, v) => sum + Number(v.bookings || 0), 0);

  // Top vendor = most active by call volume (existing data only).
  const topVendor: any = vendors.length > 0 ? vendors[0]! : null;

  // Vendors with a low qualified rate, using existing qualifiedPct only.
  const lowQualityVendors = vendors.filter((v) => Number(v.calls || 0) > 0 && Number(v.qualifiedPct || 0) < 25);
  const idleVendors = vendors.filter((v) => Number(v.calls || 0) === 0);

  let summary: string;
  if (!org || (!hasVendorData && !hasRevenueByVendor)) {
    summary = "Vendor performance data is not available yet.";
  } else if (activeVendors === 0) {
    summary = "No vendors are currently delivering measurable volume.";
  } else if (lowQualityVendors.length === 1) {
    summary = "One vendor may need a quality review.";
  } else if (lowQualityVendors.length > 1) {
    summary = num(lowQualityVendors.length) + " vendors may need a quality review.";
  } else if (activeVendors === 1) {
    summary = "One vendor is currently delivering volume.";
  } else {
    summary = num(activeVendors) + " vendors are currently delivering volume.";
  }

  // Decision queue derived ONLY from facts already present in the data.
  type Decision = { icon: string; tone: Tone; title: string; detail: string };
  const decisions: Decision[] = [];
  if (hasVendorData) {
    if (lowQualityVendors.length > 0) {
      decisions.push({
        icon: "star",
        tone: "warn",
        title: num(lowQualityVendors.length) + " vendors under 25% qualified",
        detail: "These vendors are delivering calls with a low qualified rate.",
      });
    }
    if (idleVendors.length > 0) {
      decisions.push({
        icon: "activity",
        tone: "idle",
        title: num(idleVendors.length) + " vendors have no recent calls",
        detail: "These vendors are not delivering volume right now.",
      });
    }
    if (unattributedCalls > 0) {
      decisions.push({
        icon: "search",
        tone: "warn",
        title: num(unattributedCalls) + " calls missing attribution",
        detail: "Calls without a known vendor are waiting to be attributed.",
      });
    }
    if (topVendor && vendors.length > 1) {
      decisions.push({
        icon: "chart",
        tone: "good",
        title: String(topVendor.vendor) + " is leading on volume",
        detail: num(Number(topVendor.calls || 0)) + " calls delivered.",
      });
    }
  }

  return (
    <div className="loop-os loop-os--v3 loop-os--v4 loop-os--v5">
      <main className="loop-os__main">
        <header className="loop-os__brief">
          <div className="loop-os__brief-main">
            <p className="loop-os__brief-lead">Vendors</p>
            <p className="loop-os__brief-body">{summary}</p>
          </div>
          <div className="loop-os__brief-cta">
            <span className="loop-os__brief-chip loop-os__brief-chiptoday">Today</span>
            <span className="loop-os__brief-chip loop-os__brief-chipdate">{todayLabel()}</span>
          </div>
        </header>

        <MarketplaceNav active="vendors" />

        <PartialDataNotice coverage={[rev?.coverage, traffic?.coverage]} />

        <section className="loop-modgrid">
          <Module icon="columns" title="Total Vendors" metric={hasVendorData ? num(totalVendors) : "0"} detail="Traffic partners with data" tone="good" href="/app/admin/marketplace/vendors" seed={11} />
          <Module icon="activity" title="Active Vendors" metric={hasVendorData ? num(activeVendors) : "0"} detail="Delivering volume now" tone="good" href="/app/admin/marketplace/vendors" seed={22} />
          <Module icon="chat" title="Calls" metric={num(hasVendorData ? totalVendorCalls : totalCalls)} detail={num(attributedCalls) + " attributed"} tone="good" href="/app/admin/marketplace/vendors" seed={33} />
          <Module icon="revenue" title="Revenue" metric={money(totalVendorRevenueCents)} detail="Attributed to vendors" tone="good" href="/app/admin/marketplace/vendors" seed={44} />
          <Module icon="flow" title="Bookings" metric={num(hasVendorData ? totalVendorBookings : bookings)} unit="orders" detail="Vendor-driven bookings" tone="good" href="/app/admin/marketplace/vendors" seed={55} />
          <Module icon="chart" title="Attribution" metric={attributionPct + "%"} unit="confidence" detail={num(unattributedCalls) + " calls unattributed"} tone={unattributedCalls > 0 ? "warn" : "good"} href="/app/admin/marketplace/vendors" seed={66} />
        </section>

        <div className="loop-grid">
          <div className="loop-grid__content">
            <div className="loop-card loop-market">
              <div className="loop-card__head">
                <span className="loop-card__title">Vendor Directory</span>
                <Link className="loop-card__link" href="/app/admin/marketplace">Marketplace overview</Link>
              </div>
              <div className="loop-market__body">
                {hasVendorData ? (
                  <RankedList icon="columns" title="Vendors by volume" rows={volumeRankedVendors} metric="orders" />
                ) : (
                  <div className="loop-empty">
                    <p className="loop-empty__title">No vendor delivery yet</p>
                    <p className="loop-empty__body">Vendor volume will appear here once traffic is attributed.</p>
                  </div>
                )}
              </div>
            </div>

            <div className="loop-card">
              <div className="loop-card__head">
                <span className="loop-card__title">Top Vendor</span>
              </div>
              <div className="loop-market__body">
                {topVendor ? (
                  <div className="loop-market__bars">
                    <Bar label={String(topVendor.vendor) + " calls"} value={num(Number(topVendor.calls || 0))} pct={totalVendorCalls > 0 ? Math.round((Number(topVendor.calls || 0) / totalVendorCalls) * 100) : 0} tone="good" />
                    <Bar label="Revenue" value={money(Number(topVendor.revenueCents || 0))} pct={totalVendorRevenueCents > 0 ? Math.round((Number(topVendor.revenueCents || 0) / totalVendorRevenueCents) * 100) : 0} tone="good" />
                    <Bar label="Qualified" value={num(Number(topVendor.qualified || 0))} pct={Math.max(0, Math.min(100, Number(topVendor.qualifiedPct || 0)))} tone={Number(topVendor.qualifiedPct || 0) < 25 ? "warn" : "good"} />
                    <Bar label="Bookings" value={num(Number(topVendor.bookings || 0))} pct={totalVendorBookings > 0 ? Math.round((Number(topVendor.bookings || 0) / totalVendorBookings) * 100) : 0} tone="good" />
                  </div>
                ) : (
                  <div className="loop-empty">
                    <p className="loop-empty__title">No leading vendor yet</p>
                    <p className="loop-empty__body">The most active vendor will be highlighted here.</p>
                  </div>
                )}
              </div>
            </div>

            <div className="loop-card loop-market">
              <div className="loop-card__head">
                <span className="loop-card__title">Revenue by Vendor</span>
              </div>
              <div className="loop-market__body">
                {hasRevenueByVendor ? (
                  <RankedList icon="revenue" title="Vendors by revenue" rows={revenueRankedVendors} metric="revenue" />
                ) : (
                  <div className="loop-empty">
                    <p className="loop-empty__title">No vendor revenue yet</p>
                    <p className="loop-empty__body">Revenue attributed to vendors will appear here.</p>
                  </div>
                )}
              </div>
            </div>

            <div className="loop-card">
              <div className="loop-card__head">
                <span className="loop-card__title">Vendor Quality &amp; Fulfillment</span>
              </div>
              <div className="loop-market__body">
                {hasVendorData ? (
                  <div className="loop-market__bars">
                    {vendors.slice(0, 6).map((v, i) => (
                      <Bar key={i} label={String(v.vendor || "Vendor") + " qualified"} value={num(Number(v.qualifiedPct || 0)) + "%"} pct={Math.max(0, Math.min(100, Number(v.qualifiedPct || 0)))} tone={Number(v.qualifiedPct || 0) < 25 ? "warn" : "good"} />
                    ))}
                  </div>
                ) : (
                  <div className="loop-empty">
                    <p className="loop-empty__title">No vendor quality data yet</p>
                    <p className="loop-empty__body">Qualified rates per vendor will appear here once traffic is recorded.</p>
                  </div>
                )}
              </div>
            </div>

            <div className="loop-card loop-feed">
              <div className="loop-card__head">
                <span className="loop-card__title">Recent Activity</span>
              </div>
              {liveActivity.length > 0 ? (
                <ul className="loop-feed__list">
                  {liveActivity.slice(0, 8).map((a: any) => (
                    <li className="loop-feed__item" key={a.id}>
                      <span className="loop-feed__dot" />
                      <span className="loop-feed__label">{a.label}</span>
                      <span className="loop-feed__time">{relTime(a.at)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="loop-empty">
                  <p className="loop-empty__title">No vendor activity yet</p>
                  <p className="loop-empty__body">Vendor-related activity will appear here as it is recorded.</p>
                </div>
              )}
            </div>

            <MarketplaceDecisionQueue
                items={decisions}
                reviewHref="/app/admin/marketplace/vendors"
                emptyBody="No vendor issues are surfaced by the current data."
              />

            <div className="loop-card">
              <div className="loop-card__head">
                <span className="loop-card__title">Brain</span>
                <span className="loop-badge loop-badge--idle">Standby</span>
              </div>
              <div className="loop-brief">
                <BriefingItem icon="brain" title="Vendor briefing waiting for persisted Brain insights" />
              </div>
              <p className="loop-quiet">The Brain computes intelligence on its own schedule. Briefings appear here once persisted.</p>
              <Link className="loop-card__link" href="/app/admin/brain">Open Brain</Link>
            </div>
          </div>
        </div>
      </main>

      <aside className="loop-rail">
        <div className="loop-card loop-feed">
          <div className="loop-card__head">
            <span className="loop-card__title">Live Calls <span className="loop-count">{num(liveCalls.length)}</span></span>
          </div>
          {liveCalls.length > 0 ? (
            <ul className="loop-feed__list">
              {liveCalls.slice(0, 6).map((c: any) => (
                <li className="loop-feed__item" key={c.id}>
                  <span className="loop-feed__phone" />
                  <span className="loop-feed__label">{c.customerName || c.caller || "Caller"}</span>
                  <span className="loop-feed__time">{clockDuration(c.durationSeconds)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="loop-empty">
              <p className="loop-empty__title">No live calls</p>
              <p className="loop-empty__body">Active calls will appear here.</p>
            </div>
          )}
        </div>

        <div className="loop-card loop-intg">
          <div className="loop-card__head">
            <span className="loop-card__title">Integration Status</span>
          </div>
          <div className="loop-intg__summary">
            <span className="loop-intg__stat loop-intg__stat--connected">{num(health.connected)} Connected</span>
            <span className="loop-intg__stat loop-intg__stat--needs">{num(needsPills.length)} Needs Setup</span>
            <span className="loop-intg__stat loop-intg__stat--error">{num(errorPills.length)} Errors</span>
          </div>
          {orderedPills.length > 0 ? (
            <div className="loop-intg__grid">
              {orderedPills.map((pill, i) => (
                <IntegrationPill key={i} name={pill.name} state={pill.state} />
              ))}
            </div>
          ) : (
            <div className="loop-empty">
              <p className="loop-empty__title">No integrations</p>
              <p className="loop-empty__body">Connect providers to see status here.</p>
            </div>
          )}
        </div>

        <div className="loop-card">
          <div className="loop-card__head">
            <span className="loop-card__title">Shortcuts</span>
          </div>
          <div className="loop-brief">
            <Link className="loop-card__link" href="/app/admin/marketplace">Marketplace overview</Link>
            <Link className="loop-card__link" href="/app/admin/marketplace/campaigns">Campaign Intelligence</Link>
            <Link className="loop-card__link" href="/app/admin/marketplace/buyers">Buyer Operating System</Link>
            <Link className="loop-card__link" href="/app/admin/marketplace/sources">Source / Publisher Operating System</Link>
          </div>
        </div>
      
          <ContextGroup
            title="Related"
            caption="How vendors connect across your marketplace."
            links={[
              {
                icon: "chart",
                title: "Campaigns",
                detail: "See the campaigns these vendors deliver.",
                href: "/app/admin/marketplace/campaigns",
              },
              {
                icon: "users",
                title: "Buyers",
                detail: "See the buyers served by these vendors.",
                href: "/app/admin/marketplace/buyers",
              },
              {
                icon: "flow",
                title: "Sources",
                detail: "Trace the sources tied to these vendors.",
                href: "/app/admin/marketplace/sources",
              },
              {
                icon: "brain",
                title: "Brain",
                detail: "See recommendations that reference vendors.",
                href: "/app/admin/brain",
              },
              {
                icon: "activity",
                title: "Activity",
                detail: "Follow the live event stream for vendors.",
                href: "/app/admin/marketplace/activity",
              },
            ]}
          />
        </aside>
    </div>
  );
}
