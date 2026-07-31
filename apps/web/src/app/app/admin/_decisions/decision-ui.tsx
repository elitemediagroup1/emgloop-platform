// The Decision Center's PLATFORM components.
//
// WHY THIS FOLDER EXISTS. The Decision Engine, the contract, the persistence and
// the events are already producer-neutral; the experience was not. Every part of
// it lived inside `marketplace/`, so the second producer — CRM, Accounting,
// Website Intelligence — would have had to either import from a CallGrid folder
// or fork the surface. Forking is how this repo got three workflow systems.
//
// So the split is by COUPLING, not by convenience. Everything in this file takes
// platform types (`OperationalPriority`, `OperationalObservation`, `PriorityState`,
// counts, names, strings) and knows nothing about calls, buyers, bids or
// CallGrid. Everything that reads a `Situation` — the card body, the queue's
// ranking, the evidence chain — stays in `marketplace/queue-ui.tsx`, because
// `Situation` IS a CallGrid type and pretending otherwise would be a fake
// abstraction rather than a real one.
//
// WHAT IS HONESTLY STILL COUPLED, so nobody mistakes this for finished:
//   · the card body reads `Situation` (claim, chain, escalation, read)
//   · evidence rendering is injected as a prop, because the drawer is CallGrid's
//   · the route is still /app/admin/marketplace
// When a second producer publishes decisions, the move to /app/admin/decisions
// should be a file move plus a card body that reads the canonical Decision
// contract. It is deliberately NOT that today — see `decision-contract.ts`, where
// half the fields an interesting card would want are still RESERVED.
//
// Presentational server components only. Every expansion is a native <details>
// and every control is a <form> posting to a guarded server action, so
// inspecting or deciding costs no client JavaScript.

import type { ReactNode } from 'react';
import type {
  PriorityState, DecisionActivity, Rate, LifecycleHistory,
  UnknownGroup, Ownership, OutcomeChoiceGroup,
} from '@emgloop/shared';
import { PRIORITY_STATES, priorClosure } from '@emgloop/shared';
import type { OperationalObservation, OperationalPriority } from '@emgloop/database';

/** Someone who can own a decision. */
export interface QueueMember {
  id: string;
  name: string | null;
  email: string;
}

// --- Vocabulary ---------------------------------------------------------------

export const STATE_LABEL: Record<PriorityState, string> = {
  NEEDS_REVIEW: 'Needs review',
  ASSIGNED: 'Assigned',
  WATCHING: 'Watching',
  RESOLVED: 'Resolved',
  DISMISSED: 'Dismissed',
};

export const OUTCOME_LABEL: Record<string, string> = {
  RECOVERED: 'Recovered',
  PARTIALLY_RECOVERED: 'Partly recovered',
  NOT_RECOVERED: 'Not recovered',
  NO_ACTION_NEEDED: 'No action was needed',
  FALSE_POSITIVE: 'Loop should not have raised it',
  ACCEPTED_RISK: 'Real, and accepted',
  NOT_ACTIONABLE: 'Real, and nothing could be done',
  DUPLICATE: 'Already tracked elsewhere',
  MERGED: 'Merged into another decision',
  SUPPRESSED: 'Suppressed',
  EXPIRED: 'Stopped on its own',
  CONVERTED_TO_WORK: 'Became work elsewhere',
  UNKNOWN: 'Outcome unknown',
};

export const OBSERVATION_LABEL: Record<string, string> = {
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

export function outcomeLabel(outcome: string): string {
  return OUTCOME_LABEL[outcome] ?? outcome;
}

// --- Formatting ---------------------------------------------------------------

/** Money that never dresses an unknown as $0. */
export function money(cents: number | null): string {
  if (cents === null) return 'Not quantifiable';
  return (cents < 0 ? '−' : '') + '$' + Math.round(Math.abs(cents) / 100).toLocaleString('en-US');
}

export function nameOf(members: QueueMember[], userId: string | null): string | null {
  if (!userId) return null;
  const m = members.find((x) => x.id === userId);
  return m?.name?.trim() || m?.email || 'Someone no longer on the team';
}

/** Elapsed time in the plainest possible words. */
export function since(from: Date | null, now: Date): string | null {
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

export function duration(ms: number | null): string | null {
  if (ms === null) return null;
  const hours = Math.round(ms / 3_600_000);
  if (hours < 24) return `${Math.max(1, hours)} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

export function stamp(d: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(d);
}

/**
 * Time-of-day greeting in the operator's business timezone.
 *
 * Deliberately NOT `_loop-os/greeting()`, which reads `new Date().getHours()` on
 * the server. Production runs UTC, so that function greets a Florida operator
 * with "Good morning" at 8pm. Every other timestamp on this surface is Eastern;
 * this one matches.
 */
export function greetingAt(now: Date): string {
  const hour = Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour: 'numeric', hour12: false,
    }).format(now),
  );
  if (!Number.isFinite(hour)) return 'Good day';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

// --- The mission brief --------------------------------------------------------

/** One thing the operator should look at, named and priced. */
export interface BriefFocus {
  kind: 'RISK' | 'OPPORTUNITY';
  title: string;
  /** Already formatted, or null when nothing was measurable. */
  amount: string | null;
  /** What the amount MEANS. An unlabelled number is a guess with a font size. */
  amountLabel: string | null;
  href: string | null;
}

export interface BriefCounts {
  needsDecision: number;
  assigned: number;
  watching: number;
  closed: number;
}

/**
 * The first five seconds.
 *
 * Answers "what kind of day is this", then names the biggest risk, the biggest
 * opportunity and which item to start with. Every clause is sourced: the verdict
 * from the health model (which returns UNKNOWN rather than HEALTHY when it cannot
 * measure), the counts from the operational record, the two focus cards from
 * findings the engine already ranked.
 *
 * DELIBERATELY ABSENT — and worth restating every time this file is edited:
 *
 *   · No "overdue" count. Nothing carries a due date; `dueAt` is RESERVED in the
 *     decision contract with no column and no writer. A zero there would be the
 *     one invented number on a page built to have none.
 *   · No estimated review time. Nothing measures how long a review takes.
 *   · No claim of authorship. No model wrote any of this; it is deterministic
 *     template language, and implying otherwise is the fake-AI failure by name.
 */
export function MissionBrief({
  greeting, operatorName, verdictBand, verdictLine, verdictWhy,
  counts, measured, unmeasurableCount, focus, recommendation,
  periodLabel, live, updatedLabel, persistenceError, queueHref = '#decision-queue',
}: {
  greeting: string;
  operatorName: string | null;
  /** Lowercased by the caller's model, used only for tone. UNKNOWN stays UNKNOWN. */
  verdictBand: string;
  verdictLine: string;
  verdictWhy: string;
  counts: BriefCounts;
  measured: string | null;
  unmeasurableCount: number;
  focus: BriefFocus[];
  recommendation: string | null;
  periodLabel: string;
  live: boolean;
  updatedLabel: string;
  persistenceError?: string | null;
  queueHref?: string;
}) {
  const band = verdictBand.toLowerCase();
  return (
    <section className="xb" aria-labelledby="xb-verdict">
      <div className="xb__top">
        <p className="xb__greet">
          {greeting}{operatorName ? `, ${operatorName}` : ''}.
        </p>
        <span className={'xb__pulse xb__pulse--' + (live ? 'live' : 'done')}>
          <span className="xb__dot" aria-hidden="true" />
          {live ? 'Live' : 'Completed'} · {periodLabel} · updated {updatedLabel}
        </span>
      </div>

      {/* The verdict. Shape carries the band as well as colour, so the health of
          the business is legible in greyscale and to anyone who cannot separate
          red from amber. */}
      <div className={'xb__verdictrow xb__verdictrow--' + band}>
        <span className="xb__glyph" aria-hidden="true" />
        <p className="xb__verdict" id="xb-verdict">
          {verdictLine}
          <span className="xb__verdictwhy">{verdictWhy}</span>
        </p>
      </div>

      <div className="xb__counts">
        <span className="xb__count xb__count--lead">
          <b>{counts.needsDecision}</b> need a decision
        </span>
        <span className="xb__count"><b>{counts.assigned}</b> assigned</span>
        <span className="xb__count"><b>{counts.watching}</b> watched</span>
        <span className="xb__count xb__count--muted"><b>{counts.closed}</b> closed</span>
        {measured ? (
          <span className="xb__count xb__count--money">
            <b>{measured}</b> measured across them
            {unmeasurableCount > 0 ? ` · ${unmeasurableCount} not quantifiable` : ''}
          </span>
        ) : null}
      </div>

      {focus.length > 0 ? (
        <div className="xb__focus">
          {focus.map((f) => (
            <FocusCard focus={f} key={f.kind + f.title} />
          ))}
        </div>
      ) : null}

      {/* The single most valuable sentence on the page: not what is wrong, but
          which one to start with and why. A COO sequences; they do not list. */}
      {recommendation ? (
        <div className="xb__start">
          <p className="xb__startlabel">Start here</p>
          <p className="xb__starttext">{recommendation}</p>
          <a className="xb__cta" href={queueHref}>Open the queue →</a>
        </div>
      ) : null}

      {persistenceError ? (
        <p className="xb__degraded" role="status">{persistenceError}</p>
      ) : null}
    </section>
  );
}

function FocusCard({ focus }: { focus: BriefFocus }) {
  const label = focus.kind === 'RISK' ? "Today's biggest risk" : "Today's biggest opportunity";
  const body = (
    <>
      <span className="xb__focuslabel">{label}</span>
      <span className="xb__focustitle">{focus.title}</span>
      {focus.amount ? (
        <span className="xb__focusamt">
          {focus.amount}
          {focus.amountLabel ? <span className="xb__focusbasis">{focus.amountLabel}</span> : null}
        </span>
      ) : (
        <span className="xb__focusamt xb__focusamt--none">
          Not quantifiable
          <span className="xb__focusbasis">no measured amount</span>
        </span>
      )}
    </>
  );
  const cls = 'xb__focuscard xb__focuscard--' + focus.kind.toLowerCase();
  return focus.href
    ? <a className={cls} href={focus.href}>{body}</a>
    : <div className={cls}>{body}</div>;
}

// --- The lanes ----------------------------------------------------------------

/**
 * The operating model, made visible — work on the left, archive on the right.
 *
 * Five equal chips said nothing about which of them is the operator's problem.
 * The open lanes now carry the weight; closed ones sit past a divider as a
 * record. The counts span every decision this producer has ever opened, not just
 * the selected period's: an item assigned last week is part of today's workload
 * even if today's window does not contain it, and a lane that emptied because
 * somebody changed a date filter would be actively misleading.
 */
const OPEN_LANES: readonly PriorityState[] = ['NEEDS_REVIEW', 'ASSIGNED', 'WATCHING'];

export function LaneRail({
  counts, unavailable,
}: {
  counts: Record<PriorityState, number>;
  unavailable?: boolean;
}) {
  const value = (state: PriorityState) => (unavailable ? '—' : String(counts[state]));
  return (
    <section className="q-lanes" aria-label="Decision lanes">
      {PRIORITY_STATES.map((state) => {
        const open = OPEN_LANES.includes(state);
        return (
          <div
            className={
              'q-lane q-lane--' + state.toLowerCase()
              + (open ? ' q-lane--open' : ' q-lane--closed')
              + (unavailable ? ' q-lane--pending' : '')
            }
            key={state}
          >
            {/* An em dash, never a zero: "0 assigned" and "Loop could not read
                the record" must never look the same. */}
            <span className="q-lane__count">{value(state)}</span>
            <span className="q-lane__label">{STATE_LABEL[state]}</span>
            {unavailable ? <span className="q-lane__why">unavailable</span> : null}
          </div>
        );
      })}
    </section>
  );
}

// --- Confidence ---------------------------------------------------------------

/**
 * How much to trust this decision, and what that rests on.
 *
 * Was a coloured badge whose entire justification lived in a `title` attribute —
 * unreachable by keyboard, invisible on touch, and announced inconsistently by
 * screen readers. Loop is a decision system; how much to trust a decision cannot
 * be the one thing you need a mouse to read.
 *
 * The dots are a countable shape, so the grade survives greyscale. The basis
 * opens in place, on click OR keyboard, because a badge whose grounds cannot be
 * checked is a colour.
 */
const CONFIDENCE_PIPS: Record<string, number> = {
  HIGH: 3, MODERATE: 2, LOW: 1, INSUFFICIENT: 0,
};

export function ConfidencePill({
  strength, label, basis, determinacyNote,
}: {
  strength: string;
  label: string;
  basis: string[];
  determinacyNote: string | null;
}) {
  const pips = CONFIDENCE_PIPS[strength] ?? 0;
  const tone = strength.toLowerCase();
  return (
    <details className={'q-conf q-conf--' + tone}>
      <summary className="q-conf__summary">
        <span className="q-conf__pips" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <span className={'q-conf__pip' + (i < pips ? ' is-on' : '')} key={i} />
          ))}
        </span>
        <span className="q-conf__label">{label} confidence</span>
      </summary>
      <div className="q-conf__panel">
        <p className="q-conf__basish">Based on</p>
        <ul className="q-conf__basis">
          {basis.map((b, i) => <li key={i}>{b}</li>)}
        </ul>
        {determinacyNote ? <p className="q-conf__det">{determinacyNote}</p> : null}
      </div>
    </details>
  );
}

// --- Ownership ----------------------------------------------------------------

/**
 * Who answers for this, and who is doing it.
 *
 * One component, one vocabulary, everywhere — the surface previously rendered
 * these two independent columns in four different places under three different
 * words, so a glance could not separate accountability from execution.
 */
export function OwnershipTag({ ownership }: { ownership: Ownership }) {
  return (
    <span
      className={'q-own q-own--' + ownership.standing.toLowerCase()}
      title={ownership.detail}
    >
      <span className="q-own__mark" aria-hidden="true" />
      {ownership.label}
    </span>
  );
}

// --- The timeline -------------------------------------------------------------

/**
 * The history, in the order it happened.
 *
 * Sorted by `occurredAt` for reading, which is deliberately NOT how state is
 * computed — a backdated note belongs where it happened on a timeline and at the
 * end of the log for deciding what the current state is. Both are correct;
 * conflating them is not.
 */
export function DecisionTimeline({
  log, members,
}: {
  log: OperationalObservation[];
  members: QueueMember[];
}) {
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
              {o.assignedToUserId
                ? ` → ${nameOf(members, o.assignedToUserId) ?? 'someone'}`
                : ''}
            </span>
            <span className="q-time__who">
              {o.actorType === 'SYSTEM' ? 'Loop' : nameOf(members, o.actorUserId) ?? 'Unknown'}
            </span>
            {o.outcome ? (
              <span className="q-time__outcome">{outcomeLabel(o.outcome)}</span>
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

// --- The controls -------------------------------------------------------------

/** The server actions a decision surface must provide. Named, not imported, so
 *  this file stays free of any one producer's action module. */
export interface DecisionActionSet {
  markReviewed: (formData: FormData) => Promise<void>;
  assign: (formData: FormData) => Promise<void>;
  watch: (formData: FormData) => Promise<void>;
  stopWatching: (formData: FormData) => Promise<void>;
  addNote: (formData: FormData) => Promise<void>;
  recordContact: (formData: FormData) => Promise<void>;
  recordOutcome: (formData: FormData) => Promise<void>;
  resolve: (formData: FormData) => Promise<void>;
  dismiss: (formData: FormData) => Promise<void>;
}

function HiddenFields({ priorityId, returnTo }: { priorityId: string; returnTo: string }) {
  return (
    <>
      <input type="hidden" name="priorityId" value={priorityId} />
      <input type="hidden" name="returnTo" value={returnTo} />
    </>
  );
}

/**
 * The decision controls, in a real hierarchy.
 *
 * WHAT CHANGED AND WHY. Every control used to be the same button: assign, watch,
 * mark reviewed, made contact and tried-no-answer sat in one row as five peers,
 * and RESOLVE — the action the whole product exists to capture — was one of four
 * stacked forms behind a collapsed "Close this out". The most consequential thing
 * an operator can do was the hardest thing to reach.
 *
 * Now: Review, Assign and Resolve are primary. Watch and Dismiss are secondary.
 * Contact, notes and outcome-without-closing are overflow.
 *
 * RESOLVE IS ONE INTENTIONAL INTERACTION, NOT ONE BLIND CLICK. It asks exactly
 * one required question — how this ended — because the answer is the entire
 * feedback loop. A one-click resolve would make UNKNOWN the default recorded
 * outcome, and the false-positive rate that `DecisionActivityPanel` publishes is
 * only worth anything if that field is real. Closing a decision is how Loop
 * learns; it is not how a row gets hidden.
 */
export function DecisionActions({
  priorityId, state, members, returnTo, actions, outcomeGroups, history, ownership,
}: {
  priorityId: string | null;
  state: PriorityState;
  members: QueueMember[];
  returnTo: string;
  actions: DecisionActionSet;
  outcomeGroups: OutcomeChoiceGroup[];
  history: LifecycleHistory | null;
  ownership: Ownership;
}) {
  if (!priorityId) {
    return (
      <p className="q-actnote">
        This decision could not be written to the operational record, so it cannot
        be assigned or resolved right now. Nothing you did here would survive a
        refresh, so the controls are hidden rather than shown inert.
      </p>
    );
  }

  const id = priorityId;
  const closed = state === 'RESOLVED' || state === 'DISMISSED';
  // What happened the last time somebody closed this. Read back from the log,
  // never computed — and shown BEFORE the resolve control, because an operator
  // closing something for the fourth time should see that the previous three
  // resolutions did not hold.
  const prior = priorClosure(history, outcomeLabel);

  return (
    <div className="q-do">
      {!closed ? (
        <div className="q-do__primary">
          <form action={actions.markReviewed} className="q-do__unit">
            <HiddenFields priorityId={id} returnTo={returnTo} />
            <button className="q-btn" type="submit">Review</button>
          </form>

          <form action={actions.assign} className="q-do__unit q-do__assign">
            <HiddenFields priorityId={id} returnTo={returnTo} />
            <label className="q-sr" htmlFor={`a-${id}`}>
              {ownership.accountable ? 'Change who owns this' : 'Assign an owner'}
            </label>
            {/* Deliberately unselected, even on a reassign. Pre-filling the
                current owner makes "submit without looking" a no-op that still
                writes an observation, and the log is supposed to mean something. */}
            <select
              className="q-sel" id={`a-${id}`} name="assignedToUserId" required defaultValue=""
            >
              <option value="" disabled>Choose someone…</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>{m.name?.trim() || m.email}</option>
              ))}
            </select>
            <button className="q-btn q-btn--primary" type="submit">
              {ownership.standing === 'UNOWNED' ? 'Assign' : 'Reassign'}
            </button>
          </form>

          <details className="q-do__unit q-panelwrap">
            <summary className="q-btn q-btn--primary q-btn--summary">Resolve</summary>
            <form action={actions.resolve} className="q-panel">
              <HiddenFields priorityId={id} returnTo={returnTo} />
              <p className="q-panel__h">Resolve this decision</p>
              {prior ? <p className="q-panel__prior">{prior}</p> : null}

              {/* The one required question. Grouped into the four things an
                  operator is actually answering rather than thirteen enum
                  labels — same values, same server action, fewer decisions to
                  make about a decision. */}
              <label className="q-lbl" htmlFor={`o-${id}`}>What happened?</label>
              <select className="q-sel q-sel--wide" id={`o-${id}`} name="outcome" defaultValue="">
                <option value="" disabled>Choose what happened…</option>
                {outcomeGroups.map((g) => (
                  <optgroup label={g.label} key={g.key}>
                    {g.choices.map((c) => (
                      <option key={c.value} value={c.value}>{c.label}</option>
                    ))}
                  </optgroup>
                ))}
              </select>

              <label className="q-lbl" htmlFor={`n-${id}`}>What changed? (optional)</label>
              <input
                className="q-in" id={`n-${id}`} name="note" maxLength={500}
                placeholder="e.g. added a second buyer, raised the routing cap"
              />

              <label className="q-lbl" htmlFor={`e-${id}`}>
                Measured effect, if anyone measured one
              </label>
              <div className="q-do__pair">
                <input
                  className="q-in" id={`e-${id}`} name="effectDollars" inputMode="decimal"
                  placeholder="e.g. 1980"
                />
                <input
                  className="q-in" name="effectBasis" maxLength={200}
                  placeholder="Where that figure came from"
                />
              </div>
              <p className="q-hint">
                Leave the amount blank if nobody measured one. Loop reports it as
                unmeasured rather than as $0, and never estimates it for you.
              </p>
              <button className="q-btn q-btn--primary" type="submit">Resolve</button>
            </form>
          </details>
        </div>
      ) : null}

      <div className="q-do__secondary">
        {!closed ? (
          <>
            {state !== 'WATCHING' ? (
              <form action={actions.watch} className="q-do__unit">
                <HiddenFields priorityId={id} returnTo={returnTo} />
                <button className="q-btn q-btn--quiet" type="submit">Watch</button>
              </form>
            ) : (
              <form action={actions.stopWatching} className="q-do__unit">
                <HiddenFields priorityId={id} returnTo={returnTo} />
                <button className="q-btn q-btn--quiet" type="submit">Stop watching</button>
              </form>
            )}

            <details className="q-do__unit q-panelwrap">
              <summary className="q-btn q-btn--quiet q-btn--summary">Dismiss</summary>
              <form action={actions.dismiss} className="q-panel">
                <HiddenFields priorityId={id} returnTo={returnTo} />
                <p className="q-panel__h">Dismiss without acting</p>
                <label className="q-lbl" htmlFor={`d-${id}`}>Why?</label>
                <select className="q-sel q-sel--wide" id={`d-${id}`} name="outcome"
                  defaultValue="FALSE_POSITIVE">
                  <option value="FALSE_POSITIVE">{OUTCOME_LABEL.FALSE_POSITIVE}</option>
                  <option value="NO_ACTION_NEEDED">{OUTCOME_LABEL.NO_ACTION_NEEDED}</option>
                  <option value="ACCEPTED_RISK">{OUTCOME_LABEL.ACCEPTED_RISK}</option>
                  <option value="NOT_ACTIONABLE">{OUTCOME_LABEL.NOT_ACTIONABLE}</option>
                  <option value="DUPLICATE">{OUTCOME_LABEL.DUPLICATE}</option>
                  <option value="UNKNOWN">{OUTCOME_LABEL.UNKNOWN}</option>
                </select>
                <input className="q-in" name="note" maxLength={500} placeholder="Note (optional)" />
                <p className="q-hint">
                  This is how Loop learns whether it was right. Saying it should not
                  have raised something is the most useful answer here, not the harshest.
                </p>
                <button className="q-btn" type="submit">Dismiss</button>
              </form>
            </details>
          </>
        ) : null}

        <details className="q-do__unit q-panelwrap q-do__overflow">
          <summary className="q-btn q-btn--quiet q-btn--summary" aria-label="More actions">
            More…
          </summary>
          <div className="q-panel q-panel--wide">
            {!closed ? (
              <div className="q-panel__block">
                <p className="q-panel__h">Contact</p>
                <div className="q-do__pair">
                  <form action={actions.recordContact} className="q-do__unit">
                    <HiddenFields priorityId={id} returnTo={returnTo} />
                    <input type="hidden" name="reached" value="yes" />
                    <button className="q-btn q-btn--quiet" type="submit">Made contact</button>
                  </form>
                  <form action={actions.recordContact} className="q-do__unit">
                    <HiddenFields priorityId={id} returnTo={returnTo} />
                    <input type="hidden" name="reached" value="no" />
                    <button className="q-btn q-btn--quiet" type="submit">Tried, no answer</button>
                  </form>
                </div>
              </div>
            ) : null}

            <form action={actions.addNote} className="q-panel__block">
              <HiddenFields priorityId={id} returnTo={returnTo} />
              <p className="q-panel__h">Add a note</p>
              <input className="q-in" name="note" maxLength={500} required
                placeholder="What you found or did" />
              <button className="q-btn q-btn--quiet" type="submit">Add note</button>
            </form>

            <form action={actions.recordOutcome} className="q-panel__block">
              <HiddenFields priorityId={id} returnTo={returnTo} />
              <p className="q-panel__h">Record an outcome without closing</p>
              <select className="q-sel q-sel--wide" name="outcome" defaultValue="UNKNOWN">
                {outcomeGroups.map((g) => (
                  <optgroup label={g.label} key={g.key}>
                    {g.choices.map((c) => (
                      <option key={c.value} value={c.value}>{c.label}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <div className="q-do__pair">
                <input className="q-in" name="effectDollars" inputMode="decimal"
                  placeholder="Measured effect, e.g. 1980" />
                <input className="q-in" name="effectBasis" maxLength={200}
                  placeholder="Where that figure came from" />
              </div>
              <button className="q-btn q-btn--quiet" type="submit">Record</button>
            </form>
          </div>
        </details>
      </div>
    </div>
  );
}

// --- Tier headings ------------------------------------------------------------

/** A tier heading. Weight and position carry the priority; the words confirm it. */
export function TierHead({
  tone, label, count, id,
}: {
  tone: string;
  label: string;
  count: number;
  id?: string;
}) {
  return (
    <div className={'q-tier q-tier--' + tone}>
      <span className="q-tier__dot" aria-hidden="true" />
      <h2 className="q-tier__label" id={id}>{label}</h2>
      <span className="q-tier__count">{count}</span>
    </div>
  );
}

// --- Decision activity --------------------------------------------------------

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
 * What happened BECAUSE of Loop, rather than what happened in the business.
 *
 * The only section that measures the product rather than the business, and the
 * false-positive rate is the point of it: a system that never reports how often
 * it was wrong cannot be calibrated by the person relying on it. At launch it
 * honestly says there is not enough history yet, and that is correct.
 */
export function DecisionActivityPanel({ activity }: { activity: DecisionActivity }) {
  if (activity.total === 0) {
    return (
      <section className="cg-sec q-act" aria-labelledby="q-act-h">
        <h2 className="cg-sec__h" id="q-act-h">How Loop is doing</h2>
        <p className="q-act__empty">
          Nothing has been recorded yet. Once decisions are assigned, resolved or
          dismissed, this is where Loop reports how its recommendations actually
          turned out — including how often it was wrong.
        </p>
      </section>
    );
  }

  return (
    <section className="cg-sec q-act" aria-labelledby="q-act-h">
      <h2 className="cg-sec__h" id="q-act-h">How Loop is doing</h2>
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
            {activity.measuredEffectCents === null ? '—' : money(activity.measuredEffectCents)}
          </span>
          <span className="q-act__label">Measured effect</span>
          <span className="q-act__note">
            {activity.measuredEffectCents === null
              ? 'No closed decision has recorded a measured amount. This is not $0 — nobody has measured one.'
              : `Typed in by an operator on ${activity.measuredEffectSample} closed decision${activity.measuredEffectSample === 1 ? '' : 's'}. Loop never estimates this.`}
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

// --- Open work ----------------------------------------------------------------

/**
 * What is open right now, regardless of the selected period.
 *
 * Without this the queue would lie by omission: a decision assigned last Tuesday
 * that this period's analysis no longer surfaces is still somebody's open work,
 * and letting it disappear because the operator changed a date filter is how a
 * queue quietly loses the thing it was for.
 */
export function OpenWorkPanel({
  openWork, members, now,
}: {
  openWork: OperationalPriority[];
  members: QueueMember[];
  now: Date;
}) {
  if (openWork.length === 0) return null;
  return (
    <section className="cg-sec q-open-work" aria-labelledby="q-ow-h">
      <h2 className="cg-sec__h" id="q-ow-h">Open work</h2>
      <p className="cg-sec__sub">
        Everything currently owned or watched, whichever period it was found in.
      </p>
      <ul className="q-ow__list">
        {openWork.map((p) => (
          <li className="q-ow__item" key={p.id}>
            <span className="q-ow__title">{p.title}</span>
            <span className="q-ow__who">
              {STATE_LABEL[p.state as PriorityState]}
              {p.ownerUserId ? ` · ${nameOf(members, p.ownerUserId) ?? 'Unassigned'}` : ''}
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

// --- Unknowns -----------------------------------------------------------------

/**
 * What Loop could not determine, grouped so it teaches instead of warning.
 *
 * A flat list of a dozen caveats reads as a wall and gets skipped, which is the
 * worst possible outcome for the block that makes the rest of the page
 * believable. Each group states what KIND of limit it is, so a reader learns the
 * shape of what Loop can and cannot see rather than absorbing an undifferentiated
 * disclaimer. Nothing is removed; the grouping conserves every item.
 */
export function UnknownGroups({
  groups, sectionLabel, children,
}: {
  groups: UnknownGroup[];
  sectionLabel: string;
  /** Optional trailing note, e.g. a producer's own provenance line. */
  children?: ReactNode;
}) {
  if (groups.length === 0) return null;
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  return (
    <section className="cg-sec q-unk" aria-labelledby="q-unk-h">
      <div className="q-unk__head">
        <h2 className="cg-sec__h" id="q-unk-h">{sectionLabel}</h2>
        <span className="q-unk__count">{total}</span>
      </div>
      <p className="cg-sec__sub">
        A product that shows conclusions while hiding their limits is not one you
        can delegate to. These are the limits.
      </p>
      <div className="q-unk__groups">
        {groups.map((g) => (
          <details className={'q-unk__group q-unk__group--' + g.key.toLowerCase()} key={g.key}>
            <summary className="q-unk__summary">
              <span className="q-unk__glabel">{g.label}</span>
              <span className="q-unk__gcount">{g.items.length}</span>
            </summary>
            <div className="q-unk__body">
              <p className="q-unk__blurb">{g.blurb}</p>
              <ul className="q-unk__list">
                {g.items.map((u) => (
                  <li className="q-unk__item" key={u.id}>
                    <span className="q-unk__stmt">{u.statement}</span>
                    <span className="q-unk__reason">{u.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          </details>
        ))}
      </div>
      {children}
    </section>
  );
}
