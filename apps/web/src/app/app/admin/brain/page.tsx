import Link from "next/link";
import { SidebarIcon } from "../../../crm/_brand/SidebarIcon";
import { loadOrFallback } from "../../../../demo/db-health";
import { crmRepos, requireCrmContext } from "../../../../crm/crm-data";
import { loadProviderCards, computeSystemHealth } from "../../../../crm/integration-os";
import { money, num, todayLabel, clockDuration, IntegrationStatusPanel } from "../../_loop-os";
import { loadExecutiveBriefing } from "./brain-data";
import type {
  ExecutiveBriefing,
  IntelligenceChange,
  OptimizationAction,
} from "@emgloop/intelligence";
import type { RecommendationEnvelope } from "@emgloop/brain";

export const dynamic = "force-dynamic";

// INTELLIGENCE MODULE 1 — CallGrid Executive Intelligence.
//
// This page is the Executive Briefing: it CONSUMES an intelligence module's
// output and presents it. It computes nothing and fabricates nothing — every
// number, sentence, opportunity and risk comes from the pure module. Revenue is
// the ONLY headline KPI (mission rule); everything else is explanation. Every
// section that lacks evidence renders an honest "Not enough data", never "0".

// Confidence that was never computed is unknown, not 0%. Rendering "0%
// confidence" reads as "the Brain is certain this is worthless", which is a
// different and much stronger claim than "the Brain did not score this".
// The header above promises this page never shows a fabricated 0; this is where
// that promise was being broken.
function confPct(c: number | undefined): string {
  return c === undefined ? "unscored" : `${Math.round(c * 100)}%`;
}

function changeArrow(d: IntelligenceChange["direction"]): string {
  return d === "up" ? "▲" : d === "down" ? "▼" : "→";
}

function changeValue(c: IntelligenceChange): string {
  if (c.unit === "usd_cents") return money(c.current);
  if (c.unit === "count") return num(c.current);
  if (c.unit === "ratio") return `${Math.round(c.current * 100)}%`;
  return String(c.current);
}

const OPT_LABEL: Record<OptimizationAction["kind"], string> = {
  increase: "Increase",
  decrease: "Decrease",
  pause: "Pause",
  negotiate: "Negotiate",
  scale: "Scale",
  reallocate: "Reallocate",
};

function RecommendationRow({ r }: { r: RecommendationEnvelope }) {
  return (
    <li className="loop-rec">
      <div className="loop-rec__head">
        <span className="loop-rec__title">{r.recommendation}</span>
        <span className="loop-rec__conf">{confPct(r.trust.confidence)} confidence</span>
      </div>
      <p className="loop-rec__reason">{r.reason}</p>
      <div className="loop-rec__foot">
        <span className="loop-rec__impact">
          <span className="loop-rec__k">Expected</span> {r.expectedOutcome.statement}
        </span>
        {r.risk.costOfInaction ? (
          <span className="loop-rec__impact">
            <span className="loop-rec__k">If ignored</span> {r.risk.costOfInaction}
          </span>
        ) : null}
      </div>
    </li>
  );
}

function Empty({ icon, title, body }: { icon: string; title: string; body: string }) {
  return (
    <div className="loop-empty">
      <span className="loop-empty__icon"><SidebarIcon name={icon} /></span>
      <p className="loop-empty__title">{title}</p>
      <p className="loop-empty__body">{body}</p>
    </div>
  );
}

export default async function ExecutiveBriefingPage() {
  const { organizationId: org } = await requireCrmContext();

  const briefingR = org
    ? await loadOrFallback(async () => loadExecutiveBriefing(org))
    : ({ ok: false } as const);
  const liveCallsR = org
    ? await loadOrFallback(async () => crmRepos.liveOperations.listLiveCalls(org))
    : ({ ok: false } as const);
  const integrationsR = org
    ? await loadOrFallback(async () => loadProviderCards(org))
    : ({ ok: false } as const);

  const briefing: ExecutiveBriefing | null = briefingR.ok ? briefingR.data.briefing : null;
  const liveCalls = liveCallsR.ok ? liveCallsR.data : [];
  const cards = integrationsR.ok ? integrationsR.data : [];
  const health = computeSystemHealth(cards);

  const rev = briefing?.revenue ?? null;
  const primaryModule = briefing?.modules[0];
  const takeaway = briefing?.narrative[0] ?? "The Brain is waiting for CallGrid data to brief on.";
  const revDeltaTone =
    rev?.direction === "up" ? "loop-delta--up" : rev?.direction === "down" ? "loop-delta--down" : "loop-delta--flat";

  return (
    <div className="loop-os loop-os--v3 loop-os--v4 loop-os--v5">
      <main className="loop-os__main">
        <header className="loop-os__brief">
          <div className="loop-os__brief-main">
            <p className="loop-os__brief-lead">Executive Briefing</p>
            <p className="loop-os__brief-body">{takeaway}</p>
          </div>
          <div className="loop-os__brief-cta">
            <span className="loop-os__brief-chip loop-os__brief-chiptoday">
              {primaryModule ? `${primaryModule.label} · ${confPct(primaryModule.confidence)} confidence` : "CallGrid"}
            </span>
            <span className="loop-os__brief-chip loop-os__brief-chipdate">{todayLabel()}</span>
          </div>
        </header>

        {/* THE ONLY KPI: Revenue. Everything below is explanation. */}
        <section className="loop-kpi">
          <div className="loop-kpi__label">
            <SidebarIcon name="revenue" /> Revenue · {briefing?.window.label ?? "Last 7 days"}
          </div>
          <div className="loop-kpi__value">
            {rev && rev.currentCents !== null ? money(rev.currentCents) : "Not measured"}
          </div>
          {rev && rev.currentCents !== null && rev.changePercent !== null ? (
            <div className={`loop-delta ${revDeltaTone}`}>
              {changeArrow(rev.direction)} {Math.abs(Math.round(rev.changePercent))}% vs prior window
            </div>
          ) : (
            <div className="loop-kpi__note">
              {rev && rev.currentCents === null
                ? "No per-call revenue was attributed in this window."
                : "No prior window to compare against yet."}
            </div>
          )}
        </section>

        <div className="loop-grid">
          <div className="loop-grid__content">
            {/* Executive Summary */}
            <div className="loop-card">
              <div className="loop-card__head">
                <span className="loop-card__title">Executive Summary</span>
                {primaryModule ? (
                  <span className="loop-badge loop-badge--live">CallGrid</span>
                ) : null}
              </div>
              {briefing && briefing.narrative.length > 0 ? (
                <div className="loop-summary">
                  {briefing.narrative.map((s, i) => (
                    <p className="loop-summary__line" key={i}>{s}</p>
                  ))}
                </div>
              ) : (
                <Empty
                  icon="brain"
                  title="No briefing yet."
                  body="Once CallGrid calls flow through the integration, the Brain summarizes what changed, why, and what to do next."
                />
              )}
            </div>

            {/* What Changed */}
            <div className="loop-card">
              <div className="loop-card__head">
                <span className="loop-card__title">What Changed</span>
              </div>
              {briefing && briefing.whatChanged.length > 0 ? (
                <ul className="loop-changes">
                  {briefing.whatChanged.slice(0, 8).map((c, i) => (
                    <li className={`loop-change loop-change--${c.direction}`} key={i}>
                      <span className="loop-change__arrow">{changeArrow(c.direction)}</span>
                      <span className="loop-change__label">{c.label}</span>
                      <span className="loop-change__pct">
                        {c.changePercent !== undefined
                          ? `${c.changePercent >= 0 ? "+" : ""}${Math.round(c.changePercent)}%`
                          : "new"}
                      </span>
                      <span className="loop-change__val">{changeValue(c)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty
                  icon="activity"
                  title="Not enough data to show change."
                  body="A prior comparison window is needed to state what changed. It appears once two periods of CallGrid data exist."
                />
              )}
            </div>

            {/* Risks */}
            <div className="loop-card">
              <div className="loop-card__head">
                <span className="loop-card__title">Top Risks</span>
                {briefing && briefing.risks.length > 0 ? (
                  <span className="loop-badge loop-badge--warn">{briefing.risks.length}</span>
                ) : null}
              </div>
              {briefing && briefing.risks.length > 0 ? (
                <ul className="loop-recs">
                  {briefing.risks.map((r, i) => <RecommendationRow r={r} key={i} />)}
                </ul>
              ) : (
                <Empty
                  icon="bell"
                  title="No material risk surfaced."
                  body="Margin, acceptance and buyer quality are within normal bounds for the data available. Risks appear here severity-first, with the evidence behind them."
                />
              )}
            </div>

            {/* Opportunities */}
            <div className="loop-card">
              <div className="loop-card__head">
                <span className="loop-card__title">Top Opportunities</span>
                {briefing && briefing.opportunities.length > 0 ? (
                  <span className="loop-badge loop-badge--good">{briefing.opportunities.length}</span>
                ) : null}
              </div>
              {briefing && briefing.opportunities.length > 0 ? (
                <ul className="loop-recs">
                  {briefing.opportunities.map((r, i) => <RecommendationRow r={r} key={i} />)}
                </ul>
              ) : (
                <Empty
                  icon="revenue"
                  title="No scalable upside identified yet."
                  body="When a source or buyer shows high quality and healthy margin worth more allocation, it appears here with the numbers behind it."
                />
              )}
            </div>

            {/* Optimization */}
            <div className="loop-card">
              <div className="loop-card__head">
                <span className="loop-card__title">Optimization</span>
              </div>
              {briefing && briefing.optimizations.length > 0 ? (
                <ul className="loop-opts">
                  {briefing.optimizations.map((o, i) => (
                    <li className="loop-opt" key={i}>
                      <span className={`loop-opt__kind loop-opt__kind--${o.kind}`}>{OPT_LABEL[o.kind]}</span>
                      <div className="loop-opt__body">
                        <span className="loop-opt__target">{o.targetLabel}</span>
                        <span className="loop-opt__reason">{o.reason}</span>
                        <span className="loop-opt__impact">{o.expectedImpact}</span>
                      </div>
                      <span className="loop-opt__conf">{confPct(o.confidence)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty
                  icon="flow"
                  title="Nothing to tune right now."
                  body="Bids to raise or lower, sources to pause, buyers to renegotiate — concrete lever changes appear here once the data supports one."
                />
              )}
            </div>

            {/* Predictive */}
            <div className="loop-card">
              <div className="loop-card__head">
                <span className="loop-card__title">Predictive</span>
                <span className="loop-badge loop-badge--idle">Directional</span>
              </div>
              {briefing && briefing.moduleOutputs[0]?.predictiveIntelligence.projections.length ? (
                <ul className="loop-preds">
                  {briefing.moduleOutputs[0].predictiveIntelligence.projections.map((p, i) => (
                    <li className="loop-pred" key={i}>
                      <p className="loop-pred__stmt">{p.statement}</p>
                      <p className="loop-pred__basis">{p.basis} · {confPct(p.confidence)} confidence</p>
                    </li>
                  ))}
                  {briefing.moduleOutputs[0].predictiveIntelligence.notEnoughDataReason ? (
                    <li className="loop-pred loop-pred--note">
                      {briefing.moduleOutputs[0].predictiveIntelligence.notEnoughDataReason}
                    </li>
                  ) : null}
                </ul>
              ) : (
                <Empty
                  icon="brain"
                  title="Not enough data to project."
                  body={
                    briefing?.moduleOutputs[0]?.predictiveIntelligence.notEnoughDataReason ??
                    "A prior window is needed before the Brain will project a trend — it refuses to guess from a single period."
                  }
                />
              )}
            </div>

            {/* Market + Transcript, side by side on wide screens */}
            <div className="loop-card">
              <div className="loop-card__head">
                <span className="loop-card__title">Market Intelligence</span>
              </div>
              {briefing && briefing.moduleOutputs[0]?.marketIntelligence.observations.length ? (
                <ul className="loop-obs">
                  {briefing.moduleOutputs[0].marketIntelligence.observations.map((o, i) => (
                    <li className="loop-obs__item" key={i}>
                      <span className="loop-obs__label">{o.label}</span>
                      <span className="loop-obs__detail">{o.detail}</span>
                    </li>
                  ))}
                  {briefing.moduleOutputs[0].marketIntelligence.notEnoughDataReason ? (
                    <li className="loop-obs__note">{briefing.moduleOutputs[0].marketIntelligence.notEnoughDataReason}</li>
                  ) : null}
                </ul>
              ) : (
                <Empty
                  icon="chart"
                  title="Not enough data on market dynamics."
                  body={
                    briefing?.moduleOutputs[0]?.marketIntelligence.notEnoughDataReason ??
                    "Winning-bid trends, pricing and competitive pressure need bid/auction report facts, which are not on the current data path."
                  }
                />
              )}
            </div>

            <div className="loop-card">
              <div className="loop-card__head">
                <span className="loop-card__title">Transcript Intelligence</span>
                <span className="loop-badge loop-badge--idle">
                  {briefing?.moduleOutputs[0]?.transcriptIntelligence.available ? "Extracted" : "Unavailable"}
                </span>
              </div>
              {briefing?.moduleOutputs[0]?.transcriptIntelligence.available ? (
                <div className="loop-tx">
                  <div className="loop-tx__col">
                    <p className="loop-tx__h">Intent</p>
                    {briefing.moduleOutputs[0].transcriptIntelligence.intents.map((x, i) => (
                      <p className="loop-tx__row" key={i}>{x.intent} <b>{x.count}</b></p>
                    ))}
                  </div>
                  <div className="loop-tx__col">
                    <p className="loop-tx__h">Rejection causes</p>
                    {briefing.moduleOutputs[0].transcriptIntelligence.rejectionCauses.map((x, i) => (
                      <p className="loop-tx__row" key={i}>{x.cause} <b>{x.count}</b></p>
                    ))}
                  </div>
                </div>
              ) : (
                <Empty
                  icon="chat"
                  title="Not enough data: no transcripts."
                  body={
                    briefing?.moduleOutputs[0]?.transcriptIntelligence.notEnoughDataReason ??
                    "The CallGrid sensor does not deliver call transcripts today, so transcript intelligence cannot run."
                  }
                />
              )}
            </div>

            {/* Unknowns & Missing Evidence — the honest edges */}
            <div className="loop-card">
              <div className="loop-card__head">
                <span className="loop-card__title">Unknowns &amp; Missing Evidence</span>
                <span className="loop-badge loop-badge--idle">Honest</span>
              </div>
              {briefing && (briefing.missingEvidence.length > 0 || briefing.unknowns.length > 0) ? (
                <ul className="loop-gaps">
                  {briefing.missingEvidence.map((m, i) => (
                    <li className="loop-gap" key={`m${i}`}>
                      <span className="loop-gap__icon"><SidebarIcon name="search" /></span>
                      <span>{m}</span>
                    </li>
                  ))}
                  {briefing.unknowns.map((u, i) => (
                    <li className="loop-gap loop-gap--q" key={`u${i}`}>
                      <span className="loop-gap__icon"><SidebarIcon name="brain" /></span>
                      <span>{u}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty
                  icon="search"
                  title="Nothing flagged as unknown."
                  body="When the Brain cannot reach a confident conclusion, it names what it would need to know here instead of guessing."
                />
              )}
            </div>
          </div>

          <aside className="loop-rail">
            <div className="loop-card">
              <div className="loop-card__head">
                <span className="loop-card__title">Jump to</span>
              </div>
              <div className="loop-brief">
                <Link className="loop-brief__item" href="/app/admin/marketplace">
                  <span className="loop-brief__icon"><SidebarIcon name="grid" /></span>
                  <div className="loop-brief__text">
                    <div className="loop-brief__title">Marketplace</div>
                    <div className="loop-brief__wait">The reporting the Brain explains.</div>
                  </div>
                </Link>
                <Link className="loop-brief__item" href="/app/admin/work">
                  <span className="loop-brief__icon"><SidebarIcon name="flow" /></span>
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
                <span className="loop-card__title">Live Calls <span className="loop-count">{num(liveCalls.length)}</span></span>
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
