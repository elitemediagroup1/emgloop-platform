// The Decision Center, as CallGrid Intelligence renders it.
//
// WHAT LIVES HERE vs `_decisions/decision-ui.tsx`. Everything in this file reads
// a `Situation` — a CallGrid type carrying a claim, a reasoning chain, an
// escalation state and merged findings. Everything that does NOT (the brief
// shell, the lanes, confidence, ownership, the controls, the timeline, activity,
// open work, unknown groups) lives in the platform folder and knows nothing about
// calls or buyers. When CRM or Accounting starts publishing decisions, it reuses
// that half unchanged and writes its own card body — the way the engine already
// works for every producer.
//
// THIS PAGE IS A QUEUE, NOT A DOCUMENT. It is scanned and cleared, not read top
// to bottom, so the craft here is information design rather than prose: the brief
// answers "is there a fire" in one line, each card carries a name, a decision and
// a consequence, and everything else is one expansion away.
//
// A CARD SHOWS THREE DIFFERENT KINDS OF THING, and they are never styled alike:
// what was MEASURED (the money, the counts), what Loop READ into it (the claim,
// the chain), and what a HUMAN did about it (owner, status, history). Collapsing
// those into one voice is how a product starts sounding like it knows more than
// it does.
//
// THIS IS AN INBOX, NOT A REPORT. Every decision is on the page — there is no
// "N more tracked" and nothing behind a count. What differs is how much ROOM each
// gets. That now includes the compact tier: it previously hid "why this matters"
// with `display: none`, which made tiering a filter rather than a layout. A
// reader who suspects the product is withholding items stops trusting the count,
// and then stops trusting the queue.
//
// THE EYE SHOULD LAND ON THE ACTION. Within a card the recommended action is the
// largest thing after the title. What happened is context for the decision, not
// the point of the card — an operator opening this at 8am needs to know what to
// DO, and the measurement is how they check it afterwards.
//
// Presentational server components only. The expansions are native <details>, so
// inspecting a conclusion costs no client JavaScript.

import Link from 'next/link';
import type {
  Situation, Briefing, ChainLink, PriorityState, LifecycleHistory,
  BusinessHealth, OperationalReasoning, CallGridFinding, Opportunity,
} from '@emgloop/shared';
import {
  ESCALATION_LABEL, REVIEW_URGENCY_LABEL, HEALTH_BAND_LABEL,
  standingOf, confidenceOf, whyItMatters, outcomeChoices, tierDecisions,
  ownershipOf, storyDigest,
} from '@emgloop/shared';
import { EvidenceDrawer } from './intelligence-ui';
import type { LivePriority } from './operational-queue-data';
import {
  markReviewedAction, assignAction, watchAction, stopWatchingAction,
  addNoteAction, recordContactAction, recordOutcomeAction,
  resolveAction, dismissAction,
} from './operational-actions';
import {
  MissionBrief, LaneRail, ConfidencePill, OwnershipTag, DecisionActions,
  DecisionTimeline, DecisionActivityPanel, OpenWorkPanel, UnknownGroups, TierHead,
  STATE_LABEL, money, nameOf, since, duration, greetingAt,
  type QueueMember, type BriefFocus, type DecisionActionSet,
} from '../_decisions/decision-ui';

export type { QueueMember };
export {
  LaneRail, DecisionActivityPanel as DecisionActivitySection,
  OpenWorkPanel as OpenWorkSection, UnknownGroups,
};

/** The producer's action module, bound once. */
const ACTIONS: DecisionActionSet = {
  markReviewed: markReviewedAction,
  assign: assignAction,
  watch: watchAction,
  stopWatching: stopWatchingAction,
  addNote: addNoteAction,
  recordContact: recordContactAction,
  recordOutcome: recordOutcomeAction,
  resolve: resolveAction,
  dismiss: dismissAction,
};

/**
 * Severity as a rail weight and position, never as the word "Critical".
 *
 * "Critical / High / Notable" is engine vocabulary. What an operator needs is to
 * see at a glance which card is worst — that is form, not a label, and the card's
 * position already carries the ranking. The rail now varies in WIDTH as well as
 * colour, so urgency survives greyscale and colour blindness; the verdict line
 * says it in words as well. A card somebody owns cools down: still important, no
 * longer the reader's problem to pick up.
 */
function railTone(s: Situation, state: PriorityState): string {
  if (state === 'RESOLVED' || state === 'DISMISSED') return 'done';
  if (state === 'ASSIGNED' || state === 'WATCHING') return 'held';
  if (s.reviewPriority === 'IMMEDIATE' || s.reviewPriority === 'TODAY') return 'fire';
  if (s.reviewPriority === 'THIS_WEEK') return 'warn';
  return 'calm';
}

/** The DOM id of a decision card, so the brief can link straight to one. */
export function decisionAnchor(situationId: string): string {
  return 'decision-' + situationId;
}

/**
 * Where the brief's "biggest risk" and "biggest opportunity" should send the
 * reader: the Situation that MERGED the finding, since the queue ranks
 * Situations and a finding no longer exists as a row of its own.
 *
 * Returns null when no Situation carries it — the card then links to the queue
 * rather than to an anchor that does not resolve, which is the failure a reader
 * only notices after clicking.
 */
export function anchorForFinding(
  situations: readonly Situation[],
  findingId: string | null,
): string | null {
  if (!findingId) return null;
  const owner = situations.find((s) => s.observations.some((o) => o.id === findingId));
  return owner ? '#' + decisionAnchor(owner.id) : null;
}

/** The one-line verdict that replaces a severity badge. */
function verdictOf(s: Situation): string {
  switch (s.reviewPriority) {
    case 'IMMEDIATE': return 'Needs you now';
    case 'TODAY': return 'Needs you today';
    case 'THIS_WEEK': return 'Needs you this week';
    case 'MONITOR': return 'Worth watching';
    default: return 'No action today';
  }
}

// --- The brief ----------------------------------------------------------------

/** Money for the brief, or null when nothing was measurable. */
function briefMoney(cents: number | null): string | null {
  return cents === null ? null : money(cents);
}

/**
 * The CallGrid adapter over the platform brief.
 *
 * Its whole job is turning this producer's health model, findings and counts into
 * the neutral props `MissionBrief` takes. No string is composed here that the
 * engine did not already produce, and the two focus cards are findings the engine
 * already ranked — they were previously two collapses deep inside the supporting
 * drawer, where the one screen that decides an operator's morning could not
 * reach them.
 */
export function ExecutiveBrief({
  briefing, health, counts, operatorName, periodLabel, live, updatedLabel,
  now, topRisk, topOpportunity, riskHref, opportunityHref, persistenceError,
}: {
  briefing: Briefing;
  health: BusinessHealth;
  counts: { needsDecision: number; assigned: number; watching: number; closed: number };
  operatorName: string | null;
  periodLabel: string;
  live: boolean;
  updatedLabel: string;
  now: Date;
  topRisk: CallGridFinding | null;
  topOpportunity: Opportunity | null;
  riskHref: string | null;
  opportunityHref: string | null;
  persistenceError?: string | null;
}) {
  const band = health.overall.band;

  const focus: BriefFocus[] = [];
  if (topRisk) {
    focus.push({
      kind: 'RISK',
      title: topRisk.title,
      // The finding's own measured movement. Null when the rule established no
      // amount — "Not quantifiable" is rendered, never a zero.
      amount: briefMoney(topRisk.absoluteChange),
      amountLabel: topRisk.absoluteChange === null ? null : 'measured change',
      href: riskHref,
    });
  }
  if (topOpportunity) {
    focus.push({
      kind: 'OPPORTUNITY',
      title: topOpportunity.finding.title,
      // EXPOSURE or a measured GAP — never a predicted gain, which is why the
      // engine's own `impactLabel` travels with it. An amount without its basis
      // is a forecast wearing a measurement's clothes.
      amount: briefMoney(topOpportunity.estimatedImpactCents),
      amountLabel: topOpportunity.estimatedImpactCents === null
        ? null
        : topOpportunity.impactLabel,
      href: opportunityHref,
    });
  }

  return (
    <MissionBrief
      greeting={greetingAt(now)}
      operatorName={operatorName}
      verdictBand={band}
      // UNKNOWN is rendered as UNKNOWN. "We could not read the data" and
      // "everything is fine" must never look the same.
      verdictLine={
        band === 'UNKNOWN'
          ? 'Loop could not establish overall health for this period.'
          : `Marketplace health — ${HEALTH_BAND_LABEL[band].toLowerCase()}`
      }
      verdictWhy={health.overall.explanation}
      counts={counts}
      measured={briefMoney(briefing.measuredImpactCents)}
      unmeasurableCount={briefing.unpricedCount}
      focus={focus}
      recommendation={briefing.sequencing ?? briefing.opener}
      periodLabel={periodLabel}
      live={live}
      updatedLabel={updatedLabel}
      persistenceError={persistenceError}
    />
  );
}

// --- One card -----------------------------------------------------------------

function ChainView({ links, terminus, wouldExtend }: {
  links: ChainLink[];
  terminus: string;
  wouldExtend: string;
}) {
  return (
    <div className="q-chain">
      <ol className="q-chain__list">
        {links.map((l, i) => (
          <li className={'q-chain__link q-chain__link--' + l.support} key={i}>
            <span className="q-chain__stmt">{l.statement}</span>
            {l.basis ? <span className="q-chain__basis">{l.basis}</span> : null}
          </li>
        ))}
      </ol>
      {/* The terminus is the most important honesty device on the page. A chain
          that stops silently reads as a complete explanation. */}
      <div className="q-chain__end">
        <p className="q-chain__endtext">{terminus}</p>
        <p className="q-chain__extend">
          <span className="q-chain__extendlabel">What would extend this</span>
          {wouldExtend}
        </p>
      </div>
    </div>
  );
}

/**
 * Loop's read: a claim, its basis, what argues against it, the boundary, and
 * what would change it.
 *
 * The disconfirming field is why this block exists. A system that only ever
 * reports supporting evidence is indistinguishable from one that cannot look for
 * the other kind, and the reader has no way to calibrate it. Nothing here is a
 * probability — every clause traces to a measured value.
 */
function ReadBlock({ situation }: { situation: Situation }) {
  const r = situation.read;
  return (
    <div className="q-read">
      <p className="q-read__h">What Loop thinks is going on</p>
      <p className="q-read__claim">{r.claim}</p>
      <dl className="q-read__list">
        <div><dt>Because</dt><dd>{r.because}</dd></div>
        <div><dt>What argues against it</dt><dd>{r.arguesAgainst}</dd></div>
        <div><dt>What Loop can&rsquo;t see</dt><dd>{r.cannotSee}</dd></div>
        <div><dt>What would change this read</dt><dd>{r.wouldChange}</dd></div>
      </dl>
    </div>
  );
}

/**
 * The durable facts: how long this has been known, who has it, how it has gone.
 *
 * "Third time in six weeks" is a measured fact about the record, and it changes
 * what an operator does far more than the severity band does.
 */
function StandingBlock({
  item, members, now,
}: {
  item: LivePriority;
  members: QueueMember[];
  now: Date;
}) {
  const h: LifecycleHistory | null = item.history;
  const firstSeen = since(item.firstDetectedAt, now);
  const owner = nameOf(members, item.ownerUserId);

  return (
    <dl className="q-standing">
      <div>
        <dt>Status</dt>
        <dd>{STATE_LABEL[item.state]}{owner ? ` · ${owner} answers for it` : ''}</dd>
      </div>
      {firstSeen ? (
        <div>
          <dt>First seen</dt>
          <dd>
            {firstSeen}
            {item.detectionCount > 1
              ? ` · seen in ${item.detectionCount} periods since`
              : ' · first time Loop has seen this'}
          </dd>
        </div>
      ) : null}
      {item.reopenCount > 0 ? (
        <div>
          <dt>Came back</dt>
          <dd>
            Closed and detected again {item.reopenCount} time
            {item.reopenCount === 1 ? '' : 's'}. A resolution that did not hold.
          </dd>
        </div>
      ) : null}
      {h && h.contactAttempts > 0 ? (
        <div>
          <dt>Contact</dt>
          <dd>{h.contactAttempts} recorded attempt{h.contactAttempts === 1 ? '' : 's'}</dd>
        </div>
      ) : null}
      {h && h.msToFirstDecision !== null ? (
        <div>
          <dt>Time to first decision</dt>
          <dd>{duration(h.msToFirstDecision)}</dd>
        </div>
      ) : null}
    </dl>
  );
}

/**
 * How many measured values back this, and where they came from.
 *
 * "3 independent measurements" would be a claim Loop cannot support — several
 * values routinely come from the same provider report row, and independence is
 * not something the evidence model establishes. Countable and true instead:
 * how many values, from how many named sources.
 */
function evidenceScale(s: Situation): { values: number; sources: number } {
  const values = s.observations.reduce((n, f) => n + f.supportingEvidence.length, 0);
  const sources = new Set(
    s.observations.flatMap((f) => f.supportingEvidence.map((e) => e.providerReport)),
  ).size;
  return { values, sources };
}

/**
 * One decision card: what it is, how much to trust it, what to do, and a visible
 * end.
 *
 * The tier changes how much ROOM this gets — padding, type scale — and never
 * what it contains. The previous pass hid "why this matters" on compact cards,
 * which quietly made a layout decision into an editorial one.
 */
export function SituationRow({
  item, rank, entityHref, members, canAct, returnTo, now, tier = 'primary',
}: {
  item: LivePriority;
  rank: number;
  entityHref: string | null;
  members: QueueMember[];
  canAct: boolean;
  returnTo: string;
  now: Date;
  tier?: 'primary' | 'compact';
}) {
  const s = item.situation;
  const confidence = confidenceOf(s);
  const why = whyItMatters(s);
  const ownership = ownershipOf({
    state: item.state,
    accountable: nameOf(members, item.ownerUserId),
    working: nameOf(members, item.assigneeUserId),
  });
  const scale = evidenceScale(s);
  const closed = item.state === 'RESOLVED' || item.state === 'DISMISSED';

  return (
    <article
      className={'q-row q-row--' + railTone(s, item.state) + ' q-row--' + tier}
      // So the brief can send the reader to THIS decision rather than to the top
      // of the queue. A link that lands on the wrong card is worse than one that
      // lands on the list.
      id={decisionAnchor(s.id)}
      aria-label={s.title}
    >
      <div className="q-row__rail" aria-hidden="true" />
      <div className="q-row__body">
        <div className="q-row__top">
          <span className="q-row__rank" aria-hidden="true">{rank}</span>
          <h3 className="q-row__title">{s.title}</h3>
          {/* Confidence sits beside the title on EVERY card and opens in place.
              Loop is a decision system; how much to trust a decision is not a
              detail to be found later, and it is not something you should need a
              mouse to read. */}
          <ConfidencePill
            strength={confidence.strength}
            label={confidence.label}
            basis={confidence.basis}
            determinacyNote={confidence.determinacyNote}
          />
          <OwnershipTag ownership={ownership} />
          {item.reopenCount > 0 ? (
            <span className="q-row__back">back {item.reopenCount}×</span>
          ) : null}
          {item.detectionCount > 1 ? (
            <span className="q-row__seen">seen {item.detectionCount}×</span>
          ) : null}
        </div>

        {/* Urgency in words, not only in the rail's colour. */}
        {!closed ? (
          <p className="q-row__verdict">{verdictOf(s)}</p>
        ) : (
          <p className="q-row__verdict q-row__verdict--closed">{STATE_LABEL[item.state]}</p>
        )}

        {/* THE FOCAL POINT. The eye lands on what to DO, not on what happened —
            the measurement is how an operator checks the decision afterwards,
            not how they make it. */}
        {s.decision ? <p className="q-row__action">{s.decision}</p> : null}

        {/* Why it matters, in consequences rather than deltas. Present at EVERY
            tier: hiding it on compact cards made the layout into a filter. */}
        {why ? (
          <p className="q-row__why">
            <span className="q-row__whylabel">Why this matters</span>
            {why}
          </p>
        ) : null}

        {/* One sentence. What happened, measured, no interpretation. */}
        <p className="q-row__sum">{s.whatHappened}</p>

        <div className="q-row__facts">
          <span className={'q-chip q-chip--' + (s.impact.amountCents === null ? 'unknown' : 'money')}>
            {money(s.impact.amountCents)}
            <span className="q-chip__note">{s.impact.label.toLowerCase()}</span>
          </span>
          <span className="q-chip">
            {s.observationCount} observation{s.observationCount === 1 ? '' : 's'}
            <span className="q-chip__note">merged</span>
          </span>
          {scale.values > 0 ? (
            <span className="q-chip">
              {scale.values} measured value{scale.values === 1 ? '' : 's'}
              <span className="q-chip__note">
                from {scale.sources} source{scale.sources === 1 ? '' : 's'}
              </span>
            </span>
          ) : null}
        </div>

        {canAct ? (
          <DecisionActions
            priorityId={item.record?.id ?? null}
            state={item.state}
            members={members}
            returnTo={returnTo}
            actions={ACTIONS}
            outcomeGroups={outcomeChoices(s)}
            history={item.history}
            ownership={ownership}
          />
        ) : (
          <p className="q-actnote">
            You have view-only access to intelligence, so the decision controls are
            not shown. An owner or admin can assign, resolve or dismiss this.
          </p>
        )}

        <div className="q-row__expansions">
          <details className="q-row__more">
            <summary className="q-row__summary">Why Loop raised this</summary>
            <div className="q-row__detail">
              <StandingBlock item={item} members={members} now={now} />

              <dl className="q-detail">
                <div><dt>What happened</dt><dd>{s.whatHappened}</dd></div>
                <div>
                  <dt>Impact</dt>
                  <dd>
                    <span className="q-detail__money">{money(s.impact.amountCents)}</span>
                    <span className="q-detail__note">{s.impact.statement}</span>
                  </dd>
                </div>
                {/* Two different questions, answered by two different sources and
                    never merged into one confident-sounding verdict. The analysis
                    reads one window and can only observe spreading; how often
                    this has been seen, and whether a resolution failed to hold,
                    are facts about the record. */}
                <div>
                  <dt>How this period looks</dt>
                  <dd>
                    <span className="q-detail__esc">{ESCALATION_LABEL[s.escalation.state]}</span>
                    <span className="q-detail__note">{s.escalation.basis}</span>
                  </dd>
                </div>
                {item.record ? (
                  <div>
                    <dt>How it has gone</dt>
                    <dd>
                      <span className="q-detail__esc">
                        {ESCALATION_LABEL[standingOf(item.record).state]}
                      </span>
                      <span className="q-detail__note">{standingOf(item.record).basis}</span>
                    </dd>
                  </div>
                ) : null}
                {s.ifIgnored ? (
                  <div><dt>If nothing changes</dt><dd>{s.ifIgnored}</dd></div>
                ) : null}
                <div>
                  <dt>Review priority</dt>
                  <dd>{REVIEW_URGENCY_LABEL[s.reviewPriority]}</dd>
                </div>
              </dl>

              <ReadBlock situation={s} />

              <ChainView
                links={s.chain.links}
                terminus={s.chain.terminus}
                wouldExtend={s.chain.wouldExtend}
              />

              <DecisionTimeline log={item.log} members={members} />

              {s.unknowns.length > 0 ? (
                <div className="q-gaps">
                  <p className="q-gaps__h">What Loop can&rsquo;t see about this</p>
                  <ul className="q-gaps__list">
                    {s.unknowns.slice(0, 4).map((u, i) => <li key={i}>{u}</li>)}
                  </ul>
                </div>
              ) : null}

              {entityHref ? (
                <p className="q-row__open">
                  <Link className="q-open" href={entityHref}>Open the numbers behind this →</Link>
                </p>
              ) : null}
            </div>
          </details>

          {/* Evidence, promoted out from three expansions deep to one. It is the
              reason to believe any of the above; burying it under two other
              summaries meant nobody ever checked a conclusion. */}
          {scale.values > 0 ? (
            <details className="q-row__more q-row__more--evidence">
              <summary className="q-row__summary">
                Observed — {scale.values} measured value{scale.values === 1 ? '' : 's'}
                {' '}from {scale.sources} source{scale.sources === 1 ? '' : 's'}
              </summary>
              <div className="q-row__detail">
                {/* The merge stays reversible: the reader can always see the
                    observations Loop combined, individually. */}
                {s.observationCount > 1
                  ? s.observations.map((o) => (
                      <div className="q-obs__item" key={o.id}>
                        <p className="q-obs__title">{o.title}</p>
                        <p className="q-obs__sum">{o.plainLanguageSummary}</p>
                        <EvidenceDrawer finding={o} />
                      </div>
                    ))
                  : <EvidenceDrawer finding={s.observations[0]!} />}
              </div>
            </details>
          ) : null}
        </div>
      </div>
    </article>
  );
}

// --- The queue ----------------------------------------------------------------

/**
 * The queue. An inbox, not a report.
 *
 * EVERY decision is on this page. There is no "N more tracked", nothing behind a
 * count and nothing collapsed away that still needs a person — the tiers change
 * how much ROOM a decision gets, never whether it appears.
 *
 * Four tiers, in the order attention should flow:
 *   1. Needs a decision — full cards, action-first, the first three.
 *   2. Also undecided   — compact cards, same information, less room.
 *   3. Someone has it   — one line each; not the reader's problem today.
 *   4. Closed           — collapsed, because the record is what matters now.
 */
export function QueueSection({
  items, emptyReason, hrefFor, members, canAct, returnTo, now,
}: {
  items: LivePriority[];
  emptyReason: string | null;
  hrefFor: (s: Situation) => string | null;
  members: QueueMember[];
  canAct: boolean;
  returnTo: string;
  now: Date;
}) {
  const tiers = tierDecisions(
    items,
    (i) => ({
      undecided: i.state === 'NEEDS_REVIEW',
      closed: i.state === 'RESOLVED' || i.state === 'DISMISSED',
    }),
  );

  if (items.length === 0) {
    return (
      <section className="q-empty" id="decision-queue" aria-label="Nothing needs attention">
        <p className="q-empty__text">{emptyReason}</p>
      </section>
    );
  }

  let rank = 0;
  const nextRank = () => (rank += 1);
  const card = (item: LivePriority, tier: 'primary' | 'compact') => (
    <SituationRow
      key={item.situation.id}
      item={item}
      rank={nextRank()}
      entityHref={hrefFor(item.situation)}
      members={members}
      canAct={canAct}
      returnTo={returnTo}
      now={now}
      tier={tier}
    />
  );

  return (
    <div className="q-queue" id="decision-queue">
      {tiers.primary.length > 0 ? (
        <>
          <TierHead
            tone="fire"
            label="Needs a decision"
            count={tiers.primary.length + tiers.active.length}
            id="tier-needs-decision"
          />
          {tiers.primary.map((item) => card(item, 'primary'))}
        </>
      ) : (
        <section className="q-empty" aria-label="Nothing undecided">
          <p className="q-empty__text">
            Everything Loop found this period has been decided on.
          </p>
        </section>
      )}

      {tiers.active.length > 0 ? (
        <>
          <TierHead tone="warn" label="Also waiting on a decision" count={tiers.active.length} />
          {tiers.active.map((item) => card(item, 'compact'))}
        </>
      ) : null}

      {tiers.monitoring.length > 0 ? (
        <>
          <TierHead tone="calm" label="Someone has it" count={tiers.monitoring.length} />
          <ul className="q-lines">
            {tiers.monitoring.map((item) => {
              const ownership = ownershipOf({
                state: item.state,
                accountable: nameOf(members, item.ownerUserId),
                working: nameOf(members, item.assigneeUserId),
              });
              return (
                <li className="q-line" key={item.situation.id}>
                  <span className={'q-line__state q-line__state--' + item.state.toLowerCase()}>
                    {STATE_LABEL[item.state]}
                  </span>
                  <span className="q-line__title">{item.situation.title}</span>
                  <span className="q-line__who">{ownership.label}</span>
                  <span className="q-line__age">
                    {since(item.record?.stateChangedAt ?? item.firstDetectedAt, now)}
                  </span>
                  <span className="q-line__money">{money(item.situation.impact.amountCents)}</span>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}

      {tiers.closed.length > 0 ? (
        <details className="q-handled">
          <summary className="q-handled__summary">
            {tiers.closed.length} closed this period
          </summary>
          <div className="q-handled__body">
            {tiers.closed.map((item) => card(item, 'compact'))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

// --- Today's story ------------------------------------------------------------

/**
 * The business narrative as a headline and three bullets.
 *
 * Promoted out of the supporting drawer, where a single paragraph in a tile went
 * unread. It explains the queue rather than measuring the business, so it belongs
 * with the decisions and not with the metrics.
 *
 * The bullets are whole cluster narratives, never clipped: these sentences carry
 * their own hedging, and a truncated hedge reads as a confident claim.
 */
export function TodaysStorySection({ reasoning }: { reasoning: OperationalReasoning }) {
  const digest = storyDigest(
    reasoning.businessStory,
    reasoning.clusters.map((c) => c.narrative),
  );

  return (
    <section className="cg-sec q-story" aria-labelledby="q-story-h">
      <h2 className="cg-sec__h" id="q-story-h">Today&rsquo;s story</h2>
      <p className="q-story__headline">{digest.headline}</p>
      {digest.bullets.length > 0 ? (
        <ul className="q-story__list">
          {digest.bullets.map((b, i) => <li key={i}>{b}</li>)}
        </ul>
      ) : null}
      {digest.rest || digest.moreCount > 0 ? (
        <details className="q-story__more">
          <summary className="q-story__summary">
            Read more
            {digest.moreCount > 0
              ? ` · ${digest.moreCount} further connection${digest.moreCount === 1 ? '' : 's'}`
              : ''}
          </summary>
          <div className="q-story__body">
            {digest.rest ? <p className="q-story__rest">{digest.rest}</p> : null}
            {digest.moreCount > 0 ? (
              <ul className="q-story__list">
                {reasoning.clusters
                  .slice(digest.bullets.length)
                  .map((c, i) => <li key={i}>{c.narrative}</li>)}
              </ul>
            ) : null}
          </div>
        </details>
      ) : null}
      <p className="q-story__note">
        Composed from measured relationships only. Loop can attribute a change
        arithmetically and follow it through the metric formulas; it cannot observe
        routing, caps, schedules, budgets or demand, so nothing here is a causal
        claim. Reasoning {reasoning.version}.
      </p>
    </section>
  );
}
