// The Executive Queue — the operator's surface for CallGrid Intelligence.
//
// This page is a QUEUE, not a document. It is scanned and cleared, not read top
// to bottom, so the craft here is information design rather than prose: the
// briefing answers "is there a fire" in one line, each row carries a name, a
// number and the decision, and everything else is one expansion away.
//
// THE CONTROLS ARE NOW REAL. Assign, watch, resolve and dismiss write an
// immutable observation and survive a refresh, which is the only condition under
// which they were ever allowed to exist — an operator who presses Ignore and
// sees the item again tomorrow stops pressing buttons, and then stops opening
// the page. Every control here is a `<form>` posting to a guarded server action;
// none of them is decorative, and there is still no button for anything Loop
// cannot actually do.
//
// A ROW THEREFORE SHOWS THREE DIFFERENT KINDS OF THING, and they are never
// styled alike: what was MEASURED (the money, the counts), what Loop READ into
// it (the claim, the chain), and what a HUMAN did about it (owner, status,
// timeline). Collapsing those into one voice is how a product starts sounding
// like it knows more than it does.
//
// Presentational server components only. The expansions are native <details>, so
// inspecting a conclusion costs no client JavaScript.

import Link from 'next/link';
import type {
  Situation, SituationQueue, Briefing, ChainLink,
  PriorityState, DecisionActivity, LifecycleHistory, Rate,
} from '@emgloop/shared';
import {
  ESCALATION_LABEL, REVIEW_URGENCY_LABEL, PRIORITY_STATES, OPERATIONAL_OUTCOMES,
  standingOf,
} from '@emgloop/shared';
import type { OperationalObservation, OperationalPriority } from '@emgloop/database';
import { EvidenceDrawer } from './intelligence-ui';
import type { LivePriority } from './operational-queue-data';
import {
  markReviewedAction, assignAction, watchAction, stopWatchingAction,
  addNoteAction, recordContactAction, recordOutcomeAction,
  resolveAction, dismissAction,
} from './operational-actions';

/** Someone who can own a priority. */
export interface QueueMember {
  id: string;
  name: string | null;
  email: string;
}

/** Money that never dresses an unknown as $0. */
function money(cents: number | null): string {
  if (cents === null) return 'Not quantifiable';
  return (cents < 0 ? '−' : '') + '$' + Math.round(Math.abs(cents) / 100).toLocaleString('en-US');
}

function nameOf(members: QueueMember[], userId: string | null): string {
  if (!userId) return 'Unassigned';
  const m = members.find((x) => x.id === userId);
  return m?.name?.trim() || m?.email || 'Someone no longer on the team';
}

/** Elapsed time in the plainest possible words. */
function since(from: Date | null, now: Date): string | null {
  if (!from) return null;
  const ms = now.getTime() - from.getTime();
  if (ms < 0) return null;
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return 'less than an hour ago';
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.floor(days / 30);
  return `${months} month${months === 1 ? '' : 's'} ago`;
}

function duration(ms: number | null): string | null {
  if (ms === null) return null;
  const hours = Math.round(ms / 3_600_000);
  if (hours < 24) return `${Math.max(1, hours)} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

const STATE_LABEL: Record<PriorityState, string> = {
  NEEDS_REVIEW: 'Needs review',
  ASSIGNED: 'Assigned',
  WATCHING: 'Watching',
  RESOLVED: 'Resolved',
  DISMISSED: 'Dismissed',
};

/**
 * Severity as a rail colour and position, never as the word "Critical".
 *
 * "Critical / High / Notable" is engine vocabulary. What an operator needs is to
 * see at a glance which row is worst — that is form, not a label, and the row's
 * position already carries the ranking. A row somebody owns cools down: it is
 * still important, but it is no longer the reader's problem to pick up.
 */
function railTone(s: Situation, state: PriorityState): string {
  if (state === 'RESOLVED' || state === 'DISMISSED') return 'done';
  if (state === 'ASSIGNED' || state === 'WATCHING') return 'held';
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
  briefing, queue, periodLabel, live, persistenceError,
}: {
  briefing: Briefing;
  queue: SituationQueue;
  periodLabel: string;
  live: boolean;
  persistenceError?: string | null;
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
      {/* A degraded operational record is stated at the top, not discovered by an
          operator wondering why their assignment disappeared. */}
      {persistenceError ? <p className="q-brief__degraded">{persistenceError}</p> : null}
    </section>
  );
}

// --- The lanes ----------------------------------------------------------------------

/**
 * The operating model, made visible — and now filled from the durable record
 * rather than from one analysis run.
 *
 * The counts span every priority this producer has ever opened, not just the
 * selected period's. An item assigned last week and still open is part of the
 * operator's workload today even if the window they are looking at does not
 * contain it, and a lane that emptied because somebody changed a date filter
 * would be actively misleading.
 */
export function LaneBar({
  counts, unavailable,
}: {
  counts: Record<PriorityState, number>;
  unavailable?: boolean;
}) {
  return (
    <section className="q-lanes" aria-label="Queue">
      {PRIORITY_STATES.map((state) => (
        <div className={'q-lane' + (unavailable ? ' q-lane--pending' : '')} key={state}>
          {/* An em dash, never a zero: "0 assigned" and "Loop could not read the
              record" must never look the same. */}
          <span className="q-lane__count">{unavailable ? '—' : counts[state]}</span>
          <span className="q-lane__label">{STATE_LABEL[state]}</span>
          {unavailable ? <span className="q-lane__why">unavailable</span> : null}
        </div>
      ))}
    </section>
  );
}

// --- Decision activity ----------------------------------------------------------------

function RateView({ rate, label }: { rate: Rate; label: string }) {
  return (
    <div className="q-act__item">
      <span className="q-act__num">
        {rate.percent === null ? '—' : `${rate.percent}%`}
      </span>
      <span className="q-act__label">{label}</span>
      <span className="q-act__note">
        {rate.percent === null
          ? rate.unavailableReason
          : `${rate.numerator} of ${rate.denominator}`}
      </span>
    </div>
  );
}

/**
 * What happened BECAUSE of Loop, rather than what happened in the marketplace.
 *
 * This is the only section on the page that measures the product rather than the
 * business, and the false-positive rate is the point of it: a system that never
 * reports how often it was wrong cannot be calibrated by the person relying on
 * it. At launch it will honestly say there is not enough history yet, and that
 * is the correct thing for it to say.
 */
export function DecisionActivitySection({ activity }: { activity: DecisionActivity }) {
  if (activity.total === 0) {
    return (
      <section className="cg-sec q-act" aria-label="Decisions">
        <h2 className="cg-sec__h">Decisions</h2>
        <p className="q-act__empty">
          Nothing has been recorded yet. Once items are assigned, resolved or dismissed,
          this is where Loop reports how its recommendations actually turned out —
          including how often it was wrong.
        </p>
      </section>
    );
  }

  return (
    <section className="cg-sec q-act" aria-label="Decisions">
      <h2 className="cg-sec__h">Decisions</h2>
      <div className="q-act__grid">
        <div className="q-act__item">
          <span className="q-act__num">{activity.open}</span>
          <span className="q-act__label">Still open</span>
          <span className="q-act__note">
            {activity.needsReview} needing review · {activity.assigned} assigned ·{' '}
            {activity.watching} watched
          </span>
        </div>
        <div className="q-act__item">
          <span className="q-act__num">{activity.resolved + activity.dismissed}</span>
          <span className="q-act__label">Closed</span>
          <span className="q-act__note">
            {activity.resolved} resolved · {activity.dismissed} dismissed
          </span>
        </div>
        <div className="q-act__item">
          <span className="q-act__num">
            {activity.measuredEffectCents === null
              ? '—'
              : money(activity.measuredEffectCents)}
          </span>
          <span className="q-act__label">Measured effect</span>
          <span className="q-act__note">
            {activity.measuredEffectCents === null
              ? 'No closed item has recorded a measured amount. This is not $0 — nobody has measured one.'
              : `Typed in by an operator on ${activity.measuredEffectSample} closed item${activity.measuredEffectSample === 1 ? '' : 's'}. Loop never estimates this.`}
          </span>
        </div>
        <RateView rate={activity.falsePositiveRate} label="Loop was wrong" />
        <RateView rate={activity.reopenRate} label="Came back" />
        <div className="q-act__item">
          <span className="q-act__num">{duration(activity.medianResolutionMs) ?? '—'}</span>
          <span className="q-act__label">Typical time to close</span>
          <span className="q-act__note">
            {activity.medianResolutionMs === null
              ? 'Nothing has been closed yet.'
              : `Median of ${activity.medianResolutionSample}. A median, so one straggler cannot define it.`}
          </span>
        </div>
      </div>
      {activity.insufficientHistory ? (
        <p className="q-act__caveat">{activity.insufficientHistory}</p>
      ) : null}
    </section>
  );
}

// --- The timeline -------------------------------------------------------------------

const OBSERVATION_LABEL: Record<string, string> = {
  SITUATION_DETECTED: 'Loop first saw this',
  SITUATION_RESIGHTED: 'Still happening',
  REOPENED: 'Came back after being closed',
  REVIEWED: 'Reviewed',
  ASSIGNED: 'Assigned',
  OWNER_CHANGED: 'Owner changed',
  WATCH_STARTED: 'Watching',
  WATCH_STOPPED: 'Stopped watching',
  NOTE_ADDED: 'Note',
  CONTACT_ATTEMPTED: 'Tried to make contact',
  CONTACT_COMPLETED: 'Made contact',
  AWAITING_RESPONSE: 'Waiting for a response',
  RESPONSE_RECEIVED: 'Got a response',
  ESCALATED: 'Escalated',
  OUTCOME_RECORDED: 'Outcome recorded',
  RESOLVED: 'Resolved',
  DISMISSED: 'Dismissed',
};

const OUTCOME_LABEL: Record<string, string> = {
  RECOVERED: 'Recovered',
  PARTIALLY_RECOVERED: 'Partly recovered',
  NOT_RECOVERED: 'Not recovered',
  NO_ACTION_NEEDED: 'No action was needed',
  FALSE_POSITIVE: 'Loop should not have raised it',
  ACCEPTED_RISK: 'Real, and accepted',
  NOT_ACTIONABLE: 'Real, and nothing could be done',
  UNKNOWN: 'Outcome unknown',
};

function stamp(d: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(d);
}

/**
 * The history, in the order it happened.
 *
 * Sorted by `occurredAt` for reading, which is deliberately NOT how state is
 * computed — a backdated note belongs where it happened on a timeline and at the
 * end of the log for the purposes of deciding what the current state is. Both are
 * correct; conflating them is not.
 */
function Timeline({ log, members }: { log: OperationalObservation[]; members: QueueMember[] }) {
  if (log.length === 0) return null;
  const ordered = [...log].sort(
    (a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.sequence - b.sequence,
  );
  return (
    <div className="q-time">
      <p className="q-time__h">History</p>
      <ol className="q-time__list">
        {ordered.map((o) => (
          <li className={'q-time__item q-time__item--' + o.actorType.toLowerCase()} key={o.id}>
            <span className="q-time__when">{stamp(o.occurredAt)}</span>
            <span className="q-time__what">
              {OBSERVATION_LABEL[o.observationType] ?? o.observationType}
              {o.assignedToUserId ? ` → ${nameOf(members, o.assignedToUserId)}` : ''}
            </span>
            <span className="q-time__who">
              {o.actorType === 'SYSTEM' ? 'Loop' : nameOf(members, o.actorUserId)}
            </span>
            {o.outcome ? (
              <span className="q-time__outcome">{OUTCOME_LABEL[o.outcome] ?? o.outcome}</span>
            ) : null}
            {o.measuredEffectCents !== null ? (
              <span className="q-time__effect">
                {money(o.measuredEffectCents)}
                {o.measuredEffectBasis ? ` · ${o.measuredEffectBasis}` : ''}
              </span>
            ) : null}
            {o.note ? <span className="q-time__note">{o.note}</span> : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

// --- The controls -------------------------------------------------------------------

function HiddenFields({ priorityId, returnTo }: { priorityId: string; returnTo: string }) {
  return (
    <>
      <input type="hidden" name="priorityId" value={priorityId} />
      <input type="hidden" name="returnTo" value={returnTo} />
    </>
  );
}

/**
 * The decision controls.
 *
 * Ordered by what an operator actually does most: take it, watch it, close it.
 * Resolving and dismissing ask for an outcome, because the outcome is the entire
 * feedback loop — "dismissed" alone tells Loop nothing, while "Loop should not
 * have raised it" tells it everything.
 */
function ActionBar({
  item, members, returnTo,
}: {
  item: LivePriority;
  members: QueueMember[];
  returnTo: string;
}) {
  const id = item.record?.id;
  if (!id) {
    return (
      <p className="q-act-note">
        This item could not be written to the operational record, so it cannot be
        assigned or resolved right now. Nothing you do here would survive a refresh,
        so the controls are hidden rather than shown inert.
      </p>
    );
  }

  const closed = item.state === 'RESOLVED' || item.state === 'DISMISSED';

  return (
    <div className="q-do">
      {!closed ? (
        <>
          <form action={assignAction} className="q-do__row">
            <HiddenFields priorityId={id} returnTo={returnTo} />
            <label className="q-do__lbl" htmlFor={`a-${id}`}>Owner</label>
            <select className="q-do__sel" id={`a-${id}`} name="assignedToUserId" required
              defaultValue={item.ownerUserId ?? ''}>
              <option value="" disabled>Choose someone</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>{m.name?.trim() || m.email}</option>
              ))}
            </select>
            <button className="q-do__btn q-do__btn--primary" type="submit">
              {item.ownerUserId ? 'Change owner' : 'Assign'}
            </button>
          </form>

          <div className="q-do__row">
            {item.state !== 'WATCHING' ? (
              <form action={watchAction}>
                <HiddenFields priorityId={id} returnTo={returnTo} />
                <button className="q-do__btn" type="submit">Watch</button>
              </form>
            ) : (
              <form action={stopWatchingAction}>
                <HiddenFields priorityId={id} returnTo={returnTo} />
                <button className="q-do__btn" type="submit">Stop watching</button>
              </form>
            )}
            <form action={markReviewedAction}>
              <HiddenFields priorityId={id} returnTo={returnTo} />
              <button className="q-do__btn" type="submit" title="Records that you looked. Does not clear it from the queue — only a decision does that.">
                Mark reviewed
              </button>
            </form>
            <form action={recordContactAction} className="q-do__inline">
              <HiddenFields priorityId={id} returnTo={returnTo} />
              <input type="hidden" name="reached" value="yes" />
              <button className="q-do__btn" type="submit">Made contact</button>
            </form>
            <form action={recordContactAction} className="q-do__inline">
              <HiddenFields priorityId={id} returnTo={returnTo} />
              <input type="hidden" name="reached" value="no" />
              <button className="q-do__btn" type="submit">Tried, no answer</button>
            </form>
          </div>
        </>
      ) : null}

      <details className="q-do__more">
        <summary className="q-do__summary">
          {closed ? 'Record something else' : 'Close this out'}
        </summary>
        <div className="q-do__panel">
          <form action={resolveAction} className="q-do__form">
            <HiddenFields priorityId={id} returnTo={returnTo} />
            <p className="q-do__formh">Resolve</p>
            <label className="q-do__lbl" htmlFor={`o-${id}`}>What happened</label>
            <select className="q-do__sel" id={`o-${id}`} name="outcome" defaultValue="UNKNOWN">
              {OPERATIONAL_OUTCOMES.map((o) => (
                <option key={o} value={o}>{OUTCOME_LABEL[o] ?? o}</option>
              ))}
            </select>
            <label className="q-do__lbl" htmlFor={`e-${id}`}>
              Measured effect, if you measured one
            </label>
            <input className="q-do__in" id={`e-${id}`} name="effectDollars" inputMode="decimal"
              placeholder="e.g. 1980" />
            <input className="q-do__in" name="effectBasis" maxLength={200}
              placeholder="Where that figure came from" />
            <input className="q-do__in" name="note" maxLength={500} placeholder="Note (optional)" />
            <p className="q-do__hint">
              Leave the amount blank if nobody measured one. Loop will report it as
              unmeasured rather than as $0, and it will never estimate it for you.
            </p>
            <button className="q-do__btn q-do__btn--primary" type="submit">Resolve</button>
          </form>

          <form action={dismissAction} className="q-do__form">
            <HiddenFields priorityId={id} returnTo={returnTo} />
            <p className="q-do__formh">Dismiss</p>
            <label className="q-do__lbl" htmlFor={`d-${id}`}>Why</label>
            <select className="q-do__sel" id={`d-${id}`} name="outcome" defaultValue="FALSE_POSITIVE">
              <option value="FALSE_POSITIVE">{OUTCOME_LABEL.FALSE_POSITIVE}</option>
              <option value="NO_ACTION_NEEDED">{OUTCOME_LABEL.NO_ACTION_NEEDED}</option>
              <option value="ACCEPTED_RISK">{OUTCOME_LABEL.ACCEPTED_RISK}</option>
              <option value="NOT_ACTIONABLE">{OUTCOME_LABEL.NOT_ACTIONABLE}</option>
              <option value="UNKNOWN">{OUTCOME_LABEL.UNKNOWN}</option>
            </select>
            <input className="q-do__in" name="note" maxLength={500} placeholder="Note (optional)" />
            <p className="q-do__hint">
              This is how Loop learns whether it was right. Saying it should not
              have raised something is the most useful answer here, not the harshest.
            </p>
            <button className="q-do__btn" type="submit">Dismiss</button>
          </form>

          <form action={recordOutcomeAction} className="q-do__form">
            <HiddenFields priorityId={id} returnTo={returnTo} />
            <p className="q-do__formh">Record an outcome without closing</p>
            <select className="q-do__sel" name="outcome" defaultValue="UNKNOWN">
              {OPERATIONAL_OUTCOMES.map((o) => (
                <option key={o} value={o}>{OUTCOME_LABEL[o] ?? o}</option>
              ))}
            </select>
            <input className="q-do__in" name="effectDollars" inputMode="decimal"
              placeholder="Measured effect, e.g. 1980" />
            <input className="q-do__in" name="effectBasis" maxLength={200}
              placeholder="Where that figure came from" />
            <button className="q-do__btn" type="submit">Record</button>
          </form>

          <form action={addNoteAction} className="q-do__form">
            <HiddenFields priorityId={id} returnTo={returnTo} />
            <p className="q-do__formh">Add a note</p>
            <input className="q-do__in" name="note" maxLength={500} required
              placeholder="What you found or did" />
            <button className="q-do__btn" type="submit">Add</button>
          </form>
        </div>
      </details>
    </div>
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
 * The durable facts: how long this has been known, who has it, how it has gone
 * before.
 *
 * This is the block the whole branch exists to make possible. Before there was a
 * record, every one of these lines had to say "Loop does not remember"; now
 * "third time in six weeks" is a measured fact, and it changes what an operator
 * does far more than the severity band above it does.
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

  return (
    <dl className="q-standing">
      <div>
        <dt>Status</dt>
        <dd>
          {STATE_LABEL[item.state]}
          {item.ownerUserId ? ` · ${nameOf(members, item.ownerUserId)}` : ''}
        </dd>
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
 * One queue row: rank, name, verdict, money, the decision, one line of why.
 *
 * A card invites reading; a row invites choosing. The operator picks one and
 * opens it, so the closed state carries only what is needed to choose — plus,
 * now, who has it, because "somebody already owns this" is the single most
 * useful thing to know before reading any further.
 */
export function SituationRow({
  item, rank, entityHref, members, canAct, returnTo, now,
}: {
  item: LivePriority;
  rank: number;
  entityHref: string | null;
  members: QueueMember[];
  canAct: boolean;
  returnTo: string;
  now: Date;
}) {
  const s = item.situation;
  const owned = item.state === 'ASSIGNED' || item.state === 'WATCHING';
  const closed = item.state === 'RESOLVED' || item.state === 'DISMISSED';

  return (
    <article className={'q-row q-row--' + railTone(s, item.state)} aria-label={s.title}>
      <div className="q-row__rail" aria-hidden="true" />
      <div className="q-row__body">
        <div className="q-row__top">
          <span className="q-row__rank" aria-hidden="true">{rank}</span>
          <h3 className="q-row__title">{s.title}</h3>
          {/* Once somebody owns it, the engine's urgency stops being the headline —
              the human fact outranks it. */}
          {owned || closed ? (
            <span className={'q-row__state q-row__state--' + item.state.toLowerCase()}>
              {STATE_LABEL[item.state]}
              {item.ownerUserId ? ` · ${nameOf(members, item.ownerUserId)}` : ''}
            </span>
          ) : (
            <span className="q-row__verdict">{verdictOf(s)}</span>
          )}
          {item.reopenCount > 0 ? (
            <span className="q-row__back" title="This was closed and came back">
              back {item.reopenCount}×
            </span>
          ) : null}
          {item.detectionCount > 1 ? (
            <span className="q-row__seen">seen {item.detectionCount}×</span>
          ) : null}
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

        {canAct ? (
          <ActionBar item={item} members={members} returnTo={returnTo} />
        ) : (
          <p className="q-act-note">
            You have view-only access to intelligence, so the decision controls are
            not shown. An owner or admin can assign, resolve or dismiss this.
          </p>
        )}

        <details className="q-row__more">
          <summary className="q-row__summary">Show me why</summary>
          <div className="q-row__detail">
            <StandingBlock item={item} members={members} now={now} />

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
              {/* Two different questions, answered by two different sources and
                  never merged into one confident-sounding verdict. The analysis
                  reads one window and can only observe spreading; how often this
                  has been seen, and whether a resolution failed to hold, are facts
                  about the record. Showing only the first would have Loop report
                  "not established" beside a row that says "seen 12 times". */}
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

            <Timeline log={item.log} members={members} />

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
 *
 * Items already owned or already closed sink below the ones that still need a
 * decision, regardless of how the engine ranked them: the queue's job is to show
 * what is UNDECIDED, and a critical item somebody is already handling is not the
 * reader's next action.
 */
export function QueueSection({
  items, emptyReason, limit = 3, hrefFor, members, canAct, returnTo, now,
}: {
  items: LivePriority[];
  emptyReason: string | null;
  limit?: number;
  hrefFor: (s: Situation) => string | null;
  members: QueueMember[];
  canAct: boolean;
  returnTo: string;
  now: Date;
}) {
  const undecided = items.filter((i) => i.state === 'NEEDS_REVIEW');
  const handled = items.filter((i) => i.state !== 'NEEDS_REVIEW');
  const shown = undecided.slice(0, limit);
  const held = undecided.length - shown.length;

  if (items.length === 0) {
    return (
      <section className="q-empty" aria-label="Nothing needs attention">
        <p className="q-empty__text">{emptyReason}</p>
      </section>
    );
  }

  return (
    <div className="q-queue">
      {shown.length === 0 ? (
        <section className="q-empty" aria-label="Nothing undecided">
          <p className="q-empty__text">
            Everything Loop found this period has been decided on. {handled.length} item
            {handled.length === 1 ? ' is' : 's are'} owned, watched or closed below.
          </p>
        </section>
      ) : null}

      {shown.map((item, i) => (
        <SituationRow
          key={item.situation.id}
          item={item}
          rank={i + 1}
          entityHref={hrefFor(item.situation)}
          members={members}
          canAct={canAct}
          returnTo={returnTo}
          now={now}
        />
      ))}

      {held > 0 ? (
        <p className="q-held">
          {held} more undecided
          {' · '}
          <span className="q-held__note">
            Loop surfaces at most {limit} so the list stays a decision rather than a report.
          </span>
        </p>
      ) : null}

      {handled.length > 0 ? (
        <details className="q-handled">
          <summary className="q-handled__summary">
            {handled.length} already decided this period
          </summary>
          <div className="q-handled__body">
            {handled.map((item, i) => (
              <SituationRow
                key={item.situation.id}
                item={item}
                rank={shown.length + i + 1}
                entityHref={hrefFor(item.situation)}
                members={members}
                canAct={canAct}
                returnTo={returnTo}
                now={now}
              />
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

// --- Open work ----------------------------------------------------------------------

/**
 * What is open right now, regardless of the selected period.
 *
 * Without this the queue would lie by omission: an item assigned last Tuesday
 * that this period's analysis no longer surfaces is still somebody's open work,
 * and letting it disappear because the operator changed a date filter is how a
 * queue quietly loses the thing it was for.
 */
export function OpenWorkSection({
  openWork, members, now,
}: {
  openWork: OperationalPriority[];
  members: QueueMember[];
  now: Date;
}) {
  if (openWork.length === 0) return null;
  return (
    <section className="cg-sec q-open-work" aria-label="Open work">
      <h2 className="cg-sec__h">Open work</h2>
      <p className="cg-sec__sub">
        Everything currently owned or watched, whichever period it was found in.
      </p>
      <ul className="q-ow__list">
        {openWork.map((p) => (
          <li className="q-ow__item" key={p.id}>
            <span className="q-ow__title">{p.title}</span>
            <span className="q-ow__who">
              {STATE_LABEL[p.state as PriorityState]}
              {p.ownerUserId ? ` · ${nameOf(members, p.ownerUserId)}` : ''}
            </span>
            <span className="q-ow__age">
              {p.stateChangedAt ? since(p.stateChangedAt, now) : since(p.firstDetectedAt, now)}
            </span>
            <span className="q-ow__money">
              {p.impactCents === null ? '' : money(p.impactCents)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
