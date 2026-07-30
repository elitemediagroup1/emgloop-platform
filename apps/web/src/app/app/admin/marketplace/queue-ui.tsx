// The Executive Queue — the operator's surface for CallGrid Intelligence.
//
// This page is a QUEUE, not a document. It is scanned and cleared, not read
// top to bottom, so the craft here is information design rather than prose: the
// briefing answers "is there a fire" in one line, each row carries a name, a
// number and the decision, and everything else is one expansion away.
//
// WHAT IS DELIBERATELY ABSENT: there are no state-changing controls. Assign,
// Watch, Ignore and Resolve are the point of the queue, and every one of them is
// a state that must survive a refresh. Loop does not yet remember operator
// decisions, so rendering those buttons would be a control that looks live and
// does nothing — the fabricated-functionality failure this repository forbids,
// and the specific failure mode that trains an operator to stop pressing
// buttons. The lanes therefore state why they cannot fill, and the actions
// arrive with the persistence that makes them true.
//
// Presentational server components only. The expansions are native <details>, so
// inspecting a conclusion costs no client JavaScript.

import Link from 'next/link';
import type {
  Situation, SituationQueue, Briefing, LaneAvailability, ChainLink,
} from '@emgloop/shared';
import { ESCALATION_LABEL, REVIEW_URGENCY_LABEL } from '@emgloop/shared';
import { EvidenceDrawer } from './intelligence-ui';

/** Money that never dresses an unknown as $0. */
function money(cents: number | null): string {
  if (cents === null) return 'Not quantifiable';
  return (cents < 0 ? '−' : '') + '$' + Math.round(Math.abs(cents) / 100).toLocaleString('en-US');
}

/**
 * Severity as a rail colour and position, never as the word "Critical".
 *
 * "Critical / High / Notable" is engine vocabulary. What an operator needs is to
 * see at a glance which row is worst — that is form, not a label, and the row's
 * position already carries the ranking.
 */
function railTone(s: Situation): string {
  if (s.reviewPriority === 'IMMEDIATE' || s.reviewPriority === 'TODAY') return 'fire';
  if (s.reviewPriority === 'THIS_WEEK') return 'warn';
  return 'calm';
}

/** The one-line verdict that replaces a severity badge. */
function verdictOf(s: Situation): string {
  switch (s.reviewPriority) {
    case 'IMMEDIATE': return 'Needs you now';
    case 'TODAY': return 'Needs you today';
    case 'THIS_WEEK': return 'This week';
    case 'MONITOR': return 'Worth watching';
    default: return 'No action today';
  }
}

// --- The briefing ------------------------------------------------------------------

/**
 * The first thing on the screen and the last thing to be cut.
 *
 * It answers "is there a fire" before anything else, then says which item to
 * start with and why. A COO does not just list; they sequence, and the reason
 * for the sequence is the single most valuable string here.
 */
export function BriefingBlock({
  briefing, queue, periodLabel, live,
}: {
  briefing: Briefing;
  queue: SituationQueue;
  periodLabel: string;
  live: boolean;
}) {
  return (
    <section className="q-brief" aria-label="Briefing">
      <p className="q-brief__period">
        {periodLabel}
        {live ? <span className="q-brief__live"> · still in progress</span> : null}
      </p>
      <p className="q-brief__opener">{briefing.opener}</p>
      {briefing.sequencing ? <p className="q-brief__seq">{briefing.sequencing}</p> : null}
      {briefing.measuredImpactCents !== null ? (
        <p className="q-brief__total">
          <span className="q-brief__totalnum">{money(briefing.measuredImpactCents)}</span>
          <span className="q-brief__totallabel">
            measured across {queue.situations.length} item{queue.situations.length === 1 ? '' : 's'}
            {briefing.unpricedCount > 0
              ? ` · ${briefing.unpricedCount} carr${briefing.unpricedCount === 1 ? 'ies' : 'y'} no amount Loop can measure`
              : ''}
          </span>
        </p>
      ) : null}
    </section>
  );
}

// --- The lanes ----------------------------------------------------------------------

/**
 * The operating model, made visible.
 *
 * A lane that is permanently empty for an unstated reason reads as a broken
 * product, so an unavailable lane says what it is waiting for. This is the same
 * honesty rule the metrics follow — "0" and "not measurable" must never look
 * alike.
 */
export function LaneBar({ queue }: { queue: SituationQueue }) {
  return (
    <section className="q-lanes" aria-label="Queue">
      {queue.lanes.map((lane: LaneAvailability) => (
        <div
          className={'q-lane' + (lane.available ? '' : ' q-lane--pending')}
          key={lane.state}
        >
          <span className="q-lane__count">
            {lane.available ? queue.counts[lane.state] : '—'}
          </span>
          <span className="q-lane__label">{lane.label}</span>
          {lane.unavailableReason ? (
            <span className="q-lane__why" title={lane.unavailableReason}>
              not yet tracked
            </span>
          ) : null}
        </div>
      ))}
    </section>
  );
}

// --- One row ------------------------------------------------------------------------

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
        <div>
          <dt>Because</dt>
          <dd>{r.because}</dd>
        </div>
        <div>
          <dt>What argues against it</dt>
          <dd>{r.arguesAgainst}</dd>
        </div>
        <div>
          <dt>What Loop can&rsquo;t see</dt>
          <dd>{r.cannotSee}</dd>
        </div>
        <div>
          <dt>What would change this read</dt>
          <dd>{r.wouldChange}</dd>
        </div>
      </dl>
    </div>
  );
}

/**
 * One queue row: rank, name, verdict, money, the decision, one line of why.
 *
 * A card invites reading; a row invites choosing. The operator picks one and
 * opens it, so the closed state carries only what is needed to choose.
 */
export function SituationRow({
  situation, rank, entityHref,
}: {
  situation: Situation;
  rank: number;
  entityHref: string | null;
}) {
  const s = situation;
  return (
    <article className={'q-row q-row--' + railTone(s)} aria-label={s.title}>
      <div className="q-row__rail" aria-hidden="true" />
      <div className="q-row__body">
        <div className="q-row__top">
          <span className="q-row__rank" aria-hidden="true">{rank}</span>
          <h3 className="q-row__title">{s.title}</h3>
          <span className="q-row__verdict">{verdictOf(s)}</span>
          {s.observationCount > 1 ? (
            <span className="q-row__merged" title="Loop merged related observations into one item">
              {s.observationCount} observations
            </span>
          ) : null}
        </div>

        <p className="q-row__money">{money(s.impact.amountCents)}</p>
        <p className="q-row__moneylabel">{s.impact.label.toLowerCase()}</p>

        {s.decision ? <p className="q-row__decision">{s.decision}</p> : null}
        <p className="q-row__why">{s.whyItMatters}</p>

        <details className="q-row__more">
          <summary className="q-row__summary">Show me why</summary>
          <div className="q-row__detail">
            <dl className="q-detail">
              <div>
                <dt>What happened</dt>
                <dd>{s.whatHappened}</dd>
              </div>
              <div>
                <dt>Impact</dt>
                <dd>
                  <span className="q-detail__money">{money(s.impact.amountCents)}</span>
                  <span className="q-detail__note">{s.impact.statement}</span>
                </dd>
              </div>
              <div>
                <dt>How bad</dt>
                <dd>
                  <span className="q-detail__esc">{ESCALATION_LABEL[s.escalation.state]}</span>
                  <span className="q-detail__note">{s.escalation.basis}</span>
                </dd>
              </div>
              {s.ifIgnored ? (
                <div>
                  <dt>If nothing changes</dt>
                  <dd>{s.ifIgnored}</dd>
                </div>
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

            {/* The merge stays reversible: the reader can always see the
                observations Loop combined, individually. */}
            {s.observationCount > 1 ? (
              <details className="q-obs">
                <summary className="q-obs__summary">
                  The {s.observationCount} observations separately
                </summary>
                <div className="q-obs__body">
                  {s.observations.map((o) => (
                    <div className="q-obs__item" key={o.id}>
                      <p className="q-obs__title">{o.title}</p>
                      <p className="q-obs__sum">{o.plainLanguageSummary}</p>
                      <EvidenceDrawer finding={o} />
                    </div>
                  ))}
                </div>
              </details>
            ) : (
              <EvidenceDrawer finding={s.observations[0]!} />
            )}

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
      </div>
    </article>
  );
}

// --- The queue ----------------------------------------------------------------------

/**
 * The queue itself, cut to a handful.
 *
 * THREE IS A CEILING, NOT A TARGET. A quiet period yields fewer and a period
 * with nothing evidence-backed yields none — and "N more tracked, none urgent"
 * is what makes the cut read as judgment rather than as a limitation.
 */
export function QueueSection({
  queue, limit = 3, hrefFor,
}: {
  queue: SituationQueue;
  limit?: number;
  hrefFor: (s: Situation) => string | null;
}) {
  const shown = queue.situations.slice(0, limit);
  const held = queue.situations.length - shown.length;

  if (shown.length === 0) {
    return (
      <section className="q-empty" aria-label="Nothing needs attention">
        <p className="q-empty__text">{queue.emptyReason}</p>
      </section>
    );
  }

  return (
    <div className="q-queue">
      {shown.map((s, i) => (
        <SituationRow key={s.id} situation={s} rank={i + 1} entityHref={hrefFor(s)} />
      ))}
      {held > 0 ? (
        <p className="q-held">
          {held} more tracked, {shown.length === queue.situations.length ? '' : 'none urgent'}
          {' · '}
          <span className="q-held__note">
            Loop surfaces at most {limit} so the list stays a decision rather than a report.
          </span>
        </p>
      ) : null}
      {/* Stated once, at the foot of the queue rather than as six dead buttons on
          every row. An action that cannot survive a refresh is not an action. */}
      <p className="q-actions-note">
        Assigning, watching, dismissing and resolving arrive with the decision
        lifecycle — Loop does not yet remember operator decisions between visits,
        so those controls are not shown rather than shown inert.
      </p>
    </div>
  );
}
