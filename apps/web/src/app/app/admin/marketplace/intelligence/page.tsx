import Link from "next/link";

import { SITUATION_KIND_LABELS, confidenceOf, groupUnknowns, situationKind, type PriorityState } from "@emgloop/shared";
import { decisionEngine, type OperationalPriority } from "@emgloop/database";

import { loadCommandContext, withQuery, type SearchParams } from "../command-data";
import { CommandShell, money } from "../command-ui";
import { loadExecutiveAnalysis, situationHref, numbersHref } from "../executive-data";
import {
  SituationRow, TodaysStorySection, DecisionActivitySection, OpenWorkSection, UnknownGroups,
} from "../queue-ui";
import { MarketplaceRiskPanel, OpportunitiesSection, FindingList } from "../intelligence-ui";
import { CALLGRID_SOURCE } from "../operational-queue-data";
import { STATE_LABEL } from "../../_decisions/decision-ui";
import { requireWorkspacePermission } from "../../../../../workspaces/guard";
import {
  INTEL_CONFIDENCE, INTEL_ENTITIES, INTEL_KINDS, INTEL_LANES, LANE_STATE,
  intelQuery, matchesIntelFilter, readIntelFilter, type IntelLane,
} from "../intelligence-filter";

export const dynamic = "force-dynamic";

// CallGrid Intelligence — the Intelligence workspace.
//
// THIS IS WHERE THE DEPTH LIVES. Everything the Overview used to stack on one page
// is here, moved and not removed: every Situation Loop detected with its decision
// controls (Review, Assign, Watch, Resolve, Dismiss), its evidence, its reasoning
// and its limits; open work from earlier periods; how Loop's own calls have turned
// out; the business story; the marketplace structure; and everything Loop could not
// determine.
//
// LANES ARE THE DURABLE RECORD. Needs review / Watching / Assigned / Resolved /
// Dismissed are the decision record's states, counted across every period, and a
// lane shows this period's Situations in that state first, then the ones from
// earlier periods that are still in it. Filters narrow; none of them hides a lane.

const BASE = "/app/admin/marketplace";
/** How many situations get a full decision card; the rest are rows that open their own page. */
const CARD_LIMIT = 5;
const LANE_LABEL: Record<IntelLane, string> = {
  "needs-review": "Needs review",
  watching: "Watching",
  assigned: "Assigned",
  resolved: "Resolved",
  dismissed: "Dismissed",
  all: "All",
};
const ENTITY_LABEL: Record<(typeof INTEL_ENTITIES)[number], string> = {
  buyer: "Buyers", vendor: "Vendors", source: "Sources", campaign: "Campaigns", bids: "Bids", market: "Whole marketplace",
};
const KIND_LABEL: Record<(typeof INTEL_KINDS)[number], string> = {
  risk: "Risk", opportunity: "Opportunity", investigation: "Needs investigation", watch: "Watch",
};
const CONF_LABEL: Record<(typeof INTEL_CONFIDENCE)[number], string> = {
  high: "High confidence", moderate: "Moderate", low: "Low", insufficient: "Insufficient evidence",
};

export default async function IntelligencePage({ searchParams }: { searchParams?: SearchParams }) {
  const session = await requireWorkspacePermission("ADMIN", "intelligence", "view");
  const ctx = await loadCommandContext(session, searchParams);
  const analysis = await loadExecutiveAnalysis(ctx);
  const { intel, ops, members, bidIntel } = analysis;
  const filter = readIntelFilter(searchParams);
  const returnTo = withQuery(`${BASE}/intelligence`, intelQuery(ctx.query, filter));

  const shown = ops.items.filter((i) => matchesIntelFilter(i, filter));
  const metrics = [...new Set(ops.items.map((i) => i.situation.observations[0]?.primaryMetric).filter((m): m is string => Boolean(m)))].sort();

  // The lane's items from EARLIER periods: in the durable record, in this state, not
  // detected by this period's analysis. Only for a lane, and only when no filter that
  // needs the analysis (kind, confidence, metric) is set -- a record without its
  // analysis cannot be classified, and pretending otherwise would be a guess.
  let earlier: OperationalPriority[] = [];
  const analysisFilter = filter.kind !== null || filter.confidence !== null || filter.metric !== null || filter.entity !== null;
  if (filter.lane !== "all" && !analysisFilter && !ops.persistenceError) {
    const inPeriod = new Set(ops.items.map((i) => i.record?.id).filter(Boolean));
    earlier = (await decisionEngine
      .list(ctx.organizationId, { producer: CALLGRID_SOURCE, states: [LANE_STATE[filter.lane] as PriorityState], take: 50 })
      .catch(() => []))
      .filter((p) => !inPeriod.has(p.id));
  }

  const laneHref = (lane: IntelLane) => withQuery(`${BASE}/intelligence`, intelQuery(ctx.query, filter, { lane }));
  const count = (lane: IntelLane) =>
    ops.persistenceError ? "—" : lane === "all"
      ? String(Object.values(ops.counts).reduce((a, b) => a + b, 0))
      : String(ops.counts[LANE_STATE[lane]]);

  return (
    <CommandShell ctx={ctx} active="intelligence" path={`${BASE}/intelligence`}>
      {ops.persistenceError ? <p className="cgx-note">{ops.persistenceError}</p> : null}

      <nav className="cgx-lanes" aria-label="Decision states">
        {INTEL_LANES.map((lane) => {
          const on = filter.lane === lane;
          return (
            <Link key={lane} href={laneHref(lane)} className={"cgx-lane" + (on ? " cgx-lane--on" : "")} aria-current={on ? "page" : undefined}>
              <span className="cgx-lane__label">{LANE_LABEL[lane]}</span>
              <span className="cgx-lane__n">{count(lane)}</span>
            </Link>
          );
        })}
      </nav>

      <form method="get" action={`${BASE}/intelligence`} className="cgx-filters" aria-label="Filter intelligence">
        {[...new URLSearchParams(ctx.query)].map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
        {filter.lane !== "needs-review" ? <input type="hidden" name="lane" value={filter.lane} /> : null}
        <label className="cgx-filters__field">
          <span>About</span>
          <select name="entity" defaultValue={filter.entity ?? ""} className="loop-input">
            <option value="">Anything</option>
            {INTEL_ENTITIES.map((e) => <option key={e} value={e}>{ENTITY_LABEL[e]}</option>)}
          </select>
        </label>
        <label className="cgx-filters__field">
          <span>Type</span>
          <select name="kind" defaultValue={filter.kind ?? ""} className="loop-input">
            <option value="">Any type</option>
            {INTEL_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
          </select>
        </label>
        <label className="cgx-filters__field">
          <span>Evidence</span>
          <select name="confidence" defaultValue={filter.confidence ?? ""} className="loop-input">
            <option value="">Any strength</option>
            {INTEL_CONFIDENCE.map((c) => <option key={c} value={c}>{CONF_LABEL[c]}</option>)}
          </select>
        </label>
        <label className="cgx-filters__field">
          <span>Metric</span>
          <select name="metric" defaultValue={filter.metric ?? ""} className="loop-input">
            <option value="">Any metric</option>
            {metrics.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <button type="submit" className="loop-btn">Apply</button>
        <Link href={withQuery(`${BASE}/intelligence`, intelQuery(ctx.query, filter, { entity: null, kind: null, confidence: null, metric: null }))} className="cgx-filters__clear">Clear filters</Link>
      </form>

      <p className="cgx-foot">
        {shown.length === 1 ? "1 situation" : `${shown.length} situations`} from {ctx.selection.label} in this view
        {earlier.length > 0 ? `, and ${earlier.length} from earlier periods still ${LANE_LABEL[filter.lane].toLowerCase()}` : ""}.
        Each is one business event, merged from the findings that describe it.
      </p>

      <div className="q-queue cgx-queue" id="decision-queue">
        {shown.length === 0 ? (
          <p className="cgx-empty">
            {ops.items.length === 0
              ? intel.queue.emptyReason ?? "Loop found nothing to decide on for this period."
              : "Nothing in this period matches this view."}
          </p>
        ) : (
          // The first few as full decision cards; every other one as a row that opens its
          // own page with the same controls, evidence and limits. Every decision is listed.
          shown.slice(0, CARD_LIMIT).map((item, i) => (
            <SituationRow
              key={item.situation.id}
              item={item}
              rank={i + 1}
              entityHref={numbersHref(ctx, item.situation)}
              detailHref={item.record ? situationHref(ctx, item) : null}
              members={members}
              canAct={ctx.canAct}
              returnTo={returnTo}
              now={ctx.now}
              tier={i < 3 && item.state === "NEEDS_REVIEW" ? "primary" : "compact"}
            />
          ))
        )}
      </div>

      {shown.length > CARD_LIMIT ? (
        <section className="cgx-card cgx-card--wide" aria-label="More in this view">
          <header className="cgx-card__head"><h2 className="cgx-card__title">{shown.length - CARD_LIMIT} more in this view</h2></header>
          <div className="adm-tablewrap cgx-card__body">
            <table className="adm-table dim-table cgx-table">
              <thead><tr><th>#</th><th>Situation</th><th>Type</th><th>State</th><th>Evidence</th><th className="dim-num">Impact</th></tr></thead>
              <tbody>
                {shown.slice(CARD_LIMIT).map((item, i) => {
                  const kind = situationKind(item.situation);
                  return (
                    <tr key={item.situation.id} className="dim-row">
                      <td>{CARD_LIMIT + i + 1}</td>
                      <td><Link href={situationHref(ctx, item)} className="dim-rowlink">{item.situation.title}</Link></td>
                      <td>{SITUATION_KIND_LABELS[kind]}</td>
                      <td>{STATE_LABEL[item.state]}</td>
                      <td>{confidenceOf(item.situation).label}</td>
                      <td className="dim-num">{money(item.situation.impact.amountCents)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {earlier.length > 0 ? (
        <section className="cgx-card cgx-card--wide" aria-label="From earlier periods">
          <header className="cgx-card__head"><h2 className="cgx-card__title">From earlier periods</h2></header>
          <ul className="q-lines">
            {earlier.map((p) => (
              <li key={p.id} className="q-line">
                <span className={"q-line__state q-line__state--" + p.state.toLowerCase()}>{STATE_LABEL[p.state as PriorityState]}</span>
                <Link href={withQuery(`${BASE}/intelligence/${encodeURIComponent(p.id)}`, ctx.query)} className="q-line__title">{p.title}</Link>
                <span className="q-line__money">{money(p.impactCents)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <DecisionActivitySection activity={ops.activity} />

      <details className="cgx-more-section">
        <summary className="cgx-more-section__summary">Open work from every period</summary>
        <OpenWorkSection openWork={ops.openWork} members={members} now={ctx.now} />
      </details>

      <details className="cgx-more-section">
        <summary className="cgx-more-section__summary">The story of this period</summary>
        <TodaysStorySection reasoning={intel.reasoning} />
      </details>

      <details className="cgx-more-section">
        <summary className="cgx-more-section__summary">Money available and risks worth attention</summary>
        <OpportunitiesSection opportunities={intel.opportunityFindings} sectionLabel="Money Available" />
        <FindingList sectionLabel="Risks Worth Attention" findings={intel.risks} emptyLine="No evidence-backed risk for this period." compact />
      </details>

      <details className="cgx-more-section">
        <summary className="cgx-more-section__summary">Marketplace structure</summary>
        <MarketplaceRiskPanel risk={intel.risk} />
      </details>

      <details className="cgx-more-section" open>
        <summary className="cgx-more-section__summary">What Loop could not determine</summary>
        <UnknownGroups groups={groupUnknowns([...intel.unknowns, ...bidIntel.unknowns])} sectionLabel="What Loop could not determine about this period" />
      </details>

      <p className="q-prov">
        {ctx.desc.headerLine}
        {ctx.desc.comparisonNote ? ` · ${ctx.desc.comparisonNote}` : ""} · <Link href={withQuery(`${BASE}/activity`, ctx.query)}>Every finding as a stream →</Link>
      </p>
    </CommandShell>
  );
}
