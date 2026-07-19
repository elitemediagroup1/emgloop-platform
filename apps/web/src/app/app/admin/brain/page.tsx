import Link from "next/link";
import { SidebarIcon } from "../../../crm/_brand/SidebarIcon";
import { loadOrFallback } from "../../../../demo/db-health";
import { crmRepos, requireCrmContext } from "../../../../crm/crm-data";
import { loadProviderCards, computeSystemHealth } from "../../../../crm/integration-os";
import { num, todayLabel, clockDuration, IntegrationStatusPanel } from "../../_loop-os";
import { ExecutiveBrainView } from "../_executive/ExecutiveBrainView";
import { loadExecutiveBrain } from "../_executive/executive-brain-data";
import type { ExecutiveBrainReport } from "@emgloop/intelligence";

export const dynamic = "force-dynamic";

// Executive Brain — the platform's executive reasoning surface.
//
// This page CONSUMES the Executive Brain and presents it. It computes nothing and
// fabricates nothing: every observation, risk, opportunity and recommendation
// comes from the pure reasoning layer, and each already traces to a metric that
// cleared the Evidence Engine. It replaces the old CallGrid-module briefing,
// whose confidence the module asserted about itself; confidence here is DERIVED.
//
// Marketplace is one sensor today. The Evidence Coverage panel names the sensors
// that are not yet wired — the same view renders inside the Marketplace
// workspace, scoped to that entry point.

export default async function ExecutiveBrainPage() {
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

  const takeaway =
    report && report.summary.length > 0
      ? report.summary[0]!.observation
      : "The Brain is waiting for an instrumented sensor to explain.";

  return (
    <div className="loop-os loop-os--v3 loop-os--v4 loop-os--v5">
      <main className="loop-os__main">
        <header className="loop-os__brief">
          <div className="loop-os__brief-main">
            <p className="loop-os__brief-lead">Executive Brain</p>
            <p className="loop-os__brief-body">{takeaway}</p>
          </div>
          <div className="loop-os__brief-cta">
            <span className="loop-os__brief-chip loop-os__brief-chiptoday">
              {report
                ? `${report.evidenceCoverage.instrumentedSensors} of ${report.evidenceCoverage.totalSensors} sensors instrumented`
                : "No reasoning yet"}
            </span>
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
                <span className="loop-card__title">Jump to</span>
              </div>
              <div className="loop-brief">
                <Link className="loop-brief__item" href="/app/admin/marketplace">
                  <span className="loop-brief__icon">
                    <SidebarIcon name="grid" />
                  </span>
                  <div className="loop-brief__text">
                    <div className="loop-brief__title">Marketplace</div>
                    <div className="loop-brief__wait">The sensor the Brain explains.</div>
                  </div>
                </Link>
                <Link className="loop-brief__item" href="/app/admin/work">
                  <span className="loop-brief__icon">
                    <SidebarIcon name="flow" />
                  </span>
                  <div className="loop-brief__text">
                    <div className="loop-brief__title">My Work</div>
                    <div className="loop-brief__wait">Act on what the briefing surfaces.</div>
                  </div>
                </Link>
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
