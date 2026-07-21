import Link from "next/link";
import { SidebarIcon } from "../../../crm/_brand/SidebarIcon";
import { loadOrFallback } from "../../../../demo/db-health";
import { crmRepos, requireCrmContext } from "../../../../crm/crm-data";
import { loadProviderCards, computeSystemHealth } from "../../../../crm/integration-os";
import { num, todayLabel, clockDuration, greeting, IntegrationStatusPanel } from "../../_loop-os";
import { ExecutiveBrainView } from "../_executive/ExecutiveBrainView";
import { loadExecutiveBrain } from "../_executive/executive-brain-data";
import type { ExecutiveBrainReport } from "@emgloop/intelligence";

export const dynamic = "force-dynamic";

// CallGrid Intelligence — Overview.
//
// The single executive command center. It CONSUMES the Executive Brain and
// presents it; it computes nothing and fabricates nothing. Every observation,
// risk, opportunity and recommendation comes from the pure reasoning layer and
// already traces to a metric that cleared the Evidence Engine.
//
// Consolidation: this page was one of two surfaces (/app/admin/brain and
// /app/admin/marketplace) that rendered the SAME Executive Brain from the SAME
// path. It is now the ONE command center; /app/admin/brain redirects here. The
// six drill-downs (Buyers, Vendors, Sources, Campaigns, Activity, Auctions) are
// first-class sidebar items now, so the former in-page sub-nav is gone.
//
// Marketplace/CallGrid is one sensor today — the Evidence Coverage panel names
// the sensors that are not yet wired, so "one sensor among many" stays true on
// screen rather than implied.

// Business Health — a single honest headline derived from the Brain's own
// System Health band. Never authored: the band is computed upstream.
const HEALTH: Record<string, { label: string; tone: string; line: string }> = {
  healthy: { label: "Healthy", tone: "healthy", line: "Your marketplace is operating within normal bounds." },
  watch: { label: "Watch", tone: "degraded", line: "A few signals are worth a look, but nothing is urgent." },
  at_risk: { label: "At risk", tone: "impaired", line: "The Brain has surfaced something that needs a decision." },
};

function healthOf(report: ExecutiveBrainReport | null): { label: string; tone: string; line: string } {
  if (!report) {
    return { label: "Unmeasured", tone: "unmeasured", line: "Loop cannot reach the evidence it reasons over right now." };
  }
  return (
    HEALTH[report.systemHealth.band] ?? {
      label: "Unmeasured",
      tone: "unmeasured",
      line: "No sensor is instrumented yet, so there is nothing the Brain can trust to explain.",
    }
  );
}

// The drill-downs, promoted to first-class navigation. Kept here too as in-context
// shortcuts so the Overview always offers the next place to look.
const DRILLDOWNS: { href: string; icon: string; label: string; hint: string }[] = [
  { href: "/app/admin/marketplace/buyers", icon: "users", label: "Buyers", hint: "Demand, by revenue" },
  { href: "/app/admin/marketplace/vendors", icon: "building", label: "Vendors", hint: "Supply partners" },
  { href: "/app/admin/marketplace/sources", icon: "flow", label: "Sources", hint: "Publishers & traffic" },
  { href: "/app/admin/marketplace/campaigns", icon: "star", label: "Campaigns", hint: "What's driving calls" },
  { href: "/app/admin/marketplace/activity", icon: "activity", label: "Activity", hint: "The live event stream" },
  { href: "/app/admin/marketplace/auction", icon: "columns", label: "Auctions", hint: "Bid & win evidence" },
];

export default async function CallGridOverviewPage() {
  const { organizationId: org } = await requireCrmContext();

  const brainR = org
    ? await loadOrFallback(async () => loadExecutiveBrain(org))
    : ({ ok: false } as const);
  const liveCallsR = org
    ? await loadOrFallback(async () => crmRepos.liveOperations.listLiveCalls(org))
    : ({ ok: false } as const);
  const integrationsR = org
    ? await loadOrFallback(async () => loadProviderCards(org))
    : ({ ok: false } as const);

  const brainT = brainR.ok ? brainR.data.report : null;
  const report: ExecutiveBrainReport | null =
    brainT && brainT.state === "success" ? brainT.value : null;
  const liveCalls = liveCallsR.ok ? liveCallsR.data : [];
  const cards = integrationsR.ok ? integrationsR.data : [];
  const health = computeSystemHealth(cards);

  const band = healthOf(report);
  const takeaway =
    report && report.summary.length > 0
      ? report.summary[0]!.observation
      : band.line;

  return (
    <div className="loop-os loop-os--v3 loop-os--v4 loop-os--v5">
      <main className="loop-os__main">
        {/* Command-center lead: what am I looking at, and is everything okay? */}
        <header className="loop-os__brief">
          <div className="loop-os__brief-main">
            <p className="loop-os__brief-lead">CallGrid Intelligence</p>
            <p className="loop-os__brief-title">{greeting()}. Here is today&rsquo;s business health.</p>
            <p className="loop-os__brief-body">{takeaway}</p>
          </div>
          <div className="loop-os__brief-cta">
            <span className={"mkt-intel__health mkt-intel__health--" + band.tone}>{band.label}</span>
            <span className="loop-os__brief-chip loop-os__brief-chipdate">{todayLabel()}</span>
          </div>
        </header>

        <div className="loop-grid">
          <div className="loop-grid__content">
            {report ? (
              <ExecutiveBrainView report={report} />
            ) : (
              <div className="loop-card">
                <div className="loop-card__head">
                  <span className="loop-card__title">Executive Brain</span>
                </div>
                <div className="loop-empty">
                  <span className="loop-empty__icon">
                    <SidebarIcon name="brain" />
                  </span>
                  <p className="loop-empty__title">The Brain cannot reason right now.</p>
                  <p className="loop-empty__body">
                    Either no organization is resolved or the evidence read did not succeed. Loop is
                    showing you nothing rather than a briefing built on data it could not confirm.
                  </p>
                </div>
              </div>
            )}
          </div>

          <aside className="loop-rail">
            <div className="loop-card">
              <div className="loop-card__head">
                <span className="loop-card__title">Look closer</span>
              </div>
              <div className="loop-brief">
                {DRILLDOWNS.map((d) => (
                  <Link className="loop-brief__item" href={d.href} key={d.href}>
                    <span className="loop-brief__icon">
                      <SidebarIcon name={d.icon} />
                    </span>
                    <div className="loop-brief__text">
                      <div className="loop-brief__title">{d.label}</div>
                      <div className="loop-brief__wait">{d.hint}</div>
                    </div>
                  </Link>
                ))}
              </div>
            </div>

            <div className="loop-card loop-intg-panel">
              <IntegrationStatusPanel cards={cards} health={health} title="Evidence Sources" />
            </div>

            <div className="loop-card loop-feed">
              <div className="loop-card__head">
                <span className="loop-card__title">
                  Live Calls <span className="loop-count">{num(liveCalls.length)}</span>
                </span>
              </div>
              {liveCalls.length > 0 ? (
                <ul className="loop-feed__list">
                  {liveCalls.slice(0, 5).map((c: any) => (
                    <li className="loop-feed__item" key={c.id}>
                      <span className="loop-feed__phone" />
                      <span className="loop-feed__label">{c.customerName || c.caller}</span>
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
          </aside>
        </div>
      </main>
    </div>
  );
}
