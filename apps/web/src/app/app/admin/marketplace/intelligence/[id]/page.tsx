import Link from "next/link";
import { notFound } from "next/navigation";

import {
  OPERATIONAL_OUTCOMES, SITUATION_KIND_LABELS, formatEvidenceValue, metricLabel, situationKind, ownershipOf, type PriorityState,
} from "@emgloop/shared";

import { loadCommandContext, withQuery, type SearchParams } from "../../command-data";
import { CommandShell, money } from "../../command-ui";
import { loadExecutiveAnalysis, numbersHref } from "../../executive-data";
import { loadPriorityDetail } from "../../operational-queue-data";
import { SituationDetail } from "../../queue-ui";
import {
  markReviewedAction, assignAction, watchAction, stopWatchingAction, addNoteAction,
  recordContactAction, recordOutcomeAction, resolveAction, dismissAction,
} from "../../operational-actions";
import { DecisionActions, DecisionTimeline, OUTCOME_LABEL, STATE_LABEL, nameOf } from "../../../_decisions/decision-ui";
import { requireWorkspacePermission } from "../../../../../../workspaces/guard";

export const dynamic = "force-dynamic";

// CallGrid Intelligence — one Situation, in full.
//
// THE RECORD IS FOUND WITHIN THE SESSION'S ORGANIZATION (`loadPriorityDetail`
// resolves it scoped to the org and returns null otherwise), so another tenant's id
// is not-found, never forbidden.
//
// WHEN THE SELECTED PERIOD STILL DETECTS IT, the live analysis is shown: what
// happened, why it matters, the suggested action, why Loop raised it, the measured
// values, the evidence and the limits, with the decision controls. WHEN IT DOES NOT
// (it was detected in another period), the page says so and shows what Loop RECORDED
// at detection -- the evidence snapshot, its limits and unknowns -- rather than
// re-deriving a conclusion for a window it is not about.

const BASE = "/app/admin/marketplace";
const ACTIONS = {
  markReviewed: markReviewedAction, assign: assignAction, watch: watchAction, stopWatching: stopWatchingAction,
  addNote: addNoteAction, recordContact: recordContactAction, recordOutcome: recordOutcomeAction,
  resolve: resolveAction, dismiss: dismissAction,
};
const ENTITY_ROUTE: Record<string, string> = { buyer: "buyers", vendor: "vendors", source: "sources", campaign: "campaigns" };

type Snapshot = {
  claims?: { statement?: string; basis?: string }[];
  values?: { metricKey?: string; window?: string; entityName?: string | null; rawValue?: unknown; derivedValue?: unknown }[];
  limitations?: string[];
  unknowns?: string[];
};

/** A recorded evidence value in its metric's unit; anything that is not a number is shown as it was stored. */
function recordedValue(v: NonNullable<Snapshot["values"]>[number]): string {
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
  const derivedValue = num(v.derivedValue);
  const rawValue = num(v.rawValue);
  if (derivedValue === null && rawValue === null) {
    const stored = v.derivedValue ?? v.rawValue;
    return stored === undefined || stored === null ? "—" : String(stored);
  }
  return formatEvidenceValue({ metricKey: v.metricKey ?? "", formula: null, derivedValue, rawValue });
}

export default async function SituationPage({ params, searchParams }: { params: { id: string }; searchParams?: SearchParams }) {
  const session = await requireWorkspacePermission("ADMIN", "intelligence", "view");
  const ctx = await loadCommandContext(session, searchParams);
  const detail = await loadPriorityDetail(ctx.organizationId, params.id).catch(() => null);
  if (!detail) notFound();

  const analysis = await loadExecutiveAnalysis(ctx);
  const live = analysis.ops.items.find((i) => i.record?.id === detail.priority.id) ?? null;
  const returnTo = withQuery(`${BASE}/intelligence/${encodeURIComponent(detail.priority.id)}`, ctx.query);
  // The live title when this period detects it; the recorded one otherwise.
  const crumbs = [
    { label: "Intelligence", href: withQuery(`${BASE}/intelligence`, ctx.query) },
    { label: live?.situation.title ?? detail.priority.title },
  ];

  if (live) {
    const s = live.situation;
    const seen = new Map<string, { key: string; label: string; type: string; href: string | null }>();
    for (const o of s.observations) {
      for (const e of o.affectedEntities) {
        const key = (e.entityId || e.entityName).toLowerCase();
        const route = ENTITY_ROUTE[e.entityType];
        seen.set(`${e.entityType}:${key}`, {
          key, label: e.entityName, type: e.entityType.replace("_", " "),
          href: route ? withQuery(`${BASE}/${route}/${encodeURIComponent(key)}`, ctx.query) : e.entityType.startsWith("bid_") ? withQuery(`${BASE}/bids`, ctx.query) : null,
        });
      }
    }
    return (
      <CommandShell ctx={ctx} active="intelligence" path={`${BASE}/intelligence/${encodeURIComponent(detail.priority.id)}`} crumbs={crumbs}>
        <SituationDetail
          item={{ ...live, log: detail.observations, history: detail.history }}
          members={analysis.members}
          canAct={ctx.canAct}
          returnTo={returnTo}
          now={ctx.now}
          kindLabel={SITUATION_KIND_LABELS[situationKind(s)]}
          entityLinks={[...seen.values()]}
        />
        <p className="cgx-foot"><Link href={numbersHref(ctx, s)}>Open the numbers behind this →</Link></p>
      </CommandShell>
    );
  }

  // Detected in another period: what Loop recorded, with the controls.
  const p = detail.priority;
  const detected = detail.observations.find((o) => o.observationType === "SITUATION_DETECTED");
  const snap = (detected?.evidence ?? null) as Snapshot | null;
  const state = detail.state as PriorityState;
  const ownership = ownershipOf({ state, accountable: nameOf(analysis.members, p.ownerUserId), working: nameOf(analysis.members, p.assigneeUserId) });
  const outcomeGroups = [{
    key: "OPEN" as const,
    label: "How it ended",
    choices: OPERATIONAL_OUTCOMES.map((value) => ({ value, label: OUTCOME_LABEL[value] ?? value })),
  }];

  return (
    <CommandShell ctx={ctx} active="intelligence" path={`${BASE}/intelligence/${encodeURIComponent(p.id)}`} crumbs={crumbs}>
      <article className="cgx-situation" aria-label={p.title}>
        <header className="cgx-situation__head">
          <p className="cgx-situation__kicker">{STATE_LABEL[state]}</p>
          <h2 className="cgx-situation__title">{p.title}</h2>
        </header>
        <p className="cgx-note">
          {ctx.selection.label} does not detect this situation, so this is what Loop recorded when it last did — not a fresh analysis. Choose the period it was detected in to see the live reasoning.
        </p>
        <div className="cgx-situation__grid">
          <section className="cgx-situation__block">
            <h3 className="cgx-situation__h">What happened</h3>
            <p>{p.summary}</p>
          </section>
          <section className="cgx-situation__block">
            <h3 className="cgx-situation__h">Why it matters</h3>
            <p><strong>{money(p.impactCents)}</strong> <span className="cgx-muted">{(p.impactLabel ?? "").toLowerCase()}</span></p>
          </section>
          <section className="cgx-situation__block">
            <h3 className="cgx-situation__h">Detection</h3>
            <p className="cgx-muted">Seen in {p.detectionCount} period{p.detectionCount === 1 ? "" : "s"}.</p>
          </section>
        </div>
        <section className="cgx-situation__block">
          <h3 className="cgx-situation__h">Decide</h3>
          {ctx.canAct ? (
            <DecisionActions priorityId={p.id} state={state} members={analysis.members} returnTo={returnTo} actions={ACTIONS} outcomeGroups={outcomeGroups} history={detail.history} ownership={ownership} />
          ) : (
            <p className="q-actnote">You have view-only access to intelligence.</p>
          )}
        </section>
        {snap?.claims && snap.claims.length > 0 ? (
          <details className="cgx-more-section" open>
            <summary className="cgx-more-section__summary">Why Loop raised this (as recorded)</summary>
            <ol className="q-chain__list">{snap.claims.map((c, i) => <li key={i} className="q-chain__link"><span className="q-chain__stmt">{c.statement}</span>{c.basis ? <span className="q-chain__basis">{c.basis}</span> : null}</li>)}</ol>
          </details>
        ) : null}
        {snap?.values && snap.values.length > 0 ? (
          <details className="cgx-more-section">
            <summary className="cgx-more-section__summary">Observed evidence (as recorded)</summary>
            <ul className="cgx-situation__list">
              {snap.values.map((v, i) => (
                <li key={i}>{v.metricKey ? metricLabel(v.metricKey) : "Value"}{v.entityName ? ` · ${v.entityName}` : ""}{v.window ? ` · ${v.window}` : ""}: {recordedValue(v)}</li>
              ))}
            </ul>
          </details>
        ) : null}
        {(snap?.limitations?.length ?? 0) + (snap?.unknowns?.length ?? 0) > 0 ? (
          <details className="cgx-more-section">
            <summary className="cgx-more-section__summary">Limits (as recorded)</summary>
            <ul className="q-gaps__list">{[...(snap?.unknowns ?? []), ...(snap?.limitations ?? [])].map((u, i) => <li key={i}>{u}</li>)}</ul>
          </details>
        ) : null}
        <details className="cgx-more-section" open>
          <summary className="cgx-more-section__summary">What people have done</summary>
          <DecisionTimeline log={detail.observations} members={analysis.members} />
        </details>
      </article>
    </CommandShell>
  );
}
