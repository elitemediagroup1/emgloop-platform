// Source / Publisher Operating System workspace (read-only). Composes existing repositories via the Loop OS design system; no backend/API/DB/schema/Brain/CallGrid changes.
import Link from "next/link";
import { MarketplaceNav } from "../_MarketplaceNav";
import { MarketplaceDecisionQueue } from "../_MarketplaceDecisionQueue";
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
  BriefingItem,
  IntegrationPill,
} from "../../../_loop-os";

export const dynamic = "force-dynamic";

type Pill = { name: string; state: "connected" | "needs" | "error" };

export default async function SourceOperatingSystemPage() {
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

  // Source rows from traffic intelligence expose { vendor, source, campaign, calls, bookings, revenueCents }.
  // We aggregate these existing values by source name only (simple grouping, no new metrics).
  type SrcAgg = { source: string; calls: number; bookings: number; revenueCents: number };
  const trafficSources: any[] = traffic && Array.isArray(traffic.sources) ? traffic.sources : [];
  const sourceMap = new Map<string, SrcAgg>();
  for (const row of trafficSources) {
    const key = String(row.source || "Unattributed");
    const existing = sourceMap.get(key) || { source: key, calls: 0, bookings: 0, revenueCents: 0 };
    existing.calls += Number(row.calls || 0);
    existing.bookings += Number(row.bookings || 0);
    existing.revenueCents += Number(row.revenueCents || 0);
    sourceMap.set(key, existing);
  }
  const aggregatedSources = Array.from(sourceMap.values()).sort((a, b) => b.calls - a.calls);
  const totalSources = aggregatedSources.length;
  const activeSources = aggregatedSources.filter((s) => s.calls > 0).length;
  const hasSourceData = totalSources > 0;

  // Revenue-ranked sources from revenueByDimension (Ranked: key, label, revenueCents, orders).
  const bySource: Ranked[] = rev && Array.isArray(rev.bySource) ? rev.bySource : [];
  const revenueRankedSources: Ranked[] = bySource.slice(0, 8);
  const hasRevenueBySource = bySource.length > 0;

  // Volume-ranked source list built only from real aggregated values.
  const volumeRankedSources: Ranked[] = aggregatedSources.slice(0, 8).map((s) => ({
    label: s.source,
    revenueCents: s.revenueCents,
    orders: s.bookings,
  }));

  // Org-wide traffic aggregates (existing values, not per-source).
  const totalCalls = traffic ? Number(traffic.totalCalls || 0) : 0;
  const attributedCalls = traffic ? Number(traffic.attributedCalls || 0) : 0;
  const unattributedCalls = traffic ? Number(traffic.unattributedCalls || 0) : 0;
  const qualifiedCalls = traffic ? Number(traffic.qualifiedCalls || 0) : 0;
  const bookings = traffic ? Number(traffic.bookings || 0) : 0;
  const attributionPct =
    totalCalls > 0 ? Math.round((attributedCalls / totalCalls) * 100) : 0;
  const totalSourceRevenueCents = aggregatedSources.reduce((sum, s) => sum + s.revenueCents, 0);

  // Top source = most active by call volume (existing data only).
  const topSource: SrcAgg | null = aggregatedSources.length > 0 ? aggregatedSources[0]! : null;

  // Executive summary sentence, honest and never fabricated.
  let summary: string;
  if (!org || (!hasSourceData && !hasRevenueBySource)) {
    summary = "Source performance data is not available yet.";
  } else if (activeSources === 0) {
    summary = "No sources are currently delivering measurable volume.";
  } else if (activeSources === 1) {
    summary = "One source is currently delivering volume.";
  } else {
    summary = num(activeSources) + " sources are currently delivering volume.";
  }

  // Decision queue derived ONLY from facts already present in the data.
  type Decision = { icon: string; tone: Tone; title: string; detail: string };
  const decisions: Decision[] = [];
  if (hasSourceData) {
    const idle = aggregatedSources.filter((s) => s.calls === 0);
    if (idle.length > 0) {
      decisions.push({
        icon: "activity",
        tone: "idle",
        title: num(idle.length) + " sources have no recent calls",
        detail: "These sources are not delivering volume right now.",
      });
    }
    if (unattributedCalls > 0) {
      decisions.push({
        icon: "search",
        tone: "warn",
        title: num(unattributedCalls) + " calls missing attribution",
        detail: "Calls without a known source are waiting to be attributed.",
      });
    }
    if (topSource && aggregatedSources.length > 1) {
      decisions.push({
        icon: "chart",
        tone: "good",
        title: topSource.source + " is leading on volume",
        detail: num(topSource.calls) + " calls delivered.",
      });
    }
  }

  return (
    <div className="loop-os loop-os--v3 loop-os--v4 loop-os--v5">
      <main className="loop-os__main">
        <header className="loop-os__brief">
          <div className="loop-os__brief-main">
            <p className="loop-os__brief-lead">Source / Publisher</p>
            <p className="loop-os__brief-body">{summary}</p>
          </div>
          <div className="loop-os__brief-cta">
            <span className="loop-os__brief-chip loop-os__brief-chiptoday">Today</span>
            <span className="loop-os__brief-chip loop-os__brief-chipdate">{todayLabel()}</span>
          </div>
        </header>

        <MarketplaceNav active="sources" />

        <section className="loop-modgrid">
          <Module icon="columns" title="Total Sources" metric={hasSourceData ? num(totalSources) : "0"} detail="Publishers with delivery data" tone="good" href="/app/admin/marketplace/sources" seed={11} />
          <Module icon="activity" title="Active Sources" metric={hasSourceData ? num(activeSources) : "0"} detail="Delivering volume now" tone="good" href="/app/admin/marketplace/sources" seed={22} />
          <Module icon="chat" title="Calls" metric={num(totalCalls)} detail={num(attributedCalls) + " attributed"} tone="good" href="/app/admin/marketplace/sources" seed={33} />
          <Module icon="star" title="Qualified" metric={num(qualifiedCalls)} detail="Qualified calls (marketplace-wide)" tone="good" href="/app/admin/marketplace/sources" seed={44} />
          <Module icon="revenue" title="Revenue" metric={money(totalSourceRevenueCents)} detail="Attributed to sources" tone="good" href="/app/admin/marketplace/sources" seed={55} />
          <Module icon="chart" title="Attribution" metric={attributionPct + "%"} unit="confidence" detail={num(unattributedCalls) + " calls unattributed"} tone={unattributedCalls > 0 ? "warn" : "good"} href="/app/admin/marketplace/sources" seed={66} />
        </section>

        <div className="loop-grid">
          <div className="loop-grid__content">
            <div className="loop-card loop-market">
              <div className="loop-card__head">
                <span className="loop-card__title">Source Directory</span>
                <Link className="loop-card__link" href="/app/admin/marketplace/sources">Marketplace overview</Link>
              </div>
              <div className="loop-market__body">
                {hasSourceData ? (
                  <RankedList icon="columns" title="Sources by volume" rows={volumeRankedSources} metric="orders" />
                ) : (
                  <div className="loop-empty">
                    <p className="loop-empty__title">No source delivery yet</p>
                    <p className="loop-empty__body">Source volume will appear here once traffic is attributed.</p>
                  </div>
                )}
              </div>
            </div>

            <div className="loop-card">
              <div className="loop-card__head">
                <span className="loop-card__title">Top Source</span>
              </div>
              <div className="loop-market__body">
                {topSource ? (
                  <div className="loop-market__bars">
                    <Bar label={topSource.source + " calls"} value={num(topSource.calls)} pct={totalCalls > 0 ? Math.round((topSource.calls / totalCalls) * 100) : 0} tone="good" />
                    <Bar label="Revenue" value={money(topSource.revenueCents)} pct={totalSourceRevenueCents > 0 ? Math.round((topSource.revenueCents / totalSourceRevenueCents) * 100) : 0} tone="good" />
                    <Bar label="Orders" value={num(topSource.bookings)} pct={bookings > 0 ? Math.round((topSource.bookings / bookings) * 100) : 0} tone="good" />
                  </div>
                ) : (
                  <div className="loop-empty">
                    <p className="loop-empty__title">No leading source yet</p>
                    <p className="loop-empty__body">The most active source will be highlighted here.</p>
                  </div>
                )}
              </div>
            </div>

            <div className="loop-card loop-market">
              <div className="loop-card__head">
                <span className="loop-card__title">Revenue by Source</span>
              </div>
              <div className="loop-market__body">
                {hasRevenueBySource ? (
                  <RankedList icon="revenue" title="Sources by revenue" rows={revenueRankedSources} metric="revenue" />
                ) : (
                  <div className="loop-empty">
                    <p className="loop-empty__title">No source revenue yet</p>
                    <p className="loop-empty__body">Revenue attributed to sources will appear here.</p>
                  </div>
                )}
              </div>
            </div>

            <div className="loop-card">
              <div className="loop-card__head">
                <span className="loop-card__title">Source Quality &amp; Fulfillment</span>
              </div>
              <div className="loop-market__body">
                <div className="loop-empty loop-empty--good">
                  <p className="loop-empty__title">Per-source quality not available</p>
                  <p className="loop-empty__body">The marketplace exposes {num(qualifiedCalls)} qualified calls and {num(bookings)} bookings overall, but per-source quality and fulfillment rates are not yet broken out by the current data. This section will populate once source-level quality is persisted.</p>
                </div>
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
                  <p className="loop-empty__title">No source activity yet</p>
                  <p className="loop-empty__body">Source-related activity will appear here as it is recorded.</p>
                </div>
              )}
            </div>

            <MarketplaceDecisionQueue
                items={decisions}
                reviewHref="/app/admin/marketplace/sources"
                emptyBody="No source issues are surfaced by the current data."
              />

            <div className="loop-card">
              <div className="loop-card__head">
                <span className="loop-card__title">Brain</span>
                <span className="loop-badge loop-badge--idle">Standby</span>
              </div>
              <div className="loop-brief">
                <BriefingItem icon="brain" title="Source briefing waiting for persisted Brain insights" />
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
            <Link className="loop-card__link" href="/app/admin/marketplace/vendors">Vendor Operating System</Link>
          </div>
        </div>
      </aside>
    </div>
  );
}
