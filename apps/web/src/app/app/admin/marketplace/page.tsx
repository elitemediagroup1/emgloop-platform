// Marketplace — the Executive Brain surface.
//
// This page no longer reports the marketplace; it EXPLAINS it. The metric tiles,
// the coverage list and the ranked findings that used to live here have been
// replaced by the Executive Brain view: Executive Summary, Top Risks, Top
// Opportunities, Recommended Actions, System Health, Evidence Coverage — every
// statement backed by evidence that cleared the Evidence Engine.
//
// Marketplace is one SENSOR feeding the Brain. The same view renders at
// /app/admin/brain over the same reasoning; this page scopes the entry point to
// the Marketplace workspace and keeps its nav and drill-down evidence pages
// (Activity, Sources, Auction, …) exactly where they were.
//
// The zero-vs-unknown rule still holds: `loadExecutiveBrain` returns an ERROR
// Truth for a failed read, so a database outage renders a banner, never a
// healthy-looking empty briefing.

import Link from "next/link";
import { MarketplaceNav } from "./_MarketplaceNav";
import { ExecutiveBrainView } from "../_executive/ExecutiveBrainView";
import { loadExecutiveBrain } from "../_executive/executive-brain-data";
import { SidebarIcon } from "../../../crm/_brand/SidebarIcon";
import { requireCrmContext } from "../../../../crm/crm-data";
import { todayLabel } from "../../_loop-os";
import { hasValue, foldTruth, failed, type Truth, type TruthMeta } from "@emgloop/shared";
import type { ExecutiveBrainReport } from "@emgloop/intelligence";

export const dynamic = "force-dynamic";

export default async function MarketplaceCommandCenter() {
  const { organizationId: org } = await requireCrmContext();
  const now = new Date();
  const meta: TruthMeta = { measuredAt: now.toISOString() };

  const noOrgError = {
    code: "repository-exception" as const,
    summary: "No organization is resolved for this session.",
    retryable: false,
  };

  const result = org
    ? await loadExecutiveBrain(org, now)
    : { report: failed<ExecutiveBrainReport>(noOrgError, meta) };
  const brain: Truth<ExecutiveBrainReport> = result.report;

  const lead = hasValue(brain)
    ? brain.value.evidenceCoverage.instrumentedSensors === 0
      ? "No sensor is instrumented yet, so the Brain has nothing it can trust to explain."
      : `${brain.value.summary.length} observation(s) explained from ${brain.value.evidenceCoverage.instrumentedSensors} instrumented sensor(s).`
    : "Loop cannot currently reach the evidence it reasons over.";

  return (
    <div className="loop-os loop-os--v3 loop-os--v4 loop-os--v5">
      <div className="loop-os__main">
        <header className="loop-os__brief">
          <div className="loop-os__brief-main">
            <p className="loop-os__brief-lead">Marketplace</p>
            <h1 className="loop-os__brief-title">Executive Brain</h1>
            <p className="loop-os__brief-body">{lead}</p>
            <Link href="/app/admin" className="loop-os__brief-cta">
              Back to Overview <span aria-hidden="true">{"→"}</span>
            </Link>
          </div>
          <div className="loop-os__brief-chip">
            <SidebarIcon name="calendar" />
            <span className="loop-os__brief-chiptoday">Today</span>
            <span className="loop-os__brief-chipdate">{todayLabel()}</span>
          </div>
        </header>

        <MarketplaceNav active="overview" />

        {hasValue(brain) ? (
          <ExecutiveBrainView report={brain.value} />
        ) : (
          <section className="loop-banner loop-banner--crit" role="alert">
            <span className="loop-banner__glyph">
              <SidebarIcon name="plug" />
            </span>
            <div className="loop-banner__text">
              <div className="loop-banner__title">The Brain cannot reason right now</div>
              <div className="loop-banner__body">
                {foldTruth(brain, {
                  success: () => "",
                  empty: () => "",
                  partial: () => "",
                  unknown: (r) => r.summary,
                  unavailable: (r) => r.summary,
                  error: (e) => `${e.summary}${e.detail ? ` ${e.detail}` : ""}`,
                })}{" "}
                Until this read succeeds, Loop is showing you nothing rather than a briefing built on
                data it could not confirm.
              </div>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
