import { SidebarIcon } from "../../../crm/_brand/SidebarIcon";
import { loadOrFallback } from "../../../../demo/db-health";
import { crmRepos, requireCrmContext } from "../../../../crm/crm-data";
import { requireWorkspacePermission } from "../../../../workspaces/guard";
import { loadProviderCards, computeSystemHealth } from "../../../../crm/integration-os";
import { num, todayLabel, clockDuration, greeting, IntegrationStatusPanel } from "../../_loop-os";
import { ExecutiveBrainView } from "../_executive/ExecutiveBrainView";
import { loadExecutiveBrain } from "../_executive/executive-brain-data";
import type { ExecutiveBrainReport } from "@emgloop/intelligence";

export const dynamic = "force-dynamic";

// Brain — the executive reasoning surface.
//
// Ownership split: the Executive Brain (Executive Summary, System Health,
// Cross-Sensor Insights/Patterns, Top Risks, Top Opportunities, Recommended
// Actions, Evidence Coverage, Confidence, What Changed, Executive Narrative,
// Missing Sensors) and the Evidence Sources / Platform Health rail were MOVED
// here from CallGrid Intelligence WITHOUT modification. Every component now has
// exactly one owner: reasoning lives on Brain; CallGrid Intelligence keeps only
// its operational scorecard + drill-downs. This page consumes the pure Executive
// Brain and presents it; it computes nothing and fabricates nothing.

const HEALTH: Record<string, { label: string; tone: string; line: string }> = {
  healthy: { label: "Healthy", tone: "healthy", line: "Your business is operating within normal bounds." },
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

export default async function BrainPage() {
  // Preserve the original /app/admin/brain authorization semantics.
  await requireWorkspacePermission("ADMIN", "intelligence", "view");
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
        <header className="loop-os__brief">
          <div className="loop-os__brief-main">
            <p className="loop-os__brief-lead">Brain</p>
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
